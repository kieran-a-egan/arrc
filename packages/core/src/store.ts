import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Digest, parseContract, RunEvent, RunState, type ParseResult } from "./contracts.ts";

// ponytail: Windows-first default. Add an XDG data dir when non-Windows hosts are supported.
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local");
  const dir = join(base, "ARRC");
  if (!isAbsolute(dir)) throw new Error(`data directory is not absolute: ${dir}`);
  return dir;
}

// Version = index + 1. Never edit a shipped entry; append a new one.
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE checkpoints (
  run_id TEXT PRIMARY KEY,
  last_event_seq INTEGER,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE artefacts (
  digest TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;`,
];

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): void {
  const start = userVersion(db);
  if (start > migrations.length) {
    throw new Error(`database schema version ${start} is newer than supported ${migrations.length}`);
  }
  for (let v = start; v < migrations.length; v = userVersion(db)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read under the write lock: another process may have migrated meanwhile.
      const cur = userVersion(db);
      if (cur > migrations.length) throw new Error(`database schema version ${cur} is newer than supported`);
      if (cur === v) {
        db.exec(migrations[v]!);
        db.exec(`PRAGMA user_version = ${v + 1}`); // pragma takes no bound params; v is an integer
      }
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw e;
    }
  }
}

export type StoreErrorCode = "seq_conflict" | "duplicate_event" | "checkpoint_not_at_head";
export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: StoreErrorCode; message: string } };

export type RecoveryReport = {
  removedTemp: string[];
  adopted: string[];
  removedCorrupt: string[];
  missingFiles: string[];
  skipped: { name: string; code: string }[]; // locked/unreadable entries; never block opening
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type Store = ReturnType<typeof openStore>;

export function openStore(dir: string, opts: { busyTimeoutMs?: number } = {}) {
  const artefactDir = join(dir, "artefacts");
  mkdirSync(artefactDir, { recursive: true });
  const db = new DatabaseSync(join(dir, "arrc.db"), { timeout: opts.busyTimeoutMs ?? 5000 });
  try {
    migrate(db); // version check first: refuse a newer schema before touching journal mode
    const mode = (db.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode: string }).journal_mode;
    if (mode.toLowerCase() !== "wal") {
      throw new Error(`could not enable WAL (got ${mode})); WAL needs a local drive, and ${dir} may not be on one`);
    }
    db.exec("PRAGMA synchronous=FULL");
  } catch (e) {
    db.close();
    throw e;
  }

  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw e;
    }
  };
  const maxSeq = (runId: string): number | null => {
    const r = db.prepare("SELECT MAX(seq) AS m FROM events WHERE run_id = ?").get(runId) as { m: number | null };
    return r.m === null ? null : Number(r.m);
  };
  const artefactPath = (hex: string) => join(artefactDir, hex);
  const insertRow = (hex: string, size: number) =>
    db
      .prepare("INSERT OR IGNORE INTO artefacts (digest, size, created_at) VALUES (?, ?, ?)")
      .run(`sha256:${hex}`, size, new Date().toISOString());

  // Returns a typed result for caller-fixable conflicts; SQLite/IO failures (incl. SQLITE_BUSY) throw.
  function appendEvent(input: unknown): ParseResult<RunEvent> | StoreResult<RunEvent> {
    const parsed = parseContract(RunEvent, input);
    if (!parsed.ok) return parsed;
    const ev = parsed.value;
    return tx((): StoreResult<RunEvent> => {
      if (db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(ev.eventId)) {
        return { ok: false, error: { code: "duplicate_event", message: `eventId ${ev.eventId} already exists` } };
      }
      const expected = (maxSeq(ev.runId) ?? -1) + 1;
      if (ev.seq !== expected) {
        return { ok: false, error: { code: "seq_conflict", message: `expected seq ${expected}, got ${ev.seq}` } };
      }
      db.prepare("INSERT INTO events (run_id, seq, event_id, type, at, body) VALUES (?, ?, ?, ?, ?, ?)").run(
        ev.runId,
        ev.seq,
        ev.eventId,
        ev.type,
        ev.at,
        JSON.stringify(ev),
      );
      return { ok: true, value: ev };
    });
  }

  function readEvents(runId: string): RunEvent[] {
    const rows = db.prepare("SELECT body FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { body: string }[];
    return rows.map((r) => {
      const p = parseContract(RunEvent, JSON.parse(r.body));
      if (!p.ok) throw new Error(`corrupt event row in run ${runId}: ${JSON.stringify(p.error)}`);
      return p.value;
    });
  }

  // A checkpoint can never point past the event log.
  function writeCheckpoint(input: unknown): ParseResult<RunState> | StoreResult<RunState> {
    const parsed = parseContract(RunState, input);
    if (!parsed.ok) return parsed;
    const s = parsed.value;
    return tx((): StoreResult<RunState> => {
      const cur = maxSeq(s.runId);
      if (s.lastEventSeq !== cur) {
        return {
          ok: false,
          error: { code: "checkpoint_not_at_head", message: `lastEventSeq ${s.lastEventSeq} != log head ${cur}` },
        };
      }
      db.prepare(
        `INSERT INTO checkpoints (run_id, last_event_seq, state, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET last_event_seq = excluded.last_event_seq,
           state = excluded.state, updated_at = excluded.updated_at`,
      ).run(s.runId, s.lastEventSeq, JSON.stringify(s), new Date().toISOString());
      return { ok: true, value: s };
    });
  }

  function readCheckpoint(runId: string): RunState | undefined {
    const row = db.prepare("SELECT state FROM checkpoints WHERE run_id = ?").get(runId) as { state: string } | undefined;
    if (!row) return undefined;
    const p = parseContract(RunState, JSON.parse(row.state));
    if (!p.ok) throw new Error(`corrupt checkpoint for run ${runId}: ${JSON.stringify(p.error)}`);
    return p.value;
  }

  const intact = (p: string, hex: string) => {
    try {
      return sha256(readFileSync(p)) === hex;
    } catch {
      return false;
    }
  };

  // File first (tmp, fsync, rename), row second: a row never points at a missing file.
  // A missing or corrupt existing file is (over)written via the same path.
  function putArtefact(bytes: Uint8Array): Digest {
    const hex = sha256(bytes);
    const final = artefactPath(hex);
    if (!intact(final, hex)) {
      const tmp = `${final}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      const fd = openSync(tmp, "wx");
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd); // ponytail: no directory fsync; it fails EPERM on Windows. Recovery re-adopts orphans.
      } finally {
        closeSync(fd);
      }
      let delay = 10;
      for (let attempt = 1; ; attempt++) {
        try {
          renameSync(tmp, final);
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? "";
          if (intact(final, hex)) {
            try {
              unlinkSync(tmp); // someone else published identical content
            } catch {
              // recover() sweeps stale temps
            }
            break;
          }
          if (!RETRYABLE.has(code) || attempt >= 6) {
            try {
              unlinkSync(tmp);
            } catch {
              // best effort; recover() sweeps stale temps
            }
            throw e;
          }
          sleepSync(delay);
          delay *= 2;
        }
      }
    }
    insertRow(hex, bytes.byteLength);
    return `sha256:${hex}`;
  }

  function readArtefact(digest: string): Uint8Array {
    const d = parseContract(Digest, digest);
    if (!d.ok) throw new Error(`invalid digest: ${digest}`);
    const hex = d.value.slice("sha256:".length);
    const bytes = readFileSync(artefactPath(hex));
    if (sha256(bytes) !== hex) throw new Error(`artefact ${d.value} failed integrity check`);
    return bytes;
  }

  function recover(ropts: { tempGraceMs?: number; now?: number } = {}): RecoveryReport {
    const grace = ropts.tempGraceMs ?? 60_000;
    const now = ropts.now ?? Date.now();
    const report: RecoveryReport = { removedTemp: [], adopted: [], removedCorrupt: [], missingFiles: [], skipped: [] };
    const rowHexes = new Set(
      (db.prepare("SELECT digest FROM artefacts").all() as { digest: string }[]).map((r) => r.digest.slice(7)),
    );
    const seen = new Set<string>();
    for (const f of readdirSync(artefactDir)) {
      const p = artefactPath(f);
      try {
        if (f.includes(".tmp-")) {
          if (now - statSync(p).mtimeMs >= grace) {
            unlinkSync(p);
            report.removedTemp.push(f);
          }
        } else if (/^[0-9a-f]{64}$/.test(f)) {
          seen.add(f);
          if (rowHexes.has(f)) continue;
          const bytes = readFileSync(p);
          if (sha256(bytes) === f) {
            insertRow(f, bytes.byteLength);
            report.adopted.push(f);
          } else if (intact(p, f)) {
            // a concurrent putArtefact repaired it since we read it
            insertRow(f, readFileSync(p).byteLength);
            report.adopted.push(f);
          } else {
            // ponytail: TOCTOU window remains between this re-hash and unlink; missingFiles reports it, a re-put repairs it.
            unlinkSync(p);
            report.removedCorrupt.push(f);
          }
        }
      } catch (e) {
        const c = (e as NodeJS.ErrnoException).code ?? "UNKNOWN";
        if (c !== "ENOENT") report.skipped.push({ name: f, code: c }); // ENOENT: someone else handled it
      }
    }
    for (const hex of rowHexes) if (!seen.has(hex)) report.missingFiles.push(`sha256:${hex}`);
    return report;
  }

  try {
    recover();
  } catch (e) {
    db.close();
    throw e;
  }

  return { dir, appendEvent, readEvents, writeCheckpoint, readCheckpoint, putArtefact, readArtefact, recover, close: () => db.close() };
}
