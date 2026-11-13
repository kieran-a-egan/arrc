import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exitCodeFor, runScenarios } from "./claude-gate-live.ts";
import { buildGateArgs, runClaude } from "./claude-probe.ts";
import { CLOUD_ENV, insideGitRepo, scanHookTrust } from "./claude-trust.ts";

const fixture = path.join(import.meta.dirname, "..", "test", "fixtures", "fake-claude.mjs");
const gatePath = path.join(import.meta.dirname, "claude-gate.ts");

function dirs(t: { after: (f: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arrc-trust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const d = { root, home: path.join(root, "home"), cwd: path.join(root, "cwd"), managed: path.join(root, "managed") };
  for (const p of [path.join(d.home, ".claude"), path.join(d.cwd, ".claude"), path.join(d.managed, "managed-settings.d")]) fs.mkdirSync(p, { recursive: true });
  return d;
}
const absent = () => "absent" as const; // never query the real registry in tests
const scan = (d: ReturnType<typeof dirs>, env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = process.platform) =>
  scanHookTrust({ env, cwd: d.cwd, home: d.home, platform, managedDir: d.managed, regState: absent });

test("scanHookTrust: missing files are trusted", (t) => {
  const r = scan(dirs(t));
  assert.deepEqual(r, { trusted: true, reasons: [], apiKeyInSettings: false });
});

test("scanHookTrust: every disabler key is untrusted in every source", (t) => {
  const d = dirs(t);
  const files: [string, string][] = [
    ["user settings", path.join(d.home, ".claude", "settings.json")],
    ["project settings", path.join(d.cwd, ".claude", "settings.json")],
    ["project local settings", path.join(d.cwd, ".claude", "settings.local.json")],
    ["managed settings", path.join(d.managed, "managed-settings.json")],
    ["managed drop-in x.json", path.join(d.managed, "managed-settings.d", "x.json")],
  ];
  for (const [label, file] of files)
    for (const key of ["disableAllHooks", "allowManagedHooksOnly", "strictPluginOnlyCustomization"]) {
      fs.writeFileSync(file, JSON.stringify({ [key]: true }));
      const r = scan(d);
      assert.equal(r.trusted, false, `${label} ${key}`);
      assert.deepEqual(r.reasons, [`${label} sets ${key}`]);
      fs.writeFileSync(file, JSON.stringify({ [key]: false }));
      assert.equal(scan(d).trusted, true, `${label} ${key}=false`);
      fs.rmSync(file);
    }
});

test("scanHookTrust: CLAUDE_CONFIG_DIR replaces ~/.claude", (t) => {
  const d = dirs(t);
  const alt = path.join(d.root, "alt");
  fs.mkdirSync(alt);
  fs.writeFileSync(path.join(alt, "settings.json"), JSON.stringify({ disableAllHooks: true }));
  assert.equal(scan(d, { CLAUDE_CONFIG_DIR: alt }).trusted, false);
});

test("scanHookTrust: unreadable or invalid sources are untrusted", (t) => {
  const d = dirs(t);
  const f = path.join(d.cwd, ".claude", "settings.json");
  for (const body of ["{not json", "[]", "null", ""]) {
    fs.writeFileSync(f, body);
    assert.deepEqual(scan(d).reasons, ["project settings unreadable or invalid"], body);
  }
  fs.rmSync(f);
  fs.mkdirSync(f); // a directory where a file should be: EISDIR
  assert.equal(scan(d).trusted, false);
  fs.rmSync(f, { recursive: true });
  fs.writeFileSync(path.join(d.managed, "managed-settings.d", "bad.json"), "{");
  assert.equal(scan(d).trusted, false);
});

test("scanHookTrust: hook-disabling env vars; names are case-insensitive on win32 only", (t) => {
  const d = dirs(t);
  for (const k of ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_PERSONAL_HOOKS_OFF", "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG"]) {
    assert.deepEqual(scan(d, { [k]: "1" }).reasons, [`env ${k}`], k);
    assert.equal(scan(d, { [k]: "0" }).trusted, true, `${k}=0`);
    assert.equal(scan(d, { [k]: "" }).trusted, true, `${k} empty`);
    assert.equal(scan(d, { [k.toLowerCase()]: "1" }, "win32").trusted, false, `${k} lowercase on win32`);
    assert.equal(scan(d, { [k.toLowerCase()]: "1" }, "linux").trusted, true, `${k} lowercase on linux`);
  }
});

test("scanHookTrust: hook-off env set through a settings env block is untrusted", (t) => {
  const d = dirs(t);
  fs.writeFileSync(path.join(d.cwd, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_SIMPLE: "1" } }));
  assert.deepEqual(scan(d).reasons, ["project settings env sets CLAUDE_CODE_SIMPLE"]);
});

test("scanHookTrust: widening defaultMode is untrusted; safe modes are not", (t) => {
  const d = dirs(t);
  const f = path.join(d.home, ".claude", "settings.json");
  for (const m of ["bypassPermissions", "acceptEdits", "auto"]) {
    fs.writeFileSync(f, JSON.stringify({ permissions: { defaultMode: m } }));
    assert.equal(scan(d).trusted, false, m);
  }
  for (const m of ["default", "plan", "dontAsk"]) {
    fs.writeFileSync(f, JSON.stringify({ permissions: { defaultMode: m } }));
    assert.equal(scan(d).trusted, true, m);
  }
});

test("scanHookTrust: apiKeyInSettings is presence-only and never leaks values", (t) => {
  const d = dirs(t);
  const f = path.join(d.cwd, ".claude", "settings.local.json");
  for (const s of [{ apiKeyHelper: "SECRET-HELPER" }, { env: { ANTHROPIC_API_KEY: "SECRET-KEY" } }, { env: { ANTHROPIC_AUTH_TOKEN: "SECRET-TOKEN" } }]) {
    fs.writeFileSync(f, JSON.stringify(s));
    const r = scan(d);
    assert.equal(r.apiKeyInSettings, true);
    assert.equal(r.trusted, true);
    assert.ok(!JSON.stringify(r).includes("SECRET"));
  }
  fs.writeFileSync(f, JSON.stringify({ env: { OTHER: "x" } }));
  assert.equal(scan(d).apiKeyInSettings, false);
  fs.writeFileSync(f, JSON.stringify({ disableAllHooks: true, env: { ANTHROPIC_API_KEY: "SECRET-KEY" } }));
  assert.ok(!JSON.stringify(scan(d)).includes("SECRET"));
});

test("scanHookTrust: a git repository at or above cwd is untrusted (settings resolve from the git root)", (t) => {
  const d = dirs(t);
  assert.equal(insideGitRepo(d.cwd), false);
  const deep = path.join(d.cwd, "deep", "er");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(d.root, ".git"), "gitdir: elsewhere"); // a .git FILE (worktree/submodule) counts too
  assert.deepEqual(scanHookTrust({ env: {}, cwd: deep, home: d.home, platform: process.platform, managedDir: d.managed, regState: absent }).reasons, ["cwd inside a git repository"]);
  fs.rmSync(path.join(d.root, ".git"));
  fs.mkdirSync(path.join(d.cwd, ".git"));
  assert.deepEqual(scan(d).reasons, ["cwd inside a git repository"]);
});

test("scanHookTrust: win32 registry policy keys are presence-only; only 'absent' is trusted", (t) => {
  const d = dirs(t);
  const seen: string[] = [];
  const mk = (st: (k: string) => "absent" | "present" | "error", platform: NodeJS.Platform = "win32") =>
    scanHookTrust({ env: {}, cwd: d.cwd, home: d.home, platform, managedDir: d.managed, regState: (k) => (seen.push(k), st(k)) });
  assert.equal(mk(() => "absent").trusted, true);
  assert.deepEqual(seen, ["HKLM\\SOFTWARE\\Policies\\ClaudeCode", "HKCU\\SOFTWARE\\Policies\\ClaudeCode"]);
  assert.deepEqual(mk((k) => (k.startsWith("HKCU") ? "present" : "absent")).reasons, ["registry policy HKCU present"]);
  assert.deepEqual(mk((k) => (k.startsWith("HKLM") ? "error" : "absent")).reasons, ["registry policy HKLM error"]);
  seen.length = 0;
  mk(() => "present", "linux");
  assert.deepEqual(seen, [], "no registry query off win32");
});

test("scanHookTrust: billing-affecting config is flagged presence-only (.claude.json primaryApiKey, settings env base-url/cloud flags)", (t) => {
  const d = dirs(t);
  const g = path.join(d.home, ".claude.json");
  fs.writeFileSync(g, JSON.stringify({ primaryApiKey: "SECRET-PRIMARY" }));
  assert.equal(scan(d).apiKeyInSettings, true);
  assert.ok(!JSON.stringify(scan(d)).includes("SECRET"));
  fs.writeFileSync(g, "{oops");
  assert.equal(scan(d).apiKeyInSettings, true, "invalid fails closed");
  fs.writeFileSync(g, JSON.stringify({ oauthAccount: {} }));
  assert.equal(scan(d).apiKeyInSettings, false);
  const alt = path.join(d.root, "alt");
  fs.mkdirSync(alt);
  fs.writeFileSync(path.join(alt, ".claude.json"), JSON.stringify({ primaryApiKey: "x" }));
  assert.equal(scan(d, { CLAUDE_CONFIG_DIR: alt }).apiKeyInSettings, true, "CLAUDE_CONFIG_DIR replaces home for .claude.json");
  const f = path.join(d.cwd, ".claude", "settings.local.json");
  for (const k of ["ANTHROPIC_BASE_URL", ...CLOUD_ENV]) {
    fs.writeFileSync(f, JSON.stringify({ env: { [k]: "https://SECRET" } }));
    assert.equal(scan(d).apiKeyInSettings, true, k);
    assert.ok(!JSON.stringify(scan(d)).includes("SECRET"));
  }
});

const opts = (d: ReturnType<typeof dirs>) => ({ exe: process.execPath, prefixArgs: [fixture], env: {}, home: d.home, managedDir: d.managed, regState: absent, timeoutMs: 20_000, runEnv: { FAKE_CLAUDE_MODE: "hook", FAKE_CLAUDE_APIKEYSOURCE: "none" } });

// The policy kernel is lexical and Windows-only (drive-absolute backslash paths), so the allow-in-policy scenarios cannot pass on POSIX; skipped, not faked.
const winOnly = { skip: process.platform !== "win32" ? "policy kernel matches Windows drive-absolute paths only" : false };

test("scenario runner: S1-S6 and the S6 control pass against the fixture, evidence is sanitised, sandbox removed", winOnly, async (t) => {
  const d = dirs(t);
  const { refused, records } = await runScenarios(opts(d));
  assert.equal(refused, undefined);
  assert.deepEqual(records.map((r) => [r.scenario, r.outcome]), ["S1", "S2", "S3", "S4", "S5", "S6", "S6-control"].map((s) => [s, "pass"]));
  assert.equal(exitCodeFor({ records }), 0);
  const ctl = records[6]!;
  assert.equal(ctl.control, true);
  assert.equal((ctl.observed as any).nonceBPresent, true, "control: the unregistered hook leaks the out-of-policy read");
  assert.deepEqual((ctl.observed as any).auditDecisions, []);
  assert.equal((ctl.observed as any).fileToolsWithheld, false);
  assert.equal((records[3]!.observed as any).label, "isolated (not exposed)");
  assert.deepEqual((records[0]!.observed as any).toolsExposed, ["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit"]);
  assert.deepEqual((records[5]!.observed as any).toolsExposed, []);
  const json = JSON.stringify(records);
  assert.ok(!json.includes(os.tmpdir()), "no paths in evidence");
  assert.ok(!/arrc-gate-/.test(json));
  const s1 = records[0]!.observed as any;
  assert.deepEqual(s1.auditDecisions, [{ tool_name: "Read", decision: "allow", reason: "rule read-in" }]);
  const s2 = records[1]!.observed as any;
  assert.equal(s2.auditDecisions[0].decision, "deny");
  assert.match(s2.auditDecisions[0].reason, /^policy: /);
  assert.equal((records[5]!.observed as any).fileToolsWithheld, true);
  assert.ok(!fs.readdirSync(os.tmpdir()).some((n) => n.startsWith("arrc-gate-") && fs.existsSync(path.join(os.tmpdir(), n, "policy.json"))), "sandbox deleted");
});

test("scenario runner: no successful result event means inconclusive, never pass", async (t) => {
  const d = dirs(t);
  const { records, refused } = await runScenarios({ ...opts(d), runEnv: { FAKE_CLAUDE_MODE: "fail", FAKE_CLAUDE_APIKEYSOURCE: "none" } });
  assert.match(refused ?? "", /missing/, "no init event: fail closed after S1");
  assert.equal(records.length, 1);
  assert.ok(records.every((r) => r.outcome === "inconclusive"));
  assert.equal(exitCodeFor({ records }), 1);
});

test("scenario runner: a denial scenario where the model never attempted the tool is inconclusive", async (t) => {
  const d = dirs(t);
  const tool = JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(d.root, "x.txt"), content: "x" } });
  const { records } = await runScenarios({ ...opts(d), runEnv: { FAKE_CLAUDE_MODE: "hook", FAKE_CLAUDE_TOOL: tool, FAKE_CLAUDE_APIKEYSOURCE: "none" } });
  const by = Object.fromEntries(records.map((r) => [r.scenario, r.outcome]));
  for (const id of ["S1", "S2", "S5", "S6-control"]) assert.equal(by[id], "inconclusive", id); // no Read attempt
  assert.equal(exitCodeFor({ records }), 1);
});

test("exitCodeFor: refused, missing control, fail or inconclusive all exit 1", () => {
  type O = "pass" | "fail" | "inconclusive";
  const rec = (outcome: O) => ({ scenario: "S", expectation: "", control: false, observed: {}, outcome, cliVersion: undefined, timestamp: "" });
  const seven = (o: O) => Array.from({ length: 7 }, () => rec(o));
  assert.equal(exitCodeFor({ records: seven("pass") }), 0);
  assert.equal(exitCodeFor({ records: seven("pass").slice(1) }), 1);
  assert.equal(exitCodeFor({ records: seven("pass"), refused: "x" }), 1);
  assert.equal(exitCodeFor({ records: [...seven("pass").slice(1), rec("fail")] }), 1);
  assert.equal(exitCodeFor({ records: [...seven("pass").slice(1), rec("inconclusive")] }), 1);
});

test("scenario runner aborts after the first scenario if init apiKeySource is not none", async (t) => {
  const d = dirs(t);
  const { refused, records } = await runScenarios({ ...opts(d), runEnv: { FAKE_CLAUDE_MODE: "hook", FAKE_CLAUDE_APIKEYSOURCE: "ANTHROPIC_API_KEY" } });
  assert.match(refused ?? "", /aborted after first scenario/);
  assert.equal(records.length, 1);
  assert.equal((records[0]!.observed as any).apiKeySource, "ANTHROPIC_API_KEY");
  const missing = await runScenarios({ ...opts(d), runEnv: { FAKE_CLAUDE_MODE: "hook" } });
  assert.match(missing.refused ?? "", /apiKeySource is missing/);
  assert.equal(missing.records.length, 1);
  const ok = await runScenarios({ ...opts(d), runEnv: { FAKE_CLAUDE_MODE: "hook", FAKE_CLAUDE_APIKEYSOURCE: "none" } });
  assert.equal(ok.refused, undefined);
  assert.equal(ok.records.length, 7);
  assert.equal((ok.records[0]!.observed as any).apiKeySource, "none");
});

test("scenario runner refuses (no spawn) on primaryApiKey, invalid .claude.json, settings env billing keys, or process ANTHROPIC_BASE_URL", async (t) => {
  const d = dirs(t);
  const marker = path.join(d.root, "marker");
  const o = { ...opts(d), runEnv: { FAKE_CLAUDE_MODE: "hook", FAKE_CLAUDE_MARKER: marker } };
  const g = path.join(d.home, ".claude.json");
  const s = path.join(d.home, ".claude", "settings.json");
  const cases: [string, () => Promise<{ refused?: string }>][] = [
    ["primaryApiKey", async () => (fs.writeFileSync(g, JSON.stringify({ primaryApiKey: "SECRET" })), runScenarios(o))],
    ["invalid .claude.json", async () => (fs.writeFileSync(g, "{bad"), runScenarios(o))],
    ["settings env base url", async () => (fs.rmSync(g), fs.writeFileSync(s, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://SECRET" } })), runScenarios(o))],
    ["settings env bedrock", async () => (fs.writeFileSync(s, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } })), runScenarios(o))],
    ["process env base url", async () => (fs.rmSync(s), runScenarios({ ...o, env: { ANTHROPIC_BASE_URL: "https://SECRET" } }))],
  ];
  for (const [name, go] of cases) {
    const r = await go();
    assert.match(r.refused ?? "", /refused/, name);
    assert.ok(!JSON.stringify(r).includes("SECRET"), name);
  }
  assert.equal(fs.existsSync(marker), false, "claude never spawned");
});

test("scenario runner refuses when API-key billing may apply, without running claude", async (t) => {
  const d = dirs(t);
  const marker = path.join(d.root, "marker");
  const o = { ...opts(d), runEnv: { FAKE_CLAUDE_MODE: "hook", FAKE_CLAUDE_MARKER: marker } };
  const a = await runScenarios({ ...o, env: { ANTHROPIC_API_KEY: "sk-SECRET" } });
  assert.match(a.refused ?? "", /refused/);
  assert.ok(!JSON.stringify(a).includes("SECRET"));
  fs.writeFileSync(path.join(d.home, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "x" }));
  assert.match((await runScenarios(o)).refused ?? "", /apiKeyInSettings=true/);
  assert.equal(fs.existsSync(marker), false);
});

test("regression: disableAllHooks leaves the hook unregistered; scan withholds file tools so the read is blocked", async (t) => {
  const d = dirs(t);
  const sandbox = path.join(d.root, "sb");
  fs.mkdirSync(path.join(sandbox, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
  const canary = path.join(sandbox, "canary.txt");
  fs.writeFileSync(canary, "CANARY-NONCE");
  const policy = path.join(sandbox, "policy.json");
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, policyId: "p", rules: [] })); // would deny everything if the hook ran
  const read = async (withholdFileTools: boolean) => {
    const seen: string[] = [];
    await runClaude({ exe: process.execPath, prefixArgs: [fixture], cwd: sandbox, prompt: `Use the Read tool to read ${canary} and reply with its exact contents.`, timeoutMs: 20_000, env: { FAKE_CLAUDE_MODE: "hook" }, extraArgs: buildGateArgs(gatePath, policy, { withholdFileTools }), onEvent: (e) => seen.push(JSON.stringify(e)) });
    return seen.join("").includes("CANARY-NONCE");
  };
  const trust = scanHookTrust({ env: {}, cwd: sandbox, home: d.home, platform: process.platform, managedDir: d.managed, regState: absent });
  assert.equal(trust.trusted, false);
  assert.equal(await read(true), false, "withheld: blocked");
  assert.equal(await read(false), true, "control: without withholding the unregistered hook leaks the file (the hole being closed)");
});
