/**
 * `npm run campaign:check` (docs/multiplayer-land.md section 6, phase M6): campaigns on planning applications.
 *
 * 1. A For campaign (posters on the shelters by the homes, TV, leaflets) turns a close vote.
 * 2. An Against campaign deepens a refusal.
 * 3. A turnout claim raises turnout without changing anyone's lean.
 * 4. Leaflets reach the roll's households and nobody else.
 * 5. A public meeting where both sides speak: the side whose claim is truer gains more.
 * 6. Guards: non-stakeholders are refused; the spending cap per side; no new campaigning in the last game hour;
 *    a fly-post over a planning poster, once found, costs credibility.
 * 7. Credibility: an "odour-free" tip that smells costs its applicant credibility in the sector, and their next campaign
 *    there is weaker; a scare claim that proved false costs the objector.
 * 8. Truth check: a false claim about a rival's land is refused; one that becomes false while running is taken down and
 *    its poster fined. Area claims build a reputation homeScore reads.
 * 9. A snapshot round trip keeps campaigns, spend, the meeting, beliefs, turnout boosts, credibility and pending claims.
 * 10. Determinism: the same scene gives the same beliefs, voter by voter.
 *
 *   npx tsx packages/server/src/campaign-check.ts
 */
import {
  Terrain, Zone, KIND_ID, CAMPAIGN, PLAN_CLAIMS, PLAN_CLAIM, AD_CLAIMS, TICKS_PER_HOUR, TICKS_PER_DAY, VALUE_KINDS, ValueKind, CitizenState,
  packTile, seededValues, DEFAULT_TAX, isAreaClaim,
  type ServerMsg, type ClientMsg,
} from '@msimcity/shared';
import { World, emptyStats, lifeDefaults, citizenLater, type Citizen } from './world';
import { createGame, type Game } from './game';
import { snapshotOf, worldFromSnapshot } from './snapshot';
import type { Conn } from './transport';
import type { PlanApp } from './sim/planning';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const SEED = 4242;
const money = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;
const claimOf = (text: string) => PLAN_CLAIMS.findIndex((c) => c.text.startsWith(text));

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
 * planning:check's scene (Ada's land with a street, Bob's homes near his western border, Cy's to the south), with Bob's
 * street along y = 14 and four bus shelters on it whose panels the homes' residents pass; Dee owns land far away.
 */
function scene() {
  const world = new World(SEED);
  for (let y = -10; y < 110; y++) for (let x = -10; x < 410; x++) world.setTile(x, y, packTile(Terrain.Grass, false, 0, 0));
  let accept: ((c: Conn) => void) | null = null;
  const game = createGame(world, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false, planning: true });
  const ada = clientOf(accept!, 'Ada'), bob = clientOf(accept!, 'Bob'), cy = clientOf(accept!, 'Cy'), dee = clientOf(accept!, 'Dee');
  for (const c of [ada, bob, cy, dee]) world.players.get(c.id)!.money = 200_000;
  const parcel = (owner: string, x: number, y: number, w: number, h: number, name = owner) => {
    const p = { id: world.nextId++, owner, name, x, y, w, h, taxRate: DEFAULT_TAX, stats: emptyStats() };
    world.parcels.set(p.id, p);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) world.setParcelId(xx, yy, p.id);
    return p;
  };
  parcel('ada', 0, 0, 60, 40, 'Adaville');
  const bobLand = parcel('bob', 60, 0, 32, 30, 'Bobton');
  parcel('cy', 60, 30, 32, 16, 'Cyford');
  parcel('dee', 340, 0, 40, 40, 'Deeham');
  ada.send({ t: 'build', tool: 'road', tiles: Array.from({ length: 60 }, (_, i) => [i, 10] as [number, number]), dev: true, cls: 0 });
  bob.send({ t: 'build', tool: 'road', tiles: Array.from({ length: 20 }, (_, i) => [60 + i, 14] as [number, number]), dev: true, cls: 0 });
  for (const [x, y] of [[62, 15], [64, 15], [66, 13], [70, 13]]) bob.send({ t: 'build', tool: 'busstop' as never, tiles: [[x, y]], dev: true });
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
  const far = home(350, 20, 3); // Dee's residents, far from everything
  for (let i = 0; i < 3; i++) game.sim.value.refresh();
  return { world, game, ada, bob, cy, dee, home, parcel, far, bobLand };
}
type Scene = ReturnType<typeof scene>;

const place = (s: Scene, who: Cl, tool: string, x: number, y: number, plan?: { conditions?: string[]; offer?: number }) => {
  who.toasts.length = 0;
  who.send({ t: 'build', tool: tool as never, tiles: [[x, y]], dev: true, ...(plan ? { plan } : {}) });
  return who.last();
};
const openApp = (g: Game, x: number, y: number) => [...g.planning.apps.values()].find((a) => a.status === 'open' && a.x === x && a.y === y);
const act = (who: Cl, m: Omit<Extract<ClientMsg, { t: 'planCampaign' }>, 't'>) => { who.toasts.length = 0; who.send({ t: 'planCampaign', ...m }); return who.last(); };
/** The newest campaign of `who` on application `a`. */
const campOf = (s: Scene, who: Cl, a: PlanApp) => s.game.campaigns.campsOf(a.id).filter((c) => c.owner === who.id).at(-1);
/** Run the reach passes for `hours` game hours (time moves; nothing else of the simulation runs). */
const hours = (s: Scene, h: number) => { for (let i = 0; i < h; i++) { s.world.tick += TICKS_PER_HOUR; s.game.campaigns.tick(); } };
const beliefSum = (a: PlanApp) => Object.values(a.beliefs ?? {}).reduce((x, y) => x + y, 0);
const meanLean = (v: { leans: Map<number, number> }) => [...v.leans.values()].reduce((x, y) => x + y, 0) / Math.max(1, v.leans.size);
const credOf = (s: Scene, who: string, x: number, y: number) => s.game.campaigns.credOf(who, x, y);

// ---- 1. a For campaign turns a close vote ---------------------------------------------------------------------------
{
  const s = scene(), pl = s.game.planning;
  place(s, s.ada, 'recycling', 50, 11);
  const rc = openApp(s.game, 50, 11)!;
  // the largest offer that still loses: a close vote
  let close = 0;
  for (let o = 0; o <= 60000; o += 50) { rc.offer = o; const v = pl.vote(rc); if (v.yes > v.no) break; close = o; }
  rc.offer = 0;
  s.ada.send({ t: 'planningAct', id: rc.id, act: 'amend', offer: close });
  const v0 = pl.vote(rc);
  console.log(`a recycling centre at (50, 11) with an offer of ${money(close)}: ${v0.yes} for, ${v0.no} against (roll ${rc.roll.length})`);
  ok(rc.offer === close && v0.yes <= v0.no && v0.no - v0.yes <= 4, 'a close vote that the plan would lose');
  let why = act(s.ada, { id: rc.id, act: 'create', claim: claimOf('Recycling on your doorstep') });
  const c = campOf(s, s.ada, rc)!;
  ok(c && c.side === 1 && /Campaign ready/.test(why), `Ada (the applicant) makes a For campaign: "${s.game.adverts.campaign(c?.id ?? -1)?.text}"`);
  s.ada.toasts.length = 0;
  s.ada.send({ t: 'adRent', campaign: c.id, slots: [[66, 13, 0], [70, 13, 0], [62, 15, 0], [64, 15, 0]] });
  why = s.ada.last();
  ok(s.game.adverts.postersCount(c.id) === 4, `posters go up on Bob's four bus shelters without the Advertising tech (${why})`);
  hours(s, 6);
  const afterPosters = beliefSum(rc), seen = Object.keys(rc.beliefs ?? {}).length;
  ok(afterPosters > 0 && seen > 0 && seen < rc.roll.length, `six game hours of posters: ${seen} of ${rc.roll.length} voters pass a shelter, belief sum +${afterPosters.toFixed(2)}`);
  why = act(s.ada, { id: rc.id, act: 'tv', campaign: c.id });
  hours(s, 2);
  ok(Object.keys(rc.beliefs ?? {}).length > seen, `TV spots reach households at home too (${Object.keys(rc.beliefs ?? {}).length} voters believe something now)`);
  why = act(s.ada, { id: rc.id, act: 'leaflet', campaign: c.id });
  ok(/Leaflets through/.test(why), why);
  const v1 = pl.vote(rc);
  console.log(`  after the campaign: ${v1.yes} for, ${v1.no} against; spent For ${money(s.game.campaigns.spentOf(rc)[0])} of a cap of ${money(s.game.campaigns.capOf(rc))}`);
  ok(v1.yes > v1.no, 'the For campaign turns the vote');
  s.world.tick = rc.ends; pl.tick();
  ok(rc.status === 'approved' && s.game.adverts.postersCount(c.id) === 0 && !s.game.adverts.campaign(c.id), `decided (${rc.result}); the plan's campaigns end and their posters come down`);
}

// ---- 2. an Against campaign deepens a refusal; 3. a turnout claim; 4. leaflets only reach the roll ------------------
{
  const s = scene(), pl = s.game.planning;
  place(s, s.ada, 'opentip', 24, 9);
  const tip = openApp(s.game, 24, 9)!;
  const late = s.home(60, 16, 3); // built during the notice: not on the roll
  const v0 = pl.vote(tip);
  console.log(`an open tip at (24, 9): ${v0.yes} for, ${v0.no} against, mean lean ${meanLean(v0).toFixed(3)} (roll ${tip.roll.length})`);
  // 3. turnout first, on a clean slate
  let why = act(s.bob, { id: tip.id, act: 'create', claim: PLAN_CLAIM.turnout });
  const tc = campOf(s, s.bob, tip)!;
  ok(tc && tc.side === -1 && /vote by/.test(s.game.adverts.campaign(tc.id)?.text ?? ''), `Bob runs the turnout claim against the plan: "${s.game.adverts.campaign(tc?.id ?? -1)?.text}"`);
  why = act(s.bob, { id: tip.id, act: 'leaflet', campaign: tc.id });
  const v1 = pl.vote(tip);
  const sameLeans = [...v0.leans].every(([id, l]) => Math.abs((v1.leans.get(id) ?? NaN) - l) < 1e-12);
  ok(sameLeans && !Object.keys(tip.beliefs ?? {}).length, 'the turnout claim moves nobody: every lean is unchanged and no beliefs are set');
  ok(v1.no > v0.no && v1.yes === v0.yes, `but more of those leaning against turn out: ${v0.no} -> ${v1.no} against (${why})`);
  // 4. leaflets only reach households on the roll
  const roll = new Set(tip.roll), boosted = Object.keys(tip.turn ?? {}).map(Number);
  ok(boosted.length > 0 && boosted.every((id) => roll.has(id)) && !boosted.some((id) => late.includes(id) || s.far.includes(id)), `leaflets reach ${boosted.length} voters, all on the roll: not the home built during the notice, not Dee's residents far away`);
  // 2. an Against campaign deepens the refusal
  why = act(s.bob, { id: tip.id, act: 'create', claim: PLAN_CLAIM.fumes });
  const ac = campOf(s, s.bob, tip)!;
  why = act(s.bob, { id: tip.id, act: 'leaflet', campaign: ac.id });
  const v2 = pl.vote(tip);
  ok(beliefSum(tip) < 0 && meanLean(v2) < meanLean(v1) && v2.no >= v1.no && v2.yes <= v1.yes, `an Against campaign ("Fumes by the school", leaflets) deepens the refusal: mean lean ${meanLean(v1).toFixed(3)} -> ${meanLean(v2).toFixed(3)}, ${v2.yes} for, ${v2.no} against`);
  ok(Object.keys(tip.beliefs ?? {}).every((id) => roll.has(Number(id))), 'beliefs about the plan are only ever set for voters on the roll');
}

// ---- 5. a public meeting: the truer side gains more ----------------------------------------------------------------
{
  const s = scene(), cp = s.game.campaigns;
  place(s, s.ada, 'opentip', 24, 9);
  const tip = openApp(s.game, 24, 9)!;
  act(s.ada, { id: tip.id, act: 'create', claim: PLAN_CLAIM.odourFree });
  const ac = campOf(s, s.ada, tip)!;
  act(s.bob, { id: tip.id, act: 'create', claim: PLAN_CLAIM.fumes });
  const bc = campOf(s, s.bob, tip)!;
  const tA = cp.expectedTruth(tip, ac.claim), tB = cp.expectedTruth(tip, bc.claim);
  ok(tA < 0.5 && tB >= 0.5, `against the tip's expected impact, "odour-free" is false (${tA.toFixed(2)}) and "fumes by the school" true (${tB.toFixed(2)})`);
  let why = act(s.ada, { id: tip.id, act: 'meeting', campaign: ac.id });
  const m = cp.meetingOf(tip.id)!;
  ok(m && /Public meeting booked/.test(why), `Ada calls a public meeting: ${why} at ${Math.floor((m.at % TICKS_PER_DAY) / TICKS_PER_HOUR)}:00`);
  why = act(s.bob, { id: tip.id, act: 'meeting', campaign: bc.id });
  ok(m.speakers.length === 2 && /speak/.test(why), `Bob speaks at it too (${why})`);
  const a0 = ac.moved, b0 = bc.moved;
  s.world.tick = m.at; cp.tick();
  ok(m.done && (m.came ?? 0) > 0, `the meeting is held: ${m.came} of ${tip.roll.length} residents came`);
  console.log(`  nudges given: Ada (odour-free) ${(ac.moved - a0).toFixed(2)}, Bob (fumes) ${(bc.moved - b0).toFixed(2)}; belief sum ${beliefSum(tip).toFixed(2)}`);
  ok(bc.moved - b0 > 1.5 * (ac.moved - a0) && beliefSum(tip) < 0, 'both sides spoke: the truer case (Bob\'s) gains more, and the room leaves against');
}

// ---- 6. guards -------------------------------------------------------------------------------------------------------
{
  const s = scene(), cp = s.game.campaigns;
  place(s, s.ada, 'opentip', 24, 9);
  const tip = openApp(s.game, 24, 9)!;
  let why = act(s.dee, { id: tip.id, act: 'create', claim: PLAN_CLAIM.fumes });
  ok(/Only the applicant and owners of land in the impact zone/.test(why) && !campOf(s, s.dee, tip), `Dee (no land in the zone) may not campaign (${why})`);
  why = act(s.cy, { id: tip.id, act: 'create', claim: PLAN_CLAIM.fumes });
  ok(campOf(s, s.cy, tip), `Cy (land in the zone) may (${why})`);
  why = act(s.ada, { id: tip.id, act: 'create', claim: PLAN_CLAIM.fumes });
  ok(/against your own plan/.test(why), `the applicant may not campaign against their own plan (${why})`);
  why = act(s.ada, { id: tip.id, act: 'create', claim: PLAN_CLAIM.weListened });
  ok(/needs a changed plan/.test(why), `"We listened" needs an amended plan (${why})`);
  // the spending cap per side
  const cap = cp.capOf(tip);
  act(s.bob, { id: tip.id, act: 'create', claim: claimOf('Lorries') });
  const bc = campOf(s, s.bob, tip)!;
  const spentCy = cp.spentOf(tip)[1];
  why = act(s.bob, { id: tip.id, act: 'tv', campaign: bc.id });
  why = act(s.bob, { id: tip.id, act: 'meeting', campaign: bc.id });
  const before = cp.spentOf(tip)[1];
  why = act(s.bob, { id: tip.id, act: 'create', claim: claimOf('House prices') });
  const b2 = campOf(s, s.bob, tip)!;
  why = act(s.bob, { id: tip.id, act: 'tv', campaign: b2.id });
  ok(/over the cap/.test(why) && cp.spentOf(tip)[1] <= cap, `the Against side's spending is capped at ${money(cap)} (the tip's cost): Cy ${money(spentCy)} and Bob ${money(before - spentCy + CAMPAIGN.artCost)} spent; another TV day is refused (${why})`);
  ok(cp.spentOf(tip)[0] === 0, 'the For side\'s spending is counted apart');
  // no new campaigning in the last game hour
  s.world.tick = tip.ends - CAMPAIGN.lastTicks / 2;
  why = act(s.bob, { id: tip.id, act: 'leaflet', campaign: bc.id });
  ok(/within the hour/.test(why), `no new campaigning in the last game hour (${why})`);
  s.world.tick = tip.filed;
  // fly-posting over a planning poster costs credibility once found
  s.bob.send({ t: 'adRent', campaign: bc.id, slots: [[66, 13, 0]] });
  act(s.ada, { id: tip.id, act: 'create', claim: PLAN_CLAIM.odourFree });
  const ac = campOf(s, s.ada, tip)!;
  s.ada.toasts.length = 0;
  s.ada.send({ t: 'adFlyPost', campaign: ac.id, slot: [66, 13, 0] });
  why = s.ada.last();
  const fly = s.game.adverts.flyPosts();
  ok(fly.length === 1 && fly[0].c === ac.id && fly[0].o === bc.id, `Ada fly-posts over Bob's planning poster (${why})`);
  const c0 = credOf(s, 'ada', 24, 9);
  for (let i = 0; i < 40 && s.game.adverts.flyPosts().length; i++) hours(s, 1);
  ok(!s.game.adverts.flyPosts().length && s.game.adverts.list().find((r) => r.x === 66 && r.y === 13)?.c === bc.id, 'it is found and Bob\'s poster shows again');
  ok(credOf(s, 'ada', 24, 9) < c0, `Ada's credibility in the sector falls (${c0.toFixed(2)} -> ${credOf(s, 'ada', 24, 9).toFixed(2)})`);
}

// ---- 7. credibility: a false "odour-free" claim ----------------------------------------------------------------------
/** A tip at (24, 9) with Ada's "odour-free" and Bob's "lorries all day" claims, approved (beliefs set, as a big For campaign would) and built. */
function approvedTip(s: Scene) {
  const pl = s.game.planning;
  place(s, s.ada, 'opentip', 24, 9);
  const tip = openApp(s.game, 24, 9)!;
  act(s.ada, { id: tip.id, act: 'create', claim: PLAN_CLAIM.odourFree });
  act(s.ada, { id: tip.id, act: 'leaflet', campaign: campOf(s, s.ada, tip)!.id });
  act(s.bob, { id: tip.id, act: 'create', claim: claimOf('Lorries') });
  act(s.bob, { id: tip.id, act: 'leaflet', campaign: campOf(s, s.bob, tip)!.id });
  for (const id of tip.roll) pl.believe(tip.id, id, 1);
  tip.offer = 30000;
  s.world.tick = tip.ends; pl.tick();
  return tip;
}
/** Ada's For campaign with leaflets on a recycling centre at (50, 11): the belief sum it buys. */
function nextCampaign(s: Scene) {
  place(s, s.ada, 'recycling', 50, 11);
  const rc = openApp(s.game, 50, 11)!;
  act(s.ada, { id: rc.id, act: 'create', claim: claimOf('Recycling on your doorstep') });
  act(s.ada, { id: rc.id, act: 'leaflet', campaign: campOf(s, s.ada, rc)!.id });
  return beliefSum(rc);
}
{
  const s = scene(), cp = s.game.campaigns;
  const tip = approvedTip(s);
  ok(tip.status === 'approved' && s.world.sites.get('24,9'), `the tip is approved (${tip.result})`);
  ok(cp.watching().some((w) => w.app === tip.id && w.claims.length === 2), 'its claims wait to be judged by the residents who live with it');
  s.world.completeSite(s.world.sites.get('24,9')!);
  s.game.sim.refuse.handledAt = () => 300; // the tip takes the town's refuse: it smells
  for (let i = 0; i < 12; i++) s.game.sim.value.refresh();
  const smell = s.game.sim.value.kindAt(63, 8, ValueKind.Smell);
  console.log(`  ${VALUE_KINDS[ValueKind.Smell].name} at Bob's homes now ${Math.round(100 * smell)}%`);
  const a0 = credOf(s, 'ada', 24, 9), b0 = credOf(s, 'bob', 24, 9);
  s.world.tick += CAMPAIGN.truthAfter; cp.tick();
  const a1 = credOf(s, 'ada', 24, 9), b1 = credOf(s, 'bob', 24, 9);
  ok(a1 < a0 && cp.stats.false >= 1, `"odour-free" proved false: Ada's credibility in the sector ${a0.toFixed(2)} -> ${a1.toFixed(2)}`);
  ok(b1 !== b0, `Bob's "lorries on our streets all day" is judged too: ${b0.toFixed(2)} -> ${b1.toFixed(2)} (${b1 < b0 ? 'no lorries measured: the scare cost the objector' : 'borne out'})`);
  ok(credOf(s, 'ada', 300, 9) === 1, 'credibility is per sector: Ada elsewhere is untouched');
  const weak = nextCampaign(s);
  const s2 = scene();
  const fresh = nextCampaign(s2);
  ok(weak > 0 && weak < fresh * 0.95 && Math.abs(weak / fresh - a1) < 0.02, `Ada's next campaign in the sector is weaker: belief bought ${weak.toFixed(2)} against ${fresh.toFixed(2)} with clean credibility (x${(weak / fresh).toFixed(2)})`);

  // ---- 8. truth check on claims about a rival's land --------------------------------------------------------------
  const reeks = AD_CLAIMS.findIndex((c) => c.text === '{place} reeks'), leafy = AD_CLAIMS.findIndex((c) => c.text === 'Leafy {place}');
  ok(isAreaClaim(reeks) && isAreaClaim(leafy), 'area claims are in the advert claim table');
  s.world.players.get('ada')!.tech = ['zon1', 'adv1'];
  s.world.players.get('bob')!.tech = ['zon1', 'adv1'];
  s.game.sim.refuse.handledAt = () => 0; // the tip stops
  for (let i = 0; i < 30; i++) s.game.sim.value.refresh();
  s.ada.toasts.length = 0;
  s.ada.send({ t: 'adCampaign', theme: 1, claim: reeks, look: 0, target: { kind: 'parcel', id: s.bobLand.id } });
  let why = s.ada.last();
  ok(/not true of Bobton/.test(why), `Ada may not say Bobton reeks while it does not (${why})`);
  s.game.sim.refuse.handledAt = () => 300;
  for (let i = 0; i < 12; i++) s.game.sim.value.refresh();
  s.ada.send({ t: 'adCampaign', theme: 1, claim: reeks, look: 0, target: { kind: 'parcel', id: s.bobLand.id } });
  why = s.ada.last();
  const slur = s.game.adverts.campaignList().find((c) => c.owner === 'ada' && c.claim === reeks);
  ok(slur, `with the tip running it is true, and goes up: "${slur?.text}" (${why})`);
  s.ada.send({ t: 'adRent', campaign: slur!.id, slots: [[70, 13, 0]] });
  s.game.sim.refuse.handledAt = () => 0;
  for (let i = 0; i < 30; i++) s.game.sim.value.refresh();
  const ada0 = s.world.players.get('ada')!.money, bob0 = s.world.players.get('bob')!.money;
  hours(s, 1);
  ok(!s.game.adverts.campaign(slur!.id) && cp.stats.takenDown === 1, 'the tip stops; "Bobton reeks" is no longer true: taken down within the hour');
  ok(Math.abs(ada0 - s.world.players.get('ada')!.money - CAMPAIGN.falseFine) < 1e-6 && Math.abs(s.world.players.get('bob')!.money - bob0 - CAMPAIGN.falseFine) < 1e-6, `Ada is fined ${money(CAMPAIGN.falseFine)}, paid to Bob`);
  // area opinion: Bob markets his own land; its reputation is read by homeScore and fades
  s.bob.send({ t: 'adCampaign', theme: 3, claim: leafy, look: 0, target: { kind: 'parcel', id: s.bobLand.id } });
  const ad = s.game.adverts.campaignList().find((c) => c.owner === 'bob' && c.claim === leafy)!;
  s.bob.send({ t: 'adRent', campaign: ad.id, slots: [[62, 15, 0], [64, 15, 0]] });
  hours(s, 12);
  const rep = cp.reputation(s.bobLand.id);
  ok(rep > 0 && s.game.sim.motive.areaRep!(63, 8) > 0 && s.game.sim.motive.areaRep!(20, 20) === 0, `Bob's "Leafy Bobton" posters build Bobton's reputation (${rep.toFixed(3)}): homes there score higher with movers (+${s.game.sim.motive.areaRep!(63, 8).toFixed(3)})`);
  s.bob.send({ t: 'adEnd', campaign: ad.id, drop: true });
  hours(s, 24 * 3);
  ok(cp.reputation(s.bobLand.id) < rep / 1.8, `without the posters it fades back toward the truth (${cp.reputation(s.bobLand.id).toFixed(3)} after three days)`);
}

// ---- 9. a snapshot round trip --------------------------------------------------------------------------------------
{
  const s = scene(), cp = s.game.campaigns;
  place(s, s.ada, 'opentip', 24, 9);
  const tip = openApp(s.game, 24, 9)!;
  act(s.bob, { id: tip.id, act: 'create', claim: PLAN_CLAIM.fumes });
  const bc = campOf(s, s.bob, tip)!;
  act(s.bob, { id: tip.id, act: 'leaflet', campaign: bc.id, n: 5 });
  act(s.bob, { id: tip.id, act: 'meeting', campaign: bc.id });
  act(s.cy, { id: tip.id, act: 'create', claim: PLAN_CLAIM.turnout });
  act(s.cy, { id: tip.id, act: 'leaflet', campaign: campOf(s, s.cy, tip)!.id });
  s.bob.send({ t: 'adRent', campaign: bc.id, slots: [[66, 13, 0]] });
  // credibility from an earlier plan
  (cp as unknown as { setCred(w: string, x: number, y: number, v: number): void }).setCred('ada', 24, 9, 0.7);
  const snap = JSON.parse(JSON.stringify(snapshotOf(s.world)));
  ok(snap.campaigns && Array.isArray(snap.campaigns.camps) && snap.campaigns.cred.length === 1, 'the snapshot carries the campaigns field');
  const w2 = worldFromSnapshot(snap)!;
  const g2 = createGame(w2, { onConnection: () => {} }, { devTools: true, sandbox: false, planning: true });
  const t2 = g2.planning.apps.get(tip.id)!;
  const c2 = g2.campaigns.campsOf(tip.id);
  ok(c2.length === 2 && c2.find((c) => c.id === bc.id)?.doors.length === 5 && g2.adverts.postersCount(bc.id) === 1, 'campaigns load back with their leafleted doors and posters');
  ok(JSON.stringify(g2.campaigns.spentOf(t2)) === JSON.stringify(cp.spentOf(tip)) && g2.campaigns.meetingOf(tip.id)?.speakers.join() === String(bc.id), `the spend (${JSON.stringify(cp.spentOf(tip))}) and the meeting load back`);
  ok(JSON.stringify(t2.beliefs) === JSON.stringify(tip.beliefs) && JSON.stringify(t2.turn) === JSON.stringify(tip.turn), 'beliefs and turnout boosts on the application load back');
  ok(Math.abs(g2.campaigns.credOf('ada', 24, 9) - 0.7) < 1e-9, 'credibility per sector loads back');
  const plain = JSON.parse(JSON.stringify(snapshotOf(s.world)));
  delete plain.campaigns;
  const w3 = worldFromSnapshot(plain)!;
  const g3 = createGame(w3, { onConnection: () => {} }, { devTools: true, sandbox: false, planning: true });
  ok(g3.campaigns.campsOf(tip.id).length === 0 && g3.campaigns.credOf('ada', 24, 9) === 1, 'a save from before M6 loads with no campaigns and neutral credibility');
  const empty = scene();
  ok(!snapshotOf(empty.world).campaigns, 'a world with no campaigning saves without the field');
}

// ---- 10. determinism -----------------------------------------------------------------------------------------------
{
  const run = () => {
    const s = scene();
    place(s, s.ada, 'opentip', 24, 9);
    const tip = openApp(s.game, 24, 9)!;
    act(s.ada, { id: tip.id, act: 'create', claim: PLAN_CLAIM.odourFree });
    const ac = campOf(s, s.ada, tip)!;
    s.ada.send({ t: 'adRent', campaign: ac.id, slots: [[66, 13, 0], [62, 15, 0]] });
    act(s.ada, { id: tip.id, act: 'meeting', campaign: ac.id });
    act(s.bob, { id: tip.id, act: 'create', claim: PLAN_CLAIM.fumes });
    act(s.bob, { id: tip.id, act: 'leaflet', campaign: campOf(s, s.bob, tip)!.id, n: 6 });
    act(s.bob, { id: tip.id, act: 'meeting', campaign: campOf(s, s.bob, tip)!.id });
    hours(s, 22);
    const v = s.game.planning.vote(tip);
    return JSON.stringify({ b: Object.entries(tip.beliefs ?? {}).map(([k, x]) => [k, Math.round(x * 1e9)]), yes: v.yes, no: v.no });
  };
  const r1 = run(), r2 = run();
  ok(r1 === r2, `the same campaigns give the same beliefs, voter by voter (${JSON.parse(r1).b.length} voters, ${JSON.parse(r1).yes} for, ${JSON.parse(r1).no} against)`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall campaign checks passed');
process.exit(failed ? 1 : 0);
