import type { DemoPlacement, DemoSection, DemoXY } from './showcase';
import { FRONT } from '../structures';
import { WORLD_LANDMARKS } from '../buildings/landmarks-world';

/**
 * The rest of London (docs/demo.md "London", "Keeping it complete"): every kind a player can place stands in London,
 * where its real counterpart does. The Landmarks, Schools, Rail, Buses, Thames and Underground sections place the
 * landmarks, stations, stops and harbours; this one places the civic, utility, media, remembrance, health, police,
 * fire, builders, research, leisure and transport kinds those leave out, so the demo shows the whole catalogue at the
 * size of a real city, and `londonProblems` (showcase.ts) fails `demo:check` for a kind added without a London home.
 *
 * It is all data. london.ts fits the multi-tile spots with its landmarks, before any street is laid (a road runs
 * along each front, as for a school), and the 1×1 spots on frontage lots near their real places once the streets are
 * laid (as it does the theatres), then hands both lists to `kindsSection`. Nothing here plans anything.
 */

type Side = 'S' | 'E' | 'N' | 'W';
/** A structure where a real one stands: id, kind, latitude, longitude, the side its door faces and (where the map's river strays from the real one) its bank. */
type Spot = readonly [id: string, kind: string, lat: number, lon: number, side: Side, bank?: 'N' | 'S'];
const SIDES = { S: 0, E: 1, N: 2, W: 3 } as const;

/**
 * The multi-tile kinds, fitted after the landmarks as near the real place as the land allows. The power stations stand
 * on their rivers' banks (Battersea on the south bank, Beckton on the north), the grid supply point by the Thames
 * Barrier where the National Grid's cables cross the river, the solar farm on the Rainham marshes.
 */
export const KIND_SPOTS: Spot[] = [
  // power (docs/utilities.md): Battersea's coal station, Beckton's gas works, the grid supply point at Silvertown by the Barrier,
  // Lots Road's depot (the Chelsea power station's lineworkers), the Rainham marshes' solar farm
  ['battersea-power', 'coal-plant', 51.4819, -0.1445, 'S'],
  ['beckton-gas', 'gas-plant', 51.5133, 0.0703, 'W'],
  ['barrier-grid', 'grid-supply-point', 51.5010, 0.0360, 'E', 'N'],
  ['lots-road-depot', 'power-depot', 51.4777, -0.1819, 'N', 'N'],
  ['rainham-solar', 'solar-farm', 51.5170, 0.1500, 'W', 'N'],
  // media (docs/media.md): Broadcasting House on Portland Place, ITV on the South Bank
  ['broadcasting-house', 'broadcast-centre', 51.5185, -0.1439, 'E'],
  ['itv-south-bank', 'media-centre', 51.5072, -0.1105, 'N', 'S'],
  // remembrance (docs/remembrance.md): St Paul's churchyard, the City of London Cemetery at Manor Park
  ['st-pauls-churchyard', 'churchyard', 51.5134, -0.0990, 'N'],
  ['city-of-london-cemetery', 'municipal-cemetery', 51.5530, 0.0500, 'W'],
  // health: Guy's by the Shard, the walk-in centre in Brixton, the health centre in Hackney
  ['guys-hospital', 'community-hospital', 51.4995, -0.0870, 'W', 'S'],
  ['walk-in-brixton', 'walk-in-centre', 51.4690, -0.1130, 'N'],
  ['health-centre-hackney', 'health-centre', 51.5460, -0.0520, 'W'],
  // police and fire: Brixton's divisional station, Shoreditch's large fire station
  ['brixton-police', 'divisional-station', 51.4590, -0.1120, 'W'],
  ['shoreditch-fire', 'large-fire-station', 51.5255, -0.0785, 'N'],
  // builders at Stratford, where the Olympic Park went up
  ['stratford-depot', 'builders-depot', 51.5400, -0.0030, 'E'],
  ['stratford-buildco', 'construction-company', 51.5450, -0.0100, 'N'],
  // education the Schools section leaves out: halls by UCL, a sixth form in Camden, Kingsway College by King's Cross,
  // Imperial's research campus at White City, Roehampton's university campus
  ['halls-bloomsbury', 'halls', 51.5230, -0.1290, 'W'],
  ['sixth-form-camden', 'sixth-form', 51.5390, -0.1420, 'N'],
  ['kingsway-college', 'fe-college', 51.5330, -0.1230, 'E'],
  ['imperial-research', 'research-institute', 51.5170, -0.2340, 'N'],
  ['roehampton', 'university', 51.4530, -0.2400, 'E'],
  // leisure: the Royal Albert Hall, Westfield Stratford's screens
  ['royal-albert-hall', 'opera-house', 51.5010, -0.1774, 'S'],
  ['westfield-screens', 'big-screens', 51.5430, -0.0089, 'W'],
  // transport: Westfield's car park, Brent Cross's park and ride at the edge, Kensington Olympia's halt
  ['westfield-parking', 'multi-storey', 51.5071, -0.2210, 'E'],
  ['brent-cross-park-ride', 'park-and-ride', 51.5760, -0.2240, 'N'],
  ['olympia-halt', 'rail-halt', 51.4980, -0.2100, 'N'],
  // free-time places (docs/leisure.md): the allotments by Fulham Palace, Walthamstow Wetlands' fishing lakes, the London
  // Wetland Centre at Barnes, Brockwell Lido, Queen's Club, the lanes off Brick Lane, Queens ice rink in Bayswater, a
  // trampoline park in Wandsworth, the karts at Canning Town, Hyde Park's winter funfair, Mudchute Farm, the aquarium in
  // the Horniman at Forest Hill, Greenwich's planetarium, the Science Museum and the Barbican's concert hall
  ['bishops-park-allotments', 'allotments', 51.4710, -0.2160, 'E', 'N'],
  ['walthamstow-wetlands', 'fishing-lake', 51.5810, -0.0580, 'W'],
  ['wetland-centre', 'nature-reserve', 51.4770, -0.2370, 'N', 'S'],
  ['brockwell-lido', 'lido', 51.4520, -0.1060, 'N'],
  ['queens-club', 'tennis-club', 51.4875, -0.2140, 'E'],
  ['brick-lane-bowling', 'bowling-alley', 51.5215, -0.0720, 'S'],
  ['queens-ice', 'ice-rink', 51.5125, -0.1880, 'W'],
  ['wandsworth-trampolines', 'trampoline-park', 51.4560, -0.1920, 'E', 'S'],
  ['canning-town-karts', 'go-kart-track', 51.5150, 0.0100, 'N', 'N'],
  ['hyde-park-funfair', 'funfair', 51.5070, -0.1600, 'S'],
  ['mudchute-farm', 'city-farm', 51.4900, -0.0130, 'W', 'N'],
  ['horniman-aquarium', 'aquarium', 51.4410, -0.0610, 'W'],
  ['greenwich-planetarium', 'planetarium', 51.4770, -0.0020, 'N', 'S'],
  ['science-museum', 'science-centre', 51.4978, -0.1745, 'S'],
  ['barbican-hall', 'concert-hall', 51.5200, -0.0940, 'S'],
];

/** The 1×1 kinds, each on a frontage lot as near the real place as one is found once the streets are laid. */
export const KIND_VENUES: Spot[] = [
  // power: a substation by each station and the grid supply point, the Rainham marshes' wind row
  ['battersea-substation', 'substation', 51.4780, -0.1480, 'E'],
  ['barrier-substation', 'substation', 51.5040, 0.0420, 'W'],
  ['beckton-substation', 'substation', 51.5110, 0.0600, 'N'],
  ['rainham-substation', 'substation', 51.5150, 0.1450, 'E'],
  ['rainham-wind-1', 'wind-turbine', 51.5190, 0.1400, 'N'],
  ['rainham-wind-2', 'wind-turbine', 51.5180, 0.1470, 'W'],
  ['rainham-wind-3', 'wind-turbine', 51.5200, 0.1540, 'S'],
  // media: Television Centre at White City
  ['television-centre', 'tv-studio', 51.5088, -0.2240, 'E'],
  // remembrance: funeral directors in Islington and Hackney
  ['funeral-islington', 'funeral-director', 51.5395, -0.1030, 'W'],
  ['funeral-hackney', 'funeral-director', 51.5450, -0.0555, 'E'],
  // health: a GP in Islington, St Mary's in Paddington
  ['gp-islington', 'gp-surgery', 51.5370, -0.1015, 'N'],
  ['st-marys-hospital', 'hospital', 51.5170, -0.1730, 'W'],
  // police and fire: the Earl's Court box, a post in Notting Hill, Paddington Green station, a fire post in Clerkenwell, Euston's fire station
  ['earls-court-police-box', 'police-box', 51.4915, -0.1935, 'E'],
  ['notting-hill-police-post', 'police-post', 51.5090, -0.2000, 'N'],
  ['paddington-green-police', 'police', 51.5200, -0.1760, 'W'],
  ['clerkenwell-fire-post', 'fire-post', 51.5230, -0.1050, 'E'],
  ['euston-fire', 'fire', 51.5265, -0.1325, 'S'],
  // builders: a handyman in Hackney, a yard in Poplar
  ['hackney-handyman', 'handyman', 51.5430, -0.0640, 'W'],
  ['poplar-yard', 'yard', 51.5105, -0.0150, 'N'],
  // education: a nursery in Islington
  ['nursery-islington', 'nursery', 51.5385, -0.1060, 'E'],
  // leisure: the Odeon in Leicester Square, a café cinema in Hackney, Peckham Library, Hyde Park Corner's park
  ['odeon-leicester-square', 'cinema', 51.5101, -0.1302, 'N'],
  ['picturehouse-hackney', 'cafe-cinema', 51.5459, -0.0561, 'S'],
  ['peckham-library', 'library', 51.4741, -0.0690, 'W'],
  ['hyde-park-corner', 'park', 51.5027, -0.1527, 'E'],
  // transport: a car park in Camden and kerbside bays on Marylebone's streets
  ['camden-car-park', 'parking', 51.5395, -0.1430, 'W'],
  ['marylebone-bays', 'kerbside-bays', 51.5200, -0.1530, 'N'],
  // free-time places: the Diana memorial playground, Stockwell's skate park, roller skating in Vauxhall, the Castle
  // climbing centre, the Royal Observatory, the Whitechapel Gallery, a pottery in Hackney, the Rivoli Ballroom, Camden's
  // arcade by the Lock, a board-game café in Haggerston and an escape room by King's Cross
  ['diana-playground', 'playground', 51.5065, -0.1900, 'E'],
  ['stockwell-skatepark', 'skate-park', 51.4720, -0.1210, 'N'],
  ['vauxhall-roller-disco', 'roller-disco', 51.4855, -0.1235, 'W'],
  ['castle-climbing', 'climbing-centre', 51.5660, -0.0920, 'E'],
  ['royal-observatory', 'observatory', 51.4769, -0.0005, 'N'],
  ['whitechapel-gallery', 'art-gallery', 51.5160, -0.0700, 'S'],
  ['hackney-pottery', 'pottery-studio', 51.5500, -0.0480, 'W'],
  ['rivoli-ballroom', 'dance-hall', 51.4590, -0.0350, 'E'],
  ['camden-arcade', 'arcade', 51.5410, -0.1460, 'W'],
  ['haggerston-games-cafe', 'board-game-cafe', 51.5390, -0.0760, 'N'],
  ['kings-cross-escape', 'escape-room', 51.5310, -0.1180, 'S'],
];

/** Names (World.setStopName at the door: the tooltips read right), the dead of a resting place, the hour a stop is shown at. */
const EXTRA: Record<string, Pick<DemoPlacement, 'name' | 'graves' | 'hour' | 'aside'>> = {
  'battersea-power': { name: 'Battersea Power Station' },
  'beckton-gas': { name: 'Beckton Gas Works' },
  'barrier-grid': { name: 'Thames Barrier grid supply point' },
  'lots-road-depot': { name: 'Lots Road power depot' },
  'rainham-solar': { name: 'Rainham Marshes solar farm' },
  'broadcasting-house': { name: 'Broadcasting House' },
  'itv-south-bank': { name: 'ITV South Bank' },
  'st-pauls-churchyard': { name: 'St Paul\'s Churchyard', graves: 0.5 },
  // the City of London Cemetery at dusk
  'city-of-london-cemetery': { name: 'City of London Cemetery', graves: 0.7, hour: 18.6 },
  'guys-hospital': { name: 'Guy\'s Hospital' },
  'walk-in-brixton': { name: 'Brixton walk-in centre' },
  'health-centre-hackney': { name: 'Homerton health centre' },
  'brixton-police': { name: 'Brixton Police Station' },
  'shoreditch-fire': { name: 'Shoreditch Fire Station' },
  'stratford-depot': { name: 'Stratford builders\' depot' },
  'stratford-buildco': { name: 'Stratford Delivery Authority' },
  'halls-bloomsbury': { name: 'Bloomsbury halls' },
  'sixth-form-camden': { name: 'Camden Sixth Form' },
  'kingsway-college': { name: 'Westminster Kingsway College' },
  'imperial-research': { name: 'Imperial White City Campus' },
  'roehampton': { name: 'Roehampton University' },
  'royal-albert-hall': { name: 'Royal Albert Hall' },
  'westfield-screens': { name: 'Westfield Stratford City screens' },
  'westfield-parking': { name: 'Westfield multi-storey' },
  'brent-cross-park-ride': { name: 'Brent Cross park and ride' },
  'olympia-halt': { name: 'Kensington Olympia' },
  'battersea-substation': { name: 'Battersea substation' },
  'barrier-substation': { name: 'Silvertown substation' },
  'beckton-substation': { name: 'Beckton substation' },
  'rainham-substation': { name: 'Rainham substation' },
  'television-centre': { name: 'Television Centre' },
  'st-marys-hospital': { name: 'St Mary\'s Hospital' },
  'earls-court-police-box': { name: 'Earl\'s Court police box' },
  'notting-hill-police-post': { name: 'Notting Hill police post' },
  'paddington-green-police': { name: 'Paddington Green Police Station' },
  'peckham-library': { name: 'Peckham Library' },
  'hyde-park-corner': { name: 'Hyde Park Corner' },
  'bishops-park-allotments': { name: 'Bishop\'s Park allotments' },
  'walthamstow-wetlands': { name: 'Walthamstow Wetlands' },
  'wetland-centre': { name: 'London Wetland Centre' },
  'brockwell-lido': { name: 'Brockwell Lido' },
  'queens-club': { name: 'Queen\'s Club' },
  'brick-lane-bowling': { name: 'Brick Lane bowling' },
  'queens-ice': { name: 'Bayswater ice rink' },
  'wandsworth-trampolines': { name: 'Wandsworth trampoline park' },
  'canning-town-karts': { name: 'Canning Town karting' },
  'hyde-park-funfair': { name: 'Hyde Park funfair' },
  'mudchute-farm': { name: 'Mudchute Farm' },
  'horniman-aquarium': { name: 'Horniman aquarium' },
  'greenwich-planetarium': { name: 'Greenwich Planetarium' },
  'science-museum': { name: 'Science Museum' },
  'barbican-hall': { name: 'Barbican Hall' },
  'diana-playground': { name: 'Diana Memorial Playground' },
  'stockwell-skatepark': { name: 'Stockwell skate park' },
  'royal-observatory': { name: 'Royal Observatory' },
  'whitechapel-gallery': { name: 'Whitechapel Gallery' },
  'rivoli-ballroom': { name: 'Rivoli Ballroom' },
};

/**
 * Fit the 1×1 spots on frontage lots: `nearLot` is london.ts's finder (a free frontage lot near a latitude and
 * longitude that `ok` accepts, claimed once found) and `roadAt` its test for a road tile. A spot with no lot facing its
 * side takes any frontage lot; none at all is a problem.
 */
export function fitKindVenues(
  nearLot: (lat: number, lon: number, ok: (x: number, y: number) => boolean) => DemoXY | null,
  roadAt: (x: number, y: number) => boolean,
  problems: string[],
): DemoPlacement[] {
  const out: DemoPlacement[] = [];
  for (const [id, kind, lat, lon, side] of KIND_VENUES) {
    const [fx, fy] = FRONT[SIDES[side]];
    const door = nearLot(lat, lon, (x, y) => roadAt(x + fx, y + fy)) ?? nearLot(lat, lon, () => true);
    if (door) out.push({ id, kind, door, ...EXTRA[id] }); else problems.push(`${id}: no frontage lot near its place`);
  }
  return out;
}

/** The section: the fitted multi-tile spots (london.ts's `structures`, by id) and the 1×1 venues. */
export function kindsSection(structures: readonly DemoPlacement[], venues: readonly DemoPlacement[]): DemoSection {
  const ids = new Set(KIND_SPOTS.map(([id]) => id));
  return {
    id: 'london-kinds', name: 'The rest of London',
    blurb: 'Everything else a player can build, each where its real counterpart stands. Battersea\'s power station, the gas works at Beckton, the grid supply point by the Thames Barrier, a solar farm and wind row on the Rainham marshes; Broadcasting House, Television Centre and ITV; the City\'s churchyard, the City of London Cemetery and funeral directors; Guy\'s and St Mary\'s hospitals, surgeries and walk-in centres; police boxes to Brixton\'s divisional station, fire posts to Shoreditch\'s large station; the builders at Stratford; Imperial\'s research campus, halls, colleges and a university; the Royal Albert Hall, cinemas, libraries and parks; and the car parks, a halt and a park and ride.',
    placements: [...structures.filter((p) => ids.has(p.id ?? p.kind)).map((p) => ({ ...p, ...EXTRA[p.id ?? p.kind] })), ...venues],
  };
}

/**
 * Where the tour's new stops go: each after the stop it neighbours (the tour runs west to east along the river and
 * then round the rings). One stop frames a group: Battersea for the power on the Thames, Broadcasting House for the
 * broadcasters, Guy's for the hospitals, the Albert Hall and Imperial's campus, Brixton's police and Shoreditch's fire,
 * Stratford's builders, Beckton and Rainham for the power down river, the City of London Cemetery at dusk.
 */
const KIND_TOUR: [after: string, stops: string[]][] = [
  ['welcome', ['battersea-power']],
  ['leicester-square', ['broadcasting-house']],
  ['shard', ['guys-hospital']],
  ['stratford', ['stratford-buildco']],
  ['secondary-brixton', ['brixton-police']],
  ['area-royal-docks', ['barrier-grid', 'beckton-gas']],
  ['area-thames-gateway', ['rainham-solar']],
  ['area-hackney', ['shoreditch-fire']],
  ['golders-green-crematorium', ['city-of-london-cemetery']],
  ['imperial', ['royal-albert-hall', 'imperial-research']],
];
/** The tour ids this section adds. */
export const KIND_TOUR_IDS: string[] = KIND_TOUR.flatMap(([, s]) => s);
/** A London tour with this section's stops put in beside their neighbours. */
export function withKindsTour(tour: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of tour) {
    out.push(id);
    for (const [after, stops] of KIND_TOUR) if (after === id) out.push(...stops);
  }
  return out;
}

/**
 * Placeable kinds London does not show, with the reason (showcase.ts `londonProblems`). A kind needs a home in London
 * or a line here: the check fails for a kind with neither.
 */
/** The landmark groups (cities) with a sample city demo of their own (showcase.ts DEMOS, citydemo.ts): their landmarks stand there. */
export const CITY_DEMO_GROUPS = new Set<string>(['paris', 'new-york', 'san-francisco']);
export const LONDON_EXEMPT: Record<string, string> = {
  camp: 'the pioneer camp is a new player\'s first settlers, one per player, on a frontier start; London is a built city',
  // world landmarks (docs/buildings.md "Landmarks", landmarks-world.ts) whose own cities have no demos yet, so none
  // can stand in one; each places only in sandboxes and ?dev clients behind the locked tech node wld1. The sample
  // cities' landmarks (CITY_DEMO_GROUPS) stand in their own cities' demos instead (showcase.ts cityProblems)
  ...Object.fromEntries(WORLD_LANDMARKS.filter((k) => !CITY_DEMO_GROUPS.has(k.group ?? '')).map((k) => [k.id,
    'a world landmark behind the locked wld1 node: its own city has no demo yet, so it cannot stand in one'])),
};
