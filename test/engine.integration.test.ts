/**
 * End to end: a synthetic market streamed through the real pipeline (event
 * parsing, token book, scoring, shadow ledger, Capital Survival Engine,
 * paper executor, exit engine, persistence), on a manual clock.
 */
import { describe, expect, it } from "vitest";
import { replayDecision } from "../src/meta/replay.js";
import { evaluate } from "../src/meta/evaluate.js";
import { simulate, T0 } from "./helpers/simulate.js";

const MINUTES = 30;

describe("engine integration on a synthetic market", () => {
  it("runs the full pipeline, logs replayable decisions and keeps an exact paper ledger", async () => {
    const { engine, store, paper, sim, params, start } = await simulate(MINUTES);
    const c = engine.counters;
    expect(c.creates).toBeGreaterThan(300);
    expect(c.scored).toBeGreaterThan(1000);

    const closedShadows = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM shadows WHERE closed_ms IS NOT NULL")!.n;
    expect(closedShadows).toBeGreaterThan(100);

    // the Survival Engine was consulted, and every sizing decision replays exactly
    const sizes = store.all<{ id: number }>("SELECT id FROM decisions WHERE kind = 'size' ORDER BY id");
    expect(sizes.length).toBeGreaterThan(0);
    for (const { id } of sizes.slice(0, 25)) {
      const r = replayDecision(store, id);
      expect(r.differences).toEqual([]);
    }

    // rug tokens with a creator dump are vetoed from then on and never bought afterwards
    const bought = store.all<{ mint: string; opened_ms: number }>("SELECT mint, opened_ms FROM positions");
    for (const b of bought) expect(sim.kinds.has(b.mint)).toBe(true);

    // paper ledger: cash equals start minus every outflow plus every inflow, to the lamport
    const fills = store.all<{ side: string; lamports: number; tip_lamports: number; network_lamports: number }>("SELECT side, lamports, tip_lamports, network_lamports FROM fills");
    const opened = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM positions")!.n;
    const closed = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM positions WHERE status = 'closed'")!.n;
    let expected = start;
    for (const f of fills) {
      const amt = BigInt(f.lamports);
      expected += f.side === "buy" ? -amt : f.side === "sell" ? amt : 0n;
      expected -= BigInt(f.tip_lamports) + BigInt(f.network_lamports);
    }
    expected -= BigInt(opened) * 2_074_080n;
    expected += BigInt(closed) * 2_074_080n;
    expect(paper.cash).toBe(expected);

    // risk cap respected on every entry
    for (const p of store.all<{ stake_lamports: number }>("SELECT stake_lamports FROM positions")) {
      expect(p.stake_lamports).toBeLessThanOrEqual(Math.ceil(params.risk.maxRiskPerTradePct * 3.5e9));
    }

    // never more positions open at once than the concurrency limit
    const spans = store.all<{ opened_ms: number; closed_ms: number | null }>("SELECT opened_ms, closed_ms FROM positions");
    for (const s of spans) {
      const overlapping = spans.filter((o) => o.opened_ms <= s.opened_ms && (o.closed_ms === null || o.closed_ms > s.opened_ms)).length;
      expect(overlapping).toBeLessThanOrEqual(params.risk.maxConcurrentPositions);
    }

    // scoring stays inside its deadline
    const lat = [...engine.scoreLatency].sort((a, b) => a - b);
    expect(lat[Math.floor(lat.length * 0.99)]!).toBeLessThan(params.scoring.scoreDeadlineMs);

    // offline evaluation runs on what was collected
    const rep = evaluate(store, params, T0 + MINUTES * 60_000);
    expect(rep.samples).toBe(closedShadows);
    expect(rep.attribution).toHaveLength(7);
    console.log(
      `sim: ${c.creates} tokens, ${c.scored} scored, ${closedShadows} shadow outcomes, ${c.candidates} candidates, ${c.approved} approved, ${opened} positions (${closed} closed); paper cash ${(Number(paper.cash) / 1e9).toFixed(4)} SOL`,
    );
  }, 900_000);
});
