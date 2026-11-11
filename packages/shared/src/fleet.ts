import { MANIFEST, DESIGN_COUNT_TABLE, TOP_LEVEL_TABLE, KIND_ID } from './buildings/compiled';
import { LEVEL_SLOTS } from './buildings/codes';
import { hash2 } from './noise';
import { isRefuseSite } from './refuse';
import { designPick } from './leisure';
import type { Occupation } from './occupations';

/**
 * Mobile jobs (docs/mobile-jobs.md): people who work on the road. A worker keeps an ordinary job at a workplace; a
 * hash-seeded share of some workplaces' staff (all of a cab office's) work from a vehicle instead, the way a share of
 * bus depot staff are mechanics. Nothing here is stored: the role follows from the workplace and the citizen's id.
 */

/** The vehicle a mobile worker drives (wire bits 19-22). 0: not a fleet vehicle. */
export const FleetKind = { None: 0, Taxi: 1, PrivateHire: 2, Bicycle: 3, Moped: 4, CourierVan: 5, BinLorry: 6, Sweeper: 7, TradesVan: 8, SchoolBus: 9, UtilityVan: 10, Hearse: 11, RoadCrew: 12, Gritter: 13 } as const;
export type FleetKindId = typeof FleetKind[keyof typeof FleetKind];

/** Agent flag bits (protocol.ts packCitizenFlags; net.ts ORs them in): fleet kind in 19-22, loaded in 23, working in 24. */
export const FLEET_SHIFT = 19;
/** a taxi with a fare aboard (roof sign dark), a rider or van with something to deliver */
export const FLEET_LOADED = 1 << 23;
/** at a stop doing the job: bins on the lift, a rider or courier at the door, a sweeper's brushes down */
export const FLEET_WORKING = 1 << 24;
export const packFleet = (kind: number, loaded = false, working = false) => ((kind & 15) << FLEET_SHIFT) | (loaded ? FLEET_LOADED : 0) | (working ? FLEET_WORKING : 0);
export const citizenFleet = (f: number) => (f >> FLEET_SHIFT) & 15;
export const fleetLoaded = (f: number) => (f & FLEET_LOADED) !== 0;
export const fleetWorking = (f: number) => (f & FLEET_WORKING) !== 0;

/**
 * Server-side vehicle class of a two-wheeler: VEHICLE_LEN[4] long. It never goes on the wire (the class bits carry a
 * sedan's 0 and the fleet bits say what it is).
 */
export const BIKE_CLASS = 4;

/** What each fleet vehicle is called, and the job of whoever drives it. */
export const FLEET_LABEL: Record<number, string> = {
  1: 'taxi', 2: 'private hire car', 3: 'delivery bicycle', 4: 'delivery moped', 5: 'courier van', 6: 'bin lorry', 7: 'street sweeper', 8: 'trades van', 9: 'school bus', 10: 'repair van', 11: 'hearse',
  // severe weather (docs/weather.md W6): builders out of a yard clearing a fallen tree, or gritting the main roads
  12: 'road crew truck', 13: 'gritter',
};
export const FLEET_JOB: Record<number, string> = {
  1: 'taxi driver', 2: 'private-hire driver', 3: 'delivery rider', 4: 'delivery rider', 5: 'parcel courier', 6: 'refuse collector', 7: 'street sweeper driver', 8: 'tradesperson', 9: 'school bus driver', 10: 'lineworker', 11: 'funeral director',
  12: 'road crew', 13: 'gritter driver',
};

/** Who works on the road, and how many (shares are hash-seeded per lot or per citizen). */
export const MOBILE = {
  /** off: no mobile roles at all (the A/B control, loadtest ab.ts --set mobile=0) */
  on: true,
  /** 1×1 commercial lots that are cab offices: every member of staff drives */
  cabShare: 0.09,
  /** cab-office staff who own a car and drive private hire from home, on an app */
  privateHireShare: 0.45,
  /** staff of a food venue who are delivery riders, and the share of those on a bicycle (the rest ride mopeds) */
  riderShare: 0.25,
  bicycleShare: 0.55,
  /** industrial buildings that are parcel depots besides warehouses, freight yards and distribution centres; couriers among their staff */
  courierDepotShare: 0.18,
  courierShare: 0.35,
  /** industrial buildings that are waste and recycling depots; of their staff, bin crews and sweeper drivers (the rest sort and bale) */
  wasteDepotShare: 0.08,
  binCrewShare: 0.5,
  /** staff of a placed refuse site (shared/src/refuse.ts, M4) who are bin crews: most of them (the rest sort, tip and sweep) */
  siteCrewShare: 0.66,
  sweeperShare: 0.12,
  /** staff of a secondary school who drive its school bus (docs/education.md section 16): a school of 24 has two or three */
  schoolBusShare: 0.08,
  /** staff of a funeral director who drive its hearse (docs/remembrance.md) */
  hearseShare: 0.5,
  /** staff of a power depot who drive its repair vans (docs/utilities.md section 4.4; UTIL.crewShare) */
  lineworkerShare: 0.4,
};

/** School buses (sim/schoolbus.ts), the policy of shared/src/policies.ts. Hours of day; distances in Manhattan tiles. */
export const SCHOOLBUS = {
  /** pupils living further than this from their school are collected (nearer, they walk) */
  minDist: 12,
  seats: 40,
  maxStops: 12,
  /** the most tiles (Manhattan) a round may cover, school to the stops and back: a bus covers about a tenth of a tile a tick on its stops (measured, loadtest/policies.ts), so a round is one neighbourhood and is back before the bell */
  maxTour: 30,
  /** the morning round may leave between these hours, on a school day (the driver's shift starts at 04:30) */
  from: 4.75, until: 6.5,
  /** ticks at the kerb, and for each pupil who gets on */
  dwell: 3, perPupil: 1,
};

/** Taxis and private hire (sim/taxis.ts). Ticks unless noted; money in dollars. */
export const TAXI = {
  /** trips shorter than this (Manhattan tiles) are never taken by taxi */
  minTrip: 6,
  /** a free taxi further than this (Manhattan tiles) from the pickup is not offered */
  reach: 22,
  flagfall: 3,
  perTile: 0.45,
  /** a cab's fare: this share to the cab office's owner, the rest to the driver; private hire pays the office a commission */
  officeCut: 0.7,
  platformCut: 0.25,
  /** walking between 21:00 and 06:00 feels this much longer; driving to a night out (19:00 on, a drink or two) this much dearer */
  nightWalk: 1.6,
  outingCar: 2.6,
  /** how much a person minds paying for a taxi: fare × (min + span × hash) */
  priceTasteMin: 0.6,
  priceTasteSpan: 1.2,
  /** a passenger gives up and walks after max(waitMin, waitMul × the quoted wait) */
  waitMin: 60,
  waitMul: 3,
  /** a cab waits at a station or airport rank this close to its office between fares */
  rankReach: 20,
  /** ticks at the kerb to let someone in or out */
  pickupDwell: 4,
  dropDwell: 2,
};

/** Food delivery (sim/delivery.ts). Hours of day; rates are orders per household per day. */
export const FOOD = {
  lunch: [11.5, 14] as [number, number],
  dinner: [17.5, 22] as [number, number],
  lunchRate: 0.035,
  dinnerRate: 0.1,
  /** restaurants considered for an order (Manhattan tiles) */
  reach: 12,
  /** cooking time, game minutes */
  prepMin: 8,
  prepMax: 18,
  /** a rider takes up to batchMax ready orders at once for homes this close to the first */
  batchReach: 5,
  batchMax: 3,
  /** with this many orders waiting for a rider per rider on shift, no more are taken for now (the app says busy) */
  busyPerRider: 3,
  /** a rider is sent from at most this far (Manhattan tiles) from the kitchen, this many game minutes before the order is ready */
  riderReach: 7,
  leadMin: 8,
  mealBase: 8,
  fee: 2.5,
  tip: 1.5,
  /** an order nobody has picked up after this many game minutes is cancelled */
  cancelAfter: 60,
  /** ticks a rider stands at the door */
  doorDwell: 5,
  /** fraction of car speed in free flow */
  bicycleSpeed: 0.75,
  mopedSpeed: 1,
};

/** Refuse collection (sim/refuse.ts). */
export const REFUSE = {
  /** side of a collection district, tiles; each district has its own weekday (Monday to Friday) */
  district: 16,
  /** lorries leave from this hour on their district's day */
  startHour: 6.5,
  /** a depot serves districts whose centre is this close (Manhattan tiles) */
  reach: 40,
  /** crew on shift per lorry out */
  crew: 3,
  maxStops: 40,
  /** ticks at a stop: the lift, plus this for each home past the first */
  liftTicks: 5,
  perExtraHome: 2,
  /** paid by the home's parcel owner to the depot's owner for each home collected */
  feePerHome: 0.6,
  sweeperSpeed: 0.5,
};

/** Parcel couriers (sim/couriers.ts). */
export const COURIER = {
  /** parcels per household per day */
  parcelRate: 0.12,
  reach: 40,
  /** van departures (hour of day, jittered per van) */
  waves: [9, 13],
  vanLoad: 14,
  doorDwell: 5,
  /** to the depot's owner per parcel delivered */
  fee: 1,
};

// ---- roles ---------------------------------------------------------------------------------------------------------

const COMMERCIAL = KIND_ID.commercial, COM_DEEP = KIND_ID['com-deep'], COM_PARADE = KIND_ID['com-parade'], COM_CENTRE = KIND_ID['com-centre'];
const IND_DEPOT = KIND_ID['ind-depot'], SECONDARY = KIND_ID['secondary-school'], POWER_DEPOT = KIND_ID['power-depot'], FUNERAL = KIND_ID['funeral-director'];

/** Is this 1×1 commercial lot a cab office? A tile hash, so the sign (names.ts) and the server agree. */
export const isCabOffice = (kindId: number, x: number, y: number) => kindId === COMMERCIAL && hash2(x * 23 + 9, y * 19 + 4) < MOBILE.cabShare;
/** Does this commercial kind cook for delivery? Cafés, bars and restaurants on lots, deep plots, parades, shopping centres. */
export const isFoodVenue = (kindId: number, x: number, y: number) =>
  (kindId === COMMERCIAL && !isCabOffice(kindId, x, y)) || kindId === COM_DEEP || kindId === COM_PARADE || kindId === COM_CENTRE;

const INDUSTRIAL_IDS = new Uint8Array(256);
for (const k of MANIFEST) if (k.family === 'industrial') INDUSTRIAL_IDS[k.kindId] = 1;
/** storageDesign[kindId * LEVEL_SLOTS + level][design]: the model is a warehouse, container yard or freight depot */
const STORAGE: boolean[][] = [];
for (const k of MANIFEST) {
  if (k.family !== 'industrial') continue;
  for (const l of k.levels) STORAGE[k.kindId * LEVEL_SLOTS + l.level] = l.designs.filter((d) => !d.draft).map((d) => d.attrs.goodsType === 'storage' || d.attrs.goodsType === 'freight');
}
/** Is this industrial building a waste and recycling depot (bin lorries, street sweepers)? A tile hash, so its sign agrees. */
export const isWasteDepot = (kindId: number, x: number, y: number) => INDUSTRIAL_IDS[kindId] === 1 && kindId !== IND_DEPOT && hash2(x * 41 + 5, y * 13 + 17) < MOBILE.wasteDepotShare;
/** Is this a base for bin lorries: a placed refuse site (M4) or one of the old waste depots (a share of industry)? */
export const isRefuseDepot = (kindId: number, x: number, y: number) => isRefuseSite(kindId) || isWasteDepot(kindId, x, y);
/** Is this industrial building a parcel depot? Distribution centres, the warehouse and freight-yard models, and a hashed share of the rest. */
export function isCourierDepot(kindId: number, level: number, x: number, y: number): boolean {
  if (kindId === IND_DEPOT) return true;
  if (isWasteDepot(kindId, x, y)) return false;
  const lv = Math.min(level, TOP_LEVEL_TABLE[kindId] ?? 0), s = kindId * LEVEL_SLOTS + lv;
  const list = STORAGE[s];
  if (!list) return false;
  const n = Math.min(list.length, DESIGN_COUNT_TABLE[s] || list.length);
  if (n && list[Math.min(n - 1, Math.floor(designPick(x, y) * n))]) return true;
  return hash2(x * 29 + 3, y * 7 + 13) < MOBILE.courierDepotShare;
}

export interface MobileRole {
  kind: FleetKindId;
  /** the shift starts and ends at home (private hire), else at the workplace */
  fromHome: boolean;
}
/**
 * The road job of a worker at kind `kindId` (level `level`) at (wx, wy), or null for an ordinary job there. `car`: they
 * own a car (private hire drives its own).
 */
export function mobileRole(kindId: number, level: number, wx: number, wy: number, id: number, car: boolean): MobileRole | null {
  if (!MOBILE.on) return null;
  if (isCabOffice(kindId, wx, wy)) {
    return car && hash2(id, 431) < MOBILE.privateHireShare ? { kind: FleetKind.PrivateHire, fromHome: true } : { kind: FleetKind.Taxi, fromHome: false };
  }
  if (isFoodVenue(kindId, wx, wy)) {
    if (hash2(id, 433) >= MOBILE.riderShare) return null;
    return { kind: hash2(id, 435) < MOBILE.bicycleShare ? FleetKind.Bicycle : FleetKind.Moped, fromHome: false };
  }
  // a refuse site (docs/multiplayer-land.md M4, shared/src/refuse.ts): most of its staff are bin crews, a few drive sweepers
  if (isRefuseSite(kindId)) {
    const r = hash2(id, 437);
    return r < MOBILE.siteCrewShare ? { kind: FleetKind.BinLorry, fromHome: false } : r < MOBILE.siteCrewShare + MOBILE.sweeperShare ? { kind: FleetKind.Sweeper, fromHome: false } : null;
  }
  if (isWasteDepot(kindId, wx, wy)) {
    const r = hash2(id, 437);
    return r < MOBILE.binCrewShare ? { kind: FleetKind.BinLorry, fromHome: false } : r < MOBILE.binCrewShare + MOBILE.sweeperShare ? { kind: FleetKind.Sweeper, fromHome: false } : null;
  }
  if (kindId === SECONDARY && hash2(id, 441) < MOBILE.schoolBusShare) return { kind: FleetKind.SchoolBus, fromHome: false };
  if (kindId === FUNERAL && hash2(id, 445) < MOBILE.hearseShare) return { kind: FleetKind.Hearse, fromHome: false };
  // a power depot's lineworkers (docs/utilities.md section 4.4): repair vans out to faults on the owner's network
  if (kindId === POWER_DEPOT && hash2(id, 443) < MOBILE.lineworkerShare) return { kind: FleetKind.UtilityVan, fromHome: false };
  if (INDUSTRIAL_IDS[kindId] === 1 && hash2(id, 439) < MOBILE.courierShare && isCourierDepot(kindId, level, wx, wy)) return { kind: FleetKind.CourierVan, fromHome: false };
  return null;
}

const WEEK: number[][] = [[1, 1, 1, 1, 1, 0, 0], [1, 1, 0, 1, 1, 1, 0], [0, 1, 1, 1, 1, 1, 0], [1, 0, 1, 1, 0, 1, 1], [0, 0, 1, 1, 1, 1, 1]];
const occ = (name: string, shifts: Occupation['shifts'], cycles = WEEK): Occupation => ({ name, shifts, cycles, rotate: true, kind: 0 });
/**
 * The rota of each road job, used in place of the workplace's at hiring: taxis round the clock, riders at meal times,
 * couriers in the day, bin crews early. Days off rotate.
 */
export const FLEET_ROTA: Record<number, Occupation> = {
  [FleetKind.Taxi]: occ('taxi driver', [{ start: 6, hours: 8, weight: 0.3 }, { start: 14, hours: 8, weight: 0.3 }, { start: 18, hours: 8, weight: 0.25 }, { start: 22, hours: 8, weight: 0.15 }]),
  [FleetKind.PrivateHire]: occ('private-hire driver', [{ start: 7, hours: 8, weight: 0.25 }, { start: 11, hours: 8, weight: 0.2 }, { start: 16, hours: 8, weight: 0.35 }, { start: 20, hours: 7, weight: 0.2 }]),
  [FleetKind.Bicycle]: occ('delivery rider', [{ start: 11, hours: 4, weight: 0.3 }, { start: 17, hours: 6, weight: 0.5 }, { start: 11, hours: 10, weight: 0.2 }]),
  [FleetKind.Moped]: occ('delivery rider', [{ start: 11, hours: 4, weight: 0.25 }, { start: 17, hours: 6, weight: 0.5 }, { start: 11, hours: 10, weight: 0.25 }]),
  [FleetKind.CourierVan]: occ('parcel courier', [{ start: 8, hours: 8, weight: 0.8 }, { start: 10, hours: 8, weight: 0.2 }], [[1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 0, 0], [0, 1, 1, 1, 1, 1, 0]]),
  // a school bus driver works the school week (Monday to Friday, fixed), from before the first pupil is up (04:30)
  // lineworkers round the clock: a fault at 03:00 is somebody's call-out
  [FleetKind.UtilityVan]: occ('lineworker', [{ start: 7, hours: 8, weight: 0.45 }, { start: 15, hours: 8, weight: 0.35 }, { start: 23, hours: 8, weight: 0.2 }]),
  [FleetKind.SchoolBus]: { name: 'school bus driver', shifts: [{ start: 4.5, hours: 11, weight: 1 }], cycles: [[1, 1, 1, 1, 1, 0, 0]], rotate: false, kind: 0 },
  [FleetKind.BinLorry]: occ('refuse collector', [{ start: 6, hours: 8, weight: 1 }], [[1, 1, 1, 1, 1, 0, 0]]),
  // a funeral director's hearse driver works the funeral director's day (docs/remembrance.md)
  [FleetKind.Hearse]: occ('funeral director', [{ start: 8, hours: 10, weight: 1 }], [[1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 0, 1, 1], [0, 1, 1, 1, 1, 1, 1]]),
  [FleetKind.Sweeper]: occ('street sweeper driver', [{ start: 6, hours: 8, weight: 0.7 }, { start: 14, hours: 8, weight: 0.3 }], [[1, 1, 1, 1, 1, 0, 0]]),
};

/** The weekday (0 Monday .. 4 Friday, as day % 7) bins are collected in the district holding (x, y). */
export function binDay(x: number, y: number): number {
  const d = REFUSE.district;
  return Math.floor(hash2(Math.floor(x / d) * 31 + 7, Math.floor(y / d) * 17 + 5) * 5);
}

/** A road job in a panel (CitizenInfo.fleet): a worker's, or the vehicle's own. */
export interface FleetInfo {
  kind: number;
  /** the vehicle out on the road now (select it to follow) */
  vehicle?: number;
  /** what it is doing now */
  task: string;
  /** today's fares, deliveries, homes or parcels, and the money taken */
  today?: { jobs: number; money: number };
  /** stops still to make */
  stops?: number;
  /** a worker's base, by name ("Ace Cars cab office") */
  base?: string;
}
/** A building's road-work section in its tooltip (BuildingInfo.mobile): a cab office, a restaurant, a depot, a home. */
export interface MobileRows { role: string; rows: [string, string][] }
