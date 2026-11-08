import { Vector3, type Mesh, type Material } from 'three';
import { LifeStage, FERRIS, hash2 } from '@msimcity/shared';
import { M, type Kit, type Ctx, type View, type RoomBuilder, type LeisureRoom } from '../interiors';
import {
  outdoors, tree, pine, bench, lampPost, flowerBed, bar, setBar, visitor, crowdStage, companions, loopWalker, lineWalker,
  viewYaw, viewPitch, eyeStanding, eyeSitting, duck, rng, pick, BRIGHT,
} from '../leisureKit';
import { wheelSeat } from '../wheels';

/**
 * What people do in a park (docs/leisure.md: shared leisure.ts parkActivity): a sit on a bench by the path, a picnic on a
 * rug, a kite on the open lawn, feeding the ducks at the water's edge, and the band in the park on its Sunday
 * afternoon; and the funfair's Ferris wheel, ridden in a gondola above the real town (render/wheels.ts).
 */

/** the park round any of its activities: lawns, a gravel walk, trees at the edges, lamps, beds and people about */
function parkGrounds(k: Kit, c: Ctx, o: { path?: boolean; walkers?: number; beds?: boolean; lawn?: boolean } = {}) {
  const r = rng((c.place.venue?.seed ?? c.place.seed) ^ 0x7a1);
  outdoors(k, c, { city: 0.9 });
  if (o.path !== false) { k.box(0, 0, -2.2, 80, 0.02, 2.4, 0xd9cfb4); k.box(0, 0, -0.95, 80, 0.03, 0.1, 0xb8b0a0); }
  // trees round the edges, nearer ones toward the sides so the middle stays open
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2, d = 14 + r() * 26;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.abs(x) < 6 && z < 0 && z > -18) continue;
    (r() < 0.75 ? tree : pine)(k, r, x, z, 0.8 + r() * 0.6);
  }
  if (o.path !== false) for (let i = 0; i < 4; i++) lampPost(k, -18 + i * 12 + r() * 2, -3.6);
  if (o.beds !== false) flowerBed(k, r, 6 + r() * 3, -7 - r() * 3, 1.1 + r() * 0.5);
  // people out for a walk on the path, a jogger, a few on the far grass
  const n = o.walkers ?? 7;
  for (let i = 0; i < n; i++) {
    const look = visitor(c, i, crowdStage(r, 0.2, 0.25));
    const jog = i === 0, sp = jog ? 2.6 : 0.9 + r() * 0.5, dir = r() < 0.5 ? 1 : -1;
    lineWalker(k, look, -30 * dir, -2.0 + (r() - 0.5) * 1.4, 30 * dir, -2.2 + (r() - 0.5) * 1.4, sp, r());
  }
  for (let i = 0; i < (o.lawn === false ? 0 : 4); i++) {
    const look = visitor(c, 40 + i, crowdStage(r, 0.6, 0.1));
    loopWalker(k, look, -8 + r() * 16, -14 - r() * 8, 1.5 + r() * 2, 1 + r() * 1.5, 1.6 + r() * 1.2, r() * 6, r() < 0.5 ? 1 : -1);
  }
  return r;
}
/** pigeons pecking about near (x, z) */
function pigeons(k: Kit, r: () => number, x: number, z: number, n: number) {
  for (let i = 0; i < n; i++) {
    const px = x + (r() - 0.5) * 2.4, pz = z + (r() - 0.5) * 1.6, ph = r() * 6, col = pick(r, [0x8a8e98, 0x6a6e78, 0xa8acb4]);
    const g = k.group(px, pz, r() * 6.28, () => { k.ball(0, 0.12, 0, 0.13, 0.09, 0.08, col); k.ball(0.11, 0.2, 0, 0.05, 0.05, 0.05, 0x5a5e68); });
    k.animate.push((t) => { const peck = Math.max(0, Math.sin(t * 3.1 + ph)); g.rotation.z = -peck * 0.5; g.position.x = px + Math.sin(t * 0.3 + ph) * 0.4; });
  }
}

/** a sit on a bench beside the gravel walk, watching the park go by */
const stroll: RoomBuilder = (k, c) => {
  const r = parkGrounds(k, c);
  bench(k, 0, 0.2, Math.PI);
  const mates = companions(c, 1);
  if (mates[0]) k.sit(mates[0].look, 0.55, 0.15, 0.47, Math.PI / 2 + 0.2, 0, 1);
  pigeons(k, r, 0.4, -2.2, 5);
  // a fountain off to one side, its jet rising and falling
  k.cyl(-6, 0, -9, 2.2, 0.45, 0xb8b0a0); k.cyl(-6, 0.45, -9, 2.0, 0.02, 0x4f8fc9);
  k.cyl(-6, 0, -9, 0.25, 1.4, 0xb8b0a0); k.cyl(-6, 1.4, -9, 0.7, 0.12, 0xb8b0a0);
  const jet = k.cyl(-6, 1.5, -9, 0.08, 1, k.glow(0xcfe8ff, 0.9));
  k.animate.push((t) => { jet.scale.y = 0.9 + 0.35 * Math.sin(t * 1.7) + 0.1 * Math.sin(t * 5.3); });
  const eye = new Vector3(0, eyeSitting(c, 0.47), 0.05);
  return { eye, aim: new Vector3(0, 1.3, -10), glances: [new Vector3(-6, 1.6, -9), new Vector3(6, 1.2, -2), new Vector3(0.6, 0.2, -2.2)], label: 'sitting on a bench in the park' };
};

/** a picnic: a rug, a basket and the family round it under a big tree, a frisbee going back and forth beyond */
const picnic: RoomBuilder = (k, c) => {
  const r = parkGrounds(k, c, { path: false, walkers: 3 });
  tree(k, r, -3.5, 2.5, 1.3);
  // the rug: a check of two colours
  const [ca, cb] = pick(r, [[0xc0392b, 0xf4f0e8], [0x2f5a8a, 0xe8d8a8], [0x3a7a4a, 0xe6b734], [0x7a2f5a, 0xf0e0d0]] as [number, number][]);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) k.box(-1.1 + i * 0.37 + 0.185, 0, -1.55 + j * 0.37 + 0.185, 0.37, 0.015, 0.37, (i + j) % 2 ? ca : cb);
  // basket, plates, a flask, apples and sandwiches
  k.box(0.6, 0.015, -0.9, 0.5, 0.3, 0.34, 0xb08a4a); k.box(0.6, 0.315, -0.9, 0.52, 0.03, 0.36, 0x8a6a3a);
  for (const sx of [-0.18, 0.18]) k.box(0.6 + sx, 0.33, -0.9, 0.03, 0.14, 0.03, 0x8a6a3a);
  k.box(0.6, 0.47, -0.9, 0.39, 0.03, 0.03, 0x8a6a3a);
  for (const [px, pz] of [[-0.3, -0.6], [0.1, -0.35], [-0.55, -1.1]]) { k.cyl(px, 0.015, pz, 0.13, 0.015, 0xf4f4f0); k.box(px - 0.04, 0.03, pz - 0.03, 0.1, 0.04, 0.1, 0xe8d0a0); }
  k.cyl(-0.05, 0.015, -1.15, 0.05, 0.3, 0x2a5a8a); k.cyl(-0.05, 0.315, -1.15, 0.045, 0.05, 0xd8d8d8);
  for (let i = 0; i < 4; i++) k.ball(0.15 + r() * 0.3, 0.06, -1.25 + r() * 0.25, 0.045, 0.045, 0.045, pick(r, [0xc0392b, 0x7aa83a]));
  // the family round the rug
  const mates = companions(c, 3);
  const seats: [number, number, number][] = [[0.8, -0.3, Math.PI * 0.85], [-0.2, -1.55, Math.PI * 0.5], [0.95, -1.45, Math.PI * 0.68]];
  mates.forEach((m, i) => { const [x, z, yaw] = seats[i]; k.sit(m.look, x, z, 0.12, yaw, 0, i); });
  if (!mates.length) k.sit(visitor(c, 90, LifeStage.Adult), 0.8, -0.3, 0.12, Math.PI * 0.85, 1, 0);
  // other picnics further off, and two friends throwing a frisbee
  for (let g = 0; g < 3; g++) {
    const gx = -12 + g * 11 + r() * 3, gz = -12 - r() * 8;
    k.box(gx, 0, gz, 1.8, 0.015, 1.5, pick(r, BRIGHT));
    for (let i = 0; i < 2 + Math.floor(r() * 2); i++) k.sit(visitor(c, 60 + g * 4 + i, crowdStage(r, 0.3, 0.2)), gx + (i - 1) * 0.7, gz + 0.8, 0.12, Math.PI / 2 + (r() - 0.5), 0, g * 4 + i);
  }
  const fa = new Vector3(-6, 1.3, -9), fb = new Vector3(4, 1.3, -14);
  k.stand(visitor(c, 80), fa.x, fa.z, Math.atan2(-(fb.z - fa.z), fb.x - fa.x), 0, 1);
  k.stand(visitor(c, 81), fb.x, fb.z, Math.atan2(-(fa.z - fb.z), fa.x - fb.x), 0, 2);
  const disc = k.cyl(0, 0, 0, 0.13, 0.025, 0xf4f4f0);
  k.animate.push((t) => {
    const u = (t / 2.6) % 2, f = u < 1 ? u : 2 - u;
    disc.position.lerpVectors(fa, fb, f); disc.position.y = 1.3 + Math.sin(f * Math.PI) * 2.2; disc.rotation.y = t * 9;
  });
  const eye = new Vector3(-0.3, eyeSitting(c, 0.12), 0.05);
  return { eye, aim: new Vector3(0.3, 0.1, -1.0), glances: [new Vector3(0, 1.4, -11), new Vector3(0.8, 0.6, -0.3), new Vector3(-3.5, 4, 2)], label: 'having a picnic in the park' };
};

/** a kite on the wind over the open lawn: the string from your hand up to it, its tail streaming */
const kite: RoomBuilder = (k, c) => {
  const r = parkGrounds(k, c, { path: false, walkers: 2 });
  // the kite's sail glows a little (thin cloth with the sun behind it), so it reads bright against the sky
  const col = k.glow(pick(r, [0xd94f4f, 0x2f8fd6, 0xe6b734, 0xd94fa0, 0x4f9a5c]), 0.95), col2 = k.glow(pick(r, [0xf4f4f0, 0x2a2a2a, 0xe6b734]), 0.95);
  const kiteG = k.group(0, 0, 0, () => {
    // a diamond: two triangles made of a square turned 45 degrees, a cross of spars and a bow tail
    // a square turned 45 degrees about its base-centre: shift it so the diamond's centre is the bridle point
    const diamond = (side: number, cy: number, z: number, cc: Material) => { const m = k.box(0.3536 * side, cy - 0.3536 * side, z, side, side, 0.03, cc); m.rotation.z = Math.PI / 4; };
    diamond(1.06, 0, 0, col); diamond(0.42, 0.22, 0.02, col2);
    k.box(0, -0.75, 0.03, 0.04, 1.5, 0.02, 0x5a4232); k.box(0, -0.02, 0.03, 1.5, 0.04, 0.02, 0x5a4232);
  });
  const tail: Mesh[] = [];
  for (let i = 0; i < 7; i++) tail.push(k.box(0, 0, 0, 0.32, 0.12, 0.03, i % 2 ? col2 : col));
  const hand = new Vector3(0.25, 1.2 * c.viewer.height, -0.35), at = new Vector3();
  const line = bar(k, hand, new Vector3(0, 10, -20), 0.012, 0xf4f4f0);
  const pos = (t: number, out: Vector3) => out.set(4 * Math.sin(t * 0.31) + 1.5 * Math.sin(t * 1.13 + 1), 11 + 2.5 * Math.sin(t * 0.47 + 2) + 0.8 * Math.sin(t * 1.7), -16 + 1.5 * Math.sin(t * 0.23));
  k.animate.push((t) => {
    pos(t, at);
    kiteG.position.copy(at); kiteG.rotation.set(0.3 * Math.sin(t * 0.6), 0, 0.35 * Math.sin(t * 0.9) + 0.15 * Math.sin(t * 2.3)); kiteG.scale.setScalar(1.6);
    setBar(line, hand, at, 0.012);
    // the tail streams away down-wind and waves
    for (let i = 0; i < tail.length; i++) {
      const s = (i + 1) * 0.55;
      tail[i].position.set(at.x + Math.sin(t * 2.2 - i * 0.7) * 0.25 * (i + 1) * 0.4, at.y - 1.6 - s, at.z - s * 0.3);
      tail[i].rotation.z = Math.sin(t * 3 - i) * 0.6;
    }
  });
  // other kites far off over the hill, and a child with one of their own
  for (let i = 0; i < 2; i++) {
    const g = k.group(-30 + i * 55 + r() * 6, -45 - r() * 10, 0, () => { const b = k.box(0, 14 + r() * 6, 0, 1.4, 1.4, 0.05, pick(r, BRIGHT)); b.rotation.z = Math.PI / 4; });
    const ph = r() * 6; k.animate.push((t) => { g.rotation.z = 0.2 * Math.sin(t * 0.8 + ph); g.position.y = Math.sin(t * 0.5 + ph); });
  }
  const mates = companions(c, 2);
  mates.forEach((m, i) => k.stand(m.look, 1.1 + i * 0.7, 0.4 + i * 0.3, Math.PI / 2 + 0.3, 0, i));
  const eye = new Vector3(0, eyeStanding(c), 0), look = new Vector3();
  let yaw = 0, pitch = 0.5;
  return {
    eye, aim: new Vector3(0, 11, -16), glances: [], label: 'flying a kite in the park',
    // the head follows the kite, a little behind it
    move: (t) => {
      pos(t - 0.4, look);
      yaw += (viewYaw(eye, look) - yaw) * 0.08; pitch += (viewPitch(eye, look) - 0.06 - pitch) * 0.08;
      return { yaw, pitch, roll: 0.02 * Math.sin(t * 0.7) };
    },
  };
};

/** feeding the ducks: at the water's edge, crumbs arcing out and the ducks paddling over */
const ducks: RoomBuilder = (k, c) => {
  const r = parkGrounds(k, c, { path: false, walkers: 0, beds: false, lawn: false });
  // the pond: water from just in front of you to the far bank, a stone edge, reeds and a willow
  k.box(0, 0, -16, 44, 0.03, 30, 0x4f8fc9);
  k.box(0, 0, -1.0, 44, 0.16, 0.35, 0xb8b0a0);
  for (let i = 0; i < 14; i++) {
    const x = -20 + r() * 40, z = -2 - r() * 26;
    if (Math.abs(x) < 4 && z > -9) continue;
    for (let j = 0; j < 6; j++) k.box(x + (r() - 0.5) * 0.8, 0, z + (r() - 0.5) * 0.6, 0.05, 0.8 + r() * 0.7, 0.05, pick(r, [0x5a7a3a, 0x7a8a4a, 0x4a6a3a]));
  }
  tree(k, r, 7, -3.5, 1.1); tree(k, r, -9, -28, 1.3);
  // a few ducks, a swan, each on its own slow loop that comes close to the bank
  const ds: { g: ReturnType<Kit['group']>; cx: number; cz: number; rx: number; rz: number; w: number; ph: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const g = duck(k, r, 0, 0.03, 0, 0);
    ds.push({ g, cx: (r() - 0.5) * 6, cz: -3.4 - r() * 2.5, rx: 0.8 + r() * 1.8, rz: 0.6 + r() * 1.2, w: (0.15 + r() * 0.2) * (r() < 0.5 ? 1 : -1), ph: r() * 6 });
  }
  const swan = k.group(0, 0, 0, () => {
    k.ball(0, 0.2, 0, 0.42, 0.2, 0.26, 0xf4f4f0); k.box(0.3, 0.25, -0.04, 0.08, 0.5, 0.08, 0xf4f4f0); k.ball(0.38, 0.78, 0, 0.09, 0.07, 0.07, 0xf4f4f0); k.box(0.46, 0.74, -0.02, 0.1, 0.04, 0.04, 0xe07a2a);
  });
  ds.push({ g: swan, cx: -5, cz: -8, rx: 3, rz: 1.5, w: 0.08, ph: 1 });
  k.animate.push((t) => {
    for (const d of ds) {
      const a = d.ph + t * d.w;
      d.g.position.set(d.cx + Math.cos(a) * d.rx, 0.01 * Math.sin(t * 2 + d.ph), d.cz + Math.sin(a) * d.rz);
      d.g.rotation.y = Math.atan2(-(Math.cos(a) * d.rz * d.w), -Math.sin(a) * d.rx * d.w);
    }
  });
  // crumbs: one every couple of seconds from the hand out over the water, a ripple where it lands
  const hand = new Vector3(0.25, 1.1 * c.viewer.height, -0.4);
  const crumbs = [0, 1, 2].map(() => k.ball(0, -1, 0, 0.022, 0.018, 0.022, 0xd8b880));
  const ripples = [0, 1, 2].map(() => k.cyl(0, -1, 0, 0.3, 0.005, 0x8ab8e0));
  const land = (n: number) => new Vector3((hash2(n, 3) - 0.5) * 3, 0.04, -2.2 - hash2(n, 5) * 2.2);
  k.animate.push((t) => {
    for (let i = 0; i < 3; i++) {
      const T = 2.1, s = t / T + i / 3, n = Math.floor(s), u = s - n, to = land(n * 3 + i);
      if (u < 0.35) { const f = u / 0.35; crumbs[i].position.lerpVectors(hand, to, f); crumbs[i].position.y = hand.y + (to.y - hand.y) * f + Math.sin(f * Math.PI) * 0.6; ripples[i].position.y = -1; }
      else { crumbs[i].position.set(to.x, 0.04, to.z); const g = (u - 0.35) / 0.65; ripples[i].position.set(to.x, 0.035, to.z); ripples[i].scale.set(0.15 + g * 1.4, 0.005, 0.15 + g * 1.4); if (g > 0.9) ripples[i].position.y = -1; }
    }
  });
  const mates = companions(c, 2);
  mates.forEach((m, i) => k.stand(m.look, -1.3 - i * 0.7, -0.55, Math.PI / 2 + 0.2, 0, i));
  if (!mates.length) k.stand(visitor(c, 70, LifeStage.Child), -1.4, -0.6, Math.PI / 2, 0, 0);
  return { eye: new Vector3(0, eyeStanding(c) * 0.92, 0), aim: new Vector3(0, 0, -3.6), glances: [new Vector3(-5, 0.3, -8), new Vector3(1.5, 0.2, -2.8), new Vector3(-0.8, 1, -0.3)], label: 'feeding the ducks in the park' };
};

/** the band in the park: deckchairs on the lawn before the bandstand, a brass band in red and gold */
const band: RoomBuilder = (k, c) => {
  const r = parkGrounds(k, c, { path: false, walkers: 2 });
  const bz = -11;
  // the bandstand: an octagonal stone base, white columns and a green roof with a gilt finial
  k.cyl(0, 0, bz, 3.3, 0.9, 0xc8c0b0);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; k.cyl(Math.cos(a) * 3.0, 0.9, bz + Math.sin(a) * 3.0, 0.09, 2.6, 0xf4f4f0); }
  k.cyl(0, 3.5, bz, 3.5, 0.25, 0xf4f4f0); k.cone(0, 3.75, bz, 3.6, 1.6, 0x3f6b4f); k.cyl(0, 5.35, bz, 0.08, 0.6, 0xd8b25a);
  // the band in a curve facing the lawn, the conductor in front
  for (let i = 0; i < 7; i++) {
    const a = Math.PI * (0.15 + (i / 6) * 0.7), x = Math.cos(a) * 2.2, z = bz - Math.sin(a) * 1.2 + 0.4;
    const look = visitor(c, 100 + i);
    look.a = [look.a[0], look.a[1], 0xb02a2a, 0x1a1a2a];
    k.sit(look, x, z, 0.9 + 0.46, -Math.PI / 2 + (x * -0.08), 0, i);
    chairOf(k, x, z);
    // their instrument: a gilt bell before them
    if (i % 3 === 1) { k.cyl(x, 1.9, z + 0.35, 0.22, 0.5, 0xd8b25a); }
    else k.cone(x, 1.75, z + 0.35, 0.12, 0.3, 0xd8b25a);
  }
  const cond = visitor(c, 120); cond.a = [cond.a[0], cond.a[1], 0x1a1a2a, 0x1a1a2a];
  k.bodies.push({ look: cond, x: 0, y: 0.9, z: bz + 2.2, yaw: Math.PI / 2, swing: 0, pose: 0, ph: 9, move: (t, b) => { b.yaw = Math.PI / 2 + 0.25 * Math.sin(t * 1.4); } });
  // bunting from the bandstand out to the lamp posts
  for (const sx of [-1, 1]) for (let i = 0; i < 12; i++) {
    const f = i / 11, x = sx * (3.2 + f * 7), y = 3.4 - Math.sin(f * Math.PI) * 0.9 - f * 0.6, z = bz + f * 8.5;
    k.cone(x, y - 0.3, z, 0.12, 0.3, pick(r, BRIGHT)).rotation.x = Math.PI;
  }
  // deckchairs in rows on the lawn
  let n = 0, ex = 0, ez = 0;
  for (let row = 0; row < 4; row++) for (let i = 0; i < 9; i++) {
    const x = (i - 4) * 1.3 + (r() - 0.5) * 0.3, z = bz + 6 + row * 1.6 + (r() - 0.5) * 0.3, yaw = (r() - 0.5) * 0.3;
    deckchair(k, x, z, yaw, pick(r, [[0xd94f4f, 0xf4f4f0], [0x2f5a8a, 0xf4f4f0], [0x3a7a4a, 0xe6b734]] as [number, number][]));
    if (row === 2 && i === 5) { ex = x; ez = z; continue; }
    if (r() < 0.7) k.sit(visitor(c, 130 + n, crowdStage(r, 0.15, 0.4)), x, z + 0.1, 0.36, Math.PI / 2 + yaw, 0, n);
    n++;
  }
  const mates = companions(c, 2);
  mates.forEach((m, i) => { deckchair(k, ex + 1.0 + i, ez, 0, [0xd94f4f, 0xf4f4f0]); k.sit(m.look, ex + 1.0 + i, ez + 0.1, 0.36, Math.PI / 2, 0, i); });
  return { eye: new Vector3(ex, eyeSitting(c, 0.36) - 0.05, ez + 0.15), aim: new Vector3(0, 2.0, bz), glances: [new Vector3(0, 1.2, bz + 2.2), new Vector3(ex + 1, 1.0, ez), new Vector3(-6, 3, bz + 4)], label: 'listening to the band in the park' };
};
function chairOf(k: Kit, x: number, z: number) { k.box(x, 0.9, z, 0.4, 0.45, 0.4, 0x2a2a2a); }
function deckchair(k: Kit, x: number, z: number, yaw: number, [a, b]: [number, number]) {
  // the sitter faces -z with their hips at z + 0.1: the canvas runs from low at the front to high behind them
  k.group(x, z, yaw, () => {
    for (const sx of [-0.27, 0.27]) {
      k.box(sx, 0.4, 0.1, 0.035, 0.035, 1.05, 0x8a6a3a).rotation.x = -0.65;
      k.box(sx, 0, -0.3, 0.035, 0.32, 0.035, 0x8a6a3a);
    }
    for (let i = 0; i < 5; i++) k.box(-0.2 + i * 0.1, 0.38, 0.1, 0.1, 0.012, 1.0, i % 2 ? a : b).rotation.x = -0.65;
  });
}

/**
 * The funfair: a gondola of the Ferris wheel, turning with the real wheel (render/wheels.ts) above the real town. The
 * gondola is drawn over the city (View.overWorld), in metres round its pivot. With no wheel loaded (a preview, a chunk
 * not in), it rides above a sky dome instead.
 */
const funfair: RoomBuilder = (k, c) => {
  const r = rng(c.place.seed ^ 0xf00);
  const v = c.place.venue, seat = Math.floor(hash2(c.info.id, 77) * FERRIS.gondolas);
  const T = 1 / M; // metres per tile
  // the cabin a little roomier across than the town view's gondola (that one is left out while ridden); its depth stays
  // inside the twin rims, which pass just beyond its open ends
  const W = 1.6, D = FERRIS.cabD * T, H = FERRIS.cabH * T, hang = FERRIS.hang * T;
  const first = v ? wheelSeat(v.x, v.y, seat) : null;
  const yw = first?.yaw ?? 0;
  const paint = pick(r, [0xd94f4f, 0xe6b734, 0x2f8fd6, 0x4f9a5c, 0xd94fa0, 0xe0662e]);
  // with no wheel to ride (a preview), the gondola hangs high over open country under the sky dome instead (the dome
  // moved up with it, so its horizon stays level with the eye)
  const lift = first ? 0 : 38;
  if (!first) {
    const sky = outdoors(k, c, { city: 1.6, ground: 0x6a8a5a });
    k.scene.children.forEach((o) => { if ((o as Mesh).material === sky) o.position.y = lift; });
  }
  // the gondola, its open ends along the axle (+z of the group = the way the building faces); the pivot at the origin
  const g = k.group(0, 0, yw, () => {
    const fy = -hang, waist = 0.75;
    k.box(0, fy - 0.06, 0, W, 0.06, D, paint);
    // waist-high panels all round; the sides along the wheel's plane are windows above them, the ends open with a bar
    for (const sz of [-1, 1]) k.box(0, fy, sz * (D / 2 - 0.03), W, waist, 0.05, paint);
    for (const sx of [-1, 1]) {
      k.box(sx * (W / 2 - 0.03), fy, 0, 0.05, waist, D, paint);
      k.box(sx * (W / 2 - 0.03), fy + waist, 0, 0.07, 0.05, D, 0xf4f4f0);
      for (const sz of [-1, 1]) k.box(sx * (W / 2 - 0.035), fy, sz * (D / 2 - 0.035), 0.07, H, 0.07, 0xf4f4f0);
    }
    for (const sz of [-1, 1]) k.box(0, fy + waist, sz * (D / 2 - 0.03), W, 0.05, 0.08, 0xf4f4f0);
    k.box(0, fy + H, 0, W + 0.2, 0.08, D + 0.2, paint); k.cone(0, fy + H + 0.08, 0, Math.hypot(W, D) * 0.55, 0.3, paint).rotation.y = Math.PI / 4;
    k.box(0, fy + H + 0.3, 0, 0.08, hang - H - 0.3, 0.08, 0x3a3e49);
    // the bench across the back end, a safety bar at the front
    k.box(0, fy, -D / 2 + 0.3, W - 0.12, 0.45, 0.4, 0x6a4a2a);
    k.box(0, fy + 0.62, D / 2 - 0.2, W - 0.1, 0.04, 0.04, 0xd8b25a);
  });
  g.position.y = lift;
  const mates = companions(c, 1);
  const mate = mates[0]?.look ?? visitor(c, 7, crowdStage(r, 0.3, 0.1));
  const [mx, mz] = rot(yw, 0.38, -D / 2 + 0.32);
  // facing out of the front end with the rider: the gondola's +z (yaw of a body: atan2(-dz, dx) for (sin yw, cos yw))
  k.sit(mate, mx, mz, lift - hang + 0.45, Math.atan2(-Math.cos(yw), Math.sin(yw)) + 0.3, 0, 1);
  const [lx, lz] = rot(yw, -0.32, -D / 2 + 0.35);
  const eye = new Vector3(lx, lift - hang + eyeSitting(c, 0.45), lz);
  k.ceilOn = 0; k.lampOn = 0; k.daylight = 1; k.ambientNight = 0.35;
  k.sunDir.set(0.3, -0.8, 0.2).normalize();
  const out = new Vector3(Math.sin(yw), 0, Math.cos(yw)); // along the axle, out of the front end
  const base = viewYaw(new Vector3(), out);
  let last = first;
  return {
    eye, aim: out.clone().multiplyScalar(10), glances: [], label: 'riding the Ferris wheel',
    move: (t) => {
      const s = v ? wheelSeat(v.x, v.y, seat) : null;
      if (s) last = s;
      const ang = last?.angle ?? t * 0.04, high = Math.sin(ang); // -1 at the bottom, 1 at the top
      g.rotation.z = 0; g.rotation.x = 0.015 * Math.sin(t * 0.9);
      // looking out over the town: a slow look round, down toward the fair near the top
      return { yaw: base + 0.4 * Math.sin(t * 0.13) + 0.12 * Math.sin(t * 0.41), pitch: -0.08 - 0.22 * Math.max(0, high) + 0.05 * Math.sin(t * 0.3), roll: 0.012 * Math.sin(t * 0.9) };
    },
    overWorld: first ? () => {
      const p = last!.pivot;
      return { x: p.x + eye.x * M, y: p.y + eye.y * M, z: p.z + eye.z * M };
    } : undefined,
  };
};
/** a point in the gondola's frame (x across, z along the axle) turned to the wheel's yaw */
function rot(yw: number, x: number, z: number): [number, number] { return [x * Math.cos(yw) + z * Math.sin(yw), -x * Math.sin(yw) + z * Math.cos(yw)]; }

export const PARK_ROOMS: Partial<Record<LeisureRoom, RoomBuilder>> = { stroll, picnic, kite, ducks, band, funfair };
export type { View };
