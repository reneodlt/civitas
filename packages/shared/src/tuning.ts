/**
 * Traffic tunables, read at their use sites so an offline A/B run
 * (server/src/loadtest/ab.ts --set name=value,...) can change them without
 * editing code. The values here are the defaults the live game runs with;
 * docs/traffic-tuning.md has the matrix they were chosen from (ab.ts `old=1`
 * restores the rules as they were before it). Change them only before a world
 * is built: a few are cached (signal timing per junction). Flags are numbers
 * (0 / 1 / mode) so every knob parses the same way.
 */
export const TRAFFIC_TUNING = {
  // ---- the stuck rule -------------------------------------------------------------------
  /** Ticks a driver may go without progress before the stuck rule kicks in (0: never). */
  stuckLimit: 60,
  /**
   * How "without progress" is counted: 0 every stopped tick on the whole leg (a long commute through a few red
   * lights ran out of it without ever being jammed); 1 ticks since the car last reached a new tile.
   */
  stuckClock: 1,
  /**
   * At the stuck limit: 0 give up at once (citizen home, vehicle removed); 1 re-route around the blocked tile and keep
   * driving (abandonAfter); 2 give up only when clear of any junction box, a driver parking at the kerb and walking on
   * and a vehicle being withdrawn (home only as a last resort, after twice the limit); 3 the old give-up but never inside
   * a junction box; 4 as 0 outside a box, while a car stuck inside one has the first car clear of every box along the
   * chain holding it up released instead (itself only after three times the limit). See docs/traffic-tuning.md for why 0.
   */
  stuckReroute: 0,
  /** Ticks without progress after which a driver looks for a way round the blocked exit (then every 25 ticks; 0: only at the stuck limit). */
  rerouteAt: 0,
  /** With stuckReroute 4, a citizen who gives up parks at the kerb and walks on when there is a lot beside the car (otherwise goes home). */
  stuckKerb: 0,
  /** With stuckReroute 1, ticks stuck past the limit before the trip is abandoned (0: never). Never while inside a junction box. */
  abandonAfter: 0,

  // ---- re-routing on cumulative delay (Simulation.maybeReroute; docs/traffic-tuning.md) ----------------
  /**
   * 1: besides the driver at a standstill, one whose drive leg has taken much longer than expected at departure also
   * looks for another way at the re-route cadence, even while creeping rather than stopped (walkers: never).
   */
  delayReroute: 0,
  /** Running late: elapsed time on the leg exceeds the expected time (route cost at departure at free-flow speed) by this share ... */
  delayFrac: 0.4,
  /** ... and by at least this many ticks. */
  delayMinTicks: 20,
  /** A* node budget of a late driver's search (a held-up driver's stays at 4000). */
  delayNodes: 12000,
  /** A late driver takes the new route only when it costs less than this share of the rest of the current one (a held-up driver's is 0.85). */
  delayGain: 0.85,
  /** Most re-routes for lateness per leg. */
  delayMax: 3,
  /** Ticks after a driver's re-route search before it may search again (forced re-routes: 10). */
  rerouteCooldown: 50,
  /** A* node budget of a held-up driver's re-route search (a late driver's is delayNodes). */
  rerouteNodes: 4000,

  // ---- two-wheelers (delivery bikes and mopeds, docs/mobile-jobs.md) -------------------------------------------------
  /**
   * A bike and a car filtering past each other in a lane while either is turning: 1 the body guard holds them as any two
   * vehicles; 2 only the bike gives way (a car is never held by a bike, so the two never wait for each other); 0 they
   * filter through turns too.
   */
  bikeTurnGuard: 1,

  // ---- signals (signalT, signalPeriod and signalAmber are shared with the client, which draws the same phase) -------
  /** Lights at T-junctions as well as crossroads (1) or only at four-arm junctions (0). */
  signalT: 1,
  /** Ticks per signal phase, before each junction's own ±20%. */
  signalPeriod: 15,
  /** Amber ticks at the end of each green. */
  signalAmber: 2,
  /** 1: hold a green while nobody waits on red and someone waits on green, up to 2× the period (server-side only: the client would not show it). */
  signalActuated: 0,

  // ---- junctions (R4, docs/roads.md "Junctions"; 0 restores R3's rule for each, for ab.ts) --------------------------
  /**
   * 1: the junction tiles of one avenue crossing work as one junction (shared/src/signals.ts junctionGroup): one
   * controller timed from the group's anchor, the lights gating only cars coming in, a four-phase cycle with protected
   * lefts where two divided roads cross. 0: every tile its own junction, as in R3. 2: groups, but two phases everywhere
   * (lefts permitted, giving way; for ab.ts only: the client draws the four phases).
   */
  groupSignals: 1,
  /** A four-phase group's protected left phase, as a share of its through phase (shared with the client: signals.ts leftTicks). */
  leftPhase: 0.5,
  /** A two-tile group's green for the avenue's axis, as a share of the cycle (shared with the client: signals.ts groupPhaseOf). */
  groupSplit: 0.5,
  /**
   * 1: a car crossing a divided road's reservation may wait in the median box (straddling the edge between the two
   * carriageways' junction tiles, clear of both), one a way at each; 0: it waits in the first carriageway's box (R3).
   */
  medianBox: 1,
  /**
   * Turn lanes on one-way approaches (an avenue's carriageway, a one-way street, a motorway): the last two tiles before a
   * junction hold the lane: 1 the left lane for left turns (and U-turns) only, the right lane for straight on and
   * right; 2 the same at four-phase groups only (protected lefts), elsewhere straight-on traffic may use either; 0 R3's
   * choice (the lane for the next turn within six tiles, straight on in either).
   */
  turnLanes: 2,
  /** A mini-roundabout: an arriving car gives way to a moving car within this many tiles of the box on the arm to its left (0: first come, first served). */
  miniYield: 0.6,
  /**
   * A mini-roundabout's box: 1 one car in it at a time (the brief's model; it carries a third of a give-way crossroads,
   * docs/traffic-tuning.md "Junctions"); 0 the box's own rules, movements that do not cross sharing it.
   */
  miniOne: 0,
  /** A 5×5 roundabout: places round the ring (both lanes) a car coming on must leave free, so it never fills and locks. */
  bigRingSpare: 6,

  // ---- junction entry rules ---------------------------------------------------------------
  /**
   * Same approach, different exit: 0 the follower waits until the leader has left the box; 1 may enter once the
   * leader is past the box centre; 2 (with conflictRemaining) once the rest of the leader's path no longer crosses its own.
   */
  sameApproachRelax: 2,
  /**
   * Who counts as in a box on the way in: 0 a car whose progress is past its stop line (the old test, which a car
   * stopped exactly at the line can pass by rounding, so two cars facing each other each see the other "in the box"
   * and wait for ever); 1 a car that has committed to going in (decided at the stop line), wherever it is.
   */
  boxByCommit: 1,
  /**
   * What a car already in a box blocks: 0 every movement its whole path through the tile conflicts with (the table);
   * 1 only movements that conflict with the part of its path still under or ahead of its rear bumper, so a car
   * waiting at the far edge of a box no longer holds movements its turn crossed earlier.
   */
  conflictRemaining: 1,
  /**
   * 1: stop lines and "clear of the box" are measured along the real path, not in lane-progress units. Progress is
   * a fraction of the lane, and a right-turn arc is only half a tile long, so a car stopped at the old line on a
   * right-hand bend has its nose in the next tile, and a car turning right out of a junction leaves the box later
   * than its progress says.
   */
  arcAware: 1,
  /**
   * Arriving at a building: 0 wait until nothing at all is in its forecourt (the old rule, which deadlocks with a car
   * waiting to pull out of the same building); 1 wait only for movements that cross yours (the conflict table: the
   * in and out lanes of a driveway are straight and a lane apart, so a car pulling out does not block one pulling in).
   */
  forecourtConflict: 1,
  /** Don't block the box: 1 at junctions, 2 at every road tile, enter only when the tile after it will take you too. */
  boxClear: 0,
  /**
   * 1: a car may go into a box past a conflicting car that is standing still there (held up by something else)
   * when its own whole path through the box clears that car's body; the body guard covers that car moving off later.
   */
  passStationary: 0,
  /**
   * 1: a car pulls out (from a building, an entry tile or the kerb) only when nothing else is in that tile's box and no
   * pedestrian is where it would appear; 2 also, out of a building, only when the road tile would let it in, so cars
   * wait in the garage rather than in the forecourt (where they block cars arriving from the building's other side).
   */
  spawnClear: 2,
  /** Ramp metering: a car leaves a building only while the congestion of the road tile outside is below this (0..1; 1: always). */
  meterCongestion: 1,
  /** Lane admission: 0 a fixed count (laneCap); 1 by length, sum of (length + MIN_GAP) of the cars in the lane plus the newcomer within laneRoom. */
  laneByLength: 0,
  laneCap: 2,
  laneRoom: 1.0,
  /** Route cost of a fully congested tile on top of the empty-road cost of 1 (drivers route round jams by this). */
  congestionWeight: 8,

  // ---- pedestrians and crossings ------------------------------------------------------------
  /** Ticks a car waits for pedestrians on the crossing before nosing in when there is a gap (0: never; the body guard keeps it off them). */
  carYieldMax: 15,
  /** Ticks a pedestrian waits at an unsignalled kerb for cars in the box before stepping out anyway (0: never). */
  crossingWaitMax: 20,
  /** 1: cars read only last tick's crossings (one-tick lag); 0: last tick's and this tick's. */
  crossingLag: 1,
  /** 1: a pedestrian waiting at an unsignalled kerb claims the crossing, so no new car enters while the box clears. */
  pedPriority: 0,
  /** 1: at lights a pedestrian never crosses against the red or into a busy box, however long the wait (no hard cap). */
  pedSignalPatient: 1,
  /** Unsignalled crossings: a pedestrian at the kerb lets a car go first once it has waited this many ticks at that tile's stop line (0: never). */
  pedYieldAfter: 0,
  /** 1: a pedestrian steps off the kerb only when the whole crossing ahead is clear of car bodies (so nobody is stranded between stopped cars). */
  pedPathClear: 0,

  // ---- the body guard: last resort behind all of the above ---------------------------------------
  /**
   * 1: a car never moves its body onto a pedestrian ahead of it (it stops short, wherever it is, driveways included),
   * and a pedestrian never steps into a car's body (walking out of one is always allowed).
   */
  bodyGuard: 1,
  /** 1: the guard also keeps cars apart: a car never moves its body into another car's ahead of it (oriented rectangles). */
  carGuard: 1,
  /**
   * The guard also protects bodies as the client draws them, a bit mask: 1 a moving car's body is also tested facing
   * the way it moves this tick (the client draws it facing its motion, not its path tangent, which differs by up to
   * ~35° on a tight turn); 2 a pedestrian also never steps into a car drawn that way; 4 a car pulls out only when
   * nobody stands within its length of the start, whichever way it faces. 7 is all three: about ten times fewer
   * contacts as drawn (what a player sees), for about 20% more give-ups (docs/traffic-tuning.md).
   */
  guardDrawn: 7,
  /** With bodyGuard, pedestrians behind a car's centre: 0 ignored (driving on takes it away from them), 1 the car still never swings its rear onto one. */
  pedBehind: 0,
  /** With bodyGuard, ticks a pedestrian held on a crossing by a car's body waits before stepping back to the kerb (0: never). */
  pedRetreatAfter: 10,
  /**
   * With pedRetreatAfter, 1: a walker steps back from a car body at most once per crossing, waits there until the
   * crossing ahead is clear of car bodies, then goes on (and waits where it stands for any later body); 0: it steps back
   * as often as it is held and forward again the next tick (the old rule: the car's guard still saw it, and it went
   * back and forth until the car got away: docs/traffic-tuning.md "Crossings: the wobble").
   */
  pedRetreatOnce: 1,
  /**
   * With pedRetreatOnce, 1: a car's body guard tests a walker standing where it stepped back to body to body, without
   * its margin, so a car may nose past one beside its lane (never touching it); 0: with the margin, as any walker.
   */
  carPastHeld: 0,
  /**
   * With pedRetreatOnce, 1: a walker standing back on a crossing that a car's body guard stops for steps further back,
   * toward the kerb (always away, never forward again), so it never holds up the car it is waiting for; 0: it stands.
   */
  pedClearWay: 0,
  /** With bodyGuard, ticks a pedestrian held by a car's body waits before walking on anyway (deadlock breaker; 0: never, the stuck rule frees them). */
  guardWaitMax: 0,

  // ---- roundabouts (shared/src/junctions.ts; docs/traffic-tuning.md "Roundabouts and flyovers") ----------
  /**
   * Give way on entry: a car coming onto a roundabout waits while a car already circulating, and moving, is within
   * this many tiles of the entry (0: no give-way, first come first served like a plain junction).
   */
  ringYield: 0.7,
  /**
   * 1: on a ring tile, merging is following: a car already out in the exit lane ahead of me no longer blocks the box
   * (the gap rule keeps the distance), and a car may go in behind one still in the box. 0: the plain junction rules.
   */
  ringMerge: 1,
  /**
   * Speed factor for the turns on to and off a roundabout (a turn at a plain junction slows a car to 0.6 for each
   * half; the ring's own wide corners never slow it). docs/traffic-tuning.md: 0.8 costs about a sixth of the capacity.
   */
  ringSlow: 1,
  /** Places round the ring (lane capacity × 8) a car coming on must leave free, so the ring never fills and locks. */
  ringSpare: 4,

  // ---- smooth flow (docs/traffic-tuning.md "Smooth flow"). Full speed is DRIVE_SPEED, 0.5 tiles a tick -----------
  /**
   * 1: car following with a speed per mover (Mover.v): a driver speeds up by at most `accel` a tick and slows for the
   * car ahead, a turn, a bus halt and (with lookAhead) a stop line it will not be let over, braking at `brake`, so it
   * eases up to a queue instead of stopping dead. The old rule (0) moves min(full speed, gap to the car ahead) each
   * tick: from a stop to full speed and back in one tick. The gap, MIN_GAP, the stop lines, the conflict table and the
   * body guard are hard limits either way.
   */
  follow: 1,
  /**
   * Acceleration, tiles per tick per tick, before the driver's own style (accelVar) and heavyAccel. At 1 a car can be
   * at full speed a tick after it moves off (a tick is 36 game seconds) and a truck or bus in two; anything slower costs
   * the junctions throughput (0.15: 3 speed points, docs/traffic-tuning.md), so the drawing (client render/glide.ts) is
   * what eases a car up to speed.
   */
  accel: 1,
  /** Each driver's acceleration is accel × (1 ± accelVar), from a hash of their id (the same driver every trip). */
  accelVar: 0.25,
  /** Trucks and buses accelerate at this share of a car's rate. */
  heavyAccel: 0.6,
  /** Comfortable braking, tiles per tick per tick: what a driver plans with (harder only when the gap closes unexpectedly). */
  brake: 0.2,
  /**
   * With follow, slow down before a turn, to be at the turn's speed (0.6 of full at a plain junction) as it begins: 1
   * everywhere; 2 only into junctions with lights (at a give-way junction a turning car that slows early gets to the
   * box later and loses its gap to the cross traffic: 1.5 speed points and 6% more give-ups in a town without
   * signals, docs/traffic-tuning.md); 0 never (the turn's speed is taken at once inside the box).
   */
  followTurn: 2,
  /** Time headway, ticks: a driver keeps headway × its speed on top of MIN_GAP to a car ahead that is braking at `brake` too. */
  headway: 0.5,
  /**
   * With follow, a driver standing behind a car that is standing too waits until there is this much room (tiles, beyond
   * MIN_GAP) before moving up, or until that car moves off: a queue closes up in fewer, longer moves rather than
   * shuffling forward one car length every time the front moves (0: always move up at once). Off: 0.9 cut stops by 8%
   * but doubled car–pedestrian contacts as drawn and cost give-ups without lights.
   */
  startGap: 0,
  /**
   * 1: look ahead to the stop line. Within braking distance of it, a driver asks the entry rules whether it would be
   * let in on arrival (the light as it will be then: phases are a pure function of the tick) and brakes for the line
   * only if not, so it glides to a red and rolls on into a green that comes before it gets there. 2: only for what
   * will still be there then (a red or amber light on arrival, barriers, people on the crossing, an exit lane of
   * standing cars), not a car passing through the box now. 3: only the lights and level-crossing barriers. Off: 1 cut
   * dead stops by a quarter more for about 13 more give-ups a peak; 2 and 3 were worse.
   */
  lookAhead: 0,
  /**
   * 1: platoons through junctions. A car following one that went in by the same approach and the same exit, moving and
   * within platoonGap tiles, may go in behind it before it has left the box (the following gap keeps them apart);
   * every other entry rule still applies (the light, crossings, conflicting movements). 2: only at lights (at a give-way
   * junction a platoon holds the box against the cross traffic: a sixth more give-ups in a town without signals).
   */
  platoon: 2,
  platoonGap: 0.6,
  /** the leader of a platoon must be moving at least this fast (tiles per tick) */
  platoonV: 0.1,
  /**
   * Main-road priority at junctions without lights: 1 at T-junctions the side road gives way to cars on the through
   * road (moving, within mainGap tiles of the junction, whose path crosses its own); 2 also at crossroads, where the
   * straighter road (the longer straight run either side) is the main one. Never at lights or roundabouts. Off: within
   * the noise on the Commons (Traffic.roadRank is the hook for road classes).
   */
  mainRoad: 0,
  mainGap: 1.0,
  /** a side-road driver held this many ticks by main-road traffic goes when the box is clear anyway (no starving) */
  minorWaitMax: 20,
  /**
   * 1: green waves. Every light has the same period (signalPeriod, no ±20%) and an offset of −(x + y) / waveSpeed
   * ticks, so a car going east or south at waveSpeed meets each light in the same phase as the last (shared with the
   * client, which draws the same lamps). Everywhere (1): 1.2 speed points worse on the Commons's short blocks. 2 (R4, the default): green waves
   * at junction groups only (the avenues' crossings, shared/src/signals.ts groupTiming), every other light its own.
   */
  greenWave: 2,
  /** the speed a green wave is timed for, tiles per tick */
  waveSpeed: 0.3,

  // ---- traffic control (R5, docs/roads.md "Traffic control") ----------------------------------------------------------
  /**
   * 1: the visitor limit on at every entry (half the visitors come in: VISITOR_LIMIT_SHARE), for ab.ts on a city with
   * no gateway of its own (the Commons' visitors come in at its farthest roads). A player sets it per gateway instead
   * (RoadRule.gw, in the gateway's panel).
   */
  visitorLimit: 0,
};
export type TrafficTuning = typeof TRAFFIC_TUNING;
/** Hard cap on a pedestrian's wait at a signalled crossing: longer than any red. */
export const signalWaitMax = () => 2 * TRAFFIC_TUNING.signalPeriod * (TRAFFIC_TUNING.signalActuated ? 2 : 1);

/**
 * Economy tunables for the first hours of play (docs/early-game-audit.md, "After Gauntlet 3"), read at their use
 * sites. Like TRAFFIC_TUNING they may be overridden for an offline run: the server's ECON env var takes
 * `name=value,...` (server/src/index.ts).
 */
export const ECONOMY_TUNING = {
  /**
   * Share of public-service staff wages (police, fire, health and builders' yards; libraries and other leisure venues
   * pay staff from their takings) that comes out of the owner's treasury; the rest is a regional grant. At 1 a police
   * and a fire station and a yard (31 staff) cost a new player about $400 a day against $115-$360 of tax on days 2-4:
   * the cash cliff (docs/early-game-audit.md).
   */
  civicPayroll: 0.5,
  /**
   * Money that can run out (docs/start-from-zero.md B3, server/src/sim/finance.ts). A player may spend down to
   * -overdraftLimit; anything that would go further is refused. Running costs (wages, upkeep, interest) can still take
   * the treasury past it.
   */
  overdraftLimit: 5000,
  /** Interest on a negative balance, a share of it charged once a game day at midnight (ledger category 'interest'). */
  overdraftInterestPerDay: 0.02,
  /** Midnights in a row below zero before administration: building stops and the regional grant is withdrawn. */
  adminAfterDays: 3,
  /** The recovery plan's "raise tax": every parcel below this rate is set to it (above 0.2 workers start to quit). */
  recoveryTaxRate: 0.2,
  /** The recovery plan's "sell land back": the share of LAND_PRICE_PER_TILE an empty parcel fetches. */
  landBuyback: 0.8,
};
export type EconomyTuning = typeof ECONOMY_TUNING;

/**
 * Land and money on a shared world (docs/multiplayer-land.md section 3, M2; shared/src/land.ts, server/src/sim/land.ts).
 * Frontier starts, sandboxes (test cities, demos), showcases and local mode keep START_MONEY / FRONTIER_MONEY and the
 * flat LAND_PRICE_PER_TILE. Days are game days.
 */
export const LAND_TUNING = {
  /** a new player's treasury on a shared world (instead of START_MONEY) */
  startMoney: 3000,
  /** the free homestead: a new player's first purchase is free when it fits in homestead × homestead tiles; a bigger first purchase pays for the tiles beyond that many */
  homestead: 16,
  /**
   * The price of a tile: base × exp(gain × (land value − 1)), clamped to [min, max] dollars, where the land value is the
   * published value of the 4×4 cell (sim/value.ts) without its green and quiet terms (open country would otherwise be
   * the dearest land of all). Wilderness (land value 1) costs `base`; a busy, well-served street about 1.4 costs ~$7.
   */
  base: 1.5, gain: 4, min: 1, max: 40,
  /** land that shares no edge with yours (an outpost), and a new player's first plot, must be at least this many tiles a side */
  outpostMin: 8,
  /** the empty-land tax: each midnight, this share of the current price of every owned dry tile with nothing on it (no road, zone, building, track or structure) */
  emptyTax: 0.02,
  /** the tax pauses once the owner has not been seen (connected) for this many days */
  awayPauseDays: 3,
  /** an owner away this many days: parcels with no building on them (roads and empty zoned lots at most) go back to the market, the owner paid the current price */
  abandonEmptyDays: 30,
  /** ... and after this many, every other parcel goes to the Commons ('sys') at the current land price. 0: built land is never taken */
  abandonBuiltDays: 60,
};
export type LandTuning = typeof LAND_TUNING;

/**
 * The first five minutes (Audit #1, docs/first-five.md): the pioneer camp's settlers, the starter crew and the camp's
 * turnover. The camp's size and price are catalogue data (shared/src/buildings/camp.ts); the lighter first house is
 * residential level 1's `work` (20, a third of WORK_PER_LEVEL).
 */
export const START_TUNING = {
  /**
   * A new camp's settlers set out at once, due over this many game hours: through the nearest gate on a one-off
   * allowance past its hourly bucket, or with no gate up the road from the nearest road end (server sim/firstfive.ts).
   */
  campWaveHours: 0.75,
  /** With no gate, settlers come from a road end at least this far away (tiles), so they are seen arriving; nearer ones appear in place. */
  campWalkMin: 10,
  /** For this many game days after a player's first builders' yard opens, anyone it hires starts their shift at once. */
  starterCrewDays: 1,
  /** How far (tiles, Manhattan) the starter yard looks for people out of work to hire the moment it opens. */
  starterCrewRadius: 64,
  /** A camp resident whose job is farther than this (tiles, Manhattan) leaves it for the owner's first yard when it opens. */
  starterCrewSwitchDist: 12,
  /** A camp resident's chance per game day of moving into a finished home with room nearby (the camp is a transit camp). */
  campMoveOutPerDay: 0.35,
  /**
   * Followers: while fewer than this many people live on a new player's land and someone there has a job, its homes
   * take newcomers without waiting for a job vacancy anywhere (a settler's family follows a wage). Beyond it the
   * usual rule holds: beds fill while the world has vacant jobs.
   */
  followerBeds: 24,
  /** While the same holds and the world's residential demand is 0, those homes' lots grow as if it were this (growth()'s roll: 12 is a 10% chance a pass). */
  youngDemand: 12,
};
/** What a player may spend: the treasury and the overdraft line (the server's World.spendable; the client's previews). */
export const spendableMoney = (money: number, unlimited?: boolean) => (unlimited ? Infinity : money + ECONOMY_TUNING.overdraftLimit);

/**
 * Issue bubbles and the problems list (server/src/sim/issues.ts, shared/src/issues.ts): when a building or lot counts
 * as stuck, and when it stops. Times are game hours (turned into ticks with TICKS_PER_HOUR at the use site), so the day
 * length can change without changing what the icons mean.
 */
export const ISSUE_TUNING = {
  /**
   * Every building and zoned lot is looked at once per this many game hours, a slice of them each tick (by a hash of
   * the tile), so the cost is spread; the census of residents and staff it reads is taken at the start of each round.
   * A change is seen within two rounds and the problems list goes out at most every problemsHours, so a badge follows
   * its condition within the game hour.
   */
  evalHours: 0.25,
  problemsHours: 0.5,
  /** no builders: a site no builder has come to while builders were at work somewhere, for this long (sites wait out the night) ... */
  noBuildersHours: 1,
  /** ... while no site of its owner's has been worked for that long either and they have no builders' yard: nobody is building
   *  for them. A site in the queue behind its owner's own crew is not stuck (a new town zones dozens of lots for two builders)
   *  unless it waits this long */
  noBuildersStuckHours: 48,
  /** unstaffed: staff on shift or on the way under this share of what the roster expects at the hour ... */
  unstaffedShare: 0.5,
  /** ... for this long (shift changes and jittered starts never last that long) ... */
  unstaffedHours: 1,
  /** ... when the roster expects at least this many at work (closed hours say nothing). It clears as soon as enough are
   *  there, or once new hires fill unstaffedShare of the places, who then get this long to turn up for a shift */
  unstaffedMinExpected: 1,
  unstaffedGraceHours: 24,
  /** full parking: drivers this building turned away who found no lot in reach and parked at the kerb, a decaying count ... */
  parkingFullAt: 6,
  /** ... with this half-life in game hours; the icon goes below parkingClearAt, or at once when parking in reach grows */
  parkingHalfLifeHours: 12,
  parkingClearAt: 2,
  /** no customers: a shop or staffed venue standing all of yesterday with no visitor yesterday and none yet today */
  noCustomersDays: 1,
  /** very unhappy: residents' mean happiness under this; clears above unhappyClear (hysteresis) ... */
  unhappyBelow: 30,
  unhappyClear: 38,
  /** ... in a home standing this long (newcomers arrive broke, jobless and friendless; that is not a problem yet) ... */
  unhappyGraceHours: 24,
  /** ... and this far under its owner's town mean: the outliers, unless the whole town is under unhappyTownBelow */
  unhappyMargin: 8,
  unhappyTownBelow: 25,
  /** 1: the Commons' own buildings get icons too outside sandboxes (its queue of sites would otherwise crowd the start) */
  commons: 0,
};
export type IssueTuning = typeof ISSUE_TUNING;

/**
 * Public roads (docs/multiplayer-land.md section 8, M3; server/src/sim/publicroads.ts): road laid on unclaimed land since
 * M3 remembers who laid it (World.publicRoads), and that player pays its upkeep at its class's rate, ledger line
 * 'roads'. Days are game days.
 */
export const PUBLIC_ROAD_TUNING = {
  /** A public road tile with no traffic and nothing built beside it for this many whole days reverts to plain ground (no refund). */
  fadeDays: 5,
  /** Adopted: other owners' citizens or vehicles were seen on it on this many ... */
  adoptDays: 3,
  /** ... of the last this many days (at most 30). The builder stops paying and nobody pays (M4: the regional fund). */
  adoptWindow: 5,
  /** Traffic on public road tiles is sampled every this many ticks (moving citizens and vehicles; TICKS_PER_HOUR is 100). */
  sampleTicks: 20,
  /**
   * A public road tile other players' traffic used in the adoption window may not be bulldozed when the way round
   * between its ends is more than this much dearer (route cost, about a tile of street each) than through it.
   */
  protectDetour: 16,
  /** The protection's breadth-first searches give up after this many road tiles and count the land as linked. */
  reachMax: 20000,
};
export type PublicRoadTuning = typeof PUBLIC_ROAD_TUNING;

/**
 * What the weather does to the simulation (docs/weather.md W4, shared/src/weatherfx.ts). Every effect reads
 * `weatherFor(seed, tick)` (W1's `weatherAt`, or a forced condition in a test) and is 1 / 0 in mild dry weather, so a
 * clear day plays as before. Numbers are multipliers unless named otherwise; "wet" is rain intensity 0-1 (rain or snow).
 */
export const WEATHER_TUNING = {
  // ---- mode choice: the walk's perceived cost (transit and taxi choice weigh it against the bus, the taxi and the car)
  /** the walk costs (1 + this × rain) in rain ... */
  walkRain: 1.2,
  /** ... and (1 + this × intensity) in falling snow, plus this × lying snow */
  walkSnow: 1.5, walkSnowCover: 0.6,
  /** ... plus this per degree below coldFrom (C), at most coldMax */
  walkCold: 0.04, coldFrom: 6, coldMax: 0.5,
  /**
   * in the wet a car owner may drive a trip of driveMinWet tiles or more (DRIVE_MIN_TILES otherwise): the share who do is
   * wetDrive × (walk cost − 1), by a personal hash (some always take the car when it rains, some never)
   */
  driveMinWet: 2, wetDrive: 0.5,

  // ---- road speed and collisions (sim/traffic.ts leg and horizon)
  /** road pace at full rain (scaled by intensity, from 0 at light rain 0.15) */
  speedRain: 0.9,
  /** road pace on lying snow (full cover; scaled by cover) where the road is not gritted (no gritters yet: W6) */
  speedSnow: 0.75,
  /** road pace in thick fog (scaled by fog over 0.3) */
  speedFog: 0.9,
  /** collision rate (a hook: no road collisions are simulated yet, docs/incidents.md): × (1 + this × factor) */
  crashRain: 0.5, crashSnow: 1.5, crashFog: 0.8,

  // ---- leisure (Simulation.pickLeisure): a place's outdoor share (LeisureSpec.outdoor) takes the outdoor factor
  /** outdoor appeal × (1 − this × rain) ... */
  outdoorRain: 0.75,
  /** ... × (1 − this per degree below outdoorCold C, at most 0.6) ... */
  outdoorCold: 0.05, outdoorColdFrom: 10,
  /** ... × (1 − this) in the dark (the sun below the horizon) ... */
  outdoorDark: 0.35,
  /** ... and × (1 + this) on a warm dry day (warmFrom C or more, little cloud, no rain) */
  outdoorWarm: 0.35, warmFrom: 18,
  /** indoor appeal × (1 + this × rain) in the evening (wet nights fill cinemas, theatres and halls) */
  indoorWetNight: 0.4,

  // ---- utilities (sim/utilities.ts solve)
  /** power demand + this share per degree below heatFrom C (electric heating; at most heatMax) */
  heatPerDeg: 0.012, heatFrom: 14, heatMax: 0.3,
  /** power demand + this share per degree above coolFrom C (fans and air conditioning; at most coolMax) */
  coolPerDeg: 0.025, coolFrom: 22, coolMax: 0.3,
  /** street lighting: units an hour per road tile a node reaches, in full dark (dusk and dawn shade it; thick fog lights it by day) */
  lampUnits: 0.02,
  /** wind turbines: output × min(windMax, wind speed / the world's mean wind (windRef tiles per game hour without one)); feathered (0) when gusts pass windCutout */
  windRef: 10, windMax: 1.5, windCutout: 40,
  /** overhead-line faults × this in a storm (buried cable and nodes: half of it); W6 does the big storms */
  faultStorm: 3,

  // ---- mood (life.ts happinessParts)
  /** a sunny warm day: + up to this many points (sun up, cloud under 0.4, dry, moodWarmFrom C or more; the full lift 4 degrees warmer) */
  moodSun: 3, moodWarmFrom: 15,
  /** a grey spell: − up to this many points when more than greyFrom of the last greyHours game hours were grey (cloud over 0.8, rain over 0.15 or fog over 0.5) */
  moodGrey: 3, greyFrom: 0.75, greyHours: 72,

  // ---- transport (sim/airports.ts, sim/ferry.ts, sim/harbours.ts)
  /** flights and boats are held while fog is over this or a storm blows; a landing held longer than holdMaxHours is diverted */
  holdFog: 0.6, holdMaxHours: 4,

  // ---- construction (Simulation.workSite)
  /** site work × this in frost (at or below 0 C, or lying snow over 0.3) and × heavyRainBuild in rain over heavyRain */
  frostBuild: 0.7, heavyRainBuild: 0.8, heavyRain: 0.75,
};
export type WeatherTuning = typeof WEATHER_TUNING;
