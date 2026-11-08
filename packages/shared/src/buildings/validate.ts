import type { KindDef, Op, HelperModel, Attributes, LevelDef, Design } from './schema';
import { PALETTE, WINDOW_CLASSES, type WindowClass } from './palette';
import { FEATURES, FACES, facadeErrors } from './facade';
import { HELPERS } from './helpers';
import { MAX_KIND_CODE, MAX_LEVEL_CODE, MAX_FOOTPRINT, MAX_KIND_ID, FIRST_SUB_KIND_ID, LANDMARK_DRAFT_IDS } from './codes';
import { techFor } from '../tech';
import { GROUP_BY_ID } from './groups';
import { VENUE_TYPES, UNSTAFFED_VENUES } from '../venueTypes';

const FAMILIES = ['residential', 'commercial', 'industrial', 'office', 'civic', 'transport', 'leisure', 'utility'];
const FLAG_NAMES = ['growable', 'civic', 'service', 'workplace', 'parking', 'leisureReady'];
/** numeric args (after the op name) and the optional tail each primitive accepts */
const PRIMS: Record<string, { nums: number; color: boolean; tail?: 'win' | 'bool' | 'seg' }> = {
  box: { nums: 6, color: true, tail: 'win' },
  roof: { nums: 6, color: true, tail: 'bool' },
  cyl: { nums: 6, color: true, tail: 'seg' },
  cone: { nums: 5, color: true, tail: 'seg' },
  wheel: { nums: 5, color: true },
};
/** Attributes each family must define (after merging kind, level and design). */
const REQUIRED_ATTRS: Record<string, Record<string, 'number' | 'string' | 'hours'>> = {
  industrial: { pollution: 'number', noise: 'number', goodsType: 'string' },
  commercial: { commerceType: 'string', visitorCapacity: 'number', openHours: 'hours' },
  residential: { style: 'string', rentBand: 'string' },
  leisure: { venueType: 'string', leisureValue: 'number', radius: 'number', visitorCapacity: 'number', openHours: 'hours', ticket: 'number', stay: 'hours' },
};
/** Leisure rules beyond presence and type: sane ranges, event nights as weekdays, parks unstaffed and venues staffed. */
function checkLeisure(k: KindDef, a: Attributes, where: string, errs: string[]) {
  const bad = (m: string) => errs.push(`${where}: ${m}`);
  if (typeof a.venueType === 'string' && !(VENUE_TYPES as readonly string[]).includes(a.venueType)) bad(`venueType '${a.venueType}' unknown (${VENUE_TYPES.join(', ')})`);
  const free = (UNSTAFFED_VENUES as readonly string[]).includes(String(a.venueType));
  // a park has no staff; the playground, skate park and allotments may go either way (attractions.ts leaves them unstaffed)
  if (a.venueType === 'park' && k.flags?.workplace) bad('a park has no staff: drop the workplace flag');
  if (!free && !k.flags?.workplace) bad('a staffed venue needs the workplace flag and an occupation');
  if (isNum(a.visitorCapacity) && (!Number.isInteger(a.visitorCapacity) || a.visitorCapacity < 1 || a.visitorCapacity > 500)) bad('visitorCapacity must be an integer 1-500');
  if (isNum(a.leisureValue) && (a.leisureValue < 0 || a.leisureValue > 12)) bad('leisureValue must be 0-12');
  if (isNum(a.radius) && (a.radius < 0 || a.radius > 40)) bad('radius must be 0-40 tiles');
  if (isNum(a.ticket) && a.ticket < 0) bad('ticket must not be negative');
  const oh = a.openHours, st = a.stay;
  if (Array.isArray(oh) && oh.length === 2 && oh[0] >= oh[1]) bad('openHours must open before it closes');
  if (Array.isArray(st) && st.length === 2 && (st[0] <= 0 || st[0] > st[1])) bad('stay must be [min, max] hours with 0 < min <= max');
  if (a.eventNights !== undefined) {
    const ev = a.eventNights;
    if (!Array.isArray(ev) || ev.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(ev).size !== ev.length) bad('eventNights must be distinct weekdays 0-6 (0 = Monday)');
    // morning events too: a fishing match at 8, the dawn chorus walk at first light, a farm's open day at 11
    else if (ev.length && !(isNum(a.eventStart) && a.eventStart >= 5 && a.eventStart <= 23)) bad('event days need an eventStart hour 5-23');
  }
  for (const f of ['dayAppeal', 'eveningAppeal', 'retireeAppeal', 'childAppeal', 'upgradeVisits', 'trees', 'benches', 'eventSize'] as const) {
    if (a[f] !== undefined && !(isNum(a[f]) && (a[f] as number) >= 0)) bad(`${f} must be a non-negative number`);
  }
}
const INT16 = 32767;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isColor = (c: unknown) => (typeof c === 'string' && c in PALETTE) || (Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 0xffffff);

/** Check one recipe op; returns problems (empty when fine). */
export function checkOp(op: Op, where: string): string[] {
  const errs: string[] = [];
  if (!Array.isArray(op) || typeof op[0] !== 'string') return [`${where}: an op must be an array starting with its name`];
  const [name, ...args] = op as unknown as [string, ...unknown[]];
  const helper = HELPERS[name];
  if (helper) {
    if (args.length < helper.minArgs || args.length > helper.args.length) errs.push(`${where}: ${name} takes ${helper.args.join(' ')} (${helper.minArgs}-${helper.args.length} args), got ${args.length}`);
    args.forEach((a, i) => {
      const n = helper.args[i];
      if (n === 'color' || n === 'body') { if (!isColor(a)) errs.push(`${where}: ${name} ${n} ${JSON.stringify(a)} is not a palette name or 0xRRGGBB`); }
      else if (!isNum(a)) errs.push(`${where}: ${name} ${n} must be a number`);
    });
    return errs;
  }
  const feat = FEATURES[name];
  if (feat) {
    if (args.length < feat.min || args.length > feat.args.length) errs.push(`${where}: ${name} takes ${feat.args.join(' ')} (${feat.min}-${feat.args.length} args), got ${args.length}`);
    args.forEach((a, i) => {
      const n = feat.args[i];
      if (n === undefined) return;
      if (/olor$/.test(n)) { if (!isColor(a)) errs.push(`${where}: ${name} ${n} ${JSON.stringify(a)} is not a palette name or 0xRRGGBB`); }
      else if (n === 'part' || n === 'roofPart') { if (!(typeof a === 'string' || (Number.isInteger(a) && (a as number) >= 0))) errs.push(`${where}: ${name} ${n} must be a part name or an op index`); }
      else if (n === 'face') { if (!FACES.includes(a as never)) errs.push(`${where}: ${name} face ${JSON.stringify(a)} is not one of ${FACES.join(', ')}`); }
      else if (n === 'size' || n === 'at') return; // ad slots: checked with the design (facade.ts adslotErrors)
      else if (!Number.isInteger(a)) errs.push(`${where}: ${name} ${n} must be an integer`);
    });
    return errs;
  }
  if (name === 'taper' || name === 'lathe') return shapeErrors(name, args, where);
  if (name === 'screens') return screensErrors(args, where);
  const p = PRIMS[name];
  if (!p) return [`${where}: unknown op '${name}' (known: ${[...Object.keys(PRIMS), 'taper', 'lathe', 'screens', ...Object.keys(HELPERS), ...Object.keys(FEATURES)].join(', ')})`];
  // boxes and roofs may end with an options object ({ name, facade }), checked per design by facadeErrors
  const opts = (name === 'box' || name === 'roof') && args.length === p.nums + 3 && typeof args[p.nums + 2] === 'object';
  const max = p.nums + 1 + (p.tail ? 1 : 0) + (opts ? 1 : 0);
  if (args.length < p.nums + 1 || args.length > max) return [`${where}: ${name} takes ${p.nums} numbers, a colour${p.tail ? ` and an optional ${p.tail}` : ''}${name === 'box' || name === 'roof' ? ' then optional { name, facade }' : ''}; got ${args.length} args`];
  for (let i = 0; i < p.nums; i++) if (!isNum(args[i])) errs.push(`${where}: ${name} arg ${i + 1} must be a number`);
  if (!isColor(args[p.nums])) errs.push(`${where}: ${name} colour ${JSON.stringify(args[p.nums])} is not a palette name or 0xRRGGBB`);
  const t = args[p.nums + 1];
  if (t !== undefined) {
    if (p.tail === 'win' && !(t === true || (typeof t === 'string' && t in WINDOW_CLASSES))) errs.push(`${where}: window class ${JSON.stringify(t)} unknown (use true or one of ${Object.keys(WINDOW_CLASSES).join(', ')})`);
    if (p.tail === 'bool' && typeof t !== 'boolean') errs.push(`${where}: roof alongZ must be true or false`);
    if (p.tail === 'seg' && !(Number.isInteger(t) && (t as number) >= 3 && (t as number) <= 64)) errs.push(`${where}: segments must be an integer 3-64`);
  }
  return errs;
}

/** A bank of screens on a curve (schema.ts `screens`, adslot.ts screenArc): flush on the bezel's facets, never facing the back. */
function screensErrors(args: unknown[], where: string): string[] {
  if (args.length < 9 || args.length > 10) return [`${where}: screens takes x y z r from to cols rows h and an optional bezel colour; got ${args.length} args`];
  const errs: string[] = [];
  for (let i = 0; i < 9; i++) if (!isNum(args[i])) errs.push(`${where}: screens arg ${i + 1} must be a number`);
  if (errs.length) return errs;
  const [, , , r, from, to, cols, rows, h] = args as number[];
  if (r <= 0 || h <= 0) errs.push(`${where}: screens radius and height must be positive`);
  if (!Number.isInteger(cols) || cols < 1 || cols > 12 || !Number.isInteger(rows) || rows < 1 || rows > 4) errs.push(`${where}: screens cols must be 1-12 and rows 1-4`);
  else if (!(to > from)) errs.push(`${where}: screens must run from a smaller angle to a bigger one`);
  else {
    const step = (to - from) / cols, segs = 360 / step;
    if (Math.abs(segs - Math.round(segs)) > 1e-6 || segs < 3 || segs > 64) errs.push(`${where}: screens: a column of ${step} degrees must divide 360 into 3-64 facets`);
    else if (Math.abs(from / step - Math.round(from / step)) > 1e-6) errs.push(`${where}: screens: from (${from}) must be a multiple of a column's ${step} degrees, so the panels sit on the bezel's facets`);
    if (from + step / 2 < -135 || to - step / 2 > 135) errs.push(`${where}: screens must face a road side (front, left or right), not the back`);
  }
  if (args[9] !== undefined && !isColor(args[9])) errs.push(`${where}: screens bezel ${JSON.stringify(args[9])} is not a palette name or 0xRRGGBB`);
  return errs;
}

const winOk = (w: unknown) => w === undefined || w === true || (typeof w === 'string' && w in WINDOW_CLASSES);
/** The two shaped primitives (schema.ts): a taper (a box with a different top) and a lathe (a solid of revolution). */
function shapeErrors(name: 'taper' | 'lathe', args: unknown[], where: string): string[] {
  const errs: string[] = [];
  const opts = (o: unknown, keys: string[]) => {
    if (o === undefined) return {} as Record<string, unknown>;
    if (!o || typeof o !== 'object' || Array.isArray(o)) { errs.push(`${where}: ${name} options must be an object`); return {}; }
    for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push(`${where}: ${name} option '${k}' unknown (${keys.join(', ')})`);
    return o as Record<string, unknown>;
  };
  if (name === 'taper') {
    if (args.length < 9 || args.length > 10) return [`${where}: taper takes wBot dBot wTop dTop h x y z, a colour and optional { win, shift }; got ${args.length} args`];
    for (let i = 0; i < 8; i++) if (!isNum(args[i])) errs.push(`${where}: taper arg ${i + 1} must be a number`);
    if ([0, 1, 4].some((i) => isNum(args[i]) && (args[i] as number) <= 0) || [2, 3].some((i) => isNum(args[i]) && (args[i] as number) < 0)) errs.push(`${where}: taper base and height must be positive, the top not negative`);
    if (!isColor(args[8])) errs.push(`${where}: taper colour ${JSON.stringify(args[8])} is not a palette name or 0xRRGGBB`);
    const o = opts(args[9], ['win', 'shift']);
    if (!winOk(o.win)) errs.push(`${where}: taper win ${JSON.stringify(o.win)} unknown`);
    if (o.shift !== undefined && !(Array.isArray(o.shift) && o.shift.length === 2 && o.shift.every(isNum))) errs.push(`${where}: taper shift must be [dx, dz]`);
    return errs;
  }
  if (args.length < 5 || args.length > 6) return [`${where}: lathe takes x y z, a colour, a profile [r, dy, ...] and optional { seg, twist, stripe, every, width, axis, win }; got ${args.length} args`];
  for (let i = 0; i < 3; i++) if (!isNum(args[i])) errs.push(`${where}: lathe arg ${i + 1} must be a number`);
  if (!isColor(args[3])) errs.push(`${where}: lathe colour ${JSON.stringify(args[3])} is not a palette name or 0xRRGGBB`);
  const pr = args[4];
  if (!Array.isArray(pr) || pr.length < 4 || pr.length % 2 || !pr.every(isNum)) errs.push(`${where}: lathe profile must be [r, dy, r, dy, ...] with at least two points`);
  else for (let i = 0; i < pr.length; i += 2) {
    if (pr[i] < 0) errs.push(`${where}: lathe profile radius ${pr[i]} is negative`);
    if (i && pr[i + 1] < pr[i - 1]) errs.push(`${where}: lathe profile heights must not go down (${pr[i - 1]} then ${pr[i + 1]})`);
  }
  if (Array.isArray(pr) && pr[1] !== 0) errs.push(`${where}: lathe profile starts at dy 0 (its base sits at y)`);
  const o = opts(args[5], ['seg', 'twist', 'stripe', 'every', 'width', 'axis', 'win']);
  if (o.twist !== undefined && !isNum(o.twist)) errs.push(`${where}: lathe twist must be degrees per tile`);
  if (o.width !== undefined && !(Number.isInteger(o.width) && (o.width as number) >= 1 && (o.width as number) < ((o.every as number) ?? 4))) errs.push(`${where}: lathe width must be an integer from 1 to less than every`);
  if (o.axis !== undefined && !['x', 'y', 'z'].includes(o.axis as string)) errs.push(`${where}: lathe axis must be 'x', 'y' or 'z'`);
  if (o.seg !== undefined && !(Number.isInteger(o.seg) && (o.seg as number) >= 3 && (o.seg as number) <= 64)) errs.push(`${where}: lathe seg must be an integer 3-64`);
  if (o.stripe !== undefined && !isColor(o.stripe)) errs.push(`${where}: lathe stripe ${JSON.stringify(o.stripe)} is not a palette name or 0xRRGGBB`);
  if (o.every !== undefined && !(Number.isInteger(o.every) && (o.every as number) >= 2)) errs.push(`${where}: lathe every must be an integer 2 or more`);
  if (!winOk(o.win)) errs.push(`${where}: lathe win ${JSON.stringify(o.win)} unknown`);
  return errs;
}

function checkDesign(d: Design, where: string, errs: string[], windows?: WindowClass) {
  if (!d || typeof d !== 'object') { errs.push(`${where}: design must be an object`); return; }
  if (typeof d.name !== 'string' || !d.name) errs.push(`${where}: design needs a name`);
  if (!isNum(d.height) || d.height <= 0 || d.height > 20) errs.push(`${where}: height must be a number in (0, 20]`);
  if (!Array.isArray(d.ops) || d.ops.length === 0) errs.push(`${where}: ops must be a non-empty array`);
  else {
    const before = errs.length;
    d.ops.forEach((op, i) => errs.push(...checkOp(op, `${where} op ${i}`)));
    // facades and the features placed by cell, once every op has the right shape
    if (errs.length === before) errs.push(...facadeErrors(d.ops, where, windows));
  }
}

/** The merged attributes a design ends up with. */
export const mergeAttrs = (k: KindDef, l: LevelDef, d?: Design): Attributes => ({ ...(k.attrs ?? {}), ...(l.attrs ?? {}), ...(d?.attrs ?? {}) });

/**
 * Validate the whole catalogue. Returns a list of problems; the compile step
 * refuses to write output while it is non-empty.
 */
export function validateCatalogue(kinds: KindDef[], helpers: HelperModel[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>(), bases = new Map<number, string>(), kindIds = new Map<number, string>(), tools = new Set<string>(), keys = new Set<string>();
  const subFamilies = new Map<number, string>();
  if (!Array.isArray(kinds) || kinds.length === 0) return ['catalogue is empty'];
  for (const k of kinds) {
    const w = `kind '${k?.id ?? '?'}'`;
    if (typeof k.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(k.id)) errs.push(`${w}: id must be lower-case letters, digits and dashes`);
    else if (ids.has(k.id)) errs.push(`${w}: duplicate id`); else ids.add(k.id);
    if (typeof k.name !== 'string' || !k.name) errs.push(`${w}: missing name`);
    if (!Number.isInteger(k.code) || k.code < 1 || k.code > MAX_KIND_CODE) errs.push(`${w}: kind code ${k.code} outside 1-${MAX_KIND_CODE} (the tile's 4-bit kind field, now the family code; see docs/sub-kinds.md)`);
    else if (k.kindId === undefined || k.kindId === k.code) {
      // the family's base kind: a tile of this code with sub byte 0 is this kind, so there is exactly one per code
      if (bases.has(k.code)) errs.push(`${w}: kind code ${k.code} already used by '${bases.get(k.code)}' (a second kind of the same family needs its own kindId from ${FIRST_SUB_KIND_ID})`); else bases.set(k.code, k.id);
    } else if (!Number.isInteger(k.kindId) || k.kindId < FIRST_SUB_KIND_ID || k.kindId > MAX_KIND_ID) errs.push(`${w}: kindId ${k.kindId} outside ${FIRST_SUB_KIND_ID}-${MAX_KIND_ID} (ids below ${FIRST_SUB_KIND_ID} belong to the base kinds and equal their code; the sub byte holds up to ${MAX_KIND_ID})`);
    else subFamilies.set(k.code, k.id);
    const kid = k.kindId ?? k.code;
    if (Number.isInteger(kid)) { if (kindIds.has(kid)) errs.push(`${w}: kindId ${kid} already used by '${kindIds.get(kid)}'`); else kindIds.set(kid, k.id); }
    if (!FAMILIES.includes(k.family)) errs.push(`${w}: family '${k.family}' unknown (${FAMILIES.join(', ')})`);
    if (!k.flags || typeof k.flags !== 'object') errs.push(`${w}: missing flags`);
    else for (const f of Object.keys(k.flags)) if (!FLAG_NAMES.includes(f)) errs.push(`${w}: unknown flag '${f}'`);
    if (!(k.windows in WINDOW_CLASSES)) errs.push(`${w}: windows '${k.windows}' unknown (${Object.keys(WINDOW_CLASSES).join(', ')})`);
    if (k.tool) {
      const t = k.tool;
      // key '' is a tool with no keyboard shortcut (every letter is taken); it is only on the tool bar
      if (!t.id || typeof t.key !== 'string' || !t.label || !t.color) errs.push(`${w}: tool needs id, key ('' for none), label and color`);
      if (tools.has(t.id)) errs.push(`${w}: tool id '${t.id}' already used`); tools.add(t.id);
      const key = String(t.key).toLowerCase();
      if (key && keys.has(key)) errs.push(`${w}: tool key '${t.key}' already used`); if (key) keys.add(key);
      if (['1', '2', '3', 'x', 'z', 'c'].includes(key)) errs.push(`${w}: tool key '${t.key}' is reserved (select, buy, road, bulldoze, rotate footprint left and right)`);
    }
    if (k.flags?.workplace) {
      const o = k.occupation;
      if (!o) errs.push(`${w}: a workplace needs an occupation`);
      else {
        if (!o.name) errs.push(`${w}: occupation needs a name`);
        if (!Array.isArray(o.shifts) || !o.shifts.length || o.shifts.some((s) => !isNum(s.start) || !isNum(s.hours) || !isNum(s.weight) || s.hours <= 0 || s.weight <= 0)) errs.push(`${w}: occupation shifts need numeric start, hours > 0 and weight > 0`);
        if (!Array.isArray(o.cycles) || !o.cycles.length || o.cycles.some((c) => !Array.isArray(c) || !c.length || c.some((d) => d !== 0 && d !== 1))) errs.push(`${w}: occupation cycles must be non-empty arrays of 0 and 1`);
        if (typeof o.rotate !== 'boolean') errs.push(`${w}: occupation rotate must be true or false`);
      }
    }
    if (k.tints && (!Array.isArray(k.tints) || k.tints.some((c) => !isColor(c) || typeof c !== 'number'))) errs.push(`${w}: tints must be 0xRRGGBB numbers`);
    if (k.lotTint !== undefined && !(Number.isInteger(k.lotTint) && k.lotTint >= 0 && k.lotTint <= 0xffffff)) errs.push(`${w}: lotTint must be 0xRRGGBB`);
    if (k.footprint !== undefined) {
      const f = k.footprint;
      const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
      if (!f || !intIn(f.w, 1, MAX_FOOTPRINT) || !intIn(f.h, 1, MAX_FOOTPRINT)) errs.push(`${w}: footprint w and h must be integers 1-${MAX_FOOTPRINT} (the aux byte's part offsets are 3 bits)`);
      else if (!Array.isArray(f.door) || f.door.length !== 2 || !intIn(f.door[0], 0, f.w - 1) || f.door[1] !== f.h - 1) errs.push(`${w}: footprint door must be [dx, ${f.h - 1}] with dx 0-${f.w - 1} (a tile on the front row, which faces the road)`);
      else if (f.w * f.h > 1 && k.flags?.growable) {
        // merged lots (zones.ts): a zone grows into a bigger kind by merging lots; the family's base kind stays 1×1 so zoning stays per tile
        if (k.kindId === undefined || k.kindId === k.code || k.flags.civic) errs.push(`${w}: only civic kinds placed by a player, or growable sub-kinds a zone grows into by merging lots, can be bigger than 1×1 (a family's base kind stays 1×1)`);
        if (k.tool) errs.push(`${w}: a merged zone kind is grown, not placed; it takes no tool`);
      } else if (f.w * f.h > 1 && !k.flags?.civic) errs.push(`${w}: only civic kinds placed by a player, or growable sub-kinds a zone grows into by merging lots, can be bigger than 1×1`); // a civic car park (parking + civic) is built by builders like any structure
      if (f && f.marks !== undefined) errs.push(...footprintMarkErrors(f, w));
      // harbours (docs/boats.md section 5): back rows over water, the door row on land, and a fairway width class
      if (f && f.wet !== undefined && !(Number.isInteger(f.wet) && f.wet >= 1 && f.wet <= f.h - 1)) errs.push(`${w}: footprint wet must be an integer 1-${f.h - 1} (back rows over water; the door row stays on land)`);
      if (f && f.fairwayClearance !== undefined && (f.wet === undefined || !intIn(f.fairwayClearance, 1, 3))) errs.push(`${w}: footprint fairwayClearance must be 1-3 (narrow, river, open) and needs wet`);
    }
    if (k.draft !== undefined && typeof k.draft !== 'boolean') errs.push(`${w}: draft must be true or false`);
    if (k.tags !== undefined && (!Array.isArray(k.tags) || k.tags.some((t) => typeof t !== 'string' || !/^[a-z][a-z0-9-]*$/.test(t)) || new Set(k.tags).size !== k.tags.length)) errs.push(`${w}: tags must be distinct lower-case words ('london')`);
    if (k.landmark !== undefined && typeof k.landmark !== 'boolean') errs.push(`${w}: landmark must be true or false`);
    if (k.landmark) errs.push(...landmarkErrors(k, w));
    if (!Array.isArray(k.levels) || k.levels.length === 0) { errs.push(`${w}: needs at least one level`); continue; }
    const minLevel = k.minLevel ?? 1;
    if (!Number.isInteger(minLevel) || minLevel < 1 || minLevel > MAX_LEVEL_CODE) errs.push(`${w}: minLevel ${k.minLevel} outside 1-${MAX_LEVEL_CODE}`);
    else if (minLevel > 1 && !k.flags?.growable) errs.push(`${w}: only growable kinds may start above level 1 (minLevel)`);
    if (minLevel + k.levels.length - 1 > MAX_LEVEL_CODE) errs.push(`${w}: ${k.levels.length} levels from level ${minLevel}; the tile's 3-bit level field holds at most ${MAX_LEVEL_CODE}`);
    k.levels.forEach((l, li) => {
      const lw = `${w} level ${minLevel + li}`;
      const get = <K extends 'capacity' | 'wage' | 'upkeep' | 'cost' | 'work'>(f: K) => l[f] ?? k[f];
      const need = (f: 'capacity' | 'wage' | 'upkeep' | 'cost' | 'work', required: boolean) => {
        const v = get(f);
        if (v === undefined) { if (required) errs.push(`${lw}: missing ${f}`); return; }
        if (!isNum(v) || v < 0) errs.push(`${lw}: ${f} must be a non-negative number`);
        else if ((f === 'capacity' || f === 'work') && (!Number.isInteger(v) || v > INT16)) errs.push(`${lw}: ${f} must be an integer up to ${INT16}`);
      };
      need('capacity', true); need('work', true);
      need('wage', !!k.flags?.workplace);
      need('cost', !k.flags?.growable);
      need('upkeep', !!(k.flags?.civic || k.flags?.parking));
      const pk = l.parking ?? k.parking;
      if (!pk) errs.push(`${lw}: missing parking { surface, underground }`);
      else for (const f of ['surface', 'underground'] as const) if (!Number.isInteger(pk[f]) || pk[f] < 0 || pk[f] > INT16) errs.push(`${lw}: parking.${f} must be a non-negative integer`);
      if (l.feature !== undefined && !techFor(l.feature)) errs.push(`${lw}: feature '${l.feature}' is not unlocked by any tech node (shared/src/tech.ts)`);
      if (!Array.isArray(l.designs) || !l.designs.length) { errs.push(`${lw}: needs at least one design`); return; }
      if (!l.designs.some((d) => !d.draft) && !(k.landmark && k.draft)) errs.push(`${lw}: every design is a draft; at least one must be live`); // a draft landmark (landmark-drafts.ts) is all drafts until it is accepted
      l.designs.forEach((d, di) => {
        checkDesign(d, `${lw} design ${di} (${d?.name ?? '?'})`, errs, k.windows);
        const req = REQUIRED_ATTRS[k.family];
        if (!req) return;
        const a = mergeAttrs(k, l, d);
        for (const [f, t] of Object.entries(req)) {
          const v = a[f];
          if (v === undefined) errs.push(`${lw} design ${di}: ${k.family} attribute '${f}' missing (set it on the kind, level or design)`);
          else if (t === 'hours' ? !(Array.isArray(v) && v.length === 2 && v.every((h) => isNum(h) && h >= 0 && h <= 24)) : typeof v !== t) errs.push(`${lw} design ${di}: attribute '${f}' must be ${t === 'hours' ? '[open, close] hours 0-24' : `a ${t}`}`);
        }
        if (k.family === 'leisure') checkLeisure(k, a, `${lw} design ${di}`, errs);
      });
    });
  }
  errs.push(...groupErrors(kinds));
  for (const [code, id] of subFamilies) if (!bases.has(code)) errs.push(`kind '${id}': family code ${code} has no base kind (a tile with sub byte 0 must mean something)`);
  const hk = new Set<string>();
  for (const h of helpers) {
    if (hk.has(h.key)) errs.push(`helper model '${h.key}': duplicate key`); hk.add(h.key);
    checkDesign({ name: h.key, height: h.height, ops: h.ops }, `helper model '${h.key}'`, errs);
  }
  return errs;
}

/** Mark kinds a footprint may declare (schema.ts MarkKind). */
export const MARK_KINDS = ['door', 'gate', 'platform', 'apron', 'stand', 'dock', 'quay', 'berth'] as const;
export const MARK_EDGES = ['front', 'back', 'left', 'right'] as const;

/** Problems with a footprint's `marks`: known kinds, tiles inside the footprint, edge ranges along the edge. */
export function footprintMarkErrors(f: { w: number; h: number; marks?: unknown }, where: string): string[] {
  const errs: string[] = [];
  if (!Array.isArray(f.marks)) return [`${where}: footprint marks must be an array`];
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  f.marks.forEach((m: any, i) => {
    const mw = `${where}: footprint mark ${i + 1}`;
    if (!m || typeof m !== 'object') { errs.push(`${mw} must be an object`); return; }
    if (!(MARK_KINDS as readonly string[]).includes(m.kind)) errs.push(`${mw}: unknown kind '${m.kind}' (${MARK_KINDS.join(', ')})`);
    if (m.label !== undefined && (typeof m.label !== 'string' || !m.label || m.label.length > 40)) errs.push(`${mw}: label must be a short non-empty string`);
    const at = m.at;
    if (Array.isArray(at)) {
      if (at.length !== 2 || !int(at[0], 0, f.w - 1) || !int(at[1], 0, f.h - 1)) errs.push(`${mw}: tile ${JSON.stringify(at)} is outside the ${f.w}×${f.h} footprint`);
    } else if (at && typeof at === 'object') {
      if (!(MARK_EDGES as readonly string[]).includes(at.edge)) { errs.push(`${mw}: unknown edge '${at.edge}' (${MARK_EDGES.join(', ')})`); return; }
      const along = at.edge === 'front' || at.edge === 'back' ? f.w : f.h, across = at.edge === 'front' || at.edge === 'back' ? f.h : f.w;
      const from = at.from ?? 0, to = at.to ?? along - 1;
      if (!int(from, 0, along - 1) || !int(to, 0, along - 1) || from > to) errs.push(`${mw}: tiles ${from}..${to} are outside the ${along} tiles of the ${at.edge} edge`);
      if (at.depth !== undefined && !int(at.depth, 0, across)) errs.push(`${mw}: depth ${at.depth} is outside 0-${across}`);
    } else errs.push(`${mw}: 'at' must be a tile [dx, dy] or { edge, from?, to?, depth? }`);
  });
  return errs;
}

/**
 * Landmarks (docs/buildings.md "Landmarks"): a placed civic kind with a tool, at least one tag, a rung of a collection
 * group, and a tool that only a `locked` tech node unlocks, so a live game cannot place it before its unlock rule is decided.
 */
function landmarkErrors(k: KindDef, w: string): string[] {
  const errs: string[] = [];
  if (!k.flags?.civic) errs.push(`${w}: a landmark is placed by a player and built by builders: it needs the civic flag`);
  if (!k.tags?.length) errs.push(`${w}: a landmark needs tags (its city, e.g. ['london'])`);
  if (k.draft) {
    // the draft path (docs/landmarks.md, landmark-drafts.ts): viewer only, so no tool, collection rung or tech node yet; a reserved id range and the 'draft' tag instead
    if (k.tool) errs.push(`${w}: a draft landmark has no tool (it is never placed); the tool, collection rung and locked tech node come when it is accepted`);
    if (!k.tags?.includes('draft')) errs.push(`${w}: a draft landmark carries the tag 'draft' (it is what /viewer.html?tag=draft filters by)`);
    if (!Number.isInteger(k.kindId) || (k.kindId as number) < LANDMARK_DRAFT_IDS[0] || (k.kindId as number) > LANDMARK_DRAFT_IDS[1]) errs.push(`${w}: a draft landmark's kindId must be in the reserved range ${LANDMARK_DRAFT_IDS[0]}-${LANDMARK_DRAFT_IDS[1]} (codes.ts)`);
    return errs;
  }
  if (!k.group || !GROUP_BY_ID.get(k.group)?.collection) errs.push(`${w}: a landmark belongs to a collection group (buildings/groups.ts, e.g. 'london')`);
  if (!k.tool) errs.push(`${w}: a landmark needs a tool`);
  else {
    const t = techFor(k.tool.id);
    if (!t?.locked) errs.push(`${w}: a landmark's tool '${k.tool.id}' must be unlocked only by a locked tech node (tech.ts 'lnd1'), so live games cannot place it yet`);
  }
  return errs;
}

/** Tier attributes (schema.ts Attributes, read through shared/src/tiers.ts) and their sane ranges. */
const TIER_ATTRS: Record<string, [number, number]> = { serviceRadius: [1, 40], serviceStrength: [0.1, 2], patrolRate: [0, 6], workRate: [0.25, 4], eventSize: [0.25, 4] };

/**
 * Size ladders (groups.ts): a known group, tiers 1..n with no gaps or repeats, one family code per group, the picker
 * texts, a tool on every rung (its id is the tier's tech feature) and at most one shortcut key per group (the
 * group's key). Tier attributes must be numbers in range wherever they are set.
 */
export function groupErrors(kinds: KindDef[]): string[] {
  const errs: string[] = [];
  const byGroup = new Map<string, KindDef[]>();
  for (const k of kinds) {
    const w = `kind '${k?.id ?? '?'}'`;
    const attrSets = [k.attrs, ...(k.levels ?? []).flatMap((l) => [l.attrs, ...(l.designs ?? []).map((d) => d.attrs)])];
    for (const a of attrSets) for (const [f, [lo, hi]] of Object.entries(TIER_ATTRS)) {
      const v = a?.[f];
      if (v !== undefined && !(isNum(v) && v >= lo && v <= hi)) errs.push(`${w}: attribute '${f}' must be a number ${lo}-${hi}`);
    }
    if (k.group === undefined && k.tier === undefined) continue;
    const g = k.group !== undefined ? GROUP_BY_ID.get(k.group) : undefined;
    if (!g) { errs.push(`${w}: group '${k.group}' unknown (buildings/groups.ts)`); continue; }
    if (!Number.isInteger(k.tier) || (k.tier as number) < 1 || (k.tier as number) > 16) errs.push(`${w}: tier must be an integer 1-16 (1 = the smallest rung)`);
    if (!k.tool) errs.push(`${w}: a rung of the '${k.group}' ladder needs a tool (its id is the tier's tech feature)`);
    if (typeof k.blurb !== 'string' || k.blurb.length < 20) errs.push(`${w}: a grouped kind needs a blurb (a sentence or two for the size picker)`);
    if (typeof k.howTo !== 'string' || k.howTo.length < 20) errs.push(`${w}: a grouped kind needs howTo (how to place it well)`);
    (byGroup.get(k.group!) ?? byGroup.set(k.group!, []).get(k.group!)!).push(k);
  }
  for (const [g, list] of byGroup) {
    const tiers = list.map((k) => k.tier).sort((a, b) => (a ?? 0) - (b ?? 0));
    if (tiers.some((t, i) => t !== i + 1)) errs.push(`group '${g}': tiers must run 1..${list.length} with no gaps or repeats (got ${tiers.join(', ')})`);
    const codes = new Set(list.map((k) => k.code));
    if (codes.size > 1 && !GROUP_BY_ID.get(g)?.collection) errs.push(`group '${g}': every rung must share one family code (got ${[...codes].join(', ')}) so the simulation treats them as one service`);
    const keyed = list.filter((k) => k.tool?.key);
    if (keyed.length > 1) errs.push(`group '${g}': only one rung may carry a shortcut key (the group's key); ${keyed.map((k) => k.id).join(', ')} all do`);
    if (list.some((k) => k.draft) && !list.some((k) => !k.draft) && !GROUP_BY_ID.get(g)?.draft) errs.push(`group '${g}': every rung is a draft`);
  }
  return errs;
}
