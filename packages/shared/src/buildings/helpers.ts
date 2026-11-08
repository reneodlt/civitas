import type { Color, HelperModel, Op } from './schema';

/**
 * Helper ops expand into primitive ops at compile time. Add one here and any
 * recipe can use it; the renderer only ever sees boxes, roofs, cylinders,
 * cones and wheels.
 */
type Prim = Extract<Op, { 0: 'box' | 'roof' | 'cyl' | 'cone' | 'wheel' }>;
export const HELPERS: Record<string, { args: string[]; minArgs: number; expand(a: (number | Color)[]): Prim[] }> = {
  /**
   * A tower crane's mast only: the jib, counter-jib, cab, cable and hook are drawn turning by the client's ambient pass
   * (client/src/render/ambient.ts finds the mast by this exact box: 0.06 square, yellow, 0.8 or taller).
   */
  crane: {
    args: ['x', 'y', 'z', 'mastH'], minArgs: 4,
    expand: ([x, y, z, mastH]) => {
      const X = x as number, Y = y as number, Z = z as number, M = mastH as number;
      return [['box', 0.06, M, 0.06, X, Y, Z, 'yellow']];
    },
  },
  flag: {
    args: ['x', 'y', 'z', 'color'], minArgs: 4,
    expand: ([x, y, z, color]) => {
      const X = x as number, Y = y as number, Z = z as number;
      return [['cyl', 0.008, 0.008, 0.2, X, Y, Z, 'steel', 4], ['box', 0.08, 0.05, 0.01, X + 0.045, Y + 0.15, Z, color as Color]];
    },
  },
  chimneyStack: {
    args: ['x', 'y', 'z', 'h', 'r', 'body'], minArgs: 5,
    expand: ([x, y, z, h, r, body]) => {
      const X = x as number, Y = y as number, Z = z as number, H = h as number, R = r as number;
      return [['cyl', R, R * 1.25, H, X, Y, Z, (body ?? 'chimney') as Color], ['cyl', R * 1.1, R * 1.1, 0.07, X, Y + H, Z, 'red']];
    },
  },
};

/** Models the renderer places by key rather than by kind: the crane over a site and the site fence. */
export const HELPER_MODELS: HelperModel[] = [
  { key: 'crane', height: 0.9, ops: [['crane', 0.3, 0, -0.3, 0.9]] },
  {
    key: 'site', height: 0.2, ops: [
      ...([[-0.44, -0.44], [0.44, -0.44], [0.44, 0.44], [-0.44, 0.44]] as const).map(([x, z]): Op => ['box', 0.04, 0.2, 0.04, x, 0, z, 'grey']),
      ['box', 0.9, 0.03, 0.02, 0, 0.14, -0.44, 'yellow'],
      // the front is a plywood hoarding with an ad slot (docs/adverts.md section 2); the renderer turns the site to face the road
      ['box', 0.84, 0.17, 0.016, 0, 0.005, 0.442, 0xcbb994, undefined, { name: 'hoarding' }],
      ['adslot', 'hoarding', 'front', 0, 0, 'hoarding'],
      ['box', 0.02, 0.03, 0.9, -0.44, 0.14, 0, 'yellow'], ['box', 0.02, 0.03, 0.9, 0.44, 0.14, 0, 'yellow'],
      ['cone', 0.12, 0.1, -0.28, 0, 0.28, 'sand', 7],
    ],
  },
];

/** n copies of an op built from its index: `repeat(6, (i) => ['box', ...])`. */
export const repeat = (n: number, f: (i: number) => Op): Op[] => Array.from({ length: n }, (_, i) => f(i));
