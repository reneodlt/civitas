import type { KindDef, Op } from './schema';
import { Zone } from './codes';
import { tree } from './tierkit';

/** who redrew the thin originals (docs/buildings.md "Redesigns") */
const FABLE = 'claude-fable-5-1';

export const residential: KindDef = {
  id: 'residential', name: 'residential', code: Zone.Residential, family: 'residential',
  flags: { growable: true },
  windows: 'home',
  tool: { id: 'res', key: '4', label: 'Residential', color: 'var(--res)' },
  blurb: 'Homes. Zoned land grows into houses, then terraces, then apartment blocks (levels 1 to 3) when there are more jobs than people and builders can reach it. Each resident takes the nearest job anywhere on the road network and pays property tax to whoever owns the land they live on.',
  howTo: 'Drag Residential (4) over land you own beside a road; there is nothing to place. A builders\' yard must reach the lots by road. Levels 2 and 3 need Masonry and Steel frame, and the top level wants police, fire or health cover nearby; parks and venues help it grow.',
  attrs: { style: 'mixed', rentBand: 'low' },
  tints: [0xffffff, 0xffd9b8, 0xfff0b3, 0xcfe3f7, 0xd6ebc9, 0xf7cfcf, 0xf2e6ff, 0xffe4c4],
  lotTint: 0x8fe07a,
  levels: [
    {
      // a third of WORK_PER_LEVEL (Audit #1): the first houses go up in minutes, not a game day; levels 2 and 3 stay 120 and 180
      capacity: 4, work: 20, parking: { surface: 4, underground: 4 },
      attrs: { style: 'house', rentBand: 'low' },
      designs: [
        { name: 'cottage, pitched roof and chimney', height: 0.52, ops: [
          ['box', 0.5, 0.3, 0.42, 0, 0, 0, 'cream', true, { name: 'house', facade: { storeys: 1, bays: 3, sideBays: 2 } }],
          ['roof', 0.58, 0.22, 0.5, 0, 0.3, 0, 'terracotta'],
          ['box', 0.07, 0.16, 0.07, 0.15, 0.32, -0.1, 'chimney'],
          ['door', 'house', 'front', 2],
        ] },
        { name: 'bungalow with carport', height: 0.44, ops: [
          // the top band keeps the side windows below the carport roof
          ['box', 0.62, 0.26, 0.4, -0.05, 0, 0, 'tan', true, { name: 'house', facade: { storeys: 1, bays: 4, sideBays: 2, top: 0.06 } }],
          ['roof', 0.7, 0.18, 0.48, -0.05, 0.26, 0, 'slate', true],
          ['box', 0.22, 0.02, 0.32, 0.34, 0.2, 0.04, 'grey'],
          ['box', 0.02, 0.2, 0.02, 0.43, 0, 0.18, 'steel'], ['box', 0.02, 0.2, 0.02, 0.43, 0, -0.1, 'steel'],
          ['door', 'house', 'front', 1],
        ] },
        { name: 'tall narrow cottage with a steep slate roof, a dormer, a porch and a ridge chimney', height: 0.72, author: FABLE, ops: [
          ['box', 0.4, 0.36, 0.46, 0, 0, 0, 'white', true, { name: 'house', facade: { storeys: 1, bays: 2, sideBays: 3, ground: 'door' } }],
          ['roof', 0.46, 0.3, 0.52, 0, 0.36, 0, 'slate', false, { name: 'roof' }], ['dormer', 'roof', 1, 'white'],
          ['porch', 'house', 'front', 1, 1, 'slate', 'white'],
          ['box', 0.07, 0.22, 0.07, 0.14, 0.5, 0, 'chimney'],
          ['box', 0.16, 0.04, 0.05, -0.1, 0, 0.36, 'hedge'], ['box', 0.1, 0.004, 0.2, 0.1, 0, 0.4, 'gravel'],
        ] },
        { name: 'L-shaped brick house with a porch in the corner, slate roofs and a garden tree', height: 0.56, author: FABLE, ops: [
          // the wing covers the main block's right-hand front bay; the main block hides the wing's back wall
          ['box', 0.5, 0.3, 0.3, -0.05, 0, -0.1, 'brick', true, { name: 'main', facade: { storeys: 1, bays: 2, sideBays: 2 } }],
          ['box', 0.25, 0.3, 0.3, 0.075, 0, 0.17, 'brick', true, { name: 'wing', facade: { storeys: 1, bays: 2, sideBays: 0 } }],
          ['door', 'main', 'front', 0], ['porch', 'main', 'front', 0, 0, 'slate', 'white'],
          ['roof', 0.56, 0.2, 0.36, -0.05, 0.3, -0.1, 'slate'], ['roof', 0.31, 0.2, 0.34, 0.075, 0.3, 0.17, 'slate', true],
          ['box', 0.06, 0.2, 0.06, -0.22, 0.36, -0.1, 'chimney'],
          ['box', 0.2, 0.05, 0.04, -0.2, 0, 0.4, 'hedge'], ['box', 0.08, 0.004, 0.3, -0.17, 0, 0.35, 'gravel'], ...tree(-0.4, -0.38, 0.5),
        ] },
      ],
    },
    {
      capacity: 8, work: 120, parking: { surface: 8, underground: 8 }, feature: 'level2',
      attrs: { style: 'townhouse', rentBand: 'mid' },
      designs: [
        { name: 'brick townhouse', height: 0.66, ops: [
          ['box', 0.64, 0.5, 0.56, 0, 0, 0, 'brick', true, { name: 'house', facade: { storeys: 2, bays: 5 } }],
          ['roof', 0.7, 0.16, 0.62, 0, 0.5, 0, 'slate', true],
          ['door', 'house', 'front', 3], ['door', 'house', 'front', 1],
          ['box', 0.06, 0.14, 0.06, -0.22, 0.55, 0.12, 'chimney'],
        ] },
        { name: 'duplex, two tones, flat parapet roof', height: 0.56, ops: [
          ['box', 0.32, 0.52, 0.56, -0.17, 0, 0, 'cream', true, { name: 'west', facade: { storeys: 2, bays: 2 } }],
          ['box', 0.32, 0.52, 0.56, 0.17, 0, 0, 'tan', true, { name: 'east', facade: { storeys: 2, bays: 2 } }],
          ['box', 0.68, 0.04, 0.6, 0, 0.52, 0, 'dark'],
          ['door', 'west', 'front', 1], ['door', 'east', 'front', 0],
          ['box', 0.26, 0.02, 0.1, 0, 0.2, 0.32, 'dark'],
        ] },
        { name: 'timber-framed house with a gabled cross wing to the street, a porch and a brick chimney', height: 0.76, author: FABLE, ops: [
          ['box', 0.64, 0.44, 0.5, 0, 0, -0.02, 'white', true, { name: 'main', facade: { storeys: 2, bays: 4, sideBays: 3 } }],
          ['box', 0.32, 0.44, 0.24, 0.16, 0, 0.33, 'white', true, { name: 'wing', facade: { storeys: 2, bays: 2, sideBays: 1 } }],
          ['cornice', 'main', 1, 'timber'], ['cornice', 'wing', 1, 'timber'],
          ['roof', 0.7, 0.26, 0.56, 0, 0.44, -0.02, 'timber'], ['roof', 0.36, 0.26, 0.28, 0.16, 0.44, 0.33, 'timber', true],
          ['door', 'main', 'front', 0], ['porch', 'main', 'front', 0, 0, 'timber', 'timber'],
          ['box', 0.07, 0.2, 0.07, -0.2, 0.56, -0.02, 'brick'],
          ['box', 0.16, 0.05, 0.04, -0.24, 0, 0.44, 'hedge'], ['box', 0.08, 0.004, 0.16, -0.08, 0, 0.42, 'gravel'],
        ] },
        { name: 'modern house of two stacked boxes, a picture window, a cantilever and a roof deck', height: 0.63, author: FABLE, ops: [
          ['box', 0.64, 0.3, 0.56, 0, 0, 0, 'pale', true, { name: 'lower', facade: { storeys: 1, bays: 4, sideBays: 3, ground: 'door', margin: 0.02 } }],
          ['baywindow', 'lower', 'front', 0, 0, 'dark'], ['porch', 'lower', 'front', 2, 2, 'dark', 'white'],
          ['box', 0.5, 0.3, 0.46, 0.1, 0.3, 0, 'white', true, { name: 'upper', facade: { storeys: 1, bays: 3, sideBays: 3, margin: 0.02 } }],
          ['cornice', 'upper', 1, 'dark'],
          // the roof deck beside the upper box, with a glass balustrade and a planter
          ['box', 0.14, 0.01, 0.4, -0.24, 0.3, 0, 'timber'], ['box', 0.012, 0.06, 0.4, -0.315, 0.3, 0, 'glass'], ['box', 0.08, 0.05, 0.08, -0.24, 0.31, -0.18, 'hedge'],
          ['box', 0.1, 0.004, 0.2, 0.07, 0, 0.4, 'gravel'], ...tree(-0.4, 0.4, 0.5),
        ] },
      ],
    },
    {
      capacity: 12, work: 180, parking: { surface: 12, underground: 12 }, feature: 'level3',
      attrs: { style: 'apartments', rentBand: 'high' },
      designs: [
        { name: 'cream apartment block with balconies, a porch and a rooftop penthouse setback', height: 1.4, author: FABLE, ops: [
          ['box', 0.74, 1.0, 0.74, 0, 0, 0, 'cream', true, { name: 'block', facade: { storeys: 4, bays: 5, sideBays: 5, ground: 'door', margin: 0.03 } }],
          ['porch', 'block', 'front', 2, 2, 'dark', 'white'],
          ['balcony', 'block', 'front', 1, 1, 3], ['balcony', 'block', 'front', 2, 1, 3], ['balcony', 'block', 'front', 3, 1, 3],
          ['cornice', 'block', 4, 'dark'],
          ['box', 0.5, 0.24, 0.5, 0, 1.03, -0.04, 'white', true, { name: 'penthouse', facade: { storeys: 1, bays: 3, sideBays: 3 } }],
          ['box', 0.54, 0.03, 0.54, 0, 1.27, -0.04, 'dark'], ['box', 0.12, 0.1, 0.12, 0.2, 1.3, -0.15, 'grey'],
          ['box', 0.5, 0.05, 0.06, 0, 1.03, 0.3, 'hedge'],
        ] },
        { name: 'brick walk-up with water tank', height: 1.2, ops: [
          ['box', 0.78, 0.9, 0.7, 0, 0, 0, 'brick', true, { name: 'block', facade: { storeys: 3, bays: 5, ground: 'door' } }], ['box', 0.82, 0.04, 0.74, 0, 0.9, 0, 'dark'],
          ['box', 0.3, 0.16, 0.3, -0.15, 0.94, -0.1, 'grey'],
          ['cyl', 0.09, 0.09, 0.16, 0.22, 1.0, 0.15, 'brown', 8], ['cone', 0.1, 0.05, 0.22, 1.16, 0.15, 'dark', 8],
          ['box', 0.14, 0.06, 0.14, 0.22, 0.94, 0.15, 'dark'],
          ['box', 0.3, 0.03, 0.12, 0, 0.26, 0.4, 'dark'],
        ] },
        { name: 'mint slab block with full-width balconies, a lift room and a front lawn', height: 1.39, author: FABLE, ops: [
          ['box', 0.84, 1.2, 0.5, 0, 0, -0.1, 'mint', true, { name: 'slab', facade: { storeys: 4, bays: 6, sideBays: 3, ground: 'door', margin: 0.03 } }],
          ['balcony', 'slab', 'front', 1, 0, 5], ['balcony', 'slab', 'front', 2, 0, 5], ['balcony', 'slab', 'front', 3, 0, 5],
          ['cornice', 'slab', 4, 'dark'],
          ['box', 0.22, 0.16, 0.2, 0.25, 1.23, -0.15, 'grey'], ['box', 0.1, 0.1, 0.1, -0.2, 1.23, -0.2, 'dark'],
          ['box', 0.8, 0.01, 0.2, 0, 0, 0.4, 'lawn'], ['box', 0.1, 0.014, 0.2, 0.035, 0, 0.4, 'gravel'], ...tree(-0.35, 0.4, 0.5), ...tree(0.35, 0.4, 0.5),
        ] },
        { name: 'slim tower on a stone podium with a dark lift core and corner balconies', height: 1.72, author: FABLE, ops: [
          ['box', 0.72, 0.26, 0.72, 0, 0, 0, 'stone', true, { name: 'podium', facade: { storeys: 1, bays: 5, sideBays: 5, ground: 'door' } }],
          ['cornice', 'podium', 1, 'dark'],
          ['box', 0.5, 1.3, 0.5, 0.04, 0.29, 0.04, 'pale', true, { name: 'tower', facade: { storeys: 5, bays: 3, sideBays: 3 } }],
          // the lift core covers the back cell of the tower's left wall
          ['box', 0.18, 1.4, 0.167, -0.3, 0.29, -0.1267, 'dark'], ['box', 0.2, 0.03, 0.187, -0.3, 1.69, -0.1267, 'grey'],
          ['balcony', 'tower', 'front', 1, 2, 2], ['balcony', 'tower', 'front', 2, 2, 2], ['balcony', 'tower', 'front', 3, 2, 2], ['balcony', 'tower', 'front', 4, 2, 2],
          ['cornice', 'tower', 5, 'white'],
          ['box', 0.2, 0.1, 0.2, 0.1, 1.62, -0.05, 'grey'], ['box', 0.5, 0.05, 0.045, 0.04, 0.29, 0.3525, 'hedge'],
        ] },
      ],
    },
  ],
};
