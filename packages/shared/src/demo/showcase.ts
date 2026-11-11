import { KIND_ID, MANIFEST, type KindToolId } from '../buildings/compiled';
import { MOTORWAY_KIND } from '../gateways';
import { ZONE_COST, MAX_PARCEL_EDGE } from '../constants';
import { RANKS } from '../ranks';
import type { KindManifest } from '../buildings/schema';
import type { Tool } from '../protocol';
import { STOP_KINDS, TRANSIT, type TransitMode } from '../transit';
import { METRO, isTunnel, isPlatform, underMask } from '../metro';
import { placedFromDoor, footprintOf, FRONT, FRONT_NAMES, type Placed } from '../structures';
import { kindManifest, CIVIC_COST } from '../tile';
import { streetClashes, type StreetRun } from '../streets';
import { techFor, TRACK_NAMES } from '../tech';
import { VALUE_NAMES, VALUE_COUNT, topValues, valuesOf } from '../motivation';
import { RUNWAY_COST, RUNWAY_MIN, RUNWAY_MAX, TERMINAL_ROW } from '../airport';
import { RAIL_COST, CROSSING_COST } from '../rail';
import { ROUNDABOUT_COST, FLYOVER_COST, MINI_ROUNDABOUT_COST, BIG_ROUNDABOUT_COST, INTERCHANGE_COST, isMiniAux } from '../junctions';
import { TURN_RULE_COST, PELICAN_COST, ARM_WORDS, STREET_RULE_DEFS, STREET_RULE_BY_ID, StreetRule, ZONE20_SPEED, VISITOR_LIMIT_SHARE, type ArmState, type StreetRuleId, type RoadRuleDTO } from '../roadrules';
import { junctionGroup } from '../signals';
import { BRIDGE_TILE_COST, BRIDGE_MAX_SPAN, BRIDGE_STYLE_NAMES, BridgeStyle, isBridgeAux, bridgeStyle, bridgeSpanAt, basculeSeed, basculeLiftAt } from '../bridges';
import { isCrossing } from '../rail';
import { GROW_FORMS, firstLevelOf } from '../zones';
import { capacityOf, isGrowableId, terrainOf, Terrain } from '../tile';
import { PLANE_TYPES, timetable, type PlaneType, type Airport } from '../flights';
import { heliTimetable, type Pad, type PadKind } from '../helicopters';
import { newsHelisAt } from '../newsHelis';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../constants';
import { boatTimetable, boatLifts, type BoatType, type BoatHarbour } from '../boats';
import { FERRY } from '../ferry';
import { HARBOUR_OF, type HarbourRole } from '../harbours';
import type { SeaGate } from '../waterways';
import { londonSections, LONDON_TOUR, LONDON_VIEW } from './london';
import { cityScenario, type CityDemo } from './citydemo';
import { PARIS, PARIS_TOUR, PARIS_VIEW } from './city-paris';
import { NEW_YORK, NEW_YORK_TOUR, NEW_YORK_VIEW } from './city-new-york';
import { SAN_FRANCISCO, SAN_FRANCISCO_TOUR, SAN_FRANCISCO_VIEW } from './city-san-francisco';
import { withKindsTour, KIND_TOUR_IDS, LONDON_EXEMPT, CITY_DEMO_GROUPS } from './london-kinds';
import { isCabOffice, isFoodVenue, isWasteDepot, isCourierDepot, TAXI, FOOD, REFUSE, COURIER, MOBILE } from '../fleet';
import { zoneOf, levelOf, Zone, isRoad } from '../tile';
import { isMarkedJunction, mouthCrossing, MouthCrossing, boxJunction, sandboxSignalled, streetTreeAt, midZebraAt } from '../roadlook';
import { signalArms } from '../signals';
import { ROAD_CLASS_DEFS, RoadCls, CDIRS, auxClass, auxDir, oneWayDir, isMotorwayAux, isPedestrianAux, isDividedAux, auxJunction, isRingClassAux, isDeckClassAux } from '../roadclass';
import { SCHOOL_SPECS, STAGES, Study, schoolTakes } from '../education';
import { FIRE } from '../fires';
import { DEATH } from '../remembrance';
import { AD_SIZE, AD_SIZES, type AdSize } from '../buildings/adslot';
import { UTIL, type LinkMode } from '../utilities';
import { AD } from '../adverts';
import { withTourSound, tourSoundProblems, type TourSound } from './tourSound';

/**
 * Demo maps (docs/demo.md): a planned, lived-in town where every large object in the catalogue is placed once and
 * running, for showing the game and teaching it. This file is the scenario as data. The server's demo seeder
 * (server/src/demo/seed.ts) builds it through the same planners players use; the client's tour panel
 * (client/src/tour.ts) flies the camera through it in `TOUR` order; `npm run demo:check` fails when a placeable kind,
 * a size-ladder rung, a linear surface, a line mode or a registered feature (SHOWCASE_FEATURES) is missing from it.
 *
 * Geometry. The town is a 3×3 grid of Commons-style districts (`seedCity`, 22×22 tiles, roads every 5 tiles, zones
 * pre-built to level 3) spanning x and y from -35 to 34, with the perimeter roads on x = -35 and 34, y = -35 and 34.
 * Districts are A1 (north-west) to C3 (south-east), rows A-C north to south. Inside a district, a block is the 4×4 of
 * lots between roads; block (bi, bj) of the district at (X0, Y0) covers x X0+1+5bi..X0+4+5bi and the same in y.
 * Sections clear the blocks they use and place their objects there; rail, freight and the airport sit on extra land
 * outside the perimeter, where no road crosses the track or the runway.
 *
 * Coordinates are world tiles, y growing south. A placement names its catalogue kind (string id), the tile a player
 * would click (the door) and its rotation (FRONT order: 0 the door faces +y/south, 1 east, 2 north, 3 west).
 */

export type SectionId = 'downtown' | 'roads' | 'transport' | 'civic' | 'rail' | 'leisure' | 'airport' | 'industry' | 'riverside' | 'harbour' | 'education' | 'high-street' | 'media' | 'power' | 'remembrance'
  | 'london-areas' | 'london-landmarks' | 'london-education' | 'london-kinds' | 'london-rail' | 'london-buses' | 'london-river' | 'london-roads' | 'london-tube'
  // a sample city on the city-map kit (citydemo.ts): each city's own, built from its CityDemo
  | 'city-areas' | 'city-landmarks' | 'city-transit' | 'city-roads';
export type DemoId = 'showcase' | 'transport' | 'leisure' | 'civic' | 'london' | 'paris' | 'new-york' | 'san-francisco';
export type DemoXY = readonly [number, number];
/** x, y, width, height in tiles */
export type DemoRect = readonly [number, number, number, number];

export interface DemoPlacement {
  /** unique in the scenario; defaults to the kind id. Tour order refers to it */
  id?: string;
  /** catalogue kind id ('stadium', 'rail-station', 'bus-stop', ...) */
  kind: string;
  /** the tile a player clicks: the door of a structure, the tile itself for a 1×1 */
  door: DemoXY;
  /** FRONT order; required for multi-tile kinds */
  rot?: 0 | 1 | 2 | 3;
  /**
   * The level it stands at, for a merged lot (zones.ts GROW_FORMS: a zone kind bigger than 1×1 that growth assembles,
   * never placed by a player): the seeder builds it on lots of its zone as growth would. Default its first level.
   */
  level?: number;
  /**
   * A stop's or harbour's name (World.setStopName at the door): a metro station's, shown on the platform, the Tube map
   * and the tooltips; a ferry pier's, on the river bus line; any harbour's, for its boats and tooltip (sim/harbours.ts)
   */
  name?: string;
  /** the hour of the day the tour shows this stop at (the client pins the light while the stop is up): 21.5 for the Lights at night */
  hour?: number;
  /** a resting place (docs/remembrance.md): this share of its plots seeded with the long dead after the fill (server demo/seed.ts seedDemoGraves) */
  graves?: number;
  /** how far round from straight in front of the door the tour's camera stands (radians, + to the right; default 0.45): towards a big screen's curve */
  aside?: number;
  /** the tour's camera this much nearer (a factor on its distance, at least 13 tiles), for a low landmark among towers */
  zoom?: number;
}
/** `level`: what the lots stand at (default the town's, DEMO_TOWN.built) */
export interface DemoZone { zone: 'residential' | 'commercial' | 'industrial' | 'office'; rect: DemoRect; level?: number }
/** a runway dragged from `from` to `to` (shared/src/airport.ts planRunway) */
export interface DemoRunway { id: string; from: DemoXY; to: DemoXY }
/** railway track: each drag as a player makes it (rail.ts trackDragPath: the longer axis first, one corner) */
export interface DemoTrack { id: string; name: string; drags: readonly (readonly [DemoXY, DemoXY])[] }
/** a power trunk link (docs/utilities.md section 4.2) dragged as the pylon or cable tool drags it (rail.ts trackDragPath), from a plant or node door to another */
export interface DemoUtilLink { id: string; name: string; mode: LinkMode; from: DemoXY; to: DemoXY }
/**
 * A road bridge (bridges.ts planBridge) whose deck runs from `from` to `to`, both water tiles in a line, with road on
 * the banks beyond them. `style` forces the style (else the tool's choice); `landmark` is the catalogue landmark a
 * bascule span is drawn as (Tower Bridge), which then counts as placed in the city's demo.
 */
export interface DemoBridge { id: string; name: string; from: DemoXY; to: DemoXY; style?: keyof typeof BridgeStyle; landmark?: string }
/**
 * A junction tool clicked at `at` (junctions.ts, roadrules.ts): a roundabout (the 5×5 two-lane ring when `at` is an
 * avenue's junction) or flyover on the junction (a flyover's deck carries the `deck` road), a mini-roundabout, an
 * interchange on the motorway, a turn rule on the arm tile `at` (set to `rule`), a signal crossing on the street tile.
 */
export interface DemoJunction {
  id: string; tool: 'roundabout' | 'flyover' | 'miniroundabout' | 'interchange' | 'turnrule' | 'pelican'; at: DemoXY; deck?: 'ew' | 'ns'; rule?: ArmState;
  /** a tour stop of a city demo's own (London): its title and caption, the area framed and the tile asked about, and `big` for a 5×5 roundabout */
  name?: string; blurb?: string; rect?: DemoRect; inspect?: DemoXY; big?: boolean;
}
/** A tour stop on something that is neither a kind nor a drag (a level crossing, the river): its caption is SPOT_CAPTIONS[spot]. */
/** `view`: the tour turns the underground view ('under') or the world map ('map', docs/world-map.md) on at this stop */
/** `view` 'ranks': the stop plays a rank-up celebration over the rect (client ranks.ts preview, docs/ranks.md) */
/** `row`: a 'fire-spread' spot's homes, the lead first, which catch light one after another (server sim/fires.ts rows) */
/** `funeral`: a 'funeral' spot's funeral director and the resting place its pretend funerals go to (server sim/death.ts drills) */
/** `hour`: the tour shows the spot at this hour of the day (a blackout after dark, the TV stop in the evening, when sets are on) */
export interface DemoSpot { id: string; spot: SpotKind; name: string; rect: DemoRect; inspect?: DemoXY; view?: 'under' | 'map' | 'ranks' | 'tv' | 'traffic'; row?: readonly DemoXY[]; hour?: number; funeral?: { from: DemoXY; to: DemoXY }; /** the caption, in place of the spot kind's (a city demo's own words) */ blurb?: string }
/**
 * A street rule the scenario sets (R5, shared/src/roadrules.ts StreetRule), as the Street rules tool does: on the whole
 * street through `at` (east-west unless `ns`), or with `to` on the drag from `at` to `to` (part of a street).
 */
export interface DemoStreetRule { id: string; rule: StreetRuleId; name: string; at: DemoXY; ns?: boolean; to?: DemoXY; rect: DemoRect; inspect: DemoXY; /** the caption, in place of the rule's (a city demo's own words) */ blurb?: string }
/** Land parcels (by their `land` names, any section's) combined into one estate by the players' rule (parcelops.ts planCombine) */
export interface DemoEstate { name: string; lands: readonly string[] }
export interface DemoLine {
  id: string; mode: TransitMode; number: number; colour: number;
  /** stops in calling order: bus stop tiles or station doors */
  stops: readonly DemoXY[];
  loop: boolean; vehicles: number;
  /** a rail line calling only at freight yards */
  freight?: boolean;
  /** the line's name ("Central"), shown in place of its number (metro lines) */
  name?: string;
}
/**
 * grown land the tour stops at: a block of a zone, not placed (zones grow by themselves). `inspect` is a lot on the
 * block's edge: the four inner lots of a seedCity block have no road beside them and stay empty.
 */
export interface DemoBlock {
  id: string; kind: string; name: string; rect: DemoRect; inspect: DemoXY;
  /** the tour caption, in place of the kind's blurb (a named area of a sample city) */
  blurb?: string;
  /** how it comes about, in place of the kind's howTo */
  how?: string;
}
/**
 * A road of a class laid by a scenario (DemoSection.classRoads): `cls` a RoadCls id, the drag from `from` to `to`; or
 * `path`, every tile of a drag with corners (London's arterials, laid as one drag so an avenue's twin row follows it round
 * every corner, as the road tool lays a drag's twin: roadclass.ts twinRow), from `from` to `to`.
 */
export interface DemoClassRoad { cls: number; from: DemoXY; to: DemoXY; path?: readonly DemoXY[] }
export interface DemoSection {
  id: SectionId; name: string; blurb: string;
  /** extra land outside the districts, owned by the town */
  /**
   * extra land outside the districts, owned by the town. `frozen`: its lots stay as seeded (no upgrades, no merging), as
   * it is held by an owner of its own (`sys:<name>`) with every technology but the construction track
   */
  land?: { name: string; rect: DemoRect; frozen?: boolean }[];
  /** blocks cleared to bare ground before anything is placed */
  clear?: DemoRect[];
  /** blocks rezoned (built to the town's level) */
  zones?: DemoZone[];
  /** open water painted into the terrain (a scenario's river: no tool makes water) */
  water?: DemoRect[];
  /** straight road drags as the road tool lays them, on own dry land (bridges are `bridges`, laid after) */
  roads?: readonly (readonly [DemoXY, DemoXY])[];
  /**
   * road drags of a class (shared/src/roadclass.ts), laid after `roads` in this order as the road tool lays them: from
   * `from` to `to`, one corner at most, the drag's row going its way and, for an avenue or a motorway, the twin on its left
   */
  classRoads?: readonly DemoClassRoad[];
  /** names given to streets (shared/src/streets.ts), as an owner renames them: the street through road tile `at` (east-west unless `ns`) */
  streets?: readonly { at: DemoXY; ns?: boolean; name: string }[];
  placements?: DemoPlacement[];
  runways?: DemoRunway[];
  tracks?: DemoTrack[];
  junctions?: DemoJunction[];
  /** R5: street rules (an HGV ban, a bus lane, double yellows, a 20 zone), set after the roads and junctions */
  streetRules?: DemoStreetRule[];
  /** R5: gateways (their doors) with the visitor limit on */
  visitorLimits?: DemoXY[];
  bridges?: DemoBridge[];
  /** power trunk links (docs/utilities.md), laid after the placements they join */
  utilLinks?: DemoUtilLink[];
  lines?: DemoLine[];
  blocks?: DemoBlock[];
  spots?: DemoSpot[];
  estates?: DemoEstate[];
  /**
   * Sea gates (docs/boats.md 2.3): where the scenario's water leaves the playable world. The seeder writes them to
   * World.seaGates; every harbour then derives its sea, grounds and river lanes against them.
   */
  seaGates?: SeaGate[];
}
export interface DemoDef {
  id: DemoId; name: string; blurb: string;
  /** world-launcher slot: the child server listens on TEST_CITY_BASE_PORT + slot (8190 for the showcase) */
  slot: number;
  sections: SectionId[];
  /**
   * the town under the sections: the 3×3 districts of DEMO_TOWN (the default), the London map (london.ts), or a sample
   * city on the city-map kit, named by its id (with `city` its data: citydemo.ts, docs/demo.md "Sample cities and the
   * city-map kit"); set, the home page shows the demo as a city card
   */
  town?: 'london' | 'paris' | 'new-york' | 'san-francisco';
  /** a sample city's map and scenario (citydemo.ts); `town` is its id */
  city?: CityDemo;
  /** tour order, when not TOUR */
  tour?: string[];
  /** the welcome stop's camera, when not the 3×3 town's */
  view?: Pick<TourStop, 'focus' | 'dist' | 'yaw' | 'pitch'>;
  /** The card picture on the home page (client landing.ts), a URL the page can load. Usually leave it out: a file named after the id in packages/client/src/heroes/
   *  (paris.webp, london.jpg; png, svg too; about 960×540) is found by the build. With neither, the page draws a placeholder card from the name and blurb (docs/demo.md, "The home page").
   *  The sample cities and London leave it out: their pictures are heroes/<id>.jpg, 960×540 JPEGs of their opening views (docs/demo.md, "Sample cities and the city-map kit") */
  hero?: string;
}

/** The town under every demo: seedCity options. Deterministic: same seed, same districts, same town. */
export const DEMO_TOWN = { seed: 7, districts: 3, built: 3, gap: 2 } as const;
/** Player id that owns the demo town (seedCity's Commons player). */
export const DEMO_OWNER = 'sys';

// district block helpers, for the rects below (the placements are literal tiles)
const D = (i: number) => -35 + 24 * i;
const block = (di: number, dj: number, bi: number, bj: number): DemoRect => [D(di) + 1 + 5 * bi, D(dj) + 1 + 5 * bj, 4, 4];
/**
 * The power district (docs/utilities.md): open land west of districts B1 and C1, its two roads joining the perimeter road at
 * x = -35, and the two substations in town, on lots beside a street of C1 (the blackout drill's) and of B1.
 */
const POWER_LAND: DemoRect = [-58, 7, 23, 26];
const POWER_SUB_A: DemoXY = [-33, 14], POWER_SUB_B: DemoXY = [-33, 8];
/** the showcase's fire drill home: a level-3 house five tiles from the civic district's fire post (-24, -29), and the stop's frame */
const FIRE_DRILL: DemoXY = [-29, -31];
const FIRE_DRILL_RECT: DemoRect = [-31, -33, 9, 6];
/** the road-look stop (client render/roads.ts): east of downtown, tree-lined streets beside open lots, two box junctions and a mid-block zebra */
const ROAD_LOOK_RECT: DemoRect = [23, 7, 11, 8];
/**
 * The road classes (docs/roads.md "Classes", shared/src/roadclass.ts): open land west of district A1's north half, its
 * streets joining the perimeter road at x = -35. North to south: a pedestrian high street of shops (Cheapside, y -37)
 * that a street ends at; a one-way pair round a block of homes (North and South Parade, y -34 east and y -30 west); an
 * avenue through offices and homes (Kingsway, y -25 west and -24 east), crossed by Market Street (x -48); a motorway from
 * a motorway connection of its own at the west edge (y -21 west and -20 east) that Market Street joins by a slip road,
 * running on into the town's street at y -20 at the perimeter road; and a country lane out to the edge (Hedge Lane, y -18).
 */
export const ROAD_CLASSES_LAND: DemoRect = [-60, -40, 25, 23];
/**
 * The junctions (R4, docs/roads.md "Junctions") on the open land south of the road classes, between the High Street and
 * the power station: Regent Avenue (y -6 west, -5 east) from the perimeter road crossed by Queen's Avenue (x -50 south,
 * -49 north) at a four-phase signalled junction with protected lefts; Mill Road (y 1) crossing Queen's Avenue (a no left
 * turn from the west) and Church Lane (x -55) at a mini-roundabout, with a signal crossing between its shops and homes;
 * Hedge Lane, the country lane, out to the edge from Queen's Avenue. Kingsway's 5×5 roundabout and Market Street's
 * diamond interchange stand in the road classes' own land.
 */
export const JUNCTIONS_LAND: DemoRect[] = [[-60, -13, 25, 9], [-60, -4, 21, 10]];
export const ROAD_CLASS_STOPS = {
  pedestrian: { rect: [-57, -39, 19, 4] as DemoRect, inspect: [-52, -37] as DemoXY },
  oneway: { rect: [-58, -35, 23, 7] as DemoRect, inspect: [-44, -34] as DemoXY },
  avenue: { rect: [-58, -29, 13, 6] as DemoRect, inspect: [-48, -26] as DemoXY },
  motorway: { rect: [-60, -23, 25, 6] as DemoRect, inspect: [-55, -21] as DemoXY },
  lane: { rect: [-60, -11, 11, 3] as DemoRect, inspect: [-56, -10] as DemoXY },
};
/** The R4 junction stops: the avenue × avenue group's rect, the 5×5's, the interchange's, Mill Road's mini-roundabout and signs. */
export const JUNCTION_STOPS = {
  group: { rect: [-54, -9, 9, 8] as DemoRect, inspect: [-50, -6] as DemoXY },
  big: { rect: [-43, -29, 7, 7] as DemoRect, inspect: [-40, -28] as DemoXY },
  interchange: { rect: [-53, -24, 11, 8] as DemoRect, inspect: [-48, -23] as DemoXY },
};
/** the news helicopter's orbit over the drill (shared newsHelis.ts NEWS_HELI.radius), framed from above */
const NEWS_HELI_RECT: DemoRect = [-33, -35, 9, 9];
/**
 * Fires v2 (docs/incidents.md): the spread drill's row, the four homes along the south edge of the civic district's
 * north-west block (the lead by the road at x = -30), and the blast drill's works, the south-east corner lot of the
 * industrial estate's north-west block in district C1, with lots round it on three blocks within two tiles. Both are
 * in reach of fire stations, whose engines are held until the visitor has seen the fire spread or the works blow.
 */
const FIRE_ROW: readonly DemoXY[] = [[-31, -31], [-32, -31], [-33, -31], [-34, -31]];
const FIRE_ROW_RECT: DemoRect = [-36, -35, 8, 7];
const FIRE_BLAST: DemoXY = [-31, 27];
const FIRE_BLAST_RECT: DemoRect = [-35, 23, 9, 9];
/**
 * The high street (docs/adverts.md): a street of two-storey shops west off the perimeter road at y = -15, with a gap here
 * and there (an alley, a car park, a bus shelter) so the posters on the shops' flanks face open ground, two car parks with
 * a roadside billboard, billboards on some flat roofs, a bus shelter with its panel and a building site behind a hoarding.
 * The gaps are picked by the design hashes (designPick, level 2): the shop beside each one carries a poster on the wall
 * facing it. The server's demo seeder (server/src/demo/adverts.ts) opens the site and puts three campaigns up at three
 * wear levels. At its east end, on the corner with the perimeter road, the big screens corner (docs/adverts.md section 9)
 * turns its screens to the junction, two of their six turns rented by the town's campaigns.
 */
export const HIGH_STREET = {
  road: -15, x0: -59, x1: -36, level: 2,
  north: { gaps: [-46, -44, -36], parking: -59, busStop: -45, corner: -37 },
  south: { gaps: [-56, -36], parking: -46 },
  /** the lot left as a building site behind its hoarding */
  site: [-44, -16] as DemoXY,
  rect: [-59, -17, 24, 5] as DemoRect,
};
const HS = HIGH_STREET;
/** the shop lots of one side of the high street: every x from x0 to x1 but the gaps and the car park */
const hsLots = (y: number, gaps: readonly number[], parking: number, busStop?: number, corner?: number): DemoZone[] => {
  const out: DemoZone[] = [];
  for (let x = HS.x0; x <= HS.x1; x++) if (!gaps.includes(x) && x !== parking && x !== busStop && x !== corner) out.push({ zone: 'commercial', rect: [x, y, 1, 1], level: HS.level });
  return out;
};
/** bus line 2's stops (x = -24, beside the x = -25 road): the civic district, the western suburb, the industrial estate */
const LINE_2_STOPS = [-33, -23, -9, -4, 1, 6, 15, 20, 25, 30];
/** blocks of a seedCity district that are not homes (its zone pattern repeats in every district) */
const NON_HOME_BLOCKS: [number, number][] = [[2, 0], [0, 1], [2, 1], [3, 1], [0, 2], [1, 2], [3, 2], [1, 3], [2, 3]];

/**
 * The riverside quarter south of the freight line: a river on rows 44-47 (four wide, the span Tower Bridge's model is
 * drawn for), four streets carried over it on bridges of every style, and a row of ten 4×4 blocks between the river road
 * (y = 49) and y = 54, with a street every 5 tiles from x = -20 to 30, and a row of ten blocks of homes behind them
 * (y = 55-58, a street on y = 59) whose people work in the quarter. The quarter is reached only over the bridges.
 */
const RIVER_ROWS = [44, 47] as const;
const QUARTER_X = Array.from({ length: 11 }, (_, i) => -20 + 5 * i);
const qblock = (i: number, row = 0): DemoRect => [-19 + 5 * i, 50 + 5 * row, 4, 4];
/** the streets that cross the river: from the perimeter road (y = 34) over the railway land to the river road */
const RIVER_BRIDGES: { id: string; name: string; x: number; style: keyof typeof BridgeStyle }[] = [
  { id: 'bridge-girder', name: 'Mill Lane bridge', x: -20, style: 'Girder' }, // over the freight line's level crossing too
  { id: 'bridge-arch', name: 'Stone bridge', x: 5, style: 'Arch' },
  { id: 'bridge-bascule', name: 'Lifting bridge', x: 15, style: 'Bascule' },
  { id: 'bridge-suspension', name: 'Suspension bridge', x: 25, style: 'Suspension' },
];
/** bus line 3's stops: beside the street down to the stone bridge, then the river road's north side out to its dead end at x = 33 */
const RIVER_LINE_STOPS: DemoXY[] = [[6, 40], [12, RIVER_ROWS[1] + 1], [22, RIVER_ROWS[1] + 1], [32, RIVER_ROWS[1] + 1]];
/** The door that puts a structure's footprint's top-left corner at (ax, ay) on that turn. */
function doorAt(kind: string, ax: number, ay: number, rot: 0 | 1 | 2 | 3): DemoXY {
  const k = (KIND_ID as Record<string, number>)[kind], fp = footprintOf(k), [w, h] = rot & 1 ? [fp.h, fp.w] : [fp.w, fp.h];
  for (let y = ay; y < ay + h; y++) for (let x = ax; x < ax + w; x++) {
    const p = placedFromDoor(k, x, y, rot);
    if (p.ax === ax && p.ay === ay) return [x, y];
  }
  throw new Error(`no door puts ${kind} at (${ax}, ${ay})`);
}
/** A merged lot (docs/buildings.md "Merged lots") with its footprint's top-left corner at (ax, ay). */
const mergedAt = (kind: string, ax: number, ay: number, rot: 0 | 1 | 2 | 3, level: number): DemoPlacement => ({ kind, door: doorAt(kind, ax, ay, rot), rot, level });

/**
 * The harbour (docs/boats.md section 8), east of the town: the river runs on past the riverside quarter into a basin
 * that opens to the sea in the east (a declared sea gate, SEA_GATE). A quay road (y = 33) runs from the east perimeter
 * road along its north shore: the cargo port's quay is the basin's north edge (row 39), and a bay (rows 36-38) takes
 * the fishing harbour and a ferry pier, each with its back rows over the water and its door on the quay road.
 * On the river between the lifting bridge and the suspension bridge, a pool off the north bank (rows 41-43, as wide
 * as the marina, so the cruises find no dead ends) holds the marina, its door on a spur from the street down to the
 * lifting bridge (x = 15): its sailing yachts and barges, too tall for a closed bascule or the suspension span,
 * cruise out through the lifts (on day 4 of the first week, which demo:check's boat-lift feature holds it to; its
 * place was chosen for that, and for a fleet with every pleasure type). Past the suspension bridge a jetty stands by
 * the river road (row 47), and a pier beside bus line 3's stop at (32, 48) changes with the buses; its river buses run
 * out to the bay.
 */
const QUAY_ROAD = 33;
const BASIN: DemoRect = [45, 39, 51, 17], BAY: DemoRect = [56, 36, 40, 3], POOL: DemoRect = [19, 41, 4, 3];
/** The university quarter's street (east of the town's east road): the campus, halls and institute face it */
const QUARTER_STREET = -26;
const SEA_GATE: SeaGate = { x: 95, y: 47, name: 'the sea' };
const HARBOUR_AT: Record<'jetty' | 'pier-river' | 'pier-bay' | 'marina' | 'fishing' | 'port', DemoPlacement> = {
  jetty: { kind: 'jetty', door: doorAt('jetty', 27, RIVER_ROWS[1], 0), rot: 0, name: 'Quarter Jetty' },
  'pier-river': { kind: 'ferry-pier', door: doorAt('ferry-pier', 30, RIVER_ROWS[1], 0), rot: 0, name: 'Riverside Pier' },
  'pier-bay': { id: 'ferry-pier-2', kind: 'ferry-pier', door: doorAt('ferry-pier', 71, QUAY_ROAD + 1, 2), rot: 2, name: 'Harbour Pier' },
  marina: { kind: 'marina', door: doorAt('marina', POOL[0], POOL[1] - 2, 2), rot: 2, name: 'Lifting Bridge Marina' },
  fishing: { kind: 'fishing-harbour', door: doorAt('fishing-harbour', 58, QUAY_ROAD + 1, 2), rot: 2, name: 'Eastport Fish Quay' },
  port: { kind: 'cargo-port', door: doorAt('cargo-port', 46, QUAY_ROAD + 1, 2), rot: 2, name: 'Eastport Docks' },
};

/** Mobile-job bases on the tour (shared/src/fleet.ts): the door of a cab office, a takeaway, a waste depot and a parcel depot downtown. */
const MOBILE_SPOTS: [MobileSpot, number, number, string][] = [
  ['cab-office', 5, 0, 'Cab office'], ['takeaway', 6, 0, 'Takeaway'], ['waste-depot', 16, 0, 'Waste and recycling depot'], ['parcel-depot', 14, 0, 'Parcel depot'],
];
type MobileSpot = 'cab-office' | 'takeaway' | 'waste-depot' | 'parcel-depot';
/** Does the 1×1 lot at (x, y) of the seeded town hold that mobile-job role? */
const mobileRoleAt = (spot: MobileSpot, x: number, y: number, t: number, a: number) => {
  if (a) return false; // a structure's tile: the roles sit on lots
  const z = zoneOf(t);
  switch (spot) {
    case 'cab-office': return z === Zone.Commercial && isCabOffice(Zone.Commercial, x, y);
    case 'takeaway': return z === Zone.Commercial && isFoodVenue(Zone.Commercial, x, y);
    case 'waste-depot': return z === Zone.Industrial && isWasteDepot(Zone.Industrial, x, y);
    case 'parcel-depot': return z === Zone.Industrial && levelOf(t) > 0 && isCourierDepot(Zone.Industrial, levelOf(t), x, y);
  }
};

export const SECTIONS: DemoSection[] = [
  {
    id: 'roads', name: 'Road classes and junctions',
    blurb: 'One street of every road class, west of the town: a pedestrian high street, a one-way pair, an avenue with a two-lane roundabout, a motorway from its own connection with a diamond interchange, and a country lane out to the edge; south of them the junctions: an avenue crossing with protected left turns, a mini-roundabout, a turn ban and a signal crossing; and the street rules: an HGV ban, a bus lane with its bus line, double yellows and a 20 zone, with the motorway connection\'s visitor limit on.',
    land: [{ name: 'Road classes', rect: ROAD_CLASSES_LAND }, { name: 'Junctions', rect: JUNCTIONS_LAND[0] }, { name: 'Mill Road', rect: JUNCTIONS_LAND[1] }],
    classRoads: [
      { cls: 5, from: [-57, -37], to: [-39, -37] }, // Cheapside, the pedestrian street, first: the streets that meet it end at it
      { cls: 0, from: [-58, -37], to: [-58, -25] }, // the west street, joining the one-way pair and the avenue's end
      { cls: 0, from: [-38, -37], to: [-38, -35] }, // Cheapside's east end to North Parade
      { cls: 2, from: [-57, -34], to: [-36, -34] }, // North Parade, one way east
      { cls: 2, from: [-36, -30], to: [-57, -30] }, // South Parade, one way west
      { cls: 3, from: [-36, -26], to: [-57, -26] }, // Kingsway: the drag's row west at y -26, its twin east at -25
      { cls: 0, from: [-40, -30], to: [-40, -27] }, // Crown Street, from South Parade down to Kingsway's roundabout
      { cls: 4, from: [-57, -20], to: [-36, -20] }, // the motorway: its row east at y -20 (on into the town's street), its twin west at -21
      { cls: 0, from: [-48, -36], to: [-48, -22] }, // Market Street, across both Parades and Kingsway to the motorway, where the interchange takes it over
      // the junctions (R4): Regent Avenue from the perimeter road, Queen's Avenue across it, Mill Road and Church Lane, Hedge Lane
      { cls: 3, from: [-59, -5], to: [-36, -5] }, // Regent Avenue: its row east at y -5, its twin west at -6
      { cls: 3, from: [-50, -12], to: [-50, 4] }, // Queen's Avenue: its row south at x -50, its twin north at -49
      { cls: 0, from: [-59, 1], to: [-41, 1] }, // Mill Road, across Queen's Avenue
      { cls: 0, from: [-55, -4], to: [-55, 4] }, // Church Lane, from Regent Avenue across Mill Road (the mini-roundabout)
      { cls: 1, from: [-51, -10], to: [-60, -10] }, // Hedge Lane, from Queen's Avenue out to the edge
    ],
    zones: [
      { zone: 'commercial', rect: [-57, -38, 19, 1], level: 2 }, { zone: 'commercial', rect: [-54, -36, 6, 1], level: 2 }, { zone: 'commercial', rect: [-47, -36, 9, 1], level: 2 },
      { zone: 'residential', rect: [-57, -33, 9, 3] }, { zone: 'residential', rect: [-47, -33, 11, 3] },
      { zone: 'office', rect: [-57, -29, 9, 3] }, { zone: 'office', rect: [-47, -29, 5, 3] }, { zone: 'office', rect: [-37, -29, 2, 3] },
      { zone: 'residential', rect: [-57, -24, 9, 1], level: 2 }, { zone: 'residential', rect: [-47, -24, 4, 1], level: 2 }, { zone: 'residential', rect: [-36, -24, 1, 1], level: 2 },
      // the junctions' streets: offices on Regent Avenue, homes and shops either side of Mill Road
      { zone: 'office', rect: [-59, -8, 9, 2] }, { zone: 'office', rect: [-48, -8, 12, 2] },
      { zone: 'residential', rect: [-59, -4, 4, 2] }, { zone: 'residential', rect: [-54, -4, 4, 2] }, { zone: 'residential', rect: [-48, -4, 8, 2] },
      { zone: 'residential', rect: [-59, 0, 4, 1] }, { zone: 'residential', rect: [-54, 0, 4, 1] }, { zone: 'residential', rect: [-48, 0, 8, 1] },
      { zone: 'commercial', rect: [-59, 2, 4, 1], level: 2 }, { zone: 'commercial', rect: [-54, 2, 4, 1], level: 2 }, { zone: 'commercial', rect: [-48, 2, 8, 1], level: 2 },
    ],
    placements: [{ id: 'motorway-west', kind: 'motorway', door: [-58, -20], rot: 1 },
      // bus line 4's depot (R5), facing North Parade at the section's west end, so its buses start on their line
      { id: 'bus-depot-parades', kind: 'bus-depot', door: [-56, -35], rot: 0 },
      // bus line 4's stops (R5): two on North Parade's kerb (eastbound, in the bus lane), two on South Parade's (westbound)
      ...([[-54, -33], [-50, -33], [-50, -31], [-55, -31]] as DemoXY[]).map((door, i): DemoPlacement => ({ id: `bus-stop-${31 + i}`, kind: 'bus-stop', door }))],
    // a small loop inside the section (North Parade, Market Street, South Parade, the west street), clear of the town's perimeter road
    lines: [{ id: 'line-bus-4', mode: 'bus', number: 4, colour: 0xc8362e, loop: true, vehicles: 2, stops: [[-54, -33], [-50, -33], [-50, -31], [-55, -31]] }],
    junctions: [
      { id: 'roundabout-big', tool: 'roundabout', at: [-40, -26] }, // on Kingsway: the 5×5 two-lane ring
      { id: 'interchange', tool: 'interchange', at: [-48, -21] }, // Market Street over the motorway
      { id: 'roundabout-mini', tool: 'miniroundabout', at: [-55, 1] },
      { id: 'turn-ban', tool: 'turnrule', at: [-51, 1], rule: 'noLeft' }, // Mill Road's west arm at Queen's Avenue: no left turn
      { id: 'pelican', tool: 'pelican', at: [-45, 1] },
    ],
    // R5 traffic control: an HGV ban on South Parade, a bus lane on North Parade (bus line 4 runs along it), double yellows
    // on Market Street's approach to Cheapside, a 20 zone on Church Lane through the homes, and the motorway connection's
    // visitor limit
    streetRules: [
      { id: 'street-hgv', rule: 'hgv', name: 'HGV ban: South Parade', at: [-57, -30], to: [-36, -30], rect: [-58, -32, 24, 5], inspect: [-44, -30] },
      { id: 'street-bus', rule: 'bus', name: 'Bus lane: North Parade', at: [-57, -34], to: [-36, -34], rect: [-58, -36, 24, 5], inspect: [-44, -34] },
      { id: 'street-yellow', rule: 'yellow', name: 'Double yellows: Market Street', at: [-48, -36], to: [-48, -31], rect: [-51, -38, 7, 9], inspect: [-48, -33] },
      { id: 'street-zone20', rule: 'zone20', name: '20 zone: Church Lane', at: [-55, -4], to: [-55, 4], rect: [-58, -5, 7, 11], inspect: [-55, -2] },
    ],
    visitorLimits: [[-58, -20]],
    streets: [
      { at: [-52, -37], name: 'Cheapside' }, { at: [-44, -34], name: 'North Parade' }, { at: [-44, -30], name: 'South Parade' },
      { at: [-52, -26], name: 'Kingsway' }, { at: [-52, -25], name: 'Kingsway' }, { at: [-37, -26], name: 'Kingsway' }, { at: [-37, -25], name: 'Kingsway' }, // both sides of its roundabout { at: [-48, -32], ns: true, name: 'Market Street' }, { at: [-40, -29], ns: true, name: 'Crown Street' },
      { at: [-44, -5], name: 'Regent Avenue' }, { at: [-44, -6], name: 'Regent Avenue' }, { at: [-50, -2], ns: true, name: "Queen's Avenue" }, { at: [-49, -2], ns: true, name: "Queen's Avenue" },
      { at: [-57, 1], name: 'Mill Road' }, { at: [-55, -2], ns: true, name: 'Church Lane' }, { at: [-56, -10], name: 'Hedge Lane' },
    ],
    spots: [
      { id: 'road-pedestrian', spot: 'road-pedestrian', name: 'Pedestrian street', ...ROAD_CLASS_STOPS.pedestrian },
      { id: 'road-oneway', spot: 'road-oneway', name: 'One-way streets', ...ROAD_CLASS_STOPS.oneway },
      { id: 'road-avenue', spot: 'road-avenue', name: 'Avenue', ...ROAD_CLASS_STOPS.avenue },
      { id: 'road-motorway', spot: 'road-motorway', name: 'Motorway', ...ROAD_CLASS_STOPS.motorway },
      { id: 'road-lane', spot: 'road-lane', name: 'Country lane', ...ROAD_CLASS_STOPS.lane },
      { id: 'junction-group', spot: 'junction-group', name: 'Avenue crossing', ...JUNCTION_STOPS.group },
      { id: 'visitor-limit', spot: 'visitor-limit', name: 'Visitor limit', rect: [-60, -23, 6, 6], inspect: [-58, -20] },
      { id: 'traffic-panel', spot: 'traffic-panel', name: 'The Traffic panel', rect: [-52, -31, 9, 9], inspect: [-48, -26], view: 'traffic' },
    ],
  },
  {
    id: 'downtown', name: 'Downtown',
    blurb: 'Nine districts of homes, shops, offices and industry, pre-built to level 3. Nobody places these: you zone land and it grows when there is demand and builders can reach it. District B1 is all homes: its people commute downtown, many by bus.',
    // the western district (B1) becomes a suburb: every shop, factory and office block there is homes, so its people
    // commute out, many by the two bus lines (with no jobs at home, their trips are long enough to ride); its east
    // column keeps an office and a shopping block so the town has a few more jobs than people
    zones: NON_HOME_BLOCKS.filter(([bi]) => bi < 3).map(([bi, bj]): DemoZone => ({ zone: 'residential', rect: block(0, 1, bi, bj) })),
    blocks: [
      { id: 'block-residential', kind: 'residential', name: 'Homes', rect: block(1, 1, 1, 1), inspect: [-5, -4] },
      { id: 'block-commercial', kind: 'commercial', name: 'Shops', rect: block(1, 1, 2, 0), inspect: [3, -9] },
      { id: 'block-office', kind: 'office', name: 'Offices', rect: block(1, 1, 3, 1), inspect: [8, -4] },
      { id: 'block-industrial', kind: 'industrial', name: 'Industry', rect: block(1, 1, 0, 2), inspect: [-10, 1] },
      // the middles of the blocks (sim/blocks.ts settleInteriors): deep plots grown back from the frontage, and a
      // communal garden inside a ring of homes
      { id: 'block-deep', kind: 'res-deep', name: 'Deep plots', rect: block(1, 1, 1, 0), inspect: [-4, -7] },
      { id: 'block-garden', kind: 'block-garden', name: 'Communal garden', rect: block(1, 1, 2, 2), inspect: [1, 2],
        blurb: 'A communal garden: the 2×2 middle of a block ringed by homes, which no road reaches, planted by the residents as a shared garden. Only the homes round it count it, as a small park nearby; nobody else can get in.',
        how: 'Nothing to build. Zone a block all homes and own its middle: once every home round it stands, the residents plant it. It costs nothing and has no upkeep.' },
    ],
    // mobile jobs (docs/mobile-jobs.md): roles of grown lots picked by tile hash, so these doors are where the hashes put them
    spots: [
      ...MOBILE_SPOTS.map(([id, x, y, name]): DemoSpot => ({ id, spot: id, name, rect: [x, y, 1, 1], inspect: [x, y] })),
      // focus groups (docs/motivation.md): a home in the residential block, whose tooltip shows its parcel's value mix
      { id: 'focus-groups', spot: 'focus-groups', name: 'Focus groups', rect: block(1, 1, 1, 1), inspect: [-5, -4] },
    ],
  },
  {
    id: 'high-street', name: 'High Street',
    blurb: 'A shopping street with its ad frames rented: posters on the shops\' flanks, billboards over the car parks, a panel in the bus shelter and a hoarding round a building site, three campaigns at three ages.',
    // frozen: the two-storey shops stay as the gaps were picked for (growth would raise them to towers and merge them)
    land: [{ name: 'High Street', rect: [HS.x0, HS.road - 1, HS.x1 - HS.x0 + 1, 3], frozen: true }, { name: 'Big Screens Corner', rect: [HS.north.corner, HS.road - 2, 2, 1] }],
    roads: [[[HS.x1, HS.road], [HS.x0, HS.road]]],
    zones: [...hsLots(HS.road - 1, HS.north.gaps, HS.north.parking, HS.north.busStop, HS.north.corner), ...hsLots(HS.road + 1, HS.south.gaps, HS.south.parking)],
    placements: [
      { id: 'hs-parking-north', kind: 'parking', door: [HS.north.parking, HS.road - 1] },
      { id: 'hs-parking-south', kind: 'parking', door: [HS.south.parking, HS.road + 1] },
      { id: 'hs-bus-stop', kind: 'bus-stop', door: [HS.north.busStop, HS.road - 1] }, // its panel looks onto the building site
      // the big screens corner on the corner with the perimeter road, its screens turned to the junction; toured at night
      { id: 'big-screens', kind: 'big-screens', door: [HS.north.corner + 1, HS.road - 1], rot: 0, hour: 21, aside: 0.8 },
    ],
    spots: [{ id: 'high-street', spot: 'high-street', name: 'High Street', rect: HS.rect, inspect: [-47, -16] }],
    streets: [{ at: [HS.x0 + 2, HS.road], name: 'High Street' }],
  },
  {
    id: 'transport', name: 'Buses and parking',
    blurb: 'A bus depot whose drivers run two lines out of the western suburb with a stop on every block, every size of car park from kerbside bays to a park and ride, and a roundabout and a flyover downtown.',
    // the roundabout at (-20, -6), one of the busiest crossroads, takes its four corner lots
    clear: [block(1, 1, 2, 1), block(1, 1, 1, 2), [-21, -7, 1, 1], [-19, -7, 1, 1], [-21, -5, 1, 1], [-19, -5, 1, 1]],
    // the motorway connection (gateways): just outside the west perimeter road, where newcomers, visitors and freight come in
    // and a pioneer camp beside it (Audit #1): where a new player's first settlers live
    land: [{ name: 'Motorway junction', rect: [-39, -3, 4, 6] }, { name: 'Pioneer camp', rect: [-39, 3, 4, 3] }],
    placements: [
      { kind: 'motorway', door: [-36, 0], rot: 1 },
      { kind: 'camp', door: [-36, 4], rot: 1 },
      { kind: 'bus-depot', door: [1, -2], rot: 0 },
      { kind: 'multi-storey', door: [0, -5], rot: 2 },
      { kind: 'park-and-ride', door: [-4, 3], rot: 0 },
      { kind: 'kerbside-bays', door: [-5, 0] },
      { kind: 'parking', door: [-4, 0] },
      // line 1 runs west-east along y = -1 (stops on its north side), line 2 north-south along x = -25 through the western
      // suburb (stops on its east side): a stop in the middle of a block's frontage, never facing a junction, skipping the
      // depot and car park blocks and the civic section's lots
      ...[-33, -28, -23, -18, -9, 6, 15, 20, 25, 30].map((x, i): DemoPlacement => ({ id: i ? `bus-stop-${i + 1}` : 'bus-stop', kind: 'bus-stop', door: [x, -2] })),
      ...LINE_2_STOPS.map((y, i): DemoPlacement => ({ id: `bus-stop-${i + 11}`, kind: 'bus-stop', door: [-24, y] })),
    ],
    junctions: [
      { id: 'roundabout', tool: 'roundabout', at: [-20, -6] },
      // both bus lines cross here, line 1 over the deck and line 2 under it
      { id: 'flyover', tool: 'flyover', at: [-25, -1], deck: 'ew' },
    ],
    // the streets themselves: kerbs, corners, markings, crossings, lamps and street trees (shared/src/roadlook.ts)
    spots: [{ id: 'road-look', spot: 'road-look', name: 'Streets', rect: ROAD_LOOK_RECT, inspect: [28, 11] }],
    lines: [
      { id: 'line-bus-1', mode: 'bus', number: 1, colour: 0xe0a92e, loop: false, vehicles: 5, stops: [-33, -28, -23, -18, -9, 6, 15, 20, 25, 30].map((x): DemoXY => [x, -2]) },
      { id: 'line-bus-2', mode: 'bus', number: 2, colour: 0x3a86d4, loop: false, vehicles: 5, stops: LINE_2_STOPS.map((y): DemoXY => [-24, y]) },
    ],
  },
  {
    id: 'civic', name: 'Civic services',
    blurb: 'Every size of health, police, fire and builders, side by side in district A1: what each rung covers, who staffs it and what it costs.',
    clear: [block(0, 0, 1, 2), block(0, 0, 0, 2), block(0, 0, 2, 3), block(0, 0, 3, 1), block(0, 0, 3, 2), block(0, 0, 2, 1), block(0, 0, 1, 3)],
    placements: [
      { kind: 'gp-surgery', door: [-31, -24] },
      { kind: 'health-centre', door: [-22, -19], rot: 2 },
      { kind: 'walk-in-centre', door: [-24, -19], rot: 2 },
      { kind: 'hospital', door: [-31, -21] },
      { kind: 'community-hospital', door: [-23, -16], rot: 0 },
      { kind: 'general-hospital', door: [-33, -21], rot: 0 },
      { kind: 'teaching-hospital', door: [-27, -21], rot: 0 },
      { kind: 'police-box', door: [-19, -29] },
      { kind: 'police-post', door: [-18, -29] },
      { kind: 'police', door: [-17, -29] },
      { kind: 'divisional-station', door: [-19, -21], rot: 0 },
      { kind: 'police-hq', door: [-18, -26], rot: 0 },
      { kind: 'fire-post', door: [-24, -29] },
      { kind: 'fire', door: [-23, -29] },
      { kind: 'large-fire-station', door: [-16, -21], rot: 0 },
      { kind: 'fire-hq', door: [-23, -26], rot: 0 },
      { kind: 'handyman', door: [-26, -19] },
      { kind: 'yard', door: [-26, -16] },
      { kind: 'builders-depot', door: [-29, -19], rot: 2 },
      { kind: 'construction-company', door: [-29, -16], rot: 0 },
    ],
    // the general and teaching hospitals' air ambulances and the police headquarters' helicopter (docs/helicopters.md)
    spots: [{ id: 'helipads', spot: 'helipads', name: 'Helipads', rect: [-34, -27, 18, 10], inspect: [-27, -21] },
      // the fire drill (server sim/fires.ts drills, demoFireDrills): the house five tiles from the fire post catches light again a little after each fire is out
      { id: 'house-fire', spot: 'house-fire', name: 'House fire', rect: FIRE_DRILL_RECT, inspect: FIRE_DRILL },
      // the spread drill (sim/fires.ts rows, demoFireRows): the row's lead house catches light with nobody called, and the fire runs along the row until the engines come
      { id: 'fire-spread', spot: 'fire-spread', name: 'Fire spreading', rect: FIRE_ROW_RECT, inspect: FIRE_ROW[1], row: FIRE_ROW }],
  },
  {
    id: 'rail', name: 'Rail and freight',
    blurb: 'A halt among the homes of district A2 and a station beside the stadium, on a passenger line along the north edge, two freight yards on a freight line along the south edge (one beside the industrial estate, one beside the shops it delivers to), and an underground line from the rail station past the arena to a bus stop on line 1.',
    land: [{ name: 'North railway', rect: [-35, -41, 70, 6] }, { name: 'South railway', rect: [-35, 35, 70, 6] }],
    // the metro line's middle kiosk and its hall (beside the east road, x = 28) take a lot or two of the districts
    clear: [[27, -19, 1, 1], [27, -3, 1, 2]],
    // shops beside the east yard (the estate's nearest), homes in place of every shop nearer the estate than that
    zones: [
      { zone: 'commercial', rect: block(1, 2, 2, 3) },
      ...[block(0, 2, 3, 2), block(0, 2, 2, 0), block(0, 2, 0, 1), block(0, 1, 1, 3), block(1, 2, 0, 1)].map((rect): DemoZone => ({ zone: 'residential', rect })),
    ],
    placements: [
      { kind: 'rail-halt', door: [-7, -36], rot: 0 },
      { kind: 'rail-station', door: [20, -36], rot: 0 },
      { id: 'freight-yard-west', kind: 'freight-yard', door: [-30, 35], rot: 2 },
      { id: 'freight-yard-east', kind: 'freight-yard', door: [-2, 35], rot: 2 },
      // the underground line (docs/underground.md): a kiosk 3 tiles from the rail station's door, one by the arena, and a
      // hall 2 tiles from bus line 1's stop at (25, -2). Every platform runs north-south (rot 1: along y), so the tunnel
      // turns once under the stadium's district and runs straight down x = 27 under the roads and blocks between
      { kind: 'metro-entrance', door: [17, -36], rot: 1, name: 'Station Road' },
      { id: 'metro-entrance-2', kind: 'metro-entrance', door: [27, -19], rot: 1, name: 'Arena' },
      { kind: 'metro-station', door: [27, -2], rot: 1, name: 'Eastgate' },
    ],
    tracks: [
      // the halt's platform track runs on y = -38, the station's on y = -39: one drag with a corner, then along the station.
    // The halt sits by the homes of district A2 and the station by the stadium, 30 tiles apart: a match night out by train
      { id: 'track-passenger', name: 'Passenger line track', drags: [[[-10, -38], [15, -39]], [[15, -39], [25, -39]]] },
      { id: 'track-freight', name: 'Freight line track', drags: [[[-34, 38], [1, 38]]] },
    ],
    lines: [
      { id: 'line-rail-1', mode: 'rail', number: 1, colour: 0xb0563d, loop: false, vehicles: 1, stops: [[-7, -36], [20, -36]] },
      { id: 'line-freight-1', mode: 'rail', number: 9, colour: 0x6d6f73, loop: false, vehicles: 1, freight: true, stops: [[-30, 35], [-2, 35]] },
      { id: 'line-metro-1', mode: 'metro', number: 1, name: 'Crosstown', colour: 0x0098d4, loop: false, vehicles: 2, stops: [[17, -36], [27, -19], [27, -2]] },
    ],
  },
  {
    id: 'leisure', name: 'Leisure',
    blurb: 'Every park, cinema, theatre, sports venue and library size in district A3, with the people who go there by day and on event nights.',
    clear: [block(2, 0, 1, 0), block(2, 0, 0, 2), block(2, 0, 2, 1), block(2, 0, 3, 1), block(2, 0, 2, 3), block(2, 0, 3, 2), block(2, 0, 1, 3)],
    placements: [
      { kind: 'park', door: [24, -29] },
      { kind: 'lakeside-park', door: [25, -26], rot: 0 },
      { kind: 'botanical-garden', door: [16, -21], rot: 0 },
      { kind: 'cafe-cinema', door: [29, -24] },
      { kind: 'cinema', door: [30, -24] },
      { kind: 'multiplex', door: [30, -21], rot: 0 },
      { kind: 'studio-theatre', door: [29, -29] },
      { kind: 'theatre', door: [30, -29] },
      { kind: 'opera-house', door: [30, -26], rot: 0 },
      { kind: 'sports', door: [24, -19] },
      { kind: 'leisure-centre', door: [32, -21], rot: 0 },
      { kind: 'arena', door: [25, -16], rot: 0 },
      { kind: 'stadium', door: [20, -34], rot: 2 }, // facing the north road, a short walk from the rail station
      { kind: 'library', door: [22, -19] },
      { kind: 'central-library', door: [19, -19], rot: 2 },
      { kind: 'museum', door: [20, -16], rot: 0 },
    ],
  },
  {
    id: 'media', name: 'Media',
    blurb: 'A local TV studio, a broadcast centre and a media centre with the news helicopter\'s pad on its tower, on the north row of district B3: the town\'s channel, reporting the fire drill and the town\'s big days in the News panel (docs/media.md).',
    clear: [block(2, 1, 0, 0), block(2, 1, 1, 0)],
    placements: [
      { kind: 'broadcast-centre', door: [14, -7], rot: 0 },
      { kind: 'tv-studio', door: [17, -7] },
      { kind: 'media-centre', door: [20, -7], rot: 0 },
    ],
    // the news helicopter over the civic district's fire drill (shared newsHelis.ts), and the homes of district B2 where a
    // set in the lounge shows its pictures, the channels' programmes or teletext (client render/tv.ts)
    spots: [
      { id: 'news-heli', spot: 'news-heli', name: 'News helicopter over the fire drill', rect: NEWS_HELI_RECT, inspect: FIRE_DRILL },
      { id: 'live-tv', spot: 'live-tv', name: 'Live on TV', rect: [-6, -6, 6, 6], inspect: [-5, -4], view: 'tv', hour: 20.5 },
    ],
  },
  {
    id: 'power', name: 'Power',
    blurb: 'A power district west of the town (docs/utilities.md): a gas and a coal power station, a grid supply point by the road into town, a row of wind turbines, a solar farm and a power depot whose vans repair faults, joined to two substations in the town by streets, a pylon line and a buried cable. Every few game hours a fault blacks out the streets round one substation until the van has fixed it. Along the south road stand the five refuse grades (docs/multiplayer-land.md M4), an open tip to an energy-from-waste plant.',
    land: [{ name: 'Power station', rect: POWER_LAND }],
    roads: [[[-57, 10], [-36, 10]], [[-57, 20], [-36, 20]], [[-57, 11], [-57, 19]]],
    // the in-town substations stand on lots of districts B1 and C1 beside the perimeter road
    clear: [[POWER_SUB_A[0], POWER_SUB_A[1], 1, 1], [POWER_SUB_B[0], POWER_SUB_B[1], 1, 1]],
    placements: [
      { kind: 'gas-plant', door: [-52, 11], rot: 2 },
      { kind: 'coal-plant', door: [-46, 11], rot: 2 },
      { kind: 'grid-supply-point', door: [-40, 11], rot: 2 },
      { kind: 'power-depot', door: [-39, 19], rot: 0 },
      { id: 'wind-turbine', kind: 'wind-turbine', door: [-55, 21] }, { id: 'wind-2', kind: 'wind-turbine', door: [-53, 21] }, { id: 'wind-3', kind: 'wind-turbine', door: [-51, 21] },
      { kind: 'solar-farm', door: [-47, 21], rot: 2 },
      { kind: 'substation', door: POWER_SUB_A, name: 'Perimeter Road substation' },
      { id: 'substation-b', kind: 'substation', door: POWER_SUB_B, name: 'Beacon Lane substation' },
      // the wind row's own node: its supply runs along the turbines' road and on round to the grid supply point's
      { id: 'substation-c', kind: 'substation', door: [-50, 21] },
      // the refuse grades (docs/multiplayer-land.md M4) in a row facing the south road, worst to cleanest
      { kind: 'open-tip', door: [-56, 19], rot: 0 },
      { kind: 'lined-landfill', door: [-53, 19], rot: 0 },
      { kind: 'recycling-centre', door: [-50, 19], rot: 0 },
      { kind: 'compost-digester', door: [-47, 19], rot: 0 },
      { kind: 'energy-from-waste', door: [-44, 19], rot: 0 },
    ],
    utilLinks: [
      { id: 'power-pylons', name: 'The pylon line', mode: 'overhead', from: [-45, 13], to: POWER_SUB_A },
      { id: 'power-buried', name: 'The buried cable', mode: 'buried', from: [-47, 22], to: POWER_SUB_B },
    ],
    spots: [{ id: 'power-blackout', spot: 'blackout', name: 'A blackout', rect: [POWER_SUB_A[0] - 4, POWER_SUB_A[1] - 2, 12, 9], inspect: POWER_SUB_A, hour: 21.6 }],
  },
  {
    id: 'remembrance', name: 'Cemeteries',
    blurb: 'The north row of district C3 (docs/remembrance.md): a garden cemetery, the municipal cemetery with the funeral director beside it, a churchyard and a crematorium facing the cross street. Their plots hold the town\'s dead, a headstone each, and a funeral goes from the funeral director to the churchyard every couple of hours.',
    clear: [block(2, 2, 0, 0), block(2, 2, 1, 0), block(2, 2, 2, 0)],
    placements: [
      { kind: 'garden-cemetery', door: doorAt('garden-cemetery', 14, 14, 0), rot: 0, graves: 0.7 },
      { kind: 'municipal-cemetery', door: doorAt('municipal-cemetery', 19, 15, 0), rot: 0, graves: 0.5 },
      { kind: 'funeral-director', door: [22, 17] },
      { kind: 'churchyard', door: doorAt('churchyard', 24, 16, 0), rot: 0, graves: 0.55 },
      { kind: 'crematorium', door: doorAt('crematorium', 26, 15, 1), rot: 1, graves: 0.6 },
    ],
    // the funeral drill (sim/death.ts drills): a hearse from the funeral director to the churchyard, a few neighbours as mourners
    spots: [{ id: 'funeral', spot: 'funeral', name: 'A funeral', rect: [21, 13, 8, 7], inspect: [24, 17], funeral: { from: [22, 17], to: [24, 17] } }],
  },
  {
    id: 'airport', name: 'Airport',
    blurb: 'An airport terminal facing the east perimeter road, with a 20-tile runway five rows behind it: a flight an hour, every type from the business jet to the jumbo, landing fees for the owner.',
    land: [{ name: 'Airfield', rect: [35, -12, 15, 24] }],
    // homes across the road from the terminal, whose nearest jobs are the ground crew's
    zones: [block(2, 1, 3, 1), block(2, 1, 3, 2)].map((rect): DemoZone => ({ zone: 'residential', rect })),
    placements: [{ kind: 'airport', door: [35, 0], rot: 3 }],
    // 20 tiles: long enough for the jumbo (flights.ts PLANE_TYPES minRunway), so every plane type flies here
    runways: [{ id: 'runway', from: [46, -10], to: [46, 9] }],
  },
  {
    id: 'industry', name: 'Industry',
    blurb: 'An industrial estate in district C1 beside the west freight yard: its factories send deliveries by train to the shops beside the east yard.',
    // the south-west corner of district C1 all factories, beside the west freight yard
    zones: [block(0, 2, 0, 3), block(0, 2, 1, 3), block(0, 2, 1, 2)].map((rect): DemoZone => ({ zone: 'industrial', rect })),
    blocks: [{ id: 'block-estate', kind: 'industrial', name: 'Industrial estate', rect: [-34, 24, 9, 9], inspect: [-34, 30] }],
    // the blast drill (sim/fires.ts blastDrills, demoFireBlasts): a works catches light, blows up and sets the lots round it alight
    spots: [{ id: 'fire-blast', spot: 'fire-blast', name: 'Explosion at the works', rect: FIRE_BLAST_RECT, inspect: FIRE_BLAST }],
  },
  {
    id: 'riverside', name: 'Riverside',
    blurb: 'A river south of the freight line, crossed by a stone arch, a steel girder, a suspension and a lifting bascule bridge, with a level crossing on the way down, and a quarter beyond it where every merged building stands: terraces to tower estates, parades to hotel towers, workshops to a heavy plant, a headquarters with a rooftop helipad.',
    land: [{ name: 'Riverside', rect: [-35, 41, 70, 20] }],
    // the river runs on off the town's land both ways (into the lake to the west)
    water: [[-60, RIVER_ROWS[0], 131, RIVER_ROWS[1] - RIVER_ROWS[0] + 1]],
    roads: [
      // the four streets down to the river; the freight line's track (rail section) crosses the first on a level crossing
      ...RIVER_BRIDGES.map((b): [DemoXY, DemoXY] => [[b.x, 35], [b.x, RIVER_ROWS[0] - 1]]),
      ...RIVER_BRIDGES.map((b): [DemoXY, DemoXY] => [[b.x, RIVER_ROWS[1] + 1], [b.x, RIVER_ROWS[1] + 1]]),
      [[-20, 49], [30, 49]], [[-20, 54], [30, 54]], [[-20, 59], [30, 59]],
      // the river road runs on past the quarter to a dead end, where line 3's buses turn round (sim/busroute.ts)
      [[31, 49], [33, 49]],
      ...QUARTER_X.map((x): [DemoXY, DemoXY] => [[x, 50], [x, 58]]),
    ],
    bridges: RIVER_BRIDGES.map((b): DemoBridge => ({ id: b.id, name: b.name, from: [b.x, RIVER_ROWS[0]], to: [b.x, RIVER_ROWS[1]], style: b.style })),
    // line 3, there and back from the street down to the stone bridge, along the river road to its dead end: the buses
    // turn round there by themselves (docs/transit.md); stops on the river side of the road, facing no junction
    lines: [{ id: 'line-bus-3', mode: 'bus', number: 3, colour: 0x2fa37a, loop: false, vehicles: 2, stops: RIVER_LINE_STOPS }],
    // works to the west, then shops, offices and homes; the merged lots stand on these zones (their own tiles first)
    zones: [
      ...[0, 1, 2].map((i): DemoZone => ({ zone: 'industrial', rect: qblock(i) })),
      ...[3, 4].map((i): DemoZone => ({ zone: 'commercial', rect: qblock(i) })),
      ...[5, 6].map((i): DemoZone => ({ zone: 'office', rect: qblock(i) })),
      ...[7, 8, 9].map((i): DemoZone => ({ zone: 'residential', rect: qblock(i) })), // the last a ring of homes round a communal garden
      // the homes behind, for the quarter's jobs (the town has more jobs than people without them)
      ...QUARTER_X.slice(1).map((_x, i): DemoZone => ({ zone: 'residential', rect: qblock(i, 1) })),
    ],
    // one of every merged lot (zones.ts GROW_FORMS but the deep plots, which settle into block middles by themselves),
    // the north ones facing the river road, the south ones y = 54
    placements: [
      ...RIVER_LINE_STOPS.map((door, i): DemoPlacement => ({ id: `bus-stop-${21 + i}`, kind: 'bus-stop', door })),
      mergedAt('ind-plant', -19, 50, 2, 7),
      mergedAt('ind-works', -14, 50, 2, 5), mergedAt('ind-row', -14, 53, 0, 3),
      mergedAt('ind-depot', -9, 50, 2, 4),
      mergedAt('com-centre', -4, 50, 2, 6), mergedAt('com-parade', -4, 53, 0, 3),
      mergedAt('com-store', 1, 50, 2, 5), mergedAt('com-hotel', 3, 50, 2, 7),
      mergedAt('off-tower', 6, 50, 2, 5),
      mergedAt('off-hq', 11, 50, 2, 7), mergedAt('off-centre', 11, 53, 0, 3), // the supertall with the helipad on its crown
      mergedAt('res-estate', 16, 50, 2, 7), mergedAt('res-terrace', 16, 53, 0, 3),
      mergedAt('res-midrise', 21, 50, 2, 4), mergedAt('res-tower', 23, 50, 2, 7), mergedAt('res-block', 21, 52, 0, 5),
    ],
    spots: [
      { id: 'river', spot: 'river', name: 'The river', rect: [-20, RIVER_ROWS[0], 51, RIVER_ROWS[1] - RIVER_ROWS[0] + 1] },
      { id: 'level-crossing', spot: 'level-crossing', name: 'Level crossing', rect: [-20, 38, 1, 1], inspect: [-30, 35] },
      // the whole town from above, on the world map
      { id: 'world-map', spot: 'world-map', name: 'World map', rect: [-60, -60, 130, 140], view: 'map' },
      // settlement ranks (docs/ranks.md): the stop plays a rank-up's fireworks over the middle of the town
      { id: 'ranks', spot: 'ranks', name: 'Settlement ranks', rect: [-14, -14, 28, 28], view: 'ranks' },
      // sound (docs/audio.md): nothing to place; at dawn, so the chorus is the first thing a player hears here
      { id: 'sound', spot: 'sound', name: 'Sound', rect: [-14, -14, 28, 28], hour: 6 },
    ],
    // the railway land and the quarter beyond it: together 70×26, past the 48-tile parcel edge, so an estate (not a merge)
    estates: [{ name: 'Riverside estate', lands: ['South railway', 'Riverside'] }],
  },
  {
    id: 'education', name: 'Schools and university',
    blurb: 'A nursery and a primary school among the homes of district A2, a secondary school in the middle of them, a sixth-form college and a further-education college on its edges, and a university quarter beyond the east road: a campus, two halls of residence and a research institute. Families live round the schools, so the children walk to class on school days.',
    // job blocks of district A2 (x -11..9, y -35..-15), among its homes: the schools replace shops and works, never homes
    clear: [block(1, 0, 2, 0), block(1, 0, 2, 1), block(1, 0, 0, 1), block(1, 0, 3, 1)],
    // the university quarter: east of the town's east road (x = 34), along a street laid off it
    land: [{ name: 'University Quarter', rect: [35, -40, 45, 26] }],
    roads: [[[35, QUARTER_STREET], [79, QUARTER_STREET]]],
    placements: [
      // the primary (2×2) and the nursery beside it, facing the street between blocks (y = -30)
      { kind: 'primary-school', door: doorAt('primary-school', 0, -32, 0), rot: 0 },
      { kind: 'nursery', door: [3, -31] },
      // the secondary (3×3) in the middle of the homes, its door on the street south of it (y = -25)
      { kind: 'secondary-school', door: doorAt('secondary-school', 0, -28, 0), rot: 0 },
      // the sixth-form college (2×2) and the further-education college (3×2) on the district's edges
      { kind: 'sixth-form', door: doorAt('sixth-form', 5, -27, 0), rot: 0 },
      { kind: 'fe-college', door: doorAt('fe-college', -10, -27, 0), rot: 0 },
      // the quarter: the campus gate on the street (x = 41), two halls of residence (one across the street) and the institute
      { kind: 'university', door: doorAt('university', 38, QUARTER_STREET - 6, 0), rot: 0 },
      { kind: 'halls', door: doorAt('halls', 45, QUARTER_STREET - 2, 0), rot: 0 },
      { id: 'halls-2', kind: 'halls', door: doorAt('halls', 48, QUARTER_STREET + 1, 2), rot: 2 },
      { kind: 'research-institute', door: doorAt('research-institute', 51, QUARTER_STREET - 3, 0), rot: 0 },
    ],
  },
  {
    id: 'harbour', name: 'Harbour',
    blurb: 'The river runs on into a basin that opens to the sea: a cargo port with container ships, coasters and ro-ro ferries met by a tug, a fishing harbour whose trawlers sail before dawn, a marina of pleasure boats, a jetty by the lifting bridge whose dinghies sail through its lifts, and a river bus line between two piers.',
    // the land east of the town; the river across it (dried with the land) is painted back below
    land: [{ name: 'Harbour', rect: [35, QUAY_ROAD - 6, 45, 30] }],
    // homes behind the quay road, between it and a street on y = 28, whose nearest jobs are the docks' and the fish
    // quay's (the town has more jobs than people, and its own nearer)
    zones: [{ zone: 'residential', rect: [44, QUAY_ROAD - 4, 36, 4] }],
    water: [[35, RIVER_ROWS[0], 10, RIVER_ROWS[1] - RIVER_ROWS[0] + 1], BASIN, BAY, POOL,
      // the pier's pontoon row in the bay's shore
      [71, QUAY_ROAD + 2, 2, 1]],
    // the quay road, and the marina's spur off the street down to the lifting bridge (x = 15) over the railway land
    roads: [[[35, QUAY_ROAD], [79, QUAY_ROAD]], [[35, QUAY_ROAD - 5], [79, QUAY_ROAD - 5]], [[16, POOL[1] - 3], [HARBOUR_AT.marina.door[0], POOL[1] - 3]]],
    placements: Object.values(HARBOUR_AT),
    // river buses from the riverside quarter (beside bus line 3's stop at (22, 48)) out to the bay
    lines: [{ id: 'line-ferry-1', mode: 'ferry', number: 1, colour: 0x1f8a8a, loop: false, vehicles: 3, stops: [HARBOUR_AT['pier-river'].door, HARBOUR_AT['pier-bay'].door] }],
    seaGates: [SEA_GATE],
    spots: [{ id: 'sea-gate', spot: 'sea-gate', name: 'To the sea', rect: [SEA_GATE.x - 8, SEA_GATE.y - 6, 9, 12], inspect: HARBOUR_AT.port.door }],
  },
];

/** Tour order: placement, block, runway, track, junction and line ids, plus 'welcome' (the whole town). */
export const TOUR: string[] = [
  'welcome',
  'block-residential', 'focus-groups', 'block-commercial', 'high-street', 'big-screens', 'block-office', 'block-industrial', 'block-deep', 'block-garden',
  'cab-office', 'takeaway', 'waste-depot', 'parcel-depot',
  'bus-depot', 'bus-stop', 'line-bus-1', 'line-bus-2', 'kerbside-bays', 'parking', 'multi-storey', 'park-and-ride', 'motorway', 'camp', 'roundabout', 'flyover', 'road-look',
  'road-pedestrian', 'road-oneway', 'road-avenue', 'roundabout-big', 'road-motorway', 'interchange', 'junction-group', 'road-lane', 'roundabout-mini', 'turn-ban', 'pelican',
  'street-hgv', 'street-bus', 'line-bus-4', 'street-yellow', 'street-zone20', 'visitor-limit', 'traffic-panel',
  'gp-surgery', 'health-centre', 'walk-in-centre', 'hospital', 'community-hospital', 'general-hospital', 'teaching-hospital',
  'police-box', 'police-post', 'police', 'divisional-station', 'police-hq', 'helipads',
  'fire-post', 'house-fire', 'fire-spread', 'fire', 'large-fire-station', 'fire-hq',
  'handyman', 'yard', 'builders-depot', 'construction-company',
  'rail-halt', 'track-passenger', 'rail-station', 'line-rail-1', 'metro-entrance', 'line-metro-1', 'metro-station',
  'park', 'lakeside-park', 'botanical-garden',
  'cafe-cinema', 'cinema', 'multiplex',
  'studio-theatre', 'theatre', 'opera-house',
  'sports', 'leisure-centre', 'arena', 'stadium',
  'library', 'central-library', 'museum',
  'tv-studio', 'broadcast-centre', 'media-centre', 'news-heli', 'live-tv',
  'funeral-director', 'funeral', 'churchyard', 'municipal-cemetery', 'garden-cemetery', 'crematorium',
  'gas-plant', 'coal-plant', 'wind-turbine', 'solar-farm', 'grid-supply-point', 'substation', 'power-pylons', 'power-buried', 'power-depot', 'power-blackout',
  'open-tip', 'lined-landfill', 'recycling-centre', 'compost-digester', 'energy-from-waste',
  'nursery', 'primary-school', 'secondary-school', 'sixth-form', 'fe-college', 'university', 'halls', 'research-institute',
  'airport', 'runway',
  'block-estate', 'fire-blast', 'freight-yard-west', 'track-freight', 'freight-yard-east', 'line-freight-1',
  'river', 'level-crossing', 'bridge-girder', 'bridge-arch', 'bridge-bascule', 'bridge-suspension', 'line-bus-3', 'world-map', 'ranks', 'sound',
  'ind-plant', 'ind-works', 'ind-row', 'ind-depot', 'com-centre', 'com-parade', 'com-store', 'com-hotel',
  'off-tower', 'off-hq', 'off-centre', 'res-estate', 'res-terrace', 'res-midrise', 'res-tower', 'res-block',
  'marina', 'jetty', 'ferry-pier', 'line-ferry-1', 'ferry-pier-2', 'fishing-harbour', 'cargo-port', 'sea-gate',
];

/** The sections every sample city on the kit seeds (citydemo.ts cityScenario). */
const CITY_SECTIONS: SectionId[] = ['city-areas', 'city-landmarks', 'city-transit', 'city-roads'];
export const DEMOS: DemoDef[] = [
  { id: 'showcase', name: 'Showcase', slot: 90, sections: ['downtown', 'roads', 'transport', 'high-street', 'civic', 'rail', 'leisure', 'media', 'power', 'remembrance', 'education', 'airport', 'industry', 'riverside', 'harbour'],
    blurb: 'A lived-in town with one of every large building and every merged lot, buses, trains, an underground and river buses, an airport every plane type flies to, helicopters, a river with every style of bridge, and a harbour with every kind of boat, all running. Take the guided tour.' },
  { id: 'transport', name: 'Transport demo', slot: 91, sections: ['downtown', 'transport', 'rail', 'airport', 'industry'],
    blurb: 'Buses, parking, rail, freight and the airport, in the same town.' },
  { id: 'leisure', name: 'Leisure demo', slot: 92, sections: ['downtown', 'leisure'],
    blurb: 'Parks, cinemas, theatres, sport and libraries, every size.' },
  { id: 'civic', name: 'Civic demo', slot: 93, sections: ['downtown', 'civic', 'remembrance'],
    blurb: 'Health, police, fire and builders, every size.' },
  { id: 'london', name: 'London', slot: 94, sections: ['london-areas', 'london-landmarks', 'london-education', 'london-kinds', 'london-rail', 'london-buses', 'london-river', 'london-roads', 'london-tube'], town: 'london', tour: withKindsTour(LONDON_TOUR), view: LONDON_VIEW,
    blurb: 'A sample city on the shape of London: the Thames winding past Westminster and round the Isle of Dogs to the estuary, the City and Canary Wharf, the West End, homes from Kensington to Hackney and Brixton, docks and industry down river, the parks, the termini and Heathrow, the Central, Northern and Jubilee lines underneath, and on the river the RB1 river buses, yachts through Tower Bridge and ships from the estuary.' },
  // the sample cities on the city-map kit (citydemo.ts): each a CityDemo, its sections built on first use
  { id: 'paris', name: 'Paris', slot: 95, sections: CITY_SECTIONS, town: 'paris', city: PARIS, tour: PARIS_TOUR, view: PARIS_VIEW,
    blurb: PARIS.blurb },
  { id: 'new-york', name: 'New York', slot: 96, sections: CITY_SECTIONS, town: 'new-york', city: NEW_YORK, tour: NEW_YORK_TOUR, view: NEW_YORK_VIEW,
    blurb: NEW_YORK.blurb },
  { id: 'san-francisco', name: 'San Francisco', slot: 97, sections: CITY_SECTIONS, town: 'san-francisco', city: SAN_FRANCISCO, tour: SAN_FRANCISCO_TOUR, view: SAN_FRANCISCO_VIEW,
    blurb: SAN_FRANCISCO.blurb },
];
export const DEMO_BY_ID = new Map(DEMOS.map((d) => [d.id, d]));
export const isDemoId = (s: unknown): s is DemoId => typeof s === 'string' && DEMO_BY_ID.has(s as DemoId);
export const demoSections = (id: DemoId): DemoSection[] => {
  const d = DEMO_BY_ID.get(id), want = new Set(d?.sections ?? []);
  // London's sections are planned with its streets, on first use (london.ts)
  return (d?.town === 'london' ? londonSections() : d?.city ? cityScenario(d.city).sections : SECTIONS).filter((s) => want.has(s.id));
};
/** Land a demo's owners hold: the town's owner, and London's boroughs (`sys:<borough>`, server/src/demo/london.ts). */
export const isDemoOwner = (owner: string | undefined) => owner === DEMO_OWNER || !!owner?.startsWith(`${DEMO_OWNER}:`);

// ---------------------------------------------------------------- linear surfaces and lines (not catalogue kinds)

/**
 * Tools that paint a linear surface instead of placing a catalogue kind. Typed against `Tool`, so a new surface
 * tool fails the typecheck here until it is listed, and `demo:check` then fails until the showcase uses it.
 */
type SurfaceTool = Exclude<Tool, 'road' | 'bulldoze' | KindToolId>;
export const SURFACE_TOOLS: Record<SurfaceTool, true> = { runway: true, rail: true, roundabout: true, flyover: true, miniroundabout: true, interchange: true, turnrule: true, pelican: true, streetrule: true, pylons: true, cable: true };
/** Line modes, plus freight (a rail line between yards); a new TransitMode fails the typecheck until listed. */
export const LINE_MODES: Record<TransitMode | 'freight', true> = { bus: true, rail: true, metro: true, ferry: true, freight: true };

interface Caption { title: string; what: string; how: string; facts: [string, string][] }
const money = (n: number) => `$${n.toLocaleString('en-GB')}`;
const techLine = (feature: string) => {
  const t = techFor(feature);
  return t ? `${t.name} (${TRACK_NAMES[t.track]} tier ${t.tier}, ${money(t.cost)})` : 'available from the start';
};
const SURFACE_CAPTIONS: Record<SurfaceTool, Caption> = {
  runway: {
    title: 'Runway',
    what: 'Six rows of runway, shoulders and taxiway behind an airport terminal. A finished terminal with an intact strip is an airport: planes fly a timetable worked out from the tiles alone, and every landing pays the owner a fee by type (business jet $16, turboprop $24, regional jet $32, narrow-body $40; on runways of 16 tiles or more a wide-body $72, and from 20 tiles a jumbo $90).',
    how: `Pick Runway (U) and drag a straight line of ${RUNWAY_MIN} to ${RUNWAY_MAX} tiles, ${TERMINAL_ROW} rows behind the terminal's back row, along its whole width (a line up to 3 rows off snaps on). 16 tiles or more gives a flight an hour. Bulldozing any strip tile grounds the airport until it is repainted. Click a plane for its crew and passengers: I or O rides in the cockpit, or click a passenger in the manifest for the cabin from their seat (the window, the wing outside over the wing rows, the seat-belt sign, the route on the screen ahead).`,
    facts: [['Tool', 'Runway (U), drag'], ['Footprint', '6 rows wide, 10-32 long'], ['Needs', 'a terminal in front, own dry land, no roads'], ['Technology', techLine('runway')], ['Cost', `${money(RUNWAY_COST)} a strip tile (${money(RUNWAY_COST * 6)} per tile of length)`]],
  },
  rail: {
    title: 'Railway track',
    what: 'Track that trains run on. Each tile remembers the sides it joins, so tracks laid side by side stay apart; a station is served when the track runs along the row behind its platform, its whole width.',
    how: 'Pick Railway track in the Transport group and drag: the path runs along the longer axis first, then turns once. Start a drag on existing track to join it. Drag straight across a straight road (or lay a road straight across track) for a level crossing: barriers close ahead of each train and the traffic waits. Track does not cross water yet, and two lines may not share track (no signals).',
    facts: [['Tool', 'Railway track (no key), drag'], ['Footprint', '1 tile wide, up to 160 per drag'], ['Needs', 'own clear dry land; roads only straight across, as level crossings'], ['Technology', techLine('rail')], ['Cost', `${money(RAIL_COST)} a tile, ${money(RAIL_COST + CROSSING_COST)} a level crossing, joining is free`]],
  },
  roundabout: {
    title: 'Roundabout',
    what: 'A crossroads or T-junction rebuilt as a one-way ring round a planted island. Traffic goes round anticlockwise (it drives on the right), and a car coming in gives way to cars already on the ring, so there are no lights and no waiting for a green.',
    how: 'Pick Roundabout and click a junction. The four corner lots round it must be empty: the ring takes them. Side roads join in the middle of each side. Bulldozing any of it turns it back into a crossroads.',
    facts: [['Tool', 'Roundabout (no key), click a junction'], ['Footprint', '3×3: the junction becomes the island; 5×5 on an avenue'], ['Needs', 'three or four roads meeting, empty corner lots'], ['Technology', techLine('roundabout')], ['Cost', `${money(ROUNDABOUT_COST)}; ${money(BIG_ROUNDABOUT_COST)} the big one`]],
  },
  miniroundabout: {
    title: 'Mini-roundabout',
    what: 'A roundabout painted on a street junction: a white disc with arrows round it and give-way lines at each arm. One car at a time goes round it, giving way to a car already coming round from the left, so a quiet crossroads keeps moving with no lights and no corner lots taken.',
    how: 'Pick Mini-roundabout and click a crossroads or T-junction of streets or lanes. Avenues and one-way streets need the big roundabout or lights. Bulldozing the junction tile takes it away.',
    facts: [['Tool', 'Mini-roundabout (no key), click a junction'], ['Footprint', 'the junction tile'], ['Needs', 'three or four two-way streets or lanes meeting'], ['Technology', techLine('miniroundabout')], ['Cost', money(MINI_ROUNDABOUT_COST)]],
  },
  interchange: {
    title: 'Interchange',
    what: 'A diamond interchange: the street goes over the motorway on a bridge, and a slip road leaves each carriageway before it and joins again after, meeting the street at a junction where it gives way. Traffic on the motorway never stops.',
    how: 'Pick Interchange and click a motorway where a street meets or should cross it. It needs a straight motorway five tiles either side and 9×6 tiles of open ground or empty lots beside it. Bulldozing the bridge cuts the street again.',
    facts: [['Tool', 'Interchange (no key), click a motorway'], ['Footprint', '9 along the motorway × 6 across'], ['Needs', 'a straight motorway, open ground beside it'], ['Technology', `${techLine('interchange')} and ${techFor('motorways')?.name ?? 'Motorways'}`], ['Cost', money(INTERCHANGE_COST)]],
  },
  turnrule: {
    title: 'Turn rules',
    what: 'A sign on one arm of a junction: no left turn, no right turn, no straight on, or no entry. Drivers plan round them (a no-entry arm is one way out of the junction), and a driver whose way a new sign breaks finds another. Fire engines and ambulances on a call ignore turn bans, never a no-entry.',
    how: 'Pick Turn rules and click the road just before a junction, on the arm you want the sign on: each click goes on to the next rule (none, no left, no right, no straight on, no entry).',
    facts: [['Tool', 'Turn rules (no key), click an arm'], ['Needs', 'a junction'], ['Technology', techLine('turnrule')], ['Cost', `${money(TURN_RULE_COST)} a sign`]],
  },
  pelican: {
    title: 'Signal crossing',
    what: 'A crossing with lights: a walker presses the button, and after the traffic has had its minimum green the lights go amber, then red, and the walkers cross; then a flashing amber while the last of them finish. Where a pedestrian street crosses a street there is one already.',
    how: 'Pick Signal crossing and click a straight stretch of street away from a junction. Click it again to take it away.',
    facts: [['Tool', 'Signal crossing (no key), click a street'], ['Needs', 'a straight two-way street tile, not next to a junction'], ['Technology', techLine('pelican')], ['Cost', money(PELICAN_COST)]],
  },
  streetrule: {
    title: 'Street rules',
    what: 'Rules for a whole street, the way a council sets them: an HGV ban (no lorries but to deliver there), a bus lane on a one-way street or an avenue (buses, bikes, taxis and emergencies pass the queue in the kerb lane), double yellow lines (no kerb parking, so no lane slot lost to a parked car) and a 20 zone with speed humps (every vehicle at 60%, through traffic goes elsewhere, quieter and safer for walkers). The signs, the red lane, the yellow lines and the humps are drawn.',
    how: 'Pick Street rules, choose a rule in its picker and click a street: the ghost covers the whole street with the cost and the day\'s upkeep (for an HGV ban, how far a lorry must go round). Drag along part of a street to set it there only. Click a street that has the rule to take it off. Ctrl+Z takes the last change back.',
    facts: [['Tool', 'Street rules (no key), click a street or drag part of one'], ['Needs', 'a street; a bus lane needs two lanes one way'], ['Technology', `${techLine('streetrules')}; bus lanes ${techLine('buslane')}`], ['Cost', STREET_RULE_DEFS.map((d) => `${d.title} ${money(d.cost)} a tile`).join(', ')]],
  },
  flyover: {
    title: 'Flyover',
    what: 'One road lifted over the other on a short deck: the two never meet, so nobody waits at the crossing. Nobody can turn there either; drivers who want to plan round it.',
    how: 'Pick Flyover and click a crossroads whose road carries on straight both sides (the ramps go there). The east-west road goes over when it can; click the flyover again to put the other road on top. Bulldozing it leaves a crossroads.',
    facts: [['Tool', 'Flyover (no key), click a crossroads'], ['Footprint', 'the crossing tile, ramps on the tiles either side'], ['Needs', 'four roads meeting, plain straight road either side of the deck'], ['Technology', techLine('flyover')], ['Cost', `${money(FLYOVER_COST)}, swapping the deck is free`]],
  },
  pylons: {
    title: 'Pylons',
    what: 'An overhead trunk line: lattice towers every few tiles with the wires sagging between them, joining a power station to a substation (or a substation to a motorway connection, for the National Grid). Cheap, and it passes over anything, but nobody wants to live under one.',
    how: 'Pick Pylons in the Power grid group and drag from a power station, substation or grid supply point to another: the line runs along the longer axis, then turns once. Every tile must be your land or unowned. Click a line with the tool to take it down (half the cost comes back).',
    facts: [['Tool', 'Pylons (no key), drag'], ['Needs', 'a plant or node of yours at each end'], ['Technology', techLine('pylons')], ['Cost', `${money(UTIL.overheadCost)} a tile`]],
  },
  cable: {
    title: 'Buried cable',
    what: 'A trunk line under the ground: nothing to see but the cable joint pits, and no blight on the land it crosses. It costs four times as much as pylons, and more under water.',
    how: 'Pick Buried cable in the Power grid group and drag from a plant or node to another, as with pylons. Click a line with the tool to take it down.',
    facts: [['Tool', 'Buried cable (no key), drag'], ['Needs', 'a plant or node of yours at each end'], ['Technology', techLine('cable')], ['Cost', `${money(UTIL.buriedCost)} a tile, ${money(UTIL.buriedWaterCost)} under water`]],
  },
};
/** The 5×5 roundabout on the tour (the roundabout tool on an avenue's junction). */
const BIG_ROUNDABOUT_CAPTION: Caption = {
  title: 'Two-lane roundabout',
  what: 'Kingsway meets Crown Street at a big roundabout: a 5×5 ring of two lanes round a planted island, anticlockwise. Cars going past the second exit take the inner lane and move out before they leave; the rest keep to the outer. Coming on, a car gives way to traffic already going round, and the ring never fills, so it never locks.',
  how: 'Pick Roundabout and click an avenue\'s junction: on an avenue the tool builds the 5×5 two-lane ring (it needs Avenues). The land round the junction must be road, open ground or empty lots. Bulldozing any of it leaves the ring as streets and the island bare.',
  facts: [['Tool', 'Roundabout (no key), click an avenue junction'], ['Footprint', '5×5: a 3×3 island in a two-lane ring'], ['Lanes', 'two, the inner for cars going past the second exit'], ['Technology', `${techLine('roundabout')} and ${techFor('avenues')?.name ?? 'Avenues'}`], ['Cost', money(BIG_ROUNDABOUT_COST)]],
};
/** A bridge on the tour (not a tool of its own: the road tool lays it over water). */
const BRIDGE_CAPTION: Caption = {
  title: 'Bridge',
  what: 'A road bridge over the water. To the traffic it is plain straight road, cars and walkers both ways; nothing joins it from the side and nobody parks on it. Short crossings are mostly stone arches, middling ones arches or steel girders, long ones mostly suspension spans.',
  how: `Drag a road straight out from a road on one bank across the water to the far bank (Civil engineering): the bridge goes down when the drag reaches dry land in line, up to ${BRIDGE_MAX_SPAN} tiles of water. Both ends land on road; bends and junctions on the water are refused. Bulldozing any of the deck takes the whole bridge away.`,
  facts: [['Tool', 'Road (3), drag across the water'], ['Needs', 'road on both banks in line, open water between'], ['Technology', techLine('bridges')], ['Cost', `${money(BRIDGE_TILE_COST)} a tile of deck`]],
};
/** What each style is, added to a bridge stop's caption when the scenario names the style. A new style fails the typecheck here. */
const STYLE_NOTES: Record<keyof typeof BridgeStyle, string> = {
  Arch: 'This one is stone arches on piers, the usual choice for a short crossing.',
  Girder: 'This one is steel girders on concrete piers, for middling spans.',
  Suspension: 'This one hangs its deck from cables between two towers, the usual choice for the longest spans.',
  Bascule: 'This one lifts, drawn as Tower Bridge: a few times a day its two leaves rise for a sailing barge, the barriers close the road and the traffic waits, as at a level crossing. The road tool never picks this style; scenarios lay it.',
};
/** Tour stops on things that are neither a kind nor a drag. A spot names one of these. */
export type SpotKind = 'road-look' | 'junction-group' | 'traffic-panel' | 'visitor-limit' | 'road-lane' | 'road-oneway' | 'road-avenue' | 'road-motorway' | 'road-pedestrian' | 'level-crossing' | 'river' | 'helipads' | 'tube-crossover' | 'world-map' | 'sea-gate' | 'pool-of-london' | 'house-fire' | 'fire-spread' | 'fire-blast' | 'ranks' | 'sound' | 'high-street' | 'blackout' | 'focus-groups' | 'news-heli' | 'live-tv' | 'funeral' | MobileSpot;
const roadFacts = (cls: number): [string, string][] => {
  const d = ROAD_CLASS_DEFS[cls];
  return [['Tool', `Road (3), ${d.title}`], ['Lanes', d.access === 'pedestrian' ? 'none: paving for walkers and bikes' : d.divided ? `${d.lanes} each way, a tile each way` : d.oneWay ? `${d.lanes}, one way` : 'one each way'],
    ['Speed', `${Math.round(d.speed * 100)}% of a street's`], ['Cost', `${money(d.cost)} a tile${d.divided ? ' (two tiles a length)' : ''}, ${money(d.upkeep)} a day`], ['Technology', d.feature ? techLine(d.feature) : 'available from the start']];
};
/** The R5 street rules' tour captions (shared/src/roadrules.ts STREET_RULE_DEFS). */
const ruleFacts = (id: StreetRuleId): [string, string][] => { const d = STREET_RULE_BY_ID.get(id)!; return [['Tool', `Street rules (no key), ${d.title}`], ['Cost', `${money(d.cost)} a tile, ${money(d.upkeep)} a day`], ['Technology', techLine(d.feature)]]; };
const STREET_RULE_CAPTIONS: Record<StreetRuleId, Caption> = {
  hgv: { title: 'HGV ban', what: 'South Parade is closed to lorries: the red ring with a lorry in it stands where each road comes in. A lorry delivering to a home on it still comes, from the nearest end; every other lorry goes round by Kingsway, and the routers plan round the ban from the start. Vans and buses are not lorries: they still come through.', how: 'Street rules › HGV ban, then click the street; the ghost says how much further a lorry going past must go round.', facts: ruleFacts('hgv') },
  bus: { title: 'Bus lane', what: 'North Parade\'s kerb lane is a bus lane: red, with BUS LANE every few tiles and a solid line beside it. Buses, bikes, taxis and emergencies use it and pass the queue; cars keep to the other lane and come into it only to turn off at the last tile. Bus line 4 runs along it.', how: 'Street rules › Bus lane, then click a one-way street or an avenue\'s carriageway (one lane each way has no room for one).', facts: ruleFacts('bus') },
  yellow: { title: 'Double yellows', what: 'Market Street\'s approach to Cheapside has double yellow lines: nobody parks at its kerb, so no lane slot is lost to a parked car on the way into the shops. A driver who finds the shop\'s parking full parks on the next street back, or in a lot, and walks.', how: 'Street rules › Double yellows, then click a street or drag along part of one.', facts: ruleFacts('yellow') },
  zone20: { title: '20 zone', what: `Church Lane, through the homes south of Regent Avenue, is a 20 zone: the roundel stands at each way in and is painted on the road, and speed humps every four to six tiles slow every vehicle to ${Math.round(ZONE20_SPEED * 100)}% (cars dip over them). Routes avoid it where there is another way, so it is quieter and safer for walkers.`, how: 'Street rules › 20 zone, then click a street or drag along part of one.', facts: ruleFacts('zone20') },
};
const SPOT_CAPTIONS: Record<SpotKind, Caption> = {
  'road-lane': {
    title: 'Country lane',
    what: 'Hedge Lane runs from Queen\'s Avenue out to the edge of the land between grass verges: no kerbs, no centre line, no lamps, and cars take it at four fifths of a street\'s pace. It is the cheapest road there is, and every frontier starts with one from its motorway connection.',
    how: ROAD_CLASS_DEFS[1].howTo, facts: roadFacts(1),
  },
  'traffic-panel': {
    title: 'The Traffic panel',
    what: 'Who is on the roads and why it is slow. The panel (from the overlays menu) counts the cars on the road now by who drives them: residents, visitors, lorries, buses and services. It lists arrivals by gateway, the five junctions where most drivers gave up, and the three longest queues; click one to go there. With the congestion overlay on, hover a red road: the tooltip says what holds its cars (the car ahead, a red light, waiting for a gap, the box ahead blocked, parking, a turn) and how many are visitors and lorries, who are most of the load.',
    how: 'Overlays (H) › Traffic panel…; hover a red road with the congestion overlay on.',
    facts: [['Opens from', 'the overlays menu'], ['Costs the server', 'nothing while it is closed: it asks every few seconds while open'], ['Shapes the load', 'street rules, the visitor limit, the lorry curfew']],
  },
  'visitor-limit': {
    title: 'Visitor limit',
    what: `A motorway connection with the visitor limit on: ${Math.round(VISITOR_LIMIT_SHARE * 100)}% of the visitors who would drive in by it come, so there are fewer cars on your streets, and less visitor tax for the shops and offices they would have gone to. The gateway's panel says how many came today and yesterday and about what the limit costs a day.`,
    how: 'Click your motorway connection and press Limit visitors; press it again to lift the limit.',
    facts: [['Where', 'a motorway connection of yours (visitors come in by road)'], ['Effect', `${Math.round(VISITOR_LIMIT_SHARE * 100)}% of its visitors come`], ['Cost', 'the visitor tax of those who stay away']],
  },
  'road-oneway': {
    title: 'One-way streets',
    what: 'North Parade runs east and South Parade west, a pair round a block of homes: each has two lanes going its way, so a junction on it has half the crossing movements of a street\'s. Drivers keep to the lane for their next turn. Routes never go against the arrows, so a pair carries a busy route both ways.',
    how: ROAD_CLASS_DEFS[2].howTo, facts: roadFacts(2),
  },
  'road-avenue': {
    title: 'Avenue',
    what: 'Kingsway is two tiles wide: two lanes each way either side of a planted reservation, twice what a street carries, and the main road at a junction. Cars cross the reservation and turn round only at junctions; Market Street crosses it here, its two junction tiles working as one set of lights. A car crossing, or turning left across it, waits in the reservation\'s median box for a gap in the far carriageway, and on the last two tiles before the lights the left lane is for turning left.',
    how: `${ROAD_CLASS_DEFS[3].howTo} Dragged over a street it widens it in place, keeping its junctions, and asks before demolishing what stands in the new row.`, facts: roadFacts(3),
  },
  'road-motorway': {
    title: 'Motorway',
    what: 'A motorway from its own connection at the west edge: two lanes each way at a quarter faster than a street, with no buildings on it. Market Street meets it at a diamond interchange, over it on a bridge with slip roads off and on each carriageway; at the perimeter road it runs on into the town\'s street. The homes beside it face Kingsway, not the motorway.',
    how: ROAD_CLASS_DEFS[4].howTo, facts: roadFacts(4),
  },
  'road-pedestrian': {
    title: 'Pedestrian street',
    what: 'Cheapside is paved from wall to wall for walkers and bikes, with bollards where Market Street ends at it. No cars but fire engines and ambulances on a call, and delivery lorries before 10:00 and after 19:00. Its shops see every passer-by: the footfall bonus is left for the leisure and commerce cards to use.',
    how: ROAD_CLASS_DEFS[5].howTo, facts: roadFacts(5),
  },
  'junction-group': {
    title: 'Avenue crossing',
    what: 'Regent Avenue crosses Queen\'s Avenue: four junction tiles, one for each carriageway over each, working as one junction with one set of lights. It runs four phases: north-south straight on and right, then north-south left turns on their own (a green arrow), then the same east-west. On each approach the last two tiles before the lights hold the lanes, the left one for turning left, so through traffic is never stuck behind a car waiting to turn. Where an avenue meets a street (Market Street on Kingsway) the lights run two phases, and cars turning left across the avenue wait for a gap in the reservation\'s median box.',
    how: 'Lay two avenues across each other with Road (3), Avenue; with Traffic signals the lights come by themselves.',
    facts: [['Tiles', '2×2, one controller'], ['Phases', 'four, with protected left turns'], ['Turn lanes', 'the last two tiles of each approach'], ['Technology', `${techLine('avenues')}; ${techLine('signals')}`]],
  },
  'road-look': {
    title: 'Streets',
    what: 'Close up, every road is drawn as a street: pavements raised behind a kerb, corners rounded where roads meet, dropped kerbs with tactile paving at each crossing, and the paint a driver reads. Centre lines turn to long warning dashes before a junction. Lights get stop lines and turn arrows, junctions without them get give-way lines and triangles, zebras have flashing Belisha beacons, and busy crossroads get a yellow box. Lamp columns line the pavements and each lamp comes on at its own dusk. Trees line the verges beside gardens and open land. Busier streets wear darker and gather patches.',
    how: 'Nothing to build: lay roads. The markings follow the layout and the lights. At a T-junction the side road gives way, at a crossroads the shorter road gives way, and every approach stops at lights. Trees grow beside homes\' gardens and open grass. Far away a street is drawn flat to the same plan.',
    facts: [['Lamps', 'every third tile, alternating sides, three designs by street'], ['Zebras', 'mid-block on quiet straights, and at a third of unsignalled junction mouths'], ['Box junctions', 'busy crossroads, and some at lights'], ['Street trees', 'beside houses and open grass, most streets in stretches']],
  },
  'news-heli': {
    title: 'News helicopter',
    what: 'A media centre keeps a news helicopter on its roof pad, in its channel\'s colours. When its channel covers a story worth the flight (a fire, an explosion, a rank, a big opening, a new line) it takes off a few minutes later, flies to the scene and circles it, or hovers and creeps round, while the story is live and for a while after, then flies home. The newest live story wins, and with none on it flies a traffic watch in the 08:00 and 17:00 rush. Its flights are worked out from the story log everyone already has, so everyone sees the same helicopter. Here it covers the fire drill.',
    how: 'Build a media centre (Media, tier 3) and keep it staffed. Hover the helicopter for what it is covering, click it for its crew, I or O to ride in it.',
    facts: [['Helicopters', '1 per media centre'], ['Over the scene', 'while live, at least 1.5 game hours'], ['Orbit', 'its own radius, height and speed each sortie'], ['Technology', 'Media centres (culture track)']],
  },
  'live-tv': {
    title: 'Live on TV',
    what: 'Indoors, in the first-person view, the TV shows what is on its channel: Civitas 1, Civitas 2 or a player\'s own channel, each with a schedule of its own (the news at six, quizzes, films, cartoons in the afternoon, the match on a stadium\'s event night, teletext or the test card after 01:00). While a news helicopter is over a story its channel cuts to its camera: a real low-resolution picture of the city, a few frames a second, with the headline in the lower third and a LIVE bug, and the big screens\' news turn carries the same pictures. Teletext pages are drawn from the town\'s own story log, jams, results, prices and rank. This stop follows someone at home here watching television, when someone is.',
    how: 'Select someone at home in the evening and press I or O. The citizen panel says what they are watching. The live pictures are off on the low graphics preset (?fx=0).',
    facts: [['Channels', 'Civitas 1, Civitas 2, each player\'s media channel'], ['Live feed', '160×90 at 5 frames a second, one at a time, only while on screen'], ['Teletext', 'news, weather, travel, sport, prices, your town']],
  },
  'cab-office': {
    title: 'Cab office',
    what: 'A minicab firm in a shopfront (about one shop lot in eleven), its lit sign in taxi yellow. Every member of its staff drives: cabs with a roof sign lit while for hire, waiting at the nearest station or airport rank, and private-hire drivers who log on from home in their own car and wait where the last fare ended. People without a car to hand, out for the night or arriving with a suitcase book the nearest free one when it beats walking, the bus and driving; they wait at the kerb, ride, and pay at the door.',
    how: 'Nothing to build: zone shops and some become cab offices. The tooltip shows its drivers on shift, the taxis out and the fares today; a driver\'s panel links to the cab they are out in.',
    facts: [['Fare', `$${TAXI.flagfall} + $${TAXI.perTile} a tile`], ['Split', `${Math.round(TAXI.officeCut * 100)}% to the office for a cab, ${Math.round(TAXI.platformCut * 100)}% for private hire`], ['Reach', `the nearest free taxi within ${TAXI.reach} tiles`], ['Rota', 'round the clock, four shifts']],
  },
  takeaway: {
    title: 'Takeaway',
    what: 'Every café, bar and restaurant cooks for delivery, and a quarter of their staff are riders on bicycles and mopeds. Homes order at lunch and dinner; shortly before an order is ready the nearest free rider is sent to the kitchen, takes up to three orders for homes close together, rides at the kerb edge past queues of cars, and steps off at each door. The meal is taxed like a visit and the venue\'s owner gets the delivery fee.',
    how: 'Nothing to build: zone shops. The tooltip shows its riders, the orders in the kitchen and the deliveries today.',
    facts: [['Orders', `${FOOD.lunchRate} a household at lunch, ${FOOD.dinnerRate} at dinner`], ['Meal', `$${FOOD.mealBase} + the venue's level, $${FOOD.fee} delivery, $${FOOD.tip} tip`], ['Riders', `${Math.round(MOBILE.riderShare * 100)}% of staff, ${Math.round(MOBILE.bicycleShare * 100)}% on bicycles`]],
  },
  'waste-depot': {
    title: 'Waste and recycling depot',
    what: 'About one industrial lot in twelve is the waste depot. Each 16-tile district has its own collection weekday: from 06:30 the depot sends a bin lorry per three collectors on shift round every home\'s kerb, where it stops while the loaders tip the wheelie bins (the traffic waits behind it); two weekdays later a sweeper drives the district\'s streets with its beacon flashing. The homes\' owner pays the depot\'s owner per home emptied.',
    how: 'Nothing to build: zone industry within reach of your homes. A home\'s tooltip shows its bin day and when its bins were last emptied; the depot\'s shows its crews, the lorries out and the homes emptied today.',
    facts: [['Reach', `districts within ${REFUSE.reach} tiles`], ['Fee', `$${REFUSE.feePerHome} a home emptied`], ['Crew', `${REFUSE.crew} a lorry, Monday to Friday from 06:00`]],
  },
  'parcel-depot': {
    title: 'Parcel depot',
    what: 'Warehouses, freight depots and distribution centres (and some other industry) are parcel depots, and a third of their staff drive courier vans. Homes order parcels through the day; vans leave in a morning and an afternoon wave with up to 14 parcels, pull up at each kerb in turn and come back. The depot\'s owner is paid per parcel.',
    how: 'Nothing to build: zone industry. The tooltip shows its couriers, the parcels waiting and those delivered today.',
    facts: [['Parcels', `${COURIER.parcelRate} a household a day`], ['Vans', `from ${COURIER.waves.map((h) => `${h}:00`).join(' and ')}, ${COURIER.vanLoad} parcels each`], ['Fee', `$${COURIER.fee} a parcel`]],
  },
  'level-crossing': {
    title: 'Level crossing',
    what: 'A road over railway track. Barriers come down across the road ahead of each train and the traffic waits until it has passed. Here the freight line\'s trains cross the street down to the river.',
    how: 'Drag track straight across a straight road, or lay a road straight across straight track. Not at a junction or a corner, not where the track turns, and no road may run along the track beside it.',
    facts: [['Tool', 'Railway track or Road, drag across'], ['Needs', 'straight track, a straight road carrying on both sides'], ['Technology', techLine('rail')], ['Cost', `${money(CROSSING_COST)} on top of the track`]],
  },
  river: {
    title: 'The river',
    what: `Open water: nothing is built on it and only bridges cross it, each up to ${BRIDGE_MAX_SPAN} tiles of water between road on both banks. The quarter beyond it is reached only over its four bridges, one of each style, so everyone who lives or works there crosses one.`,
    how: 'Water is part of the terrain: no tool makes or fills it. Drag a road straight across it to bridge it.',
    facts: [['Bridges here', 'stone arch, steel girder, bascule, suspension'], ['Longest bridge', `${BRIDGE_MAX_SPAN} tiles of water`], ['Technology', techLine('bridges')]],
  },
  helipads: {
    title: 'Helipads',
    what: 'Helicopters land on the helipads drawn on buildings: air ambulances at the hospitals, the police helicopter at police headquarters, executive flights on the tallest offices (the headquarters and the office tower across the river), and the royal flight at Buckingham Palace in the London demo. The timetable is worked out from the pads alone, so everyone sees the same flights.',
    how: 'Nothing to build: a hospital, police headquarters or tall office whose design has a pad brings its service. Hover a helicopter for its callsign and errand, click it for its crew, and press I or O to ride in the cockpit.',
    facts: [['Air ambulance', '2-5 flights a pad a day, some go on to a second hospital'], ['Police', '2-3 a day, an hour or more on the pad'], ['Executive', '1-3 a day, some hop between towers'], ['Royal', 'Buckingham Palace (London demo)']],
  },
  blackout: {
    title: 'Blackout',
    what: 'A fault on a substation cuts the power to every street its supply runs along: the lamps go out, and the windows drop to a candle here and there, with the odd building on a generator burning bright. The nearest power depot sends a repair van; while the crew digs the streets stay dark, and when they are done the lights come back block by block. Homes in a cut do not grow. In this demo the substation by the perimeter road fails every six game hours, so its streets are dark about half the time.',
    how: `Keep a power depot (Power stations) near the middle of your network: a fault stays dark while its van drives there and the crew works ${UTIL.repairHours} game hours. Without one a contractor takes ${UTIL.contractorHours}. A second substation whose streets overlap keeps a fault's patch on the network's other links.`,
    facts: [['Faults', `about one per substation in 25 game days, none in the first ${UTIL.faultsFromDay} days of a world`], ['Repair', `${UTIL.repairHours} game hours on site`], ['Never cut', 'a patch with a hospital or police station, in rolling cuts']],
  },
  sound: {
    title: 'Sound',
    what: 'The city is heard as well as seen, from real recordings (Freesound, CC0) with the old synthesis as the fallback, and every instance varies in pitch, level and start. The street is heard one vehicle at a time: at street zoom each car, van, lorry, bus, moped and bicycle that passes close to the camera has its own pass-by, panned along its path and falling in pitch as it goes by (a bicycle rings its bell now and then, a car close in may honk), footsteps follow the walkers close in and a busy pavement talks, and a fire engine or ambulance on a call carries its siren with it, louder and higher as it nears, lower as it goes, until it arrives. Each thing on screen also has a bed: traffic rumbles louder with the cars drawn, wind rises as you zoom out, a crowd murmurs where people are, works and power stations hum, water laps; a market by day, a pub in the evening, children at a school, a stadium crowd, a fountain. Each district has a sound of its own, chosen by which kind of building most of the street is (a soft-max over the zone shares, so a mixed street still reads as one thing): at street zoom listen for a factory floor with metal on metal, a reversing lorry and steam over the industrial estate; tills, shop doors, music from a doorway and in the busiest streets a busker over the shops; air handling, a revolving door and a lift bell, all quieter after 19:00, in the offices; a quiet street with a lawnmower, a dog, children, a radio through a window and front doors over the homes; a murmuring crowd and camera shutters at a landmark square. Birds sing only by day where there are parks and homes, with a dawn chorus from half past four; owls call at night; gulls over water, pigeons in the squares. A church or Parliament in view rings the hour (a peal at ten), a police station sends out a siren now and then, builders hammer and drill where a site is going up, fireworks bang over a celebration, and a signal crossing beeps while it holds the cars. Ride a vehicle in first person and it takes over while the city drops 6 dB: a bus is a diesel with its doors hissing, a train a rumble over rail joints, a tube train a boom, a boat a chug. On the London tour every stop has a sound of its own, played when the camera arrives: Big Ben striking at Parliament, gulls and a boat horn on the river, a train arriving under Waterloo, a crowd at Wembley, ravens at the Tower. The beds follow the place and dip under each cue.',
    how: 'Nothing to build. Sound starts on your first click or key press. M mutes and unmutes; the sound switch and volume slider are in the line at the bottom left, and the choice is kept in this browser. Fly down to street zoom over a factory, a shopping street, an office block, a terrace and a landmark in turn and the bed changes with them. Press Shift+S (or the audio chip in the top bar) for the audio readout: the district the ambience hears ("commercial 0.62 wins, industrial 0.21, residential 0.17; ducked"), the street line (pass-bys in the last minute, sirens following, walkers close), every voice sounding now with its bus, level, pitch and recording, and why it is sounding (a bed shows the cars, walkers, tiles, zoom and hour it is made from; a tour cue its stop; a ride its vehicle; a pass-by its vehicle, how near, how fast and which way; a siren its vehicle and whether it is nearing; an event its trigger), the ducking, and a log of the last 40 starts and stops. Shift+M is the perf readout.',
    facts: [['Mute', 'M, or the sound chip in the top bar'], ['Readout', 'Shift+S, or the audio chip: what is playing now and why, with a log; free when closed'], ['Volume', 'slider at the bottom left, kept in this browser'], ['Made of', 'Freesound CC0 recordings (audio/CREDITS.md), loaded the first time each is wanted, over Web Audio synthesis as the fallback'], ['Cost', 'about 0.3 ms every quarter second'], ['Credits', 'Recordings from Freesound.org, all CC0; see client/src/audio/CREDITS.md']],
  },
  ranks: {
    title: 'Settlement ranks',
    what: `A town works its way up from ${RANKS.map((r) => r.name).join(' to ')}. Each rank has needs measured on the player's own land (residents, jobs filled, shops, a park, police and fire cover, two-storey streets, days in the black, schools or a bus line), pays a charter grant when it is reached and, on a frontier, grows the free charter by a ring of land. The rank chip in the top bar shows the next rank's progress; its card lists the needs and a milestone feed, and each rank reached is celebrated with fireworks over the town, every shell its own. This stop plays a celebration over the town: the showcase is a sandbox, so it has no ranks of its own.`,
    how: 'Play a live world or a local game: the rank chip appears beside the treasury. Follow the goals card for the first hour; the rank card takes its place once the chain is done.',
    facts: RANKS.slice(1).map((r): [string, string] => [r.name, `${r.needs.map((q) => `${q.target.toLocaleString('en-GB')}${q.frontier ? ` (${q.frontier.toLocaleString('en-GB')} on a frontier)` : ''} ${q.label}`).join(', ')}; $${r.grant.toLocaleString('en-GB')}, ${r.side}×${r.side} on a frontier`]),
  },
  'focus-groups': {
    title: 'Focus groups',
    what: `What the people of a parcel care about (docs/motivation.md). Every citizen has six values, ${VALUE_NAMES.join(', ')}: a blend of one or two characters (the grafter, the homemaker, the climber, the local, the easygoing, the free spirit), drawn toward the people already living where they move in, and passed on to their children. Values decide the jobs they take (pay, getting on, a short commute, friends at work), the homes they move to, the nights out they choose and how much each part of life weighs in their happiness. Now and then someone changes job or moves house of their own accord. The citizen panel says it in words; with focus groups a home's tooltip shows its parcel's mix in percentages.`,
    how: 'Click a citizen: the Life section opens with what they care most about ("Cares most about family; restless") and any recent change of job or home. Hover a home once you have focus groups for its parcel\'s mix.',
    facts: [['Values', VALUE_NAMES.join(', ')], ['Technology', techLine('focusgroups')], ['Changes of their own accord', 'under 1% of workers and households a day']],
  },
  'world-map': {
    title: 'The world map',
    what: 'The whole world from above, flat and north-up: land use in colour (homes green, shops blue, industry amber, offices violet, civic red, darker where buildings are taller), every owner\'s land outlined in their colour with their name, estates and parcels named, and the bus, rail and underground lines drawn in theirs. It streams no buildings or people, only a small land-use summary of each changed part of the world, so it stays quick however big the world grows. The railway land and the quarter beyond the river are one estate here: two parcels managed as one.',
    how: `Tab, the map chip, or zoom out past the 3D view's limit; zoom back in to return. Drag to pan, click a parcel for its area, buildings, population, jobs and book value. On your own land: shift-click neighbouring parcels and Combine them (a pair that makes a rectangle of up to ${MAX_PARCEL_EDGE} a side merges, the rest become one estate sharing name, colour and tax rate), Split one along a line you drag, rename it or give it a colour.`,
    facts: [['Key', 'Tab (or the map chip; Esc leaves)'], ['Combine', `rectangles up to ${MAX_PARCEL_EDGE} a side merge; the rest form an estate`], ['Split', 'a straight cut; both parts keep dry land; never through a building'], ['Book value', 'land, roads, zoning, building work and civic prices']],
  },
  'sea-gate': {
    title: 'To the sea',
    what: 'Where the basin opens to the sea, beyond the edge of the town. Container ships, coasters and ro-ro ferries come in over the horizon here for the cargo port, a tug meets each container ship and leads it in, and the trawlers go out this way to the fishing grounds before dawn. Boats work to a pure timetable, so everyone sees the same ships: each harbour sails lanes over the water, found round the bridges its boats cannot clear, and a ship too tall for a bridge waits for a bascule to lift.',
    how: 'Nothing to build. A scenario declares where its water meets the sea; in a world of its own, a lake of 1,500 tiles or more counts as open water reaching the sea, and its ships come in over its far horizon. A cargo port needs a way to the sea: a smaller lake gets pleasure boats, fishing and ferries only.',
    facts: [['Ships', 'container ships, coasters, ro-ro ferries, barges'], ['Fishing', 'trawlers out from about 04:00, home from noon, not on Sundays'], ['Bridges', 'each style has a clearance; tall boats book a bascule\'s lifts']],
  },
  'high-street': {
    title: 'Adverts on the high street',
    what: `About one shop or venue in three has an ad frame, and so does every bus shelter and every building site's hoarding: posters on a shop's flank, a 48-sheet billboard over a car park or a flat roof, banners at a stadium's gates. Empty frames show blank paper. A player makes a campaign (a theme and a claim from the table, filled with one of their parcels' or workplaces' names, in a look of their own) and rents frames for it; rent goes to whoever owns the frontage. Posters wear: they fade, get tagged by the local crew and tear, faster in streets with people out of work and no services nearby. Here three campaigns are up at three ages: fresh, tagged and wrecked.`,
    how: 'Unlock Advertising (zoning track), then the ads chip opens the Campaigns panel: make a campaign, then "Pick frames" (free frames glow; click a building to rent its frame) or "Rent 3 nearest". Who sees a poster and what it does to them comes in a later update.',
    facts: [['Frames', `${AD_SIZES.map((s) => AD_SIZE[s].label).join(', ')}`], ['Rent a day', AD_SIZES.map((s) => `${AD_SIZE[s].label} $${AD_SIZE[s].rent}`).join(', ')], ['Technology', 'Advertising (zoning track)']],
  },
  'house-fire': {
    title: 'House fire',
    what: 'Homes and works catch fire now and then, more often the bigger and older they are. The nearest staffed fire post or station in reach sends its engine on blue lights, through red signals and, when the traffic stops, down the middle of the road; once it is there the crew put it out, and the damage is what had burnt by then. With no engine in reach the building burns down and its people leave. Either way the owner pays, under "Fire damage" in the ledger. In this demo the house beside the fire post catches light every so often, so the engine is always about to turn out.',
    how: `Place a fire post or fire station (Emergency services) within ${FIRE.reach} tiles of your homes and keep it staffed. A town's first fire is a warning that never costs a building: the neighbours' bucket chain saves it when no engine comes.`,
    facts: [['Engine reach', `${FIRE.reach} tiles, or the station's own cover when wider`], ['Unattended', `burns down in about ${FIRE.burnHours} hours`], ['Bill', `${Math.round(FIRE.costShare * 100)}% of the building's value times the share burnt`], ['Technology', techLine('firepost')]],
  },
  funeral: {
    title: 'A funeral',
    what: `Citizens die of old age and illness, and in fires, explosions and accidents at work. The body is left where they died; a funeral director's hearse collects it, and ${DEATH.serviceDaysMin} to ${DEATH.serviceDaysMax} days later the hearse carries the coffin to a chapel or crematorium, the family and close friends gather (close family take the day off) and the grave is filled, a headstone of its own standing on it from then on, weathering and leaning with the years, with flowers on a new grave and on some anniversaries. Click a headstone for the person: their dates, how they died, the family tree. Partner, children and parents grieve for some days, longer while the body waits for a place; the estate pays the funeral director's and the resting place's fees and the rest goes to the partner, then the children. In this demo a funeral goes to the churchyard every couple of hours.`,
    how: 'Unlock Remembrance (civic track, about the Village rank), then place a funeral director and a churchyard, cemetery or crematorium within 80 tiles of each other. With no space in reach the dead wait at the hospital mortuary under the No burial space badge.',
    facts: [['Service', `${DEATH.serviceDaysMin}-${DEATH.serviceDaysMax} days after death, ${DEATH.serviceHours} hours`], ['Mourners', `close family and friends, up to ${DEATH.mournersMax}`], ['Fees', 'from the estate, to the owners (ledger "Funeral fees", "Burial and cremation fees")'], ['Technology', techLine('churchyard')]],
  },
  'fire-spread': {
    title: 'Fire spreading',
    what: `A fire nobody is fighting can spread to the buildings next door: every game hour each building whose lot touches it may catch, hardly at all in the first hour, about one chance in ${Math.round(1 / FIRE.spreadMax)} an hour near burn-out. Terraces and tall blocks catch more readily than detached houses, a building touching only at a corner less. A road, a park or an empty lot between is a firebreak. Once an engine crew is hosing it down the chance is almost nothing. A fire that spreads is the next owner's loss: their building, their bill. In this demo nobody calls the fire brigade for a while, so the fire runs along the row of houses until the engines come.`,
    how: `Keep every home and works within ${FIRE.reach} tiles of a staffed fire post or station, with engines to spare: a post has one, a station two. Gaps in a street (a road, a park) stop a fire running along it.`,
    facts: [['Spread', `up to ${Math.round(FIRE.spreadMax * 100)}% an hour to each building touching it, unattended`], ['Attended', `${Math.round(FIRE.spreadAttended * 1000) / 10}% an hour`], ['Firebreaks', 'roads, parks, empty lots'], ['Burning at once', `${FIRE.spreadPerOwner} in one owner's land, ${FIRE.spreadWorld} in the world`]],
  },
  'fire-blast': {
    title: 'Explosion at the works',
    what: `A burning works can blow up: the longer it burns with nobody fighting it, the likelier (about one chance in ${Math.round(1 / FIRE.blastMax)} an hour near burn-out; hardly ever once the crew are on it). The blast wrecks ${Math.round(FIRE.blastDamage * 100)}% of the works there and then, sets light to every building within ${FIRE.blastReach} tiles, across the road too, and costs its owner a share of its value on top of the fire, as "Explosion damage" in the ledger and a line in the milestone feed. In this demo the works blows a little after it catches light, every time.`,
    how: `Keep fire cover over your industry, and keep homes back from it: a road and a row of works or a park between take the edge off a blast.`,
    facts: [['Where', 'industrial lots and works only'], ['Blast reach', `${FIRE.blastReach} tiles`], ['Bill', `${Math.round(FIRE.blastCostShare * 100)}% of the works' value, plus the fire`]],
  },
  'pool-of-london': {
    title: 'The Pool of London',
    what: 'The reach between London Bridge and Tower Bridge, the old heart of the port. Tower Bridge is the one bridge here a tall boat can pass, and only with its leaves up: St Katharine Docks\' yachts and sailing barges are booked into its lifts (a few a day, on a clock), wait below the bridge for the next one if they must, and come up into the Pool until London Bridge, too low for them, turns them round. Everything else on the river, from the RB1 river buses to the barges, passes under every bridge.',
    how: 'Nothing to build: a bascule bridge lifts on its own clock, and a boat too tall for the closed span books a lift. Each style of bridge has a clearance (a stone arch is the lowest, then a steel girder, a suspension span, the bascule closed), and a boat\'s lanes go only under the bridges it clears.',
    facts: [['Tower Bridge', 'lifts 0-3 times a day, 07:00-21:00'], ['Tall boats', 'yachts, sailing barges, dinghies, ships'], ['Under every bridge', 'river buses, barges, narrowboats, motor cruisers']],
  },
  'tube-crossover': {
    title: 'Under Waterloo',
    what: 'The Northern and Jubilee lines meet under Waterloo: two entrances a short walk apart and from the rail station\'s door, so riders change between the two lines and the trains to Clapham Junction. Underground, lines never share a tunnel; where one must cross another it bores straight across it at a crossover, the north-south bore dipping under the east-west one. In the underground view (N) each line glows in its colour, platforms are lit, and the trains run in twin bores, out in one and back in the other.',
    how: `Nothing extra to build: save a line whose tunnel has to cross another's and the boring picks a crossover, straight across at right angles (${money(METRO.crossoverCost)} on top of the tunnel). Lines may not cross on a curve, a junction or a platform. A change between lines is a walk of up to ${TRANSIT.transferWalk} tiles between their stops.`,
    facts: [['Tool', 'lines panel (top bar); N for the view'], ['Crossover', `${money(METRO.crossoverCost)} on top of the tunnel`], ['Change walk', `${TRANSIT.transferWalk} tiles`], ['Technology', techLine('metrostation')]],
  },
};
const LINE_CAPTIONS: Record<TransitMode | 'freight', Omit<Caption, 'title'>> = {
  bus: {
    what: 'A bus line: the owner\'s stops in calling order, run there and back (or as a loop) by buses from a depot, one bus per driver on shift, 05:30 to 00:30. Riders whose car is at home weigh it against walking and driving, wait at the stop and pay $2 a ride to the owner.',
    how: 'Open the lines chip in the top bar, make a line, click your stops in order, pick loop or there and back and the buses wanted. Each stop needs a plain stretch of road beside it, not a junction; the depot\'s drivers must be able to reach the route. Click a bus for its passengers, pick one (or follow someone who boards) and press I or O to ride along as a passenger, from a seat a few rows back.',
    facts: [['Tool', 'lines panel (top bar)'], ['Technology', techLine('lines')], ['Fare', '$2 a ride, children free, retirees half']],
  },
  rail: {
    what: 'A passenger rail line between stations. Trains run a timetable that is a pure function of the line and its route, 05:00 to 01:00, 40 riders a carriage; a there-and-back line runs one train, a loop as many as fit.',
    how: 'Lay track behind each platform and join it up, then open the lines panel and pick the stations in calling order. Consecutive stations must be joined by track a train can run without reversing. Click a train for its riders; pick one and press I or O to ride as a passenger in a carriage, at a window seat (or I or O on the train for the driver\'s cab).',
    facts: [['Tool', 'lines panel (top bar)'], ['Technology', techLine('railstation')], ['Fare', '$2 a ride']],
  },
  metro: {
    what: `An underground line. Each station is a kiosk or a hall on the surface with a platform straight below it; the tunnel between them is bored when the line is saved, under roads, blocks and rivers alike. Trains of tube cars (${METRO.carRiders} riders a car, as many cars as the shortest platform has tiles) run rail's timetable, 05:00 to 01:00, out in one bore and back in the other, so a there-and-back line runs many trains, and they are never in traffic. Riders change to a bus or a train at any stop within a ${TRANSIT.transferWalk}-tile walk of the entrance. Press N for the underground view.`,
    how: `Pick Underground station in the Transport group (Z and C turn the platform), put the entrances on your land beside a road, then open the lines panel and click them in calling order. The preview shows the new tunnel and its cost (${money(METRO.tunnelCost)} a tile, ${money(METRO.wetTunnelCost)} under water, ${money(METRO.crossoverCost)} more to cross another line); tunnel that already exists is free. Lines never share tunnel or a platform: they cross at right angles. To ride the tube as a passenger, click a train in the underground view (N), pick a rider and press I or O: a seat looking across the car as the bore wall and the platforms slide by the window opposite.`,
    facts: [['Tool', 'lines panel (top bar)'], ['Technology', techLine('metrostation')], ['Fare', '$2 a ride, children free, retirees half']],
  },
  ferry: {
    what: `A river bus line between ferry piers. Catamarans of ${FERRY.riders} places run a timetable on the water, 05:00 to 01:00, under every bridge (they are low enough for all of them) and never in traffic; a there-and-back line runs several boats, which keep to their side of the river as they pass, and lie nose to tail at each pier, the one coming in behind the one going out. Riders wait on the pontoon and change to a bus, a train or the underground within a ${TRANSIT.transferWalk}-tile walk.`,
    how: 'Put ferry piers on your land at the water\'s edge, the pontoon over the water with open water behind it and a tile beyond each end of the berth, then open the lines panel and click the piers in calling order. The route is found on water at least three tiles wide; one line calls at a pier.',
    facts: [['Tool', 'lines panel (top bar)'], ['Technology', techLine('ferrypier')], ['Fare', '$2 a ride, children free, retirees half']],
  },
  freight: {
    what: 'A freight line between two yards. Deliveries from factories within 12 tiles of one yard to shops within 12 tiles of the other go by train when that is shorter: a truck to the yard, containers on the train, a truck for the last mile. The shipper pays the line owner $4 a container.',
    how: 'Put a freight yard near industry and another near shops, at least 14 tiles apart, join their docks with track and make a line that calls only at yards.',
    facts: [['Tool', 'lines panel (top bar)'], ['Technology', techLine('freightyard')], ['Fee', '$4 a container']],
  },
};

// ---------------------------------------------------------------- the tour

export interface TourStop {
  id: string;
  section: SectionId; sectionName: string;
  title: string; what: string; how: string;
  facts: [string, string][];
  /** camera: ground point, distance, yaw and pitch for the rig */
  focus: [number, number]; dist: number; yaw: number; pitch: number;
  /** kind id, for the swatch and the live tooltip */
  kind?: number;
  /** the structure, for its outline and marks */
  placed?: Placed;
  /** an area to outline (a block, a runway strip, the extent of a line) */
  rect?: DemoRect;
  /** tiles to mark (track drags, line stops) */
  path?: DemoXY[];
  /** the tile to ask the server about for live stats */
  inspect?: DemoXY;
  line?: { mode: TransitMode; number: number; colour: number };
  /** 'under': the tour turns the underground view on at this stop (a metro line, a spot under ground); 'map': the world map;
   *  'ranks': a rank-up celebration plays over the stop (docs/ranks.md); 'tv': the first-person view of someone at home
   *  in the stop's rect watching television, when someone is (docs/media.md section 8); 'traffic': the congestion overlay
   *  and the Traffic panel open (R5) */
  view?: 'under' | 'map' | 'ranks' | 'tv' | 'traffic';
  /** the hour of the day the stop is shown at (client tour.ts pins the light until the next stop), from its placement */
  hour?: number;
  /** what the stop sounds like (demo/tourSound.ts): cues played when the camera arrives, a bias on the ambient beds, or 'ambience' for the beds alone; the client tour plays it */
  sound?: TourSound;
}

const kindIdOf = (s: string): number => (KIND_ID as Record<string, number>)[s] ?? 0;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const FAMILY_WORD: Record<string, string> = { residential: 'homes', commercial: 'shops', office: 'offices', industrial: 'works' };
/**
 * What a merged lot is and how it comes about (docs/buildings.md "Merged lots", "Block interiors"), for a growable kind
 * bigger than 1×1 with no blurb of its own: nobody places them, so their catalogue entries carry no tool text.
 */
function mergedText(k: KindManifest): Pick<Caption, 'what' | 'how'> | null {
  const f = GROW_FORMS.flat().find((g) => g.kindId === k.kindId);
  if (!f) return null;
  const lots = FAMILY_WORD[k.family] ?? k.family;
  const levels = f.minLevel === f.topLevel ? `level ${f.minLevel}` : `levels ${f.minLevel} to ${f.topLevel}`;
  return f.deep
    ? { what: `A ${k.name}: a frontage building that has grown back into the landlocked middle of its block, one lot wide and two deep with its door on the road (${levels}). The middle of a 4×4 block has no road of its own, so only the building in front can use it.`,
        how: 'Nobody places it. Zone a block all round and growth builds the middle into deep plots from the frontage; a block ringed by homes keeps its middle for a communal garden instead.' }
    : { what: `A ${k.name}: ${f.w}×${f.h} lots of ${lots} merged into one building by growth (${levels}). When a busy building wins the demand roll, it may take in the lots beside it of the same zone and owner, and everyone who lived or worked there moves into the new building.`,
        how: 'Nobody places it: zone the land and let it grow. A merge needs neighbouring lots of one zone and one owner, its door on a road, demand, and High-rise for levels 4 to 7. Each neighbourhood\'s ambition, a hash, caps how tall its streets get, so not every block turns into towers.' };
}

function kindCaption(k: KindManifest, door: DemoXY, rot: number, level?: number): Caption {
  const fp = footprintOf(k.kindId), multi = fp.w * fp.h > 1;
  const l = k.levels[0];
  const facts: [string, string][] = [];
  if (k.tool) facts.push(['Tool', `${k.tool.label}${k.tool.key ? ` (${k.tool.key})` : ''}`]);
  facts.push(['Footprint', `${fp.w}×${fp.h}${multi ? `, door faces ${FRONT_NAMES[rot]} here${k.tool ? ' (Z/C turn it)' : ''}` : ''}`]);
  facts.push(['Placed at', `${door[0]}, ${door[1]}`]);
  facts.push(['Technology', k.tool ? techLine(k.tool.id) : 'grows by itself']);
  if (k.flags.growable) facts.push(['Zoning', `${money(ZONE_COST)} a tile, then it grows with demand`]);
  else facts.push(['Cost', `${money(CIVIC_COST[k.kindId] ?? l.cost ?? 0)}${l.upkeep ? `, ${money(l.upkeep)} a day upkeep` : ''}`]);
  const lv = level ?? firstLevelOf(k.kindId), held = k.flags.growable ? capacityOf(k.kindId, lv) : l.capacity;
  if (held) facts.push([k.flags.growable && k.family === 'residential' ? 'Residents' : 'Jobs', `${held}${k.flags.growable ? ` at level ${lv}${level ? ' here' : ''}` : ''}`]);
  const text = k.blurb ? null : isGrowableId(k.kindId) && multi ? mergedText(k) : null;
  return { title: cap(k.tool?.label?.replace(/\s*\(.*\)$/, '') ?? k.name), what: k.blurb ?? text?.what ?? '', how: k.howTo ?? text?.how ?? '', facts };
}

/** Where the camera stands for a footprint: in front of the door, a little to the side, far enough to see it whole. */
function framing(x: number, y: number, w: number, h: number, rot = 0, far = 1, aside = 0.45): Pick<TourStop, 'focus' | 'dist' | 'yaw' | 'pitch'> {
  const [fx, fy] = FRONT[rot & 3];
  const size = Math.max(w, h);
  return { focus: [x + w / 2, y + h / 2], dist: Math.min(150, Math.max(13, (9 + size * 2.6) * far)), yaw: Math.atan2(fx, fy) + aside, pitch: size > 12 ? 0.95 : 0.72 };
}
const bbox = (pts: readonly DemoXY[]): DemoRect => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1];
};

/** The tour stops of a demo, in TOUR order, for the sections it seeds. Pure: the client and the checks call it. */
export function demoTour(id: DemoId): TourStop[] {
  const sections = demoSections(id);
  const out: TourStop[] = [];
  const d = DEMO_BY_ID.get(id)!;
  for (const sid of d.tour ?? TOUR) {
    if (sid === 'welcome') {
      out.push({ id: sid, section: 'downtown', sectionName: d.name, title: d.town ? `Welcome to ${d.name}` : `Welcome to the ${d.name.toLowerCase()}`, what: d.blurb,
        how: 'Next and Previous fly the camera from object to object; Autoplay runs the tour by itself. Hover anything for its live tooltip. You have every technology and unlimited funds here: buy land at the edge and try the tools. Reset demo puts the town back exactly as it was.',
        facts: sections.map((s) => [s.name, s.blurb.split(/(?<=\.)\s/)[0]] as [string, string]),
        ...(d.view ?? { focus: [4, 0], dist: 118, yaw: Math.PI / 4, pitch: 1.0 }) });
      continue;
    }
    for (const s of sections) {
      const base = { section: s.id, sectionName: s.name };
      const p = s.placements?.find((q) => (q.id ?? q.kind) === sid);
      if (p) {
        const kid = kindIdOf(p.kind), k = kindManifest(kid);
        if (!k) continue;
        const rot = p.rot ?? 0, placed = footprintOf(kid).w * footprintOf(kid).h > 1 ? placedFromDoor(kid, p.door[0], p.door[1], rot) : undefined;
        const area = placed ? [placed.ax, placed.ay, placed.w, placed.h] as const : [p.door[0], p.door[1], 1, 1] as const;
        // a tall landmark (the Shard is 9.6 tiles) is framed from further out so its top stays in view
        const tall = Math.max(...k.levels.flatMap((l) => l.designs.map((dz) => dz.height)));
        const c = kindCaption(k, p.door, rot, p.level);
        const shown: [string, string][] = p.hour === undefined ? [] : [['Shown at', `${Math.floor(p.hour)}:${String(Math.round((p.hour % 1) * 60)).padStart(2, '0')}, ${p.hour >= 19 || p.hour < 6 ? 'after dark' : 'by day'}`]];
        out.push({ id: sid, ...base, ...c, facts: [...c.facts, ...shown], title: p.name ? `${c.title}: ${p.name}` : c.title, ...framing(area[0], area[1], area[2], area[3], rot, (tall > 3 ? tall / 3 : 1) * (p.zoom ?? 1), p.aside), kind: kid, placed, rect: placed ? undefined : area, inspect: p.door, ...(p.hour !== undefined ? { hour: p.hour } : {}) });
        continue;
      }
      const b = s.blocks?.find((q) => q.id === sid);
      if (b) {
        const k = kindManifest(kindIdOf(b.kind));
        if (!k) continue;
        const c = kindCaption(k, b.inspect, 0);
        out.push({ id: sid, ...base, ...c, title: b.name, what: b.blurb ?? c.what, how: b.how ?? c.how, facts: c.facts.filter(([f]) => f !== 'Placed at' && f !== 'Footprint'), ...framing(b.rect[0], b.rect[1], b.rect[2], b.rect[3], 0, 1.15), kind: k.kindId, rect: b.rect, inspect: b.inspect });
        continue;
      }
      const r = s.runways?.find((q) => q.id === sid);
      if (r) {
        const terminal = s.placements?.find((q) => q.kind === 'airport');
        const pts: DemoXY[] = [r.from, r.to];
        const box = bbox(pts);
        // the strip is six rows across the dragged line; widen the box towards the terminal side
        const across = box[2] === 1 ? [box[0] - 4, box[1], 6, box[3]] as const : [box[0], box[1] - 4, box[2], 6] as const;
        out.push({ id: sid, ...base, ...SURFACE_CAPTIONS.runway, ...framing(across[0], across[1], across[2], across[3], terminal?.rot ?? 0, 0.9), rect: across, inspect: terminal?.door });
        continue;
      }
      const t = s.tracks?.find((q) => q.id === sid);
      if (t) {
        const pts = t.drags.flat();
        const box = bbox(pts);
        const station = s.placements?.find((q) => /rail-|freight-/.test(q.kind) && q.door[0] >= box[0] - 2 && q.door[0] <= box[0] + box[2] && Math.abs(q.door[1] - box[1]) < 6);
        out.push({ id: sid, ...base, ...SURFACE_CAPTIONS.rail, title: t.name, ...framing(box[0], box[1], box[2], box[3], 0, 0.75), rect: box, path: pts, inspect: station?.door });
        continue;
      }
      const ul = s.utilLinks?.find((q) => q.id === sid);
      if (ul) {
        const pts = [ul.from, ul.to], box = bbox(pts);
        out.push({ id: sid, ...base, ...SURFACE_CAPTIONS[ul.mode === 'overhead' ? 'pylons' : 'cable'], title: ul.name, ...framing(box[0], box[1], box[2], box[3], 0, 0.8), rect: box, path: pts, inspect: ul.to });
        continue;
      }
      const j = s.junctions?.find((q) => q.id === sid);
      if (j) {
        // R4: the 5×5 roundabout and the interchange have their own frames; a sign and a crossing show a little round them
        const big = sid === 'roundabout-big' || !!j.big;
        const stop = j.rect ? { rect: j.rect, inspect: j.inspect ?? j.at } : big ? JUNCTION_STOPS.big : j.tool === 'interchange' ? JUNCTION_STOPS.interchange : null;
        const area = stop ? stop.rect : [j.at[0] - 2, j.at[1] - 2, 5, 5] as const;
        const cap = big ? BIG_ROUNDABOUT_CAPTION : j.tool === 'turnrule' && j.rule ? { ...SURFACE_CAPTIONS.turnrule, what: `${SURFACE_CAPTIONS.turnrule.what} Here: ${ARM_WORDS[j.rule]} for cars coming along Mill Road from the west, so they turn at the mini-roundabout instead.` } : SURFACE_CAPTIONS[j.tool];
        const rect: DemoRect = stop ? stop.rect : j.tool === 'roundabout' ? [j.at[0] - 1, j.at[1] - 1, 3, 3] : [j.at[0], j.at[1], 1, 1];
        out.push({ id: sid, ...base, ...cap, ...(j.name ? { title: j.name } : {}), ...(j.blurb ? { what: j.blurb } : {}), ...framing(area[0], area[1], area[2], area[3], 0, 0.8), rect, inspect: stop ? stop.inspect : j.tool === 'roundabout' ? [j.at[0] + 1, j.at[1]] : j.at });
        continue;
      }
      const br = s.bridges?.find((q) => q.id === sid);
      if (br) {
        const box = bbox([br.from, br.to]), ns = box[2] === 1;
        const span = ns ? box[3] : box[2], area = ns ? [box[0], box[1] - 1, 1, span + 2] as const : [box[0] - 1, box[1], span + 2, 1] as const;
        const k = br.landmark ? kindManifest(kindIdOf(br.landmark)) : undefined;
        const style = BRIDGE_STYLE_NAMES[BridgeStyle[br.style ?? 'Arch']];
        // a landmark bridge reads as the landmark (its blurb) and works as any bridge (no staff, no visitors)
        const c = k ? { ...BRIDGE_CAPTION, what: k.blurb ?? BRIDGE_CAPTION.what } : br.style ? { ...BRIDGE_CAPTION, what: `${BRIDGE_CAPTION.what} ${STYLE_NOTES[br.style]}` } : BRIDGE_CAPTION;
        const facts: [string, string][] = [['Span', `${span} tiles of water, ${br.style ? style : 'the tool\'s choice of style'}`], ...c.facts];
        out.push({ id: sid, ...base, ...c, title: br.name, facts, ...framing(area[0], area[1], area[2], area[3], ns ? 1 : 0, k ? 1.2 : 0.8), kind: k?.kindId, rect: area, inspect: br.from });
        continue;
      }
      const sr = s.streetRules?.find((q) => q.id === sid);
      if (sr) {
        const [x, y, w, h] = sr.rect;
        out.push({ id: sid, ...base, ...STREET_RULE_CAPTIONS[sr.rule], title: sr.name, ...(sr.blurb ? { what: sr.blurb } : {}), ...framing(x, y, w, h, 0, 0.55), rect: sr.rect, inspect: sr.inspect });
        continue;
      }
      const sp = s.spots?.find((q) => q.id === sid);
      if (sp) {
        const [x, y, w, h] = sp.rect;
        // the map looks straight down, north up, from far enough to take in the rect (camera.ts MAP_PITCH)
        const cam = sp.view === 'map' ? { focus: [x + w / 2, y + h / 2] as [number, number], dist: Math.max(w, h) * 1.9, yaw: 0, pitch: 1.565 } : framing(x, y, w, h, 0, w * h === 1 ? 0.8 : 0.5);
        out.push({ id: sid, ...base, ...SPOT_CAPTIONS[sp.spot], title: sp.name, ...(sp.blurb ? { what: sp.blurb } : {}), ...cam, rect: sp.view === 'map' ? undefined : sp.rect, inspect: sp.inspect, view: sp.view, ...(sp.hour !== undefined ? { hour: sp.hour } : {}) });
        continue;
      }
      const l = s.lines?.find((q) => q.id === sid);
      if (l) {
        const mode = l.freight ? 'freight' : l.mode;
        const box = bbox(l.stops);
        const title = l.freight ? `Freight line ${l.number}` : l.mode === 'bus' ? `Bus line ${l.number}` : l.mode === 'metro' ? `${l.name ?? `Line ${l.number}`} (underground)`
          : l.mode === 'ferry' ? `${l.name ?? `River bus ${l.number}`}` : `Rail line ${l.number}`;
        const facts: [string, string][] = [[l.mode === 'ferry' ? 'Piers' : 'Stops', `${l.stops.length}, ${l.loop ? 'a loop' : 'there and back'}`], [l.mode === 'bus' ? 'Buses' : l.mode === 'ferry' ? 'Boats' : 'Trains', `${l.vehicles}`], ...LINE_CAPTIONS[mode].facts];
        // a metro line's stop turns the underground view on (client/src/tour.ts)
        out.push({ id: sid, ...base, title, what: LINE_CAPTIONS[mode].what, how: LINE_CAPTIONS[mode].how, facts, ...framing(box[0], box[1], box[2], box[3], 0, 0.8), rect: box, path: [...l.stops], inspect: l.stops[0], line: { mode: l.mode, number: l.number, colour: l.colour }, ...(l.mode === 'metro' ? { view: 'under' as const } : {}) });
      }
    }
  }
  return withTourSound(id, out);
}

// ---------------------------------------------------------------- keeping the showcase complete

/**
 * What a feature's check reads of a seeded demo. demo:check (server/src/demo/check.ts) seeds every demo through the
 * real planners and fills this in from its World, so a feature is checked against what was built, not what was meant.
 */
export interface SeededDemo {
  /** buildings and structures by kind id, with how many of each (a structure counts once, at its door) */
  kinds: ReadonlyMap<number, number>;
  /** visit every tile the seeding wrote: x, y, tile word, aux byte, under byte (tunnels and platforms) */
  scan(f: (x: number, y: number, tile: number, aux: number, under: number) => void): void;
  aux(x: number, y: number): number;
  /** the helipads on its buildings (shared/src/helipads.ts chunkPads) */
  pads: readonly Pad[];
  /** its operational airports (a finished terminal with an intact runway) */
  airports: readonly Airport[];
  /** each saved bus line's turns as its buses plan them (BusService.plan): flat [x, y, kind, ...], kind 0 a dead end, 1 a junction mouth, 2 via the depot */
  busTurns: readonly { number: number; turns: readonly number[] }[];
  /** every saved line: its mode (freight lines are 'rail') and its stops (bus stop tiles, station doors) */
  lines: readonly { mode: TransitMode; number: number; stops: readonly DemoXY[] }[];
  /** every parcel: its name and the estate it is in (docs/world-map.md) */
  parcels: readonly { id: number; name: string; group?: number }[];
  /**
   * Every harbour as the server lists it (sim/harbours.ts, the `harbours` message) with its lanes and refusals, taken
   * as staffed: what its boats can do once the town has filled (docs/boats.md)
   */
  harbours: readonly (BoatHarbour & { refused?: readonly string[] })[];
  /** the world's sea gates (World.seaGates) */
  seaGates: readonly SeaGate[];
  /** every school standing (an education kind, or a London university): its kind id and door */
  schools: readonly { kind: number; x: number; y: number }[];
  /** every child and young person under 18: the home tile and the age in years (server/src/demo/seed.ts seedDemoFamilies) */
  children: readonly { x: number; y: number; age: number }[];
  /** the trunk links the seeder laid (docs/utilities.md) */
  utilLinks?: readonly { mode: LinkMode; a: readonly [number, number]; b: readonly [number, number] }[];
  /** motivation (docs/motivation.md): every citizen's packed values and, for a child, their parent's; and the Focus groups finding at a tile */
  values?: readonly { vals: number; parent?: number }[];
  focusAt?: (x: number, y: number) => { people: number; pct: readonly number[] } | undefined;
  /** ad slots (docs/adverts.md): how many open slots of each size stand in the town, and the wear of every rented poster */
  ads?: { slots: Partial<Record<AdSize, number>>; wears: readonly number[]; screensRented?: number };
  /** every street in the town (shared/src/streets.ts) with the name the server gives it */
  streets?: readonly (StreetRun & { name: string })[];
  /** the road rule records (R4 signs and crossings, R5 street rules and gateway limits: World.roadRulesList) */
  roadRules?: readonly RoadRuleDTO[];
}

/**
 * Something interesting that is not a catalogue kind (a bridge style, a level crossing, a plane type, a helicopter
 * service, a merged lot), which a demo must show. `npm run demo:check` fails while any enabled feature is missing.
 */
export interface ShowcaseFeature {
  id: string;
  /** what it is, as the check's message names it */
  caption: string;
  /** the demo that must show it: the showcase unless `rule` says why it lives elsewhere */
  demo?: DemoId;
  rule?: string;
  /** the tour stop that shows it, a stop of that demo's tour */
  tour?: string;
  /** the scenario has it (pure, over the demo's sections: showcaseProblems) */
  scenario?: (sections: readonly DemoSection[]) => boolean;
  /** the seeded demo has it (demo:check) */
  seeded?: (d: SeededDemo) => boolean;
  /** not enforced yet: why, and what turns it on */
  todo?: string;
}

/** Days of timetable read from day 0: every plane type and helicopter service must fly within them. */
export const FEATURE_DAYS = 7;
/**
 * The news helicopter flies to the fire drill (shared newsHelis.ts): a media centre's pad on the demo owner's land, and
 * a story at the drill home covered by its channel, puts the helicopter over the scene within a couple of hours.
 */
const newsHeliFlies = (d: SeededDemo) => {
  const pad = d.pads.find((p) => p.kind === 'news');
  if (!pad) return false;
  const [x, y] = FIRE_DRILL, t0 = TICKS_PER_DAY + 18 * TICKS_PER_HOUR;
  const np = { ...pad, owner: DEMO_OWNER, channel: 'demo TV', color: 0xc8463c };
  const story = { id: 1, t: t0, k: 'fire' as const, x, y, h: 'Fire drill', s: 46, ch: DEMO_OWNER };
  return [1.5, 2, 2.5].some((h) => newsHelisAt([np], [story], t0 + h * TICKS_PER_HOUR)[0]?.news?.doing === 'live');
};
const days = () => Array.from({ length: FEATURE_DAYS }, (_, d) => d);
const placedKind = (kind: string) => (ss: readonly DemoSection[]) => ss.some((s) => s.placements?.some((p) => p.kind === kind));
/**
 * What the road-look stop's streets show in a seeded demo, worked out with the same rules the client draws by
 * (shared/src/roadlook.ts), lights as in a sandbox (every owner has the technology).
 */
const roadLookSeen = new WeakMap<SeededDemo, { zebra: boolean; signal: boolean; box: boolean; trees: number }>();
function roadLook(d: SeededDemo) {
  const had = roadLookSeen.get(d);
  if (had) return had;
  const tiles = new Map<string, number>();
  d.scan((x, y, t) => tiles.set(`${x},${y}`, t));
  const tile = (x: number, y: number) => tiles.get(`${x},${y}`);
  const road = (x: number, y: number) => { const t = tile(x, y); return t !== undefined && isRoad(t); };
  const out = { zebra: false, signal: false, box: false, trees: 0 };
  const [rx, ry, rw, rh] = ROAD_LOOK_RECT;
  for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) {
    if (!road(x, y)) continue;
    const a = d.aux(x, y);
    if (midZebraAt(road, a, x, y)) out.zebra = true;
    if (isMarkedJunction(road, a, x, y)) {
      const sig = sandboxSignalled(road, x, y);
      if (sig) out.signal = true;
      if (boxJunction(road, x, y, sig)) out.box = true;
      for (const bit of [1, 2, 4, 8]) if (signalArms(road, x, y) & bit && mouthCrossing(x, y, bit, sig) === MouthCrossing.Zebra) out.zebra = true;
    }
    for (const bit of [1, 2, 4, 8]) if (streetTreeAt(tile, x, y, bit)) out.trees++;
  }
  roadLookSeen.set(d, out);
  return out;
}
const anyTile = (d: SeededDemo, f: (x: number, y: number, t: number, a: number, u: number) => boolean) => { let hit = false; d.scan((x, y, t, a, u) => { if (!hit && f(x, y, t, a, u)) hit = true; }); return hit; };
/** A line of `mode` calls within the change walk (TRANSIT.transferWalk, Manhattan) of a stop of another mode's line. */
const interchange = (mode: TransitMode) => (lines: readonly { mode: TransitMode; stops: readonly DemoXY[] }[]) => lines.some((m) => m.mode === mode && m.stops.some(([x, y]) =>
  lines.some((o) => o.mode !== mode && o.stops.some(([ox, oy]) => Math.abs(ox - x) + Math.abs(oy - y) <= TRANSIT.transferWalk))));
const metroInterchange = interchange('metro'), ferryInterchange = interchange('ferry');

// Typed against the source unions, so a new bridge style, junction tool, plane type or helicopter service fails the
// typecheck here until it has an entry, and demo:check then fails until the showcase shows it.
const BRIDGE_TOUR: Record<keyof typeof BridgeStyle, string> = { Arch: 'bridge-arch', Girder: 'bridge-girder', Suspension: 'bridge-suspension', Bascule: 'bridge-bascule' };
const JUNCTION_TOUR: Record<DemoJunction['tool'], string> = { roundabout: 'roundabout', flyover: 'flyover', miniroundabout: 'roundabout-mini', interchange: 'interchange', turnrule: 'turn-ban', pelican: 'pelican' };
const PLANE_CAPTIONS: Record<PlaneType, string> = {
  turboprop: 'a turboprop', regional: 'a regional jet', narrowbody: 'a narrow-body jet', widebody: 'a wide-body jet', jumbo: 'a jumbo jet', bizjet: 'a business jet',
};
const HELI_SERVICES: Record<PadKind, Pick<ShowcaseFeature, 'caption' | 'tour' | 'demo' | 'rule' | 'todo'>> = {
  medical: { caption: 'air ambulances (a hospital helipad)', tour: 'helipads' },
  police: { caption: 'the police helicopter (police headquarters)', tour: 'helipads' },
  corporate: { caption: 'executive helicopters (a tall office with a rooftop pad)', tour: 'off-hq' },
  royal: { caption: 'the royal flight (Buckingham Palace)', tour: 'buckingham-palace', demo: 'london',
    rule: 'only Buckingham Palace has a royal pad, and landmarks stand in their own city\'s demo (the London landmarks in London), not the showcase' },
  news: { caption: 'the news helicopter (a media centre\'s roof pad) flying to a story', tour: 'news-heli' },
};

/**
 * Every boat type is scheduled at a showcase harbour within FEATURE_DAYS (boats.ts boatTimetable over the seeded
 * harbours, staffed), or runs on a ferry line: the harbour that shows it is its tour stop.
 */
const BOAT_FEATURES: Record<BoatType, Pick<ShowcaseFeature, 'caption' | 'tour' | 'todo'>> = {
  dinghy: { caption: 'a dinghy (a jetty or a marina)', tour: 'jetty' },
  motorCruiser: { caption: 'a motor cruiser (a jetty or a marina)', tour: 'marina' },
  sailboat: { caption: 'a sailing yacht (a marina on water three tiles wide)', tour: 'marina' },
  narrowboat: { caption: 'a narrowboat (a marina whose cruise keeps to narrow water)', tour: 'marina' },
  sailingBarge: { caption: 'a sailing barge (a marina, or through a bascule\'s lift)', tour: 'bridge-bascule' },
  trawler: { caption: 'a trawler (a fishing harbour)', tour: 'fishing-harbour' },
  riverBus: { caption: 'a river bus (a ferry line)', tour: 'line-ferry-1' },
  ropax: { caption: 'a ro-ro ferry calling at a cargo port', tour: 'cargo-port' },
  barge: { caption: 'a barge calling at a cargo port', tour: 'cargo-port' },
  coaster: { caption: 'a coaster calling at a cargo port', tour: 'cargo-port' },
  containerShip: { caption: 'a container ship calling at a cargo port (open water to the sea)', tour: 'cargo-port' },
  tug: { caption: 'a tug escorting a container ship in', tour: 'cargo-port' },
  policeLaunch: { caption: 'a police launch', todo: 'not scheduled yet: it needs a police station by the water (docs/boats.md 4.1)' },
  fireBoat: { caption: 'a fire boat', todo: 'not scheduled yet: it needs a fire station by the water (docs/boats.md 4.1)' },
};
/** Each harbour kind's tour stop: its placement in the harbour section. */
const HARBOUR_TOUR: Record<HarbourRole, string> = { jetty: 'jetty', marina: 'marina', fishing: 'fishing-harbour', pier: 'ferry-pier', port: 'cargo-port' };
const boatDays = (d: SeededDemo, f: (day: number) => boolean) => d.harbours.length > 0 && days().some(f);
/** A voyage that is not the bascule's own lift barge booked into a lift: a tall boat through a lifting bridge. */
const tallThroughLift = (d: SeededDemo) => boatDays(d, (day) => [...boatLifts(d.harbours, day).values()].some((ps) => ps.some((p) => p.voyage.kind !== 'lift')));

/** Every bascule span in the seeded demo lifts at least once in FEATURE_DAYS (shared/src/bridges.ts basculeLiftAt). */
function basculeLifts(d: SeededDemo): boolean {
  const spans: [number, number][] = [];
  d.scan((x, y, _t, a) => {
    if (!isBridgeAux(a) || bridgeStyle(a) !== BridgeStyle.Bascule) return;
    const sp = bridgeSpanAt(x, y, (qx, qy) => d.aux(qx, qy));
    if (sp && sp.x0 === x && sp.y0 === y) spans.push([x, y]);
  });
  return spans.length > 0 && spans.every(([x, y]) => {
    for (let h = 0; h < FEATURE_DAYS * 24; h += 0.25) if (!Number.isNaN(basculeLiftAt(basculeSeed(x, y), h))) return true;
    return false;
  });
}

/**
 * Every stage in `stages` has a school standing whose catchment (Manhattan tiles) holds the home of a child of its age:
 * on a school day that child is admitted and walks, or is taken, to class (sim/schools.ts).
 */
const schoolRun = (stages: readonly number[]) => (d: SeededDemo) => stages.every((stage) => {
  const [from, to] = STAGES[stage].ages;
  return d.schools.some((s) => {
    const spec = SCHOOL_SPECS[s.kind];
    return !!spec && schoolTakes(spec, stage) && d.children.some((c) => c.age >= from && c.age < to && (spec.catchment === 0 || Math.abs(c.x - s.x) + Math.abs(c.y - s.y) <= spec.catchment));
  });
});
/**
 * Children share their parent's first value half as often again as two strangers would (chance: the sum of the squared
 * shares of each first value in town), which inheritance gives (docs/motivation.md section 3).
 */
const takesAfter = (vs: readonly { vals: number; parent?: number }[]) => {
  const top = (v: number) => topValues(valuesOf(v))[0], shares = new Array(VALUE_COUNT).fill(0);
  for (const v of vs) shares[top(v.vals)] += 1 / vs.length;
  let same = 0, kids = 0;
  for (const v of vs) if (v.parent) { kids++; if (top(v.vals) === top(v.parent)) same++; }
  return kids >= 10 && same / kids > 1.5 * shares.reduce((a, x) => a + x * x, 0);
};
/** Halls of residence stand within this many tiles of a university (students would walk). */
const HALLS_WALK = 12;
/** Every street is named, the names a scenario gives stand, and no street shares a name with one crossing it or alongside it. */
const namedStreets = (d: SeededDemo) => {
  const st = d.streets ?? [];
  if (!st.length) return false;
  const along = (r: StreetRun, x: number, y: number) => (r.ns ? r.line === x && y >= r.from && y <= r.to : r.line === y && x >= r.from && x <= r.to);
  for (const sec of demoSections('showcase')) for (const n of sec.streets ?? []) {
    if (!st.some((r) => r.ns === !!n.ns && along(r, n.at[0], n.at[1]) && r.name === n.name)) return false;
  }
  return streetClashes(st) === 0;
};
const studentQuarter = (d: SeededDemo) => d.schools.some((u) => SCHOOL_SPECS[u.kind]?.stage === Study.Degree
  && d.schools.some((h) => SCHOOL_SPECS[h.kind]?.beds && Math.abs(h.x - u.x) + Math.abs(h.y - u.y) <= HALLS_WALK));

/**
 * What the road classes section shows in a seeded demo (shared/src/roadclass.ts): tiles of each class, a one-way pair
 * (both ways within a few rows), an avenue junction tile with a crossing street, a motorway tile beside a motorway
 * connection and one a street meets (a slip), and pedestrian street tiles with shops beside them.
 */
const roadClassSeen = new WeakMap<SeededDemo, { n: number[]; ways: Set<number>; avenueCross: boolean; motorwayGate: boolean; slip: boolean; pedShops: number }>();
function roadClasses(d: SeededDemo) {
  const had = roadClassSeen.get(d);
  if (had) return had;
  const tiles = new Map<string, number>();
  d.scan((x, y, t) => tiles.set(`${x},${y}`, t));
  const road = (x: number, y: number) => { const t = tiles.get(`${x},${y}`); return t !== undefined && isRoad(t); };
  const out = { n: [0, 0, 0, 0, 0, 0], ways: new Set<number>(), avenueCross: false, motorwayGate: false, slip: false, pedShops: 0 };
  const near = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  d.scan((x, y, t, a) => {
    if (!isRoad(t)) return;
    const c = auxClass(a);
    out.n[c]++;
    if (c === RoadCls.OneWay && oneWayDir(a) >= 0) out.ways.add(oneWayDir(a));
    if (c === RoadCls.Avenue && auxJunction(a) && near.some(([dx, dy]) => road(x + dx, y + dy) && auxClass(d.aux(x + dx, y + dy)) === RoadCls.Street)) out.avenueCross = true;
    if (isMotorwayAux(a)) for (const [dx, dy] of near) {
      // beside a structure tile (a motorway connection: nothing else may face a motorway)
      if (!road(x + dx, y + dy)) { const na = d.aux(x + dx, y + dy); if (d.kinds.has(MOTORWAY_KIND) && na >= 0x40 && na < 0xc0) out.motorwayGate = true; continue; }
      if (!isMotorwayAux(d.aux(x + dx, y + dy)) && auxClass(d.aux(x + dx, y + dy)) === RoadCls.Street && !auxJunction(a)) out.slip = true;
    }
    if (isPedestrianAux(a)) for (const [dx, dy] of near) { const n = tiles.get(`${x + dx},${y + dy}`); if (n !== undefined && !isRoad(n) && zoneOf(n) === Zone.Commercial && levelOf(n) > 0) out.pedShops++; }
  });
  roadClassSeen.set(d, out);
  return out;
}
const classRoad = (cls: number) => (ss: readonly DemoSection[]) => ss.some((s) => s.classRoads?.some((r) => r.cls === cls));
/**
 * London's roads as seeded (docs/demo.md "London", "Roads"): the tiles of each class, the carriageway tiles (an avenue's
 * or motorway's, not a junction tile) with no road ahead or behind (a dead end in the middle of a run: none may be),
 * the interchanges' deck tiles, the big roundabouts' island tiles, and the street rule tiles by rule.
 */
const londonRoadsSeen = new WeakMap<SeededDemo, { n: number[]; dead: number; deck: number; island: number; rules: Record<string, number> }>();
function londonRoads(d: SeededDemo) {
  const had = londonRoadsSeen.get(d);
  if (had) return had;
  const tiles = new Map<string, number>();
  d.scan((x, y, t) => tiles.set(`${x},${y}`, t));
  const road = (x: number, y: number) => { const t = tiles.get(`${x},${y}`); return t !== undefined && isRoad(t); };
  const out = { n: [0, 0, 0, 0, 0, 0, 0, 0], dead: 0, deck: 0, island: 0, rules: {} as Record<string, number> };
  d.scan((x, y, t, a) => {
    if (a === 0xfc) out.island++;
    if (!isRoad(t)) return;
    out.n[auxClass(a)]++;
    if (isDeckClassAux(a)) out.deck++;
    if (!isDividedAux(a) || isDeckClassAux(a) || auxJunction(a)) return;
    const [dx, dy] = CDIRS[auxDir(a)];
    if (!road(x + dx, y + dy) || !road(x - dx, y - dy)) out.dead++;
  });
  for (const [, , r] of d.roadRules ?? []) {
    for (const def of STREET_RULE_DEFS) if ((r.st ?? 0) & def.bit) out.rules[def.id] = (out.rules[def.id] ?? 0) + 1;
    if (r.ban) out.rules.ban = (out.rules.ban ?? 0) + 1;
  }
  londonRoadsSeen.set(d, out);
  return out;
}
/** The junction tools' feature words, and the tiles that show one was built (R4). */
const JUNCTION_WORDS: Record<DemoJunction['tool'], string> = { roundabout: 'roundabout', flyover: 'flyover', miniroundabout: 'mini-roundabout (a painted one on a street crossroads)', interchange: 'diamond interchange (a street over a motorway, with slip roads)', turnrule: 'turn ban (a no left turn sign on a junction\'s arm)', pelican: 'signal crossing for walkers (a pelican)' };
const JUNCTION_SEEN: Partial<Record<DemoJunction['tool'], (d: SeededDemo) => boolean>> = {
  miniroundabout: (d) => anyTile(d, (_x, _y, t, a) => isRoad(t) && isMiniAux(a)),
  interchange: (d) => anyTile(d, (_x, _y, t, a) => isRoad(t) && isDeckClassAux(a)),
};
/** Is there a group of four junction tiles (two divided roads crossing: shared/src/signals.ts junctionGroup)? */
const groupSeen = (d: SeededDemo) => {
  const tiles = new Map<string, number>();
  d.scan((x, y, t) => tiles.set(`${x},${y}`, t));
  const road = (x: number, y: number) => { const t = tiles.get(`${x},${y}`); return t !== undefined && isRoad(t); };
  const ca = (x: number, y: number) => { const a = d.aux(x, y); return a > 0 && a < 0x40 ? a : 0; };
  return anyTile(d, (x, y, t, a) => isRoad(t) && auxJunction(a) && junctionGroup(road, ca, x, y)?.phases === 4);
};

/**
 * The feature registry: everything interesting the showcase must show that is not a catalogue kind (those are checked
 * by kind: every placeable kind, ladder rung, surface tool and line mode, below). A new feature lands with its entry
 * here, its placement in a section and its tour stop, or demo:check fails (docs/demo.md "Keeping it complete").
 */
export const SHOWCASE_FEATURES: readonly ShowcaseFeature[] = [
  // ---- road classes (docs/roads.md "Classes", shared/src/roadclass.ts): one street of each, each at its own stop
  { id: 'road-class-lane', caption: 'a country lane', tour: 'road-lane', scenario: classRoad(RoadCls.Lane), seeded: (d) => roadClasses(d).n[RoadCls.Lane] >= 10 },
  { id: 'road-class-oneway', caption: 'a one-way pair (two one-way streets going opposite ways)', tour: 'road-oneway', scenario: classRoad(RoadCls.OneWay), seeded: (d) => roadClasses(d).n[RoadCls.OneWay] >= 10 && roadClasses(d).ways.size >= 2 },
  { id: 'road-class-avenue', caption: 'an avenue (a pair of carriageways) crossed by a street', tour: 'road-avenue', scenario: classRoad(RoadCls.Avenue), seeded: (d) => roadClasses(d).n[RoadCls.Avenue] >= 20 && roadClasses(d).avenueCross },
  { id: 'road-class-motorway', caption: 'a motorway from a motorway connection, with a slip road joining it', tour: 'road-motorway', scenario: classRoad(RoadCls.Motorway), seeded: (d) => roadClasses(d).n[RoadCls.Motorway] >= 20 && roadClasses(d).motorwayGate && roadClasses(d).slip },
  { id: 'road-class-pedestrian', caption: 'a pedestrian street with shops along it', tour: 'road-pedestrian', scenario: classRoad(RoadCls.Pedestrian), seeded: (d) => roadClasses(d).n[RoadCls.Pedestrian] >= 8 && roadClasses(d).pedShops >= 8 },
  // ---- bridges: every style, laid as the road tool lays them, carrying real traffic
  ...(Object.keys(BRIDGE_TOUR) as (keyof typeof BridgeStyle)[]).map((style): ShowcaseFeature => ({
    id: `bridge-${style.toLowerCase()}`, caption: `a ${BRIDGE_STYLE_NAMES[BridgeStyle[style]]}`, tour: BRIDGE_TOUR[style],
    scenario: (ss) => ss.some((s) => s.bridges?.some((b) => b.style === style)),
    seeded: (d) => anyTile(d, (_x, _y, _t, a) => isBridgeAux(a) && bridgeStyle(a) === BridgeStyle[style]) && (style !== 'Bascule' || basculeLifts(d)),
  })),
  { id: 'river', caption: 'a river (open water) that the bridges cross', tour: 'river',
    scenario: (ss) => ss.some((s) => s.water?.length), seeded: (d) => anyTile(d, (_x, _y, t) => terrainOf(t) === Terrain.Water) },
  // ---- rail and roads
  { id: 'street-names', caption: 'named streets (a British name for each by what it is like, none alike side by side, the High Street named by its owner)', tour: 'high-street',
    scenario: (ss) => ss.some((s) => s.streets?.length), seeded: namedStreets },
  { id: 'mixed-blocks', caption: 'blocks of several sizes (3, 4, 6 and 8 long) meeting at staggered T-junctions, as the Commons is laid out', tour: 'block-residential',
    todo: 'the Commons (server/src/seed.ts COMMONS) is in no demo: the showcase is built of seedCity\'s 4×4 grid districts, which the load tests share. It turns on when the showcase districts are rebuilt on the Commons\' mix (roads probe: loadtest/roads.ts checks the Commons)' },
  { id: 'level-crossing', caption: 'a level crossing (a road over track, with barriers)', tour: 'level-crossing',
    seeded: (d) => anyTile(d, (_x, _y, t, a) => isCrossing(t, a)) },
  ...(Object.keys(JUNCTION_TOUR) as DemoJunction['tool'][]).map((tool): ShowcaseFeature => ({
    id: tool, caption: `a ${JUNCTION_WORDS[tool]}`, tour: JUNCTION_TOUR[tool], scenario: (ss) => ss.some((s) => s.junctions?.some((j) => j.tool === tool && j.id !== 'roundabout-big')),
    ...(JUNCTION_SEEN[tool] ? { seeded: JUNCTION_SEEN[tool] } : {}),
  })),
  // ---- traffic control (R5, docs/roads.md "Traffic control")
  ...(['hgv', 'bus', 'yellow', 'zone20'] as const).map((rule): ShowcaseFeature => ({
    id: `street-${rule}`, caption: `a street with ${STREET_RULE_BY_ID.get(rule)!.words}`, tour: `street-${rule}`,
    scenario: (ss) => ss.some((s) => s.streetRules?.some((r) => r.rule === rule)),
    seeded: (d) => (d.roadRules ?? []).filter((e) => (e[2].st ?? 0) & STREET_RULE_BY_ID.get(rule)!.bit).length >= 2,
  })),
  { id: 'visitor-limit', caption: 'a gateway with the visitor limit on', tour: 'visitor-limit', scenario: (ss) => ss.some((s) => s.visitorLimits?.length), seeded: (d) => (d.roadRules ?? []).some((e) => e[2].gw) },
  { id: 'traffic-panel', caption: 'the Traffic panel open with the congestion overlay (why each jam is slow)', tour: 'traffic-panel', scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'traffic-panel' && sp.view === 'traffic')) },
  { id: 'bus-lane-line', caption: 'a bus line along a bus lane', tour: 'line-bus-4', scenario: (ss) => ss.some((s) => s.lines?.some((l) => l.id === 'line-bus-4')), seeded: (d) => d.lines.some((l) => l.mode === 'bus' && l.number === 4) },
  // ---- junctions (R4, docs/roads.md "Junctions")
  { id: 'big-roundabout', caption: 'a 5×5 two-lane roundabout on an avenue', tour: 'roundabout-big', scenario: (ss) => ss.some((s) => s.junctions?.some((j) => j.id === 'roundabout-big')),
    seeded: (d) => anyTile(d, (_x, _y, _t, a) => isRingClassAux(a)) },
  { id: 'junction-group', caption: 'an avenue crossing an avenue: four junction tiles as one, four phases with protected left turns', tour: 'junction-group',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'junction-group')), seeded: (d) => groupSeen(d) },
  { id: 'motorway-gateway', caption: 'a motorway connection, the gateway newcomers, visitors and freight arrive through', tour: 'motorway',
    scenario: placedKind('motorway'), seeded: (d) => (d.kinds.get(MOTORWAY_KIND) ?? 0) > 0 },
  // ---- the look of the streets (shared/src/roadlook.ts, client render/roads.ts), all seen at the road-look stop
  { id: 'zebra-crossing', caption: 'a zebra crossing with Belisha beacons', tour: 'road-look', seeded: (d) => roadLook(d).zebra },
  { id: 'signal-crossing', caption: 'a signal-controlled crossing at a junction with lights', tour: 'road-look', seeded: (d) => roadLook(d).signal },
  { id: 'box-junction', caption: 'a yellow box junction', tour: 'road-look', seeded: (d) => roadLook(d).box },
  { id: 'street-trees', caption: 'street trees in the verges', tour: 'road-look', seeded: (d) => roadLook(d).trees >= 4 },
  // ---- aircraft: every plane type is scheduled at a showcase airport within FEATURE_DAYS (the jumbo needs 20 tiles of runway)
  ...(Object.keys(PLANE_CAPTIONS) as PlaneType[]).map((type): ShowcaseFeature => ({
    id: `plane-${type}`, caption: `${PLANE_CAPTIONS[type]} landing${PLANE_TYPES[type].minRunway ? ` (a runway of ${PLANE_TYPES[type].minRunway}+ tiles)` : ''}`, tour: 'runway',
    seeded: (d) => d.airports.some((ap) => days().some((day) => timetable(ap, day).some((f) => f.type === type))),
  })),
  // ---- helicopters: every service has a pad, and flies within FEATURE_DAYS
  ...(Object.keys(HELI_SERVICES) as PadKind[]).map((kind): ShowcaseFeature => ({
    id: `heli-${kind}`, ...HELI_SERVICES[kind],
    seeded: kind === 'news' ? newsHeliFlies
      : (d) => d.pads.some((p) => p.kind === kind) && days().some((day) => heliTimetable(d.pads, day).some((f) => f.kind === kind)),
  })),
  // ---- districts: every merged lot (zones.ts GROW_FORMS, from the catalogue, so a new form is enforced at once) and the
  // block middles: the deep plots settle by themselves (sim/blocks.ts), the other forms are placed
  ...GROW_FORMS.flat().map((f): ShowcaseFeature => {
    const id = Object.keys(KIND_ID).find((k) => (KIND_ID as Record<string, number>)[k] === f.kindId)!;
    return f.deep
      ? { id, caption: `a ${f.name} (a block middle grown from the frontage)`, tour: 'block-deep', seeded: (d) => (d.kinds.get(f.kindId) ?? 0) > 0 }
      : { id, caption: `a ${f.name} (a merged lot)`, tour: id, scenario: placedKind(id), seeded: (d) => (d.kinds.get(f.kindId) ?? 0) > 0 };
  }),
  { id: 'block-garden', caption: 'a communal garden (the middle of a ring of homes)', tour: 'block-garden', seeded: (d) => (d.kinds.get(KIND_ID['block-garden']) ?? 0) > 0 },
  // ---- buses
  { id: 'bus-turnaround', caption: 'a bus line that turns round at a dead end', tour: 'line-bus-3',
    seeded: (d) => d.busTurns.some((l) => l.turns.some((_v, i) => i % 3 === 2 && l.turns[i] === 0)) },
  // ---- metro (docs/underground.md): the showcase runs one underground line, which changes to rail and a bus
  { id: 'metro-interchange', caption: 'a metro line with an interchange (an entrance within the change walk of a rail or bus stop)', tour: 'line-metro-1',
    scenario: (ss) => metroInterchange(ss.flatMap((s) => s.lines ?? [])), seeded: (d) => metroInterchange(d.lines) },
  // ---- mobile jobs (docs/mobile-jobs.md): each tour spot's door holds its role (fleet.ts hashes)
  ...MOBILE_SPOTS.map(([spot, x, y, name]): ShowcaseFeature => ({
    id: spot, caption: `a ${name.toLowerCase()} at (${x}, ${y}) (a mobile-job base)`, tour: spot,
    seeded: (d) => anyTile(d, (tx, ty, t, a) => tx === x && ty === y && mobileRoleAt(spot, x, y, t, a)),
  })),
  // ---- the news (docs/media.md N2): the media centre's channel reports the fire drill, so the News panel has stories
  { id: 'news', caption: 'the news: the media centre\'s channel reporting the fire drill in the News panel', tour: 'media-centre',
    scenario: (ss) => placedKind('media-centre')(ss) && ss.some((s) => s.spots?.some((sp) => sp.spot === 'house-fire')) },
  // ---- utilities (docs/utilities.md): power stations, pylons and a buried cable to town, and the blackout drill
  { id: 'power-plant', caption: 'a power station feeding the town', tour: 'gas-plant', scenario: placedKind('gas-plant'), seeded: (d) => (d.kinds.get(KIND_ID['gas-plant']) ?? 0) > 0 },
  { id: 'power-pylons', caption: 'an overhead pylon line from a power station to a substation in town', tour: 'power-pylons',
    scenario: (ss) => ss.some((s) => s.utilLinks?.some((l) => l.mode === 'overhead')), seeded: (d) => !!d.utilLinks?.some((l) => l.mode === 'overhead') },
  { id: 'power-buried', caption: 'a buried cable from a plant to a substation in town', tour: 'power-buried',
    scenario: (ss) => ss.some((s) => s.utilLinks?.some((l) => l.mode === 'buried')), seeded: (d) => !!d.utilLinks?.some((l) => l.mode === 'buried') },
  { id: 'power-blackout', caption: 'a scripted blackout and the repair van that ends it', tour: 'power-blackout',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'blackout' && sp.inspect)) && placedKind('power-depot')(ss) },
  // ---- live TV and the channels' programmes (docs/media.md sections 7-8): the tour follows someone at home watching
  { id: 'live-tv', caption: 'live TV: a set in a lounge showing the news helicopter\'s pictures (the TV stop over district B2\'s homes)', tour: 'live-tv',
    scenario: (ss) => placedKind('media-centre')(ss) && ss.some((s) => s.spots?.some((sp) => sp.spot === 'live-tv' && sp.view === 'tv')) },
  { id: 'tv-programmes', caption: 'TV programmes and teletext between the news (any set on the TV stop)', tour: 'live-tv',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'live-tv')) },
  // ---- sound (docs/audio.md): the ambient beds, first-person vehicle sound and the mute, explained at a stop of their own
  { id: 'sound', caption: 'sound (the ambient beds, vehicles passing and sirens on a call, the dawn chorus, first-person vehicle sound and M for mute)', tour: 'sound',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'sound')) },
  // ---- settlement ranks (docs/ranks.md): a sandbox has none, so the tour stop plays the celebration over the town
  { id: 'settlement-ranks', caption: 'settlement ranks (a rank-up celebration over the town)', tour: 'ranks',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'ranks' && sp.view === 'ranks')) },
  // ---- the world map (docs/world-map.md): its tour stop, and an estate (two parcels combined) for it to show
  { id: 'world-map', caption: 'the world map over the whole town, with an estate of combined parcels', tour: 'world-map',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'world-map' && sp.view === 'map')) && ss.some((s) => s.estates?.length),
    seeded: (d) => { const n = new Map<number, number>(); for (const p of d.parcels) if (p.group !== undefined) n.set(p.group, (n.get(p.group) ?? 0) + 1); return [...n.values()].some((k) => k >= 2); } },
  { id: 'metro-crossover', caption: 'a metro crossover (one line\'s tunnel straight across another\'s)', tour: 'tube-crossover', demo: 'london',
    rule: 'the showcase runs one underground line; lines cross in London, where the Tube\'s Central, Northern and Jubilee lines meet',
    seeded: (d) => anyTile(d, (_x, _y, _t, _a, u) => isTunnel(u) && !isPlatform(u) && underMask(u) === 15) },
  // ---- boats and harbours (docs/boats.md): every harbour kind finds the lanes its boats need, every boat type sails,
  // a tall boat books a bascule's lift, the water meets the sea at a gate, and the river buses change with the buses
  ...(Object.keys(HARBOUR_TOUR) as HarbourRole[]).map((role): ShowcaseFeature => ({
    id: `harbour-${role}`, caption: `a ${role === 'port' ? 'cargo port' : role === 'pier' ? 'ferry pier' : role === 'fishing' ? 'fishing harbour' : role} whose boats find every lane they need`, tour: HARBOUR_TOUR[role],
    seeded: (d) => d.harbours.some((h) => HARBOUR_OF[h.kind]?.role === role && !h.refused?.length && (role === 'pier' || h.lanes.length > 0)),
  })),
  ...(Object.keys(BOAT_FEATURES) as BoatType[]).map((type): ShowcaseFeature => ({
    id: `boat-${type}`, ...BOAT_FEATURES[type],
    seeded: type === 'riverBus' ? (d) => d.lines.some((l) => l.mode === 'ferry') : (d) => boatDays(d, (day) => boatTimetable(d.harbours, day).voyages.some((v) => v.type === type)),
  })),
  { id: 'boat-lift', caption: 'a tall boat booked through a bascule\'s lift', tour: 'bridge-bascule', seeded: (d) => tallThroughLift(d) },
  { id: 'sea-gate', caption: 'a sea gate that the harbours\' lanes reach', tour: 'sea-gate',
    scenario: (ss) => ss.some((s) => s.seaGates?.length), seeded: (d) => d.seaGates.length > 0 && d.harbours.some((h) => h.lanes.some((l) => !!l.gate)) },
  { id: 'ferry-interchange', caption: 'a river bus line with an interchange (a pier within the change walk of a bus, rail or metro stop)', tour: 'line-ferry-1',
    scenario: (ss) => ferryInterchange(ss.flatMap((s) => s.lines ?? [])), seeded: (d) => ferryInterchange(d.lines) },
  // ---- education (docs/education.md): families live within reach of the schools, so the children walk to class; halls stand beside the university
  { id: 'school-run', caption: 'children living within reach of a nursery, a primary, a secondary and a sixth-form school, who walk to class on a school day',
    tour: 'primary-school', seeded: schoolRun([Study.Nursery, Study.Primary, Study.Secondary, Study.SixthForm]) },
  // ---- incidents (docs/incidents.md): a house that burns on a loop beside the fire post, so the engine turns out on every visit
  { id: 'house-fire', caption: 'a house fire with a fire post\'s engine in reach (the demo\'s fire drill)', tour: 'house-fire',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'house-fire')),
    seeded: (d) => demoFireDrillsOf(d).length > 0 },
  // fires v2: a row that spreads and a works that blows up, both staged (sim/fires.ts rows and blastDrills)
  { id: 'fire-spread', caption: 'a row of touching homes where an unattended fire runs from house to house (the spread drill)', tour: 'fire-spread',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'fire-spread' && (sp.row?.length ?? 0) >= 3)),
    seeded: (d) => demoFireRowsOf(d).length > 0 },
  { id: 'fire-blast', caption: 'a works with buildings round it within the blast\'s reach (the blast drill)', tour: 'fire-blast',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'fire-blast')),
    seeded: (d) => demoFireBlastsOf(d).length > 0 },
  // ---- death and remembrance (docs/remembrance.md): a funeral on a loop to the churchyard, and every resting place with its dead
  { id: 'funeral', caption: 'a funeral under way: the hearse at the chapel, mourners round an open grave (the funeral drill)', tour: 'funeral',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'funeral' && !!sp.funeral)) },
  { id: 'headstones', caption: 'headstones on the plots of every resting place, and a crematorium\'s memorial plaques (the town\'s seeded dead)', tour: 'garden-cemetery',
    scenario: (ss) => ['churchyard', 'municipal-cemetery', 'garden-cemetery', 'crematorium'].every((k) => ss.some((s) => s.placements?.some((p) => p.kind === k && (p.graves ?? 0) > 0))) },
  { id: 'student-quarter', caption: 'halls of residence within a short walk of the university', tour: 'halls', seeded: studentQuarter },
  // ---- adverts (docs/adverts.md): every frame size stands somewhere in the town, and the high street has posters at three ages
  { id: 'advert-slots', caption: 'an ad frame of every size (poster, billboard, shelter panel, hoarding, banner, big screen) open to the street', tour: 'high-street',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'high-street')),
    seeded: (d) => !!d.ads && AD_SIZES.every((s) => (d.ads!.slots[s] ?? 0) > 0) },
  { id: 'advert-wear', caption: 'rented posters fresh, tagged and wrecked side by side (three wear levels)', tour: 'high-street',
    seeded: (d) => !!d.ads && d.ads.wears.some((w) => w < 0.15) && d.ads.wears.some((w) => w >= 0.35 && w < 0.8) && d.ads.wears.some((w) => w >= 0.8) },
  { id: 'advert-screens', caption: 'big screens turning through rented campaigns, house adverts and the news (a big screens corner with turns rented)', tour: 'big-screens',
    seeded: (d) => !!d.ads && (d.ads.slots.screen ?? 0) >= AD.screenTurns && (d.ads.screensRented ?? 0) > 0 && (d.ads.screensRented ?? 0) < (d.ads.slots.screen ?? 0) },
  // ---- motivation (docs/motivation.md M1-M2): values for everyone, children taking after their parents, Focus groups on a home
  { id: 'citizen-values', caption: 'citizens who care about different things (every value someone\'s first), children taking after their parents', tour: 'focus-groups',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'focus-groups')),
    seeded: (d) => !!d.values?.length && d.values.every((v) => v.vals > 0) && new Set(d.values.map((v) => topValues(valuesOf(v.vals))[0])).size === VALUE_COUNT
      && takesAfter(d.values) },
  { id: 'focus-groups', caption: 'a home whose tooltip shows its parcel\'s value mix (Focus groups)', tour: 'focus-groups',
    scenario: (ss) => ss.some((s) => s.spots?.some((sp) => sp.spot === 'focus-groups' && !!sp.inspect)),
    // seeded before the fill: only the demo's families live in town, so ask where a child lives (the tour's home fills with the town)
    seeded: (d) => d.children.some((k) => { const f = d.focusAt?.(k.x, k.y); return !!f && f.people > 0 && f.pct.reduce((a, b) => a + b, 0) === 100; }) },
  { id: 'advert-reach', caption: 'a seeded campaign reaching a showcase commuter', tour: 'high-street', todo: 'reach is adverts A4 (docs/adverts.md section 4): it needs citizens\' beliefs (docs/motivation.md)' },
  { id: 'school-bus', caption: 'a school bus on a round (a fleet unit of kind 9)', tour: 'secondary-school', todo: 'the school buses are E6 (docs/education.md section 10): they take over from the escorts and the missed days' },
  { id: 'london-school-run', caption: 'children living within reach of a primary and a secondary school in London', tour: 'primary-islington', demo: 'london',
    rule: 'London has its own schools in its boroughs, and the four London universities are landmarks that stand in London, not the showcase',
    seeded: schoolRun([Study.Primary, Study.Secondary]) },
  { id: 'tower-bridge-lift', caption: 'St Katharine Docks\' tall boats through Tower Bridge\'s lifts', tour: 'st-katharine', demo: 'london',
    rule: 'Tower Bridge and St Katharine Docks are London\'s; the showcase\'s own lifting bridge has its tall boat (boat-lift)',
    seeded: tallThroughLift },
  // ---- London on the new roads (docs/demo.md "London", "Roads"): the showcase shows one of each; London uses them all
  { id: 'london-avenues', caption: 'London\'s main roads as avenues, every carriageway tile with road ahead and behind', tour: 'bus-oxford-street', demo: 'london',
    rule: 'the showcase has its own avenues (road-class-avenue); this is London\'s arterials laid as avenues',
    scenario: (ss) => ss.some((s) => s.classRoads?.some((r) => r.cls === RoadCls.Avenue && !!r.path)), seeded: (d) => londonRoads(d).n[RoadCls.Avenue] >= 1000 && londonRoads(d).dead === 0 },
  { id: 'london-motorways', caption: 'the M4 and the A13 as motorways from their connections, each with a diamond interchange', tour: 'm4-interchange', demo: 'london',
    rule: 'the showcase has its own motorway and interchange; these are London\'s approaches',
    scenario: (ss) => ss.some((s) => (s.junctions ?? []).filter((j) => j.tool === 'interchange').length >= 2), seeded: (d) => (d.kinds.get(MOTORWAY_KIND) ?? 0) >= 2 && londonRoads(d).deck >= 4 && londonRoads(d).n[RoadCls.Motorway] >= 40 },
  { id: 'london-roundabouts', caption: 'two-lane roundabouts at Hyde Park Corner, Marble Arch, Elephant and Castle and Old Street', tour: 'hyde-park-corner', demo: 'london',
    rule: 'the showcase has its own (big-roundabout); these are London\'s',
    scenario: (ss) => ss.some((s) => (s.junctions ?? []).filter((j) => j.tool === 'roundabout' && j.big).length >= 4), seeded: (d) => londonRoads(d).island >= 36 },
  { id: 'london-pedestrian', caption: 'pedestrian streets in London (Carnaby Street, the Barbican)', tour: 'carnaby-street', demo: 'london',
    rule: 'the showcase has its own (road-class-pedestrian); these are London\'s',
    scenario: classRoad(RoadCls.Pedestrian), seeded: (d) => londonRoads(d).n[RoadCls.Pedestrian] >= 4 },
  // ---- tour sound (docs/audio.md "Tour cues"): every London tour stop plays a cue on arrival, or says on purpose that the beds are enough
  { id: 'london-tour-sound', caption: 'a sound cue (or an explicit ambience) at every London tour stop', tour: 'parliament', demo: 'london',
    rule: 'the showcase takes a few cues of its own (the Sound stop plays what it describes); the full table is London\'s, because the tour there runs through the city\'s places',
    scenario: () => tourSoundProblems('london', demoTour('london')).length === 0 },
  { id: 'london-street-rules', caption: 'London\'s street rules: bus lanes on Oxford Street and the Euston Road, 20 zones round the schools, double yellows in the City, turn bans', tour: 'zone20-islington', demo: 'london',
    rule: 'the showcase has one of each rule; these are London\'s',
    scenario: (ss) => ss.some((s) => (s.streetRules ?? []).length >= 10), seeded: (d) => { const r = londonRoads(d).rules; return (r.bus ?? 0) >= 10 && (r.zone20 ?? 0) >= 50 && (r.yellow ?? 0) >= 30 && (r.ban ?? 0) >= 2; } },
];

/** Problems with the feature registry that the scenario alone shows: a feature or its tour stop missing from its demo. */
export function featureProblems(features: readonly ShowcaseFeature[] = SHOWCASE_FEATURES): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const tours = new Map<DemoId, Set<string>>();
  const tourOf = (id: DemoId) => tours.get(id) ?? tours.set(id, new Set(demoTour(id).map((t) => t.id))).get(id)!;
  for (const f of features) {
    if (ids.has(f.id)) out.push(`feature ${f.id} is listed twice`);
    ids.add(f.id);
    if (f.todo) continue;
    const demo = f.demo ?? 'showcase', where = demo === 'showcase' ? 'the showcase' : `the ${DEMO_BY_ID.get(demo)?.name ?? demo} demo`;
    if (demo !== 'showcase' && !f.rule) out.push(`feature ${f.id} lives in ${where} but gives no rule why it is not in the showcase`);
    if (!f.scenario && !f.seeded) out.push(`feature ${f.id} has nothing to check`);
    if (f.scenario && !f.scenario(demoSections(demo))) out.push(`${f.caption} (feature ${f.id}) is not in ${where}`);
    if (!f.tour) out.push(`feature ${f.id} has no tour stop`);
    else if (!tourOf(demo).has(f.tour)) out.push(`feature ${f.id}'s tour stop ${f.tour} is not on the tour of ${where}`);
  }
  return out;
}

/** Problems a seeded demo shows: an enabled feature of that demo whose `seeded` test fails on what was built. */
export function seededFeatureProblems(demo: DemoId, d: SeededDemo, features: readonly ShowcaseFeature[] = SHOWCASE_FEATURES): string[] {
  return features.filter((f) => !f.todo && (f.demo ?? 'showcase') === demo && f.seeded && !f.seeded(d))
    .map((f) => `${f.caption} (feature ${f.id}) is not in the seeded ${demo === 'showcase' ? 'showcase' : `${demo} demo`}`);
}


/**
 * What the showcase is missing, as messages (empty when complete). Every placeable kind (a tool, not a draft, not a
 * growing zone) must be placed, in particular every kind bigger than 1×1 and every size-ladder rung; every zoning tool
 * must have a grown block on the tour; every surface tool must be painted and every line mode run; every placement
 * kind must be on the tour; tour ids and placement ids must be unique and resolve; every registered feature must be in
 * its demo's scenario with a tour stop (featureProblems; their `seeded` tests run in demo:check).
 */
export function showcaseProblems(manifest: readonly KindManifest[] = MANIFEST): string[] {
  const out: string[] = [];
  const sections = demoSections('showcase');
  const placed = new Set<string>(), ids = new Set<string>(), blockKinds = new Set<string>();
  const dup = (id: string) => { if (ids.has(id)) out.push(`id ${id} is used twice`); ids.add(id); };
  for (const s of sections) {
    for (const p of s.placements ?? []) { placed.add(p.kind); dup(p.id ?? p.kind); }
    for (const b of s.blocks ?? []) { blockKinds.add(b.kind); dup(b.id); }
    for (const r of s.runways ?? []) dup(r.id);
    for (const t of s.tracks ?? []) dup(t.id);
    for (const j of s.junctions ?? []) dup(j.id);
    for (const r of s.streetRules ?? []) dup(r.id);
    for (const b of s.bridges ?? []) dup(b.id);
    for (const u of s.utilLinks ?? []) dup(u.id);
    for (const l of s.lines ?? []) dup(l.id);
    for (const sp of s.spots ?? []) dup(sp.id);
  }
  // landmarks (docs/buildings.md "Landmarks") stand in their own city's demo (the London ones in London), not the showcase;
  // a landmark drawn over a bridge (Tower Bridge) is placed by laying that bridge; LONDON_EXEMPT doubles as the
  // city-demo exemption — a world landmark whose city has no demo yet cannot stand in one (london-kinds.ts)
  const inCity = new Set(DEMOS.filter((d) => d.id !== 'showcase').flatMap((d) => demoSections(d.id).flatMap((s) => [
    ...(s.placements ?? []).map((p) => p.kind), ...(s.bridges ?? []).flatMap((b) => (b.landmark ? [b.landmark] : [])),
  ])));
  for (const k of manifest) {
    if (k.draft || !k.tool) continue;
    if (k.landmark) {
      if (!inCity.has(k.id) && !LONDON_EXEMPT[k.id]) out.push(`${k.id} (a ${(k.tags ?? []).join(', ')} landmark) is not placed in its city's demo`);
      continue;
    }
    if (k.flags.growable) {
      if (!blockKinds.has(k.id)) out.push(`zone ${k.id} (${k.tool.label}) has no grown block on the showcase tour`);
      continue;
    }
    if (!placed.has(k.id)) {
      const why = k.group ? `a rung of the ${k.group} ladder (tier ${k.tier})` : k.footprint && k.footprint.w * k.footprint.h > 1 ? `a ${k.footprint.w}×${k.footprint.h} structure` : 'a placeable kind';
      out.push(`${k.id} (${why}) is not placed in the showcase`);
    }
  }
  const all = (f: (s: DemoSection) => unknown[] | undefined) => sections.flatMap((s) => f(s) ?? []);
  for (const tool of Object.keys(SURFACE_TOOLS) as SurfaceTool[]) {
    const n = tool === 'runway' ? all((s) => s.runways).length : tool === 'rail' ? all((s) => s.tracks).length
      : tool === 'pylons' || tool === 'cable' ? all((s) => s.utilLinks?.filter((l) => l.mode === (tool === 'pylons' ? 'overhead' : 'buried'))).length
        : tool === 'streetrule' ? all((s) => s.streetRules).length // R5: the Street rules tool's rules
        : all((s) => s.junctions?.filter((j) => j.tool === tool)).length;
    if (!n) out.push(`no ${tool} is painted in the showcase`);
  }
  const lines = all((s) => s.lines) as DemoLine[];
  for (const m of Object.keys(LINE_MODES) as (TransitMode | 'freight')[]) {
    // a mode whose station kinds are all drafts (the metro until it is placed in the showcase) is not asked for yet
    if (m !== 'freight' && MANIFEST.filter((k) => STOP_KINDS[k.kindId] === m).every((k) => k.draft)) continue;
    if (!lines.some((l) => (l.freight ? 'freight' : l.mode) === m)) out.push(`no ${m} line runs in the showcase`);
  }
  const tourIds = new Set(TOUR);
  if (tourIds.size !== TOUR.length) out.push('the tour lists an id twice');
  for (const id of TOUR) if (id !== 'welcome' && !ids.has(id)) out.push(`tour stop ${id} names nothing in the scenario`);
  const toured = new Set(demoTour('showcase').map((t) => t.kind).filter((k): k is number => k !== undefined));
  for (const kind of placed) if (!toured.has(kindIdOf(kind))) out.push(`${kind} is placed but no tour stop shows it`);
  out.push(...featureProblems());
  for (const s of sections) for (const l of s.lines ?? []) {
    const want = l.mode === 'bus' ? ['bus-stop'] : l.freight ? ['freight-yard'] : l.mode === 'metro' ? ['metro-entrance', 'metro-station'] : l.mode === 'ferry' ? ['ferry-pier'] : ['rail-halt', 'rail-station'];
    for (const st of l.stops) {
      const p = sections.flatMap((q) => q.placements ?? []).find((q) => q.door[0] === st[0] && q.door[1] === st[1]);
      if (!p || !want.includes(p.kind)) out.push(`${l.id} stops at (${st[0]}, ${st[1]}), which is not a ${want.join(' or ')} placement`);
    }
  }
  return out;
}

/**
 * What London is missing, as messages (empty when complete; docs/demo.md "Keeping it complete"). London is a city demo
 * that shows the whole catalogue at the size of a real city: every placeable kind (a tool, not a draft, not a growing
 * zone; the landmarks too) stands at least once across its sections, or is in `LONDON_EXEMPT` with a reason (london-kinds.ts).
 * Also: placement ids are unique across London's sections, the stops this section adds to the tour resolve, and an
 * exemption names a kind that exists.
 */
export function londonProblems(manifest: readonly KindManifest[] = MANIFEST): string[] {
  const out: string[] = [];
  const sections = demoSections('london');
  const placed = new Set<string>(), ids = new Set<string>();
  for (const s of sections) {
    for (const p of s.placements ?? []) {
      placed.add(p.kind);
      if (ids.has(p.id ?? p.kind)) out.push(`London places id ${p.id ?? p.kind} twice`);
      ids.add(p.id ?? p.kind);
    }
    // a landmark drawn over a bridge (Tower Bridge) is placed by laying that bridge
    for (const b of s.bridges ?? []) if (b.landmark) placed.add(b.landmark);
  }
  const known = new Set(manifest.map((k) => k.id));
  for (const id of Object.keys(LONDON_EXEMPT)) if (!known.has(id)) out.push(`LONDON_EXEMPT names ${id}, which is not a catalogue kind`);
  for (const k of manifest) {
    if (k.draft || !k.tool || k.flags.growable || placed.has(k.id) || LONDON_EXEMPT[k.id]) continue;
    if (k.landmark && CITY_DEMO_GROUPS.has(k.group ?? '')) continue; // a sample city's own landmark stands there (cityProblems)
    const why = k.group ? `a rung of the ${k.group} ladder (tier ${k.tier})` : k.footprint && k.footprint.w * k.footprint.h > 1 ? `a ${k.footprint.w}×${k.footprint.h} structure` : 'a placeable kind';
    out.push(`${k.id} (${why}) has no home in London: place it where its real counterpart stands (london-kinds.ts) or exempt it with a reason`);
  }
  const stops = new Set(demoTour('london').map((t) => t.id));
  for (const id of KIND_TOUR_IDS) if (!stops.has(id)) out.push(`London's tour stop ${id} (london-kinds.ts) names nothing in the scenario`);
  return out;
}

/**
 * What a sample city on the kit is missing, as messages (docs/demo.md "Sample cities and the city-map kit"): its
 * scenario planned without a problem (every landmark, station, harbour and stop fitted, every bridge found); every
 * landmark of its city's collection (the landmark group named by its id) standing, placed or as a bridge's span; ids
 * unique and every tour stop resolving; every placement framed by a tour stop (on the tour by its id, or inside the
 * area, line or spot a stop frames); and each line's stops placements of the right kind.
 */
export function cityProblems(id: DemoId, manifest: readonly KindManifest[] = MANIFEST): string[] {
  const d = DEMO_BY_ID.get(id);
  if (!d?.city) return [`${id} is not a sample city`];
  const out = cityScenario(d.city).problems.map((p) => `${d.name}: ${p}`);
  const sections = demoSections(id), placed = new Set<string>(), ids = new Set<string>();
  const dup = (q: string) => { if (ids.has(q)) out.push(`${d.name}: id ${q} is used twice`); ids.add(q); };
  for (const s of sections) {
    for (const p of s.placements ?? []) { placed.add(p.kind); dup(p.id ?? p.kind); }
    for (const b of s.bridges ?? []) { dup(b.id); if (b.landmark) placed.add(b.landmark); }
    for (const x of [...(s.blocks ?? []), ...(s.tracks ?? []), ...(s.junctions ?? []), ...(s.lines ?? []), ...(s.spots ?? [])]) dup(x.id);
  }
  for (const k of manifest) if (k.landmark && !k.draft && k.group === d.city.id && !placed.has(k.id)) out.push(`${d.name}: its landmark ${k.id} is not placed`);
  const tour = demoTour(id), onTour = new Set(tour.map((t) => t.id));
  for (const q of d.tour ?? []) if (q !== 'welcome' && !ids.has(q)) out.push(`${d.name}: tour stop ${q} names nothing in the scenario`);
  if (new Set(d.tour).size !== d.tour?.length) out.push(`${d.name}: the tour lists an id twice`);
  const frames = tour.filter((t) => t.id !== 'welcome').map((t) => t.rect ?? (t.placed ? [t.placed.ax, t.placed.ay, t.placed.w, t.placed.h] as const : null)).filter((r): r is DemoRect => !!r);
  const inside = ([x, y]: DemoXY) => frames.some(([rx, ry, rw, rh]) => x >= rx && y >= ry && x < rx + rw && y < ry + rh);
  for (const s of sections) for (const p of s.placements ?? []) if (!onTour.has(p.id ?? p.kind) && !inside(p.door)) out.push(`${d.name}: ${p.id ?? p.kind} is placed but no tour stop frames it`);
  const all = sections.flatMap((q) => q.placements ?? []);
  for (const s of sections) for (const l of s.lines ?? []) {
    const want = l.mode === 'bus' ? ['bus-stop'] : l.freight ? ['freight-yard'] : l.mode === 'metro' ? ['metro-entrance', 'metro-station'] : l.mode === 'ferry' ? ['ferry-pier'] : ['rail-halt', 'rail-station'];
    if (l.stops.length < 2) out.push(`${d.name}: ${l.id} has fewer than two stops`);
    for (const st of l.stops) {
      const p = all.find((q) => q.door[0] === st[0] && q.door[1] === st[1]);
      if (!p || !want.includes(p.kind)) out.push(`${d.name}: ${l.id} stops at (${st[0]}, ${st[1]}), which is not a ${want.join(' or ')} placement`);
    }
  }
  return out;
}

/**
 * A demo's bridges drawn as a landmark that are not bascules (Tower Bridge is drawn over every bascule span): the
 * Brooklyn Bridge and the Golden Gate in their cities, each its first deck tile (lowest x or y) and the landmark's kind
 * id. The client draws the landmark's model over the span (render/chunkView.ts) in place of the style's towers.
 */
export function demoLandmarkSpans(id: DemoId): { x: number; y: number; kind: number }[] {
  return demoSections(id).flatMap((s) => (s.bridges ?? []).filter((b) => b.landmark && b.style !== 'Bascule' && kindIdOf(b.landmark)).map((b) => ({
    x: Math.min(b.from[0], b.to[0]), y: Math.min(b.from[1], b.to[1]), kind: kindIdOf(b.landmark!),
  })));
}

/** The substations a demo's blackout drill faults every few game hours (server sim/utilities.ts `drills`, set by index.ts): its 'blackout' spots' doors. */
export function demoBlackouts(id: DemoId): DemoXY[] {
  return demoSections(id).flatMap((s) => (s.spots ?? []).filter((sp) => sp.spot === 'blackout' && sp.inspect).map((sp) => sp.inspect!));
}
/** A demo's trunk links (docs/utilities.md), as the link tools would lay them: the seeder resolves their ends and writes them to the save. */
export const demoUtilLinks = (id: DemoId): DemoUtilLink[] => demoSections(id).flatMap((s) => s.utilLinks ?? []);

/** The homes a demo's fire drill burns (server sim/fires.ts `drills`, set by index.ts): the inspect tiles of its 'house-fire' spots. */
export function demoFireDrills(id: DemoId): DemoXY[] {
  return demoSections(id).flatMap((s) => (s.spots ?? []).filter((sp) => sp.spot === 'house-fire' && sp.inspect).map((sp) => sp.inspect!));
}
/** A demo's funeral drills (server sim/death.ts `drills`, set by index.ts): its 'funeral' spots' funeral director and resting place. */
export function demoFunerals(id: DemoId): { from: DemoXY; to: DemoXY }[] {
  return demoSections(id).flatMap((s) => (s.spots ?? []).filter((sp) => sp.spot === 'funeral' && sp.funeral).map((sp) => sp.funeral!));
}
/** A demo's resting places to seed with the long dead (server demo/seed.ts seedDemoGraves): door and the share of plots. */
export function demoGraves(id: DemoId): { door: DemoXY; share: number }[] {
  return demoSections(id).flatMap((s) => (s.placements ?? []).filter((p) => (p.graves ?? 0) > 0).map((p) => ({ door: p.door, share: p.graves! })));
}
/** A demo's spread drill rows (server sim/fires.ts `rows`, set by index.ts): the rows of its 'fire-spread' spots. */
export function demoFireRows(id: DemoId): DemoXY[][] {
  return demoSections(id).flatMap((s) => (s.spots ?? []).filter((sp) => sp.spot === 'fire-spread' && sp.row?.length).map((sp) => [...sp.row!]));
}
/** A demo's blast drill works (server sim/fires.ts `blastDrills`): the inspect tiles of its 'fire-blast' spots. */
export function demoFireBlasts(id: DemoId): DemoXY[] {
  return demoSections(id).flatMap((s) => (s.spots ?? []).filter((sp) => sp.spot === 'fire-blast' && sp.inspect).map((sp) => sp.inspect!));
}
/** What the seeded showcase has standing: fire buildings, and the level of every grown lot by tile (home, shop, works, office). */
function demoFireTiles(d: SeededDemo) {
  const fire: [number, number][] = [], built = new Map<string, number>();
  d.scan((x, y, t, a) => {
    const z = zoneOf(t);
    if (!a && z === Zone.Fire) fire.push([x, y]);
    else if ((z === Zone.Residential || z === Zone.Commercial || z === Zone.Industrial || z === Zone.Office) && levelOf(t) > 0) built.set(`${x},${y}`, z);
  });
  const covered = ([x, y]: DemoXY) => fire.some(([fx, fy]) => Math.max(Math.abs(fx - x), Math.abs(fy - y)) <= FIRE.reach);
  return { built, covered };
}
/** Spread rows standing as homes, each touching the next, with a fire building in reach (demo:check's seeded test). */
function demoFireRowsOf(d: SeededDemo): DemoXY[][] {
  const { built, covered } = demoFireTiles(d);
  return demoFireRows('showcase').filter((row) => row.every((p, i) => built.get(`${p[0]},${p[1]}`) === Zone.Residential && covered(p)
    && (i === 0 || Math.max(Math.abs(p[0] - row[i - 1][0]), Math.abs(p[1] - row[i - 1][1])) === 1)));
}
/** Blast drills standing on a works, with buildings within FIRE.blastReach and a fire building in reach (demo:check's seeded test). */
function demoFireBlastsOf(d: SeededDemo): DemoXY[] {
  const { built, covered } = demoFireTiles(d);
  return demoFireBlasts('showcase').filter(([x, y]) => {
    if (built.get(`${x},${y}`) !== Zone.Industrial || !covered([x, y])) return false;
    let round = 0;
    for (let dy = -FIRE.blastReach; dy <= FIRE.blastReach; dy++) for (let dx = -FIRE.blastReach; dx <= FIRE.blastReach; dx++) if ((dx || dy) && built.has(`${x + dx},${y + dy}`)) round++;
    return round >= 6;
  });
}
/** The fire drills of the showcase that stand on a home with a fire building within FIRE.reach (demo:check's seeded test). */
function demoFireDrillsOf(d: SeededDemo): DemoXY[] {
  const fire: [number, number][] = [];
  const homes = new Set<string>();
  d.scan((x, y, t, a) => { if (a) return; const z = zoneOf(t); if (z === Zone.Fire) fire.push([x, y]); else if (z === Zone.Residential && levelOf(t) > 0) homes.add(`${x},${y}`); });
  return demoFireDrills('showcase').filter(([x, y]) => homes.has(`${x},${y}`) && fire.some(([fx, fy]) => Math.max(Math.abs(fx - x), Math.abs(fy - y)) <= FIRE.reach));
}
