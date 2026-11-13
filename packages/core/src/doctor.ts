import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Status = "ok" | "missing" | "mismatch" | "unverified" | "blocked" | "unsupported";
export interface Capability {
  id: string;
  status: Status;
  version?: string;
  path?: string;
  detail?: string;
  remedy?: string;
}
export interface DoctorReport {
  schemaVersion: 1;
  platform: string;
  arch: string;
  capabilities: Capability[];
}
export interface Ctx {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export const CAPABILITY_IDS = [
  "os.platform",
  "node.runtime",
  "npm.cli",
  "git.cli",
  "shell.pwsh",
  "shell.windows-powershell",
  "shell.git-bash",
  "claude.cli",
  "isolation.wsl",
  "isolation.docker",
  "isolation.windows-sandbox",
  "jev.connectivity",
] as const;

function envGet(ctx: Ctx, key: string): string | undefined {
  if (ctx.platform !== "win32") return ctx.env[key];
  const k = Object.keys(ctx.env).find((e) => e.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : ctx.env[k];
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Manual PATH scan: never executes anything and never searches cwd.
export function resolveCommand(name: string, ctx: Ctx, onlyExt?: string): string | undefined {
  const win = ctx.platform === "win32";
  const delim = win ? ";" : ":";
  const exts = win
    ? onlyExt
      ? [onlyExt]
      : (envGet(ctx, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const raw of (envGet(ctx, "PATH") ?? "").split(delim)) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

// Prefer a native exe (PATH .exe, then ~/.local/bin) so a .cmd shim earlier on PATH can't block it;
// else report whatever the full PATH scan found (a shim: blocked in the probe, unverified in doctor).
export function locateClaudeExe(ctx: Ctx, home: string | undefined): string | undefined {
  const win = ctx.platform === "win32";
  const fallback = home ? path.join(home, ".local", "bin", win ? "claude.exe" : "claude") : undefined;
  return (
    resolveCommand("claude", ctx, win ? ".EXE" : undefined) ??
    (fallback && isFile(fallback) ? fallback : undefined) ??
    resolveCommand("claude", ctx)
  );
}

interface Run {
  status: "ok" | "unverified";
  output?: string;
  detail?: string;
}

export function runVersion(
  absPath: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd: string = os.tmpdir(),
): Promise<Run> {
  if (/\.(cmd|bat|ps1)$/i.test(absPath)) {
    return Promise.resolve({
      status: "unverified",
      detail: `found shim at ${absPath}; not executed (shell launch disabled for safety)`,
    });
  }
  return new Promise((resolve) => {
    // execFile can throw synchronously (e.g. EFTYPE for a non-executable .exe on Windows)
    try {
    execFile(
      absPath,
      args,
      {
        shell: false,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
        cwd,
        env: { ...process.env, ...extraEnv },
      },
      (err, stdout) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code ?? err.name;
          resolve({ status: "unverified", detail: `could not run ${absPath}: ${String(code)}` });
        } else {
          resolve({ status: "ok", output: String(stdout).trim() });
        }
      },
    );
    } catch (e) {
      resolve({ status: "unverified", detail: `could not run ${absPath}: ${String((e as NodeJS.ErrnoException).code ?? e)}` });
    }
  });
}

const parse = (v: string): [number, number, number] | undefined => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

// Minimal range check: only `^X.Y.Z` and exact `X.Y.Z`; anything else is undefined (unverified).
export function satisfies(version: string, range: string): boolean | undefined {
  const v = parse(version);
  const caret = range.startsWith("^");
  const r = parse(caret ? range.slice(1) : range);
  if (!v || !r || !/^\^?\d+\.\d+\.\d+$/.test(range)) return undefined;
  if (!caret) return v.every((n, i) => n === r[i]);
  if (v[0] !== r[0]) return false;
  return v[1] !== r[1] ? v[1] > r[1] : v[2] >= r[2];
}

interface DevEngines {
  runtime?: { version?: string };
  packageManager?: { version?: string };
}
function readDevEngines(): DevEngines {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    return (pkg.devEngines ?? {}) as DevEngines;
  } catch {
    return {};
  }
}

const fromRun = (id: string, r: Run, p: string, extra: Partial<Capability> = {}): Capability =>
  r.status === "ok"
    ? { id, status: "ok", version: r.output ?? "", path: p, ...extra }
    : { id, status: "unverified", path: p, detail: r.detail ?? "not verified", ...extra };

const missing = (id: string, remedy: string, detail?: string): Capability => ({
  id,
  status: "missing",
  remedy,
  ...(detail ? { detail } : {}),
});

const unsupported = (id: string, ctx: Ctx): Capability => ({
  id,
  status: "unsupported",
  detail: `Windows-only capability; platform is ${ctx.platform}`,
});

// Pure file reads, nothing executed. Returns the npm package dir and version that npm would actually use:
// win32 `prefix` (from npm-prefix.js) first, then the shim's own dir, POSIX symlink target, node's bundled npm.
export function npmInstall(found: string, ctx: Ctx, prefix?: string): { dir: string; version: string } | undefined {
  const dirs: string[] = [];
  if (ctx.platform === "win32") {
    if (prefix) dirs.push(path.join(prefix, "node_modules", "npm"));
  } else {
    try {
      dirs.push(path.resolve(fs.realpathSync(found), "..", ".."));
    } catch {
      // dangling link: fall through to the other candidates
    }
  }
  dirs.push(path.join(path.dirname(found), "node_modules", "npm"));
  dirs.push(
    ctx.platform === "win32"
      ? path.join(path.dirname(process.execPath), "node_modules", "npm")
      : path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm"),
  );
  for (const dir of dirs) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg.name === "npm" && typeof pkg.version === "string") return { dir, version: pkg.version };
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

async function probePwshLike(id: string, exe: string, require?: { major: number; remedy: string }): Promise<Capability> {
  const r = await runVersion(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
    POWERSHELL_TELEMETRY_OPTOUT: "1",
    POWERSHELL_UPDATECHECK: "Off",
  });
  const cap = fromRun(id, r, exe);
  if (cap.status === "ok" && require) {
    const v = parse(cap.version ?? "");
    if (!v || v[0] < require.major) return { ...cap, status: "mismatch", remedy: require.remedy };
  }
  return cap;
}

export async function runDoctor(
  ctx: Ctx = { env: process.env, platform: process.platform },
): Promise<DoctorReport> {
  const win = ctx.platform === "win32";
  const sysRoot = envGet(ctx, "SystemRoot");
  const sys32 = (...p: string[]): string | undefined => (sysRoot ? path.win32.join(sysRoot, "System32", ...p) : undefined);
  const dev = readDevEngines();
  const caps: Capability[] = [];

  // os.platform
  let osDetail = `${os.platform()} ${os.arch()} ${os.version()} ${os.release()}`;
  if (win) {
    const host = envGet(ctx, "PROCESSOR_ARCHITEW6432") ?? envGet(ctx, "PROCESSOR_ARCHITECTURE");
    if (host) osDetail += ` (host arch ${host})`;
  }
  caps.push({ id: "os.platform", status: "ok", detail: osDetail });

  // node.runtime
  {
    const range = dev.runtime?.version;
    const ok = range ? satisfies(process.version, range) : undefined;
    const base = { id: "node.runtime", version: process.version, path: process.execPath };
    if (ok === true) caps.push({ ...base, status: "ok" });
    else if (ok === false)
      caps.push({ ...base, status: "mismatch", detail: `requires ${range}`, remedy: `Install Node ${range} (see .nvmrc)` });
    else caps.push({ ...base, status: "unverified", detail: `cannot evaluate devEngines range ${range ?? "(none)"}` });
  }

  // npm.cli (never executed: it writes logs / update-notifier state)
  {
    const found = resolveCommand("npm", ctx);
    let prefix: string | undefined;
    let prefixNote: string | undefined;
    const prefixJs = found && path.join(path.dirname(found), "node_modules", "npm", "bin", "npm-prefix.js");
    if (win && prefixJs && isFile(prefixJs)) {
      // Mirrors npm.cmd: npm's own resolver prints the global prefix (it loads npm config itself,
      // so we never read .npmrc, which may hold tokens). Run with node directly, not the .cmd shim.
      const r = await runVersion(process.execPath, [prefixJs]);
      if (r.status === "ok" && r.output) prefix = r.output;
      else prefixNote = `npm prefix lookup failed (${r.detail ?? r.status})`;
    }
    const npm = found ? npmInstall(found, ctx, prefix) : undefined;
    const want = dev.packageManager?.version;
    const lookup = prefixNote && npm ? `${prefixNote}; version read from ${npm.dir}` : "";
    if (!found) caps.push(missing("npm.cli", "Install Node.js, which bundles npm: https://nodejs.org"));
    else if (!npm) caps.push({ id: "npm.cli", status: "unverified", path: found, detail: `npm found at ${found} but its version could not be read` });
    else if (want && npm.version !== want)
      caps.push({ id: "npm.cli", status: "mismatch", version: npm.version, path: npm.dir, detail: [`requires ${want}`, lookup].filter(Boolean).join("; "), remedy: `npm install -g npm@${want}` });
    else caps.push({ id: "npm.cli", status: "ok", version: npm.version, path: npm.dir, ...(lookup ? { detail: lookup } : {}) });
  }

  // git.cli
  const gitPath = resolveCommand("git", ctx);
  if (gitPath) caps.push(fromRun("git.cli", await runVersion(gitPath, ["--version"]), gitPath));
  else caps.push(missing("git.cli", "Install Git: https://git-scm.com/downloads"));

  // shell.pwsh
  const pwsh = resolveCommand("pwsh", ctx);
  if (pwsh) caps.push(await probePwshLike("shell.pwsh", pwsh, { major: 7, remedy: "Install PowerShell 7+: winget install Microsoft.PowerShell (advice only)" }));
  else caps.push(missing("shell.pwsh", "Install PowerShell 7+: https://aka.ms/powershell"));

  // shell.windows-powershell
  if (!win) caps.push(unsupported("shell.windows-powershell", ctx));
  else {
    const p = sys32("WindowsPowerShell", "v1.0", "powershell.exe");
    if (p && isFile(p)) caps.push(await probePwshLike("shell.windows-powershell", p));
    else caps.push(missing("shell.windows-powershell", "Windows PowerShell 5.1 ships with Windows; check SystemRoot and system file integrity (optional)"));
  }

  // shell.git-bash
  if (!win) caps.push(unsupported("shell.git-bash", ctx));
  else {
    const cands: string[] = [];
    const envBash = envGet(ctx, "CLAUDE_CODE_GIT_BASH_PATH");
    if (envBash) cands.push(envBash);
    else {
      if (gitPath) {
        // <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe -> <root>
        let root = path.win32.dirname(gitPath);
        while (/^(cmd|bin|mingw64)$/i.test(path.win32.basename(root))) root = path.win32.dirname(root);
        cands.push(path.win32.join(root, "bin", "bash.exe"));
      }
      const pf = envGet(ctx, "ProgramFiles");
      if (pf) cands.push(path.win32.join(pf, "Git", "bin", "bash.exe"));
    }
    const bash = cands.find(isFile);
    if (bash) caps.push({ id: "shell.git-bash", status: "ok", path: bash });
    else caps.push(missing("shell.git-bash", "Install Git for Windows (https://git-scm.com/downloads/win) or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe"));
  }

  // claude.cli
  {
    const home = win ? envGet(ctx, "USERPROFILE") : envGet(ctx, "HOME");
    const claude = locateClaudeExe(ctx, home);
    if (claude) {
      const r = await runVersion(claude, ["--version"], {
        DISABLE_AUTOUPDATER: "1",
        DISABLE_UPDATES: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      });
      caps.push(fromRun("claude.cli", r, claude));
    } else caps.push(missing("claude.cli", "Install Claude Code: https://code.claude.com/docs/en/setup"));
  }

  // isolation.wsl (never run: may prompt to install or start a VM)
  if (!win) caps.push(unsupported("isolation.wsl", ctx));
  else {
    const p = sys32("wsl.exe");
    caps.push(p && isFile(p)
      ? { id: "isolation.wsl", status: "unverified", path: p, detail: "wsl.exe present; distro/VM state not probed to avoid starting WSL" }
      : missing("isolation.wsl", "Optional: install WSL (admin required): wsl --install (advice only)"));
  }

  // isolation.docker (client only)
  {
    const d = resolveCommand("docker", ctx);
    if (d) {
      const c = fromRun("isolation.docker", await runVersion(d, ["--version"]), d);
      caps.push({ ...c, detail: [c.detail, "client only; daemon not checked"].filter(Boolean).join("; ") });
    } else caps.push(missing("isolation.docker", "Optional: install Docker Desktop: https://docs.docker.com/desktop/"));
  }

  // isolation.windows-sandbox
  if (!win) caps.push(unsupported("isolation.windows-sandbox", ctx));
  else {
    const p = sys32("WindowsSandbox.exe");
    caps.push(p && isFile(p)
      ? { id: "isolation.windows-sandbox", status: "unverified", path: p, detail: "WindowsSandbox.exe present; not launched" }
      : missing("isolation.windows-sandbox", "Optional: enabling the Windows Sandbox optional feature requires admin and Pro/Enterprise (advice only)"));
  }

  // jev.connectivity
  caps.push({
    id: "jev.connectivity",
    status: "blocked",
    detail: "System One adapter boundary exists (M0-06, #11) but live Jev transport is unauthorised and unverified. No network request made.",
  });

  return { schemaVersion: 1, platform: ctx.platform, arch: os.arch(), capabilities: caps };
}

export function formatReport(report: DoctorReport): string {
  const lines = [`ARRC doctor: ${report.platform} ${report.arch}`];
  for (const c of report.capabilities) {
    const info = [c.version, c.path && `(${c.path})`].filter(Boolean).join("  ");
    lines.push(`${`[${c.status}]`.padEnd(14)}${c.id.padEnd(27)}${info}`.trimEnd());
    if (c.detail) lines.push(`    ${c.detail}`);
    if (c.remedy) lines.push(`    -> ${c.remedy}`);
  }
  return lines.join("\n");
}

// import.meta.main is missing on older Node releases; fall back to comparing realpaths (junction/symlink safe).
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
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--json")) {
    process.stderr.write("Usage: doctor [--json]\n");
    process.exit(2);
  }
  const report = await runDoctor();
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  // ponytail: always exit 0 (diagnostic tool); add exit-code gating when a consumer needs it.
}
