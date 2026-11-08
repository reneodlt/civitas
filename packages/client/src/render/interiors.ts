import {
  Scene, Group, Mesh, BoxGeometry, CylinderGeometry, ConeGeometry, SphereGeometry, PlaneGeometry, MeshLambertMaterial, MeshBasicMaterial, ShaderMaterial,
  HemisphereLight, DirectionalLight, PointLight, PerspectiveCamera, Color, Matrix4, Vector3, Frustum,
  type Object3D, type Material, type BufferGeometry, type WebGLRenderer, type Texture,
} from 'three';
import { hash2, familyOf, Zone, LifeStage, VENUE_WORDS, VENUE_TYPES, PARK_ACTIVITY_TEXT, tvOnAt, type CitizenInfo, type VenueType, type ParkActivity } from '@msimcity/shared';
import { Crowd, lookOf, EYE, type Look } from './people';
import { sceneUniforms } from './materials';

/**
 * Procedural interiors for the first-person view (render/fpv.ts): when the selected citizen is indoors, the FPV shows
 * the room they are in instead of the street. Each room is a small scene of its own (boxes, a few lights, the people
 * figures from people.ts), built when the view enters it and disposed when it leaves, so it costs nothing otherwise.
 *
 * Rooms are built in metres; the figures are in tile units, so their crowd sits in a group scaled by 1 / M.
 * Everything is seeded: a home's paint, furniture, layout, plants and pet from the home tile and household, a
 * workplace's from its tile, so the same place always looks the same and no two look alike.
 */

/** tile units per metre (people.ts figures: a scale-1 adult's eyes at EYE tiles, about 1.6 m) */
export const M = EYE / 1.6;
/** hip height of a scale-1 figure in metres (people.ts HIP = 0.19 tiles) */
export const HIP_M = 0.19 / M;

export type Rng = () => number;
export const rng = (seed: number): Rng => { let n = 0; return () => hash2(seed, 7 + n++); };
export const pick = <T>(r: Rng, a: readonly T[]) => a[Math.floor(r() * a.length)];

export const WALLS = [0xe9e2d0, 0xd8e3e0, 0xe7d3c4, 0xcfd8e6, 0xe6e1b8, 0xc9d6bf, 0xeadbd9, 0xb9c8cf, 0xf1ece4, 0x9fb3a8, 0xd9c2a6, 0xc7b8d4];
export const FLOORS = [0x8a6a4a, 0x9e7a52, 0x6e523a, 0xb08d64, 0x5a4232, 0xc4a57c, 0x8c8478, 0x6a7380, 0x7b6a5c];
export const SOFA = [0x5a6e8a, 0x8a4a3a, 0x4a5a4a, 0x9a9488, 0x3a3f4a, 0xb08a5a, 0x6a4a6a, 0x2f5a5a, 0xc0b8a8, 0x7a2f3a];
export const RUG = [0xa8463a, 0x3a5a8a, 0xc8b48a, 0x6a8a5a, 0x8a5a7a, 0xd8d0c0, 0x4a4a52, 0xc07a3a];
export const WOOD = [0x7a5638, 0x5a3e2a, 0xa07850, 0x3e2a1e, 0xd0b48c, 0xe8e4dc];
export const BRIGHT = [0xc0392b, 0x2e86de, 0x27ae60, 0xf1c40f, 0x8e44ad, 0xe67e22, 0x16a085, 0xecf0f1, 0x34495e, 0xd35400];
export const CABINETS = [0xf2efe8, 0x5a6e5a, 0x2f3e52, 0xd8cdb8, 0x8a9aa8, 0xa07850, 0x3a3a3c];

// ---- where they are ----------------------------------------------------------------------------

/** The free-time places' outings (docs/leisure.md) and what people do in a park: scenes built by render/leisureRooms.ts. */
export type LeisureRoom = Exclude<VenueType, 'park' | 'cinema' | 'theatre' | 'sports' | 'library'> | ParkActivity | 'band';
export type RoomKind = 'lounge' | 'kitchen' | 'bed'
  | 'office' | 'police' | 'shop' | 'factory' | 'ward' | 'fire' | 'yard' | 'hub'
  | 'cinema' | 'theatre' | 'sports' | 'library' | 'cafe' | 'bar' | 'doctor' | LeisureRoom;
/** A room's builder: lays out the kit and says where the eyes are. */
export type RoomBuilder = (k: Kit, c: Ctx) => View;
/**
 * Rooms registered by other modules (render/leisureRooms.ts registers the free-time places and the park's activities on
 * import), so this file need not import them; placeOf only offers a room that has a builder.
 */
export const EXTRA_ROOMS: Partial<Record<RoomKind, RoomBuilder>> = {};

export interface Place {
  room: RoomKind;
  /** changes when a different room should be built (a new home, workplace or room in the home) */
  key: string;
  seed: number;
  /** at a leisure place the server named (CitizenInfo.venue): its door tile and kind, and a seed of the place itself, so it looks the same to everyone */
  venue?: { x: number; y: number; kind: number; seed: number };
}

const stageOf = (age: number, activity: string) => (age < 18 ? LifeStage.Child : /retired/.test(activity) || age >= 66 ? LifeStage.Retired : LifeStage.Adult);
const homeSeed = (info: CitizenInfo) => ((info.home?.x ?? 0) * 92821 + (info.home?.y ?? 0) * 68917 + (info.life?.household.id ?? 0) * 31) | 0;

/**
 * Which room of the home someone is in at this hour: asleep in bed between their own bedtime and waking, at the
 * kitchen table for breakfast after waking and for the household's dinner, otherwise in the lounge. Bedtimes, waking
 * and breakfast length differ per person; dinner is shared per home, so families eat together.
 */
export function homeRoom(id: number, stage: number, hour: number, ill: boolean, seed: number): 'bed' | 'kitchen' | 'lounge' {
  const u = hash2(id, 501), v = hash2(id, 502);
  const child = stage === LifeStage.Child, old = stage === LifeStage.Retired;
  const wake = child ? 6.6 + u * 0.9 : old ? 6.8 + u * 1.6 : 5.8 + u * 1.6;
  const bed = child ? 19.6 + v * 1.4 : old ? 21.6 + v * 1.8 : 22.2 + v * 2.0;
  const h = hour < 12 ? hour + 24 : hour;
  if (h >= bed && h < wake + 24) return 'bed';
  if (ill && hash2(id, 503) < 0.6) return 'bed';
  if (hour >= wake && hour < Math.max(wake + 0.8, 8 + u * 0.7)) return 'kitchen';
  const dinner = 17.6 + hash2(seed, 504) * 1.6;
  if (hour >= dinner && hour < dinner + 0.7) return 'kitchen';
  return 'lounge';
}

/** The indoor place the citizen's latest inspect puts them in, or null when they are out (or somewhere not modelled). */
export function placeOf(info: CitizenInfo, hour: number): Place | null {
  if (info.role !== 'citizen' || info.mode !== 'none') return null;
  const act = info.activity;
  if (act.startsWith('at home')) {
    const seed = homeSeed(info), ill = /ill|sick/.test(act);
    const room = homeRoom(info.id, stageOf(info.life?.age ?? 30, act), hour, ill, seed);
    return { room, seed, key: `home:${seed}:${room}` };
  }
  if ((act === 'on shift' || act === 'at the yard') && info.employer) {
    const e = info.employer, seed = (e.x * 7919 + e.y * 104729) | 0;
    const room: RoomKind = ({ [Zone.Commercial]: 'shop', [Zone.Industrial]: 'factory', [Zone.Hospital]: 'ward', [Zone.Police]: 'police',
      [Zone.Fire]: 'fire', [Zone.Yard]: 'yard', [Zone.Hub]: 'hub' } as Record<number, RoomKind>)[familyOf(e.kind)] ?? 'office';
    return { room, seed, key: `work:${seed}:${room}` };
  }
  const room = leisureRoomOf(act);
  if (!room || (!BASE_ROOMS.has(room) && !EXTRA_ROOMS[room])) return null;
  // seeded by the visitor (their seat, who sits round them); a free-time place is also seeded by the place itself (info.venue)
  const seed = (info.id * 31 + 7) | 0;
  const v = info.venue, venue = v ? { ...v, seed: (v.x * 7919 + v.y * 104729 + v.kind * 31) | 0 } : undefined;
  return { room, seed, venue, key: `venue:${seed}:${room}:${v ? `${v.x},${v.y}` : ''}` };
}
/** Rooms this file builds itself (the rest come from EXTRA_ROOMS). */
const BASE_ROOMS = new Set<RoomKind>(['cinema', 'theatre', 'sports', 'library', 'cafe', 'bar', 'doctor']);
const PARK_ROOMS = Object.entries(PARK_ACTIVITY_TEXT) as [ParkActivity, string][];
/** The room an outing's activity line puts someone in: a café, a bar, the doctor, a venue type or a park activity. */
export function leisureRoomOf(act: string): RoomKind | null {
  if (act === 'seeing a doctor at the hospital') return 'doctor';
  if (act === 'at a café') return 'cafe';
  if (act === 'out at a bar') return 'bar';
  if (act === VENUE_WORDS.park.event) return 'band';
  for (const [a, text] of PARK_ROOMS) if (act === text) return a;
  for (const t of VENUE_TYPES) {
    if (t === 'park') continue;
    if (act === VENUE_WORDS[t].at || act === VENUE_WORDS[t].event) return t as RoomKind;
  }
  return null;
}

/** A home's seed: its paint, furniture, the TV's channel (render/tv.ts asks for the citizen panel's "watching" line). */
export const homeSeedOf = (info: CitizenInfo) => homeSeed(info);

// ---- television ------------------------------------------------------------------------------

/** What a TV set shows this frame (render/tv.ts TvGuide): the genre the shader draws, the channel's layer and the live feed. */
export interface TvPicture {
  /** shared tv.ts GENRE_CODE, or 11 for the live helicopter feed */
  genre: number;
  /** the programme's seed (its colours, its episode) and the channel's pacing */
  seed: number; pace: number;
  /** the channel's colour */
  color: number;
  /** the channel's graphics layer (lower third, teletext page, weather map), one texture per channel */
  gfx: Texture | null;
  /** the live feed's render target, while it carries this set's pictures */
  feed: Texture | null;
  /** "Quiz Night on Civitas 1" */
  label: string;
}
/** Where sets get their pictures (main.ts sets the TvGuide); without one they show the old generic shots. */
export interface TvSource { picture(setSeed: number, home: boolean, visible: boolean): TvPicture }
let tvSource: TvSource | null = null;
/** Debug (the TV check and timings): force every TV set on (1) or off (0), or leave it to the room (null). */
export const tvDebug: { force: 0 | 1 | null } = { force: null };
/** A pub's set: seeded by the room (render/tv.ts asks with the same seed for the citizen panel). */
export const barSetSeed = (roomSeed: number) => (roomSeed * 17 + 5) | 0;
export function setTvSource(src: TvSource | null) { tvSource = src; }

// ---- shaders ---------------------------------------------------------------------------------

export const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
/** a window: the sky from the game clock over a skyline whose windows light up at night (each its own) */
export const WINDOW_FRAG = /* glsl */ `
uniform vec3 uSky; uniform float uNight; uniform float uSeed; uniform float uAspect; uniform float uLow; varying vec2 vUv;
float h1(float n) { return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 17.0) * 43758.5453); }
void main() {
  float x = vUv.x * uAspect + uSeed * 3.0, y = vUv.y;
  vec3 top = uSky * mix(1.15, 0.7, uNight), hor = mix(uSky * 1.45 + vec3(0.06, 0.05, 0.03), uSky * 1.1 + vec3(0.03, 0.02, 0.035), uNight);
  vec3 col = mix(hor, top, smoothstep(0.1, 1.0, y));
  float c1 = floor(x * 7.0), hf = uLow + 0.18 + 0.28 * h1(c1 + 40.0);
  if (y < hf) {
    col = mix(uSky * 0.75 + vec3(0.03), vec3(0.02, 0.025, 0.05), uNight);
    vec2 cell = floor(vec2(x * 40.0, y * 60.0));
    col += step(h2(cell + 3.0), 0.25 * uNight) * vec3(0.9, 0.7, 0.4) * 0.5;
  }
  float c2 = floor(x * 2.6 + 0.3), hn = uLow + 0.05 + 0.32 * h1(c2);
  if (y < hn) {
    vec3 b = mix(vec3(0.26, 0.27, 0.3) * (0.5 + uSky), vec3(0.012, 0.014, 0.025), uNight);
    vec2 g = vec2(x * 18.0, y * 26.0), cell = floor(g), f = fract(g);
    float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
    float lit = step(h2(cell + c2 * 13.0), 0.1 + 0.45 * uNight);
    b += win * mix(vec3(0.08, 0.1, 0.13) + uSky * 0.2, vec3(1.3, 0.95, 0.55) * lit * (0.6 + 0.6 * h2(cell)), uNight);
    col = b;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
/**
 * a screen (TV, cinema, monitor). A work screen draws a desktop. A TV draws its programme by genre (shared tv.ts
 * GENRE_CODE, docs/media.md section 7): the studio news, a weather map (the channel's layer) with fronts and rain moving
 * over it, a quiz set, a football pitch, a cooking studio, a nature scene, cartoon shapes, a film, a teletext page (the
 * layer), the test card, or the helicopter's live feed; the channel's layer goes over it. Genre 0 (cinema, theatre, a set
 * without a guide) is the old two-colour shot with a moving figure. Every set has its own colour cast, brightness and
 * a little barrel warp (uCast, uWarp); every channel its pacing (uPace). Dark and glassy when off.
 */
const SCREEN_FRAG = /* glsl */ `
uniform vec3 uA; uniform vec3 uB; uniform float uOn; uniform float uT; uniform float uSeed; uniform float uDesk;
uniform float uGenre; uniform float uPace; uniform vec3 uCast; uniform float uWarp;
uniform sampler2D uGfx; uniform float uGfxOn; uniform sampler2D uFeed; uniform float uFeedOn;
varying vec2 vUv;
float sh(float n) { return fract(sin(n * 91.7 + uSeed * 47.3) * 43758.5453); }
float hs(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 13.0) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hs(i), hs(i + vec2(1.0, 0.0)), f.x), mix(hs(i + vec2(0.0, 1.0)), hs(i + vec2(1.0, 1.0)), f.x), f.y); }
float fbm(vec2 p) { return 0.55 * vn(p) + 0.3 * vn(p * 2.1 + 3.1) + 0.15 * vn(p * 4.3 + 7.7); }
float box(vec2 p, vec2 c, vec2 h) { vec2 d = abs(p - c) - h; return step(max(d.x, d.y), 0.0); }
float disc(vec2 p, vec2 c, float r) { return step(length((p - c) * vec2(1.78, 1.0)), r); }
/** a figure from the waist up at x, base y0, scale s */
float person(vec2 p, float x, float y0, float s) {
  vec2 q = (p - vec2(x, y0)) / s;
  float body = step(abs(q.x), 0.16 - 0.06 * q.y) * step(0.0, q.y) * step(q.y, 0.42);
  float head = step(length((q - vec2(0.0, 0.56)) * vec2(1.6, 1.0)), 0.11);
  return max(body, head);
}
vec3 legacy(vec2 p, float t) {
  float hz = 0.35 + 0.25 * fract(uSeed * 7.3 + floor(t / 3.0) * 0.37);
  vec3 c = mix(uB * 0.7, uB * 1.2 + 0.05, step(hz, p.y));
  vec2 q = p - vec2(0.5 + 0.22 * sin(t * 0.31 + uSeed * 6.0), 0.0);
  float body = step(abs(q.x), 0.11 - 0.05 * q.y) * step(q.y, 0.55);
  float head = step(length((q - vec2(0.0, 0.66)) * vec2(1.0, 0.8)), 0.09);
  return mix(c, uA, max(body, head)) * (0.75 + 0.3 * p.y);
}
vec3 studio(vec2 p, float t) {
  vec3 c = mix(uB * 0.45, uB * 1.05 + 0.04, p.y);
  c += 0.05 * step(0.6, fract(p.x * 7.0 + 0.2)) * step(0.5, p.y);
  // the video wall: the town's skyline at dusk
  float wall = box(p, vec2(0.73, 0.6), vec2(0.21, 0.23));
  float col = floor(p.x * 34.0);
  float top = 0.43 + 0.17 * hs(vec2(col, 1.0)) * step(0.35, hs(vec2(col, 2.0)));
  vec3 sky = mix(uA * 0.8 + 0.2, vec3(0.9, 0.55, 0.35), p.y - 0.4);
  vec3 town = vec3(0.05, 0.06, 0.1) + step(0.82, hs(floor(p * vec2(120.0, 90.0)))) * vec3(0.6, 0.45, 0.2);
  c = mix(c, mix(sky, town, step(p.y, top)), wall);
  c = mix(c, uA * 0.3 + vec3(0.06, 0.05, 0.05), person(p, 0.35 + 0.006 * sin(t * 0.9), 0.2, 0.62));
  c = mix(c, vec3(0.07, 0.08, 0.11) + uB * 0.18, step(p.y, 0.24));
  return c + 0.05 * step(abs(p.y - 0.24), 0.006);
}
vec3 weather(vec2 p, float t, vec3 map) {
  // fronts and cloud moving in from the west over the map
  float cl = fbm(p * vec2(4.0, 3.0) + vec2(-t * 0.06, t * 0.01));
  float cover = smoothstep(0.52, 0.78, cl) * step(0.14, p.y) * step(p.y, 0.9);
  vec3 c = mix(map, vec3(0.93, 0.94, 0.97), cover * 0.7);
  float rain = step(0.66, cl) * step(0.93, hs(floor(p * vec2(140.0, 80.0)) + floor(t * 5.0)));
  c = mix(c, vec3(0.3, 0.5, 1.0), rain);
  float fx = fract(t * 0.012 + uSeed) * 1.4 - 0.2 + 0.06 * sin(p.y * 9.0 + uSeed * 4.0);
  float line = step(abs(p.x - fx), 0.004) * step(0.14, p.y) * step(p.y, 0.88);
  float teeth = step(abs(p.x - fx - 0.012), 0.012 * (1.0 - abs(fract(p.y * 18.0) - 0.5) * 2.0)) * step(0.14, p.y) * step(p.y, 0.88);
  c = mix(c, mix(vec3(0.15, 0.3, 0.95), vec3(0.95, 0.2, 0.15), step(0.5, sh(4.0))), max(line, teeth));
  // a sun where the sky is clear
  vec2 sp = vec2(0.25 + 0.5 * sh(6.0), 0.55 + 0.2 * sh(7.0));
  return mix(c, vec3(1.0, 0.82, 0.2), disc(p, sp, 0.05) * (1.0 - cover));
}
vec3 quiz(vec2 p, float t) {
  vec3 c = mix(vec3(0.03, 0.02, 0.1), uB * 0.5 + vec3(0.08, 0.02, 0.16), p.y);
  for (int i = 0; i < 3; i++) {
    float fi = float(i), a = sin(t * 0.5 + fi * 2.1 + uSeed * 3.0) * 0.5;
    float x0 = 0.2 + 0.3 * fi;
    c += vec3(0.35, 0.3, 0.5) * 0.35 * step(abs(p.x - x0 - (1.0 - p.y) * a), 0.03 + 0.07 * (1.0 - p.y));
    float px = 0.22 + 0.28 * fi;
    c = mix(c, uA * 0.25 + 0.05, person(p, px, 0.26, 0.38));
    vec3 lit = mix(uA, vec3(1.0, 0.9, 0.3), step(0.9, fract(t * 0.2 + fi * 0.33)));
    c = mix(c, vec3(0.06), box(p, vec2(px, 0.14), vec2(0.1, 0.12)));
    c = mix(c, lit, box(p, vec2(px, 0.16), vec2(0.08, 0.05)));
  }
  float flash = step(0.88, fract(t * 0.07 + uSeed));
  c = mix(c, mix(vec3(0.1, 0.15, 0.6), vec3(0.95, 0.85, 0.2), flash), box(p, vec2(0.5, 0.8), vec2(0.3, 0.08)));
  return mix(c, vec3(1.0), box(p, vec2(0.5, 0.8), vec2(0.26, 0.012)) * (1.0 - flash));
}
vec3 pitch(vec2 p, float t) {
  float top = 0.78;
  if (p.y > top) return mix(vec3(0.12, 0.12, 0.16), vec3(0.4, 0.35, 0.3), hs(floor(p * vec2(160.0, 60.0)))) * (0.6 + 0.4 * step(0.86, p.y));
  float v = p.y / top, sc = 0.55 + 0.45 * v;
  float u = (p.x - 0.5) / sc + 0.5 + 0.18 * sin(t * 0.05 + uSeed * 6.0);
  vec3 c = mix(vec3(0.16, 0.48, 0.18), vec3(0.2, 0.56, 0.22), step(0.5, fract(u * 9.0)));
  float lw = 0.004 / sc;
  c = mix(c, vec3(0.92), max(step(abs(u - 0.5), lw * 1.5), step(abs(length(vec2((u - 0.5) * 2.2, (v - 0.5) * 1.1)) - 0.2), 0.008)));
  c = mix(c, vec3(0.92), max(step(abs(v - 0.06), 0.006), step(abs(v - 0.94), 0.006)));
  for (int i = 0; i < 22; i++) {
    float fi = float(i);
    vec2 q = vec2(0.5 + (sh(fi) - 0.5) * 0.9 + 0.08 * sin(t * (0.3 + 0.3 * sh(fi + 30.0)) + fi), 0.1 + 0.8 * sh(fi + 7.0) + 0.05 * sin(t * 0.4 + fi * 1.7));
    float d = length(vec2((u - q.x) * 1.6, (v - q.y)) * vec2(1.0, 0.6));
    c = mix(c, i < 11 ? uA : vec3(0.95), step(d, 0.02));
  }
  vec2 b = vec2(0.5 + 0.3 * sin(t * 0.37 + uSeed * 9.0), 0.5 + 0.3 * sin(t * 0.53));
  return mix(c, vec3(1.0), step(length(vec2((u - b.x) * 1.6, v - b.y)), 0.012));
}
vec3 cooking(vec2 p, float t) {
  vec2 g = fract(p * vec2(18.0, 12.0));
  vec3 c = mix(uB * 0.4 + 0.5, vec3(0.75), step(0.08, g.x) * step(0.08, g.y));
  c = mix(c, vec3(0.45, 0.3, 0.2), box(p, vec2(0.5, 0.72), vec2(0.5, 0.012)));
  for (int i = 0; i < 6; i++) c = mix(c, uA * (0.5 + 0.5 * sh(float(i))), box(p, vec2(0.1 + 0.15 * float(i), 0.77), vec2(0.03, 0.04)));
  c = mix(c, uA * 0.2 + vec3(0.85), person(p, 0.62 + 0.03 * sin(t * 0.4), 0.3, 0.55));
  c = mix(c, vec3(0.62, 0.64, 0.66), step(p.y, 0.3));
  c = mix(c, vec3(0.08), box(p, vec2(0.3, 0.33), vec2(0.12, 0.025)));
  float steam = smoothstep(0.55, 0.8, fbm(vec2(p.x * 8.0, p.y * 5.0 - t * 0.5))) * step(0.35, p.y) * step(abs(p.x - 0.3), 0.1) * (1.0 - smoothstep(0.35, 0.65, p.y));
  return mix(c, vec3(0.95), steam * 0.7);
}
vec3 nature(vec2 p, float t) {
  float dusk = step(0.6, sh(2.0));
  vec3 c = mix(mix(vec3(0.6, 0.78, 0.95), vec3(0.95, 0.6, 0.45), dusk), mix(vec3(0.25, 0.45, 0.8), vec3(0.35, 0.25, 0.5), dusk), p.y);
  c = mix(c, vec3(1.0, 0.92, 0.6), disc(p, vec2(0.7 + 0.1 * sh(3.0), 0.75), 0.06));
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float h = 0.55 - 0.13 * fi + 0.12 * fbm(vec2(p.x * (1.5 + fi) + t * 0.01 * (fi + 1.0) + uSeed * 9.0 + fi * 3.0, fi));
    c = mix(c, mix(vec3(0.25, 0.42, 0.3), vec3(0.12, 0.3, 0.14), fi * 0.5) * (1.0 - 0.3 * dusk), step(p.y, h));
  }
  if (sh(5.0) < 0.5) c = mix(c, vec3(0.15, 0.35, 0.55) + 0.25 * step(0.9, hs(floor(p * vec2(90.0, 40.0)) + floor(t * 2.0))), step(p.y, 0.16));
  vec2 bp = vec2(fract(t * 0.025 + sh(8.0)) * 1.2 - 0.1, 0.72 + 0.04 * sin(t * 0.5));
  float flap = 0.02 * sin(t * 6.0);
  float wing = step(abs(abs(p.x - bp.x) * 0.6 - (p.y - bp.y + flap * (1.0 - abs(p.x - bp.x) * 20.0))), 0.004) * step(abs(p.x - bp.x), 0.04);
  return mix(c, vec3(0.05), wing);
}
vec3 cartoons(vec2 p, float t) {
  vec3 bg = mix(uA * 0.6 + 0.4, uB * 0.5 + 0.5, step(0.5, fract((p.x + p.y) * 6.0)) * 0.3);
  vec3 c = mix(bg, vec3(0.35, 0.75, 0.3), step(p.y, 0.2));
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = fract(0.2 + 0.3 * fi + t * 0.03 * (1.0 + fi * 0.3) + sh(fi)), y = 0.2 + 0.08 + abs(sin(t * (1.1 + 0.4 * fi) + fi)) * 0.35;
    vec2 q = (p - vec2(x, y)) * vec2(1.78, 1.0);
    float sz = 0.08 + 0.02 * fi, d = i == 0 ? length(q) - sz : i == 1 ? max(abs(q.x), abs(q.y)) - sz : max(abs(q.x) * 0.87 + q.y * 0.5, -q.y) - sz * 0.6;
    vec3 fill = i == 0 ? vec3(1.0, 0.35, 0.3) : i == 1 ? vec3(0.3, 0.55, 1.0) : vec3(1.0, 0.85, 0.2);
    c = mix(c, vec3(0.05), step(d, 0.012));
    c = mix(c, fill, step(d, 0.0));
    c = mix(c, vec3(1.0), step(length(q - vec2(-0.03, 0.03)), 0.022) + step(length(q - vec2(0.03, 0.03)), 0.022));
    c = mix(c, vec3(0.0), step(length(q - vec2(-0.025, 0.03)), 0.01) + step(length(q - vec2(0.035, 0.03)), 0.01));
  }
  return c;
}
vec3 testcard(vec2 p) {
  vec3 bars[8];
  bars[0] = vec3(0.9); bars[1] = vec3(0.9, 0.9, 0.1); bars[2] = vec3(0.1, 0.9, 0.9); bars[3] = vec3(0.1, 0.85, 0.1);
  bars[4] = vec3(0.85, 0.1, 0.85); bars[5] = vec3(0.9, 0.1, 0.1); bars[6] = vec3(0.1, 0.1, 0.9); bars[7] = vec3(0.05);
  int k = int(clamp(floor(p.x * 8.0), 0.0, 7.0));
  vec3 c = vec3(0.05);
  for (int i = 0; i < 8; i++) if (i == k) c = bars[i];
  if (p.y < 0.3) c = vec3(floor(p.x * 6.0) / 5.0);
  float r = length((p - 0.5) * vec2(1.78, 1.0));
  c = mix(c, vec3(0.95), step(abs(r - 0.42), 0.006));
  return mix(c, vec3(0.5), step(abs(fract(p.x * 16.0) - 0.5), 0.02) * step(0.92, p.y));
}
void main() {
  vec2 p = vUv;
  if (uDesk > 0.5) {
    // a work screen: a title bar, a side panel and lines of text that scroll on now and then
    float row = floor(p.y * 16.0 + floor(uT * 0.4 + uSeed * 9.0));
    vec3 c = uB;
    c = mix(c, uA * 0.55, step(0.9, p.y));
    c = mix(c, uA * 0.9, step(p.x, 0.18) * step(p.y, 0.9));
    float line = step(0.3, fract(p.y * 16.0)) * step(fract(p.y * 16.0), 0.7) * step(0.23, p.x) * step(p.x, 0.25 + 0.7 * sh(row)) * step(p.y, 0.86);
    c = mix(c, vec3(0.25, 0.27, 0.32), line * 0.8);
    gl_FragColor = vec4(mix(vec3(0.01), c, uOn), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  // the set's own barrel warp
  vec2 d = p - 0.5;
  p = 0.5 + d * (1.0 + uWarp * dot(d, d) * 4.0);
  float inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
  float t = uT * uPace;
  int g = int(uGenre + 0.5);
  vec4 o = uGfxOn > 0.5 ? texture2D(uGfx, p) : vec4(0.0);
  vec3 c;
  if (g == 1) c = studio(p, t);
  else if (g == 2) c = weather(p, t, o.rgb);
  else if (g == 3) c = quiz(p, t);
  else if (g == 4) c = pitch(p, t);
  else if (g == 5) c = cooking(p, t);
  else if (g == 6) c = nature(p, t);
  else if (g == 7) c = cartoons(p, t);
  else if (g == 8) c = legacy(p, t) * step(0.1, p.y) * step(p.y, 0.9) + 0.04 * hs(floor(p * 200.0) + floor(t * 24.0));
  else if (g == 9) c = o.rgb;
  else if (g == 10) c = testcard(p);
  else if (g == 11) c = texture2D(uFeed, p).rgb * 1.08 + 0.03 * (hs(floor(p * vec2(160.0, 90.0)) + floor(uT * 8.0)) - 0.5);
  else c = legacy(p, t);
  if (g != 2 && g != 9) c = mix(c, o.rgb, o.a);
  c *= uCast;
  c *= 0.94 + 0.06 * sin(p.y * 220.0 + uT * 9.0);
  if (g > 0) c *= 1.0 - 0.35 * dot(d, d) * 2.0;
  c *= inside;
  vec3 off = vec3(0.01) + 0.025 * smoothstep(0.25, 0.0, abs(vUv.x - vUv.y - 0.2));
  gl_FragColor = vec4(mix(off, c, uOn), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** One glowing screen and the light it throws: a new shot every few seconds, flickering a little within it. */
export class Screen {
  mat: ShaderMaterial;
  on = 1;
  /** a TV set: the seed its channel is picked by (a household's, a pub's) and whether it is in a home; null for other screens */
  set: { seed: number; home: boolean } | null = null;
  /** the panel, and whether it was in the room camera's view last frame (the live feed runs only for a set on screen) */
  mesh: Mesh | null = null;
  visible = false;
  /** what it is showing, for the room's line ("watching Quiz Night on Civitas 1") */
  label = '';
  private shot = -1;
  private prog = -1;
  constructor(public seed: number, public bright: number, public light: PointLight | null, private palette: 'tv' | 'film' | 'work') {
    // every set its own colour cast, brightness and (older sets more) barrel warp
    const h = (k: number) => hash2(seed, 21 + k);
    const tv = palette === 'tv';
    const k = tv ? 0.92 + 0.16 * h(0) : 1;
    this.mat = new ShaderMaterial({
      uniforms: {
        uA: { value: new Color() }, uB: { value: new Color() }, uOn: { value: 1 }, uT: { value: 0 }, uSeed: { value: hash2(seed, 1) }, uDesk: { value: palette === 'work' ? 1 : 0 },
        uGenre: { value: 0 }, uPace: { value: 1 }, uWarp: { value: tv ? h(4) * h(4) * 0.12 : 0 },
        uCast: { value: tv ? new Color(k * (1 + (h(1) - 0.5) * 0.12), k * (1 + (h(2) - 0.5) * 0.08), k * (1 + (h(3) - 0.5) * 0.14)) : new Color(1, 1, 1) },
        uGfx: { value: null }, uGfxOn: { value: 0 }, uFeed: { value: null }, uFeedOn: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: SCREEN_FRAG,
    });
  }
  update(t: number) {
    const u = this.mat.uniforms;
    if (this.set && tvDebug.force !== null) this.on = tvDebug.force;
    u.uT.value = t; u.uOn.value = this.on;
    if (this.set && tvSource && this.on) this.tune(t);
    else {
      u.uGenre.value = 0; u.uGfxOn.value = 0; u.uFeedOn.value = 0;
      const len = this.palette === 'work' ? 40 : 2.6 + 3 * hash2(this.seed, 9);
      const shot = Math.floor(t / len + hash2(this.seed, 2) * 10);
      if (shot !== this.shot) {
        this.shot = shot; this.prog = -1;
        const h = (k: number) => hash2(this.seed * 13 + shot, k);
        const a = u.uA.value as Color, b = u.uB.value as Color;
        if (this.palette === 'work') { a.setHSL(h(1), 0.45, 0.45); b.setHSL(0.58, 0.1, 0.85 + h(2) * 0.08); }
        else if (this.palette === 'film') { a.setHSL(h(1), 0.3 + h(2) * 0.4, 0.25 + h(3) * 0.35); b.setHSL((h(1) + 0.4 + h(4) * 0.2) % 1, 0.3, 0.12 + h(5) * 0.3); }
        else { a.setHSL(h(1), 0.25 + h(2) * 0.6, 0.3 + h(3) * 0.4); b.setHSL((h(1) + 0.5) % 1, 0.2 + h(4) * 0.5, 0.15 + h(5) * 0.45); }
        a.multiplyScalar(this.bright); b.multiplyScalar(this.bright);
      }
    }
    if (this.light) {
      const f = this.palette === 'work' ? 1 : 0.82 + 0.1 * Math.sin(t * 11 + this.seed) * Math.sin(t * 6.3) + 0.08 * Math.sin(t * 2.1 + this.seed);
      this.light.color.copy(u.uA.value as Color).lerp(u.uB.value as Color, 0.6).multiplyScalar(1 / Math.max(0.2, this.bright));
      this.light.intensity = this.light.userData.max * f * this.on;
    }
  }
  /** A TV: what the guide says is on its channel (render/tv.ts); the programme's colours change with the programme. */
  private tune(_t: number) {
    const u = this.mat.uniforms, pic = tvSource!.picture(this.set!.seed, this.set!.home, this.visible);
    u.uGenre.value = pic.genre; u.uPace.value = pic.pace;
    u.uGfx.value = pic.gfx; u.uGfxOn.value = pic.gfx ? 1 : 0;
    u.uFeed.value = pic.feed; u.uFeedOn.value = pic.feed ? 1 : 0;
    this.label = pic.label;
    if (pic.seed !== this.prog) {
      this.prog = pic.seed; this.shot = -1;
      const h = (k: number) => hash2(Math.floor(pic.seed * 1e6), k);
      const a = u.uA.value as Color, b = u.uB.value as Color;
      a.setHSL(h(1), 0.45 + h(2) * 0.4, 0.4 + h(3) * 0.25);
      b.set(pic.color).offsetHSL((h(4) - 0.5) * 0.1, 0, (h(5) - 0.5) * 0.1);
      a.multiplyScalar(this.bright * 0.8); b.multiplyScalar(this.bright * 0.8);
    }
  }
}

// ---- the kit: boxes, cylinders, windows and lights in metres ---------------------------------------

export interface Body {
  look: Look;
  x: number; y: number; z: number; yaw: number;
  /** gait swing (0 standing or seated), pose (+phone, -work) and a phase offset */
  swing: number; pose: number; ph: number;
  /** lying in bed: the head toward +z, face up */
  lie?: boolean;
  /** moving about: called each frame with seconds */
  move?: (t: number, b: Body) => void;
}

export class Kit {
  scene = new Scene();
  parent: Object3D = this.scene;
  W = 4; D = 4; H = 2.5;
  readonly boxG = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  readonly cylG = new CylinderGeometry(0.5, 0.5, 1, 14).translate(0, 0.5, 0);
  readonly ballG = new SphereGeometry(0.5, 12, 8);
  readonly coneG = new ConeGeometry(0.5, 1, 12).translate(0, 0.5, 0);
  readonly planeG = new PlaneGeometry(1, 1);
  private mats = new Map<number, MeshLambertMaterial>();
  private own: Material[] = [];
  readonly windows: ShaderMaterial[] = [];
  readonly screens: Screen[] = [];
  readonly glows: { mat: MeshBasicMaterial; base: Color; when: 'night' | 'always' | 'lamp' }[] = [];
  /** daylight from the windows: direction into the room */
  readonly sunDir = new Vector3(0.3, -0.6, 0.4);
  hemi = new HemisphereLight(0xffffff, 0x8a7a6a, 1);
  sun = new DirectionalLight(0xffffff, 0);
  /** warm lamp, a screen's light and a ceiling light: always three, so the shaders compile once per light set */
  lamp = new PointLight(0xffb070, 0, 9, 2);
  tv = new PointLight(0x9ab4ff, 0, 9, 2);
  ceil = new PointLight(0xfff0dc, 0, 14, 2);
  crowd = new Crowd(true, 64);
  bodies: Body[] = [];
  readonly animate: ((t: number) => void)[] = [];
  /** how bright the room's own lights are when on (0..1) and how much daylight gets in */
  lampOn = 0; ceilOn = 0; daylight = 1;
  ambientNight = 0.08;
  moonlight = 0.15;

  constructor() {
    this.scene.background = new Color(0x050505);
    this.sun.target.position.set(0, 0, 0);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.lamp, this.tv, this.ceil);
    const g = new Group();
    g.scale.setScalar(1 / M);
    g.add(this.crowd.mesh);
    this.crowd.mesh.castShadow = false;
    this.scene.add(g);
  }

  mat(hex: number) {
    let m = this.mats.get(hex);
    if (!m) { m = new MeshLambertMaterial({ color: hex }); this.mats.set(hex, m); }
    return m;
  }
  private mesh(geo: BufferGeometry, col: number | Material) {
    const m = new Mesh(geo, typeof col === 'number' ? this.mat(col) : col);
    this.parent.add(m);
    return m;
  }
  /** a box w × h × d with its base at y */
  box(x: number, y: number, z: number, w: number, h: number, d: number, col: number | Material, ry = 0) {
    const m = this.mesh(this.boxG, col);
    m.position.set(x, y, z); m.scale.set(w, h, d); m.rotation.y = ry;
    return m;
  }
  cyl(x: number, y: number, z: number, r: number, h: number, col: number | Material) {
    const m = this.mesh(this.cylG, col);
    m.position.set(x, y, z); m.scale.set(r * 2, h, r * 2);
    return m;
  }
  /** a cone of radius r and height h with its base at y */
  cone(x: number, y: number, z: number, r: number, h: number, col: number | Material) {
    const m = this.mesh(this.coneG, col);
    m.position.set(x, y, z); m.scale.set(r * 2, h, r * 2);
    return m;
  }
  ball(x: number, y: number, z: number, rx: number, ry: number, rz: number, col: number | Material) {
    const m = this.mesh(this.ballG, col);
    m.position.set(x, y, z); m.scale.set(rx * 2, ry * 2, rz * 2);
    return m;
  }
  /** an unlit, glowing surface; `when` decides if it follows the room's lamps or the night */
  glow(hex: number, k = 1, when: 'night' | 'always' | 'lamp' = 'always') {
    const mat = new MeshBasicMaterial({ color: new Color(hex).multiplyScalar(k) });
    this.own.push(mat);
    this.glows.push({ mat, base: mat.color.clone(), when });
    return mat;
  }
  /** a flat panel facing +z in the current frame */
  panel(x: number, y: number, z: number, w: number, h: number, mat: Material, ry = 0) {
    const m = this.mesh(this.planeG, mat);
    m.position.set(x, y, z); m.scale.set(w, h, 1); m.rotation.y = ry;
    return m;
  }
  group(x: number, z: number, ry: number, fn: () => void) {
    const g = new Group();
    g.position.set(x, 0, z); g.rotation.y = ry;
    this.parent.add(g);
    const p = this.parent;
    this.parent = g; fn(); this.parent = p;
    return g;
  }
  /** floor, ceiling and four walls around (0, 0, 0), the floor at y 0 */
  shell(W: number, D: number, H: number, wall: number, floor: number, ceil = 0xf2efe8, skirting = 0xf4f2ee) {
    this.W = W; this.D = D; this.H = H;
    this.box(0, -0.1, 0, W + 0.4, 0.1, D + 0.4, floor);
    this.box(0, H, 0, W + 0.4, 0.1, D + 0.4, ceil);
    this.box(-W / 2 - 0.05, 0, 0, 0.1, H, D + 0.2, wall);
    this.box(W / 2 + 0.05, 0, 0, 0.1, H, D + 0.2, wall);
    this.box(0, 0, -D / 2 - 0.05, W + 0.2, H, 0.1, wall);
    this.box(0, 0, D / 2 + 0.05, W + 0.2, H, 0.1, wall);
    if (skirting >= 0) {
      this.box(-W / 2 + 0.01, 0, 0, 0.02, 0.09, D, skirting); this.box(W / 2 - 0.01, 0, 0, 0.02, 0.09, D, skirting);
      this.box(0, 0, -D / 2 + 0.01, W, 0.09, 0.02, skirting);
    }
  }
  /** the frame of a wall: centre u along it, facing into the room */
  onWall(side: 'back' | 'left' | 'right' | 'front', u: number, fn: () => void) {
    const { W, D } = this;
    const [x, z, ry] = side === 'back' ? [u, -D / 2, 0] : side === 'front' ? [u, D / 2, Math.PI] : side === 'left' ? [-W / 2, u, Math.PI / 2] : [W / 2, u, -Math.PI / 2];
    return this.group(x, z, ry, fn);
  }
  /** a window in a wall, showing the city outside; it also lets daylight in along its normal */
  window(side: 'back' | 'left' | 'right' | 'front', u: number, y0: number, w: number, h: number, seed: number, frame = 0xf4f4f0, sill = true, low = 0) {
    const mat = new ShaderMaterial({
      uniforms: { uSky: { value: new Color() }, uNight: { value: 0 }, uSeed: { value: hash2(seed, 77) * 10 }, uAspect: { value: w / h }, uLow: { value: low } },
      vertexShader: VERT, fragmentShader: WINDOW_FRAG,
    });
    this.windows.push(mat);
    this.onWall(side, u, () => {
      this.panel(0, y0 + h / 2, 0.012, w, h, mat);
      const t = 0.06;
      this.box(0, y0 - t, 0.03, w + 2 * t, t, 0.07, frame); this.box(0, y0 + h, 0.03, w + 2 * t, t, 0.07, frame);
      this.box(-w / 2 - t / 2, y0, 0.03, t, h, 0.07, frame); this.box(w / 2 + t / 2, y0, 0.03, t, h, 0.07, frame);
      if (w > 1) for (let i = 1, n = Math.round(w / 1.1); i < n; i++) this.box(-w / 2 + (w * i) / n, y0, 0.03, 0.04, h, 0.05, frame);
      if (sill) this.box(0, y0 - t - 0.03, 0.08, w + 0.25, 0.035, 0.16, frame);
    });
    const n = side === 'back' ? [0, 1] : side === 'front' ? [0, -1] : side === 'left' ? [1, 0] : [-1, 0];
    this.sunDir.set(n[0] * 0.8 + 0.2, -0.55, n[1] * 0.8 + 0.2).normalize();
    return mat;
  }
  /** a screen panel and, when `light`, the room's screen light in front of it */
  screen(x: number, y: number, z: number, w: number, h: number, seed: number, bright: number, palette: 'tv' | 'film' | 'work', light = 0, ry = 0) {
    let pl: PointLight | null = null;
    if (light) {
      // the room's screen light, a little in front of the picture; a cinema screen's reaches the back row
      pl = this.tv;
      pl.userData.max = light;
      pl.distance = w > 3 ? 0 : 9;
      this.parent.updateMatrixWorld(true);
      pl.position.set(x, y, z).applyMatrix4(this.parent.matrixWorld)
        .add(new Vector3(Math.sin(ry), 0, Math.cos(ry)).transformDirection(this.parent.matrixWorld).multiplyScalar(Math.min(1.2, w * 0.4)));
    }
    const s = new Screen(seed, bright, pl, palette);
    this.screens.push(s);
    this.own.push(s.mat);
    s.mesh = this.panel(x, y, z, w, h, s.mat, ry);
    return s;
  }
  /** a person sitting with hips on a seat of height `seat` (legs hidden in it), facing yaw */
  sit(look: Look, x: number, z: number, seat: number, yaw: number, pose = 0, ph = 0) {
    this.bodies.push({ look, x, y: seat - HIP_M * look.height + 0.04, z, yaw, swing: 0, pose, ph });
  }
  stand(look: Look, x: number, z: number, yaw: number, pose = 0, ph = 0, y = 0) {
    this.bodies.push({ look, x, y, z, yaw, swing: 0, pose, ph });
  }
  /** a person lying on their back, head on a pillow at (x, y, z), feet toward -z */
  lie(look: Look, x: number, y: number, z: number) {
    this.bodies.push({ look, x, y, z, yaw: 0, swing: 0, pose: 0, ph: 0, lie: true });
  }

  /** set the lights for the hour and room, draw the people, run the animations */
  update(t: number, now: number, sky: Color, night: number) {
    for (const w of this.windows) { (w.uniforms.uSky.value as Color).copy(sky); w.uniforms.uNight.value = night; }
    const day = 1 - night;
    this.hemi.color.copy(sky).lerp(WARM_WHITE, 0.6);
    this.hemi.groundColor.setHex(0x6a5a4a);
    this.hemi.intensity = (this.ambientNight + 0.9 * day * this.daylight) + 0.35 * this.ceilOn + 0.15 * this.lampOn;
    // daylight through the windows by day, a little moonlight and street glow by night
    this.sun.color.copy(sky).lerp(WARM_WHITE, 0.5).lerp(MOON, night);
    this.sun.intensity = 1.6 * day * this.daylight + (this.windows.length ? this.moonlight * night : 0);
    this.sun.position.copy(this.sunDir).multiplyScalar(-6);
    this.lamp.intensity = (this.lamp.userData.max ?? 2.5) * this.lampOn;
    this.ceil.intensity = (this.ceil.userData.max ?? 6) * this.ceilOn;
    for (const g of this.glows) {
      const k = g.when === 'always' ? 1 : g.when === 'lamp' ? 0.06 + 0.94 * this.lampOn : 0.1 + 0.9 * night;
      g.mat.color.copy(g.base).multiplyScalar(k);
    }
    for (const s of this.screens) s.update(t);
    for (const a of this.animate) a(t);
    const c = this.crowd;
    c.begin();
    for (const b of this.bodies) {
      if (c.full) break;
      b.move?.(t, b);
      c.put(b.x * M, b.y * M, b.z * M, b.yaw, b.look, now * b.look.pace + b.ph * 40, b.swing, b.pose);
      if (b.lie) {
        // lying down: the figure's up axis along +z (head toward the pillow), its front facing up
        const g = b.look.girth, h = b.look.height;
        TMP_M.set(0, 0, g, b.x * M, g, 0, 0, (b.y + 0.12) * M, 0, h, 0, b.z * M - 0.37 * h, 0, 0, 0, 1);
        c.mesh.setMatrixAt(c.n - 1, TMP_M);
      }
    }
    c.end();
  }

  dispose() {
    for (const m of this.mats.values()) m.dispose();
    for (const m of this.own) m.dispose();
    for (const m of this.windows) m.dispose();
    this.boxG.dispose(); this.cylG.dispose(); this.ballG.dispose(); this.coneG.dispose(); this.planeG.dispose();
    this.crowd.mesh.geometry.dispose();
    this.crowd.mesh.dispose();
  }
}
const FRUSTUM = new Frustum(), PROJ = new Matrix4();
const TMP_M = new Matrix4(), WARM_WHITE = new Color(0xfff2dc), MOON = new Color(0x8ea4e0);

/** where the viewer's eyes are and what they look at; glances are other things they look at now and then */
export interface View {
  eye: Vector3; aim: Vector3; glances: Vector3[]; label: string; lying?: boolean;
  /** re-run every couple of seconds: lights and screens that follow the clock without rebuilding the room */
  live?: (hour: number) => string | void;
  /**
   * A moving eye (a swing, a skater going round, a kart, a trampoline): called every frame with seconds, it moves `eye` in
   * place and may set where the head points (radians: yaw 0 looks toward -z, pitch up positive, roll). Without a look the
   * head keeps glancing about the room as usual.
   */
  move?: (t: number, eye: Vector3) => { yaw: number; pitch: number; roll?: number } | void;
  /**
   * Above the real town (the Ferris wheel): the eye's place in world tiles this frame. The first-person view then draws
   * the city from there with the room's own camera turn, and the room (the gondola) over it (render/fpv.ts).
   */
  overWorld?: (t: number) => { x: number; y: number; z: number };
}

/** a local point in a group (x, z, ry) to world */
export const world = (gx: number, gz: number, ry: number, lx: number, lz: number): [number, number] => [gx + lx * Math.cos(ry) + lz * Math.sin(ry), gz - lx * Math.sin(ry) + lz * Math.cos(ry)];

// ---- home ------------------------------------------------------------------------------------

export interface Ctx {
  info: CitizenInfo;
  place: Place;
  hour: number;
  evening: boolean;
  viewer: Look;
  stage: number;
}

/** furniture pieces shared by several rooms */
export function plant(k: Kit, r: Rng, x: number, z: number, big = r() < 0.5) {
  const pot = pick(r, [0xb8643a, 0xe8e4dc, 0x3a3a3c, 0x6a8a9a, 0xc8a878]);
  const s = big ? 1 : 0.55;
  k.cyl(x, 0, z, 0.16 * s, 0.32 * s, pot);
  const leaf = pick(r, [0x3e7a3a, 0x2f6a40, 0x5a8a3a, 0x4a7a5a]);
  for (let i = 0; i < 3; i++) k.ball(x + (r() - 0.5) * 0.2 * s, (0.5 + i * 0.22 + r() * 0.1) * s, z + (r() - 0.5) * 0.2 * s, 0.22 * s, 0.26 * s, 0.22 * s, leaf);
}
export function chair(k: Kit, x: number, z: number, ry: number, col: number, seatH = 0.46, back = 0.5) {
  k.group(x, z, ry, () => { k.box(0, 0, 0, 0.44, seatH, 0.44, col); k.box(0, seatH, -0.2, 0.44, back, 0.05, col); });
}
export function picture(k: Kit, r: Rng, side: 'back' | 'left' | 'right' | 'front', u: number, y: number) {
  const w = 0.35 + r() * 0.5, h = 0.3 + r() * 0.45;
  k.onWall(side, u, () => {
    k.box(0, y, 0.015, w + 0.06, h + 0.06, 0.03, pick(r, [0x2a2a2a, 0xd8c8a8, 0xf4f4f0, 0x6a4a2a]));
    k.box(0, y + 0.03, 0.02, w, h, 0.03, pick(r, BRIGHT));
    k.box((r() - 0.5) * w * 0.5, y + 0.03 + h * 0.2, 0.025, w * 0.4, h * 0.45, 0.03, pick(r, [...BRIGHT, ...WALLS]));
  });
}
export function bookshelf(k: Kit, r: Rng, x: number, z: number, ry: number, w = 0.9, h = 1.9, col = pick(r, WOOD)) {
  k.group(x, z, ry, () => {
    k.box(0, 0, 0, w, h, 0.32, col);
    const rows = Math.floor(h / 0.38);
    for (let row = 0; row < rows; row++) {
      let bx = -w / 2 + 0.05;
      const y = 0.06 + row * 0.38;
      while (bx < w / 2 - 0.08) {
        const bw = 0.03 + r() * 0.05, bh = 0.2 + r() * 0.12;
        if (r() < 0.12) { bx += 0.1; continue; }
        k.box(bx + bw / 2, y, 0.12, bw, bh, 0.22, pick(r, [...BRIGHT, 0x2a2a2a, 0xe8dcc0, 0x6a2a2a, 0x2a4a6a]));
        bx += bw + 0.005;
      }
    }
  });
}
export function pet(k: Kit, r: Rng, x: number, y: number, z: number) {
  const ry = r() * 6.28;
  if (r() < 0.6) { // a cat curled up
    const col = pick(r, [0x2a2a2a, 0xd88a3a, 0x8a8a8a, 0xf0ece4, 0x6a4a32]);
    k.group(x, z, ry, () => {
      k.ball(0, y + 0.09, 0, 0.18, 0.09, 0.13, col);
      k.ball(0.15, y + 0.13, 0.04, 0.07, 0.065, 0.07, col);
      k.box(0.15, y + 0.17, 0.0, 0.02, 0.05, 0.03, col); k.box(0.15, y + 0.17, 0.08, 0.02, 0.05, 0.03, col);
      k.box(-0.12, y + 0.02, 0.1, 0.22, 0.04, 0.04, col, 0.6);
    });
  } else { // a dog lying down
    const col = pick(r, [0x2a2a2a, 0xc89a5a, 0x8a5a32, 0xe8dcc0, 0x5a4a3a]);
    k.group(x, z, ry, () => {
      k.ball(0, y + 0.14, 0, 0.32, 0.14, 0.17, col);
      k.ball(0.3, y + 0.2, 0, 0.1, 0.1, 0.1, col);
      k.box(0.38, y + 0.15, -0.035, 0.12, 0.07, 0.07, col);
      k.box(0.28, y + 0.2, -0.08, 0.06, 0.1, 0.02, col); k.box(0.28, y + 0.2, 0.08, 0.06, 0.1, 0.02, col);
      k.box(0.2, y, -0.1, 0.26, 0.06, 0.06, col); k.box(0.2, y, 0.1, 0.26, 0.06, 0.06, col);
    });
  }
}
/** the household members at home and in this room of it, as the latest inspect has them */
function membersIn(info: CitizenInfo, room: RoomKind, hour: number, seed: number) {
  return (info.life?.household.members ?? []).filter((m) => !m.relation.includes('apart') && m.activity.startsWith('at home')
    && homeRoom(m.id, stageOf(m.age, m.activity), hour, /ill|sick/.test(m.activity), seed) === room);
}
/** who else is in this room, with their looks */
function housemates(c: Ctx, room: 'bed' | 'kitchen' | 'lounge') {
  return membersIn(c.info, room, c.hour, c.place.seed).map((m) => {
    const look = lookOf(m.id, 0, stageOf(m.age, m.activity), false, c.evening);
    return { id: m.id, look, relation: m.relation, phone: look.phone && hash2(m.id, Math.floor(c.hour * 3)) < 0.5 };
  });
}
function homeShell(k: Kit, c: Ctx, W: number, D: number) {
  const r = rng(c.place.seed);
  const wall = pick(r, WALLS), floor = pick(r, FLOORS);
  k.shell(W, D, 2.5, wall, floor);
  return { wall, floor };
}
/** a ceiling light fitting: a shade that glows with the light */
export function ceilingLight(k: Kit, x: number, z: number, H: number, drop = 0.35, col = 0xfff0dc) {
  k.cyl(x, H - drop, z, 0.008, drop, 0x2a2a2a);
  k.cyl(x, H - drop - 0.16, z, 0.17, 0.18, k.glow(col, 1.1, 'lamp'));
  k.ceil.position.set(x, H - drop - 0.3, z);
}

function lounge(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed ^ 0x51);
  const W = 4.6 + r() * 1.2, D = 4.0 + r() * 0.8;
  homeShell(k, c, W, D);
  const mx = r() < 0.5 ? 1 : -1;
  const wood = pick(r, WOOD), sofaCol = pick(r, SOFA);
  // TV on its unit against the back wall
  const tvx = (r() - 0.5) * 0.6;
  k.box(tvx, 0, -D / 2 + 0.25, 1.7, 0.5, 0.45, wood);
  k.box(tvx, 0.5, -D / 2 + 0.17, 0.32, 0.06, 0.2, 0x1a1a1c);
  k.box(tvx, 0.56, -D / 2 + 0.12, 0.05, 0.08, 0.05, 0x1a1a1c);
  k.box(tvx, 0.62, -D / 2 + 0.1, 1.28, 0.76, 0.06, 0x101012);
  // the TV is on most evenings (each home its own hours), and some days for a retiree at home
  const tvOn = (hour: number) => tvOnAt(c.place.seed, hour, c.stage === LifeStage.Retired);
  const tv = k.screen(tvx, 1.0, -D / 2 + 0.135, 1.2, 0.68, c.place.seed, 1.6, 'tv', 1.6);
  tv.set = { seed: c.place.seed, home: true };
  // the sofa along one side wall, facing in
  const sx = -mx * (W / 2 - 0.5), sz = 0.1 + (r() - 0.5) * 0.4, sry = mx * Math.PI / 2;
  const cushion = new Color(sofaCol).multiplyScalar(1.12).getHex();
  k.group(sx, sz, sry, () => {
    k.box(0, 0, 0, 2.1, 0.42, 0.9, sofaCol);
    k.box(0, 0, -0.36, 2.1, 0.86, 0.2, sofaCol);
    k.box(-0.98, 0, 0, 0.16, 0.62, 0.9, sofaCol); k.box(0.98, 0, 0, 0.16, 0.62, 0.9, sofaCol);
    k.box(-0.45, 0.42, 0.05, 0.88, 0.09, 0.72, cushion); k.box(0.45, 0.42, 0.05, 0.88, 0.09, 0.72, cushion);
    if (r() < 0.7) k.box(-0.75 + r() * 0.2, 0.5, -0.2, 0.36, 0.34, 0.12, pick(r, BRIGHT), 0.15);
    if (r() < 0.4) k.box(0.7, 0.5, -0.2, 0.34, 0.32, 0.12, pick(r, BRIGHT), -0.2);
  });
  // rug and coffee table in front of it
  const tx = sx + mx * 1.15;
  k.box(tx, 0, sz, 1.7 + r() * 0.6, 0.012, 2.0 + r() * 0.5, pick(r, RUG));
  k.box(tx, 0.36, sz, 0.6, 0.05, 1.1, wood);
  for (const [a, b] of [[-0.25, -0.5], [0.25, -0.5], [-0.25, 0.5], [0.25, 0.5]]) k.box(tx + a, 0, sz + b, 0.05, 0.36, 0.05, wood);
  for (let i = 0, n = Math.floor(r() * 3); i < n; i++) k.cyl(tx + (r() - 0.5) * 0.4, 0.41, sz + (r() - 0.5) * 0.8, 0.04, 0.09, pick(r, BRIGHT));
  if (r() < 0.6) k.box(tx, 0.41, sz + 0.25, 0.22, 0.03, 0.3, pick(r, BRIGHT), r());
  // the viewer's armchair, facing the TV
  const ax = mx * (0.5 + r() * 0.4), az = D / 2 - 0.8;
  k.group(ax, az, Math.PI, () => {
    k.box(0, 0, 0, 0.9, 0.42, 0.85, sofaCol); k.box(0, 0, -0.34, 0.9, 0.9, 0.2, sofaCol);
    k.box(-0.38, 0, 0, 0.14, 0.62, 0.85, sofaCol); k.box(0.38, 0, 0, 0.14, 0.62, 0.85, sofaCol);
  });
  // a floor lamp at the sofa's back end
  const lx = sx + mx * 0.05, lz = sz - 1.25;
  k.cyl(lx, 0, lz, 0.15, 0.03, 0x2a2a2a); k.cyl(lx, 0, lz, 0.015, 1.45, 0x2a2a2a);
  k.cyl(lx, 1.4, lz, 0.2, 0.28, k.glow(pick(r, [0xffd9a0, 0xfff0d0, 0xffc890]), 1.2, 'lamp'));
  k.lamp.position.set(lx + mx * 0.2, 1.35, lz + 0.2); k.lamp.userData.max = 2.2;
  // the window opposite the sofa, with curtains, and a radiator under it
  const wz = (r() - 0.5) * 0.8, ww = 1.2 + r() * 0.6;
  k.window(mx > 0 ? 'right' : 'left', wz, 0.85, ww, 1.3, c.place.seed);
  const curtain = pick(r, [...SOFA, ...RUG]);
  k.onWall(mx > 0 ? 'right' : 'left', wz, () => {
    k.box(-ww / 2 - 0.25, 0.1, 0.1, 0.32, 2.25, 0.06, curtain); k.box(ww / 2 + 0.25, 0.1, 0.1, 0.32, 2.25, 0.06, curtain);
    k.box(0, 2.3, 0.1, ww + 1.0, 0.03, 0.03, 0x2a2a2a);
    k.box(0, 0.15, 0.06, ww * 0.8, 0.55, 0.08, 0xf2f2ee);
  });
  // a bookshelf in a back corner, pictures, plants, maybe a pet
  bookshelf(k, r, mx * (W / 2 - 0.6), -D / 2 + 0.18, 0, 0.9 + r() * 0.3, 1.5 + r() * 0.5);
  picture(k, r, mx > 0 ? 'left' : 'right', sz, 1.5);
  if (r() < 0.6) picture(k, r, 'back', -mx * (W / 2 - 0.8), 1.5);
  if (r() < 0.5) picture(k, r, 'front', -mx * 0.8, 1.45);
  for (const [px, pz] of [[mx * (W / 2 - 0.3), D / 2 - 0.3], [-mx * (W / 2 - 0.3), -D / 2 + 0.3], [mx * (W / 2 - 0.35), wz + ww / 2 + 0.55]]) if (r() < 0.55) plant(k, r, px, pz);
  if (r() < 0.45) pet(k, r, tx + mx * (0.5 + r() * 0.3), 0.01, sz + (r() - 0.5) * 1.2);
  ceilingLight(k, 0, 0, 2.5, 0.25);
  k.ceil.userData.max = 4;
  const live = (hour: number) => {
    const on = tvOn(hour), evening = hour >= 17 || hour < 6;
    tv.on = on ? 1 : 0;
    k.lampOn = evening ? 1 : 0;
    k.ceilOn = evening && !on ? 0.6 : 0;
    return on ? `in the lounge, watching ${tv.label || 'TV'}` : mates.length ? 'in the lounge with the family' : 'in the lounge';
  };
  // household members on the sofa (children sometimes on the rug), facing the TV
  const mates = housemates(c, 'lounge');
  const seats = [-0.6, 0.6, 0];
  mates.forEach((m, i) => {
    if (i < 3) {
      const [x, z] = world(sx, sz, sry, seats[i], 0.1);
      k.sit(m.look, x, z, 0.47, sry - Math.PI / 2 + mx * 0.35, m.phone ? 1 : 0, m.id);
    } else k.sit(m.look, tx + mx * 0.7, sz + (i - 3.5) * 0.6, 0.12, sry - Math.PI / 2 + mx * 0.6, 0, m.id);
  });
  const eye = new Vector3(ax, 0.47 + 0.75 * c.viewer.height, az + 0.05);
  const aim = new Vector3(tvx, 1.0, -D / 2);
  const glances = [new Vector3(sx, 1.1, sz), new Vector3(mx * W / 2, 1.4, wz)];
  if (!tvOn(c.hour)) aim.set(tx, 0.6, sz - 0.3);
  return { eye, aim, glances, label: live(c.hour) as string, live };
}

function kitchen(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed ^ 0x52);
  const W = 4.0 + r() * 1.0, D = 3.6 + r() * 0.8;
  homeShell(k, c, W, D);
  const cab = pick(r, CABINETS), top = pick(r, [0x2a2a2c, 0xe8e4dc, 0xa07850, 0x8a8a88, 0xd8d0c0]), tile = pick(r, [0xf4f4f0, 0x9ac0c8, 0x2f4a5a, 0xe8d8b8, 0xc8d8c0]);
  const mx = r() < 0.5 ? 1 : -1;
  const fx = mx * (W / 2 - 0.4);
  const cw = W - 0.82, cx = -mx * 0.41;
  k.box(cx, 0, -D / 2 + 0.3, cw, 0.86, 0.6, cab);
  k.box(cx, 0.86, -D / 2 + 0.31, cw, 0.04, 0.62, top);
  for (let x = cx - cw / 2 + 0.3; x < cx + cw / 2; x += 0.6) k.box(x, 0.7, -D / 2 + 0.605, 0.14, 0.02, 0.02, 0x9a9a9a);
  k.box(cx, 0.9, -D / 2 + 0.01, cw, 0.55, 0.02, tile);
  // the window over the sink, upper cabinets either side
  const wx = cx + (r() - 0.5) * 0.6, ww = 1.0;
  k.window('back', wx, 1.05, ww, 0.85, c.place.seed);
  const left = wx - ww / 2 - 0.1 - (cx - cw / 2), right = cx + cw / 2 - (wx + ww / 2 + 0.1);
  if (left > 0.3) k.box(cx - cw / 2 + left / 2, 1.5, -D / 2 + 0.18, left, 0.72, 0.35, cab);
  if (right > 0.3) k.box(wx + ww / 2 + 0.1 + right / 2, 1.5, -D / 2 + 0.18, right, 0.72, 0.35, cab);
  k.box(wx, 0.86, -D / 2 + 0.3, 0.6, 0.045, 0.42, 0xb8bcc0);
  k.box(wx + 0.05, 0.9, -D / 2 + 0.1, 0.03, 0.25, 0.03, 0xb8bcc0);
  // fridge, hob, kettle, toaster
  k.box(fx, 0, -D / 2 + 0.36, 0.72, 1.85, 0.66, pick(r, [0xf4f4f2, 0xb8bcc0, 0x2a2a2c, 0xd8e8e0]));
  k.box(fx - mx * 0.3, 1.0, -D / 2 + 0.7, 0.025, 0.4, 0.03, 0x8a8a8a);
  const hx = wx + mx * -1.0 * (r() < 0.5 ? 1 : -1);
  if (Math.abs(hx) < W / 2 - 0.9) k.box(hx, 0.9, -D / 2 + 0.3, 0.58, 0.012, 0.5, 0x151515);
  k.cyl(cx - mx * (cw / 2 - 0.3), 0.9, -D / 2 + 0.3, 0.08, 0.22, pick(r, BRIGHT));
  if (r() < 0.6) k.box(cx + mx * 0.2, 0.9, -D / 2 + 0.25, 0.28, 0.18, 0.16, pick(r, [0xb8bcc0, 0xc0392b, 0xf4f4f2]));
  // the table and chairs
  const tz = 0.3, tw = 1.3 + r() * 0.3, td = 0.8, wood = pick(r, WOOD), chairCol = pick(r, WOOD);
  k.box(0, 0.71, tz, tw, 0.04, td, wood);
  for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(a * (tw / 2 - 0.06), 0, tz + b * (td / 2 - 0.06), 0.05, 0.71, 0.05, wood);
  const seats: [number, number, number][] = [[0, tz + 0.72, Math.PI], [0, tz - 0.72, 0], [-tw / 2 - 0.3, tz, Math.PI / 2], [tw / 2 + 0.3, tz, -Math.PI / 2]];
  for (const [x, z, ry] of seats) chair(k, x, z, ry, chairCol);
  const breakfast = c.hour < 12;
  const mates = housemates(c, 'kitchen');
  // place settings for everyone at the table
  const places = [[0, tz + 0.22], ...seats.slice(1, 1 + Math.min(3, mates.length)).map(([x, z]) => [x * 0.55, tz + (z - tz) * 0.3])];
  for (const [x, z] of places) {
    if (breakfast) { k.cyl(x, 0.75, z, 0.08, 0.05, 0xf4f4f0); k.cyl(x + 0.17, 0.75, z, 0.04, 0.09, pick(r, BRIGHT)); }
    else { k.cyl(x, 0.75, z, 0.13, 0.015, 0xf4f4f0); k.box(x + 0.17, 0.75, z, 0.02, 0.005, 0.18, 0xb8bcc0); }
  }
  if (breakfast) { k.box(0.15, 0.75, tz - 0.05, 0.2, 0.3, 0.07, pick(r, BRIGHT)); k.box(-0.25, 0.75, tz, 0.08, 0.22, 0.08, 0xf2a030); }
  else { k.cyl(0.1, 0.75, tz - 0.1, 0.12, 0.1, pick(r, [0xc0392b, 0x3a3a3c, 0xe8e4dc, 0x2a6a8a])); k.cyl(0.4, 0.75, tz - 0.15, 0.035, 0.24, 0x3a6a3a); }
  // three round the table with the viewer; anyone else is up at the counter (making tea, clearing up)
  mates.forEach((m, i) => {
    if (i < 3) {
      const [x, z, ry] = seats[1 + i];
      k.sit(m.look, x, z + (ry === 0 ? -0.04 : 0), 0.47, ry - Math.PI / 2, m.phone && breakfast ? 1 : 0, m.id);
    } else k.stand(m.look, cx + (i - 4) * 0.7, -D / 2 + 0.95, Math.PI / 2 + (hash2(m.id, 5) - 0.5) * 0.6, 0, m.id);
  });
  if (r() < 0.4) plant(k, r, -fx, D / 2 - 0.3, false);
  if (r() < 0.3) pet(k, r, (r() - 0.5) * W * 0.6, 0.01, D / 2 - 0.6);
  picture(k, r, mx > 0 ? 'left' : 'right', 0.3, 1.5);
  ceilingLight(k, 0, tz, 2.5, 0.6, 0xfff4e0);
  k.ceil.userData.max = 4.5;
  const live = (hour: number) => { k.ceilOn = hour < 7.2 || hour > 17.5 ? 1 : 0.35; k.lampOn = k.ceilOn; };
  live(c.hour);
  const eye = new Vector3(0, 0.47 + 0.75 * c.viewer.height, tz + 0.78);
  const aim = mates.length ? new Vector3(0, 0.95, tz - 0.7) : new Vector3(wx, 1.2, -D / 2);
  return { eye, aim, glances: [new Vector3(0, 0.75, tz + 0.2), new Vector3(wx, 1.4, -D / 2), new Vector3(-tw, 1.0, tz)], label: breakfast ? 'in the kitchen, having breakfast' : 'at the kitchen table, eating dinner', live };
}

function bedroom(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed ^ (c.stage === LifeStage.Child ? 0x63 : 0x53) ^ (c.info.id * 7));
  const child = c.stage === LifeStage.Child;
  const W = child ? 3.0 + r() * 0.6 : 3.6 + r() * 0.8, D = 3.6 + r() * 0.6;
  const wall = child ? pick(r, [0xb8d8f0, 0xf0c8d8, 0xc8e8c0, 0xf4e4a8, 0xd8c8f0]) : pick(r, WALLS);
  k.shell(W, D, 2.5, wall, pick(r, FLOORS));
  const awake = c.info.activity.includes('ill') || c.info.activity.includes('sick') ? (c.hour > 7 && c.hour < 21) : false;
  // the bed, headboard against the front wall
  const bw = child ? 0.95 : 1.6, bl = 2.05, bx = child ? -W / 2 + bw / 2 + 0.15 : (r() - 0.5) * 0.6, bz = D / 2 - bl / 2;
  const duvet = pick(r, child ? BRIGHT : [...SOFA, 0xf4f4f0, 0xe8e0d0, 0x9ab0c8]);
  k.box(bx, 0, bz, bw + 0.08, 0.32, bl, pick(r, WOOD));
  k.box(bx, 0.32, bz, bw, 0.2, bl - 0.05, 0xf4f4f0);
  k.box(bx, 0, D / 2 - 0.04, bw + 0.12, 1.05, 0.08, pick(r, [...WOOD, ...SOFA]));
  k.box(bx, 0.52, bz - 0.25, bw + 0.04, 0.14, bl - 0.55, duvet);
  k.ball(bx - (child ? 0 : bw / 4), 0.6, bz - 0.55, 0.16, 0.06, 0.5, duvet);
  const pillowZ = D / 2 - 0.35;
  for (const s of child ? [0] : [-1, 1]) k.box(bx + s * bw / 4, 0.52, pillowZ, bw / (child ? 1.4 : 2.3), 0.13, 0.4, 0xf8f8f4);
  // bedside table, alarm clock, a lamp
  const sx = bx + (child ? bw / 2 + 0.3 : -(bw / 2 + 0.3));
  k.box(sx, 0, D / 2 - 0.3, 0.45, 0.55, 0.4, pick(r, WOOD));
  k.box(sx + 0.05, 0.55, D / 2 - 0.35, 0.16, 0.08, 0.06, 0x151515);
  k.panel(sx + 0.05, 0.59, D / 2 - 0.379, 0.12, 0.04, k.glow(0xff2a1a, 2.2), Math.PI);
  k.cyl(sx - 0.1, 0.55, D / 2 - 0.25, 0.09, 0.03, 0x2a2a2a); k.cyl(sx - 0.1, 0.58, D / 2 - 0.25, 0.012, 0.25, 0x2a2a2a);
  k.cyl(sx - 0.1, 0.8, D / 2 - 0.25, 0.11, 0.14, k.glow(0xffe0b0, 1, 'lamp'));
  k.lamp.position.set(sx - 0.1, 0.95, D / 2 - 0.45); k.lamp.userData.max = 0.9;
  // the window at the far wall, curtains drawn at night with a gap
  const wx = (r() - 0.5) * 0.8, ww = 1.3;
  k.window('back', wx, 0.9, ww, 1.25, c.place.seed + 3);
  const curtain = pick(r, [...SOFA, ...RUG]), shut = awake ? 0 : 0.45 - r() * 0.08;
  k.onWall('back', wx, () => {
    k.box(-ww / 2 - 0.2 + shut / 2, 0.1, 0.12, 0.45 + shut, 2.25, 0.06, curtain);
    k.box(ww / 2 + 0.2 - shut / 2, 0.1, 0.12, 0.45 + shut, 2.25, 0.06, curtain);
    k.box(0, 2.3, 0.12, ww + 1.0, 0.03, 0.03, 0x2a2a2a);
  });
  // wardrobe, a chair with clothes, pictures (posters and glow stars for children)
  k.box(-Math.sign(bx || 1) * (W / 2 - 0.35), 0, -D / 2 + 0.9, 0.62, 2.0, 1.2, pick(r, WOOD));
  chair(k, W / 2 - 0.4, -0.2, -Math.PI / 2, pick(r, WOOD));
  k.box(W / 2 - 0.4, 0.47, -0.2, 0.36, 0.06, 0.4, pick(r, BRIGHT));
  if (child) {
    for (let i = 0; i < 3; i++) picture(k, r, i === 0 ? 'left' : 'back', i === 0 ? 0 : (i - 1.5) * 1.4, 1.3 + r() * 0.4);
    for (let i = 0; i < 14; i++) k.box((r() - 0.5) * W * 0.9, 2.49, (r() - 0.5) * D * 0.9, 0.05, 0.005, 0.05, k.glow(0xb8ffb0, 0.9, 'night'));
    k.box(sx + 0.1, 0.2, D / 2 - 0.08, 0.06, 0.06, 0.02, k.glow(0xffb070, 1.5, 'night'));
    for (let i = 0; i < 5; i++) k.box((r() - 0.5) * W * 0.5, 0, -0.3 + r() * 0.8, 0.12, 0.08 + r() * 0.1, 0.12, pick(r, BRIGHT), r() * 3);
  } else picture(k, r, 'front', bx, 1.55);
  if (r() < 0.4) plant(k, r, W / 2 - 0.3, D / 2 - 0.3, false);
  // the partner asleep alongside
  const glances = [new Vector3(sx, 0.6, D / 2 - 0.3), new Vector3(bx, 2.5, 0)];
  if (!child) {
    const p = housemates(c, 'bed').find((m) => m.relation === 'partner');
    if (p) { k.lie(p.look, bx + bw / 4, 0.4, pillowZ + 0.05); glances.push(new Vector3(bx + bw / 4, 0.7, pillowZ - 0.1)); }
  }
  if (!awake && r() < 0.3) pet(k, r, bx - bw / 4, 0.62, bz - 0.7);
  k.ambientNight = awake ? 0.08 : 0.3;
  k.moonlight = 0.6;
  k.daylight = awake ? 0.8 : 0.15;
  k.lampOn = awake && (c.hour < 8 || c.hour > 18) ? 1 : 0;
  k.ceil.userData.max = 0;
  const ex = child ? bx : bx - bw / 4;
  const eye = new Vector3(ex, 0.8, pillowZ - 0.05);
  const aim = new Vector3(wx, awake ? 1.1 : 1.4, -D / 2);
  return { eye, aim, glances, label: awake ? 'in bed, unwell' : 'asleep', lying: true };
}

// ---- workplaces --------------------------------------------------------------------------------

/** someone at work there: a stand-in colleague with a stable id from the place, dressed for the job */
export const colleague = (seed: number, i: number, kind: number, evening = false, stage: number = LifeStage.Adult) =>
  lookOf(2_000_000 + Math.floor(hash2(seed, 900 + i) * 1_000_000), kind, stage, kind !== 0, evening);

export function strips(k: Kit, W: number, D: number, H: number, nx: number, nz: number, col = 0xf4f8ff) {
  const m = k.glow(col, 1.6);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) k.box((i - (nx - 1) / 2) * (W / nx), H - 0.04, (j - (nz - 1) / 2) * (D / nz), 0.3, 0.03, 1.2, m);
  k.ceil.position.set(0, H - 0.4, 0);
}

function office(k: Kit, c: Ctx, police: boolean): View {
  const r = rng(c.place.seed);
  const W = 9 + r() * 2, D = 7 + r() * 2, H = 2.9;
  k.shell(W, D, H, police ? pick(r, [0xc8d4e4, 0xdde4ea]) : pick(r, WALLS), police ? pick(r, [0x2f3e5a, 0x4a5568]) : pick(r, [0x6a7380, 0x8c8478, 0x5a6470, 0x7a6a5a]), 0xf4f4f2);
  for (let i = 0; i < 3; i++) k.window('left', (i - 1) * D * 0.3, 0.9, 1.6, 1.4, c.place.seed + i, 0xd8dce0, true, 0.15);
  const desk = pick(r, [0xe8e4dc, 0xa07850, 0xd0d4d8, 0x3a3a3c]), chairCol = pick(r, [0x2a2a2c, 0x2f4a6a, 0x5a2a2a, 0x3a5a4a]);
  let n = 0;
  const glances: Vector3[] = [];
  const kind = police ? Zone.Police : Zone.Office;
  const rows = 3, cols = 3;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const x = (col - 1) * 2.6 + (r() - 0.5) * 0.2, z = -D / 2 + 1.4 + row * 1.9;
    k.box(x, 0.72, z, 1.4, 0.04, 0.75, desk);
    k.box(x - 0.66, 0, z, 0.04, 0.72, 0.7, desk); k.box(x + 0.66, 0, z, 0.04, 0.72, 0.7, desk);
    k.box(x, 0.76, z - 0.2, 0.06, 0.18, 0.06, 0x2a2a2a);
    k.box(x, 0.88, z - 0.24, 0.58, 0.36, 0.035, 0x1a1a1c);
    k.screen(x, 1.06, z - 0.22, 0.54, 0.32, c.place.seed + n * 17, 1.0, 'work', 0);
    k.box(x, 0.76, z + 0.05, 0.42, 0.015, 0.14, 0x3a3a3c);
    if (r() < 0.5) k.cyl(x + 0.45, 0.76, z, 0.04, 0.1, pick(r, BRIGHT));
    if (r() < 0.25) plant(k, r, x - 0.55, z - 0.1 + 0.1, false);
    chair(k, x, z + 0.6, Math.PI, chairCol, 0.47, 0.55);
    if (r() < 0.78) {
      const look = colleague(c.place.seed, n, kind);
      k.sit(look, x, z + 0.62, 0.48, Math.PI / 2 + (r() - 0.5) * 0.4, look.phone && r() < 0.15 ? 1 : 0, n);
      if (glances.length < 3) glances.push(new Vector3(x, 1.2, z + 0.6));
    }
    n++;
  }
  // the viewer's own desk at the front, facing the room
  const vz = D / 2 - 1.2;
  k.box(0, 0.72, vz, 1.4, 0.04, 0.75, desk);
  k.box(0, 0.88, vz - 0.24, 0.58, 0.36, 0.035, 0x1a1a1c);
  k.box(0, 0.76, vz - 0.2, 0.06, 0.18, 0.06, 0x2a2a2a);
  k.screen(0, 1.06, vz - 0.22, 0.54, 0.32, c.place.seed + 999, 1.1, 'work', 0.4);
  k.box(0, 0.76, vz + 0.08, 0.42, 0.015, 0.14, 0x3a3a3c);
  k.cyl(0.45, 0.76, vz + 0.05, 0.04, 0.1, pick(r, BRIGHT));
  // whiteboard or noticeboard, water cooler, plants
  k.onWall('back', (r() - 0.5) * 2, () => { k.box(0, 0.9, 0.02, 2.2, 1.1, 0.03, 0xb8bcc0); k.box(0, 0.95, 0.03, 2.1, 1.0, 0.03, police ? 0xb88a5a : 0xf8f8f8); });
  if (police) for (let i = 0; i < 8; i++) k.onWall('back', (r() - 0.5) * 1.6, () => k.box(0, 1.1 + r() * 0.7, 0.05, 0.2, 0.28, 0.01, pick(r, [0xf8f8f0, 0xf4e8a0, 0xd8e8f8])));
  k.cyl(W / 2 - 0.5, 0, -D / 2 + 0.5, 0.15, 1.0, 0xe8e8e8); k.cyl(W / 2 - 0.5, 1.0, -D / 2 + 0.5, 0.13, 0.35, 0x9ac8f0);
  plant(k, r, W / 2 - 0.4, D / 2 - 0.4, true); plant(k, r, -W / 2 + 0.4, -D / 2 + 0.4, true);
  strips(k, W, D, H, 3, 3);
  k.ceilOn = 1; k.ceil.userData.max = 14; k.daylight = 0.7;
  return { eye: new Vector3(0, 0.48 + 0.75 * c.viewer.height, vz + 0.78), aim: new Vector3(0, 0.95, vz - 0.8), glances: [new Vector3(0, 1.2, -D / 4), ...glances], label: police ? 'at a desk in the station' : 'at their desk' };
}

function shop(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed);
  const W = 8 + r() * 3, D = 9 + r() * 2, H = 3.2;
  const brand = pick(r, BRIGHT);
  k.shell(W, D, H, pick(r, [0xf4f4f0, 0xe8e4dc, 0xdde4ea]), pick(r, [0xd8d4cc, 0xb8b4ac, 0xe8e4dc]));
  k.window('back', -W / 4, 0.3, W / 2 - 0.6, 2.3, c.place.seed, 0x3a3a3c, false);
  k.onWall('back', W / 4, () => { k.box(0, 0, 0.02, 1.4, 2.4, 0.04, 0x3a3a3c); k.box(0, 0.05, 0.03, 1.3, 2.3, 0.02, 0x8ab0c8); });
  k.onWall('back', 0, () => k.box(0, 2.55, 0.03, W - 0.4, 0.5, 0.04, brand));
  // aisles of shelving full of goods
  for (let a = 0; a < 3; a++) {
    const x = (a - 1) * (W / 3.3), z = -0.3;
    k.box(x, 0, z, 0.6, 1.7, 4.2, 0xd8d8d8);
    for (let lvl = 0; lvl < 4; lvl++) for (const side of [-1, 1]) {
      let zz = z - 2.0;
      while (zz < z + 2.0) {
        const len = 0.2 + r() * 0.5;
        k.box(x + side * 0.31, 0.12 + lvl * 0.42, zz + len / 2, 0.06, 0.22 + r() * 0.1, len - 0.02, pick(r, BRIGHT));
        zz += len;
      }
    }
  }
  // the counter in front of the viewer, a till, a basket stack
  const cz = D / 2 - 1.1;
  k.box(0, 0, cz, 2.6, 1.0, 0.7, brand);
  k.box(0, 1.0, cz, 2.7, 0.04, 0.75, 0xe8e4dc);
  k.box(0.6, 1.04, cz, 0.35, 0.12, 0.3, 0x2a2a2c);
  k.box(0.6, 1.19, cz - 0.03, 0.34, 0.24, 0.03, 0x2a2a2c);
  k.screen(0.6, 1.31, cz - 0.01, 0.3, 0.2, c.place.seed + 5, 1, 'work', 0);
  k.box(0.6, 1.16, cz, 0.04, 0.16, 0.04, 0x2a2a2c);
  k.box(-0.8, 1.04, cz - 0.1, 0.4, 0.2, 0.3, 0xc0392b);
  // customers browsing
  const glances: Vector3[] = [];
  for (let i = 0, n = 4 + Math.floor(r() * 5); i < n; i++) {
    const x = ((i % 4) - 1.5) * (W / 3.3) / 1 * 0.5 + (r() - 0.5) * 0.3, z = -2.2 + r() * 3.4;
    const look = lookOf(3_000_000 + Math.floor(hash2(c.place.seed, i) * 1e6), 0, r() < 0.15 ? LifeStage.Retired : LifeStage.Adult, false, c.evening);
    const yaw = r() < 0.5 ? 0 : Math.PI;
    k.stand(look, x, z, yaw + (r() - 0.5) * 0.6, look.phone && r() < 0.3 ? 1 : 0, i);
    if (glances.length < 3) glances.push(new Vector3(x, 1.4, z));
  }
  // a colleague stacking shelves
  k.stand(colleague(c.place.seed, 1, Zone.Commercial), W / 3.3 / 2 + 0.6, 1.2, Math.PI / 2, 0, 3);
  strips(k, W, D, H, 3, 3);
  k.ceilOn = 1; k.ceil.userData.max = 16; k.daylight = 0.6;
  return { eye: new Vector3(0, 1.58 * c.viewer.height, cz + 0.6), aim: new Vector3(0, 1.1, -D / 2), glances, label: 'behind the counter' };
}

function factory(k: Kit, c: Ctx, yard: boolean): View {
  const r = rng(c.place.seed);
  const W = 14 + r() * 4, D = 12 + r() * 3, H = 6.5;
  k.shell(W, D, H, pick(r, [0x8a9098, 0x9aa4a8, 0xa8a090]), pick(r, [0x7a7a74, 0x6a6c6a, 0x8a8478]), 0x6a6e72, -1);
  for (const s of ['left', 'right'] as const) for (let i = 0; i < 3; i++) k.window(s, (i - 1) * D * 0.3, 4.2, 2.4, 1.4, c.place.seed + i, 0x4a4e52, false, 0.2);
  const lineCol = 0xe8c030;
  for (const x of [-1.6, 1.6]) k.box(x, 0, 0, 0.1, 0.01, D - 1, lineCol);
  const glances: Vector3[] = [];
  if (!yard) {
    // a conveyor across the hall with boxes riding it, machines either side
    const cz = 0.2;
    k.box(0, 0, cz, W - 3, 0.85, 0.9, 0x4a4e52);
    k.box(0, 0.85, cz, W - 3, 0.04, 0.8, 0x1a1a1a);
    const items: Mesh[] = [];
    for (let i = 0; i < 9; i++) items.push(k.box(0, 0.89, cz, 0.4, 0.3, 0.45, pick(r, [0xb88a5a, 0xc89a6a, 0xa07850])));
    const span = W - 3.5;
    k.animate.push((t) => items.forEach((m, i) => { m.position.x = (((t * 0.35 + (i * span) / items.length) % span) + span) % span - span / 2; }));
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * (W / 5.5), z = -D / 4 - r() * 1.5, col = pick(r, [0x3a6ea5, 0xd8a032, 0x5a6a5a, 0xc05030]);
      k.box(x, 0, z, 1.8, 2.2 + r() * 1.2, 1.6, col);
      k.box(x, 0.9, z + 0.81, 0.9, 0.6, 0.02, 0x2a2a2a);
      k.box(x + 0.6, 1.8, z + 0.81, 0.08, 0.08, 0.02, k.glow(r() < 0.7 ? 0x30ff40 : 0xff3020, 2));
      const look = colleague(c.place.seed, i, Zone.Industrial);
      k.stand(look, x + (r() - 0.5) * 0.6, z + 1.3, Math.PI / 2 + (r() - 0.5) * 0.5, r() < 0.5 ? -1 : 0, i);
      if (glances.length < 3) glances.push(new Vector3(x, 1.4, z + 1.3));
    }
  } else {
    // a depot shed: pallets and materials, a forklift, the roller door open onto the yard
    for (let i = 0; i < 10; i++) {
      const x = (r() - 0.5) * (W - 3), z = -D / 2 + 1.2 + r() * (D / 2 - 1);
      for (let s = 0, n = 1 + Math.floor(r() * 3); s < n; s++) {
        k.box(x, s * 0.9, z, 1.2, 0.14, 1.0, 0xb08a5a);
        k.box(x, s * 0.9 + 0.14, z, 1.1, 0.7, 0.95, pick(r, [0x8a8a88, 0xc84a2a, 0x3a6ea5, 0xd8c8a0, 0x5a7a4a]));
      }
    }
    k.window('back', W / 4, 0, 4, 3.6, c.place.seed, 0x5a5e62, false);
    k.group(-1.5, 1.5, 0.6, () => {
      k.box(0, 0.2, 0, 1.2, 1.0, 0.9, 0xf2b134); k.box(0.65, 0, 0, 0.1, 2.4, 0.7, 0x2a2a2a); k.box(0.85, 0.1, 0, 0.6, 0.05, 0.6, 0x5a5a5a);
      k.box(-0.3, 1.2, 0, 0.5, 0.9, 0.85, 0x2a2a2a);
      for (const [x, z] of [[-0.4, -0.45], [0.4, -0.45], [-0.4, 0.45], [0.4, 0.45]]) k.cyl(x, 0, z, 0.2, 0.1, 0x1a1a1a).rotation.x = Math.PI / 2;
    });
    for (let i = 0; i < 4; i++) {
      const look = colleague(c.place.seed, i, Zone.Yard);
      const x = (r() - 0.5) * 6, z = -1 + r() * 3;
      k.stand(look, x, z, r() * 6.28, r() < 0.4 ? -1 : 0, i);
      if (glances.length < 3) glances.push(new Vector3(x, 1.4, z));
    }
  }
  const lamp = k.glow(0xfff4e0, 1.8);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    const x = (i - 1) * W / 3, z = (j - 0.5) * D / 2;
    k.cyl(x, H - 1.2, z, 0.01, 1.2, 0x2a2a2a); k.cyl(x, H - 1.35, z, 0.3, 0.15, lamp);
  }
  k.ceil.position.set(0, H - 1.6, 0);
  k.ceilOn = 1; k.ceil.userData.max = 40; k.daylight = 0.6;
  const ez = yard ? D / 2 - 2 : 1.2;
  return { eye: new Vector3(0.6, 1.6 * c.viewer.height, ez), aim: new Vector3(0, 1.2, -D / 2), glances, label: yard ? 'at work in the depot' : 'on the factory floor' };
}

function ward(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed);
  const W = 8, D = 8 + r() * 2, H = 2.8;
  k.shell(W, D, H, pick(r, [0xdfeee8, 0xe4ecf4, 0xf0ece0]), pick(r, [0xc8d0cc, 0xb8c8c4, 0xd0ccc0]), 0xf4f4f2);
  k.window('back', 0, 0.9, 2.4, 1.4, c.place.seed);
  const blanket = pick(r, [0x8ab0d8, 0x9ad0b8, 0xf0b8a8, 0xc8b8e0]);
  const glances: Vector3[] = [];
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
    const z = -D / 2 + 1.5 + i * 2.2, x = s * (W / 2 - 1.15);
    k.group(x, z, s * Math.PI / 2, () => {
      k.box(0, 0, 0, 0.95, 0.55, 2.0, 0xd8dce0);
      k.box(0, 0.55, 0.05, 0.9, 0.12, 1.85, 0xf8f8f8);
      k.box(0, 0.6, -0.3, 0.92, 0.1, 1.3, blanket);
      k.box(0, 0.67, 0.75, 0.6, 0.1, 0.35, 0xf8f8f8);
      k.box(0, 0, 1.0, 1.0, 1.0, 0.05, 0xb8bcc0);
    });
    if (r() < 0.75) {
      // a patient sitting up against the pillows, legs under the blanket
      const [px, pz] = world(x, z, s * Math.PI / 2, 0, 0.45);
      k.sit(lookOf(4_000_000 + Math.floor(hash2(c.place.seed, i * 2 + s) * 1e6), 0, r() < 0.4 ? LifeStage.Retired : LifeStage.Adult, false, false), px, pz, 0.64, s > 0 ? Math.PI : 0, 0, i);
    }
    // monitor on a stand, curtain rail
    k.cyl(x + s * 0.3, 0, z - 1.25, 0.02, 1.3, 0x8a8a8a);
    k.box(x + s * 0.3, 1.3, z - 1.25, 0.3, 0.22, 0.06, 0x2a2a2c);
    k.screen(x + s * 0.3, 1.41, z - 1.215, 0.26, 0.18, c.place.seed + i * 7 + s, 0.7, 'work', 0);
    if (r() < 0.5) k.box(x - s * 0.1, 0.05, z - 1.2, 0.03, 2.3, 0.9, pick(r, [0xb8d0e8, 0xd8e8d8]));
  }
  for (let i = 0; i < 3; i++) {
    const look = colleague(c.place.seed, i, Zone.Hospital);
    const x = (r() - 0.5) * 2.4, z = -D / 2 + 1.5 + r() * (D - 3);
    k.stand(look, x, z, r() * 6.28, 0, i);
    glances.push(new Vector3(x, 1.4, z));
  }
  strips(k, W, D, H, 2, 3);
  k.ceilOn = 1; k.ceil.userData.max = 12; k.daylight = 0.7;
  return { eye: new Vector3(0, 1.6 * c.viewer.height, D / 2 - 0.6), aim: new Vector3(0, 1.0, -D / 2), glances, label: 'on the ward' };
}

function fireStation(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed);
  const W = 10, D = 12, H = 5;
  k.shell(W, D, H, 0xd8d4cc, 0x8a8a84, 0xc8c8c4, -1);
  k.onWall('back', 0, () => { for (let i = 0; i < 12; i++) k.box(0, 0.2 + i * 0.32, 0.03, 4.4, 0.28, 0.05, 0xc0392b); });
  k.group(-1.2, -1.0, 0, () => {
    k.box(0, 0.4, 0, 2.5, 2.4, 7, 0xc8281c);
    k.box(0, 2.0, 3.2, 2.4, 0.7, 0.05, 0x1a2a3a);
    k.box(0, 0.5, 3.52, 2.3, 0.25, 0.05, 0xd8d8d8);
    for (const x of [-0.8, 0.8]) k.box(x, 2.85, 2.6, 0.3, 0.1, 0.2, k.glow(0x3060ff, 2));
    k.box(0, 2.8, -0.5, 2.0, 0.15, 5, 0xb8bcc0);
    for (const z of [2.2, -2.4]) for (const x of [-1.25, 1.25]) { const w = k.cyl(x, 0.45, z, 0.45, 0.3, 0x1a1a1a); w.rotation.z = Math.PI / 2; }
  });
  for (let i = 0; i < 6; i++) {
    const z = -D / 2 + 1 + i * 0.9;
    k.box(W / 2 - 0.35, 0, z, 0.6, 2.0, 0.8, 0x7a8a9a);
    k.box(W / 2 - 0.68, 0.9, z, 0.08, 1.0, 0.5, 0xb8a05a);
    k.box(W / 2 - 0.7, 1.8, z, 0.25, 0.25, 0.3, 0xf2c230);
  }
  const glances: Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const look = colleague(c.place.seed, i, Zone.Fire);
    const x = 1.6 + r() * 2, z = -2 + r() * 4;
    k.stand(look, x, z, r() * 6.28, i === 0 ? -1 : 0, i);
    glances.push(new Vector3(x, 1.4, z));
  }
  strips(k, W, D, H, 2, 3);
  k.ceilOn = 1; k.ceil.userData.max = 30; k.daylight = 0.4;
  return { eye: new Vector3(2.2, 1.6 * c.viewer.height, D / 2 - 1.2), aim: new Vector3(-0.8, 1.4, -1), glances, label: 'in the engine bay' };
}

function hub(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed);
  const W = 18, D = 14, H = 7;
  k.shell(W, D, H, 0xe4e8ec, 0xc8ccd0, 0xd8dce0, -1);
  k.window('back', 0, 0.2, W - 2, 5.5, c.place.seed, 0x5a5e62, false);
  // check-in desks along one side, the departures board over them
  for (let i = 0; i < 5; i++) {
    const z = -D / 2 + 2 + i * 2;
    k.box(-W / 2 + 2, 0, z, 0.9, 1.05, 1.6, 0x3a5a8a);
    k.box(-W / 2 + 2.1, 1.05, z, 0.8, 0.04, 1.65, 0xe8e8e8);
  }
  k.onWall('left', 0, () => {
    k.box(0, 3.2, 0.1, 6, 1.6, 0.1, 0x1a1a1c);
    const amber = k.glow(0xffb020, 1.6);
    for (let i = 0; i < 6; i++) k.box(-2.8 + r() * 0.2, 3.35 + i * 0.22, 0.16, 1.4 + r() * 1.2, 0.08, 0.01, amber);
    for (let i = 0; i < 6; i++) k.box(1.2 + r() * 0.4, 3.35 + i * 0.22, 0.16, 0.6 + r() * 0.5, 0.08, 0.01, k.glow(r() < 0.8 ? 0x40e060 : 0xff4030, 1.4));
  });
  const glances: Vector3[] = [];
  for (let i = 0; i < 14; i++) {
    const look = lookOf(5_000_000 + Math.floor(hash2(c.place.seed, i) * 1e6), 0, LifeStage.Adult, false, c.evening);
    const x0 = (r() - 0.5) * (W - 8), z0 = (r() - 0.5) * (D - 4), walk = r() < 0.5, sp = 0.6 + r() * 0.5, len = 3 + r() * 4, ph = r() * 20;
    const yaw0 = r() < 0.5 ? 0 : Math.PI;
    k.bodies.push({
      look, x: x0, y: 0, z: z0, yaw: yaw0 + (r() - 0.5) * 0.5, swing: 0, pose: look.phone && r() < 0.3 ? 1 : 0, ph: i,
      move: walk ? (t, b) => {
        const u = ((t * sp + ph) % (2 * len)) / len;
        const fwd = u < 1;
        b.x = x0 + (fwd ? u : 2 - u) * len - len / 2;
        b.yaw = fwd ? 0 : Math.PI;
        b.swing = 0.45;
      } : undefined,
    });
    if (glances.length < 3) glances.push(new Vector3(x0, 1.4, z0));
  }
  strips(k, W, D, H, 4, 3);
  k.ceilOn = 1; k.ceil.userData.max = 50; k.daylight = 1;
  return { eye: new Vector3(-W / 2 + 1.0, 1.6 * c.viewer.height, 0), aim: new Vector3(4, 1.4, -2), glances, label: 'at the check-in desks' };
}

// ---- venues ------------------------------------------------------------------------------------

function auditorium(k: Kit, c: Ctx, theatre: boolean): View {
  const r = rng(c.place.seed);
  const W = 12, D = 15, H = 7;
  k.shell(W, D, H, theatre ? 0x5a1a22 : 0x1a1a22, theatre ? 0x3a1a1a : 0x1a1a1e, 0x101014, -1);
  const seat = theatre ? 0x8a1a2a : pick(r, [0x8a1a2a, 0x2a3a6a, 0x3a3a3c]);
  const rows = 8, front = -D / 2 + 5;
  let eye = new Vector3();
  const glances: Vector3[] = [];
  const myRow = 3 + Math.floor(r() * 3), myCol = 3 + Math.floor(r() * 4);
  for (let row = 0; row < rows; row++) {
    const z = front + row * 1.0, y = row * 0.22;
    k.box(0, 0, z + 0.1, W, y, 1.0, theatre ? 0x3a1a1a : 0x16161a);
    for (let col = 0; col < 10; col++) {
      const x = (col - 4.5) * 0.62;
      k.group(x, z, Math.PI, () => { k.box(0, y, 0, 0.55, 0.45, 0.5, seat); k.box(0, y, -0.25, 0.55, 0.9, 0.1, seat); });
      if (row === myRow && col === myCol) { eye = new Vector3(x, y + 0.45 + 0.75 * c.viewer.height, z + 0.02); continue; }
      if (r() < (row < myRow ? 0.55 : 0.4)) {
        const look = lookOf(6_000_000 + Math.floor(hash2(c.place.seed, row * 10 + col) * 1e6), 0, r() < 0.15 ? LifeStage.Retired : LifeStage.Adult, false, true);
        k.sit(look, x, z + 0.04, y + 0.46, Math.PI / 2 + (r() - 0.5) * 0.15, 0, row * 10 + col);
        if (row === myRow && glances.length < 2) glances.push(new Vector3(x, y + 1.0, z));
      }
    }
    k.box(W / 2 - 0.6, y, z + 0.3, 0.1, 0.03, 0.1, k.glow(0xffa040, 1.5));
  }
  k.onWall('front', W / 2 - 1, () => k.box(0, 2.3, 0.05, 0.4, 0.18, 0.04, k.glow(0x20ff60, 1.6)));
  if (theatre) {
    k.box(0, 0, -D / 2 + 2, W, 1.0, 4, 0x5a3a2a);
    k.box(0, 1.0, -D / 2 + 0.1, W, 4, 0.1, pick(r, [0x2a3a5a, 0x3a5a3a, 0x5a4a3a]));
    for (const s of [-1, 1]) k.box(s * (W / 2 - 1), 1.0, -D / 2 + 3.9, 2, 5, 0.25, 0x9a1a22);
    k.box(0, 5.4, -D / 2 + 3.9, W, 1.2, 0.25, 0x9a1a22);
    for (let i = 0; i < 4; i++) {
      const look = lookOf(7_000_000 + Math.floor(hash2(c.place.seed, i) * 1e6), 0, LifeStage.Adult, false, true);
      const x0 = (i - 1.5) * 1.6, z0 = -D / 2 + 1.5 + r() * 1.5, ph = r() * 10, amp = 0.4 + r() * 0.8;
      k.bodies.push({ look, x: x0, y: 1.0, z: z0, yaw: -Math.PI / 2, swing: 0, pose: 0, ph: i,
        move: (t, b) => { const s = Math.sin(t * 0.25 + ph); b.x = x0 + s * amp; b.swing = Math.abs(Math.cos(t * 0.25 + ph)) * 0.3; b.yaw = -Math.PI / 2 + (Math.cos(t * 0.25 + ph) > 0 ? 0.8 : -0.8) * b.swing; } });
    }
    k.lamp.position.set(0, 4, -D / 2 + 4); k.lamp.userData.max = 40; k.lampOn = 1;
    k.ambientNight = 0.03; k.daylight = 0;
    glances.push(new Vector3(-2, 2, -D / 2 + 1));
    return { eye, aim: new Vector3(0, 1.9, -D / 2 + 1.5), glances, label: 'in the audience' };
  }
  // the screen
  const sw = W - 2.2, sh = sw / 2.2;
  k.box(0, 1.2 - 0.1, -D / 2 + 0.06, sw + 0.3, sh + 0.2, 0.05, 0x050505);
  k.screen(0, 1.2 + sh / 2, -D / 2 + 0.1, sw, sh, c.place.seed, 1.3, 'film', 22);
  k.ambientNight = 0.015; k.daylight = 0;
  glances.push(new Vector3(-3, 2.5, -D / 2));
  return { eye, aim: new Vector3(0, 1.2 + sh / 2, -D / 2), glances, label: 'watching the film' };
}

function sportsHall(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed);
  const W = 22, D = 16, H = 8;
  k.shell(W, D, H, 0xd8dce0, 0xc89a5a, 0xb8bcc0, -1);
  const line = k.mat(0xf4f4f0);
  k.box(0, 0, -1.5, 16, 0.012, 0.08, line); k.box(0, 0, -1.5 - 8, 16, 0.012, 0.08, line); k.box(0, 0, -1.5 + 0, 0.08, 0.013, 8, line);
  for (const x of [-8, 8]) k.box(x, 0, -5.5, 0.08, 0.012, 8, line);
  k.cyl(0, 0, -5.5, 1.2, 0.011, 0xc0392b);
  for (const s of [-1, 1]) { k.box(s * 8.3, 0, -5.5, 0.1, 2.0, 3, 0xf4f4f0); k.box(s * 8.6, 0, -5.5, 0.6, 2.0, 3, k.mat(0xd8d8d8)); }
  // players running about the court
  const team = [pick(r, BRIGHT), pick(r, BRIGHT)];
  for (let i = 0; i < 10; i++) {
    const look = { ...lookOf(8_000_000 + Math.floor(hash2(c.place.seed, i) * 1e6), 0, LifeStage.Adult, false, false) };
    look.a = [look.a[0], look.a[1], team[i % 2], 0x1a1a1a];
    look.b = [look.b[0], look.b[1], look.b[2], (look.b[3] | (1 << 18) | (1 << 19)) & ~(1 << 13) & ~(1 << 9) & ~(1 << 8)];
    const cx = (r() - 0.5) * 12, cz = -5.5 + (r() - 0.5) * 5, a = 1.5 + r() * 3, f = 0.3 + r() * 0.4, ph = r() * 10;
    k.bodies.push({ look, x: cx, y: 0, z: cz, yaw: 0, swing: 0.6, pose: 0, ph: i,
      move: (t, b) => {
        const x = cx + Math.sin(t * f + ph) * a, z = cz + Math.sin(t * f * 1.3 + ph * 2) * a * 0.4;
        const dx = Math.cos(t * f + ph) * a * f, dz = Math.cos(t * f * 1.3 + ph * 2) * a * 0.4 * f * 1.3;
        b.x = x; b.z = z; b.yaw = Math.atan2(-dz, dx); b.swing = Math.min(0.75, Math.hypot(dx, dz) * 0.4);
      } });
  }
  // the stands on the viewer's side
  const glances: Vector3[] = [new Vector3(0, 1, -5.5)];
  for (let row = 0; row < 4; row++) {
    const z = 0.5 + row * 0.9, y = 0.3 + row * 0.4;
    k.box(0, 0, z, 18, y, 0.9, 0x5a6a7a);
    for (let i = 0; i < 24; i++) {
      if (r() > 0.5) continue;
      const x = (i - 11.5) * 0.7;
      if (row === 3 && Math.abs(x) < 0.5) continue;
      const look = lookOf(8_500_000 + Math.floor(hash2(c.place.seed, row * 30 + i) * 1e6), 0, r() < 0.2 ? LifeStage.Child : LifeStage.Adult, false, c.evening);
      k.sit(look, x, z + 0.1, y, Math.PI / 2 + (r() - 0.5) * 0.3, 0, row * 30 + i);
    }
  }
  strips(k, W, D, H, 4, 3);
  k.ceilOn = 1; k.ceil.userData.max = 60; k.daylight = 0.3;
  return { eye: new Vector3(0, 0.3 + 1.2 + 0.75 * c.viewer.height, 0.5 + 2.7 + 0.1), aim: new Vector3(0, 0.3, -5.5), glances, label: 'in the stands, watching the match' };
}

function library(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed);
  const W = 10, D = 10, H = 3.6;
  k.shell(W, D, H, pick(r, [0xe8dcc0, 0xd8c8a8, 0xc8d4c0]), pick(r, [0x6a4a32, 0x5a2a2a, 0x3a4a3a]), 0xf0ece0);
  for (let i = 0; i < 5; i++) bookshelf(k, r, (i - 2) * 1.9, -D / 2 + 0.2, 0, 1.8, 2.6, 0x5a3e2a);
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) bookshelf(k, r, s * (W / 2 - 0.2), (i - 1) * 2.4, -s * Math.PI / 2, 2.2, 2.6, 0x5a3e2a);
  const glances: Vector3[] = [];
  const quiz = c.info.activity.includes('quiz');
  let n = 0;
  for (const [tx, tz] of [[-2, -1.5], [2, -1.5], [-2, 1.6], [2, 1.6]]) {
    k.box(tx, 0.74, tz, 2.2, 0.05, 1.0, 0x6a4a32);
    k.box(tx, 0, tz, 2.0, 0.74, 0.8, 0x4a3422);
    k.cyl(tx, 0.79, tz, 0.012, 0.3, 0xb89a3a);
    k.cyl(tx, 1.05, tz, 0.12, 0.08, k.glow(0x3a9a5a, 1.2));
    for (const [sx, sz] of [[-0.55, -0.75], [0.55, -0.75], [-0.55, 0.75], [0.55, 0.75]]) {
      if (tx === -2 && tz === 1.6 && sx === 0.55 && sz === 0.75) continue;
      chair(k, tx + sx, tz + sz, sz > 0 ? Math.PI : 0, 0x5a3e2a);
      if (r() < (quiz ? 0.85 : 0.45)) {
        const look = lookOf(9_000_000 + Math.floor(hash2(c.place.seed, n) * 1e6), 0, r() < 0.2 ? LifeStage.Retired : LifeStage.Adult, false, c.evening);
        k.sit(look, tx + sx, tz + sz * 1.02, 0.47, sz > 0 ? Math.PI / 2 : -Math.PI / 2, 0, n);
        if (glances.length < 3) glances.push(new Vector3(tx + sx, 1.2, tz + sz));
      }
      if (r() < 0.5) k.box(tx + sx, 0.79, tz + sz * 0.4, 0.3, 0.04, 0.22, pick(r, BRIGHT), r() - 0.5);
      n++;
    }
  }
  strips(k, W, D, H, 2, 2, 0xfff4e0);
  k.ceilOn = 0.7; k.ceil.userData.max = 14; k.daylight = 0.3;
  return { eye: new Vector3(-2 + 0.55, 0.47 + 0.75 * c.viewer.height, 1.6 + 0.78), aim: new Vector3(0, 1.2, -D / 2), glances, label: quiz ? 'at the quiz night' : 'reading in the library' };
}

function cafeOrBar(k: Kit, c: Ctx, bar: boolean): View {
  const r = rng(c.place.seed);
  const W = 8 + r() * 2, D = 7 + r() * 2, H = 3;
  k.shell(W, D, H, bar ? pick(r, [0x3a2a22, 0x2a3a3a, 0x4a2a2a]) : pick(r, WALLS), bar ? 0x3a2a1e : pick(r, FLOORS), bar ? 0x2a2420 : 0xf4f0e8);
  if (!bar) k.window('left', 0, 0.4, D - 2, 2.1, c.place.seed, 0x2a2a2c, false);
  // the counter along the back, with a coffee machine or bottles behind it
  k.box(0, 0, -D / 2 + 1.4, W - 2, 1.05, 0.6, bar ? 0x5a3a22 : pick(r, [0xe8e4dc, 0x5a6e5a, 0xa07850]));
  k.box(0, 1.05, -D / 2 + 1.4, W - 1.9, 0.05, 0.7, bar ? 0x2a1a12 : 0x3a3a3c);
  if (bar) {
    for (let s = 0; s < 3; s++) {
      k.box(0, 1.1 + s * 0.45, -D / 2 + 0.2, W - 2.5, 0.03, 0.3, 0x2a1a12);
      for (let i = 0; i < 16; i++) k.cyl((i - 7.5) * ((W - 3) / 16) + (r() - 0.5) * 0.08, 1.13 + s * 0.45, -D / 2 + 0.2, 0.04, 0.22 + r() * 0.1, k.glow(pick(r, [0x3a8a3a, 0xc08a2a, 0x8a2a1a, 0xd8d0b0, 0x2a5a8a]), 0.5));
    }
    k.onWall('back', 0, () => k.box(0, 1.0, 0.01, W - 2.4, 1.5, 0.02, k.glow(0xffa050, 0.25)));
  } else {
    k.box(-1, 1.1, -D / 2 + 1.35, 0.5, 0.45, 0.4, 0xb8bcc0);
    k.box(1.2, 1.1, -D / 2 + 1.4, 1.2, 0.35, 0.5, k.glow(0xffe8c0, 0.8));
    for (let i = 0; i < 6; i++) k.ball(0.75 + i * 0.18, 1.2, -D / 2 + 1.4, 0.07, 0.04, 0.07, pick(r, [0xc89a5a, 0xa06a3a, 0xe8c890]));
    k.onWall('back', 0, () => { k.box(0, 1.6, 0.02, 2.4, 0.9, 0.02, 0x1a1a1a); for (let i = 0; i < 5; i++) k.box(-0.6 + r() * 0.2, 1.7 + i * 0.15, 0.04, 1.2 + r() * 0.6, 0.05, 0.01, 0xf4f4f0); });
  }
  // staff behind the counter
  k.stand(colleague(c.place.seed, 0, Zone.Commercial, bar), (r() - 0.5) * 2, -D / 2 + 0.9, -Math.PI / 2 + 0.5, 0, 0);
  // tables of two or four
  const glances: Vector3[] = [];
  let n = 0, ex = 0, ez = 0;
  const pendant = k.glow(bar ? 0xffb060 : 0xfff0d0, bar ? 1.6 : 1.1);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    const tx = (i - 1) * 2.4 + (r() - 0.5) * 0.3, tz = -D / 2 + 3 + j * 2.0;
    k.cyl(tx, 0, tz, 0.05, 0.74, 0x2a2a2a); k.cyl(tx, 0.74, tz, 0.4, 0.04, bar ? 0x3a2418 : pick(r, [0xe8e4dc, 0xa07850, 0x3a3a3c]));
    k.cyl(tx, H - 0.8, tz, 0.006, 0.8, 0x2a2a2a); k.cyl(tx, H - 0.95, tz, 0.14, 0.16, pendant);
    for (const s of [-1, 1]) {
      const sx = tx + s * 0.62;
      chair(k, sx, tz, -s * Math.PI / 2, bar ? 0x2a1a12 : pick(r, WOOD), 0.46, 0.45);
      if (i === 2 && j === 1 && s === 1) { ex = sx; ez = tz; continue; }
      if (r() < 0.7) {
        const look = lookOf(9_500_000 + Math.floor(hash2(c.place.seed, n) * 1e6), 0, r() < 0.15 ? LifeStage.Retired : LifeStage.Adult, false, bar || c.evening);
        k.sit(look, sx, tz, 0.47, s > 0 ? Math.PI : 0, look.phone && r() < 0.25 ? 1 : 0, n);
        if (glances.length < 3) glances.push(new Vector3(sx, 1.2, tz));
      }
      n++;
    }
    k.cyl(tx + (r() - 0.5) * 0.3, 0.78, tz + (r() - 0.5) * 0.3, 0.04, bar ? 0.16 : 0.09, bar ? k.glow(0xd8a030, 0.6) : k.mat(0xf4f4f0));
  }
  k.ceil.position.set(0, H - 1.0, -0.5);
  k.ceilOn = 1; k.ceil.userData.max = bar ? 9 : 10; k.daylight = bar ? 0 : 0.9; k.ambientNight = bar ? 0.2 : 0.1;
  k.lamp.position.set(0, 1.6, -D / 2 + 0.8); k.lamp.userData.max = bar ? 6 : 0; k.lampOn = 1;
  // the pub's TV high on the wall the viewer faces: the match on a match night, else the news or the programmes (render/tv.ts)
  let tv: Screen | null = null;
  if (bar) {
    const tz = ez + (r() - 0.5) * 1.2;
    k.onWall('left', tz, () => {
      k.box(0, 1.78, 0.03, 1.36, 0.82, 0.07, 0x101012);
      k.box(0, 1.6, 0.02, 0.08, 0.18, 0.04, 0x2a2a2a);
      tv = k.screen(0, 2.19, 0.072, 1.24, 0.7, c.place.seed + 3, 1.3, 'tv', 0);
    });
    tv!.set = { seed: barSetSeed(c.place.seed), home: false };
    glances.unshift(new Vector3(-W / 2, 2.1, tz));
  }
  const label = bar ? 'out at a bar' : 'at a café';
  return {
    eye: new Vector3(ex + 0.02, 0.47 + 0.75 * c.viewer.height, ez), aim: new Vector3(ex - 1.4, 1.0, ez), glances: [new Vector3(0, 1.4, -D / 2 + 1), ...glances], label,
    live: () => (tv?.label ? `${label}, the TV on ${tv.label}` : label),
  };
}

function doctor(k: Kit, c: Ctx): View {
  const r = rng(c.place.seed);
  const W = 4.2, D = 4.0, H = 2.7;
  k.shell(W, D, H, pick(r, [0xe4ecf4, 0xdfeee8]), 0xc8d0cc, 0xf4f4f2);
  k.window('right', -0.5, 0.9, 1.3, 1.3, c.place.seed);
  k.box(0, 0.73, -0.6, 1.5, 0.04, 0.75, 0xe8e4dc);
  k.box(0, 0, -0.6, 1.4, 0.73, 0.7, 0xd8d4cc);
  k.box(0.4, 0.77, -0.8, 0.5, 0.33, 0.04, 0x1a1a1c);
  k.screen(0.4, 0.94, -0.776, 0.46, 0.28, c.place.seed, 1, 'work', 0, 0);
  chair(k, 0, -1.25, 0, 0x2a3a5a, 0.48, 0.6);
  k.sit(colleague(c.place.seed, 0, Zone.Hospital), 0, -1.22, 0.48, -Math.PI / 2 + 0.1, 0, 0);
  k.group(-W / 2 + 0.5, -0.4, Math.PI / 2, () => { k.box(0, 0, 0, 1.9, 0.7, 0.7, 0x2a6a7a); k.box(0, 0.7, 0, 1.9, 0.02, 0.5, 0xf8f8f8); });
  k.onWall('back', 1.2, () => { k.box(0, 1.2, 0.02, 0.6, 0.85, 0.01, 0xf8f8f0); k.box(0, 1.5, 0.03, 0.3, 0.4, 0.01, 0xc05050); });
  k.box(W / 2 - 0.35, 0, 1.2, 0.5, 0.9, 0.5, 0xe8e8e8);
  plant(k, r, W / 2 - 0.3, -D / 2 + 0.3, false);
  strips(k, W, D, H, 1, 2);
  k.ceilOn = 1; k.ceil.userData.max = 6; k.daylight = 0.6;
  return { eye: new Vector3(0, 0.47 + 0.75 * c.viewer.height, 0.25), aim: new Vector3(0, 1.1, -1.25), glances: [new Vector3(-W / 2, 0.9, -0.4), new Vector3(W / 2, 1.4, -0.5)], label: 'seeing the doctor' };
}

// ---- the interior view -----------------------------------------------------------------------

/**
 * One room, built for one citizen at one place. `update` once a frame (lights, people, the head's idle motion),
 * `setInfo` when a fresh inspect arrives (who else is home), `render` to draw it, `dispose` when the view leaves.
 */
export class Interior {
  readonly key: string;
  readonly camera = new PerspectiveCamera(70, 16 / 9, 0.03, 80);
  label: string;
  private k: Kit;
  private v: View;
  private ctx: Ctx;
  private yaw = 0; private pitch = 0;
  private glance = -1; private glanceAt = -1;
  private gy = 0; private gp = 0;
  private liveAt = 0;
  /** the household members drawn in the room, to notice someone coming in or leaving */
  private mates: string;

  constructor(place: Place, info: CitizenInfo, hour: number) {
    this.key = place.key;
    const stage = info.life ? (info.life.stage === 'child' ? LifeStage.Child : info.life.stage === 'retired' ? LifeStage.Retired : LifeStage.Adult) : LifeStage.Adult;
    const evening = sceneUniforms.uNight.value > 0.5;
    const work = place.key.startsWith('work:');
    const viewer = lookOf(info.id, work ? familyOf(info.employer?.kind ?? 0) : 0, stage, work, evening);
    this.ctx = { info, place, hour, evening, viewer, stage };
    const B: Partial<Record<RoomKind, RoomBuilder>> = {
      lounge, kitchen, bed: bedroom,
      office: (k, c) => office(k, c, false), police: (k, c) => office(k, c, true), shop, factory: (k, c) => factory(k, c, false), yard: (k, c) => factory(k, c, true),
      ward, fire: fireStation, hub,
      cinema: (k, c) => auditorium(k, c, false), theatre: (k, c) => auditorium(k, c, true), sports: sportsHall, library,
      cafe: (k, c) => cafeOrBar(k, c, false), bar: (k, c) => cafeOrBar(k, c, true), doctor,
    };
    this.k = new Kit();
    const build = (B as Partial<Record<RoomKind, RoomBuilder>>)[place.room] ?? EXTRA_ROOMS[place.room];
    this.v = build!(this.k, this.ctx);
    this.mates = this.matesKey(info, hour);
    this.label = this.v.label;
    this.aimAt(this.v.aim);
    this.yaw = this.gy; this.pitch = this.gp;
  }

  private matesKey(info: CitizenInfo, hour: number) {
    const p = this.ctx.place;
    return p.key.startsWith('home:') ? membersIn(info, p.room, hour, p.seed).map((m) => m.id).join(',') : '';
  }
  /** someone else has come into the room or left it since it was built: build it again with them */
  stale(info: CitizenInfo, hour: number) { return this.matesKey(info, hour) !== this.mates; }

  private aimAt(p: Vector3) {
    const e = this.v.eye, dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
    this.gy = Math.atan2(-dx, -dz);
    this.gp = Math.atan2(dy, Math.hypot(dx, dz));
  }

  update(now: number, dt: number, hour: number, sky: Color) {
    const t = now / 1000, id = this.ctx.info.id;
    const night = sceneUniforms.uNight.value;
    if (t > this.liveAt) { this.liveAt = t + 2; this.label = this.v.live?.(hour) || this.label; }
    this.k.update(t, now, sky, night);
    // idle head motion: a slow drift, breathing, and now and then a glance at someone or something else in the room
    if (this.glanceAt < 0) this.glanceAt = t + 4 + hash2(id, 43) * 4;
    if (t > this.glanceAt) {
      const n = Math.floor(t / 7);
      const u = hash2(id, n * 3 + 1);
      this.glance = u < 0.62 || !this.v.glances.length ? -1 : Math.floor(hash2(id, n * 3 + 2) * this.v.glances.length);
      this.glanceAt = t + (this.glance < 0 ? 6 + hash2(id, n) * 8 : 2 + hash2(id, n) * 2.5);
      this.aimAt(this.glance < 0 ? this.v.aim : this.v.glances[this.glance]);
    }
    const kf = 1 - Math.exp(-dt * 1.6);
    this.yaw += (((this.gy - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * kf;
    this.pitch += (this.gp - this.pitch) * kf;
    const ph = hash2(id, 41) * 6.28, lying = !!this.v.lying;
    // a moving eye: the room moves it (and may turn the head), then the idle drift goes on top
    const look = this.v.move?.(t, this.v.eye);
    if (look) { this.yaw = look.yaw; this.pitch = look.pitch; }
    const yaw = this.yaw + 0.035 * Math.sin(t * 0.21 + ph) + 0.015 * Math.sin(t * 0.57 + ph * 2);
    const pitch = this.pitch + 0.02 * Math.sin(t * 0.31 + ph * 3) + (lying ? 0.01 * Math.sin(t * 0.9) : 0);
    const e = this.v.eye, c = this.camera;
    c.position.set(e.x, e.y + (lying ? 0.006 : 0.004) * Math.sin(t * (lying ? 0.9 : 1.3) + ph), e.z);
    c.rotation.set(0, 0, 0);
    c.rotation.order = 'YXZ';
    c.rotation.y = yaw; c.rotation.x = pitch; c.rotation.z = (look?.roll ?? 0) + (lying ? 0.08 : 0.01 * Math.sin(t * 0.17 + ph));
    this.worldAt = this.v.overWorld ? this.v.overWorld(t) : null;
    // which TV sets are on screen: only those may ask for the live feed
    c.updateMatrixWorld();
    FRUSTUM.setFromProjectionMatrix(PROJ.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse));
    for (const s of this.k.screens) if (s.set && s.mesh) s.visible = FRUSTUM.intersectsObject(s.mesh);
  }

  /** Riding above the real town this frame (the Ferris wheel): the eye in world tiles, else null. render/fpv.ts reads it. */
  worldAt: { x: number; y: number; z: number } | null = null;
  /** Is this room drawn over the city (its scene has no background of its own)? */
  get overWorld() { return !!this.v.overWorld; }
  /** Draw the room over what is already in the target (the city), sharing nothing but the picture: depth cleared first. */
  renderOver(renderer: WebGLRenderer) {
    // a colour background makes three.js clear the target whatever autoClear says: the city drawn first must stay
    this.k.scene.background = null;
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.k.scene, this.camera);
    renderer.autoClear = ac;
  }

  /** the TV sets in the room (debug and the TV check) */
  get tvs() { return this.k.screens.filter((s) => s.set); }
  /** the room's scene (the TV check counts its meshes) */
  get scene() { return this.k.scene; }

  setAspect(a: number) { if (Math.abs(this.camera.aspect - a) > 1e-4) { this.camera.aspect = a; this.camera.updateProjectionMatrix(); } }

  render(renderer: WebGLRenderer) { renderer.render(this.k.scene, this.camera); }

  dispose() { this.k.dispose(); }
}
