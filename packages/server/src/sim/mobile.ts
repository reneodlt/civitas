import {
  TICKS_PER_DAY, TICKS_PER_HOUR, gameMin, TRAFFIC_TUNING as TT, CitizenState, VehicleClass, isRoad, tileKey, hash2, nameFor, KIND_NAMES,
  FleetKind, FLEET_LABEL, FLEET_JOB, FLEET_ROTA, BIKE_CLASS, FOOD, REFUSE, packFleet, mobileRole,
  type MobileRole, type Occupation, type CitizenInfo, type FleetInfo, type PersonRef,
} from '@msimcity/shared';
import type { Citizen, Vehicle, World } from '../world';
import { DIRS, tkey, resetTrail } from '../world';
import type { Traffic } from './traffic';
import { dirBetween } from './traffic';
import { busLegs, type BusNet } from './busroute';
import { indicatorOf } from './indicators';
import { ageOf } from './life';
import { SchoolBuses } from './schoolbus';

/**
 * Mobile jobs (docs/mobile-jobs.md): the roaming-worker framework. A worker on shift at their base (or at home, for
 * private hire) is given a task by one of the services (taxis, delivery, refuse, couriers); the framework then puts a
 * vehicle on the road for them, a `Vehicle` in w.vehicles with vkind FLEET_VKIND + its FleetKind, and drives it through
 * the task's stops like a bus: routed with the bus router (heading-aware, live congestion), halting at the kerb
 * (Mover.halt) or driving into a door, dwelling, and back to base when the stops run out. Idle workers have no vehicle.
 */

/** Vehicle kinds of fleet vehicles: FLEET_VKIND + FleetKind (never on the wire; agents carry the fleet bits instead). */
export const FLEET_VKIND = 32;
export const isFleetVehicle = (v: Vehicle) => v.vkind > FLEET_VKIND;
const FLEET_ID_BASE = (1 << 30) + (1 << 28);
const S = CitizenState;
const DAY = TICKS_PER_DAY, TPH = TICKS_PER_HOUR;
/** on-shift index refresh, ticks */
const INDEX_EVERY = 25;
/** search budget per routed stop (states of the heading-aware search) */
const ROUTE_NODES = 6000;
/** a worker whose unit is still out stays on past the end of the shift at most this long */
const OVERTIME = gameMin(90);
/** a unit that cannot pull out of a building for this long is given up */
const PULL_MAX = 200;
/** a worker with less than this left of the shift takes no new work */
const LAST_JOB = gameMin(25);

/** A place a unit goes to: a road tile to halt on beside a building (kerb), or the building itself (door). */
export interface Stop {
  x: number; y: number;
  kerb: boolean;
  /** ticks to stand there */
  dwell: number;
  /** the building served */
  bx: number; by: number;
  /** what the service does there, and the booking, order or round it belongs to (the service's own numbers) */
  what: number; ref: number;
  /** a waypoint: drive through it without stopping (a sweeper's round) */
  pass?: boolean;
}
export interface Unit {
  v: Vehicle;
  kind: number;
  worker: number;
  /** workers riding along (a bin lorry's loaders): on the job with it, not free for other work */
  crew: number[];
  /** the workplace door, or home for private hire */
  base: [number, number];
  /** stops still to make; stops[0] is the one being driven to (or stood at) */
  stops: Stop[];
  /** pull: waiting to leave a building; drive; dwell: standing at stops[0]; idle: parked in a building, nothing to do (private hire) */
  phase: 'pull' | 'drive' | 'dwell' | 'idle';
  dwellUntil: number;
  /** heading back to base: the stops have run out */
  home: boolean;
  loaded: boolean;
  working: boolean;
  /** the worker's shift is over: no new tasks; and since when (after OVERTIME the unit comes off the road) */
  ending: boolean;
  endAt: number;
  svc: FleetService;
  /** what it is doing, for the panels */
  task: string;
  /** today's jobs done and money taken, for the panels */
  day: number; jobs: number; money: number;
}
/** One kind of road work (sim/taxis.ts, delivery.ts, refuse.ts, couriers.ts). */
export interface FleetService {
  /** the fleet kinds whose workers this service employs */
  readonly kinds: readonly number[];
  tick(): void;
  /** the unit has halted at the kerb or driven in at the door of stop s: the dwell starts */
  arrive(u: Unit, s: Stop): void;
  /** the dwell at s is over */
  depart(u: Unit, s: Stop): void;
  /** stop s cannot be reached: it is dropped */
  unreachable(u: Unit, s: Stop): void;
  /** the unit has been taken off the road at `at` with s still to make (stuck, or no worker): set down what it carries */
  withdrawn(u: Unit, at: [number, number]): void;
  /** the unit is back at base, off the road */
  returned(u: Unit): void;
  /** the unit waits at its base for more work instead of coming off the road there (a cab at its office or rank) */
  idleAtBase?(u: Unit): boolean;
  /** a building's tooltip section, or null */
  describe?(bx: number, by: number, kindId: number): FleetInfoRows | null;
  /** what the vehicle is called in its panel ("Ace Cars cab", "Golden Diner rider"), and who rides in it besides the crew */
  label?(u: Unit): string;
  aboard?(u: Unit): PersonRef[];
  /** the worker's base, as their panel names it ("Ace Cars cab office") */
  baseName?(c: Citizen, kind: number): string;
}
export interface FleetInfoRows { role: string; rows: [string, string][] }

export class Mobile {
  readonly units = new Map<number, Unit>();
  private byWorker = new Map<number, Unit>();
  private nextId = FLEET_ID_BASE;
  private services: FleetService[] = [];
  /** the school bus service (sim/schoolbus.ts), registered here so the simulation needs no hook for it */
  readonly schoolBuses: SchoolBuses;
  /** workers on shift now (state Work) by fleet kind, refreshed every INDEX_EVERY ticks */
  private shift = new Map<number, Citizen[]>();
  /** each citizen's road role, cached against their workplace (kind, tile) and cleared once a game day */
  private roles = new Map<number, { sig: number; role: MobileRole | null }>();
  private rolesDay = -1;
  /** counters since start (loadtest/mobile.ts reads them) */
  stats = { launched: 0, returned: 0, withdrawn: 0, stops: 0, unreachable: 0, overtime: 0 };
  /** the road network as the bus router sees it, with live congestion */
  private net: BusNet;

  constructor(private w: World, private traffic: Traffic) {
    this.net = { w, depot: null, cost: (x, y) => traffic.cost(x, y), degree: (x, y) => traffic.degreeOf(x, y), crossing: (x, y) => traffic.isCrossingAt(x, y) };
    this.register(this.schoolBuses = new SchoolBuses(w, this));
  }
  register(svc: FleetService) { this.services.push(svc); }

  // ---- roles and shifts ------------------------------------------------------------------------------------------

  /** The road job of an employed citizen, or null. */
  roleOf(c: Citizen): MobileRole | null {
    if (!c.job) return null;
    const day = Math.floor(this.w.tick / DAY);
    if (day !== this.rolesDay) { this.roles.clear(); this.rolesDay = day; } // levels and designs change slowly; recheck daily
    const sig = ((c.kind * 73856093) ^ (c.wx * 19349663) ^ (c.wy * 83492791) ^ (c.car ? 1 : 0)) | 0;
    const hit = this.roles.get(c.id);
    if (hit && hit.sig === sig) return hit.role;
    const b = this.w.buildings.get(tileKey(c.wx, c.wy));
    const role = b ? mobileRole(c.kind, b.level, c.wx, c.wy, c.id, c.car) : null;
    this.roles.set(c.id, { sig, role });
    return role;
  }
  /** The rota for a new hire at a workplace, when the job is on the road (Simulation.hire). */
  rotaFor(c: Citizen): Occupation | null {
    const r = this.roleOf(c);
    return r ? FLEET_ROTA[r.kind] ?? null : null;
  }
  /** Private hire: the shift starts at home, with no commute (Simulation.depart). */
  worksFromHome(c: Citizen): boolean { return !!this.roleOf(c)?.fromHome; }
  /**
   * The shift is over (Simulation.endShift): true while the worker's unit is still out, so they stay on. The unit stops
   * taking work and comes back; after OVERTIME it is taken off the road where it is.
   */
  holdShift(c: Citizen): boolean {
    const u = this.byWorker.get(c.id);
    if (!u) return false;
    if (u.phase === 'idle') { this.remove(u); return false; } // private hire logs off where it is
    if (!u.ending) { u.ending = true; u.endAt = this.w.tick; }
    return this.units.has(u.v.id);
  }
  /** Workers of these kinds on shift now (state Work; refreshed every INDEX_EVERY ticks). */
  onShift(kind: number): readonly Citizen[] { return this.shift.get(kind) ?? []; }
  unitOf(cid: number): Unit | undefined { return this.byWorker.get(cid); }
  /** A worker on shift with no unit out, or whose unit is free to take more work. */
  free(c: Citizen): boolean {
    if (c.state !== S.Work || !this.w.citizens.has(c.id) || c.nextAt - this.w.tick < LAST_JOB) return false;
    const u = this.byWorker.get(c.id);
    return !u || (!u.ending && (u.phase === 'idle' || (u.home && !u.loaded)));
  }

  private refresh() {
    this.shift.clear();
    for (const c of this.w.citizens.values()) {
      if (c.state !== S.Work) continue;
      const r = this.roleOf(c);
      if (!r) continue;
      let l = this.shift.get(r.kind);
      if (!l) this.shift.set(r.kind, l = []);
      l.push(c);
    }
  }

  // ---- the road ----------------------------------------------------------------------------------------------------

  /**
   * The road tile a vehicle halts on to serve building (bx, by): the building's front (the first road beside it, south,
   * east, west then north, as the renderer turns it), when that is a plain stretch: not a junction box, a roundabout or
   * flyover, a level crossing or a bridge. Null when there is none: the building is served at its door.
   */
  kerbOf(bx: number, by: number): [number, number] | null {
    for (const d of [2, 0, 1, 3]) {
      const x = bx + DIRS[d][0], y = by + DIRS[d][1];
      const t = this.w.peekTile(x, y);
      if (t === undefined || !isRoad(t) || (t & 3) === 3) continue; // a bridge deck is road on water
      if (this.traffic.degreeOf(x, y) >= 3 || this.traffic.junctionAux(x, y) || this.traffic.isCrossingAt(x, y) || this.w.auxAt(x, y)) return null;
      return [x, y];
    }
    return null;
  }
  /** A stop serving building (bx, by): at its kerb when it has a plain one, else at the door. */
  stopAt(bx: number, by: number, dwell: number, what: number, ref: number): Stop {
    const k = this.kerbOf(bx, by);
    return k ? { x: k[0], y: k[1], kerb: true, dwell, bx, by, what, ref } : { x: bx, y: by, kerb: false, dwell, bx, by, what, ref };
  }

  /**
   * Put a vehicle on the road for worker c of fleet kind `kind`, leaving building `from` with `stops` to make and
   * `base` to come back to. Null when it cannot be routed to its first stop.
   */
  launch(svc: FleetService, c: Citizen, kind: number, from: [number, number], base: [number, number], stops: Stop[], task: string, crew: number[] = []): Unit | null {
    const old = this.byWorker.get(c.id);
    if (old) { if (old.phase !== 'idle') return null; this.remove(old); }
    const id = this.nextId++;
    const v: Vehicle = {
      id, x: from[0] + 0.5, y: from[1] + 0.5, path: [from[0], from[1]], pi: 0, vkind: FLEET_VKIND + kind, phase: 'out', from: base, to: from, until: 0,
      parkedAt: null, parkKerb: false, owner: this.w.parcelAt(base[0], base[1])?.owner ?? null, legs: [], leg: null,
      call: false, weave: false, fee: undefined, // as every vehicle (Simulation.spawnVehicle): one shape
      ...this.w.moverDefaults(c.id), // the driver's own style
      halt: undefined, dwell: undefined,
    };
    v.halt = -1;
    v.cls = kind === FleetKind.Bicycle || kind === FleetKind.Moped ? BIKE_CLASS : kind === FleetKind.CourierVan ? VehicleClass.Van : kind === FleetKind.BinLorry || kind === FleetKind.Sweeper || kind === FleetKind.Gritter ? VehicleClass.Truck : kind === FleetKind.RoadCrew ? VehicleClass.Van : kind === FleetKind.SchoolBus ? VehicleClass.Bus : VehicleClass.Sedan;
    if (kind === FleetKind.Bicycle) { v.speedMul *= FOOD.bicycleSpeed; v.gapMul *= 0.7; }
    else if (kind === FleetKind.Moped) { v.speedMul *= FOOD.mopedSpeed; v.gapMul *= 0.8; }
    else if (kind === FleetKind.Sweeper) v.speedMul *= REFUSE.sweeperSpeed;
    else if (kind === FleetKind.BinLorry) v.gapMul *= 1.2;
    else if (kind === FleetKind.SchoolBus) v.gapMul *= 1.2;
    const day = Math.floor(this.w.tick / DAY);
    const u: Unit = { v, kind, worker: c.id, crew, base, stops, phase: 'pull', dwellUntil: 0, home: false, loaded: false, working: false, ending: false, endAt: 0, svc, task, day, jobs: 0, money: 0 };
    resetTrail(v, from[0], from[1]);
    if (!this.plan(u, true)) return null;
    v.leg = { path: v.path, drive: true, arrive: 'none' };
    this.w.vehicles.set(id, v);
    this.units.set(id, u);
    this.byWorker.set(c.id, u);
    for (const id of crew) this.byWorker.set(id, u);
    this.stats.launched++;
    return u;
  }
  /** Give a unit (idle, or on its way back) new stops. */
  retask(u: Unit, stops: Stop[], task: string): boolean {
    u.stops = stops; u.home = false; u.task = task;
    if (u.phase === 'idle') {
      // parked in a building: pull out afresh from where it is
      const at: [number, number] = [Math.floor(u.v.x), Math.floor(u.v.y)];
      u.v.path = [at[0], at[1]]; u.v.pi = 0; u.phase = 'pull'; u.v.phase = 'out';
      resetTrail(u.v, at[0], at[1]);
      if (!this.plan(u, true)) { u.stops = []; u.phase = 'idle'; u.v.phase = 'dwell'; return false; }
      if (u.v.leg) u.v.leg.path = u.v.path; else u.v.leg = { path: u.v.path, drive: true, arrive: 'none' };
      return true;
    }
    return this.plan(u, u.phase === 'pull');
  }

  /**
   * Route the unit from where it is to stops[0] and on to the stop after it (or its base), so a halt always has a next
   * node. `fresh`: it is in a building (the path is just its door). Stops it cannot reach are dropped (the service
   * hears); false when it cannot even get home.
   */
  private plan(u: Unit, fresh: boolean, avoidAhead = false): boolean {
    const v = u.v;
    const lock = !fresh && (v.committed || v.prog >= 0.5) ? 2 : 1;
    const keep = fresh ? 1 : Math.max(1, Math.min(v.path.length / 2, v.pi + lock));
    // drop what is well behind: the lane geometry reads only the node before the one being approached
    const cut = fresh ? 0 : Math.max(0, v.pi - 2);
    const head = v.path.slice(cut * 2, keep * 2);
    // a stuck unit steers clear of the tile after the one it is entering (what holds it up), as a stuck bus does
    const ahead = avoidAhead && v.pi + 1 < v.path.length / 2 ? [v.path[(v.pi + 1) * 2], v.path[(v.pi + 1) * 2 + 1]] : null;
    const avoid = ahead ? (x: number, y: number) => x === ahead[0] && y === ahead[1] : undefined;
    const sx = head[head.length - 2], sy = head[head.length - 1];
    const sdir = head.length >= 4 ? dirBetween(head[head.length - 4], head[head.length - 3], sx, sy) : -1;
    let path = head, cx = sx, cy = sy, dir = sdir;
    for (;;) {
      const a = u.stops[0];
      const tx = a ? a.x : u.base[0], ty = a ? a.y : u.base[1];
      u.home = !a;
      let halt = -1;
      if (cx !== tx || cy !== ty) {
        const first = path === head;
        const leg = (first && ahead && !(ahead[0] === tx && ahead[1] === ty) ? this.leg(cx, cy, dir, tx, ty, avoid) : null) ?? this.leg(cx, cy, dir, tx, ty);
        if (!leg) {
          if (!a) { if (path === head) return false; break; }
          this.stats.unreachable++;
          u.stops.shift();
          if (!a.pass) u.svc.unreachable(u, a);
          continue;
        }
        path = [...path, ...leg.path.slice(2)];
        dir = leg.dir; cx = tx; cy = ty;
      }
      // a waypoint: on through it to the next (the whole run of them is routed now)
      if (a?.pass) { u.stops.shift(); continue; }
      if (a?.kerb) {
        // halt on the stop's road tile; a halt needs a node after it, so drive on towards the stop after (or home)
        halt = path.length / 2 - 1;
        const b = u.stops[1];
        const nx = b ? b.x : u.base[0], ny = b ? b.y : u.base[1];
        const on = nx === a.x && ny === a.y ? null : this.leg(a.x, a.y, dir, nx, ny);
        if (on) path = [...path, ...on.path.slice(2)];
        else { path = [...path, a.bx, a.by]; halt = -1; a.kerb = false; a.x = a.bx; a.y = a.by; } // nowhere on from it: in at the door instead
      }
      v.path = path; v.pi -= cut; v.halt = halt; v.dwell = false;
      if (v.leg) v.leg.path = path;
      v.to = a ? [a.bx, a.by] : u.base;
      return path.length >= 4;
    }
    // home is out of reach after a run of waypoints: end where they end (the unit is taken off the road there)
    v.path = path; v.pi -= cut; v.halt = -1; v.dwell = false;
    if (v.leg) v.leg.path = path;
    return path.length >= 4;
  }
  private leg(sx: number, sy: number, sdir: number, tx: number, ty: number, avoid?: (x: number, y: number) => boolean) {
    const r = busLegs(this.net, sx, sy, sdir, tx, ty, { maxNodes: ROUTE_NODES, slack: 0, avoid });
    let best: (typeof r.legs)[number] = null;
    for (const l of r.legs) if (l && (!best || l.cost < best.cost)) best = l;
    return best;
  }

  tick() {
    const tick = this.w.tick;
    if (tick % INDEX_EVERY === 3) this.refresh();
    for (const s of this.services) s.tick();
    for (const u of [...this.units.values()]) this.step(u);
  }

  private step(u: Unit) {
    const v = u.v, tick = this.w.tick, day = Math.floor(tick / DAY);
    if (u.day !== day) { u.day = day; u.jobs = 0; u.money = 0; }
    const c = this.w.citizens.get(u.worker);
    if (!c || !c.job) { if (u.phase === 'idle') this.remove(u); else this.withdraw(u); return; }
    if (c.state !== S.Work && !u.ending) { u.ending = true; u.endAt = tick; } // gone home another way (a lift with a colleague): finish and come back
    if (u.phase === 'idle') { if (u.ending) this.remove(u); return; }
    if (u.ending && tick - u.endAt > OVERTIME) { this.stats.overtime++; this.withdraw(u); return; }
    if (u.phase === 'pull') {
      if (this.traffic.enter(v) === 'blocked') { if (++v.wait > PULL_MAX) this.withdraw(u); return; }
      u.phase = 'drive';
      return;
    }
    if (u.phase === 'dwell') {
      if (v.lane >= 0) this.traffic.step(v); // standing in the lane: the halt holds it, the dwell keeps its stuck clock still
      if (tick < u.dwellUntil) return;
      const s = u.stops.shift()!;
      u.working = false;
      this.stats.stops++;
      u.svc.depart(u, s);
      if (!this.units.has(v.id)) return;
      v.dwell = false;
      if (v.lane >= 0) { u.phase = 'drive'; if (!this.plan(u, false)) this.withdraw(u); return; }
      // in at a door: pull out again, or stay parked (private hire with nothing to do)
      if (!u.stops.length && u.kind === FleetKind.PrivateHire && !u.ending) { this.park(u); return; }
      const at: [number, number] = [s.bx, s.by];
      v.path = [at[0], at[1]]; v.pi = 0; v.x = at[0] + 0.5; v.y = at[1] + 0.5; v.phase = 'out';
      resetTrail(v, at[0], at[1]);
      u.phase = 'pull';
      if (!this.plan(u, true)) { this.withdraw(u); return; }
      return;
    }
    const r = this.traffic.step(v);
    const a = u.stops[0];
    if (r === 'arrived') {
      if (!a) {
        if (!u.ending && u.svc.idleAtBase?.(u)) { const t = u.task; this.park(u); u.task = t; u.v.x = u.base[0] + 0.5; u.v.y = u.base[1] + 0.5; }
        else this.home(u);
        return;
      }
      // in at the door of the stop (or at the end of the road, if its kerb had nowhere on)
      this.startDwell(u, a);
      return;
    }
    if (r === 'stuck') {
      // as a stuck bus: one look for a way round the tile after the next, then off the road
      if (v.stuck > TT.stuckLimit + 10) { this.withdraw(u); return; }
      if (v.stuck === TT.stuckLimit + 1 && !v.committed && v.prog < 0.5) this.plan(u, false, true);
    }
    if (a?.kerb && (v.halt ?? -1) >= 0 && this.traffic.atHalt(v)) this.startDwell(u, a);
  }
  private startDwell(u: Unit, s: Stop) {
    const v = u.v;
    u.phase = 'dwell';
    u.dwellUntil = this.w.tick + s.dwell;
    u.working = true;
    if (v.lane >= 0) v.dwell = true;
    else { v.phase = 'dwell'; v.x = s.bx + 0.5; v.y = s.by + 0.5; }
    u.svc.arrive(u, s);
  }
  /** Parked in a building with nothing to do (private hire between fares). */
  private park(u: Unit) {
    u.phase = 'idle'; u.v.phase = 'dwell'; u.home = false; u.loaded = false; u.task = 'waiting for a booking';
    this.traffic.leave(u.v);
  }
  private home(u: Unit) {
    this.stats.returned++;
    u.svc.returned(u);
    this.remove(u);
  }
  /** Off the road where it is: whatever it carries is set down there. */
  withdraw(u: Unit) {
    const v = u.v;
    const at: [number, number] = v.lane >= 0 && v.pi >= 1 ? [v.path[(v.pi - 1) * 2], v.path[(v.pi - 1) * 2 + 1]] : [Math.floor(v.x), Math.floor(v.y)];
    this.stats.withdrawn++;
    this.remove(u);
    u.svc.withdrawn(u, at);
  }
  remove(u: Unit) {
    this.traffic.leave(u.v);
    this.w.vehicles.delete(u.v.id);
    this.units.delete(u.v.id);
    for (const id of [u.worker, ...u.crew]) if (this.byWorker.get(id) === u) this.byWorker.delete(id);
  }
  /** A citizen has gone (died, left town): their unit comes off the road. */
  forget(c: Citizen) {
    const u = this.byWorker.get(c.id);
    if (u) { if (u.phase === 'idle') this.remove(u); else this.withdraw(u); }
  }
  /** Credit a job done to the unit's day (panels). */
  note(u: Unit, money: number) { u.jobs++; u.money += money; }

  // ---- the wire and the panels ---------------------------------------------------------------------------------------

  /** The agent quad for a fleet vehicle on the road, or null when it is off the road. */
  agentOf(v: Vehicle) {
    const u = this.units.get(v.id);
    if (!u || v.lane < 0) return null;
    const rev = this.traffic.reversing(v);
    const cls = v.cls === BIKE_CLASS ? VehicleClass.Sedan : v.cls;
    return { id: v.id, x: v.x, y: v.y, state: u.home ? S.ToHome : S.ToWork, mode: 1, kind: 0, cls, queued: v.wait > 1 && !v.dwell, emergency: false, stage: 0, rev, ind: indicatorOf(v, rev), extra: packFleet(u.kind, u.loaded, u.working) };
  }
  /** A fleet vehicle's panel: what it is, who drives it, who or what is aboard, what it is doing. */
  describe(v: Vehicle): CitizenInfo | null {
    const u = this.units.get(v.id);
    if (!u) return null;
    const w = this.w, label = FLEET_LABEL[u.kind] ?? 'vehicle';
    const c = w.citizens.get(u.worker);
    const a = u.stops[0];
    const named = (x: number, y: number) => { const b = w.buildings.get(tileKey(x, y)); return b ? `${KIND_NAMES[b.id]} (${x}, ${y})` : `(${x}, ${y})`; };
    const occupants: PersonRef[] = [];
    if (c) occupants.push({ id: c.id, name: nameFor(c.id, c.sn), age: Math.floor(ageOf(c, w.tick)), relation: 'driver', activity: FLEET_JOB[u.kind] ?? 'driver' });
    for (const id of u.crew) { const o = w.citizens.get(id); if (o) occupants.push({ id, name: nameFor(id, o.sn), age: Math.floor(ageOf(o, w.tick)), relation: 'loader', activity: FLEET_JOB[u.kind] ?? 'crew' }); }
    occupants.push(...(u.svc.aboard?.(u) ?? []));
    const title = u.svc.label?.(u) ?? label;
    const info: CitizenInfo = {
      id: v.id, name: `${title[0].toUpperCase()}${title.slice(1)} ${(v.id - FLEET_ID_BASE) % 1000}`, role: label,
      activity: u.task, mode: 'drive',
      status: u.phase === 'dwell' || u.phase === 'idle' ? 'idle' : v.wait > 1 ? 'queued' : 'moving', waitTicks: v.wait,
      destination: a ? { x: a.bx, y: a.by, label: named(a.bx, a.by) } : { x: u.base[0], y: u.base[1], label: u.kind === FleetKind.PrivateHire ? 'home' : named(u.base[0], u.base[1]) },
      occupants,
      fleet: this.fleetInfo(u),
    };
    if (v.leg && v.lane >= 0) { info.tripDone = Math.max(0, v.pi - 1); info.tripTotal = v.path.length / 2 - 1; }
    return info;
  }
  /** What a worker's or a vehicle's panel says about the job. */
  fleetInfo(u: Unit): FleetInfo {
    return { kind: u.kind, vehicle: u.v.id, task: u.task, today: { jobs: u.jobs, money: Math.round(u.money * 100) / 100 }, stops: u.stops.length };
  }
  /** A worker's panel: their road job, and the vehicle they are out in (clickable) or that they are waiting for work. */
  workerInfo(c: Citizen): FleetInfo | undefined {
    const r = this.roleOf(c);
    if (!r) return undefined;
    const u = this.byWorker.get(c.id);
    const base = this.services.find((s) => s.kinds.includes(r.kind))?.baseName?.(c, r.kind);
    const info: FleetInfo = u ? this.fleetInfo(u) : { kind: r.kind, task: c.state === S.Work ? (r.kind === FleetKind.PrivateHire ? 'logged on at home, waiting for a booking' : 'at the base, waiting for work') : 'off shift' };
    if (base) info.base = base;
    return info;
  }
  /** What a worker's activity line says while on shift. */
  activity(c: Citizen): string | null {
    if (c.state !== S.Work) return null;
    const u = this.byWorker.get(c.id);
    const r = this.roleOf(c);
    if (!r) return null;
    if (!u) return r.kind === FleetKind.PrivateHire ? 'on shift at home, app on, waiting for a booking' : `on shift, waiting for work`;
    return `${FLEET_LABEL[u.kind]}: ${u.task}`;
  }
  /** The tooltip sections of the services for a building. */
  describeBuilding(bx: number, by: number, kindId: number): FleetInfoRows[] {
    const out: FleetInfoRows[] = [];
    for (const s of this.services) { const r = s.describe?.(bx, by, kindId); if (r) out.push(r); }
    return out;
  }
  /** Units out on the road now, by fleet kind (probes). */
  counts(): Record<number, number> {
    const n: Record<number, number> = {};
    for (const u of this.units.values()) if (u.phase !== 'idle') n[u.kind] = (n[u.kind] ?? 0) + 1;
    return n;
  }
  /** Spread a value over the town by a building's tile: a stable per-place taste in [lo, lo + span). */
  static taste(x: number, y: number, salt: number, lo: number, span: number) { return lo + span * hash2(x * 37 + salt, y * 53 + salt * 7); }
  static key(x: number, y: number) { return tkey(x, y); }
  static hour(tick: number) { return (tick % DAY) / TPH; }
}
