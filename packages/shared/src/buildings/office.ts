import type { KindDef, Op } from './schema';
import { Zone } from './codes';
import { helipad, tree } from './tierkit';

/** who redrew the thin originals (docs/buildings.md "Redesigns") */
const FABLE = 'claude-fable-5-1';
/** the four corners of a square plan */
const CORNERS: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
/** weathered copper, for lantern roofs */
const COPPER = 0x6f8f7a;

export const office: KindDef = {
  id: 'office', name: 'office', code: Zone.Office, family: 'office',
  flags: { growable: true, workplace: true },
  windows: 'office',
  tool: { id: 'off', key: '7', label: 'Office', color: '#9b7fe0' },
  blurb: 'Office towers: the most jobs per tile, mostly nine to five on weekdays, so the heaviest commuter rush in the morning and the evening.',
  howTo: 'Drag Office (7) over your own land beside a road; it needs Office zoning. Offices pull commuters from far away, so give them good roads, parking or a bus line.',
  occupation: {
    name: 'office worker', rotate: false,
    shifts: [{ start: 9, hours: 8, weight: 0.6 }, { start: 8, hours: 8, weight: 0.2 }, { start: 10, hours: 8, weight: 0.15 }, { start: 7, hours: 8, weight: 0.05 }],
    cycles: [[1, 1, 1, 1, 1, 0, 0]],
  },
  tints: [0xffffff, 0xeaf0f8, 0xf4f4f0, 0xe4ecf7, 0xf1eef8],
  lotTint: 0xc9a8ff,
  lot: { wage: 14 },
  levels: [
    {
      capacity: 8, wage: 20, work: 60, parking: { surface: 1, underground: 5 },
      designs: [
        // the four level-1 designs redrawn (docs/buildings.md "Redesigns"): facades, an entrance, a roofscape, a forecourt
        { name: 'glass pavilion on a dark plinth, recessed lobby, roof terrace', height: 1.2, author: FABLE, ops: [
          ['box', 0.8, 0.05, 0.8, 0, 0, 0, 'dark'],
          ['box', 0.56, 0.26, 0.56, 0, 0.05, 0, 'glassDark', true, { name: 'lobby', facade: { storeys: 1, bays: 3, sideBays: 3, ground: 'door' } }],
          // the entrance canopy on its own posts, clear of the curtain wall
          ['box', 0.34, 0.02, 0.1, 0, 0.33, 0.37, 'dark'],
          ['box', 0.03, 0.28, 0.03, -0.15, 0.05, 0.405, 'charcoal'], ['box', 0.03, 0.28, 0.03, 0.15, 0.05, 0.405, 'charcoal'],
          // the pilotis under the overhang, then the glass floors, a dark cap and the roof terrace
          ...CORNERS.map(([sx, sz]): Op => ['box', 0.05, 0.26, 0.05, sx * 0.335, 0.05, sz * 0.335, 'charcoal']),
          ['box', 0.72, 0.72, 0.72, 0, 0.31, 0, 'glass', true, { name: 'tower', facade: { storeys: 3, bays: 4, sideBays: 4 } }],
          ['cornice', 'tower', 3, 'dark'],
          ['box', 0.22, 0.1, 0.18, 0.17, 1.06, -0.2, 'grey'], ['box', 0.14, 0.14, 0.14, -0.21, 1.06, -0.21, 'dark'],
          ['box', 0.46, 0.012, 0.3, 0, 1.06, 0.14, 'pale'], ['box', 0.7, 0.045, 0.012, 0, 1.06, 0.354, 'glass'],
          ['box', 0.08, 0.05, 0.08, -0.2, 1.072, 0.16, 'hedge'], ['box', 0.08, 0.05, 0.08, 0.2, 1.072, 0.16, 'hedge'],
        ] },
        { name: 'brick office with ribbon windows, an entrance canopy and a stone stair tower', height: 1.07, author: FABLE, ops: [
          ['box', 0.6, 0.84, 0.66, -0.08, 0, 0, 'brick', true, { name: 'block', facade: { storeys: 3, bays: 4, sideBays: 0, ground: 'door', margin: 0.04 } }],
          ['porch', 'block', 'front', 1, 2, 'dark', 'dark'],
          ['cornice', 'block', 1, 'stone'], ['cornice', 'block', 3, 'stone'],
          // the stair tower stands against the blank right side
          ['box', 0.2, 0.96, 0.3, 0.32, 0, -0.1, 'stone'], ['box', 0.22, 0.03, 0.32, 0.32, 0.96, -0.1, 'dark'],
          ['box', 0.16, 0.08, 0.12, -0.2, 0.87, -0.2, 'grey'], ['flag', -0.34, 0.87, 0.25, 'navy'],
          // planters either side of the entrance
          ['box', 0.14, 0.05, 0.08, -0.32, 0, 0.42, 'stone'], ['box', 0.12, 0.05, 0.06, -0.32, 0.05, 0.42, 'hedge'],
          ['box', 0.14, 0.05, 0.08, 0.16, 0, 0.42, 'stone'], ['box', 0.12, 0.05, 0.06, 0.16, 0.05, 0.42, 'hedge'],
        ] },
        { name: 'white precast office on dark pilotis over a glazed lobby', height: 1.37, author: FABLE, ops: [
          ['box', 0.52, 0.26, 0.52, 0, 0, 0, 'glassDark', true, { name: 'lobby', facade: { storeys: 1, bays: 3, sideBays: 3, ground: 'door' } }],
          ...[...CORNERS, [0, -1], [0, 1], [-1, 0], [1, 0]].map(([sx, sz]): Op => ['box', 0.06, 0.26, 0.06, sx * 0.33, 0, sz * 0.33, 'charcoal']),
          ['box', 0.72, 0.78, 0.72, 0, 0.26, 0, 'white', true, { name: 'slab', facade: { storeys: 3, bays: 5, sideBays: 5, margin: 0.03 } }],
          ['cornice', 'slab', 3, 'white'],
          ['box', 0.3, 0.12, 0.2, 0.1, 1.07, -0.15, 'dark'], ['cyl', 0.012, 0.012, 0.3, -0.25, 1.07, -0.25, 'steel', 5], ['box', 0.1, 0.06, 0.1, -0.22, 1.07, 0.18, 'plant'],
        ] },
        { name: 'low campus pair joined by a glazed link, trees on the forecourt', height: 0.95, author: FABLE, ops: [
          ['box', 0.34, 0.56, 0.64, -0.26, 0, -0.04, 'glass', true, { name: 'west', facade: { storeys: 2, bays: 2, sideBays: 4 } }],
          ['box', 0.34, 0.84, 0.64, 0.26, 0, -0.04, 'pale', true, { name: 'east', facade: { storeys: 3, bays: 2, sideBays: 4, ground: 'door' } }],
          // the link covers whole cells of both inner walls (two side bays, one storey)
          ['box', 0.18, 0.28, 0.32, 0, 0, -0.04, 'glassDark', true, { name: 'link', facade: { storeys: 1, bays: 1, sideBays: 0 } }],
          ['cornice', 'west', 2, 'dark'], ['cornice', 'east', 3, 'dark'],
          ['box', 0.14, 0.08, 0.14, 0.3, 0.87, -0.2, 'grey'],
          ['box', 0.84, 0.01, 0.12, 0, 0, 0.38, 'pale'], ...tree(-0.4, 0.4, 0.7), ...tree(0.4, 0.4, 0.7), ['flag', 0.1, 0.01, 0.41, 'signBlue'],
        ] },
      ],
    },
    {
      capacity: 16, wage: 26, work: 120, parking: { surface: 1, underground: 10 }, feature: 'level2',
      designs: [
        { name: 'pale stone tower on a glazed base, a dark glass crown and a beacon mast', height: 2.67, author: FABLE, ops: [
          ['box', 0.8, 0.5, 0.8, 0, 0, 0, 'glassDark', true, { name: 'base', facade: { storeys: 2, bays: 5, sideBays: 5, ground: 'door' } }],
          ['box', 0.36, 0.02, 0.07, 0, 0.26, 0.465, 'dark'], ['box', 0.02, 0.26, 0.02, -0.15, 0, 0.49, 'charcoal'], ['box', 0.02, 0.26, 0.02, 0.15, 0, 0.49, 'charcoal'],
          ['cornice', 'base', 2, 'dark'],
          ['box', 0.6, 1.4, 0.6, 0, 0.53, 0, 'pale', true, { name: 'tower', facade: { storeys: 5, bays: 4, sideBays: 4, margin: 0.05 } }],
          ['cornice', 'tower', 5, 'stone'],
          ['box', 0.48, 0.34, 0.48, 0, 1.96, 0, 'glassDark', true, { name: 'crown', facade: { storeys: 1, bays: 3, sideBays: 3 } }],
          ['box', 0.52, 0.04, 0.52, 0, 2.3, 0, 'dark'],
          ['cyl', 0.012, 0.015, 0.3, 0, 2.34, 0, 'steel', 5], ['box', 0.03, 0.03, 0.03, 0, 2.64, 0, 'red', 'beacon'],
          ['box', 0.07, 0.07, 0.07, 0.375, 0.53, -0.375, 'grey'], ['box', 0.07, 0.07, 0.07, -0.375, 0.53, -0.375, 'grey'],
        ] },
        { name: 'twin glass towers on a stone podium, joined by a sky bridge', height: 2.14, author: FABLE, ops: [
          ['box', 0.84, 0.3, 0.8, 0, 0, 0, 'stone', true, { name: 'podium', facade: { storeys: 1, bays: 6, sideBays: 5, ground: 'door' } }],
          ['box', 0.3, 0.02, 0.06, 0, 0.27, 0.47, 'dark'], ['box', 0.02, 0.27, 0.02, -0.13, 0, 0.48, 'charcoal'], ['box', 0.02, 0.27, 0.02, 0.13, 0, 0.48, 'charcoal'],
          ['cornice', 'podium', 1, 'dark'],
          ['box', 0.32, 1.5, 0.6, -0.24, 0.33, -0.06, 'glass', true, { name: 'west', facade: { storeys: 6, bays: 2, sideBays: 4 } }],
          ['box', 0.32, 1.25, 0.6, 0.24, 0.33, -0.06, 'glass', true, { name: 'east', facade: { storeys: 5, bays: 2, sideBays: 4 } }],
          // the bridge covers two side bays and one storey of both towers
          ['box', 0.16, 0.25, 0.3, 0, 1.08, -0.06, 'glassDark', true, { name: 'bridge', facade: { storeys: 1, bays: 1, sideBays: 0 } }],
          ['cornice', 'west', 6, 'white'], ['cornice', 'east', 5, 'white'],
          ['box', 0.14, 0.1, 0.14, 0.24, 1.61, -0.2, 'grey'], ['cyl', 0.01, 0.012, 0.28, -0.24, 1.86, -0.2, 'steel', 5],
        ] },
        { name: 'stepped stone ziggurat with planted terraces and a copper lantern', height: 2.49, author: FABLE, ops: [
          ['box', 0.84, 0.56, 0.84, 0, 0, 0, 'stone', true, { name: 'first', facade: { storeys: 2, bays: 6, sideBays: 6, ground: 'door', margin: 0.04 } }],
          ['box', 0.3, 0.02, 0.08, 0, 0.26, 0.46, 'dark'], ['box', 0.02, 0.26, 0.02, -0.13, 0, 0.49, 'charcoal'], ['box', 0.02, 0.26, 0.02, 0.13, 0, 0.49, 'charcoal'],
          ['cornice', 'first', 2, 'stone'],
          ['box', 0.66, 0.56, 0.66, 0, 0.59, 0, 'stone', true, { name: 'second', facade: { storeys: 2, bays: 5, sideBays: 5, margin: 0.03 } }],
          ['cornice', 'second', 2, 'stone'],
          ['box', 0.48, 0.56, 0.48, 0, 1.18, 0, 'stone', true, { name: 'third', facade: { storeys: 2, bays: 3, sideBays: 3, margin: 0.03 } }],
          ['cornice', 'third', 2, 'stone'],
          ['box', 0.3, 0.4, 0.3, 0, 1.77, 0, 'stone', true, { name: 'top', facade: { storeys: 1, bays: 2, sideBays: 2, margin: 0.03, top: 0.1 } }],
          ['taper', 0.3, 0.3, 0.1, 0.1, 0.2, 0, 2.17, 0, COPPER], ['cyl', 0.012, 0.012, 0.12, 0, 2.37, 0, 'gold', 5],
          ['box', 0.1, 0.05, 0.1, -0.38, 0.59, 0.38, 'hedge'], ['box', 0.1, 0.05, 0.1, 0.38, 0.59, 0.38, 'hedge'],
          ['box', 0.08, 0.05, 0.08, -0.29, 1.18, 0.29, 'hedge'], ['box', 0.08, 0.05, 0.08, 0.29, 1.18, 0.29, 'hedge'],
          ['flag', 0, 0.59, 0.4, 'red'],
        ] },
        { name: 'dark glass slab with a white service spine, a glazed lobby and roof plant', height: 2.37, author: FABLE, ops: [
          ['box', 0.56, 1.96, 0.5, -0.1, 0, -0.02, 'glassDark', true, { name: 'slab', facade: { storeys: 7, bays: 4, sideBays: 3 } }],
          // the spine hides the whole right wall; the lobby covers the two middle bays of the ground storey
          ['box', 0.2, 2.04, 0.5, 0.28, 0, -0.02, 'white'],
          ['box', 0.28, 0.28, 0.2, -0.1, 0, 0.33, 'glass', true, { name: 'lobby', facade: { storeys: 1, bays: 2, sideBays: 1, ground: 'door' } }],
          ['cornice', 'slab', 7, 'white'], ['box', 0.22, 0.03, 0.52, 0.28, 2.04, -0.02, 'dark'],
          ['box', 0.3, 0.1, 0.3, -0.12, 1.99, -0.05, 'grey'], ['cyl', 0.03, 0.03, 0.14, -0.3, 1.99, 0.12, 'silver', 8], ['cyl', 0.01, 0.012, 0.3, 0.28, 2.07, -0.2, 'steel', 5],
          ['box', 0.76, 0.01, 0.08, -0.06, 0, 0.46, 'pale'], ...tree(0.4, 0.42, 0.5), ...tree(-0.4, 0.42, 0.5),
        ] },
      ],
    },
    {
      capacity: 24, wage: 32, work: 180, parking: { surface: 1, underground: 15 }, feature: 'level3',
      designs: [
        { name: 'dark glass tower on a stone podium, white corner piers, a lit crown and a beacon mast', height: 3.45, author: FABLE, ops: [
          ['box', 0.84, 0.3, 0.84, 0, 0, 0, 'stone', true, { name: 'podium', facade: { storeys: 1, bays: 6, sideBays: 6, ground: 'door' } }],
          ['box', 0.32, 0.02, 0.06, 0, 0.27, 0.47, 'dark'], ['box', 0.02, 0.27, 0.02, -0.14, 0, 0.48, 'charcoal'], ['box', 0.02, 0.27, 0.02, 0.14, 0, 0.48, 'charcoal'],
          ['cornice', 'podium', 1, 'dark'],
          // the piers stand on the tower's plain margins
          ['box', 0.64, 2.0, 0.64, 0, 0.33, 0, 'glassDark', true, { name: 'tower', facade: { storeys: 8, bays: 4, sideBays: 4, margin: 0.04 } }],
          ...CORNERS.map(([sx, sz]): Op => ['box', 0.04, 2.0, 0.04, sx * 0.32, 0.33, sz * 0.32, 'white']),
          ['cornice', 'tower', 8, 'white'],
          ['box', 0.5, 0.4, 0.5, 0, 2.36, 0, 'glass', true, { name: 'crown', facade: { storeys: 1, bays: 3, sideBays: 3 } }],
          ['box', 0.54, 0.05, 0.54, 0, 2.76, 0, 'white'],
          ['cyl', 0.015, 0.02, 0.6, 0, 2.81, 0, 'steel', 6], ['box', 0.035, 0.035, 0.035, 0, 3.41, 0, 'red', 'beacon'],
          ['box', 0.08, 0.08, 0.08, 0.38, 0.33, -0.38, 'grey'], ['box', 0.08, 0.08, 0.08, -0.38, 0.33, -0.38, 'grey'],
        ] },
        { name: 'stepped pale stone tower, terraces on the setbacks, a slate lantern and a spire', height: 3.73, author: FABLE, ops: [
          ['box', 0.84, 0.8, 0.84, 0, 0, 0, 'pale', true, { name: 'first', facade: { storeys: 3, bays: 6, sideBays: 6, ground: 'door', margin: 0.04 } }],
          ['box', 0.3, 0.02, 0.06, 0, 0.24, 0.47, 'dark'], ['box', 0.02, 0.24, 0.02, -0.13, 0, 0.48, 'charcoal'], ['box', 0.02, 0.24, 0.02, 0.13, 0, 0.48, 'charcoal'],
          ['cornice', 'first', 3, 'stone'],
          ['box', 0.66, 0.9, 0.66, 0, 0.83, 0, 'pale', true, { name: 'second', facade: { storeys: 3, bays: 5, sideBays: 5, margin: 0.03 } }],
          ['cornice', 'second', 3, 'stone'],
          ['box', 0.5, 0.9, 0.5, 0, 1.76, 0, 'pale', true, { name: 'third', facade: { storeys: 3, bays: 3, sideBays: 3, margin: 0.03 } }],
          ['cornice', 'third', 3, 'stone'],
          ['box', 0.32, 0.5, 0.32, 0, 2.69, 0, 'pale', true, { name: 'fourth', facade: { storeys: 2, bays: 2, sideBays: 2, margin: 0.03 } }],
          ['cornice', 'fourth', 2, 'stone'],
          ['taper', 0.32, 0.32, 0.12, 0.12, 0.18, 0, 3.22, 0, 'slate'], ['cone', 0.06, 0.3, 0, 3.4, 0, 'steel', 6], ['box', 0.03, 0.03, 0.03, 0, 3.7, 0, 'red', 'beacon'],
          ['box', 0.08, 0.05, 0.08, -0.385, 0.83, 0.385, 'hedge'], ['box', 0.08, 0.05, 0.08, 0.385, 0.83, 0.385, 'hedge'],
          ['box', 0.07, 0.05, 0.07, -0.295, 1.76, 0.295, 'hedge'], ['box', 0.07, 0.05, 0.07, 0.295, 1.76, 0.295, 'hedge'],
        ] },
        { name: 'paired glass wings of two heights, a shared lobby and a two-storey sky bridge', height: 3.46, author: FABLE, ops: [
          ['box', 0.36, 3.0, 0.7, -0.26, 0, -0.04, 'glass', true, { name: 'west', facade: { storeys: 12, bays: 2, sideBays: 4 } }],
          ['box', 0.36, 2.5, 0.7, 0.26, 0, -0.04, 'glassDark', true, { name: 'east', facade: { storeys: 10, bays: 2, sideBays: 4 } }],
          // the lobby and the bridge each cover two side bays of both wings
          ['box', 0.16, 0.25, 0.35, 0, 0, 0.135, 'glassDark', true, { name: 'lobby', facade: { storeys: 1, bays: 1, sideBays: 0, ground: 'door' } }],
          ['box', 0.16, 0.5, 0.35, 0, 1.75, -0.215, 'white'],
          ['cornice', 'west', 12, 'white'], ['cornice', 'east', 10, 'white'],
          ['cyl', 0.012, 0.015, 0.4, -0.26, 3.03, -0.2, 'steel', 5], ['box', 0.03, 0.03, 0.03, -0.26, 3.43, -0.2, 'red', 'beacon'],
          ['box', 0.16, 0.1, 0.2, 0.26, 2.53, -0.2, 'grey'],
          ['box', 0.2, 0.02, 0.06, 0, 0.23, 0.38, 'dark'], ['box', 0.02, 0.23, 0.02, -0.08, 0, 0.4, 'charcoal'], ['box', 0.02, 0.23, 0.02, 0.08, 0, 0.4, 'charcoal'],
          ['box', 0.84, 0.01, 0.12, 0, 0, 0.42, 'pale'], ...tree(-0.38, 0.42, 0.5), ...tree(0.38, 0.42, 0.5),
        ] },
        { name: 'wide slab on a podium with a helipad', height: 2.97, ops: [
          ['box', 0.9, 0.4, 0.9, 0, 0, 0, 'stone', true], ['box', 0.86, 2.4, 0.4, 0, 0.4, -0.1, 'glassDark', true],
          ['box', 0.88, 0.05, 0.44, 0, 2.8, -0.1, 'white'],
          ...helipad(0.2, 2.85, -0.1, 0.18), ['box', 0.2, 0.12, 0.2, -0.25, 2.85, -0.1, 'grey'],
        ] },
      ],
    },
  ],
};
