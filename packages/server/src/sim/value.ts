import {
  CHUNK_SIZE, TICKS_PER_DAY, TICKS_PER_HOUR, Zone, CitizenState, VehicleClass, KIND_COUNT, SERVICE_RADIUS_OF, SERVICE_STRENGTH_OF,
  VALUE, ValueKind, VALUE_KINDS, VALUE_KIND_COUNT, VALUE_SLOTS, VALUE_SLOT_VALUE, VALUE_CELL, VALUE_CELLS, VALUE_CELLS_PER_CHUNK,
  AVERAGE_VALUE_WEIGHTS, valueKernels, combineValue, nuisanceShare, valueByte, valueHighlights, industryAttrs, isLandmarkKind,
  isWasteDepot, isPowerPlant, UTIL_POLLUTION_OF, leisureAt, capacityOf, tileKey, isRoad, zoneOf, type Airport, type ValueKernel,
} from '@msimcity/shared';
import type { Building, Mover, World } from '../world';
import { tkey, untkey } from '../world';
import { env } from '../env';

/** VALUE=0 in the environment: the field is still kept (the overlay shows it) but homes and growth ignore it (A/B runs). */
export const VALUE_FIELD = { on: env('VALUE') !== '0' };

/** What the field reads from the rest of the simulation (Simulation wires it; rail and airports are set by game.ts). */
export interface ValueHost {
  /** every mover on the road lanes now */
  eachMover(fn: (m: Mover) => void): void;
  /** routed stop tiles and the lines calling there */
  eachStop(fn: (k: number, lines: number) => void): void;
  /** homes a refuse depot emptied a day */
  handledAt(x: number, y: number): number;
  /** the staffed police, fire and health buildings (Simulation.staffedServices) */
  services(): readonly Building[];
}
export interface ValueRail { eachRunning(fn: (tiles: Set<number>, trains: number) => void): void }
export interface ValueAirports { readonly airports: Airport[] }

const K = VALUE_KIND_COUNT, CPC = VALUE_CELLS_PER_CHUNK, CS = VALUE_CELLS;
const NIGHT = (h: number) => h >= 22 || h < 4;
const ckey = tkey; // chunk and cell coordinates fit the tile key's range
const RUNWAY: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * The neighbourhood value field (docs/multiplayer-land.md section 4, M1). Eleven kinds of nuisance and amenity per
 * 4×4-tile cell, bytes in a per-chunk cache (8×8 cells a chunk, VALUE_SLOTS bytes a cell, the last the published value
 * for the average household). Derived, never saved: a load rebuilds it at the first hourly pass.
 *
 * Once a game hour (`VALUE.phase` ticks into it) the sources are measured (nuisance follows use): workers on shift at
 * each works (smoothed over hours), homes a refuse depot emptied, a plant's staff, traffic sampled on the roads every
 * `VALUE.sampleEvery` ticks (vehicles and lorries per cell), trains running, flights, night crowds at late venues,
 * buildings standing empty; and the amenities: open land and parks, jobs, shops and stops, landmarks, venues and tall
 * neighbours. They go into an emission grid per cell, quantised on a log scale (`VALUE.quantum`, `VALUE.steps`); a chunk is recomputed only when an
 * emission in reach of it changed (or the services moved, or it is new), by splatting each source's spread kernel
 * (shared valueKernels: round, or a plume from the wind rose) clipped to the chunk. Nothing runs per tick per tile.
 * Everything is owner-blind, so a tip on your border spoils your own border as much as your neighbour's.
 */
export class ValueField {
  /** per chunk (ckey): CPC × VALUE_SLOTS bytes */
  private fields = new Map<number, Uint8Array>();
  /** per chunk: emission units per cell and kind, quantised (last hour's) */
  private emitQ = new Map<number, Uint16Array>();
  /** per chunk: share of open tiles per cell (green), recounted when a tile changes */
  private open = new Map<number, Float32Array>();
  private tileDirty = new Set<number>();
  /** smoothed use: workers on shift per workplace, homes per depot, night guests per venue, traffic per cell */
  private staffEma = new Map<number, number>();
  private wasteEma = new Map<number, number>();
  private nightEma = new Map<string, number>();
  private roadEma = new Map<number, Float64Array>();
  private roadAcc = new Map<number, Float64Array>();
  private samples = 0;
  /** hours each building has stood empty */
  private emptyFor = new Map<number, number>();
  private servicesSig = -1;
  private seed: number;
  private kernels: ValueKernel[];
  /** chunks whose bytes changed at the last pass (Net and tests may read it) */
  version = 0;
  rail: ValueRail | null = null;
  airports: ValueAirports | null = null;
  /** the last pass: ms taken, chunks recomputed, sources (cells with any emission) */
  last = { ms: 0, chunks: 0, cells: 0, fields: 0 };
  stats = { passes: 0, ms: 0, chunks: 0 };

  constructor(private w: World, private host: ValueHost) {
    this.seed = w.seed;
    this.kernels = valueKernels(w.seed);
    const prev = w.onTileChanged;
    w.onTileChanged = (x, y) => { prev?.(x, y); this.tileDirty.add(ckey(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE))); };
  }

  tick() {
    const t = this.w.tick;
    if (t % VALUE.sampleEvery === 0) this.sampleRoads();
    if (t % TICKS_PER_HOUR === VALUE.phase) this.refresh();
  }

  // ---- reading ---------------------------------------------------------------------------------------

  /** The bytes of the chunk (cx, cy), or undefined when nothing is computed there. */
  chunkBytes(cx: number, cy: number): Uint8Array | undefined { return this.fields.get(ckey(cx, cy)); }
  /** The cell of tile (x, y): its chunk's bytes and the offset of the cell's first byte, or null. */
  cellAt(x: number, y: number): { b: Uint8Array; off: number } | null {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
    const b = this.fields.get(ckey(cx, cy));
    if (!b) return null;
    const lx = Math.floor((x - cx * CHUNK_SIZE) / VALUE_CELL), ly = Math.floor((y - cy * CHUNK_SIZE) / VALUE_CELL);
    return { b, off: (ly * CS + lx) * VALUE_SLOTS };
  }
  /** One kind's intensity 0-1 at tile (x, y). */
  kindAt(x: number, y: number, k: number): number { const c = this.cellAt(x, y); return c ? c.b[c.off + k] / 255 : 0; }
  /** The value at tile (x, y) for these kind weights (shared valueWeights), the average household's by default; 1 where nothing is near. */
  valueAt(x: number, y: number, weights: ArrayLike<number> = AVERAGE_VALUE_WEIGHTS): number { const c = this.cellAt(x, y); return c ? combineValue(c.b, c.off, weights) : 1; }
  /**
   * Levels the value adds to how tall a neighbourhood grows (Simulation.ambition): -1 where the average household's
   * nuisances leave under VALUE.ambitionDown of the value (never more: the boundary ceiling of section 5), +1 where the
   * value is over VALUE.ambitionUp, else 0.
   */
  ambitionDelta(x: number, y: number): number {
    if (!VALUE_FIELD.on) return 0;
    const c = this.cellAt(x, y);
    if (!c) return 0;
    if (nuisanceShare(c.b, c.off) < VALUE.ambitionDown) return -1;
    return combineValue(c.b, c.off) >= VALUE.ambitionUp ? 1 : 0;
  }
  /** A tooltip's line: the value for the average household and the worst nuisance and best amenity there (percent). */
  describe(x: number, y: number): { value: number; nuisance?: [string, number]; amenity?: [string, number] } | undefined {
    const c = this.cellAt(x, y);
    if (!c) return undefined;
    const h = valueHighlights(c.b, c.off), pct = (v: number) => Math.round((100 * v) / 255);
    return {
      value: Math.round(100 * combineValue(c.b, c.off)) / 100,
      ...(h.nuisance ? { nuisance: [VALUE_KINDS[h.nuisance[0]].name, pct(h.nuisance[1])] as [string, number] } : {}),
      ...(h.amenity ? { amenity: [VALUE_KINDS[h.amenity[0]].name, pct(h.amenity[1])] as [string, number] } : {}),
    };
  }

  // ---- measuring -------------------------------------------------------------------------------------

  private sampleRoads() {
    this.samples++;
    this.host.eachMover((m) => {
      const k = ckey(Math.floor(m.x / VALUE_CELL), Math.floor(m.y / VALUE_CELL));
      let a = this.roadAcc.get(k);
      if (!a) this.roadAcc.set(k, a = new Float64Array(2));
      a[0]++;
      if (m.cls === VehicleClass.Truck || m.cls === VehicleClass.Bus) a[1]++;
    });
  }

  /** The hour's measurements into the smoothed use. */
  private measure() {
    const w = this.w, a = VALUE.smooth, hour = (w.tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
    const night = NIGHT(Math.floor(hour));
    const onShift = new Map<number, number>(), guests = new Map<string, number>();
    for (const c of w.citizens.values()) {
      if (c.state === CitizenState.Work && c.job) { const k = tkey(c.wx, c.wy); onShift.set(k, (onShift.get(k) ?? 0) + 1); }
      else if (night && c.state === CitizenState.AtVenue && c.venue) guests.set(c.venue, (guests.get(c.venue) ?? 0) + 1);
    }
    const ema = <T>(m: Map<T, number>, k: T, x: number) => {
      const v = (m.get(k) ?? 0) * (1 - a) + x * a;
      if (v < 0.01) m.delete(k); else m.set(k, v);
    };
    for (const k of [...this.staffEma.keys()]) if (!onShift.has(k)) ema(this.staffEma, k, 0);
    for (const [k, n] of onShift) ema(this.staffEma, k, n);
    if (night) {
      for (const k of [...this.nightEma.keys()]) if (!guests.has(k)) ema(this.nightEma, k, 0);
      for (const [k, n] of guests) ema(this.nightEma, k, n);
    }
    // traffic: mean vehicles and heavy vehicles in each cell over the hour's samples
    const s = Math.max(1, this.samples);
    for (const [k, e] of this.roadEma) if (!this.roadAcc.has(k)) { e[0] *= 1 - a; e[1] *= 1 - a; if (e[0] < 0.01) this.roadEma.delete(k); }
    for (const [k, acc] of this.roadAcc) {
      let e = this.roadEma.get(k);
      if (!e) this.roadEma.set(k, e = new Float64Array(2));
      e[0] = e[0] * (1 - a) + (acc[0] / s) * a; e[1] = e[1] * (1 - a) + (acc[1] / s) * a;
    }
    this.roadAcc.clear(); this.samples = 0;
  }

  // ---- the emission grid -----------------------------------------------------------------------------

  private emit = new Map<number, Float32Array>();
  private add(x: number, y: number, kind: number, units: number) {
    if (!(units > 0)) return;
    const gx = Math.floor(x / VALUE_CELL), gy = Math.floor(y / VALUE_CELL);
    const cx = Math.floor(gx / CS), cy = Math.floor(gy / CS), k = ckey(cx, cy);
    let e = this.emit.get(k);
    if (!e) this.emit.set(k, e = new Float32Array(CPC * K));
    e[((gy - cy * CS) * CS + (gx - cx * CS)) * K + kind] += units;
  }

  /** Every source's emission this hour (units per cell and kind). */
  private gather(targets: Set<number>) {
    const w = this.w, E = VALUE.emit, emit = this.emit;
    emit.clear();
    for (const b of w.buildings.values()) {
      if (b.level <= 0) continue;
      const key = tkey(b.x, b.y), sk = tileKey(b.x, b.y);
      if (w.mothballed.has(sk)) { this.emptyFor.delete(key); continue; } // mothballed: nothing at all
      const site = w.sites.has(sk);
      // empty and derelict buildings (not sites, not civic: those are the owner's to staff)
      if ((b.zone === Zone.Residential || b.zone === Zone.Commercial || b.zone === Zone.Industrial || b.zone === Zone.Office) && !site && b.occupants === 0) {
        const h = (this.emptyFor.get(key) ?? 0) + 1;
        this.emptyFor.set(key, h);
        if (h >= E.emptyHours) { this.add(b.x, b.y, ValueKind.Disorder, E.emptyDisorder); this.add(b.x, b.y, ValueKind.Eyesore, E.emptyEyesore); }
      } else this.emptyFor.delete(key);
      if (b.zone === Zone.Industrial) {
        if (isWasteDepot(b.id, b.x, b.y)) {
          const v = (this.wasteEma.get(key) ?? 0) * (1 - VALUE.smooth) + this.host.handledAt(b.x, b.y) * VALUE.smooth;
          if (v < 0.05) this.wasteEma.delete(key); else this.wasteEma.set(key, v);
          if (v >= 0.05) {
            this.add(b.x, b.y, ValueKind.Smell, E.wasteSmell * v);
            this.add(b.x, b.y, ValueKind.Traffic, E.wasteTraffic * v);
            this.add(b.x, b.y, ValueKind.Noise, E.wasteNoise * v);
            this.add(b.x, b.y, ValueKind.Eyesore, E.wasteEyesore * Math.min(1, v / E.wasteBusy));
          }
        } else {
          const s = this.staffEma.get(key) ?? 0;
          if (s > 0) {
            const at = industryAttrs(b.id, b.level, b.x, b.y);
            this.add(b.x, b.y, ValueKind.Noise, E.indNoise * s * (1 + at.noise / 5));
            this.add(b.x, b.y, ValueKind.Smell, E.indSmell * s * (1 + at.pollution));
            if (at.hazard) this.add(b.x, b.y, ValueKind.Hazard, E.indHazard * s);
          }
        }
      }
      if (isPowerPlant(b.id)) {
        const cap = capacityOf(b.id, b.level), share = cap > 0 ? Math.min(1, b.occupants / cap) : 0;
        if (share > 0) { this.add(b.x, b.y, ValueKind.Smell, E.plantSmell * UTIL_POLLUTION_OF[b.id] * share); this.add(b.x, b.y, ValueKind.Noise, E.plantNoise * share); }
      }
      // late venues by their night crowds
      const g = this.nightEma.get(sk);
      if (g) { this.add(b.x, b.y, ValueKind.Noise, E.nightNoise * g); this.add(b.x, b.y, ValueKind.Disorder, E.nightDisorder * g); }
      // amenities
      const sp = leisureAt(b.id, b.level, b.x, b.y);
      if (sp?.type === 'park') this.add(b.x, b.y, ValueKind.Green, E.parkGreen * sp.value);
      else if (sp && (sp.type === 'theatre' || sp.type === 'cinema' || sp.type === 'library') && b.occupants > 0) this.add(b.x, b.y, ValueKind.Culture, E.venueCulture);
      if (isLandmarkKind(b.id)) this.add(b.x, b.y, ValueKind.Culture, E.landmark);
      if (b.level > 4) this.add(b.x, b.y, ValueKind.Culture, E.tallCulture * (b.level - 4));
      if (b.zone === Zone.Commercial) this.add(b.x, b.y, ValueKind.Access, E.accessShop + E.accessJob * b.occupants);
      else if (b.zone === Zone.Office || b.zone === Zone.Industrial) this.add(b.x, b.y, ValueKind.Access, E.accessJob * b.occupants);
    }
    for (const k of [...this.emptyFor.keys()]) { const [x, y] = untkey(k); if (!w.buildings.has(tileKey(x, y))) this.emptyFor.delete(k); }
    for (const k of [...this.wasteEma.keys()]) { const [x, y] = untkey(k); if (!w.buildings.has(tileKey(x, y))) this.wasteEma.delete(k); }
    // roads: noise from everything on them, heavy traffic from lorries and buses (cells keyed like chunks)
    for (const [k, e] of this.roadEma) {
      const [gx, gy] = untkey(k), x = gx * VALUE_CELL, y = gy * VALUE_CELL;
      this.add(x, y, ValueKind.Noise, E.roadNoise * e[0] + E.heavyNoise * e[1]);
      this.add(x, y, ValueKind.Traffic, E.heavyTraffic * e[1]);
    }
    this.rail?.eachRunning((tiles, trains) => {
      const u = E.railNoise * Math.min(6, trains);
      for (const k of tiles) { const [x, y] = untkey(k); this.add(x, y, ValueKind.Noise, u); }
    });
    for (const ap of this.airports?.airports ?? []) {
      if (!(ap.flightsPerHour > 0)) continue;
      const [dx, dy] = RUNWAY[ap.dir] ?? [1, 0], half = ap.runwayLen / 2;
      for (const f of [-1, 0, 1]) this.add(ap.x + dx * half * f, ap.y + dy * half * f, ValueKind.Noise, E.airNoise * ap.flightsPerHour);
    }
    this.host.eachStop((k, lines) => { const [x, y] = untkey(k); this.add(x, y, ValueKind.Access, E.accessStop * Math.min(3, lines)); });
    // green from open land, in the target chunks (unbuilt country round the town counts as open)
    for (const t of targets) {
      const o = this.openOf(t), [cx, cy] = untkey(t);
      for (let i = 0; i < CPC; i++) if (o[i] > 0) this.add(cx * CHUNK_SIZE + (i % CS) * VALUE_CELL, cy * CHUNK_SIZE + Math.floor(i / CS) * VALUE_CELL, ValueKind.Green, E.openGreen * o[i]);
    }
  }

  /** Share of each cell's tiles with no building, road or site (water counts): recounted when a tile changed. */
  private openOf(t: number): Float32Array {
    let o = this.open.get(t);
    if (o && !this.tileDirty.has(t)) return o;
    o ??= new Float32Array(CPC);
    const [cx, cy] = untkey(t), ch = this.w.getChunk(cx, cy, false);
    if (!ch) o.fill(1);
    else {
      o.fill(0);
      for (let i = 0; i < ch.tiles.length; i++) {
        const tt = ch.tiles[i];
        if (isRoad(tt) || zoneOf(tt) !== Zone.None || ch.aux[i]) continue;
        const lx = i % CHUNK_SIZE, ly = Math.floor(i / CHUNK_SIZE);
        o[Math.floor(ly / VALUE_CELL) * CS + Math.floor(lx / VALUE_CELL)] += 1 / (VALUE_CELL * VALUE_CELL);
      }
    }
    this.open.set(t, o);
    return o;
  }

  // ---- the hourly pass -------------------------------------------------------------------------------

  /** Measure, gather, and recompute the chunks an emission in reach of changed. Public for tests and probes. */
  refresh() {
    const t0 = performance.now(), w = this.w;
    if (w.seed !== this.seed) { this.seed = w.seed; this.kernels = valueKernels(w.seed); this.fields.clear(); this.emitQ.clear(); }
    this.measure();
    // targets: modified chunks and the ring round them
    const targets = new Set<number>();
    for (const ch of w.chunks.values()) {
      if (!ch.modified) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) targets.add(ckey(ch.cx + dx, ch.cy + dy));
    }
    this.gather(targets);
    this.tileDirty.clear();
    for (const k of [...this.open.keys()]) if (!targets.has(k)) this.open.delete(k);
    // quantise and diff: which emission chunks changed, and how far their changes reach (in cells)
    const q = VALUE.quantum, dirty = new Set<number>();
    const reachOf = (changed: number) => { let r = 0; for (let k = 0; k < K; k++) if (changed & (1 << k)) r = Math.max(r, this.kernels[k].r); return r; };
    const markAround = (ek: number, r: number) => {
      const [ex, ey] = untkey(ek);
      const x0 = Math.floor((ex * CS - r) / CS), x1 = Math.floor((ex * CS + CS - 1 + r) / CS);
      const y0 = Math.floor((ey * CS - r) / CS), y1 = Math.floor((ey * CS + CS - 1 + r) / CS);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const tk = ckey(x, y); if (targets.has(tk)) dirty.add(tk); }
    };
    const nextQ = new Map<number, Uint16Array>();
    let cells = 0;
    for (const [ek, e] of this.emit) {
      const qa = new Uint16Array(CPC * K), old = this.emitQ.get(ek);
      let changed = 0, any = false;
      for (let i = 0; i < qa.length; i++) {
        const v = e[i] > 0 ? Math.min(65535, Math.round(Math.log1p(e[i] / q) * VALUE.steps)) : 0;
        qa[i] = v;
        if (v) any = true;
        if (v !== (old ? old[i] : 0)) changed |= 1 << (i % K);
      }
      if (!any) { if (old) markAround(ek, reachOf((1 << K) - 1)); continue; }
      for (let i = 0; i < CPC; i++) for (let k = 0; k < K; k++) if (qa[i * K + k]) { cells++; break; }
      nextQ.set(ek, qa);
      if (changed) markAround(ek, reachOf(changed));
    }
    for (const ek of this.emitQ.keys()) if (!nextQ.has(ek)) markAround(ek, reachOf((1 << K) - 1));
    this.emitQ = nextQ;
    // services moved: every target; new targets; dropped targets
    let sig = 0;
    for (const s of this.host.services()) sig = (Math.imul(sig, 31) + s.id * 7919 + tkey(s.x, s.y)) | 0;
    if (sig !== this.servicesSig) { this.servicesSig = sig; for (const tk of targets) dirty.add(tk); }
    for (const tk of targets) if (!this.fields.has(tk)) dirty.add(tk);
    for (const tk of [...this.fields.keys()]) if (!targets.has(tk)) { this.fields.delete(tk); this.version++; }
    for (const tk of dirty) this.compute(tk);
    if (dirty.size) this.version++;
    const ms = performance.now() - t0;
    this.last = { ms, chunks: dirty.size, cells, fields: this.fields.size };
    this.stats.passes++; this.stats.ms += ms; this.stats.chunks += dirty.size;
  }

  private sums = new Float64Array(CPC * K);
  /** quantised emission -> units */
  private deq: number[] = [];
  private best = new Float64Array(KIND_COUNT);
  /** One target chunk's bytes from the emission grid and the services. */
  private compute(tk: number) {
    const [tx, ty] = untkey(tk), sums = this.sums, q = VALUE.quantum, deq = this.deq;
    sums.fill(0);
    const gx0 = tx * CS, gy0 = ty * CS;
    for (let k = 0; k < K; k++) {
      const ker = this.kernels[k], R = ker.r, n = 2 * R + 1;
      if (k === ValueKind.Quiet || k === ValueKind.Services) continue;
      const ex0 = Math.floor((gx0 - R) / CS), ex1 = Math.floor((gx0 + CS - 1 + R) / CS);
      const ey0 = Math.floor((gy0 - R) / CS), ey1 = Math.floor((gy0 + CS - 1 + R) / CS);
      for (let ey = ey0; ey <= ey1; ey++) for (let ex = ex0; ex <= ex1; ex++) {
        const e = this.emitQ.get(ckey(ex, ey));
        if (!e) continue;
        for (let i = 0; i < CPC; i++) {
          const v = e[i * K + k];
          if (!v) continue;
          const sx = ex * CS + (i % CS), sy = ey * CS + Math.floor(i / CS), u = deq[v] ?? (deq[v] = q * Math.expm1(v / VALUE.steps));
          const ax = Math.max(gx0, sx - R), bx = Math.min(gx0 + CS - 1, sx + R);
          const ay = Math.max(gy0, sy - R), by = Math.min(gy0 + CS - 1, sy + R);
          for (let y = ay; y <= by; y++) {
            const row = (y - sy + R) * n - sx + R;
            for (let x = ax; x <= bx; x++) { const wt = ker.w[row + x]; if (wt) sums[((y - gy0) * CS + (x - gx0)) * K + k] += u * wt; }
          }
        }
      }
    }
    let out = this.fields.get(tk);
    if (!out) this.fields.set(tk, out = new Uint8Array(CPC * VALUE_SLOTS));
    // services per cell centre: the strongest staffed station of each family whose square reaches it (Simulation.coverage)
    const services = this.host.services(), x0 = tx * CHUNK_SIZE, y0 = ty * CHUNK_SIZE, near: Building[] = [];
    for (const s of services) {
      const r = SERVICE_RADIUS_OF[s.id];
      if (s.x + r >= x0 && s.x - r < x0 + CHUNK_SIZE && s.y + r >= y0 && s.y - r < y0 + CHUNK_SIZE) near.push(s);
    }
    const best = this.best, E = VALUE.emit;
    for (let i = 0; i < CPC; i++) {
      const cx = x0 + (i % CS) * VALUE_CELL + VALUE_CELL / 2, cy = y0 + Math.floor(i / CS) * VALUE_CELL + VALUE_CELL / 2;
      best.fill(0);
      for (const s of near) {
        const r = SERVICE_RADIUS_OF[s.id];
        if (Math.abs(s.x - cx) <= r && Math.abs(s.y - cy) <= r) { const v = SERVICE_STRENGTH_OF[s.id]; if (v > best[s.zone]) best[s.zone] = v; }
      }
      let cover = 0;
      for (let z = 0; z < KIND_COUNT; z++) cover += best[z];
      const o = i * VALUE_SLOTS, s = i * K;
      for (let k = 0; k < K; k++) out[o + k] = Math.round(255 * (1 - Math.exp(-sums[s + k])));
      out[o + ValueKind.Disorder] = Math.round(out[o + ValueKind.Disorder] * (1 - E.policeCut * Math.min(1, best[Zone.Police])));
      out[o + ValueKind.Services] = Math.round(255 * Math.min(1, cover / VALUE.servicesFull));
      out[o + ValueKind.Quiet] = 255 - Math.max(out[o + ValueKind.Noise], out[o + ValueKind.Traffic]);
      out[o + VALUE_SLOT_VALUE] = valueByte(combineValue(out, o));
    }
  }

  /** Drop everything (a test switching worlds); the next pass rebuilds it. */
  clear() { this.fields.clear(); this.emitQ.clear(); this.open.clear(); this.servicesSig = -1; }
  /** Chunks with a field. */
  get size() { return this.fields.size; }
  /** Every chunk with a field and its bytes (tests, probes). */
  entries(): IterableIterator<[number, Uint8Array]> { return this.fields.entries(); }
}

