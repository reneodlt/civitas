/**
 * Size ladders (docs/buildings.md "Groups and tiers"). A kind with `group` and `tier` is one rung of a ladder: the
 * tool bar shows one button per group and a size picker lists its tiers, smallest first. Every kind in a group
 * shares a family code, so the simulation treats them as one service (coverage, patrols, the building index) and
 * reads the per-tier numbers from the tables and attributes. Groups marked `reserved` belong to other cards and
 * have no kinds yet; their names are taken so nothing else claims them.
 */
export interface GroupDef {
  id: string;
  /** tool bar label */
  label: string;
  /** tool bar section the group's button sits in */
  section: 'Services' | 'Transport' | 'Leisure' | 'Landmarks';
  /** swatch colour of the group's button */
  color: string;
  /** what one tier holds, for the picker's capacity line: 'staff', 'builders', 'bays', 'visitors' */
  holds: string;
  reserved?: boolean;
  /**
   * A collection rather than a size ladder (the landmarks): its rungs are separate buildings of any family, in `tier`
   * order, so the one-family-code rule and the never-shrinks-up-the-ladder checks do not apply. The picker lists them the same way.
   */
  collection?: boolean;
  /**
   * A ladder of stages rather than sizes (education): tiers run in the order a pupil moves up, so what a rung holds and
   * what it costs need not grow with the tier. Build work still grows with the footprint.
   */
  stages?: boolean;
  /** What a collection's rungs are called in the picker and its tooltips ('landmarks' when unset): 'places' for the leisure collections. */
  noun?: string;
  /** A ladder still in development: every rung may be a draft (validation otherwise calls that a mistake). Drop it when the first rung goes live. */
  draft?: boolean;
}

export const GROUPS: GroupDef[] = [
  { id: 'health', label: 'Health', section: 'Services', color: '#f4f4f4', holds: 'staff' },
  { id: 'police', label: 'Police', section: 'Services', color: '#3454a8', holds: 'officers' },
  { id: 'fire', label: 'Fire', section: 'Services', color: '#d6453a', holds: 'firefighters' },
  { id: 'builders', label: 'Builders', section: 'Services', color: '#a8713f', holds: 'builders' },
  { id: 'parking', label: 'Parking', section: 'Transport', color: '#5c6270', holds: 'bays' },
  { id: 'metro', label: 'Underground', section: 'Transport', color: '#dc241f', holds: 'staff' },
  // harbours (docs/boats.md section 5): a jetty up to a cargo port
  { id: 'harbour', label: 'Harbours', section: 'Transport', color: '#2f7fb0', holds: 'staff' },
  { id: 'park', label: 'Parks', section: 'Leisure', color: '#4f9a5c', holds: 'visitors' },
  { id: 'cinema', label: 'Cinemas', section: 'Leisure', color: '#b8434f', holds: 'seats' },
  { id: 'theatre', label: 'Theatres', section: 'Leisure', color: '#7a3e8f', holds: 'seats' },
  { id: 'sports', label: 'Sport', section: 'Leisure', color: '#2f6fb5', holds: 'visitors' },
  { id: 'library', label: 'Libraries', section: 'Leisure', color: '#a8875a', holds: 'visitors' },
  // free-time places (buildings/attractions.ts, docs/leisure.md): four collections of different places rather than size ladders,
  // each place its own kind of outing with its own first-person scene
  { id: 'outdoors', label: 'Play and green', section: 'Leisure', color: '#5aa04a', holds: 'visitors', collection: true, noun: 'places' },
  { id: 'active', label: 'Active fun', section: 'Leisure', color: '#2f8fc0', holds: 'visitors', collection: true, noun: 'places' },
  { id: 'daysout', label: 'Days out', section: 'Leisure', color: '#d9822b', holds: 'visitors', collection: true, noun: 'places' },
  { id: 'hobbies', label: 'Arts and games', section: 'Leisure', color: '#9a4f9e', holds: 'visitors', collection: true, noun: 'places' },
  // education (docs/education.md section 3): nursery to research institute, sub-kinds of the library family (code 14)
  { id: 'education', label: 'Education', section: 'Services', color: '#d8b25a', holds: 'pupils', stages: true },
  // broadcasters (docs/media.md): a local TV studio, a broadcast centre and a media centre with a news helipad (buildings/media.ts)
  { id: 'media', label: 'Media', section: 'Services', color: '#c8463c', holds: 'staff' },
  // death and remembrance (docs/remembrance.md): churchyard, municipal and garden cemetery, crematorium (buildings/remembrance.ts);
  // `stages`: the crematorium, last, is smaller and cheaper than the garden cemetery and takes in more
  { id: 'remembrance', label: 'Cemeteries', section: 'Services', color: '#5d7a52', holds: 'plots', stages: true },
  // utilities (docs/utilities.md): the power network's nodes and depot, and its plants (buildings/utilities.ts)
  { id: 'grid', label: 'Power grid', section: 'Services', color: '#d9a43a', holds: 'staff', stages: true },
  { id: 'power', label: 'Power stations', section: 'Services', color: '#8f9aa6', holds: 'staff' },
  // landmarks (docs/buildings.md "Landmarks"): real buildings, one picker per city; buildings/landmarks-london.ts
  { id: 'london', label: 'London', section: 'Landmarks', color: '#c8102e', holds: 'staff', collection: true },
  // world landmarks (buildings/landmarks-world*.ts): the same, for cities around the world; one picker per city
  { id: 'new-york', label: 'New York', section: 'Landmarks', color: '#1c2f5e', holds: 'staff', collection: true },
  { id: 'cairo', label: 'Cairo', section: 'Landmarks', color: '#c8a44a', holds: 'staff', collection: true },
  { id: 'dubai', label: 'Dubai', section: 'Landmarks', color: '#b0722e', holds: 'staff', collection: true },
  { id: 'shanghai', label: 'Shanghai', section: 'Landmarks', color: '#c9372c', holds: 'staff', collection: true },
  { id: 'paris', label: 'Paris', section: 'Landmarks', color: '#28418c', holds: 'staff', collection: true },
  { id: 'rome', label: 'Rome', section: 'Landmarks', color: '#8a2b23', holds: 'staff', collection: true },
  { id: 'beijing', label: 'Beijing', section: 'Landmarks', color: '#9e2b22', holds: 'staff', collection: true },
  { id: 'rio', label: 'Rio de Janeiro', section: 'Landmarks', color: '#e07b39', holds: 'staff', collection: true },
  { id: 'sydney', label: 'Sydney', section: 'Landmarks', color: '#2c5f9e', holds: 'staff', collection: true },
  { id: 'san-francisco', label: 'San Francisco', section: 'Landmarks', color: '#c0362c', holds: 'staff', collection: true },
  { id: 'barcelona', label: 'Barcelona', section: 'Landmarks', color: '#c95f2c', holds: 'staff', collection: true },
  { id: 'kuala-lumpur', label: 'Kuala Lumpur', section: 'Landmarks', color: '#4a7fb5', holds: 'staff', collection: true },
  { id: 'toronto', label: 'Toronto', section: 'Landmarks', color: '#2c8a5f', holds: 'staff', collection: true },
  { id: 'seattle', label: 'Seattle', section: 'Landmarks', color: '#3a6b8a', holds: 'staff', collection: true },
  { id: 'agra', label: 'Agra', section: 'Landmarks', color: '#b8874a', holds: 'staff', collection: true },
  // reserved for other cards
  { id: 'bus', label: 'Buses', section: 'Transport', color: '#e0a92e', holds: 'staff', reserved: true },
  { id: 'rail', label: 'Rail', section: 'Transport', color: '#b0563d', holds: 'staff', reserved: true },
  { id: 'airport', label: 'Airports', section: 'Transport', color: '#2b2e33', holds: 'staff', reserved: true },
];
export const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));
