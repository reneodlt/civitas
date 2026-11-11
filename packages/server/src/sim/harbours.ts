import {
  Zone, TICKS_PER_DAY, TICKS_PER_HOUR, MAX_LEVEL, Terrain, CitizenState, packTile, terrainOf, hash2, surnameFor, nameFor, kindManifest, isFoodVenue, tileKey,
  makeTerrainSampler, isBridgeAux, navigable, HARBOUR_OF, fairwayTiles, footprintTile, WIDTH_CLEARANCE, WaterGrid, openWater, deriveHarbourLanes,
  harbourLaneSpecs, harbourBerths, harbourFleet, harboursKey, boatEvents, boatVoyageAt, basedBoat, catchOf, callCargo, boatName,
  type WaterEnv, type SeaGate, type BoatEvent, type BasedBoat, type HarbourDTO, type HarbourInfo, type BoatInfo, type Placed, type ServerMsg,
} from '@msimcity/shared';
import { tkey, type Building, type World } from '../world';
import type { Simulation } from './simulation';
import { weatherNow, type WeatherHold } from './weatherfx';

/**
 * The server's harbours (docs/boats.md sections 2, 6.3-6.5): the harbour list with its lanes, sent to every client as
 * the `harbours` message, and the money the pure boat schedule (shared/src/boats.ts) makes as it runs.
 *
 *  - **Lanes on change.** Each built harbour's lanes start at one fairway tile behind its middle column, the row out
 *    where the water is as wide as its widest boats need. They are derived (deriveHarbourLanes) when a harbour is built
 *    or removed, changes hands or staffing, when any water tile's navigability changes (a bridge, a harbour, a deck
 *    taken away: the WaterGrid is invalidated there), and in a sweep once a day. Each change is a NEW list of new
 *    objects, because the schedule's caches are keyed by object; an unchanged derivation keeps the old list.
 *  - **Sea gates.** A scenario declares them (World.seaGates). Without any, a body of OPEN_SEA_TILES or more is open
 *    water reaching the sea and its offing is the gate (Rich's default, question 1): ships come over the horizon
 *    there. A cargo port on a smaller lake is refused at placement, and a port with no sea lane is no gateway.
 *  - **Events.** Each tick walks the schedule's events of days d - 1 and d between the last tick and this one, on the
 *    clock planes use (Airports.flightTick): trawlers land their catch (`berthed`), ships land containers and
 *    passengers (`alongside`) and take exports (`castOff`).
 *  - **The economy.** Fish go by lorry to food venues (75%) and industry (25%), 10 boxes a lorry, the buyer paying
 *    FISH_FEE a box; containers off ships go by lorry to shops (rail freight applies to both, as for any works), and
 *    trucks bring exports to an open port as to a motorway connection (Simulation.ports). Port dues and marina berth
 *    fees are paid from outside. Nothing here is saved: stocks and queues start empty after a restart.
 */

/** Ticks between scans of the built harbours (and the lane re-derivation a water edit asks for). */
const SCAN_EVERY = 10;
/** A scan re-derives stale harbours (after a water edit, or in the daily sweep) for about this long, then leaves the rest to the next. */
const DERIVE_BUDGET_MS = 8;
/** A lorry of fish carries this many boxes; the buyer pays this a box; this share goes to food venues, the rest to industry. */
const FISH_LORRY = 10, FISH_FEE = 3, FISH_FOOD_SHARE = 0.75, FISH_RADIUS = 60;
/** Ticks between lorries from one harbour: fish (05:00-20:00) and containers (06:00-20:00). */
const FISH_EVERY = Math.round(TICKS_PER_HOUR / 5), IMPORT_EVERY = Math.round(TICKS_PER_HOUR / 12);
/** Port dues a container landed or taken on; what a shop pays for one; the most a port holds waiting for lorries or ships. */
const PORT_DUES = 5, BOX_FEE = 3, IMPORT_MAX = 240, STACK_MAX = 400;
/** Export boxes not taken by a ship within this many ticks are written off, as rail containers are. */
const STACK_TTL = Math.round(1.5 * TICKS_PER_DAY);
/** A fishing harbour's payroll: crew (on the trawlers) against market porters, as the catalogue's staff (20 of 26). */
const FISH_CREW_SHARE = 20 / 26;
/** The name a procedural world's open water goes by as a sea gate. */
export const OFFING_NAME = 'the open sea';
const MAX_SCORE = 2 * MAX_LEVEL + 3;
const ROLE_WORD: Record<string, string> = { jetty: 'Jetty', marina: 'Marina', fishing: 'Harbour', pier: 'Pier', port: 'Docks' };
const SIDES: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

const derivedKey = (p: Placed) => `${p.kind}|${p.ax},${p.ay},${p.r}`;
/** A harbour id from its anchor tile: stable, positive, under 2^31. */
export const harbourId = (ax: number, ay: number) => ((ax + 0x4000) & 0x7fff) * 65536 + ((ay + 0x8000) & 0xffff);

/** What one harbour's lanes were derived as; `stale` once the water changed, until it is derived again. */
interface Derived { lanes: HarbourDTO['lanes']; refused: string[]; fairway: [number, number]; gates: SeaGate[]; waterTiles?: number; stale?: boolean }
/** One harbour's running figures (not saved). */
interface Yard {
  id: number; b: Building; p: Placed; dto: HarbourDTO; role: string; sea: boolean;
  day: number;
  landed: number; sold: number; stock: number; landedBy: Map<number, number>;
  calls: number; imports: number; exports: number; passengers: number; fees: number;
  importQueue: number;
  /** export boxes waiting for a ship: the tick each arrived */
  stack: number[];
  /** containers each call took on, by voyage id */
  taken: Map<number, number>;
}

export class Harbours {
  /** the list on the wire: replaced (never changed in place) whenever anything in it changes */
  list: HarbourDTO[] = [];
  /** the declared gates and each open-water offing a lane uses */
  gates: SeaGate[] = [];
  /** set when list or gates changed; net.ts sends the message and clears it */
  changed = false;
  /** totals since start (the loadtest and checks read these) */
  totals = { landed: 0, sold: 0, calls: 0, imports: 0, importLorries: 0, exports: 0, passengers: 0, dues: 0, berthFees: 0, derivations: 0, deriveMs: 0 };
  readonly grid: WaterGrid;
  private yards = new Map<number, Yard>();
  private byDoor = new Map<number, Yard>();
  private byFront = new Map<number, Yard>();
  private derived = new Map<string, Derived>();
  private sig = '';
  private listJson = '';
  private waterDirty = false;
  /** stale derivations left for the next scan */
  private restale = false;
  /** last navigability seen at each water tile that changed (0 none, 1 open, 2 + aux a deck) */
  private navSeen = new Map<number, number>();
  private exportPts: [number, number][] = [];
  private last = -1;
  private evCache = new Map<string, BoatEvent[]>();
  /** boat events held by storm or fog (docs/weather.md W4): trawlers stay in, ships wait off; they happen, late, when it lifts */
  private heldEvents: BoatEvent[] = [];
  private holding: 'storm' | 'fog' | null = null;
  /** set by game.ts: shipping held or resumed, for the news (sim/news.ts weather) */
  onHold: ((e: WeatherHold) => void) | null = null;
  /** counters since start: holds, events held (each happens late when the hold lifts) */
  weatherStats = { holds: 0, held: 0 };

  constructor(private w: World, private sim: Simulation | null = null) {
    const sample = makeTerrainSampler(w.seed);
    const env: WaterEnv = { tile: (x, y) => w.peekTile(x, y) ?? packTile(sample(x, y), false, 0, 0), aux: (x, y) => w.auxAt(x, y) };
    this.grid = new WaterGrid(env);
    const prev = w.onTileChanged;
    w.onTileChanged = (x, y) => { prev?.(x, y); this.tileChanged(x, y); };
    if (sim) {
      sim.ports = { exportPoints: () => this.exportPts, exported: (x, y) => this.exported(x, y) };
      sim.gateways.seaRoute = (x, y) => !!this.byDoor.get(tkey(x, y))?.sea;
    }
  }

  /** The tick the boat schedule runs on: day and fraction, as the clients and Airports.flightTick count it. */
  get now() { return this.w.day * TICKS_PER_DAY + (this.w.tick % TICKS_PER_DAY); }

  msg(): Extract<ServerMsg, { t: 'harbours' }> { return { t: 'harbours', list: this.list, gates: this.gates }; }

  /** A water tile changed: when boats see it differently now, the lanes are derived again. */
  private tileChanged(x: number, y: number) {
    const t = this.w.peekTile(x, y);
    if (t === undefined || terrainOf(t) !== Terrain.Water) return;
    const a = this.w.auxAt(x, y), k = tkey(x, y);
    const nav = navigable(this.grid.env, x, y) ? (isBridgeAux(a) ? 2 + a : 1) : 0;
    if (this.navSeen.get(k) === nav) return; // a harbour's wet tiles change as it is built: no boat sees that
    this.navSeen.set(k, nav);
    this.grid.invalidate(x, y);
    this.waterDirty = true;
  }

  /**
   * Water turned into land (a future fill tool, docs/boats.md section 3): World.onTileChanged only reports tiles that are
   * water after the change, so whoever fills water in says so here.
   */
  waterFilled(x: number, y: number) { this.navSeen.set(tkey(x, y), 0); this.grid.invalidate(x, y); this.waterDirty = true; }

  /** Run once per simulation tick, after it. */
  tick() {
    const now = this.now, day = Math.floor(now / TICKS_PER_DAY);
    const newDay = this.last >= 0 && Math.floor(this.last / TICKS_PER_DAY) !== day;
    if (newDay) { this.grid.clear(); this.waterDirty = true; this.payBerthFees(); } // the daily sweep
    if (this.last < 0 || this.w.tick % SCAN_EVERY === 0) this.scan();
    const from = this.last;
    this.last = now;
    if (!this.list.length || from < 0 || now <= from || now - from > TICKS_PER_DAY) return;
    const hold = weatherNow(this.w).hold;
    for (let d = Math.floor(from / TICKS_PER_DAY) - 1; d <= day; d++) {
      const evs = this.events(d);
      let lo = 0, hi = evs.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (evs[m].t <= from) lo = m + 1; else hi = m; }
      for (let i = lo; i < evs.length && evs[i].t <= now; i++) {
        if (hold && this.heldEvents.length < 2000) { this.heldEvents.push(evs[i]); this.weatherStats.held++; } else this.event(evs[i]);
      }
    }
    if (!hold && this.heldEvents.length) { const late = this.heldEvents; this.heldEvents = []; for (const e of late) this.event(e); }
    if (hold !== this.holding) {
      const was = this.holding;
      this.holding = hold;
      const y = [...this.yards.values()].find((v) => v.dto.active);
      if (hold) this.weatherStats.holds++;
      if (y) this.onHold?.({ what: 'shipping', reason: hold ?? was!, lifted: !hold, x: y.b.x, y: y.b.y, owner: y.dto.owner ?? undefined });
    }
    const hour = (now % TICKS_PER_DAY) / TICKS_PER_HOUR;
    if (this.sim && this.w.tick % FISH_EVERY === 0 && hour >= 5 && hour < 20) for (const y of this.yards.values()) if (y.stock >= FISH_LORRY && y.dto.active) this.sellFish(y);
    if (this.sim && this.w.tick % IMPORT_EVERY === 0 && hour >= 6 && hour < 20) for (const y of this.yards.values()) if (y.importQueue > 0 && y.dto.active) this.sendImport(y);
  }

  private events(day: number): BoatEvent[] {
    const key = `${harboursKey(this.list)}|${day}`;
    let evs = this.evCache.get(key);
    if (!evs) {
      evs = boatEvents(this.list, day);
      if (this.evCache.size >= 6) this.evCache.delete(this.evCache.keys().next().value!);
      this.evCache.set(key, evs);
    }
    return evs;
  }

  // ---- the harbour list -------------------------------------------------------------------------------------------

  /** Re-read the built harbours; derive and publish a new list when any of them, or the water, changed. */
  scan() {
    const found: { b: Building; p: Placed; owner: string | null; name: string }[] = [];
    let sig = '';
    for (const b of this.w.builtOf(Zone.Hub)) {
      if (!HARBOUR_OF[b.id] || b.level === 0) continue;
      const p = this.w.structureAt(b.x, b.y);
      if (!p || p.kind !== b.id) continue;
      const owner = this.w.parcelAt(b.x, b.y)?.owner ?? null;
      const name = this.w.stopNames.get(tileKey(b.x, b.y)) ?? `${surnameFor((b.x * 7919 + b.y * 104729) | 0)} ${ROLE_WORD[HARBOUR_OF[b.id]!.role]}`;
      found.push({ b, p, owner, name });
      sig += `${b.id}|${p.ax},${p.ay},${p.r}|${b.occupants > 0 ? 1 : 0}|${owner}|${name};`;
    }
    if (sig === this.sig && !this.waterDirty && !this.restale) return;
    this.sig = sig;
    if (this.waterDirty) { for (const d of this.derived.values()) d.stale = true; this.waterDirty = false; }
    // a new harbour is derived at once, stale ones while the scan is within its budget; the rest keep their lanes a scan longer
    const t0 = performance.now();
    this.restale = false;
    const list: HarbourDTO[] = [], gates = new Map<string, SeaGate>(), yards = new Map<number, Yard>();
    for (const { b, p, owner, name } of found.sort((a, c) => a.p.ax - c.p.ax || a.p.ay - c.p.ay)) {
      const id = harbourId(p.ax, p.ay), old = this.derived.get(derivedKey(p));
      const fresh = !old || (old.stale && performance.now() - t0 < DERIVE_BUDGET_MS);
      if (old?.stale && !fresh) this.restale = true;
      const d = fresh ? this.derive(p, id) : old;
      const dto: HarbourDTO = {
        id, kind: p.kind, x: p.ax, y: p.ay, name, active: b.occupants > 0, berths: harbourBerths(p), lanes: d.lanes,
        r: p.r, door: [p.doorX, p.doorY], owner, fairway: d.fairway, ...(d.refused.length ? { refused: d.refused } : {}),
      };
      list.push(dto);
      for (const l of d.lanes) { const g = l.gate ? d.gates.find((q) => q.name === l.gate) : undefined; if (g) gates.set(`${g.x},${g.y}`, g); }
      const role = HARBOUR_OF[p.kind]!.role;
      const y: Yard = this.yards.get(id) ?? {
        id, b, p, dto, role, sea: false, day: Math.floor(this.now / TICKS_PER_DAY), landed: 0, sold: 0, stock: 0, landedBy: new Map(),
        calls: 0, imports: 0, exports: 0, passengers: 0, fees: 0, importQueue: 0, stack: [], taken: new Map(),
      };
      y.b = b; y.p = p; y.dto = dto; y.role = role;
      y.sea = role === 'port' && dto.active && d.lanes.some((l) => l.purpose === 'sea' && !!l.gate);
      yards.set(id, y);
    }
    for (const g of this.w.seaGates) gates.set(`${g.x},${g.y}`, g);
    const keep = new Set(found.map((f) => derivedKey(f.p)));
    for (const k of this.derived.keys()) if (!keep.has(k)) this.derived.delete(k);
    this.yards = yards;
    this.byDoor = new Map([...yards.values()].map((y) => [tkey(y.b.x, y.b.y), y]));
    this.byFront = new Map([...yards.values()].filter((y) => y.sea).map((y) => [tkey(y.p.frontX, y.p.frontY), y]));
    this.exportPts = [...this.byFront.values()].map((y) => [y.p.frontX, y.p.frontY]);
    const json = JSON.stringify([list, [...gates.values()]]);
    if (json === this.listJson) { // the same harbours and lanes: keep the list the schedule has cached
      const same = new Map(this.list.map((h) => [h.id, h]));
      for (const y of yards.values()) y.dto = same.get(y.id) ?? y.dto;
      return;
    }
    this.listJson = json;
    this.list = list;
    this.gates = [...gates.values()];
    this.evCache.clear();
    this.changed = true;
  }

  /** Where a harbour's lanes start: its middle column, the row out where the water is as wide as its widest boats need. */
  fairwayOf(p: Placed): [number, number] {
    const h = HARBOUR_OF[p.kind]!;
    const need = Math.max(h.fairwayClearance, ...harbourLaneSpecs(p.kind).map((s) => WIDTH_CLEARANCE[s.cls]));
    let out: [number, number] | null = null;
    for (let c = need; c >= 1 && !out; c--) {
      const row = fairwayTiles(p, c - 1), t = row[Math.floor(row.length / 2)];
      if (c === 1 || this.grid.clearance(t[0], t[1]) >= c) out = t;
    }
    return out!;
  }

  private derive(p: Placed, id: number): Derived {
    const t0 = performance.now();
    const fairway = this.fairwayOf(p);
    // the side of the fairway tile facing the harbour: boats leave it heading out
    const [bx, by] = footprintTile(p, 0, 0), [fx, fy] = footprintTile(p, 0, -1);
    const entry = SIDES.findIndex(([dx, dy]) => dx === bx - fx && dy === by - fy);
    let gates: SeaGate[] = this.w.seaGates, waterTiles: number | undefined;
    if (!gates.length) {
      const ow = openWater(this.grid, fairway[0], fairway[1]);
      waterTiles = ow.tiles;
      gates = ow.open && ow.offing ? [{ x: ow.offing[0], y: ow.offing[1], name: OFFING_NAME }] : [];
    }
    const r = deriveHarbourLanes(this.grid, { kind: p.kind, fairway, entry, seed: id, gates });
    const refused = r.refused.map((q) => q.reason);
    if (HARBOUR_OF[p.kind]!.role === 'port' && !gates.length && waterTiles !== undefined) refused.unshift(this.lakeReason(waterTiles));
    const d: Derived = { lanes: r.lanes, refused, fairway, gates, waterTiles };
    this.derived.set(derivedKey(p), d);
    this.totals.derivations++; this.totals.deriveMs += performance.now() - t0;
    return d;
  }

  private lakeReason(tiles: number) { return `A cargo port needs open water that reaches the sea: this lake is ${tiles} tiles`; }

  /**
   * Why a structure may not go here (net.ts asks before placing), or null: in a world with no declared sea gates, a
   * cargo port on a lake too small to be open water (docs/boats.md 2.3).
   */
  placeProblem(p: Placed): string | null {
    if (HARBOUR_OF[p.kind]?.role !== 'port' || this.w.seaGates.length) return null;
    const c = HARBOUR_OF[p.kind]!.fairwayClearance, row = fairwayTiles(p, c - 1), [x, y] = row[Math.floor(row.length / 2)];
    const ow = openWater(this.grid, x, y);
    return ow.open ? null : this.lakeReason(ow.tiles);
  }

  // ---- the schedule's events --------------------------------------------------------------------------------------

  private roll(y: Yard) {
    const d = Math.floor(this.now / TICKS_PER_DAY);
    if (y.day === d) return;
    y.day = d; y.landed = 0; y.sold = 0; y.calls = 0; y.imports = 0; y.exports = 0; y.passengers = 0; y.fees = 0; y.landedBy.clear();
    if (y.taken.size > 64) y.taken.clear();
  }

  private event(e: BoatEvent) {
    const v = e.voyage, y = this.yards.get(v.harbour);
    if (!y) return;
    this.roll(y);
    const owner = y.dto.owner;
    if (e.what === 'berthed' && v.kind === 'fishing') {
      const n = catchOf(v);
      y.landed += n; y.stock += n; y.landedBy.set(v.boat, (y.landedBy.get(v.boat) ?? 0) + n);
      this.totals.landed += n;
    } else if (e.what === 'alongside' && v.kind === 'call') {
      const cargo = callCargo(v);
      y.calls++; this.totals.calls++;
      y.imports += cargo.imports; this.totals.imports += cargo.imports;
      y.importQueue = Math.min(IMPORT_MAX, y.importQueue + cargo.imports);
      this.dues(y, owner, cargo.imports);
      if (cargo.passengers) {
        y.passengers += cargo.passengers; this.totals.passengers += cargo.passengers;
        if (y.sea) this.sim?.gateways.shipBerthed(y.b.x, y.b.y, cargo.passengers);
      }
    } else if (e.what === 'castOff' && v.kind === 'call') {
      this.prune(y);
      const n = Math.min(y.stack.length, callCargo(v).exportRoom);
      y.stack.splice(0, n);
      y.exports += n; this.totals.exports += n;
      y.taken.set(v.id, n);
      this.dues(y, owner, n);
    }
  }

  private dues(y: Yard, owner: string | null, boxes: number) {
    if (!owner || !boxes) return;
    this.w.credit(owner, boxes * PORT_DUES, 'fees');
    y.fees += boxes * PORT_DUES; this.totals.dues += boxes * PORT_DUES;
  }

  /** Each staffed marina's owner earns its berth fee for every boat based there, once a game day. */
  private payBerthFees() {
    for (const y of this.yards.values()) {
      const fee = Number(kindManifest(y.p.kind)?.attrs.berthFee ?? 0);
      if (!fee || !y.dto.active || !y.dto.owner) continue;
      this.roll(y);
      const n = harbourFleet(y.dto).length * fee;
      this.w.credit(y.dto.owner, n, 'fees');
      y.fees += n; this.totals.berthFees += n;
    }
  }

  // ---- lorries ----------------------------------------------------------------------------------------------------

  /** One lorry of fish from the quay: to a food venue (most) or a works that processes it. */
  private sellFish(y: Yard) {
    const w = this.w, b = y.b, reach = (t: Building) => w.hasRoadAccess(t.x, t.y);
    const food = () => w.bestBuiltNear(b.x, b.y, [Zone.Commercial], FISH_RADIUS, MAX_SCORE, (c, d) => (c.level > 0 && isFoodVenue(c.id, c.x, c.y) ? c.level * 2 + 3 * Math.random() - d : null), reach);
    const works = () => w.bestBuiltNear(b.x, b.y, [Zone.Industrial], FISH_RADIUS, MAX_SCORE, (c, d) => (c.level > 0 && c.occupants > 0 ? 3 * Math.random() - d : null), reach);
    const t = Math.random() < FISH_FOOD_SHARE ? food() ?? works() : works() ?? food();
    if (!t) return;
    y.stock -= FISH_LORRY; y.sold += FISH_LORRY; this.totals.sold += FISH_LORRY;
    this.sim!.harbourFreight(b, [t.x, t.y], FISH_LORRY * FISH_FEE);
  }

  /** One container off a ship to a shop anywhere in town, as a motorway lorry brings one in. */
  private sendImport(y: Yard) {
    const w = this.w, f = [y.p.frontX, y.p.frontY];
    const t = w.bestBuiltNear(f[0], f[1], [Zone.Commercial], Infinity, MAX_SCORE, (c, d) => c.level * 2 + 6 * Math.random() - d / 4, (c) => w.hasRoadAccess(c.x, c.y));
    if (!t) return;
    y.importQueue--; this.totals.importLorries++;
    this.sim!.harbourFreight(y.b, [t.x, t.y], BOX_FEE);
  }

  /** Drop the export boxes that waited too long for a ship. */
  private prune(y: Yard) {
    const cut = this.w.tick - STACK_TTL;
    let n = 0;
    while (n < y.stack.length && y.stack[n] < cut) n++;
    if (n) y.stack.splice(0, n);
  }

  /** A truck reached the road in front of an open port with an export (Simulation.ports): its box joins the stack. */
  private exported(x: number, y: number): boolean {
    const yd = this.byFront.get(tkey(x, y));
    if (!yd) return false;
    this.prune(yd);
    if (yd.stack.length < STACK_MAX) yd.stack.push(this.w.tick);
    return true;
  }

  // ---- inspection -------------------------------------------------------------------------------------------------

  /** A fishing harbour's crew on its trawler `boat`: the citizens on its payroll the hash puts on that boat. */
  private crewOf(y: Yard, boat: BasedBoat): { id: number; name: string }[] {
    const trawlers = harbourFleet(y.dto).filter((q) => q.type === 'trawler');
    const k = trawlers.findIndex((q) => q.id === boat.id);
    if (k < 0) return [];
    const out: { id: number; name: string }[] = [];
    for (const c of this.w.citizens.values()) {
      if (!c.job || c.wx !== y.b.x || c.wy !== y.b.y) continue;
      if (crewBoat(c.id, trawlers.length) === k) out.push({ id: c.id, name: nameFor(c.id, c.sn) });
    }
    return out;
  }

  /** The boat panel's server half (net.ts 'inspectBoat'). */
  inspectBoat(id: number): BoatInfo | null {
    const now = this.now, v = boatVoyageAt(this.list, id, now), based = basedBoat(this.list, id);
    const y = this.yards.get(v?.harbour ?? based?.harbour ?? -1);
    if (!y) return null;
    this.roll(y);
    const info: BoatInfo = { id, harbour: y.id, harbourName: y.dto.name };
    if (based?.type === 'trawler') { info.crew = this.crewOf(y, based); info.landedToday = y.landedBy.get(id) ?? 0; }
    if (v?.kind === 'call') { const c = callCargo(v); info.cargo = { imports: c.imports, exports: y.taken.get(v.id) ?? 0, passengers: c.passengers }; }
    return info;
  }

  /** A crew member at work while their trawler is out: the citizen panel says "at sea on the Kittiwake". */
  atSea(citizen: number): { boat: number; name: string } | undefined {
    const c = this.w.citizens.get(citizen);
    if (!c?.job || c.state !== CitizenState.Work) return undefined;
    const y = this.byDoor.get(tkey(c.wx, c.wy));
    if (!y || y.role !== 'fishing') return undefined;
    const trawlers = harbourFleet(y.dto).filter((q) => q.type === 'trawler');
    const b = trawlers[crewBoat(c.id, trawlers.length)];
    if (!b || boatVoyageAt(this.list, b.id, this.now)?.kind !== 'fishing') return undefined;
    return { boat: b.id, name: boatName(b.type, b.seed) };
  }

  /** The harbour's tooltip (net.ts inspect). */
  describe(b: Building): HarbourInfo | undefined {
    const y = this.byDoor.get(tkey(b.x, b.y));
    const role = HARBOUR_OF[b.id]?.role;
    if (!role) return undefined;
    if (!y) return { role, active: false, lanes: [], refused: [b.level === 0 ? 'being built' : 'not in service'], boats: 0, away: 0 };
    this.roll(y);
    const d = this.derived.get(derivedKey(y.p));
    const fleet = harbourFleet(y.dto), now = this.now;
    const info: HarbourInfo = {
      role, active: y.dto.active, refused: y.dto.refused ?? [],
      lanes: y.dto.lanes.map((l) => ({ purpose: l.purpose, cls: l.cls, tiles: l.route.sides.length, ...(l.gate ? { gate: l.gate } : {}) })),
      boats: fleet.length, away: fleet.filter((q) => boatVoyageAt(this.list, q.id, now)).length,
    };
    const sea = y.dto.lanes.find((l) => l.gate && (l.purpose === 'sea' || l.purpose === 'grounds'))?.gate;
    if (sea) info.sea = sea;
    if (d?.waterTiles !== undefined && !sea) info.waterTiles = d.waterTiles;
    if (role === 'fishing') Object.assign(info, { landed: y.landed, sold: y.sold, stock: y.stock });
    if (role === 'port') { this.prune(y); Object.assign(info, { calls: y.calls, imports: y.imports, exports: y.exports, importQueue: y.importQueue, exportStack: y.stack.length, passengers: y.passengers, fees: y.fees }); }
    if (role === 'marina') info.fees = y.fees;
    return info;
  }

  /** Today's figures over every harbour (the loadtest prints these). */
  today() {
    const t = { landed: 0, sold: 0, stock: 0, calls: 0, imports: 0, exports: 0, importQueue: 0, exportStack: 0, passengers: 0, fees: 0 };
    for (const y of this.yards.values()) {
      this.roll(y);
      t.landed += y.landed; t.sold += y.sold; t.stock += y.stock; t.calls += y.calls; t.imports += y.imports; t.exports += y.exports;
      t.importQueue += y.importQueue; t.exportStack += y.stack.length; t.passengers += y.passengers; t.fees += y.fees;
    }
    return t;
  }
}

/** Which of a fishing harbour's trawlers a member of its payroll crews, or -1 for a market porter (a hash of their id). */
export function crewBoat(citizen: number, trawlers: number): number {
  if (!trawlers || hash2(citizen, 4111) >= FISH_CREW_SHARE) return -1;
  return Math.floor(hash2(citizen, 4113) * trawlers);
}
