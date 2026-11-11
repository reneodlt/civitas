import { CHUNK_SIZE } from './constants';
import { MANIFEST, DESIGN_COUNT_TABLE, TOP_LEVEL_TABLE } from './buildings/compiled';
import { LEVEL_SLOTS } from './buildings/codes';
import { designPick } from './leisure';
import { climateOf } from './weather';
import { VALUE_COUNT } from './motivation';

/**
 * Neighbourhood value (docs/multiplayer-land.md section 4, M1): what is near a place, as eleven kinds of nuisance and
 * amenity, kept by the server per 4×4-tile cell (sim/value.ts) and combined into a value with a household's own weights.
 * Shared so the client can label the kinds and the overlay, and so the tuning is in one place. Browser-safe.
 *
 * Every kind is a byte 0-255 per cell (an intensity 0-1). Nuisances spread from measured use (nuisance follows use:
 * a refuse depot by the homes it empties, a works by its staff on shift, a road by the traffic on it); smell and smoke
 * spread as a downwind plume from the world's wind rose (shared/src/weather.ts climateOf), noise leans a little
 * downwind. Quiet is derived (the absence of noise and heavy traffic); services come from the existing coverage.
 */
export const ValueKind = {
  Noise: 0, Smell: 1, Traffic: 2, Hazard: 3, Disorder: 4, Eyesore: 5,
  Green: 6, Quiet: 7, Access: 8, Services: 9, Culture: 10,
} as const;
export type ValueKindId = (typeof ValueKind)[keyof typeof ValueKind];
export const VALUE_KIND_COUNT = 11;
/** bytes per cell: the eleven kinds, then the published value (average household) */
export const VALUE_SLOTS = 12;
export const VALUE_SLOT_VALUE = 11;
/** tiles a cell side, cells a chunk side, cells a chunk */
export const VALUE_CELL = 4;
export const VALUE_CELLS = CHUNK_SIZE / VALUE_CELL;
export const VALUE_CELLS_PER_CHUNK = VALUE_CELLS * VALUE_CELLS;

export interface ValueKindInfo {
  key: string; name: string; nuisance: boolean;
  /** the overlay legend's ends and its one-line explanation */
  lo: string; hi: string; explain: string;
}
export const VALUE_KINDS: readonly ValueKindInfo[] = [
  { key: 'noise', name: 'noise', nuisance: true, lo: 'quiet', hi: 'loud', explain: 'Busy roads, works on shift, trains, flights and late venues; leans a little downwind' },
  { key: 'smell', name: 'smell and smoke', nuisance: true, lo: 'clean air', hi: 'reeks', explain: 'Refuse depots by what they handle, smoking works and plants; carried downwind on the prevailing wind' },
  { key: 'traffic', name: 'heavy traffic', nuisance: true, lo: 'none', hi: 'lorries all day', explain: 'Lorries and buses measured on the roads, and refuse traffic' },
  { key: 'hazard', name: 'hazard', nuisance: true, lo: 'safe', hi: 'dangerous', explain: 'Chemical and fuel works while they run' },
  { key: 'disorder', name: 'disorder', nuisance: true, lo: 'orderly', hi: 'rowdy', explain: 'Late venues by their night crowds, empty and derelict buildings; police cover lowers it' },
  { key: 'eyesore', name: 'eyesore', nuisance: true, lo: 'pleasant', hi: 'ugly', explain: 'Derelict buildings and busy tips, close by only' },
  { key: 'green', name: 'green', nuisance: false, lo: 'built up', hi: 'leafy', explain: 'Parks, water and open country nearby' },
  { key: 'quiet', name: 'quiet', nuisance: false, lo: 'noisy', hi: 'peaceful', explain: 'The absence of noise and heavy traffic' },
  { key: 'access', name: 'access', nuisance: false, lo: 'remote', hi: 'everything near', explain: 'Shops, jobs and stops within a short walk' },
  { key: 'services', name: 'services', nuisance: false, lo: 'none', hi: 'police, fire and health', explain: 'The service cover of staffed stations' },
  { key: 'culture', name: 'culture and prestige', nuisance: false, lo: 'plain', hi: 'prestigious', explain: 'Landmarks, theatres, cinemas and libraries, and tall neighbours' },
];

/** How one kind spreads from a source: radius in tiles, falloff power, and how far it leans downwind. */
export interface ValueSpread {
  /** reach in tiles with no wind (round part) */
  r: number;
  /** falloff power: 1 linear, 2 falls off fast */
  p: number;
  /** 0 round, 1 all plume */
  lean: number;
  /** plume reach downwind and upwind, as multiples of r */
  down: number; up: number;
}

/**
 * The tunables. Emissions are in "units": a source cell's own intensity is 1 - exp(-units), so 1 unit is 63% at the
 * source and less round it by the spread.
 */
export const VALUE = {
  /** the hourly refresh happens at this tick of the game hour (after the hour's other bookkeeping) */
  phase: 37,
  /** traffic and crowds are sampled every so many ticks */
  sampleEvery: 10,
  /** the hourly smoothing of measured use (EMA weight of the newest hour) */
  smooth: 0.3,
  /**
   * emissions are kept on a log scale, `steps` to an e-fold above `quantum` units (about 13% a step), so a busy
   * street's hour-to-hour wobble or a smaller change than that recomputes nothing
   */
  quantum: 0.02, steps: 8,
  spread: [
    /* noise */ { r: 14, p: 2, lean: 0.3, down: 1.4, up: 0.6 },
    /* smell */ { r: 26, p: 1, lean: 1, down: 1.7, up: 0.3 },
    /* traffic */ { r: 6, p: 1, lean: 0, down: 1, up: 1 },
    /* hazard */ { r: 16, p: 1, lean: 0, down: 1, up: 1 },
    /* disorder */ { r: 10, p: 1, lean: 0, down: 1, up: 1 },
    /* eyesore */ { r: 6, p: 1, lean: 0, down: 1, up: 1 },
    /* green */ { r: 12, p: 1, lean: 0, down: 1, up: 1 },
    /* quiet (derived) */ { r: 0, p: 1, lean: 0, down: 1, up: 1 },
    /* access */ { r: 12, p: 1, lean: 0, down: 1, up: 1 },
    /* services (from coverage) */ { r: 0, p: 1, lean: 0, down: 1, up: 1 },
    /* culture */ { r: 20, p: 1, lean: 0, down: 1, up: 1 },
  ] as ValueSpread[],
  /** plume width: one cell at the source, widening by this share of the distance downwind */
  plumeWiden: 0.35,
  emit: {
    /** industry, per worker on shift: noise (times 1 + the model's noise / 5), smell (times 1 + its pollution), hazard (chemicals, fuel) */
    indNoise: 0.035, indSmell: 0.01, indHazard: 0.05,
    /** a refuse depot, per home emptied a day (today and yesterday averaged): smell, lorries, noise; eyesore up to `wasteEyesore` once busy */
    wasteSmell: 0.025, wasteTraffic: 0.012, wasteNoise: 0.006, wasteEyesore: 0.6, wasteBusy: 20,
    /** a power plant at full staff: smell per point of pollution (0-10), noise */
    plantSmell: 0.25, plantNoise: 0.6,
    /** roads, per vehicle on the road in the cell on average (sampled): noise; per lorry or bus: heavy traffic and noise */
    roadNoise: 0.04, heavyTraffic: 0.4, heavyNoise: 0.1,
    /** a rail tile with trains running, per train on the line (at most 6) */
    railNoise: 0.04,
    /** an airport, per flight an hour, at each of three points along the runway */
    airNoise: 0.25,
    /** late venues, per guest at night (sampled 22:00-04:00): noise and disorder */
    nightNoise: 0.06, nightDisorder: 0.05,
    /** an empty building (not a site) after this many hours: disorder and eyesore */
    emptyHours: 12, emptyDisorder: 0.25, emptyEyesore: 0.35,
    /** police cover takes this share of disorder off at full strength */
    policeCut: 0.6,
    /** green: per open tile share of the cell (no building, no road; water counts), per park (times its leisure value) */
    openGreen: 0.5, parkGreen: 0.35,
    /** access: per job, per shop, per stop tile (times lines, at most 3) */
    accessJob: 0.012, accessShop: 0.15, accessStop: 0.25,
    /** culture: a landmark, a staffed theatre, cinema or library, per level over 4 of a building */
    landmark: 1.6, venueCulture: 0.5, tallCulture: 0.12,
  },
  /** services: coverage (0-3 families) / this fills the byte */
  servicesFull: 3,
  /**
   * Average weights per kind: for a nuisance, the share of value it takes at full intensity; for an amenity, the
   * weight before saturation. Multiplied per household by VALUE_BY_MOTIVE.
   */
  weight: [0.35, 0.45, 0.25, 0.45, 0.35, 0.2, 0.6, 0.3, 0.5, 0.5, 0.4],
  /** a nuisance never takes more than this share off on its own */
  maxCut: 0.9,
  /** the published value byte is value / publishMax (1 sits at 128 of 255... about) */
  publishMax: 2,
  /** homeScore: weight of the value term, and how hard the log ratio is pressed before clamping to ±1 */
  homeTerm: 0.45, homeGain: 1.2,
  /** ambition: one level less where the average household's nuisance share left is under this; one more where value is over `ambitionUp` */
  ambitionDown: 0.62, ambitionUp: 1.75,
};

/**
 * How each of the six motivation values (docs/motivation.md section 3: Money, Family, Status, Roots, Time, Adventure)
 * weighs each kind, as a multiplier on VALUE.weight. A household's weights are its values' blend of these rows.
 * Family minds hazard and disorder most and loves green and services; Adventure barely minds noise and likes culture
 * and access; Status minds eyesore and loves prestige; Time wants access and quiet; Money cares about price (step 2),
 * so minds everything a little less; Roots is close to the average.
 */
export const VALUE_BY_MOTIVE: readonly (readonly number[])[] = [
  //        noise smell traff hazard disord eyes green quiet access serv culture
  /* Money */ [0.6, 0.7, 0.7, 0.7, 0.8, 0.5, 0.6, 0.6, 1.0, 0.8, 0.5],
  /* Family */ [1.2, 1.2, 1.5, 2.2, 2.0, 1.0, 1.5, 1.4, 0.9, 1.7, 0.8],
  /* Status */ [1.0, 1.2, 0.9, 0.9, 1.2, 1.8, 1.2, 1.0, 0.7, 0.9, 2.2],
  /* Roots */ [0.9, 0.9, 0.9, 0.9, 1.1, 0.9, 1.0, 1.0, 1.0, 0.9, 0.9],
  /* Time */ [1.3, 1.0, 1.0, 0.8, 0.8, 0.8, 1.0, 1.5, 1.8, 1.0, 0.8],
  /* Adventure */ [0.3, 0.8, 0.6, 0.6, 0.4, 0.6, 1.0, 0.4, 1.3, 0.6, 1.7],
];

/** A household's weight per kind from its six value weights (summing to 1). `out` is reused when given. */
export function valueWeights(values: readonly number[], out = new Float64Array(VALUE_KIND_COUNT)): Float64Array {
  for (let k = 0; k < VALUE_KIND_COUNT; k++) {
    let m = 0;
    for (let v = 0; v < VALUE_COUNT; v++) m += (values[v] ?? 0) * VALUE_BY_MOTIVE[v][k];
    out[k] = VALUE.weight[k] * m;
  }
  return out;
}
/** The average household's weights (an even blend of the six values): the published value. */
export const AVERAGE_VALUE_WEIGHTS = valueWeights(new Array(VALUE_COUNT).fill(1 / VALUE_COUNT));

const sat = (x: number) => x / (1 + x);
/**
 * value = (1 + Σ saturate(wᵢ × amenityᵢ)) × Π (1 − wⱼ × nuisanceⱼ), base 1 (docs/multiplayer-land.md section 4).
 * `b` holds a cell's bytes from `off` (VALUE_KIND_COUNT of them); null reads as nothing near (value 1).
 */
export function combineValue(b: ArrayLike<number> | null, off: number, w: ArrayLike<number> = AVERAGE_VALUE_WEIGHTS): number {
  if (!b) return 1;
  let add = 0, mul = 1;
  for (let k = 0; k < VALUE_KIND_COUNT; k++) {
    const x = b[off + k] / 255;
    if (!x) continue;
    if (VALUE_KINDS[k].nuisance) mul *= 1 - Math.min(VALUE.maxCut, w[k] * x);
    else add += sat(w[k] * x);
  }
  return (1 + add) * mul;
}
/** The nuisance part alone (the share of value left after the nuisances): ambition's floor reads it. */
export function nuisanceShare(b: ArrayLike<number> | null, off: number, w: ArrayLike<number> = AVERAGE_VALUE_WEIGHTS): number {
  if (!b) return 1;
  let mul = 1;
  for (let k = 0; k < VALUE_KIND_COUNT; k++) if (VALUE_KINDS[k].nuisance && b[off + k]) mul *= 1 - Math.min(VALUE.maxCut, (w[k] * b[off + k]) / 255);
  return mul;
}
/** The published value byte and back. */
export const valueByte = (v: number) => Math.round(255 * Math.max(0, Math.min(1, v / VALUE.publishMax)));
export const valueOfByte = (b: number) => (b / 255) * VALUE.publishMax;

// ---- spread kernels --------------------------------------------------------------------------------

/** A spread kernel on the cell grid: weights for cell offsets -r..r on each axis, (2r + 1)² of them, 1 at the centre. */
export interface ValueKernel { r: number; w: Float32Array }
const kernelCache = new Map<number, ValueKernel[]>();

/**
 * The kernels of every kind for a world: round ones for most, a plume from the wind rose for smell and a downwind lean
 * for noise (docs/weather.md section 3: long downwind, short upwind; a strong wind's bin spreads further). The rose
 * blows TOWARDS each bin's (dx, dy) in tile space, so a westerly world's plumes reach east (+x). Cached per seed.
 */
export function valueKernels(seed: number): ValueKernel[] {
  let ks = kernelCache.get(seed);
  if (ks) return ks;
  const rose = climateOf(seed).rose;
  let mean = 0;
  for (const b of rose) mean += b.share * b.speed;
  ks = VALUE.spread.map((s) => buildKernel(s, rose, mean || 1));
  if (kernelCache.size > 16) kernelCache.clear();
  kernelCache.set(seed, ks);
  return ks;
}

function buildKernel(s: ValueSpread, rose: { dx: number; dy: number; share: number; speed: number }[], meanSpeed: number): ValueKernel {
  if (s.r <= 0) return { r: 0, w: new Float32Array([1]) };
  const C = VALUE_CELL, reach = s.r * (s.lean > 0 ? Math.max(1, s.down * 1.4) : 1);
  const r = Math.ceil(reach / C), n = 2 * r + 1, w = new Float32Array(n * n);
  const at = (dx: number, dy: number) => {
    const d = Math.hypot(dx, dy);
    const round = d >= s.r ? 0 : (1 - d / s.r) ** s.p;
    if (s.lean <= 0) return round;
    let plume = 0;
    for (const b of rose) {
      if (!b.share) continue;
      const along = dx * b.dx + dy * b.dy, across = Math.abs(dx * b.dy - dy * b.dx);
      const sf = Math.max(0.7, Math.min(1.4, b.speed / meanSpeed));
      const len = along >= 0 ? s.r * s.down * sf : s.r * s.up;
      if (Math.abs(along) >= len) continue;
      const width = C + VALUE.plumeWiden * Math.max(0, along);
      plume += b.share * (1 - Math.abs(along) / len) ** s.p * Math.exp(-((across / width) ** 2));
    }
    return (1 - s.lean) * round + s.lean * plume;
  };
  const c0 = at(0, 0) || 1;
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) w[(j + r) * n + (i + r)] = Math.max(0, at(i * C, j * C) / c0);
  return { r, w };
}

// ---- industrial models' attributes ------------------------------------------------------------------

/** Per kind id × level slot: each (non-draft) design's noise, pollution (0-5) and whether its goods are hazardous. */
const IND_ATTRS: { noise: number; pollution: number; hazard: boolean }[][] = [];
for (const k of MANIFEST) {
  if (k.family !== 'industrial') continue;
  for (const l of k.levels) {
    IND_ATTRS[k.kindId * LEVEL_SLOTS + l.level] = l.designs.filter((d) => !d.draft).map((d) => {
      const a = (d.attrs ?? {}) as { noise?: number; pollution?: number; goodsType?: string };
      return { noise: a.noise ?? 0, pollution: a.pollution ?? 0, hazard: a.goodsType === 'chemicals' || a.goodsType === 'fuel' };
    });
  }
}
const NO_ATTRS = { noise: 0, pollution: 0, hazard: false };
/** The industrial model standing at (x, y) of this kind and level: its noise, pollution and hazard (the design the client draws). */
export function industryAttrs(kindId: number, level: number, x: number, y: number): { noise: number; pollution: number; hazard: boolean } {
  const lv = Math.min(level, TOP_LEVEL_TABLE[kindId] ?? 0), s = kindId * LEVEL_SLOTS + lv;
  const list = IND_ATTRS[s];
  if (!list || !list.length) return NO_ATTRS;
  const n = Math.min(list.length, DESIGN_COUNT_TABLE[s] || list.length);
  return list[Math.min(n - 1, Math.floor(designPick(x, y) * n))] ?? NO_ATTRS;
}
const LANDMARK_IDS = new Uint8Array(256);
for (const k of MANIFEST) if (k.landmark) LANDMARK_IDS[k.kindId] = 1;
export const isLandmarkKind = (kindId: number) => LANDMARK_IDS[kindId] === 1;

/** The strongest nuisance and amenity in a cell's bytes (for a tooltip), as [kind, byte] or null when there is none worth naming. */
export function valueHighlights(b: ArrayLike<number>, off: number): { nuisance: [number, number] | null; amenity: [number, number] | null } {
  let n: [number, number] | null = null, a: [number, number] | null = null;
  for (let k = 0; k < VALUE_KIND_COUNT; k++) {
    const x = b[off + k];
    if (x < 26) continue;
    if (VALUE_KINDS[k].nuisance) { if (!n || x > n[1]) n = [k, x]; } else if (!a || x > a[1]) a = [k, x];
  }
  return { nuisance: n, amenity: a };
}
