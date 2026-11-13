import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_ENV, scanHookTrust } from "./claude-trust.ts";
import { locateClaudeExe, runVersion, type Ctx, type Status } from "./doctor.ts";

// Never let the probe self-update or phone home.
const NO_UPDATE = { DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
// Presence only, never values: these change which identity/billing the CLI uses.
const ENV_FLAGS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", ...CLOUD_ENV, "CLAUDE_CODE_GIT_BASH_PATH"];
// Args ARRC must never pass: they bypass or disable the permission hooks that provide enforcement.
const FORBIDDEN_FLAGS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--bare", "--safe-mode", "--managed-settings", "--project-config-root"]; // the last relocates where project settings are read, defeating the trust scan
const GATE_DENIED_TOOLS = ["Bash", "PowerShell", "Monitor", "WebFetch", "WebSearch", "Task", "Agent", "mcp__*", "ListMcpResourcesTool", "ReadMcpResourceTool"];
// Allowlist (--tools): exactly the gate-mapped tools that are built-in tool names in CLI 2.1.325 (MultiEdit is gate-mapped but not a 2.1.325 tool).
const GATE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit"];
// Also denied (belt and braces) when hook registration cannot be verified. NotebookRead/LS/MultiEdit exist in CLI 2.1.325 strings.
const FILE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "LS"];

/** True if args (never the prompt; runClaude checks prefixArgs and extraArgs together) would bypass/disable enforcement or replace the gate settings. */
function forbiddenExtraArgs(a: string[]): boolean {
  const eq = (t: string, f: string) => t === f || t.startsWith(f + "=");
  if (a.some((t) => FORBIDDEN_FLAGS.some((f) => eq(t, f)) || eq(t, "--setting-sources"))) return true;
  if (["--settings", "--tools", "--disallowedTools", "--mcp-config"].some((f) => a.filter((t) => eq(t, f)).length > 1)) return true;
  const widen = ["bypassPermissions", "acceptEdits", "auto"];
  return a.some((t, i) => (t === "--permission-mode" && widen.includes(a[i + 1] ?? "")) || widen.some((m) => t === `--permission-mode=${m}`));
}

// Env names are case-insensitive only on Windows.
const norm = (k: string) => (process.platform === "win32" ? k.toLowerCase() : k);
// The CLI disables hooks when these are truthy (--bare / --safe-mode set them), so they must never reach the child.
const HOOK_OFF_ENV = ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE"].map(norm);
// Parent Claude Code session identity must not leak into a gated child (names found by string search of CLI 2.1.325).
const PARENT_SESSION_ENV = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_PID"].map(norm);
const envPresence = (env: NodeJS.ProcessEnv) => {
  const seen = Object.fromEntries(Object.entries(env).map(([k, val]) => [norm(k), val]));
  return Object.fromEntries(ENV_FLAGS.map((k) => [k, !!seen[norm(k)]])) as Record<string, boolean>;
};

export interface AuthClass {
  source: string;
  billing: "cloud" | "api" | "subscription" | "unknown";
  /** A key/token env var is set, so it wins over any /login subscription (documented for -p). */
  apiKeyOverridesSubscription: boolean;
  possibleCharges: boolean | "unknown";
  apiKeySource?: string; // raw system/init value, not interpreted
}

/**
 * Presence-only classification following Claude Code's documented precedence: cloud provider, AUTH_TOKEN,
 * API_KEY, (apiKeyHelper), OAUTH_TOKEN, /login. Values are never read. ponytail: apiKeyHelper lives in settings
 * files we never open, and a /login subscription is indistinguishable from "nothing set", so both stay "unknown".
 */
export function classifyAuth(env: NodeJS.ProcessEnv, init?: { apiKeySource?: string }): AuthClass {
  const e = envPresence(env);
  const raw = typeof init?.apiKeySource === "string" ? { apiKeySource: init.apiKeySource } : {};
  const keyed = !!(e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_API_KEY);
  const initKeyed = init?.apiKeySource === "ANTHROPIC_API_KEY" || init?.apiKeySource === "ANTHROPIC_AUTH_TOKEN"; // key from a settings env block
  const r = (source: string, billing: AuthClass["billing"], possibleCharges: AuthClass["possibleCharges"]): AuthClass =>
    ({ source, billing, apiKeyOverridesSubscription: (keyed || initKeyed) && billing === "api", possibleCharges, ...raw });
  // Any non-empty cloud flag (even "0") counts as cloud: presence-only and deliberately conservative.
  const cloud = CLOUD_ENV.find((k) => e[k]);
  if (cloud) return r(cloud, "cloud", true);
  if (e.ANTHROPIC_AUTH_TOKEN) return r("ANTHROPIC_AUTH_TOKEN", "api", true);
  if (e.ANTHROPIC_API_KEY) return r("ANTHROPIC_API_KEY", "api", true);
  // A key from a settings `env` block is absent from process env but init still reports its name.
  if (init?.apiKeySource === "apiKeyHelper" || init?.apiKeySource === "ANTHROPIC_API_KEY" || init?.apiKeySource === "ANTHROPIC_AUTH_TOKEN") return r(init.apiKeySource, "api", true);
  if (e.CLAUDE_CODE_OAUTH_TOKEN) return r("CLAUDE_CODE_OAUTH_TOKEN", "subscription", "unknown"); // extra-usage billing may apply
  return r("unknown", "unknown", "unknown");
}

export interface RateLimit {
  status: string;
  resetsAt: number | "unknown"; // unix seconds
  rateLimitType: string;
  utilization: number | "unknown";
}
/** Undocumented event; every field is validated and falls back to "unknown". */
export function parseRateLimit(e: any): RateLimit {
  const i = e?.rate_limit_info;
  const s = (v: unknown) => (typeof v === "string" && v ? v : "unknown");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : "unknown");
  return { status: s(i?.status), resetsAt: n(i?.resetsAt), rateLimitType: s(i?.rateLimitType), utilization: n(i?.utilization) };
}

/** Extra CLI args that route every tool call through the gate hook and make un-approved actions fail explicitly. */
export function buildGateArgs(gateScript: string, policyPath: string, o: { withholdFileTools: boolean }): string[] {
  // Exec form (program + args, no shell, so no Git Bash dependency). Unverified live.
  // onFailure:"block": only exit 2 blocks by default; any other hook failure (missing script, timeout) would let the tool run.
  const settings = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: process.execPath, args: [gateScript, policyPath], onFailure: "block" }] }] } };
  // Deny rules for the classes the gate always denies; they apply regardless of hooks. ponytail: "mcp__*" wildcard form unverified live.
  // --tools (allowlist; "" = no tools) and --disallowedTools are both variadic: they must stay the LAST args, each given one comma-joined value.
  // withholdFileTools: hooks cannot be verified to run (see scanHookTrust), so file tools must not exist for the model at all.
  const denied = o.withholdFileTools ? [...GATE_DENIED_TOOLS, ...FILE_TOOLS] : GATE_DENIED_TOOLS;
  // --strict-mcp-config alone (no --mcp-config) loads no MCP servers at all.
  return ["--settings", JSON.stringify(settings), "--strict-mcp-config", "--permission-prompts", "none", "--tools", o.withholdFileTools ? "" : GATE_TOOLS.join(","), "--disallowedTools", denied.join(",")];
}

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
  const envPresent = envPresence(o.env);
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
  apiKeySource?: string; // raw system/init value
  tools?: string[]; // system/init tool names the CLI actually exposed
  rateLimits: RateLimit[];
  costUsdEstimate?: number; // result.total_cost_usd: client-side list-price estimate, NOT a bill
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
  cwd?: string;
  extraArgs?: string[]; // e.g. buildGateArgs(); appended after the standard flags
  prompt: string;
  model?: string;
  resume?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onEvent?: (e: { type?: string }) => void;
}): Promise<RunResult> {
  const r: RunResult = { eventCounts: {}, toolUses: [], rateLimits: [], malformedLines: 0, exitCode: null, signal: null, timedOut: false, cancelled: false, stderrTail: "" };
  if (/^\s*-/.test(o.prompt)) {
    r.spawnError = "prompt must not start with '-' (would be parsed as a CLI flag)";
    return Promise.resolve(r);
  }
  const args = [...(o.prefixArgs ?? []), "-p", o.prompt, "--output-format", "stream-json", "--verbose"];
  if (o.model) args.push("--model", o.model);
  if (o.resume) args.push("--resume", o.resume);
  args.push(...(o.extraArgs ?? []));
  if (forbiddenExtraArgs([...(o.prefixArgs ?? []), ...(o.extraArgs ?? [])])) {
    r.spawnError = "refused: argument would bypass or disable permission enforcement";
    return Promise.resolve(r);
  }
  if (Object.keys(o.env ?? {}).some((k) => HOOK_OFF_ENV.includes(norm(k)))) {
    r.spawnError = "refused: env var would disable hooks";
    return Promise.resolve(r);
  }
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HOOK_OFF_ENV.includes(norm(k)) && !PARENT_SESSION_ENV.includes(norm(k))));
  return new Promise((resolve) => {
    if (o.signal?.aborted) {
      r.cancelled = true;
      return resolve(r);
    }
    let child: ChildProcess;
    try {
      child = spawn(o.exe, args, { ...(o.cwd ? { cwd: o.cwd } : {}), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...inherited, ...NO_UPDATE, ...o.env } });
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
      if (e.type === "system" && e.subtype === "init") {
        if (typeof e.model === "string") r.model = e.model;
        if (typeof e.apiKeySource === "string") r.apiKeySource = e.apiKeySource;
        if (Array.isArray(e.tools)) r.tools = e.tools.filter((t: unknown) => typeof t === "string");
      }
      if (e.type === "rate_limit_event") r.rateLimits.push(parseRateLimit(e));
      if (e.type === "assistant" && Array.isArray(e.message?.content))
        for (const b of e.message.content) if (b?.type === "tool_use") r.toolUses.push({ name: String(b.name), id: String(b.id) });
      if (e.type === "result") {
        r.result = { subtype: e.subtype, isError: e.is_error };
        if (typeof e.total_cost_usd === "number") r.costUsdEstimate = e.total_cost_usd;
      }
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
  const opt: { exe?: string; model?: string; gate?: string; json: boolean; live: boolean } = { json: false, live: false };
  let bad = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opt.json = true;
    else if (a === "--live") opt.live = true;
    else if ((a === "--exe" || a === "--model" || a === "--gate") && argv[i + 1] && !argv[i + 1]!.startsWith("--")) opt[a.slice(2) as "exe" | "model" | "gate"] = argv[++i]!;
    else bad = true;
  }
  if (opt.gate && !opt.live) bad = true;
  if (bad) {
    process.stderr.write("Usage: claude-probe [--exe <path>] [--json] [--live [--model <m>] [--gate <policy.json>]]\n");
    process.exit(2);
  }
  const homedir = os.homedir();
  const located = locateClaude({ ...(opt.exe ? { explicit: opt.exe } : {}), env: process.env, platform: process.platform, homedir });
  const out: Record<string, unknown> = { located };
  if (located.status === "ok" && located.path) {
    out.fingerprint = await fingerprint(located.path, { env: process.env, homedir, cwd: process.cwd() });
    if (opt.live) {
      const gateScript = path.join(import.meta.dirname, "claude-gate" + path.extname(import.meta.filename));
      // Fail closed: file tools are withheld unless the scan positively finds nothing that could stop the hook.
      const hookTrust = scanHookTrust({ env: process.env, cwd: process.cwd(), home: homedir, platform: process.platform });
      out.hookTrust = hookTrust;
      const base = {
        exe: located.path,
        timeoutMs: 120_000,
        ...(opt.model ? { model: opt.model } : {}),
        ...(opt.gate ? { extraArgs: buildGateArgs(gateScript, path.resolve(opt.gate), { withholdFileTools: !hookTrust.trusted }) } : {}),
      };
      const a = await runClaude({ ...base, prompt: "Reply with exactly: OK" });
      const b = await runClaude({ ...base, prompt: "Reply with exactly: OK again", ...(a.sessionId ? { resume: a.sessionId } : {}) });
      const ac = new AbortController();
      const c = await runClaude({ ...base, prompt: "Reply with exactly: OK", signal: ac.signal, onEvent: () => ac.abort() });
      const trim = (x: RunResult) => ({ ...x, stderrTail: x.stderrTail.slice(-300) });
      out.auth = classifyAuth(process.env, a.apiKeySource ? { apiKeySource: a.apiKeySource } : undefined);
      out.live = { first: trim(a), resume: trim(b), cancel: trim(c), resumedSameSession: !!a.sessionId && a.sessionId === b.sessionId };
    }
  }
  console.log(JSON.stringify(out, null, 2));
}
