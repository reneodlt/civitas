import { CONTRACTS, SERVICE_IDS, SERVICE_NAMES, priceText, type ServicesView, type ServiceQuote, type ServiceContractDTO, type ServiceId, type ParcelDTO, type ClientMsg } from '@msimcity/shared';
import type { ClientWorld } from './world';

/**
 * Service contracts on the world map (docs/multiplayer-land.md M8; the server's rules in server/src/sim/contracts.ts):
 * the parcel panel's Services block (the providers that reach the land with their price against the regional one, Sign,
 * the contracts running there with Give notice, and on your own land your posted tariffs) and the running contracts in
 * the market box. MapMode owns the panel and calls these; actions are `data-sv` buttons it hands to `act`. Form fields
 * have `mk` ids so the panel's redraw keeps what was typed.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-GB')}`;
export const emptyServices = (): ServicesView => ({ tariffs: [], contracts: [], regional: { refuse: 0, power: 0 } });
/** ask the server again for a parcel's quotes after this long (ms) */
const QUOTE_MS = 5000;

export class ServicesPanel {
  view = emptyServices();
  private quotes = new Map<number, { at: number; q: ServiceQuote[] }>();
  private asked = new Map<number, number>();
  constructor(private w: ClientWorld) {}

  private name(id: string) { return this.w.players.get(id)?.name ?? id; }
  private mine(id: string) { return !this.w.spectate && id === this.w.me; }
  /** A `services` message: tariffs or contracts changed, so the quotes are asked for again. */
  setView(v: ServicesView) { this.view = v; this.asked.clear(); }
  setQuotes(id: number, q: ServiceQuote[]) { this.quotes.set(id, { at: performance.now(), q }); }
  /** The quote request for parcel `id` when the last answer is stale (MapMode sends it on selecting a parcel). */
  quoteFor(id: number): ClientMsg | null {
    if (this.w.spectate) return null;
    const now = performance.now();
    if (now - (this.asked.get(id) ?? -Infinity) < QUOTE_MS) return null;
    this.asked.set(id, now);
    return { t: 'svc', op: 'quote', id };
  }
  private row(c: ServiceContractDTO, party: boolean) {
    const me = this.w.me, other = c.provider === me ? `to ${esc(this.name(c.buyer))}` : `from ${esc(this.name(c.provider))}`;
    const until = c.ends !== undefined ? `ends day ${c.ends} (notice)` : `until day ${c.end}`;
    const btn = party && !this.w.spectate && c.ends === undefined ? ` <button class="chip" data-sv="notice" data-id="${c.id}" title="The contract ends ${CONTRACTS.noticeDays} days after notice; the service runs until then">Give notice</button>` : '';
    return `<div class="mkrow"><b>${SERVICE_NAMES[c.service]}</b> ${other}, ${esc(priceText(c.service, c.price))} · ${until} · paid ${money(c.paid)}${btn}</div>`;
  }

  /** The parcel panel's Services block. */
  parcelHtml(p: ParcelDTO): string {
    const v = this.view, me = this.w.me, mine = this.mine(p.owner);
    const rows: string[] = [];
    const here = v.contracts.filter((c) => c.parcels.includes(p.id));
    for (const c of here) rows.push(this.row(c, c.buyer === me || c.provider === me));
    if (mine) {
      const q = this.quotes.get(p.id)?.q ?? [];
      const est = p.group !== undefined && [...this.w.parcels.values()].filter((x) => x.group === p.group).length > 1;
      let offers = 0;
      for (const s of SERVICE_IDS) {
        if (here.some((c) => c.service === s)) continue;
        const list = q.filter((x) => x.service === s);
        if (!list.length) continue;
        rows.push(`<div class="hint">${SERVICE_NAMES[s]}: the regional supplier charges ${esc(priceText(s, v.regional[s]))}</div>`);
        for (const x of list) {
          const save = v.regional[s] > 0 ? Math.round((1 - x.price / v.regional[s]) * 100) : 0;
          rows.push(`<div class="mkrow">${esc(this.name(x.provider))} ${esc(priceText(s, x.price))}${save > 0 ? ` (${save}% under)` : ''} ${x.reach
            ? `<button class="chip" data-sv="sign" data-id="${p.id}" data-s="${s}" data-p="${esc(x.provider)}">Sign</button>` : `<span class="hint">${esc(x.why ?? 'out of reach')}</span>`}</div>`);
          if (x.reach) offers++;
        }
      }
      if (offers) rows.push(`<label>Term (days) <input type="number" id="mkSvDays" min="${CONTRACTS.minDays}" max="${CONTRACTS.maxDays}" value="10"></label>${est ? '<label class="mkchk"><input type="checkbox" id="mkSvEstate" checked> the whole estate</label>' : ''}
        <div class="hint">The price is fixed for the term; either side may leave with ${CONTRACTS.noticeDays} days' notice. The provider's network or lorries use your streets for that service only.</div>`);
      // your own tariffs, shown to every neighbour
      rows.push(`<details class="mkform" id="mkSvTariffs"><summary>Your tariffs…</summary>${SERVICE_IDS.map((s) => {
        const t = v.tariffs.find((x) => x.owner === me && x.service === s);
        return `<label>${SERVICE_NAMES[s]}, $ ${s === 'refuse' ? 'a home a day' : 'a unit'} (at most ${v.regional[s].toFixed(3)})
          <input type="number" id="mkSv_${s}" min="0" max="${v.regional[s]}" step="0.001" value="${t ? t.price : (v.regional[s] * 0.9).toFixed(3)}"></label>
          <div class="mbtns"><button class="chip" data-sv="tariff" data-s="${s}">${t ? 'Change' : 'Post'}</button>${t ? ` <button class="chip" data-sv="untariff" data-s="${s}">Withdraw</button>` : ''}</div>`;
      }).join('')}<div class="hint">Neighbours in reach of your refuse sites or substations may sign up at your price. Running contracts keep the price they were signed at.</div></details>`);
    } else {
      const theirs = v.tariffs.filter((t) => t.owner === p.owner);
      if (theirs.length) rows.push(`<div class="mkrow"><b>${esc(this.name(p.owner))}'s tariffs</b> ${theirs.map((t) => `${SERVICE_NAMES[t.service].toLowerCase()} ${esc(priceText(t.service, t.price))}`).join(' · ')}</div>`);
    }
    if (!rows.length) return '';
    return `<div class="mkblock"><h3>Services</h3>${rows.join('')}</div>`;
  }

  /** The market box's running contracts (as buyer and provider). */
  boxHtml(): string {
    const list = this.view.contracts;
    if (!list.length) return '';
    return `<h3>Service contracts</h3>${list.map((c) => this.row(c, true)).join('')}`;
  }

  /** A `data-sv` button: the intent to send (or null), reading the form fields from `root`. */
  act(b: HTMLElement, root: HTMLElement): ClientMsg | null {
    const val = (q: string) => (root.querySelector(q) as HTMLInputElement | null)?.value ?? '';
    const s = b.dataset.s as ServiceId;
    switch (b.dataset.sv) {
      case 'sign': {
        const estate = (root.querySelector('#mkSvEstate') as HTMLInputElement | null)?.checked === true;
        return { t: 'svc', op: 'sign', id: Number(b.dataset.id), service: s, provider: b.dataset.p ?? '', days: Math.round(Number(val('#mkSvDays')) || 10), ...(estate ? { estate } : {}) };
      }
      case 'notice': return { t: 'svc', op: 'notice', contract: Number(b.dataset.id) };
      case 'tariff': return { t: 'svc', op: 'tariff', service: s, price: Number(val(`#mkSv_${s}`)) };
      case 'untariff': return { t: 'svc', op: 'tariff', service: s, price: null };
    }
    return null;
  }
}
