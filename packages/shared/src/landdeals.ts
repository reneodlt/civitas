import { Zone } from './buildings/codes';
import { familyOf, KIND_NAMES } from './tile';
import { isLeisure, leisureSpecs } from './leisure';
import { refuseGradeOf } from './refuse';
import { isPowerPlant, UTIL_POLLUTION_OF } from './utilities';

/**
 * The land market (docs/multiplayer-land.md section 7 "Land", M7): listings and offers, covenants, leases and neighbour
 * pacts. Browser-safe: the types on the wire, the tuning and the covenant and strip rules both sides check (the server
 * is the authority: server/src/sim/landdeals.ts).
 */

/**
 * Covenants on a parcel, set by a seller when listing and binding every later owner (they ride on the parcel, are copied
 * to both parts of a split and joined on a merge; they are never lifted).
 * - `noHeavy`: no industrial zoning and no heavy nuisance building (refuse sites, polluting power stations, airports).
 * - `park`: only parks (and roads): no zoning, no other building, no parking lots or bus stops.
 * - `maxLevel`: no building grows past this level.
 */
export interface Covenant { noHeavy?: 1; park?: 1; maxLevel?: number }

export interface Rect { x: number; y: number; w: number; h: number }

/** A parcel (or an estate) for sale. Days are game days. */
export interface ListingDTO {
  id: number; seller: string;
  /** the parcels sold together (an estate's members, or one) */
  parcels: number[];
  price: number;
  /** covenants the land takes on at the sale */
  cov?: Covenant;
  listed: number; expires: number;
}
/** An offer for a listing; the buyer's money is checked when it is made and again on acceptance (no escrow). */
export interface OfferDTO { id: number; listing: number; buyer: string; amount: number; day: number }
/** A lease on offer: `tenant` set: only that player may take it. */
export interface LeaseOfferDTO { id: number; parcel: number; landlord: string; rent: number; days: number; tenant?: string; expires: number }
/** A lease running: the tenant holds the parcel (builds and collects as owner) until `end`, paying `rent` each midnight. */
export interface LeaseDTO { id: number; parcel: number; landlord: string; tenant: string; rent: number; start: number; end: number }
/**
 * A neighbour pact: a buffer strip on parcels `pa` (proposer's) and `pb` (the neighbour's) kept free of nuisance buildings.
 * Proposed until the neighbour accepts; `ends` set once either side gave notice.
 */
export interface PactDTO { id: number; a: string; b: string; pa: number; pb: number; strip: Rect; state: 'proposed' | 'active'; day: number; ends?: number }

/** What the server tells each client: every listing, lease and pact, and the offers they made or received. */
export interface DealsView { listings: ListingDTO[]; offers: OfferDTO[]; leaseOffers: LeaseOfferDTO[]; leases: LeaseDTO[]; pacts: PactDTO[] }

export type LandDealMsg =
  | { t: 'land'; op: 'list'; id: number; price: number; estate?: boolean; cov?: Covenant }
  | { t: 'land'; op: 'unlist'; listing: number }
  | { t: 'land'; op: 'offer'; listing: number; amount: number }
  | { t: 'land'; op: 'buy'; listing: number }
  | { t: 'land'; op: 'accept' | 'reject' | 'withdraw'; offer: number }
  | { t: 'land'; op: 'lease'; id: number; rent: number; days: number; tenant?: string }
  | { t: 'land'; op: 'leaseAccept' | 'leaseCancel'; lease: number }
  | { t: 'land'; op: 'pact'; pa: number; pb: number; strip: Rect }
  | { t: 'land'; op: 'pactAccept' | 'pactEnd'; pact: number };

export const LAND_DEALS = {
  /** a listing (and its offers) lapses after this many game days */
  listingDays: 7,
  /** a lease offer or a pact proposal lapses after this many days */
  offerDays: 7,
  /** lease terms, in days */
  leaseMinDays: 1, leaseMaxDays: 60,
  /** a pact ends this many days after either side gives notice */
  pactNoticeDays: 3,
  /** most open listings, lease offers and pact proposals one player may have at a time */
  maxOpen: 40,
  /** the most a price or a day's rent may be */
  maxPrice: 100_000_000,
};

const HEAVY = new Uint8Array(256);
const PARK = new Uint8Array(256);
for (let k = 1; k < 256; k++) {
  if (familyOf(k) === Zone.Industrial || refuseGradeOf(k) !== undefined || (isPowerPlant(k) && UTIL_POLLUTION_OF[k] > 0) || k === Zone.Airport) HEAVY[k] = 1;
  if (isLeisure(k) && [0, 1].some((l) => leisureSpecs(k, l).some((s) => s.type === 'park'))) PARK[k] = 1;
}
/** Heavy nuisance kinds, by kind id: industry, refuse sites, polluting power stations, the airport. */
export const isHeavyNuisanceKind = (kind: number) => HEAVY[kind] === 1;
/** Parks (leisure kinds whose venue is a park). */
export const isParkKind = (kind: number) => PARK[kind] === 1;

const kname = (k: number) => KIND_NAMES[k] ?? 'that';
/**
 * Why a covenant forbids building or zoning `kind` (a kind id; a zone tool passes its family's base kind; the parking lot
 * Zone.Parking), or null. Roads are never refused.
 */
export function covenantRefusal(cov: Covenant | undefined, kind: number): string | null {
  if (!cov) return null;
  if (cov.park && !isParkKind(kind)) return `This land has a covenant: it stays a park (only parks and roads; no ${kname(kind)})`;
  if (cov.noHeavy && isHeavyNuisanceKind(kind)) return `This land has a covenant: no heavy industry (no ${familyOf(kind) === Zone.Industrial ? 'industrial zoning' : kname(kind)})`;
  return null;
}
/** Whether a covenant lets a building grow to `level`. */
export const covenantAllowsLevel = (cov: Covenant | undefined, level: number) => !cov?.maxLevel || level <= cov.maxLevel;
/** The covenants in words, for the parcel panel ('' for none). */
export function covenantText(cov: Covenant | undefined): string {
  if (!cov) return '';
  const out: string[] = [];
  if (cov.noHeavy) out.push('no heavy industry');
  if (cov.park) out.push('stays a park');
  if (cov.maxLevel) out.push(`no building over ${cov.maxLevel} level${cov.maxLevel === 1 ? '' : 's'}`);
  return out.join(' · ');
}
/** A clean covenant from the wire (unknown fields dropped), or undefined when it says nothing. */
export function cleanCovenant(c: unknown): Covenant | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const o = c as Record<string, unknown>, out: Covenant = {};
  if (o.noHeavy) out.noHeavy = 1;
  if (o.park) out.park = 1;
  const n = Math.floor(Number(o.maxLevel));
  if (Number.isFinite(n) && n >= 1 && n <= 7) out.maxLevel = n;
  return out.noHeavy || out.park || out.maxLevel ? out : undefined;
}
/** Two parcels' covenants together (the strictest of each): what a merged parcel keeps. */
export function joinCovenants(a: Covenant | undefined, b: Covenant | undefined): Covenant | undefined {
  if (!a) return b && { ...b };
  if (!b) return { ...a };
  const out: Covenant = { ...a };
  if (b.noHeavy) out.noHeavy = 1;
  if (b.park) out.park = 1;
  if (b.maxLevel) out.maxLevel = Math.min(b.maxLevel, a.maxLevel ?? 7);
  return out;
}
/** Why a pact's buffer strip forbids `kind` (no heavy nuisance buildings), or null. */
export const stripRefusal = (kind: number) => isHeavyNuisanceKind(kind) ? `That is inside a neighbour pact's buffer strip: no ${familyOf(kind) === Zone.Industrial ? 'industrial zoning' : kname(kind)} there` : null;

export const rectsOverlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const inRect = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** The land market state in a snapshot (optional field `landDeals`; covenants ride on the parcels themselves). */
export interface LandDealsSave extends DealsView { next: number }
