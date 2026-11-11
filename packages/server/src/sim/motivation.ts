import {
  LifeStage, Zone, CitizenState, TICKS_PER_DAY, TICKS_PER_HOUR, VALUE_COUNT, Value, MOTIVE, ARCHETYPES, capacityOf, hash2, tileKey, isCivicId, isUtilityKind, familyOf, OCCUPATIONS, wageOf, wageMul, skillNeed,
  valuesOf, packWeights, archetypeBlend, jitterValues, seededValues, describeValues, type FocusInfo, VALUE, valueWeights,
} from '@msimcity/shared';
import type { Building, Citizen, World } from '../world';
import { ageOf } from './life';
import { Place } from './skills';
import { env } from '../env';
import { VALUE_FIELD } from './value';

/**
 * Motivation M1-M2 (docs/motivation.md): citizens' values and the decisions they score with them.
 *
 * - **Values** (M1) are stored per citizen as six 0-15 integers packed into `Citizen.vals` (shared/src/motivation.ts).
 *   Incomers are seeded from hashed archetypes pulled toward the people already living on their parcel (`seed`),
 *   children inherit their parents' with a share of their own (`inheritValues`), and old saves derive them from the id
 *   on load (snapshot.ts). Life reshapes them at a decision (`weightsOf`: a child at home, a partner, being out of work,
 *   age), without storing anything. They bend the parts of happiness (`bend`), name a citizen in the panel
 *   (`describe`), and add up per parcel for Focus groups (`focus`).
 * - **Decisions** (M2): the job search scores a few vacancies by wage (Money), place and building (Status), commute
 *   (Time) and friends there (Roots) (`pickJob`); a grown child moving out, and a household moving of its own accord,
 *   score homes (`homeScore`); a night out weighs distance, events and tickets by Adventure and Money (`leisure`). Once
 *   a game day (`daily`, one call from Simulation.lifeStep) an employed adult may look for a better job and a household
 *   may look for a better home, both slow (Rich's 2a: under 1% a day).
 *
 * `MOTIVE=0` in the environment turns it all off: every decision is as before (the first vacancy, a near and random
 * home, the old leisure score, unbent happiness), the A/B control for loadtest/motivation.ts. Values are still seeded,
 * so a save keeps them either way.
 */
const PARTS = env('MOTIVE_PARTS')?.split(',');
/** the parts, for A/B runs (MOTIVE_PARTS=jobs,homes,leisure,bend,daily,school: only those): all of them by default */
const part = (k: string) => !PARTS || PARTS.includes(k);
export const MOTIVATION = { on: env('MOTIVE') !== '0', jobs: part('jobs'), homes: part('homes'), leisure: part('leisure'), bend: part('bend'), daily: part('daily'), school: part('school') };

const DAY_TICKS = TICKS_PER_DAY;

/** What the daily decisions need from the simulation (closures over its private steps, as FirstFiveDeps). */
export interface MotiveHost {
  /** scored vacancies from c's home: the chosen one's building and path, or null; `except` is never offered */
  bestJob(c: Citizen, except?: Building): { b: Building; path: number[]; place: number } | null;
  /** may c change job of their own accord now (a plain worker: no road job, apprenticeship or site) */
  canSwitch(c: Citizen): boolean;
  /** c leaves their job and takes a place at b, with this walking route */
  switchJob(c: Citizen, b: Building, path: number[]): void;
  /** may c take a place at b now (room, and the skill gate), and the road from c's home to it */
  canTake(c: Citizen, b: Building): boolean;
  pathTo(c: Citizen, b: Building): number[] | null;
  /** services in reach of a tile (0-3) and parks' leisure value there */
  cover(x: number, y: number): number;
  parks(x: number, y: number): number;
  /** c (at home) moves to home b into household hh */
  moveHome(c: Citizen, b: Building, hh: number): void;
  /** may a household move into b (road access, not the camp) */
  homeOk(b: Building): boolean;
  /** the neighbourhood value at a tile for these kind weights (sim/value.ts; 1 where nothing is near) */
  value?(x: number, y: number, weights: ArrayLike<number>): number;
}

/** One job candidate's facts, for scoring against the others. */
interface JobFacts { wage: number; status: number; steps: number; friend: boolean; kind: number; essential: boolean }

/**
 * Builders' yards, public services (police, fire, health, schools, libraries) and utilities (plants, nodes, the depot):
 * the jobs a town cannot do without.
 * When one is the nearest vacancy it is taken as before motivation, and its staff do not leave it for a better job, so
 * scoring never starves the crews that build the town or the stations that cover it (the first-hours guard).
 */
export const essentialJob = (kind: number) => isCivicId(kind) || isUtilityKind(kind) || familyOf(kind) === Zone.Yard;

export class Motivation {
  /** parcel id -> residents and the sum of their stored weights, re-counted once a game day on first use */
  private area = new Map<number, { ids: number[]; s: number[] }>();
  private areaDay = -1;
  /** citizens in town when the area count was made: it is made again once the town has grown by a quarter (a fill) */
  private areaPop = 0;
  /** game day of each citizen's last move or job change of their own accord (not saved: one early look after a load at most) */
  private settledDay = new Map<number, number>();
  private wbuf = new Array(VALUE_COUNT).fill(0);
  /** since the simulation started (probes, the demo check) */
  stats = {
    seeded: 0, byArea: 0, inherited: 0, scoredJobs: 0, notFirst: 0,
    jobLooks: 0, jobSwitches: 0, recruited: 0, homeLooks: 0, moves: 0, movedPeople: 0, scoredHomes: 0,
  };
  /** the most recent self-initiated changes, for the showcase and the probe: [day, citizen id, what] */
  log: [number, number, string][] = [];
  /** citizen id -> [day, what] of their latest such change, oldest first (pruned past settleDays) */
  private recent = new Map<number, [number, string]>();

  constructor(private w: World) {}

  // ---- values (M1) -------------------------------------------------------------------------------

  /** An incomer's values: the archetype blend pulled toward their new parcel's residents, then the jitter. */
  seed(id: number, home: Building | undefined): number {
    this.stats.seeded++;
    const blend = archetypeBlend(id);
    const a = home ? this.areaOf(this.w.parcelIdAt(home.x, home.y)) : undefined;
    if (a && a.ids.length >= MOTIVE.areaMin) {
      this.stats.byArea++;
      let sum = 0;
      for (const x of a.s) sum += x;
      for (let i = 0; i < VALUE_COUNT; i++) blend[i] = (1 - MOTIVE.areaPull) * blend[i] + MOTIVE.areaPull * (a.s[i] / sum);
    }
    return packWeights(jitterValues(id, blend));
  }

  /** The residents of a parcel and their summed weights, as of today's count. */
  private areaOf(pid: number) {
    if (pid < 0) return undefined;
    const day = Math.floor(this.w.tick / DAY_TICKS);
    if (day !== this.areaDay || this.w.citizens.size > 1.25 * this.areaPop + 8) {
      this.areaDay = day; this.areaPop = this.w.citizens.size;
      this.area.clear();
      const parcelOfHome = new Map<number, number>();
      const wts = this.wbuf;
      for (const c of this.w.citizens.values()) {
        if (c.mig || !c.vals) continue;
        const hk = c.hx * 65536 + c.hy;
        let p = parcelOfHome.get(hk);
        if (p === undefined) { p = this.w.parcelIdAt(c.hx, c.hy); parcelOfHome.set(hk, p); }
        if (p < 0) continue;
        let e = this.area.get(p);
        if (!e) this.area.set(p, (e = { ids: [], s: new Array(VALUE_COUNT).fill(0) }));
        e.ids.push(c.id);
        valuesOf(c.vals, wts);
        for (let i = 0; i < VALUE_COUNT; i++) e.s[i] += wts[i];
      }
    }
    return this.area.get(pid);
  }

  /**
   * Weights as life has reshaped them today (docs/motivation.md section 3): the stored values times multipliers for a
   * child at home, a partner, being out of work or short of money, a recent degree, youth, age and retirement,
   * renormalised. Into `out` (a fresh array when not given).
   */
  weightsOf(c: Citizen, out: number[] = new Array(VALUE_COUNT)): number[] {
    const w = valuesOf(c.vals || seededValues(c.id), out);
    const tick = this.w.tick, age = ageOf(c, tick);
    if (c.stage !== LifeStage.Child) {
      const hh = this.w.households.get(c.hh);
      if (hh && hh.ids.length > 1) for (const id of hh.ids) {
        const k = this.w.citizens.get(id);
        if (k && k.stage === LifeStage.Child && k.par && (k.par === c.id || k.par === c.partner)) { w[Value.Family] *= 2.2; w[Value.Adventure] *= 0.5; break; }
      }
      if (c.partner) { w[Value.Family] *= 1.4; w[Value.Roots] *= 1.2; }
      if (c.stage === LifeStage.Adult && (!c.job && !c.study || c.money < 60)) w[Value.Money] *= 1.8;
      if (c.grad !== undefined && tick / DAY_TICKS - c.grad < 7) { w[Value.Status] *= 1.5; w[Value.Adventure] *= 1.4; }
    }
    if (age >= 18 && age < 25) { w[Value.Adventure] *= 1.5; w[Value.Roots] *= 0.7; }
    if (age >= 50) { w[Value.Roots] *= 1.5; w[Value.Time] *= 1.3; w[Value.Adventure] *= 0.4; }
    if (c.stage === LifeStage.Retired) { w[Value.Money] *= 0.4; w[Value.Status] *= 0.3; w[Value.Roots] *= 1.6; }
    let sum = 0;
    for (let i = 0; i < VALUE_COUNT; i++) sum += w[i];
    for (let i = 0; i < VALUE_COUNT; i++) w[i] /= sum;
    return w;
  }

  /** Happiness multipliers per value (life.ts happinessParts): a weight of 1/6 is neutral; undefined when off. */
  bend(c: Citizen): number[] | undefined {
    if (!MOTIVATION.on || !MOTIVATION.bend) return undefined;
    const w = this.weightsOf(c);
    for (let i = 0; i < VALUE_COUNT; i++) w[i] = Math.max(MOTIVE.bendLo, Math.min(MOTIVE.bendHi, 1 + MOTIVE.bend * (6 * w[i] - 1)));
    return w;
  }

  /** The citizen panel's line: "Cares most about family; restless". */
  describe(c: Citizen): string { return describeValues(this.weightsOf(c)); }

  /**
   * Focus groups (Culture tier 2): the grown-ups living on a parcel now and their value mix in whole percentages.
   * O(citizens), with one parcel lookup per home, like the other tooltips (Simulation.describe).
   */
  focus(pid: number, name: string): FocusInfo {
    const s = new Array(VALUE_COUNT).fill(0), wts = this.wbuf, homes = new Map<number, boolean>();
    let people = 0;
    for (const c of this.w.citizens.values()) {
      if (c.stage === LifeStage.Child || c.mig) continue;
      const hk = c.hx * 65536 + c.hy;
      let here = homes.get(hk);
      if (here === undefined) { here = this.w.parcelIdAt(c.hx, c.hy) === pid; homes.set(hk, here); }
      if (!here) continue;
      this.weightsOf(c, wts);
      for (let i = 0; i < VALUE_COUNT; i++) s[i] += wts[i];
      people++;
    }
    return { parcel: name, people, pct: people ? roundPct(s) : s };
  }

  // ---- decisions (M2) ----------------------------------------------------------------------------

  /** A job candidate's facts: the wage the place would pay c, its status, the commute and whether a friend works there. */
  jobFacts(c: Citizen, b: Building, steps: number, place: number): JobFacts {
    const skill = place === Place.Skilled ? skillNeed(b.id, b.level) : 0;
    const wage = wageOf(b.id, b.level) * wageMul({ edu: c.edu, track: c.track, skill }, b.id);
    let friend = false;
    for (const id of c.friends) { const f = this.w.citizens.get(id); if (f && f.job && f.wx === b.x && f.wy === b.y) { friend = true; break; } }
    return { wage, status: (skill ? 0.6 : 0) + 0.4 * Math.min(1, (b.level - 1) / 5), steps, friend, kind: b.id, essential: essentialJob(b.id) };
  }

  /**
   * The index of the best of a few job candidates (the first is the nearest), by the citizen's weights: Money reads the
   * wage against the candidates' mean, Status the place and building, Time the extra steps over the nearest, Roots a
   * friend there, Adventure a personal taste for the kind of work. Scores go in `scores` when given.
   */
  pickJob(c: Citizen, facts: JobFacts[], scores?: number[]): number {
    if (facts.length <= 1 || !MOTIVATION.on || !MOTIVATION.jobs) return 0;
    for (let i = 0; i < facts.length; i++) if (facts[i].essential) return i; // the nearest essential vacancy wins (essentialJob)
    const w = this.weightsOf(c, this.wbuf);
    let meanWage = 0, meanStatus = 0, minSteps = Infinity;
    for (const f of facts) { meanWage += f.wage; meanStatus += f.status; minSteps = Math.min(minSteps, f.steps); }
    meanWage /= facts.length; meanStatus /= facts.length;
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i];
      const sc = w[Value.Money] * clamp(4 * (f.wage - meanWage) / Math.max(1, meanWage))
        + w[Value.Status] * clamp(2 * (f.status - meanStatus))
        + w[Value.Time] * clamp(-2 * (f.steps - minSteps) / MOTIVE.jobSlack)
        + w[Value.Family] * clamp(-(f.steps - minSteps) / MOTIVE.jobSlack)
        + w[Value.Roots] * (f.friend ? 0.6 : 0)
        + w[Value.Adventure] * (hash2(c.id * 131 + f.kind, 1620) - 0.5)
        - MOTIVE.commuteCost * (f.steps - minSteps) / MOTIVE.jobSlack // nobody likes a longer trip
        + MOTIVE.noise * (2 * Math.random() - 1);
      if (scores) scores[i] = sc;
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    this.stats.scoredJobs++;
    if (best !== 0) this.stats.notFirst++;
    return best;
  }

  /**
   * How a home suits a household (docs/motivation.md section 5), relative to where they live now (whose own score is
   * the Roots of staying put): Money the parcel's tax, Family services, parks and a spare bed, Status the building,
   * Roots staying near (the old home is where friends and family are), Time the walk to work, Adventure somewhere
   * new. `d` is the Manhattan distance from the current home; `need` the beds the household takes. The neighbourhood
   * value (docs/multiplayer-land.md section 4, step 1) adds a term: the value at b against the current home's, both
   * with the household's own kind weights (shared valueWeights: a Family-minded household minds hazard and disorder).
   */
  homeScore(c: Citizen, w: readonly number[], host: MotiveHost, from: Building | undefined, b: Building, d: number, need: number): number {
    const W = this.w, R = MOTIVE.moveRadius;
    const pb = W.parcelAt(b.x, b.y), pf = from ? W.parcelAt(from.x, from.y) : undefined;
    const same = !!pb && pb === pf;
    const tax = (pb?.taxRate ?? 0) - (pf?.taxRate ?? pb?.taxRate ?? 0);
    const fam = (x: number, y: number, bb: Building | undefined) => host.cover(x, y) / 3 + (host.parks(x, y) > 0 ? 0.3 : 0)
      + (bb && capacityOf(bb.id, bb.level) - bb.occupants - (bb === from ? 0 : need) > 0 ? 0.2 : 0);
    const famNow = from ? fam(from.x, from.y, from) : 0;
    const work = c.job ? (Math.abs(b.x - c.wx) + Math.abs(b.y - c.wy)) - (from ? Math.abs(from.x - c.wx) + Math.abs(from.y - c.wy) : 0) : 0;
    return w[Value.Money] * clamp(-6 * tax)
      + w[Value.Family] * clamp(1.5 * (fam(b.x, b.y, b) - famNow))
      + w[Value.Status] * clamp(0.5 * (b.level - (from?.level ?? b.level)))
      + w[Value.Roots] * (clamp(-d / R) + (same ? 0.3 : 0))
      + w[Value.Time] * clamp(-1.5 * work / R)
      + w[Value.Adventure] * (clamp(d / R) + (same ? 0 : 0.2))
      + this.hoodTerm(w, host, from, b)
      - 0.1 * d / R; // moving is a bother
  }
  private kw = new Float64Array(11);
  /** The neighbourhood value term of homeScore: VALUE.homeTerm × the log of b's value over the current home's, pressed and clamped. */
  hoodTerm(w: readonly number[], host: MotiveHost, from: Building | undefined, b: Building): number {
    if (!host.value || !from || !VALUE_FIELD.on) return 0;
    const kw = valueWeights(w, this.kw);
    const vb = host.value(b.x, b.y, kw), vf = host.value(from.x, from.y, kw);
    return VALUE.homeTerm * clamp(VALUE.homeGain * Math.log(Math.max(0.05, vb) / Math.max(0.05, vf)));
  }

  /**
   * The best home in reach for c's household (beds for `need`), scored by `homeScore` plus noise, or null. Walks the
   * built-building grid near home (World.eachBuiltNear), as the move-out's bestBuiltNear does, and scores an even
   * spread of at most MOTIVE.homeOptions of the homes with room (scoring reads services and parks, so not hundreds);
   * road access only for a would-be best.
   */
  bestHome(c: Citizen, host: MotiveHost, need: number, w: readonly number[]): { b: Building; score: number } | null {
    const W = this.w, from = W.buildings.get(tileKey(c.hx, c.hy));
    // the homes with room, nearest first (cheap), then a hashed sample of at most homeOptions of them to score
    const room: [Building, number][] = [];
    W.eachBuiltNear(c.hx, c.hy, [Zone.Residential], MOTIVE.moveRadius, (b, d) => {
      if (b !== from && capacityOf(b.id, b.level) - b.occupants >= need && (b.holdUntil ?? 0) <= W.tick) room.push([b, d]);
    });
    if (!room.length) return null;
    const step = Math.max(1, room.length / MOTIVE.homeOptions), off = Math.random() * step;
    let best: Building | null = null, bestScore = -Infinity;
    for (let k = off; k < room.length; k += step) {
      const [b, d] = room[Math.floor(k)];
      const sc = this.homeScore(c, w, host, from, b, d, need) + MOTIVE.noise * (2 * Math.random() - 1);
      if (sc <= bestScore || !host.homeOk(b)) continue;
      best = b; bestScore = sc;
    }
    this.stats.scoredHomes++;
    return best ? { b: best, score: bestScore } : null;
  }

  /** A grown child's new home when they move out (Simulation.lifeFamily): the scored choice, or undefined to keep the old way. */
  moveOutHome(c: Citizen, host: MotiveHost): Building | null | undefined {
    if (!MOTIVATION.on || !MOTIVATION.homes) return undefined;
    return this.bestHome(c, host, 1, this.weightsOf(c))?.b ?? null;
  }

  /**
   * A night out's multipliers (Simulation.pickLeisure) for a place `d` tiles away with this ticket, at an event or not:
   * Adventure goes further and loves an event, Money minds the ticket. About 1 for an average citizen.
   */
  leisure(c: Citizen, d: number, ticket: number, event: boolean): number {
    const w = valuesOf(c.vals, this.wbuf);
    const reach = 12 * (0.7 + 1.8 * w[Value.Adventure]);
    return ((1 + d / 12) / (1 + d / reach))
      * (event ? 0.7 + 1.8 * w[Value.Adventure] : 1)
      * (ticket > 0 ? Math.max(0.5, 1 - 1.2 * (w[Value.Money] - 0.25) * Math.min(1, ticket / 10)) : 1);
  }
  /** The bar yardstick's multiplier: adventurous people go somewhere new rather than the pub. */
  yardstick(c: Citizen): number {
    if (!MOTIVATION.on || !MOTIVATION.leisure) return 1;
    const a = valuesOf(c.vals, this.wbuf)[Value.Adventure];
    return Math.max(0.7, Math.min(1.3, 1.25 - 1.5 * a));
  }

  /**
   * The daily look of Rich's 2a (once a game day per citizen at home, from Simulation.lifeStep): an employed adult may
   * look for a better job, and the household's eldest-id adult may look for a better home. Slow by design.
   */
  daily(c: Citizen, host: MotiveHost) {
    if (!MOTIVATION.on || !MOTIVATION.daily || c.stage !== LifeStage.Adult || c.mig) return;
    const day = Math.floor(this.w.tick / DAY_TICKS);
    const last = this.settledDay.get(c.id);
    if (last !== undefined && day - last < MOTIVE.settleDays) return;
    if (last !== undefined) this.settledDay.delete(c.id);
    if (c.job && host.canSwitch(c) && this.recruit(c, host)) { this.settledDay.set(c.id, day); return; }
    const w = this.weightsOf(c);
    if (c.job && host.canSwitch(c) && Math.random() < MOTIVE.lookJob * (0.5 + 1.5 * (w[Value.Money] + w[Value.Status] + w[Value.Time]))) {
      this.stats.jobLooks++;
      if (this.betterJob(c, host)) { this.settledDay.set(c.id, day); return; }
    }
    if (Math.random() < MOTIVE.lookHome * Math.max(0.1, 1.2 - 2 * w[Value.Roots])) this.betterHome(c, host, day);
  }

  /**
   * Essential workplaces under half staffed (builders' yards, public services, utilities), re-listed once a game hour.
   * In a town where nobody is out of work no job-seeker comes for a new one, so they recruit (`recruit`).
   */
  private needy: Building[] = [];
  private needyAt = -Infinity;
  private needyNow(): Building[] {
    const now = this.w.tick;
    if (now - this.needyAt < TICKS_PER_HOUR) return this.needy;
    this.needyAt = now;
    this.needy = [];
    for (const b of this.w.buildings.values()) {
      // only workplaces with a roster: a cemetery, a park or a car park is civic but employs nobody (hire() picks a shift)
      if (b.level <= 0 || !essentialJob(b.id) || !OCCUPATIONS[b.id] || (this.w.mothballed.size && this.w.mothballed.has(tileKey(b.x, b.y)))) continue;
      const cap = capacityOf(b.id, b.level);
      if (cap > 0 && b.occupants < cap / 2) this.needy.push(b);
    }
    return this.needy;
  }
  /**
   * A plain worker living within MOTIVE.recruitRadius of an essential workplace under half staffed takes a place there
   * with chance MOTIVE.recruitChance a day, whatever their values: the station's hiring drive. Without it a new fire
   * post in a town with nobody out of work stays empty, as no job-seeker comes for it.
   */
  private recruit(c: Citizen, host: MotiveHost): boolean {
    const needy = this.needyNow();
    if (!needy.length) return false;
    let best: Building | null = null, bd = Infinity;
    for (const b of needy) {
      const d = Math.abs(b.x - c.hx) + Math.abs(b.y - c.hy);
      if (d <= MOTIVE.recruitRadius && d < bd && host.canTake(c, b)) { best = b; bd = d; }
    }
    if (!best || Math.random() >= MOTIVE.recruitChance) return false;
    const path = host.pathTo(c, best);
    if (!path) return false;
    host.switchJob(c, best, path);
    this.stats.recruited++;
    this.note(c, 'took a job where they were short of staff');
    return true;
  }

  /** Score the current job against a fresh search; switch when a rival wins by switchMargin. */
  private betterJob(c: Citizen, host: MotiveHost): boolean {
    const cur = this.w.buildings.get(tileKey(c.wx, c.wy));
    if (!cur) return false;
    const rival = host.bestJob(c, cur);
    if (!rival) return false;
    const steps = c.commute ? c.commute.length / 2 - 1 : Math.round(1.3 * (Math.abs(c.wx - c.hx) + Math.abs(c.wy - c.hy)));
    const facts = [
      this.jobFacts(c, cur, steps, c.skill ? Place.Skilled : Place.Unskilled),
      this.jobFacts(c, rival.b, rival.path.length / 2 - 1, rival.place),
    ];
    const scores = [0, 0];
    this.pickJob(c, facts, scores);
    if (scores[1] < scores[0] + MOTIVE.switchMargin) return false;
    host.switchJob(c, rival.b, rival.path);
    this.stats.jobSwitches++;
    const why = facts[1].wage > facts[0].wage * 1.05 ? 'for the pay' : facts[1].steps < facts[0].steps ? 'for a shorter commute' : facts[1].status > facts[0].status ? 'to get on' : 'for a change';
    this.note(c, `changed job ${why}`);
    return true;
  }

  /**
   * The household's look at homes: the adult with the lowest id rolls (once a day, as for babies), with the mean of
   * the grown-ups' weights; everyone must be at home. Moves when the best home beats theirs by moveMargin.
   */
  private betterHome(c: Citizen, host: MotiveHost, day: number) {
    const W = this.w, hh = W.households.get(c.hh);
    const ids = hh?.ids ?? [c.id];
    const people: Citizen[] = [];
    for (const id of ids) {
      const o = W.citizens.get(id);
      if (!o) continue;
      if (o.stage !== LifeStage.Child && o.id < c.id) return; // not the household's roller
      if (o.state !== CitizenState.Home || o.mig || o.hx !== c.hx || o.hy !== c.hy) return; // everyone at home
      people.push(o);
    }
    const from = W.buildings.get(tileKey(c.hx, c.hy));
    if (!from || from.zone !== Zone.Residential || !host.homeOk(from)) return; // halls, the camp (FirstFive.campStep moves them)
    this.stats.homeLooks++;
    const w = new Array(VALUE_COUNT).fill(0), one = this.wbuf;
    let adults = 0;
    for (const o of people) if (o.stage !== LifeStage.Child) { this.weightsOf(o, one); for (let i = 0; i < VALUE_COUNT; i++) w[i] += one[i]; adults++; }
    for (let i = 0; i < VALUE_COUNT; i++) w[i] /= Math.max(1, adults);
    const best = this.bestHome(c, host, people.length, w);
    if (!best) return;
    const stay = w[Value.Roots] * 0.3; // the current home's own score: staying put
    if (best.score < stay + MOTIVE.moveMargin) return;
    for (const o of people) { host.moveHome(o, best.b, c.hh); this.settledDay.set(o.id, day); }
    this.stats.moves++;
    this.stats.movedPeople += people.length;
    const [top] = topOf(w);
    this.note(c, `moved house${people.length > 1 ? ' with the family' : ''} (${MOVE_WHY[top]})`);
  }

  private note(c: Citizen, what: string) {
    const day = Math.floor(this.w.tick / DAY_TICKS);
    this.log.push([day, c.id, what]);
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    this.recent.delete(c.id);
    this.recent.set(c.id, [day, what]);
    if (this.recent.size > 4000) for (const [id, [d]] of this.recent) { if (day - d < MOTIVE.settleDays && this.recent.size <= 4000) break; this.recent.delete(id); }
  }
  /** c's latest change of job or home of their own accord, while within settleDays (the citizen panel). */
  lately(c: Citizen): string | undefined {
    const r = this.recent.get(c.id);
    return r && Math.floor(this.w.tick / DAY_TICKS) - r[0] < MOTIVE.settleDays ? r[1] : undefined;
  }
}

const MOVE_WHY = ['cheaper', 'better for the family', 'a better address', 'near friends', 'nearer work', 'somewhere new'];

const clamp = (x: number) => (x < -1 ? -1 : x > 1 ? 1 : x);
const topOf = (w: readonly number[]) => { let a = 0; for (let i = 1; i < w.length; i++) if (w[i] > w[a]) a = i; return [a]; };

/** Whole percentages summing to 100 (largest remainder). */
function roundPct(s: number[]): number[] {
  const total = s.reduce((a, b) => a + b, 0) || 1;
  const raw = s.map((x) => (100 * x) / total), out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]]++;
  return out;
}

/**
 * A child's values (docs/motivation.md section 3, Rich's 5: yes): the mean of the parents' stored weights, blended
 * with the child's own hashed archetype at MOTIVE.childOwn, then the jitter. Pure: Families.join uses it too.
 */
export function inheritValues(id: number, parents: (Citizen | undefined)[]): number {
  const mean = new Array(VALUE_COUNT).fill(0), one = new Array(VALUE_COUNT).fill(0);
  let n = 0;
  for (const p of parents) if (p?.vals) { valuesOf(p.vals, one); for (let i = 0; i < VALUE_COUNT; i++) mean[i] += one[i]; n++; }
  if (!n) return seededValues(id);
  const own = archetypeBlend(id);
  for (let i = 0; i < VALUE_COUNT; i++) own[i] = (1 - MOTIVE.childOwn) * (mean[i] / n) + MOTIVE.childOwn * own[i];
  return packWeights(jitterValues(id, own));
}

/**
 * Staying on in education (sim/schools.ts): the multiplier on EDU.uniShare and postgradTake, by Status and Adventure
 * (1 for the city's average, 0.6-1.6), and the share choosing STEM over the arts at sixth form, by Status and Money
 * against Adventure (0.5 for the average). Off: 1 and 0.5, as before.
 */
export function stayOnLift(c: Citizen): number {
  if (!MOTIVATION.on || !MOTIVATION.school || !c.vals) return 1;
  const w = valuesOf(c.vals);
  return Math.max(0.6, Math.min(1.6, 1 + 1.5 * (w[Value.Status] + w[Value.Adventure] - 0.25)));
}
export function stemShare(c: Citizen): number {
  if (!MOTIVATION.on || !MOTIVATION.school || !c.vals) return 0.5;
  const w = valuesOf(c.vals);
  return Math.max(0.2, Math.min(0.8, 0.5 + (w[Value.Status] + w[Value.Money] - w[Value.Adventure] - 0.27)));
}

/** The archetype nearest to a citizen's stored values (probes and the showcase). */
export function archetypeOf(vals: number): number {
  const w = valuesOf(vals);
  let best = 0, bd = Infinity;
  ARCHETYPES.forEach((a, i) => { let d = 0; for (let k = 0; k < VALUE_COUNT; k++) d += (a.w[k] - w[k]) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}
