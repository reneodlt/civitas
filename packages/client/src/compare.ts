/**
 * Model comparison matrix (/compare.html): the building designs down the rows,
 * the design authors (the models that wrote them) across the columns, so the
 * output of different models on the same brief can be compared side by side.
 * Each cell is a thumbnail shot exactly as the viewer shoots them (same bench,
 * same light); click a cell to open that design in the building viewer.
 * Reads only compiled output (MANIFEST + recipes via models.ts); the Vite
 * catalogue plugin recompiles on change and HMR reloads this page.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Mesh, Vector3, Box3, PlaneGeometry, GridHelper, MeshLambertMaterial, Group,
  ACESFilmicToneMapping, type Object3D, type MeshLambertMaterial as LambertT,
} from 'three';
import { MANIFEST, CATALOGUE_HASH, type KindManifest, type LevelManifest, type DesignManifest } from '@msimcity/shared';
import { buildModels, allDesigns, type Design } from './render/models';
import { buildingMaterial, nightUniform } from './render/materials';
import { Lighting } from './render/lighting';
import { parkScatterGroup } from './render/parks';
import { landmarkPreview } from './render/landmarks';

// ---------------------------------------------------------------- catalogue entries

interface Entry { kind: KindManifest; level: LevelManifest; design: DesignManifest; built: Design }
buildModels();
const built = new Map(allDesigns().map((d) => [d.key, d]));
const entries: Entry[] = MANIFEST.flatMap((kind) => kind.levels.flatMap((level) => level.designs.map((design) => ({ kind, level, design, built: built.get(design.key)! }))));
const authorOf = (e: { design: { author?: string } }) => e.design.author ?? 'original';
/** columns: the models first (alphabetical), the original catalogue last */
const authors = [...new Set(entries.map(authorOf))].sort((a, b) => (a === 'original' ? 1 : b === 'original' ? -1 : a.localeCompare(b)));
/** metadata tags on kinds ('london', 'world', the city tags), for the Tag filter */
const TAGS = [...new Set(MANIFEST.flatMap((k) => k.tags ?? []))].sort();
const MODEL_ROW = (r: Row) => r.designs.some((e) => authorOf(e) !== 'original');

// ---------------------------------------------------------------- state (kept in the hash)

const state = { hour: 11, tag: 'all', scope: 'models' as 'models' | 'all', drafts: true, open: '' };
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const q = new URLSearchParams(location.search); // ?tag=… also works, for shareable links
  if (p.get('h')) state.hour = Math.max(0, Math.min(24, Number(p.get('h')) || 11));
  if (p.get('scope') === 'all') state.scope = 'all';
  if (p.get('drafts') === '0') state.drafts = false;
  if (p.get('tag') || q.get('tag')) state.tag = (p.get('tag') || q.get('tag'))!;
  if (p.get('open') || q.get('open')) state.open = (p.get('open') || q.get('open'))!; // ?open=<design key>: start with the modal up
}
function writeHash() {
  const p = new URLSearchParams({ h: String(state.hour), scope: state.scope });
  if (!state.drafts) p.set('drafts', '0');
  if (state.tag !== 'all') p.set('tag', state.tag);
  history.replaceState(null, '', '#' + p.toString());
}
readHash();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hh = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
/** Camera offset from the look-at point for a yaw and pitch (the same orbit the modal and thumbnails use). */
const viewDir = (yaw: number, pitch: number) => new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
/**
 * The smallest distance from `center` at which a camera looking along -dir with vertical field `fovDeg` sees every corner
 * of `box`, plus a margin. Fits the real bounds, so a tall or wide design is never cropped at the edge of its picture.
 */
function fitDist(box: Box3, center: Vector3, dir: Vector3, fovDeg: number, aspect = 1, margin = 1.12): number {
  const t = Math.tan((fovDeg * Math.PI) / 360), tx = t * aspect;
  const right = new Vector3().crossVectors(dir.clone().negate(), new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, dir.clone().negate());
  let d = 0;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const p = new Vector3(x, y, z).sub(center), s = p.dot(dir);
    d = Math.max(d, s + Math.abs(p.dot(right)) / tx, s + Math.abs(p.dot(up)) / t);
  }
  return Math.max(d, 0.5) * margin;
}

// ---------------------------------------------------------------- rows: one per building (kind × level)

interface Row { kind: KindManifest; level: LevelManifest; designs: Entry[] }
const rowsAll: Row[] = [];
{
  const byGroup = new Map<string, Row>();
  for (const e of entries) {
    const g = `${e.kind.kindId}:${e.level.level}`;
    let row = byGroup.get(g);
    if (!row) { row = { kind: e.kind, level: e.level, designs: [] }; byGroup.set(g, row); rowsAll.push(row); }
    row.designs.push(e);
  }
}
const visibleRows = () => rowsAll.filter((r) =>
  r.designs.some((e) => state.drafts || !e.design.draft) &&
  (state.scope === 'all' || MODEL_ROW(r)) &&
  (state.tag === 'all' || !!r.kind.tags?.includes(state.tag)));
/** columns for the current filter: only authors with at least one design in the visible rows, in the global column order */
const visibleAuthors = (rows: Row[]) => {
  const set = new Set<string>();
  for (const r of rows) for (const e of r.designs) if (state.drafts || !e.design.draft) set.add(authorOf(e));
  return authors.filter((a) => set.has(a));
};

// ---------------------------------------------------------------- thumbnails (one small offscreen renderer, re-shot when the light changes)

const thumbCanvas = document.createElement('canvas');
let thumbRenderer: WebGLRenderer | null = null;
try {
  thumbRenderer = new WebGLRenderer({ canvas: thumbCanvas, antialias: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(192, 192, false);
  thumbRenderer.toneMapping = ACESFilmicToneMapping;
  thumbRenderer.toneMappingExposure = 1.05;
} catch {
  // no WebGL (a VM, a remote desktop): the matrix still lists every design, just without pictures
}
const thumbScene = new Scene();
const MAT_DAY = 0x23453b, MAT_NIGHT = 0x10201c;
const benchMat = new MeshLambertMaterial({ color: MAT_DAY });
{
  const mat = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2), benchMat);
  const grid = new GridHelper(40, 40, 0x4d8371, 0x3a6858);
  grid.position.y = 0.001;
  thumbScene.add(mat, grid);
}
const thumbLight = new Lighting(thumbScene);
thumbLight.mode = 'fixed';
thumbLight.setQuality(0);
const thumbCam = new PerspectiveCamera(32, 1, 0.05, 100);
const thumbMaterial = buildingMaterial();
const thumbs = new Map<string, string>(); // `${designKey}@${hour}` → data URL
let thumbJob = 0, pending = 0;
const target = new Vector3();

function shoot(list: Entry[], hour: number) {
  const job = ++thumbJob;
  pending = thumbRenderer ? list.length : 0;
  if (!thumbRenderer) { updateCount(); return; }
  const queue = [...list];
  const night = hour < 6.5 || hour > 18.5;
  const step = () => {
    if (job !== thumbJob) return;
    for (let n = 0; n < 6 && queue.length; n++) {
      const e = queue.shift()!;
      const cacheKey = `${e.design.key}@${hour}`;
      let url = thumbs.get(cacheKey);
      if (!url) {
        const m = new Mesh(e.built.geometry, thumbMaterial);
        thumbScene.add(m);
        const trees = parkScatterGroup(e.design.attrs);
        if (trees) thumbScene.add(trees);
        const parts = landmarkPreview(e.kind.kindId);
        if (parts) { parts.update(hour, nightUniform.value); thumbScene.add(parts.object); }
        const box = new Box3().expandByObject(m);
        if (trees) box.expandByObject(trees);
        if (parts) box.expandByObject(parts.object);
        // the caption covers the foot of the square: fit the model with a band of empty space below it, so it sits high
        const dir = viewDir(-0.6, 0.45);
        const fitBox = box.clone();
        fitBox.min.y -= (box.max.y - box.min.y) * 0.45;
        target.copy(fitBox.getCenter(new Vector3()));
        const dist = fitDist(fitBox, target, dir, thumbCam.fov);
        thumbCam.position.copy(target).addScaledVector(dir, dist);
        thumbCam.lookAt(target);
        thumbLight.fixedHour = hour;
        thumbLight.update(hour, target, dist);
        thumbScene.background = thumbLight.sky;
        benchMat.color.set(night ? MAT_NIGHT : MAT_DAY);
        thumbRenderer.render(thumbScene, thumbCam);
        url = thumbCanvas.toDataURL('image/png');
        if (thumbs.size > 400) thumbs.clear(); // scrubbing the hour fills the cache; start over rather than grow without bound
        thumbs.set(cacheKey, url);
        thumbScene.remove(m);
        if (parts) thumbScene.remove(parts.object);
        if (trees) { thumbScene.remove(trees); trees.traverse((o) => (o as Mesh).geometry?.dispose()); }
      }
      const img = document.querySelector<HTMLImageElement>(`img[data-key="${e.design.key}"]`);
      if (img) img.src = url;
      pending--;
    }
    if (queue.length) setTimeout(step, 0);
    else if (job === thumbJob) updateCount();
  };
  step();
}
const shootVisible = () => shoot(visibleRows().flatMap((r) => r.designs), state.hour);

// ---------------------------------------------------------------- matrix

function renderToolbar() {
  const sel = $<HTMLSelectElement>('tag');
  sel.innerHTML = `<option value="all">Any</option>` + TAGS.map((t) => `<option value="${esc(t)}">${esc(cap(t))}</option>`).join('');
  sel.value = TAGS.includes(state.tag) ? state.tag : 'all';
  state.tag = sel.value;
  sel.onchange = () => { state.tag = sel.value; writeHash(); renderMatrix(); };
  $<HTMLSelectElement>('scope').value = state.scope;
  $<HTMLSelectElement>('scope').onchange = (ev) => { state.scope = (ev.target as HTMLSelectElement).value as 'models' | 'all'; writeHash(); renderMatrix(); };
  $<HTMLInputElement>('drafts').checked = state.drafts;
  $<HTMLInputElement>('drafts').onchange = (ev) => { state.drafts = (ev.target as HTMLInputElement).checked; writeHash(); renderMatrix(); };
}

function updateCount() {
  const rows = visibleRows();
  const cols = visibleAuthors(rows);
  const cells = rows.reduce((a, r) => a + r.designs.length, 0);
  $('count').textContent = pending
    ? `shooting ${pending} thumbnails…`
    : `${rows.length} buildings × ${cols.length} authors · ${cells} designs · catalogue ${CATALOGUE_HASH}${thumbRenderer ? '' : ' · no WebGL: pictures off'}`;
}

function renderMatrix() {
  const rows = visibleRows();
  const table = $('mx');
  if (!rows.length) {
    table.innerHTML = '<tbody><tr><td class="empty">No buildings match these filters. Widen the row scope or pick another tag.</td></tr></tbody>';
    updateCount();
    return;
  }
  const cols = visibleAuthors(rows);
  table.innerHTML = `
    <thead><tr>
      <th class="rowhead" scope="col">Building</th>
      ${cols.map((a) => `<th scope="col"><span class="n">${esc(a === 'original' ? 'original catalogue' : a)}</span><span class="c">${entries.filter((e) => authorOf(e) === a).length} designs</span></th>`).join('')}
    </tr></thead>
    <tbody>${rows.map((r) => {
      const multi = r.kind.levels.length > 1 || r.level.level > 1;
      const byAuthor = new Map<string, Entry[]>();
      for (const e of r.designs) { const a = authorOf(e); (byAuthor.get(a) ?? byAuthor.set(a, []).get(a)!).push(e); }
      return `<tr>
        <th class="rowhead" scope="row"><span class="kind">${esc(cap(r.kind.name))}</span>
          <span class="meta">${multi ? `level ${r.level.level} · ` : ''}${r.designs.length} design${r.designs.length === 1 ? '' : 's'}</span>
          <span class="tags">${(r.kind.tags ?? []).map((t) => `<span class="pill">${esc(t)}</span>`).join('')}${r.kind.landmark ? '<span class="pill">landmark</span>' : ''}</span>
        </th>
        ${cols.map((a) => {
          const list = byAuthor.get(a);
          if (!list || (!state.drafts && list.every((e) => e.design.draft))) return '<td class="none">—</td>';
          const e = list[0];
          return `<td class="cell"><a data-cell="${e.design.key}" href="/viewer.html?d=${encodeURIComponent(e.design.key)}" title="${esc(cap(r.kind.name))} — ${esc(e.design.name)} (${e.design.height} tiles, ${e.built.geometry.attributes.position.count} vertices)">
            <img data-key="${e.design.key}" alt="${esc(e.design.name)}" src="" />
            <span class="dname">${esc(e.design.name)}</span>
            ${list.length > 1 ? `<span class="multi">×${list.length}</span>` : ''}${e.design.draft ? '<span class="dr">draft</span>' : ''}
          </a></td>`;
        }).join('')}
      </tr>`;
    }).join('')}</tbody>`;
  shootVisible();
}

// ---------------------------------------------------------------- hour

function setHour(h: number) {
  state.hour = Math.max(0, Math.min(24, h));
  $<HTMLInputElement>('hour').value = String(state.hour);
  $('hourVal').textContent = hh(state.hour);
  const night = state.hour < 6.5 || state.hour > 18.5;
  $('dayBtn').setAttribute('aria-pressed', String(!night));
  $('nightBtn').setAttribute('aria-pressed', String(night));
  writeHash();
  debounceShoot();
}
let shootTimer: ReturnType<typeof setTimeout> | undefined;
function debounceShoot() {
  clearTimeout(shootTimer);
  shootTimer = setTimeout(shootVisible, 250); // the matrix is all thumbnails: reshoot at the chosen hour, batched
}
$('dayBtn').onclick = () => setHour(11);
$('nightBtn').onclick = () => setHour(20.5);
$<HTMLInputElement>('hour').oninput = (ev) => setHour(Number((ev.target as HTMLInputElement).value));

// ---------------------------------------------------------------- modal preview (click a cell)

const modal = $<HTMLDivElement>('modal');
const modalCanvas = $<HTMLCanvasElement>('modalView');
const entriesByKey = new Map(entries.map((e) => [e.design.key, e]));
let modalRenderer: WebGLRenderer | null = null;
let modalScene: Scene | null = null;
let modalLight: Lighting | null = null;
let modalTurntable: Group | null = null;
let modalCam: PerspectiveCamera | null = null;
let modalMaterial: LambertT | null = null;
let modalBenchMat: MeshLambertMaterial | null = null;
let modalMoving: ReturnType<typeof landmarkPreview> = null;
let modalTrees: Object3D | null = null;
let modalRaf = 0, mLast = performance.now();
let mYaw = -0.6, mPitch = 0.42, mDist = 3, mFrameY = 0.4, mDragging = false, mLastX = 0, mLastY = 0, mIdleSince = 0;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function ensureModalGL(): boolean {
  if (modalRenderer) return true;
  try {
    modalRenderer = new WebGLRenderer({ canvas: modalCanvas, antialias: true });
    modalRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    modalRenderer.toneMapping = ACESFilmicToneMapping;
    modalRenderer.toneMappingExposure = 1.05;
    modalScene = new Scene();
    const benchMat = new MeshLambertMaterial({ color: MAT_DAY });
    const mat = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2), benchMat);
    mat.receiveShadow = true;
    const grid = new GridHelper(40, 40, 0x4d8371, 0x3a6858);
    grid.position.y = 0.001;
    modalScene.add(mat, grid);
    modalBenchMat = benchMat;
    modalLight = new Lighting(modalScene);
    modalLight.mode = 'fixed';
    modalTurntable = new Group();
    modalScene.add(modalTurntable);
    modalCam = new PerspectiveCamera(35, 1, 0.05, 200);
    modalMaterial = buildingMaterial() as LambertT;
    return true;
  } catch {
    modalRenderer = null;
    return false;
  }
}

function openModal(key: string) {
  const e = entriesByKey.get(key);
  if (!e) return;
  $('modalKind').textContent = `${cap(e.kind.name)}${e.kind.levels.length > 1 || e.level.level > 1 ? `, level ${e.level.level}` : ''} · designed by ${authorOf(e)} · ${e.design.height} tiles`;
  $('modalTitle').textContent = cap(e.design.name);
  $<HTMLAnchorElement>('modalViewer').href = `/viewer.html?d=${encodeURIComponent(key)}`;
  if (!ensureModalGL()) {
    $('modalNone').hidden = false;
  } else {
    $('modalNone').hidden = true;
    modalTurntable!.clear();
    modalMoving = landmarkPreview(e.kind.kindId);
    modalTrees = parkScatterGroup(e.design.attrs);
    const m = new Mesh(e.built.geometry, modalMaterial!);
    m.castShadow = m.receiveShadow = true;
    modalTurntable!.add(m);
    if (modalTrees) modalTurntable!.add(modalTrees);
    if (modalMoving) modalTurntable!.add(modalMoving.object);
    // the turntable spins about the vertical axis through the middle of the model: fit it at every yaw, not just the first
    const box = new Box3().setFromObject(modalTurntable!);
    mFrameY = (box.min.y + box.max.y) / 2;
    const axis = new Vector3(0, mFrameY, 0);
    mDist = 0;
    for (let i = 0; i < 24; i++) mDist = Math.max(mDist, fitDist(box, axis, viewDir((i * Math.PI) / 12, mPitch), 35));
  }
  modal.hidden = false;
  $('modalClose').focus();
  cancelAnimationFrame(modalRaf);
  mLast = performance.now();
  modalRaf = requestAnimationFrame(modalTick);
}
function closeModal() {
  modal.hidden = true;
  cancelAnimationFrame(modalRaf);
  modalMoving = null;
  modalTrees?.traverse((o) => (o as Mesh).geometry?.dispose()); // the trees own their geometry; the model mesh shares the registry's
  modalTrees = null;
  modalTurntable?.clear();
}
function modalTick(now: number) {
  if (modal.hidden || !modalRenderer) return;
  const dt = Math.min(0.1, (now - mLast) / 1000); mLast = now;
  if ($<HTMLInputElement>('modalSpin').checked && !mDragging && !reduceMotion && now - mIdleSince > 1500) mYaw += dt * 0.35;
  const w = modalCanvas.clientWidth, h = modalCanvas.clientHeight;
  if (modalCanvas.width !== Math.floor(w * modalRenderer.getPixelRatio()) || modalCanvas.height !== Math.floor(h * modalRenderer.getPixelRatio())) {
    modalRenderer.setSize(w, h, false);
    modalCam!.aspect = w / Math.max(1, h);
    modalCam!.updateProjectionMatrix();
  }
  target.set(0, mFrameY, 0);
  modalCam!.position.set(Math.sin(mYaw) * Math.cos(mPitch) * mDist, mFrameY + Math.sin(mPitch) * mDist, Math.cos(mYaw) * Math.cos(mPitch) * mDist);
  modalCam!.lookAt(target);
  const l = modalLight!;
  l.fixedHour = state.hour;
  l.update(state.hour, target, mDist);
  modalScene!.background = l.sky;
  const night = state.hour < 6.5 || state.hour > 18.5;
  modalBenchMat!.color.set(night ? MAT_NIGHT : MAT_DAY);
  modalMoving?.update(state.hour + now / 20000, nightUniform.value); // a game hour is 20 s, as in the city
  modalRenderer.render(modalScene!, modalCam!);
  modalRaf = requestAnimationFrame(modalTick);
}
$('modalClose').onclick = closeModal;
$('modalBack').onclick = closeModal;
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !modal.hidden) closeModal(); });
modalCanvas.addEventListener('pointerdown', (ev) => { mDragging = true; mLastX = ev.clientX; mLastY = ev.clientY; modalCanvas.setPointerCapture(ev.pointerId); });
modalCanvas.addEventListener('pointermove', (ev) => {
  if (!mDragging) return;
  mYaw -= (ev.clientX - mLastX) * 0.01;
  mPitch = Math.max(0.08, Math.min(1.3, mPitch + (ev.clientY - mLastY) * 0.006));
  mLastX = ev.clientX; mLastY = ev.clientY; mIdleSince = performance.now();
});
modalCanvas.addEventListener('pointerup', () => { mDragging = false; });
modalCanvas.addEventListener('wheel', (ev) => { ev.preventDefault(); mDist = Math.max(1.2, Math.min(30, mDist * (ev.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });
// a cell opens the modal; the anchor keeps its href so middle-click still opens the viewer
$('mx').addEventListener('click', (ev) => {
  const a = (ev.target as HTMLElement).closest<HTMLElement>('a[data-cell]');
  if (!a) return;
  ev.preventDefault();
  openModal(a.dataset.cell!);
});

renderToolbar();
setHour(state.hour);
renderMatrix();
if (state.open) openModal(state.open); // ?open=<design key>: start with the modal up

/** For headless checks and the console. */
(window as unknown as { compare: object }).compare = {
  rows: () => visibleRows().map((r) => `${r.kind.kindId}:${r.level.level}`),
  authors: () => authors,
  setHour,
  openModal,
  thumbsReady: () => pending === 0,
};
