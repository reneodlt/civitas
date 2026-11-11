import {
  TICKS_PER_DAY, TICKS_PER_HOUR, railService, callsBetween, trainsAt, trainCycles, railPoint, headwayMinutes, SERVICE_START_HOUR, SERVICE_END_HOUR,
  type RailLineDef, type RailRoute, type RailService, type RailLineDTO, type TransitLine, type TransitMode,
} from '@msimcity/shared';
import type { World } from '../world';
import type { Transit, ModeService, LineRoute } from './transit';

const REBUILD_EVERY = 10;
/** a train's vehicle id for the transit registry: clear of citizens and of the buses' ids (line ids are unique across modes) */
const VEHICLE_BASE = 1 << 30;
export const trainVehicleId = (lineId: number, train: number) => VEHICLE_BASE + lineId * 16 + train;
export const vehicleLine = (vid: number) => Math.floor((vid - VEHICLE_BASE) / 16);
export const vehicleTrain = (vid: number) => (vid - VEHICLE_BASE) % 16;

export interface TimetabledLine {
  line: TransitLine;
  def: RailLineDef;
  route: RailRoute | null;
  tiles: Set<number> | null;
  /** present while trains can run (route found, stations built, trains assigned) */
  svc: RailService | null;
  /** 'running', or why no trains run */
  status: string;
}

/**
 * The line-running half of a mode whose trains run rail's pure timetable (shared/src/rail.ts): surface rail
 * (sim/rail.ts) and the metro (sim/metro.ts). Lines live in the transit registry; this keeps each one's route
 * through its network and its service, re-derives them every REBUILD_EVERY ticks (and at the next tick after an
 * edit: `pending`), answers the planner's timing questions from the timetable, and hands every call at a station to
 * the registry so riders get on and off. Nothing per train goes over the wire: the clients run the same timetable.
 *
 * A mode says how a line is defined (`def`), how it is routed through its network now (`network`), when its
 * stations are open (`unbuilt`) and how many a train carries (`capacity`).
 */
export abstract class Timetabled implements ModeService {
  /** a sandbox: a line may call at any owner's stations; set by game.ts */
  sandbox = false;
  abstract readonly mode: TransitMode;
  protected byId = new Map<number, TimetabledLine>();
  /** true when the lines' wire form changed since net last sent it */
  changed = true;
  /** set by network edits: lines are re-derived at the next tick instead of the next REBUILD_EVERY */
  pending = false;
  private sig = '';
  private last = -1;
  protected stats = new Map<string, { day: number; calls: number; boarded: number; alighted: number }>();

  constructor(protected w: World, protected transit: Transit) {}

  /** Each line with trains running: its track tiles (tkey) and its trains (sim/value.ts: rail noise). */
  eachRunning(fn: (tiles: Set<number>, trains: number) => void) { for (const l of this.byId.values()) if (l.svc && l.tiles) fn(l.tiles, l.def.trains); }
  /** The tick trains run on: the same day + fraction the clients interpolate from 'stats' (as planes do). */
  get railTick() { return this.w.day * TICKS_PER_DAY + (this.w.tick % TICKS_PER_DAY); }

  /** The timetable's view of a transit line. */
  protected abstract def(l: TransitLine): RailLineDef;
  /** The line's route through the network as it is now, or why it has none; an earlier line keeps what a later one also finds. */
  protected abstract network(rl: TimetabledLine): { route: RailRoute; tiles: Set<number> } | string;
  /** The first of the line's stations that is not open yet, if any. */
  protected abstract unbuilt(rl: TimetabledLine): [number, number] | undefined;
  /** Places on one of the line's trains. */
  protected abstract capacity(svc: RailService): number;
  abstract stopProblem(x: number, y: number): string | null;
  /** Why no one may board now (a ferry held by storm or fog, docs/weather.md W4), or null: riders still get off, none get on, the planner skips the mode. */
  protected heldWhy(): string | null { return null; }
  abstract route(line: TransitLine): LineRoute | string;

  // ---- lines -------------------------------------------------------------------------------------

  /** The registry saved, re-routed or deleted a line: take its definition, route and service from the tiles. */
  lineChanged(id: number, line: TransitLine | null) {
    const old = this.byId.get(id);
    if (!line || line.mode !== this.mode) {
      if (old) { this.withdraw(old); this.byId.delete(id); this.publish(); }
      return;
    }
    const rl: TimetabledLine = old ?? { line, def: this.def(line), route: null, tiles: null, svc: null, status: 'starting' };
    if (old?.svc) this.withdraw(old);
    rl.line = line; rl.def = this.def(line);
    this.byId.set(id, rl);
    this.derive(rl);
    this.publish();
  }

  /** Route and service of one line from the tiles. */
  protected derive(rl: TimetabledLine) {
    const was = rl.svc;
    rl.route = null; rl.tiles = null; rl.svc = null;
    if (this.transit.routeProblem(rl.line.id)) { rl.status = this.transit.routeProblem(rl.line.id); return; }
    const r = this.network(rl);
    if (typeof r === 'string') { rl.status = r; return; }
    rl.route = r.route; rl.tiles = r.tiles;
    const unbuilt = this.unbuilt(rl);
    if (unbuilt) { rl.status = `waiting for the station at (${unbuilt[0]}, ${unbuilt[1]}) to be built`; return; }
    if (rl.line.vehicles < 1) { rl.status = 'no trains assigned'; return; }
    rl.svc = railService(rl.def, r.route);
    rl.status = 'running';
    if (was && JSON.stringify(was.pieces) !== JSON.stringify(rl.svc.pieces)) this.withdraw({ ...rl, svc: was }); // the timetable moved under its riders
  }

  /** Re-derive every line (the network or stations may have changed). Lines whose route broke or came back are re-checked by the registry. */
  rebuild() {
    this.sync();
    let broke = false;
    for (const rl of [...this.byId.values()].sort((a, b) => a.line.id - b.line.id)) {
      const had = !!rl.route, key = rl.route ? JSON.stringify(rl.route) : '';
      this.derive(rl);
      if (had !== !!rl.route || (rl.route && JSON.stringify(rl.route) !== key)) broke = true;
    }
    if (broke) this.transit.revalidate();
    this.publish();
  }
  /**
   * Take this mode's lines from the registry (World.transitLines): lines loaded with the world, saved or deleted since,
   * whether or not the registry told us through lineChanged.
   */
  private sync() {
    const seen = new Set<number>();
    for (const l of this.w.transitLines.values()) {
      if (l.mode !== this.mode) continue;
      seen.add(l.id);
      const rl = this.byId.get(l.id);
      if (!rl) this.byId.set(l.id, { line: l, def: this.def(l), route: null, tiles: null, svc: null, status: 'starting' });
      else if (rl.line !== l) { rl.line = l; rl.def = this.def(l); }
    }
    for (const [id, rl] of this.byId) if (!seen.has(id)) { this.withdraw(rl); this.byId.delete(id); }
  }
  protected publish() {
    const sig = JSON.stringify(this.dtos());
    if (sig !== this.sig) { this.sig = sig; this.changed = true; }
  }

  // ---- ModeService: timing ----------------------------------------------------------------------

  /** The cycle piece index of a line's call (calls run 0..n-1 then n-2..1 back on a there-and-back line, as the pieces do). */
  protected pieceOfCall(svc: RailService, call: number): number {
    let k = -1;
    for (let i = 0; i < svc.pieces.length; i++) if (svc.pieces[i].stop >= 0 && ++k === call) return i;
    return -1;
  }
  protected callOf(rl: TimetabledLine, stop: number, dir: 1 | -1): number {
    const n = rl.def.stations.length;
    return rl.def.loop || dir > 0 || stop === n - 1 ? stop : 2 * (n - 1) - stop;
  }
  waitAt(line: TransitLine, call: number): number | null {
    const rl = this.byId.get(line.id);
    if (!rl?.svc || rl.svc.freight) return null; // freight trains take no passengers: the planner skips them
    if (this.heldWhy()) return null;
    const svc = rl.svc, pi = this.pieceOfCall(svc, call);
    if (pi < 0) return null;
    const now = this.railTick, p = svc.pieces[pi];
    for (const c of callsBetween(svc, now - p.dur, now + TICKS_PER_DAY / 4)) {
      if (c.stop !== p.stop || c.dir !== p.dir || c.depart < now) continue;
      return Math.max(0, c.arrive - now);
    }
    return null;
  }
  rideTicks(line: TransitLine, a: number, b: number): number {
    const rl = this.byId.get(line.id);
    if (!rl?.svc) return Infinity;
    const svc = rl.svc, pa = this.pieceOfCall(svc, a), pb = this.pieceOfCall(svc, b);
    if (pa < 0 || pb < 0) return Infinity;
    const leave = svc.pieces[pa].t0 + svc.pieces[pa].dur, reach = svc.pieces[pb].t0;
    return reach > leave ? reach - leave : reach - leave + svc.T;
  }
  /** Ticks between trains of a line (the planner expects half of it at a change). */
  headway(line: TransitLine): number | null {
    const rl = this.byId.get(line.id);
    return rl?.svc ? rl.svc.headway : null;
  }
  inService(line: TransitLine): number {
    const rl = this.byId.get(line.id);
    return rl?.svc ? trainsAt(rl.svc, this.railTick).length : 0;
  }
  problem(line: TransitLine): string | null {
    const rl = this.byId.get(line.id);
    if (!rl) return 'not routed yet';
    if (!rl.svc) return rl.status;
    const held = this.heldWhy();
    if (held) return held;
    if (!this.inService(line)) {
      const h = (this.railTick % TICKS_PER_DAY) / TICKS_PER_HOUR;
      return h < SERVICE_START_HOUR && h >= SERVICE_END_HOUR - 24 ? 'outside service hours (05:00–01:00)' : 'between trains';
    }
    return null;
  }
  positionOf(vehicleId: number): [number, number] | null {
    const rl = this.byId.get(vehicleLine(vehicleId));
    if (!rl?.svc) return null;
    const t = trainsAt(rl.svc, this.railTick).find((s) => s.train === vehicleTrain(vehicleId));
    if (!t) return null;
    const p = railPoint(rl.svc.geom, t.s);
    return [p.x, p.z];
  }

  // ---- ModeService: running ---------------------------------------------------------------------

  /** Once per simulation tick (from Transit.tick): re-derive now and then, and serve every call at a station since last time. */
  tick() {
    const now = this.railTick;
    if (this.last < 0 || this.pending || this.w.tick % REBUILD_EVERY === 0) { this.pending = false; this.rebuild(); }
    const from = this.last < 0 ? now : this.last;
    this.last = now;
    if (now <= from || now - from > TICKS_PER_DAY) return;
    for (const rl of this.byId.values()) {
      const svc = rl.svc;
      if (!svc) continue;
      // arrivals: riders for this station get off, and those waiting get on
      for (const call of callsBetween(svc, from, now)) this.serve(rl, call.train, call.stop, call.dir);
      // while the doors stay open, latecomers on the platform still get on
      for (const t of trainsAt(svc, now)) if (t.phase === 'dwell' && t.doors) this.serve(rl, t.train, t.stop, t.dir, false);
      // a train's day ends when its last cycle brings it back to the first station: everyone gets off there
      for (let day = Math.floor(from / TICKS_PER_DAY) - 1; day <= Math.floor(now / TICKS_PER_DAY); day++) {
        const d0 = day * TICKS_PER_DAY + SERVICE_START_HOUR * TICKS_PER_HOUR;
        for (let i = 0; i < svc.trains; i++) {
          const end = d0 + i * svc.headway + trainCycles(svc, i) * svc.T;
          if (trainCycles(svc, i) > 0 && end > from && end <= now) this.finish(rl, i);
        }
      }
    }
  }
  /** A train at a station: hand over to the registry (riders off, riders on). `arrival` false: a later tick of the same dwell. */
  protected serve(rl: TimetabledLine, train: number, stop: number, dir: 1 | -1, arrival = true) {
    const vid = trainVehicleId(rl.line.id, train);
    const room = this.heldWhy() ? 0 : this.capacity(rl.svc!) - this.transit.load(vid);
    if (!arrival && room <= 0) return;
    const { off, on } = this.transit.serveCall(vid, rl.line.id, this.callOf(rl, stop, dir), room, true);
    if (!arrival && !on && !off) return;
    const door = rl.def.stations[stop], day = Math.floor(this.railTick / TICKS_PER_DAY), key = `${door[0]},${door[1]}`;
    let s = this.stats.get(key);
    if (!s || s.day !== day) { s = { day, calls: 0, boarded: 0, alighted: 0 }; this.stats.set(key, s); }
    if (arrival) s.calls++;
    s.boarded += on; s.alighted += off;
  }
  /** A train's day ends back at the first station: everyone left on board gets off there. */
  protected finish(rl: TimetabledLine, train: number) {
    const vid = trainVehicleId(rl.line.id, train);
    this.transit.serveCall(vid, rl.line.id, 0, 0, false);
    const d = rl.def.stations[0];
    this.transit.evacuate(vid, [d[0], d[1]]);
  }
  /** A line stops running (deleted, re-timed or broken): riders on its trains walk on from where they are. */
  protected withdraw(rl: TimetabledLine) {
    if (!rl.svc) return;
    for (let i = 0; i < rl.svc.trains; i++) this.withdrawTrain(rl, i);
  }
  protected withdrawTrain(rl: TimetabledLine, train: number) {
    const vid = trainVehicleId(rl.line.id, train);
    const p = this.positionOf(vid);
    this.transit.evacuate(vid, p ? [Math.floor(p[0]), Math.floor(p[1])] : null);
  }

  // ---- wire ----------------------------------------------------------------------------------------

  /** The lines as the wire carries them (to everyone: they are small, and trains need them wherever the camera is). */
  dtos(): RailLineDTO[] {
    return [...this.byId.values()].sort((a, b) => a.line.id - b.line.id).map((l) => ({
      ...l.def, stations: l.def.stations.map((s) => [s[0], s[1]] as [number, number]), status: l.status,
      route: l.svc ? l.route ?? undefined : undefined, running: l.svc?.trains ?? 0, note: l.svc?.note,
      headwayMin: l.svc ? headwayMinutes(l.svc) : undefined,
    }));
  }
}
