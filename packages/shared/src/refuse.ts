import { KIND_ID, CAPACITY_TABLE, WAGE_TABLE, UPKEEP_TABLE, COST_TABLE } from './buildings/compiled';
import { LEVEL_SLOTS } from './buildings/codes';
import { ValueKind, VALUE_KINDS, VALUE_KIND_COUNT, VALUE_CELL, valueKernels } from './value';
import { ECONOMY_TUNING } from './tuning';

/**
 * Refuse grades, add-ons, the landfill levy and boundary limits (docs/multiplayer-land.md section 5, M4). Browser-safe
 * and shared: the server charges and spreads with it (sim/refuse.ts, sim/value.ts, net.ts), the client's ghost shows the
 * same boundary verdict before a click (main.ts) and the building panel the same figures.
 *
 * Use is "homes emptied a day" as in M1 (nuisance follows use); a home's bins are LANDFILL_LEVY.tonnesPerHome tonnes.
 * Each grade gives off so many value units per home a day per nuisance kind (the same units as shared value.ts VALUE.emit:
 * a source cell's intensity is 1 - exp(-units)), eyesore rising to its most once the site is busy. Add-ons multiply them.
 */

/** The add-ons a refuse site may have, as bits of its add-on mask (World.refuseAddons on the server). */
export const RefuseAddon = { Enclosure: 1, Screening: 2, Hours: 4 } as const;
export type RefuseAddonId = 'enclosure' | 'screening' | 'hours';
export interface RefuseAddonDef {
  id: RefuseAddonId; bit: number; label: string; blurb: string;
  /** one-off cost to fit it and its upkeep a day */
  cost: number; upkeep: number;
  /** multiplier per value kind (noise, smell, traffic, hazard, disorder, eyesore; the rest 1) */
  mult: readonly number[];
  /** multiplier on smoke (the levy's smoke units) */
  smoke: number;
  /** multiplier on the homes the site can take a day */
  throughput: number;
}
const M = (noise: number, smell: number, traffic: number, hazard: number, eyesore: number): number[] => {
  const m = new Array(VALUE_KIND_COUNT).fill(1);
  m[ValueKind.Noise] = noise; m[ValueKind.Smell] = smell; m[ValueKind.Traffic] = traffic; m[ValueKind.Hazard] = hazard; m[ValueKind.Eyesore] = eyesore;
  return m;
};
export const REFUSE_ADDONS: readonly RefuseAddonDef[] = [
  { id: 'enclosure', bit: RefuseAddon.Enclosure, label: 'Enclosure', blurb: 'work under a roof with air extraction (scrubbers on a stack): much less smell, smoke and noise', cost: 3000, upkeep: 15, mult: M(0.5, 0.4, 1, 0.4, 0.6), smoke: 0.4, throughput: 1 },
  { id: 'screening', bit: RefuseAddon.Screening, label: 'Screening', blurb: 'tree belts and earth banks round the yard: less noise, the eyesore mostly hidden', cost: 700, upkeep: 3, mult: M(0.65, 0.9, 1, 1, 0.3), smoke: 1, throughput: 1 },
  { id: 'hours', bit: RefuseAddon.Hours, label: 'Restricted hours', blurb: 'no night working: the gates shut at 19:00, so no night noise, but it takes 30% less a day', cost: 0, upkeep: 0, mult: M(0.6, 1, 0.85, 1, 1), smoke: 1, throughput: 0.7 },
];
export const REFUSE_ADDON_BY_ID = new Map(REFUSE_ADDONS.map((a) => [a.id, a]));

export type RefuseGradeId = 'tip' | 'landfill' | 'recycling' | 'compost' | 'incinerator';
export interface RefuseGrade {
  id: RefuseGradeId; kindId: number; name: string;
  /** homes it can empty a day at full use (its crews' rounds are capped at this) */
  capacity: number;
  /** share of each tonne landfilled (pays the levy) */
  landfill: number;
  /** smoke units per tonne (pays the levy; spreads as smell and a little hazard) */
  smoke: number;
  /** money back per tonne handled, and what for (the ledger's `recycling` line) */
  sales: number; salesWhat: string;
  /** value units per home emptied a day: noise, smell (with smoke), heavy traffic, hazard; eyesore at its most once busy */
  noise: number; smell: number; traffic: number; hazard: number; eyesore: number;
}
/**
 * The grades (docs/multiplayer-land.md section 5's table). Compared with M1's old depots (VALUE.emit.waste*: smell 0.025,
 * traffic 0.012, noise 0.006 a home), the tip is a little worse and every other grade better; the recycling centre is the
 * noisiest yard. Money at a moderate 100 homes a day (25 tonnes): see refuseDaily and the refuse check.
 */
export const REFUSE_GRADES: readonly RefuseGrade[] = [
  { id: 'tip', kindId: KIND_ID['open-tip'], name: 'open tip', capacity: 160, landfill: 1, smoke: 0, sales: 0, salesWhat: '', noise: 0.006, smell: 0.03, traffic: 0.013, hazard: 0, eyesore: 0.8 },
  { id: 'landfill', kindId: KIND_ID['lined-landfill'], name: 'lined landfill', capacity: 160, landfill: 1, smoke: 0, sales: 0.3, salesWhat: 'landfill gas', noise: 0.005, smell: 0.014, traffic: 0.01, hazard: 0, eyesore: 0.45 },
  { id: 'recycling', kindId: KIND_ID['recycling-centre'], name: 'recycling centre', capacity: 140, landfill: 0.3, smoke: 0, sales: 1.6, salesWhat: 'materials', noise: 0.009, smell: 0.003, traffic: 0.011, hazard: 0, eyesore: 0.25 },
  { id: 'compost', kindId: KIND_ID['compost-digester'], name: 'composting and digester site', capacity: 100, landfill: 0.2, smoke: 0, sales: 2.2, salesWhat: 'gas and compost', noise: 0.003, smell: 0.005, traffic: 0.007, hazard: 0, eyesore: 0.15 },
  { id: 'incinerator', kindId: KIND_ID['energy-from-waste'], name: 'energy-from-waste plant', capacity: 200, landfill: 0.1, smoke: 0.5, sales: 3.2, salesWhat: 'power', noise: 0.005, smell: 0.002, traffic: 0.01, hazard: 0, eyesore: 0.3 },
];
const GRADE_OF: (RefuseGrade | undefined)[] = [];
for (const g of REFUSE_GRADES) GRADE_OF[g.kindId] = g;
/** The grade of a refuse site's kind, or undefined for any other kind. */
export const refuseGradeOf = (kindId: number): RefuseGrade | undefined => GRADE_OF[kindId];
export const isRefuseSite = (kindId: number) => GRADE_OF[kindId] !== undefined;

/**
 * The landfill levy (section 5, "instead of the polluter pays the neighbour"): every tonne landfilled and every unit of
 * smoke pays into the world's regional fund, which pays the upkeep of adopted public roads (sim/publicroads.ts).
 */
export const LANDFILL_LEVY = {
  /** a home's bins, tonnes */
  tonnesPerHome: 0.25,
  /** per tonne landfilled */
  perTonne: 3,
  /** per unit of smoke */
  perSmoke: 4,
  /** smell and hazard units per unit of smoke (an incinerator's stack) */
  smokeSmell: 0.1, smokeHazard: 0.016,
  /** eyesore reaches its most at this many homes a day (as M1's VALUE.emit.wasteBusy) */
  busy: 20,
};

/** Homes a site can empty a day with these add-ons. */
export function refuseCapacity(kindId: number, addons = 0): number {
  const g = GRADE_OF[kindId];
  if (!g) return 0;
  let c = g.capacity;
  for (const a of REFUSE_ADDONS) if (addons & a.bit) c *= a.throughput;
  return Math.floor(c);
}

/** Value units a day a site gives off per kind at `homes` homes emptied a day (out: VALUE_KIND_COUNT, nuisances only). */
export function refuseEmission(kindId: number, addons: number, homes: number, out = new Float64Array(VALUE_KIND_COUNT)): Float64Array {
  out.fill(0);
  const g = GRADE_OF[kindId];
  if (!g || !(homes > 0)) return out;
  let smoke = g.smoke * LANDFILL_LEVY.tonnesPerHome * homes;
  for (const a of REFUSE_ADDONS) if (addons & a.bit) smoke *= a.smoke;
  out[ValueKind.Noise] = g.noise * homes;
  out[ValueKind.Smell] = g.smell * homes;
  out[ValueKind.Traffic] = g.traffic * homes;
  out[ValueKind.Hazard] = g.hazard * homes;
  out[ValueKind.Eyesore] = g.eyesore * Math.min(1, homes / LANDFILL_LEVY.busy);
  for (const a of REFUSE_ADDONS) if (addons & a.bit) for (let k = 0; k < VALUE_KIND_COUNT; k++) out[k] *= a.mult[k];
  // the stack's smoke (already cut by an enclosure's scrubbers) spreads as smell and a little hazard
  out[ValueKind.Smell] += smoke * LANDFILL_LEVY.smokeSmell;
  out[ValueKind.Hazard] += smoke * LANDFILL_LEVY.smokeHazard;
  return out;
}

/** What one home's bins cost or earn at a site: tonnes, tonnes landfilled, smoke units, the levy, sales. */
export function refusePerHome(kindId: number, addons = 0): { tonnes: number; landfilled: number; smoke: number; levy: number; sales: number } {
  const g = GRADE_OF[kindId], t = LANDFILL_LEVY.tonnesPerHome;
  if (!g) return { tonnes: 0, landfilled: 0, smoke: 0, levy: 0, sales: 0 };
  let smoke = g.smoke * t;
  for (const a of REFUSE_ADDONS) if (addons & a.bit) smoke *= a.smoke;
  const landfilled = g.landfill * t;
  return { tonnes: t, landfilled, smoke, levy: landfilled * LANDFILL_LEVY.perTonne + smoke * LANDFILL_LEVY.perSmoke, sales: g.sales * t };
}
/** Add-ons' upkeep a day. */
export function addonUpkeep(addons: number): number { let u = 0; for (const a of REFUSE_ADDONS) if (addons & a.bit) u += a.upkeep; return u; }

/**
 * A site's day at `homes` homes a day: the levy and sales, its upkeep (the building's and its add-ons'), the owner's
 * share of a full staff's wages (three shifts' worth is not paid: one 8-hour shift each, as World.payroll charges), and
 * `net`, the day's cost (positive: it costs the owner that much). The refuse check compares grades with it.
 */
export function refuseDaily(kindId: number, addons: number, homes: number) {
  const g = GRADE_OF[kindId];
  const ph = refusePerHome(kindId, addons), s = kindId * LEVEL_SLOTS + 1;
  const upkeep = (g ? UPKEEP_TABLE[s] : 0) + addonUpkeep(addons);
  const wages = g ? CAPACITY_TABLE[s] * WAGE_TABLE[s] * ECONOMY_TUNING.civicPayroll : 0;
  const levy = ph.levy * homes, sales = ph.sales * homes;
  return { tonnes: ph.tonnes * homes, landfilled: ph.landfilled * homes, smoke: ph.smoke * homes, levy, sales, upkeep, wages, build: g ? COST_TABLE[s] : 0, net: upkeep + wages + levy - sales };
}

// ---- boundary limits ---------------------------------------------------------------------------------------------

/**
 * The most of each nuisance kind (intensity 0-1, the value field's byte / 255) a building may push onto someone else's
 * land, as its own long-run contribution at full use (docs/multiplayer-land.md section 5, limits at the boundary).
 * Amenities have no limit (1).
 */
export const BOUNDARY_LIMITS: readonly number[] = (() => {
  const l = new Array(VALUE_KIND_COUNT).fill(1);
  l[ValueKind.Noise] = 0.4; l[ValueKind.Smell] = 0.35; l[ValueKind.Traffic] = 0.45; l[ValueKind.Hazard] = 0.2; l[ValueKind.Disorder] = 0.4; l[ValueKind.Eyesore] = 0.4;
  return l;
})();

export interface BoundaryImpact {
  /** per value kind: the most this site would push onto any other owner's land at full use (0-1) */
  worst: number[];
  /** the owner and a tile of that worst place, per kind (null where nobody else's land is reached) */
  owner: (string | null)[]; at: ([number, number] | null)[];
  /** the kinds over their limit */
  over: number[];
  ok: boolean;
  /** homes a day assumed (full use) */
  homes: number;
}
/**
 * What a refuse site of `kindId` with `addons`, its door at (x, y), would push onto other owners' land at full use: the
 * M1 spread kernels of this world (valueKernels(seed): round, or a plume on the wind rose) over the expected emission,
 * per 4×4 cell, the worst of each kind over every tile whose owner is someone other than `builder` (unclaimed land and
 * the builder's own land are not limited). `ownerAt` reads a tile's parcel owner (null: unclaimed).
 */
export function boundaryImpact(kindId: number, addons: number, x: number, y: number, seed: number, builder: string, ownerAt: (x: number, y: number) => string | null | undefined): BoundaryImpact {
  const K = VALUE_KIND_COUNT, homes = refuseCapacity(kindId, addons);
  const u = refuseEmission(kindId, addons, homes), ks = valueKernels(seed);
  const worst = new Array(K).fill(0), owner: (string | null)[] = new Array(K).fill(null), at: ([number, number] | null)[] = new Array(K).fill(null);
  const C = VALUE_CELL, gx = Math.floor(x / C), gy = Math.floor(y / C);
  let R = 0;
  for (let k = 0; k < K; k++) if (u[k] > 0) R = Math.max(R, ks[k].r);
  const cellI = new Float64Array(K);
  for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
    let any = false;
    for (let k = 0; k < K; k++) {
      cellI[k] = 0;
      if (!(u[k] > 0)) continue;
      const ker = ks[k], r = ker.r;
      if (Math.abs(i) > r || Math.abs(j) > r) continue;
      const w = ker.w[(j + r) * (2 * r + 1) + (i + r)];
      if (!w) continue;
      const v = 1 - Math.exp(-u[k] * w);
      cellI[k] = v;
      if (v > worst[k] && v > 0.005) any = true;
    }
    if (!any) continue;
    // the owners of this cell's tiles other than the builder
    const x0 = (gx + i) * C, y0 = (gy + j) * C;
    let who: string | null = null, wx = 0, wy = 0;
    for (let ty = y0; ty < y0 + C && !who; ty++) for (let tx = x0; tx < x0 + C; tx++) {
      const o = ownerAt(tx, ty);
      if (o && o !== builder) { who = o; wx = tx; wy = ty; break; }
    }
    if (!who) continue;
    for (let k = 0; k < K; k++) if (cellI[k] > worst[k]) { worst[k] = cellI[k]; owner[k] = who; at[k] = [wx, wy]; }
  }
  const over: number[] = [];
  for (let k = 0; k < K; k++) if (VALUE_KINDS[k].nuisance && worst[k] > BOUNDARY_LIMITS[k] + 1e-9) over.push(k);
  return { worst, owner, at, over, ok: over.length === 0, homes };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** The refusal for an impact over its limits, naming the worst kind and whose land it reaches; null when it passes. */
export function boundaryRefusal(b: BoundaryImpact, what: string, nameOf: (owner: string) => string = (o) => o): string | null {
  if (b.ok) return null;
  let k = b.over[0];
  for (const o of b.over) if (b.worst[o] / BOUNDARY_LIMITS[o] > b.worst[k] / BOUNDARY_LIMITS[k]) k = o;
  const more = b.over.length > 1 ? ` (and ${b.over.filter((o) => o !== k).map((o) => VALUE_KINDS[o].name).join(', ')})` : '';
  return `The ${what} would push ${pct(b.worst[k])} ${VALUE_KINDS[k].name}${more} onto ${nameOf(b.owner[k] ?? '')}'s land at full use; the limit at a boundary is ${pct(BOUNDARY_LIMITS[k])}. Choose a cleaner grade, add screening or an enclosure, or build further back`;
}
/** A one-line summary of an impact that passes: the worst kind over others' land against its limit. */
export function boundarySummary(b: BoundaryImpact): string {
  let k = -1;
  for (let i = 0; i < VALUE_KIND_COUNT; i++) if (VALUE_KINDS[i].nuisance && b.worst[i] > 0 && (k < 0 || b.worst[i] / BOUNDARY_LIMITS[i] > b.worst[k] / BOUNDARY_LIMITS[k])) k = i;
  return k < 0 ? 'nothing reaches anyone else\'s land' : `at others' land: ${VALUE_KINDS[k].name} ${pct(b.worst[k])} of ${pct(BOUNDARY_LIMITS[k])} allowed`;
}
