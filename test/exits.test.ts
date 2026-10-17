import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_PARAMS, resolveParams } from "../src/config/params.js";
import { applyExitFill, evaluateExit, openExitState, type CurveCtx } from "../src/exits/exitEngine.js";
import { TokenBook } from "../src/ingest/tokens.js";
import { applyBuy, applySell, rawBuyTokens, rawSellProceeds, simulateV3Buy, type CurveState } from "../src/math/curve.js";
import { MAINNET_GLOBAL, curveSchedule } from "./helpers/gen.js";

const ctx: CurveCtx = { global: MAINNET_GLOBAL, schedule: curveSchedule(), mintSupply: MAINNET_GLOBAL.tokenTotalSupply };
const T = 1_000_000;

function setup(creatorBuy = 500_000_000n) {
  const book = new TokenBook();
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const g = MAINNET_GLOBAL;
  book.onCreate({
    kind: "create", signature: "c", slot: 1, receivedAtMs: T, mint, bondingCurve: "", creator, user: creator, name: "x", symbol: "X", uri: "",
    timestampSec: 0, virtualTokenReserves: g.initialVirtualTokenReserves, virtualSolReserves: g.initialVirtualSolReserves,
    realTokenReserves: g.initialRealTokenReserves, tokenTotalSupply: g.tokenTotalSupply, tokenProgram: "", isMayhemMode: false,
    isCashbackEnabled: false, quoteIsSol: true, creatorFeeBps: 0n,
  });
  let seq = 0;
  const trade = (user: string, isBuy: boolean, lamportsOrTokens: bigint, tMs: number) => {
    const rec = book.get(mint)!;
    const c = rec.curve;
    let tokens: bigint, sol: bigint, after: CurveState;
    if (isBuy) {
      tokens = rawBuyTokens(lamportsOrTokens, c.virtualTokenReserves, c.virtualSolReserves);
      sol = lamportsOrTokens;
      after = applyBuy(c, tokens, sol);
    } else {
      tokens = lamportsOrTokens;
      sol = rawSellProceeds(tokens, c.virtualTokenReserves, c.virtualSolReserves);
      after = applySell(c, tokens, sol);
    }
    book.onTrade({
      kind: "trade", signature: `s${seq}`, slot: 2 + seq, seq: seq++, receivedAtMs: tMs, mint, user, isBuy, solAmount: sol, tokenAmount: tokens,
      fee: 0n, creatorFee: 0n, timestampSec: 0, virtualSolReserves: after.virtualSolReserves, virtualTokenReserves: after.virtualTokenReserves,
      realSolReserves: after.realSolReserves, realTokenReserves: after.realTokenReserves, creator, ixName: "", userPreBalance: null, feePayer: user,
    });
    return tokens;
  };
  const creatorTokens = trade(creator, true, creatorBuy, T);
  trade("whale", true, 10_000_000_000n, T + 1000);
  const rec = book.get(mint)!;
  const stake = 50_000_000n;
  const buy = simulateV3Buy(ctx.global, ctx.schedule, ctx.mintSupply, rec.curve, stake)!;
  const s = openExitState(mint, stake, buy.tokens, rec, T + 2000, DEFAULT_PARAMS);
  return { book, mint, creator, creatorTokens, trade, rec, s };
}

describe("exit engine", () => {
  it("fires take-profit rungs in order as the liquidation multiple climbs", () => {
    const { trade, rec, s } = setup();
    expect(evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 3000, 0n)).toBeNull();
    trade("buyer", true, 25_000_000_000n, T + 5000); // big inflow lifts the price well past 1.6x
    const a = evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 6000, 0n)!;
    expect(a.kind).toBe("sell");
    if (a.kind !== "sell") throw new Error();
    expect(a.rung).toBe(0);
    expect(a.tokens).toBe((s.initialTokens * 300_000n) / 1_000_000n);
    applyExitFill(s, a, a.tokens, 1n);
    const b = evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 7000, 0n);
    // the next rung needs 2.5x, which this move may or may not reach; it must not repeat rung 0
    if (b && b.kind === "sell") expect(b.rung === undefined || b.rung > 0).toBe(true);
  });

  it("exits everything on the hard stop", () => {
    const { trade, rec, s } = setup();
    trade("whale", false, rec.holders.get("whale")!, T + 4000);
    const a = evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 5000, 0n)!;
    expect(a.kind).toBe("sell");
    if (a.kind === "sell") {
      expect(a.reason).toMatch(/^stop/);
      expect(a.tokens).toBe(s.remainingTokens);
      expect(a.urgency).toBe("emergency");
    }
  });

  it("exits on a creator dump before anything else", () => {
    const { trade, rec, s, creator, creatorTokens } = setup();
    trade(creator, false, creatorTokens / 5n, T + 4000);
    const a = evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 4500, 0n)!;
    expect(a.kind === "sell" && a.urgency === "emergency" && /creator sold/.test(a.reason)).toBe(true);
  });

  it("exits at the maximum hold time", () => {
    const { rec, s } = setup();
    const p = resolveParams({ exits: { maxHoldSec: 60, momentumDecayRatio: 0 } });
    const a = evaluateExit(s, rec, ctx, p, s.openedAtMs + 61_000, 0n)!;
    expect(a.kind === "sell" && /max hold/.test(a.reason)).toBe(true);
  });

  it("exits on momentum decay before the first rung", () => {
    const { trade, rec, s } = setup();
    const p = resolveParams({ exits: { momentumWindowSec: 10, momentumMinHoldSec: 5 } });
    trade("b1", true, 1_000_000_000n, T + 3000);
    expect(evaluateExit(s, rec, ctx, p, T + 4000, 0n)).toBeNull(); // inflow strong, records the peak
    const a = evaluateExit(s, rec, ctx, p, T + 40_000, 0n)!; // nothing since: inflow collapsed
    expect(a.kind === "sell" && /momentum/.test(a.reason)).toBe(true);
  });

  it("trails the runner after the first rung", () => {
    const { trade, rec, s } = setup();
    trade("buyer", true, 25_000_000_000n, T + 5000);
    const a = evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 6000, 0n)!;
    if (a.kind !== "sell") throw new Error();
    applyExitFill(s, a, a.tokens, 1n);
    evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 6500, 0n);
    trade("buyer", false, rec.holders.get("buyer")!, T + 7000);
    const b = evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 8000, 0n)!;
    expect(b.kind === "sell" && (/trailing/.test(b.reason) || /stop/.test(b.reason))).toBe(true);
  });

  it("sells on PumpSwap when the curve completes, or holds if configured", () => {
    const { rec, s } = setup();
    rec.curve = { ...rec.curve, complete: true, realTokenReserves: 0n };
    const a = evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 5000, 0n)!;
    expect(a.kind === "sell" && a.venue === "amm").toBe(true);
    expect(evaluateExit(s, rec, ctx, resolveParams({ exits: { migrationAction: "hold" } }), T + 5000, 0n)).toBeNull();
  });

  it("burns and closes a remainder worth less than the fee to sell it", () => {
    const { rec, s } = setup();
    const a = evaluateExit(s, rec, ctx, DEFAULT_PARAMS, T + 60_000, 10_000_000_000n)!;
    expect(a.kind).toBe("burnClose");
    applyExitFill(s, a, s.remainingTokens, 0n);
    expect(s.closed).toBe(true);
  });
});
