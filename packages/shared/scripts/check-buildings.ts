/**
 * npm run buildings:check
 * Snapshot test for the building catalogue migration:
 *  1. the compiled tables and the tile.ts / occupations.ts wrappers return
 *     exactly what the hard-coded functions returned before the catalogue,
 *  2. every model the renderer builds has the same height, vertex count and
 *     geometry bytes as the old models.ts produced,
 *  3. the committed compiled.ts / recipes.ts are up to date,
 *  4. validation rejects the mistakes it is meant to catch,
 *  5-7. leisure, footprints, harbours (wet footprints, docs/boats.md section 5) and airfields,
 *  8. sub-kinds (docs/sub-kinds.md): kind id / family code / sub byte round trips, id-indexed tables and wrappers.
 *  9. size ladders (groups.ts, tiers.ts): the original kinds keep their behaviour as one rung each, tiers scale, every rung places.
 * 10. merged lots (zones.ts): the bigger zone kinds growth assembles, their level ranges, capacity per tile, tech and rotations.
 * 11. windows (facade.ts): no part covers a window. Facades, drafts and new designs fail; the original catalogue's
 *     known collisions (window-baseline.ts) are listed only. `--windows` prints every collision in full.
 * Tables are indexed by kind id; the snapshot kinds are base kinds, whose ids equal their old codes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../src/tile';
import { MAX_LEVEL } from '../src/constants';
import { OCCUPATIONS } from '../src/occupations';
import { CATALOGUE, HELPER_MODELS } from '../src/buildings/catalogue';
import { compileCatalogue, emitCatalogue } from '../src/buildings/compile';
import { validateCatalogue } from '../src/buildings/validate';
import * as V from '../src/buildings/validate';
import { WINDOW_CLASSES } from '../src/buildings/palette';
import { LANDMARK_DRAFT_IDS } from '../src/buildings/codes';
import { CAPACITY_TABLE, WAGE_TABLE, PARK_SURFACE_TABLE, PARK_UNDERGROUND_TABLE, MANIFEST, KIND_ID, CIVIC_TOOLS } from '../src/buildings/compiled';
import type { KindDef } from '../src/buildings/schema';
import { buildModels, allVariants, allDesigns } from '../../client/src/render/models';
import { LEISURE_CODES, leisureAt, leisureSpecs, isLeisure } from '../src/leisure';
import { Win } from '../../client/src/render/materials';
import * as S from '../src/structures';
import * as H from '../src/harbours';
import { mapByte, MapClass } from '../src/worldmap';
import * as A from '../src/airport';
import * as F from '../src/flights';
import { RECIPES } from '../src/buildings/recipes';
import { AD } from '../src/adverts';
import * as TI from '../src/tiers';
import { GROUPS } from '../src/buildings/groups';
import { shapeExtent } from '../src/buildings/facade';
import { techFor } from '../src/tech';
import { SERVICE_RADIUS } from '../src/constants';
import * as Z from '../src/zones';
import { TECH, levelFeature } from '../src/tech';
import { TOP_LEVEL_TABLE, DESIGN_COUNT_TABLE, KIND_FAMILY_TABLE } from '../src/buildings/compiled';
import { compileOps } from '../src/buildings/compile';
import { windowCollisions, windowRects, isFeature, CELL } from '../src/buildings/facade';
import type { CompiledOp, Op } from '../src/buildings/schema';
import { LEGACY_WINDOW_COLLISIONS } from './window-baseline';
import { EXTRA_DESIGNS } from '../src/buildings/designs/index';
import { AD_SLOTS } from '../src/buildings/compiled';
import { AD_STRIDE, AD_SIZES, FACE_YAW } from '../src/buildings/adslot';
import { compileCatalogue as compileAll } from '../src/buildings/compile';

/**
 * Harbours (docs/boats.md section 5): paint the water a wet kind placed at door (x, y) facing r needs (its wet rows and
 * the fairway band behind) into a scratch grid, so "clear land beside a road" checks work for every kind.
 */
function paintWater(grid: Map<string, number>, kind: number, x: number, y: number, r: number) {
  const spec = S.wetOf(kind);
  if (!spec) return;
  const p = S.placedFromDoor(kind, x, y, r), fp = S.footprintOf(kind);
  for (let ly = -S.fairwayDepth(spec.fairwayClearance); ly < spec.wet; ly++) for (let lx = 0; lx < fp.w; lx++) {
    const [tx, ty] = S.footprintTile(p, lx, ly);
    grid.set(`${tx},${ty}`, T.packTile(T.Terrain.Water, false, 0, 0));
  }
}

// ---- Captured from tile.ts / occupations.ts / models.ts on 2026-10-16, before the catalogue existed.
// Rows are kind codes 0-15, columns levels 0-7, exactly what the old functions returned.
const OLD = {
  capacity: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 4, 8, 12, 16, 20, 24, 28],
    [0, 3, 6, 9, 12, 15, 18, 21],
    [0, 6, 12, 18, 24, 30, 36, 42],
    [0, 8, 16, 24, 32, 40, 48, 56],
    [0, 12, 12, 12, 12, 12, 12, 12],
    [0, 9, 9, 9, 9, 9, 9, 9],
    [0, 24, 24, 24, 24, 24, 24, 24],
    [0, 10, 10, 10, 10, 10, 10, 10],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  wage: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [10, 15, 20, 25, 30, 35, 40, 45],
    [9, 14, 19, 24, 29, 34, 39, 44],
    [14, 20, 26, 32, 38, 44, 50, 56],
    [20, 20, 20, 20, 20, 20, 20, 20],
    [20, 20, 20, 20, 20, 20, 20, 20],
    [26, 26, 26, 26, 26, 26, 26, 26],
    [16, 16, 16, 16, 16, 16, 16, 16],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  parkSurface: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 4, 8, 12, 16, 20, 24, 28],
    [0, 1, 1, 1, 1, 1, 1, 1],
    [0, 2, 2, 2, 2, 2, 2, 2],
    [0, 1, 1, 1, 1, 1, 1, 1],
    [0, 4, 4, 4, 4, 4, 4, 4],
    [0, 3, 3, 3, 3, 3, 3, 3],
    [0, 6, 6, 6, 6, 6, 6, 6],
    [0, 6, 6, 6, 6, 6, 6, 6],
    [12, 12, 12, 12, 12, 12, 12, 12],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  parkDeep: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 4, 8, 12, 16, 20, 24, 28],
    [0, 3, 6, 9, 12, 15, 18, 21],
    [0, 4, 8, 12, 16, 20, 24, 28],
    [0, 5, 10, 15, 20, 25, 30, 35],
    [0, 10, 10, 10, 10, 10, 10, 10],
    [0, 6, 6, 6, 6, 6, 6, 6],
    [0, 20, 20, 20, 20, 20, 20, 20],
    [0, 10, 10, 10, 10, 10, 10, 10],
    [12, 12, 12, 12, 12, 12, 12, 12],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  CIVIC_COST: {"5": 400, "6": 400, "7": 900, "8": 300, "9": 150} as Record<string, number>,
  CIVIC_UPKEEP: {"5": 20, "6": 20, "7": 50, "8": 15, "9": 2} as Record<string, number>,
  LOT_CAPACITY: 12,
  KIND_NAMES: ["", "residential", "commercial", "industrial", "office", "police station", "fire station", "hospital", "builders' yard", "parking lot"],
  KIND_COUNT: 10,
  WORK_PER_LEVEL: 60,
  CIVIC_WORK: 300,
  VENUE_CAPACITY_PER_LEVEL: 6,
  /** isGrowable, isCivic, isService, isWorkplace per kind code 0-15 */
  flags: ["0000", "1000", "1001", "1001", "1001", "0111", "0111", "0111", "0101", "0000", "0000", "0000", "0000", "0000", "0000", "0000"],
  OCCUPATIONS: {"2": {"name": "shop worker", "kind": 2, "rotate": true, "shifts": [{"start": 9, "hours": 8, "weight": 0.4}, {"start": 12, "hours": 8, "weight": 0.3}, {"start": 6, "hours": 8, "weight": 0.2}, {"start": 14, "hours": 8, "weight": 0.1}], "cycles": [[1, 1, 1, 1, 1, 0, 0], [1, 1, 0, 1, 1, 1, 0], [0, 1, 1, 1, 1, 1, 0]]}, "3": {"name": "factory worker", "kind": 3, "rotate": true, "shifts": [{"start": 6, "hours": 8, "weight": 0.5}, {"start": 14, "hours": 8, "weight": 0.3}, {"start": 22, "hours": 8, "weight": 0.2}], "cycles": [[1, 1, 1, 1, 1, 0, 0], [1, 1, 1, 1, 0, 0, 1]]}, "4": {"name": "office worker", "kind": 4, "rotate": false, "shifts": [{"start": 9, "hours": 8, "weight": 0.6}, {"start": 8, "hours": 8, "weight": 0.2}, {"start": 10, "hours": 8, "weight": 0.15}, {"start": 7, "hours": 8, "weight": 0.05}], "cycles": [[1, 1, 1, 1, 1, 0, 0]]}, "5": {"name": "police officer", "kind": 5, "rotate": true, "shifts": [{"start": 7, "hours": 8, "weight": 1}, {"start": 15, "hours": 8, "weight": 1}, {"start": 23, "hours": 8, "weight": 1}], "cycles": [[1, 1, 1, 1, 0, 0, 1], [1, 1, 1, 1, 1, 0, 0]]}, "6": {"name": "firefighter", "kind": 6, "rotate": true, "shifts": [{"start": 8, "hours": 24, "weight": 1}], "cycles": [[1, 0, 0]]}, "7": {"name": "hospital staff", "kind": 7, "rotate": true, "shifts": [{"start": 7, "hours": 12, "weight": 1}, {"start": 19, "hours": 12, "weight": 0.8}], "cycles": [[1, 1, 1, 0, 0, 0, 0], [1, 1, 0, 0, 1, 1, 0]]}, "8": {"name": "builder", "kind": 8, "rotate": true, "shifts": [{"start": 7, "hours": 8, "weight": 0.6}, {"start": 8, "hours": 8, "weight": 0.4}], "cycles": [[1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 0, 0]]}},
};
/** [key, height, vertices, fnv32 of position+normal+color+aWin bytes] for every model the old models.ts built */
const OLD_MODELS: [string, number, number, string][] = [
  ["1:1:0", 0.52, 126, 'a8865705'],
  ["1:1:1", 0.44, 198, 'b5d0dcbf'],
  ["1:1:2", 0.66, 216, '397bb916'],
  ["1:1:3", 0.5, 180, '88e6b0d7'],
  ["1:2:0", 0.66, 162, '1ca86645'],
  ["1:2:1", 0.56, 216, '89652401'],
  ["1:2:2", 0.72, 216, '88d7d4f7'],
  ["1:2:3", 0.63, 216, '976ecc19'],
  ["1:3:0", 1.36, 180, '3835560d'],
  ["1:3:1", 1.2, 360, '524f00c3'],
  ["1:3:2", 1.4, 324, 'f54e8569'],
  ["1:3:3", 1.65, 180, '5cbc7ec5'],
  ["2:1:0", 0.5, 144, 'c04c2a69'],
  ["2:1:1", 0.48, 360, 'beff72c9'],
  ["2:1:2", 0.4, 372, '81061c79'],
  ["2:1:3", 0.64, 252, '9b6068d1'],
  ["2:2:0", 0.91, 144, '3f0cee99'],
  ["2:2:1", 0.66, 216, 'f0406e8d'],
  ["2:2:2", 0.94, 198, '6cd2dddd'],
  ["2:2:3", 0.8, 312, 'b9135339'],
  ["2:3:0", 2.25, 144, 'a5fd4d'],
  ["2:3:1", 2.1, 432, '2648186d'],
  ["2:3:2", 1.9, 348, '465ac989'],
  ["2:3:3", 2.14, 144, '50b8ab41'],
  ["3:1:0", 0.54, 162, 'ede45492'],
  ["3:1:1", 0.5, 162, 'ea3fc3fd'],
  ["3:1:2", 0.36, 270, 'c7ad93d2'],
  ["3:1:3", 0.4, 372, '206f3f79'],
  ["3:2:0", 1.26, 282, 'c69ccbbe'],
  ["3:2:1", 1, 522, '2e045571'],
  ["3:2:2", 0.95, 354, 'e83a0e62'],
  ["3:2:3", 1.2, 492, '886602c1'],
  ["3:3:0", 2.1, 504, 'e9b43e37'],
  ["3:3:1", 2.1, 660, '58fd3232'],
  ["3:3:2", 1.95, 756, '8c65b10e'],
  ["3:3:3", 1.66, 552, 'c8a63c99'],
  ["4:1:0", 1.17, 108, '93f24189'],
  ["4:1:1", 0.94, 180, '126a7839'],
  ["4:1:2", 1.04, 432, 'e5dd9a09'],
  ["4:1:3", 0.83, 180, '7aa9207d'],
  ["4:2:0", 2.3, 108, 'fdb326ad'],
  ["4:2:1", 1.65, 180, '43aecc31'],
  ["4:2:2", 2.4, 180, '8bd92b4d'],
  ["4:2:3", 2.4, 168, '79d69dca'],
  ["4:3:0", 3.4, 180, 'ecff4b86'],
  ["4:3:1", 3.7, 180, 'f646926'],
  ["4:3:2", 3.05, 180, '718c4605'],
  ["4:3:3", 2.97, 288, 'cd780f8a'],
  ["5:1:0", 0.63, 204, '3a420786'],
  ["6:1:0", 1, 180, 'fbfc58b1'],
  ["7:1:0", 1.15, 324, '31afa93e'],
  ["8:1:0", 1, 432, '4f22bddb'],
  ["9:1:0", 0.3, 852, 'ad03cae2'],
  ["crane", 0.9, 228, '6ee7bae'],
  ["site", 0.2, 330, '6407885d'],
];

let failures = 0, passes = 0;
const fail = (msg: string) => { failures++; console.error('  FAIL ' + msg); };
const eq = (what: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passes++; else fail(`${what}: got ${g}, want ${w}`);
};
const section = (s: string) => console.log(s);

// ---------------------------------------------------------------- 1. tables
section('tables and wrappers');
const growable = (k: number) => k >= 1 && k <= 4;
/** The 1×1 zone kinds stop at level 3 (MAX_LEVEL was 3 when the snapshot was taken; merged lots now reach MAX_LEVEL 7). */
const LEGACY_TOP = 3;
const unreachable: string[] = [];
/** Kinds added after the snapshot (kind ids >= OLD.KIND_COUNT) are checked against their own catalogue entry instead. */
const isNew = (k: number) => k >= OLD.KIND_COUNT && MANIFEST.some((m) => m.kindId === k);
for (let k = 0; k < T.KIND_ID_COUNT; k++) {
  if (k >= 16 && !isNew(k)) continue; // an unused sub-kind id: nothing to compare
  if (isNew(k)) {
    const m = MANIFEST.find((e) => e.kindId === k)!;
    const first = m.levels[0].level, top = m.levels[m.levels.length - 1].level;
    for (let l = 0; l < 8; l++) {
      // levels below a merged kind's first level repeat the first, levels past the top repeat the top
      const lv = l === 0 ? undefined : m.levels.find((x) => x.level === Math.max(first, Math.min(l, top)));
      eq(`new kind ${m.id}: capacity(${k}, ${l})`, T.capacity(k, l), lv ? lv.capacity : 0);
      if (lv) eq(`new kind ${m.id}: wageFor(${k}, ${l})`, T.wageFor(k, l), lv.wage);
      if (lv) eq(`new kind ${m.id}: parkingCapacity(${k}, ${l})`, [T.parkingCapacity(k, l, false), T.parkingCapacity(k, l, true)], [lv.parking.surface, lv.parking.underground]);
      eq(`new kind ${m.id}: capacityOf(${k}, ${l})`, T.capacityOf(k, l), lv ? lv.capacity : 0);
      if (lv) eq(`new kind ${m.id}: wageOf/upkeepOf/workOf/parkingOf(${k}, ${l})`, [T.wageOf(k, l), T.upkeepOf(k, l), T.workOf(k, l), T.parkingOf(k, l, false), T.parkingOf(k, l, true)],
        [lv.wage, lv.upkeep, lv.work, lv.parking.surface, lv.parking.underground]);
    }
    eq(`new kind ${m.id}: flags`, [T.isGrowable(k), T.isCivic(k), T.isService(k), T.isWorkplace(k)], [m.flags.growable, m.flags.civic, m.flags.service, m.flags.workplace]);
    eq(`new kind ${m.id}: flags by id`, [T.isGrowableId(k), T.isCivicId(k), T.isServiceId(k), T.isWorkplaceId(k), T.isParkingId(k)], [m.flags.growable, m.flags.civic, m.flags.service, m.flags.workplace, m.flags.parking]);
    continue;
  }
  for (let l = 0; l < 8; l++) {
    const i = k * 8 + l;
    // The 1×1 zones never pass level 3; the old formulas extrapolated past it, the tables clamp to the top level.
    if (growable(k) && l > LEGACY_TOP) {
      if (CAPACITY_TABLE[i] !== OLD.capacity[k][l]) unreachable.push(`${k}:${l}`);
      continue;
    }
    eq(`CAPACITY_TABLE[${k}:${l}]`, CAPACITY_TABLE[i], OLD.capacity[k][l]);
    eq(`WAGE_TABLE[${k}:${l}]`, WAGE_TABLE[i], OLD.wage[k][l]);
    eq(`PARK_SURFACE_TABLE[${k}:${l}]`, PARK_SURFACE_TABLE[i], OLD.parkSurface[k][l]);
    eq(`PARK_UNDERGROUND_TABLE[${k}:${l}]`, PARK_UNDERGROUND_TABLE[i], OLD.parkDeep[k][l]);
    eq(`capacity(${k}, ${l})`, T.capacity(k, l), OLD.capacity[k][l]);
    eq(`wageFor(${k}, ${l})`, T.wageFor(k, l), OLD.wage[k][l]);
    eq(`parkingCapacity(${k}, ${l}, false)`, T.parkingCapacity(k, l, false), OLD.parkSurface[k][l]);
    eq(`parkingCapacity(${k}, ${l}, true)`, T.parkingCapacity(k, l, true), OLD.parkDeep[k][l]);
    // the id-based variants agree for base kinds (kind id = code, sub byte 0)
    eq(`capacityOf/wageOf/parkingOf(${k}, ${l})`, [T.capacityOf(k, l), T.wageOf(k, l), T.parkingOf(k, l, false), T.parkingOf(k, l, true)], [OLD.capacity[k][l], OLD.wage[k][l], OLD.parkSurface[k][l], OLD.parkDeep[k][l]]);
  }
  eq(`flags(${k})`, [T.isGrowable(k), T.isCivic(k), T.isService(k), T.isWorkplace(k)].map(Number).join(''), OLD.flags[k]);
  eq(`flags by id (${k})`, [T.isGrowableId(k), T.isCivicId(k), T.isServiceId(k), T.isWorkplaceId(k)].map(Number).join(''), OLD.flags[k]);
}
const oldKeys = <V>(r: Record<string, V>) => Object.fromEntries(Object.entries(r).filter(([k]) => !isNew(Number(k))));
eq('CIVIC_COST', oldKeys(T.CIVIC_COST), OLD.CIVIC_COST);
eq('CIVIC_UPKEEP', oldKeys(T.CIVIC_UPKEEP), OLD.CIVIC_UPKEEP);
for (const m of MANIFEST.filter((e) => isNew(e.kindId) && (e.flags.civic || e.flags.parking))) {
  eq(`new kind ${m.id}: CIVIC_COST`, T.CIVIC_COST[m.kindId] ?? 0, m.levels[0].cost); // a kind nobody places (the communal garden) costs nothing
  eq(`new kind ${m.id}: CIVIC_UPKEEP`, T.CIVIC_UPKEEP[m.kindId], m.levels[0].upkeep);
}
eq('LOT_CAPACITY', T.LOT_CAPACITY, OLD.LOT_CAPACITY);
eq('KIND_NAMES (snapshot kinds)', T.KIND_NAMES.slice(0, OLD.KIND_COUNT), OLD.KIND_NAMES);
eq('KIND_NAMES (new kinds, by id)', T.KIND_NAMES.slice(OLD.KIND_COUNT), Array.from({ length: T.KIND_NAMES.length - OLD.KIND_COUNT }, (_, i) => MANIFEST.find((m) => m.kindId === OLD.KIND_COUNT + i)?.name ?? ''));
eq('KIND_COUNT (family codes)', T.KIND_COUNT, Math.max(OLD.KIND_COUNT, ...MANIFEST.map((m) => m.code + 1)));
eq('KIND_ID_COUNT', T.KIND_ID_COUNT, Math.max(16, ...MANIFEST.map((m) => m.kindId + 1)));
eq('WORK_PER_LEVEL', T.WORK_PER_LEVEL, OLD.WORK_PER_LEVEL);
eq('CIVIC_WORK', T.CIVIC_WORK, OLD.CIVIC_WORK);
eq('VENUE_CAPACITY_PER_LEVEL', T.VENUE_CAPACITY_PER_LEVEL, OLD.VENUE_CAPACITY_PER_LEVEL);
// The simulation still uses WORK_PER_LEVEL, CIVIC_WORK and VENUE_CAPACITY_PER_LEVEL; the catalogue must agree with them.
// Size-ladder rungs added after the snapshot (groups.ts) carry their own build work, scaled with their footprint (checked in 'groups and tiers').
for (const k of MANIFEST) for (const l of k.levels) {
  // merged zone kinds (zones.ts) carry their own work, scaled with level and footprint (checked in 'merged lots')
  // Audit #1: a residential level-1 house is a third of WORK_PER_LEVEL (20), so the first homes rise within minutes
  const firstHouse = k.kindId === T.Zone.Residential && l.level === 1;
  const want = k.flags.growable ? (isNew(k.kindId) && k.footprint ? l.work : firstHouse ? T.WORK_PER_LEVEL / 3 : T.WORK_PER_LEVEL * l.level) : k.flags.civic ? (isNew(k.kindId) && (k.group || k.landmark) ? l.work : T.CIVIC_WORK) : 0;
  eq(`work ${k.id} L${l.level}`, T.workOf(k.kindId, l.level), want);
  if (k.kindId === k.code) eq(`constructionWork ${k.id} L${l.level} (code wrapper)`, T.constructionWork(k.code, l.level), want);
  if (k.kindId === T.Zone.Commercial) eq(`visitorCapacity commercial L${l.level}`, l.attrs.visitorCapacity, l.level * T.VENUE_CAPACITY_PER_LEVEL);
}
const occ = Object.fromEntries(Object.entries(OCCUPATIONS).map(([k, o]) => [k, { name: o.name, kind: o.kind, rotate: o.rotate, shifts: o.shifts, cycles: o.cycles }]));
const oldOcc = Object.fromEntries(Object.entries(OLD.OCCUPATIONS as Record<string, { name: string; kind: number; rotate: boolean; shifts: unknown; cycles: unknown }>).map(([k, o]) => [k, { name: o.name, kind: o.kind, rotate: o.rotate, shifts: o.shifts, cycles: o.cycles }]));
eq('OCCUPATIONS', oldKeys(occ), oldOcc);
for (const m of MANIFEST.filter((e) => isNew(e.kindId) && e.occupation)) eq(`new kind ${m.id}: occupation`, OCCUPATIONS[m.kindId]?.name, m.occupation!.name);
eq('window classes match render/materials.ts Win', Object.values(WINDOW_CLASSES), [Win.None, Win.Home, Win.Shop, Win.Office, Win.Civic, Win.Factory, Win.Venue, Win.Fire, Win.Beacon, Win.Sign]);
// facade and empty-lot tints that render/chunkView.ts used to hard-code
const tintsOf = (code: number) => MANIFEST.find((k) => k.code === code)?.tints;
eq('residential tints', tintsOf(1), [0xffffff, 0xffd9b8, 0xfff0b3, 0xcfe3f7, 0xd6ebc9, 0xf7cfcf, 0xf2e6ff, 0xffe4c4]);
eq('commercial tints', tintsOf(2), [0xffffff, 0xfff3e0, 0xeef2f7, 0xf7e8e8, 0xf4f7ec]);
eq('industrial tints', tintsOf(3), [0xffffff, 0xf2ebe0, 0xe8ebee, 0xf6e9d6, 0xe9eee6]);
eq('office tints', tintsOf(4), [0xffffff, 0xeaf0f8, 0xf4f4f0, 0xe4ecf7, 0xf1eef8]);
eq('lot tints', MANIFEST.filter((k) => k.lotTint !== undefined && !isNew(k.kindId)).map((k) => [k.code, k.lotTint]), [[1, 0x8fe07a], [2, 0x7ab6ff], [3, 0xf0c060], [4, 0xc9a8ff]]);
eq('merged lots keep their family\'s lot tint', MANIFEST.filter((k) => k.lotTint !== undefined && isNew(k.kindId)).every((k) => k.lotTint === MANIFEST.find((b) => b.kindId === k.code)!.lotTint), true);
eq('tools', MANIFEST.filter((k) => k.tool && !isNew(k.kindId)).map((k) => [k.tool!.id, k.tool!.key, k.tool!.label, k.tool!.cost, k.tool!.color]), [
  ['res', '4', 'Residential', 25, 'var(--res)'], ['com', '5', 'Commercial', 25, 'var(--com)'], ['ind', '6', 'Industrial', 25, 'var(--ind)'], ['off', '7', 'Office', 25, '#9b7fe0'],
  ['police', '8', 'Police station', 400, '#3454a8'], ['fire', '9', 'Fire station', 400, '#d6453a'], ['hospital', '0', 'Hospital', 900, '#f4f4f4'],
  ['yard', 'Y', "Builders' yard", 300, '#a8713f'], ['park', 'P', 'Parking lot', 150, '#5c6270'],
]);
if (unreachable.length) console.log(`  note: 1×1 zone levels above ${LEGACY_TOP} clamp to level ${LEGACY_TOP} (unreachable, not compared): ${unreachable.join(' ')}`);
eq('MAX_LEVEL (merged lots climb to the 3-bit level field)', MAX_LEVEL, 7);
for (let k = 1; k <= 4; k++) eq(`1×1 zone ${k} tops out at level ${LEGACY_TOP}`, TOP_LEVEL_TABLE[k], LEGACY_TOP);

// ---------------------------------------------------------------- 2. models
section('models');
buildModels();
const now = allVariants();
const isNewKey = (key: string) => /^\d+:/.test(key) && isNew(Number(key.split(':')[0]));
// designs added through designs/index.ts EXTRA_DESIGNS (the AI design batches) append after a level's own designs; once
// promoted out of draft they are live variants too, but the snapshot is about the original catalogue
const extraKey = (() => {
  const first = new Map<string, number>();
  for (const k of CATALOGUE) k.levels.forEach((l, li) => {
    const lvl = (k.minLevel ?? 1) + li;
    // variant keys number a level's live designs only, so count live ones
    const extras = EXTRA_DESIGNS.filter((e) => e.kind === k.id && e.level === lvl && !e.design.draft).length;
    if (extras) first.set(`${k.kindId ?? k.code}:${lvl}`, l.designs.filter((d) => !d.draft).length - extras);
  });
  return (key: string) => { const m = /^(\d+:\d+):(\d+)$/.exec(key); return !!m && first.has(m[1]) && Number(m[2]) >= first.get(m[1])!; };
})();
eq('model keys in build order', now.map((v) => v.key).filter((k) => !isNewKey(k) && !extraKey(k)), OLD_MODELS.map((m) => m[0]));
const newModels = now.filter((v) => isNewKey(v.key));
console.log(`  ${newModels.length} model(s) of kinds added since the snapshot: ${newModels.map((v) => v.key).join(' ')}`);
function fnv(h: number, a: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
/**
 * Snapshot models deliberately changed since: their walls got facades and their doors the door helper, so no door
 * covers a window (section 11). [vertices, fnv32] of the new geometry; the silhouette and height are unchanged.
 */
const FACADE_FIXED: Record<string, [number, string]> = {
  '1:1:0': [198, '15badaf1'], '1:1:1': [354, '1e05223f'], '1:2:0': [426, 'b8b45c0d'], '1:2:1': [528, 'e9fe6c01'], '1:3:1': [696, 'f0ee0933'],
};
/**
 * Snapshot models deliberately changed since: their plain roof discs became real helipads (tierkit helipad: disc, ring
 * and H), which shared/src/helipads.ts finds and helicopters land on. The office slab's pad keeps its place; the
 * hospital's moves right and its roof cross left so the bigger pad fits. Heights are unchanged.
 */
const HELIPAD_FIXED: Record<string, [number, string]> = { '4:3:3': [756, '4280ad8e'] }; // the hospital ('7:1:0') has since been redesigned, below
/**
 * Snapshot models deliberately changed since: they carry an ad slot's empty frame (docs/adverts.md section 2, buildings/
 * adslot.ts). The supermarket gets a default billboard on its flat roof; the site fence's front rail became a plywood
 * hoarding with a poster frame. Heights are unchanged.
 */
const ADSLOT_FIXED: Record<string, [number, string]> = { '2:2:1': [432, '8fe1b839'], site: [402, 'a6732c31'] };
/**
 * Snapshot models redrawn since (docs/buildings.md "Redesigns"): the thinnest original designs rebuilt in their own
 * slot with facades, an entrance, a roofscape and a forecourt, so every tile that showed the old model shows the new
 * one. [height, vertices, fnv32]: unlike the fixes above, the height may change.
 */
const REDESIGNED: Record<string, [number, number, string]> = {
  '4:1:0': [1.2, 996, '568d6d75'], '4:1:1': [1.07, 852, 'e9c0ac3e'], '4:1:2': [1.37, 1128, '784d9fa6'], '4:1:3': [0.95, 1008, '4a11b86a'],
  '4:2:0': [2.67, 1524, '52376f65'], '4:2:1': [2.14, 1380, '859ef48c'], '4:2:2': [2.49, 1806, 'c935d902'], '4:2:3': [2.37, 1344, 'fc976a3c'],
  '4:3:0': [3.45, 2016, '6c243966'], '4:3:1': [3.73, 2250, 'c8b7f3b2'], '4:3:2': [3.46, 2388, 'fc30be18'],
  // the civic base kinds (one design each): the hospital keeps a helipad on its ward roof (shared/src/helipads.ts finds it)
  '5:1:0': [1.14, 1356, '5ab34dd9'], '6:1:0': [1.35, 936, '64280e61'], '7:1:0': [1.22, 1848, 'f6840ba1'], '8:1:0': [1.02, 798, '8098eece'], 'crane': [0.9, 36, '48cbeaa9'], // the crane helper is mast-only now: the jib turns in render/ambient.ts
  // the thinnest zone originals
  '1:3:0': [1.4, 1524, '9ebf63ed'], '1:3:3': [1.72, 1368, 'cd67bbfd'], '2:1:0': [0.69, 468, '7c8a78c9'], '2:2:0': [0.95, 948, '5a2f7ba5'],
  '2:3:0': [2.22, 1152, '1b0bc115'], '2:3:3': [2.34, 1176, '19ceb6c7'], '3:1:0': [0.7, 822, '6ba205be'],
  // residential originals whose doors and bays sat over windows, redrawn with facades
  '1:1:2': [0.72, 432, 'fc5be5ea'], '1:1:3': [0.56, 576, 'd36315b7'], '1:2:2': [0.76, 660, 'fad5642c'], '1:2:3': [0.63, 852, '335efc8b'], '1:3:2': [1.39, 1608, '98a9dc95'],
  // commercial originals whose awnings, glazing and doors sat over windows, redrawn with facades
  '2:1:1': [0.67, 720, 'b6a8e7f6'], '2:1:2': [0.53, 876, 'b02a9dda'], '2:1:3': [0.64, 696, '48dc35b4'], '2:2:2': [1.1, 762, '1aed2dd1'], '2:2:3': [0.85, 1140, '931e779d'],
};
let identical = 0, refixed = 0;
for (const [key, oldHeight, oldVerts, oldHash] of OLD_MODELS) {
  const re = REDESIGNED[key];
  const fixed = re ? ([re[1], re[2]] as [number, string]) : FACADE_FIXED[key] ?? HELIPAD_FIXED[key] ?? ADSLOT_FIXED[key];
  const height = re ? re[0] : oldHeight;
  const [verts, hash] = fixed ?? [oldVerts, oldHash];
  if (fixed) refixed++;
  const v = now.find((m) => m.key === key);
  if (!v) { fail(`model ${key} missing`); continue; }
  let h = 2166136261;
  for (const n of ['position', 'normal', 'color', 'aWin']) h = fnv(h, (v.geometry.attributes[n].array as Float32Array));
  eq(`model ${key} height`, v.height, height);
  eq(`model ${key} vertices`, v.geometry.attributes.position.count, verts);
  eq(`model ${key} geometry bytes`, h.toString(16), hash);
  if (v.geometry.attributes.position.count === verts && h.toString(16) === hash && !fixed) identical++;
}
const drafts = allDesigns().filter((d) => d.draft);
console.log(`  ${identical}/${OLD_MODELS.length} models byte-identical to the old models.ts, ${refixed} deliberately re-snapshotted after facade fixes (${Object.keys(FACADE_FIXED).join(' ')}), helipads (${Object.keys(HELIPAD_FIXED).join(' ')}), ad slot frames (${Object.keys(ADSLOT_FIXED).join(' ')}) and redesigns (${Object.keys(REDESIGNED).join(' ')}); ${drafts.length} draft design(s) built for the viewer only: ${drafts.map((d) => d.key).join(', ')}`);
if (!drafts.length) fail('expected the kiosk draft');
if (now.some((v) => drafts.some((d) => d.key === v.key))) fail('a draft leaked into the city batch');
// draft landmarks (landmark-drafts.ts, docs/landmarks.md): viewer only, so no tool, no live design, and the reserved ids
for (const m of MANIFEST.filter((k) => k.landmark && k.draft)) {
  if (m.tool) fail(`${m.id}: a draft landmark has a tool`);
  if (m.levels.some((l) => l.designs.some((d) => !d.draft))) fail(`${m.id}: a draft landmark has a live design`);
  if (m.kindId < LANDMARK_DRAFT_IDS[0] || m.kindId > LANDMARK_DRAFT_IDS[1]) fail(`${m.id}: draft landmark kind id ${m.kindId} is outside ${LANDMARK_DRAFT_IDS.join('-')}`);
}
for (const m of MANIFEST.filter((k) => !(k.landmark && k.draft) && k.kindId >= LANDMARK_DRAFT_IDS[0] && k.kindId <= LANDMARK_DRAFT_IDS[1])) fail(`${m.id}: kind id ${m.kindId} is in the draft landmark range`);

// ---------------------------------------------------------------- 3. generated files fresh
section('generated files');
const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/buildings');
const fresh = emitCatalogue(compileCatalogue(CATALOGUE, HELPER_MODELS));
eq('compiled.ts up to date', readFileSync(join(dir, 'compiled.ts'), 'utf8') === fresh.compiled, true);
eq('recipes.ts up to date', readFileSync(join(dir, 'recipes.ts'), 'utf8') === fresh.recipes, true);

// ---------------------------------------------------------------- 4. validation catches mistakes
section('validation');
const clone = () => JSON.parse(JSON.stringify(CATALOGUE)) as KindDef[];
const expectError = (what: string, mutate: (c: KindDef[]) => void, pattern: RegExp) => {
  const c = clone(); mutate(c);
  const errs = validateCatalogue(c, HELPER_MODELS);
  if (errs.some((e) => pattern.test(e))) passes++; else fail(`${what}: expected an error matching ${pattern}, got ${JSON.stringify(errs.slice(0, 3))}`);
};
eq('real catalogue is valid', validateCatalogue(CATALOGUE, HELPER_MODELS), []);
expectError('duplicate id', (c) => { c[1].id = c[0].id; }, /duplicate id/);
expectError('duplicate kind code', (c) => { c[1].code = c[0].code; }, /already used/);
expectError('kind code 16', (c) => { c[0].code = 16; }, /outside 1-15/);
expectError('kind code 0', (c) => { c[0].code = 0; }, /outside 1-15/);
expectError('eight levels', (c) => { while (c[0].levels.length < 8) c[0].levels.push(c[0].levels[0]); }, /at most 7/);
expectError('missing capacity', (c) => { delete c[4].levels[0].capacity; }, /missing capacity/);
expectError('missing wage on a workplace', (c) => { delete c[4].levels[0].wage; }, /missing wage/);
expectError('missing occupation', (c) => { delete c[4].occupation; }, /needs an occupation/);
expectError('missing parking', (c) => { delete c[4].levels[0].parking; }, /missing parking/);
expectError('unknown op', (c) => { (c[0].levels[0].designs[0].ops as unknown[]).push(['sphere', 1, 2, 3]); }, /unknown op 'sphere'/);
expectError('unknown palette name', (c) => { (c[0].levels[0].designs[0].ops[0] as unknown[])[7] = 'mauve'; }, /'?"mauve"'? is not a palette name/);
expectError('unknown window class', (c) => { (c[0].levels[0].designs[0].ops[0] as unknown[])[8] = 'disco'; }, /window class/);
expectError('wrong arity', (c) => { (c[0].levels[0].designs[0].ops[0] as unknown[]).splice(2, 3); }, /takes 6 numbers/);
expectError('missing industrial attribute', (c) => { delete c[2].levels[0].attrs!.pollution; }, /'pollution' missing/);
expectError('unknown tech feature', (c) => { c[0].levels[1].feature = 'level9'; }, /not unlocked by any tech/);
expectError('duplicate tool key', (c) => { c[1].tool!.key = c[0].tool!.key; }, /tool key/);

// ---------------------------------------------------------------- 5. leisure family
section('leisure');
eq('leisure kind codes', LEISURE_CODES, [...new Set(MANIFEST.filter((m) => m.family === 'leisure').map((m) => m.code))]);
for (const m of MANIFEST.filter((e) => e.family === 'leisure' && !(e.landmark && e.draft))) { // a draft landmark has no live design, so no spec (landmark-drafts.ts)
  eq(`${m.id}: isLeisure`, isLeisure(m.kindId), true);
  for (const l of m.levels) {
    const live = l.designs.filter((d) => !d.draft);
    // a landmark (docs/buildings.md "Landmarks") is one real building: one design
    if (live.length < (m.landmark ? 1 : 2)) fail(`${m.id} L${l.level}: needs at least ${m.landmark ? 'one live design' : 'two live designs'}, has ${live.length}`); else passes++;
    const specs = leisureSpecs(m.kindId, l.level);
    eq(`${m.id} L${l.level}: one spec per live design`, specs.length, live.length);
    specs.forEach((sp, i) => {
      const a = live[i].attrs;
      eq(`${m.id} L${l.level} d${i}: spec mirrors attributes`, [sp.type, sp.capacity, sp.value, sp.radius, sp.open, sp.close, sp.ticket, sp.eventNights],
        [a.venueType, a.visitorCapacity, a.leisureValue, a.radius, (a.openHours as number[])[0], (a.openHours as number[])[1], a.ticket, a.eventNights ?? []]);
      eq(`${m.id} L${l.level} d${i}: staffed iff a workplace`, sp.staffed, m.flags.workplace);
    });
    // every tile resolves to one of the level's designs, and the hash spreads them
    const seen = new Set<number>();
    for (let x = 0; x < 40; x++) { const sp = leisureAt(m.kindId, l.level, x, 7); if (!sp) fail(`${m.id} L${l.level}: no spec at (${x}, 7)`); else seen.add(sp.design); }
    eq(`${m.id} L${l.level}: tiles use every design`, seen.size, live.length);
  }
  if (m.levels[0].cost <= 0 && m.tool) fail(`${m.id}: placed kinds need a cost`); else passes++; // the communal garden has no tool: the sim plants it (sim/blocks.ts)
}
eq('non-leisure kinds have no leisure spec', MANIFEST.filter((m) => m.family !== 'leisure').some((m) => leisureAt(m.kindId, 1, 0, 0)), false);
eq('venue windows only on leisure kinds', MANIFEST.filter((m) => m.windows === 'venue').every((m) => m.family === 'leisure'), true);
const leisureIdx = CATALOGUE.findIndex((k) => k.family === 'leisure' && k.flags.workplace);
const parkIdx = CATALOGUE.findIndex((k) => k.family === 'leisure' && !k.flags.workplace);
expectError('unknown venue type', (c) => { c[leisureIdx].attrs!.venueType = 'casino'; }, /venueType 'casino' unknown/);
expectError('event night past Sunday', (c) => { c[leisureIdx].attrs!.eventNights = [4, 7]; }, /eventNights must be distinct weekdays/);
expectError('event nights without a start', (c) => { c[leisureIdx].attrs!.eventNights = [4]; delete c[leisureIdx].attrs!.eventStart; }, /eventStart/);
expectError('closing before opening', (c) => { c[leisureIdx].attrs!.openHours = [20, 12]; }, /open before it closes/);
expectError('missing leisure attribute', (c) => { delete c[leisureIdx].attrs!.ticket; }, /'ticket' missing/);
expectError('a staffed park', (c) => { c[parkIdx].flags.workplace = true; c[parkIdx].occupation = c[leisureIdx].occupation; c[parkIdx].wage = 10; }, /a park has no staff/);

// ---------------------------------------------------------------- 6. footprints (multi-tile structures)
section('footprints');
{
  const multi = MANIFEST.filter((m) => m.footprint);
  for (let k = 0; k < T.KIND_ID_COUNT; k++) {
    const m = MANIFEST.find((e) => e.kindId === k);
    const want = m?.footprint ? { w: m.footprint.w, h: m.footprint.h, door: m.footprint.door } : { w: 1, h: 1, door: [0, 0] };
    eq(`footprintOf(${k})`, S.footprintOf(k), want);
    eq(`isMultiTile(${k})`, S.isMultiTile(k), !!m?.footprint);
  }
  eq('snapshot kinds stay 1×1', MANIFEST.filter((m) => !isNew(m.kindId) && m.footprint).map((m) => m.id), []);
  if (!multi.length) fail('expected the airport terminal as the worked multi-tile example');
  // aux encoding round trip
  for (let r = 0; r < 4; r++) { const a = S.anchorAux(r); eq(`anchor aux r${r}`, [S.isAnchorAux(a), S.isPartAux(a), S.auxOrientation(a)], [true, false, r]); }
  for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
    if (!dx && !dy) continue;
    const a = S.partAux(dx, dy);
    if (!S.isPartAux(a) || S.isAnchorAux(a) || S.partDx(a) !== dx || S.partDy(a) !== dy) fail(`part aux ${dx},${dy} does not round-trip (0x${a.toString(16)})`); else passes++;
  }
  for (const m of multi) {
    const fp = m.footprint!;
    for (let r = 0; r < 4; r++) {
      // a structure written to a scratch map is found again from every one of its tiles, with the door touching the road ahead
      const p = S.placedFromDoor(m.kindId, 10, 10, r);
      const aux = new Map<string, number>(), tiles = new Map<string, number>(), subs = new Map<string, number>();
      // every tile carries the family code in its word and the kind's sub byte (0 for a base kind), as World.placeStructure writes them
      S.eachTile(p, (x, y, a) => { aux.set(`${x},${y}`, a); tiles.set(`${x},${y}`, T.packTile(0, false, m.code, 1)); subs.set(`${x},${y}`, T.subFor(m.kindId)); });
      eq(`${m.id} r${r}: tiles`, aux.size, fp.w * fp.h);
      eq(`${m.id} r${r}: rotated size`, [p.w, p.h], r % 2 ? [fp.h, fp.w] : [fp.w, fp.h]);
      eq(`${m.id} r${r}: door`, [p.doorX, p.doorY], [10, 10]);
      eq(`${m.id} r${r}: front`, [p.frontX - p.doorX, p.frontY - p.doorY], S.FRONT[r]);
      const doorEdge = r === 0 ? p.doorY === p.ay + p.h - 1 : r === 1 ? p.doorX === p.ax + p.w - 1 : r === 2 ? p.doorY === p.ay : p.doorX === p.ax;
      eq(`${m.id} r${r}: door on the front edge`, doorEdge, true);
      let found = 0;
      for (const key of aux.keys()) {
        const [x, y] = key.split(',').map(Number);
        const q = S.structureAt(x, y, (ax, ay) => aux.get(`${ax},${ay}`) ?? 0, (ax, ay) => tiles.get(`${ax},${ay}`), (ax, ay) => subs.get(`${ax},${ay}`) ?? 0);
        if (q && q.doorX === 10 && q.doorY === 10 && q.r === r && q.kind === m.kindId) found++;
      }
      eq(`${m.id} r${r}: every tile maps to the door`, found, fp.w * fp.h);
    }
    // rotation: a forced orientation lays the footprint out validly on clear land, door on the front edge, road ahead
    for (let r = 0; r < 4; r++) {
      const grid = new Map<string, number>();
      const road = T.packTile(0, true, 0, 0);
      const env = (): S.PlaceEnv => ({ tile: (x, y) => grid.get(`${x},${y}`) ?? T.packTile(0, false, 0, 0), aux: () => 0, sub: () => 0, land: () => null });
      const [fx, fy] = S.FRONT[r];
      grid.set(`${10 + fx},${10 + fy}`, road);
      paintWater(grid, m.kindId, 10, 10, r);
      const v = S.planStructure(m.kindId, 10, 10, env(), r);
      if (!v.ok) { fail(`${m.id} r${r}: forced rotation refused on clear land: ${v.reason}`); continue; }
      const p = v.placed;
      eq(`${m.id} r${r}: forced orientation`, p.r, r);
      eq(`${m.id} r${r}: forced layout is the footprint turned ${r} quarter turns`, [p.w, p.h, p.doorX, p.doorY], [r % 2 ? fp.h : fp.w, r % 2 ? fp.w : fp.h, 10, 10]);
      eq(`${m.id} r${r}: door's outward neighbour is the road`, [p.frontX, p.frontY], [10 + fx, 10 + fy]);
      // the same orientation through the auto path when that road is the only one
      const auto = S.planStructure(m.kindId, 10, 10, env());
      eq(`${m.id} r${r}: auto facing agrees when only that side has a road`, auto.ok && auto.placed.r, r);
      // no road on the chosen side: refused with the door reason, placed still reported for the preview
      for (let q = 0; q < 4; q++) {
        if (q === r) continue;
        const bad = S.planStructure(m.kindId, 10, 10, env(), q);
        eq(`${m.id}: rot ${q} with the road on side ${r} is refused`, bad.ok ? 'ok' : bad.reason, 'The door must face a road');
        eq(`${m.id}: refused rot ${q} still reports its footprint`, !bad.ok && bad.placed?.r, q);
      }
      // a forced layout blocked by a building is refused for its tiles, not its facing
      const far = p.r === 0 ? [p.ax, p.ay] : [p.ax + p.w - 1, p.ay + p.h - 1];
      const farWas = grid.get(`${far[0]},${far[1]}`); // a harbour's wet tile is water (paintWater)
      grid.set(`${far[0]},${far[1]}`, T.packTile(0, false, T.Zone.Police, 1));
      eq(`${m.id} r${r}: a building under any tile refuses the forced layout`, S.planStructure(m.kindId, 10, 10, env(), r).ok, false);
      // invalid rot values fall back to automatic facing
      if (farWas === undefined) grid.delete(`${far[0]},${far[1]}`); else grid.set(`${far[0]},${far[1]}`, farWas);
      for (const bogus of [-1, 4, 1.5, Number.NaN]) eq(`${m.id}: rot ${bogus} is ignored`, S.planStructure(m.kindId, 10, 10, env(), bogus).ok, auto.ok);
      // marks turn with the footprint: all inside the placed rectangle, the door mark on the door tile facing the road
      const marks = S.placedMarks(p);
      for (const mk of marks) {
        const inside = mk.x >= p.ax - S.MARK_LINE / 2 - 1e-6 && mk.y >= p.ay - S.MARK_LINE / 2 - 1e-6 && mk.x + mk.w <= p.ax + p.w + S.MARK_LINE / 2 + 1e-6 && mk.y + mk.h <= p.ay + p.h + S.MARK_LINE / 2 + 1e-6;
        eq(`${m.id} r${r}: ${mk.kind} mark '${mk.label ?? ''}' inside the footprint`, inside, true);
      }
      const door = marks.find((mk) => mk.kind === 'door');
      eq(`${m.id} r${r}: door mark sits on the door tile, facing the road`, door && [door.x, door.y, door.w, door.h, door.facing], [10, 10, 1, 1, r]);
      eq(`${m.id} r${r}: one placed mark per declared mark`, marks.length, S.marksOf(m.kindId).length);
    }
    // declared marks: known kinds, inside the footprint (also enforced by validation below)
    eq(`${m.id}: marks pass validation`, V.footprintMarkErrors({ w: fp.w, h: fp.h, marks: fp.marks ?? [] }, m.id), []);
    // a 'back' edge mark lies opposite the door in every rotation
    for (let r = 0; r < 4; r++) {
      const p = S.placedFromDoor(m.kindId, 10, 10, r);
      const back = S.placedMarks(p).find((mk) => mk.edge && mk.facing === ((2 + r) & 3));
      if (back) {
        const [fx, fy] = S.FRONT[r];
        const side = (back.x + back.w / 2 - (10 + 0.5)) * -fx + (back.y + back.h / 2 - (10 + 0.5)) * -fy;
        eq(`${m.id} r${r}: back-edge mark lies behind the door (${back.kind})`, side > 0, true);
      }
    }
    // recipes are authored in tiles for the whole footprint: boxes, roofs and cylinders stay inside it
    for (const rec of RECIPES.filter((x) => x.kind === m.kindId)) {
      let out = 0;
      for (const op of rec.ops) {
        if (op[0] === 'taper' || op[0] === 'lathe') { const e = shapeExtent(op); if (e[0] < -fp.w / 2 - 1e-6 || e[1] > fp.w / 2 + 1e-6 || e[4] < -fp.h / 2 - 1e-6 || e[5] > fp.h / 2 + 1e-6) out++; continue; }
        const [hw, hd, x, z] = op[0] === 'box' || op[0] === 'roof' ? [op[1] / 2, op[3] / 2, op[4], op[6]]
          : op[0] === 'cyl' ? [Math.max(op[1], op[2]), Math.max(op[1], op[2]), op[4], op[6]] : op[0] === 'cone' ? [op[1], op[1], op[3], op[5]] : [0, 0, 0, 0];
        if (Math.abs(x) + hw > fp.w / 2 + 1e-6 || Math.abs(z) + hd > fp.h / 2 + 1e-6) out++;
      }
      eq(`${m.id} ${rec.key}: model inside its ${fp.w}×${fp.h} footprint`, out, 0);
    }
  }
  // placement: a clear footprint beside a road is accepted, facing that road; roads, buildings and water inside refuse it
  const first = multi[0];
  if (first) {
    const fp = first.footprint!;
    const grid = new Map<string, number>();
    const env = (land: (x: number, y: number) => string | null = () => null): S.PlaceEnv => ({
      tile: (x, y) => grid.get(`${x},${y}`) ?? T.packTile(0, false, 0, 0), aux: () => 0, sub: () => 0, land,
    });
    grid.set('0,1', T.packTile(0, true, 0, 0));
    const ok = S.planStructure(first.kindId, 0, 0, env());
    eq('plan: door with a road at +y faces +y', ok.ok && ok.placed.r, 0);
    grid.clear(); grid.set('1,0', T.packTile(0, true, 0, 0));
    const east = S.planStructure(first.kindId, 0, 0, env());
    eq('plan: door with a road at +x faces +x', east.ok && [east.placed.r, east.placed.ax, east.placed.ay], [1, -(fp.h - 1), -(fp.w - 1 - fp.door[0])]);
    grid.clear();
    eq('plan: no road at the door', S.planStructure(first.kindId, 0, 0, env()).ok, false);
    grid.set('0,1', T.packTile(0, true, 0, 0)); grid.set('1,-1', T.packTile(0, true, 0, 0));
    const blocked = S.planStructure(first.kindId, 0, 0, env());
    eq('plan: a road inside the footprint refuses it', blocked.ok ? 'ok' : blocked.reason, `${/^[aeiou]/.test(first.name) ? 'An' : 'A'} ${first.name} needs ${fp.w}×${fp.h} tiles clear of roads`);
    grid.delete('1,-1'); grid.set('1,0', T.packTile(0, false, T.Zone.Police, 1));
    eq('plan: a building inside the footprint refuses it', S.planStructure(first.kindId, 0, 0, env()).ok, false);
    grid.set('1,0', T.packTile(0, false, T.Zone.Residential, 0));
    eq('plan: an empty zoned lot may be built over', S.planStructure(first.kindId, 0, 0, env()).ok, true);
    grid.set('1,0', T.packTile(1, false, 0, 0));
    eq('plan: water inside refuses it', S.planStructure(first.kindId, 0, 0, env()).ok, false);
    grid.delete('1,0');
    eq('plan: foreign land refuses it', S.planStructure(first.kindId, 0, 0, env((x) => (x === 1 ? 'Not your land' : null))).ok, false);
  }
  expectError('footprint too big', (c) => { c.find((k) => k.footprint)!.footprint!.w = 9; }, /footprint w and h must be integers 1-8/);
  expectError('door off the front row', (c) => { c.find((k) => k.footprint)!.footprint!.door = [0, 0]; }, /footprint door must be/);
  expectError('multi-tile growable', (c) => { c[0].footprint = { w: 2, h: 2, door: [0, 1] }; }, /only civic kinds/);
  expectError('mark of an unknown kind', (c) => { c.find((k) => k.footprint)!.footprint!.marks = [{ kind: 'helipad' as never, at: [0, 0] }]; }, /unknown kind 'helipad'/);
  expectError('mark tile outside the footprint', (c) => { const f = c.find((k) => k.footprint)!.footprint!; f.marks = [{ kind: 'stand', at: [f.w, 0] }]; }, /outside the \d+×\d+ footprint/);
  expectError('mark edge range outside the footprint', (c) => { c.find((k) => k.footprint)!.footprint!.marks = [{ kind: 'platform', at: { edge: 'back', from: 0, to: 9 } }]; }, /are outside the \d+ tiles of the back edge/);
  expectError('mark on an unknown edge', (c) => { c.find((k) => k.footprint)!.footprint!.marks = [{ kind: 'gate', at: { edge: 'top' as never } }]; }, /unknown edge 'top'/);
  expectError('mark deeper than the footprint', (c) => { const f = c.find((k) => k.footprint)!.footprint!; f.marks = [{ kind: 'apron', at: { edge: 'back', depth: f.h + 1 } }]; }, /depth \d+ is outside/);
  expectError('rotation key Z is reserved', (c) => { c[1].tool!.key = 'z'; }, /reserved/);
  expectError('rotation key C is reserved', (c) => { c[1].tool!.key = 'C'; }, /reserved/);
  expectError('a draft landmark with a tool', (c) => { c.find((k) => k.id === 'town-clock-tower')!.tool = { id: 'clocktower', key: '', label: 'Clock tower', color: '#c8a060' }; }, /draft landmark has no tool/);
  expectError('a draft landmark outside the reserved ids', (c) => { c.find((k) => k.id === 'town-clock-tower')!.kindId = 120; }, /reserved range 230-249/);
  expectError('a draft landmark without the draft tag', (c) => { c.find((k) => k.id === 'town-clock-tower')!.tags = ['victorian']; }, /tag 'draft'/);
  expectError('a live landmark still needs its collection rung', (c) => { const k = c.find((x) => x.id === 'town-clock-tower')!; k.draft = false; k.levels[0].designs[0].draft = false; }, /collection group/);
}

// ---------------------------------------------------------------- 6b. harbours: wet footprints (docs/boats.md section 5)
section('harbours');
{
  const IDS: Record<string, number> = { jetty: 24, marina: 25, 'fishing-harbour': 26, 'ferry-pier': 27, 'cargo-port': 28 };
  const ROLE: Record<string, string> = { jetty: 'jetty', marina: 'marina', 'fishing-harbour': 'fishing', 'ferry-pier': 'pier', 'cargo-port': 'port' };
  const NODE: Record<string, string> = { jetty: 'tr10', marina: 'tr10', 'fishing-harbour': 'tr10', 'ferry-pier': 'tr11', 'cargo-port': 'tr12' };
  eq('wet kinds are the five harbours', MANIFEST.filter((m) => S.wetOf(m.kindId)).map((m) => m.id).sort(), Object.keys(IDS).sort());
  const water = T.packTile(T.Terrain.Water, false, 0, 0), grass = T.packTile(0, false, 0, 0), road = T.packTile(0, true, 0, 0);
  const deck = T.packTile(T.Terrain.Water, true, 0, 0), DECK_AUX = 0xd8;
  eq('a bridge deck is open water to boats, a pontoon is not', [S.isOpenWaterTile(water, 0), S.isOpenWaterTile(deck, DECK_AUX), S.isOpenWaterTile(water, S.partAux(1, 0)), S.isOpenWaterTile(grass, 0), S.isOpenWaterTile(undefined, 0)], [true, true, false, false, false]);
  for (const [id, kind] of Object.entries(IDS)) {
    const m = MANIFEST.find((k) => k.id === id)!;
    eq(`${id}: kind id`, [(KIND_ID as Record<string, number>)[id], m.code], [kind, T.Zone.Hub]);
    eq(`${id}: harbour role`, H.HARBOUR_OF[kind]?.role, ROLE[id]);
    eq(`${id}: unlocked by ${NODE[id]}`, techFor(m.tool!.id)?.id, NODE[id]);
    const spec = S.wetOf(kind)!, fp = S.footprintOf(kind), depth = S.fairwayDepth(spec.fairwayClearance);
    eq(`${id}: wet rows behind a dry door row`, spec.wet >= 1 && spec.wet <= fp.h - 1, true);
    for (let r = 0; r < 4; r++) {
      const grid = new Map<string, number>(), aux = new Map<string, number>();
      const env = (land: (x: number, y: number) => string | null = () => null): S.PlaceEnv => ({
        tile: (x, y) => grid.get(`${x},${y}`) ?? grass, aux: (x, y) => aux.get(`${x},${y}`) ?? 0, sub: () => 0, land,
      });
      grid.set(`${10 + S.FRONT[r][0]},${10 + S.FRONT[r][1]}`, road);
      paintWater(grid, kind, 10, 10, r);
      const v = S.planStructure(kind, 10, 10, env(), r);
      if (!v.ok) { fail(`${id} r${r}: refused on its water: ${v.reason}`); continue; }
      const p = v.placed;
      const at = (lx: number, ly: number) => S.footprintTile(p, lx, ly).join(',');
      const refused = (what: string, key: string, word: number, pattern: RegExp, a = 0) => {
        const was = grid.get(key);
        grid.set(key, word); if (a) aux.set(key, a);
        const q = S.planStructure(kind, 10, 10, env(), r);
        if (!q.ok && pattern.test(q.reason)) passes++; else fail(`${id} r${r}: ${what}: expected ${pattern}, got ${q.ok ? 'ok' : q.reason}`);
        if (was === undefined) grid.delete(key); else grid.set(key, was);
        aux.delete(key);
      };
      refused('a dry back row', at(fp.w - 1, 0), grass, /must stand on open water/);
      refused('a road on the wet row', at(0, spec.wet - 1), deck, /must stand on open water/, DECK_AUX);
      refused('another structure on the wet row', at(0, 0), water, /must stand on open water/, S.partAux(1, 1));
      refused('a wet quay', at(fp.w - 1, spec.wet), water, /must stand on dry land/);
      refused(`a fairway narrower than ${S.FAIRWAY_WORDS[spec.fairwayClearance]}`, at(0, -depth), grass, /water behind it/);
      refused('a pontoon in the fairway', at(fp.w - 1, -1), water, /water behind it/, S.partAux(0, 0));
      // a bridge deck in the fairway is open water, and the water beyond the band is not asked for
      grid.set(at(0, -1), deck); aux.set(at(0, -1), DECK_AUX);
      eq(`${id} r${r}: a bridge deck in the fairway is fine`, S.planStructure(kind, 10, 10, env(), r).ok, true);
      grid.set(at(0, -1), water); aux.delete(at(0, -1));
      eq(`${id} r${r}: wet rows need the player's land too`, S.planStructure(kind, 10, 10, env((x, y) => (`${x},${y}` === at(0, 0) ? 'Not your land' : null)), r).ok, false);
      eq(`${id} r${r}: the fairway is public water`, S.planStructure(kind, 10, 10, env((x, y) => (`${x},${y}` === at(0, -1) ? 'Not your land' : null)), r).ok, true);
      // automatic facing finds the side with the water behind, wherever else there are roads
      for (const [dx, dy] of S.FRONT) {
        const x = 10 + dx, y = 10 + dy, k = `${x},${y}`;
        if (!grid.has(k) && (x < p.ax || y < p.ay || x >= p.ax + p.w || y >= p.ay + p.h)) grid.set(k, road);
      }
      const auto = S.planStructure(kind, 10, 10, env());
      eq(`${id} r${r}: automatic facing turns its back to the water`, auto.ok && auto.placed.r, r);
      // geometry helpers: tile <-> local round trips, wet tiles, the quay with water behind, the fairway behind the back row
      let trips = 0, wet = 0;
      for (let ly = -2; ly < fp.h; ly++) for (let lx = 0; lx < fp.w; lx++) {
        const [x, y] = S.footprintTile(p, lx, ly), [bx, by] = S.footprintLocal(p, x, y);
        if (bx === lx && by === ly) trips++;
        if (S.isWetTile(p, x, y)) wet++;
      }
      eq(`${id} r${r}: footprintLocal inverts footprintTile`, trips, (fp.h + 2) * fp.w);
      eq(`${id} r${r}: wet tiles are the back rows`, wet, spec.wet * fp.w);
      const quay = S.quayTiles(p);
      eq(`${id} r${r}: the quay is dry with water behind every tile`, quay.every(([x, y], lx) => !S.isWetTile(p, x, y) && T.isBuildable(grid.get(`${x},${y}`) ?? grass)
        && grid.get(at(lx, spec.wet - 1)) === water), true);
      const fw = S.fairwayTiles(p);
      eq(`${id} r${r}: the fairway touches the back row from outside`, fw.every(([x, y], lx) => {
        const [bx, by] = S.footprintTile(p, lx, 0);
        return Math.abs(x - bx) + Math.abs(y - by) === 1 && (x < p.ax || y < p.ay || x >= p.ax + p.w || y >= p.ay + p.h);
      }), true);
      // berths: over the wet rows (the ferry pier's in the row behind it), each boat length inside the footprint's width
      const berths = H.placedBerths(p);
      eq(`${id} r${r}: berths`, berths.length, H.HARBOUR_OF[kind]!.berths.length);
      const bad = berths.filter((b, i) => {
        const slot = H.HARBOUR_OF[kind]!.berths[i];
        const [lx, ly] = S.footprintLocal(p, Math.floor(b.x), Math.floor(b.y));
        const along = slot.dir & 1 ? slot.x : slot.y, room = slot.dir & 1 ? fp.w : spec.wet;
        const water = id === 'ferry-pier' ? ly === -1 : ly >= 0 && ly < spec.wet;
        return !water || lx < 0 || lx >= fp.w || along - slot.len / 2 < -1e-6 || along + slot.len / 2 > room + 1e-6 || b.dir !== ((slot.dir + r) & 3);
      });
      eq(`${id} r${r}: every berth on the water and inside the footprint's width`, bad.map((b) => b.label), []);
      eq(`${id} r${r}: every berth's fairway tile is in the fairway`, berths.every((b) => fw.some(([x, y]) => x === b.fairway[0] && y === b.fairway[1])), true);
    }
    // the world map reads a wet structure tile as water
    eq(`${id}: map byte of a wet tile`, mapByte(T.packTile(T.Terrain.Water, false, T.Zone.Hub, 1), S.partAux(0, 0)) & 15, MapClass.Water);
  }
  expectError('wet rows on the door row', (c) => { c.find((k) => k.id === 'jetty')!.footprint!.wet = 2; }, /footprint wet must be an integer 1-1/);
  expectError('a fairway class without wet rows', (c) => { const f = c.find((k) => k.id === 'rail-halt')!.footprint!; f.fairwayClearance = 2; }, /fairwayClearance must be 1-3/);
  expectError('a fairway class out of range', (c) => { c.find((k) => k.id === 'marina')!.footprint!.fairwayClearance = 4; }, /fairwayClearance must be 1-3/);
}

// ---------------------------------------------------------------- 7. airfields (runway aux bytes, shared/src/airport.ts)
section('airfields');
{
  // the airfield range sits in the aux layer's free top range and never reads as a structure byte
  const codes: number[] = [];
  for (let o = 0; o < 4; o++) for (let k = 0; k < A.AIRFIELD_ROWS; k++) {
    const a = A.airfieldAux(o, k);
    codes.push(a);
    eq(`airfield aux o${o} row${k}`, [A.isAirfieldAux(a), S.isStructureAux(a), A.airfieldOrientation(a), A.airfieldRow(a)], [true, false, o, k]);
  }
  eq('airfield codes are distinct and within 0xc0-0xd7', [new Set(codes).size, Math.min(...codes), Math.max(...codes)], [24, 0xc0, 0xd7]);
  let clash = 0;
  for (let a = 0; a < 256; a++) if (A.isAirfieldAux(a) && (a < 0xc0 || a > 0xd7 || S.isStructureAux(a))) clash++;
  eq('no other byte reads as airfield', clash, 0);
  eq('the airport terminal is kind 15, 8×7', [T.Zone.Airport, S.footprintOf(T.Zone.Airport).w, S.footprintOf(T.Zone.Airport).h], [15, 8, 7]);

  // a terminal and its runway on a scratch map, in all four orientations
  for (let r = 0; r < 4; r++) {
    const tiles = new Map<string, number>(), aux = new Map<string, number>();
    const env: A.RunwayEnv = { tile: (x, y) => tiles.get(`${x},${y}`) ?? T.packTile(0, false, 0, 0), aux: (x, y) => aux.get(`${x},${y}`) ?? 0, sub: () => 0, land: () => null };
    const p = S.placedFromDoor(T.Zone.Airport, 0, 0, r);
    S.eachTile(p, (x, y, a) => { aux.set(`${x},${y}`, a); tiles.set(`${x},${y}`, T.packTile(0, false, T.Zone.Airport, 1)); });
    const { back, t0 } = A.terminalSpan(p);
    const bs = r & 1 ? S.FRONT[r][0] : S.FRONT[r][1];
    const centre = back - A.TERMINAL_ROW * bs;
    const line = (off: number, len: number, start = t0 - 2): [number, number][] => Array.from({ length: len }, (_, i) => (r & 1 ? [centre + off, start + i] : [start + i, centre + off]));
    eq(`runway r${r}: too short`, A.planRunway(line(0, 9), env).ok, false);
    eq(`runway r${r}: not straight`, A.planRunway([...line(0, 6), ...line(1, 6, t0 + 4)], env).ok, false);
    eq(`runway r${r}: too far from the terminal`, A.planRunway(line(-4 * bs, 12), env).ok, false);
    eq(`runway r${r}: shorter than the terminal is wide`, A.planRunway(line(0, 10, t0 + 2), env).ok, false);
    const plan = A.planRunway(line(2 * bs, 12), env); // dragged two rows off: snaps onto the runway row
    eq(`runway r${r}: snaps and plans`, [plan.ok, plan.centre, plan.tiles?.length, plan.cost], [true, centre, 12 * A.AIRFIELD_ROWS * 3, 12 * A.AIRFIELD_ROWS * A.RUNWAY_COST]);
    const road = [...line(0, 12)][5];
    tiles.set(`${road[0]},${road[1]}`, T.packTile(0, true, 0, 0));
    eq(`runway r${r}: a road across refuses it`, A.planRunway(line(0, 12), env).ok, false);
    tiles.delete(`${road[0]},${road[1]}`);
    eq(`runway r${r}: foreign land refuses it`, A.planRunway(line(0, 12), { ...env, land: () => 'Not your land' }).ok, false);
    for (let i = 0; i < plan.tiles!.length; i += 3) aux.set(`${plan.tiles![i]},${plan.tiles![i + 1]}`, plan.tiles![i + 2]);
    const link = A.airportFor(p, env);
    const ap = link.airport;
    eq(`airport r${r}: operational`, [link.status, ap?.runwayLen, ap?.gates, ap?.dir], ['operational', 12, A.TERMINAL_GATES, [0, 3, 1, 2][r]]);
    if (ap) {
      // the stands the schedule parks planes on are on the terminal's apron rows, 2.1 tiles inside its back edge
      const tc = r & 1 ? p.ay + p.h / 2 : p.ax + p.w / 2;
      for (let g = 0; g < 2; g++) {
        const [wx, wz] = F.toWorld(ap, F.gateU(ap, g), F.STAND_OFFSET);
        const along = r & 1 ? wz : wx, across = r & 1 ? wx : wz;
        eq(`airport r${r}: gate ${g} on the apron`, [Math.round(Math.abs(along - tc) * 100) / 100, Math.round((across - (back + 0.5 - 0.5 * bs)) * bs * 100) / 100], [1.65, 2.1]);
      }
      eq(`airport r${r}: runway tiles find their terminal`, A.airfieldTerminal(...line(0, 12)[11], env)?.doorX, 0);
    }
    eq(`airport r${r}: repainting is free`, A.planRunway(line(0, 12), env).cost, 0);
    const lift = (a: number, k: number) => { const i = 3 * (a * A.AIRFIELD_ROWS + k); aux.delete(`${plan.tiles![i]},${plan.tiles![i + 1]}`); };
    lift(0, A.RUNWAY_CENTRE_ROW); // the end of the centre line: the runway is one tile shorter and still long enough
    eq(`airport r${r}: a lifted end tile shortens it`, A.airportFor(p, env).airport?.runwayLen, 11);
    lift(6, 4); // a taxiway tile in the middle
    eq(`airport r${r}: a missing strip tile stops it`, A.airportFor(p, env).airport, null);
  }
}

// ---------------------------------------------------------------- 8. sub-kinds (docs/sub-kinds.md)
section('sub-kinds');
{
  // every tile written before sub-kinds (sub byte 0) means exactly what it meant: the family's base kind, id = code
  for (let code = 0; code < 16; code++) eq(`kindIdOf(${code}, 0) is the base kind`, T.kindIdOf(code, 0), code);
  // each kind round-trips through what a placement writes: family code in the tile word, subFor(id) in the sub layer
  for (const m of MANIFEST) {
    const sub = T.subFor(m.kindId), word = T.packTile(0, false, m.code, 1);
    eq(`${m.id}: family code`, T.familyOf(m.kindId), m.code);
    eq(`${m.id}: sub byte`, sub, m.kindId === m.code ? 0 : m.kindId);
    eq(`${m.id}: tile word + sub byte -> kind id`, T.kindIdOf(T.zoneOf(word), sub), m.kindId);
    eq(`${m.id}: KIND_ID`, KIND_ID[m.id as keyof typeof KIND_ID], m.kindId);
    eq(`${m.id}: name by id`, T.KIND_NAMES[m.kindId], m.name);
    eq(`${m.id}: kindManifest`, T.kindManifest(m.kindId)?.id, m.id);
  }
  const subs = MANIFEST.filter((m) => m.kindId !== m.code);
  if (!subs.length) fail('expected at least one sub-kind (the bus depot draft)'); else passes++;
  for (const m of subs) {
    // a sub byte that names a kind of another family is ignored: the tile reads as its own family's base kind
    for (let code = 1; code < 16; code++) if (code !== m.code) eq(`${m.id}: sub ${m.kindId} on family ${code} reads as the base kind`, T.kindIdOf(code, m.kindId), code);
    // the sub-kind's numbers come from its own row, not its family's base row
    // (growable sub-kinds, the merged lots, have no placement cost: CIVIC_COST lists placed kinds only)
    eq(`${m.id}: own row, not its base kind's`, [T.capacityOf(m.kindId, 1), T.wageOf(m.kindId, 1), T.upkeepOf(m.kindId, 1), T.CIVIC_COST[m.kindId] ?? 0], [m.levels[0].capacity, m.levels[0].wage, m.levels[0].upkeep, m.levels[0].cost]);
    eq(`${m.id}: differs from its base kind`, JSON.stringify([T.capacityOf(m.code, 1), T.wageOf(m.code, 1), T.upkeepOf(m.code, 1), T.CIVIC_COST[m.code], T.parkingOf(m.code, 1, false)]) !== JSON.stringify([m.levels[0].capacity, m.levels[0].wage, m.levels[0].upkeep, m.levels[0].cost, m.levels[0].parking.surface]), true);
    eq(`${m.id}: code wrapper passes the id through`, T.capacity(m.kindId, 1), m.levels[0].capacity);
  }
  eq('an out-of-range sub byte reads as the base kind', T.kindIdOf(T.Zone.Commercial, 255), T.Zone.Commercial);
  // a sub-kind structure is found from every tile with its own id, and reads as something else once its sub bytes are gone
  const depot = subs.find((m) => m.footprint);
  if (depot) {
    const fp = depot.footprint!;
    const p = S.placedFromDoor(depot.kindId, 0, 0, 0);
    const aux = new Map<string, number>(), tiles = new Map<string, number>(), sub = new Map<string, number>();
    S.eachTile(p, (x, y, a) => { aux.set(`${x},${y}`, a); tiles.set(`${x},${y}`, T.packTile(0, false, depot.code, 1)); sub.set(`${x},${y}`, T.subFor(depot.kindId)); });
    const read = (x: number, y: number, withSub: boolean) => S.structureAt(x, y, (ax, ay) => aux.get(`${ax},${ay}`) ?? 0, (ax, ay) => tiles.get(`${ax},${ay}`), (ax, ay) => (withSub ? sub.get(`${ax},${ay}`) ?? 0 : 0));
    let ok = 0;
    for (const key of aux.keys()) { const [x, y] = key.split(',').map(Number); const q = read(x, y, true); if (q && q.kind === depot.kindId && q.w * q.h === fp.w * fp.h) ok++; }
    eq(`${depot.id}: every tile resolves to kind ${depot.kindId}`, ok, fp.w * fp.h);
    eq(`${depot.id}: is not an airport`, read(p.doorX, p.doorY, true)?.kind === T.Zone.Airport, false);
    eq(`${depot.id}: without its sub bytes it is no longer a ${depot.name}`, read(p.doorX, p.doorY, false)?.kind === depot.kindId, false);
    eq(`${depot.id}: footprint by id`, [S.footprintOf(depot.kindId).w, S.footprintOf(depot.kindId).h], [fp.w, fp.h]);
    eq(`${depot.id}: its family's base keeps its own footprint`, [S.footprintOf(depot.code).w, S.footprintOf(depot.code).h], [8, 7]);
  }
  // validation of ids
  const subIdx = CATALOGUE.findIndex((k) => k.kindId !== undefined && k.kindId !== k.code);
  expectError('a sub-kind id below 16', (c) => { c[subIdx].kindId = 3; }, /kindId 3 outside 16-255/);
  expectError('a sub-kind id past the sub byte', (c) => { c[subIdx].kindId = 256; }, /kindId 256 outside 16-255/);
  expectError('two sub-kinds with one id', (c) => { const d = JSON.parse(JSON.stringify(c[subIdx])); d.id = 'depot-two'; d.tool.id = 'depot2'; d.tool.key = 'Q'; c.push(d); }, /kindId 16 already used/);
  expectError('two base kinds on one code', (c) => { delete c[subIdx].kindId; }, /kind code 15 already used/);
  expectError('a sub-kind whose family has no base', (c) => { c[subIdx].code = 15; c.splice(c.findIndex((k) => k.code === 15 && k.kindId === undefined), 1); }, /has no base kind/);
}

// ---------------------------------------------------------------- 9. size ladders
section('groups and tiers');
{
  // the original kinds are one rung each, unchanged: their tier attributes are the pre-tier defaults
  const ORIGINAL: Record<string, [string, number]> = {
    police: ['police', 3], fire: ['fire', 2], hospital: ['health', 4], yard: ['builders', 2], parking: ['parking', 2],
    park: ['park', 1], cinema: ['cinema', 2], theatre: ['theatre', 2], sports: ['sports', 1], library: ['library', 1],
  };
  for (const [id, [group, tier]] of Object.entries(ORIGINAL)) {
    const m = MANIFEST.find((k) => k.id === id)!;
    eq(`${id}: rung ${tier} of the ${group} ladder`, [m.group, m.tier], [group, tier]);
    eq(`${id}: pre-tier behaviour (radius, strength, patrols, pace)`, [TI.SERVICE_RADIUS_OF[m.kindId], TI.SERVICE_STRENGTH_OF[m.kindId], TI.PATROL_RATE_OF[m.kindId], TI.WORK_RATE_OF[m.kindId]], [SERVICE_RADIUS, 1, 1, 1]);
    eq(`${id}: no tier attributes of its own`, ['serviceRadius', 'serviceStrength', 'patrolRate', 'workRate', 'eventSize'].filter((a) => m.levels.some((l) => l.attrs[a] !== undefined)), []);
  }
  for (let id = 0; id < 16; id++) eq(`base kind ${id}: default tier numbers`, [TI.SERVICE_RADIUS_OF[id], TI.SERVICE_STRENGTH_OF[id], TI.PATROL_RATE_OF[id], TI.WORK_RATE_OF[id]], [SERVICE_RADIUS, 1, 1, 1]);
  const used = GROUPS.filter((g) => !g.reserved).map((g) => g.id);
  eq('every non-reserved group has a ladder', TI.LADDERS.map((l) => l.group.id), used);
  eq('reserved groups have no rungs yet', GROUPS.filter((g) => g.reserved && TI.LADDERS.some((l) => l.group.id === g.id)).map((g) => g.id), []);
  for (const l of TI.LADDERS) {
    const g = l.group.id, ts = l.tiers;
    eq(`${g}: tiers 1..${ts.length}`, ts.map((k) => k.tier), ts.map((_, i) => i + 1));
    const collection = !!l.group.collection; // landmarks: separate buildings of any family, not sizes of one
    const stages = !!l.group.stages; // education: tiers are the stages a pupil moves through, so holds and cost need not climb
    if (!collection) eq(`${g}: one family code`, new Set(ts.map((k) => k.code)).size, 1);
    eq(`${g}: ladderOf round trip`, ts.every((k) => TI.ladderOf(k.kindId) === l), true);
    eq(`${g}: every rung has a tool, a blurb and how to place it`, ts.filter((k) => !k.tool || !k.blurb || !k.howTo).map((k) => k.id), []);
    eq(`${g}: one shortcut key at most`, ts.filter((k) => k.tool?.key).length <= 1, true);
    eq(`${g}: at least two sizes`, ts.length >= 2, true);
    // the numbers scale up the ladder (each rung at least matches the one below it)
    const up = (what: string, f: (k: typeof ts[number]) => number) => {
      if (collection) return;
      const v = ts.map(f);
      eq(`${g}: ${what} never shrinks up the ladder (${v.join(' ')})`, v.every((x, i) => i === 0 || x >= v[i - 1]), true);
    };
    const s = ts.map((k) => TI.tierSummary(k));
    if (!stages) { up('what it holds', (k) => TI.tierSummary(k).holds); up('cost', (k) => k.levels[0].cost); }
    if (ts[0].flags.service) { up('coverage radius', (k) => TI.SERVICE_RADIUS_OF[k.kindId]); up('coverage strength', (k) => TI.SERVICE_STRENGTH_OF[k.kindId]); up('patrols or call-outs', (k) => TI.PATROL_RATE_OF[k.kindId]); }
    if (g === 'builders') up('builder pace', (k) => TI.WORK_RATE_OF[k.kindId]);
    if (ts[0].family === 'leisure') { up('leisure reach', (k) => s[ts.indexOf(k)].radius ?? 0); up('event pull', (k) => s[ts.indexOf(k)].eventSize ?? 1); }
    // build work grows with the footprint among the new rungs (the original kinds keep CIVIC_WORK)
    const fresh = ts.filter((k) => isNew(k.kindId)).sort((a, b) => (a.footprint?.w ?? 1) * (a.footprint?.h ?? 1) - (b.footprint?.w ?? 1) * (b.footprint?.h ?? 1));
    const works = fresh.map((k) => k.levels[0].work);
    eq(`${g}: build work grows with the footprint (${works.join(' ')})`, (collection || works.every((x, i) => i === 0 || x >= works[i - 1])) && works.every((x) => x > 0), true);
    // every rung places: a multi-tile rung in all four rotations on clear land beside a road, a single tile through the civic or lot tool
    for (const k of ts) {
      const tool = k.tool!.id;
      if (S.isMultiTile(k.kindId)) {
        const ok = [0, 1, 2, 3].filter((r) => {
          const grid = new Map<string, number>();
          grid.set(`${10 + S.FRONT[r][0]},${10 + S.FRONT[r][1]}`, T.packTile(0, true, 0, 0));
          paintWater(grid, k.kindId, 10, 10, r);
          return S.planStructure(k.kindId, 10, 10, { tile: (x, y) => grid.get(`${x},${y}`) ?? T.packTile(0, false, 0, 0), aux: () => 0, sub: () => 0, land: () => null }, r).ok;
        });
        eq(`${k.id}: places in every rotation`, ok, [0, 1, 2, 3]);
        eq(`${k.id}: placed by the civic structure tool`, (CIVIC_TOOLS as Record<string, number>)[tool], k.kindId);
      } else eq(`${k.id}: a single-tile tool the server knows`, (CIVIC_TOOLS as Record<string, number>)[tool] === k.kindId || (tool === 'park' && k.kindId === T.Zone.Parking), true);
      // a tech feature per rung, or available from the start
      const t = techFor(tool);
      if (isNew(k.kindId) && !t && !['handyman', 'park'].includes(k.id)) fail(`${k.id}: no tech node unlocks '${tool}' (only the handyman and the park are from the start)`); else passes++;
    }
    eq(`${g}: footprints (${s.map((x) => x.footprint).join(' ')})`, s.length, ts.length);
  }
  // validation catches ladder mistakes
  const tiered = CATALOGUE.findIndex((k) => k.group === 'health' && k.tier === 1);
  expectError('an unknown group', (c) => { c[tiered].group = 'spaceport'; }, /group 'spaceport' unknown/);
  expectError('a gap in the tiers', (c) => { c[tiered].tier = 9; }, /tiers must run 1\.\.\d+ with no gaps/);
  expectError('a rung of another family', (c) => { c[tiered].code = 5; c[tiered].kindId = 250; }, /every rung must share one family code/);
  expectError('a rung without a blurb', (c) => { delete c[tiered].blurb; }, /needs a blurb/);
  expectError('two keys in one ladder', (c) => { c[tiered].tool!.key = 'Q'; }, /only one rung may carry a shortcut key/);
  expectError('a tier attribute out of range', (c) => { c[tiered].attrs = { ...(c[tiered].attrs ?? {}), serviceStrength: 5 }; }, /serviceStrength' must be a number/);
}

// ---------------------------------------------------------------- 10. merged lots (zones.ts)
section('merged lots');
{
  const merged = MANIFEST.filter((m) => m.flags.growable && m.footprint);
  const FAMILIES: [number, string][] = [[T.Zone.Residential, 'residential'], [T.Zone.Commercial, 'commercial'], [T.Zone.Industrial, 'industrial'], [T.Zone.Office, 'office']];
  for (const [code, fam] of FAMILIES) {
    const forms = Z.GROW_FORMS[code];
    eq(`${fam}: at least three merged forms`, forms.length >= 3, true);
    eq(`${fam}: forms reach level 7`, Math.max(...forms.map((f) => f.topLevel)), 7);
    eq(`${fam}: forms start at level 2`, Math.min(...forms.map((f) => f.minLevel)), 2);
    // every level 2-7 is reachable by some form (the 1×1 lot covers 1-3)
    for (let l = 2; l <= 7; l++) eq(`${fam}: some form stands at level ${l}`, forms.some((f) => f.minLevel <= l && f.topLevel >= l) || l <= LEGACY_TOP, true);
  }
  for (const m of merged) {
    const id = m.kindId, fp = m.footprint!, area = fp.w * fp.h;
    const first = m.levels[0].level, top = m.levels[m.levels.length - 1].level;
    eq(`${m.id}: a sub-kind of a zone family (id 70-89)`, [id >= 70 && id <= 89, m.code >= 1 && m.code <= 4, KIND_FAMILY_TABLE[id], T.subFor(id)], [true, true, m.code, id]);
    eq(`${m.id}: grown, not placed (no tool, no group)`, [m.tool, m.group], [undefined, undefined]);
    eq(`${m.id}: levels run ${first}..${top} without gaps`, m.levels.map((l) => l.level), Array.from({ length: top - first + 1 }, (_, i) => first + i));
    eq(`${m.id}: first level 2 or more`, first >= 2, true);
    eq(`${m.id}: TOP_LEVEL_TABLE and zones.ts agree`, [TOP_LEVEL_TABLE[id], Z.topLevelOf(id), Z.firstLevelOf(id), Z.isMergedKind(id)], [top, top, first, true]);
    eq(`${m.id}: no designs below its first level`, Array.from({ length: first }, (_, l) => DESIGN_COUNT_TABLE[id * 8 + l]), new Array(first).fill(0));
    eq(`${m.id}: slots below the first level repeat it`, Array.from({ length: first - 1 }, (_, i) => T.capacityOf(id, i + 1)), new Array(first - 1).fill(m.levels[0].capacity));
    for (const l of m.levels) {
      const live = l.designs.filter((d) => !d.draft);
      eq(`${m.id} L${l.level}: at least two live designs`, live.length >= 2, true);
      eq(`${m.id} L${l.level}: gated by ${levelFeature(l.level)}`, l.feature, levelFeature(l.level));
      const node = techFor(l.feature!);
      eq(`${m.id} L${l.level}: tech node`, node?.id, l.level === 2 ? 'con1' : l.level === 3 ? 'con2' : 'con5');
      eq(`${m.id} L${l.level}: build work = 60 × level × tiles × 0.6`, l.work, Math.round(60 * l.level * area * 0.6));
      // capacity per tile never falls below anything of the family at a lower level, so a merge never has to evict
      const perTile = l.capacity / area;
      const below = MANIFEST.filter((k) => k.code === m.code && k.flags.growable && !k.draft)
        .flatMap((k) => k.levels.filter((x) => x.level < l.level).map((x) => x.capacity / ((k.footprint?.w ?? 1) * (k.footprint?.h ?? 1))));
      eq(`${m.id} L${l.level}: ${perTile.toFixed(1)} per tile ≥ every lower level of the family (${Math.max(...below).toFixed(1)})`, perTile >= Math.max(...below) - 1e-9, true);
      eq(`${m.id} L${l.level}: tables`, [T.capacityOf(id, l.level), T.wageOf(id, l.level), T.workOf(id, l.level), T.parkingOf(id, l.level, true)], [l.capacity, l.wage, l.work, l.parking.underground]);
      if (m.code === T.Zone.Commercial) eq(`${m.id} L${l.level}: venueCapacityOf reads visitorCapacity`, Z.venueCapacityOf(id, l.level), l.attrs.visitorCapacity);
      if (m.code === T.Zone.Industrial) eq(`${m.id} L${l.level}: pollution set`, typeof l.attrs.pollution, 'number');
      if (m.flags.workplace) eq(`${m.id}: occupation`, OCCUPATIONS[id]?.name, m.occupation!.name);
    }
    // capacity climbs with the level within the kind
    eq(`${m.id}: capacity grows level by level`, m.levels.every((l, i) => i === 0 || l.capacity > m.levels[i - 1].capacity), true);
    // every merged kind places in all four rotations over empty lots of its family (the footprint section checks marks and model bounds)
    const lot = T.packTile(0, false, m.code, 0);
    const rots = [0, 1, 2, 3].filter((r) => {
      const grid = new Map<string, number>();
      grid.set(`${10 + S.FRONT[r][0]},${10 + S.FRONT[r][1]}`, T.packTile(0, true, 0, 0));
      return S.planStructure(id, 10, 10, { tile: (x, y) => grid.get(`${x},${y}`) ?? lot, aux: () => 0, sub: () => 0, land: () => null }, r).ok;
    });
    eq(`${m.id}: places over empty lots in every rotation`, rots, [0, 1, 2, 3]);
  }
  // the 1×1 zones behave as before
  for (let l = 0; l <= 3; l++) eq(`commercial L${l}: venueCapacityOf is level × ${T.VENUE_CAPACITY_PER_LEVEL}`, Z.venueCapacityOf(T.Zone.Commercial, l), l * T.VENUE_CAPACITY_PER_LEVEL);
  eq('1×1 zones are not merged kinds', [1, 2, 3, 4].map((k) => Z.isMergedKind(k)), [false, false, false, false]);
  eq('level features', [1, 2, 3, 4, 5, 6, 7].map(levelFeature), ['', 'level2', 'level3', 'level4', 'level5', 'level6', 'level7']);
  const hr = TECH.find((t) => t.id === 'con5');
  eq('High-rise opens levels 4-7 after Deep foundations', [hr?.name, hr?.track, hr?.unlocks, hr?.requires], ['High-rise', 'construction', ['level4', 'level5', 'level6', 'level7'], ['con3']]);
  eq('heavy plant pollutes most', Z.pollutionOf(KIND_ID['ind-plant'], 7) >= 8, true);
  // validation: base kinds stay 1×1, merged kinds take no tool, levels fit the 3-bit field
  const mergedIdx = CATALOGUE.findIndex((k) => k.id === 'res-terrace');
  expectError('a merged kind with a tool', (c) => { c[mergedIdx].tool = { id: 'terrace', key: '', label: 'Terrace', color: '#fff' }; }, /grown, not placed/);
  expectError('a merged kind past level 7', (c) => { c[mergedIdx].minLevel = 7; }, /at most 7/);
  expectError('minLevel on a placed kind', (c) => { c[CATALOGUE.findIndex((k) => k.id === 'police')].minLevel = 2; }, /only growable kinds may start above level 1/);
}

// ---------------------------------------------------------------- 11. windows (facade.ts)
section('windows');
{
  const full = process.argv.includes('--windows');
  // an ad slot (adslot.ts) is a feature too, but it does not make a legacy design a facade one: its own frames are checked when it compiles
  const usesFacade = (ops: Op[]) => ops.some((op) => (isFeature(op[0]) && op[0] !== 'adslot') || ((op[0] === 'box' || op[0] === 'roof') && !!op[9]?.facade));
  const listed: string[] = [], seen = new Set<string>();
  let facades = 0;
  for (const k of CATALOGUE) k.levels.forEach((l, li) => l.designs.forEach((d) => {
    const level = (k.minLevel ?? 1) + li, id = `${k.kindId ?? k.code}:${level} ${d.name}`;
    const src: number[] = [];
    const ops = compileOps(d.ops, k.windows, src);
    const hits = windowCollisions(ops);
    const fac = usesFacade(d.ops);
    if (fac) facades++;
    const raw = /\(raw\)$/.test(d.author ?? ''); // a design kept as the "before" of a comparison
    const legacy = !fac && !d.draft && !d.author && LEGACY_WINDOW_COLLISIONS.has(id);
    if (legacy) seen.add(id);
    if (!hits.length) { passes++; return; }
    const say = (x: typeof hits[number]) => {
      const part = d.ops[src[x.part]], box = d.ops[src[x.box]];
      const what = (op: Op) => (op[0] === 'box' || op[0] === 'roof') && typeof op[9]?.name === 'string' ? `${op[0]} '${op[9].name}'` : JSON.stringify(op).slice(0, 60);
      return `op ${src[x.part]} ${what(part)} covers ${x.windows.length} window(s) on the ${x.face} wall of op ${src[x.box]} ${what(box)}: ${x.windows.slice(0, 3).join('; ')}${x.windows.length > 3 ? '; ...' : ''}`;
    };
    const head = `${id} (${d.author ?? 'original'}${d.draft ? ', draft' : ''})`;
    if (legacy || raw) {
      listed.push(`${head}: ${hits.length} collision(s)${full ? '\n      ' + hits.map(say).join('\n      ') : ', first: ' + say(hits[0])}`);
      passes++;
    } else fail(`window collision in ${head}${fac ? ', a facade design' : ''}:\n      ${hits.map(say).join('\n      ')}`);
  }));
  console.log(`  ${facades} design(s) use facades; ${listed.length} design(s) cover windows and are listed without failing (original catalogue before facades, and raw comparison drafts)${full ? ':' : '; --windows for every collision:'}`);
  for (const line of listed) console.log('    ' + line);
  const stale = [...LEGACY_WINDOW_COLLISIONS].filter((id) => !seen.has(id) || !listed.some((x) => x.startsWith(id + ' (')));
  if (stale.length) console.log(`  note: window-baseline.ts lists design(s) that no longer collide or no longer exist; delete their lines: ${stale.join(' | ')}`);

  // the rule itself, on hand-made recipes (no catalogue edits): a door box over a facade window is caught,
  // the door helper on the same cell is not, and a wing that hides whole cells is not a collision
  const wall = ['box', 0.6, 0.5, 0.4, 0, 0, 0, 'cream', 'home', { name: 'w', facade: { storeys: 2, bays: 3 } }] as Op;
  const c = (ops: Op[]) => windowCollisions(compileOps(ops, 'home'));
  const bad = c([wall, ['box', 0.09, 0.16, 0.02, 0.2, 0.08, 0.2, 'door']]);
  eq('a door box over a facade window is a collision', bad.map((x) => [x.part, x.face, x.windows.length > 0]), [[1, 'front', true]]);
  eq('the door helper in that cell is not', c([wall, ['door', 'w', 'front', 2]]), []);
  eq('balconies, bay windows, porches and cornices placed by cell are not', c([wall, ['balcony', 'w', 'front', 1, 0, 2], ['baywindow', 'w', 'back', 0, 1], ['porch', 'w', 'front', 0, 1], ['cornice', 'w', 1], ['door', 'w', 'front', 2]]), []);
  eq('a wing hiding whole cells is not', c([wall, ['box', 0.2, 0.5, 0.3, 0.2, 0, 0.35, 'brick']]), []);
  eq('a wing cutting a window in half is', c([wall, ['box', 0.15, 0.5, 0.3, 0.25, 0, 0.35, 'brick']]).length > 0, true);
  // cell geometry: windows centred in their cells, one per storey × bay, and features change the cell they sit in
  const ops = compileOps([wall, ['door', 'w', 'front', 1], ['balcony', 'w', 'front', 1, 0, 2]], 'home');
  const front = windowRects(ops[0] as Extract<CompiledOp, { 0: 'box' }>, 0);
  eq('front wall: 2 storeys × 3 bays less the door cell', front.length, 5);
  eq('windows centred in their cells', front.every((w) => Math.abs((w.s0 + w.s1) / 2 - (w.cell.s0 + w.cell.s1) / 2) < 1e-9), true);
  eq('the balcony storey has glazed doors', front.filter((w) => /balconyDoor/.test(w.label)).length, 3);
  eq('cell modes are numbered as the shader reads them', [CELL.plain, CELL.window, CELL.balconyDoor, CELL.shopfront, CELL.garage, CELL.bayPane], [1, 2, 3, 4, 5, 6]);
  // validation of facades and features
  const fi = CATALOGUE.findIndex((k) => k.levels.some((l) => l.designs.some((d) => usesFacade(d.ops))));
  const facadeDesign = (cat: KindDef[]) => { const k = cat[fi]; for (const l of k.levels) for (const d of l.designs) if (usesFacade(d.ops)) return d; throw new Error('no facade design'); };
  if (fi < 0) fail('expected at least one facade design (the Haiku trial)');
  else {
    expectError('a feature naming no part', (cat) => { facadeDesign(cat).ops.push(['door', 'nowhere', 'front', 0]); }, /no box or roof named 'nowhere'/);
    expectError('a bay out of range', (cat) => { const d = facadeDesign(cat); const b = d.ops.find((o) => o[0] === 'box' && o[9]?.facade)!; d.ops.push(['door', d.ops.indexOf(b), 'front', 40]); }, /bay 40 outside/);
    expectError('a balcony on the ground floor', (cat) => { const d = facadeDesign(cat); const b = d.ops.find((o) => o[0] === 'box' && o[9]?.facade)!; d.ops.push(['balcony', d.ops.indexOf(b), 'front', 0, 0, 0]); }, /storey 0 outside 1-/);
    expectError('an unknown face', (cat) => { const d = facadeDesign(cat); d.ops.push(['door', 0, 'top' as never, 0]); }, /face "top" is not one of/);
    expectError('a feature on a box without a facade', (cat) => { const d = facadeDesign(cat); d.ops.push(['box', 0.1, 0.1, 0.1, 0, 0, 0, 'white', true, { name: 'plainbox' }], ['door', 'plainbox', 'front', 0]); }, /has no facade/);
    expectError('a facade with no storeys', (cat) => { const b = facadeDesign(cat).ops.find((o) => o[0] === 'box' && o[9]?.facade)!; (b[9] as { facade: { storeys: number } }).facade.storeys = 0; }, /storeys must be an integer/);
    expectError('a facade without windows', (cat) => { const b = facadeDesign(cat).ops.find((o) => o[0] === 'box' && o[9]?.facade)!; (b as unknown[])[8] = 'none'; }, /a facade needs a window class/);
    expectError('two parts with one name', (cat) => { const d = facadeDesign(cat); const b = d.ops.find((o) => o[0] === 'box' && o[9]?.facade)!; d.ops.push(['box', 0.1, 0.1, 0.1, 0, 0, 0, 'white', true, { name: (b[9] as { name?: string }).name }]); }, /used twice/);
  }
}

// ---------------------------------------------------------------- 12. ad slots (buildings/adslot.ts, docs/adverts.md section 2)
{
  console.log('12. ad slots');
  const recipeKeys = new Set([...RECIPES.map((r) => r.key), 'site']);
  const kindOf = new Map(MANIFEST.map((k) => [k.kindId, k]));
  let slots = 0;
  for (const [key, a] of Object.entries(AD_SLOTS)) {
    if (!recipeKeys.has(key)) fail(`ad slots for unknown design ${key}`);
    if (a.length % AD_STRIDE) fail(`ad slots of ${key}: ${a.length} numbers, not a multiple of ${AD_STRIDE}`);
    for (let i = 0; i < a.length; i += AD_STRIDE) {
      slots++;
      if (![0, 1, 3].includes(a[i])) fail(`ad slot ${key}#${i / AD_STRIDE} faces ${a[i]}: never the back wall`);
      if (!(a[i + 1] >= 0 && a[i + 1] < AD_SIZES.length)) fail(`ad slot ${key}#${i / AD_STRIDE}: size code ${a[i + 1]}`);
      if (!(a[i + 5] > 0 && a[i + 6] > 0)) fail(`ad slot ${key}#${i / AD_STRIDE}: empty poster`);
      // the poster faces its wall, or (a screen on a curve) within 45 degrees of the wall it is filed under
      if (!(Number.isFinite(a[i + 7]) && Math.abs(Math.atan2(Math.sin(a[i + 7] - FACE_YAW[a[i]]), Math.cos(a[i + 7] - FACE_YAW[a[i]]))) <= Math.PI / 4 + 1e-6)) fail(`ad slot ${key}#${i / AD_STRIDE}: turned ${a[i + 7]}, not towards its ${a[i]} wall`);
    }
    const kind = Number(key.split(':')[0]);
    if (kindOf.get(kind)?.family === 'residential') fail(`a home carries an ad slot (${key}): no ads on homes (docs/adverts.md question 2)`);
  }
  const live = RECIPES.filter((r) => !r.draft && ['commercial', 'leisure'].includes(kindOf.get(r.kind)?.family ?? '') && !kindOf.get(r.kind)?.landmark);
  const withSlot = live.filter((r) => AD_SLOTS[r.key]).length;
  const share = withSlot / live.length;
  if (share < 0.15 || share > 0.45) fail(`about one commercial or leisure design in three should carry a slot; ${withSlot}/${live.length}`); else passes++;
  eq('every bus shelter has a panel', !!AD_SLOTS[`${KIND_ID['bus-stop']}:1:0`], true);
  eq('the building-site fence has a hoarding', AD_SLOTS.site?.[1], AD_SIZES.indexOf('hoarding'));
  console.log(`  ${slots} slot(s) on ${Object.keys(AD_SLOTS).length} design(s); ${withSlot}/${live.length} commercial and leisure designs carry one`);
  // big screens (docs/adverts.md section 9): every design with screens has AD.screenTurns of them, and only landmarks and the big screens corner carry them
  const screenCode = AD_SIZES.indexOf('screen');
  for (const [key, a] of Object.entries(AD_SLOTS)) {
    let n = 0;
    for (let i = 0; i < a.length; i += AD_STRIDE) if (a[i + 1] === screenCode) n++;
    if (!n) continue;
    const k = kindOf.get(Number(key.split(':')[0]));
    if (n !== AD.screenTurns) fail(`${key} has ${n} big screens; a building's screens share AD.screenTurns (${AD.screenTurns}) turns`); else passes++;
    if (!k || !(k.landmark || k.id === 'big-screens')) fail(`${key} carries big screens: only landmarks and the big screens corner do`);
  }
  eq('Piccadilly Circus has its six screens', (AD_SLOTS[`${KIND_ID['piccadilly-circus']}:1:0`] ?? []).filter((_, i, a) => i % AD_STRIDE === 1 && a[i] === screenCode).length, AD.screenTurns);
  // validation: the back wall, an unknown size, and a frame over a window
  const busStopAt = (cat: KindDef[]) => cat.find((k) => k.id === 'bus-stop')!.levels[0].designs[0].ops;
  expectError('screens facing the back', (cat) => { busStopAt(cat).push(['screens', 0, 0.1, 0, 0.3, 90, 180, 3, 1, 0.2]); }, /must face a road side/);
  expectError('screens off the bezel\'s facets', (cat) => { busStopAt(cat).push(['screens', 0, 0.1, 0, 0.3, -80, 0, 3, 1, 0.2]); }, /must divide 360|must be a multiple/);
  expectError('an ad slot on the back wall', (cat) => { busStopAt(cat).push(['adslot', 4, 'back', 0, 0, 'panel']); }, /must face a road side/);
  expectError('an unknown ad size', (cat) => { busStopAt(cat).push(['adslot', 4, 'right', 0, 0, 'mural' as never]); }, /is not one of panel/);
  const usesFacade = (ops: Op[]) => ops.some((op) => (op[0] === 'box') && !!op[9]?.facade);
  const fac = structuredClone(CATALOGUE); // not clone(): JSON turns an op's undefined window class into null
  const k = fac.find((x) => x.levels.some((l) => l.designs.some((d) => usesFacade(d.ops) && x.family === 'commercial')))!;
  const d = k.levels.flatMap((l) => l.designs).find((x) => usesFacade(x.ops))!;
  const host = d.ops.findIndex((o) => o[0] === 'box' && o[9]?.facade);
  d.ops.push(['adslot', host, 'front', 0, 1, 'poster']); // over a first-floor window
  let thrown = '';
  try { compileAll(fac, HELPER_MODELS); } catch (e) { thrown = String(e); }
  if (/ad slot frame .* covers windows/.test(thrown)) passes++; else fail(`a slot over a window should not compile; got ${thrown.slice(0, 200) || 'no error'}`);
}

console.log(failures ? `\nbuildings:check FAILED: ${failures} failure(s), ${passes} passed` : `\nbuildings:check passed: ${passes} assertions`);
process.exit(failures ? 1 : 0);
