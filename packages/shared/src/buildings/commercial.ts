import type { KindDef } from './schema';
import { Zone } from './codes';
import { repeat } from './helpers';
import { car } from './tierkit';

/** who redrew the thin originals (docs/buildings.md "Redesigns") */
const FABLE = 'claude-fable-5-1';

export const commercial: KindDef = {
  id: 'commercial', name: 'commercial', code: Zone.Commercial, family: 'commercial',
  flags: { growable: true, workplace: true, leisureReady: true },
  windows: 'shop',
  tool: { id: 'com', key: '5', label: 'Commercial', color: 'var(--com)' },
  blurb: 'Shops, cafés, bars and restaurants. They employ people on early, day and late shifts, take deliveries from industry, and double as somewhere to go: residents stop for a coffee or a meal, and visitors drive in from the edge of town.',
  howTo: 'Drag Commercial (5) over your own land beside a road; it grows when there are more people than jobs. Put shops where people pass and within a short drive of factories, whose trucks deliver to the nearest shop (or by train, through a freight line).',
  attrs: { commerceType: 'shop', openHours: [7, 22] },
  occupation: {
    name: 'shop worker', rotate: true,
    shifts: [{ start: 9, hours: 8, weight: 0.4 }, { start: 12, hours: 8, weight: 0.3 }, { start: 6, hours: 8, weight: 0.2 }, { start: 14, hours: 8, weight: 0.1 }],
    cycles: [[1, 1, 1, 1, 1, 0, 0], [1, 1, 0, 1, 1, 1, 0], [0, 1, 1, 1, 1, 1, 0]],
  },
  tints: [0xffffff, 0xfff3e0, 0xeef2f7, 0xf7e8e8, 0xf4f7ec],
  lotTint: 0x7ab6ff,
  lot: { wage: 10 },
  levels: [
    {
      capacity: 3, wage: 15, work: 60, parking: { surface: 1, underground: 3 },
      attrs: { visitorCapacity: 6 },
      designs: [
        { name: 'white-rendered corner shop with a striped awning, a flat above and a side door', height: 0.69, author: FABLE, ops: [
          ['box', 0.66, 0.5, 0.56, 0, 0, -0.06, 'white', true, { name: 'shop', facade: { storeys: 2, bays: 4, sideBays: 3 } }],
          ['awning', 'shop', 'front', 0, 3, 'awning'], ['door', 'shop', 'right', 0, 'green'], ['cornice', 'shop', 2, 'dark'],
          ['box', 0.07, 0.16, 0.07, 0.22, 0.53, -0.25, 'chimney'],
          ['box', 0.06, 0.08, 0.04, 0.25, 0, 0.36, 'signBlue'], ['box', 0.08, 0.06, 0.08, -0.28, 0, 0.36, 'green'],
        ] },
        { name: 'brick corner store with a striped awning, a stone cornice and the flat\'s door at the side', height: 0.67, author: FABLE, ops: [
          ['box', 0.72, 0.5, 0.6, 0, 0, -0.04, 'brick', true, { name: 'store', facade: { storeys: 2, bays: 4, sideBays: 3 } }],
          ['awning', 'store', 'front', 0, 0, 'awning'], ['awning', 'store', 'front', 1, 1, 'white'], ['awning', 'store', 'front', 2, 2, 'awning'], ['awning', 'store', 'front', 3, 3, 'white'],
          ['door', 'store', 'right', 0, 'green'], ['cornice', 'store', 2, 'stone'],
          ['box', 0.07, 0.14, 0.07, -0.26, 0.53, -0.25, 'chimney'],
          ['cyl', 0.02, 0.02, 0.06, 0.32, 0, 0.4, 'dark', 6], ['box', 0.06, 0.08, 0.04, -0.3, 0, 0.4, 'signBlue'],
        ] },
        { name: 'café in a green shopfront with a cream awning and pavement tables under umbrellas', height: 0.53, author: FABLE, attrs: { commerceType: 'café', openHours: [6, 19] }, ops: [
          ['box', 0.56, 0.4, 0.5, -0.1, 0, -0.1, 'green', true, { name: 'cafe', facade: { storeys: 1, bays: 3, sideBays: 2 } }],
          ['door', 'cafe', 'front', 0, 'door'], ['awning', 'cafe', 'front', 0, 2, 'cream'],
          ['box', 0.58, 0.03, 0.52, -0.1, 0.4, -0.1, 'dark'],
          ['box', 0.3, 0.04, 0.3, -0.15, 0.43, -0.15, 'hedge'], ['cyl', 0.025, 0.025, 0.1, 0.1, 0.43, -0.25, 'silver', 6],
          // two pavement tables under umbrellas, a planter at the kerb
          ['cyl', 0.008, 0.008, 0.22, 0.33, 0, 0.3, 'steel', 4], ['cone', 0.11, 0.05, 0.33, 0.22, 0.3, 'awning', 8],
          ['cyl', 0.008, 0.008, 0.22, 0.33, 0, 0.02, 'steel', 4], ['cone', 0.11, 0.05, 0.33, 0.22, 0.02, 'cream', 8],
          ['cyl', 0.006, 0.006, 0.07, 0.33, 0, 0.3, 'steel', 4], ['cyl', 0.035, 0.035, 0.005, 0.33, 0.07, 0.3, 'white', 8],
          ['cyl', 0.006, 0.006, 0.07, 0.33, 0, 0.02, 'steel', 4], ['cyl', 0.035, 0.035, 0.005, 0.33, 0.07, 0.02, 'white', 8],
          ['box', 0.08, 0.06, 0.2, 0.42, 0, 0.3, 'hedge'],
        ] },
        { name: 'chrome diner with a red band, an entrance canopy and a tall lit sign', height: 0.64, author: FABLE, attrs: { commerceType: 'restaurant', openHours: [7, 24] }, ops: [
          ['box', 0.6, 0.32, 0.48, 0, 0, -0.06, 'silver', true, { name: 'diner', facade: { storeys: 1, bays: 4, sideBays: 3 } }],
          ['door', 'diner', 'front', 1, 'red'], ['cornice', 'diner', 1, 'red'], ['box', 0.64, 0.02, 0.52, 0, 0.355, -0.06, 'dark'],
          ['box', 0.2, 0.02, 0.07, -0.08, 0.3, 0.255, 'red'], ['box', 0.015, 0.3, 0.015, -0.17, 0, 0.28, 'steel'], ['box', 0.015, 0.3, 0.015, 0.01, 0, 0.28, 'steel'],
          ['cyl', 0.015, 0.02, 0.6, -0.38, 0, 0.3, 'steel', 6], ['box', 0.2, 0.14, 0.03, -0.3, 0.5, 0.3, 'red', 'sign'], ['box', 0.16, 0.05, 0.034, -0.3, 0.54, 0.3, 'yellow', 'sign'],
          ['cyl', 0.03, 0.03, 0.08, 0.2, 0.375, -0.2, 'silver', 8], ['box', 0.1, 0.06, 0.1, -0.1, 0.375, -0.2, 'grey'],
          ...car(0.4, 0.3, 'red', false, 0),
        ] },
        // Worked example from docs/buildings.md: a draft design. Drafts show in /viewer.html
        // but are never placed in the city; drop `draft` to add it to the street rotation.
        { name: 'news kiosk with a striped canopy', height: 0.34, draft: true, attrs: { commerceType: 'kiosk', openHours: [6, 20], visitorCapacity: 2 }, ops: [
          ['box', 0.9, 0.02, 0.9, 0, 0, 0, 'stone'],
          ['box', 0.3, 0.24, 0.24, -0.12, 0.02, -0.08, 'green', true],
          ['box', 0.34, 0.03, 0.28, -0.12, 0.26, -0.08, 'dark'],
          ...repeat(4, (i) => ['box', 0.085, 0.02, 0.14, -0.248 + i * 0.085, 0.22, 0.1, i % 2 ? 'cream' : 'green']),
          ['box', 0.26, 0.07, 0.02, -0.12, 0.27, 0.075, 'yellow'],
          ['box', 0.12, 0.12, 0.06, 0.16, 0.02, 0.12, 'signBlue'], ['box', 0.1, 0.02, 0.07, 0.16, 0.14, 0.12, 'white'],
          ['cyl', 0.012, 0.012, 0.18, 0.3, 0.02, -0.2, 'steel', 5], ['box', 0.1, 0.12, 0.02, 0.3, 0.2, -0.2, 'red'],
        ] },
      ],
    },
    {
      capacity: 6, wage: 20, work: 120, parking: { surface: 1, underground: 6 }, feature: 'level2',
      attrs: { visitorCapacity: 12 },
      designs: [
        { name: 'stone-fronted shop with a glazed ground floor, balconies above and a cornice', height: 0.95, author: FABLE, ops: [
          ['box', 0.78, 0.78, 0.7, 0, 0, 0, 'stone', true, { name: 'shop', facade: { storeys: 3, bays: 5, sideBays: 4 } }],
          ['awning', 'shop', 'front', 1, 3, 'navy'], ['balcony', 'shop', 'front', 2, 1, 3, 'dark', 'stone'], ['cornice', 'shop', 3, 'stone'],
          ['box', 0.2, 0.1, 0.16, 0.2, 0.81, -0.2, 'grey'], ['box', 0.14, 0.14, 0.14, -0.22, 0.81, -0.22, 'dark'],
          ['box', 0.06, 0.08, 0.04, 0.3, 0, 0.42, 'signBlue'], ['box', 0.08, 0.06, 0.08, -0.3, 0, 0.42, 'green'],
        ] },
        { name: 'supermarket with entrance canopy and rooftop plant', height: 0.66, attrs: { commerceType: 'supermarket', openHours: [7, 22] }, ops: [
          ['box', 0.86, 0.5, 0.78, 0, 0, 0, 'stone', true], ['box', 0.6, 0.2, 0.04, 0, 0.05, 0.4, 'glass'],
          ['box', 0.9, 0.04, 0.3, 0, 0.3, 0.4, 'signBlue'], ['box', 0.5, 0.14, 0.04, 0, 0.52, 0.3, 'signBlue'],
          ['box', 0.2, 0.1, 0.2, -0.25, 0.5, -0.2, 'grey'], ['box', 0.2, 0.1, 0.2, 0.2, 0.5, -0.25, 'grey'],
        ] },
        { name: 'shop below two floors of flats, a mansard roof with dormers and a chimney', height: 1.1, author: FABLE, ops: [
          ['box', 0.76, 0.78, 0.68, 0, 0, 0, 'cream', true, { name: 'block', facade: { storeys: 3, bays: 5, sideBays: 4 } }],
          ['awning', 'block', 'front', 0, 4, 'awning'], ['door', 'block', 'right', 0, 'door'], ['cornice', 'block', 3, 'stone'],
          ['taper', 0.78, 0.7, 0.6, 0.52, 0.2, 0, 0.81, 0, 'slate'], ['box', 0.6, 0.02, 0.52, 0, 1.01, 0, 'dark'],
          ['box', 0.1, 0.1, 0.06, -0.2, 0.81, 0.32, 'cream', 'home', { name: 'dormerA', facade: { storeys: 1, bays: 1, sideBays: 0 } }],
          ['box', 0.1, 0.1, 0.06, 0.2, 0.81, 0.32, 'cream', 'home', { name: 'dormerB', facade: { storeys: 1, bays: 1, sideBays: 0 } }],
          ['box', 0.08, 0.2, 0.08, 0.3, 0.9, -0.1, 'chimney'],
        ] },
        { name: 'two-block shopping arcade with awnings, a parapet clock and flags', height: 0.85, author: FABLE, attrs: { commerceType: 'mall' }, ops: [
          // the east block hides the whole of the west block's right wall, and the west the east's left
          ['box', 0.5, 0.7, 0.72, -0.18, 0, 0, 'white', true, { name: 'west', facade: { storeys: 3, bays: 3, sideBays: 4 } }],
          ['box', 0.36, 0.467, 0.72, 0.25, 0, 0, 'pale', true, { name: 'east', facade: { storeys: 2, bays: 2, sideBays: 4 } }],
          ['awning', 'west', 'front', 0, 2, 'navy'], ['awning', 'east', 'front', 0, 1, 'awning'], ['cornice', 'west', 3, 'dark'], ['cornice', 'east', 2, 'dark'],
          ['flag', 0.15, 0.497, 0.2, 'red'], ['flag', 0.35, 0.497, 0.2, 'yellow'],
          ['box', 0.12, 0.12, 0.03, -0.18, 0.73, 0.3, 'white'], ['lathe', -0.18, 0.79, 0.316, 'dark', [0, 0, 0.04, 0, 0.04, 0.004], { seg: 16, axis: 'z' }],
          ['box', 0.16, 0.1, 0.16, -0.2, 0.73, -0.2, 'grey'],
          ['box', 0.08, 0.06, 0.08, -0.4, 0, 0.44, 'hedge'], ['box', 0.08, 0.06, 0.08, 0.4, 0, 0.44, 'hedge'],
        ] },
      ],
    },
    {
      capacity: 9, wage: 25, work: 180, parking: { surface: 1, underground: 9 }, feature: 'level3',
      attrs: { visitorCapacity: 18 },
      designs: [
        { name: 'glass tower over a two-shop retail podium, with a lit roof sign', height: 2.22, author: FABLE, ops: [
          ['box', 0.84, 0.52, 0.76, 0, 0, 0, 'white', true, { name: 'podium', facade: { storeys: 2, bays: 6, sideBays: 5 } }],
          ['awning', 'podium', 'front', 0, 2, 'awning'], ['awning', 'podium', 'front', 3, 5, 'navy'], ['cornice', 'podium', 2, 'dark'],
          ['box', 0.56, 1.5, 0.56, 0, 0.55, 0, 'glass', 'office', { name: 'tower', facade: { storeys: 6, bays: 4, sideBays: 4 } }],
          ['cornice', 'tower', 6, 'white'],
          ['box', 0.3, 0.14, 0.04, 0, 2.08, 0.15, 'red', 'sign'], ['box', 0.2, 0.12, 0.2, -0.1, 2.08, -0.15, 'grey'],
        ] },
        { name: 'hotel with vertical fins and a roof sign', height: 2.1, attrs: { commerceType: 'hotel', openHours: [0, 24] }, ops: [
          ['box', 0.84, 0.3, 0.84, 0, 0, 0, 'stone', true], ['box', 0.78, 1.6, 0.5, 0, 0.3, -0.1, 'cream', 'home'],
          ...repeat(7, (i) => ['box', 0.03, 1.6, 0.06, (i - 3) * 0.11, 0.3, 0.17, 'white']),
          ['box', 0.8, 0.04, 0.54, 0, 1.9, -0.1, 'dark'], ['box', 0.4, 0.14, 0.04, 0, 1.94, -0.05, 'red'], ['box', 0.5, 0.03, 0.2, 0, 0.3, 0.45, 'dark'],
        ] },
        { name: 'stepped department store', height: 1.9, attrs: { commerceType: 'department store' }, ops: [
          ['box', 0.88, 0.7, 0.88, 0, 0, 0, 'stone', true], ['box', 0.74, 0.6, 0.74, 0, 0.7, 0, 'cream', true], ['box', 0.56, 0.5, 0.56, 0, 1.3, 0, 'cream', true],
          ['box', 0.6, 0.04, 0.6, 0, 1.8, 0, 'dark'], ['box', 0.9, 0.03, 0.16, 0, 0.4, 0.46, 'awning'],
          ['flag', -0.3, 0.7, 0.3, 'red'], ['flag', 0.3, 0.7, 0.3, 'signBlue'],
        ] },
        { name: 'three offset glass cubes stepping back, with roof gardens on the steps', height: 2.34, author: FABLE, ops: [
          ['box', 0.74, 0.7, 0.74, -0.04, 0, 0, 'glassDark', true, { name: 'first', facade: { storeys: 3, bays: 5, sideBays: 5 } }],
          ['awning', 'first', 'front', 1, 3, 'awning'], ['cornice', 'first', 3, 'white'],
          ['box', 0.6, 0.7, 0.6, 0.08, 0.73, -0.06, 'glass', 'office', { name: 'second', facade: { storeys: 3, bays: 4, sideBays: 4 } }],
          ['cornice', 'second', 3, 'white'],
          ['box', 0.46, 0.6, 0.46, -0.08, 1.46, 0.04, 'white', 'office', { name: 'third', facade: { storeys: 2, bays: 3, sideBays: 3 } }],
          ['cornice', 'third', 2, 'dark'],
          // roof gardens on the steps, clear of the walls above
          ['box', 0.5, 0.05, 0.08, -0.1, 0.73, 0.31, 'hedge'], ['box', 0.1, 0.05, 0.4, -0.33, 0.73, -0.1, 'hedge'], ['box', 0.14, 0.05, 0.4, 0.3, 1.46, -0.06, 'hedge'],
          ['cyl', 0.01, 0.012, 0.25, 0.1, 2.09, -0.1, 'steel', 5],
        ] },
      ],
    },
  ],
};
