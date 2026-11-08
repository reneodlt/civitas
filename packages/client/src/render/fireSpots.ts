import { model } from './models';

/**
 * Where a design's windows are, for the fires (render/fires.ts): flames and smoke pour out of them, the panes glow with
 * the fire inside and go black afterwards, soot smears the wall above them. Read once per design from the geometry the
 * kit built, in the design's own frame: a facade box (shared buildings/facade.ts) carries one quad per storey × bay cell
 * with its mode in `aFac.z` and its bay and storey in `aCell`, so a window cell is a quad; a legacy windowed box draws one
 * window in each cell of a grid seven across a tile and five up it (render/materials.ts WINDOWS), so its spots are the
 * centres of the grid cells that lie wholly inside each wall. Walls only (no roofs or floors), and only the window
 * classes (not beacons, camp fires or signs).
 */
export interface Spot {
  x: number; y: number; z: number;
  /** the wall's outward normal (horizontal) */
  nx: number; nz: number;
  /** the cell's width along the wall and its height */
  w: number; h: number;
}
const MAX_SPOTS = 40;
/** facade cell modes that are glass (shared facade.ts CELL): window, a glazed balcony door, a shopfront, a bay pane */
const GLASS = new Set([2, 3, 4, 6]);
const cache = new Map<string, Spot[]>();

export function windowSpots(key: string): Spot[] {
  let s = cache.get(key);
  if (!s) { s = extract(key); cache.set(key, s); }
  return s;
}

interface Rect { minA: number; maxA: number; minY: number; maxY: number; off: number; axisX: boolean; sgn: number; mode: number }

function extract(key: string): Spot[] {
  const d = model(key);
  if (!d) return [];
  const g = d.geometry;
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal'), win = g.getAttribute('aWin'), fac = g.getAttribute('aFac'), cel = g.getAttribute('aCell');
  if (!pos || !nrm || !win) return [];
  const cells = new Map<string, Rect>(), walls = new Map<string, Rect>();
  const grow = (map: Map<string, Rect>, k: string, i: number, axisX: boolean, sgn: number, mode: number) => {
    let r = map.get(k);
    if (!r) { r = { minA: Infinity, maxA: -Infinity, minY: Infinity, maxY: -Infinity, off: 0, axisX, sgn, mode }; map.set(k, r); }
    for (let v = i; v < i + 3; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v), a = axisX ? z : x;
      r.minA = Math.min(r.minA, a); r.maxA = Math.max(r.maxA, a); r.minY = Math.min(r.minY, y); r.maxY = Math.max(r.maxY, y);
      r.off = axisX ? x : z;
    }
  };
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const cls = win.getX(i);
    if (cls < 0.5 || cls > 6.5) continue;
    if (Math.abs(nrm.getY(i)) > 0.3) continue;
    const nx = nrm.getX(i), nz = nrm.getZ(i), axisX = Math.abs(nx) > Math.abs(nz), sgn = axisX ? Math.sign(nx) : Math.sign(nz);
    const mode = fac ? Math.round(fac.getZ(i)) : 0;
    if (mode >= 2) grow(cells, `${fac!.getW(i)}:${cel!.getX(i)}:${cel!.getY(i)}:${axisX ? 1 : 0}${sgn}`, i, axisX, sgn, mode);
    else if (mode === 0) grow(walls, `${axisX ? 1 : 0}${sgn}:${Math.round((axisX ? pos.getX(i) : pos.getZ(i)) * 500)}`, i, axisX, sgn, 0);
  }
  const out: Spot[] = [];
  const spot = (r: Rect, a: number, y: number, w: number, h: number) => out.push({
    x: r.axisX ? r.off : a, y, z: r.axisX ? a : r.off, nx: r.axisX ? r.sgn : 0, nz: r.axisX ? 0 : r.sgn, w, h,
  });
  for (const r of cells.values()) if (GLASS.has(r.mode)) spot(r, (r.minA + r.maxA) / 2, (r.minY + r.maxY) / 2, r.maxA - r.minA, r.maxY - r.minY);
  for (const r of walls.values()) {
    if (r.maxA - r.minA < 1 / 7 || r.maxY - r.minY < 1 / 5) continue;
    const a0 = Math.ceil(r.minA * 7 - 1e-4), a1 = Math.floor(r.maxA * 7 + 1e-4), y0 = Math.ceil(r.minY * 5 - 1e-4), y1 = Math.floor(r.maxY * 5 + 1e-4);
    for (let j = y0; j < y1; j++) for (let k = a0; k < a1; k++) spot(r, (k + 0.5) / 7, (j + 0.5) / 5, 1 / 7, 1 / 5);
  }
  if (out.length <= MAX_SPOTS) return out;
  // too many: keep an even spread of them (the thinned list still covers every wall and storey)
  const step = out.length / MAX_SPOTS, kept: Spot[] = [];
  for (let i = 0; i < MAX_SPOTS; i++) kept.push(out[Math.floor(i * step)]);
  return kept;
}
