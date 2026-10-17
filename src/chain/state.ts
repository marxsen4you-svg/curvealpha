/**
 * Adapters from the official SDK's decoded accounts (BN, PublicKey) to the
 * plain bigint structures the exact math uses. Decoding itself is done by the
 * SDK's IDL coder, which handles every account layout version the program
 * has written (a BondingCurve can be 49 to 166 bytes).
 */
import { PublicKey } from "@solana/web3.js";
import type { CurveState, FeeSchedule, GlobalParams } from "../math/curve.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sdk = any;

const b = (x: { toString(): string } | null | undefined): bigint => BigInt(x ? x.toString() : "0");

export function globalFromSdk(g: Sdk): GlobalParams {
  return {
    initialVirtualTokenReserves: b(g.initialVirtualTokenReserves),
    initialVirtualSolReserves: b(g.initialVirtualSolReserves),
    initialRealTokenReserves: b(g.initialRealTokenReserves),
    tokenTotalSupply: b(g.tokenTotalSupply),
    feeBasisPoints: b(g.feeBasisPoints),
    creatorFeeBasisPoints: b(g.creatorFeeBasisPoints),
    creatorFeeConfigurable: Boolean(g.creatorFeeConfigurable),
    poolMigrationFee: b(g.poolMigrationFee),
  };
}

export function scheduleFromSdk(fc: Sdk): FeeSchedule {
  return {
    feeTiers: (fc.feeTiers as Sdk[]).map((t) => ({
      marketCapLamportsThreshold: b(t.marketCapLamportsThreshold),
      lpFeeBps: b(t.fees.lpFeeBps),
      protocolFeeBps: b(t.fees.protocolFeeBps),
      creatorFeeBps: b(t.fees.creatorFeeBps),
    })),
  };
}

export interface DecodedCurve {
  state: CurveState;
  creator: string;
  /** True only for SOL-quoted curves; CurveAlpha trades nothing else. */
  quoteIsSol: boolean;
}

export function curveFromSdk(c: Sdk): DecodedCurve {
  const creator: PublicKey = c.creator;
  const quote: PublicKey = c.quoteMint ?? PublicKey.default;
  return {
    state: {
      virtualTokenReserves: b(c.virtualTokenReserves),
      virtualSolReserves: b(c.virtualQuoteReserves ?? c.virtualSolReserves),
      realTokenReserves: b(c.realTokenReserves),
      realSolReserves: b(c.realQuoteReserves ?? c.realSolReserves),
      tokenTotalSupply: b(c.tokenTotalSupply),
      complete: Boolean(c.complete),
      hasCreator: !creator.equals(PublicKey.default),
      isMayhemMode: Boolean(c.isMayhemMode),
      isCashbackCoin: Boolean(c.isCashbackCoin),
      creatorFeeBps: b(c.creatorFeeBps),
    },
    creator: creator.toBase58(),
    quoteIsSol: quote.equals(PublicKey.default) || quote.toBase58() === "So11111111111111111111111111111111111111112",
  };
}
