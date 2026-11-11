import { AdditiveBlending, Camera, Color, Mesh, PlaneGeometry, Scene, ShaderMaterial, Vector3 } from 'three';

/**
 * The sun and the moon in the sky (render/lighting.ts drives them): a disc with a soft glow, drawn along the light's own
 * direction so the shadows point away from it. Each is one camera-facing quad placed just inside whichever camera renders
 * it (the 3D view or first person, which have different far planes), so it sits behind everything and buildings and hills
 * hide it. Additive, unfogged, no depth write: it only brightens the flat sky colour behind it.
 *
 * Sizes are angles, so the sun looks the same size from any camera. The disc is drawn larger than the real 0.53° so it
 * reads from the overhead view; the glow widens and warms as the sun nears the horizon. The moon shows its phase: a
 * lunar month is MOON_MONTH_DAYS game days (a game week is a year of a citizen's life, so a real month would be half a
 * day; this is slower so a phase lasts a session).
 */
const MOON_MONTH_DAYS = 8;
const SUN_DISC = 0.03, SUN_GLOW = 0.32, MOON_DISC = 0.026, MOON_GLOW = 0.12; // half-widths in radians (tan of)

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** disc: a hard-edged circle of radius `disc` (in quad units); glow: a falloff to the quad's edge; the moon lit by phase */
const FRAG = /* glsl */ `
uniform vec3 uDisc; uniform vec3 uGlow; uniform float uRatio; uniform float uAlpha; uniform float uPhase; uniform float uMoon;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float g = pow(1.0 - r, 3.0) * 0.55 + pow(1.0 - r, 12.0) * 0.6;
  vec3 col = uGlow * g;
  float d = r / uRatio; // 0..1 inside the disc
  float edge = 1.0 - smoothstep(0.92, 1.0, d);
  if (d < 1.0) {
    float lit = 1.0;
    if (uMoon > 0.5) {
      // a sphere lit from a direction swinging round with the phase: 0 new, 0.5 full
      vec2 p = vUv / uRatio;
      vec3 n = vec3(p, sqrt(max(0.0, 1.0 - dot(p, p))));
      float a = uPhase * 6.2831853;
      lit = smoothstep(-0.04, 0.04, dot(n, vec3(sin(a), 0.0, -cos(a)))) * 0.95 + 0.05;
      lit *= 0.85 + 0.15 * fract(sin(dot(floor(p * 6.0), vec2(12.9898, 78.233))) * 43758.5453); // a few maria
    }
    col += uDisc * edge * lit;
  }
  gl_FragColor = vec4(col * uAlpha, 1.0);
}`;

class Body {
  readonly mesh: Mesh;
  readonly mat: ShaderMaterial;
  /** unit vector from the viewer towards the body */
  readonly dir = new Vector3(0, 1, 0);
  constructor(disc: number, glow: number, moon: boolean) {
    this.mat = new ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uDisc: { value: new Color() }, uGlow: { value: new Color() }, uRatio: { value: disc / glow },
        uAlpha: { value: 0 }, uPhase: { value: 0.5 }, uMoon: { value: moon ? 1 : 0 },
      },
      transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, toneMapped: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10; // before the scene's transparent things, after the opaque ones that hide it
    // placed per camera: the 3D view's far plane is 2000 tiles, first person's 160
    this.mesh.onBeforeRender = (_r, _s, cam: Camera) => {
      const far = (cam as Camera & { far?: number }).far ?? 1000;
      const dist = far * 0.85;
      this.mesh.position.copy(cam.position).addScaledVector(this.dir, dist);
      this.mesh.quaternion.copy(cam.quaternion);
      this.mesh.scale.setScalar(dist * glow);
      this.mesh.updateMatrixWorld();
    };
  }
}

export class Celestial {
  private sun = new Body(SUN_DISC, SUN_GLOW, false);
  private moon = new Body(MOON_DISC, MOON_GLOW, true);
  private tmp = new Color();
  /** 0..1: cloud and fog hiding the sky (weather, docs/weather.md W2); 0 for a clear sky */
  veil = 0;

  constructor(scene: Scene) { scene.add(this.sun.mesh, this.moon.mesh); }

  set visible(v: boolean) { this.sun.mesh.visible = v; this.moon.mesh.visible = v; }

  /** `sun`: the unit vector towards the sun (shared sunAt: x east, y up, z south); `day` the game day, for the moon's phase. */
  update(sun: { x: number; y: number; z: number }, day: number) {
    const clear = 1 - 0.9 * this.veil;
    const elev = sun.y;
    this.sun.dir.set(sun.x, sun.y, sun.z).normalize();
    const up = Math.min(1, Math.max(0, (elev + 0.04) / 0.08)); // sinks below the horizon over the last few degrees
    const low = 1 - Math.min(1, Math.max(0, elev / 0.35)); // 1 at the horizon, 0 well up
    const su = this.sun.mat.uniforms;
    (su.uDisc.value as Color).setRGB(1.6, 1.45 - 0.45 * low, 1.2 - 0.75 * low);
    (su.uGlow.value as Color).setRGB(0.55 + 0.35 * low, 0.42, 0.25 - 0.1 * low).multiplyScalar(0.6 + 0.6 * low);
    su.uAlpha.value = up * clear;
    // the moon: opposite the sun (as lighting.ts lights the night), phase by the day; a summer full moon rides low
    const phase = (((day / MOON_MONTH_DAYS + 0.5) % 1) + 1) % 1; // a new world opens under a full moon
    this.moon.dir.set(-sun.x, -sun.y, -sun.z).normalize();
    const mu = this.moon.mat.uniforms;
    const full = 1 - Math.abs(phase - 0.5) * 2; // 1 at full, 0 at new
    (mu.uDisc.value as Color).setRGB(0.9, 0.92, 1.0);
    (mu.uGlow.value as Color).copy(this.tmp.setRGB(0.25, 0.3, 0.45)).multiplyScalar(0.2 + 0.8 * full);
    mu.uPhase.value = phase;
    // up only while the sun is down (lighting.ts lights the night from the moon's side)
    const night = Math.min(1, Math.max(0, (-elev + 0.05) / 0.15));
    const mUp = Math.min(1, Math.max(0, (-elev + 0.04) / 0.08));
    mu.uAlpha.value = mUp * (0.15 + 0.85 * night) * clear;
  }
}
