import { Vector3, Color, Mesh, ShaderMaterial, SphereGeometry, AdditiveBlending, DoubleSide, type Object3D, type Group, type MeshBasicMaterial } from 'three';
import { LifeStage, VENUE_WORDS, hash2, type VenueType } from '@msimcity/shared';
import { VERT, HIP_M, bookshelf, picture, chair, type Kit, type Ctx, type View, type RoomBuilder, type LeisureRoom, type Body, type Rng } from '../interiors';
import { bar, setBar, visitor, crowdStage, staff, companions, loopWalker, lineWalker, viewYaw, viewPitch, eyeStanding, eyeSitting, rng, pick, BRIGHT, WOOD } from '../leisureKit';
import type { Look } from '../people';

/**
 * First-person scenes for the indoor free-time places (docs/leisure.md), built with render/leisureKit.ts: the bowling
 * alley (your own throws and your friends' down a lane, the pins flying, the sweep and the rack), the ice rink and the
 * roller disco (skating round with the crowd, leaning into the turns), the climbing wall (halfway up a route on a top
 * rope), the trampoline park (bouncing), the arcade (at a cabinet whose game plays), the board-game café (a game of
 * ludo with the dice rolling) and the escape room (an old professor's study, the clock running down).
 *
 * Halls without windows light themselves (hallLights): their own steady overhead light whatever the hour outside.
 */

// ---- helpers ---------------------------------------------------------------------------------

const seedOf = (c: Ctx) => c.place.venue?.seed ?? c.place.seed;
/** is the place's event on (league night, the ice disco)? */
const eventOn = (c: Ctx, t: VenueType) => VENUE_WORDS[t].event !== VENUE_WORDS[t].at && c.info.activity === VENUE_WORDS[t].event;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x: number) => { const u = clamp01(x); return u * u * (3 - 2 * u); };
const wrapPi = (a: number) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
const mod = (a: number, n: number) => ((a % n) + n) % n;
/** the feet of a figure seated on a seat this high (Kit.sit) */
const seatY = (l: Look, seat: number) => seat - HIP_M * l.height + 0.04;

// people.ts feature bits: bands on a high-vis top; coat, bags and briefcase (left in a locker for sport)
const BANDS = 1 << 17, BAGS = (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10);
/** a look in other clothes: a top (and legs), with feature bits set or cleared */
function dressed(l: Look, top: number, legs = l.a[3], set = 0, clear = 0): Look {
  return { ...l, a: [l.a[0], l.a[1], top, legs], b: [l.b[0], l.b[1], l.b[2], (l.b[3] | set) & ~clear] };
}
const sporty = (l: Look) => dressed(l, l.a[2], l.a[3], 0, BAGS);
const hiVis = (l: Look) => dressed(l, 0xf2d230, l.a[3], BANDS, BAGS);

/** who came along: the viewer's own household first, then friends seeded by the place */
function party(c: Ctx, r: Rng, n: number, slot: number, child = 0.25, retired = 0.15): Look[] {
  const out = companions(c, n).map((m) => m.look);
  for (let i = 0; out.length < n; i++) out.push(visitor(c, slot + i, crowdStage(r, child, retired)));
  return out;
}

/** A hall's own lights: a steady sky light and an overhead key light whatever the hour (the kit's hemisphere and sun, set after the clock has had its say). Change the fields to dim or colour them. */
interface HallLight { hemi: number; sun: number; sky: Color; ground: Color; sunCol: Color }
function hallLights(k: Kit, hemi: number, sun: number, sky = 0xfff4e8, ground = 0x6a5a4a, sunCol = 0xfff4e8, dir: [number, number, number] = [0.25, -1, 0.35]): HallLight {
  const o: HallLight = { hemi, sun, sky: new Color(sky), ground: new Color(ground), sunCol: new Color(sunCol) };
  k.daylight = 0;
  k.sunDir.set(dir[0], dir[1], dir[2]).normalize();
  k.animate.push(() => {
    k.hemi.color.copy(o.sky); k.hemi.groundColor.copy(o.ground); k.hemi.intensity = o.hemi;
    k.sun.color.copy(o.sunCol); k.sun.intensity = o.sun;
  });
  return o;
}
/** a see-through glowing material: glass, a net, a light beam (additive) */
function seeThrough(k: Kit, col: number, opacity: number, additive = false): MeshBasicMaterial {
  const m = k.glow(col, 1);
  m.transparent = true; m.opacity = opacity; m.depthWrite = false;
  if (additive) m.blending = AdditiveBlending;
  return m;
}
/** a head turning smoothly toward where it is told to look (yaw, pitch), at `rate` per second */
function smoother(rate = 3) {
  let y = NaN, p = 0, last = -1;
  return (t: number, ty: number, tp: number) => {
    if (isNaN(y) || t < last || t - last > 1) { y = ty; p = tp; }
    else { const f = 1 - Math.exp(-(t - last) * rate); y += wrapPi(ty - y) * f; p += (tp - p) * f; }
    last = t;
    return { yaw: y, pitch: p };
  };
}
/** a bobbing body: seated or standing, its weight shifting a little (a DJ, a cheering friend) */
function bob(k: Kit, look: Look, x: number, y: number, z: number, yaw: number, amp: number, rate: number, ph: number, pose = 0) {
  k.bodies.push({ look, x, y, z, yaw, swing: 0, pose, ph, move: (t, b) => { b.y = y + amp * Math.abs(Math.sin(t * rate + ph)); b.yaw = yaw + 0.12 * Math.sin(t * rate * 0.5 + ph); } });
}

/**
 * The eye skating round an ellipse (rx, rz) about the origin the way everyone goes (the angle falling): a push every
 * stride and a sway to the side of the pushing skate, quicker on the straights, leaning into the turns, the head looking
 * a little ahead round the curve and now and then across the rink. `angle` is where on the loop the eye is (for the
 * family skating alongside).
 */
function skateLoop(rx: number, rz: number, speed: number, ph: number, eyeY: number, stride: number) {
  const len = Math.PI * (3 * (rx + rz) - Math.sqrt((3 * rx + rz) * (rx + 3 * rz))), w = (speed / len) * Math.PI * 2;
  const angle = (t: number) => ph - (w * t + 0.35 * Math.sin(t * 0.13 + ph));
  const rate = (t: number) => -(w + 0.35 * 0.13 * Math.cos(t * 0.13 + ph));
  let prevH = NaN, prevT = 0, roll = 0;
  const move = (t: number, e: Vector3) => {
    const a = angle(t), da = rate(t);
    const dx = -Math.sin(a) * rx * da, dz = Math.cos(a) * rz * da, sp = Math.hypot(dx, dz) || 1;
    const st = (t * Math.PI) / stride, sway = 0.07 * Math.sin(st);
    e.set(Math.cos(a) * rx + (-dz / sp) * sway, eyeY + 0.018 * Math.abs(Math.cos(st)), Math.sin(a) * rz + (dx / sp) * sway);
    const heading = Math.atan2(-dx, -dz);
    if (!isNaN(prevH) && t > prevT && t - prevT < 0.5) {
      const turn = wrapPi(heading - prevH) / (t - prevT);
      roll += (Math.max(-0.14, Math.min(0.14, turn * 0.3)) - roll) * Math.min(1, (t - prevT) * 3);
    }
    prevH = heading; prevT = t;
    const la = a + da * 0.9, yaw = Math.atan2(-(Math.cos(la) * rx - e.x), -(Math.sin(la) * rz - e.z));
    const gt = t + ph * 5, gp = mod(gt, 19), glance = gp < 3.2 ? 0.6 * Math.sin((Math.PI * gp) / 3.2) * (Math.floor(gt / 19) % 2 ? 1 : -1) : 0;
    return { yaw: yaw + glance + 0.03 * Math.sin(st), pitch: -0.1 + 0.012 * Math.sin(st * 2), roll: roll + 0.025 * Math.sin(st) };
  };
  return { angle, rate, move };
}
/** a skater keeping pace with the eye's loop on a lane of its own (rx, rz), `off` radians ahead */
function alongside(k: Kit, look: Look, loop: ReturnType<typeof skateLoop>, rx: number, rz: number, off: number, y: number, ph: number) {
  k.bodies.push({ look, x: 0, y, z: 0, yaw: 0, swing: 0.4, pose: 0, ph, move: (t, b) => {
    const a = loop.angle(t) + off, da = loop.rate(t);
    b.x = Math.cos(a) * rx; b.z = Math.sin(a) * rz;
    b.yaw = Math.atan2(-(Math.cos(a) * rz * da), -Math.sin(a) * rx * da);
  } });
}
/** lanes of skaters going round with the crowd: nested ellipses (rx + d, rz + 0.55 d), a small group to a lane at one speed */
function skaters(k: Kit, c: Ctx, r: Rng, rx: number, rz: number, lanes: number[], speed: [number, number], per: number, slot: number, y: number, max: number) {
  let n = 0;
  for (const d of lanes) {
    const count = 1 + Math.floor(r() * per), sp = speed[0] + r() * (speed[1] - speed[0]), ph = r() * 6.28;
    for (let j = 0; j < count && n < max; j++, n++) {
      const look = sporty(visitor(c, slot + n, crowdStage(r, 0.3, 0.08)));
      const b = loopWalker(k, look, 0, 0, rx + d, rz + 0.55 * d, sp, ph + j * (0.08 + r() * 0.05), -1, y);
      b.swing = 0.28 + r() * 0.22;
    }
  }
}
/** a rounded rink's outline, segment by segment: straights and quarter circles of radius rc, as (x, z, length, yaw) */
function rinkEdge(RX: number, RZ: number, RC: number, off: number, per: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const s of [-1, 1]) { out.push([0, s * (RZ + off), 2 * (RX - RC), 0]); out.push([s * (RX + off), 0, 2 * (RZ - RC), Math.PI / 2]); }
  const rr = RC + off, len = 2 * rr * Math.sin(Math.PI / (4 * per)) + 0.06;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let j = 0; j < per; j++) {
    const a = (j + 0.5) * (Math.PI / (2 * per));
    out.push([sx * (RX - RC + Math.cos(a) * rr), sz * (RZ - RC + Math.sin(a) * rr), len, Math.atan2(-sz * Math.cos(a), -sx * Math.sin(a))]);
  }
  return out;
}
/** a rounded rink's floor: two crossing boxes and a disc at each corner */
function rinkFloor(k: Kit, RX: number, RZ: number, RC: number, col: number, grow = 0) {
  const m = k.mat(col);
  k.box(0, 0, 0, 2 * (RX - RC), 0.02, 2 * RZ, m); k.box(0, 0, 0, 2 * RX, 0.02, 2 * (RZ - RC), m);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(sx * (RX - RC), 0, sz * (RZ - RC), RC + grow, 0.02, m);
  return m;
}
/** a mirror ball: facets that catch the light as it turns, and the spots of light it throws sweeping the floor */
function mirrorBall(k: Kit, r: Rng, x: number, y: number, z: number, rad: number, H: number, spread: number, nDots: number) {
  const bright = k.glow(0xffffff, 2.2), dim = k.glow(0x7a8090, 0.7), tint = k.glow(0xa8d8ff, 1.4);
  const facets: Mesh[] = [];
  const ball = k.group(0, 0, 0, () => {
    k.ball(0, 0, 0, rad, rad, rad, 0xb8bcc8);
    for (let i = 0; i < 40; i++) {
      const v = 1 - (2 * (i + 0.5)) / 40, s = Math.sqrt(1 - v * v), a = i * 2.39996;
      facets.push(k.box(Math.cos(a) * s * rad * 1.01, v * rad * 1.01 - 0.03, Math.sin(a) * s * rad * 1.01, rad * 0.16, rad * 0.12, rad * 0.16, dim));
    }
  });
  ball.position.set(x, y, z);
  k.cyl(x, y + rad * 0.9, z, 0.012, H - y - rad * 0.9, 0x2a2a2a);
  const dotMat = k.glow(0xffffff, 0.9), dotTint = k.glow(0xffd8f0, 0.8);
  const dots = k.group(x, z, 0, () => {
    for (let i = 0; i < nDots; i++) {
      const a = r() * 6.28, d = 1 + Math.sqrt(r()) * spread;
      k.box(Math.cos(a) * d, 0.026, Math.sin(a) * d, 0.13, 0.003, 0.13, r() < 0.3 ? dotTint : dotMat, r() * 3);
    }
  });
  k.animate.push((t) => {
    ball.rotation.y = t * 0.55; dots.rotation.y = t * 0.55;
    for (let i = 0; i < facets.length; i++) {
      const s = Math.sin(t * 2.7 + i * 2.3) + Math.sin(t * 1.3 + i * 0.7);
      facets[i].material = s > 1.55 ? bright : s > 1.2 ? tint : dim;
    }
  });
}

// ---- bowling ---------------------------------------------------------------------------------

const LANE = 1.05, GUT = 0.24, CAP = 0.14, PITCH = LANE + 2 * GUT + CAP, LEN = 18.29, LANE_Y = 0.015, BALL_R = 0.109;
/** the head pin's spot down the lane (the foul line at z 0, the lanes running toward -z) */
const HEAD = -LEN;
/** the ten pins: the head pin nearest, rows of one to four going back */
const PINS: [number, number][] = [];
for (let row = 0; row < 4; row++) for (let i = 0; i <= row; i++) PINS.push([(i - row / 2) * 0.305, -row * 0.264]);
const PIN_ROW = [0, 1, 1, 2, 2, 2, 3, 3, 3, 3];
const BALLS = [0x1f4fd0, 0xd02f6a, 0x2f9a4a, 0x7a3fc0, 0xe08a1a, 0x1a1a1a, 0xb8b8c4, 0x10a0b0, 0xc02020];
const NEON: [number, number][] = [[0xff3fa4, 0x32e6ff], [0xffb02e, 0x8a5bff], [0x3dff8f, 0xff4fd8], [0x47a3ff, 0xffe14a]];

/** one lane's turns: every T seconds a ball is released at `at` and the pins are cleared and set again */
interface Lane { x: number; seed: number; T: number; ph: number; at: number; pins: Object3D[]; ball: Object3D; sweep: Mesh }
const laneNow = (l: Lane, t: number) => { const s = (t + l.ph) / l.T, n = Math.floor(s); return { n, u: (s - n) * l.T }; };
const rollOf = (l: Lane, n: number) => 2.3 + hash2(l.seed, n * 5 + 1) * 0.6;
/** where the ball meets the pins across the lane: the pocket, just right of the head pin, is 0.07 */
const lineOf = (l: Lane, n: number) => 0.07 + (hash2(l.seed, n * 5 + 2) - 0.5) * 0.3;
const strikeOf = (l: Lane, n: number) => Math.abs(lineOf(l, n) - 0.07) < 0.045;
const pinFalls = (l: Lane, n: number, i: number) => strikeOf(l, n) || hash2(l.seed, n * 31 + i + 100) < 0.95 - Math.abs(PINS[i][0] - lineOf(l, n)) * 1.3;

/** a lane this frame: the ball rolls down with a hook, the pins fly, the sweep clears the deck and the rack lowers a new set */
function laneTick(l: Lane, t: number) {
  const { n, u } = laneNow(l, t);
  const roll = rollOf(l, n), hit = l.at + roll, end = lineOf(l, n), s0 = 0.17 + hash2(l.seed, n * 5 + 3) * 0.12;
  const b = l.ball;
  b.visible = u >= l.at && u < hit + 0.9;
  if (b.visible) {
    if (u < hit) {
      const f = (u - l.at) / roll, g = f * (1.15 - 0.15 * f);
      b.position.set(l.x + s0 + 0.12 * Math.sin(Math.PI * g) + (end - s0) * g * g, LANE_Y + BALL_R, -0.25 + (HEAD + 0.25) * g);
      b.rotation.set(-(g * LEN) / BALL_R, 0.3, 0);
    } else b.position.set(l.x + end, LANE_Y + BALL_R, HEAD - ((u - hit) / 0.9) * 1.5);
  }
  const sweepDown = hit + 1.5, sweepBack = hit + 1.9, rackDown = hit + 2.5, rackSet = hit + 3.0, lift = hit + 3.4;
  const zs = HEAD + 0.35 - 1.65 * ease((u - sweepBack) / (rackDown - sweepBack));
  const ys = u < sweepDown ? 0.95 : u < sweepBack ? 0.95 - 0.93 * ease((u - sweepDown) / 0.4) : u < rackDown ? 0.02 : 0.02 + 0.93 * ease((u - rackDown) / (lift - rackDown));
  l.sweep.position.set(l.x, ys, u < sweepBack ? HEAD + 0.35 : zs);
  for (let i = 0; i < 10; i++) {
    const p = l.pins[i], x0 = l.x + PINS[i][0], z0 = HEAD + PINS[i][1];
    p.visible = true;
    if (u >= rackDown) { p.position.set(x0, LANE_Y + 0.75 * (1 - ease((u - rackDown) / (rackSet - rackDown))), z0); p.rotation.set(0, 0, 0); continue; }
    const tau = u - hit - PIN_ROW[i] * 0.05;
    if (tau <= 0 || !pinFalls(l, n, i)) { p.position.set(x0, LANE_Y, z0); p.rotation.set(0, 0, 0); }
    else {
      const h1 = hash2(l.seed, n * 41 + i), h2 = hash2(l.seed, n * 43 + i), h3 = hash2(l.seed, n * 47 + i);
      let dx = PINS[i][0] - end + (h1 - 0.5) * 0.7, dz = -0.7 - h2 * 0.9;
      const m = Math.hypot(dx, dz); dx /= m; dz /= m;
      const dist = 0.3 + h3 * 1.1, f = 1 - (1 - Math.min(1, tau / 0.6)) ** 2, tilt = Math.min(Math.PI / 2, tau * 7);
      p.position.set(Math.max(l.x - 0.8, Math.min(l.x + 0.8, x0 + dx * dist * f)),
        LANE_Y + Math.sin(Math.min(1, tau / 0.45) * Math.PI) * (0.04 + 0.16 * h1) + 0.055 * Math.sin(tilt), Math.max(HEAD - 1.35, z0 + dz * dist * f));
      p.rotation.set(0, Math.atan2(dz, -dx) + (h2 - 0.5) * 6 * f, tilt);
    }
    // the sweep pushes whatever is on the deck back into the pit as it passes
    if (u >= sweepBack && zs < p.position.z + 0.05) p.visible = false;
  }
}

/** a bowler's turn on their lane (release at 3.4 s): up from the settee to the stance, the approach, the release, watching, and back to sit */
function bowlerPose(b: Body, u: number, hit: number, x: number, sx: number, sz: number, sy: number) {
  const st = 3.25, line = 0.42;
  const walk = (f: number, x0: number, z0: number, x1: number, z1: number, sw: number) => {
    const e = clamp01(f);
    b.x = x0 + (x1 - x0) * e; b.z = z0 + (z1 - z0) * e; b.y = 0; b.swing = sw; b.pose = 0;
    b.yaw = Math.atan2(-(z1 - z0), x1 - x0);
  };
  if (u > hit + 2.9) { b.x = sx; b.z = sz; b.y = sy; b.yaw = Math.PI / 2; b.swing = 0; b.pose = 0; }
  else if (u < 1.4) walk(u / 1.4, sx, sz - 0.5, x, st, 0.45);
  else if (u < 1.9) { walk(1, sx, sz - 0.5, x, st, 0); b.yaw = Math.PI / 2; b.pose = -0.3; }
  else if (u < 3.4) { walk((u - 1.9) / 1.5, x, st, x, line, 0.65); b.pose = u > 3.0 ? -0.8 : 0; }
  else if (u < hit + 0.8) { b.x = x; b.z = line; b.y = 0; b.swing = 0; b.pose = 0; b.yaw = Math.PI / 2 + 0.2 * Math.sin((u - 3.4) * 1.8); }
  else walk((u - hit - 0.8) / 2.0, x, line, sx, sz - 0.5, 0.45);
}

/** bowling: at the head of your lane, taking turns with a friend; the ball hooks into the pocket, the pins fly, the score goes up overhead */
const bowling: RoomBuilder = (k, c) => {
  const S = seedOf(c), r = rng(S ^ 0xb0b1);
  const league = eventOn(c, 'bowling');
  const N = 8, L = 2 + Math.floor(r() * 4), lx = (i: number) => (i - L) * PITCH;
  const H = 3.6, zFar = HEAD - 1.6, zNear = 8.8, xL = lx(0) - PITCH / 2, xR = lx(N - 1) + PITCH / 2, xc = (xL + xR) / 2, W = xR - xL + 2.6;
  const [n0, n1] = pick(r, NEON);
  k.group(xc, (zFar + zNear) / 2, 0, () => k.shell(W, zNear - zFar, H, pick(r, [0x1c1830, 0x14202e, 0x241626, 0x1a1a22]), pick(r, [0x2a1f4a, 0x1f2a4a, 0x3a1f3a, 0x223a3a]), 0x0e0e16, -1));
  // the approach, the foul line, the lanes with their gutters, the cappings between them
  k.box(xc, 0, 2.3, xR - xL, 0.012, 4.6, 0xe2c08c);
  k.box(xc, 0.012, 0, xR - xL, 0.004, 0.04, 0x1a1a1a);
  const wood = pick(r, [0xd9a96a, 0xe0b47a, 0xcf9c5e]);
  for (let i = 0; i <= N; i++) k.box(xL + i * PITCH, 0, -(LEN + 1.05) / 2, CAP, 0.07, LEN + 1.05, 0x30343e);
  for (let i = 0; i < N; i++) {
    const x = lx(i);
    k.box(x, 0, -(LEN - 0.45) / 2, LANE, LANE_Y, LEN - 0.45, wood);
    k.box(x, 0, HEAD - 0.3, LANE, LANE_Y, 1.5, 0xf0dcb0);
    for (const s of [-1, 1]) {
      k.box(x + s * 0.27, LANE_Y, -(LEN - 0.45) / 2, 0.1, 0.004, LEN - 0.45, 0xedc994);
      k.box(x + (s * (LANE + GUT)) / 2, 0, -(LEN + 1.05) / 2, GUT, 0.006, LEN + 1.05, 0x22242c);
    }
  }
  // the arrows and the approach dots on your lane
  for (let i = -3; i <= 3; i++) {
    k.box(i * 0.13, LANE_Y, -4.9 + Math.abs(i) * 0.15, 0.04, 0.004, 0.04, 0x5a3a1e, Math.PI / 4);
    k.cyl(i * 0.15, 0.012, 2.0, 0.012, 0.004, 0x5a3a1e);
  }
  // the masking unit over the pin decks, its neon, the pin light at its foot, the pit and its curtain
  const mz = HEAD + 0.6, g0 = k.glow(n0, 1.3), g1 = k.glow(n1, 1.3), plate = k.glow(0xf4f0e0, 0.9);
  k.box(xc, 0.78, mz - 1.1, W, H - 0.78, 2.2, 0x15151f);
  k.box(xc, 0.74, mz - 0.06, W, 0.04, 0.12, k.glow(0xfff6e0, 1.6));
  k.box(xc, 0, HEAD - 1.5, W, 0.78, 0.08, 0x060608);
  k.box(xc, 0, HEAD - 1.28, W, 0.004, 0.45, 0x0a0a0e);
  for (let i = 0; i < N; i++) {
    const x = lx(i), a = i % 2 ? g0 : g1, b = i % 2 ? g1 : g0;
    k.box(x, 1.2 + (i % 2) * 0.2, mz, PITCH * 0.9, 0.07, 0.03, a);
    k.box(x, 1.75 + (i % 2) * 0.15, mz, PITCH * 0.55, 0.05, 0.03, b);
    k.box(x, 2.3, mz, 0.36, 0.36, 0.03, plate);
  }
  // the pins and a ball for every lane: yours in detail
  const white = k.mat(0xf7f5ef), red = k.mat(0xc8202a);
  const T0 = 10.6 + r() * 1.2, lanes: Lane[] = [];
  for (let i = 0; i < N; i++) {
    const x = lx(i), mine = i === L, bc = pick(r, BALLS);
    const pins = PINS.map(([px, pz]) => k.group(x + px, HEAD + pz, 0, () => {
      if (mine) { k.ball(0, 0.13, 0, 0.06, 0.12, 0.06, white); k.cyl(0, 0.22, 0, 0.026, 0.1, white); k.ball(0, 0.335, 0, 0.038, 0.048, 0.038, white); k.cyl(0, 0.235, 0, 0.029, 0.03, red); }
      else k.ball(0, 0.19, 0, 0.056, 0.19, 0.056, white);
    }));
    const ball = mine ? k.group(0, 0, 0, () => {
      k.ball(0, 0, 0, BALL_R, BALL_R, BALL_R, bc);
      for (const [hx, hy, hz] of [[0.022, 0.1, 0.035], [-0.022, 0.1, 0.035], [0, 0.088, -0.05]]) k.ball(hx, hy, hz, 0.014, 0.014, 0.014, 0x0a0a0a);
    }) : k.ball(0, 0, 0, BALL_R, BALL_R, BALL_R, bc);
    const sweep = k.box(x, 0.95, HEAD + 0.35, LANE + 0.3, 0.22, 0.06, 0x2a2a32);
    lanes.push({ x, seed: (hash2(S, 300 + i) * 1e6) | 0, T: mine ? T0 : 10.6 + r() * 3.5, ph: mine ? 0 : r() * 20, at: 3.4, pins, ball, sweep });
  }
  k.animate.push((t) => { for (const l of lanes) laneTick(l, t); });
  const our = lanes[L];
  // your party: one bowls with you, the rest wait on the settee; bumpers up when a child came along
  const mates = companions(c, 3);
  const crew = party(c, r, 3, 20);
  if (mates.some((m) => m.child)) for (const s of [-1, 1]) k.box(s * (LANE / 2 + 0.05), 0, -(LEN - 1) / 2 - 0.4, 0.06, 0.13, LEN - 1.4, 0x2a7ad8);
  // per pair of lanes: the ball return, the settee and its table, the score screen overhead
  const retX = (p: number) => (lx(2 * p) + lx(2 * p + 1)) / 2, ourPair = Math.floor(L / 2), side = Math.sign(retX(ourPair));
  const sofa = pick(r, [0x7a1f3a, 0x1f4a7a, 0x3a2a6a, 0x1f6a5a]);
  const dim = k.glow(0x1a2a5a, 1), lit = k.glow(0x8fe0ff, 1.1), gold = k.glow(0xffcf3a, 1.4), cur = k.glow(0xffffff, 1.5), bg = k.glow(0x0a1440, 1);
  const cells: Mesh[][] = [[], []], bars: { m: Mesh; l: Lane }[] = [];
  for (let p = 0; p < N / 2; p++) {
    const px = retX(p), ours = p === ourPair;
    k.box(px, 0, 1.9, 0.5, 0.55, 0.9, 0x2a2e3a);
    k.ball(px, 0.55, 1.9, 0.25, 0.14, 0.45, 0x2a2e3a);
    k.box(px, 0, 2.95, 0.42, 0.5, 1.2, 0x3a3e4a);
    for (let b = 0; b < 3; b++) k.ball(px, 0.5 + BALL_R, 2.6 + b * 0.25, BALL_R, BALL_R, BALL_R, pick(r, BALLS));
    k.box(px, 0, 5.45, 3.0, 0.45, 0.65, sofa); k.box(px, 0, 5.85, 3.0, 0.95, 0.18, sofa);
    k.cyl(px, 0, 4.5, 0.32, 0.48, 0x2a2a30);
    if (r() < 0.7) k.cyl(px + (r() - 0.5) * 0.3, 0.48, 4.5 + (r() - 0.5) * 0.2, 0.04, 0.14, k.glow(pick(r, [0xd8a030, 0xc02a2a, 0xf4f0e8]), 0.6));
    const g = k.group(px, 0.4, 0, () => {
      k.box(0, 0.38, -0.02, 0.05, H - 2.62 - 0.38, 0.05, 0x2a2a30);
      k.box(0, -0.42, -0.06, 1.5, 0.84, 0.08, 0x111116);
      k.panel(0, 0, -0.015, 1.4, 0.74, bg);
      for (let row = 0; row < 2; row++) {
        if (ours) {
          k.panel(-0.6, 0.12 - row * 0.28, -0.01, 0.15, 0.2, row ? g1 : g0);
          for (let f = 0; f < 10; f++) cells[row].push(k.panel(-0.395 + f * 0.112, 0.12 - row * 0.28, -0.01, 0.1, 0.2, dim));
        } else bars.push({ m: k.panel(-0.62, 0.12 - row * 0.28, -0.01, 1.2, 0.18, row ? g1 : lit), l: lanes[2 * p + row] });
      }
    });
    g.position.y = 2.62; g.rotation.x = 0.25;
  }
  // the score: a frame for each of you, a cell filled as each ball is bowled, gold for a strike and a flash on the screen
  k.animate.push((t) => {
    const { n, u } = laneNow(our, t), hit = our.at + rollOf(our, n);
    const turn = mod(n, 20), frame = Math.floor(turn / 2), who = turn % 2, done = u > hit + 0.6;
    for (let row = 0; row < 2; row++) for (let f = 0; f < 10; f++) {
      const played = f < frame || (f === frame && (row < who || (row === who && done)));
      cells[row][f].material = !played ? (f === frame && row === who && Math.sin(t * 6) > 0 ? cur : dim) : strikeOf(our, n - turn + f * 2 + row) ? gold : lit;
    }
    if (strikeOf(our, n) && u > hit + 0.3 && u < hit + 2.6) bg.color.setHex(Math.sin(t * 10) > 0 ? 0xc08010 : 0xa01860);
    for (const b of bars) { const s = laneNow(b.l, t), w = 0.12 + (1.08 * (mod(s.n, 10) + (s.u > b.l.at + 3 ? 1 : 0))) / 10; b.m.scale.x = w; b.m.position.x = -0.62 + w / 2; }
  });
  // your friend bowls every other turn; the others sit on your side of the settee
  const seatX = (j: number) => retX(ourPair) - side * (0.35 + 0.5 * j), seatZ = 5.38;
  const friend = crew[0], fy = seatY(friend, 0.45);
  const pal: Body = { look: friend, x: seatX(0), y: fy, z: seatZ, yaw: Math.PI / 2, swing: 0, pose: 0, ph: 3,
    move: (t, b) => {
      const { n, u } = laneNow(our, t);
      if (n % 2 === 0) { b.x = seatX(0); b.z = seatZ; b.y = fy; b.yaw = Math.PI / 2; b.swing = 0; b.pose = 0; }
      else bowlerPose(b, u, our.at + rollOf(our, n), 0.12, seatX(0), seatZ, fy);
    } };
  k.bodies.push(pal);
  for (let j = 1; j < 3; j++) bob(k, crew[j], seatX(j), seatY(crew[j], 0.45), seatZ, Math.PI / 2 + (r() - 0.5) * 0.3, 0.015, 1.3 + r(), r() * 6, crew[j].phone && r() < 0.3 ? 1 : 0);
  // the other lanes: one or two bowlers taking turns, someone watching now and then; team shirts on league night
  const team = [pick(r, BRIGHT), pick(r, BRIGHT), pick(r, BRIGHT), pick(r, BRIGHT)];
  let slot = 40;
  for (let i = 0; i < N; i++) {
    if (i === L) continue;
    const l = lanes[i], p = Math.floor(i / 2), px = retX(p), s = i % 2 ? 1 : -1;
    const nb = league || r() < 0.65 ? 2 : 1;
    for (let j = 0; j < nb; j++) {
      let look = visitor(c, slot++, crowdStage(r, 0.2, 0.15));
      if (league) look = dressed(look, team[i % 4]);
      const sx = px + s * (0.4 + 0.7 * j), sy = seatY(look, 0.45);
      k.bodies.push({ look, x: sx, y: sy, z: seatZ, yaw: Math.PI / 2, swing: 0, pose: 0, ph: slot,
        move: (t, b) => {
          const { n, u } = laneNow(l, t);
          if (n % nb !== j) { b.x = sx; b.z = seatZ; b.y = sy; b.yaw = Math.PI / 2; b.swing = 0; b.pose = 0; }
          else bowlerPose(b, u, l.at + rollOf(l, n), l.x + 0.12, sx, seatZ, sy);
        } });
    }
    if (r() < (league ? 0.6 : 0.3)) { const look = visitor(c, slot++, crowdStage(r, 0.3, 0.2)); k.sit(look, px + s * 1.25, seatZ, 0.45, Math.PI / 2, look.phone ? 1 : 0, slot); }
  }
  // the snack bar and shoe counter at the back, neon along the walls, downlights over the lanes
  k.box(xc, 0, 7.7, 5, 1.05, 0.7, 0x2a2a34); k.box(xc, 0.3, 7.34, 4.8, 0.08, 0.02, g0); k.box(xc, 1.05, 7.7, 5.2, 0.05, 0.8, 0x1a1a1e);
  k.stand(staff(c, 1), xc + 0.8, 8.3, Math.PI / 2, 0, 1);
  for (const s of [-1, 1]) {
    k.box(xc + s * (W / 2 - 0.03), 2.6, -6, 0.04, 0.06, 26, s < 0 ? g0 : g1);
    k.box(xc + s * (W / 2 - 0.03), 0.9, -6, 0.04, 0.04, 26, s < 0 ? g1 : g0);
  }
  k.box(xc, H - 0.06, 0.9, xR - xL, 0.05, 0.05, g1);
  const down = k.glow(0xfff2dc, 1.2);
  for (let p = 0; p < N / 2; p++) for (const z of [-15, -10, -5, 2]) k.box(retX(p), H - 0.03, z, 0.5, 0.03, 0.5, down);
  hallLights(k, 0.5, 0.45, 0xe8e0ff, 0x3a3048);
  k.ceil.position.set(0, H - 0.3, 2.5); k.ceil.userData.max = 8; k.ceilOn = 1;
  k.lamp.position.set(0, 0.7, HEAD + 0.3); k.lamp.userData.max = 3.5; k.lamp.color.set(0xfff4e0); k.lampOn = 1;
  // you: waiting by the ball return, then your turn: up the approach, the slide and release, watching it go, back again
  const eh = eyeStanding(c);
  const Wp = new Vector3(-0.7 * side, eh, 3.15), Sp = new Vector3(0.06, eh, 3.0), Fp = new Vector3(0.06, eh, 0.5);
  const pinsAt = new Vector3(0, 0.25, HEAD - 0.3), board = new Vector3(retX(ourPair), 2.62, 0.4), sofaAt = new Vector3(seatX(1), 1.0, seatZ);
  const head = smoother(3.2), tgt = new Vector3();
  return {
    eye: Wp.clone(), aim: pinsAt.clone(), glances: [], label: league ? 'bowling at league night' : 'bowling',
    move: (t, e) => {
      const { n, u } = laneNow(our, t), hit = our.at + rollOf(our, n), mine = n % 2 === 0;
      let dp = 0, roll = 0;
      if (!mine || u < 1.0) e.copy(Wp);
      else if (u < 1.6) e.lerpVectors(Wp, Sp, ease((u - 1.0) / 0.6));
      else if (u < 3.4) {
        const f = (u - 1.6) / 1.8, crouch = ease((u - 2.9) / 0.5);
        e.lerpVectors(Sp, Fp, f * (1.3 - 0.3 * f));
        e.y = eh + 0.02 * Math.sin(f * Math.PI * 7) - 0.45 * crouch; dp = -0.35 * crouch;
      } else if (u < 4.2) { const up = 1 - ease((u - 3.4) / 0.8); e.copy(Fp); e.y = eh - 0.45 * up; dp = -0.35 * up; }
      else if (u < hit + 1.4) { e.copy(Fp); if (u < hit) roll = -0.05 * Math.sin((Math.PI * (u - 3.4)) / (hit - 3.4)); }
      else if (u < hit + 3.6) e.lerpVectors(Fp, Wp, ease((u - hit - 1.4) / 2.2));
      else e.copy(Wp);
      tgt.copy(pinsAt);
      if (!mine && u > 0.1 && u < 1.9) tgt.set(pal.x, 1.2, pal.z);
      else if (u > hit + 0.9 && u < hit + 2.4) tgt.copy(board);
      else if (!mine && n % 6 === 1 && u > hit + 3.0 && u < hit + 5.2) tgt.copy(sofaAt);
      const h = head(t, viewYaw(e, tgt), viewPitch(e, tgt) + dp);
      return { yaw: h.yaw, pitch: h.pitch, roll };
    },
  };
};

// ---- the ice rink ----------------------------------------------------------------------------

/** skating round the ice with the crowd under the arched roof; the café gallery at one end; coloured lights at the ice disco */
const icerink: RoomBuilder = (k, c) => {
  const S = seedOf(c), r = rng(S ^ 0x1ce);
  const disco = /disco/.test(c.info.activity);
  const RX = 25, RZ = 13, RC = 8, HW = 66, HD = 42, WALL = 7;
  // the hall: rubber matting, walls, and a barrel roof
  k.box(0, -0.1, 0, HW, 0.1, HD, 0x34363c);
  const wall = pick(r, [0x5a6e86, 0x6a7a8a, 0x4a5a72]);
  for (const s of [-1, 1]) { k.box((s * HW) / 2, 0, 0, 0.3, 14.5, HD, wall); k.box(0, 0, (s * HD) / 2, HW, WALL, 0.3, wall); }
  const R = (21 * 21 + 49) / 14, yc = 14 - R, half = Math.asin(21 / R);
  for (let i = 0; i < 10; i++) {
    const a = -half + (i + 0.5) * (half / 5);
    const m = k.box(0, 0, 0, HW, 0.25, 2 * R * Math.sin(half / 10) + 0.12, i % 2 ? 0xc8ccd2 : 0xbcc2ca);
    m.position.set(0, yc + R * Math.cos(a), R * Math.sin(a)); m.rotation.x = a;
  }
  const lamp = k.glow(0xf4f8ff, 1.7);
  for (const z of [-9, 0, 9]) {
    k.box(0, 11.2, z, HW - 4, 0.35, 0.35, 0x4a4e58);
    for (let i = 0; i < 5; i++) k.box(-24 + i * 12, 10.95, z, 2.4, 0.18, 0.7, lamp);
  }
  // banners hung along the side walls
  for (let i = 0; i < 8; i++) { const s = i % 2 ? 1 : -1; k.box(-21 + i * 6, 3.4, s * (HD / 2 - 0.2), 1.6, 2.4, 0.04, pick(r, BRIGHT)); }
  // the ice, its painted lines and circles
  const ice = rinkFloor(k, RX, RZ, RC, 0xe4eef5, 0.3);
  const red = k.mat(0xc8303a), blue = k.mat(0x2a5ac8), Y = 0.02;
  const ring = (x: number, z: number, col: ReturnType<Kit['mat']>) => { k.cyl(x, Y, z, 4.5, 0.003, col); k.cyl(x, Y + 0.003, z, 4.42, 0.003, ice); k.cyl(x, Y + 0.009, z, 0.3, 0.002, col); };
  ring(0, 0, blue);
  for (const s of [-1, 1]) for (const sz of [-1, 1]) ring(s * 15.5, sz * 6.5, red);
  k.box(0, Y + 0.006, 0, 0.3, 0.003, 2 * RZ - 0.3, red);
  for (const s of [-1, 1]) { k.box(s * 7.6, Y + 0.006, 0, 0.3, 0.003, 2 * RZ - 0.3, blue); k.box(s * 21, Y + 0.006, 0, 0.05, 0.003, 23.6, red); }
  // the boards round the rink, a coloured rail along the top, adverts on the straights
  const capC = pick(r, [0xd02a2a, 0x2a5ad0, 0xe0b020]);
  for (const [x, z, len, ry] of rinkEdge(RX, RZ, RC, 0.08, 6)) { k.box(x, 0, z, len, 1.07, 0.16, 0xf2f2ee, ry); k.box(x, 1.07, z, len, 0.05, 0.22, capC, ry); }
  const AD: [number, number][] = [[0xd02a2a, 0xffffff], [0x2a5ad0, 0xffd23a], [0x1a8a4a, 0xffffff], [0xffd23a, 0x1a1a1a], [0xffffff, 0xd02a2a], [0x7a2ad0, 0xffffff], [0xff7a1a, 0x1a3a6a]];
  for (const s of [-1, 1]) for (let i = 0; i < 8; i++) {
    const [a, b] = pick(r, AD), x = -14 + i * 4;
    k.box(x, 0.3, s * (RZ - 0.005), 3.4, 0.6, 0.02, a);
    if (r() < 0.6) k.box(x + (r() - 0.5) * 1.2, 0.45, s * (RZ - 0.012), 1.2 + r() * 0.6, 0.25, 0.02, b);
  }
  for (const s of [-1, 1]) for (const z of [-2.6, 2.6]) { const [a, b] = pick(r, AD); k.box(s * (RX - 0.005), 0.3, z, 0.02, 0.6, 4.2, a); k.box(s * (RX - 0.012), 0.45, z, 0.02, 0.25, 1.6, b); }
  // benches outside the boards, people lacing their skates
  for (const s of [-1, 1]) for (let i = 0; i < 2; i++) {
    const x = -10 + i * 20 + (r() - 0.5) * 4, z = s * (RZ + 1.4);
    k.box(x, 0, z, 3, 0.45, 0.45, 0x5a4a3a);
    if (r() < 0.8) k.sit(visitor(c, 200 + i * 2 + (s > 0 ? 1 : 0), crowdStage(r, 0.3, 0.2)), x + (r() - 0.5) * 2, z, 0.45, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0, i);
  }
  // the gallery café over the far end: glass balustrade, tables, warm lamps; the skate hire under it
  const gx = 28.2, warm = k.glow(0xffc880, 1.4), glass = seeThrough(k, 0xa8d8ff, 0.22);
  k.box(gx + 2.4, 3.4, 0, 4.8, 0.3, 30, 0x5a5048);
  for (let z = -14; z <= 14; z += 7) k.box(gx + 0.3, 0, z, 0.3, 3.4, 0.3, 0x6a6a70);
  k.box(gx + 0.05, 3.7, 0, 0.04, 1.0, 30, glass); k.box(gx + 0.05, 4.7, 0, 0.1, 0.06, 30, 0x8a8a90);
  for (let i = 0; i < 5; i++) {
    const z = -12 + i * 6 + (r() - 0.5);
    k.cyl(gx + 1.4, 3.7, z, 0.4, 0.75, 0x3a2a20); k.cyl(gx + 1.4, 6.2, z, 0.18, 0.22, warm);
    for (const s of [-1, 1]) if (r() < 0.75) {
      k.box(gx + 1.4 + s * 0.6, 3.7, z, 0.4, 0.46, 0.4, 0x2a2a2a);
      k.sit(visitor(c, 60 + i * 2 + (s > 0 ? 1 : 0), crowdStage(r, 0.2, 0.3)), gx + 1.4 + s * 0.6, z, 4.16, s > 0 ? Math.PI : 0, 0, i * 2);
    }
  }
  k.box(gx + 3.9, 3.7, 0, 0.6, 1.05, 6, 0x4a3a2a); k.box(gx + 3.59, 3.95, 0, 0.02, 0.5, 5.6, warm);
  k.stand(staff(c, 2), gx + 4.45, 0.6, Math.PI, 0, 2, 3.7);
  k.box(gx + 3.5, 0, -6, 0.8, 1.05, 5, 0x3a4a5a); k.box(gx + 3.08, 0.6, -6, 0.02, 0.3, 4.6, k.glow(0x9fd8ff, 1.2));
  k.stand(staff(c, 3), gx + 4.3, -6.5, Math.PI, 0, 3);
  // skaters going round, the way everyone goes; beginners clinging to the boards; little ones with penguin skate aids
  const RXv = 19, RZv = 8.5;
  skaters(k, c, r, RXv, RZv, [-7.6, -6.9, -6.2, -5.5, -4.8, -4.1, -3.4, -2.7, -2.0, 1.8, 2.4, 3.0], [1.8, 4.2], disco ? 3 : 2.4, 100, 0.05, 30);
  for (let i = 0; i < 4; i++) {
    const s = i % 2 ? 1 : -1, x0 = -12 + i * 7 + r() * 3;
    const b = lineWalker(k, sporty(visitor(c, 150 + i, crowdStage(r, 0.5, 0.1))), x0, s * (RZ - 0.42), x0 + 1.6 + r(), s * (RZ - 0.42), 0.12 + r() * 0.08, r(), 0.05);
    b.swing = 0.08;
  }
  for (let i = 0; i < 2; i++) {
    const rx = 10.7, rz = 3.93, sp = 0.6, ph = r() * 6.28 + i * 3, len = Math.PI * (rx + rz), w = -(sp / len) * Math.PI * 2;
    const peng = k.group(0, 0, 0, () => {
      k.ball(0, 0.36, 0, 0.2, 0.3, 0.2, 0x1a1a22); k.ball(0.09, 0.34, 0, 0.12, 0.22, 0.15, 0xf4f4f0); k.ball(0, 0.72, 0, 0.14, 0.14, 0.14, 0x1a1a22);
      k.cone(0.12, 0.72, 0, 0.04, 0.12, 0xf09a2a).rotation.z = -Math.PI / 2;
      k.box(-0.24, 0.3, 0, 0.04, 0.6, 0.36, 0xd02a2a);
    });
    const at = (t: number) => ph + t * w;
    k.bodies.push({ look: sporty(visitor(c, 160 + i, LifeStage.Child)), x: 0, y: 0.05, z: 0, yaw: 0, swing: 0.15, pose: 0, ph: i, move: (t, b) => {
      const a = at(t); b.x = Math.cos(a) * rx; b.z = Math.sin(a) * rz; b.yaw = Math.atan2(-(Math.cos(a) * rz * w), -Math.sin(a) * rx * w);
    } });
    k.animate.push((t) => {
      const a = at(t) + w * 1.0; peng.position.set(Math.cos(a) * rx, 0.02, Math.sin(a) * rz);
      peng.rotation.y = Math.atan2(-(Math.cos(a) * rz * w), -Math.sin(a) * rx * w);
    });
  }
  // you, with whoever came along skating beside you
  const loop = skateLoop(RXv, RZv, 3.3, r() * 6.28, eyeStanding(c) + 0.06, 0.95);
  companions(c, 2).forEach((m, i) => { const d = i === 0 ? -1.1 : 1.15; alongside(k, sporty(m.look), loop, RXv + d, RZv + 0.55 * d, -0.05 - 0.03 * i, 0.05, i * 5); });
  // the lights: bright and even for a session; dimmed, with a mirror ball and colours sweeping the ice at the disco
  const hall = hallLights(k, 0.62, 0.75, 0xf4f8ff, 0x8a9aa8, 0xf4f8ff, [0.2, -1, 0.3]);
  if (disco) {
    hall.hemi = 0.2; hall.sun = 0.12; hall.sky.set(0x8070ff);
    lamp.color.setHex(0x30303a);
    mirrorBall(k, r, 0, 9.5, 0, 0.7, 14, 22, 60);
    const spots: { m: Mesh; mat: MeshBasicMaterial; fx: number; fz: number; ph: number }[] = [];
    for (let i = 0; i < 10; i++) { const mat = seeThrough(k, 0xff40c0, 0.55, true); spots.push({ m: k.cyl(0, 0.026, 0, 1.6, 0.004, mat), mat, fx: 0.11 + r() * 0.12, fz: 0.13 + r() * 0.1, ph: r() * 6.28 }); }
    k.animate.push((t) => {
      lamp.color.setHex(0x30303a);
      for (const s of spots) {
        s.m.position.x = Math.sin(t * s.fx + s.ph) * 20; s.m.position.z = Math.sin(t * s.fz + s.ph * 2) * 9;
        s.mat.color.setHSL(mod(t * 0.05 + s.ph / 6.28, 1), 1, 0.5).multiplyScalar(0.8);
      }
      k.ceil.color.setHSL(mod(t * 0.03, 1), 0.9, 0.5);
    });
    k.ceil.position.set(0, 8, 0); k.ceil.distance = 40; k.ceil.userData.max = 120; k.ceilOn = 1;
  }
  return { eye: new Vector3(RXv, eyeStanding(c), 0), aim: new Vector3(0, 1, 0), glances: [], label: disco ? 'skating at the ice disco' : 'skating at the ice rink', move: loop.move };
};

// ---- the roller disco ------------------------------------------------------------------------

/** rolling round a maple floor under a mirror ball, the beams sweeping, the DJ on the stage */
const rollerdisco: RoomBuilder = (k, c) => {
  const S = seedOf(c), r = rng(S ^ 0x7011);
  const night = eventOn(c, 'rollerdisco');
  const W = 32, D = 21, H = 8;
  k.shell(W, D, H, pick(r, [0x2a1a3a, 0x1a1a3a, 0x301a2a]), 0x1a1424, 0x0c0a14, -1);
  // the floor: maple boards on a rounded rink, a low wall round it with a glowing top
  const RX = 11, RZ = 6.5, RC = 4.5;
  rinkFloor(k, RX, RZ, RC, 0xd8b080);
  for (let i = -5; i <= 5; i++) {
    const x = i * 1.8, ax = Math.max(0, Math.abs(x) - (RX - RC)), zm = RZ - RC + Math.sqrt(Math.max(0, RC * RC - ax * ax)) - 0.15;
    k.box(x, 0.02, 0, 0.04, 0.002, 2 * zm, 0xc0925e);
  }
  const pink = k.glow(0xff3fb4, 1.4), cyan = k.glow(0x30e0ff, 1.4), purple = k.glow(0xa050ff, 1.4);
  for (const [x, z, len, ry] of rinkEdge(RX, RZ, RC, 0.35, 5)) { k.box(x, 0, z, len, 0.95, 0.1, 0x3a2050, ry); k.box(x, 0.95, z, len, 0.05, 0.14, Math.abs(ry) < 0.01 || Math.abs(ry - Math.PI / 2) < 0.01 ? pink : cyan, ry); }
  // the mirror ball, the light rig and its beams
  mirrorBall(k, r, 0, 6.2, 0, 0.55, H, 9.5, 46);
  for (const z of [-3.6, 3.6]) k.box(0, 7.4, z, 20, 0.3, 0.3, 0x2a2a30);
  const tmp = new Vector3();
  const heads: { g: Group; m: MeshBasicMaterial; spot: Mesh; sm: MeshBasicMaterial; ph: number; hue: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const hx = -7.5 + i * 3, hz = i % 2 ? -3.6 : 3.6;
    k.box(hx, 7.0, hz, 0.4, 0.4, 0.4, 0x1a1a1e);
    const m = seeThrough(k, 0xff40c0, 0.16, true), sm = seeThrough(k, 0xff40c0, 0.5, true);
    const g = k.group(hx, hz, 0, () => k.cone(0, -7.0, 0, 0.75, 7.0, m));
    g.position.y = 7.0;
    heads.push({ g, m, spot: k.cyl(0, 0.03, 0, 0.75, 0.004, sm), sm, ph: r() * 6.28, hue: i / 6 });
  }
  // the stage at one end: the DJ at the decks, speakers, a wall of light behind
  const sx = -RX - 2.6;
  k.box(sx - 0.4, 0, 0, 3.4, 0.7, 8, 0x1a1420);
  k.box(sx + 0.7, 0.7, 0, 0.7, 1.05, 2.4, 0x101014); k.box(sx + 1.06, 0.95, 0, 0.02, 0.12, 2.2, pink); k.box(sx + 1.06, 1.25, 0, 0.02, 0.06, 2.2, cyan);
  const decks = [-0.5, 0.5].map((z) => k.cyl(sx + 0.7, 1.75, z, 0.17, 0.02, 0x2a2a2a));
  for (const s of [-1, 1]) { k.box(sx + 0.5, 0.7, s * 3.2, 0.7, 1.7, 0.7, 0x0a0a0c); for (const y of [1.2, 1.9]) k.ball(sx + 0.86, y, s * 3.2, 0.02, 0.22, 0.22, 0x3a3a40); }
  const dj = dressed(staff(c, 0), pick(r, [0xff3fb4, 0x30e0ff, 0xf4f4f0, 0x1a1a1a]));
  bob(k, dj, sx + 0.1, 0.7, 0, 0, 0.05, 3.6, 0, -0.5);
  const led: MeshBasicMaterial[] = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { const m = k.glow(0xff00ff, 1); led.push(m); k.box(-W / 2 + 0.06, 1.3 + j * 1.25, -3.4 + i * 1.36, 0.04, 1.15, 1.26, m); }
  // the snack bar at the far end, benches along the walls, neon on the walls
  k.box(W / 2 - 0.6, 0, 0, 0.8, 1.05, 5, 0x2a1a30); k.box(W / 2 - 1.02, 0.4, 0, 0.02, 0.1, 4.6, cyan);
  k.stand(staff(c, 1), W / 2 - 0.25, 0.8, Math.PI, 0, 1);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const x = -6 + i * 12, z = s * (D / 2 - 0.6);
      k.box(x, 0, z, 3.4, 0.45, 0.5, 0x3a2a4a);
      for (let j = 0; j < 2; j++) if (r() < 0.7) k.sit(sporty(visitor(c, 200 + i * 4 + j * 2 + (s > 0 ? 1 : 0), crowdStage(r, 0.4, 0.05))), x - 0.8 + j * 1.6, z, 0.45, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0, i * 4 + j);
    }
    k.box(0, 2.6, s * (D / 2 - 0.03), W - 4, 0.06, 0.04, s > 0 ? pink : purple);
    k.box(0, 4.4, s * (D / 2 - 0.03), W - 4, 0.06, 0.04, cyan);
  }
  // the skaters: families, couples, kids, going round with the music
  const RXv = 7.4, RZv = 4.1;
  skaters(k, c, r, RXv, RZv, [-4.0, -3.3, -2.6, -1.9, -1.3, 1.3, 1.9, 2.5], [1.6, 3.4], night ? 3 : 2.5, 100, 0.06, 24);
  const loop = skateLoop(RXv, RZv, 2.7, r() * 6.28, eyeStanding(c) + 0.07, 0.85);
  companions(c, 2).forEach((m, i) => { const d = i === 0 ? -0.65 : 0.65; alongside(k, sporty(m.look), loop, RXv + d, RZv + 0.55 * d, -0.08 - 0.04 * i, 0.06, i * 5); });
  // the colours: pink, purple and cyan cycling on everything, the beams sweeping, the light wall pulsing to the beat
  const hall = hallLights(k, night ? 0.26 : 0.32, 0.2, 0xc080ff, 0x402060, 0xffb0e0);
  k.ceil.position.set(0, 6.5, 0); k.ceil.distance = 30; k.ceil.userData.max = 60; k.ceilOn = 1;
  k.lamp.position.set(sx + 1.5, 2.5, 0); k.lamp.userData.max = 8; k.lamp.distance = 14; k.lampOn = 1;
  k.tv.distance = 20;
  const hue = (h: number) => 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(Math.PI * 2 * h));
  k.animate.push((t) => {
    for (const h of heads) {
      h.g.rotation.x = 0.42 * Math.sin(t * 0.53 + h.ph); h.g.rotation.z = 0.42 * Math.sin(t * 0.41 + h.ph * 1.3);
      tmp.set(0, -1, 0).applyEuler(h.g.rotation);
      const k2 = 7.0 / Math.max(0.5, -tmp.y);
      h.g.scale.y = k2 / 7.0;
      h.spot.position.set(h.g.position.x + tmp.x * k2, 0.03, h.g.position.z + tmp.z * k2);
      h.m.color.setHSL(hue(h.hue + t * 0.04), 1, 0.5).multiplyScalar(0.45); h.sm.color.copy(h.m.color).multiplyScalar(2);
    }
    for (let i = 0; i < led.length; i++) led[i].color.setHSL(hue(t * 0.07 + (i % 6) * 0.08 + Math.floor(i / 6) * 0.1), 1, 0.5).multiplyScalar(0.6 + 0.6 * Math.max(0, Math.sin(t * Math.PI * 2 * 2 - i * 0.4)));
    for (const d of decks) d.rotation.y = t * 3.5;
    k.ceil.color.setHSL(hue(t * 0.05), 0.8, 0.55);
    k.lamp.color.setHSL(hue(t * 0.05 + 0.5), 0.9, 0.55);
    k.tv.position.set(Math.cos(t * 0.4) * 8, 3, Math.sin(t * 0.4) * 5); k.tv.color.setHSL(hue(t * 0.06 + 0.25), 1, 0.5); k.tv.intensity = 18;
    hall.sunCol.setHSL(hue(t * 0.03 + 0.1), 0.6, 0.7);
  });
  return { eye: new Vector3(RXv, eyeStanding(c), 0), aim: new Vector3(0, 1, 0), glances: [], label: night ? 'at the roller disco night' : 'at the roller disco', move: loop.move };
};

// ---- the climbing wall -------------------------------------------------------------------------

/** halfway up a route on a top rope: the holds before you, the rope up to the anchor, climbers either side, your belayer far below */
const climbing: RoomBuilder = (k, c) => {
  const S = seedOf(c), r = rng(S ^ 0xc11b);
  const comp = eventOn(c, 'climbing');
  const HW = 22, HD = 18, H = 16, Z0 = -1.4, TH = 0.1, TOP = 14;
  k.group(0, Z0 - 1 + HD / 2, 0, () => k.shell(HW, HD, H, 0xd8d8d0, 0x5a6a8a, 0x8a8e96, -1));
  /** a point on the wall face (x across, ly up the face, off out from it) in the room */
  const wallPt = (x: number, ly: number, off: number, out = new Vector3()) => out.set(x, ly * Math.cos(TH) - off * Math.sin(TH), Z0 + ly * Math.sin(TH) + off * Math.cos(TH));
  // the wall: panels leaning toward you, routes of coloured holds, a few big volumes; anchors along the top
  const routes = [0, -1.6, 1.7, -3.4, 3.5, -5.4, 5.5, -7.6, 7.8];
  const cols = routes.map(() => pick(r, [0xe8302a, 0x2a7ae8, 0x3ac04a, 0xf2c820, 0xe85ac8, 0xff8a1a, 0x8a4ae8, 0x1ac8c8, 0xf4f4f0, 0x2a2a2a]));
  const wg = k.group(0, Z0, 0, () => {
    for (let i = 0; i < 7; i++) k.box(-10 + (i + 0.5) * (20 / 7), 0, -0.15, 20 / 7 + 0.01, TOP + 0.3, 0.3, pick(r, [0x9aa4b0, 0x8a96a6, 0xb4b8bc, 0x6e7a8a, 0xa8b0a0, 0x9a8aa8]));
    k.box(0, TOP + 0.3, -0.25, 20.4, 0.25, 0.6, 0x5a5e66);
    routes.forEach((rx, ri) => {
      const near = Math.abs(rx) < 2, step = near ? 0.42 : 0.85, col = cols[ri];
      for (let ly = 0.3 + r() * 0.2; ly < TOP - 0.4; ly += step * (0.8 + r() * 0.4)) {
        const x = rx + (r() - 0.5) * 1.0, kind = r();
        if (kind < 0.45) k.ball(x, ly, 0.02, 0.07 + r() * 0.07, 0.05 + r() * 0.04, 0.05, col);
        else if (kind < 0.75) k.box(x, ly - 0.02, 0, 0.12 + r() * 0.08, 0.04, 0.06, col).rotation.z = (r() - 0.5) * 1.2;
        else if (kind < 0.9) k.ball(x, ly, 0.0, 0.13, 0.1, 0.045, col);
        else k.box(x, ly - 0.07, 0, 0.05, 0.14, 0.06, col).rotation.z = (r() - 0.5) * 0.8;
      }
      k.box(rx, TOP - 0.35, 0, 0.12, 0.2, 0.04, 0x8a8e96); k.ball(rx, TOP - 0.42, 0.05, 0.03, 0.05, 0.015, 0x3a3e46);
    });
    for (let i = 0; i < 8; i++) k.ball(-9 + r() * 18, 1.5 + r() * 11, 0, 0.35 + r() * 0.25, 0.3 + r() * 0.25, 0.18 + r() * 0.1, pick(r, [0x3a3e46, 0xe8e0d0, 0x2a5a8a, 0xc87a3a]));
  });
  wg.rotation.x = TH;
  // routes on the side walls too, and crash mats along the foot of the wall
  for (const s of [-1, 1]) {
    k.box(s * (HW / 2 - 0.15), 0, 6, 0.3, 12, 12, pick(r, [0x8a96a6, 0xa8b0a0]));
    for (let i = 0; i < 22; i++) k.ball(s * (HW / 2 - 0.3), 0.4 + r() * 11, 1 + r() * 10, 0.05, 0.07 + r() * 0.04, 0.07 + r() * 0.04, pick(r, BRIGHT));
  }
  k.box(0, 0, Z0 + 1.4, 20, 0.04, 2.2, 0x2a4a8a);
  // the roof: trusses and lights high over the hall
  const lights = k.glow(0xf4f6ff, 1.6);
  for (const z of [0.5, 4.5, 8.5, 12.5]) { k.box(0, 15.2, z, HW, 0.45, 0.45, 0x3a3e46); for (let i = 0; i < 4; i++) k.box(-7.5 + i * 5, 14.9, z, 1.4, 0.12, 0.45, lights); }
  // climbers on the routes either side, each with a belayer below and a rope through the anchor
  const ropeCols = [0xff6a1a, 0x1a8aff, 0x3ad04a, 0xe03ad0, 0xf2c820, 0x1ac8c8];
  const climbers: Body[] = [];
  const hz = Z0 + 2.6, P = 105, hv = new Vector3(), anchorTmp = new Vector3();
  for (let i = 0; i < 6; i++) {
    const x = routes[i + 1], top = 11.5 + r() * 1.8, ph = (i * P) / 6 + r() * 8, rope = ropeCols[i];
    const look = sporty(visitor(c, 300 + i, crowdStage(r, 0.25, 0.05)));
    const anchor = wallPt(x, TOP - 0.42, 0.08);
    const up = bar(k, wallPt(x, 1, 0.3), anchor, 0.011, rope);
    const belay = new Vector3(x + 0.6, 1.0, hz);
    bar(k, anchor, belay, 0.011, rope);
    k.stand(sporty(visitor(c, 320 + i, crowdStage(r, 0.05, 0.1))), x + 0.6, hz + 0.15, Math.PI / 2, -0.3, i);
    const body: Body = { look, x, y: 0, z: Z0 + 0.4, yaw: Math.PI / 2, swing: 0, pose: 0, ph: i * 3, move: (t, b) => {
      const u = mod(t + ph, P), climbT = ((top - 0.3) / 0.35) * 2.2, low = top / 0.9;
      let y = 0, moving = false, upNow = false;
      if (u < climbT) { const m = u / 2.2, j = Math.floor(m), f = m - j; y = 0.3 + 0.35 * (j + ease(f / 0.5)); moving = f < 0.5; upNow = true; }
      else if (u < climbT + 3) { y = top; upNow = true; }
      else if (u < climbT + 3 + low) y = top - (u - climbT - 3) * 0.9;
      wallPt(x, y / Math.cos(TH), y > 0.05 ? 0.3 : 0.6, hv);
      b.x = x + (y > 0.05 ? 0.06 * Math.sin(u * 1.3) : 0); b.y = Math.max(0, hv.y); b.z = hv.z;
      b.swing = moving ? 0.22 : 0; b.pose = upNow && y > 0.05 ? -0.8 : 0;
      setBar(up, anchorTmp.set(b.x, b.y + 0.95, b.z + 0.12), anchor, 0.011);
    } };
    k.bodies.push(body); climbers.push(body);
  }
  // people about on the floor: waiting their turn, chatting; spectators at the competition
  for (let i = 0; i < (comp ? 9 : 4); i++) {
    const look = sporty(visitor(c, 340 + i, crowdStage(r, 0.3, 0.1)));
    if (comp && i >= 3) k.sit(look, -6 + (i - 3) * 2.2 + r() * 0.6, 6 + r(), 0.12, Math.PI / 2, 0, i);
    else k.stand(look, -8 + r() * 16, 4 + r() * 6, r() * 6.28, look.phone ? 1 : 0, i);
  }
  // you: your belayer below, your rope up to the anchor; climbing a move at a time, then lowered off and up again
  const belayer = party(c, r, 1, 360, 0.05, 0.1)[0];
  k.stand(belayer, 0.55, hz, Math.PI / 2, -0.3, 9);
  const ropeCol = pick(r, ropeCols), myAnchor = wallPt(0, TOP - 0.42, 0.08), harness = new Vector3();
  const myRope = bar(k, wallPt(0, 5, 0.6), myAnchor, 0.011, ropeCol);
  bar(k, myAnchor, new Vector3(0.55, 1.0, hz - 0.15), 0.011, ropeCol);
  hallLights(k, 0.6, 0.75, 0xf4f6ff, 0x7a8aa0, 0xfff8f0, [0.15, -0.9, -0.6]);
  k.ceil.position.set(0, 13, 4); k.ceil.distance = 30; k.ceil.userData.max = 60; k.ceilOn = 1;
  const climbT = 70, CP = climbT + 4 + 7 / 0.8, ph0 = r() * CP, head = smoother(2.2), tv = new Vector3();
  const lookAtBody = (e: Vector3, b: Body) => { tv.set(b.x, b.y + 1.2, b.z); return [viewYaw(e, tv), viewPitch(e, tv)]; };
  return {
    eye: wallPt(0, 6, 1.1), aim: wallPt(0, 9, 0), glances: [], label: comp ? 'climbing in the bouldering competition' : 'climbing at the wall',
    move: (t, e) => {
      const u = mod(t + ph0, CP);
      let ly: number, lowering = false;
      if (u < climbT) { const m = u / 3.0, j = Math.floor(m), f = m - j; ly = 3.0 + 0.1 * (j + ease(f / 0.45)) * 3; }
      else if (u < climbT + 4) ly = 10;
      else { ly = Math.max(3, 10 - (u - climbT - 4) * 0.8); lowering = true; }
      const sway = 0.12 * Math.sin((u * Math.PI) / 3.0);
      wallPt(sway, ly, 1.1 + 0.04 * Math.sin(u * 0.7), e);
      setBar(myRope, harness.set(e.x + 0.05, e.y - 0.8, e.z - 0.35), myAnchor, 0.011);
      let ty = 0.12 * Math.sin(u * 0.21), tp = 0.85;
      if (lowering) { ty = 0.25; tp = -1.15; }
      else {
        const s = mod(u, 26);
        if (s > 7 && s < 10.5) [ty, tp] = lookAtBody(e, climbers[0]);
        else if (s > 16 && s < 18.5) { ty = 0.25; tp = -1.25; }
        else if (s > 19 && s < 22.5) [ty, tp] = lookAtBody(e, climbers[1]);
      }
      const h = head(t, ty, Math.max(-1.35, Math.min(1.1, tp)));
      return { yaw: h.yaw, pitch: h.pitch, roll: 0.03 * Math.sin((u * Math.PI) / 3.0) };
    },
  };
};

// ---- the trampoline park ---------------------------------------------------------------------

/** a lower hemisphere: a trampoline bed sagging under you (shared by every trampoline scene; never disposed, one small mesh) */
const DISH = new SphereGeometry(0.5, 20, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
/** one bounce after another: below 0 the bed is giving under the feet, above it you are in the air; each bounce its own height */
function bounce(t: number, P: number, ph: number, seed: number, hmax: number) {
  const s = t / P + ph, n = Math.floor(s), f = s - n, h = hmax * (0.65 + 0.35 * hash2(seed, n));
  if (f < 0.2) return -0.3 * Math.sin((Math.PI * f) / 0.2) * (0.5 + 0.5 * (h / hmax));
  const g = (f - 0.2) / 0.8;
  return 4 * h * g * (1 - g);
}

/** bouncing: a grid of beds with padded edges, children bouncing all round, the foam pit, the dodgeball court in its nets */
const trampoline: RoomBuilder = (k, c) => {
  const S = seedOf(c), r = rng(S ^ 0x7a3b);
  const family = eventOn(c, 'trampoline');
  const HW = 34, HD = 30, H = 9, Y = 0.5, zc = -4;
  k.group(0, zc, 0, () => k.shell(HW, HD, H, pick(r, [0xe8e4dc, 0xdfe8ee, 0xf0e6d8]), 0x5a6a7a, 0x3a3e46, -1));
  // the grid: six by four beds on a raised frame, padded strips between them; your bed sags as you land
  const cx = (i: number) => -7 + 2.8 * i, cz = (j: number) => 2 - 3.6 * j, MI = 2, MJ = 0;
  const bed = k.mat(0x1e3c8c);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) if (i !== MI || j !== MJ) k.box(cx(i), Y - 0.02, cz(j), 2.4, 0.02, 3.2, bed);
  const dishMat = k.mat(0x1e3c8d); dishMat.side = DoubleSide;
  const dish = new Mesh(DISH, dishMat); dish.position.set(cx(MI), Y, cz(MJ)); dish.scale.set(3.4, 0.04, 4.52); k.scene.add(dish);
  const padA = k.mat(pick(r, [0xd8302a, 0xe8502a, 0x2a9a4a])), padB = k.mat(0xf2c420);
  for (let j = 0; j <= 4; j++) k.box(0, 0, 3.8 - 3.6 * j, 17.2, Y + 0.1, 0.4, padA);
  for (let i = 0; i <= 6; i++) k.box(-8.4 + 2.8 * i, 0, -3.4, 0.4, Y + 0.105, 14.8, padB);
  // the foam pit beyond, across a padded walkway, full of coloured foam cubes
  k.box(0, 0, -11.3, 17.2, Y + 0.1, 1.0, padA);
  const fx = -2, fz = -14, fw = 8, fd = 4.2;
  for (const s of [-1, 1]) k.box(fx + s * (fw / 2 + 0.2), 0, fz, 0.4, Y + 0.1, fd + 0.8, padB);
  k.box(fx, 0, fz - fd / 2 - 0.2, fw + 0.8, Y + 0.1, 0.4, padB);
  k.box(fx, 0, fz, fw, 0.32, fd, 0x3a5aa8);
  const foam = [0xe8302a, 0xf2c420, 0x2a7ae8, 0x3ac04a, 0xf4f4f0, 0xe85ac8];
  for (let i = 0; i < 56; i++) {
    const m = k.box(fx + (r() - 0.5) * (fw - 0.3), 0.26 + r() * 0.14, fz + (r() - 0.5) * (fd - 0.3), 0.28, 0.28, 0.28, pick(r, foam), r() * 3);
    m.rotation.x = (r() - 0.5) * 0.8; m.rotation.z = (r() - 0.5) * 0.8;
  }
  // a child bouncing at the far edge, then the leap into the foam, wading out and round again
  const jumper = sporty(visitor(c, 400, LifeStage.Child)), jx = fx + 1 + r() * 2, JP = 10.5, jph = r() * JP;
  k.bodies.push({ look: jumper, x: jx, y: Y, z: -10.9, yaw: Math.PI / 2, swing: 0, pose: 0, ph: 1, move: (t, b) => {
    const u = mod(t + jph, JP);
    b.swing = 0; b.yaw = Math.PI / 2;
    if (u < 2) { b.x = jx; b.z = cz(3); b.y = Y + Math.max(-0.2, bounce(t, 1.0, 0, 7, 0.6)); }
    else if (u < 2.8) { const f = (u - 2) / 0.8; b.x = jx; b.z = cz(3) + (fz + 0.3 - cz(3)) * f; b.y = Y + (-0.25 - Y) * f + Math.sin(Math.PI * f) * 1.6; }
    else if (u < 3.4) { b.x = jx; b.z = fz + 0.3; b.y = -0.25 - 0.3 * ease((u - 2.8) / 0.6); }
    else if (u < 6.4) { const f = (u - 3.4) / 3; b.x = jx + (fx + fw / 2 + 0.3 - jx) * f; b.z = fz + 0.3; b.y = -0.55 + (Y + 0.1 + 0.55) * ease((f - 0.6) / 0.4); b.yaw = 0; b.swing = 0.3; }
    else { const f = (u - 6.4) / (JP - 6.4); b.x = fx + fw / 2 + 0.3 + (jx - fx - fw / 2 - 0.3) * f; b.z = fz + 0.3 + (cz(3) - fz - 0.3) * f; b.y = Y + 0.05; b.yaw = Math.atan2(-(cz(3) - fz), jx - fx - fw / 2 - 0.3); b.swing = 0.5; }
  } });
  // the dodgeball court off to the right: its own bed, padded edges and nets, two teams bouncing and throwing
  const dx = 12.6, dz = -5, dw = 5, dd = 10;
  k.box(dx, Y - 0.02, dz, dw, 0.02, dd, bed);
  for (const s of [-1, 1]) { k.box(dx + s * (dw / 2 + 0.2), 0, dz, 0.4, Y + 0.1, dd + 0.8, padA); k.box(dx, 0, dz + s * (dd / 2 + 0.2), dw, Y + 0.1, 0.4, padA); }
  const net = seeThrough(k, 0x101418, 0.32);
  for (const s of [-1, 1]) { k.box(dx + s * (dw / 2 + 0.4), Y + 0.1, dz, 0.02, 2.6, dd + 0.8, net); k.box(dx, Y + 0.1, dz + s * (dd / 2 + 0.4), dw + 0.8, 2.6, 0.02, net); }
  for (const sx of [-1, 1]) for (const sz of [-1, 0, 1]) k.box(dx + sx * (dw / 2 + 0.4), 0, dz + sz * (dd / 2 + 0.4), 0.08, Y + 2.7, 0.08, 0x2a2a30);
  k.box(dx, Y, dz, dw, 0.004, 0.08, 0xf4f4f0);
  const players: Body[] = [];
  for (let i = 0; i < 6; i++) {
    const s = i < 3 ? -1 : 1, x = dx + ((i % 3) - 1) * 1.4, z = dz + s * (2.2 + r() * 1.8), P = 1.0 + r() * 0.3, ph = r(), seed = 500 + i;
    const look = dressed(sporty(visitor(c, 410 + i, crowdStage(r, 0.8, 0))), s < 0 ? 0xd8302a : 0x2a7ae8);
    const b: Body = { look, x, y: Y, z, yaw: s < 0 ? -Math.PI / 2 : Math.PI / 2, swing: 0, pose: 0, ph: i, move: (t, bb) => { bb.y = Y + Math.max(-0.2, bounce(t, P, ph, seed, 0.5)); } };
    k.bodies.push(b); players.push(b);
  }
  const balls = [0, 1].map(() => k.ball(0, -1, 0, 0.11, 0.11, 0.11, 0xe8302a));
  const from = new Vector3(), to = new Vector3();
  k.animate.push((t) => balls.forEach((m, i) => {
    const T = 1.3 + i * 0.4, s = t / T + i * 0.37, n = Math.floor(s), f = s - n;
    const a = players[Math.floor(hash2(n, 3 + i) * 3) + (n % 2 ? 0 : 3)], b = players[Math.floor(hash2(n, 9 + i) * 3) + (n % 2 ? 3 : 0)];
    from.set(a.x, a.y + 1.0, a.z); to.set(b.x, b.y + 0.9, b.z);
    m.position.lerpVectors(from, to, f); m.position.y += Math.sin(Math.PI * f) * 0.8;
  }));
  // children (and on the family bounce, their parents) bouncing on the other beds, each to their own rhythm
  const mates = companions(c, 2);
  const taken = new Set([`${MI},${MJ}`, `${Math.round((jx + 7) / 2.8)},3`]);
  const bouncer = (look: Look, i: number, j: number, seed: number, hmax: number) => {
    taken.add(`${i},${j}`);
    const x = cx(i) + (r() - 0.5) * 0.8, z = cz(j) + (r() - 0.5) * 1.2, P = 0.95 + r() * 0.35, ph = r(), spin = r() < 0.3 ? (r() - 0.5) * 2 : 0, yaw0 = r() * 6.28;
    k.bodies.push({ look, x, y: Y, z, yaw: yaw0, swing: 0, pose: 0, ph: seed, move: (t, b) => {
      const h = bounce(t, P, ph, seed, hmax); b.y = Y + h; b.swing = h > 0.2 ? 0.12 : 0;
      b.yaw = yaw0 + spin * t + 0.3 * Math.sin(t * 0.3 + seed);
    } });
  };
  mates.forEach((m, i) => bouncer(sporty(m.look), MI + (i ? 1 : -1), MJ, 600 + i, m.child ? 0.6 : 0.8));
  for (let n = 0; n < 14; n++) {
    const i = Math.floor(r() * 6), j = Math.floor(r() * 4);
    if (taken.has(`${i},${j}`)) continue;
    const adult = family && r() < 0.35, look = sporty(visitor(c, 420 + n, adult ? LifeStage.Adult : crowdStage(r, 0.85, 0)));
    bouncer(look, i, j, 700 + n, adult ? 0.7 : 0.45 + r() * 0.35);
  }
  // the marshal on the floor beside the grid in a high-vis top, parents on the benches at the front
  const marshal = lineWalker(k, hiVis(staff(c, 1)), -9.4, 3.5, -9.4, -9.5, 0.45, r());
  marshal.swing = 0.25;
  for (let i = 0; i < 3; i++) {
    const x = -6 + i * 5;
    k.box(x, 0, 6.2, 2.6, 0.45, 0.5, 0x3a4a5a);
    for (let j = 0; j < 2; j++) if (r() < 0.75) { const look = visitor(c, 440 + i * 2 + j, crowdStage(r, 0.1, 0.3)); k.sit(look, x - 0.6 + j * 1.2, 6.2, 0.45, Math.PI / 2, look.phone && r() < 0.5 ? 1 : 0, i * 2 + j); }
  }
  // murals of big colour on the walls, strip lights in the roof
  for (let i = 0; i < 5; i++) k.box(-12 + i * 6, 1.5 + r() * 2, zc - HD / 2 + 0.06, 3 + r() * 2, 2.5 + r() * 2, 0.04, pick(r, [0x2a9ad8, 0xe8302a, 0xf2c420, 0x3ac04a, 0xa04ae8, 0xff8a1a]));
  for (const s of [-1, 1]) for (let i = 0; i < 2; i++) k.box(s * (HW / 2 - 0.06), 1.2 + r() * 2, -14 + i * 12 + r() * 3, 0.04, 2 + r() * 2, 4 + r() * 3, pick(r, [0x2a9ad8, 0xe8302a, 0xf2c420, 0x3ac04a, 0xa04ae8]));
  const strip = k.glow(0xf4f8ff, 1.6);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) k.box(-12 + i * 8, H - 0.05, zc - 9 + j * 9, 0.4, 0.05, 5, strip);
  hallLights(k, 0.62, 0.7, 0xf8f8ff, 0x6a6a7a);
  k.ceil.position.set(0, H - 1, -4); k.ceil.distance = 25; k.ceil.userData.max = 40; k.ceilOn = 1;
  // you: bounce after bounce, the bed giving under you, a turn now and then while in the air
  const eh = eyeStanding(c), BP = 1.12, seed = (S & 0xffff) + 17, hm = c.stage === LifeStage.Child ? 0.8 : 1.0;
  const yawAt = (n: number) => 0.65 * Math.sin(n * 0.29 + seed) + 0.2 * Math.sin(n * 0.11);
  return {
    eye: new Vector3(cx(MI), Y + eh, cz(MJ)), aim: new Vector3(0, 1, -14), glances: [], label: family ? 'at the family bounce' : 'bouncing at the trampoline park',
    move: (t, e) => {
      const h = bounce(t, BP, 0, seed, hm), s = t / BP, n = Math.floor(s), f = s - n;
      e.set(cx(MI) + 0.05 * Math.sin(t * 0.37), Y + eh + h, cz(MJ) + 0.06 * Math.sin(t * 0.23));
      dish.scale.y = 2 * (0.02 + Math.max(0, -h));
      const air = clamp01((f - 0.2) / 0.8), yaw = yawAt(n - 1) + (yawAt(n) - yawAt(n - 1)) * ease(air);
      const pitch = h < 0 ? -0.12 + h * 0.8 : -0.12 + 0.1 * Math.sin(Math.PI * air);
      return { yaw, pitch, roll: 0.025 * Math.sin(t * 1.7) };
    },
  };
};

// ---- the arcade ------------------------------------------------------------------------------

/** an arcade game on a cabinet's screen: a space shooter, a racer, a maze chase or falling blocks, with scanlines */
const ARCADE_FRAG = /* glsl */ `
uniform float uT; uniform float uSeed; uniform float uGame; uniform vec3 uSky; uniform float uNight; varying vec2 vUv;
float hs(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 17.0) * 43758.5453); }
float box(vec2 p, vec2 c, vec2 h) { vec2 d = abs(p - c) - h; return step(max(d.x, d.y), 0.0); }
vec3 pal(float h) { return 0.55 + 0.45 * cos(6.2831 * (h + vec3(0.0, 0.33, 0.67))); }
float tri(float x) { float u = fract(x); return u < 0.5 ? u * 2.0 : 2.0 - u * 2.0; }
vec3 shooter(vec2 p, float t) {
  vec3 c = vec3(0.01, 0.0, 0.05) + vec3(0.03, 0.0, 0.06) * p.y;
  vec2 sp = vec2(p.x * 70.0, p.y * 50.0 + t * 7.0);
  c += vec3(0.85) * step(0.988, hs(floor(sp))) * (0.5 + 0.5 * hs(floor(sp) + 3.0));
  float wave = floor(t / 24.0);
  vec2 q = (p - vec2(0.5 + 0.14 * sin(t * 0.9), 0.74 - 0.03 * mod(floor(t * 0.5), 5.0))) / vec2(0.1, 0.075) + vec2(3.0, 1.5);
  vec2 cell = floor(q), f = fract(q);
  if (cell.x >= 0.0 && cell.x < 6.0 && cell.y >= 0.0 && cell.y < 3.0 && hs(cell + wave * 7.0) > 0.18) {
    float legs = step(0.5, fract(t * 2.0));
    float spr = box(f, vec2(0.5, 0.55), vec2(0.28, 0.17)) + box(f, vec2(0.5, 0.78), vec2(0.12, 0.08))
      + box(f, vec2(0.28 + 0.1 * legs, 0.28), vec2(0.05, 0.1)) + box(f, vec2(0.72 - 0.1 * legs, 0.28), vec2(0.05, 0.1));
    float eye = box(f, vec2(0.38, 0.58), vec2(0.05, 0.05)) + box(f, vec2(0.62, 0.58), vec2(0.05, 0.05));
    vec3 col = cell.y < 0.5 ? vec3(0.3, 1.0, 0.4) : cell.y < 1.5 ? vec3(0.3, 0.9, 1.0) : vec3(1.0, 0.35, 0.9);
    c = mix(c, col, clamp(spr, 0.0, 1.0) * (1.0 - clamp(eye, 0.0, 1.0)));
  }
  float sx = 0.5 + 0.32 * sin(t * 0.83 + uSeed * 5.0) * cos(t * 0.31);
  c = mix(c, vec3(0.95, 0.95, 0.3), max(box(p, vec2(sx, 0.09), vec2(0.045, 0.014)), box(p, vec2(sx, 0.115), vec2(0.012, 0.016))));
  float ft = floor(t * 1.4) / 1.4, fx = 0.5 + 0.32 * sin(ft * 0.83 + uSeed * 5.0) * cos(ft * 0.31);
  c = mix(c, vec3(1.0), box(p, vec2(fx, 0.13 + fract(t * 1.4) * 0.75), vec2(0.004, 0.018)));
  for (int i = 0; i < 3; i++) c = mix(c, vec3(0.2, 0.8, 0.3), box(p, vec2(0.25 + 0.25 * float(i), 0.2), vec2(0.05, 0.02)) * step(0.3, hs(floor(p * 90.0))));
  vec2 g = floor(p * vec2(40.0, 30.0));
  return mix(c, vec3(1.0, 0.3, 0.3), step(28.0, g.y) * step(g.y, 28.5) * step(2.0, g.x) * step(g.x, 9.0) * step(0.35, hs(g + floor(t * 0.5))));
}
vec3 racer(vec2 p, float t) {
  float hz = 0.55;
  vec3 sky = mix(vec3(1.0, 0.55, 0.3), vec3(0.2, 0.3, 0.85), smoothstep(hz, 1.0, p.y));
  float curve = 0.35 * sin(t * 0.3 + uSeed * 3.0);
  float m = hz + 0.07 * (0.6 + 0.4 * sin(p.x * 9.0 + uSeed * 4.0 - curve * 3.0)) * (0.7 + 0.3 * sin(p.x * 23.0));
  if (p.y > hz) return p.y < m ? vec3(0.3, 0.18, 0.45) : sky;
  float d = hz - p.y, z = 0.12 / max(d, 0.002), k = 1.0 - d / hz;
  float cx = 0.5 + curve * k * k, w = 0.03 + d * 1.1, x = (p.x - cx) / w;
  float stripe = step(0.5, fract(z * 1.5 - t * 5.0));
  vec3 c = mix(vec3(0.12, 0.5, 0.16), vec3(0.16, 0.6, 0.2), stripe);
  if (abs(x) < 1.0) c = mix(vec3(0.32), vec3(0.38), stripe);
  if (abs(x) > 0.9 && abs(x) < 1.12) c = mix(vec3(0.9, 0.1, 0.1), vec3(0.95), stripe);
  if (abs(x) < 0.03 && stripe > 0.5) c = vec3(0.95);
  // a rival ahead, the player's car at the bottom
  float rd = 0.08 + 0.06 * tri(t * 0.05), rx = cx + (0.4 * sin(t * 0.21)) * (0.03 + rd * 1.1);
  c = mix(c, vec3(0.2, 0.4, 1.0), box(p, vec2(rx, hz - rd), vec2(0.02 + rd * 0.4, 0.012 + rd * 0.2)));
  vec2 cp = vec2(0.5 + 0.08 * sin(t * 0.7), 0.09);
  c = mix(c, vec3(0.95, 0.12, 0.1), box(p, cp, vec2(0.08, 0.04)));
  return mix(c, vec3(0.1), box(p, cp + vec2(0.0, 0.03), vec2(0.045, 0.02)));
}
vec3 maze(vec2 p, float t) {
  vec2 g = p * vec2(15.0, 11.0), cell = floor(g), f = fract(g);
  bool edge = cell.x < 0.5 || cell.x > 13.5 || cell.y < 0.5 || cell.y > 9.5;
  bool pillar = mod(cell.x, 2.0) < 0.5 && mod(cell.y, 2.0) < 0.5;
  if (edge || pillar) return mix(vec3(0.15, 0.25, 1.0), vec3(0.02, 0.02, 0.15), box(f, vec2(0.5), vec2(0.38)));
  vec3 c = vec3(0.0);
  float u = fract(t * 0.06), x = 1.5 + 12.0 * (u < 0.5 ? u * 2.0 : 2.0 - u * 2.0), dir = u < 0.5 ? 1.0 : -1.0;
  bool eaten = cell.y == 5.0 && (dir > 0.0 ? cell.x + 0.5 < x : cell.x + 0.5 > x);
  if (!eaten && length(f - 0.5) < 0.1) c = vec3(1.0, 0.85, 0.7);
  vec2 d = g - vec2(x, 5.5);
  if (length(d) < 0.45 && abs(atan(d.y, d.x * dir)) > 0.7 * abs(sin(t * 9.0))) c = vec3(1.0, 0.9, 0.1);
  for (int i = 0; i < 3; i++) {
    float fi = float(i), v = tri(t * (0.05 + 0.02 * fi) + fi * 0.3);
    vec2 e = g - vec2(3.5 + 4.0 * fi, 1.5 + 8.0 * v);
    float body = max(step(length(e), 0.42) * step(0.0, e.y), step(abs(e.x), 0.42) * step(-0.4, e.y) * step(e.y, 0.0) * (1.0 - step(e.y, -0.28) * step(0.5, fract((e.x + 0.42) * 3.6 + t * 3.0))));
    vec3 gc = i == 0 ? vec3(1.0, 0.15, 0.1) : i == 1 ? vec3(1.0, 0.6, 0.85) : vec3(0.2, 0.9, 1.0);
    c = mix(c, gc, body);
    c = mix(c, vec3(1.0), step(length(e - vec2(-0.15, 0.1)), 0.1) + step(length(e - vec2(0.15, 0.1)), 0.1));
  }
  return c;
}
vec3 blocks(vec2 p, float t) {
  vec3 c = vec3(0.03, 0.02, 0.08) + 0.04 * step(0.5, fract((p.x + p.y) * 20.0));
  vec2 q = (p - vec2(0.3, 0.04)) / vec2(0.4, 0.92);
  float pc = floor(t / 4.0), pf = fract(t / 4.0);
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) {
    c = mix(c, vec3(0.12), box(p, vec2(0.85, 0.75), vec2(0.1, 0.1)));
    c = mix(c, pal(fract((pc + 1.0) * 0.37 + uSeed)), box(p, vec2(0.85, 0.75), vec2(0.04, 0.04)));
    return mix(c, vec3(0.9), box(p, vec2(0.85, 0.5), vec2(0.08 * (0.3 + 0.7 * fract(t / 40.0)), 0.015)));
  }
  vec2 g = q * vec2(10.0, 20.0), cell = floor(g), f = fract(g);
  float cyc = floor(t / 40.0), lt = fract(t / 40.0), h = floor(2.0 + 8.0 * lt * (0.6 + 0.4 * hs(vec2(cell.x, cyc))));
  float bev = box(f, vec2(0.5), vec2(0.4));
  vec3 col = vec3(0.02, 0.02, 0.06);
  if (cell.y + 0.5 < h && hs(cell + cyc * 3.0) > 0.12) col = pal(hs(cell + 5.0 + cyc)) * (0.65 + 0.35 * bev);
  float px = floor(1.0 + 7.0 * hs(vec2(pc, 9.0))), py = floor(20.0 - pf * 9.0);
  if (cell.x >= px && cell.x <= px + 1.0 && cell.y >= py && cell.y <= py + 1.0) col = pal(fract(pc * 0.37 + uSeed)) * (0.7 + 0.3 * bev);
  return col + step(0.96, fract(t / 6.0)) * step(abs(cell.y - 1.0), 0.5) * vec3(0.9);
}
void main() {
  vec2 p = vUv, d = p - 0.5;
  float t = uT + uSeed * 37.0;
  int g = int(uGame + 0.5);
  vec3 c = g == 0 ? shooter(p, t) : g == 1 ? racer(p, t) : g == 2 ? maze(p, t) : blocks(p, t);
  float at = step(0.93, fract(t / 31.0 + uSeed));
  c = mix(c, pal(fract(t * 0.5)) * 1.2, at * box(p, vec2(0.5, 0.55), vec2(0.38, 0.09)));
  c *= 0.84 + 0.16 * sin(p.y * 360.0);
  c *= 1.0 - 0.6 * dot(d, d);
  gl_FragColor = vec4(c * 1.25, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** standing at a cabinet with its game playing, rows of glowing cabinets, air hockey, the claw machine, the racing seat */
const arcade: RoomBuilder = (k, c) => {
  const S = seedOf(c), r = rng(S ^ 0xa4c);
  const hiscore = eventOn(c, 'arcade');
  const W = 15, D = 12, H = 3.6, zc = 2.2;
  k.group(0, zc, 0, () => k.shell(W, D, H, pick(r, [0x1a1030, 0x101a30, 0x200f24]), 0x0c0c24, 0x08080e, -1));
  // the games: one shader, each cabinet its own game and seed, one clock for all
  const clock = { value: 0 };
  const game = (g: number, seed: number) => {
    const m = new ShaderMaterial({ uniforms: { uT: clock, uSeed: { value: hash2(seed, 5) }, uGame: { value: g }, uSky: { value: new Color() }, uNight: { value: 0 } }, vertexShader: VERT, fragmentShader: ARCADE_FRAG });
    k.windows.push(m); // the kit disposes it (it sets the unused sky uniforms each frame)
    return m;
  };
  k.animate.push((t) => { clock.value = t; });
  const BODY = [0x1a1a1e, 0xb02020, 0x2040b0, 0x5a20a0, 0xe0b020, 0x1a6a3a, 0xe8e8e8, 0x2a2a3a];
  const MARQ = [0xff3fa4, 0x32e6ff, 0xffd23a, 0x6aff6a, 0xff7a2a, 0xb06aff];
  /** a cabinet facing +z in its frame (front at z 0): body, marquee, bezel and screen, the control panel */
  const cabinet = (x: number, z: number, ry: number, g: number, seed: number) => {
    let screen: Mesh | null = null;
    const grp = k.group(x, z, ry, () => {
      k.box(0, 0, -0.42, 0.74, 1.95, 0.84, pick(r, BODY));
      k.box(0, 1.68, 0.02, 0.72, 0.24, 0.04, k.glow(pick(r, MARQ), 1.3));
      k.box(0, 1.15, 0.005, 0.64, 0.5, 0.02, 0x0a0a0c);
      screen = k.panel(0, 1.4, 0.018, 0.56, 0.42, game(g, seed));
      k.box(0, 0.88, 0.17, 0.74, 0.12, 0.34, 0x1a1a1e);
    });
    return { grp, screen: screen! };
  };
  // the row you stand at, along the back; your cabinet in the middle
  const mine = Math.floor(r() * 4);
  for (let i = -4; i <= 4; i++) if (i !== 0) cabinet(i * 0.82, -0.62, 0, Math.floor(r() * 4), S + i);
  cabinet(0, -0.62, 0, mine, S + 99);
  // your controls: the stick, the buttons, the coin door
  const stick = k.group(-0.16, -0.62 + 0.22, 0, () => { k.cyl(0, 0, 0, 0.01, 0.08, 0x1a1a1a); k.ball(0, 0.09, 0, 0.026, 0.026, 0.026, 0xd02020); });
  stick.position.y = 1.0;
  const btnCols = [0xe8302a, 0x2a7ae8, 0xf2c820, 0x3ac04a, 0xe85ac8, 0xf4f4f4];
  const btnLit = btnCols.map((col) => k.glow(col, 1.6)), btnOff = btnCols.map((col) => k.mat(col));
  const buttons = btnCols.map((_, i) => k.cyl(0.0 + (i % 3) * 0.075, 1.0, -0.62 + (i < 3 ? 0.16 : 0.26), 0.022, 0.016, btnOff[i]));
  k.box(0, 0.4, -0.615, 0.24, 0.3, 0.02, 0x3a3a3c);
  for (const s of [-1, 1]) k.box(s * 0.05, 0.6, -0.6, 0.03, 0.05, 0.01, k.glow(0xff3020, 1.4));
  k.animate.push((t) => {
    stick.rotation.z = 0.32 * Math.sin(t * 2.3) * Math.sin(t * 0.7); stick.rotation.x = 0.25 * Math.sin(t * 1.7 + 1);
    for (let i = 0; i < buttons.length; i++) buttons[i].material = hash2(Math.floor(t * 6), i) < 0.18 ? btnLit[i] : btnOff[i];
    k.tv.color.setHSL(mod(t * 0.05, 1), 0.7, 0.55); k.tv.intensity = 0.9 + 0.25 * Math.sin(t * 9) * Math.sin(t * 3.1);
  });
  k.tv.position.set(0, 1.4, -0.2); k.tv.distance = 3.5;
  // a row along the left wall
  for (let i = 0; i < 5; i++) cabinet(-6.4, 0.6 + i * 0.85, Math.PI / 2, Math.floor(r() * 4), S + 200 + i);
  // air hockey on the left: a glowing table, the puck flying, two children playing
  const ax = -3.2, az = 1.3, edge = k.glow(pick(r, MARQ), 1.4);
  k.box(ax, 0, az, 2.1, 0.76, 1.1, 0x1a1a2a);
  k.box(ax, 0.76, az, 2.0, 0.01, 1.0, k.glow(0xd8f0ff, 0.9));
  for (const s of [-1, 1]) { k.box(ax, 0.76, az + s * 0.52, 2.1, 0.05, 0.05, edge); for (const t2 of [-1, 1]) k.box(ax + s * 1.03, 0.76, az + t2 * 0.37, 0.05, 0.05, 0.36, edge); }
  const puck = k.cyl(0, 0.775, 0, 0.04, 0.012, k.glow(0xff3020, 1.2));
  const mallets = [-1, 1].map((s) => k.group(ax + s * 0.85, az, 0, () => { k.cyl(0, 0.775, 0, 0.05, 0.03, s < 0 ? 0xe8302a : 0x2a7ae8); k.cyl(0, 0.805, 0, 0.02, 0.05, s < 0 ? 0xe8302a : 0x2a7ae8); }));
  k.box(ax, 0, az - 0.7, 0.06, 2.1, 0.06, 0x2a2a30); k.box(ax, 2.1, az - 0.7, 0.6, 0.25, 0.08, k.glow(0xff3f6a, 1.1));
  const kids = [-1, 1].map((s, i) => { const look = visitor(c, 500 + i, crowdStage(r, 0.8, 0)); const b: Body = { look, x: ax + s * 1.35, y: 0, z: az, yaw: s < 0 ? 0 : Math.PI, swing: 0, pose: -0.6, ph: i * 3 }; k.bodies.push(b); return b; });
  k.animate.push((t) => {
    const px = 0.95 * (2 * (1 - Math.abs(mod(t / 0.9, 2) - 1)) - 1), pz = 0.45 * (2 * (1 - Math.abs(mod(t / 0.57 + 0.3, 2) - 1)) - 1);
    puck.position.set(ax + px, 0.775, az + pz);
    mallets.forEach((m, i) => { const s = i ? 1 : -1, near = clamp01(1 - Math.abs(px - s * 0.85) / 1.2); m.position.z = az + pz * (0.3 + 0.6 * near); kids[i].z = az + pz * (0.2 + 0.4 * near); });
  });
  // the claw machines on the right: plush toys under glass, the claw wandering and dropping
  const glass = seeThrough(k, 0xc8e0ff, 0.14), plush = [0xf2c820, 0xe85ac8, 0x6ad0ff, 0xf4f4f0, 0x8a5a3a, 0x3ac04a, 0xff8a6a];
  const claws: Group[] = [];
  for (let m = 0; m < 2; m++) {
    const g = k.group(3.9, 0.6 + m * 1.0, -Math.PI / 2, () => {
      k.box(0, 0, 0, 0.9, 0.85, 0.9, pick(r, [0xe8302a, 0x2a7ae8, 0xe85ac8]));
      k.box(0, 0.55, 0.455, 0.6, 0.2, 0.01, k.glow(0xffe060, 1.1));
      for (let i = 0; i < (m ? 6 : 9); i++) {
        const x = (r() - 0.5) * 0.65, z = (r() - 0.5) * 0.65, col = pick(r, plush);
        k.ball(x, 0.95 + r() * 0.06, z, 0.09, 0.08, 0.08, col); if (!m) k.ball(x, 1.07 + r() * 0.04, z, 0.065, 0.065, 0.065, col);
      }
      k.box(0, 0.85, 0, 0.9, 1.05, 0.9, glass);
      k.box(0, 1.9, 0, 0.94, 0.3, 0.94, k.glow(pick(r, MARQ), 1.2));
      k.box(0, 1.86, 0, 0.8, 0.03, 0.8, k.glow(0xffffff, 1.0));
    });
    const claw = k.group(0, 0, 0, () => { k.cyl(0, 0.2, 0, 0.006, 0.5, 0xc0c0c8); for (let i = 0; i < 3; i++) k.box(Math.cos(i * 2.1) * 0.03, 0.1, Math.sin(i * 2.1) * 0.03, 0.015, 0.1, 0.015, 0xc0c0c8, i * 2.1); });
    g.add(claw); claws.push(claw);
  }
  k.animate.push((t) => claws.forEach((cl, i) => {
    const u = mod(t + i * 5, 11), drop = u > 7 && u < 10 ? Math.sin((Math.PI * (u - 7)) / 3) : 0;
    cl.position.set(0.28 * Math.sin(t * 0.37 + i), 1.6 - 0.48 * drop, 0.28 * Math.sin(t * 0.29 + i * 2));
  }));
  k.stand(visitor(c, 510, crowdStage(r, 0.7, 0)), 3.15, 0.6, 0, -0.4, 4);
  k.lamp.position.set(3.6, 2.2, 1.1); k.lamp.userData.max = 3; k.lamp.color.set(0xff70c0); k.lampOn = 1;
  // the racing seat: a screen of its own, a teenager steering through the bends
  const rx = 3.9, rz = 3.6;
  k.box(rx, 0, rz, 0.6, 0.42, 0.6, 0x1a1a1a); k.box(rx - 0.3, 0.42, rz, 0.12, 0.7, 0.6, 0xc02020);
  k.box(rx + 0.55, 0, rz, 0.1, 0.75, 0.1, 0x2a2a2a); const wheel = k.ball(rx + 0.55, 0.85, rz, 0.02, 0.15, 0.15, 0x1a1a1a);
  k.box(rx + 1.3, 0, rz, 0.2, 0.7, 0.4, 0x2a2a2a); k.box(rx + 1.32, 0.7, rz, 0.06, 0.66, 1.16, 0x0a0a0c);
  k.panel(rx + 1.28, 1.03, rz, 1.1, 0.62, game(1, S + 300), -Math.PI / 2);
  const racerKid = visitor(c, 520, crowdStage(r, 0.6, 0));
  k.bodies.push({ look: racerKid, x: rx, y: seatY(racerKid, 0.42), z: rz, yaw: 0, swing: 0, pose: -0.3, ph: 7, move: (t, b) => { b.yaw = 0.18 * Math.sin(t * 0.3 + 2); wheel.rotation.x = 1.2 * Math.sin(t * 0.3 + 2); } });
  // the prize counter behind, its shelves of toys; a change machine
  const cz = 7.1;
  k.box(-3.5, 0, cz, 3.2, 1.05, 0.6, 0x2a1a3a); k.box(-3.5, 0.3, cz - 0.31, 3.0, 0.12, 0.02, k.glow(0xffd23a, 1.3));
  k.stand(staff(c, 1), -3.5, cz + 0.6, Math.PI / 2, 0, 1);
  for (let s = 0; s < 3; s++) { k.box(-3.5, 0.9 + s * 0.6, 8.05, 3.2, 0.04, 0.3, 0x3a2a2a); for (let i = 0; i < 7; i++) k.ball(-4.9 + i * 0.45 + r() * 0.1, 1.04 + s * 0.6, 8.0, 0.11, 0.1, 0.1, pick(r, plush)); }
  k.box(1.5, 0, 7.8, 0.8, 1.7, 0.6, 0x3a3a44); k.box(1.5, 1.2, 7.49, 0.5, 0.3, 0.02, k.glow(0x6aff6a, 1.1));
  // the carpet: a dark sky with planets, rings and stars that glow under the black light
  const cm = [0xff3fa4, 0x32e6ff, 0xffd23a, 0x6aff6a, 0xb06aff].map((col) => k.glow(col, 0.55));
  for (let i = 0; i < 46; i++) {
    const x = (r() - 0.5) * 13, z = -0.4 + r() * 8.2, m = pick(r, cm);
    if (r() < 0.55) k.cyl(x, 0.001, z, 0.07 + r() * 0.14, 0.002, m); else k.box(x, 0.001, z, 0.07, 0.002, 0.07, m, Math.PI / 4);
  }
  // neon on the back wall over the cabinets, strips round the room, dim downlights
  const n1 = k.glow(0xff3fa4, 1.6), n2 = k.glow(0x32e6ff, 1.6), n3 = k.glow(0xffd23a, 1.6), bw = zc - D / 2 + 0.05;
  for (const [x, y, w, h, rz2, m] of [[-2.2, 2.6, 0.08, 0.7, 0.4, n3], [-2.0, 2.9, 0.08, 0.6, -0.5, n3], [-1.8, 3.1, 0.08, 0.5, 0.4, n3], [1.6, 2.8, 0.7, 0.07, 0.785, n1], [1.6, 2.8, 0.7, 0.07, -0.785, n1], [0, 2.45, 3.6, 0.06, 0, n2], [0, 3.2, 3.6, 0.06, 0, n1]] as [number, number, number, number, number, MeshBasicMaterial][]) {
    const m2 = k.box(x, y - h / 2, bw, w, h, 0.03, m); m2.rotation.z = rz2;
  }
  for (const s of [-1, 1]) k.box(s * (W / 2 - 0.04), H - 0.3, zc, 0.04, 0.06, D - 0.4, s < 0 ? n1 : n2);
  for (let i = 0; i < 6; i++) k.cyl(-4 + (i % 3) * 4, H - 0.02, 1 + Math.floor(i / 3) * 4, 0.15, 0.02, k.glow(0xd0c8ff, 0.8));
  // players at the other cabinets, people wandering between games; your friends beside you
  for (const i of [-3, -2, 2, 4]) if (r() < (hiscore ? 0.95 : 0.6)) k.stand(visitor(c, 530 + i, crowdStage(r, 0.5, 0.05)), i * 0.82, 0.0, Math.PI / 2, -0.3, i + 4);
  for (let i = 0; i < 5; i += 2) if (r() < 0.6) k.stand(visitor(c, 540 + i, crowdStage(r, 0.5, 0.05)), -5.75, 0.6 + i * 0.85, Math.PI, -0.3, i);
  for (let i = 0; i < (hiscore ? 4 : 2); i++) lineWalker(k, visitor(c, 550 + i, crowdStage(r, 0.5, 0.1)), -4.5 + r() * 2, 3.5 + r(), 2.5 + r() * 1.5, 4.5 + r() * 1.5, 0.6 + r() * 0.4, r());
  const crew = companions(c, 2);
  if (crew[0]) k.stand(crew[0].look, -0.82, 0.02, Math.PI / 2, -0.3, 11);
  if (crew[1]) k.stand(crew[1].look, 0.6, 0.6, 2.0, 0, 12);
  hallLights(k, 0.22, 0.12, 0x8070c0, 0x201838, 0xb0a0ff);
  k.ceil.position.set(0, H - 0.4, 2.5); k.ceil.userData.max = 4; k.ceil.color.set(0xd0c0ff); k.ceilOn = 1;
  const eh = eyeStanding(c);
  return {
    eye: new Vector3(0, eh, 0), aim: new Vector3(0, 1.4, -0.62),
    glances: [new Vector3(ax, 0.9, az), new Vector3(3.9, 1.3, 1.1), new Vector3(-0.82, 1.3, 0), new Vector3(rx + 1.2, 1.0, rz), new Vector3(0, 2.8, bw)],
    label: hiscore ? 'at high-score night at the arcade' : 'playing at the arcade',
  };
};

// ---- the board-game café ---------------------------------------------------------------------

const GAME_BOX = [...BRIGHT, 0x2a2a2a, 0xf4f0e8, 0x6a2a2a, 0x2a4a6a, 0xe8b830, 0x7a4a9a, 0x3a8a8a, 0xd86a3a];
/** a shelf unit of board games: boxes stood on end with their spines out, and flat stacks */
function gameShelf(k: Kit, r: Rng, x: number, z: number, ry: number, w: number, h: number, col: number) {
  k.group(x, z, ry, () => {
    k.box(0, 0, 0.02, w, h, 0.04, col);
    for (const s of [-1, 1]) k.box(s * (w / 2 - 0.02), 0, 0.2, 0.04, h, 0.38, col);
    const rows = 4, rh = (h - 0.05) / rows;
    for (let row = 0; row <= rows; row++) k.box(0, row * rh, 0.2, w, 0.03, 0.38, col);
    for (let row = 0; row < rows; row++) {
      const y = row * rh + 0.03;
      let bx = -w / 2 + 0.05;
      while (bx < w / 2 - 0.12) {
        if (r() < 0.35) {
          const bw = 0.26 + r() * 0.08, n = 2 + Math.floor(r() * 3);
          let y2 = y;
          for (let i = 0; i < n; i++) { const bh = 0.04 + r() * 0.04; k.box(bx + bw / 2 + (r() - 0.5) * 0.02, y2, 0.2, bw, bh, 0.28 + r() * 0.06, pick(r, GAME_BOX)); y2 += bh; }
          bx += bw + 0.02;
        } else { const bw = 0.05 + r() * 0.06; k.box(bx + bw / 2, y, 0.2, bw, 0.26 + r() * 0.1, 0.3, pick(r, GAME_BOX)); bx += bw + 0.008; }
      }
    }
  });
}
/** a die: a white cube with its pips, 1 up (+y), 2 on +x, 3 on +z, opposite faces summing to seven */
function die(k: Kit, s: number) {
  const pip = k.mat(0x1a1a1a), h = s / 2, o = s * 0.28;
  const faces: [number, (a: number, b: number) => [number, number, number]][] = [
    [1, (a, b) => [a, h, b]], [6, (a, b) => [a, -h, b]], [2, (a, b) => [h, b, a]], [5, (a, b) => [-h, b, a]], [3, (a, b) => [a, b, h]], [4, (a, b) => [a, b, -h]],
  ];
  const PIPS: Record<number, [number, number][]> = {
    1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    5: [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]], 6: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]],
  };
  const g = k.group(0, 0, 0, () => {
    k.box(0, -h, 0, s, s, s, 0xf8f6f0);
    for (const [v, at] of faces) for (const [a, b] of PIPS[v]) { const [x, y, z] = at(a * o, b * o); k.ball(x * 1.0, y, z, s * 0.09, s * 0.09, s * 0.09, pip); }
  });
  g.rotation.order = 'YXZ';
  return g;
}
/** the turn that shows `v` on top: [x, z] rotations (YXZ order, a yaw of its own on top) */
const FACE_UP: Record<number, [number, number]> = { 1: [0, 0], 6: [Math.PI, 0], 2: [0, Math.PI / 2], 5: [0, -Math.PI / 2], 3: [-Math.PI / 2, 0], 4: [Math.PI / 2, 0] };

/** at a table with a game of ludo, the die rolling round the table, mugs of hot chocolate, shelves of games all round */
const boardgames: RoomBuilder = (k, c) => {
  const S = seedOf(c), r = rng(S ^ 0xb6a3);
  const tourney = eventOn(c, 'boardgames');
  const W = 9, D = 7.4, H = 2.9;
  k.shell(W, D, H, pick(r, [0xc8553a, 0x2f6a6a, 0xe8d8b8, 0x3a4a6a, 0x6a3a4a, 0xd8b860]), pick(r, [0x8a6a4a, 0x6e523a, 0x9e7a52]), 0xf0e8dc);
  k.window('left', 0.6, 0.9, 2.6, 1.4, c.place.seed, 0x3a2a1e);
  picture(k, r, 'right', -1.2, 1.5); picture(k, r, 'right', 1.0, 1.6);
  // shelves of games on the back wall and by the window
  const wood = pick(r, WOOD.slice(0, 4));
  gameShelf(k, r, -1.6, -D / 2 + 0.02, 0, 1.5, 2.3, wood); gameShelf(k, r, 1.6, -D / 2 + 0.02, 0, 1.5, 2.3, wood);
  gameShelf(k, r, -W / 2 + 0.02, -2.2, Math.PI / 2, 1.4, 2.0, wood);
  k.box(0, 2.1, -D / 2 + 0.02, 1.4, 0.4, 0.03, k.glow(0xffe0a0, 0.9)); k.box(0, 2.18, -D / 2 + 0.04, 1.1, 0.06, 0.02, 0x8a2a2a);
  // your table: the board, its pieces and the die; mugs and biscuits; the cards
  const T = new Vector3(0, 0.76, 1.0), bt = 0.772, s = 0.5 / 15;
  k.cyl(T.x, 0, T.z, 0.3, 0.03, 0x2a2a2a); k.cyl(T.x, 0, T.z, 0.06, 0.72, 0x2a2a2a); k.box(T.x, 0.72, T.z, 0.95, 0.04, 0.95, pick(r, [0x6a4a2a, 0x8a6a3a, 0x4a3422]));
  const LUDO = [0xd03a2a, 0x2a8a3a, 0xe8c020, 0x2a5ac8];
  const cell = (i: number, j: number, y = bt): [number, number, number] => [T.x + (i - 7) * s, y, T.z + (j - 7) * s];
  k.box(T.x, 0.76, T.z, 0.5, 0.012, 0.5, 0xf8f4ea);
  const yards: [number, number][] = [[2.5, 2.5], [11.5, 2.5], [11.5, 11.5], [2.5, 11.5]];
  yards.forEach(([i, j], col) => { const [x, , z] = cell(i, j); k.box(x, bt, z, 6 * s, 0.002, 6 * s, LUDO[col]); k.box(x, bt + 0.002, z, 4 * s, 0.002, 4 * s, 0xf8f4ea); });
  const homes: [number, number, number, number][] = [[7, 3, 1, 5], [11, 7, 5, 1], [7, 11, 1, 5], [3, 7, 5, 1]];
  homes.forEach(([i, j, w, d], col) => { const [x, , z] = cell(i, j); k.box(x, bt, z, w * s, 0.002, d * s, LUDO[col]); });
  for (let q = 0; q < 4; q++) { const [x, , z] = cell(7 + (q === 1 ? 0.5 : q === 3 ? -0.5 : 0), 7 + (q === 0 ? -0.5 : q === 2 ? 0.5 : 0)); k.box(x, bt + 0.001, z, (q % 2 ? 1 : 3) * s, 0.002, (q % 2 ? 3 : 1) * s, LUDO[q]); }
  const line = k.mat(0x3a3a3a);
  for (const b of [6, 7, 8, 9]) { k.box(T.x + (b - 7.5) * s, bt + 0.0003, T.z, 0.002, 0.001, 0.5, line); k.box(T.x, bt + 0.0003, T.z + (b - 7.5) * s, 0.5, 0.001, 0.002, line); }
  for (let n = 0; n <= 6; n++) for (const [ax, az] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const d = 7.5 - n, [x, , z] = cell(7 + ax * d, 7 + az * d);
    if (ax) k.box(x, bt + 0.0003, T.z, 0.002, 0.001, 3 * s, line);
    else k.box(T.x, bt + 0.0003, z, 3 * s, 0.001, 0.002, line);
  }
  // the track: 52 squares round the cross, each arm turned a quarter from the last
  const arm: [number, number][] = [];
  for (let j = 5; j >= 0; j--) arm.push([6, j]);
  arm.push([7, 0]);
  for (let j = 0; j <= 5; j++) arm.push([8, j]);
  const track: [number, number][] = [];
  for (let q = 0; q < 4; q++) for (const [i0, j0] of arm) { let i = i0, j = j0; for (let n = 0; n < q; n++) [i, j] = [14 - j, i]; track.push([i, j]); }
  for (let col = 0; col < 4; col++) { const [x, , z] = cell(...track[col * 13 + 1]); k.box(x, bt + 0.0012, z, s * 0.9, 0.002, s * 0.9, LUDO[col]); }
  // the pieces: three waiting in each yard, one out on the track
  const pawn = (col: number) => k.group(0, 0, 0, () => { k.cone(0, 0, 0, 0.011, 0.03, LUDO[col]); k.ball(0, 0.033, 0, 0.0095, 0.0095, 0.0095, LUDO[col]); });
  yards.forEach(([i, j], col) => { for (let p = 1; p < 4; p++) { const g = pawn(col); const [x, y, z] = cell(i + (p % 2 ? -1 : 1), j + (p < 2 ? -1 : 1)); g.position.set(x, y, z); } });
  const runners = [0, 1, 2, 3].map((col) => pawn(col));
  // seats: you (+z), left, across, right; each seat plays a colour: the yard on their left hand
  const seats: [number, number, number][] = [[0, 0.62, Math.PI / 2], [-0.62, 0, 0], [0, -0.62, -Math.PI / 2], [0.62, 0, Math.PI]];
  const colOf = (seat: number) => (seat + 2) % 4;
  const chairCol = pick(r, WOOD);
  seats.forEach(([x, z], i) => chair(k, T.x + x * 1.02, T.z + z * 1.02, [Math.PI, Math.PI / 2, 0, -Math.PI / 2][i], chairCol, 0.46, 0.5));
  const crew = party(c, r, 3, 600, 0.3, 0.2);
  const players: Body[] = [];
  crew.forEach((look, i) => {
    const [x, z, yaw] = seats[i + 1];
    const b: Body = { look, x: T.x + x * 1.04, y: seatY(look, 0.47), z: T.z + z * 1.04, yaw: yaw + (r() - 0.5) * 0.2, swing: 0, pose: 0, ph: i * 5 };
    k.bodies.push(b); players.push(b);
  });
  // mugs of hot chocolate (cream on some), biscuits, the cards
  const mugAt: [number, number][] = [[0.3, 0.34], [-0.36, 0.25], [-0.28, -0.36], [0.36, -0.22]];
  mugAt.forEach(([x, z]) => {
    const col = pick(r, [0xf4f0e8, 0xd03a2a, 0x2a5ac8, 0xe8c020, 0x3a8a5a]);
    k.cyl(T.x + x, 0.76, T.z + z, 0.042, 0.095, col); k.cyl(T.x + x, 0.84, T.z + z, 0.037, 0.008, 0x5a3220);
    k.box(T.x + x + 0.045, 0.78, T.z + z - 0.005, 0.02, 0.05, 0.01, col);
    if (r() < 0.5) k.ball(T.x + x, 0.855, T.z + z, 0.032, 0.022, 0.032, 0xfaf6ee);
  });
  k.cyl(T.x - 0.33, 0.76, T.z + 0.36, 0.08, 0.008, 0xf4f4f0);
  for (let i = 0; i < 3; i++) k.cyl(T.x - 0.33 + (i - 1) * 0.04, 0.768, T.z + 0.36 + (i % 2) * 0.02, 0.025, 0.008, 0xc89a5a);
  k.box(T.x + 0.34, 0.76, T.z + 0.3, 0.06, 0.02, 0.09, 0x2a4a8a);
  for (let i = 0; i < 3; i++) k.box(T.x + 0.28 + i * 0.03, 0.762 + i * 0.001, T.z + 0.06, 0.06, 0.001, 0.09, 0xf8f8f4, 0.3 - i * 0.25);
  // the die: thrown from each seat in turn, tumbling to a stop; the thrower's piece hops on that many squares
  const dieG = die(k, 0.024);
  const hands: [number, number, number][] = [[0.12, 0.95, 0.42], [-0.42, 0.95, 0.1], [-0.1, 0.95, -0.42], [0.42, 0.95, -0.08]];
  const rests: [number, number][] = [[0.05, 0.33], [-0.34, 0.06], [0.05, -0.33], [0.34, -0.05]];
  const TP = 6.5, tph = r() * 100, game = 48;
  const roll = (n: number) => 1 + Math.floor(hash2(S, n * 7 + 1) * 6);
  /** where colour col's runner stands at the start of turn n: its start square plus its rolls so far this game */
  const posAt = (n: number, seat: number) => { let p = colOf(seat) * 13 + 1; for (let m = n - mod(n, game); m < n; m++) if (mod(m, 4) === seat) p += roll(m); return p % 52; };
  const sq = (p: number, y: number, out: Vector3) => { const [x, , z] = cell(...track[mod(p, 52)]); return out.set(x, y, z); };
  const a = new Vector3(), b = new Vector3();
  k.animate.push((t) => {
    const s2 = (t + tph) / TP, n = Math.floor(s2), u = (s2 - n) * TP, seat = mod(n, 4), v = roll(n);
    // the die: from the hand, bouncing across the table, settling to show the roll
    const [hx, hy, hz] = hands[seat], [rx, rz] = rests[seat], e = clamp01((u - 0.3) / 1.1), eo = 1 - (1 - e) ** 3;
    const [fx, fz] = FACE_UP[v], yaw0 = hash2(S, n * 7 + 2) * 6.28;
    dieG.position.set(T.x + hx + (rx - hx) * eo, u < 0.3 ? hy : 0.772 + Math.abs(Math.sin(e * Math.PI * 3)) * 0.07 * (1 - e) + (hy - 0.772) * Math.max(0, 1 - e * 4), T.z + hz + (rz - hz) * eo);
    dieG.rotation.set(fx + (1 - eo) * 9.4, yaw0 + (1 - eo) * 6.3, fz + (1 - eo) * 7.9);
    // each runner where its rolls have taken it; this turn's hops on after the die settles
    for (let st = 0; st < 4; st++) {
      const p = posAt(n, st), g = runners[colOf(st)];
      if (st !== seat || u < 1.7) { sq(p, bt, g.position); continue; }
      const hop = Math.min(v, (u - 1.7) / 0.32), i = Math.floor(hop), f = hop - i;
      if (i >= v) { sq(p + v, bt, g.position); continue; }
      sq(p + i, bt, a); sq(p + i + 1, bt, b);
      g.position.lerpVectors(a, b, f); g.position.y = bt + Math.sin(Math.PI * f) * 0.025;
    }
    // the thrower's arm goes out with the throw; the others watch it land
    players.forEach((pb, i) => { pb.pose = i + 1 === seat && u < 0.6 ? -0.7 : 0; });
  });
  // the other tables, games under way; on tournament day every seat taken and the numbers on the tables
  const tables: [number, number][] = [[-2.5, -1.3], [2.5, -1.3], [-2.9, 2.0], [2.4, 2.4]];
  let slot = 620;
  tables.forEach(([x, z], ti) => {
    k.cyl(x, 0, z, 0.06, 0.72, 0x2a2a2a); k.cyl(x, 0, z, 0.28, 0.03, 0x2a2a2a); k.cyl(x, 0.72, z, 0.45, 0.04, pick(r, [0x6a4a2a, 0x8a6a3a, 0x4a3422]));
    k.box(x, 0.76, z, 0.4, 0.012, 0.4, pick(r, GAME_BOX)); k.box(x, 0.772, z, 0.28, 0.003, 0.28, pick(r, GAME_BOX));
    for (let i = 0; i < 3; i++) k.cone(x + (r() - 0.5) * 0.3, 0.775, z + (r() - 0.5) * 0.3, 0.012, 0.035, pick(r, LUDO));
    k.cyl(x + 0.3, 0.76, z + 0.15, 0.04, 0.09, pick(r, [0xf4f0e8, 0xd03a2a, 0x2a5ac8]));
    if (tourney) k.box(x - 0.25, 0.76, z - 0.2, 0.1, 0.07, 0.01, 0xf8f8f4);
    k.cyl(x, H - 0.75, z, 0.005, 0.75, 0x2a2a2a); k.cyl(x, H - 0.95, z, 0.16, 0.2, k.glow(0xffd8a0, 1.2, 'lamp'));
    [[0, 0.65, Math.PI / 2, Math.PI], [0, -0.65, -Math.PI / 2, 0], [0.65, 0, Math.PI, -Math.PI / 2], [-0.65, 0, 0, Math.PI / 2]].forEach(([dx, dz, yaw, cry], si) => {
      if (ti >= 2 && si === 0) return;
      chair(k, x + dx, z + dz, cry, chairCol, 0.46, 0.5);
      if (r() < (tourney ? 0.95 : 0.6)) { const look = visitor(c, slot++, crowdStage(r, 0.25, 0.2)); k.sit(look, x + dx * 1.02, z + dz * 1.02, 0.47, yaw + (r() - 0.5) * 0.3, look.phone && r() < 0.2 ? 1 : 0, slot); }
    });
  });
  // someone browsing the shelves, the café's counter in the corner
  lineWalker(k, visitor(c, 690, crowdStage(r, 0.2, 0.2)), -2.4, -D / 2 + 0.85, 2.4, -D / 2 + 0.85, 0.35, r());
  k.box(W / 2 - 0.75, 0, D / 2 - 1.4, 0.7, 1.0, 2.2, pick(r, WOOD)); k.box(W / 2 - 0.75, 1.0, D / 2 - 1.4, 0.8, 0.04, 2.3, 0x2a2a2a);
  k.stand(staff(c, 1), W / 2 - 0.2, D / 2 - 1.2, Math.PI, 0, 2);
  // a warm lamp low over your table
  k.cyl(T.x, 1.85, T.z, 0.005, H - 1.85, 0x2a2a2a); k.cone(T.x, 1.62, T.z, 0.24, 0.24, 0x2a3a2a); k.cyl(T.x, 1.6, T.z, 0.13, 0.04, k.glow(0xffe0b0, 1.5, 'lamp'));
  k.lamp.position.set(T.x, 1.5, T.z); k.lamp.userData.max = 2.2; k.lampOn = 1;
  k.ceil.position.set(0, H - 0.4, -1.2); k.ceil.userData.max = 7; k.ceil.color.set(0xffe4c0); k.ceilOn = 0.8;
  k.daylight = 0.6; k.ambientNight = 0.15;
  const eye = new Vector3(T.x, eyeSitting(c, 0.47), T.z + 0.6);
  return {
    eye, aim: new Vector3(T.x, 0.84, T.z - 0.12),
    glances: players.map((p) => new Vector3(p.x, p.y + 1.25 * p.look.height, p.z)).concat([new Vector3(1.6, 1.3, -D / 2), new Vector3(-2.5, 1.0, -1.3)]),
    label: tourney ? 'at the games tournament' : 'playing board games',
  };
};

// ---- the escape room -------------------------------------------------------------------------

/** someone searching the room: from stop to stop (x, z, facing), a while at each going through things */
function searcher(k: Kit, look: Look, stops: [number, number, number][], r: Rng, ph: number, speed = 0.7) {
  const segs: { a: [number, number, number]; b: [number, number, number]; walk: number; stay: number }[] = [];
  let total = 0;
  for (let i = 0; i < stops.length; i++) {
    const a = stops[i], b = stops[(i + 1) % stops.length], walk = Math.hypot(b[0] - a[0], b[1] - a[1]) / speed, stay = 2.5 + r() * 3.5;
    segs.push({ a, b, walk, stay }); total += walk + stay;
  }
  k.bodies.push({ look, x: stops[0][0], y: 0, z: stops[0][1], yaw: stops[0][2], swing: 0, pose: 0, ph, move: (t, bd) => {
    let u = mod(t + ph, total);
    for (const s of segs) {
      if (u < s.walk) {
        const f = u / s.walk;
        bd.x = s.a[0] + (s.b[0] - s.a[0]) * f; bd.z = s.a[1] + (s.b[1] - s.a[1]) * f; bd.yaw = Math.atan2(-(s.b[1] - s.a[1]), s.b[0] - s.a[0]); bd.swing = 0.4; bd.pose = 0;
        return;
      }
      u -= s.walk;
      if (u < s.stay) { bd.x = s.b[0]; bd.z = s.b[1]; bd.yaw = s.b[2] + 0.25 * Math.sin(u * 0.9); bd.swing = 0; bd.pose = Math.sin(u * 1.3) > 0 ? -0.6 : 0; return; }
      u -= s.stay;
    }
  } });
}

/** in a puzzle room dressed as an old professor's study: the padlocked chest, the clock running down, the team searching */
const escape: RoomBuilder = (k, c) => {
  const S = seedOf(c), r = rng(S ^ 0xe5c);
  const W = 5.4, D = 5.2, H = 2.8;
  k.shell(W, D, H, pick(r, [0x2f4a3a, 0x4a2a2a, 0x2a3a52, 0x5a4a32]), pick(r, [0x5a3e2a, 0x6e523a]), 0xd8ccb0);
  // wood panelling round the lower walls, a rug
  const panel = pick(r, [0x5a3a22, 0x4a2e1c, 0x6a4a2a]);
  k.box(0, 0, -D / 2 + 0.03, W, 1.0, 0.06, panel); k.box(0, 0, D / 2 - 0.03, W, 1.0, 0.06, panel);
  for (const s of [-1, 1]) k.box(s * (W / 2 - 0.03), 0, 0, 0.06, 1.0, D, panel);
  k.box(0, 0, -0.1, 2.8, 0.006, 2.0, pick(r, [0x7a2a2a, 0x2a3a6a, 0x5a4a2a])); k.box(0, 0.006, -0.1, 2.4, 0.004, 1.6, pick(r, [0xb8843a, 0x8a2a3a, 0x3a5a4a]));
  // the bookcases either side of the clock
  bookshelf(k, r, -1.75, -D / 2 + 0.2, 0, 1.0, 2.3, panel); bookshelf(k, r, 1.75, -D / 2 + 0.2, 0, 1.0, 2.3, panel);
  // the clock over the desk, its hands running; the countdown over the door
  const cz = -D / 2 + 0.06;
  k.box(0, 1.65, cz + 0.04, 0.8, 0.8, 0.08, 0x4a2e1c);
  const face = k.cyl(0, 2.05, cz + 0.08, 0.33, 0.02, 0xf2e8d0); face.rotation.x = Math.PI / 2; face.position.set(0, 2.05, cz + 0.08);
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; k.box(Math.sin(a) * 0.28, 2.05 + Math.cos(a) * 0.28 - 0.02, cz + 0.105, 0.015, 0.04, 0.005, 0x2a2a2a, 0).rotation.z = -a; }
  const minute = k.box(0, 2.05, cz + 0.11, 0.018, 0.27, 0.006, 0x1a1a1a), hour = k.box(0, 2.05, cz + 0.115, 0.026, 0.18, 0.006, 0x1a1a1a);
  const second = k.box(0, 2.05, cz + 0.12, 0.006, 0.29, 0.004, 0xc02020);
  const ex = W / 2 - 0.03, dz0 = 0.75;
  k.box(ex, 0, dz0, 0.06, 2.1, 1.0, 0x3a2414); k.box(ex - 0.04, 0, dz0, 0.04, 2.0, 0.86, 0x5a3a22);
  k.ball(ex - 0.1, 1.0, dz0 - 0.32, 0.03, 0.03, 0.03, 0xc8a040);
  k.box(ex - 0.04, 2.2, dz0, 0.04, 0.16, 0.4, k.glow(0x20e060, 1.5));
  k.box(ex - 0.05, 2.42, dz0, 0.04, 0.22, 1.0, 0x0a0a0a);
  const count = k.box(ex - 0.08, 2.47, dz0, 0.02, 0.12, 0.9, k.glow(0xff2020, 1.8));
  // the keypad by the door, its light red until someone tries a code
  k.box(ex - 0.03, 1.2, dz0 + 0.75, 0.04, 0.24, 0.16, 0x2a2a2e); k.box(ex - 0.06, 1.24, dz0 + 0.75, 0.01, 0.14, 0.12, 0x8a8a90);
  const keyRed = k.glow(0xff2a1a, 1.8), keyGreen = k.glow(0x2aff4a, 1.8);
  const keyLight = k.box(ex - 0.06, 1.4, dz0 + 0.75, 0.02, 0.03, 0.03, keyRed);
  // the desk: lamp, books, papers, a magnifying glass, a candle
  const dz = -1.25;
  k.box(0, 0.72, dz, 1.7, 0.05, 0.8, 0x4a2e1c);
  for (const s of [-1, 1]) k.box(s * 0.6, 0, dz, 0.45, 0.72, 0.74, 0x3a2414);
  k.box(0, 0.2, dz - 0.3, 0.75, 0.52, 0.04, 0x3a2414);
  k.box(0.55, 0.77, dz - 0.15, 0.16, 0.03, 0.12, 0xc8a040); k.cyl(0.55, 0.8, dz - 0.15, 0.01, 0.28, 0xc8a040);
  k.box(0.55, 1.06, dz - 0.12, 0.32, 0.07, 0.13, k.glow(0x1a8a4a, 1.2, 'lamp'));
  for (let i = 0; i < 3; i++) k.box(-0.55 + (r() - 0.5) * 0.04, 0.77 + i * 0.05, dz - 0.15, 0.3, 0.05, 0.22, pick(r, [0x6a1a1a, 0x1a3a5a, 0x3a5a2a, 0x5a4a2a]), (r() - 0.5) * 0.3);
  for (let i = 0; i < 3; i++) k.box(-0.05 + i * 0.12, 0.771 + i * 0.001, dz + 0.1, 0.21, 0.002, 0.29, 0xf2ead8, (r() - 0.5) * 0.6);
  k.ball(0.15, 0.78, dz + 0.22, 0.05, 0.006, 0.05, 0xc8e0e8); k.box(0.22, 0.775, dz + 0.27, 0.12, 0.012, 0.02, 0x2a1a10, -0.6);
  k.cyl(-0.25, 0.77, dz - 0.2, 0.025, 0.12, 0xf2ead8);
  const flame = k.ball(-0.25, 0.915, dz - 0.2, 0.012, 0.022, 0.012, k.glow(0xffb040, 1.8));
  k.box(0, 0, dz - 0.75, 0.6, 0.5, 0.55, 0x5a1a1a); k.box(0, 0.5, dz - 0.98, 0.6, 0.7, 0.12, 0x5a1a1a);
  // the padlocked chest before the desk
  const chx = -1.2, chz = -0.55;
  k.box(chx, 0, chz, 0.8, 0.42, 0.48, 0x5a3a22);
  const lid = k.cyl(chx + 0.41, 0.42, chz, 0.24, 0.82, 0x6a4a2a); lid.rotation.z = Math.PI / 2;
  for (const s of [-1, 1]) k.box(chx + s * 0.25, 0, chz, 0.04, 0.43, 0.5, 0xb89040);
  k.box(chx, 0.28, chz + 0.245, 0.1, 0.12, 0.02, 0xc8a040); k.box(chx, 0.16, chz + 0.26, 0.09, 0.1, 0.03, 0x8a8a90); k.ball(chx, 0.29, chz + 0.26, 0.035, 0.04, 0.008, 0x8a8a90);
  // the globe on its stand, turning slowly
  const gx = 1.5, gz = -0.5;
  k.cyl(gx, 0, gz, 0.2, 0.03, 0x4a2e1c); k.cyl(gx, 0.03, gz, 0.03, 0.62, 0x4a2e1c);
  const tilt = k.group(gx, gz, 0, () => {});
  tilt.position.y = 0.92; tilt.rotation.z = 0.41;
  const globe = k.group(0, 0, 0, () => {
    k.ball(0, 0, 0, 0.24, 0.24, 0.24, 0x2a5a9a);
    for (let i = 0; i < 6; i++) { const a = r() * 6.28, v = (r() - 0.5) * 1.4; k.ball(Math.cos(a) * Math.cos(v) * 0.19, Math.sin(v) * 0.19, Math.sin(a) * Math.cos(v) * 0.19, 0.08 + r() * 0.04, 0.08, 0.08 + r() * 0.04, pick(r, [0x4a8a3a, 0x8a7a4a, 0x5a8a3a])); }
  });
  tilt.add(globe);
  k.box(gx - 0.005, 0.66, gz, 0.01, 0.52, 0.01, 0xc8a040);
  // paintings, a map, the hint screen, a curio cabinet
  picture(k, r, 'left', -1.5, 1.5); picture(k, r, 'left', 1.8, 1.55);
  k.onWall('right', -1.2, () => { k.box(0, 1.25, 0.02, 1.0, 0.7, 0.02, 0xe8d8b0); k.box(-0.15, 1.4, 0.035, 0.35, 0.25, 0.005, 0x8aa070); k.box(0.2, 1.35, 0.035, 0.3, 0.3, 0.005, 0x9a8a5a); });
  const hx = -W / 2 + 0.06, hzz = 0.1;
  k.box(hx + 0.18, 1.3, hzz, 0.36, 0.42, 0.52, 0x2a2a28);
  const hintBg = k.glow(0x062a12, 1);
  k.panel(hx + 0.365, 1.51, hzz, 0.44, 0.33, hintBg, Math.PI / 2);
  const hintLines = [0, 1, 2, 3].map((i) => k.box(hx + 0.37, 1.6 - i * 0.06, hzz, 0.004, 0.02, 0.3, k.glow(0x6aff8a, 1.3)));
  k.box(hx + 0.02, 0, 1.4, 0.04, 1.7, 0.8, 0x4a2e1c); k.box(hx + 0.2, 1.66, 1.4, 0.4, 0.04, 0.8, 0x4a2e1c);
  for (const s of [-1, 1]) k.box(hx + 0.2, 0, 1.4 + s * 0.39, 0.4, 1.7, 0.02, 0x4a2e1c);
  k.box(hx + 0.41, 0.2, 1.4, 0.02, 1.4, 0.76, seeThrough(k, 0xc8e0e8, 0.2));
  for (let i = 0; i < 4; i++) { const y = 0.25 + i * 0.35; k.box(hx + 0.2, y, 1.4, 0.36, 0.02, 0.76, 0x3a2414); k.ball(hx + 0.22, y + 0.09, 1.25 + r() * 0.3, 0.06, 0.08, 0.06, pick(r, [0xc8a040, 0x5a8aa0, 0xe8e0d0, 0x8a3a2a])); }
  // a ceiling lamp, warm and low
  k.cyl(0, H - 0.5, 0, 0.006, 0.5, 0x2a2a2a); k.cone(0, H - 0.72, 0, 0.26, 0.22, 0x2a3a2a); k.cyl(0, H - 0.74, 0, 0.16, 0.03, k.glow(0xffd8a0, 1.4, 'lamp'));
  // the team searching: the shelves, the desk, the chest, the globe, the keypad, the hint screen
  const team = party(c, r, 3, 700, 0.25, 0.1);
  const zones: [number, number, number][][] = [
    [[-1.9, 1.35, Math.PI], [-1.75, -1.85, Math.PI / 2], [-2.0, -0.35, Math.PI]],
    [[1.75, -1.85, Math.PI / 2], [0.95, -0.15, Math.atan2(-(gz + 0.15), gx - 0.95)], [2.1, 1.45, 0]],
    [[0.1, -0.45, Math.PI / 2], [-1.2, 0.12, Math.PI / 2], [-0.4, 0.4, Math.PI / 2 + 0.5]],
  ];
  team.forEach((look, i) => searcher(k, look, zones[i], r, r() * 30, 0.6 + r() * 0.2));
  hallLights(k, 0.42, 0.25, 0xffe4c4, 0x4a3020, 0xffe0b0, [0.3, -1, 0.2]);
  k.lamp.position.set(0.55, 1.2, dz - 0.05); k.lamp.userData.max = 2.4; k.lamp.color.set(0xffd8a0); k.lampOn = 1;
  k.ceil.position.set(0, H - 0.9, 0); k.ceil.userData.max = 5; k.ceil.color.set(0xffc890); k.ceilOn = 1;
  k.animate.push((t) => {
    minute.rotation.z = -(t / 60) * Math.PI * 2; hour.rotation.z = -(t / 720) * Math.PI * 2; second.rotation.z = -Math.floor(t) * (Math.PI / 30);
    const left = 0.9 * (0.02 + 0.98 * (1 - mod(t + S * 0.01, 300) / 300)); count.scale.z = left; count.position.z = dz0 - 0.45 + left / 2;
    flame.scale.set(1, 1 + 0.25 * Math.sin(t * 13) * Math.sin(t * 7.3), 1);
    keyLight.material = mod(t + 3, 23) > 21.5 && Math.sin(t * 18) > 0 ? keyGreen : keyRed;
    const h = mod(t, 25), typing = clamp01(h / 3);
    hintLines.forEach((m, i) => { const w = 0.3 * Math.max(0.03, clamp01(typing * 4 - i) * (0.6 + 0.4 * hash2(Math.floor(t / 25), i))); m.scale.z = w; m.position.z = hzz - 0.15 + w / 2; });
    if (h < 1.2 && Math.sin(t * 12) > 0) hintBg.color.setHex(0x1a6a2a);
    globe.rotation.y = t * 0.15;
  });
  return {
    eye: new Vector3(0.25, eyeStanding(c), 1.55), aim: new Vector3(-0.3, 0.95, -1.0),
    glances: [new Vector3(0, 2.05, cz), new Vector3(ex, 1.3, dz0 + 0.75), new Vector3(hx, 1.5, hzz), new Vector3(gx, 0.9, gz), new Vector3(ex, 2.45, dz0), new Vector3(-1.75, 1.5, -D / 2)],
    label: 'in an escape room',
  };
};

export const INDOOR_ROOMS: Partial<Record<LeisureRoom, RoomBuilder>> = { bowling, icerink, rollerdisco, climbing, trampoline, arcade, boardgames, escape };
export type { View };
