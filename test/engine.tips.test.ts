/**
 * Fixed costs come from the live Jito tip floor. When the floor stops
 * updating (API outage, network trouble) the costs in every sizing decision
 * are unknown, so no entry may be approved. TipOracle.isStale existed for
 * this but nothing called it.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "./helpers/simulate.js";

describe("entries depend on a fresh tip floor", () => {
  it("approves entries while the tip floor keeps updating", async () => {
    const { store } = await simulate(8);
    const approved = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM decisions WHERE kind = 'size' AND approved = 1")!.n;
    expect(approved).toBeGreaterThan(0);
  }, 300_000);

  it("refuses every entry once the tip floor goes stale, and says why", async () => {
    const { store, engine } = await simulate(8, undefined, { tipsDownAfterMs: 60_000 });
    const sizes = store.all<{ approved: number; summary: string }>("SELECT approved, summary FROM decisions WHERE kind = 'size'");
    expect(sizes.filter((s) => s.approved === 1)).toEqual([]);
    expect(sizes.some((s) => /stale/.test(s.summary))).toBe(true);
    // the counterfactual ledger keeps learning; it does not depend on tips
    expect(engine.shadows.openCount + store.get<{ n: number }>("SELECT COUNT(*) AS n FROM shadows")!.n).toBeGreaterThan(0);
  }, 300_000);
});
