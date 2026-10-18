/**
 * Leakage and uncertainty in the offline evaluation.
 *
 *  - The Kelly bankroll path learned from each outcome as soon as the
 *    position was opened, not when it closed: a later-closing winner sized
 *    entries that were made before anyone could have known about it.
 *  - The weight search split by open time with no purge: training outcomes
 *    that were still open when the test period began, and the same mint
 *    scored at several horizons on both sides of the split, leak the test
 *    period into training.
 *  - Point estimates came without any uncertainty, on samples where one
 *    mint contributes up to four correlated rows (one per horizon).
 */
import { describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { resolveParams } from "../src/config/params.js";
import { evaluate } from "../src/meta/evaluate.js";

const NOW = Date.UTC(2026, 9, 18);
const DAY = 86_400_000;
const strong = { creator: 0.9, microstructure: 0.9, holders: 0.9, velocity: 0.9, smartMoney: 0.9, social: 0.9, trajectory: 0.9 };

function insert(store: Store, rows: Array<{ mint: string; opened: number; closed: number; multiple: number; values?: Record<string, number | null>; horizon?: number }>) {
  for (const r of rows) {
    store.run(
      "INSERT INTO shadows(mint, horizon_s, score, factors, opened_ms, closed_ms, multiple, sell_tx_count, close_reason, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.mint,
      r.horizon ?? 30,
      90,
      JSON.stringify({ values: r.values ?? strong }),
      r.opened,
      r.closed,
      r.multiple,
      1,
      "test",
      "[[0,1]]",
    );
  }
}

describe("evaluation leakage controls", () => {
  it("the Kelly bankroll path only learns from outcomes that had closed before each simulated entry", () => {
    const store = new Store(":memory:");
    const t0 = NOW - 10 * DAY;
    const rows = [];
    // 60 quick losers establish the sample
    for (let i = 0; i < 60; i++) rows.push({ mint: `L${i}`, opened: t0 + i * 60_000, closed: t0 + i * 60_000 + 30_000, multiple: 0.5 });
    // a 50x winner opened next, but it only closes at the very end
    rows.push({ mint: "W", opened: t0 + 60 * 60_000, closed: NOW - 60_000, multiple: 50 });
    // nine more losers, entered while the winner was still open
    for (let i = 0; i < 9; i++) rows.push({ mint: `M${i}`, opened: t0 + (61 + i) * 60_000, closed: t0 + (61 + i) * 60_000 + 30_000, multiple: 0.5 });
    insert(store, rows);
    const rep = evaluate(store, resolveParams({}), NOW);
    // nothing known at entry time justified a stake, so no simulated trade was made
    for (const k of rep.kelly) expect(k.finalBankrollSol).toBe(1);
  });

  it("the weight search purges training outcomes that overlap the test period, by time and by mint", () => {
    const store = new Store(":memory:");
    const t0 = NOW - 10 * DAY;
    const rows = [];
    // 100 outcomes, one per mint, one hour apart, each closed 10 minutes after it opened
    for (let i = 0; i < 100; i++) rows.push({ mint: `T${i}`, opened: t0 + i * 3_600_000, closed: t0 + i * 3_600_000 + 600_000, multiple: 1 + (i % 7) / 10 });
    // training outcome 50 stays open into the test period (which starts at outcome 70)
    rows[50]!.closed = t0 + 75 * 3_600_000;
    // training outcomes 10 and 20 share their mint with test outcomes
    rows[10]!.mint = "T80";
    rows[20]!.mint = "T90";
    insert(store, rows);
    const rep = evaluate(store, resolveParams({}), NOW);
    expect(rep.weights.trainSamples).toBe(67);
    expect(rep.weights.testSamples).toBe(30);
    expect(rep.weights.purged).toBe(3);
  });
});

describe("evaluation uncertainty", () => {
  it("reports bootstrap intervals, resampled by mint, that bracket the point estimates", () => {
    const store = new Store(":memory:");
    const rows = [];
    let k = 0;
    for (let m = 0; m < 80; m++) {
      for (const h of [15, 30, 60, 90]) {
        const v = (m % 10) / 10;
        // related to velocity, with deterministic noise so the correlation is not perfect
        const noise = (((m * 7 + h) % 11) - 5) / 10;
        rows.push({ mint: `C${m}`, horizon: h, opened: NOW - 5 * DAY + k * 60_000, closed: NOW - 5 * DAY + k * 60_000 + 30_000, multiple: Math.max(0.05, 0.4 + v * 1.5 + noise), values: { ...strong, velocity: v } });
        k++;
      }
    }
    insert(store, rows);
    const rep = evaluate(store, resolveParams({}), NOW);
    const vel = rep.attribution.find((a) => a.factor === "velocity")!;
    expect(vel.spearman).not.toBeNull();
    expect(vel.spearmanCi).not.toBeNull();
    expect(vel.spearmanCi![0]).toBeLessThanOrEqual(vel.spearman!);
    expect(vel.spearmanCi![1]).toBeGreaterThanOrEqual(vel.spearman!);
    expect(rep.baseline.clusters).toBe(80);
    const th = rep.thresholds.find((t) => t.selected >= 20 && t.meanMultiple !== null)!;
    expect(th.meanMultipleCi![0]).toBeLessThanOrEqual(th.meanMultiple!);
    expect(th.meanMultipleCi![1]).toBeGreaterThanOrEqual(th.meanMultiple!);
  });
});
