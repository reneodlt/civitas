import {
  MOTORWAY_KIND,
  ruleLines, turnAllowed, TICKS_PER_DAY, TICKS_PER_HOUR, gameMin, MAX_LEVEL, WALK_SPEED, DRIVE_SPEED, pedestrianDeliveryOpen, auxClass, oneWayDir, carStepOk, SERVICE_RADIUS, TRAFFIC_TUNING as TT, signalWaitMax,
  DRIVE_MIN_TILES, CAR_FETCH_RADIUS, PARK_RADIUS, PARKING_FEE, KERB_CAP, FREIGHT_TRIPS_PER_LEVEL_PER_DAY, VISITORS_PER_100_PEAK_HOUR,
  KIND_ID, campStage, chainActive,
  Zone, CitizenState, VehicleClass, VehicleKind, KIND_COUNT, KIND_ID_COUNT, KIND_NAMES, CIVIC_UPKEEP, CONSTRUCTION_FEE, MAX_BUILDERS_PER_SITE, CAMP_KIND,
  capacityOf, parkingOf, wageOf, upkeepOf, workOf, familyOf, isGrowableId, isCivicId, isServiceId, isParkingId,
  withLevel, withProgress, progressOf, isRoad, tileKey, parseKey, mod,
  OCCUPATIONS, pickShift, hoursToTicks, hasFeature, levelFeature, nameFor, surnameFor, hash2, LifeStage, LIFE_STAGE_NAMES,
  LEISURE_CODES, LEISURE_MAX_RADIUS, VENUE_TYPE_INDEX, VENUE_WORDS, parkActivity, EVENT_NAMES, WEEKDAY_NAMES, leisureAt, isLeisure, isOpenAt, eventOn, eventStartAt, nextEvent,
  type LeisureSpec, TRANSIT, stopModeOf, stopName, walkCost, BUS_DEPOT_KIND, TAXI, FLEET_JOB,
  SERVICE_RADIUS_OF, SERVICE_STRENGTH_OF, WORK_RATE_OF, PATROL_RATE_OF,
  GROW_FORMS, topLevelOf, firstLevelOf, isMergedKind, venueCapacityOf, isMultiTile, placedFromAnchor, planStructure, packTile, terrainOf,
  zoneOf, isBuildable, underConstruction, isGatewayId, GATEWAY_OF, GATEWAY_WORDS, bridgeSpanAt, BRIDGE_STYLE_NAMES,
  type GoalId, type BuildingInfo, type BuildingPeople, type PersonRow, type RoadInfo, type BusInfo, type CitizenInfo, type CitizenLife, type PersonRef,
  buildingValue, LAND_PRICE_PER_TILE, ROAD_COST,
  eduDefaults, birthdayOf, yearGroup, STAGES, Study, EduResult, EDU_NURSERY, EDU_DROPPED, EDU_HOMEWARD, CITIZEN_STUDY, type CitizenEducation,
  SKILLS, wageMul, EduLevel, type EduFields, MOTIVE, type FocusInfo,
} from '@msimcity/shared';
import type { Building, Citizen, Leg, Mover, Vehicle, World, MergePlan } from '../world';
import { noteTrail, resetTrail, tkey, untkey, lifeDefaults, citizenLater, hasJobs } from '../world';
import {
  LIFE, HEALTH, Cond, ACUTE, COND_NAMES, ageOf, stageFor, seededAge, fluWave, healthTarget,
  noteIncome, noteSpend, week, today, happinessParts, happinessOf,
  LEISURE, leisureTier, leisureNeed, noteLeisureVisit, leisureDay,
} from './life';
import { findPath, findPaths, findBest, findRoute, pathBetween, pathStillValid, SEARCH } from '../pathfinding';
import { PhaseStats, CI } from '../perf/phases';
import { Traffic, crossMask, dirBetween, hypot } from './traffic';
import { indicatorOf } from './indicators';
import { Transit, BusService, isMechanic } from './transit';
import { vehicleTrain } from './timetabled';
/** rows of a bus's roster (a full bus is far fewer; this only cuts a pathological one), as a train's */
const BUS_ROSTER_CAP = 200;
import { Carpool, CARPOOL, householdShare, coworkerShare, friendShare, type Candidate } from './carpool';
import { Gateways, MIG, type Gate } from './gateways';
import { TrafficControl } from './control';
import { Mobile, FLEET_VKIND } from './mobile';
import { Taxis } from './taxis';
import { Delivery } from './delivery';
import { Refuse } from './refuse';
import { Couriers } from './couriers';
import { Skills, Place } from './skills';
import { plantGardens, deepBackOk, GARDEN_KIND } from './blocks';
import { Schools, ERRAND_SCHOOL } from './schools';
import { FirstFive } from './firstfive';
import { START_TUNING } from '@msimcity/shared';
import { Families } from './families';
import { Learning, ERRAND_CLASS } from './learning';
import { Death, ERRAND_FUNERAL } from './death';
import { Motivation, MOTIVATION, inheritValues, essentialJob, type MotiveHost } from './motivation';

const DAY = TICKS_PER_DAY, TPH = TICKS_PER_HOUR;
const GROWTH_EVERY = gameMin(24), SPAWN_EVERY = gameMin(24), STATS_EVERY = 5, JOB_SEARCH_EVERY = gameMin(60), SITE_SEARCH_EVERY = gameMin(24);
const DISPATCH_EVERY = 10, ENTRIES_EVERY = 100, REROUTE_EVERY = 25, SWEEP_EVERY = 500;
const MAX_IDLE_DAYS = 3;
const HOME_TAX_BASE = 40;          // property tax = base * parcel tax rate, per citizen per day at home
const REST_TICKS = 4 * TPH;        // minimum time at home between shifts
const PRE_STOP_TICKS = Math.round(0.7 * TPH);
const P_PRE_STOP = 0.15;           // café before work
const P_AFTER_EVENING = 0.45;      // bar/restaurant after a shift ending in the evening
const P_AFTER_OTHER = 0.12;
const OUTING_RATE = 0.03 / TPH;    // per tick chance of going out while free between 11:00 and 23:00
const VENUE_MIN = 1 * TPH, VENUE_MAX = 3 * TPH;
const MIN_SPENDING_MONEY = 10;
// leisure places (parks, cinemas, theatres, sports halls, libraries; attributes in shared/src/buildings/leisure.ts)
const LEISURE_TRIP_MAX = 40;        // tiles (Manhattan) anyone will go for a day or night out
const CHILD_TRIP_MAX = 14;          // children go out on their own only to free places this close to home
const CHILD_OUT_AGE = 8;            // and only from this age, by day
const BAR_YARDSTICK = 0.55;         // a leisure place must out-score a bar visit worth this (times noise) to be chosen
const EVENT_PULL = 2.6;             // appeal multiplier around an event's start
const EVENT_TICKET = 1.5;           // event nights cost more
const LEISURE_GROWTH_P = 0.3;       // chance per growth pass that a park busy enough opens an upgrade site
// merged lots (shared/src/zones.ts): a building ready to grow may merge with neighbouring lots of its zone and owner
const MERGE_P = 0.5;                // chance a growth that could also happen in place tries a merge first
const MERGE_JUMP = 2;               // a merge raises the level by at most this much
const MERGE_SEARCHES_PER_PASS = 24; // merge searches (each a few hundred tile reads at most) per growth pass
const MERGES_PER_PASS = 8;          // merges opened per growth pass (they share one pass over the citizens)
const MERGE_SITES_PER_PARCEL = 2;   // merges being built at once in one parcel: a neighbourhood rebuilds a block or two at a time
const BUILD_RATE = 50 / TPH;       // work units per builder per tick
const FEE_PER_UNIT = CONSTRUCTION_FEE / 2;
const PRIORITY_WEIGHT = 40;        // one priority step is worth this many tiles of extra travel
/** A handyman's crew in the camp stage (shared campStage) works a civic site this many tiles of travel after the lots (two priority steps). */
const CAMP_WAIT = 2 * PRIORITY_WEIGHT;
const LEAD_SLACK = gameMin(5);
const ROUTE_BUDGET = 40;           // A* searches per tick for re-routing
const FREIGHT_FEE = 3, VISITOR_SPEND = 5;
// inter-city freight through motorway connections (sim/gateways.ts): lorries in per shop per day, share of factory deliveries sent out
const IMPORTS_PER_SHOP_PER_DAY = 0.4, EXPORT_SHARE = 0.08, MOTORWAY_VISITORS_PER_HOUR = 24, MOTORWAY_LORRIES_PER_HOUR = 12;
const FREIGHT_DWELL = gameMin(15), CALLOUT_DWELL = gameMin(20);
const PATROL_EVERY = 1.5 * TPH, CALLOUT_EVERY = 3 * TPH;
// dispatch: every building is rolled once per DISPATCH_EVERY ticks (a rotating slice each tick); the trips it
// decides on queue up and at most DISPATCH_BUDGET start per tick (one A* each), so no tick takes the whole load
const DISPATCH_BUDGET = 60, DISPATCH_QUEUE_MAX = 600;
const FREIGHT_RADIUS = 40;                        // tiles (Manhattan) a delivery looks for a shop within
const FREIGHT_MAX_SCORE = 2 * MAX_LEVEL + 3, VISITOR_MAX_SCORE = 5 + MAX_LEVEL, PATROL_MAX_SCORE = 6;
const FREIGHT_NODES = 1500, VISITOR_NODES = 2500, PATROL_NODES = 1200; // fallback road searches
const VEHICLE_ID_BASE = 1 << 30;
const PEOPLE_ROW_CAP = 80;           // rows per list in the building panel
/** a fire engine on a call (Mover.call) stopped this many ticks (in traffic or at its door) drives on down the middle of the road (Simulation.weave), at this share of the speed */
const WEAVE_AFTER = 8, WEAVE_SPEED = 0.6;
const GARAGE_WAIT_MAX = 150;          // ticks a car will wait for a gap to pull out before the trip is abandoned

const S = CitizenState;
/**
 * CITIZEN_STUDY for a pupil or student on the way to or back from school (pupils use ToWork and Work for school;
 * docs/education.md): sim/schools.ts marks the trip home from school (EDU_HOMEWARD), so the walk back from the park does not.
 */
const studyFlag = (c: Citizen) => (c.study && (c.state === S.ToWork || (c.state === S.ToHome && (c.eduBits & EDU_HOMEWARD))) ? CITIZEN_STUDY : 0);
/** A trip dispatch decided on: from a building (freight, patrols, call-outs) or an entry tile (visitors). */
/**
 * A job search from a home that found nothing (Simulation.findJob): the tiles it looked at, padded by two for the
 * junction rules a step reads round it, the World.jobEdits count it ran at, and the full workplaces it passed.
 */
interface JobMiss { x0: number; y0: number; x1: number; y1: number; edits: number; full: Building[] }
interface DispatchJob {
  vkind: number; b: Building | null; entry: [number, number] | null;
  /** harbour freight (sim/harbours.ts): the buyer is already chosen, and what it pays on delivery */
  to?: [number, number]; fee?: number;
}
const VEHICLE_LABEL: Record<number, string> = { [VehicleKind.Freight]: 'delivery truck', [VehicleKind.Visitor]: 'visitor', [VehicleKind.Patrol]: 'police patrol', [VehicleKind.FireEngine]: 'fire engine', [VehicleKind.Ambulance]: 'ambulance' };

/**
 * Tick-based city simulation. Everything here operates on the shared World and
 * is independent of networking: it could run in a worker or a separate shard.
 *
 * Citizens are free agents. They live where they spawned, take the nearest
 * reachable job of any kind in any parcel, keep that occupation's hours, walk
 * or drive to it (and park, or hunt for a lot, or block the kerb), stop at
 * cafés and bars, pay tax where they work, live and spend, and leave if life
 * gets too expensive. Builders are citizens too: nothing is built until they
 * reach the site. Freight, visitors and patrols share the roads with them.
 */
/** What a driver's leg was expected to take when it set off, and how many times it has been re-routed since. */
interface LegTrack { leg: Leg | null; at0: number; exp0: number; at: number; exp: number; n: number; tripAt: number; trip: number; day: number; dayN: number }

/** Whether b is the first workplace of its kind and level a search has offered (motivation's candidates differ); notes it. */
function newKind(seen: Set<number>, b: Building): boolean {
  const k = b.id * 16 + b.level;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
}

export class Simulation {
  population = 0; jobs = 0; employed = 0; vacantJobs = 0;
  /** children in town (families move in with them, sim/families.ts): homes are built for the grown-ups the jobs need */
  children = 0;
  moving = 0; driving = 0; outAndAbout = 0; parkedCars = 0;
  traffic: Traffic;
  private services: Building[] = [];
  private visitors = new Map<string, number>();
  private entries: [number, number][] = [];
  /** the entries are motorway connections (sim/gateways.ts): inter-city freight runs through them */
  private motorway = false;
  private routeBudget = 0;
  /** tick phase timings and work counters (perf/phases.ts, docs/perf.md); game.ts closes each tick */
  readonly perf = new PhaseStats();
  private searchSeen = { routes: 0, nodes: 0 };
  /**
   * Per-driver re-route bookkeeping (trip and day counts, and the leg's expected time at departure for the cumulative-delay
   * re-route). A WeakMap so a removed mover takes its record with it; a mover with no record (loaded mid-leg) is never "late".
   */
  private legTrack = new WeakMap<Mover, LegTrack>();
  /** Re-routes by kind since the simulation started, and per game day (the harness reads these). */
  rerouteLog = { slow: 0, late: 0, forced: 0, lateTried: 0, byDay: new Map<number, number>() };
  /** When set, every driven leg that ends pushes [elapsed ticks, expected ticks at departure] here (offline measurement). */
  legSamples: [number, number][] | null = null;
  private nextVehicleId = VEHICLE_ID_BASE;
  private dispatchQueue: DispatchJob[] = [];
  /** citizens at each venue right now (AtVenue, not doctor's visits), for friendships made over a drink */
  private guests = new Map<string, Set<number>>();
  /** rebuilt once a game day on first use: who works where and who lives on which parcel, for partners and friends */
  private social = { day: -1, work: new Map<number, number[]>(), parcel: new Map<number, number[]>() };
  /** life events since the simulation started (probes and tests read these) */
  lifeEvents = { births: 0, deaths: 0, deathsOldAge: 0, deathsIllness: 0, partners: 0, movedIn: 0, movedOut: 0, leftTown: 0, friendships: 0, doctorVisits: 0, sickDaysOff: 0, orphansLeft: 0, graduations: 0, dropOuts: 0 };
  private today = 0;
  /** visits per venue tile (leisure places, cafés and bars): today's and yesterday's count (parks grow with use; tooltips and the issue bubbles read them) */
  private venueVisits = new Map<string, { day: number; today: number; yesterday: number }>();
  /** leisure coverage per home tile (tkey), recomputed at most once a game hour */
  private leisureCache = new Map<number, { at: number; score: number; parks: number; nParks: number; nVenues: number }>();
  /** Job searches from a home that found nothing, by tkey of the home (findJob). */
  private jobMisses = new Map<number, JobMiss>();
  /** arrivals since the simulation started, by venue type ('bar' for cafés, bars and restaurants) and hour of day (probes read this) */
  leisureStats: Record<string, number[]> = {};
  /** the same by life stage (LifeStage: adult, child, retired) */
  leisureByStage: Record<string, number[]> = {};

  /** public transport (sim/transit.ts): every mode's lines and riders; buses are one of its services */
  transit: Transit;
  buses: BusService;
  /** car sharing (sim/carpool.ts): who rides in whose car */
  pool: Carpool;
  /** gateways (sim/gateways.ts): where newcomers arrive and leavers go out */
  gateways: Gateways;
  /** traffic control (R5): freight routing round HGV bans and 20 zones, the visitor limit, the lorry curfew, the Traffic panel */
  control: TrafficControl;
  /** mobile jobs (sim/mobile.ts, docs/mobile-jobs.md): workers on the road, and the taxi service */
  mobile: Mobile;
  taxis: Taxis;
  delivery: Delivery;
  refuse: Refuse;
  couriers: Couriers;
  /** schools (sim/schools.ts, docs/education.md): admissions, the school day, results */
  schools: Schools;
  /** jobs, wages and migration by education (sim/skills.ts, docs/education.md section 7) */
  skills: Skills;
  /** drivers a building turned away who found no lot in reach and parked at the kerb, by building tile key; drained by sim/issues.ts */
  kerbOut = new Map<string, number>();
  /** Visits to a venue (leisure place, café or bar) today and yesterday (sim/issues.ts: no customers). */
  visitsOf(key: string) { return this.visitsAt(key); }
  /** The staffed police, fire and health buildings coverage counts (rebuilt every few ticks): the coverage overlay (server/src/overlays.ts). */
  get staffedServices(): readonly Building[] { return this.services; }
  /** families moving in with children (sim/families.ts), and higher and adult education (sim/learning.ts), docs/education.md section 18 */
  families: Families;
  learning: Learning;
  /** death and remembrance (sim/death.ts, docs/remembrance.md): the dead, their funerals and graves, the grieving */
  death: Death;
  /** the first five minutes (sim/firstfive.ts, docs/first-five.md): the camp's settlers, the starter crew, the first-settlers moment */
  start: FirstFive;
  /** utilities (sim/utilities.ts, docs/utilities.md): whether building b may grow to `target` (level 2 and up need power); set by game.ts */
  powerGate: ((b: Building, target: number) => boolean) | null = null;
  /** what citizens care about and the choices they score with it (sim/motivation.ts, docs/motivation.md M1-M2) */
  motive: Motivation;
  private motiveHost: MotiveHost;
  /** adds the tiles growth must leave alone this pass (sim/fires.ts: buildings on fire), as tkeys; set by game.ts */
  held: ((into: Set<number>) => void) | null = null;
  /** messages for a parcel owner's screen (net.ts sends them as toasts and clears the list) */
  notices: { owner: string; msg: string }[] = [];
  /** owners already told that newcomers spawn in place; cleared once a gateway brings someone in, so a town that loses its last gateway hears again */
  private noticed = new Set<string>();
  /** trips planned by mode since start (the A/B harness reads these): walked, driven, by transit */
  modeLog = { walk: 0, drive: 0, transit: 0, taxi: 0 };

  constructor(private w: World) {
    w.onRoadClass = () => { this.classEpoch++; };
    w.onRoadRule = () => { this.classEpoch++; }; // a new turn ban or no entry (R4): drivers check their way as for a class change
    this.motive = new Motivation(w);
    this.motiveHost = {
      bestJob: (c, except) => this.jobOptions(c, except),
      canSwitch: (c) => c.state === S.Home && !c.site && c.appr === undefined && !c.study && !essentialJob(c.kind) && !this.mobile.roleOf(c),
      switchJob: (c, b, path) => { w.quitJob(c); this.hire(c, b, path); },
      canTake: (c, b) => this.skills.placeFor(b, c.edu) !== Place.None,
      pathTo: (c, b) => pathBetween(w, c.hx, c.hy, b.x, b.y),
      cover: (x, y) => Math.floor(this.coverage(x, y) + 1e-6),
      parks: (x, y) => this.leisureCoverage(x, y).parks,
      moveHome: (c, b, hh) => this.moveHome(c, b, hh),
      homeOk: (b) => b.zone === Zone.Residential && b.id !== CAMP_KIND && w.hasRoadAccess(b.x, b.y),
    };
    this.traffic = new Traffic(w);
    this.transit = new Transit(w);
    this.buses = new BusService(w, this.traffic, this.transit);
    this.transit.register(this.buses);
    this.pool = new Carpool(w);
    this.gateways = new Gateways(w);
    this.control = new TrafficControl(w, this.traffic, this.gateways);
    this.mobile = new Mobile(w, this.traffic);
    this.taxis = new Taxis(w, this.mobile);
    this.mobile.register(this.taxis);
    this.taxis.ranks = () => this.taxiRanks();
    this.delivery = new Delivery(w, this.mobile);
    this.mobile.register(this.delivery);
    this.refuse = new Refuse(w, this.mobile);
    this.mobile.register(this.refuse);
    this.couriers = new Couriers(w, this.mobile);
    this.mobile.register(this.couriers);
    this.schools = new Schools(w, {
      scheduleNext: (c) => this.scheduleNext(c), depart: (c) => this.depart(c),
      escort: (a, c, then, onShift) => this.escortTrip(a, c, then, onShift), fetch: (a, c) => this.fetchTrip(a, c),
    }, this.lifeEvents);
    this.skills = new Skills(w, (c) => this.leaveTown(c), (owner, msg) => this.notices.push({ owner, msg })); // it says it once a game day itself
    this.schools.onGraduated = (c) => this.skills.graduated(c);
    const make = (id: number, home: Building, age: number, health: number, edu?: EduFields) => this.makeCitizen(id, home, age, health, edu);
    this.families = new Families(w, this.skills, this.gateways, {
      make, follow: (p, c) => this.followIn(p, c), settle: (p) => { if (this.vacantJobs > 0) this.findJob(p); },
    });
    this.learning = new Learning(w, this.schools, this.skills, this.gateways, {
      make, classTrip: (c, x, y) => this.classTrip(c, x, y), rehome: (c, b) => this.moveHome(c, b, c.hh), leave: (c) => this.leaveTown(c),
    }, this.lifeEvents);
    this.death = new Death(w, this.mobile, {
      funeralTrip: (c, x, y) => this.funeralTrip(c, x, y), hospitalNear: (x, y) => this.nearestHospital(x, y), covered: (x, y) => this.hasHospital(x, y),
    }, this.lifeEvents);
    this.mobile.register(this.death); // its hearses
    w.onCitizenRemoved = (c) => { this.traffic.leave(c); this.transit.drop(c); this.taxis.drop(c); this.mobile.forget(c); this.pool.forget(c); this.releaseParking(c); this.dropVenue(c); };
    this.start = new FirstFive(w, this.gateways, {
      spawn: (home) => this.spawnCitizen(home),
      arriveFrom: (home, x, y) => this.arriveVia(this.start.roadGate(x, y), home.x, home.y),
      hire: (c, b, path) => this.hire(c, b, path),
      canTake: (c, b) => this.skills.placeFor(b, c.edu) !== Place.None, // E4's skill gate as findJob applies it
      moveHome: (c, b, hh) => this.moveHome(c, b, hh),
      entries: () => this.entries,
    });
  }

  tick() {
    const w = this.w, perf = this.perf;
    perf.begin();
    w.tick++;
    if (w.tick % DAY === 0) this.newDay();
    this.schools.tick();
    this.learning.tick();
    if (w.tick % STATS_EVERY === 0) this.recomputeStats();
    if (w.tick % GROWTH_EVERY === 0) this.growth();
    if (w.tick % GROWTH_EVERY === 13) this.leisureGrowth();
    if (w.tick % GROWTH_EVERY === 19) plantGardens(w); // homes all round a block's middle plant a communal garden there (sim/blocks.ts)
    if (w.tick % SPAWN_EVERY === 3) this.spawn();
    if (w.tick % ENTRIES_EVERY === 7) this.findEntries();
    perf.lap('plan');
    this.gateways.tick((g, hx, hy, tag) => this.arriveVia(g, hx, hy, tag));
    this.start.tick(); // a camp's settlers coming up the road (sim/firstfive.ts)
    perf.lap('gateways');
    if (w.tick % SWEEP_EVERY === 11) this.traffic.sweep();
    this.traffic.beginTick();
    perf.lap('traffic0');
    this.routeBudget = ROUTE_BUDGET;
    this.moveCitizens();
    perf.lap('citizens');
    this.moveVehicles();
    perf.lap('vehicles');
    this.transit.tick();
    perf.lap('transit');
    this.mobile.tick();
    perf.lap('mobile');
    this.dispatch();
    perf.lap('dispatch');
    this.traffic.endTick();
    perf.lap('traffic1');
    // the tick's work: route searches and the nodes they expanded (pathfinding.ts SEARCH), who moved
    const seen = this.searchSeen, cur = perf.cur;
    cur[CI.routes] += SEARCH.routes - seen.routes; cur[CI.nodes] += SEARCH.nodes - seen.nodes;
    seen.routes = SEARCH.routes; seen.nodes = SEARCH.nodes;
    cur[CI.moving] = this.moving; cur[CI.driving] = this.driving;
  }

  get dayFrac() { return (this.w.tick % DAY) / DAY; }
  /** Guests at each leisure place right now, flat [x, y, count, ...] by door tile (ServerMsg 'venues'). */
  venueGuests(): number[] {
    const out: number[] = [];
    for (const [key, g] of this.guests) { if (!g.size) continue; const [x, y] = parseKey(key); out.push(x, y, g.size); }
    return out;
  }
  private get hour() { return (this.w.tick % DAY) / TPH; }

  // ---- inspection -----------------------------------------------------------

  /** Everything worth showing in a tooltip for one building. O(citizens), fine at hover rate. */
  describe(b: Building, full = false): BuildingInfo {
    const w = this.w;
    const key = tileKey(b.x, b.y);
    const info: BuildingInfo = { x: b.x, y: b.y, kind: b.id, level: b.level, capacity: capacityOf(b.id, b.level), occupants: b.occupants };
    const parcel = w.parcelAt(b.x, b.y);
    if (parcel) info.parcel = { name: parcel.name, owner: w.players.get(parcel.owner)?.name ?? parcel.owner, taxRate: parcel.taxRate };
    const site = w.sites.get(key);
    if (site) info.construction = { done: site.total - site.work, total: site.total, builders: site.assigned, priority: site.priority };
    const underground = w.ownerHas(b.x, b.y, 'underground', hasFeature);
    const pcap = parkingOf(b.id, b.level, underground);
    if (pcap > 0 || b.zone === Zone.Parking) {
      info.parking = { capacity: pcap, used: w.parking.get(key) ?? 0, underground: underground && b.zone !== Zone.Parking && b.zone !== Zone.Residential, turnedAway: w.parkFail.get(key) ?? 0 };
      if (b.zone === Zone.Parking) { info.parking.fee = PARKING_FEE; info.parking.incomeToday = w.lotIncome.get(key) ?? 0; info.upkeep = CIVIC_UPKEEP[b.id]; }
    }
    if (full) info.people = this.peopleAt(b);
    const mob = this.mobile.describeBuilding(b.x, b.y, b.id);
    if (mob.length) info.mobile = mob;
    if (b.zone === Zone.Parking) return info;
    if (isGatewayId(b.id)) {
      let enRoute = 0;
      for (const c of w.citizens.values()) if ((c.mig === MIG.In || c.mig === MIG.Out) && c.gx === b.x && c.gy === b.y) enRoute++;
      info.gateway = this.gateways.describe(b, enRoute);
      // R5: visitors by road through a motorway connection, and the visitor limit with what it costs (sim/control.ts)
      if (info.gateway && b.id === MOTORWAY_KIND) {
        const st = w.structureAt(b.x, b.y), fx = st?.frontX ?? b.x, fy = st?.frontY ?? b.y, v = this.control.visitorsAt(fx, fy), on = this.control.limitAt(b.x, b.y);
        Object.assign(info.gateway, { visitorsToday: v.today, visitorsYesterday: v.yesterday, visitorLimit: on, limitCost: this.control.limitCost(fx, fy, on) });
      }
    }
    // bus stops (rail stations have their own section, net.ts / sim/rail.ts)
    if (stopModeOf(b.id) === 'bus') { info.transit = this.transit.describeStop(b.x, b.y); if (!capacityOf(b.id, b.level)) return info; }
    if (b.zone === Zone.Residential) {
      const r = { total: 0, employed: 0, atHome: 0, out: 0, working: 0, drivers: 0, jobsByKind: new Array(KIND_ID_COUNT).fill(0) };
      for (const c of w.citizens.values()) {
        if (c.hx !== b.x || c.hy !== b.y) continue;
        r.total++;
        if (c.job) { r.employed++; r.jobsByKind[c.kind]++; }
        if (c.car) r.drivers++;
        if (c.state === S.Home) r.atHome++;
        else if (c.state === S.AtVenue || c.state === S.ToVenue) r.out++;
        else r.working++;
      }
      info.residents = r;
      const lc = this.leisureCoverage(b.x, b.y);
      info.leisure = { score: lc.score, label: ['little to do nearby', 'some places to go', 'plenty to do nearby'][leisureTier(lc.score)], parks: lc.nParks, venues: lc.nVenues };
    } else {
      const shifts = new Map<string, number>();
      const wk = { total: 0, onShift: 0, commuting: 0, offDuty: 0, drivers: 0, shifts: [] as [string, number][] };
      for (const c of w.citizens.values()) {
        if (!c.job || c.wx !== b.x || c.wy !== b.y) continue;
        wk.total++;
        if (c.car) wk.drivers++;
        if (c.state === S.Work || c.state === S.AtSite || c.state === S.ToSite) wk.onShift++;
        else if (c.state === S.ToWork || (c.state === S.ToVenue && c.venueThen === S.ToWork)) wk.commuting++;
        else wk.offDuty++;
        shifts.set(this.shiftLabel(c), (shifts.get(this.shiftLabel(c)) ?? 0) + 1);
      }
      wk.shifts = [...shifts.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 4);
      info.workers = wk;
      info.wage = wageOf(b.id, b.level);
      if (isCivicId(b.id)) info.upkeep = upkeepOf(b.id, b.level); // per level: a large park costs more than a pocket park
      const school = this.schools.describe(b);
      if (school) info.school = school;
      if (b.zone === Zone.Commercial) { info.visitors = this.visitors.get(key) ?? 0; info.visitorCapacity = venueCapacityOf(b.id, b.level); }
      const sp = leisureAt(b.id, b.level, b.x, b.y);
      if (sp) {
        const h = this.hour, vis = this.visitsAt(key), staffed = !sp.staffed || b.occupants > 0;
        info.venue = {
          type: sp.type, title: sp.title, visitors: this.visitors.get(key) ?? 0, capacity: sp.capacity, open: [sp.open, sp.close],
          openNow: staffed && isOpenAt(sp, h, b.x, b.y), staffed, ticket: sp.ticket, visitsToday: vis.today, visitsYesterday: vis.yesterday,
          leisureValue: sp.value, radius: sp.radius,
        };
        const ne = nextEvent(sp, this.today, h, b.x, b.y);
        if (ne) info.venue.nextEvent = { weekday: WEEKDAY_NAMES[mod(ne.day, 7)], hour: ne.hour, tonight: ne.day === this.today, name: EVENT_NAMES[sp.type] };
        if (sp.upgradeVisits > 0) info.venue.upgradeVisits = sp.upgradeVisits;
        if (sp.blockOnly) {
          const homes = new Set<number>();
          let residents = 0;
          for (const c of w.citizens.values()) if (this.roundGarden(b, c.hx, c.hy)) { homes.add(tkey(c.hx, c.hy)); residents++; }
          info.venue.block = { homes: homes.size, residents };
        }
      }
      if (b.zone === Zone.Yard) {
        const active = new Set<string>();
        for (const c of w.citizens.values()) if (c.job && c.wx === b.x && c.wy === b.y && c.site) active.add(c.site);
        info.activeSites = active.size;
      }
    }
    return info;
  }

  /** Named lists for the building panel: residents, staff, visitors and builders, those physically here first. */
  private peopleAt(b: Building): BuildingPeople {
    const w = this.w;
    const key = tileKey(b.x, b.y);
    const residents: PersonRow[] = [], workers: PersonRow[] = [], visitors: PersonRow[] = [], builders: PersonRow[] = [];
    const row = (c: Citizen, here: boolean): PersonRow => ({ id: c.id, name: nameFor(c.id, c.sn), activity: this.activityOf(c), here, age: Math.floor(ageOf(c, w.tick)), stage: c.stage, edu: c.edu });
    for (const c of w.citizens.values()) {
      if ((b.zone === Zone.Residential || b.lodgers) && c.hx === b.x && c.hy === b.y) { // a hall's students too
        const r = row(c, c.state === S.Home);
        r.household = c.hh; r.householdName = surnameFor(w.households.get(c.hh)?.sn ?? c.sn);
        residents.push(r);
      }
      if (b.zone !== Zone.Residential && b.zone !== Zone.Parking && c.job && c.wx === b.x && c.wy === b.y) workers.push(row(c, c.state === S.Work));
      if (c.state === S.AtVenue && c.venue === key) visitors.push(row(c, true));
      else if (c.study && !c.job && c.sx === b.x && c.sy === b.y) visitors.push(row(c, c.state === S.Work)); // pupils (sim/schools.ts)
      if (c.site === key && (c.state === S.AtSite || c.state === S.ToSite)) builders.push(row(c, c.state === S.AtSite));
    }
    for (const v of w.vehicles.values()) {
      if (v.phase !== 'dwell' || v.to[0] !== b.x || v.to[1] !== b.y) continue;
      const label = VEHICLE_LABEL[v.vkind] ?? 'vehicle';
      const verb = v.vkind === VehicleKind.Freight ? 'unloading' : v.vkind === VehicleKind.Visitor ? 'visiting' : 'attending';
      visitors.push({ id: v.id, name: `${label[0].toUpperCase()}${label.slice(1)} ${v.id - VEHICLE_ID_BASE}`, activity: `${label}, ${verb}`, here: true });
    }
    let truncated = false;
    const cap = (rows: PersonRow[]) => {
      rows.sort((a, z) => Number(z.here) - Number(a.here) || a.id - z.id);
      if (rows.length > PEOPLE_ROW_CAP) { truncated = true; rows.length = PEOPLE_ROW_CAP; }
      return rows;
    };
    const people: BuildingPeople = { residents: cap(residents), workers: cap(workers), visitors: cap(visitors) };
    if (builders.length) people.builders = cap(builders);
    const parked = w.parking.get(key);
    if (parked) people.parkedHere = parked;
    if (truncated) people.truncated = true;
    return people;
  }

  describeRoad(x: number, y: number): RoadInfo {
    const t = this.traffic;
    let queued = 0;
    const info: RoadInfo = {
      x, y, congestion: t.congestionAt(x, y), vehiclesNow: t.onTile(x, y), queuedNow: 0,
      speedPct: 1, junction: t.junctionKind(x, y), kerbParked: this.w.kerb.get(tkey(x, y)) ?? 0,
    };
    for (const m of this.moversOn(x, y)) if (m.wait > 1) queued++;
    info.queuedNow = queued;
    info.speedPct = info.vehiclesNow ? Math.max(0, 1 - queued / info.vehiclesNow) : 1;
    if (info.junction === 'signal') { const ph = t.signalPhase(x, y); info.green = ph.green; info.amber = ph.amber; if (ph.left) info.leftPhase = true; }
    // R4: the junction group, its turn rules, a signal crossing's lamps
    const g = t.groupOf(x, y);
    if (g) info.group = { x: g.x, y: g.y, w: g.w, h: g.h, phases: t.phasesAt(x, y) };
    const anchor = g ?? (t.degreeOf(x, y) >= 3 ? { x, y } : null);
    if (anchor) { const lines = ruleLines(this.w.roadRuleAt(anchor.x, anchor.y)); if (lines.length) info.rules = lines; }
    if (info.junction === 'pelican') info.pelican = t.pelicanLamp(x, y);
    const parcel = this.w.parcelAt(x, y);
    if (parcel) info.parcel = { name: parcel.name, owner: this.w.players.get(parcel.owner)?.name ?? parcel.owner };
    const span = bridgeSpanAt(x, y, (bx, by) => this.w.auxAt(bx, by));
    if (span) info.bridge = { style: BRIDGE_STYLE_NAMES[span.style], span: span.len };
    const a = this.w.auxAt(x, y), cls = auxClass(a);
    if (cls) { info.cls = cls; if (oneWayDir(a) >= 0) info.flow = oneWayDir(a); }
    return info;
  }
  private *moversOn(x: number, y: number): Iterable<Mover> {
    for (const c of this.w.citizens.values()) if (c.lane >= 0 && Math.floor(c.x) === x && Math.floor(c.y) === y) yield c;
    for (const v of this.w.vehicles.values()) if (v.lane >= 0 && Math.floor(v.x) === x && Math.floor(v.y) === y) yield v;
  }

  /** Live detail for a person or vehicle; `withRoute` adds the trail taken and the route ahead (for the selected agent only). */
  describeCitizen(id: number, withRoute = false): CitizenInfo | null {
    const w = this.w;
    const v = w.vehicles.get(id);
    if (v) { const vi = this.describeVehicle(v); if (withRoute) { this.addRoute(vi, v); if (vi.bus) this.busRoster(vi.bus, v.id); } return vi; }
    const c = w.citizens.get(id);
    if (!c) return null;
    const parcelName = (x: number, y: number) => w.parcelAt(x, y)?.name;
    const info: CitizenInfo = {
      id, name: nameFor(id, c.sn), role: 'citizen',
      occupation: c.job ? (c.kind === BUS_DEPOT_KIND && isMechanic(c.id) ? 'bus mechanic' : OCCUPATIONS[c.kind]?.name) : c.study ? (c.study >= Study.FeCourse ? 'student' : 'pupil')
        : c.stage === LifeStage.Child ? 'child' : c.stage === LifeStage.Retired ? 'retired' : 'looking for work',
      home: { x: c.hx, y: c.hy, parcel: parcelName(c.hx, c.hy) },
      activity: this.activityOf(c), mode: c.leg ? (c.leg.drive ? 'drive' : c.leg.ride && this.transit.isRiding(c) ? 'ride' : 'walk') : 'none',
      ownsCar: c.car, money: Math.round(c.money), status: c.leg?.drive && c.wait > 1 ? 'queued' : c.leg?.ride ? (this.transit.isRiding(c) ? 'moving' : 'idle') : c.leg ? 'moving' : 'idle', waitTicks: c.wait,
    };
    if (c.job) {
      const wb = w.buildings.get(tileKey(c.wx, c.wy));
      if (wb) info.employer = { x: wb.x, y: wb.y, kind: wb.id, level: wb.level, parcel: parcelName(wb.x, wb.y) };
      info.shift = { label: this.shiftLabel(c), workingToday: this.worksOn(c, Math.floor(w.tick / DAY)) };
    }
    const dest = this.destinationOf(c);
    if (dest) info.destination = dest;
    if (c.car) {
      if (c.parkedAt) { const [px, py] = parseKey(c.parkedAt); info.parked = { x: px, y: py, where: c.parkKerb ? 'at the kerb' : (w.buildings.get(c.parkedAt)?.zone === Zone.Parking ? 'in a parking lot' : 'at the building') }; }
      else if (!(c.leg?.drive)) info.parked = { x: c.hx, y: c.hy, where: 'at home' };
    }
    const night = this.nightOf(c);
    if (night) info.night = night;
    if (c.state === S.AtVenue && !c.errand && c.venue) {
      const vb = this.w.buildings.get(c.venue);
      if (vb && leisureAt(vb.id, vb.level, vb.x, vb.y)) info.venue = { x: vb.x, y: vb.y, kind: vb.id };
    }
    if (c.leg) { info.tripDone = Math.max(0, c.leg.drive ? c.pi - 1 : c.pi); info.tripTotal = c.path.length / 2 - 1; }
    if (c.leg && this.legTrack.get(c)?.tripAt === c.tripStart) { const rr = this.reroutesOf(c).trip; if (rr > 0) info.reroutes = rr; }
    const role = this.mobile.roleOf(c);
    if (role) { info.occupation = FLEET_JOB[role.kind]; info.fleet = this.mobile.workerInfo(c); }
    if (c.leg?.hail) { info.taxi = this.taxis.taxiOf(c); info.mode = this.taxis.isAboard(c) ? 'drive' : 'none'; info.status = this.taxis.isAboard(c) ? 'moving' : 'idle'; }
    this.describeShare(c, info);
    if (withRoute) {
      this.addRoute(info, c);
      // on board a bus, a train or a tube train: which one, so the first-person view can sit them in it (the selected citizen only)
      const ab = this.transit.aboardOf(c);
      if (ab && ab.mode === 'bus') {
        const bv = w.vehicles.get(ab.vehicle);
        info.aboard = { mode: 'bus', vehicle: ab.vehicle, line: ab.line, load: ab.load, next: bv ? this.buses.describe(bv)?.bus?.nextStop : undefined };
      } else if (ab && ab.mode !== 'ferry') {
        const train = vehicleTrain(ab.vehicle), svc = this.transit.services.get(ab.mode) as { describeTrain?(line: number, train: number): { next?: string } | null } | undefined;
        info.aboard = { mode: ab.mode, vehicle: ab.vehicle, line: ab.line, train, load: ab.load, next: svc?.describeTrain?.(ab.line, train)?.next };
      }
    }
    info.life = this.describeLife(c);
    return info;
  }
  /** The selected bus's roster (as a train's): everyone on board and where each gets off, cut at 200 rows. */
  private busRoster(bus: BusInfo, id: number) {
    const aboard = this.transit.aboard(id), tick = this.w.tick;
    bus.riders = aboard.slice(0, BUS_ROSTER_CAP).map(({ c, off }) => ({ id: c.id, name: nameFor(c.id, c.sn), activity: `to ${this.w.stopLabel(off.x, off.y)}`, age: Math.floor(ageOf(c, tick)) }));
    if (aboard.length > BUS_ROSTER_CAP) bus.truncated = true;
  }
  /** Car sharing for the panels: a driver's occupants (driver first), or the car a passenger rides in or waits for. */
  private describeShare(c: Citizen, info: CitizenInfo) {
    const w = this.w, tick = w.tick;
    const ref = (o: Citizen, relation: string): PersonRef => ({ id: o.id, name: nameFor(o.id, o.sn), age: Math.floor(ageOf(o, tick)), relation, activity: this.activityOf(o) });
    const relation = (d: Citizen, o: Citizen) => d.hh === o.hh ? this.relationOf(d, o) : d.friends.includes(o.id) ? 'friend'
      : d.job && o.job && d.wx === o.wx && d.wy === o.wy ? 'colleague' : 'neighbour';
    if (c.leg?.lift) {
      const d = w.citizens.get(c.leg.lift.driver);
      if (d) info.liftWith = ref(d, relation(c, d));
      if (this.pool.aboard(c)) { info.mode = 'drive'; info.status = 'moving'; } else info.mode = 'none';
      return;
    }
    const occ = this.pool.occupants(c);
    if (!occ.length) return;
    info.occupants = [ref(c, 'driver')];
    for (const [id, aboard] of occ) {
      const o = w.citizens.get(id);
      if (o) info.occupants.push(ref(o, aboard ? relation(c, o) : `${relation(c, o)}, to pick up`));
    }
  }
  /** Age, health, family, friends and happiness for the citizen panel. O(citizens) for the colleague count, like describe(). */
  private describeLife(c: Citizen): CitizenLife {
    const w = this.w, tick = w.tick, day = Math.floor(tick / DAY);
    const ref = (o: Citizen, relation: string): PersonRef => ({ id: o.id, name: nameFor(o.id, o.sn), age: Math.floor(ageOf(o, tick)), relation, activity: this.activityOf(o) });
    const hh = w.households.get(c.hh);
    const members: PersonRef[] = [];
    for (const id of hh?.ids ?? []) {
      const o = id === c.id ? undefined : w.citizens.get(id);
      if (o) members.push(ref(o, this.relationOf(c, o)));
    }
    const partner = c.partner ? w.citizens.get(c.partner) : undefined;
    if (partner && partner.hh !== c.hh) members.push(ref(partner, 'partner (lives apart)'));
    const ORDER = ['partner', 'partner (lives apart)', 'parent', 'sibling', 'child', 'relative'];
    members.sort((a, b) => ORDER.indexOf(a.relation) - ORDER.indexOf(b.relation) || b.age - a.age);
    const friends: PersonRef[] = [];
    for (const id of c.friends) { const o = w.citizens.get(id); if (o) friends.push(ref(o, 'friend')); }
    let colleagues = 0;
    if (c.job) for (const o of w.citizens.values()) if (o.job && o !== c && o.wx === c.wx && o.wy === c.wy) colleagues++;
    const parts = happinessParts(c, { coverage: Math.floor(this.coverage(c.hx, c.hy) + 1e-6), tick, parks: this.leisureCoverage(c.hx, c.hy).parks, kids: this.families.homeParts(c, this.schools), bend: this.motive.bend(c) });
    const wk = week(c, tick);
    const fresh = c.statsDay === day;
    let care: string | undefined;
    if (c.errand === 1 && c.state === S.AtVenue) care = 'seeing a doctor';
    else if (c.errand === 1 && c.state === S.ToVenue) care = 'on the way to the doctor';
    else if (c.health < HEALTH.staysHomeBelow) care = 'too ill to go out';
    else if (c.offSickDay === day) care = 'off sick today';
    else if (c.care > 0) care = "doctor's visit planned";
    return {
      age: Math.floor(ageOf(c, tick)), stage: LIFE_STAGE_NAMES[c.stage] ?? 'adult',
      health: Math.round(c.health), conditions: COND_NAMES.filter(([bit]) => c.cond & bit).map(([, n]) => n), care,
      household: { id: c.hh, name: surnameFor(hh?.sn ?? c.sn), members },
      friends, colleagues,
      happiness: happinessOf(parts), reasons: parts.slice(0, 4),
      income7: Math.round(wk.income), spend7: Math.round(wk.spend),
      tripsToday: fresh ? c.tripsToday : 0, trafficMinToday: fresh ? Math.round((c.trafficTicksToday * 60) / TPH) : 0,
      sickDays: c.sickDays, leisureNeed: Math.round(leisureNeed(c) * 100),
      birthday: birthdayOf(c.born, LIFE.daysPerYear), education: this.describeEducation(c),
      values: this.motive.describe(c), lately: this.motive.lately(c),
    };
  }
  /** Level, track, the stage under way and the finished ones (docs/education.md). */
  private describeEducation(c: Citizen): CitizenEducation {
    const w = this.w;
    const placeName = (x: number, y: number, kind: number) => `${KIND_NAMES[w.buildings.get(tileKey(x, y))?.id ?? kind] ?? 'school'} at (${x}, ${y})`;
    const info: CitizenEducation = {
      level: c.edu,
      history: c.eduLog.map(([stage, x, y, kind, week, result]) => ({ stage, place: placeName(x, y, kind), week, result })),
    };
    if (c.track) info.track = c.track;
    if (c.eduBits & EDU_NURSERY) info.nursery = true;
    if (c.eduBits & EDU_DROPPED) info.droppedOut = true;
    if (c.study) {
      // schools go by year group (a child may join mid-stage); courses by school days held, adult courses by days attended
      const spec = STAGES[c.study], day = w.tick / DAY, school = c.study >= Study.Primary && c.study <= Study.SixthForm;
      const yg = yearGroup(c.born, day, LIFE.daysPerYear);
      const done = school ? yg - (spec.ages[0] - 4) + mod(day, LIFE.daysPerYear) / LIFE.daysPerYear : spec.years ? c.due / spec.days : c.att / spec.days;
      info.studying = {
        place: { x: c.sx, y: c.sy, name: placeName(c.sx, c.sy, 0) }, stage: c.study,
        attendance: c.due ? Math.min(1, c.att / c.due) : 1, progress: Math.max(0, Math.min(1, school ? done / spec.years : done)),
      };
      if (school) info.studying.yearGroup = yg;
    }
    if (c.appr !== undefined) info.apprentice = Math.min(1, c.appr / STAGES[Study.Apprentice].days);
    return info;
  }
  /** How o is related to c, both in the same household. */
  private relationOf(c: Citizen, o: Citizen): string {
    const w = this.w;
    if (o.id === c.partner) return 'partner';
    if (o.par && (o.par === c.id || o.par === c.partner)) return 'child';
    if (c.par && (c.par === o.id || w.citizens.get(c.par)?.partner === o.id)) return 'parent';
    if (c.par && o.par && (o.par === c.par || w.citizens.get(o.par)?.partner === c.par)) return 'sibling';
    return 'relative';
  }
  /**
   * Fill in the tiles passed this trip and the tiles still to go: the rest of
   * the current leg from the next node not yet reached (a driver's `pi` is the
   * node being approached, a walker's the node last reached), then every leg
   * still queued. `legStarts[i]` is the route node where leg i begins.
   */
  private addRoute(info: CitizenInfo, m: Citizen | Vehicle) {
    info.trail = m.trail.slice();
    const route: number[] = [], kinds: ('walk' | 'drive' | 'ride')[] = [], starts: number[] = [];
    const add = (path: number[], from: number, drive: boolean | 'ride') => {
      let i = Math.max(0, from) * 2;
      if (i >= path.length) return;
      const n = route.length;
      let start = n / 2;
      if (n >= 2 && route[n - 2] === path[i] && route[n - 1] === path[i + 1]) { i += 2; start--; } // legs share their boundary node
      starts.push(start);
      kinds.push(drive === 'ride' ? 'ride' : drive ? 'drive' : 'walk');
      for (; i < path.length; i += 2) route.push(path[i], path[i + 1]);
    };
    if (m.leg) add(m.path, m.leg.ride || m.leg.lift ? 0 : m.leg.drive ? m.pi : m.pi + 1, m.leg.ride ? 'ride' : m.leg.drive || !!m.leg.lift);
    for (const leg of m.legs) add(leg.path, 0, leg.ride ? 'ride' : leg.drive || !!leg.lift);
    info.route = route; info.legKinds = kinds; info.legStarts = starts;
  }
  private describeVehicle(v: Vehicle): CitizenInfo {
    const w = this.w;
    if (v.vkind === VehicleKind.Bus) { const bi = this.buses.describe(v); if (bi) return bi; }
    if (v.vkind > FLEET_VKIND) { const fi = this.mobile.describe(v); if (fi) return fi; }
    const label = VEHICLE_LABEL[v.vkind] ?? 'vehicle';
    const fromB = w.buildings.get(tileKey(v.from[0], v.from[1])), toB = w.buildings.get(tileKey(v.to[0], v.to[1]));
    const named = (b: Building | undefined, p: [number, number]) => b ? `${KIND_NAMES[b.id]} at (${p[0]}, ${p[1]})` : `(${p[0]}, ${p[1]})`;
    const activity = v.phase === 'out'
      ? (v.vkind === VehicleKind.Freight ? `delivering to the ${named(toB, v.to)}` : v.vkind === VehicleKind.Visitor ? `driving in to the ${named(toB, v.to)}` : v.vkind === VehicleKind.Patrol ? 'on patrol' : `responding to a call at the ${named(toB, v.to)}`)
      : v.phase === 'dwell' ? (v.vkind === VehicleKind.Freight ? 'unloading' : v.vkind === VehicleKind.Visitor ? 'visiting' : 'attending')
      : v.vkind === VehicleKind.Visitor ? 'leaving town' : `heading back to the ${named(fromB, v.from)}`;
    // visitors leave by any entry point, not necessarily the one they came in by
    const lastPath = v.legs.length ? v.legs[v.legs.length - 1].path : v.leg?.path;
    const exit: [number, number] | null = v.phase === 'back' && v.vkind === VehicleKind.Visitor && lastPath && lastPath.length >= 2 ? [lastPath[lastPath.length - 2], lastPath[lastPath.length - 1]] : null;
    const info: CitizenInfo = {
      id: v.id, name: `${label[0].toUpperCase()}${label.slice(1)} ${v.id - VEHICLE_ID_BASE}`, role: label,
      activity, mode: 'drive', status: v.wait > 1 ? 'queued' : v.phase === 'dwell' ? 'idle' : 'moving', waitTicks: v.wait,
      destination: exit ? { x: exit[0], y: exit[1], label: 'the edge of town' } : v.phase === 'back' ? { x: v.from[0], y: v.from[1], label: named(fromB, v.from) } : { x: v.to[0], y: v.to[1], label: named(toB, v.to) },
    };
    if (v.parkedAt) { const [px, py] = parseKey(v.parkedAt); info.parked = { x: px, y: py, where: v.parkKerb ? 'at the kerb' : 'parked' }; }
    if (v.leg) { info.tripDone = Math.max(0, v.pi - 1); info.tripTotal = v.path.length / 2 - 1; }
    return info;
  }
  private shiftLabel(c: Citizen) {
    const sh = Math.round(c.shiftStart / TPH) % 24, eh = (sh + Math.round(c.shiftLen / TPH)) % 24;
    return `${String(sh).padStart(2, '0')}:00–${String(eh).padStart(2, '0')}:00`;
  }
  private activityOf(c: Citizen): string {
    if (c.mig === MIG.In || c.mig === MIG.Out) { // with their luggage, through a gateway (sim/gateways.ts)
      const g = c.gx === undefined || c.gy === undefined ? undefined : GATEWAY_OF[this.w.buildings.get(tileKey(c.gx, c.gy))?.id ?? -1];
      const where = g ? GATEWAY_WORDS[g.type] : 'the edge of town';
      const how = c.leg?.drive ? (c.car && g?.modes.includes('car') ? 'driving' : 'in a taxi') : 'walking with a suitcase';
      return c.mig === MIG.In ? `moving to town: ${how} from ${where} to their new home` : `leaving town: ${how} to ${where}`;
    }
    const pupil = c.study > 0 && !c.job, school = c.study >= Study.Degree ? 'university' : c.study === Study.FeCourse || c.study === Study.Evening ? 'college' : 'school';
    const going = c.state === S.ToWork ? (pupil ? `, going to ${school}` : ', going to work') : c.state === S.ToHome ? ', going home' : c.state === S.ToVenue ? (c.errand === ERRAND_SCHOOL ? ', on the school run' : ', going out') : '';
    if (c.leg?.lift) {
      const d = this.w.citizens.get(c.leg.lift.driver);
      const car = d ? `${nameFor(d.id, d.sn)}'s car` : 'a car';
      return `${this.pool.aboard(c) ? `passenger in ${car}` : `waiting to get into ${car}`}${going}`;
    }
    if (c.leg && !c.leg.drive && c.legs[0]?.lift) {
      const d = this.w.citizens.get(c.legs[0].lift.driver);
      return `walking to ${d ? `${nameFor(d.id, d.sn)}'s` : 'the'} car for a lift${going}`;
    }
    if (c.leg?.hail) {
      const tx = this.taxis.activity(c);
      if (tx) return `${tx}${going}`;
    }
    if (c.leg?.ride) {
      const ta = this.transit.activity(c);
      if (ta) return `${ta}${c.state === S.ToWork ? ', going to work' : c.state === S.ToHome ? ', going home' : c.state === S.ToVenue ? ', going out' : ''}`;
    }
    const legWord = () => {
      if (!c.leg) return '';
      if (!c.leg.drive && c.legs[0]?.ride) { const l = this.transit.line(c.legs[0].ride.line); return `walking to ${stopName(c.legs[0].ride.board[0], c.legs[0].ride.board[1])} for the ${l?.number ?? 'bus'}, then on`; }
      if (c.leg.drive) return c.wait > 1 ? 'stuck in traffic, driving' : 'driving';
      if (c.leg.arrive === 'pickup') return 'walking to the car, then driving';
      if (c.legs.length === 0 && c.parkedAt && !c.parkKerb && c.leg.path.length > 2) return 'parked, walking the last stretch';
      return 'walking';
    };
    switch (c.state) {
      case S.Home:
        if (c.health < HEALTH.staysHomeBelow) return 'at home, too ill to go out';
        if (c.offSickDay === Math.floor(this.w.tick / DAY) && (c.cond & ACUTE)) return 'at home, off sick';
        if (c.stage === LifeStage.Child) return 'at home';
        if (c.stage === LifeStage.Retired) return 'at home, retired';
        return c.job ? 'at home' : 'at home, between jobs';
      case S.ToWork: return `${legWord()} to ${pupil ? school : 'work'}`;
      case S.Work: return pupil ? (c.study >= Study.Degree ? 'at lectures' : `at ${school}`) : this.mobile.activity(c) ?? (familyOf(c.kind) === Zone.Yard ? 'at the yard' : 'on shift');
      case S.ToHome: return `${legWord()} home`;
      case S.ToSite: return `${legWord()} to a building site`;
      case S.AtSite: return 'working on a building site';
      case S.ToVenue: {
        if (c.errand === ERRAND_SCHOOL) return `${legWord()} to school with a child`;
        if (c.errand === ERRAND_CLASS) return `${legWord()} to an evening class`;
        if (c.errand === ERRAND_FUNERAL) return `${legWord()} to a funeral`;
        if (c.errand) return `${legWord()} to the doctor`;
        const sp = this.venueSpecOf(c);
        return `${legWord()} ${sp ? VENUE_WORDS[sp.type].going : this.hour < 16 ? 'to a café' : 'out for the evening'}`;
      }
      case S.AtVenue: {
        if (c.errand === ERRAND_SCHOOL) return 'at the school gate';
        if (c.errand === ERRAND_CLASS) return 'at an evening class';
        if (c.errand === ERRAND_FUNERAL) return 'at a funeral';
        if (c.errand) return 'seeing a doctor at the hospital';
        const sp = this.venueSpecOf(c), b = sp && c.venue ? this.w.buildings.get(c.venue) : undefined;
        if (sp && b) {
          if (eventOn(sp, this.today) && Math.abs(this.hour - eventStartAt(sp, b.x, b.y) - 1) < 1.6) return VENUE_WORDS[sp.type].event;
          // a park visit is a picnic, a kite or the ducks (where there is water), seeded per person and visit (docs/leisure.md)
          if (sp.type === 'park') return parkActivity(sp, c.id, c.venueSince ?? 0, this.hour, c.stage).at;
          return VENUE_WORDS[sp.type].at;
        }
        return this.hour < 16 ? 'at a café' : 'out at a bar';
      }
    }
    return '';
  }
  private destinationOf(c: Citizen): CitizenInfo['destination'] | undefined {
    const w = this.w;
    const at = (x: number, y: number, label: string) => ({ x, y, label });
    if (c.mig === MIG.Out && c.gx !== undefined && c.gy !== undefined) return at(c.gx, c.gy, `${KIND_NAMES[w.buildings.get(tileKey(c.gx, c.gy))?.id ?? 0] ?? 'gateway'} (leaving town)`);
    if (c.mig === MIG.In) return at(c.hx, c.hy, 'new home');
    if (c.state === S.ToWork) return c.study && !c.job ? at(c.sx, c.sy, KIND_NAMES[w.buildings.get(tileKey(c.sx, c.sy))?.id ?? 0] ?? 'school') : at(c.wx, c.wy, `${KIND_NAMES[c.kind]} (work)`);
    if (c.state === S.ToHome) return at(c.hx, c.hy, 'home');
    if (c.state === S.ToSite && c.site) { const [x, y] = parseKey(c.site); return at(x, y, 'building site'); }
    if (c.state === S.ToVenue && c.venue && c.errand) { const [x, y] = parseKey(c.venue); return at(x, y, c.errand === ERRAND_SCHOOL ? 'school (the school run)' : c.errand === ERRAND_CLASS ? 'college (evening class)' : c.errand === ERRAND_FUNERAL ? 'a funeral' : 'hospital (doctor)'); }
    if (c.state === S.ToVenue && c.venue) {
      const [x, y] = parseKey(c.venue); const b = w.buildings.get(c.venue);
      const sp = b && leisureAt(b.id, b.level, b.x, b.y);
      return at(x, y, sp ? sp.title : this.hour < 16 ? 'café' : b && b.level >= 2 ? 'restaurant' : 'bar');
    }
    return undefined;
  }
  /**
   * A night out for the first-person view (client render/nightout.ts): game hours at the venue so far (0 on the way there) and
   * whether the drink flows. Only for an ordinary outing: not the doctor, school, a class or a funeral. `drinks` is a café,
   * bar or restaurant visit begun from 16:00 to 04:00 (the hours the activity line calls "out at a bar"), not a coffee before
   * a shift, and not a cinema, theatre, park, sports hall or library.
   */
  private nightOf(c: Citizen): CitizenInfo['night'] | undefined {
    if (c.errand || (c.state !== S.ToVenue && c.state !== S.AtVenue)) return undefined;
    const at = c.state === S.AtVenue, tick = this.w.tick;
    const since = at ? Math.min(tick, c.venueSince ?? tick) : tick, h = (since % DAY) / TPH;
    const drinks = !this.venueSpecOf(c) && c.venueThen !== S.ToWork && (h >= 16 || h < 4);
    return { hours: at ? Math.round(((tick - since) / TPH) * 100) / 100 : 0, drinks };
  }
  /** The leisure place a citizen is visiting or heading to, if it is one (not a café, bar or the doctor). */
  private venueSpecOf(c: Citizen): LeisureSpec | undefined {
    const b = c.venue ? this.w.buildings.get(c.venue) : undefined;
    return b ? leisureAt(b.id, b.level, b.x, b.y) : undefined;
  }

  // ---- daily ------------------------------------------------------------

  private newDay() {
    const w = this.w;
    w.day++;
    for (const p of w.parcels.values()) {
      p.stats.taxYesterday = p.stats.taxToday;
      p.stats.taxToday = 0;
      if (p.stats.roads > 0) w.credit(p.owner, -w.roadUpkeepOf(p));
      w.dirtyParcels.add(p.id);
    }
    for (const b of w.buildings.values()) {
      if ((!isCivicId(b.id) && !isParkingId(b.id)) || b.level === 0) continue;
      const parcel = w.parcelAt(b.x, b.y);
      if (parcel && !w.mothballed.has(tileKey(b.x, b.y))) w.credit(parcel.owner, -upkeepOf(b.id, b.level)); // per level (parks have three); one-level kinds as before; none while mothballed (sim/finance.ts)
    }
    for (const c of w.citizens.values()) {
      this.skills.day(c); // brain drain: graduates out of work or over-qualified
      if (c.job || c.study || c.stage !== LifeStage.Adult) { c.idleDays = 0; continue; } // children, retirees and students are not looking for work
      if (c.mig) continue; // moving in or out already
      if (++c.idleDays > MAX_IDLE_DAYS) { this.skills.count(c); this.leaveTown(c); }
    }
    this.control.chargeCurfew(); // the lorry curfew's running cost (R5)
    w.parkFail.clear(); w.lotIncome.clear();
    this.leisureCache.clear(); // drops homes that are gone; the rest refill on first use
    this.jobMisses.clear(); // likewise
  }

  // ---- stats --------------------------------------------------------------

  private recomputeStats() {
    const w = this.w;
    let jobs = 0, employed = 0;
    const per = new Map<number, { population: number; jobs: number; employed: number; byKind: number[]; staffed: number[]; sites: number; buildings: number; value: number }>();
    const bucket = (pid: number) => {
      let s = per.get(pid);
      if (!s) { s = { population: 0, jobs: 0, employed: 0, byKind: new Array(KIND_ID_COUNT).fill(0), staffed: new Array(KIND_ID_COUNT).fill(0), sites: 0, buildings: 0, value: 0 }; per.set(pid, s); }
      return s;
    };
    this.services.length = 0;
    for (const b of w.buildings.values()) {
      const s = bucket(w.parcelIdAt(b.x, b.y));
      if (b.level > 0) { s.buildings++; s.value += buildingValue(b.id, b.level); } // book value (docs/world-map.md)
      if (b.zone === Zone.Residential) { s.population += b.occupants; continue; }
      if (b.lodgers) s.population += b.lodgers; // students in a hall of residence (sim/learning.ts)
      if (b.zone === Zone.Parking) continue;
      const cap = capacityOf(b.id, b.level);
      s.jobs += cap; s.employed += b.occupants; s.byKind[b.id] += cap; s.staffed[b.id] += b.occupants;
      jobs += cap; employed += b.occupants;
      if (isServiceId(b.id) && b.occupants > 0) this.services.push(b);
    }
    for (const site of w.sites.values()) bucket(w.parcelIdAt(site.x, site.y)).sites++;
    let moving = 0, driving = 0, out = 0, parked = 0, children = 0;
    for (const c of w.citizens.values()) {
      if (c.stage === LifeStage.Child) children++;
      if (c.state === S.ToWork || c.state === S.ToHome || c.state === S.ToSite || c.state === S.ToVenue) { moving++; if (c.leg?.drive) driving++; }
      if (c.state === S.AtVenue) out++;
      if (c.parkedAt) parked++;
    }
    for (const v of w.vehicles.values()) if (v.phase !== 'dwell') { moving++; driving++; } else parked++;
    this.population = w.citizens.size; this.children = children;
    this.jobs = jobs; this.employed = employed; this.vacantJobs = jobs - employed;
    this.moving = moving; this.driving = driving; this.outAndAbout = out; this.parkedCars = parked;
    const housed = new Map<string, number>(), filled = new Map<string, number>();
    for (const p of w.parcels.values()) {
      const s = per.get(p.id) ?? bucket(-1);
      housed.set(p.owner, (housed.get(p.owner) ?? 0) + s.population);
      filled.set(p.owner, (filled.get(p.owner) ?? 0) + s.employed);
      const st = p.stats;
      const value = Math.round(s.value + p.w * p.h * LAND_PRICE_PER_TILE + st.roads * ROAD_COST);
      const changed = s.population !== st.population || s.jobs !== st.jobs || s.employed !== st.employed || s.sites !== st.sites
        || s.buildings !== st.buildings || value !== st.value
        || s.byKind.some((v, i) => v !== st.jobsByKind[i]) || s.staffed.some((v, i) => v !== st.staffedByKind[i]);
      if (!changed) continue;
      st.population = s.population; st.jobs = s.jobs; st.employed = s.employed; st.sites = s.sites; st.buildings = s.buildings; st.value = value;
      st.jobsByKind = [...s.byKind]; st.staffedByKind = [...s.staffed];
      w.dirtyParcels.add(p.id);
    }
    for (const [owner, n] of housed) w.bump(owner, 'housed', n, true);
    for (const [owner, n] of filled) w.bump(owner, 'jobs', n, true);
  }

  /** A citizen's happiness parts as the daily update reads them now (sim/issues.ts asks why a very unhappy home is). */
  moodParts(c: Citizen) {
    return happinessParts(c, { coverage: Math.floor(this.coverage(c.hx, c.hy) + 1e-6), tick: this.w.tick, parks: this.leisureCoverage(c.hx, c.hy).parks, kids: this.families.homeParts(c, this.schools), bend: this.motive.bend(c) });
  }
  /**
   * Service coverage of a tile: for each service family (police, fire, health) the strongest staffed station whose
   * radius reaches it, summed. Radius and strength come from the station's tier (shared/src/tiers.ts); the original
   * stations are strength 1 within SERVICE_RADIUS, so with only those this is the count of distinct services in reach.
   * Smaller rungs give fractions (a police box is 0.4); happiness reads the whole part, growth and tax tolerance all of it.
   */
  /** Focus groups (net.ts inspect, for a viewer with the feature): the value mix of the people on the parcel at (x, y). */
  focusAt(x: number, y: number): FocusInfo | undefined {
    const p = this.w.parcelAt(x, y);
    return p ? this.motive.focus(p.id, p.name) : undefined;
  }
  /** A tile's service cover (0-3) and leisure tier (0-2), for the wear rate of a poster there (sim/adverts.ts). */
  areaCover(x: number, y: number): [number, number] { return [this.coverage(x, y), leisureTier(this.leisureCoverage(x, y).score)]; }
  private coverage(x: number, y: number): number {
    const best = this.coverBest;
    best.fill(0);
    for (const s of this.services) {
      const r = SERVICE_RADIUS_OF[s.id];
      if (Math.abs(s.x - x) <= r && Math.abs(s.y - y) <= r) { const v = SERVICE_STRENGTH_OF[s.id]; if (v > best[s.zone]) best[s.zone] = v; }
    }
    let n = 0;
    for (let k = 0; k < KIND_COUNT; k++) n += best[k];
    return n;
  }
  /** scratch for coverage(): the strongest station per family code */
  private coverBest = new Float64Array(16);

  /**
   * Leisure within reach of a home: the summed leisure value of every open-able place whose radius covers it (venues
   * only once they have staff), capped, and the parks' share of it. Cached per tile for a game hour.
   */
  private leisureCoverage(x: number, y: number) {
    const k = tkey(x, y), now = this.w.tick;
    const hit = this.leisureCache.get(k);
    if (hit && now - hit.at < TPH) return hit;
    let score = 0, parks = 0, nParks = 0, nVenues = 0;
    this.w.eachBuiltNear(x, y, LEISURE_CODES, LEISURE_MAX_RADIUS, (b, d) => {
      const sp = leisureAt(b.id, b.level, b.x, b.y);
      if (!sp || d > sp.radius || (sp.staffed && b.occupants === 0)) return;
      if (sp.blockOnly && !this.roundGarden(b, x, y)) return; // a communal garden counts for its own block's homes only
      score += sp.value;
      if (sp.type === 'park') { parks += sp.value; nParks++; } else nVenues++;
    });
    const v = { at: now, score: Math.min(LEISURE.coverageCap, score), parks, nParks, nVenues };
    this.leisureCache.set(k, v);
    return v;
  }
  /** Is the home at (x, y) on the ring of the block whose communal garden is b? */
  private roundGarden(b: Building, x: number, y: number) {
    const s = this.w.structureAt(b.x, b.y);
    return !!s && x >= s.ax - 1 && y >= s.ay - 1 && x <= s.ax + s.w && y <= s.ay + s.h;
  }

  /** Parks grow with use: a park busy enough yesterday opens an upgrade site (more paths, trees, a fountain). */
  private leisureGrowth() {
    const w = this.w;
    for (const code of LEISURE_CODES) {
      for (const b of w.builtOf(code)) {
        const sp = leisureAt(b.id, b.level, b.x, b.y);
        if (!sp || sp.upgradeVisits <= 0) continue;
        const key = tileKey(b.x, b.y);
        if (w.sites.has(key) || this.visitsAt(key).yesterday < sp.upgradeVisits || !w.hasRoadAccess(b.x, b.y)) continue;
        if (Math.random() < LEISURE_GROWTH_P) w.createSite(b.x, b.y, b.id, b.level + 1, workOf(b.id, b.level + 1));
      }
    }
  }

  /** Road tiles at the edge of the built-up area where through-traffic appears. */
  private findEntries() {
    const w = this.w;
    // with a motorway connection, through-traffic comes and goes through it (sim/gateways.ts); else the farthest roads
    const gates = this.gateways.motorwayEntries();
    this.motorway = gates.length > 0;
    if (gates.length) { this.entries = gates; return; }
    let best: ([number, number] | null)[] = [null, null, null, null];
    let bv = [-Infinity, -Infinity, -Infinity, -Infinity];
    for (const ch of w.chunks.values()) {
      if (!ch.modified) continue;
      for (let i = 0; i < ch.tiles.length; i++) {
        if (!isRoad(ch.tiles[i])) continue;
        const x = ch.cx * 32 + (i % 32), y = ch.cy * 32 + Math.floor(i / 32);
        const vals = [x, -x, y, -y];
        for (let d = 0; d < 4; d++) if (vals[d] > bv[d]) { bv[d] = vals[d]; best[d] = [x, y]; }
      }
    }
    this.entries = best.filter((e): e is [number, number] => !!e);
  }

  // ---- growth: zones queue construction sites; builders do the rest --------------

  /**
   * Zoned lots beside a road grow when there is demand (residential demand follows the job surplus and vice versa) and
   * only when mostly occupied. A 1×1 lot grows to level 3 on its own tile. From level 1 a building may instead merge with
   * neighbouring lots of its zone and owner into a bigger kind (shared/src/zones.ts) that climbs to level 7: a terrace
   * row, a department store, an office tower, a heavy plant. Nothing is built here: growth opens a construction site.
   * Work per pass stays bounded: the demand roll comes first, and only MERGE_SEARCHES_PER_PASS merge searches run.
   */
  private growth() {
    const w = this.w;
    const rDemand = Math.max(0, this.jobs - (this.population - this.children) + 6); // the children of families moving in take beds, not jobs
    const cDemand = Math.max(0, this.population - this.jobs + 6);
    const merges: MergePlan[] = [];
    const claimed = new Set<number>(); // tiles under a merge planned this pass
    this.held?.(claimed); // tiles on fire (sim/fires.ts): nothing grows into or out of a burning building
    let searches = 0;
    // merges under construction per parcel, so builders are not swamped and a district rebuilds a block or two at a time
    const building = new Map<number, number>();
    for (const s of w.sites.values()) if (s.merge) { const pid = w.parcelIdAt(s.x, s.y); building.set(pid, (building.get(pid) ?? 0) + 1); }
    for (const b of w.buildings.values()) {
      if (!isGrowableId(b.id)) continue;
      const key = tileKey(b.x, b.y);
      if (w.sites.has(key) || claimed.has(tkey(b.x, b.y))) continue;
      if (!w.hasRoadAccess(b.x, b.y)) {
        if (b.level > 0 && Math.random() < 0.1) this.decline(b);
        continue;
      }
      if (b.level >= MAX_LEVEL) continue;
      if (b.level > 0 && b.occupants < capacityOf(b.id, b.level) * 0.7) continue;
      const canUp = b.level < topLevelOf(b.id);
      if (!canUp && !GROW_FORMS[b.zone].length) continue;
      let p = Math.min(0.6, (b.zone === Zone.Residential ? (rDemand > 0 || !this.start.youngTown(b) ? rDemand : START_TUNING.youngDemand) : cDemand) / 30) * 0.25; // a new town's first homes grow without the world's job surplus (sim/firstfive.ts)
      let cov = 1;
      if (b.zone === Zone.Residential) {
        cov = this.coverage(b.x, b.y);
        p *= (1 + 0.2 * cov) * (1 + 0.15 * leisureTier(this.leisureCoverage(b.x, b.y).score)); // services, parks and venues help
      }
      if (Math.random() >= p) continue;
      // merge with the neighbours (always worth a look at the kind's top level), else grow in place
      const pid = w.parcelIdAt(b.x, b.y);
      if (b.level >= 1 && searches < MERGE_SEARCHES_PER_PASS && merges.length < MERGES_PER_PASS && (building.get(pid) ?? 0) < MERGE_SITES_PER_PARCEL
        && (!canUp || Math.random() < MERGE_P)) {
        searches++;
        const plan = this.planMerge(b, cov, claimed);
        if (plan) { merges.push(plan); building.set(pid, (building.get(pid) ?? 0) + 1); continue; }
      }
      if (!canUp) continue;
      const target = b.level + 1;
      const merged = isMergedKind(b.id);
      if (merged && target > this.ambition(b.x, b.y) + this.learning.lift(b)) continue; // this neighbourhood stops here (a research institute near an office lifts it)
      const need = levelFeature(target);
      if (need && !w.ownerHas(b.x, b.y, need, hasFeature)) continue; // the owner's builders can't raise anything taller yet
      if (b.zone === Zone.Residential && target >= 3 && cov === 0) continue; // the top tiers want services nearby
      if (this.powerGate && !this.powerGate(b, target)) continue; // two storeys and up need power (sim/utilities.ts)
      w.createSite(b.x, b.y, b.id, target, workOf(b.id, target)); // the catalogue's work: a first house is a third of WORK_PER_LEVEL (docs/first-five.md)
    }
    if (merges.length) w.mergeLots(merges);
  }

  /** A zoned building that lost its road shrinks a level now and then; a merged one falls back into empty lots. */
  private decline(b: Building) {
    const w = this.w;
    if (isMergedKind(b.id) && b.level - 1 < firstLevelOf(b.id)) {
      const s = w.structureAt(b.x, b.y);
      if (s) w.removeStructure(s);
      return;
    }
    w.setTile(b.x, b.y, withLevel(w.getTile(b.x, b.y), b.level - 1));
  }

  /**
   * How tall a neighbourhood lets merged lots grow: a hash of the 7×7-tile cell picks low-rise (3), mid-rise (5) or
   * high-rise (7) character and a per-lot hash nudges it a level either way, so streets mix sizes and not every
   * block becomes towers.
   */
  private ambition(x: number, y: number): number {
    const hood = hash2(Math.floor(x / 7) * 7 + 3, Math.floor(y / 7) * 13 + 5);
    const lot = hash2(x * 13 + 7, y * 29 + 11);
    const a = (hood < 0.3 ? 3 : hood < 0.65 ? 5 : 7) + (lot < 0.25 ? -1 : lot > 0.85 ? 1 : 0);
    return Math.max(2, Math.min(MAX_LEVEL, a));
  }

  /**
   * Find a merge for building b: a merged kind of its zone (shared/src/zones.ts GROW_FORMS) whose footprint, in some
   * orientation and offset, covers b and only lots of the same zone and owner that are empty or no taller than b
   * (1×1 lots or whole smaller merged buildings, none under construction), with its door on a road. The level is
   * one up from b's (or the kind's first level, at most MERGE_JUMP up), within the neighbourhood's ambition and the
   * owner's technology, and the new building must hold everyone already living or working there. Kinds, turns and
   * offsets are tried from hash-seeded starting points, so neighbouring lots pick different shapes. The footprint is
   * checked once more by the shared placement rule (planStructure) with the merged lots seen as empty lots.
   */
  private planMerge(b: Building, cov: number, claimed: Set<number>): MergePlan | null {
    const w = this.w;
    const forms = GROW_FORMS[b.zone];
    const owner = w.parcelAt(b.x, b.y)?.owner;
    if (!forms.length || !owner) return null;
    const s = isMultiTile(b.id) ? w.structureAt(b.x, b.y) : null;
    const bx = s ? s.ax : b.x, by = s ? s.ay : b.y, bw = s ? s.w : 1, bh = s ? s.h : 1;
    const ambition = this.ambition(b.x, b.y) + this.learning.lift(b);
    const h1 = hash2(b.x * 7 + 1, b.y * 11 + 2), h2 = hash2(b.x * 3 + 5, b.y * 5 + 9 + w.day);
    const n = forms.length, f0 = Math.floor(h1 * n);
    for (let i = 0; i < n; i++) {
      const f = forms[(f0 + i) % n];
      if (f.kindId === b.id || f.area < bw * bh) continue;
      const target = Math.max(b.level + 1, f.minLevel);
      if (target > f.topLevel || target - b.level > MERGE_JUMP || target > ambition) continue;
      if (b.zone === Zone.Residential && target >= 3 && cov === 0) continue;
      const need = levelFeature(target);
      if (need && !w.ownerHas(b.x, b.y, need, hasFeature)) continue;
      if (this.powerGate && !this.powerGate(b, target)) continue; // a merge to two storeys and up needs power too
      const cap = capacityOf(f.kindId, target);
      const r0 = Math.floor(h2 * 4);
      for (let ri = 0; ri < 4; ri++) {
        const r = (r0 + ri) & 3;
        const W = r & 1 ? f.h : f.w, H = r & 1 ? f.w : f.h;
        if (W < bw || H < bh) continue;
        const nx = W - bw + 1, ny = H - bh + 1, m = nx * ny, k0 = Math.floor(h2 * 997) % m;
        for (let k = 0; k < m; k++) {
          const kk = (k0 + k) % m;
          const p = placedFromAnchor(f.kindId, bx - (kk % nx), by - Math.floor(kk / nx), r);
          const ft = w.peekTile(p.frontX, p.frontY);
          if (ft === undefined || !isRoad(ft)) continue;
          if (f.deep && !deepBackOk(w, p, b.zone)) continue; // a deep plot grows back into the block's landlocked middle only (sim/blocks.ts)
          const occ = this.mergeOccupants(p, b, owner, claimed);
          if (occ < 0 || occ > cap) continue;
          const inside = (x: number, y: number) => x >= p.ax && y >= p.ay && x < p.ax + p.w && y < p.ay + p.h;
          const v = planStructure(f.kindId, p.doorX, p.doorY, {
            tile: (x, y) => { const t = w.peekTile(x, y); return t !== undefined && inside(x, y) ? packTile(terrainOf(t), false, b.zone, 0) : t; },
            aux: (x, y) => (inside(x, y) ? 0 : w.auxAt(x, y)),
            sub: (x, y) => (inside(x, y) ? 0 : w.subAt(x, y)),
            land: (x, y) => (w.parcelAt(x, y)?.owner === owner ? null : 'Not your land'),
          }, r);
          if (!v.ok) continue;
          for (let y = p.ay; y < p.ay + p.h; y++) for (let x = p.ax; x < p.ax + p.w; x++) claimed.add(tkey(x, y));
          return { placed: v.placed, target, work: workOf(f.kindId, target) };
        }
      }
    }
    return null;
  }

  /**
   * People living or working in the buildings a merge footprint would take in, or -1 when it may not: every tile a lot
   * of b's zone and owner, not a road, water or a site, no taller than b, a structure only when wholly inside.
   */
  private mergeOccupants(p: { ax: number; ay: number; w: number; h: number }, b: Building, owner: string, claimed: Set<number>): number {
    const w = this.w;
    let occ = 0;
    const seen: Building[] = [];
    for (let y = p.ay; y < p.ay + p.h; y++) for (let x = p.ax; x < p.ax + p.w; x++) {
      if (claimed.has(tkey(x, y))) return -1;
      const t = w.peekTile(x, y);
      if (t === undefined || isRoad(t) || !isBuildable(t) || underConstruction(t)) return -1;
      if (w.parcelAt(x, y)?.owner !== owner) return -1;
      const s = w.auxAt(x, y) ? w.structureAt(x, y) : null;
      const inside = !!s && s.ax >= p.ax && s.ay >= p.ay && s.ax + s.w <= p.ax + p.w && s.ay + s.h <= p.ay + p.h;
      if (s?.kind === GARDEN_KIND) { if (!inside) return -1; continue; } // a block's communal garden, taken in whole by a merge reaching into the middle
      if (zoneOf(t) !== b.zone) return -1;
      let bb: Building | undefined;
      if (w.auxAt(x, y)) {
        if (!s || !isGrowableId(s.kind) || s.ax < p.ax || s.ay < p.ay || s.ax + s.w > p.ax + p.w || s.ay + s.h > p.ay + p.h) return -1;
        bb = w.buildings.get(tileKey(s.doorX, s.doorY));
      } else bb = w.buildings.get(tileKey(x, y));
      if (!bb || (bb !== b && bb.level > b.level) || w.sites.has(tileKey(bb.x, bb.y))) return -1;
      if (!seen.includes(bb)) { seen.push(bb); occ += bb.occupants; }
    }
    return occ;
  }

  // ---- population -----------------------------------------------------------

  private spawn() {
    const w = this.w;
    for (const b of w.buildings.values()) {
      if (b.zone !== Zone.Residential || b.level === 0) continue;
      const cap = capacityOf(b.id, b.level);
      const queued = this.gateways.pendingAt(b.x, b.y); // newcomers already on their way through a gateway
      if (b.occupants + queued >= cap || (b.occupants + queued >= cap - 1 && (b.holdUntil ?? 0) > w.tick)) continue; // the last bed is held for a family
      if (this.vacantJobs <= 0 && Math.random() > 0.05 && !this.start.followers(b)) continue; // a new town's first beds fill behind a wage (sim/firstfive.ts)
      // a merged block or tower fills like the lots it replaced: one chance per dozen beds (a 1×1 home holds at most 12)
      const tries = cap > 12 ? Math.ceil(cap / 12) : 1;
      for (let i = 0; i < tries; i++) {
        const q = this.gateways.pendingAt(b.x, b.y);
        if (i > 0 && (b.occupants + q >= cap || (b.occupants + q >= cap - 1 && (b.holdUntil ?? 0) > w.tick))) break;
        if (Math.random() < 0.25) this.newcomer(b);
      }
    }
  }

  private spawnCitizen(home: Building) {
    const w = this.w;
    const id = w.nextId++;
    const n = this.skills.newcomer(id, seededAge(id, LIFE.newcomerMin, LIFE.newcomerMax));
    const c = this.makeCitizen(id, home, n.age, 70 + 28 * hash2(id, 212), n.edu);
    w.addCitizen(c);
    home.occupants++;
    this.start.settled(c); // the first settlers on a player's land (sim/firstfive.ts)
    if (this.vacantJobs > 0) this.findJob(c);
    this.families.join(c, home, false); // about a fifth come with a partner and children (sim/families.ts)
  }
  // ---- migration through gateways (sim/gateways.ts) ------------------------------

  /** A home with room wants a newcomer: queue one at a gateway, or with none in town spawn them in place as before. */
  private newcomer(home: Building) {
    if (this.gateways.request(home, SPAWN_EVERY)) return;
    this.spawnCitizen(home);
    if (this.w.filling) return;
    this.gateways.totals.fallbackIn++;
    const owner = this.w.parcelAt(home.x, home.y)?.owner;
    if (owner) this.notice(owner, 'Newcomers are moving straight into your homes: place a motorway connection (Transport, at a road end on the edge of town) or a station so they arrive and leave through it');
  }
  /** Taxi ranks: the doors of the gateways people may leave by taxi (stations, the airport, coach depots). */
  private *taxiRanks(): Iterable<[number, number]> {
    for (const g of this.gateways.list) if (g.spec.modes.includes('taxi')) yield [g.x, g.y];
  }
  /** Tell an owner once, until the situation changes (see `noticed`). */
  private notice(owner: string, msg: string) {
    if (this.noticed.has(owner)) return;
    this.noticed.add(owner);
    this.notices.push({ owner, msg });
  }
  /**
   * A newcomer released at gate g for the home at (hx, hy): they appear at the gate and travel home with their luggage.
   * `tag`: a student coming for a university (sim/learning.ts), who has a bed and a place waiting.
   */
  private arriveVia(g: Gate, hx: number, hy: number, tag = 0) {
    const w = this.w;
    const home = w.buildings.get(tileKey(hx, hy));
    if (tag) { const s = this.learning.student(home, tag); if (s) this.travelIn(s, g); return; }
    if (!home || home.zone !== Zone.Residential || home.level === 0 || home.occupants >= capacityOf(home.id, home.level)) return; // gone or filled meanwhile
    const id = w.nextId++;
    const n = this.skills.newcomer(id, seededAge(id, LIFE.newcomerMin, LIFE.newcomerMax));
    const c = this.makeCitizen(id, home, n.age, 70 + 28 * hash2(id, 212), n.edu);
    w.addCitizen(c);
    home.occupants++;
    this.travelIn(c, g);
    this.families.join(c, home, c.mig === MIG.In); // about a fifth come with a partner and children (sim/families.ts)
  }
  /** Newcomer c (in the world and their home) sets off from gate g for home. */
  private travelIn(c: Citizen, g: Gate) {
    c.mig = MIG.In; c.gx = g.x; c.gy = g.y; c.x = g.x + 0.5; c.y = g.y + 0.5;
    this.gateways.noteIn(g);
    this.noticed.clear();
    if (this.migrate(c, g, c.hx, c.hy, true)) { c.state = S.ToHome; return; }
    // no way from this gate to the home: they turn up at the door all the same
    this.gateways.unroutable++;
    c.x = c.hx + 0.5; c.y = c.hy + 0.5;
    this.migrantHome(c);
  }
  /**
   * A family moving in with c (sim/families.ts): p, at the gate, rides in c's car or walks beside c; false when they
   * cannot come along (c took a taxi, the car is full), and p goes straight to the door.
   */
  private followIn(p: Citizen, c: Citizen): boolean {
    const start = this.carStart(c);
    if (start) return CARPOOL.on && this.pool.booked(c) < CARPOOL.seats && this.takeLift(p, c, start, null, [p.hx, p.hy]);
    const l = c.leg;
    if (!l || l.drive || l.hail || l.lift || l.ride) return false;
    resetTrail(p, Math.floor(p.x), Math.floor(p.y));
    today(p, this.today); p.tripsToday++; p.tripStart = this.w.tick;
    p.legs = [{ path: l.path.slice(), drive: false, arrive: 'none' }];
    this.startLeg(p);
    return true;
  }
  /**
   * Plan the trip between a gate and (dx, dy) from where the citizen is: their own car through a motorway, a taxi
   * (a car trip that ends at the door) or a walk with a suitcase (Gateways.modeFor). False when there is no way.
   */
  private migrate(c: Citizen, g: Gate, dx: number, dy: number, inbound: boolean): boolean {
    const w = this.w;
    const fx = Math.floor(c.x), fy = Math.floor(c.y);
    this.traffic.leave(c); this.transit.drop(c); this.taxis.drop(c); this.pool.forget(c);
    c.legs = []; c.leg = null; c.pts = null;
    resetTrail(c, fx, fy);
    today(c, Math.floor(w.tick / DAY)); c.tripsToday++; c.tripStart = w.tick;
    if (fx === dx && fy === dy) { c.path = [dx, dy]; c.pi = 1; return true; }
    const mode = this.gateways.modeFor(g, c, Math.abs(dx - fx) + Math.abs(dy - fy));
    if (mode === 'taxi') {
      // a real taxi from the rank when one is free nearby (sim/taxis.ts); else the ride as before
      const q = this.taxis.quote(fx, fy, dx, dy);
      const leg = q && c.money >= q.fare ? this.taxis.book(c, q, fx, fy, dx, dy) : null;
      if (leg) { c.legs = [leg]; this.modeLog.taxi++; this.startLeg(c); return true; }
    }
    if (mode !== 'foot') {
      // a car comes off (or goes onto) the road in front of the gate, not out of the building
      const [sx, sy] = inbound ? [g.fx, g.fy] : [fx, fy], [ex, ey] = inbound ? [dx, dy] : [g.fx, g.fy];
      const route = findRoute(w, sx, sy, ex, ey, (x, y) => this.traffic.cost(x, y));
      // their own car parks at home on the way in; a taxi just drops them off, and a car on the way out leaves town
      // their own car coming in may carry the family (sim/families.ts): a carpool trip
      if (route && route.path.length >= 4) { c.legs = [{ path: route.path, drive: true, arrive: inbound && mode === 'car' ? 'parkHome' : 'none', dest: [ex, ey], ...(inbound && mode === 'car' ? { pool: this.pool.token() } : {}) }]; c.x = sx + 0.5; c.y = sy + 0.5; }
    }
    if (!c.legs.length) {
      const wp = pathBetween(w, fx, fy, dx, dy);
      if (!wp) return false;
      c.legs = [{ path: wp, drive: false, arrive: 'none' }];
    }
    if (c.legs[0].drive) this.modeLog.drive++; else this.modeLog.walk++;
    this.startLeg(c);
    return true;
  }
  /** A citizen who is leaving town: with a gateway they pack up and travel out through it, without one they go at once. */
  private leaveTown(c: Citizen) {
    if (!this.gateways.any) { this.gateways.totals.fallbackOut++; this.w.removeCitizen(c); return; }
    if (c.mig === MIG.Out || c.mig === MIG.Leaving) return;
    c.mig = MIG.Leaving;
    if (c.state === S.Home) this.migrantHome(c); // otherwise when they are next home
  }
  /** A migrant at home: a newcomer has moved in, a leaver sets off, and one who was on the way out has gone. */
  private migrantHome(c: Citizen) {
    const w = this.w;
    if (c.mig === MIG.In) {
      c.mig = 0; c.gx = undefined; c.gy = undefined;
      this.start.settled(c); // the first settlers on a player's land (sim/firstfive.ts)
      if (this.vacantJobs > 0 && c.stage === LifeStage.Adult && !c.study) this.findJob(c); // not the children or students moving in
      return;
    }
    if (c.mig === MIG.Out) { // arrived at the gate (or gave up on the trip): gone, and the bed is free
      this.gateways.noteOut(this.gateways.at(c.gx, c.gy));
      w.removeCitizen(c);
      return;
    }
    const g = this.gateways.forDeparture(c, c.hx, c.hy);
    if (!g) { this.gateways.totals.fallbackOut++; w.removeCitizen(c); return; }
    w.quitJob(c); this.dropVenue(c); c.care = 0; c.errand = 0;
    c.mig = MIG.Out; c.gx = g.x; c.gy = g.y;
    if (!this.migrate(c, g, g.x, g.y, false)) { this.gateways.noteOut(g); w.removeCitizen(c); return; }
    c.state = S.ToHome; // travelling; arriveHome sees MIG.Out and lets them go
  }

  /** A citizen at home in `home`, of the given age and health, in a household of their own. */
  private makeCitizen(id: number, home: Building, age: number, health: number, edu: EduFields = eduDefaults(id, age)): Citizen {
    const w = this.w;
    return {
      id, hx: home.x, hy: home.y, job: false, wx: 0, wy: 0, kind: 0,
      x: home.x + 0.5, y: home.y + 0.5, state: S.Home,
      path: [], pi: 0, commute: null, money: 40,
      shiftStart: 0, shiftLen: 0, cycle: [1], phase: 0, nextAt: 0,
      idleDays: 0, site: null, venue: null, venueUntil: 0, venueThen: S.ToHome, preStop: false,
      car: w.ownsCar(id, 0), legs: [], leg: null, parkedAt: null, parkKerb: false,
      ...w.moverDefaults(id),
      ...lifeDefaults(id, w.tick, age, health),
      ...edu,
      leisure: LEISURE.start + LEISURE.startSpread * hash2(id, 219), // newcomers arrive neither bored nor fresh from a holiday
      ...citizenLater(),
      vals: this.motive.seed(id, home), // what they care about, drawn by the area they move into (sim/motivation.ts)
    };
  }

  /**
   * The nearest workplace with a vacancy by road from home. A search that finds nothing has walked its whole node
   * budget, which on a big map is thousands of tiles, and every newcomer to a home with no work in reach would walk it
   * again: so a miss is remembered with the tiles it looked at and the full workplaces it passed, and stands, giving
   * the same answer without searching, until one of those workplaces has room again or World.jobEditedSince sees a
   * workplace or road edit over those tiles.
   *
   * Education (sim/skills.ts): a vacancy is a place this citizen's level may take, a skilled place they qualify for
   * or an unskilled one, so a miss is remembered per home and level.
   */
  private findJob(c: Citizen): boolean {
    const w = this.w, sk = this.skills, edu = c.edu;
    const home = tkey(c.hx, c.hy) * 8 + (SKILLS.on ? edu : 0);
    const miss = this.jobMisses.get(home);
    if (miss) {
      if (!w.jobEditedSince(miss.x0, miss.y0, miss.x1, miss.y1, miss.edits) && miss.full.every((b) => sk.placeFor(b, edu) === Place.None)) return false;
      this.jobMisses.delete(home);
    }
    let x0 = c.hx, y0 = c.hy, x1 = c.hx, y1 = c.hy;
    const full = new Set<Building>(), kinds = new Set<number>();
    const isGoal = (x: number, y: number) => {
      if (x < x0) x0 = x; else if (x > x1) x1 = x;
      if (y < y0) y0 = y; else if (y > y1) y1 = y;
      const t = w.peekTile(x, y);
      if (t === undefined || isRoad(t) || !hasJobs(zoneOf(t))) return false; // most tiles looked at: no map lookup
      const b = w.buildings.get(tileKey(x, y));
      if (!b || !hasJobs(b.zone) || (w.mothballed.size && w.mothballed.has(tileKey(x, y)))) return false; // a mothballed service hires nobody (sim/finance.ts)
      if (sk.placeFor(b, edu) !== Place.None) return newKind(kinds, b); // the nearest of each kind and level: the choices differ
      full.add(b);
      return false;
    };
    // motivation (sim/motivation.ts): a few vacancies from the same search, scored by what the citizen cares about
    const rs = MOTIVATION.on && MOTIVATION.jobs ? findPaths(w, c.hx, c.hy, isGoal, undefined, MOTIVE.jobOptions, MOTIVE.jobSlack, MOTIVE.jobExtraNodes) : null;
    const r = rs ? rs[this.pickJob(c, rs)] : findPath(w, c.hx, c.hy, isGoal);
    if (!r) { this.jobMisses.set(home, { x0: x0 - 2, y0: y0 - 2, x1: x1 + 2, y1: y1 + 2, edits: w.jobEdits, full: [...full] }); return false; }
    this.hire(c, w.buildings.get(tileKey(r.gx, r.gy))!, r.path);
    return true;
  }
  /** The scored choice among a search's vacancies (an index into rs; 0, the nearest, with one). */
  private pickJob(c: Citizen, rs: { path: number[]; gx: number; gy: number }[]): number {
    if (rs.length <= 1) return 0;
    const facts = rs.map((r) => { const b = this.w.buildings.get(tileKey(r.gx, r.gy))!; return this.motive.jobFacts(c, b, r.path.length / 2 - 1, this.skills.placeFor(b, c.edu)); });
    return this.motive.pickJob(c, facts);
  }
  /**
   * A worker's look for a better job (Motivation.daily): the scored best of a fresh search from home, never their own
   * workplace. No miss cache: a worker with a job is not a newcomer to a home with no work in reach.
   */
  private jobOptions(c: Citizen, except?: Building): { b: Building; path: number[]; place: number } | null {
    const w = this.w, sk = this.skills, edu = c.edu, kinds = new Set<number>();
    const rs = findPaths(w, c.hx, c.hy, (x, y) => {
      const t = w.peekTile(x, y);
      if (t === undefined || isRoad(t) || !hasJobs(zoneOf(t))) return false;
      const b = w.buildings.get(tileKey(x, y));
      if (!b || b === except || !hasJobs(b.zone) || (w.mothballed.size && w.mothballed.has(tileKey(x, y)))) return false;
      return sk.placeFor(b, edu) !== Place.None && newKind(kinds, b);
    }, undefined, MOTIVE.jobOptions, MOTIVE.jobSlack, MOTIVE.jobExtraNodes);
    if (!rs.length) return null;
    const r = rs[this.pickJob(c, rs)], b = w.buildings.get(tileKey(r.gx, r.gy))!;
    return { b, path: r.path, place: sk.placeFor(b, edu) };
  }

  private hire(c: Citizen, b: Building, commute: number[]) {
    this.skills.hired(c, b); // before the count: it reads which places are free
    b.occupants++;
    c.job = true; c.wx = b.x; c.wy = b.y; c.kind = b.id; c.commute = commute; c.idleDays = 0;
    const occ = this.mobile.rotaFor(c) ?? OCCUPATIONS[b.id]; // a road job keeps its own hours (docs/mobile-jobs.md)
    const shift = pickShift(occ);
    const jitter = (Math.random() + Math.random() - 1) * TPH * 0.5; // mostly small, up to ±30 min
    c.shiftStart = mod(Math.round(hoursToTicks(shift.start) + jitter), DAY);
    c.shiftLen = hoursToTicks(shift.hours);
    c.cycle = occ.cycles[Math.floor(Math.random() * occ.cycles.length)];
    c.phase = occ.rotate ? Math.floor(Math.random() * c.cycle.length) : 0;
    c.car = c.car || this.w.ownsCar(c.id, b.id); // a better job can mean a car
    if (this.vacantJobs > 0) this.vacantJobs--;
    this.scheduleNext(c);
    this.start.hired(c, b); // a starter yard's crew sets out now (sim/firstfive.ts)
  }

  // ---- schedule -------------------------------------------------------------

  /** Whether the next commute will be driven, judged from home. */
  private willDrive(c: Citizen) {
    return c.car && (c.parkedAt !== null || Math.abs(c.wx - c.hx) + Math.abs(c.wy - c.hy) >= DRIVE_MIN_TILES);
  }
  private lead(c: Citizen) {
    const tiles = c.commute ? c.commute.length / 2 : 10;
    const drive = this.willDrive(c);
    const speed = drive ? DRIVE_SPEED * 0.7 : WALK_SPEED; // drivers allow for traffic and parking
    return Math.ceil(tiles / speed) + LEAD_SLACK + (c.preStop ? PRE_STOP_TICKS : 0);
  }
  private worksOn(c: Citizen, dayIdx: number) { return c.cycle[mod(dayIdx + c.phase, c.cycle.length)] === 1; }

  /** Pick the next departure: early enough for the commute (and a café stop), on a working day, after some rest. */
  private scheduleNext(c: Citizen) {
    const now = this.w.tick;
    c.preStop = c.job && Math.random() < P_PRE_STOP; // no café on the way to school
    const lead = this.lead(c);
    const depTod = mod(c.shiftStart - lead, DAY);
    let t = Math.floor(now / DAY) * DAY + depTod;
    while (t < now + REST_TICKS) t += DAY;
    for (let i = 0; i < 14 && !this.worksOn(c, Math.floor((t + lead) / DAY)); i++) t += DAY;
    c.nextAt = t;
    this.start.rescheduled(c, REST_TICKS); // a starter yard's crew goes out again after a rest on its first day (sim/firstfive.ts)
  }

  // ---- movement & daily routine ---------------------------------------------

  private moveCitizens() {
    const w = this.w;
    const tick = w.tick;
    this.today = Math.floor(tick / DAY);
    for (const c of w.citizens.values()) {
      // one life step per citizen per game day, staggered by id over the day
      if ((tick + c.id) % DAY === 0 && !c.mig) { this.lifeStep(c); if (!w.citizens.has(c.id)) continue; }
      switch (c.state) {
        case S.Home:
          if (c.mig) { this.migrantHome(c); break; } // moving in, or packed up and leaving (sim/gateways.ts)
          if (c.care > 0 && tick >= c.care && this.maybeDoctor(c)) break;
          if (!c.job) {
            if (c.study) { // pupils and students keep the school's timetable (sim/schools.ts), and look for no job
              if (tick >= c.nextAt) this.schools.setOff(c);
              else if (c.nextAt - tick > 4 * TPH) this.maybeOuting(c);
              break;
            }
            if (c.stage === LifeStage.Adult && (tick + c.id) % JOB_SEARCH_EVERY === 0 && this.findJob(c)) break;
            this.maybeOuting(c);
          } else if (tick >= c.nextAt) this.depart(c);
          else if (c.nextAt - tick > 4 * TPH) this.maybeOuting(c);
          break;
        case S.ToWork:
          if (this.advance(c)) { c.state = S.Work; this.noteCommute(c); }
          break;
        case S.Work:
          if (tick >= c.nextAt) this.endShift(c);
          else if (familyOf(c.kind) === Zone.Yard && (tick + c.id) % SITE_SEARCH_EVERY === 0) this.seekSite(c);
          break;
        case S.ToSite:
          if (tick >= c.nextAt) this.endShift(c);
          else if (this.advance(c)) c.state = S.AtSite;
          break;
        case S.AtSite:
          if (tick >= c.nextAt) this.endShift(c);
          else this.workSite(c);
          break;
        case S.ToHome:
          if (this.advance(c)) this.arriveHome(c);
          break;
        case S.ToVenue:
          if (this.advance(c)) this.arriveVenue(c);
          break;
        case S.AtVenue:
          if (tick >= c.venueUntil) this.leaveVenue(c);
          break;
      }
    }
  }

  private depart(c: Citizen) {
    if (this.death.staysHome(c)) { this.scheduleNext(c); return; } // a funeral in the family, or grief (sim/death.ts)
    if (this.staysOffSick(c)) {
      c.sickDays++; c.offSickDay = this.today; this.lifeEvents.sickDaysOff++;
      this.scheduleNext(c); // skip this shift; the next one is at least REST_TICKS away
      return;
    }
    if (!this.commutePath(c)) { this.dropCommute(c); return; }
    const startAbs = c.nextAt + this.lead(c);
    c.nextAt = startAbs + c.shiftLen; // shift ends on schedule however long the trip takes
    if (this.mobile.worksFromHome(c)) { c.state = S.Work; return; } // private hire: logs on at home (sim/mobile.ts)
    if (c.preStop && c.money >= MIN_SPENDING_MONEY && this.goToVenue(c, S.ToWork)) return;
    if (!this.plan(c, c.wx, c.wy)) { this.dropCommute(c); return; }
    c.state = S.ToWork;
    this.shareToWork(c);
    this.schools.leaving(c); // a young child goes along to school on a parent's way to work (sim/schools.ts)
  }
  /** No way to work: the job goes; no way to school: the place goes (sim/schools.ts admits again where there is a way). */
  private dropCommute(c: Citizen) {
    if (c.study && !c.job) this.schools.leave(c, EduResult.Left); else this.w.quitJob(c);
  }
  /** The end of a shift or a school day: a wage, or a day attended. */
  private shiftDone(c: Citizen) {
    if (c.study && !c.job) this.schools.attended(c); else this.payWage(c);
  }

  /** The walking route home→work, cached; drivers plan afresh each trip with live traffic. */
  private commutePath(c: Citizen): number[] | null {
    if (c.commute && pathStillValid(this.w, c.commute)) return c.commute;
    c.commute = pathBetween(this.w, c.hx, c.hy, c.wx, c.wy);
    return c.commute;
  }

  private endShift(c: Citizen) {
    if (c.state === S.Work && this.mobile.holdShift(c)) return; // out on the road: finish the job and come back first (sim/mobile.ts)
    if (c.state === S.Work && c.study && !c.job && this.schools.pickUp(c)) return; // an under-8 waits to be fetched
    if (c.state === S.Work && this.waitForLift(c)) return; // a lift home with someone finishing a little later
    this.shiftDone(c);
    this.w.leaveSite(c);
    if (!this.w.citizens.has(c.id)) return;
    const h = this.hour;
    const p = h >= 16 && h <= 23.5 ? P_AFTER_EVENING : P_AFTER_OTHER;
    if (c.money >= MIN_SPENDING_MONEY && Math.random() < p && this.goToVenue(c, S.ToHome)) { this.bringCompany(c, false); return; }
    this.goHome(c);
    if (c.state === S.ToHome) { if (c.study) this.schools.homeward(c); this.shareFromWork(c); }
  }

  private goHome(c: Citizen) {
    if (!this.plan(c, c.hx, c.hy)) { this.teleportHome(c); return; }
    c.state = S.ToHome;
  }

  private arriveHome(c: Citizen) {
    c.state = S.Home;
    c.eduBits &= ~EDU_HOMEWARD;
    if (c.mig) { this.migrantHome(c); return; }
    if (c.stage !== LifeStage.Child && !(c.study && !c.job)) this.payHomeTax(c); // full-time students pay no council tax
    if (this.w.citizens.has(c.id) && (c.job || c.study)) this.scheduleNext(c);
  }

  // ---- venues: cafés before work, bars and restaurants after, parks and leisure venues by type --------------------

  private goToVenue(c: Citizen, then: number): boolean {
    const w = this.w;
    // a day or night out (not the café stop before work) may go to a park, cinema, theatre, sports hall or library instead
    if (then === S.ToHome) {
      const lb = this.pickLeisure(c, false);
      if (lb && this.tripToVenue(c, lb.x, lb.y, then)) return true;
    }
    const fx = Math.floor(c.x), fy = Math.floor(c.y);
    const r = findPath(w, fx, fy, (x, y) => {
      const key = tileKey(x, y);
      const b = w.buildings.get(key);
      if (!b || b.zone !== Zone.Commercial || b.level === 0) return false;
      if ((this.visitors.get(key) ?? 0) >= venueCapacityOf(b.id, b.level)) return false;
      return Math.random() < 0.6; // don't all pile into the nearest place
    }, 900);
    if (!r) return false;
    return this.tripToVenue(c, r.gx, r.gy, then);
  }
  /**
   * The best leisure place for this outing, or null when a bar would do better or nothing suitable is open in reach.
   * Score: appeal at this time of day, to this life stage and around an event's start, times the citizen's own
   * hash-seeded taste for that kind of place, how much good it does and how much they need it, over distance, with
   * some chance. A bar visit is the yardstick it has to beat. `freeOnly`: a child on their own, free places nearby.
   */
  private pickLeisure(c: Citizen, freeOnly: boolean): Building | null {
    const w = this.w;
    if (!LEISURE_CODES.some((code) => w.builtOf(code).length > 0)) return null;
    const h = this.hour, evening = h >= 17;
    const fx = Math.floor(c.x), fy = Math.floor(c.y);
    const needMul = 0.7 + 0.8 * leisureNeed(c);
    let best: Building | null = null;
    let bestScore = freeOnly ? 0.15 : BAR_YARDSTICK * (0.6 + 0.8 * Math.random()) * this.motive.yardstick(c);
    w.eachBuiltNear(fx, fy, LEISURE_CODES, freeOnly ? CHILD_TRIP_MAX : LEISURE_TRIP_MAX, (b, d) => {
      const sp = leisureAt(b.id, b.level, b.x, b.y);
      if (!sp || sp.blockOnly) return; // a block's communal garden is for the homes round it; no road leads there
      if (freeOnly ? sp.ticket > 0 : c.money < Math.max(MIN_SPENDING_MONEY, sp.ticket * EVENT_TICKET)) return;
      // open now and not about to close
      if (!isOpenAt(sp, h, b.x, b.y) || !isOpenAt(sp, Math.min(23.99, h + sp.stayMin * 0.5), b.x, b.y)) return;
      if (sp.staffed && b.occupants === 0) return; // nobody on the payroll: shut
      if ((this.visitors.get(tileKey(b.x, b.y)) ?? 0) >= sp.capacity) return;
      const stage = c.stage === LifeStage.Retired ? sp.retiree : c.stage === LifeStage.Child ? sp.child : 1;
      const taste = 0.35 + 1.3 * hash2(c.id, 301 + VENUE_TYPE_INDEX[sp.type]);
      const pull = this.eventNow(sp, b) ? EVENT_PULL * sp.eventSize : 1; // bigger venues, bigger nights
      const score = ((evening ? sp.evening : sp.day) * stage * taste * pull * (0.5 + sp.value / 8) * needMul * (0.6 + 0.8 * Math.random())) / (1 + d / 12)
        * (MOTIVATION.on && MOTIVATION.leisure ? this.motive.leisure(c, d, sp.ticket, pull > 1) : 1); // Adventure goes further and loves an event, Money minds the ticket
      if (score > bestScore) { bestScore = score; best = b; }
    });
    return best;
  }
  /** An event at this place is about to start or has just started (an hour and a half before to half an hour after). */
  private eventNow(sp: LeisureSpec, b: Building) {
    if (!eventOn(sp, this.today)) return false;
    const dt = this.hour - eventStartAt(sp, b.x, b.y);
    return dt > -1.5 && dt < 0.5;
  }
  /** Visitors a venue can hold at once: a leisure place's own capacity, or a café/bar's per level. */
  private venueCap(b: Building) {
    const sp = leisureAt(b.id, b.level, b.x, b.y);
    return sp ? sp.capacity : venueCapacityOf(b.id, b.level);
  }
  /** Count an arrival: per place for the day (parks grow with use) and by type and hour for probes. */
  private noteVisit(key: string, type: string, stage: number) {
    (this.leisureStats[type] ??= new Array(24).fill(0))[Math.floor(this.hour) % 24]++;
    (this.leisureByStage[type] ??= [0, 0, 0])[stage]++;
    // per place for leisure places and cafés and bars alike: the issue bubbles' "no customers" reads them (sim/issues.ts)
    const v = this.venueVisits.get(key);
    if (!v) { this.venueVisits.set(key, { day: this.today, today: 1, yesterday: 0 }); return; }
    if (v.day !== this.today) { v.yesterday = v.day === this.today - 1 ? v.today : 0; v.today = 0; v.day = this.today; }
    v.today++;
  }
  private visitsAt(key: string): { today: number; yesterday: number } {
    const v = this.venueVisits.get(key);
    if (!v) return { today: 0, yesterday: 0 };
    if (v.day === this.today) return { today: v.today, yesterday: v.yesterday };
    return { today: 0, yesterday: v.day === this.today - 1 ? v.today : 0 };
  }
  /** Set off for a known venue (also used by friends and children joining someone). */
  private tripToVenue(c: Citizen, x: number, y: number, then: number): boolean {
    if (!this.plan(c, x, y)) return false;
    const key = tileKey(x, y);
    this.visitors.set(key, (this.visitors.get(key) ?? 0) + 1);
    c.venue = key; c.venueThen = then; c.errand = 0;
    c.state = S.ToVenue;
    return true;
  }

  /**
   * A grown-up takes child c to school (sim/schools.ts): a trip to the school door with no stay, then home or on to
   * work. The child rides along when they drive (sim/carpool.ts), else sets off beside them.
   */
  private escortTrip(a: Citizen, c: Citizen, then: number, onShift = false): boolean {
    if (!this.plan(a, c.sx, c.sy)) return false;
    if (then === S.ToWork && !onShift) a.nextAt = a.nextAt + this.lead(a) + a.shiftLen; // as depart: the shift ends on schedule
    a.venue = tileKey(c.sx, c.sy); a.venueThen = then; a.errand = ERRAND_SCHOOL; a.state = S.ToVenue;
    const start = this.carStart(a);
    if (start && this.takeLift(c, a, start, null, [c.sx, c.sy])) c.state = S.ToWork;
    else this.depart(c);
    return true;
  }
  /** A grown-up walks to the school gate to fetch child c, and back home (the child waits there, sim/schools.ts). */
  private fetchTrip(a: Citizen, c: Citizen): boolean {
    const car = a.car;
    a.car = false; // on foot: the child walks home beside them
    const ok = this.plan(a, c.sx, c.sy);
    a.car = car;
    if (!ok) return false;
    a.venue = tileKey(c.sx, c.sy); a.venueThen = S.ToHome; a.errand = ERRAND_SCHOOL; a.state = S.ToVenue;
    return true;
  }

  /** An evening class (sim/learning.ts): a trip to the college door, the class, then home. */
  private classTrip(c: Citizen, x: number, y: number): boolean {
    if (!this.plan(c, x, y)) return false;
    c.venue = tileKey(x, y); c.venueThen = S.ToHome; c.errand = ERRAND_CLASS; c.state = S.ToVenue;
    return true;
  }

  /** A funeral (sim/death.ts): a trip to the chapel or crematorium, the service, then home. */
  private funeralTrip(c: Citizen, x: number, y: number): boolean {
    if (!this.plan(c, x, y)) return false;
    c.venue = tileKey(x, y); c.venueThen = S.ToHome; c.errand = ERRAND_FUNERAL; c.state = S.ToVenue;
    return true;
  }

  private arriveVenue(c: Citizen) {
    const w = this.w;
    const b = c.venue ? w.buildings.get(c.venue) : undefined;
    if (!b) { this.leaveVenue(c); return; }
    if (c.errand === ERRAND_FUNERAL) { c.state = S.AtVenue; c.venueUntil = this.death.serviceEnd(c); return; } // until the service ends
    if (c.errand === ERRAND_SCHOOL) { c.state = S.AtVenue; c.venueUntil = w.tick; return; } // the school gate: a wave, and on
    if (c.errand === ERRAND_CLASS) { c.state = S.AtVenue; c.venueUntil = this.learning.classEnd(c); return; } // until the class ends
    if (c.errand) { // a doctor's visit: no bill, a short wait
      c.state = S.AtVenue;
      c.venueUntil = w.tick + HEALTH.doctorMinTicks + Math.round(Math.random() * (HEALTH.doctorMaxTicks - HEALTH.doctorMinTicks));
      return;
    }
    const spec = leisureAt(b.id, b.level, b.x, b.y);
    const event = !!spec && this.eventNow(spec, b);
    const spend = spec ? Math.round(spec.ticket * (event ? EVENT_TICKET : 1)) : 3 + b.level;
    // children are paid for by the parent they came out with (or whoever in the household can)
    const payer = c.stage === LifeStage.Child ? (this.householdPayer(c) ?? c) : c;
    if (spend > 0) { payer.money -= spend; noteSpend(payer, spend, w.tick); }
    noteLeisureVisit(c, spec ? spec.value : LEISURE.barValue);
    this.noteVisit(c.venue!, spec ? spec.type : 'bar', c.stage);
    this.meetGuests(c, c.venue!);
    const parcel = w.parcelAt(b.x, b.y);
    if (parcel && spend > 0) {
      const tax = spend * parcel.taxRate;
      w.credit(parcel.owner, tax);
      parcel.stats.taxToday += tax;
      w.dirtyParcels.add(parcel.id);
    }
    c.state = S.AtVenue; c.venueSince = w.tick;
    if (spec) {
      let stay = (spec.stayMin + Math.random() * (spec.stayMax - spec.stayMin)) * TPH;
      if (event) stay = Math.max(stay, Math.floor(w.tick / DAY) * DAY + (eventStartAt(spec, b.x, b.y) + spec.stayMax) * TPH - w.tick); // stay for the whole show
      c.venueUntil = w.tick + Math.round(stay);
    } else c.venueUntil = w.tick + (c.venueThen === S.ToWork ? Math.round(PRE_STOP_TICKS * 0.8) : Math.round(VENUE_MIN + Math.random() * (VENUE_MAX - VENUE_MIN)));
  }

  private leaveVenue(c: Citizen) {
    if (c.state === S.AtVenue && !c.errand && c.venueThen !== S.ToWork && this.waitForLift(c)) return; // going home with family or a friend
    if (c.errand === 1 && c.state === S.AtVenue) this.seenDoctor(c);
    if (c.errand === ERRAND_CLASS && c.state === S.AtVenue) this.learning.attended(c);
    const key = c.venue;
    this.dropVenue(c);
    c.errand = 0;
    const toWork = c.venueThen === S.ToWork && c.job;
    const [dx, dy] = toWork ? [c.wx, c.wy] : [c.hx, c.hy];
    if (!this.plan(c, dx, dy)) { this.teleportHome(c); return; }
    c.state = toWork ? S.ToWork : S.ToHome;
    if (!toWork && key) this.shareFromVenue(c, key);
  }

  private dropVenue(c: Citizen) {
    if (!c.venue) return;
    const g = this.guests.get(c.venue);
    if (g) { g.delete(c.id); if (!g.size) this.guests.delete(c.venue); }
    if (c.errand) { c.venue = null; return; } // doctor's visits are not venue customers
    const n = (this.visitors.get(c.venue) ?? 1) - 1;
    if (n <= 0) this.visitors.delete(c.venue); else this.visitors.set(c.venue, n);
    c.venue = null;
  }

  /**
   * Free at home: now and then go out. Children only go out with a parent (bringCompany); retirees go out more and
   * from the morning; anyone unwell stays in. An evening outing may bring friends, and any outing a child at home.
   */
  private maybeOuting(c: Citizen) {
    const h = this.hour;
    if (c.stage === LifeStage.Child) { this.maybeChildOuting(c); return; }
    const retired = c.stage === LifeStage.Retired;
    if (h < (retired ? 9 : 11) || h > 23 || c.money < MIN_SPENDING_MONEY) return;
    // the leisure need: someone who has not been out for days goes out more readily
    if (Math.random() >= OUTING_RATE * (retired ? LIFE.retireeOutingMul : 1) * (LEISURE.outingLo + LEISURE.outingSpan * leisureNeed(c))) return;
    if ((c.cond & ACUTE) || c.health < HEALTH.staysHomeBelow) return;
    if (this.goToVenue(c, S.ToHome)) this.bringCompany(c, true);
  }
  /** Children old enough go out on their own by day, but only to a free park or library close to home. */
  private maybeChildOuting(c: Citizen) {
    const h = this.hour;
    if (h < 9.5 || h > 17.5) return;
    if (Math.random() >= OUTING_RATE * (LEISURE.outingLo + LEISURE.outingSpan * leisureNeed(c))) return;
    if ((c.cond & ACUTE) || c.health < HEALTH.staysHomeBelow || ageOf(c, this.w.tick) < CHILD_OUT_AGE) return;
    const b = this.pickLeisure(c, true);
    if (b) this.tripToVenue(c, b.x, b.y, S.ToHome);
  }

  // ---- lives: one step per citizen per game day, plus events ------------------------------------------

  /**
   * The daily life step: stage changes (growing up, retiring), health and illness, death, pension, family events
   * (babies, partners, moving out) and friendships at work, then happiness. Runs once per game day per citizen at a
   * time of day staggered by id, so it never lands on one tick. Family events only happen while the citizen is home.
   */
  private lifeStep(c: Citizen) {
    const w = this.w, tick = w.tick;
    const age = ageOf(c, tick);
    const stage = stageFor(c.id, age);
    if (stage !== c.stage) {
      if (c.stage === LifeStage.Child && stage === LifeStage.Adult) { c.car = w.ownsCar(c.id, 0); c.money = Math.max(c.money, 40); }
      if (stage === LifeStage.Retired && c.job) w.quitJob(c);
      c.stage = stage;
    }
    // links to people who have died or left town are dropped here, not when they go
    if (c.partner && !w.citizens.has(c.partner)) c.partner = 0;
    if (c.friends.length) { let j = 0; for (const id of c.friends) if (w.citizens.has(id)) c.friends[j++] = id; c.friends.length = j; }
    const hh = w.households.get(c.hh);
    if (c.stage === LifeStage.Child && !(hh && hh.ids.some((id) => (w.citizens.get(id)?.stage ?? LifeStage.Child) !== LifeStage.Child))) {
      this.lifeEvents.orphansLeft++; // no grown-up left at home: the child goes to live with relatives out of town
      w.removeCitizen(c);
      return;
    }
    const covered = this.hasHospital(c.hx, c.hy);
    this.lifeHealth(c, age, covered, hh);
    if (this.death.lifeRoll(c, age)) return; // old age, illness or an accident at work: the body, the funeral, the grief (sim/death.ts)
    if (c.stage === LifeStage.Retired) { c.money += LIFE.pension; noteIncome(c, LIFE.pension, tick); }
    if (c.stage !== LifeStage.Child && c.state === S.Home) this.lifeFamily(c, age, hh);
    if (c.state === S.Home) this.start.campStep(c); // a camp settler moves into a finished home nearby (sim/firstfive.ts)
    if (c.state === S.Home) this.motive.daily(c, this.motiveHost); // a better job or home, now and then (sim/motivation.ts)
    if (c.job && c.friends.length < LIFE.maxFriends && Math.random() < LIFE.workFriendPerDay) {
      const o = this.pickFrom(this.socialIndex().work.get(tkey(c.wx, c.wy)), c);
      if (o) this.befriend(c, o);
    }
    // the leisure need drains a little every day; parks near home give some of it back
    const lc = this.leisureCoverage(c.hx, c.hy);
    leisureDay(c, lc.parks);
    c.happy = happinessOf(happinessParts(c, { coverage: Math.floor(this.coverage(c.hx, c.hy) + 1e-6), tick, parks: lc.parks, kids: this.families.homeParts(c, this.schools), bend: this.motive.bend(c) }));
    c.trafficTicksLife = 0;
  }

  /** Daily health: drift toward what is normal for the age, wear from work and traffic, illness coming and going. */
  private lifeHealth(c: Citizen, age: number, covered: boolean, hh: { ids: number[] } | undefined) {
    const w = this.w;
    let h = c.health + (healthTarget(age, c.cond) + this.skills.healthBonus(c) - c.health) * HEALTH.pull;
    const fam = familyOf(c.kind); // wear and injuries follow the workplace family (c.kind is a kind id)
    if (c.job) h -= fam === Zone.Industrial ? HEALTH.wearIndustrial : fam === Zone.Yard ? HEALTH.wearYard : fam === Zone.Fire ? HEALTH.wearFire : 0;
    h -= Math.min(HEALTH.trafficCap, (c.trafficTicksLife / TPH) * HEALTH.trafficPerHour);
    if (covered) h += HEALTH.hospitalBoost;
    if (c.cond & Cond.Flu) h -= HEALTH.fluCost;
    if (c.cond & Cond.Injury) h -= HEALTH.injuryCost;
    if (c.cond & Cond.Chronic) h -= HEALTH.chronicCost;
    h += (Math.random() - 0.5) * 2;
    c.health = Math.max(0, Math.min(100, h));
    if (c.cond & ACUTE) {
      c.condDays -= covered ? HEALTH.hospitalRecovery : 1;
      if (c.condDays <= 0) { c.cond &= ~ACUTE; c.condDays = 0; c.care = 0; }
    } else if (c.care < 0 && Math.random() < 0.15) c.care = 0; // a chronic illness gets a check-up now and then
    const frail = (c.health < 50 ? 1.5 : 1) * (c.stage !== LifeStage.Adult ? 1.5 : 1);
    if (!(c.cond & Cond.Flu)) {
      let p = (HEALTH.fluBase + HEALTH.fluSeason * fluWave(w.tick / DAY)) * frail * (0.5 + hash2(c.id, 217));
      if (hh && hh.ids.some((id) => id !== c.id && ((w.citizens.get(id)?.cond ?? 0) & Cond.Flu))) p *= HEALTH.fluHousehold;
      if (Math.random() < p) this.fallIll(c, Cond.Flu, HEALTH.fluDaysMin + Math.random() * (HEALTH.fluDaysMax - HEALTH.fluDaysMin));
    }
    if (c.job && !(c.cond & Cond.Injury) && (fam === Zone.Industrial || fam === Zone.Yard) && this.worksOn(c, this.today)) {
      const p = (fam === Zone.Industrial ? HEALTH.injuryIndustrial : HEALTH.injuryYard) * (c.health < 50 ? 1.5 : 1);
      if (Math.random() < p) this.fallIll(c, Cond.Injury, HEALTH.injuryDaysMin + Math.random() * (HEALTH.injuryDaysMax - HEALTH.injuryDaysMin));
    }
    if (!(c.cond & Cond.Chronic) && age > HEALTH.chronicFrom && Math.random() < HEALTH.chronicPer5y * ((age - HEALTH.chronicFrom) / 5) * frail) c.cond |= Cond.Chronic;
    // see a doctor about anything acute, or a chronic illness that is getting worse
    if (c.care === 0 && ((c.cond & ACUTE) || ((c.cond & Cond.Chronic) && c.health < 55))) c.care = this.clinicTick();
  }
  private fallIll(c: Citizen, cond: number, days: number) {
    c.cond |= cond;
    c.condDays = Math.max(c.condDays, days);
    if (c.care < 0) c.care = 0; // a new illness is worth a new visit
  }
  /** Skip this shift? Most shifts with flu or an injury, and every shift when very ill. */
  private staysOffSick(c: Citizen) {
    if (c.health < HEALTH.staysHomeBelow) return true;
    return (c.cond & ACUTE) !== 0 && Math.random() < HEALTH.sickSkip;
  }
  /** A time in surgery hours (09:00-18:00) within the next day or so. */
  private clinicTick(): number {
    let t = this.w.tick + Math.round((0.5 + Math.random() * 6) * TPH);
    const h = mod(t, DAY) / TPH;
    if (h < 9 || h >= 18) t = (Math.floor(t / DAY) + (h >= 18 ? 1 : 0)) * DAY + Math.round((9 + Math.random() * 6) * TPH);
    return t;
  }
  /** Time for a planned doctor's visit: a trip to the nearest staffed hospital, a short wait, then home. */
  private maybeDoctor(c: Citizen): boolean {
    const w = this.w;
    if (c.health < HEALTH.staysHomeBelow) {
      // too ill to go anywhere: stays home and waits it out
      // TODO ambulance call-outs: dispatch an Ambulance (VehicleKind.Ambulance) from the nearest staffed hospital here
      c.care = this.clinicTick();
      return false;
    }
    const h = this.hour;
    if (h < 8.5 || h >= 18.5 || (c.job && c.nextAt - w.tick < 3 * TPH && c.nextAt > w.tick)) { c.care = this.clinicTick(); return false; }
    const hosp = this.nearestHospital(c.hx, c.hy);
    if (!hosp || !this.plan(c, hosp.x, hosp.y)) { c.care = -1; return false; }
    c.venue = tileKey(hosp.x, hosp.y); c.errand = 1; c.venueThen = S.ToHome; c.state = S.ToVenue;
    c.care = -1;
    this.lifeEvents.doctorVisits++;
    return true;
  }
  private seenDoctor(c: Citizen) {
    c.health = Math.min(100, c.health + HEALTH.doctorBoost);
    c.condDays *= 1 - HEALTH.doctorCure;
  }
  private hasHospital(x: number, y: number) {
    for (const s of this.services) if (s.zone === Zone.Hospital && Math.abs(s.x - x) <= SERVICE_RADIUS_OF[s.id] && Math.abs(s.y - y) <= SERVICE_RADIUS_OF[s.id]) return true;
    return false;
  }
  private nearestHospital(x: number, y: number): Building | null {
    let best: Building | null = null, bd = Infinity;
    for (const s of this.services) {
      if (s.zone !== Zone.Hospital) continue;
      const d = Math.abs(s.x - x) + Math.abs(s.y - y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /** Babies, partners and grown-up children moving out. Called from the life step while the citizen is home. */
  private lifeFamily(c: Citizen, age: number, hh: { ids: number[] } | undefined) {
    const w = this.w;
    const home = w.buildings.get(tileKey(c.hx, c.hy));
    if (!home || home.zone !== Zone.Residential) return; // students in halls (sim/learning.ts) have no family life there
    const spare = home.occupants < capacityOf(home.id, home.level);
    const hold = (b: Building) => { b.holdUntil = w.tick + LIFE.familyHoldDays * DAY; };
    if (c.partner) {
      const p = w.citizens.get(c.partner);
      if (!p) return;
      if (p.hh !== c.hh) { this.cohabit(c, p); return; } // living apart: move in together once a bed is free
      // one roll a day per couple living together, by the partner with the lower id
      if (c.partner < c.id || p.hx !== c.hx || p.hy !== c.hy) return;
      const pa = ageOf(p, w.tick);
      if (age < LIFE.birthMinAge || age > LIFE.birthMaxAge || pa < LIFE.birthMinAge || pa > LIFE.birthMaxAge) return;
      let kids = 0;
      for (const id of hh?.ids ?? []) if (w.citizens.get(id)?.stage === LifeStage.Child) kids++;
      if (kids >= LIFE.maxChildren) { c.babyWait = 0; return; }
      if (c.babyWait <= w.tick) {
        c.babyWait = 0;
        if (Math.random() >= LIFE.birthPerDay * (0.6 + 0.8 * hash2(c.hh, 91))) return;
        c.babyWait = w.tick + LIFE.babyWaitDays * DAY; // decided on a baby
      }
      if (spare) { this.spawnChild(home, c); c.babyWait = 0; } else hold(home); // no room yet: keep the next free bed for the baby
      return;
    }
    if ((hh?.ids.length ?? 1) === 1 && c.stage !== LifeStage.Child) {
      // living alone: now and then people leave town, more often when life here is not good
      // a graduate with no work to match their degree for a while is likelier to go (brain drain, sim/skills.ts)
      // and more readily where the owner charges tuition fees (sim/schools.ts drainMul, the E6 policy)
      const drain = this.skills.drainMul(c), fees = c.edu >= EduLevel.Degree ? this.schools.drainMul(c) : 1;
      const p = (LIFE.leaveBasePerDay + LIFE.leaveUnhappyPerDay * Math.max(0, (LIFE.leaveUnhappyBelow - c.happy) / LIFE.leaveUnhappyBelow))
        * ((home.holdUntil ?? 0) > w.tick ? LIFE.leaveCrowdedMul : 1) * drain * fees;
      if (Math.random() < p) { this.lifeEvents.leftTown++; if (drain > 1) this.skills.drained(c); else this.leaveTown(c); return; }
    }
    if (c.stage === LifeStage.Adult && Math.random() < LIFE.partnerPerDay) {
      const idx = this.socialIndex();
      const pool = c.job && Math.random() < 0.5 ? idx.work.get(tkey(c.wx, c.wy)) : idx.parcel.get(w.parcelIdAt(c.hx, c.hy));
      const o = this.pickFrom(pool, c);
      if (o && !o.partner && o.stage === LifeStage.Adult && o.hh !== c.hh && Math.abs(ageOf(o, w.tick) - age) <= LIFE.partnerAgeGap) { this.pair(c, o); return; }
    }
    if (c.par && age <= LIFE.moveOutMaxAge && hh && hh.ids.includes(c.par) && Math.random() < LIFE.moveOutPerDay) {
      const scored = this.motive.moveOutHome(c, this.motiveHost); // by what they care about (sim/motivation.ts); undefined when off
      const b = scored !== undefined ? scored : w.bestBuiltNear(c.hx, c.hy, [Zone.Residential], LIFE.moveOutRadius, 6,
        (b, d) => (b !== home && b.id !== CAMP_KIND && b.occupants < capacityOf(b.id, b.level) ? 6 * Math.random() - d : null), (b) => w.hasRoadAccess(b.x, b.y)); // not into the tents
      if (b) { this.moveHome(c, b, w.nextId++); this.lifeEvents.movedOut++; }
    }
  }
  /** Two singles become partners and, if one of them can, move in together. */
  private pair(a: Citizen, b: Citizen) {
    const w = this.w;
    a.partner = b.id; b.partner = a.id;
    a.friends = a.friends.filter((id) => id !== b.id); b.friends = b.friends.filter((id) => id !== a.id);
    this.lifeEvents.partners++;
    this.cohabit(a, b);
  }
  /**
   * Partners living apart move in together: whoever has no children of their own at home moves (the smaller
   * household first) into the other's home if it has a free bed. If neither can, the home the smaller household
   * would move to holds its next free bed from newcomers for a while, and they try again on a later day.
   */
  private cohabit(a: Citizen, b: Citizen) {
    const w = this.w;
    const movable = (m: Citizen) => (m.state === S.Home || m.state === S.Work) && !(w.households.get(m.hh)?.ids ?? []).some((id) => w.citizens.get(id)?.par === m.id);
    const sizeOf = (m: Citizen) => w.households.get(m.hh)?.ids.length ?? 1;
    for (const [mover, stay] of sizeOf(a) <= sizeOf(b) ? [[a, b], [b, a]] : [[b, a], [a, b]]) {
      const home = w.buildings.get(tileKey(stay.hx, stay.hy));
      if (!home || home.zone !== Zone.Residential || !movable(mover) || home.occupants >= capacityOf(home.id, home.level)) continue;
      this.moveHome(mover, home, stay.hh);
      this.lifeEvents.movedIn++;
      return;
    }
    // no bed free on either side: they live apart for now, and the first choice of home keeps its next free bed
    const [first, other] = sizeOf(a) <= sizeOf(b) ? [a, b] : [b, a];
    const target = w.buildings.get(tileKey(other.hx, other.hy));
    if (target && target.zone === Zone.Residential && movable(first)) target.holdUntil = w.tick + LIFE.familyHoldDays * DAY;
  }
  /** Move a citizen's home to b and into household hh (they must be at home or at work). */
  private moveHome(c: Citizen, b: Building, hh: number) {
    const w = this.w;
    const old = w.buildings.get(tileKey(c.hx, c.hy));
    if (old) w.bedIn(old, -1); // a home, or a hall of residence (sim/learning.ts)
    w.bedIn(b, 1);
    c.hx = b.x; c.hy = b.y; c.commute = null;
    if (c.state === S.Home) { c.x = b.x + 0.5; c.y = b.y + 0.5; }
    w.setHousehold(c, hh);
  }
  private spawnChild(home: Building, parent: Citizen) {
    const w = this.w;
    const id = w.nextId++;
    const c = this.makeCitizen(id, home, 0, 85 + 12 * hash2(id, 212));
    c.money = 0; c.car = false; c.stage = LifeStage.Child;
    c.hh = parent.hh; c.sn = w.households.get(parent.hh)?.sn ?? parent.sn; c.par = parent.id;
    c.vals = inheritValues(id, [parent, w.citizens.get(parent.partner)]); // children take after their parents (sim/motivation.ts)
    w.addCitizen(c);
    home.occupants++;
    this.lifeEvents.births++;
  }
  /** Rebuilt on first use each game day: workplace -> staff ids, home parcel -> resident ids. */
  private socialIndex() {
    const s = this.social;
    if (s.day === this.today) return s;
    s.day = this.today; s.work.clear(); s.parcel.clear();
    const push = (m: Map<number, number[]>, k: number, id: number) => { const a = m.get(k); if (a) a.push(id); else m.set(k, [id]); };
    const parcelOfHome = new Map<number, number>(); // homes hold many people: look each home's parcel up once
    for (const c of this.w.citizens.values()) {
      if (c.job) push(s.work, tkey(c.wx, c.wy), c.id);
      const hk = tkey(c.hx, c.hy);
      let pid = parcelOfHome.get(hk);
      if (pid === undefined) { pid = this.w.parcelIdAt(c.hx, c.hy); parcelOfHome.set(hk, pid); }
      push(s.parcel, pid, c.id);
    }
    return s;
  }
  private pickFrom(ids: number[] | undefined, not: Citizen): Citizen | null {
    if (!ids || ids.length < 2) return null;
    for (let i = 0; i < 3; i++) {
      const o = this.w.citizens.get(ids[Math.floor(Math.random() * ids.length)]);
      if (o && o !== not) return o;
    }
    return null;
  }
  private befriend(a: Citizen, b: Citizen) {
    if (a === b || a.hh === b.hh || a.partner === b.id) return;
    if (a.friends.length >= LIFE.maxFriends || b.friends.length >= LIFE.maxFriends || a.friends.includes(b.id)) return;
    a.friends.push(b.id); b.friends.push(a.id);
    this.lifeEvents.friendships++;
  }
  /** Arriving at a venue: a small chance of making friends with each guest already there. */
  private meetGuests(c: Citizen, key: string) {
    let g = this.guests.get(key);
    if (!g) { g = new Set(); this.guests.set(key, g); }
    const p = this.hour >= 17 ? LIFE.venueFriendEvening : LIFE.venueFriendDay;
    let n = 0;
    for (const id of g) {
      if (n++ >= 8) break;
      if (Math.random() >= p) continue;
      const o = this.w.citizens.get(id);
      if (o && (o.stage === LifeStage.Child) === (c.stage === LifeStage.Child)) this.befriend(c, o);
    }
    g.add(c.id);
  }
  /**
   * Someone just set off for a venue: a child at home may come along with a parent leaving home, and in the
   * evening an idle friend living nearby may join (at most two). They set off now, so they walk at about the same time.
   */
  private bringCompany(c: Citizen, fromHome: boolean) {
    const w = this.w;
    const key = c.venue;
    if (!key || c.stage === LifeStage.Child) return;
    const venue = w.buildings.get(key);
    if (!venue) return;
    const [vx, vy] = parseKey(key);
    const cap = this.venueCap(venue);
    const room = () => (this.visitors.get(key) ?? 0) < cap;
    // children are keener on some places (parks, the cinema) than others (the theatre)
    const childJoins = Math.min(0.9, LIFE.childJoins * (leisureAt(venue.id, venue.level, venue.x, venue.y)?.child ?? 1));
    if (fromHome) {
      for (const id of w.households.get(c.hh)?.ids ?? []) {
        const k = w.citizens.get(id);
        if (!k || k.stage !== LifeStage.Child || k.state !== S.Home || (k.cond & ACUTE) || k.hx !== c.hx || k.hy !== c.hy) continue;
        if (room() && Math.random() < childJoins && !this.rideToVenue(k, c, vx, vy)) this.tripToVenue(k, vx, vy, S.ToHome);
      }
    }
    if (this.hour < 17 || !c.friends.length) return;
    let joined = 0;
    for (const id of c.friends) {
      if (joined >= 2) break;
      const f = w.citizens.get(id);
      if (!f || f.state !== S.Home || f.stage === LifeStage.Child || f.money < MIN_SPENDING_MONEY || (f.cond & ACUTE) || f.health < HEALTH.staysHomeBelow) continue;
      if (f.job && f.nextAt - w.tick < 4 * TPH) continue;
      if (Math.abs(f.hx - vx) + Math.abs(f.hy - vy) > LIFE.friendJoinRadius) continue;
      if (!room() || Math.random() >= LIFE.friendJoins) continue;
      if (this.tripToVenue(f, vx, vy, S.ToHome)) joined++;
    }
  }
  /** Who pays when a child is out: the parent if they share the household, else any grown-up there. */
  private householdPayer(c: Citizen): Citizen | null {
    const w = this.w;
    const par = w.citizens.get(c.par);
    if (par && par.hh === c.hh) return par;
    for (const id of w.households.get(c.hh)?.ids ?? []) { const m = w.citizens.get(id); if (m && m.stage !== LifeStage.Child) return m; }
    return null;
  }
  /** Door-to-door time of the trip that just reached work, smoothed. */
  private noteCommute(c: Citizen) {
    const t = this.w.tick - c.tripStart;
    c.commuteTicks = c.commuteTicks > 0 ? c.commuteTicks * 0.7 + t * 0.3 : t;
  }

  // ---- car sharing (sim/carpool.ts) ---------------------------------------------------------

  /** Where the car of d's current trip sets off from (the start of its first drive leg), or null when d is not driving. */
  private carStart(d: Citizen): [number, number] | null {
    const trip = this.pool.tripOf(d);
    if (!trip) return null;
    for (const l of [d.leg, ...d.legs]) if (l && l.drive && l.pool === trip) return [l.path[0], l.path[1]];
    return null;
  }
  /**
   * Would p go home with d today? The same household and home: the household's habit (children always go with family);
   * colleagues living near, or friends: the pair's. Rolled once a day so whoever waits and whoever drives agree.
   */
  private sharesWith(d: Citizen, p: Citizen, place: 'work' | 'venue'): boolean {
    if (d.hh === p.hh && d.hx === p.hx && d.hy === p.hy) return p.stage === LifeStage.Child || hash2(d.hh * 7 + 815, this.today) < householdShare(d.hh);
    const pair = Math.min(d.id, p.id) * 31 + Math.max(d.id, p.id);
    if (place === 'work') return Math.abs(d.hx - p.hx) + Math.abs(d.hy - p.hy) <= CARPOOL.neighbourR && hash2(pair + 816, this.today) < coworkerShare(d.id, p.id);
    return d.friends.includes(p.id) && hash2(pair + 817, this.today) < friendShare(d.id, p.id);
  }
  /**
   * At the end of a shift or a night out with no car of one's own here: wait (once) for someone in the household,
   * a colleague living near or a friend who has a car here and leaves within CARPOOL.waitBack, and go home with them.
   */
  private waitForLift(c: Citizen): boolean {
    if (!CARPOOL.on || c.parkedAt !== null || this.pool.waited.has(c.id)) return false;
    const w = this.w, now = w.tick, atWork = c.state === S.Work;
    const leaves = (d: Citizen) => {
      if (d === c || d.parkedAt === null) return 0;
      if (atWork) return d.state === S.Work && d.wx === c.wx && d.wy === c.wy ? d.nextAt : 0;
      return d.state === S.AtVenue && d.venue === c.venue && !d.errand && d.venueThen === S.ToHome ? d.venueUntil : 0;
    };
    let best = 0;
    const consider = (d: Citizen | undefined) => {
      if (!d) return;
      const t = leaves(d);
      if (t > now && t - now <= CARPOOL.waitBack && (!best || t < best) && this.sharesWith(d, c, atWork ? 'work' : 'venue')) best = t;
    };
    for (const id of w.households.get(c.hh)?.ids ?? []) consider(w.citizens.get(id));
    if (atWork) { for (const id of this.socialIndex().work.get(tkey(c.wx, c.wy)) ?? []) consider(w.citizens.get(id)); }
    else for (const id of c.friends) consider(w.citizens.get(id));
    if (!best) return false;
    this.pool.waited.add(c.id);
    if (atWork) c.nextAt = best + 1; else c.venueUntil = best + 1; // the driver leaves first and takes them
    return true;
  }
  /** d just set off for work in the car from home: household members and colleagues next door due out about now may come. */
  private shareToWork(d: Citizen) {
    if (!CARPOOL.on) return;
    const start = this.carStart(d);
    if (!start || start[0] !== d.hx || start[1] !== d.hy) return;
    const w = this.w, now = w.tick;
    // pupils too: the school run (sim/schools.ts), dropped off at the school door
    const due = (p: Citizen) => p !== d && p.state === S.Home && (p.job || p.study > 0) && p.nextAt >= now && p.nextAt - now <= (p.study && !p.job ? this.schools.liftWindow(p) : CARPOOL.window) && !p.preStop
      && !(p.cond & ACUTE) && p.health >= HEALTH.staysHomeBelow && !this.death.offToday(p); // a mourner's funeral day off holds for a lift too (sim/death.ts)
    const cands: Candidate[] = [];
    const share = householdShare(d.hh);
    for (const id of w.households.get(d.hh)?.ids ?? []) {
      const p = w.citizens.get(id);
      if (p && p.hx === d.hx && p.hy === d.hy && due(p) && ((p.study && !p.job) || Math.random() < share)) cands.push({ p, dest: [p.wx, p.wy] });
    }
    // neighbours (same parcel, a few tiles away) working at or near the same place
    const social = this.socialIndex();
    for (const id of social.parcel.get(w.parcelIdAt(d.hx, d.hy)) ?? []) {
      const p = w.citizens.get(id);
      if (!p || !p.job || p.hh === d.hh || Math.abs(p.hx - d.hx) + Math.abs(p.hy - d.hy) > CARPOOL.neighbourR || !due(p)) continue;
      if (Math.abs(p.wx - d.wx) + Math.abs(p.wy - d.wy) > CARPOOL.sameDest) continue;
      if (Math.random() < coworkerShare(d.id, p.id)) cands.push({ p, dest: [p.wx, p.wy], on: [p.hx, p.hy] });
    }
    this.shareRide(d, start, [d.wx, d.wy], cands, (p) => {
      if (p.study && !p.job) this.schools.liftIn(p); // the school day ends with the bell
      else p.nextAt = p.nextAt + this.lead(p) + p.shiftLen; // as depart: the shift ends on schedule
      p.state = S.ToWork;
    });
  }
  /** d just set off home from work by car: those waiting for a lift and colleagues finishing about now who share with d. */
  private shareFromWork(d: Citizen) {
    if (!CARPOOL.on) return;
    const start = this.carStart(d);
    if (!start) return;
    const w = this.w, now = w.tick;
    const cands: Candidate[] = [];
    for (const id of this.socialIndex().work.get(tkey(d.wx, d.wy)) ?? []) {
      const p = w.citizens.get(id);
      if (!p || p === d || p.state !== S.Work || p.wx !== d.wx || p.wy !== d.wy || p.parkedAt !== null || p.nextAt - now > CARPOOL.early) continue;
      if (this.sharesWith(d, p, 'work')) cands.push({ p, dest: [p.hx, p.hy] });
    }
    this.shareRide(d, start, [d.hx, d.hy], cands, (p) => {
      this.shiftDone(p);
      this.w.leaveSite(p);
      if (this.w.citizens.has(p.id)) { p.state = S.ToHome; if (p.study) this.schools.homeward(p); }
    });
  }
  /** d just set off home by car from a venue: family and friends there without a car who share with d come too. */
  private shareFromVenue(d: Citizen, key: string) {
    if (!CARPOOL.on) return;
    const start = this.carStart(d);
    const g = this.guests.get(key);
    if (!start || !g) return;
    const cands: Candidate[] = [];
    for (const id of g) {
      const p = this.w.citizens.get(id);
      if (!p || p === d || p.state !== S.AtVenue || p.venue !== key || p.errand || p.venueThen !== S.ToHome || p.parkedAt !== null) continue;
      if (this.sharesWith(d, p, 'venue')) cands.push({ p, dest: [p.hx, p.hy] });
    }
    this.shareRide(d, start, [d.hx, d.hy], cands, (p) => { this.dropVenue(p); p.errand = 0; p.state = S.ToHome; });
  }
  /** A child coming along on an outing rides in the car when the grown-up drives. */
  private rideToVenue(p: Citizen, d: Citizen, x: number, y: number): boolean {
    if (!CARPOOL.on || this.pool.booked(d) >= CARPOOL.seats) return false;
    const start = this.carStart(d);
    if (!start || !this.takeLift(p, d, start, null, [x, y])) return false;
    const key = tileKey(x, y);
    this.visitors.set(key, (this.visitors.get(key) ?? 0) + 1);
    p.venue = key; p.venueThen = S.ToHome; p.errand = 0;
    p.state = S.ToVenue;
    return true;
  }
  /** Choose riders for d's drive from `start` to `dest`, add any stops to the drive, and take them; `go` starts each one's trip. */
  private shareRide(d: Citizen, start: [number, number], dest: [number, number], cands: Candidate[], go: (p: Citizen) => void) {
    if (!cands.length) return;
    const room = CARPOOL.seats - this.pool.booked(d);
    let plan = this.pool.choose(start, dest, cands.slice(0, Math.max(0, room) + 2));
    if (plan.via.length && !this.addStops(d, plan.via)) plan = { via: [], riders: plan.riders.filter((r) => !r.on && !r.off) };
    for (const r of plan.riders.slice(0, room)) if (this.takeLift(r.p, d, r.on ?? start, r.off, r.dest)) go(r.p);
  }
  /** Split d's drive into legs through `via` (pick-ups and drop-offs on the way); false, leaving it as it was, when a leg has no route. */
  private addStops(d: Citizen, via: [number, number][]): boolean {
    const trip = this.pool.tripOf(d);
    const cur = d.leg?.drive && d.leg.pool === trip ? d.leg : null;
    const leg = cur ?? d.legs.find((l) => l.drive && l.pool === trip);
    if (!leg || !leg.dest || (cur && d.lane >= 0 && (d.pi > 1 || d.prog > 0))) return false;
    const pts: [number, number][] = [[leg.path[0], leg.path[1]], ...via, leg.dest];
    const legs: Leg[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const r = findRoute(this.w, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], (x, y) => this.traffic.cost(x, y));
      if (!r || r.path.length < 4) return false;
      const last = i + 2 === pts.length;
      legs.push({ path: r.path, drive: true, arrive: last ? leg.arrive : 'stop', dest: last ? leg.dest : pts[i + 1], pool: trip });
    }
    if (cur) { this.traffic.leave(d); d.legs = [...legs, ...d.legs]; this.startLeg(d); }
    else d.legs.splice(d.legs.indexOf(leg), 1, ...legs);
    return true;
  }
  /** Book p into d's car on its trip, walking to where it sets off from first if need be. False when p cannot get there. */
  private takeLift(p: Citizen, d: Citizen, on: [number, number], off: [number, number] | null, dest: [number, number]): boolean {
    const w = this.w;
    const trip = this.pool.tripOf(d);
    if (!trip) return false;
    const px = Math.floor(p.x), py = Math.floor(p.y);
    let walk: number[] | null = null;
    if (px !== on[0] || py !== on[1]) { walk = pathBetween(w, px, py, on[0], on[1]); if (!walk) return false; }
    this.traffic.leave(p); this.transit.drop(p); this.taxis.drop(p); this.pool.forget(p);
    p.legs = []; p.leg = null; p.pts = null;
    resetTrail(p, px, py);
    today(p, Math.floor(w.tick / DAY)); p.tripsToday++; p.tripStart = w.tick;
    if (walk) p.legs.push({ path: walk, drive: false, arrive: 'none' });
    // the drive from where they get in to where they get out, for the route ribbon
    const shown: number[] = [];
    let aboard = false;
    for (const l of [d.leg, ...d.legs]) {
      if (!l || !l.drive || l.pool !== trip) continue;
      if (!aboard && l.path[0] === on[0] && l.path[1] === on[1]) aboard = true;
      if (!aboard) continue;
      for (let i = shown.length ? 2 : 0; i < l.path.length; i++) shown.push(l.path[i]);
      if (off && l.dest && l.dest[0] === off[0] && l.dest[1] === off[1]) break;
    }
    p.legs.push({ path: shown.length >= 2 ? shown : [on[0], on[1]], drive: false, arrive: 'none', lift: { driver: d.id, dest } });
    this.startLeg(p);
    this.pool.add(d, trip, p, on, off, dest);
    return true;
  }
  /** A lift fell through (the driver re-planned, gave up or went without them): make their own way from here. */
  private liftFellThrough(c: Citizen, dest: [number, number]) {
    if (!this.plan(c, dest[0], dest[1])) this.teleportHome(c);
  }

  // ---- builders ---------------------------------------------------------------------

  private seekSite(c: Citizen): boolean {
    const w = this.w;
    const fx = Math.floor(c.x), fy = Math.floor(c.y);
    // the camp stage (shared campStage, docs/ranks.md section 3): a handyman's two crews take homes and shops before a civic
    // site on the same land, unless the goals card is asking for that very building; a yard is never made to wait
    const camp = c.kind === KIND_ID.handyman ? this.campOwners() : null;
    const waits = (s: { x: number; y: number; kind: number }) => {
      const ask = camp!.get(w.parcelAt(s.x, s.y)?.owner ?? '');
      if (ask === undefined) return false;
      const f = familyOf(s.kind);
      if (f === Zone.Residential || f === Zone.Commercial || f === Zone.Yard) return false;
      return !((ask === 'leisure' && isLeisure(s.kind)) || (ask === 'cover' && (f === Zone.Police || f === Zone.Fire)));
    };
    const siteScore = (s: { x: number; y: number; kind: number; priority: number; assigned: number }) =>
      s.priority <= -2 || s.assigned >= MAX_BUILDERS_PER_SITE ? null
        : s.priority * PRIORITY_WEIGHT - s.assigned * 3 - (camp?.size && waits(s) ? CAMP_WAIT : 0); // spread crews across equal-priority sites
    // bounds for the search to stop early: the best score of any open site, and the best (score - distance)
    // any of them could reach, as road distance is never shorter than Manhattan distance
    let maxScore = -Infinity, maxTotal = -Infinity;
    for (const s of w.sites.values()) {
      const sc = siteScore(s);
      if (sc === null) continue;
      if (sc > maxScore) maxScore = sc;
      const t = sc - Math.max(1, Math.abs(s.x - fx) + Math.abs(s.y - fy));
      if (t > maxTotal) maxTotal = t;
    }
    if (maxScore === -Infinity) return false; // nothing to build anywhere
    const r = findBest(w, fx, fy, (x, y) => {
      const s = w.sites.get(tileKey(x, y));
      return s ? siteScore(s) : null;
    }, 2500, maxScore, maxTotal);
    if (!r) return false;
    if (!this.plan(c, r.gx, r.gy)) return false;
    const key = tileKey(r.gx, r.gy);
    w.sites.get(key)!.assigned++;
    c.site = key;
    c.state = S.ToSite;
    return true;
  }

  /** The owners still in the camp stage (shared campStage), each with the goal their card is on, read once a tick. */
  private campAt = -1;
  private campMap = new Map<string, GoalId | null>();
  private campOwners(): ReadonlyMap<string, GoalId | null> {
    const w = this.w;
    if (this.campAt === w.tick) return this.campMap;
    this.campAt = w.tick;
    this.campMap.clear();
    for (const p of w.players.values()) if (p.onboarding && campStage(p.onboarding.done, p.onboarding.skipped)) this.campMap.set(p.id, chainActive(p.onboarding.done));
    return this.campMap;
  }

  private workSite(c: Citizen) {
    const w = this.w;
    const s = c.site ? w.sites.get(c.site) : undefined;
    if (!s) { c.site = null; this.nextSiteOrYard(c); return; }
    if (s.priority <= -2) { w.leaveSite(c); this.nextSiteOrYard(c); return; } // paused: down tools
    const rate = BUILD_RATE * WORK_RATE_OF[c.kind]; // the crew's pace comes from their workplace's tier (a construction company works faster)
    s.work -= rate;
    const q = Math.min(3, Math.floor((4 * (s.total - s.work)) / s.total));
    const t = w.getTile(s.x, s.y);
    if (progressOf(t) !== q) w.setTile(s.x, s.y, withProgress(t, q)); // clients show the building rising
    const yardOwner = w.parcelAt(c.wx, c.wy)?.owner, siteOwner = w.parcelAt(s.x, s.y)?.owner;
    w.transfer(siteOwner, yardOwner, FEE_PER_UNIT * rate, 'builders');
    w.bump(yardOwner, 'built', rate);
    if (siteOwner !== yardOwner) w.bump(siteOwner, 'built', rate); // work on your land counts for your construction tech, whoever's builders do it
    if (s.work <= 0) {
      w.completeSite(s); // other builders assigned here notice next tick
      c.site = null;
      this.nextSiteOrYard(c);
    }
  }

  private nextSiteOrYard(c: Citizen) {
    if (this.seekSite(c)) return;
    if (!this.plan(c, c.wx, c.wy)) { this.goHome(c); return; }
    c.state = S.ToWork;
  }

  // ---- trips: walk or drive, in legs ----------------------------------------------

  /**
   * Plan a trip from where the citizen is to (dx, dy) and start its first leg.
   * Car owners drive anything beyond a short walk when the car is to hand, and
   * always go back for a car they left somewhere. Drivers park on arrival (see
   * arriveLeg). False when there is no way there at all.
   */
  private plan(c: Citizen, dx: number, dy: number): boolean {
    const w = this.w;
    const hx = Math.floor(c.x), hy = Math.floor(c.y);
    this.traffic.leave(c);
    this.transit.drop(c); this.taxis.drop(c);
    this.pool.forget(c);
    c.legs = []; c.leg = null; c.pts = null;
    resetTrail(c, hx, hy);
    today(c, Math.floor(w.tick / DAY)); c.tripsToday++; c.tripStart = w.tick;
    if (hx === dx && hy === dy) { c.path = [dx, dy]; c.pi = 1; return true; }
    const goingHome = dx === c.hx && dy === c.hy;
    const carPos: [number, number] = c.parkedAt ? parseKey(c.parkedAt) : [c.hx, c.hy];
    const carHere = carPos[0] === hx && carPos[1] === hy;
    const carDist = Math.abs(carPos[0] - hx) + Math.abs(carPos[1] - hy);
    const far = Math.abs(dx - hx) + Math.abs(dy - hy) >= DRIVE_MIN_TILES;
    let useCar = c.car && (goingHome ? c.parkedAt !== null : carDist <= CAR_FETCH_RADIUS && far);
    const legs: Leg[] = [];
    let carTicks = Infinity;
    if (useCar) {
      let fetch = 0;
      const pool = this.pool.token(); // every drive can take passengers (sim/carpool.ts)
      if (!carHere) {
        const wp = pathBetween(w, hx, hy, carPos[0], carPos[1]);
        if (wp) { legs.push({ path: wp, drive: false, arrive: 'pickup', pool }); fetch = wp.length / 2; } else useCar = false;
      }
      if (useCar) {
        const route = findRoute(w, carPos[0], carPos[1], dx, dy, (x, y) => this.traffic.cost(x, y));
        if (route && route.path.length >= 4) {
          legs.push({ path: route.path, drive: true, arrive: goingHome ? 'parkHome' : 'park', dest: [dx, dy], pool });
          if (carHere) this.releaseParking(c); // the car was parked right here: free its slot as we pull out
          // what the drive is expected to take: the route at a typical town speed, the walk to the car, parking
          carTicks = route.cost / (DRIVE_SPEED * c.speedMul * 0.6) + walkCost((fetch + 2) / WALK_SPEED) + PARKING_FEE * 0.5 * TRANSIT.ticksPerDollar;
        } else { useCar = false; legs.length = 0; }
      }
    }
    // public transport, when the car is at home (or there is none): a stop near each end on one line (one change
    // allowed), weighed against walking and driving with a hash-seeded personal taste for each (docs/transit.md)
    if (this.transit.any && c.parkedAt === null && Math.abs(dx - hx) + Math.abs(dy - hy) >= TRANSIT.minTrip) {
      const tl = this.transitChoice(c, hx, hy, dx, dy, useCar ? carTicks : Infinity);
      if (tl) { c.legs = tl; this.modeLog.transit++; this.startLeg(c); return true; }
    }
    // a taxi or private hire (sim/taxis.ts) when the car is at home or there is none: booked now if it beats walking and driving
    if (c.parkedAt === null && Math.abs(dx - hx) + Math.abs(dy - hy) >= TAXI.minTrip) {
      const h = this.hour, evening = h >= 19 || h < 4;
      const db = goingHome ? undefined : this.w.buildings.get(tileKey(dx, dy));
      const nightOut = evening && (goingHome ? c.state === S.AtVenue : !!db && (db.zone === Zone.Commercial || isLeisure(db.id)));
      const tl = this.taxis.choose(c, hx, hy, dx, dy, useCar ? carTicks : Infinity, nightOut);
      if (tl) { c.legs = tl; this.modeLog.taxi++; this.startLeg(c); return true; }
    }
    if (useCar) this.modeLog.drive++; else this.modeLog.walk++;
    if (!useCar) {
      const wp = pathBetween(w, hx, hy, dx, dy);
      if (!wp) return false;
      legs.push({ path: wp, drive: false, arrive: 'none' });
    }
    c.legs = legs;
    this.startLeg(c);
    return true;
  }

  /**
   * Mode choice for a trip the planner can make by transit (docs/transit.md): perceived ticks by transit (walks and
   * the wait weighted, the rides as they are) times a personal taste, plus the fare in ticks, against the walk (weighted
   * the same way) and the drive (carTicks, also times a personal taste; Infinity without a car). The legs, or null
   * to walk or drive as before.
   */
  private transitChoice(c: Citizen, hx: number, hy: number, dx: number, dy: number, carTicks: number): Leg[] | null {
    const fare = this.transit.fareFor(c);
    if (c.money < fare) return null;
    const p = this.transit.bestTransit(hx, hy, dx, dy);
    if (!p || c.money < p.fare * fare) return null;
    const dist = Math.abs(dx - hx) + Math.abs(dy - hy);
    const walkSpeed = c.stage === LifeStage.Retired ? WALK_SPEED * LIFE.retireeWalk : WALK_SPEED;
    const taste = TRANSIT.tasteMin + TRANSIT.tasteSpan * hash2(c.id, 77);    // how much this person minds the bus
    const carTaste = 0.85 + 0.6 * hash2(c.id, 78);                          // and how much they mind driving and parking
    const byTransit = p.perceived * taste * (walkSpeed < WALK_SPEED ? 0.9 : 1) + p.fare * fare * TRANSIT.ticksPerDollar;
    const byFoot = walkCost((dist * 1.2) / walkSpeed);
    if (byTransit >= byFoot || byTransit >= carTicks * carTaste) return null;
    return this.transit.legsFor(p, hx, hy, dx, dy);
  }

  private startLeg(m: Citizen | Vehicle): boolean {
    const leg = m.legs.shift() ?? null;
    m.leg = leg;
    if (!leg) return false;
    m.path = leg.path; m.pi = 0; m.wait = 0; m.stuck = 0; m.pts = null;
    if (leg.ride && 'hx' in m) { this.traffic.leave(m); this.transit.startRide(m, leg); return true; } // to the stop's crowd
    if (leg.lift) { this.traffic.leave(m); return true; } // waiting for the car, or in it (sim/carpool.ts)
    if (leg.hail && 'hx' in m) { this.traffic.leave(m); this.taxis.startWait(m); return true; } // waiting for a taxi, or in it (sim/taxis.ts)
    if (leg.drive) {
      m.cls = this.classOf(m);
      this.startTrack(m, leg);
      if (!this.traffic.canDrive(m.path)) leg.drive = false;
      else {
        this.traffic.leave(m); m.x = m.path[0] + 0.5; m.y = m.path[1] + 0.5;
        // 'blocked' keeps the car in the garage, and so does waiting for a passenger to get in; advance retries
        if (!(leg.pool && 'hx' in m && this.pool.hold(m))) this.traffic.enter(m);
      }
    }
    if (!leg.drive) { this.traffic.leave(m); this.startWalking(m); }
    return true;
  }
  /** Lay out the sidewalk route for the current leg and set off along it. */
  private startWalking(m: Citizen | Vehicle) {
    const pl = this.traffic.walkPolyline(m.path);
    m.pts = pl.pts; m.cross = pl.cross; m.node = pl.node; m.xdir = pl.xdir; m.pp = 1; m.pi = 0;
    m.x = pl.pts[0]; m.y = pl.pts[1];
  }
  private classOf(m: Citizen | Vehicle): number {
    if ('vkind' in m) return m.vkind === VehicleKind.Freight || m.vkind === VehicleKind.FireEngine ? VehicleClass.Truck : m.vkind === VehicleKind.Visitor ? VehicleClass.Sedan : VehicleClass.Van;
    const fam = familyOf(m.kind); // the workplace family (c.kind is a kind id)
    return fam === Zone.Yard ? VehicleClass.Truck : (fam === Zone.Police || fam === Zone.Fire || fam === Zone.Hospital) ? VehicleClass.Van : VehicleClass.Sedan;
  }

  /** Move a citizen along the current leg; true once the whole trip is complete. */
  private advance(c: Citizen): boolean {
    if (!c.leg) return true;
    const leg = c.leg;
    if (leg.lift) {
      const r = this.pool.ride(c);
      if (r === 'wait' || r === 'ride') return false;
      if (r === 'void') { this.liftFellThrough(c, leg.lift.dest); return false; }
      // 'off': out of the car, the walk from here (if any) is queued
    } else if (leg.ride) {
      if (!this.transit.rideDone(c)) return false; // waiting at the stop or on board
    } else if (leg.hail) {
      if (!this.taxis.hailDone(c)) return false; // waiting at the kerb or in the taxi (sim/taxis.ts)
    } else if (leg.drive) {
      if (c.lane < 0) { // still in the garage: pull out as soon as the lane start is clear (and everyone is in)
        if (leg.pool && this.pool.hold(c)) return false;
        if (this.traffic.enter(c) === 'blocked') { if (++c.wait > GARAGE_WAIT_MAX) { this.traffic.count('garageGiveUp'); this.abortTrip(c, false); } return false; }
        return false;
      }
      const r = this.traffic.step(c);
      if (c.wait > 1) { if (c.statsDay !== this.today) today(c, this.today); c.trafficTicksToday++; c.trafficTicksLife++; }
      if (r === 'moving') { if (this.classEpoch) this.recheckClasses(c, leg); this.maybeReroute(c, leg, this.dueForcedReroute(c)); return false; }
      if (r === 'stuck') { this.onStuck(c, leg); return false; }
    } else if (!this.walk(c)) {
      if (!this.repath(c)) { this.abortTrip(c); return false; }
      return false;
    } else if (c.pts && c.pp * 2 < c.pts.length) return false;
    // leg finished
    this.arriveLeg(c, leg);
    if (!this.w.citizens.has(c.id)) return false;
    if (c.leg === leg || c.leg === null) { if (!this.startLeg(c)) { c.leg = null; return true; } }
    return false;
  }

  /** What happens at the end of a leg: parking, picking the car up, or nothing. */
  private arriveLeg(m: Citizen | Vehicle, leg: Leg) {
    const w = this.w;
    if (leg.drive && this.legSamples) this.sampleLeg(m, leg);
    switch (leg.arrive) {
      case 'pickup': {
        this.releaseParking(m);
        return;
      }
      case 'parkHome': {
        m.parkedAt = null; m.parkKerb = false;
        if (leg.pool && 'hx' in m) this.pool.unload(m, true);
        return;
      }
      case 'stop': { // a pick-up or drop-off on the way (sim/carpool.ts); the next drive leg starts from here
        if ('hx' in m) this.pool.unload(m, false);
        return;
      }
      case 'park':
      case 'parkLot': {
        const here = tileKey(Math.floor(m.x), Math.floor(m.y));
        const b = w.buildings.get(here);
        const dest = leg.dest ?? [Math.floor(m.x), Math.floor(m.y)];
        if (b && this.parkingFree(b)) {
          this.occupy(m, b);
        } else if (leg.arrive === 'park' && b) {
          w.parkFail.set(here, (w.parkFail.get(here) ?? 0) + 1);
          const lot = this.findLot(b.x, b.y);
          if (lot) { m.legs.unshift({ path: lot.path, drive: true, arrive: 'parkLot', dest, pool: leg.pool }); return; }
          this.kerbOut.set(here, (this.kerbOut.get(here) ?? 0) + 1); // full and no lot in reach (sim/issues.ts: parking full)
          this.kerbPark(m, leg.path);
        } else {
          this.kerbPark(m, leg.path);
        }
        // passengers get out here too (sim/carpool.ts), then walk the rest of the way if the car is not at the destination
        if (leg.pool && 'hx' in m) this.pool.unload(m, true);
        const px = Math.floor(m.x), py = Math.floor(m.y);
        if (px !== dest[0] || py !== dest[1]) {
          const wp = pathBetween(w, px, py, dest[0], dest[1]);
          if (wp) m.legs.unshift({ path: wp, drive: false, arrive: 'none' });
          else { m.x = dest[0] + 0.5; m.y = dest[1] + 0.5; }
        }
        return;
      }
      default: return;
    }
  }

  /**
   * Walk along the leg's polyline. Before stepping onto a carriageway the
   * walker waits at the kerb for any car already in that tile's box, and at
   * a signalled junction for the road they are crossing to have a red (but
   * not forever); a walker with the walk signal holds back turning cars that
   * have not reached the box yet while it clears. While on the carriageway, the tile is flagged with the carriageways
   * being crossed so cars that would drive over them hold at its edge. False
   * when a road tile on the route has gone, so the caller can re-plan.
   */
  private walk(c: Citizen): boolean {
    const ok = this.walkOn(c);
    if (c.pts) this.traffic.noteWalker(c); // where pedestrians are, for the body guard
    return ok;
  }
  private walkOn(c: Citizen): boolean {
    const pts = c.pts;
    if (!pts) return true;
    let remaining = c.stage === LifeStage.Retired ? WALK_SPEED * LIFE.retireeWalk : WALK_SPEED;
    const np = pts.length / 2;
    while (remaining > 0 && c.pp < np) {
      const tx = pts[c.pp * 2], ty = pts[c.pp * 2 + 1];
      const crossing = c.cross![c.pp];
      const xd = c.xdir?.[c.pp] ?? -1;
      if (crossing && TT.pedRetreatOnce && this.backedOff(c, crossing, true)) {
        // stepped back from a car body on this crossing: held there until the crossing ahead is clear, then on, and no
        // second step back on this crossing (docs/traffic-tuning.md "Crossings: the wobble")
        if (this.crossingClear(c, crossing)) this.retreated.get(c)!.hold = false;
        else {
          // in the way of a car (its guard stopped for this walker): a step further back, toward the kerb (pedClearWay)
          if (TT.pedClearWay && this.traffic.inCarsWay(c) && this.retreatToKerb(c, crossing, xd)) return true;
          if (c.x !== pts[(c.pp - 1) * 2] || c.y !== pts[(c.pp - 1) * 2 + 1]) this.traffic.noteCrossing(crossing, crossMask(xd)); // still on the carriageway
          this.traffic.count('guardPed'); c.wait++; return true;
        }
      }
      if (crossing && !(c.cross![c.pp - 1] === crossing) && c.x === pts[(c.pp - 1) * 2] && c.y === pts[(c.pp - 1) * 2 + 1]) {
        // at the kerb, about to step out
        const [bx, by] = untkey(crossing);
        if (xd >= 0 && this.traffic.junctionKind(bx, by) === 'signal') {
          // at lights: never against the signal (the hard cap is longer than any red), and cars stuck in the box only delay you so long
          const swm = TT.pedSignalPatient ? Infinity : signalWaitMax(), walkOn = this.traffic.walkSignal(bx, by, xd);
          if (!walkOn && c.wait < 2 * swm) { c.wait++; return true; }
          if (this.traffic.boxBusy(bx, by, crossMask(xd))) {
            if (walkOn && c.wait < swm) {
              this.traffic.noteCrossing(crossing, crossMask(xd)); // claim the crossing: no new turning car cuts in while the box clears
              c.wait++; return true;
            }
            if (TT.pedSignalPatient) { c.wait++; return true; } // past the cap on a red: still never into a busy box
            this.traffic.count('pedForced');
          }
        } else if (xd >= 0 && this.traffic.junctionKind(bx, by) === 'pelican') {
          // a signal crossing (R4): press, and cross on the red (cars still on it go first); never against it but for the cap
          const swm = signalWaitMax();
          if (this.traffic.pelicanLamp(bx, by) !== 'red' && c.wait < 2 * swm) { this.traffic.pressPelican(bx, by); c.wait++; return true; }
          if (this.traffic.boxBusy(bx, by, crossMask(xd)) && c.wait < 3 * swm) { this.traffic.noteCrossing(crossing, crossMask(xd)); c.wait++; return true; }
        } else if (TT.pedYieldAfter > 0 && this.traffic.carWaitingInto(bx, by, TT.pedYieldAfter) && (TT.crossingWaitMax <= 0 || c.wait < 3 * TT.crossingWaitMax)) {
          c.wait++; return true; // a car has waited a while for people crossing here: let it go first
        } else if (this.traffic.boxBusy(bx, by)) {
          // let cars already in the box go first; with pedestrian priority, claim the crossing so no new car goes in meanwhile
          if (TT.crossingWaitMax <= 0 || c.wait < TT.crossingWaitMax) {
            if (TT.pedPriority) this.traffic.noteCrossing(crossing, crossMask(xd));
            c.wait++; return true;
          }
          this.traffic.count('pedForced');
        }
        if (TT.pedPathClear && !this.crossingClear(c, crossing)) {
          // a car is standing on the crossing: wait on the kerb (claiming it, so no more cars pull onto it)
          this.traffic.noteCrossing(crossing, crossMask(xd));
          c.wait++; return true;
        }
      }
      if (crossing) this.traffic.noteCrossing(crossing, crossMask(xd));
      if (c.x === pts[(c.pp - 1) * 2] && c.y === pts[(c.pp - 1) * 2 + 1] && this.traffic.barrierAhead(c.x, c.y, tx, ty)) { c.wait++; return true; } // a level crossing's barriers are down
      const dx = tx - c.x, dy = ty - c.y;
      const d = hypot(dx, dy);
      if (TT.bodyGuard && d > 0) {
        // never step into a car's body (stepping out of one is always allowed); after guardWaitMax, walk on anyway
        const s = Math.min(1, remaining / d), nx = c.x + dx * s, ny = c.y + dy * s;
        if (this.traffic.carBodyAt(nx, ny) && !this.traffic.carBodyAt(c.x, c.y)) {
          if (TT.pedRetreatAfter > 0 && crossing && c.wait >= TT.pedRetreatAfter && !(TT.pedRetreatOnce && this.backedOff(c, crossing, false)) && this.retreatToKerb(c, crossing, xd)) return true;
          if (TT.guardWaitMax <= 0 || c.wait < TT.guardWaitMax) { this.traffic.count('guardPed'); c.wait++; return true; }
          this.traffic.count('guardPedGaveUp');
        }
      }
      if (d <= remaining) {
        c.x = tx; c.y = ty; remaining -= d; c.wait = 0;
        const nd = c.node![c.pp];
        if (nd >= 0) {
          c.pi = nd;
          noteTrail(c, c.path[nd * 2], c.path[nd * 2 + 1]);
          if (nd > 0 && nd < c.path.length / 2 - 1) {
            const t = this.w.peekTile(c.path[nd * 2], c.path[nd * 2 + 1]);
            if (t === undefined || !isRoad(t)) return false;
          }
        }
        c.pp++;
      } else {
        c.x += (dx / d) * remaining; c.y += (dy / d) * remaining; remaining = 0;
      }
    }
    return true;
  }

  /**
   * A pedestrian held on a crossing by a car's body (the car in turn held by them) steps back toward the kerb they
   * came from, which clears the car's way; at the kerb the usual rules decide when to try again. False when the
   * way back is blocked too.
   */
  private retreatToKerb(c: Citizen, k: number, xd: number): boolean {
    const pts = c.pts!;
    let i = c.pp - 1;
    while (i > 0 && c.cross![i] === k) i--; // the point before the crossing run: the kerb
    const kx = pts[i * 2], ky = pts[i * 2 + 1];
    const dx = kx - c.x, dy = ky - c.y, d = Math.hypot(dx, dy);
    if (d < 1e-9) return false;
    const s = Math.min(1, WALK_SPEED / d), nx = c.x + dx * s, ny = c.y + dy * s;
    if (this.traffic.carBodyAt(nx, ny)) return false;
    c.x = nx; c.y = ny;
    if (s >= 1) { c.x = kx; c.y = ky; c.pp = i + 1; c.wait = 0; } // back on the kerb, facing the crossing again
    else this.traffic.noteCrossing(k, crossMask(xd)); // still on the carriageway
    if (TT.pedRetreatOnce) {
      // once per crossing of this walk, and held where it stepped back to (on the kerb, the kerb's own rules decide)
      const r = this.retreated.get(c);
      if (r) { r.k = k; r.pts = pts; r.hold = s < 1; } else this.retreated.set(c, { k, pts, hold: s < 1 });
      if (s < 1) this.traffic.holdBack(c); // the car may nose past it (carPastHeld)
      if (s < 1) c.wait = 0;
    }
    this.traffic.count('pedRetreat');
    return true;
  }
  /** the crossing each walker last stepped back on (pedRetreatOnce): its tile key, the walk it was on, still held back there */
  private retreated = new WeakMap<Citizen, { k: number; pts: number[]; hold: boolean }>();
  /** has c already stepped back on crossing k of the walk it is on (and, with `holding`, not gone on since)? */
  private backedOff(c: Citizen, k: number, holding: boolean): boolean {
    const r = this.retreated.get(c);
    return !!r && r.k === k && r.pts === c.pts && (!holding || r.hold);
  }
  /** Is the crossing from c's kerb (the points flagged with tile key k from c.pp on) clear of car bodies? */
  private crossingClear(c: Citizen, k: number): boolean {
    const pts = c.pts!;
    let x0 = c.x, y0 = c.y;
    for (let i = c.pp; i * 2 < pts.length && c.cross![i] === k; i++) {
      const x1 = pts[i * 2], y1 = pts[i * 2 + 1];
      for (let t = 0.2; t <= 1.0001; t += 0.2) if (this.traffic.carBodyAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
      x0 = x1; y0 = y1;
    }
    return true;
  }

  private repath(c: Citizen): boolean {
    const gx = c.path[c.path.length - 2], gy = c.path[c.path.length - 1];
    const p = pathBetween(this.w, Math.floor(c.x), Math.floor(c.y), gx, gy);
    if (!p) return false;
    c.path = p; c.commute = null;
    if (c.leg) c.leg.path = p;
    this.startWalking(c);
    return true;
  }

  /**
   * Drivers held up for a while look for a better way round, with hysteresis
   * so routes don't flap. `force` (the stuck rule) avoids the tile beyond the
   * one ahead, which is what holds the car, and takes any way round at all.
   * Only the route after the tile ahead changes, and never once the car is
   * committed into it (its movement through that box is already decided).
   */
  /** a road's class changed (World.onRoadClass): drivers check the way ahead once against it (recheckClasses) */
  private classEpoch = 0;
  private classSeen = new WeakMap<Mover, number>();
  /**
   * After a road's class changed under the traffic (a street made one-way or pedestrian, say: shared/src/roadclass.ts),
   * a driver whose way ahead now breaks a rule finds another; the rest carry on. Until it has a way that keeps them, it
   * asks again each tick (a car committed into a box cannot turn off this tick).
   */
  private recheckClasses(m: Mover, leg: Leg) {
    if (this.classSeen.get(m) === this.classEpoch) return;
    // a delivery may go on along a pedestrian street only in its hours (it may always drive off one: carStepOk checks the way on)
    const p = m.path, n = p.length / 2, service = m.priority || ('vkind' in m && (m as Vehicle).vkind === VehicleKind.Freight && pedestrianDeliveryOpen((this.w.tick % TICKS_PER_DAY) / TICKS_PER_HOUR));
    let broken = false;
    for (let i = Math.max(1, m.pi); i + 1 < n && !broken; i++) {
      const ax = p[i * 2], ay = p[i * 2 + 1], bx = p[i * 2 + 2], by = p[i * 2 + 3];
      if (!isRoad(this.w.peekTile(bx, by) ?? 0)) continue;
      if (!carStepOk(this.w.auxAt(ax, ay), this.w.auxAt(bx, by), dirBetween(ax, ay, bx, by), service)) broken = true;
    }
    if (!broken && this.w.ruleTiles.size) broken = this.breaksRules(m, Math.max(1, m.pi));
    if (!broken && this.w.streetAny) broken = this.control.breaksBan(m, Math.max(1, m.pi)); // a new HGV ban on a lorry's way (R5)
    // a way broken by a class change or a road rule: any other way at all, from the tile ahead (not avoiding the one
    // after it, as the stuck rule does: that tile holds nobody up)
    if (broken) { const was = m.path; this.maybeReroute(m, leg, true, true); if (m.path === was) return; }
    this.classSeen.set(m, this.classEpoch);
  }
  /**
   * Does m's way from path node `from` on make a movement a junction's road rule bans (R4, World.ruleTiles: a turn ban or
   * a no entry, from the heading it comes into the junction by to the one it leaves by)? Emergencies on a call ignore
   * turn bans, never a no-entry.
   */
  breaksRules(m: Mover, from: number): boolean {
    const p = m.path, n = p.length / 2, RT = this.w.ruleTiles;
    for (let i = Math.max(1, from); i + 1 < n; i++) {
      const rk = RT.get(tkey(p[i * 2], p[i * 2 + 1]));
      if (rk === undefined || RT.get(tkey(p[i * 2 - 2], p[i * 2 - 1])) === rk) continue; // not coming into a ruled junction here
      const inH = dirBetween(p[i * 2 - 2], p[i * 2 - 1], p[i * 2], p[i * 2 + 1]);
      let j = i;
      while (j + 1 < n && RT.get(tkey(p[j * 2 + 2], p[j * 2 + 3])) === rk) j++;
      if (j + 1 >= n) break;
      const outH = dirBetween(p[j * 2], p[j * 2 + 1], p[j * 2 + 2], p[j * 2 + 3]);
      if (!turnAllowed(this.w.roadRules.get(rk), inH, outH, m.priority)) return true;
      i = j;
    }
    return false;
  }
  private maybeReroute(m: Mover, leg: Leg, force = false, broken = false) {
    const w = this.w;
    let late = false;
    if (force) { if (w.tick - m.rerouted < 10) return; }
    else {
      if (this.routeBudget <= 0 || (w.tick + m.id * 7) % REROUTE_EVERY !== 0 || w.tick - m.rerouted < TT.rerouteCooldown) return;
      // held up (at a standstill for a while), or running late on the whole leg even if it is creeping along
      late = !!TT.delayReroute && this.runningLate(m, leg);
      if (m.wait < 10 && !late) return;
    }
    const n = m.path.length / 2;
    if (m.pi >= n - 1 || m.committed || m.prog >= 0.5) return;
    if (!force) this.routeBudget--;
    m.rerouted = w.tick;
    if (late) this.rerouteLog.lateTried++;
    const ax = m.path[(m.pi - 1) * 2], ay = m.path[(m.pi - 1) * 2 + 1];
    const bx = m.path[m.pi * 2], by = m.path[m.pi * 2 + 1];
    const cx = m.path[(m.pi + 1) * 2], cy = m.path[(m.pi + 1) * 2 + 1];
    const gx = m.path[(n - 1) * 2], gy = m.path[(n - 1) * 2 + 1];
    // never back through the tile behind: lanes have no U-turns (one would be drawn driving straight through the box)
    const AVOID = 1e4;
    const lorry = this.control.isLorry(m), base = lorry ? this.control.costFor(m) : null; // a lorry (R5): HGV bans and 20 zones
    const cost = base
      ? (force && !broken
        ? (x: number, y: number) => ((x === cx && y === cy && m.pi + 1 < n - 1) || (x === ax && y === ay) ? AVOID : base(x, y))
        : (x: number, y: number) => (x === ax && y === ay ? AVOID : base(x, y)))
      : force && !broken
        ? (x: number, y: number) => ((x === cx && y === cy && m.pi + 1 < n - 1) || (x === ax && y === ay) ? AVOID : this.traffic.cost(x, y))
        : (x: number, y: number) => (x === ax && y === ay ? AVOID : this.traffic.cost(x, y));
    // a new way is taken only when it costs less than `worse`, so the search stops once it cannot find one that does
    // (docs/search-perf.md: three in four searches found the way the driver was already on; the margin keeps rounding
    // from ever stopping one short of a way that would be taken)
    const worse = force ? AVOID : Math.min(AVOID, this.traffic.pathCost(m.path, m.pi + 1) * (late ? TT.delayGain : 0.85));
    // a driver running late searches wider: the way round a jam is often a long way round
    const alt = findRoute(w, bx, by, gx, gy, cost, 0.4, late ? TT.delayNodes : TT.rerouteNodes, dirBetween(ax, ay, bx, by), worse * (1 + 1e-9), false, m.priority, lorry); // heading into B already (no turning on a flyover)
    if (!alt || alt.path.length < 2 || alt.cost >= worse) return;
    m.path = [ax, ay, ...alt.path]; m.pi = 1;
    leg.path = m.path;
    this.traffic.restrand(m);
    this.traffic.count(force ? 'stuckReroutes' : 'reroutes');
    this.noteReroute(m, leg, force ? 'forced' : late ? 'late' : 'slow');
  }

  // ---- re-route bookkeeping ----------------------------------------------------------

  /** Ticks a driver is expected to need for the rest of its route at free-flow speed, from the route cost now. */
  private expectedTicks(m: Mover, from: number): number {
    const speed = DRIVE_SPEED * m.speedMul * (m.cls === VehicleClass.Truck ? 0.8 : 1);
    return this.traffic.pathCost(m.path, from) / speed;
  }
  /** A drive leg starts: remember when, what it should take, and carry the trip's re-route count over from the leg before. */
  private startTrack(m: Citizen | Vehicle, leg: Leg) {
    const prev = this.legTrack.get(m);
    const tripAt = 'tripStart' in m ? m.tripStart : -1; // a vehicle's "trip" is one leg
    const sameTrip = !!prev && tripAt >= 0 && prev.tripAt === tripAt;
    const exp = this.expectedTicks(m, 1);
    this.legTrack.set(m, {
      leg, at: this.w.tick, exp, at0: this.w.tick, exp0: exp, n: 0, tripAt,
      trip: sameTrip ? prev!.trip : 0, day: prev?.day ?? -1, dayN: prev?.dayN ?? 0,
    });
  }
  /** Elapsed time on this leg exceeds what was expected at departure by delayFrac and delayMinTicks (and the re-route budget for the leg is not spent). */
  private runningLate(m: Mover, leg: Leg): boolean {
    const t = this.legTrack.get(m);
    if (!t || t.leg !== leg || t.exp <= 0 || t.n >= TT.delayMax) return false;
    const over = this.w.tick - t.at - t.exp;
    return over >= TT.delayMinTicks && over > t.exp * TT.delayFrac;
  }
  private noteReroute(m: Mover, leg: Leg, kind: 'slow' | 'late' | 'forced') {
    const day = Math.floor(this.w.tick / DAY);
    let t = this.legTrack.get(m);
    if (!t || t.leg !== leg) this.legTrack.set(m, t = { leg, at: this.w.tick, exp: 0, at0: this.w.tick, exp0: 0, n: 0, tripAt: -1, trip: 0, day: -1, dayN: 0 });
    t.trip++;
    if (t.day !== day) { t.day = day; t.dayN = 0; }
    t.dayN++;
    if (kind === 'late') t.n++;
    // the new route is the new plan: judge lateness from here against what it should take
    if (t.exp > 0 && kind !== 'forced') { t.at = this.w.tick; t.exp = this.expectedTicks(m, m.pi); }
    this.rerouteLog[kind]++;
    this.rerouteLog.byDay.set(day, (this.rerouteLog.byDay.get(day) ?? 0) + 1);
  }
  /** Re-routes of one driver this trip and today (0 when never re-routed). */
  reroutesOf(m: Mover): { trip: number; day: number } {
    const t = this.legTrack.get(m);
    return t ? { trip: t.trip, day: t.day === Math.floor(this.w.tick / DAY) ? t.dayN : 0 } : { trip: 0, day: 0 };
  }
  private sampleLeg(m: Mover, leg: Leg) {
    const t = this.legTrack.get(m);
    if (t && t.leg === leg && t.exp0 > 0) this.legSamples!.push([this.w.tick - t.at0, t.exp0]);
  }

  /** Held up rerouteAt ticks (and every REROUTE_EVERY after) without reaching a new tile: time to try another way round. */
  private dueForcedReroute(m: Mover): boolean {
    return TT.rerouteAt > 0 && m.wait > 0 && m.stuck >= TT.rerouteAt && (m.stuck - TT.rerouteAt) % REROUTE_EVERY === 0;
  }
  /**
   * A driver past the stuck limit (TRAFFIC_TUNING.stuckLimit). The old rule
   * (stuckReroute 0) gives up at once: the citizen goes home, a vehicle is
   * removed. Otherwise the driver looks for a way round the blocked exit every
   * REROUTE_EVERY ticks, and only after abandonAfter more ticks, and never
   * while inside a junction box, gives up visibly: a citizen leaves the car
   * at the kerb and walks on from the building beside it, a vehicle is withdrawn.
   */
  private onStuck(m: Citizen | Vehicle, leg: Leg) {
    // the Traffic panel's give-ups by junction and by who (R5, sim/control.ts): whatever the rule below did
    const c = this.traffic.counters, before = c.stuckHome + c.stuckDespawn + c.abandonKerb + c.abandonDespawn;
    const at = m.pi >= 1 ? { pi: m.pi, path: m.path } : null;
    this.stuckRule(m, leg);
    if (at && c.stuckHome + c.stuckDespawn + c.abandonKerb + c.abandonDespawn > before) this.control.noteGiveUp({ ...m, ...at } as Citizen | Vehicle);
  }
  private stuckRule(m: Citizen | Vehicle, leg: Leg) {
    const veh = 'vkind' in m;
    if (!TT.stuckReroute) {
      if (this.traffic.inJunctionBox(m)) this.traffic.count('stuckInBox');
      if (veh) { this.traffic.count('stuckDespawn'); this.despawn(m); }
      else { this.traffic.count('stuckHome'); this.abortTrip(m, false); }
      return;
    }
    if (TT.stuckReroute === 4) {
      // never make a car vanish from inside a junction box: release the first car clear of every box along the
      // chain of cars holding it up instead (that unblocks it), and only as a last resort, at three times the
      // limit, the boxed car itself
      let target: Citizen | Vehicle = m;
      if (this.traffic.inJunctionBox(m)) {
        target = null as unknown as Citizen;
        const seen = new Set<Mover>([m]);
        for (let h = this.traffic.holderOf(m); h && !seen.has(h) && seen.size < 40; h = this.traffic.holderOf(h)) {
          seen.add(h);
          if (!this.traffic.inJunctionBox(h) && h.wait > 0) { target = h as Citizen | Vehicle; break; }
        }
        if (!target) { if (m.stuck <= 3 * TT.stuckLimit) return; target = m; }
      }
      if (this.traffic.inJunctionBox(target)) this.traffic.count('stuckInBox');
      if ('vkind' in target) { this.traffic.count('stuckDespawn'); this.despawn(target); }
      else if (TT.stuckKerb && target.leg && this.abandonAtKerb(target, target.leg)) this.traffic.count('abandonKerb');
      else { this.traffic.count('stuckHome'); this.abortTrip(target, false); }
      if (target !== m) m.stuck = Math.floor(TT.stuckLimit / 2); // give the freed queue time to move before m is judged again
      return;
    }
    if (TT.stuckReroute === 3) {
      // the old give-up, but never while the car is inside a junction box
      if (this.traffic.inJunctionBox(m)) return;
      if (veh) { this.traffic.count('stuckDespawn'); this.despawn(m); }
      else { this.traffic.count('stuckHome'); this.abortTrip(m, false); }
      return;
    }
    if (TT.stuckReroute === 2) {
      // give up where it is safe to be seen doing so: never inside a junction box; a driver pulls over at the
      // kerb and walks on, a vehicle is withdrawn; home only as a last resort, after twice the limit
      if (this.traffic.inJunctionBox(m)) return;
      if (veh) { this.traffic.count('abandonDespawn'); this.despawn(m); return; }
      if (this.abandonAtKerb(m, leg)) { this.traffic.count('abandonKerb'); return; }
      if (m.stuck > 2 * TT.stuckLimit) { this.traffic.count('stuckHome'); this.abortTrip(m, false); }
      return;
    }
    const over = m.stuck - TT.stuckLimit;
    if ((over - 1) % REROUTE_EVERY === 0) this.maybeReroute(m, leg, true);
    if (TT.abandonAfter <= 0 || over <= TT.abandonAfter || this.traffic.inJunctionBox(m)) return;
    if (veh) { this.traffic.count('abandonDespawn'); this.despawn(m); }
    else if (this.abandonAtKerb(m, leg)) this.traffic.count('abandonKerb');
  }
  /**
   * Pull over where the car is (a plain road tile, it holds a kerb slot like
   * any kerb-parked car) and walk the rest of the way from the lot on the
   * kerb side. False, and the driver keeps waiting, when there is no lot on
   * that side or no footpath on from it.
   */
  private abandonAtKerb(c: Citizen, leg: Leg): boolean {
    const w = this.w;
    if (c.lane < 0 || c.pi < 1) return false;
    const ax = c.path[(c.pi - 1) * 2], ay = c.path[(c.pi - 1) * 2 + 1];
    const d = dirBetween(ax, ay, c.path[c.pi * 2], c.path[c.pi * 2 + 1]);
    const RIGHT = [2, 3, 1, 0];
    const rx = ax + [1, -1, 0, 0][RIGHT[d]], ry = ay + [0, 0, 1, -1][RIGHT[d]];
    const rt = w.peekTile(rx, ry);
    if (rt === undefined || isRoad(rt)) return false;
    if (w.streetAny && this.traffic.kerbless(ax, ay)) return false; // double yellows or a bus lane (R5): not here
    const n = c.path.length / 2;
    // a shared drive with stops still to make: walk to where the whole trip was going (passengers make their own way)
    const last = leg.pool ? c.legs.filter((l) => l.pool === leg.pool).pop() : undefined;
    const dest = last?.dest ?? leg.dest ?? [c.path[(n - 1) * 2], c.path[(n - 1) * 2 + 1]];
    const wp = pathBetween(w, rx, ry, dest[0], dest[1]);
    if (!wp) return false;
    if (last) c.legs = c.legs.filter((l) => l.pool !== leg.pool);
    this.traffic.leave(c);
    const k = tkey(ax, ay);
    w.kerb.set(k, Math.min(KERB_CAP + 2, (w.kerb.get(k) ?? 0) + 1));
    c.parkedAt = tileKey(ax, ay); c.parkKerb = true;
    c.x = rx + 0.5; c.y = ry + 0.5;
    c.legs.unshift({ path: wp, drive: false, arrive: 'none' });
    this.startLeg(c);
    return true;
  }

  /** Give up on the current trip. A commute with no road left costs the job; a jam does not. */
  private abortTrip(c: Citizen, noRoute = true) {
    const wasCommute = c.state === S.ToWork;
    this.teleportHome(c);
    if (wasCommute && noRoute) this.w.quitJob(c);
  }

  private teleportHome(c: Citizen) {
    this.transit.drop(c); this.taxis.drop(c);
    this.pool.forget(c);
    this.w.leaveSite(c);
    this.dropVenue(c);
    c.errand = 0;
    if (c.leg?.drive) { c.parkedAt = null; c.parkKerb = false; } // the car comes home too
    this.traffic.leave(c);
    c.legs = []; c.leg = null; c.pts = null;
    c.x = c.hx + 0.5; c.y = c.hy + 0.5; c.state = S.Home; c.path = []; c.pi = 0; c.trail = []; c.eduBits &= ~EDU_HOMEWARD;
    if (c.job || c.study) this.scheduleNext(c);
  }

  // ---- parking ---------------------------------------------------------------------

  private parkingCap(b: Building) {
    return parkingOf(b.id, b.level, this.w.ownerHas(b.x, b.y, 'underground', hasFeature));
  }
  private parkingFree(b: Building) {
    return (this.w.parking.get(tileKey(b.x, b.y)) ?? 0) < this.parkingCap(b);
  }
  private occupy(m: Citizen | Vehicle, b: Building) {
    const w = this.w;
    const key = tileKey(b.x, b.y);
    w.parking.set(key, (w.parking.get(key) ?? 0) + 1);
    m.parkedAt = key; m.parkKerb = false;
    const parcel = w.parcelAt(b.x, b.y);
    w.bump(parcel?.owner, 'parked', 1);
    if (b.zone === Zone.Parking && parcel) {
      if ('money' in m) { m.money -= PARKING_FEE; noteSpend(m, PARKING_FEE, w.tick); }
      w.credit(parcel.owner, PARKING_FEE, 'fees');
      parcel.stats.taxToday += PARKING_FEE;
      w.lotIncome.set(key, (w.lotIncome.get(key) ?? 0) + PARKING_FEE);
      w.dirtyParcels.add(parcel.id);
    }
  }
  private releaseParking(m: { parkedAt: string | null; parkKerb: boolean }) {
    const w = this.w;
    if (!m.parkedAt) return;
    if (m.parkKerb) {
      const [x, y] = parseKey(m.parkedAt);
      const k = tkey(x, y), n = (w.kerb.get(k) ?? 1) - 1;
      if (n <= 0) w.kerb.delete(k); else w.kerb.set(k, n);
    } else {
      const n = (w.parking.get(m.parkedAt) ?? 1) - 1;
      if (n <= 0) w.parking.delete(m.parkedAt); else w.parking.set(m.parkedAt, n);
    }
    m.parkedAt = null; m.parkKerb = false;
  }
  /** Nearest parking lot with a free bay within PARK_RADIUS of a full destination, with a drive route to it. */
  private findLot(x: number, y: number): { path: number[] } | null {
    const w = this.w;
    const lotScore = (lx: number, ly: number) => 2 * hash2(lx, ly); // a little spread between equally close lots
    // only search the roads when a lot with a free bay is in range; its best (score - distance) bounds the search
    let maxTotal = -Infinity;
    w.eachBuiltNear(x, y, [Zone.Parking], PARK_RADIUS, (b, d) => {
      if (this.parkingFree(b)) maxTotal = Math.max(maxTotal, lotScore(b.x, b.y) - Math.max(1, d));
    });
    if (maxTotal === -Infinity) return null;
    const r = findBest(w, x, y, (lx, ly) => {
      if (Math.abs(lx - x) + Math.abs(ly - y) > PARK_RADIUS) return null;
      const b = w.buildings.get(tileKey(lx, ly));
      if (!b || b.zone !== Zone.Parking || !this.parkingFree(b)) return null;
      return lotScore(lx, ly);
    }, 800, 2, maxTotal);
    return r && r.path.length >= 4 ? { path: r.path } : null;
  }
  /** Leave the car on the last road tile of the leg (costing that lane a slot). */
  private kerbPark(m: Citizen | Vehicle, path: number[]) {
    const w = this.w;
    let rx = Math.floor(m.x), ry = Math.floor(m.y);
    for (let i = path.length - 4; i >= 0; i -= 2) {
      const t = w.peekTile(path[i], path[i + 1]);
      if (t !== undefined && isRoad(t) && !this.traffic.kerbless(path[i], path[i + 1])) { rx = path[i]; ry = path[i + 1]; break; } // never at the kerb of a roundabout, flyover or level crossing
    }
    const k = tkey(rx, ry);
    w.kerb.set(k, Math.min(KERB_CAP + 2, (w.kerb.get(k) ?? 0) + 1));
    m.parkedAt = tileKey(rx, ry); m.parkKerb = true;
  }

  // ---- vehicles that are not citizens: freight, visitors, patrols, call-outs ---------------

  /**
   * Rail freight (sim/rail.ts, set by index.ts): asked first for every factory -> shop delivery; it may take it by train,
   * naming the yard the truck drives to instead, and hears when that truck arrives.
   */
  freight: { consign(from: [number, number], to: [number, number], owner: string | null): { id: number; yard: [number, number] } | null; truckStarted(id: number, vid: number | null): void; truckArrived(vid: number): boolean } | null = null;
  /**
   * Cargo ports (sim/harbours.ts, set by game.ts): the road in front of each open port is an export point beside the
   * motorway connections, and a truck arriving there leaves its box in the port's export stack.
   */
  ports: { exportPoints(): readonly [number, number][]; exported(x: number, y: number): boolean } | null = null;
  /** Queue a delivery from a harbour (sim/harbours.ts): fish to a buyer, or a container off a ship to a shop; the buyer pays `fee` on delivery. */
  harbourFreight(b: Building, to: [number, number], fee: number) { this.dispatchQueue.push({ vkind: VehicleKind.Freight, b, entry: null, to, fee }); }
  /** A delivery truck from (from) to (to) for its owner: the last mile of rail freight, from a yard to the shop. */
  spawnFreightTruck(from: [number, number], to: [number, number], owner: string | null): number | null { return this.spawnVehicle(VehicleKind.Freight, from, to, owner)?.id ?? null; }
  /** A fire engine on blue lights from its station to a fire (sim/fires.ts), or null when no road joins them. It pulls up at the door, never looking for a space, and waits there (phase 'dwell'). */
  spawnFireEngine(from: [number, number], to: [number, number], owner: string | null): number | null {
    const v = this.spawnVehicle(VehicleKind.FireEngine, from, to, owner, true);
    if (v?.leg) v.leg.arrive = 'none';
    if (v) v.call = true;
    return v?.id ?? null;
  }

  private spawnVehicle(vkind: number, from: [number, number], to: [number, number], owner: string | null, priority = false): Vehicle | null {
    const w = this.w;
    // a pedestrian street lets in emergencies, and deliveries out of shop hours (shared/src/roadclass.ts)
    const service = priority || (vkind === VehicleKind.Freight && pedestrianDeliveryOpen((w.tick % TICKS_PER_DAY) / TICKS_PER_HOUR));
    // an emergency on a call ignores turn bans, never a no-entry (shared/src/roadrules.ts)
    // a lorry (R5): round HGV bans but to reach either end, and 20 zones cost it more (sim/control.ts)
    const lorry = vkind === VehicleKind.Freight;
    const route = findRoute(w, from[0], from[1], to[0], to[1], this.control.costFor(null, vkind), undefined, undefined, undefined, undefined, service, priority, lorry);
    if (!route || route.path.length < 4) return null;
    const id = this.nextVehicleId++;
    const v: Vehicle = {
      id, x: from[0] + 0.5, y: from[1] + 0.5, path: [], pi: 0, vkind, phase: 'out', from, to, until: 0,
      parkedAt: null, parkKerb: false, owner, legs: [{ path: route.path, drive: true, arrive: vkind === VehicleKind.Patrol ? 'none' : 'park', dest: to }], leg: null,
      call: false, weave: false, // set on a fire engine's call (sim/fires.ts); here so every vehicle has one shape
      fee: undefined, // and the rest of what some vehicles get later (harbour freight; buses and fleet vehicles: sim/transit.ts, sim/mobile.ts)
      ...w.moverDefaults(id),
      halt: undefined, dwell: undefined,
    };
    v.priority = priority;
    if (vkind === VehicleKind.Freight) v.gapMul *= 1.4;
    resetTrail(v, from[0], from[1]);
    w.vehicles.set(id, v);
    // a lorry the curfew holds sets off in the morning (moveVehicles); kept off the Vehicle, so every vehicle has one shape
    const hold = lorry ? this.control.curfewHold(id, owner, to) : undefined;
    if (lorry) this.control.noteFreight();
    else if (vkind === VehicleKind.Visitor) this.control.noteVisitor(from[0], from[1]);
    if (hold !== undefined) this.control.holds.set(id, hold);
    else this.startLeg(v);
    return v;
  }

  private moveVehicles() {
    const w = this.w;
    for (const v of w.vehicles.values()) {
      if (v.vkind === VehicleKind.Bus || v.vkind > FLEET_VKIND) continue; // driven by the bus service (sim/transit.ts) or as mobile jobs (sim/mobile.ts)
      if (v.phase === 'dwell') {
        if (w.tick >= v.until) this.headBack(v);
        continue;
      }
      if (this.control.holds.size) { // a lorry the curfew held (R5): it sets off once its time comes
        const h = this.control.holds.get(v.id);
        if (h !== undefined) { if (w.tick < h) continue; this.control.holds.delete(v.id); this.control.curfew.released++; if (!this.startLeg(v)) { w.vehicles.delete(v.id); continue; } }
      }
      if (!v.leg) { w.vehicles.delete(v.id); continue; }
      const leg = v.leg;
      let done = false;
      const call = v.call ? this.callStep(v) : 0; // a fire engine on a call (sim/fires.ts): 1 waiting or weaving, 2 arrived weaving
      if (call === 1) continue;
      if (call === 2) done = true;
      else if (leg.drive) {
        if (v.lane < 0) { if (this.traffic.enter(v) === 'blocked') { if (++v.wait > GARAGE_WAIT_MAX) { this.traffic.count('garageGiveUp'); this.despawn(v); } continue; } continue; }
        const r = this.traffic.step(v);
        if (r === 'stuck') { this.onStuck(v, leg); continue; }
        if (r === 'moving') { if (this.classEpoch) this.recheckClasses(v, leg); this.maybeReroute(v, leg, this.dueForcedReroute(v)); continue; }
        done = true;
      } else {
        // vehicles never walk; a non-drive leg means the route could not be driven
        done = true; v.x = leg.path[leg.path.length - 2] + 0.5; v.y = leg.path[leg.path.length - 1] + 0.5;
      }
      if (!done) continue;
      this.arriveLeg(v, leg);
      if (v.legs.length) { this.startLeg(v); continue; }
      v.leg = null;
      if (v.phase === 'out') this.startDwell(v);
      else this.despawn(v);
    }
  }
  /**
   * A fire engine on a call that traffic has stopped (sim/fires.ts) drives on down the middle of the road with its lights
   * on, out of the lanes: nobody has to make room in the simulation, and drawn it passes the queue on the crown of the
   * road. It keeps to its route at WEAVE_SPEED of a car's speed, through junctions and signals, until it arrives. Returns
   * true on arrival. callStep, before the ordinary drive step: 0 drive on as any vehicle, 1 done for this tick, 2 arrived.
   */
  private callStep(v: Vehicle): 0 | 1 | 2 {
    if (!v.leg?.drive) return 0;
    if (v.weave) return this.weave(v) ? 2 : 1;
    if (v.lane < 0) {
      // pulling out: enter() zeroes wait, so stuck counts the engine's wait at its door
      if (this.traffic.enter(v) === 'blocked' && ++v.stuck > WEAVE_AFTER) v.weave = true;
      return 1;
    }
    if (v.wait > WEAVE_AFTER) { this.traffic.leave(v); v.weave = true; return 1; } // stopped in traffic since the last step
    return 0;
  }
  private weave(v: Vehicle): boolean {
    const p = v.path, n = p.length / 2;
    if (v.pi < 1) v.pi = 1;
    let s = DRIVE_SPEED * WEAVE_SPEED;
    while (s > 0 && v.pi < n) {
      const left = 1 - v.prog;
      if (s >= left) { s -= left; noteTrail(v, p[v.pi * 2], p[v.pi * 2 + 1]); v.pi++; v.prog = 0; } else { v.prog += s; s = 0; }
    }
    if (v.pi >= n) { v.x = p[(n - 1) * 2] + 0.5; v.y = p[(n - 1) * 2 + 1] + 0.5; v.weave = false; return true; }
    const ax = p[(v.pi - 1) * 2], ay = p[(v.pi - 1) * 2 + 1], bx = p[v.pi * 2], by = p[v.pi * 2 + 1];
    v.x = ax + 0.5 + (bx - ax) * v.prog; v.y = ay + 0.5 + (by - ay) * v.prog;
    return false;
  }
  private startDwell(v: Vehicle) {
    const w = this.w;
    v.phase = 'dwell';
    const toB = w.buildings.get(tileKey(v.to[0], v.to[1]));
    const parcel = toB ? w.parcelAt(toB.x, toB.y) : undefined;
    if (v.vkind === VehicleKind.Freight) {
      v.until = w.tick + FREIGHT_DWELL;
      if (this.motorway && this.entries.some((e) => e[0] === v.to[0] && e[1] === v.to[1])) { v.until = w.tick; if (v.owner) w.credit(v.owner, FREIGHT_FEE, 'fees'); return; } // an export, handed over at the motorway junction and paid for by the buyer out of town
      if (this.ports?.exported(v.to[0], v.to[1])) { v.until = w.tick; if (v.owner) w.credit(v.owner, FREIGHT_FEE, 'fees'); return; } // the same, into a cargo port's export stack (sim/harbours.ts)
      if (this.freight?.truckArrived(v.id)) return; // a container left at a freight yard for the train: the shop pays on the last mile
      if (parcel && v.owner) w.transfer(parcel.owner, v.owner, v.fee ?? FREIGHT_FEE);
    } else if (v.vkind === VehicleKind.Visitor) {
      v.until = w.tick + Math.round(TPH * (1 + 2 * Math.random()));
      if (parcel) { const tax = VISITOR_SPEND * parcel.taxRate; w.credit(parcel.owner, tax); parcel.stats.taxToday += tax; w.dirtyParcels.add(parcel.id); }
    } else if (v.vkind === VehicleKind.Patrol) {
      v.until = w.tick; // turn straight round
    } else {
      v.until = w.tick + CALLOUT_DWELL;
    }
  }
  private headBack(v: Vehicle) {
    const w = this.w;
    // the lorry curfew (R5): a lorry that delivered late stays where it is until the morning
    if (v.vkind === VehicleKind.Freight && this.curfewOwners() > 0) { const h = this.control.curfewHold(v.id, v.owner, v.to); if (h !== undefined) { v.until = h; return; } }
    const at: [number, number] = v.parkedAt ? parseKey(v.parkedAt) : [Math.floor(v.x), Math.floor(v.y)];
    this.releaseParking(v);
    v.phase = 'back';
    const dest: [number, number] = v.vkind === VehicleKind.Visitor && this.entries.length ? this.entries[Math.floor(Math.random() * this.entries.length)] : v.from;
    // a delivery or an emergency that went down a pedestrian street drives out of it again (roadclass.ts)
    const service = v.vkind === VehicleKind.Freight || v.vkind === VehicleKind.FireEngine || v.vkind === VehicleKind.Ambulance || v.vkind === VehicleKind.Patrol;
    const route = findRoute(w, at[0], at[1], dest[0], dest[1], this.control.costFor(v), undefined, undefined, undefined, undefined, service, false, this.control.isLorry(v));
    if (!route || route.path.length < 4) { this.despawn(v); return; }
    v.x = at[0] + 0.5; v.y = at[1] + 0.5;
    v.priority = false; v.call = false;
    resetTrail(v, at[0], at[1]);
    v.legs = [{ path: route.path, drive: true, arrive: 'none' }];
    this.startLeg(v);
  }
  /** How many players have the lorry curfew on (0 skips its checks), recounted when the players change. */
  private curfewOwners(): number {
    let n = 0;
    for (const p of this.w.players.values()) if (p.policies?.includes('curfew')) n++;
    return n;
  }
  private despawn(v: Vehicle) {
    this.traffic.leave(v);
    this.releaseParking(v);
    this.w.vehicles.delete(v.id);
  }

  /**
   * Put new freight, visitors, patrols and call-outs on the road at their hourly rates. Runs every tick: each
   * industrial building and station is rolled once per DISPATCH_EVERY ticks (a rotating slice of each list per
   * tick, with the per-roll chance scaled to that window), visitors are rolled per tick. Destinations come from
   * the World's built-building index (nearest-ish, weighted as before) and are routed once with A*; at most
   * DISPATCH_BUDGET trips start per tick and the rest wait in a queue for the next one.
   */
  private dispatch() {
    const w = this.w;
    const h = this.hour;
    const window = DISPATCH_EVERY, slot = w.tick % window;
    const q = this.dispatchQueue;
    const eachInSlice = (list: readonly Building[], fn: (b: Building) => void) => {
      const n = list.length, i0 = Math.floor((n * slot) / window), i1 = Math.floor((n * (slot + 1)) / window);
      for (let i = i0; i < i1; i++) fn(list[i]);
    };
    // freight from staffed industry, by day
    if (h >= 6 && h < 20) {
      eachInSlice(w.builtOf(Zone.Industrial), (b) => {
        if (b.occupants === 0) return;
        // a merged works sends freight like the lots it replaced: by jobs (a 1×1 lot has 6 per level, so this is its level)
        const weight = isMergedKind(b.id) ? capacityOf(b.id, b.level) / 6 : b.level;
        const p = (FREIGHT_TRIPS_PER_LEVEL_PER_DAY * weight) / (14 * TPH) * window;
        if (Math.random() < p) q.push({ vkind: VehicleKind.Freight, b, entry: null });
      });
      // inter-city freight through the motorway connections (sim/gateways.ts): lorries bring goods in for the shops
      if (this.motorway) {
        let n = Math.min(IMPORTS_PER_SHOP_PER_DAY * w.builtOf(Zone.Commercial).length / 14, this.entries.length * MOTORWAY_LORRIES_PER_HOUR) / TPH;
        for (; n > 0 && Math.random() < n; n -= 1) q.push({ vkind: VehicleKind.Freight, b: null, entry: this.entries[Math.floor(Math.random() * this.entries.length)] });
      }
    }
    // patrols and call-outs from stations whose owner has the technology
    for (const zone of [Zone.Police, Zone.Fire, Zone.Hospital]) {
      const every = zone === Zone.Police ? PATROL_EVERY : CALLOUT_EVERY;
      const vkind = zone === Zone.Police ? VehicleKind.Patrol : zone === Zone.Fire ? VehicleKind.FireEngine : VehicleKind.Ambulance;
      eachInSlice(w.builtOf(zone), (b) => {
        if (b.occupants === 0 || !w.ownerHas(b.x, b.y, 'patrols', hasFeature)) return;
        if (Math.random() < (window * PATROL_RATE_OF[b.id]) / every) q.push({ vkind, b, entry: null }); // per tier: a police box patrols less, an HQ more (1 for the original stations)
      });
    }
    // visitors from outside, scaled with population and the time of day
    if (this.entries.length && this.population > 0) {
      const peak = (h >= 8 && h < 10) || (h >= 16 && h < 19) ? 1 : (h >= 10 && h < 23) ? 0.4 : 0.05;
      let n = (VISITORS_PER_100_PEAK_HOUR * (this.population / 100) * peak) / TPH;
      // a motorway connection's slip road feeds about as many cars an hour as one road lane takes (the old far-edge
      // entries turned away nine in ten at the kerb): a second connection brings more visitors in
      if (this.motorway) n = Math.min(n, (this.entries.length * MOTORWAY_VISITORS_PER_HOUR * peak) / TPH);
      while (n > 0) {
        if (Math.random() >= n) break;
        n -= 1;
        const entry = this.entries[Math.floor(Math.random() * this.entries.length)];
        // the visitor limit at its gateway (R5): half are turned away
        if ((TT.visitorLimit || w.gatewayLimits) && this.control.dropVisitor(entry, !!TT.visitorLimit, Math.random)) continue;
        q.push({ vkind: VehicleKind.Visitor, b: null, entry });
      }
    }
    if (q.length > DISPATCH_QUEUE_MAX) q.splice(0, q.length - DISPATCH_QUEUE_MAX); // overloaded: the oldest give up
    let budget = DISPATCH_BUDGET, done = 0;
    while (done < q.length && budget > 0) budget -= this.startTrip(q[done++]);
    q.splice(0, done);
  }

  /** Pick a destination for one dispatched trip and put the vehicle on the road. Returns the route searches spent. */
  private startTrip(job: DispatchJob): number {
    const w = this.w;
    const reachable = (t: Building) => w.hasRoadAccess(t.x, t.y);
    if (job.vkind === VehicleKind.Freight && job.entry) {
      // an import: a lorry from the motorway connection to a shop, and back out the way it came
      const from = job.entry;
      const t = w.bestBuiltNear(from[0], from[1], [Zone.Commercial], Infinity, FREIGHT_MAX_SCORE, (c, d) => c.level * 2 + 6 * Math.random() - d / 4, reachable);
      return t && this.spawnVehicle(VehicleKind.Freight, from, [t.x, t.y], null) ? 1 : 0;
    }
    if (job.vkind === VehicleKind.Visitor) {
      const from = job.entry!;
      const score = (t: Building, d: number) => 5 * Math.random() + t.level - d;
      const t = w.bestBuiltNear(from[0], from[1], [Zone.Commercial, Zone.Office], Infinity, VISITOR_MAX_SCORE, score, reachable);
      if (!t) return 0;
      if (this.spawnVehicle(VehicleKind.Visitor, from, [t.x, t.y], null)) return 1;
      // close as the crow flies but not by road: search the roads instead
      const r = findBest(w, from[0], from[1], (x, y) => {
        const c = w.buildings.get(tileKey(x, y));
        return c && (c.zone === Zone.Commercial || c.zone === Zone.Office) && c.level > 0 ? 5 * Math.random() + c.level : null;
      }, VISITOR_NODES, VISITOR_MAX_SCORE);
      if (r) this.spawnVehicle(VehicleKind.Visitor, from, [r.gx, r.gy], null);
      return 3;
    }
    const b = job.b!;
    if (w.buildings.get(tileKey(b.x, b.y)) !== b || b.level === 0) return 0; // bulldozed or rezoned meanwhile
    const owner = w.parcelAt(b.x, b.y)?.owner ?? null;
    if (job.vkind === VehicleKind.Freight && job.to) {
      // from a harbour to a buyer it chose (sim/harbours.ts); rail freight may take it, as for any works
      const to = job.to, byRail = this.freight?.consign([b.x, b.y], to, owner);
      if (byRail) {
        const v = this.spawnVehicle(VehicleKind.Freight, [b.x, b.y], byRail.yard, owner);
        this.freight!.truckStarted(byRail.id, v?.id ?? null);
        if (v) return 1;
      }
      const v = this.spawnVehicle(VehicleKind.Freight, [b.x, b.y], to, owner);
      if (v) v.fee = job.fee;
      return 1;
    }
    const seaPts = job.vkind === VehicleKind.Freight ? this.ports?.exportPoints() ?? [] : [];
    if (job.vkind === VehicleKind.Freight && (this.motorway || seaPts.length) && Math.random() < EXPORT_SHARE) {
      // an export: the truck takes the goods out to the nearest motorway connection or cargo port and comes back empty
      let best: [number, number] | null = null, bd = Infinity;
      for (const e of this.motorway ? [...this.entries, ...seaPts] : seaPts) { const d = Math.abs(e[0] - b.x) + Math.abs(e[1] - b.y); if (d < bd) { bd = d; best = e; } }
      const v = best && this.spawnVehicle(VehicleKind.Freight, [b.x, b.y], best, owner);
      if (v) { if (v.leg) v.leg.arrive = 'none'; return 1; } // handed over on the junction road, no parking
    }
    if (job.vkind === VehicleKind.Freight) {
      const t = w.bestBuiltNear(b.x, b.y, [Zone.Commercial], FREIGHT_RADIUS, FREIGHT_MAX_SCORE, (c, d) => c.level * 2 + 3 * Math.random() - d, reachable);
      if (!t) return 0;
      // rail freight (sim/rail.ts): when a freight line serves both ends, the truck runs to the nearest yard instead
      const byRail = this.freight?.consign([b.x, b.y], [t.x, t.y], owner);
      if (byRail) {
        const v = this.spawnVehicle(VehicleKind.Freight, [b.x, b.y], byRail.yard, owner);
        this.freight!.truckStarted(byRail.id, v?.id ?? null);
        if (v) return 1;
      }
      if (this.spawnVehicle(VehicleKind.Freight, [b.x, b.y], [t.x, t.y], owner)) return 1;
      const r = findBest(w, b.x, b.y, (x, y) => {
        const c = w.buildings.get(tileKey(x, y));
        return c && c.zone === Zone.Commercial && c.level > 0 ? c.level * 2 + 3 * Math.random() : null;
      }, FREIGHT_NODES, FREIGHT_MAX_SCORE);
      if (r) this.spawnVehicle(VehicleKind.Freight, [b.x, b.y], [r.gx, r.gy], owner);
      return 3;
    }
    // patrol or call-out: any building within SERVICE_RADIUS (square) of the station
    const inArea = (x: number, y: number) => Math.abs(x - b.x) <= SERVICE_RADIUS && Math.abs(y - b.y) <= SERVICE_RADIUS;
    const t = w.bestBuiltNear(b.x, b.y, null, 2 * SERVICE_RADIUS, PATROL_MAX_SCORE,
      (c, d) => (c !== b && inArea(c.x, c.y) ? 6 * Math.random() - d : null), reachable);
    if (!t) return 0;
    const emergency = job.vkind !== VehicleKind.Patrol;
    if (this.spawnVehicle(job.vkind, [b.x, b.y], [t.x, t.y], owner, emergency)) return 1;
    const r = findBest(w, b.x, b.y, (x, y) => {
      if (!inArea(x, y)) return null;
      const c = w.buildings.get(tileKey(x, y));
      return c && c.level > 0 && c !== b ? 6 * Math.random() : null;
    }, PATROL_NODES, PATROL_MAX_SCORE);
    if (r) this.spawnVehicle(job.vkind, [b.x, b.y], [r.gx, r.gy], owner, emergency);
    return 3;
  }

  /** Everyone who should be drawn: travelling citizens and vehicles on the road. */
  *agents(): Iterable<{ id: number; x: number; y: number; state: number; mode: number; kind: number; cls: number; queued: boolean; emergency: boolean; stage: number; bag?: boolean; rev?: boolean; ind?: number; under?: boolean; extra?: number }> {
    for (const c of this.w.citizens.values()) {
      if (c.state === S.Home || c.state === S.Work) continue;
      if (c.leg?.lift) continue; // in someone's car, or waiting for it to set off (sim/carpool.ts): not drawn
      if (c.leg?.hail) {
        // waiting at the kerb for a taxi: standing there; in it, or waiting indoors for one that comes in at the door: not drawn
        if (this.taxis.waiting(c) === 'kerb') yield { id: c.id, x: c.x, y: c.y, state: c.state, mode: 0, kind: familyOf(c.kind), cls: 0, queued: true, emergency: false, stage: c.stage, bag: c.mig === MIG.In || c.mig === MIG.Out, extra: studyFlag(c) };
        continue;
      }
      if (c.leg?.ride) {
        // on board: inside the bus, not drawn; at the stop: standing in the crowd (queued marks a walker standing still)
        if (this.transit.isRiding(c)) continue;
        // on a metro platform: below ground (CITIZEN_UNDER), drawn only by the underground view
        yield { id: c.id, x: c.x, y: c.y, state: c.state, mode: 0, kind: familyOf(c.kind), cls: 0, queued: true, emergency: false, stage: c.stage, bag: c.mig === MIG.In || c.mig === MIG.Out, under: this.transit.isUnder(c), extra: studyFlag(c) };
        continue;
      }
      const drive = !!c.leg?.drive;
      if (drive && c.lane < 0) continue; // waiting in the garage for a gap
      yield { id: c.id, x: c.x, y: c.y, state: c.state, mode: drive ? 1 : 0, kind: familyOf(c.kind), cls: drive ? c.cls : 0, queued: drive && c.wait > 1, emergency: false, stage: c.stage, bag: c.mig === MIG.In || c.mig === MIG.Out, ind: drive ? indicatorOf(c, false) : 0, extra: studyFlag(c) };
    }
    for (const v of this.w.vehicles.values()) {
      if (v.phase === 'dwell' ? !v.call : v.lane < 0 && !v.weave) continue; // a fire engine at a fire (sim/fires.ts) is drawn parked at the kerb
      if (v.vkind > FLEET_VKIND) { const a = this.mobile.agentOf(v); if (a) yield a; continue; } // taxis, riders, bin lorries (sim/mobile.ts)
      const rev = v.cls === VehicleClass.Bus && this.traffic.reversing(v);
      yield { id: v.id, x: v.x, y: v.y, state: v.phase === 'back' ? S.ToHome : S.ToWork, mode: 1, kind: v.vkind, cls: v.cls, queued: v.wait > 1, emergency: v.priority, stage: 0, rev, ind: indicatorOf(v, rev) };
    }
  }

  // ---- economy -----------------------------------------------------------------

  private payWage(c: Citizen) {
    const w = this.w;
    const wb = w.buildings.get(tileKey(c.wx, c.wy));
    if (!wb) return;
    const wage = wageOf(c.kind, wb.level) * wageMul(c, c.kind) * (c.shiftLen / (8 * TPH)); // by education in a skilled place (sim/skills.ts)
    const parcel = w.parcelAt(c.wx, c.wy);
    const rate = parcel ? parcel.taxRate : 0;
    const tax = wage * rate;
    c.money += wage - tax;
    noteIncome(c, wage - tax, w.tick);
    if (c.appr !== undefined) this.learning.shift(c, wage); // an apprentice's day on the job (sim/learning.ts)
    if (!parcel) return;
    if (isCivicId(c.kind) && !isLeisure(c.kind)) w.payroll(parcel.owner, wage); // public payroll (part grant-funded); leisure venues pay staff from their takings
    w.credit(parcel.owner, tax);
    parcel.stats.taxToday += tax;
    w.dirtyParcels.add(parcel.id);
    if (rate > 0.2 && Math.random() < (rate - 0.2) * 0.5) w.quitJob(c); // high income tax: look elsewhere
  }

  private payHomeTax(c: Citizen) {
    const w = this.w;
    const parcel = w.parcelAt(c.hx, c.hy);
    if (!parcel) return;
    const tax = HOME_TAX_BASE * parcel.taxRate;
    if (c.money < tax) { this.leaveTown(c); return; } // can't afford to live here any more
    c.money -= tax;
    noteSpend(c, tax, w.tick);
    w.credit(parcel.owner, tax);
    parcel.stats.taxToday += tax;
    w.dirtyParcels.add(parcel.id);
    // services make high taxes bearable, and so do parks and places to go
    const tolerance = 0.25 + 0.05 * this.coverage(c.hx, c.hy) + 0.025 * leisureTier(this.leisureCoverage(c.hx, c.hy).score);
    if (parcel.taxRate > tolerance && Math.random() < parcel.taxRate - tolerance) this.leaveTown(c);
  }
}
