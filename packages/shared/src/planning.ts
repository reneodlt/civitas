import { CAPACITY_TABLE } from './buildings/compiled';
import { LEVEL_SLOTS } from './buildings/codes';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { ValueKind, VALUE_KINDS, VALUE_KIND_COUNT, VALUE_CELL, valueKernels } from './value';
import { REFUSE_GRADES, REFUSE_ADDONS, BOUNDARY_LIMITS, refuseCapacity, refuseEmission } from './refuse';

/**
 * Planning notices and the residents' vote (docs/multiplayer-land.md section 6, M5). Browser-safe and shared: the server
 * decides with it (sim/planning.ts, net.ts), the client's ghost says "goes to planning" before a click (main.ts) and the
 * planning panel shows the same impact per kind.
 *
 * A build "needs planning" when it is a nuisance source (PLANNING_SOURCES: the refuse grades for now) whose expected
 * impact at full use reaches someone else's land above PLANNING.threshold × the boundary limit of some kind, while
 * staying within the limits (over a limit it is still refused outright, M4). Impact on the builder's own land and on
 * unclaimed land never needs a vote (decision 8).
 */

export const PLANNING = {
  /** how long a notice runs: one game day (decision 9) */
  noticeTicks: TICKS_PER_DAY,
  /** a nuisance kind reaching others' land over this share of its boundary limit needs planning */
  threshold: 0.4,
  /** the impact zone (who votes): cells where the plan adds at least this intensity of some nuisance kind */
  zoneMin: 0.04,
  /** after a refusal the applicant may not file again near the site for this long */
  coolTicks: 2 * TICKS_PER_DAY,
  /** ... and for this long after the refusal a filing near it needs a changed design (a lower impact score) */
  rememberTicks: 10 * TICKS_PER_DAY,
  /** "near the site": a door within this many tiles of the refused one */
  nearTiles: 8,
  /** a changed design scores at most this share of the refused one's impact (cleaner grade, add-ons, more distance) */
  changedBy: 0.9,
  // ---- the vote (section 6, "The vote") ----
  /** own impact: this × ln(value after / value before) at the voter's home, with their household's weights */
  impactGain: 4,
  /** belief about the plan (campaigns from M6; word of mouth now): weight of a belief in -1..1 */
  beliefGain: 0.5,
  /** word of mouth: a voter's belief is this share of the mean own impact of their friends on the roll */
  wordOfMouth: 0.3,
  /** the community offer: gain × sat(dollars per household on the roll / offerScale), bent by the household's Money weight */
  offerGain: 0.8, offerScale: 150,
  /** jobs: gain × min(1, the building's jobs / households on the roll); full for a household with someone out of work */
  jobsGain: 0.25, jobsEmployed: 0.4,
  /** a little hashed noise on each lean, so a vote is not a cliff */
  noise: 0.06,
  /** turnout = base + gain × |lean| (× lossAversion for opponents), capped */
  turnoutBase: 0.15, turnoutGain: 1.2, lossAversion: 1.8, turnoutMax: 0.95,
  /** recently decided applications stay in the list (and on the map) this long */
  showDecidedTicks: 6 * TICKS_PER_HOUR,
  /** the most a community offer may be */
  maxOffer: 1_000_000,
};

/**
 * Belief targets (docs/motivation.md section 4: parcel, estate, building, study) with the fifth, `plan`
 * (docs/multiplayer-land.md section 6): beliefs about a planning application. Plumbing for M6's campaigns: the server's
 * Planning keeps a belief per voter per open application (sim/planning.ts `believe`), neutral unless something sets it.
 */
export const BeliefTarget = { Parcel: 0, Estate: 1, Building: 2, Study: 3, Plan: 4 } as const;
export type BeliefTargetKind = (typeof BeliefTarget)[keyof typeof BeliefTarget];

/** A nuisance building that may need planning: what it gives off at full use with these add-ons, its jobs, the conditions it may take. */
export interface PlanningSource {
  kindId: number; name: string;
  /** value units a day per kind at full use with `addons` (the add-on bits are its conditions) */
  emission(addons: number): Float64Array;
  /** staff at level 1: the jobs it brings */
  jobs: number;
  /** the add-on bits it may take as conditions */
  conditions: number;
}
/**
 * The nuisance sources planning knows: the refuse grades (M4). Industry kinds, plants and late venues join this list as
 * they become placed buildings with full-use emissions (they grow from zoning today).
 */
export const PLANNING_SOURCES: PlanningSource[] = REFUSE_GRADES.map((g) => ({
  kindId: g.kindId, name: g.name,
  emission: (addons: number) => refuseEmission(g.kindId, addons, refuseCapacity(g.kindId, addons)),
  jobs: CAPACITY_TABLE[g.kindId * LEVEL_SLOTS + 1] ?? 0,
  conditions: REFUSE_ADDONS.reduce((m, a) => m | a.bit, 0),
}));
const SOURCE_OF: (PlanningSource | undefined)[] = [];
for (const s of PLANNING_SOURCES) SOURCE_OF[s.kindId] = s;
export const planningSourceOf = (kindId: number): PlanningSource | undefined => SOURCE_OF[kindId];

/** The add-ons as conditions: names, one-off costs (held with the build) and bits. */
export const conditionCost = (mask: number) => REFUSE_ADDONS.reduce((s, a) => s + (mask & a.bit ? a.cost : 0), 0);
export const conditionNames = (mask: number) => REFUSE_ADDONS.filter((a) => mask & a.bit).map((a) => a.label.toLowerCase());
export const conditionBits = (ids: readonly unknown[] | undefined) => {
  let m = 0;
  for (const id of ids ?? []) { const a = REFUSE_ADDONS.find((x) => x.id === id); if (a) m |= a.bit; }
  return m;
};

export interface PlanImpact {
  /** per value kind: the most the plan pushes onto any other owner's land at full use (0-1) */
  worst: number[];
  /** kinds over the boundary limit (refused outright) and kinds over the planning threshold */
  over: number[]; needs: number[];
  /** other owners reached above the zone minimum, with the worst share of a limit on their land */
  owners: Map<string, number>;
  /** cells of the impact zone (cell x, cell y on the 4×4 grid): intensities per kind (nuisances only) */
  cells: Map<string, Float32Array>;
  /** Σ over nuisance kinds of worst / limit: a refiled design must score lower (PLANNING.changedBy) */
  score: number;
}
export const cellKeyOf = (x: number, y: number) => `${Math.floor(x / VALUE_CELL)},${Math.floor(y / VALUE_CELL)}`;

/**
 * What the building of `kindId` with conditions `addons`, its door at (x, y), would push round it at full use: the M1
 * spread kernels of this world over the expected emission (as boundaryImpact, M4), keeping the cells of the impact zone
 * (any nuisance at PLANNING.zoneMin or more, whoever owns them) and the worst per kind on land owned by someone other
 * than `builder`. `ownerAt` reads a tile's owner (null: unclaimed).
 */
export function planImpact(kindId: number, addons: number, x: number, y: number, seed: number, builder: string, ownerAt: (x: number, y: number) => string | null | undefined): PlanImpact {
  const K = VALUE_KIND_COUNT, src = SOURCE_OF[kindId];
  const worst = new Array(K).fill(0), owners = new Map<string, number>(), cells = new Map<string, Float32Array>();
  if (!src) return { worst, over: [], needs: [], owners, cells, score: 0 };
  const u = src.emission(addons), ks = valueKernels(seed);
  const C = VALUE_CELL, gx = Math.floor(x / C), gy = Math.floor(y / C);
  let R = 0;
  for (let k = 0; k < K; k++) if (u[k] > 0) R = Math.max(R, ks[k].r);
  for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
    let any = false;
    const cellI = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      if (!(u[k] > 0) || !VALUE_KINDS[k].nuisance) continue;
      const ker = ks[k], r = ker.r;
      if (Math.abs(i) > r || Math.abs(j) > r) continue;
      const w = ker.w[(j + r) * (2 * r + 1) + (i + r)];
      if (!w) continue;
      const v = 1 - Math.exp(-u[k] * w);
      cellI[k] = v;
      if (v >= PLANNING.zoneMin) any = true;
    }
    if (!any) continue;
    cells.set(`${gx + i},${gy + j}`, cellI);
    const x0 = (gx + i) * C, y0 = (gy + j) * C, seen = new Set<string>();
    for (let ty = y0; ty < y0 + C; ty++) for (let tx = x0; tx < x0 + C; tx++) {
      const o = ownerAt(tx, ty);
      if (!o || o === builder || seen.has(o)) continue;
      seen.add(o);
      let share = 0;
      for (let k = 0; k < K; k++) if (cellI[k] > 0) { if (cellI[k] > worst[k]) worst[k] = cellI[k]; share = Math.max(share, cellI[k] / BOUNDARY_LIMITS[k]); }
      owners.set(o, Math.max(owners.get(o) ?? 0, share));
    }
  }
  const over: number[] = [], needs: number[] = [];
  let score = 0;
  for (let k = 0; k < K; k++) {
    if (!VALUE_KINDS[k].nuisance) continue;
    score += worst[k] / BOUNDARY_LIMITS[k];
    if (worst[k] > BOUNDARY_LIMITS[k] + 1e-9) over.push(k);
    else if (worst[k] > PLANNING.threshold * BOUNDARY_LIMITS[k] + 1e-9) needs.push(k);
  }
  return { worst, over, needs, owners, cells, score };
}

/** The intensity per nuisance kind a plan adds at tile (x, y) (zero outside its zone). */
export function planAt(imp: PlanImpact, x: number, y: number): Float32Array | undefined { return imp.cells.get(cellKeyOf(x, y)); }

/**
 * A cell's value bytes with a plan's intensities added (nuisances combine as the field does, 1 - (1 - a)(1 - b); quiet
 * falls with the new noise and heavy traffic). `b` from `off`, VALUE_KIND_COUNT of them; into `out`.
 */
export function withPlan(b: ArrayLike<number> | null, off: number, add: ArrayLike<number>, out: Float64Array = new Float64Array(VALUE_KIND_COUNT)): Float64Array {
  for (let k = 0; k < VALUE_KIND_COUNT; k++) {
    const x = b ? b[off + k] / 255 : 0, a = VALUE_KINDS[k].nuisance ? add[k] ?? 0 : 0;
    out[k] = 255 * (1 - (1 - x) * (1 - a));
  }
  const q = 255 - Math.max(out[ValueKind.Noise], out[ValueKind.Traffic]);
  out[ValueKind.Quiet] = b ? Math.min(b[off + ValueKind.Quiet], q) : q;
  return out;
}

export type PlanKind = 'build' | 'addon' | 'closure';
export type PlanStatus = 'open' | 'approved' | 'refused' | 'withdrawn' | 'lapsed';
/** A planning application as the client sees it (`planning` message). */
export interface PlanAppDTO {
  id: number; kind: PlanKind; by: string; status: PlanStatus;
  /** the site: a building's door, a closure's first tile; the building's kind and footprint corner and size for the marker */
  x: number; y: number; bk?: number; fx?: number; fy?: number; fw?: number; fh?: number;
  /** what it is, in words ("open tip", "taking the screening off the lined landfill", "closing 6 tiles of public road") */
  what: string;
  /** game ticks: filed and when the notice ends */
  filed: number; ends: number;
  /** conditions (add-on ids) and the community offer */
  conditions: string[]; offer: number;
  /** worst per nuisance kind on others' land, as [kind, intensity 0-1, limit] */
  impact: [number, number, number][];
  /** the mayors whose land it reaches (or, for a closure, who depend on the road) */
  affected: string[];
  /** voters on the frozen roll */
  voters: number;
  /** closures: who objected */
  objections?: string[];
  /** once decided: the count and a sentence */
  yes?: number; no?: number; result?: string;
}
