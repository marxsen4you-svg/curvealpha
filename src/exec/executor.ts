/**
 * Executors. Paper and live share one interface and one decision pipeline;
 * only the fill source differs.
 *
 * Paper fills are exact, not approximate: after the configured latency the
 * order is filled against the curve state the live stream reports at that
 * moment, with the same integer math the program uses, and every fixed cost
 * (base fee, priority fee, the tip the live path would have paid) is charged
 * to the paper ledger. Paper mode therefore measures the strategy, not an
 * idealized version of it.
 */
import BN from "bn.js";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";
import { pumpSwapSdk } from "../chain/sdk.js";
import type { Params } from "../config/params.js";
import type { TokenRecord } from "../ingest/tokens.js";
import { simulateSell, simulateV3Buy, type FeeSchedule, type GlobalParams } from "../math/curve.js";
import { BASE_FEE_PER_SIGNATURE, priorityFee } from "../risk/costs.js";
import type { Clock } from "../util/clock.js";
import { ammSellQuote, poolAtMigration } from "./amm.js";
import type { BundleClient } from "./jito.js";
import { assemble, burnCloseIxs, buyIxs, cuLimitFor, measureCompute, pumpSdk, sellIxs, tipIx, userAta } from "./tx.js";

export interface MarketCtx {
  global: GlobalParams;
  schedule: FeeSchedule;
  ammSchedule: FeeSchedule;
  /** Live record lookup: the executor reads the curve at fill time, not at order time. */
  token: (mint: string) => TokenRecord | undefined;
}

export interface BuyOrder {
  mint: string;
  tokenProgram: string;
  budgetLamports: bigint;
  /** Minimum tokens accepted, from the exact quote less slippage. */
  minTokensOut: bigint;
  tipLamports: bigint;
}

export interface SellOrder {
  mint: string;
  tokenProgram: string;
  tokens: bigint;
  minSolOut: bigint;
  tipLamports: bigint;
  venue: "curve" | "amm";
  closeAccount: boolean;
}

export interface Fill {
  ok: boolean;
  error?: string;
  /** Lamports spent on the curve (buy) or received net of curve fees (sell). */
  lamports: bigint;
  tokens: bigint;
  curveFeesLamports: bigint;
  networkLamports: bigint;
  tipLamports: bigint;
  /** Rent locked (buy, positive) or refunded (closing sell, negative). */
  rentLamports: bigint;
  signature?: string;
  bundleId?: string;
  route?: string;
  landedSlot?: number;
  estimate?: boolean;
  cuLimit?: number;
}

export interface Executor {
  readonly mode: "paper" | "live";
  buy(o: BuyOrder): Promise<Fill>;
  sell(o: SellOrder): Promise<Fill>;
  burnClose(mint: string, tokenProgram: string, tokens: bigint, tipLamports: bigint): Promise<Fill>;
  spendableLamports(): Promise<bigint>;
}

const fail = (error: string): Fill => ({
  ok: false,
  error,
  lamports: 0n,
  tokens: 0n,
  curveFeesLamports: 0n,
  networkLamports: 0n,
  tipLamports: 0n,
  rentLamports: 0n,
});

// ------------------------------------------------------------------ paper

export class PaperExecutor implements Executor {
  readonly mode = "paper" as const;
  cash: bigint;

  constructor(
    private m: MarketCtx,
    private params: () => Params,
    private clock: Clock,
    startingLamports: bigint,
    private ataRent: () => bigint,
  ) {
    this.cash = startingLamports;
  }

  private network(cuLimit: bigint): bigint {
    return BASE_FEE_PER_SIGNATURE + priorityFee(BigInt(this.params().execution.cuPriceMicroLamports), cuLimit);
  }

  async spendableLamports(): Promise<bigint> {
    return this.cash;
  }

  async buy(o: BuyOrder): Promise<Fill> {
    await this.clock.sleep(this.params().execution.paperLatencyMs);
    const rec = this.m.token(o.mint);
    if (!rec) return fail("token no longer tracked");
    const need = o.budgetLamports + o.tipLamports + this.network(BigInt(this.params().execution.paperBuyCuLimit)) + this.ataRent();
    if (need > this.cash) return fail("insufficient paper cash");
    const sim = simulateV3Buy(this.m.global, this.m.schedule, rec.curve.tokenTotalSupply, rec.curve, o.budgetLamports);
    if (!sim) return fail("buy would cross the curve or the curve is complete");
    if (sim.tokens < o.minTokensOut) return fail(`slippage: ${sim.tokens} tokens < minimum ${o.minTokensOut}`);
    const network = this.network(BigInt(this.params().execution.paperBuyCuLimit));
    const spent = sim.netSol + sim.fees;
    this.cash -= spent + network + o.tipLamports + this.ataRent();
    return {
      ok: true,
      lamports: spent,
      tokens: sim.tokens,
      curveFeesLamports: sim.fees,
      networkLamports: network,
      tipLamports: o.tipLamports,
      rentLamports: this.ataRent(),
    };
  }

  async sell(o: SellOrder): Promise<Fill> {
    await this.clock.sleep(this.params().execution.paperLatencyMs);
    const rec = this.m.token(o.mint);
    if (!rec) return fail("token no longer tracked");
    const network = this.network(BigInt(this.params().execution.paperSellCuLimit));
    const rent = o.closeAccount ? -this.ataRent() : 0n;
    let net: bigint;
    let fees = 0n;
    let estimate = false;
    if (rec.curve.complete || o.venue === "amm") {
      const reserved = this.m.global.tokenTotalSupply - this.m.global.initialRealTokenReserves;
      net = ammSellQuote(poolAtMigration(this.m.global, rec.curve, reserved), o.tokens, this.m.ammSchedule, rec.curve.tokenTotalSupply);
      estimate = true;
    } else {
      const s = simulateSell(this.m.global, this.m.schedule, rec.curve.tokenTotalSupply, rec.curve, o.tokens);
      net = s.netSol;
      fees = s.fees;
    }
    if (net < o.minSolOut) return fail(`slippage: ${net} lamports < minimum ${o.minSolOut}`);
    this.cash += net - network - o.tipLamports - rent;
    return { ok: true, lamports: net, tokens: o.tokens, curveFeesLamports: fees, networkLamports: network, tipLamports: o.tipLamports, rentLamports: rent, estimate };
  }

  async burnClose(_mint: string, _tp: string, tokens: bigint, tipLamports: bigint): Promise<Fill> {
    await this.clock.sleep(this.params().execution.paperLatencyMs);
    const network = this.network(20_000n);
    this.cash += this.ataRent() - network - tipLamports;
    return { ok: true, lamports: 0n, tokens, curveFeesLamports: 0n, networkLamports: network, tipLamports, rentLamports: -this.ataRent() };
  }
}

// ------------------------------------------------------------------- live

export class LiveExecutor implements Executor {
  readonly mode = "live" as const;

  constructor(
    private conn: Connection,
    private signer: Keypair,
    private bundles: BundleClient,
    private params: () => Params,
    private clock: Clock,
  ) {}

  private get user(): PublicKey {
    return this.signer.publicKey;
  }

  async spendableLamports(): Promise<bigint> {
    return BigInt(await this.conn.getBalance(this.user, "confirmed"));
  }

  /** Measure, assemble, sign, send as a bundle, wait for landing, read the real deltas. */
  private async submit(
    ixs: Awaited<ReturnType<typeof buyIxs>>,
    tipLamports: bigint,
    mint: PublicKey,
  ): Promise<Fill> {
    const p = this.params().execution;
    const tipAccount = new PublicKey(await this.bundles.randomTipAccount());
    const all = [...ixs, tipIx(this.user, tipAccount, tipLamports)];
    const measured = await measureCompute(this.conn, this.user, all);
    if (measured.err) return fail(`simulation failed: ${JSON.stringify(measured.err)} ${measured.logs.slice(-3).join(" | ")}`);
    const cuLimit = cuLimitFor(measured.unitsConsumed, p.cuMarginPct);
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const tx = assemble(this.user, blockhash, all, cuLimit, BigInt(p.cuPriceMicroLamports));
    tx.sign([this.signer]);
    const sig58 = bs58.encode(tx.signatures[0]!);
    const preSol = BigInt(await this.conn.getBalance(this.user, "processed"));
    const { bundleId, route } = await this.bundles.sendBundle([Buffer.from(tx.serialize()).toString("base64")], p.useBam);
    const deadline = this.clock.now() + p.bundleTimeoutMs;
    while (this.clock.now() < deadline) {
      await this.clock.sleep(400);
      const st = await this.conn.getSignatureStatuses([sig58]);
      const s = st.value[0];
      if (s?.err) return { ...fail(`landed with error ${JSON.stringify(s.err)}`), signature: sig58, bundleId, route };
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
        const t = await this.conn.getTransaction(sig58, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        const keys = t?.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses }).staticAccountKeys ?? [];
        const idx = keys.findIndex((k) => k.equals(this.user));
        const pre = BigInt(t?.meta?.preBalances[idx] ?? Number(preSol));
        const post = BigInt(t?.meta?.postBalances[idx] ?? 0);
        const tok = (list: Array<{ owner?: string; mint: string; uiTokenAmount: { amount: string } }> | null | undefined) =>
          BigInt(list?.find((b) => b.owner === this.user.toBase58() && b.mint === mint.toBase58())?.uiTokenAmount.amount ?? "0");
        const tokenDelta = tok(t?.meta?.postTokenBalances) - tok(t?.meta?.preTokenBalances);
        const fee = BigInt(t?.meta?.fee ?? 0);
        return {
          ok: true,
          // signed SOL delta of the wallet excluding the network fee and the tip
          lamports: pre - post - fee - tipLamports,
          tokens: tokenDelta < 0n ? -tokenDelta : tokenDelta,
          curveFeesLamports: 0n,
          networkLamports: fee,
          tipLamports,
          rentLamports: 0n,
          signature: sig58,
          bundleId,
          route,
          landedSlot: s.slot,
          cuLimit,
        };
      }
    }
    const inflight = await this.bundles.inflightStatus(bundleId).catch(() => ({ status: "Unknown" as const, landedSlot: null }));
    return { ...fail(`bundle not confirmed in ${p.bundleTimeoutMs} ms (status ${inflight.status})`), bundleId, route };
  }

  async buy(o: BuyOrder): Promise<Fill> {
    const mint = new PublicKey(o.mint);
    const tp = new PublicKey(o.tokenProgram);
    const f = await this.submit(await buyIxs(this.user, mint, tp, o.budgetLamports, o.minTokensOut), o.tipLamports, mint);
    if (!f.ok) return f;
    // lamports above is SOL out of the wallet net of fee and tip; split off the ATA rent it includes
    const rent = BigInt(await this.conn.getMinimumBalanceForRentExemption(170));
    return { ...f, lamports: f.lamports - rent, rentLamports: rent };
  }

  async sell(o: SellOrder): Promise<Fill> {
    const mint = new PublicKey(o.mint);
    const tp = new PublicKey(o.tokenProgram);
    let ixs;
    if (o.venue === "amm") {
      // graduated: quote and build against the live pool with the official PumpSwap SDK
      const pool = pumpSdk.canonicalPumpPoolPda(mint);
      const state = await new pumpSwapSdk.OnlinePumpAmmSdk(this.conn).swapSolanaState(pool, this.user);
      const slippagePct = this.params().execution.slippageBps / 100;
      ixs = await pumpSwapSdk.PUMP_AMM_SDK.sellBaseInput(state, new BN(o.tokens.toString()), slippagePct);
      if (o.closeAccount) ixs.push(createCloseAccountInstruction(userAta(this.user, mint, tp), this.user, this.user, [], tp));
    } else {
      ixs = await sellIxs(this.user, mint, tp, o.tokens, o.minSolOut, o.closeAccount);
    }
    const f = await this.submit(ixs, o.tipLamports, mint);
    if (!f.ok) return f;
    // a sell moves SOL into the wallet: flip the sign so lamports is proceeds,
    // and split off the rent refund when the account was closed
    const rent = o.closeAccount ? BigInt(await this.conn.getMinimumBalanceForRentExemption(170)) : 0n;
    return { ...f, lamports: -f.lamports - rent, rentLamports: -rent };
  }

  async burnClose(mintS: string, tokenProgram: string, tokens: bigint, tipLamports: bigint): Promise<Fill> {
    const mint = new PublicKey(mintS);
    const tp = new PublicKey(tokenProgram);
    const f = await this.submit(burnCloseIxs(this.user, mint, tp, tokens), tipLamports, mint);
    return f.ok ? { ...f, lamports: 0n, rentLamports: f.lamports } : f;
  }
}
