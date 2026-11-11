/**
 * Mobile jobs probe (docs/mobile-jobs.md): taxis, food delivery, bin rounds and parcel couriers in a test city.
 *
 *   npx tsx packages/server/src/loadtest/mobile.ts --districts 2 --days 3 [--seed 1] [--off]
 *
 * Builds an N×N-district test city (seedCity, built to level 3), runs it from midnight for --days game days with a
 * seeded Math.random, and prints for each day after the first (the first is the town filling up): taxi bookings,
 * pickups, fares, waits and rides; food orders placed, delivered and cancelled with order-to-door minutes; bin rounds and
 * homes emptied; sweeper rounds; parcels; fleet vehicles on the road; and the sim's ms per tick. `--off` runs the same
 * city with mobile jobs off (MOBILE.on = false) for the tick-cost comparison.
 *
 * `--grade tip|landfill|recycling|compost|incinerator` (docs/multiplayer-land.md M4) turns every old waste depot of the
 * city into a refuse site of that grade (a one-tile stand-in for the 2×2 building: the simulation reads only the door),
 * so the rounds run from graded sites end to end: the bins line then adds tonnes, the landfill levy, sales and the
 * regional fund.
 */
import { TICKS_PER_DAY, TICKS_PER_HOUR, Zone, MOBILE, isCabOffice, isWasteDepot, isCourierDepot, isFoodVenue, isRefuseDepot, REFUSE_GRADES, packTile, terrainOf, familyOf, subFor } from '@msimcity/shared';
import { World } from '../world';
import { Simulation } from '../sim/simulation';
import { seedCity } from './cities';

const DAY = TICKS_PER_DAY, TPH = TICKS_PER_HOUR;
const argv = process.argv.slice(2);
const get = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const districts = Number(get('districts') ?? 2), days = Number(get('days') ?? 3), seed = Number(get('seed') ?? 1);
MOBILE.on = !argv.includes('--off');

let a = seed * 2654435761;
Math.random = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const w = new World(seed);
seedCity(w, { districts, built: 3, lots: true });
const grade = get('grade') ? REFUSE_GRADES.find((g) => g.id === get('grade')) : undefined;
if (get('grade') && !grade) throw new Error(`--grade is one of ${REFUSE_GRADES.map((g) => g.id).join(', ')}`);
if (grade) {
  let n = 0;
  for (const b of [...w.buildings.values()]) if (b.zone === Zone.Industrial && b.level > 0 && isWasteDepot(b.id, b.x, b.y)) { w.setTile(b.x, b.y, packTile(terrainOf(w.getTile(b.x, b.y)), false, familyOf(grade.kindId), 1), subFor(grade.kindId)); n++; }
  console.log(`[mobile] ${n} old waste depots turned into ${grade.name}s`);
}
const sim = new Simulation(w);

const pct = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const snap = () => ({ taxi: { ...sim.taxis.stats }, food: { ...sim.delivery.stats }, bins: { ...sim.refuse.stats }, parcels: { ...sim.couriers.stats }, mob: { ...sim.mobile.stats }, minutes: sim.delivery.minutes.length, hours: sim.couriers.hours.length, modes: { ...sim.modeLog } });
const diff = <T extends Record<string, number>>(x: T, y: T) => Object.fromEntries(Object.keys(x).map((k) => [k, Math.round((x[k] - (y[k] ?? 0)) * 100) / 100])) as T;

console.log(`[mobile] ${districts}×${districts} districts, seed ${seed}, mobile jobs ${MOBILE.on ? 'on' : 'off'}`);
let s0 = snap(), simMs = 0, ticks = 0, onRoad = 0, peak = 0;
const byHour = new Array(24).fill(0);
while (w.tick < days * DAY) {
  const t0 = performance.now();
  sim.tick();
  if (w.tick > DAY) { simMs += performance.now() - t0; ticks++; }
  let n = 0;
  for (const u of sim.mobile.units.values()) if (u.v.lane >= 0) n++;
  onRoad += n; if (n > peak) peak = n;
  byHour[Math.floor((w.tick % DAY) / TPH)] += n;
  if (w.tick % DAY !== 0) continue;
  const day = w.tick / DAY - 1, s = snap();
  if (day === 0) {
    let cabs = 0, food = 0, waste = 0, parcel = 0;
    for (const b of w.buildings.values()) {
      if (b.level === 0) continue;
      if (isCabOffice(b.id, b.x, b.y)) cabs++;
      else if (isFoodVenue(b.id, b.x, b.y)) food++;
      if (isRefuseDepot(b.id, b.x, b.y)) waste++;
      else if (b.zone === Zone.Industrial && isCourierDepot(b.id, b.level, b.x, b.y)) parcel++;
    }
    console.log(`[mobile] ${w.citizens.size} citizens; ${cabs} cab offices, ${food} food venues, ${waste} waste depots, ${parcel} parcel depots`);
  } else {
    const t = diff(s.taxi, s0.taxi), fd = diff(s.food, s0.food), bn = diff(s.bins, s0.bins), pc = diff(s.parcels, s0.parcels), md = diff(s.modes, s0.modes);
    const mins = sim.delivery.minutes.slice(s0.minutes), hrs = sim.couriers.hours.slice(s0.hours);
    const trips = md.walk + md.drive + md.transit + md.taxi;
    console.log(`\n[mobile] day ${day} (weekday ${(day % 7)}), ${w.citizens.size} citizens`);
    console.log(`  taxis: ${t.booked} booked (${f1((100 * md.taxi) / Math.max(1, trips))}% of trips), ${t.pickedUp} picked up, ${t.delivered} set down at the door, ${t.gaveUp} gave up waiting, ${t.setDown} set down early (taxi stuck); fares $${Math.round(t.fares)}; wait ${f1(t.waitSum / Math.max(1, t.pickedUp) / (TPH / 60))} min, ride ${f1(t.rideSum / Math.max(1, t.delivered) / (TPH / 60))} min`);
    console.log(`  food: ${fd.placed} orders, ${fd.delivered} delivered, ${fd.cancelled} cancelled, ${fd.handedBack} handed back by a stuck rider, ${fd.failed} lost; order to door median ${f1(pct(mins, 0.5))} min, p90 ${f1(pct(mins, 0.9))}; ${fd.busy} turned away (busy); $${Math.round(fd.money)} spent`);
    console.log(`  bins: ${bn.rounds} rounds (${bn.homes} homes), ${bn.roundsDone} rounds completed, ${bn.homesDone} homes emptied, ${bn.lorries} lorries out, ${bn.unserved} homes with no depot in reach; ${bn.sweeps} sweeper rounds (${bn.sweepsDone} back)`);
    if (grade) console.log(`  refuse sites: ${bn.tonnes} t handled, levy $${bn.levy}, sales $${bn.sales}; regional fund $${Math.round(w.regional.fund)}`);
    console.log(`  parcels: ${pc.parcels} ordered, ${pc.delivered} delivered by ${pc.vans} vans, order to door median ${f1(pct(hrs, 0.5))} h`);
    console.log(`  fleet vehicles on the road: ${f1(onRoad / DAY)} mean, ${peak} peak; units ${JSON.stringify(diff(s.mob, s0.mob))}`);
    console.log(`  sim ${f1(simMs / Math.max(1, ticks) * 1000 / 1000)} ms/tick (${(simMs / Math.max(1, ticks)).toFixed(3)})`);
    onRoad = 0; peak = 0; simMs = 0; ticks = 0;
  }
  s0 = s;
}
console.log(`\n[mobile] fleet vehicles on the road by hour (sum over the run): ${byHour.map((v, h) => `${h}:${Math.round(v / TPH)}`).join(' ')}`);
