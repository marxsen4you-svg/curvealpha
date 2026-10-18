/**
 * Worker thread entry: runs the offline evaluation against the database file
 * on its own connection (WAL lets it read while the engine writes) and posts
 * the report back. The engine's event loop never pays for it.
 */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { evaluate, type ReadableStore } from "./evaluate.js";
import type { Params } from "../config/params.js";

const { path, params, nowMs, windowDays, tipLamports } = workerData as { path: string; params: Params; nowMs: number; windowDays: number; tipLamports: number };
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");
const store: ReadableStore = {
  all: <T>(sql: string, ...args: Array<string | number | bigint | null>) => db.prepare(sql).all(...args) as T[],
  get: <T>(sql: string, ...args: Array<string | number | bigint | null>) => db.prepare(sql).get(...args) as T | undefined,
};
try {
  parentPort!.postMessage({ ok: true, report: evaluate(store, params, nowMs, windowDays, tipLamports) });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
} finally {
  db.close();
}
