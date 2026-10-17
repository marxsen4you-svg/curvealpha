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
 * Nothing here changes live parameters by itself. The CLI prints a
 * suggestion; applying it is an explicit operator action that goes through
 * the audited parameter path.
 */
import type { Params } from "../config/params.js";
import type { Store } from "../store/db.js";
import { FACTORS, type FactorName } from "../score/alpha.js";
import { kellyStake, quantile, type Outcome } from "../risk/kelly.js";

interface ShadowRow {
  id: number;
  opened_ms: number;
  horizon_s: number;
  score: number;
  multiple: number;
  sell_tx_count: number;
  factors: string;
  path: string | null;
}

interface Sample {
  t: number;
  horizon: number;
  values: Partial<Record<FactorName, number | null>>;
  multiple: number;
  sells: number;
  path: Array<[number, number]>;
}

export interface EvaluationReport {
  samples: number;
  windowDays: number;
  baseline: { meanMultiple: number; hitRate2x: number; medianMultiple: number };
  attribution: Array<{ factor: FactorName; coverage: number; spearman: number | null; topTercileMean: number | null; bottomTercileMean: number | null }>;
  weights: { current: Params["scoring"]["weights"]; suggested: Params["scoring"]["weights"] | null; trainScore: number; testScoreCurrent: number; testScoreSuggested: number | null; metric: string };
  thresholds: Array<{ threshold: number; selected: number; meanMultiple: number | null; hitRate2x: number | null; growthPerTrade: number | null }>;
  kelly: Array<{ fraction: number; finalBankrollSol: number; maxDrawdownPct: number; trades: number }>;
  ladders: Array<{ name: string; levels: number[]; fractions: number[]; meanMultiple: number }>;
  pnlAttribution: Array<{ factor: FactorName; pnlSol: number }>;
}

function load(store: Store, sinceMs: number): Sample[] {
  const rows = store.all<ShadowRow>(
    "SELECT id, opened_ms, horizon_s, score, multiple, sell_tx_count, factors, path FROM shadows WHERE closed_ms IS NOT NULL AND opened_ms >= ? ORDER BY opened_ms",
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
    return { t: r.opened_ms, horizon: r.horizon_s, values, multiple: r.multiple, sells: r.sell_tx_count, path };
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
function selectionMetric(samples: Sample[], w: Params["scoring"]["weights"], fixedFrac: number, cap: number): number {
  const scored = samples.map((s) => [scoreWith(s.values, w), s] as const).filter((x): x is readonly [number, Sample] => x[0] !== null);
  if (scored.length < 20) return -Infinity;
  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, Math.max(10, Math.floor(scored.length / 5)));
  return top.reduce((a, [, s]) => a + Math.min(s.multiple, cap) - fixedFrac * (1 + s.sells), 0) / top.length;
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

export function evaluate(store: Store, p: Params, nowMs: number, windowDays = 14, tipLamports = 100_000): EvaluationReport {
  const samples = load(store, nowMs - windowDays * 86_400_000);
  const cap = p.risk.outcomeMultipleCap;
  const nominal = p.scoring.shadowNominalSol * 1e9;
  const fixedFrac = (5_000 + 200 + tipLamports) / nominal;
  const mult = samples.map((s) => Math.min(s.multiple, cap));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

  const attribution = FACTORS.map((f) => {
    const pairs = samples.filter((s) => typeof s.values[f] === "number").map((s) => [s.values[f] as number, Math.log(Math.max(1e-6, Math.min(s.multiple, cap)))] as const);
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
    const third = Math.floor(sorted.length / 3);
    return {
      factor: f,
      coverage: samples.length ? pairs.length / samples.length : 0,
      spearman: spearman(pairs.map((x) => x[0]), pairs.map((x) => x[1])),
      topTercileMean: third >= 5 ? mean(sorted.slice(-third).map((x) => Math.exp(x[1]))) : null,
      bottomTercileMean: third >= 5 ? mean(sorted.slice(0, third).map((x) => Math.exp(x[1]))) : null,
    };
  });

  // time split: fit on the older 70 %, judge on the newer 30 %
  const cut = Math.floor(samples.length * 0.7);
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);
  const current = p.scoring.weights;
  let best = { ...current };
  let bestTrain = selectionMetric(train, best, fixedFrac, cap);
  for (let round = 0; round < 4; round++) {
    for (const f of FACTORS) {
      for (const scale of [0, 0.5, 0.75, 1.25, 1.5, 2]) {
        const cand = { ...best, [f]: Math.round(best[f] * scale * 1000) / 1000 || (scale === 0 ? 0 : 0.01) };
        const m = selectionMetric(train, cand, fixedFrac, cap);
        if (m > bestTrain + 1e-9) {
          bestTrain = m;
          best = cand;
        }
      }
    }
  }
  const testCurrent = selectionMetric(test, current, fixedFrac, cap);
  const testBest = selectionMetric(test, best, fixedFrac, cap);
  const improved = Number.isFinite(testBest) && testBest > testCurrent;

  const thresholds = [];
  for (let th = 40; th <= 95; th += 5) {
    const sel = samples.filter((s) => {
      const sc = scoreWith(s.values, current);
      return sc !== null && sc >= th;
    });
    const outs: Outcome[] = sel.map((s) => ({ multiple: s.multiple, sellTxCount: s.sells }));
    const stake =
      outs.length >= 20
        ? kellyStake({ outcomes: outs, bankrollLamports: 2e9, entryFixedLamports: 5_200 + tipLamports, exitFixedLamportsPerTx: 5_200 + tipLamports, maxStakeLamports: 0.5e9, multipleCap: cap })
        : null;
    let growth: number | null = null;
    if (stake !== null && stake > 0) {
      growth = mean(outs.map((o) => Math.log(1 + (stake * (Math.min(o.multiple, cap) - 1) - (5_200 + tipLamports) * (1 + o.sellTxCount)) / 2e9)));
    }
    thresholds.push({
      threshold: th,
      selected: sel.length,
      meanMultiple: sel.length ? mean(sel.map((s) => Math.min(s.multiple, cap))) : null,
      hitRate2x: sel.length ? sel.filter((s) => s.multiple >= 2).length / sel.length : null,
      growthPerTrade: growth,
    });
  }

  // sequential bankroll paths over the samples the current threshold selects
  const th = p.scoring.baseAlphaThreshold;
  const chosen = samples.filter((s) => (scoreWith(s.values, current) ?? -1) >= th);
  const kelly = [0.25, 0.5, 0.75].map((fraction) => {
    let bank = 1e9;
    let peak = bank;
    let maxDd = 0;
    const seen: Outcome[] = [];
    for (const s of chosen) {
      if (seen.length >= p.risk.minOutcomeSamples) {
        const k = kellyStake({ outcomes: seen, bankrollLamports: bank, entryFixedLamports: 5_200 + tipLamports, exitFixedLamportsPerTx: 5_200 + tipLamports, maxStakeLamports: bank * 0.25, multipleCap: cap });
        const stake = Math.min(k * fraction, (p.risk.maxRiskPerTradePct * bank) / p.risk.lossGivenAdverse);
        if (stake > 0) {
          bank += stake * (Math.min(s.multiple, cap) - 1) - (5_200 + tipLamports) * (1 + s.sells);
          peak = Math.max(peak, bank);
          maxDd = Math.max(maxDd, 1 - bank / peak);
        }
      }
      seen.push({ multiple: s.multiple, sellTxCount: s.sells });
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
    baseline: { meanMultiple: mean(mult), hitRate2x: samples.length ? samples.filter((s) => s.multiple >= 2).length / samples.length : 0, medianMultiple: quantile(mult, 0.5) },
    attribution,
    weights: {
      current,
      suggested: improved ? best : null,
      trainScore: bestTrain,
      testScoreCurrent: testCurrent,
      testScoreSuggested: improved ? testBest : null,
      metric: "mean net multiple of the top score quintile, fixed costs at the nominal shadow stake",
    },
    thresholds,
    kelly,
    ladders,
    pnlAttribution: FACTORS.map((f) => ({ factor: f, pnlSol: pnlBy.get(f)! })),
  };
}
