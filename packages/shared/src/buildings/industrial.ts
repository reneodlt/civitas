import type { KindDef } from './schema';
import { Zone } from './codes';
import { repeat } from './helpers';
import { van, fence, ASPHALT } from './tierkit';

/** who redrew the thin originals (docs/buildings.md "Redesigns") */
const FABLE = 'claude-fable-5-1';

export const industrial: KindDef = {
  id: 'industrial', name: 'industrial', code: Zone.Industrial, family: 'industrial',
  flags: { growable: true, workplace: true },
  windows: 'factory',
  tool: { id: 'ind', key: '6', label: 'Industrial', color: 'var(--ind)' },
  blurb: 'Factories and warehouses: well-paid shift work round the clock, and the delivery trucks that keep the shops stocked. Industry is noisy and dirty, and its trucks fill the roads by day.',
  howTo: 'Drag Industrial (6) over your own land beside a road. Keep it a little away from homes but within a short drive of shops; a freight yard within 12 tiles lets its deliveries go by train.',
  attrs: { goodsType: 'manufactured' },
  occupation: {
    name: 'factory worker', rotate: true,
    shifts: [{ start: 6, hours: 8, weight: 0.5 }, { start: 14, hours: 8, weight: 0.3 }, { start: 22, hours: 8, weight: 0.2 }],
    cycles: [[1, 1, 1, 1, 1, 0, 0], [1, 1, 1, 1, 0, 0, 1]],
  },
  tints: [0xffffff, 0xf2ebe0, 0xe8ebee, 0xf6e9d6, 0xe9eee6],
  lotTint: 0xf0c060,
  lot: { wage: 9 },
  levels: [
    {
      capacity: 6, wage: 14, work: 60, parking: { surface: 2, underground: 4 },
      attrs: { pollution: 1, noise: 2 },
      designs: [
        { name: 'corrugated warehouse with two roller doors, a gatehouse office, a flue and a van on the apron', height: 0.7, author: FABLE, attrs: { goodsType: 'storage' }, ops: [
          ['box', 0.8, 0.4, 0.6, 0, 0, -0.12, 'corrugated', true, { name: 'shed', facade: { storeys: 1, bays: 4, sideBays: 3, margin: 0.04 } }],
          ['garage', 'shed', 'front', 1], ['garage', 'shed', 'front', 2], ['door', 'shed', 'front', 0],
          ['roof', 0.84, 0.16, 0.64, 0, 0.4, -0.12, 'roofGrey'],
          ['box', 0.8, 0.006, 0.28, 0, 0, 0.36, ASPHALT],
          ['box', 0.2, 0.22, 0.16, 0.34, 0.006, 0.36, 'pale', 'office', { name: 'office', facade: { storeys: 1, bays: 2, sideBays: 1, ground: 'door' } }],
          ['box', 0.22, 0.02, 0.18, 0.34, 0.226, 0.36, 'dark'],
          ['cyl', 0.03, 0.035, 0.3, -0.3, 0.4, -0.3, 'chimney', 6],
          ...van(-0.3, 0.36, 'white', 'boxBlue', false, 0), ['box', 0.1, 0.06, 0.1, 0.05, 0, 0.3, 'timber'],
          ...fence(-0.46, -0.1, 0.7, false, 'grey', 0.06),
        ] },
        { name: 'brick workshop with sawtooth roof and roller door', height: 0.5, ops: [
          ['box', 0.8, 0.36, 0.72, 0, 0, 0, 'brick', true],
          ...repeat(3, (i) => ['roof', 0.26, 0.13, 0.72, -0.27 + i * 0.27, 0.36, 0, 'roofGrey', true]),
          ['box', 0.3, 0.26, 0.02, 0.1, 0, 0.37, 'grey'], ['box', 0.2, 0.03, 0.02, 0.1, 0.26, 0.37, 'dark'],
        ] },
        { name: 'container yard with a shed', height: 0.36, attrs: { goodsType: 'freight', noise: 3 }, ops: [
          ['box', 0.3, 0.26, 0.3, -0.28, 0, -0.25, 'corrugated', true], ['roof', 0.34, 0.08, 0.34, -0.28, 0.26, -0.25, 'roofGrey'],
          ['box', 0.4, 0.14, 0.16, 0.15, 0, -0.3, 'boxBlue'], ['box', 0.4, 0.14, 0.16, 0.15, 0.14, -0.3, 'boxOrange'],
          ['box', 0.4, 0.14, 0.16, 0.15, 0, -0.1, 'rust'], ['box', 0.4, 0.14, 0.16, 0.15, 0, 0.1, 'boxGreen'],
          ['box', 0.4, 0.14, 0.16, 0.15, 0.14, 0.1, 'silver'], ['box', 0.16, 0.14, 0.4, -0.3, 0, 0.22, 'boxBlue'],
        ] },
        { name: 'depot with three bay doors and a tank', height: 0.4, attrs: { goodsType: 'freight' }, ops: [
          ['box', 0.86, 0.3, 0.5, 0, 0, -0.15, 'corrugated', true], ['box', 0.88, 0.03, 0.52, 0, 0.3, -0.15, 'roofGrey'],
          ['box', 0.2, 0.24, 0.02, -0.27, 0, 0.11, 'dark'], ['box', 0.2, 0.24, 0.02, 0, 0, 0.11, 'dark'], ['box', 0.2, 0.24, 0.02, 0.27, 0, 0.11, 'dark'],
          ['cyl', 0.1, 0.1, 0.26, 0.3, 0, 0.32, 'steel', 10], ['cyl', 0.02, 0.02, 0.4, -0.32, 0, 0.32, 'chimney', 6],
        ] },
      ],
    },
    {
      capacity: 12, wage: 19, work: 120, parking: { surface: 2, underground: 8 }, feature: 'level2',
      attrs: { pollution: 2, noise: 3 },
      designs: [
        { name: 'sawtooth factory with chimney', height: 1.26, ops: [
          ['box', 0.86, 0.55, 0.8, 0, 0, 0, 'corrugated', true],
          ...repeat(3, (i) => ['roof', 0.28, 0.14, 0.8, -0.29 + i * 0.29, 0.55, 0, 'rust', true]),
          ['cyl', 0.05, 0.06, 0.65, 0.33, 0.55, -0.3, 'chimney'], ['cyl', 0.055, 0.055, 0.06, 0.33, 1.2, -0.3, 'red'],
        ] },
        { name: 'grain silos and a shed', height: 1.0, attrs: { goodsType: 'food', pollution: 1 }, ops: [
          ['box', 0.5, 0.5, 0.7, -0.18, 0, 0, 'corrugated', true], ['roof', 0.54, 0.12, 0.74, -0.18, 0.5, 0, 'roofGrey', true],
          ['cyl', 0.12, 0.12, 0.9, 0.25, 0, -0.2, 'steel', 12], ['cone', 0.12, 0.1, 0.25, 0.9, -0.2, 'grey', 12],
          ['cyl', 0.12, 0.12, 0.9, 0.25, 0, 0.1, 'steel', 12], ['cone', 0.12, 0.1, 0.25, 0.9, 0.1, 'grey', 12],
          ['box', 0.3, 0.05, 0.05, 0.05, 0.75, -0.05, 'dark'],
        ] },
        { name: 'gabled warehouse with loading dock and vents', height: 0.95, attrs: { goodsType: 'storage' }, ops: [
          ['box', 0.86, 0.6, 0.8, 0, 0, -0.03, 'pale', true], ['roof', 0.9, 0.22, 0.84, 0, 0.6, -0.03, 'roofGrey'],
          ['box', 0.86, 0.1, 0.14, 0, 0, 0.42, 'grey'], ['box', 0.2, 0.3, 0.02, -0.25, 0.1, 0.38, 'dark'], ['box', 0.2, 0.3, 0.02, 0.1, 0.1, 0.38, 'dark'],
          ['cyl', 0.04, 0.04, 0.12, -0.2, 0.8, -0.1, 'chimney', 8], ['cyl', 0.04, 0.04, 0.12, 0.2, 0.8, -0.1, 'chimney', 8],
        ] },
        { name: 'brick mill with two stacks', height: 1.2, attrs: { goodsType: 'textiles' }, ops: [
          ['box', 0.7, 0.7, 0.76, -0.06, 0, 0, 'brick', true], ['box', 0.74, 0.04, 0.8, -0.06, 0.7, 0, 'dark'], ['box', 0.3, 0.1, 0.3, -0.15, 0.7, -0.1, 'grey'],
          ['chimneyStack', 0.36, 0, -0.25, 1.1, 0.05, 'brick'], ['chimneyStack', 0.36, 0, 0.15, 0.9, 0.05, 'brick'],
        ] },
      ],
    },
    {
      capacity: 18, wage: 24, work: 180, parking: { surface: 2, underground: 12 }, feature: 'level3',
      attrs: { pollution: 4, noise: 4 },
      designs: [
        { name: 'plant with chimney and tanks', height: 2.1, attrs: { goodsType: 'chemicals' }, ops: [
          ['box', 0.88, 0.7, 0.88, 0, 0, 0, 'plant', true],
          ['cyl', 0.06, 0.08, 1.3, -0.3, 0.7, -0.3, 'chimney'], ['cyl', 0.065, 0.065, 0.08, -0.3, 2.0, -0.3, 'red'],
          ['cyl', 0.13, 0.13, 0.45, 0.25, 0.7, 0.25, 'steel', 10], ['cyl', 0.13, 0.13, 0.45, 0.25, 0.7, -0.08, 'steel', 10],
          ['box', 0.5, 0.08, 0.08, -0.1, 0.74, 0.38, 'yellow'],
        ] },
        { name: 'refinery towers, pipework and flare', height: 2.1, attrs: { goodsType: 'fuel', pollution: 5 }, ops: [
          ['box', 0.5, 0.4, 0.6, -0.2, 0, 0.1, 'plant', true],
          ['cyl', 0.07, 0.07, 1.6, 0.25, 0, -0.25, 'steel', 10], ['cyl', 0.06, 0.06, 1.2, 0.25, 0, 0.05, 'steel', 10],
          ['cyl', 0.04, 0.04, 2.0, 0.32, 0, 0.3, 'steel', 8], ['cyl', 0.03, 0.03, 0.08, 0.32, 2.0, 0.3, 'flare', 6],
          ['box', 0.5, 0.04, 0.04, 0, 0.9, -0.25, 'chimney'], ['box', 0.04, 0.04, 0.5, 0.25, 0.6, -0.1, 'chimney'],
          ['cyl', 0.14, 0.14, 0.3, -0.25, 0, -0.25, 'silver', 12],
        ] },
        { name: 'heavy works with three stacks', height: 1.95, attrs: { goodsType: 'steel', noise: 5 }, ops: [
          ['box', 0.88, 0.8, 0.86, 0, 0, 0, 'charcoal', true], ['box', 0.9, 0.04, 0.88, 0, 0.8, 0, 'roofGrey'],
          ['box', 0.16, 0.12, 0.16, -0.2, 0.84, 0.2, 'grey'], ['box', 0.16, 0.12, 0.16, 0.2, 0.84, 0.2, 'grey'], ['box', 0.3, 0.3, 0.02, 0.1, 0, 0.44, 'dark'],
          ['chimneyStack', -0.3, 0.8, -0.3, 1.1, 0.05], ['chimneyStack', -0.05, 0.8, -0.3, 1.1, 0.05], ['chimneyStack', 0.2, 0.8, -0.3, 1.1, 0.05],
        ] },
        { name: 'cooling towers beside a hall', height: 1.66, attrs: { goodsType: 'power' }, ops: [
          ['box', 0.5, 0.5, 0.86, -0.2, 0, 0, 'pale', true], ['box', 0.52, 0.04, 0.88, -0.2, 0.5, 0, 'dark'],
          ['cyl', 0.14, 0.2, 1.3, 0.25, 0, -0.22, 'stone', 14], ['cyl', 0.14, 0.2, 1.3, 0.25, 0, 0.22, 'stone', 14],
          ['cyl', 0.02, 0.02, 1.6, -0.36, 0, -0.36, 'chimney', 6], ['cyl', 0.025, 0.025, 0.06, -0.36, 1.6, -0.36, 'red', 6],
        ] },
      ],
    },
  ],
};
