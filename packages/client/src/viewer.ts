/**
 * Building viewer (/viewer.html): every kind, level and design in the compiled
 * catalogue on a turntable, lit by the real building material so windows come
 * on at night. Reads only compiled output (MANIFEST + recipes via models.ts);
 * when a catalogue file changes, the Vite plugin recompiles and HMR reloads
 * this page, keeping the selection and filters in the URL hash.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Mesh, Group, PlaneGeometry, MeshLambertMaterial, Color, Vector3, GridHelper,
  ACESFilmicToneMapping, PCFSoftShadowMap, type MeshLambertMaterial as LambertT,
} from 'three';
import { MANIFEST, TECH_BY_ID, TRACK_NAMES, CATALOGUE_HASH, LADDERS, FUNFAIR_KIND, ladderOf, tierSummary, footprintLabel, techFor, type KindManifest, type LevelManifest, type DesignManifest, type Attributes } from '@msimcity/shared';
import { buildModels, allDesigns, model, type Design } from './render/models';
import { buildingMaterial } from './render/materials';
import { Lighting } from './render/lighting';
import { parkScatterGroup } from './render/parks';
import { landmarkPreview } from './render/landmarks';
import { LeisureAnims } from './render/leisureAnims';
import { WheelsView } from './render/wheels';
import { AmbientView } from './render/ambient';
import { RIGS } from './render/leisureRigs';
import { Matrix4 } from 'three';
import { nightUniform } from './render/materials';
import { Interior, EXTRA_ROOMS, type Place, type RoomKind } from './render/interiors';
import './render/leisureRooms'; // registers the free-time places' and the park's scenes
import { Zone, PARK_ACTIVITY_TEXT, type CitizenInfo } from '@msimcity/shared';

// ---------------------------------------------------------------- catalogue entries

interface Entry { kind: KindManifest; level: LevelManifest; design: DesignManifest; tier: number; built: Design }
buildModels();
const built = new Map(allDesigns().map((d) => [d.key, d]));
const tierOf = (l: LevelManifest) => Math.max(0, ...l.tech.map((id) => TECH_BY_ID.get(id)?.tier ?? 0));
const entries: Entry[] = MANIFEST.flatMap((kind) => kind.levels.flatMap((level) => level.designs.map((design) => ({ kind, level, design, tier: tierOf(level), built: built.get(design.key)! }))));
const FAMILY_LABEL: Record<string, string> = { residential: 'Residential', commercial: 'Commercial', industrial: 'Industrial', office: 'Office', civic: 'Civic', transport: 'Transport', leisure: 'Leisure' };
const families = [...new Set(MANIFEST.map((k) => k.family))];
/** metadata tags on kinds ('london': the landmarks), for the Tag filter (?tag=london) */
const TAGS = [...new Set(MANIFEST.flatMap((k) => k.tags ?? []))].sort();
/** the city draws moving parts over this design: a rig for its kind (and design, where the rig names one), or the funfair's wheel (render/leisureRigs.ts, wheels.ts) */
const moves = (e: Entry) => e.kind.kindId === FUNFAIR_KIND || RIGS.some((r) => r.kind === e.kind.kindId && (r.design === undefined || r.design === e.design.index));

// ---------------------------------------------------------------- state (kept in the hash so HMR reloads land in the same place)

const state = { key: entries[0].design.key, family: 'all', tier: -1, tag: 'all', motion: false, drafts: true, author: 'all', hour: 11, spin: true, site: false, tint: -1, view: 'kinds' as 'kinds' | 'ladders', lineup: false, inside: false, room: '', visit: 1 };
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('d') && entries.some((e) => e.design.key === p.get('d'))) state.key = p.get('d')!;
  if (p.get('f')) state.family = p.get('f')!;
  if (p.get('t')) state.tier = Number(p.get('t'));
  if (p.get('h')) state.hour = Math.max(0, Math.min(24, Number(p.get('h')) || 11));
  if (p.get('drafts') === '0') state.drafts = false;
  const q = new URLSearchParams(location.search); // ?author=… also works, for shareable links
  if (p.get('author') || q.get('author')) state.author = (p.get('author') || q.get('author'))!;
  if (p.get('tag') || q.get('tag')) state.tag = (p.get('tag') || q.get('tag'))!; // ?tag=london: the London landmarks
  if (p.get('m') === '1') state.motion = true; // only designs with moving parts
  if (p.get('site') === '1') state.site = true;
  if (p.get('v') === 'ladders') state.view = 'ladders';
  if (p.get('lu') === '1') state.lineup = true;
  if (p.get('in') === '1') state.inside = true;
  if (p.get('room')) state.room = p.get('room')!;
  if (p.get('visit')) state.visit = Math.max(1, Number(p.get('visit')) || 1);
}
function writeHash() {
  const p = new URLSearchParams({ d: state.key, f: state.family, t: String(state.tier), h: String(state.hour) });
  if (!state.drafts) p.set('drafts', '0');
  if (state.author !== 'all') p.set('author', state.author);
  if (state.tag !== 'all') p.set('tag', state.tag);
  if (state.motion) p.set('m', '1');
  if (state.site) p.set('site', '1');
  if (state.view === 'ladders') p.set('v', 'ladders');
  if (state.lineup) p.set('lu', '1');
  if (state.inside) { p.set('in', '1'); if (state.room) p.set('room', state.room); if (state.visit > 1) p.set('visit', String(state.visit)); }
  history.replaceState(null, '', '#' + p.toString());
}
readHash();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number) => '$' + (Math.round(n * 100) / 100).toLocaleString();
const hh = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const authorOf = (e: { design: { author?: string } }) => e.design.author ?? 'original';
const visible = () => entries.filter((e) => (state.family === 'all' || e.kind.family === state.family) && (state.tier < 0 || e.tier === state.tier) && (state.drafts || !e.design.draft) && (state.author === 'all' || authorOf(e) === state.author) && (state.tag === 'all' || !!e.kind.tags?.includes(state.tag)) && (!state.motion || moves(e)));
const current = () => entries.find((e) => e.design.key === state.key) ?? entries[0];

// ---------------------------------------------------------------- turntable

const canvas = $<HTMLCanvasElement>('view');
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const MAT_DAY = new Color(0x23453b), MAT_NIGHT = new Color(0x10201c);
function makeBench(scene: Scene) {
  const matMat = new MeshLambertMaterial({ color: MAT_DAY });
  const mat = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2), matMat);
  mat.receiveShadow = true;
  const grid = new GridHelper(40, 40, 0x4d8371, 0x3a6858);
  grid.position.y = 0.001;
  const lot = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new MeshLambertMaterial({ color: 0x9aa0a8 }));
  lot.position.y = 0.002;
  lot.receiveShadow = true;
  scene.add(mat, grid, lot);
  return { matMat, lot };
}
const scene = new Scene();
const bench = makeBench(scene);
const matMaterial = bench.matMat;
const lighting = new Lighting(scene);
lighting.mode = 'fixed';
const camera = new PerspectiveCamera(35, 1, 0.05, 200);
const turntable = new Group();
scene.add(turntable);
const material = buildingMaterial() as LambertT;
const shellMaterial = buildingMaterial() as LambertT;
shellMaterial.color.set(0x8e939b);
const helperMaterial = buildingMaterial();
let yaw = -0.6, pitch = 0.42, frameDist = 3, frameY = 0.4;

/** Frame a model `height` tall over a footprint `span` tiles across (the longer side). */
function frame(height: number, span = 1) {
  frameY = Math.min(height * 0.42, 1.6);
  frameDist = 1.65 * Math.max(2.1, height * 1.2 + 1.0, span * 1.15 + 0.8);
}
const spanOf = (k: KindManifest) => Math.max(k.footprint?.w ?? 1, k.footprint?.h ?? 1);
/** The first live design of each rung of a ladder at level 1 (the current rung shows the design being viewed). */
function lineupEntries(e: Entry): Entry[] {
  const lad = ladderOf(e.kind.kindId);
  if (!lad) return [e];
  return lad.tiers.map((k) => (k.kindId === e.kind.kindId ? e : entries.find((x) => x.kind.kindId === k.kindId && x.level.level === 1 && !x.design.draft) ?? e));
}
/** the current landmark's moving parts, turned by the game clock the viewer's hour stands for */
let moving: ReturnType<typeof landmarkPreview> = null;
/** the leisure places' moving parts and the funfair's wheel (render/leisureAnims.ts, wheels.ts), as the city draws them over the model */
const anims = new LeisureAnims(), wheels = new WheelsView(), ambient = new AmbientView();
scene.add(anims.group, wheels.group, ambient.group);
function showCurrent() {
  turntable.clear();
  moving = null;
  anims.clear('viewer'); wheels.clear('viewer'); ambient.clear('viewer');
  const e = current();
  const d = e.built;
  const tint = state.tint >= 0 && e.kind.tints ? e.kind.tints[state.tint] : 0xffffff;
  material.color.set(tint);
  if (state.site) {
    // the shell that rises is the design that will stand there, in concrete, inside the site fence, under a crane
    const shell = new Mesh(d.geometry, shellMaterial);
    shell.scale.set(1, 0.5, 1);
    const fence = new Mesh(model('site')!.geometry, helperMaterial);
    const crane = new Mesh(model('crane')!.geometry, helperMaterial);
    for (const m of [shell, fence, crane]) { m.castShadow = m.receiveShadow = true; turntable.add(m); }
  } else if (state.lineup && ladderOf(e.kind.kindId)) {
    // every rung of the ladder side by side, smallest first, on footprint-sized lots half a tile apart
    const row = lineupEntries(e);
    const widths = row.map((x) => x.kind.footprint?.w ?? 1);
    const total = widths.reduce((a, w) => a + w, 0) + 0.5 * (row.length - 1);
    let x0 = -total / 2, tallest = 0, deepest = 1;
    row.forEach((x, i) => {
      const m = new Mesh(x.built.geometry, material);
      m.castShadow = m.receiveShadow = true;
      m.position.x = x0 + widths[i] / 2;
      turntable.add(m);
      const trees = parkScatterGroup(x.design.attrs);
      if (trees) { trees.position.x = m.position.x; turntable.add(trees); }
      x0 += widths[i] + 0.5;
      tallest = Math.max(tallest, x.built.height); deepest = Math.max(deepest, x.kind.footprint?.h ?? 1);
    });
    bench.lot.visible = false;
    frame(tallest, Math.max(total * 0.74, deepest));
    return;
  } else {
    const m = new Mesh(d.geometry, material);
    m.castShadow = m.receiveShadow = true;
    turntable.add(m);
    const trees = parkScatterGroup(e.design.attrs); // parks: the trees and benches the city scatters as instances
    if (trees) turntable.add(trees);
    moving = landmarkPreview(e.kind.kindId); // landmarks: the Eye's wheel, Big Ben's dials (render/landmarks.ts)
    if (moving) turntable.add(moving.object);
    // the model stands at the origin as a built place whose door is tile (0, 0): the pass takes an open place as half full
    const placed = [{ key: e.built.key, matrix: new Matrix4(), sign: { kind: e.kind.kindId, x: 0, y: 0, r: 0 }, ad: [0, 0, 0] as [number, number, number] }];
    anims.setChunk('viewer', placed); wheels.setChunk('viewer', placed); ambient.setChunk('viewer', placed);
  }
  // the grey lot under the model covers its footprint
  bench.lot.visible = true;
  bench.lot.scale.set(e.kind.footprint?.w ?? 1, 1, e.kind.footprint?.h ?? 1);
  frame(state.site ? Math.max(1, d.height * 0.5) : d.height, spanOf(e.kind));
}

// ---------------------------------------------------------------- inside: the first-person rooms (render/interiors.ts)

const ROOM_NAME: Partial<Record<RoomKind, string>> = {
  lounge: 'lounge', kitchen: 'kitchen', bed: 'bedroom', shop: 'shop floor', cafe: 'café', office: 'office', police: 'police office',
  factory: 'factory floor', yard: 'yard', ward: 'ward', doctor: "doctor's room", fire: 'fire station', hub: 'terminal',
  stroll: 'stroll', picnic: 'picnic', kite: 'kite flying', ducks: 'feeding the ducks', band: 'band concert', sports: 'sports hall',
};
const roomName = (r: RoomKind) => ROOM_NAME[r] ?? String(r).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/-/g, ' ');
/** The rooms a citizen can be seen in at this kind, in the order the chips show them (the same rooms placeOf picks in the game). */
function roomsOf(kind: KindManifest): RoomKind[] {
  const vt = (kind.attrs as Attributes | undefined)?.venueType;
  if (kind.family === 'leisure') {
    if (vt === 'park') return [...(Object.keys(PARK_ACTIVITY_TEXT) as RoomKind[]), 'band'];
    return vt && (EXTRA_ROOMS[vt as RoomKind] || ['cinema', 'theatre', 'sports', 'library'].includes(String(vt))) ? [vt as RoomKind] : [];
  }
  const byCode: Record<number, RoomKind[]> = {
    [Zone.Residential]: ['lounge', 'kitchen', 'bed'], [Zone.Commercial]: ['shop', 'cafe'], [Zone.Industrial]: ['factory'], [Zone.Office]: ['office'],
    [Zone.Police]: ['police'], [Zone.Fire]: ['fire'], [Zone.Hospital]: ['ward', 'doctor'], [Zone.Yard]: ['yard'], [Zone.Hub]: ['hub'],
  };
  return byCode[kind.code] ?? [];
}
const WORK: ReadonlySet<RoomKind> = new Set<RoomKind>(['shop', 'office', 'police', 'factory', 'yard', 'ward', 'fire', 'hub']);
const HOME: ReadonlySet<RoomKind> = new Set<RoomKind>(['lounge', 'kitchen', 'bed']);
let interior: Interior | null = null, interiorFor = '';
/** look offsets the visitor adds by dragging, on top of the room's own idle glances */
let lookYaw = 0, lookPitch = 0, lookFov = 70;
/** Build the room the chips and the hour say, for a made-up visitor (like render/fpv.ts's preview), at this kind's door. */
function buildInterior() {
  const e = current(), rooms = roomsOf(e.kind);
  const room = rooms.includes(state.room as RoomKind) ? (state.room as RoomKind) : rooms[0];
  const key = `${e.design.key}|${room}|${state.visit}|${Math.round(state.hour * 4)}`;
  if (key === interiorFor && interior) return;
  interior?.dispose(); interior = null; interiorFor = key;
  if (!room) return;
  const seed = state.visit, x = 11 + seed * 3, y = 7 + seed * 5, kindId = e.kind.kindId;
  const work = WORK.has(room), home = HOME.has(room);
  const act = home ? 'at home' : work ? 'on shift' : '';
  const info = {
    id: 9_900_000 + seed * 17 + kindId, name: 'Visitor', role: 'citizen', mode: 'none', activity: act, status: 'idle', waitTicks: 0,
    home: { x: x + 2, y: y + 1, label: 'home', parcel: '' }, employer: work ? { x, y, kind: kindId } : undefined,
    venue: { x, y, kind: kindId },
    life: { age: 34, stage: 'adult', household: { id: 4000 + seed, members: [] } },
  } as unknown as CitizenInfo;
  const pseed = home ? ((x + 2) * 92821 + (y + 1) * 68917 + (4000 + seed) * 31) | 0 : work ? (x * 7919 + y * 104729) | 0 : (info.id * 31 + 7) | 0;
  const place: Place = { room, seed: pseed, key: `${home ? 'home' : work ? 'work' : 'venue'}:${pseed}:${room}`, venue: home || work ? undefined : { x, y, kind: kindId, seed: (x * 7919 + y * 104729 + kindId * 31) | 0 } };
  try { interior = new Interior(place, info, state.hour); } catch (err) { console.error('[viewer] interior', room, err); interior = null; }
}
function renderInsideTools() {
  const e = current(), rooms = roomsOf(e.kind);
  const box = $('insideTools');
  $('outsideBtn').setAttribute('aria-pressed', String(!state.inside));
  $('insideBtn').setAttribute('aria-pressed', String(state.inside));
  $<HTMLButtonElement>('insideBtn').disabled = !rooms.length;
  $('insideBtn').title = rooms.length ? 'First-person view from inside, as a citizen sees it' : 'No inside view for this kind';
  const on = state.inside && rooms.length > 0;
  box.hidden = !on;
  $('stage').classList.toggle('inside', on);
  if (!on) return;
  const cur = rooms.includes(state.room as RoomKind) ? state.room : rooms[0];
  $('roomChips').innerHTML = rooms.map((r) => `<button class="chip" data-room="${esc(r)}" aria-pressed="${r === cur}">${esc(roomName(r))}</button>`).join('');
  $('roomChips').querySelectorAll<HTMLButtonElement>('[data-room]').forEach((b) => (b.onclick = () => { state.room = b.dataset.room!; writeHash(); renderInsideTools(); }));
}
function setInside(on: boolean) {
  state.inside = on && roomsOf(current().kind).length > 0;
  lookYaw = 0; lookPitch = 0;
  if (!state.inside) { interior?.dispose(); interior = null; interiorFor = ''; }
  writeHash(); renderInsideTools();
}

let dragging = false, lastX = 0, lastY = 0, idleSince = 0;
canvas.addEventListener('pointerdown', (ev) => { dragging = true; lastX = ev.clientX; lastY = ev.clientY; canvas.setPointerCapture(ev.pointerId); });
canvas.addEventListener('pointermove', (ev) => {
  if (!dragging) return;
  if (interior) { // inside: turn the head
    lookYaw += (ev.clientX - lastX) * 0.004;
    lookPitch = Math.max(-1.1, Math.min(1.1, lookPitch + (ev.clientY - lastY) * 0.004));
    lastX = ev.clientX; lastY = ev.clientY; return;
  }
  yaw -= (ev.clientX - lastX) * 0.01;
  pitch = Math.max(0.08, Math.min(1.3, pitch + (ev.clientY - lastY) * 0.006));
  lastX = ev.clientX; lastY = ev.clientY; idleSince = performance.now();
});
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); if (interior) { lookFov = Math.max(30, Math.min(95, lookFov * (ev.deltaY > 0 ? 1.06 : 0.94))); return; } frameDist = Math.max(1.2, Math.min(14, frameDist * (ev.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduceMotion) state.spin = false;
const target = new Vector3();
let last = performance.now();
function tick(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (state.spin && !dragging && now - idleSince > 1500) yaw += dt * 0.35;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  if (state.inside) {
    applyHour(lighting, target, frameDist); // the hour's light: the rooms read the night uniform and the sky colour
    buildInterior();
    if (interior) {
      interior.setAspect(w / Math.max(1, h));
      interior.update(now, dt, state.hour, lighting.sky);
      const c = interior.camera;
      c.rotation.y += lookYaw; c.rotation.x = Math.max(-1.45, Math.min(1.45, c.rotation.x - lookPitch));
      if (Math.abs(c.fov - lookFov) > 0.01) { c.fov = lookFov; c.updateProjectionMatrix(); }
      if (interior.label !== $('insideLine').textContent) $('insideLine').textContent = interior.label;
      interior.render(renderer);
      requestAnimationFrame(tick);
      return;
    }
  }
  target.set(0, frameY, 0);
  camera.position.set(Math.sin(yaw) * Math.cos(pitch) * frameDist, frameY + Math.sin(pitch) * frameDist, Math.cos(yaw) * Math.cos(pitch) * frameDist);
  camera.lookAt(target);
  applyHour(lighting, target, frameDist);
  scene.background = lighting.sky;
  moving?.update(state.hour + now / 20000, nightUniform.value); // a game hour is 20 s, as in the city
  anims.frame([camera]); wheels.frame([camera]); ambient.frame([camera]);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
function applyHour(l: Lighting, t: Vector3, dist: number) {
  l.fixedHour = state.hour;
  l.update(state.hour, t, dist);
  const night = state.hour < 6.5 || state.hour > 18.5 ? 1 : 0;
  matMaterial.color.copy(MAT_DAY).lerp(MAT_NIGHT, night * 0.7);
}

// ---------------------------------------------------------------- thumbnails (one small offscreen renderer, re-shot when the light changes)

const thumbCanvas = document.createElement('canvas');
const thumbRenderer = new WebGLRenderer({ canvas: thumbCanvas, antialias: true, preserveDrawingBuffer: true });
thumbRenderer.setSize(192, 192, false);
thumbRenderer.toneMapping = ACESFilmicToneMapping;
thumbRenderer.toneMappingExposure = 1.05;
const thumbScene = new Scene();
makeBench(thumbScene);
const thumbLight = new Lighting(thumbScene);
thumbLight.mode = 'fixed';
thumbLight.setQuality(0);
const thumbCam = new PerspectiveCamera(32, 1, 0.05, 100);
const thumbMaterial = buildingMaterial();
const thumbs = new Map<string, string>();
let thumbJob = 0;
function shootThumbs() {
  const job = ++thumbJob;
  thumbs.clear();
  const queue = [...entries];
  const step = () => {
    if (job !== thumbJob) return;
    for (let n = 0; n < 6 && queue.length; n++) {
      const e = queue.shift()!;
      const m = new Mesh(e.built.geometry, thumbMaterial);
      thumbScene.add(m);
      const trees = parkScatterGroup(e.design.attrs);
      if (trees) thumbScene.add(trees);
      const parts = landmarkPreview(e.kind.kindId);
      if (parts) { parts.update(state.hour, nightUniform.value); thumbScene.add(parts.object); }
      const hgt = e.design.height, y = Math.min(hgt * 0.42, 1.6), dist = 1.75 * Math.max(1.2, hgt * 1.1 + 0.45, spanOf(e.kind) * 1.05 + 0.2);
      thumbCam.position.set(Math.sin(-0.6) * Math.cos(0.45) * dist, y + Math.sin(0.45) * dist, Math.cos(-0.6) * Math.cos(0.45) * dist);
      target.set(0, y, 0);
      thumbCam.lookAt(target);
      applyHour(thumbLight, target, dist);
      thumbScene.background = thumbLight.sky;
      thumbRenderer.render(thumbScene, thumbCam);
      thumbs.set(e.design.key, thumbCanvas.toDataURL('image/png'));
      thumbScene.remove(m);
      if (parts) thumbScene.remove(parts.object);
      if (trees) { thumbScene.remove(trees); trees.traverse((o) => (o as Mesh).geometry?.dispose()); }
      const img = document.querySelector<HTMLImageElement>(`img[data-key="${e.design.key}"]`);
      if (img) img.src = thumbs.get(e.design.key)!;
    }
    if (queue.length) setTimeout(step, 0);
  };
  step();
}

// ---------------------------------------------------------------- browse column

function renderFilters() {
  const fam = $('famRow'), tier = $('tierRow'), view = $('viewRow');
  const chip = (label: string, on: boolean, click: () => void) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = label; b.setAttribute('aria-pressed', String(on)); b.onclick = click;
    return b;
  };
  view.replaceChildren(view.firstElementChild!, chip('Kinds', state.view === 'kinds', () => setView('kinds')), chip('Ladders', state.view === 'ladders', () => setView('ladders')));
  fam.replaceChildren(fam.firstElementChild!, chip('All', state.family === 'all', () => setFilter('all', state.tier)), ...families.map((f) => chip(FAMILY_LABEL[f] ?? f, state.family === f, () => setFilter(f, state.tier))));
  const tiers = [...new Set(entries.map((e) => e.tier))].sort();
  tier.replaceChildren(tier.firstElementChild!, chip('Any', state.tier < 0, () => setFilter(state.family, -1)), ...tiers.map((t) => chip(t === 0 ? 'From the start' : `Tier ${t}`, state.tier === t, () => setFilter(state.family, t))));
  const tag = $('tagRow');
  tag.hidden = !TAGS.length;
  tag.replaceChildren(tag.firstElementChild!, chip('Any', state.tag === 'all', () => setTag('all')), ...TAGS.map((t) => chip(cap(t), state.tag === t, () => setTag(t))));
  const motion = $('motionRow');
  motion.replaceChildren(motion.firstElementChild!, chip('Any', !state.motion, () => setMotion(false)), chip('Moving parts', state.motion, () => setMotion(true)));
  motion.lastElementChild!.setAttribute('title', `Only the ${entries.filter(moves).length} designs the city draws moving parts over`);
  $<HTMLInputElement>('drafts').checked = state.drafts;
}
function setTag(t: string) { state.tag = t; refilter(); }
function setMotion(on: boolean) { state.motion = on; refilter(); }
/** the tag or motion filter changed: land on a design that still shows */
function refilter() {
  const list = visible();
  if (list.length && !list.some((e) => e.design.key === state.key)) state.key = list[0].design.key;
  if (!roomsOf(current().kind).length) state.inside = false;
  writeHash(); renderFilters(); renderGrid(); showCurrent(); renderSpec(); renderInsideTools();
}
function renderGrid() {
  const list = visible();
  const grid = $('grid');
  if (!list.length) { grid.innerHTML = '<p class="empty">No designs match these filters. Choose another family or tier.</p>'; return; }
  const groups = new Map<string, Entry[]>();
  // by ladder (Group by: Ladders): each ladder's rungs in tier order, then every kind that is not on a ladder
  const ordered = state.view === 'ladders'
    ? [...LADDERS.flatMap((l) => l.tiers.flatMap((k) => list.filter((e) => e.kind.kindId === k.kindId))), ...list.filter((e) => !ladderOf(e.kind.kindId))]
    : list;
  for (const e of ordered) { const g = `${e.kind.kindId}:${e.level.level}`; (groups.get(g) ?? groups.set(g, []).get(g)!).push(e); }
  let lastLadder = '';
  grid.innerHTML = [...groups.values()].map((g) => {
    const { kind, level } = g[0];
    const lad = state.view === 'ladders' ? ladderOf(kind.kindId) : undefined;
    let head = '';
    if (state.view === 'ladders' && (lad?.group.id ?? 'other') !== lastLadder) {
      lastLadder = lad?.group.id ?? 'other';
      head = lad ? `<h2 class="lad"><i style="background:${lad.group.color}"></i>${esc(lad.group.label)} <span>${lad.tiers.length} sizes</span></h2>` : '<h2 class="lad">Not on a ladder</h2>';
    }
    const lv = kind.levels.length > 1 || level.level > 1 ? ` <span>level ${level.level}</span>` : '';
    const rung = lad ? `<span class="rung">${kind.tier}</span> ` : '';
    // merged lots (shared/src/zones.ts) show their footprint like ladder rungs do
    const fp = lad || (kind.flags.growable && kind.footprint) ? ` <span>${footprintLabel(kind)}</span>` : '';
    return `${head}<h3>${rung}<b>${esc(cap(kind.name))}</b>${fp}${lv}</h3><div class="thumbs">${g.map((e) => `
      <button class="thumb" data-key="${e.design.key}" aria-current="${e.design.key === state.key}" title="${esc(e.design.name)}" aria-label="${esc(cap(e.kind.name))} level ${e.level.level}: ${esc(e.design.name)}${e.design.draft ? ' (draft)' : ''}${moves(e) ? ', moving parts' : ''}">
        <img data-key="${e.design.key}" alt="" src="${thumbs.get(e.design.key) ?? ''}" />
        <span class="tag">${e.design.key}</span>${e.design.draft ? '<span class="dr">draft</span>' : ''}${e.design.author ? `<span class="by">${esc(e.design.author.replace(/^claude-/, ''))}</span>` : ''}${moves(e) ? '<span class="mv">moving</span>' : ''}
      </button>`).join('')}</div>`;
  }).join('');
  grid.querySelectorAll<HTMLButtonElement>('button.thumb').forEach((b) => (b.onclick = () => select(b.dataset.key!)));
  $('count').textContent = `${list.length} of ${entries.length} designs · ${MANIFEST.length} kinds · catalogue ${CATALOGUE_HASH}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- spec sheet

const ATTR_LABEL: Record<string, string> = {
  pollution: 'Pollution', noise: 'Noise', goodsType: 'Goods', commerceType: 'Trade', visitorCapacity: 'Visitors at once',
  openHours: 'Open', style: 'Style', rentBand: 'Rent band', leisureValue: 'Leisure value', radius: 'Radius',
  venueType: 'Venue type', ticket: 'Ticket', stay: 'Visit lasts (h)', eventNights: 'Event days (0 = Mon)', eventStart: 'Event starts',
  dayAppeal: 'Appeal by day', eveningAppeal: 'Appeal in the evening', retireeAppeal: 'Appeal to retirees', childAppeal: 'Appeal to children',
  title: 'Called', upgradeVisits: 'Grows at visits a day', paths: 'Path layout', trees: 'Trees (scattered)', benches: 'Benches (scattered)',
  serviceRadius: 'Covers homes within (tiles)', serviceStrength: 'Coverage strength', patrolRate: 'Patrols or call-outs (× a station)',
  workRate: 'Builder pace (× a yard)', eventSize: 'Event-night pull (× usual)', decks: 'Decks', busStop: 'Bus stop at the gate (later)',
};
/** The ladder this kind is a rung of: blurb, how to place it and every rung side by side. */
function ladderHtml(kind: KindManifest): string {
  const lad = ladderOf(kind.kindId);
  if (!lad) return '';
  const row = (k: KindManifest) => {
    const s = tierSummary(k), t = techFor(k.tool?.id ?? '');
    const does = s.strength !== undefined ? `${s.radius}t ${Math.round(s.strength * 100)}%` : s.workRate !== undefined ? `${Math.round(s.workRate * 100)}%` : s.radius ? `${s.radius}t` : '–';
    const key = entries.find((x) => x.kind.kindId === k.kindId && !x.design.draft)?.design.key ?? '';
    return `<tr data-key="${esc(key)}" class="${k.kindId === kind.kindId ? 'on' : ''}"><td class="${k.kindId === kind.kindId ? 'on' : ''}">${s.tier}</td><td class="${k.kindId === kind.kindId ? 'on' : ''}">${esc(k.tool?.label ?? k.name)}</td><td>${s.footprint}</td><td>${s.holds}</td><td>${does}</td><td>${money(s.cost)}</td><td>${money(s.upkeep)}</td><td title="${esc(t?.name ?? 'from the start')}">${t ? `${esc(TRACK_NAMES[t.track].slice(0, 3))} ${t.tier}` : '–'}</td></tr>`;
  };
  return `<h4>${esc(lad.group.label)} ${lad.group.collection ? `${lad.group.noun ?? 'landmarks'} · ${kind.tier} of ${lad.tiers.length}` : `ladder · size ${kind.tier} of ${lad.tiers.length}`}</h4>
    ${kind.blurb ? `<p class="blurb">${esc(kind.blurb)}</p>` : ''}${kind.howTo ? `<p class="howto">${esc(kind.howTo)}</p>` : ''}
    <table class="levels ladder"><thead><tr><th>#</th><th>Size</th><th>Tiles</th><th>${esc(lad.group.holds)}</th><th>Covers</th><th>Cost</th><th>/day</th><th>Tech</th></tr></thead><tbody>${lad.tiers.map(row).join('')}</tbody></table>
    <p class="note">Click a row to view that size; tick <b>Ladder line-up</b> to see them side by side.</p>`;
}
const fmtAttr = (k: string, v: Attributes[string]) => (k === 'openHours' && Array.isArray(v) ? (v[0] === 0 && v[1] === 24 ? 'all day' : `${hh(Number(v[0]))} to ${hh(Number(v[1]))}`) : Array.isArray(v) ? v.join(', ') : String(v));
const FLAG_TEXT: Record<string, string> = {
  growable: 'Grows by itself on zoned land', civic: 'Placed by a player, staffed, paid upkeep', service: 'Covers nearby homes',
  workplace: 'Employs citizens', parking: 'Parks cars as its main job', leisureReady: 'Can host visitors',
};
function techText(ids: string[]) {
  if (!ids.length) return '<p class="note">Available from the start.</p>';
  return '<dl class="kv">' + ids.map((id) => {
    const t = TECH_BY_ID.get(id);
    return t ? `<dt>${esc(t.name)}</dt><dd>${esc(TRACK_NAMES[t.track])} tier ${t.tier} · ${money(t.cost)}</dd>` : `<dt>${esc(id)}</dt><dd></dd>`;
  }).join('') + '</dl>';
}
function renderSpec() {
  const e = current();
  const { kind, level, design } = e;
  $('titleKind').textContent = `${cap(kind.name)}${kind.levels.length > 1 || level.level > 1 ? `, level ${level.level}` : ''} · design ${design.index + 1} of ${level.designs.length}`;
  const merged = kind.flags.growable && !!kind.footprint;
  $('titleName').textContent = cap(design.name);
  const isWork = kind.flags.workplace;
  const rows: [string, (l: LevelManifest) => string][] = [
    [kind.code === 1 ? 'Residents' : 'Jobs', (l) => String(l.capacity)],
    ...(isWork ? [['Wage per shift', (l: LevelManifest) => money(l.wage)] as [string, (l: LevelManifest) => string]] : []),
    ['Upkeep per day', (l) => (l.upkeep ? money(l.upkeep) : '–')],
    ['Placement cost', (l) => (merged ? 'grown, not placed' : kind.flags.growable ? `${money(kind.tool?.cost ?? 0)}/tile` : money(l.cost))],
    ['Build work', (l) => (l.work ? String(l.work) : 'instant')],
    ['Parking', (l) => String(l.parking.surface)],
    ['Parking, deep', (l) => String(l.parking.underground)],
  ];
  const head = kind.levels.map((l) => `<th class="${l.level === level.level ? 'on' : ''}">L${l.level}</th>`).join('');
  const table = `<table class="levels"><thead><tr><th></th>${head}</tr></thead><tbody>${rows.map(([name, f]) => `<tr><td>${name}</td>${kind.levels.map((l) => `<td class="${l.level === level.level ? 'on' : ''}">${f(l)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const attrs = Object.entries(design.attrs).filter(([, v]) => v !== undefined);
  const occ = kind.occupation;
  const tints = kind.tints?.length ? `<h4>Facade tints</h4><div class="tints">${['none', ...kind.tints].map((c, i) => {
    const hex = c === 'none' ? '#ffffff' : '#' + (c as number).toString(16).padStart(6, '0');
    return `<button data-tint="${i - 1}" aria-pressed="${state.tint === i - 1}" title="${c === 'none' ? 'No tint' : hex}" aria-label="Tint ${c === 'none' ? 'none' : hex}" style="background:${hex}"></button>`;
  }).join('')}</div><p class="note">Each tile picks one of these by hash and dims it a little, so a street never repeats.</p>` : '';
  $('spec').innerHTML = `
    <h2>${esc(cap(design.name))}</h2>
    <div class="sub">${esc(cap(kind.name))}${kind.name !== kind.family ? `, ${esc((FAMILY_LABEL[kind.family] ?? kind.family).toLowerCase())} family` : ''}. Kind id ${kind.kindId}${kind.kindId !== kind.code ? ` (sub-kind of family code ${kind.code})` : ''}, level ${level.level}, design ${design.index + 1} of ${level.designs.length}.${merged ? ` Merged lots, ${footprintLabel(kind)}: grown when neighbouring ${esc(kind.family)} lots of one owner merge, never placed.` : ''}</div>
    <div>${design.draft ? '<span class="pill draft">Draft: viewer only, not placed in the city</span>' : ''}<span class="pill">${esc(design.key)}</span><span class="pill">${design.height} tiles tall</span><span class="pill">${design.ops} parts · ${e.built.geometry.attributes.position.count} vertices</span><span class="pill">${esc(kind.windows)} windows</span><span class="pill author">designed by ${esc(design.author ?? 'original catalogue')}</span>${moves(e) ? '<span class="pill moving" title="The city draws parts moving over this design (render/leisureRigs.ts, wheels.ts); the turntable shows them">moving parts</span>' : ''}${kind.landmark ? '<span class="pill">landmark</span>' : ''}${(kind.tags ?? []).map((t) => `<span class="pill">tag: ${esc(t)}</span>`).join('')}</div>
    ${ladderHtml(kind)}
    <h4>Per level</h4>${table}
    <h4>Tech needed</h4>${techText(level.tech)}
    <h4>Behaviour</h4><dl class="kv">${Object.entries(kind.flags).filter(([, on]) => on).map(([f]) => `<dt>${esc(FLAG_TEXT[f] ?? f)}</dt><dd></dd>`).join('') || '<dt>No special behaviour</dt><dd></dd>'}</dl>
    ${attrs.length ? `<h4>Attributes</h4><dl class="kv">${attrs.map(([k, v]) => `<dt>${esc(ATTR_LABEL[k] ?? k)}</dt><dd>${esc(fmtAttr(k, v))}</dd>`).join('')}</dl>` : ''}
    ${occ ? `<h4>Who works here</h4><dl class="kv"><dt>Occupation</dt><dd>${esc(occ.name)}</dd>${occ.shifts.map((s) => `<dt>Shift from ${hh(s.start)}</dt><dd>${s.hours} h · ${Math.round((s.weight / occ.shifts.reduce((a, x) => a + x.weight, 0)) * 100)}%</dd>`).join('')}<dt>Rosters</dt><dd>${occ.cycles.map((c) => c.map((d) => (d ? 'W' : '–')).join('')).join(', ')}</dd><dt>Rotating start</dt><dd>${occ.rotate ? 'yes' : 'no'}</dd></dl>` : ''}
    ${tints}
    <p class="note">Edit <code>packages/shared/src/buildings/${kind.landmark && kind.draft ? 'landmark-drafts' : esc(kind.family)}.ts</code>; this page reloads when the catalogue recompiles.</p>`;
  $('spec').querySelectorAll<HTMLTableRowElement>('table.ladder tr[data-key]').forEach((tr) => (tr.onclick = () => { if (tr.dataset.key) { select(tr.dataset.key); document.querySelector<HTMLElement>(`button.thumb[data-key="${tr.dataset.key}"]`)?.scrollIntoView({ block: 'nearest' }); } }));
  $('spec').querySelectorAll<HTMLButtonElement>('[data-tint]').forEach((b) => (b.onclick = () => { state.tint = Number(b.dataset.tint); showCurrent(); renderSpec(); }));
}

// ---------------------------------------------------------------- controls

function select(key: string) {
  if (!entries.some((e) => e.design.key === key)) return;
  if (current().kind.kindId !== entries.find((e) => e.design.key === key)!.kind.kindId) state.tint = -1;
  const sameKind = current().kind.kindId === entries.find((e) => e.design.key === key)!.kind.kindId;
  state.key = key;
  if (!sameKind) { state.room = ''; lookYaw = 0; lookPitch = 0; if (!roomsOf(current().kind).length) setInside(false); }
  writeHash();
  showCurrent(); renderSpec(); renderInsideTools();
  document.querySelectorAll('button.thumb').forEach((b) => b.setAttribute('aria-current', String((b as HTMLElement).dataset.key === key)));
}
function setFilter(family: string, tier: number) {
  state.family = family; state.tier = tier;
  const list = visible();
  if (list.length && !list.some((e) => e.design.key === state.key)) state.key = list[0].design.key;
  writeHash(); renderFilters(); renderGrid(); showCurrent(); renderSpec();
}
function setView(v: 'kinds' | 'ladders') {
  state.view = v;
  writeHash(); renderFilters(); renderGrid();
  document.querySelector<HTMLElement>(`button.thumb[data-key="${state.key}"]`)?.scrollIntoView({ block: 'nearest' });
}
function setHour(h: number, reshoot = true) {
  const night = h < 6.5 || h > 18.5;
  const changedSide = night !== (state.hour < 6.5 || state.hour > 18.5);
  state.hour = h;
  $<HTMLInputElement>('hour').value = String(h);
  $('hourVal').textContent = hh(h);
  $('dayBtn').setAttribute('aria-pressed', String(!night));
  $('nightBtn').setAttribute('aria-pressed', String(night));
  writeHash();
  if (reshoot && changedSide) shootThumbs();
}
$('outsideBtn').onclick = () => setInside(false);
$('insideBtn').onclick = () => setInside(true);
$('visitBtn').onclick = () => { state.visit++; lookYaw = 0; lookPitch = 0; writeHash(); };
$('dayBtn').onclick = () => setHour(11);
$('nightBtn').onclick = () => setHour(20.5);
$<HTMLInputElement>('hour').oninput = (ev) => setHour(Number((ev.target as HTMLInputElement).value));
$<HTMLInputElement>('drafts').onchange = (ev) => { state.drafts = (ev.target as HTMLInputElement).checked; setFilter(state.family, state.tier); };
{ // designer filter: everyone who has a design in the catalogue
  const sel = $<HTMLSelectElement>('author');
  const names = [...new Set(entries.map((e) => authorOf(e)))].sort((a, b) => (a === 'original' ? -1 : b === 'original' ? 1 : a.localeCompare(b)));
  sel.innerHTML = `<option value="all">Everyone</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n === 'original' ? 'original catalogue' : n)} (${entries.filter((e) => authorOf(e) === n).length})</option>`).join('');
  sel.value = names.includes(state.author) ? state.author : 'all';
  sel.onchange = () => { state.author = sel.value; if (state.author !== 'all') state.drafts = true; $<HTMLInputElement>('drafts').checked = state.drafts; setFilter(state.family, state.tier); };
  if (state.author !== 'all') setFilter(state.family, state.tier); // opened with a designer in the link: show their first design
}
$<HTMLInputElement>('spin').checked = state.spin;
$<HTMLInputElement>('spin').onchange = (ev) => { state.spin = (ev.target as HTMLInputElement).checked; };
$<HTMLInputElement>('site').checked = state.site;
$<HTMLInputElement>('site').onchange = (ev) => { state.site = (ev.target as HTMLInputElement).checked; writeHash(); showCurrent(); };
$<HTMLInputElement>('lineup').checked = state.lineup;
$<HTMLInputElement>('lineup').onchange = (ev) => { state.lineup = (ev.target as HTMLInputElement).checked; writeHash(); showCurrent(); };
window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
  const list = visible(), i = list.findIndex((e) => e.design.key === state.key);
  const next = list[(i + (ev.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
  if (next) { select(next.design.key); document.querySelector<HTMLElement>(`button.thumb[data-key="${next.design.key}"]`)?.scrollIntoView({ block: 'nearest' }); }
});

setHour(state.hour, false);
if ((state.tag !== 'all' || state.motion) && !visible().some((e) => e.design.key === state.key)) state.key = visible()[0]?.design.key ?? state.key; // ?tag=london opens on a landmark, m=1 on moving parts
renderFilters(); renderGrid(); showCurrent(); renderSpec(); setInside(state.inside);
shootThumbs();
requestAnimationFrame(tick);

/** For headless checks and the console. */
(window as unknown as { viewer: object }).viewer = {
  select, setFilter, setHour, entries: () => entries.map((e) => e.design.key),
  setMotion, moving: () => entries.filter(moves).map((e) => e.design.key),
  thumbsReady: () => thumbs.size === entries.length,
  setSpin: (on: boolean) => { state.spin = on; $<HTMLInputElement>('spin').checked = on; },
  setYaw: (y: number) => { yaw = y; },
  setPitch: (p: number) => { pitch = p; },
  setView, setLineup: (on: boolean) => { state.lineup = on; $<HTMLInputElement>('lineup').checked = on; writeHash(); showCurrent(); },
  ladders: () => LADDERS.map((l) => ({ group: l.group.id, keys: l.tiers.map((k) => entries.find((x) => x.kind.kindId === k.kindId && !x.design.draft)?.design.key) })),
  zoom: (f: number) => { frameDist *= f; },
  setInside, rooms: () => roomsOf(current().kind), setRoom: (r: string) => { state.room = r; writeHash(); renderInsideTools(); },
  insideLine: () => interior?.label ?? null,
};
