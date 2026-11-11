/**
 * `npm run value:check` (docs/multiplayer-land.md section 4, M1): the neighbourhood value field (sim/value.ts) on small
 * hand-built scenes and a big test city. Nuisance follows use (an idle depot or works gives off nothing, a busy one
 * does; mothballed nothing), smell reaches further downwind than upwind (the world's wind rose), the builder's own land
 * is hit as hard as a neighbour's, a Family-minded household's homeScore prefers the quieter home more than an
 * adventurous one's, the field is deterministic, a saved and loaded world rebuilds it, and the hourly pass's cost.
 *
 *   npx tsx packages/server/src/value-check.ts [--districts 6]
 */
import {
  Terrain, Zone, CitizenState, packTile, isWasteDepot, climateOf, valueKernels, ValueKind, VALUE, VALUE_SLOTS, valueWeights, combineValue, TICKS_PER_HOUR,
  DEFAULT_TAX,
} from '@msimcity/shared';
import { World, emptyStats, type Building, type Citizen } from './world';
import { ValueField, type ValueHost } from './sim/value';
import { Motivation, type MotiveHost } from './sim/motivation';
import { Simulation } from './sim/simulation';
import { seedCity } from './loadtest/cities';
import { snapshotOf, worldFromSnapshot } from './snapshot';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const argv = process.argv.slice(2);
const arg = (n: string, d: number) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const f2 = (v: number) => v.toFixed(2);

const SEED = 4242;
/** A scene: open grass round (0, 0), two owners' parcels side by side, a waste depot and a works on Ada's. */
function scene(handled: number, staff: number) {
  const w = new World(SEED);
  for (let y = -80; y < 80; y++) for (let x = -80; x < 80; x++) w.setTile(x, y, packTile(Terrain.Grass, false, 0, 0));
  for (const [owner, x0] of [['ada', -40], ['bob', 0]] as const) {
    w.getOrCreatePlayer(owner, owner, 0);
    const p = { id: w.nextId++, owner, name: owner, x: x0, y: -40, w: 40, h: 80, taxRate: DEFAULT_TAX, stats: emptyStats() };
    w.parcels.set(p.id, p);
    for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) w.setParcelId(x, y, p.id);
  }
  // a waste depot on Ada's land, 2 tiles from Bob's border: the first tile (scanning) the depot hash picks
  let depot: [number, number] = [0, 0];
  for (let x = -3; x > -40 && !depot[0]; x--) for (let y = -2; y <= 2; y++) if (isWasteDepot(Zone.Industrial, x, y)) { depot = [x, y]; break; }
  w.setTile(depot[0], depot[1], packTile(Terrain.Grass, false, Zone.Industrial, 2));
  // a works (not a depot) far away on Ada's land
  let works: [number, number] = [0, 0];
  for (let x = -30; x > -40 && !works[0]; x--) for (let y = 30; y <= 36; y++) if (!isWasteDepot(Zone.Industrial, x, y)) { works = [x, y]; break; }
  w.setTile(works[0], works[1], packTile(Terrain.Grass, false, Zone.Industrial, 3));
  // workers on shift at the works (the field counts citizens at Work there)
  for (let i = 0; i < staff; i++) w.citizens.set(900_000 + i, { id: 900_000 + i, state: CitizenState.Work, job: true, wx: works[0], wy: works[1] } as unknown as Citizen);
  const host: ValueHost = { eachMover() {}, eachStop() {}, handledAt: (x, y) => (x === depot[0] && y === depot[1] ? handled : 0), services: () => [] };
  const f = new ValueField(w, host);
  for (let h = 0; h < 40; h++) f.refresh(); // a day and more: the smoothing settles
  return { w, f, depot, works };
}

// ---- nuisance follows use ---------------------------------------------------------------------------
const idle = scene(0, 0), busy = scene(60, 40);
const smellNear = (s: ReturnType<typeof scene>) => s.f.kindAt(s.depot[0], s.depot[1], ValueKind.Smell);
console.log(`depot at (${busy.depot}), works at (${busy.works})`);
ok(smellNear(idle) === 0 && idle.f.kindAt(idle.depot[0], idle.depot[1], ValueKind.Traffic) === 0, `an idle depot gives off nothing (smell ${f2(smellNear(idle))})`);
ok(smellNear(busy) > 0.5, `a busy depot (60 homes a day) smells at its own cell: ${f2(smellNear(busy))}`);
ok(idle.f.kindAt(idle.works[0], idle.works[1], ValueKind.Noise) === 0, 'a works with nobody on shift is silent');
ok(busy.f.kindAt(busy.works[0], busy.works[1], ValueKind.Noise) > 0.3, `a works with 40 on shift is loud: noise ${f2(busy.f.kindAt(busy.works[0], busy.works[1], ValueKind.Noise))}`);
{
  const s = scene(60, 40);
  s.w.mothballed.add(`${s.depot[0]},${s.depot[1]}`);
  for (let h = 0; h < 30; h++) s.f.refresh();
  ok(s.f.kindAt(s.depot[0], s.depot[1], ValueKind.Smell) === 0, 'mothballed, the same depot gives off nothing');
}

// ---- wind: smell further downwind than upwind -------------------------------------------------------
{
  const rose = climateOf(SEED).rose;
  let dx = 0, dy = 0;
  for (const b of rose) { dx += b.share * b.dx; dy += b.share * b.dy; }
  const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
  const [x0, y0] = busy.depot, at = (d: number) => busy.f.kindAt(Math.round(x0 + dx * d), Math.round(y0 + dy * d), ValueKind.Smell);
  const reach = (sign: number) => { let r = 0; for (let d = 0; d <= 70; d += 2) if (busy.f.kindAt(Math.round(x0 + sign * dx * d), Math.round(y0 + sign * dy * d), ValueKind.Smell) > 0.02) r = d; return r; };
  console.log(`  wind blows towards (${f2(dx)}, ${f2(dy)}); smell at 16 tiles downwind ${f2(at(16))}, upwind ${f2(at(-16))}; reach down ${reach(1)}, up ${reach(-1)} tiles`);
  ok(at(16) > at(-16) * 2 && reach(1) > reach(-1) * 2, 'smell reaches further downwind than upwind');
  // the kernels themselves (cell-sized steps make single cells uneven): weight downwind of the source against upwind
  const half = (k: number) => {
    const ker = valueKernels(SEED)[k], n = 2 * ker.r + 1;
    let down = 0, up = 0;
    for (let j = -ker.r; j <= ker.r; j++) for (let i = -ker.r; i <= ker.r; i++) { const d = i * dx + j * dy, v = ker.w[(j + ker.r) * n + i + ker.r]; if (d > 0.5) down += v; else if (d < -0.5) up += v; }
    return [down, up];
  };
  const [nd, nu] = half(ValueKind.Noise), [sd, su] = half(ValueKind.Smell), [ed, eu] = half(ValueKind.Eyesore);
  ok(nd > nu * 1.1 && sd > su * 3 && Math.abs(ed - eu) < 0.01 * (ed + eu), `kernels: noise leans downwind (${f2(nd)} to ${f2(nu)}), smell is a plume (${f2(sd)} to ${f2(su)}), eyesore is round (${f2(ed)} to ${f2(eu)})`);
}

// ---- own land: the depot's border spoils Ada's side as much as Bob's ----------------------------------
{
  // the cells either side of the depot's cell: Ada's (west) and Bob's (east), for the round kinds (eyesore, lorries)
  const [x0, y0] = busy.depot, gx = Math.floor(x0 / 4), wx = (gx - 1) * 4 + 1, ex = (gx + 1) * 4 + 1;
  const round = (x: number) => busy.f.kindAt(x, y0, ValueKind.Eyesore) + busy.f.kindAt(x, y0, ValueKind.Traffic);
  const own = busy.w.parcelAt(wx, y0)?.owner, other = busy.w.parcelAt(ex, y0)?.owner, west = round(wx), east = round(ex);
  ok(own === 'ada' && other === 'bob' && west > 0.1 && Math.abs(west - east) < 0.02, `the builder's own land is hit as hard as the neighbour's (Ada's side ${f2(west)}, Bob's ${f2(east)})`);
  ok(busy.f.valueAt(wx, y0) < idle.f.valueAt(wx, y0), `value on Ada's own land falls beside her busy depot (${f2(busy.f.valueAt(wx, y0))} against ${f2(idle.f.valueAt(wx, y0))})`);
}

// ---- homeScore: a Family-minded household prefers the quiet home more than an adventurous one --------
{
  const s = busy, w = s.w;
  const near = { x: s.works[0] - 6, y: s.works[1] - 6, zone: Zone.Residential, id: Zone.Residential, level: 1, occupants: 1 } as Building;
  const far = { x: 30, y: -30, zone: Zone.Residential, id: Zone.Residential, level: 1, occupants: 0 } as Building;
  const m = new Motivation(w);
  const host = { value: (x: number, y: number, k: ArrayLike<number>) => s.f.valueAt(x, y, k) } as unknown as MotiveHost;
  const family = [0.05, 0.7, 0.05, 0.1, 0.05, 0.05], adventure = [0.1, 0.0, 0.1, 0.0, 0.15, 0.65];
  const tf = m.hoodTerm(family, host, near, far), ta = m.hoodTerm(adventure, host, near, far);
  const vf = (v: number[], b: Building) => f2(s.f.valueAt(b.x, b.y, valueWeights(v)));
  console.log(`  noisy home value ${vf(family, near)} (family) ${vf(adventure, near)} (adventure); quiet home ${vf(family, far)} / ${vf(adventure, far)}`);
  ok(tf > 0 && tf > ta, `homeScore's value term prefers the quiet home, more for a Family household (${f2(tf)}) than an adventurous one (${f2(ta)})`);
  ok(m.hoodTerm(family, host, far, near) < 0, 'and counts against moving next to the works');
}

// ---- determinism ---------------------------------------------------------------------------------------
{
  const a = scene(60, 40), b = scene(60, 40);
  let same = a.f.size === b.f.size && a.f.size > 0;
  for (const [k, bytes] of a.f.entries()) { const o = b.f.entries(); let hit: Uint8Array | undefined; for (const [k2, v] of o) if (k2 === k) hit = v; if (!hit || hit.some((v, i) => v !== bytes[i])) same = false; }
  ok(same, `two builds of the same scene give the same bytes (${a.f.size} chunks)`);
  const before = [...a.f.entries()].map(([k, v]) => `${k}:${v.join(',')}`).join('|');
  const v0 = a.f.version;
  a.f.refresh();
  ok([...a.f.entries()].map(([k, v]) => `${k}:${v.join(',')}`).join('|') === before && a.f.last.chunks === 0 && a.f.version === v0, 'a settled field recomputes nothing on the next hour');
}

// ---- the published value byte -------------------------------------------------------------------------
{
  const c = busy.f.cellAt(busy.depot[0], busy.depot[1])!;
  ok(Math.abs(combineValue(c.b, c.off) * 255 / VALUE.publishMax - c.b[c.off + VALUE_SLOTS - 1]) <= 1, 'the last byte of a cell is the published value');
}

// ---- a big test city: the hourly cost, effects, and a load ---------------------------------------------
{
  const n = arg('districts', 6);
  const w = new World(SEED);
  seedCity(w, { districts: n, built: 3 });
  const sim = new Simulation(w);
  const t0 = performance.now();
  const hours = 4;
  for (let i = 0; i < hours * TICKS_PER_HOUR; i++) sim.tick();
  const simMs = performance.now() - t0;
  const v = sim.value;
  console.log(`  ${n}×${n} districts, ${w.buildings.size} buildings, ${w.citizens.size} citizens: ${v.stats.passes} passes, ${f2(v.stats.ms / Math.max(1, v.stats.passes))} ms a pass on average (last ${f2(v.last.ms)} ms, ${v.last.chunks} chunks recomputed of ${v.last.fields}, ${v.last.cells} emitting cells); sim ${f2(simMs / (hours * TICKS_PER_HOUR))} ms a tick`);
  v.clear();
  const t1 = performance.now(); v.refresh(); const full = performance.now() - t1;
  console.log(`  a full rebuild (every chunk): ${f2(full)} ms for ${v.last.chunks} chunks; per game hour that is ${f2(full / TICKS_PER_HOUR)} ms a tick spread`);
  ok(full < 250, `the full rebuild of a ${n}×${n} city takes under 250 ms (${f2(full)})`);
  // the loaded world rebuilds the same field from its tiles
  const w2 = worldFromSnapshot(JSON.parse(JSON.stringify(snapshotOf(w))));
  ok(!!w2, 'the world saves and loads (nothing new in the snapshot)');
  if (w2) {
    const sim2 = new Simulation(w2);
    sim2.value.refresh();
    ok(sim2.value.size === v.size && sim2.value.size > 0, `a loaded world rebuilds the field at its first pass (${sim2.value.size} chunks)`);
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall value checks passed');
process.exit(failed ? 1 : 0);
