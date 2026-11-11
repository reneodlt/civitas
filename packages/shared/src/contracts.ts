import { REFUSE } from './fleet';
import { UTIL } from './utilities';

/**
 * Service contracts between players (docs/multiplayer-land.md section 7 "Services", M8). Browser-safe: the types on the
 * wire, the tuning and the regional reference prices both sides show (the server is the authority:
 * server/src/sim/contracts.ts).
 *
 * - A provider posts a public **tariff** per service: refuse a home a day, power a unit. It may not be above the
 *   regional reference price (`regionalPrice`), so nobody is held hostage.
 * - A buyer **signs** a parcel or an estate up with a provider at the posted price, fixed for the term (days). Either side
 *   may give `CONTRACTS.noticeDays` days' notice; nobody cuts the service mid-contract.
 * - While it runs, the provider's network (power) walks the buyer's roads and the provider's refuse sites take the
 *   rounds for the buyer's homes, for that service only.
 * - Billing is hourly: the buyer pays (`services`), the provider is paid (`contracts`).
 *
 * Water joins when the water network is built (docs/utilities.md U3): `ServiceId` and `regionalPrice` take it then.
 * Tenders ("refuse collection for 400 homes for 10 days", providers bid) are later.
 */
export type ServiceId = 'refuse' | 'power';
export const SERVICE_IDS: readonly ServiceId[] = ['refuse', 'power'];
export const SERVICE_NAMES: Record<ServiceId, string> = { refuse: 'Refuse collection', power: 'Power' };
/** what a price is for */
export const SERVICE_UNIT: Record<ServiceId, string> = { refuse: 'a home a day', power: 'a unit' };

export const CONTRACTS = {
  /** either side may leave with this many game days' notice */
  noticeDays: 3,
  /** terms, in game days */
  minDays: 3, maxDays: 60,
  /** the most contracts one buyer may have running at a time */
  maxOpen: 40,
  /** billing runs at this tick of each game hour (staggered from the utilities' solve at 41) */
  billAt: 47,
};

/**
 * The regional supplier's price for a service: what the buyer pays without a contract, and the most a provider may post.
 * - refuse: the old waste depots' fee (REFUSE.feePerHome a weekly collection, from the home's owner to the depot's),
 *   spread over the week: about $0.086 a home a day;
 * - power: grid import, UTIL.importPrice a unit ($0.06), what a network pays the National Grid.
 */
export function regionalPrice(s: ServiceId): number {
  return s === 'refuse' ? REFUSE.feePerHome / 7 : UTIL.importPrice;
}
/** A price in words: "$0.086 a home a day" */
export const priceText = (s: ServiceId, price: number) => `$${price < 1 ? price.toFixed(3) : price.toFixed(2)} ${SERVICE_UNIT[s]}`;

/** A posted tariff: anyone may sign up at this price while it stands. */
export interface TariffDTO { owner: string; service: ServiceId; price: number; day: number }
/**
 * A contract running: `buyer` (the parcels' owner) pays `price` (fixed at signing) to `provider` for `service` on
 * `parcels` from day `start` to day `end`; `ends` and `noticeBy` once either side gave notice.
 */
export interface ServiceContractDTO {
  id: number; service: ServiceId; provider: string; buyer: string; parcels: number[]; price: number;
  start: number; end: number; ends?: number; noticeBy?: string;
  /** paid so far, and in the last hour billed (dollars) */
  paid: number; last: number;
}
/** What each client is sent: every tariff (public), the regional prices, and the contracts they are a party to. */
export interface ServicesView { tariffs: TariffDTO[]; contracts: ServiceContractDTO[]; regional: Record<ServiceId, number> }
/** A provider's offer to one parcel, for the buyer's panel (`svcQuotes`): its tariff and whether its network or sites reach. */
export interface ServiceQuote { provider: string; service: ServiceId; price: number; reach: boolean; why?: string }

export type ServiceMsg =
  /** post (or change) a tariff; a price of null withdraws it (running contracts keep their price) */
  | { t: 'svc'; op: 'tariff'; service: ServiceId; price: number | null }
  /** sign parcel `id` (or its whole estate) up with `provider` for `days` at the provider's posted price */
  | { t: 'svc'; op: 'sign'; id: number; service: ServiceId; provider: string; days: number; estate?: boolean }
  /** give notice on a contract (either side) */
  | { t: 'svc'; op: 'notice'; contract: number }
  /** the providers that could serve parcel `id`, answered with `svcQuotes` */
  | { t: 'svc'; op: 'quote'; id: number };

/** The snapshot's optional `contracts` field. */
export interface ContractsSave { next: number; tariffs: TariffDTO[]; contracts: ServiceContractDTO[] }
