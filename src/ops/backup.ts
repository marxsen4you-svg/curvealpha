/**
 * Database backup and restore.
 *
 * Backup is online: pending writes are flushed, then VACUUM INTO writes a
 * consistent, compacted copy while the engine keeps running, and the copy
 * is integrity-checked before it is reported good.
 *
 * Restore is offline: it refuses while an engine heartbeat on the target is
 * fresh, refuses a backup that fails its integrity check or comes from a
 * newer schema, and moves the database it replaces aside instead of
 * deleting it.
 */
import { copyFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, type Store } from "../store/db.js";

export interface BackupResult {
  ok: boolean;
  path: string;
  bytes: number;
  error?: string;
}

function inspect(path: string): { ok: true; version: number } | { ok: false; error: string } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path);
    const qc = (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
    if (qc !== "ok") return { ok: false, error: `integrity check failed: ${qc}` };
    return { ok: true, version: Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) };
  } catch (e) {
    return { ok: false, error: `not a readable CurveAlpha database: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    db?.close();
  }
}

export function backupDatabase(store: Store, dest: string): BackupResult {
  if (existsSync(dest)) return { ok: false, path: dest, bytes: 0, error: `${dest} already exists` };
  store.flush();
  store.db.prepare("VACUUM INTO ?").run(dest);
  const check = inspect(dest);
  return { ok: check.ok, path: dest, bytes: statSync(dest).size, ...(check.ok ? {} : { error: check.error }) };
}

export function restoreDatabase(backup: string, dbPath: string, nowMs: number, heartbeatMaxAgeMs = 15_000): { ok: boolean; error?: string; asidePath?: string } {
  const check = inspect(backup);
  if (!check.ok) return { ok: false, error: check.error };
  if (check.version > SCHEMA_VERSION) return { ok: false, error: `backup schema version ${check.version} is newer than this build (${SCHEMA_VERSION})` };
  let asidePath: string | undefined;
  if (existsSync(dbPath)) {
    const cur = new DatabaseSync(dbPath);
    try {
      const beats = cur.prepare("SELECT value FROM kv WHERE key LIKE 'heartbeat:%'").all() as Array<{ value: string }>;
      const alive = beats.some((b) => {
        try {
          return nowMs - (JSON.parse(b.value) as { atMs: number }).atMs < heartbeatMaxAgeMs;
        } catch {
          return false;
        }
      });
      if (alive) return { ok: false, error: "the engine using this database is running: stop it before restoring" };
      cur.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      cur.close();
    }
    asidePath = `${dbPath}.pre-restore-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}.sqlite`;
    renameSync(dbPath, asidePath);
    for (const ext of ["-wal", "-shm"]) if (existsSync(dbPath + ext)) rmSync(dbPath + ext);
  }
  copyFileSync(backup, dbPath);
  return { ok: true, asidePath };
}
