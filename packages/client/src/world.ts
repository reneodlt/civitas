import { CHUNK_SIZE, landPriceOf, floodRiskAt, floodPriceMul, b64ToU16, b64ToI32, b64ToU8, chunkKey, chunkOf, localIndex, structureAt, kindIdOf, zoneOf, isRoad, type Placed, type ChunkDTO, type ParcelDTO, type PlayerDTO, type RoadRule, type RoadRuleDTO } from '@msimcity/shared';

export interface ClientChunk { cx: number; cy: number; tiles: Uint16Array; parcel: Int32Array; aux: Uint8Array; /** kind ids of sub-kinds (docs/sub-kinds.md) */ sub: Uint8Array; /** tunnels and platforms (docs/underground.md) */ under: Uint8Array; dirty: boolean;
  /** what changed since the chunk was last rebuilt (DIRTY_* bits): render/chunkWork.ts runs only the passes that read it */
  mask: number;
  /** when it was first marked since its last rebuild began (performance.now ms): how stale its drawing can be */
  markedAt?: number }

/**
 * What a change touches, so a rebuild runs only the passes that read it (render/chunkWork.ts PASSES): the road shape (a
 * tile's road bit or terrain, an aux byte: kerbs, junctions, signs, bridges, rails, runways), the buildings (a tile's
 * family, level, construction flag, progress or priority, a sub byte, a parcel id) and the underground (an under byte).
 */
export const DIRTY_SHAPE = 1, DIRTY_BUILD = 2, DIRTY_UNDER = 4, DIRTY_ALL = 7;
/** the tile word's terrain, road and family bits: what a change to the layout of roads and stops touches (ClientWorld.layoutVersion) */
const LAYOUT_BITS = 0x7f;

/**
 * What marks chunks dirty, counted by cause (docs/perf.md, "What the jitter is: chunk rebuilds"): `marks` are clean-to-dirty
 * transitions (each one a rebuild owed), `sets` every write of the flag, `tiles` the tile entries the messages carried and
 * `changed` those whose value actually differed. `msc.perf.dirty()` reads them as rates.
 */
export const DIRTY_CAUSES = ['chunk', 'chunk-edge', 'tiles', 'tiles-edge', 'aux', 'aux-edge', 'sub', 'under'] as const;
export type DirtyCause = (typeof DIRTY_CAUSES)[number];
export class DirtyStats {
  marks: Record<DirtyCause, number> = Object.fromEntries(DIRTY_CAUSES.map((c) => [c, 0])) as Record<DirtyCause, number>;
  sets: Record<DirtyCause, number> = { ...this.marks };
  tiles: Record<DirtyCause, number> = { ...this.marks };
  changed: Record<DirtyCause, number> = { ...this.marks };
  /** chunks waiting for a rebuild (the scheduler's queue: render/chunkWork.ts) */
  readonly queue = new Set<ClientChunk>();
  mark(c: ClientChunk, cause: DirtyCause, bits: number) {
    this.sets[cause]++;
    c.mask |= bits;
    if (!c.dirty) { this.marks[cause]++; c.dirty = true; c.markedAt = performance.now(); }
    this.queue.add(c);
  }
}

/** Client-side mirror of the part of the world we are subscribed to. */
export class ClientWorld {
  chunks = new Map<string, ClientChunk>();
  readonly dirtyStats = new DirtyStats();
  /**
   * The old invalidation, for paired measurements (msc.chunkWork.setLegacy): every tile entry marks its chunk whether
   * or not it changed, every edge tile marks the neighbour, and every mark is a whole rebuild.
   */
  legacyDirty = false;
  parcels = new Map<number, ParcelDTO>();
  players = new Map<string, PlayerDTO>();
  me = '';
  /** a frontier start and its road end (welcome.start, welcome.home; docs/first-five.md section 0) */
  start: 'commons' | 'frontier' = 'commons';
  home: [number, number] | null = null;
  /** a sandbox (test city or demo, from the welcome): anyone may edit any parcel and buy land anywhere */
  sandbox = false;
  /** a shared world's market rules (welcome.land, docs/multiplayer-land.md M2): land priced by value, outposts, the homestead */
  market = false;
  /** market rules: each subscribed chunk's land price bytes (the `landPrice` message, shared/src/land.ts); absent: the wild price */
  landPrices = new Map<string, Uint8Array>();
  parcelsDirty = false;
  /**
   * Bumps whenever something a transit line depends on changed on the server: a tile's road bit, terrain or family (a road
   * laid or lifted, a stop built or taken down), an aux, sub or under byte. Not a building growing a level, and not a chunk
   * arriving (`chunksVersion` counts those: the client's view moved, not the world). The line editor watches both (lines.ts):
   * the first routes its draft again, the two together refresh the stop markers.
   */
  layoutVersion = 0;
  chunksVersion = 0;
  /** per chunk: congestion on roads (0-255) and cars parked in lots */
  traffic = new Map<string, Uint8Array>();
  trafficDirty = new Set<string>();
  /** per chunk: cars parked at the kerb of each road tile (absent when none) */
  kerb = new Map<string, Uint8Array>();
  /** per chunk: issue codes (shared/src/issues.ts Issue) at buildings' door tiles, absent when none; bumped on change */
  issues = new Map<string, Uint8Array>();
  issuesVersion = 0;
  /** per chunk: the data overlay's bytes (shared/src/issues.ts Overlay) for channel `overlayCh`; chunks changed since the renderer looked */
  overlay = new Map<string, Uint8Array>();
  overlayCh = 0;
  overlayDirty = new Set<string>();
  /** your own parcels' problems (message 'problems'): flat triples x, y, code */
  problems: number[] = [];
  /**
   * Road rule records (shared/src/roadrules.ts: turn bans and no entry on a junction's arms, signal crossings) by their
   * anchor tile "x,y" (a junction group's min corner, or the crossing's tile), from 'roadRules'; `rulesVersion` bumps on
   * every change so views can rebuild.
   */
  roadRules = new Map<string, RoadRule>();
  rulesVersion = 0;
  /** each signal crossing's last granted walk phase by tile "x,y" (shared/src/signals.ts pelicanPhase), from 'walks' */
  walks = new Map<string, number>();
  applyRoadRules(r: RoadRuleDTO[]) {
    this.roadRules.clear();
    for (const [x, y, rule] of r) this.roadRules.set(`${x},${y}`, rule);
    this.rulesVersion++;
  }
  applyWalks(u: number[]) { for (let i = 0; i + 2 < u.length; i += 3) this.walks.set(`${u[i]},${u[i + 1]}`, u[i + 2]); }
  /** the road rule record anchored at (x, y), if any */
  ruleAt(x: number, y: number): RoadRule | undefined { return this.roadRules.get(`${x},${y}`); }
  /** the tick a signal crossing at (x, y) last began its walk phase (-Infinity: never, its lamps green) */
  walkAt(x: number, y: number): number { return this.walks.get(`${x},${y}`) ?? -Infinity; }

  /** a read-only showcase (SPECTATE on the server, from the welcome): nothing may be changed, a sandbox included */
  spectate = false;
  /** whether this player may edit land owned by `owner` (the server's rule: their own, or anyone's in a sandbox; nobody's in a showcase) */
  mayEdit(owner: string) { return !this.spectate && (owner === this.me || this.sandbox); }

  putChunk(dto: ChunkDTO) {
    const N = CHUNK_SIZE * CHUNK_SIZE;
    const aux = dto.aux ? b64ToU8(dto.aux) : null, sub = dto.sub ? b64ToU8(dto.sub) : null, under = dto.under ? b64ToU8(dto.under) : null;
    const c: ClientChunk = {
      cx: dto.cx, cy: dto.cy, tiles: b64ToU16(dto.tiles), parcel: b64ToI32(dto.parcels),
      aux: aux && aux.length === N ? aux : new Uint8Array(N), sub: sub && sub.length === N ? sub : new Uint8Array(N),
      under: under && under.length === N ? under : new Uint8Array(N), dirty: false, mask: 0,
    };
    const old = this.chunks.get(chunkKey(dto.cx, dto.cy));
    this.chunksVersion++;
    if (old) this.dirtyStats.queue.delete(old);
    this.chunks.set(chunkKey(dto.cx, dto.cy), c);
    this.dirtyStats.mark(c, 'chunk', DIRTY_ALL);
    // road tiling along our edges depends on neighbours, and theirs on us
    this.touch(dto.cx - 1, dto.cy, 'chunk-edge'); this.touch(dto.cx + 1, dto.cy, 'chunk-edge'); this.touch(dto.cx, dto.cy - 1, 'chunk-edge'); this.touch(dto.cx, dto.cy + 1, 'chunk-edge');
    return c;
  }
  dropChunk(key: string) {
    const c = this.chunks.get(key);
    if (c) { this.dirtyStats.queue.delete(c); this.chunksVersion++; }
    this.chunks.delete(key); this.traffic.delete(key); this.kerb.delete(key);
    if (this.issues.delete(key)) this.issuesVersion++;
    if (this.overlay.delete(key)) this.overlayDirty.add(key);
    this.landPrices.delete(key);
  }
  applyLandPrice(cx: number, cy: number, d: string) {
    if (d) this.landPrices.set(chunkKey(cx, cy), b64ToU8(d)); else this.landPrices.delete(chunkKey(cx, cy));
  }
  /** The price of a rectangle under the market rules, from the same bytes the server prices it from. */
  landPrice(r: { x: number; y: number; w: number; h: number }): number { return landPriceOf(r, (cx, cy) => this.landPrices.get(chunkKey(cx, cy)), this.riskMul); }
  /** the world seed (from `welcome`): flood risk lowers a tile's price as the server's does (docs/weather.md W6) */
  seed = 0;
  private readonly riskMul = (x: number, y: number) => floodPriceMul(floodRiskAt(this.seed, x, y));
  applyIssues(cx: number, cy: number, d: string) {
    const key = chunkKey(cx, cy);
    if (!this.chunks.has(key)) return;
    const bytes = d ? b64ToU8(d) : null;
    if (bytes && bytes.length === CHUNK_SIZE * CHUNK_SIZE) this.issues.set(key, bytes); else this.issues.delete(key);
    this.issuesVersion++;
  }
  /** The issue code at a tile (its structure's door), 0 when none or not loaded. */
  issueAt(x: number, y: number): number {
    const b = this.issues.get(chunkKey(chunkOf(x), chunkOf(y)));
    return b ? b[localIndex(x, y)] : 0;
  }
  applyOverlay(ch: number, cx: number, cy: number, d: string) {
    const key = chunkKey(cx, cy);
    if (ch !== this.overlayCh || !this.chunks.has(key)) return; // an answer for a channel switched away from
    const bytes = d ? b64ToU8(d) : null;
    if (bytes && bytes.length === CHUNK_SIZE * CHUNK_SIZE) this.overlay.set(key, bytes); else this.overlay.delete(key);
    this.overlayDirty.add(key);
  }
  /** Switch the overlay channel: the old bytes go (the server sends the new ones). */
  setOverlayChannel(ch: number) {
    if (ch === this.overlayCh) return;
    for (const key of this.overlay.keys()) this.overlayDirty.add(key);
    this.overlay.clear();
    this.overlayCh = ch;
  }

  applyTraffic(cx: number, cy: number, d: string, k?: string) {
    const key = chunkKey(cx, cy);
    if (!this.chunks.has(key)) return;
    const bytes = b64ToU8(d);
    if (bytes.length === CHUNK_SIZE * CHUNK_SIZE) this.traffic.set(key, bytes); else this.traffic.delete(key);
    const kerb = k ? b64ToU8(k) : null;
    if (kerb && kerb.length === CHUNK_SIZE * CHUNK_SIZE) this.kerb.set(key, kerb); else this.kerb.delete(key);
    this.trafficDirty.add(key);
  }
  trafficAt(x: number, y: number): number {
    const t = this.traffic.get(chunkKey(chunkOf(x), chunkOf(y)));
    return t ? t[localIndex(x, y)] : 0;
  }

  getTile(x: number, y: number): number | undefined {
    const c = this.chunks.get(chunkKey(chunkOf(x), chunkOf(y)));
    return c ? c.tiles[localIndex(x, y)] : undefined;
  }
  parcelIdAt(x: number, y: number): number {
    const c = this.chunks.get(chunkKey(chunkOf(x), chunkOf(y)));
    return c ? c.parcel[localIndex(x, y)] : 0;
  }
  parcelAt(x: number, y: number) { return this.parcels.get(this.parcelIdAt(x, y)); }
  auxAt(x: number, y: number): number {
    const c = this.chunks.get(chunkKey(chunkOf(x), chunkOf(y)));
    return c ? c.aux[localIndex(x, y)] : 0;
  }
  /** Sub byte at a tile (kind id of a sub-kind; 0 = the family's base kind or not loaded). */
  subAt(x: number, y: number): number {
    const c = this.chunks.get(chunkKey(chunkOf(x), chunkOf(y)));
    return c ? c.sub[localIndex(x, y)] : 0;
  }
  /** Under byte at a tile (tunnel or platform, shared/src/metro.ts; 0 = solid ground or not loaded). */
  underAt(x: number, y: number): number {
    const c = this.chunks.get(chunkKey(chunkOf(x), chunkOf(y)));
    return c ? c.under[localIndex(x, y)] : 0;
  }
  /** The catalogue kind id standing on a tile (0 for nothing or not loaded). */
  kindIdAt(x: number, y: number): number {
    const t = this.getTile(x, y);
    return t === undefined || isRoad(t) ? 0 : kindIdOf(zoneOf(t), this.subAt(x, y));
  }
  private auxFn = (x: number, y: number) => this.auxAt(x, y);
  private tileFn = (x: number, y: number) => this.getTile(x, y);
  private subFn = (x: number, y: number) => this.subAt(x, y);
  /** The multi-tile structure covering (x, y), if its anchor is loaded. */
  structureAt(x: number, y: number): Placed | null { return this.auxAt(x, y) ? structureAt(x, y, this.auxFn, this.tileFn, this.subFn) : null; }
  /** The tile the server knows a building by: a structure's door, else the tile itself. */
  doorOf(x: number, y: number): [number, number] {
    const s = this.structureAt(x, y);
    return s ? [s.doorX, s.doorY] : [x, y];
  }
  /** flat triples x, y, aux (the server sends them just before the matching tile words) */
  applyAux(u: number[]) {
    for (let i = 0; i < u.length; i += 3) {
      const c = this.chunks.get(chunkKey(chunkOf(u[i]), chunkOf(u[i + 1])));
      if (!c) continue;
      const li = localIndex(u[i], u[i + 1]);
      const st = this.dirtyStats; st.tiles.aux++;
      if (c.aux[li] === u[i + 2] && !this.legacyDirty) continue; // nothing to redraw
      if (c.aux[li] !== u[i + 2]) st.changed.aux++;
      if (c.aux[li] !== u[i + 2]) this.layoutVersion++;
      c.aux[li] = u[i + 2];
      st.mark(c, 'aux', DIRTY_SHAPE | DIRTY_BUILD);
      // runway ends are drawn from the neighbours' bytes, so a change on a chunk edge redraws the chunk next door
      const lx = li % CHUNK_SIZE, ly = Math.floor(li / CHUNK_SIZE);
      if (lx === 0) this.touch(c.cx - 1, c.cy, 'aux-edge'); else if (lx === CHUNK_SIZE - 1) this.touch(c.cx + 1, c.cy, 'aux-edge');
      if (ly === 0) this.touch(c.cx, c.cy - 1, 'aux-edge'); else if (ly === CHUNK_SIZE - 1) this.touch(c.cx, c.cy + 1, 'aux-edge');
    }
  }

  /** flat triples x, y, sub (the server sends them after 'aux' and before the matching tile words) */
  applySub(u: number[]) {
    for (let i = 0; i < u.length; i += 3) {
      const c = this.chunks.get(chunkKey(chunkOf(u[i]), chunkOf(u[i + 1])));
      if (!c) continue;
      const li = localIndex(u[i], u[i + 1]), st = this.dirtyStats;
      st.tiles.sub++;
      if (c.sub[li] === u[i + 2] && !this.legacyDirty) continue;
      if (c.sub[li] !== u[i + 2]) st.changed.sub++;
      if (c.sub[li] !== u[i + 2]) this.layoutVersion++;
      c.sub[li] = u[i + 2];
      st.mark(c, 'sub', DIRTY_BUILD);
    }
  }

  /** flat triples x, y, under byte (sent before 'aux' and the tile words) */
  applyUnder(u: number[]) {
    for (let i = 0; i < u.length; i += 3) {
      const c = this.chunks.get(chunkKey(chunkOf(u[i]), chunkOf(u[i + 1])));
      if (!c) continue;
      const li = localIndex(u[i], u[i + 1]), st = this.dirtyStats;
      st.tiles.under++;
      if (c.under[li] === u[i + 2] && !this.legacyDirty) continue;
      if (c.under[li] !== u[i + 2]) st.changed.under++;
      if (c.under[li] !== u[i + 2]) this.layoutVersion++;
      c.under[li] = u[i + 2];
      st.mark(c, 'under', DIRTY_UNDER);
    }
  }

  applyTiles(u: number[]) {
    for (let i = 0; i < u.length; i += 4) {
      const x = u[i], y = u[i + 1];
      const c = this.chunks.get(chunkKey(chunkOf(x), chunkOf(y)));
      if (!c) continue;
      const li = localIndex(x, y);
      const st = this.dirtyStats, was = c.tiles[li], now = u[i + 2];
      st.tiles.tiles++;
      if (was === now && c.parcel[li] === u[i + 3] && !this.legacyDirty) continue; // nothing to redraw
      if (was !== now || c.parcel[li] !== u[i + 3]) st.changed.tiles++;
      // the road bit or the terrain: kerbs, junctions and signs here and next door; anything else is the buildings only
      const shape = ((was ^ now) & 7) !== 0;
      if (((was ^ now) & LAYOUT_BITS) !== 0) this.layoutVersion++; // the road bit, terrain or family (a stop or a station going up or coming down)
      c.tiles[li] = now; c.parcel[li] = u[i + 3]; st.mark(c, 'tiles', shape ? DIRTY_SHAPE | DIRTY_BUILD : DIRTY_BUILD);
      if (!shape && !this.legacyDirty) continue; // a building on an edge tile changes nothing drawn next door (buildings there face roads, not lots)
      const lx = li % CHUNK_SIZE, ly = Math.floor(li / CHUNK_SIZE);
      if (lx === 0) this.touch(c.cx - 1, c.cy, 'tiles-edge'); else if (lx === CHUNK_SIZE - 1) this.touch(c.cx + 1, c.cy, 'tiles-edge');
      if (ly === 0) this.touch(c.cx, c.cy - 1, 'tiles-edge'); else if (ly === CHUNK_SIZE - 1) this.touch(c.cx, c.cy + 1, 'tiles-edge');
    }
  }
  private touch(cx: number, cy: number, cause: DirtyCause) {
    const n = this.chunks.get(chunkKey(cx, cy));
    if (n) this.dirtyStats.mark(n, cause, DIRTY_SHAPE | DIRTY_BUILD);
  }
  applyParcels(parcels: ParcelDTO[], removed?: number[]) {
    for (const p of parcels) this.parcels.set(p.id, p);
    for (const id of removed ?? []) this.parcels.delete(id);
    this.parcelsDirty = true;
  }
  applyPlayers(players: PlayerDTO[]) {
    for (const p of players) this.players.set(p.id, p);
  }
  get myPlayer() { return this.players.get(this.me); }
  static chunkSize = CHUNK_SIZE;
}
