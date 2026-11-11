import type { PaletteName, WindowClass } from './palette';
import type { AdSize } from './adslot';

// ---------------------------------------------------------------- recipes

/** A palette name ('brick') or a 0xRRGGBB number. */
export type Color = PaletteName | number;
/** On a box: a window class name, or `true` for the kind's own `windows` class. */
export type Win = WindowClass | true;

/**
 * Model recipe operations. Each is a tuple: the op name, then the same
 * arguments as the matching `Kit` call (render/kit.ts). Sizes and positions
 * are in tiles; a tile is 1×1 with its centre at x=0, z=0, ground at y=0,
 * and +z faces the road.
 */
export type Op =
  /** box w h d x y z color [win] [{ name, facade }]: base at y, centred on x,z; a facade lays its windows out by storey and bay */
  | ['box', number, number, number, number, number, number, Color, Win?, PartOpts?]
  /** roof w h d x y z color [alongZ] [{ name }]: pitched prism, ridge along x unless alongZ */
  | ['roof', number, number, number, number, number, number, Color, boolean?, PartOpts?]
  /** cyl rTop rBot h x y z color [segments=8] */
  | ['cyl', number, number, number, number, number, number, Color, number?]
  /** cone r h x y z color [segments=8] */
  | ['cone', number, number, number, number, number, Color, number?]
  /** wheel r w x y z color: a cylinder lying along x */
  | ['wheel', number, number, number, number, number, Color]
  /**
   * taper wBot dBot wTop dTop h x y z color [{ win, shift }]: a box whose top face is a different rectangle (wTop×dTop,
   * 0×0 for a pyramid), centred over the base or `shift`ed by [dx, dz]; base at y. Tapering towers, splayed shards, a slab
   * that widens upwards. `win` lights its near-vertical faces with the legacy window grid.
   */
  | ['taper', number, number, number, number, number, number, number, number, Color, TaperOpts?]
  /**
   * lathe x y z color profile [{ seg, twist, stripe, every, width, axis, win }]: a solid of revolution about the vertical
   * axis through x, y, z. `profile` is [r, dy, r, dy, ...] from the base up (dy above y; r 0 for a point); an open top is
   * capped flat. `twist` turns the rings by that many degrees per tile of height; with `stripe`, `width` facets in every
   * `every` take that colour, so a twisted lathe has spiral bands (the Gherkin's glazing). `axis` 'x' or 'z' lays it on
   * its side, the profile running along +x or +z from x, y, z (a barrel vault: half of it inside the box below).
   */
  | ['lathe', number, number, number, Color, number[], LatheOpts?]
  /** crane x y z mastHeight: tower crane (helper) */
  | ['crane', number, number, number, number]
  /** flag x y z color: pole with a flag (helper) */
  | ['flag', number, number, number, Color]
  /** chimneyStack x y z h r [body='chimney']: tapered stack with a red cap (helper) */
  | ['chimneyStack', number, number, number, number, number, Color?]
  // features placed by cell on a facade box (buildings/facade.ts, docs/buildings.md "Facades"); `part` is a box's name or op index
  /** door part face bay [colour='door']: a door in that ground-floor cell, which then draws no window */
  | ['door', PartRef, FaceName, number, Color?]
  /** balcony part face storey fromBay toBay [rail='dark'] [slab='stone']: on the floor line under that storey; its windows become glazed doors */
  | ['balcony', PartRef, FaceName, number, number, number, Color?, Color?]
  /** baywindow part face storey bay [roof='slate']: a glazed bay projecting from that cell */
  | ['baywindow', PartRef, FaceName, number, number, Color?]
  /** porch part face fromBay toBay [roof='slate'] [posts='white']: a canopy on posts over those ground-floor bays */
  | ['porch', PartRef, FaceName, number, number, Color?, Color?]
  /** awning part face fromBay toBay [colour='awning']: a canopy without posts over those ground-floor bays (shopfronts) */
  | ['awning', PartRef, FaceName, number, number, Color?]
  /** garage part face bay: a roller door drawn in that ground-floor cell */
  | ['garage', PartRef, FaceName, number]
  /** dormer roofPart n [body='white']: n dormers along the roof's front slope (right slope for a ridge along z) */
  | ['dormer', PartRef, number, Color?]
  /** cornice part storey [colour='stone']: a band round the box on that storey's floor line (storey = storeys: on top) */
  | ['cornice', PartRef, number, Color?]
  /**
   * adslot part face bay storey size [at]: an ad slot (docs/adverts.md section 2, buildings/adslot.ts), an empty frame the
   * game can rent out. On a facade box by cell; on a plain box bay and storey are 0 and it is centred, or placed `at`
   * [along, up] (fractions of the wall). Never on the back wall, never over a window.
   */
  | ['adslot', PartRef, FaceName, number, number, AdSize, [number, number]?]
  /**
   * screens x y z r from to cols rows h [bezel='charcoal']: a bank of big screens round a curve (docs/adverts.md section 9,
   * buildings/adslot.ts screenArc): cols × rows flat `screen` slots on the facets of a dark bezel band of radius r about
   * (x, z), from `from` to `to` degrees (0 faces the front, 90 the right, -90 the left), foot at y, h tall. A column's
   * angle must divide 360 and `from`, so the panels sit flush on the bezel's facets; never facing the back.
   */
  | ['screens', number, number, number, number, number, number, number, number, number, Color?];

export interface TaperOpts { win?: Win; shift?: [number, number] }
export interface LatheOpts { seg?: number; twist?: number; stripe?: Color; every?: number; width?: number; axis?: 'y' | 'x' | 'z'; win?: Win }

/** A wall of a box: front faces +z (the road), right +x, back -z, left -x. Bays count from the left as seen from outside. */
export type FaceName = 'front' | 'right' | 'back' | 'left';
/** A box or roof in the same design: its `name` option, or its index in the design's ops (0-based, as authored). */
export type PartRef = string | number;
/** Options after a box's window class or a roof's alongZ flag. */
export interface PartOpts {
  /** lets feature ops refer to this part */
  name?: string;
  /** boxes with windows: lay them out per wall by storey and bay */
  facade?: FacadeSpec;
}
/**
 * Windows by storey and bay (docs/buildings.md "Facades"). Each wall is split into `storeys` rows (the box height
 * less `top`, evenly) and bays columns between `margin`s: `bays` on the front and back, `sideBays` on the sides.
 * The shader draws one window centred in each cell; features placed by cell replace or change cells.
 */
export interface FacadeSpec {
  storeys: number;
  bays: number;
  /** bays on the left and right walls (default: bays scaled by depth / width, at least 1; 0 = blank sides) */
  sideBays?: number;
  /** the front wall's ground storey: windows (default; shops default to shopfront), a door in the middle bay, a shopfront, garage doors or plain wall */
  ground?: 'windows' | 'door' | 'shopfront' | 'garage' | 'plain';
  /** plain wall at each end of every wall, in tiles (default 0) */
  margin?: number;
  /** plain band at the top of the box (parapet or attic), in tiles (default 0) */
  top?: number;
}

export type OpName = Op[0];

/** One look for a kind+level. A tile picks one of its kind+level's designs by hash. */
export interface Design {
  /** short description, shown in the viewer */
  name: string;
  /** top of the model in tiles; the crane over an upgrading building sits here */
  height: number;
  ops: Op[];
  /** drafts are compiled and shown in the viewer but never placed in the city */
  draft?: boolean;
  /** who designed it: a person, or the AI model id (e.g. 'claude-haiku-5-5'); shown and filterable in the viewer */
  author?: string;
  /** attributes for this design only (override the level's and the kind's) */
  attrs?: Attributes;
}

// ---------------------------------------------------------------- attributes

/** Extensible per-family attributes. Unknown keys are allowed; the listed ones are validated. */
export interface Attributes {
  // industrial
  pollution?: number;
  noise?: number;
  goodsType?: string;
  // commercial
  commerceType?: string;
  visitorCapacity?: number;
  openHours?: [number, number];
  // residential
  style?: string;
  rentBand?: 'low' | 'mid' | 'high';
  // leisure: parks, cinemas, theatres, sports halls, libraries (see shared/src/leisure.ts for how the sim reads them)
  /** 'park' | 'cinema' | 'theatre' | 'sports' | 'library': picks the outing wording and who it appeals to */
  venueType?: string;
  /** how much one visit restores a citizen's leisure need (about 0.08 per point), and the place's weight in the leisure coverage of homes in `radius` */
  leisureValue?: number;
  /** tiles (Manhattan) within which homes count this place in their leisure coverage */
  radius?: number;
  /** weekdays (0 = Monday) with an event night: premieres, performances, matches, a quiz */
  eventNights?: number[];
  /** hour the event starts on an event night */
  eventStart?: number;
  /** spend per visit (sales tax to the parcel, as at a bar); 0 = free */
  ticket?: number;
  /** [min, max] hours a visit lasts */
  stay?: [number, number];
  /** appeal by time of day (0 = never, 1 = like a bar) and to retirees and children (multipliers) */
  dayAppeal?: number;
  eveningAppeal?: number;
  retireeAppeal?: number;
  childAppeal?: number;
  /** name of this level or design in tooltips ('pocket park', 'community hall') */
  title?: string;
  /** parks: daily visits that make it grow to the next level (builders add paths, trees and a fountain) */
  upgradeVisits?: number;
  /** parks (client scatter): path layout and how many trees and benches to plant */
  paths?: string;
  trees?: number;
  benches?: number;
  // size tiers (groups.ts): read by the simulation through shared/src/tiers.ts; defaults keep the pre-tier behaviour
  /** service kinds: tiles (square, from the door) within which homes count it in their coverage; default SERVICE_RADIUS */
  serviceRadius?: number;
  /** service kinds: weight of this station in a home's coverage (1 = a full service; the best station per family counts) */
  serviceStrength?: number;
  /** police, fire and health: patrols or call-outs sent per hour, relative to a station (1) */
  patrolRate?: number;
  /** builders' yards: work each builder does per hour, relative to a yard's crew (1) */
  workRate?: number;
  /** leisure venues: how much harder an event night pulls people in (1 = the usual premiere or match night) */
  eventSize?: number;
  /** leisure venues: how much of a visit is out of doors, 0-1 (default 1 for a park, 0 otherwise): the weather's pull on it (docs/weather.md W4) */
  outdoor?: number;
  // gateways (shared/src/gateways.ts): where newcomers arrive and leavers go, read by the server's sim/gateways.ts
  /** what kind of way in and out of town this is: 'motorway' | 'rail' | 'bus' | 'air' | 'sea' (sea: later, needs water) */
  gateway?: string;
  /** how arrivals travel on from the gate: 'car' (drive their own car in), 'foot' (walk with a suitcase), 'taxi' (a car trip) */
  gatewayModes?: string[];
  /** newcomers the gateway can bring in per game hour (more arrive with each plane at an airport) */
  arrivalsPerHour?: number;
  /** a seaport needs water beside it (the seaport subtask reads this) */
  needsWater?: boolean;
  [key: string]: string | number | boolean | [number, number] | number[] | string[] | undefined;
}

// ---------------------------------------------------------------- kinds

export type Family = 'residential' | 'commercial' | 'industrial' | 'office' | 'civic' | 'transport' | 'leisure' | 'utility';

export interface Flags {
  /** grows by itself on zoned land (via construction sites), up to its top level */
  growable?: boolean;
  /** placed by a player, built by builders, staffed, paid upkeep */
  civic?: boolean;
  /** gives service coverage to nearby homes */
  service?: boolean;
  /** employs citizens */
  workplace?: boolean;
  /** holds parked cars as its main purpose (a lot) */
  parking?: boolean;
  /** can host leisure visitors (cafés and bars, parks and venues) */
  leisureReady?: boolean;
}

export interface Shift { start: number; hours: number; weight: number }
/** Who works at this kind and when. */
export interface OccupationDef {
  name: string;
  shifts: Shift[];
  /** work/rest patterns; one is picked per citizen. 1 = works that day. */
  cycles: number[][];
  /** randomise where in the cycle each citizen starts (rotating rosters) */
  rotate: boolean;
}

/** Numbers the simulation reads for one kind+level. */
export interface LevelStats {
  /** residents (residential) or jobs (everything else) */
  capacity: number;
  /** pay for a standard 8-hour shift */
  wage: number;
  /** daily upkeep paid by the parcel owner */
  upkeep: number;
  /** one-off placement price (placed kinds); growable zones pay the per-tile ZONE_COST instead */
  cost: number;
  /** builder work units to build this level */
  work: number;
  /** cars it can take off the street without, and with, Deep foundations */
  parking: { surface: number; underground: number };
}

export interface LevelDef extends Partial<LevelStats> {
  /** tech feature needed to grow to this level ('level2', 'level3'), if any */
  feature?: string;
  attrs?: Attributes;
  designs: Design[];
}

export interface ToolDef {
  /** tool id: also the tech feature that unlocks placing it */
  id: string;
  /** keyboard shortcut */
  key: string;
  label: string;
  /** CSS colour of the tool swatch */
  color: string;
}

/**
 * Tiles a kind covers. The model recipe is authored in tiles for this footprint: w along x, h along z, centred on
 * x=0, z=0, front (+z) towards the road. `door` is the tile on the front row (dy = h - 1) the simulation registers
 * the building at; the road must touch it. Default 1×1 with the door on the only tile. Up to 8×8 (docs/aux-layer.md).
 */
export interface Footprint {
  w: number; h: number; door: [number, number];
  /** significant parts drawn in the placement preview and on hover (docs/buildings.md); a door mark is implied from `door` */
  marks?: FootprintMark[];
  /**
   * Harbours (docs/boats.md section 5): how many back rows stand over water, 1 to h - 1. Those rows must be open water
   * on the player's land and the rest dry; the last dry row is the quay, with water behind every tile of it.
   */
  wet?: number;
  /**
   * With `wet`: the width class the water behind the back edge must have, 1 narrow, 2 river, 3 open. Placement wants
   * 2 × fairwayClearance - 1 rows of open water behind the whole back edge (structures.ts `fairwayProblem`).
   */
  fairwayClearance?: number;
}

/** What a footprint mark stands for; decides its colour in the preview. */
export type MarkKind = 'door' | 'gate' | 'platform' | 'apron' | 'stand' | 'dock' | 'quay' | 'berth';
export type MarkEdge = 'front' | 'back' | 'left' | 'right';
/**
 * A significant part of a footprint, in unrotated footprint coordinates (x 0..w across, y 0..h with y = h the front, the
 * road side). `at` is one tile `[dx, dy]`, or a strip along an edge: `from`..`to` are tile indexes along that edge (inclusive,
 * default the whole edge) and `depth` is how many tiles it reaches inward (omitted or 0: a thin line on the boundary).
 * It turns with the footprint. `label` is the short text shown on hover.
 */
export interface FootprintMark {
  kind: MarkKind;
  at: [number, number] | { edge: MarkEdge; from?: number; to?: number; depth?: number };
  label?: string;
}

export interface KindDef extends Partial<LevelStats> {
  /** stable id, e.g. 'residential' */
  id: string;
  /** display name, lower case as used in sentences ('police station') */
  name: string;
  /** tile kind code 1-15: the family code written into the tile word (docs/sub-kinds.md) */
  code: number;
  /**
   * Stable numeric catalogue id, 1-255, persisted in the per-tile sub layer. Omitted on a family's base kind, whose
   * id is its code (a tile of that code with sub byte 0 is this kind). A sub-kind sharing a code takes an id from 16.
   */
  kindId?: number;
  family: Family;
  flags: Flags;
  /** default window class for boxes whose win is `true` */
  windows: WindowClass;
  tool?: ToolDef;
  occupation?: OccupationDef;
  attrs?: Attributes;
  /** facade tints picked per tile by hash (multiplied into the vertex colours) */
  tints?: number[];
  /** ground tint of an empty zoned lot (growable kinds) */
  lotTint?: number;
  /** what the engine reports for a tile of this kind before level 1 stands (empty lot or civic site) */
  lot?: Partial<Omit<LevelStats, 'parking'>> & { parking?: { surface: number; underground: number } };
  /** levels in order, from `minLevel` (default 1) up; kind-level numbers are defaults for every level */
  levels: LevelDef[];
  /**
   * The level the first entry of `levels` is (default 1). Merged zone kinds (zones.ts, docs/buildings.md "Merged lots")
   * start higher: a 2×2 mid-rise is level 4 and nothing less, so its `levels` hold only levels 4 and up. Table slots
   * below it repeat the first level's numbers and have no designs.
   */
  minLevel?: number;
  /** multi-tile structures: the footprint (default 1×1) */
  footprint?: Footprint;
  /** a work-in-progress kind: its tool is hidden from the tool bar unless the client has ?dev, and only a dev server accepts it */
  draft?: boolean;
  /**
   * Size ladder (groups.ts): the group this kind is a rung of ('health', 'police', ...) and its tier, 1 = smallest.
   * Every kind of a group shares a family code; the tool bar shows the group once and a picker lists the tiers.
   */
  group?: string;
  tier?: number;
  /** grouped kinds: one or two sentences for the picker card and the viewer: what this size is and what it adds */
  blurb?: string;
  /** grouped kinds: how to place it well (footprint, facing, what it needs nearby) */
  howTo?: string;
  /**
   * A landmark: a recognisable real building (docs/buildings.md "Landmarks"). It is a placed civic kind that works as an
   * existing role (offices, a venue, an attraction), sits in a `collection` group's picker, carries `tags`, and its
   * tool is unlocked only by a `locked` tech node, so a live game cannot place it until its unlock rule is decided.
   */
  landmark?: boolean;
  /** metadata labels, lower case ('london'): the viewer filters by them (?tag=london) and the client can list kinds by them */
  tags?: string[];
}

/** A helper model the renderer places on its own (the crane over a site, the site fence). */
export interface HelperModel { key: string; height: number; ops: Op[] }

// ---------------------------------------------------------------- compiled shapes

export interface DesignManifest { key: string; index: number; name: string; height: number; draft: boolean; ops: number; attrs: Attributes; author?: string }
export interface LevelManifest extends LevelStats { level: number; tech: string[]; feature?: string; attrs: Attributes; designs: DesignManifest[] }
export interface KindManifest {
  /** kindId: the numeric catalogue id (tables, sub layer, Building.id); code: the family code in the tile word */
  id: string; name: string; kindId: number; code: number; family: Family; flags: Required<Flags>; windows: WindowClass;
  tool?: ToolDef & { cost: number };
  /** tech ids needed to place or zone this kind */
  tech: string[];
  occupation?: OccupationDef;
  attrs: Attributes;
  tints?: number[];
  lotTint?: number;
  levels: LevelManifest[];
  /** present only for kinds bigger than 1×1 */
  footprint?: Footprint;
  draft?: boolean;
  /** size ladder (groups.ts) and its picker texts */
  group?: string; tier?: number; blurb?: string; howTo?: string;
  /** a landmark (docs/buildings.md "Landmarks") and its metadata tags */
  landmark?: boolean; tags?: string[];
}
/** A compiled recipe: primitive ops only, colours and window classes resolved to numbers. */
export type CompiledOp =
  | ['box', number, number, number, number, number, number, number, number, CompiledFacade?]
  | ['roof', number, number, number, number, number, number, number, boolean]
  | ['cyl', number, number, number, number, number, number, number, number]
  | ['cone', number, number, number, number, number, number, number]
  | ['wheel', number, number, number, number, number, number]
  /** taper wBot dBot wTop dTop h x y z colour win shiftX shiftZ */
  | ['taper', number, number, number, number, number, number, number, number, number, number, number, number]
  /** lathe x y z colour segments stripeColour every width twist axis(0 y, 1 x, 2 z) win profile ([r, dy] pairs, flat) */
  | ['lathe', number, number, number, number, number, number, number, number, number, number, number, number[]];
/**
 * A facade as recipes.ts carries it: storeys, bays front/back, side bays, margin, top band, and cell overrides as
 * flat quadruples (face 0-3 front/right/back/left, storey, bay, mode; buildings/facade.ts CELL).
 */
export interface CompiledFacade { s: number; b: number; sb: number; m: number; t: number; c?: number[] }
/** `kind` is the kind id; keys are `${kindId}:${level}:${design}`. */
export interface CompiledRecipe { key: string; kind: number; level: number; index: number; height: number; draft: boolean; ops: CompiledOp[] }
