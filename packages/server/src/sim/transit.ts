import {
  turnAllowed, TICKS_PER_DAY, TICKS_PER_HOUR, WALK_SPEED, DRIVE_SPEED, TRAFFIC_TUNING as TT, TRANSIT, VehicleClass, VehicleKind,
  isRoad, hash2, stopName, inServiceHours, stopModeOf, walkCost, BUS_DEPOT_KIND, LifeStage, zoneOf, terrainOf, Terrain, problemText,
  type TransitLine, type TransitMode, type StopRef, type LineInfo, type StopInfo, type BusInfo, type CitizenInfo, type LinePreview, type LineProblem,
} from '@msimcity/shared';
import { DIRS, tkey, resetTrail, noteTrail, type Citizen, type Leg, type Vehicle, type World } from '../world';
import { pathBetween } from '../pathfinding';
import { noteSpend } from './life';
import { dirBetween, type Traffic } from './traffic';
import { busLegs, planLap, isReversal, turnAt, joinGap, TURN_TICKS, type BusNet, type LapFail } from './busroute';

/**
 * Public transport (docs/transit.md): one registry of lines for every mode, the riders who use them, and the
 * planner that offers a trip by line to the simulation's mode choice. Each mode runs its own vehicles through a
 * ModeService: buses (BusService, below) drive the ordinary traffic model; the rail module registers its own.
 *
 * A rider's trip is ordinary legs: walk to the stop, one ride leg per line (`Leg.ride`), walk on from the stop they
 * get off at. During a ride leg the rider is first waiting at the stop (drawn there, standing), then on board
 * (not drawn; counted in the vehicle's load), and the leg ends when the vehicle calls at their stop.
 */

const DAY = TICKS_PER_DAY, TPH = TICKS_PER_HOUR;

/** The road (or track) a line's vehicles drive round once, and where on it each call is. */
export interface LineRoute {
  /** stop index (into line.stops) per call, in the order vehicles call */
  calls: number[];
  /** one lap, flat [x0,y0,…]; the tile after the last node is node 0 again */
  path: number[];
  /** path node index of each call (the tile the vehicle stands on to serve that stop) */
  callNodes: number[];
}
/**
 * What a mode provides to the registry. The registry owns lines, riders, fares and ridership; a service owns its
 * vehicles. A vehicle standing at a call hands over with `Transit.serveCall`.
 */
export interface ModeService {
  readonly mode: TransitMode;
  /** Is (x, y) a stop this mode can call at? Null when it is, else why not. */
  stopProblem(x: number, y: number): string | null;
  /** Work out a line's lap, or say why it cannot run. Called on save and whenever the network under it changes. */
  route(line: TransitLine): LineRoute | string;
  /** A draft line routed for the editor's preview (the lap, its length and time, what is wrong); optional. */
  plan?(line: TransitLine): Omit<LinePreview, 'seq'>;
  /** Is a lap routed earlier still drivable (roads, stops and turns still there)? Optional: every line is kept otherwise. */
  lapValid?(r: LineRoute): boolean;
  /** Expected ticks until a vehicle of `line` calls at `call` (from now); null when none will soon (not running). */
  waitAt(line: TransitLine, call: number): number | null;
  /** Expected in-vehicle ticks from call a to call b (b after a round the lap; b === a is a whole lap). */
  rideTicks(line: TransitLine, a: number, b: number): number;
  /**
   * Lines this service keeps itself (rail keeps its own definitions and editor). Omit it to use the shared
   * registry (World.transitLines, edited through Transit.saveLine), as buses do. Ids must not clash across services:
   * a service that keeps its own lines numbers them from its own base (rail: RAIL_LINE_ID_BASE).
   */
  lines?(): Iterable<TransitLine>;
  /** Ticks between vehicles of the line at a stop now (a lap over the vehicles in service); optional, null when not running. */
  headway?(line: TransitLine): number | null;
  /** Vehicles of the line in service now. */
  inService(line: TransitLine): number;
  /** Why the line is not running right now (no depot, no drivers, outside hours), or null when it is. */
  problem(line: TransitLine): string | null;
  /** Move vehicles one tick (called by Transit.tick every simulation tick). */
  tick(): void;
  /** A line was saved (changed) or deleted (null): re-route or withdraw its vehicles. */
  lineChanged(id: number, line: TransitLine | null): void;
  /** Where a vehicle is now, so riders on board move with it; null when it is gone. */
  positionOf(vehicleId: number): [number, number] | null;
  /**
   * Make what a line needs before it is routed, and pay for it (the metro bores its tunnels: sim/metro.ts); called by
   * saveLine after the stops are checked and before route(). An error refuses the save. Optional.
   */
  commit?(line: TransitLine): string | null;
  /** Where a rider stands waiting at a stop, seeded per rider (the metro: along the platform); optional, else the kerb crowd (standAt). */
  waitSpot?(stop: StopRef, citizenId: number): [number, number] | null;
  /** Riders of this mode wait and ride below ground: their agents carry CITIZEN_UNDER and the surface does not draw them. */
  readonly under?: boolean;
}

/** One ride of a planned trip. */
export interface RidePlan { line: TransitLine; from: number; to: number; board: StopRef; off: StopRef; wait: number; ride: number }
/** A trip by transit as the planner prices it: perceived ticks (walking and waiting weighted) and how many fares it takes. */
export interface TransitPlan { rides: RidePlan[]; walkIn: number; walkOut: number; ticks: number; perceived: number; fare: number }

interface Rider {
  c: Citizen; leg: Leg; line: number; from: number; to: number;
  stop: StopRef; off: StopRef;
  phase: 'wait' | 'ride';
  since: number; maxWait: number; vehicle: number;
  /** tick the rider steps aboard: boarding takes the dwell, one rider a tick, so the crowd thins while the bus stands */
  boardAt: number;
}
interface Count { day: number; today: number; yesterday: number; fares: number }

export class Transit {
  /** a sandbox (test city or demo): anyone may edit or delete any line and call at any owner's stops; set by game.ts */
  sandbox = false;
  readonly services = new Map<TransitMode, ModeService>();
  private routes = new Map<number, LineRoute | string>();
  private riders = new Map<number, Rider>();
  private waiting = new Map<number, Rider[]>(); // by stop tile key
  private onboard = new Map<number, Rider[]>(); // by vehicle id
  private lineCount = new Map<number, Count>();
  private stopCount = new Map<number, Count>();
  /** stops of routed lines by 8×8 cell, for the catchment search */
  private stopGrid = new Map<number, StopRef[]>();
  /** routed lines by stop tile key, with the calls of that stop on each */
  private linesAt = new Map<number, { line: TransitLine; calls: number[] }[]>();
  /** bumped when lines change; the network layer re-sends lines when it moves */
  version = 1;
  /** counters since start (the A/B harness reads these) */
  stats = { planned: 0, boarded: 0, alighted: 0, gaveUp: 0, transfers: 0, evacuated: 0 };

  constructor(private w: World) {}

  register(svc: ModeService) {
    this.services.set(svc.mode, svc);
    this.rebuild();
  }
  /** every line of every mode, by id (rebuilt by indexLines) */
  private byId = new Map<number, TransitLine>();
  private get lines() { return this.byId; }
  line(id: number) { return this.byId.get(id); }
  /** Every line: the shared registry plus the lines services keep themselves. */
  private *allLines(): Iterable<TransitLine> {
    yield* this.w.transitLines.values();
    for (const svc of this.services.values()) if (svc.lines) yield* svc.lines();
  }
  /** A service that keeps its own lines changed them: route and index them again. */
  linesChanged() { this.rebuild(); }
  routeOf(id: number): LineRoute | null { const r = this.routes.get(id); return r && typeof r !== 'string' ? r : null; }
  /** Problem with a line's route ('' when routed). */
  routeProblem(id: number): string { const r = this.routes.get(id); return typeof r === 'string' ? r : r ? '' : 'not routed yet'; }
  /** True when any line could carry anyone (the planner is skipped otherwise). */
  get any() { return this.linesAt.size > 0; }

  // ---- lines ------------------------------------------------------------------------------

  /**
   * The stops of a draft line, checked: each a stop of the first one's mode, on the owner's land (any land in a
   * sandbox), in a service that takes lines from the shared registry. The stops' own problems (no road beside one,
   * facing a junction) are left to a service that plans its routes (buses), whose route says how to fix them.
   */
  private draftStops(owner: string, spec: Partial<TransitLine>): { stops: StopRef[]; mode: TransitMode; svc: ModeService } | LineProblem {
    const bad = (message: string, stop?: number, s?: StopRef): LineProblem => ({ message, stop, tiles: s ? [s.x, s.y] : [], fatal: true });
    const stops: StopRef[] = [];
    for (const s of Array.isArray(spec.stops) ? spec.stops.slice(0, TRANSIT.maxStops) : []) {
      const x = Math.floor(Number(s?.x)), y = Math.floor(Number(s?.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return bad('Bad stop');
      if (stops.length && stops[stops.length - 1].x === x && stops[stops.length - 1].y === y) continue;
      stops.push({ x, y });
    }
    if (stops.length < 2) return bad('A line needs at least two stops');
    const mode = stopModeOf(this.w.kindIdAt(stops[0].x, stops[0].y));
    if (!mode) return bad(`(${stops[0].x}, ${stops[0].y}) is not a stop`, 0, stops[0]);
    const svc = this.services.get(mode);
    if (!svc) return bad(`No ${mode} service on this server`);
    if (svc.lines) return bad(`${mode} lines are set up in their own panel`);
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (stopModeOf(this.w.kindIdAt(s.x, s.y)) !== mode) return bad(`${this.w.stopLabel(s.x, s.y)} (stop ${i + 1}) is not a ${mode} stop`, i, s);
      if (!this.sandbox && this.w.parcelAt(s.x, s.y)?.owner !== owner) return bad(`${this.w.stopLabel(s.x, s.y)} (stop ${i + 1}) is not on your land`, i, s);
      if (svc.plan) continue;
      const p = svc.stopProblem(s.x, s.y);
      if (p) return bad(p, i, s);
    }
    return { stops, mode, svc };
  }
  /** Route a draft line for the editor without saving it (the 'linePreview' message). */
  previewLine(owner: string, spec: Partial<TransitLine>, seq: number): LinePreview {
    const d = this.draftStops(owner, spec);
    const none = { seq, ok: false, path: [], calls: [], callNodes: [], turns: [], length: 0, lapTicks: 0 };
    if (!('svc' in d)) return { ...none, problem: d };
    const line: TransitLine = { id: Number(spec.id) || 0, owner, mode: d.mode, number: 1, colour: 0, stops: d.stops, loop: spec.loop !== false, vehicles: 1 };
    const prev = spec.id ? this.w.transitLines.get(Number(spec.id)) : undefined;
    if (prev) line.owner = prev.owner; // its owner's depot, as when it is saved
    if (d.svc.plan) return { seq, ...d.svc.plan(line) };
    const r = d.svc.route(line);
    if (typeof r === 'string') return { ...none, problem: { message: r, tiles: [], fatal: true } };
    return { ...none, ok: true, path: r.path, calls: r.calls, callNodes: r.callNodes, length: r.path.length / 2 };
  }
  /** Create or replace a line after validating it; returns an error message or the saved line. */
  saveLine(owner: string, spec: Partial<TransitLine> & { id?: number }): TransitLine | string {
    const d = this.draftStops(owner, spec);
    if (!('svc' in d)) return problemText(d);
    const { stops, mode, svc } = d;
    const prev = spec.id ? this.w.transitLines.get(Number(spec.id)) : undefined;
    if (prev && prev.owner !== owner && !this.sandbox) return 'Not your line';
    if (prev) owner = prev.owner; // a sandbox visitor editing someone's line leaves it theirs (fares, depot)
    const num = Math.max(1, Math.min(999, Math.floor(Number(spec.number) || 1)));
    for (const l of this.lines.values()) if (l.owner === owner && l.mode === mode && l.number === num && l.id !== prev?.id) return `You already run a ${mode} ${num}`;
    const line: TransitLine = {
      id: prev?.id ?? this.w.nextLineId++, owner, mode, number: num,
      colour: (Number(spec.colour) >>> 0) & 0xffffff, stops, loop: spec.loop !== false,
      vehicles: Math.max(0, Math.min(TRANSIT.maxVehicles, Math.floor(Number(spec.vehicles) || 0))),
    };
    const name = typeof spec.name === 'string' ? spec.name.trim().slice(0, 24) : prev?.name;
    if (name) line.name = name;
    if (svc.commit) { const err = svc.commit(line); if (err) return err; }
    const r = svc.route(line);
    if (typeof r === 'string') return r;
    this.w.transitLines.set(line.id, line);
    this.routes.set(line.id, r);
    this.indexLines();
    svc.lineChanged(line.id, line);
    this.dropRidersOf(line.id, prev ? r : null);
    this.version++;
    return line;
  }
  deleteLine(owner: string, id: number): string | null {
    const l = this.w.transitLines.get(id);
    if (!l) return 'No such line';
    if (l.owner !== owner && !this.sandbox) return 'Not your line';
    this.w.transitLines.delete(id);
    this.routes.delete(id);
    this.indexLines();
    this.services.get(l.mode)?.lineChanged(id, null);
    this.dropRidersOf(id, null);
    this.version++;
    return null;
  }
  /** Route every line again (after load, or when a service registers). */
  rebuild() {
    this.byId.clear();
    for (const l of this.allLines()) this.byId.set(l.id, l);
    for (const id of [...this.routes.keys()]) if (!this.byId.has(id)) this.routes.delete(id);
    for (const l of this.lines.values()) {
      const svc = this.services.get(l.mode);
      this.routes.set(l.id, svc ? svc.route(l) : `no ${l.mode} service`);
    }
    this.indexLines();
    // services that keep their own lines hear about them here; registry lines (buses) are told when they are saved
    for (const l of this.lines.values()) { const svc = this.services.get(l.mode); if (svc?.lines) svc.lineChanged(l.id, l); }
    this.version++;
  }
  /**
   * A mode's network changed under its lines (track laid or lifted: rail calls this): route every line of the other
   * modes again now, and tell the service and the riders about each one whose route changed. Bus lines are left to
   * validate(), which re-routes a lap only when its roads or stops are gone (a fresh A* over live congestion would move
   * every bus each time).
   */
  revalidate() {
    let changed = false;
    for (const l of this.lines.values()) {
      if (l.mode === 'bus') continue;
      const svc = this.services.get(l.mode);
      if (!svc) continue;
      const was = this.routes.get(l.id), nr = svc.route(l);
      if (JSON.stringify(was ?? null) === JSON.stringify(nr)) continue;
      this.routes.set(l.id, nr);
      svc.lineChanged(l.id, l);
      if (typeof nr === 'string') this.dropRidersOf(l.id, null);
      changed = true;
    }
    if (changed) { this.indexLines(); this.version++; }
  }
  /** Re-check lines whose stops or roads changed (called every so often): a broken lap is re-routed or suspended. */
  private validate() {
    let changed = false;
    for (const l of this.lines.values()) {
      const r = this.routes.get(l.id);
      const svc = this.services.get(l.mode);
      if (!svc) continue;
      const stopsOk = l.stops.every((s) => stopModeOf(this.w.kindIdAt(s.x, s.y)) === l.mode && !svc.stopProblem(s.x, s.y));
      let ok = !!r && typeof r !== 'string' && stopsOk;
      if (ok && svc.lapValid) ok = svc.lapValid(r as LineRoute);
      if (ok && typeof r !== 'string') continue;
      // broken, or broken before: try again (roads may have come back)
      const nr = stopsOk ? svc.route(l) : `a stop on line ${l.number} is gone`;
      const was = typeof r === 'string' ? r : '';
      const now = typeof nr === 'string' ? nr : '';
      if (was === now && typeof nr === 'string') continue;
      this.routes.set(l.id, nr);
      svc.lineChanged(l.id, l);
      if (typeof nr === 'string') this.dropRidersOf(l.id, null);
      changed = true;
    }
    if (changed) { this.indexLines(); this.version++; }
  }
  private indexLines() {
    this.byId.clear();
    for (const l of this.allLines()) this.byId.set(l.id, l);
    this.stopGrid.clear(); this.linesAt.clear();
    for (const l of this.lines.values()) {
      const r = this.routeOf(l.id);
      if (!r) continue;
      r.calls.forEach((si, call) => {
        const s = l.stops[si], k = tkey(s.x, s.y);
        let at = this.linesAt.get(k);
        if (!at) {
          this.linesAt.set(k, at = []);
          const ck = cellKey(s.x, s.y);
          let g = this.stopGrid.get(ck);
          if (!g) this.stopGrid.set(ck, g = []);
          g.push(s);
        }
        let e = at.find((a) => a.line === l);
        if (!e) at.push(e = { line: l, calls: [] });
        e.calls.push(call);
      });
    }
  }
  /** Riders of a line that changed: those waiting give up (walk), those on board stay on (their vehicle drops them). */
  private dropRidersOf(id: number, _route: LineRoute | null) {
    for (const r of [...this.riders.values()]) if (r.line === id && r.phase === 'wait') this.giveUp(r);
  }

  // ---- per tick -------------------------------------------------------------------------------

  tick() {
    const tick = this.w.tick;
    if (tick % 100 === 37) this.validate();
    for (const svc of this.services.values()) svc.tick();
    // riders on board move with their vehicle
    for (const [vid, list] of this.onboard) {
      const svc = this.serviceOfVehicle(list);
      const p = svc?.positionOf(vid);
      if (!p) { this.evacuate(vid, null); continue; }
      const tick = this.w.tick;
      for (const r of list) if (tick >= r.boardAt) { r.c.x = p[0]; r.c.y = p[1]; } // still stepping aboard: at the stop
    }
    // waiting riders give up after a long wait (or when their line stopped)
    if (tick % 10 === 3) for (const list of this.waiting.values()) for (const r of [...list]) if (tick - r.since > r.maxWait) this.giveUp(r);
  }
  private serviceOfVehicle(list: Rider[]): ModeService | undefined {
    const l = list.length ? this.lines.get(list[0].line) : undefined;
    return l ? this.services.get(l.mode) : this.services.get('bus');
  }

  // ---- riders -------------------------------------------------------------------------------

  /** A ride leg starts: the rider stands at the stop, in the small crowd on the kerb side. */
  startRide(c: Citizen, leg: Leg) {
    const ride = leg.ride!;
    this.drop(c);
    const line = this.lines.get(ride.line);
    const tick = this.w.tick;
    const svc = line && this.services.get(line.mode);
    const exp = line && svc ? svc.waitAt(line, ride.from) : null;
    const r: Rider = {
      c, leg, line: ride.line, from: ride.from, to: ride.to, stop: { x: ride.board[0], y: ride.board[1] }, off: { x: ride.off[0], y: ride.off[1] },
      phase: 'wait', since: tick, maxWait: Math.max(TRANSIT.waitMin, TRANSIT.waitMul * (exp ?? 0)), vehicle: 0, boardAt: 0,
    };
    if (!line || exp === null) r.maxWait = 0; // nothing will come: give up at the next check
    this.riders.set(c.id, r);
    const k = tkey(r.stop.x, r.stop.y);
    let l = this.waiting.get(k);
    if (!l) this.waiting.set(k, l = []);
    l.push(r);
    const spot = svc?.waitSpot?.(r.stop, c.id);
    if (spot) { c.x = spot[0]; c.y = spot[1]; } else this.standAt(c, r.stop.x, r.stop.y);
    c.pts = null; c.wait = 0;
    noteTrail(c, r.stop.x, r.stop.y);
  }
  /** Put a citizen in the little crowd on a stop tile: towards the road, spread along the kerb. */
  standAt(c: Citizen, x: number, y: number) {
    const d = boardDir(this.w, x, y);
    const [dx, dy] = d >= 0 ? DIRS[d] : [0, 1];
    const along = (hash2(c.id, 61) - 0.5) * 0.62, back = 0.12 + 0.12 * hash2(c.id, 62);
    c.x = x + 0.5 + dx * back - dy * along;
    c.y = y + 0.5 + dy * back + dx * along;
  }
  /** Where a ride leg stands: true once it is over (got off at the stop, or gave up and the legs now walk on). */
  rideDone(c: Citizen): boolean {
    return !this.riders.has(c.id);
  }
  riderOf(c: Citizen): { phase: 'wait' | 'ride'; line: TransitLine | undefined; off: StopRef; stop: StopRef; since: number } | null {
    const r = this.riders.get(c.id);
    return r ? { phase: r.phase, line: this.lines.get(r.line), off: r.off, stop: r.stop, since: r.since } : null;
  }
  /** Forget a citizen (removed, sent home, re-planned): off the stop and out of any vehicle. */
  drop(c: Citizen) {
    const r = this.riders.get(c.id);
    if (!r) return;
    this.riders.delete(c.id);
    const k = tkey(r.stop.x, r.stop.y);
    removeFrom(this.waiting, k, r);
    if (r.vehicle) removeFrom(this.onboard, r.vehicle, r);
  }
  /** A waiting rider gives up: walk from the stop to wherever the trip was going. */
  private giveUp(r: Rider) {
    this.drop(r.c);
    this.stats.gaveUp++;
    this.walkOnFrom(r.c, r.stop.x, r.stop.y);
  }
  /** Replace the rest of a trip with a walk from (x, y) to its final destination (the end of the last leg). */
  private walkOnFrom(c: Citizen, x: number, y: number) {
    const last = c.legs.length ? c.legs[c.legs.length - 1] : c.leg;
    const p = last?.path;
    const gx = p && p.length >= 2 ? p[p.length - 2] : c.hx, gy = p && p.length >= 2 ? p[p.length - 1] : c.hy;
    const wp = pathBetween(this.w, x, y, gx, gy) ?? [x, y, gx, gy];
    c.x = x + 0.5; c.y = y + 0.5;
    c.legs = [{ path: wp, drive: false, arrive: 'none' }];
  }

  /**
   * A vehicle of `lineId` stands at `call` with `room` places free: riders bound here get off (and walk on, or wait
   * for their next line), then riders waiting here for this line in this direction get on, fares paid to the owner.
   * `board` false only lets people off (a vehicle going out of service).
   */
  serveCall(vehicleId: number, lineId: number, call: number, room: number, board = true): { off: number; on: number } {
    const line = this.lines.get(lineId);
    if (!line) return { off: 0, on: 0 };
    const r0 = this.routeOf(lineId);
    const si = r0 ? r0.calls[call] : -1;
    const stop = si >= 0 ? line.stops[si] : null;
    let off = 0, on = 0;
    const list = this.onboard.get(vehicleId);
    if (list) {
      for (const r of [...list]) {
        if (r.to !== call) continue;
        removeFrom(this.onboard, vehicleId, r);
        this.riders.delete(r.c.id);
        this.stats.alighted++;
        off++;
        if (stop) this.standAt(r.c, stop.x, stop.y);
        noteTrail(r.c, r.off.x, r.off.y);
      }
    }
    if (!board || !stop || room <= 0) return { off, on };
    const k = tkey(stop.x, stop.y);
    const w = this.waiting.get(k);
    if (!w) return { off, on };
    const tick = this.w.tick, day = Math.floor(tick / DAY);
    for (const r of [...w]) {
      if (on >= room) break;
      if (r.line !== lineId || r.from !== call) continue;
      removeFrom(this.waiting, k, r);
      r.phase = 'ride'; r.vehicle = vehicleId; r.boardAt = tick + 1 + on;
      let ob = this.onboard.get(vehicleId);
      if (!ob) this.onboard.set(vehicleId, ob = []);
      ob.push(r);
      on++;
      this.stats.boarded++;
      const fare = this.fareFor(r.c);
      if (fare > 0) { r.c.money -= fare; noteSpend(r.c, fare, tick); this.w.credit(line.owner, fare, 'fees'); }
      bumpCount(this.lineCount, lineId, day, fare);
      bumpCount(this.stopCount, k, day, 0);
    }
    return { off, on };
  }
  load(vehicleId: number) { return this.onboard.get(vehicleId)?.length ?? 0; }
  /** Who is on board a vehicle (and still stepping aboard), with the stop each gets off at: the selected train's roster. */
  aboard(vehicleId: number): { c: Citizen; off: StopRef }[] { return (this.onboard.get(vehicleId) ?? []).map((r) => ({ c: r.c, off: r.off })); }
  /** Is there anyone to set down at `call`, or (when boarding) anyone waiting there for this line in that direction? */
  wantsCall(vehicleId: number, lineId: number, call: number, board: boolean): boolean {
    for (const r of this.onboard.get(vehicleId) ?? []) if (r.to === call) return true;
    if (!board) return false;
    const line = this.lines.get(lineId), route = this.routeOf(lineId);
    const s = line && route ? line.stops[route.calls[call]] : undefined;
    if (!s) return false;
    for (const r of this.waiting.get(tkey(s.x, s.y)) ?? []) if (r.line === lineId && r.from === call) return true;
    return false;
  }
  /** A vehicle leaves service with people on board, at road tile (x, y) or nowhere (null): they walk on from there. */
  evacuate(vehicleId: number, at: [number, number] | null) {
    const list = this.onboard.get(vehicleId);
    if (!list) return;
    this.onboard.delete(vehicleId);
    for (const r of list) {
      this.riders.delete(r.c.id);
      this.stats.evacuated++;
      const x = at ? at[0] : r.off.x, y = at ? at[1] : r.off.y;
      this.walkOnFrom(r.c, x, y);
    }
  }

  // ---- the planner ------------------------------------------------------------------------------

  /**
   * The best trip by transit from (fx, fy) to (tx, ty) right now, or null: a stop within the catchment of each end on
   * the same line, or one change onto a second line at the stop you get off at or one a short walk away
   * (TRANSIT.transferWalk). Priced in perceived ticks: the walks (walkCost) and the waits (waitWeight) weighted, the
   * rides as they are; the number of fares is returned separately (riders' fares differ by age).
   */
  bestTransit(fx: number, fy: number, tx: number, ty: number): TransitPlan | null {
    if (!this.linesAt.size) return null;
    const from = this.stopsNear(fx, fy, TRANSIT.catchment);
    if (!from.length) return null;
    const to = this.stopsNear(tx, ty, TRANSIT.catchment);
    if (!to.length) return null;
    const walkT = (d: number) => (d * 1.2) / WALK_SPEED;
    // the calls near the destination, by line: get off there and walk d tiles
    const destCalls = new Map<number, { call: number; s: StopRef; d: number }[]>();
    for (const t of to) for (const { line, calls } of this.linesAt.get(tkey(t.s.x, t.s.y)) ?? []) {
      let l = destCalls.get(line.id);
      if (!l) destCalls.set(line.id, l = []);
      for (const call of calls) l.push({ call, s: t.s, d: t.d });
    }
    if (!destCalls.size) return null;
    let best: TransitPlan | null = null;
    const waits = new Map<string, number | null>();
    const waitOf = (l: TransitLine, call: number, later: boolean) => {
      const key = `${l.id}:${call}:${later ? 1 : 0}`;
      if (!waits.has(key)) {
        const svc = this.services.get(l.mode);
        // a change happens later: expect half a headway then, not the bus that is due now
        const v = !svc ? null : later ? (svc.headway?.(l) ?? svc.waitAt(l, call)) : svc.waitAt(l, call);
        waits.set(key, later && v !== null && svc?.headway ? v / 2 : v);
      }
      return waits.get(key)!;
    };
    for (const o of from) {
      const atO = this.linesAt.get(tkey(o.s.x, o.s.y));
      if (!atO) continue;
      const wIn = walkCost(walkT(o.d));
      for (const { line: la, calls: ca } of atO) {
        const ra = this.routeOf(la.id)!, svcA = this.services.get(la.mode)!;
        const K = ra.calls.length;
        const direct = destCalls.get(la.id);
        for (const a of ca) {
          const wa = waitOf(la, a, false);
          if (wa === null) continue;
          for (let step = 1; step < K; step++) {
            const b = (a + step) % K;
            const sb = la.stops[ra.calls[b]];
            if (sb.x === o.s.x && sb.y === o.s.y) continue;
            const rideA = svcA.rideTicks(la, a, b);
            const sofar = wIn + TRANSIT.waitWeight * wa + rideA;
            if (best && sofar >= best.perceived) continue;
            const first: RidePlan = { line: la, from: a, to: b, board: o.s, off: sb, wait: wa, ride: rideA };
            if (direct) for (const dc of direct) {
              if (dc.call !== b) continue;
              const perceived = sofar + walkCost(walkT(dc.d));
              if (!best || perceived < best.perceived) best = { rides: [first], walkIn: o.d, walkOut: dc.d, ticks: walkT(o.d) + wa + rideA + walkT(dc.d), perceived, fare: 1 };
            }
            // one change: at sb, or at a stop a short walk from it
            for (const tr of this.stopsNear(sb.x, sb.y, TRANSIT.transferWalk)) {
              const walkX = tr.d ? walkCost(walkT(tr.d)) : 0;
              for (const { line: lb, calls: cb } of this.linesAt.get(tkey(tr.s.x, tr.s.y)) ?? []) {
                if (lb.id === la.id) continue;
                const dests = destCalls.get(lb.id);
                if (!dests) continue;
                const svcB = this.services.get(lb.mode)!;
                for (const c0 of cb) {
                  const wb = waitOf(lb, c0, true);
                  if (wb === null) continue;
                  for (const dc of dests) {
                    if (dc.call === c0) continue;
                    const rideB = svcB.rideTicks(lb, c0, dc.call);
                    const perceived = sofar + walkX + TRANSIT.waitWeight * wb + rideB + walkCost(walkT(dc.d)) + TRANSIT.transferPenalty;
                    if (best && perceived >= best.perceived) continue;
                    best = {
                      rides: [first, { line: lb, from: c0, to: dc.call, board: tr.s, off: dc.s, wait: wb, ride: rideB }],
                      walkIn: o.d, walkOut: dc.d, ticks: walkT(o.d) + wa + rideA + walkT(tr.d) + wb + rideB + walkT(dc.d), perceived, fare: 2,
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
    return best;
  }
  /** Every routed stop tile (tkey) and how many lines call there (sim/value.ts: access). */
  eachStop(fn: (k: number, lines: number) => void) { for (const [k, v] of this.linesAt) fn(k, v.length); }
  /** Routed stops within Manhattan distance r of (x, y), nearest first, with the lines calling there (a station's "change here for"). */
  stopsAround(x: number, y: number, r: number): { s: StopRef; d: number; lines: TransitLine[] }[] {
    return this.stopsNear(x, y, r).sort((a, b) => a.d - b.d || a.s.x - b.s.x || a.s.y - b.s.y)
      .map(({ s, d }) => ({ s, d, lines: (this.linesAt.get(tkey(s.x, s.y)) ?? []).map((e) => e.line) }));
  }
  /** Routed stops within Manhattan distance r of (x, y), with their distance. */
  private stopsNear(x: number, y: number, r: number): { s: StopRef; d: number }[] {
    const out: { s: StopRef; d: number }[] = [];
    for (let cy = Math.floor((y - r) / 8); cy <= Math.floor((y + r) / 8); cy++) for (let cx = Math.floor((x - r) / 8); cx <= Math.floor((x + r) / 8); cx++) {
      const g = this.stopGrid.get(cellKeyC(cx, cy));
      if (g) for (const s of g) { const d = Math.abs(s.x - x) + Math.abs(s.y - y); if (d <= r) out.push({ s, d }); }
    }
    return out;
  }
  /** What one ride costs this citizen: children ride free, retirees pay half (TRANSIT.fare). */
  fareFor(c: Citizen): number {
    return c.stage === LifeStage.Child ? 0 : c.stage === LifeStage.Retired ? TRANSIT.fare / 2 : TRANSIT.fare;
  }

  /**
   * The legs of a planned transit trip from (hx, hy) to (dx, dy): walk to the first stop, one ride leg per line (with
   * a walk between stops when the change is at another stop), walk from the last stop. Null when a walk cannot be
   * found (the caller then walks or drives instead).
   */
  legsFor(plan: TransitPlan, hx: number, hy: number, dx: number, dy: number): Leg[] | null {
    const legs: Leg[] = [];
    const first = plan.rides[0], last = plan.rides[plan.rides.length - 1];
    const wIn = pathBetween(this.w, hx, hy, first.board.x, first.board.y);
    if (!wIn) return null;
    if (wIn.length > 2) legs.push({ path: wIn, drive: false, arrive: 'none' });
    let prev: RidePlan | null = null;
    for (const r of plan.rides) {
      if (prev && (prev.off.x !== r.board.x || prev.off.y !== r.board.y)) {
        const wx = pathBetween(this.w, prev.off.x, prev.off.y, r.board.x, r.board.y);
        if (!wx) return null;
        legs.push({ path: wx, drive: false, arrive: 'none' });
      }
      legs.push({ path: this.ridePath(r), drive: false, arrive: 'none', ride: { line: r.line.id, from: r.from, to: r.to, board: [r.board.x, r.board.y], off: [r.off.x, r.off.y] }, dest: [dx, dy] });
      prev = r;
    }
    const wOut = pathBetween(this.w, last.off.x, last.off.y, dx, dy);
    if (!wOut) return null;
    legs.push({ path: wOut, drive: false, arrive: 'none' });
    if (plan.rides.length > 1) this.stats.transfers++;
    this.stats.planned++;
    return legs;
  }
  /** The tiles a ride passes over (for the route ribbon): stop, the lap from call to call, stop. */
  private ridePath(r: RidePlan): number[] {
    const route = this.routeOf(r.line.id);
    const out = [r.board.x, r.board.y];
    if (!route) { out.push(r.off.x, r.off.y); return out; }
    const L = route.path.length / 2;
    let i = route.callNodes[r.from];
    const end = route.callNodes[r.to];
    for (let n = 0; n <= L; n++) {
      out.push(route.path[i * 2], route.path[i * 2 + 1]);
      if (i === end && n > 0) break;
      i = (i + 1) % L;
    }
    out.push(r.off.x, r.off.y);
    return out;
  }

  // ---- inspection ---------------------------------------------------------------------------------

  lineInfos(names: (id: string) => string): LineInfo[] {
    const day = Math.floor(this.w.tick / DAY);
    const out: LineInfo[] = [];
    for (const l of this.lines.values()) {
      const r = this.routeOf(l.id), svc = this.services.get(l.mode);
      const c = readCount(this.lineCount.get(l.id), day);
      out.push({
        ...l, stops: l.stops.map((s) => ({ ...s })), ownerName: names(l.owner),
        status: this.routeProblem(l.id) || svc?.problem(l) || 'running',
        path: r ? r.path : [], calls: r ? r.calls : [], callNodes: r ? r.callNodes : [],
        inService: svc ? svc.inService(l) : 0, ridersToday: c.today, ridersYesterday: c.yesterday, faresToday: c.fares,
        stopBoardings: l.stops.map((s) => readCount(this.stopCount.get(tkey(s.x, s.y)), day).today),
      });
    }
    return out;
  }
  describeStop(x: number, y: number): StopInfo {
    const day = Math.floor(this.w.tick / DAY), k = tkey(x, y);
    const waitList = this.waiting.get(k) ?? [];
    const c = readCount(this.stopCount.get(k), day);
    const info: StopInfo = { name: this.w.stopLabel(x, y), waiting: waitList.length, lines: [], boardingsToday: c.today, boardingsYesterday: c.yesterday };
    const d = boardDir(this.w, x, y);
    if (d >= 0) info.board = [x + DIRS[d][0], y + DIRS[d][1]];
    const mode = stopModeOf(this.w.kindIdAt(x, y));
    const p = mode ? this.services.get(mode)?.stopProblem(x, y) : null;
    if (p) info.problem = p;
    for (const l of this.lines.values()) {
      if (!l.stops.some((s) => s.x === x && s.y === y)) continue;
      const r = this.routeOf(l.id), svc = this.services.get(l.mode);
      let next: number | undefined;
      if (r && svc) for (let call = 0; call < r.calls.length; call++) {
        const s = l.stops[r.calls[call]];
        if (s.x !== x || s.y !== y) continue;
        const wt = svc.waitAt(l, call);
        if (wt !== null && (next === undefined || wt < next)) next = wt;
      }
      info.lines.push({
        id: l.id, number: l.number, colour: l.colour, waiting: waitList.filter((q) => q.line === l.id).length,
        nextArrival: next === undefined ? undefined : this.w.tick + Math.round(next), inService: svc ? svc.inService(l) : 0,
      });
    }
    info.lines.sort((a, b) => a.number - b.number);
    return info;
  }
  /** For the citizen panel: 'waiting for the 3', 'riding the 3 to Okafor Road'. */
  activity(c: Citizen): string | null {
    const r = this.riders.get(c.id);
    if (!r) return null;
    const l = this.lines.get(r.line);
    const name = l ? (l.name ? `the ${l.name} line` : `the ${l.number}`) : 'a bus';
    const at = (s: StopRef) => this.w.stopLabel(s.x, s.y);
    if (r.phase === 'wait') return `waiting for ${name} at ${at(r.stop)}`;
    return this.w.tick < r.boardAt ? `boarding ${name} for ${at(r.off)}` : `riding ${name} to ${at(r.off)}`;
  }
  /**
   * The vehicle a rider sits in (on board, not still stepping aboard), its line and mode, and how many are on it: the selected
   * citizen's `CitizenInfo.aboard`, so the first-person view can sit them in it (client render/fpv.ts). Null otherwise.
   */
  aboardOf(c: Citizen): { mode: TransitMode; vehicle: number; line: number; load: number } | null {
    const r = this.riders.get(c.id);
    if (!r || r.phase !== 'ride' || this.w.tick < r.boardAt) return null;
    const l = this.lines.get(r.line);
    return l ? { mode: l.mode, vehicle: r.vehicle, line: r.line, load: this.load(r.vehicle) } : null;
  }
  /** On board (and not still stepping aboard at the stop). */
  isRiding(c: Citizen) { const r = this.riders.get(c.id); return !!r && r.phase === 'ride' && this.w.tick >= r.boardAt; }
  isWaiting(c: Citizen) { return this.riders.get(c.id)?.phase === 'wait'; }
  /** Waiting or riding below ground (a mode with `under`: the metro), so the surface does not draw them (CITIZEN_UNDER). */
  isUnder(c: Citizen) { const r = this.riders.get(c.id), l = r && this.lines.get(r.line); return !!l && !!this.services.get(l.mode)?.under; }
  waitingCount() { let n = 0; for (const l of this.waiting.values()) n += l.length; return n; }
  ridingCount() { let n = 0; for (const l of this.onboard.values()) n += l.length; return n; }
}

// ======================================================================================================
// Buses
// ======================================================================================================

interface Bus {
  v: Vehicle; line: number; depot: [number, number];
  phase: 'toLine' | 'service' | 'retiring' | 'toDepot';
  /** the call being driven to (or stood at) */
  call: number;
  /** path node index where the current lap starts (lap node 0 = call 0's road tile) */
  base: number;
  atCall: boolean; arrivedAt: number; dwellUntil: number;
  /** when it left the last call and when it was expected at this one (delay) */
  leftAt: number; expectAt: number; delay: number;
  /** the lap it drives (a line change swaps it at the next call) */
  route: LineRoute;
}
/** Where the bus's centre stops in the lane leaving the stop's road tile: just past the tile centre. */
export const HALT_PROG = 0.04;

/**
 * Buses: each line runs out of its owner's nearest bus depot, one bus per driver on shift up to the number the owner
 * asked for, from 05:30 to 00:30. A bus is an ordinary Vehicle (VehicleKind.Bus, VehicleClass.Bus) driven by the
 * traffic model; its path is the line's lap, extended a lap ahead as it goes. At each call it pulls in on the stop's
 * road tile (Mover.halt), dwells while people get off and on, holds a little when it has caught up with the bus
 * ahead, and drives on.
 */
export class BusService implements ModeService {
  /** a sandbox: a line may use any owner's depot when its own has none; set by game.ts */
  sandbox = false;
  readonly mode = 'bus' as const;
  private buses = new Map<number, Bus>();
  private nextId = (1 << 30) + (1 << 29);
  /** per line: expected ticks of each segment (call k to k+1), learnt from the buses as they run */
  private seg = new Map<number, number[]>();
  /** drivers on shift per depot tile key, refreshed every DRIVERS_EVERY ticks */
  private drivers = new Map<number, number>();
  private lastSpawn = new Map<number, number>();
  private short = new Map<number, number>();
  /** counters since start */
  stats = { spawned: 0, withdrawn: 0, returned: 0, calls: 0, skipped: 0, held: 0 };

  constructor(private w: World, private traffic: Traffic, private transit: Transit) {}

  // ---- the line's lap --------------------------------------------------------------------

  stopProblem(x: number, y: number): string | null {
    const d = boardDir(this.w, x, y);
    if (d < 0) return `${stopName(x, y)} has no road beside it`;
    const bx = x + DIRS[d][0], by = y + DIRS[d][1];
    if (this.traffic.degreeOf(bx, by) >= 3) return `${stopName(x, y)} faces a junction: buses can only stop on a plain stretch of road`;
    return null;
  }
  /** The road tile a bus stands on to serve a stop. */
  private boardTile(s: StopRef): [number, number] | null {
    const d = boardDir(this.w, s.x, s.y);
    return d < 0 ? null : [s.x + DIRS[d][0], s.y + DIRS[d][1]];
  }
  /** Stop index per call: a loop calls S0 … Sn-1, there and back S0 … Sn-1 … S1. */
  private callsOf(line: TransitLine): number[] {
    const n = line.stops.length, calls: number[] = [];
    for (let i = 0; i < n; i++) calls.push(i);
    if (!line.loop) for (let i = n - 2; i >= 1; i--) calls.push(i);
    return calls;
  }
  /** Route cost of a road tile for a line's lap: fixed (junctions and level crossings dearer), never today's traffic, so a line routes the same way every time. */
  private lineCost = (x: number, y: number) => 1 + (this.traffic.degreeOf(x, y) >= 3 ? 0.6 : 0) + (this.traffic.isCrossingAt(x, y) ? 1.5 : 0);
  /** The road network for the bus router: fixed costs for laps, live congestion for a bus finding its way (`live`). */
  private busNet(depot: [number, number] | null, live = false): BusNet {
    return {
      w: this.w, depot,
      cost: live ? (x, y) => this.traffic.cost(x, y) : this.lineCost,
      degree: (x, y) => this.traffic.degreeOf(x, y),
      crossing: (x, y) => this.traffic.isCrossingAt(x, y),
    };
  }
  route(line: TransitLine): LineRoute | string {
    const p = this.plan(line, false);
    if (!p.ok) return p.problem ? problemText(p.problem) : 'No route';
    return { calls: p.calls, path: p.path, callNodes: p.callNodes };
  }
  /**
   * Route a line (docs/transit.md "The lap"): its stops checked, the lap planned through the road tile of every call
   * (sim/busroute.ts: round a block, a roundabout, a three-point turn at a dead end or in a junction mouth, or via
   * the depot where the bus has to turn round), and what is wrong said with a fix. `full`: also time it and check
   * the depot can reach it (the editor's preview); route() leaves that to problem().
   */
  plan(line: TransitLine, full = true): Omit<LinePreview, 'seq'> {
    const calls = this.callsOf(line), K = calls.length;
    const out: Omit<LinePreview, 'seq'> = { ok: false, path: [], calls, callNodes: [], turns: [], length: 0, lapTicks: 0 };
    const name = (i: number) => `${stopName(line.stops[i].x, line.stops[i].y)} (stop ${i + 1})`;
    for (let i = 0; i < line.stops.length; i++) {
      const s = line.stops[i], p = this.stopProblem(s.x, s.y);
      if (!p) continue;
      const spot = this.stopSpot(s, line.owner);
      const d = boardDir(this.w, s.x, s.y);
      out.problem = {
        message: d < 0 ? `${name(i)} has no road beside it` : `${name(i)} faces a junction: a bus can only pull in on a plain stretch of road`,
        fix: spot ? `Move the stop to (${spot[0]}, ${spot[1]}), beside a plain stretch of road` : d < 0 ? 'Move the stop beside a road, or lay a road past it' : 'Move the stop a tile or two along the street, away from the junction',
        stop: i, tiles: d < 0 ? [s.x, s.y] : [s.x, s.y, s.x + DIRS[d][0], s.y + DIRS[d][1]], suggest: spot ?? undefined, fatal: true,
      };
      return out;
    }
    if (K < 2) { out.problem = { message: 'A line needs at least two stops', tiles: [], fatal: true }; return out; }
    const tiles = calls.map((si) => this.boardTile(line.stops[si])!);
    const depot = this.depotFor(line);
    const dk: [number, number] | null = depot ? [depot.x, depot.y] : null;
    const lap = planLap(this.busNet(dk), tiles);
    out.path = lap.path; out.callNodes = lap.callNodes;
    for (const t of lap.turns) out.turns.push(lap.path[t.node * 2], lap.path[t.node * 2 + 1], t.kind === 'dead end' ? 0 : t.kind === 'junction' ? 1 : 2);
    if (lap.fail) { out.problem = this.lapProblem(line, calls, lap.fail); return out; }
    out.ok = true;
    out.length = lap.path.length / 2;
    if (!full) return out;
    const r: LineRoute = { calls, path: lap.path, callNodes: lap.callNodes };
    out.lapTicks = Math.round(calls.reduce((t, _, k) => t + this.segEstimate(r, k) + this.dwellGuess(), 0));
    // the buses start and end their day at the depot: it must reach the lap by road
    if (depot && !this.depotReaches(r, dk!)) {
      const s0 = line.stops[0], b0 = tiles[0], dr = this.depotRoad(dk!), gap = dr ? joinGap(this.w, dr, b0) : null;
      if (!dr) {
        out.problem = { message: `Your bus depot at (${dk![0]}, ${dk![1]}) has no road at its door`, fix: 'Lay a road past the depot door', leg: [dk![0], dk![1], s0.x, s0.y], tiles: [dk![0], dk![1]], fatal: false };
        return out;
      }
      out.problem = {
        message: `No road from your bus depot to ${name(0)}`,
        fix: gap?.length ? `Connect the depot's street: lay road over the ${gap.length / 2} tile${gap.length > 2 ? 's' : ''} marked, from (${gap[0]}, ${gap[1]})` : `Connect the depot's street to the line's roads`,
        stop: 0, leg: [dk![0], dk![1], s0.x, s0.y], tiles: gap ?? [], fatal: false,
      };
    }
    return out;
  }
  /** Say why segment `f.seg` of a lap cannot be driven, and how to fix it. */
  private lapProblem(line: TransitLine, calls: number[], f: LapFail): LineProblem {
    const K = calls.length, i = calls[f.seg], j = calls[(f.seg + 1) % K];
    const a = line.stops[i], b = line.stops[j];
    const A = `${stopName(a.x, a.y)} (stop ${i + 1})`, B = `${stopName(b.x, b.y)} (stop ${j + 1})`;
    const base = { from: i, to: j, leg: [a.x, a.y, b.x, b.y], tiles: [] as number[], fatal: true };
    if (f.reason === 'same tile') return { ...base, message: `${A} and ${B} are served from the same road tile`, fix: 'Take one of them off the line, or move it along the street', tiles: [a.x, a.y, b.x, b.y] };
    if (f.reason === 'too far') return { ...base, message: `${A} to ${B} is too far by road for a bus to plan`, fix: 'Add a stop between them' };
    if (f.reason === 'no turn') return { ...base, message: `A bus from ${A} cannot get round to ${B}: there is nowhere on the way to turn round`, fix: 'Join the road into a loop, or give it a junction or a dead end to turn in' };
    const gap = f.gap ?? [];
    const n = gap.length / 2;
    return {
      ...base, tiles: gap, message: `No road joins ${A} to ${B}`,
      fix: n > 1 ? `Connect the roads: lay road over the ${n} tiles marked, (${gap[0]}, ${gap[1]}) to (${gap[gap.length - 2]}, ${gap[gap.length - 1]})`
        : n ? `Connect the roads: lay road on (${gap[0]}, ${gap[1]})` : 'Their streets are not joined: connect them with a road',
    };
  }
  /** The nearest free tile (within 4) to a stop where it could go instead: on the owner's land, empty, beside a plain stretch of road. */
  private stopSpot(s: StopRef, owner: string): [number, number] | null {
    let best: [number, number] | null = null, bd = Infinity;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = s.x + dx, y = s.y + dy, dist = Math.abs(dx) + Math.abs(dy);
      if (!dist || dist >= bd) continue;
      const t = this.w.peekTile(x, y);
      if (t === undefined || isRoad(t) || zoneOf(t) !== 0 || terrainOf(t) === Terrain.Water || this.w.auxAt(x, y)) continue;
      if (!this.sandbox && this.w.parcelAt(x, y)?.owner !== owner) continue;
      if (this.stopProblem(x, y)) continue;
      best = [x, y]; bd = dist;
    }
    return best;
  }
  /** A road tile beside the depot door (where its buses come out). */
  private depotRoad(d: [number, number]): [number, number] | null {
    for (const [dx, dy] of DIRS) { const t = this.w.peekTile(d[0] + dx, d[1] + dy); if (t !== undefined && isRoad(t)) return [d[0] + dx, d[1] + dy]; }
    return null;
  }
  /** Can a bus get from the depot door onto the lap (at the call nearest the door, as spawn() joins it)? */
  private depotReaches(r: LineRoute, d: [number, number]): boolean {
    let k0 = 0, bd = Infinity;
    r.calls.forEach((_, k) => { const n = r.callNodes[k]; const dist = Math.abs(r.path[n * 2] - d[0]) + Math.abs(r.path[n * 2 + 1] - d[1]); if (dist < bd) { bd = dist; k0 = k; } });
    const n = r.callNodes[k0], L = r.path.length / 2, pn = (n + L - 1) % L;
    const arrive = dirBetween(r.path[pn * 2], r.path[pn * 2 + 1], r.path[n * 2], r.path[n * 2 + 1]);
    return !!busLegs(this.busNet(d), d[0], d[1], -1, r.path[n * 2], r.path[n * 2 + 1], { want: arrive }).legs[arrive];
  }
  /** Still drivable: every node a road (or the depot it turns in), every turn round still at a dead end or a junction. */
  lapValid(r: LineRoute): boolean {
    const p = r.path, n = p.length / 2, net = this.busNet(null);
    for (let i = 0; i < n; i++) {
      const x = p[i * 2], y = p[i * 2 + 1], t = this.w.peekTile(x, y);
      if (t === undefined) return false;
      if (!isRoad(t)) { if (this.w.kindIdAt(x, y) !== BUS_DEPOT_KIND) return false; continue; }
      if (isReversal(p, i) && !turnAt(net, x, y)) return false;
    }
    // a turn ban or no entry put up since (R4, World.ruleTiles): round the lap, each ruled junction's way in and out
    const RT = this.w.ruleTiles;
    if (RT.size) for (let i = 0; i < n; i++) {
      const at = (j: number) => { const k = ((j % n) + n) % n; return tkey(p[k * 2], p[k * 2 + 1]); };
      const rk = RT.get(at(i));
      if (rk === undefined || RT.get(at(i - 1)) === rk) continue;
      let j = i;
      while (j - i < n && RT.get(at(j + 1)) === rk) j++;
      const xy = (j: number) => { const k = ((j % n) + n) % n; return [p[k * 2], p[k * 2 + 1]]; };
      const [ax, ay] = xy(i - 1), [bx, by] = xy(i), [cx, cy] = xy(j), [dx, dy] = xy(j + 1);
      if (!turnAllowed(this.w.roadRules.get(rk), dirBetween(ax, ay, bx, by), dirBetween(cx, cy, dx, dy))) return false;
    }
    return true;
  }

  // ---- timing ------------------------------------------------------------------------------------

  /**
   * First estimate of a segment's running time, before any bus has driven it: the route cost of its tiles (1 per tile,
   * more where congested, junctions dearer: Traffic.cost) at a bus's cruising speed, plus TURN_TICKS for each turn round.
   * No margin: on the free-flowing streets of loadtest/busroutes.ts it comes within 0-14% of the laps buses drive (a
   * dwell guess per call added). Lights and jams make real laps longer; the buses' own times replace it as they run (arrive()).
   */
  private segEstimate(r: LineRoute, k: number): number {
    const L = r.path.length / 2, K = r.calls.length;
    const a = r.callNodes[k], b = k + 1 < K ? r.callNodes[k + 1] : L;
    let cost = 0, turns = 0;
    for (let i = a + 1; i <= b; i++) { const n = i % L; cost += this.traffic.cost(r.path[n * 2], r.path[n * 2 + 1]); if (isReversal(r.path, n)) turns++; }
    return cost / (DRIVE_SPEED * 0.8) + turns * TURN_TICKS;
  }
  private segs(line: TransitLine, r: LineRoute): number[] {
    let s = this.seg.get(line.id);
    if (!s || s.length !== r.calls.length) { s = r.calls.map((_, k) => this.segEstimate(r, k)); this.seg.set(line.id, s); }
    return s;
  }
  private dwellGuess() { return TRANSIT.dwellBase + 2; }
  rideTicks(line: TransitLine, a: number, b: number): number {
    const r = this.transit.routeOf(line.id);
    if (!r) return Infinity;
    const s = this.segs(line, r), K = r.calls.length;
    let t = 0, k = a;
    do { t += s[k] + (k !== a ? this.dwellGuess() : 0); k = (k + 1) % K; } while (k !== b);
    return t;
  }
  /** Ticks until bus `b` calls at `call` (0 when it is standing there now). */
  private eta(b: Bus, line: TransitLine, call: number): number {
    const r = b.route, s = this.segs(line, r), K = r.calls.length, tick = this.w.tick;
    if (b.atCall && b.call === call) return 0;
    let t = b.atCall ? Math.max(0, b.dwellUntil - tick) + s[b.call] : Math.max(1, b.expectAt - tick);
    let k = b.atCall ? (b.call + 1) % K : b.call;
    if (b.phase === 'toLine') t += 10;
    for (let n = 0; n < K && k !== call; n++) { t += this.dwellGuess() + s[k]; k = (k + 1) % K; }
    return t;
  }
  waitAt(line: TransitLine, call: number): number | null {
    let best: number | null = null;
    for (const b of this.buses.values()) {
      if (b.line !== line.id || (b.phase !== 'service' && b.phase !== 'toLine')) continue;
      const t = this.eta(b, line, call);
      if (best === null || t < best) best = t;
    }
    return best;
  }
  headway(line: TransitLine): number | null {
    const n = this.inService(line), r = this.transit.routeOf(line.id);
    if (!n || !r) return null;
    return this.segs(line, r).reduce((t, x) => t + x + this.dwellGuess(), 0) / n;
  }
  inService(line: TransitLine): number {
    let n = 0;
    for (const b of this.buses.values()) if (b.line === line.id && (b.phase === 'service' || b.phase === 'toLine')) n++;
    return n;
  }
  problem(line: TransitLine): string | null {
    if (!line.vehicles) return 'no buses assigned';
    const depot = this.depotFor(line);
    if (!depot) return 'no bus depot';
    if (!this.depotOk(line, [depot.x, depot.y])) return 'no road from the bus depot to the line';
    if (!inServiceHours(this.hour())) return 'outside service hours (05:30–00:30)';
    if (!this.inService(line) && !(this.drivers.get(tkey(depot.x, depot.y)) ?? 0)) return 'no drivers on shift at the depot';
    return null;
  }
  private hour() { return (this.w.tick % DAY) / TPH; }
  /** per line: can its depot reach the lap (a search, so remembered for a while, and redone when the lap or depot changes) */
  private depotReach = new Map<number, { depot: number; route: LineRoute; at: number; ok: boolean }>();
  private depotOk(line: TransitLine, d: [number, number]): boolean {
    const r = this.transit.routeOf(line.id);
    if (!r) return true;
    const c = this.depotReach.get(line.id), k = tkey(d[0], d[1]);
    if (c && c.depot === k && c.route === r && this.w.tick - c.at < 500) return c.ok;
    const ok = this.depotReaches(r, d);
    this.depotReach.set(line.id, { depot: k, route: r, at: this.w.tick, ok });
    return ok;
  }

  // ---- depots and drivers ----------------------------------------------------------------------

  /** The owner's built bus depot nearest the line's first stop (in a sandbox, any depot when the owner has none). */
  private depotFor(line: TransitLine): { x: number; y: number } | null {
    const s = line.stops[0];
    const nearest = (anyOwner: boolean) => {
      let best: { x: number; y: number } | null = null, bd = Infinity;
      for (const b of this.w.builtOf(15)) {
        if (b.id !== BUS_DEPOT_KIND || b.level < 1) continue;
        if (!anyOwner && this.w.parcelAt(b.x, b.y)?.owner !== line.owner) continue;
        const d = Math.abs(b.x - s.x) + Math.abs(b.y - s.y);
        if (d < bd) { bd = d; best = b; }
      }
      return best;
    };
    return nearest(false) ?? (this.sandbox ? nearest(true) : null);
  }
  /** Depot staff on shift now, or on their way in for one, who drive (the rest are mechanics). */
  private countDrivers() {
    this.drivers.clear();
    for (const c of this.w.citizens.values()) {
      // at work, or on the way in for their shift (so a handover at a shift change does not call buses in)
      if (!c.job || c.kind !== BUS_DEPOT_KIND || (c.state !== 2 /* Work */ && c.state !== 1 /* ToWork */) || isMechanic(c.id)) continue;
      const k = tkey(c.wx, c.wy);
      this.drivers.set(k, (this.drivers.get(k) ?? 0) + 1);
    }
  }
  /** Buses out of a depot (on the road for any line, not yet back). */
  private outOf(depot: [number, number]) {
    let n = 0;
    for (const b of this.buses.values()) if (b.depot[0] === depot[0] && b.depot[1] === depot[1]) n++;
    return n;
  }

  // ---- running ----------------------------------------------------------------------------------

  lineChanged(id: number, line: TransitLine | null) {
    this.seg.delete(id);
    const r = line ? this.transit.routeOf(id) : null;
    for (const b of this.buses.values()) {
      if (b.line !== id) continue;
      if (!line || !r) { if (b.phase !== 'toDepot') this.retire(b, true); continue; }
      b.route = r; // takes effect from the next call: the bus re-joins the new lap there
      if (b.call >= r.calls.length) b.call = 0;
      this.rejoin(b, b.call);
    }
  }
  positionOf(id: number): [number, number] | null {
    const b = this.buses.get(id);
    return b ? [b.v.x, b.v.y] : null;
  }
  busOf(id: number) { return this.buses.get(id); }
  get count() { return this.buses.size; }

  tick() {
    const w = this.w, tick = w.tick;
    if (tick % 25 === 5) this.countDrivers();
    if (tick % 10 === 0) this.dispatch();
    for (const b of [...this.buses.values()]) this.step(b);
  }

  /** Send buses out (and call surplus ones in) to match each line's wish, the drivers on shift and the hours. */
  private dispatch() {
    const tick = this.w.tick;
    const open = inServiceHours(this.hour());
    for (const line of this.w.transitLines.values()) {
      if (line.mode !== 'bus') continue;
      const r = this.transit.routeOf(line.id);
      const mine = [...this.buses.values()].filter((b) => b.line === line.id && (b.phase === 'service' || b.phase === 'toLine'));
      const depot = this.depotFor(line);
      if (!open || !r || !depot) { for (const b of mine) this.retire(b, false); continue; }
      const dk: [number, number] = [depot.x, depot.y];
      const free = (this.drivers.get(tkey(depot.x, depot.y)) ?? 0) - this.outOf(dk);
      // fewer drivers than buses out (a shift change): call one in, but only once it has lasted a while
      const short = free < 0 ? (this.short.get(line.id) ?? 0) + 1 : 0;
      this.short.set(line.id, short);
      if (mine.length > line.vehicles || short > 6) { const b = mine[mine.length - 1]; if (b) this.retire(b, false); this.short.set(line.id, 0); continue; }
      // no new departures in the last half hour of service
      if (mine.length < line.vehicles && free > 0 && inServiceHours((this.hour() + 0.5) % 24)) {
        // space departures by about a headway so they do not leave in a bunch
        const lap = this.segs(line, r).reduce((s, x) => s + x + this.dwellGuess(), 0);
        const gap = Math.max(15, Math.min(120, lap / Math.max(1, line.vehicles)));
        if (tick - (this.lastSpawn.get(line.id) ?? -Infinity) >= gap) this.spawn(line, r, dk);
      }
    }
  }

  private spawn(line: TransitLine, r: LineRoute, depot: [number, number]) {
    const id = this.nextId++;
    const v: Vehicle = {
      id, x: depot[0] + 0.5, y: depot[1] + 0.5, path: [], pi: 0, vkind: VehicleKind.Bus, phase: 'out', from: depot, to: depot, until: 0,
      parkedAt: null, parkKerb: false, owner: line.owner, legs: [], leg: null,
      call: false, weave: false, fee: undefined, // as every vehicle (Simulation.spawnVehicle): one shape
      ...this.w.moverDefaults(id),
      halt: undefined, dwell: undefined,
    };
    v.cls = VehicleClass.Bus; v.speedMul = 1; v.gapMul = 1.15; v.halt = -1;
    const b: Bus = { v, line: line.id, depot, phase: 'toLine', call: 0, base: 0, atCall: false, arrivedAt: 0, dwellUntil: 0, leftAt: this.w.tick, expectAt: this.w.tick, delay: 0, route: r };
    // join the lap at the call nearest the depot
    let k0 = 0, bd = Infinity;
    r.calls.forEach((_, k) => { const n = r.callNodes[k]; const d = Math.abs(r.path[n * 2] - depot[0]) + Math.abs(r.path[n * 2 + 1] - depot[1]); if (d < bd) { bd = d; k0 = k; } });
    v.path = [depot[0], depot[1]]; v.pi = 0;
    resetTrail(v, depot[0], depot[1]);
    if (!this.rejoin(b, k0, true)) return;
    v.leg = { path: v.path, drive: true, arrive: 'none' };
    this.w.vehicles.set(id, v);
    this.buses.set(id, b);
    this.lastSpawn.set(line.id, this.w.tick);
    this.stats.spawned++;
  }

  /**
   * Re-plan the bus's path from where it is to call k of its lap and on round the lap: keep the path up to the node
   * it is driving to (it may already be committed to that tile), A* from there to call k's road tile without
   * turning back, then the lap from call k on. `fresh`: the bus is still in the depot (the path is just its door).
   */
  private rejoin(b: Bus, k: number, fresh = false, avoidAhead = false): boolean {
    const v = b.v, r = b.route;
    const L = r.path.length / 2;
    // keep the tile being driven to; once committed into it (or half way there) its exit is decided too, so keep that
    const lock = !fresh && (v.committed || v.prog >= 0.5) ? 2 : 1;
    const keep = fresh ? 1 : Math.min(v.path.length / 2, v.pi + lock);
    const head = v.path.slice(0, keep * 2);
    const sx = head[head.length - 2], sy = head[head.length - 1];
    const back = keep >= 2 ? [head[head.length - 4], head[head.length - 3]] : null;
    const cn = r.callNodes[k], tx = r.path[cn * 2], ty = r.path[cn * 2 + 1];
    // arrive at the call heading the way the lap does, so it carries on round the lap from there (sim/busroute.ts)
    const pn = (cn + L - 1) % L, arrive = dirBetween(r.path[pn * 2], r.path[pn * 2 + 1], tx, ty);
    const sdir = back ? dirBetween(back[0], back[1], sx, sy) : -1;
    // a stuck bus steers clear of the tile after the one it is entering (what holds it up), unless that is the call itself
    const ahead = avoidAhead && v.pi + 1 < v.path.length / 2 ? [v.path[(v.pi + 1) * 2], v.path[(v.pi + 1) * 2 + 1]] : null;
    const blocked = ahead && !(ahead[0] === tx && ahead[1] === ty) ? ahead : null;
    let joint: number[] = [];
    if (sx !== tx || sy !== ty || (sdir >= 0 && sdir !== arrive)) {
      const leg = busLegs(this.busNet(b.depot, true), sx, sy, sdir, tx, ty, { want: arrive, avoid: blocked ? (x, y) => x === blocked[0] && y === blocked[1] : undefined }).legs[arrive];
      if (!leg) { if (!fresh && !blocked) this.withdraw(b); return false; }
      joint = leg.path.slice(2, -2); // between the kept head and the call tile
    }
    const p = [...head, ...joint];
    // lap node cn is the next node pushed; base is where lap node 0 would be (it may be negative: only base + callNodes is read)
    b.base = p.length / 2 - cn;
    for (let i = cn; i < L; i++) p.push(r.path[i * 2], r.path[i * 2 + 1]);
    for (let i = 0; i < L; i++) p.push(r.path[i * 2], r.path[i * 2 + 1]);
    v.path = p;
    if (v.leg) v.leg.path = p;
    b.call = k;
    v.halt = b.base + cn;
    b.atCall = false; v.dwell = false;
    b.leftAt = this.w.tick;
    b.expectAt = this.w.tick + Math.max(1, (v.halt - Math.max(0, v.pi - 1)) / (DRIVE_SPEED * 0.8 * 0.7));
    return true;
  }

  /** Keep a lap of path ahead of the bus and drop what is far behind it. */
  private keepPath(b: Bus) {
    const v = b.v, r = b.route, L = r.path.length / 2;
    while (v.path.length / 2 < b.base + 2 * L) for (let i = 0; i < L; i++) v.path.push(r.path[i * 2], r.path[i * 2 + 1]);
    const halt = v.halt ?? -1;
    const drop = Math.min(v.pi - 2, b.base, halt >= 0 ? halt : Infinity);
    if (drop >= 64) {
      v.path.splice(0, drop * 2);
      v.pi -= drop; b.base -= drop;
      if (halt >= 0) v.halt = halt - drop;
    }
  }

  private step(b: Bus) {
    const v = b.v, tick = this.w.tick;
    const line = this.w.transitLines.get(b.line);
    if (v.lane < 0) {
      // in the depot yard, waiting to pull out
      if (this.traffic.enter(v) === 'blocked') { if (++v.wait > 300) this.withdraw(b); }
      return;
    }
    if (b.atCall) { this.atCall(b, line); if (b.atCall) { this.traffic.step(v); return; } }
    // a request stop: nobody to set down and nobody waiting, so the bus drives on without pulling in (decided as late
    // as possible, while it is in the lane leading to the stop's road tile)
    const h0 = v.halt ?? -1;
    if (h0 >= 0 && b.phase !== 'toDepot' && (v.pi === h0 || v.pi === h0 + 1) && !this.transit.wantsCall(v.id, b.line, b.call, b.phase !== 'retiring')) {
      this.pass(b, line);
      if ((b.phase as Bus['phase']) === 'toDepot' || !this.buses.has(v.id)) return; // headed home (or withdrawn) on the way past
    }
    const r = this.traffic.step(v);
    if (r === 'arrived') {
      // back in the depot
      this.transit.evacuate(v.id, [Math.floor(v.x), Math.floor(v.y)]);
      this.remove(b);
      this.stats.returned++;
      return;
    }
    if (r === 'stuck') {
      // held up past the stuck limit: look once for a way round the tile after the next (as a car's forced re-route
      // does); still held ten ticks later, give up as a stuck car does: the bus leaves service where it is (a long bus
      // left standing in a jam holds up more than a car would: docs/traffic-tuning.md "Buses")
      if (v.stuck > TT.stuckLimit + 10) { this.withdraw(b); return; }
      if (v.stuck === TT.stuckLimit + 1 && !v.committed && v.prog < 0.5 && b.phase !== 'toDepot') this.rejoin(b, b.call, false, true);
    }
    const halt = v.halt ?? -1;
    if (b.phase !== 'toDepot' && halt >= 0 && this.traffic.atHalt(v)) this.arrive(b, line);
    if (b.phase !== 'toDepot') this.keepPath(b);
  }

  /** Learn the running time of the segment just driven (from the last call to this one). */
  private learn(b: Bus, line: TransitLine | undefined) {
    const tick = this.w.tick;
    if (line && b.leftAt < tick && b.phase === 'service') {
      const s = this.segs(line, b.route), K = s.length, k = (b.call + K - 1) % K;
      const took = tick - b.leftAt;
      if (b.expectAt > b.leftAt && took < 6 * s[k] + 50) s[k] += (took - s[k]) * 0.25;
    }
    b.delay = Math.max(0, tick - b.expectAt);
  }
  /** Drive past a call with nobody to serve: on to the next one. */
  private pass(b: Bus, line: TransitLine | undefined) {
    if (b.phase === 'toLine') b.phase = 'service';
    this.learn(b, line);
    this.stats.skipped++;
    if (b.phase === 'retiring' && this.transit.load(b.v.id) === 0) { this.headHome(b); return; }
    this.depart(b, line);
  }
  /** The bus has pulled in at its call: people off, people on, then dwell. */
  private arrive(b: Bus, line: TransitLine | undefined) {
    const v = b.v, tick = this.w.tick;
    b.atCall = true; v.dwell = true; b.arrivedAt = tick;
    if (b.phase === 'toLine') b.phase = 'service';
    this.stats.calls++;
    this.learn(b, line);
    const board = b.phase === 'service';
    const { off, on } = this.transit.serveCall(v.id, b.line, b.call, TRANSIT.busCapacity - this.transit.load(v.id), board);
    b.dwellUntil = tick + Math.max(TRANSIT.dwellBase + Math.ceil((off + on) * TRANSIT.dwellPerRider), on + 2); // everyone aboard before it pulls away
    if (b.phase === 'retiring' && this.transit.load(v.id) === 0) this.headHome(b);
  }
  /** Standing at a call: late-comers get on, then anti-bunching, then away to the next call. */
  private atCall(b: Bus, line: TransitLine | undefined) {
    const v = b.v, tick = this.w.tick;
    if (tick < b.dwellUntil) return;
    if (b.phase === 'service') {
      const { on } = this.transit.serveCall(v.id, b.line, b.call, TRANSIT.busCapacity - this.transit.load(v.id), true);
      if (on) { b.dwellUntil = tick + Math.max(Math.ceil(on * TRANSIT.dwellPerRider), on + 1); return; }
      // anti-bunching: hold a little when too close behind the bus ahead, but never with traffic queued behind
      if (line && tick - b.dwellUntil < TRANSIT.holdMax && !this.traffic.queuedBehind(v) && this.tooClose(b, line)) { this.stats.held++; return; }
    }
    this.depart(b, line);
  }
  /** Away from the call (served or passed) towards the next one. */
  private depart(b: Bus, line: TransitLine | undefined) {
    const v = b.v, tick = this.w.tick;
    const K = b.route.calls.length;
    b.atCall = false; v.dwell = false;
    const next = (b.call + 1) % K;
    if (next === 0) b.base += b.route.path.length / 2;
    b.call = next;
    v.halt = b.base + b.route.callNodes[next];
    b.leftAt = tick;
    b.expectAt = tick + (line ? this.segs(line, b.route)[(next + K - 1) % K] : 30);
    if (b.phase === 'retiring' && this.transit.load(v.id) === 0) this.headHome(b);
    else this.keepPath(b);
  }
  /** Is the bus ahead on the lap closer than bunchShare of an even headway? */
  private tooClose(b: Bus, line: TransitLine): boolean {
    const L = b.route.path.length / 2;
    let n = 0, ahead = Infinity;
    const pos = (x: Bus) => (((x.v.pi - 1 - x.base) % L) + L) % L + x.v.prog;
    const me = pos(b);
    for (const o of this.buses.values()) {
      if (o.line !== b.line || o.phase !== 'service') continue;
      n++;
      if (o === b) continue;
      const d = (((pos(o) - me) % L) + L) % L;
      if (d < ahead) ahead = d;
    }
    return n > 1 && ahead < (TRANSIT.bunchShare * L) / n;
  }

  /** Stop taking passengers; once empty, drive back to the depot. `now`: line gone, head home at once. */
  private retire(b: Bus, now: boolean) {
    if (b.phase === 'toDepot') return;
    if (b.v.lane < 0) { this.remove(b); return; } // never left the depot yard
    b.phase = 'retiring';
    if (now) { this.transit.evacuate(b.v.id, b.atCall ? this.stopTile(b) : [Math.floor(b.v.x), Math.floor(b.v.y)]); this.headHome(b); return; }
    if (b.atCall && this.transit.load(b.v.id) === 0) this.headHome(b);
  }
  private stopTile(b: Bus): [number, number] | null {
    const line = this.w.transitLines.get(b.line);
    const si = b.route.calls[b.call];
    const s = line?.stops[si];
    return s ? [s.x, s.y] : null;
  }
  /** Route from where the bus is to its depot door; it leaves the road when it gets there. */
  private headHome(b: Bus) {
    const v = b.v;
    b.phase = 'toDepot'; b.atCall = false; v.dwell = false; v.halt = -1;
    const keep = Math.min(v.path.length / 2, v.pi + 1);
    const head = v.path.slice(0, keep * 2);
    const sx = head[head.length - 2], sy = head[head.length - 1];
    const back = keep >= 2 ? [head[head.length - 4], head[head.length - 3]] : null;
    const r = busLegs(this.busNet(null, true), sx, sy, back ? dirBetween(back[0], back[1], sx, sy) : -1, b.depot[0], b.depot[1]).legs.find((l) => l);
    if (!r || r.path.length < 2) { this.withdraw(b); return; }
    v.path = [...head, ...r.path.slice(2)];
    if (v.leg) v.leg.path = v.path;
    this.traffic.restrand(v);
    if (v.path.length < 4) { this.withdraw(b); }
  }
  /** Take a bus off the road where it is (stuck for good, or no way on): its riders walk on from there. */
  private withdraw(b: Bus) {
    const v = b.v;
    const at: [number, number] = v.lane >= 0 && v.pi >= 1 ? [v.path[(v.pi - 1) * 2], v.path[(v.pi - 1) * 2 + 1]] : [Math.floor(v.x), Math.floor(v.y)];
    this.transit.evacuate(v.id, at);
    this.remove(b);
    this.stats.withdrawn++;
  }
  private remove(b: Bus) {
    this.traffic.leave(b.v);
    this.w.vehicles.delete(b.v.id);
    this.buses.delete(b.v.id);
  }

  // ---- inspection ---------------------------------------------------------------------------------

  describe(v: Vehicle): CitizenInfo | null {
    const b = this.buses.get(v.id);
    if (!b) return null;
    const line = this.w.transitLines.get(b.line);
    const si = b.route.calls[b.call];
    const s = line?.stops[si];
    const load = this.transit.load(v.id);
    const delay = b.atCall ? b.delay : Math.max(b.delay, this.w.tick - b.expectAt);
    const state = b.phase === 'toDepot' ? 'returning to the depot' : b.phase === 'retiring' ? 'last trip, setting people down' : b.phase === 'toLine' ? 'heading out to its first stop'
      : b.atCall ? (this.w.tick >= b.dwellUntil ? 'holding at the stop to even out the gaps' : 'at the stop') : 'in service';
    const bus: BusInfo = {
      line: b.line, number: line?.number ?? 0, colour: line?.colour ?? 0xffffff, nextStop: s && b.phase !== 'toDepot' ? stopName(s.x, s.y) : undefined,
      load, capacity: TRANSIT.busCapacity, delayMin: Math.round((Math.max(0, delay) * 60) / TPH), state,
    };
    const info: CitizenInfo = {
      id: v.id, name: `Bus ${line ? line.number : ''}`.trim(), role: 'bus',
      activity: b.phase === 'toDepot' ? 'returning to the depot' : s ? `${b.atCall ? 'at' : 'to'} ${stopName(s.x, s.y)}` : state,
      mode: 'drive', status: v.wait > 1 && !b.atCall ? 'queued' : b.atCall ? 'idle' : 'moving', waitTicks: v.wait,
      destination: s && b.phase !== 'toDepot' ? { x: s.x, y: s.y, label: stopName(s.x, s.y) } : { x: b.depot[0], y: b.depot[1], label: 'bus depot' },
      bus,
    };
    return info;
  }
  /** Buses by line, for the client's livery: flat [busId, lineId, …]. */
  liveryPairs(): number[] {
    const out: number[] = [];
    for (const b of this.buses.values()) out.push(b.v.id, b.line);
    return out;
  }
}

// ---- helpers ----------------------------------------------------------------------------------------------

/** The direction (DIRS index) from a stop tile to the road it faces: south, east, west, north first, as the renderer turns it. */
export function boardDir(w: World, x: number, y: number): number {
  for (const d of [2, 0, 1, 3]) {
    const t = w.peekTile(x + DIRS[d][0], y + DIRS[d][1]);
    if (t !== undefined && isRoad(t)) return d;
  }
  return -1;
}
/** Hash-seeded: about TRANSIT.mechanicShare of depot staff are mechanics, the rest drive. */
export const isMechanic = (id: number) => hash2(id, 97) < TRANSIT.mechanicShare;
const cellKeyC = (cx: number, cy: number) => (cx + 0x8000) * 65536 + (cy + 0x8000);
const cellKey = (x: number, y: number) => cellKeyC(Math.floor(x / 8), Math.floor(y / 8));
function removeFrom<K, T>(m: Map<K, T[]>, k: K, v: T) {
  const l = m.get(k);
  if (!l) return;
  const i = l.indexOf(v);
  if (i >= 0) l.splice(i, 1);
  if (!l.length) m.delete(k);
}
function bumpCount(m: Map<number, Count>, k: number, day: number, fare: number) {
  let c = m.get(k);
  if (!c) m.set(k, c = { day, today: 0, yesterday: 0, fares: 0 });
  if (c.day !== day) { c.yesterday = c.day === day - 1 ? c.today : 0; c.today = 0; c.fares = 0; c.day = day; }
  c.today++; c.fares += fare;
}
function readCount(c: Count | undefined, day: number) {
  if (!c) return { today: 0, yesterday: 0, fares: 0 };
  if (c.day === day) return c;
  return { today: 0, yesterday: c.day === day - 1 ? c.today : 0, fares: 0 };
}
