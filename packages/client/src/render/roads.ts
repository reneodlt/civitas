import {
  BufferGeometry, BufferAttribute, Uint32BufferAttribute, Mesh, Group, InstancedMesh, InstancedBufferAttribute, Matrix4, Quaternion, Vector3,
  Color, MeshLambertMaterial, IcosahedronGeometry, SphereGeometry, DynamicDrawUsage, type Material, type Camera, type Texture,
} from 'three';
import {
  CHUNK_SIZE, Terrain, hash2, isRoad, terrainOf, signalArms, armCount, signalledArms, isMarkedJunction, mouthControl, mouthCrossing,
  boxJunction, leafySide, streetTreeAt, midZebraAt, MouthCrossing, MouthControl, isRingAux, ringPos, isArmPos, RING_POS, isFlyoverAux, deckEW,
  isBridgeAux, bridgeNS, bridgeStyle, BridgeStyle, isRailAux, railMask, streetRun, streetLine, MOTORWAY_KIND,
  auxClass, oneWayDir, isDividedAux, isMotorwayAux, auxJunction, RoadCls,
  isMiniAux, isRingClassAux, isDeckClassAux, isClassAux, isPedestrianAux, bigRingAt, implicitPelican, junctionGroup, slipJunction, linkedDegree, roadsLinked,
  carStepOk, inGroup, turnAllowed, TRAFFIC_TUNING, StreetRule, humpAt, type RoadRule, type JunctionGroup,
} from '@msimcity/shared';
import type { ClientChunk } from '../world';
import { Geo, buildTile, buildRing, buildBigRing, surfaceY, ringSurfaceY, bigRingSurfaceY, STREET, SIDE, CLASS_PROFILES, type RoadTile, type RoadProfile, type ClassInfo, type BigRingTile } from './roadGeo';
import { junctionLights } from './signals';
import { lampTexture, OVL_SIZE, groundMaterial, lanternMaterial, sceneUniforms } from './materials';
import { Kit } from './kit';
import { leafMaterial, leafDepthMaterial } from './seasons';

/**
 * The streets near the camera as geometry (render/roadGeo.ts) and their furniture: lamp columns of three designs
 * with lanterns that light their own pools on the road, street trees in the verges, bollards at corners, litter bins,
 * Belisha beacons at zebras and the posts that will carry street name plates. Further off a road is its atlas cell on
 * the ground mesh (atlas.ts draws those to the same plan), so the far view costs what it always did.
 *
 * Detail tiers by distance from the camera (3D, tiles): a chunk within NEAR_IN of a camera gets its road mesh (one
 * draw call, the ground's material) and its furniture; past NEAR_OUT it drops back to the flat cells. Each road tile's
 * look is worked out from the tiles round it into a description (roadGeo RoadTile) and built once; a rebuild of the
 * chunk (any tile in it changed) reuses every tile whose description is unchanged, so a growing town does not
 * rebuild its streets. Furniture is instanced across all near chunks (a dozen draw calls in all) and refilled only
 * when a chunk's furniture or the near set changes.
 *
 * Street lamps are placed for every loaded chunk, near or not: their positions and habits go into lampTexture, from
 * which the ground and road shaders pool the light and the lanterns glow, each lamp coming on at its own darkness,
 * a few dead or sputtering, sodium-warm or LED-white by street (the organic rule).
 *
 * Nothing here touches the simulation: the road bit, the routing graph and the lanes cars drive are as they were.
 */
export const NEAR_IN = 74, NEAR_OUT = 84;
/** the time a frame may spend building road tiles (ms), and the road tiles it builds whatever the time; a chunk's build
 *  carries on over as many frames as it needs */
const BUILD_MS = 6, BUILD_MIN = 16;
const N = CHUNK_SIZE * CHUNK_SIZE;
const UP = new Vector3(0, 1, 0);

/** what a tile's road needs from the world */
export interface RoadCtx {
  tile: (x: number, y: number) => number | undefined;
  aux: (x: number, y: number) => number;
  /** the junction's owner has the Traffic signals technology */
  signalled: (x: number, y: number) => boolean;
}

/** a profile drawn on every street instead, from the console (RoadLayer.preview), for trying out cross-sections */
let previewProfile: RoadProfile | null = null;
/** The cross-section of a road tile: its class's (shared/src/roadclass.ts, the aux byte), a street's otherwise. */
export const profileOf = (_tile: number, aux: number): RoadProfile => { const cls = auxClass(aux); return cls ? CLASS_PROFILES[cls] : previewProfile ?? STREET; };
/** DIRS order (E, W, S, N) to a side (N 0, E 1, S 2, W 3) */
const DIR_SIDE = [1, 3, 2, 0];

// ---- furniture ------------------------------------------------------------------------------------------------------

const F = { Post0: 0, Post1: 1, Post2: 2, Lens0: 3, Lens1: 4, Lens2: 5, Trunk: 6, Crown: 7, Column: 8, Bollard: 9, Bin: 10, Sign: 11, Beacon: 12, Globe: 13, Bench: 14 } as const;
const F_COUNT = 15;
interface Furn { f: number; m: Matrix4; c: Color; lamp?: [number, number, number, number]; street?: string }

/** A name plate's post (R2 draws the street's name on it): the plate's centre, its yaw (it faces along +z turned by yaw) and the street tile it names. */
/**
 * A name plate's post (R2's street names, shared/src/streets.ts, go on it; drawn blank until then): the plate's centre,
 * its yaw (it faces along +z turned by yaw) and the street it names, as streetLine(streetRun(...)) keys it.
 */
export interface NamePlate { x: number; y: number; z: number; yaw: number; street: string }

const LAMP_H = [0.5, 0.56, 0.38], LAMP_REACH = [0.13, 0.15, 0];
function postGeometry(design: number) {
  const k = new Kit();
  const h = LAMP_H[design], reach = LAMP_REACH[design];
  if (design === 0) {
    // a modern column: a slim grey shaft, a level arm and a flat LED head
    k.cyl(0.0065, 0.009, h, 0, 0, 0, 0x8d939a, 6);
    k.box(reach + 0.01, 0.008, 0.008, reach / 2, h - 0.008, 0, 0x8d939a);
    k.box(0.07, 0.012, 0.032, reach, h - 0.016, 0, 0x6b7077);
  } else if (design === 1) {
    // an older column with a swan-neck bracket and a cobra head over the road
    k.cyl(0.006, 0.011, h, 0, 0, 0, 0x9aa0a4, 6);
    k.box(0.01, 0.01, 0.01, 0.01, h - 0.01, 0, 0x9aa0a4);
    k.box(reach - 0.02, 0.008, 0.008, reach / 2, h + 0.004, 0, 0x9aa0a4);
    k.taper(0.075, 0.034, 0.05, 0.02, 0.022, reach + 0.01, h - 0.012, 0, 0xb4b9bd);
  } else {
    // a heritage lamp: a black fluted column on a plinth, the lantern on top
    k.cyl(0.016, 0.019, 0.04, 0, 0, 0, 0x1d2024, 8);
    k.cyl(0.0065, 0.01, h - 0.08, 0, 0.04, 0, 0x1d2024, 8);
    k.cyl(0.012, 0.007, 0.012, 0, h - 0.04, 0, 0x1d2024, 8);
    k.cone(0.03, 0.022, 0, h, 0, 0x1d2024, 6);
  }
  return k.build();
}
function lensGeometry(design: number) {
  const k = new Kit();
  const h = LAMP_H[design], reach = LAMP_REACH[design];
  if (design === 0) k.box(0.055, 0.003, 0.024, reach, h - 0.019, 0, 0xffffff);
  else if (design === 1) k.box(0.05, 0.004, 0.022, reach + 0.012, h - 0.016, 0, 0xffffff);
  else k.taper(0.026, 0.026, 0.034, 0.034, 0.03, 0, h - 0.03, 0, 0xffffff);
  return k.build();
}
function treeGeometries() {
  // canopies are white: the instance colour is the species' leaf
  const trunk = new Kit().cyl(0.009, 0.014, 0.16, 0, 0, 0, 0x6b4a2b, 5).build();
  const crown = new Kit();
  crown.part(new IcosahedronGeometry(0.085, 0).translate(0, 0.2, 0), 0xffffff);
  crown.part(new IcosahedronGeometry(0.06, 0).translate(0.035, 0.26, -0.02), 0xf2f2f2);
  crown.part(new IcosahedronGeometry(0.05, 0).translate(-0.04, 0.17, 0.03), 0xe8e8e8);
  const column = new Kit();
  column.part(new SphereGeometry(0.05, 6, 5).scale(1, 2.6, 1).translate(0, 0.25, 0), 0xffffff);
  return { trunk, crown: crown.build(), column: column.build() };
}
function smallGeometries() {
  const bollard = new Kit().cyl(0.0075, 0.0085, 0.045, 0, 0, 0, 0x1b1d20, 6).box(0.017, 0.006, 0.017, 0, 0.034, 0, 0xe8e8e2).build();
  const bin = new Kit().cyl(0.014, 0.012, 0.036, 0, 0, 0, 0xffffff, 8).cyl(0.016, 0.016, 0.006, 0, 0.036, 0, 0xffffff, 8).build();
  const sign = new Kit();
  for (const x of [-0.03, 0.03]) sign.box(0.005, 0.07, 0.005, x, 0, 0, 0x2b2e33);
  sign.box(0.084, 0.03, 0.004, 0, 0.05, 0, 0x1c1e22).box(0.078, 0.024, 0.005, 0, 0.053, 0.0005, 0xf4f4f0);
  const beacon = new Kit();
  for (let i = 0; i < 6; i++) beacon.cyl(0.0055, 0.0055, 0.03, 0, i * 0.03, 0, i % 2 ? 0xf2f2ee : 0x1b1d20, 6);
  const globe = new Kit().part(new SphereGeometry(0.017, 10, 8).translate(0, 0.195, 0), 0xffffff).build();
  // a bench (pedestrian streets): seat and back in the instance colour, facing +z, on two dark legs
  const bench = new Kit().box(0.086, 0.005, 0.028, 0, 0.019, 0.002, 0xffffff).box(0.086, 0.022, 0.005, 0, 0.024, -0.013, 0xffffff)
    .box(0.005, 0.019, 0.026, -0.036, 0, 0, 0x4a4d52).box(0.005, 0.019, 0.026, 0.036, 0, 0, 0x4a4d52).build();
  return { bollard, bin: bin, sign: sign.build(), beacon: beacon.build(), globe, bench };
}

/** Belisha globes: amber, flashing about once a second, each crossing at its own rate and phase (aLamp.x). */
function beaconMaterial() {
  const m = new MeshLambertMaterial({ vertexColors: true, color: 0xffa31a });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sceneUniforms.uTime; shader.uniforms.uNight = sceneUniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aLamp;\nvarying vec4 vLamp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLamp = aLamp;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uNight;\nvarying vec4 vLamp;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  float ph = fract(uTime * (0.85 + 0.2 * vLamp.x) + vLamp.y);
  totalEmissiveRadiance += vec3(1.0, 0.55, 0.08) * step(ph, 0.5) * (0.9 + 1.4 * uNight);`);
  };
  m.customProgramCacheKey = () => 'msc-belisha';
  return m;
}

/** Leaf colours of street trees: plane and lime greens, a copper beech now and then, cherries in blossom. */
const LEAF = [0x6aa84f, 0x5e9a46, 0x78b45a, 0x6f9e3f, 0x8a4a3c, 0xf0b4c4, 0xf4dde4].map((c) => new Color(c));

// ---- per chunk ------------------------------------------------------------------------------------------------------

interface TileCache {
  sig: string;
  t: RoadTile | null;
  ring: { pos: number; arm: boolean } | null;
  big?: BigRingTile | null;
  p: Float32Array; n: Float32Array; c: Float32Array; uv: Float32Array; idx: Uint32Array;
  furn: Furn[];
  /** the road tile's aRoad value (16 + its N E S W road bits) */
  road: number;
}
interface Entry {
  key: string; cx: number; cy: number;
  chunk: ClientChunk;
  dirty: boolean; near: boolean;
  mesh: Mesh | null;
  /** built since it came near (a chunk with no road tiles has no mesh, and must not be built again every frame for it) */
  built: boolean;
  tiles: Map<number, TileCache>;
  /** per tile in the mesh: local index, first vertex, vertex count (heat updates) */
  ranges: number[];
  heat: Uint8Array | undefined;
  /** smoothed congestion per tile, and the wear level it gave at the last build */
  wear: Float32Array; wearAt: Uint8Array; wearSeen: boolean; wearBuilt: number;
  /** junction tiles and whether they were signalled at the last build (local index, 0/1 pairs) */
  junctions: number[];
  furn: Furn[];
  /** a build under way (time-sliced over frames): the next tile, the tiles so far, what it has seen */
  job: { i: number; keep: Map<number, TileCache>; junctions: number[]; described: number; fresh: number; ms: number } | null;
}
const ckey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

export class RoadLayer {
  /** the road meshes (the ground's shader fades them in the underground view) */
  group = new Group();
  /** street furniture: ghosted with the rest of the surface in the underground view */
  furniture = new Group();
  readonly material: Material;
  private entries = new Map<number, Entry>();
  private byKey = new Map<string, Entry>();
  private ctx: RoadCtx | null = null;
  /** the catalogue kind standing on a tile (main.ts: world.kindIdAt), for a road that runs on into a motorway connection's apron */
  kindAt: (x: number, y: number) => number = () => 0;
  /** the road rule records (main.ts: the client world): signal crossings placed with the tool are painted (R4) */
  rules: { ruleAt(x: number, y: number): RoadRule | undefined; rulesVersion: number } | null = null;
  private rulesSeen = -1;
  private furnDirty = false;
  private lampDirty = false;
  private lampData = lampTexture.image.data as Uint8Array;
  private meshes: InstancedMesh[] = [];
  private plates: NamePlate[] = [];
  private tmpV = new Vector3();

  constructor(atlas: Texture) {
    this.material = groundMaterial(atlas, true);
    this.group.name = 'roads'; this.furniture.name = 'street furniture';
    const furnMat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const lens = lanternMaterial(), beacon = beaconMaterial();
    const tree = treeGeometries(), small = smallGeometries();
    const CROWN_LEAF = { mat: leafMaterial({ crownY: 0.2, above: -1 }), depth: leafDepthMaterial({ crownY: 0.2, above: -1 }) };
    const COLUMN_LEAF = { mat: leafMaterial({ crownY: 0.25, above: -1 }), depth: leafDepthMaterial({ crownY: 0.25, above: -1 }) };
    const geos = [postGeometry(0), postGeometry(1), postGeometry(2), lensGeometry(0), lensGeometry(1), lensGeometry(2),
      tree.trunk, tree.crown, tree.column, small.bollard, small.bin, small.sign, small.beacon, small.globe, small.bench];
    const caps = [6000, 6000, 6000, 6000, 6000, 6000, 12000, 12000, 12000, 6000, 3000, 3000, 2000, 2000, 2000];
    this.meshes = geos.map((g, i) => {
      const lamp = i >= F.Lens0 && i <= F.Lens2, glob = i === F.Globe;
      if (lamp || glob) g.setAttribute('aLamp', new InstancedBufferAttribute(new Float32Array(caps[i] * 4), 4).setUsage(DynamicDrawUsage));
      // crowns and columns go through the year (render/seasons.ts); the trunk below keeps the plain material
      const leaf = i === F.Crown ? CROWN_LEAF : i === F.Column ? COLUMN_LEAF : null;
      const m = new InstancedMesh(g, leaf ? leaf.mat : lamp ? lens : glob ? beacon : furnMat, caps[i]);
      if (leaf?.depth) m.customDepthMaterial = leaf.depth;
      m.count = 0; m.frustumCulled = false;
      m.castShadow = i <= F.Post2 || i === F.Trunk || i === F.Crown || i === F.Column || i === F.Beacon || i === F.Bench;
      m.receiveShadow = i === F.Crown || i === F.Column;
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      this.furniture.add(m);
      return m;
    });
  }

  // ---- the chunk lifecycle (main.ts calls these beside the other per-chunk renderers) ---------------------------------

  /** A chunk's tiles or aux bytes changed (or it arrived): place its lamps now, rebuild its streets when near. */
  scanChunk(key: string, chunk: ClientChunk, getTile: (x: number, y: number) => number | undefined, auxAt: (x: number, y: number) => number) {
    if (!this.ctx) this.ctx = { tile: getTile, aux: auxAt, signalled: () => false };
    else { this.ctx.tile = getTile; this.ctx.aux = auxAt; }
    let e = this.byKey.get(key);
    if (!e) {
      e = { key, cx: chunk.cx, cy: chunk.cy, chunk, dirty: true, near: false, mesh: null, built: false, tiles: new Map(), ranges: [], heat: undefined,
        wear: new Float32Array(N), wearAt: new Uint8Array(N), wearSeen: false, wearBuilt: 0, junctions: [], furn: [], job: null };
      this.byKey.set(key, e); this.entries.set(ckey(chunk.cx, chunk.cy), e);
    }
    e.chunk = chunk; e.dirty = true; // a build under way finishes, and another follows
    this.placeLamps(e);
  }

  dropChunk(key: string) {
    const e = this.byKey.get(key);
    if (!e) return;
    this.dropMesh(e);
    this.clearLamps(e);
    if (e.near && e.furn.length) this.furnDirty = true;
    this.byKey.delete(key); this.entries.delete(ckey(e.cx, e.cy));
  }

  /** The congestion bytes for a chunk changed (ChunkView.tintRoads): the heat overlay's attribute, and the wear they leave. */
  setHeat(cx: number, cy: number, heat: Uint8Array | undefined, wear = true) {
    const e = this.entries.get(ckey(cx, cy));
    if (!e) return;
    e.heat = heat;
    this.tint(e);
    if (!heat || !wear) return; // another overlay's bytes (power, road classes) are no traffic: they leave no wear
    // wear follows traffic slowly: a smoothed congestion per tile, and a rebuild (cached tiles mostly) when a level changes
    let changed = false;
    for (let i = 0; i < N; i++) {
      const h = heat[i] / 255;
      e.wear[i] = e.wearSeen ? e.wear[i] * 0.9 + h * 0.1 : h;
      if (wearLevel(e.wear[i]) !== e.wearAt[i]) changed = true;
    }
    e.wearSeen = true;
    if (changed && performance.now() - e.wearBuilt > 60000) e.dirty = true;
  }

  /** Ownership, technology or road rules changed: junctions whose lights came or went are re-marked, signal crossings repainted. */
  invalidate() {
    if (this.rules && this.rules.rulesVersion !== this.rulesSeen) {
      // a rule changed somewhere: every near chunk looks again (each tile whose look is unchanged is reused as it is)
      this.rulesSeen = this.rules.rulesVersion;
      for (const e of this.entries.values()) e.dirty = true;
      return;
    }
    for (const e of this.entries.values()) {
      if (!e.junctions.length || !this.ctx) continue;
      const x0 = e.cx * CHUNK_SIZE, z0 = e.cy * CHUNK_SIZE;
      for (let i = 0; i < e.junctions.length; i += 2) {
        const li = e.junctions[i], x = x0 + (li % CHUNK_SIZE), z = z0 + Math.floor(li / CHUNK_SIZE);
        if ((this.isSignalled(x, z) ? 1 : 0) !== e.junctions[i + 1]) { e.dirty = true; break; }
      }
    }
  }

  /** Tiers for the cameras drawing this frame, chunk builds within the budget, the furniture and the lamp map. */
  frame(cams: readonly Camera[], signalled: (x: number, y: number) => boolean) {
    if (this.ctx) this.ctx.signalled = signalled;
    const deadline = performance.now() + BUILD_MS;
    const todo: [number, Entry][] = [];
    for (const e of this.entries.values()) {
      const d = this.distance(e, cams);
      const near = e.near ? d < NEAR_OUT : d < NEAR_IN;
      if (near !== e.near) {
        e.near = near;
        if (e.mesh) e.mesh.visible = near;
        if (e.furn.length) this.furnDirty = true;
        if (!near) { this.dropMesh(e); e.tiles = new Map(); e.ranges = []; e.job = null; e.built = false; } // far: the flat cells; free the cached tiles too
      }
      if (near && (e.dirty || e.job || !e.built)) todo.push([d, e]);
    }
    todo.sort((a, b) => a[0] - b[0]);
    for (const [, e] of todo) if (!this.build(e, deadline)) break;
    if (this.furnDirty) this.fillFurniture();
    if (this.lampDirty) { lampTexture.needsUpdate = true; this.lampDirty = false; }
  }

  /** Height of the surface a walker stands on at (x, z): a pavement's near the camera, else the ground's (0). */
  /** R5: speed humps of 20 zones on the near streets (tile key: the street runs north-south), kept as tiles are described */
  private humps = new Map<string, boolean>();
  /**
   * How far a car (or anyone) at (x, z) is lifted by a speed hump under it (R5): a low rounded bump across the
   * carriageway where roadGeo paints it, so cars dip over each hump as they cross. 0 off a hump.
   */
  humpY(x: number, z: number): number {
    if (!this.humps.size) return 0;
    const tx = Math.floor(x), tz = Math.floor(z), ns = this.humps.get(`${tx},${tz}`);
    if (ns === undefined) return 0;
    const at = (hash2(tx * 31 + 151 * 7, tz * 17 - 151 * 13) - 0.5) * 0.12; // roadGeo humpPaint's band, hk(t, 151)
    const d = (ns ? z - tz : x - tx) - 0.5 - at, u = d / 0.085;
    return Math.abs(u) < 1 ? 0.012 * (1 - u * u) : 0;
  }
  walkY(x: number, z: number): number {
    const tx = Math.floor(x), tz = Math.floor(z);
    const e = this.entries.get(ckey(Math.floor(tx / CHUNK_SIZE), Math.floor(tz / CHUNK_SIZE)));
    if (!e || !e.mesh || !e.near) return 0;
    const lx = tx - e.cx * CHUNK_SIZE, lz = tz - e.cy * CHUNK_SIZE;
    const tc = e.tiles.get(lz * CHUNK_SIZE + lx);
    if (!tc) return 0;
    if (tc.t) return surfaceY(tc.t, x, z);
    if (tc.ring) return ringSurfaceY(tx, tz, tc.ring.pos, tc.ring.arm, STREET, x, z);
    if (tc.big) return bigRingSurfaceY(tx, tz, tc.big, x, z);
    return 0;
  }

  /**
   * Draw every street with another cross-section, or back to its own with null: `msc.roads.preview({ carriage: 0.42,
   * kerb: 0.014, lanes: 2, median: 0.06, oneWay: false })`. Drawing only (the lanes cars drive do not move): for R3.
   */
  preview(p: RoadProfile | null) {
    previewProfile = p;
    for (const e of this.entries.values()) e.dirty = true;
  }

  /** Is any near chunk still building? (tests and screenshots wait for it) */
  busy(): boolean { for (const e of this.entries.values()) if (e.near && (e.dirty || e.job)) return true; return false; }

  /** Name plate posts near the camera (the hook for R2's street names). */
  namePlates(): readonly NamePlate[] { return this.plates; }

  // ---- building -----------------------------------------------------------------------------------------------------

  private distance(e: Entry, cams: readonly Camera[]): number {
    let best = Infinity;
    const x0 = e.cx * CHUNK_SIZE, z0 = e.cy * CHUNK_SIZE;
    for (const cam of cams) {
      const p = cam.getWorldPosition(this.tmpV);
      const dx = Math.max(x0 - p.x, 0, p.x - (x0 + CHUNK_SIZE)), dz = Math.max(z0 - p.z, 0, p.z - (z0 + CHUNK_SIZE));
      best = Math.min(best, Math.hypot(dx, p.y, dz));
    }
    return best;
  }

  /** Has junction tile (x, z) lights? As the lights are drawn (render/signals.ts junctionLights): a junction group as one, from its anchor. */
  private isSignalled(x: number, z: number): boolean {
    const c = this.ctx!;
    const j = junctionLights(this.roadKnown, c.aux, x, z);
    return !!j && j.lit && c.signalled(j.g.x, j.g.y);
  }
  /** road for the rules (unloaded tiles are not road), as the lights and the server see it */
  private roadKnown = (x: number, z: number) => { const t = this.ctx!.tile(x, z); return t !== undefined && isRoad(t); };
  /** a tile's class byte for drawing: a motorway under a deck (class 7) is drawn as the motorway it is */
  private cAux = (x: number, z: number) => drawAux(this.ctx!.aux(x, z));
  /** road for shapes: an unloaded neighbour is taken as road (the street carries on), as the ground cells do */
  private roadFn = (x: number, z: number) => { const t = this.ctx!.tile(x, z); return t === undefined ? true : isRoad(t); };

  private dropMesh(e: Entry) {
    if (!e.mesh) return;
    this.group.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh = null;
  }

  /** the last chunk builds: time (ms), tiles described, tiles built afresh (the rest reused) */
  private builds: { ms: number; tiles: number; fresh: number }[] = [];
  private nBuilds = 0;
  /** street meshes finished since the page opened (the rebuild accounting, render/chunkWork.ts) */
  buildCount() { return this.nBuilds; }

  /**
   * Carry a chunk's build on until `deadline` (performance.now ms): its tiles a few at a time, then the mesh. True when
   * the chunk is done (its new mesh replaces the old, which shows until then); false when the time ran out.
   */
  private build(e: Entry, deadline: number): boolean {
    const t0 = performance.now();
    if (!e.job) { e.job = { i: 0, keep: new Map(), junctions: [], described: 0, fresh: 0, ms: 0 }; e.dirty = false; e.wearBuilt = t0; }
    const job = e.job;
    const x0 = e.cx * CHUNK_SIZE, z0 = e.cy * CHUNK_SIZE;
    const keep = job.keep, junctions = job.junctions;
    let done = 0;
    for (let i = job.i; i < N; i++) {
      const t = e.chunk.tiles[i];
      if (!isRoad(t)) continue;
      if (done++ >= BUILD_MIN && performance.now() > deadline) { job.i = i; job.ms += performance.now() - t0; return false; }
      const x = x0 + (i % CHUNK_SIZE), z = z0 + Math.floor(i / CHUNK_SIZE);
      e.wearAt[i] = wearLevel(e.wear[i]);
      const d = this.describe(x, z, t, e.chunk.aux[i], e.wearAt[i]);
      if (!d) continue;
      job.described++;
      if (d.t?.junction) junctions.push(i, d.t.cross.some((k) => k === MouthCrossing.Signal) ? 1 : 0);
      const old = e.tiles.get(i);
      if (old && old.sig === d.sig) { keep.set(i, old); continue; }
      job.fresh++;
      const g = new Geo();
      if (d.t) buildTile(d.t, g); else if (d.ring) buildRing(x, z, d.ring.pos, d.ring.arm, STREET, g); else if (d.big) buildBigRing(x, z, d.big, g, e.wearAt[i]);
      keep.set(i, {
        sig: d.sig, t: d.t, ring: d.ring, big: d.big, road: 16 + (d.t ? d.t.m8 & 15 : 15),
        p: new Float32Array(g.p), n: new Float32Array(g.n), c: new Float32Array(g.c), uv: new Float32Array(g.uv), idx: new Uint32Array(g.idx),
        furn: d.t ? this.furnish(d.t) : d.ring || d.big ? this.furnishRing(x, z) : [],
      });
    }
    e.job = null;
    e.tiles = keep; e.junctions = junctions;
    // one mesh for the chunk
    let nv = 0, ni = 0;
    for (const tc of keep.values()) { nv += tc.p.length / 3; ni += tc.idx.length; }
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), colr = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const road = new Float32Array(nv), heat = new Float32Array(nv), idx = new Uint32Array(ni);
    let v = 0, k = 0;
    e.ranges = [];
    const furn: Furn[] = [];
    for (const [li, tc] of keep) {
      const n = tc.p.length / 3;
      pos.set(tc.p, v * 3); nrm.set(tc.n, v * 3); colr.set(tc.c, v * 3); uv.set(tc.uv, v * 2);
      road.fill(tc.road, v, v + n);
      for (let j = 0; j < tc.idx.length; j++) idx[k + j] = tc.idx[j] + v;
      e.ranges.push(li, v, n);
      v += n; k += tc.idx.length;
      for (const f of tc.furn) furn.push(f);
    }
    this.dropMesh(e);
    if (ni) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(pos, 3));
      geo.setAttribute('normal', new BufferAttribute(nrm, 3));
      geo.setAttribute('color', new BufferAttribute(colr, 3));
      geo.setAttribute('uv', new BufferAttribute(uv, 2));
      geo.setAttribute('aRoad', new BufferAttribute(road, 1));
      geo.setAttribute('aHeat', new BufferAttribute(heat, 1));
      geo.setIndex(new Uint32BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mesh = new Mesh(geo, this.material);
      mesh.matrixAutoUpdate = false; mesh.receiveShadow = true;
      mesh.visible = e.near;
      e.mesh = mesh;
      this.group.add(mesh);
      this.tint(e);
    }
    if (furn.length || e.furn.length) this.furnDirty = true; // (a chunk with no streets has none, before or after)
    e.furn = furn;
    e.built = true;
    this.nBuilds++;
    if (job.described) this.builds.push({ ms: job.ms + performance.now() - t0, tiles: job.described, fresh: job.fresh });
    if (this.builds.length > 64) this.builds.shift();
    return true;
  }

  private tint(e: Entry) {
    if (!e.mesh) return;
    const a = e.mesh.geometry.attributes.aHeat as BufferAttribute, arr = a.array as Float32Array;
    for (let i = 0; i < e.ranges.length; i += 3) arr.fill(e.heat ? e.heat[e.ranges[i]] / 255 : 0, e.ranges[i + 1], e.ranges[i + 1] + e.ranges[i + 2]);
    a.needsUpdate = true;
  }

  /** Everything a road tile's look depends on, and a signature of it; null for tiles drawn by others (decks, ramps). */
  private describe(x: number, z: number, tw: number, a0: number, wear: number): { sig: string; t: RoadTile | null; ring: { pos: number; arm: boolean } | null; big?: BigRingTile | null } | null {
    const ctx = this.ctx!, road = this.roadFn;
    if (terrainOf(tw) === Terrain.Water) return null; // a bridge deck: render/bridges.ts
    if (isRingAux(a0)) {
      const p = ringPos(a0), arm = isArmPos(p) && road(x + RING_POS[p][0], z + RING_POS[p][1]);
      return { sig: `R${p}${arm ? 1 : 0}`, t: null, ring: { pos: p, arm } };
    }
    if (isRingClassAux(a0)) {
      // a 5×5 roundabout's ring (R4); one whose island has gone is drawn as the one-way street it drives as
      const b = this.bigRing(x, z, a0);
      if (b) return { sig: `B${b.turn}${b.corner ? 1 : 0}${b.arm},${b.armC},${wear}`, t: null, ring: null, big: b };
    }
    if (this.isRamp(x, z, a0)) return null; // under a flyover's or a bridge's ramp, or an interchange's (render/junctions.ts)
    const a = isRingClassAux(a0) ? (a0 & ~7) | RoadCls.OneWay : drawAux(a0);
    const under = isFlyoverAux(a);
    let m8 = 0;
    const DIAG: [number, number][] = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
    // a motorway connection's apron carries the carriageway on: no kerb across the end of the road into it
    for (let s = 0; s < 4; s++) if (road(x + SIDE[s][0], z + SIDE[s][1]) || this.kindAt(x + SIDE[s][0], z + SIDE[s][1]) === MOTORWAY_KIND) m8 |= 1 << s;
    for (let s = 0; s < 4; s++) if (road(x + DIAG[s][0], z + DIAG[s][1])) m8 |= 16 << s;
    if (under) m8 &= deckEW(a) ? ~(2 | 8 | 0xf0) : ~(1 | 4 | 0xf0); // the deck's ramps are not this road's sides
    const arms = under ? (deckEW(a) ? 5 : 10) & m8 : signalArms(road, x, z);
    const mini = isMiniAux(a);
    const junction = !under && (mini || isMarkedJunction(road, a, x, z));
    const sig0 = junction && !mini && this.isSignalled(x, z);
    // where an interchange's slips meet its street (R4): the slips give way, the street runs on
    const slipX = junction && slipJunction(ctx.aux, x, z) ? (isDeckClassAux(ctx.aux(x + 2, z)) || isDeckClassAux(ctx.aux(x - 2, z)) ? 1 : 2) : 0;
    const cross = [0, 0, 0, 0], ctrl = [0, 0, 0, 0], nCross = [0, 0, 0, 0], nCtrl = [0, 0, 0, 0], nArms = [0, 0, 0, 0];
    let nTurns: number[] | undefined;
    let leafy = 0;
    for (let s = 0; s < 4; s++) {
      const bit = 1 << s, nx = x + SIDE[s][0], nz = z + SIDE[s][1];
      if (junction && arms & bit && !isRingAux(ctx.aux(nx, nz))) {
        cross[s] = mouthCrossing(x, z, bit, sig0);
        ctrl[s] = mini ? MouthControl.GiveWay : slipX ? slipCtrl(slipX, s) : mouthControl(road, x, z, bit, sig0);
      }
      // the junction next door, when this tile is one of its arms (not its twin lane)
      if (arms & bit && !junction && !under) {
        const na = ctx.aux(nx, nz), nt = ctx.tile(nx, nz), back = 1 << ((s + 2) & 3);
        if (nt === undefined || !isRoad(nt)) { /* nothing */ }
        else if (isMiniAux(na)) {
          // a mini-roundabout: every arm gives way
          nArms[s] = signalArms(road, nx, nz) | back; nCtrl[s] = MouthControl.GiveWay; nCross[s] = mouthCrossing(nx, nz, back, false);
        } else if (isRingClassAux(na) && !isRingClassAux(a0)) {
          // a road coming onto a 5×5 roundabout's ring gives way at its edge
          nArms[s] = back; nCtrl[s] = MouthControl.GiveWay;
        } else if (isMarkedJunction(road, na, nx, nz)) {
          const nArm = signalArms(road, nx, nz);
          if (nArm & back) {
            const ns = this.isSignalled(nx, nz), nSlip = slipJunction(ctx.aux, nx, nz) ? (isDeckClassAux(ctx.aux(nx + 2, nz)) || isDeckClassAux(ctx.aux(nx - 2, nz)) ? 1 : 2) : 0;
            nCross[s] = mouthCrossing(nx, nz, back, ns); nCtrl[s] = nSlip ? slipCtrl(nSlip, (s + 2) & 3) : mouthControl(road, nx, nz, back, ns); nArms[s] = nArm;
            // the arrows: where a car going in may leave the junction (its group's ways out, no U-turn, no banned turn)
            const j = this.junctionAt(nx, nz);
            if (j) { const tm = sidesOf(this.turnsFrom(j.g, SIDE_DIR[s])); if ((tm | back) !== (nArm | back)) (nTurns ??= [-1, -1, -1, -1])[s] = tm; }
          }
        }
      }
      if (!(m8 & bit) && leafySide(ctx.tile(nx, nz))) leafy |= bit;
    }
    const cls = auxClass(a);
    // no marked crossings on a lane, a motorway or a pedestrian street (its walkers have it all)
    if (cls === RoadCls.Lane || cls === RoadCls.Motorway || cls === RoadCls.Pedestrian) cross.fill(0);
    const box = junction && !mini && cls !== RoadCls.Lane && cls !== RoadCls.Pedestrian && cls !== RoadCls.Motorway && boxJunction(road, x, z, sig0, wear >= 2);
    const rail = isRailAux(a) ? railMask(a) : 0;
    // a signal crossing (R4): placed on a straight with the tool, or where a pedestrian street crosses this one
    const ped = (tx: number, tz: number) => { const b = ctx.aux(tx, tz); return isClassAux(b) ? b : 0; };
    let pelican: 'ns' | 'ew' | undefined;
    if (!under && cls !== RoadCls.Pedestrian && cls !== RoadCls.Motorway) {
      if (!junction && (arms === 5 || arms === 10) && this.rules?.ruleAt(x, z)?.pelican) pelican = arms === 5 ? 'ns' : 'ew';
      else if (junction) pelican = implicitPelican(this.roadKnown, ped, x, z) ?? undefined;
    }
    if (pelican && junction) cross.fill(0);
    // a signal crossing next door along this straight: its zigzags run on over the near half
    let zig = 0;
    if (!junction && !under && !pelican && (arms === 5 || arms === 10) && cls !== RoadCls.Pedestrian) for (let s = 0; s < 4; s++) {
      if (!(arms & (1 << s))) continue;
      const nx = x + SIDE[s][0], nz = z + SIDE[s][1], along = s === 0 || s === 2 ? 'ns' : 'ew';
      if (this.rules?.ruleAt(nx, nz)?.pelican || implicitPelican(this.roadKnown, ped, nx, nz) === along) zig |= 1 << s;
    }
    const zebra = !junction && !under && !pelican && midZebraAt(road, a, x, z);
    const prof = profileOf(tw, a);
    const t: RoadTile = { x, z, prof, m8, arms, junction, cross, ctrl, box, nCross, nCtrl, nArms, leafy, rail, under, zebra, wear };
    if (mini) t.mini = true;
    if (pelican) t.pelican = pelican;
    if (zig) t.zig = zig;
    if (nTurns) t.nTurns = nTurns.map((m, i) => (m < 0 ? nArms[i] : m));
    if (cls) t.cl = this.classInfo(x, z, a, cls, arms, junction, nArms, m8);
    const cl = t.cl;
    // R5 street rules on this tile (shared/src/roadrules.ts): double yellows on its kerbs, a bus lane, a 20 zone's hump and entry
    const st = this.rules?.ruleAt(x, z)?.st ?? 0;
    if (this.humps.size) this.humps.delete(`${x},${z}`);
    let stSig = '';
    if (st && !junction && !under && (arms === 5 || arms === 10)) {
      if (st & StreetRule.NoParking) t.yellow = ~m8 & 15;
      if (st & StreetRule.BusLane && cl && cl.flow >= 0) { t.bus = true; if ((((arms === 5 ? z : x) % 3) + 3) % 3 === 1) t.busText = true; }
      if (st & StreetRule.Zone20) {
        const zone = (tx: number, tz: number) => ((this.rules?.ruleAt(tx, tz)?.st ?? 0) & StreetRule.Zone20) !== 0;
        const jn = (tx: number, tz: number) => armCount(signalArms(road, tx, tz)) >= 3;
        if (humpAt(x, z, arms === 5, zone, jn)) { t.hump = true; this.humps.set(`${x},${z}`, arms === 5); }
        let zin = 0;
        for (let s = 0; s < 4; s++) if (arms & (1 << s) && !zone(x + SIDE[s][0], z + SIDE[s][1])) zin |= 1 << s;
        if (zin) t.zoneIn = zin;
      }
      stSig = `|S${t.yellow ?? 0},${t.bus ? 1 : 0}${t.busText ? 1 : 0},${t.hump ? 1 : 0},${t.zoneIn ?? 0}`;
    }
    const clSig = cl ? `|C${cl.cls},${cl.flow},${cl.twin},${cl.divJ ? 1 : 0},${cl.eC.join(',')},${cl.eK.join(',')},${cl.nose},${cl.slip},${cl.gore},${cl.mouth},${cl.arrow ? 1 : 0},${cl.jbox},${cl.jAhead ? 1 : 0},${cl.hold ?? 0}${cl.holdL ?? 0}${cl.holdR ?? 0},${cl.mbox ?? 0}` : '';
    const sig = `${prof.carriage},${prof.lanes},${prof.median},${prof.oneWay ? 1 : 0}|${m8},${arms},${junction ? 1 : 0}${cross.join('')}${ctrl.join('')}${box ? 1 : 0}${nCross.join('')}${nCtrl.join('')},${nArms.join('.')},${leafy},${rail},${under ? 1 : 0}${zebra ? 1 : 0},${wear}${mini ? 'M' : ''}${pelican ?? ''}${zig || ''}${t.nTurns ? `T${t.nTurns.join('.')}` : ''}${clSig}${stSig}`;
    return { sig, t, ring: null };
  }

  /**
   * A 5×5 roundabout's ring tile (R4, road class 6): its place round the island (the frame buildBigRing turns), and the
   * road joining it from outside the box, if any (cars coming on, going off, or both).
   */
  private bigRing(x: number, z: number, a: number): BigRingTile | null {
    const ctx = this.ctx!;
    const box = bigRingAt(ctx.aux, x, z);
    if (!box) return null;
    const ox = x - box[0], oz = z - box[1];
    const corner = (ox === 0 || ox === 4) && (oz === 0 || oz === 4);
    const turn = corner ? (ox === 4 && oz === 0 ? 0 : ox === 0 && oz === 0 ? 1 : ox === 0 ? 2 : 3) : ox === 4 ? 0 : oz === 0 ? 1 : ox === 0 ? 2 : 3;
    let arm = 0, armC = STREET.carriage;
    if (!corner) {
      const [dx, dz] = [[1, 0], [0, -1], [-1, 0], [0, 1]][turn], nx = x + dx, nz = z + dz, nb = ctx.aux(nx, nz);
      if (this.roadKnown(nx, nz) && !isPedestrianAux(nb)) {
        const na = isClassAux(nb) ? nb : 0, din = dx > 0 ? 1 : dx < 0 ? 0 : dz > 0 ? 3 : 2; // the step from the arm onto the ring
        if (carStepOk(na, a, din)) arm |= 1;
        if (carStepOk(a, na, [1, 0, 3, 2][din])) arm |= 2;
        armC = CLASS_PROFILES[auxClass(drawAux(na))]?.carriage ?? STREET.carriage;
      }
    }
    return { turn, corner, arm, armC };
  }

  /**
   * What a class tile's look depends on (roadGeo ClassInfo): its flow and twin, the widths and kerbs it meets at each
   * edge, where its reservation ends, a motorway's slips and gores, a pedestrian street's mouths, the one-way arrows.
   */
  private classInfo(x: number, z: number, a: number, cls: number, arms: number, junction: boolean, nArms: number[], m8: number): ClassInfo {
    const ctx = this.ctx!, P = CLASS_PROFILES[cls];
    const ow = oneWayDir(a), flow = ow >= 0 ? DIR_SIDE[ow] : -1;
    const roadAt = (s: number) => { const t = ctx.tile(x + SIDE[s][0], z + SIDE[s][1]); return t !== undefined && isRoad(t); };
    const auxS = (s: number) => this.cAux(x + SIDE[s][0], z + SIDE[s][1]);
    let twin = -1;
    if (flow >= 0 && isDividedAux(a)) {
      const s = (flow + 3) & 3, b = auxS(s), bo = oneWayDir(b);
      if (roadAt(s) && isDividedAux(b) && (b & 7) === cls && bo >= 0 && DIR_SIDE[bo] === ((flow + 2) & 3)) twin = s;
    }
    const eC = [0, 0, 0, 0], eK = [0, 0, 0, 0];
    let mouth = 0, slip = 0;
    for (let s = 0; s < 4; s++) {
      eC[s] = P.carriage;
      if (!roadAt(s)) continue;
      const nb = auxClass(auxS(s)), nP = CLASS_PROFILES[nb];
      // the two roads meet at the street's width, or else the wider of them
      eC[s] = nb === 0 ? nP.carriage : Math.max(P.carriage, nP.carriage);
      eK[s] = nP.kerb;
      if (cls === RoadCls.Pedestrian && nb !== RoadCls.Pedestrian) mouth |= 1 << s;
      if (cls === RoadCls.Motorway && flow >= 0 && s === ((flow + 1) & 3) && nb !== RoadCls.Motorway) slip |= 1 << s;
    }
    let nose = 0, gore = 0;
    if (twin >= 0) for (const e of [flow, (flow + 2) & 3]) {
      const b = auxS(e);
      if (!(roadAt(e) && isDividedAux(b) && (b & 7) === cls && oneWayDir(b) === ow)) nose |= 1 << e;
    }
    if (cls === RoadCls.Motorway && flow >= 0 && !slip) {
      const o = (flow + 1) & 3;
      for (const e of [flow, (flow + 2) & 3]) {
        const ex = x + SIDE[e][0], ez = z + SIDE[e][1], b = this.cAux(ex, ez);
        if (!isMotorwayAux(b) || oneWayDir(b) !== ow) continue;
        const tx = ex + SIDE[o][0], tz = ez + SIDE[o][1], tt = ctx.tile(tx, tz);
        if (tt !== undefined && isRoad(tt) && !isMotorwayAux(this.cAux(tx, tz))) gore |= 1 << e;
      }
    }
    const nsAxis = flow >= 0 ? flow === 0 || flow === 2 : (arms & 5) !== 0 && (arms & 10) === 0;
    const line = nsAxis ? x : z, pos = nsAxis ? z : x;
    let arrow = false;
    if (flow >= 0 && (arms === 5 || arms === 10) && !junction && !nArms.some(Boolean) && (cls === RoadCls.OneWay || cls === RoadCls.Avenue)) {
      // every few tiles, the phase hashed by the street (a one-way's matches its far cells, chunkView classCell)
      const per = cls === RoadCls.OneWay ? 4 + Math.floor(hash2(line * 3 + 1, 9) * 3) : 7, ph = Math.floor(hash2(line * 5 + 2, 11) * per);
      arrow = (((pos + ph) % per) + per) % per === 0 && (cls === RoadCls.OneWay || hash2(line * 7 + 5, pos) < 0.5);
    }
    // an avenue's crossing: its junction tiles (one each side of the reservation, two pairs where avenues cross) boxed
    // as one when every one of them is a crossing (road on all four sides), at about seven crossings in ten
    let jbox = -1;
    if (cls === RoadCls.Avenue && auxJunction(a) && (m8 & 15) === 15) {
      const isJ = (px: number, pz: number) => { const t = ctx.tile(px, pz); return t !== undefined && isRoad(t) && auxJunction(this.cAux(px, pz)); };
      const four = (px: number, pz: number) => SIDE.every(([dx, dz]) => { const t = ctx.tile(px + dx, pz + dz); return t !== undefined && isRoad(t); });
      const sides = [0, 1, 2, 3].filter((s) => isJ(x + SIDE[s][0], z + SIDE[s][1]));
      const members: [number, number][] = [[x, z], ...sides.map((s): [number, number] => [x + SIDE[s][0], z + SIDE[s][1]])];
      if (sides.length === 2 && (sides[0] + sides[1]) % 2 === 1) {
        const dx = SIDE[sides[0]][0] + SIDE[sides[1]][0], dz = SIDE[sides[0]][1] + SIDE[sides[1]][1];
        if (isJ(x + dx, z + dz)) members.push([x + dx, z + dz]);
      }
      const kx = Math.min(...members.map((m) => m[0])), kz = Math.min(...members.map((m) => m[1]));
      if (members.every(([px, pz]) => four(px, pz)) && hash2(kx * 17 + 5, kz * 13 + 7) < 0.7) {
        jbox = 0;
        for (let s = 0; s < 4; s++) if (!sides.includes(s)) jbox |= 1 << s;
      }
    }
    const ahead = flow >= 0 ? auxS(flow) : 0;
    const fx = flow >= 0 ? x + SIDE[flow][0] : 0, fz = flow >= 0 ? z + SIDE[flow][1] : 0;
    const jAhead = flow >= 0 && isDividedAux(a) && roadAt(flow) && isDividedAux(ahead) && auxJunction(ahead)
      && SIDE.every(([dx, dz]) => { const t = ctx.tile(fx + dx, fz + dz); return t !== undefined && isRoad(t); }); // a crossing, not a bend or an end
    const info: ClassInfo = { cls, flow, twin, divJ: auxJunction(a), eC, eK, nose, slip, gore, mouth, arrow, line, pos, jbox, jAhead };
    // R4 turn lanes: the last two tiles of a one-way approach (not a motorway) hold the lanes (TRAFFIC_TUNING.turnLanes)
    const TL = TRAFFIC_TUNING.turnLanes;
    if (TL && ow >= 0 && (cls === RoadCls.OneWay || cls === RoadCls.Avenue) && !junction) {
      const [dx, dz] = SIDE[flow];
      for (let k = 1; k <= 2; k++) {
        const jx = x + dx * k, jz = z + dz * k;
        const j = this.junctionAt(jx, jz);
        if (!j) {
          // the lanes must run on to it: the tile between one-way the same way
          const b = this.cAux(jx, jz);
          if (!this.roadKnown(jx, jz) || oneWayDir(b) !== ow) break;
          continue;
        }
        if (TL === 2 && j.phases !== 4) break;
        const ex = this.turnsFrom(j.g, ow), L = [3, 2, 0, 1][ow], R = [2, 3, 1, 0][ow];
        info.hold = k;
        info.holdL = ex & (1 << L) ? 2 : 0;
        info.holdR = (ex & (1 << ow) ? 1 : 0) | (ex & (1 << R) ? 4 : 0);
        break;
      }
    }
    // R4 median box: the edges of a junction group's tile shared with another of its tiles (a reservation a car crossing may wait on)
    if (TRAFFIC_TUNING.medianBox && junction && cls === RoadCls.Avenue && auxJunction(a)) {
      const g = this.junctionAt(x, z)?.g;
      if (g && (g.w > 1 || g.h > 1)) {
        let mbox = 0;
        for (let s = 0; s < 4; s++) if (inGroup(g, x + SIDE[s][0], z + SIDE[s][1])) mbox |= 1 << s;
        if (mbox) info.mbox = mbox;
      }
    }
    return info;
  }

  /** The junction at (x, z) as the traffic sees it (three or more arms that join for cars): its group and phases; null for none. */
  private junctionAt(x: number, z: number): { g: JunctionGroup; phases: number } | null {
    const ca = this.clsFn, road = this.roadKnown;
    if (!road(x, z) || isPedestrianAux(ca(x, z)) || isFlyoverAux(this.ctx!.aux(x, z)) || isDeckClassAux(ca(x, z)) || linkedDegree(road, ca, x, z) < 3) return null;
    const g = TRAFFIC_TUNING.groupSignals && isDividedAux(ca(x, z)) ? junctionGroup(road, ca, x, z) : null;
    if (g && (g.w > 1 || g.h > 1)) return { g, phases: TRAFFIC_TUNING.groupSignals === 2 ? 2 : g.phases };
    return { g: { x, y: z, w: 1, h: 1, phases: 2 }, phases: 2 };
  }
  /** The ways out of a junction (group): DIRS bits (E 1, W 2, S 4, N 8) where a car may leave it. */
  private exits(g: JunctionGroup): number {
    const ca = this.clsFn, CD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let m = 0;
    for (let ty = g.y; ty < g.y + g.h; ty++) for (let tx = g.x; tx < g.x + g.w; tx++) for (let d = 0; d < 4; d++) {
      const nx = tx + CD[d][0], nz = ty + CD[d][1];
      if (inGroup(g, nx, nz) || !this.roadKnown(nx, nz) || isPedestrianAux(ca(nx, nz)) || !roadsLinked(ca, tx, ty, d) || !carStepOk(ca(tx, ty), ca(nx, nz), d)) continue;
      m |= 1 << d;
    }
    return m;
  }
  /** The ways (DIRS bits) a car coming into junction group g heading inH may leave it: its ways out, less the U-turn and any turn the junction's signs ban. */
  private turnsFrom(g: JunctionGroup, inH: number): number {
    const r = this.rules?.ruleAt(g.x, g.y);
    let m = this.exits(g) & ~(1 << [1, 0, 3, 2][inH]);
    if (r) for (let d = 0; d < 4; d++) if (m & (1 << d) && !turnAllowed(r, inH, d)) m &= ~(1 << d);
    return m;
  }
  /** a tile's class byte, 0 for a street or any other byte (what the traffic rules read) */
  private clsFn = (x: number, z: number) => { const a = this.ctx!.aux(x, z); return isClassAux(a) ? a : 0; };

  /** A road tile under a flyover's ramp or a bridge's landing ramp (those draw it; render/junctions.ts, bridges.ts). */
  private isRamp(x: number, z: number, a: number): boolean {
    const ctx = this.ctx!;
    for (let s = 0; s < 4; s++) {
      const nx = x + SIDE[s][0], nz = z + SIDE[s][1], na = ctx.aux(nx, nz);
      if (!na) continue;
      const alongX = s === 1 || s === 3;
      if (isFlyoverAux(na) && deckEW(na) === alongX) { const nt = ctx.tile(nx, nz); if (nt !== undefined && isRoad(nt)) return true; }
      // an interchange's ramp (R4): the street tile either side of its deck, along the deck (a deck over a north-south motorway runs east-west)
      if (isDeckClassAux(na) && !isDeckClassAux(a) && (((na >> 3) & 3) >= 2) === alongX) { const nt = ctx.tile(nx, nz); if (nt !== undefined && isRoad(nt)) return true; }
      if (isBridgeAux(na) && bridgeNS(na) === !alongX) {
        const nt = ctx.tile(nx, nz);
        if (nt === undefined || terrainOf(nt) !== Terrain.Water) continue;
        if (bridgeStyle(na) === BridgeStyle.Bascule) return true;
        // a plain straight landing takes the ramp (bridges.ts span: no aux of its own, no road either side across)
        const px = alongX ? 0 : 1, pz = alongX ? 1 : 0;
        if (!a && !this.roadFn(x + px, z + pz) && !this.roadFn(x - px, z - pz)) return true;
      }
    }
    return false;
  }

  // ---- lamps --------------------------------------------------------------------------------------------------------

  /** Where a road tile's lamp stands (tile-local), where its light falls, and its habits; null for none. */
  private lampOf(x: number, z: number, tw: number, a: number): { px: number; pz: number; lx: number; lz: number; yaw: number; on: number; flags: number; design: number } | null {
    const road = this.roadFn;
    if (terrainOf(tw) === Terrain.Water || isRailAux(a) || isFlyoverAux(a) || isBridgeAux(a) || isDeckClassAux(a) || this.isRamp(x, z, a)) return null;
    if (midZebraAt(road, a, x, z)) return null; // the zebra's beacons stand there
    const r = (n: number) => hash2(x * 41 + n * 13, z * 37 - n * 7);
    const cls = auxClass(a);
    if (cls === RoadCls.Motorway) return this.motorwayLamp(x, z, a, r);
    let px = 0, pz = 0, lx = 0, lz = 0, line = 0, st = 0;
    if (isRingAux(a)) {
      const p = ringPos(a);
      if (!(p & 1) || r(1) > 0.5) return null;
      // on the outer corner of the ring, leaning in over it
      const [ox, oz] = RING_POS[p];
      px = ox * 0.44; pz = oz * 0.44; lx = ox * 0.3; lz = oz * 0.3; line = x; st = z;
    } else if (isRingClassAux(a)) {
      // a 5×5 roundabout (R4): on the outer pavement of about one side tile in two, the outer corner of each corner tile
      const b = this.bigRing(x, z, a);
      if (!b || b.arm || r(1) > (b.corner ? 0.8 : 0.45)) return null;
      let p: [number, number] = b.corner ? [0.43, -0.43] : [0.465, (r(2) - 0.5) * 0.3], l: [number, number] = b.corner ? [0.3, -0.3] : [0.3, p[1]];
      for (let i = 0; i < b.turn; i++) { p = [p[1], -p[0]]; l = [l[1], -l[0]]; }
      [px, pz] = p; [lx, lz] = l; line = Math.floor(x / 5); st = Math.floor(z / 5);
    } else {
      const arms = signalArms(road, x, z), n = armCount(arms);
      if (arms === 5 || arms === 10) {
        // along a straight: every third tile, the side alternating, the spacing set by the street's own phase
        const ns = arms === 5, along = ns ? z : x;
        line = ns ? x : z;
        // (a pedestrian street's heritage lamps every other tile)
        const per = cls === RoadCls.Pedestrian ? 2 : 3;
        const k = along + Math.floor(hash2(line * 7 + 3, ns ? 41 : 43) * 3);
        if (((k % per) + per) % per !== 0) return null;
        let side = Math.floor(k / per) & 1 ? 1 : -1;
        const sideRoad = (sd: number) => (ns ? road(x + sd, z) : road(x, z + sd));
        if (sideRoad(side)) side = -side;
        if (sideRoad(side)) return null;
        if (cls === RoadCls.Lane && r(12) > 0.18) return null; // a lane's lamps are few and far between
        const j = (r(2) - 0.5) * 0.3;
        // the lantern reaches out over the road from the back of the pavement
        if (ns) { px = side * 0.47; pz = j; lx = side * 0.34; lz = j; } else { px = j; pz = side * 0.47; lx = j; lz = side * 0.34; }
        st = Math.floor(along / 8);
      } else if (n === 2) {
        // a bend: on the outside corner, leaning in over the turn
        // (not on a divided road's junction tiles: their outside corner is the crossing or the turn)
        if (r(3) > 0.6 || (cls === RoadCls.Lane && r(12) > 0.25) || auxJunction(a)) return null;
        const sx = arms & 2 ? -1 : 1, sz = arms & 4 ? -1 : 1;
        px = sx * 0.43; pz = sz * 0.43; lx = sx * 0.34; lz = sz * 0.34; line = x + z; st = 0;
      } else return null;
    }
    if (r(4) < 0.04) return null; // a column taken down and not replaced
    // the street's lamps: one design and colour per stretch, now and then a replacement that does not match
    const ds = hash2(line * 11 + 5, st * 3 + 1), odd = r(5) < 0.08;
    let design = odd ? Math.floor(r(6) * 3) : ds < 0.45 ? 0 : ds < 0.8 ? 1 : 2;
    if (cls === RoadCls.Pedestrian) design = r(6) < 0.06 ? 1 : 2; // heritage lanterns, now and then an old column
    else if (cls === RoadCls.Lane) design = ds < 0.65 ? 1 : 0;
    const led = design === 0 ? r(7) > 0.1 : design === 2 ? r(7) < 0.5 : r(7) < 0.15;
    if (design === 2) { lx = px; lz = pz; }
    const dead = r(8) < 0.04, sput = !dead && r(9) < 0.05;
    const bright = Math.floor(r(10) * 31);
    const flags = (dead ? 1 : 0) | (sput ? 2 : 0) | (led ? 4 : 0) | (bright << 3);
    return { px, pz, lx, lz, yaw: Math.atan2(-(lz - pz), lx - px), on: 0.1 + 0.55 * r(11), flags, design };
  }

  /**
   * A motorway's lamps: on the reservation, every third tile of a lit stretch, the pair of carriageways' columns on the
   * same spot (one column with an arm each way), each lantern lighting its own carriageway.
   */
  private motorwayLamp(x: number, z: number, a: number, r: (n: number) => number) {
    const ow = oneWayDir(a);
    if (ow < 0) return null;
    const f = DIR_SIDE[ow], tw = (f + 3) & 3, [tx, tz] = SIDE[tw];
    const b = this.ctx!.aux(x + tx, z + tz);
    if (!isMotorwayAux(b) || oneWayDir(b) < 0) return null;
    const ns = f === 0 || f === 2, along = ns ? z : x;
    const edge = ns ? x + Math.max(0, tx) : z + Math.max(0, tz); // the shared edge, the same for both of the pair
    if (hash2(edge * 7 + 1, Math.floor(along / 12) * 5 + (ns ? 1 : 2)) > 0.6) return null; // an unlit stretch
    const k = along + Math.floor(hash2(edge * 11 + 5, ns ? 7 : 9) * 3);
    if (((k % 3) + 3) % 3 !== 0) return null;
    const j = (hash2(edge * 13 + 3, along * 7 + 1) - 0.5) * 0.2;
    const px = ns ? tx * 0.5 : j, pz = ns ? j : tz * 0.5, lx = ns ? tx * 0.3 : j, lz = ns ? j : tz * 0.3;
    const dead = r(8) < 0.03, sput = !dead && r(9) < 0.03, led = hash2(edge * 3 + 1, Math.floor(along / 12)) > 0.25;
    const flags = (dead ? 1 : 0) | (sput ? 2 : 0) | (led ? 4 : 0) | (Math.floor(r(10) * 31) << 3);
    return { px, pz, lx, lz, yaw: Math.atan2(-(lz - pz), lx - px), on: 0.1 + 0.55 * r(11), flags, design: 0 };
  }

  private placeLamps(e: Entry) {
    const x0 = e.cx * CHUNK_SIZE, z0 = e.cy * CHUNK_SIZE, d = this.lampData;
    for (let i = 0; i < N; i++) {
      const x = x0 + (i % CHUNK_SIZE), z = z0 + Math.floor(i / CHUNK_SIZE);
      const o = (((z % OVL_SIZE) + OVL_SIZE) % OVL_SIZE * OVL_SIZE + (((x % OVL_SIZE) + OVL_SIZE) % OVL_SIZE)) * 4;
      const t = e.chunk.tiles[i];
      const l = isRoad(t) ? this.lampOf(x, z, t, e.chunk.aux[i]) : null;
      if (!l) { d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0; continue; }
      d[o] = Math.max(1, Math.round(l.on * 255)); d[o + 1] = Math.round((l.lx + 0.5) * 255); d[o + 2] = Math.round((l.lz + 0.5) * 255); d[o + 3] = l.flags;
    }
    this.lampDirty = true;
  }
  private clearLamps(e: Entry) {
    const x0 = e.cx * CHUNK_SIZE, z0 = e.cy * CHUNK_SIZE, d = this.lampData;
    for (let i = 0; i < N; i++) {
      const x = x0 + (i % CHUNK_SIZE), z = z0 + Math.floor(i / CHUNK_SIZE);
      const o = (((z % OVL_SIZE) + OVL_SIZE) % OVL_SIZE * OVL_SIZE + (((x % OVL_SIZE) + OVL_SIZE) % OVL_SIZE)) * 4;
      d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0;
    }
    this.lampDirty = true;
  }

  // ---- furniture ----------------------------------------------------------------------------------------------------

  /** A road tile's furniture: its lamp, street trees, bollards at junction corners, a bin, Belisha beacons, name plates. */
  private furnish(t: RoadTile): Furn[] {
    const ctx = this.ctx!;
    const out: Furn[] = [];
    const ox = t.x + 0.5, oz = t.z + 0.5;
    const r = (n: number) => hash2(t.x * 53 + n * 11, t.z * 47 - n * 5);
    const at = (lx: number, lz: number) => surfaceY(t, ox + lx, oz + lz);
    const put = (f: number, lx: number, lz: number, yaw: number, s: number, c: Color, lean = 0, leanDir = 0, lamp?: [number, number, number, number], y?: number) => {
      const q = new Quaternion().setFromAxisAngle(UP, yaw);
      if (lean) q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(Math.cos(leanDir), 0, -Math.sin(leanDir)), lean));
      out.push({ f, m: new Matrix4().compose(new Vector3(ox + lx, y ?? at(lx, lz), oz + lz), q, new Vector3(s, s, s)), c, lamp });
    };
    const cls = t.cl?.cls ?? 0;
    const tw = ctx.tile(t.x, t.z)!;
    const l = this.lampOf(t.x, t.z, tw, ctx.aux(t.x, t.z));
    let lampSide = -1, lampAlong = 0;
    if (l && cls === RoadCls.Motorway) {
      // the pair's columns stand on one spot, so they are alike: one column with an arm each way
      put(F.Post0, l.px, l.pz, l.yaw, 1, new Color().setScalar(0.95));
      put(F.Lens0, l.px, l.pz, l.yaw, 1, new Color(1, 1, 1), 0, 0, [l.on, l.flags, t.x, t.z]);
    } else if (l) {
      const s = 0.95 + 0.1 * r(1);
      const tone = new Color().setScalar(0.85 + 0.25 * r(2));
      put(F.Post0 + l.design, l.px, l.pz, l.yaw, s, tone, (r(3) - 0.5) * 0.04, r(4) * 6.28);
      put(F.Lens0 + l.design, l.px, l.pz, l.yaw, s, new Color(1, 1, 1), (r(3) - 0.5) * 0.04, r(4) * 6.28, [l.on, l.flags, t.x, t.z]);
      lampSide = Math.abs(l.px) > Math.abs(l.pz) ? (l.px > 0 ? 1 : 3) : (l.pz > 0 ? 2 : 0);
      lampAlong = Math.abs(l.px) > Math.abs(l.pz) ? l.pz : l.px;
    }
    // street trees in the verge (a motorway's verge is kept clear)
    for (let s = 0; s < 4 && cls !== RoadCls.Motorway; s++) {
      const tree = streetTreeAt(ctx.tile, t.x, t.z, 1 << s);
      if (!tree || (s === lampSide && Math.abs(tree.along - lampAlong) < 0.2)) continue;
      const off = 0.482, [dx, dz] = SIDE[s];
      const lx = dx * off + (dx === 0 ? tree.along : 0), lz = dz * off + (dz === 0 ? tree.along : 0);
      const k = tree.k, species = k < 0.55 ? 0 : k < 0.75 ? 1 : 2;
      const size = (species === 2 ? 1.35 : 1.75) + 0.7 * hash2(t.x * 3 + s, t.z * 5 - s);
      const leaf = species === 2 ? LEAF[5 + (hash2(t.x + s, t.z) < 0.6 ? 0 : 1)] : LEAF[Math.floor(hash2(t.x * 7 + s, t.z * 3) * 4.99)];
      const c = leaf.clone().multiplyScalar(0.85 + 0.25 * hash2(t.z * 11 + s, t.x * 13));
      const lean = 0.03 + 0.06 * hash2(t.x * 19 + s, t.z * 23), leanDir = Math.atan2(-dz, -dx) + (hash2(t.x, t.z * 3 + s) - 0.5) * 1.2; // towards the open road, for the light
      const yaw = hash2(t.x * 29 + s, t.z * 31) * 6.28;
      put(F.Trunk, lx, lz, yaw, size, new Color().setScalar(0.85 + 0.3 * hash2(t.x + 9, t.z + s)), lean, leanDir);
      put(species === 1 ? F.Column : F.Crown, lx, lz, yaw, size * (species === 1 ? 1 : 1 + 0.15 * hash2(t.x, t.z + s * 7)), c, lean, leanDir);
    }
    if (cls === RoadCls.Avenue && t.cl!.twin >= 0) this.reservationTrees(t, put);
    if (cls === RoadCls.Pedestrian) this.pedFurniture(t, put);
    if (t.junction && cls !== RoadCls.Lane && cls !== RoadCls.Motorway && cls !== RoadCls.Pedestrian) {
      const c = t.prof.carriage;
      // bollards round some corners, clear of the walkers' corner (the sidewalk line meets at 45°)
      for (const [sx, sz, sa, sb] of [[1, -1, 1, 0], [1, 1, 1, 2], [-1, 1, 3, 2], [-1, -1, 3, 0]]) {
        if (!(t.m8 & (1 << sa)) || !(t.m8 & (1 << sb)) || r(20 + sa * 3 + sb) > 0.45) continue;
        for (const ang of [0.35, 1.22]) {
          const lx = sx * (0.5 - Math.cos(ang) * 0.104), lz = sz * (0.5 - Math.sin(ang) * 0.104);
          put(F.Bollard, lx, lz, 0, 0.95 + 0.1 * r(30 + sa), new Color().setScalar(0.9 + 0.2 * r(31 + sb)));
        }
      }
      // Belisha beacons at both ends of each zebra, in step with each other, each crossing at its own rate
      for (let s = 0; s < 4; s++) {
        if (t.cross[s] !== MouthCrossing.Zebra) continue;
        const [dx, dz] = SIDE[s], rx = -dz, rz = dx;
        for (const e of [-1, 1]) {
          const lx = dx * 0.41 + rx * e * (c + 0.055), lz = dz * 0.41 + rz * e * (c + 0.055);
          put(F.Beacon, lx, lz, 0, 1, new Color(1, 1, 1));
          put(F.Globe, lx, lz, 0, 1, new Color(1, 1, 1), 0, 0, [r(40 + s), r(44 + s), 0, 0]);
        }
      }
    } else if (t.zebra) {
      // Belisha beacons at the ends of a mid-block zebra
      const ns = t.arms === 5, c = t.prof.carriage;
      for (const e of [-1, 1]) {
        const lx = ns ? e * (c + 0.055) : 0, lz = ns ? 0 : e * (c + 0.055);
        put(F.Beacon, lx, lz, 0, 1, new Color(1, 1, 1));
        put(F.Globe, lx, lz, 0, 1, new Color(1, 1, 1), 0, 0, [r(40), r(44), 0, 0]);
      }
    } else if ((t.arms === 5 || t.arms === 10) && r(50) < 0.1 && cls !== RoadCls.Lane && cls !== RoadCls.Motorway) {
      // a litter bin on the pavement, away from the lamp
      const ns = t.arms === 5, sides = ns ? [1, 3] : [0, 2];
      const s = sides[r(51) < 0.5 ? 0 : 1];
      if (s !== lampSide && !(t.m8 & (1 << s))) {
        const [dx, dz] = SIDE[s], along = (r(52) - 0.5) * 0.6;
        const binC = r(53) < 0.6 ? new Color(0x2b3a2e) : r(53) < 0.85 ? new Color(0x1d1f22) : new Color(0x6b2a24);
        put(F.Bin, dx * 0.468 + (dx === 0 ? along : 0), dz * 0.468 + (dz === 0 ? along : 0), r(54) * 6.28, 1, binC);
      }
    }
    // a name plate post on a corner where the street meets a junction: always on a road that gives way, on about half
    // of the others (R2 names the street on it)
    for (let s = 0; s < 4; s++) {
      if (cls === RoadCls.Motorway) break;
      if (!t.nArms[s] || (t.nCtrl[s] !== MouthControl.GiveWay && r(70 + s) > 0.5)) continue;
      const [dx, dz] = SIDE[s], rx = -dz, rz = dx;
      const e = r(60 + s) < 0.5 ? -1 : 1;
      if (t.m8 & (1 << (e > 0 ? (s + 1) & 3 : (s + 3) & 3))) continue;
      const lx = dx * 0.36 + rx * e * 0.468, lz = dz * 0.36 + rz * e * 0.468;
      const yaw = Math.atan2(rx * e, rz * e) + Math.PI / 2;
      put(F.Sign, lx, lz, yaw, 1, new Color(1, 1, 1));
      out[out.length - 1].street = streetLine(streetRun(t.x, t.z, s === 0 || s === 2, this.roadFn));
    }
    return out;
  }

  /**
   * Trees on an avenue's reservation, stood on the shared edge by one of the pair (the tile with its twin to the north
   * or west): by stretch a tree on every tile, on every other with shrubs between, or shrubs only; one species to a
   * stretch with the odd replacement, each tree its own size, lean and place, a gap where one was lost.
   */
  private reservationTrees(t: RoadTile, put: (f: number, lx: number, lz: number, yaw: number, s: number, c: Color, lean?: number, leanDir?: number, lamp?: [number, number, number, number], y?: number) => void) {
    const cl = t.cl!, tw = cl.twin;
    if (tw !== 0 && tw !== 3) return;
    const [nx, nz] = SIDE[tw], ux = -nz, uz = nx;
    const ns = ux === 0, along = ns ? t.z : t.x, edge = ns ? t.x + Math.max(0, nx) : t.z + Math.max(0, nz);
    const h = (n: number) => hash2(edge * 31 + n * 7, along * 17 - n * 3);
    const sideOf = (dx: number, dz: number) => SIDE.findIndex(([x, z]) => x === dx && z === dz);
    const umax = cl.nose & (1 << sideOf(ux, uz)) ? 0.1 : 0.42, umin = cl.nose & (1 << sideOf(-ux, -uz)) ? -0.1 : -0.42; // (a nose keeps clear for the signal pole on it, R4)
    const stretchK = Math.floor(along / 8), style = hash2(edge * 5 + 2, stretchK * 3 + 1), K = t.prof.kerb;
    const sp = hash2(edge * 3 + 9, stretchK * 7 + 2), odd = h(1) < 0.12;
    const kind = odd ? h(8) : sp; // species: plane/lime greens, a column of poplars, cherries in blossom
    const at = (u: number): [number, number] => [nx * 0.5 + ux * u, nz * 0.5 + uz * u];
    if (style < 0.85 && (style < 0.6 || (along & 1) === 0) && h(2) > 0.1) {
      const u = Math.max(umin, Math.min(umax, (h(3) - 0.5) * 0.35)), [lx, lz] = at(u);
      const column = kind > 0.62 && kind < 0.8, blossom = kind >= 0.8;
      const size = (blossom ? 1.4 : 1.65) + 0.65 * h(4), lean = 0.02 + 0.05 * h(5), leanDir = h(6) * 6.28, yaw = h(7) * 6.28;
      const leaf = blossom ? LEAF[5 + (h(9) < 0.6 ? 0 : 1)] : LEAF[Math.floor(kind * 6.4) % 5];
      put(F.Trunk, lx, lz, yaw, size, new Color().setScalar(0.85 + 0.3 * h(10)), lean, leanDir, undefined, K);
      put(column ? F.Column : F.Crown, lx, lz, yaw, size * (column ? 1 : 1 + 0.15 * h(11)), leaf.clone().multiplyScalar(0.85 + 0.25 * h(12)), lean, leanDir, undefined, K);
    }
    if (style >= 0.6) {
      // shrubs: low, rounded, a darker green
      const n = 2 + (h(13) < 0.5 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const u = Math.max(umin, Math.min(umax, -0.42 + 0.84 * ((i + 0.3 + 0.4 * h(14 + i)) / n))), [lx, lz] = at(u), s = 0.6 + 0.3 * h(16 + i);
        put(F.Crown, lx, lz, h(18 + i) * 6.28, s, LEAF[1].clone().multiplyScalar(0.7 + 0.25 * h(20 + i)), 0, 0, undefined, K - 0.11 * s);
      }
    }
  }

  /**
   * A pedestrian street's furniture: bollards across each mouth where a road cars use meets it (three or four, one now
   * and then missing), and now and then a bench or a planter with a shrub, clear of the walkers' lines (0.42 out).
   */
  private pedFurniture(t: RoadTile, put: (f: number, lx: number, lz: number, yaw: number, s: number, c: Color, lean?: number, leanDir?: number, lamp?: [number, number, number, number], y?: number) => void) {
    const cl = t.cl!;
    const r = (n: number) => hash2(t.x * 59 + n * 17, t.z * 43 - n * 11);
    const prec = hash2(Math.floor(t.x / 7) * 5 + 3, Math.floor(t.z / 7) * 9 + 1); // the precinct's style
    const bollardC = prec < 0.4 ? new Color(1, 1, 1) : prec < 0.7 ? new Color(0.75, 0.95, 0.8) : new Color(1.6, 1.6, 1.65);
    for (let s = 0; s < 4; s++) {
      if (!(cl.mouth & (1 << s))) continue;
      const [dx, dz] = SIDE[s], rx = -dz, rz = dx;
      const n = 3 + (r(1 + s) < 0.5 ? 1 : 0), span = 0.26;
      for (let i = 0; i < n; i++) {
        if (r(10 + s * 5 + i) < 0.08) continue; // one taken out (for the deliveries) and not put back
        const across = -span + (2 * span * i) / (n - 1) + (r(30 + s * 5 + i) - 0.5) * 0.02;
        put(F.Bollard, dx * 0.44 + rx * across, dz * 0.44 + rz * across, 0, 0.95 + 0.15 * r(50 + i), bollardC.clone().multiplyScalar(0.9 + 0.2 * r(55 + i)));
      }
    }
    if ((t.arms !== 5 && t.arms !== 10) || t.junction || r(80) > 0.38) return;
    const ns = t.arms === 5, side = r(81) < 0.5 ? -1 : 1, along = (r(82) - 0.5) * 0.6, across = side * (0.24 + 0.04 * r(83));
    const lx = ns ? across : along, lz = ns ? along : across;
    if (r(84) < 0.55) {
      // a bench facing the middle of the street: timber, green-painted iron or black
      const dx = ns ? -side : 0, dz = ns ? 0 : -side, k = r(85);
      const c = k < 0.5 ? new Color(0.62, 0.42, 0.26) : k < 0.8 ? new Color(0.2, 0.36, 0.26) : new Color(0.14, 0.15, 0.16);
      put(F.Bench, lx, lz, Math.atan2(dx, dz), 1, c.multiplyScalar(0.9 + 0.2 * r(86)));
    } else {
      // a planter (terracotta, stone or charcoal) with a shrub or a flowering bush in it
      const k = r(87), ps = 2.2 + 0.9 * r(88);
      const c = k < 0.4 ? new Color(0.72, 0.42, 0.3) : k < 0.75 ? new Color(0.78, 0.76, 0.72) : new Color(0.24, 0.25, 0.27);
      put(F.Bin, lx, lz, r(89) * 6.28, ps, c);
      const sh = 0.36 + 0.16 * r(90), leaf = LEAF[Math.floor(r(91) * 6.99)];
      put(F.Crown, lx, lz, r(92) * 6.28, sh, leaf.clone().multiplyScalar(0.85 + 0.25 * r(93)), 0, 0, undefined, 0.042 * ps - 0.105 * sh);
    }
  }

  private furnishRing(x: number, z: number): Furn[] {
    const ctx = this.ctx!;
    const tw = ctx.tile(x, z)!;
    const l = this.lampOf(x, z, tw, ctx.aux(x, z));
    if (!l) return [];
    const m = new Matrix4().compose(new Vector3(x + 0.5 + l.px, STREET.kerb, z + 0.5 + l.pz), new Quaternion().setFromAxisAngle(UP, l.yaw), new Vector3(1, 1, 1));
    return [{ f: F.Post0 + l.design, m, c: new Color(1, 1, 1) }, { f: F.Lens0 + l.design, m, c: new Color(1, 1, 1), lamp: [l.on, l.flags, x, z] }];
  }

  private fillFurniture() {
    this.furnDirty = false;
    const counts = new Array(F_COUNT).fill(0);
    this.plates = [];
    const sign = new Vector3(), sq = new Quaternion(), ss = new Vector3();
    for (const e of this.entries.values()) {
      if (!e.near || !e.mesh) continue;
      for (const f of e.furn) {
        const mesh = this.meshes[f.f], i = counts[f.f];
        if (i >= mesh.instanceMatrix.count) continue;
        mesh.setMatrixAt(i, f.m);
        mesh.setColorAt(i, f.c);
        if (f.lamp) (mesh.geometry.attributes.aLamp as InstancedBufferAttribute).setXYZW(i, ...f.lamp);
        counts[f.f]++;
        if (f.f === F.Sign) {
          f.m.decompose(sign, sq, ss);
          const yaw = 2 * Math.atan2(sq.y, sq.w);
          this.plates.push({ x: sign.x, y: sign.y + 0.053, z: sign.z, yaw, street: f.street ?? '' });
        }
      }
    }
    this.meshes.forEach((m, i) => {
      m.count = counts[i];
      m.visible = counts[i] > 0; // no draw call (nor shadow pass) for a kind with nothing to show
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      const al = m.geometry.attributes.aLamp as InstancedBufferAttribute | undefined;
      if (al) al.needsUpdate = true;
    });
  }

  /** for the console and tests: chunks near, built, tiles cached, furniture drawn */
  stats() {
    let near = 0, built = 0, tiles = 0, tris = 0;
    for (const e of this.entries.values()) {
      if (e.near) near++;
      if (e.mesh) { built++; tris += (e.mesh.geometry.index?.count ?? 0) / 3; }
      tiles += e.tiles.size;
    }
    const b = this.builds, fresh = b.filter((q) => q.fresh), cached = b.filter((q) => !q.fresh && q.tiles);
    const avg = (q: { ms: number }[]) => (q.length ? +(q.reduce((n, x) => n + x.ms, 0) / q.length).toFixed(2) : null);
    return {
      chunks: this.entries.size, near, built, tiles, tris, furniture: this.meshes.reduce((n, m) => n + m.count, 0),
      buildMs: { fresh: avg(fresh), freshMax: fresh.length ? +Math.max(...fresh.map((q) => q.ms)).toFixed(2) : null, cached: avg(cached), n: b.length },
    };
  }
}

/** side (N E S W) to DIRS (E W S N) index, and DIRS bits to side bits */
const SIDE_DIR = [3, 0, 2, 1];
const sidesOf = (dirs: number) => (dirs & 1 ? 2 : 0) | (dirs & 2 ? 8 : 0) | (dirs & 4 ? 4 : 0) | (dirs & 8 ? 1 : 0);
/** a tile's byte for drawing: a motorway carriageway under an interchange's deck (class 7, R4) is drawn as the motorway */
const drawAux = (a: number) => (isDeckClassAux(a) ? (a & ~7) | RoadCls.Motorway : a);
/** the control on arm s of the junction where an interchange's slips meet its street (`axis` 1: the street runs east-west): the slips give way */
const slipCtrl = (axis: number, s: number) => ((s === 0 || s === 2) === (axis === 1) ? MouthControl.GiveWay : MouthControl.None);

/** congestion smoothed (0..1) to a wear level 0..3 */
const wearLevel = (w: number) => (w > 0.45 ? 3 : w > 0.25 ? 2 : w > 0.1 ? 1 : 0);
