import {
  TICKS_PER_DAY, TICKS_PER_HOUR, DRIVE_SPEED, WALK_SPEED, CitizenState, LifeStage, FleetKind, TAXI, TRANSIT, MOBILE, FLEET_LABEL, tileKey, nameFor, hash2, walkCost,
  kindManifest, signSource, signText, isCabOffice, type PersonRef,
} from '@msimcity/shared';
import type { Citizen, Leg, World } from '../world';
import { tkey } from '../world';
import { pathBetween } from '../pathfinding';
import { noteIncome, noteSpend, ageOf, LIFE } from './life';
import { weatherNow } from './weatherfx';
import type { Mobile, Unit, Stop, FleetService, FleetInfoRows } from './mobile';

const DAY = TICKS_PER_DAY;
const S = CitizenState;
/** what a stop is for */
const PICKUP = 1, DROP = 2;
/** a taxi covers a tile of route in about this many ticks, pulling out and town traffic allowed for */
const TICKS_PER_TILE = 1.3 / (DRIVE_SPEED * 0.45);

interface Booking {
  id: number;
  /** the passenger */
  cid: number;
  from: [number, number];
  to: [number, number];
  /** booked, quoted wait (ticks) */
  at: number; quoted: number;
  state: 'waiting' | 'aboard' | 'done' | 'failed';
  /** the vehicle sent */
  vid: number;
  fare: number;
  /** where the passenger stands while waiting (kerb side of their building), or null when the taxi comes in at the door */
  stand: [number, number] | null;
  label: string;
}
/** What a free taxi would cost and when it would come. */
export interface TaxiQuote { worker: Citizen; kind: number; at: [number, number]; unit?: Unit; wait: number; ride: number; fare: number }

/**
 * Taxis and private hire (docs/mobile-jobs.md section 2). Cab offices are 1×1 commercial lots picked by tile hash; all
 * their staff drive. Cab drivers take the office's cab out for each fare and bring it back; private-hire drivers work
 * from home in their own car and wait where the last fare ended. A trip is booked when the passenger's mode choice
 * picks it (Simulation.plan): the nearest free taxi is sent to the kerb of their building, they wait there, ride, pay
 * at the end and get out at the kerb of where they were going.
 */
export class Taxis implements FleetService {
  readonly kinds = [FleetKind.Taxi, FleetKind.PrivateHire];
  private bookings = new Map<number, Booking>();
  private byRider = new Map<number, Booking>();
  private nextBooking = 1;
  /** per cab office (tile key): today's fares and takings */
  private offices = new Map<number, { day: number; fares: number; money: number; yFares: number; yMoney: number }>();
  /** since start (loadtest/mobile.ts reads these) */
  stats = { quotes: 0, booked: 0, pickedUp: 0, delivered: 0, gaveUp: 0, failed: 0, setDown: 0, fares: 0, waitSum: 0, rideSum: 0 };

  /** where cabs may wait for fares besides their office: the doors of stations, the airport and coach depots (set by the Simulation from its gateways) */
  ranks: () => Iterable<[number, number]> = () => [];

  constructor(private w: World, private mobile: Mobile) {}

  tick() {}

  /** Where a cab from the office at (x, y) waits between fares: the nearest rank within TAXI.rankReach, else the office. */
  rankFor(x: number, y: number): [number, number] {
    let best: [number, number] = [x, y], bd = TAXI.rankReach + 1;
    for (const r of this.ranks()) { const d = Math.abs(r[0] - x) + Math.abs(r[1] - y); if (d < bd) { bd = d; best = r; } }
    return best;
  }

  /** The name a cab office trades under (its sign). */
  officeName(x: number, y: number): string {
    const k = kindManifest(2);
    return k ? signText(signSource(k, x, y)) : 'Cars';
  }

  /**
   * The nearest free taxi within TAXI.reach of (fx, fy): a cab driver at their office, a private-hire driver at home or
   * parked after a fare, or either on the way back with nobody aboard. Null when none is free.
   */
  quote(fx: number, fy: number, dx: number, dy: number): TaxiQuote | null {
    this.stats.quotes++;
    let best: TaxiQuote | null = null, bd = TAXI.reach + 1;
    for (const kind of this.kinds) {
      for (const c of this.mobile.onShift(kind)) {
        if (!this.mobile.free(c)) continue;
        const u = this.mobile.unitOf(c.id);
        const at: [number, number] = u ? [Math.floor(u.v.x), Math.floor(u.v.y)] : kind === FleetKind.PrivateHire ? [c.hx, c.hy] : [c.wx, c.wy];
        const d = Math.abs(at[0] - fx) + Math.abs(at[1] - fy);
        if (d >= bd) continue;
        bd = d;
        best = { worker: c, kind, at, unit: u, wait: 0, ride: 0, fare: 0 };
      }
    }
    if (!best) return null;
    const trip = Math.abs(dx - fx) + Math.abs(dy - fy);
    best.wait = Math.round(bd * TICKS_PER_TILE + 6);
    best.ride = Math.round(trip * TICKS_PER_TILE);
    best.fare = Math.round((TAXI.flagfall + TAXI.perTile * trip * 1.2) * 100) / 100;
    return best;
  }

  /**
   * Mode choice (Simulation.plan, once the bus has been weighed): a taxi from (fx, fy) to (dx, dy) when it beats walking
   * and the car. Perceived ticks: the fare in ticks times a personal price taste, the wait weighted as a bus wait, the
   * ride; walking at night feels longer, and so does driving to (or back from) a night out. Books it and returns the
   * trip's legs, or null.
   */
  choose(c: Citizen, fx: number, fy: number, dx: number, dy: number, carTicks: number, nightOut: boolean): Leg[] | null {
    if (!MOBILE.on || c.stage === LifeStage.Child || this.byRider.has(c.id)) return null;
    const dist = Math.abs(dx - fx) + Math.abs(dy - fy);
    if (dist < TAXI.minTrip || !this.w.buildings.has(tileKey(fx, fy))) return null;
    const q = this.quote(fx, fy, dx, dy);
    if (!q || c.money < q.fare + 5) return null;
    const h = (this.w.tick % DAY) / TICKS_PER_HOUR, night = h >= 21 || h < 6;
    const walkSpeed = c.stage === LifeStage.Retired ? WALK_SPEED * LIFE.retireeWalk : WALK_SPEED;
    const taste = TAXI.priceTasteMin + TAXI.priceTasteSpan * hash2(c.id, 441);
    const byTaxi = q.fare * TRANSIT.ticksPerDollar * taste + TRANSIT.waitWeight * q.wait + q.ride;
    const byFoot = walkCost((dist * 1.2) / walkSpeed) * (night ? TAXI.nightWalk : 1) * weatherNow(this.w).walk; // a wet walk (docs/weather.md W4)
    const byCar = carTicks * (0.85 + 0.6 * hash2(c.id, 78)) * (nightOut ? TAXI.outingCar : 1);
    if (byTaxi >= byFoot || byTaxi >= byCar) return null;
    const leg = this.book(c, q, fx, fy, dx, dy);
    return leg ? [leg] : null;
  }

  /** Book the quoted taxi for c from (fx, fy) to (dx, dy): the trip's one leg, or null when the taxi cannot get there. */
  book(c: Citizen, q: TaxiQuote, fx: number, fy: number, dx: number, dy: number): Leg | null {
    const m = this.mobile;
    const id = this.nextBooking++;
    const pickup = m.stopAt(fx, fy, TAXI.pickupDwell, PICKUP, id);
    // a cab sets down at the kerb and goes back; private hire pulls in at the door and waits there for the next booking
    const drop: Stop = q.kind === FleetKind.PrivateHire ? { x: dx, y: dy, kerb: false, dwell: TAXI.dropDwell, bx: dx, by: dy, what: DROP, ref: id } : m.stopAt(dx, dy, TAXI.dropDwell, DROP, id);
    const officeX = q.worker.wx, officeY = q.worker.wy;
    const label = q.kind === FleetKind.PrivateHire ? `private hire car (${this.officeName(officeX, officeY)})` : `${this.officeName(officeX, officeY)} taxi`;
    const task = `on the way to pick up ${nameFor(c.id, c.sn)}`;
    let u: Unit | null | undefined = q.unit;
    const fresh = !u;
    if (u) { if (!m.retask(u, [pickup, drop], task)) return null; }
    else {
      // a cab waits at its office's rank (or the office) between fares, private hire where the last fare ended
      const from: [number, number] = q.kind === FleetKind.PrivateHire ? [q.worker.hx, q.worker.hy] : [officeX, officeY];
      const base: [number, number] = q.kind === FleetKind.PrivateHire ? from : this.rankFor(officeX, officeY);
      u = m.launch(this, q.worker, q.kind, from, base, [pickup, drop], task);
      if (!u) return null;
    }
    if (!u.stops.some((s) => s.ref === id && s.what === PICKUP)) {
      // the pickup was unreachable: a taxi just sent out goes straight back in, one already out carries on as it was going
      if (fresh) m.remove(u); else m.retask(u, u.stops.filter((s) => s.ref !== id), 'heading back');
      return null;
    }
    const stand: [number, number] | null = pickup.kerb ? [pickup.x + 0.5 + (fx - pickup.x) * 0.45, pickup.y + 0.5 + (fy - pickup.y) * 0.45] : null;
    const b: Booking = { id, cid: c.id, from: [fx, fy], to: [dx, dy], at: this.w.tick, quoted: q.wait, state: 'waiting', vid: u.v.id, fare: q.fare, stand, label };
    this.bookings.set(id, b);
    this.byRider.set(c.id, b);
    this.stats.booked++;
    return { path: [fx, fy, dx, dy], drive: false, arrive: 'none', hail: { booking: id, dest: [dx, dy] } };
  }

  /** The hail leg has started: stand at the kerb (or wait indoors when the taxi comes in at the door). */
  startWait(c: Citizen) {
    const b = this.byRider.get(c.id);
    if (b?.stand) { c.x = b.stand[0]; c.y = b.stand[1]; }
  }
  /** Is the passenger's hail leg over (set down at the destination, or given up and walking on)? Runs every tick of the leg. */
  hailDone(c: Citizen): boolean {
    const b = this.byRider.get(c.id);
    if (!b) return true;
    if (b.state === 'done') { this.forgetBooking(b); return true; }
    if (b.state === 'failed') { this.forgetBooking(b); this.walkOn(c, b); return true; }
    if (b.state === 'waiting' && this.w.tick - b.at > Math.max(TAXI.waitMin, TAXI.waitMul * b.quoted)) {
      this.stats.gaveUp++;
      this.cancel(b);
      this.forgetBooking(b);
      this.walkOn(c, b);
      return true;
    }
    if (b.state === 'aboard') { const u = this.mobile.units.get(b.vid); if (u) { c.x = u.v.x; c.y = u.v.y; } }
    return false;
  }
  /** Waiting at the kerb (drawn standing there), or indoors for a taxi that comes in at the door (not drawn). */
  waiting(c: Citizen): 'kerb' | 'indoors' | null {
    const b = this.byRider.get(c.id);
    return b?.state === 'waiting' ? (b.stand ? 'kerb' : 'indoors') : null;
  }
  isAboard(c: Citizen): boolean { return this.byRider.get(c.id)?.state === 'aboard'; }
  /** The taxi a passenger is in or waiting for, for their panel. */
  taxiOf(c: Citizen): { vehicle: number; label: string } | undefined {
    const b = this.byRider.get(c.id);
    return b && (b.state === 'waiting' || b.state === 'aboard') ? { vehicle: b.vid, label: b.label } : undefined;
  }
  /** The passenger's activity line. */
  activity(c: Citizen): string | null {
    const b = this.byRider.get(c.id);
    if (!b) return null;
    if (b.state === 'aboard') return `in a ${b.label}`;
    const u = this.mobile.units.get(b.vid);
    const left = u ? Math.max(1, Math.round(((u.v.path.length / 2 - u.v.pi) * TICKS_PER_TILE * 60) / (DAY / 24))) : 0;
    return `waiting for a ${b.label}${u && u.stops[0]?.ref === b.id ? `, about ${left} min away` : ''}`;
  }
  /** The passenger is re-planning, has gone or has been sent home: their booking is called off. */
  drop(c: Citizen) {
    const b = this.byRider.get(c.id);
    if (!b) return;
    if (b.state === 'waiting' || b.state === 'aboard') this.cancel(b);
    this.forgetBooking(b);
  }

  private forgetBooking(b: Booking) {
    this.bookings.delete(b.id);
    if (this.byRider.get(b.cid) === b) this.byRider.delete(b.cid);
  }
  /** Take a booking's stops off its taxi (it carries on with whatever else it has, or goes back). */
  private cancel(b: Booking) {
    const was = b.state;
    b.state = 'failed';
    const u = this.mobile.units.get(b.vid);
    if (!u) return;
    if (was === 'aboard') u.loaded = false;
    // standing at a stop, it finishes the dwell and then goes on without this booking's stops; else it re-plans now
    const cur = u.phase === 'dwell' ? u.stops[0] : undefined;
    const rest = u.stops.filter((s) => s.ref !== b.id || s === cur);
    if (rest.length === u.stops.length) return;
    if (cur) u.stops = rest;
    else this.mobile.retask(u, rest, rest.length ? u.task : 'heading back');
  }
  /** Give up on the taxi: walk the rest of the way from where they are. */
  private walkOn(c: Citizen, b: Booking) {
    const fx = Math.floor(c.x), fy = Math.floor(c.y);
    const wp = pathBetween(this.w, fx, fy, b.to[0], b.to[1]);
    if (wp && wp.length >= 4) c.legs.unshift({ path: wp, drive: false, arrive: 'none' });
    else { c.x = b.to[0] + 0.5; c.y = b.to[1] + 0.5; }
  }

  // ---- the taxi's side (FleetService) ------------------------------------------------------------------------------

  arrive(u: Unit, s: Stop) {
    const b = this.bookings.get(s.ref);
    const c = b ? this.w.citizens.get(b.cid) : undefined;
    if (!b || !c) return;
    if (s.what === PICKUP) {
      if (b.state !== 'waiting' || c.leg?.hail?.booking !== b.id) return; // gave up meanwhile
      b.state = 'aboard'; u.loaded = true;
      this.stats.pickedUp++; this.stats.waitSum += this.w.tick - b.at;
      b.at = this.w.tick;
      u.task = `taking ${nameFor(c.id, c.sn)} to (${b.to[0]}, ${b.to[1]})`;
      return;
    }
    if (s.what === DROP && b.state === 'aboard') {
      // set down at the door, and pay: a cab's fare mostly to the office, private hire a commission
      b.state = 'done'; u.loaded = false;
      c.x = b.to[0] + 0.5; c.y = b.to[1] + 0.5;
      this.stats.delivered++; this.stats.rideSum += this.w.tick - b.at;
      this.pay(u, c, b);
      u.task = u.kind === FleetKind.PrivateHire ? 'dropping off, then waiting for the next booking' : 'dropping off';
    }
  }
  private pay(u: Unit, c: Citizen, b: Booking) {
    const w = this.w, tick = w.tick;
    const fare = Math.min(b.fare, Math.max(0, c.money));
    c.money -= fare; noteSpend(c, fare, tick);
    const cut = u.kind === FleetKind.PrivateHire ? TAXI.platformCut : TAXI.officeCut;
    const driver = w.citizens.get(u.worker);
    const office = driver ? [driver.wx, driver.wy] : u.base;
    const owner = w.parcelAt(office[0], office[1])?.owner;
    if (owner) w.credit(owner, fare * cut, 'fees');
    if (driver) { driver.money += fare * (1 - cut); noteIncome(driver, fare * (1 - cut), tick); }
    this.mobile.note(u, fare);
    this.stats.fares += fare;
    const k = tkey(office[0], office[1]), day = Math.floor(tick / DAY);
    let o = this.offices.get(k);
    if (!o) this.offices.set(k, o = { day, fares: 0, money: 0, yFares: 0, yMoney: 0 });
    if (o.day !== day) { o.yFares = o.day === day - 1 ? o.fares : 0; o.yMoney = o.day === day - 1 ? o.money : 0; o.fares = 0; o.money = 0; o.day = day; }
    o.fares++; o.money += fare;
  }
  depart(u: Unit, _s: Stop) {
    if (!u.stops.length) u.task = u.kind === FleetKind.PrivateHire ? 'waiting for a booking' : 'heading back to the rank';
    else if (u.stops[0].what === DROP) {
      const b = this.bookings.get(u.stops[0].ref);
      const c = b ? this.w.citizens.get(b.cid) : undefined;
      if (b && c && b.state === 'aboard') u.task = `taking ${nameFor(c.id, c.sn)} to (${b.to[0]}, ${b.to[1]})`;
    }
  }
  unreachable(u: Unit, s: Stop) {
    const b = this.bookings.get(s.ref);
    if (!b) return;
    this.stats.failed++;
    if (s.what === DROP && b.state === 'aboard') {
      // nowhere to go from here: set down where the taxi is, they walk on
      const c = this.w.citizens.get(b.cid);
      if (c) { c.x = Math.floor(u.v.x) + 0.5; c.y = Math.floor(u.v.y) + 0.5; }
      u.loaded = false;
    }
    b.state = 'failed';
    u.stops = u.stops.filter((x) => x.ref !== b.id || x === s);
  }
  withdrawn(u: Unit, at: [number, number]) {
    for (const b of this.bookings.values()) {
      if (b.vid !== u.v.id || (b.state !== 'waiting' && b.state !== 'aboard')) continue;
      if (b.state === 'aboard') { const c = this.w.citizens.get(b.cid); if (c) { c.x = at[0] + 0.5; c.y = at[1] + 0.5; } this.stats.setDown++; }
      b.state = 'failed';
    }
  }
  returned(_u: Unit) {}
  /** Cabs wait at their rank or office for the next fare (Mobile parks them there), and hand the cab back at the end of the shift. */
  idleAtBase(u: Unit) { u.task = `waiting for a fare at ${u.base[0] === this.w.citizens.get(u.worker)?.wx && u.base[1] === this.w.citizens.get(u.worker)?.wy ? 'the office' : 'the rank'}`; return true; }

  label(u: Unit) { const c = this.w.citizens.get(u.worker); return u.kind === FleetKind.PrivateHire ? 'private hire car' : c ? `${this.officeName(c.wx, c.wy)} cab` : 'taxi'; }
  baseName(c: Citizen, kind: number) { return kind === FleetKind.PrivateHire ? `${this.officeName(c.wx, c.wy)} (private hire, works from home)` : `${this.officeName(c.wx, c.wy)} cab office`; }
  /** The passenger aboard a taxi, for its panel. */
  aboard(u: Unit): PersonRef[] {
    for (const b of this.bookings.values()) {
      if (b.vid !== u.v.id || (b.state !== 'aboard' && b.state !== 'waiting')) continue;
      const c = this.w.citizens.get(b.cid);
      if (c) return [{ id: c.id, name: nameFor(c.id, c.sn), age: Math.floor(ageOf(c, this.w.tick)), relation: b.state === 'aboard' ? 'passenger' : 'to pick up', activity: b.state === 'aboard' ? `to (${b.to[0]}, ${b.to[1]})` : `waiting at (${b.from[0]}, ${b.from[1]})` }];
    }
    return [];
  }

  /** A cab office's tooltip: its name, drivers on shift, taxis out, fares today and yesterday. */
  describe(bx: number, by: number, kindId: number): FleetInfoRows | null {
    if (!isCabOffice(kindId, bx, by)) return null;
    let cabs = 0, ph = 0, out = 0;
    for (const kind of this.kinds) for (const c of this.mobile.onShift(kind)) {
      if (c.wx !== bx || c.wy !== by) continue;
      if (kind === FleetKind.PrivateHire) ph++; else cabs++;
      const u = this.mobile.unitOf(c.id);
      if (u && u.phase !== 'idle') out++;
    }
    const o = this.offices.get(tkey(bx, by)), day = Math.floor(this.w.tick / DAY);
    const today = o && o.day === day ? o : null, yest = o ? (o.day === day ? { f: o.yFares, m: o.yMoney } : o.day === day - 1 ? { f: o.fares, m: o.money } : null) : null;
    return {
      role: `cab office: ${this.officeName(bx, by)}`,
      rows: [
        ['Drivers on shift', `${cabs} cab${cabs === 1 ? '' : 's'}, ${ph} private hire`],
        ['Out on a job', `${out}`],
        ['Fares today', `${today?.fares ?? 0} · $${Math.round(today?.money ?? 0)}`],
        ['Yesterday', `${yest?.f ?? 0} · $${Math.round(yest?.m ?? 0)}`],
      ],
    };
  }

  /** May this citizen take a taxi at all? Adults and retirees with the money for it. */
  static eligible(c: Citizen, fare: number) { return c.stage !== LifeStage.Child && c.money >= fare + 5 && c.state !== S.Work; }
  static label(kind: number) { return FLEET_LABEL[kind]; }
  static key(x: number, y: number) { return tileKey(x, y); }
}
