/**
 * Death and remembrance probe (docs/remembrance.md, server/src/sim/death.ts): the card's acceptance on a real town.
 *
 *   npx tsx packages/server/src/loadtest/death.ts [--seed 1] [--quiet]
 *
 * A 1×1 Commons (seedCity, built 3) filled for a day, with a funeral director and a churchyard side by side in it. Then:
 * 1. a death archives: the record (name, dates, cause, family, where), the body left at home, the citizen gone;
 * 2. the hearse collects the body (a FleetKind.Hearse unit on the road, the body at the funeral director's), the service
 *    is booked two to four days on at the churchyard, the mourners go (a funeral errand), close family take the day off,
 *    the burial fills a plot (the graves message carries it), the partner's grief ends soon after;
 * 3. the estate: the funeral director's and the churchyard's fees go to their owner's ledger ('funeral', 'burial'), the
 *    rest to the partner;
 * 4. plots fill: with the churchyard full, the next dead wait at the hospital mortuary with the No burial space badge;
 *    a crematorium placed in reach takes them (memorial plaques), the badge clears;
 * 5. fires and explosions: hand-lit home fires at night with every fire building mothballed kill some of the people at
 *    home; the same fires with the fire post staffed kill far fewer; gas explosions kill; each incident is one news story
 *    naming its dead; accidents at works happen at their rate (raised for the test);
 * 6. the first-hour rail and the warning fire: a player's citizens do not die in their first hour (deaths spared), do
 *    after it; the warning fire harms nobody;
 * 7. determinism: the same deaths and fires on a second run give the same archive and graves;
 * 8. saves: a save with the archive loads with it; a save from before death (no field) loads with an empty archive.
 * Prints pass/fail counts; exits 1 on any failure.
 */
import {
  TICKS_PER_DAY, TICKS_PER_HOUR, Zone, Issue, Cause, DEATH, FleetKind, CitizenState as S, LifeStage, KIND_ID, GRAVE_STRIDE, GRAVE_PLAQUE,
  packTile, terrainOf, subFor, tileKey, placedFromDoor, workOf, nameFor, plotCapacity, FUNERAL_KIND, CHURCHYARD_KIND, CREMATORIUM_KIND, capacityOf,
} from '@msimcity/shared';
import { World, type Building } from '../world';
import { seedCity } from './cities';
import { createGame, type Game } from '../game';
import { snapshotOf, worldFromSnapshot } from '../snapshot';
import { ERRAND_FUNERAL } from '../sim/death';

const argv = process.argv.slice(2);
const get = (n: string, d: number) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const seed = get('seed', 1);
const quiet = argv.includes('--quiet');
const DAY = TICKS_PER_DAY, TPH = TICKS_PER_HOUR;
const log = (s: string) => { if (!quiet) console.log(s); };

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let checks = 0, fails = 0;
const ok = (cond: boolean, what: string) => { checks++; if (!cond) fails++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`); };

interface Town { w: World; g: Game; x0: number; y0: number; fd: Building; rest: Building }
/** Clear a footprint and put a built structure there (the probes' way: adverts.ts, ab.ts). */
function place(w: World, kind: number, doorX: number, doorY: number, r = 0) {
  const p = placedFromDoor(kind, doorX, doorY, r);
  for (let y = p.ay; y < p.ay + p.h; y++) for (let x = p.ax; x < p.ax + p.w; x++) w.setTile(x, y, packTile(terrainOf(w.getTile(x, y)), false, 0, 0));
  w.placeStructure(p, { work: workOf(kind, 1), priority: 1, built: true });
  return w.buildings.get(tileKey(p.doorX, p.doorY))!;
}
/**
 * A 1×1 Commons filled for a day; then a funeral director in place of the lot at local (1, 4), a churchyard at (2, 4)
 * (door, 2×2 behind it) and a few hours for the funeral director to hire. `owner` gives the district to a player
 * (non-sandbox: the first-hour rail applies).
 */
function town(rnd = seed, owner = 'sys', sandbox = true): Town {
  Math.random = mulberry32(rnd * 7919);
  const w = new World(rnd);
  const layout = seedCity(w, { districts: 1, built: 3, seedOwner: owner });
  const d = layout.districts[0], x0 = d.x, y0 = d.y;
  const g = createGame(w, { onConnection() {} }, { devTools: false, sandbox });
  g.fires.enabled = false;
  for (let i = 0; i < 1.05 * DAY; i++) g.step();
  // the block's front row cleared of any merged building (a res-midrise may straddle it)
  for (let y = y0 + 3; y <= y0 + 4; y++) for (let x = x0 + 1; x <= x0 + 4; x++) { const s = w.structureAt(x, y); if (s) w.removeStructure(s); }
  const fx = x0 + 1, fy = y0 + 4; // beside the churchyard, so its hearse's runs are short in the town's busy streets
  w.setTile(fx, fy, packTile(terrainOf(w.getTile(fx, fy)), false, Zone.Office, 1), subFor(FUNERAL_KIND));
  const rest = place(w, CHURCHYARD_KIND, x0 + 2, y0 + 4);
  const fd = () => w.buildings.get(tileKey(fx, fy))!;
  for (let i = 0; i < 2 * DAY && !(fd().occupants >= 3 && i > DAY / 4); i++) g.step(); // staff hired (an essential workplace recruits, docs/motivation.md)
  return { w, g, x0, y0, fd: fd(), rest };
}
const run = (g: Game, ticks: number, until?: () => boolean) => { for (let i = 0; i < ticks; i++) { g.step(); if (until?.()) return true; } return false; };
const toHour = (g: Game, h: number) => { const w = g.world; const t = (Math.floor(w.tick / DAY) + (w.tick % DAY >= h * TPH ? 1 : 0)) * DAY + h * TPH; run(g, t - w.tick); };
const ledger = (w: World, owner: string, cat: 'funeral' | 'burial') => { const L = w.players.get(owner)?.ledger; return (L?.today[cat] ?? 0) + (L?.yesterday[cat] ?? 0); };
/** grown-ups at home with a partner living with them, most money first */
const couples = (w: World) => [...w.citizens.values()].filter((c) => c.stage !== LifeStage.Child && c.state === S.Home && c.partner && w.citizens.get(c.partner)?.hh === c.hh && !c.mig).sort((a, b) => a.id - b.id);
const deathOf = (g: Game) => g.sim.death;
type DeadRec = ReturnType<Game['sim']['death']['dead']['get']>;

// ---- 1-3: a death, the hearse, the funeral, the estate --------------------------------------------------------------
console.log('1-3. a death, the hearse and the funeral, the estate');
const T = town();
{
  const { w, g, fd, rest } = T, D = deathOf(g);
  ok(fd?.id === FUNERAL_KIND && fd.occupants > 0, `the funeral director at (${fd?.x}, ${fd?.y}) is staffed (${fd?.occupants} staff)`);
  const st = rest && w.structureAt(rest.x, rest.y);
  ok(rest?.id === CHURCHYARD_KIND && !!st && plotCapacity(CHURCHYARD_KIND, st.ax, st.ay) >= 24, `a churchyard at (${rest?.x}, ${rest?.y}) with ${st ? plotCapacity(CHURCHYARD_KIND, st.ax, st.ay) : 0} plots`);
  toHour(g, 7);
  const c = couples(w).find((x) => Math.abs(x.hx - fd.x) + Math.abs(x.hy - fd.y) < 40)!;
  const partner = w.citizens.get(c.partner)!;
  c.money = 900;
  const pMoney0 = partner.money, f0 = ledger(w, 'sys', 'funeral'), b0 = ledger(w, 'sys', 'burial');
  const id = c.id, name = nameFor(c.id, c.sn), home: [number, number] = [c.hx, c.hy];
  D.die(c, Cause.OldAge);
  const d = D.dead.get(id)!;
  ok(!w.citizens.has(id) && !!d, `${name} died: gone from the world, in the archive`);
  ok(!!d && d.cause === Cause.OldAge && d.died === w.tick && d.partner === partner.id && d.at[0] === home[0] && d.at[1] === home[1] && d.where === 'at home', `the record: cause old age, the tick, the partner, the body left at home (${d?.where})`);
  const info = D.info(id);
  ok(!!info && info.name === name && info.family.some((f) => f.relation === 'partner' && f.living && f.id === partner.id) && info.state === 'awaiting', `the panel: ${info?.name}, ${info?.age}, ${info?.stateText}; family ${info?.family.map((f) => `${f.relation} ${f.name}`).join(', ')}`);
  ok(D.grievingFor(partner) !== undefined, `the partner grieves (${D.grievingFor(partner)})`);
  // the hearse
  let hearse = false;
  const collected = run(g, DAY, () => { if ((g.sim.mobile.counts()[FleetKind.Hearse] ?? 0) > 0) hearse = true; return d.st === 2 || d.st >= 3; });
  ok(hearse && collected && D.stats.byHearse === 1, `a hearse came for the body and took it to the funeral director's within ${((w.tick - d.died) / TPH).toFixed(1)} h (state ${d.st})`);
  const mourners = [...(d.mourners ?? [])];
  ok(d.svc !== undefined && d.rest?.[0] === rest.x && d.rest?.[1] === rest.y && d.slot !== undefined, `the service booked at the churchyard for day ${d.svc !== undefined ? Math.floor(d.svc / DAY) : '-'} (${d.svc !== undefined ? ((d.svc - d.died) / DAY).toFixed(1) : '-'} days on), plot ${d.slot}`);
  const svcDay = Math.floor((d.svc ?? 0) / DAY);
  // the funeral day: the partner stays home from work, the mourners set off, the hearse stands at the chapel
  let errand = 0, atService = 0, shown = false, hearseThere = false, partnerWorked = false;
  const noHearse0 = D.stats.noHearse;
  run(g, 6 * DAY, () => {
    if (w.tick % 5 === 0) {
      for (const m of mourners) { const o = w.citizens.get(m); if (o?.errand === ERRAND_FUNERAL) { errand++; if (o.state === S.AtVenue) atService++; } }
      if (Math.floor(w.tick / DAY) === svcDay && partner.state === S.Work) partnerWorked = true;
      const site = D.graves().find((s) => s.x === rest.x && s.y === rest.y);
      if (site?.f) shown = true;
      if (d.st === 4 && [...g.sim.mobile.units.values()].some((u) => u.kind === FleetKind.Hearse && u.phase === 'dwell')) hearseThere = true;
    }
    return d.st === 5 && !mourners.some((m) => w.citizens.get(m)?.errand === ERRAND_FUNERAL);
  });
  ok(d.st === 5 && !!d.held && d.rested !== undefined, `laid to rest ${((d.rested ?? 0) - d.died) / DAY > 0 ? (((d.rested ?? 0) - d.died) / DAY).toFixed(1) : '-'} days after the death (${D.info(id)?.stateText})`);
  ok(errand > 0 && atService > 0, `mourners went to the service (${mourners.length} asked; seen on the way or there ${errand} times, at the chapel ${atService})`);
  ok(!partnerWorked, 'the partner took the funeral day off');
  ok(shown, 'the funeral showed at the churchyard while it was under way (graves message f)');
  log(`     the hearse ${hearseThere ? 'stood at the chapel through the service' : 'was held up: the service went ahead without it'} (${D.stats.noHearse - noHearse0} held without one)`);
  const site = D.graves().find((s) => s.x === rest.x && s.y === rest.y);
  const graves: number[] = [];
  for (let i = 0; site && i < site.g.length; i += GRAVE_STRIDE) graves.push(site.g[i + 1]);
  ok(graves.includes(id), `the graves message carries the headstone (${graves.length} at the churchyard)`);
  const fee = ledger(w, 'sys', 'funeral') - f0, burial = ledger(w, 'sys', 'burial') - b0;
  ok(fee > 0 && burial > 0 && (d.fees ?? 0) === Math.round(fee + burial), `fees out of the estate to the owner: funeral $${fee}, burial $${burial} (ledger 'funeral', 'burial')`);
  ok(D.stats.inherited === 900 - (d.fees ?? 0) && !!d.heirs?.[0]?.includes(nameFor(partner.id, partner.sn)) && partner.money >= pMoney0 + 900 - (d.fees ?? 0) - 60, `the rest of the estate went to the partner: $${900 - (d.fees ?? 0)} (their money ${pMoney0.toFixed(0)} -> ${partner.money.toFixed(0)}; heirs ${d.heirs?.join(', ')})`);
  run(g, DEATH.griefAfterService * DAY + TPH);
  ok(D.grievingFor(partner) === undefined, 'the partner\'s grief ended soon after a funeral on time');
  log(`     stats ${JSON.stringify(D.stats)}`);
}

// ---- 4: full plots, the mortuary, the crematorium ------------------------------------------------------------------
console.log('4. plots fill; the dead wait at the mortuary; a crematorium takes them');
{
  const { w, g, x0, y0, rest } = T, D = deathOf(g);
  const pl = (D as unknown as { places: Map<string, { slots: number[] }> }).places.get(tileKey(rest.x, rest.y))!;
  const free = pl.slots.filter((s) => s === 0).length;
  D.seedGraves(rest.x, rest.y, free, 7);
  ok(pl.slots.every((s) => s !== 0), `the churchyard is full (${pl.slots.length} plots)`);
  toHour(g, 9);
  const victims = [...w.citizens.values()].filter((c) => c.stage === LifeStage.Retired || c.stage === LifeStage.Adult).filter((c) => c.state === S.Home).slice(0, 3);
  for (const c of victims) D.die(c, Cause.Illness);
  const ids = victims.map((c) => c.id), recs = ids.map((i) => D.dead.get(i)!);
  run(g, 3 * DAY, () => recs.every((r) => r.st === 3));
  const hosp = w.buildings.get(tileKey(x0 + 1, y0 + 16));
  ok(recs.every((r) => r.st === 3), `the ${recs.length} dead wait at the mortuary (states ${recs.map((r) => r.st).join(',')})`);
  ok(recs.every((r) => r.mort?.[0] === hosp?.x && r.mort?.[1] === hosp?.y), `at the hospital's (${hosp?.x}, ${hosp?.y})`);
  run(g, 2);
  ok(g.issues.codeAt(hosp!.x, hosp!.y) === Issue.NoBurial, 'the hospital shows the No burial space badge');
  const panel = hosp && D.panel(hosp);
  ok(!!panel && panel.role === 'mortuary' && panel.waiting === recs.length && !!panel.noSpace, `its panel: ${panel?.waiting} waiting, no space`);
  // a crematorium in reach
  const crem = place(w, CREMATORIUM_KIND, x0 + 12, y0 + 4);
  ok(crem?.id === CREMATORIUM_KIND, `a crematorium at (${crem?.x}, ${crem?.y})`);
  run(g, 6 * DAY, () => recs.every((r) => r.st === 5));
  ok(recs.every((r) => r.st === 5 && r.rest?.[0] === crem.x && r.rest?.[1] === crem.y), `all cremated there (${recs.map((r) => D.info(r.id)?.stateText).join('; ')})`);
  run(g, 2);
  ok(g.issues.codeAt(hosp!.x, hosp!.y) !== Issue.NoBurial, 'the badge cleared');
  const cs = D.graves().find((s) => s.x === crem.x && s.y === crem.y);
  let plaques = 0;
  for (let i = 0; cs && i < cs.g.length; i += GRAVE_STRIDE) if (cs.g[i + 3] & GRAVE_PLAQUE) plaques++;
  ok(plaques >= recs.length, `memorial plaques in the garden of remembrance: ${plaques} (the ${recs.length} and anyone else who died meanwhile)`);
  // every service took place, with its hearse or without: whether a hearse gets out of the funeral director's garage in time
  // depends on the jam outside it in this town (docs/traffic-tuning.md "Hearses in death.ts"), so how many arrived is logged, not asserted
  ok(D.stats.services >= recs.length && D.stats.withHearse + D.stats.noHearse === D.stats.services, `every service went ahead (${D.stats.services}, for the ${recs.length} and anyone else who died meanwhile)`);
  log(`     hearses carried the coffin to ${D.stats.withHearse} of ${D.stats.services} services (the rest held up in this town's jammed streets: the service went ahead without them)`);
}

// ---- 5: fires, explosions and accidents -----------------------------------------------------------------------------
console.log('5. fires, explosions and accidents');
function fireDeaths(t: Town, covered: boolean, n: number): { lit: number; died: number; people: number; burnt: number } {
  const { w, g } = t, D = deathOf(g);
  if (!covered) for (const b of w.builtOf(Zone.Fire)) w.setMothballed(b, true);
  run(g, 20);
  // covered: homes in reach of a staffed fire building; unattended: the same homes, the stations mothballed
  const posts = w.builtOf(Zone.Fire).filter((b) => b.level > 0);
  const homes = w.builtOf(Zone.Residential).filter((b) => b.level >= 1 && !w.sites.has(tileKey(b.x, b.y)) && posts.some((p) => Math.max(Math.abs(p.x - b.x), Math.abs(p.y - b.y)) <= 12))
    .sort((a, b) => a.x - b.x || a.y - b.y).filter((_, i) => i % 3 === 0);
  let lit = 0, people = 0;
  const before = D.stats.fire, burnt0 = g.fires.stats.burnt;
  for (const b of homes) {
    if (lit >= n) break;
    toHour(g, 2); // at night: everyone at home
    const inside = [...w.citizens.values()].filter((c) => c.state === S.Home && c.hx === b.x && c.hy === b.y).length;
    if (!inside || w.buildings.get(tileKey(b.x, b.y)) !== b || !g.fires.ignite(b)) continue;
    lit++;
    // until it is out, but at most 7 hours; people at home at the end are the ones there
    run(g, 7 * TPH, () => !g.fires.dtos().some((f) => f.x === b.x && f.y === b.y && f.ph !== 2));
    people += inside;
  }
  return { lit, died: D.stats.fire - before, people, burnt: g.fires.stats.burnt - burnt0 };
}
{
  // hand-lit fires only (no background fires, no spread), so the two runs differ in the cover alone
  const U = town(seed + 1);
  const un = fireDeaths(U, false, 12);
  ok(un.lit >= 8 && un.died > 0, `unattended: ${un.lit} home fires at night, ${un.burnt} burnt down, ${un.died} of the ${un.people} people at home died`);
  const C = town(seed + 1);
  const cov = fireDeaths(C, true, 12);
  ok(cov.lit >= 8 && cov.died <= Math.max(1, Math.floor(un.died / 4)), `covered: ${cov.lit} fires (${cov.burnt} burnt down), ${cov.died} died (well under a quarter of the unattended)`);
  const stories = U.g.news.all().filter((s) => s.k === 'death');
  ok(stories.length > 0 && stories.every((s) => (s.dead?.length ?? 0) > 0 && s.dead!.every((id) => U.g.sim.death.dead.get(id)?.story === s.id)), `each incident is one news story naming its dead (${stories.length}: "${stories[0]?.h}")`);
  // explosions (fires on: a blast sets its neighbours alight)
  U.g.fires.enabled = true;
  const D = deathOf(U.g), e0 = D.stats.explosion;
  let blasts = 0;
  for (const b of U.w.builtOf(Zone.Residential).filter((x) => x.level >= 2).slice(40, 70)) {
    toHour(U.g, 3);
    if (U.w.buildings.get(tileKey(b.x, b.y)) !== b) continue;
    if (U.g.fires.explode([b.x, b.y], { cause: 'gas', level: true })) blasts++;
    run(U.g, 3 * TPH);
  }
  ok(blasts >= 10 && D.stats.explosion > e0, `gas explosions kill: ${blasts} blasts, ${D.stats.explosion - e0} dead`);
  // accidents (the rate raised for the test, and put back)
  const acc0 = D.stats.accident, rate = DEATH.accidentIndustrial;
  (DEATH as { accidentIndustrial: number }).accidentIndustrial = 0.5;
  (DEATH as { accidentYard: number }).accidentYard = 0.5;
  run(U.g, DAY);
  (DEATH as { accidentIndustrial: number }).accidentIndustrial = rate;
  (DEATH as { accidentYard: number }).accidentYard = 0.0004;
  const accStories = U.g.news.all().filter((s) => s.k === 'death' && /accident/i.test(s.h));
  ok(D.stats.accident > acc0 && accStories.length > 0, `accidents at work: ${D.stats.accident - acc0} at a raised rate, in the news ("${accStories[0]?.h}")`);
  const one = [...D.dead.values()].find((x) => x.cause === Cause.Accident);
  ok(!!one && /accident/.test(one.where), `an accident's record says where: "${one?.where}"`);
}

// ---- 6: the first hour and the warning fire ---------------------------------------------------------------------------
console.log('6. the first-hour rail and the warning fire');
{
  const P = town(seed + 2, 'p1', false);
  const { w, g } = P, D = deathOf(g);
  const olds = [...w.citizens.values()].filter((c) => c.stage !== LifeStage.Child).slice(0, 200);
  const d0 = D.stats.deaths;
  for (const c of olds) { c.born = w.tick / DAY - 112 * 7; D.lifeRoll(c, 112); } // 112 years old: the roll often says die
  ok(D.stats.deaths === d0 && D.stats.spared > 0, `in the player's first hour nobody dies (${D.stats.spared} deaths spared)`);
  (D as unknown as { first: Record<string, number> }).first.p1 = w.tick - DEATH.graceTicks - 1;
  const p = w.players.get('p1')!; if (p.ranks) p.ranks.at[0] = w.tick - DEATH.graceTicks - 1;
  for (const c of olds) if (w.citizens.has(c.id)) D.lifeRoll(c, 112);
  ok(D.stats.deaths > d0, `after it they do (${D.stats.deaths - d0} died)`);
  ok(D.notices.some((n) => n.first && n.owner === 'p1' && n.hint === 'death'), `the town's first death is an advisor line: "${D.notices.find((n) => n.first)?.msg.slice(0, 90)}..."`);
  // the warning fire: the bucket chain, nobody harmed
  for (const b of w.builtOf(Zone.Fire)) w.setMothballed(b, true);
  g.fires.enabled = true;
  toHour(g, 2);
  const home = w.builtOf(Zone.Residential).find((b) => b.level >= 1 && [...w.citizens.values()].some((c) => c.state === S.Home && c.hx === b.x && c.hy === b.y))!;
  const f0 = D.stats.fire;
  g.fires.ignite(home, { warning: true });
  run(g, 7 * TPH, () => !g.fires.dtos().some((f) => f.x === home.x && f.y === home.y && f.ph !== 2));
  ok(D.stats.fire === f0, 'the warning fire harmed nobody');
}

// ---- 7: determinism -----------------------------------------------------------------------------------------------------
console.log('7. determinism');
function scripted(rnd: number) {
  const t = town(rnd);
  const { w, g } = t, D = deathOf(g);
  toHour(g, 8);
  const vs = [...w.citizens.values()].filter((c) => c.state === S.Home && c.stage !== LifeStage.Child).sort((a, b) => a.id - b.id).slice(0, 6);
  for (const c of vs) D.die(c, Cause.OldAge);
  g.fires.enabled = true;
  for (const b of w.builtOf(Zone.Fire)) w.setMothballed(b, true);
  const homes = w.builtOf(Zone.Residential).filter((b) => b.level >= 1).sort((a, b) => a.x - b.x || a.y - b.y).slice(5, 9);
  toHour(g, 2);
  for (const b of homes) g.fires.ignite(b);
  run(g, 5 * DAY);
  const recs = [...D.dead.values()].map((d: NonNullable<DeadRec>) => [d.id, d.cause, d.st, d.slot ?? -1, d.rested ?? -1, d.fees ?? -1].join(':')).join(' ');
  return { recs, graves: JSON.stringify(D.graves()), n: D.dead.size, w, g };
}
const r1 = scripted(seed + 3), r2 = scripted(seed + 3);
ok(r1.n > 6 && r1.recs === r2.recs && r1.graves === r2.graves, `the same seed gives the same archive and graves (${r1.n} records)`);

// ---- 8: saves ------------------------------------------------------------------------------------------------------------
console.log('8. saves');
{
  const snap = JSON.parse(JSON.stringify(snapshotOf(r1.w)));
  ok(!!snap.death && snap.death.dead.length === r1.n && snap.version === 8, `the save carries the archive (${snap.death?.dead.length} records), version still ${snap.version}`);
  const w2 = worldFromSnapshot(snap)!;
  const g2 = createGame(w2, { onConnection() {} }, { devTools: false, sandbox: true });
  g2.step();
  ok(g2.sim.death.dead.size === r1.n && JSON.stringify(g2.sim.death.graves()) === JSON.stringify(r1.g.sim.death.graves()), `it loads with the archive and the same graves (${g2.sim.death.dead.size})`);
  const old = JSON.parse(JSON.stringify(snap)); delete old.death;
  const w3 = worldFromSnapshot(old)!;
  const g3 = createGame(w3, { onConnection() {} }, { devTools: false, sandbox: true });
  for (let i = 0; i < 50; i++) g3.step();
  ok(g3.sim.death.dead.size === 0 && g3.sim.death.graves().length === 0, 'a save from before death loads with an empty archive and runs');
}

console.log(`\n${checks - fails}/${checks} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
