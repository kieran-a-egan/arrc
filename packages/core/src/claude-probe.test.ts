import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildGateArgs, classifyAuth, fingerprint, locateClaude, runClaude } from "./claude-probe.ts";

const win = process.platform === "win32";
const gatePath = path.join(import.meta.dirname, "claude-gate.ts");
const probePath = path.join(import.meta.dirname, "claude-probe.ts");
const fixture = path.join(import.meta.dirname, "..", "test", "fixtures", "fake-claude.mjs");
const run = promisify(execFile);
const base = { exe: process.execPath, prefixArgs: [fixture], prompt: "hi", timeoutMs: 10_000 };

function tmp(t: { after: (f: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arrc probe "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}
// Starts the hanging fake; returns the grandchild pid once written. Cleans up on exit.
function hang(t: { after: (f: () => void) => void }, extra: object) {
  let pidFile = "";
  let selfPidFile = "";
  // Registered before tmp(): after-hooks run FIFO, so the pid files must still exist when this runs.
  // Kills the direct child too, so a killTree regression fails the test instead of hanging the runner.
  t.after(() => {
    for (const f of [pidFile, selfPidFile])
      try {
        process.kill(Number(fs.readFileSync(f, "utf8")));
      } catch {
        // already gone
      }
  });
  const dir = tmp(t);
  pidFile = path.join(dir, "pid");
  selfPidFile = path.join(dir, "selfpid");
  const env = { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_PIDFILE: pidFile, FAKE_CLAUDE_SELFPIDFILE: selfPidFile };
  const self = () => Number(fs.readFileSync(selfPidFile, "utf8"));
  const grandchild = async () => {
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    return Number(fs.readFileSync(pidFile, "utf8"));
  };
  return { p: runClaude({ ...base, env, ...extra }), grandchild, self };
}

test("locateClaude: explicit absolute exe is ok; relative is blocked; missing is missing", (t) => {
  const dir = tmp(t);
  const exe = path.join(dir, win ? "claude.exe" : "claude");
  fs.writeFileSync(exe, "");
  const o = { env: {}, platform: process.platform, homedir: dir };
  assert.equal(locateClaude({ ...o, explicit: exe }).status, "ok");
  assert.equal(locateClaude({ ...o, explicit: "claude.exe" }).status, "blocked");
  assert.equal(locateClaude({ ...o, explicit: path.join(dir, "nope", win ? "c.exe" : "c") }).status, "missing");
  assert.equal(locateClaude(o).status, "missing");
});

test("locateClaude: explicit beats ARRC_CLAUDE_EXE beats default", (t) => {
  const dir = tmp(t);
  const [a, b] = ["a", "b"].map((n) => path.join(dir, win ? `${n}.exe` : n));
  fs.writeFileSync(a!, "");
  fs.writeFileSync(b!, "");
  const o = { env: { ARRC_CLAUDE_EXE: b }, platform: process.platform, homedir: dir };
  assert.equal(locateClaude({ ...o, explicit: a! }).path, a);
  assert.equal(locateClaude(o).path, b);
  assert.equal(locateClaude(o).source, "ARRC_CLAUDE_EXE");
});

test("locateClaude: default falls back to ~/.local/bin", (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, ".local", "bin"), { recursive: true });
  const exe = path.join(dir, ".local", "bin", win ? "claude.exe" : "claude");
  fs.writeFileSync(exe, "");
  assert.equal(locateClaude({ env: { PATH: dir }, platform: process.platform, homedir: dir }).path, exe);
});

test("locateClaude: a .cmd earlier on PATH does not block the native exe fallback (win32)", { skip: !win }, (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "claude.cmd"), "");
  fs.mkdirSync(path.join(dir, ".local", "bin"), { recursive: true });
  const exe = path.join(dir, ".local", "bin", "claude.exe");
  fs.writeFileSync(exe, "");
  const r = locateClaude({ env: { PATH: dir, PATHEXT: ".CMD;.EXE" }, platform: "win32", homedir: dir });
  assert.equal(r.status, "ok");
  assert.equal(r.path, exe);
});

test("locateClaude: trims whitespace and one pair of quotes from the override", (t) => {
  const dir = tmp(t);
  const exe = path.join(dir, win ? "claude.exe" : "claude");
  fs.writeFileSync(exe, "");
  const r = locateClaude({ explicit: `  "${exe}" `, env: {}, platform: process.platform, homedir: dir });
  assert.equal(r.path, exe);
  assert.equal(r.status, "ok");
});

test("locateClaude: trims whitespace and quotes from ARRC_CLAUDE_EXE", (t) => {
  const dir = tmp(t);
  const exe = path.join(dir, win ? "claude.exe" : "claude");
  fs.writeFileSync(exe, "");
  const r = locateClaude({ env: { ARRC_CLAUDE_EXE: ` "${exe}" ` }, platform: process.platform, homedir: dir });
  assert.equal(r.path, exe);
  assert.equal(r.source, "ARRC_CLAUDE_EXE");
});

test("locateClaude: .cmd shim is blocked and never executed (win32)", { skip: !win }, (t) => {
  const dir = tmp(t);
  const marker = path.join(dir, "marker.txt");
  const shim = path.join(dir, "claude.cmd");
  fs.writeFileSync(shim, `@echo ran> "${marker}"\r\n`);
  for (const explicit of [shim, undefined]) {
    const r = locateClaude({ ...(explicit ? { explicit } : {}), env: { PATH: dir, PATHEXT: ".CMD" }, platform: "win32", homedir: dir });
    assert.equal(r.status, "blocked");
    assert.match(r.detail ?? "", /shim/);
  }
  assert.equal(fs.existsSync(marker), false);
});

test("fingerprint records existence and presence only, never contents or values", async (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "SECRET-CRED-CONTENT");
  const env = { ANTHROPIC_API_KEY: "sk-SECRET-VALUE", CLAUDE_CODE_USE_BEDROCK: "" };
  const fp = await fingerprint(process.execPath, { env, homedir: home, cwd: home });
  assert.equal(fp.version, process.version);
  assert.equal(fp.config["~/.claude/settings.json"], true);
  assert.equal(fp.config["~/.claude/settings.local.json"], false);
  assert.equal(fp.envPresent.ANTHROPIC_API_KEY, true);
  assert.equal(fp.envPresent.CLAUDE_CODE_USE_BEDROCK, false);
  assert.equal(fp.envPresent.ANTHROPIC_AUTH_TOKEN, false);
  const json = JSON.stringify(fp);
  assert.ok(!json.includes("SECRET"));
  assert.ok(!json.includes("credentials"));
});

test("runClaude parses the stream and passes model/resume through", async () => {
  const r = await runClaude({ ...base, model: "haiku", resume: "sess-9" });
  assert.equal(r.exitCode, 0);
  assert.equal(r.sessionId, "sess-9");
  assert.equal(r.model, "haiku");
  assert.deepEqual(r.toolUses, [{ name: "Read", id: "tu1" }]);
  assert.deepEqual(r.result, { subtype: "success", isError: false });
  assert.deepEqual(r.eventCounts, { system: 1, assistant: 1, user: 1, result: 1 });
  assert.equal(r.malformedLines, 0);
});

test("runClaude counts malformed lines without throwing", async () => {
  const r = await runClaude({ ...base, env: { FAKE_CLAUDE_MODE: "malformed" } });
  assert.equal(r.malformedLines, 1);
  assert.equal(r.result?.subtype, "success");
});

test("runClaude reports non-zero exit and stderr", async () => {
  const r = await runClaude({ ...base, env: { FAKE_CLAUDE_MODE: "fail" } });
  assert.equal(r.exitCode, 3);
  assert.match(r.stderrTail, /boom/);
});

test("runClaude reports spawn failure without rejecting", async () => {
  const r = await runClaude({ ...base, exe: path.join(os.tmpdir(), "arrc-no-such-exe.exe") });
  assert.ok(r.spawnError);
});

test("runClaude timeout kills the process", async (t) => {
  const h = hang(t, { timeoutMs: 1500 });
  const r = await h.p;
  assert.equal(r.timedOut, true);
  assert.equal(r.cancelled, false);
  assert.equal(r.eventCounts.system, 1);
  assert.equal(await gone(h.self()), true, "direct child must be terminated");
});

test("runClaude abort cancels and kills the whole tree (win32)", { skip: !win }, async (t) => {
  const ac = new AbortController();
  const h = hang(t, { signal: ac.signal, onEvent: () => ac.abort() });
  const r = await h.p;
  assert.equal(r.cancelled, true);
  const pid = await h.grandchild();
  assert.equal(await gone(pid), true, "grandchild must be terminated");
});

test("runClaude abort cancels (all platforms)", async (t) => {
  const ac = new AbortController();
  const h = hang(t, { signal: ac.signal, onEvent: () => ac.abort() });
  const r = await h.p;
  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
  assert.equal(await gone(h.self()), true, "direct child must be terminated");
});

test("runClaude rejects prompts starting with '-' without spawning", async (t) => {
  const marker = path.join(tmp(t), "marker");
  for (const prompt of ["--dangerously-skip-permissions", "  --help"]) {
    const r = await runClaude({ ...base, prompt, env: { FAKE_CLAUDE_MARKER: marker } });
    assert.match(r.spawnError ?? "", /must not start with '-'/);
    assert.equal(r.exitCode, null);
  }
  assert.equal(fs.existsSync(marker), false);
});

test("runClaude reports exit code and null signal on a normal exit", async () => {
  const r = await runClaude(base);
  assert.equal(r.exitCode, 0);
  assert.equal(r.signal, null);
});

test("runClaude with an already-aborted signal does not spawn", async (t) => {
  const marker = path.join(tmp(t), "marker");
  const r = await runClaude({ ...base, signal: AbortSignal.abort(), env: { FAKE_CLAUDE_MARKER: marker } });
  assert.equal(r.cancelled, true);
  assert.equal(r.sessionId, undefined);
  assert.equal(fs.existsSync(marker), false);
});

test("runClaude spawn failure leaves exitCode null", async () => {
  const r = await runClaude({ ...base, exe: path.join(os.tmpdir(), "arrc-no-such-exe.exe") });
  assert.equal(r.exitCode, null);
});

test("classifyAuth follows documented precedence, presence only", () => {
  const key = { ANTHROPIC_API_KEY: "sk-SECRET", CLAUDE_CODE_OAUTH_TOKEN: "oauth-SECRET" };
  const a = classifyAuth(key);
  assert.deepEqual([a.billing, a.source, a.apiKeyOverridesSubscription, a.possibleCharges], ["api", "ANTHROPIC_API_KEY", true, true]);
  assert.ok(!JSON.stringify(a).includes("SECRET"));
  const none = classifyAuth({});
  assert.deepEqual([none.billing, none.possibleCharges, none.apiKeyOverridesSubscription], ["unknown", "unknown", false]);
  assert.equal(classifyAuth({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "k" }).billing, "cloud");
  // Env names are case-insensitive on Windows only.
  assert.equal(classifyAuth({ anthropic_auth_token: "t" }).source, win ? "ANTHROPIC_AUTH_TOKEN" : "unknown");
  const sub = classifyAuth({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
  assert.deepEqual([sub.billing, sub.possibleCharges, sub.apiKeyOverridesSubscription], ["subscription", "unknown", false]);
  assert.equal(classifyAuth({}, { apiKeySource: "apiKeyHelper" }).billing, "api");
  for (const s of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    const k = classifyAuth({}, { apiKeySource: s });
    assert.deepEqual([k.billing, k.possibleCharges, k.source, k.apiKeySource, k.apiKeyOverridesSubscription], ["api", true, s, s, true]);
  }
  const raw = classifyAuth({}, { apiKeySource: "/login managed key" });
  assert.deepEqual([raw.billing, raw.apiKeySource], ["unknown", "/login managed key"]);
});

test("runClaude records init apiKeySource, rate limits (unknown when absent) and cost estimate", async () => {
  const r = await runClaude({ ...base, env: { FAKE_CLAUDE_MODE: "limits" } });
  assert.equal(r.apiKeySource, "none");
  assert.deepEqual(r.rateLimits, [
    { status: "allowed_warning", resetsAt: 1790000000, rateLimitType: "five_hour", utilization: 0.82 },
    { status: "allowed", resetsAt: "unknown", rateLimitType: "unknown", utilization: "unknown" },
    { status: "unknown", resetsAt: "unknown", rateLimitType: "unknown", utilization: "unknown" },
  ]);
  assert.equal(r.costUsdEstimate, 0.0123);
  assert.equal((await runClaude(base)).rateLimits.length, 0);
});

test("runClaude refuses args that bypass or disable permission enforcement, without spawning", async (t) => {
  const marker = path.join(tmp(t), "marker");
  for (const extra of [["--dangerously-skip-permissions"], ["--allow-dangerously-skip-permissions"], ["--permission-mode", "bypassPermissions"], ["--bare"], ["--safe-mode"], ["--managed-settings", "{}"], ["--managed-settings={}"], ["--bare=1"], ["--dangerously-skip-permissions=true"], ["--permission-mode=bypassPermissions"], ["--setting-sources", "user"], ["--setting-sources=user"], ["--settings", "{}", "--settings", "{}"], ["--settings=a", "--settings", "b"]]) {
    const r = await runClaude({ ...base, extraArgs: extra, env: { FAKE_CLAUDE_MARKER: marker } });
    assert.match(r.spawnError ?? "", /refused/, extra.join(" "));
  }
  assert.equal(fs.existsSync(marker), false);
});

test("runClaude refuses caller env that disables hooks, and strips it from the inherited env", async (t) => {
  const dir = tmp(t);
  const marker = path.join(dir, "marker");
  for (const k of ["CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_SIMPLE", ...(win ? ["claude_code_safe_mode"] : [])]) {
    const r = await runClaude({ ...base, env: { [k]: "0", FAKE_CLAUDE_MARKER: marker } });
    assert.match(r.spawnError ?? "", /refused/, k);
  }
  assert.equal(fs.existsSync(marker), false);
  const out = path.join(dir, "envout");
  const prev = [process.env.CLAUDE_CODE_SIMPLE, process.env.CLAUDE_CODE_SAFE_MODE];
  process.env.CLAUDE_CODE_SIMPLE = "1";
  process.env.CLAUDE_CODE_SAFE_MODE = "1";
  try {
    const r = await runClaude({ ...base, env: { FAKE_CLAUDE_ENVOUT: out } });
    assert.equal(r.exitCode, 0);
  } finally {
    for (const [k, v] of [["CLAUDE_CODE_SIMPLE", prev[0]], ["CLAUDE_CODE_SAFE_MODE", prev[1]]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), [null, null]);
  if (win) {
    // inherited lowercase key: the child's env lookup is case-insensitive on Windows, so it would see it if not stripped
    const prevLc = process.env.claude_code_simple;
    process.env.claude_code_simple = "1";
    try {
      const r = await runClaude({ ...base, env: { FAKE_CLAUDE_ENVOUT: out } });
      assert.equal(r.exitCode, 0);
    } finally {
      if (prevLc === undefined) delete process.env.claude_code_simple;
      else process.env.claude_code_simple = prevLc;
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), [null, null]);
  }
});

test("runClaude only inspects extraArgs, not the prompt", async () => {
  const r = await runClaude({ ...base, prompt: "explain --bare mode and bypassPermissions" });
  assert.equal(r.spawnError, undefined);
  assert.equal(r.exitCode, 0);
});

test("buildGateArgs wires a PreToolUse hook and no-prompt mode", () => {
  const a = buildGateArgs("C:\\g\\claude-gate.ts", "C:\\p\\policy.json");
  assert.equal(a[2], "--permission-prompts");
  assert.equal(a[3], "none");
  const h = JSON.parse(a[1]!).hooks.PreToolUse[0];
  assert.equal(h.matcher, "*");
  assert.equal(h.hooks[0].command, process.execPath);
  assert.deepEqual(h.hooks[0].args, ["C:\\g\\claude-gate.ts", "C:\\p\\policy.json"]);
  assert.equal(h.hooks[0].onFailure, "block");
  assert.equal(a[4], "--disallowedTools");
  for (const t of ["Bash", "PowerShell", "WebFetch", "WebSearch", "Task", "Agent", "mcp__*", "ListMcpResourcesTool", "ReadMcpResourceTool"]) assert.ok(a[5]!.split(",").includes(t), t);
});

test("fixture models fail-open: a broken hook blocks only with onFailure:block", async (t) => {
  const dir = tmp(t);
  const settings = (onFailure?: string) =>
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: process.execPath, args: [path.join(dir, "missing.js")], ...(onFailure ? { onFailure } : {}) }] }] } });
  const go = async (s: string) => {
    const executed = path.join(dir, `executed-${Math.random()}`);
    const tool = { tool_name: "Read", tool_input: { file_path: "C:\\work\\a.txt" } };
    await runClaude({ ...base, extraArgs: ["--settings", s], env: { FAKE_CLAUDE_MODE: "hook", FAKE_CLAUDE_TOOL: JSON.stringify(tool), FAKE_CLAUDE_EXECUTED: executed } });
    return fs.existsSync(executed);
  };
  assert.equal(await go(settings("block")), false);
  assert.equal(await go(settings()), true);
});

test("fixture: tool runs only when the gate hook allows it (interception before execution)", async (t) => {
  const dir = tmp(t);
  const policyPath = path.join(dir, "policy.json");
  const principals = [{ kind: "model", id: "claude-code" }];
  fs.writeFileSync(policyPath, JSON.stringify({ schemaVersion: 1, policyId: "p1", rules: [{ ruleId: "r", effect: "allow", principals, operation: "fs.read", target: { root: "C:\\work" } }] }));
  const extraArgs = buildGateArgs(gatePath, policyPath);
  const go = async (tool: object) => {
    const executed = path.join(dir, `executed-${Math.random()}`);
    const r = await runClaude({ ...base, extraArgs, env: { FAKE_CLAUDE_MODE: "hook", FAKE_CLAUDE_TOOL: JSON.stringify(tool), FAKE_CLAUDE_EXECUTED: executed } });
    assert.equal(r.exitCode, 0, r.stderrTail);
    return fs.existsSync(executed);
  };
  assert.equal(await go({ tool_name: "Read", tool_input: { file_path: "C:\\work\\a.txt" } }), true);
  assert.equal(await go({ tool_name: "Read", tool_input: { file_path: "C:\\secret\\a.txt" } }), false);
  assert.equal(await go({ tool_name: "Write", tool_input: { file_path: "C:\\work\\a.txt" } }), false);
  assert.equal(await go({ tool_name: "Bash", tool_input: { command: "echo hi" } }), false);
  assert.equal(await go({ tool_name: "mcp__x__y", tool_input: {} }), false);
  // A broken policy makes the hook exit 2, which must also block.
  fs.writeFileSync(policyPath, "{broken");
  assert.equal(await go({ tool_name: "Read", tool_input: { file_path: "C:\\work\\a.txt" } }), false);
});

test("CLI rejects unknown flags and --exe without a value with exit code 2", async () => {
  for (const args of [["--bogus"], ["--exe"], ["--exe", "--json"], ["--model"], ["--live", "--model"], ["--gate"], ["--gate", "p.json"]])
    await assert.rejects(run(process.execPath, [probePath, ...args]), (e: { code?: number }) => e.code === 2);
});

test("claude-probe source stays free of shells, credential files, network and writes", () => {
  const src = fs.readFileSync(probePath, "utf8");
  for (const bad of [".credentials", "claude.json", "fetch(", "readFile", "writeFile", "rmSync", "unlink"]) {
    assert.ok(!src.includes(bad), `claude-probe.ts must not contain ${bad}`);
  }
  assert.ok(!/shell:\s*true/.test(src), "claude-probe.ts must not use shell: true");
});
