import { isJunctionTool } from './junctiontools';
import type { ColumnPick } from './pick';
import { MAX_PARCEL_EDGE, MANIFEST, KIND_TOOLS, KIND_ID, isMultiTile, trackDragPath, roadDragPath, snapRoadEnd, type KindToolId, type RoadShape } from '@msimcity/shared';
import type { CameraRig } from './camera';
import { Vector3 } from 'three';
import { pinchFactor, readScrollMode, writeScrollMode, scrollZoom, wheelPixels, type ScrollMode } from './gestures';

/** how far a press may travel before it is a drag (a pan) rather than a click */
const CLICK_SLOP = 5;
/** tools that drag a path or a line over the ground: they pick the ground tile, never a building's column (pick.ts) */
const GROUND_TOOLS = new Set<string>(['road', 'rail', 'pylons', 'cable', 'runway', 'streetrule', 'floodwall']);
/** Safari's trackpad pinch/rotate (GestureEvent is not in lib.dom) */
interface GestureLike extends UIEvent { scale: number; rotation: number; clientX: number; clientY: number }

export type ToolId = 'select' | 'buy' | 'road' | 'bulldoze' | 'runway' | 'rail' | 'roundabout' | 'flyover' | 'miniroundabout' | 'interchange' | 'turnrule' | 'pelican' | 'streetrule' | 'pylons' | 'cable' | 'floodwall' | KindToolId;
/** `?dev` in the URL shows draft kinds (catalogue `draft: true`) in the tool bar and on their keys. */
export const DEV_TOOLS = typeof location !== 'undefined' && new URLSearchParams(location.search).has('dev');
/** Kinds whose tool shows: every catalogue kind with a tool, drafts only with ?dev. */
export const TOOL_KINDS = MANIFEST.filter((k) => k.tool && (!k.draft || DEV_TOOLS));
/** Shortcut keys: the fixed tools plus one per catalogue kind with a tool (buildings/*.ts). */
export const TOOL_KEYS: Record<string, ToolId> = {
  '1': 'select', '2': 'buy', '3': 'road', 'x': 'bulldoze', 'u': 'runway',
  ...Object.fromEntries(TOOL_KINDS.map((k) => [k.tool!.key.toLowerCase(), k.tool!.id as KindToolId])),
};
/**
 * Kinds with a platform under their door (docs/underground.md section 2). The kiosk is 1×1 but turns with Z/C like a
 * structure, because the platform runs along the street it faces (`rot & 1`); the hall is 2×1. The platform itself
 * (planPlatform, the server's `rot` handling for the kiosk) belongs to shared/src/metro.ts and net.ts.
 */
const PLATFORM_KINDS = new Set<number>([KIND_ID['metro-entrance'], KIND_ID['metro-station']]);
/** The kind a tool places when its footprint follows the cursor and it is placed by a click, not a drag (multi-tile, or a station with a platform), or 0. */
export function structureTool(tool: string): number {
  const k = (KIND_TOOLS as Record<string, number>)[tool];
  return k !== undefined && (isMultiTile(k) || PLATFORM_KINDS.has(k)) ? k : 0;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface InputCallbacks {
  onBuild(tool: ToolId, tiles: [number, number][]): void;
  onBuy(r: Rect): void;
  onSelect(x: number, y: number, px: number, py: number): void;
  onHover(tile: [number, number] | null): void;
  onToolChange(tool: ToolId): void;
  /** Z (dir +1, anticlockwise) or C (dir -1, clockwise) while a multi-tile tool is active; the handler works out where the turn starts from */
  onRotate(tool: ToolId, dir: 1 | -1): void;
  /** a right-click: the button went down and up without a drag (a drag pans); px/py are canvas pixels, cx/cy client pixels */
  onContext?(px: number, py: number, cx: number, cy: number): void;
  /** keys that are not tools or camera (e.g. overlays, panels) */
  onKey(code: string): void;
  /** a road drag let go (input.ts roadPath): the tiles in order and the shape; the handler asks about buildings in the way and sends it */
  onRoad?(tiles: [number, number][], shape: RoadShape): void;
  /** Ctrl/Cmd+Z with the road tool: take back the last road drag */
  onUndoRoad?(): void;
  /**
   * the Street rules tool (R5) let go: a click (`street` true: the handler takes the whole street through the tile, along
   * `ns`, the axis nearer the cursor's way across the tile) or a straight drag of tiles (part of a street)
   */
  onStreetRule?(tiles: [number, number][], street: boolean, ns: boolean): void;
  /** Ctrl/Cmd+Z with the Street rules tool: take back the last street rule */
  onUndoStreetRule?(): void;
  /** whether a tile is road, for snapping a road drag's end (unloaded tiles are not) */
  isRoad?(x: number, y: number): boolean;
  /** a shortcut key of a size ladder (client/src/picker.ts): the size to select instead (the last one used), or undefined */
  ladderKey?(tool: ToolId): ToolId | undefined;
  /** whether a tile is water (a road drag does not snap across it); unloaded tiles count as dry */
  isWater?(x: number, y: number): boolean;
  /** the world map (mapmode.ts): while it is up it takes the left button, the wheel zooms about the cursor, and the view does not turn */
  map?: MapInput;
}
/** What the world map does with the pointer (canvas pixels): a left press, drag and release (a click or a pan or a split cut), and hover. */
export interface MapInput {
  active(): boolean;
  down(px: number, py: number, shift: boolean): void;
  move(px: number, py: number, dx: number, dy: number): void;
  up(px: number, py: number): void;
  hover(px: number, py: number): void;
}

/** Mouse/keyboard handling: camera control, painting tools and land selection. */
export class Input {
  tool: ToolId = 'select';
  hover: [number, number] | null = null;
  buyRect: Rect | null = null;
  /** the runway being dragged: a straight line of tiles from where the drag started, along its longer axis */
  runwayLine: [number, number][] | null = null;
  private runwayStart: [number, number] | null = null;
  /** railway track being dragged (shared/src/rail.ts trackDragPath): along the longer axis from the start, then the other, so a drag can turn one corner */
  railPath: [number, number][] | null = null;
  private railStart: [number, number] | null = null;
  private keys = new Set<string>();
  /** orientation chosen with Z/C per multi-tile tool (0-3, FRONT order in shared/src/structures.ts); a tool absent here places with automatic facing */
  private rotations = new Map<string, number>();
  private panning = false;
  /** where the right button went down, until the pointer has travelled far enough for it to be a pan rather than a click */
  private rightDown: { x: number; y: number; moved: boolean } | null = null;
  /** a left press with the select tool: a click selects (on release), a drag grabs the map and pans it */
  private selectDown: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  private orbiting = false;
  private pivot = new Vector3();
  painting = false;
  /**
   * The road being dragged (shared/src/roadtool.ts roadDragPath): straight, or one corner the way the drag first went;
   * holding Shift during the drag makes it a loop round the rectangle. Nothing is sent until the button comes up; Esc
   * lets go of it. The end snaps onto a road one tile beyond it.
   */
  roadPath: [number, number][] | null = null;
  roadShape: RoadShape = 'line';
  /** the Street rules tool's drag (R5): a straight line from where it started, along its longer axis; one tile is a click */
  streetPath: [number, number][] | null = null;
  private streetStart: [number, number] | null = null;
  /** which half of the tile the press was in, for a click's axis (ns: nearer the tile's east or west edge than its north or south) */
  streetNs = false;
  private roadStart: [number, number] | null = null;
  private roadEnd: [number, number] | null = null;
  /** the axis the road drag first left its start along (undefined until it moves, and again when it comes back) */
  private roadFirstX: boolean | undefined;
  private painted = new Set<string>();
  private lastPaint: [number, number] | null = null;
  private buyStart: [number, number] | null = null;
  private tmp = new Vector3();
  /** wheel, trackpad and zoom-key input is gathered here and eased into the rig a frame at a time in update() */
  private pend = { panX: 0, panY: 0, yaw: 0, pitch: 0, zoom: 0 };
  private zoomAt: { x: number; y: number } | null = null;
  private gPivot = new Vector3();
  private gPivotAt = -1e9;
  /** what plain scroll does (gestures.ts): zoom, the standard, or pan for trackpad users who prefer it */
  private scroll: ScrollMode = readScrollMode();
  /** a Safari gesture in progress: the last scale/rotation seen, and whether the rotation has passed its dead zone */
  private gest: { scale: number; rot: number; armed: boolean } | null = null;

  constructor(private canvas: HTMLCanvasElement, private rig: CameraRig, private cb: InputCallbacks) {
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.up);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) canvas.addEventListener(t, this.gesture as EventListener, { passive: false });
    const sel = document.getElementById('scrollMode') as HTMLSelectElement | null;
    if (sel) {
      sel.value = this.scroll;
      sel.addEventListener('change', () => {
        this.scroll = sel.value === 'pan' ? 'pan' : 'zoom';
        writeScrollMode(this.scroll);
        sel.blur(); // a focused select swallows the camera keys
      });
    }
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // middle button: stop browser autoscroll / paste so it can drive the orbit
    canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('auxclick', (e) => e.preventDefault());
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.key === 'Shift' && this.roadStart) { this.roadShape = 'line'; this.layRoad(); this.cb.onHover(this.hover); } // a loop goes back to a line
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** The orientation the player chose for a multi-tile tool, or undefined while it still faces the road automatically. */
  rotationOf(tool: string): number | undefined { return this.rotations.get(tool); }
  setRotation(tool: string, r: number) { this.rotations.set(tool, r & 3); }

  /** a read-only showcase (main.ts, from the welcome): only the select tool, whatever the keys or panels ask for */
  readOnly = false;
  setTool(t: ToolId) {
    if (this.readOnly && t !== 'select') t = 'select';
    if (this.tool === t) return;
    this.tool = t;
    this.buyStart = null; this.buyRect = null; this.painting = false;
    this.runwayStart = null; this.runwayLine = null;
    this.railStart = null; this.railPath = null;
    this.roadStart = null; this.roadPath = null;
    this.streetStart = null; this.streetPath = null;
    this.cb.onToolChange(t);
  }

  /**
   * Is the point (canvas pixels) over tile `t` nearer its north or south edge than its east or west one? At a crossroads
   * that picks the north-south street (the arm the cursor is towards); a tile on one street only ignores it.
   */
  private nsAt(px: number, py: number, t: [number, number]): boolean {
    const hit = this.rig.groundAt(px, py, this.canvas.clientWidth, this.canvas.clientHeight, this.tmp);
    if (!hit) return false;
    const fx = hit.x - t[0] - 0.5, fy = hit.z - t[1] - 0.5;
    return Math.abs(fy) > Math.abs(fx);
  }
  /** the building columns a click can land on (main.ts hands them in from the drawn heights; pick.ts) */
  column: ColumnPick | null = null;
  /**
   * The tile under a canvas point: the tile of the building the cursor is over (its drawn column, roof included), else
   * the ground it comes down to. `ground` skips the columns for the tools that lay out a path or a line over the
   * ground, where a drag across a building must keep reading ground tiles rather than hop to a roof.
   */
  tileAt(px: number, py: number, ground = false): [number, number] | null {
    return this.rig.tileAt(px, py, this.canvas.clientWidth, this.canvas.clientHeight, ground ? null : this.column);
  }
  /** whether the active tool reads the ground tile under the cursor, not the building's: the drags that lay out roads, tracks, runways and street rules */
  private get groundTool() { return GROUND_TOOLS.has(this.tool); }

  /** Continuous keyboard camera movement; call once per frame. */
  update(dt: number) {
    const k = this.keys;
    const speed = this.rig.dist * 1.1 * dt;
    if (k.has('KeyW') || k.has('ArrowUp')) this.rig.target.addScaledVector(this.rig.forward(), speed);
    if (k.has('KeyS') || k.has('ArrowDown')) this.rig.target.addScaledVector(this.rig.forward(), -speed);
    if (k.has('KeyA') || k.has('ArrowLeft')) this.rig.target.addScaledVector(this.rig.right(), -speed);
    if (k.has('KeyD') || k.has('ArrowRight')) this.rig.target.addScaledVector(this.rig.right(), speed);
    if (!this.onMap) { // the map stays north-up: no turning or tilting
      if (k.has('KeyQ')) this.rig.rotate(1.6 * dt);
      if (k.has('KeyE')) this.rig.rotate(-1.6 * dt);
      if (k.has('KeyR')) this.rig.rotate(0, 1.2 * dt);
      if (k.has('KeyF')) this.rig.rotate(0, -1.2 * dt);
    }
    // + / - (and Page Up / Down) zoom about the view centre
    const zin = k.has('Equal') || k.has('NumpadAdd') || k.has('PageUp'), zout = k.has('Minus') || k.has('NumpadSubtract') || k.has('PageDown');
    if (zin !== zout) { this.zoomAt = null; this.pend.zoom += (zin ? -1.4 : 1.4) * dt; }
    this.drain(dt);
  }

  /** Ease the gathered trackpad motion into the camera: a short time constant, so it follows the fingers without the steps of coarse events. */
  private drain(dt: number) {
    const p = this.pend;
    if (!(p.panX || p.panY || p.yaw || p.pitch || p.zoom)) return;
    // dt can be 0 or negative on the first frame (main.ts takes `last` from performance.now()): a negative step would
    // make f negative and the pending motion grow without bound, so clamp it
    if (!Number.isFinite(p.zoom) || !Number.isFinite(p.panX) || !Number.isFinite(p.panY)) { p.zoom = p.panX = p.panY = p.yaw = p.pitch = 0; return; }
    const f = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.25)) * 30);
    const take = (v: number) => (Math.abs(v) < 1e-4 ? v : v * f);
    const h = this.canvas.clientHeight;
    const px = take(p.panX), py = take(p.panY);
    if (px || py) { this.rig.panPixels(px, py, h); p.panX -= px; p.panY -= py; }
    const yaw = take(p.yaw), pitch = take(p.pitch);
    if (yaw || pitch) { this.rig.orbitAround(this.gPivot, yaw, pitch); p.yaw -= yaw; p.pitch -= pitch; }
    const z = take(p.zoom);
    if (z) {
      if (this.zoomAt) this.rig.zoomAt(Math.exp(z), this.zoomAt.x, this.zoomAt.y, this.canvas.clientWidth, h);
      else this.rig.zoom(Math.exp(z));
      p.zoom -= z;
    }
    if (Math.abs(p.panX) < 0.01) p.panX = 0;
    if (Math.abs(p.panY) < 0.01) p.panY = 0;
    if (Math.abs(p.yaw) < 1e-5) p.yaw = 0;
    if (Math.abs(p.pitch) < 1e-5) p.pitch = 0;
    // zoom is not zeroed here: take() hands over the last sliver whole, so a notch adds up to exactly its zoom
  }

  /** a left press on the world map, until it is released */
  private mapDrag = false;
  private get onMap() { return !!this.cb.map?.active(); }

  private down = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    if (this.onMap && e.button === 0) { this.mapDrag = true; this.cb.map!.down(e.offsetX, e.offsetY, e.shiftKey); return; }
    if (this.onMap && e.button === 1) return; // the map stays north-up
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // orbit around the ground point under the cursor; fall back to the view centre over the sky
      const hit = this.rig.groundAt(e.offsetX, e.offsetY, this.canvas.clientWidth, this.canvas.clientHeight, this.pivot);
      if (!hit) this.pivot.copy(this.rig.target);
      this.orbiting = true; this.canvas.style.cursor = 'grabbing'; return;
    }
    if (e.button === 2) { this.panning = true; this.rightDown = { x: e.clientX, y: e.clientY, moved: false }; return; }
    if (e.button === 0 && e.shiftKey) { this.panning = true; return; }
    if (e.button !== 0) return;
    const tile = this.tileAt(e.offsetX, e.offsetY, this.groundTool);
    if (!tile) return;
    if (this.tool === 'select') { this.selectDown = { x: e.clientX, y: e.clientY, px: e.offsetX, py: e.offsetY, moved: false }; return; }
    if (this.tool === 'buy') { this.buyStart = tile; this.buyRect = { x: tile[0], y: tile[1], w: 1, h: 1 }; return; }
    if (this.tool === 'runway') { this.runwayStart = tile; this.runwayLine = [tile]; return; }
    // track and trunk links (docs/utilities.md 4.2) drag the same way: along the longer axis, then one corner
    if (this.tool === 'rail' || this.tool === 'pylons' || this.tool === 'cable' || this.tool === 'floodwall') { this.railStart = tile; this.railPath = [tile]; return; }
    if (this.tool === 'road') { this.roadStart = tile; this.roadEnd = tile; this.roadFirstX = undefined; this.roadShape = 'line'; this.roadPath = [tile]; return; }
    if (this.tool === 'streetrule') { this.streetStart = tile; this.streetPath = [tile]; this.streetNs = this.nsAt(e.offsetX, e.offsetY, tile); return; } // Shift at the press pans, as with any tool; held during the drag it makes a loop
    this.painting = true; this.painted.clear(); this.lastPaint = null;
    this.paint(tile);
  };

  private move = (e: PointerEvent) => {
    if (this.mapDrag) { this.cb.map!.move(e.offsetX, e.offsetY, e.movementX, e.movementY); return; }
    if (this.onMap && !this.panning) { this.cb.map!.hover(e.offsetX, e.offsetY); return; }
    if (this.orbiting) { this.rig.orbitAround(this.pivot, -e.movementX * 0.006, e.movementY * 0.005); return; }
    const sd = this.selectDown;
    if (sd) {
      if (!sd.moved && Math.hypot(e.clientX - sd.x, e.clientY - sd.y) >= CLICK_SLOP) { sd.moved = true; this.canvas.style.cursor = 'grabbing'; }
      if (sd.moved) { this.rig.panPixels(e.movementX, e.movementY, this.canvas.clientHeight); return; }
    }
    if (this.panning) {
      const rd = this.rightDown;
      if (rd && !rd.moved) { // a right press that has not yet travelled a few pixels may still be a click
        if (Math.hypot(e.clientX - rd.x, e.clientY - rd.y) < CLICK_SLOP) return;
        rd.moved = true;
      }
      this.rig.panPixels(e.movementX, e.movementY, this.canvas.clientHeight);
      return;
    }
    const tile = this.tileAt(e.offsetX, e.offsetY, this.groundTool);
    if (tile && this.runwayStart) {
      // before the hover callback, so the status line judges the line as it now stands
      const [sx, sy] = this.runwayStart;
      const alongX = Math.abs(tile[0] - sx) >= Math.abs(tile[1] - sy);
      const n = Math.min(64, Math.abs(alongX ? tile[0] - sx : tile[1] - sy)), d = Math.sign(alongX ? tile[0] - sx : tile[1] - sy);
      this.runwayLine = Array.from({ length: n + 1 }, (_, i): [number, number] => (alongX ? [sx + d * i, sy] : [sx, sy + d * i]));
    }
    if (tile && this.railStart) this.railPath = trackDragPath(this.railStart, tile);
    if (tile && this.streetStart) {
      const [sx, sy] = this.streetStart, alongX = Math.abs(tile[0] - sx) >= Math.abs(tile[1] - sy);
      const n = Math.min(160, Math.abs(alongX ? tile[0] - sx : tile[1] - sy)), d = Math.sign(alongX ? tile[0] - sx : tile[1] - sy);
      this.streetPath = Array.from({ length: n + 1 }, (_, i): [number, number] => (alongX ? [sx + d * i, sy] : [sx, sy + d * i]));
    }
    if (tile && !this.streetStart && this.tool === 'streetrule') this.streetNs = this.nsAt(e.offsetX, e.offsetY, tile);
    if (tile && this.roadStart) { this.roadEnd = tile; this.roadShape = e.shiftKey ? 'loop' : 'line'; this.layRoad(); }
    if (!tile !== !this.hover || (tile && this.hover && (tile[0] !== this.hover[0] || tile[1] !== this.hover[1]))) {
      this.hover = tile;
      this.cb.onHover(tile);
    }
    if (!tile) return;
    if (this.painting && !structureTool(this.tool) && !isJunctionTool(this.tool)) this.paint(tile); // junction tools: one click, one junction (or one sign)
    if (this.buyStart) {
      const [sx, sy] = this.buyStart;
      let x0 = Math.min(sx, tile[0]), y0 = Math.min(sy, tile[1]);
      let x1 = Math.max(sx, tile[0]), y1 = Math.max(sy, tile[1]);
      if (x1 - x0 >= MAX_PARCEL_EDGE) { if (tile[0] > sx) x1 = x0 + MAX_PARCEL_EDGE - 1; else x0 = x1 - MAX_PARCEL_EDGE + 1; }
      if (y1 - y0 >= MAX_PARCEL_EDGE) { if (tile[1] > sy) y1 = y0 + MAX_PARCEL_EDGE - 1; else y0 = y1 - MAX_PARCEL_EDGE + 1; }
      this.buyRect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
  };

  private up = (e: PointerEvent) => {
    if (this.mapDrag) { this.mapDrag = false; this.cb.map!.up(e.offsetX, e.offsetY); return; }
    const sd = this.selectDown;
    this.selectDown = null;
    if (sd) {
      if (sd.moved) this.canvas.style.cursor = '';
      else if (e.type === 'pointerup') { const tile = this.tileAt(sd.px, sd.py); if (tile) this.cb.onSelect(tile[0], tile[1], sd.px, sd.py); }
    }
    if (this.rightDown && !this.rightDown.moved && e.type === 'pointerup' && e.button === 2) this.cb.onContext?.(e.offsetX, e.offsetY, e.clientX, e.clientY);
    this.rightDown = null;
    if (this.buyStart && this.buyRect) this.cb.onBuy(this.buyRect);
    if (this.runwayStart && this.runwayLine) this.cb.onBuild('runway', this.runwayLine);
    if (this.railStart && this.railPath) this.cb.onBuild(this.tool === 'pylons' || this.tool === 'cable' || this.tool === 'floodwall' ? this.tool : 'rail', this.railPath);
    this.railStart = null; this.railPath = null;
    if (this.streetStart && this.streetPath && e.type === 'pointerup') {
      const p = this.streetPath, ns = p.length > 1 ? p[0][0] === p[1][0] : this.streetNs;
      this.cb.onStreetRule?.(p, p.length === 1, ns);
    }
    const hadStreet = !!this.streetStart;
    this.streetStart = null; this.streetPath = null;
    if (hadStreet) this.cb.onHover(this.hover);
    const road = this.roadStart && this.roadPath && e.type === 'pointerup' ? this.roadPath : null;
    const hadRoad = !!this.roadStart;
    this.roadStart = null; this.roadPath = null; this.roadEnd = null;
    if (road) this.cb.onRoad?.(road, this.roadShape);
    this.buyStart = null; this.buyRect = null;
    this.runwayStart = null; this.runwayLine = null;
    this.painting = false; this.panning = false;
    if (hadRoad) this.cb.onHover(this.hover); // the status line drops the drag's cost
    if (this.orbiting) { this.orbiting = false; this.canvas.style.cursor = ''; }
  };

  /**
   * Scroll, the same for every device (gestures.ts): zooms about the cursor (or pans, if the player set scroll to pan);
   * Shift+scroll pans; Alt/Option+scroll rotates (sideways) and tilts (up and down); a pinch (ctrl+wheel) zooms about
   * the cursor. All of it is eased in over a few frames. Cmd+scroll is left to the browser.
   */
  private wheel = (e: WheelEvent) => {
    if (e.metaKey) return;
    e.preventDefault(); // no page scroll, no page zoom
    const dx = wheelPixels(e.deltaX, e.deltaMode), dy = wheelPixels(e.deltaY, e.deltaMode);
    if (e.ctrlKey) {
      this.pend.zoom += Math.log(pinchFactor(e.deltaY, e.deltaMode));
      this.zoomAt = { x: e.offsetX, y: e.offsetY };
      return;
    }
    if (e.altKey && !this.onMap) { // the map stays north-up: Alt+scroll does what plain scroll does
      this.setPivot(e.offsetX, e.offsetY, e.timeStamp);
      this.pend.yaw += dx * 0.006;
      this.pend.pitch -= dy * 0.005;
      return;
    }
    if (e.shiftKey || this.scroll === 'pan') { this.pend.panX -= dx; this.pend.panY -= dy; return; }
    this.pend.zoom += scrollZoom(dy);
    this.zoomAt = { x: e.offsetX, y: e.offsetY };
  };

  /** the ground point a trackpad orbit turns about: under the cursor where the burst began, kept while it goes on */
  private setPivot(x: number, y: number, now: number) {
    if (now - this.gPivotAt > 300) {
      if (!this.rig.groundAt(x, y, this.canvas.clientWidth, this.canvas.clientHeight, this.gPivot)) this.gPivot.copy(this.rig.target);
    }
    this.gPivotAt = now;
  }

  /** Safari only: trackpad pinch zooms about the cursor; a twist orbits once it passes a dead zone (a pinch always wobbles a little) */
  private gesture = (ev: Event) => {
    const e = ev as GestureLike;
    e.preventDefault(); // otherwise Safari zooms the page
    if (e.type === 'gesturestart') {
      const r = this.canvas.getBoundingClientRect();
      this.gest = { scale: 1, rot: 0, armed: false };
      this.zoomAt = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!this.rig.groundAt(this.zoomAt.x, this.zoomAt.y, this.canvas.clientWidth, this.canvas.clientHeight, this.gPivot)) this.gPivot.copy(this.rig.target);
      this.gPivotAt = performance.now();
      return;
    }
    const g = this.gest;
    if (!g || e.type === 'gestureend') { this.gest = null; return; }
    if (e.scale > 0 && g.scale > 0) this.pend.zoom += Math.log(g.scale / e.scale);
    g.scale = e.scale;
    if (!g.armed && Math.abs(e.rotation) > 8) { g.armed = true; g.rot = e.rotation; }
    if (g.armed && !this.onMap) {
      this.gPivotAt = performance.now(); // pivot is fixed for the gesture
      this.pend.yaw += (e.rotation - g.rot) * Math.PI / 180; // Safari's rotation is clockwise-positive; clockwise turns the view that way
      g.rot = e.rotation;
    }
  };

  private keydown = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return; // typing
    this.keys.add(e.code);
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z' && (this.tool === 'road' || this.tool === 'streetrule') && !this.onMap) {
      // Ctrl+Z (Cmd+Z on a Mac) with the road tool: take back the last road drag (the browser's own undo has nothing
      // here); with the Street rules tool, the last street rule
      e.preventDefault();
      if (!e.repeat) { if (this.tool === 'road') this.cb.onUndoRoad?.(); else this.cb.onUndoStreetRule?.(); }
      return;
    }
    if (e.key === 'Shift' && this.roadStart) { this.roadShape = 'loop'; this.layRoad(); this.cb.onHover(this.hover); }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Tab') e.preventDefault(); // the world map's key, not the browser's focus
    if (this.onMap) { this.cb.onKey(e.code); return; } // tools wait for the 3D view
    const key = e.key.toLowerCase();
    if ((key === 'z' || key === 'c') && structureTool(this.tool)) {
      // turn the footprint a quarter: Z anticlockwise, C clockwise (1×1 tools ignore both)
      if (!e.repeat) this.cb.onRotate(this.tool, key === 'z' ? 1 : -1);
      return;
    }
    if (e.code === 'Escape' && this.streetStart) {
      // Esc mid-drag lets go of the street rule drag and keeps the tool
      this.streetStart = null; this.streetPath = null;
      this.cb.onHover(this.hover);
      return;
    }
    if (e.code === 'Escape' && this.roadStart) {
      // Esc mid-drag lets go of the road and keeps the tool; a second Esc goes back to select as ever
      this.roadStart = null; this.roadPath = null; this.roadEnd = null;
      this.cb.onHover(this.hover);
      return;
    }
    const tool = TOOL_KEYS[key];
    if (tool && !this.readOnly) this.setTool(this.cb.ladderKey?.(tool) ?? tool);
    if (e.code === 'Escape') this.setTool('select');
    this.cb.onKey(e.code);
  };

  /** Paint a tile, filling the straight line from the previous paint so fast drags leave no gaps. */
  private paint(tile: [number, number]) {
    const line: [number, number][] = [];
    if (this.lastPaint) {
      let [x0, y0] = this.lastPaint;
      const [x1, y1] = tile;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 512; guard++) {
        line.push([x0, y0]);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    } else line.push(tile);
    this.lastPaint = tile;
    const tiles: [number, number][] = [];
    const push = (t: [number, number]) => {
      const k = `${t[0]},${t[1]}`;
      if (this.painted.has(k)) return;
      this.painted.add(k); tiles.push(t);
    };
    for (const t of line) push(t);
    if (tiles.length) this.cb.onBuild(this.tool, tiles);
  }

  /** The road drag's tiles from its start to the cursor, in its shape, the end snapped onto a road one tile beyond. */
  private layRoad() {
    const a = this.roadStart, b = this.roadEnd;
    if (!a || !b) return;
    // the first axis is the way the drag first left the start (along the longer one when it went diagonally)
    if (b[0] === a[0] && b[1] === a[1]) this.roadFirstX = undefined;
    else if (this.roadFirstX === undefined) this.roadFirstX = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    const path = roadDragPath(a, b, this.roadShape, this.roadFirstX);
    const road = this.cb.isRoad, wet = this.cb.isWater;
    this.roadPath = road && this.roadShape === 'line' ? snapRoadEnd(path, road, (x, y) => !wet?.(x, y)) : path;
  }
}
