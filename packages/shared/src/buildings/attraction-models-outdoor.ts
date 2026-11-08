import type { Design, Op, Color } from './schema';
import { repeat } from './helpers';
import { slab, tree, pine, car, carRow, bayLines, ASPHALT, PAVING } from './tierkit';

/**
 * Models for the outdoor and active free-time places (attractions.ts), keyed by the kind's
 * variable name there. Recipes are authored in tiles for the whole footprint, centred on 0,0 with +z to the road.
 * Two designs per kind; a tile picks one by hash.
 */

// ---------------------------------------------------------------- local parts

/** A lawn over a w×d footprint, inset like a slab. */
const lawn = (w: number, d: number, c: Color = 'lawn'): Op => ['box', w - 0.04, 0.012, d - 0.04, 0, 0, 0, c];
/** A path laid on the lawn. */
const path = (w: number, d: number, x: number, z: number, c: Color = 'gravel', y = 0.012): Op => ['box', w, 0.004, d, x, y, z, c];
/** Water of overlapping discs (an edge that is not a rectangle): a bank ring under each disc, then the water. */
const lake = (parts: [number, number, number][], bank: Color = 'stone', water: Color = 'pond'): Op[] => [
  ...parts.map(([x, z, r]): Op => ['cyl', r + 0.04, r + 0.05, 0.016, x, 0.008, z, bank, 16]),
  ...parts.map(([x, z, r]): Op => ['cyl', r, r, 0.02, x, 0.01, z, water, 16]),
];
/** A bench standing on the ground: a solid seat and a backrest on the `back` side (-1 or 1 along z, or along x). */
const bench = (x: number, z: number, alongX = true, back = -1, c: Color = 'timber', y = 0.012): Op[] => alongX
  ? [['box', 0.12, 0.03, 0.04, x, y, z, c], ['box', 0.12, 0.06, 0.01, x, y, z + back * 0.02, c]]
  : [['box', 0.04, 0.03, 0.12, x, y, z, c], ['box', 0.01, 0.06, 0.12, x + back * 0.02, y, z, c]];
/** A thin bar from (x0, y0, z0) up to (x1, y1, z1): a sheared prism (a zip wire, a handrail, a rope, a strut). */
const rod = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number, c: Color): Op =>
  ['taper', t, t, t, t, y1 - y0, x0, y0, z0, c, { shift: [x1 - x0, z1 - z0] }];
/** A lamp post whose head glows after dusk. */
const lamp = (x: number, z: number, h: number, head: Color = 'marquee', y = 0.012): Op[] => [
  ['cyl', 0.008, 0.012, h, x, y, z, 'charcoal', 5], ['box', 0.06, 0.03, 0.04, x, y + h, z, head, 'sign'],
];
/** A floodlight mast with a lamp bank facing `face` (along z unless alongX). */
const floodlight = (x: number, z: number, h: number, alongX = true, y = 0.012): Op[] => [
  ['cyl', 0.012, 0.02, h, x, y, z, 'steel', 5],
  ['box', alongX ? 0.14 : 0.04, 0.07, alongX ? 0.04 : 0.14, x, y + h, z, 'marquee', 'sign'],
  ['box', alongX ? 0.15 : 0.05, 0.015, alongX ? 0.05 : 0.15, x, y + h + 0.07, z, 'charcoal'],
];
/** A clump of reeds: thin cones of two greens. */
const reeds = (x: number, z: number, n = 3, s = 1, y = 0.012): Op[] => repeat(n, (i): Op =>
  ['cone', 0.02 * s, (0.08 + (i % 2) * 0.04) * s, x + (((i * 37) % 7) - 3) * 0.014 * s, y, z + (((i * 53) % 5) - 2) * 0.016 * s, i % 3 ? 0x6f8a3a : 0x9a9a4a, 5]);
/** A flat disc facing the road (a sign roundel, a clock face, a wheel), its back at z. */
const disc = (x: number, y: number, z: number, r: number, c: Color, t = 0.008, seg = 16): Op => ['lathe', x, y, z, c, [r, 0, r, t], { axis: 'z', seg }];
/** A low railing panel between two points on the same x or z (a solid strip reads as railings at this scale). */
const rail = (x0: number, z0: number, x1: number, z1: number, h: number, c: Color, y = 0.012, t = 0.01): Op =>
  z0 === z1 ? ['box', Math.abs(x1 - x0), h, t, (x0 + x1) / 2, y, z0, c] : ['box', t, h, Math.abs(z1 - z0), x0, y, (z0 + z1) / 2, c];
/** A weeping willow: trunk and a bell of drooping leaves. */
const willow = (x: number, z: number, s = 1): Op[] => [
  ['cyl', 0.014 * s, 0.02 * s, 0.12 * s, x, 0.012, z, 'timber', 5],
  ['lathe', x, 0.04 * s, z, 0x8aa84a, [0.13 * s, 0, 0.14 * s, 0.07 * s, 0.11 * s, 0.15 * s, 0.05 * s, 0.2 * s, 0, 0.21 * s], { seg: 9 }],
];
/** An allotment plot: dug soil with `rows` crop rows along x, alternating two crop colours. */
const plot = (x: number, z: number, w: number, d: number, rows: number, crop: Color, crop2: Color = crop, h = 0.03): Op[] => [
  ['box', w, 0.02, d, x, 0.012, z, SOIL],
  ...repeat(rows, (i): Op => ['box', w - 0.06, h, 0.035, x, 0.032, z - d / 2 + (d / rows) * (i + 0.5), i % 2 ? crop2 : crop]),
];
/** A raised timber bed with soil and `rows` crop rows on top. */
const raised = (x: number, z: number, w: number, d: number, rows: number, crop: Color, crop2: Color = crop): Op[] => [
  ['box', w, 0.05, d, x, 0.012, z, 0xa07a4a], ['box', w - 0.024, 0.006, d - 0.024, x, 0.058, z, SOIL],
  ...repeat(rows, (i): Op => ['box', w - 0.06, 0.03, (d - 0.06) / rows - 0.02, x, 0.064, z - (d - 0.06) / 2 + ((d - 0.06) / rows) * (i + 0.5), i % 2 ? crop2 : crop]),
];
/** A garden shed: walls and a pitched roof (ridge along x). */
const shed = (x: number, z: number, w: number, d: number, h: number, body: Color, roof: Color): Op[] => [
  ['box', w, h, d, x, 0.012, z, body], ['roof', w + 0.03, 0.06, d + 0.03, x, 0.012 + h, z, roof],
];
/** Tennis lines for a court of length L and width W centred on cx, cz, its length along z (or along x), painted at y. */
const courtLines = (cx: number, cz: number, L: number, W: number, alongX: boolean, y: number, c: Color = 'white'): Op[] => {
  const t = 0.006, h = 0.004;
  // [along-length size, across size, offset along length, offset across]
  const parts: [number, number, number, number][] = [
    [L, t, 0, -W / 2], [L, t, 0, W / 2], [t, W, -L / 2, 0], [t, W, L / 2, 0],
    [t, W * 0.75, -L * 0.27, 0], [t, W * 0.75, L * 0.27, 0], [L * 0.54, t, 0, 0],
  ];
  return parts.map(([l, w, dl, dw]): Op => alongX ? ['box', l, h, w, cx + dl, y, cz + dw, c] : ['box', w, h, l, cx + dw, y, cz + dl, c]);
};
const RUBBER_G = 0x3f9a6a, RUBBER_R = 0xd9534f, RUBBER_B = 0x3a7fc4, BARK = 0x8a6a48, SOIL = 0x5a3f2a, CONCRETE = 0xb4b1aa;

export const OUTDOOR_MODELS: Record<string, Design[]> = {
  // ================================================================= Play and green
  playground: [
    { name: 'adventure playground with swings, a climbing tower and slide, a zip wire and a roundabout', height: 0.42, ops: [
      lawn(1, 1),
      ['box', 0.42, 0.006, 0.26, -0.2, 0.012, -0.27, RUBBER_G], ['box', 0.34, 0.006, 0.36, 0.2, 0.012, -0.16, RUBBER_R],
      ['cyl', 0.15, 0.15, 0.006, -0.22, 0.012, 0.2, RUBBER_B, 14], path(0.12, 0.22, 0.08, 0.36),
      // a low railing all round, a gap at the front for the gate
      rail(-0.46, -0.46, 0.46, -0.46, 0.06, 0x2f5a3c), rail(-0.46, -0.46, -0.46, 0.46, 0.06, 0x2f5a3c), rail(0.46, -0.46, 0.46, 0.46, 0.06, 0x2f5a3c),
      rail(-0.46, 0.46, 0.0, 0.46, 0.06, 0x2f5a3c), rail(0.16, 0.46, 0.46, 0.46, 0.06, 0x2f5a3c),
      ['box', 0.02, 0.18, 0.02, 0.0, 0.012, 0.46, 'yellow'], ['box', 0.02, 0.18, 0.02, 0.16, 0.012, 0.46, 'yellow'], ['box', 0.2, 0.05, 0.016, 0.08, 0.15, 0.46, 0xe0a42e],
      // swings: two A-frames and a top bar (the seats on their chains swing in the client's animation pass, render/leisureRigs.ts)
      ['taper', 0.02, 0.16, 0.02, 0.02, 0.2, -0.39, 0.018, -0.27, RUBBER_R], ['taper', 0.02, 0.16, 0.02, 0.02, 0.2, -0.01, 0.018, -0.27, RUBBER_R],
      ['box', 0.4, 0.016, 0.016, -0.2, 0.204, -0.27, 'yellow'],
      // climbing tower: posts, a deck, a pyramid roof, a rail, a scramble net and a slide to the front
      ...[[-0.07, -0.07], [0.07, -0.07], [-0.07, 0.07], [0.07, 0.07]].map(([dx, dz]): Op => ['box', 0.018, 0.3, 0.018, 0.2 + dx, 0.018, -0.2 + dz, 'timber']),
      ['box', 0.16, 0.02, 0.16, 0.2, 0.15, -0.2, BARK], ['taper', 0.2, 0.2, 0, 0, 0.09, 0.2, 0.318, -0.2, 'red'],
      ['box', 0.16, 0.05, 0.008, 0.2, 0.17, -0.276, 'yellow'],
      ['taper', 0.1, 0.12, 0.01, 0.12, 0.15, 0.08, 0.018, -0.2, 0xc9a66b, { shift: [0.045, 0] }],
      ['taper', 0.07, 0.22, 0.07, 0.01, 0.15, 0.2, 0.018, 0.01, 'yellow', { shift: [0, -0.105] }],
      // zip wire down the right side: a tall post at the back, a low one at the front, a seat on a rope
      ['box', 0.024, 0.3, 0.024, 0.41, 0.012, -0.38, 'timber'], ['box', 0.024, 0.16, 0.024, 0.41, 0.012, 0.3, 'timber'],
      rod(0.41, 0.165, 0.3, 0.41, 0.305, -0.38, 0.006, 'charcoal'),
      // (the seat runs down the wire in the client's animation pass)
      // roundabout's base post on its rubber pad (the disc and bars turn in the client's animation pass)
      ['cyl', 0.02, 0.02, 0.02, -0.22, 0.018, 0.2, 'charcoal', 6],
      ...bench(0.32, 0.36, true, 1), ['cyl', 0.018, 0.016, 0.05, 0.42, 0.012, 0.38, 'green', 6], ...tree(0.36, 0.14, 0.75),
    ] },
    { name: 'timber castle play fort with a rope bridge, a slide and a sandpit', height: 0.48, ops: [
      lawn(1, 1, 'lawnDark'), ['box', 0.86, 0.006, 0.36, 0, 0.012, -0.24, BARK], path(0.12, 0.3, 0.1, 0.33),
      rail(-0.46, -0.46, 0.46, -0.46, 0.05, 'timber'), rail(-0.46, -0.46, -0.46, 0.46, 0.05, 'timber'), rail(0.46, -0.46, 0.46, 0.46, 0.05, 'timber'),
      rail(-0.46, 0.46, 0.03, 0.46, 0.05, 'timber'), rail(0.17, 0.46, 0.46, 0.46, 0.05, 'timber'),
      ['box', 0.024, 0.12, 0.024, 0.03, 0.012, 0.46, 'timber'], ['box', 0.024, 0.12, 0.024, 0.17, 0.012, 0.46, 'timber'],
      // the keep: crenellations, a door, an arrow slit and a flag
      ['box', 0.22, 0.26, 0.2, -0.26, 0.018, -0.22, 0x9a6b3f],
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]): Op => ['box', 0.05, 0.05, 0.05, -0.26 + sx * 0.085, 0.278, -0.22 + sz * 0.075, 0x9a6b3f]),
      ['box', 0.07, 0.11, 0.01, -0.21, 0.018, -0.116, 'door'], ['box', 0.02, 0.06, 0.01, -0.31, 0.17, -0.116, 'charcoal'],
      ['flag', -0.26, 0.278, -0.22, 'red'],
      ['taper', 0.09, 0.12, 0.09, 0.01, 0.2, -0.31, 0.018, -0.06, 0xc9a66b, { shift: [0, -0.055] }],
      // the watch tower with a cone roof, joined by a rope bridge, and a slide out of the front
      ['box', 0.16, 0.32, 0.16, 0.24, 0.018, -0.28, 0x8a5a32], ['cone', 0.12, 0.14, 0.24, 0.338, -0.28, 'red', 8],
      ['box', 0.06, 0.07, 0.01, 0.24, 0.19, -0.196, 'door'],
      ['box', 0.31, 0.012, 0.06, 0.005, 0.17, -0.24, 'timber'],
      ['box', 0.31, 0.006, 0.006, 0.005, 0.23, -0.27, 0xd9c38e], ['box', 0.31, 0.006, 0.006, 0.005, 0.23, -0.21, 0xd9c38e],
      ['taper', 0.07, 0.28, 0.07, 0.01, 0.18, 0.24, 0.012, -0.06, 'boxBlue', { shift: [0, -0.135] }],
      // sandpit with a bucket and spade, log seats, spring riders, a bench and a tree
      ['box', 0.3, 0.028, 0.22, -0.24, 0.012, 0.26, 'timber'], ['box', 0.27, 0.03, 0.19, -0.24, 0.012, 0.26, 'sand'],
      ['cyl', 0.018, 0.014, 0.03, -0.3, 0.042, 0.24, 'red', 6], ['box', 0.04, 0.008, 0.012, -0.18, 0.042, 0.29, 'boxBlue'],
      ...[[-0.05, 0.2], [-0.04, 0.32], [-0.38, 0.06]].map(([x, z]): Op => ['cyl', 0.025, 0.028, 0.035, x, 0.012, z, 'timber', 7]),
      ...[[0.37, 0.14, 'red'], [0.37, 0.32, 'boxGreen']].flatMap(([x, z, c]): Op[] => [
        ['cyl', 0.01, 0.012, 0.04, x as number, 0.012, z as number, 'steel', 5], ['box', 0.07, 0.04, 0.03, x as number, 0.05, z as number, c as Color],
      ]),
      ...bench(0.4, -0.04, false, 1), ...tree(0.4, -0.4, 0.8),
    ] },
  ],
  skatePark: [
    { name: 'concrete bowl and a mini half-pipe with a funbox, a grind rail, a painted wall and a floodlight', height: 0.7, ops: [
      slab(1, 1, CONCRETE),
      // the bowl: steel coping round two lobes, a paler interior and the deep end
      ['cyl', 0.215, 0.215, 0.006, -0.22, 0.02, -0.17, 'steel', 18], ['cyl', 0.145, 0.145, 0.006, -0.3, 0.02, 0.04, 'steel', 14],
      ['cyl', 0.2, 0.2, 0.008, -0.22, 0.02, -0.17, 0x9d9a93, 18], ['cyl', 0.13, 0.13, 0.008, -0.3, 0.02, 0.04, 0x9d9a93, 14],
      ['cyl', 0.1, 0.1, 0.01, -0.22, 0.02, -0.2, 0x878580, 14],
      // mini half-pipe: two curved quarter pipes (a gentle and a steep facet each), coping and a deck rail
      ['taper', 0.36, 0.22, 0.36, 0.12, 0.04, 0.26, 0.02, -0.33, 0xc4c1ba, { shift: [0, -0.05] }],
      ['taper', 0.36, 0.12, 0.36, 0.08, 0.1, 0.26, 0.06, -0.38, 0xc4c1ba, { shift: [0, -0.02] }],
      ['wheel', 0.008, 0.36, 0.26, 0.16, -0.36, 'steel'], ['box', 0.36, 0.06, 0.008, 0.26, 0.16, -0.436, 'charcoal'],
      ['taper', 0.36, 0.22, 0.36, 0.12, 0.04, 0.26, 0.02, 0.01, 0xbdbab2, { shift: [0, 0.05] }],
      ['taper', 0.36, 0.12, 0.36, 0.08, 0.1, 0.26, 0.06, 0.06, 0xbdbab2, { shift: [0, 0.02] }],
      ['wheel', 0.008, 0.36, 0.26, 0.16, 0.04, 'steel'],
      // funbox with two ramps and a steel edge, and a grind rail in front
      ['box', 0.16, 0.06, 0.14, -0.2, 0.02, 0.32, 0xa9a69e], ['box', 0.16, 0.006, 0.006, -0.2, 0.077, 0.39, 'steel'],
      ['taper', 0.12, 0.14, 0.01, 0.14, 0.06, -0.34, 0.02, 0.32, 0xbdbab2, { shift: [0.055, 0] }],
      ['taper', 0.12, 0.14, 0.01, 0.14, 0.06, -0.06, 0.02, 0.32, 0xbdbab2, { shift: [-0.055, 0] }],
      ['box', 0.01, 0.04, 0.01, -0.36, 0.02, 0.44, 'charcoal'], ['box', 0.01, 0.04, 0.01, -0.06, 0.02, 0.44, 'charcoal'], ['box', 0.32, 0.01, 0.01, -0.21, 0.06, 0.44, 'yellow'],
      // a painted wall (a mural, no tags) along the back
      ['box', 0.46, 0.16, 0.03, -0.22, 0.02, -0.455, 0x5a8fc4],
      ['box', 0.12, 0.08, 0.004, -0.37, 0.05, -0.439, 'yellow'], ['box', 0.1, 0.11, 0.004, -0.22, 0.04, -0.439, 'boxOrange'], ['box', 0.12, 0.06, 0.004, -0.08, 0.08, -0.439, RUBBER_G],
      ...floodlight(0.44, 0.22, 0.6, false), ...bench(0.24, 0.42, true, 1, 'charcoal'), ['cyl', 0.018, 0.016, 0.05, 0.1, 0.02, 0.44, 'green', 6], ...tree(0.38, 0.38, 0.7, 'hedge', 0.02),
    ] },
    { name: 'street plaza with ledges, stairs, a handrail and a pump track', height: 0.4, ops: [
      slab(1, 1, 0xcbc5b8),
      // raised terrace at the back with two steps, a handrail and a hubba ledge down to the plaza
      ['box', 0.92, 0.1, 0.28, 0, 0.02, -0.32, 0xb1aca2],
      ['box', 0.34, 0.067, 0.045, -0.05, 0.02, -0.1575, 0xb8b3a9], ['box', 0.34, 0.033, 0.045, -0.05, 0.02, -0.1125, 0xbfbab0],
      ['box', 0.008, 0.05, 0.008, 0.14, 0.02, -0.08, 'steel'], ['box', 0.008, 0.05, 0.008, 0.14, 0.12, -0.2, 'steel'], rod(0.14, 0.07, -0.08, 0.14, 0.17, -0.2, 0.008, 'steel'),
      ['taper', 0.08, 0.1, 0.08, 0.01, 0.1, 0.22, 0.02, -0.13, 0xa9a49a, { shift: [0, -0.045] }],
      // ledges with steel edges and a manual pad
      ['box', 0.3, 0.05, 0.08, -0.28, 0.02, 0.1, 0xbdb9b0], ['box', 0.3, 0.006, 0.006, -0.28, 0.067, 0.14, 'steel'],
      ['box', 0.08, 0.04, 0.24, -0.4, 0.02, 0.32, 0xb5b0a6], ['box', 0.006, 0.006, 0.24, -0.36, 0.057, 0.32, 'steel'],
      ['box', 0.16, 0.025, 0.12, -0.12, 0.02, 0.34, 0xa9a49a],
      // pump track: an asphalt loop of rollers round a grass island with a sapling
      ['cyl', 0.2, 0.21, 0.008, 0.24, 0.02, 0.24, ASPHALT, 18], ['cyl', 0.08, 0.09, 0.02, 0.24, 0.02, 0.24, 'lawn', 12],
      ...repeat(4, (i): Op => {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        return ['lathe', 0.24 + 0.145 * Math.cos(a), 0.028, 0.24 + 0.145 * Math.sin(a), 0x4a4d55, [0.055, 0, 0.04, 0.025, 0, 0.035], { seg: 10 }];
      }),
      ...tree(0.24, 0.24, 0.55, 'hedge', 0.04),
      // planters, a bench and lamps on the terrace
      ['box', 0.12, 0.06, 0.12, -0.38, 0.12, -0.36, 0x8f8a80], ...tree(-0.38, -0.36, 0.7, 'green', 0.18),
      ['box', 0.12, 0.06, 0.12, 0.38, 0.12, -0.38, 0x8f8a80], ...tree(0.38, -0.38, 0.65, 'hedge', 0.18),
      ...bench(0.37, -0.22, true, -1, 'timber', 0.12), ...lamp(-0.2, -0.4, 0.26, 'marquee', 0.12), ...lamp(-0.44, 0.44, 0.3, 'marquee', 0.02),
    ] },
  ],
  allotments: [
    { name: 'hedged allotment plots with coloured sheds, a greenhouse, water butts and a scarecrow', height: 0.28, ops: [
      lawn(2, 2, 'lawnDark'),
      ['box', 1.92, 0.09, 0.06, 0, 0.012, -0.93, 'hedge'], ['box', 0.06, 0.09, 1.8, -0.93, 0.012, 0, 'hedge'], ['box', 0.06, 0.09, 1.8, 0.93, 0.012, 0, 'hedge'],
      ['box', 0.38, 0.09, 0.06, -0.77, 0.012, 0.93, 'hedge'], ['box', 1.38, 0.09, 0.06, 0.27, 0.012, 0.93, 'hedge'],
      ['box', 0.025, 0.12, 0.025, -0.575, 0.012, 0.93, 'timber'], ['box', 0.025, 0.12, 0.025, -0.425, 0.012, 0.93, 'timber'], ['box', 0.2, 0.04, 0.012, -0.5, 0.11, 0.93, 'green'],
      path(0.14, 1.8, -0.5, 0.03), path(1.33, 0.1, 0.235, 0.62, 'lawn'),
      // left: a blue shed and its water butt, salad rows, bean wigwams, rhubarb and a compost bin
      ...shed(-0.74, -0.76, 0.22, 0.16, 0.15, 0x5a7fa0, 'roofGrey'), ['cyl', 0.03, 0.03, 0.07, -0.66, 0.012, -0.62, 'green', 8],
      ...plot(-0.74, -0.38, 0.26, 0.36, 3, 0x6aa04a),
      ...plot(-0.74, 0.06, 0.26, 0.4, 0, SOIL), ['taper', 0.07, 0.07, 0, 0, 0.17, -0.79, 0.032, 0.02, 0x6f8f3a], ['taper', 0.07, 0.07, 0, 0, 0.15, -0.68, 0.032, 0.12, 0x5f8a3a],
      ...plot(-0.74, 0.48, 0.26, 0.32, 2, 0x5f9a3a, 0x7a9a3a, 0.045), ['box', 0.12, 0.07, 0.1, -0.74, 0.012, 0.79, 0x6b4a2a],
      // middle: four long plots, one with a scarecrow
      ...plot(-0.09, -0.68, 0.62, 0.36, 4, 0x4f8a3a, 0x6aa04a),
      ...plot(-0.09, -0.24, 0.62, 0.4, 3, 0x7aa86a, 0x9a4a6a),
      ...plot(-0.09, 0.22, 0.62, 0.4, 2, 0x8aa83a),
      ['cyl', 0.007, 0.007, 0.19, -0.02, 0.032, 0.22, 'timber', 4], ['box', 0.12, 0.012, 0.012, -0.02, 0.16, 0.22, 'timber'],
      ['box', 0.045, 0.05, 0.025, -0.02, 0.12, 0.22, 'red'], ['cyl', 0.016, 0.016, 0.03, -0.02, 0.21, 0.22, 'sand', 6], ['cone', 0.03, 0.035, -0.02, 0.24, 0.22, 'timber', 6],
      // right: a greenhouse, a red shed, lettuces and a row of sunflowers
      ['box', 0.4, 0.14, 0.24, 0.64, 0.012, -0.74, 0xcfe9ee], ['roof', 0.4, 0.07, 0.24, 0.64, 0.152, -0.74, 0xbfe0e6], ['box', 0.41, 0.012, 0.012, 0.64, 0.215, -0.74, 'white'],
      ...plot(0.64, -0.36, 0.52, 0.36, 3, 0x5f9a3a, 'plum'),
      ...shed(0.8, 0.0, 0.16, 0.14, 0.14, 0x9a5a3a, 'slate'), ['cyl', 0.03, 0.03, 0.07, 0.66, 0.012, -0.02, 'charcoal', 8],
      ...plot(0.64, 0.36, 0.52, 0.32, 2, 0x4f8a3a),
      ...[0.48, 0.64, 0.8].flatMap((x, i): Op[] => [
        ['cyl', 0.006, 0.006, 0.18 + i * 0.02, x, 0.032, 0.25, 0x5f8a3a, 4], disc(x, 0.2 + i * 0.02, 0.256, 0.025, 'yellow', 0.008, 10),
      ]),
      // cut flowers along the front and a bench
      ...repeat(6, (i): Op => ['cone', 0.03, 0.05, 0.1 + i * 0.13, 0.012, 0.8, (['red', 'yellow', 'plum', 'white', 'boxOrange', 'plum'] as const)[i], 5]),
      ...bench(-0.25, 0.8, true, 1),
    ] },
    { name: 'raised-bed allotments with a polytunnel, a fruit cage, compost bays and a communal hut with a flag', height: 0.32, ops: [
      lawn(2, 2), path(0.14, 1.83, -0.5, 0.015, BARK), path(1.83, 0.1, 0, -0.1, BARK), path(1.83, 0.1, 0, 0.5, BARK),
      rail(-0.95, -0.95, 0.95, -0.95, 0.07, BARK), rail(-0.95, -0.95, -0.95, 0.95, 0.07, BARK), rail(0.95, -0.95, 0.95, 0.95, 0.07, BARK),
      rail(-0.95, 0.95, -0.58, 0.95, 0.07, BARK), rail(-0.42, 0.95, 0.95, 0.95, 0.07, BARK),
      ['box', 0.025, 0.2, 0.025, -0.575, 0.012, 0.95, 'timber'], ['box', 0.025, 0.2, 0.025, -0.425, 0.012, 0.95, 'timber'], ['box', 0.2, 0.03, 0.04, -0.5, 0.212, 0.95, 'timber'],
      // raised beds down the left
      ...raised(-0.76, -0.7, 0.28, 0.24, 2, 0x4f8a3a, 0x6aa04a), ...raised(-0.76, -0.35, 0.28, 0.24, 1, 0x7aa86a),
      // polytunnel (three facets of a half-round hoop) and its door
      ['taper', 0.8, 0.28, 0.8, 0.22, 0.07, 0.05, 0.012, -0.7, 0xe6ecee], ['taper', 0.8, 0.22, 0.8, 0.12, 0.05, 0.05, 0.082, -0.7, 0xe6ecee],
      ['taper', 0.8, 0.12, 0.8, 0, 0.025, 0.05, 0.132, -0.7, 0xdfe6e8], ['box', 0.01, 0.1, 0.08, -0.352, 0.012, -0.7, 0x5a6a5a],
      // compost bays: a back board, four dividers and two heaps
      ['box', 0.36, 0.08, 0.02, 0.72, 0.012, -0.87, 'timber'],
      ...repeat(4, (i): Op => ['box', 0.015, 0.08, 0.16, 0.55 + i * 0.115, 0.012, -0.8, 'timber']),
      ['cone', 0.05, 0.06, 0.61, 0.012, -0.8, SOIL, 7], ['cone', 0.05, 0.05, 0.72, 0.012, -0.8, 0x6b4a2a, 7],
      // a row of beds between the tunnel and the cross path
      ...raised(-0.22, -0.32, 0.32, 0.22, 2, 0x8aa83a, 0x5f9a3a), ...raised(0.18, -0.32, 0.32, 0.22, 1, 'plum'), ...raised(0.6, -0.32, 0.32, 0.22, 2, 0x6aa04a, 0x4f8a3a),
      // fruit cage: posts, top rails and berry bushes
      ...[[-0.35, 0.02], [0.15, 0.02], [-0.35, 0.38], [0.15, 0.38]].map(([x, z]): Op => ['box', 0.012, 0.16, 0.012, x, 0.012, z, 0x2f4a3a]),
      ['box', 0.51, 0.008, 0.008, -0.1, 0.168, 0.02, 0x2f4a3a], ['box', 0.51, 0.008, 0.008, -0.1, 0.168, 0.38, 0x2f4a3a],
      ['box', 0.008, 0.008, 0.37, -0.35, 0.168, 0.2, 0x2f4a3a], ['box', 0.008, 0.008, 0.37, 0.15, 0.168, 0.2, 0x2f4a3a],
      ...[[-0.24, 0.12], [-0.02, 0.14], [-0.14, 0.28]].map(([x, z], i): Op => ['lathe', x, 0.012, z, i === 1 ? 0x3f6b3a : 0x4f7a3a, [0.06, 0, 0.065, 0.04, 0.04, 0.08, 0, 0.09], { seg: 8 }]),
      // the communal hut with a deck, a bench and the society's flag
      ['box', 0.44, 0.2, 0.26, 0.6, 0.012, 0.18, 0x4f7a5a], ['roof', 0.48, 0.1, 0.3, 0.6, 0.212, 0.18, 'slate'],
      ['box', 0.44, 0.02, 0.08, 0.6, 0.012, 0.35, 'timber'], ['box', 0.06, 0.12, 0.01, 0.5, 0.032, 0.312, 'door'],
      ['flag', 0.3, 0.012, 0.42, 'boxGreen'], ...bench(0.72, 0.36, true, -1, 'timber', 0.032),
      // beds by the front fence, a water tank and two beehives
      ...raised(0.02, 0.75, 0.34, 0.24, 2, 0x5f9a3a, 'yellow'), ...raised(0.42, 0.75, 0.3, 0.24, 1, 0x6aa04a),
      ['cyl', 0.05, 0.05, 0.12, -0.3, 0.012, 0.75, 0x2f5a3c, 10],
      ['box', 0.07, 0.08, 0.07, 0.76, 0.012, 0.7, 'white'], ['box', 0.07, 0.08, 0.07, 0.86, 0.012, 0.82, 'white'],
    ] },
  ],
  fishingLake: [
    { name: 'irregular lake ringed with fishing pegs and reeds, a wooded island and a bailiff\'s hut', height: 0.32, ops: [
      lawn(2, 2),
      ...lake([[-0.2, -0.25, 0.55], [0.35, -0.2, 0.45], [0.05, 0.22, 0.36], [-0.45, 0.12, 0.3]], 0x8f8a5a),
      ['cyl', 0.13, 0.15, 0.03, -0.22, 0.01, -0.3, 'lawnDark', 10], ...tree(-0.22, -0.3, 0.9, 'hedge', 0.04),
      // timber pegs on the water's edge, rods out on three and a green brolly over one
      ...[[-0.2, -0.8], [0.8, -0.2], [0.55, -0.6], [0.05, 0.58], [0.3, 0.48], [-0.66, 0.33], [-0.74, -0.35]].map(([x, z]): Op => ['box', 0.08, 0.024, 0.08, x, 0.012, z, 'timber']),
      rod(-0.2, 0.036, -0.8, -0.2, 0.11, -0.64, 0.004, 'charcoal'), rod(0.8, 0.036, -0.2, 0.64, 0.11, -0.2, 0.004, 'charcoal'), rod(0.05, 0.036, 0.58, 0.05, 0.11, 0.42, 0.004, 'charcoal'),
      ['cyl', 0.004, 0.004, 0.1, -0.68, 0.036, 0.35, 'charcoal', 4], ['cone', 0.07, 0.04, -0.68, 0.11, 0.35, 0x2f5a3c, 8],
      ...reeds(-0.59, -0.64, 3), ...reeds(0.67, 0.12, 3), ...reeds(-0.25, 0.42, 3, 0.9),
      // the bailiff's hut by the gate, a path, a car park and a fence along the road
      ['box', 0.24, 0.16, 0.18, -0.7, 0.012, 0.72, 0x3f6b4f], ['roof', 0.28, 0.08, 0.22, -0.7, 0.172, 0.72, 'slate'],
      ['box', 0.06, 0.11, 0.01, -0.64, 0.012, 0.812, 'door'], ['box', 0.1, 0.06, 0.012, -0.38, 0.1, 0.9, 'cream'],
      path(0.12, 0.42, -0.4, 0.74), ['box', 0.012, 0.1, 0.012, -0.38, 0.012, 0.906, 'timber'],
      ['box', 0.72, 0.004, 0.28, 0.6, 0.012, 0.82, 'gravel'], ...carRow(0.34, 0.82, 4, 0.18, false, 0.016),
      rail(-0.96, 0.95, -0.48, 0.95, 0.05, 'timber'), rail(-0.32, 0.95, 0.22, 0.95, 0.05, 'timber'),
      ...bench(0.55, 0.5, true, 1), ...bench(-0.86, 0.12, false, -1),
      ...tree(-0.86, -0.84, 1), ...pine(0.15, -0.9, 1.1), ...tree(0.86, -0.82, 0.9), ...tree(-0.88, -0.55, 0.85),
    ] },
    { name: 'long canal-style pond with jetties, weeping willows and a cabin', height: 0.3, ops: [
      lawn(2, 2, 'lawnDark'),
      ['box', 1.76, 0.02, 0.66, 0, 0.008, -0.32, 'stone'], ['box', 1.68, 0.022, 0.58, 0, 0.008, -0.32, 'pond'],
      // jetties off the front bank, a rowing boat, pegs on the far bank, lily pads and reeds at the ends
      ...[-0.6, -0.2, 0.2, 0.6].map((x, i): Op => ['box', 0.08, 0.024, 0.16 + (i % 2) * 0.04, x, 0.012, -0.06 - (i % 2) * 0.02, 'timber']),
      // (the rowing boat is rowed up and down the pond in the client's animation pass, render/leisureRigs.ts)
      ...[-0.5, 0.0, 0.5].map((x): Op => ['box', 0.08, 0.024, 0.08, x, 0.012, -0.62, 'timber']),
      ...[[-0.35, -0.4], [-0.28, -0.46], [0.35, -0.25], [0.12, -0.5]].map(([x, z], i): Op => ['cyl', 0.03 + (i % 2) * 0.01, 0.03 + (i % 2) * 0.01, 0.004, x, 0.03, z, 0x4f8a3a, 8]),
      ...reeds(-0.8, -0.5, 3), ...reeds(0.82, -0.14, 3),
      // willows on the far bank
      ...willow(-0.6, -0.82), ...willow(0.05, -0.83, 1.05), ...willow(0.66, -0.82, 0.95),
      // a towpath, the bailiff's cabin by the gate with a tickets board, benches, lamps and a car park
      path(1.76, 0.1, 0, 0.1), path(0.12, 0.76, -0.3, 0.55),
      ['box', 0.3, 0.17, 0.2, -0.64, 0.012, 0.62, 0x8a6a48], ['roof', 0.34, 0.09, 0.3, -0.64, 0.182, 0.67, 'green'],
      ['box', 0.06, 0.12, 0.01, -0.56, 0.012, 0.722, 'door'], ['box', 0.3, 0.012, 0.08, -0.64, 0.012, 0.76, 'timber'],
      ['box', 0.012, 0.14, 0.012, -0.18, 0.012, 0.86, 'timber'], ['box', 0.12, 0.07, 0.012, -0.18, 0.1, 0.868, 'cream'],
      ...bench(0.0, 0.24, true, 1), ...bench(0.45, 0.24, true, 1), ...lamp(-0.45, 0.2, 0.26), ...lamp(0.25, 0.2, 0.26),
      ['box', 0.06, 0.09, 1.4, -0.93, 0.012, -0.25, 'hedge'], ['box', 0.06, 0.09, 1.4, 0.93, 0.012, -0.25, 'hedge'],
      ['box', 0.78, 0.004, 0.3, 0.55, 0.012, 0.8, 'gravel'], ...carRow(0.26, 0.8, 4, 0.19, false, 0.016, 1),
    ] },
  ],
  natureReserve: [
    { name: 'wetland lake with reed beds, boardwalks, a bird hide on stilts and a green-roofed visitor centre', height: 0.32, ops: [
      lawn(3, 2, 'lawnDark'), ['box', 0.9, 0.014, 0.7, -1.0, 0, 0.6, 'lawn'], ['box', 0.9, 0.014, 0.46, 1.0, 0, 0.48, 'lawn'],
      ...repeat(8, (i): Op => ['cone', 0.026, 0.04, (i < 4 ? -1.0 : 1.0) + ((((i * 37) % 11) / 11) - 0.5) * 0.7, 0.014, (i < 4 ? 0.6 : 0.48) + ((((i * 53) % 7) / 7) - 0.5) * (i < 4 ? 0.5 : 0.3), (['yellow', 'plum', 'white', 'red'] as const)[i % 4], 5]),
      ...lake([[-0.55, -0.35, 0.45], [0.05, -0.45, 0.42], [0.55, -0.3, 0.35], [-1.0, -0.2, 0.3]], 0x8f8a5a, 0x5a8fa8),
      // reed beds in the shallows
      ...[[-1.2, 0.0, 0.12], [0.8, -0.05, 0.1], [-0.25, -0.02, 0.09]].flatMap(([x, z, r]): Op[] => [['cyl', r, r + 0.02, 0.04, x, 0.012, z, 0x9a9a4a, 9], ...reeds(x, z, 2, 1.1, 0.03)]),
      // boardwalk from behind the centre across the water to the hide
      ['box', 0.08, 0.03, 1.25, 0.2, 0.012, -0.175, 'timber'], ['box', 0.43, 0.03, 0.08, 0.025, 0.012, -0.8, 'timber'],
      // the bird hide on stilts at the water's edge, its viewing slot over the lake
      ...[[-0.52, -0.88], [-0.18, -0.88], [-0.52, -0.78], [-0.18, -0.78]].map(([x, z]): Op => ['box', 0.015, 0.07, 0.015, x, 0.012, z, 'timber']),
      ['box', 0.4, 0.1, 0.14, -0.35, 0.082, -0.83, 0x6a4a2e], ['box', 0.34, 0.025, 0.006, -0.35, 0.14, -0.757, 'charcoal'],
      ['roof', 0.44, 0.05, 0.18, -0.35, 0.182, -0.83, 0x5f7a3a],
      // visitor centre at the front middle: timber walls, a planted roof, a glass front and a sign
      ['box', 0.72, 0.2, 0.34, 0, 0.012, 0.62, 0x9a7a52], ['box', 0.78, 0.03, 0.4, 0, 0.212, 0.62, 0x6f9a4a],
      ...[[-0.22, 0.56, 'yellow'], [0.1, 0.7, 'white'], [0.26, 0.52, 'plum']].map(([x, z, c]): Op => ['cone', 0.03, 0.03, x as number, 0.242, z as number, c as Color, 5]),
      ['box', 0.44, 0.15, 0.012, -0.06, 0.012, 0.795, 'glass'], ['box', 0.08, 0.13, 0.014, 0.24, 0.012, 0.797, 'door'],
      ['box', 0.012, 0.11, 0.012, -0.13, 0.012, 0.9, 'timber'], ['box', 0.012, 0.11, 0.012, 0.13, 0.012, 0.9, 'timber'], ['box', 0.3, 0.06, 0.014, 0, 0.07, 0.9, 0x2f5a3c],
      // woods at the back corners, a car park on the right and a bench
      ...tree(1.3, -0.8, 1.1), ...pine(1.05, -0.82, 1.1), ...tree(1.32, -0.3, 1.0), ...tree(-1.3, -0.78, 1.05),
      ['box', 0.6, 0.004, 0.24, 1.1, 0.012, 0.84, 'gravel'], ...carRow(0.9, 0.84, 3, 0.2, false, 0.016, 2), path(0.36, 0.08, 0.56, 0.86),
      ...bench(-0.62, 0.12, true, 1),
    ] },
    { name: 'woodland and meadow with a pond-dipping platform, an observation tower and a turf-roofed centre', height: 0.96, ops: [
      lawn(3, 2), ['box', 0.9, 0.014, 1.5, -1.0, 0, -0.2, 0x4f7a3a], ['box', 0.9, 0.014, 1.5, 1.0, 0, -0.2, 0x8fb860],
      // the wood on the left
      ...tree(-1.3, -0.8, 1.2), ...pine(-1.0, -0.86, 1.2), ...tree(-0.72, -0.62, 1.1), ...pine(-1.26, -0.32, 1.1), ...tree(-0.92, -0.18, 1.15), ...tree(-1.28, 0.24, 1.0),
      // the wildflower meadow on the right, with a bug hotel
      ...repeat(8, (i): Op => ['cone', 0.026, 0.04, 1.0 + ((((i * 37) % 11) / 11) - 0.5) * 0.8, 0.014, -0.2 + ((((i * 53) % 13) / 13) - 0.5) * 1.3, (['yellow', 'plum', 'white', 'red', 'signBlue'] as const)[i % 5], 5]),
      ['box', 0.1, 0.12, 0.06, 1.2, 0.014, 0.3, 0x8a6a48], ['roof', 0.12, 0.04, 0.08, 1.2, 0.134, 0.3, 'timber'],
      // the dipping pond and its railed platform
      ...lake([[0.15, -0.45, 0.32], [0.42, -0.35, 0.22]], 0x8f8a5a), ['box', 0.26, 0.03, 0.14, 0.15, 0.012, -0.12, 'timber'],
      ['box', 0.01, 0.05, 0.14, 0.02, 0.042, -0.12, 'timber'], ['box', 0.01, 0.05, 0.14, 0.28, 0.042, -0.12, 'timber'],
      // the observation tower: legs, a half-way landing, a railed top deck under a pyramid roof, two flights of stairs
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]): Op => ['box', 0.03, 0.83, 0.03, -0.33 + sx * 0.1, 0.012, -0.66 + sz * 0.1, 'timber']),
      ['box', 0.23, 0.02, 0.23, -0.33, 0.35, -0.66, BARK], ['box', 0.27, 0.025, 0.27, -0.33, 0.68, -0.66, BARK],
      ['box', 0.27, 0.06, 0.012, -0.33, 0.705, -0.53, 'timber'], ['box', 0.27, 0.06, 0.012, -0.33, 0.705, -0.79, 'timber'],
      ['box', 0.012, 0.06, 0.27, -0.46, 0.705, -0.66, 'timber'], ['box', 0.012, 0.06, 0.27, -0.2, 0.705, -0.66, 'timber'],
      ['taper', 0.32, 0.32, 0, 0, 0.12, -0.33, 0.842, -0.66, 0x5f7a3a],
      ['taper', 0.06, 0.04, 0.06, 0.04, 0.338, -0.24, 0.012, -0.32, BARK, { shift: [0, -0.21] }],
      ['taper', 0.06, 0.04, 0.06, 0.04, 0.31, -0.41, 0.37, -0.58, BARK, { shift: [0, -0.18] }],
      // the visitor centre: a round timber drum under a turf dome, glazed to the road, and its sign
      ['lathe', 0, 0.012, 0.6, 0x9a7a52, [0.32, 0, 0.32, 0.15], { seg: 14, win: true }],
      ['lathe', 0, 0.162, 0.6, 'lawnDark', [0.34, 0, 0.3, 0.05, 0.18, 0.1, 0, 0.12], { seg: 14 }],
      ['box', 0.3, 0.11, 0.04, 0, 0.012, 0.9, 'glass'], ['box', 0.07, 0.1, 0.044, 0.08, 0.012, 0.9, 'door'],
      ['box', 0.012, 0.1, 0.012, 0.48, 0.012, 0.9, 'timber'], ['box', 0.22, 0.06, 0.014, 0.48, 0.07, 0.9, 0x2f5a3c],
      // mown paths, a car park and a bench by the pond
      path(0.1, 0.62, 0.15, 0.23, 0xa8cf7a, 0.014), path(0.9, 0.1, -0.3, -0.05, 0xa8cf7a, 0.012),
      ['box', 0.62, 0.004, 0.24, 1.1, 0.012, 0.84, 'gravel'], ...carRow(0.9, 0.84, 3, 0.2, false, 0.016, 1),
      ...bench(0.55, -0.02, true, 1),
    ] },
  ],
  lido: [
    { name: 'art-deco lido with a lane pool, a diving stage, changing huts and a curved cream entrance', height: 0.56, ops: [
      slab(2, 2, 0xe6dfd0),
      ['box', 1.44, 0.024, 0.84, 0, 0.02, -0.28, 'white'], ['box', 1.36, 0.026, 0.76, 0, 0.02, -0.28, 0x7fc8e8],
      ...repeat(5, (i): Op => ['box', 1.2, 0.028, 0.008, 0.04, 0.02, -0.28 + (i - 2) * 0.13, 0x2d4a9c]),
      // stepped diving stage at the deep end: a springboard and a high board
      ['box', 0.16, 0.18, 0.28, -0.87, 0.02, -0.3, 'cream'], ['box', 0.12, 0.4, 0.2, -0.87, 0.02, -0.3, 'white'],
      ['box', 0.26, 0.012, 0.06, -0.66, 0.2, -0.38, 0x2f8f9a], ['box', 0.2, 0.02, 0.12, -0.72, 0.4, -0.27, 'white'],
      ['box', 0.12, 0.05, 0.01, -0.87, 0.42, -0.4, 0x2d4a9c],
      // a row of changing huts along the back under one roof
      ...repeat(8, (i): Op => ['box', 0.17, 0.13, 0.14, -0.63 + i * 0.18, 0.02, -0.86, ([0xe8846a, 0xf2e4c9, 0x6fb0d8, 0xf6d36a] as const)[(i * 3) % 4]]),
      ['box', 1.48, 0.02, 0.18, 0, 0.15, -0.86, 0x2d4a9c],
      // the cream entrance with a rounded corner, a teal band, a fin, a lit name and a flag
      ['box', 0.65, 0.3, 0.43, -0.625, 0.02, 0.735, 'cream'], ['cyl', 0.215, 0.215, 0.3, -0.3, 0.02, 0.735, 'cream', 16],
      ['box', 0.66, 0.03, 0.44, -0.625, 0.22, 0.735, 0x2f8f9a], ['cyl', 0.22, 0.22, 0.03, -0.3, 0.22, 0.735, 0x2f8f9a, 16],
      ['box', 0.67, 0.03, 0.45, -0.625, 0.32, 0.735, 'white'], ['cyl', 0.225, 0.225, 0.03, -0.3, 0.32, 0.735, 'white', 16],
      ['box', 0.04, 0.2, 0.2, -0.5, 0.35, 0.74, 'white'], ['box', 0.32, 0.05, 0.02, -0.66, 0.15, 0.955, 0x2f8f9a, 'sign'],
      ['box', 0.2, 0.12, 0.012, -0.66, 0.02, 0.953, 'glass'], ['flag', -0.86, 0.35, 0.6, 0x2f8f9a],
      // sun loungers and parasols on the terrace, the lifeguard's high chair
      ...repeat(6, (i): Op => ['box', 0.06, 0.018, 0.14, 0.05 + i * 0.15, 0.02, 0.38, ([0xe8846a, 'white', 0x6fb0d8] as const)[i % 3]]),
      ...[0.12, 0.42, 0.72].flatMap((x, i): Op[] => [['cyl', 0.006, 0.006, 0.2, x, 0.02, 0.56, 'steel', 4], ['cone', 0.12, 0.06, x, 0.18, 0.56, ([0xe8846a, 0x2f8f9a, 0xf6d36a] as const)[i], 8]]),
      ['box', 0.015, 0.22, 0.015, 0.82, 0.02, -0.36, 'white'], ['box', 0.015, 0.22, 0.015, 0.82, 0.02, -0.24, 'white'],
      ['box', 0.08, 0.015, 0.14, 0.82, 0.24, -0.3, 'white'], ['box', 0.015, 0.08, 0.14, 0.855, 0.255, -0.3, 'red'],
      // a cream wall round the open sides and a tree in the corner
      rail(-0.96, -0.96, 0.96, -0.96, 0.1, 'cream', 0.02, 0.03), rail(0.96, -0.96, 0.96, 0.96, 0.1, 'cream', 0.02, 0.03),
      rail(-0.96, -0.96, -0.96, 0.5, 0.1, 'cream', 0.02, 0.03), rail(-0.08, 0.95, 0.96, 0.95, 0.1, 'cream', 0.02, 0.03),
      ...tree(0.84, 0.82, 0.7, 'hedge', 0.02),
    ] },
    { name: 'lagoon lido with a curved pool, a beach, a flume slide and palm umbrellas', height: 0.56, ops: [
      slab(2, 2, 0xe9dcc0),
      ['cyl', 0.24, 0.26, 0.02, 0.55, 0.008, 0.32, 'sand', 14],
      ...lake([[-0.1, -0.35, 0.5], [0.45, -0.2, 0.38], [-0.55, -0.05, 0.3], [0.2, 0.18, 0.28]], 'white', 0x6fd0e8),
      // the flume: a tower, a cage and a canopy, two chutes on a post into the deep end
      ['box', 0.14, 0.34, 0.14, 0.8, 0.02, -0.75, 'yellow'], ['box', 0.1, 0.1, 0.1, 0.8, 0.36, -0.75, 'white'], ['taper', 0.18, 0.18, 0, 0, 0.1, 0.8, 0.46, -0.75, 'red'],
      rod(0.42, 0.2, -0.75, 0.7, 0.36, -0.75, 0.05, 'boxOrange'), rod(0.3, 0.035, -0.5, 0.42, 0.2, -0.75, 0.05, 'boxOrange'),
      ['box', 0.02, 0.26, 0.02, 0.55, 0.02, -0.75, 'steel'],
      // paddling pool with a mushroom fountain
      ['cyl', 0.17, 0.17, 0.02, 0.62, 0.02, 0.74, 'white', 14], ['cyl', 0.15, 0.15, 0.022, 0.62, 0.02, 0.74, 0x8fdcef, 14],
      ['cyl', 0.015, 0.02, 0.08, 0.62, 0.04, 0.74, 'white', 6], ['cone', 0.07, 0.04, 0.62, 0.12, 0.74, 'boxOrange', 10],
      // the entrance under a turquoise barrel roof, with portholes and a lit sign
      ['box', 0.75, 0.24, 0.4, -0.575, 0.02, 0.75, 'white'],
      ['lathe', -0.95, 0.22, 0.75, 0x3fb8c8, [0.2, 0, 0.2, 0.75], { axis: 'x', seg: 16 }],
      ['box', 0.18, 0.13, 0.012, -0.36, 0.02, 0.953, 'glass'], ['box', 0.3, 0.05, 0.016, -0.36, 0.17, 0.955, 'boxOrange', 'sign'],
      ...[-0.85, -0.74, -0.63].map((x): Op => disc(x, 0.13, 0.95, 0.03, 'signBlue', 0.006, 10)),
      // lifeguard hut on stilts, loungers and palm umbrellas round the water
      ['box', 0.02, 0.16, 0.02, -0.88, 0.02, -0.62, 'white'], ['box', 0.02, 0.16, 0.02, -0.78, 0.02, -0.62, 'white'],
      ['box', 0.14, 0.1, 0.12, -0.83, 0.18, -0.62, 'red'], ['roof', 0.17, 0.05, 0.15, -0.83, 0.28, -0.62, 'white'],
      ...[[-0.86, 0.38], [-0.74, 0.4], [-0.02, 0.66], [0.18, 0.66], [-0.4, -0.88]].map(([x, z], i): Op => ['box', 0.06, 0.018, 0.14, x, 0.02, z, ([0xf6d36a, 0x3fb8c8, 'white'] as const)[i % 3]]),
      ...[[-0.8, 0.3], [0.08, 0.56], [-0.6, -0.86], [0.86, 0.1]].flatMap(([x, z], i): Op[] => [
        ['cyl', 0.008, 0.01, 0.2, x, 0.02, z, 'timber', 5], ['cone', 0.11, 0.05, x, 0.18, z, i % 2 ? 0x4f9a3a : 0xc8a060, 7],
      ]),
      // a low wall and two palms at the back corners
      rail(-0.96, -0.96, 0.96, -0.96, 0.08, 'white', 0.02, 0.03), rail(0.96, -0.96, 0.96, 0.96, 0.08, 'white', 0.02, 0.03),
      ...[[-0.84, -0.84], [0.84, 0.46]].flatMap(([x, z]): Op[] => [['taper', 0.035, 0.035, 0.02, 0.02, 0.36, x, 0.02, z, 0x8a6a48], ['cone', 0.13, 0.05, x, 0.37, z, 0x3f8a3a, 7]]),
    ] },
  ],
  tennisClub: [
    { name: 'two floodlit hard courts behind tall fences and a clubhouse with a veranda', height: 0.58, ops: [
      lawn(2, 1), ['box', 1.41, 0.006, 0.92, 0.255, 0.012, 0, 0x4f8a5a],
      // two blue courts, their lines and nets
      ...[-0.1, 0.61].flatMap((x): Op[] => [
        ['box', 0.44, 0.004, 0.86, x, 0.018, 0, 0x3f7fb0], ...courtLines(x, 0, 0.78, 0.36, false, 0.022),
        ['box', 0.44, 0.04, 0.006, x, 0.022, 0, 0x2b2e36], ['box', 0.44, 0.006, 0.008, x, 0.062, 0, 'white'],
      ]),
      // tall fences at the back and sides, a top rail, a kick board and a post at the front so the courts show
      rail(-0.45, -0.46, 0.96, -0.46, 0.22, 0x2f5a44, 0.012, 0.008), rail(-0.45, -0.46, -0.45, 0.46, 0.22, 0x2f5a44, 0.012, 0.008), rail(0.96, -0.46, 0.96, 0.46, 0.22, 0x2f5a44, 0.012, 0.008),
      ['box', 1.41, 0.012, 0.008, 0.255, 0.22, 0.46, 0x2f5a44], ['box', 1.41, 0.04, 0.008, 0.255, 0.012, 0.46, 0x2f5a44], ['box', 0.012, 0.22, 0.012, 0.255, 0.012, 0.46, 0x2f5a44],
      ...floodlight(-0.1, -0.44, 0.48), ...floodlight(0.61, -0.44, 0.48), ...floodlight(-0.1, 0.44, 0.48), ...floodlight(0.61, 0.44, 0.48),
      // the clubhouse: weatherboard walls, a roof carried over the veranda on posts, a door and a bench
      ['box', 0.42, 0.2, 0.34, -0.74, 0.012, -0.1, 'white'], ['roof', 0.46, 0.1, 0.5, -0.74, 0.212, -0.05, 0x3f6b4f],
      ['box', 0.42, 0.02, 0.13, -0.74, 0.012, 0.135, 'timber'],
      ['box', 0.015, 0.18, 0.015, -0.93, 0.032, 0.19, 'white'], ['box', 0.015, 0.18, 0.015, -0.55, 0.032, 0.19, 'white'],
      ['box', 0.06, 0.12, 0.01, -0.68, 0.032, 0.075, 'door'], ...bench(-0.84, 0.13, true, -1, 'white', 0.032),
      path(0.12, 0.27, -0.74, 0.335), ['flag', -0.55, 0.012, 0.36, 0x5fa04f], ...tree(-0.9, 0.36, 0.7),
    ] },
    { name: 'striped grass courts and a white pavilion with a clock and a cupola', height: 0.52, ops: [
      lawn(2, 1, 'lawnDark'),
      ...repeat(6, (i): Op => ['box', 0.197, 0.004, 0.9, -0.12 + i * 0.197, 0.012, 0, i % 2 ? 0x7fb865 : 'lawn']),
      ...[-0.22, 0.22].flatMap((z): Op[] => [
        ...courtLines(0.37, z, 0.8, 0.36, true, 0.016),
        ['box', 0.006, 0.04, 0.4, 0.37, 0.016, z, 0x2b2e36], ['box', 0.008, 0.006, 0.4, 0.37, 0.056, z, 'white'],
      ]),
      // a green windbreak at the back and a low white rail at the sides
      rail(-0.22, -0.46, 0.96, -0.46, 0.12, 0x2f5a44), rail(0.96, -0.46, 0.96, 0.46, 0.04, 'white'), rail(-0.22, 0.46, 0.96, 0.46, 0.04, 'white'),
      // umpire's chair between the courts and the heavy roller
      ['box', 0.012, 0.14, 0.012, 0.37, 0.016, -0.02, 'white'], ['box', 0.012, 0.14, 0.012, 0.37, 0.016, 0.02, 'white'], ['box', 0.05, 0.03, 0.05, 0.37, 0.156, 0, 0x3f6b4f],
      ['wheel', 0.03, 0.1, -0.15, 0.042, 0.38, 0x3f6b4f], rod(-0.15, 0.04, 0.38, -0.15, 0.1, 0.24, 0.008, 'charcoal'),
      // the pavilion: gable to the road with a clock, a cupola on the ridge, a veranda with a lean-to roof
      ['box', 0.62, 0.2, 0.42, -0.63, 0.012, -0.09, 'white'], ['roof', 0.68, 0.16, 0.48, -0.63, 0.212, -0.09, 0x3f6b4f, true],
      disc(-0.63, 0.29, 0.15, 0.045, 'white', 0.008, 14), ['box', 0.006, 0.035, 0.006, -0.63, 0.29, 0.16, 'charcoal'], ['box', 0.025, 0.006, 0.006, -0.62, 0.29, 0.16, 'charcoal'],
      ['box', 0.08, 0.08, 0.08, -0.63, 0.34, -0.12, 'white'], ['taper', 0.1, 0.1, 0, 0, 0.1, -0.63, 0.42, -0.12, 0x2f8f9a],
      ['box', 0.62, 0.02, 0.14, -0.63, 0.012, 0.19, 'timber'],
      ...[-0.92, -0.63, -0.34].map((x): Op => ['box', 0.015, 0.16, 0.015, x, 0.032, 0.25, 'white']),
      ['box', 0.66, 0.015, 0.16, -0.63, 0.192, 0.2, 0x3f6b4f], ['box', 0.3, 0.13, 0.012, -0.63, 0.032, 0.126, 'glass'],
      ...[-0.9, -0.36].flatMap((x): Op[] => [['cyl', 0.03, 0.025, 0.04, x, 0.012, 0.34, 'stone', 8], ['cone', 0.035, 0.05, x, 0.052, 0.34, 'red', 6]]),
      path(0.12, 0.2, -0.63, 0.37), ...bench(-0.1, 0.4, true, 1, 'white'),
    ] },
  ],
  bowlingAlley: [
    { name: 'neon-banded bowling box with a giant pin and ball on the roof, a glazed entrance and a car park', height: 0.82, ops: [
      slab(2, 1, ASPHALT),
      ['box', 1.9, 0.46, 0.58, 0, 0.02, -0.17, 0x2b2e4a], ['box', 1.92, 0.03, 0.6, 0, 0.48, -0.17, 'charcoal'],
      ['box', 1.91, 0.025, 0.59, 0, 0.38, -0.17, 0xff4fa0, 'sign'], ['box', 1.91, 0.025, 0.59, 0, 0.42, -0.17, 0x3fb8ff, 'sign'],
      // the name board over a glazed entrance with a pink canopy
      ['box', 0.7, 0.11, 0.03, -0.5, 0.24, 0.135, 'charcoal'], ['box', 0.6, 0.05, 0.034, -0.52, 0.27, 0.135, 'marquee', 'sign'],
      ['lathe', -0.2, 0.25, 0.14, 'white', [0.012, 0, 0.018, 0.03, 0.009, 0.06, 0.012, 0.075, 0, 0.085], { seg: 8, win: 'sign' }],
      ['box', 0.5, 0.18, 0.12, -0.65, 0.02, 0.18, 'glass', 'venue'], ['box', 0.56, 0.02, 0.16, -0.65, 0.2, 0.2, 0xff4fa0],
      // a giant pin with red neck stripes and a purple ball on the roof
      ['lathe', 0.45, 0.51, -0.06, 'white', [0.045, 0, 0.065, 0.05, 0.07, 0.09, 0.055, 0.14, 0.032, 0.18, 0.03, 0.205, 0.042, 0.24, 0.038, 0.27, 0.02, 0.29, 0, 0.3], { seg: 12 }],
      ['cyl', 0.035, 0.036, 0.012, 0.45, 0.674, -0.06, 'red', 12], ['cyl', 0.033, 0.034, 0.012, 0.45, 0.694, -0.06, 'red', 12],
      ['lathe', 0.64, 0.51, -0.04, 0x7a2fd0, [0.03, 0, 0.065, 0.025, 0.08, 0.08, 0.065, 0.135, 0, 0.16], { seg: 12 }],
      disc(0.62, 0.62, 0.036, 0.012, 'charcoal', 0.006, 6), disc(0.66, 0.62, 0.036, 0.012, 'charcoal', 0.006, 6),
      ['box', 0.14, 0.06, 0.1, -0.5, 0.51, -0.3, 'plant'], ['box', 0.1, 0.05, 0.1, -0.2, 0.51, -0.32, 'plant'],
      // the car park strip
      ...bayLines(-0.3, 0.33, 6, 0.2, 0.26), ...carRow(-0.2, 0.33, 6, 0.2, false, 0.02, 2),
    ] },
    { name: 'sixties googie bowl with a swooping roof on V struts and a starburst sign', height: 0.84, ops: [
      slab(2, 1, PAVING), ['box', 1.4, 0.004, 0.16, -0.25, 0.02, 0.39, ASPHALT], ['box', 0.44, 0.004, 0.62, 0.72, 0.02, -0.16, ASPHALT],
      // the hall with a glass wall to the road under an upswept roof
      ['box', 1.4, 0.26, 0.52, -0.25, 0.02, -0.2, 0xe8e0cc], ['box', 1.32, 0.22, 0.02, -0.25, 0.02, 0.07, 'glass', 'venue'],
      ['taper', 1.44, 0.56, 1.44, 0.78, 0.1, -0.24, 0.28, -0.2, 'white', { shift: [0, 0.11] }], ['box', 1.44, 0.02, 0.03, -0.24, 0.36, 0.285, 0x3fb8c8],
      ...[-0.8, 0.2].flatMap((x): Op[] => [rod(x, 0.02, 0.22, x - 0.1, 0.34, 0.22, 0.02, 0x3fb8c8), rod(x, 0.02, 0.22, x + 0.1, 0.34, 0.22, 0.02, 0x3fb8c8)]),
      // the pylon: a boomerang board with a lit name and a pin, a starburst on top
      ['box', 0.05, 0.62, 0.05, 0.75, 0.02, 0.25, 'white'], ['box', 0.1, 0.06, 0.1, 0.75, 0.02, 0.25, 0x3fb8c8],
      ['taper', 0.36, 0.03, 0.26, 0.03, 0.12, 0.72, 0.3, 0.28, 0xd94f4f, { shift: [0.06, 0] }], ['box', 0.22, 0.04, 0.034, 0.74, 0.34, 0.28, 'marquee', 'sign'],
      ['lathe', 0.75, 0.7, 0.24, 0xffd84a, [0, 0, 0.13, 0.008, 0, 0.016], { axis: 'z', seg: 4, win: 'sign' }],
      ['lathe', 0.75, 0.7, 0.244, 0xff8a3a, [0, 0, 0.09, 0.008, 0, 0.016], { axis: 'z', seg: 4, twist: 5625, win: 'sign' }],
      disc(0.75, 0.7, 0.256, 0.03, 'white', 0.008, 10),
      // cars along the front and down the right
      ...carRow(-0.8, 0.39, 5, 0.25, true, 0.024, 1), ...car(0.72, -0.36, 'red', true, 0.024), ...car(0.72, -0.16, 0x2f8f9a, true, 0.024),
      ['cone', 0.04, 0.12, -0.9, 0.02, 0.24, 'green', 5], ['lathe', -0.2, 0.02, 0.24, 'white', [0.006, 0, 0.006, 0.2, 0.03, 0.22, 0.03, 0.25, 0, 0.27], { seg: 8, win: 'sign' }],
    ] },
  ],
  iceRink: [
    { name: 'barrel-roofed rink hall with a glazed arched front, a big snowflake and an outdoor practice rink', height: 0.66, ops: [
      slab(2, 2, PAVING),
      // the hall and its shallow barrel vault (three facets of an arc), the arched end glazed to the road
      ['box', 1.8, 0.34, 1.12, 0, 0.02, -0.36, 0xdfe9f0, true],
      ['taper', 1.8, 1.12, 1.3, 1.12, 0.15, 0, 0.36, -0.36, 0xc9d3dc], ['taper', 1.3, 1.12, 0.7, 1.12, 0.107, 0, 0.51, -0.36, 0xc9d3dc],
      ['taper', 0.7, 1.12, 0, 1.12, 0.041, 0, 0.617, -0.36, 0xc9d3dc],
      ['taper', 1.74, 0.02, 1.26, 0.02, 0.15, 0, 0.36, 0.21, 'glass', { win: 'venue' }], ['taper', 1.26, 0.02, 0.68, 0.02, 0.107, 0, 0.51, 0.21, 'glass', { win: 'venue' }],
      ['taper', 0.68, 0.02, 0, 0.02, 0.04, 0, 0.617, 0.21, 'glass'],
      ['box', 1.8, 0.3, 0.02, 0, 0.02, 0.21, 'glass', 'venue'], ['box', 1.82, 0.03, 1.14, 0, 0.34, -0.36, 0x2f6fb5],
      // a snowflake on a disc in the arch
      disc(0, 0.5, 0.22, 0.12, 'white', 0.008, 18),
      ['box', 0.016, 0.18, 0.006, 0, 0.41, 0.232, 0x2f6fb5, 'sign'],
      ['taper', 0.022, 0.006, 0.022, 0.006, 0.09, -0.078, 0.455, 0.232, 0x2f6fb5, { shift: [0.156, 0], win: 'sign' }],
      ['taper', 0.022, 0.006, 0.022, 0.006, 0.09, 0.078, 0.455, 0.232, 0x2f6fb5, { shift: [-0.156, 0], win: 'sign' }],
      // the entrance canopy at the front left and a lit name over it
      ['box', 0.5, 0.02, 0.22, -0.55, 0.22, 0.32, 0x2f6fb5], ['box', 0.015, 0.2, 0.015, -0.78, 0.02, 0.42, 'white'], ['box', 0.015, 0.2, 0.015, -0.32, 0.02, 0.42, 'white'],
      ['box', 0.4, 0.05, 0.02, -0.55, 0.245, 0.42, 'white', 'sign'],
      // an outdoor practice rink under a flat canopy: ice, hockey lines, boards, posts and roof
      ['box', 0.8, 0.008, 0.5, 0.48, 0.02, 0.65, 0xeaf6fb],
      ['box', 0.008, 0.01, 0.5, 0.48, 0.02, 0.65, 'red'], ['box', 0.008, 0.01, 0.5, 0.33, 0.02, 0.65, 'signBlue'], ['box', 0.008, 0.01, 0.5, 0.63, 0.02, 0.65, 'signBlue'],
      ['box', 0.82, 0.04, 0.012, 0.48, 0.02, 0.394, 'white'], ['box', 0.82, 0.04, 0.012, 0.48, 0.02, 0.906, 'white'],
      ['box', 0.012, 0.04, 0.5, 0.074, 0.02, 0.65, 'white'], ['box', 0.012, 0.04, 0.5, 0.886, 0.02, 0.65, 'white'],
      ...[[0.08, 0.4], [0.88, 0.4], [0.08, 0.9], [0.88, 0.9]].map(([x, z]): Op => ['box', 0.02, 0.36, 0.02, x, 0.02, z, 'steel']),
      ['box', 0.86, 0.02, 0.56, 0.48, 0.38, 0.65, 0xe8eef2],
      ...tree(-0.86, 0.86, 0.75, 'hedge', 0.02), ...tree(-0.15, 0.86, 0.7, 'green', 0.02), ...bench(-0.4, 0.86, true, 1, 'charcoal', 0.02),
    ] },
    { name: 'open-air rink under a tensile canopy, with a café chalet, string lights and fir trees', height: 0.66, ops: [
      slab(2, 2, PAVING),
      ['box', 1.2, 0.01, 0.8, 0.15, 0.02, -0.3, 0xeaf6fb],
      ['box', 1.24, 0.05, 0.02, 0.15, 0.02, -0.71, 'white'], ['box', 1.24, 0.05, 0.02, 0.15, 0.02, 0.11, 'white'],
      ['box', 0.02, 0.05, 0.8, -0.46, 0.02, -0.3, 'white'], ['box', 0.02, 0.05, 0.8, 0.76, 0.02, -0.3, 'white'],
      // the canopy: corner masts, two pointed sails, flying masts through the peaks
      ...[[-0.52, -0.77], [0.82, -0.77], [-0.52, 0.17], [0.82, 0.17]].map(([x, z]): Op => ['cyl', 0.015, 0.018, 0.42, x, 0.02, z, 'steel', 6]),
      ['taper', 0.67, 0.94, 0, 0, 0.16, -0.185, 0.42, -0.3, 'white'], ['taper', 0.67, 0.94, 0, 0, 0.16, 0.485, 0.42, -0.3, 0xf2f4f6],
      ['cyl', 0.008, 0.01, 0.22, -0.185, 0.44, -0.3, 'steel', 5], ['cyl', 0.008, 0.01, 0.22, 0.485, 0.44, -0.3, 'steel', 5],
      // string lights between the masts
      ['box', 1.34, 0.008, 0.008, 0.15, 0.36, 0.17, 'marquee', 'sign'], ['box', 1.34, 0.008, 0.008, 0.15, 0.36, -0.77, 'marquee', 'sign'],
      ['box', 0.008, 0.008, 0.94, -0.52, 0.36, -0.3, 'marquee', 'sign'], ['box', 0.008, 0.008, 0.94, 0.82, 0.36, -0.3, 'marquee', 'sign'],
      // the café chalet with a snowy roof, a terrace and tables, and the skate hire hut
      ['box', 0.4, 0.18, 0.26, -0.6, 0.02, 0.6, 0x8a5a32], ['roof', 0.46, 0.18, 0.32, -0.6, 0.2, 0.6, 'white'],
      ['box', 0.2, 0.04, 0.012, -0.6, 0.15, 0.735, 'boxOrange', 'sign'], ['box', 0.4, 0.015, 0.17, -0.6, 0.02, 0.815, 'timber'],
      ['cyl', 0.03, 0.01, 0.06, -0.7, 0.035, 0.83, 'white', 8], ['cyl', 0.03, 0.01, 0.06, -0.5, 0.035, 0.83, 'white', 8],
      ['box', 0.2, 0.14, 0.16, 0.62, 0.02, 0.55, 'red', true], ['roof', 0.24, 0.06, 0.2, 0.62, 0.16, 0.55, 'white'],
      ['lathe', -0.37, 0.25, 0.73, 'marquee', [0.004, 0, 0.004, 0.5], { axis: 'x', seg: 4, win: 'sign' }],
      ['cyl', 0.008, 0.01, 0.25, 0.13, 0.02, 0.73, 'charcoal', 5],
      // fir trees, a big one with a star, and benches facing the ice
      ...pine(-0.85, -0.86, 1.2), ...pine(0.9, -0.88, 1.1), ...pine(0.9, 0.3, 1.2), ...pine(-0.86, 0.2, 1.1),
      ...pine(0.25, 0.58, 1.6), ['box', 0.03, 0.03, 0.03, 0.25, 0.46, 0.58, 'yellow', 'sign'],
      ...bench(-0.1, 0.25, true, 1, 'timber', 0.02), ...bench(0.42, 0.25, true, 1, 'timber', 0.02),
    ] },
  ],
  rollerDisco: [
    { name: 'round-fronted roller disco with pink and purple neon, a mirror ball and a skate sign', height: 0.68, ops: [
      slab(1, 1, PAVING),
      // a box hall with a drum front, white caps and two neon bands round both
      ['box', 0.72, 0.42, 0.56, 0, 0.02, -0.18, 0x3a2a4a], ['cyl', 0.36, 0.36, 0.42, 0, 0.02, 0.08, 0x3a2a4a, 20],
      ['box', 0.74, 0.03, 0.58, 0, 0.44, -0.18, 'white'], ['cyl', 0.37, 0.37, 0.03, 0, 0.44, 0.08, 'white', 20],
      ['box', 0.73, 0.025, 0.57, 0, 0.3, -0.18, 0xff4fb0, 'sign'], ['cyl', 0.365, 0.365, 0.025, 0, 0.3, 0.08, 0xff4fb0, 20],
      ['box', 0.73, 0.025, 0.57, 0, 0.36, -0.18, 0x9a4fff, 'sign'], ['cyl', 0.365, 0.365, 0.025, 0, 0.36, 0.08, 0x9a4fff, 20],
      // glass doors under a white canopy, glowing portholes either side
      ['box', 0.22, 0.2, 0.04, 0, 0.02, 0.43, 'glass', 'venue'], ['box', 0.3, 0.02, 0.08, 0, 0.23, 0.45, 'white'],
      disc(-0.22, 0.16, 0.36, 0.045, 0xff4fb0, 0.01, 12), disc(0.22, 0.16, 0.36, 0.045, 0xff4fb0, 0.01, 12),
      // a mirror ball on a short pole and a roller skate on the roof's front edge
      ['cyl', 0.008, 0.008, 0.08, 0, 0.47, 0.14, 'steel', 5],
      ['lathe', 0, 0.55, 0.14, 'silver', [0.02, 0, 0.055, 0.02, 0.07, 0.06, 0.055, 0.1, 0.02, 0.12, 0, 0.122], { seg: 10, stripe: 0x9fd0ff, every: 2, width: 1, win: 'sign' }],
      disc(-0.045, 0.495, 0.35, 0.022, 'yellow', 0.02, 10), disc(0.055, 0.495, 0.35, 0.022, 'yellow', 0.02, 10),
      ['box', 0.15, 0.035, 0.03, 0.005, 0.51, 0.36, 'white', 'sign'], ['box', 0.07, 0.09, 0.03, -0.035, 0.545, 0.36, 'white', 'sign'],
      // queue posts and planters
      ['cyl', 0.008, 0.008, 0.06, 0.2, 0.02, 0.46, 'gold', 5], ['cyl', 0.008, 0.008, 0.07, 0.34, 0.02, 0.32, 'gold', 5], rod(0.2, 0.065, 0.46, 0.34, 0.075, 0.32, 0.006, 0xd94f4f),
      ['cyl', 0.05, 0.04, 0.05, -0.38, 0.02, 0.4, 'charcoal', 8], ['cone', 0.045, 0.12, -0.38, 0.07, 0.4, 'green', 6],
      ['box', 0.16, 0.05, 0.1, 0.18, 0.47, -0.3, 'plant'],
    ] },
    { name: 'converted brick warehouse with a rainbow mural band and a big skate-wheel sign', height: 0.66, ops: [
      slab(1, 1, 0xbdb5a6),
      ['box', 0.84, 0.4, 0.74, 0, 0.02, -0.08, 'brick'], ['roof', 0.88, 0.2, 0.78, 0, 0.42, -0.08, 'slate', true],
      ...[-0.3, -0.08, 0.14].map((z): Op => ['box', 0.012, 0.13, 0.12, -0.424, 0.25, z, 'glassDark']),
      // the rainbow band painted all round
      ...repeat(6, (i): Op => ['box', 0.85, 0.025, 0.75, 0, 0.08 + i * 0.025, -0.08, ([0xe0403a, 0xf08a2e, 0xf2cf3a, 0x4fb04f, 0x3a7fd0, 0x8a4fc0] as const)[i]]),
      // a skate wheel on the gable, the old loading door glazed, a steel canopy on ties and a neon name
      disc(0, 0.5, 0.31, 0.075, 'yellow', 0.02, 16), disc(0, 0.5, 0.33, 0.032, 'white', 0.006, 12), disc(0, 0.5, 0.336, 0.012, 'charcoal', 0.004, 8),
      ['box', 0.3, 0.22, 0.02, 0, 0.02, 0.3, 'glass'],
      ['box', 0.4, 0.02, 0.12, 0, 0.26, 0.35, 'charcoal'], rod(-0.18, 0.28, 0.4, -0.18, 0.37, 0.29, 0.006, 'charcoal'), rod(0.18, 0.28, 0.4, 0.18, 0.37, 0.29, 0.006, 'charcoal'),
      ['box', 0.5, 0.05, 0.02, 0, 0.32, 0.3, 0xff4fb0, 'sign'],
      // a fire escape down the right wall
      ['box', 0.06, 0.012, 0.14, 0.45, 0.26, -0.2, 'charcoal'], ['box', 0.06, 0.06, 0.006, 0.45, 0.272, -0.27, 'charcoal'],
      ['taper', 0.05, 0.04, 0.05, 0.04, 0.24, 0.45, 0.02, 0.12, 'charcoal', { shift: [0, -0.25] }],
      ['chimneyStack', -0.25, 0.42, -0.36, 0.16, 0.03, 'brick'],
      // bollards and planters by the door
      ...[-0.3, 0.3].flatMap((x): Op[] => [['box', 0.1, 0.05, 0.1, x, 0.02, 0.4, 'charcoal'], ['cone', 0.045, 0.1, x, 0.07, 0.4, 'hedge', 6]]),
      ...[-0.12, 0.0, 0.12].map((x): Op => ['cyl', 0.012, 0.012, 0.05, x, 0.02, 0.45, 'yellow', 6]),
    ] },
  ],
  climbingCentre: [
    { name: 'tall climbing hall with an overhanging wall of coloured holds outside and a big glass front', height: 1.14, ops: [
      slab(1, 1, PAVING),
      ['box', 0.88, 1.0, 0.62, 0, 0.02, -0.15, 0x5a6370], ['box', 0.9, 0.04, 0.64, 0, 1.02, -0.15, 0xe06a2e],
      ['box', 0.46, 0.08, 0.03, -0.12, 1.06, -0.02, 0xe06a2e, 'sign'], ['box', 0.38, 0.03, 0.034, -0.12, 1.085, -0.02, 'white', 'sign'],
      ['box', 0.4, 0.8, 0.02, -0.21, 0.02, 0.17, 'glass', 'venue'],
      ['box', 0.42, 0.06, 0.03, -0.21, 0.84, 0.175, 0xe06a2e, 'sign'],
      // the outdoor wall: a plywood face leaning out over the street side, holds and two volumes, a crash mat below
      ['taper', 0.4, 0.04, 0.4, 0.04, 0.85, 0.22, 0.02, 0.18, 0xd9cbb0, { shift: [0, 0.2] }],
      ...repeat(14, (i): Op => {
        const y = 0.08 + (((i * 53) % 13) / 13) * 0.74, x = 0.05 + (((i * 37) % 11) / 11) * 0.34;
        return ['box', 0.026, 0.02, 0.02, x, y, 0.2 + (0.2 * (y - 0.02)) / 0.85 + 0.008, (['red', 'yellow', 'boxBlue', 'boxGreen', 'plum', 'boxOrange', 'white'] as const)[i % 7]];
      }),
      ['taper', 0.09, 0.04, 0, 0.04, 0.08, 0.12, 0.5, 0.33, 'boxGreen'], ['taper', 0.1, 0.04, 0.1, 0, 0.07, 0.32, 0.3, 0.29, 'boxBlue'],
      ['box', 0.42, 0.03, 0.26, 0.22, 0.02, 0.33, 0x2f6fb5],
      // a bouldering rock by the door, a bike rack
      ['taper', 0.2, 0.16, 0.08, 0.06, 0.12, -0.3, 0.02, 0.36, 0x9a968e, { shift: [0.03, -0.02] }],
      ['box', 0.02, 0.02, 0.02, -0.34, 0.08, 0.413, 'red'], ['box', 0.02, 0.02, 0.02, -0.27, 0.11, 0.395, 'yellow'], ['box', 0.02, 0.02, 0.02, -0.38, 0.05, 0.425, 'boxBlue'],
      ['box', 0.2, 0.05, 0.012, -0.05, 0.02, 0.42, 'steel'], ['box', 0.008, 0.05, 0.06, -0.12, 0.02, 0.42, 'steel'],
    ] },
    { name: 'chapel conversion with a tall gable and rose window, and a climbing tower out back', height: 1.12, ops: [
      slab(1, 1, 0xc9c2b4),
      // the chapel: stone walls, a steep slate roof gable to the road, a rose window, lancets, a porch and a bellcote
      ['box', 0.5, 0.46, 0.64, -0.14, 0.02, 0.0, 'stone'], ['roof', 0.56, 0.32, 0.7, -0.14, 0.48, 0.0, 'slate', true],
      disc(-0.14, 0.6, 0.35, 0.065, 'glass', 0.008, 14), disc(-0.14, 0.6, 0.358, 0.02, 'gold', 0.004, 8),
      ['box', 0.05, 0.24, 0.012, -0.3, 0.14, 0.325, 'glass'], ['box', 0.05, 0.24, 0.012, 0.02, 0.14, 0.325, 'glass'],
      ['box', 0.18, 0.18, 0.1, -0.14, 0.02, 0.37, 'stone'], ['roof', 0.22, 0.08, 0.12, -0.14, 0.2, 0.37, 'slate', true], ['box', 0.08, 0.13, 0.012, -0.14, 0.02, 0.422, 'door'],
      ['box', 0.06, 0.08, 0.06, -0.14, 0.74, 0.3, 'stone'], ['taper', 0.08, 0.08, 0, 0, 0.08, -0.14, 0.82, 0.3, 'slate'],
      // the climbing tower behind, joined by a glass link: a plywood shaft, an overhanging top, holds, ropes and a railed top
      ['box', 0.12, 0.26, 0.2, 0.13, 0.02, -0.22, 'glass'],
      ['box', 0.3, 0.8, 0.3, 0.3, 0.02, -0.25, 0xd9cbb0], ['taper', 0.3, 0.3, 0.3, 0.3, 0.25, 0.3, 0.82, -0.25, 0xe06a2e, { shift: [0, 0.08] }],
      ...[0.18, 0.42].map((x): Op => ['box', 0.03, 0.8, 0.03, x, 0.02, -0.1, 'charcoal']),
      ...repeat(12, (i): Op => {
        const y = 0.08 + (((i * 53) % 13) / 13) * 0.68, x = 0.2 + (((i * 37) % 11) / 11) * 0.2;
        return ['box', 0.024, 0.02, 0.016, x, y, -0.094, (['red', 'yellow', 'boxBlue', 'boxGreen', 'plum', 'white'] as const)[i % 6]];
      }),
      ['box', 0.004, 0.8, 0.004, 0.25, 0.02, -0.09, 'white'], ['box', 0.004, 0.8, 0.004, 0.35, 0.02, -0.09, 'yellow'],
      ['box', 0.32, 0.05, 0.32, 0.3, 1.07, -0.17, 'charcoal'],
      // a sign by the path and a tree
      ['box', 0.012, 0.14, 0.012, 0.26, 0.02, 0.4, 'charcoal'], ['box', 0.16, 0.08, 0.014, 0.26, 0.1, 0.41, 0xe06a2e, 'sign'],
      ...tree(0.36, 0.18, 0.75, 'hedge', 0.02),
    ] },
  ],
  trampolinePark: [
    { name: 'warehouse with bright panels, a trampoline graphic band, a glazed entrance and a car park', height: 0.6, ops: [
      slab(2, 1, ASPHALT),
      ['box', 1.9, 0.48, 0.64, 0, 0.02, -0.14, 0xd8dce2], ['roof', 1.94, 0.08, 0.68, 0, 0.5, -0.14, 'corrugated'],
      // bright panels along the top of the front, a white band of trampolines with a bouncing ball over each
      ...repeat(6, (i): Op => ['box', 0.3, 0.13, 0.012, -0.79 + i * 0.316, 0.345, 0.186, (['boxGreen', 'yellow', 'boxBlue', 0xff6fa0, 'boxOrange', 0x2fbf8f] as const)[i]]),
      ['box', 1.9, 0.1, 0.014, 0, 0.225, 0.187, 'white'],
      ...[-0.6, -0.2, 0.2, 0.6].flatMap((x, i): Op[] => [
        ['box', 0.2, 0.035, 0.004, x, 0.24, 0.196, 'yellow'], ['box', 0.16, 0.02, 0.006, x, 0.247, 0.197, 0x2d3a6a],
        disc(x + (i % 2 ? 0.03 : -0.03), 0.3, 0.194, 0.016, (['red', 'boxBlue', 'boxGreen', 'plum'] as const)[i], 0.006, 8),
      ]),
      // the glazed entrance at the front left under a green canopy, a lit name on the wall top
      ['box', 0.44, 0.18, 0.08, -0.68, 0.02, 0.22, 'glass', 'venue'], ['box', 0.5, 0.02, 0.14, -0.68, 0.2, 0.25, 0x2fbf8f],
      ['box', 0.6, 0.1, 0.03, 0.3, 0.5, 0.15, 0x2fbf8f, 'sign'], ['box', 0.5, 0.04, 0.034, 0.3, 0.53, 0.15, 'white', 'sign'],
      // the car park
      ...bayLines(-0.36, 0.34, 6, 0.21, 0.24), ...carRow(-0.255, 0.34, 6, 0.21, false, 0.02, 4),
    ] },
    { name: 'curved-roof hangar with a striped bouncy-castle entrance arch', height: 0.7, ops: [
      slab(2, 1, PAVING),
      // the hangar: walls and a half-round vault with white ribs
      ['box', 1.84, 0.34, 0.66, 0, 0.02, -0.13, 0xdfe3e8],
      ['lathe', -0.92, 0.36, -0.13, 0xb8c4cc, [0.33, 0, 0.33, 1.84], { axis: 'x', seg: 20 }],
      ...[-0.55, -0.15, 0.25, 0.65].map((x): Op => ['lathe', x, 0.36, -0.13, 'white', [0.336, 0, 0.336, 0.02], { axis: 'x', seg: 20 }]),
      // the inflatable arch: striped pillars with turret tops, a striped bolster, merlons, glass doors behind
      ['lathe', -0.82, 0.02, 0.3, 'red', [0.06, 0, 0.06, 0.4], { seg: 12, stripe: 'yellow', every: 2, width: 1 }],
      ['lathe', -0.42, 0.02, 0.3, 'red', [0.06, 0, 0.06, 0.4], { seg: 12, stripe: 'yellow', every: 2, width: 1 }],
      ['cone', 0.075, 0.1, -0.82, 0.42, 0.3, 'boxBlue', 10], ['cone', 0.075, 0.1, -0.42, 0.42, 0.3, 'boxBlue', 10],
      ['lathe', -0.82, 0.37, 0.3, 'boxGreen', [0.05, 0, 0.05, 0.4], { axis: 'x', seg: 10, stripe: 'yellow', every: 2, width: 1 }],
      ...[-0.68, -0.62, -0.56].map((x, i): Op => ['box', 0.035, 0.04, 0.04, x, 0.41, 0.3, i % 2 ? 'yellow' : 'red']),
      ['box', 0.36, 0.26, 0.02, -0.62, 0.02, 0.205, 'glass'],
      // a lit name, big bouncing-ball dots on the wall, cars and planters
      ['box', 0.6, 0.08, 0.03, 0.3, 0.25, 0.215, 0x2fbf8f, 'sign'],
      ...[[-0.2, 0.12, 'boxOrange'], [0.0, 0.08, 'boxBlue'], [0.55, 0.1, 0xff6fa0], [0.8, 0.14, 'yellow']].map(([x, y, c]): Op => disc(x as number, y as number, 0.2, 0.04, c as Color, 0.008, 12)),
      ...bayLines(-0.3, 0.37, 5, 0.24, 0.2), ...carRow(-0.18, 0.37, 5, 0.24, false, 0.02, 1),
      ['cyl', 0.05, 0.04, 0.05, -0.9, 0.02, 0.42, 'charcoal', 8], ['cone', 0.045, 0.12, -0.9, 0.07, 0.42, 'hedge', 6],
    ] },
  ],
  goKartTrack: [
    { name: 'twisting kart circuit with a hairpin tongue, tyre walls, a pit garage, a grandstand and a start gantry', height: 0.65, ops: [
      lawn(3, 2),
      // the circuit: a loop with a tongue pushed in from the back, outer corners rounded
      ['box', 2.4, 0.006, 0.14, 0, 0.012, 0.45, ASPHALT], ['box', 0.14, 0.006, 1.23, -1.2, 0.012, -0.165, ASPHALT], ['box', 0.14, 0.006, 1.23, 1.2, 0.012, -0.165, ASPHALT],
      ['box', 0.97, 0.006, 0.14, 0.715, 0.012, -0.78, ASPHALT], ['box', 0.97, 0.006, 0.14, -0.715, 0.012, -0.78, ASPHALT],
      ['box', 0.14, 0.006, 0.97, 0.3, 0.012, -0.365, ASPHALT], ['box', 0.14, 0.006, 0.97, -0.3, 0.012, -0.365, ASPHALT], ['box', 0.74, 0.006, 0.14, 0, 0.012, 0.05, ASPHALT],
      ...[[-1.2, 0.45], [1.2, 0.45], [-1.2, -0.78], [1.2, -0.78]].map(([x, z]): Op => ['cyl', 0.07, 0.07, 0.006, x, 0.012, z, ASPHALT, 12]),
      // start line and gantry with its lights
      ['box', 0.02, 0.008, 0.14, -0.06, 0.012, 0.45, 'white'], ['box', 0.02, 0.008, 0.14, -0.03, 0.012, 0.45, 'charcoal'],
      ['box', 0.025, 0.28, 0.025, -0.1, 0.012, 0.355, 'charcoal'], ['box', 0.025, 0.28, 0.025, -0.1, 0.012, 0.545, 'charcoal'],
      ['box', 0.03, 0.04, 0.215, -0.1, 0.27, 0.45, 'charcoal'], ['box', 0.006, 0.02, 0.16, -0.118, 0.28, 0.45, 'red', 'sign'],
      // kerbs on the inside of two corners
      ['box', 0.025, 0.008, 0.24, 1.115, 0.012, 0.26, 'red'], ['box', 0.026, 0.009, 0.05, 1.115, 0.012, 0.2, 'white'], ['box', 0.026, 0.009, 0.05, 1.115, 0.012, 0.32, 'white'],
      ['box', 0.4, 0.008, 0.025, 0, 0.012, 0.135, 'red'], ['box', 0.06, 0.009, 0.026, -0.1, 0.012, 0.135, 'white'], ['box', 0.06, 0.009, 0.026, 0.1, 0.012, 0.135, 'white'],
      // tyre walls down both outer sides, tyre stacks at the back corners and in the tongue
      ...[-1.36, 1.36].flatMap((x): Op[] => [
        ['lathe', x, 0.04, -0.65, 'charcoal', [0.028, 0, 0.028, 0.95], { axis: 'z', seg: 8 }], ['lathe', x, 0.095, -0.62, 0x3a3d44, [0.028, 0, 0.028, 0.9], { axis: 'z', seg: 8 }],
      ]),
      ...[[-1.36, -0.92], [1.36, -0.92], [-0.15, -0.1], [0.15, -0.1]].map(([x, z]): Op => ['cyl', 0.03, 0.03, 0.08, x, 0.012, z, 'charcoal', 8]),
      // three karts parked in the pit lane (the ones racing are the client's moving parts, render/leisureRigs.ts)
      ['box', 0.08, 0.02, 0.05, -0.55, 0.018, 0.64, 'yellow'], ['cyl', 0.012, 0.012, 0.02, -0.56, 0.038, 0.64, 'red', 6],
      ['box', 0.08, 0.02, 0.05, -0.35, 0.018, 0.64, 'boxBlue'], ['cyl', 0.012, 0.012, 0.02, -0.36, 0.038, 0.64, 'white', 6],
      ['box', 0.08, 0.02, 0.05, -0.15, 0.018, 0.64, 'boxGreen'], ['cyl', 0.012, 0.012, 0.02, -0.16, 0.038, 0.64, 'yellow', 6],
      // pit lane and wall, the pit garage with a lit name and a chequered flag
      ['box', 1.15, 0.006, 0.08, -0.175, 0.012, 0.64, 0x4a4d55], ['box', 1.15, 0.03, 0.012, -0.175, 0.012, 0.56, 'white'],
      ['box', 1.0, 0.18, 0.26, -0.2, 0.012, 0.83, 'white'], ['box', 1.01, 0.03, 0.27, -0.2, 0.15, 0.83, 0xd9b02e],
      ['box', 0.3, 0.12, 0.012, -0.2, 0.012, 0.962, 'glass'], ['box', 0.5, 0.05, 0.02, -0.2, 0.192, 0.92, 'charcoal', 'sign'], ['flag', 0.2, 0.192, 0.8, 'white'],
      // the grandstand and its roof
      ...repeat(3, (i): Op => ['box', 0.75, 0.06 * (i + 1), 0.09, 0.95, 0.012, 0.66 + i * 0.09, i % 2 ? 'grey' : 'red']),
      ['box', 0.02, 0.29, 0.02, 0.6, 0.012, 0.92, 'steel'], ['box', 0.02, 0.29, 0.02, 1.3, 0.012, 0.92, 'steel'], ['box', 0.8, 0.015, 0.32, 0.95, 0.3, 0.77, 'white'],
      // a car park, floodlights and a tree in the tongue
      ['box', 0.66, 0.004, 0.3, -1.1, 0.012, 0.8, 'gravel'], ...carRow(-1.35, 0.8, 4, 0.18, false, 0.016, 2),
      ...floodlight(-1.42, -0.2, 0.55, false), ...floodlight(1.42, 0.1, 0.55, false), ...tree(0, -0.62, 1.0),
    ] },
    { name: 'figure-of-eight kart track with a bridge over the crossing and a timing tower', height: 0.71, ops: [
      lawn(3, 2),
      // the figure of eight: the north-south leg climbs over the east-west leg on a bridge
      ['box', 0.14, 0.006, 0.2, 0, 0.012, 0.4, ASPHALT],
      ['taper', 0.14, 0.27, 0.14, 0.01, 0.1, 0, 0.012, 0.165, ASPHALT, { shift: [0, -0.13] }],
      ['box', 0.16, 0.02, 0.26, 0, 0.1, -0.1, 0x9a968e], ['box', 0.14, 0.004, 0.26, 0, 0.12, -0.1, ASPHALT],
      ['box', 0.006, 0.03, 0.26, -0.078, 0.12, -0.1, 'red'], ['box', 0.006, 0.03, 0.26, 0.078, 0.12, -0.1, 'red'],
      ['taper', 0.14, 0.27, 0.14, 0.01, 0.1, 0, 0.012, -0.365, ASPHALT, { shift: [0, 0.13] }],
      ['box', 0.14, 0.006, 0.3, 0, 0.012, -0.65, ASPHALT],
      ['box', 1.2, 0.006, 0.14, -0.6, 0.012, -0.8, ASPHALT], ['box', 0.14, 0.006, 0.7, -1.2, 0.012, -0.45, ASPHALT],
      ['box', 2.4, 0.006, 0.14, 0, 0.012, -0.1, ASPHALT], ['box', 0.14, 0.006, 0.6, 1.2, 0.012, 0.2, ASPHALT], ['box', 1.2, 0.006, 0.14, 0.6, 0.012, 0.5, ASPHALT],
      ...[[0, 0.5], [0, -0.8], [-1.2, -0.8], [-1.2, -0.1], [1.2, -0.1], [1.2, 0.5]].map(([x, z]): Op => ['cyl', 0.07, 0.07, 0.006, x, 0.012, z, ASPHALT, 12]),
      ['box', 0.02, 0.008, 0.14, 0.7, 0.012, 0.5, 'white'], ['box', 0.02, 0.008, 0.14, 0.73, 0.012, 0.5, 'charcoal'],
      // the timing tower: a white shaft, a glass control room, a lit position board
      ['box', 0.16, 0.55, 0.16, -0.78, 0.012, 0.58, 'white'], ['box', 0.24, 0.12, 0.24, -0.78, 0.562, 0.58, 'glass', 'venue'], ['box', 0.27, 0.025, 0.27, -0.78, 0.682, 0.58, 'charcoal'],
      ['box', 0.12, 0.4, 0.012, -0.78, 0.12, 0.666, 'charcoal'], ['box', 0.08, 0.34, 0.014, -0.78, 0.15, 0.666, 0xf2cf3a, 'sign'],
      // a stand by the bridge, rising away from the track
      ...repeat(3, (i): Op => ['box', 0.09, 0.06 * (i + 1), 0.36, -0.2 - i * 0.09, 0.012, 0.26, i % 2 ? 'grey' : 0xd9b02e]),
      // pit lane, garages and the reception with a lit name
      ['box', 1.2, 0.006, 0.08, 0.5, 0.012, 0.65, 0x4a4d55], ['box', 1.2, 0.03, 0.012, 0.5, 0.012, 0.6, 'white'],
      ['box', 1.1, 0.16, 0.24, 0.5, 0.012, 0.84, 'silver'], ['box', 0.36, 0.24, 0.23, -0.24, 0.012, 0.835, 0xd9b02e],
      ['box', 0.2, 0.14, 0.012, -0.24, 0.012, 0.956, 'glass'], ['box', 0.6, 0.06, 0.02, 0.5, 0.09, 0.97, 'charcoal', 'sign'],
      // kerb, tyre walls and stacks by the bridge, karts parked in the pit lane (the racing ones are the client's moving parts), floodlights and a tree in the paddock
      ['box', 0.025, 0.008, 0.3, -1.115, 0.012, -0.45, 'red'], ['box', 0.026, 0.009, 0.06, -1.115, 0.012, -0.52, 'white'], ['box', 0.026, 0.009, 0.06, -1.115, 0.012, -0.38, 'white'],
      ['lathe', -1.36, 0.04, -0.9, 'charcoal', [0.028, 0, 0.028, 0.9], { axis: 'z', seg: 8 }], ['lathe', 1.36, 0.04, -0.2, 'charcoal', [0.028, 0, 0.028, 0.8], { axis: 'z', seg: 8 }],
      ['cyl', 0.03, 0.03, 0.08, -0.12, 0.012, 0.02, 'charcoal', 8], ['cyl', 0.03, 0.03, 0.08, 0.14, 0.012, -0.26, 'charcoal', 8],
      ['box', 0.08, 0.02, 0.05, 0.3, 0.018, 0.65, 'red'], ['cyl', 0.012, 0.012, 0.02, 0.29, 0.038, 0.65, 'white', 6],
      ['box', 0.08, 0.02, 0.05, 0.5, 0.018, 0.65, 'yellow'], ['cyl', 0.012, 0.012, 0.02, 0.49, 0.038, 0.65, 'boxBlue', 6],
      ['box', 0.08, 0.02, 0.05, 0.7, 0.018, 0.65, 'boxBlue'], ['cyl', 0.012, 0.012, 0.02, 0.69, 0.038, 0.65, 'red', 6],
      ...floodlight(-1.42, 0.2, 0.55, false), ...floodlight(1.42, -0.6, 0.55, false), ...tree(0.8, -0.62, 1.1),
    ] },
  ],
};
