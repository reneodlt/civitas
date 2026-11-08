import {
  BoxGeometry, CylinderGeometry, Group, InstancedMesh, Matrix4, Quaternion, Vector3, Color, Mesh, InstancedBufferGeometry,
  InstancedBufferAttribute, PlaneGeometry, ShaderMaterial, NormalBlending, DynamicDrawUsage, DoubleSide, type BufferGeometry, type Camera,
} from 'three';
import { hash2, type CompiledOp } from '@msimcity/shared';
import { RECIPES, HELPER_RECIPES } from '@msimcity/shared/src/buildings/recipes';
import { Kit } from './kit';
import { vehicleMaterial, sceneUniforms } from './materials';
import { motion } from './motionGate';

/**
 * The small signs of life on the buildings a player sees in their first hour (docs/buildings.md "Moving parts"):
 * smoke from the chimneys of works and power plants by day, from a few homes' chimneys on winter-dark evenings and
 * mornings, and from the pioneer camp's fire at night; and the cranes over every building site and builders' yard,
 * which slew to a new spot, run their trolley out along the jib and lower the hook, each on its own clock.
 *
 * Both are read off the compiled recipes, so no design needs marking up: a chimney stack is the red cap the
 * `chimneyStack` helper puts on top of one, a home's chimney a small box in the chimney colour, the camp's fire its
 * flame blocks (window class 7), and a crane its mast (the `crane` helper now builds only the mast; the jib, cab,
 * cable and hook are this pass's). Placements come from render/buildings.ts (setChunk), so a chunk rebuild keeps
 * each crane where it was in its swing (state by tile).
 *
 * Cost: the smoke is one instanced draw of billboards animated on the GPU from uTime; the CPU lays it out again only
 * when the camera has moved or every couple of seconds, nearest sources first up to MAX_SOURCES. The cranes are two
 * instanced draws and a few matrix writes a frame for those within range. Both follow the motion switch
 * (render/motionGate.ts): at level 1 half the sources and every other frame, at 0 frozen.
 */
const RANGE = 70, CRANE_RANGE = 90, MAX_SOURCES = 120, MAX_CRANES = 96, PUFFS = 6;
/** palette numbers the recipes compile to (shared buildings/palette.ts): the stack cap's red, the chimney grey, the crane's yellow */
const CAP_RED = 0xcb3b2d, CHIMNEY = 0x6b6e74, CRANE_YELLOW = 0xe6b734;
const WIND = 0.7;

/** a smoke source in a design's frame: the top of a stack (kind 0), a home's chimney (1) or a camp fire (2) */
interface Stack { x: number; y: number; z: number; r: number; kind: number }
interface Mast { x: number; y: number; z: number; h: number }
interface Features { stacks: Stack[]; masts: Mast[] }
const featureCache = new Map<string, Features>();
let recipeIndex: Map<string, readonly CompiledOp[]> | null = null;

/** What a design has to animate, from its compiled ops (cached per key). */
function featuresOf(key: string): Features {
  let f = featureCache.get(key);
  if (f) return f;
  if (!recipeIndex) { recipeIndex = new Map(); for (const r of [...RECIPES, ...HELPER_RECIPES]) recipeIndex.set(r.key, r.ops); }
  const ops = recipeIndex.get(key) ?? [];
  const stacks: Stack[] = [], masts: Mast[] = [];
  for (const op of ops) {
    if (op[0] === 'cyl') {
      // a stack's red cap: the chimneyStack helper's (0.07 tall) or a recipe's own short red ring on a chimney
      const [, rTop, , h, x, y, z, colour] = op;
      if (h >= 0.04 && h <= 0.1 && colour === CAP_RED && rTop <= 0.14) stacks.push({ x, y: y + h, z, r: Math.max(0.025, rTop * 0.8), kind: 0 });
    } else if (op[0] === 'box') {
      const [, w, h, d, x, y, z, colour, win] = op;
      if (colour === CHIMNEY && w <= 0.12 && d <= 0.12 && h >= 0.06) stacks.push({ x, y: y + h, z, r: 0.028, kind: 1 });
      else if (win === 7 && h >= 0.07 && key.startsWith('120:')) stacks.push({ x, y: y + h, z, r: 0.035, kind: 2 }); // the pioneer camp's fire, not a lantern
      else if (colour === CRANE_YELLOW && Math.abs(w - 0.06) < 1e-6 && Math.abs(d - 0.06) < 1e-6 && h >= 0.8) masts.push({ x, y, z, h });
    }
  }
  f = { stacks, masts };
  featureCache.set(key, f);
  return f;
}

/** a source placed in the world */
interface Source { x: number; y: number; z: number; r: number; kind: number; seed: number }
interface Crane { key: string; matrix: Matrix4; top: Vector3; h: number; seed: number; colour: number }
interface CraneState { yaw: number; yawTo: number; trolley: number; trolleyTo: number; hook: number; hookTo: number; nextAt: number; n: number }

const SMOKE_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
uniform float uTime; uniform float uWind;
varying vec2 vUv; varying float vA; varying float vTone; varying float vSeed;
void main() {
  float seed = aS.x, size = aS.y, period = aS.z, kind = aO.y, inten = aI.x;
  // a puff's life: born at the chimney's mouth, rising, swelling, thinning and leaning downwind, on its own clock
  float life = fract(uTime / period + seed * 13.7);
  float drift = uWind + (fract(seed * 3.1) - 0.5) * 0.5;
  vec3 dir = vec3(cos(drift), 0.0, sin(drift));
  float tall = kind < 0.5 ? 1.0 : kind < 1.5 ? 0.45 : 0.6;
  float rise = life * (0.6 + 0.6 * fract(seed * 5.3)) * tall;
  float lean = pow(life, 1.6) * (0.35 + 0.5 * fract(seed * 9.1)) * tall;
  float wob = sin(uTime * (0.8 + fract(seed * 4.7)) + seed * 17.0) * 0.06 * life;
  vec3 c = aP + vec3(0.0, 0.02 + rise, 0.0) + dir * lean + vec3(-dir.z, 0.0, dir.x) * wob;
  float s = size * (0.6 + 3.2 * life);
  float ang = seed * 6.283 + uTime * (fract(seed * 2.9) - 0.5) * 0.3;
  vec2 rp = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * position.xy;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  gl_Position = projectionMatrix * viewMatrix * vec4(c + (right * rp.x + up * rp.y) * s, 1.0);
  vUv = uv;
  vA = inten * pow(sin(3.14159 * life), 0.8) * (1.0 - 0.45 * life);
  vTone = aI.y; vSeed = seed;
}`;
const SMOKE_FRAG = /* glsl */ `
uniform float uNight;
varying vec2 vUv; varying float vA; varying float vTone; varying float vSeed;
void main() {
  if (vA < 0.004) discard;
  vec2 q = vUv * 2.0 - 1.0;
  float ang = atan(q.y, q.x);
  float lobes = 0.82 + 0.1 * sin(ang * 3.0 + vSeed * 20.0) + 0.08 * sin(ang * 5.0 - vSeed * 11.0);
  float r = length(q) / lobes;
  float a = (1.0 - smoothstep(0.25, 1.0, r)) * vA * 0.55;
  if (a < 0.004) discard;
  // pale steam from a works' stack, grey coal smoke from a hearth, the camp fire's wood smoke; all darker at night
  vec3 col = mix(vec3(0.32, 0.31, 0.3), vec3(0.86, 0.86, 0.88), vTone) * (1.0 - 0.6 * uNight);
  gl_FragColor = vec4(col, a);
}`;

/** the jib, counter-jib and cab as the `crane` helper drew them, about the mast top; the cable one unit long (scaled) and the hook */
function jibGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.66, 0.05, 0.05).translate(0.18, -0.025, 0), CRANE_YELLOW);
  k.part(new BoxGeometry(0.1, 0.08, 0.08).translate(-0.22, -0.06, 0), 0x2b2e36);
  k.part(new BoxGeometry(0.1, 0.1, 0.1).translate(0.02, -0.11, 0.06), 0xc9ccd2);
  k.part(new BoxGeometry(0.05, 0.03, 0.05).translate(0, -0.015, 0), 0x2b2e36); // the slewing ring
  const g = k.build(); g.computeVertexNormals(); return g;
}
function cableGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new CylinderGeometry(0.006, 0.006, 1, 4).translate(0, -0.5, 0), 0x2b2e36);
  const g = k.build(); g.computeVertexNormals(); return g;
}
function hookGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.05, 0.04, 0.05).translate(0, -0.02, 0), 0x2b2e36);
  k.part(new BoxGeometry(0.06, 0.012, 0.03).translate(0, -0.05, 0), CRANE_YELLOW); // a load on the hook
  const g = k.build(); g.computeVertexNormals(); return g;
}

const UP = new Vector3(0, 1, 0), V = new Vector3(), P = new Vector3(), Q = new Quaternion(), S = new Vector3(1, 1, 1), L = new Matrix4(), M = new Matrix4();

export class AmbientView {
  readonly group = new Group();
  /** sources and cranes drawn last frame, the last frame's cost in ms, for the perf readout */
  sources = 0; cranes = 0; lastMs = 0;
  private perChunk = new Map<string, { sources: Source[]; cranes: Crane[] }>();
  private craneState = new Map<string, CraneState>();
  private smoke: Mesh; private sP: Float32Array; private sO: Float32Array; private sS: Float32Array; private sI: Float32Array; private sGeo: InstancedBufferGeometry;
  private jib: InstancedMesh; private cable: InstancedMesh; private hook: InstancedMesh;
  private laidAt = 0; private laidFrom = new Vector3(1e9, 0, 0); private laidHour = -1; private dirty = true;
  private last = performance.now(); private frames = 0;
  private col = new Color();

  constructor() {
    const n = MAX_SOURCES * 8;
    this.sGeo = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(1, 1);
    this.sGeo.index = plane.index; this.sGeo.setAttribute('position', plane.getAttribute('position')); this.sGeo.setAttribute('uv', plane.getAttribute('uv'));
    this.sP = new Float32Array(n * 3); this.sO = new Float32Array(n * 4); this.sS = new Float32Array(n * 4); this.sI = new Float32Array(n * 4);
    this.sGeo.setAttribute('aP', new InstancedBufferAttribute(this.sP, 3).setUsage(DynamicDrawUsage));
    this.sGeo.setAttribute('aO', new InstancedBufferAttribute(this.sO, 4).setUsage(DynamicDrawUsage));
    this.sGeo.setAttribute('aS', new InstancedBufferAttribute(this.sS, 4).setUsage(DynamicDrawUsage));
    this.sGeo.setAttribute('aI', new InstancedBufferAttribute(this.sI, 4).setUsage(DynamicDrawUsage));
    this.sGeo.instanceCount = 0;
    const mat = new ShaderMaterial({
      vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG, transparent: true, depthWrite: false, side: DoubleSide, blending: NormalBlending,
      uniforms: { uTime: sceneUniforms.uTime, uNight: sceneUniforms.uNight, uWind: { value: WIND } },
    });
    this.smoke = new Mesh(this.sGeo, mat);
    this.smoke.frustumCulled = false; this.smoke.renderOrder = 10; this.smoke.visible = false;
    this.group.add(this.smoke);
    const vm = vehicleMaterial();
    this.jib = new InstancedMesh(jibGeometry(), vm, MAX_CRANES);
    this.cable = new InstancedMesh(cableGeometry(), vm, MAX_CRANES);
    this.hook = new InstancedMesh(hookGeometry(), vm, MAX_CRANES);
    for (const m of [this.jib, this.cable, this.hook]) { m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = false; this.group.add(m); }
    for (let i = 0; i < MAX_CRANES; i++) { this.jib.setColorAt(i, this.col.setHex(0xffffff)); this.cable.setColorAt(i, this.col.setHex(0xffffff)); this.hook.setColorAt(i, this.col.setHex(0xffffff)); }
  }

  /** One chunk's buildings were (re)placed: keep what smokes and what slews among them. */
  setChunk(key: string, items: { key: string; matrix: Matrix4; color?: Color }[]) {
    const sources: Source[] = [], cranes: Crane[] = [];
    for (const it of items) {
      const f = featuresOf(it.key);
      if (!f.stacks.length && !f.masts.length) continue;
      const e = it.matrix.elements, ox = e[12], oz = e[14];
      for (const s of f.stacks) {
        V.set(s.x, s.y, s.z).applyMatrix4(it.matrix);
        sources.push({ x: V.x, y: V.y, z: V.z, r: s.r * it.matrix.getMaxScaleOnAxis(), kind: s.kind, seed: hash2(Math.floor(V.x * 10) + s.kind * 3, Math.floor(V.z * 10) + Math.floor(s.y * 7)) });
      }
      for (const m of f.masts) {
        const top = new Vector3(m.x, m.y + m.h, m.z).applyMatrix4(it.matrix);
        cranes.push({ key: `${Math.round(ox * 4)},${Math.round(oz * 4)},${Math.round(m.x * 10)},${Math.round(m.z * 10)}`, matrix: it.matrix, top, h: m.h, seed: hash2(Math.floor(ox * 3) + 11, Math.floor(oz * 3) + 5), colour: it.color?.getHex() ?? 0xffffff });
      }
    }
    if (sources.length || cranes.length) this.perChunk.set(key, { sources, cranes }); else this.perChunk.delete(key);
    this.dirty = true;
  }
  clear(key: string) { if (this.perChunk.delete(key)) this.dirty = true; }

  /** How hard a source smokes at this hour: works by day, hearths on dark evenings and mornings, the camp fire at night. */
  private strength(s: Source, hour: number, night: number): number {
    const h = s.seed;
    if (s.kind === 0) { const from = 5.5 + 2 * h, to = 18.5 + 2.5 * hash2(h * 97, 3); return hour >= from && hour < to ? 0.8 + 0.4 * hash2(h * 31, 7) : 0; }
    if (s.kind === 1) { if (h > 0.45) return 0; const eve = hour >= 16.5 + 2 * h && hour < 22.5 + 1.5 * hash2(h * 53, 1), morn = hour >= 6 + h && hour < 8.5; return eve || morn ? 0.55 : 0; }
    return night > 0.25 ? 0.9 : 0;
  }

  /** Lay the smoke out again: the nearest sources to the camera, their puffs on their own clocks, their strength by the hour. */
  private lay(cam: Camera) {
    const hour = sceneUniforms.uHour.value, night = sceneUniforms.uNight.value;
    const range = RANGE * (motion.level === 1 ? 0.7 : 1), r2 = range * range, cap = motion.level === 1 ? MAX_SOURCES / 2 : MAX_SOURCES;
    const near: { s: Source; d: number; k: number }[] = [];
    for (const c of this.perChunk.values()) for (const s of c.sources) {
      const d = cam.position.distanceToSquared(V.set(s.x, s.y, s.z));
      if (d > r2) continue;
      const k = this.strength(s, hour, night);
      if (k > 0) near.push({ s, d, k });
    }
    near.sort((a, b) => a.d - b.d);
    let n = 0;
    for (const { s, k } of near.slice(0, cap)) {
      const puffs = s.kind === 0 ? 8 : PUFFS;
      for (let i = 0; i < puffs; i++) {
        const a = hash2(s.seed * 1000 + i * 7, i * 3 + 1), b = hash2(i * 11 + 5, s.seed * 777 + i);
        this.sP.set([s.x, s.y, s.z], n * 3);
        this.sO.set([s.r, s.kind, 0, 0], n * 4);
        this.sS.set([hash2(s.seed * 313 + i, i * 17 + 3), s.r * (3 + 2.5 * b) * (s.kind === 0 ? 1.4 : 1), (s.kind === 0 ? 4 : 3) + 3 * a, 0], n * 4);
        this.sI.set([k, s.kind === 0 ? 0.8 : s.kind === 1 ? 0.45 : 0.3, 0, 0], n * 4);
        n++;
      }
    }
    this.sGeo.instanceCount = n;
    this.smoke.visible = n > 0;
    for (const key of ['aP', 'aO', 'aS', 'aI']) (this.sGeo.getAttribute(key) as InstancedBufferAttribute).needsUpdate = true;
    this.sources = near.length;
  }

  private stateOf(c: Crane, now: number): CraneState {
    let st = this.craneState.get(c.key);
    if (!st) {
      const h = (k: number) => hash2(c.seed * 1000 + k * 13, k * 7 + 1);
      st = { yaw: h(1) * Math.PI * 2, yawTo: h(1) * Math.PI * 2, trolley: 0.2 + 0.25 * h(2), trolleyTo: 0.2 + 0.25 * h(2), hook: 0.3, hookTo: 0.3, nextAt: now + h(3) * 8, n: 0 };
      this.craneState.set(c.key, st);
    }
    return st;
  }

  frame(cams: readonly Camera[], visible = true) {
    const t0 = performance.now();
    this.frames++;
    const dt = Math.min(0.1, (t0 - this.last) / 1000);
    this.last = t0;
    motion.judge(t0, dt);
    if (!visible || !this.perChunk.size || !cams.length) { this.group.visible = false; this.sources = 0; this.cranes = 0; return; }
    this.group.visible = true;
    const cam = cams[0];
    // the smoke: laid out again when the camera has moved a few tiles, the hour has turned, a chunk came or went, or two seconds passed
    const hourStep = Math.floor(sceneUniforms.uHour.value * 4);
    if (motion.level > 0 && (this.dirty || hourStep !== this.laidHour || t0 - this.laidAt > 2000 || cam.position.distanceToSquared(this.laidFrom) > 36)) {
      this.lay(cam);
      this.laidAt = t0; this.laidFrom.copy(cam.position); this.laidHour = hourStep; this.dirty = false;
    }
    // the cranes: a few matrix writes each, every frame (every other at level 1, none when frozen)
    if (motion.level === 0 || (motion.level === 1 && (this.frames & 1))) { this.lastMs = performance.now() - t0; return; }
    const step = motion.level === 1 ? dt * 2 : dt, r2 = CRANE_RANGE * CRANE_RANGE, now = t0 / 1000;
    let n = 0;
    for (const c of this.perChunk.values()) for (const cr of c.cranes) {
      if (n >= MAX_CRANES || cam.position.distanceToSquared(cr.top) > r2) continue;
      const st = this.stateOf(cr, now);
      // slew toward the next spot, run the trolley out or in, lower or raise the hook; when all are there, dwell, then pick the next job
      let dy = st.yawTo - st.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      st.yaw += Math.max(-0.3 * step, Math.min(0.3 * step, dy));
      st.trolley += Math.max(-0.08 * step, Math.min(0.08 * step, st.trolleyTo - st.trolley));
      st.hook += Math.max(-0.12 * step, Math.min(0.12 * step, st.hookTo - st.hook));
      if (Math.abs(dy) < 0.01 && Math.abs(st.trolleyTo - st.trolley) < 0.005 && Math.abs(st.hookTo - st.hook) < 0.005 && now > st.nextAt) {
        st.n++;
        const h = (k: number) => hash2(cr.seed * 1000 + st.n * 29 + k * 13, k * 7 + st.n);
        st.yawTo = h(1) * Math.PI * 2; st.trolleyTo = 0.15 + 0.32 * h(2);
        st.hookTo = Math.min(cr.h - 0.2, 0.25 + 0.6 * h(3)); // never below the ground: the mast's height less the cab
        st.nextAt = now + 5 + 10 * h(4);
      }
      Q.setFromAxisAngle(UP, st.yaw); S.set(1, 1, 1);
      L.compose(P.set(0, 0, 0), Q, S);
      // the jib about the mast top (in the recipe's frame, from the placement's matrix)
      const localTop = V.copy(cr.top).applyMatrix4(M.copy(cr.matrix).invert());
      L.setPosition(localTop);
      M.multiplyMatrices(cr.matrix, L);
      this.jib.setMatrixAt(n, M); this.jib.setColorAt(n, this.col.setHex(cr.colour));
      // the cable hangs from the trolley, scaled to its length; the hook at its end
      const tx = localTop.x + Math.sin(st.yaw + Math.PI / 2) * st.trolley, tz = localTop.z + Math.cos(st.yaw + Math.PI / 2) * st.trolley;
      L.compose(P.set(tx, localTop.y - 0.05, tz), Q, S.set(1, st.hook, 1));
      M.multiplyMatrices(cr.matrix, L);
      this.cable.setMatrixAt(n, M); this.cable.setColorAt(n, this.col.setHex(cr.colour));
      L.compose(P.set(tx, localTop.y - 0.05 - st.hook, tz), Q, S.set(1, 1, 1));
      M.multiplyMatrices(cr.matrix, L);
      this.hook.setMatrixAt(n, M); this.hook.setColorAt(n, this.col.setHex(cr.colour));
      n++;
    }
    this.cranes = n;
    for (const m of [this.jib, this.cable, this.hook]) { m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    this.lastMs = performance.now() - t0;
  }
}
