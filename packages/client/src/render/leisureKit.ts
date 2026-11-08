import { Mesh, SphereGeometry, ShaderMaterial, BackSide, Color, Vector3, type Material } from 'three';
import { hash2, LifeStage } from '@msimcity/shared';
import { Kit, rng, pick, BRIGHT, WOOD, type Ctx, type Rng, type Body } from './interiors';
import { lookOf, type Look } from './people';

/**
 * The kit for the free-time places' first-person scenes (docs/leisure.md, render/leisureRooms.ts and render/rooms/*):
 * the outdoors (a sky dome with the town's skyline round the horizon, stars at night, sun and moonlight), the furniture
 * of parks and fairs (trees, benches, lamp posts), the people (visitors seeded per place, walkers on a loop, the
 * visitor's own household beside them) and a few helpers for lines and animals.
 *
 * Conventions (render/interiors.ts): metres, y up, the room's origin near the viewer. A body's yaw 0 faces +x and its
 * heading for a step (dx, dz) is atan2(-dz, dx); a View's yaw 0 looks toward -z (camera rotation.y).
 */

/** the sky over an outdoor scene: a gradient from the horizon to the zenith by the clock's sky colour, a skyline round the
 * horizon whose windows light up at night, stars once it is dark, and a hazy ground below the horizon */
const SKY_FRAG = /* glsl */ `
uniform vec3 uSky; uniform float uNight; uniform float uSeed; uniform float uCity; uniform vec3 uGround; varying vec3 vDir;
float h1(float n) { return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 17.0) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float az = atan(d.z, d.x) / 6.2831853 + 0.5;
  vec3 top = uSky * mix(1.15, 0.7, uNight);
  vec3 hor = mix(uSky * 1.45 + vec3(0.06, 0.05, 0.03), uSky * 1.1 + vec3(0.03, 0.02, 0.035), uNight);
  vec3 col = mix(hor, top, smoothstep(0.0, 0.9, el));
  // stars: a sparse field above the haze, twinkling a little, only once it is dark
  vec2 sc = floor(vec2(az * 900.0, el * 260.0));
  float star = step(0.9965, h2(sc)) * smoothstep(0.08, 0.3, el) * smoothstep(0.5, 0.9, uNight);
  col += vec3(0.9, 0.92, 1.0) * star * (0.5 + 0.5 * h2(sc + 7.0));
  // the far town: blocks by azimuth, lower and paler far away, nearer ones taller with a window grid
  float x = az * 160.0;
  float c1 = floor(x * 0.7), hf = uCity * (0.025 + 0.05 * h1(c1 + 40.0));
  if (el < hf) {
    col = mix(mix(hor, uSky * 0.8, 0.5), vec3(0.03, 0.035, 0.06), uNight);
    vec2 cell = floor(vec2(x * 5.0, el * 500.0));
    col += step(h2(cell + 3.0), 0.22 * uNight) * vec3(0.9, 0.7, 0.4) * 0.45;
  }
  float c2 = floor(x * 0.3), hn = uCity * (0.012 + 0.07 * h1(c2) * step(0.35, h1(c2 + 9.0)));
  if (el < hn) {
    vec3 b = mix(vec3(0.3, 0.31, 0.34) * (0.5 + uSky), vec3(0.014, 0.016, 0.028), uNight);
    vec2 g = vec2(x * 3.0, el * 300.0), cell = floor(g), f = fract(g);
    float win = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.7);
    float lit = step(h2(cell + c2 * 13.0), 0.1 + 0.45 * uNight);
    b += win * mix(vec3(0.07, 0.09, 0.12) + uSky * 0.18, vec3(1.3, 0.95, 0.55) * lit * (0.6 + 0.6 * h2(cell)), uNight);
    col = b;
  }
  if (el < 0.0) col = mix(uGround, hor, 0.45);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const SKY_VERT = 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
/** shared by every outdoor scene; never disposed (it is one small sphere) */
const DOME = new SphereGeometry(70, 32, 16);

export interface OutdoorOpts {
  /** the ground's colour (lawn by default) and how far it reaches, metres */
  ground?: number; size?: number;
  /** how tall the town's skyline stands round the horizon (1 = a town, 0 = open country, 2 = a city) */
  city?: number;
  /** the sun's direction into the scene (defaults to a high sun from the south-west) */
  sun?: [number, number, number];
}
/**
 * Make the kit an outdoor scene: a ground plane, the sky dome, daylight from above and moonlight at night. Lamps and
 * glows the scene adds itself; the kit's update sets the sky's colour and the night from the clock.
 */
export function outdoors(k: Kit, c: Ctx, o: OutdoorOpts = {}): ShaderMaterial {
  const size = o.size ?? 120, ground = o.ground ?? 0x6fa857;
  k.box(0, -0.1, 0, size, 0.1, size, ground);
  const mat = new ShaderMaterial({
    uniforms: {
      uSky: { value: new Color() }, uNight: { value: 0 }, uSeed: { value: hash2(c.place.venue?.seed ?? c.place.seed, 77) * 10 },
      uCity: { value: o.city ?? 1 }, uGround: { value: new Color(ground).multiplyScalar(0.8) },
    },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: BackSide, depthWrite: false,
  });
  k.windows.push(mat); // the kit sets uSky and uNight on every window material each frame, and disposes them
  const dome = new Mesh(DOME, mat);
  dome.renderOrder = -1;
  k.scene.add(dome);
  k.scene.background = null;
  k.daylight = 1;
  const [sx, sy, sz] = o.sun ?? [0.35, -0.85, 0.3];
  k.sunDir.set(sx, sy, sz).normalize();
  k.ambientNight = 0.12; k.moonlight = 0.3;
  return mat;
}

// ---- props ------------------------------------------------------------------------------------

const LEAF = [0x3e7a3a, 0x2f6a40, 0x5a8a3a, 0x4a7a5a, 0x6a9a3a];
/** a broadleaf tree: a trunk and a few overlapping crowns, s = scale (1 ≈ 7 m tall) */
export function tree(k: Kit, r: Rng, x: number, z: number, s = 1) {
  const leaf = pick(r, LEAF);
  k.cyl(x, 0, z, 0.16 * s, 2.4 * s, 0x5a4232);
  for (let i = 0; i < 4; i++) k.ball(x + (r() - 0.5) * 1.6 * s, (3.2 + r() * 2.2) * s, z + (r() - 0.5) * 1.6 * s, (1.4 + r() * 0.8) * s, (1.2 + r() * 0.6) * s, (1.4 + r() * 0.8) * s, leaf);
}
/** a conifer: stacked cones made of flattened balls */
export function pine(k: Kit, r: Rng, x: number, z: number, s = 1) {
  k.cyl(x, 0, z, 0.14 * s, 1.6 * s, 0x4a3426);
  for (let i = 0; i < 4; i++) k.ball(x, (1.8 + i * 1.3) * s, z, (1.6 - i * 0.35) * s, 0.9 * s, (1.6 - i * 0.35) * s, 0x2f5a3a);
}
/** a park bench facing yaw (radians about y; 0 faces +z) */
export function bench(k: Kit, x: number, z: number, ry: number, col = 0x6a4a2a) {
  k.group(x, z, ry, () => {
    k.box(0, 0.42, 0, 1.6, 0.05, 0.42, col); k.box(0, 0.5, -0.2, 1.6, 0.4, 0.05, col);
    for (const sx of [-0.7, 0.7]) { k.box(sx, 0, 0, 0.06, 0.42, 0.42, 0x2a2a2a); k.box(sx, 0.42, -0.2, 0.06, 0.5, 0.06, 0x2a2a2a); }
  });
}
/** a lamp post whose lantern glows at night */
export function lampPost(k: Kit, x: number, z: number, h = 3.6) {
  k.cyl(x, 0, z, 0.06, h, 0x2a2e36);
  k.box(x - 0.14, h - 0.05, z - 0.14, 0.28, 0.32, 0.28, 0x2a2e36);
  k.box(x - 0.11, h - 0.02, z - 0.11, 0.22, 0.26, 0.22, k.glow(0xffd28a, 1.4, 'night'));
}
/** a flower bed: a stone kerb and blooms */
export function flowerBed(k: Kit, r: Rng, x: number, z: number, rad = 1.2) {
  k.cyl(x, 0, z, rad, 0.18, 0xb8b0a0);
  k.cyl(x, 0.18, z, rad * 0.92, 0.04, 0x4a3a2a);
  for (let i = 0; i < 18; i++) {
    const a = r() * 6.28, d = Math.sqrt(r()) * rad * 0.85;
    k.ball(x + Math.cos(a) * d, 0.3, z + Math.sin(a) * d, 0.09, 0.08, 0.09, pick(r, [0xd94f4f, 0xe6b734, 0xf4f4f0, 0xd94fa0, 0x7a5ad9]));
  }
}
/** a thin bar from a to b (a kite's string, a rope, a rail): a box stretched along the line */
export function bar(k: Kit, a: Vector3, b: Vector3, w: number, col: number | Material) {
  const m = k.box(0, 0, 0, w, w, a.distanceTo(b), col);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.position.y -= w / 2;
  m.lookAt(b.x, b.y - w / 2, b.z);
  return m;
}
/** move a bar made by `bar` to run from a to b */
export function setBar(m: Mesh, a: Vector3, b: Vector3, w: number) {
  m.scale.set(w, w, a.distanceTo(b));
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.position.y -= w / 2;
  m.lookAt(b.x, b.y - w / 2, b.z);
}

// ---- people -----------------------------------------------------------------------------------

/** a visitor's look, seeded by the place, a slot and the hour block (the same faces at the same place for a while) */
export function visitor(c: Ctx, slot: number, stage: number = LifeStage.Adult, work = false): Look {
  const base = c.place.venue?.seed ?? c.place.seed;
  return lookOf(12_000_000 + Math.floor(hash2(base, slot * 7 + 3 + Math.floor(c.hour / 3)) * 1e6), 0, stage, work, c.evening);
}
/** a life stage for a crowd member: children, adults and retirees in the shares given */
export function crowdStage(r: Rng, child: number, retired: number): number {
  const u = r();
  return u < child ? LifeStage.Child : u < child + retired ? LifeStage.Retired : LifeStage.Adult;
}
/** someone who works there (a lifeguard, a ride operator): seeded by the place */
export function staff(c: Ctx, slot: number): Look {
  const base = c.place.venue?.seed ?? c.place.seed;
  return lookOf(13_000_000 + Math.floor(hash2(base, slot * 11 + 1) * 1e6), 0, LifeStage.Adult, true, false);
}
/**
 * The viewer's household out with them: members whose activity line is the viewer's (a family at the lido, children on a
 * picnic). Up to `max`, with their own looks, so the people beside you are your actual family.
 */
export function companions(c: Ctx, max = 3): { id: number; look: Look; child: boolean }[] {
  const act = c.info.activity;
  const out: { id: number; look: Look; child: boolean }[] = [];
  for (const m of c.info.life?.household.members ?? []) {
    if (out.length >= max || m.id === c.info.id || m.activity !== act) continue;
    const stage = m.age < 18 ? LifeStage.Child : m.age >= 66 ? LifeStage.Retired : LifeStage.Adult;
    out.push({ id: m.id, look: lookOf(m.id, 0, stage, false, c.evening), child: stage === LifeStage.Child });
  }
  return out;
}
/** a walker going round an ellipse (centre, radii) at `speed` m/s, starting at phase ph (radians); `dir` -1 goes the other way */
export function loopWalker(k: Kit, look: Look, cx: number, cz: number, rx: number, rz: number, speed: number, ph: number, dir = 1, y = 0): Body {
  const len = Math.PI * (rx + rz), w = (speed / len) * Math.PI * 2 * dir;
  const b: Body = { look, x: cx, y, z: cz, yaw: 0, swing: Math.min(0.75, speed * 0.45), pose: 0, ph,
    move: (t, bb) => {
      const a = ph + t * w;
      bb.x = cx + Math.cos(a) * rx; bb.z = cz + Math.sin(a) * rz;
      const dx = -Math.sin(a) * rx * w, dz = Math.cos(a) * rz * w;
      bb.yaw = Math.atan2(-dz, dx);
    } };
  k.bodies.push(b);
  return b;
}
/** a walker going to and fro along a line from a to b (turning at the ends), at `speed` m/s */
export function lineWalker(k: Kit, look: Look, ax: number, az: number, bx: number, bz: number, speed: number, ph: number, y = 0): Body {
  const len = Math.hypot(bx - ax, bz - az), period = (2 * len) / Math.max(0.1, speed);
  const b: Body = { look, x: ax, y, z: az, yaw: 0, swing: Math.min(0.75, speed * 0.45), pose: 0, ph,
    move: (t, bb) => {
      const u = (((t + ph * period) / period) % 1 + 1) % 1, f = u < 0.5 ? u * 2 : 2 - u * 2;
      bb.x = ax + (bx - ax) * f; bb.z = az + (bz - az) * f;
      const s = u < 0.5 ? 1 : -1;
      bb.yaw = Math.atan2(-(bz - az) * s, (bx - ax) * s);
    } };
  k.bodies.push(b);
  return b;
}
/** the yaw a View uses to look from `from` toward `to` (yaw 0 looks toward -z) */
export const viewYaw = (from: Vector3, to: Vector3) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
/** and the pitch */
export const viewPitch = (from: Vector3, to: Vector3) => Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z));
/** the eye height of the viewer standing (or sitting with hips at `seat`), in metres */
export const eyeStanding = (c: Ctx) => 1.6 * c.viewer.height;
export const eyeSitting = (c: Ctx, seat: number) => seat + 0.75 * c.viewer.height;

// ---- animals ----------------------------------------------------------------------------------

/** a duck (or a drake with a green head) floating at (x, y, z) facing yaw; returns its group to move */
export function duck(k: Kit, r: Rng, x: number, y: number, z: number, ry: number) {
  const drake = r() < 0.5, body = drake ? 0x8a7a6a : 0x8a6a4a, head = drake ? 0x1f6a3a : 0x7a5a3a;
  return k.group(x, z, ry, () => {
    k.ball(0, y + 0.1, 0, 0.2, 0.1, 0.13, body);
    k.ball(0.18, y + 0.24, 0, 0.07, 0.07, 0.065, head);
    k.box(0.24, y + 0.21, -0.025, 0.08, 0.025, 0.05, 0xe0a030);
    if (drake) k.box(0.13, y + 0.17, -0.07, 0.05, 0.03, 0.14, 0xf4f4f0);
    k.box(-0.2, y + 0.14, -0.04, 0.08, 0.04, 0.08, body);
  });
}
/** a seeded generator for scenes (re-exported for the room files) */
export { rng, pick, BRIGHT, WOOD };
