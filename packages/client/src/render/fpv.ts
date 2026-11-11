import {
  PerspectiveCamera, OrthographicCamera, Color, Scene, Mesh, PlaneGeometry, ShaderMaterial, WebGLRenderTarget, HalfFloatType, LinearFilter,
  Quaternion, Vector2, Vector3, Vector4, type WebGLRenderer, type Fog, type Object3D, type Light,
} from 'three';
import { hash2, tvOnAt, TICKS_PER_HOUR, type CitizenInfo } from '@msimcity/shared';
import type { CitizensView } from './citizens';
import { Interior, placeOf, homeSeedOf, type Place } from './interiors';
import { sceneUniforms } from './materials';
import { Instruments, type AircraftCal } from './instruments';
import { CarInterior, TrainCab, HelmCab, type CarFeed, type TrainCabFeed, type HelmFeed } from './vehicleInterior';
import { TunnelRide, TUNNEL_BG, TUNNEL_FOG, type TunnelFeed } from './tunnelRide';
import { NightOut, swimShape, wordOf, type NightFeed } from './nightout';
import { PassengerInterior, type PassengerFeed } from './passengerInterior';
import { handover, handOut, handStep, aboardKey, LOST_WAIT, RIDE_WAIT, type HandIn } from './passenger';

/** the vehicle an inspect sits a citizen in (CitizenInfo.aboard) */
export type Aboard = NonNullable<CitizenInfo['aboard']>;

export type FpvMode = 'off' | 'inset' | 'full';

const INSET_FRAC = 0.32, INSET_MARGIN = 16;
const FADE_SECONDS = 0.25;
/**
 * a night out in the full window is drawn into a target this much of the window's pixels across (the swim softens it anyway):
 * smaller as the swim grows, which also makes the scene and the blur's first pass cheaper. Up at these strengths, back down 0.04 under them.
 */
const FULL_SWIM_SCALES = [0.85, 0.7, 0.55], FULL_SWIM_UP = [0.12, 0.4];
/** the most taps the swim's second blur pass spends on a pixel of its small target (a quarter of the scene's size across) */
const BLUR_TAPS = 12;
/** going in or out of a door, or between rooms, is a slower fade through black */
const ROOM_FADE = 0.6;
/** street-level fog: the world is a few tiles tall, so the horizon is much closer than from the overhead camera */
const FOG_NEAR = 5, FOG_FAR = 46;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const angDiff = (a: number, b: number) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** turns the camera's -z onto +x, the way trains and planes face in their own frames */
const LOOK_FWD = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
const TMP_Q = new Quaternion(), TMP_Q2 = new Quaternion(), TMP_E = new Vector3();

/**
 * A train cab or plane cockpit to ride in (render/trains.ts, render/planes.ts): where the eye is and how the vehicle is
 * turned, straight from the pose the renderer drew this frame, so the view never drifts from the model.
 */
export interface CabEye {
  /** which vehicle ('t3:0', 'p1:4012'): a new key starts a new ride */
  key: string;
  x: number; y: number; z: number;
  /** the vehicle's orientation (+x forward, +y up), so pitch and bank carry into the view */
  q: Quaternion;
  /** HUD: the vehicle's name and a few lines of what it is doing */
  label: string;
  lines: string[];
  /** how far the view reaches (a plane's is much further than the street's) */
  fogFar?: number;
  /** look down a little from the vehicle's axis, radians */
  dip?: number;
  /** cab sway amplitude (0 none) and a per-vehicle seed for its phase */
  sway?: number; seed?: number;
  /** an aircraft: show the flight instruments (render/instruments.ts), calibrated to the game's speed and altitude scales */
  instruments?: AircraftCal;
  /** a train cab: draw the driver's cab around the view (render/vehicleInterior.ts) */
  interior?: TrainCabFeed;
  /** a boat's wheelhouse (or open helm): draw its window frames and console around the view (render/vehicleInterior.ts) */
  helm?: HelmFeed;
  /** a tube train: ride through the tunnel instead of the street (render/tunnelRide.ts); the surface is not drawn */
  tunnel?: TunnelFeed;
  /** a passenger's seat: draw the bus, carriage, tube car or plane cabin around the view (render/passengerInterior.ts) */
  passenger?: PassengerFeed;
  /** bumped whenever `label` or `lines` change (an eye built once and reused): the HUD is rewritten only then */
  rev?: number;
}

export interface FpvHooks {
  citizens: CitizensView;
  /** the id of the selected person or road vehicle, 0 when none */
  selected(): number;
  /** the selected train's cab or plane's cockpit, when one is selected */
  cab(): CabEye | null;
  /** the indicator lamps of a road vehicle that are lit right now: -1 left, 1 right, 2 both, 0 none (the dashboard arrows; the caller does the blinking) */
  indicator?(id: number): number;
  /** the mode changed (including to 'off' once a fade-out has finished) */
  onChange(mode: FpvMode): void;
  /** a short message for the player ("they are indoors") */
  notify(msg: string): void;
  /**
   * What a tube cab ride needs: the under layer's byte at a tile, and the groups of the main scene that are drawn
   * over the tunnel (the tube trains, the crowds on the platforms).
   */
  tunnel?: { underAt(x: number, y: number): number; keep(): Object3D[] };
  /** the game clock in ticks (fractional), for a night out's build-up and ease-off (render/nightout.ts); absent: the lighting hour */
  clock?(): number;
  /**
   * A passenger's seat in the vehicle the inspect sits them in (render/passenger.ts), posed from this frame's drawing, or null when
   * the vehicle is not drawn here. The eye may be one object reused from call to call.
   */
  seat?(ab: Aboard, rider: number, info: CitizenInfo): CabEye | null;
  /** the view sat down in a vehicle (or got up from one: null), so the renderer can keep that vehicle's own body out of the eye */
  riding?(ab: Aboard | null): void;
}

/**
 * First-person view from the selected person or vehicle: a 16:9 inset (bottom-right) or the whole window.
 *
 * The camera sits at eye height on the agent's rendered position and looks along its smoothed heading, leaning
 * toward the next corner of the planned route; walkers bob, drivers sway, and every input is low-pass filtered so
 * the 5 Hz position updates never jerk the view. The agent's own body is on layer 1 (see CitizensView), which this
 * camera does not render. The inset is drawn into a small render target and blitted every frame, so it can be
 * refreshed every other frame on a slow machine without flickering.
 *
 * Indoors (at home, at work, out at a venue, as the latest inspect says) the view is of the room they are in instead,
 * a small scene of its own from render/interiors.ts, built on the way in and disposed on the way out; going in or out
 * of the door fades through black.
 */
export class Fpv {
  mode: FpvMode = 'off';
  id = 0;
  readonly camera = new PerspectiveCamera(70, 16 / 9, 0.02, 160);
  /** fade 0..1 (1 = fully shown); a fade-out ends in 'off' */
  level = 0;
  /** a tube cab ride is on (main.ts then keeps the underground trains and platform crowds alive for it) */
  get tunnelOn() { return this.inTunnel && this.mode !== 'off'; }
  /** frames drawn / skipped, for the FPS probe */
  rendered = 0; skipped = 0;
  /** milliseconds the FPV render itself took last time (CPU side, includes GL submission) */
  lastCost = 0;

  /** running average of the frame time in ms, which decides whether the inset refreshes every frame */
  avgMs = 16;
  private want = 0;
  private info: CitizenInfo | null = null;
  private hud: HTMLElement;
  private body: HTMLElement;
  private fade: HTMLElement;
  private inst: Instruments;
  private car: CarInterior;
  private train: TrainCab;
  private helm: HelmCab;
  /** a passenger's bus, carriage, tube car or cabin: made on first use */
  private pax: PassengerInterior | null = null;
  /** the hand-over between the street follow and a seat (render/passenger.ts), and the vehicle of the seat on show */
  private hand = handover();
  private hout = handOut();
  private hin: HandIn = { eye: false, aboard: '', found: false, foundShown: false, riding: false, level: 0, dt: 0 };
  private seatAb: Aboard | null = null;
  private hudRev = -1;
  /** the car interior was drawn this frame (otherwise it is hidden) */
  private carOn = false;
  private lastHeading = 0;
  private carFeed: CarFeed = { id: 0, height: 0.16, speedTps: 0, yawRate: 0, indicator: 0 };
  private hudKey = '';
  private hudAt = 0;
  // smoothed pose
  private ready = false;
  private px = 0; private pz = 0; private py = 0.3;
  private heading = 0;
  private speed = 0;
  /** speed averaged over a second or so, for the lead that cancels the position filter's lag */
  private lead = 0;
  private bobAmt = 0;
  private lost = 0;
  private everTravelled = false;
  private idleSince = 0;
  // inset drawing
  private rt: WebGLRenderTarget | null = null;
  private blit: Mesh;
  private blitScene = new Scene();
  private blitCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** the swim's blur: the scene boxed down to a half or a quarter of its size across (blurA), then softened there by a disc (blurB); see blurPasses */
  private blurA: WebGLRenderTarget | null = null;
  private blurB: WebGLRenderTarget | null = null;
  /** which of them the blit reads as the soft picture, and the radius (in its texels) still to take in the blit's own taps */
  private soft: WebGLRenderTarget | null = null; private softR = 0;
  private passScene = new Scene();
  private passMesh!: Mesh;
  private passDown!: ShaderMaterial;
  private passDisc!: ShaderMaterial;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private winW = 0; private winH = 0;
  private parity = 0;
  private sizeTag = '';
  // riding in a cab: its key and smoothed orientation
  private cabKey = '';
  private cabQ = new Quaternion();
  private fogFar = FOG_FAR;
  /** the weather's fog and rain shorten the street's view (main.ts sets it each frame: 1 clear, down to about 0.2 in thick fog) */
  fogMul = 1;
  // riding a tube train: the tunnel scene, drawn in place of the street
  private tunnel: TunnelRide | null = null;
  private inTunnel = false;
  private clr = new Color();
  // indoors: the room on show, the selected citizen's latest inspect (whoever it is for), and a fade-out under way
  private room: Interior | null = null;
  /** a room shown on its own, with nobody selected (debug, screenshots and the TV check: `preview`) */
  private shown: Interior | null = null;
  private latest: CitizenInfo | null = null;
  private hold = false;
  private sky = new Color(0x9fc4e8);
  // a night out (render/nightout.ts): the swim's strength as the view shows it (eased toward the evening's), and the evening so far
  private night: NightOut | null = null;
  swim = 0;
  /** the sway's phase in radians: it advances at a rate that slows as they get drunker, so it never jumps when the strength moves */
  private swimT = 0;
  /** which of FULL_SWIM_SCALES the full window's target is drawn at (0 sober) */
  private scaleTier = 0;
  /** the swim's small blur targets are the scene's size over this (2 for a light blur, 4 for a heavy one) */
  private blurDiv = 4;
  /** debug and screenshots: force the swim's strength (0..1) whoever is watched; null: from the evening */
  swimDebug: number | null = null;

  constructor(private hooks: FpvHooks) {
    this.hud = document.createElement('div');
    this.hud.id = 'fpv';
    this.hud.className = 'hidden';
    this.hud.innerHTML = `<div class="ftop"><span class="fname"></span><span class="fbtns"><button class="chip" id="fpvSwap" title="Toggle full window (O)"></button><button class="chip" id="fpvClose" title="Close first person (I)">✕</button></span></div>`
      + `<div class="fbody"></div><div class="fhint">Esc to exit</div><div class="ffade"></div>`;
    this.body = this.hud.querySelector('.fbody')!;
    this.fade = this.hud.querySelector('.ffade')!;
    this.inst = new Instruments(this.hud, this.fade);
    // behind the title and the text block, so those stay readable over the dash
    this.car = new CarInterior(this.hud, this.hud.firstElementChild);
    this.train = new TrainCab(this.hud, this.hud.firstElementChild);
    this.helm = new HelmCab(this.hud, this.hud.firstElementChild);
    // between the canvas and the rest of the UI, so in full-window mode the panels stay clickable but the world does not
    document.body.insertBefore(this.hud, document.getElementById('ui'));
    this.hud.querySelector<HTMLElement>('#fpvClose')!.onclick = () => this.end();
    this.hud.querySelector<HTMLElement>('#fpvSwap')!.onclick = () => this.toggleFull();

    this.blit = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
      uniforms: {
        map: { value: null }, mapB: { value: null }, uSoft: { value: new Vector3() }, fade: { value: 1 }, sky: { value: new Color() },
        // the night out's swim: strength, the sway's phase (radians), the citizen's period (unused by the shader)/phase/sway/double image, blur/ratio/mix, and the target's size
        uSwim: { value: 0 }, uT: { value: 0 }, uS: { value: new Vector4(4, 0, 8, 16) }, uS2: { value: new Vector3(9, 0.7, 0.4) }, uRes: { value: new Vector2(1, 1) },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      // Scene pixels are tone-mapped here (a render target is not), but the sky is a plain clear colour on screen, so
      // where the picture is empty (alpha 0) the sky colour goes straight out, exactly as in the overhead view.
      fragmentShader: `uniform sampler2D map; uniform sampler2D mapB; uniform float fade; uniform vec3 sky; varying vec2 vUv;
        uniform float uSwim; uniform float uT; uniform vec4 uS; uniform vec3 uS2; uniform vec2 uRes;
        uniform vec3 uSoft; // x: radius of a disc taken here over mapB, in its texels (0: mapB is soft already); yz: its texel
        vec4 soft(vec2 uv) {
          vec4 acc = texture2D(mapB, uv);
          if (uSoft.x <= 0.0) return acc;
          for (int i = 1; i <= 8; i++) {
            float a = float(i) * 2.3999632;
            acc += texture2D(mapB, uv + vec2(cos(a), sin(a)) * (sqrt(float(i) / 8.0) * uSoft.x) * uSoft.yz);
          }
          return acc / 9.0;
        }
        void main() {
          vec4 s;
          if (uSwim > 0.002) {
            // A night out (render/nightout.ts): the picture sways on a slow rhythm of the citizen's own, a second image drifts
            // from one side of the first to the other, and the whole softens, all of it growing with how long they have been out.
            // Heavily drunk, the picture now and then lurches to one side and comes back. Sizes are pixels at 720p at full
            // strength, scaled to the view and to the strength. The soft picture is the scene blurred in two small passes
            // (blurPasses), so a heavy blur costs a few taps a pixel here, not a few dozen.
            float k = uRes.y / 720.0;
            vec2 px = 1.0 / uRes;
            float t = uT + uS.y;
            vec2 off = vec2(sin(t + vUv.y * 5.0) + 0.5 * sin(t * uS2.y * 1.7 + vUv.y * 11.0), cos(t * uS2.y + vUv.x * 4.0)) * uS.z * uSwim * k * px;
            float lu = pow(0.5 + 0.5 * sin(t * 0.37 + 1.3), 5.0) * smoothstep(0.55, 1.0, uSwim);
            off += vec2(sin(t * 0.23 + 2.0), 0.6 * cos(t * 0.19)) * lu * 12.0 * k * px;
            vec2 uv = vUv + off;
            float w = clamp(uS2.x * uSwim / 2.0, 0.0, 1.0);
            s = w < 1.0 ? mix(texture2D(map, uv), soft(uv), w) : soft(uv);
            // double vision: the second image slides from one side of the first to the other
            float g = uS.w * uSwim * k * px.x * sin(t * 0.5 + 1.0);
            vec2 gc = uv + vec2(g, 0.35 * g * uRes.x / uRes.y);
            s = mix(s, w < 1.0 ? mix(texture2D(map, gc), soft(gc), w) : soft(gc), uS2.z * pow(uSwim, 0.75));
          } else s = texture2D(map, vUv);
          vec3 c = toneMapping(s.rgb / max(s.a, 1e-3));
          gl_FragColor = vec4(mix(sky, c, s.a) * fade, 1.0);
          #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false,
    }));
    this.blit.frustumCulled = false;
    this.blitScene.add(this.blit);
    const passVs = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    // scene -> a half or a quarter size across: the exact average of each block of texels. (A few pixels of the scene are NaN, from
    // some material's lighting: alone that is a black dot, but a box would spread it into a black patch, so those are left out.)
    this.passDown = new ShaderMaterial({
      uniforms: { map: { value: null }, uSize: { value: new Vector2(1, 1) }, uDiv: { value: 4 } }, vertexShader: passVs,
      fragmentShader: `uniform sampler2D map; uniform vec2 uSize; uniform float uDiv;
        void main() {
          int div = int(uDiv);
          ivec2 base = ivec2(gl_FragCoord.xy) * div;
          vec4 s = vec4(0.0); float n = 0.0;
          for (int y = 0; y < 4; y++) {
            if (y >= div) break;
            for (int x = 0; x < 4; x++) {
              if (x >= div) break;
              ivec2 p = base + ivec2(x, y);
              if (p.x >= int(uSize.x) || p.y >= int(uSize.y)) continue;
              vec4 c = texelFetch(map, p, 0);
              if (any(isnan(c)) || any(isinf(c))) continue;
              s += c; n += 1.0;
            }
          }
          gl_FragColor = s / max(n, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    // the small picture softened by a disc of taps on a golden-angle spiral, radius uR in its own texels (a texel or more: the box's steps go)
    this.passDisc = new ShaderMaterial({
      uniforms: { map: { value: null }, uTexel: { value: new Vector2(1, 1) }, uR: { value: 1 } }, vertexShader: passVs,
      fragmentShader: `uniform sampler2D map; uniform vec2 uTexel; uniform float uR; varying vec2 vUv;
        const int TAPS = ${BLUR_TAPS};
        void main() {
          vec4 acc = texture2D(map, vUv);
          float wsum = 1.0;
          float n = clamp(5.0 + uR * 2.0, 5.0, float(TAPS));
          for (int i = 1; i <= TAPS; i++) {
            float fi = float(i);
            if (fi > n) break;
            float a = fi * 2.3999632;
            acc += texture2D(map, vUv + vec2(cos(a), sin(a)) * (sqrt(fi / n) * uR) * uTexel);
            wsum += 1.0;
          }
          gl_FragColor = acc / wsum;
        }`,
      depthTest: false, depthWrite: false,
    });
    this.passMesh = new Mesh(new PlaneGeometry(2, 2), this.passDown);
    this.passMesh.frustumCulled = false;
    this.passScene.add(this.passMesh);

    window.addEventListener('keydown', this.key);
  }

  // ---- control ------------------------------------------------------------------------------

  /** I: open or close the inset (from full window it drops back to the inset). */
  toggleInset() { if (this.mode === 'inset' && this.want) this.end(); else this.start('inset'); }
  /** O: open the full window, or go back to the inset from it. */
  toggleFull() { if (this.mode === 'full' && this.want) this.start('inset'); else this.start('full'); }

  start(mode: 'inset' | 'full') {
    const cab = this.hooks.cab();
    if (cab) {
      if (this.mode === 'off' || this.cabKey !== cab.key) { this.ready = false; this.lost = 0; this.info = null; if (this.mode === 'off') this.level = 0; }
      this.cabKey = cab.key; this.id = 0; this.leaveRoom(); this.leaveSeat();
      this.want = 1;
      this.setMode(mode);
      return;
    }
    this.cabKey = '';
    const id = this.hooks.selected();
    if (!id) { this.hooks.notify('Select a person or vehicle first, then press I or O for their view'); return; }
    if (!this.viewable(id)) { this.hooks.notify('They are indoors, with nothing to see yet'); return; }
    if (this.mode === 'off' || this.id !== id) {
      this.ready = false; this.lost = 0; this.everTravelled = false; this.idleSince = 0; if (this.mode === 'off') this.level = 0;
      this.leaveRoom(); this.leaveSeat(); this.info = this.latest?.id === id ? this.latest : null;
    }
    this.id = id;
    this.want = 1;
    this.setMode(mode);
  }

  /**
   * Debug (msc.fpv.preview, the TV screenshots and timings): show a home's lounge (or a pub) full-window with nobody
   * selected, built for a made-up household whose set is on at the hour; `null` goes back to the game view.
   */
  preview(room: 'lounge' | 'bar' | null, seed = 1, hour = sceneUniforms.uHour.value): string {
    this.shown?.dispose(); this.shown = null;
    if (!room) return '';
    let hh = seed;
    const info = (h: number): CitizenInfo => ({
      id: 9_900_000 + seed, name: 'Preview', role: 'citizen', mode: 'none', activity: 'at home, retired', status: 'idle', waitTicks: 0,
      home: { x: seed * 3, y: seed * 5, label: 'home', parcel: '' }, life: { age: 70, stage: 'retired', household: { id: h, members: [] } },
    } as unknown as CitizenInfo);
    // a household whose set is on now
    for (let i = 0; i < 64 && room === 'lounge' && !tvOnAt(homeSeedOf(info(hh)), hour, true); i++) hh++;
    const ci = info(hh);
    const place: Place = room === 'lounge' ? { room, seed: homeSeedOf(ci), key: 'preview' } : { room, seed: (seed * 31 + 7) | 0, key: 'preview' };
    this.shown = new Interior(place, ci, hour);
    this.layout(true);
    return this.shown.label;
  }
  /** the previewed room (the TV check reads its screens) */
  get previewRoom() { return this.shown; }

  /** The room on show's line ("in the lounge, watching Quiz Night on Civitas 1"), '' outdoors. */
  get roomLabel() { return this.room?.label ?? ''; }

  /** Fade out and return to the overhead view. */
  end() { if (this.mode !== 'off') this.want = 0; }

  /** The selection changed: follow the new one (person, vehicle, train or plane) in the same mode, or fade out when it was cleared. */
  retarget() {
    if (this.mode === 'off') return;
    const cab = this.hooks.cab();
    if (cab) {
      if (cab.key === this.cabKey) return;
      this.cabKey = cab.key; this.id = 0; this.info = null; this.ready = false; this.lost = 0; this.leaveRoom(); this.leaveSeat();
      this.level = Math.min(this.level, 0.2);
      return;
    }
    const id = this.hooks.selected();
    if (!id) { this.end(); return; }
    if (id === this.id && !this.cabKey) return;
    if (!this.viewable(id)) { this.end(); return; }
    this.cabKey = '';
    this.id = id; this.ready = false; this.lost = 0; this.everTravelled = false; this.idleSince = 0;
    this.info = this.latest?.id === id ? this.latest : null;
    this.leaveRoom(); this.leaveSeat();
    this.level = Math.min(this.level, 0.2);
  }

  setInfo(info: CitizenInfo) {
    this.latest = info;
    this.latestFeed = info.night ? { ...info.night, at: this.hooks.clock ? this.hooks.clock() / TICKS_PER_HOUR : sceneUniforms.uHour.value } : undefined;
    if (info.id === this.id) { this.info = info; this.hudKey = ''; }
  }

  /** on the street, aboard a bus or train, or indoors somewhere with a room to show (or not inspected yet, so worth waiting for) */
  private viewable(id: number) {
    if (this.hooks.citizens.eyeOf(id)) return true;
    return this.latest?.id !== id || !!this.latest.aboard || !!placeOf(this.latest, sceneUniforms.uHour.value);
  }

  private leaveRoom() { this.room?.dispose(); this.room = null; this.hold = false; }
  /** back to the street follow: put the passenger's interior away and let the renderer draw their vehicle again */
  private leaveSeat() {
    if (this.seatAb) { this.seatAb = null; this.hooks.riding?.(null); }
    this.hand.shown = 'street'; this.hand.key = ''; this.hand.lost = 0;
    this.pax?.hide();
    this.viewOffset(null);
  }
  /**
   * A passenger's eye renders only the box of the view its windows show (PassengerInterior.region): the camera's frustum is
   * narrowed to it (a view offset), so culling and the building tiers skip what the cabin's walls hide, and render() keeps the
   * viewport and scissor to it. Null: the whole view again.
   */
  private viewOffset(r: { on: boolean; x: number; y: number; w: number; h: number } | null) {
    const o = this.vo, c = this.camera, vw = this.viewW(), vh = this.viewH();
    if (!r?.on) { if (o.on) { o.on = false; c.clearViewOffset(); } return; }
    if (o.on && o.x === r.x && o.y === r.y && o.w === r.w && o.h === r.h && o.vw === vw && o.vh === vh) return;
    o.on = true; o.x = r.x; o.y = r.y; o.w = r.w; o.h = r.h; o.vw = vw; o.vh = vh; o.fresh = true;
    c.setViewOffset(vw, vh, r.x, r.y, r.w, r.h);
  }
  private vo = { on: false, x: 0, y: 0, w: 0, h: 0, vw: 0, vh: 0, fresh: false };

  private setMode(mode: FpvMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    document.body.classList.toggle('fpv-full', mode === 'full');
    document.body.classList.toggle('fpv-on', mode !== 'off');
    this.hud.className = mode === 'off' ? 'hidden' : mode;
    if (mode === 'off') { this.inst.hide(); this.car.hide(); this.train.hide(); this.helm.hide(); this.leaveSeat(); }
    const swap = this.hud.querySelector<HTMLElement>('#fpvSwap')!;
    swap.textContent = mode === 'full' ? '▣ inset' : '⤢ full';
    this.layout(true);
    this.hooks.onChange(mode);
  }

  private key = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyI') this.toggleInset();
    else if (e.code === 'KeyO') this.toggleFull();
    else if (e.code === 'Escape' && this.mode === 'full') this.end();
  };

  // ---- per frame ----------------------------------------------------------------------------

  /** Advance the camera, fade and HUD; call once per frame after the citizens have moved. */
  update(now: number, dt: number, route: number[] | null) {
    this.avgMs += (dt * 1000 - this.avgMs) * 0.05;
    if (this.shown) { this.shown.update(now, dt, sceneUniforms.uHour.value, this.sky); return; }
    if (this.mode === 'off') { this.swim = 0; return; }
    this.swimStep(dt);
    this.level = clamp(this.level + (this.want && !this.hold ? 1 : -1) * dt / (this.room || this.hold ? ROOM_FADE : FADE_SECONDS), 0, 1);
    if (!this.want && this.level <= 0) {
      this.id = 0; this.info = null; this.cabKey = '';
      this.leaveRoom();
      this.tunnelFeed(null, now);
      this.setMode('off');
      return;
    }
    if (this.cabKey) {
      const cab = this.hooks.cab();
      if (!cab || cab.key !== this.cabKey) {
        // the train went out of service or the plane left: hold the last view for a moment, then fade out
        this.lost += dt;
        if (this.lost > 0.35) this.end();
      } else {
        this.lost = 0;
        this.ride(cab, now, dt);
        this.tunnelFeed(cab, now);
        this.cabHud(now, cab);
        this.instruments(cab, now, dt);
        this.car.hide();
        if (cab.interior) this.train.update(cab.interior, now, dt, this.viewW(), this.viewH(), this.level); else this.train.hide();
        if (cab.helm) this.helm.update(cab.helm, now, dt, this.viewW(), this.viewH(), this.level); else this.helm.hide();
        if (cab.passenger) { this.paxOf().update(cab.passenger, now, dt, this.viewW(), this.viewH(), this.level); this.viewOffset(this.pax!.region); } else if (this.pax) { this.pax.hide(); this.viewOffset(null); }
      }
      return;
    }
    const eye = this.hooks.citizens.eyeOf(this.id);
    // aboard a bus, a train or a tube train, or fading out of one: the passenger's seat (render/passenger.ts)
    if ((this.info?.aboard || this.hand.shown === 'seat') && this.passenger(eye !== null, now, dt)) return;
    this.fogFar = FOG_FAR;
    this.tunnelFeed(null, now);
    this.inst.hide(); this.train.hide(); this.helm.hide();
    this.hud.classList.remove('inst');
    this.carOn = false;
    const hour = sceneUniforms.uHour.value;
    if (eye && !eye.travelling) this.idleSince += dt; else this.idleSince = 0;
    // indoors once the street has lost them, or they have stood at the door a moment with the inspect saying they are in
    const place = this.info && (!eye || !eye.travelling) ? placeOf(this.info, hour) : null;
    this.hold = false;
    if (place && (!eye || this.room || this.idleSince > 0.8)) {
      this.lost = 0;
      if (!this.room || this.room.key !== place.key || this.room.stale(this.info!, hour)) {
        // a different room (or someone came in): fade the old view out, then build the new one and fade it in
        if (this.level > 0 && this.ready) this.hold = true;
        else { this.room?.dispose(); this.room = new Interior(place, this.info!, hour); this.ready = true; }
      }
      if (this.room) this.room.update(now, dt, hour, this.sky);
      else if (eye) this.follow(eye, now, dt, route);
    } else if (eye) {
      this.lost = 0;
      if (this.room) {
        // out of the door: fade the room out, then pick up the street view
        if (this.level > 0) { this.hold = true; this.room.update(now, dt, hour, this.sky); }
        else { this.leaveRoom(); this.ready = false; this.everTravelled = false; }
      }
      if (!this.room) {
        this.follow(eye, now, dt, route);
        // arrived somewhere with no room to show: a trip that was under way has finished and they have stood still for a bit
        if (eye.travelling) this.everTravelled = true;
        else if (this.everTravelled && this.idleSince > 3) this.end();
      }
    } else {
      // gone from the street with the inspect not yet saying where (it refreshes once a second): fade to dark and wait
      this.lost += dt;
      if (this.room) this.room.update(now, dt, hour, this.sky);
      else this.hold = this.lost > 0.35;
      // boarding takes up to a second to show in the inspect: wait longer for someone whose trip rides
      if (this.lost > (this.room ? 8 : this.info?.mode === 'ride' || this.info?.legKinds?.includes('ride') ? RIDE_WAIT : LOST_WAIT)) this.end();
    }
    if (!this.carOn) this.car.hide();
    this.updateHud(now, eye?.speed ?? 0);
  }

  private paxOf() { return (this.pax ??= new PassengerInterior(this.hud, this.hud.firstElementChild)); }

  /**
   * A followed citizen aboard a bus, a train or a tube train (CitizenInfo.aboard): the hand-over (render/passenger.ts handStep) fades
   * through black from the street into their seat, from one vehicle to the next, and back to the street once they are off. The seat is
   * ridden like a cab (`ride`), through the tunnel for a tube car. False when this frame is the street follow's, which then runs as usual.
   */
  private passenger(eyeOn: boolean, now: number, dt: number): boolean {
    const info = this.info, ab = info?.aboard, key = aboardKey(ab);
    const want = ab && info && this.hooks.seat ? this.hooks.seat(ab, this.id, info) : null;
    const h = this.hand;
    if (ab && h.shown === 'seat' && h.key === key) this.seatAb = ab; // the same vehicle, its latest load and next stop
    let shown = h.shown === 'seat' && h.key === key ? want : null;
    // fading out of a seat the inspect no longer names: pose that one (the eye object may be the one just used)
    if (h.shown === 'seat' && h.key !== key && this.seatAb && info && this.hooks.seat) shown = this.hooks.seat(this.seatAb, this.id, info);
    const i = this.hin;
    i.eye = eyeOn; i.aboard = key; i.found = want !== null; i.foundShown = shown !== null;
    i.riding = info?.mode === 'ride' || !!info?.legKinds?.includes('ride'); i.level = this.level; i.dt = dt;
    const o = handStep(h, i, this.hout);
    if (o.end) this.end();
    this.hold = o.hold;
    if (o.switched) {
      this.ready = false;
      const next = o.draw === 'seat' && ab ? ab : null;
      if (aboardKey(next ?? undefined) !== aboardKey(this.seatAb ?? undefined)) { this.seatAb = next; this.hooks.riding?.(next); }
      if (o.draw === 'street') { this.pax?.hide(); this.viewOffset(null); this.everTravelled = false; this.idleSince = 0; return false; }
      return true; // dark this frame; the seat is posed from the next
    }
    if (o.draw === 'street') return false;
    // the seat, or (nothing to pose) the picture held while it fades
    this.inst.hide(); this.car.hide(); this.train.hide(); this.helm.hide();
    if (this.hud.classList.contains('inst')) this.hud.classList.remove('inst');
    if (o.draw === 'seat' && shown) {
      this.lost = 0;
      this.ride(shown, now, dt);
      this.tunnelFeed(shown, now);
      this.cabHud(now, shown);
      if (shown.passenger) { this.paxOf().update(shown.passenger, now, dt, this.viewW(), this.viewH(), this.level); this.paxDoors = shown.passenger.doors; this.viewOffset(this.pax!.region); }
    }
    return true;
  }
  /** the seat on show, for the ride's sound (main.ts): its vehicle's ride key, its kind, where the eye is and whether the doors are open */
  get passengerRide(): { key: string; kind: 'bus' | 'train' | 'metro'; x: number; z: number; doors: boolean } | null {
    const ab = this.seatAb;
    if (this.mode === 'off' || this.hand.shown !== 'seat' || !ab) return null;
    return { key: this.hand.key, kind: ab.mode === 'bus' ? 'bus' : ab.mode === 'rail' ? 'train' : 'metro', x: this.camera.position.x, z: this.camera.position.z, doors: this.paxDoors };
  }
  /** the doors of the seat's vehicle are open, as its feed last said */
  private paxDoors = false;

  /**
   * A night out (render/nightout.ts): the swim's strength follows the evening read from the citizen's activity line, eased so
   * a new inspect never steps it. Nothing in a cab, nor for a vehicle, nor for anyone indoors at the cinema (the rules say so).
   */
  private swimStep(dt: number) {
    const info = this.info;
    let target = 0;
    if (!this.cabKey && info && info.id === this.id && info.role === 'citizen') {
      if (this.night?.id !== this.id) this.night = new NightOut(this.id);
      const hours = this.hooks.clock ? this.hooks.clock() / TICKS_PER_HOUR : sceneUniforms.uHour.value;
      // the server's exact hours at the venue (as of the inspect, once a second); the clock carries them on between
      const feed = info === this.latest ? this.latestFeed : undefined;
      target = this.night.update(info.activity, hours, info.tripTotal ? clamp((info.tripDone ?? 0) / info.tripTotal, 0, 1) : undefined, feed);
    } else this.night = null;
    if (this.swimDebug !== null) target = this.swimDebug;
    this.swim += (target - this.swim) * (1 - Math.exp(-dt * 1.2));
    if (target === 0 && this.swim < 0.003) this.swim = 0;
    // the sway slows as they get drunker (a period of the citizen's own, up to 1.8 times longer at full strength)
    const sh = this.night?.shape ?? swimShape(this.id);
    this.swimT += dt * 6.2831853 / (sh.period * (1 + 0.8 * this.swim));
  }
  /** the latest inspect's `night` with the game hour it came in at */
  private latestFeed: NightFeed | undefined;
  /** the swim is on (the HUD says so, the picture swims) */
  get tipsy() { return this.swim > 0.06; }

  private follow(eye: NonNullable<ReturnType<CitizensView['eyeOf']>>, now: number, dt: number, route: number[] | null) {
    const id = this.id;
    const fx = Math.cos(eye.ang), fz = -Math.sin(eye.ang);
    // sit a little forward of the middle of a car (where the driver is) and just ahead of a walker's body
    const lead = eye.car ? 0.04 : 0.025;
    const tx = eye.x + fx * lead, tz = eye.z + fz * lead;

    // corner look-ahead: find the next route tile in front of us; if the path turns there, lean into the turn as it nears
    let want = eye.ang;
    if (route && eye.travelling && route.length >= 4) {
      for (let i = 0; i + 3 < route.length; i += 2) {
        const dx = route[i] + 0.5 - eye.x, dz = route[i + 1] + 0.5 - eye.z, d = Math.hypot(dx, dz);
        if (d < 0.55 || (dx * fx + dz * fz) / d < 0.3) continue;
        const turn = angDiff(Math.atan2(-(route[i + 3] - route[i + 1]), route[i + 2] - route[i]), eye.ang);
        if (Math.abs(turn) > 0.25) want = eye.ang + turn * 0.4 * clamp(1 - d / 2.4, 0, 1);
        break;
      }
    }

    const POS_RATE = 7;
    const k = 1 - Math.exp(-dt * POS_RATE); // position: filtered, so late or bunched tick updates never jerk the view
    const kh = 1 - Math.exp(-dt * 5.5); // heading: slower, so corners swing rather than snap
    if (!this.ready) {
      this.px = tx; this.pz = tz; this.heading = this.lastHeading = want; this.speed = this.lead = eye.speed; this.bobAmt = 0; this.ready = true;
    } else {
      // a low-pass filter trails a moving body by speed / rate; lead by that much (from the smoothed speed) to cancel it
      const lag = this.lead / POS_RATE;
      this.px += (tx + fx * lag - this.px) * k; this.pz += (tz + fz * lag - this.pz) * k;
      this.heading += angDiff(want, this.heading) * kh;
      this.speed += (eye.speed - this.speed) * (1 - Math.exp(-dt * 4));
      this.lead += (eye.speed - this.lead) * (1 - Math.exp(-dt * 1.5));
    }
    const moving = clamp(this.speed / 0.8, 0, 1);
    this.bobAmt += (moving - this.bobAmt) * (1 - Math.exp(-dt * 5));

    // bob (walkers, in step with the body) and sway (cars); amplitude differs per agent
    const amp = 0.75 + 0.5 * hash2(id, 31);
    let y = eye.height, roll = 0, pitch = eye.car ? 0 : -0.045, yawSway = 0;
    if (eye.car) {
      const ph = hash2(id, 33) * 6.28;
      roll = Math.sin(now * 0.0011 + ph) * 0.007 * amp * this.bobAmt;
      y += Math.sin(now * 0.0123 + ph) * 0.0012 * this.bobAmt;
      yawSway = Math.sin(now * 0.0007 + ph) * 0.012 * this.bobAmt;
      pitch += Math.sin(now * 0.0019 + ph) * 0.004 * this.bobAmt;
    } else {
      const s = Math.sin(now * eye.pace + id);
      y += Math.abs(s) * 0.014 * amp * this.bobAmt;
      roll = s * 0.014 * amp * this.bobAmt;
      pitch += Math.cos(now * eye.pace * 2 + id) * 0.006 * this.bobAmt;
      yawSway = s * 0.01 * amp * this.bobAmt;
    }
    const h = this.heading + yawSway;
    const c = this.camera;
    c.position.set(this.px, y, this.pz);
    c.lookAt(this.px + Math.cos(h) * 10, y + Math.tan(pitch) * 10, this.pz - Math.sin(h) * 10);
    c.rotateZ(roll);
    this.py = y;
    // the inside of a car, van, truck or bus; walkers have none
    if (eye.car) {
      const yawRate = dt > 0 ? angDiff(this.heading, this.lastHeading) / dt : 0;
      const f = this.carFeed;
      f.id = id; f.height = eye.height; f.speedTps = this.speed; f.yawRate = clamp(yawRate, -4, 4); f.color = eye.color; f.indicator = this.hooks.indicator?.(id) ?? 0;
      this.car.update(f, now, dt, this.viewW(), this.viewH(), this.level);
      this.carOn = true;
    }
    this.lastHeading = this.heading;
  }

  /** the size of the first-person viewport in CSS pixels: the inset or the whole window */
  private viewW() { return this.mode === 'full' ? this.winW : this.rect.w; }
  private viewH() { return this.mode === 'full' ? this.winH : this.rect.h; }

  /**
   * In a cab: the eye is where the renderer put the cab this frame (a pure function of the smoothed tick, so it is
   * already smooth); only the orientation is filtered, lightly, so bogies swinging through a curve do not twitch the view.
   */
  private ride(cab: CabEye, now: number, dt: number) {
    const c = this.camera;
    // the camera looks down its -z; turn that onto the vehicle's +x, then dip the view and add a little sway
    TMP_Q.copy(cab.q).multiply(LOOK_FWD);
    const ph = (cab.seed ?? 0) * 6.28, sway = cab.sway ?? 0;
    TMP_E.set(1, 0, 0);
    TMP_Q.multiply(TMP_Q2.setFromAxisAngle(TMP_E, -(cab.dip ?? 0) + Math.sin(now * 0.0017 + ph) * 0.004 * sway));
    TMP_E.set(0, 0, 1);
    TMP_Q.multiply(TMP_Q2.setFromAxisAngle(TMP_E, Math.sin(now * 0.0023 + ph) * 0.008 * sway));
    // a jump (the driver walking to the other cab at a terminus): blink and cut rather than swing round
    if (this.ready && Math.hypot(cab.x - this.px, cab.z - this.pz) > 0.8) { this.ready = false; this.level = Math.min(this.level, 0.1); }
    if (!this.ready) { this.cabQ.copy(TMP_Q); this.ready = true; }
    else this.cabQ.slerp(TMP_Q, 1 - Math.exp(-dt * 14));
    c.position.set(cab.x, cab.y + Math.sin(now * 0.011 + ph) * 0.0015 * sway, cab.z);
    c.quaternion.copy(this.cabQ);
    this.px = cab.x; this.pz = cab.z; this.py = cab.y;
    this.fogFar = cab.fogFar ?? FOG_FAR;
  }

  /** Ride the tunnel while the cab is a tube train's; otherwise put the tunnel scene away. */
  private tunnelFeed(cab: CabEye | null, now: number) {
    const hk = this.hooks.tunnel;
    if (cab?.tunnel && hk) {
      this.tunnel ??= new TunnelRide(hk.underAt);
      this.tunnel.update(cab.tunnel, now);
      this.inTunnel = true;
      this.fogFar = TUNNEL_FOG.far;
    } else if (this.inTunnel) {
      this.inTunnel = false;
      this.tunnel?.hide();
    }
  }

  // ---- HUD ----------------------------------------------------------------------------------

  /** The flight instruments, for aircraft only; the `inst` class makes room for them in the text block. */
  private instruments(cab: CabEye, now: number, dt: number) {
    const on = !!cab.instruments;
    if (this.hud.classList.contains('inst') !== on) this.hud.classList.toggle('inst', on);
    const full = this.mode === 'full';
    this.inst.update(cab, now, dt, full ? 'full' : 'inset', full ? this.winW : this.rect.w, full ? this.winH : this.rect.h, this.level);
  }

  private cabHud(now: number, cab: CabEye) {
    if (cab.rev !== undefined) {
      // an eye that says when its words change: nothing to build per frame
      if (this.hudKey === 'rev' && cab.rev === this.hudRev) return;
      this.hudKey = 'rev'; this.hudRev = cab.rev; this.hudAt = now;
    } else {
      const key = `${cab.label}|${cab.lines.join('|')}`;
      if (key === this.hudKey && now - this.hudAt < 500) return;
      this.hudKey = key; this.hudAt = now;
    }
    this.hud.querySelector('.fname')!.textContent = cab.label;
    this.body.innerHTML = cab.lines.map((l, i) => `<div class="${i === 0 ? 'fact' : i === cab.lines.length - 1 ? 'fspd' : 'fdest'}">${esc(l)}</div>`).join('');
  }

  private updateHud(now: number, liveSpeed: number) {
    const i = this.info;
    const queued = i?.status === 'queued';
    const speed = i && i.mode === 'drive' && i.speedPct !== undefined ? `${Math.round(i.speedPct * 100)}% of free flow` : `${this.speed.toFixed(1)} tiles/s`;
    const room = this.room?.label ?? '';
    const tipsy = this.tipsy;
    const word = tipsy ? wordOf(this.swim) : '';
    const key = `${i?.name}|${i?.activity}|${i?.destination?.label}|${queued ? Math.round((i?.waitTicks ?? 0) * 0.6) : -1}|${Math.round(this.speed * 2)}|${speed}|${room}|${word}`;
    if (key === this.hudKey && now - this.hudAt < 500) return;
    this.hudKey = key; this.hudAt = now;
    const name = this.hud.querySelector('.fname')!;
    name.textContent = i ? i.name : '…';
    let html = '';
    const tip = tipsy ? `<div class="ftipsy${word === 'very drunk' ? ' heavy' : ''}">${word}</div>` : '';
    if (i && this.room) html += `<div class="fact">${esc(i.activity)}</div><div class="fspd">${esc(room)}</div>${tip}`;
    else if (i) {
      html += `<div class="fact">${esc(i.activity)}${queued ? ` · <span class="bad">held up ${Math.round(i.waitTicks * 0.6)} min</span>` : ''}</div>`;
      if (i.destination) html += `<div class="fdest">to ${esc(i.destination.label)} <span>(${i.destination.x}, ${i.destination.y})</span></div>`;
      html += `<div class="fspd">${speed}</div>${tip}`;
    }
    this.body.innerHTML = html;
    void liveSpeed;
  }

  // ---- drawing ------------------------------------------------------------------------------

  private layout(force = false) {
    const W = window.innerWidth, H = window.innerHeight;
    if (!force && W === this.winW && H === this.winH) return;
    this.winW = W; this.winH = H;
    const w = Math.round(clamp(W * INSET_FRAC, 240, Math.max(240, W - 2 * INSET_MARGIN)));
    const h = Math.round(w * 9 / 16);
    this.rect = { x: W - w - INSET_MARGIN, y: INSET_MARGIN, w, h }; // y from the bottom, as GL wants
    this.hud.style.setProperty('--iw', `${w}px`);
    this.hud.style.setProperty('--ih', `${h}px`);
  }

  /**
   * Draw the frame. With the FPV off this is just the overhead render; inset adds a second view; full replaces it.
   * `hide` are overhead-only helpers (route line, hover marker) kept out of the street-level view.
   */
  render(renderer: WebGLRenderer, scene: Scene, overhead: PerspectiveCamera, hide: Object3D[]) {
    overhead.layers.enable(1); // the selected agent's own meshes are on layer 1, which the first-person camera skips
    if (scene.background instanceof Color) this.sky.copy(scene.background);
    if (this.shown) {
      const a = this.winW / this.winH;
      this.shown.setAspect(a); this.shown.render(renderer); this.fade.style.opacity = '0';
      return;
    }
    if (this.mode === 'off' || !this.ready) { renderer.render(scene, overhead); this.fade.style.opacity = '0'; return; }
    this.layout();
    const t0 = performance.now();
    const full = this.mode === 'full';
    // a night out swims the picture in the blit (render/nightout.ts), so the full window is drawn into a target too while it does
    const swimming = this.swim > 0.004 && !this.cabKey;
    if (full && !swimming) {
      const a = this.winW / this.winH;
      if (Math.abs(this.camera.aspect - a) > 1e-4) { this.camera.aspect = a; this.camera.updateProjectionMatrix(); }
      this.fade.style.opacity = String(1 - this.level);
      if (this.room) { this.room.setAspect(a); this.room.render(renderer); }
      else if (this.vo.on) {
        // the passenger's windows only (the cabin hides the rest)
        const o = this.vo, gy = this.winH - o.y - o.h;
        renderer.setViewport(o.x, gy, o.w, o.h); renderer.setScissor(o.x, gy, o.w, o.h); renderer.setScissorTest(true);
        this.street(renderer, scene, hide);
        renderer.setScissorTest(false); renderer.setViewport(0, 0, this.winW, this.winH);
      } else this.street(renderer, scene, hide);
      this.rendered++;
      this.lastCost = performance.now() - t0;
      return;
    }
    const { x, y, w, h } = full ? { x: 0, y: 0, w: this.winW, h: this.winH } : this.rect;
    if (full) this.fade.style.opacity = String(1 - this.level);
    else { this.fade.style.opacity = '0'; renderer.render(scene, overhead); }
    // a slow frame: refresh the inset every other frame and re-blit the last picture in between
    if (!full && this.avgMs > 33) this.parity ^= 1; else this.parity = 0;
    if (this.swim > 0.004 && this.scaleTier < FULL_SWIM_UP.length && this.swim >= FULL_SWIM_UP[this.scaleTier]) this.scaleTier++;
    else if (this.scaleTier > 0 && this.swim < FULL_SWIM_UP[this.scaleTier - 1] - 0.04) this.scaleTier--;
    const pr = renderer.getPixelRatio() * (full ? FULL_SWIM_SCALES[this.scaleTier] : 1);
    const tag = `${w}x${h}@${pr}`;
    if (!this.rt || tag !== this.sizeTag) {
      this.rt?.dispose();
      this.rt = new WebGLRenderTarget(Math.round(w * pr), Math.round(h * pr), { type: HalfFloatType, samples: 4, minFilter: LinearFilter, magFilter: LinearFilter });
      this.sizeTag = tag;
      this.parity = 0;
      this.vo.fresh = true;
    }
    if (this.camera.aspect !== w / h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    const mat = this.blit.material as ShaderMaterial;
    if (this.parity === 0 && this.room) {
      this.room.setAspect(w / h);
      if (!full) renderer.shadowMap.autoUpdate = false; // (the full window has had no overhead pass to refresh the sun's shadow map)
      renderer.setRenderTarget(this.rt);
      this.room.render(renderer);
      renderer.setRenderTarget(null);
      renderer.shadowMap.autoUpdate = true;
      this.rendered++;
    } else if (this.parity === 0) {
      // the overhead pass has just refreshed the sun's shadow map, which is the same for both cameras
      if (!full) renderer.shadowMap.autoUpdate = false; // (the full window has had no overhead pass to refresh the sun's shadow map)
      // leave the sky out of the target (clear to alpha 0); the blit paints it
      const bg = scene.background, alpha = renderer.getClearAlpha();
      if (bg instanceof Color) (mat.uniforms.sky.value as Color).copy(this.inTunnel ? this.clr.setHex(TUNNEL_BG) : bg);
      scene.background = null; renderer.setClearAlpha(0);
      const rt = this.rt;
      if (this.vo.on) {
        // a passenger's windows only: clear the whole target when the box changes, then draw inside the box
        const o = this.vo, sx = rt.width / w, sy = rt.height / h;
        if (o.fresh) { rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height); renderer.setRenderTarget(rt); renderer.clear(); o.fresh = false; }
        rt.viewport.set(Math.floor(o.x * sx), Math.floor((h - o.y - o.h) * sy), Math.ceil(o.w * sx), Math.ceil(o.h * sy));
        rt.scissor.copy(rt.viewport); rt.scissorTest = true;
      } else if (rt.scissorTest) { rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height); }
      renderer.setRenderTarget(rt);
      this.street(renderer, scene, hide);
      renderer.setRenderTarget(null);
      scene.background = bg; renderer.setClearAlpha(alpha);
      renderer.shadowMap.autoUpdate = true;
      this.rendered++;
    } else this.skipped++;
    mat.uniforms.map.value = this.rt.texture;
    if (swimming) this.blurPasses(renderer, this.parity === 0, full);
    mat.uniforms.mapB.value = swimming && this.soft ? this.soft.texture : this.rt.texture;
    (mat.uniforms.uSoft.value as Vector3).set(swimming ? this.softR : 0, this.blurA ? 1 / this.blurA.width : 1, this.blurA ? 1 / this.blurA.height : 1);
    mat.uniforms.fade.value = full ? 1 : this.level; // the full window fades by the overlay above it
    this.swimUniforms(mat, swimming);
    renderer.setViewport(x, y, w, h);
    if (!full) { renderer.setScissor(x, y, w, h); renderer.setScissorTest(true); }
    renderer.render(this.blitScene, this.blitCam);
    if (!full) renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.winW, this.winH);
    this.lastCost = performance.now() - t0;
  }

  /**
   * The swim's blur, in two passes on small targets: the scene (`rt`) boxed down to a half or a quarter of its size across (blurA),
   * then a disc of taps over that small picture (blurB; the inset takes the disc in the blit instead). The final
   * blit mixes the sharp and soft pictures by strength, so a view that is blurred 10 px costs a few taps a pixel of the window
   * instead of three dozen. `fresh`: the scene was drawn this frame (else the last soft picture is reused).
   */
  private blurPasses(renderer: WebGLRenderer, fresh: boolean, full: boolean) {
    const rt = this.rt!;
    // the small picture is half the scene's size across while the blur is light (a blur of a couple of pixels), a quarter once heavy
    if (this.blurDiv === 4 && this.swim < 0.3) this.blurDiv = 2;
    else if (this.blurDiv === 2 && this.swim > 0.36) this.blurDiv = 4;
    const div = this.blurDiv;
    const aw = Math.max(2, Math.ceil(rt.width / div)), ah = Math.max(2, Math.ceil(rt.height / div));
    if (!this.blurA || this.blurA.width !== aw || this.blurA.height !== ah) {
      this.blurA?.dispose(); this.blurB?.dispose();
      const o = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false } as const;
      this.blurA = new WebGLRenderTarget(aw, ah, o); this.blurB = new WebGLRenderTarget(aw, ah, o);
      this.soft = this.blurA; fresh = true;
    }
    if (!fresh) return;
    const [A, B] = [this.blurA, this.blurB!];
    // the disc's radius in the small picture's texels: the blur wanted at 720p (the shader's own sum), at least a texel so the
    // small picture's bilinear steps are smoothed away
    const sh = this.night?.shape ?? swimShape(this.id);
    const radius = Math.max(0.9, sh.blur * this.swim * (rt.height / 720 / div) * 0.85);
    this.passMesh.material = this.passDown;
    this.passDown.uniforms.map.value = rt.texture;
    (this.passDown.uniforms.uSize.value as Vector2).set(rt.width, rt.height);
    this.passDown.uniforms.uDiv.value = div;
    renderer.setRenderTarget(A);
    renderer.render(this.passScene, this.blitCam);
    this.soft = A; this.softR = 0;
    if (full) {
      // the window is many pixels: soften the small picture here, once, so the blit reads it with a tap or two
      this.passMesh.material = this.passDisc;
      this.passDisc.uniforms.map.value = A.texture;
      (this.passDisc.uniforms.uTexel.value as Vector2).set(1 / aw, 1 / ah);
      this.passDisc.uniforms.uR.value = radius;
      renderer.setRenderTarget(B);
      renderer.render(this.passScene, this.blitCam);
      this.soft = B;
    } else this.softR = radius; // the inset is few pixels: the blit takes the disc itself and saves a pass
    renderer.setRenderTarget(null);
  }

  /** The blit's night-out uniforms: this citizen's swim at its strength now (all zero when sober). */
  private swimUniforms(mat: ShaderMaterial, on: boolean) {
    const u = mat.uniforms;
    u.uSwim.value = on ? this.swim : 0;
    if (!on) return;
    const sh = this.night?.shape ?? swimShape(this.id);
    u.uT.value = this.swimT;
    (u.uS.value as Vector4).set(sh.period, sh.phase, sh.amp, sh.ghost);
    (u.uS2.value as Vector3).set(sh.blur, sh.ratio, sh.mix);
    (u.uRes.value as Vector2).set(this.rt!.width, this.rt!.height);
  }

  /** One street-level render of the scene, with the closer fog and the overhead-only helpers hidden. */
  private street(renderer: WebGLRenderer, scene: Scene, hide: Object3D[]) {
    if (this.inTunnel && this.tunnel) { this.tunnelPass(renderer, scene); return; }
    const fog = scene.fog as Fog;
    const near = fog.near, far = fog.far;
    fog.near = FOG_NEAR * this.fogMul; fog.far = Math.min(this.fogFar * this.fogMul, far);
    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    renderer.render(scene, this.camera);
    hide.forEach((o, n) => { o.visible = vis[n]; });
    fog.near = near; fog.far = far;
  }

  /**
   * A tube cab: the tunnel scene (render/tunnelRide.ts) first, then the main scene over it with everything hidden but the
   * groups the tunnel keeps (other tube trains, the crowds on the platforms), their light turned right down and the
   * fog the tunnel's, so a train ahead comes up out of the dark. The depth buffer is shared, so they sit inside the bore.
   */
  private tunnelPass(renderer: WebGLRenderer, scene: Scene) {
    const t = this.tunnel!, fog = scene.fog as Fog;
    const rt = renderer.getRenderTarget();
    t.setView(rt ? rt.height : renderer.getDrawingBufferSize(TMP_V2).y, this.camera.fov);
    const ca = renderer.getClearAlpha();
    renderer.getClearColor(this.clr);
    const clear = this.clr.getHex();
    const bg = scene.background;
    scene.background = null;
    renderer.setClearColor(TUNNEL_BG, 1);
    renderer.render(t.scene, this.camera);
    const keep = new Set(this.hooks.tunnel!.keep());
    const hidden: Object3D[] = [], lit: [Light, number][] = [];
    for (const o of scene.children) {
      if ((o as Light).isLight) { lit.push([o as Light, (o as Light).intensity]); (o as Light).intensity *= TUNNEL_LIGHT; continue; }
      if (keep.has(o) || !o.visible) continue;
      o.visible = false; hidden.push(o);
    }
    const fc = fog.color.getHex(), near = fog.near, far = fog.far;
    fog.color.setHex(TUNNEL_FOG.color); fog.near = TUNNEL_FOG.near; fog.far = TUNNEL_FOG.far;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(scene, this.camera);
    renderer.autoClear = auto;
    fog.color.setHex(fc); fog.near = near; fog.far = far;
    for (const o of hidden) o.visible = true;
    for (const [l, i] of lit) l.intensity = i;
    scene.background = bg;
    renderer.setClearColor(clear, ca);
  }
}
const TMP_V2 = new Vector2();
/** how much of the sun and sky light reaches a tube train in its bore */
const TUNNEL_LIGHT = 0.5;
