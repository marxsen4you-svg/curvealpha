/**
 * Differential proof: CurveAlpha's bigint curve math equals pump.fun's own
 * SDK (@pump-fun/pump-sdk 4.1.0, which mirrors the program) on every case.
 * Any single mismatch fails the suite.
 */
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { pumpSdk } from "../src/chain/sdk.js";
import {
  buySolFromTokens,
  buyTokensFromSol,
  feeRates,
  marketCapLamports,
  sellSolFromTokens,
  v3BuySolFromTokens,
  v3BuyTokensFromSol,
} from "../src/math/curve.js";
import { big, randBig, randLog, randomCase, rng, toSdkCurve, toSdkFeeConfig, toSdkGlobal } from "./helpers/gen.js";

const N = Number(process.env.CURVE_DIFF_CASES ?? 4000);

/** Run fn and capture either its value or the fact that it threw. */
function outcome<T>(fn: () => T): { ok: true; v: T } | { ok: false } {
  try {
    return { ok: true, v: fn() };
  } catch {
    return { ok: false };
  }
}

function compare(ours: () => bigint, theirs: () => { toString(): string }) {
  const a = outcome(ours);
  const b = outcome(() => big(theirs()));
  expect(a.ok).toBe(b.ok);
  if (a.ok && b.ok) expect(a.v).toBe(b.v);
}

const {
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getBuyV3QuoteAmountFromTokenAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
  bondingCurveMarketCap,
  computeFeesBps,
} = pumpSdk;

describe("curve math equals the official pump SDK", () => {
  for (const fixture of [false, true]) {
    const label = fixture ? "mainnet fixture tiers" : "random tiers";

    it(`fee rates and market cap (${label})`, () => {
      const r = rng(fixture ? 11 : 1);
      for (let i = 0; i < N; i++) {
        const c = randomCase(r, { fixture });
        const ours = feeRates(c.global, c.schedule, c.mintSupply, c.curve);
        const theirs = computeFeesBps({
          global: toSdkGlobal(c.global),
          feeConfig: toSdkFeeConfig(c.schedule),
          mintSupply: new BN(c.mintSupply.toString()),
          virtualQuoteReserves: new BN(c.curve.virtualSolReserves.toString()),
          virtualTokenReserves: new BN(c.curve.virtualTokenReserves.toString()),
          quoteMint: PublicKey.default,
          creatorFeeBps: new BN(c.curve.creatorFeeBps.toString()),
        });
        expect(ours.protocolFeeBps).toBe(big(theirs.protocolFeeBps));
        expect(ours.creatorFeeBps).toBe(big(theirs.creatorFeeBps));
        expect(marketCapLamports(c.mintSupply, c.curve.virtualSolReserves, c.curve.virtualTokenReserves)).toBe(
          big(
            bondingCurveMarketCap({
              mintSupply: new BN(c.mintSupply.toString()),
              virtualQuoteReserves: new BN(c.curve.virtualSolReserves.toString()),
              virtualTokenReserves: new BN(c.curve.virtualTokenReserves.toString()),
            }),
          ),
        );
      }
    });

    it(`v1/v2 buy, buy cost and sell (${label})`, () => {
      const r = rng(fixture ? 12 : 2);
      for (let i = 0; i < N; i++) {
        const c = randomCase(r, { fixture });
        const sol = randLog(r, 1n, 200_000_000_000n);
        const tokens = randLog(r, 1n, 800_000_000_000_000n);
        const args = {
          global: toSdkGlobal(c.global),
          feeConfig: toSdkFeeConfig(c.schedule),
          mintSupply: new BN(c.mintSupply.toString()),
          bondingCurve: toSdkCurve(c.curve),
          quoteMint: PublicKey.default,
        };
        compare(
          () => buyTokensFromSol(c.global, c.schedule, c.mintSupply, c.curve, sol),
          () => getBuyTokenAmountFromSolAmount({ ...args, amount: new BN(sol.toString()) }),
        );
        compare(
          () => buySolFromTokens(c.global, c.schedule, c.mintSupply, c.curve, tokens),
          () => getBuySolAmountFromTokenAmount({ ...args, amount: new BN(tokens.toString()) }),
        );
        compare(
          () => sellSolFromTokens(c.global, c.schedule, c.mintSupply, c.curve, tokens),
          () => getSellSolAmountFromTokenAmount({ ...args, amount: new BN(tokens.toString()) }),
        );
        // the no-FeeConfig fallback path
        compare(
          () => sellSolFromTokens(c.global, null, c.mintSupply, c.curve, tokens),
          () => getSellSolAmountFromTokenAmount({ ...args, feeConfig: null, amount: new BN(tokens.toString()) }),
        );
      }
    });

    it(`v3 exact-in buy and v3 token buy incl. post-completion leg (${label})`, () => {
      const r = rng(fixture ? 13 : 3);
      for (let i = 0; i < N; i++) {
        const c = randomCase(r, { fixture });
        // a third of budgets are sized to cross the remaining curve supply
        const budget =
          r() < 0.33 ? randLog(r, 1_000_000_000n, 400_000_000_000n) : randLog(r, 1n, 10_000_000_000n);
        const tokens =
          r() < 0.33
            ? c.curve.realTokenReserves + randBig(r, 1n, 150_000_000_000_000n)
            : randLog(r, 1n, 500_000_000_000_000n);
        const args = {
          global: toSdkGlobal(c.global),
          feeConfig: toSdkFeeConfig(c.schedule),
          mintSupply: new BN(c.mintSupply.toString()),
          bondingCurve: toSdkCurve(c.curve),
          curveBaseTokenBalance: new BN(c.curveBaseTokenBalance.toString()),
        };
        compare(
          () => v3BuyTokensFromSol(c.global, c.schedule, c.mintSupply, c.curve, budget, c.curveBaseTokenBalance),
          () => getBuyV3TokenAmountFromQuoteAmount({ ...args, amount: new BN(budget.toString()) }),
        );
        compare(
          () => v3BuySolFromTokens(c.global, c.schedule, c.mintSupply, c.curve, tokens, c.curveBaseTokenBalance),
          () => getBuyV3QuoteAmountFromTokenAmount({ ...args, amount: new BN(tokens.toString()) }),
        );
      }
    });
  }
});
