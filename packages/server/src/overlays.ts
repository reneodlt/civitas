import {
  CHUNK_SIZE, Overlay, OVERLAY_COVERAGE_FULL, OVERLAY_JOBS_RADIUS, OVERLAY_JOBS_FULL, Zone, Terrain, KIND_COUNT,
  SERVICE_RADIUS_OF, SERVICE_STRENGTH_OF, LEISURE_CODES, LEISURE_MAX_RADIUS, capacityOf, leisureAt, isRoad, zoneOf, overlayByte,
  NEIGHBOURHOOD_KIND0, isNeighbourhoodOverlay, VALUE_CELL, VALUE_CELLS, VALUE_SLOTS, VALUE_SLOT_VALUE,
} from '@msimcity/shared';
import type { World } from './world';
import type { Simulation } from './sim/simulation';
import type { Issues } from './sim/issues';
import type { News } from './sim/news';
import { LEISURE } from './sim/life';

const N = CHUNK_SIZE * CHUNK_SIZE;

/**
 * The data overlays (shared/src/issues.ts Overlay): one byte per tile of a chunk for the channel a client asked for,
 * worked out from what the simulation already keeps. Coverage and leisure are painted on every land tile (where a home
 * would be covered), the same sums Simulation.coverage() and leisureCoverage() make for a home; happiness on the tiles
 * of homes with people in them (the issue census); jobs/homes as jobs minus residents within OVERLAY_JOBS_RADIUS.
 * 0 means no data (water, roads). Net calls `bytes` for subscribed chunks a few times a game hour and sends what changed.
 */
export class Overlays {
  private best = new Float32Array(KIND_COUNT * N);
  private sum = new Float32Array(N);
  private reach = new Uint8Array(N);
  /** the news log (sim/news.ts), for the news overlay; set by Net */
  news: News | null = null;

  constructor(private w: World, private sim: Simulation, private issues: Issues) {}

  /** The chunk's bytes for one channel, or null when the channel is unknown or the chunk is not loaded. */
  bytes(ch: number, cx: number, cy: number): Uint8Array | null {
    const ch0 = this.w.getChunk(cx, cy, false);
    if (!ch0) return null;
    switch (ch) {
      case Overlay.Coverage: return this.coverage(cx, cy, ch0.tiles);
      case Overlay.Leisure: return this.leisure(cx, cy, ch0.tiles);
      case Overlay.Happiness: return this.happiness(cx, cy, ch0.tiles, ch0.aux);
      case Overlay.JobsHomes: return this.jobsHomes(cx, cy, ch0.tiles);
      case Overlay.News: return this.newsReach(cx, cy, ch0.tiles);
      default: return isNeighbourhoodOverlay(ch) ? this.neighbourhood(ch, cx, cy, ch0.tiles) : null;
    }
  }

  /**
   * The Neighbourhood layer (sim/value.ts): each 4×4 cell's byte on its land tiles, the combined value (1 is the middle
   * of the diverging ramp) or one kind. A chunk with no field (nothing built near) shows no data.
   */
  private neighbourhood(ch: number, cx: number, cy: number, tiles: Uint16Array) {
    const f = this.sim.value.chunkBytes(cx, cy), out = new Uint8Array(N);
    if (!f) return out;
    const slot = ch === Overlay.Neighbourhood ? VALUE_SLOT_VALUE : ch - NEIGHBOURHOOD_KIND0;
    for (let i = 0; i < N; i++) {
      if (!this.land(tiles[i])) continue;
      const lx = i % CHUNK_SIZE, ly = Math.floor(i / CHUNK_SIZE);
      out[i] = overlayByte(f[(Math.floor(ly / VALUE_CELL) * VALUE_CELLS + Math.floor(lx / VALUE_CELL)) * VALUE_SLOTS + slot] / 255);
    }
    return out;
  }

  private land(t: number) { return !isRoad(t) && (t & 3) !== Terrain.Water; }

  /** Police, fire and health: per family the strongest staffed station whose square reaches the tile, summed (Simulation.coverage). */
  private coverage(cx: number, cy: number, tiles: Uint16Array) {
    const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE, best = this.best;
    best.fill(0);
    for (const s of this.sim.staffedServices) {
      const r = SERVICE_RADIUS_OF[s.id], v = SERVICE_STRENGTH_OF[s.id], z = s.zone;
      const ax = Math.max(x0, s.x - r), bx = Math.min(x0 + CHUNK_SIZE - 1, s.x + r);
      const ay = Math.max(y0, s.y - r), by = Math.min(y0 + CHUNK_SIZE - 1, s.y + r);
      if (ax > bx || ay > by) continue;
      for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
        const i = z * N + (y - y0) * CHUNK_SIZE + (x - x0);
        if (v > best[i]) best[i] = v;
      }
    }
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!this.land(tiles[i])) continue;
      let n = 0;
      for (let k = 0; k < KIND_COUNT; k++) n += best[k * N + i];
      out[i] = overlayByte(n / OVERLAY_COVERAGE_FULL);
    }
    return out;
  }

  /** Leisure value of the open-able places whose radius reaches the tile, capped (Simulation.leisureCoverage, without the block gardens). */
  private leisure(cx: number, cy: number, tiles: Uint16Array) {
    const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE, sum = this.sum;
    sum.fill(0);
    const mx = x0 + CHUNK_SIZE / 2, my = y0 + CHUNK_SIZE / 2;
    this.w.eachBuiltNear(mx, my, LEISURE_CODES, LEISURE_MAX_RADIUS + CHUNK_SIZE, (b) => {
      const sp = leisureAt(b.id, b.level, b.x, b.y);
      if (!sp || sp.blockOnly || (sp.staffed && b.occupants === 0)) return;
      const r = sp.radius;
      for (let y = Math.max(y0, b.y - r); y <= Math.min(y0 + CHUNK_SIZE - 1, b.y + r); y++) {
        const rest = r - Math.abs(y - b.y);
        for (let x = Math.max(x0, b.x - rest); x <= Math.min(x0 + CHUNK_SIZE - 1, b.x + rest); x++) sum[(y - y0) * CHUNK_SIZE + (x - x0)] += sp.value;
      }
    });
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (this.land(tiles[i])) out[i] = overlayByte(Math.min(LEISURE.coverageCap, sum[i]) / LEISURE.coverageCap);
    return out;
  }

  /** How many media centres' channels reach each land tile: none, one (half way up the ramp) or rival channels (the top). */
  private newsReach(cx: number, cy: number, tiles: Uint16Array) {
    const out = new Uint8Array(N);
    if (!this.news) return out;
    this.news.channelsOver(cx * CHUNK_SIZE, cy * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, this.reach);
    for (let i = 0; i < N; i++) if (this.land(tiles[i])) out[i] = overlayByte(this.reach[i] / 2);
    return out;
  }

  /** Mean happiness of a home's residents (at the issue census), on every tile of the home; 0 elsewhere. */
  private happiness(cx: number, cy: number, tiles: Uint16Array, aux: Uint8Array) {
    const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE, w = this.w;
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const t = tiles[i];
      if (isRoad(t) || zoneOf(t) !== Zone.Residential) continue;
      const x = x0 + (i % CHUNK_SIZE), y = y0 + Math.floor(i / CHUNK_SIZE);
      const [dx, dy] = aux[i] ? w.doorOf(x, y) : [x, y];
      const h = this.issues.happinessAt(dx, dy);
      if (h < 0) continue;
      out[i] = overlayByte(h / 100);
    }
    return out;
  }

  /** Jobs (capacity) minus residents within OVERLAY_JOBS_RADIUS tiles (a square), on every land tile; 128 is balanced. */
  private jobsHomes(cx: number, cy: number, tiles: Uint16Array) {
    const R = OVERLAY_JOBS_RADIUS, S = CHUNK_SIZE + 2 * R + 1;
    const x0 = cx * CHUNK_SIZE - R, y0 = cy * CHUNK_SIZE - R; // window origin; prefix sums are one bigger
    const grid = new Float32Array(S * S);
    const mx = cx * CHUNK_SIZE + CHUNK_SIZE / 2, my = cy * CHUNK_SIZE + CHUNK_SIZE / 2;
    this.w.eachBuiltNear(mx, my, null, CHUNK_SIZE + 2 * R + 2, (b) => {
      const gx = b.x - x0, gy = b.y - y0;
      if (gx < 0 || gy < 0 || gx >= S - 1 || gy >= S - 1) return;
      if (b.zone === Zone.Parking) return;
      const v = b.zone === Zone.Residential ? -b.occupants : capacityOf(b.id, b.level);
      if (v) grid[(gy + 1) * S + gx + 1] += v;
    });
    for (let y = 1; y < S; y++) for (let x = 1; x < S; x++) grid[y * S + x] += grid[(y - 1) * S + x] + grid[y * S + x - 1] - grid[(y - 1) * S + x - 1];
    const box = (ax: number, ay: number, bx: number, by: number) => grid[by * S + bx] - grid[ay * S + bx] - grid[by * S + ax] + grid[ay * S + ax];
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!this.land(tiles[i])) continue;
      const lx = i % CHUNK_SIZE, ly = Math.floor(i / CHUNK_SIZE);
      const bal = box(lx, ly, lx + 2 * R + 1, ly + 2 * R + 1); // window [lx, lx + 2R] in grid coordinates, prefix-sum indices one up
      out[i] = overlayByte(0.5 + 0.5 * Math.max(-1, Math.min(1, bal / OVERLAY_JOBS_FULL)));
    }
    return out;
  }
}

