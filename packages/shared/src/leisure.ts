import { MANIFEST, DESIGN_COUNT_TABLE, TOP_LEVEL_TABLE } from './buildings/compiled';
import { LEVEL_SLOTS } from './buildings/codes';
import type { Attributes } from './buildings/schema';
import { hash2 } from './noise';

/**
 * Leisure places as the simulation and the tooltips read them: one flat record per kind, level and live design,
 * built once from the compiled manifest (the leisure family's attributes in buildings/leisure.ts). Behaviour is
 * keyed by these numbers, never by kind id.
 */
export type VenueType = 'park' | 'cinema' | 'theatre' | 'sports' | 'library';
export interface LeisureSpec {
  kind: number; level: number; design: number;
  type: VenueType;
  /** what a tooltip calls it: 'pocket park', 'cinema', 'community hall' */
  title: string;
  open: number; close: number;
  capacity: number;
  /** leisure value: need restored per visit and weight in the coverage of nearby homes */
  value: number;
  radius: number;
  ticket: number;
  stayMin: number; stayMax: number;
  /** weekdays 0-6 (0 = Monday, as day % 7) */
  eventNights: number[];
  eventStart: number;
  day: number; evening: number; retiree: number; child: number;
  /** venues need someone on the payroll to open; parks need nobody */
  staffed: boolean;
  /** parks: visits a day that make it grow to the next level (0 = top level) */
  upgradeVisits: number;
  /** parks: path layout and how many trees and benches the client scatters */
  paths: string; trees: number; benches: number;
  /** how much harder an event night pulls people in than the usual one (attribute eventSize; bigger venues, bigger nights) */
  eventSize: number;
  /** a block's communal garden (attribute blockOnly): only the homes round its own block count it, and nobody travels to it */
  blockOnly: boolean;
  /**
   * how much of a visit is out of doors, 0-1 (attribute `outdoor`; default 1 for a park, 0 for the rest): the weather's
   * pull on it (docs/weather.md W4, shared weatherfx.ts leisureMul): rain, cold and the dark keep people out, warm dry days bring them
   */
  outdoor: number;
}

const num = (a: Attributes, k: string, d: number) => (typeof a[k] === 'number' ? (a[k] as number) : d);
const pair = (a: Attributes, k: string, d: [number, number]): [number, number] => (Array.isArray(a[k]) && (a[k] as number[]).length === 2 ? (a[k] as [number, number]) : d);

function specOf(kind: number, level: number, design: number, name: string, workplace: boolean, a: Attributes): LeisureSpec {
  const [open, close] = pair(a, 'openHours', [9, 21]);
  const [stayMin, stayMax] = pair(a, 'stay', [1, 2]);
  return {
    kind, level, design, type: String(a.venueType) as VenueType, title: typeof a.title === 'string' ? a.title : name,
    open, close, capacity: num(a, 'visitorCapacity', 10), value: num(a, 'leisureValue', 3), radius: num(a, 'radius', 10),
    ticket: num(a, 'ticket', 0), stayMin, stayMax,
    eventNights: Array.isArray(a.eventNights) ? [...(a.eventNights as number[])] : [],
    eventStart: num(a, 'eventStart', 19.5),
    day: num(a, 'dayAppeal', 1), evening: num(a, 'eveningAppeal', 1), retiree: num(a, 'retireeAppeal', 1), child: num(a, 'childAppeal', 1),
    staffed: workplace, upgradeVisits: num(a, 'upgradeVisits', 0),
    paths: typeof a.paths === 'string' ? a.paths : '', trees: num(a, 'trees', 0), benches: num(a, 'benches', 0),
    eventSize: num(a, 'eventSize', 1), blockOnly: a.blockOnly === true,
    outdoor: Math.max(0, Math.min(1, num(a, 'outdoor', String(a.venueType) === 'park' ? 1 : 0))),
  };
}

/** specs[kindId * LEVEL_SLOTS + level] = one spec per live design, in the order tiles pick them. */
const SPECS: LeisureSpec[][] = [];
/** Family codes that hold leisure kinds, for spatial lookups (World.eachBuiltNear); filter hits with leisureAt(b.id, ...). */
export const LEISURE_CODES: number[] = [];
/** 1 per kind id of the leisure family */
const LEISURE_IDS = new Uint8Array(256);
for (const k of MANIFEST) {
  if (k.family !== 'leisure') continue;
  if (!LEISURE_CODES.includes(k.code)) LEISURE_CODES.push(k.code);
  LEISURE_IDS[k.kindId] = 1;
  for (const l of k.levels) SPECS[k.kindId * LEVEL_SLOTS + l.level] = l.designs.filter((d) => !d.draft).map((d) => specOf(k.kindId, l.level, d.index, k.name, k.flags.workplace, d.attrs));
}
/** The widest catchment of any leisure place, for spatial searches. */
export const LEISURE_MAX_RADIUS = Math.max(0, ...SPECS.flatMap((l) => (l ?? []).map((sp) => sp.radius)));
/** Index of each venue type, for hash-seeded tastes. */
export const VENUE_TYPE_INDEX: Record<VenueType, number> = { park: 0, cinema: 1, theatre: 2, sports: 3, library: 4 };
/** Is this kind id a park or leisure venue? */
export const isLeisure = (kind: number) => LEISURE_IDS[kind] === 1;

/**
 * Which design stands on tile (x, y): the same hash render/chunkView.ts uses to pick a model, so the server
 * reads the attributes of the building the players see (a community hall keeps longer hours than a library).
 */
export const designPick = (x: number, y: number) => hash2(x * 13 + 5, y * 17 + 11);

/** The leisure record for a building of this kind id and level at (x, y); undefined for non-leisure kinds or level 0. */
export function leisureAt(kind: number, level: number, x: number, y: number): LeisureSpec | undefined {
  if (level <= 0 || !isLeisure(kind)) return undefined;
  const lv = Math.min(level, TOP_LEVEL_TABLE[kind] ?? 0);
  const s = kind * LEVEL_SLOTS + lv;
  const list = SPECS[s];
  if (!list?.length) return undefined;
  const n = Math.min(list.length, DESIGN_COUNT_TABLE[s] || list.length);
  return list[Math.min(n - 1, Math.floor(designPick(x, y) * n))];
}
/** Every spec of a kind and level (all live designs), e.g. for checks and the viewer. */
export const leisureSpecs = (kind: number, level: number): readonly LeisureSpec[] => SPECS[kind * LEVEL_SLOTS + level] ?? [];

/** Per-place opening jitter in hours (up to ±20 min), so a town's venues do not all open on the stroke of the hour. */
export const openJitter = (x: number, y: number) => (hash2(x * 7 + 1, y * 3 + 2) - 0.5) * 0.66;
/** Open at this hour of the day (0-24)? */
export function isOpenAt(s: LeisureSpec, hour: number, x: number, y: number): boolean {
  const j = openJitter(x, y);
  return hour >= s.open + j && hour < s.close + (s.close >= 24 ? 0 : j);
}
/** Is `day` (game day) one of this place's event days? */
export const eventOn = (s: LeisureSpec, day: number) => s.eventNights.includes(((day % 7) + 7) % 7);
/** Event start on a given day for this place, with a per-place offset of up to ±15 minutes. */
export const eventStartAt = (s: LeisureSpec, x: number, y: number) => s.eventStart + (hash2(x * 11 + 4, y * 5 + 9) - 0.5) * 0.5;
/** The next event from (day, hour) on: today if it has not started yet, else the next event day. */
export function nextEvent(s: LeisureSpec, day: number, hour: number, x: number, y: number): { day: number; hour: number } | null {
  if (!s.eventNights.length) return null;
  const start = eventStartAt(s, x, y);
  for (let d = 0; d < 8; d++) if (eventOn(s, day + d) && (d > 0 || hour < start + 1)) return { day: day + d, hour: start };
  return null;
}
export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** What an event is called, by venue type. */
export const EVENT_NAMES: Record<VenueType, string> = { park: 'band in the park', cinema: 'premiere night', theatre: 'performance', sports: 'match night', library: 'quiz night' };
/** Wording for activities and destinations, by venue type. */
export const VENUE_WORDS: Record<VenueType, { at: string; going: string; event: string }> = {
  park: { at: 'in the park', going: 'to the park', event: 'listening to the band in the park' },
  cinema: { at: 'at the cinema', going: 'to the cinema', event: 'at a premiere' },
  theatre: { at: 'at the theatre', going: 'to the theatre', event: 'watching a performance' },
  sports: { at: 'at the sports hall', going: 'to the sports hall', event: 'watching a match' },
  library: { at: 'at the library', going: 'to the library', event: 'at the quiz night' },
};
