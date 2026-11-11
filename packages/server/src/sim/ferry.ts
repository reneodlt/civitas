import {
  TICKS_PER_DAY, TRANSIT, packTile, makeTerrainSampler, hasFeature, techFor, trainsAt, nextRide, headwayMinutes, nameFor, stopTile, railService,
  FERRY, routeWater, ferryStop, pierAt, pierBuilt, pontoonSpot, sailPoints, isFerryPierKind, WaterGrid,
  type RailEnv, type WaterEnv, type RailLineDef, type RailRoute, type RailService, type RouteResult, type TransitLine, type StopRef,
  type LinePreview, type FerryLineDTO, type MetroStationInfo, type TrainInfo,
} from '@msimcity/shared';
import type { World } from '../world';
import type { Transit, LineRoute } from './transit';
import { Timetabled, trainVehicleId, type TimetabledLine } from './timetabled';
import { lapOf } from './rail';
import { ageOf } from './life';
import { weatherNow, type WeatherHold } from './weatherfx';

/** rows of a boat's roster */
const ROSTER_CAP = 200;
/** a refused route is searched again after this many ticks at most (a found one whenever the water under it changes) */
const RETRY_TICKS = 50;

/** The timetable's view of a ferry line: piers by their doors, one river bus a "train" (`ferry`), its name when it has one. */
export function ferryDef(l: TransitLine, doorOf: (x: number, y: number) => [number, number] = (x, y) => [x, y]): RailLineDef {
  return {
    id: l.id, owner: l.owner, number: l.number, name: l.name || `Line ${l.number}`, color: l.colour,
    stations: l.stops.map((s) => doorOf(s.x, s.y)), trains: Math.max(1, l.vehicles), cars: 0, loop: l.loop, ferry: true,
  };
}

/**
 * River buses (docs/boats.md section 6.2, shared/src/ferry.ts) as the 'ferry' mode of the transit registry. Lines are
 * made in the Lines panel by clicking ferry piers; the route is found on the water (`routeWater`: river-class lanes
 * between the piers' berth rows) and the boats run rail's pure timetable (sim/timetabled.ts), so nothing per boat goes
 * over the wire, only the lines ('ferryLines'). Riders wait on the pontoon and pay fares to the line's owner as on the
 * trains. Water is shared, so lines may cross and share it; the one exclusive rule is one line a pier.
 *
 * Routes are cached per line shape with a signature of the water they run on (every route tile and its neighbours,
 * and the piers' doors), so the timetable's re-derivation every 10 ticks costs a few thousand tile reads; a route is
 * searched again when that water changes, and every route once a game day (a new shortcut may have opened).
 */
export class Ferry extends Timetabled {
  readonly mode = 'ferry' as const;
  readonly env: RailEnv;
  private water: WaterEnv;
  private grid: WaterGrid;
  private gridDay = -1;
  private found = new Map<string, { r: RouteResult; sig: number; at: number }>();
  private doorOf = (x: number, y: number) => this.w.doorOf(x, y);
  protected def(l: TransitLine) { return ferryDef(l, this.doorOf); }

  constructor(w: World, transit: Transit) {
    super(w, transit);
    this.env = { tile: (x, y) => w.peekTile(x, y), aux: (x, y) => w.auxAt(x, y), sub: (x, y) => w.subAt(x, y) };
    const sample = makeTerrainSampler(w.seed);
    // water no one has generated yet is still water: the grid falls back to the terrain (docs/boats.md section 2)
    this.water = { tile: (x, y) => w.peekTile(x, y) ?? packTile(sample(x, y), false, 0, 0), aux: (x, y) => w.auxAt(x, y) };
    this.grid = new WaterGrid(this.water);
  }

  // ---- routes ------------------------------------------------------------------------------------

  stopProblem(x: number, y: number): string | null {
    const s = ferryStop(x, y, this.env);
    return 'reason' in s ? cap(s.reason) : null;
  }
  /** A hash of what a route was found on: its tiles and their neighbours (tile words and aux bytes), and the piers' doors. */
  private waterSig(route: RailRoute | null, doors: [number, number][]): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 0x01000193); };
    const at = (x: number, y: number) => { mix(this.w.peekTile(x, y) ?? -1); mix(this.w.auxAt(x, y)); };
    for (const [x, y] of doors) { at(x, y); mix(this.w.subAt(x, y)); }
    if (route) {
      let x = route.x, y = route.y;
      for (let k = 0; k < route.sides.length; k++) {
        at(x, y); at(x + 1, y); at(x - 1, y); at(x, y + 1); at(x, y - 1);
        const o = route.sides.charCodeAt(k) - 48;
        x += o === 1 ? 1 : o === 3 ? -1 : 0; y += o === 2 ? 1 : o === 0 ? -1 : 0;
      }
    }
    return h;
  }
  /** The route of a line's shape on the water now: cached while the water under it and its piers are unchanged. */
  private find(def: Pick<RailLineDef, 'stations' | 'loop'>): RouteResult {
    if (this.w.day !== this.gridDay) { this.gridDay = this.w.day; this.grid = new WaterGrid(this.water); this.found.clear(); }
    const key = `${def.loop ? 1 : 0}|${def.stations.map((s) => s.join(',')).join(';')}`;
    const hit = this.found.get(key);
    if (hit) {
      const sig = this.waterSig(hit.r.ok ? hit.r.route : null, def.stations);
      if (sig === hit.sig && (hit.r.ok || this.w.tick - hit.at < RETRY_TICKS)) return hit.r;
      this.grid = new WaterGrid(this.water); // something on the water changed: read it afresh
    }
    const r = routeWater(def, this.grid, this.env);
    if (this.found.size > 256) this.found.clear();
    this.found.set(key, { r, sig: this.waterSig(r.ok ? r.route : null, def.stations), at: this.w.tick });
    return r;
  }
  /** Why a line may not call where it does (ownership, one line a pier), or null. */
  private claimProblem(line: TransitLine, def: RailLineDef): string | null {
    for (const [x, y] of def.stations) {
      if (!this.sandbox && pierAt(x, y, this.env) && this.w.parcelAt(x, y)?.owner !== line.owner) return `The pier at (${x}, ${y}) is not yours: a line calls only at its owner's piers`;
      for (const o of [...this.w.transitLines.values()].sort((a, b) => a.id - b.id)) {
        if (o.mode !== 'ferry' || o.id === line.id) continue;
        if (o.stops.some((s) => { const [dx, dy] = this.doorOf(s.x, s.y); return dx === x && dy === y; })) {
          return `The pier at (${x}, ${y}) already serves ${lineName(o)}; build another pier for this line`;
        }
      }
    }
    return null;
  }
  route(line: TransitLine): LineRoute | string {
    const def = this.def(line);
    const claim = this.claimProblem(line, def);
    if (claim) return claim;
    const r = this.find(def);
    return r.ok ? lapOf(r.route, def.stations.length) : `${cap(lineName(line))}: ${r.reason}`;
  }
  protected network(rl: TimetabledLine): { route: RailRoute; tiles: Set<number> } | string {
    const r = this.find(rl.def);
    return r.ok ? r : r.reason;
  }
  protected unbuilt(rl: TimetabledLine): [number, number] | undefined {
    return rl.def.stations.find(([x, y]) => { const p = pierAt(x, y, this.env); return !p || !pierBuilt(p, this.env); });
  }

  // ---- the editor and saving ----------------------------------------------------------------------

  /** A draft line routed as a save would route it: the lap, the line the boats sail, the round trip, or what is wrong. */
  plan(line: TransitLine): Omit<LinePreview, 'seq'> {
    const none = { ok: false, path: [], calls: [], callNodes: [], turns: [], length: 0, lapTicks: 0 };
    const bad = (message: string, at?: [number, number]) => ({ ...none, problem: { message, tiles: at ? [at[0], at[1]] : [], fatal: true } });
    const pre = this.capProblem(line) ?? this.techProblem(line);
    if (pre) return bad(pre);
    const def = this.def(line);
    const claim = this.claimProblem(line, def);
    if (claim) return bad(claim);
    const r = this.find(def);
    if (!r.ok) return bad(cap(r.reason), r.at);
    const lap = lapOf(r.route, def.stations.length);
    return {
      ok: true, path: lap.path, calls: lap.calls, callNodes: lap.callNodes, turns: [], length: lap.path.length / 2,
      lapTicks: Math.round(railService(def, r.route).T), sail: sailPoints(r.route),
    };
  }
  /** On save (Transit.saveLine, before route()): the owner's cap on lines and the River buses technology. */
  commit(line: TransitLine): string | null {
    return this.capProblem(line) ?? this.techProblem(line);
  }
  private capProblem(line: TransitLine): string | null {
    let n = 0;
    for (const l of this.w.transitLines.values()) if (l.mode === 'ferry' && l.owner === line.owner && l.id !== line.id) n++;
    return n >= FERRY.linesPerOwner ? `You run ${FERRY.linesPerOwner} ferry lines already, the most one owner may` : null;
  }
  private techProblem(line: TransitLine): string | null {
    const p = this.w.players.get(line.owner);
    if (!p || this.sandbox || p.devUnlimited || hasFeature(p.tech, 'ferry')) return null;
    return `${techFor('ferry')?.name ?? 'River buses'} is needed before you can run ferry lines`;
  }

  // ---- riders -------------------------------------------------------------------------------------

  /** Riders walk the gangway on and off: the timetable's time plus FERRY.access. */
  rideTicks(line: TransitLine, a: number, b: number): number {
    return super.rideTicks(line, a, b) + FERRY.access;
  }
  /** A rider waits at their own spot on the pontoon. */
  waitSpot(stop: StopRef, citizenId: number): [number, number] | null {
    const p = pierAt(stop.x, stop.y, this.env);
    return p ? pontoonSpot(p, citizenId) : null;
  }
  protected capacity(svc: RailService) { return svc.vehicles * FERRY.riders; }

  // ---- the weather (docs/weather.md W4) -------------------------------------------------------------

  /** set by game.ts: sailings held or resumed, for the news (sim/news.ts weather) */
  onHold: ((e: WeatherHold) => void) | null = null;
  private holding: 'storm' | 'fog' | null = null;
  /** counters since start: holds, ticks held */
  weatherStats = { holds: 0, heldTicks: 0 };
  /** Storm or thick fog: the boats keep their timetable (the clients draw it) but take no one on, and the planner sends nobody by river bus. */
  protected heldWhy(): string | null {
    const h = this.byId.size ? weatherNow(this.w).hold : null;
    return h ? (h === 'storm' ? 'sailings held: storm' : 'sailings held: thick fog') : null;
  }
  tick() {
    const h = this.byId.size ? weatherNow(this.w).hold : null;
    if (h) this.weatherStats.heldTicks++;
    if (h !== this.holding) {
      const was = this.holding;
      this.holding = h;
      const first = [...this.byId.values()].find((l) => l.svc)?.def.stations[0];
      if (h) this.weatherStats.holds++;
      if (first) this.onHold?.({ what: 'river buses', reason: h ?? was!, lifted: !h, x: first[0], y: first[1], owner: this.w.parcelAt(first[0], first[1])?.owner });
    }
    super.tick();
  }

  /** The lines on the wire ('ferryLines'): rail's form, with the piers' names. */
  dtos(): FerryLineDTO[] {
    return super.dtos().map((d) => ({ ...d, names: d.stations.map(([x, y]) => this.w.stopLabel(x, y)) }));
  }

  // ---- tooltips -----------------------------------------------------------------------------------

  /** The ferry section of the tooltip of the pier covering (x, y). */
  describeStation(x: number, y: number): MetroStationInfo | undefined {
    const [dx, dy] = this.doorOf(x, y);
    if (!isFerryPierKind(this.w.kindIdAt(dx, dy))) return undefined;
    const p = pierAt(dx, dy, this.env);
    const st = ferryStop(dx, dy, this.env);
    const now = this.railTick, today = Math.floor(now / TICKS_PER_DAY);
    const s = this.stats.get(`${dx},${dy}`);
    const info: MetroStationInfo = {
      name: this.w.stopLabel(dx, dy),
      track: 'reason' in st ? cap(st.reason) : p && pierBuilt(p, this.env) ? 'open' : 'opens when the pier is built',
      lines: [], changes: [],
      callsToday: s && s.day === today ? s.calls : 0, boardedToday: s && s.day === today ? s.boarded : 0,
      alightedToday: s && s.day === today ? s.alighted : 0, faresToday: 0,
    };
    if (!('reason' in st)) { const [x0, y0] = stopTile(st, st.a0), [x1, y1] = stopTile(st, st.a1); info.platform = [x0, y0, x1, y1]; }
    for (const rl of [...this.byId.values()].sort((a, b) => a.line.number - b.line.number)) {
      const i = rl.def.stations.findIndex(([sx, sy]) => sx === dx && sy === dy);
      if (i < 0) continue;
      const row: MetroStationInfo['lines'][number] = { id: rl.line.id, number: rl.line.number, name: rl.def.name, color: rl.line.colour, status: rl.status };
      if (rl.svc) {
        row.headwayMin = headwayMinutes(rl.svc);
        const n = rl.def.stations.length, names = (j: number) => this.w.stopLabel(rl.def.stations[j][0], rl.def.stations[j][1]);
        for (const j of [i + 1 < n ? i + 1 : rl.def.loop ? 0 : -1, i > 0 && !rl.def.loop ? i - 1 : -1]) {
          if (j < 0) continue;
          const ride = nextRide(rl.svc, i, j, now);
          const end = rl.def.loop ? 'round the loop' : `towards ${names(j > i ? n - 1 : 0)}`;
          if (ride && (!row.next || ride.depart < row.next.tick)) row.next = { tick: ride.depart, toward: end };
        }
      }
      info.lines.push(row);
    }
    const mine = new Set(info.lines.map((l) => l.id));
    for (const { s: o, lines } of this.transit.stopsAround(dx, dy, TRANSIT.transferWalk)) {
      if (o.x === dx && o.y === dy) continue;
      const others = lines.filter((l) => !mine.has(l.id));
      if (!others.length) continue;
      info.changes.push({
        name: this.w.stopLabel(o.x, o.y), x: o.x, y: o.y, mode: others[0].mode,
        lines: others.map((l) => ({ id: l.id, number: l.number, name: l.name, colour: l.colour })),
      });
    }
    return info;
  }

  /** A river bus's tooltip; `full` (the selected boat's panel) adds everyone on board. */
  describeTrain(lineId: number, train: number, full = false): TrainInfo | null {
    const rl = this.byId.get(lineId);
    if (!rl?.svc) return null;
    const t = trainsAt(rl.svc, this.railTick).find((s) => s.train === train);
    if (!t) return null;
    const vid = trainVehicleId(lineId, train), st = rl.def.stations, n = st.length;
    const name = (i: number) => this.w.stopLabel(st[i][0], st[i][1]);
    const info: TrainInfo = {
      line: lineId, number: rl.line.number, colour: rl.line.colour, freight: false,
      state: t.phase === 'dwell' ? `alongside at ${name(t.stop)}` : `sailing to ${name(t.stop)}`,
      load: this.transit.load(vid), capacity: this.capacity(rl.svc),
    };
    const prev = t.phase === 'dwell' ? t.stop : rl.def.loop ? (t.stop - 1 + n) % n : t.stop - t.dir;
    if (prev >= 0 && prev < n) info.prev = name(prev);
    info.next = name(t.stop);
    if (full) {
      const aboard = this.transit.aboard(vid);
      info.riders = aboard.slice(0, ROSTER_CAP).map(({ c, off }) => ({
        id: c.id, name: nameFor(c.id, c.sn), activity: `to ${this.w.stopLabel(off.x, off.y)}`, here: true, age: Math.floor(ageOf(c, this.w.tick)), stage: c.stage,
      }));
      if (aboard.length > ROSTER_CAP) info.truncated = true;
    }
    return info;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lineName = (l: TransitLine) => (l.name ? `the ${l.name} line` : `line ${l.number}`);
