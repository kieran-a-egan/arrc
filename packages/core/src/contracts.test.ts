import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { z } from "zod";
import {
  ExecutorCapability,
  OperationApproval,
  RunEvent,
  RunState,
  SystemOneDecision,
  TaskDag,
  TaskResult,
  parseContract,
} from "./contracts.ts";

const load = (f: string): any => JSON.parse(readFileSync(new URL(`../test/fixtures/${f}.valid.json`, import.meta.url), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const code = (s: z.ZodType, input: unknown) => {
  const r = parseContract(s, input);
  return r.ok ? "ok" : r.error.code;
};

const table: [string, z.ZodType, string][] = [
  ["TaskDag", TaskDag, "task-dag"],
  ["SystemOneDecision", SystemOneDecision, "system-one-decision"],
  ["ExecutorCapability", ExecutorCapability, "executor-capability"],
  ["OperationApproval", OperationApproval, "operation-approval"],
  ["RunEvent", RunEvent, "run-event"],
  ["RunState", RunState, "run-state"],
  ["TaskResult", TaskResult, "task-result"],
];

for (const [name, schema, file] of table) {
  test(`${name}: valid fixture round-trips through JSON`, () => {
    const r = parseContract(schema, load(file));
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(JSON.parse(JSON.stringify(r.value)), r.value);
  });
  test(`${name}: stale and unsupported versions`, () => {
    assert.equal(code(schema, { ...load(file), schemaVersion: 0 }), "stale_version");
    assert.equal(code(schema, { ...load(file), schemaVersion: 2 }), "unsupported_version");
  });
  test(`${name}: invalid schema`, () => {
    assert.equal(code(schema, { ...load(file), extra: 1 }), "invalid_schema");
    const missing = load(file);
    delete missing[Object.keys(missing)[1]!];
    assert.equal(code(schema, missing), "invalid_schema");
    for (const bad of ["x", null, 5, [], undefined]) assert.equal(code(schema, bad), "invalid_schema");
  });
}

test("error result is serialisable", () => {
  const r = parseContract(TaskDag, { schemaVersion: 1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(JSON.parse(JSON.stringify(r.error)), r.error);
});

test("CommandSpec is executable + args only", () => {
  const dag = (command: unknown) => {
    const d = load("task-dag");
    d.tasks[0].command = command;
    return code(TaskDag, d);
  };
  const approval = (operation: unknown) => code(OperationApproval, { ...load("operation-approval"), operation });
  assert.equal(dag({ executable: "git", args: [] }), "ok");
  for (const run of [dag, approval]) {
    assert.equal(run("git status"), "invalid_schema");
    assert.equal(run({ executable: "git", args: [], shell: true }), "invalid_schema");
    assert.equal(run({ executable: "git", args: ["a\0b"] }), "invalid_schema");
    assert.equal(run({ executable: "", args: [] }), "invalid_schema");
  }
});

test("OperationApproval authority rules", () => {
  const with_ = (patch: Record<string, unknown>) => code(OperationApproval, { ...load("operation-approval"), ...patch });
  assert.equal(with_({ approvedBy: { kind: "model", id: "m2" } }), "invalid_schema");
  assert.equal(with_({ approvedBy: { kind: "orchestrator", id: "o" } }), "invalid_schema");
  assert.equal(with_({ approvedBy: { kind: "user", id: "u1", scope: "*" } }), "invalid_schema");
  assert.equal(with_({ approvedBy: { kind: "user", id: "u1", isAdmin: true } }), "invalid_schema");
  assert.equal(with_({ requestedBy: { kind: "user", id: "u1" } }), "invalid_schema");
  assert.equal(with_({ expiresAt: "2026-01-01T00:00:00Z" }), "invalid_schema");
  assert.equal(with_({ expiresAt: "2025-01-01T00:00:00Z" }), "invalid_schema");
  assert.equal(with_({ operationDigest: "sha256:abc" }), "invalid_schema");
});

test("label strings reject NUL and blank", () => {
  const op = (target: string) => code(OperationApproval, { ...load("operation-approval"), target });
  assert.equal(op("a\u0000b"), "invalid_schema");
  assert.equal(op("   "), "invalid_schema");
  const res = (path: string) => {
    const r = load("task-result");
    r.evidence[1].path = path;
    return code(TaskResult, r);
  };
  assert.equal(res(" "), "invalid_schema");
  assert.equal(res("a\u0000b"), "invalid_schema");
  const d = load("task-dag");
  d.tasks[0].title = "a\u0000b";
  assert.equal(code(TaskDag, d), "invalid_schema");
});

test("SystemOneDecision cannot carry approval", () => {
  assert.equal(code(SystemOneDecision, { ...load("system-one-decision"), approved: true }), "invalid_schema");
});

test("TaskDag structural rules", () => {
  const t = (taskId: string, dependsOn: string[]) => ({ taskId, title: taskId, dependsOn, requiredCapabilities: [] });
  const dag = (...tasks: unknown[]) => code(TaskDag, { schemaVersion: 1, dagId: "d", tasks });
  assert.equal(dag(t("a", []), t("b", ["a"])), "ok");
  assert.equal(dag(t("a", ["b"]), t("b", ["a"])), "invalid_schema");
  assert.equal(dag(t("a", ["a"])), "invalid_schema");
  assert.equal(dag(t("a", ["zzz"])), "invalid_schema");
  assert.equal(dag(t("a", []), t("a", [])), "invalid_schema");
  assert.equal(dag(), "invalid_schema");
  assert.equal(dag(t("__proto__", [])), "invalid_schema");
  assert.equal(dag(t("a", []), t("b", ["a", "a"])), "invalid_schema");
  const msgs = (r: ReturnType<typeof parseContract>) => (r.ok ? [] : r.error.issues.map((i) => i.message));
  const dup = parseContract(TaskDag, { schemaVersion: 1, dagId: "d", tasks: [t("a", []), t("b", ["a", "a"])] });
  assert.ok(msgs(dup).some((m) => m.includes("duplicate")) && !msgs(dup).includes("dependency cycle"));
  const cyc = parseContract(TaskDag, { schemaVersion: 1, dagId: "d", tasks: [t("a", ["b"]), t("b", ["a"])] });
  assert.ok(msgs(cyc).includes("dependency cycle"));
  const big = Array.from({ length: 20000 }, (_, i) => t(`t${i}`, i ? [`t${i - 1}`] : []));
  assert.equal(dag(...big), "ok");
});

test("RunState pauseReason iff paused", () => {
  const s = load("run-state");
  delete s.pauseReason;
  assert.equal(code(RunState, s), "invalid_schema");
  assert.equal(code(RunState, { ...s, status: "running", pauseReason: "operator" }), "invalid_schema");
  assert.equal(code(RunState, { ...s, status: "running" }), "ok");
});

test("RunState rejects __proto__ task key", () => {
  const s = load("run-state");
  s.tasks = JSON.parse('{"__proto__":"pending"}');
  assert.equal(code(RunState, s), "invalid_schema");
  s.tasks = { "": "pending" };
  assert.equal(code(RunState, s), "invalid_schema");
});

test("distinct user approver is accepted", () => {
  const a = { ...load("operation-approval"), requestedBy: { kind: "user", id: "u1" }, approvedBy: { kind: "user", id: "u2" } };
  assert.equal(code(OperationApproval, a), "ok");
});

test("nested strictness", () => {
  const unrecognized = (s: z.ZodType, input: unknown) => {
    const r = parseContract(s, input);
    return !r.ok && r.error.code === "invalid_schema" && r.error.issues.some((i) => i.code === "unrecognized_keys");
  };
  const d = load("task-dag");
  d.tasks[0].extra = 1;
  assert.ok(unrecognized(TaskDag, d));
  for (let i = 0; i < 3; i++) {
    const r = load("task-result");
    r.evidence[i].extra = 1;
    assert.ok(unrecognized(TaskResult, r));
  }
  const e = load("run-event");
  e.extra = 1;
  assert.ok(unrecognized(RunEvent, e));
});

test("every RunEvent type parses", () => {
  const base = { schemaVersion: 1, eventId: "ev1", runId: "r1", seq: 0, at: "2026-01-01T00:00:00Z" };
  for (const extra of [
    { type: "run.started" },
    { type: "task.started", taskId: "a" },
    { type: "task.completed", taskId: "a" },
    { type: "task.failed", taskId: "a", reason: "x" },
    { type: "approval.granted", grantId: "g1" },
    { type: "run.paused", reason: "operator" },
  ])
    assert.equal(code(RunEvent, { ...base, ...extra }), "ok", extra.type);
});

test("non-integer schemaVersion is invalid_schema", () => {
  for (const v of [1.5, 0.5, NaN, Infinity]) assert.equal(code(TaskDag, { ...load("task-dag"), schemaVersion: v }), "invalid_schema");
});