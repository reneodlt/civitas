import {
  ECONOMY_TUNING, LAND_PRICE_PER_TILE, TICKS_PER_HOUR, Zone, KIND_NAMES, familyOf, isServiceId, isCivicId, isRoad, zoneOf, levelOf,
  underConstruction, upkeepOf, wageOf, packTile, terrainOf, tileKey, ZONE_TOOLS,
  type FinanceDTO, type RecoveryPlanDTO, type RecoverAction, type ClientMsg,
} from '@msimcity/shared';
import type { World, Player, Parcel, Building } from '../world';

/**
 * Money that can run out (docs/start-from-zero.md B3, docs/audit-2026-10.md card 5).
 *
 * - The overdraft: a player may spend down to -ECONOMY_TUNING.overdraftLimit (World.spendable, checked by net.ts and the
 *   few sim modules that charge for a build). Below zero, interest (overdraftInterestPerDay of the negative balance) is
 *   charged at midnight, ledger category 'interest'.
 * - Administration: a player below zero at `adminAfterDays` midnights in a row (Player.adminDays) is in administration
 *   (Player.admin) until the first midnight that finds the treasury at zero or above. Net refuses every build, buy, zone,
 *   road, unlock, policy and line intent meanwhile (adminRefusal), and World.payroll charges the whole of civic wages
 *   (the regional grant is withdrawn).
 * - The recovery plan, one `recover` intent each: raise tax to recoveryTaxRate, sell empty parcels back at landBuyback of
 *   the land price, mothball services (World.mothballed: staff let go, no upkeep, no coverage until reopened).
 *
 * Sandboxes (test cities and demos) never enter administration; their players' treasuries are endless anyway. The Commons
 * ('sys') is never charged interest.
 */

/** A building its owner may mothball: a staffed service (police, fire, health) or a builders' yard, built. */
export const mothballable = (b: Building) => b.level > 0 && (isServiceId(b.id) || familyOf(b.id) === Zone.Yard);

/**
 * Net's refusal of an intent from a player in administration, or null when it may go ahead: bulldozing, parcel settings,
 * build priorities, inspecting and the recovery plan still work.
 */
export function adminRefusal(m: ClientMsg): string | null {
  const what = m.t === 'buy' ? 'buying land'
    : m.t === 'build' ? (m.tool === 'bulldoze' ? null : m.tool === 'road' ? 'laying roads' : m.tool in ZONE_TOOLS ? 'zoning' : m.tool === 'rail' ? 'laying track' : 'building')
      : m.t === 'unlock' ? 'research'
        : m.t === 'setPolicy' ? (m.on === true ? 'enacting policies' : null)
          : m.t === 'line' && m.op === 'save' ? 'opening or changing lines'
            : m.t === 'adCampaign' || m.t === 'adRent' ? 'advertising' : null;
  return what && `In administration: ${what} is stopped until a midnight finds the treasury at zero or above. Bulldozing, parcel settings and the recovery plan (the red chip by the treasury) still work`;
}

/** Something to tell one owner: an advisor hint (net.ts sends it through the onboarding hints) or a plain toast. */
export interface FinanceNotice { owner: string; hint?: 'overdraft' | 'admin'; msg: string }

const money = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export class Finance {
  /** drained by net.ts flush */
  notices: FinanceNotice[] = [];
  /** the game day last seen: its change is midnight (Simulation.newDay has already rolled the day and charged upkeep) */
  private day: number;
  /** each player's recovery plan, worked out at most once a game hour (or again after a recovery action) */
  private plans = new Map<string, { hour: number; plan: RecoveryPlanDTO }>();
  /** a parcel's land at the market price (sim/land.ts, a shared world's market rules; set by game.ts); null: LAND_PRICE_PER_TILE a tile */
  landPrice: ((q: Parcel) => number) | null = null;
  private parcelPrice(q: Parcel) { return this.landPrice ? this.landPrice(q) : q.w * q.h * LAND_PRICE_PER_TILE; }

  constructor(private w: World, private sandbox: boolean) {
    this.day = w.day;
    w.financeDTO = (p) => this.dto(p);
  }

  /** After every simulation tick (game.ts). */
  tick() {
    if (this.w.day === this.day) return;
    this.day = this.w.day;
    this.midnight();
  }

  /** Interest, the count of midnights below zero, going into and coming out of administration. */
  private midnight() {
    const w = this.w, T = ECONOMY_TUNING;
    for (const p of w.players.values()) {
      if (p.id === 'sys' || p.devUnlimited) continue;
      if (p.money < 0) w.credit(p.id, p.money * T.overdraftInterestPerDay, 'interest');
      if (this.sandbox) continue;
      if (p.money < 0) {
        const n = p.adminDays = (p.adminDays ?? 0) + 1;
        if (!p.admin && n >= T.adminAfterDays) {
          p.admin = { since: w.day };
          this.notices.push({ owner: p.id, hint: 'admin', msg: `Your city is in administration after ${plural(n, 'midnight')} below zero (${money(p.money)}). Building, buying, zoning and research are stopped and the regional grant for staff wages is withdrawn until the treasury is back above zero at midnight. The recovery plan (the red chip by the treasury): raise tax, sell empty land back, mothball services.` });
        } else if (n === 1 && !p.admin) {
          this.notices.push({ owner: p.id, hint: 'overdraft', msg: `The treasury is below zero (${money(p.money)}): you are on the ${money(T.overdraftLimit)} overdraft at ${Math.round(T.overdraftInterestPerDay * 100)}% interest a day. ${T.adminAfterDays} midnights below zero and the city goes into administration. Three levers: raise tax, sell empty land back, mothball services.` });
        }
      } else {
        if (p.admin) this.notices.push({ owner: p.id, msg: `Out of administration after ${plural(w.day - p.admin.since, 'day')}: the treasury is back above zero (${money(p.money)}). Building is open again and the regional grant pays half of staff wages again.` });
        delete p.admin; delete p.adminDays;
      }
      w.playersDirty = true;
    }
    for (const k of w.mothballed) { const b = w.buildings.get(k); if (!b || !mothballable(b)) w.mothballed.delete(k); }
    this.plans.clear();
  }

  /** The players message's `fin`: only while overdrawn, counting midnights, in administration or with something mothballed. */
  dto(p: Player): FinanceDTO | undefined {
    if (p.id === 'sys' || p.devUnlimited) return undefined;
    if (p.money >= 0 && !p.admin && !p.adminDays && !this.mothballedOf(p.id).length) return undefined;
    const T = ECONOMY_TUNING;
    return {
      limit: T.overdraftLimit, days: p.adminDays ?? 0, after: T.adminAfterDays,
      interest: p.money < 0 ? Math.round(-p.money * T.overdraftInterestPerDay * 100) / 100 : 0,
      ...(p.admin ? { admin: p.admin.since } : {}),
      plan: this.plan(p),
    };
  }

  private mothballedOf(owner: string): Building[] {
    const out: Building[] = [];
    for (const k of this.w.mothballed) { const b = this.w.buildings.get(k); if (b && this.w.parcelAt(b.x, b.y)?.owner === owner) out.push(b); }
    return out;
  }

  /** What each recovery action would do for this player now (cached for the game hour). */
  plan(p: Player): RecoveryPlanDTO {
    const w = this.w, T = ECONOMY_TUNING, hour = Math.floor(w.tick / TICKS_PER_HOUR);
    const hit = this.plans.get(p.id);
    if (hit && hit.hour === hour) return hit.plan;
    const plan: RecoveryPlanDTO = { taxRate: T.recoveryTaxRate, taxParcels: 0, taxPerDay: 0, sellParcels: 0, sellTiles: 0, sellCash: 0, mothball: 0, mothballPerDay: 0, mothballed: 0 };
    const share = w.payrollShare(p.id);
    let sellValue = 0;
    for (const q of w.parcels.values()) {
      if (q.owner !== p.id) continue;
      if (q.taxRate < T.recoveryTaxRate) {
        plan.taxParcels++;
        if (q.taxRate > 0) plan.taxPerDay += q.stats.taxYesterday * (T.recoveryTaxRate / q.taxRate - 1);
      }
      if (this.sellable(q)) { plan.sellParcels++; plan.sellTiles += q.w * q.h; sellValue += this.parcelPrice(q); }
      for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
        const b = w.buildings.get(tileKey(x, y));
        if (!b || !mothballable(b)) continue;
        if (w.mothballed.has(tileKey(x, y))) { plan.mothballed++; continue; }
        if (!isServiceId(b.id)) continue; // the plan's button leaves the yards alone (a building's panel can still mothball one)
        plan.mothball++;
        plan.mothballPerDay += upkeepOf(b.id, b.level) + b.occupants * wageOf(b.id, b.level) * share;
      }
    }
    plan.taxPerDay = Math.round(plan.taxPerDay);
    plan.mothballPerDay = Math.round(plan.mothballPerDay);
    plan.sellCash = Math.round(sellValue * T.landBuyback);
    this.plans.set(p.id, { hour, plan });
    return plan;
  }

  /**
   * Whether a parcel can go back to the region: nothing on it but roads and empty zoned lots (no building, no site, no
   * structure, track or tunnel, no civic kind, no bus stop or parking).
   */
  private sellable(q: Parcel): boolean {
    const w = this.w;
    for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
      const t = w.peekTile(x, y);
      if (t === undefined) continue;
      if (w.auxAt(x, y) || w.underAt(x, y) || underConstruction(t) || w.sites.has(tileKey(x, y))) return false;
      if (isRoad(t) || zoneOf(t) === Zone.None) continue;
      if (levelOf(t) > 0 || isCivicId(w.kindIdAt(x, y))) return false;
    }
    return true;
  }

  /** One recovery action (the `recover` intent). Returns the toast. */
  recover(p: Player, action: RecoverAction, keys?: string[]): { ok: boolean; msg: string } {
    const r = action === 'tax' ? this.raiseTax(p) : action === 'sell' ? this.sellLand(p)
      : action === 'mothball' || action === 'unmothball' ? this.mothball(p, action === 'mothball', keys) : null;
    if (!r) return { ok: false, msg: 'Unknown recovery action' };
    if (r.ok) { this.plans.delete(p.id); this.w.playersDirty = true; }
    return r;
  }

  private raiseTax(p: Player) {
    const R = ECONOMY_TUNING.recoveryTaxRate;
    let n = 0;
    for (const q of this.w.parcels.values()) {
      if (q.owner !== p.id || q.taxRate >= R) continue;
      q.taxRate = R; n++;
      this.w.dirtyParcels.add(q.id);
    }
    if (!n) return { ok: false, msg: `Every parcel of yours is taxed at ${Math.round(R * 100)}% or more already` };
    return { ok: true, msg: `Tax raised to ${Math.round(R * 100)}% on ${plural(n, 'parcel')}. Above that, workers start to look for jobs elsewhere` };
  }

  /** Every empty parcel of the player's goes back to the region: roads on it are taken up, the tiles become unclaimed. */
  private sellLand(p: Player) {
    const w = this.w;
    let n = 0, tiles = 0, value = 0;
    for (const q of [...w.parcels.values()]) {
      if (q.owner !== p.id || !this.sellable(q)) continue;
      value += this.parcelPrice(q);
      if (q.group !== undefined) w.leaveEstate(q.id, () => true);
      for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
        const t = w.peekTile(x, y);
        if (t !== undefined && (isRoad(t) || zoneOf(t) !== Zone.None)) w.setTile(x, y, packTile(terrainOf(t), false, 0, 0));
        w.setParcelId(x, y, 0);
      }
      w.parcels.delete(q.id);
      w.removedParcels.add(q.id); w.dirtyParcels.delete(q.id);
      tiles += q.w * q.h; n++;
    }
    if (!n) return { ok: false, msg: 'No land to sell back: every parcel of yours has something built or being built on it' };
    const cash = Math.round(value * ECONOMY_TUNING.landBuyback);
    w.credit(p.id, cash, 'land');
    return { ok: true, msg: `Sold ${plural(n, 'empty parcel')} (${tiles} tiles) back to the region for ${money(cash)}` };
  }

  /** Mothball (or reopen) the given doors, or with none every service of the player's (reopen: everything mothballed). */
  private mothball(p: Player, on: boolean, keys?: string[]) {
    const w = this.w;
    let list: Building[];
    if (Array.isArray(keys) && keys.length) {
      list = [];
      for (const k of keys.slice(0, 64)) {
        const b = w.buildings.get(String(k));
        if (!b) continue;
        if (w.parcelAt(b.x, b.y)?.owner !== p.id) return { ok: false, msg: 'Not your building' };
        if (!mothballable(b)) return { ok: false, msg: `A ${KIND_NAMES[b.id]} cannot be mothballed: only police, fire and health services and builders' yards` };
        list.push(b);
      }
    } else if (on) {
      list = [];
      for (const q of w.parcels.values()) {
        if (q.owner !== p.id) continue;
        for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
          const b = w.buildings.get(tileKey(x, y));
          if (b && mothballable(b) && isServiceId(b.id)) list.push(b);
        }
      }
    } else list = this.mothballedOf(p.id);
    const todo = list.filter((b) => w.mothballed.has(tileKey(b.x, b.y)) !== on);
    if (!todo.length) return { ok: false, msg: on ? 'Nothing to mothball: no open police, fire or health service of yours' : 'Nothing is mothballed' };
    const share = w.payrollShare(p.id);
    let saves = 0;
    for (const b of todo) { saves += upkeepOf(b.id, b.level) + b.occupants * wageOf(b.id, b.level) * share; w.setMothballed(b, on); }
    const what = todo.length === 1 ? `the ${KIND_NAMES[todo[0].id]}` : plural(todo.length, 'building');
    return {
      ok: true, msg: on
        ? `Mothballed ${what}: staff let go, no upkeep and no cover from ${todo.length === 1 ? 'it' : 'them'}, about ${money(saves)} a day saved. Reopen from the recovery plan or the building's panel`
        : `Reopened ${what}: ${todo.length === 1 ? 'it hires' : 'they hire'} staff again and the upkeep is back`,
    };
  }
}
