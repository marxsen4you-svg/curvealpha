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
import { Connection, Keypair, PublicKey, type SignatureStatus } from "@solana/web3.js";
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
  /** Tokens of this mint the wallet actually holds, or null when that cannot be read right now (live only). */
  holdingsOf?(mint: string, tokenProgram: string): Promise<bigint | null>;
}

interface Holdings {
  sol: bigint;
  tokens: bigint;
  ataLamports: bigint;
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
    /** Called after every change to the paper cash, so a crash never loses a fill's effect on the ledger. */
    private onCash: (cash: bigint) => void = () => undefined,
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
    this.onCash(this.cash);
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
    this.onCash(this.cash);
    return { ok: true, lamports: net, tokens: o.tokens, curveFeesLamports: fees, networkLamports: network, tipLamports: o.tipLamports, rentLamports: rent, estimate };
  }

  async burnClose(_mint: string, _tp: string, tokens: bigint, tipLamports: bigint): Promise<Fill> {
    await this.clock.sleep(this.params().execution.paperLatencyMs);
    const network = this.network(20_000n);
    this.cash += this.ataRent() - network - tipLamports;
    this.onCash(this.cash);
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

  async holdingsOf(mint: string, tokenProgram: string): Promise<bigint | null> {
    const ata = userAta(this.user, new PublicKey(mint), new PublicKey(tokenProgram));
    try {
      const acc = await this.conn.getAccountInfo(ata, "confirmed");
      if (!acc) return 0n; // no token account: nothing held
      const r = await this.conn.getTokenAccountBalance(ata, "confirmed");
      return BigInt(r.value.amount);
    } catch {
      return null;
    }
  }

  /** What the wallet and the order's token account hold right now. */
  private async holdings(ata: PublicKey): Promise<Holdings> {
    const [sol, tokens, acc] = await Promise.all([
      this.conn.getBalance(this.user, "processed"),
      this.conn
        .getTokenAccountBalance(ata, "processed")
        .then((r) => BigInt(r.value.amount))
        .catch(() => 0n), // no token account yet
      this.conn.getAccountInfo(ata, "processed").catch(() => null),
    ]);
    return { sol: BigInt(sol), tokens, ataLamports: BigInt(acc?.lamports ?? 0) };
  }

  private async status(sig: string): Promise<SignatureStatus | null> {
    try {
      return (await this.conn.getSignatureStatuses([sig])).value[0] ?? null;
    } catch {
      return null; // a transient RPC error is not an answer; keep polling
    }
  }

  /**
   * Measure, assemble, sign, send as a bundle, and track the transaction
   * until it is settled one way or the other. The returned fill's lamports
   * are the SOL that left the wallet net of the network fee and the tip
   * (negative when SOL came in), rentLamports is the change in the token
   * account's lamports (rent deposited, or refunded when negative), and
   * tokens is the size of the token balance change.
   *
   * "Did not land" is only reported once the blockhash has expired, because
   * until then the transaction can still land. A confirmed transaction is
   * read from its own metadata; if the RPC has not indexed it, the fill is
   * reconciled from the balances and marked as an estimate.
   */
  private async submit(ixs: Awaited<ReturnType<typeof buyIxs>>, tipLamports: bigint, mint: PublicKey, tokenProgram: PublicKey): Promise<Fill> {
    const p = this.params().execution;
    const tipAccount = new PublicKey(await this.bundles.randomTipAccount());
    const all = [...ixs, tipIx(this.user, tipAccount, tipLamports)];
    const measured = await measureCompute(this.conn, this.user, all);
    if (measured.err) return fail(`simulation failed: ${JSON.stringify(measured.err)} ${measured.logs.slice(-3).join(" | ")}`);
    const cuLimit = cuLimitFor(measured.unitsConsumed, p.cuMarginPct);
    const cuPrice = BigInt(p.cuPriceMicroLamports);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const tx = assemble(this.user, blockhash, all, cuLimit, cuPrice);
    tx.sign([this.signer]);
    const sig58 = bs58.encode(tx.signatures[0]!);
    // what this transaction pays if it lands, exactly: one signature plus the priority fee on the requested limit
    const fee = BASE_FEE_PER_SIGNATURE + priorityFee(cuPrice, BigInt(cuLimit));
    const ata = userAta(this.user, mint, tokenProgram);
    const before = await this.holdings(ata);
    let sent: { bundleId?: string; route?: "bam" | "block-engine" } = {};
    let sendError: string | null = null;
    try {
      sent = await this.bundles.sendBundle([Buffer.from(tx.serialize()).toString("base64")], p.useBam);
    } catch (e) {
      // the block engine may have accepted it before the error: track it to expiry like any other
      sendError = e instanceof Error ? e.message : String(e);
    }
    const ctx = { signature: sig58, bundleId: sent.bundleId, route: sent.route, cuLimit };
    const deadline = this.clock.now() + p.bundleTimeoutMs;
    for (;;) {
      await this.clock.sleep(400);
      const s = await this.status(sig58);
      if (s?.err) return { ...fail(`landed with error ${JSON.stringify(s.err)}`), ...ctx };
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
        return this.settle(sig58, s.slot, before, ata, mint, fee, tipLamports, ctx);
      }
      if (this.clock.now() >= deadline) {
        const height = await this.conn.getBlockHeight("confirmed").catch(() => null);
        if (height !== null && height > lastValidBlockHeight) break;
      }
    }
    // the blockhash has expired, so the transaction can no longer land: one last look, then the balances decide
    const last = await this.status(sig58);
    if (last?.err) return { ...fail(`landed with error ${JSON.stringify(last.err)}`), ...ctx };
    if (last && (last.confirmationStatus === "confirmed" || last.confirmationStatus === "finalized")) {
      return this.settle(sig58, last.slot, before, ata, mint, fee, tipLamports, ctx);
    }
    const after = await this.holdings(ata);
    if (after.tokens !== before.tokens) return this.fromBalances(before, after, fee, tipLamports, ctx);
    const why = sent.bundleId ? `bundle ${sent.bundleId}` : `bundle not accepted: ${sendError ?? "unknown"}`;
    return { ...fail(`not landed: blockhash expired (${why})`), ...ctx };
  }

  /** Settle a confirmed transaction from its metadata, waiting a little for the RPC to index it. */
  private async settle(sig: string, slot: number, before: Holdings, ata: PublicKey, mint: PublicKey, fee: bigint, tip: bigint, ctx: Partial<Fill>): Promise<Fill> {
    for (let i = 0; i < 8; i++) {
      const t = await this.conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (t?.meta) {
        const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses }).staticAccountKeys;
        const u = keys.findIndex((k) => k.equals(this.user));
        const a = keys.findIndex((k) => k.equals(ata));
        if (u >= 0) {
          const tok = (list: Array<{ owner?: string; mint: string; uiTokenAmount: { amount: string } }> | null | undefined) =>
            BigInt(list?.find((b) => b.owner === this.user.toBase58() && b.mint === mint.toBase58())?.uiTokenAmount.amount ?? "0");
          const tokenDelta = tok(t.meta.postTokenBalances) - tok(t.meta.preTokenBalances);
          const actualFee = BigInt(t.meta.fee);
          return {
            ok: true,
            lamports: BigInt(t.meta.preBalances[u]!) - BigInt(t.meta.postBalances[u]!) - actualFee - tip,
            tokens: tokenDelta < 0n ? -tokenDelta : tokenDelta,
            curveFeesLamports: 0n,
            networkLamports: actualFee,
            tipLamports: tip,
            rentLamports: a >= 0 ? BigInt(t.meta.postBalances[a]!) - BigInt(t.meta.preBalances[a]!) : 0n,
            landedSlot: slot,
            ...ctx,
          };
        }
      }
      await this.clock.sleep(400);
    }
    return this.fromBalances(before, await this.holdings(ata), fee, tip, { ...ctx, landedSlot: slot });
  }

  /** A fill reconstructed from balance changes (the transaction itself could not be read). */
  private fromBalances(before: Holdings, after: Holdings, fee: bigint, tip: bigint, ctx: Partial<Fill>): Fill {
    const tokenDelta = after.tokens - before.tokens;
    return {
      ok: true,
      estimate: true,
      lamports: before.sol - after.sol - fee - tip,
      tokens: tokenDelta < 0n ? -tokenDelta : tokenDelta,
      curveFeesLamports: 0n,
      networkLamports: fee,
      tipLamports: tip,
      rentLamports: after.ataLamports - before.ataLamports,
      ...ctx,
    };
  }

  async buy(o: BuyOrder): Promise<Fill> {
    const mint = new PublicKey(o.mint);
    const tp = new PublicKey(o.tokenProgram);
    const f = await this.submit(await buyIxs(this.user, mint, tp, o.budgetLamports, o.minTokensOut), o.tipLamports, mint, tp);
    if (!f.ok) return f;
    // SOL out of the wallet includes the rent the token account took (none if it already existed)
    return { ...f, lamports: f.lamports - f.rentLamports };
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
    const f = await this.submit(ixs, o.tipLamports, mint, tp);
    if (!f.ok) return f;
    // a sell moves SOL into the wallet: flip the sign so lamports is proceeds, without the
    // rent refunded by closing the account (rentLamports is negative then)
    return { ...f, lamports: -f.lamports + f.rentLamports };
  }

  async burnClose(mintS: string, tokenProgram: string, tokens: bigint, tipLamports: bigint): Promise<Fill> {
    const mint = new PublicKey(mintS);
    const tp = new PublicKey(tokenProgram);
    const f = await this.submit(burnCloseIxs(this.user, mint, tp, tokens), tipLamports, mint, tp);
    return f.ok ? { ...f, lamports: 0n } : f;
  }
}
