import type { TechDTO } from './protocol';

/**
 * The technology tree. Tiers are earned by playing (a counter the player's own
 * city drives crosses a threshold) and then bought. Conditions are data, so the
 * server enforces them and the client can show progress bars without either
 * side knowing the other's code.
 */
export type Counter = 'built' | 'roads' | 'housed' | 'jobs' | 'parked' | 'pupils' | 'graduates';
export const COUNTER_LABELS: Record<Counter, string> = {
  built: 'units of construction work completed by your builders',
  roads: 'road tiles laid',
  housed: 'residents housed at once',
  jobs: 'jobs filled in your parcels at once',
  parked: 'cars parked at your buildings',
  pupils: 'school places filled in your parcels at once',
  graduates: 'residents of your parcels with a degree or more',
};

export interface TechNode {
  id: string;
  track: 'zoning' | 'construction' | 'transport' | 'civic' | 'culture' | 'education' | 'utilities';
  tier: number;
  name: string;
  blurb: string;
  cost: number;
  requires: string[];
  condition: { counter: Counter; min: number };
  /** feature ids this node opens: tool names, 'policy-*' (the education policies, policies.ts), 'level2' ... 'level7', 'underground', 'signals', 'publicRoads', 'bridges', 'patrols', 'airport', 'runway', 'lines' (the transit Lines panel), 'ferry' (river bus lines, docs/boats.md) */
  unlocks: string[];
  /**
   * The node cannot be earned or bought in a live game yet: its unlock rule is still to be decided, and this text
   * says so in the tech tree in place of the condition. Sandboxes (test cities, demos), the Commons and the dev
   * "unlock everything" action still get it (they take ALL_TECH_IDS), and so does a ?dev client on a dev server.
   */
  locked?: string;
}

/**
 * Costs and conditions were retuned for the first two hours of play (docs/early-game-audit.md, "After Gauntlet 3"):
 * tiers 2-5 cost about a third less, so after the opening a node is a day or so of tax away rather than five, and the
 * transport nodes that asked for road tiles (met by any opening layout, so they gated nothing) now ask for residents,
 * arriving as the traffic they fix does. Parking lots (tr1) still opens on 20 road tiles. The motorway connection needs no
 * technology (no node unlocks it): newcomers should be able to arrive through it from the first homes.
 */
export const TECH: TechNode[] = [
  // zoning: what land may be used for
  { id: 'zon1', track: 'zoning', tier: 1, name: 'Commercial zoning', blurb: 'Shops, cafés and bars. Your residents spend money and pay sales tax here.', cost: 200, requires: [], condition: { counter: 'housed', min: 12 }, unlocks: ['com'] },
  { id: 'zon2', track: 'zoning', tier: 2, name: 'Industrial zoning', blurb: 'Factories and warehouses: well-paid shift work and freight on your roads.', cost: 300, requires: ['zon1'], condition: { counter: 'housed', min: 40 }, unlocks: ['ind'] },
  // adverts (docs/adverts.md): the frames on shops, shelters and hoardings; the Campaigns panel. On the zoning track after Commercial zoning, as the frames are mostly on shops
  { id: 'adv1', track: 'zoning', tier: 2, name: 'Advertising', blurb: 'Posters, billboards and shelter panels: rent the empty frames on shops, bus shelters and building sites and put your own campaigns on them. Rent goes to whoever owns the frontage. Posters wear and get tagged, faster in neglected streets.', cost: 250, requires: ['zon1'], condition: { counter: 'housed', min: 60 }, unlocks: ['adverts'] },
  { id: 'zon3', track: 'zoning', tier: 3, name: 'Office zoning', blurb: 'Office towers hold the most jobs per tile and draw the heaviest commuter traffic.', cost: 1000, requires: ['zon2', 'con1'], condition: { counter: 'jobs', min: 80 }, unlocks: ['off'] },
  // construction: how big things can be built
  { id: 'con1', track: 'construction', tier: 1, name: 'Masonry', blurb: 'Your builders can raise two-storey buildings. Zones in your parcels grow to level 2.', cost: 500, requires: [], condition: { counter: 'built', min: 1500 }, unlocks: ['level2'] },
  { id: 'con2', track: 'construction', tier: 2, name: 'Steel frame', blurb: 'Towers. Zones in your parcels grow to level 3, and steel lets you build a builders\' depot with its own crane and a multi-storey car park.', cost: 1200, requires: ['con1'], condition: { counter: 'built', min: 4000 }, unlocks: ['level3', 'depot', 'multistorey'] },
  { id: 'con3', track: 'construction', tier: 3, name: 'Deep foundations', blurb: 'Basement levels under new and existing buildings: underground parking for everyone who works or shops there.', cost: 1500, requires: ['con2'], condition: { counter: 'built', min: 7000 }, unlocks: ['underground'] },
  { id: 'con4', track: 'construction', tier: 4, name: 'Industrialised building', blurb: 'A construction company with a batching plant, mixer trucks and three times a yard\'s crews, each working sixty per cent faster.', cost: 3500, requires: ['con3'], condition: { counter: 'built', min: 12000 }, unlocks: ['buildco'] },
  { id: 'con5', track: 'construction', tier: 5, name: 'High-rise', blurb: 'Neighbouring lots of one zone merge into bigger buildings and climb past level 3: mid-rise flats, department stores, office towers and distribution centres at levels 4 and 5, then residential towers, hotels, corporate campuses, supertalls and heavy plants at 6 and 7.', cost: 4000, requires: ['con3'], condition: { counter: 'built', min: 10000 }, unlocks: ['level4', 'level5', 'level6', 'level7'] },
  // transport: moving people and cars
  { id: 'tr1', track: 'transport', tier: 1, name: 'Parking lots', blurb: 'Surface lots with a dozen bays, and kerbside bays for half a dozen. Drivers who find no space at their destination park here and walk, and pay you for it.', cost: 150, requires: [], condition: { counter: 'roads', min: 20 }, unlocks: ['park', 'kerbbays'] },
  { id: 'tr2', track: 'transport', tier: 2, name: 'Traffic signals', blurb: 'Crossroads in your parcels get phased signals, roughly doubling what a busy junction can carry. With them come signal crossings for walkers, turn bans and no-entry signs to set on a junction\'s arms, and street rules: HGV bans, double yellow lines and 20 zones with humps, and a lorry curfew policy.', cost: 500, requires: ['tr1'], condition: { counter: 'housed', min: 100 }, unlocks: ['signals', 'turnrule', 'pelican', 'streetrules', 'curfew'] },
  { id: 'tr3', track: 'transport', tier: 3, name: 'Public works', blurb: 'Lay roads on unclaimed land to link your parcels to the wider world.', cost: 700, requires: ['tr2'], condition: { counter: 'housed', min: 150 }, unlocks: ['publicRoads'] },
  // road classes (docs/roads.md "Classes", shared/src/roadclass.ts): the street and the country lane need nothing
  { id: 'tr13', track: 'transport', tier: 2, name: 'One-way streets', blurb: 'One-way streets: two lanes going the way you drag them. Pair two to carry a busy route, or keep traffic out of a quiet one.', cost: 350, requires: ['tr1'], condition: { counter: 'housed', min: 80 }, unlocks: ['onewayStreets'] },
  { id: 'tr14', track: 'transport', tier: 3, name: 'Avenues', blurb: 'Avenues: two tiles wide, two lanes each way either side of a planted reservation, twice what a street carries. Drag one over a street to widen it.', cost: 1000, requires: ['tr2'], condition: { counter: 'housed', min: 160 }, unlocks: ['avenues'] },
  { id: 'tr15', track: 'transport', tier: 4, name: 'Motorways', blurb: 'Motorways from your motorway connection: fast, two lanes each way, no buildings on them; streets join them by slip roads and never cross.', cost: 2500, requires: ['tr14', 'tr3'], condition: { counter: 'jobs', min: 200 }, unlocks: ['motorways'] },
  { id: 'tr7', track: 'transport', tier: 3, name: 'Junction design', blurb: 'Roundabouts and flyovers. A roundabout keeps traffic moving without lights: drivers give way to cars already on the ring. A flyover lifts one road over the other, so nothing crossing ever waits (but nobody can turn there). Mini-roundabouts paint a roundabout on a street junction; with Avenues the roundabout tool builds a big two-lane ring on an avenue, and with Motorways an interchange joins a street to a motorway.', cost: 1200, requires: ['tr2'], condition: { counter: 'roads', min: 120 }, unlocks: ['roundabout', 'flyover', 'miniroundabout', 'interchange'] },
  { id: 'tr8', track: 'transport', tier: 3, name: 'Civil engineering', blurb: 'Road bridges: drag a road straight across a river or lake, up to 12 tiles of water, landing on road at both banks. Short crossings get stone arches, longer ones steel girders or a suspension span.', cost: 1500, requires: ['tr3'], condition: { counter: 'housed', min: 180 }, unlocks: ['bridges'] },
  { id: 'tr4', track: 'transport', tier: 4, name: 'Aviation', blurb: 'An airport terminal and a runway behind it. Planes land on a daily timetable, every landing pays you a fee, and the ground crew work early and late shifts.', cost: 4500, requires: ['tr3'], condition: { counter: 'jobs', min: 200 }, unlocks: ['airport', 'runway'] },
  { id: 'tr5', track: 'transport', tier: 5, name: 'Public transport', blurb: 'Bus stops, a bus depot and the Lines panel: route buses round your stops, set a fare-paying timetable running from 05:30 to 00:30, and take cars off the road. Bus lanes on one-way streets and avenues let buses pass the queues.', cost: 1000, requires: ['tr2'], condition: { counter: 'housed', min: 200 }, unlocks: ['busstop', 'busdepot', 'lines', 'parkride', 'buslane'] },
  { id: 'tr6', track: 'transport', tier: 6, name: 'Rail', blurb: 'Railway track, halts, stations and freight yards. Trains run your lines on a timetable from 05:00 to 01:00, 40 riders a carriage paying fares; a there-and-back line runs one train, a loop as many as fit. Freight yards load containers for freight lines.', cost: 3000, requires: ['tr5'], condition: { counter: 'jobs', min: 250 }, unlocks: ['rail', 'railhalt', 'railstation', 'freightyard'] },
  // boats and harbours (docs/boats.md section 5): the jetty, marina and fishing harbour, then ferry piers, then the seaport
  { id: 'tr10', track: 'transport', tier: 4, name: 'Harbours', blurb: 'Jetties, marinas and fishing harbours, built with their back rows over the water. Pleasure boats are based at jetties and marinas, and trawlers land their catch at the fish quay.', cost: 1800, requires: ['tr8'], condition: { counter: 'housed', min: 250 }, unlocks: ['jetty', 'marina', 'fishharbour'] },
  { id: 'tr11', track: 'transport', tier: 6, name: 'River buses', blurb: 'Ferry piers and river bus lines: catamarans call at your piers on a timetable, and riders pay fares as on the trains.', cost: 2500, requires: ['tr5', 'tr10'], condition: { counter: 'jobs', min: 250 }, unlocks: ['ferrypier', 'ferry'] },
  { id: 'tr12', track: 'transport', tier: 7, name: 'Seaport', blurb: 'A cargo port on open water that reaches the sea: container ships, coasters and barges bring imports and take your exports, and ferries bring newcomers.', cost: 9000, requires: ['tr10', 'zon2'], condition: { counter: 'jobs', min: 500 }, unlocks: ['cargoport'] },
  { id: 'tr9', track: 'transport', tier: 7, name: 'Underground railway', blurb: 'Metro entrances and station halls with platforms bored under the street. Click the entrances in the Lines panel to run a metro line: the tunnel is bored for you, and trains run from 05:00 to 01:00 in twin bores, never in traffic.', cost: 8000, requires: ['tr6', 'con3'], condition: { counter: 'jobs', min: 600 }, unlocks: ['metro', 'metroentrance', 'metrostation'] },
  // civic: services
  { id: 'civ1', track: 'civic', tier: 1, name: 'Emergency services', blurb: 'Police and fire stations, with police boxes, neighbourhood posts and fire posts to fill the gaps. Covered homes tolerate higher taxes and grow faster.', cost: 400, requires: [], condition: { counter: 'housed', min: 20 }, unlocks: ['police', 'fire', 'policebox', 'policepost', 'firepost'] },
  { id: 'civ2', track: 'civic', tier: 2, name: 'Healthcare', blurb: 'GP surgeries, health centres, walk-in centres and the city hospital: the best-paid jobs in town and the third service homes look for.', cost: 800, requires: ['civ1'], condition: { counter: 'housed', min: 100 }, unlocks: ['hospital', 'gp', 'healthcentre', 'walkin'] },
  { id: 'civ3', track: 'civic', tier: 3, name: 'Patrols and call-outs', blurb: 'Your stations put patrol cars, fire engines and ambulances on the road.', cost: 700, requires: ['civ2'], condition: { counter: 'jobs', min: 60 }, unlocks: ['patrols'] },
  { id: 'civ4', track: 'civic', tier: 4, name: 'Regional services', blurb: 'Bigger stations that cover a whole district: a divisional police station with a car pound, a large fire station with a drill tower and a community hospital.', cost: 1800, requires: ['civ3'], condition: { counter: 'housed', min: 300 }, unlocks: ['divstation', 'bigfire', 'commhospital'] },
  { id: 'civ5', track: 'civic', tier: 5, name: 'Metropolitan services', blurb: 'Police headquarters, a fire and rescue headquarters and a general hospital with a helipad: the strongest cover, reaching across much of the city.', cost: 4000, requires: ['civ4'], condition: { counter: 'housed', min: 600 }, unlocks: ['policehq', 'firehq', 'genhospital'] },
  // death and remembrance (docs/remembrance.md): about the Village rank (340 residents on the Commons, 400 on a frontier)
  { id: 'rem1', track: 'civic', tier: 3, name: 'Remembrance', blurb: 'A funeral director with a hearse, churchyards, cemeteries and a crematorium: your dead are laid to rest in town, their headstones stand where you can visit them, and the fees come to you.', cost: 900, requires: ['civ2'], condition: { counter: 'housed', min: 300 }, unlocks: ['funeral', 'churchyard', 'cemetery', 'gardencemetery', 'crematorium'] },
  { id: 'civ6', track: 'civic', tier: 6, name: 'Medical school', blurb: 'A teaching hospital campus with a research wing: the finest health care there is.', cost: 8000, requires: ['civ5', 'cul4'], condition: { counter: 'jobs', min: 600 }, unlocks: ['teachhospital'] },
  // culture: places to go (parks need no technology)
  { id: 'cul1', track: 'culture', tier: 1, name: 'Libraries and halls', blurb: 'A library or community hall, and the lakeside park: free daytime outings that retirees and children love, and a reason to stay.', cost: 400, requires: [], condition: { counter: 'housed', min: 25 }, unlocks: ['library', 'lakepark'] },
  // pedestrian streets (docs/roads.md "Classes"): with the town's first shops, where the walkers are
  { id: 'cul6', track: 'culture', tier: 2, name: 'Pedestrian streets', blurb: 'Pave a street for walkers and bikes: no cars but emergencies, and deliveries before 10:00 and after 19:00. Shops on it see the most passers-by.', cost: 500, requires: ['cul1', 'zon1'], condition: { counter: 'housed', min: 90 }, unlocks: ['pedestrianStreets'] },
  // Focus groups (docs/motivation.md, Rich's 4a: Culture tier 2): a home's tooltip shows what the people of its parcel care about
  { id: 'cul2', track: 'culture', tier: 2, name: 'Cinemas and sports halls', blurb: 'Evening crowds, premiere and match nights, ticket sales taxed in your parcel, and traffic to match. With them come focus groups: hover a home to see what the people of its parcel care about most.', cost: 700, requires: ['cul1'], condition: { counter: 'housed', min: 70 }, unlocks: ['cinema', 'sports', 'cafecinema', 'centrallibrary', 'focusgroups'] },
  { id: 'cul3', track: 'culture', tier: 3, name: 'Theatre', blurb: 'A playhouse with performances three nights a week. The best night out in town draws people from far away.', cost: 1200, requires: ['cul2', 'zon1'], condition: { counter: 'jobs', min: 100 }, unlocks: ['theatre', 'studiotheatre', 'leisurecentre'] },
  { id: 'cul4', track: 'culture', tier: 4, name: 'Big nights out', blurb: 'A multiplex, an indoor arena and a museum: big venues with big event nights that draw people from across town.', cost: 2200, requires: ['cul3'], condition: { counter: 'housed', min: 350 }, unlocks: ['multiplex', 'arena', 'museum'] },
  { id: 'cul5', track: 'culture', tier: 5, name: 'Landmarks', blurb: 'An opera house, a stadium with floodlights, a botanical garden and a big screens corner: places people cross the city for.', cost: 5000, requires: ['cul4', 'con2'], condition: { counter: 'jobs', min: 500 }, unlocks: ['opera', 'stadium', 'botanic', 'bigscreens'] },
  // free-time places (docs/leisure.md, buildings/attractions.ts): four collections of places to play, swim, make things and spend a day
  { id: 'cul7', track: 'culture', tier: 1, name: 'Play and green spaces', blurb: 'An adventure playground, a skate park, allotments and a fishing lake: free or cheap places close to home where children play after school and retirees spend their afternoons.', cost: 300, requires: [], condition: { counter: 'housed', min: 30 }, unlocks: ['playground', 'skatepark', 'allotments', 'fishinglake'] },
  { id: 'cul8', track: 'culture', tier: 2, name: 'Days out', blurb: 'A nature reserve with a bird hide, a city farm, an art gallery, a pottery studio, a tennis club and a board-game café: gentle outings for every age.', cost: 600, requires: ['cul7'], condition: { counter: 'housed', min: 80 }, unlocks: ['naturereserve', 'cityfarm', 'gallery', 'pottery', 'tennisclub', 'gamescafe'] },
  { id: 'cul9', track: 'culture', tier: 3, name: 'Indoor fun', blurb: 'A lido, a bowling alley, a roller disco, a climbing centre, a trampoline park, a family arcade, an escape room and a dance hall: somewhere to go whatever the weather.', cost: 1000, requires: ['cul8', 'cul2'], condition: { counter: 'housed', min: 150 }, unlocks: ['lido', 'bowling', 'rollerdisco', 'climbing', 'trampoline', 'arcade', 'escaperoom', 'dancehall'] },
  { id: 'cul10', track: 'culture', tier: 4, name: 'Attractions', blurb: 'An ice rink, a go-kart track, an aquarium, a planetarium, a science centre, an observatory and a concert hall: big days out that draw families from across town.', cost: 2400, requires: ['cul9', 'cul3'], condition: { counter: 'housed', min: 300 }, unlocks: ['icerink', 'karting', 'aquarium', 'planetarium', 'sciencecentre', 'observatory', 'concerthall'] },
  { id: 'cul11', track: 'culture', tier: 5, name: 'Funfair', blurb: 'A funfair with a Ferris wheel, a carousel, dodgems and a helter-skelter, and fireworks on Saturday nights: the biggest day out of all. Ride the wheel in first person to see your town from the top.', cost: 4000, requires: ['cul10'], condition: { counter: 'jobs', min: 400 }, unlocks: ['funfair'] },
  // broadcasters (docs/media.md N1, buildings/media.ts): after Advertising, as the media centre is also adverts' TV studio. The
  // card's rank gates (Village for the broadcast centre, Town for the media centre) are the residents those ranks need
  { id: 'med1', track: 'culture', tier: 3, name: 'Local television', blurb: 'A local TV studio with a newsroom and a mast: your own channel reporting the fires, the openings and the big days of its town, 24 tiles round it. Rival channels compete for the stories where they overlap.', cost: 900, requires: ['cul2', 'adv1'], condition: { counter: 'housed', min: 120 }, unlocks: ['tvstudio'] },
  { id: 'med2', track: 'culture', tier: 4, name: 'Broadcasting', blurb: 'A broadcast centre with live studios, a satellite dish yard and outside-broadcast vans: a channel covering a whole district, 48 tiles round it.', cost: 2000, requires: ['med1'], condition: { counter: 'housed', min: 340 }, unlocks: ['broadcast'] },
  { id: 'med3', track: 'culture', tier: 5, name: 'Media centres', blurb: 'A media centre tower with a news helipad, a big screen and a dish array: a channel that reaches the whole map.', cost: 4500, requires: ['med2', 'con2'], condition: { counter: 'housed', min: 560 }, unlocks: ['mediacentre'] },
  // education (docs/education.md section 6): nursery to research institute. The pupils and graduates counters are filled by the schools simulation (E3); until then edu4 and edu5 cannot be earned.
  { id: 'edu1', track: 'education', tier: 1, name: 'Schools', blurb: 'Nurseries and primary schools: children of three to eleven learn near home, and their parents like a good school close by.', cost: 500, requires: ['civ1'], condition: { counter: 'housed', min: 60 }, unlocks: ['nursery', 'primary'] },
  { id: 'edu2', track: 'education', tier: 2, name: 'Secondary education', blurb: 'Academies for eleven to sixteen: GCSEs, a big catchment, and a pool of teenagers who go on to further study.', cost: 1200, requires: ['edu1'], condition: { counter: 'housed', min: 200 }, unlocks: ['secondary', 'policy-meals', 'policy-buses'] },
  { id: 'edu3', track: 'education', tier: 3, name: 'Further education', blurb: 'Sixth-form colleges for A-levels and further-education colleges for trades and adult courses: the skilled workforce offices and factories ask for.', cost: 1800, requires: ['edu2', 'zon2'], condition: { counter: 'jobs', min: 150 }, unlocks: ['sixthform', 'fecollege', 'policy-learning', 'policy-apprentice'] },
  { id: 'edu4', track: 'education', tier: 4, name: 'Higher education', blurb: 'A university campus with halls of residence: degrees for your own school leavers, students from far away, and the best-paid graduates.', cost: 4500, requires: ['edu3', 'con2'], condition: { counter: 'pupils', min: 150 }, unlocks: ['university', 'halls', 'policy-fees'] },
  { id: 'edu5', track: 'education', tier: 5, name: 'Research', blurb: 'A research institute of glass and steel labs: postgraduates, the finest jobs in town, and offices that want to be near it.', cost: 7000, requires: ['edu4', 'zon3'], condition: { counter: 'graduates', min: 200 }, unlocks: ['research'] },
  // utilities (docs/utilities.md section 4, buildings/utilities.ts): Electrification comes before Masonry (1,500 built), so the
  // moment two-storey buildings are possible the player has been told houses want power too. Grid import needs no node of its own
  { id: 'ut1', track: 'utilities', tier: 1, name: 'Electrification', blurb: 'Substations and the National Grid. A substation passes power 12 road tiles along your streets; near a motorway connection it brings in the grid, at a price. Homes and workplaces need power to grow to two storeys.', cost: 300, requires: [], condition: { counter: 'built', min: 250 }, unlocks: ['substation'] },
  { id: 'ut2', track: 'utilities', tier: 2, name: 'Power stations', blurb: 'Gas and coal power stations, grid supply points, a power depot whose vans repair faults, and trunk lines on pylons or buried cable to join them up. Your own units are cheaper than the grid\'s, and every bill is income.', cost: 900, requires: ['ut1'], condition: { counter: 'housed', min: 150 }, unlocks: ['gasplant', 'coalplant', 'gridsupply', 'powerdepot', 'pylons', 'cable'] },
  { id: 'ut3', track: 'utilities', tier: 3, name: 'Renewables', blurb: 'Wind turbines and solar farms: nothing to burn and no smoke, but they make power only when the wind blows or the sun is up.', cost: 1200, requires: ['ut2'], condition: { counter: 'jobs', min: 200 }, unlocks: ['windturbine', 'solarfarm'] },
  // London landmarks (buildings/landmarks-london.ts, docs/buildings.md "Landmarks"): real buildings, tagged 'london'. How a
  // live game earns them is still to be decided, so the node is `locked`: only sandboxes and dev clients place them.
  // The second five tool ids are reserved for the landmarks of kind ids 96-100.
  { id: 'lnd1', track: 'culture', tier: 6, name: 'London landmarks', blurb: 'The Gherkin, the Shard, the Walkie Talkie, One Canada Square, the Royal Opera House, Big Ben, the London Eye, the Tower, Buckingham Palace, Tower Bridge and Piccadilly Circus: real London buildings that work as offices, venues and attractions.', cost: 10000, requires: ['cul5'], condition: { counter: 'jobs', min: 1000 }, locked: 'How these unlock is still to be decided: for now they stand only in test cities and demos.',
    unlocks: ['gherkin', 'shard', 'walkietalkie', 'canadasquare', 'royalopera', 'bigben', 'londoneye', 'toweroflondon', 'buckingham', 'towerbridge', 'piccadilly'] },
  // London's universities (buildings/landmarks-london-3.ts, docs/education.md section 9): landmarks that work as universities. Locked like lnd1.
  { id: 'lnd2', track: 'culture', tier: 6, name: 'London universities', blurb: 'UCL, Imperial College, King\'s College and the London School of Economics: real London buildings that work as universities, admitting students from across the city.', cost: 10000, requires: ['edu4', 'cul5'], condition: { counter: 'graduates', min: 500 }, locked: 'How these unlock is still to be decided: for now they stand only in test cities and demos.',
    unlocks: ['ucl', 'imperial', 'kings', 'lse'] },
  // World landmarks (buildings/landmarks-world*.ts, docs/buildings.md "Landmarks"): real buildings in cities around the
  // world, one locked node like lnd1; `unlocks` lists every world landmark's tool id as its city lands.
  { id: 'wld1', track: 'culture', tier: 6, name: 'World landmarks', blurb: 'New York\'s towers, Paris\'s iron lace, Cairo\'s pyramids, Dubai\'s skyline and Shanghai\'s Pudong: real buildings from around the world that work as offices, venues and attractions, with more cities to follow.', cost: 10000, requires: ['cul5'], condition: { counter: 'jobs', min: 1000 }, locked: 'How these unlock is still to be decided: for now they stand only in test cities and demos.',
    unlocks: ['empirestate', 'chrysler', 'liberty', 'onewtc', 'brooklyn', 'flatiron', 'rockefeller', 'radiocity',
      'greatpyramid', 'sphinx', 'khafre', 'cairotower', 'sultanhassan',
      'burjkhalifa', 'burjalarab', 'dubaiframe', 'motf', 'jumeirah',
      'orientalpearl', 'shanghaitower', 'jinmao', 'swfc', 'yugarden', 'eiffeltower', 'arcdetriomphe', 'notredame', 'louvre', 'operagarnier', 'sacrecoeur',
      'colosseum', 'stpeters', 'pantheon', 'trevi', 'altare', 'castelsangelo',
      'forbiddencity', 'templeofheaven', 'greatwall', 'tiananmen', 'cctv', 'summerpalace',
      'christredeemer', 'sugarloaf', 'riocathedral', 'maracana', 'sambadrome',
      'operahouse', 'harbourbridge', 'sydneytower', 'stmarys',
      'goldengate', 'transamerica', 'coittower', 'ferrybuilding', 'alcatraz',
      'sagradafamilia', 'casabatllol', 'campnou', 'torreglories',
      'petronas', 'kltower', 'merdeka118', 'batucaves',
      'cntower', 'casaloma', 'rom', 'oldcityhall',
      'spaceneedle', 'pikeplace', 'columbiacenter', 'smithtower',
      'tajmahal', 'agrafort', 'fatehpursikri', 'itimad'] },
];
export const TECH_BY_ID = new Map(TECH.map((t) => [t.id, t]));
export const ALL_TECH_IDS = TECH.map((t) => t.id);
export const TRACK_NAMES: Record<TechNode['track'], string> = { zoning: 'Zoning', construction: 'Construction', transport: 'Transport', civic: 'Civic', culture: 'Culture', education: 'Education', utilities: 'Utilities' };

/** The tech node that opens a feature, or undefined when it is available from the start. */
export function techFor(feature: string): TechNode | undefined {
  return TECH.find((t) => t.unlocks.includes(feature));
}
export const hasFeature = (unlocked: readonly string[], feature: string) => {
  const t = techFor(feature);
  return !t || unlocked.includes(t.id);
};
/** Tech needed for a zone to grow to `level` (1 is always allowed): Masonry for 2, Steel frame for 3, High-rise for 4-7. */
export const levelFeature = (level: number) => (level >= 2 ? `level${Math.min(7, level)}` : '');

/** Whether a player may earn and buy this node: false for a `locked` node (its unlock rule is still to be decided). */
export const isEarnable = (t: TechNode) => !t.locked;

export function describeCondition(t: TechNode): string {
  if (t.locked) return t.locked;
  return `${t.condition.min} ${COUNTER_LABELS[t.condition.counter]}`;
}
export function techDTO(t: TechNode): TechDTO {
  return { id: t.id, track: t.track, tier: t.tier, name: t.name, blurb: t.blurb, cost: t.cost, requires: t.requires, condition: describeCondition(t), unlocks: t.unlocks };
}
