import type { KindDef, Op, Color } from './schema';
import { Zone } from './codes';
import { slab, van, tree, pine, fence } from './tierkit';
import { repeat } from './helpers';

/**
 * Refuse grades (docs/multiplayer-land.md section 5, M4): five placed refuse sites, civic sub-kinds of the transport-hub
 * family (code 15) like the power plants, kind ids 217-221. Each is a base for bin lorries and street sweepers (shared
 * fleet.ts mobileRole) and the place the rounds tip what they collect (server sim/refuse.ts); what the grade does with it
 * (landfill, recycle, compost, burn) sets its nuisance per tonne, the landfill levy it pays and what it earns back
 * (shared/src/refuse.ts REFUSE_GRADES). The `refuse` ladder, in grade order: open tip, lined landfill, recycling centre,
 * composting and digester site, energy-from-waste plant. All are 2×2, door on the front row.
 */

const OCCUPATION = {
  name: 'refuse worker', rotate: true,
  shifts: [{ start: 6, hours: 8, weight: 0.8 }, { start: 14, hours: 8, weight: 0.2 }],
  cycles: [[1, 1, 1, 1, 1, 0, 0], [0, 1, 1, 1, 1, 1, 0]],
};
const base = {
  code: Zone.Hub, family: 'utility' as const, flags: { civic: true, workplace: true }, windows: 'civic' as const,
  occupation: OCCUPATION, lot: { wage: 17 }, group: 'refuse',
  footprint: { w: 2, h: 2, door: [0, 1] as [number, number] },
  tints: [0xffffff, 0xf2efe8, 0xeef1f4],
};
const DIRT = 0x8a7a62, GRAVEL = 0xb3ab9c, CONCRETE = 0xa9acb1, LINER = 0x2d3134, CAP = 0x7fa05e, BIN = 0x4c7a3a;
const RUBBISH: Color[] = [0x9a8f7f, 0x7d7468, 0xb4a993, 0x6f6a5f, 0xa39278];

/** A heap of rubbish: a squat pyramid. */
const heap = (x: number, z: number, w: number, d: number, h: number, c: Color): Op => ['taper', w, d, w * 0.25, d * 0.3, h, x, 0.02, z, c];
/** A bulldozer pushing the face: body, cab and blade. */
const dozer = (x: number, z: number): Op[] => [
  ['box', 0.16, 0.06, 0.1, x, 0.02, z, 'yellow'], ['box', 0.07, 0.06, 0.08, x - 0.03, 0.08, z, 'glassDark'],
  ['box', 0.02, 0.06, 0.14, x + 0.1, 0.02, z, 'charcoal'],
];
/** A weighbridge hut by the gate. */
const hut = (x: number, z: number, w = 0.26, d = 0.18, h = 0.14, body: Color = 'brick'): Op[] => [
  ['box', w, h, d, x, 0.02, z, body, true], ['box', w + 0.02, 0.02, d + 0.02, x, 0.02 + h, z, 'dark'],
];
/** A coloured skip. */
const skip = (x: number, z: number, c: Color): Op => ['taper', 0.12, 0.08, 0.15, 0.09, 0.06, x, 0.02, z, c];
/** A ring of perimeter fence round the yard, open at the front middle. */
const yardFence = (c: Color = 0x5d6672): Op[] => [
  ...fence(0, -0.96, 1.92, true, c, 0.1), ...fence(-0.96, 0, 1.92, false, c, 0.1), ...fence(0.96, 0, 1.92, false, c, 0.1),
  ...fence(-0.6, 0.96, 0.72, true, c, 0.1), ...fence(0.6, 0.96, 0.72, true, c, 0.1),
];

// ================================================================= 1: the open tip

export const openTip: KindDef = {
  ...base, id: 'open-tip', name: 'open tip', kindId: 217, tier: 1,
  blurb: 'A hole in the ground with a bulldozer: the cheapest place to put a town\'s rubbish, and the worst neighbour. It smells, lorries queue at the gate and gulls follow them. Every tonne pays the landfill levy.',
  howTo: 'Two tiles by two on a road, downwind of town and well back from anyone else\'s land: it may push only so much smell, traffic and eyesore over a boundary. Bin lorries from here collect every district within 40 tiles. Needs Waste management.',
  tool: { id: 'opentip', key: '', label: 'Open tip (2×2)', color: '#8a7a62' },
  attrs: { refuse: 'tip', title: 'open tip' },
  levels: [{
    capacity: 9, wage: 17, cost: 1500, upkeep: 12, work: 260, parking: { surface: 2, underground: 2 },
    designs: [
      { name: 'raw tip: heaps of rubbish, a bulldozer on the face, a weighbridge hut', height: 0.35, ops: [
        slab(2, 2, DIRT),
        heap(-0.45, -0.4, 0.8, 0.7, 0.3, RUBBISH[0]), heap(0.4, -0.45, 0.7, 0.6, 0.24, RUBBISH[1]), heap(0.1, 0.05, 0.6, 0.5, 0.18, RUBBISH[2]),
        ...dozer(-0.2, 0.25), ...hut(0.55, 0.62), ...van(-0.5, 0.6, 'white', BIN),
        ...fence(0, -0.96, 1.92, true, 0x6b5e4c, 0.08),
      ] },
      { name: 'tip in an old quarry: one long face, a compactor and a skip line', height: 0.32, ops: [
        slab(2, 2, 0x7d6e58),
        heap(0, -0.5, 1.6, 0.7, 0.28, RUBBISH[3]), heap(-0.5, 0.0, 0.6, 0.4, 0.16, RUBBISH[4]),
        ...dozer(0.35, -0.05), ...hut(-0.55, 0.62, 0.22), ...repeat(3, (i): Op => skip(0.1 + i * 0.2, 0.55, i === 1 ? 'yellow' : BIN)),
      ] },
    ],
  }],
};

// ================================================================= 2: the lined landfill

export const linedLandfill: KindDef = {
  ...base, id: 'lined-landfill', name: 'lined landfill', kindId: 218, tier: 2,
  blurb: 'Engineered cells on a black liner, capped with clay and grass as they fill, the gas drawn off and the leachate tanked. Half the smell of a tip and tidier to look at; every tonne still pays the landfill levy.',
  howTo: 'Two tiles by two on a road. It can sit nearer neighbours than a tip, but not beside them. Bin lorries from here collect every district within 40 tiles. Needs Waste management.',
  tool: { id: 'landfill', key: '', label: 'Lined landfill (2×2)', color: '#5d7a52' },
  attrs: { refuse: 'landfill', title: 'landfill site' },
  levels: [{
    capacity: 10, wage: 18, cost: 4500, upkeep: 30, work: 420, parking: { surface: 2, underground: 2 },
    designs: [
      { name: 'an open lined cell, a capped green mound, a leachate tank and a gas flare', height: 0.4, ops: [
        slab(2, 2, GRAVEL),
        ['box', 0.9, 0.03, 0.8, -0.45, 0.02, -0.4, LINER], heap(-0.45, -0.4, 0.6, 0.5, 0.14, RUBBISH[0]),
        ['taper', 0.9, 0.8, 0.4, 0.3, 0.22, 0.45, 0.02, -0.4, CAP], ...dozer(-0.3, 0.1),
        ['cyl', 0.1, 0.1, 0.16, 0.6, 0.02, 0.3, CONCRETE, 10], ['cyl', 0.012, 0.012, 0.3, 0.3, 0.02, 0.3, 'steel', 6],
        ...hut(0.6, 0.66), ...yardFence(),
      ] },
      { name: 'two capped cells and a working cell, a weighbridge office', height: 0.36, ops: [
        slab(2, 2, GRAVEL),
        ['taper', 0.8, 0.8, 0.35, 0.35, 0.2, -0.5, 0.02, -0.5, CAP], ['taper', 0.8, 0.8, 0.35, 0.35, 0.18, 0.4, 0.02, -0.5, CAP],
        ['box', 0.9, 0.03, 0.5, -0.3, 0.02, 0.2, LINER], heap(-0.3, 0.2, 0.6, 0.3, 0.1, RUBBISH[1]),
        ...hut(0.55, 0.6, 0.3, 0.2, 0.16), ...yardFence(),
      ] },
    ],
  }],
};

// ================================================================= 3: the recycling centre

export const recyclingCentre: KindDef = {
  ...base, id: 'recycling-centre', name: 'recycling centre', kindId: 219, tier: 3,
  blurb: 'A sorting shed with balers and bays of skips: paper, glass, metal and plastic go back out as materials and earn money; only the residue goes to landfill. Little smell, but the shed and the lorries are noisy.',
  howTo: 'Two tiles by two on a road. Cheaper to run than a tip once the levy bites on a busy round. Restricted hours or screening quiet it for neighbours. Bin lorries from here collect every district within 40 tiles. Needs Recycling.',
  tool: { id: 'recycling', key: '', label: 'Recycling centre (2×2)', color: '#3f7f9a' },
  attrs: { refuse: 'recycling', title: 'recycling centre' },
  levels: [{
    capacity: 12, wage: 18, cost: 6000, upkeep: 40, work: 520, parking: { surface: 3, underground: 3 },
    designs: [
      { name: 'clad sorting shed, a row of coloured skips and bales', height: 0.5, ops: [
        slab(2, 2, CONCRETE),
        ['box', 1.2, 0.34, 0.7, -0.3, 0.02, -0.5, 0x6e8a99, true], ['roof', 1.24, 0.1, 0.74, -0.3, 0.36, -0.5, 'roofGrey'],
        ...repeat(4, (i): Op => skip(-0.6 + i * 0.3, 0.2, (['boxBlue', 'green', 'yellow', 'red'] as Color[])[i])),
        ...repeat(3, (i): Op => ['box', 0.1, 0.08, 0.1, 0.6, 0.02 + i * 0.08, -0.5, 0xc8b88a]),
        ...van(0.55, 0.55, 'white', BIN), ...yardFence(),
      ] },
      { name: 'two sheds, a conveyor and a baler yard', height: 0.48, ops: [
        slab(2, 2, CONCRETE),
        ['box', 0.8, 0.3, 0.6, -0.5, 0.02, -0.5, 0x7a8f6e, true], ['box', 0.6, 0.26, 0.6, 0.45, 0.02, -0.5, 0x6e8a99, true],
        ['box', 0.5, 0.04, 0.06, 0, 0.3, -0.3, 'steel'],
        ...repeat(5, (i): Op => ['box', 0.1, 0.08, 0.1, -0.5 + i * 0.13, 0.02, 0.25, 0xc8b88a]),
        ...repeat(3, (i): Op => skip(0.25 + i * 0.22, 0.3, (['boxBlue', 'green', 'yellow'] as Color[])[i])), ...yardFence(),
      ] },
    ],
  }],
};

// ================================================================= 4: composting and digester

export const compostingSite: KindDef = {
  ...base, id: 'compost-digester', name: 'composting and digester site', kindId: 220, tier: 4,
  blurb: 'Food and garden waste turned in long windrows and fed to sealed digesters: the gas is sold, the compost goes to farms. A light earthy smell and some lorries; very little goes to landfill.',
  howTo: 'Two tiles by two on a road. The gentlest grade: it can stand close to neighbours. It handles less a day than a tip. Bin lorries from here collect every district within 40 tiles. Needs Recycling.',
  tool: { id: 'compost', key: '', label: 'Composting and digester (2×2)', color: '#6f8f3a' },
  attrs: { refuse: 'compost', title: 'composting site' },
  levels: [{
    capacity: 10, wage: 18, cost: 8000, upkeep: 45, work: 560, parking: { surface: 2, underground: 2 },
    designs: [
      { name: 'windrows, two green digester domes and a gas holder', height: 0.5, ops: [
        slab(2, 2, GRAVEL),
        ...repeat(3, (i): Op => ['taper', 0.9, 0.12, 0.85, 0.02, 0.08, -0.45, 0.02, -0.7 + i * 0.22, 0x5b4632]),
        ['lathe', 0.35, 0.02, -0.5, BIN, [0.22, 0, 0.22, 0.22, 0.16, 0.32, 0, 0.36], { seg: 14 }],
        ['lathe', 0.35, 0.02, 0.05, BIN, [0.2, 0, 0.2, 0.2, 0.14, 0.3, 0, 0.33], { seg: 14 }],
        ['cyl', 0.012, 0.012, 0.32, 0.75, 0.02, -0.75, 'steel', 6],
        ...hut(-0.5, 0.6), ...tree(-0.85, 0.85, 0.8), ...tree(0.85, 0.85, 0.8),
      ] },
      { name: 'a covered compost barn and a tall digester tank', height: 0.55, ops: [
        slab(2, 2, GRAVEL),
        ['box', 1.0, 0.24, 0.6, -0.4, 0.02, -0.5, 0x8c7a5c], ['roof', 1.04, 0.1, 0.64, -0.4, 0.26, -0.5, 'roofGrey'],
        ['cyl', 0.24, 0.24, 0.4, 0.5, 0.02, -0.4, BIN, 14], ['cone', 0.25, 0.1, 0.5, 0.42, -0.4, 0x5f6b5e, 14],
        ...repeat(2, (i): Op => ['taper', 0.8, 0.12, 0.75, 0.02, 0.07, -0.3, 0.02, 0.15 + i * 0.22, 0x5b4632]),
        ...pine(0.85, 0.85, 0.8),
      ] },
    ],
  }],
};

// ================================================================= 5: energy from waste

export const incinerator: KindDef = {
  ...base, id: 'energy-from-waste', name: 'energy-from-waste plant', kindId: 221, tier: 5,
  blurb: 'A tipping hall, a furnace and a tall stack: rubbish burned to raise steam, the power sold. Hardly anything is landfilled, but the stack smokes and every unit of smoke pays the levy unless the plant is enclosed with scrubbers.',
  howTo: 'Two tiles by two on a road. Its smoke carries far downwind: an enclosure (scrubbers) halves it. The biggest throughput of any grade. Bin lorries from here collect every district within 40 tiles. Needs Energy from waste.',
  tool: { id: 'incinerator', key: '', label: 'Energy from waste (2×2)', color: '#7a6a80' },
  attrs: { refuse: 'incinerator', title: 'energy-from-waste plant' },
  levels: [{
    capacity: 14, wage: 21, cost: 14000, upkeep: 80, work: 900, parking: { surface: 3, underground: 4 },
    designs: [
      { name: 'clad hall with a curved roof and one tall stack', height: 1.8, ops: [
        slab(2, 2, CONCRETE),
        ['box', 1.4, 0.5, 0.9, -0.2, 0.02, -0.4, 0x7a6a80, true],
        ['lathe', -0.9, 0.52, -0.4, 'roofGrey', [0.45, 0, 0.45, 1.4], { axis: 'x', seg: 10 }],
        ['cyl', 0.07, 0.09, 1.7, 0.7, 0.02, -0.6, 'chimney', 10], ['cyl', 0.072, 0.072, 0.05, 0.7, 1.5, -0.6, 'red', 10],
        ['box', 0.03, 0.03, 0.03, 0.7, 1.72, -0.6, 'red', 'beacon'],
        ...van(-0.5, 0.55, 'white', BIN), ...van(-0.2, 0.55, 'white', BIN),
      ] },
      { name: 'brick furnace house, a tipping hall and twin stacks', height: 1.6, ops: [
        slab(2, 2, CONCRETE),
        ['box', 0.9, 0.6, 0.8, -0.4, 0.02, -0.45, 'brick', true], ['box', 0.7, 0.36, 0.6, 0.45, 0.02, -0.45, 0x8e9aa6, true],
        ['cyl', 0.05, 0.07, 1.5, 0.75, 0.02, -0.88, 'chimney', 10], ['cyl', 0.05, 0.07, 1.5, 0.55, 0.02, -0.88, 'chimney', 10],
        ['box', 0.03, 0.03, 0.03, 0.75, 1.52, -0.88, 'red', 'beacon'],
        ...van(0.4, 0.55, 'white', BIN),
      ] },
    ],
  }],
};

/** The refuse grades in ladder order (catalogue.ts lists them after the power kinds). */
export const REFUSE_SITES: KindDef[] = [openTip, linedLandfill, recyclingCentre, compostingSite, incinerator];
