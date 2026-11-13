// Fake claude for tests: node fake-claude.mjs -p <prompt> --output-format stream-json --verbose [--model m] [--resume id]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (process.env.FAKE_CLAUDE_MARKER) fs.writeFileSync(process.env.FAKE_CLAUDE_MARKER, "spawned");
if (process.env.FAKE_CLAUDE_ENVOUT) fs.writeFileSync(process.env.FAKE_CLAUDE_ENVOUT, JSON.stringify([process.env.CLAUDE_CODE_SIMPLE, process.env.CLAUDE_CODE_SAFE_MODE]));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const init = { type: "system", subtype: "init", session_id: val("--resume") ?? "sess-1", model: val("--model") ?? "default", tools: [] };

if (mode === "fail") {
  process.stderr.write("boom\n");
  process.exit(3);
}
if (mode === "hang") {
  const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1e3)"], { stdio: "ignore", detached: true, windowsHide: true });
  g.unref(); // detached: escapes the parent's kill-on-close job object, so only a real tree kill reaches it
  fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(g.pid));
  fs.writeFileSync(process.env.FAKE_CLAUDE_SELFPIDFILE, String(process.pid));
  emit(init);
  setInterval(() => {}, 1000);
} else if (mode === "limits") {
  emit({ ...init, apiKeySource: "none" });
  emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1790000000, rateLimitType: "five_hour", utilization: 0.82 } });
  emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: "soon" } }); // partial/wrong types
  emit({ type: "rate_limit_event" }); // no payload
  emit({ type: "result", subtype: "success", is_error: false, session_id: init.session_id, total_cost_usd: 0.0123 });
} else if (mode === "hook") {
  // Emulates Claude Code: run the PreToolUse hook from --settings; "execute" (write the marker) only on an explicit allow.
  const tool = JSON.parse(process.env.FAKE_CLAUDE_TOOL);
  // Models the documented contract: exit 2 blocks; exit 0 + JSON decision applies; other non-zero exit is NON-blocking
  // (tool proceeds) unless the handler has onFailure:"block"; exit 0 with unparseable stdout = no decision = proceeds
  // (unverified assumption).
  const handler = JSON.parse(val("--settings")).hooks.PreToolUse[0].hooks[0];
  const h = spawnSync(handler.command, handler.args ?? [], { input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: process.cwd(), tool_use_id: "tu1", ...tool }), encoding: "utf8", shell: false });
  let allowed;
  if (h.status === 2) allowed = false;
  else if (h.status !== 0) allowed = handler.onFailure !== "block";
  else {
    try {
      allowed = JSON.parse(h.stdout).hookSpecificOutput.permissionDecision !== "deny";
    } catch {
      allowed = true;
    }
  }
  if (allowed) fs.writeFileSync(process.env.FAKE_CLAUDE_EXECUTED, "executed");
  emit(init);
  emit({ type: "assistant", session_id: init.session_id, message: { content: [{ type: "tool_use", id: "tu1", name: tool.tool_name, input: tool.tool_input }] } });
  emit({ type: "user", session_id: init.session_id, message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: !allowed }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: init.session_id });
} else {
  emit(init);
  if (mode === "malformed") process.stdout.write("not json\n");
  emit({ type: "assistant", session_id: init.session_id, message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }] } });
  emit({ type: "user", session_id: init.session_id, message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: init.session_id });
}
