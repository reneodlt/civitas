import { MANIFEST, DESIGN_COUNT_TABLE, TOP_LEVEL_TABLE } from './buildings/compiled';
import { LEVEL_SLOTS } from './buildings/codes';
import type { Attributes } from './buildings/schema';
import { hash2 } from './noise';
import { LifeStage } from './protocol';

/**
 * Leisure places as the simulation and the tooltips read them: one flat record per kind, level and live design,
 * built once from the compiled manifest (the leisure family's attributes in buildings/leisure.ts). Behaviour is
 * keyed by these numbers, never by kind id.
 */
import { VENUE_TYPES, type VenueType } from './venueTypes';
export { VENUE_TYPES, UNSTAFFED_VENUES, type VenueType } from './venueTypes';
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
export const VENUE_TYPE_INDEX = Object.fromEntries(VENUE_TYPES.map((t, i) => [t, i])) as Record<VenueType, number>;
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
/**
 * How each type of outing is worded: `at` while there (the activity line, and the first-person view picks its scene by
 * it), `going` on the way, `event` while an event is on, and `eventName` for the tooltip's next event. Children,
 * families and retirees all go to these places, so every line is one a child could read.
 */
export const VENUE_TEXT: Record<VenueType, { at: string; going: string; event: string; eventName: string }> = {
  park: { at: 'in the park', going: 'to the park', event: 'listening to the band in the park', eventName: 'band in the park' },
  cinema: { at: 'at the cinema', going: 'to the cinema', event: 'at a premiere', eventName: 'premiere night' },
  theatre: { at: 'at the theatre', going: 'to the theatre', event: 'watching a performance', eventName: 'performance' },
  sports: { at: 'at the sports hall', going: 'to the sports hall', event: 'watching a match', eventName: 'match night' },
  library: { at: 'at the library', going: 'to the library', event: 'at the quiz night', eventName: 'quiz night' },
  playground: { at: 'at the playground', going: 'to the playground', event: 'at the playground', eventName: '' },
  skatepark: { at: 'at the skate park', going: 'to the skate park', event: 'at the skate jam', eventName: 'skate jam' },
  allotments: { at: 'on the allotment', going: 'to the allotment', event: 'at the harvest show', eventName: 'harvest show' },
  fishing: { at: 'fishing at the lake', going: 'to the fishing lake', event: 'in the fishing match', eventName: 'fishing match' },
  reserve: { at: 'birdwatching at the reserve', going: 'to the nature reserve', event: 'on the dawn chorus walk', eventName: 'dawn chorus walk' },
  lido: { at: 'swimming at the lido', going: 'to the lido', event: 'at the swimming gala', eventName: 'swimming gala' },
  tennis: { at: 'playing tennis', going: 'to the tennis club', event: 'at the club tournament', eventName: 'club tournament' },
  bowling: { at: 'bowling', going: 'to the bowling alley', event: 'at league night', eventName: 'league night' },
  icerink: { at: 'skating at the ice rink', going: 'to the ice rink', event: 'at the ice disco', eventName: 'ice disco' },
  rollerdisco: { at: 'at the roller disco', going: 'to the roller disco', event: 'at the roller disco night', eventName: 'roller disco night' },
  climbing: { at: 'climbing at the wall', going: 'to the climbing centre', event: 'in the bouldering competition', eventName: 'bouldering competition' },
  trampoline: { at: 'at the trampoline park', going: 'to the trampoline park', event: 'at the family bounce', eventName: 'family bounce' },
  karting: { at: 'racing go-karts', going: 'to the go-kart track', event: 'in the kart grand prix', eventName: 'kart grand prix' },
  funfair: { at: 'at the funfair', going: 'to the funfair', event: 'watching the fireworks at the funfair', eventName: 'fireworks night' },
  farm: { at: 'at the city farm', going: 'to the city farm', event: 'at the farm open day', eventName: 'open day' },
  aquarium: { at: 'at the aquarium', going: 'to the aquarium', event: 'watching feeding time at the aquarium', eventName: 'feeding time' },
  planetarium: { at: 'at the planetarium', going: 'to the planetarium', event: 'at the star show', eventName: 'star show' },
  science: { at: 'at the science centre', going: 'to the science centre', event: 'at the science centre late', eventName: 'late opening' },
  observatory: { at: 'at the observatory', going: 'to the observatory', event: 'stargazing at the observatory', eventName: 'stargazing night' },
  gallery: { at: 'at the art gallery', going: 'to the art gallery', event: 'at an exhibition opening', eventName: 'exhibition opening' },
  pottery: { at: 'at a pottery class', going: 'to the pottery studio', event: 'at the open studio', eventName: 'open studio' },
  concert: { at: 'at a concert', going: 'to the concert hall', event: 'at the concert', eventName: 'concert' },
  dancehall: { at: 'dancing at the dance hall', going: 'to the dance hall', event: 'at the tea dance', eventName: 'tea dance' },
  arcade: { at: 'at the arcade', going: 'to the arcade', event: 'at high-score night', eventName: 'high-score night' },
  boardgames: { at: 'playing board games', going: 'to the board-game café', event: 'at the games tournament', eventName: 'games tournament' },
  escape: { at: 'in an escape room', going: 'to the escape room', event: 'in an escape room', eventName: '' },
};
/** Is this attribute value a venue type the game knows? (validation) */
export const isVenueType = (v: unknown): v is VenueType => typeof v === 'string' && (VENUE_TYPES as readonly string[]).includes(v);
/** What an event is called, by venue type. */
export const EVENT_NAMES = Object.fromEntries(VENUE_TYPES.map((t) => [t, VENUE_TEXT[t].eventName])) as Record<VenueType, string>;
/** Wording for activities and destinations, by venue type. */
export const VENUE_WORDS = Object.fromEntries(VENUE_TYPES.map((t) => [t, { at: VENUE_TEXT[t].at, going: VENUE_TEXT[t].going, event: VENUE_TEXT[t].event }])) as Record<VenueType, { at: string; going: string; event: string }>;

/**
 * What someone does on a park visit (docs/leisure.md): a stroll and a sit on a bench, a picnic on the grass (midday to
 * early evening), a kite on the open lawn (by day; children and their parents most) or feeding the ducks where the park
 * has water (the pond, lakeside and botanical parks). Seeded per person and visit so a visit keeps one activity, and
 * worded for the activity line; the first-person view picks its scene by the line. The band's afternoon is the park's event.
 */
export type ParkActivity = 'stroll' | 'picnic' | 'kite' | 'ducks';
export const PARK_ACTIVITY_TEXT: Record<ParkActivity, string> = {
  stroll: 'in the park', picnic: 'having a picnic in the park', kite: 'flying a kite in the park', ducks: 'feeding the ducks in the park',
};
/** Does this park have water to feed ducks on? (a pond or lake path layout, or a lake in the recipe) */
export const parkHasWater = (s: LeisureSpec) => s.paths === 'pond' || s.title === 'lakeside park' || s.title === 'botanical garden';
export function parkActivity(s: LeisureSpec, id: number, since: number, hour: number, stage: number): { id: ParkActivity; at: string } {
  const u = hash2(id * 7 + 3, Math.floor(since / 97) + 11);
  const day = hour >= 9 && hour < 19, lunch = hour >= 11.5 && hour < 18.5;
  const child = stage === LifeStage.Child;
  const opts: [ParkActivity, number][] = [
    ['stroll', 1],
    ['picnic', lunch ? 1.1 : 0],
    ['kite', day ? (child ? 1.4 : 0.5) : 0],
    ['ducks', parkHasWater(s) ? (child ? 1.5 : 0.9) : 0],
  ];
  const total = opts.reduce((a, [, w]) => a + w, 0);
  let pickAt = u * total;
  for (const [a, w] of opts) { if (pickAt < w) return { id: a, at: PARK_ACTIVITY_TEXT[a] }; pickAt -= w; }
  return { id: 'stroll', at: PARK_ACTIVITY_TEXT.stroll };
}
