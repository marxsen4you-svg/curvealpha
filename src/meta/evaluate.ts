/**
 * Offline evaluation over the shadow ledger and the trade history.
 *
 *   - factor attribution: does each factor actually rank outcomes?
 *   - weight search: coordinate ascent on the factor weights, fitted on the
 *     older 70 % of outcomes and judged on the newer 30 % (never on the data
 *     it was fitted to); suggested only when the held-out result improves
 *   - threshold sweep: what each Alpha threshold would have selected
 *   - Kelly fraction backtest: sequential bankroll paths for several fractions
 *   - ladder comparison on the recorded shadow paths
 *   - realized P&L attribution of closed positions to factors
 *
 * Leakage controls. Outcomes are ordered by when they were opened, but an
 * outcome is only known once it has closed:
 *   - the train/test split is purged: a training outcome still open when the
 *     test period begins, or whose mint also appears in the test period (a
 *     mint is scored at up to four horizons), is dropped from training;
 *   - the Kelly path sizes each simulated entry only from outcomes that had
 *     closed before that entry was opened.
 * Uncertainty. One mint contributes up to four correlated rows, so intervals
 * treat the mint as the unit: the Spearman interval uses the Bonett-Wright
 * standard error with n = number of mints, and mean multiples are
 * bootstrapped by resampling mints.
 *
 * Nothing here changes live parameters by itself. The CLI prints a
 * suggestion; applying it is an explicit operator action that goes through
 * the audited parameter path.
 */
import type { Params } from "../config/params.js";
import type { Store } from "../store/db.js";
import { FACTORS, type FactorName } from "../score/alpha.js";
import { kellyStake, mulberry32, quantile, type Outcome } from "../risk/kelly.js";

interface ShadowRow {
  id: number;
  mint: string;
  opened_ms: number;
  closed_ms: number;
  horizon_s: number;
  score: number;
  multiple: number;
  sell_tx_count: number;
  factors: string;
  path: string | null;
}

interface Sample {
  t: number;
  closed: number;
  mint: string;
  horizon: number;
  values: Partial<Record<FactorName, number | null>>;
  multiple: number;
  sells: number;
  path: Array<[number, number]>;
}

export type Interval = [number, number];

export interface EvaluationReport {
  samples: number;
  windowDays: number;
  baseline: { meanMultiple: number; hitRate2x: number; medianMultiple: number; clusters: number };
  attribution: Array<{
    factor: FactorName;
    coverage: number;
    spearman: number | null;
    /** 95 % interval, mints as the unit (Bonett-Wright). */
    spearmanCi: Interval | null;
    topTercileMean: number | null;
    bottomTercileMean: number | null;
  }>;
  weights: {
    current: Params["scoring"]["weights"];
    suggested: Params["scoring"]["weights"] | null;
    trainScore: number;
    testScoreCurrent: number;
    testScoreSuggested: number | null;
    metric: string;
    trainSamples: number;
    testSamples: number;
    /** Training outcomes dropped because they overlap the test period in time or by mint. */
    purged: number;
  };
  thresholds: Array<{
    threshold: number;
    selected: number;
    meanMultiple: number | null;
    /** 95 % bootstrap interval of the mean multiple, resampling mints. */
    meanMultipleCi: Interval | null;
    hitRate2x: number | null;
    growthPerTrade: number | null;
  }>;
  kelly: Array<{ fraction: number; finalBankrollSol: number; maxDrawdownPct: number; trades: number }>;
  ladders: Array<{ name: string; levels: number[]; fractions: number[]; meanMultiple: number }>;
  pnlAttribution: Array<{ factor: FactorName; pnlSol: number }>;
}

/** The evaluation only reads; anything that can run these two queries will do. */
export type ReadableStore = Pick<Store, "all" | "get">;

function load(store: ReadableStore, sinceMs: number): Sample[] {
  const rows = store.all<ShadowRow>(
    "SELECT id, mint, opened_ms, closed_ms, horizon_s, score, multiple, sell_tx_count, factors, path FROM shadows WHERE closed_ms IS NOT NULL AND opened_ms >= ? ORDER BY opened_ms, id",
    sinceMs,
  );
  return rows.map((r) => {
    let values: Sample["values"] = {};
    try {
      values = JSON.parse(r.factors).values ?? {};
    } catch {
      values = {};
    }
    let path: Array<[number, number]> = [];
    try {
      path = r.path ? JSON.parse(r.path) : [];
    } catch {
      path = [];
    }
    return { t: r.opened_ms, closed: r.closed_ms, mint: r.mint, horizon: r.horizon_s, values, multiple: r.multiple, sells: r.sell_tx_count, path };
  });
}

function rank(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

export function spearman(a: number[], b: number[]): number | null {
  if (a.length < 10) return null;
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n;
  const mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/** 95 % interval for a Spearman correlation (Bonett and Wright, 2000), with n the number of independent units. */
export function spearmanInterval(r: number, n: number): Interval | null {
  if (n < 10 || Math.abs(r) >= 1) return null;
  const se = Math.sqrt((1 + (r * r) / 2) / (n - 3));
  const z = Math.atanh(r);
  return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];
}

/** 95 % bootstrap interval of the mean of `xs`, resampling whole clusters (mints). */
function clusterMeanInterval(xs: number[], clusters: string[], resamples = 200, seed = 0x5eed): Interval | null {
  const sum = new Map<string, { s: number; n: number }>();
  for (let i = 0; i < xs.length; i++) {
    const c = sum.get(clusters[i]!) ?? { s: 0, n: 0 };
    c.s += xs[i]!;
    c.n++;
    sum.set(clusters[i]!, c);
  }
  const groups = [...sum.values()];
  if (groups.length < 10) return null;
  const r = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[Math.floor(r() * groups.length)]!;
      s += g.s;
      n += g.n;
    }
    means.push(s / n);
  }
  return [quantile(means, 0.025), quantile(means, 0.975)];
}

/** Factor values as typed columns (NaN = unavailable) so the weight search can rescore quickly. */
interface Columns {
  n: number;
  cols: Record<FactorName, Float64Array>;
  net: Float64Array;
}

function columns(samples: Sample[], fixedFrac: number, cap: number): Columns {
  const n = samples.length;
  const cols = Object.fromEntries(FACTORS.map((f) => [f, new Float64Array(n)])) as Record<FactorName, Float64Array>;
  const net = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    for (const f of FACTORS) {
      const v = s.values[f];
      cols[f][i] = v === null || v === undefined ? NaN : v;
    }
    net[i] = Math.min(s.multiple, cap) - fixedFrac * (1 + s.sells);
  }
  return { n, cols, net };
}

function scoreWith(values: Sample["values"], w: Params["scoring"]["weights"]): number | null {
  let acc = 0;
  let avail = 0;
  let total = 0;
  for (const f of FACTORS) {
    total += w[f];
    const v = values[f];
    if (v === null || v === undefined || w[f] === 0) continue;
    acc += w[f] * v;
    avail += w[f];
  }
  if (avail === 0 || avail / total < 0.5) return null;
  return (100 * acc) / avail;
}

/** Mean net multiple (fixed costs as a fraction of a nominal stake) of the top quintile by score. */
function selectionMetric(c: Columns, w: Params["scoring"]["weights"]): number {
  const total = FACTORS.reduce((a, f) => a + w[f], 0);
  const scored: Array<[number, number]> = [];
  for (let i = 0; i < c.n; i++) {
    let acc = 0;
    let avail = 0;
    for (const f of FACTORS) {
      const v = c.cols[f][i]!;
      if (Number.isNaN(v) || w[f] === 0) continue;
      acc += w[f] * v;
      avail += w[f];
    }
    if (avail === 0 || avail / total < 0.5) continue;
    scored.push([(100 * acc) / avail, c.net[i]!]);
  }
  if (scored.length < 20) return -Infinity;
  scored.sort((a, b) => b[0] - a[0]);
  const top = Math.max(10, Math.floor(scored.length / 5));
  let s = 0;
  for (let i = 0; i < top; i++) s += scored[i]![1];
  return s / top;
}

function ladderOnPath(path: Array<[number, number]>, levels: number[], fractions: number[], stop: number, final: number): number {
  // proceeds per unit stake when following a ladder on a recorded remainder-multiple path
  let remaining = 1;
  let proceeds = 0;
  let rung = 0;
  for (const [, m] of path) {
    if (m <= 1 - stop) {
      proceeds += remaining * m;
      return proceeds;
    }
    while (rung < levels.length && m >= levels[rung]!) {
      const sell = Math.min(remaining, fractions[rung]!);
      proceeds += sell * m;
      remaining -= sell;
      rung++;
    }
  }
  return proceeds + remaining * final;
}

/** Recompute the path's Kelly stake after this many newly closed outcomes (and size from the latest window). */
const KELLY_PATH_RECOMPUTE_EVERY = 10;
const KELLY_PATH_WINDOW = 800;

export function evaluate(store: ReadableStore, p: Params, nowMs: number, windowDays = 14, tipLamports = 100_000): EvaluationReport {
  const samples = load(store, nowMs - windowDays * 86_400_000);
  const cap = p.risk.outcomeMultipleCap;
  const nominal = p.scoring.shadowNominalSol * 1e9;
  const fixedFrac = (5_000 + 200 + tipLamports) / nominal;
  const mult = samples.map((s) => Math.min(s.multiple, cap));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const clusters = new Set(samples.map((s) => s.mint)).size;

  const attribution = FACTORS.map((f) => {
    const with_ = samples.filter((s) => typeof s.values[f] === "number");
    const pairs = with_.map((s) => [s.values[f] as number, Math.log(Math.max(1e-6, Math.min(s.multiple, cap)))] as const);
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
    const third = Math.floor(sorted.length / 3);
    const rho = spearman(pairs.map((x) => x[0]), pairs.map((x) => x[1]));
    return {
      factor: f,
      coverage: samples.length ? pairs.length / samples.length : 0,
      spearman: rho,
      spearmanCi: rho === null ? null : spearmanInterval(rho, new Set(with_.map((s) => s.mint)).size),
      topTercileMean: third >= 5 ? mean(sorted.slice(-third).map((x) => Math.exp(x[1]))) : null,
      bottomTercileMean: third >= 5 ? mean(sorted.slice(0, third).map((x) => Math.exp(x[1]))) : null,
    };
  });

  // time split: fit on the older 70 %, judge on the newer 30 %, purged of anything that overlaps the test period
  const cut = Math.floor(samples.length * 0.7);
  const test = samples.slice(cut);
  const testStart = test[0]?.t ?? Infinity;
  const testMints = new Set(test.map((s) => s.mint));
  const before = samples.slice(0, cut);
  const train = before.filter((s) => s.closed <= testStart && !testMints.has(s.mint));
  const trainC = columns(train, fixedFrac, cap);
  const testC = columns(test, fixedFrac, cap);
  const current = p.scoring.weights;
  let best = { ...current };
  let bestTrain = selectionMetric(trainC, best);
  for (let round = 0; round < 4; round++) {
    for (const f of FACTORS) {
      for (const scale of [0, 0.5, 0.75, 1.25, 1.5, 2]) {
        const cand = { ...best, [f]: Math.round(best[f] * scale * 1000) / 1000 || (scale === 0 ? 0 : 0.01) };
        const m = selectionMetric(trainC, cand);
        if (m > bestTrain + 1e-9) {
          bestTrain = m;
          best = cand;
        }
      }
    }
  }
  const testCurrent = selectionMetric(testC, current);
  const testBest = selectionMetric(testC, best);
  const improved = Number.isFinite(testBest) && testBest > testCurrent;

  const scores = samples.map((s) => scoreWith(s.values, current));
  const thresholds = [];
  for (let th = 40; th <= 95; th += 5) {
    const sel = samples.filter((_, i) => scores[i] !== null && scores[i]! >= th);
    const outs: Outcome[] = sel.map((s) => ({ multiple: s.multiple, sellTxCount: s.sells }));
    const stake =
      outs.length >= 20
        ? kellyStake({ outcomes: outs, bankrollLamports: 2e9, entryFixedLamports: 5_200 + tipLamports, exitFixedLamportsPerTx: 5_200 + tipLamports, maxStakeLamports: 0.5e9, multipleCap: cap })
        : null;
    let growth: number | null = null;
    if (stake !== null && stake > 0) {
      growth = mean(outs.map((o) => Math.log(1 + (stake * (Math.min(o.multiple, cap) - 1) - (5_200 + tipLamports) * (1 + o.sellTxCount)) / 2e9)));
    }
    const selMult = sel.map((s) => Math.min(s.multiple, cap));
    thresholds.push({
      threshold: th,
      selected: sel.length,
      meanMultiple: sel.length ? mean(selMult) : null,
      meanMultipleCi: sel.length >= 20 ? clusterMeanInterval(selMult, sel.map((s) => s.mint)) : null,
      hitRate2x: sel.length ? sel.filter((s) => s.multiple >= 2).length / sel.length : null,
      growthPerTrade: growth,
    });
  }

  // sequential bankroll paths over the samples the current threshold selects; each entry is sized only
  // from outcomes that had closed by the time it was opened
  const th = p.scoring.baseAlphaThreshold;
  const chosen = samples.filter((_, i) => (scores[i] ?? -1) >= th);
  const byClose = [...chosen].sort((a, b) => a.closed - b.closed);
  const kelly = [0.25, 0.5, 0.75].map((fraction) => {
    let bank = 1e9;
    let peak = bank;
    let maxDd = 0;
    const known: Outcome[] = [];
    let next = 0;
    let sizedAt = -Infinity;
    let stakeFrac = 0;
    for (const s of chosen) {
      while (next < byClose.length && byClose[next]!.closed <= s.t) {
        known.push({ multiple: byClose[next]!.multiple, sellTxCount: byClose[next]!.sells });
        next++;
      }
      if (known.length < p.risk.minOutcomeSamples) continue;
      if (known.length - sizedAt >= KELLY_PATH_RECOMPUTE_EVERY) {
        const k = kellyStake({ outcomes: known.slice(-KELLY_PATH_WINDOW), bankrollLamports: bank, entryFixedLamports: 5_200 + tipLamports, exitFixedLamportsPerTx: 5_200 + tipLamports, maxStakeLamports: bank * 0.25, multipleCap: cap });
        stakeFrac = k / bank;
        sizedAt = known.length;
      }
      const stake = Math.min(stakeFrac * bank * fraction, (p.risk.maxRiskPerTradePct * bank) / p.risk.lossGivenAdverse);
      if (stake > 0) {
        bank += stake * (Math.min(s.multiple, cap) - 1) - (5_200 + tipLamports) * (1 + s.sells);
        peak = Math.max(peak, bank);
        maxDd = Math.max(maxDd, 1 - bank / peak);
      }
    }
    return { fraction, finalBankrollSol: bank / 1e9, maxDrawdownPct: maxDd * 100, trades: chosen.length };
  });

  const presets: Array<[string, number[], number[]]> = [
    ["current", p.exits.tpLevels, p.exits.tpFractions],
    ["early recovery", [1.4, 2, 3.5, 7], [0.4, 0.3, 0.15, 0.1]],
    ["tail heavy", [2, 4, 10, 25], [0.25, 0.25, 0.25, 0.15]],
    ["single exit 2x", [2], [1]],
  ];
  const withPath = samples.filter((s) => s.path.length > 1);
  const ladders = presets.map(([name, levels, fractions]) => ({
    name,
    levels,
    fractions,
    meanMultiple: mean(withPath.map((s) => ladderOnPath(s.path, levels, fractions, p.exits.stopLossPct, s.path[s.path.length - 1]![1]))),
  }));

  // realized P&L of closed positions, split by each factor's share of the entry score
  const pos = store.all<{ proceeds_lamports: number; stake_lamports: number; fixed_cost_lamports: number; decision_id: number | null }>(
    "SELECT proceeds_lamports, stake_lamports, fixed_cost_lamports, decision_id FROM positions WHERE status = 'closed' AND closed_ms >= ?",
    nowMs - windowDays * 86_400_000,
  );
  const pnlBy = new Map<FactorName, number>(FACTORS.map((f) => [f, 0]));
  for (const r of pos) {
    const pnl = (r.proceeds_lamports - r.stake_lamports - r.fixed_cost_lamports) / 1e9;
    const d = r.decision_id ? store.get<{ payload: string }>("SELECT payload FROM decisions WHERE id = ?", r.decision_id) : undefined;
    const contrib: Partial<Record<FactorName, number>> = d ? (JSON.parse(d.payload).alpha?.contributions ?? {}) : {};
    const total = Object.values(contrib).reduce((a, b) => a + (b ?? 0), 0);
    if (total <= 0) continue;
    for (const f of FACTORS) pnlBy.set(f, pnlBy.get(f)! + (pnl * (contrib[f] ?? 0)) / total);
  }

  return {
    samples: samples.length,
    windowDays,
    baseline: {
      meanMultiple: mean(mult),
      hitRate2x: samples.length ? samples.filter((s) => s.multiple >= 2).length / samples.length : 0,
      medianMultiple: quantile(mult, 0.5),
      clusters,
    },
    attribution,
    weights: {
      current,
      suggested: improved ? best : null,
      trainScore: bestTrain,
      testScoreCurrent: testCurrent,
      testScoreSuggested: improved ? testBest : null,
      metric: "mean net multiple of the top score quintile, fixed costs at the nominal shadow stake",
      trainSamples: train.length,
      testSamples: test.length,
      purged: before.length - train.length,
    },
    thresholds,
    kelly,
    ladders,
    pnlAttribution: FACTORS.map((f) => ({ factor: f, pnlSol: pnlBy.get(f)! })),
  };
}
