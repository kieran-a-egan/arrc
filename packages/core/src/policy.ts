import { createHash } from "node:crypto";
import { z } from "zod";
import { CommandSpec, Digest, OperationApproval, Principal, SystemOneDecision, parseContract, SCHEMA_VERSION, Id as id } from "./contracts.ts";
import type { ParseResult } from "./contracts.ts";

// Pure, deterministic, platform-independent policy kernel: string ops only, no fs, no `path`.
// Models and System 1 advice never grant anything; only code-defined ceiling + validated rules do.

export const OPERATIONS = deepFreeze(["fs.read", "fs.write", "process.spawn"] as const);
export type Operation = (typeof OPERATIONS)[number];
export type Risk = "low" | "medium" | "high";

export const RISK_RANK: Record<Risk, number> = deepFreeze({ low: 0, medium: 1, high: 2 });
const BASE_RISK: Record<Operation, Risk> = { "fs.read": "low", "fs.write": "medium", "process.spawn": "high" };

export function deepFreeze<T>(o: T): T {
  if (typeof o === "object" && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ---- Windows path rules: lexical only, reject rather than normalise ----

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$|clock\$)$/;

/** Returns a lowercase comparison key, or null if the path is rejected. */
export function checkPath(p: unknown): string | null {
  if (typeof p !== "string" || p.length === 0 || p.length > 259) return null;
  if (/[^\x20-\x7e]/.test(p)) return null; // non-ASCII + control chars
  if (/[<>"|?*/~]/.test(p)) return null;
  if (!/^[A-Za-z]:\\/.test(p)) return null; // drive-absolute only: no UNC, \\?\, C:foo, relative
  if (p.indexOf(":", 2) !== -1) return null; // ADS
  let rest = p.slice(3);
  if (rest.endsWith("\\") && rest.length > 1) rest = rest.slice(0, -1);
  if (rest !== "") {
    for (const seg of rest.split("\\")) {
      if (seg === "" || seg === "." || seg === "..") return null;
      if (/[. ]$/.test(seg)) return null;
      if (RESERVED.test(seg.split(".")[0]!.trimEnd().toLowerCase())) return null;
    }
  }
  const key = p.toLowerCase();
  return key.length > 3 && key.endsWith("\\") ? key.slice(0, -1) : key;
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith("\\") ? root : root + "\\");
}

// ---- Ceiling: immutable, code-defined, not configurable ----

export const DENIED_EXECUTABLES: readonly string[] = deepFreeze([
  "cmd", "powershell", "pwsh", "bash", "sh", "wsl", "wscript", "cscript",
  "mshta", "rundll32", "regsvr32", "msiexec", "node", "python", "py",
  "python3", "pythonw", "pyw", "powershell_ise", "sudo", "runas", "wslhost", "conhost", "forfiles",
  "bitsadmin", "certutil", "installutil", "regasm", "regsvcs", "msbuild",
  "wmic", "schtasks", "reg", "sc", "cmstp", "msxsl", "perl", "ruby", "java", "javaw", "dotnet", "deno", "bun",
]);
// ponytail: this denylist is defence-in-depth and incomplete; the primary control is exact allow + user approval.
// A worktree is not a sandbox, so no isolation/network requirement can be honoured yet.
export const SUPPORTED_ENFORCEMENT: readonly string[] = deepFreeze([]);

/** Returns a violation message or null. Targets here are already path-checked. */
function ceilingViolation(op: Operation, pathOrExe: string): string | null {
  const key = checkPath(pathOrExe);
  if (key === null) return "invalid path";
  if (op === "process.spawn") {
    if (!key.endsWith(".exe")) return "executable must be a .exe";
    const raw = key.slice(key.lastIndexOf("\\") + 1).slice(0, -4);
    const base = DENIED_EXECUTABLES.includes(raw) ? raw : raw.replace(/[\d.]+$/, ""); // python3.12 -> python; rundll32 stays
    if (DENIED_EXECUTABLES.includes(base)) return `executable ${base} is denied`;
  } else if (op === "fs.write" && key.split("\\").some((s) => s.endsWith(".git"))) {
    return "writes into git metadata (.git, *.git) are denied";
  }
  return null;
}

// ---- Policy config ----

const Target = z.strictObject({ root: z.string() });
const Rule = z.discriminatedUnion("operation", [
  z.strictObject({ ruleId: id, effect: z.enum(["allow", "deny"]), principals: z.array(Principal).min(1), operation: z.literal(["fs.read", "fs.write"]), target: Target }),
  z.strictObject({ ruleId: id, effect: z.enum(["allow", "deny"]), principals: z.array(Principal).min(1), operation: z.literal("process.spawn"), target: z.strictObject({ command: CommandSpec }) }),
]);
export const PolicyConfig = z.strictObject({ schemaVersion: z.literal(SCHEMA_VERSION), policyId: id, rules: z.array(Rule) });
export type PolicyConfig = z.infer<typeof PolicyConfig>;

/** Parses and semantically validates; any problem rejects the WHOLE config (no trimming). Result is deep-frozen. */
export function loadPolicy(input: unknown): ParseResult<PolicyConfig> {
  const r = parseContract(PolicyConfig, input);
  if (!r.ok) return r;
  const issues: { path: string; code: string; message: string }[] = [];
  const seen = new Set<string>();
  r.value.rules.forEach((rule, i) => {
    const at = `rules.${i}`;
    if (seen.has(rule.ruleId)) issues.push({ path: `${at}.ruleId`, code: "duplicate_rule_id", message: `duplicate ruleId ${rule.ruleId}` });
    seen.add(rule.ruleId);
    const paths: [string, string][] = "root" in rule.target
      ? [[`${at}.target.root`, rule.target.root]]
      : [[`${at}.target.command.executable`, rule.target.command.executable], ...(rule.target.command.cwd !== undefined ? [[`${at}.target.command.cwd`, rule.target.command.cwd] as [string, string]] : [])];
    for (const [path, p] of paths) if (checkPath(p) === null) issues.push({ path, code: "invalid_path", message: "path rejected" });
    if (rule.effect !== "allow") return; // deny rules only need valid paths (checked above)
    const subject = "root" in rule.target ? rule.target.root : rule.target.command.executable;
    const v = checkPath(subject) === null ? null : ceilingViolation(rule.operation, subject);
    if (v) issues.push({ path: at, code: "ceiling_violation", message: v });
    if ("command" in rule.target && rule.target.command.cwd === undefined)
      issues.push({ path: `${at}.target.command.cwd`, code: "missing_cwd", message: "allowed spawn rules must pin cwd" });
  });
  // Write-then-exec escalation (AC4); see the executor requirements in decide().
  const allows = r.value.rules.filter((x) => x.effect === "allow");
  const writeRoots = allows.flatMap((x) => (x.operation === "fs.write" && "root" in x.target ? [checkPath(x.target.root)] : [])).filter((k): k is string => k !== null);
  for (const [i, x] of r.value.rules.entries()) {
    if (x.effect !== "allow" || !("command" in x.target)) continue;
    const exe = checkPath(x.target.command.executable);
    if (exe === null) continue;
    const dir = exe.slice(0, exe.lastIndexOf("\\"));
    if (writeRoots.some((w) => within(w, exe) || within(dir, w)))
      issues.push({ path: `rules.${i}.target.command.executable`, code: "write_exec_overlap", message: "executable is writable via an allowed fs.write root" });
  }
  if (issues.length) return { ok: false, error: { code: "invalid_schema", issues } };
  return { ok: true, value: deepFreeze(r.value) };
}

// ---- Request + decision ----

const Request = z.strictObject({
  operation: z.string(),
  target: z.union([z.strictObject({ path: z.string() }), z.strictObject({ command: CommandSpec })]),
  requires: z.array(z.string()).optional(),
  advice: SystemOneDecision.optional(),
});

export type DenyReason =
  | "invalid_request" | "unknown_operation" | "invalid_target" | "ceiling_violation" | "unsupported_enforcement"
  | "uncalibrated_high_risk_advice" | "no_matching_rule" | "denied_by_rule" | "approval_required" | "invalid_context" | "internal_error";
export type Decision = { allow: true; ruleId: string; risk: Risk } | { allow: false; reason: DenyReason };

const deny = (reason: DenyReason): Decision => ({ allow: false, reason });

export function operationDigest(cmd: CommandSpec): Digest {
  const canon = JSON.stringify({ executable: cmd.executable, args: cmd.args, cwd: cmd.cwd ?? null });
  return `sha256:${createHash("sha256").update(canon).digest("hex")}`;
}

const samePrincipal = (a: { kind: string; id: string }, b: { kind: string; id: string }) => a.kind === b.kind && a.id === b.id;

/**
 * Binding check ONLY, NOT authorisation: verifies a grant's digest, policy, requester, target and time window.
 * It cannot tell a real grant from a forged one; an approval broker must establish provenance first.
 * `decide` never consults it.
 */
export function verifyApprovalBinding(policy: PolicyConfig, a: OperationApproval, cmd: CommandSpec, p: Principal, now: Date): boolean {
  if (!OperationApproval.safeParse(a).success) return false; // untrusted shape: never throw, fail closed
  const d = operationDigest(cmd);
  const cwd = checkPath(cmd.cwd);
  const t = now.getTime();
  return (
    a.operationDigest === operationDigest(a.operation) && a.operationDigest === d &&
    a.policyId === policy.policyId &&
    samePrincipal(a.requestedBy, p) &&
    a.approvedBy.kind === "user" && !samePrincipal(a.approvedBy, p) &&
    !a.revoked &&
    Date.parse(a.issuedAt) <= t && t < Date.parse(a.expiresAt) &&
    cwd !== null && checkPath(a.target) === cwd
  );
}

/**
 * Supplied and authenticated by the trusted host (orchestrator/executor boundary), never copied from agent or
 * model output. The request is untrusted agent data and carries neither principal nor approval.
 */
export type HostContext = { principal: Principal };

/**
 * Decides one untrusted request. `policy` must be the output of `loadPolicy`. Never throws; any failure is a deny.
 *
 * Executor requirements (not enforced by this lexical, pure kernel):
 * - Lexical only. Symlink/junction/8.3 resolution needs fs.realpathSync.native in the I/O
 *   executor layer (not this milestone); the kernel never touches the filesystem.
 * - Write-then-exec escalation (AC4). The approval digest binds path+args, not file contents; content
 *   hashing of the executable belongs to the executor (cwd-based DLL search is not covered here).
 * - A spawn cwd inside a writable root lets a model plant a fake bare repo (HEAD/objects/refs/config with
 *   core.fsmonitor) that git would discover and execute. The executor must run git with safe.bareRepository=explicit
 *   (or GIT_CEILING_DIRECTORIES). Not enforced by this lexical kernel.
 * - fs scope is a subtree match; a rule/deny on a subtree does not cover its ancestors, so the
 *   executor must do non-recursive single-path operations (e.g. fs.write on C:epo, the parent of .git).
 */
export function decide(policy: PolicyConfig, request: unknown, context: HostContext): Decision {
  try {
    const ctx = z.strictObject({ principal: Principal }).safeParse(context);
    if (!ctx.success) return deny("invalid_context");
    const principal = ctx.data.principal;
    const parsed = Request.safeParse(request);
    if (!parsed.success) return deny("invalid_request");
    const req = parsed.data;
    const op = req.operation;
    if (!(OPERATIONS as readonly string[]).includes(op)) return deny("unknown_operation");
    const operation = op as Operation;

    const isSpawn = operation === "process.spawn";
    const cmd = "command" in req.target ? req.target.command : undefined;
    const path = "path" in req.target ? req.target.path : undefined;
    if (isSpawn ? cmd === undefined : path === undefined) return deny("invalid_target");
    const subject = isSpawn ? cmd!.executable : path!;
    const subjectKey = checkPath(subject);
    const cwdKey = cmd?.cwd === undefined ? null : checkPath(cmd.cwd);
    if (subjectKey === null || (isSpawn && cwdKey === null)) return deny("invalid_target");

    if ((req.requires ?? []).some((r) => !SUPPORTED_ENFORCEMENT.includes(r))) return deny("unsupported_enforcement");
    if (ceilingViolation(operation, subject)) return deny("ceiling_violation");

    const advice = req.advice;
    if (advice && advice.risk === "high" && !advice.calibrated) return deny("uncalibrated_high_risk_advice");

    // Allow rules match exactly; deny rules match broadly and fail closed: a deny rule with an invalid path
    // matches, spawn cwd is optional and a subtree match, and args are a POSITIONAL prefix (a deny on ["push"]
    // does not cover ["-C", ".", "push"]; acceptable because allows are exact).
    const matches = policy.rules.filter((rule) => {
      if (rule.operation !== operation || !rule.principals.some((q) => samePrincipal(q, principal))) return false;
      const isDeny = rule.effect !== "allow";
      if ("root" in rule.target) {
        const root = checkPath(rule.target.root);
        return root === null || isSpawn ? isDeny : within(root, subjectKey); // shape/op mismatch: never allow, always deny
      }
      if (!isSpawn) return isDeny; // command target on an fs rule (forged): same
      const rc = rule.target.command;
      const exe = checkPath(rc.executable);
      const rcwd = rc.cwd === undefined ? undefined : checkPath(rc.cwd);
      if (isDeny) {
        if (exe === null || rcwd === null) return true;
        return exe === subjectKey && (rcwd === undefined || within(rcwd, cwdKey!)) && rc.args.every((x, i) => x === cmd!.args[i]);
      }
      return isSpawn && exe === subjectKey && rcwd === cwdKey && rc.args.length === cmd!.args.length && rc.args.every((x, i) => x === cmd!.args[i]);
    });
    if (matches.some((m) => m.effect !== "allow")) return deny("denied_by_rule");
    const rule = matches.find((m) => m.effect === "allow");
    if (!rule) return deny("no_matching_rule");

    // Advice may only raise risk, never lower it.
    let risk = BASE_RISK[operation];
    if (advice && RISK_RANK[advice.risk] > RISK_RANK[risk]) risk = advice.risk;
    // ponytail: high-risk operations (including all process.spawn) cannot be authorised until the M1-07 approval
    // broker provides trusted grant provenance (approver authentication, issuance, revocation store, single-use).
    if (risk === "high") return deny("approval_required");
    return { allow: true, ruleId: rule.ruleId, risk };
  } catch {
    return deny("internal_error");
  }
}
