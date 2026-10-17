/**
 * Slow-moving knowledge the scorer reads: creator histories, ranked wallets,
 * the historical trajectory corpus, wallet funding sources, recent launch
 * names and (optionally) X mention counts. All of it is built from the
 * engine's own observations and stored locally; nothing is imputed.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import type { Store } from "../store/db.js";
import type { TokenRecord } from "../ingest/tokens.js";
import type { RealizedPnl } from "../ingest/tokens.js";
import { CHECKPOINTS, CHECKPOINT_SEC, logInflow, priceAt, realSolAt, type CorpusEntry, type CreatorStats, type SocialReading } from "./factors.js";

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// ------------------------------------------------------------- creators

export class CreatorHistory {
  private cache = new Map<string, { at: number; stats: CreatorStats }>();
  constructor(private store: Store) {}

  stats(creator: string, nowMs: number): CreatorStats {
    const c = this.cache.get(creator);
    if (c && nowMs - c.at < 60_000) return c.stats;
    const rows = this.store.all<{ graduated: number; time_to_peak_s: number | null; creator_first_sell_s: number | null; creator_self_buy: number }>(
      "SELECT graduated, time_to_peak_s, creator_first_sell_s, creator_self_buy FROM token_archive WHERE creator = ? ORDER BY created_ms DESC LIMIT 500",
      creator,
    );
    const stats: CreatorStats = {
      launches: rows.length,
      graduations: rows.filter((r) => r.graduated).length,
      medianTimeToPeakSec: median(rows.map((r) => r.time_to_peak_s).filter((x): x is number => x !== null)),
      medianFirstSellSec: median(rows.map((r) => r.creator_first_sell_s).filter((x): x is number => x !== null)),
      selfBuyRate: rows.length ? rows.filter((r) => r.creator_self_buy).length / rows.length : 0,
    };
    this.cache.set(creator, { at: nowMs, stats });
    return stats;
  }
}

// --------------------------------------------------------- smart money

export class SmartMoney {
  private pending = new Map<string, { trades: number; pnl: bigint; wins: number; losses: number }>();
  top = new Map<string, number>();
  private lastRank = 0;

  constructor(private store: Store) {}

  onRealized(r: RealizedPnl): void {
    const p = this.pending.get(r.wallet) ?? { trades: 0, pnl: 0n, wins: 0, losses: 0 };
    p.trades++;
    p.pnl += r.pnlLamports;
    if (r.pnlLamports > 0n) p.wins++;
    else p.losses++;
    this.pending.set(r.wallet, p);
  }

  flush(nowMs: number): void {
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    this.store.defer(() => {
      for (const [w, p] of batch) {
        this.store.run(
          `INSERT INTO wallets(wallet, trades, pnl_lamports, wins, losses, updated_ms) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(wallet) DO UPDATE SET trades = trades + excluded.trades, pnl_lamports = pnl_lamports + excluded.pnl_lamports,
           wins = wins + excluded.wins, losses = losses + excluded.losses, updated_ms = excluded.updated_ms`,
          w,
          p.trades,
          p.pnl,
          p.wins,
          p.losses,
          nowMs,
        );
      }
    });
  }

  /** Rank wallets by realized P&L per trade, shrunk toward zero (prior of 5 trades). */
  rank(minTrades: number, topK: number, nowMs: number): void {
    if (nowMs - this.lastRank < 60_000 && this.top.size > 0) return;
    this.lastRank = nowMs;
    const rows = this.store.all<{ wallet: string }>(
      "SELECT wallet FROM wallets WHERE trades >= ? AND pnl_lamports > 0 ORDER BY (CAST(pnl_lamports AS REAL) / (trades + 5)) DESC LIMIT ?",
      minTrades,
      topK,
    );
    this.top = new Map(rows.map((r, i) => [r.wallet, i]));
  }
}

// --------------------------------------------------------------- corpus

export class Corpus {
  entries: CorpusEntry[] = [];
  constructor(private store: Store, private maxEntries = 60_000) {}

  load(sinceMs: number): void {
    const rows = this.store.all<{ mint: string; created_ms: number; inflow: string; price: string; max_after: string; graduated: number }>(
      "SELECT mint, created_ms, inflow, price, max_after, graduated FROM corpus WHERE created_ms >= ? ORDER BY created_ms DESC LIMIT ?",
      sinceMs,
      this.maxEntries,
    );
    this.entries = rows.map((r) => ({
      mint: r.mint,
      createdMs: r.created_ms,
      inflow: JSON.parse(r.inflow),
      price: JSON.parse(r.price),
      maxAfter: JSON.parse(r.max_after),
      graduated: Boolean(r.graduated),
    }));
    // precompute the log paths so scoring never pays for it
    for (const e of this.entries) logInflow(e);
  }

  /** Turn a finished token into a corpus entry and an archive row. */
  archive(rec: TokenRecord, nowMs: number): void {
    const n = Math.min(CHECKPOINTS, Math.floor((Math.min(nowMs, rec.createdAtMs + CHECKPOINTS * CHECKPOINT_SEC * 1000) - rec.createdAtMs) / 1000 / CHECKPOINT_SEC));
    const inflow: number[] = [];
    const price: number[] = [];
    for (let i = 1; i <= n; i++) {
      const t = rec.createdAtMs + i * CHECKPOINT_SEC * 1000;
      inflow.push(realSolAt(rec, t));
      price.push(priceAt(rec, t));
    }
    // highest price after each checkpoint, from the full tape
    const maxAfter = price.map((_, i) => {
      const t = rec.createdAtMs + (i + 1) * CHECKPOINT_SEC * 1000;
      let m = price[i]!;
      for (const tr of rec.trades) if (tr.tMs > t) m = Math.max(m, Number(tr.vS) / Number(tr.vT));
      return m;
    });
    const graduated = rec.completedAtMs !== null;
    const peak = Number(rec.peakVsol) / 30e9;
    const buyers = new Set(rec.trades.filter((t) => t.isBuy).map((t) => t.user)).size;
    const entry: CorpusEntry = { mint: rec.mint, createdMs: rec.createdAtMs, inflow, price, maxAfter, graduated };
    if (n >= 2) {
      logInflow(entry);
      this.entries.unshift(entry);
      if (this.entries.length > this.maxEntries) this.entries.pop();
    }
    this.store.defer(() => {
      if (n >= 2) {
        this.store.run(
          "INSERT OR REPLACE INTO corpus(mint, created_ms, inflow, price, max_after, graduated) VALUES (?, ?, ?, ?, ?, ?)",
          rec.mint,
          rec.createdAtMs,
          JSON.stringify(inflow),
          JSON.stringify(price),
          JSON.stringify(maxAfter),
          graduated ? 1 : 0,
        );
      }
      this.store.run(
        `INSERT OR REPLACE INTO token_archive(mint, creator, symbol, name, created_ms, completed_ms, graduated, peak_multiple,
         time_to_peak_s, creator_first_sell_s, creator_self_buy, trades, unique_buyers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rec.mint,
        rec.creator,
        rec.symbol,
        rec.name,
        rec.createdAtMs,
        rec.completedAtMs,
        graduated ? 1 : 0,
        peak * peak, // price scales with vS squared on a constant product curve
        (rec.peakAtMs - rec.createdAtMs) / 1000,
        rec.creatorFirstSellMs === null ? null : (rec.creatorFirstSellMs - rec.createdAtMs) / 1000,
        rec.creatorSelfBuy ? 1 : 0,
        rec.trades.length,
        buyers,
      );
    });
  }
}

// -------------------------------------------------------------- funding

/**
 * Resolves who funded a wallet: the first SOL sender in its oldest visible
 * transaction. Lookups run in the background as soon as a wallet appears
 * among a token's first buyers, under a concurrency cap, and are cached in
 * the database. A wallet with a long history resolves to null (established,
 * not a fresh sybil). Unresolved wallets are simply absent from the map.
 */
export class FundingResolver {
  readonly known = new Map<string, string | null>();
  private inflight = new Set<string>();
  private queue: string[] = [];
  private active = 0;

  constructor(private conn: Connection | null, private store: Store, private concurrency = 4) {
    for (const r of store.all<{ wallet: string; funder: string | null }>("SELECT wallet, funder FROM funders ORDER BY fetched_ms DESC LIMIT 200000")) {
      this.known.set(r.wallet, r.funder);
    }
  }

  request(wallet: string): void {
    if (!this.conn || this.known.has(wallet) || this.inflight.has(wallet)) return;
    this.inflight.add(wallet);
    this.queue.push(wallet);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const w = this.queue.shift()!;
      this.active++;
      void this.resolve(w)
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          this.inflight.delete(w);
          this.pump();
        });
    }
  }

  private async resolve(wallet: string): Promise<void> {
    const conn = this.conn!;
    const pk = new PublicKey(wallet);
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 25 }, "confirmed");
    let funder: string | null = null;
    if (sigs.length < 25 && sigs.length > 0) {
      const oldest = sigs[sigs.length - 1]!.signature;
      const tx = await conn.getTransaction(oldest, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx?.meta) {
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
        const all = [...keys.staticAccountKeys, ...(keys.accountKeysFromLookups?.writable ?? []), ...(keys.accountKeysFromLookups?.readonly ?? [])];
        let best = -1;
        let drop = 0;
        for (let i = 0; i < all.length; i++) {
          if (all[i]!.equals(pk)) continue;
          const d = (tx.meta.preBalances[i] ?? 0) - (tx.meta.postBalances[i] ?? 0);
          if (d > drop) {
            drop = d;
            best = i;
          }
        }
        funder = best >= 0 ? all[best]!.toBase58() : null;
      }
    }
    this.known.set(wallet, funder);
    const now = Date.now();
    this.store.defer(() => this.store.run("INSERT OR REPLACE INTO funders(wallet, funder, fetched_ms) VALUES (?, ?, ?)", wallet, funder, now));
  }
}

// ---------------------------------------------------------------- names

export class RecentNames {
  private ring: Array<{ at: number; name: string }> = [];
  add(name: string, at: number): void {
    this.ring.push({ at, name });
    if (this.ring.length > 20_000) this.ring.splice(0, this.ring.length - 20_000);
  }
  since(at: number, exclude: string): string[] {
    return this.ring.filter((r) => r.at >= at && r.name !== exclude).map((r) => r.name);
  }
}

// ------------------------------------------------------------------- X

/**
 * Mention counts for a mint address from the X API v2 recent counts
 * endpoint. Requires an X API bearer token on a tier that includes counts.
 * Without one the social factor runs on name novelty alone and says so.
 */
export class XMentions {
  private cache = new Map<string, { at: number; r: SocialReading | null }>();
  constructor(private bearer: string | undefined, private fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    return Boolean(this.bearer);
  }

  async reading(mint: string, windowSec: number, nowMs: number): Promise<SocialReading | null> {
    if (!this.bearer) return null;
    const c = this.cache.get(mint);
    if (c && nowMs - c.at < 20_000) return c.r;
    const start = new Date(nowMs - 2 * windowSec * 1000 - 60_000).toISOString();
    const url = `https://api.x.com/2/tweets/counts/recent?query=${encodeURIComponent(mint)}&granularity=minute&start_time=${start}`;
    let r: SocialReading | null = null;
    try {
      const res = await this.fetchFn(url, { headers: { authorization: `Bearer ${this.bearer}` }, signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ end: string; tweet_count: number }> };
        const cut = nowMs - windowSec * 1000;
        let now = 0;
        let prev = 0;
        for (const d of body.data ?? []) {
          if (Date.parse(d.end) > cut) now += d.tweet_count;
          else prev += d.tweet_count;
        }
        r = { mentions: now, mentionsPrevWindow: prev };
      }
    } catch {
      r = null;
    }
    this.cache.set(mint, { at: nowMs, r });
    return r;
  }
}
