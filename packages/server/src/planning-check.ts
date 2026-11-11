/**
 * `npm run planning:check` (docs/multiplayer-land.md section 6, phase M5): planning notices and the residents' vote.
 *
 * - An open tip within the boundary limits but near a rival's homes goes to planning instead of being placed: the money
 *   is held, the site reserved, the rival told, the news carries it; the residents vote it down; everything is refunded.
 * - The roll is frozen at filing: a home built during the notice does not vote.
 * - Refused: a cooling-off near the site, then an unchanged design is still refused; a changed one (cleaner) is not.
 * - A composting site at the tip's site needs no vote and is placed at once.
 * - Conditions (an enclosure) lower the impact; an approved plan's conditions are fitted and cannot be taken off.
 * - A community offer flips a close vote and is paid out to the affected owners.
 * - A nuisance build reaching only the builder's own land needs no vote.
 * - The vote is deterministic (the same scene twice gives the same tally and leans).
 * - A save round trip keeps open applications, their rolls, the refused designs and the conditions.
 * - Road closure notices (a protected public road, M3): an objection stops it; silence lets it through.
 *
 *   npx tsx packages/server/src/planning-check.ts
 */
import {
  Terrain, Zone, KIND_ID, CIVIC_COST, PLANNING, REFUSE_ADDONS, RefuseAddon, VALUE_KINDS, BOUNDARY_LIMITS, CitizenState,
  packTile, planImpact, seededValues, isRoad, isBuildable, DEFAULT_TAX, TICKS_PER_DAY,
  type ServerMsg, type ClientMsg, type PlanAppDTO,
} from '@msimcity/shared';
import { World, emptyStats, lifeDefaults, citizenLater, type Citizen } from './world';
import { createGame, type Game } from './game';
import { snapshotOf, worldFromSnapshot } from './snapshot';
import { seedFrontier } from './seed';
import type { Conn } from './transport';
import type { PlanApp } from './sim/planning';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const TIP = KIND_ID['open-tip'], LANDFILL = KIND_ID['lined-landfill'], RECYCLING = KIND_ID['recycling-centre'], COMPOST = KIND_ID['compost-digester'];
const SEED = 4242;
const money = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;

type Cl = ReturnType<typeof clientOf>;
function clientOf(accept: (c: Conn) => void, name: string) {
  const toasts: string[] = [], msgs: ServerMsg[] = [];
  let onMsg: ((d: string) => void) | null = null;
  accept({ open: true, send: (d) => { const m = JSON.parse(d) as ServerMsg; msgs.push(m); if (m.t === 'toast') toasts.push(m.msg); }, close() {}, onMessage: (fn) => { onMsg = fn; }, onClose() {} });
  const send = (m: ClientMsg) => onMsg!(JSON.stringify(m));
  send({ t: 'hello', name });
  const last = () => { const t = toasts.at(-1) ?? ''; toasts.length = 0; return t; };
  return { send, toasts, msgs, last, id: name.toLowerCase() };
}

/**
 * The scene: Ada's land (60 by 40) with a street along y = 10, Bob's to the east (32 by 40) with 16 homes near his
 * western border, Cy's south of Bob's with a few more; an outpost of Ada's far away (100 by 100) with its own street.
 * Planning is forced on (`planning: true`), as on a shared world.
 */
function scene() {
  const world = new World(SEED);
  for (let y = -10; y < 110; y++) for (let x = -10; x < 310; x++) world.setTile(x, y, packTile(Terrain.Grass, false, 0, 0));
  let accept: ((c: Conn) => void) | null = null;
  const game = createGame(world, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false, planning: true });
  const ada = clientOf(accept!, 'Ada'), bob = clientOf(accept!, 'Bob'), cy = clientOf(accept!, 'Cy');
  for (const c of [ada, bob, cy]) world.players.get(c.id)!.money = 200_000;
  const parcel = (owner: string, x: number, y: number, w: number, h: number) => {
    const p = { id: world.nextId++, owner, name: owner, x, y, w, h, taxRate: DEFAULT_TAX, stats: emptyStats() };
    world.parcels.set(p.id, p);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) world.setParcelId(xx, yy, p.id);
  };
  parcel('ada', 0, 0, 60, 40);
  parcel('bob', 60, 0, 32, 30);
  parcel('cy', 60, 30, 32, 16);
  parcel('ada', 200, 0, 100, 100);
  ada.send({ t: 'build', tool: 'road', tiles: Array.from({ length: 60 }, (_, i) => [i, 10] as [number, number]), dev: true, cls: 0 });
  ada.send({ t: 'build', tool: 'road', tiles: Array.from({ length: 100 }, (_, i) => [200 + i, 50] as [number, number]), dev: true, cls: 0 });
  let nextCit = 500_000;
  const home = (x: number, y: number, people: number, jobless = 0) => {
    world.setTile(x, y, packTile(Terrain.Grass, false, Zone.Residential, 1));
    const ids: number[] = [];
    for (let i = 0; i < people; i++) {
      const id = nextCit++;
      const c = { id, ...lifeDefaults(id, world.tick, 30 + (id % 30), 80), ...citizenLater(), hx: x, hy: y, x: x + 0.5, y: y + 0.5, job: i >= jobless, wx: 0, wy: 0, kind: 0, state: CitizenState.Home, money: 500, path: [], pi: 0 } as unknown as Citizen;
      c.vals = seededValues(id); c.hh = ids[0] ?? id;
      world.citizens.set(id, c);
      ids.push(id);
    }
    for (const id of ids) world.citizens.get(id)!.friends = ids.filter((f) => f !== id);
    return ids;
  };
  for (let y = 6; y < 14; y += 2) for (let x = 61; x < 68; x += 2) home(x, y, 2, x === 61 && y === 6 ? 1 : 0);
  for (let x = 61; x < 70; x += 3) home(x, 32, 2);
  for (let i = 0; i < 3; i++) game.sim.value.refresh(); // the neighbourhood as it is (green, quiet, access): what the plan would change
  return { world, game, ada, bob, cy, home, parcel };
}
type Scene = ReturnType<typeof scene>;

const place = (s: Scene, who: Cl, tool: string, x: number, y: number, plan?: { conditions?: string[]; offer?: number }) => {
  who.toasts.length = 0;
  who.send({ t: 'build', tool: tool as never, tiles: [[x, y]], dev: true, ...(plan ? { plan } : {}) });
  return who.last();
};
const openApp = (g: Game, x: number, y: number) => [...g.planning.apps.values()].find((a) => a.status === 'open' && a.x === x && a.y === y);
const decideNow = (s: Scene, a: PlanApp) => { s.world.tick = Math.max(s.world.tick, a.ends); s.game.planning.tick(); };
const cash = (s: Scene, id: string) => s.world.players.get(id)!.money;
const lastPlanning = (c: Cl) => { const m = [...c.msgs].reverse().find((x) => x.t === 'planning') as Extract<ServerMsg, { t: 'planning' }> | undefined; return m?.apps ?? []; };
const flushPlanning = (s: Scene) => { const pl = s.game.planning; const out = pl.notices.splice(0); if (pl.changed) { pl.changed = false; const m = JSON.stringify({ t: 'planning', apps: pl.dtos() }); for (const c of [s.ada, s.bob, s.cy]) c.msgs.push(JSON.parse(m)); } return out; };

// ---- 1. a tip near a rival goes to planning and is voted down -------------------------------------------------------
const S = scene(), { world, game, ada, bob, cy } = S, pl = game.planning;
const imp0 = planImpact(TIP, 0, 24, 9, SEED, 'ada', (x, y) => world.parcelAt(x, y)?.owner);
console.log(`a tip at (24, 9), 36 tiles from Bob's land: ${imp0.worst.map((v, k) => (VALUE_KINDS[k].nuisance && v > 0.01 ? `${VALUE_KINDS[k].name} ${Math.round(100 * v)}% (limit ${Math.round(100 * BOUNDARY_LIMITS[k])}%)` : '')).filter(Boolean).join(', ')}`);
ok(!imp0.over.length && imp0.needs.length, 'within the boundary limits, over the planning threshold');
const ada0 = cash(S, 'ada');
let why = place(S, ada, 'opentip', 24, 9);
const tipApp = openApp(game, 24, 9)!;
ok(tipApp && !world.sites.get('24,9') && !world.buildings.get('24,9'), `the tip is filed, not placed${why ? ` (${why})` : ''}`);
ok(Math.abs(cash(S, 'ada') - (ada0 - CIVIC_COST[TIP])) < 1e-6, `its cost (${money(CIVIC_COST[TIP])}) is taken and held`);
ok(tipApp.affected.includes('bob') && tipApp.roll.length === 38, `${tipApp.affected.join(' and ')}'s land is affected; ${tipApp.roll.length} residents (all of Bob's and Cy's) are on the frozen roll`);
let notes = flushPlanning(S);
ok(notes.some((n) => n.owner === 'bob' && /Planning notice: Ada plans an open tip/.test(n.msg)) && notes.some((n) => n.owner === 'ada' && /goes to planning/.test(n.msg)), 'Bob gets a toast; Ada is told it went to planning');
ok(game.news.all().some((st) => st.k === 'planning' && /tip/.test(st.h)), `the local news carries it: "${game.news.all().find((st) => st.k === 'planning')?.h}"`);
ok(lastPlanning(bob).some((a: PlanAppDTO) => a.id === tipApp.id && a.status === 'open' && a.fw === 2 && a.impact.length > 0), 'the planning list (and the site marker) reaches the clients with its impact by kind');
why = place(S, ada, 'opentip', 24, 9);
ok(/planning application is open/.test(why), `the site is kept clear during the notice (${why})`);
{ // the land market (M7) will not sell or lease land with an open application on it
  const site = world.parcelAt(24, 9)!;
  ok(/planning application open/.test(game.deals.canTransfer?.(site) ?? ''), `land under an open application cannot be sold or leased (${game.deals.canTransfer?.(site)})`);
}
// a home built during the notice does not vote
const late = S.home(60, 16, 3);
ok(!tipApp.roll.some((id) => late.includes(id)), 'a home built on Bob\'s land during the notice is not on the roll');
const v1 = pl.vote(tipApp);
ok(v1.yes + v1.no <= tipApp.roll.length && [...v1.leans.keys()].every((id) => !late.includes(id)), `the vote counts only the frozen roll (${v1.yes + v1.no} voting of ${tipApp.roll.length})`);
decideNow(S, tipApp);
notes = flushPlanning(S);
console.log(`  ${tipApp.result}`);
ok(tipApp.status === 'refused' && (tipApp.no ?? 0) > (tipApp.yes ?? 0), `the residents vote it down (${tipApp.yes} for, ${tipApp.no} against)`);
ok(Math.abs(cash(S, 'ada') - ada0) < 1e-6 && !world.sites.get('24,9'), 'refused: Ada is refunded in full and nothing is built');
ok(notes.some((n) => n.owner === 'bob' && /refused/i.test(n.msg)) && game.news.all().some((st) => st.k === 'planning' && /(throw out|refused)/.test(st.h)), 'Bob is told, and the news reports the result');
// the cooling-off and the changed-design rule
why = place(S, ada, 'opentip', 24, 9);
ok(/refused here .* file again near this site in/.test(why) && !openApp(game, 24, 9), `refiling at once is refused: the cooling-off (${why})`);
world.tick += PLANNING.coolTicks;
why = place(S, ada, 'opentip', 24, 9);
ok(/changed design/.test(why) && !openApp(game, 24, 9), `after the cooling-off the unchanged design is still refused (${why.slice(0, 80)}...)`);
why = place(S, ada, 'opentip', 24, 9, { conditions: ['screening'] });
const tip2 = openApp(game, 24, 9);
ok(/changed design/.test(why) && !tip2, 'screening alone barely changes the tip\'s smell: still refused as unchanged');
const cleaner = planImpact(LANDFILL, RefuseAddon.Enclosure, 24, 9, SEED, 'ada', (x, y) => world.parcelAt(x, y)?.owner);
ok(pl.refileRefusal('ada', 24, 9, cleaner.score) === null, `a cleaner grade with an enclosure is a changed design (impact score ${cleaner.score.toFixed(2)} against ${imp0.score.toFixed(2)}): it may be filed`);

// ---- 2. compost at the same site needs no vote ---------------------------------------------------------------------
why = place(S, ada, 'compost', 24, 9);
ok(world.sites.get('24,9')?.kind === COMPOST && !openApp(game, 24, 9), `a composting site at the tip's site is placed at once: nothing reaches Bob over the threshold${why ? ` (${why})` : ''}`);

// ---- 3. conditions lower the impact and are enforced after approval -----------------------------------------------
const bare = planImpact(LANDFILL, 0, 36, 11, SEED, 'ada', (x, y) => world.parcelAt(x, y)?.owner), enc = planImpact(LANDFILL, RefuseAddon.Enclosure, 36, 11, SEED, 'ada', (x, y) => world.parcelAt(x, y)?.owner);
ok(bare.over.length && !enc.over.length && enc.score < bare.score, `a lined landfill at (36, 11) is over a limit without an enclosure (score ${bare.score.toFixed(2)}) and within it with one (${enc.score.toFixed(2)})`);
why = place(S, ada, 'landfill', 36, 11);
ok(/limit at a boundary/.test(why) && !openApp(game, 36, 11), 'filed bare it is refused outright (over the limit)');
const ada1 = cash(S, 'ada');
place(S, ada, 'landfill', 36, 11, { conditions: ['enclosure'] });
const lf2 = openApp(game, 36, 11)!;
ok(lf2 && lf2.mask === RefuseAddon.Enclosure && Math.abs(cash(S, 'ada') - (ada1 - CIVIC_COST[LANDFILL] - REFUSE_ADDONS[0].cost)) < 1e-6, `with the enclosure as a condition it goes to planning; the enclosure's ${money(REFUSE_ADDONS[0].cost)} is held with the building`);
const before = pl.impactOf(lf2)!.score;
ada.send({ t: 'planningAct', id: lf2.id, act: 'amend', conditions: ['screening'] });
ok(lf2.mask === (RefuseAddon.Enclosure | RefuseAddon.Screening) && pl.impactOf(lf2)!.score < before, `amended with screening: the true impact falls (${before.toFixed(2)} -> ${pl.impactOf(lf2)!.score.toFixed(2)}); the roll stays frozen (${lf2.roll.length})`);
bob.send({ t: 'planningAct', id: lf2.id, act: 'amend', offer: 5000 });
ok(/Not your application/.test(bob.last()), 'Bob may not amend Ada\'s application');
let flip = pl.vote(lf2);
if (flip.yes <= flip.no) { // raise the offer until the vote passes, so the conditions can be seen enforced
  for (const o of [500, 1000, 2000, 4000, 8000, 16000]) { lf2.offer = o; if (pl.vote(lf2).yes > pl.vote(lf2).no) break; }
  const o = lf2.offer; lf2.offer = 0;
  ada.send({ t: 'planningAct', id: lf2.id, act: 'amend', offer: o });
}
flip = pl.vote(lf2);
decideNow(S, lf2);
ok(lf2.status === 'approved', `approved (${lf2.result})`);
ok(world.sites.get('36,11')?.kind === LANDFILL && world.refuseAddons.get('36,11') === (RefuseAddon.Enclosure | RefuseAddon.Screening), 'the landfill is placed with its conditions fitted as add-ons');
world.completeSite(world.sites.get('36,11')!);
ada.toasts.length = 0;
ada.send({ t: 'refuseAddon', x: 36, y: 11, addon: 'screening', on: false });
ok(/condition of the planning approval/.test(ada.last()) && world.refuseAddons.get('36,11') === (RefuseAddon.Enclosure | RefuseAddon.Screening), 'a condition cannot be taken off afterwards');

// ---- 4. an offer flips a close vote ------------------------------------------------------------------------------
flushPlanning(S);
const bob0 = cash(S, 'bob'), cy0 = cash(S, 'cy');
place(S, ada, 'recycling', 50, 11);
const rc = openApp(game, 50, 11)!;
ok(rc && rc.bk === RECYCLING, `a recycling centre at (50, 11), 10 tiles from Bob's land, goes to planning (roll ${rc?.roll.length})`);
const v0 = pl.vote(rc);
let need = 0;
for (let o = 250; o <= 60000 && !need; o += 250) { rc.offer = o; const v = pl.vote(rc); if (v.yes > v.no) need = o; }
rc.offer = 0;
console.log(`  without an offer: ${v0.yes} for, ${v0.no} against; the smallest offer that carries it: ${money(need)}`);
ok(v0.yes <= v0.no && need > 0, 'without an offer the vote fails; an offer turns it');
const ada2 = cash(S, 'ada');
ada.send({ t: 'planningAct', id: rc.id, act: 'amend', offer: need });
ok(rc.offer === need && Math.abs(cash(S, 'ada') - (ada2 - need)) < 1e-6 && rc.roll.length === pl.apps.get(rc.id)!.roll.length, `Ada raises her offer to ${money(need)} during the notice (held)`);
decideNow(S, rc);
ok(rc.status === 'approved' && world.sites.get('50,11')?.kind === RECYCLING, `the vote now passes (${rc.result})`);
const paid = cash(S, 'bob') - bob0 + cash(S, 'cy') - cy0;
ok(Math.abs(paid - need) < 1e-6 && cash(S, 'bob') > bob0, `the offer is paid out to the affected owners (Bob ${money(cash(S, 'bob') - bob0)}, Cy ${money(cash(S, 'cy') - cy0)})`);
ok(world.players.get('bob')!.ledger?.today.planning !== undefined, 'as the ledger\'s "Planning offers" line');

// ---- 5. own land only: no vote -------------------------------------------------------------------------------------
why = place(S, ada, 'opentip', 250, 49);
ok(world.sites.get('250,49')?.kind === TIP && !openApp(game, 250, 49), `a tip in the middle of Ada's outpost (only her land reached) is placed at once, no vote${why ? ` (${why})` : ''}`);

// ---- 6. a save round trip ------------------------------------------------------------------------------------------
place(S, ada, 'landfill', 44, 9, { conditions: ['enclosure'], offer: 300 }); // another notice, left open
const open6 = openApp(game, 44, 9);
ok(open6 && open6.offer === 300 && open6.mask === RefuseAddon.Enclosure, 'a lined landfill filed with a condition and an offer at once');
ada.send({ t: 'planningAct', id: open6!.id, act: 'withdraw' });
ok(open6!.status === 'withdrawn' && /withdrawn/.test(ada.last()), 'withdrawn by Ada: refunded, no cooling-off');
place(S, ada, 'landfill', 44, 9, { conditions: ['enclosure'], offer: 300 });
const open7 = openApp(game, 44, 9);
const snap = JSON.parse(JSON.stringify(snapshotOf(world)));
ok(open7 && snap.planning && Array.isArray(snap.planning.apps), 'the snapshot carries the planning field');
const w2 = worldFromSnapshot(snap)!;
const g2 = createGame(w2, { onConnection: () => {} }, { devTools: true, sandbox: false, planning: true });
const back = [...g2.planning.apps.values()].find((a) => a.id === open7!.id);
ok(back && back.status === 'open' && back.roll.join() === open7!.roll.join() && back.ends === open7!.ends && back.offer === 300, 'an open application loads back with its frozen roll and end');
ok(g2.planning.lockedAt(36, 11) === (RefuseAddon.Enclosure | RefuseAddon.Screening), 'the approved plan\'s conditions load back');
ok(/changed design|file again/.test(g2.planning.refileRefusal('ada', 24, 9, imp0.score) ?? ''), 'and so does the refused design');
const plain = JSON.parse(JSON.stringify(snapshotOf(world)));
delete plain.planning;
const w3 = worldFromSnapshot(plain)!;
const g3 = createGame(w3, { onConnection: () => {} }, { devTools: true, sandbox: false, planning: true });
ok(g3.planning.apps.size === 0 && !snapshotOf(w3).planning, 'a save from before M5 loads with no applications (and saves without the field)');

// ---- 7. determinism -------------------------------------------------------------------------------------------------
{
  const run = () => {
    const s = scene();
    place(s, s.ada, 'opentip', 24, 9);
    const a = openApp(s.game, 24, 9)!;
    const v = s.game.planning.vote(a);
    return JSON.stringify({ yes: v.yes, no: v.no, leans: [...v.leans].map(([k, l]) => [k, Math.round(l * 1e6)]) });
  };
  const r1 = run(), r2 = run();
  ok(r1 === r2, `the same scene votes the same way, voter by voter (${JSON.parse(r1).yes} for, ${JSON.parse(r1).no} against)`);
}

// ---- 8. road closure notices ---------------------------------------------------------------------------------------
{
  const w = new World(777);
  seedFrontier(w);
  for (let y = -24; y <= 14; y++) for (let x = -33; x <= -21; x++) if (y !== 0 && !isBuildable(w.getTile(x, y))) w.setTile(x, y, packTile(Terrain.Grass, false, 0, 0));
  let acc: ((c: Conn) => void) | null = null;
  const g = createGame(w, { onConnection: (fn) => { acc = fn; } }, { devTools: true, sandbox: false });
  const a = clientOf(acc!, 'Ada'), b = clientOf(acc!, 'Bob');
  for (let i = 0; i < 40; i++) g.step();
  w.charter = undefined;
  b.send({ t: 'buy', x: -32, y: -22, w: 8, h: 8 });
  const line: [number, number][] = [];
  for (let y = -14; y <= -1; y++) line.push([-28, y]);
  b.send({ t: 'build', tool: 'road', tiles: line, dev: true, cls: 0 });
  ok(line.every(([x, y]) => isRoad(w.getTile(x, y))), 'Bob lays the only road from the gate to his land');
  a.toasts.length = 0; a.msgs.length = 0;
  a.send({ t: 'build', tool: 'bulldoze', tiles: [[-28, -5], [-28, -6]] });
  const offer = a.msgs.find((m) => m.t === 'closureOffer') as Extract<ServerMsg, { t: 'closureOffer' }> | undefined;
  ok(/closure notice/.test(a.last()) && offer?.tiles.length === 2 && isRoad(w.getTile(-28, -5)), 'Ada may not bulldoze it (protected), and is offered a closure notice for the two tiles');
  a.send({ t: 'closureNotice', tiles: offer!.tiles });
  const n1 = [...g.planning.apps.values()].find((x) => x.kind === 'closure' && x.status === 'open')!;
  ok(n1 && n1.affected.join() === 'bob', 'Ada gives notice; Bob is the mayor who depends on the road');
  for (let i = 0; i < 2; i++) g.step();
  ok(b.toasts.some((t) => /gives notice to close/.test(t)), 'Bob gets a toast');
  a.send({ t: 'planningAct', id: n1.id, act: 'object' });
  ok(/Only a mayor/.test(a.last()), 'Ada may not object to her own notice');
  b.send({ t: 'planningAct', id: n1.id, act: 'object' });
  ok(n1.status === 'refused' && isRoad(w.getTile(-28, -5)) && /objected/.test(n1.result ?? ''), `Bob objects: the closure is stopped and the road stays (${n1.result})`);
  a.send({ t: 'closureNotice', tiles: offer!.tiles });
  ok(/objected to .* give notice again in/.test(a.last()) && ![...g.planning.apps.values()].some((x) => x.kind === 'closure' && x.status === 'open'), 'Ada may not give notice on the same road again at once (it cools off)');
  const cooled = w.tick + PLANNING.coolTicks;
  while (w.tick < cooled) g.step();
  a.send({ t: 'closureNotice', tiles: offer!.tiles });
  const n2 = [...g.planning.apps.values()].find((x) => x.kind === 'closure' && x.status === 'open')!;
  const end = n2.ends;
  while (w.tick < end + 1) g.step();
  ok(n2.status === 'approved' && !isRoad(w.getTile(-28, -5)) && !isRoad(w.getTile(-28, -6)), `nobody objects within the notice (${PLANNING.noticeTicks / TICKS_PER_DAY} game day): the road is taken up (${n2.result})`);
  ok(b.toasts.some((t) => /taken up/.test(t)), 'and Bob is told');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall planning checks passed');
process.exit(failed ? 1 : 0);
