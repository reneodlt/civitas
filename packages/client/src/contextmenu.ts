import {
  BULLDOZE_COST, KIND_NAMES, PRIORITY_NAMES, Terrain, isRoad, isRailAux, isAirfieldAux, kindIdOf, levelOf, priorityOf, stopModeOf,
  terrainOf, underConstruction, zoneOf, STREET_NAME_MAX, STREET_RULE_DEFS, StreetRule, streetRuleTiles, streetRuleCost, streetAxisAt, busLaneOk, hasFeature, techFor, type CitizenInfo, type ServerMsg, type PurchaseCheck, type RoadInfo,
} from '@msimcity/shared';
import type { NetClient } from './net';
import type { ClientWorld } from './world';
import type { VehicleSel } from './vehicles';

/** What a right-click landed on: an agent (person or road vehicle), a train, a plane, a tile, or the first-person view of the selection. */
export type CtxTarget =
  | { k: 'agent'; id: number }
  | { k: 'train'; line: number; train: number }
  | { k: 'plane'; airport: number; flight: number }
  | { k: 'heli'; flight: number }
  | { k: 'boat'; id: number }
  | { k: 'tile'; x: number; y: number }
  | { k: 'cab' };

/** What the menu needs from main.ts: the current selection, and the actions the panels and keys already perform. */
export interface CtxDeps {
  world: ClientWorld;
  net: NetClient;
  selectedCitizen(): number;
  selectedVehicle(): VehicleSel | null;
  following(): boolean;
  fpvMode(): 'off' | 'inset' | 'full';
  selectAgent(id: number): void;
  selectVehicle(v: VehicleSel | null): void;
  /** clear the selected person or vehicle */
  deselect(): void;
  follow(on: boolean): void;
  /** the FPV key's toggles: I (inset) and O (whole window) */
  fpv(mode: 'inset' | 'full'): void;
  /** what a left click on a tile does: open the building's people panel, or just the parcel's panel */
  selectTile(x: number, y: number, panel: 'building' | 'parcel'): void;
  focus(x: number, y: number): void;
  openLines(): void;
  buyVerdict(r: { x: number; y: number; w: number; h: number }): PurchaseCheck;
  /** what buying the rectangle would cost me (main.ts buyCost: the flat price, or the market price less a homestead) */
  buyCost(r: { x: number; y: number; w: number; h: number }): { cost: number };
  /** hide the hover tooltip while the menu is up */
  onOpen(): void;
}

export interface MenuItem {
  /** stable id, so an armed confirmation survives a refresh of the menu */
  key: string;
  label: string;
  /** right-hand text: a cost, a state, or the short reason an entry is greyed out */
  hint?: string;
  /** greyed out, with this as its tooltip */
  disabled?: string;
  /** a second click is needed; the entry then reads `confirm` */
  confirm?: string;
  danger?: boolean;
  on?: boolean;
  run?: () => void;
}
export interface MenuModel { title: string; sub?: string; swatch?: string; groups: MenuItem[][] }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const MARGIN = 8;
/** entries that change the world: left out in a read-only showcase (world.spectate) */
const CHANGES = new Set(['demolish', 'raise', 'lower', 'pause', 'buy', 'rename-h', 'rename-v', 'rule-hgv', 'rule-bus', 'rule-yellow', 'rule-zone20']);

/** The right-click menu: a small list of the actions that exist for whatever was clicked, each greyed out with its reason when it cannot be done. */
export class ContextMenu {
  private el: HTMLDivElement;
  private model: MenuModel | null = null;
  private target: CtxTarget | null = null;
  private pos = { x: 0, y: 0 };
  private armed = '';
  private focus = -1;
  private info: CitizenInfo | null = null;
  /** a road tile's live answer (its streets' names), asked for when the menu opens on one */
  private road: RoadInfo | null = null;
  private flat: MenuItem[] = [];
  private html = '';

  constructor(private d: CtxDeps) {
    this.el = document.createElement('div');
    this.el.id = 'ctxmenu';
    this.el.className = 'hidden';
    this.el.setAttribute('role', 'menu');
    document.getElementById('ui')!.appendChild(this.el);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (b) this.activate(Number(b.dataset.i));
    });
    // outside the menu a left press only closes it (the click does not also select or paint); a right press closes it and goes on to open the next one
    window.addEventListener('pointerdown', (e) => {
      if (this.el.classList.contains('hidden') || this.el.contains(e.target as Node)) return;
      this.hide();
      if (e.button === 0) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    window.addEventListener('keydown', this.keydown, true);
    window.addEventListener('wheel', () => this.hide(), { passive: true });
    window.addEventListener('blur', () => this.hide());
    window.addEventListener('resize', () => this.hide());
    // the first-person inset sits above the canvas, so it gets its own menu for the person or vehicle it shows
    document.addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('#fpv') || t.closest('button')) return;
      e.preventDefault();
      this.open({ k: 'cab' }, e.clientX, e.clientY);
    });
    d.net.tap((m) => this.onMessage(m));
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  open(target: CtxTarget, cx: number, cy: number) {
    this.d.onOpen();
    this.target = target;
    this.pos = { x: cx, y: cy };
    this.armed = '';
    this.focus = -1;
    this.info = null; this.road = null;
    if (target.k === 'agent') this.d.net.send({ t: 'inspectCitizen', id: target.id });
    if (target.k === 'tile') { const t = this.d.world.getTile(target.x, target.y); if (t !== undefined && isRoad(t)) this.d.net.send({ t: 'inspect', x: target.x, y: target.y }); }
    this.model = this.build();
    this.render();
    this.el.classList.remove('hidden');
    this.place();
  }

  hide() {
    if (!this.isOpen) return;
    this.el.classList.add('hidden');
    this.model = null; this.target = null; this.armed = ''; this.info = null; this.road = null; this.html = '';
  }

  private onMessage(m: ServerMsg) {
    const tg = this.target;
    if (this.isOpen && tg?.k === 'tile' && m.t === 'road' && m.x === tg.x && m.y === tg.y && m.info) {
      this.road = m.info;
      this.model = this.build(); this.render(); this.place();
      return;
    }
    if (!this.isOpen || this.target?.k !== 'agent') return;
    if (m.t !== 'citizen' || m.id !== this.target.id) return;
    if (!m.info) { this.hide(); return; } // gone while the menu was up
    this.info = m.info;
    this.model = this.build();
    this.render();
    this.place();
  }

  private keydown = (e: KeyboardEvent) => {
    if (!this.isOpen) return;
    const n = this.flat.length;
    const step = (dir: number) => {
      for (let k = 1; k <= n; k++) {
        const i = (this.focus + dir * k + n * 2) % n;
        if (!this.flat[i].disabled) { this.focus = i; break; }
      }
      this.render();
    };
    if (e.code === 'Escape') { this.hide(); e.stopPropagation(); e.preventDefault(); }
    else if (e.code === 'ArrowDown') { step(1); e.preventDefault(); e.stopPropagation(); }
    else if (e.code === 'ArrowUp') { step(-1); e.preventDefault(); e.stopPropagation(); }
    else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && this.focus >= 0) { this.activate(this.focus); e.preventDefault(); e.stopPropagation(); }
  };

  private activate(i: number) {
    const it = this.flat[i];
    if (!it || it.disabled || !it.run) return;
    if (it.confirm && this.armed !== it.key) { this.armed = it.key; this.focus = i; this.render(); return; }
    this.hide();
    it.run();
  }

  private render() {
    const m = this.model;
    if (!m) return;
    this.flat = m.groups.flat();
    let i = 0;
    const groups = m.groups.map((g) => g.map((it) => {
      const idx = i++, armed = this.armed === it.key && !!it.confirm;
      const cls = ['ci', it.disabled ? 'disabled' : '', it.danger ? 'danger' : '', armed ? 'armed' : '', it.on ? 'on' : '', idx === this.focus ? 'focus' : ''].filter(Boolean).join(' ');
      const tip = it.disabled ?? (armed ? 'click again to do it' : '');
      return `<button class="${cls}" role="menuitem" data-i="${idx}"${tip ? ` title="${esc(tip)}"` : ''}${it.disabled ? ' aria-disabled="true"' : ''}><span class="cl">${esc(armed ? it.confirm! : it.label)}</span>${it.hint ? `<span class="ck">${esc(it.hint)}</span>` : ''}</button>`;
    }).join('')).filter(Boolean).join('<div class="csep"></div>');
    const html = `<div class="ch"><b>${m.swatch ? `<i class="sw" style="background:${m.swatch}"></i>` : ''}${esc(m.title)}</b>${m.sub ? `<span>${esc(m.sub)}</span>` : ''}</div>${groups}`;
    if (html !== this.html) { this.html = html; this.el.innerHTML = html; } // an identical rebuild must not swallow a click in progress
  }

  /** At the cursor, nudged back inside the window (flipped above or left of it when it would run off the far edge). */
  private place() {
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    let x = this.pos.x + 2, y = this.pos.y + 2;
    if (x + w > innerWidth - MARGIN) x = this.pos.x - w - 2;
    if (y + h > innerHeight - MARGIN) y = this.pos.y - h - 2;
    x = Math.max(MARGIN, Math.min(x, innerWidth - w - MARGIN));
    y = Math.max(MARGIN, Math.min(y, innerHeight - h - MARGIN));
    this.el.style.left = `${x}px`; this.el.style.top = `${y}px`;
  }

  // ---- what each target offers ---------------------------------------------------------------

  /** The menu for the target; in a read-only showcase without the entries that change something (they would only be refused). */
  private build(): MenuModel {
    const m = this.model0();
    if (this.d.world.spectate) m.groups = m.groups.map((g) => g.filter((it) => !CHANGES.has(it.key))).filter((g) => g.length);
    return m;
  }
  private model0(): MenuModel {
    const t = this.target!;
    switch (t.k) {
      case 'agent': return this.agentModel(t.id);
      case 'train': return this.vehicleModel({ kind: 'train', line: t.line, train: t.train });
      case 'plane': return this.vehicleModel({ kind: 'plane', airport: t.airport, flight: t.flight });
      case 'heli': return this.vehicleModel({ kind: 'heli', flight: t.flight });
      case 'boat': return this.vehicleModel({ kind: 'boat', id: t.id });
      case 'cab': return this.cabModel();
      case 'tile': return this.tileModel(t.x, t.y);
    }
  }

  private fpvItems(sel: boolean, pick: () => void): MenuItem[] {
    const mode = sel ? this.d.fpvMode() : 'off';
    // on the selected target these are the I and O keys; on another one the view moves to it and only changes mode if it must
    const go = (want: 'inset' | 'full') => () => { pick(); if (sel || this.d.fpvMode() !== want) this.d.fpv(want); };
    return [
      { key: 'fpv', label: mode === 'inset' ? 'Leave first-person view' : 'First-person view', hint: 'I', on: mode === 'inset', run: go('inset') },
      { key: 'fpvFull', label: mode === 'full' ? 'Back to the inset' : 'First-person, whole window', hint: 'O', on: mode === 'full', run: go('full') },
    ];
  }

  private agentModel(id: number): MenuModel {
    const d = this.d, i = this.info;
    const sel = d.selectedCitizen() === id && !d.selectedVehicle();
    const pick = () => { if (!sel) d.selectAgent(id); };
    const follow = d.following() && sel;
    const items: MenuItem[] = [
      { key: 'inspect', label: sel ? 'Inspecting, route shown' : 'Inspect and show route', on: sel, run: () => d.selectAgent(id), disabled: sel ? 'Already selected' : undefined },
      { key: 'follow', label: follow ? 'Stop following' : 'Follow', on: follow, run: () => { pick(); d.follow(!follow); } },
      ...this.fpvItems(sel, pick),
    ];
    const go: MenuItem[] = [];
    const dest = i?.destination, home = i?.home, job = i?.employer;
    if (!i) go.push({ key: 'loading', label: 'Loading details…', disabled: 'Waiting for the server' });
    else {
      if (home) go.push({ key: 'home', label: 'Go to their home', hint: home.parcel, run: () => d.focus(home.x, home.y) });
      if (job) go.push({ key: 'job', label: `Go to their work`, hint: KIND_NAMES[job.kind], run: () => d.focus(job.x, job.y) });
      if (dest) go.push({ key: 'dest', label: 'Go to where they are heading', hint: dest.label, run: () => d.focus(dest.x, dest.y) });
      if (i.bus) go.push({ key: 'lines', label: 'Bus lines panel', hint: 'lines', run: () => d.openLines() });
    }
    const groups = [items, go.length ? go : []];
    if (sel) groups.push([{ key: 'deselect', label: 'Deselect', run: () => d.deselect() }]);
    return { title: i?.name ?? 'Person or vehicle', sub: i ? `${i.role} · ${i.activity}` : 'loading…', groups };
  }

  private vehicleModel(v: VehicleSel): MenuModel {
    const d = this.d, cur = d.selectedVehicle();
    const sel = !!cur && cur.kind === v.kind && JSON.stringify(cur) === JSON.stringify(v);
    const pick = () => { if (!sel) d.selectVehicle(v); };
    const follow = d.following() && sel;
    return {
      title: v.kind === 'train' ? `Train ${v.train + 1}` : v.kind === 'plane' ? `Flight` : v.kind === 'boat' ? 'Boat' : 'Helicopter',
      sub: v.kind === 'train' ? `line ${v.line}` : v.kind === 'plane' ? `airport ${v.airport}` : v.kind === 'boat' ? 'afloat' : 'helicopter flight',
      groups: [[
        { key: 'inspect', label: sel ? 'Inspecting' : 'Inspect', on: sel, run: () => d.selectVehicle(v), disabled: sel ? 'Already selected' : undefined },
        { key: 'follow', label: follow ? 'Stop following' : 'Follow', on: follow, run: () => { pick(); d.follow(!follow); } },
        ...this.fpvItems(sel, pick).map((it) => ({ ...it, label: it.label.replace('First-person', v.kind === 'boat' ? 'Wheelhouse' : 'Cab').replace('Leave first-person view', v.kind === 'boat' ? 'Leave wheelhouse view' : 'Leave cab view') })),
      ], ...(sel ? [[{ key: 'deselect', label: 'Deselect', run: () => d.deselect() }]] : [])],
    };
  }

  /** the first-person view's own menu: the selection it shows */
  private cabModel(): MenuModel {
    const d = this.d, mode = d.fpvMode(), follow = d.following();
    const veh = d.selectedVehicle(), id = d.selectedCitizen();
    return {
      title: 'First-person view',
      sub: veh ? (veh.kind === 'train' ? 'cab view' : 'flight') : id ? 'person or vehicle' : '',
      groups: [[
        { key: 'inset', label: mode === 'inset' ? 'Leave first-person view' : 'Show as the corner inset', hint: 'I', on: mode === 'inset', run: () => d.fpv('inset') },
        { key: 'full', label: mode === 'full' ? 'Back to the inset' : 'Whole window', hint: mode === 'full' ? 'O, Esc' : 'O', on: mode === 'full', run: () => d.fpv('full') },
        { key: 'follow', label: follow ? 'Stop following' : 'Follow from above', on: follow, run: () => d.follow(!follow) },
      ], [{ key: 'deselect', label: 'Deselect', run: () => d.deselect() }]],
    };
  }

  private tileModel(x: number, y: number): MenuModel {
    const d = this.d, w = d.world;
    const [dx, dy] = w.doorOf(x, y);
    const t = w.getTile(dx, dy);
    const me = w.me, parcel = w.parcelAt(x, y);
    const mine = !!parcel && w.mayEdit(parcel.owner); // sandbox: every parcel is yours to edit
    const yours = !!parcel && parcel.owner === me;
    const ownerName = parcel ? (w.players.get(parcel.owner)?.name ?? parcel.owner) : '';
    const sub = parcel ? `${parcel.name} · ${yours ? 'yours' : ownerName}` : 'unclaimed land';
    const swatch = parcel ? `#${(w.players.get(parcel.owner)?.color ?? 0xffffff).toString(16).padStart(6, '0')}` : undefined;
    if (t === undefined) return { title: 'Not loaded yet', groups: [[{ key: 'focus', label: 'Centre the view here', run: () => d.focus(x, y) }]] };
    const cash = w.myPlayer?.money ?? 0;
    const view: MenuItem = { key: 'focus', label: 'Centre the view here', run: () => d.focus(dx, dy) };

    const demolish = (label: string, cost: number, note?: string): MenuItem => ({
      key: 'demolish', label, danger: true,
      confirm: cost > 0 ? `Confirm: demolish for ${money(cost)}` : 'Confirm: demolish (free)',
      hint: parcel && !mine ? 'not yours' : cost > cash ? `needs ${money(cost)}` : cost > 0 ? `${money(cost)}${note ? `, ${note}` : ''}` : note ?? 'free',
      disabled: parcel && !mine ? `Not your land: ${ownerName} owns it` : cost > cash ? `Needs ${money(cost)}; you have ${money(cash)}` : undefined,
      run: () => d.net.send({ t: 'build', tool: 'bulldoze', tiles: [[dx, dy]] }),
    });
    const parcelItem = (): MenuItem[] => parcel ? [mine
      ? { key: 'parcel', label: 'Parcel settings', hint: 'tax, name', run: () => d.selectTile(x, y, 'parcel') }
      : { key: 'parcel', label: 'View parcel', hint: ownerName, run: () => d.selectTile(x, y, 'parcel') }] : [];

    const aux = w.auxAt(x, y);
    if (isRailAux(aux)) {
      if (isRoad(t)) return { title: 'Level crossing', sub, swatch, groups: [[demolish('Lift the track (the road stays)', 0)], [...parcelItem(), view]] };
      return { title: 'Railway track', sub, swatch, groups: [[demolish('Lift this track tile', 0)], [...parcelItem(), view]] };
    }
    if (isAirfieldAux(aux)) {
      return { title: 'Runway or taxiway', sub, swatch, groups: [[demolish('Lift this paving tile', 0)], [...parcelItem(), view]] };
    }
    if (isRoad(t)) {
      // its streets by name (server/src/streets.ts), each renamable by its owner
      const streets = this.road?.streets ?? [];
      const rename: MenuItem[] = streets.map((st) => ({
        key: `rename-${st.ns ? 'v' : 'h'}`, label: streets.length > 1 ? `Rename ${st.name}` : 'Rename street', hint: st.mine ? st.name : 'not yours',
        disabled: st.mine ? undefined : 'Only the owner of most of a street can rename it',
        run: () => {
          const name = prompt(`A new name for ${st.name} (up to ${STREET_NAME_MAX} letters; leave it empty for the name it had)`, st.name);
          if (name !== null && name.trim() !== st.name) d.net.send({ t: 'renameStreet', x, y, ns: st.ns, name: name.trim() });
        },
      }));
      // R5 street rules (shared/src/roadrules.ts): each on or off along the street through this tile, as the Street rules tool clicks
      const env = { road: (tx: number, ty: number) => { const tt = w.getTile(tx, ty); return tt !== undefined && isRoad(tt); }, aux: (tx: number, ty: number) => w.auxAt(tx, ty), bits: (tx: number, ty: number) => w.ruleAt(tx, ty)?.st ?? 0 };
      const ns = streetAxisAt(env, x, y, !(env.road(x - 1, y) || env.road(x + 1, y)));
      const me = w.myPlayer;
      const rules: MenuItem[] = STREET_RULE_DEFS.map((def) => {
        const tiles = streetRuleTiles(env, x, y, ns, def.id), c = streetRuleCost(env, tiles, def.bit);
        const lock = me && !hasFeature(me.tech, def.feature) && !me.devUnlimited ? techFor(def.feature)?.name ?? 'a technology' : null;
        const noLane = def.bit === StreetRule.BusLane && !tiles.some(([tx, ty]) => busLaneOk(w.auxAt(tx, ty)));
        const why = parcel && !mine ? `Not your street: ${ownerName} owns it` : noLane ? 'One lane each way: a bus lane needs a one-way street or an avenue' : c.on && lock ? `Needs ${lock}` : c.on && c.cost > cash ? `Needs ${money(c.cost)}` : undefined;
        return {
          key: `rule-${def.id}`, label: c.on ? `${def.title} along this street` : `Take the ${def.title.toLowerCase()} off`, on: !c.on,
          hint: why ? (noLane ? 'one lane each way' : lock && c.on ? 'locked' : 'not yours') : c.on ? `${money(c.cost)}, ${money(Math.round(c.upkeep * 100) / 100)}/day` : 'free',
          disabled: why,
          run: () => d.net.send({ t: 'streetRule', rule: def.id, tiles, on: c.on }),
        };
      });
      return { title: streets[0]?.name ?? 'Road', sub: streets[1] ? `${streets[0].name} at ${streets[1].name} · ${sub}` : sub, swatch, groups: [rename, rules, [demolish('Demolish this road tile', levelOf(t) > 0 ? BULLDOZE_COST : 0)], [...parcelItem(), view]] };
    }
    if (zoneOf(t) !== 0) {
      const kind = kindIdOf(zoneOf(t), w.subAt(dx, dy));
      const name = KIND_NAMES[kind] ?? 'building';
      const site = underConstruction(t), lvl = levelOf(t);
      const title = site ? `${name} (under construction)` : lvl === 0 ? `${name} lot (zoned, empty)` : lvl > 1 ? `${name} · level ${lvl}` : name;
      const first: MenuItem[] = [];
      if (lvl > 0 || site) first.push({ key: 'inspect', label: 'Inspect', hint: 'people, details', run: () => d.selectTile(x, y, 'building') });
      if (stopModeOf(kind) === 'bus') first.push({ key: 'lines', label: 'Bus lines', hint: 'lines panel', run: () => d.openLines() });
      const build: MenuItem[] = [];
      if (site) {
        const pr = priorityOf(t);
        const set = (p: number) => () => d.net.send({ t: 'priority', x: dx, y: dy, priority: p });
        const why = mine ? undefined : 'Not your build';
        build.push(
          { key: 'raise', label: 'Build sooner', hint: mine ? PRIORITY_NAMES[pr] : 'not yours', disabled: why ?? (pr >= 2 ? 'Already urgent' : undefined), run: set(pr + 1) },
          { key: 'lower', label: 'Build later', hint: mine ? undefined : 'not yours', disabled: why ?? (pr <= -1 ? 'Already low (or paused)' : undefined), run: set(pr - 1) },
          pr <= -2 ? { key: 'pause', label: 'Resume building', hint: mine ? undefined : 'not yours', disabled: why, run: set(0) } : { key: 'pause', label: 'Pause building', hint: mine ? undefined : 'not yours', disabled: why, run: set(-2) },
        );
      }
      // multi-tile structures are bulldozed by their door, which doorOf already gave; the cost is the same flat fee as any building
      const cost = lvl > 0 ? BULLDOZE_COST : 0;
      return { title, sub, swatch, groups: [first, build, [demolish(site ? 'Cancel and demolish' : lvl === 0 ? 'Clear zoning' : 'Demolish', cost, lvl > 0 ? 'no refund' : undefined)], [...parcelItem(), view]] };
    }
    // bare land
    const water = terrainOf(t) === Terrain.Water;
    const land: MenuItem[] = [];
    if (!parcel) {
      const v = water ? { ok: false as const, reason: 'That is water' } : d.buyVerdict({ x, y, w: 1, h: 1 });
      const price = d.buyCost({ x, y, w: 1, h: 1 }).cost;
      land.push({
        key: 'buy', label: 'Buy this tile', hint: v.ok ? money(price) : 'cannot buy',
        disabled: !v.ok ? v.reason : price > cash ? `Needs ${money(price)}; you have ${money(cash)}` : undefined,
        run: () => d.net.send({ t: 'buy', x, y, w: 1, h: 1, q: price }),
      });
    }
    return { title: water ? 'Water' : parcel ? 'Open land' : 'Unclaimed land', sub, swatch, groups: [land, [...parcelItem(), view]] };
  }
}
