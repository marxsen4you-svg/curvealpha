/**
 * Seeded generators for curve states, fee schedules and amounts, producing the
 * same case both as CurveAlpha bigint state and as @pump-fun/pump-sdk objects,
 * so the two implementations can be compared on identical inputs.
 */
import BN from "bn.js";
import { PublicKey, Keypair } from "@solana/web3.js";
import type { CurveState, FeeSchedule, FeeTier, GlobalParams } from "../../src/math/curve.js";

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform bigint in [lo, hi]. */
export function randBig(r: () => number, lo: bigint, hi: bigint): bigint {
  const span = hi - lo + 1n;
  let acc = 0n;
  for (let i = 0; i < 4; i++) acc = (acc << 32n) | BigInt(Math.floor(r() * 4294967296));
  return lo + (acc % span);
}

/** Log-uniform bigint in [lo, hi], lo >= 1. */
export function randLog(r: () => number, lo: bigint, hi: bigint): bigint {
  const a = Math.log(Number(lo));
  const b = Math.log(Number(hi));
  const v = BigInt(Math.floor(Math.exp(a + (b - a) * r())));
  return v < lo ? lo : v > hi ? hi : v;
}

export const MAINNET_GLOBAL: GlobalParams = {
  initialVirtualTokenReserves: 1_073_000_000_000_000n,
  initialVirtualSolReserves: 30_000_000_000n,
  initialRealTokenReserves: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  feeBasisPoints: 95n,
  creatorFeeBasisPoints: 30n,
  creatorFeeConfigurable: false,
  poolMigrationFee: 15_000_001n,
};

/**
 * SOL tier table of the live mainnet pump-amm (PumpSwap) FeeConfig captured
 * at slot 445186127 (2026-09-08), from pump.fun's own SDK test fixture. It is
 * the PumpSwap table, not the bonding curve's; tests use it as a realistic
 * many-tier table. The engine reads the live curve table at runtime.
 */
export const FIXTURE_TIERS: Array<[string, string, string, string]> = [
  ["0", "2", "93", "30"],
  ["420000000000", "20", "5", "95"],
  ["1470000000000", "20", "5", "90"],
  ["2460000000000", "20", "5", "85"],
  ["3440000000000", "20", "5", "80"],
  ["4420000000000", "20", "5", "75"],
  ["9820000000000", "20", "5", "70"],
  ["14740000000000", "20", "5", "65"],
  ["19650000000000", "20", "5", "60"],
  ["24560000000000", "20", "5", "55"],
  ["29470000000000", "20", "5", "50"],
  ["34380000000000", "20", "5", "45"],
  ["39300000000000", "20", "5", "40"],
  ["44210000000000", "20", "5", "35"],
  ["49120000000000", "20", "5", "30"],
  ["54030000000000", "20", "5", "28"],
  ["58940000000000", "20", "5", "25"],
  ["63860000000000", "20", "5", "23"],
  ["68770000000000", "20", "5", "20"],
  ["73681000000000", "20", "5", "18"],
  ["78590000000000", "20", "5", "15"],
  ["83500000000000", "20", "5", "13"],
  ["88400000000000", "20", "5", "10"],
  ["93330000000000", "20", "5", "8"],
  ["98240000000000", "20", "5", "5"],
];

/**
 * Bonding curve schedule as publicly reported in September 2026: 0.95 %
 * protocol + 0.30 % creator for every curve market cap. Paper-mode fallback
 * only when the live FeeConfig cannot be read.
 */
export function curveSchedule(): FeeSchedule {
  return {
    feeTiers: [{ marketCapLamportsThreshold: 0n, lpFeeBps: 0n, protocolFeeBps: 95n, creatorFeeBps: 30n }],
  };
}

export function fixtureSchedule(): FeeSchedule {
  return {
    feeTiers: FIXTURE_TIERS.map(([t, lp, p, c]) => ({
      marketCapLamportsThreshold: BigInt(t),
      lpFeeBps: BigInt(lp),
      protocolFeeBps: BigInt(p),
      creatorFeeBps: BigInt(c),
    })),
  };
}

/** Random tier table, thresholds chosen to straddle curve market caps. */
export function randomSchedule(r: () => number): FeeSchedule {
  const n = 1 + Math.floor(r() * 6);
  const tiers: FeeTier[] = [];
  let t = 0n;
  for (let i = 0; i < n; i++) {
    tiers.push({
      marketCapLamportsThreshold: t,
      lpFeeBps: randBig(r, 0n, 30n),
      protocolFeeBps: randBig(r, 0n, 200n),
      creatorFeeBps: randBig(r, 0n, 200n),
    });
    t += randLog(r, 1_000_000_000n, 300_000_000_000n);
  }
  return { feeTiers: tiers };
}

export interface Case {
  global: GlobalParams;
  schedule: FeeSchedule;
  curve: CurveState;
  mintSupply: bigint;
  curveBaseTokenBalance: bigint;
}

/** A curve state reachable by trading from the initial state. */
export function randomCase(r: () => number, opts: { fixture?: boolean } = {}): Case {
  const g: GlobalParams = {
    ...MAINNET_GLOBAL,
    creatorFeeConfigurable: r() < 0.3,
  };
  const k = g.initialVirtualTokenReserves * g.initialVirtualSolReserves;
  const reserved = g.initialVirtualTokenReserves - g.initialRealTokenReserves;
  // how many real tokens are already sold; bias toward the edges
  const u = r();
  const sold =
    u < 0.1
      ? randBig(r, 0n, 1_000_000_000n)
      : u < 0.2
        ? g.initialRealTokenReserves - randBig(r, 1n, 5_000_000_000_000n)
        : randBig(r, 0n, g.initialRealTokenReserves - 1n);
  const vT = g.initialVirtualTokenReserves - sold;
  const vS = k / vT + randBig(r, 0n, 50_000n); // rounding drift above k
  const curve: CurveState = {
    virtualTokenReserves: vT,
    virtualSolReserves: vS,
    realTokenReserves: vT - reserved,
    realSolReserves: vS - g.initialVirtualSolReserves,
    tokenTotalSupply: g.tokenTotalSupply,
    complete: false,
    hasCreator: r() < 0.9,
    isMayhemMode: r() < 0.1,
    isCashbackCoin: false,
    creatorFeeBps: r() < 0.3 ? randBig(r, 1n, 150n) : 0n,
  };
  const mintSupply = curve.isMayhemMode ? randBig(r, 900_000_000_000_000n, 2_000_000_000_000_000n) : g.tokenTotalSupply;
  return {
    global: g,
    schedule: opts.fixture ? fixtureSchedule() : randomSchedule(r),
    curve,
    mintSupply,
    // the curve's token account: remaining real supply plus the slice reserved for the pool
    curveBaseTokenBalance: curve.realTokenReserves + (g.tokenTotalSupply - g.initialRealTokenReserves),
  };
}

// ---------------------------------------------------------- SDK adapters

const bn = (x: bigint) => new BN(x.toString());
const someCreator = Keypair.generate().publicKey;

export function toSdkGlobal(g: GlobalParams): any {
  return {
    initialVirtualTokenReserves: bn(g.initialVirtualTokenReserves),
    initialVirtualSolReserves: bn(g.initialVirtualSolReserves),
    initialRealTokenReserves: bn(g.initialRealTokenReserves),
    tokenTotalSupply: bn(g.tokenTotalSupply),
    feeBasisPoints: bn(g.feeBasisPoints),
    creatorFeeBasisPoints: bn(g.creatorFeeBasisPoints),
    creatorFeeConfigurable: g.creatorFeeConfigurable,
    poolMigrationFee: bn(g.poolMigrationFee),
    whitelistedQuoteMints: [],
    initialVirtualQuoteReserves: bn(g.initialVirtualSolReserves),
    mayhemModeEnabled: false,
  };
}

export function toSdkFeeConfig(s: FeeSchedule): any {
  const zero = { lpFeeBps: new BN(0), protocolFeeBps: new BN(0), creatorFeeBps: new BN(0) };
  return {
    admin: PublicKey.default,
    flatFees: zero,
    feeTiers: s.feeTiers.map((t) => ({
      marketCapLamportsThreshold: bn(t.marketCapLamportsThreshold),
      fees: { lpFeeBps: bn(t.lpFeeBps), protocolFeeBps: bn(t.protocolFeeBps), creatorFeeBps: bn(t.creatorFeeBps) },
    })),
    stableFeeTiers: [],
    exoticFlatFees: zero,
  };
}

export function toSdkCurve(c: CurveState): any {
  return {
    virtualTokenReserves: bn(c.virtualTokenReserves),
    virtualQuoteReserves: bn(c.virtualSolReserves),
    realTokenReserves: bn(c.realTokenReserves),
    realQuoteReserves: bn(c.realSolReserves),
    tokenTotalSupply: bn(c.tokenTotalSupply),
    complete: c.complete,
    creator: c.hasCreator ? someCreator : PublicKey.default,
    isMayhemMode: c.isMayhemMode,
    isCashbackCoin: c.isCashbackCoin,
    quoteMint: PublicKey.default,
    creatorFeeBps: bn(c.creatorFeeBps),
    canEditCreatorFee: false,
    isHolderReward: false,
    creatorFee: new BN(0),
    protocolFees: new BN(0),
    depth: 0,
    initialVirtualQuoteReserves: bn(30_000_000_000n),
    postCompleteBaseOut: new BN(0),
    postCompleteQuoteIn: new BN(0),
  };
}

export const big = (x: { toString(): string }) => BigInt(x.toString());
