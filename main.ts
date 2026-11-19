// GTA VI trophy rarity forecaster (Node 22, standard library only).
//
// For every trophy of Grand Theft Auto VI on PS5, forecasts five quantiles
// of its Exophase earn rate at the case target.
//
// Idea: a trophy's earn rate is (earners / players tracked). Both counts
// grow roughly like power laws in the time since release, so in
// log-log space each is close to a straight line against
// ln(1 + hours since release). Fit both lines per trophy with recency
// weights (24 h half-life), take the net slope (earners minus players),
// shrink it toward the tier median, average a whole-history fit with a
// last-day fit, and extrapolate from the last observed rate with a
// damping factor, because earn rates saturate instead of compounding
// forever. The spread is a logit random walk plus the propagated slope
// uncertainty, with a floor so a flat launch-night history still admits
// that Exophase can refresh its counts between checkpoint and target.
//
// Deterministic, offline, no dependencies. Reads every *.in file in the
// input directory and writes one *.out per case.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The quantile levels the contest scores, in row order.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Standard normal quantiles at those levels.
const Z_SCORES = [-1.645, -0.674, 0, 0.674, 1.645];
// Logit spread per square-root day of horizon (random-walk part).
const WALK_SIGMA = 0.45;
// Narrowest logit spread we ever report.
const SPREAD_FLOOR = 0.8;
// Recency weight half-life, in hours.
const HALF_LIFE_HOURS = 24;
// Weight of a trophy's own slope vs its tier median when shrinking.
const OWN_WEIGHT = 0.7;
// A trophy at (or effectively at) 100% is forecast at 99.99: the scorer
// clamps to 99.99 anyway, and 100% has no logit.
const TOP_RATE = 99.99;

interface TrophyDef {
  id: number;
  tier: string;
}

interface ReadRow {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface TrophyCase {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  game: { release_date: string };
  trophies: TrophyDef[];
  history: ReadRow[];
}

interface WeightedPoint {
  x: number;
  y: number;
  w: number;
}

interface LineFit {
  slope: number;
  intercept: number;
  slopeSe: number;
}

const clampPct = (pct: number): number => Math.min(99.99, Math.max(0.01, pct));
const toLogit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const fromLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Weighted least-squares line through points, with the standard error of
 * the slope. Returns null when the points cannot define a slope (fewer
 * than two points, or all x equal).
 */
function weightedLine(points: WeightedPoint[]): LineFit | null {
  if (points.length < 2) return null;
  let wSum = 0;
  let xBar = 0;
  let yBar = 0;
  for (const p of points) {
    wSum += p.w;
    xBar += p.w * p.x;
    yBar += p.w * p.y;
  }
  if (wSum <= 0) return null;
  xBar /= wSum;
  yBar /= wSum;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += p.w * (p.x - xBar) * (p.x - xBar);
    sxy += p.w * (p.x - xBar) * (p.y - yBar);
  }
  if (sxx <= 1e-12) return null;
  const slope = sxy / sxx;
  const intercept = yBar - slope * xBar;
  // Slope standard error from the weighted residual variance.
  let slopeSe = 0;
  if (points.length > 2) {
    let rss = 0;
    for (const p of points) {
      const r = p.y - (intercept + slope * p.x);
      rss += p.w * r * r;
    }
    const dof = points.length - 2;
    const variance = rss / dof / sxx;
    slopeSe = variance > 0 ? Math.sqrt(variance) : 0;
  }
  return { slope, intercept, slopeSe };
}

/** Net log-rate slope (earners slope minus players slope) for one fit. */
function netSlope(
  earners: WeightedPoint[],
  players: WeightedPoint[],
): { slope: number; se: number } | null {
  const fitEarners = weightedLine(earners);
  const fitPlayers = weightedLine(players);
  if (fitEarners === null || fitPlayers === null) return null;
  return {
    slope: fitEarners.slope - fitPlayers.slope,
    se: Math.sqrt(
      fitEarners.slopeSe * fitEarners.slopeSe +
        fitPlayers.slopeSe * fitPlayers.slopeSe,
    ),
  };
}

interface TrophyForecast {
  medianPct: number;
  spread: number;
}

/**
 * Forecast one trophy. `obs` holds one entry per usable read:
 * log-time x, log earners, log players, recency weight, read time.
 */
function forecastTrophy(
  lastRate: number,
  obs: Array<{ x: number; logEarners: number; logPlayers: number; w: number; t: number }>,
  xLast: number,
  xTarget: number,
  horizonDays: number,
  tierMedianSlope: number,
): TrophyForecast {
  const fallback: TrophyForecast = {
    medianPct: clampPct(lastRate),
    spread: Math.max(SPREAD_FLOOR, WALK_SIGMA * Math.sqrt(horizonDays)),
  };
  if (obs.length === 0) return fallback;

  const earnersAll: WeightedPoint[] = obs.map((o) => ({ x: o.x, y: o.logEarners, w: o.w }));
  const playersAll: WeightedPoint[] = obs.map((o) => ({ x: o.x, y: o.logPlayers, w: o.w }));
  const whole = netSlope(earnersAll, playersAll);
  if (whole === null) return fallback;

  // Last-day fit: reads within 24 h of the checkpoint.
  const lastTime = Math.max(...obs.map((o) => o.t));
  const recent = obs.filter((o) => lastTime - o.t <= 24 * 3600 * 1000);
  let recentFit: { slope: number; se: number } | null = null;
  if (recent.length >= 2) {
    recentFit = netSlope(
      recent.map((o) => ({ x: o.x, y: o.logEarners, w: o.w })),
      recent.map((o) => ({ x: o.x, y: o.logPlayers, w: o.w })),
    );
  }
  const ownSlope = recentFit === null ? whole.slope : (whole.slope + recentFit.slope) / 2;
  const shrunkSlope = OWN_WEIGHT * ownSlope + (1 - OWN_WEIGHT) * tierMedianSlope;

  const gap = Math.max(0, xTarget - xLast);
  // Damping: rates saturate, so a trend extrapolated over a long log-time
  // gap counts for less the further the target sits from the last read.
  const damp = 1 / (1 + gap);
  const medianPct = clampPct(lastRate * Math.exp(shrunkSlope * gap * damp));
  const slopeSe = recentFit === null ? whole.se : (whole.se + recentFit.se) / 2;
  const spread = Math.max(
    SPREAD_FLOOR,
    WALK_SIGMA * Math.sqrt(horizonDays) + slopeSe * gap * damp,
  );
  return { medianPct, spread };
}

function forecastCase(c: TrophyCase): Array<{ id: number; q: number[] }> {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`case ${c.id} asks for levels ${JSON.stringify(c.levels)}`);
  }
  if (c.history.length === 0) throw new Error(`case ${c.id} has no history`);

  const releaseMs = Date.parse(`${c.game.release_date}T00:00:00Z`);
  const checkpointMs = Date.parse(c.at);
  const targetMs = Date.parse(c.target);
  const horizonDays = c.horizon_minutes / 1440;
  const logTime = (ms: number): number =>
    Math.log(1 + Math.max(0, (ms - releaseMs) / 3_600_000));
  const xTarget = logTime(targetMs);
  const lastRead = c.history[c.history.length - 1];
  const lastMs = Date.parse(lastRead.at);
  const xLast = logTime(lastMs);

  // Per-trophy observations, built once so the tier medians can be
  // computed before any trophy is forecast.
  interface TrophyObs {
    lastRate: number;
    obs: Array<{ x: number; logEarners: number; logPlayers: number; w: number; t: number }>;
    ownSlope: number | null;
  }
  const perTrophy: TrophyObs[] = c.trophies.map((_, i) => {
    const obs: TrophyObs['obs'] = [];
    for (const read of c.history) {
      const rate = read.rates[i];
      if (rate === null || rate === undefined) continue;
      if (!(read.players_tracked > 0)) continue;
      const t = Date.parse(read.at);
      const earners = Math.max(0.5, (rate / 100) * read.players_tracked);
      obs.push({
        x: logTime(t),
        logEarners: Math.log(earners),
        logPlayers: Math.log(read.players_tracked),
        // 24 h half-life recency weight, 1.0 at the last read.
        w: Math.pow(0.5, (lastMs - t) / (HALF_LIFE_HOURS * 3_600_000)),
        t,
      });
    }
    const lastRate = lastRead.rates[i] ?? 0;
    let ownSlope: number | null = null;
    if (obs.length >= 2) {
      const whole = netSlope(
        obs.map((o) => ({ x: o.x, y: o.logEarners, w: o.w })),
        obs.map((o) => ({ x: o.x, y: o.logPlayers, w: o.w })),
      );
      if (whole !== null) {
        const lastTime = Math.max(...obs.map((o) => o.t));
        const recent = obs.filter((o) => lastTime - o.t <= 24 * 3600 * 1000);
        let recentSlope: number | null = null;
        if (recent.length >= 2) {
          const rf = netSlope(
            recent.map((o) => ({ x: o.x, y: o.logEarners, w: o.w })),
            recent.map((o) => ({ x: o.x, y: o.logPlayers, w: o.w })),
          );
          recentSlope = rf === null ? null : rf.slope;
        }
        ownSlope = recentSlope === null ? whole.slope : (whole.slope + recentSlope) / 2;
      }
    }
    return { lastRate, obs, ownSlope };
  });

  // Tier median of the per-trophy averaged slopes; trophies without a
  // fit fall back to their tier's median, or 0 when the tier has none.
  const slopesByTier = new Map<string, number[]>();
  c.trophies.forEach((t, i) => {
    const s = perTrophy[i].ownSlope;
    if (s === null) return;
    const list = slopesByTier.get(t.tier) ?? [];
    list.push(s);
    slopesByTier.set(t.tier, list);
  });
  const tierMedian = (tier: string): number => {
    const list = slopesByTier.get(tier);
    return list !== undefined && list.length > 0 ? medianOf(list) : 0;
  };

  return c.trophies.map((t, i) => {
    const { lastRate, obs, ownSlope } = perTrophy[i];
    // A trophy everyone already has cannot climb past 100%.
    if (lastRate >= TOP_RATE) {
      return { id: t.id, q: [TOP_RATE, TOP_RATE, TOP_RATE, TOP_RATE, TOP_RATE] };
    }
    let fc: TrophyForecast;
    try {
      fc = forecastTrophy(
        lastRate,
        obs,
        xLast,
        xTarget,
        horizonDays,
        ownSlope === null ? tierMedian(t.tier) : tierMedian(t.tier),
      );
    } catch {
      fc = {
        medianPct: clampPct(lastRate),
        spread: Math.max(SPREAD_FLOOR, WALK_SIGMA * Math.sqrt(horizonDays)),
      };
    }
    const centre = toLogit(fc.medianPct);
    const qs: number[] = [];
    let prev = -Infinity;
    for (const z of Z_SCORES) {
      const v = round4(clampPct(fromLogit(centre + z * fc.spread)));
      // Rounding must never break the non-decreasing order.
      const ordered = Math.max(v, prev);
      qs.push(ordered);
      prev = ordered;
    }
    return { id: t.id, q: qs };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as TrophyCase;
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
