// gta6-trophy-rarity-forecast-01 entry: regime-adaptive logit forecaster.
//
// Idea: Exophase's trophy page only changes when Exophase refreshes its
// counts, so a case's history is a staircase: long flat stretches, then a
// jump at each refresh. Two regimes follow from that.
//
//   * Flat history (one segment, as in the practice cases): no refresh has
//     been seen yet, so one is due. The one refresh the house published
//     dropped every non-100% rate to about a fifth of its pre-refresh
//     value (launch night 638 players / 943 trophies earned -> 04:30Z
//     refresh 3,868 players / 4,276 trophies; the non-100% rates summed
//     47.78 -> 10.55, a factor of 0.22, and the house baseline's stated
//     practice loss is reproduced at ~0.195). The forecast therefore shifts the median down by that
//     factor and carries a wide spread, because a refresh is a level shift
//     the flat history cannot price.
//   * Stepped history (the final case): fit, per trophy, a straight line
//     to the logit rate against ln(1 + hours since the first read), over
//     the distinct refreshed levels (segments), anchored on the last level
//     and extrapolated to the target. Slopes are shrunk toward the
//     cross-trophy median slope (empirical-Bayes: every trophy shares the
//     same dilution/progression forces, so the common slope is estimated
//     far better than any one trophy's). The spread combines the
//     random-walk widening with horizon, the fit's residual (how jumpy the
//     refreshes were) and the slope's extrapolation error.
//
// Everything is deterministic, stdlib only, no network, no clock: the
// program reads only the case file it is given.
//
// Node 22: node /bot/main.ts (the repo holds this file only as main.ts).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Random-walk spread, logit units per square-root day (the baseline's). */
const SIGMA_RW = 0.5;
/** One refresh's dilution of a non-100% rate.
 *  The published 04:30Z refresh sums to a proportional factor of 0.22
 *  (non-100% rates 47.78 -> 10.55); the house baseline's stated practice
 *  loss of ~1.51 is reproduced at a factor of ~0.195, so 0.20 splits the
 *  two estimates of the same event. The grid over both is flat around
 *  here, so this is a central prior, not a tuned point. */
const REFRESH_DILUTION = 0.2;
/** Spread of the flat-regime forecast, logit units.
 *  A refresh is a fairly uniform dilution (per-trophy noise is only
 *  ~0.2-0.3 logit from earner granularity and 2-decimal rounding), so a
 *  0.6 spread covers it with room to spare; a wider band only pays
 *  pinball loss without buying coverage. */
const FLAT_SIGMA = 0.6;
/** A rate at or above this is treated as "everyone has it" (Gone Fishing). */
const SATURATED = 99.5;

interface Case {
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: Array<{ id: number }>;
  history: Array<{ at: string; players_tracked: number; rates: Array<number | null> }>;
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Collapse consecutive reads with identical rate vectors into segments. */
function segments(c: Case): Array<{ tHours: number; rates: Array<number | null> }> {
  const t0 = Date.parse(c.history[0].at);
  const segs: Array<{ tHours: number; rates: Array<number | null> }> = [];
  for (const read of c.history) {
    const last = segs[segs.length - 1];
    const same =
      last !== undefined &&
      last.rates.length === read.rates.length &&
      last.rates.every((r, i) => r === read.rates[i]);
    if (!same) {
      segs.push({ tHours: (Date.parse(read.at) - t0) / 3_600_000, rates: read.rates });
    }
  }
  return segs;
}

interface TrophyFit {
  slope: number;
  slopeSe: number;
  residVar: number;
  n: number;
}

/** OLS of y on x with slope standard error and residual variance. */
function ols(xs: number[], ys: number[]): TrophyFit {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let rss = 0;
  for (let i = 0; i < n; i++) rss += (ys[i] - (intercept + slope * xs[i])) ** 2;
  const dof = Math.max(n - 2, 1);
  const residVar = rss / dof;
  const slopeSe = sxx > 0 ? Math.sqrt(residVar / sxx) : 1;
  return { slope, slopeSe, residVar, n };
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const horizonDays = c.horizon_minutes / 1440;
  const last = c.history[c.history.length - 1];
  const segs = segments(c);
  const tTarget = (Date.parse(c.target) - Date.parse(c.history[0].at)) / 3_600_000;
  const xTarget = Math.log1p(tTarget);

  // ---- Flat regime: one segment, no refresh seen yet. -----------------
  if (segs.length <= 1) {
    const sigma = Math.sqrt(FLAT_SIGMA ** 2 + SIGMA_RW ** 2 * horizonDays);
    return c.trophies.map((t, i) => {
      const r = last.rates[i] ?? 0;
      if (r >= SATURATED) {
        // Everyone has it; it stays (nearly) everyone.
        const l = logit(r);
        return { id: t.id, q: Z.map((z) => round4(clampPct(invLogit(l + z * 0.1)))) };
      }
      const l = logit(r) + Math.log(REFRESH_DILUTION);
      return { id: t.id, q: Z.map((z) => round4(clampPct(invLogit(l + z * sigma)))) };
    });
  }

  // ---- Trend regime: fit per trophy on the refreshed levels. ----------
  // Prefer the last 24h of segments (the current regime, not the launch
  // anomaly); fall back to all segments when the recent window is thin.
  const lastSeg = segs[segs.length - 1];
  const recent = segs.filter((s) => lastSeg.tHours - s.tHours <= 24);
  const fitSegs = recent.length >= 3 ? recent : segs;
  const xs = fitSegs.map((s) => Math.log1p(s.tHours));

  // Per-trophy fits, then the cross-trophy median slope and its spread.
  const fits: Array<TrophyFit | null> = c.trophies.map((_, i) => {
    const ys: number[] = [];
    const xx: number[] = [];
    fitSegs.forEach((s, j) => {
      const r = s.rates[i];
      if (r !== null && r > 0) {
        ys.push(logit(r));
        xx.push(xs[j]);
      }
    });
    if (ys.length < 2) return null;
    if (ys.length === 2) {
      // Two points: exact slope, no residual; standard error unknown.
      const slope = (ys[1] - ys[0]) / (xx[1] - xx[0]);
      return { slope, slopeSe: Number.POSITIVE_INFINITY, residVar: 0.04, n: 2 };
    }
    return ols(xx, ys);
  });
  const slopes = fits.filter((f): f is TrophyFit => f !== null).map((f) => f.slope);
  const slopeMed = median(slopes);
  const slopeTau = Math.max(
    0.05,
    median(slopes.map((s) => Math.abs(s - slopeMed))) * 1.4826,
  );

  return c.trophies.map((t, i) => {
    const rLast = last.rates[i] ?? 0;
    if (rLast >= SATURATED) {
      const l = logit(rLast);
      return { id: t.id, q: Z.map((z) => round4(clampPct(invLogit(l + z * 0.1)))) };
    }
    const fit = fits[i];
    const lLast = logit(rLast);
    const xLast = Math.log1p(lastSeg.tHours);
    let lMed = lLast;
    let sigma = Math.sqrt(SIGMA_RW ** 2 * horizonDays + 0.04);
    if (fit !== null) {
      // Empirical-Bayes shrinkage of the slope toward the common slope.
      const se2 = Number.isFinite(fit.slopeSe) ? fit.slopeSe ** 2 : slopeTau ** 2;
      const w = slopeTau ** 2 / (slopeTau ** 2 + se2);
      const slopeStar = w * fit.slope + (1 - w) * slopeMed;
      lMed = lLast + slopeStar * (xTarget - xLast);
      // Never extrapolate more than 2 logit from the last observed level.
      lMed = Math.min(lLast + 2, Math.max(lLast - 2, lMed));
      const slopeVar = w * se2;
      const extrapVar = slopeVar * (xTarget - xLast) ** 2;
      sigma = Math.sqrt(
        SIGMA_RW ** 2 * horizonDays + Math.max(fit.residVar, 0.04) + extrapVar,
      );
      if (fit.n === 2) sigma *= 1.5;
    }
    sigma = Math.min(2.0, Math.max(0.35, sigma));
    return { id: t.id, q: Z.map((z) => round4(clampPct(invLogit(lMed + z * sigma)))) };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
