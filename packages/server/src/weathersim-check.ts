/**
 * `npm run weathersim:check` (docs/weather.md W4): the weather's effects on the simulation point the right way and stay
 * deterministic.
 *
 *  1. the pure effects (shared/src/weatherfx.ts) under each forced condition: the walk, road pace, collisions (a hook),
 *     leisure appeal outdoors and in, power demand, wind output, faults, holds, site work and mood;
 *  2. a 1×1 test city (seedCity, built 3, a park, a cinema and a library placed as loadtest/leisure.ts does), Math.random
 *     seeded, run from midnight to 08:00 of day 2 and measured for half a day under `clear`, `rain` and `snow`: planned walks
 *     fall and drives rise in the wet, road speed falls, park visits fall; the same seed and condition repeat exactly;
 *  3. utilities (a substation and a gas plant in a 1×1 town, createGame): demand rises in the cold and the heat, street
 *     lighting draws at night and not at noon, turbines feather in a storm;
 *  4. the news line for a hold, and the weather read through World.seed.
 *
 *   npx tsx packages/server/src/weathersim-check.ts [--quick]
 */
import {
  TICKS_PER_DAY, TICKS_PER_HOUR, KIND_ID, Zone, isRoad, packTile, terrainOf, familyOf, subFor, planStructure, workOf, isMultiTile, tileKey, mulberry32,
  setForcedWeather, weatherFor, walkMul, roadSpeedMul, collisionMul, leisureMul, powerDemandMul, gasDemandMul, windOutputMul, faultMulOf, holdReason,
  buildMul, weatherMood, windAt, UTIL_WEATHER, type ForcedWeather,
} from '@msimcity/shared';
import { World, type Building } from './world';
import { Simulation } from './sim/simulation';
import { createGame } from './game';
import { News } from './sim/news';
import { seedCity } from './loadtest/cities';
import { weatherNow } from './sim/weatherfx';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const f2 = (v: number) => v.toFixed(2), pct = (v: number) => `${(100 * v).toFixed(1)}%`;
const DAY = TICKS_PER_DAY, TPH = TICKS_PER_HOUR;
const quick = process.argv.includes('--quick');
const SEED = 1, NOON = DAY + 12 * TPH, MIDNIGHT = DAY;
const force = (f: ForcedWeather | null, tick = NOON) => { setForcedWeather(f); return weatherFor(SEED, tick); };

// ---------------------------------------------------------------- 1. the pure effects
{
  const clear = force('clear'), rain = force('rain'), snow = force('snow'), fog = force('fog'), storm = force('storm'), warm = force('warm');
  ok(walkMul(clear) === 1 && walkMul(rain) > 1.5 && walkMul(snow) > walkMul(rain), `the walk: clear ${f2(walkMul(clear))}, rain ${f2(walkMul(rain))}, snow ${f2(walkMul(snow))}`);
  ok(roadSpeedMul(clear) === 1 && Math.abs(roadSpeedMul(rain) - 0.9) < 1e-9 && roadSpeedMul(snow) < 0.8 && roadSpeedMul(snow, true) > roadSpeedMul(snow) && roadSpeedMul(fog) < 1,
    `road pace: clear ${f2(roadSpeedMul(clear))}, rain ${f2(roadSpeedMul(rain))}, snow ${f2(roadSpeedMul(snow))} (gritted ${f2(roadSpeedMul(snow, true))}), fog ${f2(roadSpeedMul(fog))}`);
  ok(collisionMul(clear) === 1 && collisionMul(rain) > 1 && collisionMul(snow) > collisionMul(rain) && collisionMul(fog) > 1, `collision hook: rain ${f2(collisionMul(rain))}, snow ${f2(collisionMul(snow))}, fog ${f2(collisionMul(fog))}`);
  ok(leisureMul(rain, 1, false, 0) < leisureMul(clear, 1, false, 0) && leisureMul(clear, 1, false, 1) < leisureMul(clear, 1, false, 0) && leisureMul(warm, 1, false, 0) > leisureMul(clear, 1, false, 0),
    `a park: clear ${f2(leisureMul(clear, 1, false, 0))}, at night ${f2(leisureMul(clear, 1, true, 1))}, rain ${f2(leisureMul(rain, 1, false, 0))}, snow ${f2(leisureMul(snow, 1, false, 0))}, warm ${f2(leisureMul(warm, 1, false, 0))}`);
  ok(leisureMul(rain, 0, true, 1) > 1 && leisureMul(clear, 0, true, 1) === 1 && leisureMul(rain, 0, false, 0) === 1, `a cinema on a wet night ${f2(leisureMul(rain, 0, true, 1))}, a dry one ${f2(leisureMul(clear, 0, true, 1))}`);
  ok(powerDemandMul(clear) === 1 && powerDemandMul(snow) > 1 && powerDemandMul({ ...warm, tempC: 30 }) > 1 && gasDemandMul(snow) > gasDemandMul(clear),
    `power demand: 16 C ${f2(powerDemandMul(clear))}, -2 C ${f2(powerDemandMul(snow))}, 30 C ${f2(powerDemandMul({ ...warm, tempC: 30 }))}; heating gas (hook) -2 C ${f2(gasDemandMul(snow))}`);
  ok(windOutputMul(storm) === 0 && windOutputMul(rain) > windOutputMul(fog), `turbines (against 10 tiles/h): rain ${f2(windOutputMul(rain))}, fog ${f2(windOutputMul(fog))}, storm ${f2(windOutputMul(storm))} (feathered)`);
  ok(faultMulOf(storm, true) > faultMulOf(storm, false) && faultMulOf(storm, false) > 1 && faultMulOf(rain, true) === 1, `faults in a storm: overhead ×${faultMulOf(storm, true)}, buried and nodes ×${faultMulOf(storm, false)}, rain ×1`);
  ok(holdReason(storm) === 'storm' && holdReason(fog) === 'fog' && holdReason(rain) === null && holdReason(clear) === null, 'flights and boats held in storm and thick fog only');
  ok(buildMul(clear) === 1 && buildMul(snow) < 1 && buildMul(storm) < 1 && buildMul({ ...rain, rain: 0.9 }) < 1 && buildMul(rain) === 1,
    `site work: snow (frost) ×${f2(buildMul(snow))}, storm ×${f2(buildMul(storm))}, heavy rain 0.9 ×${f2(buildMul({ ...rain, rain: 0.9 }))}, steady rain 0.7 ×1`);
  setForcedWeather('rain'); const mr = weatherMood(SEED, NOON);
  setForcedWeather('warm'); const mw = weatherMood(SEED, NOON), mn = weatherMood(SEED, MIDNIGHT);
  setForcedWeather('clear'); const mc = weatherMood(SEED, NOON);
  ok(!!mr && mr.delta < 0 && !!mw && mw.delta > 0 && !mn && (!mc || mc.delta < mw.delta), `mood: rain "${mr?.label}" ${f2(mr?.delta ?? 0)}, warm noon (24 C) "${mw?.label}" +${f2(mw?.delta ?? 0)}, clear 16 C +${f2(mc?.delta ?? 0)}, midnight none`);
  // the hooks read the forced weather too
  setForcedWeather('storm');
  ok(UTIL_WEATHER.windMul(NOON, SEED) === 0 && windAt(NOON, SEED) === 0 && UTIL_WEATHER.faultMul(0, 0, NOON, true, SEED) > 1, 'UTIL_WEATHER.windMul and faultMul read the storm');
  setForcedWeather(null);
  // the real weather: deterministic, and every effect in range over a year of hours
  let same = true, inRange = true, n = 0, wet = 0, slow = 0;
  for (let h = 0; h < 24 * 7; h++) {
    const t = h * TPH + 37, a = weatherFor(SEED, t), b = weatherFor(SEED, t);
    if (JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(weatherMood(SEED, t)) !== JSON.stringify(weatherMood(SEED, t))) same = false;
    const wm = walkMul(a), rs = roadSpeedMul(a), lm = leisureMul(a, 1, false, 0), pd = powerDemandMul(a);
    if (!(wm >= 1 && wm < 4 && rs > 0.5 && rs <= 1 && lm >= 0 && lm < 2 && pd >= 1 && pd < 1.5)) inRange = false;
    n++; if (wm > 1.3) wet++; if (rs < 1) slow++;
  }
  ok(same && inRange, `the real weather (seed ${SEED}, a year of hours): deterministic and in range; the walk dearer in ${pct(wet / n)} of hours, roads slower in ${pct(slow / n)}`);
}

// ---------------------------------------------------------------- 2. a test city under clear, rain and snow
interface Run { walk: number; drive: number; transit: number; taxi: number; speed: number; park: number; indoor: number; happy: number; sig: string }
function cityRun(f: ForcedWeather): Run {
  setForcedWeather(f);
  Math.random = mulberry32(4242);
  const w = new World(SEED);
  const layout = seedCity(w, { districts: 1, built: 3 });
  const sim = new Simulation(w);
  const d0 = layout.districts[0];
  for (const [id, lx, ly] of [['park', 6, 2], ['cinema', 11, 8], ['library', 4, 17]] as [string, number, number][]) {
    const x = d0.x + lx, y = d0.y + ly, t = w.getTile(x, y), kind = KIND_ID[id as keyof typeof KIND_ID];
    if (isRoad(t) || !w.hasRoadAccess(x, y)) throw new Error(`(${x}, ${y}) is not a lot next to a road`);
    w.setTile(x, y, packTile(terrainOf(t), false, familyOf(kind), 1), subFor(kind));
  }
  const fill = DAY + 8 * TPH, span = quick ? 6 * TPH : 12 * TPH;
  for (let i = 0; i < fill; i++) sim.tick();
  const m0 = { ...sim.modeLog }, l0 = JSON.parse(JSON.stringify(sim.leisureStats)) as Record<string, number[]>;
  const tr = sim.traffic;
  let v = 0, s = 0;
  for (let i = 0; i < span; i++) { sim.tick(); v += tr.lastVehicles; s += tr.lastSpeedPct * tr.lastVehicles; }
  const visits = (t: string) => (sim.leisureStats[t] ?? []).reduce((a, n, h) => a + n - (l0[t]?.[h] ?? 0), 0);
  const cs = [...w.citizens.values()];
  const r: Run = {
    walk: sim.modeLog.walk - m0.walk, drive: sim.modeLog.drive - m0.drive, transit: sim.modeLog.transit - m0.transit, taxi: sim.modeLog.taxi - m0.taxi,
    speed: v ? s / v : 1, park: visits('park'), indoor: visits('cinema') + visits('library'), happy: cs.reduce((a, c) => a + c.happy, 0) / Math.max(1, cs.length), sig: '',
  };
  r.sig = JSON.stringify([r.walk, r.drive, r.taxi, r.park, r.indoor, Math.round(r.speed * 1e6), cs.length, cs.reduce((a, c) => a + c.x + c.y, 0).toFixed(3)]);
  setForcedWeather(null);
  return r;
}
{
  const t0 = performance.now();
  const clear = cityRun('clear'), rain = cityRun('rain'), snow = cityRun('snow');
  const share = (r: Run) => r.walk / Math.max(1, r.walk + r.drive + r.transit + r.taxi);
  const row = (n: string, r: Run) => `${n}: walk ${r.walk} drive ${r.drive} transit ${r.transit} taxi ${r.taxi} (walk share ${pct(share(r))}), speed ${pct(r.speed)}, park visits ${r.park}, cinema+library ${r.indoor}, happiness ${r.happy.toFixed(1)}`;
  console.log(`     ${row('clear', clear)}\n     ${row('rain ', rain)}\n     ${row('snow ', snow)}`);
  ok(share(rain) < share(clear) && share(snow) < share(clear) && rain.drive > clear.drive, `the wet moves trips from walking to the car: walk share ${pct(share(clear))} -> rain ${pct(share(rain))}, snow ${pct(share(snow))}`);
  ok(rain.speed < clear.speed && snow.speed < clear.speed, `road speed: ${pct(clear.speed)} -> rain ${pct(rain.speed)}, snow ${pct(snow.speed)}`);
  ok(rain.park < clear.park && snow.park < clear.park, `park visits: ${clear.park} -> rain ${rain.park}, snow ${snow.park}`);
  ok(rain.happy < clear.happy, `happiness after a wet spell: ${clear.happy.toFixed(1)} -> ${rain.happy.toFixed(1)}`);
  const again = cityRun('rain');
  ok(again.sig === rain.sig, `deterministic: the same seed in the rain repeats exactly (${rain.sig})`);
  console.log(`     (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------------------------------------------------------------- 3. utilities
{
  Math.random = mulberry32(99);
  const w = new World(SEED);
  const layout = seedCity(w, { districts: 1, built: 3, seedOwner: 'ada' });
  const g = createGame(w, { onConnection() {} }, { devTools: false, sandbox: true });
  g.fires.enabled = false;
  const put = (kind: number, x: number, y: number, staff = 0): Building | null => {
    const p = planStructure(kind, x, y, { tile: (a, b) => w.peekTile(a, b), aux: (a, b) => w.auxAt(a, b), sub: (a, b) => w.subAt(a, b), land: () => null });
    if (isMultiTile(kind)) { if (!p.ok) throw new Error(`cannot place ${kind}: ${p.reason}`); w.placeStructure(p.placed, { work: workOf(kind, 1), priority: 0, built: true }); }
    else w.setTile(x, y, packTile(terrainOf(w.getTile(x, y)), false, Zone.Hub, 1), subFor(kind));
    const b = w.buildings.get(tileKey(x, y)) ?? null;
    if (b && staff) b.occupants = staff;
    return b;
  };
  const d = layout.districts[0];
  for (let k = 0; k < 4; k++) put(KIND_ID.substation, d.x + 1 + 5 * k, d.y + 6 + 5 * (k % 2));
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) w.setTile(d.x + 11 + i, d.y + 11 + j, packTile(terrainOf(w.getTile(d.x + 11 + i, d.y + 11 + j)), false, 0, 0));
  put(KIND_ID['gas-plant'], d.x + 12, d.y + 14, 24);
  while (w.tick < NOON) g.step();
  const u = g.utilities;
  const demandAt = (f: ForcedWeather) => { setForcedWeather(f); u.solve(); const h = u.hourly.get('ada') ?? [...u.hourly.values()][0]; const out = { demand: h?.demand ?? 0, lights: u.weatherHour.lighting, mul: u.weatherHour.demandMul }; setForcedWeather(null); return out; };
  const noon = { clear: demandAt('clear'), snow: demandAt('snow'), warm: demandAt('warm') };
  while (w.tick < DAY + 23 * TPH) g.step();
  const night = { clear: demandAt('clear'), snow: demandAt('snow') };
  setForcedWeather(null);
  console.log(`     ${u.field.nodes.length} substations, ${Array.from(u.field.served).reduce((a, b) => a + b, 0)} road tiles lit; demand at noon: clear ${noon.clear.demand.toFixed(1)}, snow (-2 C) ${noon.snow.demand.toFixed(1)}, warm (24 C) ${noon.warm.demand.toFixed(1)}; at 23:00: clear ${night.clear.demand.toFixed(1)} (lighting ${night.clear.lights.toFixed(1)}), snow ${night.snow.demand.toFixed(1)}`);
  ok(noon.snow.demand > noon.clear.demand * 1.1 && noon.warm.demand > noon.clear.demand && noon.clear.lights === 0, `demand rises in the cold (×${f2(noon.snow.demand / Math.max(1e-9, noon.clear.demand))}) and the heat (×${f2(noon.warm.demand / Math.max(1e-9, noon.clear.demand))}); no street lighting at noon`);
  ok(night.clear.lights > 0 && night.clear.demand > night.clear.lights, `street lighting draws at night: ${night.clear.lights.toFixed(1)} units of ${night.clear.demand.toFixed(1)}`);
}

// ---------------------------------------------------------------- 4. the news, and the world's seed
{
  const w = new World(SEED);
  seedCity(w, { districts: 1, built: 1 });
  const news = new News(w);
  news.weather({ what: 'flights', reason: 'fog', lifted: false, x: 3, y: 3 });
  const st = news.all()[news.all().length - 1];
  ok(st?.k === 'weather' && /Fog grounds flights/.test(st.h), `a hold makes the news: "${st?.h}"`);
  w.tick += 50;
  news.weather({ what: 'flights', reason: 'fog', lifted: true, x: 3, y: 3 });
  const st2 = news.all()[news.all().length - 1];
  ok(st2.id === st.id && /Flights land again/.test(st2.h) && (st2.end ?? 0) > w.tick, `and lifting it updates the story: "${st2.h}"`);
  const a = new World(7), b = new World(8);
  a.tick = b.tick = 5 * DAY + 3 * TPH;
  ok(weatherNow(a).w === weatherFor(7, a.tick) || JSON.stringify(weatherNow(a).w) === JSON.stringify(weatherFor(7, a.tick)), 'the server reads weatherFor(World.seed, tick)');
  void b;
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall weathersim checks passed');
if (failed) process.exit(1);
