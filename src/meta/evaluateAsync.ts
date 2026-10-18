/**
 * The offline evaluation, off the event loop. A file-backed database is
 * evaluated in a worker thread on its own read connection; an in-memory one
 * (tests, demos) cannot be shared with a worker and is evaluated in-process
 * on a later tick.
 */
import { Worker } from "node:worker_threads";
import type { Params } from "../config/params.js";
import type { Store } from "../store/db.js";
import { evaluate, type EvaluationReport } from "./evaluate.js";

export function evaluateAsync(store: Store, params: Params, nowMs: number, windowDays = 14, tipLamports = 100_000): Promise<EvaluationReport> {
  if (store.path === ":memory:") {
    return new Promise((resolve, reject) =>
      setImmediate(() => {
        try {
          resolve(evaluate(store, params, nowMs, windowDays, tipLamports));
        } catch (e) {
          reject(e);
        }
      }),
    );
  }
  // running from source (tsx, tests) the worker is a .ts file and needs the tsx loader; built, it is plain .js
  const fromSource = import.meta.url.endsWith(".ts");
  const entry = new URL(`./evaluateWorker.${fromSource ? "ts" : "js"}`, import.meta.url);
  const execArgv = fromSource && !process.execArgv.some((a) => a.includes("tsx")) ? [...process.execArgv, "--import", "tsx"] : process.execArgv;
  return new Promise((resolve, reject) => {
    const w = new Worker(entry, { workerData: { path: store.path, params, nowMs, windowDays, tipLamports }, execArgv });
    w.once("message", (m: { ok: boolean; report?: EvaluationReport; error?: string }) => (m.ok ? resolve(m.report!) : reject(new Error(m.error))));
    w.once("error", reject);
    w.once("exit", (code) => {
      if (code !== 0) reject(new Error(`evaluation worker exited with code ${code}`));
    });
  });
}
