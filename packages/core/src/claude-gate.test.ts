import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gateToolUse } from "./claude-gate.ts";
import { loadPolicy } from "./policy.ts";

const gatePath = path.join(import.meta.dirname, "claude-gate.ts");
const cfg = {
  schemaVersion: 1,
  policyId: "p1",
  rules: [
    { ruleId: "r", effect: "allow", principals: [{ kind: "model", id: "claude-code" }], operation: "fs.read", target: { root: "C:\\work" } },
    { ruleId: "w", effect: "allow", principals: [{ kind: "model", id: "claude-code" }], operation: "fs.write", target: { root: "C:\\work\\out" } },
  ],
};
const loaded = loadPolicy(cfg);
assert.ok(loaded.ok, JSON.stringify(loaded));
const policy = loaded.value;
const ev = (tool_name: string, tool_input: unknown, extra: object = {}) => ({ hook_event_name: "PreToolUse", cwd: "C:\\work", tool_name, tool_input, ...extra });
const decision = (x: unknown) => gateToolUse(policy, x).hookSpecificOutput.permissionDecision;

test("gate allows in-policy reads and writes", () => {
  assert.equal(decision(ev("Read", { file_path: "C:\\work\\a.txt" })), "allow");
  assert.equal(decision(ev("Grep", { pattern: "x" })), "allow"); // no path => cwd, which is in policy
  assert.equal(decision(ev("Glob", { pattern: "src/**/*.ts" })), "allow");
  for (const [t, k] of [["Write", "file_path"], ["Edit", "file_path"], ["MultiEdit", "file_path"], ["NotebookEdit", "notebook_path"]] as const)
    assert.equal(decision(ev(t, { [k]: "C:\\work\\out\\n.txt" })), "allow", t);
});

test("gate denies out-of-policy paths and escapes", () => {
  assert.equal(decision(ev("Write", { file_path: "C:\\work\\a.txt" })), "deny"); // read-only area
  assert.equal(decision(ev("Read", { file_path: "C:\\other\\a.txt" })), "deny");
  assert.equal(decision(ev("Read", { file_path: "C:\\work\\..\\other\\a.txt" })), "deny");
  assert.equal(decision(ev("Read", { file_path: "C:/work/a.txt" })), "deny"); // forward slashes rejected by checkPath
  assert.equal(decision(ev("Read", { file_path: "relative.txt" })), "deny");
  assert.equal(decision(ev("Grep", { pattern: "x", path: "C:\\other" })), "deny");
  assert.equal(decision(ev("Grep", { pattern: "x" }, { cwd: "C:\\other" })), "deny");
  assert.equal(decision(ev("Glob", { pattern: "C:\\other\\**" })), "deny");
  assert.equal(decision(ev("Glob", { pattern: "../**" })), "deny");
});

test("gate reads only the tool's own path field", () => {
  for (const t of ["Grep", "Glob"]) assert.equal(decision(ev(t, { pattern: "x", file_path: "C:\\work\\a", path: "C:\\other" })), "deny", t);
  assert.equal(decision(ev("Read", { path: "C:\\work\\a.txt" })), "deny");
  assert.equal(decision(ev("Write", { notebook_path: "C:\\work\\out\\n.txt" })), "deny");
  assert.equal(decision(ev("NotebookEdit", { file_path: "C:\\work\\out\\n.txt" })), "deny");
});

test("gate denies Glob patterns that escape the root", () => {
  for (const pattern of ["{..,x}/**/*", "{..}/secret/*", "~/.ssh/*", "..\\x", "C:\\x\\*", "/etc/*", "\\\\srv\\share\\*", "a/../b"])
    assert.equal(decision(ev("Glob", { pattern })), "deny", pattern);
  assert.equal(decision(ev("Glob", { pattern: "src/**/*.ts", path: "C:\\work" })), "allow");
});

test("gate denies prototype-chain tool names", () => {
  for (const t of ["toString", "constructor", "__proto__", "hasOwnProperty"]) assert.equal(decision(ev(t, { file_path: "C:\\work\\a.txt" })), "deny", t);
});

test("gate denies every unmediated tool class and malformed input", () => {
  for (const t of ["Bash", "PowerShell", "WebFetch", "WebSearch", "Task", "Agent", "mcp__srv__tool", "NotebookRead", "SomethingNew"])
    assert.equal(decision(ev(t, { command: "echo hi", file_path: "C:\\work\\a.txt" })), "deny", t);
  for (const bad of [null, undefined, 5, "x", {}, ev("Read", null), ev("Read", {}), ev("", { file_path: "C:\\work\\a" }), { ...ev("Read", { file_path: "C:\\work\\a" }), hook_event_name: "PostToolUse" }])
    assert.equal(decision(bad), "deny", JSON.stringify(bad));
});

test("gate denies for a context the policy does not name", () => {
  const r = gateToolUse(policy, ev("Read", { file_path: "C:\\work\\a.txt" }), { principal: { kind: "plugin", id: "x" } });
  assert.equal(r.hookSpecificOutput.permissionDecision, "deny");
});

function entry(policyJson: string, stdin: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arrc gate "));
  try {
    const p = path.join(dir, "policy.json");
    fs.writeFileSync(p, policyJson);
    return spawnSync(process.execPath, [gatePath, p], { input: stdin, encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("entrypoint prints hook JSON for allow and deny, exit 0", () => {
  const a = entry(JSON.stringify(cfg), JSON.stringify(ev("Read", { file_path: "C:\\work\\a.txt" })));
  assert.equal(a.status, 0);
  assert.equal(JSON.parse(a.stdout).hookSpecificOutput.permissionDecision, "allow");
  const d = entry(JSON.stringify(cfg), JSON.stringify(ev("Bash", { command: "ls" })));
  assert.equal(d.status, 0);
  assert.equal(JSON.parse(d.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("entrypoint exits 2 on bad policy, bad stdin JSON, or missing policy arg", () => {
  assert.equal(entry("{not json", "{}").status, 2);
  assert.equal(entry(JSON.stringify({ ...cfg, rules: [{ nope: 1 }] }), "{}").status, 2);
  assert.equal(entry(JSON.stringify(cfg), "not json").status, 2);
  const r = spawnSync(process.execPath, [gatePath], { input: "{}", encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /claude-gate/);
});
