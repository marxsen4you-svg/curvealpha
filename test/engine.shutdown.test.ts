/**
 * Graceful shutdown. Stopping used to exit immediately, abandoning orders
 * and exits in flight (a live order may land after the process is gone).
 * settle() waits for them, up to a limit, so the database records their
 * outcome before the process exits.
 */
import { describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import type { Executor } from "../src/exec/executor.js";
import { Sim } from "./helpers/simulate.js";

describe("graceful shutdown", () => {
  it("waits for an order in flight and records it before reporting settled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let buys = 0;
    const s = new Sim({
      wrapExecutor: (paper) =>
        ({
          mode: paper.mode,
          spendableLamports: () => paper.spendableLamports(),
          sell: (o) => paper.sell(o),
          burnClose: (...a) => paper.burnClose(...a),
          buy: async (o) => {
            buys++;
            await gate;
            return paper.buy(o);
          },
        }) satisfies Executor,
    });
    await s.tips.refresh();
    const e = s.boot(new Store(":memory:"));
    expect(await s.runUntil(() => buys > 0, 40)).toBe(true);
    const settled = e.settle(10_000);
    let done = false;
    void settled.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false); // still waiting for the order
    release();
    // the paper buy waits out its simulated latency on the manual clock
    await s.clock.advance(1_000);
    expect(await settled).toBe(true);
    expect(s.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM fills WHERE side = 'buy'")!.n).toBeGreaterThan(0);
  }, 300_000);

  it("gives up after the limit when an order never resolves", async () => {
    const s = new Sim({
      wrapExecutor: (paper) =>
        ({
          mode: paper.mode,
          spendableLamports: () => paper.spendableLamports(),
          sell: (o) => paper.sell(o),
          burnClose: (...a) => paper.burnClose(...a),
          buy: () => new Promise(() => undefined),
        }) satisfies Executor,
    });
    await s.tips.refresh();
    const e = s.boot(new Store(":memory:"));
    let buys = 0;
    const orig = e.positions.open.bind(e.positions);
    e.positions.open = (req) => {
      buys++;
      return orig(req);
    };
    expect(await s.runUntil(() => buys > 0, 40)).toBe(true);
    const t = Date.now();
    expect(await e.settle(150)).toBe(false);
    expect(Date.now() - t).toBeLessThan(2_000);
  }, 300_000);
});
