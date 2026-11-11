import { CHUNK_SIZE, TICKS_PER_HOUR } from './constants';
import { makeElevationSampler, WATER_LEVEL } from './terrain';
import { weatherFor, weatherGen } from './weatherfx';
import { weatherAt } from './weather';

/**
 * Severe weather (docs/weather.md W6): storms and floods, their warnings, the flood risk of the ground. Pure functions of
 * the world seed, the tile and the tick (through `weatherFor`, so the W4 forced conditions and the W6 test script apply),
 * so the server and every client agree with nothing on the wire: the client's weather chip, the TV and the buy-land
 * preview read the same outlook and risk the server warns and prices from. Browser-safe.
 *
 * - **Flood risk** (`floodRiskAt`): land whose ground height (terrain.ts makeElevationSampler) is within `riskMargin` of
 *   the water level and within `riskNear` tiles of water. 1 at the water's edge height, 0 at the margin. Precomputed per
 *   chunk (a byte a tile) and cached.
 * - **The river level** (`riverLevel`): heavy rain over a rolling window (`window` hours, each hour's rain over
 *   `heavyFrom` counted, older hours decayed by `decay`; snow counts `snowShare` as it lies before it runs off), scaled
 *   to 0..1 between the world's own `levelFrom` and `levelTop` quantiles of that sum (riverClimate). A tile floods while the level is at least 1 − its risk
 *   (`floodsAt`): a little rise floods the lowest strip by the water, a full one every risk tile.
 * - **The outlook** (`severeOutlook`): storms (W1's `storm` hours) and flood spells (the level at `floodFrom` or more)
 *   starting in the next `leadHours`, found by looking ahead over the same functions.
 */
export const SEVERE = {
  /** warnings: storms and flood spells starting within this many game hours are announced */
  leadHours: 24,
  /** flood risk: land up to this much above the water level (the terrain noise; sand is 0.08) ... */
  riskMargin: 0.1,
  /** ... and within this many tiles of water */
  riskNear: 6,
  /** the river level: the rain over `heavyFrom` each hour, over the last `window` hours, older hours times `decay` an hour */
  window: 48, decay: 0.96, heavyFrom: 0.3, snowShare: 0.25,
  /**
   * the level is 0 under the world's `levelFrom` quantile of that sum (its real weather over `calYears` years) and 1 at
   * its `levelTop` quantile: every world floods about as often, wet or dry
   */
  levelFrom: 0.94, levelTop: 0.995, calYears: 8,
  /** a flood spell: the level at this or more (the lowest strip by the water floods) */
  floodFrom: 0.15,
  /** land price × (1 − priceCut × risk) (shared/src/land.ts); the value field's hazard byte at least hazard × the cell's mean risk */
  priceCut: 0.45, hazard: 0.6,
  /** a flooded building's owner pays this share of its book value once a flood (ledger `flood`), never a level lost */
  damageShare: 0.08,
  /** flood defences: dollars a tile; they hold the water back while the level is at most `wallHold` (then it tops them) */
  wallCost: 30, wallHold: 0.85,
  /** storms: each road tile beside a tree (a park or a wild tree) has this chance an hour of a tree coming down on it */
  treePerHour: 0.012,
  /** at most this many fallen trees on the roads at once */
  treeMax: 12,
  /** a fallen tree nobody has cleared is cleared by a contractor after this many game hours */
  treeClearHours: 8,
  /** a crew's work at a fallen tree, game minutes; crews come from builders' yards this close (Manhattan tiles) */
  crewMinutes: 45, crewReach: 48,
  /** gritting: a gritted road stays gritted this many game hours; rounds go out when snow is forecast within `gritAhead` hours or lying */
  gritHours: 10, gritAhead: 6,
  /** a gritter's round: waypoints (every `gritStep`-th tile of a nearest-neighbour walk), main roads first, within `gritReach` tiles of the yard */
  gritStops: 24, gritStep: 2, gritReach: 28,
  /** builders on shift at a yard who may go out gritting or clearing trees, at most, each */
  crewPerYard: 1,
};

const TPH = TICKS_PER_HOUR;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------- flood risk

const N = CHUNK_SIZE * CHUNK_SIZE;
const riskCache = new Map<string, Uint8Array>();
const samplers = new Map<number, (x: number, y: number) => number>();
const samplerOf = (seed: number) => {
  let s = samplers.get(seed);
  if (!s) { if (samplers.size > 8) samplers.clear(); samplers.set(seed, s = makeElevationSampler(seed)); }
  return s;
};

/**
 * A chunk's flood risk, a byte a tile row by row: 0 none (high ground, far from water, or water itself), 1..255 the risk
 * (255 at the water level). Cached per seed and chunk.
 */
export function floodRiskChunk(seed: number, cx: number, cy: number): Uint8Array {
  const key = `${seed}|${cx}|${cy}`;
  let out = riskCache.get(key);
  if (out) return out;
  const R = SEVERE.riskNear, S = CHUNK_SIZE + 2 * R, x0 = cx * CHUNK_SIZE - R, y0 = cy * CHUNK_SIZE - R, h = samplerOf(seed);
  const e = new Float32Array(S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) e[j * S + i] = h(x0 + i, y0 + j) - WATER_LEVEL;
  // distance to water (Chebyshev, capped at R + 1): two passes of a min filter, rows then columns
  const big = R + 1, row = new Uint8Array(S * S);
  for (let j = 0; j < S; j++) {
    let last = -1e9;
    for (let i = 0; i < S; i++) { if (e[j * S + i] < 0) last = i; row[j * S + i] = Math.min(big, i - last); }
    last = 1e9;
    for (let i = S - 1; i >= 0; i--) { if (e[j * S + i] < 0) last = i; row[j * S + i] = Math.min(row[j * S + i], big, last - i); }
  }
  out = new Uint8Array(N);
  const M = SEVERE.riskMargin;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    const i = lx + R, j = ly + R, ev = e[j * S + i];
    if (ev < 0 || ev >= M) continue;
    let d = big;
    for (let k = -R; k <= R && d > 0; k++) { const jj = j + k; if (jj >= 0 && jj < S) d = Math.min(d, Math.max(Math.abs(k), row[jj * S + i])); }
    if (d > R) continue;
    out[ly * CHUNK_SIZE + lx] = 1 + Math.round(254 * (1 - ev / M));
  }
  if (riskCache.size > 2048) riskCache.clear();
  riskCache.set(key, out);
  return out;
}
/** A tile's flood risk, 0 (none) to 1 (at the water's own level). */
export function floodRiskAt(seed: number, x: number, y: number): number {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const b = floodRiskChunk(seed, cx, cy)[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)];
  return b ? (b - 1) / 254 : 0;
}
/** Does a tile of this risk (0..1) flood at this river level (0..1)? Never a tile with no risk. */
export const floodsAt = (risk: number, level: number) => risk > 0 && level > 0 && risk >= 1 - level;
/** The land price multiplier of a tile's flood risk (shared/src/land.ts landPriceOf). */
export const floodPriceMul = (risk: number) => 1 - SEVERE.priceCut * clamp01(risk);

// ---------------------------------------------------------------- the river level

const inflow = new Map<string, number>();
const runoff = (w: { rain: number; snow: boolean }) => Math.max(0, w.rain - SEVERE.heavyFrom) * (w.snow ? SEVERE.snowShare : 1);
/** One game hour's run-off into the rivers: rain over heavyFrom (snow a share of it). */
function inflowAt(seed: number, hour: number): number {
  const key = `${seed}|${hour}|${weatherGen()}`;
  let v = inflow.get(key);
  if (v !== undefined) return v;
  v = runoff(weatherFor(seed, hour * TPH));
  if (inflow.size > 8192) inflow.clear();
  inflow.set(key, v);
  return v;
}
const calCache = new Map<number, { base: number; top: number }>();
/**
 * The world's river climate: the rolling sums at its levelFrom and levelTop quantiles over calYears of its real weather
 * (W1's weatherAt, never a forced condition), so a level reads the same on every side. About 10 ms once per seed.
 */
export function riverClimate(seed: number): { base: number; top: number } {
  let c = calCache.get(seed);
  if (c) return c;
  const H = SEVERE.calYears * 24 * 7, W = SEVERE.window, d = SEVERE.decay, dW = Math.pow(d, W);
  const r = new Float64Array(H + W);
  for (let i = 0; i < r.length; i++) r[i] = runoff(weatherAt(seed, (i - W) * TPH));
  const sums = new Float64Array(H);
  let s = 0;
  for (let i = 0; i < W; i++) s = s * d + r[i]; // the window ending at hour -1
  for (let h = 0; h < H; h++) { s = s * d + r[h + W] - dW * r[h]; sums[h] = Math.max(0, s); }
  sums.sort();
  const q = (p: number) => sums[Math.min(H - 1, Math.floor(p * (H - 1)))];
  const base = Math.max(1, q(SEVERE.levelFrom));
  c = { base, top: Math.max(base + 2, q(SEVERE.levelTop)) };
  if (calCache.size > 8) calCache.clear();
  calCache.set(seed, c);
  return c;
}
/** The rolling sum of heavy rain behind the river level at a game hour (the raw figure, for checks and calibration). */
export function riverSum(seed: number, hour: number): number {
  let s = 0, d = 1;
  for (let k = 0; k < SEVERE.window; k++, d *= SEVERE.decay) s += inflowAt(seed, hour - k) * d;
  return s;
}
/** The river level, 0 (normal) to 1 (every risk tile under water), for the game hour holding `tick`. */
export function riverLevel(seed: number, tick: number): number {
  const c = riverClimate(seed);
  return clamp01((riverSum(seed, Math.floor(tick / TPH)) - c.base) / (c.top - c.base));
}

// ---------------------------------------------------------------- the outlook

export interface SevereEvent {
  kind: 'storm' | 'flood';
  /** game hours (tick / TICKS_PER_HOUR): the first hour of it, and the first hour after it (scanned at most 72 hours on) */
  from: number; to: number;
  /** a flood spell's highest river level (0..1); a storm's strongest gust (tiles an hour) */
  peak: number;
}
const stormAt = (seed: number, hour: number) => weatherFor(seed, hour * TPH).storm;
const floodAt = (seed: number, hour: number) => riverLevel(seed, hour * TPH) >= SEVERE.floodFrom;
const outlookCache = new Map<string, SevereEvent[]>();

/**
 * Storms and flood spells under way at game hour `hour` or starting in the next `ahead` hours (SEVERE.leadHours), in
 * order of start. A spell under way has `from` <= hour. Memoised per hour.
 */
export function severeOutlook(seed: number, tick: number, ahead = SEVERE.leadHours): SevereEvent[] {
  const h0 = Math.floor(tick / TPH), key = `${seed}|${h0}|${ahead}|${weatherGen()}`;
  const hit = outlookCache.get(key);
  if (hit) return hit;
  const out: SevereEvent[] = [];
  for (const kind of ['storm', 'flood'] as const) {
    const on = kind === 'storm' ? stormAt : floodAt;
    let h = h0;
    if (on(seed, h)) { while (h > h0 - 72 && on(seed, h - 1)) h--; } // under way: find where it began
    else { h = h0 + 1; while (h <= h0 + ahead && !on(seed, h)) h++; if (h > h0 + ahead) continue; }
    const from = h;
    let peak = 0;
    for (; h < from + 72 && on(seed, h); h++) peak = Math.max(peak, kind === 'storm' ? weatherFor(seed, h * TPH).wind.gust : riverLevel(seed, h * TPH));
    out.push({ kind, from, to: h, peak });
  }
  out.sort((a, b) => a.from - b.from);
  if (outlookCache.size > 512) outlookCache.clear();
  outlookCache.set(key, out);
  return out;
}

/** A warning's words: "Storm warning: gales from 14:00 tomorrow" / "Flood warning: rivers rising from 03:00". */
export function warningText(e: SevereEvent, nowHour: number): string {
  const hh = `${String(((e.from % 24) + 24) % 24).padStart(2, '0')}:00`;
  const day = Math.floor(e.from / 24) - Math.floor(nowHour / 24);
  const when = e.from <= nowHour ? 'now' : `from ${hh}${day === 0 ? ' today' : day === 1 ? ' tomorrow' : ` in ${day} days`}`;
  if (e.kind === 'storm') return `Storm warning: gales and falling trees ${when}`;
  return `Flood warning: rivers rising ${when}${e.peak >= 0.6 ? ', low land by the water will flood' : ', the lowest land by the water may flood'}`;
}
