import { PUBLIC_ROAD_TUNING as T, isRoad, isClassAux, classDef, auxClass, zoneOf, packTile, terrainOf, Zone, CHUNK_SIZE } from '@msimcity/shared';
import { DIRS, tkey, untkey, type World, type PublicRoad } from '../world';
import { findRoute } from '../pathfinding';
import type { Traffic } from './traffic';
import type { Gateways } from './gateways';

/**
 * Public roads (docs/multiplayer-land.md section 8, phase M3): road on unclaimed land.
 *
 * - **Builder pays.** net.ts records who lays (or upgrades) each public road tile (`laid`); at midnight that player pays
 *   the tile's upkeep at its class's rate, ledger line 'roads' ("Public roads"). Road from before M3, or laid by the
 *   world itself, is `old`: nobody pays and it never fades. Land bought under a public road takes it into the parcel
 *   (World.setParcelId drops the record) and its owner pays for it as for any road of theirs.
 * - **Use.** Every `sampleTicks` ticks the moving citizens and vehicles standing on a public road tile mark it used
 *   today, under their owner (a citizen's home parcel's owner, a vehicle's dispatcher); a tile whose congestion is above
 *   nothing counts as used too, and at midnight so does a tile with anything built or zoned beside it.
 * - **Fading.** A tile unused for `fadeDays` whole days reverts to plain ground at midnight (ordinary tile deltas, no
 *   refund), unless removing it would cut someone's land off from every gateway (`cutOff`, the same check as the
 *   bulldozer's). Its builder is told the midnight before.
 * - **Adoption.** A tile other owners' traffic used on `adoptDays` of the last `adoptWindow` days is adopted: the
 *   builder record goes and nobody pays its upkeep for now (`regionalFund`, the hook M4's fund fills).
 * - **Protected removal** (`removalRefusal`): bulldozing public road is refused when it would cut another player's land
 *   off from every gateway, or when other players' traffic used it lately and the way round between its ends is more
 *   than `protectDetour` dearer. Closure notices with objections come with planning (M5).
 *
 * Nothing here runs per tick per tile: a sample walks the movers every `sampleTicks` ticks and the public road set once;
 * midnight walks the public road set once.
 */
export class PublicRoads {
  /**
   * Hook for M4's regional fund: called at midnight with the day's upkeep of the adopted public road tiles. Nobody pays it
   * yet; the fund (docs/multiplayer-land.md section 5, the levy) will.
   */
  regionalFund: ((upkeep: number) => void) | null = null;
  /** the adopted upkeep of the last midnight (the probes read it) */
  adoptedUpkeep = 0;

  constructor(private w: World, private traffic: Traffic, private gateways: Gateways, private notify: (owner: string, msg: string) => void) {
    this.adoptOld();
  }

  /**
   * Every road tile on unclaimed land that has no record yet becomes `old` (a save from before M3, or a seeded world):
   * nobody pays for it and it never fades, but its use is tracked, so the bulldozer can protect the players who use it.
   * Once, when the game starts: road laid since goes through `laid`.
   */
  private adoptOld() {
    const w = this.w, day = w.day;
    for (const c of w.chunks.values()) for (let i = 0; i < c.tiles.length; i++) {
      if (!isRoad(c.tiles[i]) || c.parcel[i] !== 0) continue;
      const k = tkey(c.cx * CHUNK_SIZE + (i % CHUNK_SIZE), c.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE));
      if (!w.publicRoads.has(k)) w.publicRoads.set(k, { old: 1, used: day, om: 0, od: day });
    }
  }

  /** A player laid road on unclaimed tile (x, y), or upgraded the road there: they are its builder now and pay its upkeep. */
  laid(x: number, y: number, builder: string) {
    if (this.w.parcelIdAt(x, y) !== 0) return;
    const day = this.w.day, r = this.w.publicRoads.get(tkey(x, y));
    const u = r?.u;
    this.w.publicRoads.set(tkey(x, y), { b: builder, used: day, om: 0, od: day, ...(u ? { u } : {}) });
  }

  /** The builder of public road tile (x, y), if anyone pays for it. */
  builderAt(x: number, y: number): string | undefined { return this.w.publicRoads.get(tkey(x, y))?.b; }

  /** After every simulation tick: a sample every `sampleTicks` ticks. */
  tick() { if (this.w.tick % T.sampleTicks === 0 && this.w.publicRoads.size) this.sample(); }

  /** Who is on the public road now: moving citizens (by their home's owner) and vehicles (by their dispatcher), and congestion. */
  sample() {
    const w = this.w, pr = w.publicRoads, day = w.day;
    for (const c of w.citizens.values()) {
      if (!c.leg) continue;
      const r = pr.get(tkey(Math.floor(c.x), Math.floor(c.y)));
      if (r) this.use(r, w.parcelAt(c.hx, c.hy)?.owner, day);
    }
    for (const v of w.vehicles.values()) {
      if (v.phase === 'dwell') continue;
      const r = pr.get(tkey(Math.floor(v.x), Math.floor(v.y)));
      if (r) this.use(r, v.owner ?? undefined, day);
    }
    for (const [k, r] of pr) {
      if (r.used === day) continue;
      const [x, y] = untkey(k);
      if (this.traffic.congestionAt(x, y) > 0) r.used = day;
    }
  }

  private use(r: PublicRoad, owner: string | undefined, day: number) {
    r.used = day;
    if (!owner) return;
    (r.u ??= {})[owner] = day;
    if (owner !== r.b && !r.old) { roll(r, day); r.om |= 1; }
  }

  /** At midnight (Simulation.newDay, after the day has turned): drop stale records, adopt, charge, warn and fade. */
  newDay() {
    const w = this.w, pr = w.publicRoads;
    if (!pr.size) return;
    const day = w.day, yesterday = day - 1;
    const owe = new Map<string, number>(), adopted = new Map<string, Spot>(), warn = new Map<string, Spot>();
    const fade = new Set<number>();
    let fund = 0;
    for (const [k, r] of pr) {
      const [x, y] = untkey(k), t = w.peekTile(x, y);
      if (t === undefined || !isRoad(t) || w.parcelIdAt(x, y) !== 0) { pr.delete(k); continue; } // gone (bulldozed, undone) or bought
      if (r.used < yesterday && this.fronted(x, y)) r.used = yesterday;
      if (r.u) {
        for (const id in r.u) if (r.u[id] <= yesterday - T.adoptWindow) delete r.u[id];
        if (!Object.keys(r.u).length) delete r.u;
      }
      if (r.old) continue;
      roll(r, yesterday);
      if (!r.ad && bits(r.om) >= T.adoptDays) {
        if (r.b) note(adopted, r.b, x, y);
        delete r.b; delete r.warned; r.ad = 1;
      }
      const up = classDef(auxClass(w.auxAt(x, y))).upkeep;
      if (r.b) owe.set(r.b, (owe.get(r.b) ?? 0) + up);
      else fund += up;
      const idle = yesterday - r.used, a = w.auxAt(x, y);
      if (a && !isClassAux(a)) continue; // a junction, bridge deck or crossing stays (its builder can bulldoze it)
      if (idle >= T.fadeDays) fade.add(k);
      else if (idle === T.fadeDays - 1 && r.b && r.warned === undefined) { r.warned = day; note(warn, r.b, x, y); }
    }
    for (const [owner, amount] of owe) if (amount > 0) w.credit(owner, -amount, 'roads');
    this.adoptedUpkeep = fund;
    if (fund > 0) this.regionalFund?.(fund);
    for (const [owner, s] of adopted) this.notify(owner, `${plural(s.n, 'tile')} of the public road you laid near (${s.x}, ${s.y}) ${s.n === 1 ? 'is' : 'are'} used by other players' traffic every day now and ${s.n === 1 ? 'has' : 'have'} been adopted: you no longer pay ${s.n === 1 ? 'its' : 'their'} upkeep`);
    for (const [owner, s] of warn) this.notify(owner, `${plural(s.n, 'tile')} of the public road you laid near (${s.x}, ${s.y}) ${s.n === 1 ? 'has' : 'have'} had no traffic for ${plural(T.fadeDays - 1, 'day')}: unless something uses ${s.n === 1 ? 'it' : 'them'}, ${s.n === 1 ? 'it goes' : 'they go'} back to countryside at midnight (no refund)`);
    if (fade.size) this.fade(fade, yesterday);
  }

  /** The unused tiles go back to plain ground, a cluster at a time, but for a cluster that is the only link to someone's land. */
  private fade(tiles: Set<number>, yesterday: number) {
    const w = this.w, faded = new Map<string, Spot>();
    const left = new Set(tiles);
    for (const k0 of tiles) {
      if (!left.has(k0)) continue;
      // the cluster of fading tiles 4-connected to k0
      const cl = new Set<number>([k0]), q = [k0];
      left.delete(k0);
      for (let i = 0; i < q.length; i++) {
        const [x, y] = untkey(q[i]);
        for (const [dx, dy] of DIRS) { const n = tkey(x + dx, y + dy); if (left.has(n)) { left.delete(n); cl.add(n); q.push(n); } }
      }
      if (this.cutOff(cl, null).length) { for (const k of cl) { const r = w.publicRoads.get(k); if (r) { r.used = yesterday; delete r.warned; } } continue; } // someone's only link: kept, looked at again in fadeDays
      for (const k of cl) {
        const [x, y] = untkey(k), r = w.publicRoads.get(k);
        if (r?.b) note(faded, r.b, x, y);
        w.publicRoads.delete(k);
        w.setTile(x, y, packTile(terrainOf(w.getTile(x, y)), false, 0, 0));
      }
    }
    for (const [owner, s] of faded) this.notify(owner, `${plural(s.n, 'tile')} of the public road you laid near (${s.x}, ${s.y}) went back to countryside after ${plural(T.fadeDays, 'day')} with no traffic`);
  }

  /** Anything built, being built or zoned beside road tile (x, y): it serves a lot. */
  private fronted(x: number, y: number): boolean {
    for (const [dx, dy] of DIRS) {
      const t = this.w.peekTile(x + dx, y + dy);
      if (t !== undefined && !isRoad(t) && zoneOf(t) !== Zone.None) return true;
    }
    return false;
  }

  // ---- protected removal ------------------------------------------------------------------------------------------

  /**
   * Why `actor` may not bulldoze these public road tiles, or null when they may: removing them (all together) would cut
   * another player's land off from every gateway, or lengthen the trips of other players whose traffic used them in the
   * adoption window by more than `protectDetour`. A replacement route already there passes both naturally.
   */
  removalRefusal(tiles: readonly (readonly [number, number])[], actor: string): string | null {
    const walls = new Set<number>();
    for (const [x, y] of tiles) walls.add(tkey(x, y));
    if (!walls.size) return null;
    const cut = this.cutOff(walls, actor);
    if (cut.length) return `This public road is the only road link between ${possessive(this.w, cut)} land and the gateways: build another way round before taking it up`;
    // whose traffic used it lately (other than the bulldozer's)
    const day = this.w.day, users = new Set<string>();
    for (const k of walls) { const u = this.w.publicRoads.get(k)?.u; if (u) for (const id in u) if (id !== actor && u[id] > day - 1 - T.adoptWindow) users.add(id); }
    if (!users.size) return null;
    const extra = this.detour(walls);
    if (extra <= T.protectDetour) return null;
    const how = Number.isFinite(extra) ? `the way round is ${Math.round(extra)} tiles longer` : 'there is no way round near by';
    return `${possessive(this.w, [...users])} traffic uses this public road and ${how}: build a replacement route before taking it up`;
  }

  /**
   * Who depends on these public road tiles (other than `actor`): the owners removing them would cut off, and the owners
   * whose traffic used them within the adoption window. A closure notice (M5, sim/planning.ts) goes to these mayors.
   */
  dependents(tiles: readonly (readonly [number, number])[], actor: string): string[] {
    const walls = new Set<number>();
    for (const [x, y] of tiles) walls.add(tkey(x, y));
    const out = new Set(this.cutOff(walls, actor)), day = this.w.day;
    for (const k of walls) { const u = this.w.publicRoads.get(k)?.u; if (u) for (const id in u) if (id !== actor && u[id] > day - 1 - T.adoptWindow) out.add(id); }
    return [...out].sort();
  }

  /**
   * The owners (other than `actor`; everyone with null) whose land reaches a gateway along roads now and would not with
   * the road tiles `walls` gone. Candidates are the owners beside the tiles and beside any piece of road the removal
   * leaves with no gateway; each is confirmed with a bounded search from all the roads in and around their land.
   */
  cutOff(walls: ReadonlySet<number>, actor: string | null): string[] {
    const w = this.w, gw = this.gatewayTiles();
    if (!gw.size) return []; // a world with no gateway yet: nothing to be cut off from
    const cands = new Set<string>();
    const ownersBeside = (x: number, y: number) => {
      const o = w.parcelAt(x, y)?.owner; if (o) cands.add(o);
      for (const [dx, dy] of DIRS) { const q = w.parcelAt(x + dx, y + dy)?.owner; if (q) cands.add(q); }
    };
    const sides: number[] = [];
    for (const k of walls) {
      const [x, y] = untkey(k);
      ownersBeside(x, y);
      for (const [dx, dy] of DIRS) { const n = tkey(x + dx, y + dy); if (!walls.has(n) && this.road(n)) sides.push(n); }
    }
    const done = new Set<number>();
    for (const s of sides) {
      if (done.has(s)) continue;
      const r = this.reach([s], walls, gw);
      if (r.open) continue;
      for (const k of r.seen) { done.add(k); const [x, y] = untkey(k); ownersBeside(x, y); }
    }
    if (actor) cands.delete(actor);
    const out: string[] = [];
    for (const o of cands) {
      const starts = this.roadsOf(o, gw);
      if (starts === true) continue; // a gateway on their own land
      if (this.reach(starts, NONE, gw).open && !this.reach(starts, walls, gw).open) out.push(o);
    }
    return out;
  }

  /** The dearest way round the removed tiles between the road tiles at their ends, over the cost through them (Infinity: none found). */
  detour(walls: ReadonlySet<number>): number {
    const ends: [number, number][] = [];
    for (const k of walls) {
      const [x, y] = untkey(k);
      for (const [dx, dy] of DIRS) { const n = tkey(x + dx, y + dy); if (!walls.has(n) && this.road(n) && !ends.some(([ex, ey]) => tkey(ex, ey) === n)) ends.push([x + dx, y + dy]); }
    }
    if (ends.length < 2) return 0; // a dead end: nobody goes through it
    const cost = (x: number, y: number) => this.traffic.cost(x, y);
    let worst = 0;
    const [s] = ends;
    for (const g of ends.slice(1, 6)) {
      // (both searches take HGV bans as walls, as the probe's set does; so the difference is the tiles' alone)
      const before = findRoute(this.w, s[0], s[1], g[0], g[1], cost, 0.4, 6000, -1, Infinity, false, false, new Set<number>());
      if (!before) continue;
      const after = findRoute(this.w, s[0], s[1], g[0], g[1], cost, 0.4, 6000, -1, Infinity, false, false, walls as Set<number>);
      worst = Math.max(worst, after ? after.cost - before.cost : Infinity);
    }
    return worst;
  }

  /** Road tiles next to a gateway's door (and the one in front of it). */
  private gatewayTiles(): Set<number> {
    const s = new Set<number>();
    for (const g of this.gateways.list) {
      s.add(tkey(g.fx, g.fy));
      for (const [dx, dy] of DIRS) if (this.road(tkey(g.x + dx, g.y + dy))) s.add(tkey(g.x + dx, g.y + dy));
    }
    return s;
  }

  /** The road tiles in and round an owner's parcels (true when a gateway's road is on their land). */
  private roadsOf(owner: string, gw: ReadonlySet<number>): number[] | true {
    const out: number[] = [];
    for (const p of this.w.parcels.values()) {
      if (p.owner !== owner) continue;
      for (let y = p.y - 1; y <= p.y + p.h; y++) for (let x = p.x - 1; x <= p.x + p.w; x++) {
        const k = tkey(x, y);
        if (!this.road(k)) continue;
        const inside = x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
        if (inside && gw.has(k)) return true;
        out.push(k);
      }
    }
    return out;
  }

  /**
   * Breadth-first along road tiles from `starts`, not through `walls`: open when it meets a gateway's road or passes
   * reachMax tiles (a network that big is taken as linked); otherwise the tiles it reached.
   */
  private reach(starts: readonly number[], walls: ReadonlySet<number>, gw: ReadonlySet<number>): { open: boolean; seen: Set<number> } {
    const seen = new Set<number>(), q: number[] = [];
    for (const k of starts) if (!walls.has(k) && !seen.has(k) && this.road(k)) { seen.add(k); q.push(k); }
    for (let i = 0; i < q.length; i++) {
      const k = q[i];
      if (gw.has(k) || seen.size > T.reachMax) return { open: true, seen };
      const [x, y] = untkey(k);
      for (const [dx, dy] of DIRS) {
        const n = tkey(x + dx, y + dy);
        if (seen.has(n) || walls.has(n) || !this.road(n)) continue;
        seen.add(n); q.push(n);
      }
    }
    return { open: false, seen };
  }

  private road(k: number): boolean { const [x, y] = untkey(k), t = this.w.peekTile(x, y); return t !== undefined && isRoad(t); }
}

const NONE: ReadonlySet<number> = new Set();

/** Shift a record's other-owner day bits on to `day`. */
function roll(r: PublicRoad, day: number) {
  if (day <= r.od) return;
  const s = day - r.od;
  r.om = s >= T.adoptWindow ? 0 : (r.om << s) & ((1 << T.adoptWindow) - 1);
  r.od = day;
}
function bits(n: number) { let c = 0; for (; n; n &= n - 1) c++; return c; }

interface Spot { n: number; x: number; y: number }
function note(m: Map<string, Spot>, owner: string, x: number, y: number) {
  const s = m.get(owner);
  if (s) s.n++; else m.set(owner, { n: 1, x, y });
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
/** "Bob's", "Bob's and Ada's", "the Commons'" */
function possessive(w: World, ids: readonly string[]): string {
  const names = ids.slice(0, 3).map((id) => {
    const n = id === 'sys' ? 'the Commons' : w.players.get(id)?.name ?? id;
    return n.endsWith('s') ? `${n}'` : `${n}'s`;
  });
  if (ids.length > 3) names.push(`${ids.length - 3} more players'`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
