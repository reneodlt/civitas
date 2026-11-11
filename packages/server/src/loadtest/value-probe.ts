/**
 * Neighbourhood value probe (docs/multiplayer-land.md M1): a seeded test city played for some days, for an A/B with
 * the field's effects off (VALUE=0: the field is kept, homes and growth ignore it). Prints moves of their own accord,
 * growth (levels, merged buildings, population), where homes stand on the value, and the hourly pass's cost.
 *
 *   npx tsx packages/server/src/loadtest/value-probe.ts [--districts 2] [--days 4]
 *   VALUE=0 npx tsx packages/server/src/loadtest/value-probe.ts ...
 */
import { TICKS_PER_DAY, Zone, isMergedKind, ValueKind } from '@msimcity/shared';
import { World } from '../world';
import { Simulation } from '../sim/simulation';
import { VALUE_FIELD } from '../sim/value';
import { seedCity } from './cities';
import { seededRandom } from '../demo/seed';

const argv = process.argv.slice(2);
const get = (n: string, d: number) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const districts = get('districts', 2), days = get('days', 4);
Math.random = seededRandom(0x7a1e);
const w = new World(4242);
seedCity(w, { districts, built: 1 });
const sim = new Simulation(w);
const t0 = performance.now();
for (let i = 0; i < days * TICKS_PER_DAY; i++) sim.tick();
const ms = performance.now() - t0;
let levels = 0, merged = 0, homes = 0, homeLv = 0, nuis = 0, sought = 0, low = 0, pop = 0;
let vSum = 0, vOcc = 0;
for (const b of w.buildings.values()) {
  levels += b.level;
  if (isMergedKind(b.id)) merged++;
  if (b.zone !== Zone.Residential || b.level <= 0) continue;
  homes++; homeLv += b.level; pop += b.occupants;
  const v = sim.value.valueAt(b.x, b.y), d = sim.value.ambitionDelta(b.x, b.y);
  vSum += v; vOcc += v * b.occupants;
  if (d < 0) low++; else if (d > 0) sought++;
  if (sim.value.kindAt(b.x, b.y, ValueKind.Noise) > 0.5) nuis++;
}
const st = sim.motive.stats, v = sim.value;
console.log(`value effects ${VALUE_FIELD.on ? 'ON' : 'OFF'}: ${districts}×${districts} districts, ${days} days, ${(ms / (days * TICKS_PER_DAY)).toFixed(2)} ms a tick`);
console.log(`  citizens ${w.citizens.size}, homes ${homes} (mean level ${(homeLv / homes).toFixed(2)}), residents ${pop}, all levels ${levels}, merged buildings ${merged}`);
console.log(`  moves ${st.moves} (${st.movedPeople} people), home looks ${st.homeLooks}, homes scored ${st.scoredHomes}`);
console.log(`  homes: mean value ${(vSum / homes).toFixed(3)}, resident-weighted ${(vOcc / Math.max(1, pop)).toFixed(3)}; ambition -1 at ${low}, +1 at ${sought}; noise > 50% at ${nuis}`);
console.log(`  value passes ${v.stats.passes}, ${(v.stats.ms / v.stats.passes).toFixed(2)} ms a pass, ${(v.stats.chunks / v.stats.passes).toFixed(1)} chunks a pass of ${v.size}`);
console.log(`VALUEPROBE ${JSON.stringify({ on: VALUE_FIELD.on, citizens: w.citizens.size, homes, pop, levels, merged, moves: st.moves, vHome: vSum / homes, vResident: vOcc / Math.max(1, pop), low, sought, passMs: v.stats.ms / v.stats.passes })}`);
