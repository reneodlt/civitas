import {
  LAND_DEALS, LAND_TUNING, KIND_NAMES, Zone, zoneOf, levelOf, isRoad, isBuildable, checkPurchase, edgeAdjacent, inRect, rectsOverlap,
  cleanCovenant, joinCovenants, covenantRefusal, covenantAllowsLevel, covenantText, stripRefusal, isHeavyNuisanceKind,
  type Covenant, type ListingDTO, type OfferDTO, type LeaseOfferDTO, type LeaseDTO, type PactDTO, type DealsView, type LandDealsSave,
  type LandDealMsg, type Rect, type LandRect, type Placed,
} from '@msimcity/shared';
import type { World, Parcel, Player, Building } from '../world';

const money = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
type Listing = ListingDTO & { sig: string };
export type DealResult = { ok: true; msg: string } | { ok: false; msg: string };
const ok = (msg: string): DealResult => ({ ok: true, msg });
const no = (msg: string): DealResult => ({ ok: false, msg });

/**
 * The land market (docs/multiplayer-land.md section 7 "Land", M7), one per game (game.ts), in every world but a showcase
 * (which refuses every intent anyway):
 *
 * - **Listings and offers.** The holder of a parcel (its owner, or its landlord while leased) lists it, or its whole
 *   estate, at an asking price, optionally with covenants. Anyone else may buy at the asking price at once, or offer
 *   less; the seller accepts or rejects. Money is checked when an offer is made and again when it is accepted (no
 *   escrow). A sale moves the parcels and everything on them: `Parcel.owner` is what every system reads (building
 *   rights, taxes, upkeep, utilities, refuse), so the buyer has it all from the next tick; residents stay. Listings
 *   lapse after LAND_DEALS.listingDays; a listing whose land changed (split, merged, sold another way) is withdrawn.
 * - **Rules for the buyer.** No walling in (landrules.ts, as a purchase), and on a market world a sale touching none of
 *   the buyer's land is an outpost (at least 8×8). "Must share an edge" (classic worlds) does not apply: that paces
 *   buying unclaimed land, and a sale is between two players. `canTransfer` is the hook for planning (M5): land under
 *   an open application cannot change hands.
 * - **Covenants** ride on the parcel (`Parcel.cov`): the build and zone checks (net.ts through `buildRefusal` and
 *   `placeRefusal`) and the growth gate (`mayGrow`, chained before the power gate by game.ts).
 * - **Leases.** The tenant becomes `Parcel.owner` for the term (builds and collects as the owner); the landlord is kept
 *   on the lease. Rent each midnight (`rent` lines on both sides); at the end the land goes back to the landlord with
 *   whatever is on it (the simpler of the design's two rules: no book-value buy-out). A tenant in administration at
 *   midnight has missed the rent: the lease ends. A leased parcel cannot be split, combined, sold back or abandoned
 *   (`World.landLocked`); its landlord may sell it, and the lease goes with it.
 * - **Neighbour pacts.** Two adjacent holders agree a buffer strip on their parcels where nobody builds heavy nuisance
 *   (industrial zoning, refuse sites, polluting plants, the airport); no money changes hands; either may end it with
 *   LAND_DEALS.pactNoticeDays' notice. A pact binds the land: it survives a sale.
 */
export class LandDeals {
  /** for one player's screen (net.ts sends them as toasts) */
  notices: { owner: string; msg: string }[] = [];
  /** something a client sees changed (net.ts sends each client its view) */
  changed = true;
  /** a sandbox (test city, demo): no walling-in or outpost rules */
  sandbox = false;
  /** a shared world's market rules (outposts at least LAND_TUNING.outpostMin) */
  market = false;
  /** planning (M5): why a parcel may not change hands now (an open application), or null */
  canTransfer: ((q: Parcel) => string | null) | null = null;
  /** parcels changed holder (game.ts: the utilities' reach is worked out again) */
  onTransfer: ((ids: number[]) => void) | null = null;
  private listings = new Map<number, Listing>();
  private offers = new Map<number, OfferDTO>();
  private leaseOffers = new Map<number, LeaseOfferDTO>();
  private leases = new Map<number, LeaseDTO>();
  private pacts = new Map<number, PactDTO>();
  private next = 1;
  private day: number;

  constructor(private w: World) {
    this.day = w.day;
    if (w.landDealsLoaded) { this.load(w.landDealsLoaded); w.landDealsLoaded = null; }
    w.landDealsSave = () => this.save();
    w.landLocked = (id) => (this.leaseOn(id) ? 'A lease is running on that parcel: it cannot be split, combined or sold back until the lease ends' : null);
  }

  // ---- reading ------------------------------------------------------------------------------------------

  /** The lease running on a parcel, if any. */
  leaseOn(id: number): LeaseDTO | undefined { for (const l of this.leases.values()) if (l.parcel === id) return l; return undefined; }
  /** Who holds a parcel's freehold: its landlord while leased, else its owner. */
  holder(q: Parcel): string { return this.leaseOn(q.id)?.landlord ?? q.owner; }
  private listingOf(id: number): Listing | undefined { for (const l of this.listings.values()) if (l.parcels.includes(id)) return l; return undefined; }
  private name(id: string) { return this.w.players.get(id)?.name ?? id; }
  private sigOf(qs: Parcel[]) { return qs.map((q) => `${q.id}:${q.x},${q.y},${q.w},${q.h}`).join(';'); }
  private tell(owner: string, msg: string) { this.notices.push({ owner, msg }); }
  private openCount(id: string) {
    let n = 0;
    for (const l of this.listings.values()) if (l.seller === id) n++;
    for (const l of this.leaseOffers.values()) if (l.landlord === id) n++;
    for (const p of this.pacts.values()) if (p.state === 'proposed' && p.a === id) n++;
    return n;
  }

  /** What one player's client is sent: everything public, and the offers they made or received. */
  view(pid: string): DealsView {
    const w = this.w;
    const live = (p: PactDTO): PactDTO => {
      const qa = w.parcels.get(p.pa), qb = w.parcels.get(p.pb);
      return { ...p, a: qa ? this.holder(qa) : p.a, b: qb ? this.holder(qb) : p.b, strip: { ...p.strip } };
    };
    return {
      listings: [...this.listings.values()].map(({ sig: _s, ...l }) => ({ ...l, parcels: [...l.parcels], ...(l.cov ? { cov: { ...l.cov } } : {}) })),
      offers: [...this.offers.values()].filter((o) => o.buyer === pid || this.listings.get(o.listing)?.seller === pid).map((o) => ({ ...o })),
      leaseOffers: [...this.leaseOffers.values()].map((o) => ({ ...o })),
      leases: [...this.leases.values()].map((l) => ({ ...l })),
      pacts: [...this.pacts.values()].map(live),
    };
  }

  // ---- the intents ---------------------------------------------------------------------------------------

  /** One `land` intent from player p. */
  handle(p: Player, m: LandDealMsg): DealResult {
    const before = this.notices.length, r = this.act(p, m);
    // the actor has the result as their toast: what this told them besides goes
    this.notices = [...this.notices.slice(0, before), ...this.notices.slice(before).filter((x) => x.owner !== p.id)];
    return r;
  }
  private act(p: Player, m: LandDealMsg): DealResult {
    const n = (v: unknown) => Math.floor(Number(v));
    switch (m.op) {
      case 'list': return this.list(p, n(m.id), Number(m.price), m.estate === true, cleanCovenant(m.cov));
      case 'unlist': return this.unlist(p, n(m.listing));
      case 'offer': return this.offer(p, n(m.listing), Number(m.amount));
      case 'buy': { const l = this.listings.get(n(m.listing)); return l ? this.buy(p, l) : no('That listing has gone'); }
      case 'accept': return this.accept(p, n(m.offer));
      case 'reject': case 'withdraw': return this.dropOffer(p, n(m.offer), m.op);
      case 'lease': return this.offerLease(p, n(m.id), Number(m.rent), n(m.days), typeof m.tenant === 'string' ? m.tenant : undefined);
      case 'leaseAccept': return this.acceptLease(p, n(m.lease));
      case 'leaseCancel': return this.cancelLease(p, n(m.lease));
      case 'pact': return this.proposePact(p, n(m.pa), n(m.pb), m.strip);
      case 'pactAccept': return this.acceptPact(p, n(m.pact));
      case 'pactEnd': return this.endPact(p, n(m.pact));
    }
    return no('Unknown land deal');
  }

  list(p: Player, id: number, price: number, estate: boolean, cov?: Covenant): DealResult {
    const w = this.w, q = w.parcels.get(id);
    if (!q) return no('That parcel no longer exists');
    const members = estate && q.group !== undefined ? w.estateOf(q.group) : [q];
    if (members.some((m) => this.holder(m) !== p.id)) return no('Not your land to sell');
    if (!(Number.isFinite(price) && price >= 0 && price <= LAND_DEALS.maxPrice)) return no('Give an asking price');
    if (members.some((m) => this.listingOf(m.id))) return no('That land is already for sale: withdraw the listing first');
    if (this.openCount(p.id) >= LAND_DEALS.maxOpen) return no(`At most ${LAND_DEALS.maxOpen} listings, lease offers and pact proposals at a time`);
    for (const m of members) { const why = this.canTransfer?.(m); if (why) return no(why); }
    if (cov) for (const m of members) { const b = this.breach(m, cov); if (b) return no(`That covenant would already be broken on ${m.name}: ${b}`); }
    const l: Listing = { id: this.next++, seller: p.id, parcels: members.map((m) => m.id), price: Math.round(price), ...(cov ? { cov } : {}), listed: w.day, expires: w.day + LAND_DEALS.listingDays, sig: this.sigOf(members) };
    this.listings.set(l.id, l);
    this.changed = true;
    return ok(`${members.length > 1 ? `${q.name} (${members.length} parcels)` : q.name} is for sale at ${money(l.price)} for ${LAND_DEALS.listingDays} days${cov ? `, with the covenant ${covenantText(cov)}` : ''}`);
  }

  private unlist(p: Player, id: number): DealResult {
    const l = this.listings.get(id);
    if (!l) return no('That listing has gone');
    if (l.seller !== p.id) return no('Not your listing');
    this.dropListing(l, 'the seller withdrew it');
    return ok('Listing withdrawn');
  }

  private offer(p: Player, id: number, amount: number): DealResult {
    const l = this.valid(id);
    if (!l) return no('That listing has gone');
    if (l.seller === p.id) return no('That is your own listing');
    if (!(Number.isFinite(amount) && amount > 0)) return no('Offer an amount');
    amount = Math.round(amount);
    if (amount >= l.price) return this.buy(p, l);
    if (p.admin) return no('In administration: buying land is stopped');
    if (this.w.spendable(p) < amount) return no(this.w.shortOf(p, amount, 'for that offer'));
    for (const o of this.offers.values()) if (o.listing === l.id && o.buyer === p.id) this.offers.delete(o.id); // one offer per buyer: the latest
    const o: OfferDTO = { id: this.next++, listing: l.id, buyer: p.id, amount, day: this.w.day };
    this.offers.set(o.id, o);
    this.changed = true;
    this.tell(l.seller, `${p.name} offers ${money(amount)} for ${this.landName(l)} (asking ${money(l.price)}): accept or reject it on the map`);
    return ok(`Offer of ${money(amount)} made for ${this.landName(l)}; ${this.name(l.seller)} decides`);
  }

  /** Buy at the asking price, at once. */
  buy(p: Player, l: Listing): DealResult {
    if (!this.valid(l.id)) return no('That listing has gone');
    if (l.seller === p.id) return no('That is your own listing');
    const r = this.transfer(l, p.id, l.price);
    return r ? no(r) : ok(`Bought ${this.landName(l, true)} for ${money(l.price)}`);
  }

  private accept(p: Player, id: number): DealResult {
    const o = this.offers.get(id);
    if (!o) return no('That offer has gone');
    const l = this.valid(o.listing);
    if (!l) return no('That listing has gone');
    if (l.seller !== p.id) return no('Not your listing');
    const r = this.transfer(l, o.buyer, o.amount);
    if (r) {
      this.offers.delete(o.id); this.changed = true;
      this.tell(o.buyer, `Your offer for ${this.landName(l)} could not go through: ${r}`);
      return no(`The sale to ${this.name(o.buyer)} could not go through: ${r}`);
    }
    return ok(`Sold to ${this.name(o.buyer)} for ${money(o.amount)}`);
  }

  private dropOffer(p: Player, id: number, op: 'reject' | 'withdraw'): DealResult {
    const o = this.offers.get(id);
    if (!o) return no('That offer has gone');
    const l = this.listings.get(o.listing);
    if (op === 'reject' ? l?.seller !== p.id : o.buyer !== p.id) return no(op === 'reject' ? 'Not your listing' : 'Not your offer');
    this.offers.delete(id); this.changed = true;
    if (op === 'reject') { this.tell(o.buyer, `${p.name} rejected your offer of ${money(o.amount)}${l ? ` for ${this.landName(l)}` : ''}`); return ok('Offer rejected'); }
    if (l) this.tell(l.seller, `${p.name} withdrew the offer of ${money(o.amount)} for ${this.landName(l)}`);
    return ok('Offer withdrawn');
  }

  /**
   * Move a listing's parcels to the buyer for `amount`: the rules, then the land (owner, or the landlord of a running
   * lease), the covenants, the money and the notices. Returns the refusal, or null when done.
   */
  transfer(l: Listing, buyerId: string, amount: number): string | null {
    const w = this.w, buyer = w.players.get(buyerId), seller = l.seller;
    if (!buyer) return 'No such buyer';
    if (buyer.admin) return `${buyer.name} is in administration: buying land is stopped`;
    if (w.spendable(buyer) < amount) return w.shortOf(buyer, amount, 'for that land');
    const qs = l.parcels.map((id) => w.parcels.get(id)!);
    for (const q of qs) { const why = this.canTransfer?.(q); if (why) return why; }
    if (!this.sandbox) { const why = this.wallRefusal(buyerId, qs.filter((q) => !this.leaseOn(q.id))); if (why) return why; }
    const whole = qs.length > 1 || (qs[0].group !== undefined && w.estateOf(qs[0].group).length === 1);
    for (const q of qs) {
      const lease = this.leaseOn(q.id);
      if (lease) { lease.landlord = buyerId; this.tell(lease.tenant, `${q.name} was sold: ${buyer.name} is your landlord now, on the same terms`); }
      else {
        if (q.group !== undefined && !whole) w.leaveEstate(q.id, () => true);
        q.owner = buyerId;
        w.recountRoads(q.id);
      }
      if (l.cov) q.cov = joinCovenants(q.cov, l.cov);
      w.dirtyParcels.add(q.id);
    }
    if (amount) { w.credit(buyerId, -amount, 'land'); w.credit(seller, amount, 'landsale'); }
    for (const o of [...this.offers.values()]) if (o.listing === l.id) { this.offers.delete(o.id); if (o.buyer !== buyerId) this.tell(o.buyer, `${this.landName(l)} was sold to someone else`); }
    for (const o of [...this.leaseOffers.values()]) if (l.parcels.includes(o.parcel)) this.leaseOffers.delete(o.id);
    this.listings.delete(l.id);
    this.changed = true;
    this.tell(seller, `Sold ${this.landName(l, true)} to ${buyer.name} for ${money(amount)}`);
    this.tell(buyerId, `${this.landName(l, true)} is yours, with everything on it${l.cov ? `; covenant: ${covenantText(l.cov)}` : ''}`);
    this.onTransfer?.(l.parcels);
    return null;
  }

  /** The purchase rules a sale must keep for the buyer: no walling in; on a market world an outpost at least outpostMin. */
  private wallRefusal(buyer: string, qs: Parcel[]): string | null {
    const w = this.w, done = new Set<number>();
    const owned: LandRect[] = [...w.parcels.values()].filter((q) => q.owner === buyer && !qs.includes(q));
    for (const q of qs) {
      const v = checkPurchase(q, buyer, {
        owned: [...owned, ...qs.filter((m) => done.has(m.id))],
        ownerAt: (x, y) => { if (inRect(q, x, y)) return null; const r = w.parcelAt(x, y); return r ? (done.has(r.id) ? buyer : r.owner) : null; },
        isWater: (x, y) => !isBuildable(w.getTile(x, y)),
        ownerName: (id) => this.name(id),
      }, { outposts: true, outpostMin: this.market ? LAND_TUNING.outpostMin : 0 });
      if (!v.ok) return v.reason.replace('That purchase', 'That sale').replace('A first plot', 'A first plot (bought or sold)');
      done.add(q.id);
    }
    return null;
  }

  /** The listing if its land is as listed and still the seller's; otherwise it is withdrawn (and undefined). */
  private valid(id: number): Listing | undefined {
    const l = this.listings.get(id);
    if (!l) return undefined;
    const qs = l.parcels.map((pid) => this.w.parcels.get(pid));
    if (qs.some((q) => !q) || this.sigOf(qs as Parcel[]) !== l.sig || (qs as Parcel[]).some((q) => this.holder(q) !== l.seller)) {
      this.dropListing(l, 'the land changed (split, merged or passed on)');
      return undefined;
    }
    return l;
  }
  private dropListing(l: Listing, why: string) {
    this.listings.delete(l.id);
    for (const o of [...this.offers.values()]) if (o.listing === l.id) { this.offers.delete(o.id); this.tell(o.buyer, `The listing of ${this.landName(l)} ended (${why}); your offer lapsed`); }
    this.changed = true;
    if (!why.startsWith('the seller')) this.tell(l.seller, `Your listing of ${this.landName(l)} ended: ${why}`);
  }
  private landName(l: ListingDTO, long = false) {
    const q = this.w.parcels.get(l.parcels[0]);
    const n = q?.name ?? 'that land';
    return l.parcels.length > 1 ? `${n} (${l.parcels.length} parcels${long ? ', an estate' : ''})` : n;
  }

  // ---- covenants and strips --------------------------------------------------------------------------------

  /** What on a parcel already breaks a covenant, or null. */
  breach(q: Parcel, cov: Covenant): string | null {
    const w = this.w;
    for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
      const t = w.peekTile(x, y);
      if (t === undefined || isRoad(t) || zoneOf(t) === Zone.None) continue;
      const k = w.kindIdAt(x, y);
      if (covenantRefusal(cov, k)) return `the ${KIND_NAMES[k] ?? 'building'} at (${x}, ${y})${zoneOf(t) !== Zone.None && levelOf(t) === 0 ? ' (zoned)' : ''}`;
      if (!covenantAllowsLevel(cov, levelOf(t))) return `the level ${levelOf(t)} ${KIND_NAMES[k] ?? 'building'} at (${x}, ${y})`;
    }
    return null;
  }
  /** Why `kind` may not be built or zoned on tile (x, y): a covenant on its parcel, or a pact's strip. Null: allowed. */
  buildRefusal(x: number, y: number, kind: number): string | null {
    const q = this.w.parcelAt(x, y);
    const c = covenantRefusal(q?.cov, kind);
    if (c) return c;
    if (this.pacts.size && isHeavyNuisanceKind(kind)) for (const p of this.pacts.values()) if (p.state === 'active' && inRect(p.strip, x, y)) return stripRefusal(kind);
    return null;
  }
  /** The same for a placed structure's footprint. */
  placeRefusal(pl: Placed): string | null {
    const r: Rect = { x: pl.ax, y: pl.ay, w: pl.w, h: pl.h };
    const seen = new Set<number>();
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const q = this.w.parcelAt(x, y);
      if (!q || seen.has(q.id)) continue;
      seen.add(q.id);
      const c = covenantRefusal(q.cov, pl.kind);
      if (c) return c;
    }
    if (this.pacts.size && isHeavyNuisanceKind(pl.kind)) for (const p of this.pacts.values()) if (p.state === 'active' && rectsOverlap(p.strip, r)) return stripRefusal(pl.kind);
    return null;
  }
  /** The growth gate: a covenant's level cap (game.ts chains it before the power gate). */
  mayGrow(b: Building, target: number): boolean {
    const q = this.w.parcelAt(b.x, b.y);
    return !q?.cov || covenantAllowsLevel(q.cov, target);
  }

  // ---- leases -------------------------------------------------------------------------------------------

  private offerLease(p: Player, id: number, rent: number, days: number, tenant?: string): DealResult {
    const w = this.w, q = w.parcels.get(id), T = LAND_DEALS;
    if (!q) return no('That parcel no longer exists');
    if (this.holder(q) !== p.id) return no('Not your land to lease');
    if (this.leaseOn(id)) return no('That parcel is leased already');
    if (!(Number.isFinite(rent) && rent >= 0 && rent <= T.maxPrice)) return no('Give a rent a day');
    if (!(days >= T.leaseMinDays && days <= T.leaseMaxDays)) return no(`A lease runs ${T.leaseMinDays}-${T.leaseMaxDays} days`);
    if (this.openCount(p.id) >= T.maxOpen) return no(`At most ${T.maxOpen} listings, lease offers and pact proposals at a time`);
    const why = this.canTransfer?.(q);
    if (why) return no(why);
    let to: string | undefined;
    if (tenant && tenant.trim()) {
      const t = tenant.trim().toLowerCase();
      to = [...w.players.values()].find((pl) => pl.id === tenant.trim() || pl.name.toLowerCase() === t)?.id;
      if (!to) return no(`No player called ${tenant.trim()}`);
      if (to === p.id) return no('You cannot lease your own land to yourself');
    }
    for (const o of [...this.leaseOffers.values()]) if (o.parcel === id) this.leaseOffers.delete(o.id); // the latest offer stands
    const o: LeaseOfferDTO = { id: this.next++, parcel: id, landlord: p.id, rent: Math.round(rent * 100) / 100, days, ...(to ? { tenant: to } : {}), expires: w.day + T.offerDays };
    this.leaseOffers.set(o.id, o);
    this.changed = true;
    if (to) this.tell(to, `${p.name} offers you a lease on ${q.name}: ${money(o.rent)} a day for ${plural(days, 'day')}`);
    return ok(`${q.name} offered for lease at ${money(o.rent)} a day for ${plural(days, 'day')}${to ? ` to ${this.name(to)}` : ''}`);
  }

  private acceptLease(p: Player, id: number): DealResult {
    const w = this.w, o = this.leaseOffers.get(id);
    if (!o) return no('That lease offer has gone');
    const q = w.parcels.get(o.parcel);
    if (!q || q.owner !== o.landlord || this.leaseOn(q.id)) { this.leaseOffers.delete(id); this.changed = true; return no('That land is no longer on offer'); }
    if (o.tenant && o.tenant !== p.id) return no('That lease is offered to someone else');
    if (o.landlord === p.id) return no('That is your own land');
    if (p.admin) return no('In administration: taking on a lease is stopped');
    if (w.spendable(p) < o.rent) return no(w.shortOf(p, o.rent, 'for the first day\'s rent'));
    const why = this.canTransfer?.(q);
    if (why) return no(why);
    this.leaseOffers.delete(id);
    if (q.group !== undefined) w.leaveEstate(q.id, () => true);
    const l: LeaseDTO = { id: this.next++, parcel: q.id, landlord: o.landlord, tenant: p.id, rent: o.rent, start: w.day, end: w.day + o.days };
    this.leases.set(l.id, l);
    q.owner = p.id;
    w.recountRoads(q.id);
    w.dirtyParcels.add(q.id);
    this.changed = true;
    this.tell(o.landlord, `${p.name} took the lease on ${q.name}: ${money(l.rent)} a day until day ${l.end}`);
    this.onTransfer?.([q.id]);
    return ok(`${q.name} is yours to build on until day ${l.end}, at ${money(l.rent)} a day`);
  }

  private cancelLease(p: Player, id: number): DealResult {
    const o = this.leaseOffers.get(id);
    if (!o) return no('That lease offer has gone');
    if (o.landlord !== p.id && o.tenant !== p.id) return no('Not your lease offer');
    this.leaseOffers.delete(id); this.changed = true;
    if (o.tenant === p.id) this.tell(o.landlord, `${p.name} declined your lease offer`);
    return ok('Lease offer withdrawn');
  }

  /** The land goes back to the landlord, with whatever is on it. */
  private endLease(l: LeaseDTO, why: string) {
    const w = this.w, q = w.parcels.get(l.parcel);
    this.leases.delete(l.id);
    this.changed = true;
    if (!q) return;
    if (q.group !== undefined) w.leaveEstate(q.id, () => true);
    q.owner = l.landlord;
    w.recountRoads(q.id);
    w.dirtyParcels.add(q.id);
    this.tell(l.tenant, `Your lease on ${q.name} ended (${why}): the land and what is on it go back to ${this.name(l.landlord)}`);
    this.tell(l.landlord, `The lease on ${q.name} ended (${why}): the land is yours again, with what ${this.name(l.tenant)} built on it`);
    this.onTransfer?.([q.id]);
  }

  // ---- pacts --------------------------------------------------------------------------------------------

  private proposePact(p: Player, pa: number, pb: number, strip: Rect): DealResult {
    const w = this.w, qa = w.parcels.get(pa), qb = w.parcels.get(pb);
    if (!qa || !qb) return no('That parcel no longer exists');
    if (this.holder(qa) !== p.id) return no('Propose a pact from your own parcel');
    const other = this.holder(qb);
    if (other === p.id) return no('A pact is between two neighbours: that parcel is yours');
    if (!edgeAdjacent(qa, qb)) return no('A pact is between parcels that share an edge');
    const s = { x: Math.floor(Number(strip?.x)), y: Math.floor(Number(strip?.y)), w: Math.floor(Number(strip?.w)), h: Math.floor(Number(strip?.h)) };
    if (![s.x, s.y, s.w, s.h].every(Number.isFinite) || s.w < 1 || s.h < 1 || s.w > 96 || s.h > 96) return no('Mark the buffer strip');
    for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) {
      if (!inRect(qa, x, y) && !inRect(qb, x, y)) return no('The buffer strip must lie on the two parcels');
      const t = w.peekTile(x, y);
      if (t !== undefined && !isRoad(t) && zoneOf(t) !== Zone.None && isHeavyNuisanceKind(w.kindIdAt(x, y))) return no(`The strip already has ${KIND_NAMES[w.kindIdAt(x, y)]} at (${x}, ${y})`);
    }
    if (this.openCount(p.id) >= LAND_DEALS.maxOpen) return no(`At most ${LAND_DEALS.maxOpen} listings, lease offers and pact proposals at a time`);
    const pact: PactDTO = { id: this.next++, a: p.id, b: other, pa, pb, strip: s, state: 'proposed', day: w.day };
    this.pacts.set(pact.id, pact);
    this.changed = true;
    this.tell(other, `${p.name} proposes a neighbour pact: a ${s.w}×${s.h} buffer strip between ${qa.name} and ${qb.name} kept free of heavy nuisance. Accept it on the map`);
    return ok(`Pact proposed to ${this.name(other)}`);
  }

  private acceptPact(p: Player, id: number): DealResult {
    const pact = this.pacts.get(id), w = this.w;
    if (!pact || pact.state !== 'proposed') return no('That proposal has gone');
    const qb = w.parcels.get(pact.pb), qa = w.parcels.get(pact.pa);
    if (!qa || !qb) { this.pacts.delete(id); this.changed = true; return no('That land has changed'); }
    if (this.holder(qb) !== p.id) return no('That pact is not yours to accept');
    pact.state = 'active'; pact.day = w.day;
    this.changed = true;
    this.tell(this.holder(qa), `${p.name} accepted the neighbour pact: the strip between ${qa.name} and ${qb.name} stays free of heavy nuisance`);
    return ok('Pact agreed');
  }

  private endPact(p: Player, id: number): DealResult {
    const pact = this.pacts.get(id), w = this.w;
    if (!pact) return no('That pact has gone');
    const qa = w.parcels.get(pact.pa), qb = w.parcels.get(pact.pb);
    const a = qa ? this.holder(qa) : pact.a, b = qb ? this.holder(qb) : pact.b;
    if (p.id !== a && p.id !== b) return no('Not your pact');
    const other = p.id === a ? b : a;
    if (pact.state === 'proposed') { this.pacts.delete(id); this.changed = true; this.tell(other, `${p.name} ${p.id === pact.a ? 'withdrew' : 'declined'} the neighbour pact`); return ok('Pact proposal dropped'); }
    if (pact.ends !== undefined) return no(`Notice is given already: the pact ends on day ${pact.ends}`);
    pact.ends = w.day + LAND_DEALS.pactNoticeDays;
    this.changed = true;
    this.tell(other, `${p.name} gave notice on your neighbour pact: it ends on day ${pact.ends}`);
    return ok(`Notice given: the pact ends on day ${pact.ends}`);
  }

  // ---- time ---------------------------------------------------------------------------------------------

  /** After every simulation tick (game.ts). */
  tick() {
    if (this.w.tick % 25 === 0) for (const id of [...this.listings.keys()]) this.valid(id);
    if (this.w.day === this.day) return;
    this.day = this.w.day;
    this.midnight();
  }

  /** Rent, lease ends, lapsed listings, offers and proposals, pacts at the end of their notice. Public for checks. */
  midnight() {
    const w = this.w, day = w.day;
    for (const l of [...this.leases.values()]) {
      const tenant = w.players.get(l.tenant);
      if (!w.parcels.has(l.parcel)) { this.leases.delete(l.id); this.changed = true; continue; }
      if (!tenant || tenant.admin) { this.endLease(l, 'the rent was missed: the tenant is in administration'); continue; }
      if (l.rent > 0) { w.credit(l.tenant, -l.rent, 'rent'); w.credit(l.landlord, l.rent, 'rent'); }
      if (day >= l.end) this.endLease(l, 'the term is over');
    }
    for (const l of [...this.listings.values()]) if (this.valid(l.id) && day >= l.expires) this.dropListing(l, `it lapsed after ${LAND_DEALS.listingDays} days`);
    for (const o of [...this.leaseOffers.values()]) if (day >= o.expires || !w.parcels.has(o.parcel)) { this.leaseOffers.delete(o.id); this.changed = true; }
    for (const p of [...this.pacts.values()]) {
      const gone = !w.parcels.has(p.pa) || !w.parcels.has(p.pb);
      if (gone || (p.state === 'proposed' && day >= p.day + LAND_DEALS.offerDays)) { this.pacts.delete(p.id); this.changed = true; continue; }
      if (p.ends !== undefined && day >= p.ends) {
        this.pacts.delete(p.id); this.changed = true;
        const qa = w.parcels.get(p.pa)!, qb = w.parcels.get(p.pb)!;
        for (const o of new Set([this.holder(qa), this.holder(qb)])) this.tell(o, `The neighbour pact between ${qa.name} and ${qb.name} has ended`);
      }
    }
  }

  // ---- saving -------------------------------------------------------------------------------------------

  save(): LandDealsSave | null {
    if (!this.listings.size && !this.offers.size && !this.leaseOffers.size && !this.leases.size && !this.pacts.size) return null;
    const v = this.view('');
    return { next: this.next, ...v, listings: [...this.listings.values()].map((l) => ({ ...l, parcels: [...l.parcels] })), offers: [...this.offers.values()].map((o) => ({ ...o })), pacts: [...this.pacts.values()].map((p) => ({ ...p, strip: { ...p.strip } })) };
  }
  private load(s: LandDealsSave) {
    const arr = <T>(a: unknown): T[] => (Array.isArray(a) ? (a as T[]).filter((x) => x && typeof x === 'object') : []);
    for (const l of arr<Listing>(s.listings)) if (Array.isArray(l.parcels)) this.listings.set(l.id, { ...l, sig: typeof l.sig === 'string' ? l.sig : '' });
    for (const o of arr<OfferDTO>(s.offers)) this.offers.set(o.id, { ...o });
    for (const o of arr<LeaseOfferDTO>(s.leaseOffers)) this.leaseOffers.set(o.id, { ...o });
    for (const l of arr<LeaseDTO>(s.leases)) this.leases.set(l.id, { ...l });
    for (const p of arr<PactDTO>(s.pacts)) if (p.strip) this.pacts.set(p.id, { ...p, strip: { ...p.strip } });
    const ids = [...this.listings.keys(), ...this.offers.keys(), ...this.leaseOffers.keys(), ...this.leases.keys(), ...this.pacts.keys()];
    this.next = Math.max(Number(s.next) || 1, 1 + Math.max(0, ...ids));
  }
}
