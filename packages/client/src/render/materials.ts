import { MeshLambertMaterial, Texture, DataTexture, RedFormat, RGBAFormat, UnsignedByteType, NearestFilter, RepeatWrapping, Vector2, Vector4, Color } from 'three';
import { ROAD_CLASS_DEFS } from '@msimcity/shared';

/** Side of the data overlay's map (render/overlayMap.ts): one texel per tile, wrapped, so the streamed window (well under this) never needs re-centring. */
export const OVL_SIZE = 1024;
/** The data overlay's bytes (shared/src/issues.ts overlayByte, 0 no data) for the loaded chunks, texel (x mod OVL_SIZE, y mod OVL_SIZE). */
export const overlayTexture = (() => {
  const t = new DataTexture(new Uint8Array(OVL_SIZE * OVL_SIZE), OVL_SIZE, OVL_SIZE, RedFormat, UnsignedByteType);
  t.magFilter = t.minFilter = NearestFilter; t.wrapS = t.wrapT = RepeatWrapping; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
})();

/**
 * The power map (client/src/utilities.ts, docs/utilities.md section 4.5): one byte a tile, wrapped like the overlay's, how
 * dark the tile is for lack of power: 0 normal (supplied, or never connected), about 40 a brownout, 255 a cut or a fault.
 * The window shader reads it under each building and the street-lamp shader under each lamp.
 */
export const powerTexture = (() => {
  const t = new DataTexture(new Uint8Array(OVL_SIZE * OVL_SIZE), OVL_SIZE, OVL_SIZE, RedFormat, UnsignedByteType);
  t.magFilter = t.minFilter = NearestFilter; t.wrapS = t.wrapT = RepeatWrapping; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
})();

/**
 * Street lamps (render/roads.ts): one texel per tile, wrapped like the overlay's. R: the darkness at which the lamp
 * comes on (0: no lamp on this tile); G, B: where in the tile its light falls (under the head, out over the road);
 * A: flags, bit 0 dead, bit 1 sputtering, bit 2 a white LED lantern (else sodium-warm), bits 3-7 its brightness.
 * The ground and road shaders pool light from the lamps of the nine tiles round each fragment; the lamp heads glow
 * from the same bytes, so a lamp and its pool always agree.
 */
export const lampTexture = (() => {
  const t = new DataTexture(new Uint8Array(OVL_SIZE * OVL_SIZE * 4), OVL_SIZE, OVL_SIZE, RGBAFormat, UnsignedByteType);
  t.magFilter = t.minFilter = NearestFilter; t.wrapS = t.wrapT = RepeatWrapping; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
})();

/**
 * Uniforms shared by every scene material. uNight is 0 by day and 1 at night,
 * uHour is the game clock (0-24) and uTime is wall-clock seconds for flicker.
 * Everything driven by them is staggered per window / per lamp so nothing in
 * the city switches in lockstep.
 */
export const sceneUniforms = {
  uNight: { value: 0 },
  uHour: { value: 12 },
  /** the sun's height now (sine of its elevation, shared sunAt) and the hour the evening darkness falls (the sun 3 degrees up, set by the season): windows' glass and their evening schedules follow the year (docs/weather.md W5) */
  uElev: { value: 0 },
  uDusk: { value: 18 },
  /** the year phase 0..1 (shared seasonOf, or ?season=): trees leaf, turn and drop by it (render/seasons.ts) */
  uYear: { value: 0.1 },
  /** a multiplier on grass by the season (greener spring, yellower late summer, duller winter): xyz the colour, w the grey blend */
  uGrass: { value: new Vector4(1, 1, 1, 0) },
  uTime: { value: 0 },
  /** 1 while the congestion overlay is showing */
  uHeat: { value: 0 },
  /** 0 normal view, 1 underground view: the ground and buildings fade and cool in their own shaders (render/underground.ts) */
  uUnder: { value: 0 },
  /** 1: windows below a pixel draw their class's average (WINDOWS, far windows); 0 always draws every pane (for comparing) */
  uFarWin: { value: 1 },
  /** the data overlay (client/src/overlays.ts): 0 off, 1 a sequential ramp, 2 a diverging one; ground and buildings read uOvlMap */
  uOvl: { value: 0 },
  uOvlMap: { value: overlayTexture as Texture },
  /** 1 while the power map holds anything dark (utilities.ts): the shaders skip the read otherwise */
  uPow: { value: 0 },
  uPowMap: { value: powerTexture as Texture },
  /** what the congestion path paints on the roads: 0 traffic, 1 the power overlay's states (utilities.ts) */
  uHeatMode: { value: 0 },
  /** the street lamps' map (lampTexture) */
  uLampMap: { value: lampTexture as Texture },
  /** weather (render/weather.ts, docs/weather.md W2): wet ground 0..1, lying snow 0..1, cloud cover 0..1, the clouds' drift in tiles, the sky's colour and brightness (the wet roads' sheen) */
  uWet: { value: 0 },
  uSnow: { value: 0 },
  uCloud: { value: 0 },
  uWindOff: { value: new Vector2() },
  uSkyCol: { value: new Color(0.6, 0.7, 0.9) },
  uSkyLum: { value: 1 },
};
export const nightUniform = sceneUniforms.uNight;

/** Window schedule classes carried in the `aWin` vertex attribute. */
export const Win = { None: 0, Home: 1, Shop: 2, Office: 3, Civic: 4, Factory: 5, Venue: 6, Fire: 7, Beacon: 8, Sign: 9 } as const;

const HASH = /* glsl */ `float mscHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`;

/**
 * A failing lamp or tube (playtest f91d8841, "flickering lights on some streets": the old sputter was a hard strobe of 5% of
 * the lamps at three flashes a second, for ever, and a lamp's pool and its lantern strobed out of step). It is steady nearly
 * all of the time. Every 25 to 65 seconds, on a period and phase of its own per lamp, it stutters for about a second and a
 * half: two or three soft dips down to 40%, eased in and out, never faster than two a second and never a hard step. `seed` is
 * one number per lamp (mscLampSeed of its tile, so the pool on the road and the lantern agree), t is uTime.
 */
const FLUTTER = /* glsl */ `
float mscLampSeed(vec2 tile) { return fract(sin(dot(tile, vec2(12.9898, 78.233))) * 43758.5453); }
float mscFlutter(float seed, float t) {
  float per = 25.0 + 40.0 * fract(seed * 7.13);
  float u = fract(t / per + fract(seed * 3.77)) * per / 1.5;
  if (u >= 1.0) return 1.0;
  float dip = 0.5 + 0.5 * cos(u * (10.0 + 6.0 * fract(seed * 5.31)) + 3.14159);
  return 1.0 - 0.6 * sin(u * 3.14159) * dip * dip;
}`;

/**
 * Sky colour for the hour, in linear space: the same recipe as Lighting.update (night, day, dusk glow,
 * blue hour), so the glass reflects what the sky is doing without a new uniform. Keep the two in step.
 */
const SKY = /* glsl */ `
vec3 mscSky(float el) {
  float dayK = smoothstep(-0.22, 0.16, el);
  float duskK = exp(-(el / 0.2) * (el / 0.2)) * 0.8;
  float blueK = exp(-((el + 0.15) / 0.09) * ((el + 0.15) / 0.09));
  vec3 s = mix(vec3(0.0037, 0.0070, 0.0210), vec3(0.347, 0.552, 0.807), dayK);
  s = mix(s, vec3(0.745, 0.323, 0.133), duskK);
  return mix(s, vec3(0.025, 0.050, 0.168), blueK * 0.6);
}`;

const VERT_PARS = /* glsl */ `
attribute float aWin;
attribute float aTop;
attribute vec4 aFac;
attribute vec4 aCell;
uniform float uHour;
uniform float uElev;
varying float vWin;
varying float vTop;
varying vec4 vFac;
varying vec4 vCell;
varying vec3 vLocal;
varying vec3 vLocalN;
varying vec2 vOrigin;
varying vec3 vSky;
${SKY}`;

/** The power map's read (powerTexture): 0 normal, up to 1 dark, by tile; 0 without a read while nothing is dark. */
const POW_PARS = /* glsl */ `
uniform float uPow;
uniform sampler2D uPowMap;
float mscPowAt(vec2 tile) { return uPow > 0.5 ? texture2D(uPowMap, (mod(tile, ${OVL_SIZE}.0) + 0.5) / ${OVL_SIZE}.0).r : 0.0; }`;

const FRAG_PARS = /* glsl */ `
uniform float uNight;
uniform float uHour;
uniform float uDusk;
uniform float uTime;
uniform float uFarWin;
uniform float uWet;
uniform float uSnow;
uniform float uCloud;
varying float vWin;
varying float vTop;
varying vec4 vFac;
varying vec4 vCell;
varying vec3 vLocal;
varying vec3 vLocalN;
varying vec2 vOrigin;
varying vec3 vSky;
${HASH}
${FLUTTER}
${POW_PARS}
// coverage of [a, b] at x for a pixel footprint of half-width w (soft edge, so panes do not crawl)
float mscBand(float x, float a, float b, float w) { return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x); }
float mscRect(vec2 f, vec2 a, vec2 b, vec2 w) { return mscBand(f.x, a.x, b.x, w.x) * mscBand(f.y, a.y, b.y, w.y); }
// arched tall window: rectangle below y = 0.74, half-ellipse above, grown by g for frames
float mscArch(vec2 f, float hw, float g, float w) {
  float x = abs(f.x - 0.5);
  if (f.y < 0.74) return (1.0 - smoothstep(hw + g - w, hw + g + w, x)) * smoothstep(0.10 - g - w, 0.10 - g + w, f.y);
  vec2 e = vec2(x / (hw + g), (f.y - 0.74) / (0.17 + g));
  return 1.0 - smoothstep(1.0 - w * 6.0, 1.0 + w * 6.0, length(e));
}
vec3 mscCurtain(float k) {
  if (k < 0.2) return vec3(0.72, 0.60, 0.40);
  if (k < 0.4) return vec3(0.50, 0.12, 0.08);
  if (k < 0.55) return vec3(0.10, 0.17, 0.42);
  if (k < 0.7) return vec3(0.12, 0.33, 0.17);
  if (k < 0.83) return vec3(0.65, 0.42, 0.06);
  if (k < 0.93) return vec3(0.30, 0.09, 0.22);
  return vec3(0.80, 0.80, 0.77);
}
vec3 mscSignboard(float k) {
  if (k < 0.18) return vec3(0.45, 0.04, 0.04);
  if (k < 0.36) return vec3(0.04, 0.08, 0.30);
  if (k < 0.52) return vec3(0.05, 0.25, 0.12);
  if (k < 0.68) return vec3(0.70, 0.62, 0.45);
  if (k < 0.84) return vec3(0.60, 0.40, 0.05);
  return vec3(0.06, 0.06, 0.07);
}
// What lights a room of class cls: k picks within the class's mix, h2 and h4 the odd variation; lamp is set for a dim
// lamp in the corner rather than the main light.
vec3 mscGlow(float cls, float k, float h2, float h4, out float lamp) {
  vec3 glow; lamp = 0.0;
  if (cls < 1.5 || cls > 5.5) {
    // homes and venues: tungsten, soft white, a cooler LED, a lamp in the corner, the odd coloured one
    if (k < 0.36) glow = vec3(1.0, 0.72, 0.42);
    else if (k < 0.62) glow = vec3(1.0, 0.85, 0.64);
    else if (k < 0.80) glow = vec3(0.86, 0.92, 1.0);
    else if (k < 0.95) { glow = vec3(1.0, 0.6, 0.3); lamp = 1.0; }
    else glow = mix(vec3(0.95, 0.3, 0.75), vec3(0.35, 0.9, 0.5), step(0.5, h4));
    if (cls > 5.5 && h4 < 0.3) glow = mix(vec3(1.0, 0.35, 0.25), vec3(0.6, 0.35, 1.0), step(0.5, h2)); // stage colour
  } else if (cls < 2.5) {
    // shops: bright display LEDs, warm boutique spots, the odd neon-coloured window
    if (k < 0.2) glow = vec3(1.0, 0.8, 0.55);
    else if (k < 0.55) glow = vec3(1.0, 0.94, 0.84);
    else if (k < 0.88) glow = vec3(0.86, 0.93, 1.0);
    else glow = mix(vec3(1.0, 0.25, 0.55), vec3(0.3, 0.8, 1.0), step(0.5, h4));
  } else if (cls < 4.5) {
    // offices and civic: fluorescent tubes and panel LEDs, a manager's desk lamp here and there
    if (k < 0.12) { glow = vec3(1.0, 0.78, 0.5); lamp = step(0.5, h2); }
    else if (k < 0.5) glow = vec3(0.88, 1.0, 0.93);
    else glow = vec3(0.84, 0.91, 1.0);
  } else {
    // works: sodium and mercury floods, some tubes
    if (k < 0.4) glow = vec3(1.0, 0.62, 0.26);
    else if (k < 0.75) glow = vec3(0.76, 0.96, 0.86);
    else glow = vec3(0.92, 0.97, 1.0);
  }
  return glow;
}
// The evening follows the sun (docs/weather.md W5): lights come on at the dusk of the season (the sun 3 degrees up) rather than at a clock
// hour, so in winter the early dark finds homes lit from about 16:00 and in summer they wait for 20:15; people stay up a little later
// while the light lasts. Occupancy (who is home, who has gone to bed) stays by the hour.
float mscOnAt(float on) { return min(on, uDusk - 0.5 + (on - 16.0) * 0.6); }
float mscOffAt(float off) { return off < 39.0 ? off + clamp((uDusk - 18.0) * 0.45, -1.2, 1.5) : off; }
// The share of a class's panes lit at hour t (12..36) in a building of personality bld, for the far windows: the
// expectation of the per-pane schedule in WINDOWS (darkness threshold, on, off or all night, early start, vacancy,
// the odd blinker). Keep the numbers in step with it.
float mscLitShare(float cls, float t, float bld) {
  float onA, onB, offA, offB, offP, alln, wA, wB, mornP, vac;
  if (cls < 1.5)      { onA = 16.5; onB = 4.0; offA = 21.0; offB = 5.5; offP = 1.4; alln = 0.08; wA = 29.5; wB = 2.5; mornP = 0.6;  vac = 0.32; }
  else if (cls < 2.5) { onA = 16.0; onB = 2.5; offA = 19.5; offB = 5.0; offP = 1.0; alln = 0.12; wA = 31.0; wB = 2.0; mornP = 0.35; vac = 0.28; }
  else if (cls < 3.5) { onA = 16.0; onB = 1.5; offA = 17.8; offB = 4.5; offP = 2.0; alln = 0.07; wA = 30.5; wB = 2.0; mornP = 0.70; vac = 0.25; }
  else if (cls < 4.5) { onA = 16.0; onB = 1.0; offA = 22.0; offB = 6.0; offP = 1.0; alln = 0.45; wA = 29.0; wB = 3.0; mornP = 0.80; vac = 0.18; }
  else if (cls < 5.5) { onA = 16.0; onB = 3.0; offA = 18.0; offB = 4.0; offP = 1.0; alln = 0.30; wA = 29.0; wB = 2.0; mornP = 0.50; vac = 0.42; }
  else                { onA = 16.2; onB = 2.0; offA = 22.8; offB = 2.2; offP = 1.0; alln = 0.05; wA = 34.0; wB = 2.0; mornP = 0.04; vac = 0.12; }
  offA += (bld - 0.5) * 1.5;
  wA += (bld - 0.5) * 1.0;
  onA = mscOnAt(onA); offA = mscOffAt(offA);
  float eve = clamp((t - onA) / onB, 0.0, 1.0) * (alln + (1.0 - alln) * (1.0 - pow(clamp((t - offA) / offB, 0.0, 1.0), 1.0 / offP)));
  float morn = clamp((t - wA) / wB, 0.0, 1.0) * mornP;
  float dark = clamp((uNight - 0.04 - 0.4 * bld) / 0.55, 0.0, 1.0);
  return (1.0 - vac) * dark * (eve + morn - eve * morn) * 0.965;
}`;

/**
 * Windows, drawn on one grid (7 by 5 cells per unit) by day and by night.
 *
 * By day every window-class face shows glazing: dark panes in a frame and sill a little lighter than the
 * wall, reflecting the sky more the more obliquely they are seen (a cheap Fresnel), with each window
 * drawing its own hand (curtains in a few colours, blinds half down, the odd open sash, reflection
 * brightness). The class decides the layout: homes get small sashes with sills, shops a full-height ground
 * floor under a signboard, offices curtain-wall bands with mullions and spandrels (ribbon windows when the
 * wall is not glass), civic buildings tall arched windows, venues tall plain ones and factories only a
 * clerestory strip under the eaves. Past a distance where a cell is smaller than a few pixels the detail
 * fades to the class average so nothing shimmers. Further out, where a cell is about a pixel, the wall skips the
 * per-pane hands: by day it draws the class's expected look, by night each pane is only lit or not at the class's lit
 * share for the hour (mscLitShare) in one of its lights (mscGlow), from two hashes instead of eight. Each building
 * fades over to it at its own distance.
 *
 * At dusk the glazing hands over to the lit-window logic below: each pane keeps its own hours, a
 * darkness level at which it switches on, a bedtime or closing time, maybe an early start, maybe a night
 * owl, a TV flickering, a vacancy. Whole buildings share a personality offset so households differ as well
 * as rooms. The light itself varies too: homes lean to tungsten and soft white with some cooler LEDs, corner lamps
 * (more of them late in the evening, when the big light goes off) and the odd coloured room; shops mix display
 * LEDs with warm spots and a little neon; offices burn fluorescent and panel LEDs with the odd failing tube; works
 * use sodium and mercury. Each building leans warm or cool as a whole, and drawn curtains and blinds tint and dim
 * what shows through them. Unlit panes stay dark glass.
 *
 * `aWin` carries the class and `aTop` the height of the box (Kit.add), which is how a factory knows where
 * its eaves are.
 *
 * Facade boxes (shared buildings/facade.ts, docs/buildings.md "Facades") skip the fixed grid: the kit splits their
 * walls into one quad per storey × bay cell, `aFac` carries the position across the cell, its mode and wall, and
 * `aCell` its bay, storey and size, so exactly one window is drawn centred in each cell. Modes add glazed doors
 * (behind balconies), shopfronts, garage doors and bay-window panes, and plain cells draw nothing. facade.ts RECT
 * mirrors the layouts below for buildings:check; keep the two in step.
 */
const WINDOWS = /* glsl */ `
if (vWin > 8.5) {
  // Win.Sign: a lit logo or screen (shared buildings/media.ts). It comes on at a dusk time of its own per building and
  // breathes a little on a slow phase of its own per part, so no two broadcasters' signs light or pulse together
  float hs = mscHash(floor(vOrigin * 4.0) + 9.1);
  float on = smoothstep(0.12 + 0.3 * hs, 0.3 + 0.3 * hs, uNight);
  float br = 0.9 + 0.1 * sin(uTime * (0.6 + hs) + dot(floor(vLocal.xz * 10.0), vec2(2.3, 5.9)));
  totalEmissiveRadiance += diffuseColor.rgb * br * (0.25 + 1.25 * on);
} else if (vWin > 7.5) {
  // Win.Beacon: a red aviation light on a mast or a roof corner (shared buildings/media.ts). Each building and each light
  // blinks on its own period and phase, a short flash with a soft tail, brighter after dark
  float hb = mscHash(floor(vOrigin * 4.0) + floor(vLocal.xz * 9.0 + vLocal.y * 3.0) * 0.37 + 2.1);
  float per = 1.1 + 0.9 * hb;
  float ph = fract(uTime / per + hb * 7.3);
  float flash = smoothstep(0.0, 0.04, ph) * (1.0 - smoothstep(0.14 + 0.1 * hb, 0.32 + 0.1 * hb, ph));
  totalEmissiveRadiance += diffuseColor.rgb * (0.08 + flash * (0.5 + 2.4 * min(1.0, uNight * 1.6)));
} else if (vWin > 6.5) {
  // Win.Fire: a camp fire or a lantern (shared buildings/camp.ts). The whole box glows, faintly by day and fully from
  // dusk, and flickers on a phase of its own per building and per part, so no two camps (or lamps) pulse together
  float ph = mscHash(floor(vOrigin * 4.0) + 5.3) * 40.0 + dot(floor(vLocal.xz * 12.0), vec2(3.1, 7.7));
  float fl = 0.74 + 0.16 * sin(uTime * 7.3 + ph) + 0.1 * sin(uTime * 12.7 + ph * 1.7) * sin(uTime * 3.1 + ph * 0.6);
  totalEmissiveRadiance += diffuseColor.rgb * fl * (0.18 + 1.5 * min(1.0, uNight * 1.6));
} else if (vWin > 0.5) {
  vec2 g = vec2(0.0);
  float wall = 0.0;
  if (abs(vLocalN.x) > 0.7) { g = vec2(vLocal.z, vLocal.y); wall = 1.0; }
  else if (abs(vLocalN.z) > 0.7) { g = vec2(vLocal.x, vLocal.y); wall = 1.0; }
  // facade boxes (shared buildings/facade.ts): aFac.z is the cell mode, 0 on everything else (the legacy grid)
  float fmode = floor(vFac.z + 0.5);
  bool fac = fmode > 1.5;
  if (fmode > 0.5 && fmode < 1.5) wall = 0.0; // plain facade wall: margins, top band, behind a door or a bay window
  if (wall > 0.5) {
    float cls = floor(vWin + 0.5);
    float top = vTop;
    vec2 freq = vec2(7.0, 5.0);
    vec2 gg = g * freq;
    vec2 cell = floor(gg);
    vec2 f = fract(gg);
    vec2 fw = fwidth(gg);
    if (fac) { f = vFac.xy; fw = fwidth(vFac.xy); cell = vec2(vCell.x + vFac.w * 32.0, vCell.y); }
    float ground = abs(cell.y) < 0.5 ? 1.0 : 0.0;
    // layout: 1 sash (homes, and shops above the ground floor), 2 shopfront, 3 office, 4 civic, 5 factory, 6 venue,
    // 7 glazed door (behind a balcony), 8 bay-window pane, 9 garage door (facade.ts RECT mirrors these)
    float lay = cls;
    if (!fac) lay = (cls < 1.5 || (cls < 2.5 && ground < 0.5)) ? 1.0 : cls < 2.5 ? 2.0 : cls;
    else if (fmode < 2.5) lay = cls < 2.5 ? 1.0 : cls;
    else if (fmode < 3.5) lay = 7.0;
    else if (fmode < 4.5) lay = 2.0;
    else if (fmode < 5.5) lay = 9.0;
    else lay = 8.0;
    if (fac) {
      // a cell wider than its window should be squeezes the window across (facade.ts squeezeOf): pane w, pane h, widest w/h
      vec3 pa = lay < 1.5 ? (cls < 1.5 ? vec3(0.46, 0.48, 0.75) : vec3(0.60, 0.48, 0.75))
        : abs(lay - 4.0) < 0.5 ? vec3(0.40, 0.81, 0.5) : abs(lay - 6.0) < 0.5 ? vec3(0.56, 0.84, 0.6) : abs(lay - 7.0) < 0.5 ? vec3(0.40, 0.78, 0.6) : vec3(0.0);
      if (pa.z > 0.0 && vCell.w > 0.0) { float k = max(1.0, pa.x * vCell.z / (pa.y * vCell.w) / pa.z); f.x = 0.5 + (f.x - 0.5) * k; fw.x *= k; }
    }
    vec2 w = clamp(fw * 0.5, 0.002, 0.2);
    float dst = smoothstep(0.18, 0.5, max(fw.x, fw.y)); // 0 near, 1 where a cell is only a few pixels
    vec3 wallC = diffuseColor.rgb;
    vec2 bseed = floor(vOrigin * 4.0);
    float bld = mscHash(bseed + 0.37);
    // far windows: from about a cell a pixel each pane is below a pixel and drawing it only aliases, so the wall takes
    // its class's average look instead (the block after the panes), faded in over a band that each building starts
    // at its own distance
    float farK = uFarWin * smoothstep(0.55, 1.0, max(fw.x, fw.y) * (0.85 + 0.3 * bld));
    vec3 em0 = totalEmissiveRadiance;
    float pane = 0.0, frm = 0.0, sill = 0.0, spand = 0.0, sgn = 0.0, gar = 0.0;
    float meanPane = 0.22, refl0 = 0.10, yTop = 0.0, litK = 1.0; // litK: big panes glow less per area
    vec2 pu = vec2(0.5);
    bool glassy = false;
    bool houseLike = false;
    if (lay < 1.5) {
      // homes, and the floors above a shop: a sash with a frame and a sill
      houseLike = true;
      vec2 a = cls < 1.5 ? vec2(0.27, 0.32) : vec2(0.20, 0.32);
      vec2 b = cls < 1.5 ? vec2(0.73, 0.80) : vec2(0.80, 0.80);
      pane = mscRect(f, a, b, w);
      frm = clamp(mscRect(f, a - vec2(0.05, 0.045), b + vec2(0.05, 0.035), w) - pane, 0.0, 1.0);
      sill = mscRect(f, vec2(0.17, 0.235), vec2(0.83, 0.30), w);
      pu = (f - a) / (b - a);
      meanPane = 0.22; yTop = 0.84;
    } else if (lay < 2.5) {
      // shopfront: glazing almost the full cell, a signboard above it
      vec2 a = vec2(0.03, 0.07), b = vec2(0.97, 0.68);
      pane = mscRect(f, a, b, w);
      frm = clamp(mscRect(f, a - vec2(0.03, 0.04), b + vec2(0.03, 0.03), w) - pane, 0.0, 1.0);
      sgn = mscRect(f, vec2(0.0, 0.74), vec2(1.0, 0.97), w);
      pu = (f - a) / (b - a);
      meanPane = 0.38; refl0 = 0.12; litK = 0.55;
    } else if (lay < 3.5) {
      glassy = wallC.b - wallC.r > 0.2;
      if (glassy) {
        // curtain wall: spandrel panel below, glass above, mullions at the cell edges
        vec2 a = vec2(0.07, 0.25), b = vec2(0.93, 1.0);
        pane = mscRect(f, a, b, w);
        float run = mscRect(f, vec2(0.0, 0.22), vec2(1.0, 1.0), w);
        frm = clamp(run - pane, 0.0, 1.0);
        spand = 1.0 - mscBand(f.y, 0.22, 1.5, w.y);
        pu = (f - a) / (b - a);
        meanPane = 0.52; refl0 = 0.30; litK = 0.6;
      } else {
        // ribbon windows between piers
        vec2 a = vec2(0.07, 0.30), b = vec2(0.93, 0.84);
        pane = mscRect(f, a, b, w);
        frm = clamp(mscRect(f, a - vec2(0.04, 0.04), b + vec2(0.04, 0.03), w) - pane, 0.0, 1.0);
        sill = mscRect(f, vec2(0.03, 0.235), vec2(0.97, 0.29), w);
        pu = (f - a) / (b - a);
        meanPane = 0.36; refl0 = 0.20; yTop = 0.88; litK = 0.8;
      }
    } else if (lay < 4.5) {
      // civic: tall arched windows
      pane = mscArch(f, 0.20, 0.0, w.x);
      frm = clamp(mscArch(f, 0.20, 0.045, w.x) - pane, 0.0, 1.0);
      sill = mscRect(f, vec2(0.24, 0.045), vec2(0.76, 0.095), w);
      pu = vec2((f.x - 0.3) / 0.4, (f.y - 0.1) / 0.81);
      meanPane = 0.30; refl0 = 0.12; yTop = 0.96; litK = 0.8;
    } else if (lay < 5.5) {
      if (fac) {
        // factory facade: a strip window high in each cell
        vec2 a = vec2(0.04, 0.55), b = vec2(0.96, 0.82);
        pane = mscRect(f, a, b, w);
        frm = clamp(mscRect(f, a - vec2(0.0, 0.03), b + vec2(0.0, 0.03), w) - pane, 0.0, 1.0);
        pu = (f - a) / (b - a);
      } else if (top > 0.2) {
        // factory: a clerestory strip just under the eaves, and nothing else
        float fy = (g.y - (top - 0.15)) / 0.10;
        float wy = clamp(fw.y * 0.5 / (freq.y * 0.10), 0.002, 0.3);
        cell.y = floor((top - 0.1) * freq.y);
        pane = mscBand(f.x, 0.04, 0.96, w.x) * mscBand(fy, 0.0, 1.0, wy);
        frm = clamp(mscBand(f.x, 0.0, 1.0, w.x) * mscBand(fy, -0.22, 1.22, wy) - pane, 0.0, 1.0);
        pu = vec2(f.x, fy);
      }
      meanPane = 0.10; refl0 = 0.14; litK = 0.85;
    } else if (lay < 6.5) {
      // venues: tall plain windows
      vec2 a = vec2(0.22, 0.08), b = vec2(0.78, 0.92);
      pane = mscRect(f, a, b, w);
      frm = clamp(mscRect(f, a - vec2(0.05, 0.035), b + vec2(0.05, 0.035), w) - pane, 0.0, 1.0);
      sill = mscRect(f, vec2(0.16, 0.015), vec2(0.84, 0.07), w);
      pu = (f - a) / (b - a);
      meanPane = 0.45; refl0 = 0.14; yTop = 0.96; litK = 0.85;
    } else if (lay < 7.5) {
      // glazed door onto a balcony: tall, from the floor
      houseLike = cls < 2.5;
      vec2 a = vec2(0.30, 0.02), b = vec2(0.70, 0.80);
      pane = mscRect(f, a, b, w);
      frm = clamp(mscRect(f, a - vec2(0.04, 0.02), b + vec2(0.04, 0.03), w) - pane, 0.0, 1.0);
      pu = (f - a) / (b - a);
      meanPane = 0.25; refl0 = 0.14; litK = 0.9;
    } else if (lay < 8.5) {
      // bay window: glazing across the cell in three lights
      houseLike = cls < 2.5;
      vec2 a = vec2(0.10, 0.14), b = vec2(0.90, 0.86);
      pane = mscRect(f, a, b, w);
      pu = (f - a) / (b - a);
      frm = clamp(mscRect(f, a - vec2(0.04, 0.04), b + vec2(0.04, 0.04), w) - pane, 0.0, 1.0);
      frm = max(frm, pane * (mscBand(pu.x, 0.32, 0.35, w.x * 2.0) + mscBand(pu.x, 0.65, 0.68, w.x * 2.0)));
      sill = mscRect(f, vec2(0.06, 0.08), vec2(0.94, 0.12), w);
      meanPane = 0.45; refl0 = 0.14; litK = 0.8;
    } else {
      // garage: a ribbed door, no glazing
      vec2 a = vec2(0.16, 0.0), b = vec2(0.84, 0.70);
      gar = mscRect(f, a, b, w);
      frm = clamp(mscRect(f, a - vec2(0.04, 0.0), b + vec2(0.04, 0.04), w) - gar, 0.0, 1.0);
      pu = (f - a) / (b - a);
      meanPane = 0.0;
    }
    // a window the roofline would cut in half is left out rather than drawn clipped (the legacy grid only: facade cells fit their wall)
    if (!fac && top > 0.01 && yTop > 0.0 && (cell.y + yTop) / freq.y > top + 0.004) { pane = 0.0; frm = 0.0; sill = 0.0; }

    if ((pane + frm + sill + spand + sgn + gar > 0.002 || dst > 0.01) && farK < 0.999) {
      vec2 seed = cell * 1.3 + bseed * 7.1 + floor(vLocalN.xz * 2.0) * 13.7;
      float h1 = mscHash(seed), h2 = mscHash(seed + 1.7), h3 = mscHash(seed + 3.9), h4 = mscHash(seed + 5.3);
      float h5 = mscHash(seed + 7.7), h6 = mscHash(seed + 9.1), h7 = mscHash(seed + 11.3), h8 = mscHash(seed + 13.1);

      // ---- by day: glazing ----
      float nr = 1.0 - dst;
      float dA = fract(h1 * 17.31 + h2 * 5.77), dB = fract(h3 * 13.17 + h4 * 7.31), dC = fract(h5 * 11.73 + h8 * 9.19), dD = fract(h6 * 3.77 + h4 * 6.13);
      vec3 glassC = glassy ? wallC * 0.28 : vec3(0.022, 0.030, 0.042) + wallC * 0.05;
      vec3 paneC = glassC;
      vec3 shade = vec3(1.0); // at night: the room light as it comes through curtains or blinds
      float rf = (0.65 + 0.7 * dD) * (0.8 + 0.4 * clamp(pu.y, 0.0, 1.0));
      if (houseLike) {
        if (dA < 0.30) {            // curtains drawn to the sides, a valance on top
          float cm = clamp(step(pu.x, 0.36) + step(0.64, pu.x) + step(0.86, pu.y), 0.0, 1.0);
          paneC = mix(paneC, mscCurtain(dC) * (0.78 + 0.22 * sin(pu.x * 55.0)), cm);
          shade = mix(vec3(1.0), mscCurtain(dC) * 1.25 + 0.08, cm * nr);
          rf *= 1.0 - cm;
        } else if (dA < 0.52) {     // blinds part way down
          float bm = step(1.0 - (0.25 + 0.5 * dB), pu.y);
          paneC = mix(paneC, vec3(0.62, 0.58, 0.50) * (0.82 + 0.18 * step(0.5, fract(pu.y * 11.0))), bm);
          shade = mix(vec3(1.0), vec3(0.5, 0.47, 0.4) * (0.6 + 0.4 * step(0.5, fract(pu.y * 11.0))), bm * nr);
          rf *= 1.0 - bm;
        } else if (dA < 0.58) {     // an open sash: dark room on one side, the swung pane catching the sky
          float hv = step(pu.x, 0.5);
          paneC = mix(paneC, vec3(0.006, 0.007, 0.009), hv);
          rf *= (1.0 - hv) * 1.6;
        }
        if (cls < 1.5 && dB < 0.45) frm = max(frm, pane * mscBand(pu.x, 0.47, 0.53, w.x * 2.0));
      } else if (abs(lay - 2.0) < 0.5) {
        if (dA < 0.40) { paneC = vec3(0.12, 0.085, 0.05) * (0.5 + 0.9 * pu.y); rf *= 0.5; } // the shop behind the glass
      } else if (abs(lay - 3.0) < 0.5) {
        if (dA < 0.20) {
          float bm = step(1.0 - (0.2 + 0.6 * dB), pu.y);
          paneC = mix(paneC, vec3(0.62, 0.62, 0.65), bm);
          shade = mix(vec3(1.0), vec3(0.55) * (0.6 + 0.4 * step(0.5, fract(pu.y * 13.0))), bm * nr);
          rf *= 1.0 - bm;
        }
      }
      vec3 frameC = wallC + (1.0 - wallC) * 0.32 + 0.02;
      vec3 sillC = wallC + (1.0 - wallC) * 0.5 + 0.04;
      vec3 base = wallC;
      float spandM = abs(lay - 3.0) < 0.5 ? mix(spand, 0.24, dst) : 0.0;
      base = mix(base, wallC * 0.55 + vec3(0.004, 0.008, 0.014), spandM);
      base = mix(base, frameC, clamp(frm, 0.0, 1.0) * nr);
      base = mix(base, sillC, sill * nr);
      if (gar > 0.002 || (dst > 0.01 && lay > 8.5)) base = mix(base, vec3(0.50, 0.52, 0.55) * (0.86 + 0.14 * step(0.5, fract(pu.y * 9.0))), mix(gar, 0.45, dst));
      vec3 signC = vec3(0.0);
      if (sgn > 0.002 && nr > 0.01) {
        signC = mscSignboard(bld);
        float marks = step(0.80, f.y) * step(f.y, 0.92) * step(0.15, f.x) * step(f.x, 0.85) * step(0.45, mscHash(vec2(floor(g.x * 42.0), floor(bld * 50.0))));
        base = mix(base, mix(signC, vec3(0.85, 0.80, 0.65), marks), sgn * nr);
      }
      float pd = mix(pane, meanPane, dst);
      base = mix(base, paneC, pd);
      diffuseColor.rgb = base;
      {
        vec3 nrm = normalize(normal);
        float ndv = clamp(dot(nrm, normalize(vViewPosition)), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 3.0);
        totalEmissiveRadiance += (vSky + vec3(0.012, 0.016, 0.030)) * (refl0 + (1.0 - refl0) * 0.9 * fres) * rf * pd;
      }

      // ---- by night: lit windows ----
      if (uNight > 0.001 && (pane + sgn) > 0.002) {
        float t = uHour < 12.0 ? uHour + 24.0 : uHour; // 12..36 so the night is one continuous span
        float on, off, wake, mornP, vac, coolP;
        if (cls < 1.5)      { on = 16.5 + 4.0 * h5; off = 21.0 + 5.5 * pow(h2, 1.4); if (h3 < 0.08) off = 40.0; wake = 29.5 + 2.5 * h4; mornP = 0.6;  vac = 0.32; coolP = 0.15; }
        else if (cls < 2.5) { on = 16.0 + 2.5 * h5; off = 19.5 + 5.0 * h2;           if (h3 < 0.12) off = 40.0; wake = 31.0 + 2.0 * h4; mornP = 0.35; vac = 0.28; coolP = 0.50; }
        else if (cls < 3.5) { on = 16.0 + 1.5 * h5; off = 17.8 + 4.5 * h2 * h2;      if (h3 < 0.07) off = 40.0; wake = 30.5 + 2.0 * h4; mornP = 0.70; vac = 0.25; coolP = 0.85; }
        else if (cls < 4.5) { on = 16.0 + 1.0 * h5; off = 22.0 + 6.0 * h2;           if (h3 < 0.45) off = 40.0; wake = 29.0 + 3.0 * h4; mornP = 0.80; vac = 0.18; coolP = 0.75; }
        else if (cls < 5.5) { on = 16.0 + 3.0 * h5; off = 18.0 + 4.0 * h2;           if (h3 < 0.30) off = 40.0; wake = 29.0 + 2.0 * h4; mornP = 0.50; vac = 0.42; coolP = 0.70; }
        else                { on = 16.2 + 2.0 * h5; off = 22.8 + 2.2 * h2;           if (h3 < 0.05) off = 40.0; wake = 34.0 + 2.0 * h4; mornP = 0.04; vac = 0.12; coolP = 0.25; } // venues: lit for the evening shows, dark after the late one
        off += (bld - 0.5) * 1.5;
        wake += (bld - 0.5) * 1.0;
        on = mscOnAt(on); off = mscOffAt(off);
        float onThr = clamp(0.05 + 0.55 * h1 + 0.4 * bld, 0.03, 0.98);
        float dark = smoothstep(onThr - 0.05, onThr + 0.03, uNight);
        float eve = smoothstep(on - 0.15, on + 0.15, t) * (1.0 - smoothstep(off - 0.2, off + 0.2, t));
        float morn = smoothstep(wake - 0.2, wake + 0.2, t) * step(h8 * 0.7 + h5 * 0.3, mornP);
        float lit = step(vac, h6) * dark * max(eve, morn);
        if (h7 < 0.07) lit *= step(0.5, fract(uTime / (25.0 + 40.0 * h2) + h4));
        float tv = step(0.07, h7) * step(h7, 0.2) * step(cls, 1.5);
        float flick = 1.0 - tv * 0.4 * (0.5 + 0.5 * sin(uTime * 2.1 + h4 * 60.0)) * (0.5 + 0.5 * sin(uTime * 5.3 + h2 * 90.0));
        // what lights the room: each building leans warm or cool (bld2) and each pane picks within its class's mix
        float bld2 = mscHash(bseed + 2.71);
        float k = clamp(h8 * 0.72 + bld2 * 0.28 + (coolP - 0.5) * 0.2, 0.0, 0.999);
        float lamp;
        vec3 glow = mscGlow(cls, k, h2, h4, lamp);
        // late in the evening the big light goes off in a home and a lamp stays on
        if (cls < 1.5 && lamp < 0.5 && t > 22.0 + 2.5 * h3 && h4 > 0.45) { glow = vec3(1.0, 0.62, 0.32); lamp = 1.0; }
        glow = mix(glow, vec3(0.45, 0.62, 1.0), tv * 0.75);
        // a dim lamp: weaker, and pooled around where it stands in the room
        float lampK = 1.0;
        if (lamp > 0.5) {
          vec2 lp = vec2(0.15 + 0.7 * h2, 0.15);
          lampK = mix(0.42, 0.22 + 0.6 * (1.0 - smoothstep(0.0, 0.9, distance(clamp(pu, 0.0, 1.0), lp))), nr);
        }
        // a failing tube stutters now and then (mscFlutter: steady, a soft stutter every half minute or so)
        if (cls > 2.5 && cls < 4.5 && h7 > 0.975) flick *= mscFlutter(h4 * 91.0 + h2, uTime);
        glow *= shade * lampK;
        float gain = lit * flick * (0.85 + 0.5 * h5) * min(1.0, uNight * 1.6) * 1.8 * litK * (litK < 0.99 ? 0.75 + 0.5 * clamp(pu.y, 0.0, 1.0) : 1.0);
        // power (client utilities.ts, docs/utilities.md 4.5): in a cut a candle burns in a few rooms (warm, flickering on its own
        // phase) and the odd building runs a generator (bright and steady); a brownout dims the rest, steadily
        float pk = mscPowAt(floor(vOrigin));
        if (pk > 0.004) {
          float gen = step(mscHash(bseed + 4.4), 0.06);
          if (pk > 0.5) {
            gain *= gen + (1.0 - gen) * step(h3, 0.12) * (0.28 + 0.12 * sin(uTime * 8.0 + h4 * 40.0) + 0.06 * sin(uTime * 17.0 + h2 * 20.0));
            glow = mix(glow, vec3(1.0, 0.56, 0.22), 1.0 - gen);
          } else gain *= 1.0 - pk * (0.8 + 0.1 * sin(uTime * 0.6 + h2 * 30.0)); // a steady dim with a slow breath, no flicker
        }
        totalEmissiveRadiance += glow * gain * pane;
        // an open shop lights its signboard a little
        totalEmissiveRadiance += signC * gain * sgn * 0.35 * nr;
      }
    }

    if (farK > 0.001) {
      // ---- far windows: by day the panes above averaged over the wall, as they come out where a cell is a pixel or two
      // (dst = 1: frames, sills and signs gone, glazing at the class's mean, curtains, blinds and shop interiors at their
      // expected share), so the fade band does not show. Mirrors the layouts and hands above; keep the two in step.
      bool gls = abs(lay - 3.0) < 0.5 && wallC.b - wallC.r > 0.2;
      bool hl = lay < 1.5 || (lay > 6.5 && lay < 8.5 && cls < 2.5);
      // per layout: the day mean, reflectance head-on and the night gain per area (meanPane, refl0, litK)
      vec3 lp = lay < 1.5 ? vec3(0.22, 0.10, 1.0)
        : lay < 2.5 ? vec3(0.38, 0.12, 0.55)
        : lay < 3.5 ? (gls ? vec3(0.52, 0.30, 0.6) : vec3(0.36, 0.20, 0.8))
        : lay < 4.5 ? vec3(0.30, 0.12, 0.8)
        : lay < 5.5 ? vec3(0.10, 0.14, 0.85)
        : lay < 6.5 ? vec3(0.45, 0.14, 0.85)
        : lay < 7.5 ? vec3(0.25, 0.14, 0.9)
        : lay < 8.5 ? vec3(0.45, 0.14, 0.8)
        : vec3(0.0);
      vec3 glassC = gls ? wallC * 0.28 : vec3(0.022, 0.030, 0.042) + wallC * 0.05;
      vec3 paneC = glassC;
      float rfm = 1.0;
      if (hl) { paneC = glassC * 0.662 + vec3(0.1415, 0.1182, 0.0977); rfm = 0.65; }
      else if (abs(lay - 2.0) < 0.5) { paneC = glassC * 0.6 + vec3(0.0456, 0.0324, 0.019); rfm = 0.8; }
      else if (abs(lay - 3.0) < 0.5) { paneC = glassC * 0.9 + vec3(0.062, 0.062, 0.065); rfm = 0.9; }
      vec3 fb = wallC;
      if (abs(lay - 3.0) < 0.5) fb = mix(fb, wallC * 0.55 + vec3(0.004, 0.008, 0.014), 0.24);
      if (lay > 8.5) fb = mix(fb, vec3(0.50, 0.52, 0.55) * 0.93, 0.45);
      fb = mix(fb, paneC, lp.x);
      float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
      vec3 fe = (vSky + vec3(0.012, 0.016, 0.030)) * (lp.y + (1.0 - lp.y) * 0.9 * fres) * rfm * lp.x;
      if (uNight > 0.001 && pane > 0.002) {
        // by night each pane still decides for itself, so lit windows keep their speckle (an average reads as a flat
        // glow), but from two hashes rather than the hands above: lit or not (the class's lit share at this hour,
        // mscLitShare, drawn from the panes the near drawing leaves occupied, h6) and which light
        float t = uHour < 12.0 ? uHour + 24.0 : uHour;
        vec2 seed = cell * 1.3 + bseed * 7.1 + floor(vLocalN.xz * 2.0) * 13.7;
        float lit = step(1.0 - mscLitShare(cls, t, bld), mscHash(seed + 9.1));
        float coolP = cls < 1.5 ? 0.15 : cls < 2.5 ? 0.50 : cls < 3.5 ? 0.85 : cls < 4.5 ? 0.75 : cls < 5.5 ? 0.70 : 0.25;
        float k = clamp(mscHash(seed + 13.1) * 0.72 + mscHash(bseed + 2.71) * 0.28 + (coolP - 0.5) * 0.2, 0.0, 0.999);
        float lamp;
        vec3 glow = mscGlow(cls, k, fract(k * 7.3), fract(k * 11.9), lamp);
        if (cls < 1.5 && lamp < 0.5 && t > 22.0 + 2.5 * fract(k * 5.1) && fract(k * 3.7) > 0.45) { glow = vec3(1.0, 0.62, 0.32); lamp = 1.0; }
        float pkf = mscPowAt(floor(vOrigin)); // power, as for the near panes
        if (pkf > 0.004) {
          float genf = step(mscHash(bseed + 4.4), 0.06);
          lit *= pkf > 0.5 ? genf + (1.0 - genf) * step(mscHash(seed + 21.7), 0.12) * 0.3 : 1.0 - 0.75 * pkf;
          if (pkf > 0.5) glow = mix(glow, vec3(1.0, 0.56, 0.22), 1.0 - genf);
        }
        fe += glow * (lamp > 0.5 ? 0.42 : 1.0) * lit * 1.1 * min(1.0, uNight * 1.6) * 1.8 * lp.z * pane;
      }
      diffuseColor.rgb = mix(diffuseColor.rgb, fb, farK);
      totalEmissiveRadiance = mix(totalEmissiveRadiance, em0 + fe, farK);
    }
  }
}`;

/**
 * Lambert with baked vertex colours, flat shading and procedural windows: glazing by day, lit panes at
 * night. Works for BatchedMesh and InstancedMesh alike.
 */
export function buildingMaterial() {
  const m = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sceneUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWin = aWin; vTop = aTop; vFac = aFac; vCell = aCell; vLocal = position; vLocalN = normal; vSky = mscSky(uElev);')
      .replace('#include <project_vertex>', `#include <project_vertex>
{
  vec4 o = vec4(0.0, 0.0, 0.0, 1.0);
  #ifdef USE_BATCHING
    o = batchingMatrix * o;
  #endif
  #ifdef USE_INSTANCING
    o = instanceMatrix * o;
  #endif
  vOrigin = (modelMatrix * o).xz;
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>' + FRAG_PARS + 'uniform float uUnder;' + OVL_PARS)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + WX_ROOF + WINDOWS)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>' + BUILDING_OVL + GHOST);
  };
  m.customProgramCacheKey = () => 'msc-windows';
  return m;
}

/** Weather on buildings: walls darken a little when wet, roofs take a white blend by the snow lying (each roof its own threshold, so they do not all turn at once). */
const WX_ROOF = /* glsl */ `
if (uCloud > 0.001) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114))), 0.4 * uCloud);
if (uWet > 0.001) diffuseColor.rgb *= 1.0 - 0.14 * uWet;
if (uSnow > 0.001 && vLocalN.y > 0.6) {
  float h = mscHash(floor(vOrigin));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 1.0), 0.94 * smoothstep(h * 0.4, h * 0.4 + 0.3, uSnow * 1.15) * (1.0 - uUnder));
}`;

/** The underground view: buildings go cool, grey and nearly clear so the layer below reads. */
const GHOST = /* glsl */ `
if (uUnder > 0.001) {
  float l = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(l) * vec3(0.72, 0.86, 1.1) + vec3(0.02, 0.04, 0.07), uUnder * 0.6);
  gl_FragColor.a *= 1.0 - 0.93 * uUnder;
}`;

/** The same for the ground: dark and half clear, roads a little less so (their outline stays). */
const GROUND_UNDER = /* glsl */ `
if (uUnder > 0.001) {
  float l = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(l) * vec3(0.7, 0.86, 1.1), uUnder * 0.45) * (1.0 - 0.62 * uUnder);
  gl_FragColor.a *= 1.0 - (vRoad >= 16.0 ? 0.6 : 0.76) * uUnder;
}`;

const GROUND_VERT_PARS = /* glsl */ `
attribute float aRoad;
attribute float aHeat;
varying float vRoad;
varying float vHeat;
varying vec3 vWorldP;`;

const GROUND_FRAG_PARS = /* glsl */ `
uniform float uNight;
uniform float uTime;
uniform float uHeat;
uniform float uHeatMode;
uniform float uUnder;
uniform float uWet;
uniform float uSnow;
uniform float uCloud;
uniform vec4 uGrass;
uniform vec2 uWindOff;
uniform vec3 uSkyCol;
uniform sampler2D uLampMap;
varying float vRoad;
varying float vHeat;
varying vec3 vWorldP;
${HASH}
${FLUTTER}
${POW_PARS}
// Light pool at p from the street lamp (if any) of tile \`tile\` (lampTexture: where it falls, when it comes on, its flags).
vec3 mscLamp(vec2 tile, vec2 p) {
  vec4 L = texture2D(uLampMap, (mod(tile, ${OVL_SIZE}.0) + 0.5) / ${OVL_SIZE}.0);
  if (L.r < 0.002) return vec3(0.0);
  float d = distance(p, tile + L.gb);
  float pool = smoothstep(1.05, 0.0, d);
  pool *= pool;
  float f = floor(L.a * 255.0 + 0.5);
  float dead = mod(f, 2.0), sput = mod(floor(f / 2.0), 2.0), led = mod(floor(f / 4.0), 2.0), bright = floor(f / 8.0) / 31.0;
  float on = smoothstep(L.r - 0.04, L.r + 0.04, uNight);
  if (dead > 0.5) on = 0.0;
  else if (sput > 0.5) on *= mscFlutter(mscLampSeed(tile), uTime); // a failing lamp: steady, with a soft stutter now and then
  float pl = mscPowAt(tile); // power (utilities.ts): out in a cut, a steady dim in a brownout (the lantern does the same)
  if (pl > 0.5) on = 0.0;
  else if (pl > 0.004) on *= 1.0 - pl * 0.8;
  vec3 c = led > 0.5 ? vec3(0.88, 0.92, 1.0) : vec3(1.0, 0.78, 0.45);
  return c * pool * on * (0.75 + 0.6 * bright);
}`;

/**
 * Weather on the ground (before the lamps and the lighting): wet ground darkens, roads more; lying snow blends to white, patchy by tile,
 * thinner on roads, never on water (blue-dominant tiles). Land and roads only; the underground view fades it.
 */
const WX_GROUND = /* glsl */ `
{
  // the year's hue on grass (green-dominant, not road): greener in spring, yellower late in summer, duller in winter (render/seasons.ts)
  vec3 c = diffuseColor.rgb;
  float gk = smoothstep(0.02, 0.07, c.g - max(c.r * 1.02, c.b * 1.1)) * (1.0 - step(16.0, vRoad));
  if (gk > 0.0) {
    vec3 g = c * uGrass.xyz;
    g = mix(g, vec3(dot(g, vec3(0.299, 0.587, 0.114))) * vec3(1.02, 0.97, 0.88), uGrass.w);
    diffuseColor.rgb = mix(c, g, gk);
  }
}
if (uCloud > 0.001) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114))), 0.4 * uCloud);
if (uWet > 0.001 || uSnow > 0.001) {
  float isRoad = step(16.0, vRoad);
  diffuseColor.rgb *= 1.0 - uWet * mix(0.12, 0.4, isRoad);
  if (uSnow > 0.001) {
    float h = mscHash(floor(vWorldP.xz));
    float cover = uSnow * mix(1.15, 0.42, isRoad);
    float k = smoothstep(h * 0.4, h * 0.4 + 0.3, cover);
    k *= 1.0 - smoothstep(0.02, 0.08, diffuseColor.b - max(diffuseColor.r, diffuseColor.g)) ;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 1.0), 0.94 * k * (1.0 - uUnder));
  }
}`;

/** After the lighting: wet roads shine with the sky at a glancing view, and clouds' shadows drift over the land by day. */
const WX_GROUND_LIT = /* glsl */ `
if (uWet > 0.001 && vRoad >= 16.0) {
  float f = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
  gl_FragColor.rgb += uSkyCol * uWet * (0.03 + 0.45 * f) * 0.5 * (1.0 - uUnder);
}
if (uCloud > 0.12 && uNight < 0.9) {
  vec2 q = (vWorldP.xz - uWindOff) * 0.055;
  float n = sin(q.x + 1.7 * sin(q.y * 0.7)) * sin(q.y * 1.1 + 1.3 * sin(q.x * 0.6)) * 0.4 + 0.5 * sin(q.x * 2.3 + q.y * 1.9 + 1.0) * 0.25 + 0.5;
  float t = 1.05 - uCloud;
  float sh = smoothstep(t - 0.12, t + 0.12, n) * 0.3 * (1.0 - 0.6 * smoothstep(0.7, 1.0, uCloud)) * (1.0 - uNight) * (1.0 - uUnder);
  gl_FragColor.rgb *= 1.0 - sh;
}`;

/** aRoad: 16 + the N E S W road bits on a road tile; 1 or more on a tile with a road among its eight neighbours. */
const LAMPS = /* glsl */ `
if (vRoad > 0.5 && uNight > 0.001) {
  vec2 tile = floor(vWorldP.xz);
  vec2 p = vWorldP.xz;
  vec3 lamp = vec3(0.0);
  for (int dz = -1; dz <= 1; dz++) for (int dx = -1; dx <= 1; dx++) lamp += mscLamp(tile + vec2(float(dx), float(dz)), p);
  totalEmissiveRadiance += lamp * min(1.0, uNight * 1.5) * diffuseColor.rgb * 2.0;
}`;

/**
 * The data overlays (shared/src/issues.ts): colour-blind safe ramps, in output (sRGB) space since they are painted after
 * tone mapping. Sequential: a viridis fit (dark violet, teal, yellow); diverging: orange, pale, blue.
 */
const OVL_PARS = /* glsl */ `
uniform float uOvl;
uniform sampler2D uOvlMap;
vec3 mscViridis(float t) {
  const vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  const vec3 c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
  const vec3 c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  const vec3 c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
  const vec3 c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
  const vec3 c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
  const vec3 c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}
vec3 mscDiverge(float t) {
  vec3 lo = vec3(0.90, 0.46, 0.05), mid = vec3(0.93, 0.92, 0.86), hi = vec3(0.13, 0.40, 0.80);
  return t < 0.5 ? mix(lo, mid, t * 2.0) : mix(mid, hi, (t - 0.5) * 2.0);
}
/** the overlay byte of a tile (0 no data, else 1-255), from the wrapped map */
float mscOvlAt(vec2 tile) { return texture2D(uOvlMap, (mod(tile, ${OVL_SIZE}.0) + 0.5) / ${OVL_SIZE}.0).r * 255.0; }
vec3 mscOvlRamp(float b) { float v = clamp((b - 1.0) / 254.0, 0.0, 1.0); return uOvl < 1.5 ? mscViridis(v) : mscDiverge(v); }`;

/** Data overlay on the ground: land tiles with data take the ramp over the lit result (reads the same day and night); the rest go grey. */
const GROUND_OVL = /* glsl */ `
if (uOvl > 0.5 && vRoad < 16.0) {
  float b = mscOvlAt(floor(vWorldP.xz));
  float l = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor.rgb = b > 0.5 ? mix(vec3(l), mscOvlRamp(b), 0.8) : mix(gl_FragColor.rgb, vec3(l), 0.7) * 0.85;
}`;

/** The same on buildings, by the tile their instance stands on, keeping some of the lit shading so shapes still read. */
const BUILDING_OVL = /* glsl */ `
if (uOvl > 0.5) {
  float b = mscOvlAt(floor(vOrigin));
  float l = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor.rgb = b > 0.5 ? mscOvlRamp(b) * (0.55 + 0.7 * clamp(l, 0.0, 0.8)) : vec3(0.35 + 0.5 * l);
}`;

/** Congestion overlay: painted over the lit result so it reads the same by day and night. */
const glslColour = (c: number) => `vec3(${(((c >> 16) & 255) / 255).toFixed(3)}, ${(((c >> 8) & 255) / 255).toFixed(3)}, ${((c & 255) / 255).toFixed(3)})`;
/** the road classes overlay: a road tile's byte is (class + 1) * 32 (main.ts roadClassHeat), each class its own colour */
const CLASS_COLOURS = ROAD_CLASS_DEFS.map((d, i) => `${i ? 'else ' : ''}if (k < ${i + 1.5}) pc = ${glslColour(d.colour)};`).join(' ');
const HEAT = /* glsl */ `
if (uHeat > 0.5 && vRoad >= 16.0 && uHeatMode > 1.5) {
  if (vHeat > 0.05) {
    float k = floor(vHeat * 255.0 / 32.0 + 0.5);
    vec3 pc = vec3(0.5);
    ${CLASS_COLOURS}
    gl_FragColor.rgb = mix(gl_FragColor.rgb, pc, 0.75);
  }
} else if (uHeat > 0.5 && vRoad >= 16.0 && uHeatMode > 0.5) {
  // the power overlay (utilities.ts heat bytes): supplied green, brownout amber, cut or fault red, a dead node's streets grey
  if (vHeat > 0.05) {
    vec3 pc = vHeat < 0.375 ? vec3(0.31, 0.83, 0.42) : vHeat < 0.625 ? vec3(0.95, 0.76, 0.19) : vHeat < 0.875 ? vec3(0.91, 0.22, 0.17) : vec3(0.55, 0.57, 0.62);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, pc, 0.72);
  }
} else if (uHeat > 0.5 && vRoad >= 16.0) {
  vec3 low = vec3(0.31, 0.83, 0.42), mid = vec3(0.95, 0.76, 0.19), high = vec3(0.91, 0.22, 0.17);
  vec3 heat = vHeat < 0.5 ? mix(low, mid, vHeat * 2.0) : mix(mid, high, (vHeat - 0.5) * 2.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, heat, 0.55 + 0.35 * vHeat);
}`;

/**
 * Textured, vertex-tinted ground with street-lamp pools along roads after dark. `road`: the variant for the road
 * geometry (render/roads.ts), pulled a touch towards the camera so it wins over the ground quads it lies on.
 */
export function groundMaterial(atlas: Texture, road = false) {
  const m = new MeshLambertMaterial({ map: atlas, vertexColors: true });
  if (road) { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2; }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sceneUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + GROUND_VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vRoad = aRoad; vHeat = aHeat;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>' + GROUND_FRAG_PARS + OVL_PARS)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + WX_GROUND + LAMPS)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>' + WX_GROUND_LIT + HEAT + GROUND_OVL + GROUND_UNDER);
  };
  m.customProgramCacheKey = () => 'msc-ground';
  return m;
}

/**
 * Street lamp lanterns (render/roads.ts), instanced: each glows after dark from its lamp's own bytes, as its pool on
 * the road does (lampTexture). aLamp: switch-on darkness, flags (as the texture's A byte), the lamp's tile x and z.
 */
export function lanternMaterial() {
  const m = new MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    for (const k of ['uNight', 'uTime', 'uPow', 'uPowMap'] as const) shader.uniforms[k] = sceneUniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aLamp;\nvarying vec4 vLamp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLamp = aLamp;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uTime;\nvarying vec4 vLamp;\n' + FLUTTER + POW_PARS)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    float f = vLamp.y;
    float dead = mod(f, 2.0), sput = mod(floor(f / 2.0), 2.0), led = mod(floor(f / 4.0), 2.0), bright = floor(f / 8.0) / 31.0;
    float on = smoothstep(vLamp.x - 0.04, vLamp.x + 0.04, uNight);
    if (dead > 0.5) on = 0.0;
    else if (sput > 0.5) on *= mscFlutter(mscLampSeed(vLamp.zw), uTime); // the same lamp, the same stutter as its pool on the road
    float pl = mscPowAt(vLamp.zw);
    if (pl > 0.5) on = 0.0; else if (pl > 0.004) on *= 1.0 - pl * 0.8;
    vec3 c = led > 0.5 ? vec3(0.85, 0.9, 1.0) : vec3(1.0, 0.72, 0.38);
    totalEmissiveRadiance += c * on * (1.6 + 1.2 * bright);
  }`);
  };
  m.customProgramCacheKey = () => 'msc-lantern';
  return m;
}

export function vehicleMaterial() {
  return new MeshLambertMaterial({ vertexColors: true, flatShading: true });
}
