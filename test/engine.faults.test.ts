/**
 * Fault containment in the execution path.
 *
 * Orders and exits are launched without awaiting them. An exception inside
 * one (an RPC error, a Jito HTTP error, a bug) used to become an unhandled
 * promise rejection, which terminates Node by default and, with systemd's
 * Restart=always, restarts the engine without its open positions. An
 * exception during a live buy also leaves the order's outcome unknown: it
 * may have landed. The engine must contain the error, keep managing what it
 * holds, and stop opening new positions until an operator has looked.
 */
import { describe, expect, it } from "vitest";
import type { Executor } from "../src/exec/executor.js";
import { simulate } from "./helpers/simulate.js";

describe("execution faults are contained", () => {
  it("an exception during a buy halts new entries instead of crashing, and frees the order's reservation", async () => {
    let throws = 0;
    const { engine, store } = await simulate(8, undefined, {
      wrapExecutor: (paper) =>
        ({
          mode: paper.mode,
          spendableLamports: () => paper.spendableLamports(),
          sell: (o) => paper.sell(o),
          burnClose: (...a) => paper.burnClose(...a),
          buy: async () => {
            throws++;
            throw new Error("rpc: socket hang up");
          },
        }) satisfies Executor,
    });
    expect(throws).toBeGreaterThan(0);
    const snap = engine.survivalSnapshot();
    expect(snap.mode).toBe("HALTED");
    expect(snap.haltReason).toMatch(/execution fault.*socket hang up/);
    expect(snap.pendingPositions).toBe(0);
    // the fault is in the audit log, and no buy after it was attempted
    const faults = store.all<{ summary: string }>("SELECT summary FROM decisions WHERE kind = 'execution' AND summary LIKE '%fault%'");
    expect(faults.length).toBeGreaterThan(0);
    expect(throws).toBe(1);
  }, 300_000);

  it("an exception during a sell is logged and retried; the position stays managed", async () => {
    let sellThrows = 0;
    const { engine, store } = await simulate(12, undefined, {
      wrapExecutor: (paper) =>
        ({
          mode: paper.mode,
          spendableLamports: () => paper.spendableLamports(),
          buy: (o) => paper.buy(o),
          burnClose: (...a) => paper.burnClose(...a),
          sell: async (o) => {
            if (sellThrows < 3) {
              sellThrows++;
              throw new Error("jito: 429 Too Many Requests");
            }
            return paper.sell(o);
          },
        }) satisfies Executor,
    });
    expect(sellThrows).toBe(3);
    const failedExits = store.all<{ summary: string }>("SELECT summary FROM decisions WHERE kind = 'exit' AND approved = 0");
    expect(failedExits.length).toBeGreaterThanOrEqual(3);
    expect(failedExits[0]!.summary).toMatch(/429/);
    // a sell fault does not halt entries: exits must keep working
    expect(engine.survivalSnapshot().haltReason ?? "").not.toMatch(/execution fault/);
    // and the position whose sells threw was eventually closed by a later attempt
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM positions WHERE status = 'closed'")!.n).toBeGreaterThan(0);
  }, 300_000);
});
