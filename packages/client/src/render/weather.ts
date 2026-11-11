import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, Points, ShaderMaterial, Vector2, Vector3,
  type Camera, type PerspectiveCamera, type WebGLRenderer, type Scene,
} from 'three';
import { weatherAt, TICKS_PER_HOUR, type Weather } from '@msimcity/shared';
import { sceneUniforms } from './materials';

/**
 * Weather as the player sees it (docs/weather.md W2): one `weatherAt(worldSeed, liveTick)` per frame, eased so a jump in the
 * clock never pops, and from it
 *  - the numbers the rest of the frame reads (`state`: cloud, fog, wet roads, lying snow ...; lighting.ts, main.ts, fpv.ts),
 *  - a camera-local particle volume (rain: instanced streaks, snow: points), one draw of either, slanted by the wind,
 *  - the scene uniforms the ground, road and roof shaders blend with (uWet, uSnow, cloud shadows),
 *  - the top-bar chip's text and the sound's inputs.
 * `?weather=rain|snow|fog|storm|clear` forces a condition (screenshots).
 */

export type Forced = 'rain' | 'snow' | 'fog' | 'storm' | 'clear';
export const isForced = (s: string | null): s is Forced => s === 'rain' || s === 'snow' || s === 'fog' || s === 'storm' || s === 'clear';

export interface WxState {
  cloud: number;
  /** 0..1 intensity of what is falling, and which it is */
  rain: number;
  snow: boolean;
  fog: number;
  /** 0..1 wet ground: rises while it rains, dries over about a game hour after */
  wet: number;
  snowCover: number;
  storm: boolean;
  /** 0..1 wind strength for the look and the sound (tiles per game hour over 28) */
  windK: number;
  /** the direction the wind blows towards, a unit vector in tile space (x east, y south = world z) */
  dx: number;
  dy: number;
  tempC: number;
}

const TAU = Math.PI * 2;
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const MPH = 1.8; // per tile per game hour (docs/weather.md W1)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** the compass point a wind blowing towards (dx, dy) comes from */
export const windFrom = (dx: number, dy: number) => POINTS[(((Math.round(Math.atan2(dx, -dy) / (TAU / 16)) + 8) % 16) + 16) % 16];

/** what each forced condition holds (on top of the real wind direction) */
const FORCED: Record<Forced, Partial<Weather> & { speed?: number }> = {
  clear: { cloud: 0, rain: 0, fog: 0, snowCover: 0, snow: false, storm: false, tempC: 16 },
  rain: { cloud: 0.9, rain: 0.7, fog: 0, snowCover: 0, snow: false, storm: false, tempC: 9, speed: 13 },
  snow: { cloud: 0.85, rain: 0.6, fog: 0.15, snowCover: 0.95, snow: true, storm: false, tempC: -2, speed: 8 },
  fog: { cloud: 0.5, rain: 0, fog: 0.85, snowCover: 0, snow: false, storm: false, tempC: 6, speed: 3 },
  storm: { cloud: 1, rain: 1, fog: 0, snowCover: 0, snow: false, storm: true, tempC: 8, speed: 30 },
};

const RAIN_MAX = 9000, SNOW_MAX = 7000;

const RAIN_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCenter;
uniform vec2 uBox;      // half extents: x,z and y
uniform float uScale;   // 1 at a 30 tile volume
uniform vec3 uOff;      // accumulated travel at scale 1
uniform float uLen, uWidth, uProj;
uniform float uAlpha;
uniform float uDrift, uDriftZ;
varying float vA;
varying float vAcross;
void main() {
  vec3 B = vec3(uBox.x, uBox.y, uBox.x) * 2.0;
  vec3 lo = vec3(uCenter.x, 0.0, uCenter.z) - vec3(uBox.x, 0.0, uBox.x);
  float sv = 0.85 + 0.3 * aSeed.w;
  vec3 w = aSeed.xyz * B + uOff * uScale * sv;
  vec3 p = lo + mod(w - lo, B);
  vec3 tail = p - normalize(vec3(uDrift, -1.0, uDriftZ)) * uLen * uScale * (0.7 + 0.6 * aSeed.w);
  vec3 a = (viewMatrix * vec4(p, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(tail, 1.0)).xyz;
  vec3 side = cross(b - a, a);
  side = length(side) > 1e-6 ? normalize(side) : vec3(1.0, 0.0, 0.0);
  float px = max(-a.z, 0.1) / uProj;            // one pixel across, in world units here
  float wd = max(uWidth * uScale, 1.0 * px);
  vec3 pos = mix(a, b, position.y) + side * (position.x * wd);
  gl_Position = projectionMatrix * vec4(pos, 1.0);
  vec3 q = (p - vec3(uCenter.x, uBox.y, uCenter.z)) / vec3(uBox.x, uBox.y, uBox.x);
  float edge = (1.0 - smoothstep(0.65, 1.0, abs(q.y))) * (1.0 - smoothstep(0.65, 1.0, length(q.xz)));
  float near = smoothstep(uBox.x * 0.04, uBox.x * 0.2, -a.z); // no fat streaks right at the lens
  vA = uAlpha * edge * near * clamp(uWidth * uScale / wd + 0.35, 0.0, 1.0) * (0.55 + 0.45 * aSeed.w);
  vAcross = position.x;
}`;

const RAIN_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
varying float vAcross;
void main() {
  float soft = 1.0 - smoothstep(0.2, 0.5, abs(vAcross));
  gl_FragColor = vec4(uColor, vA * soft);
}`;

const SNOW_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCenter;
uniform vec2 uBox;
uniform float uScale;
uniform vec3 uOff;
uniform float uSize, uProj, uAlpha, uTime;
varying float vA;
void main() {
  vec3 B = vec3(uBox.x, uBox.y, uBox.x) * 2.0;
  vec3 lo = vec3(uCenter.x, 0.0, uCenter.z) - vec3(uBox.x, 0.0, uBox.x);
  float sv = 0.8 + 0.4 * aSeed.w;
  vec3 w = aSeed.xyz * B + uOff * uScale * sv;
  vec3 p = lo + mod(w - lo, B);
  float ph = aSeed.w * 40.0;
  p.x += sin(uTime * (0.7 + aSeed.x) + ph) * 0.5 * uScale;
  p.z += cos(uTime * (0.6 + aSeed.z) + ph * 1.3) * 0.5 * uScale;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 0.1);
  float s = uSize * uScale * (0.7 + 0.6 * aSeed.w);
  gl_PointSize = max(1.5, s * uProj / d);
  vec3 q = (p - vec3(uCenter.x, uBox.y, uCenter.z)) / vec3(uBox.x, uBox.y, uBox.x);
  float edge = (1.0 - smoothstep(0.65, 1.0, abs(q.y))) * (1.0 - smoothstep(0.65, 1.0, length(q.xz)));
  vA = uAlpha * edge * smoothstep(uBox.x * 0.04, uBox.x * 0.2, d);
}`;

const SNOW_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.35, 1.0, d);
  gl_FragColor = vec4(uColor, vA * a);
}`;

function seeds(n: number, salt: number): Float32Array {
  const a = new Float32Array(n * 4);
  let s = salt >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; // fixed: every machine's rain falls alike
  for (let i = 0; i < a.length; i++) a[i] = rnd();
  return a;
}

export class WeatherView {
  readonly state: WxState = { cloud: 0, rain: 0, snow: false, fog: 0, wet: 0, snowCover: 0, storm: false, windK: 0, dx: 1, dy: 0, tempC: 12 };
  readonly group = new Group();
  /** the world seed (tv.worldSeed after `welcome`); until then weather is as for seed 0 */
  seed = () => 0;
  force: Forced | null = null;
  /** where the overhead camera looks and how far, and the first-person camera (set by main.ts each frame) */
  focus = new Vector2();
  dist = 60;
  fpvCamera: Camera | null = null;
  /** the particles are not drawn in the underground view, a tube ride, the map ... (set by main.ts) */
  enabled = true;
  /** sound (Ambience.setWeather) */
  onSound: ((rain: number, wind: number, storm: boolean) => void) | null = null;

  private rain: Mesh;
  private snow: Points;
  private rainU: Record<string, { value: unknown }>;
  private snowU: Record<string, { value: unknown }>;
  private raw: Weather | null = null;
  private first = true;
  private off = new Vector3();
  private snowOff = new Vector3();
  private time = 0;
  private lastWet = 0;
  private chipAt = -1e9;
  private chipText = '';
  private chipTip = '';
  private tint = new Color();
  private vp = new Vector2();
  /** the last frame's cost, ms (average over a second, the perf HUD's check) */
  costMs = 0;
  private costAcc = 0;
  private costN = 0;

  constructor(scene: Scene) {
    const common = () => ({ uCenter: { value: new Vector3() }, uBox: { value: new Vector2(30, 30) }, uScale: { value: 1 }, uOff: { value: new Vector3() }, uProj: { value: 1000 }, uAlpha: { value: 0 }, uColor: { value: new Color(0.8, 0.85, 0.95) } });
    // rain: instanced quads, one per streak
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aSeed', new InstancedBufferAttribute(seeds(RAIN_MAX, 12345), 4));
    g.instanceCount = 0;
    this.rainU = { ...common(), uLen: { value: 1.7 }, uWidth: { value: 0.03 }, uDrift: { value: 0 }, uDriftZ: { value: 0 } };
    const rm = new ShaderMaterial({
      uniforms: this.rainU as never, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
      transparent: true, depthWrite: false, fog: false, toneMapped: false, side: DoubleSide,
    });
    this.rain = new Mesh(g, rm);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 20;
    this.rain.visible = false;
    this.rain.onBeforeRender = (r, _s, cam) => this.place(r, cam, this.rainU, 0.6);
    // snow: points
    const sg = new BufferGeometry();
    sg.setAttribute('position', new BufferAttribute(new Float32Array(SNOW_MAX * 3), 3));
    sg.setAttribute('aSeed', new BufferAttribute(seeds(SNOW_MAX, 777), 4));
    sg.setDrawRange(0, 0);
    this.snowU = { ...common(), uSize: { value: 0.2 }, uTime: { value: 0 } };
    this.snowU.uColor.value = new Color(0.95, 0.97, 1);
    this.snow = new Points(sg, new ShaderMaterial({ uniforms: this.snowU as never, vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 20;
    this.snow.visible = false;
    this.snow.onBeforeRender = (r, _s, cam) => this.place(r, cam, this.snowU, 0.5);
    this.group.add(this.rain, this.snow);
    scene.add(this.group);
  }

  /** The volume for this camera: small and tight round the first-person eye, round the look-at point (sized by zoom) for the overhead one. */
  private place(r: WebGLRenderer, cam: Camera, u: Record<string, { value: unknown }>, _unused: number) {
    const fpv = cam === this.fpvCamera;
    const R = fpv ? 14 : Math.min(72, Math.max(16, this.dist * 0.75));
    const c = u.uCenter.value as Vector3, box = u.uBox.value as Vector2;
    if (fpv) c.copy(cam.position); else c.set(this.focus.x, 0, this.focus.y);
    box.set(R, fpv ? 11 : R);
    u.uScale.value = R / 30;
    const rt = r.getRenderTarget();
    const h = rt ? rt.height : r.getDrawingBufferSize(this.vp).y;
    const fov = ((cam as PerspectiveCamera).fov ?? 50) * Math.PI / 180;
    u.uProj.value = h / (2 * Math.tan(fov / 2));
  }

  /** snap to the weather of the (new) seed at once, no easing */
  reset() { this.first = true; }

  /** Whether anything is falling or the sky is veiled, for the cheap exits. */
  get active() { return this.state.rain > 0.01 || this.state.fog > 0.01 || this.state.cloud > 0.01 || this.state.snowCover > 0.01; }

  /** Once a frame, from the live fractional tick. `liveHour`: the game hour (0-24), for the chip's day or night icon. */
  update(dt: number, tickF: number, nowMs: number) {
    const t0 = performance.now();
    const w = weatherAt(this.seed(), tickF);
    this.raw = w;
    const f = this.force ? FORCED[this.force] : null;
    const rain = f?.rain ?? w.rain, snow = f?.snow ?? w.snow;
    const speed = f?.speed !== undefined ? Math.max(f.speed, w.wind.speed * 0.5) : w.wind.speed;
    const tgt = {
      cloud: f?.cloud ?? w.cloud, rain, fog: f?.fog ?? w.fog, snowCover: f?.snowCover ?? w.snowCover,
      windK: clamp01(speed / 28), dx: w.wind.dx, dy: w.wind.dy, tempC: f?.tempC ?? w.tempC,
    };
    const s = this.state;
    const k = this.first ? 1 : 1 - Math.exp(-dt * 1.2);
    s.cloud += (tgt.cloud - s.cloud) * k;
    s.rain += (tgt.rain - s.rain) * k;
    s.fog += (tgt.fog - s.fog) * k;
    s.snowCover += (tgt.snowCover - s.snowCover) * k;
    s.windK += (tgt.windK - s.windK) * k;
    s.dx = tgt.dx; s.dy = tgt.dy; s.tempC = tgt.tempC;
    s.snow = snow; s.storm = f ? f.storm ?? false : w.storm;
    // wet roads: soak quickly while it rains, dry over about 40 seconds (a game hour is 20) after; snow does not wet them
    const wetTo = !snow && rain > 0.04 ? Math.min(1, 0.55 + 0.6 * rain) : 0;
    s.wet = this.first ? wetTo : wetTo > s.wet ? Math.min(wetTo, s.wet + dt * 0.5) : Math.max(wetTo, s.wet - dt / 40);
    this.first = false;

    // the shaders' shared uniforms
    sceneUniforms.uWet.value = s.wet;
    sceneUniforms.uSnow.value = s.snowCover;
    sceneUniforms.uCloud.value = s.cloud;
    this.time += dt;
    // cloud shadows drift with the wind: 3 tiles per second at a gale, a little in a calm
    const ws = 0.4 + 3 * s.windK;
    const o = sceneUniforms.uWindOff.value as Vector2;
    o.x = (o.x + s.dx * ws * dt) % 4096; o.y = (o.y + s.dy * ws * dt) % 4096;

    // the particles: rain falls 22 tiles a second (at scale 1), slanted by the wind
    const fall = 22, drift = s.windK * 0.6 * fall;
    this.off.x += s.dx * drift * dt; this.off.z += s.dy * drift * dt; this.off.y -= fall * dt;
    this.off.x %= 4096; this.off.z %= 4096; this.off.y %= 4096;
    this.snowOff.x += s.dx * (1.2 + 6 * s.windK) * dt; this.snowOff.z += s.dy * (1.2 + 6 * s.windK) * dt; this.snowOff.y -= 2.4 * dt;
    this.snowOff.x %= 4096; this.snowOff.z %= 4096; this.snowOff.y %= 4096;

    const show = this.enabled && s.rain > 0.02;
    const raining = show && !s.snow, snowing = show && s.snow;
    this.rain.visible = raining; this.snow.visible = snowing;
    // brightness of the sky lights the streaks (dark at night)
    if (raining || snowing) {
      const ru = this.rainU, su = this.snowU;
      (ru.uOff.value as Vector3).copy(this.off);
      (su.uOff.value as Vector3).copy(this.snowOff);
      su.uTime.value = this.time;
      ru.uDrift.value = s.dx * s.windK * 0.6; ru.uDriftZ.value = s.dy * s.windK * 0.6;
      const lum = Math.max(0.12, Math.min(1, sceneUniforms.uSkyLum.value));
      this.tint.setRGB(0.75 * lum + 0.05, 0.8 * lum + 0.06, 0.9 * lum + 0.08);
      (ru.uColor.value as Color).copy(this.tint);
      (su.uColor.value as Color).setRGB(0.95 * lum + 0.04, 0.96 * lum + 0.04, lum + 0.05);
      const geo = this.rain.geometry as InstancedBufferGeometry;
      geo.instanceCount = Math.round(RAIN_MAX * Math.min(1, 0.06 + s.rain));
      ru.uAlpha.value = 0.4 + 0.35 * s.rain;
      this.snow.geometry.setDrawRange(0, Math.round(SNOW_MAX * Math.min(1, 0.25 + s.rain)));
      su.uAlpha.value = 0.85;
    }
    this.onSound?.(s.snow ? 0 : s.rain, s.windK, s.storm);
    if (nowMs - this.chipAt > 500) { this.chipAt = nowMs; this.buildChip(tickF); }
    this.lastWet = s.wet;
    this.costAcc += performance.now() - t0; this.costN++;
    if (this.costN >= 60) { this.costMs = this.costAcc / this.costN; this.costAcc = 0; this.costN = 0; }
  }

  /** The chip's icon and text, and its tooltip's next few hours. Rebuilt twice a second. */
  private buildChip(tickF: number) {
    const w = this.raw!, s = this.state;
    const hour = ((tickF / TICKS_PER_HOUR) % 24 + 24) % 24;
    const icon = (c: { cloud: number; rain: number; snow: boolean; fog: number; storm: boolean }, hr: number) =>
      c.storm ? '⛈' : c.rain > 0.1 ? (c.snow ? '❄' : '☂') : c.fog > 0.4 ? '🌫' : c.cloud > 0.65 ? '☁' : c.cloud > 0.3 ? (hr >= 6 && hr < 20 ? '⛅' : '☁') : hr >= 6 && hr < 20 ? '☀' : '☾';
    const mph = Math.round(s.windK * 28 * MPH), from = windFrom(s.dx, s.dy);
    this.chipText = `${icon({ cloud: s.cloud, rain: s.rain, snow: s.snow, fog: s.fog, storm: s.storm }, hour)} ${Math.round(s.tempC)}°C · ${mph < 2 ? 'calm' : `${from} ${mph} mph`}`;
    const lines = [`Now: ${describe(s.cloud, s.rain, s.snow, s.fog, s.storm)}, ${Math.round(s.tempC)}°C, wind from the ${from} at ${mph} mph${s.snowCover > 0.2 ? `, snow lying (${Math.round(s.snowCover * 100)}%)` : ''}`];
    const seed = this.seed();
    for (let i = 1; i <= 6; i++) {
      const x = weatherAt(seed, tickF + i * 2 * TICKS_PER_HOUR), hr = Math.floor(hour + i * 2) % 24;
      lines.push(`${String(hr).padStart(2, '0')}:00  ${icon(x, hr)} ${describe(x.cloud, x.rain, x.snow, x.fog, x.storm)}, ${Math.round(x.tempC)}°C, ${windFrom(x.wind.dx, x.wind.dy)} ${Math.round(x.wind.speed * MPH)} mph`);
    }
    this.chipTip = lines.join('\n');
  }
  get chip() { return { text: this.chipText, title: this.chipTip }; }
  get cost() { return this.costMs; }
  get wetNow() { return this.lastWet; }
}

function describe(cloud: number, rain: number, snow: boolean, fog: number, storm: boolean): string {
  if (storm) return 'thunderstorm';
  if (rain > 0.05) return snow ? (rain > 0.5 ? 'heavy snow' : 'snow') : rain > 0.7 ? 'heavy rain' : rain > 0.3 ? 'rain' : 'light rain';
  if (fog > 0.4) return 'fog';
  return cloud > 0.75 ? 'overcast' : cloud > 0.4 ? 'cloudy' : cloud > 0.15 ? 'sunny spells' : 'clear';
}
