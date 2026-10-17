/**
 * Properties the exact curve math must satisfy beyond SDK equality.
 */
import { describe, expect, it } from "vitest";
import {
  applyBuy,
  buyTokensFromSol,
  rawBuyCost,
  sellSolFromTokens,
  simulateSell,
  simulateV3Buy,
  solToComplete,
  v3BuyTokensFromSol,
  marketCapLamports,
  feeRates,
} from "../src/math/curve.js";
import { MAINNET_GLOBAL, curveSchedule, fixtureSchedule, randLog, randomCase, rng } from "./helpers/gen.js";

const N = 3000;

describe("curve invariants", () => {
  it("simulateV3Buy delivers exactly what v3BuyTokensFromSol quotes and never exceeds the budget", () => {
    const r = rng(21);
    let checked = 0;
    for (let i = 0; i < N; i++) {
      const c = randomCase(r, { fixture: true });
      const budget = randLog(r, 10_000n, 5_000_000_000n);
      const sim = simulateV3Buy(c.global, c.schedule, c.mintSupply, c.curve, budget);
      if (!sim) continue;
      checked++;
      expect(sim.tokens).toBe(v3BuyTokensFromSol(c.global, c.schedule, c.mintSupply, c.curve, budget, c.curveBaseTokenBalance));
      expect(sim.netSol + sim.fees <= budget).toBe(true);
      // k never decreases through a buy
      const k0 = c.curve.virtualSolReserves * c.curve.virtualTokenReserves;
      const k1 = sim.after.virtualSolReserves * sim.after.virtualTokenReserves;
      expect(k1 >= k0).toBe(true);
    }
    expect(checked).toBeGreaterThan(N * 0.9);
  });

  it("a buy followed immediately by a full sell always loses (no same-bundle take profit exists)", () => {
    const r = rng(22);
    for (let i = 0; i < N; i++) {
      const c = randomCase(r, { fixture: true });
      const budget = randLog(r, 10_000n, 20_000_000_000n);
      const buy = simulateV3Buy(c.global, c.schedule, c.mintSupply, c.curve, budget);
      if (!buy) continue;
      const back = sellSolFromTokens(c.global, c.schedule, c.mintSupply, buy.after, buy.tokens);
      expect(back < budget).toBe(true);
    }
  });

  it("selling never pays more than the gross constant product output and leaves k non-decreasing", () => {
    const r = rng(23);
    for (let i = 0; i < N; i++) {
      const c = randomCase(r, { fixture: true });
      const sold = 793_100_000_000_000n - c.curve.realTokenReserves;
      if (sold <= 1n) continue;
      const tokens = randLog(r, 1n, sold);
      const s = simulateSell(c.global, c.schedule, c.mintSupply, c.curve, tokens);
      expect(s.netSol <= s.grossSol).toBe(true);
      expect(s.fees >= 0n).toBe(true);
      const k0 = c.curve.virtualSolReserves * c.curve.virtualTokenReserves;
      const k1 = s.after.virtualSolReserves * s.after.virtualTokenReserves;
      expect(k1 >= k0).toBe(true);
    }
  });

  it("token output is monotone non-decreasing in budget", () => {
    const r = rng(24);
    for (let i = 0; i < 500; i++) {
      const c = randomCase(r, { fixture: true });
      let prev = -1n;
      for (let b = 1_000_000n; b <= 3_000_000_000n; b = (b * 13n) / 10n) {
        const t = buyTokensFromSol(c.global, c.schedule, c.mintSupply, c.curve, b);
        expect(t >= prev).toBe(true);
        prev = t;
      }
    }
  });

  it("graduation figures from the canonical initial state", () => {
    const g = MAINNET_GLOBAL;
    const init = {
      virtualTokenReserves: g.initialVirtualTokenReserves,
      virtualSolReserves: g.initialVirtualSolReserves,
      realTokenReserves: g.initialRealTokenReserves,
      realSolReserves: 0n,
      tokenTotalSupply: g.tokenTotalSupply,
      complete: false,
      hasCreator: true,
      isMayhemMode: false,
      isCashbackCoin: false,
      creatorFeeBps: 0n,
    };
    const toComplete = solToComplete(init);
    // about 85 SOL of real reserves at graduation
    expect(toComplete).toBe(rawBuyCost(g.initialRealTokenReserves, g.initialVirtualTokenReserves, g.initialVirtualSolReserves));
    expect(toComplete > 84_000_000_000n && toComplete < 86_000_000_000n).toBe(true);
    const done = applyBuy(init, g.initialRealTokenReserves, toComplete);
    expect(done.complete).toBe(true);
    // the whole curve, start to finish, stays below the first PumpSwap tier step
    const mcStart = marketCapLamports(g.tokenTotalSupply, init.virtualSolReserves, init.virtualTokenReserves);
    const mcEnd = marketCapLamports(g.tokenTotalSupply, done.virtualSolReserves, done.virtualTokenReserves);
    expect(mcEnd < fixtureSchedule().feeTiers[1]!.marketCapLamportsThreshold).toBe(true);
    expect(mcStart < mcEnd).toBe(true);
    const r0 = feeRates(g, fixtureSchedule(), g.tokenTotalSupply, done);
    expect(r0.protocolFeeBps + r0.creatorFeeBps).toBe(123n); // PumpSwap tier 0 without its 2 bps LP fee
    const rc = feeRates(g, curveSchedule(), g.tokenTotalSupply, done);
    expect(rc.protocolFeeBps + rc.creatorFeeBps).toBe(125n);
  });
});
