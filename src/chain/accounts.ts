/**
 * RPC reads of the accounts the math depends on. Global and FeeConfig are
 * read at startup and refreshed periodically, so a fee schedule change on
 * chain reaches the decisions within one refresh interval.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { pumpSdk } from "./sdk.js";
import { curveFromSdk, globalFromSdk, scheduleFromSdk, type DecodedCurve } from "./state.js";
import type { FeeSchedule, GlobalParams } from "../math/curve.js";

export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}

export interface ProtocolState {
  global: GlobalParams;
  schedule: FeeSchedule;
  fetchedAtMs: number;
}

export async function fetchProtocolState(conn: Connection): Promise<ProtocolState> {
  const [g, fc] = await Promise.all([
    conn.getAccountInfo(pumpSdk.GLOBAL_PDA, "confirmed"),
    conn.getAccountInfo(pumpSdk.PUMP_FEE_CONFIG_PDA, "confirmed"),
  ]);
  if (!g) throw new Error(`pump Global account not found at ${pumpSdk.GLOBAL_PDA.toBase58()}`);
  if (!fc) throw new Error(`pump FeeConfig account not found at ${pumpSdk.PUMP_FEE_CONFIG_PDA.toBase58()}`);
  return {
    global: globalFromSdk(pumpSdk.PUMP_SDK.decodeGlobal(g)),
    schedule: scheduleFromSdk(pumpSdk.PUMP_SDK.decodeFeeConfig(fc)),
    fetchedAtMs: Date.now(),
  };
}

export interface CurveRead extends DecodedCurve {
  slot: number;
  /** The curve's own token account balance (prices the pool-to-be on a crossing buy). */
  curveBaseTokenBalance: bigint;
  tokenProgram: PublicKey;
  mintSupply: bigint;
}

/** Read a curve, its token account and the mint at one consistent slot. */
export async function fetchCurve(conn: Connection, mint: PublicKey): Promise<CurveRead | null> {
  const curvePk = bondingCurvePda(mint);
  const mintInfo = await conn.getAccountInfo(mint, "confirmed");
  if (!mintInfo) return null;
  const tokenProgram = mintInfo.owner;
  const curveAta = PublicKey.findProgramAddressSync(
    [curvePk.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  )[0];
  const res = await conn.getMultipleAccountsInfoAndContext([curvePk, curveAta, mint], "confirmed");
  const [curveAcc, ataAcc, mintAcc] = res.value;
  if (!curveAcc || !mintAcc) return null;
  const decoded = curveFromSdk(pumpSdk.PUMP_SDK.decodeBondingCurve(curveAcc));
  // SPL token account: amount is a u64 at offset 64; mint supply is a u64 at offset 36
  const bal = ataAcc && ataAcc.data.length >= 72 ? ataAcc.data.readBigUInt64LE(64) : 0n;
  const supply = mintAcc.data.readBigUInt64LE(36);
  return { ...decoded, slot: res.context.slot, curveBaseTokenBalance: bal, tokenProgram, mintSupply: supply };
}

/** Rent for a Token-2022 ATA, read live (the protocol can change rent). */
export async function fetchAtaRent(conn: Connection, tokenAccountSize = 170): Promise<bigint> {
  return BigInt(await conn.getMinimumBalanceForRentExemption(tokenAccountSize, "confirmed"));
}
