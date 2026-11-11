import {
  TICKS_PER_HOUR, TICKS_PER_DAY, CHUNK_SIZE, LAND_TUNING, SEVERE, Terrain, Zone, FleetKind, RoadCls, gameMin, hash2, tileKey, isRoad, zoneOf, terrainOf,
  familyOf, leisureAt, buildingValue, roadClassAt, isBridgeAux, floodRiskAt, floodRiskChunk, floodsAt, riverLevel, severeOutlook, warningText, weatherFor,
  overlayByte, ROAD_WEATHER, KIND_NAMES,
  type SevereEvent, type ServerMsg,
} from '@msimcity/shared';
import type { Citizen, Player, World } from '../world';
import { tkey, untkey } from '../world';
import type { Simulation } from './simulation';
import type { FleetService, Mobile, Stop, Unit, FleetInfoRows } from './mobile';
import type { News } from './news';

const TPH = TICKS_PER_HOUR;
const DIRS4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** the hourly pass runs at this tick of the game hour */
const PHASE = 11;
/** crews and gritters are sent every so many ticks while there is work */
const DISPATCH_EVERY = 25;
/** a fallen tree's crew could not get there this many times: left to the contractor */
const MAX_TRIES = 3;
/** at most this many flooded tiles go on the wire */
const WIRE_FLOOD_MAX = 6000;

/**
 * Flood insurance (docs/weather.md W6, a hook for later): an insured owner's flood damage is paid by the insurer. No
 * insurance exists yet, so nobody is.
 */
export const floodInsured = (_owner: string): boolean => false;

interface Tree {
  id: number; x: number; y: number;
  /** where the tree stood (the side it fell from), for the drawing */
  dx: number; dy: number;
  at: number;
  /** the contractor clears it at this tick if no crew has */
  until: number;
  /** the crew's vehicle id (0 none) and whether they are at work on it */
  crew: number; working: boolean; tries: number;
}
export interface SevereSave {
  warned?: { storm: number; flood: number };
  trees?: [number, number, number, number, number, number][];
  walls?: [number, number, string][];
  /** buildings (door tile keys) billed in the flood under way */
  damaged?: number[];
  gritted?: [number, number, number][];
  spell?: number;
  nextTree?: number;
}

/**
 * Severe weather (docs/weather.md section 4 and W6), one per game (game.ts), registered as a fleet service on sim.mobile
 * so its crews and gritters are units like the bin lorries and repair vans. Everything it decides is a pure function of
 * the seed, the tiles and the tick (shared/src/severe.ts and hashes), so a replay repeats.
 *
 * - **Warnings.** Once a game hour the outlook (severeOutlook: storms and flood spells starting within a game day) is
 *   read; each spell is announced once: a news story, and a toast to every player with land (a storm) or with land that
 *   would flood at the spell's peak (a flood). The client's weather chip and TV read the same outlook themselves.
 * - **Storms.** Overhead-line faults are utilities' (W4, UTIL_WEATHER). Here: in each storm hour each road tile beside a
 *   tree (a park, or a wild tree on open grass, by hash) may have one fall across it (SEVERE.treePerHour, at most
 *   treeMax at once). The tile is closed (Traffic.closures: the routers go round it) until a crew from a builders' yard
 *   clears it (a builder on shift with no site, driving out as a road crew), or a contractor after treeClearHours.
 * - **Floods.** Once a game hour the river level (riverLevel) is read; at floodFrom and over, land tiles whose risk is
 *   under the level flood where the water can reach them from a river or lake: a flood fill from the water's edge
 *   through floodable tiles, which flood defences stop while the level is at most wallHold (tiles behind a continuous
 *   wall are dry; the simple rule). Flooded roads close; a flooded home's people stay home and a flooded workplace or
 *   venue shuts (Simulation.stayHome, closedAt); each flooded building's owner pays damageShare of its book value once
 *   a flood (ledger `flood`), never a level: a flood damages but never demolishes, and an owner away (the empty-land
 *   tax's pause, LAND_TUNING.awayPauseDays) or insured (floodInsured, a hook) pays nothing.
 * - **Gritters.** While snow lies or is forecast within gritAhead hours, each builders' yard with a free builder sends a
 *   gritter round of the roads near it, main roads first (avenues, motorways, ring roads, then junctions); every tile it
 *   drives over is gritted for gritHours, so `ROAD_WEATHER.gritted(x, y)` lifts the W4 snow slowdown there.
 */
export class Severe implements FleetService {
  readonly kinds = [FleetKind.RoadCrew, FleetKind.Gritter];
  /** for one owner's screen (net.ts sends them as toasts) */
  notices: { owner: string; msg: string }[] = [];
  /** the wire state changed (net.ts broadcasts `severe`) */
  changed = true;
  news: News | null = null;
  /** off: nothing happens (a sandbox may switch it off; the checks drive it) */
  enabled = true;
  readonly trees = new Map<number, Tree>();
  /** flood defences: tile key -> owner */
  readonly walls = new Map<number, string>();
  /** land tiles under water now, and the buildings (door keys) flooded */
  readonly flooded = new Set<number>();
  readonly floodedB = new Set<number>();
  private damaged = new Set<number>();
  /** gritted road tiles: tile key -> until tick */
  readonly gritted = new Map<number, number>();
  level = 0;
  /** the last spell announced of each kind (its first hour) */
  private warned = { storm: -1e9, flood: -1e9 };
  private spell = 0;
  private nextTree = 1;
  private gritters = new Set<Unit>();
  /** a yard's gritter round waiting for a driver, by the yard's door key */
  private rounds = new Map<number, Stop[]>();
  private hourDone = -1;
  private dirty = true;
  private protectedCache: { ver: number; set: Set<number> } | null = null;
  private wallVer = 0;
  stats = {
    warnings: [] as { kind: 'storm' | 'flood'; at: number; from: number; to: number }[],
    trees: 0, byCrew: 0, byContractor: 0, crews: 0, floods: 0, floodTiles: 0, billed: 0, billedCost: 0, waived: 0, gritRounds: 0, gritTiles: 0, stayedHome: 0,
  };

  constructor(private w: World, private sim: Simulation, private mobile: Mobile) {
    mobile.register(this);
    if (w.severeLoaded) { this.load(w.severeLoaded as SevereSave); w.severeLoaded = null; }
    w.severeSave = () => this.save();
    sim.stayHome = (c) => this.staysHome(c);
    sim.closedAt = (x, y) => this.floodedB.size > 0 && this.floodedB.has(tkey(x, y));
    // the W4 hook: the shared one (one world a process on a server or in local mode) and this world's own on its Traffic
    ROAD_WEATHER.gritted = sim.traffic.gritted = (x, y) => this.isGritted(x, y);
    const prev = w.onTileChanged;
    w.onTileChanged = (x, y) => { prev?.(x, y); this.tileChanged(x, y); };
  }

  // ---- the tick ------------------------------------------------------------------------------------------------------

  tick() {
    if (!this.enabled) return;
    const w = this.w, tick = w.tick, h = Math.floor(tick / TPH);
    if (tick % TPH === PHASE && h !== this.hourDone) { this.dirty = false; this.hourDone = h; this.hourly(h); }
    else if (this.dirty) { this.dirty = false; this.flood(); } // a load, or a wall built or taken down: the water now
    if (this.gritters.size) for (const u of [...this.gritters]) {
      if (!this.mobile.units.has(u.v.id)) { this.gritters.delete(u); continue; }
      if (u.v.lane >= 0) this.grit(Math.floor(u.v.x), Math.floor(u.v.y));
    }
    if (tick % DISPATCH_EVERY === 7 && (this.rounds.size || [...this.trees.values()].some((t) => !t.crew))) this.dispatch();
    for (const t of this.trees.values()) if (tick >= t.until && !t.working) this.clearTree(t, 'contractor');
  }

  private hourly(h: number) {
    this.warn(h);
    this.storm(h);
    this.flood();
    this.gritPlan(h);
    const now = this.w.tick;
    for (const [k, until] of this.gritted) if (until <= now) this.gritted.delete(k);
  }

  // ---- warnings ------------------------------------------------------------------------------------------------------

  private warn(h: number) {
    const w = this.w;
    for (const e of severeOutlook(w.seed, h * TPH)) {
      if (e.from <= this.warned[e.kind]) continue;
      this.warned[e.kind] = e.from;
      this.stats.warnings.push({ kind: e.kind, at: h, from: e.from, to: e.to });
      const text = warningText(e, h);
      const [x, y] = this.centre();
      this.news?.severe({
        headline: e.kind === 'storm' ? `${text.replace('Storm warning: ', 'Storm warning for {place}: ')}` : `${text.replace('Flood warning: ', 'Flood warning for {place}: ')}`,
        x, y, s: e.kind === 'storm' ? 45 : 55, ref: `severe|warn|${e.kind}|${e.from}`,
      });
      for (const [owner, n] of this.atRisk(e)) {
        const p = w.players.get(owner);
        if (!p || owner === 'sys') continue;
        this.notices.push({ owner, msg: e.kind === 'storm'
          ? `${text}: overhead lines may fault and trees may fall across roads. Builders' yards send crews to clear them`
          : `${text}: ${n.tiles} of your tiles by the water${n.buildings ? ` (${n.buildings} building${n.buildings === 1 ? '' : 's'})` : ''} could flood. Flood defences (the Flood wall tool) hold the water back` });
      }
    }
  }
  /** Who a spell threatens: every owner of land in a storm; in a flood, owners of tiles that flood at its peak. */
  private atRisk(e: SevereEvent): Map<string, { tiles: number; buildings: number }> {
    const out = new Map<string, { tiles: number; buildings: number }>(), w = this.w;
    for (const q of w.parcels.values()) {
      let r = out.get(q.owner);
      if (e.kind === 'storm') { if (!r) out.set(q.owner, { tiles: q.w * q.h, buildings: 0 }); continue; }
      let tiles = 0, buildings = 0;
      for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
        if (!floodsAt(floodRiskAt(w.seed, x, y), e.peak) || this.walls.has(tkey(x, y))) continue;
        tiles++;
        if (w.buildings.has(tileKey(x, y))) buildings++;
      }
      if (!tiles) continue;
      if (!r) out.set(q.owner, r = { tiles: 0, buildings: 0 });
      r.tiles += tiles; r.buildings += buildings;
    }
    return out;
  }
  /** Somewhere to hang a world-wide story: the world's home, or its first parcel. */
  private centre(): [number, number] {
    const w = this.w;
    if (w.home) return w.home;
    for (const q of w.parcels.values()) return [q.x + Math.floor(q.w / 2), q.y + Math.floor(q.h / 2)];
    return [0, 0];
  }

  // ---- storms: fallen trees ------------------------------------------------------------------------------------------

  private roll(x: number, y: number, h: number, salt: number) {
    return hash2((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(h, 83492791)) | 0, (Math.imul(this.w.seed | 0, 2654435761) ^ salt) | 0);
  }
  /**
   * The tile at (x, y) when its chunk is one somebody has built in (World chunk `modified`), else undefined: floods and
   * trees look only there, so what they do never depends on which wild chunks happen to be loaded (by a client looking).
   */
  private builtTile(x: number, y: number): number | undefined {
    const c = this.w.getChunk(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE), false);
    return c?.modified ? this.w.peekTile(x, y) : undefined;
  }
  /** A tree stands on (x, y): a park's grounds, or open grass with a wild tree on it (one tile in four, by hash). */
  private treeAt(x: number, y: number): boolean {
    const w = this.w, t = this.builtTile(x, y);
    if (t === undefined || isRoad(t) || terrainOf(t) !== Terrain.Grass) return false;
    const z = zoneOf(t);
    if (z === Zone.None) return !w.auxAt(x, y) && hash2(x * 13 + 7, y * 29 + 3) < 0.25;
    const b = w.buildings.get(tileKey(...(w.auxAt(x, y) ? w.doorOf(x, y) : [x, y]) as [number, number]));
    return !!b && leisureAt(b.id, b.level, b.x, b.y)?.type === 'park';
  }
  private storm(h: number) {
    const w = this.w;
    if (!weatherFor(w.seed, h * TPH).storm || this.trees.size >= SEVERE.treeMax) return;
    for (const ch of w.chunks.values()) {
      if (!ch.modified) continue;
      for (let i = 0; i < ch.tiles.length && this.trees.size < SEVERE.treeMax; i++) {
        const t = ch.tiles[i];
        if (!isRoad(t) || terrainOf(t) === Terrain.Water) continue;
        const x = ch.cx * CHUNK_SIZE + (i % CHUNK_SIZE), y = ch.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE), a = ch.aux[i];
        if (a >= 0x40 || isBridgeAux(a)) continue; // a junction structure, a bridge
        if (this.roll(x, y, h, 0x5eed) >= SEVERE.treePerHour) continue;
        const k = tkey(x, y);
        if (this.trees.has(k)) continue;
        const d = DIRS4.find(([dx, dy]) => this.treeAt(x + dx, y + dy));
        if (!d) continue;
        const tr: Tree = { id: this.nextTree++, x, y, dx: d[0], dy: d[1], at: w.tick, until: w.tick + SEVERE.treeClearHours * TPH, crew: 0, working: false, tries: 0 };
        this.trees.set(k, tr);
        this.sim.traffic.closures.add(k);
        this.stats.trees++;
        this.changed = true;
        const owner = w.parcelAt(x, y)?.owner;
        if (owner && owner !== 'sys') this.notices.push({ owner, msg: `A tree has come down across the road at (${x}, ${y}): it is closed until a crew from a builders' yard clears it` });
        this.news?.severe({ headline: 'Storm brings trees down across roads in {place}', x, y, s: 35, ref: `severe|trees|${h - (h % 12)}` });
      }
    }
  }
  private clearTree(t: Tree, by: 'crew' | 'contractor') {
    const k = tkey(t.x, t.y);
    if (this.trees.get(k) !== t) return;
    this.trees.delete(k);
    if (!this.flooded.has(k)) this.sim.traffic.closures.delete(k);
    this.stats[by === 'crew' ? 'byCrew' : 'byContractor']++;
    if (t.crew && by === 'contractor') { const u = this.mobile.units.get(t.crew); if (u && u.stops[0]?.ref === t.id) { u.stops.shift(); } }
    this.changed = true;
  }

  // ---- floods --------------------------------------------------------------------------------------------------------

  /** Tiles under water at `level`: a flood fill from the water's edge through floodable land; defences hold while the level is at most wallHold. */
  floodFill(level: number, walls = true): Set<number> {
    const w = this.w, seed = w.seed, out = new Set<number>(), queue: number[] = [];
    if (level <= 0) return out;
    const hold = walls && this.walls.size > 0 && level <= SEVERE.wallHold;
    const water = (x: number, y: number) => { const t = w.peekTile(x, y); return t !== undefined && terrainOf(t) === Terrain.Water; };
    const floodable = (x: number, y: number) => {
      const t = this.builtTile(x, y);
      if (t === undefined || terrainOf(t) === Terrain.Water) return false;
      if (hold && this.walls.has(tkey(x, y))) return false;
      return floodsAt(floodRiskAt(seed, x, y), level);
    };
    for (const ch of w.chunks.values()) {
      if (!ch.modified) continue;
      const risk = floodRiskChunk(seed, ch.cx, ch.cy);
      for (let i = 0; i < risk.length; i++) {
        if (!risk[i] || !floodsAt((risk[i] - 1) / 254, level)) continue;
        const x = ch.cx * CHUNK_SIZE + (i % CHUNK_SIZE), y = ch.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE), k = tkey(x, y);
        if (out.has(k) || !floodable(x, y) || !DIRS4.some(([dx, dy]) => water(x + dx, y + dy))) continue;
        out.add(k); queue.push(x, y);
      }
    }
    for (let q = 0; q < queue.length; q += 2) {
      const x = queue[q], y = queue[q + 1];
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy, k = tkey(nx, ny);
        if (out.has(k) || !floodable(nx, ny)) continue;
        out.add(k); queue.push(nx, ny);
      }
    }
    return out;
  }
  /** The flood now: the river level, the tiles under it, closures, closed buildings, damage, news. Also after a wall is built. */
  flood() {
    const w = this.w, lv = riverLevel(w.seed, w.tick);
    const was = this.flooded.size;
    if (Math.abs(lv - this.level) > 0.005) this.changed = true;
    this.level = lv;
    const next = lv >= SEVERE.floodFrom ? this.floodFill(lv) : new Set<number>();
    let same = next.size === this.flooded.size;
    if (same) for (const k of next) if (!this.flooded.has(k)) { same = false; break; }
    if (same) return;
    for (const k of this.flooded) if (!next.has(k) && !this.trees.has(k)) this.sim.traffic.closures.delete(k);
    this.flooded.clear();
    this.floodedB.clear();
    let roads = 0;
    const fresh: number[] = [];
    for (const k of next) {
      this.flooded.add(k);
      const [x, y] = untkey(k), t = w.peekTile(x, y)!;
      if (isRoad(t)) { this.sim.traffic.closures.add(k); roads++; continue; }
      if (zoneOf(t) === Zone.None) continue;
      const [dx, dy] = w.auxAt(x, y) ? w.doorOf(x, y) : [x, y], dk = tkey(dx, dy);
      if (!w.buildings.has(tileKey(dx, dy)) || this.floodedB.has(dk)) continue;
      this.floodedB.add(dk);
      if (!this.damaged.has(dk)) { this.damaged.add(dk); fresh.push(dk); }
    }
    this.changed = true;
    if (!was && next.size) { this.spell++; this.stats.floods++; }
    this.stats.floodTiles = Math.max(this.stats.floodTiles, next.size);
    // the bills: each building once a flood, never a level lost
    const bills = new Map<string, { n: number; cost: number; waived: number }>();
    for (const dk of fresh) {
      const [x, y] = untkey(dk), b = w.buildings.get(tileKey(x, y))!, owner = w.parcelAt(x, y)?.owner;
      if (!owner) continue;
      const cost = Math.round(SEVERE.damageShare * buildingValue(b.id, b.level));
      let r = bills.get(owner);
      if (!r) bills.set(owner, r = { n: 0, cost: 0, waived: 0 });
      r.n++;
      if (cost <= 0) continue;
      if (this.away(owner) || floodInsured(owner)) { r.waived += cost; this.stats.waived += cost; continue; }
      r.cost += cost;
    }
    for (const [owner, r] of bills) {
      if (r.cost > 0) { w.credit(owner, -r.cost, 'flood'); this.stats.billed += r.n; this.stats.billedCost += r.cost; }
      if (owner === 'sys') continue;
      this.notices.push({ owner, msg: `Floodwater in ${r.n} of your building${r.n === 1 ? '' : 's'} by the water${r.cost ? `: $${r.cost.toLocaleString('en-GB')} of damage` : ''}${r.waived ? ' (waived: you were away)' : ''}. People stay home and shops shut until it goes down; nothing is lost for good` });
    }
    if (next.size) {
      const [x, y] = untkey(next.values().next().value as number);
      this.news?.severe({ headline: `Floods close ${roads} road${roads === 1 ? '' : 's'} in {place}${this.floodedB.size ? `; ${this.floodedB.size} buildings under water` : ''}`, x, y, s: 60, ref: `severe|flood|${this.spell}` });
    } else if (was) {
      const [x, y] = this.centre();
      this.news?.severe({ headline: 'Floodwater goes down in {place}: roads reopen', x, y, s: 40, ref: `severe|flood|${this.spell}` });
      this.damaged.clear();
    }
  }
  private away(owner: string): boolean {
    const p = this.w.players.get(owner);
    if (!p || owner === 'sys' || p.seen === undefined) return false;
    return (this.w.tick - p.seen) / TICKS_PER_DAY >= LAND_TUNING.awayPauseDays;
  }
  private staysHome(c: Citizen): boolean {
    if (!this.floodedB.size) return false;
    const yes = this.floodedB.has(tkey(c.hx, c.hy)) || (c.job && this.floodedB.has(tkey(c.wx, c.wy)));
    if (yes) this.stats.stayedHome++;
    return yes;
  }

  // ---- flood defences ------------------------------------------------------------------------------------------------

  /** Build flood defences along `tiles` (the player's own empty land), or take down the one at tiles[0] (half back). */
  wall(p: Player, tiles: [number, number][], remove: boolean, sandbox: boolean): string {
    const w = this.w;
    if (remove) {
      const [x, y] = tiles[0] ?? [NaN, NaN], k = tkey(x, y), o = this.walls.get(k);
      if (!o) return 'There is no flood wall there';
      if (o !== p.id && !sandbox) return 'That flood wall is not yours';
      this.walls.delete(k); this.wallVer++; this.changed = true; this.dirty = true;
      w.credit(o, Math.round(SEVERE.wallCost / 2), 'build');
      return `Flood wall taken down at (${x}, ${y}), half its cost back`;
    }
    const ok: [number, number][] = [];
    let skipped = 0;
    for (const [x, y] of tiles.slice(0, 160)) {
      if (this.walls.has(tkey(x, y)) || ok.some(([a, b]) => a === x && b === y)) continue;
      const t = w.peekTile(x, y), q = w.parcelAt(x, y);
      if (t === undefined || terrainOf(t) === Terrain.Water || isRoad(t) || zoneOf(t) !== Zone.None || w.auxAt(x, y) || !q || (q.owner !== p.id && !sandbox)) { skipped++; continue; }
      ok.push([x, y]);
    }
    if (!ok.length) return 'A flood wall goes on your own empty land (no road, zone or building), on the bank above the water';
    const cost = ok.length * SEVERE.wallCost;
    if (w.spendable(p) < cost) return w.shortOf(p, cost, `for ${ok.length} tiles of flood wall`);
    w.credit(p.id, -cost, 'build');
    for (const [x, y] of ok) this.walls.set(tkey(x, y), p.id);
    this.wallVer++; this.changed = true; this.dirty = true;
    return `Flood wall built: ${ok.length} tiles, $${cost.toLocaleString('en-GB')}${skipped ? ` (${skipped} tiles skipped: not your empty land)` : ''}. It holds the water back until the river is ${Math.round(SEVERE.wallHold * 100)}% up`;
  }
  /** A tile changed: a wall under a new road, zone or building goes. */
  private tileChanged(x: number, y: number) {
    const k = tkey(x, y);
    if (!this.walls.has(k)) return;
    const t = this.w.peekTile(x, y);
    if (t !== undefined && !isRoad(t) && zoneOf(t) === Zone.None && terrainOf(t) !== Terrain.Water) return;
    this.walls.delete(k); this.wallVer++; this.changed = true; this.dirty = true;
  }
  /** Tiles a wall keeps dry at the level it holds (behind it), for the overlay. */
  protectedTiles(): Set<number> {
    if (!this.walls.size) return new Set();
    if (this.protectedCache?.ver === this.wallVer) return this.protectedCache.set;
    const open = this.floodFill(SEVERE.wallHold, false), held = this.floodFill(SEVERE.wallHold, true), set = new Set<number>();
    for (const k of open) if (!held.has(k) && !this.walls.has(k)) set.add(k);
    this.protectedCache = { ver: this.wallVer, set };
    return set;
  }

  // ---- gritters ------------------------------------------------------------------------------------------------------

  private grit(x: number, y: number) {
    const t = this.w.peekTile(x, y);
    if (t === undefined || !isRoad(t)) return; // pulling out of the yard: not a road yet
    const k = tkey(x, y), until = this.w.tick + SEVERE.gritHours * TPH;
    if ((this.gritted.get(k) ?? 0) < until - TPH) { if (!this.gritted.has(k)) this.stats.gritTiles++; this.gritted.set(k, until); }
  }
  /** Is the road tile (x, y) gritted now? */
  isGritted(x: number, y: number): boolean { return this.gritted.size > 0 && (this.gritted.get(tkey(x, y)) ?? 0) > this.w.tick; }
  /** Snow lying now or forecast within gritAhead hours. */
  gritWanted(h: number): boolean {
    const seed = this.w.seed;
    for (let k = 0; k <= SEVERE.gritAhead; k++) { const x = weatherFor(seed, (h + k) * TPH); if (x.snowCover > 0.05 || (x.snow && x.rain > 0.1)) return true; }
    return false;
  }
  private gritPlan(h: number) {
    if (!this.gritWanted(h)) { this.rounds.clear(); return; }
    const w = this.w, now = w.tick, tr = this.sim.traffic, R = SEVERE.gritReach;
    for (const b of w.builtOf(Zone.Yard)) {
      if (b.level <= 0) continue;
      const yk = tkey(b.x, b.y);
      if (this.rounds.has(yk) || [...this.gritters].some((u) => u.base[0] === b.x && u.base[1] === b.y)) continue;
      const cand: { x: number; y: number; s: number }[] = [];
      for (let y = b.y - R; y <= b.y + R; y++) for (let x = b.x - R; x <= b.x + R; x++) {
        const d = Math.abs(x - b.x) + Math.abs(y - b.y);
        if (d > R) continue;
        const t = w.peekTile(x, y);
        if (t === undefined || !isRoad(t) || terrainOf(t) === Terrain.Water) continue;
        const a = w.auxAt(x, y);
        if (a >= 0x40 || isBridgeAux(a)) continue;
        if ((this.gritted.get(tkey(x, y)) ?? 0) > now + (SEVERE.gritHours * TPH) / 2) continue;
        const cls = roadClassAt(t, a);
        const main = cls === RoadCls.Avenue || cls === RoadCls.Motorway || cls === RoadCls.Ring ? 3 : tr.degreeOf(x, y) >= 3 ? 2 : 1;
        cand.push({ x, y, s: main * 1000 - d });
      }
      if (cand.length < 4) continue;
      cand.sort((p, q) => q.s - p.s);
      const pick = cand.slice(0, SEVERE.gritStops * SEVERE.gritStep);
      const stops: Stop[] = [];
      let cx = b.x, cy = b.y, n = 0;
      while (pick.length && stops.length < SEVERE.gritStops) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < pick.length; i++) { const dd = Math.abs(pick[i].x - cx) + Math.abs(pick[i].y - cy); if (dd < bd) { bd = dd; bi = i; } }
        const { x, y } = pick.splice(bi, 1)[0];
        if (n++ % SEVERE.gritStep === 0) stops.push({ x, y, kerb: false, pass: true, dwell: 0, bx: x, by: y, what: 2, ref: 0 });
        cx = x; cy = y;
      }
      if (stops.length) this.rounds.set(yk, stops);
    }
  }

  // ---- crews and gritters out of the yards -----------------------------------------------------------------------------

  /** Builders on shift at a yard with no site and free to go out, by the yard's door key. */
  private freeBuilders(): Map<number, Citizen[]> {
    const out = new Map<number, Citizen[]>();
    for (const c of this.w.citizens.values()) {
      if (!c.job || c.site || familyOf(c.kind) !== Zone.Yard || !this.mobile.free(c) || this.mobile.unitOf(c.id)) continue;
      const k = tkey(c.wx, c.wy);
      let l = out.get(k);
      if (!l) out.set(k, l = []);
      l.push(c);
    }
    return out;
  }
  private outFrom(x: number, y: number) { let n = 0; for (const u of this.mobile.units.values()) if (u.svc === this && u.base[0] === x && u.base[1] === y) n++; return n; }
  private dispatch() {
    const free = this.freeBuilders();
    if (!free.size) return;
    // fallen trees: the nearest yard in reach with a free builder (and room for another crew)
    for (const t of [...this.trees.values()].sort((a, b) => a.id - b.id)) {
      if (t.crew || t.tries >= MAX_TRIES) continue;
      let best: Citizen | null = null, bd = Infinity;
      for (const l of free.values()) {
        const c = l[0];
        if (!c) continue;
        const d = Math.abs(c.wx - t.x) + Math.abs(c.wy - t.y);
        if (d <= SEVERE.crewReach && d < bd && this.outFrom(c.wx, c.wy) < SEVERE.crewPerYard + 1) { bd = d; best = c; }
      }
      if (!best) continue;
      const stop: Stop = { x: t.x, y: t.y, kerb: true, dwell: gameMin(SEVERE.crewMinutes), bx: t.x, by: t.y, what: 1, ref: t.id };
      const u = this.mobile.launch(this, best, FleetKind.RoadCrew, [best.wx, best.wy], [best.wx, best.wy], [stop], `on the way to a fallen tree at (${t.x}, ${t.y})`);
      free.get(tkey(best.wx, best.wy))!.shift();
      if (!u) { t.tries++; continue; }
      t.crew = u.v.id; this.stats.crews++;
    }
    // gritter rounds: the yard's own free builder
    for (const [yk, stops] of [...this.rounds]) {
      const l = free.get(yk), c = l?.shift();
      if (!c) continue;
      const u = this.mobile.launch(this, c, FleetKind.Gritter, [c.wx, c.wy], [c.wx, c.wy], stops.slice(), 'gritting the main roads');
      this.rounds.delete(yk);
      if (!u) continue;
      u.working = true; // spreading all the way round
      this.gritters.add(u);
      this.stats.gritRounds++;
    }
  }

  // FleetService
  arrive(u: Unit, s: Stop) {
    if (s.what !== 1) return;
    const t = this.treeById(s.ref);
    if (t) { t.working = true; u.task = `clearing a fallen tree at (${t.x}, ${t.y})`; }
  }
  depart(_u: Unit, s: Stop) {
    if (s.what !== 1) return;
    const t = this.treeById(s.ref);
    if (t) this.clearTree(t, 'crew');
  }
  unreachable(_u: Unit, s: Stop) { if (s.what === 1) { const t = this.treeById(s.ref); if (t) { t.crew = 0; t.working = false; t.tries++; } } }
  withdrawn(u: Unit) { this.gritters.delete(u); for (const t of this.trees.values()) if (t.crew === u.v.id) { t.crew = 0; t.working = false; } }
  returned(u: Unit) { this.gritters.delete(u); }
  label(u: Unit) { return u.kind === FleetKind.Gritter ? 'gritter' : 'road crew truck'; }
  baseName(c: Citizen) { const b = this.w.buildings.get(tileKey(c.wx, c.wy)); return b ? KIND_NAMES[b.id] : "builders' yard"; }
  describe(bx: number, by: number, kindId: number): FleetInfoRows | null {
    if (familyOf(kindId) !== Zone.Yard) return null;
    let crews = 0, grit = 0;
    for (const u of this.mobile.units.values()) if (u.svc === this && u.base[0] === bx && u.base[1] === by) { if (u.kind === FleetKind.Gritter) grit++; else crews++; }
    if (!crews && !grit && !this.trees.size && !this.rounds.size) return null;
    return { role: 'Road crews and gritters', rows: [['Clearing fallen trees', `${crews}`], ['Gritting', `${grit}`]] };
  }
  private treeById(id: number) { for (const t of this.trees.values()) if (t.id === id) return t; return undefined; }

  // ---- the wire, the overlay, the save -------------------------------------------------------------------------------

  msg(): Extract<ServerMsg, { t: 'severe' }> {
    const trees: number[] = [], flood: number[] = [], walls: number[] = [];
    for (const t of this.trees.values()) trees.push(t.x, t.y);
    let n = 0;
    for (const k of this.flooded) { if (n++ >= WIRE_FLOOD_MAX) break; const [x, y] = untkey(k); flood.push(x, y); }
    for (const k of this.walls.keys()) { const [x, y] = untkey(k); walls.push(x, y); }
    return { t: 'severe', trees, flood, walls, level: Math.round(this.level * 1000) / 1000 };
  }
  /** The Flood risk overlay (shared/src/issues.ts OVERLAY_FLOOD): risk on every dry tile, a third of it behind defences, the top under water now. */
  overlayBytes(cx: number, cy: number, tiles: Uint16Array): Uint8Array {
    const out = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE), risk = floodRiskChunk(this.w.seed, cx, cy), prot = this.protectedTiles();
    for (let i = 0; i < out.length; i++) {
      if (!risk[i] || terrainOf(tiles[i]) === Terrain.Water) continue;
      const k = tkey(cx * CHUNK_SIZE + (i % CHUNK_SIZE), cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE));
      const r = (risk[i] - 1) / 254;
      out[i] = this.flooded.has(k) ? 255 : overlayByte(prot.has(k) || this.walls.has(k) ? r / 3 : 0.1 + 0.85 * r);
    }
    return out;
  }
  private save(): SevereSave | null {
    const s: SevereSave = {};
    if (this.warned.storm > -1e9 || this.warned.flood > -1e9) s.warned = { ...this.warned };
    if (this.trees.size) s.trees = [...this.trees.values()].map((t) => [t.x, t.y, t.dx, t.dy, t.at, t.until]);
    if (this.walls.size) s.walls = [...this.walls].map(([k, o]) => { const [x, y] = untkey(k); return [x, y, o]; });
    if (this.damaged.size) s.damaged = [...this.damaged];
    if (this.gritted.size) s.gritted = [...this.gritted].map(([k, u]) => { const [x, y] = untkey(k); return [x, y, u]; });
    if (this.spell) s.spell = this.spell;
    if (this.nextTree > 1) s.nextTree = this.nextTree;
    return Object.keys(s).length ? s : null;
  }
  private load(s: SevereSave) {
    if (s.warned && typeof s.warned === 'object') this.warned = { storm: Number(s.warned.storm) || -1e9, flood: Number(s.warned.flood) || -1e9 };
    this.nextTree = Number(s.nextTree) || 1;
    for (const r of Array.isArray(s.trees) ? s.trees : []) {
      const [x, y, dx, dy, at, until] = r.map(Number);
      if (![x, y, at, until].every(Number.isFinite)) continue;
      const k = tkey(x, y);
      this.trees.set(k, { id: this.nextTree++, x, y, dx: dx || 0, dy: dy || 0, at, until, crew: 0, working: false, tries: 0 });
      this.sim.traffic.closures.add(k);
    }
    for (const r of Array.isArray(s.walls) ? s.walls : []) if (Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])) && typeof r[2] === 'string') this.walls.set(tkey(Number(r[0]), Number(r[1])), r[2]);
    for (const k of Array.isArray(s.damaged) ? s.damaged : []) if (Number.isFinite(Number(k))) this.damaged.add(Number(k));
    for (const r of Array.isArray(s.gritted) ? s.gritted : []) if (r.every((v) => Number.isFinite(Number(v)))) this.gritted.set(tkey(Number(r[0]), Number(r[1])), Number(r[2]));
    this.spell = Number(s.spell) || 0;
  }
}
