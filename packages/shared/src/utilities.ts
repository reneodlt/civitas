import { MANIFEST } from './buildings/compiled';
import { CHUNK_SIZE, TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { chunkKey, chunkOf, localIndex } from './coords';
import { isRoad, zoneOf, levelOf, kindIdOf } from './tile';
import { Zone } from './buildings/codes';
import { hash2 } from './noise';
import { structureAt, isMultiTile } from './structures';
import { MOTORWAY_KIND } from './gateways';

/**
 * Utilities (docs/utilities.md): the hybrid networks. Plants generate, nodes pass power on along the streets, trunk
 * links join them, and supply is solved against demand per network once a game hour. This module is shared and pure:
 *
 * - the kinds' attributes, flattened by kind id (`UTIL_*_OF`);
 * - `utilityReach`, the road search from a node, and `UtilityField`, which caches every node's reach per chunk and per
 *   owner. Server and client run it from the same tiles, so reach never goes on the wire;
 * - `solveNetwork`, the hourly solver: brownouts between 0.85 and 1, rolling cuts below, by priority;
 * - the demand curve, availability, the wire and save shapes, and the hooks later phases fill (weather, land value,
 *   contracts).
 *
 * Phase 1 is power. The field, solver and links take a utility id so water, sewerage and the rest reuse them.
 */

export type UtilityId = 'power';
/** Where a utility kind sits in its network. */
export const UtilRole = { None: 0, Node: 1, Plant: 2, Depot: 3 } as const;
/** A plant's availability: steady (thermal), the sun's elevation, or the wind signal. */
export const Avail = { Steady: 0, Sun: 1, Wind: 2 } as const;
/** Node states on the wire (`utilState`), worst last. */
export const UtilState = { Ok: 0, Brown: 1, Cut: 2, Fault: 3, Unpowered: 4 } as const;
export const UTIL_STATE_WORDS = ['supplied', 'brownout', 'rolling cut', 'fault', 'no supply'];

/** Tuning (docs/utilities.md sections 3 and 4). Money in dollars, power in units an hour, times in game hours unless noted. */
export const UTIL = {
  /** demand per resident or job by family code, before the level factor and the hour's curve */
  rate: { [Zone.Residential]: 0.1, [Zone.Commercial]: 0.2, [Zone.Office]: 0.15, [Zone.Industrial]: 0.4 } as Record<number, number>,
  /** everything else that has people in it (civic buildings, venues, hubs) */
  civicRate: 0.15,
  /** an empty building still draws this share of its capacity's demand (lighting, heating) */
  baseShare: 0.1,
  /** the level factor: level 1, level 2, and each level above */
  level1: 0.6, levelStep: 0.15,
  /** the power curve by hour of day (0-23): night trough, morning, day, the 17:00-20:00 peak */
  curve: [0.5, 0.5, 0.5, 0.5, 0.5, 0.55, 0.75, 1.0, 1.1, 1.0, 0.95, 0.95, 1.0, 1.0, 0.95, 0.95, 1.05, 1.4, 1.4, 1.4, 1.35, 1.1, 0.85, 0.65],
  /** s = supply / demand: brownout below 1, rolling cuts below `cutBelow` */
  cutBelow: 0.85,
  /** a margin under this shows amber in the panel */
  amberMargin: 0.1,
  /** night, when workplaces are cut before homes */
  nightFrom: 22, nightTo: 6,
  /** a plant runs at full output with this share of its staff on the payroll */
  fullStaffShare: 0.5,
  /** bills: the default tariff a unit, and grid import a unit (about 2.5× what a gas plant's fuel costs): imported power breaks even, your own earns */
  tariff: 0.06, importPrice: 0.06,
  /** road steps from a node's door to a motorway connection's within which the network can take grid import */
  importReach: 64,
  /** links: dollars a tile, overhead and buried, and buried under water; towers every `pylonEvery` tiles */
  overheadCost: 40, buriedCost: 160, buriedWaterCost: 400, pylonEvery: 4,
  /** a link removed gives back this share of what it cost */
  refund: 0.5,
  /** the longest link, in tiles */
  maxLinkTiles: 160,
  /** faults: chance per node per game hour, per link tile per game hour; none before this world day, none in sandboxes unless opted in */
  nodeFaultPerHour: 1 / (25 * 24), linkFaultPerTileHour: 1 / (40 * 7 * 24), faultsFromDay: 7,
  /** repair: hours on site, and the contractor's hours when no van comes (lineworkers among a depot's staff: fleet.ts MOBILE.lineworkerShare) */
  repairHours: 2, contractorHours: 10,
};

/**
 * What the owner of a power fault can expect and do, in words (playtest 37299b96: the game never said a contractor
 * fixes it, nor that a power depot's van is quicker). The notice when it opens, the panels while it is open.
 * `crew`: a van of the owner's is on its way or at work; `depot`: the owner has a power depot; `tech`: the owner has
 * the technology that brings one (`techName`); `hoursLeft`: until the contractor comes.
 */
export function faultAdvice(o: { crew?: 'coming' | 'working'; depot: boolean; tech: boolean; techName: string; hoursLeft: number }): string {
  const h = Math.max(1, Math.round(o.hoursLeft)), van = `${UTIL.repairHours}–${UTIL.repairHours + 1} hours`;
  const contractor = `a contractor fixes it in about ${h} hour${h === 1 ? '' : 's'}`;
  if (o.crew === 'working') return `A repair crew is at work: power back within about ${UTIL.repairHours} hours.`;
  if (o.crew === 'coming') return `A repair van is on its way: fixed in about ${van}.`;
  if (o.depot) return `Your power depot sends a repair van (about ${van}); if none can come, ${contractor}.`;
  const c = contractor[0].toUpperCase() + contractor.slice(1);
  return o.tech ? `${c}. A power depot of your own sends a repair van in ${van}.`
    : `${c}. A power depot of your own would send a repair van in ${van}: it needs ${o.techName} (T).`;
}

/** Storms (docs/utilities.md section 4.4): there is no weather system yet. Both are 1; a weather card fills them in. */
export const UTIL_WEATHER = {
  /** multiplies the fault rate at (x, y): a storm raises overhead faults about 10× for a few hours */
  faultMul: (_x: number, _y: number, _tick: number, _overhead: boolean) => 1,
  /** multiplies wind output: 0 at gale force (the turbines feather) */
  windMul: (_tick: number) => 1,
};

// ---------------------------------------------------------------- kinds

/** Network role by kind id (UtilRole). */
export const UTIL_ROLE_OF = new Uint8Array(256);
/** A plant's output at full staff and availability, units an hour. */
export const UTIL_SUPPLY_OF = new Float64Array(256);
/** A node's reach in road steps from its door. */
export const UTIL_RADIUS_OF = new Uint8Array(256);
/** The most a node passes on to its patch, units an hour. */
export const UTIL_NODE_CAP_OF = new Float64Array(256);
/** The most grid import a node brings in, units an hour (0: it cannot import). */
export const UTIL_IMPORT_OF = new Float64Array(256);
/** A thermal plant's fuel cost per unit generated. */
export const UTIL_FUEL_OF = new Float64Array(256);
/** A plant's pollution, 0-10 (a hook for the derived-fields card bbe84771). */
export const UTIL_POLLUTION_OF = new Uint8Array(256);
/** A plant's availability (Avail). */
export const UTIL_AVAIL_OF = new Uint8Array(256);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Kind ids per utility and role, in id order. */
export const UTIL_KINDS = { nodes: [] as number[], plants: [] as number[], depots: [] as number[] };
for (const k of MANIFEST) {
  const a = k.levels[0]?.attrs ?? k.attrs;
  if (a.utility !== 'power') continue;
  const id = k.kindId;
  if (num(a.nodeRadius) > 0) { UTIL_ROLE_OF[id] = UtilRole.Node; UTIL_KINDS.nodes.push(id); }
  else if (num(a.supply) > 0) { UTIL_ROLE_OF[id] = UtilRole.Plant; UTIL_KINDS.plants.push(id); }
  else if (num(a.crews) > 0) { UTIL_ROLE_OF[id] = UtilRole.Depot; UTIL_KINDS.depots.push(id); }
  UTIL_SUPPLY_OF[id] = num(a.supply);
  UTIL_RADIUS_OF[id] = num(a.nodeRadius);
  UTIL_NODE_CAP_OF[id] = num(a.nodeCapacity);
  UTIL_IMPORT_OF[id] = num(a.importCap);
  UTIL_FUEL_OF[id] = num(a.fuel);
  UTIL_POLLUTION_OF[id] = num(a.pollution);
  UTIL_AVAIL_OF[id] = a.availability === 'sun' ? Avail.Sun : a.availability === 'wind' ? Avail.Wind : Avail.Steady;
}
export const isUtilityKind = (id: number) => UTIL_ROLE_OF[id] !== UtilRole.None;
export const isPowerNode = (id: number) => UTIL_ROLE_OF[id] === UtilRole.Node;
export const isPowerPlant = (id: number) => UTIL_ROLE_OF[id] === UtilRole.Plant;
export const isPowerDepot = (id: number) => UTIL_ROLE_OF[id] === UtilRole.Depot;
/** The widest node reach, for the chunk margin a change invalidates. */
export const MAX_UTIL_RADIUS = Math.max(1, ...UTIL_KINDS.nodes.map((id) => UTIL_RADIUS_OF[id]));

// ---------------------------------------------------------------- demand and availability

/** The level factor of demand: 0.6 at level 1, 1 at level 2, 0.15 more each level above. */
export const levelFactor = (level: number) => (level <= 0 ? 0 : level === 1 ? UTIL.level1 : 1 + UTIL.levelStep * (level - 2));
/** A building's power demand this hour, units: (occupants + baseShare × capacity) × rate × level factor × curve. */
export function powerDemand(family: number, level: number, occupants: number, capacity: number, hour: number): number {
  const rate = UTIL.rate[family] ?? UTIL.civicRate;
  return (occupants + UTIL.baseShare * capacity) * rate * levelFactor(level) * UTIL.curve[((Math.floor(hour) % 24) + 24) % 24];
}
/** The sun's elevation for the hour, as the sky draws it (render/lighting.ts, materials.ts mscSky): 0 at night, 1 at noon. */
export const daylight = (hour: number) => Math.max(0, Math.sin((hour / 24) * Math.PI * 2 - Math.PI / 2));
/**
 * The wind, 0.15-1: a slow signal hashed from the world seed, eased between values every six game hours, so turbines
 * have calm spells and windy ones the same way on every run.
 */
export function windAt(tick: number, seed: number): number {
  const span = 6 * TICKS_PER_HOUR, i = Math.floor(tick / span), f = (tick - i * span) / span;
  const a = hash2(i * 7 + 3, seed * 13 + 1), b = hash2((i + 1) * 7 + 3, seed * 13 + 1);
  const e = f * f * (3 - 2 * f);
  return Math.max(0, (0.15 + 0.85 * (a + (b - a) * e)) * UTIL_WEATHER.windMul(tick));
}
/** A plant's availability now (1 for steady plants). */
export function availability(kind: number, tick: number, seed: number): number {
  const a = UTIL_AVAIL_OF[kind];
  return a === Avail.Sun ? daylight((tick % TICKS_PER_DAY) / TICKS_PER_HOUR) : a === Avail.Wind ? windAt(tick, seed) : 1;
}

// ---------------------------------------------------------------- reach

/** The tiles reach reads. `owner` is the parcel owner at a tile, or null for unowned (public) land. */
export interface UtilEnv {
  tile(x: number, y: number): number | undefined;
  sub(x: number, y: number): number;
  aux(x: number, y: number): number;
  owner(x: number, y: number): string | null;
  /**
   * Service contracts (docs/multiplayer-land.md M8): whether `owner`'s network may also walk the road at (x, y), which
   * another player owns, because that player's parcel has a power contract with them. Absent: never (section 3.1).
   */
  access?(owner: string, x: number, y: number): boolean;
}
/** A node: its door, kind and owner. `key` is the door's numeric key (utilKey), the id it has on the wire. */
export interface UtilNode { key: number; x: number; y: number; kind: number; owner: string }
/** The door's numeric key: the same formula as the server's tkey, so ids agree everywhere. */
export const utilKey = (x: number, y: number) => (x + 0x8000) * 65536 + (y + 0x8000);
export const utilUnkey = (k: number): [number, number] => [Math.floor(k / 65536) - 0x8000, k - Math.floor(k / 65536) * 65536 - 0x8000];
const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];

/** Whether supply from `owner`'s node may run along the tile: a road on their own land or on unowned land, or on a buyer's land under a power contract (M8). */
const passable = (env: UtilEnv, owner: string, x: number, y: number) => {
  const t = env.tile(x, y);
  if (t === undefined || !isRoad(t)) return false;
  const o = env.owner(x, y);
  return o === null || o === owner || (env.access !== undefined && env.access(owner, x, y));
};

/**
 * A node's reach (docs/utilities.md section 3.1): a breadth-first search over road tiles from the roads beside its door,
 * east, west, south and north in that order, up to `steps` (default the kind's nodeRadius), on the owner's roads and
 * public ones. Returns flat [x, y, ...] and the step count of each, nearest first.
 */
export function utilityReach(node: UtilNode, env: UtilEnv, steps = UTIL_RADIUS_OF[node.kind]): { tiles: number[]; dist: number[] } {
  const tiles: number[] = [], dist: number[] = [];
  const seen = new Set<number>();
  for (let d = 0; d < 4; d++) {
    const x = node.x + DX[d], y = node.y + DY[d], k = utilKey(x, y);
    if (seen.has(k) || !passable(env, node.owner, x, y)) continue;
    seen.add(k); tiles.push(x, y); dist.push(0);
  }
  for (let i = 0; i < dist.length; i++) {
    const s = dist[i];
    if (s >= steps) continue;
    const x = tiles[i * 2], y = tiles[i * 2 + 1];
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d], k = utilKey(nx, ny);
      if (seen.has(k) || !passable(env, node.owner, nx, ny)) continue;
      seen.add(k); tiles.push(nx, ny); dist.push(s + 1);
    }
  }
  return { tiles, dist };
}

/** The door of the building standing on (x, y): a structure's door, else the tile. Null on a road or nothing. */
export function doorAt(env: UtilEnv, x: number, y: number): [number, number] | null {
  const t = env.tile(x, y);
  if (t === undefined || isRoad(t) || zoneOf(t) === Zone.None) return null;
  if (env.aux(x, y)) {
    const s = structureAt(x, y, env.aux, env.tile, env.sub);
    if (s) return [s.doorX, s.doorY];
  }
  return [x, y];
}

/** A node, plant or depot standing complete at its door (x, y), from the tiles; null otherwise. */
export function utilityAt(env: UtilEnv, x: number, y: number): { kind: number; role: number } | null {
  const t = env.tile(x, y);
  if (t === undefined || isRoad(t) || levelOf(t) < 1) return null;
  const kind = kindIdOf(zoneOf(t), env.sub(x, y));
  const role = UTIL_ROLE_OF[kind];
  if (!role) return null;
  if (isMultiTile(kind)) { const s = structureAt(x, y, env.aux, env.tile, env.sub); if (!s || s.doorX !== x || s.doorY !== y) return null; }
  return { kind, role };
}

/** One chunk's worth of an owner's field: the serving node (index into UtilityField.nodes, -1 none) and its distance. */
interface FieldCell { node: Int32Array; dist: Uint8Array }

/**
 * Every node's reach, cached per chunk and per owner (docs/utilities.md section 3.1). For each road tile an owner's
 * nodes reach, the nearest node serves it; a tie goes to the lower key, so the server and every client agree whatever
 * order they found the nodes in. `adjacent` lists node pairs (indexes) whose reaches touch: the streets join them into
 * one network. Rebuilt whole by `rebuild`; callers decide when (a chunk's road or node signature changed).
 */
export class UtilityField {
  nodes: UtilNode[] = [];
  /** node index pairs whose reaches share a road tile, flat [a, b, ...] with a < b */
  adjacent: number[] = [];
  private cells = new Map<string, FieldCell>();
  private byKey = new Map<number, number>();
  /** road tiles reached, over all nodes (the probe and the bench read it) */
  reached = 0;

  /** Recompute from these nodes (any order) over env's tiles. */
  rebuild(nodes: readonly UtilNode[], env: UtilEnv) {
    this.nodes = [...nodes].sort((a, b) => a.key - b.key);
    this.cells.clear(); this.byKey.clear();
    this.reached = 0;
    const pairs = new Set<number>();
    const adj: number[] = [];
    this.nodes.forEach((n, i) => this.byKey.set(n.key, i));
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const r = utilityReach(n, env);
      this.reached += r.dist.length;
      for (let j = 0; j < r.dist.length; j++) {
        const x = r.tiles[j * 2], y = r.tiles[j * 2 + 1], d = r.dist[j];
        const c = this.cell(n.owner, chunkOf(x), chunkOf(y), true)!;
        const li = localIndex(x, y), cur = c.node[li];
        if (cur >= 0 && cur !== i) { const p = cur * 100000 + i; if (!pairs.has(p)) { pairs.add(p); adj.push(cur, i); } }
        if (cur < 0 || d < c.dist[li]) { c.node[li] = i; c.dist[li] = d; }
      }
    }
    this.adjacent = adj;
  }
  private cell(owner: string, cx: number, cy: number, make = false): FieldCell | undefined {
    const k = `${owner}|${chunkKey(cx, cy)}`;
    let c = this.cells.get(k);
    if (!c && make) {
      c = { node: new Int32Array(CHUNK_SIZE * CHUNK_SIZE).fill(-1), dist: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE) };
      this.cells.set(k, c);
    }
    return c;
  }
  /** Index of the node serving road tile (x, y) for `owner`, or -1. */
  nodeIndexAt(owner: string, x: number, y: number): number {
    const c = this.cell(owner, chunkOf(x), chunkOf(y));
    return c ? c.node[localIndex(x, y)] : -1;
  }
  /** Steps from the serving node to road tile (x, y), or -1. */
  distAt(owner: string, x: number, y: number): number {
    const c = this.cell(owner, chunkOf(x), chunkOf(y));
    if (!c) return -1;
    const li = localIndex(x, y);
    return c.node[li] < 0 ? -1 : c.dist[li];
  }
  indexOf(key: number): number { return this.byKey.get(key) ?? -1; }
  /**
   * The node serving a building of `owner` whose door is (bx, by): of the road tiles beside the door, the one nearest a
   * node (ties east, west, south, north). Index into nodes, or -1: not covered.
   */
  serving(owner: string, bx: number, by: number): number {
    let best = -1, bd = 1e9;
    for (let d = 0; d < 4; d++) {
      const x = bx + DX[d], y = by + DY[d];
      const c = this.cell(owner, chunkOf(x), chunkOf(y));
      if (!c) continue;
      const li = localIndex(x, y), n = c.node[li];
      if (n >= 0 && c.dist[li] < bd) { bd = c.dist[li]; best = n; }
    }
    return best;
  }
  /** Owners with any reach in chunk (cx, cy), for drawing. */
  ownersIn(cx: number, cy: number): string[] {
    const tail = `|${chunkKey(cx, cy)}`, out: string[] = [];
    for (const k of this.cells.keys()) if (k.endsWith(tail)) out.push(k.slice(0, -tail.length));
    return out;
  }
}

/**
 * A chunk's utility signature: a hash over its road bits and its utility kinds' tiles (kind and level). It changes only
 * when reach could: a road laid or dug up, a node finished or knocked down. Construction progress elsewhere does not.
 */
export function chunkUtilSig(tiles: Uint16Array, sub: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    let v = 0;
    if (isRoad(t)) v = 1;
    else if (zoneOf(t) === Zone.Hub && sub[i] && UTIL_ROLE_OF[sub[i]]) v = 2 + sub[i] * 8 + levelOf(t);
    if (v) h = Math.imul(h ^ (i * 2654435761 + v), 16777619) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------- networks and the solver

/** One node as the solver sees it this hour. */
export interface SolveNode {
  key: number;
  /** the patch's demand this hour, and the most the node passes on */
  demand: number; cap: number;
  /** never cut: a hospital or police station in the patch */
  never: boolean;
  /** the player pinned it */
  protect: boolean;
  /** share of the patch's demand from workplaces (0-1): at night they are cut first, by day homes are */
  workShare: number;
  /** faulted: off until repaired, draws nothing */
  fault: boolean;
}
export interface SolveResult {
  /** UtilState per node, in input order */
  state: Uint8Array;
  /** load per node: what it passes on as a share of its cap, 0-255 (%) */
  load: Uint8Array;
  /** network totals this hour, units */
  demand: number; served: number; generated: number; imported: number;
  /** supply over demand before cuts (Infinity with no demand) */
  ratio: number;
}

/** Whether `hour` (0-24) is night for the cut order. */
const isNight = (hour: number) => hour >= UTIL.nightFrom || hour < UTIL.nightTo;

/**
 * Solve one network for the hour (docs/utilities.md section 3.3). `generation` is what its plants can make, `importCap`
 * what the grid can bring in (0 without access). Own generation is used first, then import for the shortfall.
 * s = (generation + import) / demand: 1 or more is ok; 0.85 to 1 browns out every node; below 0.85 nodes are cut,
 * never-cut and protected ones last, workplaces first at night and homes by day, rotating by a hash of the node and
 * `hourIndex`, until the rest are back to s ≥ 1. A node whose own patch wants more than its cap browns out (cap /
 * demand ≥ 0.85) or trips (below), whatever the network has. Pure: the same input gives the same output.
 */
export function solveNetwork(nodes: readonly SolveNode[], generation: number, importCap: number, hour: number, hourIndex: number): SolveResult {
  const n = nodes.length;
  const state = new Uint8Array(n), load = new Uint8Array(n);
  const drawn = new Float64Array(n);
  let D = 0;
  for (let i = 0; i < n; i++) {
    const s = nodes[i];
    if (s.fault) { state[i] = UtilState.Fault; continue; }
    drawn[i] = Math.min(s.demand, s.cap);
    D += drawn[i];
  }
  const avail = Math.max(0, generation) + Math.max(0, importCap);
  const res: SolveResult = { state, load, demand: D, served: 0, generated: 0, imported: 0, ratio: D > 0 ? avail / D : Infinity };
  if (avail <= 0) {
    for (let i = 0; i < n; i++) if (state[i] !== UtilState.Fault) state[i] = UtilState.Unpowered;
    return res;
  }
  const on = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) if (state[i] === UtilState.Fault) on[i] = 0;
  let served = D;
  const s = res.ratio;
  if (s < UTIL.cutBelow) {
    // rolling cuts: the cuttable nodes in order, cut until what is left fits
    const night = isNight(hour);
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (on[i] && !nodes[i].never && !nodes[i].protect && drawn[i] > 0) order.push(i);
    const cls = (i: number) => (night ? (nodes[i].workShare >= 0.5 ? 0 : 1) : (nodes[i].workShare < 0.5 ? 0 : 1));
    const rot = (i: number) => hash2((nodes[i].key % 1000003) + 17, hourIndex * 31 + 7);
    order.sort((a, b) => cls(a) - cls(b) || rot(a) - rot(b) || nodes[a].key - nodes[b].key);
    for (const i of order) {
      if (served <= avail) break;
      on[i] = 0; state[i] = UtilState.Cut; served -= drawn[i];
    }
  }
  const after = served > 0 ? avail / served : Infinity;
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    const nd = nodes[i];
    const local = nd.demand > 0 ? nd.cap / nd.demand : Infinity;
    const r = Math.min(after, local);
    if (r < UTIL.cutBelow && local < UTIL.cutBelow && !nd.never) { state[i] = UtilState.Cut; on[i] = 0; served -= drawn[i]; continue; } // tripped on its own overload
    state[i] = r < 1 ? UtilState.Brown : UtilState.Ok;
    load[i] = Math.min(255, Math.round((nd.cap > 0 ? drawn[i] / nd.cap : 0) * 100));
  }
  served = Math.max(0, Math.min(served, avail));
  res.served = served;
  res.generated = Math.min(Math.max(0, generation), served);
  res.imported = Math.max(0, served - res.generated);
  return res;
}

/** Union-find over small integer ids, for the networks. */
export class Unions {
  private p: Int32Array;
  constructor(n: number) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(a: number): number { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  join(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb); }
}

// ---------------------------------------------------------------- trunk links

export type LinkMode = 'overhead' | 'buried';
/** A trunk link on the wire and in the save: its owner, mode, the plants or nodes (or motorway connection) at its ends, and its tiles. */
export interface UtilLinkDTO {
  id: number; util: UtilityId; owner: string; mode: LinkMode;
  /** the doors at its two ends */
  a: [number, number]; b: [number, number];
  /** flat [x, y, ...] from a to b */
  tiles: number[];
}
/** Dollars to lay a link over these tiles (flat), `wet(x, y)` true for water. */
export function linkCost(mode: LinkMode, tiles: readonly number[], wet: (x: number, y: number) => boolean): number {
  let c = 0;
  for (let i = 0; i < tiles.length; i += 2) c += mode === 'overhead' ? UTIL.overheadCost : wet(tiles[i], tiles[i + 1]) ? UTIL.buriedWaterCost : UTIL.buriedCost;
  return c;
}
/**
 * Where an overhead link's towers stand: both ends and every `pylonEvery` tiles between, each moved to the nearest tile
 * of the run (within one) with no building on it (`clear`). Flat [x, y, ...] along the run.
 */
export function pylonSpots(tiles: readonly number[], clear: (x: number, y: number) => boolean): number[] {
  const n = tiles.length / 2, out: number[] = [];
  if (!n) return out;
  const want: number[] = [];
  for (let i = 0; i < n; i += UTIL.pylonEvery) want.push(i);
  if (want[want.length - 1] !== n - 1) want.push(n - 1);
  for (const i of want) {
    let pick = -1;
    for (const d of [0, 1, -1]) { const j = i + d; if (j >= 0 && j < n && clear(tiles[j * 2], tiles[j * 2 + 1])) { pick = j; break; } }
    if (pick >= 0) out.push(tiles[pick * 2], tiles[pick * 2 + 1]);
  }
  return out;
}
/** Land value hook (docs/utilities.md section 7): how much an overhead line blights tiles within this many tiles. */
export const PYLON_BLIGHT = { range: 2, factor: 0.85 };
/** The land-value factor at (x, y) from overhead links (1 = none). Read by nothing yet: the land-value field (bbe84771) will. */
export function pylonBlightAt(x: number, y: number, links: readonly UtilLinkDTO[]): number {
  for (const l of links) {
    if (l.mode !== 'overhead') continue;
    for (let i = 0; i < l.tiles.length; i += 2) if (Math.abs(l.tiles[i] - x) <= PYLON_BLIGHT.range && Math.abs(l.tiles[i + 1] - y) <= PYLON_BLIGHT.range) return PYLON_BLIGHT.factor;
  }
  return 1;
}
/** Is (x, y) a motorway connection's tile? Its door is where import comes in. */
export const isMotorwayAt = (env: UtilEnv, x: number, y: number) => {
  const t = env.tile(x, y);
  return t !== undefined && !isRoad(t) && kindIdOf(zoneOf(t), env.sub(x, y)) === MOTORWAY_KIND;
};

// ---------------------------------------------------------------- wire, panels and the save

/** A building's utilities in its panel (BuildingInfo.utilities). */
export interface UtilityInfo {
  /** power to this building: its node's state (UtilState), the node's door and kind, its bill */
  power?: { state: number; node?: [number, number]; nodeKind?: number; steps?: number; units: number; bill: number; needed: boolean;
    /** its node is faulted: who fixes it and when (faultAdvice); absent from older servers */
    repair?: string };
  /** a node, plant or depot: its network */
  network?: NetworkInfo;
}
export interface NetworkInfo {
  role: 'node' | 'plant' | 'depot';
  /** this node's state and load (%), or the plant's output now (units) and its share of full */
  state?: number; load?: number; output?: number; share?: number;
  /** the network this hour: units */
  demand: number; supply: number; generated: number; imported: number;
  /** nodes and plants in it, and the worst state among its nodes */
  nodes: number; plants: number;
  /** grid import: reachable, on, its cap */
  importable: boolean; importOn: boolean; importCap: number;
  /** pinned by the player (nodes) */
  protect?: boolean;
  /** open faults in this network, in words */
  faults: string[];
  /** beside each fault: who fixes it and when (faultAdvice, the contractor's hours counting down); absent from older servers */
  repair?: string[];
  /** a depot: vans out now and repairs today */
  vans?: number; repairs?: number;
}
/** An open fault (the save and the panels). */
export interface FaultSave {
  id: number; owner: string; kind: 'node' | 'link';
  /** the node's door key, or the link id */
  ref: number;
  /** where the crew goes */
  x: number; y: number;
  at: number;
  /** a contractor clears it at this tick if no van has */
  until: number;
}
/** Interconnector contracts (U9, docs/utilities.md section 7): declared so saves can carry them; none are made yet. */
export interface ContractDTO { id: number; seller: string; buyer: string; util: UtilityId; price: number; cap: number; link: number; endsAt?: number }
/** The `utilities` field of the snapshot (optional; absent while there is nothing to keep). */
export interface UtilitiesSave {
  links: UtilLinkDTO[];
  nextLink: number;
  faults: FaultSave[];
  nextFault: number;
  /** nodes pinned as protected, by door key */
  protect?: number[];
  /** owners who switched grid import off */
  noImport?: string[];
  /** tariff multipliers by owner (0.5-2; a hook for the tariff slider) */
  tariff?: Record<string, number>;
  contracts?: ContractDTO[];
}
