import {
  PLANNING, TICKS_PER_HOUR, TICKS_PER_DAY, LifeStage, KIND_NAMES, CIVIC_COST, REFUSE_ADDONS, BOUNDARY_LIMITS, VALUE_KINDS, VALUE_KIND_COUNT, ValueKind, VALUE_COUNT, Value,
  planImpact, planAt, withPlan, planningSourceOf, conditionCost, conditionNames, combineValue, valueWeights, hash2, workOf,
  planStructure, placedFromDoor, isRoad, isBridgeAux, packTile, terrainOf, tileKey,
  type PlanImpact, type PlanAppDTO, type PlanKind, type PlanStatus, type Placed,
} from '@msimcity/shared';
import type { World, Citizen } from '../world';
import type { Simulation } from './simulation';
import type { News } from './news';

/**
 * Planning notices and the residents' vote (docs/multiplayer-land.md section 6, M5). One per game (game.ts), told about
 * new filings by Net and deciding them itself when their notice runs out.
 *
 * - **Applications.** A nuisance build that reaches someone else's land over the planning threshold (shared/src/planning.ts
 *   planImpact) is filed instead of placed (Net.placeStructure): the money (the building, its conditions and the community
 *   offer) is taken at filing and held; the site is reserved; a marker shows on the map; the affected mayors get a toast
 *   and the local news a story. Taking a nuisance-cutting add-on off a refuse site likewise (`addon`). A protected public
 *   road (M3) may be closed by a closure notice (`closure`): the mayors who depend on it may object within the notice.
 * - **The roll** is frozen at filing: every resident (not a child) whose home is in the impact zone, of every owner.
 * - **The vote** at the end of the notice: each voter's lean is their own expected impact (the plan's intensities at full
 *   use added to their home cell, valued with their household's weights: M1's combineValue), their belief about the plan
 *   (`believe`: neutral until M6's campaigns, plus word of mouth from friends on the roll), the community offer and jobs;
 *   turnout grows with the strength of feeling, more for opponents (loss aversion). Hash-seeded, so the same world gives
 *   the same result. More yes than no among those voting approves.
 * - **Outcomes.** Approved: the building is placed as any build (its conditions fitted as add-ons that cannot be taken off,
 *   `locked`), the offer paid out among the affected owners. Refused: everything held is refunded, and the applicant may
 *   not file near the site for PLANNING.coolTicks, then only a design with a lower impact score (cleaner grade, add-ons,
 *   further back) until PLANNING.rememberTicks.
 *
 * Nothing runs per tick but a look at the open applications' end ticks.
 */

export interface PlanApp {
  id: number; kind: PlanKind; by: string; status: PlanStatus;
  /** the door (a build, an add-on change) or the first tile (a closure) */
  x: number; y: number;
  /** build: the kind and orientation; add-on: the site's kind */
  bk?: number; r?: number;
  /** build: the conditions as add-on bits; add-on: the mask asked for (`from` the mask it had) */
  mask: number; from?: number;
  /** the community offer, and everything held (the building, its conditions, the offer) */
  offer: number; held: number;
  filed: number; ends: number;
  /** the frozen roll: citizen ids */
  roll: number[];
  /** the mayors reached (build, add-on) or depending on the road (closure) */
  affected: string[];
  /** closure: the public road tiles, and who objected */
  tiles?: [number, number][]; objections?: string[];
  /** decided: when, the count and why */
  decided?: number; yes?: number; no?: number; result?: string;
  /** beliefs about this plan on the roll (citizen id -> -1..1): M6's campaigns write them; saved */
  beliefs?: Record<number, number>;
}
/** A refused design, for the cooling-off and the changed-design rule. */
interface Refused { by: string; x: number; y: number; kind: number; score: number; at: number }
export interface PlanningSave { apps: PlanApp[]; nextId: number; refused: Refused[]; locks: [number, number, number][] }

const ADULT = (c: Citizen) => c.stage !== LifeStage.Child && !c.mig;

export class Planning {
  readonly apps = new Map<number, PlanApp>();
  private nextId = 1;
  private refused: Refused[] = [];
  /** conditions of approved plans per site (door tile key): add-on bits that may not be taken off */
  readonly locks = new Map<string, number>();
  private impacts = new Map<number, PlanImpact>();
  /** set when the list changed (Net sends `planning`) */
  changed = true;
  /** toasts for one owner's screen */
  notices: { owner: string; msg: string }[] = [];
  news: News | null = null;
  /** counters since start (the check) */
  stats = { filed: 0, approved: 0, refused: 0, closures: 0 };
  private lastHour = -1;

  /** `on`: votes on nuisance builds (shared worlds). Closure notices work wherever road protection does. */
  constructor(private w: World, private sim: Simulation, readonly on: boolean) {
    const s = w.planningLoaded as PlanningSave | null;
    if (s && typeof s === 'object') {
      for (const a of Array.isArray(s.apps) ? s.apps : []) if (a && Number.isInteger(a.id) && typeof a.by === 'string' && Array.isArray(a.roll)) this.apps.set(a.id, { ...a, roll: [...a.roll], affected: [...(a.affected ?? [])] });
      this.nextId = Math.max(1, Number(s.nextId) || 1, 1 + Math.max(0, ...this.apps.keys()));
      for (const r of Array.isArray(s.refused) ? s.refused : []) if (r && typeof r.by === 'string') this.refused.push({ ...r });
      for (const l of Array.isArray(s.locks) ? s.locks : []) if (Array.isArray(l) && Number.isInteger(l[0]) && Number.isInteger(l[1]) && l[2] > 0) this.locks.set(tileKey(l[0], l[1]), l[2] & 7);
      w.planningLoaded = null;
    }
    w.planningSave = () => this.save();
  }

  private name(id: string) { return id === 'sys' ? 'the Commons' : this.w.players.get(id)?.name ?? id; }
  private ownerAt = (x: number, y: number) => this.w.parcelAt(x, y)?.owner;

  // ---- asking --------------------------------------------------------------------------------------------------

  /**
   * The impact of a nuisance build of `kind` with conditions `mask` at door (x, y) by `builder`, when it needs planning
   * (some kind over the threshold on others' land, none over its limit); null when it may be placed at once (or is
   * refused by the limits: Net checks those first). Off (not a shared world): always null.
   */
  needs(kind: number, mask: number, x: number, y: number, builder: string): PlanImpact | null {
    if (!this.on || !planningSourceOf(kind)) return null;
    const imp = planImpact(kind, mask, x, y, this.w.seed, builder, this.ownerAt);
    return imp.needs.length && !imp.over.length ? imp : null;
  }

  /** Why `by` may not file a plan of impact `score` at door (x, y) now (the cooling-off, an unchanged design), or null. */
  refileRefusal(by: string, x: number, y: number, score: number): string | null {
    const now = this.w.tick, near = PLANNING.nearTiles;
    this.refused = this.refused.filter((r) => now - r.at < PLANNING.rememberTicks);
    for (const r of this.refused) {
      if (r.kind === -1 || r.by !== by || Math.abs(r.x - x) > near || Math.abs(r.y - y) > near) continue;
      if (now - r.at < PLANNING.coolTicks) return `A plan of yours was refused here ${hoursAgo(now - r.at)}: you may file again near this site in ${hoursLeft(r.at + PLANNING.coolTicks - now)}`;
      if (score > PLANNING.changedBy * r.score) return `Residents refused a plan like this here: file a changed design (a cleaner grade, more add-ons, or further back) that reaches the neighbours less (now ${Math.round(100 * score / r.score)}% of the refused plan's impact; it must be under ${Math.round(100 * PLANNING.changedBy)}%)`;
    }
    return null;
  }

  /** Why `by` may not give notice to close these tiles now: a notice of theirs on them was objected to lately. */
  closureRefusal(by: string, tiles: readonly (readonly [number, number])[]): string | null {
    const now = this.w.tick;
    for (const r of this.refused) if (r.kind === -1 && r.by === by && now - r.at < PLANNING.coolTicks && tiles.some(([x, y]) => x === r.x && y === r.y))
      return `A closure notice of yours on this road was objected to ${hoursAgo(now - r.at)}: you may give notice again in ${hoursLeft(r.at + PLANNING.coolTicks - now)}, or build a way round first`;
    return null;
  }

  /** Whether tile (x, y) is in the footprint of an open building application (reserved until it is decided). */
  reservedAt(x: number, y: number): boolean {
    for (const a of this.apps.values()) {
      if (a.status !== 'open' || a.kind !== 'build' || a.bk === undefined) continue;
      const p = placedFromDoor(a.bk, a.x, a.y, a.r ?? 0);
      if (x >= p.ax && x < p.ax + p.w && y >= p.ay && y < p.ay + p.h) return true;
    }
    return false;
  }
  /** The open application, if any, for the refuse site whose door is (x, y) (an add-on change waiting). */
  openAt(x: number, y: number): PlanApp | undefined {
    for (const a of this.apps.values()) if (a.status === 'open' && a.x === x && a.y === y && a.kind !== 'closure') return a;
    return undefined;
  }
  /** Add-on bits at the site with door (x, y) that are planning conditions (may not be taken off). */
  lockedAt(x: number, y: number): number { return this.locks.get(tileKey(x, y)) ?? 0; }

  /** M6's campaigns: what citizen `cid` believes about plan `id` (-1 against .. 1 for). Plumbing: nothing calls it yet. */
  believe(id: number, cid: number, b: number) {
    const a = this.apps.get(id);
    if (!a || a.status !== 'open') return;
    (a.beliefs ??= {})[cid] = Math.max(-1, Math.min(1, b));
  }

  // ---- filing --------------------------------------------------------------------------------------------------

  /**
   * File a building of `placed.kind` with conditions `mask` and a community `offer` (Net checked the land, the limits, the
   * cooling-off and the money): `cost` (the building and its conditions) and the offer are taken now and held.
   */
  fileBuild(by: string, placed: Placed, mask: number, offer: number, cost: number, imp: PlanImpact): PlanApp {
    const a = this.newApp('build', by, placed.doorX, placed.doorY, imp);
    a.bk = placed.kind; a.r = placed.r; a.mask = mask; a.offer = offer; a.held = cost + offer;
    if (cost) this.w.credit(by, -cost, 'build');
    if (offer) this.w.credit(by, -offer, 'planning');
    this.announce(a, imp);
    return a;
  }
  /** File taking add-ons off the refuse site at door (x, y): `from` the mask it has, `mask` the one asked for. */
  fileAddon(by: string, x: number, y: number, kind: number, from: number, mask: number, imp: PlanImpact): PlanApp {
    const a = this.newApp('addon', by, x, y, imp);
    a.bk = kind; a.mask = mask; a.from = from;
    this.announce(a, imp);
    return a;
  }
  /** A closure notice for protected public road tiles: `affected` (PublicRoads.dependents) may object until it ends. */
  fileClosure(by: string, tiles: [number, number][], affected: string[]): PlanApp {
    const a: PlanApp = { id: this.nextId++, kind: 'closure', by, status: 'open', x: tiles[0][0], y: tiles[0][1], mask: 0, offer: 0, held: 0, filed: this.w.tick, ends: this.w.tick + PLANNING.noticeTicks, roll: [], affected, tiles: tiles.map(([x, y]) => [x, y]), objections: [] };
    this.apps.set(a.id, a);
    this.stats.closures++;
    this.changed = true;
    const msg = `${this.name(by)} gives notice to close ${tiles.length} tile${tiles.length === 1 ? '' : 's'} of public road near (${a.x}, ${a.y}) that your land or traffic depends on. Object in the Planning panel within a game day, or it goes (silence is consent)`;
    for (const o of affected) this.notices.push({ owner: o, msg });
    this.notices.push({ owner: by, msg: `Closure notice filed: ${affected.map((o) => this.name(o)).join(', ')} may object within a game day; if nobody does, the road is taken up` });
    this.news?.planning('closureFiled', a.x, a.y, 'a road', by);
    return a;
  }

  private newApp(kind: PlanKind, by: string, x: number, y: number, imp: PlanImpact): PlanApp {
    const a: PlanApp = { id: this.nextId++, kind, by, status: 'open', x, y, mask: 0, offer: 0, held: 0, filed: this.w.tick, ends: this.w.tick + PLANNING.noticeTicks, roll: this.rollOf(imp), affected: [...imp.owners.keys()].sort() };
    this.apps.set(a.id, a);
    this.impacts.set(a.id, imp);
    this.stats.filed++;
    this.changed = true;
    return a;
  }
  /** Residents (not children, not on their way in or out) whose home is in the impact zone, in id order. */
  private rollOf(imp: PlanImpact): number[] {
    const out: number[] = [];
    for (const c of this.w.citizens.values()) if (ADULT(c) && c.vals && planAt(imp, c.hx, c.hy)) out.push(c.id);
    return out.sort((a, b) => a - b);
  }
  private announce(a: PlanApp, imp: PlanImpact) {
    const what = this.what(a), worst = this.worstWords(imp);
    for (const o of a.affected) this.notices.push({ owner: o, msg: `Planning notice: ${this.name(a.by)} plans ${what} near your land (${worst}). ${a.roll.length} resident${a.roll.length === 1 ? '' : 's'} vote at the end of a game day: see the Planning panel` });
    this.notices.push({ owner: a.by, msg: `Your ${what} goes to planning: it reaches ${a.affected.map((o) => `${this.name(o)}'s`).join(', ')} land (${worst}). ${a.roll.length} resident${a.roll.length === 1 ? '' : 's'} vote in a game day${a.held ? `; $${Math.round(a.held).toLocaleString('en-GB')} is held until then and refunded if refused` : ''}. You may add conditions or raise your offer in the Planning panel` });
    const near = this.nearOf(imp);
    this.news?.planning('planFiled', a.x, a.y, what, a.by, a.bk, near);
  }
  /** A tile of the most affected other owner's land (for the news' "near ..."). */
  private nearOf(imp: PlanImpact): [number, number] | undefined {
    let best: string | null = null, bv = 0;
    for (const [o, v] of imp.owners) if (v > bv) { best = o; bv = v; }
    if (!best) return undefined;
    for (const p of this.w.parcels.values()) if (p.owner === best) return [p.x + (p.w >> 1), p.y + (p.h >> 1)];
    return undefined;
  }
  private what(a: PlanApp): string {
    const g = a.bk !== undefined ? planningSourceOf(a.bk)?.name ?? KIND_NAMES[a.bk] : 'building';
    if (a.kind === 'closure') return `closing ${a.tiles?.length ?? 0} tiles of public road`;
    if (a.kind === 'addon') return `taking the ${conditionNames((a.from ?? 0) & ~a.mask).join(' and ')} off the ${g}`;
    return `${/^[aeiou]/.test(g) ? 'an' : 'a'} ${g}`;
  }
  private worstWords(imp: PlanImpact): string {
    let k = -1;
    for (let i = 0; i < VALUE_KIND_COUNT; i++) if (VALUE_KINDS[i].nuisance && imp.worst[i] > 0 && (k < 0 || imp.worst[i] / BOUNDARY_LIMITS[i] > imp.worst[k] / BOUNDARY_LIMITS[k])) k = i;
    return k < 0 ? 'little' : `${VALUE_KINDS[k].name} up to ${Math.round(100 * imp.worst[k])}%`;
  }

  /** The current impact of an application (recomputed after a load or an amendment). */
  impactOf(a: PlanApp): PlanImpact | null {
    if (a.kind === 'closure' || a.bk === undefined) return null;
    let imp = this.impacts.get(a.id);
    if (!imp) { imp = planImpact(a.bk, a.mask, a.x, a.y, this.w.seed, a.by, this.ownerAt); this.impacts.set(a.id, imp); }
    return imp;
  }

  // ---- during the notice ---------------------------------------------------------------------------------------

  /**
   * The applicant amends an open build application: adds conditions (add-on ids) and/or raises the offer to `offer`.
   * The extra money is taken and held; the true impact is recomputed; the roll stays frozen. Returns a refusal or null.
   */
  amend(by: string, id: number, addBits: number, offer: number | undefined, spendable: number): string | null {
    const a = this.apps.get(id);
    if (!a || a.status !== 'open') return 'That application is not open';
    if (a.by !== by) return 'Not your application';
    if (a.kind !== 'build') return 'Only a building application can be amended';
    const src = planningSourceOf(a.bk!);
    const bits = addBits & (src?.conditions ?? 0) & ~a.mask;
    const newOffer = offer === undefined || !Number.isFinite(offer) ? a.offer : Math.min(PLANNING.maxOffer, Math.max(a.offer, Math.round(offer)));
    const extra = conditionCost(bits), more = newOffer - a.offer;
    if (!bits && !more) return 'Nothing to change: add a condition or raise the offer';
    if (spendable < extra + more) return `That needs $${Math.round(extra + more).toLocaleString('en-GB')} more than you can spend`;
    a.mask |= bits; a.offer = newOffer; a.held += extra + more;
    if (extra) this.w.credit(by, -extra, 'build');
    if (more) this.w.credit(by, -more, 'planning');
    this.impacts.delete(a.id);
    this.changed = true;
    const msg = `${this.name(by)} amended the plan for ${this.what(a)}: ${[bits ? `added ${conditionNames(bits).join(' and ')}` : '', more ? `offer now $${newOffer.toLocaleString('en-GB')}` : ''].filter(Boolean).join(', ')}`;
    for (const o of a.affected) this.notices.push({ owner: o, msg });
    return null;
  }
  /** An affected mayor objects to a closure notice: it is stopped at once. */
  object(who: string, id: number): string | null {
    const a = this.apps.get(id);
    if (!a || a.status !== 'open') return 'That notice is not open';
    if (a.kind !== 'closure') return 'Residents vote on building plans; objections are for road closures';
    if (!a.affected.includes(who)) return 'Only a mayor whose land or traffic depends on the road may object';
    (a.objections ??= []).push(who);
    this.decide(a);
    return null;
  }
  /** The applicant withdraws an open application: everything held comes back, and there is no cooling-off. */
  withdraw(by: string, id: number): string | null {
    const a = this.apps.get(id);
    if (!a || a.status !== 'open') return 'That application is not open';
    if (a.by !== by) return 'Not your application';
    this.refund(a);
    this.close(a, 'withdrawn', 'Withdrawn by the applicant');
    return null;
  }

  // ---- deciding ------------------------------------------------------------------------------------------------

  /** Each tick: decide applications whose notice ran out; drop old decided ones and conditions of sites that are gone. */
  tick() {
    const now = this.w.tick;
    for (const a of this.apps.values()) if (a.status === 'open' && now >= a.ends) this.decide(a);
    const hour = Math.floor(now / TICKS_PER_HOUR);
    if (hour === this.lastHour) return;
    this.lastHour = hour;
    for (const [id, a] of this.apps) if (a.status !== 'open' && now - (a.decided ?? now) > PLANNING.showDecidedTicks) { this.apps.delete(id); this.impacts.delete(id); this.changed = true; }
    for (const k of this.locks.keys()) if (!this.w.buildings.has(k)) this.locks.delete(k);
  }

  /** The vote (a build or an add-on change) or the objections (a closure), and what follows. */
  decide(a: PlanApp) {
    if (a.status !== 'open') return;
    if (a.kind === 'closure') return this.decideClosure(a);
    const v = this.vote(a);
    a.yes = v.yes; a.no = v.no;
    const ok = v.yes > v.no || v.yes + v.no === 0;
    const what = this.what(a), tally = v.yes + v.no ? `${v.yes} for, ${v.no} against, ${v.yes + v.no} of ${v.roll} voting` : 'nobody on the roll voted';
    if (ok) {
      const done = a.kind === 'build' ? this.build(a) : this.applyAddon(a);
      if (done) { this.refund(a); this.close(a, 'lapsed', `Approved (${tally}), but ${done}: refunded`); return; }
      this.payOffer(a, v.weights);
      this.close(a, 'approved', `Approved: ${tally}${a.mask && a.kind === 'build' ? `; conditions: ${conditionNames(a.mask).join(', ')}` : ''}`);
      this.stats.approved++;
      this.news?.planning('planApproved', a.x, a.y, what, a.by, a.bk, this.nearOf(this.impactOf(a)!));
    } else {
      this.refund(a);
      this.refused.push({ by: a.by, x: a.x, y: a.y, kind: a.bk ?? 0, score: this.impactOf(a)?.score ?? 0, at: this.w.tick });
      this.close(a, 'refused', `Refused: ${tally}`);
      this.stats.refused++;
      this.news?.planning('planRefused', a.x, a.y, what, a.by, a.bk, this.nearOf(this.impactOf(a)!));
    }
    const msg = `Planning: ${this.name(a.by)}'s ${what.replace(/^an? /, '')} ${a.result!.charAt(0).toLowerCase()}${a.result!.slice(1)}`;
    for (const o of new Set([a.by, ...a.affected])) this.notices.push({ owner: o, msg: o === a.by && (a.status as PlanStatus) === 'refused' ? `${msg}. Everything held is refunded; you may file a changed design here after ${hoursLeft(PLANNING.coolTicks)}` : msg });
  }

  private decideClosure(a: PlanApp) {
    if (a.objections?.length) {
      this.close(a, 'refused', `Stopped: ${a.objections.map((o) => this.name(o)).join(', ')} objected`);
      for (const [x, y] of a.tiles ?? []) this.refused.push({ by: a.by, x, y, kind: -1, score: Infinity, at: this.w.tick }); // no new notice on it while it cools off
      this.news?.planning('closureBlocked', a.x, a.y, 'a road', a.by);
    } else {
      let n = 0;
      for (const [x, y] of a.tiles ?? []) {
        if (this.w.parcelIdAt(x, y) !== 0) continue;
        const t = this.w.peekTile(x, y);
        if (t === undefined || !isRoad(t)) continue;
        if (isBridgeAux(this.w.auxAt(x, y))) { this.w.removeBridge(x, y); n++; continue; }
        this.w.setTile(x, y, packTile(terrainOf(t), false, 0, 0));
        n++;
      }
      this.close(a, 'approved', `No objection: ${n} tile${n === 1 ? '' : 's'} of road taken up`);
      this.news?.planning('closureDone', a.x, a.y, 'a road', a.by);
    }
    const msg = `Road closure near (${a.x}, ${a.y}): ${a.result}`;
    for (const o of new Set([a.by, ...a.affected])) this.notices.push({ owner: o, msg });
  }

  private close(a: PlanApp, status: PlanStatus, result: string) {
    a.status = status; a.result = result; a.decided = this.w.tick;
    delete a.beliefs;
    this.changed = true;
  }
  private refund(a: PlanApp) {
    if (!a.held) return;
    const offer = a.offer, rest = a.held - offer;
    if (rest) this.w.credit(a.by, rest, 'build');
    if (offer) this.w.credit(a.by, offer, 'planning');
    a.held = 0;
  }

  /** Approved: place the building as a build would (its conditions fitted and locked). A reason when it can no longer go there. */
  private build(a: PlanApp): string | null {
    const kind = a.bk!;
    const verdict = planStructure(kind, a.x, a.y, {
      tile: (x, y) => this.w.getTile(x, y), aux: (x, y) => this.w.auxAt(x, y), sub: (x, y) => this.w.subAt(x, y),
      land: (x, y) => (this.w.parcelAt(x, y)?.owner === a.by ? null : 'Not your land'),
    }, a.r);
    if (!verdict.ok) return `the site is no longer clear (${verdict.reason.toLowerCase()})`;
    this.w.placeStructure(verdict.placed, { work: workOf(kind, 1), priority: 1 });
    const key = tileKey(verdict.placed.doorX, verdict.placed.doorY);
    if (a.mask) { this.w.refuseAddons.set(key, a.mask); this.locks.set(key, a.mask); }
    a.held = 0; // spent: the building and its conditions are built, the offer paid out
    return null;
  }
  private applyAddon(a: PlanApp): string | null {
    const key = tileKey(a.x, a.y), b = this.w.buildings.get(key);
    if (!b || b.id !== a.bk) return 'the site is gone';
    if ((this.w.refuseAddons.get(key) ?? 0) !== a.from) return 'the site\'s add-ons changed meanwhile';
    if (a.mask) this.w.refuseAddons.set(key, a.mask); else this.w.refuseAddons.delete(key);
    return null;
  }
  /** The community offer goes to the affected owners, split by their residents on the roll (evenly when none). */
  private payOffer(a: PlanApp, weights: Map<string, number>) {
    if (!a.offer) return;
    const owners = a.affected.length ? a.affected : [];
    if (!owners.length) { this.w.credit(a.by, a.offer, 'planning'); a.offer = 0; return; }
    let tot = 0;
    for (const o of owners) tot += weights.get(o) ?? 0;
    for (const o of owners) this.w.credit(o, (a.offer * (tot ? weights.get(o) ?? 0 : 1)) / (tot || owners.length), 'planning');
  }

  /**
   * The residents' vote (section 6): per voter on the frozen roll still living in town, lean = own impact + belief +
   * offer + jobs + a little hashed noise; turnout = base + gain × |lean| (× loss aversion against); yes when lean > 0.
   * Also each affected owner's residents on the roll (the offer's split).
   */
  vote(a: PlanApp): { yes: number; no: number; roll: number; weights: Map<string, number>; leans: Map<number, number> } {
    const imp = this.impactOf(a)!, src = planningSourceOf(a.bk!), w = this.w;
    const voters: Citizen[] = [];
    for (const id of a.roll) { const c = w.citizens.get(id); if (c && !c.mig) voters.push(c); }
    const households = new Set(voters.map((c) => c.hh)), hhOut = new Set<number>();
    for (const c of voters) if (c.stage === LifeStage.Adult && !c.job) hhOut.add(c.hh);
    const nh = Math.max(1, households.size);
    const jobsShare = Math.min(1, (src?.jobs ?? 0) / nh);
    const perHome = a.offer / nh;
    const wts = new Array(VALUE_COUNT).fill(0), kw = new Float64Array(VALUE_KIND_COUNT), after = new Float64Array(VALUE_KIND_COUNT), base = new Float64Array(VALUE_KIND_COUNT);
    const own = new Map<number, number>(), money = new Map<number, number>();
    for (const c of voters) {
      this.sim.motive.weightsOf(c, wts);
      valueWeights(wts, kw);
      const add = planAt(imp, c.hx, c.hy);
      let o = 0;
      if (add) {
        // the home's cell as the field has it (nothing measured yet: nothing near, and so quiet)
        const cell = this.sim.value.cellAt(c.hx, c.hy);
        if (cell) for (let k = 0; k < VALUE_KIND_COUNT; k++) base[k] = cell.b[cell.off + k];
        else { base.fill(0); base[ValueKind.Quiet] = 255; }
        withPlan(base, 0, add, after);
        o = PLANNING.impactGain * Math.log(Math.max(1e-6, combineValue(after, 0, kw)) / Math.max(1e-6, combineValue(base, 0, kw)));
      }
      own.set(c.id, o);
      money.set(c.id, wts[Value.Money]);
    }
    const onRoll = new Set(voters.map((c) => c.id));
    let yes = 0, no = 0;
    const weights = new Map<string, number>(), leans = new Map<number, number>();
    const sat = (x: number) => x / (1 + x);
    for (const c of voters) {
      // belief: M6's campaigns (a.beliefs), and word of mouth: friends on the roll talk about what it means for them
      let wom = 0, nf = 0;
      for (const f of c.friends) if (onRoll.has(f)) { wom += own.get(f) ?? 0; nf++; }
      const belief = (a.beliefs?.[c.id] ?? 0) * PLANNING.beliefGain + (nf ? (PLANNING.wordOfMouth * wom) / nf : 0);
      const bend = Math.max(0.6, Math.min(1.6, 1 + 0.35 * (VALUE_COUNT * (money.get(c.id) ?? 1 / VALUE_COUNT) - 1)));
      const offer = PLANNING.offerGain * sat(perHome / PLANNING.offerScale) * bend;
      const jobs = PLANNING.jobsGain * jobsShare * (hhOut.has(c.hh) ? 1 : PLANNING.jobsEmployed);
      const lean = own.get(c.id)! + belief + offer + jobs + PLANNING.noise * (hash2(c.id, a.id * 977 + 13) - 0.5);
      leans.set(c.id, lean);
      const p = Math.min(PLANNING.turnoutMax, PLANNING.turnoutBase + PLANNING.turnoutGain * Math.abs(lean) * (lean < 0 ? PLANNING.lossAversion : 1));
      if (hash2(c.id, a.id * 7919 + 1) < p) { if (lean > 0) yes++; else no++; }
      const o = w.parcelAt(c.hx, c.hy)?.owner;
      if (o) weights.set(o, (weights.get(o) ?? 0) + 1);
    }
    return { yes, no, roll: a.roll.length, weights, leans };
  }

  // ---- what clients get ----------------------------------------------------------------------------------------

  dtos(): PlanAppDTO[] {
    const out: PlanAppDTO[] = [];
    for (const a of this.apps.values()) {
      const imp = this.impactOf(a);
      const p = a.kind === 'build' && a.bk !== undefined ? placedFromDoor(a.bk, a.x, a.y, a.r ?? 0) : null;
      const impact: [number, number, number][] = [];
      if (imp) for (let k = 0; k < VALUE_KIND_COUNT; k++) if (VALUE_KINDS[k].nuisance && imp.worst[k] > 0.005) impact.push([k, Math.round(imp.worst[k] * 1000) / 1000, BOUNDARY_LIMITS[k]]);
      out.push({
        id: a.id, kind: a.kind, by: a.by, status: a.status, x: a.x, y: a.y, ...(a.bk !== undefined ? { bk: a.bk } : {}),
        ...(p ? { fx: p.ax, fy: p.ay, fw: p.w, fh: p.h } : {}),
        what: this.what(a), filed: a.filed, ends: a.ends,
        conditions: REFUSE_ADDONS.filter((d) => a.kind === 'build' && a.mask & d.bit).map((d) => d.id), offer: a.offer,
        impact, affected: a.affected, voters: a.roll.length,
        ...(a.objections ? { objections: a.objections } : {}),
        ...(a.yes !== undefined ? { yes: a.yes, no: a.no } : {}), ...(a.result ? { result: a.result } : {}),
      });
    }
    return out;
  }

  private save(): PlanningSave | null {
    if (!this.apps.size && !this.refused.length && !this.locks.size) return null;
    return {
      apps: [...this.apps.values()].map((a) => ({ ...a, roll: [...a.roll], affected: [...a.affected], ...(a.tiles ? { tiles: a.tiles.map(([x, y]) => [x, y] as [number, number]) } : {}), ...(a.beliefs ? { beliefs: { ...a.beliefs } } : {}) })),
      nextId: this.nextId, refused: this.refused.map((r) => ({ ...r })),
      locks: [...this.locks].map(([k, m]) => { const [x, y] = k.split(',').map(Number); return [x, y, m] as [number, number, number]; }),
    };
  }
}

/** The one-off cost of a building and its conditions at filing. */
export const buildCost = (kind: number, mask: number) => (CIVIC_COST[kind] ?? 0) + conditionCost(mask);

const hoursOf = (ticks: number) => Math.max(1, Math.round(ticks / TICKS_PER_HOUR));
const hoursLeft = (ticks: number) => (ticks >= TICKS_PER_DAY ? `${Math.round((10 * ticks) / TICKS_PER_DAY) / 10} game days` : `${hoursOf(ticks)} game hours`);
const hoursAgo = (ticks: number) => (ticks < TICKS_PER_HOUR ? 'just now' : `${hoursOf(ticks)} game hour${hoursOf(ticks) === 1 ? '' : 's'} ago`);
