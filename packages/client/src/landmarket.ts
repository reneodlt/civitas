import { LAND_DEALS, covenantText, edgeAdjacent, type DealsView, type ListingDTO, type ParcelDTO, type PactDTO, type LeaseDTO, type Rect, type ClientMsg } from '@msimcity/shared';
import type { ClientWorld } from './world';
import type { MapMark } from './render/worldmap';

/**
 * The land market on the world map (docs/multiplayer-land.md M7; the server's rules in server/src/sim/landdeals.ts):
 * the parcel panel's market block (list with covenants, buy, offer, accept or reject, lease, pacts), the "For sale"
 * layer (listed land tinted by its price a tile) and the market box with the listings and the player's open deals.
 * MapMode owns the panel and calls these; actions are `data-mk` buttons it hands to `act`.
 */
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-GB');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const emptyDeals = (): DealsView => ({ listings: [], offers: [], leaseOffers: [], leases: [], pacts: [] });

/** Price-a-tile bands of the For sale layer: [below this $ a tile, colour]. */
export const SALE_BANDS: [number, number, string][] = [[2, 0x62d2a2, 'under $2'], [5, 0xf6d55c, '$2-5'], [15, 0xf9a03f, '$5-15'], [Infinity, 0xe8505b, 'over $15']];

export class LandMarketView {
  deals = emptyDeals();
  /** the For sale layer is shown */
  layer = false;
  constructor(private w: ClientWorld) {}

  private name(id: string) { return this.w.players.get(id)?.name ?? id; }
  leaseOn(id: number): LeaseDTO | undefined { return this.deals.leases.find((l) => l.parcel === id); }
  holder(p: ParcelDTO) { return this.leaseOn(p.id)?.landlord ?? p.owner; }
  listingOf(id: number): ListingDTO | undefined { return this.deals.listings.find((l) => l.parcels.includes(id)); }
  private area(l: ListingDTO) { let a = 0; for (const id of l.parcels) { const q = this.w.parcels.get(id); if (q) a += q.w * q.h; } return a; }
  private landName(l: ListingDTO) { const q = this.w.parcels.get(l.parcels[0]); return `${q?.name ?? 'land'}${l.parcels.length > 1 ? ` (${l.parcels.length} parcels)` : ''}`; }
  private mine(id: string) { return !this.w.spectate && id === this.w.me; }

  /** The For sale layer's marks: listed land tinted by its asking price a tile. */
  marks(): MapMark[] {
    if (!this.layer) return [];
    const bands = SALE_BANDS.map(([, c]) => ({ rects: [] as Rect[], fill: c, fillA: 0.45, line: c, px: 2 }));
    for (const l of this.deals.listings) {
      const per = l.price / Math.max(1, this.area(l));
      const i = SALE_BANDS.findIndex(([lim]) => per < lim);
      for (const id of l.parcels) { const q = this.w.parcels.get(id); if (q) bands[i].rects.push(q); }
    }
    return bands.filter((b) => b.rects.length);
  }
  /** A few words for the map's hover line. */
  hoverNote(p: ParcelDTO): string {
    const l = this.listingOf(p.id), lease = this.leaseOn(p.id);
    return [l ? `for sale ${money(l.price)}` : '', lease ? `leased to ${this.name(lease.tenant)}` : '', p.cov ? `covenant: ${covenantText(p.cov)}` : ''].filter(Boolean).join(' · ');
  }

  /** The parcel panel's market block for one parcel. */
  parcelHtml(p: ParcelDTO): string {
    const d = this.deals, me = this.w.me, holder = this.holder(p), mine = this.mine(holder);
    const lease = this.leaseOn(p.id), l = this.listingOf(p.id);
    const rows: string[] = [];
    if (p.cov) rows.push(`<div class="mkrow"><b>Covenant</b> ${esc(covenantText(p.cov))}</div>`);
    if (lease) rows.push(`<div class="mkrow"><b>Leased</b> by ${esc(this.name(lease.landlord))} to ${esc(this.name(lease.tenant))}, ${money(lease.rent)} a day until day ${lease.end}</div>`);
    for (const pc of d.pacts.filter((x) => x.pa === p.id || x.pb === p.id)) rows.push(this.pactRow(pc));
    if (l) {
      rows.push(`<div class="mkrow"><b>For sale</b> ${money(l.price)}${l.parcels.length > 1 ? ` with ${l.parcels.length - 1} more parcels` : ''} · until day ${l.expires}${l.cov ? ` · covenant: ${esc(covenantText(l.cov))}` : ''}</div>`);
      if (l.seller === me) {
        const offers = d.offers.filter((o) => o.listing === l.id);
        rows.push(offers.map((o) => `<div class="mkrow">${esc(this.name(o.buyer))} offers <b>${money(o.amount)}</b> <button class="chip" data-mk="accept" data-id="${o.id}">Accept</button> <button class="chip" data-mk="reject" data-id="${o.id}">Reject</button></div>`).join('') || '<div class="hint">No offers yet.</div>');
        rows.push(`<div class="mbtns"><button class="chip" data-mk="unlist" data-id="${l.id}">Withdraw listing</button></div>`);
      } else if (!this.w.spectate) {
        const my = d.offers.find((o) => o.listing === l.id && o.buyer === me);
        rows.push(`<div class="mbtns"><button class="chip" data-mk="buy" data-id="${l.id}">Buy for ${money(l.price)}</button>
          <input type="number" id="mkOffer" min="1" step="10" placeholder="offer $" value="${my ? my.amount : Math.round(l.price * 0.8)}"><button class="chip" data-mk="offer" data-id="${l.id}">Offer</button>
          ${my ? `<button class="chip" data-mk="withdraw" data-id="${my.id}" title="Your offer of ${money(my.amount)}">Withdraw offer</button>` : ''}</div>`);
      }
    } else if (mine) {
      const est = p.group !== undefined && [...this.w.parcels.values()].filter((q) => q.group === p.group).length > 1;
      const value = p.stats.value ?? 0;
      rows.push(`<details class="mkform" id="mkSell"><summary>Sell…</summary>
        <label>Asking price <input type="number" id="mkPrice" min="0" step="10" value="${Math.max(10, Math.round(value))}"></label>
        ${est ? '<label class="mkchk"><input type="checkbox" id="mkEstate" checked> the whole estate</label>' : ''}
        <div class="hint">Covenants bind every later owner:</div>
        <label class="mkchk"><input type="checkbox" id="mkNoHeavy"> no heavy industry</label>
        <label class="mkchk"><input type="checkbox" id="mkPark"> stays a park</label>
        <label class="mkchk">no building over <select id="mkMaxLevel"><option value="0">any</option>${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n}</option>`).join('')}</select> levels</label>
        <div class="mbtns"><button class="chip" data-mk="list" data-id="${p.id}">List for sale (${LAND_DEALS.listingDays} days)</button></div>
        <div class="hint">Split first to sell a piece. Anyone may buy at the asking price at once or make an offer; you accept or reject.</div>
      </details>`);
    }
    // leases on offer for this parcel
    for (const o of d.leaseOffers.filter((x) => x.parcel === p.id)) {
      const forMe = !o.tenant || o.tenant === me;
      rows.push(`<div class="mkrow"><b>Lease on offer</b> ${money(o.rent)} a day for ${o.days} days${o.tenant ? ` to ${esc(this.name(o.tenant))}` : ''}
        ${o.landlord === me ? `<button class="chip" data-mk="leaseCancel" data-id="${o.id}">Withdraw</button>` : forMe && !this.w.spectate ? `<button class="chip" data-mk="leaseAccept" data-id="${o.id}">Take the lease</button>` : ''}</div>`);
    }
    if (mine && !lease && !d.leaseOffers.some((x) => x.parcel === p.id)) {
      rows.push(`<details class="mkform" id="mkLease"><summary>Lease out…</summary>
        <label>Rent a day <input type="number" id="mkRent" min="0" step="1" value="${Math.max(1, Math.round((p.stats.value ?? 0) / 200))}"></label>
        <label>Term (days) <input type="number" id="mkDays" min="${LAND_DEALS.leaseMinDays}" max="${LAND_DEALS.leaseMaxDays}" value="10"></label>
        <label>Tenant (a name; empty: anyone) <input type="text" id="mkTenant" maxlength="24"></label>
        <div class="mbtns"><button class="chip" data-mk="lease" data-id="${p.id}">Offer lease</button></div>
        <div class="hint">The tenant builds and collects as owner and pays the rent each midnight. At the end the land comes back with what is on it; a tenant in administration misses the rent and the lease ends.</div>
      </details>`);
    }
    if (!rows.length) return '';
    return `<div class="mkblock"><h3>Land market</h3>${rows.join('')}</div>`;
  }
  private pactRow(pc: PactDTO) {
    const me = this.w.me, s = pc.strip, other = pc.a === me ? pc.b : pc.a;
    const party = pc.a === me || pc.b === me;
    const btn = !party || this.w.spectate ? ''
      : pc.state === 'proposed' ? (pc.b === me ? `<button class="chip" data-mk="pactAccept" data-id="${pc.id}">Accept</button> <button class="chip" data-mk="pactEnd" data-id="${pc.id}">Decline</button>` : `<button class="chip" data-mk="pactEnd" data-id="${pc.id}">Withdraw</button>`)
      : pc.ends === undefined ? `<button class="chip" data-mk="pactEnd" data-id="${pc.id}" title="The pact ends ${LAND_DEALS.pactNoticeDays} days after notice">Give notice</button>` : '';
    return `<div class="mkrow"><b>Pact</b> ${party ? `with ${esc(this.name(other))}` : `${esc(this.name(pc.a))} and ${esc(this.name(pc.b))}`}: a ${s.w}×${s.h} buffer strip at (${s.x}, ${s.y}), no heavy nuisance · ${pc.state === 'proposed' ? 'proposed' : pc.ends !== undefined ? `ends day ${pc.ends}` : 'in force'} ${btn}</div>`;
  }

  /** Two parcels picked, one yours and a neighbour's: the strip along the shared edge, `d` tiles into each. */
  stripFor(a: ParcelDTO, b: ParcelDTO, d: number): Rect | null {
    if (!edgeAdjacent(a, b)) return null;
    if (a.x + a.w === b.x || b.x + b.w === a.x) {
      const edge = a.x + a.w === b.x ? b.x : a.x, y0 = Math.max(a.y, b.y), y1 = Math.min(a.y + a.h, b.y + b.h);
      return { x: edge - d, y: y0, w: 2 * d, h: y1 - y0 };
    }
    const edge = a.y + a.h === b.y ? b.y : a.y, x0 = Math.max(a.x, b.x), x1 = Math.min(a.x + a.w, b.x + b.w);
    return { x: x0, y: edge - d, w: x1 - x0, h: 2 * d };
  }
  /** The two-parcel panel's pact block (one parcel yours, the other a neighbour's). */
  pactHtml(sel: ParcelDTO[], d: number): string {
    if (sel.length !== 2 || this.w.spectate) return '';
    const [a, b] = this.mine(this.holder(sel[0])) ? sel : [sel[1], sel[0]];
    if (!this.mine(this.holder(a)) || this.mine(this.holder(b))) return '';
    const s = this.stripFor(a, b, d);
    if (!s) return '<div class="hint">A neighbour pact is between parcels that share an edge.</div>';
    return `<div class="mkblock"><h3>Neighbour pact</h3>
      <div class="hint">A buffer strip along your shared edge with ${esc(this.name(this.holder(b)))}, kept free of heavy nuisance (industry, tips, polluting plants) by both of you. No money; either may end it with ${LAND_DEALS.pactNoticeDays} days' notice.</div>
      <label>Tiles each side <input type="number" id="mkStrip" min="1" max="8" value="${d}"></label>
      <div class="mbtns"><button class="chip" data-mk="pact" data-a="${a.id}" data-b="${b.id}">Propose a ${s.w}×${s.h} strip</button></div></div>`;
  }

  /** The market box: the For sale layer's toggle and legend, the listings, and this player's open deals. */
  boxHtml(): string {
    const d = this.deals, me = this.w.me;
    const mineOpen: string[] = [];
    for (const o of d.offers) {
      const l = d.listings.find((x) => x.id === o.listing);
      if (!l) continue;
      if (l.seller === me) mineOpen.push(`<div class="mkrow"><a data-mk="go" data-id="${l.parcels[0]}">${esc(this.landName(l))}</a>: ${esc(this.name(o.buyer))} offers ${money(o.amount)} <button class="chip" data-mk="accept" data-id="${o.id}">Accept</button> <button class="chip" data-mk="reject" data-id="${o.id}">Reject</button></div>`);
      else if (o.buyer === me) mineOpen.push(`<div class="mkrow">Your offer ${money(o.amount)} for <a data-mk="go" data-id="${l.parcels[0]}">${esc(this.landName(l))}</a> <button class="chip" data-mk="withdraw" data-id="${o.id}">Withdraw</button></div>`);
    }
    for (const o of d.leaseOffers) if (o.tenant === me) mineOpen.push(`<div class="mkrow">Lease of <a data-mk="go" data-id="${o.parcel}">${esc(this.w.parcels.get(o.parcel)?.name ?? 'land')}</a> from ${esc(this.name(o.landlord))}: ${money(o.rent)} a day for ${o.days} days <button class="chip" data-mk="leaseAccept" data-id="${o.id}">Take</button> <button class="chip" data-mk="leaseCancel" data-id="${o.id}">Decline</button></div>`);
    for (const pc of d.pacts) if (pc.state === 'proposed' && pc.b === me) mineOpen.push(`<div class="mkrow">${esc(this.name(pc.a))} proposes a pact by <a data-mk="go" data-id="${pc.pb}">${esc(this.w.parcels.get(pc.pb)?.name ?? 'your land')}</a> <button class="chip" data-mk="pactAccept" data-id="${pc.id}">Accept</button> <button class="chip" data-mk="pactEnd" data-id="${pc.id}">Decline</button></div>`);
    const list = this.layer ? d.listings.slice().sort((a, b) => a.price / this.area(a) - b.price / this.area(b)).slice(0, 30).map((l) =>
      `<div class="mkrow"><a data-mk="go" data-id="${l.parcels[0]}">${esc(this.landName(l))}</a> ${money(l.price)} · ${money(l.price / Math.max(1, this.area(l)))}/tile · ${esc(this.name(l.seller))}${l.cov ? ' · covenant' : ''}</div>`).join('') || '<div class="hint">Nothing for sale.</div>' : '';
    const legend = this.layer ? `<div class="mklegend">${SALE_BANDS.map(([, c, t]) => `<span><i style="background:#${c.toString(16).padStart(6, '0')}"></i>${t}/tile</span>`).join('')}</div>` : '';
    return `<button class="chip${this.layer ? ' on' : ''}" data-mk="layer">For sale (${d.listings.length})</button>${legend}${list}${mineOpen.length ? `<h3>Your deals</h3>${mineOpen.join('')}` : ''}`;
  }

  /** A `data-mk` button: the intent to send (or null), reading the form fields from `root`. */
  act(b: HTMLElement, root: HTMLElement): ClientMsg | null {
    const id = Number(b.dataset.id), val = (q: string) => (root.querySelector(q) as HTMLInputElement | null)?.value ?? '';
    const on = (q: string) => !!(root.querySelector(q) as HTMLInputElement | null)?.checked;
    switch (b.dataset.mk) {
      case 'list': {
        const max = Number(val('#mkMaxLevel'));
        const cov = { ...(on('#mkNoHeavy') ? { noHeavy: 1 as const } : {}), ...(on('#mkPark') ? { park: 1 as const } : {}), ...(max > 0 ? { maxLevel: max } : {}) };
        return { t: 'land', op: 'list', id, price: Number(val('#mkPrice')), estate: on('#mkEstate'), ...(Object.keys(cov).length ? { cov } : {}) };
      }
      case 'unlist': return { t: 'land', op: 'unlist', listing: id };
      case 'buy': return { t: 'land', op: 'buy', listing: id };
      case 'offer': return { t: 'land', op: 'offer', listing: id, amount: Number(val('#mkOffer')) };
      case 'accept': case 'reject': case 'withdraw': return { t: 'land', op: b.dataset.mk, offer: id };
      case 'lease': return { t: 'land', op: 'lease', id, rent: Number(val('#mkRent')), days: Number(val('#mkDays')), ...(val('#mkTenant').trim() ? { tenant: val('#mkTenant').trim() } : {}) };
      case 'leaseAccept': case 'leaseCancel': return { t: 'land', op: b.dataset.mk, lease: id };
      case 'pactAccept': case 'pactEnd': return { t: 'land', op: b.dataset.mk, pact: id };
      case 'pact': {
        const a = this.w.parcels.get(Number(b.dataset.a)), c = this.w.parcels.get(Number(b.dataset.b));
        const s = a && c && this.stripFor(a, c, Math.max(1, Math.min(8, Number(val('#mkStrip')) || 2)));
        return s ? { t: 'land', op: 'pact', pa: a!.id, pb: c!.id, strip: s } : null;
      }
    }
    return null;
  }
}
