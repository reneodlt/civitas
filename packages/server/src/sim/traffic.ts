import {
  DRIVE_SPEED, MIN_GAP, LANE_OFFSET, SIDEWALK_OFFSET, VEHICLE_LEN, VEHICLE_WIDTH, TRAFFIC_TUNING as TT,
  VehicleClass, BIKE_CLASS, isRoad, hasFeature, signalTiming, signalPhaseOf, signalArms, signalledArms, type SignalPhase,
  isJunctionAux, isRingAux, isFlyoverAux, islandOf, ringPos, isArmPos, RING_POS, isCrossing, isBridgeAux, isDeck, bridgeStyle, BridgeStyle, basculeBarrierAt,
  CHUNK_SIZE, chunkOf, localIndex, hash2,
  isClassAux, edgeLanes, classDef, carStepOk, isMotorwayAux, isPedestrianAux, oneWayDir, auxDir, isDividedAux,
  groupPhaseOf, groupArms, inGroup, isRingClassAux, isDeckClassAux, deckAxisStep, isMiniAux, CDIRS, pelicanPhase, pelicanReady, implicitPelican,
  slipJunction, groupTiming, groupMain, MINI_AUX, type JunctionGroup,
  StreetRule, ZONE20_SPEED, ZONE20_COST,
} from '@msimcity/shared';
import { DIRS, noteTrail, tkey, type Mover, type World } from '../world';
import { env } from '../env';

// a test server may override TRAFFIC_TUNING for its whole run, as ab.ts --set does offline: TRAFFIC=follow=1,lookAhead=1
for (const kv of (env('TRAFFIC') ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  if (k in TT && Number.isFinite(Number(v))) (TT as Record<string, number>)[k] = Number(v);
}

/**
 * Two-wheelers (fleet.ts BIKE_CLASS: delivery bicycles and mopeds, docs/mobile-jobs.md) ride at the kerb edge of the
 * lane, BIKE_SIDE further out than a car, and filter: in a lane, cars follow cars and bikes follow bikes, and the body
 * guard does not hold a bike and a car in the same lane against each other. Everything else (stop lines, signals, the
 * junction box, crossings, pedestrians) applies to them as to cars.
 */
const isBike = (m: Mover) => m.cls === BIKE_CLASS;
/**
 * A two-wheeler's offset towards the kerb from a car's line, and the width of a bike and its rider: it rides in the
 * strip between a car's side (LANE_OFFSET + half a car, 0.28 from the centre line) and people on the pavement
 * (SIDEWALK_OFFSET less a walker's radius, 0.35), touching neither.
 */
const BIKE_SIDE = 0.125, BIKE_WIDTH = 0.05;
/** body width of a mover, and the guard's margin round a pedestrian (none for a bike, which passes in its own strip) */
const widthOf = (m: Mover) => (isBike(m) ? BIKE_WIDTH : VEHICLE_WIDTH);
const marginOf = (m: Mover) => (isBike(m) ? 0 : GUARD_MARGIN);
/**
 * The nearest mover of the given kind (bike or not) before index i of a lane queue: the one m follows. On a two-lane
 * road (R3 classes) a car follows only cars in its own lane of it (`strand`, Mover.s1); bikes keep to the right-hand one.
 */
function leaderIn(q: Mover[], i: number, bike: boolean, strand = 0): Mover | null {
  for (let j = i - 1; j >= 0; j--) { const o = q[j]; if (isBike(o) === bike && (bike || (o.s1 ?? 0) === strand)) return o; }
  return null;
}

/**
 * Car following (TRAFFIC_TUNING.follow): the fastest a driver may go this tick and still stop, braking at `dec` a tick,
 * within `s` of an obstacle ahead that itself moves at `vl` and can brake as hard: v²/2dec + headway·v ≤ s + vl²/2dec.
 * With headway 0.5 and vl 0 that is exactly a stop braking by dec each tick (s 0.3, dec 0.1: 0.2, then 0.1, then 0).
 */
export function safeSpeed(s: number, vl: number, dec: number): number {
  const se = s + (vl * vl) / (2 * dec), T = TT.headway;
  return se <= 0 ? 0 : dec * (Math.sqrt(T * T + (2 * se) / dec) - T);
}

/**
 * Math.hypot of two numbers, bit for bit: the steps of V8's own (builtins/math.tq: scaled by the larger, Kahan-summed,
 * which for two numbers comes to this) without the builtin call, which costs ~27 ns in Node 20 against ~2 ns. Checked
 * against Math.hypot on 20 million pairs and the edge cases (zeros, infinities, NaN, subnormals): every one the same.
 */
export function hypot(x: number, y: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax !== ax || ay !== ay) return ax === Infinity || ay === Infinity ? Infinity : NaN;
  const max = ay > ax ? ay : ax;
  if (max === Infinity) return Infinity;
  if (max === 0) return 0;
  const n0 = ax / max, n1 = ay / max;
  return Math.sqrt(n0 * n0 + n1 * n1) * max;
}

/** Index into DIRS for the step from a to b (adjacent tiles). */
export function dirBetween(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  return dx > 0 ? 0 : dx < 0 ? 1 : dy > 0 ? 2 : 3;
}
/** DIRS is E, W, S, N. Right-hand turns for right-hand traffic (x east, y south). */
const RIGHT = [2, 3, 1, 0], LEFT = [3, 2, 0, 1], OPP = [1, 0, 3, 2];
const isEW = (d: number) => d < 2;
/**
 * The direction of lane key k (Traffic.laneKey), and the tile key it is on. Lane keys are past 2^31, where `k % 4` costs
 * ~18 ns in Node 20 (a float remainder) against ~1 ns written with floor; the answers are the same.
 */
const laneDir = (k: number) => k - Math.floor(k / 4) * 4;
const laneTile = (k: number) => Math.floor(k / 4);
/** x and y of tile key t (tkey), likewise without `%` */
const tileX = (t: number) => Math.floor(t / 65536) - 0x8000;
const tileY = (t: number) => t - Math.floor(t / 65536) * 65536 - 0x8000;
/** Street rules (R5) that keep a tile's kerb clear of parked cars: double yellows, and a bus lane. */
const NO_KERB = StreetRule.NoParking | StreetRule.BusLane;
/** Fleet vehicle kinds (sim/mobile.ts FLEET_VKIND 32 + FleetKind) that may use a bus lane: taxis and private hire. */
const BUS_LANE_TAXI = 33, BUS_LANE_HIRE = 34;
/**
 * How far back (lane progress, tiles) a car coming along a motorway makes one joining it by a slip road wait, at the
 * pace a motorway had before the cars were fast (1.25 a street's): the gap scales with the class's speed (slipGap), a
 * car at 2.5 covers twice the road in the ticks a merger needs to clear the junction and get up to speed.
 */
const SLIP_GAP = 2;
const SLIP_GAP_SPEED = 1.25;
/**
 * A car whose free pace (before turns) is more than this many tiles a tick (a street's is at most 0.56, a motorway's
 * 0.55 to 1.4) is fast: it may cross more than one tile edge in a tick, so a step carries on into the next lane with
 * what is left of its move (`step`), and it plans its speed along the route ahead (`horizon`), not just for the car
 * in front of it. Streets, avenues and everything else run exactly the single step they always did.
 */
const FAST_PACE = 0.7;
/** The furthest ahead (tiles) a fast car looks along its route: its stopping distance at the top pace is about 6. */
const HORIZON_MAX = 8;
/** what a level crossing adds to a road tile's cost for the router: the expected wait for the barriers */
const CROSSING_DELAY = 1.5;
/** what a bascule bridge's deck tile adds to a road tile's cost while it is lifting (shared/src/bridges.ts) */
const BASCULE_UP_COST = 25;

/**
 * A road tile's congestion state (docs/traffic-tuning.md "Congestion"): moving averages, per tick, of the cars held on
 * the tile (`s`) and of the cars on it (`n`), as of the end of tick `at`. A tick nobody drove on the tile counts as a
 * tick with no cars, so between visits both fall by (1 - EMA_ALPHA) a tick. Runtime state only: never saved.
 */
interface Cong { s: number; n: number; at: number }
/**
 * The router's cost of one chunk's tiles, as dense arrays (docs/search-perf.md): Traffic.cost is called for every tile
 * every A* search looks at. `cong` is congestionAt as it was first read in epoch `at` (a new epoch each tick and after
 * endTick, the only place congestion changes; its decay changes only with the tick); `flags` the parts that change only with the tiles
 * (0: not worked out, else 1 | 2 for a junction of three or more | 4 a level crossing | 8 a bascule deck), cleared by
 * invalidate as the degree and crossing caches are; `kerb` 1 where a car is parked at the kerb, kept by World.kerb.
 */
interface CostChunk { cong: Float64Array; at: Float64Array; flags: Uint8Array; kerb: Uint8Array; base: Float32Array }
const CELLS = CHUNK_SIZE * CHUNK_SIZE;
/**
 * One chunk's lanes and road geometry caches, as dense arrays: `lanes` the queue of each lane (tile index × 4 + direction;
 * the same arrays as Traffic.cells, which keeps them for going through every lane), and the degree, roundabout or flyover
 * byte and crossing caches (degreeOf, junctionAux, isCrossingAt; -1 not worked out, as after invalidate).
 */
interface RoadChunk {
  lanes: (Mover[] | undefined)[]; deg: Int8Array; jaux: Int16Array; xing: Int8Array;
  /** the class byte of each tile (roadclass.ts; 0 a street or any other byte, -1 not worked out), dropped by invalidate */
  caux: Int16Array;
  /** junction control by tile (Traffic.junction), dropped round any road change */
  junc: (Junction | undefined)[];
  /** signal crossings (R4, Traffic.pelicanAt): 1 a crossing, 0 not, -1 not worked out (dropped round road changes and when a road rule changes) */
  pel: Int8Array;
  /** the congestion entries of Traffic.cong by tile (the same objects; cong keeps their order) */
  cong: (Cong | undefined)[];
  /** movers that drove on each tile this tick, and those of them held up (the congestion's inputs, endTick), from tick `presAt` */
  pres: Uint16Array; stop: Uint16Array; presAt: Uint32Array;
  /**
   * pedestrians on each tile's carriageway (Traffic.noteCrossing, CROSS_* masks), two slots a tile: the tick numbered
   * presStamp in slot presStamp & 1, the one before it in the other; `xmAt` says which tick a slot holds
   */
  xm: Uint8Array; xmAt: Uint32Array;
}
interface Junction {
  signal: boolean; ver: number; deg: number; pid: number; offset: number; period: number; act?: Actuation;
  /** the main road's axis (Traffic.mainAxis) and the tick it was worked out */
  main?: number; mainAt?: number;
  /**
   * R4: the junction group this tile is part of when it is more than one tile (an avenue crossing,
   * shared/src/signals.ts junctionGroup): its lights are one controller timed from the anchor (`offset`, `period` are
   * the anchor's) running `phases` 2 or 4, and `ctl` is the anchor's own Junction (actuation state lives there once).
   */
  g?: JunctionGroup; phases?: number; ctl?: Junction;
}
/** Vehicles no longer than this may wait in a divided road's median box (a car or a bike; vans, lorries and buses not). */
const MEDIAN_LEN = 0.36;
/** Lane progress at which a car waits in the median box: centred on the edge between the two carriageways' tiles. */
const MEDIAN_PROG = 0.5;
/** Ticks a junction's main road (Traffic.mainAxis) is kept before it is worked out again (roads further along may change). */
const MAIN_TTL = 500;
/** Actuated signal state: the axis on green, when that green began and when it is due to end. */
interface Actuation { green: 'ns' | 'ew'; start: number; end: number; decided: boolean; at: number }
/** Running totals for the A/B harness and diagnostics (read-only outside Traffic; see Traffic.counters). */
export interface TrafficCounters {
  /** cars pushed into a lane leaving a junction tile (3+ road neighbours) */
  junctionEntries: number;
  /** citizens sent home by the stuck rule (the old give-up), vehicles removed by it */
  stuckHome: number; stuckDespawn: number;
  /** trips abandoned after the long wait: car left at the kerb and the driver walked on / vehicle removed clear of any box */
  abandonKerb: number; abandonDespawn: number;
  /** cars that never got out of the garage (not on the road, so never visible) */
  garageGiveUp: number;
  /** re-routes: the usual congestion re-route, and the forced one at the stuck limit */
  reroutes: number; stuckReroutes: number;
  /** a car went in while pedestrians were on its crossing (CAR_YIELD_MAX ran out); a pedestrian stepped out with a car in the box */
  carNosed: number; pedForced: number;
  /** body guard: car moves cut short by a pedestrian in the way; pedestrian steps held by a car body; pedestrians who walked on after guardWaitMax */
  guardCar: number; guardPed: number; guardPedGaveUp: number;
  /** of the give-ups above, those that removed a car from inside a junction box */
  stuckInBox: number;
  /** pedestrian steps back toward the kerb from a crossing held by a car body (pedRetreatAfter) */
  pedRetreat: number;
}
/** Pedestrian body radius and the clearance the body guard keeps on top of it. */
const PED_R = 0.07, GUARD_MARGIN = 0.03;
interface Obb { x: number; y: number; hx: number; hy: number; len: number }
/** Separating-axis test for two car bodies (length × VEHICLE_WIDTH rectangles), each grown by `pad`. */
function obbOverlap(a: Obb, b: Obb, pad: number): boolean {
  const W2 = VEHICLE_WIDTH / 2 + pad;
  return !obbApart(a, b, pad, W2, a.hx, a.hy) && !obbApart(a, b, pad, W2, -a.hy, a.hx) && !obbApart(a, b, pad, W2, b.hx, b.hy) && !obbApart(a, b, pad, W2, -b.hy, b.hx);
}
/** Does axis (nx, ny) separate the two bodies (obbOverlap)? */
function obbApart(a: Obb, b: Obb, pad: number, W2: number, nx: number, ny: number): boolean {
  const ra = (a.len / 2 + pad) * Math.abs(a.hx * nx + a.hy * ny) + W2 * Math.abs(-a.hy * nx + a.hx * ny);
  const rb = (b.len / 2 + pad) * Math.abs(b.hx * nx + b.hy * ny) + W2 * Math.abs(-b.hy * nx + b.hx * ny);
  return Math.abs((b.x - a.x) * nx + (b.y - a.y) * ny) > ra + rb;
}
/**
 * Movers by the tile they are on, refilled every tick (the body guard's car grid and the walkers): per chunk a list per
 * tile and the fill each list belongs to, so emptying is a new fill number and a lookup is a chunk and two array reads.
 */
class TileLists {
  private chunks = new Map<number, TileChunk>();
  private fill = 1;
  private lastCx = NaN; private lastCy = NaN; private last: TileChunk | undefined;
  clear() { this.fill++; }
  add(x: number, y: number, m: Mover) {
    let c = this.chunk(x, y);
    if (!c) { c = { fill: new Uint32Array(CELLS), lists: new Array(CELLS) }; this.chunks.set(tkey(chunkOf(x), chunkOf(y)), c); this.last = c; }
    const i = localIndex(x, y);
    if (c.fill[i] !== this.fill) { c.fill[i] = this.fill; c.lists[i] = [m]; } // a new list: cheaper than emptying the old one (length = 0)
    else c.lists[i].push(m);
  }
  /** the movers on tile (x, y) since the last clear, if any */
  get(x: number, y: number): Mover[] | undefined {
    const c = this.chunk(x, y);
    if (!c) return undefined;
    const i = localIndex(x, y);
    return c.fill[i] === this.fill ? c.lists[i] : undefined;
  }
  /** The lists of the 3×3 tiles round (tx, ty) with anyone on them since the last clear, row by row, into `out`: how many. */
  near(tx: number, ty: number, out: Mover[][]): number {
    let n = 0;
    const lx = tx - Math.floor(tx / CHUNK_SIZE) * CHUNK_SIZE, ly = ty - Math.floor(ty / CHUNK_SIZE) * CHUNK_SIZE;
    if (lx >= 1 && lx <= CHUNK_SIZE - 2 && ly >= 1 && ly <= CHUNK_SIZE - 2) {
      const c = this.chunk(tx, ty);
      if (!c) return 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const i = (ly + dy) * CHUNK_SIZE + lx + dx; if (c.fill[i] === this.fill) out[n++] = c.lists[i]; }
      return n;
    }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const l = this.get(tx + dx, ty + dy); if (l) out[n++] = l; }
    return n;
  }
  private chunk(x: number, y: number): TileChunk | undefined {
    const cx = chunkOf(x), cy = chunkOf(y);
    if (cx !== this.lastCx || cy !== this.lastCy) { this.last = this.chunks.get(tkey(cx, cy)); this.lastCx = cx; this.lastCy = cy; }
    return this.last;
  }
}
interface TileChunk { fill: Uint32Array; lists: Mover[][] }
/**
 * A walker's route. `cross[i]` is the tile key when the segment ending at
 * point i is on that tile's carriageway (0 otherwise); `xdir[i]` is, for the
 * first point of each crossing, the walker's heading (a DIRS index) as they
 * step off the kerb, plus 4 when the crossing cuts across the junction box
 * (left turns, diagonal kerb-to-kerb steps) rather than straight over one road.
 */
export interface Polyline { pts: number[]; cross: number[]; node: number[]; xdir: number[] }

/** Which carriageways a crossing is on, as a mask: 1 = a north-south road, 2 = an east-west road. */
export const CROSS_NS_ROAD = 1, CROSS_EW_ROAD = 2;
/** The carriageways (CROSS_* mask) a car moving inD -> outD through a box drives over. */
export function movementMask(inD: number, outD: number): number {
  return (isEW(inD) || isEW(outD) ? CROSS_EW_ROAD : 0) | (!isEW(inD) || !isEW(outD) ? CROSS_NS_ROAD : 0);
}
/** The crossing mask for a crossing step with heading code `xd` (see Polyline.xdir). */
export function crossMask(xd: number): number {
  if (xd < 0 || xd >= 4) return CROSS_NS_ROAD | CROSS_EW_ROAD;
  return isEW(xd) ? CROSS_NS_ROAD : CROSS_EW_ROAD; // walking east-west takes you over the north-south road
}

/**
 * The congestion averages' weight on each tick (docs/traffic-tuning.md "Congestion"): about a 33-tick memory, a signal
 * cycle of two phases, so a queue that moves off on each green reads as the jam it is instead of swinging with the lights.
 */
const EMA_ALPHA = 0.03;
/**
 * Cars a tick at which a tile counts as full: a queue spaced a car a tile, creeping forward, has about 0.85. With fewer,
 * the held cars weigh as a share of this many, so a lone car held at a red light reads about 0.35-0.5 at most and fades.
 */
const CONG_FULL = 0.75;
/** The fraction left of a tile's congestion averages `gap` ticks after the last tick they took in (empty ticks count as zero). */
const congFade = (gap: number) => (gap <= 0 ? 1 : Math.pow(1 - EMA_ALPHA, gap));
const STOP_MARGIN = 0.03;
/**
 * The longest vehicle that, waiting at the stop line of a junction straight after a level crossing (its nose
 * STOP_MARGIN short of the junction), stands clear of a passing train: its tail must stay outside the train's half
 * width (0.105) of the crossing's middle, with a little to spare. Cars are; vans, trucks and buses are not.
 */
const XING_SHORT = 0.5 - STOP_MARGIN - 0.105 - 0.02;
/** Lane progress past the stop's road-tile centre where a bus halts at a stop (sim/transit.ts HALT_PROG). */
const HALT_AT = 0.04;
/**
 * Where a bus halts when the stop's road tile is where it turns round (a stop at a dead end): not in the middle of the
 * three-point turn, across the road, but once it has turned, straight in the other lane (KTURN's last straight), so it
 * serves the stop as it finishes the turn.
 */
const HALT_TURNED = 0.46;

/**
 * Turning round inside one tile (a bus at the end of its line, sim/busroute.ts): a three-point turn in the lane's
 * frame, u along the way in from the tile's entry edge, w to the left of it. Forward and left from the right-hand lane
 * across to the far kerb, back a little while still turning, then forward and left again into the other lane and out
 * by the edge it came in at. Sampled once by arc length; `rev0`..`rev1` is the stretch driven backwards.
 */
const KTURN = (() => {
  const o = LANE_OFFSET, u: number[] = [], w: number[] = [], rev: boolean[] = [];
  const u0 = 0.25, R1 = 0.3, R2 = 0.25, f1 = (100 * Math.PI) / 180, f2 = (140 * Math.PI) / 180, N = 24;
  const add = (a: number, b: number, back: boolean) => { u.push(a); w.push(b); rev.push(back); };
  for (let i = 0; i <= N; i++) add((u0 * i) / N, -o, false);
  for (let i = 1; i <= N; i++) { const f = (f1 * i) / N; add(u0 + R1 * Math.sin(f), -o + R1 * (1 - Math.cos(f)), false); }
  const u1 = u[u.length - 1], w1 = w[w.length - 1];
  for (let i = 1; i <= N; i++) { const f = f1 + ((f2 - f1) * i) / N; add(u1 + R2 * (Math.sin(f1) - Math.sin(f)), w1 + R2 * (Math.cos(f) - Math.cos(f1)), true); }
  const u2 = u[u.length - 1], w2 = w[w.length - 1], R3 = (o - w2) / (1 + Math.cos(f2));
  for (let i = 1; i <= N; i++) { const f = f2 + ((Math.PI - f2) * i) / N; add(u2 + R3 * (Math.sin(f) - Math.sin(f2)), w2 + R3 * (Math.cos(f2) - Math.cos(f)), false); }
  const u3 = u[u.length - 1];
  for (let i = 1; i <= N; i++) add(u3 * (1 - i / N), o, false);
  const s = [0];
  for (let i = 1; i < u.length; i++) s.push(s[i - 1] + hypot(u[i] - u[i - 1], w[i] - w[i - 1]));
  const len = s[s.length - 1];
  for (let i = 0; i < s.length; i++) s[i] /= len;
  const rev0 = s[rev.indexOf(true) - 1], rev1 = s[rev.lastIndexOf(true)];
  return { u, w, s, len, rev0, rev1 };
})();
/** Speed factor through a three-point turn (on top of the junction turn factor): the time it takes to turn round. */
const UTURN_SLOW = 0.5;
/** A turn round at s (0..1): the lane's three-point turn, or a plain U for another offset (o: right of the way in). */
function uturnPoint(s: number, o: number, out: [number, number]): [number, number] {
  if (o !== LANE_OFFSET) {
    const L = 1 + Math.PI * o, d = s * L; // in to the middle, half round it, back out
    if (d < 0.5) { out[0] = d; out[1] = -o; } else if (d > L - 0.5) { out[0] = L - d; out[1] = o; } else { const a = ((d - 0.5) / (Math.PI * o)) * Math.PI; out[0] = 0.5 + o * Math.sin(a); out[1] = -o * Math.cos(a); }
    return out;
  }
  const S = KTURN.s;
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const t = S[hi] > S[lo] ? Math.min(1, Math.max(0, (s - S[lo]) / (S[hi] - S[lo]))) : 0;
  out[0] = KTURN.u[lo] + (KTURN.u[hi] - KTURN.u[lo]) * t;
  out[1] = KTURN.w[lo] + (KTURN.w[hi] - KTURN.w[lo]) * t;
  return out;
}

/**
 * Point `s` (0..1) along the path a mover takes through tile (tx,ty) when it
 * arrives heading `inD` and leaves heading `outD`, keeping `o` to the right of
 * the centreline. Straight across, or a quarter arc: tight around the near
 * corner for a right turn, wide around the far corner for a left turn; back
 * out the way it came, a three-point turn (uturnPoint). `o2`, when it differs
 * from `o`, is the offset it leaves by (a lane change on a multi-lane road, R3):
 * the offset eases from one to the other across the tile (smoothstep, so the
 * heading at both edges is the lane's own), round the corner on a turn.
 */
export function pathPoint(tx: number, ty: number, inD: number, outD: number, s: number, o: number, out: [number, number], o2 = o): [number, number] {
  const cx = tx + 0.5, cy = ty + 0.5;
  const ix = DIRS[inD][0], iy = DIRS[inD][1];
  const rx = -iy, ry = ix; // right of the incoming direction
  if (outD === OPP[inD]) {
    uturnPoint(s, o, out);
    const u = out[0], w = out[1]; // w is to the left: -right
    out[0] = cx - 0.5 * ix + u * ix - w * rx;
    out[1] = cy - 0.5 * iy + u * iy - w * ry;
    return out;
  }
  if (o2 !== o) o += (o2 - o) * s * s * (3 - 2 * s);
  if (outD === inD) {
    out[0] = cx - 0.5 * ix + o * rx + ix * s;
    out[1] = cy - 0.5 * iy + o * ry + iy * s;
    return out;
  }
  const th = s * Math.PI / 2, c = Math.cos(th), sn = Math.sin(th);
  if (outD === RIGHT[inD]) {
    const r = 0.5 - o, kx = cx - 0.5 * ix + 0.5 * rx, ky = cy - 0.5 * iy + 0.5 * ry;
    out[0] = kx + r * (-c * rx + sn * ix); out[1] = ky + r * (-c * ry + sn * iy);
  } else {
    const r = 0.5 + o, kx = cx - 0.5 * ix - 0.5 * rx, ky = cy - 0.5 * iy - 0.5 * ry;
    out[0] = kx + r * (c * rx + sn * ix); out[1] = ky + r * (c * ry + sn * iy);
  }
  return out;
}
/**
 * A lane's offset right of the centre line: strand 0 (the right-hand lane, where a single-lane road's one is) at
 * LANE_OFFSET, strand 1 (the left lane of a one-way tile, roadclass.ts) as far left of it.
 */
export const strandOffset = (k: number) => (k ? -LANE_OFFSET : LANE_OFFSET);

/**
 * Which movements through one tile cannot share the box. Same approach, same
 * exit is plain following (handled by the gap rule); same approach but a
 * different exit still conflicts, because the turning car slows in front of
 * the other. Everything else is decided by whether the two paths come within
 * a car's width of each other anywhere inside the tile.
 */
const CONFLICT: boolean[] = new Array(256).fill(false);
(() => {
  const a: [number, number] = [0, 0], b: [number, number] = [0, 0];
  const samples = (inD: number, outD: number) => {
    const out: [number, number][] = [];
    for (let s = 0.04; s < 1; s += 0.08) { pathPoint(0, 0, inD, outD, s, LANE_OFFSET, a); out.push([a[0], a[1]]); }
    return out;
  };
  for (let i1 = 0; i1 < 4; i1++) for (let o1 = 0; o1 < 4; o1++) for (let i2 = 0; i2 < 4; i2++) for (let o2 = 0; o2 < 4; o2++) {
    const idx = ((i1 * 4 + o1) * 4 + i2) * 4 + o2;
    // a vehicle turning round sweeps the whole box: it shares it with nobody but one following it round
    if (o1 === OPP[i1] || o2 === OPP[i2]) { CONFLICT[idx] = !(i1 === i2 && o1 === o2); continue; }
    if (i1 === i2) { CONFLICT[idx] = o1 !== o2; continue; }
    const p1 = samples(i1, o1), p2 = samples(i2, o2);
    let hit = false;
    for (const q of p1) { for (const r of p2) { b[0] = q[0] - r[0]; b[1] = q[1] - r[1]; if (b[0] * b[0] + b[1] * b[1] < (VEHICLE_WIDTH + 0.1) ** 2) { hit = true; break; } } if (hit) break; }
    CONFLICT[idx] = hit;
  }
})();
const conflicts = (i1: number, o1: number, i2: number, o2: number) => CONFLICT[((i1 * 4 + o1) * 4 + i2) * 4 + o2];
/**
 * For each movement pair, the furthest point (path parameter s, 0..1 through the tile) of the second movement
 * that still comes within a car's width of the first one's path; -1 when they never do. A car in the box whose
 * rear is past that point no longer stands in the way (TRAFFIC_TUNING.conflictRemaining).
 */
const CONFLICT_LAST = new Float32Array(256).fill(-1);
/** Clearance between centrelines (beyond a car's width) that still counts as in the way, for the rest of a path. */
const CONFLICT_LAST_MARGIN = Number(env('CONFLICT_LAST_MARGIN') ?? 0.04);
/** Path length per unit of s for a movement (straight 1, right-turn arc shorter, left-turn arc longer), in the right-hand lane. */
const ARC = (inD: number, outD: number) => (outD === inD ? 1 : outD === OPP[inD] ? KTURN.len : outD === RIGHT[inD] ? (Math.PI / 2) * (0.5 - LANE_OFFSET) : (Math.PI / 2) * (0.5 + LANE_OFFSET));
/** ARC for a movement in by lane (strand) a and out by lane b: a turn's arc is as long as its mean radius makes it. */
const ARC_S = (inD: number, outD: number, a: number, b: number) => (!(a | b) || outD === inD || outD === OPP[inD] ? ARC(inD, outD) : (Math.PI / 2) * (0.5 + (outD === RIGHT[inD] ? -1 : 1) * (strandOffset(a) + strandOffset(b)) / 2));
(() => {
  const a: [number, number] = [0, 0], b: [number, number] = [0, 0];
  const thr = (VEHICLE_WIDTH + CONFLICT_LAST_MARGIN) ** 2;
  for (let i1 = 0; i1 < 4; i1++) for (let o1 = 0; o1 < 4; o1++) for (let i2 = 0; i2 < 4; i2++) for (let o2 = 0; o2 < 4; o2++) {
    const idx = ((i1 * 4 + o1) * 4 + i2) * 4 + o2;
    if (o1 === OPP[i1] || o2 === OPP[i2]) { CONFLICT_LAST[idx] = 1; continue; } // turning round: in the way until out of the box
    let last = -1;
    for (let s2 = 0; s2 <= 1.0001; s2 += 0.02) {
      pathPoint(0, 0, i2, o2, s2, LANE_OFFSET, b);
      for (let s1 = 0; s1 <= 1.0001; s1 += 0.02) {
        pathPoint(0, 0, i1, o1, s1, LANE_OFFSET, a);
        if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < thr) { last = s2; break; }
      }
    }
    CONFLICT_LAST[idx] = last;
  }
})();
/** The movement conflict table (approach/exit pairs that cannot share a box), for diagnostics. */
export const conflictsFor = conflicts;

/**
 * The same tables for movements on multi-lane roads (R3 classes): each movement also has the lane it comes in by and
 * the lane it leaves by (strands, strandOffset). Index `movement pair × 16 + sIn1 << 3 | sOut1 << 2 | sIn2 << 1 | sOut2`;
 * with every strand 0 the entry is CONFLICT's and CONFLICT_LAST's own, so plain roads read the tables they always did.
 * The rest are worked out the first time they are asked for (0xff and NaN: not yet). Two movements that come in by the
 * same lane follow the old rule (a different exit, or a different lane out, conflicts: the one ahead slows in front of
 * the other); two side by side, or from different approaches, conflict where their paths come within a car's width.
 */
const CONFLICT_S = new Uint8Array(4096).fill(0xff);
const CONFLICT_LAST_S = new Float32Array(4096).fill(NaN);
for (let i = 0; i < 256; i++) { CONFLICT_S[i * 16] = CONFLICT[i] ? 1 : 0; CONFLICT_LAST_S[i * 16] = CONFLICT_LAST[i]; }
function strandConflict(idx: number): number {
  const m = idx >> 4, sb = idx & 15;
  const i1 = m >> 6, o1 = (m >> 4) & 3, i2 = (m >> 2) & 3, o2 = m & 3;
  const a1 = strandOffset((sb >> 3) & 1), b1 = strandOffset((sb >> 2) & 1), a2 = strandOffset((sb >> 1) & 1), b2 = strandOffset(sb & 1);
  if (o1 === OPP[i1] || o2 === OPP[i2]) return !(i1 === i2 && o1 === o2 && sb >> 2 === (sb & 3)) ? 1 : 0;
  if (i1 === i2 && a1 === a2) return o1 !== o2 || b1 !== b2 ? 1 : 0;
  const p: [number, number] = [0, 0], q: [number, number] = [0, 0], thr = (VEHICLE_WIDTH + 0.1) ** 2;
  for (let s1 = 0.04; s1 < 1; s1 += 0.08) {
    pathPoint(0, 0, i1, o1, s1, a1, p, b1);
    for (let s2 = 0.04; s2 < 1; s2 += 0.08) { pathPoint(0, 0, i2, o2, s2, a2, q, b2); if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < thr) return 1; }
  }
  return 0;
}
function strandConflictLast(idx: number): number {
  const m = idx >> 4, sb = idx & 15;
  const i1 = m >> 6, o1 = (m >> 4) & 3, i2 = (m >> 2) & 3, o2 = m & 3;
  if (o1 === OPP[i1] || o2 === OPP[i2]) return 1;
  const a1 = strandOffset((sb >> 3) & 1), b1 = strandOffset((sb >> 2) & 1), a2 = strandOffset((sb >> 1) & 1), b2 = strandOffset(sb & 1);
  const a: [number, number] = [0, 0], b: [number, number] = [0, 0], thr = (VEHICLE_WIDTH + CONFLICT_LAST_MARGIN) ** 2;
  let last = -1;
  for (let s2 = 0; s2 <= 1.0001; s2 += 0.02) {
    pathPoint(0, 0, i2, o2, s2, a2, b, b2);
    for (let s1 = 0; s1 <= 1.0001; s1 += 0.02) {
      pathPoint(0, 0, i1, o1, s1, a1, a, b1);
      if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < thr) { last = s2; break; }
    }
  }
  return last;
}
/** conflicts() for movements with their lanes in and out (strands); all strands 0 is conflicts() itself. */
function conflictsS(i1: number, o1: number, a1: number, b1: number, i2: number, o2: number, a2: number, b2: number): boolean {
  const idx = (((i1 * 4 + o1) * 4 + i2) * 4 + o2) * 16 + ((a1 << 3) | (b1 << 2) | (a2 << 1) | b2);
  let v = CONFLICT_S[idx];
  if (v === 0xff) v = CONFLICT_S[idx] = strandConflict(idx);
  return v === 1;
}
/** CONFLICT_LAST for movements with their strands. */
function conflictLastS(i1: number, o1: number, a1: number, b1: number, i2: number, o2: number, a2: number, b2: number): number {
  const idx = (((i1 * 4 + o1) * 4 + i2) * 4 + o2) * 16 + ((a1 << 3) | (b1 << 2) | (a2 << 1) | b2);
  let v = CONFLICT_LAST_S[idx];
  if (v !== v) v = CONFLICT_LAST_S[idx] = strandConflictLast(idx);
  return v;
}
export const conflictsForStrands = conflictsS;

/**
 * Road traffic. Every road tile has one lane per direction; a lane is a FIFO
 * of movers heading from the tile's centre to the next tile's centre, with
 * positions worked out from real lane geometry (right-hand lanes, turn arcs).
 * Drivers follow the car ahead bumper to bumper plus a personal gap, stop at
 * the edge of the next tile until they may enter it (room beyond the box, no
 * conflicting movement already in it, no pedestrian on the crossing, a green
 * light where there are signals), and never overtake. Per tile, how held up
 * its cars are (congestionAt: the share of them held, over the last few dozen
 * ticks) is used for routing, the heat overlay and tooltips.
 */
export class Traffic {
  private cells = new Map<number, Mover[]>();
  private cong = new Map<number, Cong>();
  /** lanes and road geometry caches by chunk (RoadChunk), and the last one looked up */
  private roads = new Map<number, RoadChunk>();
  private lastRx = NaN; private lastRy = NaN; private lastRoad: RoadChunk | undefined;
  /** barrier state per crossing for the tick under way */
  private bars = new Map<number, boolean>();
  private barsTick = -1;
  /**
   * Level-crossing barriers (set by game.ts from sim/rail.ts): are the barriers of the crossing (x, y) down now? Null
   * (no rail) leaves every crossing open.
   */
  barrier: ((x: number, y: number) => boolean) | null = null;
  /** pedestrians on the carriageway, by tile: last tick's picture (read) and this tick's (written) */
  // (RoadChunk.xm: CROSS_* masks by tile for this tick and the one before, in slots by the tick's presStamp)
  private phase: SignalPhase = { green: 'ns', amber: false };
  /**
   * scratch for the tick under way: the tiles driven on (the start tile of each step's lane), in the order first driven
   * on, with the RoadChunk and index holding their counts (RoadChunk.pres, .stop, stamped `presAt`)
   */
  private presKeys: number[] = []; private presRc: RoadChunk[] = []; private presIdx: number[] = []; private presStamp = 1;
  vehicles = 0; queued = 0; private speedSum = 0;
  lastVehicles = 0; lastQueued = 0; lastSpeedPct = 1;
  /** tiles whose congestion changed since the last traffic broadcast */
  dirty = new Set<number>();
  private tmp: [number, number] = [0, 0];
  private cnt: TrafficCounters = { junctionEntries: 0, stuckHome: 0, stuckDespawn: 0, abandonKerb: 0, abandonDespawn: 0, garageGiveUp: 0, reroutes: 0, stuckReroutes: 0, carNosed: 0, pedForced: 0, guardCar: 0, guardPed: 0, guardPedGaveUp: 0, stuckInBox: 0, pedRetreat: 0 };
  /** walkers by the tile they were on when they last moved: last tick's and this tick's (positions are read live) */
  private walkPrev = new TileLists();
  private walkCur = new TileLists();
  /** Running totals since the world was loaded (read-only view). */
  get counters(): Readonly<TrafficCounters> { return this.cnt; }
  /** Bump one counter (the simulation reports give-ups and re-routes here). */
  count(k: keyof TrafficCounters, n = 1) { this.cnt[k] += n; }

  constructor(private w: World) {
    w.onTileChanged = (x, y) => this.invalidate(x, y);
    // main-road priority (TRAFFIC_TUNING.mainRoad) by road class: a bigger road's arms are the main road (roadclass.ts rank)
    this.roadRank = (x, y) => (this.isRoadAt(x, y) ? classDef(this.classAux(x, y) & 7).rank : -1);
    w.kerb.onSet = (k, n) => { const c = this.costChunkOfKey(k); if (c) c.kerb[this.costCell] = n > 0 ? 1 : 0; };
    // a street rule (R5) changes a tile's route cost (a 20 zone) and whether a car may park at its kerb
    w.onStreetRules = (tiles) => { for (const [x, y] of tiles) this.dropCostFlags(x, y); };
  }

  static laneKey(x: number, y: number, dir: number) { return tkey(x, y) * 4 + dir; }
  /** The RoadChunk of tile (x, y), made if there is none yet. */
  private roadChunk(x: number, y: number): RoadChunk {
    let rc = this.roadChunkIf(x, y);
    if (!rc) {
      rc = {
        lanes: new Array(CELLS * 4), deg: new Int8Array(CELLS).fill(-1), jaux: new Int16Array(CELLS).fill(-1), xing: new Int8Array(CELLS).fill(-1), caux: new Int16Array(CELLS).fill(-1),
        junc: new Array(CELLS), pel: new Int8Array(CELLS).fill(-1), cong: new Array(CELLS), pres: new Uint16Array(CELLS), stop: new Uint16Array(CELLS), presAt: new Uint32Array(CELLS),
        xm: new Uint8Array(CELLS * 2), xmAt: new Uint32Array(CELLS * 2),
      };
      this.roads.set((chunkOf(x) + 0x800) * 0x1000 + chunkOf(y) + 0x800, rc);
      this.lastRoad = rc;
    }
    return rc;
  }
  private roadChunkIf(x: number, y: number): RoadChunk | undefined {
    const cx = chunkOf(x), cy = chunkOf(y);
    if (cx !== this.lastRx || cy !== this.lastRy) { this.lastRoad = this.roads.get((cx + 0x800) * 0x1000 + cy + 0x800); this.lastRx = cx; this.lastRy = cy; }
    return this.lastRoad;
  }

  beginTick() {
    this.presKeys.length = 0; this.presRc.length = 0; this.presIdx.length = 0; this.presStamp++;
    this.vehicles = 0; this.queued = 0; this.speedSum = 0;
    const wt = this.walkPrev; this.walkPrev = this.walkCur; this.walkCur = wt; this.walkCur.clear();
    if (TT.bodyGuard || TT.carGuard) {
      // cars by the tile they are on at the start of the tick, for the body guard (a car moves at most half a tile a tick)
      const g = this.carGrid;
      g.clear();
      for (const q of this.cells.values()) for (const m of q) g.add(Math.floor(m.x), Math.floor(m.y), m);
    }
  }
  private carGrid = new TileLists();
  endTick() {
    const tick = this.w.tick;
    for (let j = 0; j < this.presKeys.length; j++) {
      // congestion is how held up the tile's cars are: the held share of them, with fewer than CONG_FULL cars a tick
      // weighing as a share of that
      const k = this.presKeys[j], rc = this.presRc[j], n = rc.pres[this.presIdx[j]], st = rc.stop[this.presIdx[j]];
      const c = rc.cong[this.presIdx[j]];
      if (c) {
        const f = congFade(tick - c.at - 1);
        c.s = c.s * f + (st - c.s * f) * EMA_ALPHA; c.n = c.n * f + (n - c.n * f) * EMA_ALPHA; c.at = tick;
      } else { const nc = { s: st * EMA_ALPHA, n: n * EMA_ALPHA, at: tick }; this.cong.set(k, nc); rc.cong[this.presIdx[j]] = nc; }
      this.dirty.add(k);
    }
    this.congEpoch++; // the router's cached congestion is stale now
    this.lastVehicles = this.vehicles; this.lastQueued = this.queued;
    this.lastSpeedPct = this.vehicles ? this.speedSum / this.vehicles : 1;
  }

  // ---- congestion -------------------------------------------------------------

  /**
   * How held up the cars on road tile (x, y) are, 0..1 (docs/traffic-tuning.md "Congestion"): of the cars on it over
   * the last few dozen ticks, the share held (moving under 30% of free speed, the HUD's "queued"), with fewer than
   * CONG_FULL cars a tick weighing as a share of that. 1 is a standstill; a signal approach held half the time reads about 0.5.
   */
  congestionAt(x: number, y: number): number {
    const rc = this.roadChunkIf(x, y);
    const c = rc?.cong[localIndex(x, y)];
    if (!c) return 0;
    const f = congFade(this.w.tick - c.at - 1);
    if (c.n * f < 0.004) { this.cong.delete(tkey(x, y)); rc!.cong[localIndex(x, y)] = undefined; this.dirty.add(tkey(x, y)); return 0; }
    return (c.s * f) / Math.max(c.n * f, CONG_FULL);
  }
  cost(x: number, y: number): number {
    const cx = chunkOf(x), cy = chunkOf(y);
    let cc = this.lastCost;
    if (cx !== this.lastCx || cy !== this.lastCy) { cc = this.costChunk(cx, cy); this.lastCx = cx; this.lastCy = cy; this.lastCost = cc; }
    const i = localIndex(x, y);
    if (this.w.tick !== this.epochTick) { this.epochTick = this.w.tick; this.congEpoch++; }
    let g: number;
    if (cc.at[i] === this.congEpoch) g = cc.cong[i];
    else { g = cc.cong[i] = this.congestionAt(x, y); cc.at[i] = this.congEpoch; }
    let f = cc.flags[i];
    if (!f) {
      f = cc.flags[i] = 1 | (this.degreeOf(x, y) >= 3 ? 2 : 0) | (this.isCrossingAt(x, y) ? (this.xingOf(x, y) === 1 ? 4 : 8) : 0);
      const ca = this.classAux(x, y);
      cc.base[i] = ca ? classDef(ca & 7).routeCost : 1; // the road's class: the hierarchy routers prefer (roadclass.ts)
      if (this.w.streetAny & StreetRule.Zone20 && this.w.streetAt(x, y) & StreetRule.Zone20) cc.base[i] *= ZONE20_COST; // a 20 zone (R5): through traffic goes elsewhere
    }
    let c = cc.base[i] + TT.congestionWeight * g;
    if (f & 2) c += 0.6;
    if (cc.kerb[i]) c += 0.5;
    // a level crossing: the expected wait for its barriers. A bascule lifts only a few times a day: nothing, but while it
    // is up, a detour (drivers held at it past the stuck limit re-route round it)
    if (f & 12) c += f & 4 ? CROSSING_DELAY : this.barrierDownAt(x, y) ? BASCULE_UP_COST : 0;
    return c;
  }
  private costChunks = new Map<number, CostChunk>();
  private lastCx = NaN; private lastCy = NaN; private lastCost!: CostChunk;
  /** bumped each new tick and by endTick: a cost chunk's congestion read in an earlier epoch is stale */
  private congEpoch = 0; private epochTick = NaN;
  private costChunk(cx: number, cy: number): CostChunk {
    const nk = tkey(cx, cy);
    let cc = this.costChunks.get(nk);
    if (!cc) {
      cc = { cong: new Float64Array(CELLS), at: new Float64Array(CELLS).fill(-1), flags: new Uint8Array(CELLS), kerb: new Uint8Array(CELLS), base: new Float32Array(CELLS).fill(1) };
      for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) if ((this.w.kerb.get(tkey(cx * CHUNK_SIZE + lx, cy * CHUNK_SIZE + ly)) ?? 0) > 0) cc.kerb[ly * CHUNK_SIZE + lx] = 1;
      this.costChunks.set(nk, cc);
    }
    return cc;
  }
  /** The cost chunk holding tile key k, if there is one yet, leaving the tile's index in it in `costCell`. */
  private costChunkOfKey(k: number): CostChunk | undefined {
    const x = tileX(k), y = tileY(k);
    this.costCell = localIndex(x, y);
    return this.costChunks.get(tkey(chunkOf(x), chunkOf(y)));
  }
  private costCell = 0;
  /** Is a car parked at the kerb of (x, y)? (World.kerb, from the cost chunk's copy of it) */
  private kerbAt(x: number, y: number): boolean {
    const cx = chunkOf(x), cy = chunkOf(y);
    let cc = this.kerbCost;
    if (cx !== this.kerbCx || cy !== this.kerbCy) { cc = this.costChunk(cx, cy); this.kerbCx = cx; this.kerbCy = cy; this.kerbCost = cc; }
    return cc.kerb[localIndex(x, y)] !== 0;
  }
  /** kerbAt's last cost chunk (its own, so it and the router's searches do not keep displacing each other's) */
  private kerbCx = NaN; private kerbCy = NaN; private kerbCost!: CostChunk;
  /** The cost chunk's flags of (x, y), dropped with the degree and crossing caches. */
  private dropCostFlags(x: number, y: number) {
    const cc = this.costChunks.get(tkey(chunkOf(x), chunkOf(y)));
    if (cc) cc.flags[localIndex(x, y)] = 0;
  }
  pathCost(path: number[], from: number): number {
    let c = 0;
    for (let i = from; i * 2 + 1 < path.length; i++) c += this.cost(path[i * 2], path[i * 2 + 1]);
    return c;
  }
  sweep() {
    const tick = this.w.tick;
    for (const [k, c] of this.cong) if (c.n * congFade(tick - c.at - 1) < 0.004) {
      this.cong.delete(k); this.dirty.add(k);
      const x = tileX(k), y = tileY(k);
      this.roadChunkIf(x, y)!.cong[localIndex(x, y)] = undefined;
    }
  }

  // ---- road geometry caches ------------------------------------------------------

  degreeOf(x: number, y: number): number {
    const rc = this.roadChunk(x, y), i = localIndex(x, y);
    let d = rc.deg[i];
    if (d < 0) {
      d = 0;
      for (let k = 0; k < 4; k++) { const t = this.w.peekTile(x + DIRS[k][0], y + DIRS[k][1]); if (t !== undefined && isRoad(t) && this.linked(x, y, k)) d++; }
      if (isFlyoverAux(this.junctionAux(x, y)) || (this.w.anyRoadClass && isDeckClassAux(this.classAux(x, y)))) d = 2; // two roads straight through on two levels (a flyover, an interchange's deck): no junction box
      rc.deg[i] = d;
    }
    return d;
  }
  /**
   * Do road tile (x, y) and its road neighbour heading d join for cars (roadclass.ts)? Always between streets; not
   * across a divided road's reservation, nor between a pedestrian street and a road cars use (a pedestrian street's
   * mouth is no junction to traffic).
   */
  private linked(x: number, y: number, d: number): boolean {
    const a = this.classAux(x, y), b = this.classAux(x + DIRS[d][0], y + DIRS[d][1]);
    if (!a && !b) return true;
    if (isPedestrianAux(a) !== isPedestrianAux(b)) return false;
    return carStepOk(a, b, d, true) || carStepOk(b, a, OPP[d], true);
  }
  /** The class byte of tile (x, y) (shared/src/roadclass.ts), 0 for a street or any other byte; cached like the rest. */
  classAux(x: number, y: number): number {
    const rc = this.roadChunk(x, y), i = localIndex(x, y);
    let a = rc.caux[i];
    if (a < 0) { a = this.w.auxAt(x, y); if (!isClassAux(a)) a = 0; rc.caux[i] = a; }
    return a;
  }
  /** A road cars may use (a pedestrian street is not one, for the signals' arms). */
  private carRoadAt = (x: number, y: number) => this.isRoadAt(x, y) && !isPedestrianAux(this.classAux(x, y));
  /**
   * The lane m takes across the edge from path node k to k + 1 (a strand, Mover.s1), `prev` being the lane it crossed
   * the edge before that in. A single-lane edge: 0. Two lanes (a one-way tile, roadclass.ts edgeLanes): the lane for its
   * next turn within six tiles (left: 1, right: 0); straight on, the lane it is in, or coming off a single lane one of
   * the two by its own hash, so traffic spreads over both. Bikes keep to the right.
   */
  strandFor(m: Mover, k: number, prev: number): number {
    const p = m.path, n = p.length / 2;
    if (k + 1 >= n || k < 0 || isBike(m)) return 0;
    const ax = p[k * 2], ay = p[k * 2 + 1], bx = p[k * 2 + 2], by = p[k * 2 + 3];
    const d = dirBetween(ax, ay, bx, by);
    if (edgeLanes(this.classAux(ax, ay), this.classAux(bx, by), d) < 2) return 0;
    // a bus lane (R5) on either tile: the kerb lane (strand 0) for buses, bikes, taxis and emergencies, unless they turn
    // left soon; everyone else the other lane, but for a right turn out of the tile ahead (turning off at the last tile)
    if (this.w.streetAny & StreetRule.BusLane && (this.w.streetAt(ax, ay) | this.w.streetAt(bx, by)) & StreetRule.BusLane) {
      if (this.busLaneUser(m)) {
        for (let j = k + 1; j + 1 < n && j <= k + 6; j++) {
          const dj = dirBetween(p[j * 2], p[j * 2 + 1], p[j * 2 + 2], p[j * 2 + 3]);
          if (dj !== d) return dj === LEFT[d] ? 1 : 0;
        }
        return 0;
      }
      if (k + 2 < n && dirBetween(bx, by, p[k * 2 + 4], p[k * 2 + 5]) === RIGHT[d]) return 0;
      return 1;
    }
    // a big roundabout (R4): its inner lane for cars going past the second exit, the outer for the rest and before an exit
    const ring = this.ringStrand(m, k);
    if (ring >= 0) return ring;
    // turn lanes (R4): the last two tiles of a one-way approach to a junction hold the lane, the left for left turns
    // and U-turns, the right for straight on and right; not on a motorway, where nobody turns left
    if (TT.turnLanes && !isMotorwayAux(this.classAux(ax, ay))) {
      for (let j = k + 1; j + 1 < n && j <= k + 3; j++) {
        const jx = p[j * 2], jy = p[j * 2 + 1];
        if (this.degreeOf(jx, jy) < 3) continue;
        const jn = this.junction(jx, jy), g = jn.g;
        if (TT.turnLanes === 2 && jn.phases !== 4) break;
        const inH = dirBetween(p[j * 2 - 2], p[j * 2 - 1], jx, jy);
        for (let q = j; q + 1 < n; q++) {
          if (g && inGroup(g, p[q * 2 + 2], p[q * 2 + 3])) continue;
          const outH = dirBetween(p[q * 2], p[q * 2 + 1], p[q * 2 + 2], p[q * 2 + 3]);
          return outH === LEFT[inH] || outH === OPP[inH] ? 1 : 0;
        }
        break;
      }
    }
    for (let j = k + 1; j + 1 < n && j <= k + 6; j++) {
      const dj = dirBetween(p[j * 2], p[j * 2 + 1], p[j * 2 + 2], p[j * 2 + 3]);
      if (dj !== d) return dj === LEFT[d] ? 1 : 0;
    }
    if (k > 0 && edgeLanes(this.classAux(p[k * 2 - 2], p[k * 2 - 1]), this.classAux(ax, ay), dirBetween(p[k * 2 - 2], p[k * 2 - 1], ax, ay)) === 2) return prev;
    return hash2(m.id * 7 + 3, ax * 31 + ay * 17 + d) < 0.5 ? 0 : 1;
  }
  /**
   * The lane on a big roundabout (R4, road class 6) for m's edge from path node k: -1 when the edge is not on the ring
   * or its approach. Counting the ring tiles m drives from where it comes on to where it leaves: more than nine (past the
   * second exit), the inner lane (1) but for the last four; six to nine (the second exit, straight over), either lane by
   * the driver's hash but the last two; otherwise the outer (0); the approach takes the lane the ring will want.
   */
  private ringStrand(m: Mover, k: number): number {
    const p = m.path, n = p.length / 2;
    let r0 = -1;
    for (let j = k + 1; j < n && j <= k + 3; j++) if (isRingClassAux(this.classAux(p[j * 2], p[j * 2 + 1]))) { r0 = j; break; }
    if (r0 < 0) return -1;
    // back to where m came onto the ring
    let s0 = r0;
    while (s0 - 1 >= 0 && isRingClassAux(this.classAux(p[s0 * 2 - 2], p[s0 * 2 - 1]))) s0--;
    let e = r0;
    while (e + 1 < n && isRingClassAux(this.classAux(p[e * 2 + 2], p[e * 2 + 3]))) e++;
    const total = e - s0 + 1, left = e - Math.max(k + 1, s0) + 1;
    // past the second exit (ten ring tiles or more): the inner lane, out again four tiles before the exit; to the second
    // exit (six to nine, straight over): either lane, by the driver, out two tiles before; to the first: the outer
    if (total > 9) return left > 4 ? 1 : 0;
    if (total > 5) return left > 2 && hash2(m.id * 31 + s0, 0x51ab) < 0.5 ? 1 : 0;
    return 0;
  }
  /**
   * After m's path changed ahead of it (a re-route), the lane it leaves the tile ahead by. A road's class changing under
   * a car is caught the same way in step(): a lane that is no longer there is the right-hand one.
   */
  restrand(m: Mover) {
    if (!this.w.anyRoadClass || m.lane < 0) return;
    m.s2 = this.strandFor(m, m.pi, m.s1 ?? 0);
  }
  /** The roundabout or flyover byte of a tile (shared/src/junctions.ts), 0 for none. */
  junctionAux(x: number, y: number): number {
    const rc = this.roadChunk(x, y), i = localIndex(x, y);
    let a = rc.jaux[i];
    if (a < 0) { a = this.w.auxAt(x, y); if (!isJunctionAux(a)) a = 0; rc.jaux[i] = a; }
    return a;
  }
  /**
   * Is (x, y) a level crossing (a road tile with straight track over it, shared/src/rail.ts)? A bascule bridge's deck
   * tile counts as one: barriers on its approaches close while it lifts.
   */
  isCrossingAt(x: number, y: number): boolean {
    const rc = this.roadChunk(x, y), i = localIndex(x, y);
    let v = rc.xing[i];
    if (v < 0) {
      const t = this.w.peekTile(x, y), a = this.w.auxAt(x, y);
      v = isCrossing(t, a) ? 1 : isDeck(t, a) && bridgeStyle(a) === BridgeStyle.Bascule ? 2 : 0;
      rc.xing[i] = v;
    }
    return v !== 0;
  }
  /** The crossing cache of (x, y) (isCrossingAt): 1 a level crossing, 2 a bascule deck, 0 neither, -1 not worked out yet. */
  private xingOf(x: number, y: number): number {
    const rc = this.roadChunkIf(x, y);
    return rc ? rc.xing[localIndex(x, y)] : -1;
  }
  /** Are the barriers of the crossing (x, y) down this tick? */
  barrierDownAt(x: number, y: number): boolean {
    const bascule = this.xingOf(x, y) === 2;
    if (!this.barrier && !bascule) return false;
    if (this.barsTick !== this.w.tick) { this.bars.clear(); this.barsTick = this.w.tick; }
    const k = tkey(x, y);
    let v = this.bars.get(k);
    if (v === undefined) { v = bascule ? basculeBarrierAt(x, y, this.auxFn, this.w.tick) : this.barrier!(x, y); this.bars.set(k, v); }
    return v;
  }
  private auxFn = (x: number, y: number) => this.w.auxAt(x, y);
  /** Barriers down at the crossing (x, y), or at a crossing straight after it heading d (side-by-side tracks are crossed in one go)? */
  private crossingClosed(x: number, y: number, d: number): boolean {
    for (let i = 0; i < 4 && this.isCrossingAt(x, y); i++, x += DIRS[d][0], y += DIRS[d][1]) if (this.barrierDownAt(x, y)) return true;
    return false;
  }
  /** Walking from (x0, y0) to (x1, y1) onto a level crossing whose barriers are down? Walkers wait at the edge (simulation.walkOn). */
  barrierAhead(x0: number, y0: number, x1: number, y1: number): boolean {
    const mx = Math.floor((x0 + x1) / 2), my = Math.floor((y0 + y1) / 2);
    // a walker caught on a bascule span when the barriers close walks on off it, as a car drives off
    if (this.isCrossingAt(Math.floor(x0), Math.floor(y0)) && this.xingOf(Math.floor(x0), Math.floor(y0)) === 2) return false;
    return this.isCrossingAt(mx, my) && this.barrierDownAt(mx, my) && !(x0 > mx + 0.02 && x0 < mx + 0.98 && y0 > my + 0.02 && y0 < my + 0.98);
  }
  /** No car is left at the kerb of a roundabout, a flyover, a level crossing or a bridge. */
  kerbless(x: number, y: number): boolean { const ca = this.classAux(x, y); return !!this.junctionAux(x, y) || this.isCrossingAt(x, y) || isBridgeAux(this.w.auxAt(x, y)) || isMotorwayAux(ca) || isPedestrianAux(ca) || isRingClassAux(ca) || ((this.w.anyRoadClass || this.w.roadRules.size > 0) && this.pelicanAt(x, y)) || (!!(this.w.streetAny & NO_KERB) && !!(this.w.streetAt(x, y) & NO_KERB)); }
  /** May m use a bus lane (R5)? Buses, two-wheelers, taxis and private hire, and emergencies on a call. */
  busLaneUser(m: Mover): boolean { const vk = (m as { vkind?: number }).vkind; return m.cls === VehicleClass.Bus || isBike(m) || m.priority || vk === BUS_LANE_TAXI || vk === BUS_LANE_HIRE; }
  /** Speed factor for a turn through tile (x, y): 0.6 at a plain junction; on a roundabout 1 round a corner, TRAFFIC_TUNING.ringSlow on or off at an arm. */
  private turnSlow(x: number, y: number) {
    const a = this.junctionAux(x, y);
    if (!a && this.w.anyRoadClass && isRingClassAux(this.classAux(x, y))) return TT.ringSlow; // a big roundabout's wide corners and its ways on and off
    return !isRingAux(a) ? 0.6 : isArmPos(ringPos(a)) ? TT.ringSlow : 1;
  }
  /** Is (x, y) a flyover tile (positions in tile units)? On one the deck and the road beneath never meet. */
  private flyAt(x: number, y: number) { const fx = Math.floor(x), fy = Math.floor(y); return isFlyoverAux(this.junctionAux(fx, fy)) || (this.w.anyRoadClass && isDeckClassAux(this.classAux(fx, fy))); }
  /** Two cars that cannot touch: one is on a flyover tile and they drive along different axes (deck and road beneath). */
  private apart(a: Mover, b: Mover) { return a.lane >= 0 && b.lane >= 0 && isEW(laneDir(a.lane)) !== isEW(laneDir(b.lane)) && (this.flyAt(a.x, a.y) || this.flyAt(b.x, b.y)); }
  isRoadAt(x: number, y: number) { const t = this.w.peekTile(x, y); return t !== undefined && isRoad(t); }
  private invalidate(x: number, y: number) {
    const rc = this.roadChunkIf(x, y);
    if (rc) { const i = localIndex(x, y); rc.deg[i] = -1; rc.jaux[i] = -1; rc.xing[i] = -1; rc.caux[i] = -1; }
    for (const [dx, dy] of DIRS) { const nc = this.roadChunkIf(x + dx, y + dy); if (nc) nc.deg[localIndex(x + dx, y + dy)] = -1; }
    this.dropCostFlags(x, y); for (const [dx, dy] of DIRS) this.dropCostFlags(x + dx, y + dy);
    // signal arms look at diagonal neighbours too (wide-road twins), so re-check the 3x3 around the change; with road
    // classes a junction group (R4) reaches three tiles out, so the 7x7
    const r = this.w.anyRoadClass ? 3 : 1;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const jc = this.roadChunkIf(x + dx, y + dy); if (jc) jc.junc[localIndex(x + dx, y + dy)] = undefined; }
    if (this.w.anyRoadClass) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const pc = this.roadChunkIf(x + dx, y + dy); if (pc) pc.pel[localIndex(x + dx, y + dy)] = -1; }
  }
  private roadAt = (x: number, y: number) => this.isRoadAt(x, y);
  /**
   * Junction control, cached. Junctions of three or more arms (not counting
   * the twin lane of a wide road, see signalArms) get signals when the parcel
   * owner has the technology; the cache is dropped around any road change
   * and re-checked when anyone unlocks technology or the tile changes parcel
   * (land bought under an existing road).
   */
  private junction(x: number, y: number): Junction {
    const rc = this.roadChunk(x, y), i = localIndex(x, y);
    let j = rc.junc[i];
    const deg = this.degreeOf(x, y), pid = this.w.parcelIdAt(x, y);
    if (!j || j.ver !== this.w.techVersion || j.deg !== deg || j.pid !== pid) {
      const ca = this.w.anyRoadClass ? this.classAux(x, y) : 0;
      // R4: the tiles of an avenue crossing work as one junction (signals.ts junctionGroup)
      const gr = deg >= 3 && isDividedAux(ca) ? this.w.groupAt(x, y) : null, g = gr && (gr.w > 1 || gr.h > 1) ? gr : null;
      let signal: boolean;
      if (g && TT.groupSignals) {
        let bar = false; // a motorway, roundabout or flyover in it: no lights
        for (let ty = g.y; ty < g.y + g.h; ty++) for (let tx = g.x; tx < g.x + g.w; tx++) if (isMotorwayAux(this.classAux(tx, ty)) || this.junctionAux(tx, ty) || isRingClassAux(this.classAux(tx, ty))) bar = true;
        signal = !bar && signalledArms(groupArms(this.carRoadAt, g)) && this.w.ownerHas(g.x, g.y, 'signals', hasFeature);
      } else signal = deg >= 3 && !this.junctionAux(x, y) && !isMotorwayAux(ca) && !isRingClassAux(ca) && !(this.w.anyRoadClass && slipJunction(this.auxFn, x, y)) && signalledArms(signalArms(this.w.anyRoadClass ? this.carRoadAt : this.roadAt, x, y)) && this.w.ownerHas(x, y, 'signals', hasFeature);
      const was = j?.g;
      j = j ?? { signal, ver: 0, deg, pid, ...signalTiming(x, y) };
      j.signal = signal; j.ver = this.w.techVersion; j.deg = deg; j.pid = pid; j.main = undefined;
      j.g = g ?? undefined; j.phases = g && TT.groupSignals ? (TT.groupSignals === 2 ? 2 : g.phases) : 2; j.ctl = undefined;
      if (g && TT.groupSignals) { const t = groupTiming(g.x, g.y); j.offset = t.offset; j.period = t.period; j.act = undefined; }
      else if (was) { const t = signalTiming(x, y); j.offset = t.offset; j.period = t.period; j.act = undefined; }
      rc.junc[i] = j;
    }
    if (j.g && TT.groupSignals && !j.ctl) j.ctl = j.g.x === x && j.g.y === y ? j : this.junction(j.g.x, j.g.y);
    return j;
  }
  /**
   * Does the light at junction B hold m now (B is path node `bi` of m's route, entered heading inD)? Only coming into
   * a signalled junction from outside it: inside a junction group (R4) the moves between its tiles answer only to the
   * box rules. Emergencies on a call go through. At a four-phase group the protected left phase lets through only the
   * green axis's left turns and U-turns, the through phase only its straight on and right turns.
   */
  private lightHolds(m: Mover, bi: number, inD: number): boolean {
    const bx = m.path[bi * 2], by = m.path[bi * 2 + 1];
    const j = this.junction(bx, by);
    if (!j.signal || m.priority) return false;
    if (j.g && TT.groupSignals && bi > 0 && inGroup(j.g, m.path[(bi - 1) * 2], m.path[(bi - 1) * 2 + 1])) return false;
    const ph = this.signalPhase(bx, by);
    if ((ph.green === 'ew') !== isEW(inD) || ph.amber) return true;
    return j.phases === 4 && !!ph.left !== this.groupLeft(m, bi, j.g!, inD);
  }
  /** Does m, coming into group g at path node bi heading inD, turn left (or round) by the time it leaves the group? */
  private groupLeft(m: Mover, bi: number, g: JunctionGroup, inD: number): boolean {
    const p = m.path, n = p.length / 2;
    for (let k = bi; k + 1 < n; k++) {
      if (inGroup(g, p[k * 2 + 2], p[k * 2 + 3])) continue;
      const out = dirBetween(p[k * 2], p[k * 2 + 1], p[k * 2 + 2], p[k * 2 + 3]);
      return out === LEFT[inD] || out === OPP[inD];
    }
    return false;
  }
  junctionKind(x: number, y: number): 'none' | 'yield' | 'signal' | 'roundabout' | 'flyover' | 'mini' | 'bigRoundabout' | 'interchange' | 'pelican' {
    const a = this.junctionAux(x, y);
    if (a) return isRingAux(a) ? 'roundabout' : isMiniAux(a) ? 'mini' : isFlyoverAux(a) ? 'flyover' : 'bigRoundabout';
    if (this.w.anyRoadClass) {
      const ca = this.classAux(x, y);
      if (isRingClassAux(ca)) return 'bigRoundabout';
      if (isDeckClassAux(ca)) return 'interchange';
    }
    if (this.degreeOf(x, y) < 3) return (this.w.anyRoadClass || this.w.roadRules.size) && this.pelicanAt(x, y) ? 'pelican' : 'none';
    return this.junction(x, y).signal ? 'signal' : 'yield';
  }
  /** The junction group (R4) of a junction tile, when it is more than one tile. */
  groupOf(x: number, y: number): JunctionGroup | undefined { return this.degreeOf(x, y) >= 3 ? this.junction(x, y).g : undefined; }
  /** How many phases the lights at (x, y) run (2, or 4 at a group of two divided roads crossing). */
  phasesAt(x: number, y: number): number { return this.degreeOf(x, y) >= 3 ? this.junction(x, y).phases ?? 2 : 2; }
  /** The signal phase at (x,y) now (the same pure function of tick the client draws). Shared scratch: copy what you keep. */
  signalPhase(x: number, y: number): SignalPhase {
    const j = this.junction(x, y);
    if (j.ctl) {
      // a junction group (R4): one controller, at its anchor; actuated only when it runs two phases
      if (TT.signalActuated && j.signal && j.phases === 2) return this.actuated(j.ctl, j.g!.x, j.g!.y);
      return groupPhaseOf(j, j.phases ?? 2, this.w.tick + this.lookTicks, this.phase, groupMain(j.g!));
    }
    if (TT.signalActuated && j.signal) return this.actuated(j, x, y);
    return signalPhaseOf(j, this.w.tick + this.lookTicks, this.phase);
  }
  /**
   * Actuated lights (TRAFFIC_TUNING.signalActuated, server-side only: the
   * client draws the fixed-time phase). At the point the amber would start,
   * a green is held one more tick while nobody waits on the red approaches and
   * someone is coming on the green ones, up to twice the junction's period.
   */
  private actuated(j: Junction, x: number, y: number): SignalPhase {
    const t = this.w.tick, amber = TT.signalAmber;
    let s = j.act;
    if (!s) { const b = signalPhaseOf(j, t, this.phase); s = j.act = { green: b.green, start: t, end: t + j.period, decided: false, at: t }; }
    if (t >= s.end) { s.green = s.green === 'ns' ? 'ew' : 'ns'; s.start = t; s.end = t + j.period; s.decided = false; }
    if (!s.decided && t >= s.end - amber && s.at !== t) {
      s.at = t;
      const red = s.green === 'ns' ? 'ew' : 'ns';
      if (t - s.start < 2 * j.period && !this.approaching(x, y, red) && this.approaching(x, y, s.green)) s.end = t + amber + 1;
      else s.decided = true;
    }
    this.phase.green = s.green;
    this.phase.amber = s.decided && t >= s.end - amber;
    return this.phase;
  }
  /** Any car in a lane arriving at (x,y) along this axis? */
  private approaching(x: number, y: number, axis: 'ns' | 'ew'): boolean {
    const g = this.junction(x, y).g;
    if (g && TT.groupSignals) {
      // a group: the lanes coming into any of its tiles from outside it
      for (let ty = g.y; ty < g.y + g.h; ty++) for (let tx = g.x; tx < g.x + g.w; tx++) for (let d = 0; d < 4; d++) {
        if (isEW(d) !== (axis === 'ew') || inGroup(g, tx - DIRS[d][0], ty - DIRS[d][1])) continue;
        const q = this.laneQ(tx - DIRS[d][0], ty - DIRS[d][1], d);
        if (q && q.length) return true;
      }
      return false;
    }
    for (let d = 0; d < 4; d++) {
      if (isEW(d) !== (axis === 'ew')) continue;
      const q = this.laneQ(x - DIRS[d][0], y - DIRS[d][1], d);
      if (q && q.length) return true;
    }
    return false;
  }
  green(x: number, y: number): 'ns' | 'ew' { return this.signalPhase(x, y).green; }
  /** Signalled junction whose crossed carriageway has a red now: may a walker heading `xd` (Polyline.xdir) step out? */
  walkSignal(x: number, y: number, xd: number): boolean {
    const ph = this.signalPhase(x, y);
    // the road you walk beside has the green, so the road you cross has red; on a box crossing that is the road you entered by.
    // Not in a four-phase group's protected left phase (R4): the turning cars drive over the crossings beside the green road
    return !ph.amber && !ph.left && (ph.green === 'ew') === isEW(xd & 3);
  }

  // ---- occupancy -------------------------------------------------------------

  laneCount(x: number, y: number, dir: number) { return this.laneQ(x, y, dir)?.length ?? 0; }
  onTile(x: number, y: number): number {
    let n = 0;
    for (let d = 0; d < 4; d++) n += this.laneCount(x, y, d);
    return n;
  }
  private capacityInto(x: number, y: number, strand = 0) {
    return Math.max(1, TT.laneCap - (!strand && this.kerbAt(x, y) ? 1 : 0)); // a car at the kerb takes room in the right-hand lane only
  }
  /**
   * Is there room for `m` in lane `key` on tile (x,y)? A fixed count of cars
   * (laneCap, one fewer with a car at the kerb), or with laneByLength the
   * bumper-to-bumper length of the queue: every car's length plus MIN_GAP,
   * the newcomer's included, within laneRoom tiles (less a car's worth at the kerb).
   * `extra` cars are already on their way in (the lane before, for boxClear).
   */
  private laneRoom(x: number, y: number, key: number, m: Mover, extra: Mover[] | null = null, strand = 0): boolean {
    // a plain motorway tile admits as many as the following gap lets in: cars at 1.2 tiles a tick keep a headway longer than
    // a tile, and a count or a length of lane that admits them one at a time stops the one behind dead from speed
    if (this.w.anyRoadClass && isMotorwayAux(this.classAux(x, y)) && this.degreeOf(x, y) < 3) return true;
    const q = this.laneAt(key);
    if (!TT.laneByLength) {
      // two-wheelers (fleet.ts BIKE_CLASS) slip into the space a car leaves and take none of a car's: they do not count,
      // and the following gap alone keeps them clear of whatever is ahead (docs/mobile-jobs.md)
      if (m.cls === BIKE_CLASS) return true;
      // a two-lane road's lanes fill one by one (`strand`); cars on their way in count whichever lane they take
      let n = extra?.length ?? 0;
      if (q) for (const o of q) if (o.cls !== BIKE_CLASS && (o.s1 ?? 0) === strand) n++;
      return n < this.capacityInto(x, y, strand);
    }
    const kerb = !strand && this.kerbAt(x, y);
    let used = m.len + MIN_GAP;
    if (q) for (const o of q) if ((o.s1 ?? 0) === strand) used += o.len + MIN_GAP;
    if (extra) for (const o of extra) used += o.len + MIN_GAP;
    const room = TT.laneRoom - (kerb ? VEHICLE_LEN[0] + MIN_GAP : 0);
    return used <= room + 1e-9 || (!q?.length && !extra?.length); // an empty lane always takes one car
  }
  /** Is `m` (in lane m.lane, short of tile B) inside any junction box: the one it is leaving, or B once committed? */
  inJunctionBox(m: Mover): boolean {
    if (m.lane < 0) return false;
    const ax = m.path[(m.pi - 1) * 2], ay = m.path[(m.pi - 1) * 2 + 1];
    if (this.degreeOf(ax, ay) >= 3 && m.prog < this.clearAt(m)) return true;
    if (m.pi * 2 + 1 < m.path.length) {
      const bx = m.path[m.pi * 2], by = m.path[m.pi * 2 + 1];
      if (this.degreeOf(bx, by) >= 3 && (m.committed || m.prog > this.stopLine(m))) return true;
    }
    return false;
  }
  /** Where a mover must stop in its lane to keep its nose out of the next tile. */
  private stopLine(m: Mover) {
    if (!TT.arcAware) return 0.5 - m.len / 2 - STOP_MARGIN;
    return 0.5 - (m.len / 2 + STOP_MARGIN) / ARC_S(m.inDir, laneDir(m.lane), m.s0 ?? 0, m.s1 ?? 0);
  }
  /** Lane progress at which a car's rear has left the tile its lane starts on (the box it is leaving). */
  private clearAt(m: Mover) {
    if (!TT.arcAware) return 0.5 + m.len / 2;
    return 0.5 + m.len / 2 / ARC_S(laneDir(m.lane), this.nextDirOf(m), m.s1 ?? 0, m.s2 ?? 0);
  }

  /**
   * Movers physically inside tile T's box right now, with their movement through it: the count, the movers in boxM and
   * their movements in boxIn and boxOut (scratch: read them before the next call).
   */
  private inBox(tx: number, ty: number): number {
    const M = this.boxM, I = this.boxIn, O = this.boxOut, SI = this.boxSi, SO = this.boxSo;
    let n = 0;
    // inside a chunk, not on its edge: every lane looked at is in this tile's RoadChunk
    const lx = tx - Math.floor(tx / CHUNK_SIZE) * CHUNK_SIZE, ly = ty - Math.floor(ty / CHUNK_SIZE) * CHUNK_SIZE;
    const inner = lx >= 1 && lx <= CHUNK_SIZE - 2 && ly >= 1 && ly <= CHUNK_SIZE - 2;
    const rc = inner ? this.roadChunkIf(tx, ty) : undefined, i0 = ly * CHUNK_SIZE + lx, med = this.w.anyRoadClass;
    if (inner && !rc) return 0;
    for (let d = 0; d < 4; d++) {
      // arriving lanes: from the neighbour on the opposite side, heading d
      const q = rc ? rc.lanes[(i0 - DIRS[d][0] - DIRS[d][1] * CHUNK_SIZE) * 4 + d] : this.laneQ(tx - DIRS[d][0], ty - DIRS[d][1], d);
      // a car waiting in a median box (R4: there are none without road classes) is in neither carriageway's box
      if (q) for (const m of q) if (TT.boxByCommit ? m.committed : m.prog > this.stopLine(m) && !(med && m.med)) { M[n] = m; I[n] = d; O[n] = this.nextDirOf(m); SI[n] = m.s1 ?? 0; SO[n] = m.s2 ?? 0; n++; }
      const o = rc ? rc.lanes[i0 * 4 + d] : this.laneQ(tx, ty, d);
      if (o) for (const m of o) if (m.prog < this.clearAt(m) && !(med && m.med)) { M[n] = m; I[n] = m.inDir; O[n] = d; SI[n] = m.s0 ?? 0; SO[n] = m.s1 ?? 0; n++; }
    }
    return n;
  }
  private boxM: Mover[] = []; private boxIn: number[] = []; private boxOut: number[] = [];
  /** the lanes (strands) the movers in boxM come into and leave the box by */
  private boxSi: number[] = []; private boxSo: number[] = [];
  /**
   * Any car in the box of a tile: what a pedestrian checks before stepping
   * onto the carriageway. With a CROSS_* mask, only cars whose movement uses
   * one of those carriageways count (at lights, traffic going straight along
   * the green road beside you does not cross your path).
   */
  boxBusy(tx: number, ty: number, mask = CROSS_NS_ROAD | CROSS_EW_ROAD): boolean {
    for (let i = 0, n = this.inBox(tx, ty); i < n; i++) if (movementMask(this.boxIn[i], this.boxOut[i]) & mask) return true;
    return false;
  }
  /** A pedestrian is on the carriageway of this tile this tick, over the roads in `mask` (CROSS_*). */
  noteCrossing(k: number, mask = CROSS_NS_ROAD | CROSS_EW_ROAD) {
    const x = tileX(k), y = tileY(k), rc = this.roadChunk(x, y), s = this.presStamp, i = localIndex(x, y) * 2 + (s & 1);
    if (rc.xmAt[i] !== s) { rc.xmAt[i] = s; rc.xm[i] = 0; }
    rc.xm[i] |= mask;
  }
  /** Mask of the carriageways pedestrians were on in this tile last tick (0: nobody). */
  crossingsAt(x: number, y: number) {
    const rc = this.roadChunkIf(x, y);
    if (!rc) return 0;
    const s = this.presStamp, i = localIndex(x, y) * 2, p = i + ((s - 1) & 1), c = i + (s & 1);
    // with the lag removed, a walker who stepped out earlier this tick counts too
    return (rc.xmAt[p] === s - 1 ? rc.xm[p] : 0) | (TT.crossingLag ? 0 : rc.xmAt[c] === s ? rc.xm[c] : 0);
  }

  /** May `m` drive on into its destination building's forecourt (tile bx,by), arriving heading `dir`? */
  private forecourtFree(m: Mover, bx: number, by: number, dir: number): boolean {
    if (!TT.forecourtConflict) return !this.boxBusyExcept(bx, by, m);
    return !this.boxConflict(m, bx, by, dir, dir);
  }
  private boxBusyExcept(tx: number, ty: number, m: Mover): boolean {
    // inBox, stopping at the first mover found other than m
    const lx = tx - Math.floor(tx / CHUNK_SIZE) * CHUNK_SIZE, ly = ty - Math.floor(ty / CHUNK_SIZE) * CHUNK_SIZE;
    const inner = lx >= 1 && lx <= CHUNK_SIZE - 2 && ly >= 1 && ly <= CHUNK_SIZE - 2;
    const rc = inner ? this.roadChunkIf(tx, ty) : undefined, i0 = ly * CHUNK_SIZE + lx, med = this.w.anyRoadClass;
    if (inner && !rc) return false;
    for (let d = 0; d < 4; d++) {
      const q = rc ? rc.lanes[(i0 - DIRS[d][0] - DIRS[d][1] * CHUNK_SIZE) * 4 + d] : this.laneQ(tx - DIRS[d][0], ty - DIRS[d][1], d);
      if (q) for (const o of q) if ((TT.boxByCommit ? o.committed : o.prog > this.stopLine(o) && !(med && o.med)) && o !== m) return true;
      const l = rc ? rc.lanes[i0 * 4 + d] : this.laneQ(tx, ty, d);
      if (l) for (const o of l) if (o.prog < this.clearAt(o) && !(med && o.med) && o !== m) return true;
    }
    return false;
  }

  private nextDirOf(m: Mover): number {
    const n = m.path.length / 2;
    if (m.pi + 1 >= n) return dirBetween(m.path[(m.pi - 1) * 2], m.path[(m.pi - 1) * 2 + 1], m.path[m.pi * 2], m.path[m.pi * 2 + 1]);
    return dirBetween(m.path[m.pi * 2], m.path[m.pi * 2 + 1], m.path[(m.pi + 1) * 2], m.path[(m.pi + 1) * 2 + 1]);
  }

  /** Can a path be driven at all (two or more nodes)? */
  canDrive(path: number[]) { return path.length >= 4; }
  /**
   * Put a mover on the first lane of its path. 'blocked' while the car that
   * left before it is still too close to the start, so departures from one
   * building (or one entry point) file out one by one instead of stacking.
   */
  enter(m: Mover): 'ok' | 'blocked' {
    this.leave(m);
    m.len = VEHICLE_LEN[m.cls] ?? VEHICLE_LEN[0];
    const d = dirBetween(m.path[0], m.path[1], m.path[2], m.path[3]);
    const key = Traffic.laneKey(m.path[0], m.path[1], d);
    const q = this.laneQ(m.path[0], m.path[1], d);
    if (this.w.anyRoadClass) { m.s0 = 0; m.s1 = this.strandFor(m, 0, 0); m.s2 = this.strandFor(m, 1, m.s1); }
    else if (m.s1 || m.s2) m.s0 = m.s1 = m.s2 = 0;
    const tail = q && q.length ? leaderIn(q, q.length, isBike(m), m.s1 ?? 0) : null;
    if (tail && tail.prog < (tail.len + m.len) / 2 + MIN_GAP * m.gapMul) return 'blocked';
    if (TT.spawnClear && this.boxBusyExcept(m.path[0], m.path[1], m)) return 'blocked';
    m.pi = 1; m.prog = 0; m.wait = 0; m.stuck = 0; m.committed = false; m.v = 0;
    m.inDir = d;
    if (TT.meterCongestion < 1 && !this.isRoadAt(m.path[0], m.path[1]) && this.congestionAt(m.path[2], m.path[3]) >= TT.meterCongestion) return 'blocked';
    if (TT.spawnClear >= 2 && m.path.length >= 6 && !this.isRoadAt(m.path[0], m.path[1]) && !(m.priority && m.call)) {
      // out of a building: stay in the garage until the road tile would take you, so nobody waits in the forecourt (a fire
      // engine on a call does pull out and waits there, lights flashing, for the traffic to let it in: sim/fires.ts)
      const nd = dirBetween(m.path[2], m.path[3], m.path[4], m.path[5]);
      if (!this.canEnter(m, m.path[2], m.path[3], d, nd)) return 'blocked';
    }
    if (TT.bodyGuard && (this.pedInBody(m, 0) || ((TT.guardDrawn & 4) && this.pedNear(m.x, m.y, m.len / 2 + PED_R + GUARD_MARGIN)))) return 'blocked';
    noteTrail(m, m.path[0], m.path[1]);
    this.push(key, m);
    this.place(m);
    return 'ok';
  }
  leave(m: Mover) {
    if (m.lane < 0) return;
    const q = this.laneAt(m.lane);
    if (q) {
      const i = q.indexOf(m);
      if (i >= 0) q.splice(i, 1);
      if (q.length === 0) this.dropLane(m.lane);
    }
    m.lane = -1; m.committed = false; if (m.med) m.med = false;
  }
  /** The queue of lane (x, y, d), if anyone is in it (the same array as in `cells`). */
  private laneQ(x: number, y: number, d: number): Mover[] | undefined {
    const rc = this.roadChunkIf(x, y);
    return rc ? rc.lanes[localIndex(x, y) * 4 + d] : undefined;
  }
  /** The queue of the lane with key `key` (laneKey), if anyone is in it. */
  private laneAt(key: number): Mover[] | undefined {
    const t = laneTile(key);
    return this.laneQ(tileX(t), tileY(t), laneDir(key));
  }
  private dropLane(key: number) {
    this.cells.delete(key);
    const t = laneTile(key), x = tileX(t), y = tileY(t);
    const rc = this.roadChunkIf(x, y);
    if (rc) rc.lanes[localIndex(x, y) * 4 + laneDir(key)] = undefined;
  }
  private push(key: number, m: Mover) {
    let q = this.laneAt(key);
    if (!q) { q = []; this.cells.set(key, q); const t = laneTile(key), x = tileX(t), y = tileY(t); this.roadChunk(x, y).lanes[localIndex(x, y) * 4 + laneDir(key)] = q; }
    q.push(m);
    m.lane = key;
  }

  /** World position of a mover from its lane, progress and the turns before and after. */
  private place(m: Mover) {
    const p = this.posAt(m, m.prog, this.tmp);
    m.x = p[0]; m.y = p[1];
  }
  private posAt(m: Mover, prog: number, p: [number, number]): [number, number] {
    const ax = m.path[(m.pi - 1) * 2], ay = m.path[(m.pi - 1) * 2 + 1];
    const bx = m.path[m.pi * 2], by = m.path[m.pi * 2 + 1];
    const d = dirBetween(ax, ay, bx, by);
    if (isBike(m)) {
      const off = LANE_OFFSET + BIKE_SIDE;
      if (prog < 0.5) pathPoint(ax, ay, m.inDir, d, 0.5 + prog, off, p);
      else pathPoint(bx, by, d, this.nextDirOf(m), prog - 0.5, off, p);
      return p;
    }
    // each tile is crossed from the lane it was come into by to the lane it is left by (one lane, LANE_OFFSET, on plain roads)
    if (prog < 0.5) pathPoint(ax, ay, m.inDir, d, 0.5 + prog, strandOffset(m.s0 ?? 0), p, strandOffset(m.s1 ?? 0));
    else pathPoint(bx, by, d, this.nextDirOf(m), prog - 0.5, strandOffset(m.s1 ?? 0), p, strandOffset(m.s2 ?? 0));
    return p;
  }
  /** A progress the body guard can test: on into the next lane (as step() would put it there), or short of the destination. */
  private sweepProg(m: Mover, p: number): number {
    if (p < 1) return p;
    if (m.pi + 1 >= m.path.length / 2) return 0.999;
    return 1 + Math.min(p - 1, 0.3);
  }
  /** Position along m's route at progress p of its lane, where p in [1, 1.5) is that far into the next lane. */
  private posAlong(m: Mover, p: number, out: [number, number]): [number, number] {
    if (p < 1 || m.pi + 1 >= m.path.length / 2) return this.posAt(m, Math.min(p, 0.999), out);
    const ax = m.path[(m.pi - 1) * 2], ay = m.path[(m.pi - 1) * 2 + 1];
    const bx = m.path[m.pi * 2], by = m.path[m.pi * 2 + 1];
    if (isBike(m)) return pathPoint(bx, by, dirBetween(ax, ay, bx, by), this.nextDirOf(m), 0.5 + (p - 1), LANE_OFFSET + BIKE_SIDE, out);
    return pathPoint(bx, by, dirBetween(ax, ay, bx, by), this.nextDirOf(m), 0.5 + (p - 1), strandOffset(m.s1 ?? 0), out, strandOffset(m.s2 ?? 0));
  }
  /**
   * The body guard, last resort behind the entry rules: how far m may move this tick (at most `allowed`) without its
   * body touching a pedestrian or another car's body ahead of it. Bodies near enough to matter are gathered once,
   * then the sweep is checked at thirds and m stops at the last clear one. Bodies behind m are ignored (driving on
   * takes it away from them, and they keep their own distance), as are cars it already touches (moving on ends that).
   */
  private guardSweep(m: Mover, allowed: number): number {
    const h = this.tmp2;
    if (!this.headingOf(m, h)) return allowed;
    const nhx = h[0], nhy = h[1];
    const reach = m.len / 2 + allowed + 0.35;
    this.gNp = 0; this.gNc = 0;
    if (TT.bodyGuard) this.gatherPeds(m, nhx, nhy, reach);
    if (TT.carGuard) this.gatherCars(m, nhx, nhy, reach);
    if (!this.gNp && !this.gNc) return allowed;
    return this.sweepClear(m, allowed);
  }
  /** guardSweep: the walkers near enough to matter, into gPeds (x, y, margin; gNp numbers) */
  private gatherPeds(m: Mover, nhx: number, nhy: number, reach: number) {
    const tx = Math.floor(m.x), ty = Math.floor(m.y), peds = this.gPeds;
    let np = 0;
    let mFly = -1; // flyAt(m.x, m.y), once it is needed
    const L = this.nearL;
    for (let g = 0; g < 2; g++) for (let j = 0, nl = (g ? this.walkPrev : this.walkCur).near(tx, ty, L); j < nl; j++) {
      for (const p of L[j]) {
        if (!p.pts) continue; // stopped walking since it was noted
        const ex = p.x - m.x, ey = p.y - m.y;
        if (ex * ex + ey * ey > reach * reach) continue;
        if (this.flyAt(p.x, p.y)) continue; // walkers on a flyover are on the deck or under it, beside the carriageways
        if (mFly < 0) mFly = this.flyAt(m.x, m.y) ? 1 : 0;
        if (mFly) continue;
        // already touching (walking out of a car is always allowed): driving on is how that ends
        if (Math.abs(ex * nhx + ey * nhy) < m.len / 2 + PED_R && Math.abs(-ex * nhy + ey * nhx) < widthOf(m) / 2 + PED_R) continue;
        // behind the car's centre: ignored (pedBehind 0), or only a real touch counts (1: no margin, or a turning car's rear would freeze it next to people on the kerb)
        const ahead = ex * nhx + ey * nhy > 0;
        if (!ahead && !TT.pedBehind) continue;
        peds[np++] = p.x; peds[np++] = p.y; peds[np++] = ahead ? GUARD_MARGIN : 0;
      }
    }
    this.gNp = np;
  }
  /** guardSweep: the car bodies ahead near enough to matter that m does not already touch, into gCars (gNc of them) */
  private gatherCars(m: Mover, nhx: number, nhy: number, reach: number) {
    const tx = Math.floor(m.x), ty = Math.floor(m.y);
    let nc = 0;
    const now = this.gNow;
    now.x = m.x; now.y = m.y; now.hx = nhx; now.hy = nhy; now.len = m.len;
    const oh = this.tmp3, cars = this.gCars, L = this.nearL;
    for (let j = 0, nl = this.carGrid.near(tx, ty, L); j < nl; j++) {
      for (const o of L[j]) {
        if (o === m || o.lane < 0) continue;
        const ex = o.x - m.x, ey = o.y - m.y, rr = reach + o.len / 2 + VEHICLE_WIDTH;
        if (ex * nhx + ey * nhy <= 0 || ex * ex + ey * ey > rr * rr) continue;
        if (this.apart(m, o) || this.filtering(m, o) || !this.headingOf(o, oh)) continue;
        const ob = cars[nc] ??= { x: 0, y: 0, hx: 0, hy: 0, len: 0 };
        ob.x = o.x; ob.y = o.y; ob.hx = oh[0]; ob.hy = oh[1]; ob.len = o.len;
        if (obbOverlap(now, ob, 0)) continue;
        // a car waiting in a median box (R4) stands clear of both carriageways' lanes by a twentieth of a tile, less
        // than the guard's margin on both bodies: it is tested body to body, or it would hold the reservation-side lane
        this.gMed[nc] = !!o.med;
        nc++;
      }
    }
    this.gNc = nc;
  }
  /** guardSweep: how far m may move, at the last third of `allowed` clear of everything gathered */
  private sweepClear(m: Mover, allowed: number): number {
    const peds = this.gPeds, np = this.gNp, cars = this.gCars, nc = this.gNc;
    const a = this.gA, b = this.gB, c = this.gC;
    const halfL = m.len / 2 + PED_R + GUARD_MARGIN, halfW = widthOf(m) / 2 + PED_R + marginOf(m);
    for (let k = 1; k <= 3; k++) {
      const p = this.sweepProg(m, m.prog + (allowed * k) / 3);
      this.posAlong(m, Math.max(0, p - 0.01), a); this.posAlong(m, p + 0.01, b); this.posAlong(m, p, c);
      let hx = b[0] - a[0], hy = b[1] - a[1];
      const d = hypot(hx, hy); if (d < 1e-6) continue;
      hx /= d; hy /= d;
      // test the body along its path and as the client will draw it, facing the way it moved this tick
      const cx = c[0] - m.x, cy = c[1] - m.y, cd = hypot(cx, cy);
      const nh = (TT.guardDrawn & 1) && cd > 1e-2 ? 2 : 1;
      let hit = false;
      for (let o = 0; o < nh && !hit; o++) {
        const ux = o === 0 ? hx : cx / cd, uy = o === 0 ? hy : cy / cd;
        for (let i = 0; i < np && !hit; i += 3) {
          const ex = peds[i] - c[0], ey = peds[i + 1] - c[1], pad = peds[i + 2] - GUARD_MARGIN;
          hit = Math.abs(ex * ux + ey * uy) < halfL + pad && Math.abs(-ex * uy + ey * ux) < halfW + pad;
        }
        if (!hit && nc) {
          const me = this.gMe;
          me.x = c[0]; me.y = c[1]; me.hx = ux; me.hy = uy; me.len = m.len;
          for (let j = 0; j < nc; j++) if (obbOverlap(me, cars[j], this.gMed[j] ? 0 : GUARD_MARGIN)) { hit = true; break; }
        }
      }
      if (hit) return (allowed * (k - 1)) / 3;
    }
    return allowed;
  }
  private gPeds: number[] = [];
  /** scratch for TileLists.near */
  private nearL: Mover[][] = [];
  /** guardSweep's scratch: how many numbers of gPeds and bodies of gCars are this sweep's, m's body now and at a sweep point, path points */
  private gNp = 0; private gNc = 0;
  private gNow: Obb = { x: 0, y: 0, hx: 0, hy: 0, len: 0 }; private gMe: Obb = { x: 0, y: 0, hx: 0, hy: 0, len: 0 };
  private gA: [number, number] = [0, 0]; private gB: [number, number] = [0, 0]; private gC: [number, number] = [0, 0]; private tmp3: [number, number] = [0, 0];
  /** Any pedestrian within r of (x,y)? (A car pulls out only when nobody is standing where it will appear, whichever way it is drawn.) */
  private pedNear(x: number, y: number, r: number): boolean {
    const tx = Math.floor(x), ty = Math.floor(y);
    const L = this.nearL;
    for (let g = 0; g < 2; g++) for (let j = 0, nl = (g ? this.walkPrev : this.walkCur).near(tx, ty, L); j < nl; j++) {
      for (const p of L[j]) if (p.pts && (p.x - x) ** 2 + (p.y - y) ** 2 < r * r) return true;
    }
    return false;
  }
  private gCars: Obb[] = [];
  /** gatherCars: whether each gathered car is waiting in a median box (tested without the margin) */
  private gMed: boolean[] = [];
  /**
   * A two-wheeler and a car in the same lane, or one in the lane the other drives into next, both going straight: the
   * bike rides past at the kerb edge. While either is turning, their paths cross and the body guard holds them as any two.
   */
  private filtering(m: Mover, o: Mover): boolean {
    if (isBike(m) === isBike(o)) return false;
    // through a turn: with bikeTurnGuard 1 both are held as any two vehicles; with 2 only the bike gives way (a car is never held by a bike)
    if (TT.bikeTurnGuard && (TT.bikeTurnGuard === 1 || isBike(m)) && (this.turning(m) || this.turning(o))) return false;
    if (o.lane === m.lane) return true;
    const n = m.path.length / 2;
    return m.pi + 1 < n && o.lane === Traffic.laneKey(m.path[m.pi * 2], m.path[m.pi * 2 + 1], this.nextDirOf(m));
  }
  /** Is m on the turning part of its lane: still coming round from the way it entered, or already into the turn ahead? */
  private turning(m: Mover): boolean {
    if (m.lane < 0 || m.pi < 1 || m.pi * 2 + 1 >= m.path.length) return false;
    const d = laneDir(m.lane);
    return (m.prog < 0.5 && m.inDir !== d) || (m.prog > 0.3 && this.nextDirOf(m) !== d);
  }
  /** Would mover m's body at `prog` (posAlong) touch a pedestrian (body guard)? */
  private pedInBody(m: Mover, prog: number): boolean {
    const a = this.posAlong(m, Math.max(0, prog - 0.01), [0, 0]), b = this.posAlong(m, prog + 0.01, [0, 0]);
    const c = this.posAlong(m, prog, [0, 0]);
    let hx = b[0] - a[0], hy = b[1] - a[1];
    const d = hypot(hx, hy); if (d < 1e-6) return false;
    hx /= d; hy /= d;
    const halfL = m.len / 2 + PED_R + GUARD_MARGIN, halfW = widthOf(m) / 2 + PED_R + marginOf(m);
    const tx = Math.floor(c[0]), ty = Math.floor(c[1]);
    const now = this.headingOf(m, this.tmp2) ? [this.tmp2[0], this.tmp2[1]] : null;
    for (let g = 0; g < 2; g++) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const l = (g ? this.walkPrev : this.walkCur).get(tx + dx, ty + dy);
        if (!l) continue;
        for (const p of l) {
          if (!p.pts) continue; // stopped walking since it was noted
          if (now && (p.x - m.x) * now[0] + (p.y - m.y) * now[1] <= 0) continue; // behind me: driving on takes me away
          if (this.flyAt(p.x, p.y) || this.flyAt(c[0], c[1])) continue;
          const ex = p.x - c[0], ey = p.y - c[1];
          if (Math.abs(ex * hx + ey * hy) < halfL && Math.abs(-ex * hy + ey * hx) < halfW) return true;
        }
      }
    }
    return false;
  }
  /** Would m's body at `prog` overlap another car's body that it does not already overlap (separating axes)? */
  private carInBody(m: Mover, prog: number): boolean {
    const a = this.posAlong(m, Math.max(0, prog - 0.01), [0, 0]), b = this.posAlong(m, prog + 0.01, [0, 0]);
    const c = this.posAlong(m, prog, [0, 0]);
    let hx = b[0] - a[0], hy = b[1] - a[1];
    const d = hypot(hx, hy); if (d < 1e-6) return false;
    hx /= d; hy /= d;
    const me = { x: c[0], y: c[1], hx, hy, len: m.len };
    const now = this.headingOf(m, this.tmp2) ? { x: m.x, y: m.y, hx: this.tmp2[0], hy: this.tmp2[1], len: m.len } : null;
    const tx = Math.floor(c[0]), ty = Math.floor(c[1]), h: [number, number] = [0, 0];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dd = 0; dd < 4; dd++) {
      const q = this.laneQ(tx + dx, ty + dy, dd);
      if (!q) continue;
      for (const o of q) {
        if (o === m || this.apart(m, o) || this.filtering(m, o)) continue;
        const ex = o.x - c[0], ey = o.y - c[1];
        if (ex * ex + ey * ey > ((m.len + o.len) / 2 + VEHICLE_WIDTH) ** 2 || !this.headingOf(o, h)) continue;
        // only what is ahead: a car behind me keeps its own distance (and a turning car's rear swings toward it)
        if (now && (o.x - m.x) * now.hx + (o.y - m.y) * now.hy <= 0) continue;
        const ob = { x: o.x, y: o.y, hx: h[0], hy: h[1], len: o.len };
        if (!obbOverlap(me, ob, o.med ? 0 : GUARD_MARGIN)) continue;
        if (now && obbOverlap(now, ob, 0)) continue; // already touching: moving on is how it ends
        return true;
      }
    }
    return false;
  }
  /** Is the point (x,y) inside (or within a pedestrian's radius of) any car body on the road? */
  carBodyAt(x: number, y: number): boolean {
    const tx = Math.floor(x), ty = Math.floor(y), h = this.tmp2;
    let fly = -1; // flyAt(x, y), once it is needed
    const L = this.nearL;
    for (let j = 0, nl = this.carGrid.near(tx, ty, L); j < nl; j++) {
      for (const m of L[j]) {
        if (m.lane < 0) continue;
        const ex = x - m.x, ey = y - m.y;
        if (ex * ex + ey * ey > 0.36) continue;
        if (this.flyAt(m.x, m.y)) continue;
        if (fly < 0) fly = this.flyAt(x, y) ? 1 : 0;
        if (fly || !this.headingOf(m, h)) continue;
        if (Math.abs(ex * h[0] + ey * h[1]) < m.len / 2 + PED_R && Math.abs(-ex * h[1] + ey * h[0]) < widthOf(m) / 2 + PED_R) return true;
        const mh = TT.guardDrawn & 2 ? this.motion.get(m) : undefined; // and as drawn, facing its last move
        if (mh && Math.abs(ex * mh[0] + ey * mh[1]) < m.len / 2 + PED_R && Math.abs(-ex * mh[1] + ey * mh[0]) < widthOf(m) / 2 + PED_R) return true;
      }
    }
    return false;
  }
  /**
   * The car holding m up, when it is another car (for the stuck rule): the car ahead in its lane, the tail of the
   * lane it is following into, the head of a full exit lane, the tail still in the box at a junction, or a car in the
   * next box whose movement conflicts with m's. Null when m is held by something else (a light, pedestrians) or free.
   */
  holderOf(m: Mover): Mover | null {
    if (m.lane < 0) return null;
    const q = this.laneAt(m.lane);
    if (!q) return null;
    const idx = q.indexOf(m);
    if (idx > 0 && !this.w.anyRoadClass) return q[idx - 1];
    if (idx > 0) { const l = leaderIn(q, idx, isBike(m), m.s1 ?? 0) ?? (isBike(m) ? null : leaderIn(q, idx, true)); if (l) return l; } // the car ahead in its own lane (or a bike it follows)
    const n = m.path.length / 2;
    if (m.pi >= n) return null;
    const ax = m.path[(m.pi - 1) * 2], ay = m.path[(m.pi - 1) * 2 + 1], bx = m.path[m.pi * 2], by = m.path[m.pi * 2 + 1];
    const dir = dirBetween(ax, ay, bx, by), last = m.pi + 1 >= n;
    const fly = isFlyoverAux(this.junctionAux(bx, by)) || (this.w.anyRoadClass && isDeckClassAux(this.classAux(bx, by)));
    const M = this.boxM, I = this.boxIn, O = this.boxOut;
    const SI = this.boxSi, SO = this.boxSo, s1 = m.s1 ?? 0, s2 = m.s2 ?? 0;
    if (last) { for (let i = 0, k = this.inBox(bx, by); i < k; i++) if (M[i] !== m && !(fly && isEW(I[i]) !== isEW(dir)) && conflictsS(dir, dir, s1, s2, I[i], O[i], SI[i], SO[i])) return M[i]; return null; }
    const outD = this.nextDirOf(m);
    const nq = this.laneQ(bx, by, outD);
    if (m.committed) return nq && nq.length ? nq[nq.length - 1] : null;
    if (nq && nq.length && !this.laneRoom(bx, by, Traffic.laneKey(bx, by, outD), m, null, s2)) return nq[0];
    if (nq && nq.length && this.degreeOf(bx, by) >= 3) { const t = nq[nq.length - 1]; if (t.prog < this.clearAt(t) + MIN_GAP) return t; }
    for (let i = 0, k = this.inBox(bx, by); i < k; i++) if (M[i] !== m && !(fly && isEW(I[i]) !== isEW(dir)) && conflictsS(dir, outD, s1, s2, I[i], O[i], SI[i], SO[i])) return M[i];
    if (nq && nq.length) return nq[nq.length - 1];
    return null;
  }
  /**
   * Is m the first car in its lane, held at the stop line into a junction box or a level crossing? (The A/B harness's
   * smoothness measure: a stop there is the junction's, not the stream's.)
   */
  headAtStopLine(m: Mover): boolean { return this.standing(m) === 'junction'; }
  /**
   * Where a standing car stands (the A/B harness's stop breakdown): first in its lane at the stop line into a junction
   * box or a level crossing ('junction'), into a plain road tile ('line') or its destination ('dest'); behind another
   * car ('queue'); anywhere else ('other': the body guard, a bus halt, a lane it has just come into).
   */
  standing(m: Mover): 'junction' | 'line' | 'dest' | 'queue' | 'other' {
    if (m.lane < 0 || m.pi * 2 + 1 >= m.path.length) return 'other';
    const q = this.laneAt(m.lane);
    if (q && leaderIn(q, q.indexOf(m), isBike(m), m.s1 ?? 0)) return 'queue';
    if (m.committed || m.prog < this.stopLine(m) - 0.05) {
      // the tail of the next lane close ahead holds it like a car in its own lane
      const n = m.path.length / 2;
      if (m.pi + 1 < n) { const nq = this.laneQ(m.path[m.pi * 2], m.path[m.pi * 2 + 1], this.nextDirOf(m)); if (nq && nq.length && 1 - m.prog + nq[nq.length - 1].prog < 0.6) return 'queue'; }
      return 'other';
    }
    if (m.pi + 1 >= m.path.length / 2) return 'dest';
    const bx = m.path[m.pi * 2], by = m.path[m.pi * 2 + 1];
    return this.degreeOf(bx, by) >= 3 || this.isCrossingAt(bx, by) ? 'junction' : 'line';
  }
  /**
   * Why m is held up (R5, the heat overlay's explanation and the Traffic panel), from the same tests the entry rules make:
   * an index into JAM_CAUSES (0 following the car ahead, 1 held at a red light, 2 waiting for a gap, 3 the box ahead
   * blocked, 4 getting into its destination, 5 slowed for a turn), or -1 when it is moving freely. Read-only: called
   * only when a client asks (jamWhy), never by the tick.
   */
  whyHeld(m: Mover): number {
    if (m.lane < 0 || m.pi < 1 || m.pi * 2 + 1 >= m.path.length) return -1;
    const n = m.path.length / 2, bx = m.path[m.pi * 2], by = m.path[m.pi * 2 + 1];
    const dir = dirBetween(m.path[(m.pi - 1) * 2], m.path[(m.pi - 1) * 2 + 1], bx, by), outD = this.nextDirOf(m);
    const turning = (outD !== dir && m.prog > 0.3) || (m.inDir !== dir && m.prog < 0.3);
    if (m.wait < 2) return turning && (m.v ?? 0) < DRIVE_SPEED * 0.4 ? 5 : -1;
    // short of the stop line: the car ahead in its own lane (this tile's, or the next tile's tail), else a turn or a bus stop
    const q = this.laneAt(m.lane);
    if (q && leaderIn(q, q.indexOf(m), isBike(m), m.s1 ?? 0)) return 0;
    if (m.committed || m.prog < this.stopLine(m) - 0.05) {
      if (m.pi + 1 < n) { const nq = this.laneQ(bx, by, outD), t = nq && nq.length ? leaderIn(nq, nq.length, isBike(m), m.s2 ?? 0) : null; if (t && 1 - m.prog + t.prog < 0.6) return 0; }
      return turning ? 5 : m.dwell ? -1 : 0;
    }
    if (m.pi + 1 >= n) return 4;
    if (this.degreeOf(bx, by) >= 3 && this.lightHolds(m, m.pi, dir)) return 1;
    if ((this.w.anyRoadClass || this.w.roadRules.size > 0) && this.pelicanAt(bx, by)) { const l = this.pelicanLamp(bx, by); if (l === 'amber' || l === 'red') return 1; }
    const nq = this.laneQ(bx, by, outD);
    if (nq && nq.length && !this.laneRoom(bx, by, Traffic.laneKey(bx, by, outD), m, null, m.s2 ?? 0)) return 3;
    if (TT.boxClear && this.degreeOf(bx, by) >= 3 && !this.roomBeyond(m, bx, by, outD, nq ?? null)) return 3;
    return 2;
  }
  /**
   * Is anything queued behind m: following it in its own lane, or in the lane that leads into the tile its lane starts
   * from (a bus standing at a stop holds those up)?
   */
  queuedBehind(m: Mover): boolean {
    if (m.lane < 0 || m.pi < 1) return false;
    const q = this.laneAt(m.lane);
    if (q && q.indexOf(m) < q.length - 1) return true;
    const ax = m.path[(m.pi - 1) * 2], ay = m.path[(m.pi - 1) * 2 + 1], d = m.inDir;
    const b = this.laneQ(ax - DIRS[d][0], ay - DIRS[d][1], d);
    return !!b && b.length > 0;
  }
  /** Has a car been held at the stop line into tile (x,y) for at least `ticks` (pedYieldAfter)? */
  carWaitingInto(x: number, y: number, ticks: number): boolean {
    for (let d = 0; d < 4; d++) {
      const q = this.laneQ(x - DIRS[d][0], y - DIRS[d][1], d);
      if (!q || !q.length) continue;
      // the head of the lane, and on a two-lane road the head of the left-hand lane too
      for (let j = 0, seen = 0; j < q.length && seen < 2; j++) {
        const h = q[j];
        if (j > 0 && (!this.w.anyRoadClass || !h.s1 || q.slice(0, j).some((o) => o.s1))) continue;
        seen++;
        if (!h.committed && h.wait >= ticks && h.pi * 2 + 1 < h.path.length && h.path[h.pi * 2] === x && h.path[h.pi * 2 + 1] === y) return true;
        if (!this.w.anyRoadClass) break;
      }
    }
    return false;
  }
  /** A walker moved this tick (the body guard reads its position live). */
  noteWalker(m: Mover) {
    this.walkCur.add(Math.floor(m.x), Math.floor(m.y), m);
  }
  private tmp2: [number, number] = [0, 0];

  /** The direction a car last moved in (how the client draws it), or false before it has moved. */
  motionOf(m: Mover, out: [number, number]): boolean {
    const h = this.motion.get(m);
    if (!h) return false;
    out[0] = h[0]; out[1] = h[1];
    return true;
  }
  /** Is the mover in the backing-up part of a three-point turn (the client draws it facing against its motion)? */
  reversing(m: Mover): boolean {
    const s = this.turnProgress(m);
    return s >= KTURN.rev0 && s <= KTURN.rev1;
  }
  /** Does a bus turn round on the tile of its halt (a stop at a dead end: it halts once it has turned)? */
  private turnsAtHalt(m: Mover): boolean {
    const h = m.halt ?? -1, p = m.path;
    return h >= 1 && (h + 1) * 2 + 1 < p.length && p[(h - 1) * 2] === p[(h + 1) * 2] && p[(h - 1) * 2 + 1] === p[(h + 1) * 2 + 1];
  }
  /** Has a bus come to its halt (sim/transit.ts): into the lane after the stop's road tile, and turned round if it turns there? */
  atHalt(m: Mover): boolean {
    const h = m.halt ?? -1;
    return h >= 0 && m.pi === h + 1 && m.lane >= 0 && (!this.turnsAtHalt(m) || m.prog >= HALT_TURNED - 0.02);
  }
  /** How far through a turn round the mover is (0..1 through the three-point turn), -1 when it is not turning round. */
  turnProgress(m: Mover): number {
    if (m.lane < 0 || m.pi < 1 || m.pi * 2 + 1 >= m.path.length) return -1;
    const d = laneDir(m.lane);
    const back = m.prog >= 0.5 ? this.nextDirOf(m) === OPP[d] : m.inDir === OPP[d];
    return back ? (m.prog >= 0.5 ? m.prog - 0.5 : m.prog + 0.5) : -1;
  }
  /** Unit heading of a car on the road from its lane geometry (body-overlap checks); false when it is not on a lane. */
  headingOf(m: Mover, out: [number, number]): boolean {
    if (m.lane < 0 || m.pi < 1 || m.pi * 2 + 1 >= m.path.length) return false;
    // cached per position: most cars are queued and do not move between the many checks of one tick
    const c = this.headings.get(m);
    if (c && c[0] === m.prog && c[1] === m.lane && c[2] === m.pi && c[5] === m.path.length) { out[0] = c[3]; out[1] = c[4]; return true; }
    const a = this.hA, b = this.hB;
    const p0 = Math.max(0, m.prog - 0.01), p1 = Math.min(0.999, m.prog + 0.01);
    this.posAt(m, p0, a); this.posAt(m, p1, b);
    const dx = b[0] - a[0], dy = b[1] - a[1], d = hypot(dx, dy);
    if (d < 1e-6) return false;
    out[0] = dx / d; out[1] = dy / d;
    if (c) { c[0] = m.prog; c[1] = m.lane; c[2] = m.pi; c[3] = out[0]; c[4] = out[1]; c[5] = m.path.length; }
    else this.headings.set(m, [m.prog, m.lane, m.pi, out[0], out[1], m.path.length]);
    return true;
  }
  private headings = new WeakMap<Mover, number[]>();
  private hA: [number, number] = [0, 0]; private hB: [number, number] = [0, 0];
  /** each car's direction of its last move, which is how the client orients it */
  private motion = new WeakMap<Mover, number[]>();

  /** May `m`, waiting at the edge of tile B, drive into it and on into lane (B→C)? */
  private canEnter(m: Mover, bx: number, by: number, inD: number, outD: number): boolean {
    const nextKey = Traffic.laneKey(bx, by, outD);
    const nq = this.laneAt(nextKey);
    if (!this.laneRoom(bx, by, nextKey, m, TT.platoon ? this.goingInAhead(m, outD) : null, m.s2 ?? 0)) return false;
    // level crossings: never onto one with the barriers down, and only with room to get right off it on the far side;
    // a car still on one when they come down drives off whatever is ahead (lights, give-way, people waiting)
    const ax = m.path[(m.pi - 1) * 2], ay = m.path[(m.pi - 1) * 2 + 1], onXing = this.isCrossingAt(ax, ay);
    if (!onXing && this.isCrossingAt(bx, by) && (this.crossingClosed(bx, by, inD) || !this.offCrossing(m, bx, by, outD, nq ?? null))) return false;
    const trapped = onXing && this.crossingClosed(ax, ay, inD);
    const deg = this.degreeOf(bx, by);
    // nobody waits in a junction box for a level crossing's barriers: they hold at the junction's stop line instead
    if (deg >= 3 && this.crossingClosed(bx + DIRS[outD][0], by + DIRS[outD][1], outD)) return false;
    const ja = this.junctionAux(bx, by), classes = this.w.anyRoadClass;
    const ring = (isRingAux(ja) || (classes && isRingClassAux(this.classAux(bx, by)))) && TT.ringMerge > 0;
    if (nq && nq.length && deg >= 3 && !ring) {
      // at a junction the car ahead in the exit lane must be out of the box before we go in behind it;
      // on plain road the following gap in step() is all that is needed, so cars can close up inside a tile
      const tail = leaderIn(nq, nq.length, isBike(m), m.s2 ?? 0);
      if (tail && tail.prog < this.clearAt(tail) + MIN_GAP && !(TT.platoon && (TT.platoon === 1 || this.junction(bx, by).signal) && this.platoonBehind(m, tail, inD))
        && !(classes && this.platoonFast(m, tail, inD, ax, ay, bx, by))) return false;
    }
    // a mini-roundabout (R4) holds one car at a time: it needs no don't-block-the-box rule
    if (TT.boxClear && (deg >= 3 || TT.boxClear >= 2) && ja !== MINI_AUX && !this.roomBeyond(m, bx, by, outD, nq ?? null)) return false;
    const jb = deg >= 3 ? this.junction(bx, by) : null, signal = !!jb && jb.signal && !trapped;
    const walkers = trapped ? 0 : this.crossingsAt(bx, by);
    if (walkers && ((!signal && !isRingAux(ja)) || (walkers & movementMask(inD, outD)))) {
      // at lights only the crossings this movement drives over hold it (straight through on green passes people crossing the red road);
      // on a roundabout people cross the arms, which cars going round never drive over
      if (TT.carYieldMax <= 0 || m.wait < TT.carYieldMax) return false;
      if (!this.predicting) this.cnt.carNosed++;
    }
    // green for my approach axis, and not its amber: cars already committed clear the box before the other axis goes
    // (a junction group's lights, R4, gate only cars coming into the group: lightHolds)
    if (signal && !m.priority) {
      if (jb!.g) { if (this.lightHolds(m, m.pi, inD)) return false; }
      else { const ph = this.signalPhase(bx, by); if ((ph.green === 'ew') !== isEW(inD) || ph.amber) return false; }
    }
    if (TT.ringYield > 0 && isRingAux(ja) && !m.priority && !trapped && !this.ringGiven(m, bx, by, inD, outD, ja)) return false;
    // R4's junctions (a big roundabout, a mini-roundabout, a signal crossing, the median box): their own entry rules
    if ((ja || classes || this.w.roadRules.size) && !this.r4Entry(m, ax, ay, bx, by, inD, outD, ja, deg, trapped)) return false;
    // a slip road: from any other road onto a motorway, give way to the cars coming along it (roadclass.ts), lights or none
    if (this.w.anyRoadClass && !m.priority && !trapped && m.wait < TT.minorWaitMax * 3) {
      const cb = this.classAux(bx, by);
      if (isMotorwayAux(cb) && !isMotorwayAux(this.classAux(ax, ay)) && !(isDeckClassAux(cb) && deckAxisStep(cb, DIRS[inD][0])) && this.mainComing(m, bx, by, inD, outD, isEW(auxDir(cb)) ? 1 : 0, this.slipGap(cb))) return false;
    }
    // main-road priority without lights: from a side road, give way to cars coming along the main one
    if (TT.mainRoad && deg >= 3 && !signal && !ja && !m.priority && !trapped && m.wait < TT.minorWaitMax) {
      const main = this.mainAxis(bx, by);
      if (main >= 0 && (isEW(inD) ? 1 : 0) !== main && this.mainComing(m, bx, by, inD, outD, main)) return false;
    }
    if (!trapped && this.w.anyRoadClass && !this.overMedian(m, bx, by, outD)) return false;
    return !this.boxConflict(m, bx, by, inD, outD, trapped);
  }
  /**
   * The entry rules of R4's junctions (canEnter): may m go on into tile B? A big roundabout's give way and never full; a
   * mini-roundabout's give way to the left; a signal crossing's amber and red; the median box's one car a way.
   */
  private r4Entry(m: Mover, ax: number, ay: number, bx: number, by: number, inD: number, outD: number, ja: number, deg: number, trapped: boolean): boolean {
    if (trapped) return true;
    const classes = this.w.anyRoadClass;
    // a big roundabout: coming on, give way to the ring and never fill it
    if (classes && !m.priority && isRingClassAux(this.classAux(bx, by)) && !this.bigRingGiven(m, ax, ay, bx, by)) return false;
    // a mini-roundabout: giving way to a car coming in from the left (one car in the box at a time with miniOne)
    if (ja === MINI_AUX && !this.miniGiven(m, bx, by, inD)) return false;
    // a signal crossing: stop on its amber and red (cars already on it drive off)
    if (!m.priority && deg < 3 && (classes || this.w.roadRules.size) && this.pelicanAt(bx, by)) {
      const lamp = pelicanPhase(this.walkAtOf(bx, by), this.w.tick + this.lookTicks);
      if (lamp === 'amber' || lamp === 'red') return false;
    }
    // the median box holds one car a way: nobody comes into B to cross the reservation while one is waiting to
    if (classes && TT.medianBox && this.medianEdge(bx, by, outD) && this.medianTaken(m, bx, by, outD)) return false;
    return true;
  }
  /**
   * Is the edge out of junction tile B heading d a crossing of a divided road's reservation inside one junction group
   * (R4: B and the tile beyond in the same group of two or four tiles)? There a car may wait in the median box.
   */
  private medianEdge(bx: number, by: number, d: number): boolean {
    if (!isDividedAux(this.classAux(bx, by)) || this.degreeOf(bx, by) < 3) return false;
    const g = this.junction(bx, by).g;
    return !!g && inGroup(g, bx + DIRS[d][0], by + DIRS[d][1]);
  }
  /** Does m, held at the edge of the next tile, wait in the median box over a divided road's reservation (R4)? */
  private medianWaits(m: Mover, ax: number, ay: number, dir: number): boolean {
    return !!m.med || (TT.medianBox > 0 && m.len <= MEDIAN_LEN && this.medianEdge(ax, ay, dir));
  }
  /**
   * How far m may move towards its median box this tick: up to the edge between the carriageways (centred on it, clear
   * of both), rather than the stop line in the first carriageway's box; it is in the median once there.
   */
  private medianAllowed(m: Mover, allowed: number): number {
    const a = Math.max(0, Math.min(allowed, MEDIAN_PROG - m.prog));
    if (m.prog + a >= MEDIAN_PROG - 1e-9) m.med = true;
    return a;
  }
  /** Is the median box out of B heading d taken (a car other than m in lane B→d not yet let on over the reservation)? */
  private medianTaken(m: Mover, bx: number, by: number, d: number): boolean {
    const q = this.laneQ(bx, by, d);
    if (q) for (const o of q) if (o !== m && !o.committed) return true;
    return false;
  }
  /**
   * Crossing a divided road (roadclass.ts): a car going from one of its junction tiles B straight on into the other, C
   * (over the central reservation), may go into B and wait there for a gap in C's traffic, as a car waits in a box to
   * turn, but not while a car crossing the other way is in C's box heading into B: each would stand in one box
   * waiting for the other's (the twin-box deadlock), so the first one in goes first. True when that is not the move.
   */
  private overMedian(m: Mover, bx: number, by: number, outD: number): boolean {
    const a = this.classAux(bx, by);
    if (!isDividedAux(a) || oneWayDir(a) >= 0) return true;
    const i = m.pi + 1, n = m.path.length / 2;
    if (i + 1 >= n) return true;
    const cx = m.path[i * 2], cy = m.path[i * 2 + 1];
    if (cx !== bx + DIRS[outD][0] || cy !== by + DIRS[outD][1]) return true;
    const c = this.classAux(cx, cy);
    if (!isDividedAux(c) || oneWayDir(c) >= 0 || auxDir(c) === auxDir(a) || isEW(auxDir(c)) !== isEW(auxDir(a))) return true; // not its twin across the reservation
    for (let k = 0, nb = this.inBox(cx, cy); k < nb; k++) {
      const o = this.boxM[k];
      if (o === m || o.lane < 0) continue;
      // o's tile after C: B means it is crossing towards me
      const j = laneTile(o.lane) === tkey(cx, cy) ? o.pi : o.pi + 1;
      if (j * 2 + 1 < o.path.length && o.path[j * 2] === bx && o.path[j * 2 + 1] === by) return false;
    }
    return true;
  }
  /**
   * The main road through junction (x, y) (TRAFFIC_TUNING.mainRoad): 0 north-south, 1 east-west, -1 none (every arm
   * gives way to whatever is in the box, first come first served). At a T-junction the two arms in line are the main
   * road; at a crossroads (mainRoad 2) the road with the longer straight run either side (by at least 3 tiles), worked
   * out again every MAIN_TTL ticks. Road classes (R3) are the hook: `roadRank`, when set, ranks each arm's road and a
   * higher rank wins before straightness is looked at.
   */
  private mainAxis(x: number, y: number): number {
    const j = this.junction(x, y), t = this.w.tick;
    if (j.main !== undefined && t - (j.mainAt ?? 0) < MAIN_TTL) return j.main;
    const road = (dx: number, dy: number) => this.isRoadAt(x + dx, y + dy);
    const ns = road(0, -1) && road(0, 1), ew = road(1, 0) && road(-1, 0);
    let main = -1;
    if (this.roadRank) {
      const r = this.roadRank, rn = Math.max(r(x, y - 1), r(x, y + 1)), re = Math.max(r(x + 1, y), r(x - 1, y));
      if (rn !== re) main = rn > re ? 0 : 1;
    }
    if (main < 0 && ns !== ew) main = ns ? 0 : 1; // a T: the arms in line
    else if (main < 0 && ns && ew && TT.mainRoad >= 2) {
      const run = (dx: number, dy: number) => { let n = 0; while (n < 16 && this.isRoadAt(x + dx * (n + 1), y + dy * (n + 1))) n++; return n; };
      const ln = Math.min(run(0, -1), run(0, 1)), le = Math.min(run(1, 0), run(-1, 0));
      if (Math.abs(ln - le) >= 3) main = ln > le ? 0 : 1;
    }
    j.main = main; j.mainAt = t;
    return main;
  }
  /** Road classes, when they come (R3): the rank of the road on tile (x, y), higher for a bigger road. Null: straightness decides. */
  roadRank: ((x: number, y: number) => number) | null = null;
  /**
   * Is a car coming along the main road (axis `main`) into box B, moving, within mainGap tiles of its stop line, whose
   * movement through the box crosses m's (inD -> outD)?
   */
  private mainComing(m: Mover, bx: number, by: number, inD: number, outD: number, main: number, gap = TT.mainGap): boolean {
    const reach = gap > 2 ? Math.ceil(gap) : 2; // lanes back to look along: two, more for a fast road's wider gap
    for (let d = 0; d < 4; d++) {
      if ((isEW(d) ? 1 : 0) !== main) continue;
      const ax = bx - DIRS[d][0], ay = by - DIRS[d][1];
      for (let back = 0; back < reach; back++) {
        const q = this.laneQ(ax - back * DIRS[d][0], ay - back * DIRS[d][1], d);
        if (q) for (const c of q) {
          if (c === m || c.committed || c.wait >= 2) continue;
          const k = c.pi + back;
          if (k * 2 + 1 >= c.path.length || c.path[k * 2] !== bx || c.path[k * 2 + 1] !== by) continue;
          const to = back ? (k + 1 < c.path.length / 2 ? dirBetween(bx, by, c.path[(k + 1) * 2], c.path[(k + 1) * 2 + 1]) : d) : this.nextDirOf(c);
          if (back + this.stopLine(c) - c.prog > gap) continue;
          if (conflictsS(inD, outD, m.s1 ?? 0, m.s2 ?? 0, d, to, back ? c.s2 ?? 0 : c.s1 ?? 0, back ? 0 : c.s2 ?? 0)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Platoons (TRAFFIC_TUNING.platoon): may m follow `t`, the tail of its exit lane still in the box, straight in? Only
   * when t came in by the same approach (so the same movement: one lane per approach), is moving at platoonV or more,
   * and m's nose is within platoonGap of t's tail.
   */
  private platoonBehind(m: Mover, t: Mover, inD: number): boolean {
    return t.inDir === inD && (t.v ?? 0) >= TT.platoonV && 1 - m.prog + t.prog - (t.len + m.len) / 2 <= TT.platoonGap;
  }
  /**
   * Platoons on a motorway: through a junction tile of it (a slip road's mouth; nobody crosses a motorway, and a merger
   * has waited for the gap, `slipGap`), a car may follow one that went in by the same approach and is moving, within
   * platoonGap tiles of its tail scaled with the road's speed: a car doing 1.2 tiles a tick closes on the leader that
   * far in the tick the leader is still leaving the box, and holding it at the stop line stopped it dead from speed.
   * The following gap and every other entry rule still apply.
   */
  private platoonFast(m: Mover, t: Mover, inD: number, ax: number, ay: number, bx: number, by: number): boolean {
    const cb = this.classAux(bx, by);
    if (!TT.platoon || !isMotorwayAux(cb) || !isMotorwayAux(this.classAux(ax, ay))) return false;
    return t.inDir === inD && (t.v ?? 0) >= TT.platoonV && 1 - m.prog + t.prog - (t.len + m.len) / 2 <= TT.platoonGap * classDef(cb & 7).speed;
  }
  /**
   * The cars ahead of m in its own lane already committed into the lane heading outD after the next tile (they will
   * take room there before m: with platoons a car may commit while the one ahead is still on its way in), or null.
   */
  private goingInAhead(m: Mover, outD: number): Mover[] | null {
    const q = this.laneAt(m.lane);
    let out: Mover[] | null = null;
    if (q) for (const o of q) {
      if (o === m) break;
      if (o.committed && o.path[o.pi * 2] === m.path[m.pi * 2] && o.path[o.pi * 2 + 1] === m.path[m.pi * 2 + 1] && this.nextDirOf(o) === outD && (o.s2 ?? 0) === (m.s2 ?? 0)) (out ??= []).push(o);
    }
    return out;
  }

  /**
   * Give way on entry to a roundabout: may m come onto ring tile B (aux a) by heading inD, to leave it heading outD?
   * Always when it is already on the ring; from an arm or a driveway only while no car circulating towards B that
   * stays on the ring past it (into the lane m joins), and moving, is within TRAFFIC_TUNING.ringYield tiles of B's
   * box (the lane into B from the ring tile before it, and the lane before that). Cars leaving by B's arm cross nobody.
   */
  private ringGiven(m: Mover, bx: number, by: number, inD: number, outD: number, a: number): boolean {
    const ax = bx - DIRS[inD][0], ay = by - DIRS[inD][1];
    const [ix, iy] = islandOf(bx, by, a), p = ringPos(a);
    const prev = this.junctionAux(ax, ay);
    if (isRingAux(prev)) { const [jx, jy] = islandOf(ax, ay, prev); if (jx === ix && jy === iy) return true; }
    const gap = TT.ringYield, nx = bx + DIRS[outD][0], ny = by + DIRS[outD][1];
    const ux = ix + RING_POS[(p + 7) & 7][0], uy = iy + RING_POS[(p + 7) & 7][1];
    const vx = ix + RING_POS[(p + 6) & 7][0], vy = iy + RING_POS[(p + 6) & 7][1];
    /** does c's route pass node k of its path at (x, y)? */
    const at = (c: Mover, k: number, x: number, y: number) => k * 2 + 1 < c.path.length && c.path[k * 2] === x && c.path[k * 2 + 1] === y;
    const q1 = this.laneQ(ux, uy, dirBetween(ux, uy, bx, by));
    if (q1) for (const c of q1) if (c !== m && c.wait < 2 && at(c, c.pi + 1, nx, ny) && this.stopLine(c) - c.prog < gap) return false;
    const q0 = this.laneQ(vx, vy, dirBetween(vx, vy, ux, uy));
    if (q0) for (const c of q0) if (c !== m && c.wait < 2 && at(c, c.pi + 1, bx, by) && at(c, c.pi + 2, nx, ny) && 1 - c.prog + this.stopLine(c) < gap) return false;
    // never fill the ring: with every lane round it full nobody can move on (each waits for room in the next), so a
    // car comes on only while TRAFFIC_TUNING.ringSpare places stay free, counting cars already committed coming on
    const cap = TT.laneByLength ? Math.floor(TT.laneRoom / (VEHICLE_LEN[0] + MIN_GAP)) : TT.laneCap;
    let n = 1;
    for (let q = 0; q < 8; q++) {
      const rx = ix + RING_POS[q][0], ry = iy + RING_POS[q][1], sx = ix + RING_POS[(q + 1) & 7][0], sy = iy + RING_POS[(q + 1) & 7][1];
      n += this.laneQ(rx, ry, dirBetween(rx, ry, sx, sy))?.length ?? 0;
      if (q & 1) continue;
      // the way in at this side: from the arm (two out from the island) towards the middle tile
      const ox = rx + RING_POS[q][0], oy = ry + RING_POS[q][1];
      const lane = this.laneQ(ox, oy, dirBetween(ox, oy, rx, ry));
      if (lane) for (const c of lane) if (c !== m && c.committed) n++;
    }
    return n <= 8 * cap - TT.ringSpare;
  }
  /**
   * Give way on to a big roundabout (R4, road class 6): may m, coming from A (not a ring tile), come onto ring tile B?
   * Not while a car going round, and moving, is within ringYield of B's box on the ring tile before it (or the one before
   * that) and stays on the ring past B, unless m has waited minorWaitMax already (the box rules still hold it while
   * anything crosses its way); and never when the ring would fill (bigRingSpare places free, both lanes).
   */
  private bigRingGiven(m: Mover, ax: number, ay: number, bx: number, by: number): boolean {
    if (isRingClassAux(this.classAux(ax, ay))) return true;
    const gap = TT.ringYield;
    const on = (c: Mover, k: number) => k * 2 + 1 < c.path.length && isRingClassAux(this.classAux(c.path[k * 2], c.path[k * 2 + 1]));
    const at = (c: Mover, k: number, x: number, y: number) => k * 2 + 1 < c.path.length && c.path[k * 2] === x && c.path[k * 2 + 1] === y;
    // the ring tile before B, and the one before that
    let px = 0, py = 0, pd = -1;
    for (let d = 0; d < 4; d++) { const tx = bx - DIRS[d][0], ty = by - DIRS[d][1], a = this.classAux(tx, ty); if (isRingClassAux(a) && auxDir(a) === d) { px = tx; py = ty; pd = d; break; } }
    // a driver held this long by the ring's traffic goes when the box is clear anyway (no starving), as at a main road
    if (pd >= 0 && gap > 0 && m.wait < TT.minorWaitMax) {
      // joining the outer lane, a car going round in the inner one that stays there crosses nobody
      const outer = !(m.s2 ?? 0);
      const q1 = this.laneQ(px, py, pd);
      if (q1) for (const c of q1) if (c !== m && c.wait < 2 && at(c, c.pi, bx, by) && on(c, c.pi + 1) && !(outer && c.s1 && c.s2) && this.stopLine(c) - c.prog < gap) return false;
      for (let d = 0; d < 4; d++) {
        const tx = px - DIRS[d][0], ty = py - DIRS[d][1], a = this.classAux(tx, ty);
        if (!isRingClassAux(a) || auxDir(a) !== d) continue;
        const q0 = this.laneQ(tx, ty, d);
        if (q0) for (const c of q0) if (c !== m && c.wait < 2 && at(c, c.pi, px, py) && at(c, c.pi + 1, bx, by) && on(c, c.pi + 2) && 1 - c.prog + this.stopLine(c) < gap) return false;
        break;
      }
    }
    // never fill the ring: round its sixteen tiles by their ways out, counting the cars on it and those committed coming on
    const cap = TT.laneByLength ? Math.floor(TT.laneRoom / (VEHICLE_LEN[0] + MIN_GAP)) : TT.laneCap;
    let n = 1, tx = bx, ty = by;
    for (let i = 0; i < 16; i++) {
      const a = this.classAux(tx, ty);
      if (!isRingClassAux(a)) break;
      const d = auxDir(a);
      n += this.laneQ(tx, ty, d)?.length ?? 0;
      for (let e = 0; e < 4; e++) {
        if (e === d) continue;
        const sx = tx - DIRS[e][0], sy = ty - DIRS[e][1];
        if (isRingClassAux(this.classAux(sx, sy))) continue;
        const lane = this.laneQ(sx, sy, e);
        if (lane) for (const c of lane) if (c !== m && c.committed) n++;
      }
      tx += DIRS[d][0]; ty += DIRS[d][1];
      if (tx === bx && ty === by) break;
    }
    return n <= 16 * 2 * cap - TT.bigRingSpare;
  }
  /**
   * A mini-roundabout (R4, MINI_AUX): may m, coming in heading inD, go into its box? With miniOne only when nobody else is
   * in it (otherwise the box's own conflict rules decide, after this), and not while a moving car is about to come in from
   * the arm on m's left (traffic goes round anticlockwise, so that is
   * the way the cars going round come from) within miniYield of the box. Cars that are all standing give way to nobody:
   * the first to move goes, so four waiting at once never lock.
   */
  private miniGiven(m: Mover, bx: number, by: number, inD: number): boolean {
    if (TT.miniOne && this.boxBusyExcept(bx, by, m)) return false;
    if (TT.miniYield <= 0 || m.wait >= TT.minorWaitMax) return true;
    const e = RIGHT[inD], q = this.laneQ(bx - DIRS[e][0], by - DIRS[e][1], e);
    if (q) for (const c of q) {
      if (c === m || c.committed || c.wait >= 2 || c.pi * 2 + 1 >= c.path.length) continue;
      if (c.path[c.pi * 2] !== bx || c.path[c.pi * 2 + 1] !== by) continue;
      if (this.stopLine(c) - c.prog < TT.miniYield) return false;
    }
    return true;
  }

  // ---- signal crossings (pelicans, R4: shared/src/signals.ts pelicanPhase) ------------------------------------------

  /** Is (x, y) a signal crossing: one placed (a road rule) or where a pedestrian street crosses a street? Cached per tile. */
  pelicanAt(x: number, y: number): boolean {
    if (this.w.rulesVersion !== this.rulesSeen) { this.rulesSeen = this.w.rulesVersion; for (const rc of this.roads.values()) rc.pel.fill(-1); }
    const rc = this.roadChunk(x, y), i = localIndex(x, y);
    let v = rc.pel[i];
    if (v < 0) {
      v = this.isRoadAt(x, y) && (!!this.w.roadRuleAt(x, y)?.pelican || (this.w.anyRoadClass && !!implicitPelican(this.roadAt, (tx, ty) => this.classAux(tx, ty), x, y))) ? 1 : 0;
      rc.pel[i] = v;
    }
    return v === 1;
  }
  private rulesSeen = -1;
  /** each signal crossing's last walk grant (shared/src/signals.ts pelicanPhase), by tile key; the grants made since the last drainWalks, flat [x, y, walkAt, ...] */
  private walks = new Map<number, number>();
  private freshWalks: number[] = [];
  walkAtOf(x: number, y: number): number { return this.walks.get(tkey(x, y)) ?? -1e9; }
  /** What a signal crossing's lamps show cars now. */
  pelicanLamp(x: number, y: number) { return pelicanPhase(this.walkAtOf(x, y), this.w.tick); }
  /** A walker at the kerb presses the button: the walk phase is granted at once when the last cycle and its minimum green are done. */
  pressPelican(x: number, y: number) {
    const at = this.walkAtOf(x, y);
    if (!pelicanReady(at, this.w.tick + 1)) return;
    const t = this.w.tick + 1;
    this.walks.set(tkey(x, y), t);
    this.freshWalks.push(x, y, t);
  }
  /** Every crossing's last grant, for a client joining (flat [x, y, walkAt, ...]). */
  walksList(): number[] { const out: number[] = []; for (const [k, t] of this.walks) out.push(tileX(k), tileY(k), t); return out; }
  /** The grants since the last call, for the broadcast. */
  drainWalks(): number[] { const u = this.freshWalks; this.freshWalks = []; return u; }
  /**
   * Keep the track clear: may m drive onto level crossing B (on into lane B→C) expecting to get right off it? The car
   * ahead must be off it, and there must be room beyond (roomBeyond). With a junction straight after the crossing a
   * vehicle waits at that junction's stop line with its tail in B: a car is short enough to stand clear of the train
   * there, a longer vehicle goes on only when it could drive straight through the junction now (room in its exit lane,
   * nothing in its way in the box, the light green and not amber).
   */
  private offCrossing(m: Mover, bx: number, by: number, outD: number, nq: Mover[] | null): boolean {
    if (nq && nq.length) { const tail = leaderIn(nq, nq.length, isBike(m), m.s2 ?? 0); if (tail && tail.prog < this.clearAt(tail) + MIN_GAP) return false; }
    const i = m.pi + 1, n = m.path.length / 2;
    if (i + 1 >= n) return true; // C is where it is going: the forecourt rule decides
    const cx = m.path[i * 2], cy = m.path[i * 2 + 1];
    if (cx !== bx + DIRS[outD][0] || cy !== by + DIRS[outD][1] || this.degreeOf(cx, cy) < 3) return this.roomBeyond(m, bx, by, outD, nq);
    if (m.len <= XING_SHORT) return true;
    if (nq && nq.length) return false;
    const d2 = dirBetween(cx, cy, m.path[(i + 1) * 2], m.path[(i + 1) * 2 + 1]);
    const s3 = m.s2 || m.s1 ? this.strandFor(m, i, m.s2 ?? 0) : 0;
    if (!this.laneRoom(cx, cy, Traffic.laneKey(cx, cy, d2), m, null, s3)) return false;
    if (this.junction(cx, cy).signal && this.lightHolds(m, i, outD)) return false;
    return !this.boxConflict(m, cx, cy, outD, d2, false, m.s2 ?? 0, s3);
  }
  /** Is a movement inD -> outD through tile B blocked by a car already in that box? */
  private boxConflict(m: Mover, bx: number, by: number, inD: number, outD: number, trapped = false, ms1 = m.s1 ?? 0, ms2 = m.s2 ?? 0): boolean {
    const ja = this.junctionAux(bx, by), classes = this.w.anyRoadClass;
    const fly = isFlyoverAux(ja) || (classes && isDeckClassAux(this.classAux(bx, by))), ring = (isRingAux(ja) || (classes && isRingClassAux(this.classAux(bx, by)))) && TT.ringMerge > 0;
    for (let i = 0, n = this.inBox(bx, by); i < n; i++) {
      const om = this.boxM[i], oIn = this.boxIn[i], oOut = this.boxOut[i], si = this.boxSi[i], so = this.boxSo[i];
      if (om === m) continue;
      if (fly && isEW(oIn) !== isEW(inD)) continue; // on the deck or under it: the other road never meets this one
      if (ring && oOut === outD && om.lane === Traffic.laneKey(bx, by, outD)) continue; // ahead of me in the lane I merge into: I follow it
      if (!conflictsS(inD, outD, ms1, ms2, oIn, oOut, si, so)) continue;
      if (TT.conflictRemaining && (oIn !== inD || TT.sameApproachRelax >= 2) && om.lane === Traffic.laneKey(bx, by, oOut)) {
        // already on its way out: only the rest of its path from its rear bumper on can be in my way
        const rear = 0.5 + om.prog - om.len / 2 / ARC_S(oIn, oOut, si, so);
        if (rear > conflictLastS(inD, outD, ms1, ms2, oIn, oOut, si, so) + 0.04) continue;
      }
      // same approach, other exit: with the relaxation, go once the leader's tail is past the box centre on its way out
      if (TT.sameApproachRelax === 1 && oIn === inD && om.lane === Traffic.laneKey(bx, by, oOut) && om.prog >= om.len / 2 + MIN_GAP) continue;
      // a vehicle getting off a level crossing as the barriers come down goes past anyone standing clear of its path
      if ((TT.passStationary || trapped) && om.wait >= (trapped ? 1 : 2) && this.pathClearOf(m, bx, by, inD, outD, om, ms1, ms2)) continue;
      return true;
    }
    return false;
  }
  /** Does m's whole path through tile B (inD -> outD) keep its body clear of o's body where o stands now? */
  private pathClearOf(m: Mover, bx: number, by: number, inD: number, outD: number, o: Mover, s1 = 0, s2 = 0): boolean {
    const h: [number, number] = [0, 0];
    if (!this.headingOf(o, h)) return false;
    const ob = { x: o.x, y: o.y, hx: h[0], hy: h[1], len: o.len };
    const a: [number, number] = [0, 0], b: [number, number] = [0, 0], c: [number, number] = [0, 0];
    const o1 = strandOffset(s1), o2 = strandOffset(s2);
    for (let s = 0; s <= 1.0001; s += 0.1) {
      pathPoint(bx, by, inD, outD, s, o1, c, o2);
      pathPoint(bx, by, inD, outD, Math.max(0, s - 0.02), o1, a, o2);
      pathPoint(bx, by, inD, outD, Math.min(1, s + 0.02), o1, b, o2);
      const dx = b[0] - a[0], dy = b[1] - a[1], d = hypot(dx, dy) || 1;
      if (obbOverlap({ x: c[0], y: c[1], hx: dx / d, hy: dy / d, len: m.len }, ob, GUARD_MARGIN)) return false;
    }
    return true;
  }
  /**
   * Don't block the box: a car may go into junction B only if it will also be
   * let into the tile after it, counting the cars already in the exit lane
   * (they take those slots first). Plain-road next tiles only; at a junction
   * next door the ordinary entry rules there decide.
   */
  private roomBeyond(m: Mover, bx: number, by: number, outD: number, nq: Mover[] | null): boolean {
    const i = m.pi + 1, n = m.path.length / 2;
    if (i + 1 >= n) return true; // next tile is the destination
    const cx = m.path[i * 2], cy = m.path[i * 2 + 1];
    if (cx !== bx + DIRS[outD][0] || cy !== by + DIRS[outD][1]) return true;
    if (this.degreeOf(cx, cy) >= 3) return true;
    const dx = m.path[(i + 1) * 2], dy = m.path[(i + 1) * 2 + 1];
    const d2 = dirBetween(cx, cy, dx, dy);
    // cars already on their way into that exit lane take its room first: those in it, and those committed into B
    // from another approach that will turn into it
    const ahead: Mover[] = nq ? [...nq] : [];
    for (let d = 0; d < 4; d++) {
      const q = this.laneQ(bx - DIRS[d][0], by - DIRS[d][1], d);
      if (q) for (const o of q) if (o !== m && o.committed && this.nextDirOf(o) === outD) ahead.push(o);
    }
    return this.laneRoom(cx, cy, Traffic.laneKey(cx, cy, d2), m, ahead, m.s2 || m.s1 ? this.strandFor(m, i, m.s2 ?? 0) : 0);
  }

  /** A driver's acceleration (TRAFFIC_TUNING.follow): accel × their own style, slower for trucks and buses. */
  private accelOf(m: Mover, heavy: boolean): number {
    return TT.accel * (1 + TT.accelVar * (2 * hash2(m.id, 0x5a17) - 1)) * (heavy ? TT.heavyAccel : 1);
  }
  /**
   * A fast car's speed limit from what lies along its route (FAST_PACE): the fastest it may go this tick and still be
   * down to the pace of each slower road, each turn and each queue ahead by the time it gets there, braking at
   * TRAFFIC_TUNING.brake like a driver anywhere else. The rules in `leg` are exact for the tile ahead (the car in front
   * in its lane or the tail of the next lane, the stop line); at 1.4 tiles a tick that is a fraction of the 6 tiles it
   * takes to stop, and a car that only saw a queue one tile off would stop dead from speed. Looks at most HORIZON_MAX
   * tiles, and no further than it could use at its present speed.
   */
  private horizon(m: Mover, v: number, dir: number, heavy: boolean): number {
    const dec = TT.brake, n = m.path.length / 2, path = m.path, bike = isBike(m);
    const reach = Math.min(HORIZON_MAX, Math.ceil((v * v) / (2 * dec) + v * TT.headway + 1.5));
    const pace = DRIVE_SPEED * m.speedMul * (heavy ? 0.8 : 1);
    let cap = Infinity, prev = dir, judged = false;
    for (let j = m.pi; j < n && j - m.pi <= reach; j++) {
      const x = path[j * 2], y = path[j * 2 + 1];
      if (!this.isRoadAt(x, y)) break;
      const ca = this.classAux(x, y);
      const L = pace * (ca && !(isDeckClassAux(ca) && deckAxisStep(ca, DIRS[prev][0])) ? classDef(ca & 7).speed : 1);
      // a slower road: down to its pace at its near edge
      const dEdge = j - m.pi + 0.5 - m.prog;
      if (dEdge > 0 && L < v) cap = Math.min(cap, safeSpeed(dEdge, L, dec));
      if (j + 1 >= n) break;
      const nd = dirBetween(x, y, path[j * 2 + 2], path[j * 2 + 3]);
      // a junction tile of the road (a slip road's mouth): be at its stop line when the box is clear, not at speed when it is not
      if (!judged && j >= m.pi && this.degreeOf(x, y) >= 3) {
        judged = true;
        const ds = j - m.pi + this.stopLine(m) - m.prog;
        if (ds > 0.02) cap = Math.min(cap, this.boxCaution(m, v, x, y, prev, nd, ds, j === m.pi ? m.s1 ?? 0 : m.s2 ?? 0, m.s2 ?? 0));
      }
      // a turn here: down to its pace by 0.3 into the lane that comes into the tile (where leg() starts to slow a car)
      if (nd !== prev) {
        const vt = L * this.turnSlow(x, y) * (nd === OPP[prev] ? UTURN_SLOW : 1), dT = j - m.pi + 0.3 - m.prog;
        if (dT > 0 && vt < v) cap = Math.min(cap, safeSpeed(dT, vt, dec));
      }
      // a lane out of this tile with no room for me: leg() will hold me at its stop line, so be able to stop there
      {
        const ds = j - m.pi + this.stopLine(m) - m.prog;
        if (ds > 0.02 && !this.laneRoom(x, y, Traffic.laneKey(x, y, nd), m, null, m.s2 ?? 0)) return Math.min(cap, safeSpeed(ds, 0, dec));
      }
      // the nearest car standing or crawling in the lane out of this tile (the lane out of the next tile is the near rule's)
      if (j > m.pi) {
        const q = this.laneQ(x, y, nd);
        const t = q && q.length ? leaderIn(q, q.length, bike, m.s2 ?? 0) : null;
        if (t) {
          const room = j - m.pi + 1 - m.prog + t.prog - (t.len + m.len) / 2 - MIN_GAP * m.gapMul;
          return Math.min(cap, safeSpeed(room, t.v ?? 0, dec));
        }
      }
      prev = nd;
    }
    return cap;
  }
  /**
   * horizon(): the speed at which m, `ds` short of the stop line before junction tile (x, y) (in by inD, out by outD),
   * gets there as the box clears: for each car in the box whose movement conflicts with m's, the time it needs to get
   * its rear out (at its present pace) against the time m needs to arrive. A car that would arrive first is slowed to
   * arrive just after; one for a box that will not clear in a few ticks is slowed to stop at the line.
   */
  private boxCaution(m: Mover, v: number, x: number, y: number, inD: number, outD: number, ds: number, si: number, so: number): number {
    const dec = TT.brake, ta = ds / Math.max(v, 0.15);
    let cap = Infinity;
    for (let i = 0, n = this.inBox(x, y); i < n; i++) {
      const om = this.boxM[i];
      if (om === m || !conflictsS(inD, outD, si, so, this.boxIn[i], this.boxOut[i], this.boxSi[i], this.boxSo[i])) continue;
      const out = om.lane === Traffic.laneKey(x, y, this.boxOut[i]);
      const left = Math.max(0, (out ? 0 : 1 - om.prog) + this.clearAt(om) + MIN_GAP - (out ? om.prog : 0));
      const tc = left / Math.max(om.v ?? 0, 0.15) + 0.5;
      if (ta >= tc) continue;
      cap = Math.min(cap, tc >= 3 ? safeSpeed(ds, 0, dec) : ds / tc);
    }
    return cap;
  }
  /** How far back a car coming along a motorway tile of class byte `ca` makes a merger from a slip road wait (SLIP_GAP, scaled with the class's speed). */
  private slipGap(ca: number) { return Math.max(SLIP_GAP, (SLIP_GAP * classDef(ca & 7).speed) / SLIP_GAP_SPEED); }

  /**
   * Look-ahead (TRAFFIC_TUNING.lookAhead): would m, `ds` short of its stop line and wanting to go at v, be let into
   * tile B on arrival? The entry rules as they stand now (2: only what will still be there; 3: only the lights and the
   * barriers), with the light as it will be when m gets there at that speed.
   */
  private wouldEnter(m: Mover, bx: number, by: number, dir: number, nextDir: number, last: boolean, ds: number, v: number): boolean {
    if (last) return this.forecourtFree(m, bx, by, dir);
    // step() decides at the line on the tick whose move would take it over, a tick before it is there
    this.lookTicks = Math.min(4 * TT.signalPeriod, Math.max(0, Math.ceil(ds / Math.max(v, 0.05)) - 1));
    this.predicting = true;
    const ok = TT.lookAhead >= 2 ? !this.heldAhead(m, bx, by, dir, nextDir, TT.lookAhead >= 3) : this.canEnter(m, bx, by, dir, nextDir);
    this.predicting = false; this.lookTicks = 0;
    return ok;
  }
  /**
   * Look-ahead 2: only what will still hold m when it gets to the line, not what is passing now (a car crossing the box,
   * the one ahead still in it): a red or amber light then, barriers down, people on the crossing, an exit lane full of
   * cars that are standing.
   */
  private heldAhead(m: Mover, bx: number, by: number, inD: number, outD: number, lightsOnly: boolean): boolean {
    const deg = this.degreeOf(bx, by), signal = deg >= 3 && this.junction(bx, by).signal;
    if (signal && this.lightHolds(m, m.pi, inD)) return true;
    if (this.isCrossingAt(bx, by) && this.crossingClosed(bx, by, inD)) return true;
    if (lightsOnly) return false;
    const walkers = this.crossingsAt(bx, by);
    if (walkers && ((!signal && !isRingAux(this.junctionAux(bx, by))) || (walkers & movementMask(inD, outD)))) return true;
    const key = Traffic.laneKey(bx, by, outD);
    if (!this.laneRoom(bx, by, key, m, null, m.s2 ?? 0)) { const nq = this.laneAt(key); if (nq && nq.every((o) => (o.v ?? 0) < 0.05)) return true; }
    return false;
  }
  /** while wouldEnter asks canEnter: ticks ahead to read the lights at, and no counting */
  private lookTicks = 0; private predicting = false;

  /**
   * Advance a driver one tick. 'arrived' once the final node is reached (the
   * mover is then off the road), 'stuck' when it has waited past the limit.
   *
   * A move crosses at most one tile edge and comes into the next lane no further than 0.3 along it (where the stop line
   * of the tile after is): whatever a fast car had left of its move was lost. Before the carry that capped the 1.25
   * motorway at a street's pace (0.61 then 0.39 tiles on alternate ticks, an average of 0.5), and a car at 2.5 times a
   * street's would have lost half its move. A fast car now goes on in a second leg with what the first had left, from
   * the lane it came into, under every rule of a step there (the car ahead, the stop line and its entry rules, the
   * body guard); one leg more is the most a car at 1.4 tiles a tick can use, and the loop would take a third.
   */
  step(m: Mover): 'moving' | 'arrived' | 'stuck' {
    this.carry = 0;
    let r = this.leg(m, Infinity, false), left = this.carry;
    for (let k = 0; k < 3 && left > 0.005 && r === 'moving'; k++) {
      const v1 = m.v ?? 0; // the move so far, what the next leg cannot use included
      this.carry = 0;
      r = this.leg(m, left, true);
      m.v = r === 'arrived' ? 0 : v1 - left + (m.v ?? 0);
      left = this.carry;
    }
    return r;
  }
  /** What the last leg could not use because it crossed an edge with more than 0.3 of its move left (only a fast car's). */
  private carry = 0;
  private leg(m: Mover, cap: number, again: boolean): 'moving' | 'arrived' | 'stuck' {
    const n = m.path.length / 2;
    if (m.lane < 0 || m.pi >= n) return 'arrived';
    const ax = m.path[(m.pi - 1) * 2], ay = m.path[(m.pi - 1) * 2 + 1];
    const bx = m.path[m.pi * 2], by = m.path[m.pi * 2 + 1];
    const dir = dirBetween(ax, ay, bx, by);
    const last = m.pi + 1 >= n;
    const nextDir = this.nextDirOf(m);

    const heavy = m.cls === VehicleClass.Truck || m.cls === VehicleClass.Bus;
    let base = DRIVE_SPEED * m.speedMul * (heavy ? 0.8 : 1);
    if (this.w.anyRoadClass) {
      // the class of the road under the car sets its pace (roadclass.ts speed); a lane gone from under it (the road's
      // class changed) is the right-hand one
      const ca = m.prog < 0.5 ? this.classAux(ax, ay) : this.classAux(bx, by);
      if (ca && !(isDeckClassAux(ca) && deckAxisStep(ca, DIRS[dir][0]))) base *= classDef(ca & 7).speed; // on an interchange's deck, a street's pace
      if (m.s1 && edgeLanes(this.classAux(ax, ay), this.classAux(bx, by), dir) < 2) m.s1 = 0;
      if (m.s2 && !last && edgeLanes(this.classAux(bx, by), this.classAux(m.path[(m.pi + 1) * 2], m.path[(m.pi + 1) * 2 + 1]), nextDir) < 2) m.s2 = 0;
    }
    if (this.kerbAt(ax, ay)) base *= 0.6;
    if (cap < base) base = cap; // a second leg has only what the first left
    // a 20 zone (R5): every vehicle at ZONE20_SPEED on its tiles
    if (this.w.streetAny & StreetRule.Zone20 && this.w.streetAt(m.prog < 0.5 ? ax : bx, m.prog < 0.5 ? ay : by) & StreetRule.Zone20) base *= ZONE20_SPEED;
    const free = base; // before the turns: what the turn ahead is slowed from
    const fast = free > FAST_PACE && this.w.anyRoadClass;
    // turns slow a car for each half; on a roundabout the ring's wide corners not at all, the turns on and off less
    if (nextDir !== dir && m.prog > 0.3) base *= this.turnSlow(bx, by);
    if (m.inDir !== dir && m.prog < 0.3) base *= this.turnSlow(ax, ay);
    // turning round (a bus at the end of its line): a three-point turn takes a while
    if ((nextDir === OPP[dir] && m.prog > 0.4) || (m.inDir === OPP[dir] && m.prog < 0.5)) base *= UTURN_SLOW;

    // follow the car ahead: in this lane, or the tail of the next lane on my route
    const q = this.laneAt(m.lane)!;
    const idx = q.indexOf(m);
    const bike = isBike(m);
    let gap = Infinity;
    // cars follow cars and two-wheelers follow two-wheelers (they filter past each other at the kerb edge)
    const lead = idx > 0 ? leaderIn(q, idx, bike, m.s1 ?? 0) : null;
    let tailNext: Mover | null = null;
    if (lead) gap = lead.prog - m.prog - (lead.len + m.len) / 2;
    // into a building, also behind a car pulling out of it the same way (it starts at the middle, where this one ends)
    else if (!last || !this.isRoadAt(bx, by)) {
      const nq = this.laneQ(bx, by, nextDir);
      tailNext = nq && nq.length ? leaderIn(nq, nq.length, bike, m.s2 ?? 0) : null;
      if (tailNext) gap = 1 - m.prog + tailNext.prog - (tailNext.len + m.len) / 2;
    }
    let room = gap - MIN_GAP * m.gapMul;
    // progress is a fraction of the lane, and a right-turn arc is shorter than a straight, so also
    // hold the real distance to the car ahead (the chord never overstates the arc, so this is safe)
    const ahead = lead ?? tailNext;
    if (ahead) {
      const dist = hypot(ahead.x - m.x, ahead.y - m.y) - (ahead.len + m.len) / 2 - MIN_GAP * m.gapMul * 0.5;
      if (dist < room) room = dist;
    }
    let allowed = Math.max(0, Math.min(base, room));
    // a bus pulling in at a stop (sim/transit.ts): never past the centre of the stop's road tile, path node m.halt
    const halt = m.halt ?? -1;
    let haltLim = Infinity;
    if (halt >= 0) {
      const at = this.turnsAtHalt(m) ? HALT_TURNED : HALT_AT;
      haltLim = halt === m.pi ? 1 - m.prog + at : halt === m.pi - 1 ? at - m.prog : Infinity;
      if (haltLim < allowed) allowed = Math.max(0, haltLim);
    }

    const stop = this.stopLine(m);
    if (TT.follow) {
      // car following: speed up gently, and slow in time for whatever is ahead rather than stopping dead at it
      const v = m.v ?? 0, dec = TT.brake;
      let want = v >= base ? base : Math.min(base, v + this.accelOf(m, heavy));
      if (ahead) {
        const vl = ahead.v ?? 0;
        want = Math.min(want, safeSpeed(room, vl, dec));
        // standing in a queue: move up only once there is room worth moving into, or the car ahead moves off
        if (TT.startGap > 0 && v < 0.01 && vl < 0.01 && room < TT.startGap) want = 0;
      }
      if (haltLim < Infinity) want = Math.min(want, safeSpeed(haltLim, 0, dec));
      // a turn through the next tile begins at progress 0.3: be down to its speed by then
      if (TT.followTurn && !last && nextDir !== dir && m.prog < 0.3 && (TT.followTurn === 1 || this.junction(bx, by).signal)) {
        const vt = free * this.turnSlow(bx, by) * (nextDir === OPP[dir] ? UTURN_SLOW : 1);
        want = Math.min(want, safeSpeed(0.3 - m.prog, vt, dec));
      }
      // a fast car plans along the route: a queue, a slower road or a turn up to its stopping distance ahead
      if (fast) want = Math.min(want, this.horizon(m, v, dir, heavy));
      // look ahead to the stop line: brake for it only when the next tile will not take me on arrival
      if (TT.lookAhead && !m.committed && stop > m.prog) {
        const ds = stop - m.prog, vs = safeSpeed(ds, 0, dec);
        if (vs < want && !this.wouldEnter(m, bx, by, dir, nextDir, last, ds, want)) want = vs;
      }
      if (want < allowed) allowed = Math.max(0, want);
    }

    // the stop line: decide once, at the edge of the next tile, whether to go in
    if (!m.committed && m.prog + allowed >= stop) {
      // into the next road tile: the full entry rules; into the destination building: one vehicle in its forecourt at a time
      const ok = last ? this.forecourtFree(m, bx, by, dir) : this.canEnter(m, bx, by, dir, nextDir);
      if (ok) { m.committed = true; if (m.med) m.med = false; }
      else if (this.w.anyRoadClass && !last && this.medianWaits(m, ax, ay, dir)) allowed = this.medianAllowed(m, allowed);
      else allowed = Math.max(0, stop - m.prog);
    }

    if ((TT.bodyGuard || TT.carGuard) && allowed > 0) {
      const safe = this.guardSweep(m, allowed);
      if (safe < allowed) { this.cnt.guardCar++; allowed = safe; }
    }

    let moved = 0;
    let arrived = false;
    const ox = m.x, oy = m.y;
    if (m.prog + allowed >= 1) {
      if (last) {
        moved = 1 - m.prog;
        this.leave(m);
        m.x = bx + 0.5; m.y = by + 0.5; m.pi++;
        noteTrail(m, bx, by);
        arrived = true;
      } else {
        const over = m.prog + allowed - 1;
        moved = allowed;
        q.splice(idx, 1); if (q.length === 0) this.dropLane(m.lane);
        this.push(Traffic.laneKey(bx, by, nextDir), m);
        m.inDir = dir; m.pi++; m.prog = Math.min(over, 0.3); m.committed = false; if (m.med) m.med = false;
        if (fast && over > m.prog) this.carry = over - m.prog;
        if (this.w.anyRoadClass) { m.s0 = m.s1 ?? 0; m.s1 = m.s2 ?? 0; m.s2 = this.strandFor(m, m.pi, m.s1); }
        // a bus never comes into a lane already past its stop line before a junction: its nose would be in the box,
        // in the way of whatever turns there (a bus turning round sweeps the whole box: sim/busroute.ts)
        if (m.cls === VehicleClass.Bus && m.pi * 2 + 1 < m.path.length && this.degreeOf(m.path[m.pi * 2], m.path[m.pi * 2 + 1]) >= 3) m.prog = Math.min(m.prog, Math.max(0, this.stopLine(m)));
        noteTrail(m, bx, by);
        if (this.degreeOf(bx, by) >= 3) this.cnt.junctionEntries++;
        if (TT.stuckClock) m.stuck = 0; // the stuck clock counts time since the car last reached a new tile
      }
    } else {
      m.prog += allowed; moved = allowed;
    }
    m.v = arrived ? 0 : moved;
    if (!arrived) {
      this.place(m);
      // remember the direction it last moved in: the client draws a car facing its motion, not its path tangent
      const mx = m.x - ox, my = m.y - oy, md = hypot(mx, my);
      if (md > 1e-2) { const h = this.motion.get(m); if (h) { h[0] = mx / md; h[1] = my / md; } else this.motion.set(m, [mx / md, my / md]); }
    }

    // the second leg of a fast car's move is the same car in the same tick: counted once, by the first, on the tile it
    // started the tick on (so a tile's cars and its held cars, the congestion's inputs, are the same cars)
    if (!again) {
      const rc = this.roadChunk(ax, ay), ri = localIndex(ax, ay);
      if (rc.presAt[ri] !== this.presStamp) { rc.presAt[ri] = this.presStamp; rc.pres[ri] = 0; rc.stop[ri] = 0; this.presKeys.push(tkey(ax, ay)); this.presRc.push(rc); this.presIdx.push(ri); }
      rc.pres[ri]++;
      if (moved < base * 0.3) { rc.stop[ri]++; this.queued++; }
      this.vehicles++; this.speedSum += Math.min(1, moved / (DRIVE_SPEED * m.speedMul));
      if (moved < 0.02) { m.wait++; if (!m.dwell) m.stuck++; } else m.wait = 0; // a bus dwelling at a stop is not stuck
    }
    if (arrived) return 'arrived';
    return TT.stuckLimit > 0 && m.stuck > TT.stuckLimit ? 'stuck' : 'moving';
  }

  // ---- pedestrians -------------------------------------------------------------

  /**
   * The route a walker actually takes along a tile path: the right-hand
   * sidewalk, tight round right-hand corners, across the box on left turns and
   * straight over side roads at junctions, and a door-to-kerb step at each end
   * that crosses the carriageway when the building is on the far side. Points
   * flagged with a tile key are on that tile's carriageway.
   */
  walkPolyline(path: number[]): Polyline {
    const pts: number[] = [], cross: number[] = [], node: number[] = [], xdir: number[] = [];
    const n = path.length / 2;
    const p = this.tmp;
    const push = (x: number, y: number, c = 0, nd = -1, xd = -1) => { pts.push(x, y); cross.push(c); node.push(nd); xdir.push(xd); };
    const cx = (i: number) => path[i * 2] + 0.5, cy = (i: number) => path[i * 2 + 1] + 0.5;
    const road = (i: number) => this.isRoadAt(path[i * 2], path[i * 2 + 1]);
    const dirAt = (i: number) => dirBetween(path[i * 2], path[i * 2 + 1], path[(i + 1) * 2], path[(i + 1) * 2 + 1]);
    const side = (i: number, d: number, k: number): [number, number] => [cx(i) + k * DIRS[d][0], cy(i) + k * DIRS[d][1]];
    const O = SIDEWALK_OFFSET;
    push(cx(0), cy(0), 0, 0);
    if (n === 1) return { pts, cross, node, xdir };
    if (!road(0) && !road(1)) { push(cx(1), cy(1), 0, 1); return { pts, cross, node, xdir }; }
    for (let i = 1; i < n; i++) {
      const tk = tkey(path[i * 2], path[i * 2 + 1]);
      if (!road(i)) {
        // stepping off the previous road tile into this building
        const inD = dirAt(i - 1); // direction from the road tile into the building
        const travel = i >= 2 ? dirAt(i - 2) : inD; // how we were walking along that road
        const r = RIGHT[travel];
        const [kx, ky] = side(i - 1, inD, O);
        if (inD !== r) push(kx, ky, tkey(path[(i - 1) * 2], path[(i - 1) * 2 + 1]), -1, inD === OPP[r] ? inD : inD + 4); // cross to the far kerb first
        push(cx(i), cy(i), 0, i);
        continue;
      }
      const outD = i + 1 < n ? dirAt(i) : -1;
      const inD = dirAt(i - 1);
      const prevBuilding = !road(i - 1);
      const r = outD >= 0 ? RIGHT[outD] : RIGHT[inD];
      if (prevBuilding) {
        // out of the door onto the near kerb, then across if the sidewalk we need is on the far side
        const [qx, qy] = side(i, OPP[inD], O);
        push(qx, qy, 0, i);
        if (outD >= 0 && OPP[inD] !== r) { const [sx, sy] = side(i, r, O); push(sx, sy, tk, -1, r === inD ? inD : inD + 4); }
        continue;
      }
      if (outD < 0) { const [sx, sy] = side(i, RIGHT[inD], O); push(sx, sy, 0, i); continue; } // leg ends on this road tile
      const nextBuilding = !road(i + 1);
      if (nextBuilding) {
        // walk on along our sidewalk to the point in front of the door; the step off happens next node
        const [sx, sy] = side(i, RIGHT[inD], O);
        push(sx, sy, 0, i);
        continue;
      }
      if (outD === inD) {
        const deg = this.degreeOf(path[i * 2], path[i * 2 + 1]);
        const armRight = this.isRoadAt(path[i * 2] + DIRS[r][0], path[i * 2 + 1] + DIRS[r][1]);
        // a signal crossing (R4) walked straight over, across its road: a crossing, as at a junction's arm
        const tx = path[i * 2], ty = path[i * 2 + 1];
        const pel = deg < 3 && (this.w.anyRoadClass || this.w.roadRules.size > 0) && this.pelicanAt(tx, ty) && this.carRoadAt(tx + DIRS[r][0], ty + DIRS[r][1]) && this.carRoadAt(tx - DIRS[r][0], ty - DIRS[r][1]);
        const x = (deg >= 3 && armRight) || pel;
        pathPoint(path[i * 2], path[i * 2 + 1], inD, outD, 0, O, p); push(p[0], p[1], 0, i);
        pathPoint(path[i * 2], path[i * 2 + 1], inD, outD, 1, O, p); push(p[0], p[1], x ? tk : 0, -1, x ? inD : -1);
      } else if (outD === RIGHT[inD]) {
        for (const s of [0, 0.5, 1]) { pathPoint(path[i * 2], path[i * 2 + 1], inD, outD, s, O, p); push(p[0], p[1], 0, s === 0 ? i : -1); }
      } else {
        // a left turn crosses the box, except round a roundabout's corner: that is the ring's outer kerb
        const a = this.junctionAux(path[i * 2], path[i * 2 + 1]);
        const corner = (isRingAux(a) && !isArmPos(ringPos(a))) || (this.w.anyRoadClass && isRingClassAux(this.classAux(path[i * 2], path[i * 2 + 1])) && this.degreeOf(path[i * 2], path[i * 2 + 1]) < 3);
        const x = corner ? 0 : tk;
        for (let k = 0; k <= 6; k++) { pathPoint(path[i * 2], path[i * 2 + 1], inD, outD, k / 6, O, p); push(p[0], p[1], k === 0 ? 0 : x, k === 0 ? i : -1, k === 0 || !x ? -1 : inD + 4); }
      }
    }
    return { pts, cross, node, xdir };
  }
}
