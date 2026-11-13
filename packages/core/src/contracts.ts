import { z } from "zod";

// All object schemas are z.strictObject (zod strictness is per-object): unknown fields are
// rejected so they can never silently widen permissions. JSON-safe types only.

export const SCHEMA_VERSION = 1;
const schemaVersion = z.literal(SCHEMA_VERSION);

export type ParseIssue = { path: string; code: string; message: string };
export type ParseResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: "stale_version" | "unsupported_version" | "invalid_schema"; issues: ParseIssue[] };
    };

/** Single shared entry point: version check first, then strict schema parse. */
export function parseContract<S extends z.ZodType>(schema: S, input: unknown): ParseResult<z.infer<S>> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const v = Object.hasOwn(input, "schemaVersion") ? (input as Record<string, unknown>)["schemaVersion"] : undefined;
    if (typeof v === "number" && Number.isInteger(v) && v !== SCHEMA_VERSION) {
      return {
        ok: false,
        error: {
          code: v < SCHEMA_VERSION ? "stale_version" : "unsupported_version",
          issues: [{ path: "schemaVersion", code: "invalid_value", message: `got ${v}, expected ${SCHEMA_VERSION}` }],
        },
      };
    }
  }
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  const issues = r.error.issues.map((i) => ({
    path: i.path.map(String).join("."),
    code: i.code,
    message: i.message,
  }));
  return { ok: false, error: { code: "invalid_schema", issues } };
}

// ---- building blocks ----

// One shared id schema for every identifier (also record keys): excludes "", "__proto__", leading punctuation.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export { id as Id };
const noNul = (s: string) => !s.includes("\0");
const safeString = z.string().refine(noNul, "must not contain NUL");
const label = safeString.min(1).refine((s) => s.trim().length > 0, "must not be blank");
const timestamp =z.iso.datetime();

// ponytail: executable + argv only. .exe/.cmd/.ps1 launcher handling belongs to the executor milestone.
export const CommandSpec = z.strictObject({
  executable: safeString.min(1),
  args: z.array(safeString),
  cwd: safeString.min(1).optional(),
});
export type CommandSpec = z.infer<typeof CommandSpec>;

export const Principal = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), id }),
  z.strictObject({ kind: z.literal("orchestrator"), id }),
  z.strictObject({ kind: z.literal("model"), id }),
  z.strictObject({ kind: z.literal("plugin"), id }),
]);
export type Principal = z.infer<typeof Principal>;

export const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type Digest = z.infer<typeof Digest>;

// ---- 1. TaskDag ----

export const Task = z.strictObject({
  taskId: id,
  title: label,
  dependsOn: z.array(id),
  requiredCapabilities: z.array(id),
  command: CommandSpec.optional(),
});
export type Task = z.infer<typeof Task>;

export const TaskDag = z
  .strictObject({ schemaVersion, dagId: id, tasks: z.array(Task).min(1) })
  .superRefine((dag, ctx) => {
    const ids = new Set<string>();
    dag.tasks.forEach((t, i) => {
      if (ids.has(t.taskId)) ctx.addIssue({ code: "custom", path: ["tasks", i, "taskId"], message: `duplicate taskId ${t.taskId}` });
      ids.add(t.taskId);
    });
    let bad = ids.size !== dag.tasks.length;
    dag.tasks.forEach((t, i) => {
      const path = ["tasks", i, "dependsOn"];
      if (new Set(t.dependsOn).size !== t.dependsOn.length) {
        bad = true;
        ctx.addIssue({ code: "custom", path, message: `${t.taskId} has duplicate dependsOn entries` });
      }
      for (const d of t.dependsOn) {
        if (d === t.taskId) {
          bad = true;
          ctx.addIssue({ code: "custom", path, message: `${t.taskId} depends on itself` });
        } else if (!ids.has(d)) {
          bad = true;
          ctx.addIssue({ code: "custom", path, message: `${t.taskId} depends on unknown task ${d}` });
        }
      }
    });
    if (bad) return;
    // Kahn's algorithm, O(V+E): anything left unprocessed is on or behind a cycle.
    const dependents = new Map<string, string[]>(dag.tasks.map((t) => [t.taskId, []]));
    const indeg = new Map<string, number>();
    for (const t of dag.tasks) {
      indeg.set(t.taskId, t.dependsOn.length);
      for (const d of t.dependsOn) dependents.get(d)!.push(t.taskId);
    }
    const queue = dag.tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.taskId);
    let done = 0;
    for (let n = queue.pop(); n !== undefined; n = queue.pop()) {
      done++;
      for (const m of dependents.get(n)!) {
        const left = indeg.get(m)! - 1;
        indeg.set(m, left);
        if (left === 0) queue.push(m);
      }
    }
    if (done !== dag.tasks.length) {
      dag.tasks.forEach((t, i) => {
        if ((indeg.get(t.taskId) ?? 0) > 0) ctx.addIssue({ code: "custom", path: ["tasks", i, "dependsOn"], message: "dependency cycle" });
      });
    }
  });
export type TaskDag = z.infer<typeof TaskDag>;

// ---- 2. SystemOneDecision (advisory only: no approval/permission fields; strictness rejects them) ----

// ponytail: fail-closed handling of high-risk uncalibrated advice is policy work (M0-05), not schema.
export const SystemOneDecision = z.strictObject({
  schemaVersion,
  decisionId: id,
  taskId: id,
  recommendation: z.string(),
  confidence: z.number().min(0).max(1),
  calibrated: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
});
export type SystemOneDecision = z.infer<typeof SystemOneDecision>;

// ---- 3. ExecutorCapability ----

export const ExecutorCapability = z.strictObject({
  schemaVersion,
  executorId: id,
  platform: z.enum(["win32", "linux", "darwin"]),
  capabilities: z
    .array(id)
    .refine((c) => new Set(c).size === c.length, "capabilities must be unique"),
});
export type ExecutorCapability = z.infer<typeof ExecutorCapability>;

// ---- 4. OperationApproval ----

// ponytail: a parsed grant is NOT proof of authority. M0-05 provides binding/digest verification only
// (`verifyApprovalBinding`); approver authentication, revocation lookup and grant provenance belong to the
// M1-07 approval broker. Consumers must not treat schema validity as authorisation.

export const OperationApproval = z
  .strictObject({
    schemaVersion,
    grantId: id,
    operation: CommandSpec,
    operationDigest: Digest,
    requestedBy: Principal,
    // Only a human user can approve; models, plugins and the orchestrator cannot.
    approvedBy: z.strictObject({ kind: z.literal("user"), id }),
    target: label,
    policyId: id,
    issuedAt: timestamp,
    expiresAt: timestamp,
    revoked: z.boolean(),
  })
  .superRefine((a, ctx) => {
    if (!(Date.parse(a.expiresAt) > Date.parse(a.issuedAt)))
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must be after issuedAt" });
    if (a.requestedBy.kind === a.approvedBy.kind && a.requestedBy.id === a.approvedBy.id)
      ctx.addIssue({ code: "custom", path: ["approvedBy"], message: "self-approval is not allowed" });
  });
export type OperationApproval = z.infer<typeof OperationApproval>;

// ---- 5. RunEvent ----

const eventBase = { schemaVersion, eventId: id, runId: id, seq: z.int().min(0), at: timestamp };

export const RunEvent = z.discriminatedUnion("type", [
  z.strictObject({ ...eventBase, type: z.literal("run.started") }),
  z.strictObject({ ...eventBase, type: z.literal("task.started"), taskId: id }),
  z.strictObject({ ...eventBase, type: z.literal("task.completed"), taskId: id }),
  z.strictObject({ ...eventBase, type: z.literal("task.failed"), taskId: id, reason: z.string() }),
  z.strictObject({ ...eventBase, type: z.literal("approval.granted"), grantId: id }),
  z.strictObject({
    ...eventBase,
    type: z.literal("run.paused"),
    reason: z.enum(["reconciliation_required", "approval_required", "operator"]),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

// ---- 6. RunState ----

export const RunState = z
  .strictObject({
    schemaVersion,
    runId: id,
    dagId: id,
    status: z.enum(["pending", "running", "paused", "succeeded", "failed", "cancelled"]),
    // zod silently drops a "__proto__" record key, so check raw keys before the record parse.
    tasks: z
      .unknown()
      .superRefine((v, ctx) => {
        if (typeof v === "object" && v !== null && Object.keys(v).includes("__proto__"))
          ctx.addIssue({ code: "custom", message: "invalid task id __proto__" });
      })
      .pipe(z.record(id, z.enum(["pending", "running", "succeeded", "failed", "unknown"]))),
    lastEventSeq: z.int().min(0).nullable(), // null = no events yet
    pauseReason: z.enum(["reconciliation_required", "approval_required", "operator"]).optional(),
  })
  .superRefine((s, ctx) => {
    if ((s.status === "paused") !== (s.pauseReason !== undefined))
      ctx.addIssue({ code: "custom", path: ["pauseReason"], message: "pauseReason is required iff status is paused" });
  });
export type RunState = z.infer<typeof RunState>;

// ---- 7. TaskResult / Evidence ----

export const Evidence = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    command: CommandSpec,
    exitCode: z.int(),
    stdoutDigest: Digest,
    stderrDigest: Digest,
  }),
  z.strictObject({ kind: z.literal("file"), path: label, digest: Digest }),
  z.strictObject({ kind: z.literal("log"), message: z.string() }),
]);
export type Evidence = z.infer<typeof Evidence>;

// outcome "unknown" = uncertain external effect; requires reconciliation before retry.
export const TaskResult = z.strictObject({
  schemaVersion,
  runId: id,
  taskId: id,
  outcome: z.enum(["succeeded", "failed", "unknown"]),
  evidence: z.array(Evidence),
});
export type TaskResult = z.infer<typeof TaskResult>;
