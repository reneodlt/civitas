import { MeshLambertMaterial, MeshDepthMaterial, RGBADepthPacking, Vector4 } from 'three';
import { sceneUniforms } from './materials';

/**
 * The year on the client (docs/weather.md W5): trees leaf, turn and drop by the year phase, grass changes hue, and `?season=` forces it.
 *
 * Trees are instanced meshes (street trees in render/roads.ts, park trees in render/parks.ts); the season is a vertex-shader patch
 * on their material, so it costs nothing on the CPU: a per-tree hash from the instance's world position (nobody turns in lockstep, a
 * street takes a couple of game days to go from green to bare) and the `uYear` uniform. The year (a game week) starts in spring:
 *   bud   the leaves open between phase about -0.06 and 0.28 (each tree its own start), young leaves a fresher yellow-green
 *   turn  from about 0.46 each tree goes yellow, orange or red over a tenth of a year
 *   drop  from about 0.56 the foliage thins (the canopy shrinks to a sparse twig mass of its trunk's brown) and is bare by 0.8
 * Conifers are evergreen. `uSnow` lays white on the upper surfaces of every tree, bare or not, patchily by tree.
 */

export type SeasonName = 'spring' | 'summer' | 'autumn' | 'winter';
/** the phase `?season=` forces: spring mid-bud, summer full, autumn mid-turn, winter bare */
export const SEASON_PHASE: Record<SeasonName, number> = { spring: 0.1, summer: 0.38, autumn: 0.59, winter: 0.86 };
export const isSeasonName = (s: string | null): s is SeasonName => s === 'spring' || s === 'summer' || s === 'autumn' || s === 'winter';

/** the grass multiplier (xyz) and grey blend (w) for a year phase: greener in spring, yellower late in summer, duller in winter */
export function grassFor(phase: number, out: Vector4 = new Vector4()): Vector4 {
  const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // anchor looks at spring 0.12, high summer 0.3, late summer 0.45, autumn 0.62, winter 0.85, back to spring across 1.0
  const K: [number, number, number, number, number][] = [
    [0.12, 0.96, 1.16, 0.9, 0.0], [0.3, 1.0, 1.0, 0.95, 0.0], [0.45, 1.14, 1.0, 0.74, 0.1], [0.62, 1.14, 0.92, 0.7, 0.25], [0.85, 0.92, 0.9, 0.82, 0.55],
  ];
  const first = K[0], last = K[K.length - 1];
  let a = last, b = first, t: number;
  if (phase >= last[0]) t = (phase - last[0]) / (1 + first[0] - last[0]);
  else if (phase < first[0]) t = (phase + 1 - last[0]) / (1 + first[0] - last[0]);
  else { let i = 0; while (i < K.length - 2 && phase >= K[i + 1][0]) i++; a = K[i]; b = K[i + 1]; t = (phase - a[0]) / (b[0] - a[0]); }
  t = sm(0, 1, t);
  return out.set(a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t);
}

const FN = /* glsl */ `
uniform float uYear;
uniform float uSnow;
float mscTreeH(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// leaf amount 0..1 (bud and drop), and the tree's turn 0..1, from the year phase and the tree's hash
float mscLeaf(float h, float h3) {
  float yy = uYear < 0.9 ? uYear + 0.1 : uYear - 0.9;
  float bud = smoothstep(0.04 + 0.10 * h, 0.20 + 0.10 * h, yy);
  float drop = uYear < 0.9 ? smoothstep(0.56 + 0.10 * h3, 0.70 + 0.10 * h3, uYear) : 0.0;
  return bud * (1.0 - drop);
}`;

interface LeafOpts {
  /** the canopy's centre height in the geometry's own units: the foliage shrinks towards it when it thins */
  crownY: number;
  /** geometry above this height (own units) is canopy; below it, trunk (kept as it is). -1 when the whole mesh is canopy */
  above: number;
  evergreen?: boolean;
}

/** shrink the canopy by the leaf amount: a bare tree is a small twig mass, not a green ball */
const denOf = /* glsl */ `float mscDens = mix(0.55, 1.0, smoothstep(0.0, 0.65, mscLf));`;

function colourPatch(o: LeafOpts) {
  if (o.evergreen) return /* glsl */ `
  vec3 mscIP = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float mscH = mscTreeH(mscIP.xz);
  float mscDens = 1.0;
  if (uSnow > 0.001) {
    float sk = smoothstep(mscH * 0.4, mscH * 0.4 + 0.3, uSnow * 1.15) * smoothstep(0.1, 0.6, normal.y) * step(color.r, color.g * 1.1);
    vColor = mix(vColor, vec3(0.9, 0.93, 1.0), 0.85 * sk);
  }`;
  return /* glsl */ `
  vec3 mscIP = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float mscH = mscTreeH(mscIP.xz), mscH2 = fract(mscH * 7.31), mscH3 = fract(mscH * 13.7);
  float mscLf = mscLeaf(mscH, mscH3);
  ${denOf}
  float mscCanopy = ${o.above < 0 ? '1.0' : `step(color.r, color.g * 1.1)`};
  if (mscCanopy > 0.5) {
    vec3 base = vColor;
    float lum = dot(base, vec3(0.299, 0.587, 0.114));
    // autumn: this tree's colour, in step with its own turn
    float turn = smoothstep(0.46 + 0.10 * mscH2, 0.58 + 0.10 * mscH2, uYear) * (uYear < 0.9 ? 1.0 : 0.0);
    vec3 fall = mscH3 < 0.34 ? vec3(0.95, 0.72, 0.16) : mscH3 < 0.7 ? vec3(0.9, 0.42, 0.1) : vec3(0.72, 0.17, 0.09);
    vec3 col = mix(base, fall * (0.45 + 0.9 * lum), turn);
    // spring: young leaves are a fresher yellow-green until they have opened
    col = mix(base * vec3(1.35, 1.28, 0.72), col, smoothstep(0.3, 0.9, mscLf + turn));
    // bare: the twig mass takes the brown of branches
    col = mix(vec3(0.36, 0.29, 0.23) * (0.75 + 0.5 * lum), col, smoothstep(0.05, 0.45, mscLf));
    if (uSnow > 0.001) {
      float sk = smoothstep(mscH * 0.4, mscH * 0.4 + 0.3, uSnow * 1.15) * smoothstep(0.1, 0.6, normal.y);
      col = mix(col, vec3(0.9, 0.93, 1.0), 0.85 * sk);
    }
    vColor = col;
  }`;
}
const shrinkPatch = (o: LeafOpts) => o.evergreen ? '' : /* glsl */ `
  if (${o.above < 0 ? 'true' : `position.y > ${o.above.toFixed(3)} && mscDens < 0.999`}) transformed = vec3(0.0, ${o.crownY.toFixed(3)}, 0.0) + (transformed - vec3(0.0, ${o.crownY.toFixed(3)}, 0.0)) * mscDens;`;

/** A Lambert tree material with the year in its vertex shader. */
export function leafMaterial(o: LeafOpts): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uYear = sceneUniforms.uYear; shader.uniforms.uSnow = sceneUniforms.uSnow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + FN)
      .replace('#include <color_vertex>', '#include <color_vertex>' + colourPatch(o))
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + shrinkPatch(o));
  };
  m.customProgramCacheKey = () => `msc-leaf-${o.crownY}-${o.above}-${o.evergreen ? 1 : 0}`;
  return m;
}

/** The shadow pass's matching depth material: a thinned canopy casts a thinned shadow. */
export function leafDepthMaterial(o: LeafOpts): MeshDepthMaterial | undefined {
  if (o.evergreen) return undefined;
  const m = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uYear = sceneUniforms.uYear; shader.uniforms.uSnow = sceneUniforms.uSnow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + FN)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vec3 mscIP = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float mscH = mscTreeH(mscIP.xz), mscH3 = fract(mscH * 13.7);
  float mscLf = mscLeaf(mscH, mscH3);
  ${denOf}` + shrinkPatch(o));
  };
  m.customProgramCacheKey = () => `msc-leafdepth-${o.crownY}-${o.above}`;
  return m;
}
