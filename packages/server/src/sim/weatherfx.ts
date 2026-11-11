import {
  WEATHER_TUNING as WT, DRIVE_MIN_TILES, hash2,
  weatherFor, setForcedWeather, isForcedWeather, darknessAt, walkMul, roadSpeedMul, collisionMul, buildMul, holdReason, weatherMood,
  type Weather,
} from '@msimcity/shared';
import type { World } from '../world';
import { env } from '../env';

// `WEATHER=rain|snow|fog|storm|clear|warm` forces a condition for the whole process (loadtests and checks; never live)
{ const f = env('WEATHER'); if (isForcedWeather(f)) setForcedWeather(f); }

/** The weather's effects this tick, computed once per tick per world (docs/weather.md W4). */
export interface WeatherNow {
  tick: number;
  w: Weather;
  /** the walk's perceived cost multiplier (mode choice) */
  walk: number;
  /** the share of car owners who drive trips from WEATHER_TUNING.driveMinWet tiles (DRIVE_MIN_TILES otherwise) */
  wetDrive: number;
  /** road pace on an ungritted tile, and on a gritted one */
  road: number; roadGritted: number;
  /** collision-rate multiplier (a hook) */
  crash: number;
  /** 0 day .. 1 night */
  dark: number;
  /** site work multiplier */
  build: number;
  /** flights and boats held, and why */
  hold: 'storm' | 'fog' | null;
}

const cache = new WeakMap<World, WeatherNow>();

/** The weather and its effects for the world's current tick (memoised per tick). Reads `weatherFor(World.seed, tick)`. */
export function weatherNow(world: World): WeatherNow {
  const tick = world.tick;
  let n = cache.get(world);
  if (n && n.tick === tick) return n;
  const w = weatherFor(world.seed, tick);
  const walk = walkMul(w);
  n = {
    tick, w, walk, wetDrive: Math.min(1, WT.wetDrive * (walk - 1)),
    road: roadSpeedMul(w, false), roadGritted: roadSpeedMul(w, true), crash: collisionMul(w),
    dark: darknessAt(w, tick), build: buildMul(w), hold: holdReason(w),
  };
  cache.set(world, n);
  return n;
}

/** A car owner's shortest drive now: DRIVE_MIN_TILES, or WEATHER_TUNING.driveMinWet for the hashed share who take the car in the wet. */
export function driveMinFor(world: World, id: number): number {
  const s = weatherNow(world).wetDrive;
  return s > 0 && hash2(id, 79) < s ? Math.min(DRIVE_MIN_TILES, WT.driveMinWet) : DRIVE_MIN_TILES;
}

/** The weather's part of happiness now (shared weatherMood), for happinessParts. */
export const moodNow = (world: World) => weatherMood(world.seed, world.tick);

/** Flights or boats held by the weather, or free again: for the news (sim/news.ts weather). */
export interface WeatherHold {
  what: 'flights' | 'river buses' | 'shipping';
  reason: 'storm' | 'fog';
  /** false when the hold starts, true when it lifts */
  lifted: boolean;
  /** the airport's door, the first pier, the harbour's door */
  x: number; y: number;
  owner?: string;
}
