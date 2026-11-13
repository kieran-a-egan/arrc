import { createHash } from "node:crypto";
import { z } from "zod";
import { Digest, SCHEMA_VERSION, SystemOneCategory, SystemOneDecision, SystemOneRequest, parseContract } from "./contracts.ts";
import type { ParseResult } from "./contracts.ts";
import { RISK_RANK, deepFreeze } from "./policy.ts";
import type { Risk } from "./policy.ts";

// Metadata-only System One adapter. Advice is never authority: enforcement stays in policy.ts.
// The provider is the replaceable boundary (live Jev transport is NOT implemented; see docs/spikes/0002).

type Operation = SystemOneRequest["metadata"]["operation"];

export type SystemOneProvider = (request: SystemOneRequest, signal: AbortSignal) => Promise<unknown>;

// ponytail: naive basename heuristic; misses secrets in ordinary file names. Upgrade to content-free classifier if needed.
const SENSITIVE = /^(\.env.*|.*\.(pem|key|pfx|p12)|id_(rsa|dsa|ecdsa|ed25519).*|credentials.*)$/i;

export function buildRequest(a: {
  requestId: string;
  taskId: string;
  category: string;
  operation: Operation;
  files: { path: string; content: string }[];
}): SystemOneRequest {
  const exts = new Set<string>();
  let sensitivePaths = false;
  let totalLines = 0;
  for (const f of a.files) {
    const base = f.path.slice(Math.max(f.path.lastIndexOf("\\"), f.path.lastIndexOf("/")) + 1);
    const dot = base.lastIndexOf(".");
    if (dot > 0) exts.add(base.slice(dot).toLowerCase());
    if (SENSITIVE.test(base)) sensitivePaths = true;
    // A trailing newline terminates the last line rather than starting another.
    if (f.content !== "") totalLines += f.content.split("\n").length - (f.content.endsWith("\n") ? 1 : 0);
  }
  // Extensions not matching the schema are dropped and counted; the list is capped at 32. Invalid ids/category/operation throw (programmer error, fail closed).
  const extSchema = SystemOneRequest.shape.metadata.shape.extensions.element;
  const valid = [...exts].filter((e) => extSchema.safeParse(e).success).sort().slice(0, 32);
  // Only counts, extensions and booleans are copied: never a path string or any content.
  return SystemOneRequest.parse({
    schemaVersion: SCHEMA_VERSION,
    requestId: a.requestId,
    taskId: a.taskId,
    category: a.category,
    metadata: {
      operation: a.operation, fileCount: a.files.length, totalLines, extensions: valid, otherExtensions: exts.size - valid.length, sensitivePaths,
    },
  });
}

export function requestDigest(req: SystemOneRequest): Digest {
  return `sha256:${createHash("sha256").update(JSON.stringify(req)).digest("hex")}`;
}

export function baselineDecision(req: SystemOneRequest): Risk {
  const m = req.metadata;
  if (m.operation === "process.spawn" || m.sensitivePaths) return "high";
  return m.operation === "fs.write" ? "medium" : "low";
}

// ---- Configured policy (gate) ----

export const SystemOneGate = z.strictObject({
  supportedCategories: z.array(SystemOneCategory).min(1),
  minConfidence: z.number().min(0).max(1),
  timeoutMs: z.int().min(1).max(60000),
  calibratedModels: z.array(z.strictObject({ model: z.string().min(1), modelVersion: z.string().min(1) })),
});
export type SystemOneGate = z.infer<typeof SystemOneGate>;

export function loadSystemOneGate(input: unknown): ParseResult<SystemOneGate> {
  const r = parseContract(SystemOneGate, input);
  return r.ok ? { ok: true, value: deepFreeze(r.value) } : r;
}

// ---- Advice ----

export type SystemOneFailure =
  | "invalid_request" | "unsupported_category" | "unavailable" | "timeout" | "invalid_response" | "unreliable" | "baseline_conflict" | "internal_error";
export type SystemOneResult =
  | { ok: true; decision: SystemOneDecision; baseline: Risk }
  | { ok: false; reason: SystemOneFailure };

const fail = (reason: SystemOneFailure): SystemOneResult => ({ ok: false, reason });
const TIMED_OUT = Symbol("timeout");

/** Never throws or rejects. Any failure means "no usable advice"; callers fall back to the deterministic baseline. */
export async function adviseSystemOne(provider: SystemOneProvider, request: SystemOneRequest, gateInput: SystemOneGate): Promise<SystemOneResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const req = parseContract(SystemOneRequest, request);
    const g = parseContract(SystemOneGate, gateInput); // don't trust a caller-built gate
    if (!req.ok || !g.ok) return fail("invalid_request");
    const gate = g.value;
    if (!gate.supportedCategories.includes(req.value.category)) return fail("unsupported_category");

    const ac = new AbortController();
    const timeout = new Promise<typeof TIMED_OUT>((res) => {
      timer = setTimeout(() => {
        ac.abort();
        res(TIMED_OUT);
      }, gate.timeoutMs);
    });
    // Digest and baseline are fixed before the provider runs, which only sees a frozen request.
    const digest = requestDigest(req.value);
    const baseline = baselineDecision(req.value);
    const frozen = deepFreeze(req.value);
    let raw: unknown;
    try {
      // Race so a provider that ignores the signal still times out.
      const out = await Promise.race([Promise.resolve().then(() => provider(frozen, ac.signal)), timeout]);
      if (out === TIMED_OUT) return fail("timeout");
      raw = out;
    } catch {
      return fail("unavailable");
    }

    const d = parseContract(SystemOneDecision, raw);
    if (!d.ok) return fail("invalid_response");
    const dec = d.value;
    if (dec.taskId !== req.value.taskId || dec.category !== req.value.category || dec.provenance.requestDigest !== digest)
      return fail("invalid_response");

    const listed = gate.calibratedModels.some((m) => m.model === dec.provenance.model && m.modelVersion === dec.provenance.modelVersion);
    if (dec.confidence < gate.minConfidence || (dec.calibrated && !listed)) return fail("unreliable");

    if (RISK_RANK[dec.risk] < RISK_RANK[baseline]) return fail("baseline_conflict");
    return { ok: true, decision: dec, baseline };
  } catch {
    return fail("internal_error");
  } finally {
    clearTimeout(timer);
  }
}
