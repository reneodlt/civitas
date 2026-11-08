import { BoxGeometry, CylinderGeometry, SphereGeometry, Matrix4, Quaternion, Vector3, type BufferGeometry } from 'three';
import { hash2 } from '@msimcity/shared';
import { Kit } from './kit';
import type { PlaceFrame, Put } from './leisureAnims';

/**
 * The rigs: what moves at each kind of leisure place (docs/leisure.md section 9), for render/leisureAnims.ts. A rig
 * names the kind (and the design, where the designs differ in layout), gives the geometries of its props, how many
 * instances of each one place can need, how far from a camera it still moves, and `frame`, which places this frame's
 * instances in the recipe's own frame (x across the frontage, y up, z toward the road, in tiles, centred on the
 * footprint: the same frame the ops in buildings/attraction-models-*.ts use). The recipes keep whatever stands still
 * (a track, a pit lane with karts parked in it); the rigs draw what runs.
 */
export interface Rig {
  kind: number; design?: number;
  /** one instanced mesh per prop, shared by every place of this rig */
  props: BufferGeometry[];
  /** instances of each prop one place can need at most */
  perPlace: number[];
  /** tiles from a camera within which the place's parts move and draw */
  range: number;
  /** the props cast shadows (off for small parts) */
  shadows?: boolean;
  frame(p: PlaceFrame, put: Put): void;
}

const UP = new Vector3(0, 1, 0);
const pos = new Vector3(), q = new Quaternion(), one = new Vector3(1, 1, 1), local = new Matrix4();
/** a local matrix at (x, y, z) turned `yaw` about +y (0 faces +z, toward the road) */
function at(x: number, y: number, z: number, yaw: number, s = 1): Matrix4 {
  pos.set(x, y, z); q.setFromAxisAngle(UP, yaw); one.set(s, s, s);
  return local.compose(pos, q, one);
}
function finish(g: BufferGeometry): BufferGeometry { g.computeVertexNormals(); return g; }

// ---------------------------------------------------------------------------------------------- paths

/** A closed path sampled at equal arc lengths: position, height and heading (yaw about +y; 0 along +z) at each sample. */
export interface Path { n: number; x: Float32Array; y: Float32Array; z: Float32Array; yaw: Float32Array; length: number }

/**
 * A loop through corner points [x, z, y], each corner rounded with a fillet of about radius `r` (less where the legs
 * are short); collinear points only carry a change of height (a ramp up to a bridge). Direction is the order given.
 */
export function loopPath(pts: [number, number, number][], r: number, n = 256): Path {
  const dense: [number, number, number][] = [];
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    const p0 = pts[(i + m - 1) % m], p1 = pts[i], p2 = pts[(i + 1) % m];
    const d0x = p1[0] - p0[0], d0z = p1[1] - p0[1], d1x = p2[0] - p1[0], d1z = p2[1] - p1[1];
    const l0 = Math.hypot(d0x, d0z), l1 = Math.hypot(d1x, d1z);
    const cosA = (d0x * d1x + d0z * d1z) / (l0 * l1);
    if (cosA > 0.995) { dense.push(p1); continue; }
    const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const tl = Math.min(r * Math.tan(angle / 2), 0.45 * l0, 0.45 * l1);
    const ax = p1[0] - (d0x / l0) * tl, az = p1[1] - (d0z / l0) * tl, ay = p1[2] + (p0[2] - p1[2]) * (tl / l0);
    const bx = p1[0] + (d1x / l1) * tl, bz = p1[1] + (d1z / l1) * tl, by = p1[2] + (p2[2] - p1[2]) * (tl / l1);
    for (let k = 0; k <= 6; k++) {
      const u = k / 6, w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u;
      dense.push([w0 * ax + w1 * p1[0] + w2 * bx, w0 * az + w1 * p1[1] + w2 * bz, ay + (by - ay) * u]);
    }
  }
  // cumulative length round the closed loop
  const dn = dense.length, cum = new Float64Array(dn + 1);
  for (let i = 0; i < dn; i++) {
    const a = dense[i], b = dense[(i + 1) % dn];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const length = cum[dn];
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), yaw = new Float32Array(n);
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * length;
    while (seg < dn - 1 && cum[seg + 1] < s) seg++;
    const a = dense[seg], b = dense[(seg + 1) % dn], u = (s - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]);
    x[k] = a[0] + (b[0] - a[0]) * u; z[k] = a[1] + (b[1] - a[1]) * u; y[k] = a[2] + (b[2] - a[2]) * u;
    yaw[k] = Math.atan2(b[0] - a[0], b[1] - a[1]);
  }
  return { n, x, y, z, yaw, length };
}
/** The point `u` (0-1) of the way round a path, with a sideways offset (tiles, to the right of travel). */
export function along(p: Path, u: number, side = 0, out: { x: number; y: number; z: number; yaw: number }) {
  const f = ((u % 1) + 1) % 1 * p.n, i = Math.floor(f) % p.n, j = (i + 1) % p.n, t = f - Math.floor(f);
  let dy = p.yaw[j] - p.yaw[i];
  if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
  const yaw = p.yaw[i] + dy * t;
  out.x = p.x[i] + (p.x[j] - p.x[i]) * t + Math.cos(yaw) * side;
  out.y = p.y[i] + (p.y[j] - p.y[i]) * t;
  out.z = p.z[i] + (p.z[j] - p.z[i]) * t - Math.sin(yaw) * side;
  out.yaw = yaw;
  return out;
}
const sample = { x: 0, y: 0, z: 0, yaw: 0 };

// ---------------------------------------------------------------------------------------------- go-karts (kind 229)

/** a kart facing +z: a low body (white, so it takes the instance's colour), four dark wheels, a seat back and a helmeted driver */
function kartGeometry(): BufferGeometry {
  const k = new Kit(), DARK = 0x2a2d33, TYRE = 0x1a1a1a;
  k.part(new BoxGeometry(0.044, 0.012, 0.072).translate(0, 0.016, 0.004), 0xffffff);
  k.part(new BoxGeometry(0.03, 0.008, 0.02).translate(0, 0.014, 0.045), 0xffffff); // the nose
  k.part(new BoxGeometry(0.054, 0.004, 0.014).translate(0, 0.012, -0.04), 0xffffff); // the rear bumper
  k.part(new BoxGeometry(0.03, 0.022, 0.006).translate(0, 0.03, -0.022), DARK); // the seat back
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.part(new BoxGeometry(0.012, 0.018, 0.018).translate(sx * 0.03, 0.009, sz * 0.028), TYRE);
  k.part(new SphereGeometry(0.011, 6, 5).translate(0, 0.036, -0.012), 0xffffff); // the driver's helmet
  return finish(k.build());
}
const KART_COLOURS = [0xd94f4f, 0xe6b734, 0x2f8fd6, 0x4f9a5c, 0xf2f2ee, 0xe0662e, 0x7a5ad9, 0x2fbfa0];
/** karts out on a track at most, and the speed they run at (tiles a second) */
const MAX_KARTS = 8, KART_SPEED = 0.95;
/** the kart's wheels sit on the circuit (the recipe's asphalt tops out at 0.018) */
const KART_Y = 0.018, BRIDGE_Y = 0.124;

/**
 * A kart track: `n` karts run round `path`, each with its own lane, pace and colour. How many run follows the crowd
 * (the activity eased from the guest count), so an empty track stands quiet with its karts parked in the pit, the first
 * few guests put a couple out, and a full house runs eight.
 */
function kartRig(design: number, path: Path): Rig {
  return {
    kind: 229, design, props: [kartGeometry()], perPlace: [MAX_KARTS], range: 110,
    frame(p: PlaceFrame, put: Put) {
      let n = Math.min(MAX_KARTS, Math.round(p.act * 10));
      if (p.level === 1) n = Math.min(n, 4);
      const base = Math.floor(p.seed * 8);
      for (let i = 0; i < n; i++) {
        const h = hash2(p.seed * 997 + i * 13, i * 7 + 1), h2 = hash2(i * 29 + 3, p.seed * 613 + 5);
        const v = KART_SPEED * (0.9 + 0.2 * h2);
        const u = h + (p.t * v) / path.length;
        along(path, u, (h2 - 0.5) * 0.05, sample);
        put(0, at(sample.x, sample.y, sample.z, sample.yaw), KART_COLOURS[(base + i) % KART_COLOURS.length]);
      }
    },
  };
}
/** the twisting circuit (design 0): a loop with a tongue pushed in from the back */
const KART_LOOP = loopPath([
  [-1.2, 0.45, KART_Y], [1.2, 0.45, KART_Y], [1.2, -0.78, KART_Y], [0.3, -0.78, KART_Y],
  [0.3, 0.05, KART_Y], [-0.3, 0.05, KART_Y], [-0.3, -0.78, KART_Y], [-1.2, -0.78, KART_Y],
], 0.1);
/** the figure of eight (design 1): the north-south leg climbs over the east-west leg on its bridge */
const KART_EIGHT = loopPath([
  [0, 0.5, KART_Y], [0, 0.3, KART_Y], [0, 0.03, BRIDGE_Y], [0, -0.23, BRIDGE_Y], [0, -0.5, KART_Y], [0, -0.8, KART_Y],
  [-1.2, -0.8, KART_Y], [-1.2, -0.1, KART_Y], [1.2, -0.1, KART_Y], [1.2, 0.5, KART_Y],
], 0.1);

// ---------------------------------------------------------------------------------------------- funfair (kind 250)

const Z_AXIS = new Vector3(0, 0, 1), X_AXIS = new Vector3(1, 0, 0), q2 = new Quaternion();
/** a local matrix with a roll about the facing axis (a chair swung out on its chain) or a pitch (a log nosing down a chute) */
function atTilted(x: number, y: number, z: number, yaw: number, roll: number, pitch = 0): Matrix4 {
  pos.set(x, y, z); one.set(1, 1, 1);
  q.setFromAxisAngle(UP, yaw);
  if (roll) q.multiply(q2.setFromAxisAngle(Z_AXIS, roll));
  if (pitch) q.multiply(q2.setFromAxisAngle(X_AXIS, pitch));
  return local.compose(pos, q, one);
}
/** heading along the tangent of a ring round (cx, cz) at angle `a` (the recipes' convention: x = cx + r sin a, z = cz + r cos a) */
const ringYaw = (a: number) => Math.atan2(Math.cos(a), -Math.sin(a));
/** a place's memory in a rig (a ride's spin, a car's own clock), by its seed */
function memory(store: Map<number, Float32Array>, seed: number, n: number): Float32Array {
  let m = store.get(seed);
  if (!m) { m = new Float32Array(n); store.set(seed, m); }
  return m;
}
/** a ride's speed, eased toward running while the fair is open and stopping when it shuts (as the wheel winds down) */
function spinOf(m: Float32Array, p: PlaceFrame, ramp = 6): number {
  const target = p.open ? 1 : 0;
  m[0] += Math.max(-p.dt / ramp, Math.min(p.dt / ramp, target - m[0]));
  return m[0];
}

/** the recipe's carousel, dodgems and helter-skelter centres (buildings/attraction-models-indoor.ts) */
const CX = -0.85, CZ = 0.78, SX = 1.06, SZ = 0.86, DX = 1.11, DZ = -0.94;
const HORSE_COLOURS = [0xffffff, 0xf2e4c9, 0x8a5a32, 0xffffff, 0x3a3e49, 0xe8c070];
const CAR_COLOURS = [0xd94f4f, 0xe6b734, 0x4f9a5c, 0x2f8fd6, 0xe0662e];
const MAT_COLOURS = [0xe6b734, 0xe0662e];

/** a carousel horse on its pole, facing +z along the platform's rim; the pole's ends hide in the platform and the roof as it bobs */
function horseGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new CylinderGeometry(0.005, 0.005, 0.34, 5).translate(0, 0.215, 0), 0xe8c070);
  k.part(new BoxGeometry(0.032, 0.045, 0.1).translate(0, 0.1725, 0), 0xffffff);
  k.part(new BoxGeometry(0.028, 0.05, 0.03).translate(0, 0.205, 0.05), 0xffffff);
  k.part(new BoxGeometry(0.01, 0.012, 0.02).translate(0, 0.19, -0.058), 0x5a4a3a); // the tail
  return finish(k.build());
}
/** a dodgem: a bumper rim round a coloured body, a driver, the pole up to the roof; the floor is local y 0 */
function dodgemGeometry(): BufferGeometry {
  const k = new Kit(), DARK = 0x2a2d33;
  k.part(new BoxGeometry(0.1, 0.012, 0.14).translate(0, 0.006, 0), DARK);
  k.part(new BoxGeometry(0.086, 0.034, 0.124).translate(0, 0.029, 0), 0xffffff);
  k.part(new BoxGeometry(0.06, 0.02, 0.01).translate(0, 0.055, -0.03), DARK); // the seat back
  k.part(new SphereGeometry(0.011, 6, 5).translate(0, 0.06, -0.01), 0xf2c8a0); // the driver
  k.part(new CylinderGeometry(0.004, 0.004, 0.22, 4).translate(0, 0.15, -0.05), 0xb8bcc4);
  return finish(k.build());
}
/** a rider on a mat, sliding; the slide's surface is local y 0 */
function matGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.06, 0.008, 0.07).translate(0, 0.004, 0), 0xffffff);
  k.part(new BoxGeometry(0.03, 0.04, 0.03).translate(0, 0.028, -0.01), 0x2f8fd6);
  k.part(new SphereGeometry(0.012, 6, 5).translate(0, 0.058, -0.01), 0xf2c8a0);
  return finish(k.build());
}
const CAROUSEL_PERIOD = 12, DODGEM_SPEED = 0.35, SLIDE_CYCLE = 9, SLIDE_TIME = 6;

/** the first funfair: the carousel turns, the dodgems drive about under their roof, riders come down the helter-skelter */
function funfairRig0(): Rig {
  const store = new Map<number, Float32Array>();
  return {
    kind: 250, design: 0, props: [horseGeometry(), dodgemGeometry(), matGeometry()], perPlace: [6, 5, 2], range: 110,
    frame(p: PlaceFrame, put: Put) {
      const m = memory(store, p.seed, 2 + 5), spin = spinOf(m, p);
      // the carousel: six horses round the rim, each bobbing on its pole, the platform turning a revolution in CAROUSEL_PERIOD
      m[1] += (spin * p.dt) / CAROUSEL_PERIOD;
      for (let i = 0; i < 6; i++) {
        const a = (m[1] + i / 6) * Math.PI * 2, bob = 0.02 * Math.sin(m[1] * Math.PI * 2 * 3 + (i * Math.PI) / 3) * spin;
        put(0, at(CX + 0.28 * Math.sin(a), bob + (i % 2 ? 0.02 : -0.02) * (1 - spin), CZ + 0.28 * Math.cos(a), ringYaw(a)), HORSE_COLOURS[i]);
      }
      // the dodgems: each car wanders its own Lissajous figure over the floor, driving only while the crowd fills it
      const n = Math.min(5, Math.round(p.act * 6));
      for (let i = 0; i < 5; i++) {
        if (i < n && p.level > 0) m[2 + i] += p.dt * DODGEM_SPEED * (0.85 + 0.3 * hash2(i * 7 + 1, p.seed * 331));
        const t = m[2 + i], f1 = 0.7 + 0.25 * hash2(i, p.seed * 101), f2 = 0.45 + 0.3 * hash2(i * 3 + 2, p.seed * 211);
        const ph1 = hash2(i * 5, p.seed * 577) * 6.28, ph2 = hash2(i * 11 + 4, p.seed * 733) * 6.28;
        const x = DX + 0.2 * Math.sin(f1 * t + ph1), z = DZ + 0.36 * Math.sin(f2 * t + ph2);
        const dx = 0.2 * f1 * Math.cos(f1 * t + ph1), dz = 0.36 * f2 * Math.cos(f2 * t + ph2);
        put(1, at(x, 0.045, z, Math.atan2(dx, dz)), CAR_COLOURS[i]);
      }
      // the helter-skelter: riders every few seconds while people are about, following the slide's spiral down
      const riders = p.act > 0.6 ? 2 : p.act > 0.12 ? 1 : 0;
      for (let j = 0; j < riders; j++) {
        const u = (((p.t / SLIDE_CYCLE + j * 0.5) % 1) * SLIDE_CYCLE) / SLIDE_TIME;
        if (u >= 1) continue;
        const y = 0.9 - 0.72 * u, r = (y > 0.18 ? 0.13 - (0.03 * (y - 0.18)) / 0.8 : 0.16) + 0.05, a = ((30 + u * 550) * Math.PI) / 180;
        put(2, at(SX + r * Math.sin(a), y + 0.008, SZ + r * Math.cos(a), ringYaw(a)), MAT_COLOURS[j]);
      }
    },
  };
}

/** the boardwalk fair's chair swing tower, teacups and log flume (buildings/attraction-models-indoor.ts) */
const SWX = -0.95, SWZ = 0.08, TCX = 0.68, TCZ = 0.12, FLX = 1.22;
const CHAIR_COLOURS = [0xd94f4f, 0xe6b734, 0x4f9a5c, 0x2f8fd6];
const CUP_COLOURS = [0xf4a6c8, 0x8ac8ff, 0xb8e6a0, 0xfff1b8, 0xd8b8f0];
/** a chair on its chain, hung from local y 0 (the canopy), facing +z */
function chairGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new CylinderGeometry(0.003, 0.003, 0.27, 3).translate(0, -0.135, 0), 0xb8bcc4);
  k.part(new BoxGeometry(0.045, 0.035, 0.045).translate(0, -0.2875, 0), 0xffffff);
  k.part(new SphereGeometry(0.011, 6, 5).translate(0, -0.255, 0), 0xf2c8a0); // the rider
  return finish(k.build());
}
/** a teacup on its saucer, a handle to show its spin; the ride's platform is local y 0 */
function teacupGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new CylinderGeometry(0.07, 0.07, 0.012, 14).translate(0, 0.006, 0), 0xf6f2ea);
  k.part(new CylinderGeometry(0.06, 0.04, 0.06, 12).translate(0, 0.042, 0), 0xffffff);
  k.part(new CylinderGeometry(0.05, 0.05, 0.003, 12).translate(0, 0.072, 0), 0x5a3a2a);
  k.part(new BoxGeometry(0.02, 0.016, 0.012).translate(0.068, 0.045, 0), 0xffffff);
  return finish(k.build());
}
/** a log with two riders, facing +z; its base is local y 0 */
function logGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.08, 0.04, 0.16).translate(0, 0.02, 0), 0x7a4a2a);
  k.part(new BoxGeometry(0.03, 0.04, 0.03).translate(0, 0.06, 0.03), 0xf2c8a0);
  k.part(new BoxGeometry(0.03, 0.04, 0.03).translate(0, 0.06, -0.03), 0xf2c8a0);
  return finish(k.build());
}
const SWING_PERIOD = 10, CUP_PERIOD = 9, CUP_SPIN = 3.5, FLUME_CYCLE = 16;

/** the second funfair: the chairs swing out as the tower spins, the teacups turn and spin, logs ride the flume */
function funfairRig1(): Rig {
  const store = new Map<number, Float32Array>();
  return {
    kind: 250, design: 1, props: [chairGeometry(), teacupGeometry(), logGeometry()], perPlace: [8, 5, 2], range: 110,
    frame(p: PlaceFrame, put: Put) {
      const m = memory(store, p.seed, 3), spin = spinOf(m, p, 8);
      // the chair swing: eight chairs hung from the canopy's rim, flung outward as it comes up to speed
      m[1] += (spin * p.dt) / SWING_PERIOD;
      const tilt = 0.55 * spin * spin;
      for (let i = 0; i < 8; i++) {
        const a = (m[1] + (i + 0.5) / 8) * Math.PI * 2;
        put(0, atTilted(SWX + 0.32 * Math.sin(a), 0.72, SWZ + 0.32 * Math.cos(a), ringYaw(a), -tilt), CHAIR_COLOURS[i % 4]);
      }
      // the teacups: the platform turns one way, each cup spins on its saucer its own way
      m[2] += (spin * p.dt) / CUP_PERIOD;
      for (let i = 0; i < 5; i++) {
        const a = (m[2] + i / 5) * Math.PI * 2, own = (m[2] * CUP_PERIOD) / CUP_SPIN * (i % 2 ? 1 : -1) * (0.8 + 0.4 * hash2(i, p.seed * 41));
        put(1, at(TCX + 0.2 * Math.sin(a), 0.06, TCZ + 0.2 * Math.cos(a), own * Math.PI * 2), CUP_COLOURS[i]);
      }
      // the log flume: a log leaves the station, floats the trough, drops the chute, crosses the splash pool and is lifted back unseen
      if (p.open || spin > 0.02) for (let j = 0; j < 2; j++) {
        const u = ((p.t / FLUME_CYCLE + j * 0.5) % 1) * FLUME_CYCLE;
        let z: number, y: number, pitch = 0;
        if (u < 7) { z = -1.25 + (1.35 * u) / 7; y = 0.474; }
        else if (u < 8.2) { const v = (u - 7) / 1.2; z = 0.1 + 0.4 * v; y = 0.474 - 0.382 * v; pitch = 0.75; }
        else if (u < 11) { const v = (u - 8.2) / 2.8; z = 0.5 + 0.34 * v; y = 0.092; }
        else continue;
        put(2, atTilted(FLX, y, z, 0, 0, pitch));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- adventure playground (kind 217, design 0)

/** a swing seat on two chains, hung from local y 0 (the top bar, which runs along x); it swings about x */
function swingGeometry(): BufferGeometry {
  const k = new Kit();
  for (const sx of [-1, 1]) k.part(new BoxGeometry(0.004, 0.13, 0.004).translate(sx * 0.022, -0.065, 0), 0xb8bcc4);
  k.part(new BoxGeometry(0.054, 0.01, 0.026).translate(0, -0.134, 0), 0xffffff);
  k.part(new BoxGeometry(0.022, 0.03, 0.02).translate(0, -0.114, -0.004), 0x2f8fd6); // a child on the seat
  k.part(new SphereGeometry(0.01, 6, 5).translate(0, -0.092, -0.004), 0xf2c8a0);
  return finish(k.build());
}
/** the roundabout's disc, post and handle bars; its base post stays in the recipe, local y 0 is the disc's underside */
function roundaboutGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new CylinderGeometry(0.09, 0.09, 0.02, 12).translate(0, 0.01, 0), 0xd94f4f);
  k.part(new CylinderGeometry(0.01, 0.01, 0.06, 6).translate(0, 0.05, 0), 0xe6b734);
  k.part(new BoxGeometry(0.15, 0.01, 0.01).translate(0, 0.065, 0), 0xe6b734);
  k.part(new BoxGeometry(0.01, 0.01, 0.15).translate(0, 0.065, 0), 0xe6b734);
  k.part(new BoxGeometry(0.02, 0.03, 0.02).translate(0.055, 0.035, 0), 0x4f9a5c); // a child riding it
  k.part(new SphereGeometry(0.009, 6, 5).translate(0.055, 0.058, 0), 0xf2c8a0);
  return finish(k.build());
}
/** the zip wire's seat: a hanger from the wire (local y 0) and a disc, with or without a rider */
function zipGeometry(rider: boolean): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.004, 0.09, 0.004).translate(0, -0.045, 0), 0x2a2d33);
  k.part(new CylinderGeometry(0.025, 0.025, 0.01, 8).translate(0, -0.095, 0), 0xd94f4f);
  if (rider) { k.part(new BoxGeometry(0.02, 0.03, 0.02).translate(0, -0.075, 0.012), 0xe6b734); k.part(new SphereGeometry(0.01, 6, 5).translate(0, -0.052, 0.012), 0xf2c8a0); }
  return finish(k.build());
}
const SWING_X = [-0.29, -0.11], SWING_Y = 0.204, SWING_Z = -0.27, RB_X = -0.22, RB_Y = 0.03, RB_Z = 0.2;
const ZIP_X = 0.41, ZIP_Z0 = -0.38, ZIP_Y0 = 0.305, ZIP_Z1 = 0.3, ZIP_Y1 = 0.165, ZIP_CYCLE = 11, ZIP_RIDE = 3.2;

/** the adventure playground: the swings swing, the roundabout turns and the zip wire runs, as long as children are about */
function playgroundRig(): Rig {
  const store = new Map<number, Float32Array>();
  return {
    kind: 217, design: 0, props: [swingGeometry(), roundaboutGeometry(), zipGeometry(false), zipGeometry(true)], perPlace: [2, 1, 1, 1], range: 70,
    frame(p: PlaceFrame, put: Put) {
      const m = memory(store, p.seed, 3);
      // how much is going on: eases with the crowd, so the swings die down and the roundabout coasts to a stop as they leave
      const busy = Math.min(1, p.act * 3);
      m[0] += p.dt;
      for (let i = 0; i < 2; i++) {
        const ph = hash2(i * 3 + 1, p.seed * 97) * 6.28, amp = 0.55 * busy * (0.7 + 0.3 * hash2(i, p.seed * 11));
        put(0, atTilted(SWING_X[i], SWING_Y, SWING_Z, 0, 0, amp * Math.sin((m[0] * Math.PI * 2) / 2.3 + ph)), i ? 0x2f8fd6 : 0xe0662e);
      }
      m[1] += (p.dt * busy) / 5;
      put(1, at(RB_X, RB_Y, RB_Z, m[1] * Math.PI * 2));
      // the zip wire: a rider every ZIP_CYCLE seconds while it is busy, else the seat parked at the top post
      const u = (p.t % ZIP_CYCLE) / ZIP_RIDE;
      if (busy > 0.3 && u < 1) {
        const e = u * u * (3 - 2 * u) * 0.8 + u * 0.2; // gathers speed down the wire
        put(3, at(ZIP_X, ZIP_Y0 + (ZIP_Y1 - ZIP_Y0) * e, ZIP_Z0 + (ZIP_Z1 - ZIP_Z0) * e, 0));
      } else put(2, at(ZIP_X, ZIP_Y0 - 0.01, ZIP_Z0 + 0.05, 0));
    },
  };
}

// ---------------------------------------------------------------------------------------------- city farm (kind 251)

/** the farm animals, facing +z, standing on local y 0 (white parts take the instance's colour) */
function sheepGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.046, 0.048, 0.075).translate(0, 0.04, 0), 0xffffff);
  k.part(new BoxGeometry(0.028, 0.03, 0.026).translate(0, 0.055, 0.046), 0x2a2d33);
  return finish(k.build());
}
function pigGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.044, 0.04, 0.072).translate(0, 0.036, 0), 0xeba3a3);
  k.part(new BoxGeometry(0.026, 0.022, 0.018).translate(0, 0.035, 0.044), 0xd98a8a);
  return finish(k.build());
}
function goatGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.034, 0.042, 0.064).translate(0, 0.037, 0), 0xffffff);
  k.part(new BoxGeometry(0.024, 0.04, 0.022).translate(0, 0.066, 0.04), 0x8a6a4a);
  return finish(k.build());
}
function ponyGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.026, 0.05, 0.07).translate(0, 0.041, 0), 0x5a3a22);
  k.part(new BoxGeometry(0.04, 0.045, 0.1).translate(0, 0.0885, 0), 0x8a5a32);
  k.part(new BoxGeometry(0.028, 0.07, 0.03).translate(0, 0.125, 0.05), 0x8a5a32);
  k.part(new BoxGeometry(0.012, 0.05, 0.012).translate(0, 0.085, -0.054), 0x3a2a1a);
  return finish(k.build());
}
function henGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.018, 0.024, 0.024).translate(0, 0.014, 0), 0xffffff);
  k.part(new BoxGeometry(0.012, 0.014, 0.012).translate(0, 0.032, 0.01), 0xffffff);
  k.part(new BoxGeometry(0.004, 0.008, 0.008).translate(0, 0.042, 0.01), 0xd94f4f);
  return finish(k.build());
}
function duckGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.018, 0.016, 0.03).translate(0, 0.008, 0), 0xffffff);
  k.part(new BoxGeometry(0.012, 0.014, 0.012).translate(0, 0.022, 0.012), 0xffffff);
  k.part(new BoxGeometry(0.006, 0.004, 0.008).translate(0, 0.022, 0.022), 0xe6b734);
  return finish(k.build());
}
interface Pen { x0: number; x1: number; z0: number; z1: number }
/**
 * Where an animal stands at a moment: it walks from one spot in its pen to the next over the first part of each `period`,
 * then stands (hens peck, sheep graze), every spot drawn from its own seed. Returns the position and heading in `sample`.
 */
function wander(pen: Pen, seed: number, i: number, t: number, period: number, walk = 0.45) {
  const k = Math.floor(t / period), u = (t - k * period) / period;
  const spot = (n: number): [number, number] => [pen.x0 + (pen.x1 - pen.x0) * hash2(seed * 131 + i * 17, n * 7 + 3), pen.z0 + (pen.z1 - pen.z0) * hash2(n * 13 + 5, seed * 173 + i * 19)];
  const a = spot(k), b = spot(k + 1), w = u < walk ? (u / walk) * (u / walk) * (3 - 2 * (u / walk)) : 1;
  sample.x = a[0] + (b[0] - a[0]) * w; sample.z = a[1] + (b[1] - a[1]) * w; sample.y = 0;
  sample.yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
  return u < walk;
}
const FARM0 = { sheep: { x0: 0.36, x1: 0.9, z0: -0.9, z1: -0.36 }, pigs: { x0: 0.34, x1: 0.56, z0: 0.02, z1: 0.4 }, pony: { x0: 0.66, x1: 0.9, z0: 0.02, z1: 0.4 }, hens: { x0: -0.95, x1: -0.62, z0: -0.28, z1: 0.24 } };
const FARM1 = { goats: { x0: 0.36, x1: 0.9, z0: 0.08, z1: 0.56 }, hens: { x0: -0.75, x1: 0.3, z0: -0.3, z1: 0.38 } };
const POND = { x: 0.62, z: 0.72, r: 0.13 };
const SHEEP_COLOURS = [0xf1ede2, 0xe6e0d2, 0xf1ede2], GOAT_COLOURS = [0xffffff, 0xe8dcc8, 0x6a5a4a], HEN_COLOURS = [0xffffff, 0x9a5a2a, 0xf1ede2];

/** the city farm: sheep, pigs, a pony, goats and hens wander their pens by day and ducks paddle the pond; all stand still at night */
function farmRig(design: number): Rig {
  const store = new Map<number, Float32Array>();
  return {
    kind: 251, design, props: [sheepGeometry(), pigGeometry(), ponyGeometry(), goatGeometry(), henGeometry(), duckGeometry()], perPlace: [3, 2, 1, 3, 3, 2], range: 70,
    frame(p: PlaceFrame, put: Put) {
      const m = memory(store, p.seed, 1);
      if (p.open) m[0] += p.dt; // the animals' day: they move while the farm is open and sleep where they stand when it shuts
      const t = m[0] + p.seed * 500;
      if (design === 0) {
        for (let i = 0; i < 3; i++) { const walking = wander(FARM0.sheep, p.seed, i, t, 9 + i); put(0, at(sample.x, walking ? 0 : -0.002, sample.z, sample.yaw), SHEEP_COLOURS[i]); }
        for (let i = 0; i < 2; i++) { wander(FARM0.pigs, p.seed, 10 + i, t, 11 + i * 2); put(1, at(sample.x, 0, sample.z, sample.yaw)); }
        wander(FARM0.pony, p.seed, 20, t, 14, 0.35); put(2, at(sample.x, 0, sample.z, sample.yaw));
        for (let i = 0; i < 2; i++) { const walking = wander(FARM0.hens, p.seed, 30 + i, t, 4 + i, 0.5); put(4, at(sample.x, walking ? 0 : -0.004 * (0.5 + 0.5 * Math.sin(t * 9 + i)), sample.z, sample.yaw), HEN_COLOURS[i]); }
        for (let i = 0; i < 2; i++) {
          const a = (t / (16 + i * 5)) * Math.PI * 2 * (i ? -1 : 1) + i * 2, r = POND.r * (0.5 + 0.4 * i);
          put(5, at(POND.x + r * Math.sin(a), 0.028, POND.z + r * Math.cos(a), ringYaw(a) + (i ? Math.PI : 0)), i ? 0xe6c24a : 0xffffff);
        }
      } else {
        for (let i = 0; i < 3; i++) { wander(FARM1.goats, p.seed, i, t, 7 + i); put(3, at(sample.x, 0, sample.z, sample.yaw), GOAT_COLOURS[i]); }
        for (let i = 0; i < 3; i++) { const walking = wander(FARM1.hens, p.seed, 30 + i, t, 4 + i, 0.5); put(4, at(sample.x, 0.006 - (walking ? 0 : 0.004 * (0.5 + 0.5 * Math.sin(t * 9 + i))), sample.z, sample.yaw), HEN_COLOURS[i]); }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- people on the move (tennis 223, skate park 218, ice rink 225)

/** a small standing figure facing +z: legs, a coloured top, a head; feet at local y 0 */
function figureGeometry(top = 0xffffff, legs = 0x3a3e49, racket = false, board = false): BufferGeometry {
  const k = new Kit();
  if (board) k.part(new BoxGeometry(0.018, 0.005, 0.044).translate(0, 0.0025, 0), 0x5a3d26);
  const y0 = board ? 0.005 : 0;
  k.part(new BoxGeometry(0.018, 0.026, 0.014).translate(0, y0 + 0.013, 0), legs);
  k.part(new BoxGeometry(0.024, 0.028, 0.016).translate(0, y0 + 0.04, 0), top);
  k.part(new SphereGeometry(0.01, 6, 5).translate(0, y0 + 0.064, 0), 0xf2c8a0);
  if (racket) { k.part(new BoxGeometry(0.004, 0.03, 0.004).translate(0.018, y0 + 0.04, 0.004), 0x2a2d33); k.part(new BoxGeometry(0.016, 0.02, 0.004).translate(0.018, y0 + 0.064, 0.004), 0xd94f4f); }
  return finish(k.build());
}
function ballGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new SphereGeometry(0.007, 6, 4), 0xdfff4f);
  return finish(k.build());
}
const PLAYER_COLOURS = [0xffffff, 0x2f8fd6, 0xe0662e, 0xf2f2ee];
/** a tennis court: its centre, whether it runs along x, and the baseline and sideline half-lengths; players at either end, a ball between */
interface Court { cx: number; cz: number; alongX: boolean; half: number; side: number; y: number }
const TENNIS_COURTS: Court[][] = [
  [{ cx: -0.1, cz: 0, alongX: false, half: 0.36, side: 0.14, y: 0.022 }, { cx: 0.61, cz: 0, alongX: false, half: 0.36, side: 0.14, y: 0.022 }],
  [{ cx: 0.37, cz: -0.22, alongX: true, half: 0.37, side: 0.14, y: 0.016 }, { cx: 0.37, cz: 0.22, alongX: true, half: 0.37, side: 0.14, y: 0.016 }],
];
const RALLY = 1.3;
/** the tennis club: a rally on each court in play, the players shuffling along their baselines, the ball lobbed between them */
function tennisRig(design: number): Rig {
  const courts = TENNIS_COURTS[design];
  return {
    kind: 223, design, props: [figureGeometry(0xffffff, 0x3a3e49, true), ballGeometry()], perPlace: [4, 2], range: 70,
    frame(p: PlaceFrame, put: Put) {
      const inPlay = p.act > 0.5 ? 2 : p.act > 0.12 ? 1 : 0;
      for (let c = 0; c < inPlay; c++) {
        const ct = courts[c], t = p.t + c * 3.7, ph = hash2(c, p.seed * 53) * 6.28;
        const u = ((t / RALLY) % 2); // 0-1 the ball flies to the far end, 1-2 back
        const along = u < 1 ? -ct.half + 2 * ct.half * u : ct.half - 2 * ct.half * (u - 1);
        const arc = 0.09 * Math.sin((u % 1) * Math.PI);
        const sway = Math.sin(t * 1.1 + ph) * ct.side, sway2 = Math.sin(t * 0.9 + ph + 2) * ct.side;
        const place = (a: number, s: number, y: number, yaw: number, prop: number, colour?: number) =>
          put(prop, ct.alongX ? at(ct.cx + a, y, ct.cz + s, yaw) : at(ct.cx + s, y, ct.cz + a, yaw), colour);
        place(-ct.half - 0.03, sway, ct.y, ct.alongX ? Math.PI / 2 : 0, 0, PLAYER_COLOURS[(c * 2) % 4]);
        place(ct.half + 0.03, sway2, ct.y, ct.alongX ? -Math.PI / 2 : Math.PI, 0, PLAYER_COLOURS[(c * 2 + 1) % 4]);
        place(along, (u < 1 ? sway : sway2) * 0.6, ct.y + 0.03 + arc, 0, 1);
      }
    },
  };
}

/** the skate park: riders roll round the bowl and pump the half-pipe (design 0), or lap the pump track (design 1) */
function skateRig(design: number): Rig {
  return {
    kind: 218, design, props: [figureGeometry(0xffffff, 0x2f5a3c, false, true)], perPlace: [3], range: 70,
    frame(p: PlaceFrame, put: Put) {
      const n = Math.min(3, Math.round(p.act * 4));
      for (let i = 0; i < n; i++) {
        const t = p.t * (0.85 + 0.3 * hash2(i, p.seed * 71)) + hash2(i * 3, p.seed * 19) * 20, colour = PLAYER_COLOURS[(i + Math.floor(p.seed * 4)) % 4];
        if (design === 0 && i === 1) {
          // the half-pipe: back and forth along z between the quarter pipes, rising up each face
          const u = Math.sin(t * 1.6), z = -0.165 + 0.17 * u, y = 0.028 + 0.1 * Math.max(0, Math.abs(u) - 0.55) / 0.45, lean = 0.9 * u * Math.max(0, Math.abs(u) - 0.55) / 0.45;
          put(0, atTilted(0.26 + 0.05 * Math.sin(t * 0.7), y, z, u > 0 ? 0 : Math.PI, 0, -lean * (u > 0 ? 1 : -1)), colour);
        } else if (design === 0) {
          // round the bowl's rim, dipping through it
          const a = t * 1.1 * (i ? -1 : 1), r = 0.14 + 0.05 * Math.sin(t * 2.3), dip = 0.03 * (1 - r / 0.19);
          put(0, atTilted(-0.22 + r * Math.sin(a), 0.028 - dip, -0.17 + r * Math.cos(a), ringYaw(a) + (i ? Math.PI : 0), 0.35 * (i ? -1 : 1)), colour);
        } else {
          // laps of the pump track over its rollers
          const a = t * 1.2 + i * 2.1, r = 0.145, roll = Math.cos(a * 4) * 0.012;
          put(0, atTilted(0.24 + r * Math.cos(a), 0.028 + 0.025 + Math.max(0, roll), 0.24 + r * Math.sin(a), Math.atan2(-Math.sin(a), Math.cos(a)), -0.3), colour);
        }
      }
    },
  };
}

/** a rink: its centre, half-extents and ice height; skaters loop ellipses inside it */
interface Rink { cx: number; cz: number; hx: number; hz: number; y: number; max: number }
const RINKS: Rink[] = [{ cx: 0.48, cz: 0.65, hx: 0.36, hz: 0.21, y: 0.028, max: 3 }, { cx: 0.15, cz: -0.3, hx: 0.55, hz: 0.35, y: 0.03, max: 6 }];
const SKATER_COLOURS = [0xd94f4f, 0x2f8fd6, 0xffffff, 0xe6b734, 0x7a5ad9, 0x2fbfa0];
/** the ice rink: skaters glide loops over the open-air ice, leaning into the turns; more of them as the session fills */
function rinkRig(design: number): Rig {
  const rink = RINKS[design];
  return {
    kind: 225, design, props: [figureGeometry()], perPlace: [rink.max], range: 70,
    frame(p: PlaceFrame, put: Put) {
      const n = Math.min(rink.max, Math.round(p.act * rink.max * 1.3));
      for (let i = 0; i < n; i++) {
        const h = hash2(i * 7 + 2, p.seed * 61), h2 = hash2(i * 11 + 5, p.seed * 67);
        const ax = rink.hx * (0.45 + 0.5 * h), az = rink.hz * (0.45 + 0.5 * h2), w = (0.5 + 0.3 * h) * (i % 2 ? 1 : -1);
        const a = p.t * w + h2 * 6.28, cx = rink.cx + (h - 0.5) * (rink.hx - ax) * 1.6, cz = rink.cz + (h2 - 0.5) * (rink.hz - az) * 1.6;
        const x = cx + ax * Math.cos(a), z = cz + az * Math.sin(a), dx = -ax * Math.sin(a) * w, dz = az * Math.cos(a) * w;
        put(0, atTilted(x, rink.y, z, Math.atan2(dx, dz), 0.25 * Math.sign(w)), SKATER_COLOURS[i % SKATER_COLOURS.length]);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- nature reserve (kind 221): birds over the water

/** a bird in flight, wings up or down, facing +z */
function birdGeometry(up: boolean): BufferGeometry {
  const k = new Kit(), DARK = 0x3a3a3a;
  k.part(new BoxGeometry(0.008, 0.006, 0.024).translate(0, 0, 0), DARK);
  const tilt = up ? -0.6 : 0.5;
  k.part(new BoxGeometry(0.03, 0.003, 0.01).translate(0.015, 0, 0).rotateZ(tilt).translate(0.004, 0, 0), DARK);
  k.part(new BoxGeometry(0.03, 0.003, 0.01).translate(-0.015, 0, 0).rotateZ(-tilt).translate(-0.004, 0, 0), DARK);
  return finish(k.build());
}
const FLOCK = [{ x: -0.2, z: -0.3, a: 0.55, b: 0.35 }, { x: 0.2, z: -0.4, a: 0.5, b: 0.4 }];
/** birds wheel over the reserve's water by day, each on its own loop at its own height, wings beating a few times a second */
function reserveRig(design: number): Rig {
  const f = FLOCK[design];
  return {
    kind: 221, design, props: [birdGeometry(true), birdGeometry(false)], perPlace: [6, 6], range: 90,
    frame(p: PlaceFrame, put: Put) {
      if (!p.open) return;
      for (let i = 0; i < 6; i++) {
        const h = hash2(i * 5 + 1, p.seed * 83), h2 = hash2(i * 3 + 7, p.seed * 89);
        const w = (0.25 + 0.15 * h) * (i % 3 ? 1 : -1), a = p.t * w + h2 * 6.28, s = 0.7 + 0.5 * h;
        const x = f.x + f.a * s * Math.cos(a), z = f.z + f.b * s * Math.sin(a), y = 0.42 + 0.22 * h2 + 0.04 * Math.sin(p.t * 0.7 + i);
        const dx = -f.a * s * Math.sin(a) * w, dz = f.b * s * Math.cos(a) * w;
        const flap = ((p.t * (3 + 2 * h) + i) % 1) < 0.5 ? 0 : 1;
        put(flap, atTilted(x, y, z, Math.atan2(dx, dz), 0.3 * Math.sign(w)));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- observatory (kind 255): the dome tracks the sky

/** the lathe profile of a dome of radius r and height h (as buildings/attraction-models-indoor.ts draws it) */
function domeProfile(r: number, h: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * (Math.PI / 2); out.push(i === n ? 0 : r * Math.cos(a), h * Math.sin(a)); }
  return out;
}
const CHARCOAL = 0x2b2e36, SCOPE = 0x3a3e49;
/** the slit dome with its telescope, built from the same shapes the recipe used, about its own axis at local y 0 */
function domeGeometry(design: number): BufferGeometry {
  const k = new Kit();
  if (design === 0) {
    k.lathe(0, 0, 0, 0xe4e8ee, 16, CHARCOAL, 16, 1, 0, 0, 0, domeProfile(0.225, 0.22, 7));
    k.taper(0.045, 0.045, 0.04, 0.04, 0.18, 0.006, 0.06, 0.029, SCOPE, 0, 0.02, 0.098);
  } else {
    k.lathe(0, 0, 0, 0x6fae98, 14, CHARCOAL, 14, 1, 0, 0, 0, domeProfile(0.15, 0.14, 6));
    k.taper(0.035, 0.035, 0.03, 0.03, 0.13, 0.0045, 0.04, 0.0195, SCOPE, 0, 0.0156, 0.068);
  }
  return finish(k.build());
}
const DOMES = [{ x: -0.08, y: 0.377, z: -0.1 }, { x: -0.1, y: 0.782, z: -0.1 }];
/** the observatory: while it is open (the evening) the dome slews to a new part of the sky every minute or so */
function observatoryRig(design: number): Rig {
  const store = new Map<number, Float32Array>(), d = DOMES[design];
  return {
    kind: 255, design, props: [domeGeometry(design)], perPlace: [1], range: 120, shadows: true,
    frame(p: PlaceFrame, put: Put) {
      const m = memory(store, p.seed, 2); // [azimuth, open time]
      if (p.open) {
        m[1] += p.dt;
        const target = hash2(Math.floor(m[1] / 50) + 1, p.seed * 311) * Math.PI * 2;
        let dy = target - m[0];
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        m[0] += Math.max(-0.12 * p.dt, Math.min(0.12 * p.dt, dy));
      }
      put(0, at(d.x, d.y, d.z, m[0]));
    },
  };
}

// ---------------------------------------------------------------------------------------------- lido (kind 222): swimmers

/** a swimmer: a head and shoulders just above the water, the body under it; the surface is local y 0 */
function swimmerGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.028, 0.012, 0.05).translate(0, -0.006, -0.012), 0xffffff);
  k.part(new SphereGeometry(0.011, 6, 5).translate(0, 0.004, 0.018), 0xf2c8a0);
  k.part(new BoxGeometry(0.03, 0.006, 0.008).translate(0, 0.002, 0.03), 0xf2c8a0); // arms reaching forward
  return finish(k.build());
}
const SWIM_COLOURS = [0xd94f4f, 0x2f8fd6, 0xe6b734, 0x2fbfa0, 0xf4a6c8, 0x7a5ad9];
/** the lido: swimmers do lengths of the lane pool (design 0) or drift round the lagoon (design 1); more as the afternoon fills */
function lidoRig(design: number): Rig {
  return {
    kind: 222, design, props: [swimmerGeometry()], perPlace: [6], range: 70,
    frame(p: PlaceFrame, put: Put) {
      const n = Math.min(6, Math.round(p.act * 8));
      for (let i = 0; i < n; i++) {
        const h = hash2(i * 7 + 3, p.seed * 43), h2 = hash2(i * 5 + 1, p.seed * 47), t = p.t * (0.8 + 0.4 * h) + h2 * 30;
        if (design === 0) {
          // lengths along x in lane i, turning at each end
          const lane = -0.28 + (i - 2.5) * 0.13, u = (t * 0.09) % 2, x = u < 1 ? -0.6 + 1.2 * u : 0.6 - 1.2 * (u - 1);
          put(0, at(x, 0.046, lane, u < 1 ? Math.PI / 2 : -Math.PI / 2), SWIM_COLOURS[i]);
        } else {
          const a = t * 0.3 * (i % 2 ? 1 : -1), r = 0.14 + 0.16 * h;
          put(0, at(-0.1 + r * Math.cos(a), 0.031, -0.35 + r * 0.8 * Math.sin(a), Math.atan2(-Math.sin(a) * (i % 2 ? 1 : -1), Math.cos(a) * 0.8 * (i % 2 ? 1 : -1))), SWIM_COLOURS[i]);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- fishing lake (kind 220)

/** an angler sitting on a peg, facing +z over the water; the peg's top is local y 0 */
function anglerGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.03, 0.02, 0.03).translate(0, 0.01, 0), 0x3f6b4f); // a stool
  k.part(new BoxGeometry(0.026, 0.03, 0.018).translate(0, 0.035, -0.004), 0xffffff);
  k.part(new BoxGeometry(0.03, 0.012, 0.024).translate(0, 0.026, 0.016), 0x3a3e49); // legs out in front
  k.part(new SphereGeometry(0.01, 6, 5).translate(0, 0.06, -0.004), 0xf2c8a0);
  k.part(new CylinderGeometry(0.012, 0.012, 0.006, 8).translate(0, 0.07, -0.004), 0x5a6a3a); // a hat
  return finish(k.build());
}
/** a fish leaping, nose along +z */
function fishGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.01, 0.008, 0.028), 0xc9ccd2);
  k.part(new BoxGeometry(0.002, 0.012, 0.01).translate(0, 0, -0.018), 0xb0b4bb);
  return finish(k.build());
}
/** a splash ring on the water, scaled out over its moment */
function splashGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new CylinderGeometry(0.03, 0.03, 0.002, 12), 0xffffff);
  k.part(new CylinderGeometry(0.02, 0.02, 0.003, 12), 0x8fc8e8);
  return finish(k.build());
}
/** a rowing boat with its rower and oars, bow along +z; the waterline is local y 0 */
function boatGeometry(): BufferGeometry {
  const k = new Kit();
  k.taper(0.06, 0.16, 0.08, 0.2, 0.025, 0, -0.005, 0, 0xf4f4f0);
  k.part(new BoxGeometry(0.06, 0.006, 0.03).translate(0, 0.02, 0), 0xd94f4f); // the thwart
  k.part(new BoxGeometry(0.024, 0.03, 0.018).translate(0, 0.035, 0), 0x2f8fd6); // the rower, facing the stern
  k.part(new SphereGeometry(0.01, 6, 5).translate(0, 0.06, 0), 0xf2c8a0);
  for (const s of [-1, 1]) k.part(new BoxGeometry(0.1, 0.004, 0.006).translate(s * 0.07, 0.025, 0.01).rotateY(s * 0.4), 0x5a3d26); // the oars out
  return finish(k.build());
}
const PEGS0: [number, number][] = [[-0.2, -0.8], [0.8, -0.2], [0.55, -0.6], [0.05, 0.58], [0.3, 0.48], [-0.66, 0.33], [-0.74, -0.35]];
const PEGS1: [number, number][] = [[-0.6, -0.06], [-0.2, -0.08], [0.2, -0.06], [0.6, -0.08], [-0.5, -0.62], [0.0, -0.62], [0.5, -0.62]];
const LAKE0 = [[-0.2, -0.25, 0.55], [0.35, -0.2, 0.45], [0.05, 0.22, 0.36], [-0.45, 0.12, 0.3]];
const JUMP_EVERY = 5.5, JUMP_TIME = 0.8;
/** the fishing lake: anglers settle on the pegs as the day fills, fish leap now and then, and on the canal pond a boat is rowed up and down */
function fishingRig(design: number): Rig {
  const pegs = design === 0 ? PEGS0 : PEGS1, pegY = 0.036, toward: [number, number] = design === 0 ? [-0.05, -0.1] : [0, -0.32];
  return {
    kind: 220, design, props: [anglerGeometry(), fishGeometry(), splashGeometry(), boatGeometry()], perPlace: [7, 1, 1, 1], range: 70,
    frame(p: PlaceFrame, put: Put) {
      const n = Math.min(pegs.length, Math.round(p.act * 8)), order = Math.floor(p.seed * pegs.length);
      for (let i = 0; i < n; i++) {
        const [x, z] = pegs[(i + order) % pegs.length], tz = design === 0 ? toward[1] : z < -0.3 ? -0.2 : -0.5;
        put(0, at(x, pegY, z, Math.atan2(toward[0] - x, tz - z)), PLAYER_COLOURS[i % 4]);
      }
      // a fish leaps somewhere on the water every few seconds while the lake is open
      if (p.open) {
        const k = Math.floor(p.t / JUMP_EVERY), u = (p.t - k * JUMP_EVERY) / JUMP_TIME;
        if (u < 1.4) {
          let x: number, z: number;
          if (design === 0) { const part = LAKE0[k % 4]; x = part[0] + (hash2(k, p.seed * 7) - 0.5) * part[2]; z = part[1] + (hash2(k * 3, p.seed * 13) - 0.5) * part[2]; }
          else { x = -0.7 + 1.4 * hash2(k, p.seed * 7); z = -0.55 + 0.46 * hash2(k * 3, p.seed * 13); }
          const yaw = hash2(k * 5, p.seed * 17) * 6.28;
          if (u < 1) put(1, atTilted(x, 0.03 + 0.07 * Math.sin(u * Math.PI), z, yaw, 0, (u - 0.5) * 1.8));
          if (u > 0.5) put(2, at(x, 0.031, z, yaw, 0.3 + (u - 0.5) * 1.2));
        }
      }
      if (design === 1) {
        // the boat: rowed up and down the pond, each stroke a surge
        const T = 36, u = (p.t % T) / T, s = u < 0.5 ? u * 2 : 2 - u * 2, surge = 0.015 * Math.sin(p.t * Math.PI);
        const x = -0.68 + 1.36 * s + surge * (u < 0.5 ? 1 : -1), turn = Math.min(1, Math.abs(u - 0.5) * 20);
        put(3, at(x, 0.03, -0.32 + 0.06 * Math.sin(p.t * 0.3), (u < 0.5 ? Math.PI / 2 : -Math.PI / 2) * turn));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- allotments (kind 219)

/** a gardener with a hat, facing +z, feet at local y 0 */
function gardenerGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.018, 0.026, 0.014).translate(0, 0.013, 0), 0x5a4a3a);
  k.part(new BoxGeometry(0.024, 0.028, 0.016).translate(0, 0.04, 0), 0xffffff);
  k.part(new SphereGeometry(0.01, 6, 5).translate(0, 0.064, 0), 0xf2c8a0);
  k.part(new CylinderGeometry(0.014, 0.014, 0.005, 8).translate(0, 0.072, 0), 0xd9c38e);
  k.part(new BoxGeometry(0.004, 0.05, 0.004).translate(0.016, 0.03, 0.014), 0x5a3d26); // a hoe
  return finish(k.build());
}
/** a wheelbarrow and the one pushing it, going +z; the ground is local y 0 */
function barrowGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.05, 0.026, 0.06).translate(0, 0.033, 0.03), 0x4f7a5a);
  k.part(new BoxGeometry(0.04, 0.012, 0.05).translate(0, 0.05, 0.03), 0x5a3f2a); // the load of soil
  k.part(new CylinderGeometry(0.014, 0.014, 0.008, 8).rotateZ(Math.PI / 2).translate(0, 0.014, 0.06), 0x2a2d33);
  for (const s of [-1, 1]) k.part(new BoxGeometry(0.004, 0.004, 0.07).translate(s * 0.02, 0.04, -0.02), 0x5a3d26);
  k.part(new BoxGeometry(0.018, 0.026, 0.014).translate(0, 0.013, -0.06), 0x5a4a3a);
  k.part(new BoxGeometry(0.024, 0.028, 0.016).translate(0, 0.04, -0.06), 0xffffff);
  k.part(new SphereGeometry(0.01, 6, 5).translate(0, 0.064, -0.06), 0xf2c8a0);
  return finish(k.build());
}
const PLOTS: [number, number][][] = [
  [[-0.74, -0.38], [-0.09, -0.68], [-0.09, -0.24], [-0.09, 0.22], [0.64, -0.36], [0.64, 0.36], [-0.74, 0.48]],
  [[-0.76, -0.7], [-0.76, -0.35], [-0.22, -0.32], [0.18, -0.32], [0.6, -0.32], [0.02, 0.75], [0.42, 0.75]],
];
const PLOT_Y = [0.032, 0.062], GARDENER_COLOURS = [0xd94f4f, 0x2f8fd6, 0x4f9a5c, 0xe6b734, 0x7a5ad9, 0xf2f2ee];
/** the allotments: gardeners hoe their plots, pausing to straighten up, and a barrow is wheeled up and down the main path */
function allotmentRig(design: number): Rig {
  const plots = PLOTS[design];
  return {
    kind: 219, design, props: [gardenerGeometry(), barrowGeometry()], perPlace: [6, 1], range: 70,
    frame(p: PlaceFrame, put: Put) {
      const n = Math.min(6, Math.round(p.act * 8)), order = Math.floor(p.seed * plots.length);
      for (let i = 0; i < n; i++) {
        const [px, pz] = plots[(i + order) % plots.length], h = hash2(i * 3 + 1, p.seed * 23), h2 = hash2(i * 5 + 2, p.seed * 29);
        const t = p.t + h * 10, cycle = t % 6, dig = cycle < 3.6 ? 0.3 * Math.max(0, Math.sin(cycle * Math.PI * 1.1)) : 0;
        put(0, atTilted(px + (h - 0.5) * 0.16, PLOT_Y[design], pz + (h2 - 0.5) * 0.16, h2 * 6.28, 0, dig), GARDENER_COLOURS[i]);
      }
      if (p.act > 0.3) {
        const T = 26, u = (p.t % T) / T, s = u < 0.5 ? u * 2 : 2 - u * 2, z = -0.78 + 1.5 * s;
        put(1, at(-0.5 + (design ? 0.03 : 0), design ? 0.016 : 0.016, z, u < 0.5 ? 0 : Math.PI));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- climbing centre (kind 227): the outside wall

/** a climber spread on the wall, back to the viewer (facing +z into the wall); feet at local y 0 */
function climberGeometry(): BufferGeometry {
  const k = new Kit();
  k.part(new BoxGeometry(0.022, 0.03, 0.012).translate(0, 0.015, 0), 0x3a3e49);
  k.part(new BoxGeometry(0.026, 0.03, 0.014).translate(0, 0.045, 0), 0xffffff);
  k.part(new SphereGeometry(0.01, 6, 5).translate(0, 0.07, 0), 0xf2c8a0);
  for (const s of [-1, 1]) { k.part(new BoxGeometry(0.006, 0.034, 0.008).translate(s * 0.02, 0.075, 0), 0xf2c8a0); k.part(new BoxGeometry(0.006, 0.02, 0.008).translate(s * 0.016, -0.004, 0), 0x3a3e49); }
  return finish(k.build());
}
interface Wall { x0: number; x1: number; y0: number; y1: number; z: (y: number) => number; pitch: number }
const WALLS: Wall[] = [
  { x0: 0.08, x1: 0.36, y0: 0.06, y1: 0.78, z: (y) => 0.2 + (0.2 * (y - 0.02)) / 0.85 + 0.03, pitch: -0.23 },
  { x0: 0.2, x1: 0.4, y0: 0.06, y1: 0.74, z: () => -0.074, pitch: 0 },
];
const CLIMB = 26, CLIMB_UP = 17, CLIMB_TOP = 2, CLIMB_DOWN = 4;
/** the climbing centre: climbers work up the outside wall hold by hold, rest at the top and lower off */
function climbingRig(design: number): Rig {
  const w = WALLS[design];
  return {
    kind: 227, design, props: [climberGeometry()], perPlace: [2], range: 70,
    frame(p: PlaceFrame, put: Put) {
      const n = p.act > 0.6 ? 2 : p.act > 0.12 ? 1 : 0;
      for (let i = 0; i < n; i++) {
        const t = (p.t + i * 11 + hash2(i, p.seed * 31) * CLIMB) % CLIMB;
        let f: number;
        if (t < CLIMB_UP) { const u = t / CLIMB_UP, steps = 9, s = u * steps, k = Math.floor(s), fr = s - k; f = (k + fr * fr * (3 - 2 * fr)) / steps; }
        else if (t < CLIMB_UP + CLIMB_TOP) f = 1;
        else if (t < CLIMB_UP + CLIMB_TOP + CLIMB_DOWN) { const u = (t - CLIMB_UP - CLIMB_TOP) / CLIMB_DOWN; f = 1 - u * u * (3 - 2 * u); }
        else continue;
        const x = w.x0 + (w.x1 - w.x0) * (0.3 + 0.4 * hash2(i * 7 + 1, p.seed * 37) + 0.15 * Math.sin(f * 9 + i)), y = w.y0 + (w.y1 - w.y0) * f;
        put(0, atTilted(x, y, w.z(y), 0, 0, w.pitch), PLAYER_COLOURS[(i + Math.floor(p.seed * 4)) % 4]);
      }
    },
  };
}

/** Every rig, in no particular order; a place takes the first whose kind (and design, if given) matches. */
export const RIGS: Rig[] = [
  fishingRig(0), fishingRig(1),
  allotmentRig(0), allotmentRig(1),
  climbingRig(0), climbingRig(1),
  lidoRig(0), lidoRig(1),
  tennisRig(0), tennisRig(1),
  skateRig(0), skateRig(1),
  rinkRig(0), rinkRig(1),
  reserveRig(0), reserveRig(1),
  observatoryRig(0), observatoryRig(1),
  kartRig(0, KART_LOOP),
  kartRig(1, KART_EIGHT),
  funfairRig0(),
  funfairRig1(),
  playgroundRig(),
  farmRig(0),
  farmRig(1),
];
