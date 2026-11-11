/**
 * `npm run land:check` (docs/multiplayer-land.md section 3, phase M2): land and money on a shared world, driven over fake
 * clients in a Commons world with the market rules on (GameConfig.market):
 *
 * - a new player starts with LAND_TUNING.startMoney and a free homestead (the first purchase up to 16×16), which must be
 *   at least outpostMin a side; a frontier, a sandbox and a server without `market` keep the classic rules;
 * - land is priced by the value field: wilderness at $1-2 a tile, more near the town, and the client works out the
 *   same price from the `landPrice` bytes it was sent (and a stale quote is refused);
 * - outposts: land not touching yours may be bought if it is at least outpostMin a side; walling a neighbour in is
 *   still refused;
 * - the empty-land tax: each midnight a share of the price of owned tiles with nothing on them (ledger `landtax`), less
 *   once something is built, paused when the owner has been away awayPauseDays;
 * - abandoned land: after abandonEmptyDays away an unbuilt parcel goes back to the market (its roads stay, public and
 *   unpaid) and the owner gets its price; after abandonBuiltDays built land goes to the Commons;
 * - the recovery plan's sell-back is paid at the market price, not the flat one.
 *
 *   npx tsx packages/server/src/land-check.ts
 */
import {
  LAND_TUNING as L, ECONOMY_TUNING, Terrain, Zone, TICKS_PER_DAY, TICKS_PER_HOUR, START_MONEY, FRONTIER_MONEY, packTile, isBuildable,
  isRoad, landPriceOf, b64ToU8, chunkKey, tilePriceOfValue, priceOfByte, priceByte, wildPriceByte, type ServerMsg, type ClientMsg,
} from '@msimcity/shared';
import { World, tkey } from './world';
import { seedCommons, seedFrontier } from './seed';
import { createGame } from './game';
import type { Conn } from './transport';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const usd = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString('en-GB')}`;

// ---- the price curve itself (shared/src/land.ts) -----------------------------------------------------------
ok(tilePriceOfValue(1) === L.base && L.base >= 1 && L.base <= 2, `land value 1 (open country) is the base price, ${usd(L.base)} a tile`);
ok(tilePriceOfValue(1.4) > 4 * L.base && tilePriceOfValue(0.7) >= L.min, `value 1.4 costs ${usd(tilePriceOfValue(1.4))} a tile, value 0.7 ${usd(tilePriceOfValue(0.7))} (never under ${usd(L.min)})`);
ok(Math.abs(priceOfByte(priceByte(7.3)) - 7.3) / 7.3 < 0.01, 'a price survives its byte within 1%');

// ---- a Commons world with the market rules -----------------------------------------------------------------
const world = new World(4242);
seedCommons(world, 3);
// dry grass for the scenes far out (east of the town): nothing of the seed's water in the way
for (let y = 100; y < 260; y++) for (let x = 100; x < 260; x++) if (!isBuildable(world.getTile(x, y))) world.setTile(x, y, packTile(Terrain.Grass, false, 0, 0));
let accept: ((c: Conn) => void) | null = null;
const game = createGame(world, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false, market: true });
const land = game.land;
ok(land.market, 'a Commons world with `market` plays the market rules');

function client(name: string) {
  const toasts: string[] = [];
  const prices = new Map<string, Uint8Array>();
  let welcome: Extract<ServerMsg, { t: 'welcome' }> | null = null;
  let onMsg: ((d: string) => void) | null = null;
  let onClose: (() => void) | null = null;
  const conn: Conn = {
    open: true, send: (d) => {
      const m = JSON.parse(d) as ServerMsg;
      if (m.t === 'toast') toasts.push(m.msg);
      if (m.t === 'welcome') welcome = m;
      if (m.t === 'landPrice') { if (m.d) prices.set(chunkKey(m.cx, m.cy), b64ToU8(m.d)); else prices.delete(chunkKey(m.cx, m.cy)); }
    }, close() {}, onMessage: (fn) => { onMsg = fn; }, onClose: (fn) => { onClose = fn; },
  };
  accept!(conn);
  const send = (m: ClientMsg) => onMsg!(JSON.stringify(m));
  send({ t: 'hello', name });
  const last = () => { const t = toasts.join(' | '); toasts.length = 0; return t; };
  const buy = (x: number, y: number, w: number, h: number, q?: number) => { toasts.length = 0; send({ t: 'buy', x, y, w, h, ...(q !== undefined ? { q } : {}) }); return last(); };
  const leave = () => { (conn as { open: boolean }).open = false; onClose?.(); };
  return { send, toasts, last, buy, leave, prices, id: name.toLowerCase(), welcome: () => welcome, p: () => world.players.get(name.toLowerCase())! };
}
const join = (acc: (c: Conn) => void, name: string) => { let f: ((d: string) => void) | null = null; acc({ open: true, send() {}, close() {}, onMessage: (fn) => { f = fn; }, onClose() {} }); f!(JSON.stringify({ t: 'hello', name })); };
const step = (n: number) => { for (let i = 0; i < n; i++) game.step(); };
const midnight = () => { const d = world.day; while (world.day === d) game.step(); };
const parcelsOf = (id: string) => [...world.parcels.values()].filter((q) => q.owner === id);
const ledger = (id: string) => world.players.get(id)!.ledger?.today ?? {};

// a day of the town for the value field to settle
step(TICKS_PER_DAY);

// ---- the homestead and the start --------------------------------------------------------------------------
const ada = client('Ada');
ok(ada.welcome()?.land === 'market', 'the welcome tells the client the market rules are on');
ok(ada.p().money === L.startMoney && ada.p().homestead === L.homestead, `Ada starts with ${usd(L.startMoney)} (not ${usd(START_MONEY)}) and a ${L.homestead}×${L.homestead} homestead`);
ok(/at least 8×8/.test(ada.buy(150, 150, 4, 4)) && parcelsOf('ada').length === 0, 'a 4×4 first plot is refused: a first plot must be at least 8×8');
const wildPrice = land.priceOf({ x: 150, y: 150, w: 16, h: 16 });
ok(/homestead/.test(ada.buy(150, 150, 16, 16)) && parcelsOf('ada').length === 1 && ada.p().money === L.startMoney && ada.p().homestead === undefined,
  `the first 16×16 is free (worth ${usd(wildPrice)}): Ada still has ${usd(ada.p().money)} and no homestead left`);
ok(parcelsOf('ada')[0].name === "Ada's homestead", 'the parcel is called her homestead');

// ---- price by value ----------------------------------------------------------------------------------------
const perTile = wildPrice / 256;
ok(perTile >= 1 && perTile <= 2, `wilderness costs ${usd(perTile)} a tile`);
// the dearest 8×8 in and round the town against the wild
let best = 0, bestAt = [0, 0];
for (let y = -40; y <= 40; y += 4) for (let x = -40; x <= 40; x += 4) { const p = land.priceOf({ x, y, w: 8, h: 8 }); if (p > best) { best = p; bestAt = [x, y]; } }
const wild8 = land.priceOf({ x: 240, y: 240, w: 8, h: 8 });
ok(best > 2.5 * wild8, `land in the town is dearer: the best 8×8 at (${bestAt}) is ${usd(best)} against ${usd(wild8)} in the wild (${(best / wild8).toFixed(1)}×)`);

// ---- the client works out the same price from the bytes it was sent ----------------------------------------
const subs: [number, number][] = [];
for (let cy = -3; cy <= 2; cy++) for (let cx = -3; cx <= 2; cx++) subs.push([cx, cy]);
ada.send({ t: 'sub', chunks: subs });
const clientPrice = (r: { x: number; y: number; w: number; h: number }) => landPriceOf(r, (cx, cy) => ada.prices.get(chunkKey(cx, cy)));
let same = 0, tried = 0, sentChunks = ada.prices.size;
for (let y = -60; y <= 40; y += 7) for (let x = -60; x <= 40; x += 9) { const r = { x, y, w: 1 + (x & 15) + 8, h: 1 + (y & 7) + 9 }; tried++; if (clientPrice(r) === land.priceOf(r)) same++; }
ok(same === tried && sentChunks > 0, `client and server agree on ${same} of ${tried} rectangles (${sentChunks} chunks of price bytes sent; the rest are the wild price)`);
// an hour later the field moves on; the client hears about it
step(2 * TICKS_PER_HOUR);
same = 0;
for (let y = -60; y <= 40; y += 7) for (let x = -60; x <= 40; x += 9) { const r = { x, y, w: 8, h: 8 }; if (clientPrice(r) === land.priceOf(r)) same++; }
ok(same === tried, 'and still agree two hours later');
ok(land.priceMsg(60, 60) === '' && Math.abs(priceOfByte(wildPriceByte()) - L.base) < 0.01 * L.base, 'a chunk with nothing near is the wild price ("" on the wire)');

// ---- outposts --------------------------------------------------------------------------------------------
ok(/outpost.*at least 8×8/.test(ada.buy(200, 120, 6, 6)), 'a 6×6 far from her land is refused: an outpost must be at least 8×8');
const before = ada.p().money, outpost = land.priceOf({ x: 200, y: 120, w: 8, h: 8 });
ok(/Bought 8×8/.test(ada.buy(200, 120, 8, 8, outpost)) && Math.abs(before - outpost - ada.p().money) < 1e-6, `an 8×8 outpost far from her land is allowed, for ${usd(outpost)} (the client's quote)`);
ok(/Bought 2×3/.test(ada.buy(208, 120, 2, 3)), 'a 2×3 strip beside the outpost is fine: it touches her land');
ok(/price of that land has just changed/.test(ada.buy(210, 120, 8, 8, 1)), 'a purchase quoted below the price is refused (the client showed a stale price)');
// walling in is still refused
const bob = client('Bob');
bob.buy(200, 200, 8, 8);
ok(parcelsOf('bob').length === 1, 'Bob takes his homestead, 8×8');
ok(/Bought/.test(ada.buy(192, 199, 8, 9)), 'Ada buys an 8×9 outpost on his west side');
ada.buy(200, 199, 9, 1); ada.buy(208, 200, 1, 8);
ok(parcelsOf('ada').length === 6, 'and strips along his north and east sides');
const ringMsg = ada.buy(200, 208, 9, 1);
ok(/cut off Bob's parcel/.test(ringMsg) && parcelsOf('ada').length === 6, 'the strip that closes the ring is refused: it would cut off Bob\'s parcel');

// ---- the empty-land tax ----------------------------------------------------------------------------------
const home = parcelsOf('ada').find((q) => q.name === "Ada's homestead")!;
const expect = land.taxOf(home);
const allTax = parcelsOf('ada').reduce((a, q) => a + land.taxOf(q), 0);
ok(Math.abs(expect - 256 * land.tilePrice(home.x, home.y) * L.emptyTax) < 0.5, `an empty homestead pays ${usd(expect)} a day (${Math.round(L.emptyTax * 100)}% of its price)`);
midnight();
const paid = -(ledger('ada').landtax ?? 0);
ok(Math.abs(paid - Math.round(allTax * 100) / 100) < 0.6, `at midnight Ada paid ${usd(paid)} on the ledger's "Empty-land tax" line (expected about ${usd(allTax)})`);
// roads and zoning on it: less tax
for (let x = home.x; x < home.x + 16; x++) world.setTile(x, home.y + 4, packTile(Terrain.Grass, true, 0, 0));
for (let y = home.y; y < home.y + 4; y++) for (let x = home.x; x < home.x + 16; x++) world.setTile(x, y, packTile(Terrain.Grass, false, Zone.Residential, 0));
const after = land.taxOf(home);
ok(Math.abs(after - expect * (256 - 80) / 256) < 0.05, `with a road and a zoned row on it the homestead pays ${usd(after)}: built-on tiles pay nothing`);
// away: paused
ada.leave();
const seen = ada.p().seen!;
ok(seen > 0 && seen <= world.tick, 'Ada was seen while she was connected (Player.seen)');
ada.p().seen = world.tick - 3 * TICKS_PER_DAY - 10;
const m0 = ada.p().money;
land.midnight();
ok(ada.p().money === m0 && land.last.paused >= 1, `three days away: no tax (${usd(ada.p().money - m0)})`);
ada.p().seen = world.tick - 2 * TICKS_PER_DAY;
land.midnight();
ok(ada.p().money < m0, `two days away: taxed (${usd(ada.p().money - m0)})`);

// ---- abandoned land ----------------------------------------------------------------------------------
// Ada's land: the homestead has a road and zoned lots (unbuilt), the outposts are empty. Put a house on the west outpost.
const westOutpost = parcelsOf('ada').find((q) => q.x === 192 && q.y === 199)!;
world.setTile(westOutpost.x + 2, westOutpost.y + 2, packTile(Terrain.Grass, false, Zone.Residential, 1));
const nAda = parcelsOf('ada').length, landWorth = parcelsOf('ada').filter((q) => q !== westOutpost).reduce((a, q) => a + land.priceOf(q), 0);
ada.p().seen = world.tick - 29 * TICKS_PER_DAY;
land.midnight();
ok(parcelsOf('ada').length === nAda, 'away 29 days: nothing is taken');
ada.p().seen = world.tick - 30 * TICKS_PER_DAY - 1;
const m1 = ada.p().money, roadAt = [home.x + 3, home.y + 4];
land.midnight();
ok(parcelsOf('ada').length === 1 && parcelsOf('ada')[0] === westOutpost, `away 30 days: her ${nAda - 1} unbuilt parcels go back to the market; the one with a house stays`);
ok(Math.abs(ada.p().money - m1 - landWorth) < 1, `and she is paid their current price: ${usd(ada.p().money - m1)} (expected ${usd(landWorth)}), with no tax (paused)`);
ok(world.parcelIdAt(home.x, home.y) === 0 && isRoad(world.getTile(roadAt[0], roadAt[1])) && world.publicRoads.get(tkey(roadAt[0], roadAt[1]))?.ad === 1,
  'the homestead is unclaimed again; its road stays as public road nobody pays for (adopted)');
ok(world.getTile(home.x + 1, home.y + 1) === packTile(Terrain.Grass, false, 0, 0), 'and its zoning is cleared');
ada.p().seen = world.tick - L.abandonBuiltDays * TICKS_PER_DAY - 1;
const m2 = ada.p().money, westWorth = land.priceOf(westOutpost);
land.midnight();
ok(westOutpost.owner === 'sys' && parcelsOf('ada').length === 0 && Math.abs(ada.p().money - m2 - westWorth) < 1,
  `away ${L.abandonBuiltDays} days: built land goes to the Commons, Ada paid its land price (${usd(ada.p().money - m2)})`);
ok(world.players.has('sys') && land.last.toCommons === 1, 'the Commons is never taxed or abandoned (it keeps the parcel)');

// ---- the recovery plan's sell-back is at the market price --------------------------------------------------
const cy = client('Cy');
cy.buy(120, 230, 16, 16);
cy.buy(136, 230, 8, 8);
const cyLand = parcelsOf('cy').reduce((a, q) => a + land.priceOf(q), 0);
const plan = game.finance.plan(cy.p());
ok(plan.sellParcels === 2 && Math.abs(plan.sellCash - Math.round(cyLand * ECONOMY_TUNING.landBuyback)) <= 1,
  `the recovery plan sells empty land back at ${Math.round(ECONOMY_TUNING.landBuyback * 100)}% of the market price (${usd(plan.sellCash)}), not the flat $10 a tile`);

// ---- elsewhere the classic rules -----------------------------------------------------------------------------
{
  const fw = new World(777);
  seedFrontier(fw);
  let acc: ((c: Conn) => void) | null = null;
  const g = createGame(fw, { onConnection: (fn) => { acc = fn; } }, { devTools: false, sandbox: false, market: true });
  join(acc!, 'Fay');
  ok(!g.land.market && fw.players.get('fay')?.money === FRONTIER_MONEY && fw.players.get('fay')?.homestead === undefined, `a frontier keeps its own start (${usd(FRONTIER_MONEY)}, the charter) even with \`market\``);
  const cw = new World(5);
  seedCommons(cw);
  const g2 = createGame(cw, { onConnection: (fn) => { acc = fn; } }, { devTools: false, sandbox: true, market: true });
  join(acc!, 'Sam');
  ok(!g2.land.market, 'a sandbox keeps the classic rules');
  const cw2 = new World(6);
  seedCommons(cw2);
  createGame(cw2, { onConnection: (fn) => { acc = fn; } }, { devTools: false, sandbox: false });
  join(acc!, 'Una');
  ok(cw2.players.get('una')?.money === START_MONEY && cw2.players.get('una')?.homestead === undefined, `without \`market\` a new player has ${usd(START_MONEY)} and no homestead (local mode, LAND=classic)`);
}


console.log(failed ? `\n${failed} check(s) FAILED` : '\nall land checks passed');
process.exit(failed ? 1 : 0);
