import { TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { WEATHER_TUNING as WT } from './tuning';
import { weatherAt, seasonOf, sunAt, type Weather } from './weather';

/**
 * What the weather does to the simulation (docs/weather.md W4): pure functions of a `Weather` (and the hour), read by the
 * server's sim/weatherfx.ts once a tick, and by the shared utility hooks (UTIL_WEATHER) on both sides. Tunables are
 * WEATHER_TUNING (shared/src/tuning.ts). Everything is 1 (or 0) in mild dry weather by day.
 *
 * Forced weather (tests, `WEATHER=rain|snow|fog|storm|clear` on the server): `setForcedWeather` makes every read here
 * return that condition at every tick (the wind direction stays the world's), with the same values as the client's
 * `?weather=` (render/weather.ts FORCED). Never set in a live game.
 */

/** `warm` (a sunny 24 C afternoon's sky all day) is the server's own, for the warm-day effects; the rest match the client's `?weather=`. */
export type ForcedWeather = 'rain' | 'snow' | 'fog' | 'storm' | 'clear' | 'warm';
export const isForcedWeather = (s: unknown): s is ForcedWeather => s === 'rain' || s === 'snow' || s === 'fog' || s === 'storm' || s === 'clear' || s === 'warm';

const FORCED: Record<ForcedWeather, Partial<Weather> & { speed?: number; gust?: number }> = {
  clear: { cloud: 0, rain: 0, fog: 0, snowCover: 0, snow: false, storm: false, tempC: 16, system: 'high' },
  rain: { cloud: 0.9, rain: 0.7, fog: 0, snowCover: 0, snow: false, storm: false, tempC: 9, speed: 13, gust: 18, system: 'low' },
  snow: { cloud: 0.85, rain: 0.6, fog: 0.15, snowCover: 0.95, snow: true, storm: false, tempC: -2, speed: 8, gust: 11, system: 'low' },
  fog: { cloud: 0.5, rain: 0, fog: 0.85, snowCover: 0, snow: false, storm: false, tempC: 6, speed: 3, gust: 4, system: 'calm' },
  warm: { cloud: 0.1, rain: 0, fog: 0, snowCover: 0, snow: false, storm: false, tempC: 24, speed: 6, gust: 8, system: 'high' },
  storm: { cloud: 1, rain: 1, fog: 0, snowCover: 0, snow: false, storm: true, tempC: 8, speed: 30, gust: 48, system: 'low' },
};
let forced: ForcedWeather | null = null;
/** Force a condition everywhere (tests and loadtests); null for the real weather. */
export function setForcedWeather(f: ForcedWeather | null) { forced = f; moodCache.clear(); forcedGen++; }
export const forcedWeather = () => forced;
/**
 * A scripted spell (W6 checks: a storm or a flood spell a day ahead): `script(tick)` names a condition for that tick, or
 * null for the forced condition or the real weather. Must be a pure function of the tick. Never set in a live game.
 */
let script: ((tick: number) => ForcedWeather | null) | null = null;
export function setWeatherScript(s: ((tick: number) => ForcedWeather | null) | null) { script = s; moodCache.clear(); forcedGen++; }
/** bumped whenever the forced weather or the script changes: caches of anything read through weatherFor key on it */
let forcedGen = 0;
export const weatherGen = () => forcedGen;

/** The weather the simulation reads: W1's model, or the forced condition. Do not mutate the result. */
export function weatherFor(seed: number, tick: number): Weather {
  const w = weatherAt(seed, tick);
  const f0 = (script && script(tick)) || forced;
  if (!f0) return w;
  const { speed, gust, ...f } = FORCED[f0];
  return { ...w, ...f, wind: { ...w.wind, speed: speed ?? w.wind.speed, gust: gust ?? w.wind.gust } };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hourOf = (tick: number) => (((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY) / TICKS_PER_HOUR;

/** How dark it is outside, 0 (day) to 1 (night): the sun's height (sunAt; dusk and dawn shade it), thick fog darkens the day. */
export function darknessAt(w: Weather, tick: number): number {
  const elev = sunAt(seasonOf(tick).phase, hourOf(tick)).elev;
  const sun = clamp01((0.08 - elev) / 0.14); // the sun 4.6° up: lamps go on; 3.4° below: full dark
  return Math.max(sun, clamp01((w.fog - 0.5) * 1.6) * 0.6);
}

/** The walk's perceived cost multiplier (>= 1): rain, falling and lying snow, cold. */
export function walkMul(w: Weather): number {
  let m = 1;
  if (w.rain > 0.05) m += (w.snow ? WT.walkSnow : WT.walkRain) * w.rain;
  m += WT.walkSnowCover * w.snowCover;
  m += Math.min(WT.coldMax, WT.walkCold * Math.max(0, WT.coldFrom - w.tempC));
  return m;
}

/** The road pace multiplier (<= 1) on a tile; `gritted` is whether the tile is gritted (no gritters yet: false). */
export function roadSpeedMul(w: Weather, gritted = false): number {
  let m = 1;
  if (w.rain > 0.15 && !w.snow) m *= 1 - (1 - WT.speedRain) * clamp01((w.rain - 0.15) / 0.55);
  if (w.snowCover > 0.05 && !gritted) m *= 1 - (1 - WT.speedSnow) * clamp01(w.snowCover);
  if (w.fog > 0.3) m *= 1 - (1 - WT.speedFog) * clamp01((w.fog - 0.3) / 0.5);
  return m;
}
/** Whether a road tile is gritted: W6's gritters (server sim/severe.ts) set it; nothing is until a gritter has been along. */
export const ROAD_WEATHER = { gritted: (_x: number, _y: number) => false };

/** The collision-rate multiplier (>= 1). A hook: no road collisions are simulated yet (docs/incidents.md). */
export function collisionMul(w: Weather): number {
  return 1 + WT.crashRain * (w.snow ? 0 : clamp01(w.rain)) + WT.crashSnow * Math.max(w.snowCover, w.snow ? w.rain : 0) + WT.crashFog * clamp01((w.fog - 0.3) / 0.5);
}

/**
 * A leisure place's appeal multiplier for the weather: `outdoor` 0 (indoors) to 1 (a park); `evening` the outing is after
 * 17:00; `dark` darknessAt. Outdoors: less in rain, cold and the dark, more on a warm dry day; indoors: more on a wet night.
 */
export function leisureMul(w: Weather, outdoor: number, evening: boolean, dark: number): number {
  const wet = w.rain > 0.05 ? w.rain : 0;
  let out = (1 - WT.outdoorRain * wet) * (1 - Math.min(0.6, WT.outdoorCold * Math.max(0, WT.outdoorColdFrom - w.tempC))) * (1 - WT.outdoorDark * dark);
  if (wet === 0 && w.cloud < 0.5 && w.tempC >= WT.warmFrom && dark < 0.5) out *= 1 + WT.outdoorWarm * clamp01((w.tempC - WT.warmFrom + 2) / 6);
  if (w.snowCover > 0.3 && wet === 0 && dark < 0.5) out = Math.max(out, 0.6); // a bright snowy day still gets people into the park
  const inside = evening ? 1 + WT.indoorWetNight * wet : 1;
  return outdoor * out + (1 - outdoor) * inside;
}

/** Power demand multiplier by temperature (electric heating in the cold, cooling in the heat), >= 1. */
export function powerDemandMul(w: Weather): number {
  return 1 + Math.min(WT.heatMax, WT.heatPerDeg * Math.max(0, WT.heatFrom - w.tempC)) + Math.min(WT.coolMax, WT.coolPerDeg * Math.max(0, w.tempC - WT.coolFrom));
}
/**
 * Heating gas demand multiplier (a hook: there is no gas network yet, docs/utilities.md): degrees below heatFrom as a
 * share of a cold day's 20 degrees, so 1 at heatFrom and 2 at heatFrom − 20.
 */
export function gasDemandMul(w: Weather): number { return 1 + Math.max(0, WT.heatFrom - w.tempC) / 20; }

/**
 * Wind turbines' output multiplier: the wind's speed against `ref` (the world's mean wind, meanWindOf, so a turbine
 * averages what it did before the weather; WT.windRef without one), up to WT.windMax; 0 when the gusts pass the cut-out.
 */
export function windOutputMul(w: Weather, ref: number = WT.windRef): number {
  if (w.wind.gust > WT.windCutout) return 0;
  return Math.min(WT.windMax, w.wind.speed / Math.max(1, ref));
}
/** Fault-rate multiplier: a storm raises overhead faults WT.faultStorm×, nodes and buried cable half as much. */
export function faultMulOf(w: Weather, overhead: boolean): number {
  return w.storm ? (overhead ? WT.faultStorm : 1 + (WT.faultStorm - 1) / 2) : 1;
}

/** Flights and boats held now: a storm or thick fog. The reason in words, or null. */
export function holdReason(w: Weather): 'storm' | 'fog' | null {
  return w.storm ? 'storm' : w.fog > WT.holdFog ? 'fog' : null;
}

/** Site work multiplier (<= 1): frost and lying snow, heavy rain. */
export function buildMul(w: Weather): number {
  let m = 1;
  if (w.tempC <= 0 || w.snowCover > 0.3) m *= WT.frostBuild;
  if (w.rain > WT.heavyRain && !w.snow) m *= WT.heavyRainBuild;
  return m;
}

const isGrey = (w: Weather) => w.cloud > 0.8 || w.rain > 0.15 || w.fog > 0.5;
const moodCache = new Map<string, { label: string; delta: number } | null>();
/**
 * The weather's part of everyone's happiness this game hour (life.ts happinessParts): a lift on a sunny warm day, a dip
 * after a grey spell (more than greyFrom of the last greyHours game hours grey or wet, sampled every 3 hours). A pure
 * function of the seed and the hour, memoised; null when the weather is neither.
 */
export function weatherMood(seed: number, tick: number): { label: string; delta: number } | null {
  const h = Math.floor(tick / TICKS_PER_HOUR), key = `${seed}|${h}|${forced ?? ''}|${forcedGen}`;
  if (moodCache.has(key)) return moodCache.get(key)!;
  let grey = 0, n = 0;
  for (let k = 0; k < WT.greyHours; k += 3) { n++; if (isGrey(weatherFor(seed, (h - k) * TICKS_PER_HOUR))) grey++; }
  const share = grey / n, now = weatherFor(seed, h * TICKS_PER_HOUR);
  let out: { label: string; delta: number } | null = null;
  const dark = darknessAt(now, h * TICKS_PER_HOUR + TICKS_PER_HOUR / 2);
  if (dark < 0.5 && now.cloud < 0.4 && now.rain < 0.05 && now.tempC >= WT.moodWarmFrom) out = { label: 'a sunny day', delta: WT.moodSun * clamp01(0.5 + (now.tempC - WT.moodWarmFrom) / 8) };
  else if (share > WT.greyFrom) out = { label: share > 0.9 ? 'days of grey, wet weather' : 'a grey spell', delta: -WT.moodGrey * clamp01((share - WT.greyFrom) / (1 - WT.greyFrom) + 0.25) };
  if (moodCache.size > 256) moodCache.clear();
  moodCache.set(key, out);
  return out;
}
