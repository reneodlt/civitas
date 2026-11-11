import { TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { hash2 } from './noise';

/**
 * Weather and seasons (docs/weather.md sections 2-3, phase W1): a pure function of the world seed and the tick.
 *
 * Nothing is stored and nothing goes over the wire: the server, every client and the local-mode worker call
 * `weatherAt(seed, tick)` and get the same answer (no Date, no Math.random, no Node APIs; only `hash2` and arithmetic).
 * Results are memoised per game hour (a few small caches below, bounded; a cold cache gives the same numbers as a warm one).
 *
 * COMPASS CONVENTION (tile space). North is -y, south is +y, east is +x, west is -x (the camera looks along
 * (-sin yaw, -cos yaw) in world x,z with z = tile y: yaw 0 looks north, 90 west; the world map is north-up with y down).
 * A bearing is clockwise from north in radians (0 north, PI/2 east, PI south, 3PI/2 west). A wind vector is the direction the
 * wind blows TOWARDS: for bearing b, dx = sin b and dy = -cos b, so a westerly wind (from the west) has dx = +1, dy = 0.
 * `Weather.wind.dir` is that bearing in radians in [0, 2PI). `Climate.rose[i]` blows towards i * 22.5 degrees clockwise
 * from north (i 0 north, 4 east, 8 south, 12 west). `dayForecast().windFrom` names where the wind comes from ('W' for dx = +1).
 *
 * Time. A game hour is TICKS_PER_HOUR ticks; the year is one game week (7 * TICKS_PER_DAY), phase 0 the start of spring.
 * Spring 0..0.25, summer 0.25..0.5, autumn 0.5..0.75, winter 0.75..1; warmest at phase 0.33, coldest at 0.83.
 * Pressure systems last 1-3 game days (slot boundaries hashed round 48 h slots, blended over 8 h at each front).
 * Everything is computed at whole game hours and interpolated between them.
 */

export interface WindVec { dx: number; dy: number }
export interface Climate {
  /** unit vector in tile space: the direction the wind most often blows towards (the rose's biggest bin) */
  prevailing: WindVec;
  /** tiles per game hour */
  meanSpeed: number;
  /** 0..1 rain tendency */
  wetness: number;
  /** seasonal temperature half-range, degrees C */
  swing: number;
  /** 16 directions, i * 22.5 degrees clockwise from north in tile space, wind blowing TOWARDS; shares sum to 1 */
  rose: { dx: number; dy: number; share: number; speed: number }[];
}
export interface Weather {
  /** year phase 0..1 (0 the start of spring) */
  season: number;
  tempC: number;
  /** dir: bearing in radians clockwise from north the wind blows towards; dx, dy its unit vector; speed and gust in tiles per game hour */
  wind: { dir: number; dx: number; dy: number; speed: number; gust: number };
  cloud: number;
  /** 0..1 intensity; falls as snow when `snow` */
  rain: number;
  snow: boolean;
  fog: number;
  /** 0..1 lying snow */
  snowCover: number;
  storm: boolean;
  /** sunrise and sunset, game hours */
  daylight: [number, number];
  system: 'low' | 'ridge' | 'high' | 'calm';
}
export type SeasonName = 'spring' | 'summer' | 'autumn' | 'winter';
export interface DayForecast { sky: string; wet: boolean; hi: number; lo: number; wind: number; windFrom: string }

const TICKS_PER_YEAR = TICKS_PER_DAY * 7;
const HOURS_PER_YEAR = 24 * 7;
const TAU = Math.PI * 2;
const SLOT = 48; // hours: the nominal length of a pressure system
const BLEND = 4; // hours either side of a front
const COVER_BACK = 72; // hours of look-back for lying snow
const WARMEST = 0.33;
const ROSE_YEARS = 8; // the rose is the model over this many years (one year is only about three and a half systems)
/** the compass names; index i is the bearing i * 22.5 deg */
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => { t = clamp01(t); return t * t * (3 - 2 * t); };

/** A hash of (seed, a, b) in [0,1). The seed is folded to an integer first so large seeds keep their entropy. */
function H(seed: number, a: number, b: number): number {
  const k = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(a | 0, 0x85ebca6b)) >>> 0;
  return hash2(k % 4194301, (b | 0) + 17);
}
/** smooth value noise in [0,1) along x, one lattice point per unit */
function vn(seed: number, salt: number, x: number): number {
  const i = Math.floor(x), f = smooth(x - i);
  return lerp(H(seed, salt, i), H(seed, salt, i + 1), f);
}

export function seasonOf(tick: number): { phase: number; name: SeasonName } {
  const p = tick / TICKS_PER_YEAR, phase = p - Math.floor(p);
  return { phase, name: phase < 0.25 ? 'spring' : phase < 0.5 ? 'summer' : phase < 0.75 ? 'autumn' : 'winter' };
}

// ---------------------------------------------------------------- climate

interface RawClimate { bearing: number; meanSpeed: number; wetness: number; swing: number; mean: number }
interface State {
  raw: RawClimate;
  climate: Climate | null;
  hours: Map<number, Rec>;
  covers: Map<number, Float32Array>;
  systems: Map<number, Sys>;
}
const states = new Map<number, State>();
const MAX_STATES = 8, MAX_HOURS = 1024, MAX_COVERS = 24, MAX_SYSTEMS = 256;

function stateOf(seed: number): State {
  let s = states.get(seed);
  if (s) return s;
  // prevailing wind: mostly from the west (blowing towards the east, bearing 90 deg), spread by a triangular draw; 1 world in 7 is odd
  const odd = H(seed, 900, 1) < 0.14;
  const bearingDeg = odd ? H(seed, 900, 2) * 360 : 90 + (H(seed, 900, 3) + H(seed, 900, 4) - 1) * 80;
  const raw: RawClimate = {
    bearing: ((((Math.round(bearingDeg / 22.5) * 22.5) % 360) + 360) % 360) * Math.PI / 180,
    meanSpeed: 6 + 8 * H(seed, 901, 1),
    wetness: 0.2 + 0.65 * H(seed, 901, 2),
    swing: 6 + 8 * H(seed, 901, 3),
    mean: 10 + 2 * H(seed, 901, 4),
  };
  s = { raw, climate: null, hours: new Map(), covers: new Map(), systems: new Map() };
  if (states.size >= MAX_STATES) states.delete(states.keys().next().value as number);
  states.set(seed, s);
  return s;
}
function trim<K, V>(m: Map<K, V>, max: number) {
  if (m.size <= max) return;
  let n = m.size - (max >> 1);
  for (const k of m.keys()) { if (n-- <= 0) break; m.delete(k); }
}

// ---------------------------------------------------------------- pressure systems

type SysType = 'low' | 'ridge' | 'high' | 'calm';
interface Sys { type: SysType; speedMul: number; cloud: number; rainLvl: number; anomaly: number; fog: number; dirA: number; dirB: number; wobble: number; stormy: boolean }

/** where system k begins, in game hours: the slot edge moved by up to 12 hours, so a system lasts 24 to 72 hours */
const bound = (seed: number, k: number) => SLOT * k + 24 * (H(seed, 10, k) - 0.5);

function sysOf(st: State, seed: number, k: number): Sys {
  let s = st.systems.get(k);
  if (s) return s;
  const { wetness } = st.raw;
  const ph = ((SLOT * k) / HOURS_PER_YEAR) % 1;
  const cold = (1 - Math.cos(TAU * (ph - WARMEST))) / 2; // 0 at the warmest, 1 at the coldest
  const u = H(seed, 11, k), r = (i: number) => H(seed, 12 + i, k);
  const pLow = 0.2 + 0.5 * wetness + 0.12 * cold;
  let type: SysType = u < pLow ? 'low' : u < pLow + (1 - pLow) * 0.45 ? 'ridge' : 'high';
  if (type === 'high' && cold > 0.6 && r(0) < 0.55) type = 'calm';
  const d = Math.PI / 180;
  switch (type) {
    case 'low': s = { type, speedMul: 1.35 + 0.5 * r(1), cloud: 0.75 + 0.25 * r(2), rainLvl: 0.35 + 0.65 * r(3), anomaly: 2 * cold - 1.5 * (1 - cold), fog: 0, dirA: (-45 + 90 * r(4)) * d, dirB: (-45 + 90 * r(5)) * d, wobble: 25 * d, stormy: r(6) < 0.05 + 0.25 * cold }; break;
    case 'ridge': s = { type, speedMul: 0.9 + 0.3 * r(1), cloud: 0.15 + 0.3 * r(2), rainLvl: 0.05 * r(3), anomaly: 0, fog: 0, dirA: (-12 + 24 * r(4)) * d, dirB: (-12 + 24 * r(5)) * d, wobble: 15 * d, stormy: false }; break;
    case 'high': s = { type, speedMul: 0.35 + 0.2 * r(1), cloud: 0.2 * r(2), rainLvl: 0, anomaly: 2.5 * (1 - 2 * cold), fog: 0.7 * r(7), dirA: (-80 + 160 * r(4)) * d, dirB: (-80 + 160 * r(5)) * d, wobble: 35 * d, stormy: false }; break;
    default: s = { type, speedMul: 0.12 + 0.1 * r(1), cloud: 0.6 + 0.3 * r(2), rainLvl: 0, anomaly: -3, fog: 0.6 + 0.4 * r(7), dirA: (-90 + 180 * r(4)) * d, dirB: (-90 + 180 * r(5)) * d, wobble: 35 * d, stormy: false };
  }
  st.systems.set(k, s);
  trim(st.systems, MAX_SYSTEMS);
  return s;
}

// ---------------------------------------------------------------- the hourly record

interface Rec { temp: number; dx: number; dy: number; speed: number; gust: number; cloud: number; rain: number; fog: number; storm: boolean; system: SysType; snow: boolean }

/** the diurnal curve in -1..1: coldest at 05:00, warmest at 15:00 */
function diurnal(hod: number): number {
  if (hod >= 5 && hod <= 15) return -Math.cos(Math.PI * (hod - 5) / 10);
  const t = hod > 15 ? hod - 15 : hod + 9; // hours since 15:00, 0..14
  return Math.cos(Math.PI * t / 14);
}

function recOf(seed: number, h: number): Rec {
  const st = stateOf(seed);
  let rec = st.hours.get(h);
  if (rec) return rec;
  const { raw } = st;
  // which system, and the front blend
  let j = Math.floor(h / SLOT);
  for (let n = j - 1; n <= j + 1; n++) if (bound(seed, n) <= h && h < bound(seed, n + 1)) { j = n; break; }
  const b0 = bound(seed, j), b1 = bound(seed, j + 1), dPrev = h - b0, dNext = b1 - h;
  const here = sysOf(st, seed, j);
  let A = here, B = here, w = 0, aj = j, bj = j;
  if (dPrev < BLEND) { aj = j - 1; A = sysOf(st, seed, aj); w = smooth((dPrev + BLEND) / (2 * BLEND)); }
  else if (dNext < BLEND) { bj = j + 1; B = sysOf(st, seed, bj); w = smooth((BLEND - dNext) / (2 * BLEND)); }
  const dom = w < 0.5 ? A : B, domJ = w < 0.5 ? aj : bj;
  const mix = (f: (s: Sys) => number) => lerp(f(A), f(B), w);
  const offAt = (s: Sys, k: number) => { const lo = bound(seed, k), hi = bound(seed, k + 1); return lerp(s.dirA, s.dirB, clamp01((h - lo) / (hi - lo))); };
  const off = lerp(offAt(A, aj), offAt(B, bj), w);
  const wob = mix((s) => s.wobble);

  const ph = (h / HOURS_PER_YEAR) % 1, hod = ((h % 24) + 24) % 24;
  const seasonal = Math.cos(TAU * (ph - WARMEST));
  // cloud and rain
  let cloud = clamp01(mix((s) => s.cloud) + (vn(seed, 20, h / 5) - 0.5) * 0.4);
  const rainLvl = mix((s) => s.rainLvl);
  let rain = 0;
  if (rainLvl > 0.02) {
    const f = Math.min(0.95, rainLvl * (0.6 + 0.8 * raw.wetness));
    rain = clamp01((vn(seed, 21, h / 2.5) - (1 - f)) / 0.35);
  }
  if (rain > 0) cloud = Math.max(cloud, 0.55 + 0.4 * rain);
  // wind
  const bearing = raw.bearing + off + (vn(seed, 22, h / 2.5) - 0.5) * 2 * wob;
  const dx = Math.sin(bearing), dy = -Math.cos(bearing);
  const speed = raw.meanSpeed * mix((s) => s.speedMul) * (0.75 + 0.5 * vn(seed, 23, h / 3));
  const gn = vn(seed, 24, h * 0.9);
  const gust = speed * (1.15 + (dom.type === 'low' ? 0.9 : 0.5) * gn * gn);
  const storm = dom.stormy && rain > 0.4 && gust > raw.meanSpeed * 2.2 && domJ === j;
  // temperature
  const tMean = raw.mean + raw.swing * seasonal + mix((s) => s.anomaly) + (vn(seed, 25, h / 20) - 0.5) * 2 - 1.5 * rain;
  const temp = tMean + (2 + 4 * (1 - cloud)) * diurnal(hod);
  // fog: high pressure at dawn, calm for days in a winter inversion, burnt off by wind and washed out by rain
  const dawn = Math.exp(-(((hod - 6.5) / 2.2) ** 2));
  const fogBase = mix((s) => s.fog);
  const fog = clamp01(fogBase * (dom.type === 'calm' ? 0.6 + 0.4 * dawn : dawn) * (1 - Math.min(1, speed / (raw.meanSpeed * 0.8))) * (1 - rain));
  rec = { temp, dx, dy, speed, gust, cloud, rain, fog, storm, system: dom.type, snow: rain > 0.05 && temp < 1 };
  st.hours.set(h, rec);
  trim(st.hours, MAX_HOURS);
  return rec;
}

/**
 * Lying snow at game hour h. Each game day's hours are simulated once from a fixed start 72 hours before that day, so the
 * answer never depends on what was cached or asked first.
 */
function coverOf(seed: number, h: number): number {
  const st = stateOf(seed), day = Math.floor(h / 24);
  let arr = st.covers.get(day);
  if (!arr) {
    arr = new Float32Array(COVER_BACK + 24);
    const start = day * 24 - COVER_BACK;
    let c = 0;
    for (let i = 0; i < arr.length; i++) {
      const r = recOf(seed, start + i);
      if (r.snow) c += Math.min(0.3, 0.05 + 0.3 * r.rain);
      else if (r.temp > 0.5) c -= 0.03 + 0.025 * r.temp;
      else c -= 0.004;
      c = clamp01(c);
      arr[i] = c;
    }
    st.covers.set(day, arr);
    trim(st.covers, MAX_COVERS);
  }
  return arr[h - (day * 24 - COVER_BACK)];
}

// ---------------------------------------------------------------- public

/**
 * The world's climate: prevailing wind (the rose's biggest bin), its mean strength, wetness, seasonal swing, and the wind
 * rose, counted once per seed over ROSE_YEARS years of the model. Do not mutate.
 */
export function climateOf(seed: number): Climate {
  const st = stateOf(seed);
  if (st.climate) return st.climate;
  const cnt = new Array<number>(16).fill(0), sp = new Array<number>(16).fill(0);
  const n = HOURS_PER_YEAR * ROSE_YEARS;
  for (let h = 0; h < n; h++) {
    const r = recOf(seed, h);
    let b = Math.round(Math.atan2(r.dx, -r.dy) / (TAU / 16));
    b = ((b % 16) + 16) % 16;
    cnt[b]++; sp[b] += r.speed;
  }
  const rose = cnt.map((c, i) => ({ dx: Math.sin(i * TAU / 16), dy: -Math.cos(i * TAU / 16), share: c / n, speed: c ? sp[i] / c : st.raw.meanSpeed }));
  let best = 0;
  for (let i = 1; i < 16; i++) if (rose[i].share > rose[best].share) best = i;
  st.climate = { prevailing: { dx: rose[best].dx, dy: rose[best].dy }, meanSpeed: st.raw.meanSpeed, wetness: st.raw.wetness, swing: st.raw.swing, rose };
  return st.climate;
}

/** The world's mean wind speed, tiles per game hour (cheap: no rose; `climateOf(seed).meanSpeed` is the same number). */
export const meanWindOf = (seed: number): number => stateOf(seed).raw.meanSpeed;

let lastSeed = NaN, lastTick = NaN, lastW: Weather | null = null;

/** The weather at a tick, the same on every machine. The returned object is shared by repeat calls: do not mutate it. */
export function weatherAt(seed: number, tick: number): Weather {
  if (seed === lastSeed && tick === lastTick && lastW) return lastW;
  const hf = tick / TICKS_PER_HOUR, h = Math.floor(hf), f = hf - h;
  const a = recOf(seed, h), b = f > 0 ? recOf(seed, h + 1) : a;
  const { phase } = seasonOf(tick);
  let dx = lerp(a.dx, b.dx, f), dy = lerp(a.dy, b.dy, f);
  const dl = Math.hypot(dx, dy) || 1;
  dx /= dl; dy /= dl;
  const dir = ((Math.atan2(dx, -dy) % TAU) + TAU) % TAU;
  const temp = lerp(a.temp, b.temp, f), rain = lerp(a.rain, b.rain, f);
  const len = 12 + 4 * Math.cos(TAU * (phase - WARMEST));
  const w: Weather = {
    season: phase,
    tempC: temp,
    wind: { dir, dx, dy, speed: lerp(a.speed, b.speed, f), gust: lerp(a.gust, b.gust, f) },
    cloud: lerp(a.cloud, b.cloud, f),
    rain,
    snow: rain > 0.05 && temp < 1,
    fog: lerp(a.fog, b.fog, f),
    snowCover: lerp(coverOf(seed, h), coverOf(seed, f > 0 ? h + 1 : h), f),
    storm: a.storm,
    daylight: [12 - len / 2, 12 + len / 2],
    system: a.system,
  };
  lastSeed = seed; lastTick = tick; lastW = w;
  return w;
}

/** Name of the compass point a wind blowing towards (dx, dy) comes FROM. */
function fromName(dx: number, dy: number): string {
  const towards = Math.round(Math.atan2(dx, -dy) / (TAU / 16));
  return POINTS[(((towards + 8) % 16) + 16) % 16];
}

/**
 * The forecast for a game day, read off the model's 24 hours: sky words, whether it is wet (rain or snow for three hours or
 * more), the high and low in whole degrees C, the mean wind in mph (1.8 per tile per game hour) and the point it comes from.
 */
export function dayForecast(seed: number, day: number): DayForecast {
  let hi = -99, lo = 99, wet = 0, snow = 0, storm = false, cloud = 0, fogMax = 0, sx = 0, sy = 0, sp = 0;
  for (let i = 0; i < 24; i++) {
    const r = recOf(seed, day * 24 + i);
    if (r.temp > hi) hi = r.temp;
    if (r.temp < lo) lo = r.temp;
    if (r.rain > 0.15) { wet++; if (r.snow) snow++; }
    if (r.storm) storm = true;
    cloud += r.cloud / 24; if (r.fog > fogMax) fogMax = r.fog;
    sx += r.dx * r.speed; sy += r.dy * r.speed; sp += r.speed / 24;
  }
  const mean = stateOf(seed).raw.meanSpeed;
  let sky: string;
  if (snow >= 3) sky = wet >= 8 ? 'Snow' : 'Snow showers';
  else if (storm) sky = wet >= 3 ? 'Thundery showers' : 'Gales';
  else if (wet >= 10) sky = 'Rain';
  else if (wet >= 3) sky = 'Showers';
  else if (fogMax > 0.45) sky = 'Fog clearing';
  else if (cloud > 0.7) sky = wet >= 1 ? 'Drizzle' : 'Cloudy';
  else if (cloud < 0.3) sky = sp > 1.2 * mean ? 'Bright and breezy' : 'Sunny';
  else sky = 'Sunny spells';
  return { sky, wet: wet >= 3, hi: Math.round(hi), lo: Math.round(lo), wind: Math.round(sp * 1.8), windFrom: fromName(sx, sy) };
}

// ---- the sun's path ----------------------------------------------------------------------------------------------

/**
 * The world's latitude for the sun's path, chosen so the longest day is 12 + 4 hours as `Weather.daylight` has it
 * (cos H0 = -tan(lat) tan(23.44°) = cos(120°)): about 49° north, the latitude of northern France.
 */
const TILT = (23.44 * Math.PI) / 180;
const LAT = Math.atan(0.5 / Math.tan(TILT));

/** The sun's declination for a year phase, solved so the day length is exactly `Weather.daylight`'s. */
export function sunDeclination(phase: number): number {
  const len = 12 + 4 * Math.cos(TAU * (phase - WARMEST));
  const h0 = (len / 24) * Math.PI; // half the day, as an hour angle
  return Math.atan(-Math.cos(h0) / Math.tan(LAT));
}

/**
 * Where the sun is at `hour` (0-24, may be fractional) on a day of the year `phase` (seasonOf(tick).phase), as a unit
 * vector from the ground towards it in world axes: `x` east, `y` up, `z` south (tile +y; the compass of this file's
 * header). Noon is due south; it rises north of east in summer and south of east in winter, and stands about 64° up
 * at midsummer noon, 41° at the equinoxes and 18° at midwinter. `elev` is the sine of its height (negative below the
 * horizon).
 */
export function sunAt(phase: number, hour: number): { x: number; y: number; z: number; elev: number } {
  const d = sunDeclination(phase), H = ((hour - 12) / 24) * TAU;
  const east = -Math.cos(d) * Math.sin(H);
  const north = Math.sin(d) * Math.cos(LAT) - Math.cos(d) * Math.cos(H) * Math.sin(LAT);
  const up = Math.sin(d) * Math.sin(LAT) + Math.cos(d) * Math.cos(H) * Math.cos(LAT);
  return { x: east, y: up, z: -north, elev: up };
}
