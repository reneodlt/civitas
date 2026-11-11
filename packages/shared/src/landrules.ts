/**
 * Land purchase rules, shared so the server (authoritative) and the client (buy-rectangle preview)
 * run exactly the same code.
 *
 *  1. Adjacency: after your first parcel, new land must share an edge (not just a corner) with land you own. With
 *     `outposts` (a shared world's market rules, docs/multiplayer-land.md section 3, M2) land anywhere is allowed, but
 *     a purchase that shares no edge with yours (an outpost), and the first, must be at least `outpostMin` a side.
 *  2. No islanding: a purchase may not leave another owner's parcel (the Commons included) walled in by your
 *     land, nor enclose a pocket of unclaimed land larger than MAX_ENCLOSED_UNCLAIMED tiles.
 *
 * "Walled in" means: flood fill (4-neighbour) from the neighbouring tile through every tile you do not own
 * (water included, so a lake is never an enclosure) cannot get outside your holdings' bounding box grown by
 * ENCLOSE_MARGIN tiles. The search is best-first towards the nearest box edge, so open country is cheap.
 */

export interface LandRect { x: number; y: number; w: number; h: number }

export interface LandView {
  /** Owner id of the tile, or null when unclaimed (or unknown, e.g. a chunk the client has not loaded). */
  ownerAt(x: number, y: number): string | null;
  isWater(x: number, y: number): boolean;
  /** Every rectangle the buyer already owns. */
  owned: readonly LandRect[];
  /** Display name for an owner id, for messages. */
  ownerName?(id: string): string;
}

export type PurchaseCheck = { ok: true } | { ok: false; reason: string };
/** How the rules are played: the market rules of a shared world (separate outposts) or the classic ones (absent). */
export interface PurchaseRules { outposts?: boolean; outpostMin?: number }

export const MAX_ENCLOSED_UNCLAIMED = 4;
export const ENCLOSE_MARGIN = 2;
export const ENCLOSE_VISIT_CAP = 20000;

export const MSG_OVERLAP = 'That land overlaps an existing parcel';
export const MSG_ALL_WATER = 'That is all water';
export const MSG_NOT_ADJACENT = 'New land must border land you already own';
export const MSG_ENCLOSE_UNCLAIMED = 'That purchase would enclose unclaimed land';
export const msgOutpostSmall = (n: number, first: boolean) => first
  ? `A first plot must be at least ${n}×${n} tiles`
  : `Land not touching yours (an outpost) must be at least ${n}×${n} tiles`;
export const MSG_TOO_COMPLEX = 'That purchase is too complicated to check; buy a smaller piece';

const OFF = 1 << 24, M = 1 << 26;
const key = (x: number, y: number) => (x + OFF) * M + (y + OFF);
const keyX = (k: number) => Math.floor(k / M) - OFF;
const keyY = (k: number) => (k % M) - OFF;

/** Minimal binary min-heap on (priority, key). */
class Heap {
  private p: number[] = [];
  private k: number[] = [];
  get size() { return this.p.length; }
  push(prio: number, k: number) {
    let i = this.p.length;
    this.p.push(prio); this.k.push(k);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (this.p[up] <= prio) break;
      this.p[i] = this.p[up]; this.k[i] = this.k[up]; i = up;
    }
    this.p[i] = prio; this.k[i] = k;
  }
  pop(): number {
    const top = this.k[0];
    const lp = this.p.pop()!, lk = this.k.pop()!;
    const n = this.p.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.p[c + 1] < this.p[c]) c++;
        if (this.p[c] >= lp) break;
        this.p[i] = this.p[c]; this.k[i] = this.k[c]; i = c;
      }
      this.p[i] = lp; this.k[i] = lk;
    }
    return top;
  }
}

const NB: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function checkPurchase(rect: LandRect, buyerId: string, land: LandView, rules: PurchaseRules = {}): PurchaseCheck {
  const { x, y, w, h } = rect;
  const inRect = (px: number, py: number) => px >= x && px < x + w && py >= y && py < y + h;

  // Basic footprint rules, mirrored here so the client preview can explain them.
  let dry = 0;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (land.ownerAt(xx, yy) !== null) return { ok: false, reason: MSG_OVERLAP };
    if (!land.isWater(xx, yy)) dry++;
  }
  if (dry === 0) return { ok: false, reason: MSG_ALL_WATER };

  // The ring of tiles sharing an edge with the rectangle.
  const ring: [number, number][] = [];
  for (let i = 0; i < w; i++) { ring.push([x + i, y - 1], [x + i, y + h]); }
  for (let j = 0; j < h; j++) { ring.push([x - 1, y + j], [x + w, y + j]); }

  const adjacent = ring.some(([rx, ry]) => land.ownerAt(rx, ry) === buyerId);
  if (rules.outposts) {
    const min = rules.outpostMin ?? 0;
    if (!adjacent && (w < min || h < min)) return { ok: false, reason: msgOutpostSmall(min, land.owned.length === 0) };
  }
  if (land.owned.length === 0) return { ok: true };           // first parcel: anywhere
  if (!rules.outposts && !adjacent) return { ok: false, reason: MSG_NOT_ADJACENT };

  // Bounding box of everything the buyer would own, grown by the margin. With outposts only the holdings joined to the
  // new rectangle (sharing an edge or a corner, through each other) can close a wall round anything, so the box is
  // theirs: a far outpost does not make the search cover the country in between.
  const wall = rules.outposts ? joined(rect, land.owned) : land.owned;
  let x0 = x, y0 = y, x1 = x + w - 1, y1 = y + h - 1;
  for (const r of wall) {
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w - 1 > x1) x1 = r.x + r.w - 1;
    if (r.y + r.h - 1 > y1) y1 = r.y + r.h - 1;
  }
  x0 -= ENCLOSE_MARGIN; y0 -= ENCLOSE_MARGIN; x1 += ENCLOSE_MARGIN; y1 += ENCLOSE_MARGIN;
  const outside = (px: number, py: number) => px < x0 || px > x1 || py < y0 || py > y1;
  const edgeDist = (px: number, py: number) => Math.min(px - x0, x1 - px, py - y0, y1 - py);
  const mine = (px: number, py: number) => inRect(px, py) || land.ownerAt(px, py) === buyerId;
  const nameOf = (id: string) => land.ownerName?.(id) ?? id;

  const resolved = new Set<number>();   // tiles of components already judged (escaped, or enclosed but harmless)
  let visits = 0;

  for (const [sx, sy] of ring) {
    if (mine(sx, sy)) continue;
    const sk = key(sx, sy);
    if (resolved.has(sk)) continue;

    const seen = new Set<number>([sk]);
    const heap = new Heap();
    heap.push(edgeDist(sx, sy), sk);
    let escaped = false;
    while (heap.size > 0 && !escaped) {
      const k = heap.pop();
      if (++visits > ENCLOSE_VISIT_CAP) return { ok: false, reason: MSG_TOO_COMPLEX };
      const cx = keyX(k), cy = keyY(k);
      for (const [dx, dy] of NB) {
        const nx = cx + dx, ny = cy + dy;
        if (outside(nx, ny)) { escaped = true; break; }
        const nk = key(nx, ny);
        if (seen.has(nk)) continue;
        if (resolved.has(nk)) { escaped = true; break; }   // joins a component already known to reach the outside
        if (mine(nx, ny)) continue;
        seen.add(nk);
        heap.push(edgeDist(nx, ny), nk);
      }
    }
    for (const k of seen) resolved.add(k);
    if (escaped) continue;

    // Enclosed. Anyone else's land in there is cut off; unclaimed land is tolerated in small notches.
    let pocket = 0;
    for (const k of seen) {
      const px = keyX(k), py = keyY(k);
      const o = land.ownerAt(px, py);
      if (o !== null) return { ok: false, reason: `That purchase would cut off ${nameOf(o)}'s parcel` };
    }
    for (const k of seen) if (!land.isWater(keyX(k), keyY(k))) pocket++;
    if (pocket > MAX_ENCLOSED_UNCLAIMED) return { ok: false, reason: MSG_ENCLOSE_UNCLAIMED };
  }
  return { ok: true };
}

/** The rectangles of `owned` joined to `r` by sharing an edge or a corner, directly or through each other. */
function joined(r: LandRect, owned: readonly LandRect[]): LandRect[] {
  const touch = (a: LandRect, b: LandRect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
  const out: LandRect[] = [], left = [...owned], queue: LandRect[] = [r];
  while (queue.length) {
    const a = queue.pop()!;
    for (let i = left.length - 1; i >= 0; i--) if (touch(a, left[i])) { const b = left.splice(i, 1)[0]; out.push(b); queue.push(b); }
  }
  return out;
}
