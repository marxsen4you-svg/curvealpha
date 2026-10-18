/**
 * Persistence must degrade, not crash.
 *
 *  - A deferred write that throws used to roll back the whole 250 ms batch
 *    (fills and position updates included) and rethrow from a timer, which
 *    terminates the process.
 *  - Without a busy timeout a second connection (the CLI's evaluate or
 *    check-params while the engine runs) fails at once with SQLITE_BUSY
 *    instead of waiting for the engine's write to finish.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Store } from "../src/store/db.js";

describe("store robustness", () => {
  it("a failing deferred write is counted and skipped; the rest of the batch commits", () => {
    const store = new Store(":memory:");
    store.defer(() => store.run("INSERT INTO kv(key, value) VALUES (?, ?)", "a", "1"));
    store.defer(() => store.run("INSERT INTO no_such_table(x) VALUES (?)", 1));
    store.defer(() => store.run("INSERT INTO kv(key, value) VALUES (?, ?)", "b", "2"));
    expect(() => store.flush()).not.toThrow();
    expect(store.kvGet("a")).toBe("1");
    expect(store.kvGet("b")).toBe("2");
    expect(store.writeErrors).toBe(1);
    expect(store.lastWriteError).toMatch(/no_such_table/);
  });

  it("a second connection waits for the engine's write lock instead of failing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ca-busy-")), "db.sqlite");
    new Store(path).close(); // schema
    const shared = new Int32Array(new SharedArrayBuffer(4));
    // the "engine" connection holds a write transaction for 400 ms in another thread
    const worker = new Worker(
      `const { workerData } = require("node:worker_threads");
       const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(workerData.path);
       db.exec("BEGIN IMMEDIATE");
       db.exec("INSERT INTO kv(key, value) VALUES ('engine', 'x')");
       Atomics.store(workerData.flag, 0, 1); Atomics.notify(workerData.flag, 0);
       Atomics.wait(workerData.flag, 0, 1, 400);
       db.exec("COMMIT");
       db.close();`,
      { eval: true, workerData: { path, flag: shared } },
    );
    while (Atomics.load(shared, 0) !== 1) await new Promise((r) => setTimeout(r, 5));
    const cli = new Store(path);
    expect(() => cli.kvSet("cli", "y")).not.toThrow();
    expect(cli.kvGet("engine")).toBe("x");
    cli.close();
    await new Promise((r) => worker.once("exit", r));
  });
});
