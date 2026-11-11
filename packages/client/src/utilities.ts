import {
  Group, InstancedMesh, BoxGeometry, Matrix4, Color, Quaternion, Vector3, Euler, MeshLambertMaterial, MeshBasicMaterial, PlaneGeometry,
  LineSegments, LineBasicMaterial, LineDashedMaterial, BufferGeometry, Float32BufferAttribute,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CHUNK_SIZE, UTIL, UtilRole, UtilState, UTIL_STATE_WORDS, UTIL_ROLE_OF, KIND_NAMES, MOTORWAY_KIND,
  UtilityField, chunkUtilSig, utilityAt, doorAt, utilKey, pylonSpots, linkCost, trackDragPath, isRoad, zoneOf, levelOf, kindIdOf, hash2, parseKey, terrainOf, Terrain,
  type UtilEnv, type UtilNode, type UtilLinkDTO, type UtilityInfo, type ServerMsg,
} from '@msimcity/shared';
import { powerTexture, OVL_SIZE, sceneUniforms } from './render/materials';
import type { ClientChunk, ClientWorld } from './world';
import type { ChunkView } from './render/chunkView';

const N = CHUNK_SIZE * CHUNK_SIZE;
const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
/** how dark the power map makes a tile, by node state (the window and lamp shaders read it) */
const DARK = [0, 40, 255, 255, 0];
/** the power overlay's road byte by node state: supplied, brownout, cut, fault, a dead node's streets */
const HEAT = [64, 128, 192, 192, 255];
/** a node coming back lights up block by block (4×4 tiles) over this many ms */
const RESTORE_MIN = 20_000, RESTORE_SPAN = 40_000;
/** the most towers and birds drawn */
const MAX_TOWERS = 4000, MAX_BIRDS = 600;
/** chunks whose power bytes are worked out per frame */
const FILL_PER_FRAME = 24;

type LinkTool = 'pylons' | 'cable';
type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/**
 * The client's half of utilities (docs/utilities.md section 4.5). From the loaded tiles it runs the same reach as the
 * server (shared UtilityField), so it knows which node serves every road tile and building without anything on the
 * wire; the hourly `utilState` says how each node is. With that it fills
 *
 * - the power map (render/materials.ts powerTexture): dark tiles in a cut or fault, dimmed in a brownout, read by the
 *   window and street-lamp shaders, coming back block by block over 20 to 60 s when the power returns;
 * - the power overlay: road bytes on the congestion path (ChunkView.heat, uHeatMode 1);
 *
 * and draws the trunk links: lattice towers with sagging wires along overhead links (each tower its own lean and
 * paint, a bird or two on some spans), buried links as a dashed red line while a link tool or the overlay is on, and
 * the green or red preview under a link drag.
 */
export class PowerClient {
  group = new Group();
  readonly field = new UtilityField();
  readonly env: UtilEnv;
  /** each plant's output percent by tile key, from the last utilState */
  private plants = new Map<number, number>();
  /** node state and load by door key, from the last utilState */
  readonly states = new Map<number, number>();
  readonly loads = new Map<number, number>();
  links: UtilLinkDTO[] = [];
  private down = new Set<number>();
  hour = -1;
  /** the power overlay is showing */
  overlayOn = false;
  private chunkNodes = new Map<string, UtilNode[]>();
  private sigs = new Map<string, number>();
  private fieldDirty = false;
  private lastRebuild = 0;
  private texDirty = new Set<string>();
  /** when each node came back on (performance.now), while its blocks are still relighting */
  private restore = new Map<number, number>();
  private lastRestoreFrame = 0;
  private heat = new Map<string, Uint8Array>();
  private data = powerTexture.image.data as Uint8Array;
  private darkTiles = new Map<string, number>();
  // drawing
  private towers: InstancedMesh;
  private birds: InstancedMesh;
  private wires = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true }));
  private buried = new LineSegments(new BufferGeometry(), new LineDashedMaterial({ color: 0xd8342a, dashSize: 0.35, gapSize: 0.22 }));
  private preview: InstancedMesh;
  private memo: { key: string; at: number; v: LinkVerdict } | null = null;

  constructor(private world: ClientWorld, private viewOf: (key: string) => ChunkView | undefined) {
    this.env = {
      tile: (x, y) => world.getTile(x, y), sub: (x, y) => world.subAt(x, y), aux: (x, y) => world.auxAt(x, y),
      owner: (x, y) => { const id = world.parcelIdAt(x, y); return id ? world.parcels.get(id)?.owner ?? null : null; },
      // service contracts (M8): a provider's network walks a buyer's roads on parcels under a power contract (as the server)
      access: (o, x, y) => this.powerBy.size > 0 && this.powerBy.get(world.parcelIdAt(x, y)) === o,
    };
    this.towers = new InstancedMesh(towerGeometry(), new MeshLambertMaterial({ vertexColors: false }), MAX_TOWERS);
    this.towers.count = 0; this.towers.frustumCulled = false; this.towers.castShadow = true;
    this.towers.setColorAt(0, new Color(0xffffff));
    this.birds = new InstancedMesh(new BoxGeometry(0.03, 0.025, 0.05), new MeshLambertMaterial({ color: 0x2a2724 }), MAX_BIRDS);
    this.birds.count = 0; this.birds.frustumCulled = false;
    this.wires.frustumCulled = false; this.buried.frustumCulled = false; this.buried.visible = false;
    this.preview = new InstancedMesh(new PlaneGeometry(0.92, 0.92).rotateX(-Math.PI / 2), new MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false }), 256);
    this.preview.count = 0; this.preview.frustumCulled = false; this.preview.setColorAt(0, new Color(0xffffff));
    this.group.add(this.towers, this.birds, this.wires, this.buried, this.preview);
  }

  // ---- what the tiles and the server say ---------------------------------------------------------------------------

  /** power contracts this player is a party to (M8, the `services` message): parcel id -> provider */
  private powerBy = new Map<number, string>();
  /** The `services` message's contracts (M8): the reach of a provider's network over its buyers' streets. */
  setContracts(list: readonly { service: string; provider: string; parcels: number[] }[]) {
    const next = new Map<number, string>();
    for (const c of list) if (c.service === 'power') for (const id of c.parcels) next.set(id, c.provider);
    const same = next.size === this.powerBy.size && [...next].every(([k, v]) => this.powerBy.get(k) === v);
    if (same) return;
    this.powerBy = next;
    this.fieldDirty = true;
  }
  /** A chunk was (re)built: if its roads, owners or nodes changed, the field is rebuilt soon; its power bytes are redone. */
  scanChunk(key: string, c: ClientChunk) {
    let sig = chunkUtilSig(c.tiles, c.sub);
    for (let i = 0; i < N; i++) if (isRoad(c.tiles[i]) && c.parcel[i]) sig = Math.imul(sig ^ (c.parcel[i] * 7919 + i), 16777619) >>> 0;
    this.texDirty.add(key);
    if (this.sigs.get(key) === sig) return;
    this.sigs.set(key, sig);
    const nodes: UtilNode[] = [];
    const x0 = c.cx * CHUNK_SIZE, y0 = c.cy * CHUNK_SIZE;
    for (let i = 0; i < N; i++) {
      const t = c.tiles[i];
      if (isRoad(t) || !UTIL_ROLE_OF[kindIdOf(zoneOf(t), c.sub[i])] || levelOf(t) < 1) continue;
      const x = x0 + (i % CHUNK_SIZE), y = y0 + Math.floor(i / CHUNK_SIZE);
      const u = utilityAt(this.env, x, y), owner = this.env.owner(x, y);
      if (u && u.role === UtilRole.Node && owner) nodes.push({ key: utilKey(x, y), x, y, kind: u.kind, owner });
    }
    this.chunkNodes.set(key, nodes);
    this.fieldDirty = true;
  }
  dropChunk(key: string) {
    this.sigs.delete(key); this.heat.delete(key); this.texDirty.delete(key);
    if (this.chunkNodes.delete(key)) this.fieldDirty = true;
    this.clearTex(key);
  }

  setState(m: Msg<'utilState'>) {
    const now = performance.now();
    this.hour = m.h;
    for (let i = 0; i + 3 < m.n.length; i += 4) {
      const key = utilKey(m.n[i], m.n[i + 1]), s = m.n[i + 2];
      const was = this.states.get(key);
      if (was !== undefined && DARK[was] === 255 && DARK[s] !== 255) this.restore.set(key, now);
      this.states.set(key, s); this.loads.set(key, m.n[i + 3]);
    }
    this.plants.clear();
    if (m.p) for (let i = 0; i + 2 < m.p.length; i += 3) this.plants.set(utilKey(m.p[i], m.p[i + 1]), m.p[i + 2]);
    for (const k of this.world.chunks.keys()) this.texDirty.add(k);
  }
  /** A power plant's output as a percent of its full rating at the last hourly solve, by its tile (undefined: not told yet or not a plant). */
  plantOutput(x: number, y: number): number | undefined { return this.plants.get(utilKey(x, y)); }
  setLinks(m: Msg<'utilLinks'>) {
    this.links = m.links; this.down = new Set(m.down ?? []);
    this.drawLinks();
  }

  // ---- per frame ---------------------------------------------------------------------------------------------------

  frame(now: number, tool: string, path: [number, number][] | null) {
    if (this.fieldDirty && now - this.lastRebuild > 400) {
      this.fieldDirty = false; this.lastRebuild = now;
      this.field.rebuild([...this.chunkNodes.values()].flat(), this.env);
      for (const k of this.world.chunks.keys()) this.texDirty.add(k);
    }
    if (this.restore.size && now - this.lastRestoreFrame > 250) {
      this.lastRestoreFrame = now;
      for (const [k, t] of this.restore) if (now - t > RESTORE_MIN + RESTORE_SPAN) this.restore.delete(k);
      for (const k of this.world.chunks.keys()) this.texDirty.add(k);
    }
    if (this.texDirty.size) {
      let budget = FILL_PER_FRAME; // spread over frames: an hourly refresh of every loaded chunk is no hitch
      for (const key of this.texDirty) { if (budget-- <= 0) break; this.fill(key, now); this.texDirty.delete(key); }
      powerTexture.needsUpdate = true;
      let dark = 0;
      for (const n of this.darkTiles.values()) dark += n;
      sceneUniforms.uPow.value = dark > 0 ? 1 : 0;
    }
    const linkTool = tool === 'pylons' || tool === 'cable';
    this.buried.visible = linkTool || this.overlayOn;
    this.drawPreview(linkTool ? path : null, tool as LinkTool);
  }

  /** The power overlay on or off: the roads take the power bytes on the congestion path (main.ts swaps traffic back). */
  setOverlay(on: boolean) {
    this.overlayOn = on;
    sceneUniforms.uHeatMode.value = on ? 1 : 0;
    for (const k of this.world.chunks.keys()) this.texDirty.add(k);
  }
  /** The bytes the overlay gives a chunk's roads, or undefined while it is off. */
  heatOf(key: string) { return this.overlayOn ? this.heat.get(key) : undefined; }

  /** The node serving a tile for its owner (a road: its own; a building: by its door), as a field index, or -1. */
  private nodeFor(x: number, y: number, t: number, cx: number, cy: number): number {
    if (isRoad(t)) {
      const owner = this.env.owner(x, y), by = this.powerBy.size ? this.powerBy.get(this.world.parcelIdAt(x, y)) : undefined;
      if (by) { const i = this.field.nodeIndexAt(by, x, y); if (i >= 0) return i; }
      if (owner) return this.field.nodeIndexAt(owner, x, y);
      for (const o of this.field.ownersIn(cx, cy)) { const i = this.field.nodeIndexAt(o, x, y); if (i >= 0) return i; }
      return -1;
    }
    if (zoneOf(t) === 0 || levelOf(t) < 1) return -1;
    const d = doorAt(this.env, x, y);
    if (!d) return -1;
    const owner = this.env.owner(d[0], d[1]), by = this.powerBy.size ? this.powerBy.get(this.world.parcelIdAt(d[0], d[1])) : undefined;
    if (by) { const i = this.field.serving(by, d[0], d[1]); if (i >= 0) return i; }
    return owner ? this.field.serving(owner, d[0], d[1]) : -1;
  }
  private fill(key: string, now: number) {
    const c = this.world.chunks.get(key);
    if (!c) return;
    const [cx, cy] = parseKey(key);
    const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE;
    const tx = ((x0 % OVL_SIZE) + OVL_SIZE) % OVL_SIZE, ty = ((y0 % OVL_SIZE) + OVL_SIZE) % OVL_SIZE;
    let heat = this.heat.get(key);
    if (this.overlayOn && !heat) this.heat.set(key, heat = new Uint8Array(N));
    let dark = 0;
    const any = this.field.nodes.length > 0;
    for (let i = 0; i < N; i++) {
      const x = x0 + (i % CHUNK_SIZE), y = y0 + Math.floor(i / CHUNK_SIZE), t = c.tiles[i];
      const n = any ? this.nodeFor(x, y, t, cx, cy) : -1;
      let b = 0, h = 0;
      if (n >= 0) {
        const k = this.field.nodes[n].key, s = this.states.get(k) ?? UtilState.Unpowered;
        b = DARK[s] ?? 0;
        const back = this.restore.get(k);
        if (back !== undefined && now - back < RESTORE_MIN + RESTORE_SPAN * hash2(Math.floor(x / 4) * 7 + 1, Math.floor(y / 4) * 13 + 5)) b = 255;
        if (isRoad(t)) h = HEAT[s] ?? 0;
      }
      if (b) dark++;
      this.data[(ty + Math.floor(i / CHUNK_SIZE)) * OVL_SIZE + tx + (i % CHUNK_SIZE)] = b;
      if (heat) heat[i] = h;
    }
    this.darkTiles.set(key, dark);
    if (this.overlayOn) { const v = this.viewOf(key); if (v) { v.heat = heat; v.tintRoads(); } }
  }
  private clearTex(key: string) {
    const [cx, cy] = parseKey(key);
    const tx = (((cx * CHUNK_SIZE) % OVL_SIZE) + OVL_SIZE) % OVL_SIZE, ty = (((cy * CHUNK_SIZE) % OVL_SIZE) + OVL_SIZE) % OVL_SIZE;
    for (let y = 0; y < CHUNK_SIZE; y++) this.data.fill(0, (ty + y) * OVL_SIZE + tx, (ty + y) * OVL_SIZE + tx + CHUNK_SIZE);
    this.darkTiles.delete(key);
    powerTexture.needsUpdate = true;
  }

  // ---- links -------------------------------------------------------------------------------------------------------

  private drawLinks() {
    const m = new Matrix4(), q = new Quaternion(), e = new Euler(), p = new Vector3(), s = new Vector3(1, 1, 1), col = new Color();
    const wire: number[] = [], wireCol: number[] = [], dash: number[] = [];
    let nt = 0, nb = 0;
    const clear = (x: number, y: number) => { const t = this.world.getTile(x, y); return t === undefined || isRoad(t) || zoneOf(t) === 0 || levelOf(t) === 0; };
    for (const l of this.links) {
      if (l.mode === 'buried') {
        for (let i = 0; i + 3 < l.tiles.length; i += 2) dash.push(l.tiles[i] + 0.5, 0.035, l.tiles[i + 1] + 0.5, l.tiles[i + 2] + 0.5, 0.035, l.tiles[i + 3] + 0.5);
        continue;
      }
      const spots = pylonSpots(l.tiles, clear);
      const down = this.down.has(l.id);
      const tops: [number, number, number, number][] = []; // x, z, yaw, height of each tower
      for (let i = 0; i < spots.length; i += 2) {
        if (nt >= MAX_TOWERS) break;
        const x = spots[i], y = spots[i + 1];
        const nx = spots[Math.min(i + 2, spots.length - 2)] - spots[Math.max(0, i - 2)], ny = spots[Math.min(i + 3, spots.length - 1)] - spots[Math.max(1, i - 1)];
        const yaw = Math.atan2(nx, ny); // the arms stand across the run
        const h1 = hash2(x * 17 + 3, y * 29 + 7), h2 = hash2(x * 5 + 11, y * 3 + 2);
        const ht = 0.92 + 0.12 * h1;
        e.set((h2 - 0.5) * 0.05, yaw, (h1 - 0.5) * 0.05); // each tower its own small lean
        q.setFromEuler(e); p.set(x + 0.5, 0, y + 0.5); s.set(1, ht, 1);
        m.compose(p, q, s);
        this.towers.setMatrixAt(nt, m);
        col.setRGB(0.62 + 0.18 * h2, 0.64 + 0.16 * h2, 0.66 + 0.14 * h1); // paint faded to its own grey
        this.towers.setColorAt(nt, col);
        nt++;
        tops.push([x + 0.5, y + 0.5, yaw, ht]);
      }
      // the conductors: two per side on each arm, sagging between towers
      for (let i = 0; i + 1 < tops.length; i++) {
        const [ax, az, ay, ah] = tops[i], [bx, bz, by, bh] = tops[i + 1];
        const len = Math.hypot(bx - ax, bz - az), sag = 0.06 + 0.012 * len + 0.03 * hash2(Math.round(ax * 3), Math.round(bz * 3));
        for (const [arm, hy] of [[0.24, 0.6], [-0.24, 0.6], [0.17, 0.79], [-0.17, 0.79]] as const) {
          const pa = [ax + Math.cos(ay) * arm, hy * ah, az - Math.sin(ay) * arm], pb = [bx + Math.cos(by) * arm, hy * bh, bz - Math.sin(by) * arm];
          let prev = pa;
          for (let k = 1; k <= 8; k++) {
            const t = k / 8;
            const pt = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t - sag * 4 * t * (1 - t), pa[2] + (pb[2] - pa[2]) * t];
            wire.push(prev[0], prev[1], prev[2], pt[0], pt[1], pt[2]);
            const c = down ? [0.8, 0.2, 0.15] : [0.16, 0.17, 0.19];
            wireCol.push(...c, ...c);
            prev = pt;
          }
          // a bird or two on some spans, sitting on the lower wires
          if (hy < 0.7 && nb < MAX_BIRDS && hash2(Math.round(ax * 7 + arm * 10), Math.round(az * 11)) < 0.22) {
            const t = 0.25 + 0.5 * hash2(Math.round(ax * 13), Math.round(bz * 5 + arm * 7));
            const bpos = new Vector3(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t - sag * 4 * t * (1 - t) + 0.015, pa[2] + (pb[2] - pa[2]) * t);
            m.compose(bpos, q.setFromEuler(e.set(0, ay + Math.PI / 2, 0)), s.set(1, 1, 1));
            this.birds.setMatrixAt(nb++, m);
          }
        }
      }
    }
    this.towers.count = nt; this.towers.instanceMatrix.needsUpdate = true; if (this.towers.instanceColor) this.towers.instanceColor.needsUpdate = true;
    this.birds.count = nb; this.birds.instanceMatrix.needsUpdate = true;
    const wg = new BufferGeometry();
    wg.setAttribute('position', new Float32BufferAttribute(wire, 3)); wg.setAttribute('color', new Float32BufferAttribute(wireCol, 3));
    this.wires.geometry.dispose(); this.wires.geometry = wg;
    const bg = new BufferGeometry();
    bg.setAttribute('position', new Float32BufferAttribute(dash, 3));
    this.buried.geometry.dispose(); this.buried.geometry = bg; this.buried.computeLineDistances();
  }

  /** What the server will say to a link drag, worked out on the loaded tiles (cached briefly). */
  verdict(tool: LinkTool, path: [number, number][]): LinkVerdict {
    const key = `${tool}|${path[0]}|${path[path.length - 1]}`, now = performance.now();
    if (this.memo && this.memo.key === key && now - this.memo.at < 200) return this.memo.v;
    const v = this.judge(tool, path);
    this.memo = { key, at: now, v };
    return v;
  }
  private judge(tool: LinkTool, drag: [number, number][]): LinkVerdict {
    const path = trackDragPath(drag[0], drag[drag.length - 1]);
    const tiles = path.flatMap(([x, y]) => [x, y]);
    const wet = (x: number, y: number) => { const t = this.world.getTile(x, y); return t !== undefined && terrainOf(t) === Terrain.Water && !isRoad(t); };
    const cost = linkCost(tool === 'pylons' ? 'overhead' : 'buried', tiles, wet);
    const fail = (reason: string): LinkVerdict => ({ ok: false, reason, path, cost });
    if (path.length < 2) return fail('drag from a power station or substation to another (click a line to take it down)');
    if (path.length > UTIL.maxLinkTiles) return fail(`a trunk line is at most ${UTIL.maxLinkTiles} tiles long`);
    for (const [x, y] of path) {
      const o = this.env.owner(x, y);
      if (o && !this.world.mayEdit(o)) return fail('a trunk line runs only over your land or unowned land');
    }
    const a = this.endAt(path[0][0], path[0][1]), b = this.endAt(path[path.length - 1][0], path[path.length - 1][1]);
    if (!a) return fail('start on or beside one of your power stations, substations or grid supply points');
    if (!b) return fail('end on or beside a power station, substation, grid supply point or motorway connection');
    if (a === b) return fail('the line must join two different places');
    return { ok: true, path, cost, ends: [a, b] };
  }
  private endAt(x: number, y: number): string | null {
    const at = (qx: number, qy: number): string | null => {
      const d = doorAt(this.env, qx, qy);
      if (!d) return null;
      const t = this.world.getTile(d[0], d[1]);
      if (t === undefined || levelOf(t) < 1) return null;
      const k = kindIdOf(zoneOf(t), this.world.subAt(d[0], d[1]));
      if (k === MOTORWAY_KIND) return `${KIND_NAMES[k]}@${d}`;
      const role = UTIL_ROLE_OF[k], o = this.env.owner(d[0], d[1]);
      if ((role !== UtilRole.Node && role !== UtilRole.Plant) || !o || !this.world.mayEdit(o)) return null;
      return `${KIND_NAMES[k]}@${d}`;
    };
    const here = at(x, y);
    if (here) return here;
    for (let d = 0; d < 4; d++) { const r = at(x + DX[d], y + DY[d]); if (r) return r; }
    return null;
  }
  /** Status-line text for a link tool. */
  status(tool: LinkTool, path: [number, number][] | null): string {
    const what = tool === 'pylons' ? 'pylons' : 'buried cable';
    if (!path || path.length < 2) return ` · drag from a power station, substation or grid supply point to another for ${what} ($${tool === 'pylons' ? UTIL.overheadCost : UTIL.buriedCost} a tile); click a line to take it down`;
    const v = this.verdict(tool, path);
    if (!v.ok) return ` · ${v.reason}`;
    return ` · ${v.path.length} tiles of ${what} from the ${v.ends![0].split('@')[0]} to the ${v.ends![1].split('@')[0]}, $${v.cost.toLocaleString('en-GB')} · release to lay it`;
  }
  private drawPreview(path: [number, number][] | null, tool: LinkTool) {
    if (!path || path.length < 2) { this.preview.count = 0; return; }
    const v = this.verdict(tool, path);
    const m = new Matrix4(), c = new Color(v.ok ? 0x62d2a2 : 0xff3b30);
    let n = 0;
    for (const [x, y] of v.path) {
      if (n >= 256) break;
      m.makeTranslation(x + 0.5, 0.05, y + 0.5);
      this.preview.setMatrixAt(n, m); this.preview.setColorAt(n, c);
      n++;
    }
    this.preview.count = n;
    this.preview.instanceMatrix.needsUpdate = true;
    if (this.preview.instanceColor) this.preview.instanceColor.needsUpdate = true;
  }

  /** A road tile's power line for the hover status: which node serves it and how it is. */
  roadStatus(x: number, y: number): string {
    const t = this.world.getTile(x, y);
    if (t === undefined || !isRoad(t)) return '';
    const i = this.nodeFor(x, y, t, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
    if (i < 0) return '';
    const n = this.field.nodes[i];
    return ` · power: ${UTIL_STATE_WORDS[this.states.get(n.key) ?? UtilState.Unpowered]} (${KIND_NAMES[n.kind]} at ${n.x}, ${n.y})`;
  }
}

export interface LinkVerdict { ok: boolean; reason?: string; path: [number, number][]; cost: number; ends?: [string, string] }

/** A lattice tower about a tile tall: a tapered body, two cross arms and a cap, in local units (y up, arms along x). */
function towerGeometry() {
  const parts = [
    new BoxGeometry(0.1, 0.5, 0.1).translate(0, 0.25, 0),
    new BoxGeometry(0.06, 0.42, 0.06).translate(0, 0.71, 0),
    new BoxGeometry(0.56, 0.025, 0.04).translate(0, 0.6, 0),
    new BoxGeometry(0.4, 0.025, 0.04).translate(0, 0.79, 0),
    new BoxGeometry(0.03, 0.08, 0.03).translate(0, 0.94, 0),
    // the splayed feet
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => new BoxGeometry(0.03, 0.18, 0.03).translate(i * 0.07, 0.09, j * 0.07)),
  ];
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

/** The building panel's utilities section (BuildingInfo.utilities, server sim/utilities.ts info). `mine`: buttons for the owner. */
export function utilitiesHtml(u: UtilityInfo, row: (k: string, v: string | number) => string, mine: boolean): string {
  const bad = (s: string) => `<span class="bad">${s}</span>`;
  const word = (s: number) => (s === UtilState.Ok ? 'supplied' : s === UtilState.Brown ? 'brownout' : bad(UTIL_STATE_WORDS[s] ?? 'no supply'));
  let html = '';
  if (u.power) {
    const p = u.power;
    html += `<div class="sect">Power</div>`;
    if (!p.node) html += row('Supply', p.needed ? bad('not connected: a substation within reach of this street lets it grow past one storey') : 'not connected');
    else {
      html += row('Supply', `${word(p.state)} · ${KIND_NAMES[p.nodeKind ?? 0] ?? 'substation'} at (${p.node[0]}, ${p.node[1]})${p.steps !== undefined && p.steps < 99 ? `, ${p.steps} road tile${p.steps === 1 ? '' : 's'} away` : ''}`);
      if (p.units > 0) html += row('This hour', `${p.units.toFixed(1)} units · bill $${p.bill.toFixed(2)}`);
      if (p.repair) html += row('Repair', p.repair);
      if (p.state !== UtilState.Ok && p.needed) html += row('Growth', bad('paused until the power is back'));
    }
  }
  const n = u.network;
  if (n) {
    html += `<div class="sect">Power network</div>`;
    if (n.role === 'node') html += row('This node', `${word(n.state ?? UtilState.Unpowered)} · load ${n.load ?? 0}%${n.protect ? ' · protected' : ''}`);
    if (n.role === 'plant') html += row('Generating', `${n.output ?? 0} units an hour (${Math.round((n.share ?? 0) * 100)}% of full)`);
    if (n.role === 'depot') html += row('Repair vans', `${n.vans ?? 0} out now`);
    if (n.nodes) {
      const margin = n.demand > 0 ? n.supply / n.demand - 1 : 1;
      html += row('Network', `${n.nodes} node${n.nodes === 1 ? '' : 's'}, ${n.plants} power station${n.plants === 1 ? '' : 's'}`);
      html += row('Demand / supply', `${n.demand} / ${n.supply} units${n.demand > 0 && margin < UTIL.amberMargin ? (margin < 0 ? ` ${bad('short')}` : ' <span class="warn">tight</span>') : ''}`);
      html += row('This hour', `${n.generated} generated · ${n.imported} from the grid`);
      html += row('Grid import', n.importable ? `${n.importOn ? `on, up to ${n.importCap} units at $${UTIL.importPrice} a unit` : 'switched off'}` : `out of reach: within ${UTIL.importReach} road tiles of a motorway connection, or a trunk line to one`);
    } else if (n.role !== 'depot') html += row('Network', bad('not joined to a substation: put one whose streets reach its gate, or lay pylons or a buried cable'));
    n.faults.forEach((f, i) => { html += row('Fault', bad(f)) + (n.repair?.[i] ? row('Repair', n.repair[i]) : ''); });
    if (mine && n.role === 'node') html += `<button class="chip" data-util="protect" data-on="${n.protect ? 0 : 1}" title="A protected node is cut last in rolling cuts (hospitals and police are never cut)">${n.protect ? 'Unprotect' : 'Protect'}</button>`;
    if (mine && n.role !== 'depot') html += ` <button class="chip" data-util="import" data-on="${n.importOn ? 0 : 1}" title="Grid import tops up a shortfall at $${UTIL.importPrice} a unit">${n.importOn ? 'Grid import off' : 'Grid import on'}</button>`;
  }
  return html;
}
