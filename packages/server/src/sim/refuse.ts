import {
  TICKS_PER_DAY, TICKS_PER_HOUR, WEEKDAY_NAMES, Zone, FleetKind, REFUSE, MOBILE, isRoad, binDay, isRefuseDepot, kindManifest, signSource, signText, tileKey,
  refuseGradeOf, refuseCapacity, refusePerHome, addonUpkeep, REFUSE_ADDONS, boundaryImpact, boundarySummary, BOUNDARY_LIMITS, VALUE_KINDS,
  type RefuseSiteInfo,
} from '@msimcity/shared';
import type { Building, Citizen, World } from '../world';
import { tkey, untkey } from '../world';
import type { Mobile, Unit, Stop, FleetService, FleetInfoRows } from './mobile';

const DAY = TICKS_PER_DAY, TPH = TICKS_PER_HOUR;
const LIFT = 1;
/** a home with no plain road in front is collected from a kerb this close */
const SHARE_KERB = 3;
/** sweepers: a waypoint every so many road tiles of the district, at most this many a round */
const SWEEP_STEP = 4, SWEEP_MAX = 12;

/** One district's collection today: its kerbs still to visit, in order, and the homes behind each. */
interface Round {
  id: number;
  district: number;
  depot: [number, number];
  /** kerb stops not yet given to a lorry, nearest-neighbour order from the depot */
  todo: Stop[];
  /** homes (tile keys) behind each kerb stop (by the stop's ref) */
  homes: Map<number, number[]>;
  total: number; done: number;
  lorries: number;
}

/**
 * Refuse collection and street sweeping (docs/mobile-jobs.md section 4). A hashed share of industrial buildings are
 * waste and recycling depots; half their staff are bin crews and some drive sweepers. The town is cut into districts
 * of REFUSE.district tiles, each with its own collection weekday (shared binDay). From 06:30 on that day the nearest
 * depot within reach sends a lorry per three crew on shift round every home's kerb in the district, at most maxStops a
 * lorry; it halts at each to lift the bins while traffic waits behind it, the home's owner pays the depot's owner per
 * home, and the lorry goes back when it is full of stops. Two days later a sweeper drives the district's streets.
 *
 * Refuse sites (docs/multiplayer-land.md section 5, M4; shared/src/refuse.ts): the placed grades (open tip to energy
 * from waste) are depots too, and a district goes to the nearest site within reach before any old depot, while the site
 * has room today (its grade's homes a day, less with restricted hours). Each home a site's lorry empties pays the
 * landfill levy (tonnes landfilled, smoke) from the site's owner into the world's regional fund (World.regional, ledger
 * `levy`), and earns the grade's sales back (ledger `recycling`). Add-ons' upkeep is charged at midnight (newDay).
 */
export class Refuse implements FleetService {
  readonly kinds = [FleetKind.BinLorry, FleetKind.Sweeper];
  private rounds = new Map<number, Round>();
  private nextRound = 1;
  /** the game day the rounds were last planned for */
  private plannedDay = -1;
  /** sweeper rounds still to send today: district key -> waypoints */
  private sweeps: { depot: [number, number]; stops: Stop[]; district: number }[] = [];
  /** when each home's bins were last emptied (home tile key -> tick) */
  private emptied = new Map<number, number>();
  /** per depot: today's rounds, homes and sweeps */
  private depots = new Map<number, { day: number; rounds: number; homes: number; sweeps: number; yRounds: number; yHomes: number; levy: number; sales: number; yLevy: number; ySales: number }>();
  /** homes given to each refuse site's rounds today (tkey of its door): a site takes no more than its capacity a day */
  private planned = new Map<number, number>();
  /** since start (loadtest/mobile.ts and refuse-check read these) */
  stats = { rounds: 0, roundsDone: 0, homes: 0, homesDone: 0, lorries: 0, sweeps: 0, sweepsDone: 0, fees: 0, unserved: 0, levy: 0, sales: 0, tonnes: 0 };

  constructor(private w: World, private mobile: Mobile) {}

  depotName(x: number, y: number): string {
    const b = this.w.buildings.get(tileKey(x, y)), k = b ? kindManifest(b.id) : undefined;
    return k ? signText(signSource(k, x, y)) : 'the depot';
  }
  private hour() { return (this.w.tick % DAY) / TPH; }
  private districtOf(x: number, y: number) { const d = REFUSE.district; return tkey(Math.floor(x / d), Math.floor(y / d)); }

  tick() {
    if (!MOBILE.on) return;
    const tick = this.w.tick, day = Math.floor(tick / DAY), h = this.hour();
    if (day !== this.plannedDay && h >= REFUSE.startHour) { this.plannedDay = day; this.plan(day); }
    if (tick % 10 === 4 && (this.rounds.size || this.sweeps.length)) this.dispatch();
  }

  /**
   * The depot for (x, y) within reach: the nearest refuse site with crews and room today for `homes` more, else the
   * nearest old waste depot with crews. A site already full takes a district only when nothing else is in reach.
   */
  private depotsNear(x: number, y: number, homes = 0): Building | null {
    const SITE = 1e5, FULL = 5e4;
    return this.w.bestBuiltNear(x, y, [Zone.Industrial, Zone.Hub], REFUSE.reach, SITE, (b, d) => {
      if (b.occupants <= 0 || !isRefuseDepot(b.id, b.x, b.y)) return null;
      if (!refuseGradeOf(b.id)) return -d;
      const room = refuseCapacity(b.id, this.w.refuseAddons.get(tileKey(b.x, b.y)) ?? 0) - (this.planned.get(tkey(b.x, b.y)) ?? 0);
      return room >= homes ? SITE - d : room > 0 ? FULL - d : null;
    }, (b) => this.w.hasRoadAccess(b.x, b.y));
  }
  /** Homes given to the rounds of the refuse site at (x, y) today (its panel). */
  plannedAt(x: number, y: number) { return this.planned.get(tkey(x, y)) ?? 0; }

  /** Today's districts: every home in a district whose bin day it is gets a round from the nearest depot. */
  private plan(day: number) {
    const w = this.w, wd = ((day % 7) + 7) % 7;
    this.rounds.clear(); this.sweeps.length = 0; this.planned.clear();
    if (wd >= 5) return; // no collections at the weekend
    const byDistrict = new Map<number, Building[]>();
    for (const b of w.builtOf(Zone.Residential)) {
      const due = binDay(b.x, b.y) === wd, sweep = (binDay(b.x, b.y) + 2) % 5 === wd;
      if (!due && !sweep) continue;
      const k = this.districtOf(b.x, b.y);
      let l = byDistrict.get(k);
      if (!l) byDistrict.set(k, l = []);
      l.push(b);
    }
    for (const [k, homes] of byDistrict) {
      const b0 = homes[0];
      const due = binDay(b0.x, b0.y) === wd;
      // the depot nearest the district's middle
      let mx = 0, my = 0;
      for (const b of homes) { mx += b.x; my += b.y; }
      mx = Math.round(mx / homes.length); my = Math.round(my / homes.length);
      const depot = this.depotsNear(mx, my, due ? homes.length : 0);
      if (!depot) { if (due) this.stats.unserved += homes.length; continue; }
      if (due) {
        // a refuse site takes no more than its room today (homes past it wait for next week's round)
        let take = homes;
        if (refuseGradeOf(depot.id)) {
          const dk = tkey(depot.x, depot.y), room = Math.max(0, refuseCapacity(depot.id, this.w.refuseAddons.get(tileKey(depot.x, depot.y)) ?? 0) - (this.planned.get(dk) ?? 0));
          if (room < homes.length) { take = homes.slice(0, room); this.stats.unserved += homes.length - room; }
          this.planned.set(dk, (this.planned.get(dk) ?? 0) + take.length);
        }
        if (take.length) this.planRound(k, [depot.x, depot.y], take);
      }
      else this.planSweep(k, [depot.x, depot.y], homes);
    }
  }
  private planRound(district: number, depot: [number, number], homes: Building[]) {
    const m = this.mobile;
    const id = this.nextRound++;
    const at = new Map<number, { x: number; y: number; homes: number[]; bx: number; by: number }>();
    const loose: Building[] = [];
    for (const b of homes) {
      const k = m.kerbOf(b.x, b.y);
      if (!k) { loose.push(b); continue; }
      const key = tkey(k[0], k[1]);
      let s = at.get(key);
      if (!s) at.set(key, s = { x: k[0], y: k[1], homes: [], bx: b.x, by: b.y });
      s.homes.push(tkey(b.x, b.y));
    }
    // homes that face only a junction: emptied from the nearest kerb stop close by, else not today
    for (const b of loose) {
      let best: { homes: number[] } | null = null, bd = SHARE_KERB + 1;
      for (const s of at.values()) { const d = Math.abs(s.x - b.x) + Math.abs(s.y - b.y); if (d < bd) { bd = d; best = s; } }
      if (best) best.homes.push(tkey(b.x, b.y)); else this.stats.unserved++;
    }
    if (!at.size) return;
    // nearest neighbour from the depot
    const left = [...at.values()], todo: Stop[] = [], byRef = new Map<number, number[]>();
    let cx = depot[0], cy = depot[1], ref = 0;
    while (left.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < left.length; i++) { const d = Math.abs(left[i].x - cx) + Math.abs(left[i].y - cy); if (d < bd) { bd = d; bi = i; } }
      const s = left.splice(bi, 1)[0];
      todo.push({ x: s.x, y: s.y, kerb: true, dwell: REFUSE.liftTicks + REFUSE.perExtraHome * (s.homes.length - 1), bx: s.bx, by: s.by, what: LIFT, ref: id * 1000 + ref });
      byRef.set(id * 1000 + ref, s.homes);
      ref++;
      cx = s.x; cy = s.y;
    }
    let total = 0;
    for (const h of byRef.values()) total += h.length;
    this.rounds.set(id, { id, district, depot, todo, homes: byRef, total, done: 0, lorries: 0 });
    this.stats.rounds++; this.stats.homes += total;
    this.depotDay(depot).rounds++;
  }
  /** A sweeper's round: waypoints along the district's streets, every SWEEP_STEP-th road tile in a nearest-neighbour walk. */
  private planSweep(district: number, depot: [number, number], homes: Building[]) {
    const w = this.w, d = REFUSE.district;
    const b0 = homes[0], x0 = Math.floor(b0.x / d) * d, y0 = Math.floor(b0.y / d) * d;
    const roads: [number, number][] = [];
    for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + d; x++) {
      const t = w.peekTile(x, y);
      if (t !== undefined && isRoad(t) && (t & 3) !== 3 && !w.auxAt(x, y)) roads.push([x, y]);
    }
    if (roads.length < 4) return;
    const stops: Stop[] = [];
    let cx = depot[0], cy = depot[1], n = 0;
    while (roads.length && stops.length < SWEEP_MAX) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < roads.length; i++) { const dd = Math.abs(roads[i][0] - cx) + Math.abs(roads[i][1] - cy); if (dd < bd) { bd = dd; bi = i; } }
      const [x, y] = roads.splice(bi, 1)[0];
      if (n++ % SWEEP_STEP === 0) stops.push({ x, y, kerb: false, pass: true, dwell: 0, bx: x, by: y, what: 0, ref: 0 });
      cx = x; cy = y;
    }
    this.sweeps.push({ depot, stops, district });
  }

  /** Send lorries (one per REFUSE.crew crew on shift and free at the depot) and sweepers out. */
  private dispatch() {
    const free = new Map<number, Citizen[]>(), sweepers = new Map<number, Citizen[]>();
    for (const c of this.mobile.onShift(FleetKind.BinLorry)) if (this.mobile.free(c) && !this.mobile.unitOf(c.id)) push(free, tkey(c.wx, c.wy), c);
    for (const c of this.mobile.onShift(FleetKind.Sweeper)) if (this.mobile.free(c) && !this.mobile.unitOf(c.id)) push(sweepers, tkey(c.wx, c.wy), c);
    for (const r of this.rounds.values()) {
      if (!r.todo.length) continue;
      const crew = free.get(tkey(r.depot[0], r.depot[1]));
      while (r.todo.length && crew && crew.length >= REFUSE.crew) {
        const team = crew.splice(0, REFUSE.crew);
        const stops = r.todo.splice(0, REFUSE.maxStops);
        const u = this.mobile.launch(this, team[0], FleetKind.BinLorry, r.depot, r.depot, stops, `on the bin round, ${stops.length} stops to make`, team.slice(1).map((c) => c.id));
        if (!u) { r.todo.unshift(...stops); break; }
        r.lorries++; this.stats.lorries++;
      }
    }
    for (let i = 0; i < this.sweeps.length; i++) {
      const s = this.sweeps[i], drivers = sweepers.get(tkey(s.depot[0], s.depot[1]));
      if (!drivers?.length) continue;
      const u = this.mobile.launch(this, drivers.shift()!, FleetKind.Sweeper, s.depot, s.depot, s.stops, 'sweeping the streets');
      if (!u) continue;
      u.working = true; // brushes down for the whole round
      this.sweeps.splice(i--, 1);
      this.stats.sweeps++;
      this.depotDay(s.depot).sweeps++;
    }
  }

  private depotDay(d: [number, number]) {
    const k = tkey(d[0], d[1]), day = Math.floor(this.w.tick / DAY);
    let v = this.depots.get(k);
    if (!v) this.depots.set(k, v = { day, rounds: 0, homes: 0, sweeps: 0, yRounds: 0, yHomes: 0, levy: 0, sales: 0, yLevy: 0, ySales: 0 });
    if (v.day !== day) {
      const y1 = v.day === day - 1;
      v.yRounds = y1 ? v.rounds : 0; v.yHomes = y1 ? v.homes : 0; v.yLevy = y1 ? v.levy : 0; v.ySales = y1 ? v.sales : 0;
      v.rounds = 0; v.homes = 0; v.sweeps = 0; v.levy = 0; v.sales = 0; v.day = day;
    }
    return v;
  }

  /** Homes a depot at (x, y) emptied a day, today and yesterday averaged (sim/value.ts: nuisance follows use). */
  handledAt(x: number, y: number): number {
    const v = this.depots.get(tkey(x, y)), day = Math.floor(this.w.tick / DAY);
    if (!v) return 0;
    if (v.day === day) return (v.homes + v.yHomes) / 2;
    return v.day === day - 1 ? v.homes / 2 : 0;
  }

  // ---- the lorry's side (FleetService) -----------------------------------------------------------------------------

  arrive(u: Unit, s: Stop) {
    if (s.what !== LIFT) return;
    const w = this.w, tick = w.tick;
    const homes = this.roundOf(s.ref)?.homes.get(s.ref) ?? [];
    const depotOwner = w.parcelAt(u.base[0], u.base[1])?.owner;
    for (const hk of homes) {
      this.emptied.set(hk, tick);
      const [hx, hy] = untkey(hk);
      const owner = w.parcelAt(hx, hy)?.owner;
      if (owner && depotOwner && owner !== depotOwner) w.transfer(owner, depotOwner, REFUSE.feePerHome, 'fees');
      this.stats.fees += REFUSE.feePerHome;
    }
    const r = this.roundOf(s.ref);
    if (r) r.done += homes.length;
    this.stats.homesDone += homes.length;
    this.tip(u.base, homes.length);
    this.mobile.note(u, REFUSE.feePerHome * homes.length);
    u.loaded = true; // something in the back now
    u.task = `emptying the bins of ${homes.length} home${homes.length === 1 ? '' : 's'}`;
  }
  /**
   * The depot at `base` has had `n` more homes' bins emptied today (its use: sim/value.ts reads it as handledAt). At a
   * refuse site (M4) the landfill levy on what the grade landfills and the smoke it makes goes from the site's owner into
   * the regional fund (ledger `levy`), and the grade's sales come back to the owner (ledger `recycling`).
   */
  tip(base: [number, number], n: number) {
    const w = this.w, dd = this.depotDay(base);
    dd.homes += n;
    const b = w.buildings.get(tileKey(base[0], base[1]));
    if (!b || !refuseGradeOf(b.id) || !n) return;
    const ph = refusePerHome(b.id, w.refuseAddons.get(tileKey(b.x, b.y)) ?? 0), owner = w.parcelAt(b.x, b.y)?.owner;
    const levy = ph.levy * n, sales = ph.sales * n;
    this.stats.tonnes += ph.tonnes * n;
    if (!owner) return;
    if (levy > 0) { w.credit(owner, -levy, 'levy'); w.regional.fund += levy; w.regional.levied += levy; this.stats.levy += levy; dd.levy += levy; }
    if (sales > 0) { w.credit(owner, sales, 'recycling'); this.stats.sales += sales; dd.sales += sales; }
  }
  /** At midnight (Simulation.newDay): the add-ons' upkeep, and add-ons of sites that are gone dropped. */
  newDay() {
    const w = this.w;
    for (const [k, mask] of w.refuseAddons) {
      const b = w.buildings.get(k);
      if (!b || !refuseGradeOf(b.id) || !mask) { w.refuseAddons.delete(k); continue; }
      const owner = w.parcelAt(b.x, b.y)?.owner, up = addonUpkeep(mask);
      if (owner && up > 0 && b.level > 0) w.credit(owner, -up, 'upkeep');
    }
  }

  /** A refuse site's panel section (BuildingInfo.refuse): its grade, today's tonnes, levy and sales, add-ons, impact. */
  siteInfo(b: Building, mine: boolean): RefuseSiteInfo | undefined {
    const g = refuseGradeOf(b.id);
    if (!g) return undefined;
    const w = this.w, mask = w.refuseAddons.get(tileKey(b.x, b.y)) ?? 0, v = this.depotDay([b.x, b.y]), ph = refusePerHome(b.id, mask);
    const owner = w.parcelAt(b.x, b.y)?.owner ?? '';
    const imp = boundaryImpact(b.id, mask, b.x, b.y, w.seed, owner, (x, y) => w.parcelAt(x, y)?.owner);
    const nameOf = (id: string | null) => (id ? w.players.get(id)?.name ?? id : '');
    return {
      grade: g.name, capacity: refuseCapacity(b.id, mask), planned: this.plannedAt(b.x, b.y),
      today: { homes: v.homes, tonnes: Math.round(v.homes * ph.tonnes * 10) / 10, levy: Math.round(v.levy * 100) / 100, sales: Math.round(v.sales * 100) / 100 },
      yesterday: { homes: v.yHomes, levy: Math.round(v.yLevy * 100) / 100, sales: Math.round(v.ySales * 100) / 100 },
      perTonne: { levy: Math.round((ph.levy / ph.tonnes) * 100) / 100, sales: Math.round((ph.sales / ph.tonnes) * 100) / 100, what: g.salesWhat },
      addons: REFUSE_ADDONS.map((a) => ({ id: a.id, label: a.label, blurb: a.blurb, on: (mask & a.bit) !== 0, cost: a.cost, upkeep: a.upkeep })),
      impact: imp.worst.map((x, k) => [k, x] as [number, number]).filter(([k, x]) => VALUE_KINDS[k].nuisance && x > 0.005).map(([k, x]) => ({ kind: VALUE_KINDS[k].name, pct: Math.round(x * 100), limit: Math.round(BOUNDARY_LIMITS[k] * 100), owner: nameOf(imp.owner[k]) })),
      summary: boundarySummary(imp),
      ...(mine ? { mine: true } : {}),
    };
  }
  depart(u: Unit, _s: Stop) {
    u.task = u.stops.length ? `on the bin round, ${u.stops.length} stop${u.stops.length === 1 ? '' : 's'} to make` : `taking the load back to ${this.depotName(u.base[0], u.base[1])}`;
  }
  unreachable(_u: Unit, s: Stop) { const r = this.roundOf(s.ref); if (r) this.stats.unserved += r.homes.get(s.ref)?.length ?? 0; }
  withdrawn(u: Unit, _at: [number, number]) {
    // the stops it did not make go back on the round for the next lorry
    for (const s of u.stops) { const r = this.roundOf(s.ref); if (r && s.what === LIFT) r.todo.unshift(s); }
  }
  returned(u: Unit) {
    if (u.kind === FleetKind.Sweeper) { this.stats.sweepsDone++; return; }
    for (const r of this.rounds.values()) if (r.depot[0] === u.base[0] && r.depot[1] === u.base[1] && !r.todo.length && r.done >= r.total && r.lorries > 0) { r.lorries = 0; this.stats.roundsDone++; }
  }
  private roundOf(ref: number) { return this.rounds.get(Math.floor(ref / 1000)); }

  label(u: Unit) { return `${this.depotName(u.base[0], u.base[1])} ${u.kind === FleetKind.Sweeper ? 'sweeper' : 'bin lorry'}`; }
  baseName(c: Citizen) { return this.depotName(c.wx, c.wy); }
  /** A depot's tooltip, and a home's: when its bins were last emptied and which day they go. */
  describe(bx: number, by: number, kindId: number): FleetInfoRows | null {
    const w = this.w, day = Math.floor(w.tick / DAY);
    if (isRefuseDepot(kindId, bx, by)) {
      let crew = 0, sweep = 0, out = 0;
      for (const c of this.mobile.onShift(FleetKind.BinLorry)) if (c.wx === bx && c.wy === by) crew++;
      for (const c of this.mobile.onShift(FleetKind.Sweeper)) if (c.wx === bx && c.wy === by) sweep++;
      for (const u of this.mobile.units.values()) if (u.base[0] === bx && u.base[1] === by && (u.kind === FleetKind.BinLorry || u.kind === FleetKind.Sweeper)) out++;
      const v = this.depotDay([bx, by]);
      let left = 0;
      for (const r of this.rounds.values()) if (r.depot[0] === bx && r.depot[1] === by) left += r.total - r.done;
      return {
        role: `${refuseGradeOf(kindId)?.name ?? 'waste and recycling depot'}: ${this.depotName(bx, by)}`,
        rows: [
          ['Crews on shift', `${Math.floor(crew / 3)} bin lorr${Math.floor(crew / 3) === 1 ? 'y' : 'ies'} (${crew} collectors), ${sweep} sweeper driver${sweep === 1 ? '' : 's'}`],
          ['Out on the streets', `${out}`],
          ['Today', `${v.rounds} round${v.rounds === 1 ? '' : 's'}, ${v.homes} homes emptied${left ? `, ${left} to go` : ''}, ${v.sweeps} street${v.sweeps === 1 ? '' : 's'} swept`],
          ['Yesterday', `${v.yRounds} rounds, ${v.yHomes} homes`],
        ],
      };
    }
    const b = w.buildings.get(tileKey(bx, by));
    if (!b || b.zone !== Zone.Residential || !b.level) return null;
    const last = this.emptied.get(tkey(bx, by));
    const wd = binDay(bx, by);
    const lastDay = last === undefined ? undefined : Math.floor(last / DAY);
    return {
      role: 'bins',
      rows: [
        ['Collection day', `${WEEKDAY_NAMES[wd]}${this.depotsNear(bx, by) ? '' : ' (no depot in reach)'}`],
        ['Last emptied', last === undefined ? 'not since the town was loaded' : lastDay === day ? `today, ${hhmm(last)}` : `${WEEKDAY_NAMES[((lastDay! % 7) + 7) % 7]} ${hhmm(last)}`],
      ],
    };
  }
}
function push<K, T>(m: Map<K, T[]>, k: K, v: T) { let l = m.get(k); if (!l) m.set(k, l = []); l.push(v); }
const hhmm = (tick: number) => { const h = (tick % DAY) / TPH; return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`; };
