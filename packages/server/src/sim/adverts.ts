import {
  AD, AD_CLAIMS, AD_RENTAL, AD_STRIDE, TICKS_PER_DAY, LifeStage, adHostAt, adSlotOpen, adSizeOf, adRent, adAge, adAreaRate, adSlotWorld, isScreenSlot,
  claimText, kindManifest, signSource, signText, spendableMoney, tileKey, hasFeature, techFor, adSeed, adWear, isAreaClaim,
  type AdEnv, type AdHost, type AdTarget, type AdsDTO, type CampaignDTO,
} from '@msimcity/shared';
import type { World, Player } from '../world';

/**
 * Adverts, slice 1 (docs/adverts.md A2): campaigns, rented slots and rent. A campaign is a claim from the table with a
 * look; a rental puts it on one slot (shared/src/adverts.ts finds slots from the designs, as the client does). Renting
 * costs the slot's rent per game day, charged to the renter when it goes up and at every midnight after, and paid to
 * the owner of the parcel the slot stands on ('ads' in both ledgers). A rental whose slot has gone (the building was
 * pulled down, a site's hoarding came down when it finished) or whose renter cannot pay ends.
 *
 * Wear is a formula (docs/adverts.md section 6): each rental carries its age in wear units and the rate it ages at, set
 * once a game day from its neighbourhood (adults out of work, services and leisure in reach), so client and server get
 * the same wear from the same numbers. Nothing here runs per tick but a day check; with no rentals the daily pass is
 * empty, so a city without adverts costs exactly what it did.
 *
 * Reach (who sees a poster and what it does to them) is A4 and needs citizens' beliefs (docs/motivation.md): not yet.
 */

interface Campaign extends CampaignDTO {}
interface Rental {
  x: number; y: number; i: number; c: number;
  /** wear age at `at`, the rate since (wear units per game day), the tick it went up */
  age: number; rate: number; at: number; placed: number;
  /** the slot's size code (AD_SIZES), for the panel's costs */
  s: number;
  /** a demo's poster (seed): it keeps its age and costs nothing */
  keep?: boolean;
  /** fly-posted (M6, docs/adverts.md section 7): `c` is the fly-poster's campaign; `o` the renter's, restored when found */
  o?: number;
}
/** What the snapshot keeps (snapshot.ts `adverts`); absent in older saves. */
export interface AdvertsSave { campaigns: Campaign[]; rentals: Rental[]; nextId: number; posted: string[] }
/** Something to tell one owner (net.ts sends a toast). */
export interface AdNotice { owner: string; msg: string }

const rkey = (x: number, y: number, i: number) => `${x},${y}#${i}`;
const money = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;

export class Adverts {
  /** set whenever the campaigns or rentals changed (net.ts broadcasts `ads`) */
  changed = true;
  notices: AdNotice[] = [];
  /** counters since start, for the probe */
  stats = { created: 0, rented: 0, ended: 0, unpaid: 0, gone: 0, rentPaid: 0 };
  /** the simulation's cover at a home tile (police, fire and health 0-3; leisure tier 0-3), set by game.ts */
  cover: (x: number, y: number) => [number, number] = () => [0, 0];
  /**
   * M6 (sim/campaigns.ts): the guard on spending for a plan campaign's poster rent (`isNew`: a new rental, which may be
   * refused; otherwise midnight's rent, only recorded), and the truth of an area claim about a parcel (claims about someone else's land must be true when posted).
   */
  planRent: ((c: Readonly<Campaign>, cost: number, isNew: boolean) => string | null) | null = null;
  areaTruth: ((parcel: number, claim: number) => boolean) | null = null;

  private campaigns = new Map<number, Campaign>();
  private rentals = new Map<string, Rental>();
  private nextId = 1;
  private posted = new Set<string>();
  private day: number;
  private env: AdEnv;

  constructor(private w: World) {
    this.day = w.day;
    this.env = { tile: (x, y) => w.peekTile(x, y), aux: (x, y) => w.auxAt(x, y), sub: (x, y) => w.subAt(x, y) };
    const s = w.advertsLoaded;
    if (s) {
      for (const c of s.campaigns ?? []) if (c && Number.isInteger(c.id) && typeof c.owner === 'string') this.campaigns.set(c.id, { ...c });
      for (const r of s.rentals ?? []) if (r && this.campaigns.has(r.c)) this.rentals.set(rkey(r.x, r.y, r.i), { ...r, s: r.s ?? 1 });
      this.nextId = Math.max(1, s.nextId ?? 1, 1 + Math.max(0, ...this.campaigns.keys()));
      for (const id of s.posted ?? []) this.posted.add(id);
      w.advertsLoaded = null;
    }
    w.adverts = {
      save: () => this.save(),
      counts: (owner) => {
        let campaigns = 0, rentals = 0;
        for (const c of this.campaigns.values()) if (c.owner === owner) campaigns++;
        for (const r of this.rentals.values()) if (this.campaigns.get(r.c)?.owner === owner) rentals++;
        return { campaigns, rentals, posted: this.posted.has(owner) };
      },
    };
  }

  private save(): AdvertsSave {
    return { campaigns: [...this.campaigns.values()], rentals: [...this.rentals.values()], nextId: this.nextId, posted: [...this.posted] };
  }

  dto(): AdsDTO {
    const r: number[] = [];
    for (const x of this.rentals.values()) r.push(x.x, x.y, x.i, x.c, round(x.age), round(x.rate), x.at, x.placed, x.s);
    return { campaigns: [...this.campaigns.values()], r };
  }

  /** Once a tick: only a day check. */
  tick() {
    if (this.w.day === this.day) return;
    this.day = this.w.day;
    if (this.rentals.size) this.daily();
  }

  // ---- intents (net.ts) ----------------------------------------------------------------------------

  /** A new campaign: a claim of a theme, a look and what it is about. Returns an error, or the campaign. */
  create(p: Player, m: { theme: number; claim: number; look: number; target?: AdTarget }, sandbox: boolean): string | Campaign {
    const need = this.locked(p);
    if (need) return `${need} is needed before you can run adverts`;
    const own = [...this.campaigns.values()].filter((c) => c.owner === p.id).length;
    if (own >= AD.maxCampaigns) return `You can run ${AD.maxCampaigns} campaigns at once: end one first`;
    const claim = AD_CLAIMS[Number(m.claim)];
    if (!claim || claim.theme !== Number(m.theme)) return 'Pick a claim for the theme';
    const names = this.names(p, m.target, sandbox, Number(m.claim));
    if (typeof names === 'string') return names;
    const text = claimText(Number(m.claim), names);
    if (!text) return claim.needs === 'building' ? 'That claim names a workplace: pick one of yours' : 'That claim names a place: pick one of your parcels';
    if (spendableMoney(p.money, p.devUnlimited) < AD.campaignCost) return `A campaign's artwork costs ${money(AD.campaignCost)}`;
    this.w.credit(p.id, -AD.campaignCost, 'ads');
    const c: Campaign = {
      id: this.nextId++, owner: p.id, theme: claim.theme, claim: Number(m.claim), look: Math.max(0, Math.floor(Number(m.look) || 0)) % 192,
      created: this.w.day, text, ...(m.target && claim.needs ? { target: { kind: m.target.kind, id: Number(m.target.id), ...(m.target.x !== undefined ? { x: m.target.x, y: m.target.y } : {}) } } : {}),
    };
    this.campaigns.set(c.id, c);
    this.stats.created++;
    this.changed = true;
    return c;
  }

  /** The names a claim may use: the target parcel's (its estate shares it) or the target workplace's sign. */
  private names(p: Player, t: AdTarget | undefined, sandbox: boolean, claim = -1): string | { place?: string; building?: string } {
    if (!t) return {};
    if (t.kind === 'parcel') {
      const q = this.w.parcels.get(Number(t.id));
      // an area claim may name someone else's land, but only truly (M6); its own owner may say what they like (regret answers)
      if (q && q.owner !== p.id && isAreaClaim(claim)) {
        if (this.areaTruth && !this.areaTruth(q.id, claim)) return `That is not true of ${q.name}: a claim about someone else's land must be true when it goes up`;
        return { place: q.name };
      }
      if (!q || (q.owner !== p.id && !sandbox)) return 'Pick one of your own parcels';
      return { place: q.name };
    }
    if (t.kind === 'building' && Number.isInteger(t.x) && Number.isInteger(t.y)) {
      const [dx, dy] = this.w.doorOf(t.x!, t.y!);
      const b = this.w.buildings.get(tileKey(dx, dy));
      const q = this.w.parcelAt(dx, dy);
      if (!b || b.level <= 0 || !q || (q.owner !== p.id && !sandbox)) return 'Pick a workplace on your own land';
      const k = kindManifest(b.id);
      const s = this.w.structureAt(dx, dy);
      return k ? { building: signText(signSource(k, s ? s.ax : dx, s ? s.ay : dy)) } : {};
    }
    return 'Unknown target';
  }

  /**
   * Put a campaign up on slots: the ones listed ([door x, door y, slot]), or the `n` free ones nearest (x, y). Returns an
   * error, or how many went up and the first day's rent.
   */
  rent(p: Player, campaign: number, slots: [number, number, number][] | undefined, near: { x: number; y: number; n: number } | undefined): string | { n: number; cost: number } {
    const c = this.campaigns.get(Number(campaign));
    const need = c?.target?.kind === 'plan' ? null : this.locked(p); // a stakeholder answers a planning notice without the Advertising tech (M6)
    if (need) return `${need} is needed before you can run adverts`;
    if (!c || c.owner !== p.id) return 'Pick one of your campaigns';
    let mine = 0;
    for (const r of this.rentals.values()) if (this.campaigns.get(r.c)?.owner === p.id) mine++;
    let want = Array.isArray(slots) ? slots.filter((s) => Array.isArray(s) && s.length === 3 && s.every(Number.isInteger)).slice(0, 24) : [];
    if (near && Number.isFinite(near.x) && Number.isFinite(near.y)) want = this.nearest(near.x, near.y, Math.max(1, Math.min(12, Math.floor(near.n) || 1)));
    if (!want.length) return near ? `No free ad slots within ${AD.nearReach} tiles of here` : 'Click a frame on a building';
    let n = 0, cost = 0, err = '';
    for (const [x, y, i] of want) {
      if (mine + n >= AD.maxRentals) { err = `You can rent ${AD.maxRentals} slots at once`; break; }
      const why = this.free(x, y, i);
      if (why) { err = why; continue; }
      const h = adHostAt(this.env, x, y)!;
      const rent = adRent(adSizeOf(h, i));
      if (spendableMoney(p.money, p.devUnlimited) < rent) { err = `Not enough money for the first day's rent (${money(rent)})`; break; }
      const cap = c.target?.kind === 'plan' && this.planRent ? this.planRent(c, rent, true) : null;
      if (cap) { err = cap; break; }
      this.pay(p.id, x, y, rent);
      const rate = this.rateAt(x, y, h, i);
      this.rentals.set(rkey(x, y, i), { x, y, i, c: c.id, age: 0, rate, at: this.w.tick, placed: this.w.tick, s: h.slots[i * AD_STRIDE + 1] });
      n++; cost += rent;
    }
    if (n) {
      this.posted.add(p.id);
      this.stats.rented += n;
      this.changed = true;
      return { n, cost };
    }
    return err || 'Nothing to rent there';
  }

  /** Take posters down: the slots listed, or every slot of a campaign; `drop` also ends the campaign itself. */
  end(p: Player, slots: [number, number, number][] | undefined, campaign: number | undefined, drop: boolean): string | number {
    let n = 0;
    if (Array.isArray(slots)) for (const s of slots) {
      if (!Array.isArray(s) || s.length !== 3) continue;
      const k = rkey(s[0], s[1], s[2]), r = this.rentals.get(k);
      if (r && this.campaigns.get(r.c)?.owner === p.id) { this.rentals.delete(k); n++; }
    }
    if (campaign !== undefined) {
      const c = this.campaigns.get(Number(campaign));
      if (!c || c.owner !== p.id) return 'Pick one of your campaigns';
      for (const [k, r] of this.rentals) {
        if (r.c === c.id && r.o !== undefined) { r.c = r.o; delete r.o; n++; continue; } // a fly-post comes down: the renter's poster shows again
        if (r.c === c.id || r.o === c.id) { this.rentals.delete(k); n++; }
      }
      if (drop) this.campaigns.delete(c.id);
    }
    this.stats.ended += n;
    if (n || drop) this.changed = true;
    return n;
  }

  /** Why a slot cannot be rented, or '' when it can. */
  private free(x: number, y: number, i: number): string {
    const h = adHostAt(this.env, x, y);
    if (!h || i < 0 || i >= h.slots.length / AD_STRIDE) return 'No ad slot there';
    if (!adSlotOpen(this.env, h, i, x, y)) return 'That frame faces a neighbour\'s wall: nobody would see it';
    if (this.rentals.has(rkey(x, y, i))) return 'That slot is taken';
    return '';
  }

  /** Free slots nearest a point, nearest first. Big screens are rented only by picking them (they cost four times a billboard). */
  private nearest(px: number, py: number, n: number): [number, number, number][] {
    const out: { d: number; s: [number, number, number] }[] = [];
    const R = AD.nearReach, seen = new Set<string>();
    const x0 = Math.floor(px), y0 = Math.floor(py);
    for (let y = y0 - R; y <= y0 + R; y++) for (let x = x0 - R; x <= x0 + R; x++) {
      const t = this.w.peekTile(x, y);
      if (t === undefined || !this.w.buildings.has(tileKey(x, y))) continue; // doors only: a structure once
      const h = adHostAt(this.env, x, y);
      if (!h) continue;
      for (let i = 0; i < h.slots.length / AD_STRIDE; i++) {
        const k = rkey(x, y, i);
        if (seen.has(k) || isScreenSlot(h.slots, i) || this.free(x, y, i)) continue;
        seen.add(k);
        const wp = adSlotWorld(h, i);
        out.push({ d: Math.hypot(wp.x - px, wp.y - py), s: [x, y, i] });
      }
    }
    return out.sort((a, b) => a.d - b.d).slice(0, n).map((o) => o.s);
  }

  /** The renter pays a day's rent for the slot on (x, y); the parcel's owner gets it (renting your own frontage is free). */
  private pay(renter: string, x: number, y: number, rent: number) {
    const owner = this.w.parcelAt(x, y)?.owner;
    if (owner && this.w.players.has(owner)) this.w.transfer(renter, owner, rent, 'adrent');
    else this.w.credit(renter, -rent, 'adrent');
    this.stats.rentPaid += rent;
  }

  private locked(p: Player): string | null {
    if (hasFeature(p.tech, 'adverts')) return null;
    return techFor('adverts')?.name ?? 'Advertising';
  }

  // ---- the day ------------------------------------------------------------------------------------

  /**
   * Midnight: slots that have gone end; each renter pays a day's rent per slot (a renter who cannot ends that slot);
   * every poster's age rolls forward and its area rate is worked out afresh.
   */
  private daily() {
    const w = this.w, tick = w.tick;
    const jobless = this.joblessByParcel();
    const due = new Map<string, number>();
    const ended = new Map<string, number>();
    for (const [k, r] of [...this.rentals]) {
      if (r.o !== undefined && !this.campaigns.has(r.o)) delete r.o; // the renter's campaign ended under a fly-post: the fly-poster keeps the slot
      const c = this.campaigns.get(r.o ?? r.c);
      const p = c ? w.players.get(c.owner) : undefined;
      const h = adHostAt(this.env, r.x, r.y);
      if (!c || !p || !h || r.i >= h.slots.length / AD_STRIDE) {
        this.rentals.delete(k); this.stats.gone++;
        if (c) ended.set(c.owner, (ended.get(c.owner) ?? 0) + 1);
        continue;
      }
      if (r.keep) continue;
      const rent = adRent(adSizeOf(h, r.i));
      if (spendableMoney(p.money, p.devUnlimited) < rent || p.admin) {
        this.rentals.delete(k); this.stats.unpaid++;
        this.notices.push({ owner: p.id, msg: `A ${adSizeOf(h, r.i)} of "${c.text}" came down: the rent (${money(rent)} a day) went unpaid` });
        continue;
      }
      this.pay(p.id, r.x, r.y, rent);
      if (c.target?.kind === 'plan') this.planRent?.(c, rent, false);
      due.set(p.id, (due.get(p.id) ?? 0) + rent);
      r.age = adAge(r.age, r.rate, r.at, tick);
      r.at = tick;
      r.rate = this.rateAt(r.x, r.y, h, r.i, jobless);
    }
    for (const [owner, n] of ended) this.notices.push({ owner, msg: `${n} of your posters came down: the wall or the hoarding they were on has gone` });
    this.changed = true;
  }

  /** The area rate for a slot (shared adAreaRate) from its parcel's adults out of work and the cover at its door. */
  private rateAt(x: number, y: number, h: AdHost, i: number, jobless?: Map<number, number>): number {
    const q = this.w.parcelAt(x, y);
    const share = q ? (jobless ?? this.joblessByParcel()).get(q.id) ?? 0 : 0.3;
    const [cov, lei] = this.cover(x, y);
    return adAreaRate(share, cov, lei, adSizeOf(h, i));
  }

  /** The share of each parcel's adults (living there) out of work and not studying; one pass over the citizens. */
  private joblessCache: { tick: number; m: Map<number, number> } | null = null;
  private joblessByParcel(): Map<number, number> {
    if (this.joblessCache && this.w.tick - this.joblessCache.tick < TICKS_PER_DAY / 4) return this.joblessCache.m;
    const adults = new Map<number, number>(), idle = new Map<number, number>();
    for (const c of this.w.citizens.values()) {
      if (c.stage !== LifeStage.Adult) continue;
      const pid = this.w.parcelIdAt(c.hx, c.hy);
      if (!pid) continue;
      adults.set(pid, (adults.get(pid) ?? 0) + 1);
      if (!c.job && !c.study) idle.set(pid, (idle.get(pid) ?? 0) + 1);
    }
    const m = new Map<number, number>();
    for (const [pid, n] of adults) m.set(pid, (idle.get(pid) ?? 0) / n);
    this.joblessCache = { tick: this.w.tick, m };
    return m;
  }

  // ---- for the showcase and the probe -------------------------------------------------------------

  /** A campaign made without the checks or the cost (demos and the probe). */
  seedCampaign(owner: string, theme: number, claim: number, look: number, text: string): number {
    const c: Campaign = { id: this.nextId++, owner, theme, claim, look, created: this.w.day, text };
    this.campaigns.set(c.id, c);
    this.changed = true;
    return c.id;
  }
  /**
   * Put a poster up as if it had been there a while: `age` in wear units. With `keep` (a demo's high street: fresh,
   * tagged and wrecked side by side) it stays that age and costs nothing; otherwise it ages and pays rent like any other.
   */
  seed(owner: string, campaign: number, x: number, y: number, i: number, age: number, keep = false): boolean {
    if (this.free(x, y, i) || !this.campaigns.has(campaign)) return false;
    const h = adHostAt(this.env, x, y)!;
    this.rentals.set(rkey(x, y, i), { x, y, i, c: campaign, age, rate: keep ? 0 : this.rateAt(x, y, h, i), at: this.w.tick, placed: this.w.tick, s: h.slots[i * AD_STRIDE + 1], ...(keep ? { keep: true } : {}) });
    this.posted.add(owner);
    this.changed = true;
    return true;
  }
  // ---- M6: campaigns on planning applications, fly-posting (sim/campaigns.ts) --------------------------------

  /** A campaign on planning application `app` (sim/campaigns.ts checked the stake, the guards and charged the artwork). */
  createPlan(owner: string, theme: number, claim: number, text: string, look: number, app: number): Campaign | string {
    if ([...this.campaigns.values()].filter((c) => c.owner === owner).length >= AD.maxCampaigns) return `You can run ${AD.maxCampaigns} campaigns at once: end one first`;
    const c: Campaign = { id: this.nextId++, owner, theme, claim, look: Math.max(0, Math.floor(look) || 0) % 192, created: this.w.day, text, target: { kind: 'plan', id: app } };
    this.campaigns.set(c.id, c);
    this.stats.created++;
    this.changed = true;
    return c;
  }
  campaign(id: number): Readonly<Campaign> | undefined { return this.campaigns.get(id); }
  /** End a campaign and take its posters down (the system: a decided plan, a false claim found running). */
  drop(id: number): number {
    const c = this.campaigns.get(id);
    if (!c) return 0;
    const n = this.end({ id: c.owner } as Player, undefined, id, true);
    return typeof n === 'number' ? n : 0;
  }
  /**
   * The rented slots showing these campaigns: where each poster is (its centre in tiles), its size and its condition
   * now (wear), for the reach pass. A big screen never wears.
   */
  postersOf(ids: ReadonlySet<number>): { c: number; x: number; y: number; size: string; wear: number }[] {
    const out: { c: number; x: number; y: number; size: string; wear: number }[] = [];
    if (!ids.size) return out;
    for (const r of this.rentals.values()) {
      if (!ids.has(r.c)) continue;
      const h = adHostAt(this.env, r.x, r.y);
      if (!h || r.i >= h.slots.length / AD_STRIDE) continue;
      const wp = adSlotWorld(h, r.i), size = adSizeOf(h, r.i);
      out.push({ c: r.c, x: wp.x, y: wp.y, size, wear: isScreenSlot(h.slots, r.i) ? 0 : adWear(adAge(r.age, r.rate, r.at, this.w.tick), adSeed(r.x, r.y, r.i, r.o ?? r.c)) });
    }
    return out;
  }
  /** Posters showing campaign `id` (fly-posts included). */
  postersCount(id: number): number { let n = 0; for (const r of this.rentals.values()) if (r.c === id) n++; return n; }
  /**
   * Fly-post campaign `campaign` of `p` over someone else's poster on slot (x, y, i) for CAMPAIGN.flyCost (charged by the
   * caller): the rival's campaign is kept underneath and shows again when the fly-post is found or taken down. Returns
   * the campaign covered, or a refusal.
   */
  flyPost(p: Player, campaign: number, x: number, y: number, i: number): string | { covered: number; owner: string } {
    const c = this.campaigns.get(Number(campaign));
    if (!c || c.owner !== p.id) return 'Pick one of your campaigns';
    if (c.target?.kind !== 'plan') { const need = this.locked(p); if (need) return `${need} is needed before you can run adverts`; }
    const r = this.rentals.get(rkey(x, y, i));
    if (!r) return 'There is no poster on that frame to fly-post over: rent it instead';
    if (r.o !== undefined) return 'That poster has already been fly-posted';
    const under = this.campaigns.get(r.c);
    if (!under || under.owner === p.id) return 'That poster is yours';
    if (r.keep) return 'That poster is not to be touched';
    r.o = r.c; r.c = c.id;
    this.changed = true;
    return { covered: under.id, owner: under.owner };
  }
  /** Fly-posts still up: slot, the fly-poster's campaign and the one underneath. */
  flyPosts(): { x: number; y: number; i: number; c: number; o: number }[] {
    const out: { x: number; y: number; i: number; c: number; o: number }[] = [];
    for (const r of this.rentals.values()) if (r.o !== undefined) out.push({ x: r.x, y: r.y, i: r.i, c: r.c, o: r.o });
    return out;
  }
  /** A fly-post found: the renter's poster shows again. */
  unfly(x: number, y: number, i: number) {
    const r = this.rentals.get(rkey(x, y, i));
    if (!r || r.o === undefined) return;
    r.c = r.o; delete r.o;
    this.changed = true;
  }

  /** Every rental, for the probe. */
  list(): Readonly<Rental>[] { return [...this.rentals.values()]; }
  campaignList(): Readonly<Campaign>[] { return [...this.campaigns.values()]; }
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;
