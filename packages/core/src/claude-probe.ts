import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locateClaudeExe, runVersion, type Ctx, type Status } from "./doctor.ts";

// Never let the probe self-update or phone home.
const NO_UPDATE = { DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
// Presence only, never values: these change which identity/billing the CLI uses.
const ENV_FLAGS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_GIT_BASH_PATH"];

export interface Located {
  status: Status;
  path?: string;
  source?: "explicit" | "ARRC_CLAUDE_EXE" | "PATH-or-default";
  detail?: string;
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function locateClaude(o: { explicit?: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; homedir: string }): Located {
  const win = o.platform === "win32";
  const ctx: Ctx = { env: o.env, platform: o.platform };
  let source: Located["source"] = "explicit";
  const clean = (s?: string) => s?.trim().replace(/^"(.*)"$/, "$1");
  let p = clean(o.explicit);
  if (!p && clean(o.env.ARRC_CLAUDE_EXE)) [p, source] = [clean(o.env.ARRC_CLAUDE_EXE), "ARRC_CLAUDE_EXE"];
  if (!p) [p, source] = [locateClaudeExe(ctx, o.homedir), "PATH-or-default"];
  if (!p) return { status: "missing", source, detail: "claude not found on PATH or in ~/.local/bin" };
  const platformPath = win ? path.win32 : path.posix;
  if (!platformPath.isAbsolute(p)) return { status: "blocked", source, path: p, detail: "executable path must be absolute" };
  if (win && !/\.exe$/i.test(p))
    return {
      status: "blocked",
      source,
      path: p,
      detail: "only native .exe is launched on Windows; .cmd/.bat/.ps1 shims need a shell, which is refused. Pass --exe <path> or set ARRC_CLAUDE_EXE to the native claude.exe",
    };
  if (!isFile(p)) return { status: "missing", source, path: p, detail: "file does not exist" };
  return { status: "ok", source, path: p };
}

export async function fingerprint(exe: string, o: { env: NodeJS.ProcessEnv; homedir: string; cwd: string }) {
  const v = await runVersion(exe, ["--version"], NO_UPDATE);
  const st = fs.statSync(exe); // ponytail: size+mtime only, no hash of the ~350MB binary
  const exists = (p: string) => isFile(p);
  const settings = [".claude/settings.json", ".claude/settings.local.json"];
  const config: Record<string, boolean> = {};
  for (const [base, label] of [[o.homedir, "~"], [o.cwd, "<cwd>"]] as const)
    for (const s of settings) config[`${label}/${s}`] = exists(path.join(base, s));
  const lower = Object.fromEntries(Object.entries(o.env).map(([k, val]) => [k.toLowerCase(), val]));
  const envPresent = Object.fromEntries(ENV_FLAGS.map((k) => [k, !!lower[k.toLowerCase()]]));
  return {
    path: exe,
    version: v.status === "ok" ? v.output : undefined,
    versionDetail: v.detail,
    size: st.size,
    mtime: st.mtime.toISOString(),
    config, // existence only; contents are never read
    envPresent, // booleans only; values are never recorded
    platform: `${process.platform} ${os.release()} ${os.arch()}`,
  };
}

export interface RunResult {
  sessionId?: string;
  model?: string;
  eventCounts: Record<string, number>;
  toolUses: { name: string; id: string }[];
  result?: { subtype?: string; isError?: boolean };
  malformedLines: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
  stderrTail: string;
}

// Node's child.kill() is a forceful TerminateProcess on Windows and spares descendants that are
// not in the parent's job object, so kill the whole tree with taskkill /T, falling back to child.kill().
// Graceful interrupt is not available from a Node parent.
// ponytail: POSIX only SIGTERMs the direct child; process-group tree kill is unverified/unsupported in this spike.
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const tk = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(tk, ["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true }, (err) => {
      if (err) child.kill();
    });
  } else child.kill("SIGTERM");
}

export function runClaude(o: {
  exe: string;
  prefixArgs?: string[];
  prompt: string;
  model?: string;
  resume?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onEvent?: (e: { type?: string }) => void;
}): Promise<RunResult> {
  const r: RunResult = { eventCounts: {}, toolUses: [], malformedLines: 0, exitCode: null, signal: null, timedOut: false, cancelled: false, stderrTail: "" };
  if (/^\s*-/.test(o.prompt)) {
    r.spawnError = "prompt must not start with '-' (would be parsed as a CLI flag)";
    return Promise.resolve(r);
  }
  const args = [...(o.prefixArgs ?? []), "-p", o.prompt, "--output-format", "stream-json", "--verbose"];
  if (o.model) args.push("--model", o.model);
  if (o.resume) args.push("--resume", o.resume);
  return new Promise((resolve) => {
    if (o.signal?.aborted) {
      r.cancelled = true;
      return resolve(r);
    }
    let child: ChildProcess;
    try {
      child = spawn(o.exe, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...NO_UPDATE, ...o.env } });
    } catch (e) {
      r.spawnError = String((e as NodeJS.ErrnoException).code ?? e);
      return resolve(r);
    }
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const settle = () => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      o.signal?.removeEventListener("abort", abort);
      resolve(r);
    };
    // Kill, then give `close` 2s before giving up on the pipes and resolving anyway.
    // ponytail: a stuck process may outlive the resolve if taskkill and kill() both fail.
    const kill = () => {
      killTree(child);
      timers.push(
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          r.exitCode ??= child.exitCode;
          r.signal ??= child.signalCode;
          settle();
        }, 2000).unref(),
      );
    };
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        r.malformedLines++;
        return;
      }
      if (!e || typeof e !== "object") return void r.malformedLines++;
      r.eventCounts[e.type] = (r.eventCounts[e.type] ?? 0) + 1;
      if (typeof e.session_id === "string") r.sessionId = e.session_id;
      if (e.type === "system" && e.subtype === "init" && typeof e.model === "string") r.model = e.model;
      if (e.type === "assistant" && Array.isArray(e.message?.content))
        for (const b of e.message.content) if (b?.type === "tool_use") r.toolUses.push({ name: String(b.name), id: String(b.id) });
      if (e.type === "result") r.result = { subtype: e.subtype, isError: e.is_error };
      o.onEvent?.(e);
    };
    let buf = "";
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (r.stderrTail = (r.stderrTail + d).slice(-4096)));
    timers.push(
      setTimeout(() => {
        r.timedOut = true;
        kill();
      }, o.timeoutMs),
    );
    function abort() {
      r.cancelled = true;
      kill();
    }
    o.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      r.spawnError = String(e.code ?? e.name);
      settle();
    });
    child.on("close", (code, sig) => {
      if (settled) return;
      onLine(buf);
      r.exitCode = code;
      r.signal = sig;
      settle();
    });
  });
}

const isMain =
  (import.meta as { main?: boolean }).main ??
  (() => {
    try {
      return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1] ?? ""));
    } catch {
      return false;
    }
  })();
if (isMain) {
  const argv = process.argv.slice(2);
  const opt: { exe?: string; model?: string; json: boolean; live: boolean } = { json: false, live: false };
  let bad = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opt.json = true;
    else if (a === "--live") opt.live = true;
    else if ((a === "--exe" || a === "--model") && argv[i + 1] && !argv[i + 1]!.startsWith("--")) opt[a === "--exe" ? "exe" : "model"] = argv[++i]!;
    else bad = true;
  }
  if (bad) {
    process.stderr.write("Usage: claude-probe [--exe <path>] [--json] [--live [--model <m>]]\n");
    process.exit(2);
  }
  const homedir = os.homedir();
  const located = locateClaude({ ...(opt.exe ? { explicit: opt.exe } : {}), env: process.env, platform: process.platform, homedir });
  const out: Record<string, unknown> = { located };
  if (located.status === "ok" && located.path) {
    out.fingerprint = await fingerprint(located.path, { env: process.env, homedir, cwd: process.cwd() });
    if (opt.live) {
      const base = { exe: located.path, timeoutMs: 120_000, ...(opt.model ? { model: opt.model } : {}) };
      const a = await runClaude({ ...base, prompt: "Reply with exactly: OK" });
      const b = await runClaude({ ...base, prompt: "Reply with exactly: OK again", ...(a.sessionId ? { resume: a.sessionId } : {}) });
      const ac = new AbortController();
      const c = await runClaude({ ...base, prompt: "Reply with exactly: OK", signal: ac.signal, onEvent: () => ac.abort() });
      const trim = (x: RunResult) => ({ ...x, stderrTail: x.stderrTail.slice(-300) });
      out.live = { first: trim(a), resume: trim(b), cancel: trim(c), resumedSameSession: !!a.sessionId && a.sessionId === b.sessionId };
    }
  }
  console.log(JSON.stringify(out, null, 2));
}
