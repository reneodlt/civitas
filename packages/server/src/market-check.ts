/**
 * `npm run market:check` (docs/multiplayer-land.md section 7 "Land", phase M7): the land market over fake clients.
 *
 * - list → offer → accept moves the parcel, what is on it and the money (ledger `land` and `landsale`), with toasts;
 *   an offer past the buyer's spendable money is refused; buying at the asking price is immediate;
 * - listings lapse after LAND_DEALS.listingDays, and one whose land was split goes;
 * - a covenant set at listing binds the buyer (no industrial zoning, no tip; a level cap holds growth back; a park
 *   covenant refuses houses) and survives a resale without one; a listing whose land already breaks it is refused;
 * - a lease: the tenant builds as owner and the landlord cannot, rent each midnight on both ledgers, a leased parcel
 *   cannot be split, the landlord may sell it with the lease, and at the end of the term the land goes back with what
 *   is on it; a tenant in administration misses the rent and the lease ends;
 * - a neighbour pact: the strip refuses heavy nuisance (industrial zoning, a tip) on either side, outside it is fine;
 *   ended with notice it lifts after LAND_DEALS.pactNoticeDays;
 * - walling in is refused on a transfer, and on a market world a far sale must be an outpost of at least 8×8;
 * - a snapshot round trip keeps listings, leases, pacts and covenants; an older save without them loads;
 * - a showcase refuses the intents.
 *
 *   npx tsx packages/server/src/market-check.ts
 */
import { Terrain, Zone, DEFAULT_TAX, ECONOMY_TUNING, LAND_DEALS, KIND_ID, packTile, type ServerMsg, type ClientMsg, type DealsView } from '@msimcity/shared';
import { World, emptyStats, type Parcel } from './world';
import { createGame } from './game';
import { snapshotOf, worldFromSnapshot } from './snapshot';
import type { Conn } from './transport';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

function setup(cfg: { market?: boolean; spectate?: boolean } = {}) {
  const world = new World(4242);
  for (let y = -10; y < 80; y++) for (let x = -10; x < 110; x++) world.setTile(x, y, packTile(Terrain.Grass, false, 0, 0));
  let accept: ((c: Conn) => void) | null = null;
  const game = createGame(world, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false, ...cfg });
  function client(name: string) {
    const toasts: string[] = [];
    let deals: DealsView | null = null;
    let onMsg: ((d: string) => void) | null = null;
    accept!({ open: true, send: (d) => { const m = JSON.parse(d) as ServerMsg; if (m.t === 'toast') toasts.push(m.msg); if (m.t === 'deals') deals = m; }, close() {}, onMessage: (fn) => { onMsg = fn; }, onClose() {} });
    const send = (m: ClientMsg) => onMsg!(JSON.stringify(m));
    send({ t: 'hello', name });
    const last = () => { const t = toasts.join(' | '); toasts.length = 0; return t; };
    const act = (m: ClientMsg) => { toasts.length = 0; send(m); return last(); };
    return { send, toasts, last, act, id: name.toLowerCase(), deals: () => deals!, p: () => world.players.get(name.toLowerCase())! };
  }
  const parcel = (owner: string, x: number, y: number, w: number, h: number, name = owner) => {
    const p: Parcel = { id: world.nextId++, owner, name, x, y, w, h, taxRate: DEFAULT_TAX, stats: emptyStats() };
    world.parcels.set(p.id, p);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) world.setParcelId(xx, yy, p.id);
    world.recountRoads(p.id);
    return p;
  };
  return { world, game, client, parcel };
}

// ================================================================= a classic world
const { world, game, client, parcel } = setup();
const deals = game.deals;
const ada = client('Ada'), bob = client('Bob'), cy = client('Cy');
for (const c of [ada, bob, cy]) c.p().money = 100_000;
const ledger = (id: string) => world.players.get(id)!.ledger?.today ?? {};
const A1 = parcel('ada', 0, 0, 16, 16, 'Ada east'), A2 = parcel('ada', 16, 0, 16, 16, 'Ada west');
parcel('bob', 60, 0, 16, 16, 'Bob farm');
const build = (who: ReturnType<typeof client>, tool: string, tiles: [number, number][], extra: Partial<ClientMsg> = {}) => who.act({ t: 'build', tool: tool as never, tiles, dev: true, ...extra } as ClientMsg);
// Ada's street and a house on A1
build(ada, 'road', Array.from({ length: 32 }, (_, i) => [i, 10] as [number, number]), { cls: 0 } as Partial<ClientMsg>);
world.setTile(3, 9, packTile(Terrain.Grass, false, Zone.Residential, 1));
const roadsA1 = A1.stats.roads;
ok(roadsA1 === 16 && world.parcelAt(3, 9)?.owner === 'ada', `Ada has a street (${roadsA1} road tiles on Ada east) and a house`);
game.step();

// ---- list, offer, accept -------------------------------------------------------------------------------------
let r = ada.act({ t: 'land', op: 'list', id: A1.id, price: 5000 });
ok(/for sale at \$5,000/.test(r), `Ada lists Ada east at $5,000 ("${r}")`);
game.step();
const L1 = bob.deals().listings.find((l) => l.parcels.includes(A1.id));
ok(L1 && L1.price === 5000 && L1.seller === 'ada' && L1.expires === world.day + LAND_DEALS.listingDays, 'every client sees the listing, with its price and the day it lapses');
ok(/already for sale/.test(ada.act({ t: 'land', op: 'list', id: A1.id, price: 4000 })), 'land can be listed once at a time');
ok(/Not your land/.test(bob.act({ t: 'land', op: 'list', id: A1.id, price: 1 })), 'Bob cannot list Ada\'s land');
bob.p().money = 1000 - ECONOMY_TUNING.overdraftLimit;
ok(/Need \$3,000/.test(bob.act({ t: 'land', op: 'offer', listing: L1!.id, amount: 3000 })), 'an offer past the buyer\'s spendable money is refused');
bob.p().money = 100_000;
r = bob.act({ t: 'land', op: 'offer', listing: L1!.id, amount: 3000 });
ok(/Offer of \$3,000 made/.test(r), `Bob offers $3,000 ("${r}")`);
game.step();
ok(ada.toasts.some((t) => /Bob offers \$3,000/.test(t)), 'Ada is told of the offer');
const off = ada.deals().offers.find((o) => o.listing === L1!.id && o.buyer === 'bob');
ok(off && !cy.deals().offers.length, 'the seller and the buyer see the offer; nobody else does');
const am0 = ada.p().money, bm0 = bob.p().money;
r = ada.act({ t: 'land', op: 'accept', offer: off!.id });
game.step();
ok(/Sold to Bob for \$3,000/.test(r) && A1.owner === 'bob', `Ada accepts: Ada east is Bob's ("${r}")`);
ok(bob.p().money === bm0 - 3000 && ada.p().money === am0 + 3000 && ledger('bob').land === -3000 && ledger('ada').landsale === 3000,
  'the money moves: Bob\'s ledger "Land" −$3,000, Ada\'s "Land sales" +$3,000');
ok(world.parcelAt(3, 9)?.owner === 'bob' && A1.stats.roads === roadsA1 && world.roadUpkeepOf(A1) > 0, 'the house and the street go with it: Bob pays their upkeep now');
ok(bob.toasts.some((t) => /is yours/.test(t)), 'Bob is told the land is his');
ok(!bob.deals().listings.some((l) => l.id === L1!.id), 'the listing is gone');
ok(/Not your land/.test(build(ada, 'res', [[5, 8]])) && !/Not your land/.test(build(bob, 'res', [[5, 8]])), 'Ada can no longer zone there; Bob can');

// ---- buy now, with a covenant -------------------------------------------------------------------------------
r = ada.act({ t: 'land', op: 'list', id: A2.id, price: 2000, cov: { noHeavy: 1 } });
ok(/covenant no heavy industry/.test(r), `Ada lists Ada west at $2,000 with "no heavy industry" ("${r}")`);
const L2 = deals.view('cy').listings.find((l) => l.parcels.includes(A2.id))!;
const cm0 = cy.p().money;
r = cy.act({ t: 'land', op: 'buy', listing: L2.id });
ok(/Bought Ada west for \$2,000/.test(r) && A2.owner === 'cy' && cy.p().money === cm0 - 2000, `Cy buys at the asking price, at once ("${r}")`);
ok(A2.cov?.noHeavy === 1 && game.world.parcelDTO(A2).cov?.noHeavy === 1, 'the covenant is on the parcel (and in its DTO for the panel)');
ok(/covenant: no heavy industry/.test(build(cy, 'ind', [[20, 5]])) && world.kindIdAt(20, 5) === 0, 'Cy may not zone industry there');
ok(/covenant: no heavy industry/.test(build(cy, 'opentip', [[20, 11]])) && !world.sites.get('20,11'), 'nor build a tip');
build(cy, 'res', [[20, 5]]);
ok(world.kindIdAt(20, 5) === Zone.Residential, 'homes are fine');
// resale without a covenant: it still binds
r = cy.act({ t: 'land', op: 'list', id: A2.id, price: 100 });
r = bob.act({ t: 'land', op: 'buy', listing: deals.view('bob').listings.find((l) => l.parcels.includes(A2.id))!.id });
ok(A2.owner === 'bob' && A2.cov?.noHeavy === 1 && /covenant: no heavy industry/.test(build(bob, 'ind', [[22, 5]])), 'resold without one, the covenant still binds the next owner');
// a covenant the land already breaks is refused
r = bob.act({ t: 'land', op: 'list', id: A2.id, price: 100, cov: { park: 1 } });
ok(/would already be broken/.test(r), `a park covenant on land with zoned homes is refused ("${r.slice(0, 90)}...")`);
// level cap: growth held back
const C = parcel('ada', 0, 30, 16, 16, 'Ada low');
world.setTile(2, 35, packTile(Terrain.Grass, false, Zone.Residential, 1));
ada.act({ t: 'land', op: 'list', id: C.id, price: 10, cov: { maxLevel: 2 } });
cy.act({ t: 'land', op: 'buy', listing: deals.view('cy').listings.find((l) => l.parcels.includes(C.id))!.id });
const house = { x: 2, y: 35, zone: Zone.Residential, id: Zone.Residential, level: 1, occupants: 0 };
ok(C.owner === 'cy' && deals.mayGrow(house, 2) && !deals.mayGrow(house, 3) && !game.sim.powerGate!(house, 3), 'with "no building over 2 levels" growth to level 3 is held back (the growth gate)');
// park covenant
const P = parcel('ada', 20, 30, 8, 8, 'Ada green');
ada.act({ t: 'land', op: 'list', id: P.id, price: 10, cov: { park: 1 } });
cy.act({ t: 'land', op: 'buy', listing: deals.view('cy').listings.find((l) => l.parcels.includes(P.id))!.id });
build(cy, 'road', Array.from({ length: 8 }, (_, i) => [20 + i, 37] as [number, number]), { cls: 0 } as Partial<ClientMsg>);
ok(/stays a park/.test(build(cy, 'res', [[22, 36]])), 'on "stays a park" land homes are refused');
build(cy, 'citypark', [[22, 36]]);
ok(world.kindIdAt(22, 36) === KIND_ID['park'] || world.sites.has('22,36'), 'a park is fine (and roads)');

// ---- expiry, and a listing whose land changed ----------------------------------------------------------------
const E = parcel('ada', 40, 30, 16, 16, 'Ada spare');
ada.act({ t: 'land', op: 'list', id: E.id, price: 900 });
const LE = deals.view('ada').listings.find((l) => l.parcels.includes(E.id))!;
bob.act({ t: 'land', op: 'offer', listing: LE.id, amount: 500 });
world.day += LAND_DEALS.listingDays - 1; deals.midnight();
ok(deals.view('ada').listings.some((l) => l.id === LE.id), `a listing is still up after ${LAND_DEALS.listingDays - 1} days`);
world.day += 1; deals.midnight(); game.step();
ok(!deals.view('ada').listings.some((l) => l.id === LE.id) && !deals.view('bob').offers.length, `after ${LAND_DEALS.listingDays} it lapses, with its offers`);
ok(ada.toasts.some((t) => /lapsed/.test(t)) && bob.toasts.some((t) => /your offer lapsed/.test(t)), 'seller and bidder are told');
ada.act({ t: 'land', op: 'list', id: E.id, price: 900 });
ada.act({ t: 'parcelOp', op: 'split', id: E.id, axis: 'x', at: 48 });
deals.tick(); world.tick += 25 - (world.tick % 25); deals.tick();
ok(!deals.view('ada').listings.some((l) => l.parcels.includes(E.id)), 'split after listing: the listing goes (the seller splits first, then lists the piece)');

// ---- leases -------------------------------------------------------------------------------------------------
// Bob leases Ada east (A1) to Cy: 50 a day for 3 days
r = bob.act({ t: 'land', op: 'lease', id: A1.id, rent: 50, days: 3, tenant: 'Cy' });
ok(/offered for lease at \$50 a day for 3 days to Cy/.test(r), `Bob offers Cy a lease ("${r}")`);
const LO = deals.view('cy').leaseOffers.find((o) => o.parcel === A1.id)!;
ok(/someone else/.test(ada.act({ t: 'land', op: 'leaseAccept', lease: LO.id })), 'a lease offered to Cy cannot be taken by Ada');
r = cy.act({ t: 'land', op: 'leaseAccept', lease: LO.id });
ok(/yours to build on until day/.test(r) && A1.owner === 'cy', `Cy takes it: the tenant holds the parcel ("${r}")`);
ok(/Not your land/.test(build(bob, 'res', [[6, 8]])) && !/Not your land/.test(build(cy, 'res', [[6, 8]])) && world.kindIdAt(6, 8) === Zone.Residential, 'the tenant zones as owner; the landlord cannot');
ok(/lease is running/.test(cy.act({ t: 'parcelOp', op: 'split', id: A1.id, axis: 'x', at: 8 })), 'a leased parcel cannot be split');
ok(/Not your land/.test(cy.act({ t: 'land', op: 'list', id: A1.id, price: 1 })), 'the tenant cannot sell it');
const cR = cy.p().money, bR = bob.p().money;
world.day += 1; deals.midnight();
ok(cy.p().money === cR - 50 && bob.p().money === bR + 50 && ledger('cy').rent === -50 && ledger('bob').rent === 50, 'at midnight the rent moves: "Land rent" −$50 for Cy, +$50 for Bob');
// the landlord sells: the lease goes with it
bob.act({ t: 'land', op: 'list', id: A1.id, price: 1000 });
r = ada.act({ t: 'land', op: 'buy', listing: deals.view('ada').listings.find((l) => l.parcels.includes(A1.id))!.id });
ok(/Bought/.test(r) && A1.owner === 'cy' && deals.leaseOn(A1.id)?.landlord === 'ada', 'Bob sells the freehold to Ada: the lease goes with it (Ada is the landlord, Cy keeps building)');
world.day += 2; deals.midnight(); game.step();
ok(A1.owner === 'ada' && !deals.leaseOn(A1.id) && world.kindIdAt(6, 8) === Zone.Residential, 'at the end of the term the land goes back to Ada, with Cy\'s zoning on it');
ok(cy.toasts.some((t) => /lease on .* ended/.test(t)), 'the tenant is told');
// missed rent
ada.act({ t: 'land', op: 'lease', id: A1.id, rent: 20, days: 10 });
cy.act({ t: 'land', op: 'leaseAccept', lease: deals.view('cy').leaseOffers.find((o) => o.parcel === A1.id)!.id });
ok(A1.owner === 'cy', 'an open lease offer: Cy takes it');
cy.p().admin = { since: world.day };
const aR = ada.p().money;
world.day += 1; deals.midnight();
ok(A1.owner === 'ada' && !deals.leaseOn(A1.id) && ada.p().money === aR, 'Cy goes into administration: the rent is missed and the lease ends at midnight');
delete cy.p().admin;

// ---- neighbour pacts ------------------------------------------------------------------------------------------
// Ada east (A1, Ada's) and Ada west (A2, Bob's now) share an edge at x = 16
r = ada.act({ t: 'land', op: 'pact', pa: A1.id, pb: A2.id, strip: { x: 12, y: 0, w: 8, h: 10 } });
ok(/Pact proposed to Bob/.test(r), `Ada proposes a buffer strip ("${r}")`);
const PA = deals.view('bob').pacts.find((p) => p.pa === A1.id)!;
ok(PA.state === 'proposed' && /not yours/.test(cy.act({ t: 'land', op: 'pactAccept', pact: PA.id })), 'only Bob may accept it');
bob.act({ t: 'land', op: 'pactAccept', pact: PA.id });
ok(deals.view('ada').pacts.find((p) => p.id === PA.id)?.state === 'active', 'Bob accepts: the pact is active');
ok(/buffer strip/.test(build(ada, 'ind', [[13, 3]])) && world.kindIdAt(13, 3) === 0, 'Ada may not zone industry in the strip on her own side');
r = build(ada, 'opentip', [[13, 9]]);
ok(/buffer strip/.test(r) && !world.sites.get('13,9'), `nor put a tip with a tile in it ("${r.slice(0, 80)}")`);
build(ada, 'ind', [[4, 3]]);
ok(world.kindIdAt(4, 3) === Zone.Industrial, 'outside the strip industry is fine');
build(ada, 'res', [[13, 3]]);
ok(world.kindIdAt(13, 3) === Zone.Residential, 'homes in the strip are fine');
r = bob.act({ t: 'land', op: 'pactEnd', pact: PA.id });
ok(/ends on day/.test(r), `Bob gives notice ("${r}")`);
world.day += LAND_DEALS.pactNoticeDays - 1; deals.midnight();
ok(/buffer strip/.test(build(ada, 'ind', [[14, 3]])), 'the strip holds during the notice');
world.day += 1; deals.midnight();
build(ada, 'ind', [[14, 3]]);
ok(!deals.view('ada').pacts.length && world.kindIdAt(14, 3) === Zone.Industrial, `after ${LAND_DEALS.pactNoticeDays} days it has ended`);

// ---- walling in on transfer ------------------------------------------------------------------------------------
// Eve's 4×4 at (80, 50), Bob round it on three sides, Ada's 4×4 on the fourth
parcel('eve', 80, 50, 4, 4, 'Eve');
parcel('bob', 76, 50, 4, 4); parcel('bob', 76, 46, 12, 4); parcel('bob', 76, 54, 12, 4);
const R = parcel('ada', 84, 50, 4, 4, 'Ada nook');
ada.act({ t: 'land', op: 'list', id: R.id, price: 50 });
const LR = deals.view('bob').listings.find((l) => l.parcels.includes(R.id))!;
r = bob.act({ t: 'land', op: 'buy', listing: LR.id });
ok(/would cut off eve's parcel/i.test(r) && R.owner === 'ada', `Bob may not buy the piece that closes the ring round Eve ("${r}")`);
r = cy.act({ t: 'land', op: 'buy', listing: LR.id });
ok(R.owner === 'cy', 'Cy may');

// ---- the snapshot round trip --------------------------------------------------------------------------------------
ada.act({ t: 'land', op: 'list', id: A1.id, price: 777, cov: { maxLevel: 3 } });
bob.act({ t: 'land', op: 'offer', listing: deals.view('bob').listings.find((l) => l.parcels.includes(A1.id))!.id, amount: 600 });
bob.act({ t: 'land', op: 'lease', id: A2.id, rent: 9, days: 5 });
cy.act({ t: 'land', op: 'leaseAccept', lease: deals.view('cy').leaseOffers.find((o) => o.parcel === A2.id)!.id });
ada.act({ t: 'land', op: 'pact', pa: A1.id, pb: A2.id, strip: { x: 14, y: 4, w: 4, h: 4 } });
const snap = JSON.parse(JSON.stringify(snapshotOf(world)));
ok(snap.landDeals && snap.landDeals.listings.length === 1 && snap.landDeals.leases.length === 1 && snap.landDeals.pacts.length === 1 && snap.landDeals.offers.length === 1, 'the snapshot carries the listing, its offer, the lease and the pact');
const w2 = worldFromSnapshot(snap)!;
const g2 = createGame(w2, { onConnection() {} }, { devTools: false, sandbox: false });
const v1 = JSON.stringify(deals.view('bob')), v2 = JSON.stringify(g2.deals.view('bob'));
ok(v1 === v2, 'loaded, the market is the same');
ok(w2.parcels.get(A2.id)?.cov?.noHeavy === 1 && w2.parcels.get(C.id)?.cov?.maxLevel === 2 && w2.parcels.get(A2.id)?.owner === 'cy', 'covenants and the tenant come back with the parcels');
ok(/lease is running/.test(String(w2.splitParcel(A2.id, 'x', 20, () => true))), 'and the leased parcel is still locked');
delete snap.landDeals;
for (const q of snap.parcels) delete q.cov;
const w3 = worldFromSnapshot(snap)!;
const g3 = createGame(w3, { onConnection() {} }, { devTools: false, sandbox: false });
ok(w3 && !g3.deals.view('x').listings.length && g3.deals.save() === null, 'a save from before M7 loads with an empty market');

// ================================================================= a market world: outposts
{
  const m = setup({ market: true });
  const gus = m.client('Gus'), hal = m.client('Hal');
  gus.p().money = hal.p().money = 10_000;
  const small = m.parcel('gus', 90, 60, 4, 4, 'Gus scrap');
  m.parcel('hal', 0, 0, 16, 16, 'Hal home');
  gus.act({ t: 'land', op: 'list', id: small.id, price: 10 });
  const l = m.game.deals.view('hal').listings[0];
  r = hal.act({ t: 'land', op: 'buy', listing: l.id });
  ok(m.game.land.market && /at least 8×8/.test(r) && small.owner === 'gus', `on a market world a 4×4 far from the buyer's land is refused: an outpost ("${r}")`);
  const near = m.parcel('gus', 16, 0, 4, 4, 'Gus edge');
  gus.act({ t: 'land', op: 'list', id: near.id, price: 10 });
  hal.act({ t: 'land', op: 'buy', listing: m.game.deals.view('hal').listings.find((x) => x.parcels.includes(near.id))!.id });
  ok(near.owner === 'hal', 'a 4×4 touching his land is fine');
}

// ================================================================= a showcase refuses
{
  const s = setup({ spectate: true });
  const vic = s.client('Vic');
  const q = s.parcel('vic', 0, 0, 8, 8);
  ok(/Read-only/.test(vic.act({ t: 'land', op: 'list', id: q.id, price: 1 })), 'a showcase refuses land deals');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall market checks passed');
process.exit(failed ? 1 : 0);
