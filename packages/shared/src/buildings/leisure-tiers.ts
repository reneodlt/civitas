import type { KindDef, Op, Color } from './schema';
import { repeat } from './helpers';
import { cinema, theatre, sports, library } from './leisure';
import { slab, carRow, bayLines, tree, pine, treeLine, flags, fence, lampPost, adBoard, ASPHALT, PAVING } from './tierkit';

/**
 * Size ladders for leisure (groups.ts): parks, cinemas, theatres, sport, libraries and museums. Each rung is a
 * sub-kind of its family code (10-14, kind ids 59-69) and a leisure place like the original kinds: shared/src/leisure.ts
 * reads venueType, visitorCapacity, leisureValue, radius, ticket and the rest from the attributes, plus `eventSize`
 * (how much harder an event night pulls). Bigger rungs hold more people, reach homes further away and draw bigger
 * event crowds. The big parks plant their own trees in the recipe (trees: 0 turns off the client scatter, which is
 * for single tiles). Recipes bigger than 1×1 are authored in tiles for the whole footprint.
 */

const lawn = (w: number, d: number, c: Color = 'lawn'): Op => ['box', w - 0.04, 0.012, d - 0.04, 0, 0, 0, c];
const path = (w: number, d: number, x: number, z: number): Op => ['box', w, 0.004, d, x, 0.012, z, 'gravel'];
/** A pond made of overlapping discs (a lake edge that is not a rectangle). */
const lake = (parts: [number, number, number][]): Op[] => [
  ...parts.map(([x, z, r]): Op => ['cyl', r + 0.04, r + 0.05, 0.016, x, 0.008, z, 'stone', 16]),
  ...parts.map(([x, z, r]): Op => ['cyl', r, r, 0.02, x, 0.01, z, 'pond', 16]),
];
const bench = (x: number, z: number, alongX = true): Op[] => [['box', alongX ? 0.12 : 0.04, 0.02, alongX ? 0.04 : 0.12, x, 0.04, z, 'timber'], ['box', alongX ? 0.12 : 0.012, 0.03, alongX ? 0.012 : 0.12, x, 0.06, z + (alongX ? 0.02 : 0), 'timber']];
/** A floodlight tower: lattice pole and a lamp bank that lights up in the evening (venue windows). */
const floodlight = (x: number, z: number, h: number): Op[] => [
  ['cyl', 0.02, 0.04, h, x, 0, z, 'steel', 5], ['box', 0.2, 0.12, 0.05, x, h, z, 'marquee', 'venue'], ['box', 0.22, 0.02, 0.07, x, h + 0.12, z, 'charcoal'],
];
/** Stepped seating along x (a stand), `rows` steps rising away from the pitch toward -dir*z. */
const stand = (w: number, x: number, z: number, rows: number, dir: 1 | -1, color: Color, y = 0): Op[] =>
  repeat(rows, (i): Op => ['box', w, 0.06 * (i + 1), 0.09, x, y, z - dir * i * 0.09, i % 2 ? color : 'grey']);
const standX = (d: number, x: number, z: number, rows: number, dir: 1 | -1, color: Color, y = 0): Op[] =>
  repeat(rows, (i): Op => ['box', 0.09, 0.06 * (i + 1), d, x - dir * i * 0.09, y, z, i % 2 ? color : 'grey']);

// ================================================================= parks

const parkAttrs = { trees: 0, benches: 0 };

export const lakesidePark: KindDef = {
  id: 'lakeside-park', name: 'lakeside park', code: 10, kindId: 59, family: 'leisure',
  flags: { civic: true, leisureReady: true }, windows: 'shop',
  group: 'park', tier: 2,
  footprint: { w: 3, h: 3, door: [1, 2] },
  blurb: 'Nine tiles of lawns, woods and a boating lake with an island, a boathouse and a bandstand. Far more visitors than any single park, and homes much further away count it.',
  howTo: 'A 3×3 block with the gate in the middle of the frontage. Free to visit; children walk here on their own if it is close to home.',
  tool: { id: 'lakepark', key: '', label: 'Lakeside park', color: '#3f8f6a' },
  attrs: { venueType: 'park', openHours: [6, 22], ticket: 0, stay: [0.8, 2.2], dayAppeal: 1.4, eveningAppeal: 0.4, retireeAppeal: 1.9, childAppeal: 2.2, ...parkAttrs, title: 'lakeside park' },
  cost: 900, work: 900, capacity: 0, parking: { surface: 6, underground: 6 },
  levels: [{
    upkeep: 18, attrs: { visitorCapacity: 80, leisureValue: 10, radius: 16, eventNights: [6], eventStart: 14 },
    designs: [
      { name: 'boating lake with an island, a boathouse, a bandstand and woods', height: 0.4, ops: [
        lawn(3, 3), path(0.16, 1.4, 0, 0.8), path(2.6, 0.12, 0, 0.12), path(0.12, 2.4, -1.2, -0.1),
        ...lake([[0.3, -0.55, 0.62], [0.85, -0.3, 0.4], [-0.15, -0.8, 0.38]]),
        ['cyl', 0.16, 0.18, 0.04, 0.42, 0.012, -0.62, 'lawnDark', 12], ...tree(0.42, -0.62, 0.9),
        ['box', 0.36, 0.2, 0.24, 1.15, 0.012, 0.3, 'timber', true], ['roof', 0.4, 0.1, 0.28, 1.15, 0.212, 0.3, 'green'], ['box', 0.3, 0.02, 0.24, 1.15, 0.02, 0.06, 'timber'],
        ['box', 0.06, 0.02, 0.03, 0.9, 0.032, -0.1, 'white'], ['box', 0.06, 0.02, 0.03, 0.2, 0.032, -0.3, 'red'],
        ['cyl', 0.17, 0.18, 0.05, -0.7, 0.012, 0.7, 'stone', 8],
        ...repeat(6, (i): Op => ['cyl', 0.01, 0.01, 0.17, -0.7 + 0.14 * Math.cos((i * Math.PI) / 3), 0.06, 0.7 + 0.14 * Math.sin((i * Math.PI) / 3), 'white', 4]),
        ['cone', 0.21, 0.09, -0.7, 0.23, 0.7, 'green', 8],
        ...treeLine(-1.38, -1.38, 1.38, -1.38, 9, 0.95), ...treeLine(-1.38, -1.0, -1.38, 1.2, 6, 0.9), ...treeLine(1.38, -1.0, 1.38, -0.1, 3, 0.9),
        ...tree(-0.8, -0.3, 1.0), ...tree(-0.55, 0.0, 0.9), ...pine(0.7, 0.75, 1.0), ...tree(1.1, 1.05, 0.9),
        ...bench(-0.3, 0.22), ...bench(0.5, 0.22), ...bench(-1.05, 0.45, false),
      ] },
      { name: 'country park with a meadow, a long lake and a jetty café', height: 0.36, ops: [
        lawn(3, 3, 'lawnDark'), ['box', 1.2, 0.013, 1.0, 0.7, 0, 0.75, 'lawn'],
        ...lake([[-0.6, -0.4, 0.4], [-0.1, -0.5, 0.42], [0.4, -0.65, 0.38], [0.85, -0.7, 0.3]]),
        path(0.14, 1.0, 0, 1.0), path(2.4, 0.12, 0, 0.42), path(0.12, 0.9, -1.15, -0.1),
        ['box', 0.1, 0.03, 0.5, -0.1, 0.03, -0.1, 'timber'], ...repeat(3, (i): Op => ['cyl', 0.012, 0.012, 0.04, -0.14 + (i % 2) * 0.08, 0.0, -0.25 + i * 0.15, 'timber', 4]),
        ['box', 0.42, 0.18, 0.26, -0.1, 0.012, 0.25, 'cream', true], ['roof', 0.46, 0.1, 0.3, -0.1, 0.192, 0.25, 'terracotta'],
        ['box', 0.2, 0.02, 0.1, -0.1, 0.14, 0.4, 'awning'],
        ...repeat(12, (i): Op => ['cone', 0.03, 0.04, 0.3 + (i % 4) * 0.22, 0.012, 0.5 + Math.floor(i / 4) * 0.22, (['yellow', 'red', 'white', 'plum'] as const)[i % 4], 5]),
        ...[[-1.2, -1.2], [-0.9, -1.25], [-1.25, -0.85], [1.25, -1.25], [1.0, -1.2], [1.3, 0.1], [1.2, 0.4], [-1.3, 0.9], [-1.0, 1.2], [1.25, 1.25]].flatMap(([x, z], i) => (i % 3 ? tree(x, z, 1.0) : pine(x, z, 1.1))),
        ...bench(0.4, 0.3), ...bench(-0.6, 0.3), ...bench(0.9, -0.25),
      ] },
    ],
  }],
};

export const botanicalGarden: KindDef = {
  id: 'botanical-garden', name: 'botanical garden', code: 10, kindId: 60, family: 'leisure',
  flags: { civic: true, leisureReady: true }, windows: 'shop',
  group: 'park', tier: 3,
  footprint: { w: 4, h: 4, door: [2, 3] },
  blurb: 'A great glasshouse of palms, formal beds, an arboretum and a lake garden over a whole block. The finest park in town, worth a trip from anywhere.',
  howTo: 'A 4×4 block; the gate is right of the middle of the frontage. A small entry charge pays towards the upkeep. Late game: needs Landmarks.',
  tool: { id: 'botanic', key: '', label: 'Botanical garden', color: '#2f7f55' },
  attrs: { venueType: 'park', openHours: [8, 20], ticket: 2, stay: [1.2, 3], dayAppeal: 1.6, eveningAppeal: 0.2, retireeAppeal: 2.4, childAppeal: 1.6, ...parkAttrs, title: 'botanical garden', outdoor: 0.6 },
  cost: 2200, work: 1600, capacity: 0, parking: { surface: 10, underground: 16 },
  levels: [{
    upkeep: 34, attrs: { visitorCapacity: 120, leisureValue: 12, radius: 20 },
    designs: [
      { name: 'palm house glasshouse over formal beds, an arboretum and a lake garden', height: 1.1, ops: [
        lawn(4, 4), path(0.18, 1.8, 0.5, 1.0), path(3.4, 0.14, 0, 0.1), path(0.14, 3.4, -1.0, 0),
        ['box', 1.5, 0.06, 0.8, 0.4, 0.012, -1.2, 'stone'],
        ['box', 1.4, 0.4, 0.7, 0.4, 0.07, -1.2, 0xcfe9ee, true], ['roof', 1.44, 0.22, 0.74, 0.4, 0.47, -1.2, 0xbfe0e6],
        ['cyl', 0.3, 0.34, 0.5, 0.4, 0.07, -1.2, 0xd8eef2, 18], ['cone', 0.32, 0.36, 0.4, 0.57, -1.2, 0xbfe0e6, 18], ['cyl', 0.02, 0.02, 0.08, 0.4, 0.93, -1.2, 'white', 6],
        ...repeat(7, (i): Op => ['box', 0.015, 0.4, 0.72, -0.24 + i * 0.213, 0.07, -1.2, 'white']), ['box', 1.42, 0.02, 0.72, 0.4, 0.47, -1.2, 'white'],
        ...repeat(4, (i): Op => ['box', 0.36, 0.035, 0.3, -0.3 + (i % 2) * 0.56 + 0.4, 0.012, -0.32 + Math.floor(i / 2) * 0.62 - 0.12, 'lawnDark']),
        ...repeat(16, (i): Op => ['cone', 0.035, 0.05, 0.13 + (i % 4) * 0.18, 0.045, -0.5 + Math.floor(i / 4) * 0.3, (['red', 'yellow', 'plum', 'white'] as const)[(i + Math.floor(i / 4)) % 4], 5]),
        ['cyl', 0.16, 0.17, 0.05, 0.4, 0.012, 0.1, 'stone', 12], ['cyl', 0.13, 0.13, 0.052, 0.4, 0.012, 0.1, 'pond', 12], ['cone', 0.02, 0.1, 0.4, 0.06, 0.1, 0xcfe8ff, 6],
        ...lake([[1.3, 0.9, 0.42], [1.5, 0.4, 0.3]]), ['box', 0.12, 0.03, 0.4, 1.35, 0.03, 0.65, 'timber'],
        ...[[-1.6, -1.6], [-1.3, -1.2], [-1.6, -0.7], [-1.35, -0.2], [-1.6, 0.4], [-1.3, 0.9], [-1.6, 1.4], [-0.6, 1.5], [-0.3, 1.2], [1.65, -1.65], [1.65, -0.9], [-0.6, -1.65]].flatMap(([x, z], i) => (i % 2 ? pine(x, z, 1.2) : tree(x, z, 1.15, i % 4 ? 'hedge' : 0x7a9c3a))),
        ['box', 0.5, 0.3, 0.05, 0.5, 0.012, 1.92, 'stone'], ['box', 0.3, 0.22, 0.06, 0.5, 0.012, 1.92, 'door'], ['box', 0.54, 0.04, 0.07, 0.5, 0.32, 1.92, 'gold'],
        ...fence(-0.8, 1.94, 2.2, true, 'hedge', 0.07), ...fence(1.4, 1.94, 0.9, true, 'hedge', 0.07),
      ] },
      { name: 'walled garden with a domed conservatory, a rock garden and a long canal', height: 1.0, ops: [
        lawn(4, 4, 'lawnDark'),
        ...[[0, -1.92, 3.9, 0.08], [0, 1.92, 1.4, 0.08]].map(([x, z, w, d]): Op => ['box', w, 0.14, d, x, 0.012, z, 'brick']),
        ['box', 0.08, 0.14, 3.9, -1.92, 0.012, 0, 'brick'], ['box', 0.08, 0.14, 3.9, 1.92, 0.012, 0, 'brick'],
        ['box', 0.16, 0.024, 2.6, 0, 0.012, 0.0, 'stone'], ['box', 0.12, 0.026, 2.5, 0, 0.012, 0.0, 'pond'],
        path(3.4, 0.14, 0, -0.8), path(3.4, 0.14, 0, 0.8), path(0.16, 0.6, 0, 1.6),
        ['cyl', 0.5, 0.52, 0.4, -0.95, 0.012, -1.2, 'glass', 20], ['cone', 0.5, 0.42, -0.95, 0.41, -1.2, 'glass', 20], ['cyl', 0.03, 0.03, 0.1, -0.95, 0.83, -1.2, 'gold', 6],
        ['box', 0.6, 0.3, 0.3, -0.95, 0.012, -0.72, 'white', true],
        ...repeat(7, (i): Op => ['cone', 0.08 + (i % 3) * 0.03, 0.06 + (i % 2) * 0.05, 0.6 + (i % 4) * 0.25, 0.012, -1.4 + Math.floor(i / 4) * 0.35, 'grey', 5]),
        ...repeat(5, (i): Op => ['cone', 0.04, 0.12, 0.6 + i * 0.24, 0.05, -1.05, 'green', 6]),
        ...repeat(18, (i): Op => ['cone', 0.04, 0.05, -1.6 + (i % 6) * 0.22, 0.012, 0.25 + Math.floor(i / 6) * 0.18, (['red', 'yellow', 'plum', 'white', 'awning', 'yellow'] as const)[i % 6], 5]),
        ...repeat(18, (i): Op => ['cone', 0.04, 0.05, 0.5 + (i % 6) * 0.22, 0.012, 0.25 + Math.floor(i / 6) * 0.18, (['white', 'plum', 'red', 'yellow', 'white', 'awning'] as const)[i % 6], 5]),
        ...treeLine(-1.6, 1.4, -0.6, 1.4, 4, 1.0), ...treeLine(0.6, 1.4, 1.6, 1.4, 4, 1.0), ...pine(1.55, -1.55, 1.2), ...pine(1.55, -0.3, 1.1),
        ['box', 0.4, 0.34, 0.1, 0, 0.012, 1.9, 'stone'], ['box', 0.24, 0.26, 0.11, 0, 0.012, 1.9, 'door'], ['roof', 0.44, 0.12, 0.14, 0, 0.352, 1.9, 'slate'],
      ] },
    ],
  }],
};

// ================================================================= cinemas

export const cafeCinema: KindDef = {
  id: 'cafe-cinema', name: 'café cinema', code: 11, kindId: 61, family: 'leisure',
  flags: { civic: true, workplace: true, leisureReady: true }, windows: 'venue',
  group: 'cinema', tier: 1,
  blurb: 'A single screen of forty seats behind a café bar: films with a glass of wine. Small, cheap to run and good for a neighbourhood.',
  howTo: 'One tile on a street with shops. Ticket sales are taxed in your parcel like a bar.',
  tool: { id: 'cafecinema', key: '', label: 'Café cinema', color: '#c55a63' },
  occupation: { ...cinema.occupation!, name: 'café cinema staff' },
  attrs: { ...cinema.attrs, visitorCapacity: 14, ticket: 6, leisureValue: 3, radius: 10, openHours: [11, 24], eventSize: 0.8, dayAppeal: 0.5, eventNights: [4], title: 'café cinema' },
  lot: { wage: 13 },
  levels: [{
    capacity: 3, wage: 13, cost: 350, upkeep: 6, work: 200, parking: { surface: 2, underground: 6 },
    designs: [
      { name: 'corner café cinema with a striped awning and a lit name board', height: 0.62, ops: [
        slab(1, 1, PAVING),
        ['box', 0.8, 0.5, 0.64, 0, 0.02, -0.1, 'brick', true], ['box', 0.82, 0.03, 0.66, 0, 0.52, -0.1, 'dark'],
        ['box', 0.56, 0.2, 0.02, -0.08, 0.02, 0.225, 'glass'], ...repeat(6, (i): Op => ['box', 0.1, 0.02, 0.16, -0.33 + i * 0.1, 0.24, 0.3, i % 2 ? 'cream' : 'red']),
        ['box', 0.5, 0.08, 0.03, -0.08, 0.36, 0.235, 'marquee', 'venue'], ['box', 0.4, 0.03, 0.032, -0.08, 0.38, 0.235, 'red'],
        ...repeat(2, (i): Op => ['cyl', 0.05, 0.05, 0.01, -0.25 + i * 0.3, 0.1, 0.38, 'white', 8]), ...repeat(2, (i): Op => ['cyl', 0.008, 0.008, 0.08, -0.25 + i * 0.3, 0.02, 0.38, 'charcoal', 4]),
        ['box', 0.14, 0.22, 0.02, 0.3, 0.06, 0.225, 'plum'],
      ] },
      { name: 'converted chapel cinema with a rose window and a poster case', height: 0.84, ops: [
        slab(1, 1, 'gravel'),
        ['box', 0.56, 0.44, 0.76, 0, 0.02, -0.06, 'stone', true], ['roof', 0.6, 0.3, 0.8, 0, 0.46, -0.06, 'slate', true],
        ['cyl', 0.08, 0.08, 0.02, 0, 0.5, 0.32, 'marquee', 12], ['box', 0.18, 0.24, 0.02, 0, 0.02, 0.325, 'door'],
        ['box', 0.12, 0.66, 0.12, -0.34, 0.02, 0.26, 'stone'], ['cone', 0.08, 0.16, -0.34, 0.68, 0.26, 'slate', 4],
        ['box', 0.2, 0.26, 0.03, 0.34, 0.06, 0.38, 'charcoal'], ['box', 0.16, 0.2, 0.032, 0.34, 0.09, 0.38, 'yellow'],
        ['box', 0.44, 0.06, 0.03, 0, 0.3, 0.34, 'marquee', 'venue'],
      ] },
    ],
  }],
};

export const multiplex: KindDef = {
  id: 'multiplex', name: 'multiplex', code: 11, kindId: 62, family: 'leisure',
  flags: { civic: true, workplace: true, leisureReady: true }, windows: 'venue',
  group: 'cinema', tier: 3,
  footprint: { w: 2, h: 2, door: [1, 1] },
  blurb: 'Ten screens, an IMAX and a car park full on a Friday. Three times a cinema\'s audience from twice as far, and premieres that draw a crowd.',
  howTo: 'A 2×2 lot on a main road; it brings evening traffic, so give it parking nearby. Needs Big nights out.',
  tool: { id: 'multiplex', key: '', label: 'Multiplex', color: '#a3323e' },
  occupation: cinema.occupation,
  attrs: { ...cinema.attrs, visitorCapacity: 90, ticket: 9, leisureValue: 6, radius: 20, eventSize: 1.4, eventNights: [3, 4, 5], title: 'multiplex' },
  lot: { wage: 14 },
  levels: [{
    capacity: 14, wage: 14, cost: 1800, upkeep: 30, work: 650, parking: { surface: 16, underground: 40 },
    designs: [
      { name: 'dark screen box with a glass foyer, a poster wall and a sign blade', height: 1.3, ops: [
        slab(2, 2, ASPHALT),
        ['box', 1.7, 0.86, 1.1, 0, 0.02, -0.4, 'charcoal'], ['box', 1.72, 0.08, 1.12, 0, 0.7, -0.4, 'red', true], ['box', 1.72, 0.03, 1.12, 0, 0.88, -0.4, 'dark'],
        ['box', 1.1, 0.42, 0.36, -0.2, 0.02, 0.33, 'glass', true], ['box', 1.14, 0.04, 0.4, -0.2, 0.44, 0.33, 'silver'],
        ...repeat(6, (i): Op => ['box', 0.16, 0.24, 0.012, -0.72 + i * 0.22, 0.4, 0.156, (['red', 'yellow', 'signBlue', 'plum', 'marquee', 'boxOrange'] as const)[i]]),
        ['box', 0.12, 1.24, 0.3, 0.7, 0.02, 0.3, 'red', true], ...repeat(7, (i): Op => ['box', 0.125, 0.06, 0.22, 0.7, 0.4 + i * 0.12, 0.3, 'marquee']),
        ...bayLines(-0.9, 0.8, 7, 0.2, 0.3), ...carRow(-0.8, 0.8, 7, 0.2, false, 0.02, 2),
      ] },
      { name: 'leisure box with a curved glass front and neon bands', height: 1.06, ops: [
        slab(2, 2, PAVING),
        ['box', 1.8, 0.8, 1.0, 0, 0.02, -0.45, 'silver'], ['box', 1.82, 0.05, 1.02, 0, 0.82, -0.45, 'dark'],
        ['cyl', 0.6, 0.6, 0.62, -0.2, 0.02, 0.1, 'glass', 20], ['cyl', 0.62, 0.62, 0.04, -0.2, 0.64, 0.1, 'plum', 20],
        ...repeat(3, (i): Op => ['box', 1.82, 0.025, 1.02, 0, 0.28 + i * 0.18, -0.45, (['plum', 'signBlue', 'marquee'] as const)[i], 'venue']),
        ['box', 0.8, 0.14, 0.04, 0.3, 0.88, 0.04, 'marquee', 'venue'], ['box', 0.6, 0.06, 0.045, 0.3, 0.92, 0.04, 'plum'],
        ...carRow(0.55, 0.55, 2, 0.2, false, 0.02, 1), ...carRow(0.55, 0.85, 2, 0.2, false, 0.02, 3),
        ...tree(-0.88, 0.85, 0.8), ...tree(0.88, -0.88, 0.8),
      ] },
    ],
  }],
};

// ================================================================= theatres

export const studioTheatre: KindDef = {
  id: 'studio-theatre', name: 'studio theatre', code: 12, kindId: 63, family: 'leisure',
  flags: { civic: true, workplace: true, leisureReady: true }, windows: 'venue',
  group: 'theatre', tier: 1,
  blurb: 'A black-box studio of eighty seats for new writing and comedy nights. Cheaper than a playhouse and a reason for a neighbourhood to go out.',
  howTo: 'One tile near cafés and bars. Performance nights pull people from a little further than a café cinema.',
  tool: { id: 'studiotheatre', key: '', label: 'Studio theatre', color: '#8a4e9e' },
  occupation: theatre.occupation,
  attrs: { ...theatre.attrs, visitorCapacity: 18, ticket: 10, leisureValue: 4, radius: 12, eventSize: 0.8, eventNights: [3, 5], title: 'studio theatre' },
  lot: { wage: 17 },
  levels: [{
    capacity: 5, wage: 17, cost: 600, upkeep: 10, work: 200, parking: { surface: 2, underground: 6 },
    designs: [
      { name: 'warehouse studio with a black box, a neon sign and a fire escape', height: 0.74, ops: [
        slab(1, 1, PAVING),
        ['box', 0.82, 0.6, 0.66, 0, 0.02, -0.1, 'brick', true], ['box', 0.84, 0.03, 0.68, 0, 0.62, -0.1, 'dark'],
        ['box', 0.5, 0.5, 0.4, 0.08, 0.02, -0.18, 'charcoal'], ['box', 0.52, 0.05, 0.42, 0.08, 0.6, -0.18, 'charcoal'],
        ['box', 0.06, 0.4, 0.2, -0.43, 0.14, 0.0, 'steel'], ...repeat(4, (i): Op => ['box', 0.08, 0.008, 0.2, -0.43, 0.16 + i * 0.1, 0.0, 'dark']),
        ['box', 0.3, 0.1, 0.03, 0.08, 0.42, 0.245, 'plum', 'venue'], ['box', 0.22, 0.04, 0.032, 0.08, 0.45, 0.245, 'marquee'],
        ['box', 0.18, 0.22, 0.02, 0.08, 0.02, 0.235, 'door'], ...repeat(2, (i): Op => ['box', 0.1, 0.16, 0.02, -0.2 + i * 0.56, 0.08, 0.24, 'yellow']),
      ] },
      { name: 'fringe theatre over a corner pub, with a hanging sign', height: 0.78, ops: [
        slab(1, 1, 'gravel'),
        ['box', 0.76, 0.32, 0.6, -0.04, 0.02, -0.12, 'green', true], ['box', 0.76, 0.34, 0.6, -0.04, 0.34, -0.12, 'cream', true],
        ['roof', 0.8, 0.12, 0.64, -0.04, 0.68, -0.12, 'slate'], ['box', 0.78, 0.04, 0.62, -0.04, 0.34, -0.12, 'gold'],
        ['cyl', 0.008, 0.008, 0.16, 0.36, 0.24, 0.19, 'charcoal', 4], ['box', 0.12, 0.012, 0.012, 0.32, 0.4, 0.19, 'charcoal'], ['box', 0.1, 0.12, 0.012, 0.3, 0.28, 0.19, 'plum'],
        ['box', 0.4, 0.07, 0.02, -0.1, 0.5, 0.185, 'marquee', 'venue'], ...repeat(2, (i): Op => ['box', 0.08, 0.05, 0.08, -0.3 + i * 0.4, 0.02, 0.32, 'hedge']),
      ] },
    ],
  }],
};

export const operaHouse: KindDef = {
  id: 'opera-house', name: 'opera house', code: 12, kindId: 64, family: 'leisure',
  flags: { civic: true, workplace: true, leisureReady: true }, windows: 'venue',
  group: 'theatre', tier: 3,
  footprint: { w: 3, h: 3, door: [1, 2] },
  blurb: 'A grand house for opera and ballet with a fly tower, a colonnade and a piazza. Gala nights fill it from all over the city; tickets are dear and worth it.',
  howTo: 'A 3×3 block with the doors in the middle of the frontage and the piazza in front. Late game: needs Landmarks.',
  tool: { id: 'opera', key: '', label: 'Opera house', color: '#5e2a72' },
  occupation: { ...theatre.occupation!, name: 'opera house staff' },
  attrs: { ...theatre.attrs, visitorCapacity: 160, ticket: 24, leisureValue: 10, radius: 24, eventSize: 1.8, eventNights: [2, 4, 5], stay: [2.8, 3.6], retireeAppeal: 1.6, title: 'opera house' },
  lot: { wage: 20 },
  levels: [{
    capacity: 30, wage: 20, cost: 4800, upkeep: 70, work: 1300, parking: { surface: 20, underground: 50 },
    designs: [
      { name: 'classical opera house with a fly tower, a colonnade and a fountain piazza', height: 1.86, ops: [
        slab(3, 3, PAVING),
        ['box', 2.4, 0.9, 1.6, 0, 0.02, -0.5, 'stone', true], ['box', 2.42, 0.04, 1.62, 0, 0.92, -0.5, 'roofGrey'], ['box', 2.44, 0.05, 1.64, 0, 0.8, -0.5, 'gold'],
        ['box', 1.2, 1.8, 0.8, 0, 0.02, -0.75, 'stone'], ['box', 1.22, 0.05, 0.82, 0, 1.82, -0.75, 'dark'],
        ['cyl', 0.36, 0.36, 0.14, 0, 0.97, -0.1, 'stone', 16], ['cyl', 0.08, 0.36, 0.3, 0, 1.11, -0.1, 0x6f8f7a, 16], ['cyl', 0.03, 0.03, 0.1, 0, 1.41, -0.1, 'gold', 6],
        ['box', 2.0, 0.05, 0.4, 0, 0.02, 0.5, 'white'], ...repeat(8, (i): Op => ['cyl', 0.04, 0.045, 0.62, -0.84 + i * 0.24, 0.07, 0.48, 'white', 8]),
        ['box', 2.0, 0.08, 0.3, 0, 0.69, 0.48, 'white'], ['roof', 2.0, 0.2, 0.3, 0, 0.77, 0.48, 'white'],
        ...repeat(3, (i): Op => ['box', 0.22, 0.34, 0.02, -0.4 + i * 0.4, 0.07, 0.305, 'door']),
        ['cyl', 0.22, 0.23, 0.05, 0, 0.02, 1.05, 'stone', 16], ['cyl', 0.19, 0.19, 0.052, 0, 0.02, 1.05, 'pond', 16], ['cone', 0.03, 0.14, 0, 0.07, 1.05, 0xcfe8ff, 6],
        ...lampPost(-0.7, 1.05, 0.34, 'marquee'), ...lampPost(0.7, 1.05, 0.34, 'marquee'), ...flags(-1.2, 0.85, 3, 0.2, ['plum', 'gold', 'plum'], 0.02),
        ...tree(-1.3, 1.3, 0.85), ...tree(1.3, 1.3, 0.85),
      ] },
      { name: 'harbour-style opera house of stacked white shells on a stepped podium', height: 1.62, ops: [
        slab(3, 3, 'stone'),
        ['box', 2.6, 0.18, 2.2, 0, 0.02, -0.3, 'stone'], ...repeat(4, (i): Op => ['box', 1.6, 0.045 * (i + 1), 0.1, 0, 0.02, 0.98 - i * 0.1, 'white']),
        ['box', 2.2, 0.4, 1.6, 0, 0.2, -0.4, 'glassDark', true],
        ['roof', 1.0, 1.3, 0.7, -0.55, 0.2, -0.75, 'white', true], ['roof', 0.9, 1.1, 0.6, -0.55, 0.2, -0.15, 'white', true], ['roof', 0.7, 0.8, 0.5, -0.55, 0.2, 0.3, 'white', true],
        ['roof', 0.9, 1.4, 0.7, 0.5, 0.2, -0.8, 'white', true], ['roof', 0.8, 1.15, 0.6, 0.5, 0.2, -0.2, 'white', true], ['roof', 0.6, 0.85, 0.5, 0.5, 0.2, 0.25, 'white', true],
        ['box', 0.8, 0.12, 0.04, 0, 0.3, 0.42, 'marquee', 'venue'],
        ...lampPost(-1.2, 1.2, 0.34, 'marquee'), ...lampPost(1.2, 1.2, 0.34, 'marquee'), ...lampPost(-1.2, 0.2, 0.34, 'marquee'), ...lampPost(1.2, 0.2, 0.34, 'marquee'),
      ] },
    ],
  }],
};

// ================================================================= sport

export const leisureCentre: KindDef = {
  id: 'leisure-centre', name: 'leisure centre', code: 13, kindId: 65, family: 'leisure',
  flags: { civic: true, workplace: true, leisureReady: true }, windows: 'venue',
  group: 'sports', tier: 2,
  footprint: { w: 2, h: 2, door: [1, 1] },
  blurb: 'A swimming pool, a sports hall and a gym under one roof. Busy from the early swim to the evening classes, with galas on match nights.',
  howTo: 'A 2×2 lot beside homes and schools: children and families love it. Needs Theatre (the third Culture tier).',
  tool: { id: 'leisurecentre', key: '', label: 'Leisure centre', color: '#2a86c8' },
  occupation: sports.occupation,
  attrs: { ...sports.attrs, visitorCapacity: 60, ticket: 5, leisureValue: 6, radius: 16, eventSize: 1.1, openHours: [6, 22], dayAppeal: 0.9, childAppeal: 1.8, retireeAppeal: 0.9, title: 'leisure centre' },
  lot: { wage: 14 },
  levels: [{
    capacity: 12, wage: 14, cost: 1500, upkeep: 26, work: 600, parking: { surface: 10, underground: 24 },
    designs: [
      { name: 'glazed pool hall beside a sports hall, with a flume tower', height: 1.0, ops: [
        slab(2, 2, PAVING),
        ['box', 1.0, 0.44, 1.5, -0.42, 0.02, -0.15, 'glass', true], ['roof', 1.04, 0.2, 1.54, -0.42, 0.46, -0.15, 'glass', true],
        ['box', 0.8, 0.03, 1.1, -0.42, 0.02, -0.2, 'pond'], ...repeat(5, (i): Op => ['box', 0.006, 0.032, 1.1, -0.74 + i * 0.16, 0.02, -0.2, 'white']),
        ['box', 0.76, 0.56, 1.3, 0.55, 0.02, -0.3, 'silver', true], ['roof', 0.8, 0.18, 1.34, 0.55, 0.58, -0.3, 'corrugated', true], ['box', 0.77, 0.05, 1.31, 0.55, 0.3, -0.3, 'boxBlue'],
        ['cyl', 0.1, 0.1, 0.96, 0.05, 0.02, -0.85, 'yellow', 10], ['cyl', 0.06, 0.06, 0.4, -0.08, 0.5, -0.75, 'boxOrange', 8],
        ['box', 0.6, 0.3, 0.3, 0.4, 0.02, 0.62, 'boxBlue', true], ['box', 0.64, 0.03, 0.34, 0.4, 0.32, 0.62, 'dark'], ['box', 0.4, 0.08, 0.03, 0.4, 0.22, 0.78, 'white'],
        ...carRow(-0.8, 0.8, 4, 0.18, false, 0.02, 1),
      ] },
      { name: 'open-air lido with deck chairs, a diving board and a gym block', height: 0.66, attrs: { outdoor: 0.8 }, ops: [
        slab(2, 2, 'stone'),
        ['box', 1.3, 0.024, 0.9, -0.2, 0.02, -0.3, 'white'], ['box', 1.2, 0.03, 0.8, -0.2, 0.02, -0.3, 'pond'],
        ...repeat(6, (i): Op => ['box', 1.2, 0.032, 0.006, -0.2, 0.02, -0.65 + i * 0.14, 'white']),
        ['box', 0.06, 0.24, 0.06, -0.86, 0.02, -0.3, 'steel'], ['box', 0.2, 0.012, 0.04, -0.78, 0.26, -0.3, 'white'],
        ...repeat(8, (i): Op => ['box', 0.06, 0.02, 0.12, -0.75 + i * 0.16, 0.04, 0.3, (['red', 'yellow', 'signBlue', 'white'] as const)[i % 4]]),
        ['box', 0.5, 0.5, 1.6, 0.7, 0.02, -0.1, 'cream', true], ['box', 0.52, 0.04, 1.62, 0.7, 0.52, -0.1, 'boxBlue'],
        ...repeat(3, (i): Op => ['cyl', 0.1, 0.1, 0.01, -0.6 + i * 0.4, 0.22, 0.55, (['red', 'white', 'signBlue'] as const)[i], 10]), ...repeat(3, (i): Op => ['cyl', 0.006, 0.006, 0.2, -0.6 + i * 0.4, 0.02, 0.55, 'steel', 4]),
        ...fence(-0.25, 0.92, 1.3, true, 'white', 0.1), ...tree(-0.9, 0.82, 0.8),
      ] },
    ],
  }],
};

export const arena: KindDef = {
  id: 'arena', name: 'arena', code: 13, kindId: 66, family: 'leisure',
  flags: { civic: true, workplace: true, leisureReady: true }, windows: 'venue',
  group: 'sports', tier: 3,
  footprint: { w: 3, h: 3, door: [1, 2] },
  blurb: 'An indoor arena for basketball, ice hockey and concerts, with a big screen outside. Match nights fill it from across town.',
  howTo: 'A 3×3 block with the doors in the middle of the frontage. Event nights bring a rush of traffic, so plan roads and parking. Needs Big nights out.',
  tool: { id: 'arena', key: '', label: 'Arena', color: '#24609f' },
  occupation: { ...sports.occupation!, name: 'arena staff' },
  attrs: { ...sports.attrs, visitorCapacity: 160, ticket: 12, leisureValue: 8, radius: 22, eventSize: 1.6, eventNights: [2, 4, 5], openHours: [10, 24], dayAppeal: 0.3, eveningAppeal: 1.5, title: 'arena' },
  lot: { wage: 15 },
  levels: [{
    capacity: 24, wage: 15, cost: 3200, upkeep: 50, work: 1200, parking: { surface: 20, underground: 50 },
    designs: [
      { name: 'oval arena under a shallow dome with a ring of lights', height: 1.1, ops: [
        slab(3, 3, PAVING),
        ['cyl', 1.15, 1.2, 0.6, 0, 0.02, -0.25, 'silver', 28], ['cyl', 1.17, 1.17, 0.06, 0, 0.5, -0.25, 'marquee', 28],
        ['cyl', 0.5, 1.15, 0.36, 0, 0.62, -0.25, 'roofGrey', 28], ['cyl', 0.4, 0.4, 0.08, 0, 0.98, -0.25, 'silver', 20],
        ['box', 1.0, 0.4, 0.3, 0, 0.02, 0.9, 'glass', true], ['box', 1.04, 0.04, 0.34, 0, 0.42, 0.9, 'boxBlue'],
        ['cyl', 0.03, 0.03, 0.5, 1.1, 0.02, 1.2, 'steel', 5], ['box', 0.4, 0.24, 0.04, 1.1, 0.5, 1.2, 'glassDark', 'venue'],
        ...lampPost(-1.2, 1.2, 0.4, 'white'), ...lampPost(-0.6, 1.3, 0.4, 'white'), ...flags(0.4, 1.3, 3, 0.18, ['boxBlue', 'white', 'boxBlue'], 0.02),
        ...tree(-1.35, -1.35, 0.9), ...tree(1.35, -1.35, 0.9),
      ] },
      { name: 'box arena with a curved roof, glazed concourse and a big screen', height: 1.24, ops: [
        slab(3, 3, ASPHALT),
        ['box', 2.4, 0.62, 1.8, 0, 0.02, -0.5, 'charcoal', true], ['wheel', 0.9, 2.38, 0, 0.2, -0.5, 'silver'], // a barrel roof
        ['box', 2.44, 0.06, 1.84, 0, 0.62, -0.5, 'signBlue', 'venue'],
        ['box', 2.0, 0.34, 0.3, 0, 0.02, 0.56, 'glass', true], ['box', 2.04, 0.04, 0.34, 0, 0.36, 0.56, 'silver'],
        ['box', 0.8, 0.4, 0.04, 0, 0.4, 0.42, 'glassDark', 'venue'],
        ...bayLines(-1.4, 1.1, 14, 0.2, 0.3), ...carRow(-1.3, 1.1, 14, 0.2, false, 0.02, 2),
      ] },
    ],
  }],
};

export const stadium: KindDef = {
  id: 'stadium', name: 'stadium', code: 13, kindId: 67, family: 'leisure',
  flags: { civic: true, workplace: true, leisureReady: true }, windows: 'venue',
  group: 'sports', tier: 4,
  footprint: { w: 4, h: 4, door: [2, 3] },
  blurb: 'A football stadium with four stands and floodlights you can see across the city. Match days are the biggest crowds in town and the busiest roads.',
  howTo: 'A whole 4×4 block with the main gate right of centre. Put it by a main road with parking and, later, rail or buses. Late game: needs Landmarks.',
  tool: { id: 'stadium', key: '', label: 'Stadium', color: '#1f4f88' },
  occupation: { ...sports.occupation!, name: 'stadium staff' },
  attrs: { ...sports.attrs, visitorCapacity: 300, ticket: 18, leisureValue: 10, radius: 24, eventSize: 2.2, eventNights: [5, 6], eventStart: 15, openHours: [10, 23], stay: [2, 3], dayAppeal: 0.4, eveningAppeal: 1.3, retireeAppeal: 0.6, title: 'stadium' },
  lot: { wage: 16 },
  levels: [{
    capacity: 40, wage: 16, cost: 6000, upkeep: 90, work: 2000, parking: { surface: 40, underground: 80 },
    designs: [
      { name: 'four-stand football ground with corner floodlight pylons', height: 2.14, ops: [
        slab(4, 4, ASPHALT),
        ['box', 2.3, 0.02, 1.7, 0, 0.02, -0.2, 'lawn'], ...repeat(6, (i): Op => ['box', 0.36, 0.022, 1.7, -0.95 + i * 0.38, 0.02, -0.2, i % 2 ? 'lawn' : 'lawnDark']),
        ['box', 2.2, 0.024, 0.012, 0, 0.02, -0.2, 'white'], ['cyl', 0.2, 0.2, 0.024, 0, 0.02, -0.2, 'white', 16], ['cyl', 0.19, 0.19, 0.026, 0, 0.02, -0.2, 'lawn', 16],
        ['box', 0.012, 0.024, 1.6, -1.1, 0.02, -0.2, 'white'], ['box', 0.012, 0.024, 1.6, 1.1, 0.02, -0.2, 'white'], ['box', 2.2, 0.024, 0.012, 0, 0.02, -1.0, 'white'], ['box', 2.2, 0.024, 0.012, 0, 0.02, 0.6, 'white'],
        ...stand(2.4, 0, -1.15, 6, 1, 'boxBlue'), ['box', 2.4, 0.04, 0.6, 0, 0.62, -1.4, 'silver'],
        ...stand(2.4, 0, 0.75, 5, -1, 'red'), ['box', 2.4, 0.3, 0.4, 0, 0.02, 1.4, 'charcoal', true],
        ...standX(1.6, -1.25, -0.2, 4, -1, 'boxBlue'), ...standX(1.6, 1.25, -0.2, 4, 1, 'boxBlue'),
        ...floodlight(-1.8, -1.8, 1.9), ...floodlight(1.8, -1.8, 1.9), ...floodlight(-1.8, 1.4, 1.9), ...floodlight(1.8, 1.4, 1.9),
        ...flags(-1.0, 1.75, 6, 0.4, ['boxBlue', 'white'], 0.02), ['box', 0.6, 0.12, 0.04, 0.5, 0.36, 1.62, 'marquee', 'venue'],
        ...adBoard('bannerW', -1.48, 1.78, 'banner', 0.08), ...adBoard('bannerE', 1.48, 1.78, 'banner', 0.08), // banners by the gates (docs/adverts.md)
      ] },
      { name: 'bowl stadium with a running track and a cantilevered roof ring', height: 1.42, ops: [
        slab(4, 4, PAVING),
        ['cyl', 1.75, 1.78, 0.5, 0, 0.02, -0.05, 'grey', 32], ['cyl', 1.4, 1.75, 0.46, 0, 0.06, -0.05, 'red', 32],
        ['cyl', 1.25, 1.25, 0.04, 0, 0.02, -0.05, 'court', 32], ['cyl', 1.07, 1.07, 0.042, 0, 0.02, -0.05, 'white', 32], ['cyl', 1.05, 1.05, 0.045, 0, 0.02, -0.05, 'lawn', 32],
        ['cyl', 1.88, 1.84, 0.06, 0, 1.0, -0.05, 'white', 32], ['cyl', 1.5, 1.5, 0.062, 0, 1.0, -0.05, 'charcoal', 32],
        ...repeat(12, (i): Op => ['cyl', 0.03, 0.04, 0.98, 1.8 * Math.cos((i * Math.PI) / 6), 0.02, -0.05 + 1.8 * Math.sin((i * Math.PI) / 6), 'silver', 5]),
        ...repeat(6, (i): Op => ['box', 0.16, 0.05, 0.05, 1.45 * Math.cos((i * Math.PI) / 3), 1.07, -0.05 + 1.45 * Math.sin((i * Math.PI) / 3), 'marquee', 'venue']),
        ['box', 1.0, 0.3, 0.1, 0.5, 0.02, 1.92, 'glass', true], ...flags(-1.5, 1.88, 3, 0.3, ['red', 'white'], 0.02),
        ...adBoard('bannerW', -0.35, 1.9, 'banner', 0.08), ...adBoard('bannerE', 1.35, 1.9, 'banner', 0.08), // banners either side of the entrance (docs/adverts.md)
      ] },
    ],
  }],
};

// ================================================================= libraries and museums

export const centralLibrary: KindDef = {
  id: 'central-library', name: 'central library', code: 14, kindId: 68, family: 'leisure',
  flags: { civic: true, workplace: true, leisureReady: true }, windows: 'office',
  group: 'library', tier: 2,
  footprint: { w: 2, h: 2, door: [1, 1] },
  blurb: 'Five floors of books, study rooms, a children\'s floor and a roof terrace. Open late and free: retirees and children come from across the district.',
  howTo: 'A 2×2 lot near a high street. Quiz nights on Tuesdays bring an evening crowd. Needs Cinemas and sports halls.',
  tool: { id: 'centrallibrary', key: '', label: 'Central library', color: '#94744a' },
  occupation: library.occupation,
  attrs: { ...library.attrs, visitorCapacity: 50, leisureValue: 5, radius: 16, openHours: [9, 21], eventNights: [1], eventStart: 19, eveningAppeal: 0.6, title: 'central library' },
  lot: { wage: 16 },
  levels: [{
    capacity: 10, wage: 16, cost: 1200, upkeep: 22, work: 600, parking: { surface: 6, underground: 16 },
    designs: [
      { name: 'stacked glass library of offset floors with a roof terrace', height: 1.42, ops: [
        slab(2, 2, PAVING),
        ['box', 1.5, 0.3, 1.3, 0, 0.02, -0.2, 'glass', true], ['box', 1.52, 0.03, 1.32, 0, 0.32, -0.2, 'stone'],
        ['box', 1.3, 0.28, 1.2, 0.12, 0.35, -0.3, 'glass', true], ['box', 1.32, 0.03, 1.22, 0.12, 0.63, -0.3, 'stone'],
        ['box', 1.4, 0.28, 1.1, -0.08, 0.66, -0.25, 'glassDark', true], ['box', 1.42, 0.03, 1.12, -0.08, 0.94, -0.25, 'stone'],
        ['box', 1.1, 0.28, 1.0, 0.1, 0.97, -0.35, 'glass', true], ['box', 1.12, 0.03, 1.02, 0.1, 1.25, -0.35, 'lawnDark'],
        ...tree(-0.15, -0.4, 0.6, 'hedge', 1.28), ...tree(0.35, -0.6, 0.55, 'hedge', 1.28),
        ['box', 1.0, 0.004, 0.36, 0, 0.02, 0.72, 'gravel'], ...repeat(3, (i): Op => ['box', 0.16, 0.04, 0.05, -0.4 + i * 0.4, 0.02, 0.72, 'timber']),
        ...tree(-0.85, 0.75, 0.8), ...tree(0.85, 0.75, 0.8),
      ] },
      { name: 'domed classical library with two wings and a stepped entrance', height: 1.16, ops: [
        slab(2, 2, 'gravel'),
        ['box', 1.7, 0.56, 0.9, 0, 0.02, -0.35, 'stone', true], ['box', 1.72, 0.05, 0.92, 0, 0.58, -0.35, 'cream'],
        ['cyl', 0.3, 0.3, 0.14, 0, 0.63, -0.35, 'stone', 16], ['cyl', 0.08, 0.3, 0.3, 0, 0.77, -0.35, 0x6f8f7a, 16], ['cyl', 0.03, 0.03, 0.08, 0, 1.07, -0.35, 'gold', 6],
        ['box', 0.42, 0.5, 0.5, -0.62, 0.02, 0.3, 'stone', true], ['box', 0.42, 0.5, 0.5, 0.62, 0.02, 0.3, 'stone', true],
        ['box', 0.44, 0.04, 0.52, -0.62, 0.52, 0.3, 'cream'], ['box', 0.44, 0.04, 0.52, 0.62, 0.52, 0.3, 'cream'],
        ...repeat(4, (i): Op => ['box', 0.8, 0.03 * (i + 1), 0.08, 0, 0.02, 0.6 - i * 0.08, 'white']),
        ...repeat(4, (i): Op => ['cyl', 0.03, 0.03, 0.4, -0.3 + i * 0.2, 0.14, 0.18, 'white', 8]), ['box', 0.8, 0.06, 0.14, 0, 0.54, 0.18, 'white'],
        ...tree(-0.88, 0.85, 0.7), ...tree(0.88, 0.85, 0.7),
      ] },
    ],
  }],
};

export const museum: KindDef = {
  id: 'museum', name: 'museum', code: 14, kindId: 69, family: 'leisure',
  flags: { civic: true, workplace: true, leisureReady: true }, windows: 'office',
  group: 'library', tier: 3,
  footprint: { w: 3, h: 2, door: [1, 1] },
  blurb: 'Galleries of art, history and natural history, with a café and a shop. A long day out for families and retirees, drawing visitors from far away.',
  howTo: 'Three tiles across and two deep, doors in the middle of the frontage. A small ticket pays towards the upkeep. Needs Big nights out.',
  tool: { id: 'museum', key: '', label: 'Museum', color: '#8a6a3c' },
  occupation: { ...library.occupation!, name: 'museum staff' },
  attrs: { ...library.attrs, visitorCapacity: 90, leisureValue: 7, radius: 20, ticket: 6, openHours: [10, 18], stay: [1.5, 3], dayAppeal: 1.2, retireeAppeal: 2.2, childAppeal: 1.7, title: 'museum' },
  lot: { wage: 17 },
  levels: [{
    capacity: 14, wage: 17, cost: 2400, upkeep: 36, work: 900, parking: { surface: 10, underground: 24 },
    designs: [
      { name: 'neoclassical museum with a pedimented portico and two gallery wings', height: 1.1, ops: [
        slab(3, 2, 'gravel'),
        ['box', 2.7, 0.62, 1.1, 0, 0.02, -0.38, 'stone', true], ['box', 2.72, 0.05, 1.12, 0, 0.64, -0.38, 'cream'],
        ['box', 1.0, 0.86, 0.9, 0, 0.02, -0.4, 'stone', true], ['roof', 1.04, 0.2, 0.94, 0, 0.88, -0.4, 'roofGrey', true],
        ['box', 1.2, 0.06, 0.5, 0, 0.02, 0.42, 'white'], ...repeat(6, (i): Op => ['cyl', 0.04, 0.045, 0.56, -0.5 + i * 0.2, 0.08, 0.42, 'white', 8]),
        ['box', 1.2, 0.08, 0.5, 0, 0.64, 0.42, 'white'], ['roof', 1.2, 0.22, 0.5, 0, 0.72, 0.42, 'white'],
        ...repeat(4, (i): Op => ['box', 1.0, 0.025 * (i + 1), 0.06, 0, 0.0, 0.84 - i * 0.06, 'white']),
        ['box', 0.12, 0.2, 0.12, -1.0, 0.02, 0.5, 'stone'], ['box', 0.2, 0.16, 0.12, -1.0, 0.22, 0.5, 'gold'],
        ...flags(1.0, 0.5, 2, 0.2, ['plum', 'gold'], 0.02),
      ] },
      { name: 'modern museum of angled galleries round a glass atrium, with a sculpture', height: 1.24, ops: [
        slab(3, 2, PAVING),
        ['box', 1.1, 0.7, 1.4, -0.85, 0.02, -0.25, 'charcoal', true], ['box', 1.12, 0.04, 1.42, -0.85, 0.72, -0.25, 'gold'],
        ['box', 1.0, 1.1, 1.0, 0.85, 0.02, -0.45, 'stone', true], ['box', 1.02, 0.04, 1.02, 0.85, 1.12, -0.45, 'dark'],
        ['box', 0.7, 0.6, 1.2, 0.0, 0.02, -0.3, 'glass', true], ['roof', 0.74, 0.22, 1.24, 0.0, 0.62, -0.3, 'glass', true],
        ['box', 0.12, 0.04, 0.12, 0.6, 0.02, 0.6, 'stone'], ['cone', 0.08, 0.36, 0.6, 0.06, 0.6, 'boxOrange', 3], ['cyl', 0.05, 0.05, 0.18, 0.62, 0.3, 0.6, 'gold', 6],
        ['box', 2.4, 0.004, 0.3, 0, 0.02, 0.75, 'stone'], ...treeLine(-1.3, 0.7, -0.5, 0.7, 3, 0.75),
      ] },
    ],
  }],
};

export const LEISURE_TIERS: KindDef[] = [lakesidePark, botanicalGarden, cafeCinema, multiplex, studioTheatre, operaHouse, leisureCentre, arena, stadium, centralLibrary, museum];
