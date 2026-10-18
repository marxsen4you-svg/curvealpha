/**
 * Approved but not yet filled orders must count against every limit.
 *
 * The engine approves, then fills asynchronously (paper latency, or a live
 * bundle that can take seconds to land). Before this fix the concurrency
 * count, the daily risk budget and the spendable balance were only updated
 * after the fill, so several candidates approved in one scoring pass could
 * all go through and exceed the caps together.
 */
import { describe, expect, it } from "vitest";
import { resolveParams, type Params } from "../src/config/params.js";
import { CapitalSurvivalEngine, type Candidate } from "../src/risk/survival.js";
import type { Outcome } from "../src/risk/kelly.js";
import { rng } from "./helpers/gen.js";

const SOL = 1e9;
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);

function goodOutcomes(n = 200): Outcome[] {
  const r = rng(7);
  return Array.from({ length: n }, () => {
    const u = r();
    const multiple = u < 0.55 ? 0.55 : u < 0.8 ? 1.3 : u < 0.95 ? 2.4 : 6;
    return { multiple, sellTxCount: multiple > 1 ? 3 : 1 };
  });
}

const cand = (mint: string, over: Partial<Candidate> = {}): Candidate => ({
  mint,
  alphaScore: 92,
  horizonSec: 30,
  outcomes: goodOutcomes(),
  entryFixedLamports: 15_300,
  exitFixedLamportsPerTx: 15_300,
  entryTipLamports: 10_000,
  ataRentLamports: 1_513_840,
  spendableLamports: 100 * SOL,
  seed: 1234,
  ...over,
});

const engine = (p: Params) => new CapitalSurvivalEngine(() => p, 100 * SOL, T0);

describe("Capital Survival Engine: in-flight reservations", () => {
  it("counts an approved, unfilled order against the concurrency limit", () => {
    const e = engine(resolveParams({ risk: { maxConcurrentPositions: 1 } }));
    const a = e.decide(cand("A"), T0);
    expect(a.approved).toBe(true);
    const b = e.decide(cand("B"), T0);
    expect(b.approved).toBe(false);
    expect(b.reasons[0]).toBe("concurrency: 0 open + 1 pending, limit 1");
  });

  it("frees the slot when the order fails, and keeps it when it fills", () => {
    const e = engine(resolveParams({ risk: { maxConcurrentPositions: 1 } }));
    const a = e.decide(cand("A"), T0);
    e.release(a.reservationId!);
    const b = e.decide(cand("B"), T0);
    expect(b.approved).toBe(true);
    e.commit(b.reservationId!, b.stakeLamports);
    e.setOpenPositions(1);
    expect(e.decide(cand("C"), T0).reasons[0]).toBe("concurrency: 1 open + 0 pending, limit 1");
  });

  it("charges an unfilled order to the daily risk budget", () => {
    // 100 SOL day start, 1.25 % per-trade cap = 1.25 SOL; a 2 % daily budget leaves 0.75 SOL after one trade
    const e = engine(resolveParams({ risk: { maxConcurrentPositions: 5, dailyRiskBudgetPct: 0.02 } }));
    const a = e.decide(cand("A"), T0);
    expect(a.approved).toBe(true);
    const b = e.decide(cand("B"), T0);
    expect(b.trace.dailyBudgetStake).toBeCloseTo(2 * SOL - a.stakeLamports, -1);
  });

  it("subtracts an unfilled order's cash from what the next order may spend", () => {
    const p = resolveParams({ risk: { maxConcurrentPositions: 5 } });
    // the same seed and sample give both orders the same stake; fund one and a half of them
    const stake = engine(p).decide(cand("probe"), T0).stakeLamports;
    const need = stake + 15_300 + 1_513_840;
    const spend = Math.floor(need * 1.5);
    const e = engine(p);
    expect(e.decide(cand("A", { spendableLamports: spend }), T0).approved).toBe(true);
    const b = e.decide(cand("B", { spendableLamports: spend }), T0);
    expect(b.approved).toBe(false);
    expect(b.reasons[0]).toMatch(/^funds:/);
  });

  it("records what was pending in the snapshot so the decision replays", () => {
    const p = resolveParams({ risk: { maxConcurrentPositions: 1 } });
    const e = engine(p);
    e.decide(cand("A"), T0);
    const snap = e.snapshot(T0);
    expect(snap.pendingPositions).toBe(1);
    const replayed = CapitalSurvivalEngine.replay(p, snap, cand("B"), T0);
    expect(replayed.reasons[0]).toBe("concurrency: 0 open + 1 pending, limit 1");
  });
});
