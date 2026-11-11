/**
 * `npm run contracts:check` (docs/multiplayer-land.md section 7 "Services", phase M8): service contracts over fake clients.
 *
 * - a tariff above the regional price is refused, and so is one from a player with nothing to serve from;
 * - refuse: before a contract the provider's site does not take the buyer's homes (the regional depot does); signed, the
 *   buyer's homes go on the provider's site's round with kerb stops on the buyer's street, the lorry's lift costs the
 *   buyer no fee, billing moves money hourly with a ledger line on each side; a contracted home the regional depot had
 *   to empty is paid for by the provider; the provider cannot bulldoze its last site mid-contract;
 * - the price stays fixed for the term when the provider changes the tariff;
 * - power: a refuse contract does not let the provider's network onto the buyer's streets; a power contract does, for
 *   those parcels only (not a third player's street beyond), the buyer's buildings are supplied by the provider's network
 *   and billed for the units at the contract's price; the provider cannot bulldoze the substation serving them;
 * - notice ends a contract after CONTRACTS.noticeDays midnights and the service falls back to the regional supplier;
 * - a snapshot round trip keeps tariffs and contracts; an older save without them loads.
 *
 *   npx tsx packages/server/src/contracts-check.ts
 */
import {
  Terrain, Zone, DEFAULT_TAX, CONTRACTS, KIND_ID, TICKS_PER_HOUR, REFUSE, packTile, terrainOf, subFor, tileKey, planStructure, workOf, isMultiTile,
  isWasteDepot, binDay, regionalPrice, utilKey, capacityOf,
  type ServerMsg, type ClientMsg, type ServicesView, type ServiceQuote,
} from '@msimcity/shared';
import { World, emptyStats, tkey, type Parcel, type Building } from './world';
import { createGame } from './game';
import { snapshotOf, worldFromSnapshot } from './snapshot';
import type { Conn } from './transport';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const TPH = TICKS_PER_HOUR;
const COMPOST = KIND_ID['compost-digester'], SUB = KIND_ID.substation, GAS = KIND_ID['gas-plant'];

const world = new World(4242);
for (let y = -10; y < 60; y++) for (let x = -10; x < 110; x++) world.setTile(x, y, packTile(Terrain.Grass, false, 0, 0));
let accept: ((c: Conn) => void) | null = null;
const game = createGame(world, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false });
game.fires.enabled = false;
const contracts = game.contracts, utilities = game.utilities, refuse = game.sim.refuse;
function client(name: string) {
  const toasts: string[] = [];
  let view: ServicesView | null = null, quotes: ServiceQuote[] = [];
  let onMsg: ((d: string) => void) | null = null;
  accept!({ open: true, send: (d) => { const m = JSON.parse(d) as ServerMsg; if (m.t === 'toast') toasts.push(m.msg); if (m.t === 'services') view = m; if (m.t === 'svcQuotes') quotes = m.quotes; }, close() {}, onMessage: (fn) => { onMsg = fn; }, onClose() {} });
  const send = (m: ClientMsg) => onMsg!(JSON.stringify(m));
  send({ t: 'hello', name });
  const act = (m: ClientMsg) => { toasts.length = 0; send(m); const t = toasts.join(' | '); toasts.length = 0; return t; };
  return { send, toasts, act, id: name.toLowerCase(), view: () => view!, quotes: () => quotes, p: () => world.players.get(name.toLowerCase())! };
}
const parcel = (owner: string, x: number, y: number, w: number, h: number, name = owner): Parcel => {
  const p: Parcel = { id: world.nextId++, owner, name, x, y, w, h, taxRate: DEFAULT_TAX, stats: emptyStats() };
  world.parcels.set(p.id, p);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) world.setParcelId(xx, yy, p.id);
  world.recountRoads(p.id);
  return p;
};
/** Put kind with its door at (x, y), built and complete, with `staff` on the payroll. */
function put(kind: number, x: number, y: number, staff = 0): Building {
  if (isMultiTile(kind)) {
    const p = planStructure(kind, x, y, { tile: (a, b) => world.peekTile(a, b), aux: (a, b) => world.auxAt(a, b), sub: (a, b) => world.subAt(a, b), land: () => null });
    if (!p.ok) throw new Error(`cannot place ${kind} at (${x}, ${y}): ${p.reason}`);
    world.placeStructure(p.placed, { work: workOf(kind, 1), priority: 0, built: true });
  } else world.setTile(x, y, packTile(terrainOf(world.getTile(x, y)), false, Zone.Hub, 1), subFor(kind));
  const b = world.buildings.get(tileKey(x, y));
  if (!b) throw new Error(`nothing built at (${x}, ${y})`);
  b.occupants = staff;
  return b;
}
const ledger = (id: string) => world.players.get(id)!.ledger?.today ?? {};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const ada = client('Ada'), bob = client('Bob'), cy = client('Cy');
for (const c of [ada, bob, cy]) c.p().money = 100_000;
// Ada (the provider) west, Bob (the buyer) in the middle, Cy east; one street along y = 10 across all three, each laying their own part
const A = parcel('ada', 0, 0, 48, 24, 'Ada town'), B = parcel('bob', 48, 0, 24, 24, 'Bob farm'), C = parcel('cy', 72, 0, 24, 24, 'Cy works');
for (const [who, x0, x1] of [[ada, 0, 48], [bob, 48, 72], [cy, 72, 96]] as const)
  who.act({ t: 'build', tool: 'road', tiles: Array.from({ length: x1 - x0 }, (_, i) => [x0 + i, 10] as [number, number]), dev: true, cls: 0 } as ClientMsg);
ok(world.parcelAt(50, 10)?.owner === 'bob' && world.parcelAt(80, 10)?.owner === 'cy' && world.publicRoads.size === 0, 'a street along y = 10 over Ada\'s, Bob\'s and Cy\'s land, each part its owner\'s');
// Bob's homes, all in one refuse district, facing his street
const homes = [50, 52, 54, 56].map((x) => { world.setTile(x, 9, packTile(Terrain.Grass, false, Zone.Residential, 1)); return world.buildings.get(tileKey(x, 9))!; });
for (const h of homes) h.occupants = 3;
ok(homes.every((h) => h && h.level === 1) && new Set(homes.map((h) => binDay(h.x, h.y))).size === 1, 'Bob has four homes on his street, one collection district');
// Cy's old waste depot (a hashed share of industry): the regional service
let dx = -1;
for (let x = 74; x < 95 && dx < 0; x++) if (isWasteDepot(Zone.Industrial, x, 11)) dx = x;
world.setTile(dx, 11, packTile(Terrain.Grass, false, Zone.Industrial, 1));
const legacy = world.buildings.get(tileKey(dx, 11))!;
legacy.occupants = 6;
ok(legacy && Math.abs(legacy.x - 52) <= REFUSE.reach, `Cy has an old waste depot at (${dx}, 11), the regional collection in reach of Bob's homes`);

// ---- tariffs ------------------------------------------------------------------------------------------------------
const RR = regionalPrice('refuse'), RP = regionalPrice('power');
let r = ada.act({ t: 'svc', op: 'tariff', service: 'refuse', price: 0.05 });
ok(/once you have a refuse site/.test(r), `a refuse tariff with no site to serve from is refused ("${r}")`);
const site = put(COMPOST, 40, 9, 6);
const sub = put(SUB, 46, 11, 2);
const gas = put(GAS, 34, 11, 0);
gas.occupants = Math.ceil(capacityOf(gas.id, gas.level) * 0.5);
ok(site.id === COMPOST && sub.id === SUB && gas.id === GAS, `Ada has a composting site at (40, 9), a substation at (46, 11) and a staffed gas power station at (34, 11)`);
r = ada.act({ t: 'svc', op: 'tariff', service: 'refuse', price: RR + 0.01 });
ok(/No provider may charge more than the regional supplier/.test(r) && !contracts.tariffOf('ada', 'refuse'), `refuse above the regional price ($${RR.toFixed(3)} a home a day) is refused ("${r}")`);
r = ada.act({ t: 'svc', op: 'tariff', service: 'power', price: RP * 1.5 });
ok(/regional supplier/.test(r) && !contracts.tariffOf('ada', 'power'), `power above grid import ($${RP} a unit) is refused`);
r = ada.act({ t: 'svc', op: 'tariff', service: 'refuse', price: 0.07 });
ok(/tariff posted/.test(r) && contracts.tariffOf('ada', 'refuse')?.price === 0.07, `Ada posts refuse at $0.07 a home a day ("${r}")`);
r = ada.act({ t: 'svc', op: 'tariff', service: 'power', price: 0.05 });
ok(contracts.tariffOf('ada', 'power')?.price === 0.05, 'and power at $0.05 a unit');
game.step();
ok(bob.view().tariffs.length === 2 && cy.view().tariffs.some((t) => t.owner === 'ada') && bob.view().regional.power === RP, 'every neighbour sees the posted tariffs and the regional prices');

// ---- refuse: before and after signing -----------------------------------------------------------------------------
type RR_ = { plan(day: number): void; rounds: Map<number, { depot: [number, number]; todo: { x: number; y: number; ref: number; what: number }[]; homes: Map<number, number[]> }> };
const rr = refuse as unknown as RR_;
const due = binDay(50, 9) + 7 * 10; // a weekday (day % 7) when Bob's district is due
const roundFor = (x: number, y: number) => { for (const rd of rr.rounds.values()) for (const hs of rd.homes.values()) if (hs.includes(tkey(x, y))) return rd; return null; };
rr.plan(due);
let rd = roundFor(50, 9);
ok(rd && rd.depot[0] === legacy.x && rd.depot[1] === legacy.y, `without a contract Bob's homes go to the regional depot (${rd?.depot}), not Ada's site next door`);
bob.act({ t: 'svc', op: 'quote', id: B.id });
const qs = bob.quotes();
ok(qs.length === 2 && qs.every((q) => q.provider === 'ada' && q.reach), `Bob's quotes: ${qs.map((q) => `${q.service} $${q.price} ${q.reach ? 'in reach' : q.why}`).join(', ')}`);
r = cy.act({ t: 'svc', op: 'sign', id: B.id, service: 'refuse', provider: 'ada', days: 10 });
ok(/your own land/.test(r), 'Cy cannot sign up Bob\'s land');
r = bob.act({ t: 'svc', op: 'sign', id: B.id, service: 'refuse', provider: 'ada', days: 1 });
ok(/A term is/.test(r), `a term under ${CONTRACTS.minDays} days is refused`);
r = bob.act({ t: 'svc', op: 'sign', id: B.id, service: 'refuse', provider: 'ada', days: 10 });
const cR = contracts.on('refuse', B.id);
ok(cR && cR.price === 0.07 && cR.end === world.day + 10 && /Signed up with Ada/.test(r), `Bob signs refuse for 10 days ("${r.slice(0, 110)}...")`);
game.step();
ok(ada.toasts.some((t) => /Bob signed Bob farm up/.test(t)) && ada.view().contracts.length === 1 && bob.view().contracts.length === 1 && !cy.view().contracts.length, 'Ada is told; both parties see the contract, nobody else');
rr.plan(due);
rd = roundFor(50, 9);
ok(rd && rd.depot[0] === site.x && rd.depot[1] === site.y, `signed, Bob's homes go on the round of Ada's composting site (${rd?.depot})`);
const kerbs = rd ? rd.todo.filter((s) => s.what === 1) : [];
ok(kerbs.length > 0 && kerbs.every((s) => world.parcelAt(s.x, s.y)?.owner === 'bob' && world.getTile(s.x, s.y) !== undefined), `its lorry stops at ${kerbs.length} kerb${kerbs.length === 1 ? '' : 's'} on Bob's street (${kerbs.map((s) => `${s.x},${s.y}`).join(' ')})`);
// the lift: no per-home fee from Bob; a contracted home the regional depot empties is paid for by Ada
const fakeUnit = (base: [number, number]) => ({ base, jobs: 0, money: 0, loaded: false, task: '', stops: [] }) as never;
const fees = (id: string) => ledger(id).fees ?? 0;
const bob0 = bob.p().money, adaF = fees('ada'), bobF = fees('bob');
const stop = kerbs[0];
refuse.arrive(fakeUnit([site.x, site.y]), stop as never);
const lifted = rd!.homes.get(stop.ref)!.length;
ok(bob.p().money === bob0 && fees('ada') === adaF && refuse.stats.contractHomes === lifted, `Ada's lorry empties ${lifted} of Bob's homes: no per-collection fee, the contract pays`);
const ada1 = ada.p().money, cy1 = cy.p().money;
refuse.arrive(fakeUnit([legacy.x, legacy.y]), stop as never);
ok(near(ada.p().money, ada1 - lifted * REFUSE.feePerHome) && near(cy.p().money, cy1 + lifted * REFUSE.feePerHome) && bob.p().money === bob0 && fees('bob') === bobF,
  `when the regional depot has to empty them, Ada (not Bob) pays its fee ($${(lifted * REFUSE.feePerHome).toFixed(2)} to Cy)`);
// billing, hourly
const bS0 = ledger('bob').services ?? 0, aC0 = ledger('ada').contracts ?? 0;
contracts.billRefuse();
const hour = (4 * 0.07) / 24;
ok(near(cR!.last, hour) && near((ledger('bob').services ?? 0) - bS0, -hour) && near((ledger('ada').contracts ?? 0) - aC0, hour),
  `an hour's refuse bill: 4 homes × $0.07 / 24 = $${hour.toFixed(4)} from Bob ("Services bought from neighbours") to Ada ("Service contracts sold")`);
const paid0 = cR!.paid;
for (let i = 0; i < TPH; i++) game.step();
ok(cR!.paid > paid0 + hour * 0.99, `the game bills it each hour on its own (paid so far $${cR!.paid.toFixed(4)})`);
// the price is fixed for the term
ada.act({ t: 'svc', op: 'tariff', service: 'refuse', price: 0.02 });
contracts.billRefuse();
ok(contracts.tariffOf('ada', 'refuse')?.price === 0.02 && cR!.price === 0.07 && near(cR!.last, hour), 'Ada drops her refuse tariff to $0.02: Bob\'s contract stays at $0.07 for its term');
ada.act({ t: 'svc', op: 'tariff', service: 'refuse', price: 0.085 });
ok(cR!.price === 0.07, 'and raising it later does not touch the contract either');
// nobody cuts the service mid-contract
r = ada.act({ t: 'build', tool: 'bulldoze', tiles: [[40, 9]], dev: true } as ClientMsg);
ok(/last refuse site/.test(r) && world.buildings.get(tileKey(40, 9))?.id === COMPOST, `Ada may not bulldoze her only refuse site while the contract runs ("${r.slice(0, 80)}...")`);

// ---- power ---------------------------------------------------------------------------------------------------------
utilities.solve();
ok(utilities.field.nodeIndexAt('ada', 50, 10) < 0 && !homes.some((h) => utilities.supplied(h)), 'a refuse contract does not let Ada\'s network onto Bob\'s street: his homes have no power');
ok(utilities.nodeState.get(utilKey(sub.x, sub.y))?.state === 0, 'Ada\'s substation is supplied by her gas power station');
r = bob.act({ t: 'svc', op: 'sign', id: B.id, service: 'power', provider: 'ada', days: 12 });
const cP = contracts.on('power', B.id);
ok(cP && cP.price === 0.05 && /Signed up/.test(r), `Bob signs power for 12 days at $0.05 a unit ("${r.slice(0, 90)}...")`);
const bS1 = ledger('bob').services ?? 0, aC1 = ledger('ada').contracts ?? 0, bills1 = ledger('bob').bills ?? 0;
utilities.solve();
ok([49, 50, 53, 57].every((x) => utilities.field.nodeIndexAt('ada', x, 10) >= 0),
  `with a power contract Ada's network walks Bob's street (served to (${[...Array(30).keys()].map((i) => 48 + i).filter((x) => utilities.field.nodeIndexAt('ada', x, 10) >= 0).pop()}, 10))`);
ok([72, 73, 76, 80].every((x) => utilities.field.nodeIndexAt('ada', x, 10) < 0), 'but never on to Cy\'s street beyond');
ok(homes.every((h) => utilities.supplied(h)), 'Bob\'s homes are supplied by Ada\'s network');
const units = homes.reduce((a, h) => a + (utilities.info(h)?.power?.units ?? 0), 0);
ok(units > 0 && near(cP!.last, units * 0.05, 1e-9) && near((ledger('bob').services ?? 0) - bS1, -cP!.last) && near((ledger('ada').contracts ?? 0) - aC1, cP!.last),
  `the hour's ${units.toFixed(2)} units are billed at $0.05: $${cP!.last.toFixed(4)} from Bob to Ada, a ledger line each side`);
ok((ledger('bob').bills ?? 0) > bills1, 'Bob still collects his residents\' utility bills');
rr.plan(due);
ok(roundFor(50, 9)?.depot[0] === site.x, 'refuse still goes by the refuse contract, power by the power contract: each service only its own');
r = ada.act({ t: 'build', tool: 'bulldoze', tiles: [[46, 11]], dev: true } as ClientMsg);
ok(/powers streets under contract/.test(r) && world.buildings.get(tileKey(46, 11))?.id === SUB, `Ada may not bulldoze the substation powering Bob's streets ("${r.slice(0, 70)}...")`);

// ---- notice: three midnights, then the regional supplier ----------------------------------------------------------------
r = bob.act({ t: 'svc', op: 'notice', contract: cP!.id });
ok(cP!.ends === world.day + CONTRACTS.noticeDays && /Notice given/.test(r), `Bob gives notice on power: it ends on day ${cP!.ends}`);
r = ada.act({ t: 'svc', op: 'notice', contract: cR!.id });
ok(cR!.ends === world.day + CONTRACTS.noticeDays, 'Ada gives notice on refuse (the provider may leave too)');
ok(/already/.test(bob.act({ t: 'svc', op: 'notice', contract: cP!.id })), 'notice is given once');
const day0 = world.day;
world.day = day0 + CONTRACTS.noticeDays - 1; contracts.midnight();
utilities.solve();
ok(contracts.on('power', B.id) && contracts.on('refuse', B.id) && homes.every((h) => utilities.supplied(h)), 'two midnights on, both still run and Bob\'s homes are still powered');
world.day = day0 + CONTRACTS.noticeDays; contracts.midnight();
game.step();
ok(!contracts.on('power', B.id) && !contracts.on('refuse', B.id) && bob.toasts.some((t) => /has ended/.test(t)), 'at the third midnight both end, and Bob is told');
utilities.solve();
ok(utilities.field.nodeIndexAt('ada', 50, 10) < 0 && !homes.some((h) => utilities.supplied(h)), 'Ada\'s network is off Bob\'s street again: his homes fall back to what he has (no substation of his own)');
rr.plan(due);
ok(roundFor(50, 9)?.depot[0] === legacy.x, 'and his bins go back to the regional depot');
r = ada.act({ t: 'build', tool: 'bulldoze', tiles: [[46, 11]], dev: true } as ClientMsg);
ok(world.buildings.get(tileKey(46, 11))?.id !== SUB, 'with no contract running, Ada may bulldoze her substation');

// ---- save ----------------------------------------------------------------------------------------------------------
r = bob.act({ t: 'svc', op: 'sign', id: B.id, service: 'refuse', provider: 'ada', days: 20 });
ok(contracts.on('refuse', B.id)?.price === 0.085, `Bob signs again at today's tariff ($0.085)`);
const snap = JSON.parse(JSON.stringify(snapshotOf(world)));
ok(snap.contracts && snap.contracts.tariffs.length === 2 && snap.contracts.contracts.length === 1, 'the snapshot carries tariffs and contracts (optional field `contracts`)');
const loaded = worldFromSnapshot(snap)!;
const g2 = createGame(loaded, { onConnection() {} }, { devTools: true, sandbox: false });
const c2 = g2.contracts.on('refuse', B.id);
ok(c2 && c2.price === 0.085 && c2.provider === 'ada' && c2.end === world.day + 20 && g2.contracts.tariffOf('ada', 'power')?.price === 0.05, 'a save round trip keeps the tariffs and the running contract');
const old = worldFromSnapshot(JSON.parse(JSON.stringify({ ...snapshotOf(world), contracts: undefined })))!;
const g3 = createGame(old, { onConnection() {} }, { devTools: true, sandbox: false });
ok(!g3.contracts.running.length && !g3.contracts.tariffOf('ada', 'refuse') && !snapshotOf(old).contracts, 'a save from before M8 loads with none and saves without the field');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall contracts checks passed');
process.exit(failed ? 1 : 0);
