import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, loadPolicy, type HostContext, type PolicyConfig } from "./policy.ts";

// Claude Code PreToolUse hook gate. Maps each tool call to a policy-kernel request; anything not
// explicitly mapped is denied. The decision is enforced by Claude Code (hook deny), not by prompt text.
// Never emits "ask": a prompt would hand the decision back to a model-driven session.

export type HookOutput = {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "allow" | "deny"; permissionDecisionReason: string };
};

/** The model's own tool calls always run as this principal; the host (not hook input) supplies it. */
export const CLAUDE_PRINCIPAL: HostContext = { principal: { kind: "model", id: "claude-code" } };

const out = (allow: boolean, reason: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allow ? "allow" : "deny", permissionDecisionReason: reason },
});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

// Tool -> [operation, the tool's own path field]. Own-property lookup only (no prototype names like "toString").
const TOOLS = new Map<string, ["fs.read" | "fs.write", string]>([
  ["Read", ["fs.read", "file_path"]],
  ["Glob", ["fs.read", "path"]],
  ["Grep", ["fs.read", "path"]],
  ["Edit", ["fs.write", "file_path"]],
  ["Write", ["fs.write", "file_path"]],
  ["MultiEdit", ["fs.write", "file_path"]],
  ["NotebookEdit", ["fs.write", "notebook_path"]],
]);

// A Glob pattern can reach outside `path`; only plain relative patterns stay inside the checked root.
const globEscapes = (p: string): boolean =>
  /[{}~:]/.test(p) || p.includes("..") || path.win32.isAbsolute(p) || p.startsWith("/") || p.startsWith("\\");

export function gateToolUse(policy: PolicyConfig, hookInput: unknown, context: HostContext = CLAUDE_PRINCIPAL): HookOutput {
  try {
    const h = hookInput as Record<string, unknown> | null;
    if (!h || typeof h !== "object" || h.hook_event_name !== "PreToolUse") return out(false, "not a PreToolUse event");
    const tool = str(h.tool_name);
    const input = h.tool_input as Record<string, unknown> | null;
    if (!tool || !input || typeof input !== "object") return out(false, "malformed tool call");
    const spec = TOOLS.get(tool);
    // Bash/PowerShell: shell strings cannot be mediated by an argv/path policy. Web, subagents, MCP and
    // unknown tools have no policy operation. All denied.
    if (!spec) return out(false, `tool ${tool} is not mediated by policy`);
    const [operation, field] = spec;
    let target = str(input[field]); // never fall back across fields
    // Glob/Grep with no path search cwd; the hook's cwd is the only anchor, so use it (missing cwd => deny below).
    if (!target && (tool === "Glob" || tool === "Grep") && input[field] === undefined) target = str(h.cwd);
    if (tool === "Glob" && (typeof input.pattern !== "string" || globEscapes(input.pattern))) return out(false, "Glob pattern must be relative and not escape");
    if (!target) return out(false, "missing target path");
    const d = decide(policy, { operation, target: { path: target } }, context);
    return d.allow ? out(true, `rule ${d.ruleId}`) : out(false, `policy: ${d.reason}`);
  } catch {
    return out(false, "internal error");
  }
}

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
  // Usage: node claude-gate.ts <policy.json>  (hook JSON on stdin). Any failure => stderr + exit 2 (Claude treats as blocking).
  try {
    const p = loadPolicy(JSON.parse(fs.readFileSync(process.argv[2] ?? "", "utf8")));
    if (!p.ok) throw new Error("invalid policy");
    process.stdout.write(JSON.stringify(gateToolUse(p.value, JSON.parse(fs.readFileSync(0, "utf8")))) + "\n");
  } catch (e) {
    process.stderr.write(`claude-gate: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
