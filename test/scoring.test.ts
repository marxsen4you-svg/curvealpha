import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_PARAMS, resolveParams } from "../src/config/params.js";
import { TokenBook, type TokenRecord } from "../src/ingest/tokens.js";
import { scoreToken, vetoes, type ScoreContext } from "../src/score/alpha.js";
import { creatorFactor, logInflow, microstructureFactor, trajectoryFactor, socialFactor, type CorpusEntry } from "../src/score/factors.js";
import { applyBuy, applySell, rawBuyTokens, rawSellProceeds } from "../src/math/curve.js";
import { MAINNET_GLOBAL, rng } from "./helpers/gen.js";

const T = 5_000_000;

function token(opts: { bundled?: number; organic?: number; creatorSells?: boolean } = {}) {
  const book = new TokenBook();
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const g = MAINNET_GLOBAL;
  book.onCreate({
    kind: "create", signature: "c", slot: 100, receivedAtMs: T, mint, bondingCurve: "", creator, user: creator, name: "Frog Moon", symbol: "FROG", uri: "",
    timestampSec: 0, virtualTokenReserves: g.initialVirtualTokenReserves, virtualSolReserves: g.initialVirtualSolReserves,
    realTokenReserves: g.initialRealTokenReserves, tokenTotalSupply: g.tokenTotalSupply, tokenProgram: "", isMayhemMode: false,
    isCashbackEnabled: false, quoteIsSol: true, creatorFeeBps: 0n,
  });
  let seq = 0;
  const trade = (user: string, isBuy: boolean, amt: bigint, tMs: number, slot: number, preBal: bigint | null = 10_000_000_000n) => {
    const c = book.get(mint)!.curve;
    const tokens = isBuy ? rawBuyTokens(amt, c.virtualTokenReserves, c.virtualSolReserves) : amt;
    const sol = isBuy ? amt : rawSellProceeds(amt, c.virtualTokenReserves, c.virtualSolReserves);
    const after = isBuy ? applyBuy(c, tokens, sol) : applySell(c, tokens, sol);
    book.onTrade({
      kind: "trade", signature: `s${seq}`, slot, seq: seq++, receivedAtMs: tMs, mint, user, isBuy, solAmount: sol, tokenAmount: tokens, fee: 0n, creatorFee: 0n,
      timestampSec: 0, virtualSolReserves: after.virtualSolReserves, virtualTokenReserves: after.virtualTokenReserves, realSolReserves: after.realSolReserves,
      realTokenReserves: after.realTokenReserves, creator, ixName: "", userPreBalance: preBal, feePayer: user,
    });
    return tokens;
  };
  const ct = trade(creator, true, 1_000_000_000n, T, 100);
  for (let i = 0; i < (opts.bundled ?? 0); i++) trade(`sybil${i}`, true, 300_000_000n, T + 10, 100, 303_000_000n);
  const r = rng(3);
  for (let i = 0; i < (opts.organic ?? 0); i++) trade(`w${i}`, true, BigInt(Math.floor(20_000_000 + r() * 800_000_000)), T + 1000 + i * 700, 103 + i);
  if (opts.creatorSells) trade(creator, false, ct, T + 20_000, 200);
  return { book, rec: book.get(mint)! as TokenRecord };
}

const ctx = (over: Partial<ScoreContext> = {}): ScoreContext => ({
  creatorStats: null,
  funders: new Map(),
  smartTop: new Map(),
  recentNames: [],
  social: null,
  corpus: [],
  global: MAINNET_GLOBAL,
  ...over,
});

describe("Alpha Score", () => {
  it("drops unavailable factors and renormalizes, refusing below half coverage", () => {
    const { rec } = token({ organic: 30 });
    const r = scoreToken(rec, 30, T + 30_000, ctx(), DEFAULT_PARAMS);
    expect(r.factors.smartMoney.value).toBeNull();
    expect(r.factors.trajectory.value).toBeNull();
    expect(r.score).not.toBeNull();
    expect(r.coverage).toBeGreaterThan(0.5);
    const sum = Object.values(r.contributions).reduce((a, b) => a + (b ?? 0), 0);
    expect(sum).toBeCloseTo(r.score!, 9);
    const thin = scoreToken(rec, 30, T + 30_000, ctx(), resolveParams({ scoring: { weights: { creator: 0, microstructure: 0, holders: 0, velocity: 0.1, smartMoney: 1, social: 0, trajectory: 1 } } }));
    expect(thin.score).toBeNull();
    expect(thin.vetoed).toMatch(/coverage/);
  });

  it("penalizes bundled, freshly funded first buyers", () => {
    const clean = token({ organic: 30 });
    const bundled = token({ bundled: 12, organic: 18 });
    const a = microstructureFactor(clean.rec, new Map(), DEFAULT_PARAMS);
    const b = microstructureFactor(bundled.rec, new Map(), DEFAULT_PARAMS);
    expect(a.value!).toBeGreaterThan(b.value!);
    expect(b.detail.exactFunded as number).toBeGreaterThan(0.3);
  });

  it("vetoes a token once the creator dumps", () => {
    const { rec } = token({ organic: 10, creatorSells: true });
    expect(vetoes(rec, MAINNET_GLOBAL)).toMatch(/creator/);
    expect(scoreToken(rec, 30, T + 30_000, ctx(), DEFAULT_PARAMS).score).toBeNull();
  });

  it("rewards creators who graduate and punishes serial launchers", () => {
    const { rec } = token({ organic: 5 });
    const good = creatorFactor(rec, { launches: 10, graduations: 3, medianTimeToPeakSec: 300, medianFirstSellSec: 600, selfBuyRate: 0.5 }, DEFAULT_PARAMS);
    const serial = creatorFactor(rec, { launches: 40, graduations: 0, medianTimeToPeakSec: 20, medianFirstSellSec: 15, selfBuyRate: 1 }, DEFAULT_PARAMS);
    expect(good.value!).toBeGreaterThan(0.5);
    expect(serial.value).toBe(0);
  });

  it("flags copycat names through novelty", () => {
    const { rec } = token({ organic: 5 });
    const fresh = socialFactor(rec, ["Dog Hat DOGH", "Cat Zen CATZ"], null);
    const copy = socialFactor(rec, ["Frog Moon FROG", "Frog Moon FROG", "Frog Moon FROG", "Frog Moon FROG", "Frog Moon FROG"], null);
    expect(fresh.value!).toBeGreaterThan(copy.value!);
    expect(copy.detail.copycats).toBe(5);
  });

  it("trajectory kNN rates a token by how its nearest historical curves went, and scores fast on a large corpus", () => {
    const { rec } = token({ organic: 40 });
    const r = rng(9);
    const corpus: CorpusEntry[] = Array.from({ length: 50_000 }, (_, i) => {
      const slope = r() * 3;
      const inflow = Array.from({ length: 24 }, (_, k) => slope * (k + 1));
      const price = inflow.map((x) => 2.8e-8 * (1 + x / 30) ** 2);
      const win = slope > 1.5 ? r() < 0.6 : r() < 0.05;
      return { mint: `m${i}`, createdMs: 0, inflow, price, maxAfter: price.map((p) => (win ? p * 3 : p)), graduated: false };
    });
    for (const c of corpus) logInflow(c); // the Corpus store does this when entries are loaded or archived
    const t0 = performance.now();
    const res = trajectoryFactor(rec, T + 30_000, corpus, DEFAULT_PARAMS);
    const ms = performance.now() - t0;
    console.log(`kNN over ${corpus.length} curves: ${ms.toFixed(1)} ms`);
    expect(res.value).not.toBeNull();
    expect(ms).toBeLessThan(DEFAULT_PARAMS.scoring.scoreDeadlineMs);
  });
});
