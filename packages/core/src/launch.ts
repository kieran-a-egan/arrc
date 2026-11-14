import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { isDriveAbsolute, resolveCommand, system32, systemRoot } from "./doctor.ts";

export type Shell = "pwsh" | "powershell";
export type LaunchPlan = { ok: true; command: string; args: string[] } | { ok: false; reason: string };

/** After exit or kill, how long `close` gets before the pipes are dropped and the run resolves anyway. */
export const CLOSE_GRACE_MS = 2000;

// Node's child.kill() is a forceful TerminateProcess on Windows and spares descendants that are
// not in the parent's job object, so kill the whole tree with taskkill /T, falling back to child.kill().
// Graceful interrupt is not available from a Node parent.
// ponytail: POSIX only SIGTERMs the direct child; process-group tree kill is unverified/unsupported in this spike.
/** Absolute taskkill path (SystemRoot validation lives in doctor.ts). */
export const taskkillPath = (): string => system32("taskkill.exe");

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    execFile(taskkillPath(), ["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true }, (err) => {
      if (err) child.kill();
    });
  } else child.kill("SIGTERM");
}

/**
 * RAW native launcher plan: performs NO policy check. Callers must obtain an allow from `decide()` first.
 * Windows-only: any other platform is `unsupported_platform`.
 * Pure: decides how a file may be launched. Always shell:false; a shell is only ever an explicit, named
 * interpreter for a .ps1, never inferred. .cmd/.bat are unsupported (CVE-2024-27980: need a shell, and cmd
 * metacharacters cannot be safely escaped). No -ExecutionPolicy override: a restrictive machine policy fails visibly.
 * Interpreters are emitted as absolute paths (never a bare name: Windows may search cwd before PATH).
 * ponytail: the path rule is Windows-only (drive-absolute, no `:` after the drive: rejects UNC, \\?\, ADS, rooted-no-drive).
 */
export function planLaunch(o: { file: string; args?: string[]; shell?: Shell }): LaunchPlan {
  const args = o.args ?? [];
  if (process.platform !== "win32") return { ok: false, reason: "unsupported_platform" };
  if (!isDriveAbsolute(o.file)) return { ok: false, reason: "path_not_absolute" };
  const ext = path.win32.extname(o.file).toLowerCase();
  if (ext === ".exe") return { ok: true, command: o.file, args };
  if (ext === ".cmd" || ext === ".bat") return { ok: false, reason: "blocked_cmd_shim" };
  if (ext === ".ps1") {
    if (!o.shell) return { ok: false, reason: "shell_required_for_ps1" };
    let command: string | undefined;
    if (o.shell === "powershell") {
      const root = systemRoot();
      if (!root) return { ok: false, reason: "shell_not_found" };
      command = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    } else if (o.shell === "pwsh") {
      command = resolveCommand("pwsh", { platform: process.platform, env: process.env }, ".exe");
      if (!command || !isDriveAbsolute(command)) return { ok: false, reason: "shell_not_found" };
    } else return { ok: false, reason: "unknown_shell" };
    return { ok: true, command, args: ["-NoProfile", "-NonInteractive", "-File", o.file, ...args] };
  }
  return { ok: false, reason: "unsupported_extension" };
}

export interface LaunchResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated?: true; // a stream hit MAX_STREAM and the rest was dropped
  error?: string; // spawn error code (e.g. ENOENT) or a planLaunch reason
  timedOut: boolean;
  cancelled: boolean;
}

const MAX_STREAM = 1 << 20; // 1,048,576 UTF-16 code units per stream (not bytes)

/**
 * RAW native launcher: performs NO policy check; callers must obtain an allow from `decide()` first.
 * Plans via planLaunch (never accepts a pre-built plan), then runs. Never rejects.
 * Each of stdout/stderr is capped at 1,048,576 UTF-16 code units (not bytes); a trailing lone high surrogate is dropped.
 */
export function runLaunch(spec: { file: string; args?: string[]; shell?: Shell }, o: { timeoutMs: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<LaunchResult> {
  const r: LaunchResult = { exitCode: null, stdout: "", stderr: "", timedOut: false, cancelled: false };
  const plan = planLaunch(spec);
  if (!plan.ok) return Promise.resolve({ ...r, error: plan.reason });
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ ...r, cancelled: true });
    let child: ChildProcess;
    try {
      child = spawn(plan.command, plan.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...o.env } });
    } catch (e) {
      return resolve({ ...r, error: String((e as NodeJS.ErrnoException).code ?? e) });
    }
    let done = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      o.signal?.removeEventListener("abort", abort);
      resolve(r);
    };
    // After exit or kill, give `close` 2s, then drop the pipes (a grandchild may hold them open) and resolve.
    // ponytail: a stuck process may outlive the resolve if taskkill and kill() both fail.
    const bound = () =>
      timers.push(
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          r.exitCode ??= child.exitCode;
          finish();
        }, CLOSE_GRACE_MS).unref(),
      );
    const kill = () => {
      killTree(child);
      bound();
    };
    timers.push(
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return; // already exited by itself
        r.timedOut = true;
        kill();
      }, o.timeoutMs),
    );
    const abort = () => {
      r.cancelled = true;
      kill();
    };
    o.signal?.addEventListener("abort", abort, { once: true });
    const full = { stdout: false, stderr: false };
    const cap = (k: "stdout" | "stderr") => (d: string) => {
      if (full[k]) return; // once truncated, ignore the rest so the kept text stays a true prefix
      let keep = d.slice(0, Math.max(0, MAX_STREAM - r[k].length));
      if (keep.length < d.length) {
        r.truncated = true;
        full[k] = true;
        const last = keep.charCodeAt(keep.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) keep = keep.slice(0, -1); // don't split a surrogate pair
      }
      r[k] += keep;
    };
    child.stdout?.setEncoding("utf8").on("data", cap("stdout"));
    child.stderr?.setEncoding("utf8").on("data", cap("stderr"));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (done) return;
      r.error = String(e.code ?? e.name);
      finish();
    });
    child.on("exit", bound);
    child.on("close", (code) => {
      if (done) return;
      r.exitCode = code;
      finish();
    });
  });
}