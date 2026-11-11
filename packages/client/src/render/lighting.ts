import { DirectionalLight, HemisphereLight, Color, Scene, Vector3 } from 'three';
import { sceneUniforms } from './materials';
import { Celestial } from './celestial';
import { sunAt, sunDeclination } from '@msimcity/shared';
import { grassFor } from './seasons';

const DAY_SKY = new Color(0x9fc4e8), DUSK_SKY = new Color(0xe09a66), BLUE_HOUR = new Color(0x2c3f72), NIGHT_SKY = new Color(0x0c1428);
const SUN_WARM = new Color(0xffa95c), SUN_WHITE = new Color(0xfff3e0), MOON = new Color(0x7f93d0);
const HEMI_DAY_SKY = new Color(0xbfd9ff), HEMI_DAY_GROUND = new Color(0x5a6b45);
// moonlit night floor: bright enough that empty land, roads and parcel edges read on a first view at night (Gauntlet 3)
const HEMI_NIGHT_SKY = new Color(0x34467a), HEMI_NIGHT_GROUND = new Color(0x1c2233);

const UP = new Vector3(0, 1, 0);
/** a year phase with 12 hours of day (thumbnails and anything without a clock) */
const EQUINOX = equinoxPhase();
function equinoxPhase() { let best = 0, bd = Infinity; for (let p = 0; p < 0.5; p += 0.001) { const d = Math.abs(sunDeclination(p)); if (d < bd) { bd = d; best = p; } } return best; }
/**
 * The hour the evening darkness falls on a day of the year: the sun 3 degrees up on its way down (sin 0.052), so street lamps and lit
 * windows follow the season (about 15:45 at midwinter, 20:15 at midsummer) instead of a clock hour. Bisected over the afternoon,
 * cached while the phase is within 0.002 (a quarter of a game hour).
 */
let duskPhase = -1, duskHour = 18;
const DUSK_ELEV = Math.sin((3 * Math.PI) / 180);
export function duskHourAt(phase: number): number {
  if (Math.abs(phase - duskPhase) < 0.002) return duskHour;
  let lo = 12, hi = 24;
  for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (sunAt(phase, mid).elev > DUSK_ELEV) lo = mid; else hi = mid; }
  duskPhase = phase; duskHour = (lo + hi) / 2;
  return duskHour;
}
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Sun + hemisphere light driven by the in-game clock, with a shadow camera
 * that follows the view. `sky` is the background/fog colour for this moment.
 */
export class Lighting {
  sun = new DirectionalLight(0xffffff, 2.4);
  hemi = new HemisphereLight(HEMI_DAY_SKY, HEMI_DAY_GROUND, 0.8);
  sky = new Color();
  mode: 'live' | 'fixed' = 'live';
  fixedHour = 15.5;
  hour = 12;
  /** 0 = no shadows, 1 = 1024px, 2 = 2048px */
  quality = 2;
  private extent = -1;
  private snapped = new Vector3();
  private lr = new Vector3();
  private lu = new Vector3();
  private tmp = new Color();
  /** the weather's cloud cover and fog, 0..1 (render/weather.ts, set by main.ts before `update`): they grey the sky, dim and soften the sun and veil the celestial bodies */
  cloud = 0;
  fog = 0;
  /** the sun and moon drawn in the sky, along this light's direction (only for the main view: thumbnails leave it out) */
  readonly celestial: Celestial | null;

  constructor(scene: Scene, opts: { sky?: boolean } = {}) {
    this.celestial = opts.sky ? new Celestial(scene) : null;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.setQuality(2);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 700;
    scene.add(this.sun, this.sun.target, this.hemi);
  }

  setQuality(q: number) {
    this.quality = Math.max(0, Math.min(2, q));
    this.sun.castShadow = this.quality > 0;
    const size = this.quality === 2 ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  /**
   * `yearPhase` is the day of the year (shared seasonOf(tick).phase): the sun's path follows the season (shared sunAt),
   * so winter days are short with a low sun and long shadows, and summer days long with a high one. Left out, the
   * equinox (12 hours of day).
   */
  update(liveHour: number, target: Vector3, dist: number, gameDay = 0, yearPhase = EQUINOX) {
    const h = this.mode === 'live' ? liveHour : this.fixedHour;
    this.hour = h;
    const s = sunAt(yearPhase, h);
    const elev = s.elev;
    const day = smooth(-0.22, 0.16, elev);
    const dusk = Math.exp(-((elev / 0.2) ** 2)) * 0.8;
    const blue = Math.exp(-(((elev + 0.15) / 0.09) ** 2)); // blue hour after the orange has gone

    // the light comes from the sun by day and from the moon (opposite it) by night, never quite grazing the ground
    const dir = elev >= 0 ? new Vector3(s.x, Math.max(elev, 0.05), s.z) : new Vector3(-s.x, Math.max(-elev, 0.1), -s.z);
    dir.normalize();
    if (this.celestial) this.celestial.veil = Math.min(1, this.cloud * 0.95 + this.fog);
    this.celestial?.update(s, gameDay);
    // the shadow camera moves in whole texels of its own map as the view pans (in the light's axes), so a shadow's edge stays
    // on the same texels instead of crawling and shimmering over lit surfaces; the light's direction is unchanged
    const texel = this.extent > 0 ? (2 * this.extent) / this.sun.shadow.mapSize.x : 0;
    this.snapped.copy(target);
    if (texel > 0) {
      this.lr.crossVectors(UP, dir).normalize(); this.lu.crossVectors(dir, this.lr);
      const a = this.snapped.dot(this.lr), b = this.snapped.dot(this.lu);
      this.snapped.addScaledVector(this.lr, Math.round(a / texel) * texel - a).addScaledVector(this.lu, Math.round(b / texel) * texel - b);
    }
    this.sun.position.copy(this.snapped).addScaledVector(dir, 260);
    this.sun.target.position.copy(this.snapped);
    this.sun.target.updateMatrixWorld();

    // sun fades out into the horizon and the moon fades in, so the light never pops when the direction flips
    if (elev >= 0) {
      this.sun.color.copy(SUN_WARM).lerp(SUN_WHITE, smooth(0, 0.45, elev));
      this.sun.intensity = 2.6 * smooth(0, 0.12, elev) + 0.3 * smooth(0, 0.03, elev);
    } else {
      this.sun.color.copy(MOON);
      this.sun.intensity = 1.3 * smooth(0, 0.08, -elev);
    }
    this.hemi.color.copy(HEMI_NIGHT_SKY).lerp(HEMI_DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.35);
    this.hemi.groundColor.copy(HEMI_NIGHT_GROUND).lerp(HEMI_DAY_GROUND, day);
    this.hemi.intensity = 2.6 - 1.55 * day + 0.25 * dusk * (1 - day); // 1.05 by day; the night floor keeps land readable

    this.sky.copy(NIGHT_SKY).lerp(DAY_SKY, day);
    this.tmp.copy(this.sky).lerp(DUSK_SKY, dusk);
    this.sky.copy(this.tmp).lerp(BLUE_HOUR, blue * 0.6);
    sceneUniforms.uNight.value = 1 - smooth(-0.12, 0.1, elev);
    sceneUniforms.uHour.value = h;
    sceneUniforms.uElev.value = elev;
    sceneUniforms.uDusk.value = duskHourAt(yearPhase);
    sceneUniforms.uYear.value = yearPhase;
    grassFor(yearPhase, sceneUniforms.uGrass.value);
    sceneUniforms.uTime.value = performance.now() / 1000;

    // weather: cloud greys the sky and the sky's light and diffuses the sun (shadows fade with it: the hemisphere light fills them in),
    // fog turns the sky and the distance a pale grey. Luma-matched so a grey day is not brighter than a blue one.
    const cl = this.cloud, fg = this.fog;
    if (cl > 0.001 || fg > 0.001) {
      const lum = this.sky.r * 0.299 + this.sky.g * 0.587 + this.sky.b * 0.114;
      this.sky.lerp(this.tmp.setRGB(lum * 0.86, lum * 0.9, lum * 0.97), 0.78 * cl);
      this.sky.multiplyScalar(1 - 0.22 * cl);
      const flum = Math.max(0.09, lum * 1.05 + 0.1 * day);
      this.sky.lerp(this.tmp.setRGB(flum * 0.93, flum * 0.96, flum), 0.88 * fg);
      this.sun.intensity *= 1 - 0.88 * cl - 0.1 * fg;
      this.hemi.intensity *= 1 - 0.12 * cl * day;
      this.hemi.color.lerp(this.tmp.setRGB(0.78, 0.82, 0.88), 0.4 * cl * day);
      this.sun.shadow.radius = 1 + 3 * cl;
    } else this.sun.shadow.radius = 1;
    sceneUniforms.uSkyCol.value.copy(this.sky);
    sceneUniforms.uSkyLum.value = Math.min(1, (this.sky.r * 0.299 + this.sky.g * 0.587 + this.sky.b * 0.114) * 1.6);

    // shadow frustum sized to what is on screen
    const extent = Math.min(170, Math.max(22, dist * 1.35));
    if (Math.abs(extent - this.extent) > 1) {
      this.extent = extent;
      const cam = this.sun.shadow.camera;
      cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
      cam.updateProjectionMatrix();
    }
  }
}
