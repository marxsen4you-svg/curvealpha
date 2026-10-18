/**
 * Adaptive Jito tipping.
 *
 * The oracle polls Jito's landed-tip percentiles (25/50/75/95/99 and the
 * EMA of the 50th). A tip is chosen at the configured percentile, floored at
 * the 1 000 lamport protocol minimum, and capped by the Survival Engine's tip
 * budget (the ceiling share of the residual edge). If the market tip exceeds
 * the budget the trade is refused: paying more than the edge to get filled
 * turns a positive trade into a negative one.
 */

export type TipKey = "p25" | "p50" | "p75" | "p95" | "p99" | "ema50";
export type TipFloor = Record<TipKey, bigint> & { atMs: number };

export const TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";

const toLamports = (solFloat: unknown): bigint => {
  const n = Number(solFloat);
  if (!Number.isFinite(n) || n < 0) return 0n;
  // round up to the next lamport: under-tipping by a rounding error loses the auction
  return BigInt(Math.ceil(n * 1e9));
};

export function parseTipFloor(body: unknown, nowMs: number): TipFloor | null {
  const row = Array.isArray(body) ? body[0] : null;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  return {
    p25: toLamports(r.landed_tips_25th_percentile),
    p50: toLamports(r.landed_tips_50th_percentile),
    p75: toLamports(r.landed_tips_75th_percentile),
    p95: toLamports(r.landed_tips_95th_percentile),
    p99: toLamports(r.landed_tips_99th_percentile),
    ema50: toLamports(r.ema_landed_tips_50th_percentile),
    atMs: nowMs,
  };
}

export interface TipChoice {
  tipLamports: bigint;
  percentile: TipKey;
  market: bigint;
  budget: bigint | null;
  refused: boolean;
  reason: string;
}

export function chooseTip(floor: TipFloor | null, key: TipKey, minTip: bigint, budget: bigint | null): TipChoice {
  if (!floor) {
    return { tipLamports: 0n, percentile: key, market: 0n, budget, refused: true, reason: "no tip floor data" };
  }
  const market = floor[key] > minTip ? floor[key] : minTip;
  if (budget !== null && market > budget) {
    return { tipLamports: 0n, percentile: key, market, budget, refused: true, reason: `market tip ${market} exceeds the edge budget ${budget}` };
  }
  return { tipLamports: market, percentile: key, market, budget, refused: false, reason: "ok" };
}

export class TipOracle {
  floor: TipFloor | null = null;
  history: TipFloor[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private url = TIP_FLOOR_URL,
    private fetchFn: typeof fetch = fetch,
    private onUpdate: (f: TipFloor) => void = () => undefined,
    private now: () => number = Date.now,
  ) {}

  async refresh(): Promise<TipFloor | null> {
    try {
      const res = await this.fetchFn(this.url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return this.floor;
      const f = parseTipFloor(await res.json(), this.now());
      if (f) {
        this.floor = f;
        this.history.push(f);
        if (this.history.length > 720) this.history.shift();
        this.onUpdate(f);
      }
    } catch {
      /* keep the last floor; staleness is visible on the dashboard */
    }
    return this.floor;
  }

  start(intervalMs = 10_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Tip floor older than this is not trusted for a live trade. */
  isStale(nowMs: number, maxAgeMs = 60_000): boolean {
    return !this.floor || nowMs - this.floor.atMs > maxAgeMs;
  }
}
