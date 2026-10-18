/**
 * In-memory book of every live token: its exact curve state (taken from the
 * reserves each TradeEvent reports after the trade, so no reconstruction
 * error accumulates), its trade tape, holder balances, the creator's
 * position, and per-wallet cost basis for realized P&L.
 */
import type { CreateEvt, TradeEvt } from "../chain/events.js";
import type { CurveState } from "../math/curve.js";

export interface TradeLite {
  slot: number;
  seq: number;
  tMs: number;
  user: string;
  isBuy: boolean;
  sol: bigint;
  tokens: bigint;
  vS: bigint;
  vT: bigint;
  rS: bigint;
  preBal: bigint | null;
}

export interface TokenRecord {
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  tokenProgram: string;
  createdSlot: number;
  createdAtMs: number;
  isMayhem: boolean;
  isCashback: boolean;
  quoteIsSol: boolean;
  curve: CurveState;
  lastSlot: number;
  lastSeq: number;
  completedAtMs: number | null;
  trades: TradeLite[];
  holders: Map<string, bigint>;
  /** wallet -> tokens held and lamports paid for them (net of sells, pro rata) */
  basis: Map<string, { tokens: bigint; cost: bigint }>;
  creatorBoughtTokens: bigint;
  creatorSoldTokens: bigint;
  creatorFirstSellMs: number | null;
  /** Creator bought in the creation slot. */
  creatorSelfBuy: boolean;
  peakVsol: bigint;
  peakAtMs: number;
  /** A dropped or retracted event touched this mint: never score it. */
  gap: boolean;
  tainted: boolean;
  scoredHorizons: Set<number>;
}

export interface RealizedPnl {
  wallet: string;
  mint: string;
  pnlLamports: bigint;
  tMs: number;
}

const MAX_TRADES = 6000;

export class TokenBook {
  readonly tokens = new Map<string, TokenRecord>();
  private slotIndex = new Map<number, Set<string>>();

  constructor(private onRealized: (r: RealizedPnl) => void = () => undefined) {}

  get(mint: string): TokenRecord | undefined {
    return this.tokens.get(mint);
  }

  onCreate(e: CreateEvt): TokenRecord | null {
    if (this.tokens.has(e.mint)) return this.tokens.get(e.mint)!;
    const rec: TokenRecord = {
      mint: e.mint,
      creator: e.creator,
      name: e.name,
      symbol: e.symbol,
      uri: e.uri,
      tokenProgram: e.tokenProgram,
      createdSlot: e.slot,
      createdAtMs: e.receivedAtMs,
      isMayhem: e.isMayhemMode,
      isCashback: e.isCashbackEnabled,
      quoteIsSol: e.quoteIsSol,
      curve: {
        virtualTokenReserves: e.virtualTokenReserves,
        virtualSolReserves: e.virtualSolReserves,
        realTokenReserves: e.realTokenReserves,
        realSolReserves: 0n,
        tokenTotalSupply: e.tokenTotalSupply,
        complete: false,
        hasCreator: e.creator !== "11111111111111111111111111111111",
        isMayhemMode: e.isMayhemMode,
        isCashbackCoin: e.isCashbackEnabled,
        creatorFeeBps: e.creatorFeeBps,
      },
      lastSlot: e.slot,
      lastSeq: -1,
      completedAtMs: null,
      trades: [],
      holders: new Map(),
      basis: new Map(),
      creatorBoughtTokens: 0n,
      creatorSoldTokens: 0n,
      creatorFirstSellMs: null,
      creatorSelfBuy: false,
      peakVsol: e.virtualSolReserves,
      peakAtMs: e.receivedAtMs,
      gap: false,
      tainted: false,
      scoredHorizons: new Set(),
    };
    this.tokens.set(e.mint, rec);
    this.index(e.slot, e.mint);
    return rec;
  }

  /** Apply a trade; returns the record, or null for a mint created before we started watching. */
  onTrade(e: TradeEvt): TokenRecord | null {
    const rec = this.tokens.get(e.mint);
    if (!rec) return null;
    const t: TradeLite = {
      slot: e.slot,
      seq: e.seq,
      tMs: e.receivedAtMs,
      user: e.user,
      isBuy: e.isBuy,
      sol: e.solAmount,
      tokens: e.tokenAmount,
      vS: e.virtualSolReserves,
      vT: e.virtualTokenReserves,
      rS: e.realSolReserves,
      preBal: e.userPreBalance,
    };
    if (rec.trades.length < MAX_TRADES) rec.trades.push(t);
    this.index(e.slot, e.mint);

    // the newest event by (slot, seq) defines the curve
    if (e.slot > rec.lastSlot || (e.slot === rec.lastSlot && e.seq > rec.lastSeq)) {
      rec.lastSlot = e.slot;
      rec.lastSeq = e.seq;
      rec.curve = {
        ...rec.curve,
        virtualSolReserves: e.virtualSolReserves,
        virtualTokenReserves: e.virtualTokenReserves,
        realSolReserves: e.realSolReserves,
        realTokenReserves: e.realTokenReserves,
        complete: e.realTokenReserves === 0n,
      };
      if (rec.curve.complete && rec.completedAtMs === null) rec.completedAtMs = e.receivedAtMs;
    }
    if (e.virtualSolReserves > rec.peakVsol) {
      rec.peakVsol = e.virtualSolReserves;
      rec.peakAtMs = e.receivedAtMs;
    }

    const held = rec.holders.get(e.user) ?? 0n;
    const b = rec.basis.get(e.user) ?? { tokens: 0n, cost: 0n };
    if (e.isBuy) {
      rec.holders.set(e.user, held + e.tokenAmount);
      // trader's lamports out = curve SOL plus fees
      b.tokens += e.tokenAmount;
      b.cost += e.solAmount + e.fee + e.creatorFee;
      rec.basis.set(e.user, b);
      if (e.user === rec.creator) {
        rec.creatorBoughtTokens += e.tokenAmount;
        if (e.slot === rec.createdSlot) rec.creatorSelfBuy = true;
      }
    } else {
      rec.holders.set(e.user, held > e.tokenAmount ? held - e.tokenAmount : 0n);
      if (b.tokens > 0n) {
        const sold = e.tokenAmount > b.tokens ? b.tokens : e.tokenAmount;
        const costPart = (b.cost * sold) / b.tokens;
        const proceeds = e.solAmount - e.fee - e.creatorFee;
        b.tokens -= sold;
        b.cost -= costPart;
        rec.basis.set(e.user, b);
        this.onRealized({ wallet: e.user, mint: e.mint, pnlLamports: proceeds - costPart, tMs: e.receivedAtMs });
      }
      if (e.user === rec.creator) {
        rec.creatorSoldTokens += e.tokenAmount;
        if (rec.creatorFirstSellMs === null) rec.creatorFirstSellMs = e.receivedAtMs;
      }
    }
    return rec;
  }

  /**
   * Rebuild a record for a mint we hold but whose creation we did not see in
   * this process (after a restart), from a chain read of its curve at `slot`.
   * Its history is unknown, so it is marked as having a gap: it is managed
   * (exits, valuation) but never scored or archived. A baseline tape entry
   * well in the past makes inflow-rate exits measure flow since adoption
   * instead of seeing the whole curve arrive at once.
   */
  adopt(a: { mint: string; curve: CurveState; creator: string; tokenProgram: string; symbol: string; slot: number }, nowMs: number): TokenRecord {
    const existing = this.tokens.get(a.mint);
    if (existing) return existing;
    const rec: TokenRecord = {
      mint: a.mint,
      creator: a.creator,
      name: "",
      symbol: a.symbol,
      uri: "",
      tokenProgram: a.tokenProgram,
      createdSlot: a.slot,
      createdAtMs: nowMs,
      isMayhem: a.curve.isMayhemMode,
      isCashback: a.curve.isCashbackCoin,
      quoteIsSol: true,
      curve: { ...a.curve },
      lastSlot: a.slot,
      // the read reflects the end of its slot: later events in the same slot are older than it
      lastSeq: Number.MAX_SAFE_INTEGER,
      completedAtMs: a.curve.complete ? nowMs : null,
      trades: [
        {
          slot: a.slot,
          seq: -1,
          tMs: nowMs - 3_600_000,
          user: "",
          isBuy: false,
          sol: 0n,
          tokens: 0n,
          vS: a.curve.virtualSolReserves,
          vT: a.curve.virtualTokenReserves,
          rS: a.curve.realSolReserves,
          preBal: null,
        },
      ],
      holders: new Map(),
      basis: new Map(),
      creatorBoughtTokens: 0n,
      creatorSoldTokens: 0n,
      creatorFirstSellMs: null,
      creatorSelfBuy: false,
      peakVsol: a.curve.virtualSolReserves,
      peakAtMs: nowMs,
      gap: true,
      tainted: false,
      scoredHorizons: new Set(),
    };
    this.tokens.set(a.mint, rec);
    return rec;
  }

  markComplete(mint: string, atMs: number): void {
    const rec = this.tokens.get(mint);
    if (rec && rec.completedAtMs === null) rec.completedAtMs = atMs;
  }

  /** A fork dropped this slot: every token with an event in it is tainted. */
  onDeadSlot(slot: number): string[] {
    const mints = [...(this.slotIndex.get(slot) ?? [])];
    for (const m of mints) {
      const rec = this.tokens.get(m);
      if (rec) rec.tainted = true;
    }
    this.slotIndex.delete(slot);
    return mints;
  }

  markGap(mint: string): void {
    const rec = this.tokens.get(mint);
    if (rec) rec.gap = true;
  }

  /** Every mint active since a slot is marked as having a gap. */
  markGapSince(slot: number): void {
    for (const rec of this.tokens.values()) if (rec.lastSlot >= slot || rec.createdSlot >= slot) rec.gap = true;
  }

  onConfirmedSlot(slot: number): void {
    // anything confirmed can no longer be forked away
    for (const s of this.slotIndex.keys()) if (s <= slot) this.slotIndex.delete(s);
  }

  evict(mint: string): TokenRecord | undefined {
    const rec = this.tokens.get(mint);
    this.tokens.delete(mint);
    return rec;
  }

  private index(slot: number, mint: string): void {
    let s = this.slotIndex.get(slot);
    if (!s) this.slotIndex.set(slot, (s = new Set()));
    s.add(mint);
  }

  /** Creator's current token balance (bought minus sold, never negative). */
  static creatorHeld(rec: TokenRecord): bigint {
    const net = rec.creatorBoughtTokens - rec.creatorSoldTokens;
    return net > 0n ? net : 0n;
  }
}
