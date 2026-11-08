import { BatchedMesh, Matrix4, Color, Material, Vector3, Box3, Frustum, Sphere, type Camera, type DirectionalLight } from 'three';
import { hash2, chunkKey, chunkOf, AD_SLOTS } from '@msimcity/shared';
import { buildModels, allVariants, buildFarModels } from './models';
import { Signs, SIGN_MAX_DIST, signLabel, type SignInfo } from './signs';
import { sceneUniforms } from './materials';
import { AdvertsView, type AdHostItem } from './adverts';
import { RotorsView } from './rotors';
import { WheelsView } from './wheels';
import { LeisureAnims } from './leisureAnims';
import { AmbientView } from './ambient';

const MAX_INSTANCES = 60000;

/** `ad`: the door tile and parcel id of a building or site whose design has ad slots (render/adverts.ts) */
export interface Placement { key: string; matrix: Matrix4; color: Color; sign?: SignInfo; ad?: [number, number, number] }

/**
 * Detail tiers by distance from the camera (tiles, 3D, so a high camera is far from everything):
 * - near: chunks within NEAR_IN of a camera also get name boards (signs.ts), which fade in and out per sign well
 *   inside that, so a chunk leaving the tier has nothing showing; NEAR_OUT is the hysteresis.
 * - mid: the full models.
 * - far: each building switches to its far model (models.ts farOps: small parts dropped, plain walls) past its own
 *   threshold, FAR_AT ± FAR_JITTER hashed per building so a district changes over a band rather than along a line,
 *   with FAR_HYST either side so a camera resting on the edge does not flicker. Far walls draw the window shader's
 *   plain grid instead of the facade's cells; by FAR_AT a cell is two or three pixels and the shader shows only the
 *   class average, so the switch does not read (at 95 the grid could be told apart).
 * Draw calls do not change (the BatchedMesh is one multi-draw either way); triangles, vertex work and the shadow
 * pass do.
 * Chunks wholly inside or outside the band are skipped without looking at their buildings.
 */
export const NEAR_IN = SIGN_MAX_DIST + 2, NEAR_OUT = NEAR_IN + 8;
export const FAR_AT = 120, FAR_JITTER = 18, FAR_HYST = 5;
/** the cameras have to move this far (tiles) before tiers are looked at again */
const LOD_STEP = 0.75;

/**
 * Culling: buildings off screen are left out of the draw list. Each chunk's buildings are grouped into CELL × CELL
 * tile cells with a box around their bounding spheres; once a frame, when a camera or the sun has moved, every cell is
 * tested against the cameras' frustums and the cells whose state changed show or hide their instances. A cell's box is
 * stretched along the sun's shadow first, so a building just off screen still shadows the street on screen. Per-cell on
 * the CPU rather than three's per-instance culling, which walks every instance for every camera and the shadow pass
 * each frame; this costs nothing while the camera rests and a few hundred box tests while it moves.
 */
const CELL = 8;
/** longest shadow the cull allows for (tiles); a low sun's shadows are this long at most for culling */
const SHADOW_REACH = 48;

interface Cell {
  /** indices into the chunk's instance arrays */
  items: number[];
  box: Box3;
  shown: boolean;
}

interface ChunkLod {
  ids: number[];
  /** full and far geometry id per instance (far = full for helpers without a far model) */
  full: Int32Array; far: Int32Array;
  px: Float32Array; pz: Float32Array;
  /** this building's far threshold */
  thr: Float32Array;
  isFar: Uint8Array; nFar: number;
  x0: number; x1: number; z0: number; z1: number;
  near: boolean;
  signItems: { key: string; matrix: Matrix4; sign: SignInfo }[];
  cells: Cell[];
}

const tmpSphere = new Sphere();
const tmpBox = new Box3();
const tmpM = new Matrix4();
const tmpV = new Vector3();

/**
 * Every building in every loaded chunk lives in one BatchedMesh: one draw
 * call regardless of how many model variants are on screen. Chunks swap their
 * own instances in and out when they change. Each design is added twice, full and far (see the tiers above); an
 * instance switches between the two with setGeometryIdAt.
 */
export class Buildings {
  mesh: BatchedMesh;
  readonly signs = new Signs();
  /** posters on rented ad slots (render/adverts.ts): one instanced mesh for every loaded chunk */
  readonly adverts = new AdvertsView();
  /** the wind turbines' nacelles and rotors, turning (render/rotors.ts): the kit builds only their towers */
  readonly rotors = new RotorsView();
  /** the funfairs' Ferris wheels, turning (render/wheels.ts): the kit builds only their legs and axle */
  readonly wheels = new WheelsView();
  /** the leisure places' moving parts: karts round a track and the like (render/leisureAnims.ts, rigs in leisureRigs.ts) */
  readonly anims = new LeisureAnims();
  /** chimney smoke and the cranes' jibs over sites and yards (render/ambient.ts) */
  readonly ambient = new AmbientView();
  private geomIds = new Map<string, number>();
  private farIds = new Map<string, number>();
  private perChunk = new Map<string, ChunkLod>();
  private warned = false;
  private cams: Vector3[] = [];
  private lodDirty = false;
  /** buildings drawn with their far model right now, for the perf readout */
  farCount = 0;
  /** detail tiers on; off draws every building in full with no signs (for comparing, `msc.buildings.setLod(false)`) */
  private lod = true;
  /** off-screen culling on (`msc.buildings.setCull(false)` draws everything, for comparing) */
  private culling = true;
  private cullDirty = true;
  private frusta: Frustum[] = [];
  /** the cameras' view-projection matrices and the sun's direction the cells were last tested with */
  private cullKey: number[] = [];
  private sunDir = new Vector3(0, 1, 0);
  /** buildings left out of the draw list by the cull right now, for the perf readout */
  culledCount = 0;
  /** every built building by its door tile: its design key and matrix (the fires put their flames at its windows, render/fires.ts) */
  private byDoor = new Map<string, { key: string; matrix: Matrix4 }>();
  private doorsOf = new Map<string, string[]>();

  constructor(material: Material) {
    buildModels();
    const variants = allVariants();
    const far = buildFarModels();
    let verts = 0;
    for (const v of variants) verts += v.geometry.attributes.position.count;
    for (const g of far.values()) verts += g.attributes.position.count;
    this.mesh = new BatchedMesh(MAX_INSTANCES, verts, verts, material);
    for (const v of variants) this.geomIds.set(v.key, this.mesh.addGeometry(v.geometry));
    for (const [key, g] of far) if (this.geomIds.has(key)) this.farIds.set(key, this.mesh.addGeometry(g));
    this.mesh.perObjectFrustumCulled = false;
    this.mesh.sortObjects = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.add(this.signs.mesh);
    this.mesh.add(this.adverts.mesh);
    this.mesh.add(this.rotors.group);
    this.mesh.add(this.wheels.group);
    this.mesh.add(this.anims.group);
    this.mesh.add(this.ambient.group);
  }

  setChunk(key: string, items: Placement[]) {
    const wasNear = this.perChunk.get(key)?.near ?? false;
    this.clear(key);
    const ids: number[] = [], full: number[] = [], farG: number[] = [], px: number[] = [], pz: number[] = [], thr: number[] = [];
    const signItems: ChunkLod['signItems'] = [];
    const adItems: AdHostItem[] = [];
    const doors: string[] = [];
    for (const item of items) {
      if (item.ad && AD_SLOTS[item.key]) adItems.push({ key: item.key, matrix: item.matrix, door: [item.ad[0], item.ad[1]], parcel: item.ad[2] });
      const gid = this.geomIds.get(item.key);
      if (gid === undefined) continue;
      let id: number;
      try { id = this.mesh.addInstance(gid); }
      catch { if (!this.warned) { console.warn('building instance capacity reached'); this.warned = true; } break; }
      this.mesh.setMatrixAt(id, item.matrix);
      this.mesh.setColorAt(id, item.color);
      ids.push(id);
      full.push(gid);
      farG.push(this.farIds.get(item.key) ?? gid);
      const e = item.matrix.elements, x = e[12], z = e[14];
      px.push(x); pz.push(z);
      thr.push(FAR_AT + (hash2(Math.floor(x * 4) + 17, Math.floor(z * 4) + 5) - 0.5) * 2 * FAR_JITTER);
      if (item.sign) signItems.push({ key: item.key, matrix: item.matrix, sign: item.sign });
      if (item.sign && item.ad) { const dk = `${item.ad[0]},${item.ad[1]}`; this.byDoor.set(dk, { key: item.key, matrix: item.matrix }); doors.push(dk); }
    }
    if (doors.length) this.doorsOf.set(key, doors);
    if (ids.length) {
      const c: ChunkLod = {
        ids, full: Int32Array.from(full), far: Int32Array.from(farG), px: Float32Array.from(px), pz: Float32Array.from(pz), thr: Float32Array.from(thr),
        isFar: new Uint8Array(ids.length), nFar: 0,
        x0: Math.min(...px), x1: Math.max(...px), z0: Math.min(...pz), z1: Math.max(...pz),
        near: wasNear, signItems, cells: this.cellsOf(ids, full, px, pz),
      };
      this.perChunk.set(key, c);
      this.cullDirty = true;
      if (this.cams.length) this.lodChunk(key, c, true);
    }
    if (adItems.length) this.adverts.setChunk(key, adItems);
    this.rotors.setChunk(key, items);
    this.wheels.setChunk(key, items);
    this.anims.setChunk(key, items);
    this.ambient.setChunk(key, items);
    // With per-object culling and sorting off, three only rebuilds its multi-draw
    // list when this flag is set, and addInstance/deleteInstance do not set it.
    (this.mesh as unknown as { _visibilityChanged: boolean })._visibilityChanged = true;
  }

  /** The built building whose door is (x, y): its design key and world matrix; null while its chunk is not loaded or it is a site. */
  placementAt(x: number, y: number): { key: string; matrix: Matrix4 } | null { return this.byDoor.get(`${x},${y}`) ?? null; }

  /** buildings placed for a chunk (the rebuild accounting, render/chunkWork.ts) */
  countOf(key: string): number { return this.perChunk.get(key)?.ids.length ?? 0; }

  clear(key: string) {
    const c = this.perChunk.get(key);
    this.signs.clear(key);
    this.adverts.clear(key);
    this.rotors.clear(key);
    this.wheels.clear(key);
    this.anims.clear(key);
    this.ambient.clear(key);
    for (const dk of this.doorsOf.get(key) ?? []) this.byDoor.delete(dk);
    this.doorsOf.delete(key);
    if (!c) return;
    for (const id of c.ids) this.mesh.deleteInstance(id);
    this.farCount -= c.nFar;
    for (const cell of c.cells) if (!cell.shown) this.culledCount -= cell.items.length;
    this.perChunk.delete(key);
  }

  /** The chunk's buildings grouped into cells, each boxed around its buildings' (full model) bounding spheres. */
  private cellsOf(ids: number[], geo: number[], px: number[], pz: number[]): Cell[] {
    const byKey = new Map<number, Cell>();
    for (let i = 0; i < ids.length; i++) {
      const k = (Math.floor(px[i] / CELL) & 0xffff) * 65536 + (Math.floor(pz[i] / CELL) & 0xffff);
      let cell = byKey.get(k);
      if (!cell) byKey.set(k, cell = { items: [], box: new Box3(), shown: true });
      cell.items.push(i);
      this.mesh.getBoundingSphereAt(geo[i], tmpSphere);
      this.mesh.getMatrixAt(ids[i], tmpM);
      tmpSphere.applyMatrix4(tmpM);
      cell.box.union(tmpSphere.getBoundingBox(tmpBox));
    }
    return [...byKey.values()];
  }

  /**
   * The cull (see CELL): show the cells any camera can see, directly or through a shadow, and hide the rest. Skipped
   * when no camera, the sun or the chunks have changed since the last time.
   */
  private cull(cams: Camera[], sun?: DirectionalLight) {
    if (sun) tmpV.subVectors(sun.position, sun.target.position).normalize();
    else tmpV.set(0, 1, 0);
    const key: number[] = [];
    for (const cam of cams) {
      cam.updateMatrixWorld();
      tmpM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      for (const e of tmpM.elements) key.push(e);
    }
    let same = !this.cullDirty && key.length === this.cullKey.length && tmpV.distanceToSquared(this.sunDir) < 1e-6;
    for (let i = 0; same && i < key.length; i++) same = Math.abs(key[i] - this.cullKey[i]) < 1e-5;
    if (same) return;
    this.cullKey = key;
    this.sunDir.copy(tmpV);
    this.cullDirty = false;
    while (this.frusta.length < cams.length) this.frusta.push(new Frustum());
    for (let i = 0; i < cams.length; i++) this.frusta[i].setFromProjectionMatrix(tmpM.fromArray(key, i * 16));
    // the ground offset of a shadow per tile of height, away from the sun
    const up = Math.max(this.sunDir.y, 0.05);
    const sx = -this.sunDir.x / up, sz = -this.sunDir.z / up;
    let changed = false;
    for (const c of this.perChunk.values()) {
      for (const cell of c.cells) {
        let show = !this.culling;
        if (!show) {
          const b = cell.box, reach = Math.min(1, SHADOW_REACH / (Math.max(b.max.y, 0.01) * Math.hypot(sx, sz) + 1e-6));
          const ox = sx * b.max.y * reach, oz = sz * b.max.y * reach;
          tmpBox.min.set(Math.min(b.min.x, b.min.x + ox), Math.min(b.min.y, 0), Math.min(b.min.z, b.min.z + oz));
          tmpBox.max.set(Math.max(b.max.x, b.max.x + ox), b.max.y, Math.max(b.max.z, b.max.z + oz));
          for (let i = 0; !show && i < cams.length; i++) show = this.frusta[i].intersectsBox(tmpBox);
        }
        if (show === cell.shown) continue;
        cell.shown = show;
        for (const i of cell.items) this.mesh.setVisibleAt(c.ids[i], show);
        this.culledCount += show ? -cell.items.length : cell.items.length;
        changed = true;
      }
    }
    if (changed) (this.mesh as unknown as { _visibilityChanged: boolean })._visibilityChanged = true;
  }

  setCull(on: boolean) { this.culling = on; this.cullDirty = true; }
  /** far windows on or off (render/materials.ts), for comparing */
  setFarWindows(on: boolean) { sceneUniforms.uFarWin.value = on ? 1 : 0; }

  /** The name a building shows on its front (signs.ts), from its anchor tile: a business or house name, or a home's number. */
  nameAt(x: number, y: number): string | null {
    const c = this.perChunk.get(chunkKey(chunkOf(x), chunkOf(y)));
    const it = c?.signItems.find((s) => s.sign.x === x && s.sign.y === y);
    return it ? signLabel(it.sign) : null;
  }

  /**
   * Re-tier and cull for the cameras drawing this frame (the overhead camera, and the first-person one while it shows)
   * and the sun casting shadows. Cheap when nothing moved; call once a frame before rendering.
   */
  updateLod(cameras: Camera[], sun?: DirectionalLight) {
    this.cull(cameras, sun);
    const cams = cameras.map((c) => c.position);
    let moved = cams.length !== this.cams.length;
    for (let i = 0; !moved && i < cams.length; i++) moved = cams[i].distanceToSquared(this.cams[i]) > LOD_STEP * LOD_STEP;
    if (moved) {
      this.cams = cams.map((c) => c.clone());
      for (const [key, c] of this.perChunk) this.lodChunk(key, c, false);
    }
    if (this.lodDirty) {
      (this.mesh as unknown as { _visibilityChanged: boolean })._visibilityChanged = true;
      this.lodDirty = false;
    }
    this.signs.flush();
    this.adverts.flush();
  }

  setLod(on: boolean) { this.lod = on; this.cams = []; }

  private lodChunk(key: string, c: ChunkLod, fresh: boolean) {
    // nearest and farthest a building in this chunk can be from the nearest camera (all at infinity with tiers off)
    let lo = this.lod ? Infinity : -Infinity, hi = lo;
    for (const p of this.cams) {
      const dx = Math.max(c.x0 - p.x, 0, p.x - c.x1), dz = Math.max(c.z0 - p.z, 0, p.z - c.z1);
      const fx = Math.max(Math.abs(p.x - c.x0), Math.abs(p.x - c.x1)), fz = Math.max(Math.abs(p.z - c.z0), Math.abs(p.z - c.z1));
      const y2 = p.y * p.y;
      lo = Math.min(lo, Math.sqrt(dx * dx + dz * dz + y2));
      hi = Math.min(hi, Math.sqrt(fx * fx + fz * fz + y2));
    }
    // near: name boards
    if (!this.lod) c.near = false;
    else if (!c.near && lo < NEAR_IN) c.near = true;
    else if (c.near && lo > NEAR_OUT) c.near = false;
    if (c.near && (fresh || !this.signs.has(key))) this.signs.setChunk(key, c.signItems);
    else if (!c.near && this.signs.has(key)) this.signs.clear(key);
    // far: per building, unless the whole chunk is clear of the band and already there
    const n = c.ids.length;
    if (lo > FAR_AT + FAR_JITTER + FAR_HYST && c.nFar === n) return;
    if (hi < FAR_AT - FAR_JITTER - FAR_HYST && c.nFar === 0) return;
    for (let i = 0; i < n; i++) {
      let d = Infinity;
      for (const p of this.cams) {
        const dx = c.px[i] - p.x, dz = c.pz[i] - p.z;
        d = Math.min(d, dx * dx + dz * dz + p.y * p.y);
      }
      d = Math.sqrt(d);
      const t = c.thr[i], h = fresh ? 0 : FAR_HYST;
      const want = this.lod && (c.isFar[i] ? d > t - h : d > t + h);
      if (want === !!c.isFar[i]) continue;
      c.isFar[i] = want ? 1 : 0;
      c.nFar += want ? 1 : -1;
      this.farCount += want ? 1 : -1;
      this.mesh.setGeometryIdAt(c.ids[i], want ? c.far[i] : c.full[i]);
      this.lodDirty = true;
    }
  }
}
