import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runClaude } from "./claude-probe.ts";
import { resolveCommand } from "./doctor.ts";
import { parseContract, CommandSpec, SystemOneRequest, adviseSystemOne, buildRequest, decide, loadPolicy, loadSystemOneGate, checkPath } from "./index.ts";
import { planLaunch, runLaunch, taskkillPath } from "./launch.ts";
import { system32, system32From } from "./doctor.ts";
import { echoScript, executorConformance, fakeProviders, fixtureDir, win, type Exec } from "./conformance-support.ts";

const NOT_WIN = "Windows-only: .ps1/.cmd launch semantics";
const NATIVE_WIN_ONLY = "Windows-only: the native launcher accepts only drive-absolute paths";
const lastJson = (s: string) => JSON.parse(s.trim().split("\n").pop()!);

// ---- planLaunch matrix ----
test("planLaunch: .exe direct, .ps1 only with an explicit shell, .cmd/.bat/other/relative blocked", { skip: !win && NATIVE_WIN_ONLY }, () => {
  const ctx = { platform: process.platform, env: process.env };
  const A = "C:\\t\\a b\u00fc";
  assert.deepEqual(planLaunch({ file: `${A}\\x.exe`, args: ["1"] }), { ok: true, command: `${A}\\x.exe`, args: ["1"] });
  const pwsh = resolveCommand("pwsh", ctx, ".exe");
  assert.deepEqual(
    planLaunch({ file: `${A}\\x.ps1`, args: ["1"], shell: "pwsh" }),
    pwsh ? { ok: true, command: pwsh, args: ["-NoProfile", "-NonInteractive", "-File", `${A}\\x.ps1`, "1"] } : { ok: false, reason: "shell_not_found" },
  );
  const ps5 = planLaunch({ file: `${A}\\x.PS1`, shell: "powershell" });
  assert.ok(ps5.ok && /powershell\.exe$/i.test(ps5.command));
  assert.deepEqual(ps5.ok && ps5.args, ["-NoProfile", "-NonInteractive", "-File", `${A}\\x.PS1`]);
  assert.deepEqual(planLaunch({ file: `${A}\\x.ps1` }), { ok: false, reason: "shell_required_for_ps1" });
  for (const shell of ["bash", "constructor", "toString"]) assert.deepEqual(planLaunch({ file: `${A}\\x.ps1`, shell: shell as never }), { ok: false, reason: "unknown_shell" });
  for (const f of ["x.cmd", "x.bat", "X.CMD"]) assert.deepEqual(planLaunch({ file: `${A}\\${f}`, shell: "pwsh" }), { ok: false, reason: "blocked_cmd_shim" });
  assert.deepEqual(planLaunch({ file: `${A}\\x.js` }), { ok: false, reason: "unsupported_extension" });
  assert.deepEqual(planLaunch({ file: "x.exe" }), { ok: false, reason: "path_not_absolute" });
  for (const f of ["..\\x.exe", "C:x.exe", "\\x.exe", "/x.exe", "\\\\srv\\share\\x.exe", "\\\\?\\C:\\x.exe", "C:\\a\\b.txt:s.exe"])
    assert.deepEqual(planLaunch({ file: f }), { ok: false, reason: "path_not_absolute" }, f);
  for (const f of ["C:\\a\\x.exe.", "C:\\a\\x.exe ", "C:\\a\\x.exe.cmd", "C:\\a\\x.EXE.BAT"]) assert.equal(planLaunch({ file: f }).ok, false, f);
  assert.equal(planLaunch({ file: "C:\\a\\x.EXE" }).ok, true);
});

test("planLaunch: interpreter is an absolute path outside cwd", { skip: !win && NOT_WIN }, () => {
  for (const shell of ["pwsh", "powershell"] as const) {
    const p = planLaunch({ file: "C:\\a\\x.ps1", shell });
    if (!p.ok) {
      assert.equal(shell, "pwsh");
      assert.equal(p.reason, "shell_not_found"); // pwsh not installed: refused, never a bare name
      continue;
    }
    assert.ok(path.isAbsolute(p.command), p.command);
    assert.ok(!path.resolve(p.command).toLowerCase().startsWith(process.cwd().toLowerCase() + path.sep), p.command);
  }
});

// ---- executor conformance: same assertions, native launcher and external (Claude) executor ----
const native: Exec = async (o) => {
  const r = await runLaunch({ file: o.exe, args: [o.script, o.arg] }, o);
  let args: string[] | undefined;
  let orphanPid: number | undefined;
  for (const l of r.stdout.split("\n")) {
    try {
      const e = JSON.parse(l);
      args = e.args ?? args;
      orphanPid = e.pid ?? orphanPid;
    } catch {
      // not JSON: ignore
    }
  }
  return { exitCode: r.exitCode, ...(orphanPid ? { orphanPid } : {}), ...(args ? { args } : {}), ...(r.error ? { error: r.error } : {}), timedOut: r.timedOut };
};
const claude: Exec = async (o) => {
  let args: string[] | undefined;
  let orphanPid: number | undefined;
  const r = await runClaude({ exe: o.exe, prefixArgs: [o.script], prompt: o.arg, timeoutMs: o.timeoutMs, ...(o.env ? { env: o.env } : {}), onEvent: (e) => {
      args = (e as { args?: string[] }).args ?? args;
      orphanPid = (e as { pid?: number }).pid ?? orphanPid;
    } });
  // echo.mjs sees [-p, prompt, ...] after the script; the shared case only needs the prompt present
  return { exitCode: r.exitCode, ...(orphanPid ? { orphanPid } : {}), ...(args ? { args } : {}), ...(r.spawnError ? { error: r.spawnError } : {}), timedOut: r.timedOut };
};
executorConformance("native", native, !win ? NATIVE_WIN_ONLY : undefined);
executorConformance("claude-external", claude);

// ---- .ps1 / .cmd through explicit shells ----
for (const shell of ["pwsh", "powershell"] as const)
  test(`.ps1 runs from a unicode/space dir via explicit ${shell}`, { skip: !win && NOT_WIN }, async (t) => {
    const { ps1 } = fixtureDir(t);
    const arg = "h\u00e9llo w\u00f6rld \u2713";
    const r = await runLaunch({ file: ps1, args: [arg, "b", 'a"b', "trail\\", "", "-Command"], shell }, { timeoutMs: 30_000, env: { ARRC_EXIT: "5" } });
    assert.equal(r.error, undefined, r.stderr);
    assert.equal(r.exitCode, 5);
    assert.deepEqual(lastJson(r.stdout), [arg, "b", 'a"b', "trail\\", "", "-Command"]);
  });

test(".cmd fixture is blocked and never run, even with a shell", { skip: !win && NATIVE_WIN_ONLY }, async (t) => {
  const spec = { file: fixtureDir(t).cmd, shell: "pwsh" } as const;
  assert.deepEqual(planLaunch(spec), { ok: false, reason: "blocked_cmd_shim" });
  assert.equal((await runLaunch(spec, { timeoutMs: 5000 })).error, "blocked_cmd_shim");
});

test("runLaunch plans internally: missing exe is ENOENT, bad spec is a structured plan error", { skip: !win && NATIVE_WIN_ONLY }, async (t) => {
  const { dir, cmd } = fixtureDir(t);
  assert.equal((await runLaunch({ file: path.join(dir, "no-such.exe") }, { timeoutMs: 5000 })).error, "ENOENT");
  assert.equal((await runLaunch({ file: "x.exe" }, { timeoutMs: 5000 })).error, "path_not_absolute");
  assert.equal((await runLaunch({ file: cmd }, { timeoutMs: 5000 })).error, "blocked_cmd_shim");
});

test("planLaunch/runLaunch off Windows: unsupported_platform, nothing spawned", { skip: win && "non-Windows only" }, async () => {
  const unsupported = { ok: false, reason: "unsupported_platform" };
  assert.deepEqual(planLaunch({ file: "C:\\x\\foo.exe" }), unsupported);
  assert.deepEqual(planLaunch({ file: "/usr/bin/node" }), unsupported);
  const r = await runLaunch({ file: "C:\\x\\foo.exe" }, { timeoutMs: 5000 });
  assert.equal(r.error, "unsupported_platform");
  assert.equal(r.exitCode, null);
});

test("SystemRoot that is not drive-absolute never yields a cwd-relative interpreter or taskkill path", async () => {
  const prev = process.env.SystemRoot;
  try {
    for (const bad of ["", ".", "C:relative", "relative\\dir", "\\\\srv\\share", "\\\\?\\C:\\Windows", "\\Windows", " C:\\Windows", "C:\\a:b"]) {
      process.env.SystemRoot = bad;
      const driveAbs = (p: string) => path.win32.isAbsolute(p) && /^[A-Za-z]:[\\/]/.test(p);
      // taskkill, claude-trust reg.exe (system32) and doctor's sys32 (system32From with the ctx value) share these helpers
      for (const p of [taskkillPath(), system32("reg.exe"), system32From(bad, "WindowsPowerShell", "v1.0", "powershell.exe")])
        assert.ok(driveAbs(p), `SystemRoot=${JSON.stringify(bad)}: ${p}`);
      if (!win) continue; // planLaunch is Windows-only (unsupported_platform elsewhere)
      const p = planLaunch({ file: "C:\\x\\a.ps1", shell: "powershell" });
      assert.deepEqual(p, { ok: false, reason: "shell_not_found" }, `SystemRoot=${JSON.stringify(bad)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = prev;
  }
});

// Source assertion instead of a seam: regKeyState and runDoctor's sys32 are not injectable without invasive wiring.
test("claude-trust.ts and doctor.ts build System32 paths only via the validated helpers", () => {
  for (const f of ["claude-trust.ts", "launch.ts"]) {
    const src = fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
    assert.ok(!/process\.env\.SystemRoot/.test(src), `${f} must use the doctor.ts helpers`);
  }
  assert.ok(!/"System32"/.test(fs.readFileSync(path.join(import.meta.dirname, "claude-trust.ts"), "utf8")));
  assert.ok(/system32\("reg\.exe"\)/.test(fs.readFileSync(path.join(import.meta.dirname, "claude-trust.ts"), "utf8")));
  assert.ok(/system32From\(envGet\(ctx, "SystemRoot"\)/.test(fs.readFileSync(path.join(import.meta.dirname, "doctor.ts"), "utf8")));
});

test("pwsh resolved from a root-relative PATH entry is refused (shell_not_found)", { skip: !win && NOT_WIN }, (t) => {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const saved = process.env[key];
  const dir = fixtureDir(t).dir;
  const noDrive = dir.slice(2); // \Users\...\arrc conf ü✓ : root-relative
  fs.writeFileSync(path.join(dir, "pwsh.exe"), "");
  try {
    process.env[key] = noDrive;
    assert.deepEqual(planLaunch({ file: "C:\\x\\a.ps1", shell: "pwsh" }), { ok: false, reason: "shell_not_found" });
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test("launch.ts never uses shell: true", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "launch.ts"), "utf8");
  assert.ok(!/shell:\s*true/.test(src), "launch.ts must not use shell: true");
});

test("runLaunch caps output at 1 MiB and flags truncation only when bytes were dropped", { skip: !win && NATIVE_WIN_ONLY }, async (t) => {
  const { exe } = fixtureDir(t);
  const run = (big: number) => runLaunch({ file: exe, args: [echoScript] }, { timeoutMs: 20_000, env: { ARRC_BIG: String(big) } });
  const over = await run(2 << 20);
  assert.equal(over.stdout.length, 1 << 20);
  assert.equal(over.truncated, true);
  const small = await run(10);
  assert.equal(small.truncated, undefined);
});

test("runLaunch: after a surrogate pair is cut at the cap, later chunks are ignored (true prefix)", { skip: !win && NATIVE_WIN_ONLY }, async (t) => {
  const { exe } = fixtureDir(t);
  const r = await runLaunch({ file: exe, args: [echoScript] }, { timeoutMs: 20_000, env: { ARRC_SURR: "1" } });
  assert.equal(r.stdout.length, 2 ** 20 - 1);
  assert.equal(r.truncated, true);
  assert.equal(r.stdout.at(-1), "x");
});

test("runLaunch: abort cancels a hanging run and resolves, never rejects", { skip: !win && NATIVE_WIN_ONLY }, async (t) => {
  const { exe } = fixtureDir(t);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const r = await runLaunch({ file: exe, args: [echoScript] }, { timeoutMs: 20_000, env: { ARRC_HANG: "1" }, signal: ac.signal });
  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
});

// ---- permission refusal: documents the current policy guarantee; no policy change ----
test("policy refuses to spawn fixture executables and rejects the unicode path", (t) => {
  const pol = loadPolicy({ schemaVersion: 1, policyId: "p1", rules: [] });
  assert.ok(pol.ok);
  const ctx = { principal: { kind: "model", id: "m1" } } as const;
  const spawn = (executable: string) => decide(pol.value, { operation: "process.spawn", target: { command: { executable, args: [], cwd: "C:\\repo" } } }, ctx);
  const { exe, ps1, cmd } = fixtureDir(t);
  assert.equal(checkPath(exe), null);
  for (const f of [exe, ps1, cmd]) assert.deepEqual(spawn(f), { allow: false, reason: "invalid_target" });
  assert.deepEqual(spawn("C:\\Windows\\System32\\cmd.exe"), { allow: false, reason: "ceiling_violation" });
  assert.deepEqual(spawn("C:\\tools\\echo.ps1"), { allow: false, reason: "ceiling_violation" });
});

// ---- schema failures ----
test("System One fakes: valid ok; throw/hang/invalid output degrade to ok:false", async () => {
  const gate = loadSystemOneGate({ supportedCategories: ["review"], minConfidence: 0.5, timeoutMs: 50, calibratedModels: [{ model: "m", modelVersion: "1" }] });
  assert.ok(gate.ok);
  const req = buildRequest({ requestId: "r1", taskId: "t1", category: "review", operation: "fs.read", files: [{ path: "C:\\a\\b.ts", content: "x" }] });
  const reason = async (p: Parameters<typeof adviseSystemOne>[0]) => {
    const o = await adviseSystemOne(p, req, gate.value);
    return o.ok ? "ok" : o.reason;
  };
  assert.equal(await reason(fakeProviders.valid()), "ok");
  assert.equal(await reason(fakeProviders.throws()), "unavailable");
  assert.equal(await reason(fakeProviders.schemaInvalid()), "invalid_response");
  assert.equal(await reason(fakeProviders.hangs()), "timeout");
});

test("parseContract rejects an invalid CommandSpec and a bad request", () => {
  assert.equal(parseContract(CommandSpec, { executable: "", args: [] }).ok, false);
  assert.equal(parseContract(CommandSpec, { executable: "a\0b", args: [] }).ok, false);
  assert.equal(parseContract(CommandSpec, { executable: "a", args: [], extra: 1 }).ok, false);
  assert.equal(parseContract(SystemOneRequest, { nope: 1 }).ok, false);
});
