// Wrapper around the "ok + one JSON line" contract shared by all executor conformance cases:
// prints its args as a result event, hangs or exits with a code when asked by env.
// ARRC_ORPHAN=1: also leaves a detached grandchild (inherited stdio, sleeps 30s) holding the pipes open, prints its pid, exits.
import { spawn } from "node:child_process";
if (process.env.ARRC_HANG) setInterval(() => {}, 1000);
else {
  if (process.env.ARRC_ORPHAN) {
    const g = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { detached: true, stdio: "inherit", windowsHide: true });
    process.stdout.write(JSON.stringify({ type: "orphan", pid: g.pid }) + "\n");
    g.unref();
  }
  if (process.env.ARRC_BIG) process.stdout.write("x".repeat(Number(process.env.ARRC_BIG)));
  process.stdout.write(JSON.stringify({ type: "result", args: process.argv.slice(2) }) + "\n");
  process.exitCode = Number(process.env.ARRC_EXIT ?? 0); // natural exit so a large piped write is flushed
}
