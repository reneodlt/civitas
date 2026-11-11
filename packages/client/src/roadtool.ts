import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import {
  KIND_NAMES, BRIDGE_STYLE_NAMES, hasFeature, techFor, isRoad, spendableMoney, planRoad, parallelGap, describeDemolition, ROAD_DRAG_MAX,
  ROAD_CLASS_DEFS, classDef, isRoadClass, isOneWayAux, auxDir, CDIRS, PUBLIC_ROAD_TUNING,
  type RoadPlan, type RoadEnv, type RoadShape, type RoadTileState,
} from '@msimcity/shared';
import type { ClientWorld } from './world';

/**
 * The road tool's preview (docs/roads.md "The road tool"): while a road is dragged, its tiles as a translucent ghost
 * coloured by what each will be (shared/src/roadtool.ts planRoad, the server's own rules on the loaded chunks), a chip
 * at the end with the running cost and the first reason anything is refused, the spacing guide (faint lines at the
 * depth of the block the new road makes with the nearest road alongside it, and the depth on the chip), and the
 * question asked on release when buildings are in the way.
 */
const COLOUR: Record<RoadTileState, number> = {
  new: 0x6fb3ff, have: 0xffffff, upgrade: 0x62d2a2, bridge: 0x5fb4ff, demolish: 0xffb020, refused: 0xff3b30,
};
/** new road on unclaimed land (the public premium) */
const UNCLAIMED = 0xb79cff;
const GUIDE = 0xfff1b8;
const money = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the player answered when asked about the buildings in a drag's way. */
export type DemolishAnswer = 'demolish' | 'round' | 'cancel';

const CLASS_STORE = 'msimcity.roadClass';
/** An arrow lying flat, pointing along +x, for a one-way tile of the ghost (half a tile long). */
function arrowGeometry(): BufferGeometry {
  const pts = [
    // shaft
    -0.22, 0, -0.045, 0.06, 0, -0.045, 0.06, 0, 0.045, -0.22, 0, -0.045, 0.06, 0, 0.045, -0.22, 0, 0.045,
    // head
    0.06, 0, -0.13, 0.25, 0, 0, 0.06, 0, 0.13,
  ];
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pts, 3));
}

export class RoadTool {
  readonly group = new Group();
  private quads: InstancedMesh;
  /** the spacing guide: thin strips on the ground where the next roads would make the same block */
  private guide: Mesh;
  private chip: HTMLDivElement;
  private dialog: HTMLDivElement;
  private memo: { key: string; at: number; v: RoadPlan } | null = null;
  private end = new Vector3();
  private tmp = new Vector3();
  /** the depth of the block the drag makes with the road alongside it, for the chip */
  private depth = 0;
  /** one-way tiles of the ghost: an arrow the way the traffic will go */
  private arrows: InstancedMesh;
  /**
   * The class the road tool lays (shared/src/roadclass.ts), picked from the class picker hung off the tool (ui.ts) and
   * remembered between sessions; a class the player has not unlocked lays a street.
   */
  private cls = 0;

  constructor(private world: ClientWorld, private dev: boolean) {
    // drawn over everything (no depth test), so a building in the way shows its amber tile through the model
    this.quads = new InstancedMesh(new PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2), new MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false, depthTest: false }), ROAD_DRAG_MAX * 2);
    this.quads.count = 0;
    this.quads.frustumCulled = false;
    this.quads.renderOrder = 18;
    this.quads.setColorAt(0, new Color(0xffffff));
    this.guide = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: GUIDE, transparent: true, opacity: 0.45, depthWrite: false, side: DoubleSide }));
    this.guide.frustumCulled = false;
    this.guide.renderOrder = 19;
    this.arrows = new InstancedMesh(arrowGeometry(), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false, side: DoubleSide }), ROAD_DRAG_MAX * 2);
    this.arrows.count = 0;
    this.arrows.frustumCulled = false;
    this.arrows.renderOrder = 20;
    this.group.add(this.quads, this.guide, this.arrows);
    try { const c = Number(localStorage.getItem(CLASS_STORE)); if (isRoadClass(c)) this.cls = c; } catch { /* storage blocked: a street */ }
    this.chip = document.createElement('div');
    this.chip.id = 'roadChip';
    this.chip.style.display = 'none';
    this.dialog = document.createElement('div');
    this.dialog.id = 'roadAsk';
    this.dialog.className = 'hidden';
    this.dialog.setAttribute('role', 'dialog');
    document.body.append(this.chip, this.dialog);
  }

  /** The class a drag lays now: the one picked, or a street while it is locked. */
  get roadClass(): number { return this.locked(this.cls) ? 0 : this.cls; }
  /** The class picked (even if locked), for the picker. */
  get picked(): number { return this.cls; }
  pick(cls: number) {
    if (!isRoadClass(cls)) return;
    this.cls = cls;
    this.memo = null;
    try { localStorage.setItem(CLASS_STORE, String(cls)); } catch { /* not remembered */ }
  }
  /** The technology a class still needs for this player, or null (a dev client skips locks, as the server does for it). */
  lockOf(cls: number): string | null {
    const f = classDef(cls).feature, me = this.world.myPlayer;
    if (!f || this.dev || !me) return null;
    return hasFeature(me.tech, f) ? null : techFor(f)?.name ?? 'a technology';
  }
  private locked(cls: number) { return this.lockOf(cls) !== null; }

  /** The rules the server lays a drag by, on the loaded chunks, for the player at this client. */
  private env(): RoadEnv {
    const w = this.world, me = w.myPlayer;
    const pub = this.dev || (!!me && hasFeature(me.tech, 'publicRoads'));
    const bridges = this.dev || (!!me && hasFeature(me.tech, 'bridges'));
    return {
      tile: (x, y) => w.getTile(x, y),
      aux: (x, y) => w.auxAt(x, y),
      kindId: (x, y) => w.kindIdAt(x, y),
      land: (x, y) => { const p = w.parcelAt(x, y); return p ? (w.mayEdit(p.owner) ? null : 'Not your land') : pub ? null : `${techFor('publicRoads')?.name ?? 'Public works'} is needed to lay roads outside your own land`; },
      claimed: (x, y) => !!w.parcelAt(x, y),
      structure: (x, y) => { const s = w.structureAt(x, y); return s ? KIND_NAMES[s.kind] : undefined; },
      bridgeLock: bridges ? null : techFor('bridges')?.name ?? 'Civil engineering',
    };
  }

  /** The plan for a drag as it would be laid with a yes to any demolition (so the ghost shows what is in the way), cached briefly. */
  plan(path: [number, number][], demolish = true): RoadPlan {
    const me = this.world.myPlayer;
    const cls = this.roadClass;
    const key = `${path.length}|${path[0]}|${path[path.length - 1]}|${path[Math.floor(path.length / 2)]}|${demolish}|${cls}`, now = performance.now();
    if (this.memo && this.memo.key === key && now - this.memo.at < 200) return this.memo.v;
    const v = planRoad(path, this.env(), { cls, demolish, budget: me ? spendableMoney(me.money, me.devUnlimited) : 0 });
    this.memo = { key, at: now, v };
    return v;
  }

  /**
   * The spacing guide for a drag: the block one of its straight stretches makes with the nearest road alongside it,
   * the stretch being drawn now first, else the one before the corner; null when no road is alongside either.
   */
  gap(path: [number, number][]) {
    const w = this.world;
    const mine = new Set(path.map(([x, y]) => `${x},${y}`));
    const isRoadAt = (x: number, y: number) => { if (mine.has(`${x},${y}`)) return false; const t = w.getTile(x, y); return t !== undefined && isRoad(t); };
    // the straight stretches, last first
    const legs: [number, number][][] = [];
    let end = path.length - 1;
    while (end > 0) {
      const sx = path[end][0] - path[end - 1][0], sy = path[end][1] - path[end - 1][1];
      let i = end - 1;
      while (i > 0 && path[i][0] - path[i - 1][0] === sx && path[i][1] - path[i - 1][1] === sy) i--;
      legs.push(path.slice(i, end + 1));
      end = i;
    }
    for (const leg of legs.slice(0, 2)) { const g = parallelGap(leg, isRoadAt); if (g) return { ...g, leg }; }
    return null;
  }

  /** Once per frame: the ghost, guide and chip for the drag in progress (null when there is none). */
  frame(path: [number, number][] | null, camera: PerspectiveCamera, vw: number, vh: number) {
    if (!path) { this.quads.count = 0; this.arrows.count = 0; this.guide.visible = false; this.chip.style.display = 'none'; return; }
    const v = this.plan(path);
    const m = new Matrix4(), c = new Color(), q = new Quaternion(), up = new Vector3(0, 1, 0), at = new Vector3(), one = new Vector3(1, 1, 1);
    // new road in the class's colour (a street's new road as before, lilac on unclaimed land); one-way tiles get an arrow
    const cls = this.roadClass, own = cls ? classDef(cls).colour : COLOUR.new;
    let n = 0, na = 0;
    for (const t of v.tiles) {
      if (n >= ROAD_DRAG_MAX * 2) break;
      m.makeTranslation(t.x + 0.5, t.state === 'have' ? 0.04 : 0.06, t.y + 0.5);
      this.quads.setMatrixAt(n, m);
      const hex = t.state === 'new' ? (t.unclaimed && !cls ? UNCLAIMED : own) : COLOUR[t.state];
      this.quads.setColorAt(n, c.setHex(hex).multiplyScalar(t.state === 'have' ? 0.45 : 1));
      n++;
      if ((t.state === 'new' || t.state === 'upgrade' || t.state === 'demolish') && t.byte && isOneWayAux(t.byte)) {
        const [dx, dy] = CDIRS[auxDir(t.byte)];
        q.setFromAxisAngle(up, Math.atan2(-dy, dx));
        m.compose(at.set(t.x + 0.5, 0.07, t.y + 0.5), q, one);
        this.arrows.setMatrixAt(na++, m);
      }
    }
    this.quads.count = n;
    this.quads.instanceMatrix.needsUpdate = true;
    if (this.quads.instanceColor) this.quads.instanceColor.needsUpdate = true;
    this.arrows.count = na;
    this.arrows.instanceMatrix.needsUpdate = true;
    this.drawGuide(path);
    // the chip at the drag's end
    const [ex, ey] = path[path.length - 1];
    this.end.set(ex + 0.5, 0.1, ey + 0.5);
    this.tmp.copy(this.end).project(camera);
    const show = this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1;
    this.chip.style.display = show ? '' : 'none';
    if (show) {
      this.chip.innerHTML = this.chipHtml(v);
      this.chip.style.transform = `translate(${((this.tmp.x + 1) / 2) * vw + 18}px, ${((1 - this.tmp.y) / 2) * vh - 10}px)`;
    }
  }

  /** Faint lines along the drag's straight stretch at the spacing of the road alongside: where the next road makes the same block. */
  private drawGuide(path: [number, number][]) {
    const g = this.gap(path);
    this.depth = g?.depth ?? 0;
    if (!g) { this.guide.visible = false; return; }
    const { leg, side, offset } = g;
    const alongX = leg[0][1] === leg[leg.length - 1][1];
    const a0 = Math.min(...leg.map((t) => (alongX ? t[0] : t[1]))), a1 = Math.max(...leg.map((t) => (alongX ? t[0] : t[1]))) + 1;
    const across = alongX ? leg[0][1] : leg[0][0];
    const pts: number[] = [];
    // the next road the same distance on the far side, and the one after it (a hint, not a snap): a strip down the
    // middle of where each would run
    const strip = (c: number) => {
      const h = 0.07, u0 = a0 - 1, u1 = a1 + 1, v0 = c - h, v1 = c + h;
      const q = alongX ? [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] : [[v0, u0], [v0, u1], [v1, u1], [v1, u0]];
      for (const k of [0, 1, 2, 0, 2, 3]) pts.push(q[k][0], 0.07, q[k][1]);
    };
    for (const k of [1, 2]) strip(across - side * offset * k + 0.5);
    this.guide.geometry.dispose();
    this.guide.geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pts, 3));
    this.guide.visible = true;
  }

  /** The unclaimed tiles of a drag: public road, whose upkeep its builder pays (server sim/publicroads.ts) and which fades unused. */
  private publicNote(n: number): string {
    const up = Math.round(n * classDef(this.roadClass).upkeep * 100) / 100;
    return `${n} on unclaimed land: public road, you pay its $${up % 1 ? up.toFixed(2) : up}/day upkeep (it fades after ${PUBLIC_ROAD_TUNING.fadeDays} days unused)`;
  }

  private chipHtml(v: RoadPlan): string {
    const parts: string[] = [];
    const laid = v.fresh || v.upgrade, cls = this.roadClass;
    if (cls) parts.push(`<span class="cls" style="color:#${classDef(cls).colour.toString(16).padStart(6, '0')}">${esc(classDef(cls).title)}</span>`);
    parts.push(laid ? `<b>${money(v.cost)}</b> · ${plural(v.fresh, 'tile')}${v.upgrade ? ` · ${v.upgrade} upgraded` : ''}${v.unclaimed ? ` · ${this.publicNote(v.unclaimed)}` : ''}` : v.have && !v.refused ? `${cls ? classDef(cls).name : 'road'} already` : '');
    if (this.depth) parts.push(`<span class="guide">block ${this.depth} deep</span>`);
    let html = parts.filter(Boolean).join(' · ');
    if (v.demolish.n) html += `<div class="ask">${describeDemolition(v.demolish.kinds)} in the way: you'll be asked</div>`;
    if (v.refused) html += `<div class="bad">${plural(v.refused, 'tile')} refused: ${esc(v.reason ?? '')}</div>`;
    return html || 'road already';
  }

  /** Status-line text for the road tool: the drag's cost and refusals, or how to use it. */
  status(path: [number, number][] | null, shape: RoadShape): string {
    const cn = classDef(this.roadClass).name;
    if (!path) return ` · ${cn}: drag to lay it${classDef(this.roadClass).oneWay ? ' (the way the traffic goes)' : ''}, one corner like track, hold Shift while dragging for a loop; drag over a road to upgrade it; Ctrl/Cmd+Z undoes the last drag; 3 again picks the class`;
    const v = this.plan(path);
    let s = v.fresh || v.upgrade ? ` · ${cn} · ${money(v.cost)} · ${plural(v.fresh, 'tile')}${v.upgrade ? ` · ${v.upgrade} upgraded` : ''}${v.unclaimed ? ` · ${this.publicNote(v.unclaimed)}` : ''}` : ` · ${cn} already`;
    for (const b of v.bridges) if (b.plan.ok && b.plan.tiles?.length) s += ` · a ${BRIDGE_STYLE_NAMES[b.plan.style!]} of ${plural(b.plan.tiles.length / 3, 'tile')}, ${money(b.plan.cost!)}`;
    if (v.demolish.n) s += ` · ${describeDemolition(v.demolish.kinds)} in the way`;
    if (v.refused) s += ` · ${plural(v.refused, 'tile')} refused: ${v.reason}`;
    const g = this.gap(path);
    if (g) s += ` · block ${g.depth} deep`;
    return s + (shape === 'loop' ? ' · loop (let go of Shift for a line)' : '') + ' · release to lay it, Esc to cancel';
  }

  /**
   * Ask about the buildings a drag would demolish, with the cost, near the screen point (cx, cy): demolish them and
   * build, build round them, or cancel. One answer covers the whole drag. Enter goes round, Esc cancels.
   */
  ask(v: RoadPlan, cx: number, cy: number): Promise<DemolishAnswer> {
    const d = this.dialog;
    const what = describeDemolition(v.demolish.kinds);
    const withYes = v.cost + v.demolish.cost;
    d.innerHTML = `<h3>Demolish ${esc(what)}?</h3>`
      + `<p>This road runs over ${esc(what)}. Demolishing ${v.demolish.n === 1 ? 'it' : 'them'} and laying the road costs <b>${money(withYes)}</b> in all `
      + `(${money(v.demolish.cost)} of it for the ${plural(v.demolish.n, 'tile')} in the way; nothing is refunded).</p>`
      + `<div class="row"><button data-a="demolish" class="danger">Demolish and build · ${money(withYes)}</button>`
      + `<button data-a="round">Build round ${v.demolish.n === 1 ? 'it' : 'them'} · ${money(v.cost)}</button>`
      + `<button data-a="cancel">Cancel</button></div>`;
    d.classList.remove('hidden');
    const r = d.getBoundingClientRect();
    d.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, cx - r.width / 2))}px`;
    d.style.top = `${Math.max(8, Math.min(innerHeight - r.height - 8, cy + 16))}px`;
    (d.querySelector('[data-a="round"]') as HTMLButtonElement | null)?.focus();
    return new Promise((resolve) => {
      const done = (a: DemolishAnswer) => {
        d.classList.add('hidden');
        d.onclick = null;
        window.removeEventListener('keydown', key, true);
        window.removeEventListener('pointerdown', away, true);
        resolve(a);
      };
      const key = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done('cancel'); }
      };
      // a press anywhere else is a cancel, and does not start another drag
      const away = (e: PointerEvent) => { if (!d.contains(e.target as Node)) { e.stopPropagation(); e.preventDefault(); done('cancel'); } };
      d.onclick = (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]'); if (b) done(b.dataset.a as DemolishAnswer); };
      window.addEventListener('keydown', key, true);
      window.addEventListener('pointerdown', away, true);
    });
  }
  get asking() { return !this.dialog.classList.contains('hidden'); }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
