import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { defaultDataDir, MIGRATIONS, migrate, openStore } from "./store.ts";

// node:test runs after-hooks in registration order, so handles are tracked and closed before the dir is removed.
const closers = new WeakMap<TestContext, (() => void)[]>();
function track(t: TestContext, fn: () => void) {
  const list = closers.get(t);
  if (list) list.push(fn);
  else t.after(fn);
}
function tmp(t: TestContext): string {
  const d = mkdtempSync(join(tmpdir(), "arrc store "));
  closers.set(t, []);
  t.after(() => {
    for (const fn of closers.get(t)!.reverse()) {
      try {
        fn();
      } catch {
        // already closed
      }
    }
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return d;
}
function open(t: TestContext, dir: string, busyTimeoutMs?: number) {
  const s = openStore(dir, busyTimeoutMs === undefined ? {} : { busyTimeoutMs });
  track(t, () => s.close());
  return s;
}
const ev = (runId: string, seq: number) => ({
  schemaVersion: 1,
  eventId: `${runId}-${seq}`,
  runId,
  seq,
  at: "2026-01-01T00:00:00Z",
  type: "run.started",
});
const state = (runId: string, lastEventSeq: number | null, status = "running") => ({
  schemaVersion: 1,
  runId,
  dagId: "d1",
  status,
  tasks: {},
  lastEventSeq,
});
const isOk = (r: { ok: boolean }) => r.ok;
const code = (r: unknown) => (r as { error: { code: string } }).error.code;
const isBusy = (e: unknown) => (e as { errcode?: number }).errcode === 5;
const rawDb = (dir: string, timeout = 100) => new DatabaseSync(join(dir, "arrc.db"), { timeout });

// Child that holds a write lock (optionally inserting an event) until told to proceed.
const LOCK_CHILD = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { timeout: 2000 });
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO events (run_id, seq, event_id, type, at, body) VALUES ('x', 0, 'x-0', 'run.started', '2026-01-01T00:00:00Z', '{}')").run();
if (process.argv[2] === "crash") process.exit(1);
console.log("locked");
process.stdin.on("data", () => { db.exec("COMMIT"); db.close(); process.exit(0); });
`;

function spawnChild(t: TestContext, dir: string, mode: string) {
  const child = spawn(process.execPath, ["-e", LOCK_CHILD, join(dir, "arrc.db"), mode], { stdio: ["pipe", "pipe", "inherit"] });
  const killer = setTimeout(() => child.kill(), 20_000);
  track(t, () => {
    clearTimeout(killer);
    child.kill();
  });
  const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
  const locked = new Promise<void>((res, rej) => {
    child.stdout.on("data", (d: Buffer) => d.toString().includes("locked") && res());
    child.on("exit", () => rej(new Error("child exited before locking")));
  });
  locked.catch(() => {}); // crash mode never locks
  return { child, exited, locked };
}

test("defaultDataDir uses LOCALAPPDATA or homedir fallback", () => {
  const base = process.platform === "win32" ? "C:\\Users\\x\\AppData\\Local" : "/home/x/local";
  assert.equal(defaultDataDir({ LOCALAPPDATA: base }), join(base, "ARRC"));
  assert.equal(defaultDataDir({}), join(homedir(), "AppData", "Local", "ARRC"));
});

test("fresh open enables WAL and migrates", (t) => {
  const dir = tmp(t);
  const s = open(t, dir);
  const db = rawDb(dir);
  track(t, () => db.close());
  assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
  assert.ok(existsSync(join(dir, "arrc.db-wal")));
  s.close();
});

const schemaOf = (db: DatabaseSync) => db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

test("migrations are deterministic and idempotent", (t) => {
  const a = new DatabaseSync(":memory:");
  const b = new DatabaseSync(":memory:");
  t.after(() => {
    a.close();
    b.close();
  });
  migrate(a);
  migrate(b);
  assert.deepEqual(schemaOf(a), schemaOf(b));
  const before = schemaOf(a);
  migrate(a);
  assert.deepEqual(schemaOf(a), before);
  assert.equal(version(a), MIGRATIONS.length);
});

test("reopening an existing store preserves data and schema", (t) => {
  const dir = tmp(t);
  const s1 = open(t, dir);
  assert.ok(isOk(s1.appendEvent(ev("r1", 0))));
  s1.close();
  const s2 = open(t, dir);
  assert.equal(s2.readEvents("r1").length, 1);
  const db = rawDb(dir);
  track(t, () => db.close());
  assert.equal(version(db), MIGRATIONS.length);
});

test("v0 database upgrades step by step", (t) => {
  const db = new DatabaseSync(":memory:");
  track(t, () => db.close());
  const steps = ["CREATE TABLE a (x INTEGER);", "CREATE TABLE b (y INTEGER);", "ALTER TABLE a ADD COLUMN z TEXT;"];
  migrate(db, steps.slice(0, 1));
  assert.equal(version(db), 1);
  migrate(db, steps);
  assert.equal(version(db), 3);
  db.exec("INSERT INTO a (x, z) VALUES (1, 'z')");
});

test("failing migration rolls back and keeps user_version", (t) => {
  const db = new DatabaseSync(":memory:");
  track(t, () => db.close());
  migrate(db, ["CREATE TABLE a (x INTEGER);"]);
  assert.throws(() => migrate(db, ["CREATE TABLE a (x INTEGER);", "CREATE TABLE b (y INTEGER); CREATE TABLE b (y INTEGER);"]));
  assert.equal(version(db), 1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get(), undefined);
});

test("a database with a newer schema is refused", (t) => {
  const dir = tmp(t);
  const db = rawDb(dir);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  db.close();
  assert.throws(() => openStore(dir), /newer/);
  const chk = rawDb(dir);
  track(t, () => chk.close());
  assert.notEqual((chk.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  chk.close();
  assert.equal(existsSync(join(dir, "arrc.db-wal")), false);
});

test("events round-trip and are validated", (t) => {
  const s = open(t, tmp(t));
  assert.ok(isOk(s.appendEvent(ev("r1", 0))));
  assert.ok(isOk(s.appendEvent(ev("r1", 1))));
  assert.deepEqual(s.readEvents("r1"), [ev("r1", 0), ev("r1", 1)]);
  const bad = s.appendEvent({ ...ev("r1", 2), extra: 1 });
  assert.equal(isOk(bad), false);
  assert.equal(code(bad), "invalid_schema");
  assert.equal(code(s.appendEvent(ev("r1", 3))), "seq_conflict"); // gap
  assert.equal(code(s.appendEvent({ ...ev("r1", 1), eventId: "other" })), "seq_conflict"); // duplicate seq
  assert.equal(s.readEvents("r1").length, 2);
  assert.ok(isOk(s.appendEvent(ev("r2", 0)))); // runs are independent
});

test("events are append-only in the database", (t) => {
  const dir = tmp(t);
  const s = open(t, dir);
  s.appendEvent(ev("r1", 0));
  const db = rawDb(dir);
  track(t, () => db.close());
  assert.throws(() => db.exec("UPDATE events SET type = 'x'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM events"), /append-only/);
});

test("checkpoints are tied to the event log head", (t) => {
  const s = open(t, tmp(t));
  assert.ok(isOk(s.writeCheckpoint(state("r1", null))));
  assert.equal(code(s.writeCheckpoint(state("r1", 0))), "checkpoint_not_at_head");
  s.appendEvent(ev("r1", 0));
  assert.equal(code(s.writeCheckpoint(state("r1", null))), "checkpoint_not_at_head");
  assert.ok(isOk(s.writeCheckpoint(state("r1", 0))));
  assert.equal(s.readCheckpoint("r1")?.lastEventSeq, 0);
  assert.ok(isOk(s.writeCheckpoint(state("r1", 0, "failed"))));
  assert.equal(s.readCheckpoint("r1")?.status, "failed");
  assert.equal(s.readCheckpoint("nope"), undefined);
  assert.equal(code(s.writeCheckpoint({ nonsense: true })), "invalid_schema");
});

test("same-process contention: busy, snapshot reads, then success", (t) => {
  const dir = tmp(t);
  const s = open(t, dir, 100);
  s.appendEvent(ev("r1", 0));
  const a = rawDb(dir, 1000);
  track(t, () => a.close());
  a.exec("BEGIN IMMEDIATE");
  a.prepare("INSERT INTO events (run_id, seq, event_id, type, at, body) VALUES ('r1', 1, 'r1-1', 'run.started', '2026-01-01T00:00:00Z', '{}')").run();
  assert.throws(() => s.appendEvent(ev("r1", 1)), isBusy);
  assert.equal(s.readEvents("r1").length, 1); // WAL: readers see the committed snapshot
  a.exec("ROLLBACK");
  assert.ok(isOk(s.appendEvent(ev("r1", 1))));
});

test("cross-process contention (open handle in another process)", async (t) => {
  const dir = tmp(t);
  const s = open(t, dir, 100);
  const { child, exited, locked } = spawnChild(t, dir, "hold");
  await locked;
  assert.throws(() => s.appendEvent(ev("r1", 0)), isBusy);
  child.stdin.write("go\n");
  assert.equal(await exited, 0);
  const db = rawDb(dir);
  track(t, () => db.close());
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 1); // child committed
  assert.ok(isOk(s.appendEvent(ev("r1", 0))));
});

test("interrupted event write leaves no partial state", async (t) => {
  const dir = tmp(t);
  open(t, dir).close();
  const { exited } = spawnChild(t, dir, "crash");
  assert.equal(await exited, 1);
  const s = open(t, dir);
  const db = rawDb(dir);
  track(t, () => db.close());
  assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
  assert.ok(isOk(s.appendEvent(ev("x", 0))));
});

test("artefacts round-trip, are idempotent and detect tampering", (t) => {
  const dir = tmp(t);
  const s = open(t, dir);
  const bytes = new TextEncoder().encode("hello");
  const d = s.putArtefact(bytes);
  assert.match(d, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(new Uint8Array(s.readArtefact(d)), bytes);
  assert.equal(s.putArtefact(bytes), d);
  const hex = d.slice(7);
  const fd = openSync(join(dir, "artefacts", hex), "r"); // open handle: skip path must not rename
  track(t, () => closeSync(fd));
  assert.equal(s.putArtefact(bytes), d);
  const db = rawDb(dir);
  track(t, () => db.close());
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM artefacts").get() as { n: number }).n, 1);
  assert.throws(() => s.readArtefact("sha256:bad"), /invalid digest/);
  // Tampering: rewrite in place (the open handle above is read-only and shares access).
  writeFileSync(join(dir, "artefacts", hex), "tampered");
  assert.throws(() => s.readArtefact(d), /integrity/);
});

test("recover sweeps temps, adopts and removes orphans, reports missing files", (t) => {
  const dir = tmp(t);
  const s = open(t, dir);
  const art = join(dir, "artefacts");
  const hexOf = (x: string) => s.putArtefact(new TextEncoder().encode(x)).slice(7);

  const stale = join(art, "a.tmp-1-aa");
  const fresh = join(art, "b.tmp-1-bb");
  writeFileSync(stale, "x");
  writeFileSync(fresh, "x");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(stale, old, old);

  // Orphans: write final files without rows.
  const corruptHex = "a".repeat(64);
  writeFileSync(join(art, corruptHex), "wrong"); // name != hash => corrupt
  const missingHex = hexOf("will vanish");
  rmSync(join(art, missingHex));
  const db = rawDb(dir);
  track(t, () => db.close());
  // Make a valid orphan: put, then drop only the row.
  const orphanHex = hexOf("orphan");
  db.prepare("DELETE FROM artefacts WHERE digest = ?").run(`sha256:${orphanHex}`);

  const r = s.recover();
  assert.deepEqual(r.removedTemp, ["a.tmp-1-aa"]);
  assert.ok(existsSync(fresh));
  assert.deepEqual(r.adopted, [orphanHex]);
  assert.deepEqual(r.removedCorrupt, [corruptHex]);
  assert.deepEqual(r.missingFiles, [`sha256:${missingHex}`]);
  assert.equal(existsSync(join(art, corruptHex)), false);
  assert.equal(s.recover().adopted.length, 0);
});

test("duplicate eventId is a typed error, even with a different seq", (t) => {
  const s = open(t, tmp(t));
  assert.ok(isOk(s.appendEvent(ev("r1", 0))));
  assert.equal(code(s.appendEvent(ev("r1", 0))), "duplicate_event"); // retry of a committed event
  assert.equal(code(s.appendEvent({ ...ev("r1", 1), eventId: "r1-0" })), "duplicate_event");
  assert.equal(s.readEvents("r1").length, 1);
});

test("putArtefact repairs a corrupt existing final file", (t) => {
  const dir = tmp(t);
  const s = open(t, dir);
  const payload = new TextEncoder().encode("payload");
  const hex = createHash("sha256").update(payload).digest("hex");
  writeFileSync(join(dir, "artefacts", hex), "garbage");
  const d = s.putArtefact(payload);
  assert.deepEqual(new Uint8Array(s.readArtefact(d)), payload);
});

// Real race: several processes sweep the same stale temps; losers see ENOENT, which must not fail open.
const OPEN_CHILD = `
const { openStore } = await import(process.argv[1]);
console.log("ready");
await new Promise((res) => process.stdin.once("data", res));
try { const s = openStore(process.argv[2]); s.close(); console.log("OK"); }
catch (e) { console.log("FAIL " + e.code + " " + e.message); process.exitCode = 1; }
process.exit();
`;

test("concurrent opens over many stale temps all succeed", { timeout: 90_000 }, async (t) => {
  const dir = tmp(t);
  open(t, dir).close();
  const old = new Date(Date.now() - 3_600_000);
  for (let i = 0; i < 3000; i++) {
    const p = join(dir, "artefacts", `x${i}.tmp-1-aa`);
    writeFileSync(p, "x");
    utimesSync(p, old, old);
  }
  const storeUrl = new URL("./store.ts", import.meta.url).href;
  const kids = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", OPEN_CHILD, storeUrl, dir], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const killer = setTimeout(() => child.kill(), 60_000);
    track(t, () => {
      clearTimeout(killer);
      child.kill();
    });
    let out = "";
    let seenReady = false;
    const ready = new Promise<void>((res, rej) => {
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("ready")) {
          seenReady = true;
          res();
        }
      });
      child.on("exit", (c) => seenReady || rej(new Error(`child exited (${c}) before ready: ${out}`)));
      child.on("error", (e) => seenReady || rej(e));
    });
    ready.catch(() => {}); // surfaced via Promise.all below; avoid unhandled rejection for siblings
    const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
    return { child, ready, exited, output: () => out };
  });
  await Promise.all(kids.map((k) => k.ready));
  for (const k of kids) k.child.stdin.write("go\n");
  const codes = await Promise.all(kids.map((k) => k.exited));
  assert.deepEqual(codes, [0, 0, 0, 0], kids.map((k) => k.output()).join("\n"));
});

test("openStore closes the db when the recover sweep throws", (t) => {
  const dir = tmp(t);
  open(t, dir).close();
  const art = join(dir, "artefacts");
  const win = process.platform === "win32";
  if (!win && process.getuid?.() === 0) return t.skip("root bypasses directory permissions");
  // Deny Everyone by SID (*S-1-1-0): independent of PATH/whoami/locale. track() runs before the dir is removed.
  track(t, () => (win ? execFileSync("icacls", [art, "/remove:d", "*S-1-1-0"]) : chmodSync(art, 0o755)));
  if (win) execFileSync("icacls", [art, "/deny", "*S-1-1-0:(RD)"]);
  else chmodSync(art, 0o000);
  // .close() so an unexpected success does not leak the handle.
  assert.throws(() => openStore(dir).close(), /EPERM|EACCES/);
  // Closure: SQLite removes -wal/-shm when the last connection closes (any OS); on Windows an open handle also blocks rename.
  assert.equal(existsSync(join(dir, "arrc.db-wal")), false);
  assert.equal(existsSync(join(dir, "arrc.db-shm")), false);
  if (win) renameSync(join(dir, "arrc.db"), join(dir, "moved.db"));
});

// libuv opens with FILE_SHARE_DELETE, so an open handle does not block unlink on Node. A stale "temp"
// that cannot be unlinked (here a directory: EPERM/EISDIR) exercises the same skip path portably.
test("unremovable stale temp is skipped and reported, store stays usable", (t) => {
  const dir = tmp(t);
  open(t, dir).close();
  const p = join(dir, "artefacts", "a.tmp-1-aa");
  mkdirSync(p);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(p, old, old);
  const s = open(t, dir);
  const r = s.recover();
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0]!.name, "a.tmp-1-aa");
  assert.ok(isOk(s.appendEvent(ev("r1", 0))));
  assert.ok(s.putArtefact(new TextEncoder().encode("ok")));
});
