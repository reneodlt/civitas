import { Vector3, Quaternion, type Group, type Mesh, type Material, type MeshLambertMaterial } from 'three';
import { LifeStage, hash2, VENUE_WORDS, type VenueType } from '@msimcity/shared';
import { HIP_M, type Kit, type Ctx, type RoomBuilder, type LeisureRoom, type Rng } from '../interiors';
import {
  outdoors, tree, pine, bench, lampPost, bar, setBar, visitor, crowdStage, staff, companions, loopWalker, lineWalker,
  viewYaw, viewPitch, eyeStanding, eyeSitting, duck, rng, pick, BRIGHT,
} from '../leisureKit';
import { sceneUniforms } from '../materials';
import type { Look } from '../people';

/**
 * First-person scenes for the outdoor free-time places (docs/leisure.md, shared buildings/attractions.ts), built with
 * render/leisureKit.ts: on a swing at the playground, on the deck of the skate park's bowl, kneeling at a raised bed on
 * the allotment, on a fishing peg, inside the nature reserve's bird hide, in the lido's pool, at the tennis club's
 * baseline and driving a go-kart round the circuit. Everything is seeded by the place, so it looks the same to everyone.
 */

// ---- helpers ----------------------------------------------------------------------------------

const seedOf = (c: Ctx) => c.place.venue?.seed ?? c.place.seed;
/** is the place's event on (the activity line is the event's)? */
const during = (c: Ctx, t: VenueType) => c.info.activity === VENUE_WORDS[t].event;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (u: number) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const night = () => sceneUniforms.uNight.value;
const BIT = (b: number) => 1 << b;
/** people.ts feature bits left in the locker for sport: coat, bags, hard hat, phone, shirt front, tie, stick, hi-vis bands, lanyard */
const GEAR = BIT(7) | BIT(8) | BIT(9) | BIT(10) | BIT(12) | BIT(13) | BIT(14) | BIT(15) | BIT(16) | BIT(17) | BIT(21);
/** dress someone for sport: a top and legs colour, short sleeves and shorts; for a swim also barefoot, no hat, no skirt */
function outfit(look: Look, top: number, legs: number, swim = false): Look {
  look.a = [look.a[0], look.a[1], top, legs];
  look.b = [look.b[0], swim ? look.a[0] : look.b[1], look.b[2], (look.b[3] | BIT(18) | BIT(19)) & ~(GEAR | (swim ? BIT(6) | BIT(11) : 0))];
  return look;
}
/** a see-through material: the kit's cached material for a colour no other surface in the scene uses, so it is disposed with the kit */
function glassy(k: Kit, hex: number, opacity: number): MeshLambertMaterial {
  const m = k.mat(hex);
  m.transparent = true; m.opacity = opacity; m.depthWrite = false;
  return m;
}
/** a box over [x0, x1] × [z0, z1], from y up h */
function slab(k: Kit, x0: number, x1: number, z0: number, z1: number, y: number, h: number, col: number) {
  if (x1 - x0 > 1e-3 && z1 - z0 > 1e-3) k.box((x0 + x1) / 2, y, (z0 + z1) / 2, x1 - x0, h, z1 - z0, col);
}
/** ground with a hole in it (a bowl, a pool): four slabs over [x0, x1] × [z0, z1] round the hole [hx0, hx1] × [hz0, hz1] */
function around(k: Kit, [x0, x1, z0, z1]: number[], [hx0, hx1, hz0, hz1]: number[], y: number, h: number, col: number) {
  slab(k, x0, hx0, z0, z1, y, h, col); slab(k, hx1, x1, z0, z1, y, h, col);
  slab(k, hx0, hx1, z0, hz0, y, h, col); slab(k, hx0, hx1, hz1, z1, y, h, col);
}
/** a board from a to b with its top face along the line, w wide and t thick (a slide's chute, a sloping pool floor); scene level only */
function plank(k: Kit, a: Vector3, b: Vector3, w: number, t: number, col: number | Material) {
  const m = k.box(0, 0, 0, w, t, a.distanceTo(b), col);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.position.y -= t;
  m.lookAt(b.x, b.y - t, b.z);
  return m;
}
type Key = [number, number, number, number];
/**
 * A path through timed keys [t, x, y, z], straight between them; the last key's time is the period and its place should be
 * the first's. Writes the place at t into `out` and returns the leg (the index of the key it left) plus how far along it.
 */
function keyed(keys: Key[]) {
  const T = keys[keys.length - 1][0];
  return (t: number, out: Vector3) => {
    const u = ((t % T) + T) % T;
    let i = 0;
    while (i < keys.length - 2 && u >= keys[i + 1][0]) i++;
    const a = keys[i], b = keys[i + 1], f = clamp((u - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 0.9999);
    out.set(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f);
    return i + f;
  };
}
/** a floodlight mast whose lamp faces (tx, tz) and glows after dark */
function floodlight(k: Kit, x: number, z: number, h: number, tx: number, tz: number) {
  k.cyl(x, 0, z, 0.1, h, 0x7a7e86);
  k.group(x, z, Math.atan2(tx - x, tz - z), () => {
    k.box(0, h - 0.35, 0.05, 1.4, 0.75, 0.3, 0x30343c);
    k.box(0, h - 0.29, 0.21, 1.2, 0.6, 0.04, k.glow(0xfff2d8, 1.6, 'night'));
  });
}
/**
 * Floodlit play after dark: the kit's ceiling light hung high over the court or bowl, and more ambient light once it is
 * dark. Returns the switch, for the view's `live` (the clock moves on while the scene is up).
 */
function floodlit(k: Kit, x: number, y: number, z: number, max: number) {
  k.ceil.position.set(x, y, z); k.ceil.userData.max = max; k.ceil.distance = 0;
  const on = () => { const n = night(); k.ceilOn = n > 0.35 ? 1 : 0; k.ambientNight = 0.12 + 0.25 * n; };
  on();
  return on;
}
const REED = [0x6a8a3a, 0x7a8a4a, 0x5a7a3a, 0x8a8a5a];
/** a clump of reeds, one with a bulrush head */
function reeds(k: Kit, r: Rng, x: number, z: number, n = 4, h = 1.4) {
  for (let i = 0; i < n; i++) {
    const m = k.box(x + (r() - 0.5) * 0.6, 0, z + (r() - 0.5) * 0.5, 0.035, h * (0.65 + r() * 0.5), 0.035, pick(r, REED));
    m.rotation.set((r() - 0.5) * 0.25, 0, (r() - 0.5) * 0.25);
  }
  if (r() < 0.7) { k.box(x, 0, z, 0.03, h, 0.03, REED[0]); k.cyl(x, h - 0.05, z, 0.04, 0.22, 0x5a3a22); }
}
/** a grey heron standing (facing yaw like a body); its neck is a group to bend for a stab at a fish */
function heron(k: Kit, x: number, z: number, yaw: number) {
  let neck: Group | null = null;
  const g = k.group(x, z, yaw, () => {
    for (const s of [-1, 1]) k.box(0, 0, s * 0.05, 0.022, 0.6, 0.022, 0xb8a060);
    k.ball(0, 0.74, 0, 0.27, 0.14, 0.13, 0x9aa0a8).rotation.z = 0.35;
    k.ball(-0.06, 0.76, 0, 0.24, 0.12, 0.135, 0x6a707a).rotation.z = 0.35;
    neck = k.group(0.18, 0, 0, () => {
      k.box(0, 0, 0, 0.05, 0.34, 0.05, 0xd8dce0).rotation.z = -0.2;
      k.ball(0.07, 0.36, 0, 0.065, 0.05, 0.045, 0xe8ecef);
      k.box(-0.02, 0.37, -0.008, 0.12, 0.02, 0.016, 0x1a1a1a);
      k.box(0.19, 0.345, -0.012, 0.17, 0.025, 0.025, 0xd8b030);
    });
    neck.position.y = 0.82;
  });
  return { g, neck: neck as unknown as Group };
}
/** a bird in flight (built along +x): a body and two wing groups to flap */
function flyer(k: Kit, col: number, s = 1) {
  const wings: Group[] = [];
  const g = k.group(0, 0, 0, () => {
    k.ball(0, 0, 0, 0.16 * s, 0.06 * s, 0.06 * s, col);
    k.ball(0.15 * s, 0.02 * s, 0, 0.05 * s, 0.045 * s, 0.045 * s, col);
    for (const side of [-1, 1]) wings.push(k.group(0, 0, 0, () => { k.box(0, -0.01 * s, side * 0.22 * s, 0.14 * s, 0.02 * s, 0.4 * s, col); }));
  });
  return { g, wings };
}
/** birds flying loops over (cx, cy, cz): each its own size, speed and phase, flapping with glides between */
function flock(k: Kit, r: Rng, n: number, cx: number, cy: number, cz: number, spread: number, cols: number[]) {
  for (let i = 0; i < n; i++) {
    const f = flyer(k, pick(r, cols), 0.8 + r() * 0.6);
    const ox = cx + (r() - 0.5) * spread, oz = cz + (r() - 0.5) * spread * 0.4, oy = cy + r() * 4;
    const rx = 4 + r() * 8, rz = 2 + r() * 4, w = (0.12 + r() * 0.12) * (r() < 0.5 ? 1 : -1), ph = r() * 6;
    k.animate.push((t) => {
      const a = ph + t * w;
      f.g.position.set(ox + Math.cos(a) * rx, oy + 0.8 * Math.sin(t * 0.4 + ph), oz + Math.sin(a) * rz);
      f.g.rotation.y = Math.atan2(-(Math.cos(a) * rz * w), -Math.sin(a) * rx * w);
      const glide = Math.sin(t * 0.5 + ph) > 0.35, flap = glide ? 0.12 : 0.7 * Math.sin(t * 9 + ph);
      f.wings[0].rotation.x = flap; f.wings[1].rotation.x = -flap;
    });
  }
}
type Paddler = { g: Group; cx: number; cz: number; rx: number; rz: number; w: number; ph: number };
/** waterfowl paddling slow loops (ducks, coots, a swan) */
function paddle(k: Kit, list: Paddler[]) {
  k.animate.push((t) => {
    for (const d of list) {
      const a = d.ph + t * d.w;
      d.g.position.set(d.cx + Math.cos(a) * d.rx, 0.01 * Math.sin(t * 2 + d.ph), d.cz + Math.sin(a) * d.rz);
      d.g.rotation.y = Math.atan2(-(Math.cos(a) * d.rz * d.w), -Math.sin(a) * d.rx * d.w);
    }
  });
}
const coot = (k: Kit) => k.group(0, 0, 0, () => {
  k.ball(0, 0.1, 0, 0.16, 0.1, 0.11, 0x1a1a1e); k.ball(0.14, 0.2, 0, 0.06, 0.06, 0.06, 0x1a1a1e); k.box(0.2, 0.18, -0.02, 0.05, 0.04, 0.04, 0xf4f4f0);
});
const swan = (k: Kit) => k.group(0, 0, 0, () => {
  k.ball(0, 0.2, 0, 0.42, 0.2, 0.26, 0xf4f4f0); k.box(0.3, 0.25, -0.04, 0.08, 0.5, 0.08, 0xf4f4f0);
  k.ball(0.38, 0.78, 0, 0.09, 0.07, 0.07, 0xf4f4f0); k.box(0.46, 0.74, -0.02, 0.1, 0.04, 0.04, 0xe07a2a);
});
/** trees in front of the viewer and to the sides, between radius r0 and r1 of (cx, cz), none inside `keep` [x0, x1, z0, z1] */
function treesAround(k: Kit, r: Rng, n: number, cx: number, cz: number, r0: number, r1: number, keep?: number[]) {
  for (let i = 0, tries = 0; i < n && tries < n * 8; tries++) {
    const a = Math.PI - 0.3 + r() * (Math.PI + 0.6), d = r0 + r() * (r1 - r0), x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    if (keep && x > keep[0] && x < keep[1] && z > keep[2] && z < keep[3]) continue;
    (r() < 0.7 ? tree : pine)(k, r, x, z, 0.8 + r() * 0.6);
    i++;
  }
}
/** a garden shed facing +z in its frame (door and window on the front, a pitched roof) */
function shed(k: Kit, x: number, z: number, ry: number, col: number) {
  k.group(x, z, ry, () => {
    k.box(0, 0, 0, 2.2, 1.9, 1.6, col);
    for (const s of [-1, 1]) {
      const m = k.box(0, 0, 0, 2.45, 0.06, 1.0, 0x3a3a3c);
      m.position.set(0, 2.17, s * 0.42); m.rotation.x = s * 0.45;
      k.box(s * 1.08, 1.9, 0, 0.04, 0.32, 0.6, col);
    }
    k.box(0.5, 0, 0.81, 0.7, 1.65, 0.03, 0x4a3a2a);
    k.box(-0.5, 1.0, 0.81, 0.55, 0.45, 0.03, 0xa8c4d4);
  });
}

// ---- the playground: on a swing ----------------------------------------------------------------

const playground: RoomBuilder = (k, c) => {
  const r = rng(seedOf(c) ^ 0x51a6);
  outdoors(k, c, { city: 0.7, sun: [0.3, -0.8, -0.5] });
  // the rubber safety surface: big squares in three bright colours
  const rub = pick(r, [[0xd9573a, 0x3a8fd0, 0x5aa84a], [0x2f9a8a, 0xe6a23a, 0x8a5ad0], [0x4a7ad9, 0xd94f6a, 0xe6c23a]]);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) k.box(-10 + i * 4, 0, 1 - j * 4, 4, 0.03, 4, rub[(i + 2 * j) % 3]);
  // a low fence round three sides, lamps and trees beyond it
  const fence = pick(r, [0x2f6a4a, 0x2a4a7a, 0x8a3a2a, 0x3a3a3c]);
  const run = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 2.5));
    for (let i = 0; i <= n; i++) k.box(ax + ((bx - ax) * i) / n, 0, az + ((bz - az) * i) / n, 0.08, 1.05, 0.08, fence);
    for (const y of [0.45, 0.95]) bar(k, new Vector3(ax, y, az), new Vector3(bx, y, bz), 0.06, fence);
  };
  run(-12.5, -17.5, 12.5, -17.5); run(-12.5, -17.5, -12.5, 3); run(12.5, -17.5, 12.5, 3);
  lampPost(k, -13.5, -18.6); lampPost(k, 13.5, -18.6);
  treesAround(k, r, 10, 0, -8, 17, 32);

  // the swing frame: an A-frame at each end and a beam; your swing, and the one beside it
  const frame = pick(r, [0xc0392b, 0x2e86de, 0x27ae60, 0xe6b734]), chain = 0x9aa0a8, PY = 2.5, L = PY - 0.48;
  k.box(0.5, PY, 0, 2.6, 0.1, 0.1, frame);
  for (const x of [-0.75, 1.75]) for (const s of [-1, 1]) bar(k, new Vector3(x, PY + 0.05, 0), new Vector3(x, 0, s * 1.1), 0.09, frame);
  const v = c.viewer, hs = v.height, e = 0.75 * hs, lean = 0.2;
  const shin = v.b[3] & BIT(19) ? v.a[0] : v.a[3];
  const legs: Group[] = [];
  // your swing hangs from the beam (its group turns about the beam); your hands on the chains, your legs kicking
  const mine = k.group(0, 0, 0, () => {
    for (const sx of [-0.17, 0.17]) {
      k.box(sx, -L, 0, 0.022, L, 0.022, chain);
      k.ball(sx, -L + 0.36 * hs + 0.12, 0, 0.045, 0.05, 0.045, v.a[0]);
    }
    k.box(0, -L - 0.04, 0.02, 0.42, 0.04, 0.2, 0x2a2a2a);
    for (const sx of [-0.08, 0.08]) {
      k.box(sx, -L, -0.17 * hs, 0.11 * hs, 0.12 * hs, 0.38 * hs, v.a[3]);
      const g = k.group(sx, -0.36 * hs, 0, () => {
        k.box(0, -0.4 * hs, 0, 0.1 * hs, 0.4 * hs, 0.1 * hs, shin);
        k.box(0, -0.44 * hs, -0.05 * hs, 0.11 * hs, 0.07 * hs, 0.22 * hs, v.b[1]);
      });
      g.position.y = -L + 0.06 * hs;
      legs.push(g);
    }
  });
  mine.position.y = PY;
  const w = Math.sqrt(9.8 / L), amp = 0.4 + r() * 0.12;
  const nbAmp = 0.28 + r() * 0.15, nbPh = r() * 6, nbW = w * (1.02 + r() * 0.04);
  const nb = k.group(1.0, 0, 0, () => {
    for (const sx of [-0.17, 0.17]) k.box(sx, -L, 0, 0.022, L, 0.022, chain);
    k.box(0, -L - 0.04, 0, 0.42, 0.04, 0.2, 0x2a2a2a);
  });
  nb.position.y = PY;
  // a brother or sister on the next swing (or another child), grown-ups of the family watching from in front
  const mates = companions(c, 2), kidMate = mates.find((m) => m.child);
  const kid = kidMate?.look ?? visitor(c, 1, LifeStage.Child);
  k.bodies.push({ look: kid, x: 1.0, y: 0, z: 0, yaw: Math.PI / 2, swing: 0, pose: 0, ph: 3,
    move: (t, b) => {
      const th = nbAmp * Math.sin(nbW * t + nbPh);
      nb.rotation.x = th;
      b.y = PY - L * Math.cos(th) - HIP_M * kid.height + 0.04; b.z = -L * Math.sin(th);
    } });
  mates.filter((m) => m !== kidMate).forEach((m, i) => k.stand(m.look, 1.9 + i * 0.75, -2.3 - i * 0.4, Math.atan2(-2.3, -1.4), 0, 10 + i));

  // the climbing frame: a cube of bars, a deck halfway up, a pointed roof and a rope net up the front
  const cA = pick(r, [0xc0392b, 0x2e86de, 0xe6b734, 0x27ae60]), cB = pick(r, [0xf4f4f0, 0xe6b734, 0x2a2a2a]), rope = 0xd8c8a0;
  const fx = -4.6, fz = -8, S = 2.4;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(fx + (sx * S) / 2, 0, fz + (sz * S) / 2, 0.06, 2.55, cA);
  for (const y of [0.8, 1.6, 2.4]) {
    k.box(fx, y, fz - S / 2, S, 0.05, 0.05, cB); k.box(fx - S / 2, y, fz, 0.05, 0.05, S, cB); k.box(fx + S / 2, y, fz, 0.05, 0.05, S, cB);
    if (y > 1) k.box(fx, y, fz + S / 2, S, 0.05, 0.05, cB);
  }
  k.box(fx, 1.55, fz - 0.4, S, 0.06, S - 0.8, 0x8a6a4a);
  k.cone(fx, 2.55, fz, 1.9, 0.9, cA);
  for (let i = 1; i < 4; i++) k.box(fx - S / 2 + (i * S) / 4, 0, fz + S / 2 + 0.03, 0.03, 1.6, 0.03, rope);
  for (const y of [0.55, 1.1]) k.box(fx, y, fz + S / 2 + 0.03, S, 0.03, 0.03, rope);
  k.stand(visitor(c, 2, LifeStage.Child), fx + 0.5, fz - 0.6, -Math.PI / 2 + 0.3, 0, 2, 1.61);
  k.sit(visitor(c, 7, LifeStage.Child), fx + 0.65, fz + S / 2, 2.45, -Math.PI / 2 - 0.2, 0, 7);
  const climber = visitor(c, 5, LifeStage.Child), clPh = r() * 6;
  k.bodies.push({ look: climber, x: fx - 0.35, y: 0, z: fz + S / 2 + 0.22, yaw: Math.PI / 2, swing: 0.15, pose: -1, ph: 5,
    move: (t, b) => { b.y = 0.75 * (0.5 - 0.5 * Math.cos(t * 0.45 + clPh)); } });

  // the slide: a deck on posts, a ladder up the back and the chute coming down toward you
  const sx = 4.6, sTop = 1.8, pz = -10.4, chute = pick(r, [0xe6b734, 0x2e86de, 0xd94f4f, 0x27ae60]);
  k.box(sx, sTop - 0.06, pz, 1.0, 0.06, 1.0, 0x8a6a4a);
  for (const ox of [-0.47, 0.47]) for (const oz of [-0.47, 0.47]) k.cyl(sx + ox, 0, pz + oz, 0.045, sTop + 0.85, cA);
  for (const ox of [-0.48, 0.48]) k.box(sx + ox, sTop, pz, 0.04, 0.55, 0.96, cA);
  k.cone(sx, sTop + 0.85, pz, 0.85, 0.55, cB === 0x2a2a2a ? 0xf4f4f0 : cB);
  for (const ox of [-0.24, 0.24]) bar(k, new Vector3(sx + ox, 0, pz - 1.35), new Vector3(sx + ox, sTop + 0.5, pz - 0.3), 0.05, cA);
  for (let i = 1; i <= 5; i++) { const f = i / 6; k.box(sx, f * sTop, pz - 1.35 + f * 0.85, 0.48, 0.04, 0.05, cB); }
  const c0 = new Vector3(sx, sTop, pz + 0.5), c1 = new Vector3(sx, 0.4, pz + 3.8), c2 = new Vector3(sx, 0.32, pz + 4.6);
  plank(k, c0, c1, 0.6, 0.05, chute); plank(k, c1, c2, 0.6, 0.05, chute);
  for (const ox of [-0.31, 0.31]) plank(k, new Vector3(sx + ox, sTop + 0.16, pz + 0.5), new Vector3(sx + ox, 0.56, pz + 3.8), 0.03, 0.2, chute);
  k.box(sx, 0, pz + 3.8, 0.5, 0.36, 0.06, cA);
  const slide = keyed([
    [0, sx, 0, pz - 1.75], [2.0, sx, sTop, pz - 0.6], [2.7, sx, sTop, pz + 0.3], [3.0, sx, sTop, pz + 0.5],
    [4.0, sx, 0.4, pz + 3.8], [4.3, sx, 0.32, pz + 4.6], [4.6, sx + 0.2, 0, pz + 4.9],
    [6.2, sx + 1.6, 0, pz + 1.5], [7.6, sx + 0.9, 0, pz - 2.2], [8.0, sx, 0, pz - 1.75],
  ]);
  const slider = visitor(c, 3, LifeStage.Child), SP = new Vector3(), SQ = new Vector3(), sPh = r() * 8;
  k.bodies.push({ look: slider, x: sx, y: 0, z: pz, yaw: 0, swing: 0, pose: 0, ph: 4,
    move: (t, b) => {
      const leg = slide(t + sPh, SP), i = Math.floor(leg), f = leg - i;
      slide(t + sPh + 0.1, SQ);
      // up the ladder, across the deck, sit, whoosh down, hop off and run round to the ladder again
      const seated = i === 3 || i === 4 ? 1 : i === 2 ? f : i === 5 ? 1 - f : 0;
      b.x = SP.x; b.z = SP.z; b.y = SP.y - seated * (HIP_M * slider.height - 0.04);
      b.yaw = i <= 5 ? -Math.PI / 2 : Math.atan2(-(SQ.z - SP.z), SQ.x - SP.x);
      b.swing = i === 0 ? 0.35 : i === 1 ? 0.4 : i >= 6 ? 0.7 : 0;
      b.pose = i === 0 ? -1 : 0;
    } });

  // the roundabout, two children riding it and one running alongside to push
  const rx = 6.6, rz = -14.6, wR = (0.8 + r() * 0.5) * (r() < 0.5 ? 1 : -1);
  k.cyl(rx, 0, rz, 0.3, 0.12, 0x5a5e66);
  const rbg = k.group(rx, rz, 0, () => {
    k.cyl(0, 0.1, 0, 1.4, 0.08, pick(r, [0xd94f4f, 0x2e86de, 0xe6b734]));
    k.cyl(0, 0.18, 0, 0.08, 0.75, 0xd8d8d8);
    for (let i = 0; i < 4; i++) { const a = (i * Math.PI) / 2; k.box(Math.cos(a) * 0.62, 0.82, -Math.sin(a) * 0.62, 1.24, 0.04, 0.04, 0xd8d8d8, a); }
  });
  k.animate.push((t) => { rbg.rotation.y = t * wR; });
  for (let i = 0; i < 2; i++) {
    const a0 = i * Math.PI + 0.4;
    k.bodies.push({ look: visitor(c, 4 + i * 6, LifeStage.Child), x: rx, y: 0.18, z: rz, yaw: 0, swing: 0, pose: 0, ph: 6 + i,
      move: (t, b) => { const a = a0 + t * wR; b.x = rx + Math.cos(a) * 0.85; b.z = rz - Math.sin(a) * 0.85; b.yaw = a + Math.PI; } });
  }
  k.bodies.push({ look: visitor(c, 6, LifeStage.Child), x: rx, y: 0, z: rz, yaw: 0, swing: 0.7, pose: 0, ph: 8,
    move: (t, b) => { const a = 2.0 + t * wR; b.x = rx + Math.cos(a) * 1.75; b.z = rz - Math.sin(a) * 1.75; b.yaw = a + Math.sign(wR) * (Math.PI / 2); } });

  // parents on the benches by the fence (some on their phones), a pram beside one
  for (let i = 0; i < 3; i++) {
    const bx = -7 + i * 6 + (r() - 0.5);
    bench(k, bx, -16.2, 0);
    for (let j = 0; j < 2; j++) if (r() < 0.75) k.sit(visitor(c, 20 + i * 2 + j, crowdStage(r, 0, 0.25)), bx - 0.4 + j * 0.8, -16.15, 0.47, -Math.PI / 2 + (r() - 0.5) * 0.4, r() < 0.3 ? 0.5 : 0, 20 + i * 2 + j);
  }
  const pramCol = pick(r, [0x2a3a5a, 0x5a2a3a, 0x3a4a3a, 0x8a8a8a]);
  k.group(-4.4, -15.3, 0.3, () => {
    k.box(0, 0.32, 0, 0.45, 0.32, 0.8, pramCol); k.ball(0, 0.64, -0.2, 0.24, 0.22, 0.2, pramCol);
    for (const wx of [-0.2, 0.24]) for (const wz of [-0.3, 0.3]) k.cyl(wx, 0.12, wz, 0.12, 0.04, 0x1a1a1a).rotation.z = Math.PI / 2;
    k.box(0, 0.64, 0.45, 0.45, 0.04, 0.04, 0x2a2a2a);
  });

  // the sandpit, a child digging; a spring rider with a toddler and a parent beside
  const spx = -3.6, spz = -3.2;
  k.box(spx, 0, spz, 2.4, 0.2, 2.4, 0xe0cc90);
  for (const [ox, oz, bw, bd] of [[0, -1.2, 2.5, 0.1], [0, 1.2, 2.5, 0.1], [-1.2, 0, 0.1, 2.5], [1.2, 0, 0.1, 2.5]]) k.box(spx + ox, 0, spz + oz, bw, 0.28, bd, 0x8a6a4a);
  k.cyl(spx + 0.5, 0.2, spz + 0.3, 0.09, 0.14, 0xd94f4f);
  k.sit(visitor(c, 8, LifeStage.Child), spx - 0.2, spz, 0.24, -Math.PI / 2 + 0.6, -1, 8);
  const horseCol = pick(r, BRIGHT);
  k.cyl(2.6, 0, -5, 0.07, 0.38, 0x3a3a3a);
  const horse = k.group(2.6, -5, 0, () => { k.ball(0, 0.55, 0, 0.36, 0.17, 0.15, horseCol); k.ball(0.32, 0.76, 0, 0.12, 0.14, 0.1, horseCol); k.box(0.22, 0.7, -0.2, 0.04, 0.04, 0.4, 0x2a2a2a); });
  const tot = visitor(c, 9, LifeStage.Child);
  tot.height *= 0.8;
  k.bodies.push({ look: tot, x: 2.55, y: 0, z: -5, yaw: 0, swing: 0, pose: 0, ph: 9,
    move: (t, b) => { const rock = Math.sin(t * 2.2); horse.rotation.z = 0.2 * rock; horse.rotation.x = 0.06 * Math.sin(t * 1.7); b.x = 2.55 - 0.08 * rock; b.y = 0.66 - HIP_M * tot.height + 0.04 + 0.03 * rock; } });
  k.stand(visitor(c, 11, LifeStage.Adult), 2.5, -4.2, Math.PI / 2 + 0.3, 0, 11);

  // the zip wire down the left side: a ride, a bounce at the end, and the walk back with the seat
  const zA = new Vector3(-10.5, 3.0, -2.5), zB = new Vector3(-10.5, 2.0, -14.5), drop = 1.45;
  k.cyl(zA.x, 0, zA.z, 0.09, zA.y + 0.15, 0x6a4a32); k.cyl(zB.x, 0, zB.z, 0.09, zB.y + 0.15, 0x6a4a32);
  bar(k, zA, zB, 0.02, 0x9aa0a8);
  k.box(zA.x, 0, zA.z + 0.2, 1.2, 0.8, 1.2, 0x8a6a4a);
  const seatM = k.cyl(0, 0, 0, 0.17, 0.05, 0xd94f4f), ropeM = bar(k, zA, zB, 0.015, 0x2a2a2a);
  const zipper = visitor(c, 12, LifeStage.Child), TR = new Vector3(), SE = new Vector3(), zPh = r() * 12;
  k.bodies.push({ look: zipper, x: zA.x, y: 0, z: zA.z, yaw: Math.PI / 2, swing: 0, pose: 0, ph: 12,
    move: (t, b) => {
      const u = (t + zPh) % 12;
      const f = u < 3.2 ? 1 - (1 - u / 3.2) ** 2 : u < 4.6 ? 1 : u < 11 ? 1 - (u - 4.6) / 6.4 : 0;
      const on = u < 4.2 || u >= 11;
      TR.lerpVectors(zA, zB, f);
      const sw = u > 3.2 && u < 4.4 ? 0.35 * Math.sin((u - 3.2) * 6) * (4.4 - u) : 0;
      SE.set(TR.x, TR.y - drop * Math.cos(sw), TR.z - drop * Math.sin(sw));
      seatM.position.copy(SE); setBar(ropeM, TR, SE, 0.015);
      if (on) { b.x = SE.x; b.z = SE.z; b.y = SE.y + 0.05 - HIP_M * zipper.height + 0.04; b.yaw = Math.PI / 2; b.swing = 0; }
      else { b.x = SE.x + 0.45; b.z = SE.z; b.y = 0; b.yaw = u < 4.6 ? Math.PI / 2 : -Math.PI / 2; b.swing = u < 4.6 ? 0 : 0.5; }
    } });

  // children chasing about, and a dog walker going by outside the fence
  for (let i = 0; i < 2; i++) loopWalker(k, visitor(c, 13 + i, LifeStage.Child), 0.2, -11.8, 2.6, 1.3, 2.2 + r(), r() * 6, i ? 1 : -1);
  const walker = lineWalker(k, visitor(c, 15, crowdStage(r, 0, 0.4)), -26, -21, 26, -21, 1.0, r());
  const dogCol = pick(r, [0x8a5a2a, 0x2a2a2a, 0xd8c8a8, 0xb8783a]);
  const dog = k.group(0, 0, 0, () => {
    k.box(0, 0.25, 0, 0.55, 0.22, 0.2, dogCol); k.ball(0.32, 0.45, 0, 0.11, 0.1, 0.09, dogCol);
    for (const x of [-0.2, 0.2]) for (const z of [-0.07, 0.07]) k.box(x, 0, z, 0.06, 0.26, 0.06, dogCol);
    k.box(-0.33, 0.4, 0, 0.14, 0.03, 0.03, dogCol).rotation.z = 0.6;
  });
  const wMove = walker.move!;
  walker.move = (t, b) => {
    wMove(t, b);
    const fx2 = Math.cos(b.yaw), fz2 = -Math.sin(b.yaw);
    dog.position.set(b.x + fx2 * 0.9 - fz2 * 0.4, 0.02 * Math.abs(Math.sin(t * 7)), b.z + fz2 * 0.9 + fx2 * 0.4);
    dog.rotation.y = b.yaw;
  };

  const eye = new Vector3(0, PY - L + e, lean);
  return {
    eye, aim: new Vector3(0, 1, -10), glances: [], label: 'on the swings',
    // the pendulum: the swing's group turns about the beam, the eye rides it a little behind the chains, the view tips
    // up to the sky going forward and down at the rubber going back, legs kicking out on the way forward
    move: (t, at) => {
      const th = amp * Math.sin(w * t), ly = -L + e;
      mine.rotation.x = th;
      at.set(0, PY + ly * Math.cos(th) - lean * Math.sin(th), ly * Math.sin(th) + lean * Math.cos(th));
      const kick = 0.75 + 0.5 * Math.cos(w * t + 0.3);
      for (const g of legs) g.rotation.x = kick;
      return { yaw: 0.22 * Math.sin(t * 0.12) + 0.1 * Math.sin(t * 0.33 + 1), pitch: -0.12 + th * 0.8, roll: 0.025 * Math.sin(t * 0.4) };
    },
  };
};

// ---- the skate park: on the deck of the bowl -----------------------------------------------------

const skatepark: RoomBuilder = (k, c) => {
  const r = rng(seedOf(c) ^ 0x5ca7);
  const jam = during(c, 'skatepark');
  outdoors(k, c, { size: 0.01, city: 1.1, ground: 0x6f9a52, sun: [0.25, -0.8, -0.55] });
  // the concrete plaza with the bowl sunk into it (the ground is built round the hole), grass beyond
  const BX = 0, BZ = -6.5, RB = 2, RC = 4, RD = 6.2, N = 18, conc = 0xb4b0a8;
  const plaza = [-15, 15, -26, 4];
  around(k, [-60, 60, -60, 60], plaza, -0.1, 0.1, 0x6f9a52);
  around(k, plaza, [BX - 4.3, BX + 4.3, BZ - 4.3, BZ + 4.3], -0.1, 0.1, conc);
  /** the bowl's profile: a flat bottom 2 m down, a quarter-circle transition up to the coping */
  const bowlY = (rr: number) => (rr <= RB ? -2 : rr >= RC ? 0 : -Math.sqrt(Math.max(0, 4 - (rr - RB) ** 2)));
  k.cyl(BX, -2.12, BZ, RB + 0.2, 0.12, 0xaaa69e);
  for (let i = 0; i < N; i++) {
    // one slice of the bowl: four planks up the transition, the deck and the steel coping (local +x points out)
    k.group(BX, BZ, (i / N) * Math.PI * 2, () => {
      for (let j = 0; j < 4; j++) {
        const p0 = (j / 4) * (Math.PI / 2), p1 = ((j + 1) / 4) * (Math.PI / 2);
        const r0 = RB + 2 * Math.sin(p0), y0 = -2 * Math.cos(p0), r1 = RB + 2 * Math.sin(p1), y1 = -2 * Math.cos(p1);
        const tilt = Math.atan2(y1 - y0, r1 - r0);
        const m = k.box(0, 0, 0, Math.hypot(r1 - r0, y1 - y0) + 0.05, 0.1, ((2 * Math.PI * r1) / N) * 1.06, j % 2 ? 0xbab6ae : 0xaeaaa2);
        m.rotation.z = tilt;
        m.position.set((r0 + r1) / 2 + Math.sin(tilt) * 0.1, (y0 + y1) / 2 - Math.cos(tilt) * 0.1, 0);
      }
      k.box((RC + RD) / 2, -0.1, 0, RD - RC, 0.1, ((2 * Math.PI * RD) / N) * 1.04, conc);
      k.box(RC + 0.05, -0.05, 0, 0.1, 0.1, ((2 * Math.PI * RC) / N) * 1.05, 0x8a8e96);
    });
  }
  const UP = new Vector3(0, 1, 0), NRM = new Vector3(), QA = new Quaternion(), QB = new Quaternion();
  /** a skateboard, built along +x like a body facing yaw 0 */
  const board = (deck: number) => k.group(0, 0, 0, () => {
    k.box(0, 0.06, 0, 0.8, 0.025, 0.21, deck);
    for (const x of [-0.26, 0.26]) k.box(x, 0, 0, 0.07, 0.06, 0.19, 0xe8e0c8);
  });
  /** set a board on a surface of normal n, heading yaw */
  const lay = (g: Group, x: number, y: number, z: number, yaw: number, n: Vector3) => {
    g.position.set(x, y, z);
    QA.setFromUnitVectors(UP, n); QB.setFromAxisAngle(UP, yaw);
    g.quaternion.multiplyQuaternions(QA, QB);
  };
  /** the bowl's normal at radius rr along angle a */
  const bowlN = (rr: number, a: number) => {
    if (rr <= RB || rr >= RC) return NRM.copy(UP);
    return NRM.set(Math.cos(a) * ((RB - rr) / 2), Math.sqrt(Math.max(0, 4 - (rr - RB) ** 2)) / 2, -Math.sin(a) * ((RB - rr) / 2)).normalize();
  };
  // skaters taking turns: wait on the coping, drop in, carve round pumping up and down the walls, and come back up to the
  // same spot. The viewer's side of the bowl (angle 3π/2 here) is left to the viewer.
  const n = jam ? 6 : 3 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    const look = visitor(c, 20 + i, r() < 0.45 ? LifeStage.Child : LifeStage.Adult), stoop = look.stoop;
    let a0 = r() * Math.PI * 2;
    if (Math.abs(a0 - 1.5 * Math.PI) < 0.8) a0 += 1.6;
    const P = 8 + r() * 6, wait = 0.22 + r() * 0.18, laps = r() < 0.6 ? 1 : 2, pumps = 2 + Math.floor(r() * 2), dir = r() < 0.5 ? 1 : -1, ph = r() * P;
    const g = board(pick(r, BRIGHT)), A = new Vector3(), B = new Vector3();
    const at = (u: number, o: Vector3) => {
      if (u < wait) return o.set(a0, 4.5, 0);
      const s = (u - wait) / (1 - wait), edge = Math.max(0, 1 - s / 0.06) + Math.max(0, 1 - (1 - s) / 0.06);
      return o.set(a0 + dir * laps * Math.PI * 2 * s, 2.9 + 0.85 * Math.cos(Math.PI * 2 * pumps * s) + 0.75 * edge, 0);
    };
    k.bodies.push({ look, x: BX, y: 0, z: BZ, yaw: 0, swing: 0, pose: 0, ph: 20 + i,
      move: (t, b) => {
        const u = (((t + ph) / P) % 1 + 1) % 1;
        at(u, A); at(Math.min(0.9999, u + 0.004), B);
        const a = A.x, rr = A.y, waiting = u < wait;
        b.x = BX + Math.cos(a) * rr; b.z = BZ - Math.sin(a) * rr; b.y = bowlY(rr);
        const x2 = BX + Math.cos(B.x) * B.y, z2 = BZ - Math.sin(B.x) * B.y;
        b.yaw = waiting ? Math.atan2(-Math.sin(a), -Math.cos(a)) : Math.atan2(-(z2 - b.z), x2 - b.x);
        look.stoop = waiting ? stoop : stoop + 0.3;
        lay(g, b.x, b.y, b.z, b.yaw, bowlN(rr, a));
      } });
  }
  // spectators round the bowl, two sitting on the coping with their legs over the edge
  for (let i = 0; i < (jam ? 12 : 5); i++) {
    let a = r() * Math.PI * 2;
    if (Math.abs(a - 1.5 * Math.PI) < 0.7) a += 1.5;
    const yaw = Math.atan2(-Math.sin(a), -Math.cos(a)) + (r() - 0.5) * 0.5, look = visitor(c, 40 + i, crowdStage(r, 0.35, 0.05));
    if (i < 2) k.sit(look, BX + Math.cos(a) * 4.25, BZ - Math.sin(a) * 4.25, 0.03, yaw, 0, 40 + i);
    else { const rr = 4.7 + r() * 1.0; k.stand(look, BX + Math.cos(a) * rr, BZ - Math.sin(a) * rr, yaw, r() < 0.3 ? 0.5 : 0, 40 + i); }
  }

  // the half-pipe beyond, side on: its rider going up one wall, turning, and up the other
  const HZ = -19.5, HW = 4.6, R2 = 2.8, F2 = 3.0, ply = 0xc8b48a, plyDark = 0x7a6a52;
  const hpY = (x: number) => { const d = Math.abs(x) - F2; return d <= 0 ? 0 : d >= R2 ? R2 : R2 - Math.sqrt(R2 * R2 - d * d); };
  k.box(0, 0, HZ, 2 * F2 + 0.1, 0.06, HW, ply);
  for (const s of [-1, 1]) {
    for (let j = 0; j < 5; j++) {
      const p0 = (j / 5) * (Math.PI / 2), p1 = ((j + 1) / 5) * (Math.PI / 2);
      const x0 = F2 + R2 * Math.sin(p0), y0 = R2 - R2 * Math.cos(p0), x1 = F2 + R2 * Math.sin(p1), y1 = R2 - R2 * Math.cos(p1);
      const tilt = Math.atan2(y1 - y0, x1 - x0), m = k.box(0, 0, 0, Math.hypot(x1 - x0, y1 - y0) + 0.04, 0.06, HW, ply);
      m.rotation.z = s * tilt;
      m.position.set(s * ((x0 + x1) / 2 + Math.sin(tilt) * 0.06), (y0 + y1) / 2 - Math.cos(tilt) * 0.06, HZ);
    }
    k.box(s * (F2 + R2 + 0.8), 0, HZ, 1.6, R2, HW, plyDark);
    k.box(s * (F2 + R2 + 0.03), R2 - 0.05, HZ, 0.1, 0.1, HW, 0x8a8e96);
    for (const z of [-HW / 2 + 0.05, HW / 2 - 0.05]) k.box(s * (F2 + R2 + 1.55), R2, HZ + z, 0.05, 1.0, 0.05, 0x3a3a3c);
    k.box(s * (F2 + R2 + 1.55), R2 + 0.95, HZ, 0.05, 0.05, HW, 0x3a3a3c);
    k.stand(visitor(c, 50 + s, crowdStage(r, 0.4, 0)), s * (F2 + R2 + 0.9), HZ + 1.2 * s, s > 0 ? Math.PI : 0, 0, 50 + s, R2);
  }
  const hl = visitor(c, 30, LifeStage.Adult), hStoop = hl.stoop, hb = board(pick(r, BRIGHT));
  const hAmp = F2 + R2 * 0.9, w2 = (Math.PI * 2) / (4.2 + r() * 1.2), ph2 = r() * 6, hz = HZ + (r() - 0.5);
  k.bodies.push({ look: hl, x: 0, y: 0, z: hz, yaw: 0, swing: 0, pose: 0, ph: 31,
    move: (t, b) => {
      const x = hAmp * Math.sin(w2 * t + ph2);
      b.x = x; b.y = hpY(x); b.z = hz; b.yaw = Math.cos(w2 * t + ph2) >= 0 ? 0 : Math.PI;
      hl.stoop = hStoop + 0.3;
      const d = Math.abs(x) - F2;
      if (d <= 0) NRM.copy(UP); else { const sn = Math.min(1, d / R2); NRM.set(-Math.sign(x) * sn, Math.sqrt(1 - sn * sn), 0); }
      lay(hb, b.x, b.y, b.z, b.yaw, NRM);
    } });

  // a grind rail on the right (a rider boardslides it, rolls round and comes back), a ledge on the left
  const RX = 8.2;
  k.box(RX, 0.4, -8, 0.06, 0.06, 8, 0x9aa0a8);
  for (const z of [-4.4, -8, -11.6]) k.box(RX, 0, z, 0.05, 0.4, 0.05, 0x5a5e66);
  k.box(-9, 0, -9, 0.7, 0.45, 5, 0x9a968e); k.box(-9, 0.45, -9, 0.74, 0.03, 5.04, 0x7a7e86);
  const grind = keyed([
    [0, RX, 0, -0.5], [0.8, RX, 0, -3.6], [1.0, RX, 0.46, -4.1], [3.0, RX, 0.46, -11.8], [3.3, RX, 0, -12.6], [4.2, RX + 0.6, 0, -15.6],
    [5.0, RX + 1.6, 0, -14.6], [8.4, RX + 1.6, 0, -1.6], [9.0, RX + 0.8, 0, -0.2], [9.4, RX, 0, -0.5],
  ]);
  const gl = visitor(c, 32, r() < 0.5 ? LifeStage.Child : LifeStage.Adult), gb = board(pick(r, BRIGHT)), G1 = new Vector3(), G2 = new Vector3(), gPh = r() * 9;
  k.bodies.push({ look: gl, x: RX, y: 0, z: 0, yaw: 0, swing: 0, pose: 0, ph: 32,
    move: (t, b) => {
      const leg = grind(t + gPh, G1); grind(t + gPh + 0.05, G2);
      const i = Math.floor(leg), travel = Math.atan2(-(G2.z - G1.z), G2.x - G1.x), sliding = i === 2;
      b.x = G1.x; b.y = G1.y; b.z = G1.z; b.yaw = travel + (sliding ? Math.PI / 2 : 0);
      b.swing = i === 6 ? 0.25 : 0;
      lay(gb, b.x, b.y, b.z, b.yaw, UP);
    } });

  // the graffiti wall at the back, benches, lamps, the floodlights and trees beyond
  k.box(0, 0, -24.8, 22, 2.4, 0.3, 0x8a8680);
  for (let i = 0; i < 9; i++) k.box(-10 + i * 2.5 + (r() - 0.5) * 0.6, 0.2 + r() * 0.6, -24.64, 1.4 + r() * 1.4, 0.6 + r() * 1.2, 0.02, pick(r, [...BRIGHT, 0xd94fa0, 0x4fd9c8]));
  bench(k, -12.5, -3, Math.PI / 2); bench(k, 12.5, -15, -Math.PI / 2);
  lampPost(k, -14, 2); lampPost(k, 14, -24);
  floodlight(k, -12.5, -15, 9, BX, BZ); floodlight(k, 12.5, -1, 9, BX, BZ);
  treesAround(k, r, 8, 0, -8, 20, 34);

  const mates = companions(c, 2);
  mates.forEach((m, i) => k.stand(m.look, i ? 0.95 : -0.95, -1.25, Math.PI / 2 + (i ? -0.2 : 0.2), 0, i));
  const lights = floodlit(k, BX, 7, BZ, 70);
  return {
    eye: new Vector3(0, eyeStanding(c), -1.4), aim: new Vector3(0, -1.1, -8.5),
    glances: [new Vector3(0, 1.4, HZ), new Vector3(RX, 0.6, -8), new Vector3(-3, -0.5, -6.5), new Vector3(3, -1, -9)],
    label: jam ? 'at the skate jam' : 'watching the skaters', live: () => { lights(); },
  };
};

// ---- the allotment: kneeling at a raised bed --------------------------------------------------------

const allotments: RoomBuilder = (k, c) => {
  const r = rng(seedOf(c) ^ 0xa110);
  const show = during(c, 'allotments');
  outdoors(k, c, { city: 0.6, sun: [0.35, -0.75, -0.5] });
  const SOIL = [0x4a3626, 0x5a4230, 0x3e2e20], GREENS = [0x5a9a3a, 0x3e7a3a, 0x7aa84a, 0x6a8a5a, 0x4a8a4a, 0x8aa85a];
  // the plots in a grid with grass paths between; rows of crops on each, some rows dug over
  const cols = [-12.4, -6.2, 0, 6.2, 12.4], rows = [-2.5, -11.7, -20.9];
  for (const px of cols) for (const pz of rows) {
    if (px === 0 && pz === rows[0]) continue;
    if (show && px === 6.2 && pz === rows[0]) { k.box(px, 0, pz, 5, 0.03, 8, 0x7ab060); continue; }
    k.box(px, 0, pz, 5, 0.03, 8, pick(r, SOIL));
    const n = 3 + Math.floor(r() * 3), along = r() < 0.5, g = pick(r, GREENS);
    for (let i = 0; i < n; i++) {
      if (r() < 0.15) continue;
      const u = (i + 0.5) / n - 0.5, h = 0.15 + r() * 0.3, col = r() < 0.5 ? g : pick(r, GREENS);
      if (along) k.box(px + u * 4.2, 0.03, pz, 0.4, h, 6.8, col); else k.box(px, 0.03, pz + u * 7, 4.3, h, 0.4, col);
    }
  }
  k.box(0, 0, -2.5, 5, 0.03, 8, SOIL[0]);
  // your raised bed: lettuces and onions on the left, cabbages along the back, freshly dug soil on the right
  const timber = pick(r, [0x8a6a4a, 0x6a5a4a, 0x9a7a52]);
  k.box(0, 0, -0.38, 2.6, 0.32, 0.05, timber); k.box(0, 0, -1.52, 2.6, 0.32, 0.05, timber);
  k.box(-1.28, 0, -0.95, 0.05, 0.32, 1.2, timber); k.box(1.28, 0, -0.95, 0.05, 0.32, 1.2, timber);
  k.box(0, 0.02, -0.95, 2.52, 0.27, 1.1, 0x4a3626);
  k.box(0.7, 0.29, -0.78, 0.9, 0.012, 0.6, 0x3a2a1e);
  for (let i = 0; i < 5; i++) { const x = -1.05 + i * 0.28; k.ball(x, 0.35, -0.66, 0.13, 0.08, 0.13, 0x8ac04a); k.ball(x, 0.39, -0.66, 0.07, 0.06, 0.07, 0xb0d870); }
  for (let i = 0; i < 6; i++) k.cone(-1.05 + i * 0.22, 0.29, -0.97, 0.02, 0.22 + r() * 0.08, 0x5a9a4a);
  for (let i = 0; i < 4; i++) { const x = -0.9 + i * 0.6; k.ball(x, 0.33, -1.27, 0.24, 0.07, 0.24, 0x4a7a5a); k.ball(x, 0.42, -1.27, 0.16, 0.14, 0.16, 0x6a9a8a); }
  // your gloved hand with a trowel, working the soil
  const glove = pick(r, [0x6a9a4a, 0xd9a03a, 0x3a6aa8]);
  const hand = k.group(0.45, -0.58, 0.25, () => {
    k.ball(0, 0, 0, 0.055, 0.045, 0.07, glove);
    k.box(0.02, -0.04, 0.2, 0.09, 0.09, 0.26, c.viewer.a[2]);
    k.box(0, -0.015, -0.02, 0.03, 0.03, 0.14, 0x8a5a2a);
    const blade = k.box(0, 0, 0, 0.07, 0.008, 0.14, 0x9aa0a8);
    blade.position.set(0, -0.05, -0.15); blade.rotation.x = -0.7;
  });
  const digPh = r() * 6;
  k.animate.push((t) => {
    const u = t * 0.55 + digPh, s = Math.sin(u * Math.PI * 2);
    hand.position.set(0.45 + 0.02 * Math.sin(u * 0.7), 0.44 + 0.07 * Math.cos(u * Math.PI * 2), -0.58 - 0.03 * s);
    hand.rotation.x = 0.25 * s;
  });
  // a robin on the turned soil, hopping about by the trowel
  const robin = k.group(0, 0, 0, () => {
    k.ball(0, 0.06, 0, 0.055, 0.045, 0.042, 0x7a5a3a); k.ball(0.03, 0.065, 0, 0.035, 0.035, 0.036, 0xd8582a);
    k.ball(0.055, 0.1, 0, 0.03, 0.03, 0.03, 0x7a5a3a); k.box(0.085, 0.092, -0.004, 0.025, 0.008, 0.008, 0x2a2a2a);
    k.box(-0.07, 0.07, -0.012, 0.05, 0.012, 0.024, 0x6a4a2a);
  });
  const hopAt = (n: number, o: Vector3) => o.set(0.85 + 0.22 * Math.sin(n * 0.9 + 1.3) + 0.08 * Math.sin(n * 2.1), 0.29, -0.82 + 0.16 * Math.sin(n * 0.7) + 0.05 * Math.sin(n * 1.9));
  const H0 = new Vector3(), H1 = new Vector3();
  k.animate.push((t) => {
    const s = t / 0.85, n = Math.floor(s), u = s - n;
    hopAt(n, H0); hopAt(n + 1, H1);
    if (u < 0.15) {
      const f = smooth(u / 0.15);
      robin.position.lerpVectors(H0, H1, f); robin.position.y += 0.06 * Math.sin((u / 0.15) * Math.PI); robin.rotation.z = 0;
    } else { robin.position.copy(H1); robin.rotation.z = hash2(n, 5) < 0.4 && u > 0.5 && u < 0.7 ? -0.5 : 0; }
    robin.rotation.y = Math.atan2(-(H1.z - H0.z), H1.x - H0.x);
  });
  // a watering can and a trug of what you have picked
  k.cyl(-1.6, 0, -1.9, 0.13, 0.28, 0x5a8a5a); k.box(-1.6, 0.28, -1.9, 0.03, 0.1, 0.22, 0x5a8a5a);
  bar(k, new Vector3(-1.5, 0.1, -1.9), new Vector3(-1.25, 0.36, -1.9), 0.03, 0x5a8a5a); k.cone(-1.24, 0.34, -1.9, 0.05, 0.06, 0x5a8a5a);
  k.box(1.55, 0, -1.6, 0.5, 0.15, 0.3, 0x9a7a4a);
  for (let i = 0; i < 3; i++) k.ball(1.4 + i * 0.14, 0.17, -1.6, 0.06, 0.06, 0.06, pick(r, [0x8a2a4a, 0xe07a2a, 0xc0392b]));
  // runner beans up an avenue of canes, scarlet flowers here and there
  for (let i = 0; i < 6; i++) {
    const x = -1.9 + i * 0.76;
    for (const s of [-1, 1]) bar(k, new Vector3(x, 0, -3.4 + s * 0.35), new Vector3(x, 2.15, -3.4 - s * 0.05), 0.022, 0xa08a5a);
    for (let j = 0; j < 2; j++) k.ball(x + (r() - 0.5) * 0.2, 0.6 + j * 0.75 + r() * 0.2, -3.4 + (r() - 0.5) * 0.3, 0.2, 0.32, 0.18, pick(r, [0x4a8a3a, 0x3e7a3a, 0x5a9a4a]));
    if (r() < 0.8) k.ball(x + 0.1, 1.2 + r() * 0.6, -3.2, 0.035, 0.035, 0.035, 0xd8402a);
  }
  bar(k, new Vector3(-2.3, 2.05, -3.42), new Vector3(2.3, 2.05, -3.42), 0.022, 0xa08a5a);
  // two cabbage whites over the beans
  for (let i = 0; i < 2; i++) {
    const wl: Group[] = [];
    const fly = k.group(0, 0, 0, () => { for (const s of [-1, 1]) wl.push(k.group(0, 0, 0, () => { k.box(0, 0, s * 0.03, 0.04, 0.004, 0.05, 0xf4f4ec); })); });
    const ph = r() * 6, cx = -1 + i * 2;
    k.animate.push((t) => {
      fly.position.set(cx + 0.8 * Math.sin(t * 0.5 + ph), 1.2 + 0.3 * Math.sin(t * 1.3 + ph) + 0.1 * Math.sin(t * 5), -2.6 + 0.5 * Math.sin(t * 0.37 + ph * 2));
      fly.rotation.y = t * 0.8 + ph; const f = 0.9 * Math.sin(t * 16 + ph); wl[0].rotation.x = f; wl[1].rotation.x = -f;
    });
  }
  // sheds in different colours, water butts, a greenhouse, compost bins, sunflowers and the scarecrow
  const SHEDS = [0x3a6a4a, 0x8a3a2a, 0x2f5a8a, 0xd8c890, 0x6a4a32, 0x5a8a9a];
  const off = Math.floor(r() * SHEDS.length);
  ([[-5.4, -14.6, 0], [11.6, -5.0, -Math.PI / 2], [-11.6, -18.5, Math.PI / 2], [7.2, -24.0, 0]] as [number, number, number][]).forEach(([x, z, ry], i) => {
    shed(k, x, z, ry, SHEDS[(off + i) % SHEDS.length]);
    const bx = x + Math.cos(ry) * 1.5, bz = z - Math.sin(ry) * 1.5 + 0.3;
    k.cyl(bx, 0, bz, 0.32, 0.95, 0x2a4a32); k.cyl(bx, 0.95, bz, 0.33, 0.04, 0x1a1a1a);
  });
  const glass = glassy(k, 0xd8ece6, 0.32);
  const gx = 5.8, gz = -10.0;
  k.box(gx, 0, gz, 3.0, 0.45, 2.2, 0xb8b0a0);
  for (let i = 0; i < 3; i++) { k.ball(gx - 0.9 + i * 0.9, 0.9, gz, 0.22, 0.45, 0.22, 0x4a8a3a); for (let j = 0; j < 2; j++) k.ball(gx - 0.8 + i * 0.9 + j * 0.15, 0.8 + j * 0.25, gz + 0.2, 0.05, 0.05, 0.05, 0xd8302a); }
  k.box(gx, 0.45, gz, 3.0, 1.35, 2.2, glass);
  for (const s of [-1, 1]) { const m = k.box(gx, 0, gz, 3.1, 0.03, 1.25, glass); m.position.set(gx, 2.06, gz + s * 0.55); m.rotation.x = s * 0.5; }
  for (const [ox, oz] of [[-1.5, -1.1], [1.5, -1.1], [-1.5, 1.1], [1.5, 1.1]]) k.box(gx + ox, 0.45, gz + oz, 0.04, 1.35, 0.04, 0xf4f4f0);
  k.box(gx, 2.3, gz, 3.05, 0.04, 0.05, 0xf4f4f0);
  for (const x of [-14.2, -13.2]) k.box(x, 0, -9.0, 0.9, 0.9, 0.9, 0x6a4a2a);
  for (let i = 0; i < 4; i++) {
    const z = -3.6 - i * 0.8, h = 1.8 + r() * 0.5;
    k.box(-4.1, 0, z, 0.04, h, 0.04, 0x5a8a3a);
    const head = k.cyl(-4.1, h, z, 0.2, 0.04, 0xe6b734); head.rotation.x = Math.PI / 2 - 0.3;
    const mid = k.cyl(-4.1, h + 0.01, z + 0.02, 0.09, 0.04, 0x5a3a1a); mid.rotation.x = Math.PI / 2 - 0.3;
  }
  const coat = pick(r, [0x5a4a6a, 0x6a3a2a, 0x3a4a6a, 0x5a6a3a]);
  const crow = k.group(-5.0, -9.4, 0.25, () => {
    k.box(0, 0, 0, 0.07, 1.75, 0.07, 0x7a5a3a); k.box(0, 1.3, 0, 1.3, 0.07, 0.07, 0x7a5a3a);
    k.box(0, 0.75, 0, 0.5, 0.65, 0.28, coat); k.box(0, 1.22, 0, 1.2, 0.16, 0.18, coat);
    k.ball(0, 1.62, 0, 0.15, 0.17, 0.15, 0xd8c078);
    k.cyl(0, 1.74, 0, 0.13, 0.18, 0x2a2a2a); k.cyl(0, 1.74, 0, 0.24, 0.025, 0x2a2a2a);
    for (const s of [-1, 1]) k.cone(s * 0.62, 1.3, 0, 0.06, 0.16, 0xe0c060).rotation.z = -s * Math.PI / 2;
  });
  k.animate.push((t) => { crow.rotation.z = 0.025 * Math.sin(t * 0.7); });
  // neighbours digging their plots, bending to it and straightening up; one wheeling a barrow along the path
  ([[-7.4, -12.2, -Math.PI / 2 + 0.4], [4.8, -19.6, -Math.PI / 2 - 0.3], [-12.8, -14.0, -0.4]] as [number, number, number][]).forEach(([x, z, yaw], i) => {
    const look = visitor(c, 60 + i, crowdStage(r, 0.05, 0.55)), base = look.stoop, ph = r() * 6, wd = 0.6 + r() * 0.3;
    k.bodies.push({ look, x, y: 0, z, yaw, swing: 0, pose: -0.7, ph: 60 + i,
      move: (t) => { const u = 0.5 + 0.5 * Math.sin(t * wd + ph); look.stoop = base + 0.15 + 0.75 * u * u; } });
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);
    bar(k, new Vector3(x + fx * 0.55, 0.15, z + fz * 0.55), new Vector3(x + fx * 0.5, 1.0, z + fz * 0.5), 0.03, 0x8a6a3a);
    k.box(x + fx * 0.55, 0, z + fz * 0.55, 0.18, 0.25, 0.03, 0x6a6e76, yaw + Math.PI / 2);
  });
  const barrowMan = lineWalker(k, visitor(c, 70, crowdStage(r, 0, 0.5)), -15, -7.1, 15, -7.1, 0.7, r());
  const barrow = k.group(0, 0, 0, () => {
    k.box(0.15, 0.3, 0, 0.9, 0.3, 0.6, 0x3a6a8a); k.ball(0.15, 0.6, 0, 0.35, 0.12, 0.25, 0x4a3626);
    const wh = k.cyl(0.65, 0.18, -0.03, 0.18, 0.06, 0x2a2a2a); wh.rotation.x = Math.PI / 2;
    for (const s of [-1, 1]) { bar(k, new Vector3(-0.55, 0.62, s * 0.25), new Vector3(0.6, 0.3, s * 0.2), 0.03, 0x5a5e66); k.box(-0.15, 0, s * 0.2, 0.04, 0.3, 0.04, 0x5a5e66); }
  });
  const bMove = barrowMan.move!;
  barrowMan.move = (t, b) => { bMove(t, b); barrow.position.set(b.x + Math.cos(b.yaw) * 0.85, 0, b.z - Math.sin(b.yaw) * 0.85); barrow.rotation.y = b.yaw; };
  lineWalker(k, visitor(c, 71, crowdStage(r, 0.1, 0.5)), 15, -16.3, -15, -16.3, 0.9, r());
  const sitter = visitor(c, 72, LifeStage.Retired);
  sitter.b = [sitter.b[0], sitter.b[1], sitter.b[2], sitter.b[3] & ~BIT(13)];
  k.box(-10.4, 0, -16.6, 0.45, 0.45, 0.42, 0x3a5a3a); k.box(-10.4, 0.45, -16.82, 0.45, 0.45, 0.04, 0x3a5a3a);
  k.sit(sitter, -10.4, -16.6, 0.47, -Math.PI / 2 + 0.5, 0.4, 72);
  k.cyl(-9.95, 0, -16.3, 0.05, 0.3, 0x2a5a8a);
  // the hedge at the far end and trees beyond
  k.box(0, 0, -26.5, 40, 1.8, 1.2, 0x3a6a3a);
  treesAround(k, r, 8, 0, -10, 22, 34);
  // the harvest show: a marquee on the next plot, the prize vegetables on the table and people looking them over
  if (show) {
    const mx = 6.2, mz = -3.0;
    for (const [ox, oz] of [[-1.8, -1.3], [1.8, -1.3], [-1.8, 1.3], [1.8, 1.3]]) k.cyl(mx + ox, 0, mz + oz, 0.04, 2.2, 0xf4f4f0);
    k.box(mx, 2.2, mz, 3.8, 0.12, 2.8, 0xf4f4f0); k.cone(mx, 2.32, mz, 2.3, 0.8, 0xf4f4f0);
    k.box(mx, 0, mz - 0.6, 3.0, 0.75, 0.8, 0x3a7a4a);
    for (let i = 0; i < 3; i++) k.ball(mx - 1 + i, 0.92, mz - 0.6, 0.2, 0.17, 0.2, 0xe07a2a);
    for (const s of [-1, 1]) k.ball(mx + s * 0.5, 0.85, mz - 0.45, 0.3, 0.1, 0.1, 0x4a7a3a);
    for (const [col, x] of [[0xc0392b, -1.2], [0x2e86de, 0.2]] as [number, number][]) k.cyl(mx + x, 0.75, mz - 0.18, 0.06, 0.02, col);
    for (let i = 0; i < 3; i++) k.stand(visitor(c, 80 + i, crowdStage(r, 0.2, 0.4)), mx - 1 + i, mz + 0.4 + r() * 0.4, Math.PI / 2 + (r() - 0.5) * 0.6, 0, 80 + i);
  }
  // the family kneeling beside you
  companions(c, 2).forEach((m, i) => k.sit(m.look, i ? 0.95 : -0.9, 0.05, m.child ? 0.35 : 0.5, Math.PI / 2 + (i ? -0.25 : 0.25), -0.6, i));
  const eyeY = 0.25 + 0.8 * c.viewer.height;
  return {
    eye: new Vector3(0, eyeY, 0.15), aim: new Vector3(0.1, 0.42, -1.7),
    glances: [new Vector3(0.85, 0.32, -0.82), new Vector3(-5.0, 1.3, -9.4), new Vector3(-7.4, 0.9, -12.2), new Vector3(5.8, 1.0, -10.0), new Vector3(0, 1.4, -3.4)],
    label: show ? 'at the harvest show' : 'tending the allotment',
  };
};

// ---- the fishing lake: on a peg at the water's edge -----------------------------------------------

const fishing: RoomBuilder = (k, c) => {
  const r = rng(seedOf(c) ^ 0xf15);
  const match = during(c, 'fishing');
  outdoors(k, c, { city: 0.4, sun: [0.4, -0.6, -0.6] });
  const water = pick(r, [0x4a7a86, 0x3f6f7a, 0x557f7a]), mud = 0x6a5a3a;
  // the lake from your peg to the far shore 33 m off
  k.box(0, -0.06, -30.6, 120, 0.08, 58.8, water);
  k.box(0, 0, -47, 120, 0.3, 26, 0x5f8f4a);
  k.box(0, -0.05, -34.1, 120, 0.35, 0.3, mud);
  k.box(0, 0, -1.05, 120, 0.025, 0.4, mud);
  // your peg: decking out over the water, its number on a post, your chair
  k.box(0, 0, -0.7, 1.6, 0.1, 1.5, 0x8a6a4a);
  for (const x of [-0.4, 0.4]) k.box(x, 0.1, -0.7, 0.02, 0.003, 1.5, 0x5a4232);
  k.box(-0.95, 0, -0.2, 0.06, 0.7, 0.06, 0x8a6a4a); k.box(-0.95, 0.55, -0.17, 0.3, 0.22, 0.02, 0xf4f4f0);
  k.box(0, 0.48, 0.02, 0.45, 0.04, 0.42, 0x2f4a3a); k.box(0, 0.52, 0.22, 0.45, 0.45, 0.03, 0x2f4a3a);
  // tackle box, bait tub, flask and landing net round you
  k.box(-0.55, 0.1, -0.45, 0.45, 0.2, 0.3, 0x3a5a3a); k.cyl(0.55, 0.1, -0.6, 0.08, 0.1, 0xf4f4f0); k.cyl(-0.45, 0.1, 0.25, 0.05, 0.3, 0x2a5a3a);
  bar(k, new Vector3(0.75, 0.13, -0.1), new Vector3(0.6, 0.11, -1.4), 0.025, 0x2a2a2a); k.ball(0.58, 0.11, -1.6, 0.25, 0.02, 0.22, 0x2a3a2a);
  bar(k, new Vector3(-0.55, 0.1, -1.3), new Vector3(-0.85, -0.3, -2.6), 0.3, 0x2a3a2a);
  // the rod from your hands out over the water, the line down to the float
  const eyeY = eyeSitting(c, 0.52);
  const butt = new Vector3(0.14, eyeY - 0.62, 0.05), tip0 = new Vector3(1.45, 2.55, -4.7), tip = tip0.clone(), mid = new Vector3().lerpVectors(butt, tip0, 0.45);
  const rodA = bar(k, butt, mid, 0.03, 0x2a2a30), rodB = bar(k, mid, tip, 0.015, 0x3a3a40);
  const hand = new Vector3().lerpVectors(butt, tip0, 0.1);
  k.ball(hand.x, hand.y, hand.z, 0.045, 0.04, 0.06, c.viewer.a[0]);
  bar(k, hand, new Vector3(0.3, eyeY - 0.75, 0.25), 0.09, c.viewer.a[2]);
  k.cyl(hand.x + 0.01, hand.y - 0.09, hand.z + 0.06, 0.045, 0.05, 0x3a3a40).rotation.z = Math.PI / 2;
  const fp = new Vector3(2.0, 0, -8.4), FL = new Vector3();
  const flo = k.group(fp.x, fp.z, 0, () => { k.cyl(0, -0.04, 0, 0.028, 0.08, 0xe6c23a); k.cone(0, 0.04, 0, 0.028, 0.09, 0xe0402a); });
  const line = bar(k, tip, fp, 0.008, 0xd8d8d8);
  // ripples: a light ring (a pale disc under a water-coloured one), round the float and where fish rise
  const rings = [0, 1, 2].map(() => [k.cyl(0, -1, 0, 0.5, 0.004, 0x9ac0c8), k.cyl(0, -1, 0, 0.5, 0.004, water)] as [Mesh, Mesh]);
  const ring = (i: number, x: number, z: number, g: number) => {
    const [o, n] = rings[i];
    if (g < 0) { o.position.y = n.position.y = -1; return; }
    const rad = 0.1 + 1.4 * g;
    o.position.set(x, 0.022, z); n.position.set(x, 0.026, z);
    o.scale.set(rad * 2, 0.004, rad * 2); n.scale.set(rad * 1.7, 0.004, rad * 1.7);
  };
  const fish = k.ball(0, -1, 0, 0.12, 0.05, 0.04, 0xb8c0c8);
  // the float bobs; every so often a nibble dips it twice and you strike, the rod lifting
  const P = 16 + r() * 10, phB = r() * P;
  k.animate.push((t) => {
    const u = (t + phB) % P;
    let y = 0.02 + 0.008 * Math.sin(t * 2.3 + 1) + 0.005 * Math.sin(t * 3.9), lift = 0;
    if ((u > P - 4 && u < P - 3.75) || (u > P - 3.35 && u < P - 3.1)) y -= 0.05;
    if (u > P - 2.6 && u < P - 1.0) { lift = Math.sin(((u - (P - 2.6)) / 1.6) * Math.PI); y = -0.15; }
    FL.set(fp.x - lift * 0.5, y, fp.z + lift * 1.2);
    flo.position.copy(FL);
    tip.set(tip0.x + 0.03 * Math.sin(t * 0.9) - lift * 0.2, tip0.y + 0.02 * Math.sin(t * 1.3) + lift * 0.7, tip0.z + lift * 0.6);
    mid.lerpVectors(butt, tip, 0.45);
    setBar(rodA, butt, mid, 0.03); setBar(rodB, mid, tip, 0.015);
    FL.y = Math.max(y, 0.02) + 0.07;
    setBar(line, tip, FL, 0.008);
    const d = u - (P - 4);
    ring(0, fp.x, fp.z, d >= 0 && d < 2.5 ? d / 2.5 : ((t * 0.2) % 1) < 0.5 ? ((t * 0.2) % 1) * 0.6 : -1);
    for (let i = 1; i < 3; i++) {
      const T = 9 + i * 2.3, s = t / T + i * 0.37, n = Math.floor(s), g = s - n;
      const x = (hash2(n, 11 + i) - 0.5) * 20, z = -5 - hash2(n, 13 + i) * 20;
      ring(i, x, z, g < 0.6 ? g / 0.6 : -1);
      if (i === 1) {
        if (g < 0.07) { fish.position.set(x, 0.02 + Math.sin((g / 0.07) * Math.PI) * 0.45, z); fish.rotation.z = (0.5 - g / 0.07) * 2; }
        else fish.position.y = -1;
      }
    }
  });
  // reeds along this bank, a spit with a heron standing in the shallows
  for (let i = 0; i < 12; i++) reeds(k, r, (i % 2 ? 1 : -1) * (2.8 + r() * 12), -1.3 - r() * 1.4, 4, 1.2 + r() * 0.6);
  k.cyl(-7.5, -0.06, -12.8, 2.3, 0.14, 0x6a6a3a);
  reeds(k, r, -8.4, -13.2, 5, 1.5); reeds(k, r, -7.0, -13.8, 4, 1.3);
  k.ball(-8.4, 0.3, -12.6, 0.8, 0.6, 0.7, 0x4a6a3a);
  const hr = heron(k, -5.9, -11.9, 0.2);
  k.animate.push((t) => { const u = (t * 0.07) % 1; hr.neck.rotation.z = u > 0.92 ? -0.5 * Math.sin(((u - 0.92) / 0.08) * Math.PI) : 0.05 * Math.sin(t * 0.3); });
  // other anglers along the bank under green umbrellas (more of them on match day), two on the far shore
  const angler = (x: number, z: number, slot: number, y = 0, far = false) => {
    const yaw = far ? -Math.PI / 2 : Math.PI / 2, dz = far ? 1 : -1;
    k.box(x, y, z, 0.45, 0.42, 0.42, 0x2f4a3a); k.box(x, y + 0.42, z - dz * 0.2, 0.45, 0.45, 0.04, 0x2f4a3a);
    k.sit(visitor(c, 30 + slot, crowdStage(r, 0.08, 0.4)), x, z, y + 0.44, yaw + (r() - 0.5) * 0.3, 0, 30 + slot);
    bar(k, new Vector3(x - 0.4, y, z - dz * 0.4), new Vector3(x, y + 2.0, z), 0.03, 0x3a3a3a);
    k.cone(x, y + 1.8, z, 1.25, 0.5, pick(r, [0x2f5a3a, 0x3a6a2a, 0x24483a])).rotation.x = 0.3 * dz;
    bar(k, new Vector3(x + 0.15, y + 0.85, z + dz * 0.3), new Vector3(x + 1.2, y + 2.3, z + dz * 4.2), 0.02, 0x2a2a30);
    k.box(x - 0.6, y, z, 0.45, 0.25, 0.3, 0x3a5a3a);
  };
  const pegs = match ? [-9.5, 9.0, -16.5, 16.5, -23.5, 23.5, -30, 30] : [-9.5, 9.0, -16.5, 16.5];
  pegs.forEach((x, i) => angler(x, -0.2, i));
  angler(-12, -35.5, 20, 0.3, true); angler(8, -35.6, 21, 0.3, true);
  // the far shore: trees, a willow leaning over the water, the bailiff's hut and reed beds
  for (let i = 0; i < 9; i++) (r() < 0.7 ? tree : pine)(k, r, -36 + i * 9 + (r() - 0.5) * 4, -38 - r() * 9, 0.9 + r() * 0.6);
  k.cyl(-3, 0.3, -35.5, 0.25, 2.6, 0x5a4a32);
  for (let i = 0; i < 3; i++) k.ball(-3 + (i - 1) * 1.3, 2.4 + (i % 2) * 0.5, -35 + i * 0.2, 1.6, 2.0, 1.4, 0x7a9a4a);
  k.box(14, 0.3, -37.5, 2.4, 2.0, 2.0, 0x4a6a4a); k.box(14, 2.3, -37.5, 2.7, 0.15, 2.3, 0x3a3a3c);
  for (const x of [10, -18]) k.box(x, 0.3, -34.6, 8, 0.9, 1.0, 0x8a8a4a);
  // ducks and coots paddling
  const birds: Paddler[] = [];
  for (let i = 0; i < 3; i++) birds.push({ g: duck(k, r, 0, 0.02, 0, 0), cx: -2 + r() * 12, cz: -14 - r() * 10, rx: 2 + r() * 4, rz: 1 + r() * 2, w: (0.05 + r() * 0.06) * (r() < 0.5 ? 1 : -1), ph: r() * 6 });
  for (let i = 0; i < 2; i++) birds.push({ g: coot(k), cx: 6 + r() * 8, cz: -18 - r() * 8, rx: 1 + r() * 2, rz: 0.8 + r(), w: (0.08 + r() * 0.06) * (r() < 0.5 ? 1 : -1), ph: r() * 6 });
  paddle(k, birds);
  // early-morning mist on the water: see-through sheets one behind another, so the further shore is the paler
  const mist = glassy(k, 0xe4ecf0, 0);
  const sheets = ([[-4.5, 1.0], [-11, 1.8], [-20, 3.0], [-32, 6.5]] as [number, number][]).map(([z, h]) => k.box(0, 0.02, z, 120, h, 0.04, mist));
  const mistAt = (hour: number) => { mist.opacity = 0.22 * clamp((9.2 - hour) / 3, 0, 1); for (const s of sheets) s.visible = mist.opacity > 0.01; };
  mistAt(c.hour);
  const mates = companions(c, 1);
  if (mates[0]) { k.box(-1.25, 0, 0.05, 0.45, 0.44, 0.42, 0x2f4a3a); k.box(-1.25, 0.44, 0.25, 0.45, 0.42, 0.04, 0x2f4a3a); k.sit(mates[0].look, -1.25, 0.03, 0.46, Math.PI / 2 + 0.15, 0, 1); }
  return {
    eye: new Vector3(0, eyeY, 0.02), aim: new Vector3(fp.x, 0.1, fp.z),
    glances: [new Vector3(-5.9, 0.8, -11.9), new Vector3(9, 0.9, -0.6), new Vector3(-4, 0.2, -16), new Vector3(0, 1.5, -36)],
    label: match ? 'in the fishing match' : 'fishing at the lake', live: (hour) => { mistAt(hour); },
  };
};

// ---- the nature reserve: inside the bird hide --------------------------------------------------------

const reserve: RoomBuilder = (k, c) => {
  const r = rng(seedOf(c) ^ 0xb1d);
  const dawn = during(c, 'reserve');
  // the sun ahead over the lake: it lights the water and the far side of things, not the hide's dark inner walls
  outdoors(k, c, { city: 0.25, ground: 0x6a9a50, sun: [-0.3, -0.55, 0.78] });
  const water = 0x4a7a8e;
  k.box(0, -0.06, -30, 120, 0.08, 56, water);
  k.box(0, 0, -48, 120, 0.35, 24, 0x6a8a4a);
  k.box(0, 0.35, -37.5, 120, 0.02, 3, 0x9aaa4a);
  // reed beds either side of the open water in front, a few low clumps further out, lily pads
  for (let i = 0; i < 12; i++) reeds(k, r, (i % 2 ? 1 : -1) * (2.4 + r() * 11), -2.4 - r() * 3.6, 5, 1.4 + r() * 0.7);
  for (let i = 0; i < 3; i++) reeds(k, r, (r() - 0.5) * 4, -6.5 - r() * 2, 3, 1.0);
  for (let i = 0; i < 6; i++) k.cyl((r() - 0.5) * 10, 0.02, -5 - r() * 6, 0.2 + r() * 0.15, 0.01, 0x3a6a3a);
  // an island with a dead tree, cormorants on it (one drying its wings)
  k.cyl(6, -0.06, -17, 2.6, 0.16, 0x5a6a3a);
  bar(k, new Vector3(6.3, 0.1, -17.2), new Vector3(6.6, 3.2, -17.4), 0.12, 0x8a8278);
  bar(k, new Vector3(6.5, 2.2, -17.3), new Vector3(7.6, 2.9, -17.2), 0.06, 0x8a8278);
  bar(k, new Vector3(6.55, 2.7, -17.35), new Vector3(5.6, 3.4, -17.3), 0.06, 0x8a8278);
  for (const [x, y, spread] of [[7.4, 2.95, true], [5.8, 3.42, false]] as [number, number, boolean][]) {
    k.ball(x, y + 0.14, -17.25, 0.09, 0.16, 0.08, 0x1a1a1e); k.ball(x + 0.03, y + 0.34, -17.25, 0.05, 0.05, 0.045, 0x1a1a1e);
    if (spread) for (const s of [-1, 1]) k.box(x, y + 0.12, -17.25 + s * 0.2, 0.06, 0.2, 0.32, 0x26262a);
  }
  // a heron in the shallows, ducks and coots and a swan on the water, birds flying loops over the far shore
  const hr = heron(k, -3.6, -9.6, 0.3);
  k.animate.push((t) => { const u = (t * 0.06 + 0.3) % 1; hr.neck.rotation.z = u > 0.93 ? -0.5 * Math.sin(((u - 0.93) / 0.07) * Math.PI) : 0.05 * Math.sin(t * 0.25); });
  const fowl: Paddler[] = [];
  for (let i = 0; i < 6; i++) fowl.push({ g: duck(k, r, 0, 0.02, 0, 0), cx: -6 + r() * 12, cz: -9 - r() * 12, rx: 1 + r() * 3, rz: 0.6 + r() * 1.5, w: (0.06 + r() * 0.08) * (r() < 0.5 ? 1 : -1), ph: r() * 6 });
  for (let i = 0; i < 2; i++) fowl.push({ g: coot(k), cx: -2 + r() * 8, cz: -12 - r() * 6, rx: 1 + r() * 2, rz: 0.6 + r(), w: (0.1 + r() * 0.05) * (r() < 0.5 ? 1 : -1), ph: r() * 6 });
  fowl.push({ g: swan(k), cx: -6, cz: -20, rx: 4, rz: 2, w: 0.05, ph: r() * 6 });
  paddle(k, fowl);
  flock(k, r, 5, 0, 6, -26, 30, [0x3a3a3e, 0x5a5048, 0xf4f4f0]);
  for (let i = 0; i < 10; i++) (r() < 0.6 ? tree : pine)(k, r, -40 + i * 9 + (r() - 0.5) * 4, -40 - r() * 8, 0.9 + r() * 0.6);
  for (const x of [-14, 9]) k.box(x, 0.35, -36.3, 10, 1.0, 1.2, 0x8a8a4a);
  // the sun glittering on the water ahead
  const glints: Mesh[] = [];
  for (let i = 0; i < 10; i++) { const d = 8 + r() * 22; glints.push(k.box(0.38 * d + (r() - 0.5) * 3, 0.021, -d, 0.25, 0.004, 0.06, k.glow(0xfff8e0, 1.3))); }
  k.animate.push((t) => {
    const day = night() < 0.4;
    glints.forEach((m, i) => { const s = Math.max(0, Math.sin(t * (3 + i * 0.37) + i * 2.1)); m.visible = day && s > 0.2; m.scale.x = 0.25 * s; });
  });

  // the hide: dark timber round you, the long viewing slot (its flap propped up outside), a ledge, the bench
  const wood = pick(r, [0x4a3626, 0x3e2e22, 0x54402e]), dark = 0x2a1e16, F = 0.3, X = 2.2, Z0 = -0.7, Z1 = 1.4, TOP = 2.6;
  const S0 = 1.12, S1 = 1.75, SW = 1.9;
  k.box(0, 0, (Z0 + Z1) / 2, 2 * X + 0.3, F, Z1 - Z0 + 0.3, dark);
  k.box(0, 0, Z0 - 0.04, 2 * X + 0.3, S0, 0.08, wood);
  k.box(0, S1, Z0 - 0.04, 2 * X + 0.3, TOP - S1, 0.08, wood);
  for (const s of [-1, 1]) k.box(s * (SW + (X + 0.15 - SW) / 2), S0, Z0 - 0.04, X + 0.15 - SW, S1 - S0, 0.08, wood);
  for (const x of [-0.7, 0.7]) k.box(x, S0, Z0 - 0.04, 0.07, S1 - S0, 0.07, dark);
  for (const s of [-1, 1]) k.box(s * (X + 0.04), 0, (Z0 + Z1) / 2, 0.08, TOP, Z1 - Z0 + 0.16, wood);
  k.box(0, 0, Z1 + 0.04, 2 * X + 0.16, TOP, 0.08, wood);
  k.box(1.2, F, Z1 - 0.005, 0.8, 1.9, 0.02, dark);
  k.box(0, TOP, (Z0 + Z1) / 2 - 0.2, 2 * X + 0.6, 0.1, Z1 - Z0 + 0.8, dark);
  for (const s of [-1, 1]) for (const y of [0.9, 1.6, 2.2]) k.box(s * (X - 0.01), y, (Z0 + Z1) / 2, 0.02, 0.06, Z1 - Z0, dark);
  k.box(0, S0 - 0.04, Z0 + 0.13, 2 * X, 0.04, 0.26, 0x6a5038);
  const flap = k.group(0, Z0 - 0.08, 0, () => { k.box(0, 0, -0.25, 2 * SW + 0.1, 0.035, 0.5, wood); });
  flap.position.y = S1 + 0.02; flap.rotation.x = 0.45;
  k.box(0, F + 0.4, 0.45, 2 * X - 0.1, 0.05, 0.38, 0x5a4230); k.box(0, F, 0.3, 2 * X - 0.1, 0.4, 0.04, dark);
  k.box(-0.4, S0, Z0 + 0.12, 0.08, 0.24, 0.08, 0x2a5a3a); k.box(-1.3, F, 0.75, 0.35, 0.4, 0.25, 0x3a4a6a);
  // the bird chart on the left wall: twelve birds in their colours under a green title band
  k.box(-X + 0.015, 1.45, 0.45, 0.03, 0.75, 1.1, 0xe8e2cc);
  k.box(-X + 0.032, 2.08, 0.45, 0.006, 0.08, 1.0, 0x3a6a4a);
  const CHART = [[0x7a5a3a, 0xd8582a], [0x3a6ab8, 0xe8c83a], [0x2a7ab8, 0xe0802a], [0x2a2a2a, 0xf4f4f0], [0x8a8e98, 0xe8e8e8], [0x6a5a4a, 0x1f6a3a],
    [0xc8a040, 0xd83a2a], [0x5a4a3a, 0xe8d8b8], [0xf4f4f0, 0xe0a030], [0x1a1a1a, 0xd8b030], [0x9aa0a8, 0x1a1a1a], [0x5a7a3a, 0xe8c83a]];
  CHART.forEach(([body, head], i) => {
    const z = 0.06 + (i % 4) * 0.26, y = 1.62 + Math.floor(i / 4) * 0.17;
    k.ball(-X + 0.035, y, z, 0.012, 0.035, 0.06, body); k.ball(-X + 0.038, y + 0.03, z + 0.05, 0.012, 0.024, 0.024, head);
  });
  // birdwatchers along the bench (your family beside you), binoculars up; one at a telescope on a tripod
  const mates = companions(c, 2), seats = [-0.8, 0.8, -1.6, 1.6], watchers = dawn ? 4 : 2 + Math.floor(r() * 2);
  const glances: Vector3[] = [];
  seats.forEach((x, i) => {
    const look = mates[i]?.look ?? (i < watchers ? visitor(c, 10 + i, crowdStage(r, 0.1, 0.45)) : null);
    if (!look) return;
    look.b = [look.b[0], look.b[1], look.b[2], look.b[3] & ~BIT(13)];
    look.stoop = Math.max(look.stoop, 0.22);
    const scope = i === 3 && !mates[i];
    k.sit(look, x, 0.42, F + 0.45, Math.PI / 2, scope ? 0 : 0.45, 10 + i);
    const ey = F + 0.45 + 0.04 + (1.6 - HIP_M) * look.height - 0.03, fz = 0.42 - 0.75 * look.height * Math.sin(look.stoop) - 0.16;
    if (scope) {
      bar(k, new Vector3(x, ey - 0.02, fz + 0.04), new Vector3(x, ey + 0.03, Z0 + 0.05), 0.075, 0x3a4a3a);
      for (const [dx, dz] of [[-0.25, 0.1], [0.25, 0.1], [0, -0.25]]) bar(k, new Vector3(x, ey - 0.1, -0.15), new Vector3(x + dx, F, -0.15 + dz), 0.025, 0x2a2a2a);
    } else k.box(x, ey - 0.035, fz, 0.13, 0.065, 0.11, 0x2a2a2e);
    if (glances.length < 2) glances.push(new Vector3(x, ey, 0.4));
  });
  const eye = new Vector3(0, Math.max(F + 0.45 + 0.75 * c.viewer.height, 1.36), 0.12);
  return {
    eye, aim: new Vector3(0, 0.9, -16),
    glances: [new Vector3(-3.6, 0.7, -9.6), new Vector3(-X, 1.85, 0.45), ...glances, new Vector3(6.6, 2.8, -17.3), new Vector3(-2, 0.1, -12)],
    label: dawn ? 'on the dawn chorus walk' : 'birdwatching from the hide',
  };
};

// ---- the lido: in the pool ------------------------------------------------------------------------

const lido: RoomBuilder = (k, c) => {
  const r = rng(seedOf(c) ^ 0x11d0);
  const gala = during(c, 'lido');
  outdoors(k, c, { size: 0.01, city: 0.8, ground: 0x6fa857, sun: [0.3, -0.8, -0.5] });
  // the terrace round the pool (built round the hole), grass beyond
  const PX = 7.5, PZ0 = -21, PZ1 = 4, DECK = 0.3, terr = [-17, 17, -36, 12];
  around(k, [-60, 60, -60, 60], terr, -0.1, 0.1, 0x6fa857);
  around(k, terr, [-PX, PX, PZ0, PZ1], -0.1, DECK + 0.1, 0xe4dccb);
  // the tank: pale tiles down to the floor, deep-blue mosaic at the water line, a white coping, the deep end's slope
  const tile = 0xa8dce6, band = pick(r, [0x1f5a9a, 0x1f7a8a, 0x2a4a8a]);
  for (const [x, z, w, d] of [[-PX - 0.03, (PZ0 + PZ1) / 2, 0.1, PZ1 - PZ0], [PX + 0.03, (PZ0 + PZ1) / 2, 0.1, PZ1 - PZ0], [0, PZ0 - 0.03, 2 * PX, 0.1], [0, PZ1 + 0.03, 2 * PX, 0.1]]) {
    k.box(x, -3.2, z, w, 3.2, d, tile); k.box(x, 0, z, w, DECK, d, band);
  }
  for (const s of [-1, 1]) k.box(s * (PX + 0.23), DECK, (PZ0 + PZ1) / 2, 0.5, 0.03, PZ1 - PZ0 + 1.0, 0xf4f2ec);
  for (const z of [PZ0 - 0.23, PZ1 + 0.23]) k.box(0, DECK, z, 2 * PX + 1.0, 0.03, 0.5, 0xf4f2ec);
  k.box(0, -1.3, (-12 + PZ1) / 2, 2 * PX, 0.1, PZ1 + 12, tile);
  plank(k, new Vector3(0, -1.2, -12), new Vector3(0, -3.0, -15.5), 2 * PX, 0.1, tile);
  k.box(0, -3.1, (PZ0 - 15.5) / 2, 2 * PX, 0.1, -15.5 - PZ0, tile);
  for (const x of [-5.75, -2, 2, 5.75]) k.box(x, -1.2, -4, 0.25, 0.012, 14, band);
  const wmat = glassy(k, 0x3fb8c8, 0.62);
  k.box(0, -3.1, (PZ0 + PZ1) / 2, 2 * PX - 0.04, 3.1, PZ1 - PZ0 - 0.04, wmat);
  // lane ropes bobbing, the backstroke flags across the deep end, ladders
  const ropes = [-4, 4].map((x) => k.group(x, 0, 0, () => {
    for (let i = 0; i < 25; i++) { const end = i < 3 || i > 21; k.ball(0, 0.02, PZ1 - 0.5 - i, 0.09, 0.07, 0.42, end ? 0xd8402a : i % 2 ? 0x2a6ad8 : 0xf4f4f0); }
  }));
  k.animate.push((t) => { ropes[0].position.y = 0.012 * Math.sin(t * 1.3); ropes[1].position.y = 0.012 * Math.sin(t * 1.1 + 2); });
  for (const s of [-1, 1]) k.cyl(s * (PX + 0.7), DECK, -16, 0.04, 1.7, 0xf4f4f0);
  bar(k, new Vector3(-PX - 0.7, DECK + 1.65, -16), new Vector3(PX + 0.7, DECK + 1.65, -16), 0.015, 0xf4f4f0);
  for (let i = 0; i < 13; i++) k.cone(-PX + 0.6 + i * 1.15, DECK + 1.63, -16, 0.13, 0.3, [0xd8402a, 0xf4f4f0, 0x2a6ad8][i % 3]).rotation.x = Math.PI;
  for (const [x, z] of [[-PX, -14.2], [PX, -2]]) for (const dz of [-0.25, 0.25]) bar(k, new Vector3(x + Math.sign(x) * 0.25, DECK + 0.7, z + dz), new Vector3(x - Math.sign(x) * 0.12, -0.8, z + dz), 0.04, 0xd8d8d8);
  // the springboard and the high board at the deep end
  const BXd = -2.5, BT = 1.28;
  k.box(BXd, DECK, -23.4, 0.7, 0.9, 1.2, 0x9aa0a8);
  k.box(BXd, 1.2, -21.4, 0.55, 0.08, 4.4, 0x2a7ab8);
  for (let i = 0; i < 3; i++) k.box(BXd, DECK, -24.625 + i * 0.25, 0.6, 0.3 * (i + 1), 0.25, 0x9aa0a8);
  for (const s of [-1, 1]) bar(k, new Vector3(BXd + s * 0.34, DECK + 1.0, -24.8), new Vector3(BXd + s * 0.34, 2.05, -23.2), 0.035, 0xd8d8d8);
  k.box(3, DECK, -23.4, 1.4, 3.0, 1.4, 0xf4f0e6);
  k.box(3, 3.3, -21.6, 1.6, 0.15, 2.8, 0x2a7ab8);
  for (const s of [-1, 1]) {
    bar(k, new Vector3(3 + s * 0.78, 4.35, -23.0), new Vector3(3 + s * 0.78, 4.35, -21.0), 0.04, 0xd8d8d8);
    for (const z of [-23.0, -21.0]) bar(k, new Vector3(3 + s * 0.78, 3.45, z), new Vector3(3 + s * 0.78, 4.37, z), 0.04, 0xd8d8d8);
    bar(k, new Vector3(3 + s * 0.3, DECK, -24.4), new Vector3(3 + s * 0.3, 3.5, -24.15), 0.04, 0xd8d8d8);
  }
  // swimmers: everyone in costume, only heads and shoulders above the water (the rest seen through it)
  const SUITS = [0x1a1a2a, 0x2a4a9a, 0xc0392b, 0x16a085, 0xe67e22, 0x8e44ad, 0xd94fa0, 0x2a2a2a, 0xe6c23a];
  const swimmer = (slot: number, stage: number) => { const look = visitor(c, slot, stage), suit = pick(r, SUITS); return outfit(look, r() < 0.45 ? look.a[0] : suit, suit, true); };
  (gala ? [-6.6, -5.0, 5.0, 6.6, -6.0, 5.8] : [-6.4, -5.2, 5.6]).forEach((x, i) => {
    const look = swimmer(50 + i, crowdStage(r, 0.1, 0.25)), sink = -1.28 * look.height, ph = r() * 6;
    const b = lineWalker(k, look, x, PZ1 - 1.2, x, PZ0 + 1.2, gala ? 1.1 + r() * 0.3 : 0.55 + r() * 0.4, r(), sink);
    const m0 = b.move!;
    b.swing = 0.22;
    b.move = (t, bb) => { m0(t, bb); bb.y = sink + 0.05 * Math.sin(t * 3.2 + ph); };
  });
  for (let i = 0; i < 4; i++) {
    const look = swimmer(60 + i, crowdStage(r, 0.5, 0.1)), sink = -1.28 * look.height, ph = r() * 6;
    const b = loopWalker(k, look, -1.5 + r() * 3.5, -7 - r() * 6, 0.6 + r(), 0.4 + r() * 0.6, 0.25 + r() * 0.2, r() * 6, r() < 0.5 ? 1 : -1, sink);
    const m0 = b.move!;
    b.swing = 0.15;
    b.move = (t, bb) => { m0(t, bb); bb.y = sink + 0.06 * Math.sin(t * 1.7 + ph); };
  }
  // two children throwing a beach ball between them
  const kA = new Vector3(-1.4, 0, -5.5), kB = new Vector3(0.8, 0, -8.2);
  [kA, kB].forEach((p, i) => {
    const look = swimmer(70 + i, LifeStage.Child), sink = -1.28 * look.height, o = i ? kA : kB, ph = r() * 6;
    k.bodies.push({ look, x: p.x, y: sink, z: p.z, yaw: Math.atan2(-(o.z - p.z), o.x - p.x), swing: 0.1, pose: 0, ph: 70 + i, move: (t, b) => { b.y = sink + 0.05 * Math.sin(t * 2.1 + ph); } });
  });
  const ballG = k.group(0, 0, 0, () => { k.ball(0, 0, 0, 0.22, 0.22, 0.22, 0xf4f4f0); k.ball(0, 0, 0.02, 0.222, 0.222, 0.15, 0xd8402a); k.ball(0.02, 0, 0, 0.15, 0.222, 0.222, 0x2a6ad8); });
  k.animate.push((t) => {
    const u = (t / 3.4) % 1, h = u < 0.5 ? u * 2 : (u - 0.5) * 2, from = u < 0.5 ? kA : kB, to = u < 0.5 ? kB : kA, f = Math.min(1, h / 0.8);
    ballG.position.lerpVectors(from, to, f); ballG.position.y = 0.45 + 1.4 * 4 * f * (1 - f);
    ballG.rotation.set(t * 2, t * 1.3, 0);
  });
  // someone drifting on a lilo
  const lilo = k.box(0, -0.05, 0, 0.7, 0.15, 1.9, pick(r, [0xe6c23a, 0xd94fa0, 0x2e86de, 0x27ae60]));
  k.bodies.push({ look: swimmer(72, LifeStage.Adult), x: -2.6, y: 0, z: -11, yaw: 0, swing: 0, pose: 0, ph: 72, lie: true,
    move: (t, b) => {
      b.x = -2.6 + 1.2 * Math.sin(t * 0.05); b.z = -11 + 0.8 * Math.sin(t * 0.037 + 1); b.y = 0.015 * Math.sin(t * 0.9);
      lilo.position.set(b.x, -0.05 + b.y, b.z - 0.75);
    } });
  // two on the edge with their feet in the water
  for (const z of [-3.6, -5.4]) k.sit(swimmer(74 + Math.round(-z), crowdStage(r, 0.3, 0.2)), -PX + 0.28, z, DECK + 0.03, 0, 0, 74 + Math.round(-z));
  // the diver: along the springboard, a bounce, the jump and the splash, a swim to the ladder and round the back again
  const diver = swimmer(40, crowdStage(r, 0.35, 0)), sinkD = -1.28 * diver.height;
  const dive = keyed([
    [0, BXd, BT, -23.3], [2.4, BXd, BT, -19.6], [3.2, BXd, BT, -19.5], [4.1, BXd, -1.4, -17.6], [5.2, BXd, sinkD, -16.8],
    [10.5, -6.6, sinkD, -14.2], [11.4, -7.9, DECK, -14.2], [13.6, -8.4, DECK, -24.8], [15.3, BXd, DECK, -25.0], [16.2, BXd, DECK + 0.9, -24.15], [17, BXd, BT, -23.3],
  ]);
  const splash = k.cone(BXd, 0, -17.6, 0.35, 1, 0xf4fbff), sRing = k.cyl(BXd, -1, -17.6, 0.5, 0.004, 0xd8f4f8);
  const DV = new Vector3(), DQ = new Vector3(), dPh = r() * 17, SWING = [0.5, 0, 0, 0.2, 0.25, 0.3, 0.5, 0.5, 0.4, 0.4];
  k.bodies.push({ look: diver, x: BXd, y: BT, z: -23.3, yaw: -Math.PI / 2, swing: 0, pose: 0, ph: 40,
    move: (t, b) => {
      const leg = dive(t + dPh, DV), i = Math.floor(leg), f = leg - i;
      dive(t + dPh + 0.1, DQ);
      b.x = DV.x; b.z = DV.z; b.y = DV.y;
      if (i === 1) b.y += 0.12 * Math.abs(Math.sin(t * 9));
      if (i === 2) b.y += 1.0 * Math.sin(f * Math.PI);
      if (i === 3 || i === 4) b.y += 0.04 * Math.sin(t * 3);
      b.yaw = i <= 3 ? -Math.PI / 2 : Math.atan2(-(DQ.z - DV.z), DQ.x - DV.x);
      b.swing = SWING[i] ?? 0;
      splash.visible = i === 3 && f < 0.5;
      if (splash.visible) splash.scale.set(0.7 * (1 + f), 1.6 * Math.sin(f * Math.PI * 2) + 0.01, 0.7 * (1 + f));
      const g = i === 3 ? f * 0.4 : i === 4 && f < 0.2 ? 0.4 + f * 3 : -1;
      if (g < 0) sRing.position.y = -1; else { sRing.position.y = 0.01; sRing.scale.set(0.4 + 3 * g, 0.004, 0.4 + 3 * g); }
    } });
  // the lifeguard high up on a white chair under a parasol, looking along the pool
  const lgx = 9.0, lgz = -9.5;
  for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bar(k, new Vector3(lgx + ox * 0.55, DECK, lgz + oz * 0.55), new Vector3(lgx + ox * 0.3, 2.3, lgz + oz * 0.3), 0.06, 0xf4f4f0);
  k.box(lgx, 2.3, lgz, 0.7, 0.06, 0.7, 0xf4f4f0); k.box(lgx + 0.33, 2.36, lgz, 0.05, 0.6, 0.7, 0xf4f4f0); k.box(lgx - 0.45, 1.5, lgz, 0.3, 0.05, 0.6, 0xf4f4f0);
  bar(k, new Vector3(lgx + 0.42, 2.3, lgz + 0.25), new Vector3(lgx + 0.3, 3.6, lgz + 0.2), 0.04, 0xd8d8d8);
  k.cone(lgx + 0.3, 3.45, lgz + 0.2, 1.0, 0.4, 0xe6c23a);
  const guard = outfit(staff(c, 1), 0xd8302a, 0xe6c23a);
  k.bodies.push({ look: guard, x: lgx, y: 2.36 - HIP_M * guard.height + 0.04, z: lgz, yaw: Math.PI, swing: 0, pose: 0, ph: 41,
    move: (t, b) => { b.yaw = Math.PI + 0.45 * Math.sin(t * 0.17) + 0.15 * Math.sin(t * 0.53); } });
  // changing huts in a row of colours down the right, sun loungers and parasols down the left
  const HUTS = [0xe8a0a0, 0xa0c8e8, 0xf0d890, 0xa8d8b0, 0xd8b0e0, 0xf4f4f0, 0xf0b890];
  const hOff = Math.floor(r() * HUTS.length);
  for (let i = 0; i < 9; i++) {
    const z = 2.5 - i * 2.4, col = HUTS[(i + hOff) % HUTS.length];
    k.box(12.6, DECK, z, 1.8, 2.3, 2.2, col); k.box(11.68, DECK, z, 0.04, 1.9, 0.9, i % 2 ? 0xf4f4f0 : 0x2a5a8a); k.box(12.5, DECK + 2.3, z, 2.1, 0.15, 2.35, 0xf4f4f0);
  }
  for (let i = 0; i < 7; i++) {
    const x = -10.8, z = -18 + i * 3.2;
    k.box(x, DECK + 0.25, z, 0.65, 0.08, 1.4, 0xf4f4f0); k.box(x, DECK, z, 0.6, 0.25, 0.06, 0xd8d8d8);
    const back = k.box(x, DECK + 0.33, z + 0.95, 0.65, 0.06, 0.6, 0xf4f4f0); back.rotation.x = -0.6;
    if (r() < 0.75) k.box(x, DECK + 0.33, z, 0.6, 0.015, 1.3, pick(r, BRIGHT));
    if (i % 2 === 0 && i < 6) k.lie(swimmer(90 + i, crowdStage(r, 0.1, 0.25)), x, DECK + 0.3, z + 0.75);
    if (i % 3 === 1) { k.cyl(x - 0.7, DECK, z + 1.6, 0.03, 2.2, 0xd8d8d8); k.cone(x - 0.7, DECK + 2.0, z + 1.6, 1.1, 0.45, pick(r, [0xd8402a, 0x2a6ad8, 0xe6c23a, 0x27ae60])); }
  }
  // people about on the terrace
  for (let i = 0; i < (gala ? 6 : 2); i++) lineWalker(k, swimmer(100 + i, crowdStage(r, 0.3, 0.2)), 10.4, 2, 10.4, -19, 0.8 + r() * 0.4, r(), DECK);
  // the art-deco entrance building across the far end: white render, rounded ends, a clock tower, bands of colour
  const deco = 0xf4f0e6, trim = pick(r, [0x2f8a9a, 0x2a5a9a, 0xd8602a, 0x3a8a5a]);
  k.box(0, DECK, -31, 22, 4.6, 6, deco);
  for (const s of [-1, 1]) { k.cyl(s * 11, DECK, -31, 3.0, 4.6, deco); k.cyl(s * 11, DECK + 4.6, -31, 3.1, 0.3, trim); }
  k.box(0, DECK + 4.6, -31, 22.3, 0.3, 6.3, trim);
  k.box(0, DECK + 2.4, -27.98, 20, 0.9, 0.04, 0x2a4a6a); k.box(0, DECK + 1.1, -27.97, 20, 0.12, 0.04, trim);
  k.box(0, DECK, -29.5, 5.5, 8.5, 4, deco); k.box(0, DECK + 8.5, -29.5, 5.9, 0.35, 4.4, trim);
  k.box(0, DECK + 2.9, -27.48, 1.2, 4.4, 0.04, 0x2a4a6a); k.box(0, DECK, -27.47, 2.2, 2.5, 0.04, 0x3a3a3a);
  const clock = k.cyl(0, DECK + 7.3, -27.48, 0.8, 0.06, 0xf4f4f0); clock.rotation.x = Math.PI / 2;
  k.box(0, DECK + 7.3, -27.42, 0.05, 0.55, 0.02, 0x1a1a1a); k.box(0, DECK + 7.3, -27.41, 0.4, 0.05, 0.02, 0x1a1a1a);
  for (const s of [-1, 1]) { k.cyl(s * 9, DECK + 4.9, -30, 0.05, 3, 0xd8d8d8); k.box(s * 9 + 0.5, DECK + 7.0, -30, 1.0, 0.6, 0.02, trim); }
  treesAround(k, r, 8, 0, -8, 24, 38, terr);
  // the swimming gala: bunting across the pool and spectators along the terrace
  if (gala) {
    for (let i = 0; i < 14; i++) k.cone(-PX + 0.5 + i * 1.08, DECK + 2.6 - Math.sin((i / 13) * Math.PI) * 0.5, -8, 0.14, 0.3, pick(r, BRIGHT)).rotation.x = Math.PI;
    for (let i = 0; i < 6; i++) k.stand(visitor(c, 110 + i, crowdStage(r, 0.3, 0.2)), 8.6 + (i % 2) * 0.6, -18 + i * 2.6, Math.PI, 0, 110 + i, DECK);
  }
  // your family in the water with you, and your hands sculling just under the surface
  const eye = new Vector3(1.2, 0.25, -1.5);
  companions(c, 2).forEach((m, i) => {
    const look = outfit(m.look, pick(r, SUITS), pick(r, SUITS), true), sink = -1.28 * look.height, x0 = i ? 2.7 : -0.4, z0 = i ? -3.9 : -3.4, ph = r() * 6;
    k.bodies.push({ look, x: x0, y: sink, z: z0, yaw: Math.atan2(-(eye.z - z0), eye.x - x0), swing: 0.12, pose: 0, ph: 80 + i,
      move: (t, b) => { b.y = sink + 0.05 * Math.sin(t * 1.4 + ph); b.x = x0 + 0.15 * Math.sin(t * 0.3 + ph); } });
  });
  const hands = [-1, 1].map(() => k.ball(0, -1, 0, 0.05, 0.035, 0.08, c.viewer.a[0]));
  k.animate.push((t) => {
    hands.forEach((h, i) => {
      const s = i ? 1 : -1;
      h.position.set(eye.x + s * (0.28 + 0.08 * Math.sin(t * 1.8)), -0.07 + 0.02 * Math.sin(t * 1.8 + 1), eye.z - 0.62 + 0.06 * Math.cos(t * 1.8));
    });
  });
  return {
    eye, aim: new Vector3(-1.5, 1.2, -20),
    glances: [new Vector3(lgx, 3.0, lgz), new Vector3(-5.6, 0.3, -9), new Vector3(-0.3, 0.8, -6.8), new Vector3(12, 1.4, -14), new Vector3(0, 5, -28)],
    label: gala ? 'at the swimming gala' : 'swimming at the lido',
    // treading water: bobbing with the ripples, drifting a little
    move: (t, at) => { at.set(1.2 + 0.25 * Math.sin(t * 0.13), 0.25 + 0.035 * Math.sin(t * 1.25) + 0.015 * Math.sin(t * 2.7 + 1), -1.5 + 0.3 * Math.sin(t * 0.09 + 2)); },
  };
};

// ---- tennis: at the baseline ------------------------------------------------------------------------

/**
 * A rally: contact m (even on the near side, odd on the far) at time m·T; between contacts the ball flies over the net and
 * bounces in the receiver's court. Players meet the ball `off` to its side and drift back toward the middle after a shot.
 */
function rally(seed: number, T: number, nearZ: number, farZ: number) {
  const OFF = 1000;
  const hit = (m: number, o: Vector3) => {
    const near = (m & 1) === 0;
    return o.set((hash2(seed, m) - 0.5) * (near ? 5.5 : 6.5), near ? 0.95 : 1.0, near ? nearZ : farZ);
  };
  const A = new Vector3(), B = new Vector3(), H = new Vector3();
  return {
    ball(t: number, o: Vector3) {
      const s = t / T + OFF, n = Math.floor(s), f = s - n, fb = 0.7;
      hit(n, A); hit(n + 1, B);
      o.lerpVectors(A, B, f);
      if (f < fb) { const g = f / fb; o.y = A.y * (1 - g) + 0.06 * g + 6 * g * (1 - g); }
      else { const g = (f - fb) / (1 - fb); o.y = 0.06 * (1 - g) + B.y * g + 3 * g * (1 - g); }
      return o;
    },
    x(t: number, side: number, off: number) {
      const s = t / T + OFF, n = Math.floor(s), f = smooth(s - n);
      const xh = (m: number) => hit(m, H).x + off, xr = (m: number) => 0.45 * xh(m);
      if (((n + 1) & 1) === side) { const a = xr(n - 1); return a + (xh(n + 1) - a) * f; }
      const a = xh(n); return a + (xr(n) - a) * f;
    },
    /** seconds from the nearest contact on `side` (negative before it) */
    since(t: number, side: number) { const s = t / T + OFF - side; return (s / 2 - Math.round(s / 2)) * 2 * T; },
  };
}
/** where the racket is round a player at dt seconds from their contact: ready forward-right, taken back, swung across, recovered */
const racketPhi = (dt: number) => (dt < -0.6 || dt > 0.9 ? 0.7 : dt < -0.15 ? 0.7 + smooth((dt + 0.6) / 0.45) : dt < 0.3 ? 1.7 - 2.7 * smooth((dt + 0.15) / 0.45) : -1.0 + 1.7 * smooth((dt - 0.3) / 0.6));

const tennis: RoomBuilder = (k, c) => {
  const r = rng(seedOf(c) ^ 0x7e2);
  const tourney = during(c, 'tennis');
  outdoors(k, c, { city: 0.8, sun: [0.3, -0.8, -0.45] });
  const [inC, outC] = pick(r, [[0x4a7a5a, 0x2f5a44], [0x3a6a9a, 0x2a6a50], [0xc0643a, 0xa8522f], [0x2f6a8a, 0x3a5a7a]]);
  const HL = 11.885, ZN = -HL, ZF = -2 * HL, line = 0xf4f4f0, netMat = glassy(k, 0x1a2a1a, 0.6);
  // two courts side by side: the surface, the lines, the net
  const court = (cx: number) => {
    k.box(cx, 0, ZN, 18.2, 0.02, 2 * HL + 11, outC);
    k.box(cx, 0.02, ZN, 10.97, 0.004, 2 * HL, inC);
    const W = 0.05, y = 0.026;
    for (const z of [0, ZF]) k.box(cx, y, z, 10.97, 0.004, W, line);
    for (const x of [-5.485, 5.485, -4.115, 4.115]) k.box(cx + x, y, ZN, W, 0.004, 2 * HL, line);
    for (const z of [ZN + 6.4, ZN - 6.4]) k.box(cx, y, z, 8.23, 0.004, W, line);
    k.box(cx, y, ZN, W, 0.004, 12.8, line);
    for (const z of [-0.1, ZF + 0.1]) k.box(cx, y, z, W, 0.004, 0.2, line);
    for (const s of [-1, 1]) k.cyl(cx + s * 6.4, 0, ZN, 0.04, 1.07, 0x2a3a2a);
    k.box(cx, 0, ZN, 12.8, 0.95, 0.02, netMat);
    k.box(cx, 0.93, ZN, 12.8, 0.06, 0.035, line);
    k.box(cx, 0, ZN, 0.05, 0.95, 0.03, line);
  };
  court(0); court(18.2);
  // the green fence round both (see-through mesh), posts, top rail; floodlights on masts
  const mesh = glassy(k, 0x2a4a3a, 0.28), FH = 3.5, fz0 = 5.5, fz1 = ZF - 5.5, post = 0x2a3a2a;
  for (const x of [-9.1, 9.1, 27.3]) {
    k.box(x, 0, (fz0 + fz1) / 2, 0.03, FH, fz0 - fz1, mesh); k.box(x, FH, (fz0 + fz1) / 2, 0.06, 0.06, fz0 - fz1, post);
    for (let z = fz0; z >= fz1 - 0.1; z -= 5) k.cyl(x, 0, z, 0.04, FH, post);
  }
  k.box(9.1, 0, fz1, 36.4, FH, 0.03, mesh); k.box(9.1, FH, fz1, 36.4, 0.06, 0.06, post);
  for (let x = -4.1; x < 27.3; x += 5) k.cyl(x, 0, fz1, 0.04, FH, post);
  for (const [x, aim] of [[-9.6, 0], [9.1, 9.1], [27.8, 18.2]]) for (const z of [-1, ZF + 1]) floodlight(k, x, z, 10, aim, ZN);
  // benches for the players, a kit bag and a bottle
  for (const z of [ZN + 2, ZN - 2]) bench(k, -8.4, z, Math.PI / 2);
  k.box(-8.3, 0.47, ZN + 2.3, 0.3, 0.25, 0.7, pick(r, [0x2a2a2a, 0xc0392b, 0x2e86de])); k.cyl(-8.3, 0.47, ZN + 1.6, 0.04, 0.22, 0x8ac8e8);
  // the clubhouse behind the far fence: a veranda with people at tables watching the play, windows lit after dark
  const club = pick(r, [0xe8e0d0, 0xd8c8a8, 0xf4f0e6]), roof = pick(r, [0x3a4a5a, 0x6a3a2a, 0x2a4a3a]), cbx = -4;
  k.box(cbx, 0, -37, 14, 3.4, 6, club);
  k.box(cbx, 3.4, -35.8, 14.6, 0.25, 8.6, roof);
  k.box(cbx, 0, -32.8, 14, 0.3, 2.4, 0x8a6a4a);
  for (let i = 0; i < 5; i++) k.cyl(cbx - 6.5 + i * 3.25, 0.3, -31.75, 0.07, 3.1, 0xf4f4f0);
  k.box(cbx, 1.15, -31.7, 14, 0.06, 0.06, 0xf4f4f0); k.box(cbx, 0.6, -31.7, 14, 0.05, 0.05, 0xf4f4f0);
  k.box(cbx - 1.5, 0.9, -33.98, 9, 1.5, 0.04, k.glow(0xffe0a0, 1.1, 'night')); k.box(cbx + 5, 0.3, -33.98, 1.2, 2.2, 0.04, 0x4a3a2a);
  for (let i = 0; i < 3; i++) { const tx = cbx - 4.5 + i * 3.5; k.cyl(tx, 0.3, -32.6, 0.04, 0.72, 0x3a3a3a); k.cyl(tx, 1.02, -32.6, 0.4, 0.03, 0xf4f4f0); }
  for (let i = 0; i < 5; i++) {
    if (r() > 0.8) continue;
    const x = cbx - 5.3 + i * 2.6;
    k.box(x, 0.3, -32.15, 0.42, 0.46, 0.42, 0x6a4a2a);
    k.sit(visitor(c, 20 + i, crowdStage(r, 0.1, 0.4)), x, -32.15, 0.76, -Math.PI / 2 + (r() - 0.5) * 0.6, r() < 0.3 ? 0.5 : 0, 20 + i);
  }
  for (const s of [-1, 1]) { k.ball(cbx + s * 6.5, 2.6, -31.75, 0.25, 0.2, 0.25, 0x4a8a3a); k.ball(cbx + s * 6.5, 2.72, -31.75, 0.18, 0.1, 0.18, 0xd94fa0); }
  k.cyl(cbx + 8.5, 0, -33, 0.05, 6, 0xd8d8d8); k.box(cbx + 9.1, 5.2, -33, 1.2, 0.7, 0.02, pick(r, BRIGHT));
  treesAround(k, r, 8, 9, -14, 26, 40, [-12, 30, -42, 8]);
  // the rally: your opponent across the net in whites, the ball flying to and fro, the ball's shadow on the court
  const seed = seedOf(c), rl = rally(seed, 1.4, 0.45, ZF - 0.45), BALL = new Vector3(), LOOK = new Vector3();
  const whites = (slot: number) => outfit(visitor(c, slot, LifeStage.Adult), 0xf4f4f0, r() < 0.5 ? 0xf4f4f0 : 0x2a3a5a);
  const FRAMES = [0x1a1a1a, 0xc0392b, 0x2e86de, 0xf4f4f0, 0xe67e22];
  const racket = (frame: number, hand = -1) => k.group(0, 0, 0, () => {
    k.ball(0, 0.45, 0, 0.13, 0.17, 0.012, frame); k.ball(0, 0.45, 0, 0.115, 0.155, 0.016, 0xe8e8d8);
    k.box(0, 0.1, 0, 0.03, 0.2, 0.02, frame); k.box(0, -0.13, 0, 0.034, 0.24, 0.034, 0x2a2a2a);
    if (hand >= 0) k.ball(0, -0.02, 0, 0.05, 0.06, 0.05, hand);
  });
  const ballOf = () => [k.ball(0, -1, 0, 0.06, 0.06, 0.06, k.glow(0xd8f040, 1.0)), k.cyl(0, -1, 0, 0.06, 0.003, 0x1a2a1a)] as [Mesh, Mesh];
  const [ballM, shadow] = ballOf();
  k.animate.push((t) => { rl.ball(t, BALL); ballM.position.copy(BALL); shadow.position.set(BALL.x, 0.031, BALL.z); });
  /** a player on side 0 (near, facing -z) or 1 (far, facing +z) of the court at cx, following rally `ra` */
  const player = (look: Look, ra: ReturnType<typeof rally>, side: number, cx: number, slot: number) => {
    const rk = racket(pick(r, FRAMES)), z = side ? ZF - 0.9 : 0.95, fwd = side ? 1 : -1, off = side ? 0.55 : -0.55;
    k.bodies.push({ look, x: cx, y: 0, z, yaw: side ? -Math.PI / 2 : Math.PI / 2, swing: 0, pose: 0, ph: slot,
      move: (t, b) => {
        const x = cx + ra.x(t, side, off), x2 = cx + ra.x(t + 0.05, side, off);
        b.x = x; b.swing = Math.min(0.75, (Math.abs(x2 - x) / 0.05) * 0.25);
        const phi = racketPhi(ra.since(t, side));
        // the player's right is -x facing +z, +x facing -z
        rk.position.set(x - fwd * Math.sin(phi) * 0.55, 0.95, z + fwd * Math.cos(phi) * 0.55);
        rk.rotation.set(0, side ? Math.PI - phi : -phi, 0.5);
      } });
  };
  player(whites(10), rl, 1, 0, 10);
  const rl2 = rally(seed ^ 0x77, 1.7, 0.45, ZF - 0.45), B2 = new Vector3(), [ball2, shadow2] = ballOf();
  k.animate.push((t) => { rl2.ball(t, B2); ball2.position.set(B2.x + 18.2, B2.y, B2.z); shadow2.position.set(B2.x + 18.2, 0.031, B2.z); });
  player(whites(11), rl2, 0, 18.2, 11); player(whites(12), rl2, 1, 18.2, 12);
  // doubles with your family: your partner at the net on your side, their partner at the net across
  const mates = companions(c, 1);
  if (mates[0]) {
    ([[outfit(mates[0].look, 0xf4f4f0, 0xf4f4f0), -2.4, ZN + 4.9, Math.PI / 2], [whites(13), 2.4, ZN - 4.9, -Math.PI / 2]] as [Look, number, number, number][]).forEach(([look, x0, z0, yaw], i) => {
      const rk = racket(pick(r, FRAMES)), ph = r() * 6, T = new Vector3();
      k.bodies.push({ look, x: x0, y: 0, z: z0, yaw, swing: 0, pose: 0, ph: 13 + i,
        move: (t, b) => {
          rl.ball(t, T);
          b.x = x0 + 0.5 * Math.sin(t * 0.7 + ph) + clamp(T.x * 0.2, -0.6, 0.6); b.swing = 0.15;
          rk.position.set(b.x + (i ? -0.4 : 0.4), 1.0, z0 + (i ? 0.3 : -0.3)); rk.rotation.set(0, 0, i ? 0.3 : -0.3);
        } });
    });
  }
  // the club tournament: an umpire in the high chair and spectators along the side
  if (tourney) {
    for (const [ox, oz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) k.box(-7.4 + ox, 0, ZN + oz, 0.06, 1.8, 0.06, 0xf4f4f0);
    k.box(-7.4, 1.8, ZN, 0.7, 0.06, 0.7, 0xf4f4f0); k.box(-7.75, 1.86, ZN, 0.05, 0.6, 0.7, 0xf4f4f0);
    const ump = visitor(c, 30, LifeStage.Adult);
    k.sit(ump, -7.4, ZN, 1.88, 0, 0, 30);
    for (let i = 0; i < 4; i++) {
      bench(k, -10.4, -4 - i * 5, Math.PI / 2);
      for (let j = 0; j < 2; j++) k.sit(visitor(c, 31 + i * 2 + j, crowdStage(r, 0.15, 0.35)), -10.35, -4 - i * 5 - 0.4 + j * 0.8, 0.47, 0 + (r() - 0.5) * 0.4, 0, 31 + i * 2 + j);
    }
  }
  // you: running along the baseline to meet the ball, the head following it, your racket swung through each shot
  const eye = new Vector3(0, eyeStanding(c), 0.95), mine = racket(pick(r, FRAMES), c.viewer.a[0]);
  let yaw = 0, pitch = 0;
  const lights = floodlit(k, 9, 11, ZN, 140);
  return {
    eye, aim: new Vector3(0, 1, ZF), glances: [], label: tourney ? 'at the club tournament' : 'playing tennis', live: () => { lights(); },
    move: (t, at) => {
      const x = rl.x(t, 0, -0.55), run = Math.abs(rl.x(t + 0.05, 0, -0.55) - x) / 0.05;
      at.set(x, eyeStanding(c) + 0.02 * Math.sin(t * 9) * Math.min(1, run * 0.3), 0.95);
      rl.ball(t - 0.06, LOOK);
      yaw += (clamp(viewYaw(at, LOOK), -0.7, 0.7) - yaw) * 0.12;
      pitch += (clamp(viewPitch(at, LOOK) - 0.04, -0.5, 0.3) - pitch) * 0.12;
      const phi = racketPhi(rl.since(t, 0));
      mine.position.set(x + Math.sin(phi) * 0.5, at.y - 0.62, at.z - Math.cos(phi) * 0.5);
      mine.rotation.set(-0.35, -(phi - 0.7) * 0.9, -0.45, 'YXZ');
      return { yaw, pitch, roll: 0 };
    },
  };
};

// ---- the go-kart track: driving round it ---------------------------------------------------------------

/** the circuit's centre line through these points (metres), checked for clearance: 257 m round, the tightest bend 5 m */
const KART_LOOP: [number, number][] = [[-27, 14], [-10, 14], [10, 14], [22, 13], [29, 7], [28, -1], [19, -6], [9, -3], [0, -5], [-4, -12.5], [0, -20],
  [12, -23], [22, -24.5], [28, -28.5], [29, -34], [23, -38.5], [8, -38], [-12, -35], [-26, -29], [-32, -17], [-34, -3], [-33, 7]];
/** a closed Catmull-Rom spline through the points, resampled at even steps: the point, heading and curvature at any distance */
function circuit(pts: [number, number][]) {
  const n = pts.length, raw: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let j = 0; j < 24; j++) {
      const u = j / 24, u2 = u * u, u3 = u2 * u;
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
      raw.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const cum = [0];
  for (let i = 1; i <= raw.length; i++) { const a = raw[i - 1], b = raw[i % raw.length]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const L = cum[raw.length], M = Math.floor(L / 0.5), ds = L / M, xs = new Float32Array(M), zs = new Float32Array(M);
  for (let i = 0, j = 0; i < M; i++) {
    const s = i * ds;
    while (cum[j + 1] < s) j++;
    const a = raw[j], b = raw[(j + 1) % raw.length], f = (s - cum[j]) / (cum[j + 1] - cum[j]);
    xs[i] = a[0] + (b[0] - a[0]) * f; zs[i] = a[1] + (b[1] - a[1]) * f;
  }
  const TA = new Vector3(), TB = new Vector3();
  const at = (s: number, o: Vector3) => {
    const u = (((s % L) + L) % L) / ds, i = Math.floor(u) % M, f = u - Math.floor(u), i2 = (i + 1) % M;
    return o.set(xs[i] + (xs[i2] - xs[i]) * f, 0, zs[i] + (zs[i2] - zs[i]) * f);
  };
  /** the direction of travel as an angle: (sin h, cos h); a box turned by h runs along the track */
  const heading = (s: number) => { at(s - 1, TA); at(s + 1, TB); return Math.atan2(TB.x - TA.x, TB.z - TA.z); };
  /** turning per metre: positive turns left */
  const curv = (s: number) => wrapA(heading(s + 2) - heading(s - 2)) / 4;
  return { L, at, heading, curv };
}

const karting: RoomBuilder = (k, c) => {
  const r = rng(seedOf(c) ^ 0x6a7);
  const gp = during(c, 'karting');
  const sky = outdoors(k, c, { city: 1.0, ground: 0x6a9a50, sun: [0.3, -0.8, 0.4] });
  // the eye goes far from the middle, so the sky dome goes with it (the camera sees 80 m)
  const dome = k.scene.children.find((o) => (o as Mesh).material === sky);
  const C = circuit(KART_LOOP), P0 = new Vector3(), P1 = new Vector3(), TMP = new Vector3();
  // the tarmac: short boxes through the bends, long ones down the straights
  for (let s = 0; s < C.L;) {
    const kk = Math.abs(C.curv(s)), step = kk > 0.09 ? 1.6 : kk > 0.035 ? 2.6 : 5;
    C.at(s, P0); C.at(s + step, P1);
    k.box((P0.x + P1.x) / 2, 0, (P0.z + P1.z) / 2, 7, 0.02, step + (kk > 0.035 ? 1.0 : 0.3), 0x46484e, Math.atan2(P1.x - P0.x, P1.z - P0.z));
    s += step;
  }
  // red-and-white kerbs on the inside of the bends, tyre walls (a white stack here and there) round the outside
  let kn = 0, tn = 0;
  for (let s = 0; s < C.L; s += 1.5) {
    const kk = C.curv(s);
    if (Math.abs(kk) < 0.08) continue;
    const h = C.heading(s), off = Math.sign(kk) * 3.75;
    C.at(s, P0);
    k.box(P0.x + Math.cos(h) * off, 0, P0.z - Math.sin(h) * off, 0.75, 0.05, 1.5, kn++ % 2 ? 0xd8302a : 0xf4f4f0, h);
  }
  for (let s = 0; s < C.L; s += 1.1) {
    const kk = C.curv(s);
    if (Math.abs(kk) < 0.1) continue;
    const h = C.heading(s), off = -Math.sign(kk) * 6.2;
    C.at(s, P0);
    k.cyl(P0.x + Math.cos(h) * off, 0, P0.z - Math.sin(h) * off, 0.4, 0.75, tn++ % 5 === 0 ? 0xe8e8e8 : 0x1e1e20);
  }
  // the start line on the main straight: a chequered strip and the gantry, its five reds coming on one by one and going out
  let sStart = 0, best = 1e9;
  for (let s = 0; s < C.L; s += 0.5) { C.at(s, P0); const d = Math.hypot(P0.x + 6, P0.z - 14); if (d < best) { best = d; sStart = s; } }
  const hS = C.heading(sStart), nx = Math.cos(hS), nz = -Math.sin(hS), dx = Math.sin(hS), dz = Math.cos(hS);
  const kartCol = pick(r, [0xd8302a, 0x2e86de, 0x27ae60, 0xe6b734, 0x8e44ad, 0xe67e22]);
  C.at(sStart, P0);
  for (let i = 0; i < 10; i++) k.box(P0.x + nx * (i - 4.5) * 0.7, 0.02, P0.z + nz * (i - 4.5) * 0.7, 0.7, 0.008, 0.6, i % 2 ? 0x1a1a1a : 0xf4f4f0, hS);
  for (const s of [-1, 1]) k.cyl(P0.x + nx * s * 4.4, 0, P0.z + nz * s * 4.4, 0.12, 4.6, 0x3a3e46);
  k.box(P0.x, 4.1, P0.z, 9.2, 0.6, 0.35, 0x3a3e46, hS);
  k.box(P0.x - dx * 0.05, 4.75, P0.z - dz * 0.05, 7, 0.7, 0.06, 0xf4f4f0, hS);
  k.box(P0.x - dx * 0.06, 4.95, P0.z - dz * 0.06, 7, 0.25, 0.07, kartCol, hS);
  const reds: Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const lx = P0.x + nx * (i - 2) * 0.7 - dx * 0.2, lz = P0.z + nz * (i - 2) * 0.7 - dz * 0.2;
    k.box(lx, 4.15, lz, 0.4, 0.4, 0.06, 0x1a1a1a, hS);
    reds.push(k.box(lx - dx * 0.02, 4.2, lz - dz * 0.02, 0.3, 0.3, 0.04, k.glow(0xff2a1a, 1.6), hS));
  }
  const green = k.box(P0.x - dx * 0.24, 3.75, P0.z - dz * 0.24, 0.9, 0.22, 0.04, k.glow(0x30ff60, 1.4), hS);
  k.animate.push((t) => { const u = t % 40; reds.forEach((m, i) => { m.visible = u < 6 && u > i; }); green.visible = u >= 6; });
  // the grandstand along the outside of the straight, advertising boards before it; the pits and pit wall inside
  for (let row = 0; row < 4; row++) k.box(-14, 0, 19.6 + row * 0.9, 22, 0.45 * (row + 1), 0.9, 0x9a9ea6);
  k.box(-14, 0, 23.3, 22.5, 3.6, 0.1, 0x3a5a8a); k.box(-14, 3.6, 21.4, 23, 0.12, 4.4, 0x3a5a8a);
  for (let i = 0; i < 4; i++) k.cyl(-24.5 + i * 7, 0, 19.3, 0.07, 3.6, 0x5a5e66);
  let fans = 0;
  for (let row = 0; row < 4; row++) for (let i = 0; i < 8; i++) {
    if (r() > (gp ? 0.85 : 0.55) || fans >= 26) continue;
    k.sit(visitor(c, 30 + row * 8 + i, crowdStage(r, 0.25, 0.15)), -23 + i * 2.6 + (r() - 0.5) * 0.6, 19.7 + row * 0.9, 0.45 * (row + 1), Math.PI / 2 + (r() - 0.5) * 0.4, r() < 0.2 ? 0.5 : 0, 30 + fans++);
  }
  for (let i = 0; i < 6; i++) k.box(-23 + i * 3.6, 0, 18.4, 3.4, 0.9, 0.08, pick(r, [...BRIGHT, 0xf4f4f0]));
  k.box(-16, 0, 5.5, 16, 3.0, 4, 0xe8e4dc); k.box(-16, 3.0, 5.5, 16.6, 0.25, 4.6, kartCol);
  for (let i = 0; i < 4; i++) k.box(-22 + i * 4, 0, 7.52, 3, 2.4, 0.04, 0x3a3a3c);
  k.box(-16, 0, 10.0, 20, 0.8, 0.3, 0xf4f4f0);
  for (let i = 0; i < 2; i++) k.stand(staff(c, 2 + i), -20 + i * 7, 8.6, -Math.PI / 2 + (r() - 0.5), r() < 0.5 ? 0.5 : 0, 60 + i);
  // a marshal waving a flag at the hairpin
  let sHair = 0, kMax = 0;
  for (let s = 0; s < C.L; s += 1) { const kk = Math.abs(C.curv(s)); if (kk > kMax) { kMax = kk; sHair = s; } }
  { const h = C.heading(sHair), off = -Math.sign(C.curv(sHair)) * 8.5; C.at(sHair, P0);
    const mx = P0.x + Math.cos(h) * off, mz = P0.z - Math.sin(h) * off;
    k.stand(staff(c, 4), mx, mz, Math.atan2(-(P0.z - mz), P0.x - mx), 0, 64);
    const flag = k.group(mx, mz, 0, () => { k.box(0.25, 1.1, 0, 0.03, 0.9, 0.03, 0x5a4a3a); k.box(0.5, 1.6, 0, 0.5, 0.35, 0.02, 0x2a6ad8); });
    k.animate.push((t) => { flag.rotation.y = 0.8 * Math.sin(t * 4); }); }
  // floodlights round the circuit and trees outside it, kept off the track
  const near = (x: number, z: number, d: number) => { for (let s = 0; s < C.L; s += 2) { C.at(s, TMP); if (Math.hypot(TMP.x - x, TMP.z - z) < d) return true; } return false; };
  for (const [x, z] of [[-40, 14], [0, 21], [36, 10], [36, -31], [0, -45], [-40, -30]]) floodlight(k, x, z, 12, -2, -12);
  for (let i = 0, tries = 0; i < 7 && tries < 80; tries++) {
    const x = -50 + r() * 100, z = -52 + r() * 80;
    if (near(x, z, 10) || (z > 15 && z < 25 && x > -27 && x < -1) || (x > -26 && x < -6 && z > 2 && z < 11)) continue;
    (r() < 0.6 ? tree : pine)(k, r, x, z, 0.9 + r() * 0.5); i++;
  }
  // the other karts: each a colour, a driver in a helmet, keeping its own gap ahead or behind (drawing in and dropping back)
  const wheel = (x: number, z: number) => { const m = k.cyl(x + 0.075, 0.14, z, 0.14, 0.15, 0x1a1a1a); m.rotation.z = Math.PI / 2; };
  const mates = companions(c, 1), v = 10.5, s0 = sStart + 20;
  [9, 19, 31, -11, -23].forEach((gap, i) => {
    const look = i === 0 && mates[0] ? mates[0].look : visitor(c, 70 + i, r() < 0.3 ? LifeStage.Child : LifeStage.Adult), hy = 0.2 + 0.78 * look.height;
    const col = pick(r, [0xd8302a, 0x2e86de, 0x27ae60, 0xe6b734, 0x8e44ad, 0xe67e22, 0xf4f4f0, 0x2a2a2a]);
    const g = k.group(0, 0, 0, () => {
      k.box(0, 0.04, 0, 0.85, 0.03, 1.5, 0x2a2a2e); k.box(0, 0.05, -0.72, 0.95, 0.16, 0.36, col);
      for (const s of [-1, 1]) { k.box(s * 0.56, 0.05, 0, 0.22, 0.2, 0.9, col); for (const z of [-0.5, 0.55]) wheel(s * 0.62, z); }
      k.box(0, 0.12, 0.42, 0.42, 0.45, 0.08, 0x2a2a2e); k.box(0, 0.12, 0.78, 0.9, 0.12, 0.08, 0x2a2a2e);
      k.ball(0, hy, 0.15, 0.15, 0.16, 0.16, pick(r, BRIGHT)); k.box(0, hy - 0.05, -0.01, 0.2, 0.08, 0.02, 0x1a1a1a);
    });
    const lat0 = (i % 2 ? 1 : -1) * (0.9 + r() * 0.8), ph = r() * 6, amp = 2.5 + r() * 1.5, Q = new Vector3();
    k.bodies.push({ look, x: 0, y: 0.15 - HIP_M * look.height + 0.04, z: 0, yaw: 0, swing: 0, pose: 0, ph: 70 + i,
      move: (t, b) => {
        const s = s0 + gap + v * t + amp * Math.sin(t * 0.05 + ph), h = C.heading(s), lat = lat0 + 0.5 * Math.sin(s * 0.05 + ph);
        C.at(s, Q);
        const x = Q.x + Math.cos(h) * lat, z = Q.z - Math.sin(h) * lat;
        g.position.set(x, 0.004 * Math.sin(t * 40 + ph), z); g.rotation.y = h + Math.PI;
        b.x = x - Math.sin(h) * 0.15; b.z = z - Math.cos(h) * 0.15; b.yaw = Math.atan2(-Math.cos(h), Math.sin(h));
      } });
  });
  // your kart round you: the nose, the front wheels, your legs and the steering wheel with your gloved hands on it
  const eyeH = 0.08 + 0.75 * c.viewer.height, glove = pick(r, [0x1a1a1a, 0xd8302a, 0x2e86de]);
  let steer: Group | null = null;
  const kart = k.group(0, 0, 0, () => {
    k.box(0, 0.04, -0.45, 0.8, 0.03, 1.5, 0x2a2a2e); k.box(0, 0.05, -1.15, 0.95, 0.16, 0.4, kartCol);
    k.box(0, 0.18, -1.22, 0.5, 0.22, 0.03, 0xf4f4f0).rotation.x = -0.5;
    for (const s of [-1, 1]) { k.box(s * 0.55, 0.05, -0.15, 0.22, 0.2, 0.95, kartCol); wheel(s * 0.62, -0.85); k.box(s * 0.12, 0.08, -0.45, 0.12, 0.13, 0.75, c.viewer.a[3]); }
    bar(k, new Vector3(0, 0.2, -0.8), new Vector3(0, eyeH - 0.32, -0.42), 0.04, 0x5a5e66);
    const tilt = k.group(0, -0.42, 0, () => {
      steer = k.group(0, 0, 0, () => {
        for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; k.box(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15, 0.03, 0.025, 0.1, 0x2a2a2e, -a); }
        k.box(0, 0, 0, 0.3, 0.02, 0.03, 0x5a5e66); k.cyl(0, -0.01, 0, 0.045, 0.03, kartCol);
        for (const s of [-1, 1]) k.ball(s * 0.15, 0.02, 0, 0.045, 0.04, 0.055, glove);
      });
    });
    tilt.position.y = eyeH - 0.3; tilt.rotation.x = 1.15;
  });
  const sw = steer as unknown as Group, AH = new Vector3();
  const eye = new Vector3();
  C.at(s0, eye); eye.y = eyeH;
  return {
    eye, aim: C.at(s0 + 8, new Vector3()), glances: [], label: gp ? 'in the kart grand prix' : 'racing go-karts',
    live: () => { k.ambientNight = 0.12 + 0.3 * night(); },
    // round the loop at a steady pace on a gently weaving line, looking into each bend, leaning with it, the wheel turning
    move: (t, at) => {
      const s = s0 + v * t, h = C.heading(s), kk = C.curv(s), lat = 0.6 * Math.sin((s / C.L) * Math.PI * 6);
      C.at(s, at);
      at.set(at.x + Math.cos(h) * lat, eyeH + 0.004 * Math.sin(t * 41), at.z - Math.sin(h) * lat);
      kart.position.set(at.x, 0.003 * Math.sin(t * 43), at.z); kart.rotation.y = h + Math.PI;
      sw.rotation.y = clamp(kk * 4.5, -0.9, 0.9);
      dome?.position.set(at.x, 0, at.z);
      const ha = C.heading(s + 7);
      C.at(s + 7, AH);
      AH.set(AH.x + Math.cos(ha) * lat, eyeH - 0.4, AH.z - Math.sin(ha) * lat);
      return { yaw: viewYaw(at, AH), pitch: -0.08, roll: clamp(kk * v * 0.05, -0.07, 0.07) };
    },
  };
};

export const OUTDOOR_ROOMS: Partial<Record<LeisureRoom, RoomBuilder>> = { playground, skatepark, allotments, fishing, reserve, lido, tennis, karting };
