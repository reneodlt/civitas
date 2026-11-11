/**
 * `npm run refuse:check` (docs/multiplayer-land.md section 5, phase M4): refuse grades, add-ons, the landfill levy and
 * the regional fund, and boundary limits.
 *
 * - The grades' emissions at equal use are ordered (the open tip worst for the average household), and every add-on
 *   lowers what a grade gives off; restricted hours also lower what it can take a day.
 * - Money: once the levy applies at a moderate 100 homes a day a recycling centre costs less to run than a tip, while on
 *   a trickle the tip is cheaper.
 * - In a game over fake clients: a tip beside a rival's land is refused with the reason, a composting site in the same
 *   place and a tip set well back are allowed; fitting an add-on costs its price, and taking one off is refused when it
 *   would push a site over a limit at a neighbour's land that arrived after it was built.
 * - The levy: each home a site empties pays tonnes landfilled x the levy (and smoke) from its owner into the regional
 *   fund (ledger `levy`), a cleaner grade's sales come back (`recycling`); add-ons' upkeep at midnight.
 * - The fund pays adopted public road upkeep (the PublicRoads.regionalFund hook), as far as it goes.
 * - Collection rounds go to a refuse site before an old depot, until the site's day is full.
 * - The value field gives a busy tip more smell than a composting site at the same use.
 * - A save round trip keeps the fund and the add-ons.
 *
 *   npx tsx packages/server/src/refuse-check.ts
 */
import {
  Terrain, Zone, ValueKind, VALUE_KIND_COUNT, VALUE_KINDS, KIND_ID, LANDFILL_LEVY, REFUSE_GRADES, REFUSE_ADDONS, RefuseAddon, BOUNDARY_LIMITS,
  packTile, refuseEmission, refuseDaily, refuseCapacity, refusePerHome, boundaryImpact, combineValue, isWasteDepot, DEFAULT_TAX,
  type ServerMsg, type ClientMsg,
} from '@msimcity/shared';
import { World, emptyStats, tkey } from './world';
import { createGame } from './game';
import { snapshotOf, worldFromSnapshot } from './snapshot';
import type { Conn } from './transport';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const f2 = (v: number) => v.toFixed(2);
const TIP = KIND_ID['open-tip'], LANDFILL = KIND_ID['lined-landfill'], RECYCLING = KIND_ID['recycling-centre'], COMPOST = KIND_ID['compost-digester'], EFW = KIND_ID['energy-from-waste'];
const SEED = 4242;

// ---- the grades on paper ---------------------------------------------------------------------------------------
/** The value left at a site's own cell by its emission alone at `homes` a day (the average household; 1 = untouched). */
const valueAtSource = (kind: number, addons: number, homes: number) => {
  const u = refuseEmission(kind, addons, homes), b = new Array(VALUE_KIND_COUNT).fill(0);
  for (let k = 0; k < VALUE_KIND_COUNT; k++) b[k] = Math.round(255 * (1 - Math.exp(-u[k])));
  return combineValue(b, 0);
};
const v100 = REFUSE_GRADES.map((g) => ({ g, v: valueAtSource(g.kindId, 0, 100) }));
console.log(`value left at the site at 100 homes a day: ${v100.map(({ g, v }) => `${g.id} ${f2(v)}`).join(', ')}`);
ok(v100.every(({ g, v }) => g.kindId === TIP || v > v100[0].v), 'the open tip is the worst neighbour of the five grades at equal use');
const smell = (k: number) => refuseEmission(k, 0, 100)[ValueKind.Smell];
ok(REFUSE_GRADES.every((g) => g.kindId === TIP || smell(TIP) > smell(g.kindId)) && smell(LANDFILL) > smell(RECYCLING) && smell(LANDFILL) > smell(COMPOST),
  `smell and smoke at 100 homes a day: ${REFUSE_GRADES.map((g) => `${g.id} ${f2(smell(g.kindId))}`).join(', ')} (the tip worst; energy from waste counts its smoke)`);
ok(refuseEmission(TIP, 0, 0).every((v) => v === 0), 'a site with nothing coming in gives off nothing (nuisance follows use)');

let addonsLower = true, someLower = true;
for (const g of REFUSE_GRADES) for (const a of REFUSE_ADDONS) {
  const base = refuseEmission(g.kindId, 0, 80), withA = refuseEmission(g.kindId, a.bit, 80);
  let lower = false;
  for (let k = 0; k < VALUE_KIND_COUNT; k++) { if (withA[k] > base[k] + 1e-12) addonsLower = false; if (withA[k] < base[k] - 1e-12) lower = true; }
  if (!lower) someLower = false;
}
ok(addonsLower && someLower, 'every add-on lowers what every grade gives off (nothing rises, something falls)');
ok(refuseCapacity(TIP, RefuseAddon.Hours) < refuseCapacity(TIP, 0), `restricted hours take less a day (${refuseCapacity(TIP, RefuseAddon.Hours)} homes against ${refuseCapacity(TIP, 0)})`);
ok(refuseEmission(EFW, RefuseAddon.Enclosure, 100)[ValueKind.Smell] < 0.5 * refuseEmission(EFW, 0, 100)[ValueKind.Smell] && refusePerHome(EFW, RefuseAddon.Enclosure).levy < refusePerHome(EFW, 0).levy, 'an enclosure (scrubbers) more than halves the energy-from-waste plant\'s smoke, and its levy falls');

const tip100 = refuseDaily(TIP, 0, 100), rec100 = refuseDaily(RECYCLING, 0, 100), tip5 = refuseDaily(TIP, 0, 5), rec5 = refuseDaily(RECYCLING, 0, 5);
console.log(`a day at 100 homes: tip levy $${f2(tip100.levy)}, net $${f2(tip100.net)}; recycling levy $${f2(rec100.levy)}, sales $${f2(rec100.sales)}, net $${f2(rec100.net)}`);
ok(rec100.net < tip100.net, 'at 100 homes a day the recycling centre costs less to run than the tip once the levy applies (upkeep, wages, levy less sales)');
ok(tip5.net < rec5.net, `on a trickle (5 homes a day) the tip is cheaper ($${f2(tip5.net)} against $${f2(rec5.net)}): the levy is what tips it`);
ok(Math.abs(refusePerHome(TIP).levy - LANDFILL_LEVY.tonnesPerHome * LANDFILL_LEVY.perTonne) < 1e-12, `a tip pays the levy on every tonne: $${f2(refusePerHome(TIP).levy)} a home`);

// ---- a game over fake clients ----------------------------------------------------------------------------------
const world = new World(SEED);
for (let y = -10; y < 60; y++) for (let x = -10; x < 90; x++) world.setTile(x, y, packTile(Terrain.Grass, false, 0, 0));
let accept: ((c: Conn) => void) | null = null;
const game = createGame(world, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false });
const sim = game.sim, refuse = sim.refuse;
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
for (const c of [ada, bob, cy]) world.players.get(c.id)!.money = 1e6;
const parcel = (owner: string, x: number, y: number, w: number, h: number) => {
  const p = { id: world.nextId++, owner, name: owner, x, y, w, h, taxRate: DEFAULT_TAX, stats: emptyStats() };
  world.parcels.set(p.id, p);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) world.setParcelId(xx, yy, p.id);
};
parcel('ada', 0, 0, 48, 24); // Ada: 48 by 24, a street along y = 10
parcel('bob', 48, 0, 16, 16); // Bob: east of her, his border three tiles from where she first tries a tip
const ledger = (id: string) => world.players.get(id)!.ledger?.today ?? {};
ada.send({ t: 'build', tool: 'road', tiles: Array.from({ length: 48 }, (_, i) => [i, 10] as [number, number]), dev: true, cls: 0 });
ok(world.publicRoads.size === 0 && [0, 20, 47].every((x) => world.getTile(x, 10) !== undefined), 'Ada lays a street across her land');
const place = (who: ReturnType<typeof client>, tool: string, x: number, y: number) => { who.toasts.length = 0; who.send({ t: 'build', tool: tool as never, tiles: [[x, y]], dev: true }); return who.last(); };
const siteAt = (x: number, y: number) => world.sites.get(`${x},${y}`);

const near = boundaryImpact(TIP, 0, 44, 9, SEED, 'ada', (x, y) => world.parcelAt(x, y)?.owner);
console.log(`a tip at (44, 9) would push onto Bob's land: ${near.worst.map((v, k) => (VALUE_KINDS[k].nuisance && v > 0 ? `${VALUE_KINDS[k].name} ${Math.round(v * 100)}% (limit ${Math.round(BOUNDARY_LIMITS[k] * 100)}%)` : '')).filter(Boolean).join(', ')}`);
let why = place(ada, 'opentip', 44, 9);
ok(/limit at a boundary/.test(why) && /Bob's land/.test(why) && !siteAt(44, 9), `a tip three tiles from Bob's land is refused, naming him and the limit ("${why.slice(0, 110)}...")`);
why = place(ada, 'compost', 44, 9);
ok(siteAt(44, 9)?.kind === COMPOST, `a composting and digester site in the same place is allowed${why ? ` (${why})` : ''}`);
why = place(ada, 'opentip', 4, 9);
ok(siteAt(4, 9)?.kind === TIP, `a tip set back 44 tiles from Bob's land is allowed${why ? ` (${why})` : ''}`);
ok(/limit/.test(place(ada, 'landfill', 40, 9)), 'a lined landfill 7 tiles from Bob\'s land is refused too');
const self = boundaryImpact(TIP, 0, 4, 9, SEED, 'ada', (x, y) => (world.parcelAt(x, y) ? 'ada' : null));
ok(self.ok && self.worst.every((v) => v === 0), "own land is not limited: a tip with nothing but the builder's own land round it pushes nothing onto anyone");

// finish both sites
for (const [x, y] of [[4, 9], [44, 9]]) world.completeSite(siteAt(x, y)!);
const tipB = world.buildings.get('4,9')!, compB = world.buildings.get('44,9')!;
ok(tipB?.id === TIP && compB?.id === COMPOST && tipB.level > 0, 'both sites are finished');

// ---- add-ons
let money0 = world.players.get('ada')!.money;
ada.send({ t: 'refuseAddon', x: 44, y: 9, addon: 'screening', on: true });
ok(world.refuseAddons.get('44,9') === RefuseAddon.Screening && Math.abs(world.players.get('ada')!.money - (money0 - REFUSE_ADDONS[1].cost)) < 1e-9, `fitting screening costs $${REFUSE_ADDONS[1].cost}`);
bob.toasts.length = 0;
bob.send({ t: 'refuseAddon', x: 44, y: 9, addon: 'enclosure', on: true });
ok(/Not your/.test(bob.last()) && world.refuseAddons.get('44,9') === RefuseAddon.Screening, 'Bob may not change Ada\'s site');
ada.send({ t: 'refuseAddon', x: 4, y: 9, addon: 'hours', on: true });
ok(world.refuseAddons.get('4,9') === RefuseAddon.Hours, 'Ada restricts the tip\'s hours (free)');
// Cy buys land 13 tiles south of the tip: now it is over the limit there, so the hours may not be lifted
parcel('cy', 0, 24, 16, 8);
ada.toasts.length = 0;
ada.send({ t: 'refuseAddon', x: 4, y: 9, addon: 'hours', on: false });
why = ada.last();
ok(world.refuseAddons.get('4,9') === RefuseAddon.Hours && /Cy's land/.test(why), `with Cy's land 13 tiles away, lifting the restricted hours is refused (${why.slice(0, 90)}...)`);
ada.send({ t: 'refuseAddon', x: 4, y: 9, addon: 'enclosure', on: true });
ok(world.refuseAddons.get('4,9') === (RefuseAddon.Hours | RefuseAddon.Enclosure), 'fitting an enclosure, which lowers it, is still allowed');
ada.send({ t: 'refuseAddon', x: 4, y: 9, addon: 'enclosure', on: false });
ok(world.refuseAddons.get('4,9') === (RefuseAddon.Hours | RefuseAddon.Enclosure), 'and taking it off again is refused');

// ---- the levy, sales and the fund
const fund0 = world.regional.fund, ad0 = { ...ledger('ada') };
refuse.tip([4, 9], 40);
const tipLevy = 40 * refusePerHome(TIP, world.refuseAddons.get('4,9')).levy;
ok(Math.abs(world.regional.fund - fund0 - tipLevy) < 1e-9 && Math.abs((ledger('ada').levy ?? 0) - (ad0.levy ?? 0) + tipLevy) < 1e-9,
  `40 homes tipped at the tip: ${40 * LANDFILL_LEVY.tonnesPerHome} t landfilled pay $${f2(tipLevy)} levy from Ada into the regional fund ($${f2(world.regional.fund)})`);
const fund1 = world.regional.fund;
refuse.tip([44, 9], 40);
const ph = refusePerHome(COMPOST, RefuseAddon.Screening);
ok(Math.abs(world.regional.fund - fund1 - 40 * ph.levy) < 1e-9 && Math.abs((ledger('ada').recycling ?? 0) - 40 * ph.sales) < 1e-9,
  `40 homes at the composting site: levy only on its ${Math.round(100 * REFUSE_GRADES[3].landfill)}% residue ($${f2(40 * ph.levy)}), $${f2(40 * ph.sales)} of gas and compost sold`);
const info = refuse.siteInfo(tipB, true)!;
ok(info.today.homes === 40 && Math.abs(info.today.levy - tipLevy) < 0.01 && info.addons.filter((a) => a.on).length === 2, `the tip's panel: ${info.today.homes} homes, ${info.today.tonnes} t, levy $${info.today.levy}; ${info.summary}`);
const up0 = ledger('ada').upkeep ?? 0;
refuse.newDay();
ok(Math.abs((ledger('ada').upkeep ?? 0) - up0 + REFUSE_ADDONS[0].upkeep + REFUSE_ADDONS[1].upkeep) < 1e-9, 'at midnight the add-ons\' upkeep is charged (enclosure and screening; restricted hours costs nothing)');

// the fund pays adopted public roads
const pr = sim.publicRoads;
ok(typeof pr.regionalFund === 'function', 'the regional fund is wired to PublicRoads.regionalFund');
const f0 = world.regional.fund, paid0 = world.regional.paid;
pr.regionalFund!(5);
ok(Math.abs(world.regional.fund - (f0 - 5)) < 1e-9 && Math.abs(world.regional.paid - paid0 - 5) < 1e-9, `the fund pays $5 of adopted road upkeep ($${f2(f0)} -> $${f2(world.regional.fund)})`);
const left = world.regional.fund;
pr.regionalFund!(left + 3);
ok(world.regional.fund === 0 && Math.abs(world.regional.short - 3) < 1e-9, 'past what it holds it pays what it has; the rest is nobody\'s (short $3)');
world.regional.fund = 20; // for the save below

// ---- routing: a refuse site before an old depot, until its day is full
let legacy: [number, number] | null = null;
for (let x = 12; x < 40 && !legacy; x++) for (const y of [11, 12]) if (isWasteDepot(Zone.Industrial, x, y)) { legacy = [x, y]; break; }
if (legacy) world.setTile(legacy[0], legacy[1], packTile(Terrain.Grass, false, Zone.Industrial, 1));
const legacyB = legacy && world.buildings.get(`${legacy[0]},${legacy[1]}`);
tipB.occupants = 6; compB.occupants = 6; if (legacyB) legacyB.occupants = 6;
type R = { depotsNear(x: number, y: number, homes?: number): { x: number; y: number } | null; planned: Map<number, number> };
const rr = refuse as unknown as R;
const lx = legacy ? legacy[0] : 20;
const pick = rr.depotsNear(lx, 12, 30);
ok(legacyB && pick?.x === 4 && pick.y === 9, `a district beside an old depot at (${legacy}) goes to the tip further off: a refuse site with room comes first`);
rr.planned.set(tkey(4, 9), refuseCapacity(TIP, world.refuseAddons.get('4,9')));
rr.planned.set(tkey(44, 9), refuseCapacity(COMPOST, RefuseAddon.Screening));
const pick2 = rr.depotsNear(lx, 12, 30);
ok(pick2?.x === legacy?.[0], 'once both sites\' day is full the old depot takes it');
rr.planned.clear();

// ---- the value field: the tip smells more than the composting site at the same use
for (let i = 0; i < 6; i++) sim.value.refresh();
const sTip = sim.value.kindAt(4, 9, ValueKind.Smell), sComp = sim.value.kindAt(44, 9, ValueKind.Smell);
ok(sTip > sComp && sTip > 0, `the value field: smell at the tip ${f2(sTip)} against the composting site ${f2(sComp)} after 40 homes each`);

// ---- save round trip
const loaded = worldFromSnapshot(JSON.parse(JSON.stringify(snapshotOf(world))));
ok(loaded && loaded.regional.fund === 20 && Math.abs(loaded.regional.levied - world.regional.levied) < 1e-9 && loaded.refuseAddons.get('4,9') === (RefuseAddon.Hours | RefuseAddon.Enclosure) && loaded.refuseAddons.get('44,9') === RefuseAddon.Screening,
  'a save round trip keeps the fund, its totals and the add-ons');
const before = worldFromSnapshot(JSON.parse(JSON.stringify({ ...snapshotOf(world), refuse: undefined })));
ok(before && before.regional.fund === 0 && before.refuseAddons.size === 0, 'a save from before M4 loads with an empty fund and no add-ons');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall refuse checks passed');
process.exit(failed ? 1 : 0);
