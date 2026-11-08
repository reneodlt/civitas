import type { Color, Design, Op } from './schema';
import { repeat } from './helpers';
import { slab, tree, pine, fence, lampPost, signBoard, PAVING } from './tierkit';
import { FERRIS } from '../ferris';

/**
 * Models for the days-out, arts and games free-time places (attractions.ts), keyed by the kind's
 * variable name there. Recipes are authored in tiles for the whole footprint, centred on 0,0 with +z to the road.
 * Every windowed box keeps its walls clear (docs/buildings.md "Facades"): doors, awnings and porches are placed by
 * cell, and signs, fins and shutters stand on plain wall, in margins and top bands, or beside the window frames.
 */

// ================================================================= shared parts

const rd = (v: number) => Math.round(v * 10000) / 10000;
/** Lathe profile of a dome: a quarter ellipse r across and h tall in n steps, closed at the crown. */
const dome = (r: number, h = r, n = 6): number[] => {
  const p: number[] = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * (Math.PI / 2); p.push(i === n ? 0 : rd(r * Math.cos(a)), rd(h * Math.sin(a))); }
  return p;
};
/** Lathe profile of a ball of radius r standing on its lowest point. */
const ball = (r: number, n = 8): number[] => {
  const p: number[] = [];
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI; p.push(i === 0 || i === n ? 0 : rd(r * Math.cos(a)), rd(r * (1 + Math.sin(a)))); }
  return p;
};
/** n groups of ops built from their index: `many(6, (i) => [pole, horse])`. */
const many = (n: number, f: (i: number) => Op[]): Op[] => Array.from({ length: n }, (_, i) => f(i)).flat();
/** A closed disc facing the road, t thick from z, centred on x, y. */
const disc = (x: number, y: number, z: number, r: number, color: Color, t = 0.01, sign = false, seg = 16): Op =>
  ['lathe', x, y, z, color, [0, 0, r, 0, r, t], sign ? { seg, axis: 'z', win: 'sign' } : { seg, axis: 'z' }];
const lawn = (w: number, d: number, c: Color = 'lawn'): Op => ['box', w - 0.04, 0.012, d - 0.04, 0, 0, 0, c];
const path = (w: number, d: number, x: number, z: number, c: Color = 'gravel', y = 0.012): Op => ['box', w, 0.004, d, x, y, z, c];
const bench = (x: number, z: number, y = 0.02): Op[] => [['box', 0.12, 0.025, 0.04, x, y, z, 'timber'], ['box', 0.12, 0.035, 0.012, x, y + 0.025, z - 0.018, 'timber']];
/** A small vase on a lathe, s times the size of a hand-thrown pot. */
const vase = (x: number, y: number, z: number, c: Color, s = 1): Op =>
  ['lathe', x, y, z, c, [0, 0, rd(0.014 * s), 0, rd(0.022 * s), rd(0.016 * s), rd(0.02 * s), rd(0.034 * s), rd(0.011 * s), rd(0.044 * s), rd(0.015 * s), rd(0.052 * s)], { seg: 8 }];
/** A post-and-rail pen round x0..x1, z0..z1: one rail a side and a post at each corner. */
const pen = (x0: number, x1: number, z0: number, z1: number, c: Color = 'timber', h = 0.07): Op[] => {
  const cx = rd((x0 + x1) / 2), cz = rd((z0 + z1) / 2), w = rd(x1 - x0), d = rd(z1 - z0), y = h - 0.012;
  return [
    ['box', w, 0.012, 0.012, cx, y, z0, c], ['box', w, 0.012, 0.012, cx, y, z1, c],
    ['box', 0.012, 0.012, d, x0, y, cz, c], ['box', 0.012, 0.012, d, x1, y, cz, c],
    ...[[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([x, z]): Op => ['box', 0.018, h, 0.018, x, 0.012, z, c]),
  ];
};
/** A string of lights between two poles along x at z, the bulbs glowing from dusk. */
const lights = (x0: number, x1: number, z: number, h: number, n: number, cols: Color[]): Op[] => [
  ['cyl', 0.01, 0.013, h, x0, 0.02, z, 'charcoal', 5], ['cyl', 0.01, 0.013, h, x1, 0.02, z, 'charcoal', 5],
  ['box', rd(x1 - x0), 0.005, 0.005, rd((x0 + x1) / 2), h + 0.01, z, 'charcoal'],
  ...repeat(n, (i): Op => ['box', 0.022, 0.024, 0.022, rd(x0 + ((x1 - x0) * (i + 1)) / (n + 1)), h, z, cols[i % cols.length], 'sign']),
];
/** A fair stall facing the road: counter, back board, two front posts and a canopy of n gabled stripes in two colours. */
const stall = (x: number, z: number, w: number, d: number, body: Color, c1: Color, c2: Color, n = 4): Op[] => [
  ['box', w, 0.1, rd(d * 0.45), x, 0.02, rd(z + d * 0.25), body],
  ['box', w, 0.24, 0.02, x, 0.02, rd(z - d / 2 + 0.01), body],
  ['box', 0.014, 0.24, 0.014, rd(x - w / 2 + 0.007), 0.02, rd(z + d / 2 - 0.007), 'white'],
  ['box', 0.014, 0.24, 0.014, rd(x + w / 2 - 0.007), 0.02, rd(z + d / 2 - 0.007), 'white'],
  ...repeat(n, (i): Op => ['roof', rd(w / n), 0.06, d + 0.04, rd(x - w / 2 + ((i + 0.5) * w) / n), 0.26, z, i % 2 ? c2 : c1, true]),
];

// farm animals, nose toward +x (face 1) or -x (face -1)
const sheep = (x: number, z: number, face = 1, wool: Color = 0xf1ede2): Op[] => [
  ['box', 0.075, 0.048, 0.046, x, 0.016, z, wool], ['box', 0.026, 0.03, 0.028, rd(x + face * 0.046), 0.04, z, 'charcoal'],
];
const pig = (x: number, z: number, face = 1): Op[] => [
  ['box', 0.072, 0.04, 0.044, x, 0.016, z, 0xeba3a3], ['box', 0.018, 0.022, 0.026, rd(x + face * 0.044), 0.024, z, 0xd98a8a],
];
const goat = (x: number, z: number, face = 1, coat: Color = 0xe8dcc8, y = 0.016): Op[] => [
  ['box', 0.064, 0.042, 0.034, x, y, z, coat], ['box', 0.022, 0.04, 0.024, rd(x + face * 0.04), rd(y + 0.03), z, 0x8a6a4a],
];
const pony = (x: number, z: number, face = 1, coat: Color = 0x8a5a32): Op[] => [
  ['box', 0.07, 0.05, 0.026, x, 0.016, z, 0x5a3a22],
  ['box', 0.1, 0.045, 0.04, x, 0.066, z, coat],
  ['box', 0.03, 0.07, 0.028, rd(x + face * 0.05), 0.09, z, coat],
  ['box', 0.012, 0.05, 0.012, rd(x - face * 0.054), 0.06, z, 0x3a2a1a],
];
const hen = (x: number, z: number, c: Color = 'white', y = 0.012): Op => ['box', 0.024, 0.026, 0.018, x, y, z, c];

// ================================================================= city farm (2×2, gate front left)

const BARN = 0xa8382c, BARN_DOOR = 0x8a2a22, ROOF_DARK = 0x4a4d55, HAY = 0xd9bf6a, MUD = 0x7a5a3a, COBBLE = 0x9c9486, FARM_STONE = 0xcbbf9f;

const cityFarm: Design[] = [
  { name: 'red barn with paddocks of sheep, pigs and a pony, a hen house, a duck pond and a farm shop by the gate', height: 0.73, ops: [
    lawn(2, 2),
    path(0.24, 0.92, -0.5, 0.5), path(0.85, 0.3, -0.275, -0.13),
    // the barn: red walls, white corner boards, a dark gable roof end-on to the yard, big doors and a hay loft
    ['box', 0.8, 0.34, 0.5, -0.35, 0.012, -0.6, BARN],
    ['box', 0.03, 0.34, 0.03, -0.75, 0.012, -0.35, 'white'], ['box', 0.03, 0.34, 0.03, 0.05, 0.012, -0.35, 'white'],
    ['roof', 0.88, 0.28, 0.56, -0.35, 0.352, -0.6, ROOF_DARK, true],
    ['box', 0.36, 0.27, 0.012, -0.35, 0.012, -0.344, 'white'],
    ['box', 0.155, 0.25, 0.012, -0.435, 0.012, -0.332, BARN_DOOR], ['box', 0.155, 0.25, 0.012, -0.265, 0.012, -0.332, BARN_DOOR],
    ['box', 0.14, 0.12, 0.01, -0.35, 0.37, -0.315, 'white'], ['box', 0.1, 0.09, 0.01, -0.35, 0.38, -0.307, BARN_DOOR],
    ['box', 0.09, 0.07, 0.09, -0.35, 0.6, -0.6, 'white'], ['taper', 0.11, 0.11, 0, 0, 0.06, -0.35, 0.67, -0.6, ROOF_DARK],
    ['box', 0.12, 0.06, 0.08, 0.16, 0.012, -0.42, HAY], ['box', 0.12, 0.06, 0.08, 0.16, 0.012, -0.52, HAY], ['box', 0.12, 0.06, 0.08, 0.16, 0.072, -0.47, HAY],
    // sheep paddock behind, pigs and a pony in front, split by a rail
    ['box', 0.64, 0.003, 0.64, 0.625, 0.012, -0.625, 'lawnDark'],
    ...pen(0.3, 0.95, -0.95, -0.3),
    // (the sheep wander the paddock in the client's animation pass, render/leisureRigs.ts)
    ['box', 0.29, 0.003, 0.45, 0.45, 0.012, 0.21, MUD],
    ...pen(0.3, 0.95, -0.02, 0.44), ['box', 0.012, 0.012, 0.46, 0.6, 0.058, 0.21, 'timber'],
    ['roof', 0.12, 0.08, 0.14, 0.38, 0.015, 0.06, 'corrugated', true],
    // (the pigs and the pony move about their pens in the client's animation pass)
    // duck pond
    ['cyl', 0.21, 0.21, 0.014, 0.62, 0.012, 0.72, 'stone', 18], ['cyl', 0.18, 0.18, 0.016, 0.62, 0.012, 0.72, 'pond', 18],
    // (the ducks paddle round it in the client's animation pass)
    // hen house on legs, hens scratching about
    ['box', 0.16, 0.05, 0.1, -0.82, 0.012, -0.1, 'timber'], ['box', 0.2, 0.1, 0.13, -0.82, 0.062, -0.1, 0xb08a5a],
    ['roof', 0.22, 0.06, 0.15, -0.82, 0.162, -0.1, ROOF_DARK],
    // (the hens scratch about in the client's animation pass)
    // the farm shop by the gate: door to the path, awning to the road
    ['box', 0.28, 0.2, 0.3, -0.82, 0.012, 0.6, 'cream', true, { name: 'shop', facade: { storeys: 1, bays: 2, sideBays: 2 } }],
    ['roof', 0.32, 0.12, 0.34, -0.82, 0.212, 0.6, 'terracotta'],
    ['door', 'shop', 'right', 0, 'green'], ['awning', 'shop', 'front', 0, 1, 'boxGreen'],
    // gate, name board and hedges along the road
    ['box', 0.04, 0.2, 0.04, -0.64, 0.012, 0.95, 'timber'], ['box', 0.04, 0.2, 0.04, -0.36, 0.012, 0.95, 'timber'],
    ['box', 0.34, 0.06, 0.02, -0.5, 0.17, 0.95, 'cream'], ['box', 0.24, 0.02, 0.004, -0.5, 0.19, 0.962, 'green'],
    ['box', 0.3, 0.07, 0.05, -0.82, 0.012, 0.95, 'hedge'], ['box', 1.32, 0.07, 0.05, 0.32, 0.012, 0.95, 'hedge'],
    ...tree(-0.88, -0.88, 1.0), ...tree(0.15, -0.9, 0.9),
    ['box', 0.16, 0.012, 0.09, -0.2, 0.06, 0.55, 'timber'], ['box', 0.1, 0.048, 0.02, -0.2, 0.012, 0.55, 'timber'],
    ['box', 0.16, 0.035, 0.03, -0.2, 0.012, 0.48, 'timber'], ['box', 0.16, 0.035, 0.03, -0.2, 0.012, 0.62, 'timber'],
  ] },
  { name: 'farmyard round a cobbled yard with a stone farmhouse café, a polytunnel, a byre, goats and a red tractor', height: 0.75, ops: [
    lawn(2, 2),
    ['box', 1.2, 0.006, 0.8, -0.2, 0.012, 0.0, COBBLE],
    ['box', 0.3, 0.002, 0.24, -0.5, 0.018, -0.12, 0xa8a092], ['box', 0.26, 0.002, 0.2, 0.12, 0.018, 0.22, 0x8f887c], ['box', 0.22, 0.002, 0.18, -0.1, 0.018, -0.26, 0xa8a092],
    path(0.24, 0.56, -0.5, 0.68),
    // stone farmhouse café: tea room downstairs, a door and an awning to the yard
    ['box', 0.84, 0.44, 0.36, -0.48, 0.012, -0.72, FARM_STONE, true, { name: 'house', facade: { storeys: 2, bays: 4, sideBays: 2 } }],
    ['roof', 0.9, 0.22, 0.42, -0.48, 0.452, -0.72, 'slate'],
    ['box', 0.08, 0.3, 0.08, -0.86, 0.452, -0.72, FARM_STONE], ['box', 0.08, 0.3, 0.08, -0.1, 0.452, -0.72, FARM_STONE],
    ['door', 'house', 'front', 1, 'green'], ['awning', 'house', 'front', 2, 3, 0x2f6a4f],
    ...[-0.7, -0.35].flatMap((x): Op[] => [
      ['cyl', 0.03, 0.03, 0.05, x, 0.018, -0.36, 'white', 8], ['cyl', 0.004, 0.004, 0.13, x, 0.068, -0.36, 'steel', 4], ['cone', 0.07, 0.035, x, 0.198, -0.36, 0xe8dcc0, 8],
    ]),
    // polytunnel of milky plastic, raised beds in front
    ['taper', 0.44, 0.6, 0.32, 0.6, 0.1, 0.22, 0.012, -0.62, 0xe9eef0], ['taper', 0.32, 0.6, 0.12, 0.6, 0.08, 0.22, 0.112, -0.62, 0xe9eef0],
    ['box', 0.08, 0.13, 0.008, 0.22, 0.012, -0.316, 0x6a7a70],
    ['box', 0.16, 0.04, 0.07, 0.1, 0.012, -0.22, 'timber'], ['box', 0.16, 0.04, 0.07, 0.34, 0.012, -0.22, 'timber'],
    ['box', 0.14, 0.02, 0.05, 0.1, 0.052, -0.22, 'lawnDark'], ['box', 0.14, 0.02, 0.05, 0.34, 0.052, -0.22, 0x7a9c3a],
    // timber byre with half-doors to the yard, hay at its gable
    ['box', 0.36, 0.26, 0.62, 0.74, 0.012, -0.6, 0x6b4a32], ['roof', 0.42, 0.14, 0.66, 0.74, 0.272, -0.6, 'rust', true],
    ['box', 0.008, 0.16, 0.14, 0.556, 0.012, -0.75, 'charcoal'], ['box', 0.008, 0.16, 0.14, 0.556, 0.012, -0.45, 'charcoal'],
    ['box', 0.12, 0.06, 0.08, 0.86, 0.012, -0.2, HAY], ['box', 0.12, 0.06, 0.08, 0.86, 0.072, -0.2, HAY],
    // goat pen with a climbing tower
    ...pen(0.3, 0.95, 0.04, 0.6),
    ['box', 0.12, 0.08, 0.12, 0.8, 0.012, 0.16, 'timber'], ['taper', 0.05, 0.12, 0.05, 0.02, 0.08, 0.8, 0.012, 0.27, 'timber', { shift: [0, -0.05] }],
    // (the goats wander the pen in the client's animation pass, render/leisureRigs.ts)
    // red tractor parked in the yard
    ['wheel', 0.045, 0.12, -0.2, 0.063, 0.1, 'charcoal'], ['wheel', 0.028, 0.1, -0.2, 0.046, 0.21, 'charcoal'],
    ['box', 0.08, 0.09, 0.07, -0.2, 0.06, 0.1, 'red'], ['box', 0.07, 0.05, 0.1, -0.2, 0.05, 0.19, 'red'],
    ['box', 0.09, 0.01, 0.08, -0.2, 0.15, 0.1, 'white'], ['cyl', 0.006, 0.006, 0.06, -0.18, 0.1, 0.22, 'charcoal', 5],
    // (the hens scratch about the yard in the client's animation pass)
    // stone gateposts, the farm sign, hedges along the road
    ['box', 0.06, 0.16, 0.06, -0.66, 0.012, 0.95, 'stone'], ['box', 0.06, 0.16, 0.06, -0.34, 0.012, 0.95, 'stone'],
    ['lathe', -0.66, 0.172, 0.95, 'stone', ball(0.03), { seg: 10 }], ['lathe', -0.34, 0.172, 0.95, 'stone', ball(0.03), { seg: 10 }],
    ...signBoard(-0.85, 0.88, 0.2, 'green', 'cream', 0.012, 0.18),
    ['box', 0.26, 0.07, 0.05, -0.84, 0.012, 0.95, 'hedge'], ['box', 1.28, 0.07, 0.05, 0.34, 0.012, 0.95, 'hedge'],
    ...tree(-0.9, 0.5, 0.9), ...tree(0.15, 0.8, 0.8),
  ] },
];

// ================================================================= aquarium (2×2, doors front left)

const SEA = 0x2d6fa3, SURF = 0xeef3f6, SURF2 = 0xd9e7ef, WHALE = 0x3f6fae, CLOWN = 0xf08a2e, DEEP = 0x1f3c6e, AQUA = 0x7fd0e0, GLOW_AQUA = 0x5fd6e8, FIN = 0x6a7480;
/** A porthole on the front (+z) or right (+x) wall: a silver rim and a glass that glows aqua from dusk. */
const porthole = (x: number, y: number, z: number, right = false): Op[] => right
  ? [['lathe', x, y, z, 'silver', [0, 0, 0.065, 0, 0.065, 0.012], { seg: 14, axis: 'x' }], ['lathe', x + 0.012, y, z, GLOW_AQUA, [0, 0, 0.048, 0, 0.048, 0.006], { seg: 14, axis: 'x', win: 'sign' }]]
  : [disc(x, y, z, 0.065, 'silver', 0.012, false, 14), disc(x, y, z + 0.012, 0.048, GLOW_AQUA, 0.006, true, 14)];

const aquarium: Design[] = [
  { name: 'wave-roofed aquarium of deep-blue glass with a curved glass entrance, a clownfish sign and a whale fountain', height: 0.64, ops: [
    slab(2, 2, PAVING),
    ['box', 1.6, 0.46, 1.0, 0.15, 0.02, -0.42, SEA, true, { name: 'hall', facade: { storeys: 2, bays: 8, sideBays: 5, ground: 'plain' } }],
    // the wave: strips across the roof rising and falling
    ...repeat(8, (i): Op => ['box', 0.2, rd(0.05 + 0.055 * (1 + Math.sin(i * 0.85 + 0.4))), 1.06, rd(-0.55 + i * 0.2), 0.48, -0.42, i % 2 ? SURF2 : SURF]),
    // curved glass entrance drum with a glowing band, its doors to the road
    ['lathe', -0.4, 0.02, 0.08, 'glass', [0.24, 0, 0.24, 0.2], { seg: 16, win: 'office' }],
    ['lathe', -0.4, 0.2, 0.08, 0x46c8e8, [0.245, 0, 0.245, 0.02], { seg: 16, win: 'sign' }],
    ['cyl', 0.25, 0.25, 0.025, -0.4, 0.22, 0.08, 'white', 16],
    ['box', 0.1, 0.15, 0.01, -0.4, 0.02, 0.325, 'glassDark'],
    // clownfish sign on the drum
    ['cyl', 0.008, 0.008, 0.035, -0.5, 0.245, 0.22, 'steel', 4], ['cyl', 0.008, 0.008, 0.05, -0.37, 0.245, 0.22, 'steel', 4],
    ['lathe', -0.56, 0.335, 0.22, CLOWN, [0, 0, 0.045, 0.03, 0.06, 0.09, 0.045, 0.19, 0.012, 0.25], { seg: 10, axis: 'x', win: 'sign' }],
    ['lathe', -0.48, 0.335, 0.22, 'white', [0, 0, 0.062, 0, 0.062, 0.022, 0, 0.022], { seg: 10, axis: 'x' }],
    ['box', 0.04, 0.1, 0.012, -0.29, 0.285, 0.22, CLOWN, 'sign'],
    ['box', 0.012, 0.012, 0.006, -0.535, 0.35, 0.257, 'charcoal'],
    // whale fountain in a round pool
    ['cyl', 0.32, 0.33, 0.04, 0.5, 0.02, 0.55, 'stone', 20], ['cyl', 0.29, 0.29, 0.042, 0.5, 0.02, 0.55, 'pond', 20],
    ['lathe', 0.3, 0.1, 0.55, WHALE, [0, 0, 0.06, 0.03, 0.085, 0.1, 0.08, 0.2, 0.05, 0.3, 0.02, 0.38], { seg: 12, axis: 'x' }],
    ['box', 0.05, 0.016, 0.18, 0.7, 0.12, 0.55, WHALE],
    ['box', 0.012, 0.012, 0.006, 0.34, 0.12, 0.613, 'charcoal'],
    ['cyl', 0.008, 0.012, 0.1, 0.36, 0.17, 0.55, 0xcfe8ff, 6], ['lathe', 0.36, 0.27, 0.55, 0xe6f4ff, [0, 0, 0.05, 0.05, 0.06, 0.06], { seg: 10 }],
    path(0.3, 0.62, -0.4, 0.66, 'stone', 0.02),
    ...tree(-0.86, 0.78, 0.9), ...tree(0.88, 0.86, 0.8), ...tree(-0.88, 0.3, 0.75),
    ...bench(0.05, 0.85), ...bench(0.95 - 0.12, 0.2),
  ] },
  { name: 'dark-blue aquarium with porthole windows under a glass pyramid atrium, with shark fins in a pool', height: 1.01, ops: [
    slab(2, 2, PAVING),
    ['box', 1.6, 0.34, 1.3, 0.1, 0.02, -0.3, DEEP],
    ['box', 1.62, 0.04, 1.32, 0.1, 0.36, -0.3, AQUA],
    ...porthole(0.0, 0.18, 0.35), ...porthole(0.3, 0.18, 0.35), ...porthole(0.6, 0.18, 0.35),
    ...porthole(0.9, 0.18, -0.7, true), ...porthole(0.9, 0.18, -0.35, true), ...porthole(0.9, 0.18, 0.0, true),
    ['box', 0.56, 0.07, 0.012, 0.4, 0.27, 0.356, 0xbff0ff, 'sign'],
    // glass entrance with a rounded canopy
    ['box', 0.44, 0.26, 0.2, -0.42, 0.02, 0.45, 'glass', true, { name: 'entry', facade: { storeys: 1, bays: 3, sideBays: 1, ground: 'door' } }],
    ['lathe', -0.64, 0.28, 0.45, AQUA, [0, 0, 0.08, 0, 0.08, 0.44, 0, 0.44], { seg: 12, axis: 'x' }],
    // glass pyramid and two small domes
    ['taper', 1.0, 0.9, 0, 0, 0.55, 0.15, 0.4, -0.35, 'glass', { win: 'office' }],
    ['cyl', 0.012, 0.016, 0.06, 0.15, 0.95, -0.35, 'gold', 6],
    ['lathe', -0.52, 0.4, -0.62, 'glass', dome(0.15, 0.13), { seg: 14, win: 'office' }],
    ['lathe', 0.77, 0.4, -0.72, 'glass', dome(0.12, 0.1), { seg: 12, win: 'office' }],
    // shark pool and wave paving
    ['box', 0.6, 0.035, 0.36, 0.5, 0.02, 0.72, 'stone'], ['box', 0.54, 0.037, 0.3, 0.5, 0.02, 0.72, 'pond'],
    ['taper', 0.03, 0.2, 0.004, 0.03, 0.18, 0.42, 0.057, 0.74, FIN, { shift: [0, -0.08] }],
    ['taper', 0.025, 0.14, 0.004, 0.02, 0.12, 0.64, 0.057, 0.68, FIN, { shift: [0, -0.06] }],
    ['box', 1.0, 0.003, 0.05, -0.35, 0.02, 0.8, 0x5fa8d6], ['box', 1.0, 0.003, 0.05, -0.2, 0.02, 0.9, 0x3f88c6],
    ...tree(-0.86, 0.76, 0.9), ...tree(0.88, 0.86, 0.8),
    ['flag', -0.9, 0.02, 0.5, 0x2f8fd6], ['flag', -0.74, 0.02, 0.56, CLOWN], ['flag', -0.58, 0.02, 0.62, 0x2f8fd6],
    ...bench(0.15, 0.52),
  ] },
];

// ================================================================= planetarium (2×2, doors front left)

const NIGHT = 0x22305e, MIDNIGHT = 0x1d2550, STAR = 0xfff6d8, STAR2 = 0xffd27a;
const planetarium: Design[] = [
  { name: 'white dome on a drum with a glass foyer, a star-map plaza and a ringed-planet sign', height: 0.97, ops: [
    slab(2, 2, PAVING),
    ['box', 0.5, 0.004, 1.1, -0.7, 0.02, -0.35, 'lawn'],
    ['cyl', 0.6, 0.6, 0.34, 0.2, 0.02, -0.35, 0xe9e5dc, 28], ['cyl', 0.62, 0.62, 0.04, 0.2, 0.36, -0.35, 'stone', 28],
    ['lathe', 0.2, 0.4, -0.35, 0xf3f3ef, dome(0.58, 0.5, 7), { seg: 28, stripe: 0xd7dce2, every: 4, width: 1 }],
    ['cyl', 0.02, 0.025, 0.07, 0.2, 0.9, -0.35, 'gold', 6],
    // foyer: a stone body behind a glass front, door in the middle
    ['box', 0.8, 0.28, 0.36, -0.5, 0.02, 0.5, 'stone'],
    ['box', 0.72, 0.28, 0.04, -0.5, 0.02, 0.7, 'glass', true, { name: 'foyer', facade: { storeys: 1, bays: 5, sideBays: 0, ground: 'door' } }],
    ['box', 0.86, 0.03, 0.44, -0.5, 0.3, 0.52, 'white'],
    path(0.24, 0.22, -0.5, 0.86, 'stone', 0.02),
    // star map set into the plaza, and a ringed planet on a pole over it
    ['cyl', 0.3, 0.3, 0.006, 0.5, 0.02, 0.62, NIGHT, 24],
    ...[[0.36, 0.5], [0.62, 0.48], [0.42, 0.78], [0.66, 0.74], [0.3, 0.66], [0.72, 0.6]].map(([x, z], i): Op => ['box', 0.02, 0.004, 0.02, x, 0.026, z, i % 2 ? STAR2 : STAR, 'sign']),
    ['cyl', 0.014, 0.018, 0.42, 0.5, 0.026, 0.62, 'steel', 6],
    ['lathe', 0.5, 0.446, 0.62, 0xe0a050, ball(0.09, 8), { seg: 14 }],
    ['lathe', 0.5, 0.53, 0.62, 'gold', [0, 0, 0.18, 0, 0.18, 0.012], { seg: 20, win: 'sign' }],
    // a telescope on a plinth on the lawn
    ['box', 0.16, 0.03, 0.16, -0.7, 0.024, -0.2, 'stone'], ['cone', 0.06, 0.12, -0.7, 0.054, -0.2, 'charcoal', 5],
    ['taper', 0.05, 0.05, 0.07, 0.07, 0.22, -0.72, 0.15, -0.2, 'white', { shift: [0.12, 0.02] }],
    ...tree(-0.82, -0.78, 0.9), ...pine(-0.56, -0.7, 0.9), ...tree(-0.86, 0.86, 0.75),
    ...bench(0.88, 0.3), ...lampPost(0.1, 0.9, 0.32, 'marquee'),
  ] },
  { name: 'midnight-blue cube with a band of stars, a golden dome, a crescent moon and an orrery', height: 1.28, ops: [
    slab(2, 2, PAVING),
    ['box', 1.2, 0.62, 1.2, 0.25, 0.02, -0.35, MIDNIGHT],
    ['box', 1.22, 0.14, 1.22, 0.25, 0.4, -0.35, 0x111838],
    ...[[-0.25, 0.43], [-0.08, 0.5], [0.06, 0.44], [0.2, 0.51], [0.36, 0.45], [0.52, 0.5], [0.7, 0.43]].map(([x, y], i): Op => ['box', 0.022, 0.022, 0.006, x, y, 0.263, i % 3 ? STAR : STAR2, 'sign']),
    ...[[-0.8, 0.47], [-0.55, 0.43], [-0.3, 0.5], [-0.05, 0.44], [0.12, 0.49]].map(([z, y], i): Op => ['box', 0.006, 0.022, 0.022, 0.863, y, z, i % 2 ? STAR2 : STAR, 'sign']),
    ['box', 1.24, 0.03, 1.24, 0.25, 0.64, -0.35, 'gold'],
    ['cyl', 0.44, 0.44, 0.07, 0.25, 0.67, -0.35, 0xc9a24a, 24],
    ['lathe', 0.25, 0.74, -0.35, 'gold', dome(0.42, 0.4, 7), { seg: 24, stripe: 0xb8923a, every: 3, width: 1 }],
    ['lathe', 0.25, 1.14, -0.35, 'gold', ball(0.03), { seg: 10 }], ['cyl', 0.006, 0.006, 0.08, 0.25, 1.2, -0.35, 'gold', 4],
    ['box', 0.7, 0.06, 0.012, 0.25, 0.3, 0.256, 0xfff0c8, 'sign'],
    disc(0.65, 0.17, 0.25, 0.08, 'gold', 0.01, true), disc(0.68, 0.18, 0.26, 0.068, MIDNIGHT, 0.004),
    // glass entrance pavilion, its gold canopy reaching the cube
    ['box', 0.48, 0.26, 0.38, -0.7, 0.02, 0.4, 'glass', true, { name: 'entry', facade: { storeys: 1, bays: 3, sideBays: 2, ground: 'door' } }],
    ['box', 0.61, 0.03, 0.42, -0.655, 0.28, 0.4, 'gold'],
    // an orrery in the plaza
    ['cyl', 0.05, 0.07, 0.18, 0.55, 0.02, 0.65, 'stone', 8],
    ['lathe', 0.55, 0.2, 0.65, 'gold', ball(0.06), { seg: 12, win: 'sign' }],
    ['box', 0.34, 0.008, 0.008, 0.55, 0.255, 0.65, 'steel'], ['lathe', 0.71, 0.263, 0.65, 0x5f9fd6, ball(0.025), { seg: 10 }],
    ['box', 0.008, 0.008, 0.26, 0.55, 0.29, 0.65, 'steel'], ['lathe', 0.55, 0.298, 0.53, 0xd9752b, ball(0.02), { seg: 10 }],
    ['box', 0.6, 0.05, 0.06, -0.55, 0.02, 0.92, 'hedge'], ...tree(0.88, 0.88, 0.8), ...pine(-0.85, -0.8, 1.0),
    ...lampPost(-0.2, 0.78, 0.3, 0x8fb8ff), ...lampPost(0.2, 0.78, 0.3, 0x8fb8ff),
  ] },
];

// ================================================================= science centre (2×2, doors front left)

const ORANGE = 0xe0662e, TEAL = 0x2fa7a0, SUN = 0xf2c230, DNA_RED = 0xe0402e, DNA_BLUE = 0x2f6fd6;
const scienceCentre: Design[] = [
  { name: 'three coloured blocks with a giant silver sphere, a glass entrance and a DNA-helix sculpture', height: 0.76, ops: [
    slab(2, 2, PAVING),
    ['box', 0.45, 0.56, 1.04, -0.075, 0.02, -0.4, ORANGE, true, { name: 'a', facade: { storeys: 2, bays: 2, sideBays: 0, top: 0.06 } }],
    ['box', 0.4, 0.46, 1.04, 0.35, 0.02, -0.4, TEAL, true, { name: 'b', facade: { storeys: 2, bays: 2, sideBays: 0 } }],
    ['box', 0.4, 0.66, 1.04, 0.75, 0.02, -0.4, SUN, true, { name: 'c', facade: { storeys: 2, bays: 2, sideBays: 0, top: 0.08 } }],
    ['box', 0.45, 0.03, 1.06, -0.075, 0.58, -0.4, 'white'], ['box', 0.4, 0.03, 1.06, 0.35, 0.48, -0.4, 'white'], ['box', 0.4, 0.03, 1.06, 0.75, 0.68, -0.4, 'white'],
    ['box', 0.34, 0.05, 0.01, 0.75, 0.615, 0.125, 0xfff4d0, 'sign'],
    // the sphere on its plinth
    ['cyl', 0.16, 0.18, 0.06, -0.62, 0.02, -0.4, 'grey', 12],
    ['lathe', -0.62, 0.08, -0.4, 'silver', ball(0.34, 10), { seg: 18, stripe: 0xaeb6c0, every: 2, width: 1 }],
    // glass entrance with a red canopy
    ['box', 0.6, 0.24, 0.28, -0.62, 0.02, 0.3, 'glass', true, { name: 'entry', facade: { storeys: 1, bays: 4, sideBays: 2, ground: 'door' } }],
    ['box', 0.66, 0.03, 0.34, -0.62, 0.26, 0.3, DNA_RED],
    // DNA helix: two strands spiralling round a white spine
    ['cyl', 0.09, 0.1, 0.03, 0.55, 0.02, 0.5, 'grey', 12], ['cyl', 0.02, 0.02, 0.5, 0.55, 0.05, 0.5, 'white', 6],
    ...repeat(16, (i): Op => {
      const s = i % 2, k = (i - s) / 2, a = k * 0.8 + s * Math.PI;
      return ['box', 0.03, 0.03, 0.03, rd(0.55 + 0.045 * Math.sin(a)), rd(0.07 + k * 0.055), rd(0.5 + 0.045 * Math.cos(a)), s ? DNA_BLUE : DNA_RED];
    }),
    // coloured dots in the paving, trees and bike racks
    ['cyl', 0.1, 0.1, 0.004, 0.0, 0.02, 0.62, DNA_RED, 14], ['cyl', 0.08, 0.08, 0.004, -0.25, 0.02, 0.8, DNA_BLUE, 14], ['cyl', 0.07, 0.07, 0.004, 0.2, 0.02, 0.85, SUN, 14],
    ...tree(0.88, 0.86, 0.8), ...tree(-0.86, 0.82, 0.8),
    ...repeat(3, (i): Op => ['box', 0.008, 0.05, 0.08, rd(0.82 + i * 0.05), 0.02, 0.4, 'steel']),
  ] },
  { name: 'converted brick works with a saw-tooth roof, a tall chimney, a glass entrance and a rocket on its pad', height: 1.02, ops: [
    slab(2, 2, PAVING),
    ['box', 1.5, 0.4, 1.1, 0.2, 0.02, -0.4, 'brick', true, { name: 'hall', facade: { storeys: 1, bays: 7, sideBays: 5, ground: 'plain' } }],
    // saw-tooth roof, its glazed faces to the road
    ...many(5, (i) => {
      const zc = rd(-0.84 + i * 0.22);
      return [['taper', 1.5, 0.22, 1.5, 0.02, 0.15, 0.2, 0.42, zc, 'slate', { shift: [0, 0.1] }], ['box', 1.46, 0.13, 0.008, 0.2, 0.425, rd(zc + 0.115), 0xa8d4ee]];
    }),
    ['cyl', 0.05, 0.07, 1.0, -0.78, 0.02, -0.78, 'brick', 10], ['cyl', 0.06, 0.06, 0.04, -0.78, 0.92, -0.78, 'charcoal', 10],
    // the old loading doors and the painted name on the plain front
    ['box', 0.2, 0.28, 0.012, 0.25, 0.02, 0.156, 0x2f6a4f], ['box', 0.2, 0.28, 0.012, 0.65, 0.02, 0.156, 0x2f6a4f],
    ['box', 0.9, 0.07, 0.012, 0.45, 0.32, 0.156, 0xfff4d0, 'sign'],
    // glass entrance box, front left
    ['box', 0.5, 0.3, 0.24, -0.3, 0.02, 0.27, 'glass', true, { name: 'entry', facade: { storeys: 1, bays: 3, sideBays: 2, ground: 'door' } }],
    ['box', 0.5, 0.025, 0.28, -0.3, 0.32, 0.27, ORANGE],
    // the rocket, its fins and gantry
    ['cyl', 0.17, 0.18, 0.03, 0.6, 0.02, 0.62, 'grey', 12],
    ['box', 0.24, 0.12, 0.014, 0.6, 0.05, 0.62, 'red'], ['box', 0.014, 0.12, 0.24, 0.6, 0.05, 0.62, 'red'],
    ['lathe', 0.6, 0.05, 0.62, 'white', [0, 0, 0.055, 0, 0.065, 0.1, 0.065, 0.48, 0.05, 0.58, 0.022, 0.66, 0, 0.7], { seg: 12 }],
    ['lathe', 0.6, 0.4, 0.62, 'red', [0.067, 0, 0.067, 0.05], { seg: 12 }],
    disc(0.6, 0.47, 0.683, 0.025, 0x8fd0ff, 0.006, true, 12),
    ['box', 0.05, 0.65, 0.05, 0.84, 0.02, 0.62, 'boxOrange'], ['box', 0.16, 0.02, 0.03, 0.75, 0.5, 0.62, 'boxOrange'],
    ...tree(-0.86, 0.8, 0.85), ...tree(0.9, 0.3, 0.75), ...bench(-0.1, 0.72), ...bench(0.15, 0.85),
  ] },
];

// ================================================================= observatory (1×1)

const observatory: Design[] = [
  { name: 'white round observatory with a slit dome, a telescope poking out and a railed viewing terrace', height: 0.62, ops: [
    lawn(1, 1),
    path(0.16, 0.24, -0.08, 0.36, 'stone'),
    ['cyl', 0.26, 0.27, 0.04, -0.08, 0.012, -0.1, 'stone', 16],
    ['lathe', -0.08, 0.052, -0.1, 0xf2f0ea, [0.22, 0, 0.22, 0.3], { seg: 16, win: 'civic' }],
    ['cyl', 0.235, 0.235, 0.025, -0.08, 0.352, -0.1, 'stone', 16],
    // (the dome, one dark gore its observing slit with the telescope poking out, turns to the sky in the client's animation pass, render/leisureRigs.ts)
    // porch with a pediment, step
    ['box', 0.16, 0.2, 0.1, -0.08, 0.052, 0.14, 'white'], ['roof', 0.18, 0.06, 0.12, -0.08, 0.252, 0.14, 'stone', true],
    ['box', 0.07, 0.14, 0.006, -0.08, 0.052, 0.193, 'door'], ['box', 0.16, 0.02, 0.06, -0.08, 0.012, 0.21, 'stone'],
    // viewing terrace with railings and a coin telescope
    ['box', 0.26, 0.07, 0.42, 0.3, 0.012, -0.02, 'stone'],
    ['box', 0.12, 0.012, 0.012, 0.36, 0.13, 0.184, 'charcoal'], ['box', 0.012, 0.012, 0.42, 0.424, 0.13, -0.02, 'charcoal'], ['box', 0.26, 0.012, 0.012, 0.3, 0.13, -0.224, 'charcoal'],
    ...[[0.424, 0.184], [0.424, -0.224], [0.176, -0.224], [0.3, 0.184]].map(([x, z]): Op => ['box', 0.012, 0.06, 0.012, x, 0.082, z, 'charcoal']),
    ['cyl', 0.008, 0.01, 0.08, 0.32, 0.082, 0.06, 'steel', 5], ['box', 0.04, 0.03, 0.06, 0.32, 0.162, 0.06, 0x2f8fd6],
    ['box', 0.1, 0.035, 0.05, 0.235, 0.012, 0.215, 'stone'],
    ...signBoard(-0.32, 0.38, 0.18, 0x3a3f5a, 'white', 0.012, 0.18),
    ...pine(-0.38, -0.38, 1.1), ...pine(0.38, -0.38, 0.9), ...lampPost(0.08, 0.4, 0.22, 'marquee'),
  ] },
  { name: 'brick tower with a copper slit dome, a weather mast and a roof terrace on its wing', height: 0.96, ops: [
    lawn(1, 1),
    path(0.12, 0.36, -0.1, 0.3, 'stone'),
    ['box', 0.36, 0.69, 0.36, -0.1, 0.012, -0.1, 'brick', 'civic', { name: 'tower', facade: { storeys: 3, bays: 2, sideBays: 2, ground: 'door' } }],
    ['box', 0.3, 0.23, 0.36, 0.23, 0.012, -0.1, 'brick', 'civic', { name: 'wing', facade: { storeys: 1, bays: 2, sideBays: 2 } }],
    // terrace railings on the wing, kept clear of the tower wall, and a coin telescope
    ['box', 0.25, 0.012, 0.012, 0.245, 0.29, 0.07, 'charcoal'], ['box', 0.012, 0.012, 0.34, 0.37, 0.29, -0.1, 'charcoal'], ['box', 0.25, 0.012, 0.012, 0.245, 0.29, -0.27, 'charcoal'],
    ...[[0.12, 0.07], [0.37, 0.07], [0.37, -0.27], [0.12, -0.27]].map(([x, z]): Op => ['box', 0.012, 0.06, 0.012, x, 0.242, z, 'charcoal']),
    ['cyl', 0.008, 0.01, 0.08, 0.28, 0.242, -0.1, 'steel', 5], ['box', 0.04, 0.03, 0.06, 0.28, 0.322, -0.1, 0x2f8fd6],
    // the top: cornice, drum, copper dome with its slit and the telescope tip
    ['cornice', 'tower', 3, 'stone'],
    ['cyl', 0.14, 0.14, 0.05, -0.1, 0.732, -0.1, 'cream', 14],
    // (the copper dome and its telescope turn to the sky in the client's animation pass)
    ['cyl', 0.006, 0.008, 0.2, 0.06, 0.732, 0.06, 'steel', 5], ['box', 0.1, 0.008, 0.008, 0.06, 0.87, 0.06, 'steel'], ['box', 0.008, 0.008, 0.1, 0.06, 0.9, 0.06, 'steel'],
    ['cyl', 0.01, 0.01, 0.02, 0.06, 0.932, 0.06, 'red', 5],
    // garden: sundial, bench, hedges, a tree
    ['cyl', 0.03, 0.04, 0.1, 0.25, 0.012, 0.3, 'stone', 6], ['cyl', 0.05, 0.05, 0.01, 0.25, 0.112, 0.3, 'gold', 12],
    ['taper', 0.006, 0.05, 0.006, 0, 0.04, 0.25, 0.122, 0.3, 'charcoal'],
    ...bench(-0.32, 0.22, 0.012),
    ['box', 0.3, 0.06, 0.05, -0.3, 0.012, 0.44, 'hedge'], ['box', 0.26, 0.06, 0.05, 0.3, 0.012, 0.44, 'hedge'],
    ...tree(-0.38, -0.36, 0.85),
    ...signBoard(0.3, 0.16, 0.16, 0x3a3f5a, 'white', 0.012, 0.16),
  ] },
];

// ================================================================= funfair (3×3, gate front middle)

const { hubX: HX, hubY: HY, hubZ: HZ, legSpread: LS } = FERRIS;
/**
 * The Ferris wheel's fixed parts (shared/src/ferris.ts): two A-frames either side of the wheel, their braces and
 * bearings, the axle through the hub, the hub drum, and the low boarding platform under the wheel's lowest gondola
 * with a step out between the front legs. The client's wheel pass draws the rim, spokes and gondolas turning; nothing
 * else stands in their disc.
 */
const ferrisFrame = (steel: Color, hub: Color, deck: Color): Op[] => {
  const foot = 0.6, top = HY + 0.04, out: Op[] = [];
  for (const zl of [HZ - LS, HZ + LS]) {
    for (const s of [-1, 1]) out.push(['taper', 0.06, 0.06, 0.04, 0.04, rd(top - 0.02), rd(HX + s * foot), 0.02, zl, steel, { shift: [rd(-s * foot), 0] }]);
    for (const yb of [0.5, 1.0]) out.push(['box', rd(2 * foot * (1 - (yb - 0.02) / (top - 0.02))), 0.025, 0.025, HX, yb, zl, steel]);
    out.push(['lathe', HX, HY, rd(zl - 0.035), hub, [0, 0, 0.05, 0, 0.05, 0.07, 0, 0.07], { seg: 10, axis: 'z' }]);
  }
  // the axle through both bearings, swelling into the hub drum at the wheel's plane
  const a = rd(LS - 0.01), b = rd(LS + 0.13), len = rd(2 * LS + 0.12);
  out.push(['lathe', HX, HY, rd(HZ - LS - 0.06), steel, [0, 0, 0.025, 0, 0.025, a, 0.08, a, 0.08, b, 0.025, b, 0.025, len, 0, len], { seg: 12, axis: 'z', stripe: hub, every: 2, width: 1 }]);
  out.push(['box', 0.56, 0.03, 0.42, HX, 0.02, HZ, deck]);
  out.push(['box', 0.3, 0.015, 0.2, HX, 0.02, rd(HZ + 0.31), deck]);
  return out;
};
/** The wheel's ticket booth: a little kiosk with shop windows all round and a pyramid roof. */
const ticketBooth = (x: number, z: number, body: Color, roof: Color): Op[] => [
  ['box', 0.16, 0.18, 0.14, x, 0.02, z, body, true, { name: 'booth', facade: { storeys: 1, bays: 1, sideBays: 1 } }],
  ['taper', 0.2, 0.18, 0, 0, 0.08, x, 0.2, z, roof],
];
const FAIR_SAND = 0xc9b68c, CANDY = 0xf4a6c8, CANDY2 = 0xf06aa8, WAFER = 0xd9b77a, BULBS: Color[] = ['marquee', 0xff8a8a, 0x8affc0, 0x8ac8ff];
const CX = -0.85, CZ = 0.78, SX = 1.06, SZ = 0.86, DX = 1.11, DZ = -0.94;
const HORSE: Color[] = ['white', 0xf2e4c9, 0x8a5a32, 'white', 0x3a3e49, 0xe8c070];

const funfair: Design[] = [
  { name: 'Ferris wheel over a carousel, dodgems, a helter-skelter, a candyfloss stall and an ice-cream van', height: 1.7, ops: [
    slab(3, 3, FAIR_SAND),
    path(0.62, 1.1, 0, 0.92, 'gravel', 0.02),
    ...ferrisFrame('silver', 'red', 'timber'),
    ...ticketBooth(0.2, -0.18, 'red', 'white'),
    // carousel: striped platform, mirrored column, valance with bulbs and a tent roof; the horses on their poles turn round it
    // in the client's animation pass (render/leisureRigs.ts), as the Ferris wheel's rim turns in render/wheels.ts
    ['lathe', CX, 0.02, CZ, 'gold', [0, 0, 0.42, 0, 0.42, 0.05], { seg: 24, stripe: 'red', every: 2, width: 1 }],
    ['lathe', CX, 0.07, CZ, 0xf0d890, [0.075, 0, 0.075, 0.3], { seg: 12, stripe: 'white', every: 2, width: 1, win: 'sign' }],
    ['lathe', CX, 0.37, CZ, 'red', [0, 0, 0.46, 0, 0.46, 0.06], { seg: 24, stripe: 'white', every: 2, width: 1 }],
    ['lathe', CX, 0.385, CZ, 'marquee', [0.468, 0, 0.468, 0.014], { seg: 24, win: 'sign' }],
    ['lathe', CX, 0.43, CZ, 'white', [0.47, 0, 0, 0.2], { seg: 16, stripe: 'red', every: 2, width: 1 }],
    ['flag', CX, 0.63, CZ, 'yellow'],
    // dodgems under a flat roof on posts, low and far enough right to pass under the gondolas' sweep (x from 0.76)
    ['box', 0.67, 0.025, 1.02, DX, 0.02, DZ, 'charcoal'],
    ['box', 0.69, 0.03, 0.02, DX, 0.02, -0.42, 'yellow'],
    ...[[0.79, -1.44], [1.43, -1.44], [0.79, -0.44], [1.43, -0.44]].map(([x, z]): Op => ['cyl', 0.014, 0.016, 0.26, x, 0.045, z, 'silver', 6]),
    ['box', 0.7, 0.03, 1.06, DX, 0.305, DZ, 'boxBlue'],
    ['box', 0.7, 0.03, 0.012, DX, 0.305, -0.404, 'marquee', 'sign'],
    ['box', 0.44, 0.08, 0.02, DX, 0.335, -0.43, 'red'], ['box', 0.36, 0.04, 0.006, DX, 0.355, -0.417, 0xfff1b8, 'sign'],
    // (the five cars drive about the floor in the client's animation pass)
    // helter-skelter: striped hut and spiral-striped tower, gallery, cabin, tent roof, the slide winding down
    ['lathe', SX, 0.02, SZ, 'red', [0, 0, 0.16, 0, 0.16, 0.16], { seg: 12, stripe: 'white', every: 2, width: 1 }],
    ['box', 0.07, 0.11, 0.01, SX, 0.02, SZ + 0.16, 'charcoal'],
    ['lathe', SX, 0.18, SZ, 'white', [0.13, 0, 0.1, 0.8], { seg: 12, stripe: 'red', every: 2, width: 1, twist: 160 }],
    ['cyl', 0.17, 0.17, 0.025, SX, 0.98, SZ, 'timber', 12], ['cyl', 0.11, 0.11, 0.1, SX, 1.005, SZ, 'white', 12],
    ['lathe', SX, 1.105, SZ, 'red', [0, 0, 0.15, 0, 0, 0.18], { seg: 12, stripe: 'white', every: 2, width: 1 }],
    ['flag', SX, 1.285, SZ, 'yellow'],
    ...repeat(11, (i): Op => {
      const y = rd(0.9 - i * 0.08), r = (y > 0.18 ? 0.13 - (0.03 * (y - 0.18)) / 0.8 : 0.16) + 0.05, a = ((i * 55 + 30) * Math.PI) / 180;
      return ['box', 0.09, 0.016, 0.09, rd(SX + r * Math.sin(a)), y, rd(SZ + r * Math.cos(a)), i % 2 ? 'yellow' : 'boxOrange'];
    }),
    ['box', 0.16, 0.008, 0.1, SX - 0.25, 0.02, SZ + 0.03, 'awning'],
    // candyfloss stall
    ...stall(-1.2, -0.02, 0.3, 0.2, CANDY, 'white', CANDY2),
    ...[-1.26, -1.14].flatMap((x): Op[] => [['cyl', 0.003, 0.003, 0.05, x, 0.12, 0.03, 'white', 3], ['lathe', x, 0.17, 0.03, 0xf8c8e0, ball(0.03), { seg: 10 }]]),
    ['box', 0.28, 0.04, 0.008, -1.2, 0.21, 0.085, 0xfff1b8, 'sign'],
    // hook-a-duck under a striped umbrella
    ['cyl', 0.15, 0.15, 0.06, 0.62, 0.02, -0.1, 'boxBlue', 16], ['cyl', 0.13, 0.13, 0.062, 0.62, 0.02, -0.1, 'pond', 16],
    ...[20, 110, 200, 290].map((d): Op => ['box', 0.026, 0.022, 0.018, rd(0.62 + 0.085 * Math.sin((d * Math.PI) / 180)), 0.082, rd(-0.1 + 0.085 * Math.cos((d * Math.PI) / 180)), 'yellow']),
    ['cyl', 0.008, 0.008, 0.26, 0.62, 0.082, -0.1, 'white', 5],
    ['lathe', 0.62, 0.342, -0.1, 'yellow', [0, 0, 0.2, 0, 0, 0.1], { seg: 12, stripe: 'red', every: 2, width: 1 }],
    // ice-cream van with a giant cone on the roof
    ['wheel', 0.03, 0.17, 1.12, 0.05, 0.04, 'charcoal'], ['wheel', 0.03, 0.17, 1.12, 0.05, 0.24, 'charcoal'],
    ['box', 0.16, 0.13, 0.3, 1.12, 0.05, 0.14, 'white'], ['box', 0.162, 0.03, 0.302, 1.12, 0.09, 0.14, CANDY],
    ['box', 0.006, 0.06, 0.14, 1.037, 0.1, 0.12, 0xfff1b8, 'sign'], ['box', 0.14, 0.05, 0.006, 1.12, 0.12, 0.293, 'glassDark'],
    ['lathe', 1.12, 0.18, 0.08, WAFER, [0, 0, 0.04, 0.11], { seg: 8 }], ['lathe', 1.12, 0.27, 0.08, CANDY, ball(0.05), { seg: 10 }],
    // lights across the way in, and the gate: striped pillars, a lit name and a sunburst crown
    ...lights(-0.36, 0.36, 0.5, 0.42, 5, BULBS),
    ['box', 0.08, 0.52, 0.08, -0.38, 0.02, 1.4, 'red'], ['box', 0.08, 0.52, 0.08, 0.38, 0.02, 1.4, 'red'],
    ['box', 0.012, 0.44, 0.008, -0.38, 0.06, 1.444, 'marquee', 'sign'], ['box', 0.012, 0.44, 0.008, 0.38, 0.06, 1.444, 'marquee', 'sign'],
    ['box', 0.86, 0.2, 0.07, 0, 0.54, 1.4, 'navy'], ['box', 0.62, 0.09, 0.008, 0, 0.59, 1.439, 0xffd84a, 'sign'],
    ['lathe', 0, 0.74, 1.38, 'gold', [0, 0, 0.2, 0, 0, 0.05], { seg: 16, axis: 'z', stripe: 'red', every: 2, width: 1 }],
    ['lathe', -0.38, 0.74, 1.4, 'gold', ball(0.04), { seg: 10 }], ['lathe', 0.38, 0.74, 1.4, 'gold', ball(0.04), { seg: 10 }],
    // the showman's caravan behind the wheel, trees at the edges
    ['box', 0.07, 0.03, 0.18, -1.3, 0.02, -1.32, 'charcoal'], ['box', 0.07, 0.03, 0.18, -1.0, 0.02, -1.32, 'charcoal'],
    ['box', 0.42, 0.15, 0.2, -1.15, 0.05, -1.32, 'cream', 'home', { name: 'van', facade: { storeys: 1, bays: 3, sideBays: 1, ground: 'door' } }],
    ['lathe', -1.36, 0.2, -1.32, 'red', [0, 0, 0.1, 0, 0.1, 0.42, 0, 0.42], { seg: 12, axis: 'x' }],
    ...pine(0.45, -1.38, 1.0), ...tree(-1.35, -0.7, 0.85),
  ] },
  { name: 'Ferris wheel over a seaside boardwalk with a chair swing ride, a log flume, a teacup ride and kiosks', height: 1.7, ops: [
    slab(3, 3, 0xd8c79c),
    ['box', 2.96, 0.025, 1.0, 0, 0.02, 0.98, 0xb88f5a],
    ...repeat(4, (i): Op => ['box', 2.96, 0.002, 0.012, 0, 0.045, rd(0.6 + i * 0.24), 0x8a6a42]),
    ...ferrisFrame('white', 'boxBlue', 'timber'),
    ...ticketBooth(0.2, -0.2, 'boxBlue', 'white'),
    // chair swing ride: tower, striped canopy with bulbs, chairs hanging on chains
    ['lathe', -0.95, 0.02, 0.08, 'plum', [0, 0, 0.2, 0, 0.2, 0.04], { seg: 16, stripe: 'gold', every: 2, width: 1 }],
    ['cyl', 0.045, 0.06, 0.66, -0.95, 0.06, 0.08, 'white', 10],
    ['lathe', -0.95, 0.72, 0.08, 'boxBlue', [0, 0, 0.36, 0, 0, 0.14], { seg: 16, stripe: 'white', every: 2, width: 1 }],
    ['lathe', -0.95, 0.72, 0.08, 'marquee', [0.366, 0, 0.366, 0.014], { seg: 16, win: 'sign' }],
    ['lathe', -0.95, 0.86, 0.08, 'gold', ball(0.035), { seg: 10 }], ['flag', -0.95, 0.93, 0.08, 'red'],
    // (the eight chairs on their chains swing round it in the client's animation pass, render/leisureRigs.ts)
    // teacup ride round a teapot
    ['lathe', 0.68, 0.02, 0.12, 'plum', [0, 0, 0.32, 0, 0.32, 0.04], { seg: 20, stripe: 'gold', every: 2, width: 1 }],
    ['lathe', 0.68, 0.06, 0.12, 'white', [0, 0, 0.06, 0, 0.085, 0.05, 0.075, 0.1, 0.03, 0.13, 0.035, 0.14, 0, 0.15], { seg: 12 }],
    ['taper', 0.03, 0.03, 0.02, 0.02, 0.07, 0.76, 0.1, 0.12, 'white', { shift: [0.04, 0] }],
    // (the five cups turn round the pot and spin in the client's animation pass)
    // log flume down the right side: station, trough on stilts, the drop into a splash pool
    ['box', 0.34, 0.5, 0.3, 1.22, 0.02, -1.25, 'timber'], ['roof', 0.38, 0.1, 0.34, 1.22, 0.52, -1.25, 'red', true],
    ['box', 0.16, 0.05, 1.2, 1.22, 0.42, -0.5, 0x2f8fd6], ['box', 0.12, 0.004, 1.2, 1.22, 0.47, -0.5, 'pond'],
    ...[-0.8, -0.4, 0.0].map((z): Op => ['cyl', 0.014, 0.018, 0.4, 1.22, 0.02, z, 'timber', 6]),
    ['taper', 0.16, 0.05, 0.16, 0.05, 0.42, 1.22, 0.05, 0.5, 0x2f8fd6, { shift: [0, -0.4] }],
    ['taper', 0.12, 0.05, 0.12, 0.05, 0.42, 1.22, 0.058, 0.5, 'pond', { shift: [0, -0.4] }],
    ['box', 0.36, 0.045, 0.44, 1.22, 0.045, 0.72, 'stone'], ['box', 0.32, 0.047, 0.4, 1.22, 0.045, 0.72, 'pond'],
    // (the logs ride the trough, the drop and the pool in the client's animation pass)
    ['cone', 0.05, 0.1, 1.12, 0.092, 0.58, 0xe6f4ff, 6], ['cone', 0.05, 0.1, 1.32, 0.092, 0.58, 0xe6f4ff, 6],
    // kiosks on the boardwalk: doughnuts and ice cream, each with its giant sign
    ...[[-0.62, 0xf6f2ea, 'red'], [0.62, 0xf6f2ea, 0x2f8fd6]].flatMap(([x, body, roof]): Op[] => [
      ['lathe', x as number, 0.045, 0.9, body as Color, [0, 0, 0.12, 0, 0.12, 0.2], { seg: 6 }],
      ['lathe', x as number, 0.15, 0.9, 0xfff1b8, [0.123, 0, 0.123, 0.05], { seg: 6, win: 'sign' }],
      ['lathe', x as number, 0.245, 0.9, roof as Color, [0, 0, 0.16, 0, 0, 0.1], { seg: 6, stripe: 'white', every: 2, width: 1 }],
    ]),
    ['cyl', 0.008, 0.008, 0.05, -0.62, 0.335, 0.9, 'steel', 4],
    ['lathe', -0.62, 0.465, 0.88, 0xd9a05a, [0, 0, 0.08, 0, 0.08, 0.04, 0, 0.04], { seg: 16, axis: 'z' }],
    disc(-0.62, 0.465, 0.92, 0.065, CANDY, 0.006), disc(-0.62, 0.465, 0.926, 0.022, 0x5a3a2a, 0.004, false, 10),
    ['cyl', 0.008, 0.008, 0.03, 0.62, 0.335, 0.9, 'steel', 4],
    ['lathe', 0.62, 0.365, 0.9, WAFER, [0, 0, 0.06, 0.16], { seg: 8 }],
    ['lathe', 0.62, 0.5, 0.9, CANDY, ball(0.065), { seg: 12 }], ['lathe', 0.62, 0.6, 0.9, 0xfff1d8, ball(0.05), { seg: 12 }],
    // hoopla stall behind the wheel, prizes on its counter
    ...stall(-1.15, -1.3, 0.32, 0.2, 0x8ac8ff, 'white', 'boxBlue'),
    ...[-1.25, -1.15, -1.05].map((x, i): Op => ['box', 0.035, 0.04, 0.03, x, 0.12, -1.25, (['brown', CANDY, 'yellow'] as Color[])[i]]),
    // lights over the boardwalk, the pier gate with domed pillars, railings along the edge
    ...lights(-0.36, 0.36, 0.62, 0.45, 5, BULBS),
    ...[-0.42, 0.42].flatMap((x): Op[] => [
      ['lathe', x, 0.045, 1.38, 'white', [0, 0, 0.07, 0, 0.07, 0.42], { seg: 8 }],
      ['lathe', x, 0.3, 1.38, 'marquee', [0.074, 0, 0.074, 0.02], { seg: 8, win: 'sign' }],
      ['lathe', x, 0.465, 1.38, 'boxBlue', [0.08, 0, 0.085, 0.03, 0.06, 0.08, 0.02, 0.12, 0, 0.14], { seg: 8, stripe: 'white', every: 2, width: 1 }],
    ]),
    ['box', 0.7, 0.1, 0.04, 0, 0.36, 1.38, 'navy'], ['box', 0.6, 0.06, 0.008, 0, 0.38, 1.404, 0xffd84a, 'sign'],
    ['box', 0.96, 0.012, 0.012, -0.98, 0.13, 1.46, 'white'], ['box', 0.96, 0.012, 0.012, 0.98, 0.13, 1.46, 'white'],
    ...[-1.44, -1.0, -0.52, 0.52, 1.0, 1.44].map((x): Op => ['box', 0.016, 0.1, 0.016, x, 0.045, 1.46, 'white']),
    ...pine(-0.3, -1.38, 1.0), ...tree(0.55, -1.3, 0.9),
  ] },
];

// ================================================================= art gallery (1×1)

const GALLERY_WHITE = 0xf3f2ee, GALLERY_STONE = 0xd8cfbd;
const artGallery: Design[] = [
  { name: 'white box gallery with saw-tooth skylights, a glass slot window, banners and a courtyard sculpture', height: 0.48, ops: [
    slab(1, 1, PAVING),
    ['box', 0.76, 0.36, 0.5, 0, 0.02, -0.2, GALLERY_WHITE],
    ...[-0.37, -0.21, -0.05].flatMap((zc): Op[] => [
      ['taper', 0.76, 0.16, 0.76, 0.01, 0.1, 0, 0.38, zc, 'white', { shift: [0, 0.075] }],
      ['box', 0.74, 0.09, 0.008, 0, 0.38, rd(zc + 0.084), 'glassDark'],
    ]),
    ['box', 0.44, 0.1, 0.03, 0.12, 0.22, 0.065, 'glass', true, { name: 'slot', facade: { storeys: 1, bays: 3, sideBays: 0 } }],
    ['box', 0.12, 0.24, 0.01, -0.25, 0.02, 0.055, 0x2b2e36], ['box', 0.22, 0.014, 0.12, -0.25, 0.27, 0.11, 'white'],
    ['box', 0.2, 0.03, 0.006, 0.12, 0.17, 0.053, 'charcoal'],
    ['cyl', 0.007, 0.008, 0.44, -0.4, 0.02, 0.3, 'steel', 5], ['box', 0.07, 0.24, 0.006, -0.36, 0.2, 0.3, 'plum'],
    ['cyl', 0.007, 0.008, 0.44, 0.4, 0.02, 0.3, 'steel', 5], ['box', 0.07, 0.24, 0.006, 0.36, 0.2, 0.3, ORANGE],
    ['box', 0.28, 0.05, 0.03, -0.3, 0.02, 0.46, 'stone'], ['box', 0.28, 0.05, 0.03, 0.3, 0.02, 0.46, 'stone'],
    // the sculpture: a leaning red shard and a bronze ball on a plinth
    ['box', 0.14, 0.05, 0.14, 0.05, 0.02, 0.28, 'stone'],
    ['taper', 0.07, 0.05, 0.02, 0.02, 0.26, 0.03, 0.07, 0.28, 0xc0392b, { shift: [0.05, 0] }],
    ['lathe', 0.09, 0.07, 0.31, 0x9a7a4a, ball(0.03), { seg: 10 }],
    ['box', 0.08, 0.06, 0.08, 0.27, 0.02, 0.22, 'charcoal'], ...tree(0.27, 0.22, 0.6, 'hedge', 0.08),
    ...bench(-0.12, 0.38),
  ] },
  { name: 'Victorian stone gallery with a pedimented portico, banners and a glass dome lantern', height: 0.79, ops: [
    slab(1, 1, 'gravel'),
    ['box', 0.82, 0.04, 0.66, 0, 0.02, -0.12, 'stone'],
    ['box', 0.76, 0.4, 0.5, 0, 0.06, -0.18, GALLERY_STONE, 'civic', { name: 'hall', facade: { storeys: 1, bays: 5, sideBays: 3, top: 0.08, ground: 'door' } }],
    ...[-0.21, -0.07, 0.07, 0.21].map((x): Op => ['cyl', 0.022, 0.027, 0.31, x, 0.06, 0.16, 'white', 10]),
    ['box', 0.52, 0.06, 0.16, 0, 0.37, 0.13, 'white'], ['roof', 0.54, 0.12, 0.17, 0, 0.43, 0.125, 'white', true],
    ['box', 0.3, 0.022, 0.006, 0, 0.39, 0.213, 'gold'],
    ['box', 0.05, 0.16, 0.006, -0.14, 0.21, 0.16, 'plum'], ['box', 0.05, 0.16, 0.006, 0.14, 0.21, 0.16, 'navy'],
    ['taper', 0.8, 0.54, 0.46, 0.22, 0.1, 0, 0.46, -0.18, 'roofGrey'],
    ['cyl', 0.09, 0.09, 0.08, 0, 0.56, -0.18, 'glass', 8],
    ['lathe', 0, 0.64, -0.18, 0x8a9098, dome(0.1, 0.09, 5), { seg: 8 }], ['cyl', 0.008, 0.012, 0.06, 0, 0.73, -0.18, 'gold', 5],
    ['box', 0.5, 0.027, 0.04, 0, 0.02, 0.23, 'stone'], ['box', 0.5, 0.013, 0.04, 0, 0.02, 0.27, 'stone'],
    ['box', 0.26, 0.004, 0.16, -0.32, 0.02, 0.39, 'lawn'], ['box', 0.26, 0.004, 0.16, 0.32, 0.02, 0.39, 'lawn'],
    ...lampPost(-0.4, 0.3, 0.24, 'marquee'), ...lampPost(0.4, 0.3, 0.24, 'marquee'),
    ['cyl', 0.035, 0.03, 0.05, -0.2, 0.024, 0.4, 'stone', 8], ['cone', 0.04, 0.12, -0.2, 0.074, 0.4, 'hedge', 6],
    ['cyl', 0.035, 0.03, 0.05, 0.2, 0.024, 0.4, 'stone', 8], ['cone', 0.04, 0.12, 0.2, 0.074, 0.4, 'hedge', 6],
  ] },
];

// ================================================================= pottery studio (1×1)

const KILN = 0xb0603e, GLAZE: Color[] = ['terracotta', 0x3f6fae, 0x5a9a7a, 'cream', 0x8a5a3a, 0xc8a24a];
const potteryStudio: Design[] = [
  { name: 'brick workshop with big windows and an awning, a bottle kiln, and glazed pots on shelves outside', height: 0.55, ops: [
    slab(1, 1, PAVING),
    ['box', 0.52, 0.3, 0.44, -0.18, 0.02, -0.12, 'brick', true, { name: 'studio', facade: { storeys: 1, bays: 3, sideBays: 2 } }],
    ['roof', 0.56, 0.16, 0.48, -0.18, 0.32, -0.12, 'slate'],
    ['door', 'studio', 'front', 0, 0x2f6a4f], ['awning', 'studio', 'front', 1, 2, 'terracotta'],
    ['cyl', 0.015, 0.015, 0.14, -0.32, 0.36, -0.2, 'charcoal', 6],
    // bottle kiln with an iron band and its firing door
    ['lathe', 0.29, 0.02, -0.22, KILN, [0, 0, 0.155, 0, 0.16, 0.06, 0.15, 0.16, 0.11, 0.28, 0.065, 0.4, 0.05, 0.5, 0.055, 0.53], { seg: 14 }],
    ['cyl', 0.153, 0.153, 0.015, 0.29, 0.13, -0.22, 'charcoal', 14],
    ['box', 0.06, 0.08, 0.012, 0.29, 0.02, -0.064, 'charcoal'],
    // shelves of pots
    ['box', 0.014, 0.2, 0.06, 0.13, 0.02, 0.24, 'timber'], ['box', 0.014, 0.2, 0.06, 0.41, 0.02, 0.24, 'timber'],
    ['box', 0.3, 0.012, 0.07, 0.27, 0.09, 0.24, 'timber'], ['box', 0.3, 0.012, 0.07, 0.27, 0.17, 0.24, 'timber'],
    ...[0.18, 0.27, 0.36].map((x, i): Op => vase(x, 0.102, 0.24, GLAZE[i], 0.9)),
    ...[0.19, 0.28, 0.35].map((x, i): Op => vase(x, 0.182, 0.24, GLAZE[i + 3], 0.8)),
    vase(-0.38, 0.02, 0.22, 'terracotta', 2.2), vase(0.02, 0.02, 0.2, 0x3f6fae, 1.8),
    ...signBoard(-0.2, 0.42, 0.24, 0xb8643a, 'cream', 0.02, 0.2),
    ...[-0.42, -0.42, -0.42].map((x, i): Op => ['cone', 0.035, 0.06, x, 0.02, rd(-0.3 + i * 0.12), 'plum', 6]),
    ...bench(0.02, 0.42),
  ] },
  { name: 'black timber barn studio with a kiln shed, drying racks and a pottery-wheel sign', height: 0.49, ops: [
    lawn(1, 1),
    path(0.7, 0.36, 0, 0.28),
    ['box', 0.58, 0.26, 0.44, 0.02, 0.012, -0.16, 0x3b3633, true, { name: 'barn', facade: { storeys: 1, bays: 3, sideBays: 2 } }],
    ['roof', 0.62, 0.22, 0.48, 0.02, 0.272, -0.16, 0x8a3a2a],
    ['door', 'barn', 'front', 1, 0xe8dcc0],
    // kiln shed standing clear of the barn, its flue and log pile
    ['box', 0.14, 0.18, 0.2, -0.38, 0.012, -0.2, 'corrugated'], ['box', 0.15, 0.02, 0.22, -0.38, 0.192, -0.2, 'charcoal'],
    ['cyl', 0.015, 0.015, 0.26, -0.4, 0.212, -0.22, 'charcoal', 6], ['cone', 0.03, 0.03, -0.4, 0.472, -0.22, 'charcoal', 6],
    ['box', 0.12, 0.03, 0.05, -0.38, 0.012, 0.0, 'brown'], ['box', 0.12, 0.03, 0.05, -0.38, 0.042, 0.0, 0x6a4a2a], ['box', 0.12, 0.03, 0.05, -0.38, 0.012, -0.05, 0x6a4a2a],
    // pottery-wheel sign: a wheel head on a stand with a big pot on it
    ['box', 0.12, 0.03, 0.12, 0.33, 0.012, 0.3, 'stone'], ['cyl', 0.018, 0.024, 0.12, 0.33, 0.042, 0.3, 'charcoal', 8],
    ['cyl', 0.085, 0.085, 0.02, 0.33, 0.162, 0.3, 'grey', 16],
    ['lathe', 0.33, 0.182, 0.3, 'terracotta', [0, 0, 0.035, 0, 0.06, 0.04, 0.055, 0.08, 0.032, 0.11, 0.04, 0.125], { seg: 12 }],
    ['box', 0.1, 0.03, 0.006, 0.33, 0.012, 0.363, 'cream'],
    // drying rack along the right side
    ['box', 0.012, 0.22, 0.012, 0.4, 0.012, -0.32, 'timber'], ['box', 0.012, 0.22, 0.012, 0.4, 0.012, -0.08, 'timber'],
    ['box', 0.06, 0.01, 0.26, 0.4, 0.1, -0.2, 'timber'], ['box', 0.06, 0.01, 0.26, 0.4, 0.18, -0.2, 'timber'],
    vase(0.4, 0.11, -0.28, 0xd8c8b0, 0.8), vase(0.4, 0.11, -0.14, 0xd8c8b0, 0.8), vase(0.4, 0.19, -0.26, 0xc8b8a0, 0.7), vase(0.4, 0.19, -0.13, 0xd8c8b0, 0.7),
    vase(-0.1, 0.012, 0.13, 0x5a9a7a, 1.2), vase(0.14, 0.012, 0.13, 0x3f6fae, 1.2),
    ...tree(-0.38, 0.36, 0.8), ...bench(-0.18, 0.4, 0.012),
  ] },
];

// ================================================================= dance hall (1×1)

const DECO = 0xf0e6d2, DECO_GOLD = 0xd8b25a, NEON_PINK = 0xff5a9a, SEAFOAM = 0x5fae9a;
const danceHall: Design[] = [
  { name: 'art-deco ballroom with a rounded corner tower, gold fins, tall windows and glowing signs', height: 0.87, ops: [
    slab(1, 1, PAVING),
    ['box', 0.74, 0.44, 0.6, 0.08, 0.02, -0.14, DECO, true, { name: 'hall', facade: { storeys: 1, bays: 3, sideBays: 3, margin: 0.16, top: 0.1, ground: 'door' } }],
    ['box', 0.76, 0.025, 0.62, 0.08, 0.46, -0.14, DECO_GOLD],
    // the rounded corner: a tower of tall windows, stepped crown, spire and a blade sign
    ['lathe', -0.29, 0.02, 0.16, DECO, [0.15, 0, 0.15, 0.54], { seg: 16, win: 'venue' }],
    ['lathe', -0.29, 0.5, 0.16, NEON_PINK, [0.153, 0, 0.153, 0.02], { seg: 16, win: 'sign' }],
    ['lathe', -0.29, 0.56, 0.16, DECO_GOLD, [0.12, 0, 0.12, 0.05], { seg: 16 }],
    ['lathe', -0.29, 0.61, 0.16, DECO, [0.085, 0, 0.085, 0.06], { seg: 16 }],
    ['cyl', 0.006, 0.01, 0.2, -0.29, 0.67, 0.16, 'gold', 5],
    ['box', 0.1, 0.32, 0.025, -0.29, 0.16, 0.3225, NEON_PINK, 'sign'], ['box', 0.03, 0.26, 0.004, -0.29, 0.19, 0.337, 'white'],
    // gold fins on the bay lines, rising above the coping; the name across the top band
    ...[-0.13, 0.01, 0.15, 0.29].map((x): Op => ['box', 0.014, 0.52, 0.03, x, 0.02, 0.175, DECO_GOLD]),
    ['box', 0.36, 0.055, 0.012, 0.08, 0.385, 0.196, 0xffd27a, 'sign'],
    ['awning', 'hall', 'front', 1, 1, DECO_GOLD],
    ['box', 0.12, 0.004, 0.24, 0.08, 0.02, 0.3, 0xa8202c],
    ...[-0.12, 0.28].flatMap((x): Op[] => [['cyl', 0.01, 0.012, 0.28, x, 0.02, 0.38, 'charcoal', 6], ['lathe', x, 0.3, 0.38, 'marquee', ball(0.03), { seg: 10, win: 'sign' }]]),
    ...[-0.04, 0.2].flatMap((x): Op[] => [['cyl', 0.03, 0.025, 0.05, x, 0.02, 0.26, DECO_GOLD, 8], ['cone', 0.045, 0.12, x, 0.07, 0.26, 'hedge', 6]]),
  ] },
  { name: 'seaside pavilion with a striped bell dome, corner cupolas, a veranda, bunting and deckchairs', height: 0.84, ops: [
    slab(1, 1, PAVING),
    ['box', 0.7, 0.3, 0.48, 0, 0.02, -0.16, 'white', true, { name: 'hall', facade: { storeys: 1, bays: 5, sideBays: 3, margin: 0.06, ground: 'door' } }],
    // the veranda roof rests on the wall top and on posts standing clear of the tall windows
    ['box', 0.58, 0.02, 0.14, 0, 0.32, 0.15, SEAFOAM],
    ...[-0.28, -0.14, 0.14, 0.28].map((x): Op => ['box', 0.014, 0.3, 0.014, x, 0.02, 0.205, 'white']),
    ['box', 0.58, 0.025, 0.008, 0, 0.295, 0.216, 'white'],
    ['taper', 0.74, 0.52, 0.34, 0.16, 0.1, 0, 0.32, -0.16, SEAFOAM],
    ['cyl', 0.075, 0.075, 0.05, 0, 0.42, -0.16, 'white', 12],
    ['lathe', 0, 0.47, -0.16, SEAFOAM, [0.085, 0, 0.1, 0.03, 0.09, 0.07, 0.06, 0.11, 0.025, 0.14, 0, 0.17], { seg: 12, stripe: 'white', every: 2, width: 1 }],
    ['flag', 0, 0.64, -0.16, 'red'],
    // corner cupolas in the wall margins, bunting strung between them
    ['box', 0.07, 0.38, 0.07, -0.35, 0.02, 0.08, 'white'], ['box', 0.07, 0.38, 0.07, 0.35, 0.02, 0.08, 'white'],
    ['lathe', -0.35, 0.4, 0.08, SEAFOAM, dome(0.045, 0.06, 4), { seg: 8 }], ['lathe', 0.35, 0.4, 0.08, SEAFOAM, dome(0.045, 0.06, 4), { seg: 8 }],
    ['box', 0.63, 0.005, 0.005, 0, 0.375, 0.08, 'charcoal'],
    ...repeat(7, (i): Op => ['box', 0.03, 0.035, 0.004, rd(-0.27 + i * 0.09), 0.34, 0.08, (['red', 'white', 'signBlue', 'yellow'] as Color[])[i % 4]]),
    // promenade railing with a gap at the door, deckchairs and seaside lamps
    ['box', 0.32, 0.012, 0.012, -0.28, 0.1, 0.44, 'white'], ['box', 0.32, 0.012, 0.012, 0.28, 0.1, 0.44, 'white'],
    ...[-0.43, -0.13, 0.13, 0.43].map((x): Op => ['box', 0.014, 0.09, 0.014, x, 0.02, 0.44, 'white']),
    ...([[-0.24, 'red'], [0.24, 'signBlue']] as [number, Color][]).flatMap(([x, c]): Op[] => [
      ['box', 0.06, 0.03, 0.07, x, 0.02, 0.3, 'white'], ['taper', 0.06, 0.012, 0.06, 0.012, 0.08, x, 0.05, 0.27, c, { shift: [0, -0.03] }],
    ]),
    ...[-0.42, 0.42].flatMap((x): Op[] => [['cyl', 0.008, 0.012, 0.3, x, 0.02, 0.3, SEAFOAM, 6], ['lathe', x, 0.32, 0.3, 'marquee', ball(0.025), { seg: 10, win: 'sign' }]]),
  ] },
];

// ================================================================= concert hall (2×2, doors front left)

const BRONZE = 0x7a5a3a, COPPER = 0x6fae98, PORTLAND = 0xe6dcc6, WINE = 0x8a2b3a;
const concertHall: Design[] = [
  { name: 'great hall under a swelling copper roof, with an organ-pipe front over a glass foyer and gold fins', height: 1.15, ops: [
    slab(2, 2, PAVING),
    ['box', 1.3, 0.82, 1.1, 0.25, 0.02, -0.4, BRONZE],
    ['lathe', -0.4, 0.6, -0.4, COPPER, [0, 0, 0.5, 0, 0.53, 0.33, 0.55, 0.65, 0.53, 0.98, 0.49, 1.3, 0, 1.3], { seg: 24, axis: 'x', stripe: 0x5f9e88, every: 3, width: 1 }],
    ...repeat(5, (i): Op => ['box', 0.02, 0.72, 0.04, 0.91, 0.02, rd(-0.85 + i * 0.2), 'gold']),
    // podium, glass foyer with its doors to the front left, the lit name in its top band
    ['box', 1.9, 0.06, 0.66, 0, 0.02, 0.48, 'stone'],
    ['box', 1.6, 0.4, 0.4, 0, 0.08, 0.35, 'glass', true, { name: 'foyer', facade: { storeys: 2, bays: 8, sideBays: 2, top: 0.04 } }],
    ['door', 'foyer', 'front', 1], ['door', 'foyer', 'front', 2],
    ['box', 1.62, 0.02, 0.42, 0, 0.48, 0.35, 'white'],
    ['box', 0.9, 0.032, 0.012, 0.15, 0.442, 0.556, 0xffe2a0, 'sign'],
    // organ pipes standing on the foyer roof against the hall
    ...repeat(11, (i): Op => ['cyl', 0.026, 0.026, rd(0.14 + 0.2 * (1 - Math.abs(i - 5) / 5)), rd(-0.3 + i * 0.1), 0.5, 0.185, i % 2 ? 'silver' : 'gold', 8]),
    ['box', 1.5, 0.04, 0.06, -0.1, 0.02, 0.84, 'stone'], ['box', 1.5, 0.02, 0.06, -0.1, 0.02, 0.9, 'stone'],
    ...[0.72, 0.86].flatMap((x, i): Op[] => [['cyl', 0.008, 0.008, 0.5, x, 0.08, 0.7, 'steel', 4], ['box', 0.06, 0.18, 0.006, x + 0.034, 0.38, 0.7, i ? 'gold' : WINE]]),
    ...tree(0.84, 0.89, 0.8), ...lampPost(-0.9, 0.9, 0.36, 'marquee'),
  ] },
  { name: 'classical concert hall on a podium, with a six-column portico, a pediment and a copper dome', height: 1.18, ops: [
    slab(2, 2, 'gravel'),
    ['box', 1.8, 0.08, 1.72, 0, 0.02, -0.1, 'stone'],
    ['box', 1.5, 0.66, 1.2, 0, 0.1, -0.33, PORTLAND, true, { name: 'hall', facade: { storeys: 2, bays: 8, sideBays: 6, top: 0.12, margin: 0.06 } }],
    ['door', 'hall', 'front', 2], ['door', 'hall', 'front', 3], ['door', 'hall', 'front', 4], ['door', 'hall', 'front', 5],
    ['cornice', 'hall', 2, 'white'],
    ...[-0.55, -0.33, -0.11, 0.11, 0.33, 0.55].flatMap((x): Op[] => [['cyl', 0.032, 0.04, 0.53, x, 0.1, 0.42, 'white', 10], ['box', 0.09, 0.025, 0.09, x, 0.63, 0.42, 'white']]),
    ['box', 1.26, 0.08, 0.26, 0, 0.655, 0.4, 'white'], ['roof', 1.28, 0.22, 0.27, 0, 0.735, 0.395, 'white', true],
    disc(0, 0.8, 0.53, 0.055, 'gold'),
    ['box', 0.12, 0.24, 0.008, -0.44, 0.415, 0.42, WINE], ['box', 0.12, 0.24, 0.008, 0.44, 0.415, 0.42, WINE],
    ['taper', 1.54, 1.24, 1.0, 0.76, 0.14, 0, 0.76, -0.33, 'roofGrey'],
    ['lathe', 0, 0.9, -0.33, COPPER, dome(0.34, 0.2, 6), { seg: 20 }], ['cyl', 0.012, 0.02, 0.08, 0, 1.1, -0.33, 'gold', 6],
    ['box', 1.4, 0.054, 0.06, 0, 0.02, 0.79, 'stone'], ['box', 1.4, 0.027, 0.06, 0, 0.02, 0.85, 'stone'],
    ...[-0.82, 0.82].flatMap((x): Op[] => [['cyl', 0.012, 0.016, 0.4, x, 0.02, 0.84, 'charcoal', 6], ['box', 0.05, 0.07, 0.05, x, 0.42, 0.84, 'marquee', 'sign']]),
    ...[-0.8, 0.8].flatMap((x): Op[] => [['cyl', 0.05, 0.04, 0.06, x, 0.1, 0.6, 'stone', 8], ['cone', 0.05, 0.16, x, 0.16, 0.6, 'hedge', 6]]),
  ] },
];

// ================================================================= family arcade (1×1)

const ARC_PINK = 0xff6fb5, ARC_BLUE = 0x4fc3f7, STAR_GOLD = 0xffd84a, NEON_CYAN = 0x4ff0ff, PIXEL = 0x6aff5a;
const SCREENS: Color[] = [0x5af0ff, 0xff5ad0, 0xfff05a, 0x7aff5a];
/** A friendly pixel alien, 9 cells wide and 7 tall, as runs [row from the top, first column, length]. */
const ALIEN: [number, number, number][] = [
  [0, 3, 1], [0, 5, 1], [1, 2, 5], [2, 1, 2], [2, 4, 1], [2, 6, 2], [3, 0, 9],
  [4, 0, 1], [4, 2, 5], [4, 8, 1], [5, 0, 1], [5, 2, 1], [5, 6, 1], [5, 8, 1], [6, 2, 2], [6, 5, 2],
];
const arcade: Design[] = [
  { name: 'seaside amusement arcade, open to the street, with candy stripes, marquee bulbs and a big star sign', height: 0.82, ops: [
    slab(1, 1, PAVING),
    ['box', 0.7, 0.008, 0.5, 0, 0.02, -0.17, 0x3a1d4a],
    ['box', 0.76, 0.26, 0.05, 0, 0.02, -0.42, 'white'],
    ['box', 0.05, 0.26, 0.56, -0.355, 0.02, -0.165, ARC_PINK], ['box', 0.05, 0.26, 0.56, 0.355, 0.02, -0.165, ARC_BLUE],
    ['box', 0.8, 0.16, 0.62, 0, 0.28, -0.14, 'white'],
    ...repeat(8, (i): Op => ['box', 0.1, 0.16, 0.006, rd(-0.35 + i * 0.1), 0.28, 0.173, i % 2 ? 'white' : ARC_PINK]),
    ['box', 0.42, 0.075, 0.012, 0, 0.32, 0.182, 0xfff1b8, 'sign'],
    ...repeat(9, (i): Op => ['box', 0.018, 0.018, 0.018, rd(-0.36 + i * 0.09), 0.285, 0.185, 'marquee', 'sign']),
    ...repeat(9, (i): Op => ['box', 0.018, 0.018, 0.018, rd(-0.36 + i * 0.09), 0.412, 0.185, 'marquee', 'sign']),
    // machines inside: cabinets with glowing screens, a claw machine and an air-hockey table
    ...[-0.24, -0.08, 0.08, 0.24].flatMap((x, i): Op[] => [
      ['box', 0.11, 0.2, 0.08, x, 0.028, -0.35, SCREENS[(i + 1) % 4]], ['box', 0.08, 0.06, 0.006, x, 0.14, -0.307, SCREENS[i], 'sign'],
    ]),
    ['box', 0.12, 0.2, 0.12, -0.22, 0.028, -0.05, 'glass'], ['box', 0.13, 0.04, 0.13, -0.22, 0.228, -0.05, 0xfff05a, 'sign'],
    ['box', 0.12, 0.07, 0.22, 0.2, 0.028, -0.08, 0x2f6fd6], ['box', 0.11, 0.004, 0.2, 0.2, 0.098, -0.08, 'white'],
    // the sparkle star on the roof
    ['cyl', 0.012, 0.015, 0.06, 0, 0.44, -0.12, 'charcoal', 6],
    ['lathe', 0, 0.5, -0.12, STAR_GOLD, [0, 0, 0.04, 0.13], { seg: 4, win: 'sign' }],
    ['lathe', 0, 0.66, -0.135, STAR_GOLD, [0, 0, 0.075, 0, 0.075, 0.03, 0, 0.03], { seg: 10, axis: 'z', win: 'sign' }],
    ['lathe', 0, 0.69, -0.12, STAR_GOLD, [0.04, 0, 0, 0.13], { seg: 4, win: 'sign' }],
    ['lathe', -0.2, 0.66, -0.12, STAR_GOLD, [0, 0, 0.04, 0.13], { seg: 4, axis: 'x', win: 'sign' }],
    ['lathe', 0.07, 0.66, -0.12, STAR_GOLD, [0.04, 0, 0, 0.13], { seg: 4, axis: 'x', win: 'sign' }],
    // a gumball machine and a kiddie ride on the pavement
    ['cyl', 0.02, 0.03, 0.12, 0.3, 0.02, 0.32, 'red', 8], ['lathe', 0.3, 0.14, 0.32, 0xbfe8ff, ball(0.045), { seg: 12, win: 'sign' }],
    ['box', 0.12, 0.04, 0.16, -0.28, 0.02, 0.3, 'charcoal'], ['box', 0.08, 0.06, 0.12, -0.28, 0.06, 0.3, 'yellow'], ['box', 0.06, 0.04, 0.04, -0.28, 0.12, 0.27, 'glassDark'],
  ] },
  { name: 'retro neon arcade with a lit window of cabinets, a pixel-alien sign and a giant joystick on the roof', height: 0.78, ops: [
    slab(1, 1, PAVING),
    ['box', 0.8, 0.44, 0.58, 0, 0.02, -0.15, 'charcoal'], ['box', 0.82, 0.02, 0.6, 0, 0.46, -0.15, 0x1a1c22],
    // the lit window with cabinet silhouettes, the door, neon tubes round both
    ['box', 0.54, 0.24, 0.01, 0.06, 0.02, 0.145, 0x7a3ac8, 'sign'],
    ...[-0.1, 0.06, 0.22].flatMap((x, i): Op[] => [['box', 0.07, 0.17, 0.004, x, 0.02, 0.152, 0x1a1a24], ['box', 0.05, 0.035, 0.004, x, 0.13, 0.156, SCREENS[i], 'sign']]),
    ['box', 0.11, 0.21, 0.01, -0.3, 0.02, 0.145, 'glassDark'],
    ['box', 0.58, 0.012, 0.012, 0.06, 0.27, 0.152, NEON_PINK, 'sign'],
    ['box', 0.012, 0.25, 0.012, -0.23, 0.02, 0.152, NEON_PINK, 'sign'], ['box', 0.012, 0.25, 0.012, 0.35, 0.02, 0.152, NEON_PINK, 'sign'],
    ['box', 0.13, 0.012, 0.012, -0.3, 0.24, 0.152, NEON_CYAN, 'sign'],
    ['box', 0.6, 0.05, 0.012, 0, 0.34, 0.15, NEON_CYAN, 'sign'], ['box', 0.66, 0.008, 0.008, 0, 0.42, 0.148, NEON_PINK, 'sign'],
    ['box', 0.03, 0.3, 0.1, 0.415, 0.12, 0.06, NEON_CYAN, 'sign'],
    // the pixel alien on a dark board on the roof
    ['box', 0.4, 0.03, 0.06, 0, 0.48, -0.01, 'charcoal'], ['box', 0.38, 0.27, 0.01, 0, 0.51, -0.015, 0x15161c],
    ...ALIEN.map(([r, c, n]): Op => ['box', rd(n * 0.034), 0.034, 0.02, rd(-4.5 * 0.034 + (c + n / 2) * 0.034), rd(0.52 + (6 - r) * 0.034), 0.0, PIXEL, 'sign']),
    // giant joystick with two buttons
    ['box', 0.14, 0.05, 0.1, 0.27, 0.48, -0.3, 0x1a1a1a], ['cyl', 0.01, 0.01, 0.12, 0.27, 0.53, -0.3, 'silver', 6],
    ['lathe', 0.27, 0.64, -0.3, 'red', ball(0.04), { seg: 12 }],
    ['cyl', 0.018, 0.018, 0.012, 0.23, 0.53, -0.26, 'yellow', 10], ['cyl', 0.018, 0.018, 0.012, 0.31, 0.53, -0.26, 0x2f8fd6, 10],
    ...bench(-0.25, 0.38),
  ] },
];

// ================================================================= board-game café (1×1)

const CAFE_GREEN = 0x2f7a4f, DICE = 0xf8f4ec, MEEPLE = 0xe8862a;
/** Pips of the dice sign: five on the front, three on the right, one on top (1, 3 and 5 meet at a corner). */
const dicePips = (x: number, y: number, z: number, s: number): Op[] => {
  const h = s / 2, o = s * 0.28, p = s * 0.16;
  const front: [number, number][] = [[-o, o], [o, o], [0, 0], [-o, -o], [o, -o]];
  const right: [number, number][] = [[-o, o], [0, 0], [o, -o]];
  return [
    ...front.map(([dx, dy]): Op => ['box', p, p, 0.006, rd(x + dx), rd(y + h + dy - p / 2), rd(z + h + 0.002), 'charcoal']),
    ...right.map(([dz, dy]): Op => ['box', 0.006, p, p, rd(x + h + 0.002), rd(y + h + dy - p / 2), rd(z + dz), 'charcoal']),
    ['box', p, 0.006, p, x, rd(y + s), z, 'charcoal'],
  ];
};
const boardGameCafe: Design[] = [
  { name: 'corner café with a striped awning, big windows, a giant dice and a chess knight on the roof', height: 0.76, ops: [
    slab(1, 1, PAVING),
    ['box', 0.66, 0.5, 0.56, -0.06, 0.02, -0.16, 0xe8dcc0, true, { name: 'cafe', facade: { storeys: 2, bays: 4, sideBays: 3 } }],
    ['door', 'cafe', 'front', 0, CAFE_GREEN],
    ...[0, 1, 2, 3].map((b): Op => ['awning', 'cafe', 'front', b, b, b % 2 ? 'white' : CAFE_GREEN]),
    ...[0, 1, 2].map((b): Op => ['awning', 'cafe', 'right', b, b, b % 2 ? CAFE_GREEN : 'white']),
    ['cornice', 'cafe', 1, CAFE_GREEN], ['cornice', 'cafe', 2, 'white'],
    // the dice, lit from dusk
    ['box', 0.16, 0.16, 0.16, 0.14, 0.55, 0.0, DICE, 'sign'], ...dicePips(0.14, 0.55, 0.0, 0.16),
    // the chess knight, its muzzle toward the dice
    ['cyl', 0.06, 0.065, 0.025, -0.24, 0.55, 0.0, 'charcoal', 12], ['cyl', 0.04, 0.05, 0.03, -0.24, 0.575, 0.0, 'charcoal', 12],
    ['taper', 0.07, 0.06, 0.05, 0.05, 0.09, -0.245, 0.605, 0.0, 'charcoal', { shift: [-0.01, 0] }],
    ['box', 0.11, 0.05, 0.045, -0.215, 0.665, 0.0, 'charcoal'], ['taper', 0.03, 0.03, 0, 0, 0.04, -0.255, 0.715, 0.0, 'charcoal'],
    ['box', 0.012, 0.012, 0.004, -0.2, 0.69, 0.024, 'white'],
    // pavement tables with chessboard tops, and an A-board
    ...[[0.06, 0.32], [0.38, 0.3]].flatMap(([x, z]): Op[] => [
      ['cyl', 0.035, 0.012, 0.07, x, 0.02, z, 'white', 8], ['box', 0.04, 0.003, 0.04, x, 0.09, z, 'charcoal'],
      ['box', 0.03, 0.04, 0.03, rd(x - 0.065), 0.02, z, 'timber'], ['box', 0.03, 0.04, 0.03, rd(x + 0.065), 0.02, z, 'timber'],
    ]),
    ['taper', 0.08, 0.06, 0.08, 0.01, 0.12, -0.3, 0.02, 0.32, 'charcoal'],
  ] },
  { name: 'narrow blue townhouse café with a games yard under a lit pergola and a giant meeple', height: 1.1, ops: [
    slab(1, 1, PAVING),
    ['box', 0.44, 0.78, 0.6, -0.2, 0.02, -0.15, 0x3f6b8f, true, { name: 'house', facade: { storeys: 3, bays: 2, sideBays: 3 } }],
    ['door', 'house', 'front', 0, 'yellow'], ['awning', 'house', 'front', 1, 1, 'yellow'],
    ['balcony', 'house', 'front', 2, 0, 1, 'white', 'white'],
    ['cornice', 'house', 1, 'white'],
    ['roof', 0.48, 0.24, 0.64, -0.2, 0.8, -0.15, 'slate', true],
    disc(-0.2, 0.88, 0.17, 0.04, 0xffd27a, 0.008, true, 12),
    ['box', 0.07, 0.3, 0.07, -0.35, 0.8, -0.3, 'brick'],
    // pergola over the games yard, string lights and the name board
    ...[[0.08, -0.28], [0.44, -0.28], [0.08, 0.12], [0.44, 0.12]].map(([x, z]): Op => ['cyl', 0.01, 0.01, 0.3, x, 0.02, z, 'timber', 5]),
    ['box', 0.016, 0.02, 0.44, 0.08, 0.32, -0.08, 'timber'], ['box', 0.016, 0.02, 0.44, 0.44, 0.32, -0.08, 'timber'],
    ...[-0.25, -0.12, 0.0, 0.12].map((z): Op => ['box', 0.4, 0.012, 0.016, 0.26, 0.34, z, 'timber']),
    ['box', 0.36, 0.004, 0.004, 0.26, 0.316, -0.08, 'charcoal'],
    ...repeat(5, (i): Op => ['box', 0.02, 0.022, 0.02, rd(0.12 + i * 0.07), 0.308, -0.08, 'marquee', 'sign']),
    ['box', 0.3, 0.06, 0.01, 0.26, 0.28, 0.13, MEEPLE, 'sign'],
    ...[[0.2, -0.16], [0.33, 0.0]].flatMap(([x, z]): Op[] => [
      ['cyl', 0.04, 0.015, 0.07, x, 0.02, z, 'timber', 8], ['box', 0.03, 0.04, 0.03, rd(x - 0.07), 0.02, z, 'white'], ['box', 0.03, 0.04, 0.03, rd(x + 0.07), 0.02, z, 'white'],
    ]),
    // the meeple on its plinth
    ['box', 0.16, 0.035, 0.12, 0.26, 0.02, 0.34, 'stone'],
    ['taper', 0.17, 0.06, 0.08, 0.06, 0.1, 0.26, 0.055, 0.34, MEEPLE], ['box', 0.03, 0.035, 0.062, 0.26, 0.055, 0.34, 'stone'],
    ['box', 0.2, 0.05, 0.06, 0.26, 0.155, 0.34, MEEPLE], ['box', 0.09, 0.04, 0.06, 0.26, 0.205, 0.34, MEEPLE],
    ['lathe', 0.26, 0.29, 0.31, MEEPLE, [0, 0, 0.045, 0, 0.045, 0.06, 0, 0.06], { seg: 14, axis: 'z' }],
    vase(-0.02, 0.02, 0.22, 'terracotta', 1.1),
  ] },
];

// ================================================================= escape room (1×1)

const DARK_BRICK = 0x7a3f2e, SHUTTER = 0x2f4a3a, KEYHOLE = 0x1c1622, GOTHIC = 0x6f6a78, LANTERN = 0xffc86a;
/** Shutters either side of the two first-floor windows of a 0.66-wide, two-bay venue front (beside the frames, never over them). */
const shutters = (x0: number, y: number, z: number): Op[] =>
  [0, 1].flatMap((b): Op[] => [0.047, 0.283].map((s): Op => ['box', 0.07, 0.225, 0.012, rd(x0 + b * 0.33 + s), y, z, SHUTTER]));
const escapeRoom: Design[] = [
  { name: 'dark brick house of puzzles with a keyhole door, a glowing padlock, shutters and a gas lamp', height: 0.86, ops: [
    slab(1, 1, 0x8a8478),
    ['box', 0.66, 0.5, 0.56, 0, 0.02, -0.16, DARK_BRICK, true, { name: 'house', facade: { storeys: 2, bays: 2, sideBays: 2, ground: 'plain' } }],
    ...shutters(-0.33, 0.28, 0.126),
    ['box', 0.012, 0.252, 0.284, 0.336, 0.269, -0.02, SHUTTER],
    // the keyhole door
    disc(-0.1, 0.195, 0.12, 0.07, 'gold'), ['taper', 0.14, 0.01, 0.07, 0.01, 0.16, -0.1, 0.02, 0.125, 'gold'],
    disc(-0.1, 0.195, 0.13, 0.052, KEYHOLE, 0.008), ['taper', 0.11, 0.008, 0.052, 0.008, 0.15, -0.1, 0.02, 0.134, KEYHOLE],
    ['box', 0.18, 0.015, 0.05, -0.1, 0.02, 0.145, 'stone'],
    // the padlock sign, lit from dusk
    ['box', 0.13, 0.1, 0.03, 0.17, 0.05, 0.135, 'gold', 'sign'],
    ['box', 0.02, 0.07, 0.02, 0.125, 0.15, 0.135, 'silver'], ['box', 0.02, 0.07, 0.02, 0.215, 0.15, 0.135, 'silver'], ['box', 0.11, 0.02, 0.02, 0.17, 0.22, 0.135, 'silver'],
    disc(0.17, 0.11, 0.15, 0.014, 'charcoal', 0.006, false, 10), ['box', 0.01, 0.025, 0.006, 0.17, 0.075, 0.153, 'charcoal'],
    ['box', 0.05, 0.22, 0.012, -0.3, 0.02, 0.126, 'hedge'], ['box', 0.04, 0.12, 0.012, -0.255, 0.02, 0.126, 0x4f8a45],
    ['roof', 0.7, 0.2, 0.6, 0, 0.52, -0.16, 'slate'],
    ['box', 0.08, 0.26, 0.08, 0.22, 0.52, -0.3, DARK_BRICK], ['cyl', 0.015, 0.015, 0.06, 0.2, 0.78, -0.3, 'terracotta', 6], ['cyl', 0.015, 0.015, 0.05, 0.24, 0.78, -0.3, 'terracotta', 6],
    // gas lamp with a hanging sign, railings
    ['cyl', 0.01, 0.014, 0.34, -0.4, 0.02, 0.3, 'charcoal', 6], ['box', 0.05, 0.07, 0.05, -0.4, 0.36, 0.3, LANTERN, 'fire'], ['cone', 0.04, 0.04, -0.4, 0.43, 0.3, 'charcoal', 4],
    ['box', 0.08, 0.012, 0.012, -0.36, 0.3, 0.3, 'charcoal'], ['box', 0.07, 0.06, 0.01, -0.34, 0.24, 0.3, 0x6a4a8a, 'sign'],
    ...fence(0.24, 0.42, 0.4, true, 'charcoal', 0.1),
  ] },
  { name: 'mock-Gothic puzzle house with a clock in its gable, pinnacles, lanterns and a golden key sign', height: 0.92, ops: [
    slab(1, 1, 0x6b6a72),
    ['box', 0.62, 0.48, 0.54, 0, 0.02, -0.18, GOTHIC, true, { name: 'house', facade: { storeys: 2, bays: 3, sideBays: 3, margin: 0.06, ground: 'door' } }],
    ['taper', 0.11, 0.012, 0, 0.012, 0.045, 0, 0.21, 0.096, 'stone'],
    ['roof', 0.66, 0.34, 0.58, 0, 0.5, -0.18, 'slate', true],
    // the clock in the gable, lit from dusk
    disc(0, 0.62, 0.11, 0.075, 'gold', 0.012), disc(0, 0.62, 0.122, 0.062, 0xf6f2ea, 0.006, true),
    ['box', 0.008, 0.045, 0.004, 0, 0.62, 0.13, 'charcoal'], ['box', 0.05, 0.008, 0.004, 0.025, 0.616, 0.13, 'charcoal'],
    // pinnacles at the corners and on the apex
    ['box', 0.05, 0.58, 0.05, -0.31, 0.02, 0.09, 'stone'], ['box', 0.05, 0.58, 0.05, 0.31, 0.02, 0.09, 'stone'],
    ['taper', 0.07, 0.07, 0, 0, 0.14, -0.31, 0.6, 0.09, 'stone'], ['taper', 0.07, 0.07, 0, 0, 0.14, 0.31, 0.6, 0.09, 'stone'],
    ['taper', 0.04, 0.04, 0, 0, 0.1, 0, 0.82, 0.1, 'stone'],
    // the golden key hanging from an iron arm
    ['cyl', 0.01, 0.014, 0.44, 0.4, 0.02, 0.28, 'charcoal', 6], ['box', 0.22, 0.012, 0.012, 0.29, 0.44, 0.28, 'charcoal'],
    ['box', 0.004, 0.04, 0.004, 0.22, 0.4, 0.28, 'charcoal'], ['box', 0.004, 0.04, 0.004, 0.34, 0.4, 0.28, 'charcoal'],
    ['box', 0.14, 0.018, 0.012, 0.27, 0.382, 0.28, 'gold', 'sign'],
    ['lathe', 0.34, 0.39, 0.274, 'gold', [0, 0, 0.04, 0, 0.04, 0.012, 0, 0.012], { seg: 14, axis: 'z', win: 'sign' }],
    disc(0.34, 0.39, 0.286, 0.018, 0x2b2e36, 0.004, false, 10),
    ['box', 0.02, 0.04, 0.012, 0.21, 0.342, 0.28, 'gold', 'sign'], ['box', 0.016, 0.026, 0.012, 0.24, 0.348, 0.28, 'gold', 'sign'],
    // lanterns either side of the path, spiked railings
    ...[-0.14, 0.14].flatMap((x): Op[] => [['cyl', 0.008, 0.01, 0.26, x, 0.02, 0.3, 'charcoal', 5], ['box', 0.04, 0.05, 0.04, x, 0.28, 0.3, LANTERN, 'fire']]),
    ...fence(-0.3, 0.44, 0.3, true, 'charcoal', 0.1), ...fence(0.3, 0.44, 0.3, true, 'charcoal', 0.1),
  ] },
];

export const INDOOR_MODELS: Record<string, Design[]> = {
  cityFarm, aquarium, planetarium, scienceCentre, observatory, funfair,
  artGallery, potteryStudio, danceHall, concertHall, arcade, boardGameCafe, escapeRoom,
};
