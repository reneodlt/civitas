import {
  TICKS_PER_DAY, TICKS_PER_HOUR, Zone, CitizenState, FleetKind, KIND_NAMES, TECH_BY_ID, LifeStage,
  DEATH, Cause, CAUSE_DIED, isIncident, restSpec, isRestKind, isFuneralKind, funeralFee, restDesign, plotSpots, serviceTick,
  hash2, nameFor, tileKey, parseKey, familyOf, GRAVE_PLAQUE,
  type HintId, type GraveSiteDTO, type DeceasedInfo, type RemembranceInfo, type FamilyRef, type FuneralDTO, type RestSpec,
} from '@msimcity/shared';
import type { Building, Citizen, World } from '../world';
import { noteIncome, ageOf, deathChance, HEALTH, MOODS } from './life';
import type { Mobile, FleetService, Unit, Stop } from './mobile';
import type { FireHarm } from './fires';
import { seasonHealthNow, SEASON_FX } from './weatherfx';

const DAY = TICKS_PER_DAY, TPH = TICKS_PER_HOUR, S = CitizenState;
/** a funeral trip's errand (Simulation.funeralTrip): there for the service, then home */
export const ERRAND_FUNERAL = 4;
/** where the body is (Dead.st) */
const Body = { Scene: 0, Carried: 1, Parlour: 2, Mortuary: 3, Service: 4, Rested: 5, Away: 6 } as const;
/** what a hearse stop is for (Stop.what) */
const Job = { Collect: 1, Fetch: 2, Service: 3 } as const;
/** bodies, bookings and services are looked at every this many ticks; resting places and funeral directors are looked up again every PLACES_EVERY */
const STEP_EVERY = 10, PLACES_EVERY = 100, GRAVES_EVERY = 25;
/** a body nobody has collected for this long goes to the funeral director anyway (a private ambulance) */
const COLLECT_GIVE_UP = DAY;
/** a service waits this long past its time for a hearse held up in traffic, then goes ahead without it */
const HEARSE_WAIT = Math.round(1.5 * TPH);
/** a mourner who comes late (or early) still stands at the grave this long */
const PAY_RESPECTS = Math.round(TPH / 3);

/** One person who died: the record the archive keeps, the body's progress and the estate until the funeral. */
export interface Dead {
  id: number; sn: number;
  /** game day of birth, tick of death, age at death, Cause */
  born: number; died: number; age: number; cause: number;
  /** family at death: a parent, the partner, the children; friends (only until the funeral) */
  par: number; partner: number; kids: number[]; friends?: number[];
  /** whose town they lived in (their home's parcel owner) and the home */
  owner: string; hx: number; hy: number;
  /** where the body was (a building's door), in words */
  at: [number, number]; where: string;
  st: number;
  /** the funeral director handling them, the mortuary they wait at, the resting place booked or theirs, its kind and the plot */
  fd?: [number, number]; mort?: [number, number]; rest?: [number, number]; restKind?: number; slot?: number;
  /** the service (tick), whether the mourners were sent, whether it was held; when they were laid to rest; when the body entered its present state */
  svc?: number; sent?: boolean; held?: boolean; rested?: number; since: number;
  /** the estate (their money, held until the funeral), what the fees took, who had the rest */
  estate: number; left?: number; fees?: number; heirs?: string[];
  /** who goes to the service: close family first, then friends */
  mourners?: number[];
  /** the news story of an incident (shared/news.ts) */
  story?: number;
  /** a demo's funeral drill: nobody died, and nothing is kept */
  drill?: boolean;
  /** the resting place was cleared, or the plaque taken down for a newer one: the record may go */
  gone?: boolean;
}
/** What the snapshot keeps (snapshot.ts `death`): the archive, the grieving, each player's first sight and first death. */
export interface DeathSave {
  dead: Dead[];
  /** [citizen id, until tick, deceased id] */
  grief: [number, number, number][];
  first: Record<string, number>;
  mourned: string[];
  held?: Record<string, number>;
}
/** A death in an incident, for the news (sim/news.ts death): where, whose, what building, how, and who. */
export interface DeathStoryEvent {
  x: number; y: number; owner: string; kind: number; cause: number;
  dead: { id: number; name: string; age: number }[];
}
/** Something for one owner (net.ts): a toast or an advisor hint; `first` the town's first death (the burial goal is due). */
export interface DeathNotice { owner: string; msg: string; hint?: HintId; first?: boolean }

/** What the death module needs from the simulation. */
export interface DeathHost {
  /** c sets off for the service at (x, y) (Simulation.funeralTrip); false when there is no way */
  funeralTrip(c: Citizen, x: number, y: number): boolean;
  /** the nearest staffed hospital-family building, or null */
  hospitalNear(x: number, y: number): Building | null;
  /** (x, y) is in a staffed hospital's cover */
  covered(x: number, y: number): boolean;
}

/** A resting place as the module knows it: its door, kind, plots (0 free, an id resting, -id booked) and the day's cremations. */
interface Place { x: number; y: number; ax: number; ay: number; kind: number; spec: RestSpec; owner: string; slots: number[]; cremDay: number; cremN: number; held: number }

/**
 * Death and remembrance (docs/remembrance.md, shared/src/remembrance.ts). The daily life step calls `lifeRoll`, which
 * rolls old age and illness as before (the same Math.random draw) and a hashed working day's accident; fires call
 * `harm` (Fires.onHarm) when a fire is out or a building blows up. Each death leaves a body and a record in the
 * archive (`dead`), grief in the family and the estate held for the funeral.
 *
 * The hearse is a fleet vehicle (sim/mobile.ts) driven by a funeral director's staff: this module is its FleetService.
 * It collects the body; at the funeral director's a resting place in reach is booked (a plot, or a crematorium's day)
 * and the service set two to four days on; mourners set off an hour before, the hearse three quarters of an hour; the
 * hearse stands at the chapel through the service, then the burial fills the plot, the fees go to the owners and the
 * estate to the heirs. With nowhere to book, the body waits at the hospital mortuary (the funeral director's when there
 * is none), the building shows No burial space and the families grieve longer; with no funeral director in reach (or
 * before Remembrance), the county takes it out of town.
 *
 * Per-person rolls are hashes (hash2), never extra Math.random draws, so a world's shared stream is as before. Nothing
 * runs per tick but a look at the bodies in hand every STEP_EVERY ticks.
 */
export class Death implements FleetService {
  readonly kinds = [FleetKind.Hearse] as const;
  /** the archive, by deceased id (oldest first) */
  readonly dead = new Map<number, Dead>();
  /** counters since the simulation started (probes) */
  stats = { deaths: 0, oldAge: 0, illness: 0, fire: 0, explosion: 0, accident: 0, spared: 0, collected: 0, byHearse: 0, services: 0, withHearse: 0, noHearse: 0, buried: 0, cremated: 0, mortuary: 0, away: 0, fees: 0, inherited: 0, evicted: 0, drills: 0 };
  /** notices for owners (net.ts drains them) */
  notices: DeathNotice[] = [];
  /** the graves message is due (net.ts) */
  changed = true;
  /** a sandbox (test city, demo): no first-hour grace, no first-death moment */
  sandbox = false;
  /** a demo's funeral drills: a funeral director and the resting place its pretend funerals go to (index.ts) */
  drills: { fd: [number, number]; rest: [number, number] }[] = [];
  /** set by game.ts: the news of an incident's deaths (sim/news.ts death); returns the story's id */
  onStory: ((e: DeathStoryEvent) => number | undefined) | null = null;
  /** set by game.ts: issue bubbles look again at a tile (the No burial space badge) */
  look: ((x: number, y: number) => void) | null = null;
  /** self-timing for the load test */
  ms = 0;

  private places = new Map<string, Place>();
  private fds: Building[] = [];
  private placesAt = -Infinity;
  /** citizen id -> [until tick, deceased id] */
  private grief = new Map<number, [number, number]>();
  /** close family's funeral day off: citizen id -> game day */
  private dayOff = new Map<number, number>();
  /** each player's first sight (the first-hour grace), and the owners whose town has had its first death */
  private first: Record<string, number> = {};
  private mourned = new Set<string>();
  /** the mortuaries showing No burial space now */
  private badged = new Set<string>();
  /** hearse units out, by deceased id (not saved: a loaded world sends them again) */
  private hearse = new Map<number, number>();
  private nextDrill = 0;
  private heldAt: Record<string, number> = {};

  constructor(private w: World, private mobile: Mobile, private host: DeathHost, private life: { deaths: number; deathsOldAge: number; deathsIllness: number }) {
    const s = w.deathLoaded;
    if (s) {
      for (const d of s.dead ?? []) if (d && Number.isInteger(d.id) && Number.isFinite(d.died)) this.dead.set(d.id, { ...d, sent: d.st === Body.Rested ? d.sent : false });
      for (const [id, until, of] of s.grief ?? []) if (until > w.tick) this.grief.set(id, [until, of]);
      this.first = { ...(s.first ?? {}) };
      for (const o of s.mourned ?? []) this.mourned.add(o);
      this.heldAt = { ...(s.held ?? {}) };
      w.deathLoaded = null;
    }
    for (const [id] of this.grief) { const c = w.citizens.get(id); if (c) this.setMood(c); }
    // the dead still waiting for burial space when the world was saved badge their mortuaries again
    for (const d of this.dead.values()) if (d.st === Body.Mortuary && d.svc === undefined && d.mort) this.badged.add(tileKey(...d.mort));
    w.deathSave = () => this.save();
  }

  // ---- dying ---------------------------------------------------------------------------------------------------

  /**
   * The daily life step's death (Simulation.lifeStep): old age and illness rolled as they always were (deathChance and
   * one Math.random draw), a fatal accident for someone at work in a works or on a building site (a hash of the id and
   * the day). True when c died: they are gone from the world.
   */
  lifeRoll(c: Citizen, age: number): boolean {
    const w = this.w, p = deathChance(age, c.health, SEASON_FX ? seasonHealthNow(w).stress : 0); // a heatwave or cold snap is harder on the elderly (W5)
    if (p > 0 && Math.random() < p) {
      const cause = c.health < HEALTH.poorHealthBelow ? Cause.Illness : Cause.OldAge;
      if (!DEATH.on) { this.count(cause); w.removeCitizen(c); return true; }
      if (this.spared(c)) { this.stats.spared++; return false; }
      this.die(c, cause);
      return true;
    }
    if (!DEATH.on || !c.job || (c.state !== S.Work && c.state !== S.AtSite)) return false;
    const fam = familyOf(c.kind);
    if (fam !== Zone.Industrial && fam !== Zone.Yard) return false;
    let q = fam === Zone.Industrial ? DEATH.accidentIndustrial : DEATH.accidentYard;
    if (this.host.covered(c.wx, c.wy)) q *= DEATH.accidentCovered;
    if (hash2(c.id * 31 + Math.floor(w.tick / DAY), 631) >= q || this.spared(c)) return false;
    const at: [number, number] = c.state === S.AtSite && c.site ? parseKey(c.site) as [number, number] : [c.wx, c.wy];
    const b = w.buildings.get(tileKey(...at));
    this.die(c, Cause.Accident, at, `in an accident at ${this.named(at[0], at[1])}`);
    const d = this.dead.get(c.id);
    if (d) this.story(at[0], at[1], b?.id ?? c.kind, Cause.Accident, [d]);
    return true;
  }

  /**
   * A fire is out, or a building blew up (sim/fires.ts onHarm), before the damage is done: each person in the building
   * dies with the incident's odds (DEATH.fire*, blast*), a hash of their id and the fire's. The warning fire and the
   * drills harm nobody, nor any fire in a town's first hour.
   */
  harm(e: FireHarm) {
    if (!DEATH.on || e.warning || e.drill) return;
    let p: number, cause: number;
    if (e.kind === 'blast') { p = e.levelled ? DEATH.blastLevelled : DEATH.blastSource; cause = Cause.Explosion; }
    else if (e.levelled) return; // the blast that levelled it already took its toll
    else if (e.burnt) { p = DEATH.fireUnattended; cause = Cause.Fire; }
    else if (e.crew) { const d = Math.max(0, Math.min(1, e.d ?? 0)); p = DEATH.fireAttended * d * d; cause = Cause.Fire; }
    else return; // the bucket chain had it
    if (p <= 0) return;
    const victims: Citizen[] = [];
    for (const c of this.inside(e.x, e.y)) if (hash2(c.id * 7 + e.id, e.kind === 'blast' ? 641 : 643) < p && !this.spared(c)) victims.push(c);
    if (!victims.length) return;
    const what = this.named(e.x, e.y), dead: Dead[] = [];
    for (const c of victims) {
      this.die(c, cause, [e.x, e.y], cause === Cause.Explosion ? `in the explosion at ${what}` : `in the fire at ${what}`);
      const d = this.dead.get(c.id);
      if (d) dead.push(d);
    }
    this.story(e.x, e.y, e.building, cause, dead);
  }

  /** The people in the building whose door is (x, y): at home, at work, on a visit or building it. */
  private inside(x: number, y: number): Citizen[] {
    const key = tileKey(x, y), out: Citizen[] = [];
    for (const c of this.w.citizens.values()) {
      if (c.mig) continue;
      if ((c.state === S.Home && c.hx === x && c.hy === y) || (c.state === S.Work && c.job && c.wx === x && c.wy === y)
        || (c.state === S.AtVenue && c.venue === key) || (c.state === S.AtSite && c.site === key)) out.push(c);
    }
    return out;
  }

  /** The first-hour safety rail: nobody in a player's town dies in their first real hour (not on the Commons, not in a sandbox). */
  private spared(c: Citizen): boolean {
    if (this.sandbox) return false;
    const owner = this.w.parcelAt(c.hx, c.hy)?.owner;
    if (!owner || owner === 'sys') return false;
    const p = this.w.players.get(owner);
    const start = Math.min(this.first[owner] ??= this.w.tick, p?.ranks?.at?.[0] ?? Infinity);
    return this.w.tick - start < DEATH.graceTicks;
  }

  private count(cause: number) {
    this.life.deaths++;
    if (cause === Cause.Illness) this.life.deathsIllness++;
    else if (cause === Cause.OldAge) this.life.deathsOldAge++;
    this.stats.deaths++;
    this.stats[cause === Cause.OldAge ? 'oldAge' : cause === Cause.Illness ? 'illness' : cause === Cause.Fire ? 'fire' : cause === Cause.Explosion ? 'explosion' : 'accident']++;
  }

  /**
   * c has died of `cause`: the record, the body (at `at`, or wherever they were), grief for the family, and the citizen
   * leaves the world (the bed, the job and every link go as they always did).
   */
  die(c: Citizen, cause: number, at?: [number, number], where?: string) {
    const w = this.w, now = w.tick;
    this.count(cause);
    if (!at) [at, where] = this.placeOf(c);
    const owner = w.parcelAt(c.hx, c.hy)?.owner ?? '';
    const kids: number[] = [];
    for (const o of w.citizens.values()) if (o.par === c.id && o.id !== c.id) kids.push(o.id);
    const partner = c.partner && w.citizens.has(c.partner) ? c.partner : 0;
    const d: Dead = {
      id: c.id, sn: c.sn, born: c.born, died: now, age: Math.floor(ageOf(c, now)), cause, par: c.par, partner, kids,
      friends: c.friends.filter((f) => w.citizens.has(f)).slice(0, DEATH.friendsMax), owner, hx: c.hx, hy: c.hy,
      at, where: where ?? 'at home', st: Body.Scene, since: now, estate: Math.max(0, Math.round(c.money)),
    };
    w.removeCitizen(c);
    this.dead.set(d.id, d);
    // the close family grieve: partner, children, the parent
    for (const id of [partner, ...kids, c.par]) if (id) this.mourn(id, d, now + DEATH.griefDays * DAY);
    const fd = this.funeralFor(at[0], at[1]);
    if (fd) d.fd = [fd.x, fd.y];
    else this.away(d);
    if (owner && owner !== 'sys' && !this.sandbox && !this.mourned.has(owner)) this.firstDeath(d);
    this.evict();
    this.changed = true;
  }

  /** Where c is now, as a building's door to collect from: home, work, a site or a venue; on the way somewhere, the hospital (or home). */
  private placeOf(c: Citizen): [[number, number], string] {
    const w = this.w;
    if (c.state === S.Home) return [[c.hx, c.hy], 'at home'];
    if (c.state === S.Work && c.job) return [[c.wx, c.wy], `at work at ${this.named(c.wx, c.wy)}`];
    if (c.state === S.AtSite && c.site) { const [x, y] = parseKey(c.site); return [[x, y], 'on a building site']; }
    if (c.state === S.AtVenue && c.venue && w.buildings.has(c.venue)) { const [x, y] = parseKey(c.venue); return [[x, y], `at ${this.named(x, y)}`]; }
    const h = this.host.hospitalNear(Math.floor(c.x), Math.floor(c.y));
    if (h) return [[h.x, h.y], `in hospital, taken ill on the way ${c.state === S.ToWork ? 'to work' : 'home'}`];
    return [[c.hx, c.hy], 'at home'];
  }

  /** The town's first death: the advisor's line and the burial goal (goals.ts), like the warning fire. */
  private firstDeath(d: Dead) {
    this.mourned.add(d.owner);
    const name = nameFor(d.id, d.sn), p = this.w.players.get(d.owner), t = TECH_BY_ID.get('rem1');
    const tech = !t || p?.tech.includes(t.id);
    const next = d.st === Body.Away
      ? tech ? 'With no funeral director in reach, the county is taking them out of town and the family will grieve longer: place a funeral director and a churchyard, cemetery or crematorium.'
        : `Until your town can bury its dead, the county takes them out of town and the family grieves longer. Remembrance (T${t ? `, at ${t.condition.min} residents` : ''}) brings a funeral director, churchyards and a crematorium.`
      : 'The funeral director is collecting them; the service follows in a few days.';
    this.notices.push({ owner: d.owner, hint: 'death', first: true, msg: `${name} (${d.age}) has died ${d.where}, the first death in your town. ${next}` });
  }

  /** An incident's deaths make the news (one story for all of them); the story's id goes on each record. */
  private story(x: number, y: number, kind: number, cause: number, dead: Dead[]) {
    if (!dead.length || !isIncident(cause)) return;
    const owner = this.w.parcelAt(x, y)?.owner ?? '';
    const id = this.onStory?.({ x, y, owner, kind, cause, dead: dead.map((d) => ({ id: d.id, name: nameFor(d.id, d.sn), age: d.age })) });
    if (id !== undefined) for (const d of dead) d.story = id;
    if (owner && owner !== 'sys') {
      const n = dead.length, first = `${nameFor(dead[0].id, dead[0].sn)} (${dead[0].age})`;
      const why = cause === Cause.Fire ? ': a fire crew that comes quickly saves lives, and a fire post covers 14 tiles' : cause === Cause.Accident ? '; a hospital in reach makes accidents at work rarer' : '';
      this.notices.push({ owner, msg: `${n > 1 ? `${n} people died` : `${first} died`} ${dead[0].where}${why}` });
    }
  }

  // ---- grief -----------------------------------------------------------------------------------------------------

  /** Citizen `id` grieves for d until at least `until` (never past DEATH.griefMaxDays from the death). */
  private mourn(id: number, d: Dead, until: number) {
    const c = this.w.citizens.get(id);
    if (!c) return;
    const cap = d.died + DEATH.griefMaxDays * DAY, g = this.grief.get(id);
    this.grief.set(id, [Math.min(cap, Math.max(until, g && g[1] === d.id ? g[0] : until)), d.id]);
    this.setMood(c);
  }
  /** The happiness part of a grieving citizen (life.ts MOODS): worse while the body still waits to be buried. */
  private setMood(c: Citizen) {
    MOODS.set(c, (tick) => {
      const g = this.grief.get(c.id);
      if (!g || tick >= g[0]) return null;
      const d = this.dead.get(g[1]);
      const waiting = d && (d.st === Body.Mortuary || d.st === Body.Away);
      return waiting ? { label: 'waiting to bury a loved one', delta: DEATH.griefWaitMood } : { label: 'grieving', delta: DEATH.griefMood };
    });
  }
  /** Who grieves for d now. */
  private mournersOf(d: Dead): number[] { const out: number[] = []; for (const [id, g] of this.grief) if (g[1] === d.id) out.push(id); return out; }
  /** Grief, and the deceased, for a citizen's panel. */
  grievingFor(c: Citizen): string | undefined {
    const g = this.grief.get(c.id);
    if (!g || this.w.tick >= g[0]) return undefined;
    const d = this.dead.get(g[1]);
    return d ? `grieving for ${nameFor(d.id, d.sn)}, ${Math.max(1, Math.ceil((g[0] - this.w.tick) / DAY))} more day${g[0] - this.w.tick > DAY ? 's' : ''}` : undefined;
  }

  /**
   * Does c stay home from this shift (Simulation.depart)? Close family on the day of the funeral, and a grieving worker
   * now and then (a hash of the id and the day): those are sick days.
   */
  /** Is today c's funeral day off (close family of someone laid to rest today)? Pure: no sick day is taken. Simulation.shareToWork asks before offering a lift to work, as depart does before setting off. */
  offToday(c: Citizen): boolean { return this.dayOff.get(c.id) === Math.floor(this.w.tick / DAY); }
  staysHome(c: Citizen): boolean {
    const day = Math.floor(this.w.tick / DAY);
    if (this.offToday(c)) return true;
    const g = this.grief.get(c.id);
    if (!g || this.w.tick >= g[0] || hash2(c.id * 13 + day, 651) >= DEATH.griefSkip) return false;
    c.sickDays++; c.offSickDay = day;
    return true;
  }
  /** When the service c went to ends (Simulation.arriveVenue, a funeral errand). */
  serviceEnd(c: Citizen): number {
    const end = (d: Dead) => (d.st === Body.Service ? d.since : Math.max(d.svc!, this.w.tick)) + this.serviceTicks();
    const at = this.w.tick + PAY_RESPECTS; // late, or the service already over: a while at the grave all the same
    for (const d of this.dead.values()) if (d.svc !== undefined && !d.held && d.rest && c.venue === tileKey(...d.rest) && d.mourners?.includes(c.id)) return Math.max(at, end(d));
    for (const d of this.drillsLive) if (d.mourners?.includes(c.id)) return Math.max(at, end(d));
    return at;
  }
  private serviceTicks() { return Math.round(DEATH.serviceHours * TPH); }

  // ---- the body's way ------------------------------------------------------------------------------------------

  /** The nearest staffed funeral director within DEATH.funeralReach of (x, y). */
  private funeralFor(x: number, y: number): Building | null {
    this.refresh();
    let best: Building | null = null, bd = Infinity;
    for (const b of this.fds) {
      const dd = Math.abs(b.x - x) + Math.abs(b.y - y);
      if (dd <= DEATH.funeralReach && dd < bd) { bd = dd; best = b; }
    }
    return best;
  }
  /** No funeral director in reach: the county takes the body out of town. */
  private away(d: Dead) {
    d.st = Body.Away; d.since = this.w.tick; d.fd = undefined;
    this.stats.away++;
    for (const id of this.mournersOf(d)) this.mourn(id, d, this.w.tick + DEATH.awayDays * DAY + DEATH.griefAfterService * DAY);
  }

  /** Book d a resting place in reach of their funeral director, and the service; false when nowhere has room. */
  private book(d: Dead): boolean {
    const w = this.w, now = w.tick;
    const from = d.fd ?? d.at;
    const svc = Math.max(serviceTick(d.id, now), now + DAY / 2);
    const svcDay = Math.floor(svc / DAY);
    let best: Place | null = null, bd = Infinity, slot = -1;
    for (const pl of this.places.values()) {
      const dd = Math.abs(pl.x - from[0]) + Math.abs(pl.y - from[1]);
      if (dd > DEATH.restReach || dd >= bd) continue;
      if (pl.spec.type === 'cremation') {
        if (this.cremationsOn(pl, svcDay) >= pl.spec.cremations) continue;
        best = pl; bd = dd; slot = -1;
      } else {
        const i = pl.slots.indexOf(0);
        if (i < 0) continue;
        best = pl; bd = dd; slot = i;
      }
    }
    if (!best) return false;
    d.rest = [best.x, best.y]; d.restKind = best.kind; d.svc = svc; d.sent = false;
    if (slot >= 0) { d.slot = slot; best.slots[slot] = -d.id; }
    // mourners: close family, then friends; close family take the day off
    const close = [d.partner, ...d.kids, d.par].filter((id) => id && w.citizens.has(id));
    for (const id of close) this.dayOff.set(id, svcDay);
    d.mourners = [...new Set([...close, ...(d.friends ?? []).filter((id) => w.citizens.has(id))])].slice(0, DEATH.mournersMax);
    this.changed = true;
    return true;
  }
  /** Cremations booked at a crematorium on a game day. */
  private cremationsOn(pl: Place, day: number): number {
    let n = 0;
    for (const d of this.dead.values()) if (d.rest && d.rest[0] === pl.x && d.rest[1] === pl.y && d.svc !== undefined && Math.floor(d.svc / DAY) === day) n++;
    return n;
  }

  /** The body has reached the funeral director's: book, or wait at the mortuary. */
  private atParlour(d: Dead) {
    d.st = Body.Parlour; d.since = this.w.tick;
    this.stats.collected++;
    if (this.book(d)) return;
    const fd = d.fd!, h = this.host.hospitalNear(fd[0], fd[1]);
    d.mort = h && Math.abs(h.x - fd[0]) + Math.abs(h.y - fd[1]) <= DEATH.funeralReach ? [h.x, h.y] : fd;
    d.st = Body.Mortuary;
    this.stats.mortuary++;
    for (const id of this.mournersOf(d)) this.mourn(id, d, this.w.tick + DEATH.griefWaitDays * DAY);
    this.badge(d.mort);
    if (d.owner && d.owner !== 'sys') this.notices.push({ owner: d.owner, hint: 'burial', msg: `No burial space: ${nameFor(d.id, d.sn)} is waiting at the ${this.w.buildings.get(tileKey(...d.mort))?.id === undefined ? 'mortuary' : `${KIND_NAMES[this.w.buildings.get(tileKey(...d.mort))!.id]}'s mortuary`} at (${d.mort[0]}, ${d.mort[1]}), and the family grieves longer. Build a churchyard, cemetery or crematorium within ${DEATH.restReach} tiles.` });
  }

  /** Laid to rest: the plot or plaque, the fees to the owners, the estate to the heirs, the grief's end. */
  private rest(d: Dead) {
    const w = this.w, now = w.tick;
    if (d.st === Body.Rested) return;
    const pl = d.rest ? this.places.get(tileKey(...d.rest)) : undefined;
    const wasWaiting = d.mort !== undefined || d.st === Body.Away;
    if (d.mort) { const m = d.mort; d.mort = undefined; this.unbadge(m); }
    if (pl && pl.spec.type === 'burial' && d.slot !== undefined) { pl.slots[d.slot] = d.id; this.stats.buried++; }
    else if (pl && pl.spec.type === 'cremation') {
      // the newest plaque replaces the oldest in the garden of remembrance
      const n = plotSpots(pl.kind, restDesign(pl.kind, pl.ax, pl.ay)).length;
      if (n) {
        const i = pl.held % n, old = pl.slots[i];
        if (old > 0) { const od = this.dead.get(old); if (od) { od.slot = undefined; od.gone = true; } }
        pl.slots[i] = d.id; d.slot = i;
      }
      this.stats.cremated++;
    }
    if (pl) { pl.held++; this.heldAt[tileKey(pl.x, pl.y)] = pl.held; }
    // the fees, out of the estate: the funeral director's, the resting place's (or the county's)
    const fdB = d.fd ? w.buildings.get(tileKey(...d.fd)) : undefined;
    const fdFee = fdB && isFuneralKind(fdB.id) ? funeralFee(fdB.id) : 0, restFee = pl ? pl.spec.fee : pl === undefined && !d.rest ? DEATH.countyFee : 0;
    const due = fdFee + restFee, paid = Math.min(d.estate, due);
    d.left = d.estate;
    if (paid > 0 && due > 0) {
      const toFd = Math.round(paid * fdFee / due), toRest = paid - toFd;
      const fdOwner = d.fd ? w.parcelAt(d.fd[0], d.fd[1])?.owner : undefined;
      if (fdOwner && toFd > 0) w.credit(fdOwner, toFd, 'funeral');
      if (pl && toRest > 0) w.credit(pl.owner, toRest, 'burial');
      this.stats.fees += paid;
    }
    d.fees = paid; d.estate -= paid;
    this.inherit(d);
    d.st = Body.Rested; d.rested = now; d.held = true;
    // a funeral on time ends the grief soon after; one that waited has had its grief lengthened already
    for (const id of this.mournersOf(d)) {
      const g = this.grief.get(id)!;
      if (!wasWaiting) this.grief.set(id, [Math.min(g[0], now + DEATH.griefAfterService * DAY), d.id]);
      else this.grief.set(id, [Math.min(d.died + DEATH.griefMaxDays * DAY, Math.max(g[0], now + DEATH.griefAfterService * DAY)), d.id]);
    }
    // the record keeps what the headstone and the family tree need
    d.friends = undefined; d.mourners = undefined; d.sent = undefined;
    this.changed = true;
  }
  /** Money passes to the partner, then the children (shared), then the parent; the home stays with whoever still lives in it. */
  private inherit(d: Dead) {
    const w = this.w, live = (id: number) => (id ? w.citizens.get(id) : undefined);
    const heirs: Citizen[] = [];
    const p = live(d.partner);
    if (p) heirs.push(p);
    else for (const id of d.kids) { const k = live(id); if (k) heirs.push(k); }
    if (!heirs.length) { const pa = live(d.par); if (pa) heirs.push(pa); }
    d.heirs = [];
    if (!heirs.length || d.estate <= 0) { if (heirs.length) d.heirs = heirs.map((h) => nameFor(h.id, h.sn)); d.estate = 0; return; }
    const share = Math.floor(d.estate / heirs.length);
    for (const h of heirs) { h.money += share; noteIncome(h, share, w.tick); d.heirs.push(`${nameFor(h.id, h.sn)} ($${share.toLocaleString('en-GB')})`); }
    this.stats.inherited += share * heirs.length;
    d.estate = 0;
  }

  // ---- the hearse (sim/mobile.ts FleetService) ----------------------------------------------------------------------

  /** Every tick (Mobile.tick): every STEP_EVERY ticks, the bodies in hand, the services due and the drills. */
  tick() {
    const now = this.w.tick;
    if (now % STEP_EVERY !== 7) return;
    const t0 = performance.now();
    this.refresh();
    for (const d of this.dead.values()) {
      if (d.st === Body.Rested) continue;
      this.step(d, now);
    }
    if (this.drills.length) this.drillStep(now);
    if (now % GRAVES_EVERY === 7 && this.anyService()) this.changed = true; // mourners arriving at a service under way
    this.ms += performance.now() - t0;
  }
  private anyService() { for (const d of this.dead.values()) if (d.st === Body.Service) return true; return this.drillsLive.some((d) => d.st === Body.Service); }

  private step(d: Dead, now: number) {
    switch (d.st) {
      case Body.Away:
        if (now - d.since >= DEATH.awayDays * DAY) this.rest(d);
        return;
      case Body.Scene: {
        const fd = d.fd ? this.w.buildings.get(tileKey(...d.fd)) : undefined;
        if (!fd || !isFuneralKind(fd.id)) { const f = this.funeralFor(d.at[0], d.at[1]); if (f) d.fd = [f.x, f.y]; else { this.away(d); return; } }
        if (this.hearse.has(d.id)) return;
        if (now - d.since > COLLECT_GIVE_UP) { this.atParlour(d); return; } // nobody came: a private ambulance took them
        this.send(d, [this.mobile.stopAt(d.at[0], d.at[1], DEATH.collectDwell, Job.Collect, d.id)], `collecting the late ${nameFor(d.id, d.sn)} from ${this.named(d.at[0], d.at[1])}`);
        return;
      }
      case Body.Carried: return; // in the hearse on its way back
      case Body.Mortuary:
        if (d.svc === undefined) {
          if (Math.floor(now / TPH) % DEATH.mortuaryCheckHours !== 0 || now % TPH >= STEP_EVERY) return;
          if (now - d.since > DEATH.mortuaryMaxDays * DAY) { const m = d.mort; d.mort = undefined; if (m) this.unbadge(m); this.away(d); return; }
          if (!this.book(d)) { for (const id of this.mournersOf(d)) this.mourn(id, d, now + DEATH.griefWaitDays * DAY); return; }
          this.unbadge(d.mort!); // booked: the hearse fetches them on the day; the badge goes once nobody there is left waiting
        }
        this.serviceStep(d, now);
        return;
      case Body.Parlour:
        if (d.svc === undefined && !this.book(d)) { this.atParlour(d); return; }
        this.serviceStep(d, now);
        return;
      case Body.Service:
        if (!this.hearse.has(d.id) && now >= d.since + this.serviceTicks()) this.rest(d); // held without the hearse
        return;
    }
  }

  /** A booked service: the resting place still there, mourners off an hour before, the hearse three quarters, or without it. */
  private serviceStep(d: Dead, now: number) {
    const svc = d.svc!, pl = d.rest ? this.places.get(tileKey(...d.rest)) : undefined;
    if (!pl) { if (d.slot !== undefined) d.slot = undefined; d.svc = undefined; d.rest = undefined; return; } // cleared meanwhile: book again
    if (!d.sent && now >= svc - DEATH.mournerLeadHours * TPH) { d.sent = true; this.sendMourners(d); }
    if (this.hearse.has(d.id)) {
      // the hearse is on its way: the service waits for it, but not past HEARSE_WAIT
      if (now >= svc + HEARSE_WAIT) { this.stats.noHearse++; this.startService(d); }
      return;
    }
    if (now >= svc) { this.stats.noHearse++; this.startService(d); return; } // no hearse to be had: the service goes ahead at the chapel all the same
    if (now < svc - DEATH.hearseLeadHours * TPH) return;
    const stops: Stop[] = [];
    if (d.st === Body.Mortuary && d.mort && (d.mort[0] !== d.fd?.[0] || d.mort[1] !== d.fd?.[1])) stops.push(this.mobile.stopAt(d.mort[0], d.mort[1], DEATH.collectDwell, Job.Fetch, d.id));
    stops.push(this.mobile.stopAt(pl.x, pl.y, this.serviceTicks(), Job.Service, d.id));
    this.send(d, stops, `${stops.length > 1 ? 'fetching' : 'carrying'} the late ${nameFor(d.id, d.sn)} ${stops.length > 1 ? 'from the mortuary' : ''} to ${this.named(pl.x, pl.y)}`.replace('  ', ' '));
  }
  private sendMourners(d: Dead) {
    const pl = d.rest!;
    for (const id of d.mourners ?? []) {
      const c = this.w.citizens.get(id);
      if (!c || c.mig || (c.state !== S.Home && c.state !== S.AtVenue)) continue;
      if (c.state === S.AtVenue && c.errand) continue;
      if (c.stage === LifeStage.Child && ageOf(c, this.w.tick) < 6) continue; // the little ones stay with a neighbour
      if (c.state === S.AtVenue) continue; // out already; they hear of it later
      this.host.funeralTrip(c, pl[0], pl[1]);
    }
  }
  private startService(d: Dead) {
    if (d.mort) { const m = d.mort; d.mort = undefined; this.unbadge(m); }
    d.st = Body.Service; d.since = this.w.tick;
    this.stats.services++;
    this.changed = true;
  }

  /** Put a hearse on the road for d from its funeral director, if a driver there is free. */
  private send(d: Dead, stops: Stop[], task: string): boolean {
    const fd = d.fd;
    if (!fd) return false;
    for (const c of this.mobile.onShift(FleetKind.Hearse)) {
      if (c.wx !== fd[0] || c.wy !== fd[1] || !this.mobile.free(c)) continue;
      const u = this.mobile.launch(this, c, FleetKind.Hearse, fd, fd, stops, task);
      if (!u) return false;
      this.hearse.set(d.id, u.v.id);
      return true;
    }
    return false;
  }
  private deadOf(u: Unit): Dead | undefined {
    for (const [id, v] of this.hearse) if (v === u.v.id) return this.dead.get(id) ?? this.drillsLive.find((d) => d.id === id);
    return undefined;
  }

  arrive(u: Unit, s: Stop) {
    const d = this.dead.get(s.ref) ?? this.drillsLive.find((x) => x.id === s.ref);
    if (!d) return;
    if (s.what === Job.Collect || s.what === Job.Fetch) {
      u.loaded = true; u.task = `carrying the late ${nameFor(d.id, d.sn)}${s.what === Job.Collect ? ' to the funeral director' : ` to ${this.named(d.rest?.[0] ?? 0, d.rest?.[1] ?? 0)}`}`;
      if (s.what === Job.Collect) { d.st = Body.Carried; this.stats.byHearse++; }
      if (s.what === Job.Fetch && d.mort) { const m = d.mort; d.mort = undefined; this.unbadge(m); }
      return;
    }
    // at the chapel: the service (unless it went ahead without the hearse); the hearse stands there until it ends
    if (d.st !== Body.Service) { if (!d.drill) { this.startService(d); this.stats.withHearse++; } else { d.st = Body.Service; d.since = this.w.tick; this.changed = true; } }
    u.dwellUntil = Math.max(u.dwellUntil, d.since + this.serviceTicks());
    u.task = `at the funeral of ${nameFor(d.id, d.sn)}`;
  }
  depart(u: Unit, s: Stop) {
    const d = this.dead.get(s.ref) ?? this.drillsLive.find((x) => x.id === s.ref);
    if (!d || s.what !== Job.Service) return;
    u.loaded = false; u.task = 'back to the funeral director';
    if (d.drill) this.drillDone(d); else this.rest(d);
    this.hearse.delete(d.id);
    this.mobile.note(u, 0);
  }
  unreachable(u: Unit, s: Stop) {
    const d = this.dead.get(s.ref) ?? this.drillsLive.find((x) => x.id === s.ref);
    if (!d) return;
    if (s.what === Job.Collect) { this.hearse.delete(d.id); this.atParlour(d); } // taken another way
    else if (s.what === Job.Service) { this.hearse.delete(d.id); if (d.drill) this.drillDone(d); else if (d.st !== Body.Service) this.startService(d); }
  }
  withdrawn(u: Unit) {
    const d = this.deadOf(u);
    if (!d) return;
    this.hearse.delete(d.id);
    if (d.drill) { this.drillDone(d); return; }
    if (d.st === Body.Carried) this.atParlour(d); // set down at the funeral director's all the same
    else if (d.st === Body.Service) this.rest(d);
  }
  returned(u: Unit) {
    const d = this.deadOf(u);
    if (!d) return;
    this.hearse.delete(d.id);
    if (d.st === Body.Carried) this.atParlour(d);
  }
  label(u: Unit) {
    const fd = this.w.buildings.get(tileKey(...u.base));
    return fd ? `${this.named(fd.x, fd.y).replace(/^the /, '')} hearse` : 'hearse';
  }
  baseName(c: Citizen) { return this.named(c.wx, c.wy).replace(/^the /, ''); }

  // ---- resting places and the badge ----------------------------------------------------------------------------

  /** Funeral directors (staffed) and resting places, looked up again every PLACES_EVERY ticks; plots rebuilt from the archive. */
  private refresh() {
    const w = this.w, now = w.tick;
    if (now - this.placesAt < PLACES_EVERY) return;
    this.placesAt = now;
    this.fds = w.builtOf(Zone.Office).filter((b) => isFuneralKind(b.id) && b.level > 0 && b.occupants > 0 && !w.mothballed.has(tileKey(b.x, b.y)));
    this.fds.sort((a, b) => a.x - b.x || a.y - b.y);
    const seen = new Set<string>();
    for (const b of w.builtOf(10)) {
      if (!isRestKind(b.id) || b.level <= 0 || w.mothballed.has(tileKey(b.x, b.y))) continue;
      const key = tileKey(b.x, b.y);
      seen.add(key);
      let pl = this.places.get(key);
      if (!pl || pl.kind !== b.id) {
        const s = w.structureAt(b.x, b.y), ax = s ? s.ax : b.x, ay = s ? s.ay : b.y, spec = restSpec(b.id)!;
        const n = plotSpots(b.id, restDesign(b.id, ax, ay)).length;
        pl = { x: b.x, y: b.y, ax, ay, kind: b.id, spec, owner: w.parcelAt(b.x, b.y)?.owner ?? '', slots: new Array(n).fill(0), cremDay: -1, cremN: 0, held: this.heldAt[key] ?? 0 };
        for (const d of this.dead.values()) {
          if (!d.rest || d.rest[0] !== b.x || d.rest[1] !== b.y || d.slot === undefined || d.gone || d.slot >= n) continue;
          if (d.st === Body.Rested) pl.slots[d.slot] = d.id; else if (spec.type === 'burial') pl.slots[d.slot] = -d.id;
        }
        this.places.set(key, pl);
        this.changed = true;
      }
      pl.owner = w.parcelAt(b.x, b.y)?.owner ?? pl.owner;
    }
    // resting places cleared away: their records lose their headstones (and may go)
    for (const [key, pl] of this.places) {
      if (seen.has(key)) continue;
      this.places.delete(key);
      for (const d of this.dead.values()) if (d.rest && d.rest[0] === pl.x && d.rest[1] === pl.y) { if (d.st === Body.Rested) d.gone = true; else { d.rest = undefined; d.slot = undefined; d.svc = undefined; } }
      this.changed = true;
    }
  }

  /** Bodies waiting for burial space at a door tile (sim/issues.ts: the No burial space badge). */
  noSpaceAt(x: number, y: number): boolean { return this.badged.size > 0 && this.badged.has(tileKey(x, y)); }
  private badge(at: [number, number]) { const k = tileKey(...at); if (!this.badged.has(k)) { this.badged.add(k); this.look?.(at[0], at[1]); } }
  /** Take the badge off a mortuary once no body there is still waiting for a place. */
  private unbadge(at: [number, number]) {
    const k = tileKey(...at);
    for (const d of this.dead.values()) if (d.st === Body.Mortuary && d.svc === undefined && d.mort && tileKey(...d.mort) === k) return;
    if (this.badged.delete(k)) this.look?.(at[0], at[1]);
  }

  /** Records beyond DEATH.archiveCap go, oldest first, except those whose headstone or plaque still stands or whose funeral is to come. */
  private evict() {
    if (this.dead.size <= DEATH.archiveCap) return;
    for (const [id, d] of this.dead) {
      if (this.dead.size <= DEATH.archiveCap) break;
      if (d.st !== Body.Rested) continue;
      if (!d.gone && d.slot !== undefined && d.rest && this.places.has(tileKey(...d.rest))) continue;
      this.dead.delete(id);
      this.stats.evicted++;
    }
  }

  // ---- the wire and the panels ---------------------------------------------------------------------------------

  /** Every resting place's filled plots and the funeral under way there (message `graves`). */
  graves(): GraveSiteDTO[] {
    this.refresh();
    const out: GraveSiteDTO[] = [];
    for (const pl of this.places.values()) {
      const g: number[] = [];
      const plaque = pl.spec.type === 'cremation' ? GRAVE_PLAQUE : 0;
      pl.slots.forEach((id, i) => { if (id > 0) { const d = this.dead.get(id); g.push(i, id, d?.rested ?? d?.died ?? 0, plaque); } });
      const f = this.funeralAt(pl);
      if (g.length || f) out.push({ x: pl.x, y: pl.y, g, ...(f ? { f } : {}) });
    }
    out.sort((a, b) => a.x - b.x || a.y - b.y);
    return out;
  }
  private funeralAt(pl: Place): FuneralDTO | undefined {
    const at = (d: Dead) => d.st === Body.Service && d.rest && d.rest[0] === pl.x && d.rest[1] === pl.y;
    const d = [...this.dead.values(), ...this.drillsLive].find(at);
    if (!d) return undefined;
    const key = tileKey(pl.x, pl.y);
    let n = 0;
    for (const id of d.mourners ?? []) { const c = this.w.citizens.get(id); if (c && c.state === S.AtVenue && c.errand === ERRAND_FUNERAL && c.venue === key) n++; }
    return { slot: d.drill ? this.drillSlot(pl) : d.slot ?? -1, id: d.id, t0: d.since, t1: d.since + this.serviceTicks(), n };
  }

  /** A building's remembrance lines: a funeral director, a resting place, a mortuary with bodies waiting. */
  panel(b: Building): RemembranceInfo | undefined {
    const key = tileKey(b.x, b.y);
    const planned = (match: (d: Dead) => boolean) => [...this.dead.values()].filter((d) => d.svc !== undefined && !d.held && match(d)).sort((a, c) => a.svc! - c.svc!).slice(0, 5)
      .map((d) => ({ at: d.svc!, id: d.id, name: nameFor(d.id, d.sn), place: d.rest ? this.named(d.rest[0], d.rest[1]) : '' }));
    const waitingHere = [...this.dead.values()].filter((d) => d.st === Body.Mortuary && d.mort && tileKey(...d.mort) === key);
    if (isFuneralKind(b.id)) {
      const mine = (d: Dead) => !!d.fd && tileKey(...d.fd) === key;
      const inHand = [...this.dead.values()].filter((d) => mine(d) && (d.st === Body.Parlour || d.st === Body.Carried || d.st === Body.Scene)).length;
      return { role: 'funeral', fee: funeralFee(b.id), waiting: inHand + waitingHere.length, noSpace: waitingHere.some((d) => d.svc === undefined), funerals: planned(mine), held: [...this.dead.values()].filter((d) => mine(d) && d.held).length };
    }
    if (isRestKind(b.id)) {
      this.refresh();
      const pl = this.places.get(key), spec = restSpec(b.id)!;
      const used = pl ? pl.slots.filter((s) => s > 0).length : 0, booked = pl ? pl.slots.filter((s) => s < 0).length : 0;
      const recent = pl ? [...pl.slots].filter((s) => s > 0).map((id) => this.dead.get(id)).filter((d): d is Dead => !!d).sort((a, c) => (c.rested ?? 0) - (a.rested ?? 0)).slice(0, 5)
        .map((d) => ({ id: d.id, name: nameFor(d.id, d.sn), died: d.died, age: d.age })) : [];
      const name = this.w.stopNames.get(key);
      return {
        role: spec.type, fee: spec.fee, ...(name ? { name } : {}), plots: { used, free: (pl?.slots.length ?? 0) - used - booked, booked }, recent,
        funerals: planned((d) => !!d.rest && tileKey(...d.rest) === key), held: pl?.held ?? 0,
      };
    }
    if (waitingHere.length) return { role: 'mortuary', waiting: waitingHere.length, noSpace: waitingHere.some((d) => d.svc === undefined) };
    return undefined;
  }

  /** A deceased person's panel (message `deceased`). */
  info(id: number): DeceasedInfo | null {
    const d = this.dead.get(id);
    if (!d) return null;
    const pl = d.rest ? this.places.get(tileKey(...d.rest)) : undefined;
    const states: Record<number, DeceasedInfo['state']> = { 0: 'awaiting', 1: 'awaiting', 2: 'parlour', 3: 'mortuary', 4: 'service', 6: 'away' };
    const state: DeceasedInfo['state'] = d.st === Body.Rested ? (d.gone ? 'gone' : !d.rest ? 'away' : restSpec(d.restKind ?? 0)?.type === 'cremation' ? 'cremated' : 'buried') : states[d.st];
    const restName = d.rest ? this.named(d.rest[0], d.rest[1]) : '';
    const stateText = {
      awaiting: 'waiting for the funeral director', parlour: `at the funeral director's${d.svc !== undefined ? ', the service planned' : ''}`,
      mortuary: d.svc !== undefined ? 'at the mortuary, the service planned' : 'waiting at the mortuary: no burial space in reach',
      service: `the funeral is under way at ${restName}`, away: d.st === Body.Rested ? 'laid to rest out of town by the county' : 'taken out of town by the county',
      buried: `buried at ${restName}`, cremated: `cremated at ${restName}`, gone: 'their resting place has been cleared',
    }[state];
    return {
      id: d.id, name: nameFor(d.id, d.sn), born: d.born, died: d.died, age: d.age, cause: d.cause, where: d.where, state, stateText,
      ...(d.rest && pl ? { rest: { x: d.rest[0], y: d.rest[1], kind: pl.kind, name: restName, ...(d.slot !== undefined ? { slot: d.slot } : {}) } } : {}),
      ...(d.svc !== undefined ? { funeral: { at: d.svc, place: restName, mourners: d.mourners?.length ?? 0, held: !!d.held } } : {}),
      family: this.family(d),
      ...(d.held ? { estate: { left: d.left ?? 0, fees: d.fees ?? 0, to: d.heirs ?? [] } } : {}),
      ...(d.story !== undefined ? { story: d.story } : {}),
    };
  }
  /** The family tree: parent, partner, children, grandchildren, siblings, friends; living (select them) or remembered. */
  private family(d: Dead): FamilyRef[] {
    const w = this.w, out: FamilyRef[] = [], seen = new Set<number>([d.id]);
    const add = (id: number, relation: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const c = w.citizens.get(id);
      if (c) { out.push({ id, name: nameFor(c.id, c.sn), relation, living: true, age: Math.floor(ageOf(c, w.tick)) }); return; }
      const o = this.dead.get(id);
      if (o) out.push({ id, name: nameFor(o.id, o.sn), relation, living: false, age: o.age });
    };
    add(d.par, 'parent');
    add(d.partner, 'partner');
    for (const o of this.dead.values()) if (o.partner === d.id) add(o.id, 'partner');
    const kids = new Set(d.kids);
    for (const o of this.dead.values()) if (o.par === d.id) kids.add(o.id);
    for (const c of w.citizens.values()) if (c.par === d.id) kids.add(c.id);
    for (const k of kids) add(k, 'child');
    for (const c of w.citizens.values()) if (c.par && kids.has(c.par)) add(c.id, 'grandchild');
    if (d.par) {
      for (const c of w.citizens.values()) if (c.par === d.par) add(c.id, 'sibling');
      for (const o of this.dead.values()) if (o.par === d.par) add(o.id, 'sibling');
    }
    for (const f of d.friends ?? []) add(f, 'friend');
    return out;
  }
  /** The deceased a living citizen was close to (their panel; N5's memories, docs/media.md): partner, parents, children, friends. */
  mourningOf(c: Citizen): FamilyRef[] {
    const out: FamilyRef[] = [];
    for (const d of this.dead.values()) {
      const rel = d.partner === c.id ? 'partner' : d.id === c.par ? 'parent' : d.par === c.id ? 'child' : d.kids.includes(c.id) ? 'parent' : d.par && d.par === c.par ? 'sibling' : d.friends?.includes(c.id) ? 'friend' : '';
      if (rel) out.push({ id: d.id, name: nameFor(d.id, d.sn), relation: rel, living: false, age: d.age });
    }
    return out.slice(-8);
  }
  /**
   * N5's hook (docs/media.md, card N5): what a citizen remembers of the dead: each deceased relative or friend, how they
   * died, when, and the news story of an incident, so a memory can say "my grandad died in the Brixton fire".
   */
  memoriesOf(c: Citizen): { dead: number; relation: string; cause: number; died: number; story?: number }[] {
    return this.mourningOf(c).map((r) => { const d = this.dead.get(r.id)!; return { dead: d.id, relation: r.relation, cause: d.cause, died: d.died, ...(d.story !== undefined ? { story: d.story } : {}) }; });
  }

  /** Dev servers (net.ts dev 'funeralSoon'): the dead not yet collected are taken in, and every service booked moves to a little over an hour from now. Returns how many. */
  hurry(): number {
    const now = this.w.tick;
    let n = 0;
    for (const d of this.dead.values()) if (d.st === Body.Scene && d.fd && !this.hearse.has(d.id)) this.atParlour(d); // not collected yet: taken in at once
    for (const d of this.dead.values()) {
      if (d.svc === undefined || d.held || (d.st !== Body.Parlour && d.st !== Body.Mortuary) || this.hearse.has(d.id)) continue;
      d.svc = now + Math.round(1.2 * TPH); d.sent = false;
      for (const id of [d.partner, ...d.kids, d.par]) if (id) this.dayOff.set(id, Math.floor(d.svc / DAY));
      n++;
    }
    return n;
  }

  /** A building as the panels and notices name it. */
  private named(x: number, y: number): string {
    const b = this.w.buildings.get(tileKey(x, y));
    if (!b) return `(${x}, ${y})`;
    const own = this.w.stopNames.get(tileKey(x, y)); // a named place (a scenario's: Highgate Cemetery)
    if (own) return own;
    if (b.zone === Zone.Residential) return `the house at (${x}, ${y})`;
    const n = KIND_NAMES[b.id] ?? 'building';
    return `the ${n} at (${x}, ${y})`;
  }

  // ---- demos -----------------------------------------------------------------------------------------------------

  /** pretend funerals under way (the demos' drills): not in the archive, never buried */
  private drillsLive: Dead[] = [];
  /** The demos' funeral drills: every DEATH.drillGapHours a pretend funeral goes from the funeral director to the resting place, with a few neighbours as mourners. */
  private drillStep(now: number) {
    for (const d of this.drillsLive) {
      if (d.st === Body.Parlour && now >= d.svc! - DEATH.mournerLeadHours * TPH && !d.sent) { d.sent = true; this.sendMourners(d); }
      if (d.st === Body.Parlour && !this.hearse.has(d.id) && now >= d.svc! - DEATH.hearseLeadHours * TPH) {
        const pl = this.places.get(tileKey(...d.rest!));
        if (pl && !this.send(d, [this.mobile.stopAt(pl.x, pl.y, this.serviceTicks(), Job.Service, d.id)], `carrying the late ${nameFor(d.id, d.sn)} to ${this.named(pl.x, pl.y)}`) && now > d.svc!) { d.st = Body.Service; d.since = now; this.changed = true; }
      }
      if (d.st === Body.Parlour && this.hearse.has(d.id) && now >= d.svc! + HEARSE_WAIT) { d.st = Body.Service; d.since = now; this.changed = true; }
      if (d.st === Body.Service && !this.hearse.has(d.id) && now >= d.since + this.serviceTicks()) this.drillDone(d);
    }
    if (now < this.nextDrill || this.drillsLive.length >= this.drills.length) return;
    for (const dr of this.drills) {
      if (this.drillsLive.some((d) => d.rest![0] === dr.rest[0] && d.rest![1] === dr.rest[1])) continue;
      if (!this.places.has(tileKey(...dr.rest)) || !this.w.buildings.has(tileKey(...dr.fd))) continue;
      const id = 1e9 + this.stats.drills++, svc = now + Math.round(1.1 * TPH);
      // mourners: grown-ups at home within 14 tiles, a hashed few
      const near = [...this.w.citizens.values()].filter((c) => c.state === S.Home && c.stage !== LifeStage.Child && Math.abs(c.hx - dr.rest[0]) + Math.abs(c.hy - dr.rest[1]) <= 14).sort((a, b) => hash2(a.id, id) - hash2(b.id, id)).slice(0, 5).map((c) => c.id);
      this.drillsLive.push({ id, sn: Math.floor(hash2(id, 3) * 1e6), born: now / DAY - 81 * 7, died: now - DAY, age: 81, cause: Cause.OldAge, par: 0, partner: 0, kids: [], owner: '', hx: dr.fd[0], hy: dr.fd[1], at: dr.fd, where: 'at home', st: Body.Parlour, since: now, estate: 0, fd: dr.fd, rest: dr.rest, svc, mourners: near, drill: true });
    }
    this.nextDrill = now + Math.round(DEATH.drillGapHours * TPH);
  }
  private drillDone(d: Dead) {
    this.drillsLive = this.drillsLive.filter((x) => x !== d);
    this.hearse.delete(d.id);
    this.changed = true;
  }
  /** The plot a drill's open grave is drawn at: the last free one. */
  private drillSlot(pl: Place) { return pl.spec.type === 'cremation' ? -1 : pl.slots.lastIndexOf(0); }

  /**
   * Seed a resting place with the long dead (demos, London; docs/remembrance.md): `n` records laid to rest years before the
   * world began, mostly of old age, couples side by side under one surname. Returns how many were laid.
   */
  seedGraves(x: number, y: number, n: number, seed: number, years = 90): number {
    this.placesAt = -Infinity;
    this.refresh();
    const pl = this.places.get(tileKey(x, y));
    if (!pl) return 0;
    let laid = 0;
    for (let i = 0; i < n; i++) {
      const slot = pl.slots.indexOf(0);
      if (slot < 0) break; // a crematorium's plaques fill the same way, in the order its garden takes them
      const id = this.w.nextId++, h = hash2(seed * 131 + i, 661);
      const couple = pl.spec.type === 'burial' && i > 0 && hash2(seed + i, 663) < 0.35 && laid > 0;
      const prev = couple ? this.dead.get(pl.slots[slot - 1]) : undefined;
      const sn = prev && !prev.partner ? prev.sn : id;
      const age = Math.floor(58 + 38 * hash2(id, 665)), yearsAgo = 1 + years * h;
      const died = Math.round(this.w.tick - yearsAgo * 7 * DAY);
      const cause = hash2(id, 667) < 0.8 ? Cause.OldAge : hash2(id, 669) < 0.7 ? Cause.Illness : Cause.Accident;
      const d: Dead = { id, sn, born: died / DAY - age * 7, died, age, cause, par: 0, partner: 0, kids: [], owner: pl.owner, hx: pl.x, hy: pl.y, at: [pl.x, pl.y], where: 'at home', st: Body.Rested, since: died, estate: 0, rest: [pl.x, pl.y], restKind: pl.kind, slot, rested: died + 3 * DAY, held: true, fees: 0, heirs: [] };
      if (prev && !prev.partner && sn === prev.sn) { d.partner = prev.id; prev.partner = id; }
      this.dead.set(id, d);
      pl.slots[slot] = id;
      laid++;
    }
    pl.held += laid; this.heldAt[tileKey(pl.x, pl.y)] = pl.held;
    this.changed = true;
    return laid;
  }

  private save(): DeathSave {
    const grief: [number, number, number][] = [];
    for (const [id, [until, of]] of this.grief) if (until > this.w.tick) grief.push([id, until, of]);
    return { dead: [...this.dead.values()].map((d) => ({ ...d })), grief, first: { ...this.first }, mourned: [...this.mourned], held: { ...this.heldAt } };
  }
}
