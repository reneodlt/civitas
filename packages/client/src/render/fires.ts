import {
  Group, Mesh, InstancedBufferGeometry, InstancedBufferAttribute, PlaneGeometry, ShaderMaterial, AdditiveBlending, NormalBlending,
  DynamicDrawUsage, DoubleSide, Matrix4, Vector3,
} from 'three';
import { FIRE, FirePhase, FireOutcome, TICKS_PER_HOUR, TICK_MS, hash2, fireProgress, type FireDTO } from '@msimcity/shared';
import type { ClientWorld } from '../world';
import { sceneUniforms } from './materials';
import { roofAnchor } from './issues';
import { windowSpots, type Spot } from './fireSpots';
import { motion } from './motionGate';

const MAX_FIRES = 64;
/** per fire: tongues on the roof, tongues out of windows, panes lit, soot smears, puffs off the roof and out of windows, embers, drops */
const ROOF_FLAMES = 10, WIN_FLAMES = 12, PANES_MAX = 24, SOOT_MAX = 12, ROOF_PUFFS = 14, WIN_PUFFS = 10, EMBERS_MAX = 14, DROPS_MAX = 36;
/** explosions drawn at once (fires v2), and the pieces of each: the flash, the ring and the fireball; the smoke column and the debris */
const BLASTS_MAX = 16, BLAST_GLOW_MAX = 12, BLAST_SMOKE_MAX = 64;
/**
 * How each cause of explosion looks (shared BLAST_CAUSES, FireDTO.bc; index = cause code). flash: the flash's tint, 1 a
 * warm white, -1 a blue-white (burning gas); ball: the fireball pieces (2 a works' deep orange, 3 burning gas, yellower);
 * balls, bits: [least, spread] of the fireball's balls and the debris; column: the smoke column's height; soot: 0 black
 * oily smoke, 1 pale; debris: 1 a works' steel and rust, 2 a house's brick, timber and slate; throw: how far it flies.
 */
const BLAST_LOOK = [
  { flash: 1, ball: 2, balls: [6, 5], column: 1, soot: 0, debris: 1, bits: [14, 15], throw: 1 }, // industrial
  { flash: -1, ball: 3, balls: [8, 5], column: 0.65, soot: 0.6, debris: 2, bits: [20, 14], throw: 1.3 }, // gas
] as const;
/** a blast this many ticks old when first seen is drawn as already over (a client joining later sees the aftermath, not the flash) */
const BLAST_FRESH = 25;
/** one wind for the town (smoke leans the same general way), each fire and each puff turned off it by its own hash */
const WIND = 0.7;
/** the share burnt at which the fire breaks through the roof: before it, it burns at the windows; after, the roof goes too */
const ROOF_FROM = 0.35, ROOF_FULL = 0.8;

/**
 * Per-instance data, one row per flame, pane, puff or drop, written when the list changes:
 * aP: the instance's anchor in world tiles; aO and aS: what each pass says below; aI (per frame): the fire's state.
 */
interface Pool { geo: InstancedBufferGeometry; P: Float32Array; O: Float32Array; S: Float32Array; I: Float32Array; n: number; mesh: Mesh }

/** value noise for the flames, soot and smoke: a cheap turbulence of their own */
const NOISE = /* glsl */ `
float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hsh(i), hsh(i + vec2(1.0, 0.0)), f.x), mix(hsh(i + vec2(0.0, 1.0)), hsh(i + vec2(1.0, 1.0)), f.x), f.y);
}`;

/**
 * A tongue of flame: aO (nx, 0, nz, mode), mode 1 a window tongue pushed clear of its wall and curling up and out along
 * it, 0 a roof tongue; aS: seed, height, flicker rate, the share burnt at which its window lights; aI: the fire's flame
 * strength, the share burnt, the roof's share of the fire, heat.
 */
const FLAME_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
uniform float uTime;
varying vec2 vUv; varying float vA; varying float vSeed; varying float vHot;
void main() {
  float seed = aS.x, hs = aS.y, rate = aS.z, th = aS.w, mode = aO.w;
  float flame = aI.x, d = aI.y, roof = aI.z;
  float inten = mode > 0.5 ? flame * smoothstep(th, th + 0.12, d) : flame * roof;
  // each tongue flickers at its own rate and phase, leans its own way and breathes in height: nothing in lockstep
  float t = uTime * rate + seed * 61.0;
  float breathe = 0.78 + 0.22 * sin(t) * sin(t * 0.47 + 2.0);
  float h = hs * (0.3 + 0.9 * inten) * breathe;
  float w = h * (0.45 + 0.2 * fract(seed * 7.3));
  vec3 n = vec3(aO.x, 0.0, aO.z);
  vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
  float up = position.y + 0.5;
  float sway = up * up * 0.16 * h * sin(t * 0.8 + seed * 9.0);
  vec3 base = aP + n * (0.03 * mode);
  vec3 p = base + right * (position.x * w + sway) + vec3(0.0, up * h, 0.0) + n * (mode * h * (0.12 + 0.28 * up * up));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vUv = uv; vA = inten > 0.01 ? inten : 0.0; vSeed = seed; vHot = min(1.0, inten * 1.3);
}`;
const FLAME_FRAG = /* glsl */ `
uniform float uTime; uniform float uNight;
varying vec2 vUv; varying float vA; varying float vSeed; varying float vHot;
${NOISE}
void main() {
  if (vA <= 0.0) discard;
  vec2 q = vec2(vUv.x * 2.0 - 1.0, vUv.y);
  float t = uTime * (1.4 + 0.5 * fract(vSeed * 3.3)) + vSeed * 40.0;
  // turbulence rising through the tongue: two octaves of noise scrolling upward at the tongue's own pace
  float n = 0.6 * vnoise(vec2(q.x * 2.2 + vSeed * 9.0, q.y * 3.0 - t)) + 0.4 * vnoise(vec2(q.x * 4.5 - vSeed * 5.0, q.y * 6.0 - t * 1.7 + 3.0));
  float rip = (n - 0.5) * 0.5 * q.y;
  float width = pow(max(0.0, 1.0 - q.y), 0.7) * (0.95 - 0.3 * q.y) + 0.05;
  float dd = abs(q.x + rip) / width;
  float body = (1.0 - smoothstep(0.45, 1.0, dd)) * smoothstep(0.0, 0.06, q.y) * (1.0 - smoothstep(0.6, 1.0, q.y + (0.5 - n) * 0.4));
  float heat = (1.0 - smoothstep(0.0, 1.0, dd)) * (1.0 - 0.75 * q.y) * (0.5 + n);
  float a = body * smoothstep(0.08, 0.45, heat) * vA;
  if (a < 0.015) discard;
  vec3 col = mix(vec3(0.75, 0.08, 0.01), vec3(1.0, 0.5, 0.06), smoothstep(0.15, 0.55, heat));
  col = mix(col, vec3(1.0, 0.95, 0.72), smoothstep(0.6, 1.0, heat) * (0.6 + 0.4 * vHot));
  gl_FragColor = vec4(col * (1.1 + 0.5 * uNight) * a, a);
}`;

/**
 * A window pane: a quad on the wall over the cell (aO: the wall's right vector x, z, the cell's width, height; aS: seed,
 * the share burnt at which it lights). The fire inside flickers through the glass; as the fire goes on the pane chars,
 * and after it is out the window is a black hole that fades with the scorch. aI: flame, the share burnt, the scorch.
 */
const PANE_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
varying vec2 vUv; varying float vBurn; varying float vChar; varying float vSeed;
void main() {
  float seed = aS.x, th = aS.y, flame = aI.x, d = aI.y, scorch = aI.z;
  float lit = smoothstep(th, th + 0.1, d);
  vec3 p = aP + vec3(aO.x, 0.0, aO.y) * position.x * aO.z + vec3(0.0, position.y * aO.w, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vUv = uv; vSeed = seed;
  vBurn = lit * flame;
  vChar = lit * scorch * min(1.0, (d - th) * 2.5 + 0.3);
}`;
const PANE_FRAG = /* glsl */ `
uniform float uTime; uniform float uNight;
varying vec2 vUv; varying float vBurn; varying float vChar; varying float vSeed;
void main() {
  if (vBurn < 0.01 && vChar < 0.01) discard;
  vec2 q = vUv * 2.0 - 1.0;
  // the glass inside the frame, the fire behind it beating on the pane's own rhythm, brighter toward the sill
  float inset = 1.0 - smoothstep(0.6, 0.8, max(abs(q.x), abs(q.y)));
  float fl = 0.72 + 0.18 * sin(uTime * (7.0 + 5.0 * vSeed) + vSeed * 30.0) + 0.1 * sin(uTime * 13.0 + vSeed * 11.0) * sin(uTime * 2.3 + q.y * 3.0);
  vec3 fire = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.8, 0.35), fl * (0.6 + 0.4 * (0.5 - 0.5 * q.y))) * (1.0 + 0.8 * uNight);
  float burn = vBurn * inset, chr = vChar * inset;
  float a = max(burn, chr * 0.92);
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(fire, vec3(0.03, 0.025, 0.02), chr / max(0.001, chr + burn)), a);
}`;

/** Soot: a smear up the wall from a burning window's lintel, widening as it rises; stays through the aftermath. aO as the pane's, aS: seed, threshold; aI.y the share burnt, aI.z the scorch. */
const SOOT_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
varying vec2 vUv; varying float vA; varying float vSeed;
void main() {
  float th = aS.y, d = aI.y, scorch = aI.z;
  float spread = 0.6 + 0.9 * (position.y + 0.5);
  vec3 p = aP + vec3(aO.x, 0.0, aO.y) * position.x * aO.z * spread + vec3(0.0, (position.y + 0.5) * aO.w, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vUv = uv; vSeed = aS.x;
  vA = smoothstep(th + 0.04, th + 0.35, d) * scorch;
}`;
const SOOT_FRAG = /* glsl */ `
varying vec2 vUv; varying float vA; varying float vSeed;
${NOISE}
void main() {
  if (vA < 0.01) discard;
  vec2 q = vec2(vUv.x * 2.0 - 1.0, vUv.y);
  float n = vnoise(vec2(q.x * 3.0 + vSeed * 7.0, q.y * 4.0 + vSeed * 3.0));
  float edge = 1.0 - smoothstep(0.45, 1.0, abs(q.x) + (n - 0.5) * 0.5);
  float a = edge * (1.0 - smoothstep(0.25, 1.0, q.y + (n - 0.5) * 0.4)) * vA * 0.85;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.05, 0.045, 0.04), a);
}`;

/** The glow: a sprite over the roof (aS.w 0) and a disc of light on the ground round the building (1), carrying at night. */
const GLOW_FRAG = /* glsl */ `
uniform float uNight;
varying vec2 vUv; varying float vA; varying float vSeed; varying float vHot;
void main() {
  if (vA <= 0.0) discard;
  float r = length(vUv * 2.0 - 1.0);
  float a = (1.0 - smoothstep(0.0, 1.0, r));
  a = a * a * (0.25 + 0.75 * uNight) * vHot;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(1.0, 0.45, 0.12) * a, a);
}`;
const GLOW_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
uniform float uTime;
varying vec2 vUv; varying float vA; varying float vSeed; varying float vHot;
void main() {
  float seed = aS.x, type = aS.w, inten = aI.x;
  float flick = 0.85 + 0.15 * sin(uTime * (9.0 + 4.0 * seed) + seed * 20.0) * sin(uTime * 3.1 + seed * 5.0);
  float s = (0.9 + 1.6 * inten) * (0.5 + 2.0 * max(aO.z, aO.w)) * 1.3 * flick;
  vec3 p;
  if (type < 0.5) {
    vec3 c = aP + vec3(0.0, 0.2, 0.0);
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    p = c + (right * position.x + up * position.y) * s;
  } else {
    // the light thrown on the ground: a flat disc round the building, flickering with the flames
    p = vec3(aP.x, 0.06, aP.z) + vec3(position.x, 0.0, -position.y) * 2.2 * s;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vUv = uv; vA = inten > 0.002 ? 1.0 : 0.0; vSeed = seed; vHot = inten * (type < 0.5 ? 1.0 : 0.7);
}`;

/**
 * Smoke: puffs off the roof (aS.w below 0) or out of a burning window (aS.w the share burnt at which it lights, aO.xy
 * the push out from the wall), each on its own clock, rising, swelling and drifting downwind. aI: density, tone (soot to
 * steam), the roof's share of the fire, the share burnt.
 */
const SMOKE_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
uniform float uTime; uniform float uWind;
varying vec2 vUv; varying float vA; varying float vTone; varying float vSeed;
void main() {
  float seed = aS.x, size = aS.y, period = aS.z, th = aS.w;
  float smoke = aI.x, roof = aI.z, d = aI.w;
  float inten = smoke * (th < 0.0 ? roof : smoothstep(th, th + 0.1, d) * (1.0 - 0.5 * roof));
  // a puff's life: born over the roof or at the window, rising, swelling and drifting downwind, each on its own clock and heading
  float life = fract(uTime / period + seed * 13.7);
  float drift = uWind + (fract(seed * 3.1) - 0.5) * 0.7 + (fract(seed * 2.3) - 0.5) * 0.8;
  vec3 dir = vec3(cos(drift), 0.0, sin(drift));
  float foot = 0.5 + 2.0 * max(aO.z, aO.w); // 1 over a lot, more over a bigger building
  float rise = life * (0.9 + 1.3 * fract(seed * 5.3)) * (0.6 + 0.6 * inten + 0.3 * d) * foot;
  float lean = pow(life, 1.4) * (0.5 + 0.9 * fract(seed * 9.1)) * foot;
  float wob = sin(uTime * (0.9 + fract(seed * 4.7)) + seed * 17.0) * 0.18 * life;
  vec3 c = aP + vec3(aO.x, 0.1, aO.y) * (th < 0.0 ? 1.0 : (1.0 + 2.0 * life)) + vec3(0.0, rise, 0.0) + dir * lean + vec3(-dir.z, 0.0, dir.x) * wob;
  float s = size * 0.5 * (0.3 + 1.1 * life) * foot * (0.7 + 0.5 * inten);
  float ang = seed * 6.283 + uTime * (fract(seed * 2.9) - 0.5) * 0.4;
  vec2 rp = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * position.xy;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  gl_Position = projectionMatrix * viewMatrix * vec4(c + (right * rp.x + up * rp.y) * s, 1.0);
  vUv = uv;
  vA = inten * pow(sin(3.14159 * life), 0.7) * (1.0 - 0.35 * life);
  vTone = aI.y; vSeed = seed;
}`;
const SMOKE_FRAG = /* glsl */ `
uniform float uNight;
varying vec2 vUv; varying float vA; varying float vTone; varying float vSeed;
void main() {
  if (vA < 0.004) discard;
  vec2 q = vUv * 2.0 - 1.0;
  // a lumpy puff: the disc's edge pushed in and out by a few lobes of its own
  float ang = atan(q.y, q.x);
  float lobes = 0.82 + 0.1 * sin(ang * 3.0 + vSeed * 20.0) + 0.08 * sin(ang * 5.0 - vSeed * 11.0);
  float r = length(q) / lobes;
  float a = (1.0 - smoothstep(0.3, 1.0, r)) * vA * 0.8;
  if (a < 0.004) discard;
  // dark soot while it burns, pale steam once the hoses are on it (tone 0..1)
  vec3 col = mix(vec3(0.13, 0.12, 0.12), vec3(0.78, 0.78, 0.8), vTone) * (1.0 - 0.55 * uNight);
  col += vec3(0.25, 0.08, 0.0) * (1.0 - vTone) * (1.0 - smoothstep(0.0, 0.6, r)) * uNight; // lit from below at night
  gl_FragColor = vec4(col, a);
}`;

/**
 * Embers: sparks carried up out of the flames on their own loops, blinking and dying as they rise and drift downwind.
 * aO: the wall's normal (x, 0, z, mode 1 a window, 0 the roof); aS: seed, size, period, the window's threshold; aI: flame, the share burnt, the roof's share.
 */
const EMBER_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
uniform float uTime; uniform float uWind;
varying float vA; varying vec2 vUv;
void main() {
  float seed = aS.x, size = aS.y, period = aS.z, th = aS.w;
  float flame = aI.x, d = aI.y, roof = aI.z;
  float inten = flame * (aO.w > 0.5 ? smoothstep(th, th + 0.1, d) : roof);
  float life = fract(uTime / period + seed * 7.9);
  vec3 n = vec3(aO.x, 0.0, aO.z);
  vec3 dir = vec3(cos(uWind), 0.0, sin(uWind));
  float rise = life * (0.8 + 1.2 * fract(seed * 5.3));
  vec3 c = aP + n * (0.05 + 0.3 * life) + vec3(0.0, rise, 0.0) + dir * life * life * 0.6
    + vec3(sin(uTime * 3.0 + seed * 50.0), 0.0, cos(uTime * 2.6 + seed * 31.0)) * 0.08 * life;
  float s = size * (1.0 - 0.6 * life);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  gl_Position = projectionMatrix * viewMatrix * vec4(c + (right * position.x + up * position.y) * s, 1.0);
  vUv = uv;
  float blink = 0.6 + 0.4 * sin(uTime * (15.0 + 10.0 * seed) + seed * 9.0);
  vA = inten * (1.0 - life) * smoothstep(0.0, 0.1, life) * blink;
}`;
const EMBER_FRAG = /* glsl */ `
uniform float uNight;
varying float vA; varying vec2 vUv;
void main() {
  if (vA < 0.02) discard;
  float r = length(vUv * 2.0 - 1.0);
  float a = (1.0 - smoothstep(0.1, 1.0, r)) * vA;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vec3(1.0, 0.6, 0.15) * (1.2 + 0.8 * uNight) * a, a);
}`;

/**
 * Water: drops in an arc from where it is thrown (aP) to a point on the building (aO.xyz; aO.w the arc's height). A hose
 * (aS.w 0) is a steady stream, each drop on its own clock and wobble; a bucket chain (aS.w 1) throws in bursts, each
 * thrower on their own rhythm. aI.x is how hard they are at it (0 when not putting a fire out).
 */
const SPRAY_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
uniform float uTime;
varying vec2 vUv; varying float vA;
void main() {
  float seed = aS.x, size = aS.y, rate = aS.z, bucket = aS.w;
  float life = fract(uTime * rate + seed * 23.0);
  // a bucket flies in a short burst every couple of seconds; between, nothing (each thrower has their own beat)
  float beat = fract(uTime * (0.45 + 0.2 * fract(seed * 5.0)) + fract(seed * 3.7));
  float on = bucket > 0.5 ? step(beat, 0.45) : 1.0;
  if (bucket > 0.5) life = beat / 0.45;
  vec3 a = aP, b = aO.xyz;
  vec3 c = mix(a, b, life) + vec3(0.0, aO.w * 4.0 * life * (1.0 - life), 0.0);
  float spread = (bucket > 0.5 ? 0.22 : 0.07) * life;
  c += vec3(sin(seed * 91.0 + uTime * 3.0), 0.0, cos(seed * 57.0 + uTime * 2.3)) * spread;
  float s = size * (0.5 + 0.9 * life) * (bucket > 0.5 ? 1.6 : 1.0);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  gl_Position = projectionMatrix * viewMatrix * vec4(c + (right * position.x + up * position.y) * s, 1.0);
  vUv = uv;
  vA = aI.x * on * smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.85, 1.0, life));
}`;
const SPRAY_FRAG = /* glsl */ `
uniform float uNight;
varying vec2 vUv; varying float vA;
void main() {
  if (vA < 0.01) discard;
  float r = length(vUv * 2.0 - 1.0);
  float a = (1.0 - smoothstep(0.2, 1.0, r)) * vA * 0.95;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.6, 0.8, 1.0) * (1.1 + 0.3 * uNight) * a, a);
}`;

const SCORCH_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
varying vec2 vUv; varying float vA; varying float vSeed;
void main() {
  float seed = aS.x, ang = seed * 6.283;
  vec2 rp = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * (position.xy * vec2(aO.z, aO.w) * 2.0 * (1.15 + 0.35 * fract(seed * 3.7)));
  vec3 p = vec3(aP.x + rp.x, 0.04 + 0.004 * fract(seed * 11.0), aP.z + rp.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vUv = uv; vA = aI.x; vSeed = seed;
}`;
const SCORCH_FRAG = /* glsl */ `
varying vec2 vUv; varying float vA; varying float vSeed;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float ang = atan(q.y, q.x);
  float edge = 0.75 + 0.12 * sin(ang * 4.0 + vSeed * 31.0) + 0.08 * sin(ang * 9.0 - vSeed * 17.0) + 0.05 * sin(ang * 15.0 + vSeed * 7.0);
  float r = length(q) / edge;
  float a = (1.0 - smoothstep(0.45, 1.0, r)) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.04, 0.035, 0.03), a * 0.8);
}`;

/**
 * An explosion's light (fires v2, FireDTO.bx), additive: aS.w is the piece, 0 the flash, 1 the shockwave ring on the
 * ground, 2 a ball of the fireball (3 of a gas fireball). aS: seed, size, duration (s), piece; aO: a ball's heading (x, z), its throw, rise;
 * the flash's and the ring's tint in aO.w (a flash's below 0: blue-white). aI.x is seconds since the blast (wall clock, from when the client saw it).
 */
const BLAST_GLOW_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
varying vec2 vUv; varying float vA; varying float vType; varying float vK; varying float vSeed; varying vec3 vCol;
void main() {
  float seed = aS.x, size = aS.y, dur = aS.z, type = aS.w, age = aI.x;
  float k = clamp(age / dur, 0.0, 1.0);
  vUv = uv; vType = type; vK = k; vSeed = seed;
  vA = (age >= 0.0 && age < dur) ? 1.0 : 0.0;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 p;
  if (type < 0.5) {
    // the flash: a billboard that swells in a blink and is gone
    float s = size * (0.45 + 1.1 * sqrt(k));
    p = aP + vec3(0.0, 0.35, 0.0) + (right * position.x + up * position.y) * s;
    vCol = aO.w < 0.0 ? mix(vec3(0.8, 0.9, 1.0), vec3(1.0, 0.97, 0.9), 1.0 + aO.w) : mix(vec3(1.0, 0.98, 0.88), vec3(1.0, 0.72, 0.38), aO.w);
    vA *= (1.0 - k) * (1.0 - k);
  } else if (type < 1.5) {
    // the shockwave: a ring flat on the ground racing out and thinning
    float r = size * (0.12 + 0.88 * (1.0 - pow(1.0 - k, 2.4)));
    p = vec3(aP.x, 0.07 + 0.03 * aO.w, aP.z) + vec3(position.x, 0.0, -position.y) * 2.0 * r;
    vCol = mix(vec3(1.0, 0.88, 0.66), vec3(0.98, 0.58, 0.28), aO.w);
    vA *= (1.0 - k) * (1.0 - 0.3 * k);
  } else {
    // a ball of the fireball: thrown out and up, swelling, cooling from yellow to a deep orange
    vec3 dir = normalize(vec3(aO.x, 0.0, aO.y) + vec3(0.0001, 0.0, 0.0));
    float e = 1.0 - pow(1.0 - k, 2.0);
    vec3 c = aP + vec3(0.0, 0.25, 0.0) + dir * aO.z * e + vec3(0.0, aO.w * e + 0.5 * k * k, 0.0);
    float s = size * (0.3 + 0.95 * e);
    p = c + (right * position.x + up * position.y) * s;
    vec3 cool = type > 2.5 ? mix(vec3(1.0, 0.72, 0.18), vec3(0.97, 0.48, 0.1), fract(seed * 7.1)) // burning gas: yellower, brighter
                           : mix(vec3(0.95, 0.32, 0.06), vec3(0.8, 0.18, 0.04), fract(seed * 7.1));
    vCol = mix(type > 2.5 ? vec3(1.0, 0.97, 0.78) : vec3(1.0, 0.92, 0.6), cool, smoothstep(0.05, 0.75, k));
    vA *= 1.0 - smoothstep(0.35, 1.0, k);
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const BLAST_GLOW_FRAG = /* glsl */ `
uniform float uNight;
varying vec2 vUv; varying float vA; varying float vType; varying float vK; varying float vSeed; varying vec3 vCol;
void main() {
  if (vA <= 0.003) discard;
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(q), ang = atan(q.y, q.x), a;
  if (vType < 0.5) a = pow(max(0.0, 1.0 - r), 1.5);
  else if (vType < 1.5) {
    // a ragged front of its own: the ring is never a perfect circle
    float front = 0.86 + 0.05 * sin(ang * 5.0 + vSeed * 40.0) + 0.03 * sin(ang * 11.0 - vSeed * 23.0);
    a = (1.0 - smoothstep(0.0, 0.1 + 0.15 * vK, abs(r - front))) + 0.35 * (1.0 - smoothstep(0.0, front, r)) * (1.0 - vK);
  } else {
    float lobes = 0.8 + 0.12 * sin(ang * 3.0 + vSeed * 30.0 + vK * 3.0) + 0.06 * sin(ang * 7.0 - vSeed * 13.0);
    a = 1.0 - smoothstep(0.25, 1.0, r / lobes);
  }
  a *= vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * a * (1.25 + 0.5 * uNight), a);
}`;

/**
 * An explosion's smoke and wreckage (fires v2), normal blending: aS.w 0 a puff of the smoke column, 1 a piece of a
 * works, 2 of a house (brick, timber, slate). A puff: aO (x, z) its place over the ruin, aO.z the column's height, aO.w
 * its paleness (0 black soot); aS.z its period (s). A piece: aO.x its heading,
 * aO.y how far it is thrown, aO.z how high, aO.w its colour; aS.z its time in the air (s). aI: seconds since the blast,
 * the column's strength, the debris's (it fades with the scorch).
 */
const BLAST_SMOKE_VERT = /* glsl */ `
attribute vec3 aP; attribute vec4 aO; attribute vec4 aS; attribute vec4 aI;
uniform float uTime; uniform float uWind;
varying vec2 vUv; varying float vA; varying float vType; varying float vSeed; varying vec3 vCol;
void main() {
  float seed = aS.x, size = aS.y, rate = aS.z, type = aS.w, age = aI.x;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vUv = uv; vType = type; vSeed = seed;
  vec3 p;
  if (type < 0.5) {
    // the column: puffs on their own clocks rising well above the roofs, swelling and bending downwind at the top;
    // in its first seconds it punches up from the ruin
    float life = fract(uTime / rate + seed * 17.3);
    float grow = clamp(age / 2.5, 0.0, 1.0);
    float drift = uWind + (fract(seed * 3.7) - 0.5) * 0.5;
    vec3 dir = vec3(cos(drift), 0.0, sin(drift));
    float h = aO.z * (0.3 + 0.7 * grow);
    float lean = pow(life, 2.0) * h * 0.35 * (0.6 + 0.8 * fract(seed * 5.1));
    float wob = sin(uTime * (0.7 + fract(seed * 4.3)) + seed * 11.0) * 0.25 * life;
    vec3 c = aP + vec3(aO.x, 0.2 + life * h, aO.y) + dir * lean + vec3(-dir.z, 0.0, dir.x) * wob;
    float s = size * (0.45 + 1.5 * life) * (0.6 + 0.4 * grow);
    float ang = seed * 6.283 + uTime * (fract(seed * 2.9) - 0.5) * 0.3;
    vec2 rp = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * position.xy;
    p = c + (right * rp.x + up * rp.y) * s;
    vA = aI.y * pow(sin(3.14159 * life), 0.8) * (1.0 - 0.4 * life) * smoothstep(0.0, 0.5, age);
    vCol = mix(mix(vec3(0.08, 0.075, 0.07), vec3(0.3, 0.28, 0.26), fract(seed * 7.7)), vec3(0.62, 0.6, 0.58), aO.w);
  } else {
    // a piece of wreckage on a ballistic arc, tumbling; once down it lies flat where it fell
    float k = clamp(age / rate, 0.0, 1.0);
    vec3 dir = vec3(cos(aO.x), 0.0, sin(aO.x));
    vec3 c = vec3(aP.x, 0.0, aP.z) + dir * aO.y * k + vec3(0.0, aP.y * (1.0 - k) + aO.z * 4.0 * k * (1.0 - k), 0.0);
    if (k < 1.0) {
      float spin = age * (4.0 + 7.0 * fract(seed * 3.3)) + seed * 20.0;
      vec2 rp = mat2(cos(spin), -sin(spin), sin(spin), cos(spin)) * position.xy * vec2(1.0, 0.55);
      p = c + (right * rp.x + up * rp.y) * size;
    } else {
      float a2 = seed * 6.283;
      vec2 rp = mat2(cos(a2), -sin(a2), sin(a2), cos(a2)) * position.xy * vec2(1.0, 0.55) * size;
      p = vec3(c.x + rp.x, 0.05 + 0.01 * fract(seed * 13.0), c.z + rp.y);
    }
    vA = age >= 0.0 ? aI.z : 0.0;
    vCol = type > 1.5
      ? (aO.w < 0.45 ? mix(vec3(0.5, 0.2, 0.14), vec3(0.62, 0.3, 0.2), aO.w / 0.45) : aO.w < 0.8 ? vec3(0.48, 0.36, 0.22) : vec3(0.24, 0.26, 0.3)) // brick, timber, slate
      : mix(vec3(0.09, 0.075, 0.065), vec3(0.42, 0.27, 0.18), aO.w);
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const BLAST_SMOKE_FRAG = /* glsl */ `
uniform float uNight;
varying vec2 vUv; varying float vA; varying float vType; varying float vSeed; varying vec3 vCol;
void main() {
  if (vA < 0.004) discard;
  vec2 q = vUv * 2.0 - 1.0;
  float a;
  if (vType < 0.5) {
    float ang = atan(q.y, q.x);
    float lobes = 0.8 + 0.11 * sin(ang * 3.0 + vSeed * 20.0) + 0.08 * sin(ang * 5.0 - vSeed * 11.0);
    a = (1.0 - smoothstep(0.25, 1.0, length(q) / lobes)) * 0.92;
  } else {
    // a jagged chunk: a box whose edges are bitten in by the piece's own notches
    float bite = 0.12 * sin(q.x * 9.0 + vSeed * 40.0) * sin(q.y * 7.0 - vSeed * 17.0);
    a = 1.0 - smoothstep(0.7, 0.9, max(abs(q.x), abs(q.y)) + bite);
  }
  a *= vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * (1.0 - 0.55 * uNight), a);
}`;

function pool(max: number, vert: string, frag: string, additive: boolean, order: number): Pool {
  const geo = new InstancedBufferGeometry();
  const plane = new PlaneGeometry(1, 1);
  geo.index = plane.index;
  geo.setAttribute('position', plane.getAttribute('position'));
  geo.setAttribute('uv', plane.getAttribute('uv'));
  const P = new Float32Array(max * 3), O = new Float32Array(max * 4), S = new Float32Array(max * 4), I = new Float32Array(max * 4);
  geo.setAttribute('aP', new InstancedBufferAttribute(P, 3).setUsage(DynamicDrawUsage));
  geo.setAttribute('aO', new InstancedBufferAttribute(O, 4).setUsage(DynamicDrawUsage));
  geo.setAttribute('aS', new InstancedBufferAttribute(S, 4).setUsage(DynamicDrawUsage));
  geo.setAttribute('aI', new InstancedBufferAttribute(I, 4).setUsage(DynamicDrawUsage));
  geo.instanceCount = 0;
  const mat = new ShaderMaterial({
    vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, side: DoubleSide, // the scorch, the panes and the soot lie on a surface
    blending: additive ? AdditiveBlending : NormalBlending,
    uniforms: { uTime: sceneUniforms.uTime, uNight: sceneUniforms.uNight, uWind: { value: WIND } },
  });
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return { geo, P, O, S, I, n: 0, mesh };
}

/** a window of a burning building in the world: the spot, where it lights in the fire's course, and the wall's right vector */
interface Win { x: number; y: number; z: number; nx: number; nz: number; rx: number; rz: number; w: number; h: number; th: number }
const V = new Vector3(), N = new Vector3();

/**
 * House fires (server sim/fires.ts, message `fires`). A fire burns where the building is drawn: it starts at one window
 * (hashed from the fire's seed) and spreads across the facade, outward and upward, as the share burnt grows; each
 * window it reaches glows with the fire inside, then a tongue of flame licks out of it and up the wall, dark smoke pours
 * out, embers rise and soot smears the wall above the lintel. Past ROOF_FROM of the burn it breaks through the roof:
 * tongues over the roof, the big smoke column, the glow that carries at night and the light it throws on the ground
 * round the building. Under the hoses the flames die back and the smoke turns to steam; afterwards the panes are black
 * holes, the soot and the scorch stay and fade through the aftermath. A building whose windows the client cannot see
 * (its chunk not loaded, a shed with none) burns at the roof as before. Nine instanced passes, one draw call each; an
 * explosion at a works (fires v2) adds its flash, shockwave ring, fireball, smoke column and debris in two more, drawn
 * only while a blast is in the list.
 *
 * The standing organic rule: every flame has its own height, width, flicker rate and phase, sway and place; every puff
 * its own clock, rise, size, heading off the town's wind and wobble; every pane its own beat; every fire its own first
 * window, its own order of spread, its own count of each part, its own lean of the wind and its own scorch outline, all
 * from hash2 of the tile and the fire's seed. How big it is follows the fire's own course (shared fireProgress).
 *
 * The switch (render/motionGate.ts): the flicker is the GPU's, from uTime; the frame's work is the per-fire state written
 * into the instances, done every frame at level 2, every other frame at 1, and once in thirty at 0 (frozen: the flames
 * still flicker, the fire's course just steps along); embers are drawn at level 2 only.
 */
export class FiresView {
  group = new Group();
  private fires: FireDTO[] = [];
  private flames = pool(MAX_FIRES * (ROOF_FLAMES + WIN_FLAMES), FLAME_VERT, FLAME_FRAG, true, 9);
  private panes = pool(MAX_FIRES * PANES_MAX, PANE_VERT, PANE_FRAG, false, 6);
  private soot = pool(MAX_FIRES * SOOT_MAX, SOOT_VERT, SOOT_FRAG, false, 7);
  private glows = pool(MAX_FIRES * 2, GLOW_VERT, GLOW_FRAG, true, 8);
  private smoke = pool(MAX_FIRES * (ROOF_PUFFS + WIN_PUFFS), SMOKE_VERT, SMOKE_FRAG, false, 10);
  private embers = pool(MAX_FIRES * EMBERS_MAX, EMBER_VERT, EMBER_FRAG, true, 11);
  private scorch = pool(MAX_FIRES + BLASTS_MAX, SCORCH_VERT, SCORCH_FRAG, false, 1);
  private spray = pool(MAX_FIRES * DROPS_MAX, SPRAY_VERT, SPRAY_FRAG, true, 11);
  private blastGlow = pool(BLASTS_MAX * BLAST_GLOW_MAX, BLAST_GLOW_VERT, BLAST_GLOW_FRAG, true, 12);
  private blastSmoke = pool(BLASTS_MAX * BLAST_SMOKE_MAX, BLAST_SMOKE_VERT, BLAST_SMOKE_FRAG, false, 10);
  /** when each blast (door and tick) began on the wall clock, in seconds: the flash and debris run in real time, not game time */
  private blastAt = new Map<string, number>();
  /** which fire each instance belongs to, per pool */
  private owner = new Map<Pool, Int16Array>();
  private builtAt = 0;
  private frames = 0;
  /** whether each fire's windows were found (its building drawn), for the roof's share of it */
  private hasWindows: boolean[] = [];
  /** the built building whose door is (x, y), as drawn: its design key and matrix (main.ts: render/buildings.ts placementAt); null draws the fire on the roof */
  placement: ((x: number, y: number) => { key: string; matrix: Matrix4 } | null) | null = null;
  /** windows lit, flames drawn, the last frame's cost in ms: for the perf readout */
  windowsLit = 0; lastMs = 0;

  constructor(private world: ClientWorld) {
    for (const p of this.pools) {
      this.group.add(p.mesh);
      this.owner.set(p, new Int16Array(p.P.length / 3));
    }
  }

  get count() { return this.fires.length; }

  /** The server's list (message `fires`). */
  set(list: FireDTO[]) { this.fires = list.slice(0, MAX_FIRES); this.rebuild(); }

  /**
   * The windows of a burning building in world tiles, in the order the fire reaches them: from its first window (the
   * fire's seed picks it) outward and upward across the facades, each with the share burnt at which it lights.
   */
  private windowsOf(f: FireDTO, fx: number): Win[] {
    const pl = this.placement?.(f.x, f.y);
    if (!pl) return [];
    const spots = windowSpots(pl.key);
    if (!spots.length) return [];
    const m = pl.matrix, sc = m.getMaxScaleOnAxis();
    const wins: (Win & { score: number })[] = spots.map((s: Spot, i) => {
      V.set(s.x, s.y, s.z).applyMatrix4(m);
      N.set(s.nx, 0, s.nz).transformDirection(m);
      return { x: V.x, y: V.y, z: V.z, nx: N.x, nz: N.z, rx: N.z, rz: -N.x, w: s.w * sc, h: s.h * sc, th: 0, score: hash2(fx * 3 + i * 7, f.y * 5 + i) * 0.15 };
    });
    const first = wins[Math.floor(f.s * wins.length) % wins.length];
    for (const w of wins) w.score += Math.hypot(w.x - first.x, w.z - first.z) - 0.6 * (w.y - first.y);
    wins.sort((a, b) => a.score - b.score);
    const n = wins.length;
    wins.forEach((w, i) => { w.th = Math.pow(i / Math.max(1, n - 1), 0.8) * 0.82; });
    return wins;
  }

  /** Lay out every instance: positions from the buildings drawn now, the variation from hashes. */
  private rebuild() {
    this.builtAt = performance.now();
    for (const p of this.pools) p.n = 0;
    let blasts = 0, lit = 0;
    this.hasWindows = [];
    this.fires.forEach((f, fi) => {
      const roof = roofAnchor(this.world, f.x, f.y, 0);
      const ground: [number, number, number] = [roof[0], 0, roof[2]];
      const hx = f.w / 2, hz = f.h / 2;
      const fx = f.x + 7919 * Math.floor(f.s * 997); // the fire's own seed in every hash: the drill house burns differently each time
      const wins = this.windowsOf(f, fx);
      this.hasWindows[fi] = wins.length > 0;
      lit += wins.length;
      // at the windows: the pane lit, a tongue out of the first dozen, smoke, embers and soot
      wins.slice(0, PANES_MAX).forEach((w, i) => this.put(this.panes, fi, [w.x + w.nx * 0.004, w.y, w.z + w.nz * 0.004], [w.rx, w.rz, w.w * 0.98, w.h * 0.98], [hash2(fx * 7 + i * 3, f.y * 11 + i), w.th, 0, 0]));
      wins.slice(0, WIN_FLAMES).forEach((w, i) => {
        const a = hash2(fx * 31 + i * 7, f.y * 17 + i * 3), c = hash2(i * 19 + fx, i * 23 + f.y);
        this.put(this.flames, fi, [w.x, w.y - w.h * 0.3, w.z], [w.nx, 0, w.nz, 1], [c, 0.3 + 0.3 * a + 0.4 * w.h, 5 + 5 * a, w.th]);
      });
      wins.slice(0, SOOT_MAX).forEach((w, i) => this.put(this.soot, fi, [w.x + w.nx * 0.006, w.y + w.h * 0.45, w.z + w.nz * 0.006], [w.rx, w.rz, w.w * 1.1, w.h * (1.6 + 0.8 * hash2(i, fx))], [hash2(fx * 13 + i, f.y * 3 + i * 5), w.th, 0, 0]));
      wins.slice(0, WIN_PUFFS).forEach((w, i) => {
        const a = hash2(fx * 41 + i * 13, f.y * 29 + i), b = hash2(f.y * 37 + i * 3, fx * 43 + i * 9);
        this.put(this.smoke, fi, [w.x + w.nx * 0.05, w.y + w.h * 0.2, w.z + w.nz * 0.05], [w.nx * 0.12, w.nz * 0.12, hx * 0.35, hz * 0.35], [hash2(i * 53 + fx, f.y * 3 + i), 0.35 + 0.4 * b, 2.6 + 3 * a, w.th]);
      });
      const nEm = wins.length ? EMBERS_MAX : 6;
      for (let i = 0; i < nEm; i++) {
        const a = hash2(fx * 67 + i * 5, f.y * 71 + i * 3), w = wins.length ? wins[i % Math.min(wins.length, WIN_FLAMES)] : null;
        if (w) this.put(this.embers, fi, [w.x, w.y, w.z], [w.nx, 0, w.nz, 1], [a, 0.03 + 0.025 * hash2(i, fx), 1.6 + 1.8 * a, w.th]);
        else this.put(this.embers, fi, roof, [0, 0, 0, 0], [a, 0.03 + 0.025 * hash2(i, fx), 1.6 + 1.8 * a, 0]);
      }
      // the roof: tongues clustered toward the middle, a few out at the edges, once the fire has broken through
      const nFl = 5 + Math.floor(hash2(fx * 3 + 1, f.y * 5 + 2) * (ROOF_FLAMES - 4));
      for (let i = 0; i < nFl; i++) {
        const a = hash2(fx * 31 + i * 7, f.y * 17 + i * 3), b = hash2(f.y * 13 + i * 11, fx * 7 + i * 5), c = hash2(i * 19 + fx, i * 23 + f.y);
        const ox = (a - 0.5) * (a - 0.5) * Math.sign(a - 0.5) * 2.6 * hx, oz = (b - 0.5) * (b - 0.5) * Math.sign(b - 0.5) * 2.6 * hz;
        const foot = 0.5 + Math.max(hx, hz);
        this.put(this.flames, fi, [roof[0] + ox, roof[1] - 0.05, roof[2] + oz], [0, 0, 0, 0], [c, (0.45 + 0.75 * hash2(c * 1000, i)) * foot * 0.85, 5.5 + 5 * a, 0]);
      }
      this.put(this.glows, fi, roof, [0, 0, hx * 0.5, hz * 0.5], [f.s, 1, 1, 0]);
      this.put(this.glows, fi, ground, [0, 0, hx * 0.5, hz * 0.5], [f.s, 1, 1, 1]);
      const nSm = 7 + Math.floor(hash2(fx * 7 + 3, f.y * 11 + 1) * (ROOF_PUFFS - 6));
      for (let i = 0; i < nSm; i++) {
        const a = hash2(fx * 41 + i * 13, f.y * 29 + i), b = hash2(f.y * 37 + i * 3, fx * 43 + i * 9);
        this.put(this.smoke, fi, roof, [(a - 0.5) * hx * 0.8, (b - 0.5) * hz * 0.8, hx * 0.5, hz * 0.5], [hash2(i * 53 + fx, f.y * 3 + i), 0.55 + 0.6 * b, 3.2 + 3.6 * a, -1]);
      }
      this.put(this.scorch, fi, ground, [0, 0, hx, hz], [f.s, 1, 1, fi]);
      if (f.bx !== undefined && blasts++ < BLASTS_MAX) this.blast(f, fi, roof, hx, hz);
      // water on it: the crew's hose from the engine at the kerb playing on the burning windows (or the roof), or the neighbours' buckets from round the building
      if (f.hx !== undefined && f.hy !== undefined) {
        const n = 22 + Math.floor(hash2(fx * 5 + 9, f.y * 7 + 4) * (DROPS_MAX - 22));
        const targets = wins.slice(0, WIN_FLAMES);
        for (let i = 0; i < n; i++) {
          const a = hash2(fx * 59 + i * 7, f.y * 31 + i * 13), b = hash2(f.y * 61 + i * 11, fx * 37 + i * 3);
          let tx: number, ty: number, tz: number;
          if (targets.length) { const w = targets[Math.floor(a * targets.length)]; tx = w.x + w.nx * 0.05 + (b - 0.5) * 0.1; ty = w.y + (b - 0.5) * 0.08; tz = w.z + w.nz * 0.05 + (a - 0.5) * 0.1; }
          else { tx = roof[0] + (a - 0.5) * hx * 0.8; tz = roof[2] + (b - 0.5) * hz * 0.8; ty = roof[1] * (0.55 + 0.4 * b); }
          this.put(this.spray, fi, [f.hx, 0.32, f.hy], [tx, ty, tz, 0.55 + 0.45 * a], [hash2(i * 17 + fx, f.y + i * 29), 0.11 + 0.06 * b, 0.8 + 0.6 * a, 0]);
        }
      } else if (f.bk) {
        const throwers = 3 + Math.floor(hash2(fx * 3 + 7, f.y * 9 + 1) * 3);
        for (let k = 0; k < throwers; k++) {
          const ang = (k / throwers) * Math.PI * 2 + f.s * 6.283, r = Math.max(hx, hz) + 0.35;
          const ox = roof[0] + Math.cos(ang) * r, oz = roof[2] + Math.sin(ang) * r;
          const seedK = hash2(fx * 13 + k * 41, f.y * 19 + k);
          for (let i = 0; i < 7; i++) this.put(this.spray, fi, [ox, 0.15, oz], [roof[0] + Math.cos(ang) * hx * 0.5, roof[1] * 0.35, roof[2] + Math.sin(ang) * hz * 0.5, 0.45], [seedK + i * 0.0013, 0.09 + 0.05 * hash2(k * 7 + i, fx), 1, 1]);
        }
      }
    });
    this.windowsLit = lit;
    for (const p of this.pools) {
      p.geo.instanceCount = p.n;
      p.mesh.visible = p.n > 0;
      for (const k of ['aP', 'aO', 'aS']) (p.geo.getAttribute(k) as InstancedBufferAttribute).needsUpdate = true;
    }
  }

  private get pools() { return [this.scorch, this.panes, this.soot, this.glows, this.flames, this.smoke, this.embers, this.spray, this.blastGlow, this.blastSmoke]; }

  /**
   * An explosion's pieces (FireDTO.bx), drawn the way its cause looks (BLAST_LOOK by FireDTO.bc). The organic rule: every blast has its own flash size, tint and length, its own
   * ring's reach, speed, tint and ragged front, its own count of fireball balls each with its own heading, throw, rise,
   * size and life, its own column (height, count and the clocks, places and sizes of its puffs) and its own debris (count,
   * and each piece's heading, throw, height, time in the air, size and colour), and a wider scorch of its own outline,
   * all from hashes of the door and the tick it blew.
   */
  private blast(f: FireDTO, fi: number, roof: readonly number[], hx: number, hz: number) {
    const bx = f.bx!, foot = Math.max(hx, hz), sd = Math.floor(f.s * 9973);
    const h = (i: number, j: number) => hash2(f.x * 7919 + bx * 31 + i * 101 + sd, f.y * 104729 + bx + j * 37);
    const look = BLAST_LOOK[f.bc ?? 0] ?? BLAST_LOOK[0];
    const base = [roof[0], roof[1] * 0.6, roof[2]];
    const tint = look.flash > 0 ? h(1, 1) : -(0.3 + 0.7 * h(1, 1));
    this.put(this.blastGlow, fi, base, [0, 0, 0, tint], [h(2, 1), 4.5 + 2 * h(2, 2) + 1.5 * foot, 0.3 + 0.25 * h(2, 3), 0]);
    this.put(this.blastGlow, fi, [roof[0], 0, roof[2]], [0, 0, 0, h(3, 4)], [h(3, 1), 3.2 + 1.8 * h(3, 2) + foot, 0.9 + 0.7 * h(3, 3), 1]);
    const balls = look.balls[0] + Math.floor(h(4, 1) * look.balls[1]);
    for (let i = 0; i < balls; i++) {
      const a = h(10 + i, 1) * Math.PI * 2, r = 0.4 + 1.0 * h(10 + i, 2);
      this.put(this.blastGlow, fi, base, [Math.cos(a), Math.sin(a), r * (0.6 + foot), 0.8 + 1.4 * h(10 + i, 3)], [h(10 + i, 4), 1.1 + 0.9 * h(10 + i, 5) + 0.4 * foot, 1.2 + 1.2 * h(10 + i, 6), look.ball]);
    }
    const height = (5 + 4 * h(5, 1) + foot) * look.column, puffs = 18 + Math.floor(h(5, 2) * 9);
    for (let i = 0; i < puffs; i++) {
      this.put(this.blastSmoke, fi, base, [(h(40 + i, 1) - 0.5) * hx * 0.9, (h(40 + i, 2) - 0.5) * hz * 0.9, height * (0.8 + 0.4 * h(40 + i, 3)), look.soot * (0.6 + 0.4 * h(40 + i, 7))],
        [h(40 + i, 4), 1.3 + 1.1 * h(40 + i, 5) + 0.4 * foot, 4 + 3 * h(40 + i, 6), 0]);
    }
    const bits = look.bits[0] + Math.floor(h(6, 1) * look.bits[1]), spread = h(6, 2) * Math.PI * 2, lop = 0.4 + 0.5 * h(6, 3); // the debris thrown more one way than the others
    for (let i = 0; i < bits && i + puffs < BLAST_SMOKE_MAX; i++) {
      const a = h(80 + i, 1) * Math.PI * 2, bias = Math.cos(a - spread) * lop;
      this.put(this.blastSmoke, fi, base, [a, foot + (1 + 2.5 * h(80 + i, 2)) * (1 + bias * 0.5) * look.throw, 0.8 + 1.4 * h(80 + i, 3), h(80 + i, 4)],
        [h(80 + i, 5), 0.12 + 0.16 * h(80 + i, 6), 0.7 + 0.9 * h(80 + i, 7), look.debris]);
    }
    // a wider scorch than the fire's own: the blast's reach, its outline its own
    const reach = foot + FIRE.blastReach * (0.45 + 0.25 * h(7, 1));
    this.put(this.scorch, fi, [roof[0], 0, roof[2]], [0, 0, reach, reach * (0.85 + 0.3 * h(7, 2))], [h(7, 3), 1, 1, fi]);
  }

  private put(p: Pool, fi: number, at: readonly number[], o: readonly number[], s: readonly number[]) {
    if (p.n >= p.P.length / 3) return;
    const i = p.n++;
    p.P.set(at, i * 3); p.O.set(o, i * 4); p.S.set(s, i * 4);
    this.owner.get(p)![i] = fi;
  }

  /**
   * Once a frame: each fire's flame strength, share burnt, the roof's share of it, smoke density and tone, scorch and
   * water from the game clock (`tick`, fractional), and the buildings again every couple of seconds (a chunk just
   * loaded shows its windows; a building that lost levels is lower).
   */
  frame(tick: number) {
    if (!this.fires.length) return;
    const t0 = performance.now();
    this.frames++;
    if (t0 - this.builtAt > 2500) this.rebuild();
    this.embers.mesh.visible = motion.level === 2 && this.embers.n > 0;
    if (motion.level === 0 && this.frames % 30 !== 0) return;
    if (motion.level === 1 && (this.frames & 1)) return;
    const T = TICKS_PER_HOUR, wall = t0 / 1000;
    const state = this.fires.map((f, fi) => {
      const d = fireProgress(f, tick);
      let flame = 0, smoke = 0, tone = 0, scorch = 0, water = 0;
      if (f.ph === FirePhase.Burning) {
        flame = 0.3 + 0.7 * Math.sqrt(d); smoke = 0.35 + 0.65 * Math.sqrt(d); tone = 0.05; scorch = 0.25 + 0.6 * d;
      } else if (f.ph === FirePhase.Fighting) {
        const k = Math.max(0, Math.min(1, (tick - f.ta) / Math.max(1, f.t1 - f.ta)));
        const at = 0.3 + 0.7 * Math.sqrt(f.d);
        flame = at * (1 - k) * (1 - k); smoke = (0.4 + 0.6 * Math.sqrt(f.d)) * (1 - 0.5 * k); tone = 0.25 + 0.65 * k; scorch = 0.25 + 0.6 * f.d;
        water = k < 0.92 ? 1 : (1 - k) / 0.08;
      } else {
        const k = Math.max(0, Math.min(1, (tick - f.t1) / (FIRE.aftermathHours * T)));
        const burnt = f.out === FireOutcome.Burnt;
        smoke = (burnt ? 0.45 : 0.18) * (1 - k) * (1 - k); tone = burnt ? 0.35 : 0.6;
        scorch = (burnt ? 0.95 : f.out === FireOutcome.Partial ? 0.6 : 0.35) * (1 - Math.max(0, k - 0.6) / 0.4);
      }
      // the roof's share: a fire with windows to burn at breaks through the roof as it takes hold; one without burns there from the start
      const roofShare = this.hasWindows[fi] ? Math.max(0, Math.min(1, (d - ROOF_FROM) / (ROOF_FULL - ROOF_FROM))) : 1;
      // an explosion: seconds since it blew on the wall clock, the column's strength and the debris's (fading with the scorch)
      let age = -1, column = 0, debris = 0;
      if (f.bx !== undefined) {
        const key = `${f.x},${f.y}@${f.bx}`;
        let at = this.blastAt.get(key);
        if (at === undefined) { at = tick - f.bx < BLAST_FRESH ? wall - Math.max(0, tick - f.bx) * TICK_MS / 1000 : -1e6; this.blastAt.set(key, at); }
        age = wall - at;
        const k = f.ph === FirePhase.Out ? Math.max(0, Math.min(1, (tick - f.t1) / (FIRE.aftermathHours * T))) : 0;
        column = f.ph === FirePhase.Out ? 0.7 * Math.pow(1 - k, 1.5) : f.ph === FirePhase.Fighting ? 0.8 : 1;
        debris = 1 - Math.max(0, k - 0.6) / 0.4;
      }
      return [flame, smoke, tone, scorch, d, roofShare, water, age, column, debris];
    });
    if (this.blastAt.size > 64) for (const k of [...this.blastAt.keys()].slice(0, 32)) this.blastAt.delete(k);
    this.state = state;
    this.write(this.flames, (st, I, j) => { I[j] = st[0]; I[j + 1] = st[4]; I[j + 2] = st[5]; I[j + 3] = Math.min(1, st[0] * 1.2); });
    this.write(this.panes, (st, I, j) => { I[j] = st[0]; I[j + 1] = st[4]; I[j + 2] = st[3]; });
    this.write(this.soot, (st, I, j) => { I[j + 1] = st[4]; I[j + 2] = st[3]; });
    this.write(this.glows, (st, I, j) => { I[j] = st[0]; });
    this.write(this.smoke, (st, I, j) => { I[j] = st[1]; I[j + 1] = st[2]; I[j + 2] = st[5]; I[j + 3] = st[4]; });
    if (motion.level === 2) this.write(this.embers, (st, I, j) => { I[j] = st[0]; I[j + 1] = st[4]; I[j + 2] = st[5]; });
    this.write(this.scorch, (st, I, j) => { I[j] = st[3]; });
    this.write(this.spray, (st, I, j) => { I[j] = st[6]; });
    if (this.blastGlow.n) this.write(this.blastGlow, (st, I, j) => { I[j] = st[7]; });
    if (this.blastSmoke.n) this.write(this.blastSmoke, (st, I, j) => { I[j] = st[7]; I[j + 1] = st[8]; I[j + 2] = st[9]; });
    this.lastMs = performance.now() - t0;
  }

  /** each fire's [flame, smoke, tone, scorch, share burnt, roof share, water, blast age (s), column, debris] this frame */
  private state: number[][] = [];
  private write(p: Pool, fn: (st: number[], I: Float32Array, j: number) => void) {
    const own = this.owner.get(p)!;
    for (let i = 0; i < p.n; i++) fn(this.state[own[i]], p.I, i * 4);
    (p.geo.getAttribute('aI') as InstancedBufferAttribute).needsUpdate = true;
  }
}
