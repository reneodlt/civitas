import {
  LAND_TUNING, TICKS_PER_DAY, CHUNK_SIZE, VALUE_CELL, VALUE_CELLS, Zone, isBuildable, isRoad, zoneOf, packTile, terrainOf, underConstruction, isCivicId, levelOf,
  landPriceBytes, landPriceOf, priceOfByte, wildPriceByte, tileKey, u8ToB64,
} from '@msimcity/shared';
import { tkey, type World, type Parcel } from '../world';
import type { ValueField } from './value';

const money = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;

/**
 * Land and money on a shared world (docs/multiplayer-land.md section 3, M2). One per game (game.ts), `market` set when the
 * host plays the market rules (a shared world: not a frontier, sandbox, showcase or local game).
 *
 * - **Prices.** Each chunk's land price bytes (shared/src/land.ts), one per 4×4 cell of the value field (sim/value.ts),
 *   cached until the field's version moves. Net sends them to subscribed clients (`landPrice`) and prices purchases
 *   from them, so the client's preview and the charge agree.
 * - **The empty-land tax.** Each midnight every owner pays LAND_TUNING.emptyTax of the current price of each owned dry
 *   tile with nothing on it (no road, zone, building, track or structure), ledger line `landtax`, unless they have not
 *   been seen (Player.seen, kept by net.ts) for awayPauseDays.
 * - **Abandoned land.** An owner unseen abandonEmptyDays loses each parcel with no building on it (roads and empty zoned
 *   lots at most): the zoning goes, roads stay as public road nobody pays for (adopted, so they fade if unused), the tiles
 *   are unclaimed again, and the owner's treasury gets the parcel's current price. After abandonBuiltDays the rest goes
 *   to the Commons ('sys', when the world has one) at the current land price; the buildings go with the land, unpaid.
 *
 * The Commons, dev-funded players and sandboxes are never taxed and never lose land.
 */
export class LandMarket {
  /** for one owner's screen (net.ts sends them as toasts; an absent owner misses them) */
  notices: { owner: string; msg: string }[] = [];
  private day: number;
  private cache = new Map<number, { ver: number; b: Uint8Array | undefined; d: string }>();
  /** the last midnight's figures, for checks and probes */
  last = { taxed: 0, tax: 0, paused: 0, reverted: 0, toCommons: 0 };

  constructor(private w: World, private value: ValueField, public market: boolean) {
    this.day = w.day;
  }

  /** After every simulation tick (game.ts). */
  tick() {
    if (this.w.day === this.day) return;
    this.day = this.w.day;
    if (this.market) this.midnight();
  }

  // ---- prices ----------------------------------------------------------------------------------------

  private entry(cx: number, cy: number) {
    const k = tkey(cx, cy), ver = this.value.version;
    let e = this.cache.get(k);
    if (!e || e.ver !== ver) {
      const f = this.value.chunkBytes(cx, cy), b = f ? landPriceBytes(f) : undefined;
      e = { ver, b, d: b ? u8ToB64(b) : '' };
      this.cache.set(k, e);
      if (this.cache.size > 4096) for (const [kk, ee] of this.cache) if (ee.ver !== ver) this.cache.delete(kk);
    }
    return e;
  }
  /** A chunk's price bytes, undefined where nothing is near (the wild price). */
  priceBytes(cx: number, cy: number): Uint8Array | undefined { return this.entry(cx, cy).b; }
  /** The `landPrice` message's payload for a chunk: base64, '' for the wild price. */
  priceMsg(cx: number, cy: number): string { return this.entry(cx, cy).d; }
  /** The price of a rectangle, as the client works it out from the same bytes. */
  priceOf(r: { x: number; y: number; w: number; h: number }): number { return landPriceOf(r, (cx, cy) => this.priceBytes(cx, cy)); }
  /** One tile's current price (dollars, unrounded). */
  tilePrice(x: number, y: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), b = this.priceBytes(cx, cy);
    if (!b) return priceOfByte(wildPriceByte());
    const lx = Math.floor((x - cx * CHUNK_SIZE) / VALUE_CELL), ly = Math.floor((y - cy * CHUNK_SIZE) / VALUE_CELL);
    return priceOfByte(b[ly * VALUE_CELLS + lx]);
  }

  // ---- what is on the land -----------------------------------------------------------------------------

  /** A dry tile with nothing on it: no road, zone, building, track, structure or tunnel. */
  isEmpty(x: number, y: number): boolean {
    const w = this.w, t = w.peekTile(x, y);
    if (t === undefined) return true;
    return isBuildable(t) && !isRoad(t) && zoneOf(t) === Zone.None && !w.auxAt(x, y) && !w.underAt(x, y);
  }
  /** The parcel has no building on it (roads and empty zoned lots at most), nothing being built, no structure, track or tunnel. */
  unbuilt(q: Parcel): boolean {
    const w = this.w;
    for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
      const t = w.peekTile(x, y);
      if (t === undefined) continue;
      if (underConstruction(t) || w.sites.has(tileKey(x, y)) || w.underAt(x, y)) return false;
      if (isRoad(t)) continue;
      if (w.auxAt(x, y)) return false;
      if (zoneOf(t) !== Zone.None && (levelOf(t) > 0 || isCivicId(w.kindIdAt(x, y)))) return false;
    }
    return true;
  }
  /** The parcel's daily empty-land tax now: its empty tiles at their prices times the rate. */
  taxOf(q: Parcel): number {
    let sum = 0;
    for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) if (this.isEmpty(x, y)) sum += this.tilePrice(x, y);
    return sum * LAND_TUNING.emptyTax;
  }
  /** Days since the player was last seen connected (0 when never recorded: the clock starts now). */
  awayDays(id: string): number {
    const p = this.w.players.get(id);
    if (!p) return 0;
    p.seen ??= this.w.tick;
    return (this.w.tick - p.seen) / TICKS_PER_DAY;
  }

  // ---- midnight ----------------------------------------------------------------------------------------

  /** The tax and abandoned land. Public for checks. */
  midnight() {
    const w = this.w, T = LAND_TUNING;
    const last = this.last = { taxed: 0, tax: 0, paused: 0, reverted: 0, toCommons: 0 };
    const byOwner = new Map<string, Parcel[]>();
    for (const q of w.parcels.values()) {
      const p = w.players.get(q.owner);
      if (!p || p.id === 'sys' || p.devUnlimited) continue;
      let l = byOwner.get(q.owner);
      if (!l) byOwner.set(q.owner, l = []);
      l.push(q);
    }
    for (const [owner, list] of byOwner) {
      const away = this.awayDays(owner);
      if (away >= T.abandonEmptyDays) {
        let back = 0, n = 0, nb = 0;
        for (const q of list) {
          if (w.landLocked?.(q.id)) continue; // leased land (sim/landdeals.ts, M7) goes back to its landlord, not the market
          if (this.unbuilt(q)) { back += this.revert(q); n++; }
          else if (T.abandonBuiltDays > 0 && away >= T.abandonBuiltDays && w.players.has('sys')) { back += this.toCommons(q); nb++; }
        }
        if (n || nb) {
          w.credit(owner, back, 'land');
          last.reverted += n; last.toCommons += nb;
          this.notices.push({ owner, msg: `Away ${Math.floor(away)} days: ${n + nb} of your parcels went back to the market${nb ? ` (${nb} with buildings, to the Commons)` : ''}, and ${money(back)} came into your treasury` });
        }
      }
      if (away >= T.awayPauseDays) { last.paused++; continue; }
      let tax = 0;
      for (const q of list) if (w.parcels.has(q.id)) tax += this.taxOf(q);
      if (tax <= 0) continue;
      tax = Math.round(tax * 100) / 100;
      w.credit(owner, -tax, 'landtax');
      last.taxed++; last.tax += tax;
    }
  }

  /** An unbuilt parcel back to the market: zoning cleared, roads left as public road nobody pays for. Returns its price. */
  private revert(q: Parcel): number {
    const w = this.w, price = this.priceOf(q);
    if (q.group !== undefined) w.leaveEstate(q.id, () => true);
    for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
      const t = w.peekTile(x, y);
      if (t !== undefined && !isRoad(t) && zoneOf(t) !== Zone.None) w.setTile(x, y, packTile(terrainOf(t), false, 0, 0));
      w.setParcelId(x, y, 0);
      if (t !== undefined && isRoad(t)) w.publicRoads.set(tkey(x, y), { ad: 1, used: w.day, om: 0, od: w.day });
    }
    w.parcels.delete(q.id);
    w.roadUpkeep.delete(q.id);
    w.removedParcels.add(q.id); w.dirtyParcels.delete(q.id);
    return price;
  }

  /** A built parcel to the Commons. Returns its land price. */
  private toCommons(q: Parcel): number {
    const w = this.w, price = this.priceOf(q), was = w.players.get(q.owner)?.name ?? q.owner;
    if (q.group !== undefined) w.leaveEstate(q.id, () => true);
    q.owner = 'sys';
    q.name = `Commons (was ${was}'s)`;
    w.recountRoads(q.id);
    w.dirtyParcels.add(q.id);
    return price;
  }
}
