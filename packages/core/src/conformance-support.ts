// Test support only: not exported from index.ts. Shared by *.test.ts via tsc (src/) so it type-checks with the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestDigest } from "./index.ts";
import type { SystemOneProvider } from "./index.ts";

export type After = { after: (f: () => void) => void };
export const win = process.platform === "win32";
export const echoScript = path.join(import.meta.dirname, "..", "test", "fixtures", "echo.mjs");
const UNI = "arrc conf \u00fc\u2713"; // spaces + non-ASCII

/** Fresh temp dir under os.tmpdir(), removed after the test. */
export function tmp(t: After, prefix = "arrc test "): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }));
  return root;
}

/** A directory with spaces and non-ASCII holding an .exe launcher, a .ps1 and a .cmd. Built at test time; no committed binaries. */
export function fixtureDir(t: After) {
  const dir = path.join(tmp(t), UNI);
  fs.mkdirSync(dir);
  const exe = path.join(dir, win ? "node \u00fc.exe" : "node \u00fc");
  try {
    fs.linkSync(process.execPath, exe);
  } catch {
    fs.copyFileSync(process.execPath, exe);
  }
  const ps1 = path.join(dir, "echo \u00fc.ps1");
  fs.writeFileSync(
    ps1,
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\r\nWrite-Output (ConvertTo-Json -Compress -InputObject @($args))\r\nexit ([int]$env:ARRC_EXIT)\r\n",
  );
  const cmd = path.join(dir, "echo \u00fc.cmd");
  fs.writeFileSync(cmd, "@echo off\r\necho %*\r\n");
  return { dir, exe, ps1, cmd };
}

// ---- Executor conformance: one set of assertions, run against every executor ----

export interface ExecOut {
  exitCode: number | null;
  args?: string[]; // args the fixture reported receiving (after the script path)
  error?: string; // spawn/plan failure code; must be set for a missing executable, never thrown
  timedOut?: boolean;
  orphanPid?: number; // pid of the detached grandchild, when the fixture reported one
}
export type Exec = (o: { exe: string; script: string; arg: string; env?: Record<string, string>; timeoutMs: number }) => Promise<ExecOut>;

/** `skip`: an explicit reason string makes every case show as skipped with that reason. */
export function executorConformance(name: string, exec: Exec, skip?: string) {
  const c = (title: string, fn: (t: After) => Promise<void>) => test(`conformance[${name}]: ${title}`, skip ? { skip } : {}, fn);
  const ARG = "h\u00e9llo w\u00f6rld \u2713";
  c("unicode/space exe path and args round-trip", async (t) => {
    const { exe } = fixtureDir(t);
    const r = await exec({ exe, script: echoScript, arg: ARG, timeoutMs: 10_000 });
    assert.equal(r.error, undefined);
    assert.equal(r.exitCode, 0);
    assert.ok(r.args?.includes(ARG), JSON.stringify(r.args));
  });
  c("non-zero exit code is preserved", async (t) => {
    const r = await exec({ exe: fixtureDir(t).exe, script: echoScript, arg: "x", env: { ARRC_EXIT: "7" }, timeoutMs: 10_000 });
    assert.equal(r.exitCode, 7);
  });
  c("missing executable is a structured failure, not a throw", async (t) => {
    const r = await exec({ exe: path.join(fixtureDir(t).dir, win ? "nope.exe" : "nope"), script: echoScript, arg: "x", timeoutMs: 10_000 });
    assert.equal(r.error, "ENOENT");
    assert.notEqual(r.exitCode, 0);
  });
  c("timeout kills the process", async (t) => {
    const r = await exec({ exe: fixtureDir(t).exe, script: echoScript, arg: "x", env: { ARRC_HANG: "1" }, timeoutMs: 500 });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.exitCode, 0);
  });
  c("orphaned grandchild holding the pipes does not hang the executor", async (t) => {
    const { exe } = fixtureDir(t);
    let pid: number | undefined;
    try {
      const t0 = Date.now();
      const r = await exec({ exe, script: echoScript, arg: "x", env: { ARRC_ORPHAN: "1" }, timeoutMs: 20_000 });
      pid = r.orphanPid;
      assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0}ms`);
      assert.equal(r.error, undefined);
      assert.ok(pid, "fixture reported no grandchild pid");
    } finally {
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
        // Wait (bounded, 5 s) until the pid is gone AND the fixture exe is unlocked: Windows keeps the image locked
        // briefly after the process is gone, so a liveness check alone leaves dir removal racing with EPERM.
        for (let i = 0; i < 100; i++) {
          let alive = true;
          try {
            process.kill(pid, 0);
          } catch {
            alive = false;
          }
          if (!alive) {
            try {
              fs.unlinkSync(exe);
              break;
            } catch {
              // still locked
            }
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }
  });
}

// ---- Deterministic fake System One providers ----

export const fakeProviders = {
  valid: (): SystemOneProvider => async (r) =>
    ({
      schemaVersion: 1, decisionId: "d1", taskId: r.taskId, category: r.category, recommendation: "proceed",
      confidence: 0.9, calibrated: false, risk: "low",
      provenance: { provider: "fake", model: "m", modelVersion: "1", requestDigest: requestDigest(r), evidence: ["operation", "fileCount"] },
    }) as never,
  throws: (): SystemOneProvider => async () => {
    throw new Error("provider down");
  },
  schemaInvalid: (): SystemOneProvider => async () => ({ nope: true }) as never,
  hangs: (): SystemOneProvider => () => new Promise(() => {}),
};
