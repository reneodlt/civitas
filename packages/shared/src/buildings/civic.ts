import type { KindDef, Op } from './schema';
import { Zone } from './codes';
import { helipad, car, van, engine, lampPost, mast, bayLines, PAVING } from './tierkit';

/** who redrew the one-design originals (docs/buildings.md "Redesigns") */
const FABLE = 'claude-fable-5-1';
/** a patrol car: white, a navy stripe and a blue light bar */
const patrolCar = (x: number, z: number, alongX = false, y = 0.02): Op[] => [
  ...car(x, z, 'white', alongX, y),
  ['box', alongX ? 0.204 : 0.104, 0.012, alongX ? 0.104 : 0.204, x, y + 0.025, z, 'navy'],
  ['box', alongX ? 0.02 : 0.06, 0.012, alongX ? 0.06 : 0.02, x, y + 0.08, z, 'signBlue'],
];

/** Staffed civic buildings: placed by a player, built by builders, paid for daily. One level each. */
export const police: KindDef = {
  id: 'police', name: 'police station', code: Zone.Police, family: 'civic',
  flags: { civic: true, service: true, workplace: true },
  windows: 'civic',
  tool: { id: 'police', key: '8', label: 'Police station', color: '#3454a8' },
  group: 'police', tier: 3,
  blurb: 'The town police station: a dozen officers on rotating shifts, a front counter and patrol cars. A full police service for the homes around it.',
  howTo: 'One tile beside a road. Smaller posts and boxes fill gaps; a divisional station or headquarters covers more.',
  occupation: {
    name: 'police officer', rotate: true,
    shifts: [{ start: 7, hours: 8, weight: 1 }, { start: 15, hours: 8, weight: 1 }, { start: 23, hours: 8, weight: 1 }],
    cycles: [[1, 1, 1, 1, 0, 0, 1], [1, 1, 1, 1, 1, 0, 0]],
  },
  lot: { wage: 20 },
  levels: [{
    capacity: 12, wage: 20, cost: 400, upkeep: 20, work: 300, parking: { surface: 4, underground: 10 },
    designs: [{ name: 'two-storey station with a navy fascia, a blue lamp, a radio mast and a patrol car bay', height: 1.14, author: FABLE, ops: [
      ['box', 0.96, 0.02, 0.96, 0, 0, 0, PAVING],
      ['box', 0.6, 0.56, 0.6, -0.12, 0.02, -0.1, 0xe1e5ec, true, { name: 'station', facade: { storeys: 2, bays: 4, sideBays: 4, ground: 'door', margin: 0.03 } }],
      ['cornice', 'station', 1, 'navy'], ['cornice', 'station', 2, 'dark'],
      // the entrance canopy on its own posts, clear of the wall; the blue lamp beside it
      ['box', 0.2, 0.02, 0.06, -0.05, 0.26, 0.27, 'navy'], ['box', 0.02, 0.24, 0.02, -0.13, 0.02, 0.29, 'charcoal'], ['box', 0.02, 0.24, 0.02, 0.03, 0.02, 0.29, 'charcoal'],
      ...lampPost(0.1, 0.27, 0.3, 'signBlue', 0.02),
      ...mast(-0.32, 0.61, -0.3, 0.5), ['box', 0.12, 0.08, 0.12, 0.05, 0.61, -0.3, 'grey'],
      // the patrol car bay down the right side, a second car at the kerb
      ...bayLines(0.24, 0.1, 1, 0.14, 0.24, 0.02), ...patrolCar(0.31, 0.1), ...patrolCar(0.31, 0.38, true),
      ['flag', 0.38, 0.02, -0.4, 'navy'],
    ] }],
  }],
};

export const fire: KindDef = {
  id: 'fire', name: 'fire station', code: Zone.Fire, family: 'civic',
  flags: { civic: true, service: true, workplace: true },
  windows: 'civic',
  tool: { id: 'fire', key: '9', label: 'Fire station', color: '#d6453a' },
  group: 'fire', tier: 2,
  blurb: 'Two appliance bays, a drill tower and a watch on 24-hour shifts. A full fire service for the homes around it.',
  howTo: 'One tile beside a road. Fire posts fill gaps cheaply; a large station covers more.',
  occupation: {
    name: 'firefighter', rotate: true,
    shifts: [{ start: 8, hours: 24, weight: 1 }],
    cycles: [[1, 0, 0]],
  },
  lot: { wage: 20 },
  levels: [{
    capacity: 9, wage: 20, cost: 400, upkeep: 20, work: 300, parking: { surface: 3, underground: 6 },
    designs: [{ name: 'brick fire station with two appliance bays, a watch room, a drill tower and an engine on the apron', height: 1.35, author: FABLE, ops: [
      ['box', 0.96, 0.02, 0.96, 0, 0, 0, PAVING],
      // two appliance bays and a personnel door on the ground floor, the watch room above
      ['box', 0.62, 0.62, 0.5, -0.1, 0.02, -0.17, 'brick', true, { name: 'hall', facade: { storeys: 2, bays: 3, sideBays: 3, ground: 'garage', margin: 0.04 } }],
      ['door', 'hall', 'front', 2],
      ['cornice', 'hall', 1, 'stone'], ['cornice', 'hall', 2, 'dark'],
      // the drill tower covers the back cell of the hall's right wall
      ['box', 0.2, 1.1, 0.18, 0.31, 0.02, -0.33, 'brick'], ['box', 0.22, 0.03, 0.2, 0.31, 1.12, -0.33, 'dark'], ['flag', 0.31, 1.15, -0.33, 'red'],
      ['box', 0.14, 0.08, 0.12, -0.25, 0.67, -0.3, 'grey'],
      ...lampPost(0.33, 0.2, 0.26, 'red', 0.02),
      ...bayLines(-0.3, 0.3, 2, 0.2, 0.3, 0.02), ...engine(-0.2, 0.3, false, 0.02),
    ] }],
  }],
};

export const hospital: KindDef = {
  id: 'hospital', name: 'hospital', code: Zone.Hospital, family: 'civic',
  flags: { civic: true, service: true, workplace: true },
  windows: 'civic',
  tool: { id: 'hospital', key: '0', label: 'Hospital', color: '#f4f4f4' },
  group: 'health', tier: 4,
  blurb: 'A compact city hospital stacked on one plot: wards, a casualty door and a helipad, with ambulances out. A full health service for the homes around it.',
  howTo: 'One tile beside a road. Space-efficient but cramped; the community and general hospitals reach further.',
  occupation: {
    name: 'hospital staff', rotate: true,
    shifts: [{ start: 7, hours: 12, weight: 1 }, { start: 19, hours: 12, weight: 0.8 }],
    cycles: [[1, 1, 1, 0, 0, 0, 0], [1, 1, 0, 0, 1, 1, 0]],
  },
  lot: { wage: 26 },
  levels: [{
    capacity: 24, wage: 26, cost: 900, upkeep: 50, work: 300, parking: { surface: 6, underground: 20 },
    designs: [{ name: 'white ward block over a glazed outpatients wing, an A&E canopy, a rooftop helipad and an ambulance', height: 1.22, author: FABLE, ops: [
      ['box', 0.96, 0.02, 0.96, 0, 0, 0, PAVING],
      ['box', 0.6, 1.1, 0.5, 0.1, 0.02, -0.2, 'white', true, { name: 'wards', facade: { storeys: 4, bays: 4, sideBays: 3, margin: 0.04 } }],
      // the wing covers the ward block's first bay; the ward block hides the wing's right-hand back bay
      ['box', 0.34, 0.275, 0.34, -0.2, 0.02, 0.22, 'glassDark', 'office', { name: 'wing', facade: { storeys: 1, bays: 2, sideBays: 2, ground: 'door' } }],
      ['box', 0.34, 0.02, 0.3, -0.2, 0.295, 0.24, 'dark'],
      ['box', 0.26, 0.02, 0.07, -0.12, 0.26, 0.465, 'crossRed'], ['box', 0.02, 0.24, 0.02, -0.23, 0.02, 0.48, 'charcoal'], ['box', 0.02, 0.24, 0.02, -0.01, 0.02, 0.48, 'charcoal'],
      // the roof: the cross, the helipad helicopters find (shared/src/helipads.ts) and the lift motor room
      ['box', 0.16, 0.05, 0.04, -0.1, 1.12, -0.2, 'crossRed'], ['box', 0.04, 0.05, 0.16, -0.1, 1.12, -0.2, 'crossRed'],
      ...helipad(0.2, 1.12, -0.2, 0.16),
      ['box', 0.12, 0.1, 0.12, -0.12, 1.12, -0.38, 'grey'],
      ...van(0.3, 0.3, 'white', 'crossRed', false, 0.02), ...bayLines(0.21, 0.3, 1, 0.18, 0.3, 0.02, 'yellow'),
      ...lampPost(0.42, 0.44, 0.26, 'crossRed', 0.02),
    ] }],
  }],
};

/** The builders' yard is civic (placed, staffed, upkeep) but covers no homes. */
export const yard: KindDef = {
  id: 'yard', name: "builders' yard", code: Zone.Yard, family: 'civic',
  flags: { civic: true, workplace: true },
  windows: 'none',
  tool: { id: 'yard', key: 'Y', label: "Builders' yard", color: '#a8713f' },
  group: 'builders', tier: 2,
  blurb: 'Ten builders, a shed and a tower crane. Builders go to the most urgent site anywhere on the road network and earn the yard\'s owner a fee.',
  howTo: 'One tile beside a road. Nothing gets built without builders; place one early.',
  occupation: {
    name: 'builder', rotate: true,
    shifts: [{ start: 7, hours: 8, weight: 0.6 }, { start: 8, hours: 8, weight: 0.4 }],
    cycles: [[1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 0, 0]],
  },
  lot: { wage: 16 },
  levels: [{
    capacity: 10, wage: 16, cost: 300, upkeep: 15, work: 300, parking: { surface: 6, underground: 10 },
    designs: [{ name: 'yard behind a hoarding: a site office, a materials shed, pallets and heaps, a lorry and a tower crane', height: 1.02, author: FABLE, ops: [
      ['box', 0.96, 0.02, 0.96, 0, 0, 0, 'gravel'],
      // the plywood hoarding along the front with a gate gap, a yellow rail on top
      ['box', 0.5, 0.14, 0.012, -0.2, 0.02, 0.46, 0xcbb994], ['box', 0.5, 0.012, 0.016, -0.2, 0.16, 0.46, 'yellow'],
      ['box', 0.16, 0.14, 0.012, 0.37, 0.02, 0.46, 0xcbb994], ['box', 0.16, 0.012, 0.016, 0.37, 0.16, 0.46, 'yellow'],
      ['box', 0.3, 0.2, 0.18, -0.3, 0.02, -0.34, 'pale', 'office', { name: 'cabin', facade: { storeys: 1, bays: 2, sideBays: 1, ground: 'door' } }],
      ['box', 0.32, 0.02, 0.2, -0.3, 0.22, -0.34, 'dark'],
      ['box', 0.34, 0.26, 0.3, 0.26, 0.02, -0.3, 'corrugated'], ['roof', 0.38, 0.1, 0.34, 0.26, 0.28, -0.3, 'roofGrey'],
      ['box', 0.12, 0.08, 0.12, 0.3, 0.02, 0.1, 'brick'], ['box', 0.12, 0.06, 0.12, 0.15, 0.02, 0.12, 'sand'], ['box', 0.2, 0.05, 0.1, -0.05, 0.02, 0.2, 'timber'],
      ['cone', 0.11, 0.09, -0.28, 0.02, 0.05, 'sand', 7], ['cone', 0.09, 0.07, -0.1, 0.02, -0.05, 'grey', 7],
      ['cyl', 0.03, 0.04, 0.06, 0.05, 0.02, 0.3, 'boxOrange', 6],
      ['crane', -0.12, 0.02, -0.1, 1.0],
      ...van(0.3, 0.3, 'yellow', 'dark', false, 0.02),
    ] }],
  }],
};
