// Fake claude for tests: node fake-claude.mjs -p <prompt> --output-format stream-json --verbose [--model m] [--resume id]
import { spawn } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (process.env.FAKE_CLAUDE_MARKER) fs.writeFileSync(process.env.FAKE_CLAUDE_MARKER, "spawned");
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
} else {
  emit(init);
  if (mode === "malformed") process.stdout.write("not json\n");
  emit({ type: "assistant", session_id: init.session_id, message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }] } });
  emit({ type: "user", session_id: init.session_id, message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } });
  emit({ type: "result", subtype: "success", is_error: false, session_id: init.session_id });
}
