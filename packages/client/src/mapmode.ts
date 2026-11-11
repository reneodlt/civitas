import { Vector3 } from 'three';
import { MAX_TAX, PARCEL_COLOURS, SECTOR_TILES, planCombine, planSplit, mapClassOf, type ParcelDTO, type ServerMsg } from '@msimcity/shared';
import type { NetClient } from './net';
import type { ClientWorld } from './world';
import { CameraRig, MAP_PITCH, DIST_MAX, MAP_DIST_MIN, MAP_DIST_MAX } from './camera';
import type { MapInput } from './input';
import { MapView, type MapMark } from './render/worldmap';
import { eduTotals, eduIndexLabel } from './eduView';
import { LandMarketView } from './landmarket';

/**
 * The world map mode (docs/world-map.md): Tab, the map chip, or zooming out past the 3D limit. Owns the map's camera
 * moves, its pointer handling (pan, click to select, shift-click to add, drag a cut to split), the 'map' requests for
 * the sectors in view, and the parcel panel with combine, split, leave estate, rename, colour and tax.
 */
interface Deps {
  net: NetClient; world: ClientWorld; rig: CameraRig; canvas: HTMLCanvasElement; mount: HTMLElement;
  toast(kind: 'info' | 'error', msg: string): void;
  status(text: string): void;
  /** the map came up or went: main.ts drops or streams chunks, hides the 3D panels */
  onToggle(on: boolean): void;
}
interface Totals { area: number; buildings: number; population: number; employed: number; jobs: number; roads: number; value: number; tax: number; sites: number; edu: ReturnType<typeof eduTotals> }
const EASE_S = 0.4;
/** sectors in view are asked again this often while the map is up (ms) */
const REFRESH_MS = 3000;
/** parcels messages are taken in at most this often while the map is up (ms) */
const PARCELS_MS = 500;
const CLASS_NAMES = ['grass', 'sand', 'water', 'road', 'railway', 'airfield', 'homes', 'shops', 'industry', 'offices', 'civic', 'transport', 'leisure'];
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-GB');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class MapMode implements MapInput {
  readonly view: MapView;
  on = false;
  private panel = document.createElement('div');
  /** the parcels picked: one (its panel), or several (shift-click) to combine */
  private sel: number[] = [];
  /** the parcel being cut, while Split is armed */
  private splitFor = 0;
  private press: { px: number; py: number; moved: boolean; shift: boolean; cut: [number, number] | null } | null = null;
  private cut: { a: [number, number]; b: [number, number] } | null = null;
  /** the camera's 3D pose when the map came up, to go back to */
  private saved = { pitch: 0.95, yaw: Math.PI / 4 };
  private ease: { t: number; from: { pitch: number; yaw: number; dist: number }; to: { pitch: number; yaw: number; dist: number } } | null = null;
  /** the tour put the map up and flies the camera itself: leave the pitch to it */
  private tourCam = false;
  private lastAsk = 0;
  private lastView = '';
  private tmp = new Vector3();
  private panelSig = '';
  /** the selection the panel was last drawn for (its market forms are kept across redraws of it) */
  private keptSig = '';
  /** the status line holds a preview's verdict, to clear when the preview goes */
  private saidStatus = false;
  /** the land market (landmarket.ts, docs/multiplayer-land.md M7): the panel's market block, the For sale layer and the market box */
  readonly market: LandMarketView;
  private box = document.createElement('div');
  /** a proposed pact's strip: tiles each side of the shared edge */
  private stripD = 2;

  constructor(private d: Deps) {
    this.view = new MapView(d.mount);
    this.panel.id = 'mapPanel';
    this.panel.className = 'hidden';
    d.mount.appendChild(this.panel);
    this.panel.addEventListener('click', (e) => this.onPanelClick(e));
    this.panel.addEventListener('change', (e) => this.onPanelChange(e));
    this.panel.addEventListener('input', (e) => { const t = e.target as HTMLInputElement; if (t.id === 'mpRate') this.panel.querySelector('#mpRateV')!.textContent = `${t.value}%`; });
    d.net.tap((m) => this.onMsg(m));
    this.market = new LandMarketView(d.world);
    this.box.id = 'mapMarket';
    this.box.className = 'hidden';
    d.mount.appendChild(this.box);
    this.box.addEventListener('click', (e) => this.onMarketClick(e, this.box));
  }

  private onMsg(m: ServerMsg) {
    if (m.t === 'welcome') { this.view.reset(m.seed); this.sel = []; this.splitFor = 0; }
    else if (m.t === 'mapSector') this.view.applySector(m.sx, m.sy, m.v, m.c, m.l ?? 0);
    else if (m.t === 'lines') this.view.setBusLines(m.lines);
    else if (m.t === 'railLines') this.view.setRailLines(m.lines);
    else if (m.t === 'metroLines') this.view.setMetroLines(m.lines);
    else if (m.t === 'deals') { const { t: _t, ...v } = m; this.market.deals = v; this.panelSig = ''; this.refresh(); }
  }
  /** parcels or players changed (main.ts): taken in by the next frame, at most every PARCELS_MS (a parcels message comes with most ticks) */
  parcelsChanged() { this.parcelsStale = true; }
  private parcelsStale = true;
  private parcelsAt = 0;
  private takeParcels() {
    this.parcelsStale = false;
    const w = this.d.world;
    this.view.setParcels(w.parcels.values(), w.players);
    this.sel = this.sel.filter((id) => w.parcels.has(id));
    if (this.splitFor && !w.parcels.has(this.splitFor)) this.splitFor = 0;
    this.refresh();
  }

  // ---- on and off ----------------------------------------------------------------------------------
  /** `camera` false: the caller moves the camera itself (the tour's flight) */
  set(on: boolean, camera = true) {
    if (on === this.on) return;
    const r = this.d.rig;
    this.on = on;
    this.tourCam = on && !camera;
    r.mapMode = on; r.overZoom = 0; r.underZoom = 0;
    document.body.classList.toggle('map-on', on);
    document.getElementById('mapBtn')?.classList.toggle('on', on);
    this.view.setVisible(on);
    if (on) {
      this.saved = { pitch: r.pitch, yaw: r.yaw };
      const yaw = Math.round(r.yaw / (Math.PI * 2)) * Math.PI * 2; // north up, the shortest way round
      if (camera) this.ease = { t: 0, from: { pitch: r.pitch, yaw: r.yaw, dist: r.dist }, to: { pitch: MAP_PITCH, yaw, dist: Math.max(r.dist, 320) } };
      this.takeParcels();
    } else {
      this.splitFor = 0; this.cut = null; this.press = null;
      if (camera) this.ease = { t: 0, from: { pitch: r.pitch, yaw: r.yaw, dist: r.dist }, to: { pitch: this.saved.pitch, yaw: this.saved.yaw, dist: Math.min(r.dist, DIST_MAX - 20) } };
      r.camera.near = 0.5; r.camera.far = 2000; r.camera.updateProjectionMatrix();
      this.d.status('');
    }
    this.panel.classList.toggle('hidden', !on || !this.sel.length);
    this.box.classList.toggle('hidden', !on);
    this.d.onToggle(on);
    this.refresh();
  }
  toggle() { this.set(!this.on); }

  /** Before the rig places the camera: the easing in or out of the map, and the map's own limits. */
  frameCamera(dt: number) {
    const r = this.d.rig;
    if (!Number.isFinite(r.dist) || r.dist <= 0) r.dist = 320;
    if (this.ease) {
      const e = this.ease;
      e.t = Math.min(1, e.t + Math.max(0, dt) / EASE_S);
      const k = e.t * e.t * (3 - 2 * e.t);
      r.pitch = e.from.pitch + (e.to.pitch - e.from.pitch) * k;
      r.yaw = e.from.yaw + (e.to.yaw - e.from.yaw) * k;
      r.dist = Math.exp(Math.log(e.from.dist) + (Math.log(e.to.dist) - Math.log(e.from.dist)) * k);
      if (e.t >= 1) this.ease = null;
    } else if (this.on && !this.tourCam) r.pitch = MAP_PITCH;
    if (this.on) r.dist = Math.min(MAP_DIST_MAX, Math.max(MAP_DIST_MIN * 0.8, r.dist));
    if (this.on) { r.camera.near = Math.max(0.5, r.dist * 0.05); r.camera.far = r.dist * 3; r.camera.updateProjectionMatrix(); }
  }

  /** The map's frame: sectors to ask for, cells to build, overlays and labels. */
  frame(now: number) {
    const r = this.d.rig, c = this.d.canvas, vh = c.clientHeight, vw = c.clientWidth;
    if (this.parcelsStale && now - this.parcelsAt > PARCELS_MS) { this.parcelsAt = now; this.takeParcels(); }
    const wpp = r.worldPerPixel(vh);
    const v = this.view.view(r.camera, r.target.x, r.target.z, r.dist);
    const sx0 = Math.floor(v.x0 / SECTOR_TILES), sx1 = Math.floor(v.x1 / SECTOR_TILES), sy0 = Math.floor(v.z0 / SECTOR_TILES), sy1 = Math.floor(v.z1 / SECTOR_TILES);
    if (![sx0, sx1, sy0, sy1].every(Number.isFinite)) return;
    const lvl = this.view.levelFor(wpp);
    const sig = `${sx0},${sx1},${sy0},${sy1},${lvl}`;
    if ((sig !== this.lastView || now - this.lastAsk > 500) && this.d.net.connected) {
      this.lastView = sig; this.lastAsk = now;
      // a wide view asks again less often: its sectors are smaller than a few pixels
      // at the level of detail the view draws: far out a byte per 16×16 tiles is all a pixel can show
      const s = this.view.request(sx0, sy0, sx1, sy1, lvl, now, REFRESH_MS * Math.max(1, ((sx1 - sx0 + 1) * (sy1 - sy0 + 1)) / 40));
      if (s.length) this.d.net.send({ t: 'map', s, ...(lvl ? { l: lvl } : {}) });
    }
    this.view.frame(r.camera, r.target.x, r.target.z, r.dist, wpp, vw, vh);
  }

  // ---- pointer (input.ts MapInput) -------------------------------------------------------------------
  active() { return this.on; }
  private ground(px: number, py: number): [number, number] | null {
    const c = this.d.canvas;
    const hit = this.d.rig.groundAt(px, py, c.clientWidth, c.clientHeight, this.tmp);
    return hit ? [hit.x, hit.z] : null;
  }
  down(px: number, py: number, shift: boolean) {
    const g = this.ground(px, py);
    const p = this.splitFor ? this.d.world.parcels.get(this.splitFor) : undefined;
    // a cut starts on the parcel being split; anywhere else a press pans or clicks
    const onIt = !!g && !!p && g[0] >= p.x - 1 && g[0] <= p.x + p.w + 1 && g[1] >= p.y - 1 && g[1] <= p.y + p.h + 1;
    this.press = { px, py, moved: false, shift, cut: onIt ? g : null };
    if (onIt) this.cut = { a: g!, b: g! };
  }
  move(px: number, py: number, dx: number, dy: number) {
    const pr = this.press;
    if (!pr) return;
    if (!pr.moved && Math.hypot(px - pr.px, py - pr.py) >= 5) { pr.moved = true; if (!pr.cut) this.d.canvas.style.cursor = 'grabbing'; } // as a select-tool drag in 3D (input.ts CLICK_SLOP)
    if (pr.cut) {
      const g = this.ground(px, py);
      if (g && this.cut) { this.cut.b = g; this.preview(); }
      return;
    }
    if (pr.moved) this.d.rig.panPixels(dx, dy, this.d.canvas.clientHeight);
  }
  up(px: number, py: number) {
    const pr = this.press;
    this.press = null;
    if (!pr) return;
    if (pr.moved && !pr.cut) this.d.canvas.style.cursor = '';
    if (pr.cut) {
      const plan = this.splitPlan();
      this.cut = null;
      if (plan && pr.moved) {
        if (plan.plan.ok) { this.d.net.send({ t: 'parcelOp', op: 'split', id: plan.p.id, axis: plan.axis, at: plan.at }); this.splitFor = 0; }
        else this.d.toast('error', plan.plan.reason);
      }
      this.refresh();
      return;
    }
    if (pr.moved) return;
    const g = this.ground(px, py);
    const p = g ? this.parcelAt(Math.floor(g[0]), Math.floor(g[1])) : undefined;
    if (!p) { if (!pr.shift) { this.sel = []; this.splitFor = 0; } }
    else if (pr.shift) this.sel = this.sel.includes(p.id) ? this.sel.filter((i) => i !== p.id) : [...this.sel, p.id];
    else { this.sel = [p.id]; this.splitFor = 0; }
    this.refresh();
  }
  hover(px: number, py: number) {
    if (this.press || this.cut) return;
    const g = this.ground(px, py);
    if (!g) { this.d.status(''); return; }
    const x = Math.floor(g[0]), y = Math.floor(g[1]);
    const p = this.parcelAt(x, y), w = this.d.world;
    const what = CLASS_NAMES[mapClassOf(this.view.byteAt(x, y))] ?? '';
    let s = `(${x}, ${y}) · ${what} · ${p ? `${p.name} (${w.players.get(p.owner)?.name ?? p.owner}), ${p.w}×${p.h}${p.group !== undefined ? ', estate' : ''}` : 'unclaimed land'}`;
    const note = p ? this.market.hoverNote(p) : '';
    if (note) s += ` · ${note}`;
    if (this.splitFor) s += ' · drag across the parcel to cut it in two (Esc cancels)';
    else if (this.sel.length) s += ' · shift-click to add or remove parcels';
    this.d.status(s);
  }
  /** The parcel at a tile, from the parcel list (the map has no chunks loaded). */
  private parcelAt(x: number, y: number): ParcelDTO | undefined {
    for (const p of this.d.world.parcels.values()) if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) return p;
    return undefined;
  }

  /** Esc on the map: cancel a cut, else drop the selection, else leave the map. */
  escape() {
    if (this.splitFor) { this.splitFor = 0; this.cut = null; }
    else if (this.sel.length) this.sel = [];
    else { this.set(false); return; }
    this.refresh();
  }

  // ---- previews -------------------------------------------------------------------------------------
  private splitPlan() {
    const p = this.d.world.parcels.get(this.splitFor), c = this.cut;
    if (!p || !c) return null;
    const dx = c.b[0] - c.a[0], dy = c.b[1] - c.a[1];
    const axis: 'x' | 'y' = Math.abs(dx) >= Math.abs(dy) ? 'y' : 'x'; // a mostly level drag cuts along a row
    const at = Math.round(axis === 'y' ? (c.a[1] + c.b[1]) / 2 : (c.a[0] + c.b[0]) / 2);
    return { p, axis, at, plan: planSplit(p, axis, at, { isWater: (x, y) => this.view.isWater(x, y) }) };
  }
  private combinePlan() {
    const w = this.d.world;
    return planCombine(this.sel, (id) => w.parcels.get(id), w.parcels.values(), (o) => w.mayEdit(o));
  }
  private preview() {
    const marks: MapMark[] = [];
    let status = '';
    const sp = this.splitFor ? this.splitPlan() : null;
    if (sp && this.cut) {
      const { p, plan, axis, at } = sp;
      if (plan.ok) {
        marks.push({ rects: [plan.keep], fill: 0x4aa3ff, fillA: 0.35, line: 0x62d2a2, px: 2.5 }, { rects: [plan.part], fill: 0xf9a03f, fillA: 0.35, line: 0x62d2a2, px: 2.5 });
        const a = plan.keep, b = plan.part;
        status = `Split ${p.name} along ${axis} = ${at}: ${a.w}×${a.h} keeps it, ${b.w}×${b.h} becomes ${p.name} (${plan.side}) · release to split`;
      } else {
        marks.push({ rects: [p], fill: 0xff3b30, fillA: 0.3, line: 0xff3b30, px: 2.5 });
        status = plan.reason;
      }
    } else if (this.sel.length >= 2) {
      const plan = this.combinePlan(), w = this.d.world;
      if (plan.ok) {
        const shapes = [...plan.rect.values()];
        marks.push({ rects: shapes, fill: 0x62d2a2, fillA: 0.22, line: 0x62d2a2, px: 2.5 });
        status = `Combine: ${plan.merges.length ? `${plan.merges.length} merge${plan.merges.length > 1 ? 's' : ''} into one parcel` : 'no rectangles to merge'}${plan.estate.length ? `, an estate of ${plan.estate.length} parcels` : ', one parcel'} · press Combine`;
      } else {
        marks.push({ rects: this.sel.map((id) => w.parcels.get(id)!).filter(Boolean), fill: 0xff3b30, fillA: 0.25, line: 0xff3b30, px: 2.5 });
        status = plan.reason;
      }
    }
    this.view.setSelection(this.sel, [...this.market.marks(), ...marks]);
    if (status || this.saidStatus) this.d.status(status);
    this.saidStatus = !!status;
    return status;
  }

  // ---- the panel ------------------------------------------------------------------------------------
  /** Redraw the selection, previews and panel. */
  refresh() {
    if (!this.on) return;
    const status = this.preview();
    const w = this.d.world;
    const sel = this.sel.map((id) => w.parcels.get(id)).filter((p): p is ParcelDTO => !!p);
    this.box.innerHTML = this.market.boxHtml();
    this.panel.classList.toggle('hidden', !sel.length);
    if (!sel.length) { this.panelSig = ''; return; }
    const focused = this.panel.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT';
    const sig = `${sel.map((p) => p.id).join(',')}|${this.splitFor}`;
    if (focused && sig === this.panelSig) { this.fillStats(sel); return; } // typing a name: leave the inputs alone
    this.panelSig = sig;
    // the market's forms (landmarket.ts) survive a redraw of the same selection: open sections and what was typed
    const keep = sig === this.panelSig || sig === this.keptSig ? [...this.panel.querySelectorAll<HTMLInputElement | HTMLDetailsElement>('details[id^=mk], input[id^=mk], select[id^=mk]')]
      .map((e) => [e.id, e instanceof HTMLDetailsElement ? e.open : (e as HTMLInputElement).type === 'checkbox' ? (e as HTMLInputElement).checked : e.value] as const) : [];
    this.keptSig = sig;
    this.panel.innerHTML = sel.length === 1 ? this.oneHtml(sel[0]) : this.manyHtml(sel, status);
    for (const [id, v] of keep) {
      const e = this.panel.querySelector<HTMLElement>(`#${id}`);
      if (e instanceof HTMLDetailsElement) e.open = v as boolean;
      else if (e instanceof HTMLInputElement && e.type === 'checkbox') e.checked = v as boolean;
      else if (e instanceof HTMLInputElement || e instanceof HTMLSelectElement) e.value = String(v);
    }
    this.fillStats(sel);
  }
  private estate(p: ParcelDTO) { return p.group === undefined ? [p] : [...this.d.world.parcels.values()].filter((q) => q.group === p.group); }
  private totals(list: ParcelDTO[]): Totals {
    const t = { area: 0, buildings: 0, population: 0, employed: 0, jobs: 0, roads: 0, value: 0, tax: 0, sites: 0, edu: eduTotals(list) };
    for (const p of list) {
      const s = p.stats;
      t.area += p.w * p.h; t.buildings += s.buildings ?? 0; t.population += s.population; t.employed += s.employed; t.jobs += s.jobs;
      t.roads += s.roads; t.value += s.value ?? 0; t.tax += s.taxYesterday; t.sites += s.sites;
    }
    return t;
  }
  private statRows = [
    ['area', 'Area', (t: Totals) => `${t.area.toLocaleString('en-GB')} tiles`],
    ['buildings', 'Buildings', (t: Totals) => t.buildings.toLocaleString('en-GB')],
    ['sites', 'Building sites', (t: Totals) => String(t.sites)],
    ['population', 'Population', (t: Totals) => t.population.toLocaleString('en-GB')],
    ['jobs', 'Jobs filled', (t: Totals) => `${t.employed.toLocaleString('en-GB')} / ${t.jobs.toLocaleString('en-GB')}`],
    ['roads', 'Road tiles', (t: Totals) => String(t.roads)],
    ['eduIndex', 'Education index', (t: Totals) => (t.edu.n ? `${t.edu.index} · ${eduIndexLabel(t.edu.index)}` : '–')],
    ['grads', 'Graduates', (t: Totals) => t.edu.grads.toLocaleString('en-GB')],
    ['pupils', 'Pupils / places', (t: Totals) => `${t.edu.pupils.toLocaleString('en-GB')} / ${t.edu.places.toLocaleString('en-GB')}`],
    ['value', 'Book value', (t: Totals) => money(t.value)],
    ['tax', 'Tax yesterday', (t: Totals) => money(t.tax)],
  ] as const;
  private fillStats(sel: ParcelDTO[]) {
    const est = sel.length === 1 ? this.estate(sel[0]) : sel;
    const a = this.totals(sel), b = this.totals(est);
    for (const [k, , f] of this.statRows) {
      const ea = this.panel.querySelector(`[data-s="${k}"]`), eb = this.panel.querySelector(`[data-e="${k}"]`);
      if (ea) ea.textContent = f(a);
      if (eb) eb.textContent = f(b);
    }
  }
  private table(estate: boolean) {
    return `<table class="mstats">${estate ? '<tr><th></th><th>parcel</th><th>estate</th></tr>' : ''}
      ${this.statRows.map(([k, label]) => `<tr${k === 'value' ? ' title="What the land, roads and buildings cost to make (land, zoning, building work, civic prices); not a market price"' : k === 'eduIndex' ? ' title="Residents aged 25-64: 20 x their mean level (none 0 to postgraduate 5), so 0-100"' : ''}><td>${label}</td><td data-s="${k}"></td>${estate ? `<td data-e="${k}"></td>` : ''}</tr>`).join('')}</table>`;
  }
  private oneHtml(p: ParcelDTO) {
    const w = this.d.world, owner = w.players.get(p.owner), mine = w.mayEdit(p.owner);
    const est = this.estate(p), inEstate = est.length > 1;
    const colour = p.color ?? owner?.color ?? 0xffffff;
    const swatches = [-1, ...PARCEL_COLOURS].map((c) => {
      const cc = c < 0 ? owner?.color ?? 0xffffff : c, on = c < 0 ? p.color === undefined : p.color === c;
      return `<button class="msw${on ? ' on' : ''}" data-act="colour" data-c="${c}" style="background:${hex(cc)}" title="${c < 0 ? 'the owner\'s colour' : 'this colour'}"></button>`;
    }).join('');
    return `<h2><span class="sw" style="background:${hex(colour)}"></span><span>${esc(p.name)}</span></h2>
      <div class="sub">${esc(owner?.name ?? p.owner)} · ${p.w}×${p.h} at (${p.x}, ${p.y})${inEstate ? ` · estate of ${est.length} parcels` : ''}</div>
      ${this.table(inEstate)}
      ${this.market.parcelHtml(p)}
      ${mine ? `
        <label>Name${inEstate ? ' (the whole estate)' : ''}<input type="text" id="mpName" maxlength="24" value="${esc(p.name)}"></label>
        <label>Colour</label><div class="mswatches">${swatches}</div>
        <label>Tax rate <b id="mpRateV">${Math.round(p.taxRate * 100)}%</b></label>
        <input type="range" id="mpRate" min="0" max="${MAX_TAX * 100}" step="1" value="${Math.round(p.taxRate * 100)}">
        <div class="mbtns">
          <button class="chip${this.splitFor === p.id ? ' on' : ''}" data-act="split" title="Drag a straight cut across the parcel; each part keeps some dry land and no building may straddle the cut">${this.splitFor === p.id ? 'Cancel split' : 'Split…'}</button>
          ${inEstate ? '<button class="chip" data-act="ungroup" title="Take this parcel out of its estate">Leave estate</button>' : ''}
          <button class="chip" data-act="view" title="Back to the 3D view, over this parcel">View in 3D</button>
        </div>
        <div class="hint">${this.splitFor === p.id ? 'Drag across the parcel: a mostly level drag cuts along a row, a mostly upright one along a column.' : 'Shift-click your other parcels next to this one to combine them: parcels that make a rectangle (up to 48 a side) merge, the rest become one estate sharing name, colour and tax rate.'}</div>`
    : `<div class="mbtns"><button class="chip" data-act="view">View in 3D</button></div>`}`;
  }
  private manyHtml(sel: ParcelDTO[], status: string) {
    const plan = this.combinePlan();
    return `<h2>${sel.length} parcels</h2>
      <div class="sub">${sel.map((p) => esc(p.name)).join(' · ')}</div>
      ${this.table(false)}
      <div class="mplan ${plan.ok ? 'ok' : 'bad'}">${esc(status || (plan.ok ? '' : plan.reason))}</div>
      <div class="mbtns"><button class="chip" data-act="combine" ${plan.ok ? '' : 'disabled'}>Combine</button><button class="chip" data-act="clear">Clear</button></div>
      ${this.market.pactHtml(sel, this.stripD)}`;
  }
  /** fly back to 3D over a point (main.ts sets the target) */
  onView: (x: number, y: number) => void = () => {};
  /** A land-market button (landmarket.ts) in the panel or the market box. Returns whether it was one. */
  private onMarketClick(e: MouseEvent, root: HTMLElement): boolean {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mk]');
    if (!b) return false;
    if (b.dataset.mk === 'layer') this.market.layer = !this.market.layer;
    else if (b.dataset.mk === 'go') {
      const p = this.d.world.parcels.get(Number(b.dataset.id));
      if (p) { this.sel = [p.id]; this.splitFor = 0; this.d.rig.target.set(p.x + p.w / 2, 0, p.y + p.h / 2); }
    } else {
      const m = this.market.act(b, root);
      if (m) this.d.net.send(m);
    }
    this.panelSig = '';
    this.refresh();
    return true;
  }
  private onPanelClick(e: MouseEvent) {
    if (this.onMarketClick(e, this.panel)) return;
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    const p = this.d.world.parcels.get(this.sel[0]);
    switch (b.dataset.act) {
      case 'combine': this.d.net.send({ t: 'parcelOp', op: 'combine', ids: this.sel }); this.sel = [Math.min(...this.sel)]; break;
      case 'clear': this.sel = []; break;
      case 'split': this.splitFor = this.splitFor ? 0 : this.sel[0]; break;
      case 'ungroup': if (p) this.d.net.send({ t: 'parcelOp', op: 'ungroup', id: p.id }); break;
      case 'colour': if (p) this.d.net.send({ t: 'parcel', id: p.id, color: Number(b.dataset.c) }); break;
      case 'view': if (p) { this.set(false); this.onView(p.x + p.w / 2, p.y + p.h / 2); } return;
    }
    this.panelSig = '';
    this.refresh();
  }
  private onPanelChange(e: Event) {
    const t = e.target as HTMLInputElement, p = this.d.world.parcels.get(this.sel[0]);
    if (!p) return;
    if (t.id === 'mpName' && t.value.trim()) this.d.net.send({ t: 'parcel', id: p.id, name: t.value.trim() });
    if (t.id === 'mpRate') this.d.net.send({ t: 'parcel', id: p.id, taxRate: Number(t.value) / 100 });
    if (t.id === 'mkStrip') { this.stripD = Math.max(1, Math.min(8, Number(t.value) || 2)); this.panelSig = ''; this.refresh(); return; }
    if (t.id.startsWith('mk')) return; // the market's form fields are read when its button is pressed
    t.blur();
  }
}

