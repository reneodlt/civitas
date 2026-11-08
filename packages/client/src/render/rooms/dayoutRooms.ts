import {
  Vector3, Color, Fog, Mesh, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, MeshLambertMaterial, DoubleSide,
  AdditiveBlending, SphereGeometry, CylinderGeometry, RingGeometry, TorusGeometry, type Group, type Material,
} from 'three';
import { hash2, LifeStage, VENUE_WORDS, type VenueType } from '@msimcity/shared';
import { chair, plant, strips, world, type Kit, type Ctx, type RoomBuilder, type LeisureRoom, type Body, type Rng } from '../interiors';
import {
  outdoors, tree, pine, bar, setBar, visitor, staff, crowdStage, companions, lineWalker, eyeStanding, eyeSitting, rng, pick, BRIGHT,
} from '../leisureKit';
import { sceneUniforms } from '../materials';
import type { Look } from '../people';

/**
 * Days out and the arts (docs/leisure.md): the city farm, the aquarium's tunnel, the planetarium's star show, the science
 * centre, the observatory, the art gallery, a pottery class, the concert hall and the tea dance, each a small scene from
 * the visitor's eyes, built with render/leisureKit.ts. Seeded by the place (c.place.venue.seed) so a place looks the same
 * to everyone; the visitor's own family who came along sit or stand beside them (leisureKit companions).
 *
 * Meshes made here outside the kit's box/ball/cylinder set (the planetarium's stars and dome, the observatory's dome, a
 * hoop, a ring) are disposed with the kit (`owned`).
 */

const seedOf = (c: Ctx) => c.place.venue?.seed ?? c.place.seed;
const isEvent = (c: Ctx, t: VenueType) => c.info.activity === VENUE_WORDS[t].event;
const TAU = Math.PI * 2;
/** people.ts feature bits */
const BIT = { skirt: 1 << 6, coat: 1 << 7, sideBag: 1 << 8, backpack: 1 << 9, cap: 1 << 11, phone: 1 << 13, shirtFront: 1 << 14, tie: 1 << 15, stick: 1 << 16, lanyard: 1 << 21 };
/** what someone carries that looks wrong on a player, a dancer or a raised hand (the phone shows in a raised hand) */
const CARRY = BIT.sideBag | BIT.backpack | BIT.phone;
/** a look in other clothes: top and legs, feature bits set and cleared */
function dress(look: Look, top: number, legs = top, set = 0, clear = CARRY): Look {
  return { ...look, a: [look.a[0], look.a[1], top, legs], b: [look.b[0], look.b[1], look.b[2], (look.b[3] | set) & ~clear] };
}
/** a look without the things carried (a raised hand then holds nothing) */
const bare = (look: Look, clear = CARRY): Look => ({ ...look, b: [look.b[0], look.b[1], look.b[2], look.b[3] & ~clear] });
/** a body's forward (x, z) for a yaw (yaw 0 faces +x; facing (dx, dz) is atan2(-dz, dx)); its left is (fz, -fx) */
const fwd = (yaw: number): [number, number] => [Math.cos(yaw), -Math.sin(yaw)];
const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(-(tz - z), tx - x);
/** a box's ry so its length (local z) runs along (dx, dz) */
const along = (dx: number, dz: number) => Math.atan2(dx, dz);
const wrap = (a: number) => a - Math.round(a / TAU) * TAU;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const unit = (x: number, z: number): [number, number] => { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; };
/** dispose something the kit does not own (a geometry or a material made here) with the kit */
function owned<T extends { dispose(): void }>(k: Kit, x: T): T {
  const d = k.dispose.bind(k);
  k.dispose = () => { d(); x.dispose(); };
  return x;
}
/** a mesh of a geometry made here, in the kit's current frame */
function custom(k: Kit, geo: BufferGeometry, mat: Material) {
  const m = new Mesh(owned(k, geo), mat);
  k.parent.add(m);
  return m;
}
/** a lit material with a glow of its own (gold, wet clay, bronze) */
const sheen = (k: Kit, hex: number, emissive: number) => owned(k, new MeshLambertMaterial({ color: hex, emissive }));
/** a see-through glow (glass, a soap film, a beam of light) */
function clear(k: Kit, hex: number, opacity: number, add = false) {
  const m = k.glow(hex, 1);
  m.transparent = true; m.opacity = opacity; m.depthWrite = false;
  if (add) m.blending = AdditiveBlending;
  return m;
}
const lift = (g: Group, y: number) => { g.position.y = y; return g; };
/** a group built in the kit's frame, with the kit's parent set to it while `fn` runs */
function inside(k: Kit, g: Group, fn: () => void) { const p = k.parent; k.parent = g; fn(); k.parent = p; }

// ---- the city farm ----------------------------------------------------------------------------------

interface Beast { g: Group; head: Group; legs: Group[] }
interface Pen { x0: number; x1: number; z0: number; z1: number }
/** a leg hanging from the hip at (x, h, z), so it swings from the top */
function leg(k: Kit, x: number, z: number, h: number, w: number, col: number) {
  return lift(k.group(x, z, 0, () => k.box(0, -h, 0, w, h, w, col)), h);
}
/** an animal's time in its pen: amble to a spot, stay a while (grazing, rooting, pecking), amble on; each its own pace */
function roam(seed: number, pen: Pen, period: number, walk: number) {
  const spot = (n: number): [number, number] => [pen.x0 + (pen.x1 - pen.x0) * hash2(seed, n * 2 + 1), pen.z0 + (pen.z1 - pen.z0) * hash2(seed, n * 2 + 2)];
  const off = hash2(seed, 0) * 50;
  return (t: number) => {
    const s = t / period + off, n = Math.floor(s), u = s - n;
    const [ax, az] = spot(n), [bx, bz] = spot(n + 1);
    const w = Math.min(1, u / walk), e = w * w * (3 - 2 * w);
    return { x: ax + (bx - ax) * e, z: az + (bz - az) * e, yaw: Math.atan2(-(bz - az), bx - ax), moving: w < 1 ? Math.sin(w * Math.PI) : 0 };
  };
}
function sheep(k: Kit, r: Rng, s: number): Beast {
  const wool = r() < 0.12 ? 0x3a3430 : pick(r, [0xeee8d8, 0xe6dcc8, 0xf2eee4]), face = r() < 0.55 ? 0x2a2420 : 0xd8ccb8;
  let head!: Group; const legs: Group[] = [];
  const g = k.group(0, 0, 0, () => {
    k.ball(0, 0.62 * s, 0, 0.48 * s, 0.3 * s, 0.3 * s, wool);
    k.ball(-0.1 * s, 0.74 * s, 0, 0.36 * s, 0.24 * s, 0.27 * s, wool);
    for (const [lx, lz] of [[0.26, 0.13], [0.26, -0.13], [-0.26, 0.13], [-0.26, -0.13]]) legs.push(leg(k, lx * s, lz * s, 0.44 * s, 0.07 * s, 0x2a2420));
    head = lift(k.group(0.36 * s, 0, 0, () => {
      k.ball(0.1 * s, 0, 0, 0.15 * s, 0.12 * s, 0.12 * s, wool);
      k.ball(0.3 * s, -0.02 * s, 0, 0.14 * s, 0.1 * s, 0.085 * s, face);
      k.box(0.24 * s, 0.03 * s, 0, 0.05 * s, 0.03 * s, 0.3 * s, face);
    }), 0.66 * s);
  });
  return { g, head, legs };
}
function goat(k: Kit, r: Rng, s: number): Beast {
  const coat = pick(r, [0xe8e4dc, 0x8a5a3a, 0x2a2622, 0xc8a878, 0x6a5a4a]), dark = 0x3a3028;
  let head!: Group; const legs: Group[] = [];
  const g = k.group(0, 0, 0, () => {
    k.ball(0, 0.62 * s, 0, 0.42 * s, 0.21 * s, 0.19 * s, coat);
    for (const [lx, lz] of [[0.24, 0.1], [0.24, -0.1], [-0.25, 0.1], [-0.25, -0.1]]) legs.push(leg(k, lx * s, lz * s, 0.5 * s, 0.06 * s, coat === 0xe8e4dc ? 0xd8d0c4 : dark));
    k.box(-0.42 * s, 0.68 * s, 0, 0.04 * s, 0.13 * s, 0.04 * s, coat).rotation.z = 0.6;
    head = lift(k.group(0.34 * s, 0, 0, () => {
      k.box(0.04 * s, -0.04 * s, 0, 0.12 * s, 0.2 * s, 0.11 * s, coat).rotation.z = -0.5;
      k.ball(0.17 * s, 0.12 * s, 0, 0.15 * s, 0.085 * s, 0.075 * s, coat);
      for (const sz of [-1, 1]) k.box(0.1 * s, 0.17 * s, sz * 0.04 * s, 0.03 * s, 0.15 * s, 0.03 * s, 0x8a7a62).rotation.z = 0.55;
      k.box(0.1 * s, 0.13 * s, 0, 0.05 * s, 0.02 * s, 0.3 * s, coat);
      k.box(0.27 * s, 0.0, 0, 0.03 * s, 0.08 * s, 0.03 * s, coat === 0x2a2622 ? 0x4a4038 : 0xb8ac98);
    }), 0.72 * s);
  });
  return { g, head, legs };
}
function pig(k: Kit, r: Rng, s: number, lying = false): Beast {
  const skin = pick(r, [0xeaa8a0, 0xeaa8a0, 0xc0703a, 0x2e2a2c]), snout = skin === 0x2e2a2c ? 0x4a4044 : 0xd88880;
  let head!: Group; const legs: Group[] = [];
  const y = lying ? -0.16 * s : 0;
  const g = k.group(0, 0, 0, () => {
    k.ball(0, 0.42 * s + y, 0, 0.55 * s, 0.3 * s, 0.31 * s, skin);
    if (skin === 0xeaa8a0 && r() < 0.5) k.ball(-0.12 * s, 0.58 * s + y, 0.08 * s, 0.18 * s, 0.13 * s, 0.2 * s, 0x2e2a2c);
    if (!lying) for (const [lx, lz] of [[0.3, 0.15], [0.3, -0.15], [-0.32, 0.15], [-0.32, -0.15]]) legs.push(leg(k, lx * s, lz * s, 0.22 * s, 0.09 * s, skin));
    k.ball(-0.55 * s, 0.5 * s + y, 0, 0.05 * s, 0.05 * s, 0.05 * s, skin);
    head = lift(k.group(0.48 * s, 0, 0, () => {
      k.ball(0.06 * s, 0, 0, 0.2 * s, 0.19 * s, 0.2 * s, skin);
      k.box(0.26 * s, -0.09 * s, 0, 0.08 * s, 0.11 * s, 0.13 * s, snout);
      k.box(0.12 * s, 0.13 * s, 0, 0.1 * s, 0.03 * s, 0.36 * s, skin).rotation.z = -0.35;
    }), 0.46 * s + y);
  });
  return { g, head, legs };
}
function hen(k: Kit, r: Rng, s: number): Beast {
  const col = pick(r, [0x9a5a2a, 0xa8642e, 0xf0ece4, 0x2a2a2a, 0xc8a070]);
  let head!: Group;
  const g = k.group(0, 0, 0, () => {
    k.ball(0, 0.2 * s, 0, 0.15 * s, 0.12 * s, 0.1 * s, col);
    k.box(-0.13 * s, 0.2 * s, 0, 0.08 * s, 0.14 * s, 0.05 * s, col).rotation.z = 0.45;
    k.box(0.01 * s, 0, 0, 0.03 * s, 0.1 * s, 0.08 * s, 0xd8a030);
    head = lift(k.group(0.1 * s, 0, 0, () => {
      k.ball(0.03 * s, 0.04 * s, 0, 0.055 * s, 0.06 * s, 0.05 * s, col);
      k.box(0.03 * s, 0.09 * s, 0, 0.06 * s, 0.04 * s, 0.015 * s, 0xc8281e);
      k.box(0.09 * s, 0.03 * s, 0, 0.04 * s, 0.02 * s, 0.02 * s, 0xe0a030);
    }), 0.27 * s);
  });
  return { g, head, legs: [] };
}
interface Habit { down: number; legs: number; step: number; bounce?: number; peck?: boolean; root?: boolean }
/** set an animal roaming: the body follows `path`, legs swing while it walks, the head does what the animal does when it stops */
function animate(k: Kit, b: Beast, path: (t: number) => { x: number; z: number; yaw: number; moving: number }, h: Habit, ph: number) {
  let yaw = NaN;
  const hx = b.head.position.x;
  k.animate.push((t) => {
    const p = path(t);
    yaw = Number.isNaN(yaw) ? p.yaw : yaw + wrap(p.yaw - yaw) * 0.07;
    b.g.position.x = p.x; b.g.position.z = p.z; b.g.rotation.y = yaw;
    const m = p.moving, still = 1 - m;
    if (h.peck) {
      const peck = Math.pow(Math.max(0, Math.sin(t * 6.5 + ph)), 2) * (Math.sin(t * 0.9 + ph) > -0.3 ? 1 : 0);
      b.head.rotation.z = still * h.down * peck;
      b.head.position.x = hx + m * 0.02 * Math.sin(t * 12 + ph);
    } else if (h.root) {
      b.head.rotation.z = still * (h.down - 0.12 * Math.sin(t * 4 + ph)) + m * 0.05 * Math.sin(t * 5 + ph);
    } else {
      // grazing, with the head lifted now and then to chew and look round
      const look = Math.pow(Math.max(0, Math.sin(t * 0.31 + ph)), 6);
      b.head.rotation.z = still * h.down * (1 - look) + m * 0.06 * Math.sin(t * 6 + ph);
      b.head.rotation.y = look * 0.45 * Math.sin(t * 0.5 + ph);
    }
    for (let i = 0; i < b.legs.length; i++) b.legs[i].rotation.z = m * h.legs * Math.sin(t * h.step + ph + (i === 0 || i === 3 ? 0 : Math.PI));
    if (h.bounce) b.g.position.y = m * h.bounce * Math.abs(Math.sin(t * 7 + ph));
  });
}
function fenceX(k: Kit, x0: number, x1: number, z: number, post: number, rail: number) {
  const n = Math.max(1, Math.round((x1 - x0) / 1.8));
  for (let i = 0; i <= n; i++) k.box(x0 + ((x1 - x0) * i) / n, 0, z, 0.1, 1.05, 0.1, post);
  for (const y of [0.42, 0.82]) k.box((x0 + x1) / 2, y, z + 0.06, Math.abs(x1 - x0), 0.09, 0.04, rail);
}
function fenceZ(k: Kit, z0: number, z1: number, x: number, post: number, rail: number) {
  const n = Math.max(1, Math.round(Math.abs(z1 - z0) / 1.8));
  for (let i = 1; i < n; i++) k.box(x, 0, z0 + ((z1 - z0) * i) / n, 0.1, 1.05, 0.1, post);
  for (const y of [0.42, 0.82]) k.box(x + 0.06, y, (z0 + z1) / 2, 0.04, 0.09, Math.abs(z1 - z0), rail);
}
/** a red barn, its gable end and big doors toward +z */
function barn(k: Kit, bx: number, bz: number, W: number, D: number, Hw: number) {
  const red = 0xa8342a, trim = 0xf0ece0, roof = 0x3e4248, doors = 0x7a2a20, zf = bz + D / 2;
  k.box(bx, 0, bz, W, Hw, D, red);
  // the gable: a square turned 45 degrees about its centre, half of it inside the walls
  const side = W / Math.SQRT2;
  lift(k.group(bx, bz, 0, () => k.box(0, -side / 2, 0, side, side, D - 0.04, red)), Hw).rotation.z = Math.PI / 4;
  const e = W / 2 + 0.35, t = 0.16, L = e * Math.SQRT2 + 0.12, o = t / (2 * Math.SQRT2);
  for (const s of [-1, 1]) {
    const g = lift(k.group(bx + s * (e / 2 + o), bz, 0, () => k.box(0, -t / 2, 0, L, t, D + 0.5, roof)), Hw - 0.35 + e / 2 + o);
    g.rotation.z = -s * Math.PI / 4;
  }
  for (const s of [-1, 1]) {
    k.box(bx + s * 0.85, 0, zf + 0.03, 1.6, 2.9, 0.06, doors);
    k.box(bx + s * 1.75, 0, zf + 0.05, 0.12, 2.9, 0.06, trim);
    const br = k.box(bx + s * 0.85 - s * 0.8, 0, zf + 0.07, 0.1, 3.31, 0.03, trim);
    br.rotation.z = -s * 0.504;
  }
  k.box(bx, 2.9, zf + 0.05, 3.62, 0.14, 0.06, trim);
  k.box(bx, Hw + 0.45, zf + 0.0, 1.3, 1.25, 0.06, doors);
  k.cyl(bx, Hw + W / 2 - 0.1, bz, 0.03, 1.0, 0x2a2a2a);
  return lift(k.group(bx, bz, 0, () => { k.box(0, 0, 0, 0.7, 0.04, 0.03, 0x2a2a2a); k.box(0.24, 0.04, 0, 0.18, 0.24, 0.03, 0x2a2a2a); }), Hw + W / 2 + 0.85);
}

/** leaning on the sheep pen's fence: sheep and lambs, the pigs in their mud and goats across the yard, hens, the red barn */
const farm: RoomBuilder = (k, c) => {
  const seed = seedOf(c), r = rng(seed ^ 0xfa4), open = isEvent(c, 'farm');
  outdoors(k, c, { city: 0.6, ground: 0x7ea34c, sun: [0.4, -0.8, 0.35] });
  const gravel = 0xcdbf98, post = 0x6a5038, rail = 0x8a6a48;
  k.box(0, 0, 1.8, 26, 0.012, 3.2, gravel);
  k.box(0, 0, -8.1, 30, 0.012, 2.6, gravel);
  // the sheep pen you lean on; the pigs' and goats' pens across the yard
  fenceX(k, -4, 3.6, 0, post, rail); fenceX(k, -4, 3.6, -6.6, post, rail); fenceZ(k, 0, -6.6, -4, post, rail); fenceZ(k, 0, -6.6, 3.6, post, rail);
  fenceX(k, -10, -4.6, -9.4, post, rail); fenceX(k, -10, -4.6, -14.2, post, rail); fenceZ(k, -9.4, -14.2, -4.6, post, rail); fenceZ(k, -9.4, -14.2, -10, post, rail);
  fenceX(k, 1, 8, -9.4, post, rail); fenceX(k, 1, 8, -14.6, post, rail); fenceZ(k, -9.4, -14.6, 1, post, rail); fenceZ(k, -9.4, -14.6, 8, post, rail);
  k.box(2.7, 0, -5.7, 1.4, 0.38, 0.42, 0x6a7078); k.box(2.7, 0.38, -5.7, 1.3, 0.008, 0.34, 0x5a8aa8);
  // the pigs' mud and wallow, their sty; the goats' log and house
  k.box(-7.3, 0, -11.8, 5.2, 0.016, 4.6, 0x5e4430); k.box(-6.4, 0, -12.2, 2.0, 0.022, 1.4, 0x4a3828);
  k.box(-8.8, 0, -13.3, 1.8, 1.1, 1.4, 0x8a6a4a); k.box(-8.8, 0, -12.58, 0.7, 0.75, 0.02, 0x2a2018);
  k.box(-8.8, 1.08, -13.3, 2.1, 0.12, 1.7, 0x5a4a3a).rotation.x = 0.12;
  k.cyl(4.8 + 1.1, 0.3, -12.0, 0.3, 2.2, 0x6a4a32).rotation.z = Math.PI / 2;
  k.box(7.0, 0, -13.8, 1.6, 1.3, 1.4, 0xa07850); k.box(7.0, 0, -13.08, 0.6, 0.8, 0.02, 0x2a2018);
  k.box(7.0, 1.28, -13.8, 1.8, 0.12, 1.7, 0x5a4a3a).rotation.x = 0.12;
  // the barn, hay bales stacked and round
  const vane = barn(k, 0.6, -19.8, 8, 6, 4.2);
  const hay = 0xd8bc6a;
  for (let i = 0; i < 3; i++) k.box(5.2 + i * 1.05, 0, -16.0, 1.0, 0.45, 0.5, hay);
  for (let i = 0; i < 2; i++) k.box(5.7 + i * 1.05, 0.45, -16.0, 1.0, 0.45, 0.5, hay);
  k.box(6.2, 0.9, -16.0, 1.0, 0.45, 0.5, 0xd0b260);
  for (const [x, z] of [[-4.2, -17.0], [-5.7, -17.4]]) k.cyl(x + 0.6, 0.65, z, 0.65, 1.2, 0xc8aa58).rotation.z = Math.PI / 2;
  if (open) for (let i = 0; i < 12; i++) {
    const f = i / 11, x = 0.6 - 4.4 + f * 8.8, y = 4.0 - Math.sin(f * Math.PI) * 0.7;
    k.cone(x, y - 0.3, -16.7, 0.13, 0.3, pick(r, BRIGHT)).rotation.x = Math.PI;
  }
  for (const [x, z, s] of [[-14, -12, 1.1], [-16, -22, 1.3], [-8, -27, 1.2], [9, -26, 1.3], [15, -18, 1.1], [13, -8, 0.9], [-13, -3, 1.0], [18, -30, 1.4]]) (r() < 0.75 ? tree : pine)(k, r, x, z, s);

  // the animals, each roaming its pen at its own pace
  for (let i = 0; i < 5; i++) {
    const b = sheep(k, r, 0.95 + r() * 0.15);
    animate(k, b, roam(seed * 7 + i, { x0: -3.3, x1: 3.0, z0: -1.1, z1: -6.0 }, 14 + r() * 10, 0.28), { down: -1.2, legs: 0.35, step: 5 }, r() * 6);
  }
  for (let i = 0; i < 3; i++) {
    const b = sheep(k, r, 0.56 + r() * 0.08);
    animate(k, b, roam(seed * 11 + i, { x0: -3.0, x1: 2.6, z0: -0.9, z1: -5.6 }, 6 + r() * 4, 0.4), { down: -1.0, legs: 0.5, step: 9, bounce: 0.09 }, r() * 6);
  }
  for (let i = 0; i < 3; i++) {
    const b = pig(k, r, 0.9 + r() * 0.2);
    animate(k, b, roam(seed * 13 + i, { x0: -9.3, x1: -5.3, z0: -10.2, z1: -13.0 }, 18 + r() * 8, 0.25), { down: -0.35, legs: 0.3, step: 6, root: true }, r() * 6);
  }
  const lying = pig(k, r, 1.0, true);
  lying.g.position.set(-6.2, 0, -12.3); lying.g.rotation.y = 0.4;
  k.animate.push((t) => { lying.head.rotation.z = -0.15 + 0.05 * Math.sin(t * 0.4); });
  for (let i = 0; i < 2; i++) {
    const b = goat(k, r, 0.9 + r() * 0.15);
    const pen = i ? { x0: 6.0, x1: 7.4, z0: -10.2, z1: -12.6 } : { x0: 1.6, x1: 3.4, z0: -11.0, z1: -14.0 };
    animate(k, b, roam(seed * 17 + i, pen, 12 + r() * 6, 0.3), { down: -0.9, legs: 0.35, step: 6 }, r() * 6);
  }
  // a goat up on the log looking about, and one at the fence taking feed from two children
  const top = goat(k, r, 0.85), fed = goat(k, r, 0.95);
  top.g.position.set(4.7, 0.58, -12.0); top.g.rotation.y = -Math.PI / 2 + 0.5;
  fed.g.position.set(2.45, 0, -9.95); fed.g.rotation.y = -Math.PI / 2;
  k.animate.push((t) => {
    top.head.rotation.y = 0.7 * Math.sin(t * 0.27) + 0.2 * Math.sin(t * 0.9);
    top.head.rotation.z = 0.15 + 0.1 * Math.sin(t * 0.4);
    const nib = Math.pow(Math.max(0, Math.sin(t * 0.8)), 2);
    fed.head.rotation.z = 0.25 + 0.2 * nib + 0.05 * Math.sin(t * 7);
    fed.head.rotation.y = 0.15 * Math.sin(t * 0.5);
    fed.g.position.z = -9.95 + 0.06 * nib;
  });
  for (let i = 0; i < 8; i++) {
    const b = hen(k, r, 0.9 + r() * 0.2);
    const pen = i < 6 ? { x0: -8, x1: 8, z0: -7.1, z1: -9.0 } : { x0: -3, x1: 2.4, z0: -0.7, z1: -2.4 };
    animate(k, b, roam(seed * 19 + i, pen, 3 + r() * 3, 0.4), { down: -1.1, legs: 0, step: 0, peck: true }, r() * 6);
  }

  // children feeding the goat, a parent behind them; a family at the pigs; the farmhands
  for (let i = 0; i < 2; i++) {
    const kid = bare(visitor(c, 10 + i, LifeStage.Child)), ph = r() * 6;
    k.bodies.push({ look: kid, x: 2.15 + i * 0.62, y: 0, z: -8.95, yaw: Math.PI / 2 + (i ? -0.25 : 0.2), swing: 0, pose: 1, ph: i,
      move: (t, b) => { b.pose = 0.55 + 0.45 * Math.sin(t * 0.7 + ph); } });
  }
  k.stand(visitor(c, 12, LifeStage.Adult), 3.4, -8.4, Math.PI / 2 + 0.35, 0, 2);
  for (let i = 0; i < 3; i++) {
    const kid = i === 2;
    k.stand(kid ? bare(visitor(c, 20 + i, LifeStage.Child)) : visitor(c, 20 + i, crowdStage(r, 0, 0.3)), -7.6 + i * 0.75, -8.95, Math.PI / 2 + (r() - 0.5) * 0.4, kid ? 1 : 0, 3 + i);
  }
  const hand = (slot: number) => dress(staff(c, slot), 0x3a5a3a, 0x3a5a3a, 0, CARRY | BIT.coat);
  k.stand(hand(0), 4.3, -15.3, yawTo(4.3, -15.3, 6.2, -16.0), -0.9, 6);
  lineWalker(k, hand(1), -9, -8.0, 9, -8.3, 0.75, r());
  for (let i = 0; i < (open ? 5 : 2); i++) lineWalker(k, visitor(c, 30 + i, crowdStage(r, 0.35, 0.2)), -12 + r() * 3, -7.5 - r() * 1.2, 12 - r() * 3, -7.6 - r() * 1.2, 0.8 + r() * 0.5, r());
  if (open) for (let i = 0; i < 4; i++) k.stand(visitor(c, 40 + i, crowdStage(r, 0.4, 0.2)), -1.5 + i * 0.8, -16.0 + r() * 0.6, -Math.PI / 2 + (r() - 0.5), 0, 8 + i);
  // your family at the fence beside you
  companions(c, 3).forEach((m, i) => k.stand(m.look, 0.72 + i * 0.62, 0.42, Math.PI / 2 + (hash2(m.id, 3) - 0.5) * 0.4, 0, i));
  k.animate.push((t) => { vane.rotation.y = 0.6 * Math.sin(t * 0.13) + 0.2 * Math.sin(t * 0.57); });
  return {
    eye: new Vector3(0, eyeStanding(c) - 0.06, 0.5), aim: new Vector3(0.4, 0.45, -4.2),
    glances: [new Vector3(2.45, 0.9, -9.6), new Vector3(-7.2, 0.4, -11.8), new Vector3(0.6, 3.6, -16.8), new Vector3(4.7, 1.1, -12), new Vector3(-1, 0.25, -1.6)],
    label: open ? 'at the farm open day' : 'at the city farm, by the sheep pen',
  };
};

// ---- the aquarium -----------------------------------------------------------------------------------

/** a fish built along +z (so lookAt points it where it swims), a tail fin behind */
function fishOf(k: Kit, body: number | Material, fin: number | Material, s: number) {
  return k.group(0, 0, 0, () => {
    k.ball(0, 0, 0, 0.026 * s, 0.055 * s, 0.12 * s, body);
    k.box(0, -0.035 * s, -0.13 * s, 0.012 * s, 0.07 * s, 0.06 * s, fin);
  });
}

/** walking through the glass tunnel under the water: shoals overhead, a ray gliding over, a turtle, a shark going round */
const aquarium: RoomBuilder = (k, c) => {
  const seed = seedOf(c), r = rng(seed ^ 0xa9a), feeding = isEvent(c, 'aquarium');
  k.scene.background = new Color(0x05263e);
  k.scene.fog = new Fog(0x0a3554, 2.5, 26);
  k.daylight = 0; k.ambientNight = 0.9;
  const R = 2.0, CY = 0.3, Z0 = 4, Z1 = -26;
  // sand, the walk, the tunnel's sills with their blue lights, the way in behind
  k.box(0, -0.05, -10, 60, 0.05, 60, 0xb8a87a);
  k.box(0, 0, (Z0 + Z1) / 2, 3.9, 0.025, Z0 - Z1, 0x1c2632);
  const led = k.glow(0x3ab8ff, 1.3);
  for (const s of [-1, 1]) { k.box(s * 1.93, 0, (Z0 + Z1) / 2, 0.22, 0.3, Z0 - Z1, 0x2a3440); k.box(s * 1.79, 0.3, (Z0 + Z1) / 2, 0.05, 0.02, Z0 - Z1, led); }
  k.box(0, 0, Z0 + 0.1, 6, 3.2, 0.2, 0x10161e);
  // the glass tunnel: ribs every three metres round the arch
  const rib = k.mat(0x2a3440);
  for (let z = 3; z > Z1; z -= 3) for (let j = 0; j < 7; j++) {
    const a0 = (j / 7) * Math.PI, a1 = ((j + 1) / 7) * Math.PI;
    bar(k, new Vector3(R * Math.cos(a0), CY + R * Math.sin(a0), z), new Vector3(R * Math.cos(a1), CY + R * Math.sin(a1), z), 0.07, rib);
  }
  // rocks, the tank's rocky sides far off in the blue, coral glowing on the sand, kelp swaying
  const ROCK = [0x4a4a48, 0x5a5248, 0x3e4044, 0x6a5e50];
  for (let i = 0; i < 12; i++) {
    const s = r() < 0.5 ? -1 : 1, rr = 0.4 + r() * 1.0;
    k.ball(s * (2.7 + r() * 5), rr * 0.3, 2 - r() * 24, rr, rr * 0.7, rr * 0.9, pick(r, ROCK));
  }
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) k.ball(s * (9 + r() * 2), 1.5, -2 - i * 9 - r() * 3, 2.5 + r(), 3 + r() * 2, 4 + r() * 1.5, pick(r, ROCK));
  const CORAL = [0xff6a8a, 0xff9a3a, 0xc05aff, 0xffd23a, 0x3affd0, 0xff4a5a];
  for (let i = 0; i < 9; i++) {
    const s = i % 2 ? 1 : -1, x = s * (2.5 + r() * 1.6), z = 1 - i * 2.6 - r() * 1.2;
    const mat = k.glow(pick(r, CORAL), 0.55 + r() * 0.25), kind = Math.floor(r() * 3);
    if (kind === 0) k.ball(x, 0.1, z, 0.35, 0.25, 0.32, mat);
    else if (kind === 1) for (let j = 0; j < 4; j++) k.cyl(x + (r() - 0.5) * 0.3, 0, z + (r() - 0.5) * 0.3, 0.035, 0.4 + r() * 0.45, mat).rotation.set((r() - 0.5) * 0.7, 0, (r() - 0.5) * 0.7);
    else k.box(x, 0.05, z, 0.8, 0.9, 0.03, mat, r() * 3).rotation.z = (r() - 0.5) * 0.25;
    k.ball(x + (r() - 0.5) * 0.7, 0.06, z + (r() - 0.5) * 0.7, 0.18, 0.12, 0.18, k.glow(pick(r, CORAL), 0.5));
  }
  const kelp: { a: Group; b: Group; ph: number; f: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const s = i % 2 ? 1 : -1, h = 1.6 + r() * 1.4, col = pick(r, [0x4a7a2a, 0x5a8a32, 0x3a6a2a]);
    let b!: Group;
    const a = k.group(s * (4.5 + r() * 3.5), 2 - r() * 22, r() * 3, () => {
      k.box(0, 0, 0, 0.18, h, 0.03, col);
      b = lift(k.group(0, 0, 0, () => k.box(0, 0, 0, 0.15, h * 0.9, 0.03, col)), h);
    });
    kelp.push({ a, b, ph: r() * 6, f: 0.5 + r() * 0.4 });
  }
  // light coming down from the surface
  const rays: MeshBasicMaterial[] = [];
  for (let i = 0; i < 5; i++) {
    const m = clear(k, 0x7ad8ff, 0.06, true);
    const ray = k.box((r() - 0.5) * 14, 2.6, -2 - r() * 16, 0.6 + r() * 0.8, 12, 0.6 + r() * 0.8, m);
    ray.rotation.z = (r() - 0.5) * 0.4; ray.rotation.x = (r() - 0.5) * 0.2;
    rays.push(m);
  }
  // nothing swims into the tunnel: anything that would is pushed out round the glass
  const outside = (p: Vector3) => {
    if (p.z < Z0) {
      const dy = p.y - CY, d = Math.hypot(p.x, dy), min = R + 0.3;
      if (d < min && dy > -0.6) { const s = min / Math.max(d, 1e-3); p.x = d < 1e-3 ? 0 : p.x * s; p.y = d < 1e-3 ? CY + min : CY + dy * s; }
    }
    if (p.y < 0.2) p.y = 0.2;
    return p;
  };
  // shoals: each fish keeps its place in the shoal, a little behind or ahead in time, wobbling on its own
  const shoal = (n: number, body: number | Material, fin: number | Material, size: number, path: (t: number, out: Vector3) => Vector3, spread: [number, number, number]) => {
    const fish = Array.from({ length: n }, () => ({ g: fishOf(k, body, fin, size * (0.8 + r() * 0.4)), f: (r() - 0.5) * 2 * spread[0], s: (r() - 0.5) * 2 * spread[1], u: (r() - 0.5) * 2 * spread[2], ph: r() * 6, lag: r() * 0.5 }));
    const p = new Vector3(), q = new Vector3(), a = new Vector3(), b = new Vector3();
    const place = (t: number, f: typeof fish[number], out: Vector3) => {
      path(t, p); path(t + 0.1, q);
      const [hx, hz] = unit(q.x - p.x, q.z - p.z), wob = 0.12 * Math.sin(t * 0.9 + f.ph);
      return outside(out.set(p.x + hx * (f.f + wob) - hz * f.s, p.y + f.u + 0.06 * Math.sin(t * 1.3 + f.ph * 2), p.z + hz * (f.f + wob) + hx * f.s));
    };
    k.animate.push((t) => {
      for (const f of fish) {
        place(t - f.lag, f, a); place(t - f.lag + 0.08, f, b);
        f.g.position.copy(a); f.g.lookAt(b); f.g.rotateY(0.18 * Math.sin(t * 9 + f.ph));
      }
    });
  };
  const silver = k.glow(0xa8d4f0, 0.75);
  shoal(26, silver, silver, 1, (t, o) => { const a = t * 0.22; return o.set(3.4 * Math.cos(a), 3.5 + 0.5 * Math.sin(2 * a + 1), -6 + 4.5 * Math.sin(a)); }, [1.0, 1.0, 0.4]);
  const tang = sheen(k, 0xf6d32a, 0x4a3a00);
  shoal(20, tang, tang, 1.25, (t, o) => { const a = -t * 0.17; return o.set(-4.4 + 1.6 * Math.cos(a), 1.3 + 0.4 * Math.sin(a * 2), -9 + 5.5 * Math.sin(a)); }, [0.7, 0.7, 0.35]);
  const clown = sheen(k, 0xff7a2a, 0x4a1a00), white = k.glow(0xf4f4f0, 0.8);
  shoal(16, clown, white, 0.9, feeding
    ? (t, o) => { const a = t * 0.6; return o.set(3.4 + 0.8 * Math.cos(a), 1.5 + 0.3 * Math.sin(a * 1.7), -6.5 + 0.8 * Math.sin(a)); }
    : (t, o) => { const a = t * 0.2; return o.set(4.2 + 1.3 * Math.sin(2 * a), 1.0 + 0.3 * Math.sin(3 * a), -6 + 4 * Math.sin(a)); }, [0.5, 0.5, 0.3]);
  // a shark going round, over the tunnel and down beside it
  const grey = 0x6e7a86;
  const shark = k.group(0, 0, 0, () => {
    k.ball(0, 0, 0, 0.17, 0.19, 0.85, grey);
    k.ball(0, -0.06, 0.05, 0.13, 0.12, 0.7, 0xd8dce0);
    k.box(0, 0.12, 0.05, 0.03, 0.32, 0.22, grey).rotation.x = -0.5;
    k.box(0, 0, -0.8, 0.03, 0.42, 0.18, grey).rotation.x = -0.6;
    for (const s of [-1, 1]) k.box(s * 0.25, -0.1, 0.2, 0.32, 0.025, 0.16, grey).rotation.z = s * -0.3;
  });
  // two big groupers hanging about by the glass
  const groupers = [-1, 1].map((s) => ({ s, g: k.group(0, 0, 0, () => {
    k.ball(0, 0, 0, 0.2, 0.25, 0.55, 0x6a5a48); k.box(0, -0.12, -0.6, 0.03, 0.26, 0.16, 0x5a4a38); k.box(0, 0.18, -0.05, 0.03, 0.14, 0.4, 0x5a4a38);
  }), cz: -4 - r() * 8, ph: r() * 6 }));
  // a ray gliding overhead, its wings beating slowly
  let wl!: Group, wr!: Group;
  const ray = k.group(0, 0, 0, () => {
    k.ball(0, 0, 0, 0.24, 0.07, 0.42, 0x4a5662);
    k.ball(0, -0.025, 0.02, 0.2, 0.05, 0.34, 0xe0e4e8);
    wl = k.group(0.12, 0, 0, () => k.ball(0.38, 0, -0.04, 0.42, 0.035, 0.3, 0x4a5662));
    wr = k.group(-0.12, 0, 0, () => k.ball(-0.38, 0, -0.04, 0.42, 0.035, 0.3, 0x4a5662));
    k.box(0, -0.01, -1.4, 0.02, 0.02, 1.0, 0x3a444e);
  });
  // a turtle paddling past on the right
  const flip: Group[] = [];
  const turtle = k.group(0, 0, 0, () => {
    k.ball(0, 0.03, 0, 0.36, 0.14, 0.46, 0x5a5230);
    k.ball(0, -0.04, 0, 0.32, 0.08, 0.4, 0xc8b880);
    k.ball(0, 0.02, 0.52, 0.12, 0.1, 0.14, 0x7a7a52);
    for (const [sx, sz, len] of [[1, 0.22, 0.42], [-1, 0.22, 0.42], [1, -0.3, 0.2], [-1, -0.3, 0.2]]) flip.push(k.group(sx * 0.28, sz, 0, () => k.ball(sx * len * 0.5, 0, 0, len * 0.55, 0.025, 0.1, 0x7a7a52)));
  });
  // bubbles from a bubbler among the rocks (and the diver, at feeding time)
  const bubbleMat = k.glow(0xd8f4ff, 0.9);
  const bubbles = Array.from({ length: feeding ? 12 : 8 }, (_, i) => ({ m: k.ball(0, 0, 0, 0.04, 0.04, 0.04, bubbleMat), diver: i >= 8, ph: r(), s: 0.6 + r() * 0.8 }));
  const pos = new Vector3(), ahead = new Vector3();
  k.animate.push((t) => {
    // the shark
    const sp = (tt: number, o: Vector3) => { const a = tt * 0.11; return outside(o.set(5.2 * Math.cos(a), 1.7 + 1.9 * (1 - Math.abs(Math.cos(a))), -8 + 9 * Math.sin(a))); };
    sp(t, pos); sp(t + 0.2, ahead); shark.position.copy(pos); shark.lookAt(ahead); shark.rotateY(0.1 * Math.sin(t * 2.2));
    for (const g of groupers) {
      const gp = (tt: number, o: Vector3) => { const a = tt * 0.09 * g.s + g.ph; return o.set(g.s * 3.4 + 0.6 * Math.cos(a), 0.75 + 0.15 * Math.sin(tt * 0.3 + g.ph), g.cz + 1.6 * Math.sin(a)); };
      gp(t, pos); gp(t + 0.3, ahead); g.g.position.copy(pos); g.g.lookAt(ahead); g.g.rotateY(0.06 * Math.sin(t * 1.4 + g.ph));
    }
    const rp = (tt: number, o: Vector3) => { const a = tt * 0.16; return outside(o.set(2.8 * Math.cos(a), 3.3 + 0.3 * Math.sin(a * 2), -5.5 + 4 * Math.sin(a))); };
    rp(t, pos); rp(t + 0.2, ahead); ray.position.copy(pos); ray.lookAt(ahead); ray.rotateZ(-0.22);
    wl.rotation.z = 0.35 * Math.sin(t * 1.6); wr.rotation.z = -0.35 * Math.sin(t * 1.6);
    const tp = (tt: number, o: Vector3) => { const a = tt * 0.05; return o.set(3.4 + 1.0 * Math.cos(a), 1.9 + 0.4 * Math.sin(a * 2), -9 + 6 * Math.sin(a)); };
    tp(t, pos); tp(t + 0.5, ahead); turtle.position.copy(pos); turtle.lookAt(ahead);
    for (let i = 0; i < 4; i++) flip[i].rotation.z = (i % 2 ? -1 : 1) * (i < 2 ? 0.5 : 0.2) * Math.sin(t * 1.1 + (i < 2 ? 0 : 1.5));
    for (const kp of kelp) { kp.a.rotation.z = 0.12 * Math.sin(t * kp.f + kp.ph); kp.a.rotation.x = 0.08 * Math.sin(t * kp.f * 0.7 + kp.ph); kp.b.rotation.z = 0.25 * Math.sin(t * kp.f + kp.ph - 0.8); }
    for (const b of bubbles) {
      const u = (t * 0.12 * b.s + b.ph) % 1;
      if (b.diver) b.m.position.set(3.0 + 0.05 * Math.sin(t * 3 + b.ph * 9), 1.6 + u * 6, -6.5 + 0.05 * Math.cos(t * 2.6 + b.ph * 7));
      else b.m.position.set(-2.8 + 0.08 * Math.sin(t * 2.4 + b.ph * 9), 0.1 + u * 7, -3.2 + 0.08 * Math.cos(t * 2 + b.ph * 7));
      b.m.scale.setScalar(0.06 + u * 0.06);
    }
    // the light rippling down through the water
    const w = 0.5 + 0.5 * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1);
    k.hemi.color.setRGB(0.22 + 0.05 * w, 0.5 + 0.12 * w, 0.72 - 0.06 * w);
    k.hemi.groundColor.setHex(0x0a2030);
    k.hemi.intensity = 0.9 + 0.12 * Math.sin(t * 1.9) + 0.08 * Math.sin(t * 3.1 + 2);
    k.ceil.intensity = 45 * (0.85 + 0.15 * Math.sin(t * 2.3) * Math.sin(t * 0.9 + 1));
    rays.forEach((m, i) => { m.opacity = 0.045 + 0.035 * Math.sin(t * (0.4 + i * 0.13) + i * 2); });
  });
  k.ceilOn = 1; k.ceil.userData.max = 45; k.ceil.position.set(0, 6.5, -6); k.ceil.color.set(0x9adfff); k.ceil.distance = 0;
  k.lampOn = 1; k.lamp.userData.max = 5; k.lamp.color.set(0x6affe0); k.lamp.position.set(3.4, 1.4, -5); k.lamp.distance = 12;
  k.tv.color.set(0x6a8aff); k.tv.intensity = 5; k.tv.position.set(-3.6, 1.4, -10); k.tv.distance = 12;
  // the diver at feeding time, out on the sand by the glass with the food
  if (feeding) {
    const d = visitor(c, 50, LifeStage.Adult);
    const diver: Look = { ...dress(d, 0x15181c, 0x15181c, 0, CARRY | BIT.cap | BIT.coat), a: [d.a[0], 0x15181c, 0x15181c, 0x15181c] };
    const tank = k.cyl(3.24, 0.9, -6.5, 0.1, 0.55, 0xf0c020);
    k.bodies.push({ look: diver, x: 3.0, y: 0.15, z: -6.5, yaw: Math.PI, swing: 0, pose: -0.8, ph: 3, move: (t, b) => { b.y = 0.15 + 0.08 * Math.sin(t * 0.8); tank.position.y = b.y + 0.75; } });
  }
  // people in the tunnel: some stopped to look up and point, some strolling on
  const spots: [number, number, number][] = [[-0.9, -2.6, 1], [0.8, -4.3, 0], [-0.6, -6.4, 1], [0.5, -6.9, 0], [-0.3, -10.5, 0]];
  spots.forEach(([x, z, point], i) => {
    const kid = point === 1;
    const look = kid ? bare(visitor(c, 60 + i, LifeStage.Child)) : visitor(c, 60 + i, crowdStage(r, 0.2, 0.2));
    k.stand(look, x, z, kid ? Math.PI / 2 + (r() - 0.5) * 0.6 : (x > 0 ? 0 : Math.PI) + (r() - 0.5) * 0.8, kid ? 1 : 0, i);
  });
  for (const [i, x, z] of [[0, -0.6, 1.5], [1, 0.95, -1.5], [2, -0.2, -4]]) lineWalker(k, visitor(c, 70 + i, crowdStage(r, 0.3, 0.2)), x, z, x * 0.8, -17 - i * 2, 0.42 + r() * 0.15, r());
  companions(c, 3).forEach((m, i) => k.stand(m.child ? bare(m.look) : m.look, i === 1 ? -0.55 : 0.85 + i * 0.3, -0.3 - i * 0.35, Math.PI / 2 + (i === 1 ? 0.3 : -0.3), m.child ? 1 : 0, i));
  return {
    eye: new Vector3(0.25, eyeStanding(c), 0.2), aim: new Vector3(0, 3.4, -5.5),
    glances: [new Vector3(3.4, 1.8, -7), new Vector3(-3.4, 0.6, -4.5), new Vector3(0, 1.3, -9), new Vector3(-4.4, 1.3, -8), new Vector3(1.5, 3.6, -2.5)],
    label: feeding ? 'watching feeding time at the aquarium' : 'in the aquarium tunnel',
  };
};

// ---- the planetarium --------------------------------------------------------------------------------

/** a direction on the sky from right ascension and declination (degrees), in a frame whose +y is the pole */
const sky = (ra: number, dec: number) => {
  const a = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
  return new Vector3(Math.cos(d) * Math.cos(a), Math.sin(d), -Math.cos(d) * Math.sin(a));
};
/** some of the constellations everyone knows: stars (ra, dec) and the lines between them */
const CONSTELLATIONS: { stars: [number, number][]; lines: [number, number][] }[] = [
  { stars: [[165.9, 61.8], [165.5, 56.4], [178.5, 53.7], [183.9, 57.0], [193.5, 56.0], [200.9, 54.9], [206.9, 49.3]], lines: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6]] },
  { stars: [[2.3, 59.1], [10.1, 56.5], [14.2, 60.7], [21.5, 60.2], [28.6, 63.7]], lines: [[0, 1], [1, 2], [2, 3], [3, 4]] },
  { stars: [[88.8, 7.4], [81.3, 6.3], [85.2, -1.9], [84.1, -1.2], [83.0, -0.3], [86.9, -9.7], [78.6, -8.2]], lines: [[0, 1], [0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6]] },
  { stars: [[310.4, 45.3], [305.6, 40.3], [311.6, 34.0], [296.2, 45.1], [292.7, 28.0]], lines: [[0, 1], [1, 4], [3, 1], [1, 2]] },
  { stars: [[37.9, 89.3]], lines: [] },
];

/** reclined under the dome: the star field turning slowly about the pole, constellations drawn in, a ringed planet and the moon */
const planetarium: RoomBuilder = (k, c) => {
  const seed = seedOf(c), r = rng(seed ^ 0x51a), show = isEvent(c, 'planetarium');
  k.scene.background = new Color(0x000000);
  k.daylight = 0; k.ambientNight = 0.035; k.ceilOn = 0;
  const O = new Vector3(0, 1.4, -1.5), RD = 12.6, RS = 12.0, RK = 11.2, POLE = 0.78;
  k.cyl(O.x, -0.05, O.z, 11.7, 0.05, 0x0c0c10);
  // the dome: dark overhead, a dusky glow round its foot, warmer where the projected sun has set
  const domeGeo = new SphereGeometry(RD, 48, 18, 0, TAU, 0, Math.PI / 2);
  const dp = domeGeo.attributes.position, dc: number[] = [];
  for (let i = 0; i < dp.count; i++) {
    const x = dp.getX(i), y = dp.getY(i), z = dp.getZ(i);
    const el = Math.asin(Math.min(1, y / RD)), az = Math.atan2(z, x);
    const low = 1 - smooth(0, 0.5, el), dusk = Math.pow(Math.max(0, Math.cos(az - 2.4)), 3) * (1 - smooth(0, 0.32, el));
    dc.push(0.004 + 0.02 * low + 0.16 * dusk, 0.005 + 0.05 * low + 0.05 * dusk, 0.012 + 0.11 * low + 0.02 * dusk);
  }
  domeGeo.setAttribute('color', new Float32BufferAttribute(dc, 3));
  custom(k, domeGeo, owned(k, new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, fog: false }))).position.copy(O);
  // the sky, built about the pole (+y), then tilted so the pole stands over the front of the room
  let inner!: Group;
  const twinkle: MeshBasicMaterial[] = [];
  const outer = k.group(0, 0, 0, () => {
    inner = k.group(0, 0, 0, () => {
      const sets = [0, 1, 2, 3].map(() => ({ p: [] as number[], c: [] as number[], i: [] as number[] }));
      const OCT = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], OI = [0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0, 4, 3, 0, 1, 3, 4, 5, 3, 1, 0, 3, 5];
      const star = (d: Vector3, size: number, col: Color) => {
        const s = sets[Math.floor(r() * 4)], base = s.p.length / 3;
        for (const [a, b, e] of OCT) { s.p.push(d.x * RS + a * size, d.y * RS + b * size, d.z * RS + e * size); s.c.push(col.r, col.g, col.b); }
        for (const i of OI) s.i.push(base + i);
      };
      const TINT = [new Color(1, 1, 1), new Color(0.8, 0.88, 1.15), new Color(1.1, 1.0, 0.75), new Color(1.15, 0.8, 0.6)];
      const col = new Color(), d = new Vector3();
      // the field: mostly faint, a few bright, none that never rise
      for (let n = 0; n < 900; n++) {
        const sd = Math.sin(-0.75) + r() * (1 - Math.sin(-0.75)), a = r() * TAU, cd = Math.sqrt(1 - sd * sd);
        d.set(cd * Math.cos(a), sd, -cd * Math.sin(a));
        const m = Math.pow(r(), 3);
        star(d, 0.02 + 0.05 * m, col.copy(pick(r, TINT)).multiplyScalar(0.28 + 2.2 * m));
      }
      // the Milky Way: a band of fainter stars round a great circle, and its glow
      const n = new Vector3(0.45, 0.35, 0.82).normalize(), e1 = new Vector3(0, 1, 0).cross(n).normalize(), e2 = n.clone().cross(e1);
      const mw = clear(k, 0x8a96c8, 0.05, true);
      for (let i = 0; i < 900; i++) {
        const u = r() * TAU, off = (r() + r() + r() - 1.5) * 0.16;
        d.copy(e1).multiplyScalar(Math.cos(u)).addScaledVector(e2, Math.sin(u)).multiplyScalar(Math.cos(off)).addScaledVector(n, Math.sin(off)).normalize();
        if (d.y < -0.7) continue;
        star(d, 0.016 + r() * 0.01, col.setRGB(0.18 + r() * 0.12, 0.19 + r() * 0.12, 0.24 + r() * 0.12));
        if (i % 150 === 0) { const g = d.clone().multiplyScalar(11.4); k.ball(g.x, g.y, g.z, 1.2 + r(), 1.2 + r(), 1.2 + r(), mw); }
      }
      // the constellations: their stars bright, faint lines between them
      const line = clear(k, 0x6a8ad8, 0.4);
      for (const con of CONSTELLATIONS) {
        const pts = con.stars.map(([ra, dec]) => sky(ra, dec));
        pts.forEach((p) => star(p, 0.07, col.setRGB(2.4, 2.4, 2.6)));
        for (const [a, b] of con.lines) bar(k, pts[a].clone().multiplyScalar(RS - 0.1), pts[b].clone().multiplyScalar(RS - 0.1), 0.025, line);
      }
      sets.forEach((s, i) => {
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute(s.p, 3)); g.setAttribute('color', new Float32BufferAttribute(s.c, 3)); g.setIndex(s.i);
        const m = owned(k, new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, fog: false }));
        twinkle[i] = m;
        custom(k, g, m);
      });
      // a ringed planet and the moon, near enough the pole to circle round it all show
      const sat = sky(120, 55).multiplyScalar(10);
      k.ball(sat.x, sat.y, sat.z, 0.32, 0.3, 0.32, k.glow(0xe8d4a0, 1.3));
      const ring = custom(k, new RingGeometry(0.45, 0.8, 40), owned(k, new MeshBasicMaterial({ color: new Color(0xd8c08a).multiplyScalar(1.1), side: DoubleSide, transparent: true, opacity: 0.85, fog: false })));
      ring.position.copy(sat); ring.lookAt(0, 0, 0); ring.rotateX(1.15);
      const moon = sky(300, 48).multiplyScalar(10), toward = moon.clone().normalize().multiplyScalar(-1);
      k.ball(moon.x, moon.y, moon.z, 0.6, 0.6, 0.6, k.glow(0xe8e6da, 1.25));
      const t1 = new Vector3(0, 1, 0).cross(toward).normalize(), t2 = toward.clone().cross(t1);
      for (const [a, b, s] of [[0.2, 0.15, 0.14], [-0.25, -0.1, 0.18], [0.05, -0.3, 0.1], [-0.1, 0.3, 0.12]]) {
        const p = moon.clone().addScaledVector(toward, 0.5).addScaledVector(t1, a).addScaledVector(t2, b);
        k.ball(p.x, p.y, p.z, s, s, s, k.glow(0xb4b2a8, 1.0));
      }
    });
  });
  outer.position.copy(O); outer.rotation.x = -(Math.PI / 2 - POLE);
  const spin0 = r() * TAU;
  // the town's skyline in silhouette round the foot of the dome (it hides the stars below the horizon)
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * TAU, h = 1.3 + (r() < 0.2 ? 1.6 + r() * 0.8 : r() * 1.2);
    k.box(O.x + RK * Math.cos(a), 0, O.z + RK * Math.sin(a), 2.42, h, 0.4, 0x030304, Math.PI / 2 - a);
    if (r() < 0.3) { const ta = a + 0.1; k.ball(O.x + (RK - 0.1) * Math.cos(ta), h + 0.4, O.z + (RK - 0.1) * Math.sin(ta), 0.6, 0.7, 0.6, 0x030304); }
    if (r() < 0.35) { const wa = a + (r() - 0.5) * 0.08; k.box(O.x + (RK - 0.22) * Math.cos(wa), h * (0.3 + r() * 0.5), O.z + (RK - 0.22) * Math.sin(wa), 0.12, 0.14, 0.02, k.glow(0xffc070, 0.25), Math.PI / 2 - wa); }
  }
  // rows of reclining seats facing the front, people in them in silhouette, the projector before them
  const seatCol = pick(r, [0x1a2440, 0x3a1420, 0x1e1e26]);
  const rows = [-3.0, -1.6, -0.2, 1.2, 2.6], my = 5;
  const mates = companions(c, 2);
  let n = 0;
  rows.forEach((zr, ri) => {
    k.box(0, 0, zr, 7.4, 0.4, 0.55, seatCol);
    for (let i = 0; i < 10; i++) {
      const x = (i - 4.5) * 0.72;
      lift(k.group(x, zr + 0.27, 0, () => k.box(0, 0, 0, 0.6, 0.95, 0.08, seatCol)), 0.38).rotation.x = 0.55;
      if (ri === 4) {
        // your row: your family either side of you
        const m = i === my + 1 ? mates[0] : i === my - 1 ? mates[1] : undefined;
        if (m) k.sit(bare(m.look), x, zr + 0.04, 0.42, Math.PI / 2, 0, i);
        continue;
      }
      if (r() < 0.55) k.sit(bare(visitor(c, 100 + n, crowdStage(r, 0.3, 0.2))), x, zr + 0.04, 0.42, Math.PI / 2 + (r() - 0.5) * 0.1, 0, n++);
    }
  });
  for (const s of [-1, 1]) for (let i = 0; i < 5; i++) k.box(s * 3.95, 0, rows[i] + 0.4, 0.12, 0.03, 0.06, k.glow(0xffa040, 0.6));
  k.cyl(0, 0, -5.0, 0.38, 1.3, 0x14161c);
  for (const s of [-1, 1]) k.box(s * 0.32, 1.25, -5.0, 0.08, 0.4, 0.2, 0x14161c);
  let pinner!: Group;
  const proj = lift(k.group(0, -5.0, 0, () => {
    pinner = k.group(0, 0, 0, () => {
      k.cyl(0, -0.8, 0, 0.09, 1.6, 0x22252e);
      const lens = k.glow(0x9ab8ff, 1.1);
      for (const s of [-1, 1]) {
        k.ball(0, s * 0.78, 0, 0.36, 0.36, 0.36, 0x1a1c24);
        for (let i = 0; i < 6; i++) { const a = i * 1.05 + s, e = 0.3 + r() * 0.5; k.ball(0.35 * Math.cos(a) * Math.cos(e), s * (0.78 + 0.35 * Math.sin(e)), 0.35 * Math.sin(a) * Math.cos(e), 0.035, 0.035, 0.035, lens); }
      }
    });
  }), 1.6);
  proj.rotation.x = -(Math.PI / 2 - POLE);
  // now and then a shooting star
  const streak = clear(k, 0xeef4ff, 0.9, true);
  const shoot = bar(k, new Vector3(0, 5, -5), new Vector3(0, 5.1, -5), 0.03, streak);
  const sa = new Vector3(), sb = new Vector3(), from = new Vector3(), to = new Vector3();
  k.animate.push((t) => {
    inner.rotation.y = spin0 - t * 0.03; pinner.rotation.y = inner.rotation.y;
    twinkle.forEach((m, i) => m.color.setScalar(0.86 + 0.14 * Math.sin(t * (1.3 + i * 0.7) + i * 2.1) * Math.sin(t * (0.37 + i * 0.21))));
    const P = 11, s = t / P, nn = Math.floor(s), f = (s - nn) * P / 0.7;
    if (f > 1 || hash2(seed, nn) < 0.3) { shoot.visible = false; return; }
    shoot.visible = true;
    const az = (hash2(seed, nn * 3 + 1) - 0.5) * 1.6, el = 0.5 + hash2(seed, nn * 3 + 2) * 0.6;
    from.set(Math.sin(-az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(11).add(O);
    to.copy(from).add(new Vector3(hash2(seed, nn * 3 + 3) - 0.5, -0.6, 0.3).normalize().multiplyScalar(3));
    sa.lerpVectors(from, to, Math.max(0, f - 0.35)); sb.lerpVectors(from, to, f);
    setBar(shoot, sa, sb, 0.03);
  });
  k.lampOn = 1; k.lamp.userData.max = 1.4; k.lamp.color.set(0x3050a0); k.lamp.position.set(0, 2.6, -4);
  const eye = new Vector3((my - 4.5) * 0.72, 0.95, rows[4] + 0.5);
  const look = (t: number) => {
    const dip = Math.pow(Math.max(0, Math.sin(t * 0.13 + 1)), 14);
    return { yaw: 0.05 + 0.32 * Math.sin(t * 0.041) + 0.12 * Math.sin(t * 0.13 + 2), pitch: 0.72 + 0.13 * Math.sin(t * 0.033 + 1) - 0.55 * dip, roll: 0.03 * Math.sin(t * 0.05) };
  };
  const l0 = look(0);
  return {
    eye, aim: eye.clone().add(new Vector3(-Math.sin(l0.yaw) * Math.cos(l0.pitch), Math.sin(l0.pitch), -Math.cos(l0.yaw) * Math.cos(l0.pitch)).multiplyScalar(10)),
    glances: [], move: (t) => look(t),
    label: show ? 'at the star show' : 'under the stars at the planetarium',
  };
};

// ---- the science centre -----------------------------------------------------------------------------

/** at the rail of the Foucault pendulum in a bright hall: the bob swinging and knocking down pins as its swing turns, a DNA helix
 * turning, a plasma ball, a giant bubble rising round a child, consoles of buttons and levers, the planets going round overhead */
const science: RoomBuilder = (k, c) => {
  const seed = seedOf(c), r = rng(seed ^ 0x5c1), late = isEvent(c, 'science');
  const W = 26, D = 22, H = 11;
  k.shell(W, D, H, 0xeef0f2, 0x5f7f9c, 0x3c414a, -1);
  for (let i = 0; i < 4; i++) k.box(0, H - 0.9, -D / 2 + 3 + i * 5.3, W, 0.45, 0.3, 0x5a606a);
  strips(k, W, D, H - 0.9, 4, 3);
  k.window('left', -5, 1.5, 5, 5.5, seed); k.window('left', 4, 1.5, 5, 5.5, seed + 1);
  // big colour panels on the walls
  for (const [x, col] of [[-8, 0xe74c3c], [-2.5, 0xf1c40f], [3.5, 0x2e86de], [9, 0x27ae60]] as [number, number][]) {
    k.onWall('back', x, () => { k.box(0, 2.0, 0.02, 4.2, 3.4, 0.04, col); k.ball(0.6, 3.4, 0.05, 1.0, 1.0, 0.01, 0xf4f4f0); });
  }
  for (const [z, col] of [[-6, 0x8e44ad], [0, 0xe67e22], [6, 0x16a085]] as [number, number][]) k.onWall('right', z, () => k.box(0, 2.2, 0.02, 4.4, 3.0, 0.04, col));
  const brass = sheen(k, 0xc8a050, 0x2a1a04);

  // the Foucault pendulum: a pit with rings, a brass rail, pins round the edge, the bob on a ten-metre wire
  const P = new Vector3(0, 0, -2), PIV = H - 0.4, L = PIV - 0.45;
  k.cyl(P.x, 0, P.z, 3.1, 0.012, 0x2a3240); k.cyl(P.x, 0, P.z, 2.75, 0.016, 0x3e4a5a); k.cyl(P.x, 0, P.z, 1.2, 0.02, 0x2a3240);
  const NR = 12, RR = 3.25;
  for (let i = 0; i < NR; i++) {
    const a0 = (i / NR) * TAU, a1 = ((i + 1) / NR) * TAU;
    k.cyl(P.x + RR * Math.cos(a0), 0, P.z + RR * Math.sin(a0), 0.03, 0.95, 0x8a8e96);
    bar(k, new Vector3(P.x + RR * Math.cos(a0), 0.98, P.z + RR * Math.sin(a0)), new Vector3(P.x + RR * Math.cos(a1), 0.98, P.z + RR * Math.sin(a1)), 0.05, brass);
  }
  const pins = Array.from({ length: 24 }, (_, i) => {
    const phi = (i / 24) * TAU;
    return { g: k.group(P.x + 2.5 * Math.cos(phi), P.z + 2.5 * Math.sin(phi), -phi, () => k.cyl(0, 0, 0, 0.028, 0.26, 0xd03a2a)), a: ((phi % Math.PI) + Math.PI) % Math.PI };
  });
  let swing!: Group;
  const plane = lift(k.group(P.x, P.z, 0, () => {
    swing = k.group(0, 0, 0, () => {
      k.cyl(0, -L, 0, 0.007, L, 0x9a9ea6);
      k.ball(0, -L, 0, 0.17, 0.17, 0.17, brass);
      k.cone(0, -L - 0.15, 0, 0.045, 0.16, brass).rotation.x = Math.PI;
    });
  }), PIV);
  k.box(P.x, PIV - 0.05, P.z, 0.5, 0.3, 0.5, 0x5a606a);
  const T = TAU * Math.sqrt(L / 9.81), A = Math.asin(2.42 / L), TURN = 0.025, psi0 = r() * Math.PI;
  k.animate.push((t) => {
    // the swing's plane turns with the Earth (faster than the real one, to see it go); each pin falls as it passes
    const psi = psi0 + TURN * t, u = psi - psi0 - Math.floor((psi - psi0) / Math.PI) * Math.PI;
    plane.rotation.y = -psi;
    swing.rotation.z = A * Math.sin((TAU * t) / T);
    for (const p of pins) {
      const rel = (((p.a - psi0) % Math.PI) + Math.PI) % Math.PI, since = (u - rel) / TURN;
      p.g.rotation.z = since > 0 ? -Math.min(1.45, since * 5) : 0;
    }
  });

  // a DNA helix turning on its plinth
  const dna = k.group(0, 0, 0, () => {
    for (let j = 0; j < 14; j++) {
      const a = j * 0.55, y = 0.6 + j * 0.3, A1 = new Vector3(0.6 * Math.cos(a), y, 0.6 * Math.sin(a)), B1 = new Vector3(-A1.x, y, -A1.z);
      k.ball(A1.x, A1.y, A1.z, 0.11, 0.11, 0.11, 0xe74c3c); k.ball(B1.x, B1.y, B1.z, 0.11, 0.11, 0.11, 0x2e86de);
      bar(k, A1, B1, 0.045, pick(r, [0xf1c40f, 0x27ae60, 0x8e44ad, 0xe67e22]));
    }
  });
  dna.position.set(-6.5, 0.4, -9); k.cyl(-6.5, 0, -9, 0.9, 0.4, 0x2a2e36);
  // the plasma ball, its arcs wandering, one reaching for a child's hand
  const PB = new Vector3(3.6, 1.38, -9.2);
  k.box(PB.x, 0, PB.z, 0.7, 1.0, 0.7, 0x1a1c22); k.cyl(PB.x, 1.0, PB.z, 0.12, 0.1, 0x2a2a30);
  const arc = k.glow(0xd27aff, 1.6);
  const arcs = Array.from({ length: 6 }, () => ({ m: bar(k, PB, PB.clone().add(new Vector3(0.2, 0, 0)), 0.012, arc), a: 0.6 + r() * 1.4, b: 0.5 + r() * 1.2, c: 0.4 + r() * 1.3, ph: r() * 6 }));
  k.ball(PB.x, PB.y, PB.z, 0.045, 0.045, 0.045, k.glow(0xf0d8ff, 1.6));
  k.ball(PB.x, PB.y, PB.z, 0.28, 0.28, 0.28, clear(k, 0x6a3aaa, 0.28));
  const handAt = new Vector3(3.47, 1.05, -8.8), tip = new Vector3();
  // the giant bubble: a hoop drawn up out of the pool round the child standing in it
  const BU = new Vector3(-7.5, 0, -2.5);
  k.cyl(BU.x, 0, BU.z, 1.0, 0.22, 0x2e6ab0); k.cyl(BU.x, 0.22, BU.z, 0.9, 0.012, 0x9ad0f0);
  for (const s of [-1, 1]) k.box(BU.x + s * 1.25, 0, BU.z, 0.1, 3.1, 0.1, 0xf1c40f);
  k.box(BU.x, 3.1, BU.z, 2.6, 0.12, 0.12, 0xf1c40f);
  const hoop = custom(k, new TorusGeometry(0.88, 0.03, 6, 36), k.mat(0xe0e4ea));
  hoop.rotation.x = Math.PI / 2;
  const film = clear(k, 0xbfe8ff, 0.18), tube = k.cyl(BU.x, 0.23, BU.z, 0.86, 1, film);
  const ropes = [-1, 1].map((s) => ({ s, m: bar(k, new Vector3(BU.x + s * 0.88, 0.25, BU.z), new Vector3(BU.x + s * 0.3, 3.1, BU.z), 0.012, 0x3a3a3a) }));
  const ra = new Vector3(), rb = new Vector3();
  // consoles of buttons, a lever and a little screen, along the right
  const lamps: { m: MeshBasicMaterial; base: Color; f: number; ph: number }[] = [], levers: { g: Group; ph: number }[] = [];
  [-3.5, -6.0, -8.5].forEach((z, i) => {
    k.group(8.4, z, -Math.PI / 2, () => {
      k.box(0, 0, 0, 1.5, 0.85, 0.75, [0xe74c3c, 0xf1c40f, 0x16a085][i]);
      k.box(0, 0.85, -0.05, 1.5, 0.05, 0.7, 0x2a2e36).rotation.x = 0.3;
      k.box(0, 0.85, -0.36, 1.0, 0.75, 0.05, 0x1a1a1e);
      k.screen(0, 1.25, -0.33, 0.9, 0.5, seed + i * 7, 1.1, 'film', 0);
      for (let j = 0; j < 4; j++) {
        const m = k.glow(pick(r, [0xff4040, 0x40ff60, 0x4080ff, 0xffd040]), 1.4);
        k.cyl(-0.55 + j * 0.28, 0.84, 0.12, 0.06, 0.05, m);
        lamps.push({ m, base: m.color.clone(), f: 0.6 + r() * 1.6, ph: r() * 6 });
      }
      levers.push({ g: lift(k.group(0.6, 0.0, 0, () => { k.box(0, 0, 0, 0.04, 0.35, 0.04, 0x9a9ea6); k.ball(0, 0.38, 0, 0.06, 0.06, 0.06, 0xd03a2a); }), 0.92), ph: r() * 6 });
    });
  });
  // the planets going round the sun, hung from the roof
  const OR = new Vector3(4.5, 6.2, -9);
  k.cyl(OR.x, OR.y + 0.5, OR.z, 0.015, H - OR.y - 0.5, 0x5a5e66);
  k.ball(OR.x, OR.y, OR.z, 0.5, 0.5, 0.5, k.glow(0xffc040, 1.3));
  const orbits = ([[1.1, 0.09, 0x9a8a7a, 1.6], [1.6, 0.14, 0xe8c070, 1.1], [2.2, 0.15, 0x3a7ad8, 0.8], [2.8, 0.11, 0xc8502a, 0.6], [3.7, 0.33, 0xd8a870, 0.3], [4.6, 0.28, 0xe0d0a0, 0.22]] as [number, number, number, number][])
    .map(([rad, size, col, w], i) => {
      const g = lift(k.group(OR.x, OR.z, 0, () => {
        k.box(rad / 2, -0.01, 0, rad, 0.02, 0.02, 0x9a9ea6);
        k.ball(rad, 0, 0, size, size, size, col);
        if (i === 5) k.cyl(rad, -0.01, 0, size * 1.9, 0.02, 0xc8b88a).rotation.z = 0.3;
      }), OR.y);
      return { g, w: w * 0.35, a0: r() * TAU };
    });
  k.animate.push((t) => {
    for (const a of arcs.slice(1)) setBar(a.m, PB, tip.set(Math.sin(t * a.a + a.ph), 0.6 * Math.sin(t * a.b + a.ph * 2) + 0.2, Math.cos(t * a.c + a.ph * 3)).normalize().multiplyScalar(0.27).add(PB), 0.012);
    setBar(arcs[0].m, PB, tip.copy(handAt).sub(PB).normalize().multiplyScalar(0.27).add(PB), 0.014);
    k.tv.intensity = 1.4 + 0.5 * Math.sin(t * 13) * Math.sin(t * 7.1);
    // the bubble: up in three seconds, held, popped, the hoop let down again
    const u = (t / 10 + 0.3) % 1, h = u < 0.3 ? smooth(0, 0.3, u) * 1.95 : u < 0.58 ? 1.95 : u < 0.8 ? 1.95 * (1 - smooth(0.58, 0.8, u)) : 0;
    hoop.position.set(BU.x, 0.25 + h, BU.z);
    tube.visible = u < 0.58 && h > 0.05; tube.scale.y = Math.max(0.01, h);
    film.color.setHSL((t * 0.08) % 1, 0.6, 0.78);
    for (const rp of ropes) setBar(rp.m, ra.set(BU.x + rp.s * 0.88, 0.25 + h, BU.z), rb.set(BU.x + rp.s * 0.3, 3.1, BU.z), 0.012);
    for (const l of lamps) l.m.color.copy(l.base).multiplyScalar(Math.sin(t * l.f + l.ph) > 0.2 ? 1 : 0.2);
    for (const l of levers) l.g.rotation.x = -0.5 + 0.5 * Math.max(0, Math.sin(t * 0.9 + l.ph));
    for (const o of orbits) o.g.rotation.y = o.a0 + o.w * t;
  });
  k.tv.color.set(0xb050ff); k.tv.position.set(PB.x, PB.y + 0.2, PB.z + 0.5); k.tv.distance = 5;

  // the explainer in a lab coat across the pit, children at the rail; children running between the exhibits
  const kid = (slot: number) => (late ? visitor(c, slot, crowdStage(r, 0, 0.15)) : bare(visitor(c, slot, crowdStage(r, 0.75, 0.05))));
  const ex = [P.x + 3.55 * Math.cos(-1.32), P.z + 3.55 * Math.sin(-1.32)];
  k.stand(dress(staff(c, 0), 0xf4f4f2, 0x2a3442, BIT.coat | BIT.lanyard), ex[0], ex[1], yawTo(ex[0], ex[1], P.x, P.z), -0.45, 0);
  [-1.75, -2.05, -0.95, -0.7].forEach((a, i) => {
    const x = P.x + 3.5 * Math.cos(a), z = P.z + 3.5 * Math.sin(a);
    k.stand(kid(10 + i), x, z, yawTo(x, z, P.x, P.z) + (r() - 0.5) * 0.4, i % 2 ? 1 : 0, 1 + i);
  });
  const routes: [number, number, number, number][] = [[-9.5, -11.5, 9.5, -11.8], [-4.0, 3.5, -4.2, -11], [4.2, 3.0, 5.8, -11], [-9.5, -6.0, -1.5, -7.0], [1.0, -6.6, 7.0, -6.2]];
  routes.forEach(([ax, az, bx, bz], i) => lineWalker(k, kid(20 + i), ax, az, bx, bz, late ? 0.8 + r() * 0.4 : 1.9 + r() * 0.7, r()));
  lineWalker(k, visitor(c, 30, crowdStage(r, 0, 0.3)), -10.5, 4, -10.5, -10, 0.8, r());
  lineWalker(k, visitor(c, 31, crowdStage(r, 0, 0.3)), 9.5, 4, 6.0, -1.5, 0.7, r());
  [-3.5, -8.5].forEach((z, i) => k.stand(kid(40 + i), 7.55, z, 0, -0.7, 8 + i));
  k.stand(kid(42), -5.3, -8.4, yawTo(-5.3, -8.4, -6.5, -9) + 0.2, 1, 10);
  k.stand(visitor(c, 43, LifeStage.Adult), -5.0, -9.6, yawTo(-5.0, -9.6, -6.5, -9), 0, 11);
  k.stand(bare(visitor(c, 44, LifeStage.Child)), 3.6, -8.55, Math.PI / 2, 1, 12);
  k.stand(bare(visitor(c, 45, LifeStage.Child)), BU.x, BU.z, 0.2, 0, 13, 0.22);
  k.stand(visitor(c, 46, LifeStage.Adult), BU.x + 1.9, BU.z + 1.0, yawTo(BU.x + 1.9, BU.z + 1.0, BU.x, BU.z), 1, 14);
  // your family at the rail beside you
  const me = Math.atan2(1.6 - P.z, 0.4 - P.x);
  companions(c, 3).forEach((m, i) => {
    const a = me + (i === 1 ? 0.24 : -0.22 - i * 0.12), x = P.x + 3.55 * Math.cos(a), z = P.z + 3.55 * Math.sin(a);
    k.stand(m.child ? bare(m.look) : m.look, x, z, yawTo(x, z, P.x, P.z), 0, i);
  });
  k.ceilOn = 1; k.ceil.userData.max = 110; k.daylight = 0.5; k.ambientNight = 0.3;
  return {
    eye: new Vector3(0.4, eyeStanding(c), 1.6), aim: new Vector3(0, 1.0, -3.5),
    glances: [new Vector3(0, 0.5, -2), new Vector3(0, 7, -2), new Vector3(-6.5, 2.6, -9), PB.clone(), new Vector3(8.4, 1.2, -6), new Vector3(BU.x, 1.4, BU.z), OR.clone()],
    label: late ? 'at the science centre late' : 'at the science centre, watching the pendulum',
  };
};

// ---- the observatory --------------------------------------------------------------------------------

/**
 * The inside of a dome of radius R on a wall `yc` high, with its slit (|x| < hw) open from the horizon at -z to `vEnd` past
 * the zenith: strips across x, each an arc over the top, v from the -z horizon (0) to the +z horizon (pi).
 */
function domeShell(R: number, yc: number, hw: number, vEnd: number) {
  const pos: number[] = [], idx: number[] = [];
  const patch = (x0: number, x1: number, v0: number, v1: number, nx: number, nv: number) => {
    const base = pos.length / 3, a0 = Math.asin(x0 / R), a1 = Math.asin(x1 / R);
    for (let i = 0; i <= nx; i++) {
      const x = R * Math.sin(a0 + ((a1 - a0) * i) / nx), rho = Math.sqrt(Math.max(0, R * R - x * x));
      for (let j = 0; j <= nv; j++) { const v = v0 + ((v1 - v0) * j) / nv; pos.push(x, yc + rho * Math.sin(v), -rho * Math.cos(v)); }
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < nv; j++) { const a = base + i * (nv + 1) + j, b = a + nv + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  };
  patch(-R, -hw, 0, Math.PI, 10, 24); patch(hw, R, 0, Math.PI, 10, 24); patch(-hw, hw, vEnd, Math.PI, 3, 8);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** inside the dome at night: the slit open on the stars, the big telescope tracking slowly, red light only, a queue for the eyepiece */
const observatory: RoomBuilder = (k, c) => {
  const seed = seedOf(c), r = rng(seed ^ 0x0b5), night = isEvent(c, 'observatory');
  outdoors(k, c, { city: 0.5, ground: 0x3a4a3a });
  k.daylight = 0.12; k.ambientNight = 0.03; k.moonlight = 0.05;
  const R = 4.6, HW = 2.5, HWS = 0.62, VEND = Math.PI / 2 + 0.3;
  k.cyl(0, -0.05, 0, R + 0.1, 0.06, 0x24262a);
  const wallMat = k.mat(0x8e9096); wallMat.side = DoubleSide;
  custom(k, new CylinderGeometry(R, R, HW, 40, 1, true).translate(0, HW / 2, 0), wallMat);
  const domeMat = k.mat(0x9a9ca3); domeMat.side = DoubleSide;
  custom(k, domeShell(R, HW, HWS, VEND), domeMat);
  // the ribs: arches either side of the slit and across the dome, the ring it turns on, the shutter's edge
  const steel = k.mat(0x4a4c52);
  for (const x of [-3.6, -2.3, -(HWS + 0.06), HWS + 0.06, 2.3, 3.6]) {
    const big = Math.abs(x) < 1, rr = R - (big ? 0.1 : 0.07), rho = Math.sqrt(rr * rr - x * x), n = 10;
    for (let j = 0; j < n; j++) {
      const v0 = (j / n) * Math.PI, v1 = ((j + 1) / n) * Math.PI;
      bar(k, new Vector3(x, HW + rho * Math.sin(v0), -rho * Math.cos(v0)), new Vector3(x, HW + rho * Math.sin(v1), -rho * Math.cos(v1)), big ? 0.16 : 0.1, steel);
    }
  }
  for (let i = 0; i < 20; i++) {
    const a0 = (i / 20) * TAU, a1 = ((i + 1) / 20) * TAU, rr = R - 0.09;
    bar(k, new Vector3(rr * Math.cos(a0), HW, rr * Math.sin(a0)), new Vector3(rr * Math.cos(a1), HW, rr * Math.sin(a1)), 0.18, steel);
  }
  const re = Math.sqrt(R * R - HWS * HWS) - 0.1;
  bar(k, new Vector3(-HWS - 0.1, HW + re * Math.sin(VEND), -re * Math.cos(VEND)), new Vector3(HWS + 0.1, HW + re * Math.sin(VEND), -re * Math.cos(VEND)), 0.16, steel);
  // red lights round the floor's edge
  const red = k.glow(0xff2010, 1.1);
  for (let i = 0; i < 16; i++) {
    const a0 = (i / 16) * TAU + 0.05, a1 = ((i + 1) / 16) * TAU - 0.05, rr = R - 0.08;
    bar(k, new Vector3(rr * Math.cos(a0), 0.05, rr * Math.sin(a0)), new Vector3(rr * Math.cos(a1), 0.05, rr * Math.sin(a1)), 0.035, red);
  }
  // the telescope on its pier, the tube pointing up through the slit, tracking its star
  const TP = new Vector3(0, 2.2, -0.5);
  k.cyl(TP.x, 0, TP.z, 0.3, 1.55, 0x2a2c32); k.cyl(TP.x, 0, TP.z, 0.5, 0.12, 0x2a2c32);
  let alt!: Group;
  const az = k.group(TP.x, TP.z, 0, () => {
    k.box(0, 1.55, 0, 0.55, 0.3, 0.45, 0x3a3c44);
    for (const s of [-1, 1]) k.box(s * 0.36, 1.6, 0, 0.1, 0.65, 0.3, 0x3a3c44);
    k.box(0.2, 1.62, 0.23, 0.05, 0.05, 0.01, red);
    alt = lift(k.group(0, 0, 0, () => {
      k.cyl(0, -1.3, 0, 0.26, 3.2, 0xe4e4e8);
      k.cyl(0, 1.9, 0, 0.29, 0.55, 0x1a1a1e);
      k.cyl(0, -1.45, 0, 0.12, 0.18, 0x2a2a2e);
      k.cyl(0.22, -1.2, 0, 0.045, 0.22, 0x1a1a1e).rotation.z = -Math.PI / 2;
      k.cyl(0.36, 0.2, 0, 0.06, 0.8, 0x2a2a2e);
      k.box(0.3, 0.3, 0, 0.12, 0.05, 0.05, 0x2a2a2e); k.box(0.3, 0.75, 0, 0.12, 0.05, 0.05, 0x2a2a2e);
      k.box(-0.3, -0.25, 0, 0.1, 0.5, 0.2, 0x3a3c44);
    }), TP.y);
  });
  const E0 = 1.0;
  // what it is looking at, and other bright stars in the slit (they show once it is dark)
  const aimDir = new Vector3(0, Math.sin(E0), -Math.cos(E0));
  const planet = aimDir.clone().multiplyScalar(62).add(TP);
  k.ball(planet.x, planet.y, planet.z, 0.45, 0.45, 0.45, k.glow(0xffe8c0, 1.4, 'night'));
  const starMat = k.glow(0xf0f4ff, 1.3, 'night');
  for (let i = 0; i < 14; i++) {
    const v = 0.25 + r() * 1.5, d = new Vector3((r() - 0.5) * 0.16, Math.sin(v), -Math.cos(v)).normalize().multiplyScalar(58), s = 0.1 + r() * 0.14;
    k.ball(d.x, d.y + HW, d.z, s, s, s, starMat);
  }
  // the console against the wall, lit red; a step stool at the eyepiece; a ladder
  const cg = [-3.0, 1.8] as const, cry = along(-cg[0], -cg[1]);
  k.group(cg[0], cg[1], cry, () => {
    k.box(0, 0, 0, 1.6, 0.76, 0.6, 0x3a3c42);
    k.box(-0.2, 0.76, -0.18, 0.62, 0.42, 0.04, 0x1a1a1e);
    k.box(-0.2, 0.8, -0.155, 0.56, 0.34, 0.01, k.glow(0x6a0c06, 1.0));
    k.box(-0.2, 0.76, 0.08, 0.45, 0.02, 0.16, 0x2a2a2a);
    for (let i = 0; i < 4; i++) k.box(0.35 + i * 0.08, 0.76, 0.12, 0.04, 0.015, 0.04, k.glow(i % 2 ? 0xff2a10 : 0xff6a20, 1.2));
    k.cyl(0.6, 0.76, -0.15, 0.06, 0.02, 0x2a2a2a); k.cyl(0.6, 0.78, -0.15, 0.01, 0.35, 0x2a2a2a);
    k.cyl(0.6, 1.08, -0.1, 0.07, 0.08, k.glow(0xff2a14, 1.4));
  });
  const [lx, lz] = world(cg[0], cg[1], cry, 0.6, -0.05);
  k.lamp.position.set(lx, 1.2, lz); k.lamp.color.set(0xff2a14); k.lamp.userData.max = 3.5; k.lamp.distance = 8; k.lampOn = 1;
  k.box(0.75, 0, 0.2, 0.45, 0.2, 0.4, 0x3a3c42);
  k.group(3.6, -2.6, along(-3.6, 2.6), () => {
    for (const s of [-1, 1]) k.box(s * 0.22, 0, -0.1, 0.05, 2.6, 0.05, 0x5a5c62);
    for (let i = 0; i < 6; i++) k.box(0, 0.3 + i * 0.4, -0.1, 0.44, 0.04, 0.04, 0x5a5c62);
  });
  k.ceilOn = 1; k.ceil.userData.max = 4.5; k.ceil.color.set(0xff3018); k.ceil.position.set(0, 6.0, 0.6);
  k.tv.color.set(0xff2a14); k.tv.intensity = 1.3; k.tv.position.set(0.9, 0.5, 0.9); k.tv.distance = 6;
  k.animate.push((t) => {
    const e = E0 + 0.05 * Math.sin(t * 0.013) + 0.01 * Math.sin(t * 0.07);
    alt.rotation.x = -(Math.PI / 2 - e);
    az.rotation.y = 0.05 * Math.sin(t * 0.01 + 1) + 0.008 * Math.sin(t * 0.09);
  });
  // the astronomer explaining, a child up at the eyepiece with a parent, others waiting their turn
  const fleece = (look: Look, col: number) => dress(look, col, look.a[3], 0, CARRY);
  const ast = fleece(staff(c, 0), 0x2a3a5a);
  k.stand(ast, -2.1, 0.9, yawTo(-2.1, 0.9, 1.0, 2.6), -0.45, 0);
  k.stand(bare(visitor(c, 10, LifeStage.Child)), 0.75, 0.2, Math.PI, 0, 1, 0.2);
  k.stand(visitor(c, 11, LifeStage.Adult), 1.3, 0.75, yawTo(1.3, 0.75, 0.75, 0.2), 0, 2);
  k.stand(visitor(c, 12, crowdStage(r, 0.2, 0.3)), 2.1, 1.6, yawTo(2.1, 1.6, 0, -0.5), 0, 3);
  k.stand(visitor(c, 13, crowdStage(r, 0.2, 0.3)), 2.65, 2.25, yawTo(2.65, 2.25, 0, -0.5), 0, 4);
  k.stand(visitor(c, 14, LifeStage.Retired), -1.1, 3.4, Math.PI / 2 + 0.2, 0, 5);
  k.stand(visitor(c, 15, LifeStage.Retired), -0.5, 3.6, Math.PI / 2 - 0.1, 0, 6);
  companions(c, 3).forEach((m, i) => k.stand(m.look, 1.8 + i * 0.55, 3.15 - i * 0.35, yawTo(1.8, 3.1, 0, -0.5), 0, i));
  return {
    eye: new Vector3(1.2, eyeStanding(c), 2.8), aim: new Vector3(0, 3.8, -2.6),
    glances: [new Vector3(0.3, 1.2, 0.2), new Vector3(-3.0, 1.0, 1.8), new Vector3(-2.1, 1.5, 0.9), new Vector3(0, 6.4, -1), new Vector3(2.2, 1.4, 1.9)],
    label: night ? 'stargazing at the observatory' : 'at the observatory, waiting a turn at the telescope',
  };
};

// ---- the art gallery --------------------------------------------------------------------------------

/** a framed painting facing +z in the current frame, its middle at height y: one of a few kinds of picture */
function artwork(k: Kit, r: Rng, w: number, h: number, y: number, kind = Math.floor(r() * 6)) {
  const fw = 0.07, y0 = y - h / 2, z = 0.056;
  k.box(0, y0 - fw, 0.025, w + 2 * fw, h + 2 * fw, 0.05, pick(r, [0xc8a040, 0xb8902a, 0x1a1a1a, 0xf4f4f0, 0x8a6a3a]));
  // a block on the canvas: x is its middle across (-0.5..0.5), b its foot up (0..1), both as fractions of the canvas
  const at = (x: number, b: number, ww: number, hh: number, col: number, zz = z) => k.box(x * w, y0 + b * h, zz, ww * w, hh * h, 0.012, col);
  const disc = (x: number, b: number, rx: number, ry: number, col: number, zz = z + 0.008) => k.ball(x * w, y0 + b * h, zz, rx * w, ry * h, 0.004, col);
  if (kind === 0) { // fields of colour
    at(0, 0, 1, 1, pick(r, [0x8a2a2a, 0x2a3a6a, 0xc86a2a, 0x3a5a3a]), 0.05);
    at(0, 0.08, 0.84, 0.38, pick(r, [0xe8a040, 0xd85a3a, 0x6a2a4a, 0x2a2a2a]));
    at(0, 0.54, 0.84, 0.38, pick(r, [0xf0d8a0, 0xa83a3a, 0x3a6a8a, 0xd8b84a]));
  } else if (kind === 1) { // lines and primaries
    at(0, 0, 1, 1, 0xf2f0e8, 0.05);
    at(-0.24, 0.53, 0.52, 0.47, 0xc8302a); at(0.33, 0, 0.34, 0.3, 0x2a4aa8); at(0.4, 0.68, 0.2, 0.32, 0xf0c830);
    at(0.03, 0, 0.025, 1, 0x141414, z + 0.004); at(0, 0.5, 1, 0.025, 0x141414, z + 0.004); at(0.3, 0.5, 0.02, 0.5, 0x141414, z + 0.004);
  } else if (kind === 2) { // a landscape: sky, hills, the sun, a tree
    at(0, 0, 1, 1, pick(r, [0x8ab8e0, 0xe8b07a, 0xa8c8e8]), 0.05);
    at(0, 0, 1, 0.42, pick(r, [0x5a8a3a, 0x7a9a4a, 0x4a7a3a]));
    disc(-0.18, 0.42, 0.42, 0.16, pick(r, [0x3a6a2a, 0x6a8a3a]));
    disc(0.3, 0.78, 0.07, 0.1, 0xf8e070);
    at(0.28, 0.25, 0.025, 0.2, 0x4a3422); disc(0.28, 0.5, 0.09, 0.12, 0x2f5a2a);
  } else if (kind === 3) { // a portrait
    at(0, 0, 1, 1, pick(r, [0x2a2a22, 0x3a2a2a, 0x2a3a3a]), 0.05);
    disc(0, 0.1, 0.36, 0.22, pick(r, [0x2a3a6a, 0x6a2a2a, 0x1a1a1a]));
    disc(0, 0.56, 0.17, 0.2, pick(r, [0xe8c0a0, 0xd8a880, 0xa87050]), z + 0.012);
    disc(0, 0.68, 0.19, 0.14, pick(r, [0x2a1a10, 0x6a4a2a, 0xa88a50]));
  } else if (kind === 4) { // the sea and a boat
    at(0, 0, 1, 1, pick(r, [0xc8d8e8, 0xf0c8a0]), 0.05);
    at(0, 0, 1, 0.45, pick(r, [0x2a5a8a, 0x3a6a7a]));
    at(-0.1, 0.42, 0.22, 0.05, 0x5a3a2a, z + 0.004);
    k.box(-0.1 * w, y0 + 0.47 * h, z + 0.004, 0.012 * w, 0.3 * h, 0.012, 0xf4f0e8).rotation.z = -0.12;
    disc(0.32, 0.8, 0.06, 0.08, 0xf8f0d0);
  } else { // spots of colour
    at(0, 0, 1, 1, pick(r, [0xf4f0e8, 0xe8e0d0]), 0.05);
    for (let i = 0; i < 7; i++) disc((i % 4 - 1.5) * 0.24 + (r() - 0.5) * 0.05, 0.25 + Math.floor(i / 4) * 0.45 + (r() - 0.5) * 0.08, 0.07, 0.08, pick(r, BRIGHT));
  }
}

interface Stop { x: number; z: number; yaw: number; dwell: number }
/** a visitor going from picture to picture, standing a while before each, turning as they set off and arrive */
function stroller(k: Kit, look: Look, stops: Stop[], speed: number, ph: number) {
  const legs: { t0: number; walk: number; a: Stop; b: Stop; head: number }[] = [];
  let T = 0;
  stops.forEach((a, i) => {
    const b = stops[(i + 1) % stops.length], walk = Math.max(0.05, Math.hypot(b.x - a.x, b.z - a.z) / speed);
    legs.push({ t0: T, walk, a, b, head: Math.atan2(-(b.z - a.z), b.x - a.x) });
    T += walk + b.dwell;
  });
  const body: Body = { look, x: stops[0].x, y: 0, z: stops[0].z, yaw: stops[0].yaw, swing: 0, pose: 0, ph: ph * 10,
    move: (t, b) => {
      const u = (((t + ph * T) % T) + T) % T;
      const l = legs.find((g) => u < g.t0 + g.walk + g.b.dwell) ?? legs[legs.length - 1];
      const s = u - l.t0;
      if (s < l.walk) {
        const f = s / l.walk;
        b.x = l.a.x + (l.b.x - l.a.x) * f; b.z = l.a.z + (l.b.z - l.a.z) * f; b.swing = Math.min(0.6, speed * 0.45);
        const turnIn = Math.min(1, s / 0.7), turnOut = Math.min(1, (l.walk - s) / 0.7);
        const y0 = l.a.yaw + wrap(l.head - l.a.yaw) * turnIn;
        b.yaw = l.b.dwell > 0 ? l.b.yaw + wrap(y0 - l.b.yaw) * turnOut : y0;
      } else { b.x = l.b.x; b.z = l.b.z; b.yaw = l.b.dwell > 0 ? l.b.yaw : l.head; b.swing = 0; }
    } };
  k.bodies.push(body);
  return body;
}

/** on the bench in the middle of a white room: paintings round the walls, a bronze on its plinth, the next room through the arch */
const gallery: RoomBuilder = (k, c) => {
  const seed = seedOf(c), r = rng(seed ^ 0x9a1), opening = isEvent(c, 'gallery');
  const W = 14, D = 11, H = 4.6, wall = 0xf4f2ec, floor = pick(r, [0xc8a878, 0xb89868, 0x9a8a7a]), ceil = 0xf8f8f6;
  k.W = W; k.D = D; k.H = H;
  k.box(0, -0.1, -3, W + 0.4, 0.1, D + 8, floor);
  k.box(0, H, 0, W + 0.4, 0.1, D + 0.4, ceil);
  k.box(-W / 2 - 0.05, 0, 0, 0.1, H, D + 0.2, wall); k.box(W / 2 + 0.05, 0, 0, 0.1, H, D + 0.2, wall); k.box(0, 0, D / 2 + 0.05, W + 0.2, H, 0.1, wall);
  // the back wall, with a wide arch through to the next room
  const dx0 = 2.6, dx1 = 5.2, dh = 3.1, zb = -D / 2 - 0.05;
  k.box((-W / 2 + dx0) / 2, 0, zb, dx0 + W / 2, H, 0.1, wall); k.box((dx1 + W / 2) / 2, 0, zb, W / 2 - dx1, H, 0.1, wall);
  k.box((dx0 + dx1) / 2, dh, zb, dx1 - dx0, H - dh, 0.1, wall);
  k.box(4, 0, -12.55, 10.2, H, 0.1, wall); k.box(-1.05, 0, -9, 0.1, H, 7, wall); k.box(9.05, 0, -9, 0.1, H, 7, wall); k.box(4, H, -9, 10.2, 0.1, 7.2, ceil);
  // skylights (bright by day) and spotlights on tracks
  const sky = k.glow(0xeef4ff, 1.15), skyBase = sky.color.clone();
  for (const z of [-2.4, 2.0]) { k.box(-0.4, H - 0.03, z, 9, 0.03, 1.5, sky); k.box(-0.4, H - 0.32, z - 0.78, 9.3, 0.3, 0.06, 0xeeeeea); k.box(-0.4, H - 0.32, z + 0.78, 9.3, 0.3, 0.06, 0xeeeeea); }
  for (const z of [-3.8, 3.6]) {
    k.box(0, H - 0.08, z, 12, 0.05, 0.06, 0x2a2a2a);
    for (let i = 0; i < 6; i++) k.cyl(-5.5 + i * 2.2, H - 0.3, z, 0.06, 0.22, 0x2a2a2a);
  }
  // the paintings, and where a visitor stands to look at each: [wall, along it, height, width, height of canvas]
  const hung: ['back' | 'left' | 'right' | 'front', number, number, number, number][] = [
    ['back', -1.6, 2.1, 3.2, 2.0], ['back', -5.3, 1.9, 1.1, 1.4], ['left', -3.4, 1.85, 1.3, 1.0], ['left', -0.3, 1.9, 1.8, 1.3], ['left', 2.5, 1.85, 1.0, 1.2],
    ['right', -2.8, 1.9, 2.0, 1.4], ['right', 1.0, 1.9, 1.2, 1.6], ['right', 4.0, 1.8, 0.9, 1.1], ['front', -3.0, 1.9, 1.6, 1.1], ['front', 3.2, 1.9, 1.3, 1.3],
  ];
  const stops: Stop[] = [];
  hung.forEach(([side, u, y, w, h], i) => {
    k.onWall(side, u, () => { artwork(k, r, w, h, y, i === 0 ? pick(r, [0, 1, 2, 5]) : undefined); k.box(w / 2 + 0.3, 1.45, 0.01, 0.12, 0.09, 0.01, 0xf8f8f4); });
    const d = 1.6 + r() * 0.6;
    stops.push(side === 'back' ? { x: u, z: -D / 2 + d, yaw: Math.PI / 2, dwell: 6 + r() * 8 } : side === 'front' ? { x: u, z: D / 2 - d, yaw: -Math.PI / 2, dwell: 6 + r() * 8 }
      : side === 'left' ? { x: -W / 2 + d, z: u, yaw: Math.PI, dwell: 6 + r() * 8 } : { x: W / 2 - d, z: u, yaw: 0, dwell: 6 + r() * 8 });
  });
  k.group(6.8, -12.5, 0, () => artwork(k, r, 2.2, 1.6, 1.95));
  k.group(-0.98, -9.2, Math.PI / 2, () => artwork(k, r, 1.4, 1.1, 1.9));
  // the bronze on its plinth
  const bronze = sheen(k, 0x7a5a32, 0x1a1006), SX = 2.3, SZ = -1.8;
  k.box(SX, 0, SZ, 0.8, 1.0, 0.8, 0xf8f8f6);
  k.ball(SX, 1.22, SZ, 0.34, 0.22, 0.26, bronze); k.ball(SX + 0.08, 1.55, SZ + 0.05, 0.2, 0.32, 0.18, bronze);
  k.ball(SX - 0.05, 1.95, SZ, 0.14, 0.2, 0.13, bronze); k.cone(SX - 0.05, 2.08, SZ, 0.08, 0.45, bronze);
  const ring = custom(k, new TorusGeometry(0.2, 0.055, 8, 20), bronze);
  ring.position.set(SX - 0.2, 1.5, SZ); ring.rotation.y = Math.PI / 2;
  // the bench; the door and the attendant on a chair beside it
  k.box(0.3, 0, 1.9, 2.4, 0.38, 0.6, 0x2a2a2c); k.box(0.3, 0.38, 1.9, 2.3, 0.07, 0.56, 0x3a3434);
  k.onWall('left', 4.2, () => k.box(0, 0, 0.02, 1.3, 2.4, 0.04, 0x3a3a3c));
  chair(k, -6.4, 3.3, Math.PI / 2, 0x2a2a2c);
  k.sit(dress(staff(c, 0), 0x1e2230, 0x1e2230, BIT.lanyard, CARRY | BIT.coat), -6.38, 3.3, 0.46, 0, 0, 1);
  // visitors drifting from picture to picture: one round the left, one round the right and through the arch, others between
  const door = (dwell: number): Stop => ({ x: 3.9, z: -5.0, yaw: Math.PI / 2, dwell });
  const next: Stop = { x: 6.6, z: -10.4, yaw: Math.PI / 2, dwell: 12 };
  const sculpt: Stop = { x: SX + 1.0, z: SZ + 0.9, yaw: yawTo(SX + 1.0, SZ + 0.9, SX, SZ), dwell: 8 };
  const routes: Stop[][] = [
    [stops[2], stops[3], stops[1], stops[0]], [stops[6], stops[5], door(0), next, door(0), sculpt], [stops[0], stops[4], stops[3]],
    [stops[7], stops[6], sculpt, stops[5]], [stops[8], stops[2], stops[3]], [stops[9], stops[7], stops[6]],
  ];
  routes.forEach((route, i) => stroller(k, visitor(c, 10 + i, crowdStage(r, 0.1, 0.35)), route, 0.45 + r() * 0.2, r()));
  k.stand(visitor(c, 20, crowdStage(r, 0, 0.4)), 7.5, -10.8, Math.PI / 2 + 0.3, 0, 7);
  // at an opening: more people, glasses in hand, a table of drinks and someone pouring
  if (opening) {
    const glass = clear(k, 0xf0e8b0, 0.7);
    k.box(6.0, 0, -4.4, 0.6, 0.9, 1.8, 0xf4f4f0);
    for (let i = 0; i < 8; i++) k.cyl(5.85 + (i % 2) * 0.3, 0.9, -5.0 + Math.floor(i / 2) * 0.4, 0.03, 0.14, glass);
    k.stand(dress(staff(c, 1), 0x1a1a1a, 0x1a1a1a, BIT.shirtFront), 6.65, -4.4, Math.PI, 0, 9);
    for (let g = 0; g < 3; g++) {
      const gx = [-3.5, 4.5, -1.5][g], gz = [-1.2, -0.8, -3.4][g];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + g, x = gx + 0.6 * Math.cos(a), z = gz + 0.6 * Math.sin(a);
        k.stand(bare(visitor(c, 30 + g * 3 + i, crowdStage(r, 0, 0.3))), x, z, yawTo(x, z, gx, gz), i === 1 ? 0 : 1, 10 + g * 3 + i);
      }
    }
  }
  companions(c, 2).forEach((m, i) => k.sit(m.look, i ? -0.35 : 0.95, 1.92, 0.45, Math.PI / 2 + (i ? 0.15 : -0.15), 0, i));
  // daylight from the skylights; the gallery's own lights after dark
  k.daylight = 0.8; k.ambientNight = 0.22;
  k.ceilOn = 0.5; k.ceil.userData.max = 26; k.ceil.position.set(0, H - 0.5, -0.5);
  k.lampOn = 1; k.lamp.userData.max = 5; k.lamp.color.set(0xfff0d8); k.lamp.position.set(-1.6, 3.7, -3.6);
  k.animate.push(() => {
    const night = sceneUniforms.uNight.value;
    sky.color.copy(skyBase).multiplyScalar(0.08 + 0.92 * (1 - night));
    k.ceilOn = 0.5 + 0.5 * night;
  });
  return {
    eye: new Vector3(0.35, eyeSitting(c, 0.45), 1.95), aim: new Vector3(-1.4, 1.9, -D / 2),
    glances: [new Vector3(SX, 1.6, SZ), new Vector3(6.8, 1.8, -12.5), new Vector3(-W / 2, 1.8, -0.3), new Vector3(W / 2, 1.8, -2.8), new Vector3(-5.3, 1.8, -D / 2)],
    label: opening ? 'at an exhibition opening' : 'at the art gallery, sitting with a painting',
  };
};

// ---- the pottery class ------------------------------------------------------------------------------

/** a potter's wheel at (x, z), the potter's side toward local +z; returns the spinning wheel head (things on it go round) */
function potWheel(k: Kit, x: number, z: number, ry: number, body: number) {
  let head!: Group;
  k.group(x, z, ry, () => {
    k.box(0, 0, -0.08, 0.5, 0.36, 0.62, body);
    k.cyl(0, 0.36, 0, 0.34, 0.1, 0xd8d8d4);
    k.box(0, 0, 0.3, 0.1, 0.06, 0.22, 0x2a2a2a);
    head = lift(k.group(0, 0, 0, () => { k.cyl(0, 0, 0, 0.17, 0.035, 0x5a5a5e); k.box(0.11, 0.035, 0, 0.05, 0.004, 0.02, 0x8a6a4e); }), 0.46);
  });
  return head;
}
/** a pot on a wheel head: a belly, a neck and a rim, shaped by `shape` */
function potOn(k: Kit, head: Group, mat: Material) {
  let parts!: { belly: Mesh; neck: Mesh; rim: Mesh; lump: Mesh };
  inside(k, head, () => { parts = { belly: k.ball(0, 0, 0, 0.5, 0.5, 0.5, mat), neck: k.cyl(0, 0, 0, 0.5, 1, mat), rim: k.cyl(0, 0, 0, 0.5, 1, mat), lump: k.ball(0, 0, 0, 0.012, 0.012, 0.012, 0x6a4a36) }; });
  /** the pot at stage g (0 a lump just centred, 1 pulled up into a vase); returns its height and belly radius */
  return (g: number, wob = 0) => {
    const h = 0.07 + 0.19 * g, rb = 0.115 - 0.02 * g, by = 0.035 + h * 0.4;
    parts.belly.position.set(0, by, 0); parts.belly.scale.set(rb * 2, h * 0.85, rb * 2);
    const nh = Math.max(0.001, h * 0.45 * smooth(0.25, 0.8, g)), nr = rb * (0.62 + wob);
    parts.neck.position.set(0, by + h * 0.2, 0); parts.neck.scale.set(nr * 2, nh, nr * 2);
    parts.rim.position.set(0, by + h * 0.2 + nh - 0.006, 0); parts.rim.scale.set(nr * 2.3, 0.012, nr * 2.3); parts.rim.visible = nh > 0.02;
    parts.lump.position.set(rb * 0.97, by + h * 0.05, 0);
    return { top: by + h * 0.2 + nh, rb, by, h };
  };
}

/** at a potter's wheel by a big window: the clay spinning between your hands and rising into a pot, the tutor showing how */
const pottery: RoomBuilder = (k, c) => {
  const seed = seedOf(c), r = rng(seed ^ 0x907), open = isEvent(c, 'pottery');
  const W = 9, D = 8, H = 3.4;
  k.shell(W, D, H, 0xe8e0d0, 0x8a8478, 0xf0ece4);
  k.window('left', -0.6, 0.85, 4.2, 1.9, seed);
  for (let i = 0; i < 6; i++) k.box(-1 + (r() - 0.5) * 5, 0, -1 + (r() - 0.5) * 5, 0.3 + r() * 0.5, 0.004, 0.3 + r() * 0.4, 0x9a8c7c, r() * 3);
  const clayCol = pick(r, [0x9a6a4e, 0x8a7a6a, 0xa87a5a]), wet = sheen(k, clayCol, 0x140a04);
  const wheelCol = pick(r, [0x6a8aa0, 0x3a3e44, 0x8a9a7a]);
  // your wheel, your pot, your hands on it, a bowl of water and a sponge
  const myHead = potWheel(k, 0, -0.42, 0, wheelCol);
  k.cyl(0, 0, 0.05, 0.18, 0.5, 0x8a6a48);
  const myPot = potOn(k, myHead, wet);
  k.cyl(0.28, 0.46, -0.3, 0.075, 0.07, 0xd8d4cc); k.cyl(0.28, 0.47, -0.3, 0.065, 0.055, 0x5a6a78);
  k.box(-0.22, 0.46, -0.62, 0.08, 0.04, 0.06, 0xe6c84a); k.box(-0.27, 0.46, -0.32, 0.12, 0.006, 0.02, 0x9a9a9a, 0.6);
  const skin = c.viewer.a[0], sleeve = c.viewer.a[2];
  const hands = [-1, 1].map((s) => ({ s, hand: k.ball(0, 0, 0, 0.045, 0.035, 0.065, skin), arm: bar(k, new Vector3(0, 0, 0), new Vector3(0, 1, 0), 0.07, sleeve) }));
  const HW0 = new Vector3(0, 0.46, -0.42), hp = new Vector3(), elbow = new Vector3();
  // the tutor's wheel facing the class, theirs a finished vase; other learners at theirs
  const tHead = potWheel(k, -0.7, -1.85, Math.PI, wheelCol), tPot = potOn(k, tHead, wet);
  k.cyl(-0.7, 0, -2.32, 0.18, 0.5, 0x8a6a48);
  k.sit(dress(staff(c, 0), 0x5a4232, 0x2a2a2e), -0.7, -2.3, 0.5, -Math.PI / 2, -0.35, 0);
  const heads = [tHead, myHead];
  const mates = companions(c, 2);
  const apron = () => pick(r, [0x3a5a7a, 0xb8a882, 0x2a2a2e, 0x6a8a5a, 0x8a4a3a]);
  const others: [number, number][] = [[1.4, -0.32], [-1.45, -0.25], [2.0, -1.9]];
  const pots = others.map(([x, z], i) => {
    const h = potWheel(k, x, z, 0, wheelCol);
    k.cyl(x, 0, z + 0.47, 0.18, 0.5, 0x8a6a48);
    const m = i < 2 ? mates[i] : undefined, look = m ? m.look : visitor(c, 10 + i, crowdStage(r, 0.1, 0.35));
    k.sit(dress(look, apron(), look.a[3]), x, z + 0.45, 0.5, Math.PI / 2 + (i === 2 ? 0 : i ? -0.15 : 0.15), -0.3, 2 + i);
    heads.push(h);
    return { f: potOn(k, h, wet), ph: r() * 40 };
  });
  // shelves of pots drying (grey) and fired and glazed (higher up); the kiln, warm, in the corner
  for (const ux of [-2.4, 0.6]) {
    for (const s of [-1, 1]) k.box(ux + s * 0.98, 0, -D / 2 + 0.22, 0.04, 1.95, 0.36, 0x8a6a48);
    for (let i = 0; i < 4; i++) {
      const y = 0.3 + i * 0.45;
      k.box(ux, y, -D / 2 + 0.22, 2.0, 0.03, 0.36, 0x9a7a58);
      for (let j = 0; j < 6; j++) {
        if (r() < 0.2) continue;
        const px = ux - 0.82 + j * 0.33 + (r() - 0.5) * 0.06, pz = -D / 2 + 0.22 + (r() - 0.5) * 0.1;
        const col = i < 2 ? pick(r, [0x9a8a7a, 0xb0a090, 0xc8b8a8]) : pick(r, [0xe8dcd0, 0x3a6a8a, 0x6a8a5a, 0xc8a040, 0x8a3a2a, 0xf0ece4, 0x2a4a6a]), kind = r();
        if (kind < 0.4) k.cyl(px, y + 0.03, pz, 0.06 + r() * 0.04, 0.12 + r() * 0.12, col);
        else if (kind < 0.75) k.ball(px, y + 0.1, pz, 0.08, 0.07, 0.08, col);
        else k.cyl(px, y + 0.03, pz, 0.09, 0.05, col);
      }
    }
  }
  k.box(3.6, 0, -3.3, 1.0, 1.25, 0.95, 0x8e9296); k.box(3.6, 1.25, -3.3, 1.04, 0.08, 0.99, 0x6a6e72);
  k.box(3.6, 0.15, -2.81, 0.7, 0.9, 0.03, 0x7a7e82);
  const spy = k.glow(0xff7a2a, 1.4), spyBase = spy.color.clone();
  k.box(3.25, 0.95, -2.79, 0.14, 0.1, 0.03, spy);
  k.box(3.95, 0.9, -2.8, 0.2, 0.25, 0.05, 0x2a2a2e); k.box(3.95, 1.05, -2.77, 0.05, 0.04, 0.01, k.glow(0xff2a2a, 1.4));
  k.cyl(3.6, 1.33, -3.5, 0.08, H - 1.33, 0xa8acb0);
  // the wedging table with someone kneading clay; bags of clay; aprons on pegs
  k.box(3.75, 0, -0.6, 0.8, 0.9, 1.6, 0x8a7a68); k.box(3.7, 0.9, -0.5, 0.35, 0.22, 0.28, clayCol);
  k.stand(dress(visitor(c, 20, crowdStage(r, 0, 0.3)), apron(), 0x2a2a2e), 3.05, -0.55, 0, -1, 9);
  for (let i = 0; i < 3; i++) k.box(3.9, 0, 1.0 + i * 0.5, 0.45, 0.32, 0.4, 0x5a5e62, r() * 0.3);
  for (let i = 0; i < 4; i++) k.onWall('right', 2.4 + i * 0.5, () => k.box(0, 0.95, 0.04, 0.42, 0.72, 0.03, apron()));
  if (open) for (let i = 0; i < 3; i++) k.stand(visitor(c, 30 + i, crowdStage(r, 0.2, 0.3)), -2.2 + i * 0.7, -3.0, Math.PI / 2 + (r() - 0.5), 0, 10 + i);
  for (let i = 0; i < 3; i++) k.cyl(-W / 2 + 0.12, 0.77, -1.8 + i * 0.6, 0.07, 0.1 + r() * 0.08, pick(r, [0x3a6a8a, 0xe8dcd0, 0x8a3a2a]));
  plant(k, r, -W / 2 + 0.4, 2.4, true);
  strips(k, W, D, H, 2, 1, 0xfff6e8);
  // everything turning; your pot rising between your hands, pull after pull, then a fresh lump of clay
  k.animate.push((t) => {
    for (let i = 0; i < heads.length; i++) heads[i].rotation.y = t * (8.5 + i * 0.9);
    tPot(0.92, 0.05 * Math.sin(t * 0.3));
    for (const p of pots) p.f(smooth(0.1, 0.9, ((t + p.ph) / 50) % 1), 0.04 * Math.sin(t * 0.5 + p.ph));
    const s = ((t + 6) / 42) % 1, g = smooth(0.15, 0.85, s), pot = myPot(g, 0.06 * Math.sin(s * 9));
    const pulling = s > 0.15 && s < 0.88, stroke = (t % 4.5) / 4.5, up = stroke < 0.8 ? smooth(0, 0.8, stroke) : 1 - smooth(0.8, 1, stroke);
    const y = pulling ? 0.04 + (pot.top - 0.06) * up : pot.by + 0.01;
    const rr = pulling ? pot.rb * (1 - 0.35 * up) + 0.03 : pot.rb + 0.035;
    for (const h of hands) {
      hp.set(HW0.x + h.s * rr, HW0.y + y, HW0.z + 0.02);
      h.hand.position.copy(hp); h.hand.rotation.z = h.s * 0.4;
      setBar(h.arm, elbow.set(h.s * 0.24, 0.74, -0.04), hp.set(hp.x + h.s * 0.04, hp.y, hp.z + 0.05), 0.07);
    }
    spy.color.copy(spyBase).multiplyScalar(0.8 + 0.2 * Math.sin(t * 1.3) * Math.sin(t * 0.37));
  });
  k.daylight = 0.9; k.ceilOn = 0.6; k.ceil.userData.max = 8; k.ambientNight = 0.15;
  const eye = new Vector3(0, eyeSitting(c, 0.5), 0.05);
  return {
    eye, aim: new Vector3(0, eye.y - 0.67, -1.45),
    glances: [new Vector3(-0.7, 1.0, -2.3), new Vector3(-1, 1.2, -D / 2), new Vector3(3.6, 1.0, -3.3), new Vector3(-W / 2, 1.6, -0.6), new Vector3(1.4, 1.0, 0.15), new Vector3(0, 0.55, -0.42)],
    label: open ? 'at the open studio' : 'at a pottery class, throwing a pot',
  };
};

// ---- the concert hall -------------------------------------------------------------------------------

/** in the stalls: the orchestra in its curves round the conductor, bows moving together, the organ's gold pipes behind */
const concert: RoomBuilder = (k, c) => {
  const seed = seedOf(c), r = rng(seed ^ 0xc0c), gala = isEvent(c, 'concert');
  const W = 26, D = 34, H = 15, SY = 1.0, SF = -6, C = new Vector3(0, SY, -6.9);
  k.shell(W, D, H, 0x6a4228, 0x3a2418, 0x4a3020, -1);
  const gold = sheen(k, 0xd4a83a, 0x3a2806), copper = sheen(k, 0xb87333, 0x2a1408);
  // panelled walls, the stage, its risers, the canopy of reflectors over the orchestra
  for (const s of [-1, 1]) for (let i = 0; i < 9; i++) k.box(s * (W / 2 - 0.04), 0, -12 + i * 3.4, 0.08, 9, 1.6, i % 2 ? 0x7a4a2a : 0x8a5a36);
  k.box(0, 0, -11.5, 22, SY, 11, 0x8a5a32);
  k.box(0, SY - 0.03, SF + 0.02, 22, 0.05, 0.08, k.glow(0xffd8a0, 0.7));
  for (const [z0, h, w] of [[-11, 0.25, 16], [-13, 0.5, 18], [-14.8, 0.75, 20]]) k.box(0, SY, (z0 - 17) / 2, w, h, z0 + 17, 0x7a4e2c);
  for (let i = 0; i < 5; i++) k.cyl(-6 + i * 3, 9.5 + r() * 1.5, -11 + (r() - 0.5) * 3, 1.3, 0.06, 0xd8c8a8).rotation.x = (r() - 0.5) * 0.3;
  k.box(C.x, SY, C.z, 0.8, 0.22, 0.8, 0x5a1a1a);
  // the players, in concert black, facing the conductor
  const NOPE = CARRY | BIT.cap | BIT.coat | BIT.stick, black = 0x17171b;
  let mi = 0;
  const muso = () => dress(visitor(c, 200 + mi++, r() < 0.12 ? LifeStage.Retired : LifeStage.Adult), black, black, r() < 0.35 ? BIT.skirt : BIT.shirtFront, NOPE);
  const seated = (x: number, z: number, y: number, look: Look, pose = 0) => {
    const yaw = yawTo(x, z, C.x, C.z);
    k.box(x, y, z, 0.42, 0.46, 0.42, 0x1a1a1c);
    k.sit(look, x, z, y + 0.46, yaw, pose, mi);
    return yaw;
  };
  const bows: { m: Mesh; x: number; y: number; z: number; dx: number; dz: number; amp: number; rate: number; ph: number }[] = [];
  const SECTION = [[3.3, 0], [3.3, 0.7], [2.6, 1.5], [2.2, 2.2]];
  const bow = (x: number, y: number, z: number, dx: number, dz: number, len: number, sec: number) => {
    bows.push({ m: k.box(x, y, z, 0.012, 0.012, len, 0xd8c8a0, along(dx, dz)), x, y, z, dx, dz, amp: len * 0.3, rate: SECTION[sec][0], ph: SECTION[sec][1] + (r() - 0.5) * 0.3 });
  };
  const violin = (x: number, z: number, y: number, viola: boolean, sec: number) => {
    const look = muso(), yaw = seated(x, z, y, look, 1), h = look.height;
    const [fx, fz] = fwd(yaw), lx = fz, lz = -fx, vy = y + 0.5 + 0.52 * h;
    const [dx, dz] = unit(fx * 0.7 + lx * 0.7, fz * 0.7 + lz * 0.7), [bx, bz] = unit(fx * 0.3 - lx * 0.95, fz * 0.3 - lz * 0.95);
    const vx = x + fx * 0.2 + lx * 0.12, vz = z + fz * 0.2 + lz * 0.12;
    k.box(vx, vy - 0.03, vz, 0.11, 0.045, viola ? 0.42 : 0.36, 0x9a4a22, along(dx, dz));
    bow(vx + bx * 0.05, vy + 0.03, vz + bz * 0.05, bx, bz, 0.62, sec);
  };
  const cello = (x: number, z: number, y: number, stand: boolean) => {
    const look = muso(), yaw = stand ? yawTo(x, z, C.x, C.z) : seated(x, z, y, look, 0);
    if (stand) k.stand(look, x, z, yaw, -0.3, mi, y);
    const [fx, fz] = fwd(yaw), lx = fz, lz = -fx, bodyH = stand ? 1.05 : 0.68, base = y + 0.1;
    const bx = x + fx * (stand ? 0.4 : 0.34) + lx * (stand ? 0.12 : 0), bz = z + fz * (stand ? 0.4 : 0.34) + lz * (stand ? 0.12 : 0);
    k.box(bx, base, bz, stand ? 0.52 : 0.38, bodyH, stand ? 0.24 : 0.18, 0x7a3a1a, yaw + Math.PI / 2);
    k.box(bx, base + bodyH, bz, 0.05, stand ? 0.7 : 0.45, 0.05, 0x2a1a10);
    bow(bx + fx * 0.13, base + bodyH * 0.38, bz + fz * 0.13, -lx, -lz, stand ? 0.7 : 0.66, 3);
  };
  const wind = (x: number, z: number, y: number, kind: 'flute' | 'reed' | 'bassoon') => {
    const look = muso(), yaw = seated(x, z, y, look, kind === 'flute' ? 1 : 0.6);
    const [fx, fz] = fwd(yaw), lx = fz, lz = -fx, mouth = y + 0.5 + 0.56 * look.height, m = new Vector3(x + fx * 0.14, mouth, z + fz * 0.14);
    if (kind === 'flute') bar(k, m, new Vector3(m.x - lx * 0.62 + fx * 0.05, mouth - 0.06, m.z - lz * 0.62 + fz * 0.05), 0.022, 0xd0d4d8);
    else if (kind === 'reed') bar(k, m, new Vector3(x + fx * 0.42, mouth - 0.45, z + fz * 0.42), 0.035, 0x1a1a1a);
    else bar(k, new Vector3(x + fx * 0.25 - lx * 0.12, y + 0.3, z + fz * 0.25 - lz * 0.12), new Vector3(x + fx * 0.15 + lx * 0.1, mouth + 0.45, z + fz * 0.15 + lz * 0.1), 0.06, 0x6a3a1a);
  };
  const slides: { m: Mesh; a: Vector3; f: Vector3; ph: number }[] = [];
  const brassP = (x: number, z: number, y: number, kind: 'horn' | 'trumpet' | 'trombone' | 'tuba') => {
    const look = muso(), yaw = seated(x, z, y, look, kind === 'horn' || kind === 'tuba' ? 0 : 0.8);
    const [fx, fz] = fwd(yaw), lx = fz, lz = -fx, sy = y + 0.5, mouth = sy + 0.56 * look.height, m = new Vector3(x + fx * 0.14, mouth, z + fz * 0.14);
    if (kind === 'trumpet') { const e = new Vector3(m.x + fx * 0.48, mouth - 0.08, m.z + fz * 0.48); bar(k, m, e, 0.035, gold); k.ball(e.x, e.y, e.z, 0.065, 0.065, 0.065, gold); }
    else if (kind === 'trombone') {
      k.ball(m.x + fx * 0.42 + lx * 0.1, mouth - 0.02, m.z + fz * 0.42 + lz * 0.1, 0.09, 0.09, 0.09, gold);
      slides.push({ m: bar(k, m, m.clone().add(new Vector3(fx, 0, fz)), 0.03, gold), a: m.clone().add(new Vector3(-lx * 0.05, -0.05, -lz * 0.05)), f: new Vector3(fx, -0.12, fz).normalize(), ph: r() * 6 });
    } else if (kind === 'horn') k.ball(x + fx * 0.15 - lx * 0.25, sy + 0.3, z + fz * 0.15 - lz * 0.25, 0.17, 0.17, 0.06, gold).rotation.y = along(-lx, -lz);
    else { k.cyl(x + fx * 0.22, sy - 0.05, z + fz * 0.22, 0.15, 0.7, gold); k.ball(x + fx * 0.22, sy + 0.68, z + fz * 0.22, 0.24, 0.08, 0.24, gold); }
  };
  const arc = (rad: number, deg: number) => [C.x + rad * Math.sin((deg * Math.PI) / 180), C.z - rad * Math.cos((deg * Math.PI) / 180)];
  [-75, -50, -25, 25, 50, 75].forEach((d) => { const [x, z] = arc(1.8, d); if (d < 0) violin(x, z, SY, false, 0); else cello(x, z, SY, false); });
  for (let i = 0; i < 9; i++) { const [x, z] = arc(3.1, -76 + 19 * i); if (i < 4) violin(x, z, SY, false, 1); else if (i < 7) violin(x, z, SY, true, 2); else cello(x, z, SY, false); }
  cello(5.0, -9.9, SY, true); cello(5.9, -9.3, SY, true);
  (['flute', 'flute', 'reed', 'reed', 'reed', 'bassoon'] as const).forEach((kind, i) => { const x = -2.5 + i; wind(x, -11.7 + 0.04 * x * x, SY + 0.25, kind); });
  (['horn', 'horn', 'horn', 'trumpet', 'trumpet', 'trombone', 'trombone', 'tuba'] as const).forEach((kind, i) => { const x = [-4.5, -3.5, -2.5, -1.0, 0, 1.2, 2.4, 3.6][i]; brassP(x, -13.6 + 0.03 * x * x, SY + 0.5, kind); });
  // timpani and the percussion at the back, the harp at the side
  const ty = SY + 0.75;
  for (let i = 0; i < 4; i++) {
    const x = -2.4 + i * 0.62, z = -15.2 + Math.abs(i - 1.5) * 0.12;
    k.cyl(x, ty, z, 0.05, 0.12, 0x2a2a2a); k.ball(x, ty + 0.32, z, 0.31, 0.3, 0.31, copper); k.cyl(x, ty + 0.6, z, 0.31, 0.03, 0xe8e0c8);
  }
  const timp = muso(); timp.pace = 0.006;
  k.stand(timp, -1.5, -15.85, yawTo(-1.5, -15.85, C.x, C.z), -1, mi++, ty);
  const perc = muso(); perc.pace = 0.005;
  k.stand(perc, 2.6, -15.85, yawTo(2.6, -15.85, C.x, C.z), -0.8, mi++, ty);
  k.cyl(2.85, ty + 0.5, -15.2, 0.42, 0.5, 0xe8e0d0).rotation.z = Math.PI / 2;
  for (const s of [-1, 1]) k.box(3.7 + s * 0.5, ty, -15.9, 0.05, 1.7, 0.05, 0x2a2a2a);
  k.ball(3.7, ty + 1.1, -15.88, 0.42, 0.42, 0.03, gold);
  {
    const hx = -5.6, hz = -9.0, look = muso(), yaw = seated(hx, hz, SY, look, 0.7), [fx, fz] = fwd(yaw), lx = fz, lz = -fx;
    const px = hx + fx * 0.45 + lx * 0.2, pz = hz + fz * 0.45 + lz * 0.2;
    k.cyl(px, SY, pz, 0.04, 1.75, gold);
    bar(k, new Vector3(px - fx * 0.05, SY + 0.12, pz - fz * 0.05), new Vector3(hx + fx * 0.1 + lx * 0.15, SY + 1.4, hz + fz * 0.1 + lz * 0.15), 0.1, 0xa8742a);
    bar(k, new Vector3(px, SY + 1.75, pz), new Vector3(hx + fx * 0.1 + lx * 0.15, SY + 1.5, hz + fz * 0.1 + lz * 0.15), 0.06, gold);
  }
  // the conductor on the podium, beating time
  const cond = dress(visitor(c, 199), 0x111114, 0x111114, BIT.shirtFront | BIT.tie, NOPE);
  cond.pace = 0.0042;
  k.bodies.push({ look: cond, x: C.x, y: SY + 0.22, z: C.z, yaw: Math.PI / 2, swing: 0, pose: -0.9, ph: 3,
    move: (t, b) => { b.yaw = Math.PI / 2 + 0.3 * Math.sin(t * 0.45) + 0.08 * Math.sin(t * 1.7); b.pose = -0.75 - 0.25 * Math.sin(t * 0.3); } });
  // the organ: its case, a tower of pipes in the middle, flats falling away, towers at the sides
  const OZ = -16.7;
  k.box(0, 5.0, OZ - 0.2, 13, 8.5, 0.6, 0x5a3a22);
  const pipe = (x: number, y: number, rad: number, len: number) => k.cyl(x, y, OZ + 0.2, rad, len, gold);
  for (let i = 0; i < 9; i++) { const u = (i - 4) / 4; pipe(u * 1.3, 5.6, 0.13, 5.5 - Math.abs(u) * 1.6); }
  for (const s of [-1, 1]) {
    for (let i = 0; i < 9; i++) pipe(s * (2.0 + i * 0.36), 6.0, 0.12, 3.6 - i * 0.18);
    for (let i = 0; i < 5; i++) pipe(s * (5.2 + i * 0.3), 5.4, 0.14, 5.2 - Math.abs(i - 2) * 0.6);
    k.box(s * 5.8, 10.8, OZ + 0.1, 1.8, 0.3, 0.7, 0x4a2a18);
  }
  k.box(0, 11.3, OZ + 0.1, 3.0, 0.3, 0.7, 0x4a2a18);
  // the stalls, raked: rows of red seats in three blocks
  const rowZ = (i: number) => -3.6 + i * 0.95, rowY = (i: number) => 0.22 * i;
  const blocks: [number, number][] = [[-11.2, -4.2], [-3.4, 3.4], [4.2, 11.2]];
  for (let i = 0; i < 10; i++) {
    const z = rowZ(i), y = rowY(i);
    if (i) k.box(0, 0, z + 0.1, W, y, 0.95, 0x3a2418);
    for (const [x0, x1] of blocks) { k.box((x0 + x1) / 2, y, z, x1 - x0, 0.45, 0.5, 0x8a1a22); k.box((x0 + x1) / 2, y, z + 0.27, x1 - x0, 0.95, 0.08, 0x7a1620); }
  }
  const MY_ROW = 6, MY_SEAT = 7, seatX = (j: number) => -3.1 + 0.62 * j;
  const mates = companions(c, 2);
  mates.forEach((m, i) => k.sit(m.look, seatX(MY_SEAT + (i ? -1 : 1)), rowZ(MY_ROW) + 0.02, rowY(MY_ROW) + 0.45, Math.PI / 2, 0, i));
  // the audience round you, nearest rows first, as many as there are figures left
  let left = 64 - k.bodies.length, n = 0;
  for (let row = MY_ROW; row >= 1 && left > 0; row--) for (let j = 0; j < 11 && left > 0; j++) {
    if (row === MY_ROW && Math.abs(j - MY_SEAT) <= mates.length) continue;
    if (r() > (row === MY_ROW ? 0.35 : 0.55)) continue;
    k.sit(visitor(c, 300 + n, crowdStage(r, 0.05, 0.45)), seatX(j), rowZ(row) + 0.02, rowY(row) + 0.45, Math.PI / 2 + (r() - 0.5) * 0.1, 0, n);
    n++; left--;
  }
  // further off in the side blocks and up on the balconies: heads and shoulders only
  const HAIR = [0x17120f, 0x3b2618, 0x8a5a34, 0xa8a8a8, 0xdedede, 0x2b1d14], COAT = [0x1d1d22, 0x26314f, 0x6b2335, 0x2a2a30, 0x3a3d44, 0xb8902a];
  for (let i = 0; i < 16; i++) {
    const s = i % 2 ? 1 : -1, row = Math.floor(r() * 7), x = s * (4.5 + Math.floor(r() * 5) * 0.62), y = rowY(row) + 0.45, z = rowZ(row) + 0.03;
    k.box(x, y, z, 0.42, 0.55, 0.24, pick(r, COAT)); k.ball(x, y + 0.68, z, 0.1, 0.12, 0.1, pick(r, HAIR));
  }
  for (const s of [-1, 1]) {
    const bx = s * (W / 2 - 0.8);
    k.box(bx, 5.0, 6, 1.6, 0.3, 16, 0x5a3420); k.box(s * (W / 2 - 1.6), 5.3, 6, 0.12, 0.95, 16, 0x8a5a36);
    k.box(s * (W / 2 - 1.62), 6.18, 6, 0.06, 0.08, 16.02, gold);
    for (let i = 0; i < 4; i++) k.ball(s * (W / 2 - 1.68), 5.85, -1 + i * 4.5, 0.08, 0.1, 0.08, k.glow(0xffd090, 1.3, 'lamp'));
    for (let i = 0; i < 6; i++) k.ball(s * (W / 2 - 0.9), 6.42, 0.5 + i * 2.2 + r() * 0.6, 0.1, 0.12, 0.1, pick(r, HAIR));
  }
  for (const [x, z] of [[-6, 4], [0, 6], [6, 4]]) { k.cyl(x, 11.2, z, 0.02, H - 11.2, 0x6a4a2a); k.ball(x, 11.0, z, 0.55, 0.45, 0.55, k.glow(0xffe0a0, 1.2, 'lamp')); }
  for (const s of [-1, 1]) k.box(s * (W / 2 - 0.1), 2.6, -4.5, 0.03, 0.18, 0.45, k.glow(0x20ff60, 1.5));
  // the music: bows moving together by section, trombone slides
  const a = new Vector3();
  k.animate.push((t) => {
    for (const b of bows) { const o = b.amp * Math.sin(t * b.rate + b.ph); b.m.position.set(b.x + b.dx * o, b.y, b.z + b.dz * o); }
    for (const s of slides) setBar(s.m, s.a, a.copy(s.a).addScaledVector(s.f, 0.62 + 0.24 * Math.sin(t * 1.3 + s.ph)), 0.03);
  });
  // warm light on the stage and the organ, the house lights low
  k.daylight = 0; k.ambientNight = 0.16; k.ceilOn = 1; k.lampOn = 1;
  k.ceil.position.set(0, 9, -10.5); k.ceil.color.set(0xffe0b8); k.ceil.userData.max = 120; k.ceil.distance = 0;
  k.lamp.position.set(0, 9, -13); k.lamp.color.set(0xffd090); k.lamp.userData.max = 30; k.lamp.distance = 0;
  k.tv.position.set(0, 8, 6); k.tv.color.set(0xffe8c8); k.tv.intensity = 10; k.tv.distance = 0;
  return {
    eye: new Vector3(seatX(MY_SEAT), rowY(MY_ROW) + eyeSitting(c, 0.45), rowZ(MY_ROW) + 0.03), aim: new Vector3(0, 2.2, -11.5),
    glances: [new Vector3(0, 8, -16.5), new Vector3(0, 2.2, -6.9), new Vector3(-5.6, 2, -9), new Vector3(0, 3, -15.5), new Vector3(W / 2 - 1, 6.2, 4)],
    label: gala ? 'at the concert' : 'listening to the orchestra at the concert hall',
  };
};

// ---- the dance hall ---------------------------------------------------------------------------------

/** at a table by the floor at a tea dance: couples turning round the sprung floor, the band on the stage, chandeliers, tea and cake */
const dancehall: RoomBuilder = (k, c) => {
  const seed = seedOf(c), r = rng(seed ^ 0xda7), tea = isEvent(c, 'dancehall');
  const W = 22, D = 17, H = 7;
  k.shell(W, D, H, 0xeadcc0, 0x7a5232, 0xf4ecd8);
  const gold = sheen(k, 0xd4a83a, 0x3a2806);
  // the sprung floor: boards, a dark border
  k.box(0, 0, -1, 14, 0.03, 10, 0xc8945a);
  for (let i = 1; i < 10; i++) k.box(-7 + i * 1.4, 0, -1, 0.02, 0.032, 10, 0xb0804a);
  for (const [x, z, w, d] of [[0, -6.05, 14.3, 0.15], [0, 4.05, 14.3, 0.15], [-7.075, -1, 0.15, 10.3], [7.075, -1, 0.15, 10.3]]) k.box(x, 0, z, w, 0.035, d, 0x6a3e22);
  // the stage and its curtains
  k.box(0, 0, -7.2, 9, 0.7, 2.6, 0x5a3220); k.box(0, 0.66, -5.88, 9, 0.05, 0.04, gold);
  k.box(0, 0.7, -8.4, 9, 5.0, 0.1, 0x8a1a2a);
  for (const s of [-1, 1]) k.box(s * 4.2, 0.7, -8.2, 1.0, 5.0, 0.3, 0x9a2232);
  k.box(0, 5.2, -8.1, 9.4, 0.7, 0.35, 0x9a2232); k.box(0, 5.15, -7.92, 9.4, 0.08, 0.02, gold);
  // the band: piano, double bass, a singer at the microphone, drums
  const SY = 0.7, NOPE = CARRY | BIT.cap | BIT.coat | BIT.stick;
  k.box(-3.2, SY, -7.4, 0.6, 1.25, 1.5, 0x1a1210); k.box(-2.8, SY + 0.7, -7.4, 0.22, 0.04, 1.3, 0xf4f4f0);
  k.cyl(-2.25, SY, -7.4, 0.2, 0.5, 0x2a1a12);
  const pianist = dress(visitor(c, 100), 0x1d1d22, 0x1d1d22, BIT.shirtFront | BIT.tie, NOPE); pianist.pace = 0.005;
  k.sit(pianist, -2.25, -7.4, SY + 0.5, Math.PI, -0.4, 1);
  const bassist = dress(visitor(c, 101), 0x1d1d22, 0x1d1d22, BIT.shirtFront, NOPE); bassist.pace = 0.005;
  k.stand(bassist, -0.7, -7.5, -Math.PI / 2, -0.4, 2, SY);
  k.box(-0.95, SY + 0.1, -7.1, 0.52, 1.05, 0.24, 0x7a3a1a, 0.2); k.box(-0.95, SY + 1.15, -7.1, 0.05, 0.7, 0.05, 0x2a1a10);
  const singer = dress(visitor(c, 102, LifeStage.Adult), pick(r, [0xb02050, 0x2a6a8a, 0xd8b048, 0x1a1a1a]), 0, BIT.skirt, NOPE);
  singer.a[3] = singer.a[2];
  k.bodies.push({ look: singer, x: 1.0, y: SY, z: -6.6, yaw: -Math.PI / 2, swing: 0, pose: 0.8, ph: 4,
    move: (t, b) => { b.yaw = -Math.PI / 2 + 0.22 * Math.sin(t * 0.55) + 0.06 * Math.sin(t * 1.9); } });
  k.cyl(1.0, SY, -6.2, 0.012, 1.45, 0x2a2a2a); k.ball(1.0, SY + 1.47, -6.2, 0.035, 0.05, 0.035, 0x3a3a3a);
  const drummer = dress(visitor(c, 103), 0x1d1d22, 0x1d1d22, BIT.shirtFront, NOPE); drummer.pace = 0.007;
  k.cyl(2.8, SY, -7.85, 0.18, 0.5, 0x2a1a12);
  k.sit(drummer, 2.8, -7.85, SY + 0.5, -Math.PI / 2, -0.7, 3);
  k.cyl(2.8 + 0.15, SY + 0.25, -7.25, 0.26, 0.3, 0xe8e0d0).rotation.x = Math.PI / 2;
  k.cyl(2.45, SY, -7.3, 0.015, 0.6, 0x9a9a9a); k.cyl(2.45, SY + 0.6, -7.3, 0.17, 0.12, 0xe8e0d0);
  k.cyl(3.3, SY, -7.4, 0.012, 1.1, 0x9a9a9a); k.cyl(3.3, SY + 1.1, -7.4, 0.22, 0.012, gold);
  // chandeliers down the middle, sconces on the walls; tall windows with the afternoon coming in
  const bulb = k.glow(0xffe0a8, 1.5, 'lamp'), crystal = k.glow(0xfff4e0, 0.9, 'lamp');
  for (const x of [-5, 0, 5]) {
    const cy = H - 1.6, cz = -1;
    k.cyl(x, cy + 0.3, cz, 0.02, H - cy - 0.3, 0x8a6a2a); k.cyl(x, cy, cz, 0.5, 0.05, gold);
    k.ball(x, cy + 0.12, cz, 0.18, 0.28, 0.18, bulb); k.ball(x, cy - 0.25, cz, 0.12, 0.2, 0.12, crystal);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; k.ball(x + 0.5 * Math.cos(a), cy + 0.12, cz + 0.5 * Math.sin(a), 0.07, 0.1, 0.07, bulb); }
  }
  for (const side of ['left', 'right'] as const) for (const z of [-3.5, 2.5]) {
    k.window(side, z, 1.0, 1.6, 3.8, seed + (side === 'left' ? 0 : 5) + z);
    k.onWall(side, z, () => {
      for (const s of [-1, 1]) k.box(s * 1.15, 0.2, 0.12, 0.45, 5.4, 0.08, 0x8a1a2a);
      k.box(0, 5.5, 0.12, 2.8, 0.45, 0.12, 0x9a2232);
    });
    k.onWall(side, z + 3, () => k.box(0, 2.6, 0.06, 0.18, 0.24, 0.12, k.glow(0xffd8a0, 1.2, 'lamp')));
  }
  // tables round the edge with their cloths, tea things and cake stands, chairs round them
  const china = 0xf4f0e8, CAKE = [0xf0a0b0, 0xf0d070, 0x8a5a3a, 0xf4ece0, 0xc84a5a];
  const tables: [number, number][] = [[-6, 6.2], [-2.4, 6.4], [1.2, 6.0], [4.8, 6.3], [8.2, 5.8], [-9.6, 1.5], [-9.6, -3.5], [9.6, 1.0], [9.6, -4.0]];
  const MINE = 2, mates = companions(c, 2);
  let n = 0;
  tables.forEach(([tx, tz], ti) => {
    k.cyl(tx, 0, tz, 0.52, 0.76, 0xf4f0e8);
    k.ball(tx - 0.2, 0.84, tz - 0.12, 0.1, 0.09, 0.1, china);
    k.cyl(tx + 0.22, 0.76, tz, 0.012, 0.4, gold); k.cyl(tx + 0.22, 0.8, tz, 0.15, 0.012, china); k.cyl(tx + 0.22, 1.0, tz, 0.11, 0.012, china);
    if (ti === MINE) {
      k.box(tx - 0.12, 0.83, tz - 0.12, 0.1, 0.03, 0.03, china, 0.3); k.ball(tx - 0.2, 0.94, tz - 0.12, 0.025, 0.02, 0.025, china);
      for (const [cx, cz] of [[0.08, 0.32], [-0.3, 0.12], [0.25, -0.3]]) { k.cyl(tx + cx, 0.76, tz + cz, 0.07, 0.01, china); k.cyl(tx + cx, 0.77, tz + cz, 0.04, 0.05, china); }
      for (let i = 0; i < 5; i++) { const a = i * 1.3, top = i > 2; k.cyl(tx + 0.22 + Math.cos(a) * (top ? 0.05 : 0.09), top ? 1.012 : 0.812, tz + Math.sin(a) * (top ? 0.05 : 0.09), 0.035, 0.035, pick(r, CAKE)); }
      k.cyl(tx + 0.22, 1.14, tz, 0.08, 0.012, china); k.ball(tx + 0.22, 1.17, tz, 0.03, 0.025, 0.03, pick(r, CAKE));
    } else { k.cyl(tx + 0.25, 0.812, tz + 0.05, 0.05, 0.04, pick(r, CAKE)); k.cyl(tx - 0.05, 0.76, tz + 0.25, 0.04, 0.05, china); }
    const seats = ti === MINE ? [Math.PI / 2, Math.PI * 1.15, Math.PI * 1.85] : [Math.PI * 0.6, Math.PI * 1.3, Math.PI * 1.95].map((a) => a + (r() - 0.5) * 0.3);
    seats.forEach((a, si) => {
      const x = tx + 0.74 * Math.cos(a), z = tz + 0.74 * Math.sin(a), toward = yawTo(x, z, tx, tz);
      chair(k, x, z, along(tx - x, tz - z), 0x5a2a1a, 0.46, 0.5);
      if (ti === MINE) { if (si && mates[si - 1]) k.sit(bare(mates[si - 1].look), x, z, 0.47, toward, 0.6, si); return; }
      if (r() < 0.75) k.sit(bare(visitor(c, 200 + n, crowdStage(r, 0.05, 0.75))), x, z, 0.47, toward + (r() - 0.5) * 0.5, r() < 0.35 ? 0.6 : 0, n++);
    });
  });
  // a waitress going along the tables with the tea
  lineWalker(k, dress(staff(c, 1), 0x1a1a1a, 0x1a1a1a, BIT.skirt), -7.5, 5.0, 7.5, 4.9, 0.7, r());
  // the couples: round the floor anticlockwise, most turning as they go (a waltz), some walking it (a foxtrot), rising and falling
  const SUIT = [0x1d1d22, 0x26314f, 0x3a3f4a, 0x5a4a3a, 0x2a2a30], DRESS = [0xb02050, 0x2a6a8a, 0xd8b048, 0x6a2a6a, 0x3a7a5a, 0xe8d8c8, 0xc86a3a, 0x2a2a6a];
  const PAIRS = Math.min(10, Math.floor((64 - k.bodies.length) / 2));
  for (let p = 0; p < PAIRS; p++) {
    const lead = dress(visitor(c, 400 + p * 2, crowdStage(r, 0, 0.75)), pick(r, SUIT), 0, BIT.shirtFront | (r() < 0.6 ? BIT.tie : 0), NOPE);
    lead.a[3] = lead.a[2];
    const col = pick(r, DRESS), follow = dress(visitor(c, 401 + p * 2, crowdStage(r, 0, 0.75)), col, col, BIT.skirt, NOPE);
    lead.pace = follow.pace = 0.009;
    const a0 = (p / PAIRS) * TAU + (r() - 0.5) * 0.3, lane = 1 + (r() - 0.5) * 0.28, w = -0.105 * (0.9 + r() * 0.2);
    const spin = r() < 0.6 ? 1.0 + r() * 0.6 : 0, s0 = r() * TAU, rise = r() * TAU;
    const at = { x: 0, z: 0, ux: 1, uz: 0, y: 0 };
    k.bodies.push({ look: lead, x: 0, y: 0, z: 0, yaw: 0, swing: 0.3, pose: 1, ph: p * 2,
      move: (t, b) => {
        const a = a0 + w * t, cx = 5.0 * lane * Math.cos(a), cz = -1 + 3.2 * lane * Math.sin(a);
        const [vx, vz] = unit(-5.0 * lane * Math.sin(a) * w, 3.2 * lane * Math.cos(a) * w);
        const [ux, uz] = spin ? [Math.cos(s0 + spin * t), Math.sin(s0 + spin * t)] : [vx, vz];
        at.x = cx; at.z = cz; at.ux = ux; at.uz = uz;
        at.y = spin ? 0.025 * (1 - Math.cos(t * 4.8 + rise)) : 0.01 * (1 - Math.cos(t * 3.6 + rise));
        // the lead behind the line of travel facing it (or on the turning line), the partner facing them
        b.x = cx - ux * 0.21 + uz * 0.05; b.z = cz - uz * 0.21 - ux * 0.05; b.y = at.y; b.yaw = Math.atan2(-uz, ux);
      } });
    k.bodies.push({ look: follow, x: 0, y: 0, z: 0, yaw: 0, swing: 0.3, pose: 0.6, ph: p * 2 + 1,
      move: (_t, b) => { b.x = at.x + at.ux * 0.21 - at.uz * 0.05; b.z = at.z + at.uz * 0.21 + at.ux * 0.05; b.y = at.y; b.yaw = Math.atan2(at.uz, -at.ux); } });
  }
  // the light: afternoon through the windows, the chandeliers lit, a warm light on the band
  k.daylight = 0.85; k.ambientNight = 0.2; k.lampOn = 1; k.ceilOn = 1;
  k.ceil.position.set(0, H - 2, -1); k.ceil.color.set(0xffe8c8); k.ceil.userData.max = 40; k.ceil.distance = 0;
  k.lamp.position.set(0, 4.5, -5.5); k.lamp.color.set(0xffc8a8); k.lamp.userData.max = 8;
  const [mx, mz] = tables[MINE];
  const eye = new Vector3(mx, eyeSitting(c, 0.47), mz + 0.76);
  return {
    eye, aim: new Vector3(0, 1.4, -2.5),
    glances: [new Vector3(1.0, 2.3, -6.6), new Vector3(0, 5.2, -1), new Vector3(mx - 0.6, 1.1, mz - 0.3), new Vector3(mx + 0.22, 0.9, mz), new Vector3(-W / 2, 2.6, -3.5), new Vector3(-3, 1.4, 1)],
    label: tea ? 'at the tea dance' : 'sitting out a dance at the dance hall',
  };
};

export const DAYOUT_ROOMS: Partial<Record<LeisureRoom, RoomBuilder>> = { farm, aquarium, planetarium, science, observatory, gallery, pottery, concert, dancehall };
