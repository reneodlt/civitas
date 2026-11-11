import {
  CAMPAIGN, PLAN_CLAIMS, PRICE_KIND, AD_CLAIMS, TICKS_PER_DAY, TICKS_PER_HOUR, VALUE_COUNT, VALUE_KIND_COUNT, VALUE_CELL, AVERAGE_VALUE_WEIGHTS, Zone, KIND_NAMES,
  planClaimText, claimTruth, susceptibility, isContrarian, hasTv, posterCondition, sectorOfTile, isTurnoutClaim, isAreaClaim,
  planAt, withPlan, combineValue, planningSourceOf, hash2, spendableMoney, tileKey, CIVIC_COST, BUS_STOP_KIND,
  type PlanCampaignsDTO, type PlanCampaignDTO,
} from '@msimcity/shared';
import type { World, Citizen, Player } from '../world';
import type { Simulation } from './simulation';
import type { Adverts } from './adverts';
import type { Planning, PlanApp } from './planning';
import { buildCost } from './planning';

/**
 * Campaigns on planning applications (docs/multiplayer-land.md section 6, M6). One per game (game.ts), beside Adverts and
 * Planning, ticked with the systems.
 *
 * - **The `plan` target.** A stakeholder (the applicant, or an owner of land in the impact zone) makes a campaign on an
 *   open application with a claim of PLAN_CLAIMS (For or Against, tied to a value and a value kind; or the turnout claim).
 *   It is an advert campaign (Adverts.createPlan) so its posters rent, wear and draw like any other.
 * - **Reach** runs once a game hour over the frozen roll of each open application with campaigns (only the roll's
 *   beliefs about a plan matter): a voter sees a poster within CAMPAIGN.seeReach tiles of their home or their commute,
 *   and a TV spot at home if the household has a set. The nudge is the channel's strength × susceptibility × the voter's
 *   weight on the claim's value × the poster's condition (wear; wrecked posters backfire) × freshness (1 / (1 + days of
 *   exposure)) × the campaigner's credibility in the sector; contrarians move the other way. It moves the voter's belief
 *   about the plan (Planning.believe) toward the claim's side; a turnout claim instead raises the turnout of those already
 *   leaning that way (Planning.boostTurnout) and moves nobody.
 * - **Leaflets and doorsteps** reach households on the roll directly (the zone's residents and nobody else), per household.
 *   **Public meetings** hire a hall near the zone (a marquee when none is near) for the evening; residents on the roll
 *   attend by chance and get a strong nudge from each side speaking; when both sides speak, the side whose claim is truer
 *   (against the plan's expected impact) gains more.
 * - **Guards.** Stakeholders only; a spending cap per side scaled by the plan's cost; freshness; no new campaigning in the
 *   last game hour; fly-posting over a planning poster during a notice costs credibility when found.
 * - **Credibility** per player per map sector (1 at first, CAMPAIGN.credMin-credMax) multiplies their campaigns there. Once
 *   an approved plan has stood CAMPAIGN.truthAfter, each claim made about it is judged against the M1 field measured over
 *   the zone's homes (and the plain facts): borne out raises its maker's credibility, proved false lowers it, more for a
 *   campaign that reached more of the roll.
 * - **Area claims** (AD_CLAIMS with a kind, "{place} is noisy"): about someone else's land they must be true when posted
 *   (Adverts asks `areaTruth`) and stay true: one found false while running is taken down and its maker fined (paid to
 *   the land's owner). Their posters build the parcel's reputation (belief, short run: Motivation.homeScore reads it),
 *   which fades back to the truth; an overhyped claim about one's own land costs credibility.
 */

interface PlanCamp {
  /** the advert campaign's id */
  id: number; app: number; owner: string; side: 1 | -1; claim: number;
  /** TV airtime until this tick */
  tvUntil?: number;
  /** households leafleted */
  doors: number[];
  /** distinct voters reached, and the sum of nudges given (both sides of a meeting are compared by it) */
  reached: number; moved: number;
}
interface Meeting { app: number; at: number; x: number; y: number; hall: string; speakers: number[]; done?: boolean; came?: number }
/** An approved plan's claims, waiting to be judged against the truth. */
interface Watch {
  app: number; by: string; what: string; x: number; y: number; bk: number;
  /** the zone's home cells (cell x, cell y pairs) and the kinds there when it was approved (bytes 0-255) */
  cells: number[]; base: number[];
  due: number; roll: number; offer: boolean; amended: boolean; tries?: number;
  claims: { owner: string; claim: number; side: 1 | -1; text: string; reached: number }[];
}
export interface CampaignsSave {
  camps: PlanCamp[]; meetings: Meeting[]; spent: [number, number, number][];
  /** [player, sector x, sector y, credibility × 1000] for credibility other than 1 */
  cred: [string, number, number, number][];
  watches: Watch[];
  /** area reputation: [parcel, belief × 1000] */
  rep?: [number, number][];
}

const PASSES_PER_DAY = TICKS_PER_DAY / CAMPAIGN.passTicks;
const money = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class PlanCampaigns {
  notices: { owner: string; msg: string }[] = [];
  stats = { created: 0, leaflets: 0, meetings: 0, judged: 0, borne: 0, false: 0, takenDown: 0, flyFound: 0, refused: 0 };
  private camps = new Map<number, PlanCamp>();
  private meetings = new Map<number, Meeting>();
  private spent = new Map<number, [number, number]>();
  private cred = new Map<string, number>();
  private watches: Watch[] = [];
  private rep = new Map<number, number>();
  /** per campaign: days of exposure per voter (freshness), and who was reached (not saved: a load starts them afresh) */
  private seen = new Map<number, Map<number, number>>();
  private reachedBy = new Map<number, Set<number>>();
  private flyToday = new Map<string, number>();
  private flyDay = -1;
  private lastPass = -1;
  private wbuf = new Array(VALUE_COUNT).fill(0);

  constructor(private w: World, private sim: Simulation, private ads: Adverts, private pl: Planning) {
    const s = w.campaignsLoaded as CampaignsSave | null;
    if (s && typeof s === 'object') {
      for (const c of Array.isArray(s.camps) ? s.camps : []) if (c && Number.isInteger(c.id) && ads.campaign(c.id)) this.camps.set(c.id, { ...c, doors: [...(c.doors ?? [])] });
      for (const m of Array.isArray(s.meetings) ? s.meetings : []) if (m && Number.isInteger(m.app)) this.meetings.set(m.app, { ...m, speakers: [...m.speakers] });
      for (const r of Array.isArray(s.spent) ? s.spent : []) if (Array.isArray(r)) this.spent.set(r[0], [r[1], r[2]]);
      for (const r of Array.isArray(s.cred) ? s.cred : []) if (Array.isArray(r) && typeof r[0] === 'string') this.cred.set(`${r[0]}|${r[1]}|${r[2]}`, r[3] / 1000);
      for (const wt of Array.isArray(s.watches) ? s.watches : []) if (wt && Array.isArray(wt.claims)) this.watches.push({ ...wt });
      for (const r of Array.isArray(s.rep) ? s.rep : []) if (Array.isArray(r)) this.rep.set(r[0], r[1] / 1000);
      w.campaignsLoaded = null;
    }
    w.campaignsSave = () => this.save();
    // poster rent of a plan campaign counts against its side's cap; new rent (not midnight's) passes the guards first
    ads.planRent = (c, cost, isNew) => {
      const pc = this.camps.get(c.id), a = pc && pl.apps.get(pc.app);
      if (!pc || !a) return null;
      if (isNew) {
        if (a.status !== 'open') return 'That application has been decided';
        const why = this.lateRefusal(a) ?? this.capRefusal(a, pc.side, cost);
        if (why) return why;
      }
      this.addSpent(a.id, pc.side, cost);
      return null;
    };
    ads.areaTruth = (parcel, claim) => this.areaTrue(parcel, claim);
    pl.onClose = (a) => this.closed(a);
    pl.campInfo = (a) => this.dtoOf(a);
    sim.motive.areaRep = (x, y) => this.repAt(x, y);
  }

  // ---- asking ----------------------------------------------------------------------------------------------------

  /** Whether `who` has a stake in application `a`: its applicant, or an owner of land in its impact zone. */
  stake(who: string, a: PlanApp): boolean { return a.by === who || a.affected.includes(who); }
  /** The spending cap per side: CAMPAIGN.capShare of the plan's cost (the building and its conditions), at least capMin. */
  capOf(a: PlanApp): number { return Math.max(CAMPAIGN.capMin, Math.round(CAMPAIGN.capShare * (a.bk === undefined ? 0 : a.kind === 'build' ? buildCost(a.bk, a.mask) : CIVIC_COST[a.bk] ?? 0))); }
  spentOf(a: PlanApp): [number, number] { return this.spent.get(a.id) ?? [0, 0]; }
  /** A player's credibility in the sector of tile (x, y): 1 unless their claims there were judged. */
  credOf(who: string, x: number, y: number): number { const [sx, sy] = sectorOfTile(x, y); return this.cred.get(`${who}|${sx}|${sy}`) ?? 1; }
  private setCred(who: string, x: number, y: number, v: number) {
    const [sx, sy] = sectorOfTile(x, y), k = `${who}|${sx}|${sy}`, c = clamp(v, CAMPAIGN.credMin, CAMPAIGN.credMax);
    if (Math.abs(c - 1) < 1e-4) this.cred.delete(k); else this.cred.set(k, c);
    this.pl.changed = true;
  }
  private capRefusal(a: PlanApp, side: 1 | -1, cost: number): string | null {
    const cap = this.capOf(a), s = this.spentOf(a)[side > 0 ? 0 : 1];
    return s + cost > cap + 1e-6 ? `The ${side > 0 ? 'For' : 'Against'} side may spend ${money(cap)} on this plan (${money(s)} spent): that would be ${money(s + cost - cap)} over the cap` : null;
  }
  private lateRefusal(a: PlanApp): string | null {
    return CAMPAIGN.lastHourOn && a.ends - this.w.tick <= CAMPAIGN.lastTicks ? 'The vote is within the hour: no new campaigning now' : null;
  }
  private addSpent(app: number, side: 1 | -1, v: number) {
    const s = this.spent.get(app) ?? [0, 0];
    s[side > 0 ? 0 : 1] += v;
    this.spent.set(app, s);
    this.pl.changed = true;
  }
  /** The checks every new piece of campaigning passes: the application is open, the player has a stake, the hour, the cap, the money. */
  private guard(p: Player, a: PlanApp | undefined, side: 1 | -1, cost: number): string | null {
    if (!a || a.status !== 'open' || a.kind === 'closure') return 'That application is not open to campaigning';
    if (!this.stake(p.id, a)) { this.stats.refused++; return 'Only the applicant and owners of land in the impact zone may campaign on a plan'; }
    if (p.admin) return 'In administration: campaigning is stopped until a midnight finds the treasury at zero or above';
    const late = this.lateRefusal(a);
    if (late) return late;
    const cap = this.capRefusal(a, side, cost);
    if (cap) return cap;
    if (spendableMoney(p.money, p.devUnlimited) < cost) return `That costs ${money(cost)}: more than you can spend`;
    return null;
  }
  private charge(p: Player, a: PlanApp, side: 1 | -1, cost: number) {
    if (cost) this.w.credit(p.id, -cost, 'ads');
    this.addSpent(a.id, side, cost);
  }
  private camp(p: Player, id: number): PlanCamp | string {
    const c = this.camps.get(Number(id));
    if (!c || c.owner !== p.id) return 'Pick one of your campaigns on this plan';
    return c;
  }

  // ---- intents (net.ts) ------------------------------------------------------------------------------------------

  /** A campaign on application `appId` saying claim `claim` (a turnout claim takes `side`, else the applicant's is For). */
  create(p: Player, appId: number, claim: number, side?: number, look = 0): string | PlanCamp {
    const a = this.pl.apps.get(Number(appId)), cl = PLAN_CLAIMS[Number(claim)];
    if (!cl) return 'Pick a claim';
    const s: 1 | -1 = cl.side !== 0 ? cl.side : side === 1 || side === -1 ? side : a?.by === p.id ? 1 : -1;
    const why = this.guard(p, a, s, CAMPAIGN.artCost);
    if (why) return why;
    if (cl.test === 'amended' && !a!.amended) return '"We listened" needs a changed plan: add a condition or raise the offer first';
    if (cl.side === -1 && a!.by === p.id) return 'You cannot campaign against your own plan';
    const text = planClaimText(claim, { place: this.placeOf(a!), n: planningSourceOf(a!.bk ?? -1)?.jobs ?? 0, day: this.dayWords(a!.ends) });
    const ad = this.ads.createPlan(p.id, cl.value, claim, text, look || (s > 0 ? 2 + 8 * 3 : 0), a!.id);
    if (typeof ad === 'string') return ad;
    this.charge(p, a!, s, CAMPAIGN.artCost);
    const c: PlanCamp = { id: ad.id, app: a!.id, owner: p.id, side: s, claim, doors: [], reached: 0, moved: 0 };
    this.camps.set(c.id, c);
    this.stats.created++;
    this.pl.changed = true;
    const msg = `${this.name(p.id)} campaigns ${s > 0 ? 'for' : 'against'} ${this.what(a!)}: "${text}"`;
    for (const o of new Set([a!.by, ...a!.affected])) if (o !== p.id) this.notices.push({ owner: o, msg });
    return c;
  }

  /** Leaflet `n` households on the roll not yet leafleted by this campaign (all of them when n is 0). */
  leaflet(p: Player, campId: number, n = 0): string | { households: number; people: number; cost: number } {
    const c = this.camp(p, campId);
    if (typeof c === 'string') return c;
    const a = this.pl.apps.get(c.app);
    const homes = new Map<number, Citizen[]>(), done = new Set(c.doors);
    for (const id of a?.roll ?? []) {
      const z = this.w.citizens.get(id);
      if (!z || z.mig || done.has(z.hh)) continue;
      let l = homes.get(z.hh);
      if (!l) homes.set(z.hh, l = []);
      l.push(z);
    }
    const order = [...homes.keys()].sort((x, y) => hash2(x, c.id * 7 + 1) - hash2(y, c.id * 7 + 1) || x - y);
    const take = order.slice(0, n > 0 ? Math.floor(n) : order.length);
    if (!take.length) return 'Every household on the roll has had your leaflet';
    const cost = take.length * CAMPAIGN.leafletCost;
    const why = this.guard(p, a, c.side, cost);
    if (why) return why;
    this.charge(p, a!, c.side, cost);
    let people = 0;
    for (const hh of take) {
      c.doors.push(hh);
      for (const z of homes.get(hh)!) { this.apply(c, a!, z, CAMPAIGN.leafletStrength, 1); people++; }
    }
    this.stats.leaflets += take.length;
    return { households: take.length, people, cost };
  }

  /**
   * A public meeting about the plan: the first campaign to ask hires a hall near the zone (a marquee when none is within
   * CAMPAIGN.hallReach) for the evening before the vote; later campaigns (either side) speak at it for less.
   */
  meeting(p: Player, campId: number): string | Meeting {
    const c = this.camp(p, campId);
    if (typeof c === 'string') return c;
    const a = this.pl.apps.get(c.app);
    const m = this.meetings.get(c.app);
    if (m && !m.done) {
      if (m.speakers.includes(c.id)) return 'That campaign already speaks at the meeting';
      const why = this.guard(p, a, c.side, CAMPAIGN.speakCost);
      if (why) return why;
      this.charge(p, a!, c.side, CAMPAIGN.speakCost);
      m.speakers.push(c.id);
      this.pl.changed = true;
      return m;
    }
    if (m?.done) return 'The public meeting on this plan has been held';
    if (!a) return 'That application is not open to campaigning';
    const now = this.w.tick, day0 = Math.floor(now / TICKS_PER_DAY) * TICKS_PER_DAY;
    let at = day0 + CAMPAIGN.meetingHour * TICKS_PER_HOUR;
    if (at < now + TICKS_PER_HOUR / 2) at += TICKS_PER_DAY;
    if (at > a.ends - TICKS_PER_HOUR) at = a.ends - TICKS_PER_HOUR; // an earlier meeting when the vote comes first
    if (at < now + TICKS_PER_HOUR / 4) return 'Too late to call a public meeting before the vote';
    const hall = this.hallNear(a);
    const cost = hall ? CAMPAIGN.meetingCost : CAMPAIGN.marqueeCost;
    const why = this.guard(p, a, c.side, cost);
    if (why) return why;
    this.charge(p, a, c.side, cost);
    const [zx, zy] = this.zoneCentre(a), [hx, hy] = hall ? [hall.x, hall.y] : [Math.round(zx), Math.round(zy)];
    const nm: Meeting = { app: a.id, at, x: hx, y: hy, hall: hall ? hall.name : `a marquee in ${this.placeOf(a)}`, speakers: [c.id] };
    this.meetings.set(a.id, nm);
    this.stats.meetings++;
    this.pl.changed = true;
    const msg = `${this.name(p.id)} has called a public meeting on ${this.what(a)} at ${nm.hall}, ${this.clock(at)}: speak there in the Planning panel`;
    for (const o of new Set([a.by, ...a.affected])) if (o !== p.id) this.notices.push({ owner: o, msg });
    return nm;
  }

  /** A day of evening TV spots on the city channels (or until the vote). */
  tv(p: Player, campId: number): string | number {
    const c = this.camp(p, campId);
    if (typeof c === 'string') return c;
    const a = this.pl.apps.get(c.app);
    if (c.tvUntil && c.tvUntil > this.w.tick) return 'That campaign is already on TV';
    const why = this.guard(p, a, c.side, CAMPAIGN.tvCost);
    if (why) return why;
    this.charge(p, a!, c.side, CAMPAIGN.tvCost);
    c.tvUntil = Math.min(a!.ends, this.w.tick + TICKS_PER_DAY);
    this.pl.changed = true;
    return c.tvUntil;
  }

  /** End a campaign: its posters come down (money spent stays spent). */
  end(p: Player, campId: number): string | null {
    const c = this.camp(p, campId);
    if (typeof c === 'string') return c;
    this.dropCamp(c);
    this.pl.changed = true;
    return null;
  }

  /** Fly-post a campaign of `p`'s over someone else's poster (CAMPAIGN.flyCost; CAMPAIGN.flyPerDay a day). */
  flyPost(p: Player, campaign: number, slot: [number, number, number]): string | string {
    if (!Array.isArray(slot) || slot.length !== 3 || !slot.every(Number.isInteger)) return 'Click a poster';
    if (this.flyDay !== this.w.day) { this.flyDay = this.w.day; this.flyToday.clear(); }
    const n = this.flyToday.get(p.id) ?? 0;
    if (n >= CAMPAIGN.flyPerDay) return `You may fly-post ${CAMPAIGN.flyPerDay} times a day`;
    if (p.admin) return 'In administration: advertising is stopped';
    if (spendableMoney(p.money, p.devUnlimited) < CAMPAIGN.flyCost) return `Fly-posting costs ${money(CAMPAIGN.flyCost)}`;
    const own = this.camps.get(Number(campaign)), a = own && this.pl.apps.get(own.app);
    if (own && a) { const why = this.guard(p, a, own.side, CAMPAIGN.flyCost); if (why) return why; }
    const r = this.ads.flyPost(p, Number(campaign), slot[0], slot[1], slot[2]);
    if (typeof r === 'string') return r;
    this.flyToday.set(p.id, n + 1);
    if (own && a) this.charge(p, a, own.side, CAMPAIGN.flyCost); else this.w.credit(p.id, -CAMPAIGN.flyCost, 'ads');
    return '';
  }

  // ---- the hour --------------------------------------------------------------------------------------------------

  /** Each tick: meetings that are due; once a game hour the reach pass, fly-posts found, claims judged, area claims checked. */
  tick() {
    const now = this.w.tick;
    for (const m of this.meetings.values()) if (!m.done && now >= m.at) this.hold(m);
    const pass = Math.floor(now / CAMPAIGN.passTicks);
    if (pass === this.lastPass) return;
    this.lastPass = pass;
    this.reach();
    this.findFlyPosts(pass);
    this.judge();
    this.areaPass();
  }

  /** The reach pass: posters on the roll's routes and TV spots, for each open application with campaigns. */
  reach() {
    const now = this.w.tick, byApp = new Map<number, PlanCamp[]>();
    for (const c of this.camps.values()) { const l = byApp.get(c.app); if (l) l.push(c); else byApp.set(c.app, [c]); }
    for (const [appId, camps] of byApp) {
      const a = this.pl.apps.get(appId);
      if (!a || a.status !== 'open') continue;
      const ids = new Set(camps.map((c) => c.id));
      const posters = this.ads.postersOf(ids);
      const onTv = camps.filter((c) => (c.tvUntil ?? 0) > now);
      if (!posters.length && !onTv.length) continue;
      const R = CAMPAIGN.seeReach;
      for (const id of a.roll) {
        const z = this.w.citizens.get(id);
        if (!z || z.mig) continue;
        const route = this.routeOf(z);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < route.length; i += 2) { x0 = Math.min(x0, route[i]); x1 = Math.max(x1, route[i]); y0 = Math.min(y0, route[i + 1]); y1 = Math.max(y1, route[i + 1]); }
        for (const c of camps) {
          let dose = 0, n = 0;
          for (const ps of posters) {
            if (ps.c !== c.id || n >= CAMPAIGN.seenPerPass) continue;
            if (ps.x < x0 - R || ps.x > x1 + R + 1 || ps.y < y0 - R || ps.y > y1 + R + 1) continue;
            let seen = false;
            for (let i = 0; i < route.length && !seen; i += 2) seen = Math.abs(route[i] + 0.5 - ps.x) <= R + 0.5 && Math.abs(route[i + 1] + 0.5 - ps.y) <= R + 0.5;
            if (!seen) continue;
            dose += (CAMPAIGN.strength[ps.size] ?? 0.25) * posterCondition(ps.wear);
            n++;
          }
          if ((c.tvUntil ?? 0) > now && hasTv(z.hh)) dose += CAMPAIGN.tvStrength;
          if (dose) this.apply(c, a, z, dose / PASSES_PER_DAY, 1 / PASSES_PER_DAY);
        }
      }
    }
  }

  /** Where a voter passes in a day: home and the cached commute (walkers), or the straight line to work (drivers). */
  private routeOf(z: Citizen): number[] {
    const out = [z.hx, z.hy];
    if (z.commute && z.commute.length) { for (let i = 0; i < z.commute.length; i += 2) out.push(z.commute[i], z.commute[i + 1]); return out; }
    if (z.job && (z.wx || z.wy)) {
      const d = Math.max(Math.abs(z.wx - z.hx), Math.abs(z.wy - z.hy)), steps = Math.min(200, Math.ceil(d / 2));
      for (let s = 1; s <= steps; s++) out.push(Math.round(z.hx + ((z.wx - z.hx) * s) / steps), Math.round(z.hy + ((z.wy - z.hy) * s) / steps));
    }
    return out;
  }

  /**
   * One nudge of campaign `c` on voter `z`: `dose` × susceptibility × the voter's weight on the claim's value × freshness
   * × credibility; `exposure` days are added to what this voter has seen of it. Belief toward the campaign's side
   * (contrarians the other way), or, for a turnout claim, turnout among those leaning that way. Returns the nudge.
   */
  private apply(c: PlanCamp, a: PlanApp, z: Citizen, dose: number, exposure: number): number {
    let m = this.seen.get(c.id);
    if (!m) this.seen.set(c.id, m = new Map());
    const s = m.get(z.id) ?? 0;
    m.set(z.id, s + exposure);
    const cl = PLAN_CLAIMS[c.claim];
    this.sim.motive.weightsOf(z, this.wbuf);
    const vw = clamp(VALUE_COUNT * this.wbuf[cl.value], 0.3, 2.5);
    const eff = dose * susceptibility(z.id) * vw * (1 / (1 + s)) * this.credOf(c.owner, a.x, a.y);
    if (isTurnoutClaim(c.claim)) { if (!isContrarian(z.id)) this.pl.boostTurnout(a.id, z.id, c.side, eff); }
    else this.pl.believe(a.id, z.id, this.pl.beliefOf(a.id, z.id) + c.side * eff * (isContrarian(z.id) ? -1 : 1));
    let r = this.reachedBy.get(c.id);
    if (!r) this.reachedBy.set(c.id, r = new Set());
    if (!r.has(z.id)) { r.add(z.id); c.reached++; }
    c.moved += Math.abs(eff);
    return eff;
  }

  /** Hold a meeting: residents on the roll come by chance; each side speaking nudges them, the truer side more when both speak. */
  private hold(m: Meeting) {
    m.done = true;
    this.pl.changed = true;
    const a = this.pl.apps.get(m.app);
    if (!a || a.status !== 'open') return;
    const speakers = m.speakers.map((id) => this.camps.get(id)).filter((c): c is PlanCamp => !!c);
    const contested = speakers.some((c) => c.side > 0) && speakers.some((c) => c.side < 0);
    const came: Citizen[] = [];
    for (const id of a.roll) { const z = this.w.citizens.get(id); if (z && !z.mig && hash2(id, a.id * 31 + m.at) < CAMPAIGN.meetingAttend) came.push(z); }
    m.came = came.length;
    for (const c of speakers) {
      const truth = this.expectedTruth(a, c.claim);
      const mult = contested ? CAMPAIGN.meetingTrueLo + CAMPAIGN.meetingTrueSpan * truth : 1;
      for (const z of came) this.apply(c, a, z, CAMPAIGN.meetingStrength * mult, 1);
    }
    const sides = contested ? 'both sides spoke' : `only the ${speakers[0]?.side > 0 ? 'For' : 'Against'} side spoke`;
    const msg = `The public meeting on ${this.what(a)} at ${m.hall}: ${came.length} of ${a.roll.length} residents on the roll came; ${sides}`;
    for (const o of new Set([a.by, ...a.affected])) this.notices.push({ owner: o, msg });
  }

  /** How true a claim about plan `a` is expected to be (0-1): the plan's impact on the roll's homes, before it is built. */
  expectedTruth(a: PlanApp, claim: number): number {
    const cl = PLAN_CLAIMS[claim];
    if (!cl || cl.test === null) return 0.5;
    const facts = { built: true, offer: a.offer > 0, amended: !!a.amended };
    if (cl.kind === null) return claimTruth(cl, 0, facts);
    const imp = this.pl.impactOf(a);
    let sum = 0, n = 0;
    const base = new Float64Array(VALUE_KIND_COUNT), after = new Float64Array(VALUE_KIND_COUNT);
    for (const id of a.roll) {
      const z = this.w.citizens.get(id);
      if (!z) continue;
      const add = imp ? planAt(imp, z.hx, z.hy) : undefined;
      n++;
      if (!add) continue;
      if (cl.kind !== PRICE_KIND) { sum += add[cl.kind] ?? 0; continue; }
      const cell = this.sim.value.cellAt(z.hx, z.hy);
      for (let k = 0; k < VALUE_KIND_COUNT; k++) base[k] = cell ? cell.b[cell.off + k] : 0;
      withPlan(base, 0, add, after);
      sum += 1 - combineValue(after, 0, AVERAGE_VALUE_WEIGHTS) / Math.max(1e-6, combineValue(base, 0, AVERAGE_VALUE_WEIGHTS));
    }
    return claimTruth(cl, n ? sum / n : 0, facts);
  }

  /** Fly-posts are found now and then: the renter's poster shows again; over a planning poster during a notice it costs credibility. */
  private findFlyPosts(pass: number) {
    for (const f of this.ads.flyPosts()) {
      if (hash2(f.x * 31 + f.i * 7, f.y * 17 + pass) >= CAMPAIGN.flyFind) continue;
      const by = this.ads.campaign(f.c)?.owner, under = this.ads.campaign(f.o);
      this.ads.unfly(f.x, f.y, f.i);
      this.stats.flyFound++;
      const pc = this.camps.get(f.o), a = pc && this.pl.apps.get(pc.app);
      if (by && a && a.status === 'open') {
        this.setCred(by, a.x, a.y, this.credOf(by, a.x, a.y) - CAMPAIGN.credFly);
        this.notices.push({ owner: by, msg: `Your fly-post over a planning poster near (${f.x}, ${f.y}) was found and torn down: residents think less of you here (credibility ${this.credOf(by, a.x, a.y).toFixed(2)})` });
      }
      if (under) this.notices.push({ owner: under.owner, msg: `Someone fly-posted over your poster "${under.text}" near (${f.x}, ${f.y}); it has been put right` });
    }
  }

  // ---- after the vote ----------------------------------------------------------------------------------------------

  /** An application closed: its campaigns end; an approved plan's claims wait to be judged against the truth. */
  private closed(a: PlanApp) {
    const camps = [...this.camps.values()].filter((c) => c.app === a.id);
    if (a.status === 'approved' && a.kind === 'build' && a.bk !== undefined) {
      const claims = camps.filter((c) => PLAN_CLAIMS[c.claim].test !== null).map((c) => ({ owner: c.owner, claim: c.claim, side: c.side, text: this.ads.campaign(c.id)?.text ?? '', reached: c.reached }));
      if (claims.length) {
        const cells = new Set<string>(), list: number[] = [];
        for (const id of a.roll) {
          const z = this.w.citizens.get(id);
          if (!z) continue;
          const cx = Math.floor(z.hx / VALUE_CELL), cy = Math.floor(z.hy / VALUE_CELL), k = `${cx},${cy}`;
          if (!cells.has(k)) { cells.add(k); list.push(cx, cy); }
        }
        this.watches.push({ app: a.id, by: a.by, what: this.what(a), x: a.x, y: a.y, bk: a.bk, cells: list, base: this.means(list), due: this.w.tick + CAMPAIGN.truthAfter, roll: a.roll.length, offer: a.offer > 0, amended: !!a.amended, claims });
      }
    }
    for (const c of camps) this.dropCamp(c);
    this.meetings.delete(a.id);
    this.spent.delete(a.id);
  }
  private dropCamp(c: PlanCamp) {
    this.ads.drop(c.id);
    this.camps.delete(c.id);
    this.seen.delete(c.id);
    this.reachedBy.delete(c.id);
  }
  /** The mean of each kind (bytes 0-255) over cells (cell x, cell y pairs) as the field has them now. */
  private means(cells: number[]): number[] {
    const out = new Array(VALUE_KIND_COUNT).fill(0);
    let n = 0;
    for (let i = 0; i < cells.length; i += 2) {
      const c = this.sim.value.cellAt(cells[i] * VALUE_CELL, cells[i + 1] * VALUE_CELL);
      n++;
      if (c) for (let k = 0; k < VALUE_KIND_COUNT; k++) out[k] += c.b[c.off + k];
    }
    if (n) for (let k = 0; k < VALUE_KIND_COUNT; k++) out[k] /= n;
    return out;
  }

  /** Claims of approved plans that have stood long enough: judged against the field over the zone's homes. */
  private judge() {
    const now = this.w.tick;
    this.watches = this.watches.filter((wt) => {
      if (now < wt.due) return true;
      const key = tileKey(wt.x, wt.y), b = this.w.buildings.get(key);
      const stands = !!b && b.id === wt.bk;
      if (stands && this.w.sites.has(key) && (wt.tries ?? 0) < 3) { wt.tries = (wt.tries ?? 0) + 1; wt.due = now + TICKS_PER_DAY; return true; } // still being built: wait
      const built = stands && !this.w.sites.has(key);
      const nowM = this.means(wt.cells);
      for (const cl of wt.claims) {
        const pc = PLAN_CLAIMS[cl.claim];
        let change = 0;
        if (pc.kind === PRICE_KIND) change = 1 - combineValue(nowM, 0, AVERAGE_VALUE_WEIGHTS) / Math.max(1e-6, combineValue(wt.base, 0, AVERAGE_VALUE_WEIGHTS));
        else if (pc.kind !== null) change = (nowM[pc.kind] - wt.base[pc.kind]) / 255;
        if (pc.kind !== null && pc.test !== 'built' && pc.test !== 'offer' && !built) continue; // nothing to live with: nothing learnt
        const truth = claimTruth(pc, change, { built, offer: wt.offer, amended: wt.amended });
        const ok = truth >= 0.5, weight = 0.5 + 0.5 * Math.min(1, cl.reached / Math.max(1, wt.roll));
        const before = this.credOf(cl.owner, wt.x, wt.y);
        this.setCred(cl.owner, wt.x, wt.y, before + (ok ? CAMPAIGN.credGain : -CAMPAIGN.credLoss) * weight);
        const after = this.credOf(cl.owner, wt.x, wt.y);
        this.stats.judged++;
        if (ok) this.stats.borne++; else this.stats.false++;
        this.notices.push({ owner: cl.owner, msg: ok
          ? `Residents near the ${wt.what.replace(/^an? /, '')} found "${cl.text}" true: your word counts for more here (credibility ${after.toFixed(2)})`
          : `Residents near the ${wt.what.replace(/^an? /, '')} found "${cl.text}" false: your next campaign here starts weaker (credibility ${after.toFixed(2)})` });
      }
      return false;
    });
  }

  // ---- area claims (claims about a parcel) -----------------------------------------------------------------------

  /** Whether area claim `claim` is true of parcel `parcel` now: the mean of its kind over the parcel's cells. */
  areaTrue(parcel: number, claim: number): boolean {
    const q = this.w.parcels.get(parcel), cl = AD_CLAIMS[claim];
    if (!q || !cl || cl.kind === undefined) return false;
    let sum = 0, n = 0;
    for (let y = q.y; y < q.y + q.h; y += VALUE_CELL) for (let x = q.x; x < q.x + q.w; x += VALUE_CELL) { sum += this.sim.value.kindAt(x, y, cl.kind); n++; }
    const v = n ? sum / n : 0;
    return cl.high ? v >= CAMPAIGN.areaHigh : v <= CAMPAIGN.areaLow;
  }
  /**
   * Once a game hour: area claims about someone else's land that have become false come down and their maker is fined
   * (paid to the land's owner); an area claim's posters build the parcel's reputation (good or bad), which fades back.
   * Once a game day an overhyped claim about one's own land costs a little credibility.
   */
  private areaPass() {
    const fade = Math.pow(0.5, 1 / (CAMPAIGN.areaHalfLife * PASSES_PER_DAY));
    for (const [k, v] of this.rep) { const nv = v * fade; if (Math.abs(nv) < 1e-3) this.rep.delete(k); else this.rep.set(k, nv); }
    const daily = this.w.tick % TICKS_PER_DAY < CAMPAIGN.passTicks;
    for (const c of this.ads.campaignList()) {
      if (!isAreaClaim(c.claim) || c.target?.kind !== 'parcel') continue;
      const q = this.w.parcels.get(c.target.id);
      if (!q) continue;
      const cl = AD_CLAIMS[c.claim], truth = this.areaTrue(q.id, c.claim);
      if (q.owner !== c.owner && !truth) {
        this.ads.drop(c.id);
        const fine = CAMPAIGN.falseFine;
        if (this.w.players.has(q.owner)) this.w.transfer(c.owner, q.owner, fine, 'ads'); else this.w.credit(c.owner, -fine, 'ads');
        this.stats.takenDown++;
        this.notices.push({ owner: c.owner, msg: `"${c.text}" is no longer true of ${q.name}: your posters were taken down and you are fined ${money(fine)}, paid to ${this.name(q.owner)}` });
        this.notices.push({ owner: q.owner, msg: `${this.name(c.owner)}'s posters saying "${c.text}" were no longer true and came down: ${money(fine)} paid to you` });
        continue;
      }
      const n = this.ads.postersCount(c.id);
      if (n) this.rep.set(q.id, clamp((this.rep.get(q.id) ?? 0) + ((cl.good ? 1 : -1) * CAMPAIGN.areaPerPoster * Math.min(6, n)) / PASSES_PER_DAY, -1, 1));
      if (daily && n && q.owner === c.owner && !truth) {
        const cx = q.x + (q.w >> 1), cy = q.y + (q.h >> 1);
        this.setCred(c.owner, cx, cy, this.credOf(c.owner, cx, cy) - CAMPAIGN.credLoss / 4);
        this.notices.push({ owner: c.owner, msg: `Newcomers to ${q.name} find "${c.text}" overhyped: your credibility there falls (${this.credOf(c.owner, cx, cy).toFixed(2)})` });
      }
    }
  }
  /** The area-opinion term of homeScore at a home tile: the parcel's reputation (belief, short run) × CAMPAIGN.areaTerm. */
  repAt(x: number, y: number): number {
    if (!this.rep.size) return 0;
    const pid = this.w.parcelIdAt(x, y);
    return pid ? CAMPAIGN.areaTerm * (this.rep.get(pid) ?? 0) : 0;
  }
  reputation(parcel: number): number { return this.rep.get(parcel) ?? 0; }

  // ---- words, the panel, saving --------------------------------------------------------------------------------

  private name(id: string) { return id === 'sys' ? 'the Commons' : this.w.players.get(id)?.name ?? id; }
  private what(a: PlanApp) { const g = a.bk !== undefined ? planningSourceOf(a.bk)?.name ?? KIND_NAMES[a.bk] : 'plan'; return `${/^[aeiou]/.test(g) ? 'an' : 'a'} ${g}`; }
  private clock(t: number) { const h = Math.floor((t % TICKS_PER_DAY) / TICKS_PER_HOUR); return `${String(h).padStart(2, '0')}:00 on day ${Math.floor(t / TICKS_PER_DAY) + 1}`; }
  private dayWords(t: number) { return this.clock(t); }
  /** The name of the parcel where most of the roll lives (the neighbourhood the plan is about). */
  private placeOf(a: PlanApp): string {
    const n = new Map<number, number>();
    for (const id of a.roll) { const z = this.w.citizens.get(id); const pid = z ? this.w.parcelIdAt(z.hx, z.hy) : 0; if (pid) n.set(pid, (n.get(pid) ?? 0) + 1); }
    let best = 0, bn = 0;
    for (const [pid, k] of n) if (k > bn || (k === bn && pid < best)) { best = pid; bn = k; }
    return this.w.parcels.get(best)?.name ?? 'the neighbourhood';
  }
  /** The nearest hall to hire (a shop, office or civic building, not a home, works or nuisance site) within reach of the zone. */
  private zoneCentre(a: PlanApp): [number, number] {
    let sx = 0, sy = 0, n = 0;
    for (const id of a.roll) { const z = this.w.citizens.get(id); if (z) { sx += z.hx; sy += z.hy; n++; } }
    return n ? [sx / n, sy / n] : [a.x, a.y];
  }
  private hallNear(a: PlanApp): { x: number; y: number; name: string } | null {
    const [cx, cy] = this.zoneCentre(a), R = CAMPAIGN.hallReach;
    let best: { x: number; y: number; name: string } | null = null, bd = Infinity;
    for (const b of this.w.buildings.values()) {
      if (b.level <= 0 || b.zone === Zone.Residential || b.zone === Zone.Industrial || b.zone === Zone.None || b.zone === Zone.Parking || b.zone === Zone.Yard || b.zone === Zone.Hub || b.id === BUS_STOP_KIND || planningSourceOf(b.id)) continue;
      const d = Math.max(Math.abs(b.x - cx), Math.abs(b.y - cy));
      if (d > R || this.w.sites.has(tileKey(b.x, b.y))) continue;
      if (d < bd || (d === bd && best && (b.x < best.x || (b.x === best.x && b.y < best.y)))) { bd = d; best = { x: b.x, y: b.y, name: `the ${KIND_NAMES[b.id] ?? 'hall'} at (${b.x}, ${b.y})` }; }
    }
    return best;
  }

  /** Campaigns on an application, for the panel and the probe. */
  campsOf(app: number): Readonly<PlanCamp>[] { return [...this.camps.values()].filter((c) => c.app === app); }
  meetingOf(app: number): Readonly<Meeting> | undefined { return this.meetings.get(app); }
  watching(): Readonly<Watch>[] { return this.watches; }

  dtoOf(a: PlanApp): PlanCampaignsDTO | undefined {
    if (a.status !== 'open' || a.kind === 'closure' || !this.pl.on) return undefined;
    const campaigns: PlanCampaignDTO[] = this.campsOf(a.id).map((c) => ({
      id: c.id, owner: c.owner, side: c.side, claim: c.claim, text: this.ads.campaign(c.id)?.text ?? '',
      posters: this.ads.postersCount(c.id), ...(c.tvUntil && c.tvUntil > this.w.tick ? { tv: c.tvUntil } : {}), leaflets: c.doors.length, reached: c.reached,
    }));
    const m = this.meetings.get(a.id);
    const cred: Record<string, number> = {};
    for (const o of new Set([a.by, ...a.affected])) cred[o] = Math.round(this.credOf(o, a.x, a.y) * 100) / 100;
    return {
      campaigns, spent: [...this.spentOf(a)] as [number, number], cap: this.capOf(a), cred,
      ...(m ? { meeting: { at: m.at, x: m.x, y: m.y, hall: m.hall, speakers: [...m.speakers], ...(m.done ? { done: true } : {}) } } : {}),
      ...(CAMPAIGN.lastHourOn ? { closesAt: a.ends - CAMPAIGN.lastTicks } : {}),
    };
  }

  private save(): CampaignsSave | null {
    if (!this.camps.size && !this.meetings.size && !this.cred.size && !this.watches.length && !this.rep.size && !this.spent.size) return null;
    return {
      camps: [...this.camps.values()].map((c) => ({ ...c, doors: [...c.doors] })),
      meetings: [...this.meetings.values()].map((m) => ({ ...m, speakers: [...m.speakers] })),
      spent: [...this.spent].map(([k, v]) => [k, v[0], v[1]]),
      cred: [...this.cred].map(([k, v]) => { const [p, sx, sy] = k.split('|'); return [p, Number(sx), Number(sy), Math.round(v * 1000)] as [string, number, number, number]; }),
      watches: this.watches.map((wt) => ({ ...wt, cells: [...wt.cells], base: [...wt.base], claims: wt.claims.map((c) => ({ ...c })) })),
      ...(this.rep.size ? { rep: [...this.rep].map(([k, v]) => [k, Math.round(v * 1000)] as [number, number]) } : {}),
    };
  }
}
