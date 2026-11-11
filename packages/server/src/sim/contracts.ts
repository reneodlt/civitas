import {
  CONTRACTS, SERVICE_IDS, SERVICE_NAMES, REFUSE, TICKS_PER_HOUR, Zone, UtilRole, UTIL_ROLE_OF, UTIL_RADIUS_OF, KIND_NAMES,
  regionalPrice, priceText, refuseGradeOf, tileKey, utilKey, utilityReach,
  type ServiceId, type TariffDTO, type ServiceContractDTO, type ServicesView, type ServiceQuote, type ServiceMsg, type ContractsSave, type UtilEnv,
} from '@msimcity/shared';
import type { World, Parcel, Player, Building } from '../world';
import type { Utilities, PowerContracts } from './utilities';
import type { RefuseContracts } from './refuse';

const TPH = TICKS_PER_HOUR;
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export type ContractResult = { ok: true; msg: string } | { ok: false; msg: string };
const ok = (msg: string): ContractResult => ({ ok: true, msg });
const no = (msg: string): ContractResult => ({ ok: false, msg });
const isService = (s: unknown): s is ServiceId => typeof s === 'string' && (SERVICE_IDS as readonly string[]).includes(s);

/**
 * Service contracts between players (docs/multiplayer-land.md section 7 "Services", M8), one per game (game.ts), in
 * every world (a showcase refuses the intents as it refuses every other):
 *
 * - **Tariffs.** A provider with something to serve from (a refuse site; a substation or grid supply point) posts a
 *   public price per service: refuse a home a day, power a unit. Never above the regional reference price
 *   (`regionalPrice`: the old depots' fee spread over a week; grid import), so nobody is held hostage. Changing or
 *   withdrawing it leaves running contracts alone.
 * - **Contracts.** The owner of a parcel (or an estate) signs it up with a provider in reach at the posted price, fixed
 *   for the term (CONTRACTS.minDays-maxDays). Either side gives CONTRACTS.noticeDays' notice; the contract ends at
 *   the midnight its notice or term runs out, and the service falls back to the regional supplier (the old depots for
 *   refuse; for power the buyer's own network with grid import, if any). A contract binds the land: sold, it carries on
 *   with the new owner, and ends if the provider becomes the owner.
 * - **Access.** While a power contract runs, the provider's network walks the buyer's roads on those parcels (the
 *   reach field's `access`, sim/utilities.ts) and serves its buildings first; a refuse contract sends the parcels' homes
 *   to the provider's sites' rounds (sim/refuse.ts). Each for that service only.
 * - **Billing.** Hourly: refuse at the contract's price for every home on the parcels (a day's price / 24), power for
 *   the units the provider's network supplied there (at the utilities' solve). The buyer pays (`services`, "Services
 *   bought from neighbours"), the provider is paid (`contracts`, "Service contracts sold"); both running lines.
 * - **No cut-off.** The provider may not bulldoze its last refuse site while refuse contracts run, nor a substation that
 *   served contracted buildings at the last hour (`cutRefusal`, net.ts). Where service lapses all the same, the buyer
 *   does not pay for it: power is billed only for units supplied, and a contracted home the regional depots had to
 *   empty is paid for by the provider (sim/refuse.ts arrive).
 */
export class Contracts implements PowerContracts, RefuseContracts {
  /** for one player's screen (net.ts sends them as toasts) */
  notices: { owner: string; msg: string }[] = [];
  /** something a client sees changed (net.ts sends each client its view) */
  changed = true;
  private tariffs = new Map<string, TariffDTO>();
  private contracts = new Map<number, ServiceContractDTO>();
  /** running contracts by `${service}:${parcel}` */
  private byParcel = new Map<string, ServiceContractDTO>();
  private next = 1;
  private day: number;
  /** since start (contracts:check reads them) */
  stats = { signed: 0, ended: 0, billed: 0, refused: 0 };

  constructor(private w: World, private utilities: Utilities | null) {
    this.day = w.day;
    if (w.contractsLoaded) { this.load(w.contractsLoaded); w.contractsLoaded = null; }
    w.contractsSave = () => this.save();
    this.index();
  }

  // ---- reading ------------------------------------------------------------------------------------------

  private name(id: string) { return this.w.players.get(id)?.name ?? id; }
  private tell(owner: string, msg: string) { this.notices.push({ owner, msg }); }
  private index() {
    this.byParcel.clear();
    for (const c of this.contracts.values()) for (const id of c.parcels) this.byParcel.set(`${c.service}:${id}`, c);
  }
  /** The contract running for `service` on parcel `id`. */
  on(service: ServiceId, id: number): ServiceContractDTO | undefined { return this.byParcel.get(`${service}:${id}`); }
  /** PowerContracts: the power contract on parcel `parcel` (sim/utilities.ts). */
  providerOf(parcel: number): { id: number; provider: string } | null {
    if (!parcel || !this.byParcel.size) return null;
    return this.byParcel.get(`power:${parcel}`) ?? null;
  }
  /** PowerContracts: `owner`'s network may walk the road at (x, y) on a parcel under a power contract with them. */
  access(owner: string, x: number, y: number): boolean {
    if (!this.byParcel.size) return false;
    const id = this.w.parcelIdAt(x, y);
    return !!id && this.byParcel.get(`power:${id}`)?.provider === owner;
  }
  /** RefuseContracts: the refuse contract on the parcel at (x, y) (sim/refuse.ts). */
  providerAt(x: number, y: number): { id: number; provider: string } | null {
    if (!this.byParcel.size) return null;
    const id = this.w.parcelIdAt(x, y);
    return id ? this.byParcel.get(`refuse:${id}`) ?? null : null;
  }
  tariffOf(owner: string, s: ServiceId): TariffDTO | undefined { return this.tariffs.get(`${owner}|${s}`); }
  get running(): readonly ServiceContractDTO[] { return [...this.contracts.values()]; }

  /** What one player's client is sent: every tariff, the regional prices, and the contracts they are a party to. */
  view(pid: string): ServicesView {
    return {
      tariffs: [...this.tariffs.values()].map((t) => ({ ...t })),
      contracts: [...this.contracts.values()].filter((c) => c.buyer === pid || c.provider === pid).map((c) => ({ ...c, parcels: [...c.parcels] })),
      regional: { refuse: regionalPrice('refuse'), power: regionalPrice('power') },
    };
  }

  // ---- reach --------------------------------------------------------------------------------------------

  /** The owner's built refuse sites (graded, finished, on their land). */
  private sitesOf(owner: string): Building[] {
    const out: Building[] = [];
    for (const b of this.w.builtOf(Zone.Hub)) if (refuseGradeOf(b.id) && b.level > 0 && this.w.parcelAt(b.x, b.y)?.owner === owner) out.push(b);
    return out;
  }
  private nodesOf(owner: string): Building[] {
    const out: Building[] = [];
    for (const b of this.w.builtOf(Zone.Hub)) if (UTIL_ROLE_OF[b.id] === UtilRole.Node && b.level > 0 && this.w.parcelAt(b.x, b.y)?.owner === owner) out.push(b);
    return out;
  }
  /** Manhattan tiles from (x, y) to the nearest tile of parcel q. */
  private distTo(q: Parcel, x: number, y: number) {
    const dx = x < q.x ? q.x - x : x >= q.x + q.w ? x - (q.x + q.w - 1) : 0;
    const dy = y < q.y ? q.y - y : y >= q.y + q.h ? y - (q.y + q.h - 1) : 0;
    return dx + dy;
  }
  /**
   * Whether `provider` can serve `service` on these parcels: refuse, a site of theirs within the rounds' reach
   * (REFUSE.reach) of the land; power, a substation of theirs whose reach, allowed onto these parcels' roads, takes in a
   * road on them. A string says why not.
   */
  reach(provider: string, service: ServiceId, parcels: Parcel[]): true | string {
    if (service === 'refuse') {
      const sites = this.sitesOf(provider);
      if (!sites.length) return `${this.name(provider)} has no refuse site`;
      return sites.some((b) => parcels.some((q) => this.distTo(q, b.x, b.y) <= REFUSE.reach)) ? true : `${this.name(provider)}'s refuse sites are more than ${REFUSE.reach} tiles away`;
    }
    const u = this.utilities;
    if (!u) return 'No power networks on this server';
    const nodes = this.nodesOf(provider);
    if (!nodes.length) return `${this.name(provider)} has no substation`;
    const ids = new Set(parcels.map((q) => q.id));
    const env: UtilEnv = { ...u.env, access: (o, x, y) => (o === provider && ids.has(this.w.parcelIdAt(x, y))) || (u.env.access?.(o, x, y) ?? false) };
    for (const b of nodes) {
      const r = UTIL_RADIUS_OF[b.id];
      if (!parcels.some((q) => this.distTo(q, b.x, b.y) <= r + 2)) continue;
      const got = utilityReach({ key: utilKey(b.x, b.y), x: b.x, y: b.y, kind: b.id, owner: provider }, env);
      for (let i = 0; i < got.dist.length; i++) if (ids.has(this.w.parcelIdAt(got.tiles[i * 2], got.tiles[i * 2 + 1]))) return true;
    }
    return `${this.name(provider)}'s substations do not reach a road on that land (a network runs ${UTIL_RADIUS_OF[nodes[0].id]}-16 road tiles from its substation)`;
  }
  /** The providers that could serve parcel `id`'s land (the buyer's panel): each posted tariff, its price, whether it reaches. */
  quotes(id: number): ServiceQuote[] {
    const q = this.w.parcels.get(id);
    if (!q) return [];
    const land = q.group !== undefined ? this.w.estateOf(q.group) : [q];
    const out: ServiceQuote[] = [];
    for (const t of this.tariffs.values()) {
      if (t.owner === q.owner) continue;
      const r = this.reach(t.owner, t.service, land);
      out.push({ provider: t.owner, service: t.service, price: t.price, reach: r === true, ...(r === true ? {} : { why: r }) });
    }
    return out.sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : a.price - b.price));
  }

  // ---- the intents ---------------------------------------------------------------------------------------

  /** One `svc` intent from player p (a quote is answered by net.ts with `quotes`). */
  handle(p: Player, m: ServiceMsg): ContractResult {
    const before = this.notices.length;
    const r = this.act(p, m);
    if (!r.ok) this.stats.refused++;
    // the actor has the result as their toast: what this told them besides goes
    this.notices = [...this.notices.slice(0, before), ...this.notices.slice(before).filter((x) => x.owner !== p.id)];
    return r;
  }
  private act(p: Player, m: ServiceMsg): ContractResult {
    switch (m.op) {
      case 'tariff': return this.post(p, m.service, m.price === null || m.price === undefined ? null : Number(m.price));
      case 'sign': return this.sign(p, Math.floor(Number(m.id)), m.service, String(m.provider), Math.floor(Number(m.days)), m.estate === true);
      case 'notice': return this.notice(p, Math.floor(Number(m.contract)));
    }
    return no('Unknown service request');
  }

  /** Post, change or (price null) withdraw a tariff. */
  post(p: Player, service: ServiceId, price: number | null): ContractResult {
    if (!isService(service)) return no('Unknown service');
    const k = `${p.id}|${service}`, words = SERVICE_NAMES[service].toLowerCase();
    if (price === null) {
      if (!this.tariffs.delete(k)) return no(`You have no ${words} tariff posted`);
      this.changed = true;
      return ok(`Your ${words} tariff is withdrawn: nobody new may sign up; running contracts keep their price`);
    }
    if (!Number.isFinite(price) || price < 0) return no('Give a price');
    const cap = regionalPrice(service);
    if (price > cap + 1e-9) return no(`No provider may charge more than the regional supplier: ${priceText(service, cap)} for ${words}`);
    if (service === 'refuse' ? !this.sitesOf(p.id).length : !this.nodesOf(p.id).length)
      return no(service === 'refuse' ? 'Post a refuse tariff once you have a refuse site of your own' : 'Post a power tariff once you have a substation of your own');
    const prev = this.tariffs.get(k);
    this.tariffs.set(k, { owner: p.id, service, price: Math.round(price * 1e4) / 1e4, day: this.w.day });
    this.changed = true;
    return ok(`${SERVICE_NAMES[service]} tariff ${prev ? 'changed' : 'posted'}: ${priceText(service, price)} (the regional price is ${priceText(service, cap)})${prev ? '. Running contracts keep the price they were signed at' : ''}`);
  }

  /** Sign parcel `id` (or its estate) up with `provider` for `service` at their posted price for `days`. */
  sign(p: Player, id: number, service: ServiceId, provider: string, days: number, estate: boolean): ContractResult {
    const w = this.w;
    if (!isService(service)) return no('Unknown service');
    const q = w.parcels.get(id);
    if (!q) return no('That parcel no longer exists');
    const land = estate && q.group !== undefined ? w.estateOf(q.group) : [q];
    if (land.some((m) => m.owner !== p.id)) return no('Sign up your own land');
    if (provider === p.id) return no('That is your own service');
    if (p.admin) return no('Not while your city is in administration');
    const t = this.tariffOf(provider, service);
    if (!t) return no(`${this.name(provider)} has no ${SERVICE_NAMES[service].toLowerCase()} tariff posted`);
    if (!(days >= CONTRACTS.minDays && days <= CONTRACTS.maxDays)) return no(`A term is ${CONTRACTS.minDays}-${CONTRACTS.maxDays} days`);
    const taken = land.find((m) => this.on(service, m.id));
    if (taken) return no(`${taken.name} already has a ${SERVICE_NAMES[service].toLowerCase()} contract: give notice on it first`);
    let open = 0;
    for (const c of this.contracts.values()) if (c.buyer === p.id) open++;
    if (open >= CONTRACTS.maxOpen) return no(`At most ${CONTRACTS.maxOpen} contracts at a time`);
    const r = this.reach(provider, service, land);
    if (r !== true) return no(`${r}: they cannot serve that land`);
    const c: ServiceContractDTO = { id: this.next++, service, provider, buyer: p.id, parcels: land.map((m) => m.id), price: t.price, start: w.day, end: w.day + days, paid: 0, last: 0 };
    this.contracts.set(c.id, c);
    this.index();
    this.changed = true;
    this.stats.signed++;
    if (service === 'power') this.utilities?.invalidate();
    const what = `${q.name}${land.length > 1 ? ` and ${plural(land.length - 1, 'more parcel')}` : ''}`;
    this.tell(provider, `${p.name} signed ${what} up for your ${SERVICE_NAMES[service].toLowerCase()} at ${priceText(service, c.price)} until day ${c.end}${service === 'power' ? ': your network now runs along their streets there' : ': your refuse sites collect their homes there'}`);
    return ok(`Signed up with ${this.name(provider)}: ${SERVICE_NAMES[service].toLowerCase()} for ${what} at ${priceText(service, c.price)}, fixed until day ${c.end}. Either side may leave with ${CONTRACTS.noticeDays} days' notice`);
  }

  /** Give notice on a contract (either party): it ends CONTRACTS.noticeDays midnights later (or at its term, if sooner). */
  notice(p: Player, id: number): ContractResult {
    const c = this.contracts.get(id);
    if (!c) return no('That contract has ended');
    if (p.id !== c.buyer && p.id !== c.provider) return no('Not your contract');
    if (c.ends !== undefined) return no(`Notice is given already: the contract ends on day ${c.ends}`);
    c.ends = Math.min(c.end, this.w.day + CONTRACTS.noticeDays);
    c.noticeBy = p.id;
    this.changed = true;
    const other = p.id === c.buyer ? c.provider : c.buyer;
    this.tell(other, `${p.name} gave notice on the ${SERVICE_NAMES[c.service].toLowerCase()} contract: it ends on day ${c.ends}${p.id === c.provider ? '; then the regional supplier takes over' : ''}`);
    return ok(`Notice given: the ${SERVICE_NAMES[c.service].toLowerCase()} contract ends on day ${c.ends}; the service runs until then`);
  }

  /**
   * Why the provider may not bulldoze the building at (x, y) now (net.ts), or null: its last refuse site while refuse
   * contracts run, or a substation that served contracted buildings at the last hour.
   */
  cutRefusal(x: number, y: number): string | null {
    if (!this.contracts.size) return null;
    const w = this.w, [dx, dy] = w.doorOf(x, y), b = w.buildings.get(tileKey(dx, dy));
    if (!b || b.level <= 0) return null;
    const owner = w.parcelAt(dx, dy)?.owner;
    if (!owner) return null;
    const mine = [...this.contracts.values()].filter((c) => c.provider === owner);
    if (refuseGradeOf(b.id)) {
      const run = mine.filter((c) => c.service === 'refuse');
      if (run.length && !this.sitesOf(owner).some((s) => s !== b)) return `Your ${KIND_NAMES[b.id]} is your last refuse site and ${plural(run.length, 'refuse contract')} ${run.length === 1 ? 'runs' : 'run'} on it (to day ${Math.max(...run.map((c) => c.ends ?? c.end))}): nobody cuts a service mid-contract. Give notice first (${CONTRACTS.noticeDays} days), or build another site`;
    }
    if (UTIL_ROLE_OF[b.id] === UtilRole.Node && mine.some((c) => c.service === 'power') && this.utilities?.servesContract(utilKey(dx, dy)))
      return `This ${KIND_NAMES[b.id]} powers streets under contract: nobody cuts a service mid-contract. Give notice first (${CONTRACTS.noticeDays} days)`;
    return null;
  }

  // ---- billing and time ----------------------------------------------------------------------------------

  private charge(c: ServiceContractDTO, amount: number) {
    c.last = amount;
    if (!(amount > 0)) return;
    this.w.credit(c.buyer, -amount, 'services');
    this.w.credit(c.provider, amount, 'contracts');
    c.paid += amount;
    this.stats.billed += amount;
  }
  /** PowerContracts: this hour's units under each power contract (sim/utilities.ts solve), billed at the contract's price. */
  supplied(units: Map<number, number>) {
    for (const c of this.contracts.values()) if (c.service === 'power') this.charge(c, (units.get(c.id) ?? 0) * c.price);
    this.changed = true;
  }
  /** Refuse, hourly: the day's price / 24 for every home on the contract's parcels. */
  billRefuse() {
    const refuse = [...this.contracts.values()].filter((c) => c.service === 'refuse');
    if (!refuse.length) return;
    const homes = new Map<number, number>();
    for (const b of this.w.builtOf(Zone.Residential)) {
      if (b.level <= 0) continue;
      const id = this.w.parcelIdAt(b.x, b.y);
      if (id && this.byParcel.has(`refuse:${id}`)) homes.set(id, (homes.get(id) ?? 0) + 1);
    }
    for (const c of refuse) {
      let n = 0;
      for (const id of c.parcels) n += homes.get(id) ?? 0;
      this.charge(c, (n * c.price) / 24);
    }
    this.changed = true;
  }
  /** Homes on a contract's parcels now (its panel row and the check). */
  homesOn(c: ServiceContractDTO): number {
    let n = 0;
    const ids = new Set(c.parcels);
    for (const b of this.w.builtOf(Zone.Residential)) if (b.level > 0 && ids.has(this.w.parcelIdAt(b.x, b.y))) n++;
    return n;
  }

  /** After every simulation tick (game.ts). */
  tick() {
    const w = this.w;
    if (w.tick % 25 === 0 && this.contracts.size) this.validate();
    if (w.tick % TPH === CONTRACTS.billAt) this.billRefuse();
    if (w.day === this.day) return;
    this.day = w.day;
    this.midnight();
  }
  /** Contracts whose land changed: parcels gone are dropped; a sale carries the contract to the new owner; the provider owning it ends it. */
  private validate() {
    const w = this.w;
    let changed = false;
    for (const c of [...this.contracts.values()]) {
      const live = c.parcels.filter((id) => w.parcels.has(id));
      if (live.length !== c.parcels.length) { c.parcels = live; changed = true; }
      if (!live.length) { this.end(c, 'its land is gone'); continue; }
      const owners = new Set(live.map((id) => w.parcels.get(id)!.owner));
      if (owners.has(c.provider)) {
        const keep = live.filter((id) => w.parcels.get(id)!.owner !== c.provider);
        if (!keep.length) { this.end(c, `${this.name(c.provider)} owns the land now`); continue; }
        c.parcels = keep; changed = true;
      }
      const owner = w.parcels.get(c.parcels[0])!.owner;
      if (owner !== c.buyer) {
        this.tell(owner, `The ${SERVICE_NAMES[c.service].toLowerCase()} contract on your new land with ${this.name(c.provider)} carries on: ${priceText(c.service, c.price)} until day ${c.ends ?? c.end}; you may give ${CONTRACTS.noticeDays} days' notice`);
        c.buyer = owner; changed = true;
      }
      // an estate split between owners: the parcels the buyer no longer holds leave it
      const theirs = c.parcels.filter((id) => w.parcels.get(id)!.owner === c.buyer);
      if (theirs.length !== c.parcels.length) { c.parcels = theirs; changed = true; }
    }
    if (changed) { this.index(); this.changed = true; this.utilities?.invalidate(); }
  }
  private end(c: ServiceContractDTO, why: string) {
    this.contracts.delete(c.id);
    this.index();
    this.changed = true;
    this.stats.ended++;
    if (c.service === 'power') this.utilities?.invalidate();
    const fallback = c.service === 'refuse' ? 'the regional depots collect again, at their fee' : 'power comes from your own substations (and grid import) again';
    this.tell(c.buyer, `Your ${SERVICE_NAMES[c.service].toLowerCase()} contract with ${this.name(c.provider)} has ended (${why}): ${fallback}`);
    this.tell(c.provider, `The ${SERVICE_NAMES[c.service].toLowerCase()} contract with ${this.name(c.buyer)} has ended (${why})`);
  }
  /** Contracts at the end of their notice or term. Public for checks. */
  midnight() {
    const day = this.w.day;
    this.validate();
    for (const c of [...this.contracts.values()]) {
      if (c.ends !== undefined && day >= c.ends) this.end(c, `${c.noticeBy === c.provider ? `${this.name(c.provider)}'s` : c.noticeBy ? `${this.name(c.buyer)}'s` : 'the'} notice ran out`);
      else if (day >= c.end) this.end(c, 'the term is over');
    }
  }

  // ---- saving -------------------------------------------------------------------------------------------

  save(): ContractsSave | null {
    if (!this.tariffs.size && !this.contracts.size) return null;
    return { next: this.next, tariffs: [...this.tariffs.values()].map((t) => ({ ...t })), contracts: [...this.contracts.values()].map((c) => ({ ...c, parcels: [...c.parcels] })) };
  }
  private load(s: ContractsSave) {
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    for (const t of Array.isArray(s.tariffs) ? s.tariffs : []) {
      if (!t || typeof t.owner !== 'string' || !isService(t.service) || !num(t.price)) continue;
      this.tariffs.set(`${t.owner}|${t.service}`, { owner: t.owner, service: t.service, price: Math.max(0, Math.min(regionalPrice(t.service), t.price)), day: num(t.day) ? t.day : 0 });
    }
    for (const c of Array.isArray(s.contracts) ? s.contracts : []) {
      if (!c || !num(c.id) || !isService(c.service) || typeof c.provider !== 'string' || typeof c.buyer !== 'string' || !Array.isArray(c.parcels) || !num(c.price) || !num(c.end)) continue;
      this.contracts.set(c.id, {
        id: c.id, service: c.service, provider: c.provider, buyer: c.buyer, parcels: c.parcels.filter(num), price: c.price,
        start: num(c.start) ? c.start : 0, end: c.end, ...(num(c.ends) ? { ends: c.ends } : {}), ...(typeof c.noticeBy === 'string' ? { noticeBy: c.noticeBy } : {}),
        paid: num(c.paid) ? c.paid : 0, last: num(c.last) ? c.last : 0,
      });
    }
    this.next = Math.max(num(s.next) ? s.next : 1, 1 + Math.max(0, ...this.contracts.keys()));
  }
}
