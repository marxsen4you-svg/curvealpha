/**
 * Transaction construction.
 *
 * Pump instructions come from the official SDK's IDL builders (account lists
 * included), so the account layout is the program's own. CurveAlpha supplies
 * the amounts, computed with its exact math, and wraps them with:
 *   - an idempotent ATA create on buys (Token-2022 by default),
 *   - a close of the ATA on the final sell (refunds the rent),
 *   - compute budget instructions with a limit measured by simulation,
 *   - the Jito tip transfer to a randomly chosen tip account.
 */
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { pumpSdk } from "../chain/sdk.js";

const bn = (x: bigint) => new BN(x.toString());
export const MAX_CU = 1_400_000;

export function userAta(user: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
}

export async function buyIxs(
  user: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  budgetLamports: bigint,
  minTokensOut: bigint,
): Promise<TransactionInstruction[]> {
  const ata = userAta(user, mint, tokenProgram);
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint, tokenProgram),
    await pumpSdk.PUMP_SDK.getBuyExactQuoteInV3InstructionRaw({
      user,
      mint,
      spendableQuoteIn: bn(budgetLamports),
      minTokensOut: bn(minTokensOut < 1n ? 1n : minTokensOut),
      tokenProgram,
      quoteMint: PublicKey.default,
    }),
  ];
}

export async function sellIxs(
  user: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  tokens: bigint,
  minSolOut: bigint,
  closeAta: boolean,
): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [
    await pumpSdk.PUMP_SDK.getSellV3InstructionRaw({
      user,
      mint,
      amount: bn(tokens),
      quoteAmount: bn(minSolOut < 0n ? 0n : minSolOut),
      tokenProgram,
      quoteMint: PublicKey.default,
    }),
  ];
  if (closeAta) ixs.push(createCloseAccountInstruction(userAta(user, mint, tokenProgram), user, user, [], tokenProgram));
  return ixs;
}

/** Burn a worthless remainder and close the account to recover its rent. */
export function burnCloseIxs(user: PublicKey, mint: PublicKey, tokenProgram: PublicKey, tokens: bigint): TransactionInstruction[] {
  const ata = userAta(user, mint, tokenProgram);
  const out: TransactionInstruction[] = [];
  if (tokens > 0n) out.push(createBurnInstruction(ata, mint, user, tokens, [], tokenProgram));
  out.push(createCloseAccountInstruction(ata, user, user, [], tokenProgram));
  return out;
}

export function tipIx(user: PublicKey, tipAccount: PublicKey, lamports: bigint): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: user, toPubkey: tipAccount, lamports });
}

export function assemble(
  payer: PublicKey,
  blockhash: string,
  ixs: TransactionInstruction[],
  cuLimit: number,
  cuPriceMicroLamports: bigint,
): VersionedTransaction {
  const budget = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ...(cuPriceMicroLamports > 0n
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports })]
      : []),
  ];
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...budget, ...ixs] }).compileToV0Message();
  return new VersionedTransaction(msg);
}

/** Measured compute plus a margin, never above the 1.4 M hard cap. */
export function cuLimitFor(consumed: number, marginPct: number): number {
  // integer arithmetic: 100 000 * 1.12 in floating point is 112 000.00000000001
  const bps = Math.round(marginPct * 10_000);
  return Math.min(MAX_CU, consumed + Math.floor((consumed * bps + 9_999) / 10_000));
}

/**
 * Simulate at the hard cap to measure what the instructions consume. The
 * priority fee is charged on the requested limit, so requesting the measured
 * amount plus a margin (not 1.4 M) is what keeps the fee exact.
 */
export async function measureCompute(
  conn: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[],
): Promise<{ unitsConsumed: number; err: unknown; logs: string[] }> {
  const { blockhash } = await conn.getLatestBlockhash("processed");
  const tx = assemble(payer, blockhash, ixs, MAX_CU, 0n);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
  return { unitsConsumed: sim.value.unitsConsumed ?? 0, err: sim.value.err, logs: sim.value.logs ?? [] };
}

export { pumpSdk };
