import { InstancedMesh, Group, Matrix4, Quaternion, Vector3, Color, MeshLambertMaterial, IcosahedronGeometry, ConeGeometry, DynamicDrawUsage, type BufferGeometry } from 'three';
import { CHUNK_SIZE, isRoad, zoneOf, levelOf, hash2, leisureAt, kindIdOf, type Attributes } from '@msimcity/shared';
import type { ClientChunk } from '../world';
import { Kit } from './kit';
import { VenueLights } from './nightlife';
import { leafMaterial, leafDepthMaterial } from './seasons';

/**
 * Trees and benches inside park tiles, as instances (not building models), so a city full of parks costs a few
 * draw calls and never eats into the building BatchedMesh's instance cap. Each park tile plants the number of
 * trees and benches its design asks for (attributes `trees`, `benches`), around its path layout (`paths`), with
 * hash-seeded positions, sizes, species and colours: no two parks look alike and nothing repeats in lockstep.
 * Positions follow the park model's own facing and scale (the same rules render/chunkView.ts uses).
 */
const MAX_TREES = 30000, MAX_BENCHES = 10000;
const UP = new Vector3(0, 1, 0);
const LAWN_TOP = 0.012;

function broadleafGeometry(): BufferGeometry {
  const k = new Kit();
  k.cyl(0.011, 0.016, 0.1, 0, 0, 0, 0x6b4a2b, 5);
  k.part(new IcosahedronGeometry(0.075, 0).translate(0, 0.15, 0), 0x6aa84f);
  k.part(new IcosahedronGeometry(0.05, 0).translate(0.03, 0.2, -0.02), 0x77b65a);
  return k.build();
}
function coniferGeometry(): BufferGeometry {
  const k = new Kit();
  k.cyl(0.01, 0.013, 0.06, 0, 0, 0, 0x5d3f25, 5);
  k.part(new ConeGeometry(0.065, 0.13, 7).translate(0, 0.11, 0), 0x3f7a3a);
  k.part(new ConeGeometry(0.048, 0.1, 7).translate(0, 0.18, 0), 0x47864a);
  return k.build();
}
function benchGeometry(): BufferGeometry {
  // seat along x, backrest on the +z side: the bench faces -z
  const k = new Kit();
  k.box(0.08, 0.007, 0.024, 0, 0.02, 0, 0x8a6a45);
  k.box(0.08, 0.022, 0.005, 0, 0.027, 0.011, 0x8a6a45);
  k.box(0.006, 0.02, 0.022, -0.033, 0, 0, 0x2b2e36);
  k.box(0.006, 0.02, 0.022, 0.033, 0, 0, 0x2b2e36);
  return k.build();
}

/** Canopy tints by season and species mix: fresh, deep, olive, a few turning gold or copper. */
const TREE_TINTS = [0xffffff, 0xe6f5dc, 0xd7e8cf, 0xf2f0d0, 0xfff1c4, 0xffd9a8].map((c) => new Color(c));

/** Where trees may not stand, by path layout, in the park model's own frame (tile centre 0,0; +z faces the road). */
function blocked(paths: string, x: number, z: number): boolean {
  const ax = Math.abs(x), az = Math.abs(z), m = Math.max(ax, az);
  switch (paths) {
    case 'cross': return ax < 0.13 || az < 0.13 || m > 0.43;
    case 'ring': return (m > 0.23 && m < 0.39) || (ax < 0.08 && z > 0.22) || m < 0.2 || m > 0.46;
    case 'plaza': return ax < 0.14 || az < 0.14 || m < 0.28 || (x < -0.18 && z < -0.18) || m > 0.43;
    case 'pond': return (x > -0.44 && x < 0.2 && z > -0.41 && z < 0.13) || z > 0.27 || (Math.abs(x - 0.3) < 0.09 && z > -0.2) || (x > 0.21 && z < -0.21) || m > 0.46;
    default: return m > 0.46;
  }
}
/** Bench spots by path layout: x, z and the bench's own turn (it faces -z before turning). */
const BENCH_SPOTS: Record<string, [number, number, number][]> = {
  cross: [[0.26, 0.12, Math.PI], [-0.26, -0.12, 0], [-0.26, 0.12, Math.PI], [0.26, -0.12, 0], [0.12, 0.26, Math.PI / 2], [-0.12, -0.26, -Math.PI / 2], [0.12, -0.26, Math.PI / 2], [-0.12, 0.26, -Math.PI / 2]],
  ring: [[0.14, 0.205, 0], [-0.14, -0.205, Math.PI], [0.205, -0.12, -Math.PI / 2], [-0.205, 0.12, Math.PI / 2], [-0.14, 0.205, 0], [0.14, -0.205, Math.PI]],
  plaza: [[0.18, 0.21, 0], [-0.18, -0.21, Math.PI], [0.21, -0.18, -Math.PI / 2], [-0.21, 0.18, Math.PI / 2], [-0.06, 0.21, 0], [0.06, -0.21, Math.PI], [0.21, 0.06, -Math.PI / 2], [-0.21, -0.06, Math.PI / 2]],
  pond: [[-0.32, 0.25, Math.PI], [-0.12, 0.25, Math.PI], [0.08, 0.25, Math.PI], [0.36, 0.1, -Math.PI / 2]],
};

export interface ParkLayout { paths: string; trees: number; benches: number }
export interface Scatter { trees: { m: Matrix4; c: Color; conifer: boolean }[]; benches: Matrix4[] }

const tq = new Quaternion(), tp = new Vector3(), ts = new Vector3(), tl = new Vector3();
/**
 * Trees and benches for one park tile centred at (cx, cz) world, model turned by yaw and scaled by s.
 * (tx, tz) seed the hashes, so a tile always grows the same park.
 */
export function scatterPark(p: ParkLayout, tx: number, tz: number, cx: number, cz: number, yaw: number, s: number, out: Scatter) {
  const th = hash2(tx * 41 + 3, tz * 29 + 17);
  const n = Math.max(0, Math.round(p.trees + (th - 0.5) * 2.4));
  const pConifer = 0.1 + 0.45 * hash2(tz * 19 + 2, tx * 23 + 5);
  const tintBase = Math.floor(hash2(tx * 3 + 8, tz * 11 + 1) * 3); // a park leans to one palette, trees vary within it
  const placed: [number, number][] = [];
  for (let i = 0, tries = 0; placed.length < n && tries < n * 14; tries++, i++) {
    const lx = (hash2(tx * 31 + i * 7, tz * 17 + i * 13) - 0.5) * 0.94, lz = (hash2(tz * 37 + i * 11, tx * 13 + i * 5) - 0.5) * 0.94;
    if (blocked(p.paths, lx, lz)) continue;
    if (placed.some(([px, pz]) => (px - lx) ** 2 + (pz - lz) ** 2 < 0.012)) continue;
    placed.push([lx, lz]);
    const hh = hash2(tx * 5 + i * 3, tz * 7 + i * 17), hk = hash2(i * 19 + tx, tz * 3 - i);
    const conifer = hk < pConifer;
    const size = (0.7 + 0.6 * hh) * s;
    tl.set(lx * s, 0, lz * s).applyAxisAngle(UP, yaw);
    tp.set(cx + tl.x, LAWN_TOP, cz + tl.z);
    tq.setFromAxisAngle(UP, hh * Math.PI * 2);
    ts.set(size * (0.9 + 0.2 * hk), size * (0.85 + 0.35 * hash2(i, tx + tz)), size * (0.9 + 0.2 * hk));
    const c = TREE_TINTS[(tintBase + Math.floor(hk * 3)) % TREE_TINTS.length].clone().multiplyScalar(0.85 + 0.3 * hh);
    out.trees.push({ m: new Matrix4().compose(tp, tq, ts), c, conifer });
  }
  const spots = BENCH_SPOTS[p.paths] ?? [];
  const nb = Math.min(spots.length, p.benches);
  const start = Math.floor(th * spots.length);
  for (let i = 0; i < nb; i++) {
    const [bx, bz, turn] = spots[(start + i) % spots.length];
    tl.set(bx * s, 0, bz * s).applyAxisAngle(UP, yaw);
    tp.set(cx + tl.x, LAWN_TOP, cz + tl.z);
    tq.setFromAxisAngle(UP, yaw + turn);
    ts.setScalar(s);
    out.benches.push(new Matrix4().compose(tp, tq, ts));
  }
}
const layoutOf = (a: Attributes | { paths: string; trees: number; benches: number }): ParkLayout => ({
  paths: typeof a.paths === 'string' ? a.paths : '', trees: typeof a.trees === 'number' ? a.trees : 0, benches: typeof a.benches === 'number' ? a.benches : 0,
});

/** The meshes: two tree species and benches. */
class ParkMeshes {
  group = new Group();
  broadleaf: InstancedMesh; conifer: InstancedMesh; benches: InstancedMesh;
  constructor(trees: number, benches: number) {
    const mat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    // broadleaf trees go through the year (render/seasons.ts); conifers stay green and only take snow
    const broadOpts = { crownY: 0.17, above: 0.09 }, coniferOpts = { crownY: 0.14, above: 0.09, evergreen: true };
    const mk = (g: BufferGeometry, n: number, o?: typeof broadOpts | typeof coniferOpts) => {
      const m = new InstancedMesh(g, o ? leafMaterial(o) : mat, n);
      if (o) { const d = leafDepthMaterial(o); if (d) m.customDepthMaterial = d; }
      m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      this.group.add(m);
      return m;
    };
    this.broadleaf = mk(broadleafGeometry(), trees, broadOpts);
    this.conifer = mk(coniferGeometry(), trees, coniferOpts);
    this.benches = mk(benchGeometry(), benches);
    this.benches.castShadow = false;
  }
  fill(scatters: Iterable<Scatter>) {
    let nb = 0, nc = 0, ns = 0;
    for (const sc of scatters) {
      for (const t of sc.trees) {
        const mesh = t.conifer ? this.conifer : this.broadleaf;
        const i = t.conifer ? nc : nb;
        if (i >= mesh.instanceMatrix.count) continue;
        mesh.setMatrixAt(i, t.m); mesh.setColorAt(i, t.c);
        if (t.conifer) nc++; else nb++;
      }
      for (const m of sc.benches) { if (ns < this.benches.instanceMatrix.count) this.benches.setMatrixAt(ns++, m); }
    }
    for (const [mesh, n] of [[this.broadleaf, nb], [this.conifer, nc], [this.benches, ns]] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}

/** Park scatter for every loaded chunk, and the lights of venues and nightlife after dark (render/nightlife.ts); rebuilt only when a chunk's tiles change. */
export class ParksView {
  private meshes = new ParkMeshes(MAX_TREES, MAX_BENCHES);
  group = this.meshes.group;
  private venues = new VenueLights();
  constructor() { this.group.add(this.venues.group); }
  private perChunk = new Map<string, Scatter>();
  private dirty = false;

  /** Re-plant a chunk's parks (call after its tiles change, like the building rebuild). */
  scanChunk(key: string, chunk: ClientChunk, getTile: (x: number, y: number) => number | undefined) {
    this.venues.scanChunk(key, chunk, getTile);
    const out: Scatter = { trees: [], benches: [] };
    const x0 = chunk.cx * CHUNK_SIZE, z0 = chunk.cy * CHUNK_SIZE;
    const roadAt = (x: number, z: number) => { const t = getTile(x, z); return t === undefined ? true : isRoad(t); };
    for (let i = 0; i < chunk.tiles.length; i++) {
      const t = chunk.tiles[i];
      if (isRoad(t)) continue;
      const kind = kindIdOf(zoneOf(t), chunk.sub[i]), level = levelOf(t);
      if (!kind || !level) continue;
      const x = x0 + (i % CHUNK_SIZE), z = z0 + Math.floor(i / CHUNK_SIZE);
      const sp = leisureAt(kind, level, x, z);
      if (!sp || sp.type !== 'park' || !sp.trees) continue;
      // facing and scale exactly as chunkView places the park model
      const h = hash2(x, z), h2 = hash2(z * 3 + 1, x * 5 + 7);
      let yaw: number;
      if (roadAt(x, z + 1) && getTile(x, z + 1) !== undefined) yaw = 0;
      else if (roadAt(x + 1, z) && getTile(x + 1, z) !== undefined) yaw = Math.PI / 2;
      else if (roadAt(x - 1, z) && getTile(x - 1, z) !== undefined) yaw = -Math.PI / 2;
      else if (roadAt(x, z - 1) && getTile(x, z - 1) !== undefined) yaw = Math.PI;
      else yaw = Math.floor(h * 4) * (Math.PI / 2);
      scatterPark(layoutOf(sp), x, z, x + 0.5, z + 0.5, yaw, 0.95 + 0.1 * h2, out);
    }
    if (out.trees.length || out.benches.length) this.perChunk.set(key, out);
    else if (!this.perChunk.delete(key)) return;
    this.dirty = true;
  }
  dropChunk(key: string) { this.venues.dropChunk(key); if (this.perChunk.delete(key)) this.dirty = true; }
  /** `day`: the game day, for venues' event nights */
  frame(day = 0) {
    this.venues.frame(day);
    if (!this.dirty) return;
    this.dirty = false;
    this.meshes.fill(this.perChunk.values());
  }
}

/** One park's trees and benches on their own, for the building viewer's turntable. */
export function parkScatterGroup(attrs: Attributes, seed = 7): Group | null {
  const p = layoutOf(attrs);
  if (!p.trees && !p.benches) return null;
  const out: Scatter = { trees: [], benches: [] };
  scatterPark(p, seed, seed * 3 + 1, 0, 0, 0, 1, out);
  const m = new ParkMeshes(Math.max(1, out.trees.length), Math.max(1, out.benches.length));
  m.fill([out]);
  return m.group;
}
