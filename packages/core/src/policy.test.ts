import { test } from "node:test";
import assert from "node:assert/strict";
import { DENIED_EXECUTABLES, SUPPORTED_ENFORCEMENT, checkPath, decide, loadPolicy, operationDigest } from "./index.ts";
import type { CommandSpec, PolicyConfig } from "./index.ts";

const NOW = new Date("2026-06-01T12:00:00Z");
const model = { kind: "model", id: "m1" } as const;
const other = { kind: "model", id: "m2" } as const;
const orch = { kind: "orchestrator", id: "o1" } as const;
const user = { kind: "user", id: "u1" } as const;
const GIT: CommandSpec = { executable: "C:\\tools\\git.exe", args: ["status"], cwd: "C:\\repo" };

const rule = (ruleId: string, effect: "allow" | "deny", operation: string, target: unknown, principals: unknown[] = [model]) => ({
  ruleId, effect, principals, operation, target,
});
const cfg = (rules: unknown[], extra: object = {}) => ({ schemaVersion: 1, policyId: "p1", rules, ...extra });
function load(rules: unknown[], extra: object = {}): PolicyConfig {
  const r = loadPolicy(cfg(rules, extra));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}
const rejected = (input: unknown) => {
  const r = loadPolicy(input);
  assert.ok(!r.ok);
  return r.error;
};
const reason = (p: PolicyConfig, req: unknown) => {
  const d = decide(p, req, NOW);
  return d.allow ? "ALLOW" : d.reason;
};

const base = load([
  rule("r-read", "allow", "fs.read", { root: "C:\\repo" }),
  rule("w-write", "allow", "fs.write", { root: "C:\\repo" }),
  rule("s-git", "allow", "process.spawn", { command: GIT }),
]);
const read = (path: string, extra: object = {}) => ({ principal: model, operation: "fs.read", target: { path }, ...extra });
const spawn = (command: CommandSpec, extra: object = {}) => ({ principal: model, operation: "process.spawn", target: { command }, ...extra });

function approval(over: Record<string, unknown> = {}, cmd: CommandSpec = GIT) {
  return {
    schemaVersion: 1, grantId: "g1", operation: cmd, operationDigest: operationDigest(cmd), requestedBy: model,
    approvedBy: user, target: "C:\\repo", policyId: "p1",
    issuedAt: "2026-06-01T00:00:00Z", expiresAt: "2026-06-02T00:00:00Z", revoked: false, ...over,
  };
}

test("checkPath: rejects", () => {
  const bad = [
    "", "C:", "repo", "\\\\srv\\share\\a", "\\\\?\\C:\\a", "\\\\.\\C:\\a", "\\??\\C:\\a", "C:foo", "C:/a", "C:\\a/b",
    "C:\\a\\..\\b", "C:\\a\\.\\b", "C:\\PROGRA~1", "C:\\a:b", "C:\\a.", "C:\\a ", "C:\\a\\\\b", "C:\\\\", "C:\\a\\NUL.txt", "C:\\com1",
    "C:\\LPT9.log", "C:\\caf\u00e9", "C:\\a\u0001", "C:\\a\\b*", "C:\\a?", "C:\\a|b", "C:\\" + "a".repeat(257), "C:\\a<b", 'C:\\a"b',
    "C:\\com\u00b9", "C:\\CONIN$", "C:\\a\\clock$.x", "C:\\nul .txt",
  ];
  for (const p of bad) assert.equal(checkPath(p), null, JSON.stringify(p));
  for (const p of [null, undefined, 5, {}]) assert.equal(checkPath(p), null);
});

test("checkPath: accepts and normalises case", () => {
  assert.equal(checkPath("C:\\Repo\\A.txt"), "c:\\repo\\a.txt");
  assert.equal(checkPath("C:\\Repo\\"), "c:\\repo");
  assert.equal(checkPath("C:\\"), "c:\\");
  assert.notEqual(checkPath("C:\\" + "a".repeat(256)), null); // 259 chars
  assert.equal(checkPath("C:\\console\\com10"), "c:\\console\\com10");
});

test("exact scope and deny-by-default", () => {
  const cases: [string, unknown, string][] = [
    ["exact read", read("C:\\repo\\a.txt"), "ALLOW"],
    ["case-insensitive path", read("c:\\REPO\\A.txt"), "ALLOW"],
    ["root itself", read("C:\\repo"), "ALLOW"],
    ["sibling boundary", read("C:\\repo2\\a.txt"), "no_matching_rule"],
    ["outside", read("C:\\other"), "no_matching_rule"],
    ["traversal", read("C:\\repo\\..\\secret"), "invalid_target"],
    ["unknown operation", { principal: model, operation: "fs.delete", target: { path: "C:\\repo\\a" } }, "unknown_operation"],
    ["unknown tool", { principal: model, operation: "tool.shell", target: { command: GIT } }, "unknown_operation"],
    ["fs op with command target", { principal: model, operation: "fs.read", target: { command: GIT } }, "invalid_target"],
    ["spawn with path target", { principal: model, operation: "process.spawn", target: { path: "C:\\repo" } }, "invalid_target"],
    ["spawn without cwd", spawn({ executable: GIT.executable, args: ["status"] }), "invalid_target"],
    ["unmatched command", spawn({ ...GIT, executable: "C:\\tools\\other.exe" }), "no_matching_rule"],
    ["extra arg", spawn({ ...GIT, args: ["status", "-s"] }), "no_matching_rule"],
    ["arg case change", spawn({ ...GIT, args: ["Status"] }), "no_matching_rule"],
    ["different cwd", spawn({ ...GIT, cwd: "C:\\repo2" }), "no_matching_rule"],
    ["subdir cwd", spawn({ ...GIT, cwd: "C:\\repo\\sub" }), "no_matching_rule"],
    ["write allowed", { principal: model, operation: "fs.write", target: { path: "C:\\repo\\a" } }, "ALLOW"],
  ];
  for (const [n, req, want] of cases) {
    // spawn is high risk: without approval the exact match stops at approval_required
    const w = want === "ALLOW" && (req as { operation: string }).operation === "process.spawn" ? "approval_required" : want;
    assert.equal(reason(base, req), w, n);
  }
  assert.equal(reason(base, spawn(GIT)), "approval_required");
  assert.deepEqual(decide(base, spawn(GIT, { approval: approval() }), NOW), { allow: true, ruleId: "s-git", risk: "high" });
  assert.deepEqual(decide(base, read("C:\\repo\\a"), NOW), { allow: true, ruleId: "r-read", risk: "low" });
});

test("privilege escalation", () => {
  assert.equal(reason(base, { ...read("C:\\repo\\a"), principal: other }), "no_matching_rule");
  assert.equal(reason(base, { ...read("C:\\repo\\a"), principal: { kind: "plugin", id: "m1" } }), "no_matching_rule");
  assert.equal(reason(base, { principal: model, operation: "fs.write", target: { path: "C:\\repo\\.git\\hooks\\pre-commit" } }), "ceiling_violation");
  assert.equal(reason(base, { principal: model, operation: "fs.write", target: { path: "C:\\repo\\.GIT\\config" } }), "ceiling_violation");
  for (const exe of ["C:\\Windows\\System32\\cmd.exe", "C:\\x\\pwsh.exe", "C:\\x\\run.bat", "C:\\x\\run.ps1", "C:\\x\\a.com", "C:\\x\\PowerShell.EXE"]) {
    const c = { executable: exe, args: [], cwd: "C:\\repo" };
    const e = rejected(cfg([rule("x", "allow", "process.spawn", { command: c })]));
    assert.ok(e.issues.some((i) => i.code === "ceiling_violation"), exe);
    assert.equal(reason(base, spawn(c)), "ceiling_violation", exe);
  }
  const every = DENIED_EXECUTABLES.map((n) => `C:\\x\\${n}.exe`);
  for (const exe of [...every, "C:\\x\\CertUtil.exe", "C:\\x\\python3.12.exe", "C:\\x\\perl5.36.EXE"]) {
    const c = { executable: exe, args: [], cwd: "C:\\repo" };
    const e = rejected(cfg([rule("x", "allow", "process.spawn", { command: c })]));
    assert.ok(e.issues.some((i) => i.code === "ceiling_violation"), exe);
    assert.equal(reason(base, spawn(c)), "ceiling_violation", exe);
  }
  const bare = load([rule("bw", "allow", "fs.write", { root: "C:\\srv" })]);
  assert.equal(reason(bare, { principal: model, operation: "fs.write", target: { path: "C:\\srv\\repo.git\\hooks\\pre-receive" } }), "ceiling_violation");
  assert.ok(rejected(cfg([rule("bw", "allow", "fs.write", { root: "C:\\srv\\repo.git" })])).issues.some((i) => i.code === "ceiling_violation"));
  const t = (a: Record<string, unknown>) => decide(base, spawn(GIT, { approval: approval(a) }), NOW);
  const bad: [string, Record<string, unknown>][] = [
    ["digest mismatch", { operation: { ...GIT, args: ["push"] }, operationDigest: operationDigest({ ...GIT, args: ["push"] }) }],
    ["embedded op != digest", { operation: { ...GIT, args: ["push"] } }],
    ["expired", { expiresAt: "2026-06-01T11:00:00Z", issuedAt: "2026-06-01T10:00:00Z" }],
    ["at expiry", { expiresAt: "2026-06-01T12:00:00Z" }],
    ["not yet valid", { issuedAt: "2026-06-01T13:00:00Z", expiresAt: "2026-06-02T00:00:00Z" }],
    ["revoked", { revoked: true }],
    ["other policy", { policyId: "p2" }],
    ["other requester", { requestedBy: other }],
    ["other target", { target: "C:\\repo2" }],
  ];
  for (const [n, a] of bad) assert.deepEqual(t(a), { allow: false, reason: "approval_invalid" }, n);
  assert.equal(t({}).allow, true);
  // schema-level rejections (self-approval, non-user approver) fail closed as invalid_request
  assert.deepEqual(t({ requestedBy: user }), { allow: false, reason: "invalid_request" });
  assert.deepEqual(t({ approvedBy: orch }), { allow: false, reason: "invalid_request" });
  // approval for a different command than requested
  const push = { ...GIT, args: ["push"] };
  const p2 = load([rule("s", "allow", "process.spawn", { command: push })]);
  assert.equal(reason(p2, spawn(push, { approval: approval() })), "approval_invalid");
  // advice cannot lower risk below high
  const low = { schemaVersion: 1, decisionId: "d", taskId: "t", recommendation: "ok", confidence: 1, calibrated: true, risk: "low" };
  assert.equal(reason(base, spawn(GIT, { advice: low })), "approval_required");
  // advice can raise fs risk, and a high-risk fs op can never be approved
  const high = { ...low, risk: "high" };
  assert.equal(reason(base, read("C:\\repo\\a", { advice: high })), "approval_required");
  assert.equal(reason(base, read("C:\\repo\\a", { advice: high, approval: approval() })), "approval_invalid");
});

test("ceiling and policy are immutable", () => {
  assert.throws(() => (DENIED_EXECUTABLES as string[]).push("x"));
  assert.throws(() => (SUPPORTED_ENFORCEMENT as string[]).push("isolation.sandbox"));
  assert.throws(() => { (base as { policyId: string }).policyId = "evil"; });
  assert.throws(() => { (base.rules[0] as { effect: string }).effect = "deny"; });
  assert.throws(() => (base.rules as unknown[]).push({}));
});

test("conflicting configuration", () => {
  const a = rule("a", "allow", "fs.read", { root: "C:\\repo" });
  const d = rule("d", "deny", "fs.read", { root: "C:\\repo\\secret" });
  for (const order of [[a, d], [d, a]]) {
    const p = load(order);
    assert.equal(reason(p, read("C:\\repo\\secret\\k")), "denied_by_rule");
    assert.equal(reason(p, read("C:\\repo\\ok")), "ALLOW");
  }
  const codes = (e: ReturnType<typeof rejected>) => e.issues.map((i) => i.code);
  assert.ok(codes(rejected(cfg([a, a]))).includes("duplicate_rule_id"));
  // one bad allow rule rejects the whole config
  const e = rejected(cfg([a, rule("bad", "allow", "fs.write", { root: "C:\\repo\\.git" })]));
  assert.ok(codes(e).includes("ceiling_violation"));
  assert.ok(codes(rejected(cfg([rule("x", "allow", "fs.read", { root: "\\\\srv\\s" })]))).includes("invalid_path"));
  assert.ok(codes(rejected(cfg([rule("x", "allow", "process.spawn", { command: { executable: GIT.executable, args: [] } })]))).includes("missing_cwd"));
  assert.equal(rejected(cfg([a], { extra: 1 })).code, "invalid_schema");
  assert.equal(rejected(cfg([{ ...a, extra: 1 }])).code, "invalid_schema");
  assert.equal(rejected(cfg([rule("x", "allow", "fs.read", { command: GIT })])).code, "invalid_schema");
  assert.equal(rejected(cfg([rule("x", "allow", "process.spawn", { root: "C:\\r" })])).code, "invalid_schema");
  assert.equal(rejected(cfg([rule("x", "allow", "fs.delete", { root: "C:\\r" })])).code, "invalid_schema");
  assert.equal(rejected(cfg([rule("x", "allow", "fs.read", { root: "C:\\r" }, [])])).code, "invalid_schema");
  assert.equal(rejected({ ...cfg([a]), schemaVersion: 0 }).code, "stale_version");
  assert.equal(rejected({ ...cfg([a]), schemaVersion: 2 }).code, "unsupported_version");
});

test("write-then-exec overlap is rejected", () => {
  const w = (root: string) => rule("w", "allow", "fs.write", { root });
  const s = (executable: string) => rule("s", "allow", "process.spawn", { command: { executable, args: [], cwd: "C:\\repo" } });
  for (const [root, exe] of [["C:\\repo", "C:\\repo\\bin\\app.exe"], ["C:\\tools\\plugins", "C:\\tools\\app.exe"]] as const)
    for (const order of [[w(root), s(exe)], [s(exe), w(root)]])
      assert.ok(rejected(cfg(order)).issues.some((i) => i.code === "write_exec_overlap"), root);
  load([w("C:\\repo"), s("C:\\tools\\git.exe")]);
});

test("spawn deny rules match broadly", () => {
  const cases: [string, CommandSpec, CommandSpec, string][] = [
    ["no cwd", { executable: GIT.executable, args: ["status"] }, GIT, "denied_by_rule"],
    ["no cwd, empty args", { executable: GIT.executable, args: [] }, GIT, "denied_by_rule"],
    ["matching cwd", { ...GIT, cwd: "C:\\REPO" }, GIT, "denied_by_rule"],
    ["different cwd", { ...GIT, cwd: "C:\\other" }, GIT, "ALLOW"],
    ["deny cwd covers subdir", { ...GIT, cwd: "C:\\repo" }, { ...GIT, cwd: "C:\\repo\\sub" }, "denied_by_rule"],
    ["deny drive root", { ...GIT, args: [], cwd: "C:\\" }, GIT, "denied_by_rule"],
    ["deny cwd not sibling", { ...GIT, cwd: "C:\\repo" }, { ...GIT, cwd: "C:\\repo2" }, "approval_invalid"], // not denied (fixture approval targets C:\\repo)
    ["args [] denies all", { ...GIT, args: [] }, GIT, "denied_by_rule"],
    ["prefix push", { ...GIT, args: ["push"] }, { ...GIT, args: ["push", "--force"] }, "denied_by_rule"],
    ["prefix push vs status", { ...GIT, args: ["push"] }, GIT, "ALLOW"],
  ];
  for (const [n, denyCmd, req, want] of cases) {
    const a = rule("a", "allow", "process.spawn", { command: req });
    const d = rule("d", "deny", "process.spawn", { command: denyCmd });
    for (const order of [[a, d], [d, a]])
      assert.equal(reason(load(order), spawn(req, { approval: approval({}, req) })), want, n);
  }
  const bad = rule("d", "deny", "process.spawn", { command: { executable: GIT.executable, args: [], cwd: "C:\\a\\..\\b" } });
  assert.ok(rejected(cfg([bad])).issues.some((i) => i.code === "invalid_path"));
  const badDeny = { schemaVersion: 1, policyId: "p1", rules: [rule("d", "deny", "fs.read", { root: "C:\\repo\\..\\repo" })] } as unknown as PolicyConfig;
  assert.equal(reason(badDeny, read("C:\\repo\\a")), "denied_by_rule");
  // runtime effect is not trusted: anything but exactly "allow" denies
  const forged = { schemaVersion: 1, policyId: "p1", rules: [{ ...rule("r", "allow", "fs.read", { root: "C:\\repo" }), effect: "Deny" }] } as unknown as PolicyConfig;
  assert.equal(reason(forged, read("C:\\repo\\a")), "denied_by_rule");
  // forged policies (bypass loadPolicy): malformed deny always matches, malformed allow never does
  const forge = (...rules: unknown[]) => ({ schemaVersion: 1, policyId: "p1", rules }) as unknown as PolicyConfig;
  const goodAllow = rule("a", "allow", "process.spawn", { command: GIT });
  const run = (p: PolicyConfig) => reason(p, spawn(GIT, { approval: approval() }));
  assert.equal(run(forge(goodAllow)), "ALLOW");
  for (const c of [{ ...GIT, executable: "C:\\tools\\..\\git.exe" }, { ...GIT, cwd: "C:\\repo\\..\\repo" }])
    assert.equal(run(forge(goodAllow, rule("d", "deny", "process.spawn", { command: c }))), "denied_by_rule");
  assert.equal(reason(forge(rule("a", "allow", "fs.read", { root: "C:\\repo\\..\\repo" })), read("C:\\repo\\a")), "no_matching_rule");
  assert.equal(run(forge(rule("a", "allow", "process.spawn", { command: { ...GIT, executable: "C:\\tools\\..\\git.exe" } }))), "no_matching_rule");
  // operation/target shape mismatch: never an allow, always a deny
  assert.equal(run(forge(rule("a", "allow", "process.spawn", { root: "C:\\" }))), "no_matching_rule");
  assert.equal(run(forge(goodAllow, rule("d", "deny", "process.spawn", { root: "C:\\" }))), "denied_by_rule");
  assert.equal(reason(forge(rule("a", "allow", "fs.read", { command: GIT })), read("C:\\repo\\a")), "no_matching_rule");
  assert.equal(reason(forge(rule("d", "deny", "fs.read", { command: GIT })), read("C:\\repo\\a")), "denied_by_rule");
  // fs.write deny vs allow, and drive-root scope
  const w = load([rule("w", "allow", "fs.write", { root: "C:\\repo" }), rule("wd", "deny", "fs.write", { root: "C:\\repo\\sub" })]);
  assert.equal(reason(w, { principal: model, operation: "fs.write", target: { path: "C:\\repo\\sub\\f" } }), "denied_by_rule");
  const root = load([rule("r", "allow", "fs.read", { root: "C:\\" })]);
  assert.equal(reason(root, read("C:\\x")), "ALLOW");
  assert.equal(reason(root, read("D:\\x")), "no_matching_rule");
});

test("worktree is not a sandbox", () => {
  for (const requires of [["isolation.sandbox"], ["network.none"], ["worktree"], [""]])
    assert.equal(reason(base, read("C:\\repo\\a", { requires })), "unsupported_enforcement");
  assert.equal(reason(base, read("C:\\repo\\a", { requires: [] })), "ALLOW");
});

test("fails closed", () => {
  const adv = { schemaVersion: 1, decisionId: "d", taskId: "t", recommendation: "ok", confidence: 0.4, calibrated: false, risk: "high" };
  assert.equal(reason(base, read("C:\\repo\\a", { advice: adv })), "uncalibrated_high_risk_advice");
  const garbage = [null, undefined, 1, "x", [], {}, { ...read("C:\\repo\\a"), extra: 1 }, { ...read("C:\\repo\\a"), principal: { kind: "root", id: "x" } },
    read("C:\\repo\\a", { requires: "x" }), read("C:\\repo\\a", { advice: { risk: "low" } })];
  for (const g of garbage) assert.equal(reason(base, g), "invalid_request", JSON.stringify(g));
  const cyc: Record<string, unknown> = {};
  cyc["self"] = cyc;
  assert.doesNotThrow(() => decide(base, cyc, NOW));
  assert.equal(reason(null as unknown as PolicyConfig, read("C:\\repo\\a")), "internal_error");
  assert.deepEqual(decide(base, spawn(GIT, { approval: approval() }), new Date(NaN)), { allow: false, reason: "approval_invalid" });
});

test("operationDigest is stable and cwd-sensitive", () => {
  assert.match(operationDigest(GIT), /^sha256:[0-9a-f]{64}$/);
  assert.equal(operationDigest(GIT), operationDigest({ ...GIT }));
  assert.notEqual(operationDigest(GIT), operationDigest({ executable: GIT.executable, args: GIT.args }));
});
