/**
 * `npm run roadrules:check` (docs/multiplayer-land.md section 8, phase M3): public road on unclaimed land, driven over
 * fake clients in a frontier world (one country road from the gate to the first player's charter):
 *
 * - the builder of a public road is recorded and pays its upkeep at its class's rate, ledger line 'roads';
 * - a save from before M3 loads with every public road nobody's (`old`), and a save round trip keeps the builders;
 * - unused public road fades after PUBLIC_ROAD_TUNING.fadeDays with a warning the day before, but not when it is
 *   someone's only link to the gateway;
 * - other players' traffic on adoptDays of adoptWindow days adopts it: the builder stops paying, the hook gets the upkeep;
 * - bulldozing is refused with the reason (who would be cut off, whose traffic would go the long way round), and
 *   allowed for the builder when nobody else depends on it or when a way round already exists;
 * - buying the land under a public road makes it the parcel's road and drops the builder record.
 *
 *   npx tsx packages/server/src/roadrules-check.ts
 */
import { PUBLIC_ROAD_TUNING as T, Terrain, packTile, isBuildable, isRoad, type ServerMsg, type ClientMsg } from '@msimcity/shared';
import { World, tkey, type Vehicle } from './world';
import { seedFrontier } from './seed';
import { createGame } from './game';
import { snapshotOf, worldFromSnapshot } from './snapshot';
import type { Conn } from './transport';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

const world = new World(777);
seedFrontier(world);
// dry land round the test roads (the seed may have put water there; the country road at y = 0 and the gate stay)
for (let y = -24; y <= 14; y++) for (let x = -33; x <= -21; x++) if (y !== 0 && !isBuildable(world.getTile(x, y))) world.setTile(x, y, packTile(Terrain.Grass, false, 0, 0));
let accept: ((c: Conn) => void) | null = null;
const game = createGame(world, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false });
const pr = game.sim.publicRoads;
let fund = 0;
pr.regionalFund = (n) => { fund += n; };

function client(name: string) {
  const toasts: string[] = [];
  let onMsg: ((d: string) => void) | null = null;
  accept!({ open: true, send: (d) => { const m = JSON.parse(d) as ServerMsg; if (m.t === 'toast') toasts.push(m.msg); }, close() {}, onMessage: (fn) => { onMsg = fn; }, onClose() {} });
  const send = (m: ClientMsg) => onMsg!(JSON.stringify(m));
  send({ t: 'hello', name });
  const last = () => { const t = toasts.at(-1) ?? ''; toasts.length = 0; return t; };
  return { send, toasts, last, id: name.toLowerCase() };
}
const ada = client('Ada'), bob = client('Bob'), cy = client('Cy');
const line = (x: number, y0: number, y1: number): [number, number][] => { const out: [number, number][] = []; for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) out.push([x, y]); return out; };
const road = (who: ReturnType<typeof client>, tiles: [number, number][], cls = 0) => who.send({ t: 'build', tool: 'road', tiles, dev: true, cls });
const doze = (who: ReturnType<typeof client>, tiles: [number, number][]) => { who.toasts.length = 0; who.send({ t: 'build', tool: 'bulldoze', tiles }); return who.last(); };
const isRoadAt = (x: number, y: number) => isRoad(world.getTile(x, y));
const rec = (x: number, y: number) => world.publicRoads.get(tkey(x, y));
const ledger = (id: string) => world.players.get(id)!.ledger?.today ?? {};
const midnight = () => { const d = world.day; while (world.day === d) game.step(); };
for (let i = 0; i < 40; i++) game.step(); // the gateways are scanned

ok(world.parcels.size === 1 && [...world.parcels.values()][0].owner === 'ada', 'Ada, first in, has the frontier charter');
ok(rec(-25, 0)?.old === 1 && rec(-25, 0)?.b === undefined, 'the country road on unclaimed land is old public road: nobody pays for it');

// ---- old public road is protected too: it is Ada's only link to the gate
ok(/only road link between Ada's/.test(doze(bob, [[-25, 0]])) && isRoadAt(-25, 0), "Bob may not take up the country road: it is Ada's only link to the gate (the reason names her)");

// ---- the builder is recorded and charged
world.charter = undefined; // (the charter's ring would keep the land round it for Ada: ranks.ts landRefusal)
bob.send({ t: 'buy', x: -32, y: -22, w: 8, h: 8 });
cy.send({ t: 'buy', x: -26, y: 8, w: 4, h: 4 });
ok([...world.parcels.values()].filter((p) => p.owner !== 'ada').length === 2, 'Bob and Cy buy land off the country road');
road(bob, line(-28, -1, -14)); // Bob's link: 14 tiles of street from the country road to his land
road(cy, line(-24, 1, 7)); // Cy's link: 7 tiles of street to hers
road(cy, line(-30, 1, 6), 1); // and a spur to nowhere: 6 tiles of country lane
ok(line(-28, -1, -14).every(([x, y]) => isRoadAt(x, y) && rec(x, y)?.b === 'bob'), "Bob's public road is laid and he is its builder");
ok(line(-30, 1, 6).every(([x, y]) => rec(x, y)?.b === 'cy') && rec(-24, 4)?.b === 'cy', "Cy's are hers");
// the builder may take up road nobody else depends on (today's rule, with today's costs)
road(cy, line(-22, -3, -1));
ok(rec(-22, -2)?.b === 'cy', 'Cy lays a stub');
doze(cy, line(-22, -3, -1));
ok(!isRoadAt(-22, -2), 'and takes it up again: nobody else depends on it');
// Ada may not cut Bob off
ok(/only road link between Bob's/.test(doze(ada, [[-28, -5]])) && isRoadAt(-28, -5), "Ada may not take up Bob's road: it is his only link to the gate (the reason names him)");

const day0 = world.day;
midnight();
ok(Math.abs((ledger('bob').roads ?? 0) + 14 * 0.5) < 1e-9, `at midnight Bob pays the upkeep of his 14 tiles of street, $7, as 'Public roads' (${ledger('bob').roads})`);
ok(Math.abs((ledger('cy').roads ?? 0) + (7 * 0.5 + 6 * 0.25)) < 1e-9, `Cy pays 7 tiles of street and 6 of country lane at their class's rate, $5 (${ledger('cy').roads})`);
ok(ledger('ada').roads === undefined, 'Ada lays no public road and pays nothing for it (the country road is old)');

// ---- adoption: Ada's traffic on Bob's road on adoptDays days (a vehicle of hers seen there by the sampler)
const fake = { id: -1, phase: 'out', owner: 'ada', x: 0, y: 0 } as unknown as Vehicle;
const seenOn = (tiles: [number, number][]) => { world.vehicles.set(-1, fake); for (const [x, y] of tiles) { fake.x = x + 0.5; fake.y = y + 0.5; pr.sample(); } world.vehicles.delete(-1); };
for (let d = 0; d < T.adoptDays; d++) {
  ok(rec(-28, -5)?.b === 'bob' && !rec(-28, -5)?.ad, `day ${world.day - day0}: not adopted yet`);
  seenOn(line(-28, -1, -14));
  midnight();
}
ok(line(-28, -1, -14).every(([x, y]) => rec(x, y)?.ad === 1 && rec(x, y)?.b === undefined), `after Ada's traffic on ${T.adoptDays} days Bob's road is adopted: no builder`);
ok(ledger('bob').roads === undefined && Math.abs(fund - 7) < 1e-9, `Bob pays nothing for it at that midnight; the regional fund hook is handed its $7 (${fund})`);
ok(bob.toasts.some((m) => /adopted/.test(m)), 'Bob is told it was adopted');

// ---- protected by traffic: Bob may not take up the adopted road while Ada's trips would go the long way round
const why = doze(bob, [[-28, -5]]);
ok(/Ada's traffic uses this public road/.test(why) && isRoadAt(-28, -5), `Bob's removal is refused, naming Ada's traffic (${why})`);
// ... until a way round exists
road(bob, line(-27, -4, -6));
ok(rec(-27, -5)?.b === 'bob', 'Bob lays a short way round');
ok(doze(bob, [[-28, -5]]) === '' && !isRoadAt(-28, -5), 'then he may take the tile up: the detour is short');

// ---- fading
const day = world.day - day0;
ok(day === T.adoptDays + 1, `day ${day}`);
cy.toasts.length = 0;
while (world.day - day0 < T.fadeDays) midnight(); // Cy's spur was laid on day 0 and never used
ok(isRoadAt(-30, 3) && cy.toasts.some((m) => /back to countryside at midnight/.test(m)), `on day ${T.fadeDays} the spur is still there and Cy is warned`);
midnight();
ok(line(-30, 1, 6).every(([x, y]) => !isRoadAt(x, y) && !rec(x, y)), `after ${T.fadeDays} unused days the spur has gone back to countryside`);
ok(cy.toasts.some((m) => /went back to countryside/.test(m)), 'and Cy is told');
ok(line(-24, 1, 7).every(([x, y]) => isRoadAt(x, y) && rec(x, y)?.b === 'cy'), "Cy's unused link to her land does not fade: it is her only link to the gate");
midnight();
ok(Math.abs((ledger('cy').roads ?? 0) + 7 * 0.5) < 1e-9, `the next midnight Cy pays for her link alone (${ledger('cy').roads})`);

// ---- buying the land under a public road: it is the parcel's road now
bob.send({ t: 'buy', x: -29, y: -14, w: 3, h: 3 });
const bought = world.parcelAt(-28, -13);
ok(bought?.owner === 'bob' && bought.stats.roads === 3, `Bob buys the land under three tiles of the adopted road: they are his parcel's road (${bought?.stats.roads} counted)`);
ok(!rec(-28, -13) && !rec(-28, -12) && rec(-28, -11)?.ad === 1, 'their public road records are gone; the rest stay');
// road on a player's own parcel is the owner's call
ok(doze(bob, [[-28, -12]]) === '' && !isRoadAt(-28, -12), 'road on his own parcel is his to take up');
road(bob, [[-28, -12]]);

// ---- saves
road(cy, line(-32, 3, 5)); // a stub nobody uses
const snap = snapshotOf(world);
ok(Array.isArray(snap.publicRoads) && snap.publicRoads.some((r) => r.x === -24 && r.y === 4 && r.b === 'cy'), 'the snapshot carries the public road records');
const w2 = worldFromSnapshot(JSON.parse(JSON.stringify(snap)))!;
ok(w2.publicRoads.get(tkey(-24, 4))?.b === 'cy' && w2.publicRoads.get(tkey(-28, -5)) === undefined && w2.publicRoads.get(tkey(-28, -6))?.ad === 1, 'they load back: builders and adoption kept');
const old = JSON.parse(JSON.stringify(snap));
delete old.publicRoads;
const w3 = worldFromSnapshot(old)!;
const g3 = createGame(w3, { onConnection: () => {} }, { devTools: true, sandbox: false });
const r3 = w3.publicRoads.get(tkey(-24, 4));
ok(r3?.old === 1 && r3.b === undefined && w3.publicRoads.get(tkey(-25, 0))?.old === 1, 'a save from before M3 loads with its public roads nobody\'s (old: no upkeep, no fading)');
for (let i = 0; i < 2400 * (T.fadeDays + 2); i++) g3.step();
ok(line(-32, 3, 5).every(([x, y]) => isRoad(w3.getTile(x, y)) && w3.publicRoads.get(tkey(x, y))?.old === 1), `and old public road never fades (Cy's unused stub, after ${T.fadeDays + 2} days)`);
ok(w3.players.get('cy')!.ledger?.today.roads === undefined, 'nor does anyone pay for it');

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
