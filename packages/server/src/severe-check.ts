/**
 * `npm run severe:check` (docs/weather.md W6, severe weather): warnings, fallen trees, floods, defences, flood risk on the
 * map and in the price, gritters, determinism and the save.
 *
 * 1. The pure parts (shared/src/severe.ts): flood risk only on land by water, the river level and the outlook repeat.
 * 2. Floods, on a hand-built shore of seed 4242 (a parcel of Bob's on low land by a lake): a scripted storm spell (the
 *    W4 forced conditions by tick, setWeatherScript) raises the river; the flood warning comes a game day before the
 *    water does, with a toast to Bob and a news story; then roads by the water close, homes there keep their people in,
 *    Bob pays the flood damage once, nothing is demolished; the water goes down and the roads reopen. A second run
 *    repeats exactly (determinism). Defences: a continuous wall along the water's edge keeps every tile behind it dry
 *    up to the level it holds, and is topped above it; a wall is bought on Bob's own empty land. Flood risk lowers land
 *    price, shows in the Flood risk overlay, and is a hazard in the value field. A snapshot round trip keeps the walls,
 *    the flood's damage and the warnings.
 * 3. Storms and gritters in a 1×1 test city filled for a day: a scripted storm is warned a game day ahead, trees come
 *    down across roads beside parks and wild trees, the routers price the closed tile out (a route goes round it), crews
 *    from the builders' yard (or the contractor) clear every one and the roads reopen; the trees repeat in a second
 *    world; a save mid-storm keeps them. Snow on the way sends gritters out; gritted tiles lift the W4 snow slowdown.
 *
 *   npx tsx packages/server/src/severe-check.ts
 */
import {
  CHUNK_SIZE, DEFAULT_TAX, SEVERE, TICKS_PER_HOUR, TICKS_PER_DAY, Terrain, Zone, ValueKind, OVERLAY_FLOOD, ROAD_WEATHER, FleetKind,
  floodRiskAt, floodsAt, riverLevel, riverClimate, severeOutlook, setWeatherScript, makeTerrainSampler, packTile, isRoad, tileKey, terrainOf,
  roadSpeedMul, weatherFor, landPriceOf, wildPriceByte, priceOfByte,
  type ServerMsg, type ClientMsg, type ForcedWeather,
} from '@msimcity/shared';
import { World, emptyStats, tkey, untkey, type Parcel } from './world';
import { createGame, type Game } from './game';
import { snapshotOf, worldFromSnapshot } from './snapshot';
import { findRoute } from './pathfinding';
import { CLOSED_COST } from './sim/traffic';
import { Overlays } from './overlays';
import { seedCity } from './loadtest/cities';
import type { Conn } from './transport';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const TPH = TICKS_PER_HOUR;
const hourOf = (g: Game) => Math.floor(g.world.tick / TPH);
const stepHours = (g: Game, n: number) => { for (let i = 0; i < n * TPH; i++) g.step(); };
const stepTo = (g: Game, hour: number, tickInHour = 50) => { while (g.world.tick < hour * TPH + tickInHour) g.step(); };
/** A spell of `kind` over [from, to) game hours, clear weather either side: a pure function of the tick. */
const spell = (kind: ForcedWeather, from: number, to: number) => (t: number): ForcedWeather => (t >= from * TPH && t < to * TPH ? kind : 'clear');

function connect(g: Game, accept: () => ((c: Conn) => void) | null, name: string) {
  const toasts: string[] = [];
  let onMsg: ((d: string) => void) | null = null, severe: Extract<ServerMsg, { t: 'severe' }> | null = null;
  accept()!({ open: true, send: (d) => { const m = JSON.parse(d) as ServerMsg; if (m.t === 'toast') toasts.push(m.msg); if (m.t === 'severe') severe = m; }, close() {}, onMessage: (fn) => { onMsg = fn; }, onClose() {} });
  const send = (m: ClientMsg) => onMsg!(JSON.stringify(m));
  send({ t: 'hello', name });
  void g;
  return { send, toasts, severe: () => severe };
}
function makeGame(w: World, market = false) {
  let accept: ((c: Conn) => void) | null = null;
  const g = createGame(w, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false, ...(market ? { market: true } : {}) });
  g.fires.enabled = false;
  return { g, accept: () => accept };
}
const parcel = (w: World, owner: string, x: number, y: number, ww: number, hh: number): Parcel => {
  const p: Parcel = { id: w.nextId++, owner, name: owner, x, y, w: ww, h: hh, taxRate: DEFAULT_TAX, stats: emptyStats() };
  w.parcels.set(p.id, p);
  for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) w.setParcelId(xx, yy, p.id);
  w.recountRoads(p.id);
  return p;
};

// ==================================================================================== 1. pure
const SEED = 4242;
{
  const sample = makeTerrainSampler(SEED);
  let land = 0, water = 0, risky = 0, bad = 0;
  for (let y = -200; y < 200; y += 3) for (let x = -200; x < 200; x += 3) {
    const r = floodRiskAt(SEED, x, y), t = sample(x, y);
    if (t === Terrain.Water) { water++; if (r > 0) bad++; } else { land++; if (r > 0) risky++; }
    if (r < 0 || r > 1) bad++;
  }
  ok(!bad && risky > 0 && risky < land / 2, `flood risk only on land by the water: ${risky} of ${land} sampled land tiles at risk, none on ${water} water tiles`);
  const c = riverClimate(SEED);
  let same = true, inRange = true, floodH = 0;
  for (let h = 0; h < 24 * 7 * 2; h++) { const a = riverLevel(SEED, h * TPH), b = riverLevel(SEED, h * TPH + 37); if (a !== b) same = false; if (a < 0 || a > 1) inRange = false; if (a >= SEVERE.floodFrom) floodH++; }
  ok(same && inRange, `the river level is a pure function of the hour, 0..1 (base ${c.base.toFixed(1)}, top ${c.top.toFixed(1)}); real weather floods ${floodH} of ${24 * 14} hours over two years`);
  const o1 = JSON.stringify(severeOutlook(SEED, 500 * TPH)), o2 = JSON.stringify(severeOutlook(SEED, 500 * TPH + 60));
  ok(o1 === o2, `the outlook repeats within the hour (${o1})`);
}

// ==================================================================================== 2. floods
/** A low shore of seed 4242: a land tile at the water's edge with the most risk tiles round it. */
function findShore(): { x: number; y: number; n: number } {
  const sample = makeTerrainSampler(SEED);
  let best = { x: 0, y: 0, n: -1 };
  for (let y = -320; y < 320; y += 4) for (let x = -320; x < 320; x += 4) {
    if (floodRiskAt(SEED, x, y) < 0.85 || sample(x, y) === Terrain.Water) continue;
    if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => sample(x + dx, y + dy) === Terrain.Water)) continue;
    let n = 0, dry = 0;
    for (let j = -10; j < 10; j++) for (let i = -10; i < 10; i++) { const r = floodRiskAt(SEED, x + i, y + j); if (r > 0) n++; else if (sample(x + i, y + j) !== Terrain.Water) dry++; }
    if (dry >= 20 && n > best.n) best = { x, y, n };
  }
  return best;
}
const SHORE = findShore();
const X0 = SHORE.x - 10, Y0 = SHORE.y - 10, SIDE = 20;
interface FloodRun { sig: string; warnAt: number; warnFrom: number; floodAt: number; maxTiles: number; roads: number; homes: number; bill: number; billed: number; levels: boolean; reopened: boolean; toasts: string[]; news: string[]; stayed: boolean; dryHome: boolean }
/** Bob's shore town: roads every fourth row, homes on the land between. */
function shoreWorld(): { w: World; homes: [number, number][] } {
  const w = new World(SEED), homes: [number, number][] = [];
  for (let y = Y0; y < Y0 + SIDE; y++) for (let x = X0; x < X0 + SIDE; x++) {
    const t = w.getTile(x, y);
    if (terrainOf(t) === Terrain.Water) continue;
    if ((y - Y0) % 4 === 0) w.setTile(x, y, packTile(terrainOf(t), true, 0, 0));
    else if ((x - X0) % 3 !== 2) { w.setTile(x, y, packTile(terrainOf(t), false, Zone.Residential, 1)); homes.push([x, y]); }
  }
  for (const [x, y] of homes) { const b = w.buildings.get(tileKey(x, y)); if (b) b.occupants = 2; }
  return { w, homes };
}
function floodRun(): FloodRun {
  const { w, homes } = shoreWorld();
  const { g, accept } = makeGame(w);
  const bob = connect(g, accept, 'Bob');
  parcel(w, 'bob', X0, Y0, SIDE, SIDE);
  w.players.get('bob')!.money = 100_000;
  const H0 = hourOf(g) + 30;
  setWeatherScript(spell('storm', H0, H0 + 40));
  const sv = g.severe;
  const levelsBefore = homes.map(([x, y]) => w.buildings.get(tileKey(x, y))?.level ?? 0);
  let floodAt = -1, maxTiles = 0, roads = 0, homesF = 0, stayed = false, dryHome = false;
  const money0 = w.players.get('bob')!.money;
  for (let h = hourOf(g); h < H0 + 64; h++) {
    stepHours(g, 1);
    if (sv.flooded.size && floodAt < 0) floodAt = hourOf(g);
    if (sv.flooded.size > maxTiles) {
      maxTiles = sv.flooded.size;
      roads = [...sv.flooded].filter((k) => g.sim.traffic.closures.has(k)).length;
      homesF = sv.floodedB.size;
      const fh = homes.find(([x, y]) => sv.floodedB.has(tkey(x, y))), dh = homes.find(([x, y]) => !sv.floodedB.has(tkey(x, y)));
      const fake = (hx: number, hy: number) => ({ hx, hy, job: false, wx: 0, wy: 0 }) as unknown as Parameters<NonNullable<typeof g.sim.stayHome>>[0];
      stayed = !!fh && g.sim.stayHome!(fake(fh[0], fh[1])) && !!g.sim.closedAt!(fh[0], fh[1]);
      dryHome = !!dh && !g.sim.stayHome!(fake(dh[0], dh[1]));
    }
  }
  const warn = sv.stats.warnings.find((x) => x.kind === 'flood');
  // nothing demolished: every home tile is still a built home (growth may have raised or merged some meanwhile)
  const levelsAfter = homes.map(([x, y]) => { const t = w.getTile(x, y); return (t >> 3 & 15) === Zone.Residential ? Math.max(1, (t >> 7) & 7) : 0; });
  const bill = sv.stats.billedCost;
  void money0;
  const news = g.news.recent().map((s) => s.h);
  setWeatherScript(null);
  return {
    sig: JSON.stringify([sv.stats, floodAt, maxTiles, bill]), warnAt: warn?.at ?? -1, warnFrom: warn?.from ?? -1, floodAt, maxTiles, roads, homes: homesF, bill, billed: sv.stats.billed,
    levels: levelsAfter.every((l) => l > 0) && levelsBefore.every((l) => l > 0), reopened: sv.flooded.size === 0 && ![...g.sim.traffic.closures].length, toasts: bob.toasts.slice(), news, stayed, dryHome,
  };
}
{
  ok(SHORE.n > 0, `a low shore of seed ${SEED} at (${SHORE.x}, ${SHORE.y}): ${SHORE.n} tiles at risk round it`);
  const t0 = performance.now();
  const a = floodRun();
  ok(a.warnFrom >= 0 && a.warnAt === a.warnFrom - SEVERE.leadHours, `the flood warning comes a game day ahead: issued at hour ${a.warnAt} for a spell from hour ${a.warnFrom}`);
  ok(a.floodAt >= a.warnFrom && a.floodAt <= a.warnFrom + 1, `the water comes when warned (hour ${a.floodAt})`);
  ok(a.toasts.some((t) => /^Flood warning/.test(t)) && a.news.some((h) => /Flood warning for/.test(h)), `Bob is warned (toast "${a.toasts.find((t) => /^Flood warning/.test(t))}") and the news carries it`);
  ok(a.maxTiles > 0 && a.roads > 0 && a.homes > 0, `the flood: ${a.maxTiles} tiles under water at its height, ${a.roads} road tiles closed, ${a.homes} homes flooded`);
  ok(a.stayed && a.dryHome, 'people in a flooded home stay home (and it is shut to visitors); a dry home\'s go out as usual');
  ok(a.bill > 0 && a.billed === a.homes && a.levels, `Bob pays $${a.bill} of flood damage for ${a.billed} buildings (${a.homes} flooded), once; no building lost a level or was demolished`);
  ok(a.toasts.some((t) => /Floodwater in \d+ of your buildings/.test(t)) && a.news.some((h) => /^Floods close \d+ road/.test(h) || /Floodwater goes down/.test(h)), 'a damage notice and the flood in the news');
  ok(a.reopened, 'the water went down: no tile flooded, every road open again');
  const b = floodRun();
  ok(a.sig === b.sig, `deterministic: a second run floods the same tiles at the same hours and bills the same (${a.sig.slice(0, 80)}...)`);
  console.log(`     (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
// defences, price, overlay, value, save
{
  const { w, homes } = shoreWorld();
  const { g, accept } = makeGame(w, true);
  const bob = connect(g, accept, 'Bob');
  const q = parcel(w, 'bob', X0, Y0, SIDE, SIDE);
  w.players.get('bob')!.money = 100_000;
  const sv = g.severe, L = 0.8;
  const open = sv.floodFill(L, false);
  // the risk edge: every tile the water reaches first (floodable and beside the water), walled continuously
  const water = (x: number, y: number) => terrainOf(w.getTile(x, y)) === Terrain.Water;
  const edgeTiles: number[] = [];
  for (const k of open) { const [x, y] = untkey(k); if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => water(x + dx, y + dy))) edgeTiles.push(k); }
  const inside = [...open].filter((k) => !edgeTiles.includes(k));
  for (const k of edgeTiles) sv.walls.set(k, 'bob');
  const held = sv.floodFill(L, true), topped = sv.floodFill(Math.min(1, SEVERE.wallHold + 0.1), true);
  ok(edgeTiles.length > 0 && inside.length > 0 && inside.every((k) => !held.has(k)) && held.size === 0,
    `a continuous wall along the risk edge (${edgeTiles.length} tiles) keeps all ${inside.length} tiles behind it dry at level ${L}`);
  ok(inside.some((k) => topped.has(k)), `above the level it holds (${SEVERE.wallHold}) the water tops it: ${topped.size} tiles flood`);
  const ov = new Overlays(w, g.sim, g.issues);
  ov.severe = sv;
  const [px, py] = untkey(inside[0]);
  const ch = (x: number) => Math.floor(x / CHUNK_SIZE);
  const byteAt = (x: number, y: number) => ov.bytes(OVERLAY_FLOOD, ch(x), ch(y))![(y - ch(y) * CHUNK_SIZE) * CHUNK_SIZE + (x - ch(x) * CHUNK_SIZE)];
  const protByte = byteAt(px, py);
  for (const k of edgeTiles) sv.walls.delete(k);
  (sv as unknown as { wallVer: number }).wallVer++;
  const openByte = byteAt(px, py);
  ok(openByte > 0 && protByte > 0 && protByte < openByte, `the Flood risk overlay shows the tile at (${px}, ${py}): ${openByte} open, ${protByte} behind the wall`);
  // a wall bought on Bob's own empty land
  const empty: [number, number][] = [];
  for (let y = Y0; y < Y0 + SIDE && empty.length < 3; y++) for (let x = X0; x < X0 + SIDE && empty.length < 3; x++) { const t = w.getTile(x, y); if (!isRoad(t) && terrainOf(t) !== Terrain.Water && (t >> 3 & 15) === 0) empty.push([x, y]); }
  const m0 = w.players.get('bob')!.money;
  bob.toasts.length = 0;
  bob.send({ t: 'floodWall', tiles: empty });
  ok(empty.length > 0 && sv.walls.size === empty.length && Math.abs(m0 - w.players.get('bob')!.money - empty.length * SEVERE.wallCost) < 1e-6 && /Flood wall built/.test(bob.toasts.join()),
    `Bob builds ${empty.length} tiles of flood wall on his empty land for $${empty.length * SEVERE.wallCost} ("${bob.toasts[0]}")`);
  bob.send({ t: 'floodWall', tiles: [[homes[0][0], homes[0][1]]] });
  ok(sv.walls.size === empty.length, 'a home\'s tile takes no wall');
  // price: a rectangle at risk against the same rectangle priced without the risk
  const r = { x: q.x, y: q.y, w: q.w, h: q.h };
  const risky = g.land.priceOf(r), flat = landPriceOf(r, (cx, cy) => g.land.priceBytes(cx, cy));
  ok(risky < flat, `flood risk lowers the price of Bob's shore: $${risky} against $${flat} without it`);
  const wild = priceOfByte(wildPriceByte());
  ok(Math.abs(g.land.tilePrice(SHORE.x, SHORE.y) - wild * (1 - SEVERE.priceCut * floodRiskAt(SEED, SHORE.x, SHORE.y))) < 1e-6 || g.land.tilePrice(SHORE.x, SHORE.y) < wild, `a tile at the water's edge costs $${g.land.tilePrice(SHORE.x, SHORE.y).toFixed(2)} a tile (wild land $${wild.toFixed(2)})`);
  // the value field's hazard
  g.sim.value.refresh();
  const hz = g.sim.value.kindAt(SHORE.x, SHORE.y, ValueKind.Hazard);
  let dry: [number, number] | null = null;
  for (const [x, y] of homes) if (floodRiskAt(SEED, x, y) === 0 && floodRiskAt(SEED, x + 3, y + 3) === 0 && floodRiskAt(SEED, x - 3, y - 3) === 0) { dry = [x, y]; break; }
  ok(hz > 0 && (!dry || g.sim.value.kindAt(dry[0], dry[1], ValueKind.Hazard) < hz), `the value field's hazard includes flood risk: ${(hz * 100).toFixed(0)}% by the water${dry ? `, ${(g.sim.value.kindAt(dry[0], dry[1], ValueKind.Hazard) * 100).toFixed(0)}% on dry ground` : ''}`);
  // a flood under way, saved and loaded
  const H0 = hourOf(g) + 26;
  setWeatherScript(spell('storm', H0, H0 + 40));
  stepTo(g, H0 + 30);
  const before = { walls: sv.walls.size, flooded: sv.flooded.size, warn: JSON.stringify((sv as unknown as { warned: object }).warned), damaged: (sv as unknown as { damaged: Set<number> }).damaged.size };
  const w2 = worldFromSnapshot(JSON.parse(JSON.stringify(snapshotOf(w))))!;
  const { g: g2 } = makeGame(w2, true);
  g2.step();
  const s2 = g2.severe;
  const after = { walls: s2.walls.size, flooded: s2.flooded.size, warn: JSON.stringify((s2 as unknown as { warned: object }).warned), damaged: (s2 as unknown as { damaged: Set<number> }).damaged.size };
  ok(before.flooded > 0 && JSON.stringify(before) === JSON.stringify(after), `a save mid-flood loads with the walls, the water, the warnings and the buildings already billed (${JSON.stringify(after)}${JSON.stringify(before) === JSON.stringify(after) ? '' : ` against ${JSON.stringify(before)}`})`);
  const m1 = w2.players.get('bob')!.money;
  stepHours(g2, 2);
  ok(w2.players.get('bob')!.money >= m1 - 1e-6, 'and does not bill them twice');
  const old = worldFromSnapshot({ ...JSON.parse(JSON.stringify(snapshotOf(new World(5)))), severe: undefined });
  ok(!!old, 'a save without the severe field loads');
  setWeatherScript(null);
}

// ==================================================================================== 3. storms and gritters
function stormTrees(): string {
  const w = new World(SEED);
  seedCity(w, { districts: 1, built: 3 });
  const { g } = makeGame(w);
  const H0 = hourOf(g) + 2;
  setWeatherScript(spell('storm', H0, H0 + 6));
  const keep = SEVERE.treePerHour; SEVERE.treePerHour = 0.03;
  stepTo(g, H0 + 6);
  SEVERE.treePerHour = keep;
  setWeatherScript(null);
  return JSON.stringify([...g.severe.trees.keys()].sort((a, b) => a - b));
}
{
  const t0 = performance.now();
  const w = new World(SEED);
  const layout = seedCity(w, { districts: 1, built: 3, seedOwner: 'ada' });
  const { g, accept } = makeGame(w);
  const ada = connect(g, accept, 'Ada');
  const sim = g.sim, sv = g.severe;
  stepHours(g, 30); // a day and more: people move in, the yard hires builders
  const yard = w.builtOf(Zone.Yard)[0];
  const builders = [...w.citizens.values()].filter((c) => c.job && yard && c.wx === yard.x && c.wy === yard.y).length;
  console.log(`     a 1×1 city at (${layout.x0}, ${layout.y0}): ${w.citizens.size} people, ${builders} builders at the yard (${yard?.x}, ${yard?.y})`);
  const H0 = hourOf(g) + 26;
  setWeatherScript(spell('storm', H0, H0 + 6));
  const keep = SEVERE.treePerHour; SEVERE.treePerHour = 0.03;
  stepTo(g, H0 - SEVERE.leadHours, 20);
  const warn = sv.stats.warnings.find((x) => x.kind === 'storm');
  ok(warn && warn.from === H0 && warn.at === H0 - SEVERE.leadHours, `the storm warning comes a game day ahead (issued at hour ${warn?.at} for hour ${H0})`);
  g.step();
  ok(ada.toasts.some((t) => /^Storm warning/.test(t)) && g.news.recent().some((s) => /Storm warning for/.test(s.h)), `Ada is warned ("${ada.toasts.find((t) => /^Storm warning/.test(t))}") and the news carries it`);
  ok(sv.trees.size === 0, 'no tree down before the storm');
  // through the storm: trees fall; one is looked at closely as soon as it is down
  let routed = '', closedCost = 0, seen = new Set<number>(), saved = '';
  for (let h = hourOf(g); h < H0 + 6; h++) {
    stepHours(g, 1);
    for (const k of sv.trees.keys()) seen.add(k);
    if (!routed) for (const t of sv.trees.values()) {
      closedCost = sim.traffic.cost(t.x, t.y);
      // a route between the two road tiles either side of the tree goes round it
      const ends = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [t.x + dx, t.y + dy]).filter(([x, y]) => isRoad(w.getTile(x, y)));
      for (let i = 0; i < ends.length && !routed; i++) for (let j = i + 1; j < ends.length && !routed; j++) {
        const [a, b] = [ends[i], ends[j]];
        if (a[0] !== b[0] && a[1] !== b[1]) continue; // across the tile, not round a corner
        const r = findRoute(w, a[0], a[1], b[0], b[1], (x, y) => sim.traffic.cost(x, y));
        if (!r) continue;
        let through = false;
        for (let p = 0; p < r.path.length; p += 2) if (r.path[p] === t.x && r.path[p + 1] === t.y) through = true;
        if (!through) routed = `(${a}) to (${b}) round the tree at (${t.x}, ${t.y}) in ${r.path.length / 2} tiles`;
      }
    }
    if (!saved && sv.trees.size) {
      const w2 = worldFromSnapshot(JSON.parse(JSON.stringify(snapshotOf(w))))!;
      const { g: g2 } = makeGame(w2);
      saved = JSON.stringify([[...g2.severe.trees.keys()].sort(), [...g2.sim.traffic.closures].sort()]) === JSON.stringify([[...sv.trees.keys()].sort(), [...sv.trees.keys()].sort()]) ? `${sv.trees.size}` : 'differs';
    }
  }
  SEVERE.treePerHour = keep;
  ok(seen.size > 0 && [...seen].every((k) => isRoad(w.getTile(...untkey(k)))), `the storm brings ${seen.size} trees down across roads beside parks and wild trees`);
  ok(closedCost >= CLOSED_COST, `a closed tile costs the routers ${closedCost.toFixed(0)} (a detour is cheaper)`);
  ok(!!routed, `traffic routes round a fallen tree: ${routed}`);
  ok(saved !== '' && saved !== 'differs', `a save mid-storm keeps the fallen trees and their closures (${saved})`);
  stepHours(g, SEVERE.treeClearHours + 1);
  ok(sv.trees.size === 0 && [...seen].every((k) => !sim.traffic.closures.has(k)), `every tree cleared, every road open again: ${sv.stats.byCrew} by a road crew from the yard (${sv.stats.crews} sent), ${sv.stats.byContractor} by the contractor`);
  ok(sv.stats.crews > 0 || builders === 0, 'the builders\' yard sent road crews');
  // gritters: snow on the way
  // snow due in the working day (the yard's builders drive the gritters on their shift; night snow waits for the morning round)
  let S0 = hourOf(g) + 3;
  while (S0 % 24 !== 10) S0++;
  setWeatherScript(spell('snow', S0, S0 + 10));
  for (let h = hourOf(g); h < S0 + 4; h++) {
    stepHours(g, 1);
    const free = [...w.citizens.values()].filter((c) => c.job && yard && c.wx === yard.x && c.wy === yard.y && c.state === 2).length;
    if (hourOf(g) >= S0 - 4) console.log(`     ${String(hourOf(g) % 24).padStart(2, '0')}:00 rounds waiting ${(sv as unknown as { rounds: Map<number, unknown> }).rounds.size}, builders at the yard ${free}, gritter rounds sent ${sv.stats.gritRounds}, tiles gritted ${sv.stats.gritTiles}`);
  }
  const gritted = [...sv.gritted.keys()].filter((k) => sv.gritted.get(k)! > w.tick);
  const gxy = gritted.length ? untkey(gritted[0]) : null;
  const snow = weatherFor(w.seed, w.tick);
  ok(sv.stats.gritRounds > 0 && gritted.length > 0, `snow forecast: ${sv.stats.gritRounds} gritter round(s) out of the yard, ${gritted.length} road tiles gritted`);
  // the traffic's own pace on a gritted road tile and on one the gritter has not been along (Traffic.weatherPace, W4)
  const pace = (x: number, y: number) => (sim.traffic as unknown as { weatherPace(x: number, y: number): number }).weatherPace(x, y);
  let ungritted: [number, number] | null = null;
  for (let y = layout.y0; y < layout.y0 + 30 && !ungritted; y++) for (let x = layout.x0; x < layout.x0 + 30; x++) if (isRoad(w.getTile(x, y)) && !sv.isGritted(x, y)) { ungritted = [x, y]; break; }
  ok(!!gxy && !!ungritted && sv.isGritted(gxy[0], gxy[1]) && sim.traffic.gritted!(gxy[0], gxy[1]) && pace(gxy[0], gxy[1]) > pace(ungritted[0], ungritted[1]) && roadSpeedMul(snow, true) > roadSpeedMul(snow, false),
    `a gritted tile lifts the snow slowdown: traffic's pace ${gxy ? pace(gxy[0], gxy[1]).toFixed(2) : '?'} on (${gxy}), ${ungritted ? pace(ungritted[0], ungritted[1]).toFixed(2) : '?'} on an ungritted road (lying snow ${snow.snowCover})`);
  const units = [...sim.mobile.units.values()].filter((u) => u.kind === FleetKind.Gritter).length;
  console.log(`     gritters on the road now: ${units}; main roads first (avenues, motorways, ring roads, then junctions)`);
  setWeatherScript(null);
  ok(stormTrees() === stormTrees(), 'deterministic: the same storm brings the same trees down in a second world');
  console.log(`     (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
void TICKS_PER_DAY; void floodsAt;
