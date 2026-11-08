import type { KindDef, OccupationDef, Design, Attributes } from './schema';
import { OUTDOOR_MODELS } from './attraction-models-outdoor';
import { INDOOR_MODELS } from './attraction-models-indoor';

/**
 * Free-time places (docs/leisure.md): 26 places citizens go to on a day off, after school or on a summer evening,
 * each its own kind of outing (shared/src/leisure.ts VENUE_TYPES) with its own first-person scene
 * (client/src/render/leisureRooms.ts). They sit in four collection groups (groups.ts: outdoors, active, daysout,
 * hobbies) rather than size ladders, so each picker lists different places, and the Culture track unlocks them
 * (tech.ts cul7-cul11).
 *
 * Kind ids: 217-229 (Play and green, Active fun), 250-255 (Days out) and 118, 119, 129, 140, 147-149 (Arts and
 * games), the last free ids outside the reserved blocks (docs/sub-kinds.md). Family codes by what they are like: the
 * green places with parks (10), the active ones with sport (13), the days out with the museum (14), the arts with the
 * theatre (12) and the games with the cinema (11); collection groups may mix codes.
 *
 * Everything here is for everyone: no bars, no gambling, no late-night clubs. The models are in
 * attraction-models-outdoor.ts and attraction-models-indoor.ts, keyed by kind id string.
 */

/** Venue staff rosters cover evenings and weekends, so cycles keep Friday-Sunday mostly staffed (as buildings/leisure.ts). */
const EVENING_CYCLES = [[0, 0, 1, 1, 1, 1, 1], [1, 1, 0, 0, 1, 1, 1], [1, 1, 1, 0, 0, 1, 1], [1, 1, 1, 1, 1, 0, 0]];
/** Daytime places open every day: staff work five days in seven, staggered. */
const DAY_CYCLES = [[1, 1, 1, 1, 1, 0, 0], [0, 0, 1, 1, 1, 1, 1], [1, 1, 0, 0, 1, 1, 1], [1, 1, 1, 0, 0, 1, 1]];

/** A roster: an early and a late shift (start hours) of `hours` each, weighted toward the busier one. */
const roster = (name: string, early: number, late: number, evening: boolean, hours = 8): OccupationDef => ({
  name, rotate: true, cycles: evening ? EVENING_CYCLES : DAY_CYCLES,
  shifts: [{ start: early, hours, weight: evening ? 0.4 : 0.55 }, { start: late, hours, weight: evening ? 0.6 : 0.45 }],
});

interface PlaceSpec {
  id: string; name: string; kindId: number; code: number; group: string; tier: number;
  label: string; toolId: string; color: string;
  w?: number; h?: number;
  blurb: string; howTo: string;
  /** leisure attributes (venueType, hours, ticket, appeal...) */
  attrs: Attributes;
  /** staff: jobs, wage and roster; omitted for an unstaffed place (a playground, a skate park, allotments) */
  staff?: { jobs: number; wage: number; occupation: OccupationDef };
  cost: number; upkeep: number; work: number; parking: [number, number];
  windows?: KindDef['windows'];
  designs: Design[];
}

function place(p: PlaceSpec): KindDef {
  const w = p.w ?? 1, h = p.h ?? 1;
  const k: KindDef = {
    id: p.id, name: p.name, code: p.code, kindId: p.kindId, family: 'leisure',
    flags: { civic: true, leisureReady: true, ...(p.staff ? { workplace: true } : {}) },
    windows: p.windows ?? 'venue',
    group: p.group, tier: p.tier,
    blurb: p.blurb, howTo: p.howTo,
    tool: { id: p.toolId, key: '', label: p.label, color: p.color },
    attrs: { title: p.name, ...p.attrs },
    levels: [{
      capacity: p.staff?.jobs ?? 0, wage: p.staff?.wage ?? 0, cost: p.cost, upkeep: p.upkeep, work: p.work,
      parking: { surface: p.parking[0], underground: p.parking[1] },
      designs: p.designs,
    }],
  };
  if (w > 1 || h > 1) k.footprint = { w, h, door: [Math.floor((w - 1) / 2), h - 1] };
  if (p.staff) { k.occupation = p.staff.occupation; k.lot = { wage: p.staff.wage }; }
  return k;
}

const O = OUTDOOR_MODELS, I = INDOOR_MODELS;

// ================================================================= Play and green (family 10, with the parks)

export const playground = place({
  id: 'playground', name: 'adventure playground', kindId: 217, code: 10, group: 'outdoors', tier: 1,
  label: 'Adventure playground', toolId: 'playground', color: '#e0a42e',
  blurb: 'Swings, a climbing frame, a slide and a zip wire behind a low fence. Free, and the place children ask to go after school.',
  howTo: 'One tile among homes. Children walk here on their own when it is close, so put one in every neighbourhood.',
  attrs: { venueType: 'playground', openHours: [7, 20], ticket: 0, stay: [0.5, 1.5], visitorCapacity: 20, leisureValue: 3, radius: 8,
    dayAppeal: 1.4, eveningAppeal: 0.3, retireeAppeal: 0.8, childAppeal: 3.0 },
  cost: 200, upkeep: 4, work: 250, parking: [1, 0], windows: 'shop',
  designs: O.playground,
});

export const skatePark = place({
  id: 'skate-park', name: 'skate park', kindId: 218, code: 10, group: 'outdoors', tier: 2,
  label: 'Skate park', toolId: 'skatepark', color: '#8a8f99',
  blurb: 'A concrete bowl, a half-pipe, rails and ramps. Free, busy after school and on summer evenings, with a skate jam on Saturday afternoons.',
  howTo: 'One tile near a school or a high street. Older children and young adults come from further than for a playground.',
  attrs: { venueType: 'skatepark', openHours: [8, 21], ticket: 0, stay: [0.8, 2], visitorCapacity: 16, leisureValue: 4, radius: 10,
    eventNights: [5], eventStart: 14, eventSize: 0.7, dayAppeal: 1.0, eveningAppeal: 0.9, retireeAppeal: 0.1, childAppeal: 2.4 },
  cost: 260, upkeep: 4, work: 300, parking: [1, 0], windows: 'shop',
  designs: O.skatePark,
});

export const allotments = place({
  id: 'allotments', name: 'allotments', kindId: 219, code: 10, group: 'outdoors', tier: 3,
  label: 'Allotments', toolId: 'allotments', color: '#7a9a3a',
  blurb: 'Rows of vegetable plots, sheds, water butts and a scarecrow. Retirees spend whole afternoons here; the harvest show is on Sunday mornings.',
  howTo: 'Two by two, door in the front left. A small yearly rent per visit; best near streets of older residents.',
  w: 2, h: 2,
  attrs: { venueType: 'allotments', openHours: [7, 20], ticket: 1, stay: [1.5, 3], visitorCapacity: 24, leisureValue: 4, radius: 10,
    eventNights: [6], eventStart: 11, eventSize: 0.8, dayAppeal: 1.2, eveningAppeal: 0.6, retireeAppeal: 2.6, childAppeal: 0.6 },
  cost: 300, upkeep: 3, work: 400, parking: [2, 0], windows: 'shop',
  designs: O.allotments,
});

export const fishingLake = place({
  id: 'fishing-lake', name: 'fishing lake', kindId: 220, code: 10, group: 'outdoors', tier: 4,
  label: 'Fishing lake', toolId: 'fishinglake', color: '#3f7f9f',
  blurb: 'A stocked lake ringed with fishing pegs, reeds and a bailiff\'s hut. Early starts and long quiet afternoons; a fishing match on Sunday mornings.',
  howTo: 'Two by two. A day ticket pays the bailiff. Anglers drive in from far away, so give it a car park.',
  w: 2, h: 2,
  attrs: { venueType: 'fishing', openHours: [5, 21], ticket: 3, stay: [2, 4], visitorCapacity: 20, leisureValue: 4, radius: 14,
    eventNights: [6], eventStart: 8, eventSize: 0.8, dayAppeal: 1.0, eveningAppeal: 0.7, retireeAppeal: 1.8, childAppeal: 0.7 },
  staff: { jobs: 2, wage: 13, occupation: roster('bailiff', 5, 13, false) },
  cost: 500, upkeep: 6, work: 500, parking: [6, 0], windows: 'shop',
  designs: O.fishingLake,
});

export const natureReserve = place({
  id: 'nature-reserve', name: 'nature reserve', kindId: 221, code: 10, group: 'outdoors', tier: 5,
  label: 'Nature reserve', toolId: 'naturereserve', color: '#4f7a4a',
  blurb: 'Wetland, reed beds and a wildflower meadow round a lake, with boardwalks and a timber bird hide. Free; a dawn chorus walk on Saturdays at first light.',
  howTo: 'Three across, two deep, the visitor centre in the middle of the frontage. Reaches homes a long way off; retirees love it.',
  w: 3, h: 2,
  attrs: { venueType: 'reserve', openHours: [5, 20], ticket: 0, stay: [1, 3], visitorCapacity: 30, leisureValue: 5, radius: 16,
    eventNights: [5], eventStart: 5.5, eventSize: 0.7, dayAppeal: 1.1, eveningAppeal: 0.3, retireeAppeal: 2.4, childAppeal: 1.0 },
  staff: { jobs: 2, wage: 14, occupation: roster('reserve warden', 6, 11, false) },
  cost: 900, upkeep: 10, work: 700, parking: [4, 0], windows: 'shop',
  designs: O.natureReserve,
});

// ================================================================= Active fun (family 13, with sport)

export const lido = place({
  id: 'lido', name: 'lido', kindId: 222, code: 13, group: 'active', tier: 1,
  label: 'Lido', toolId: 'lido', color: '#3fa7d6',
  blurb: 'An open-air pool with a diving board, changing huts and a sun terrace. Packed on warm afternoons; a swimming gala on Saturdays.',
  howTo: 'Two by two, entrance in the front left. Lifeguards on every shift; families come from across the district.',
  w: 2, h: 2,
  attrs: { venueType: 'lido', openHours: [7, 20], ticket: 4, stay: [1, 2.5], visitorCapacity: 60, leisureValue: 5, radius: 16,
    eventNights: [5], eventStart: 14, dayAppeal: 1.5, eveningAppeal: 0.6, retireeAppeal: 0.7, childAppeal: 2.2 },
  staff: { jobs: 6, wage: 13, occupation: roster('lifeguard', 7, 12, false) },
  cost: 1400, upkeep: 22, work: 800, parking: [6, 10], windows: 'shop',
  designs: O.lido,
});

export const tennisClub = place({
  id: 'tennis-club', name: 'tennis club', kindId: 223, code: 13, group: 'active', tier: 2,
  label: 'Tennis club', toolId: 'tennisclub', color: '#5fa04f',
  blurb: 'Two floodlit courts and a clubhouse with a veranda. Court hire by the hour and a club tournament on Sunday afternoons.',
  howTo: 'Two across, one deep. Courts are booked after work, so evenings are busiest.',
  w: 2, h: 1,
  attrs: { venueType: 'tennis', openHours: [8, 21], ticket: 4, stay: [1, 2], visitorCapacity: 16, leisureValue: 4, radius: 12,
    eventNights: [6], eventStart: 13, dayAppeal: 0.9, eveningAppeal: 1.0, retireeAppeal: 0.8, childAppeal: 0.8 },
  staff: { jobs: 2, wage: 15, occupation: roster('tennis coach', 9, 13, true) },
  cost: 700, upkeep: 8, work: 500, parking: [6, 0], windows: 'shop',
  designs: O.tennisClub,
});

export const bowlingAlley = place({
  id: 'bowling-alley', name: 'bowling alley', kindId: 224, code: 13, group: 'active', tier: 3,
  label: 'Bowling alley', toolId: 'bowling', color: '#c0392b',
  blurb: 'Ten-pin lanes under neon, a shoe counter and a snack bar. Birthday parties by day, friends and league teams on Wednesday nights.',
  howTo: 'Two across, one deep, on a busy road. Evenings and weekends are when it fills.',
  w: 2, h: 1,
  attrs: { venueType: 'bowling', openHours: [11, 23], ticket: 7, stay: [1.5, 2.5], visitorCapacity: 40, leisureValue: 5, radius: 16,
    eventNights: [2], eventStart: 19.5, dayAppeal: 0.6, eveningAppeal: 1.5, retireeAppeal: 0.6, childAppeal: 1.4 },
  staff: { jobs: 6, wage: 13, occupation: roster('bowling alley staff', 11, 16, true) },
  cost: 1100, upkeep: 16, work: 600, parking: [8, 12],
  designs: O.bowlingAlley,
});

export const iceRink = place({
  id: 'ice-rink', name: 'ice rink', kindId: 225, code: 13, group: 'active', tier: 4,
  label: 'Ice rink', toolId: 'icerink', color: '#9fd3ea',
  blurb: 'A full-size rink under a curved roof, skate hire and a gallery café. Public sessions all day and an ice disco on Friday nights.',
  howTo: 'Two by two, entrance in the front left. A big draw for families across the town.',
  w: 2, h: 2,
  attrs: { venueType: 'icerink', openHours: [10, 22], ticket: 7, stay: [1.2, 2.2], visitorCapacity: 70, leisureValue: 6, radius: 18,
    eventNights: [4], eventStart: 19.5, eventSize: 1.1, dayAppeal: 0.9, eveningAppeal: 1.2, retireeAppeal: 0.5, childAppeal: 1.9 },
  staff: { jobs: 8, wage: 14, occupation: roster('rink attendant', 9, 15, true) },
  cost: 2600, upkeep: 34, work: 1000, parking: [10, 16],
  designs: O.iceRink,
});

export const rollerDisco = place({
  id: 'roller-disco', name: 'roller disco', kindId: 226, code: 13, group: 'active', tier: 5,
  label: 'Roller disco', toolId: 'rollerdisco', color: '#d94fa0',
  blurb: 'A maple skating floor under a mirror ball and coloured lights, with skate hire and a DJ booth. Children\'s sessions by day, the big night on Saturdays.',
  howTo: 'One tile on a lively street. Children and young adults love it.',
  attrs: { venueType: 'rollerdisco', openHours: [12, 22], ticket: 5, stay: [1.2, 2], visitorCapacity: 30, leisureValue: 4, radius: 12,
    eventNights: [5], eventStart: 18.5, dayAppeal: 0.6, eveningAppeal: 1.4, retireeAppeal: 0.3, childAppeal: 1.8 },
  staff: { jobs: 3, wage: 13, occupation: roster('roller disco staff', 12, 15, true) },
  cost: 800, upkeep: 10, work: 400, parking: [3, 6],
  designs: O.rollerDisco,
});

export const climbingCentre = place({
  id: 'climbing-centre', name: 'climbing centre', kindId: 227, code: 13, group: 'active', tier: 6,
  label: 'Climbing centre', toolId: 'climbing', color: '#e06a2e',
  blurb: 'A tall hall of coloured holds on angled walls, ropes and a bouldering cave. After-work climbers and a bouldering competition on Thursdays.',
  howTo: 'One tall tile. Popular with adults after work and older children at weekends.',
  attrs: { venueType: 'climbing', openHours: [9, 22], ticket: 8, stay: [1.5, 2.5], visitorCapacity: 24, leisureValue: 5, radius: 14,
    eventNights: [3], eventStart: 19, dayAppeal: 0.8, eveningAppeal: 1.2, retireeAppeal: 0.2, childAppeal: 1.2 },
  staff: { jobs: 3, wage: 15, occupation: roster('climbing instructor', 9, 14, true) },
  cost: 900, upkeep: 12, work: 450, parking: [3, 6],
  designs: O.climbingCentre,
});

export const trampolinePark = place({
  id: 'trampoline-park', name: 'trampoline park', kindId: 228, code: 13, group: 'active', tier: 7,
  label: 'Trampoline park', toolId: 'trampoline', color: '#2fbf8f',
  blurb: 'Wall-to-wall trampolines, a foam pit and a dodgeball court. Children bounce for an hour at a time; families come together on Sunday mornings.',
  howTo: 'Two across, one deep. Mostly children, mostly by day.',
  w: 2, h: 1,
  attrs: { venueType: 'trampoline', openHours: [9, 20], ticket: 8, stay: [1, 1.5], visitorCapacity: 36, leisureValue: 4, radius: 14,
    eventNights: [6], eventStart: 10.5, dayAppeal: 1.2, eveningAppeal: 0.7, retireeAppeal: 0.1, childAppeal: 2.6 },
  staff: { jobs: 4, wage: 13, occupation: roster('trampoline park marshal', 9, 13, true) },
  cost: 1000, upkeep: 14, work: 500, parking: [6, 8],
  designs: O.trampolinePark,
});

export const goKartTrack = place({
  id: 'go-kart-track', name: 'go-kart track', kindId: 229, code: 13, group: 'active', tier: 8,
  label: 'Go-kart track', toolId: 'karting', color: '#d9b02e',
  blurb: 'A twisting outdoor circuit with tyre walls, a pit lane and a grandstand. Races every half hour and a grand prix on Saturday nights.',
  howTo: 'Three across, two deep, away from quiet streets: it is noisy. A big ticket and a big draw.',
  w: 3, h: 2,
  attrs: { venueType: 'karting', openHours: [10, 22], ticket: 15, stay: [1, 2], visitorCapacity: 24, leisureValue: 6, radius: 20,
    eventNights: [5], eventStart: 19, eventSize: 1.2, dayAppeal: 0.8, eveningAppeal: 1.3, retireeAppeal: 0.2, childAppeal: 1.0 },
  staff: { jobs: 5, wage: 14, occupation: roster('kart marshal', 10, 15, true) },
  cost: 2000, upkeep: 26, work: 900, parking: [10, 0], windows: 'shop',
  designs: O.goKartTrack,
});

// ================================================================= Days out (family 14, with the museum)

export const cityFarm = place({
  id: 'city-farm', name: 'city farm', kindId: 251, code: 14, group: 'daysout', tier: 1,
  label: 'City farm', toolId: 'cityfarm', color: '#b07a3a',
  blurb: 'Sheep, goats, pigs, hens and a pony in pens round a red barn, with a feed shop and a picnic lawn. Free; an open day on Sundays.',
  howTo: 'Two by two, the gate in the front left. Children adore it; it closes at teatime.',
  w: 2, h: 2,
  attrs: { venueType: 'farm', openHours: [9, 17], ticket: 0, stay: [1, 2], visitorCapacity: 40, leisureValue: 5, radius: 14,
    eventNights: [6], eventStart: 11, dayAppeal: 1.3, eveningAppeal: 0.1, retireeAppeal: 1.6, childAppeal: 2.8 },
  staff: { jobs: 4, wage: 13, occupation: roster('farm hand', 7, 10, false) },
  cost: 1100, upkeep: 14, work: 700, parking: [6, 0], windows: 'shop',
  designs: I.cityFarm,
});

export const aquarium = place({
  id: 'aquarium', name: 'aquarium', kindId: 252, code: 14, group: 'daysout', tier: 2,
  label: 'Aquarium', toolId: 'aquarium', color: '#2f7fbf',
  blurb: 'A rock-pool touch tank, a shark tank and a glass tunnel under a coral reef. A long rainy-day outing; feeding time draws a crowd at weekends.',
  howTo: 'Two by two, doors in the front left. Families travel across town for it.',
  w: 2, h: 2,
  attrs: { venueType: 'aquarium', openHours: [10, 18], ticket: 10, stay: [1.5, 2.5], visitorCapacity: 90, leisureValue: 7, radius: 22,
    eventNights: [5, 6], eventStart: 14, eventSize: 0.8, dayAppeal: 1.3, eveningAppeal: 0.3, retireeAppeal: 1.4, childAppeal: 2.3 },
  staff: { jobs: 8, wage: 16, occupation: roster('aquarist', 8, 11, false) },
  cost: 3000, upkeep: 40, work: 1100, parking: [10, 20], windows: 'office',
  designs: I.aquarium,
});

export const planetarium = place({
  id: 'planetarium', name: 'planetarium', kindId: 253, code: 14, group: 'daysout', tier: 3,
  label: 'Planetarium', toolId: 'planetarium', color: '#2a2f6a',
  blurb: 'A domed theatre where the night sky turns overhead, with a space gallery in the foyer. Shows every hour and a big star show on Friday nights.',
  howTo: 'Two by two under its dome, doors in the front left. Draws all ages from far away.',
  w: 2, h: 2,
  attrs: { venueType: 'planetarium', openHours: [10, 21], ticket: 8, stay: [1, 1.5], visitorCapacity: 80, leisureValue: 6, radius: 20,
    eventNights: [4], eventStart: 19.5, eventSize: 1.2, dayAppeal: 1.0, eveningAppeal: 1.0, retireeAppeal: 1.3, childAppeal: 1.8 },
  staff: { jobs: 5, wage: 16, occupation: roster('planetarium presenter', 9, 13, true) },
  cost: 2600, upkeep: 32, work: 1000, parking: [8, 16], windows: 'office',
  designs: I.planetarium,
});

export const scienceCentre = place({
  id: 'science-centre', name: 'science centre', kindId: 254, code: 14, group: 'daysout', tier: 4,
  label: 'Science centre', toolId: 'sciencecentre', color: '#e0662e',
  blurb: 'Hands-on halls of buttons, levers, bubbles and a great swinging pendulum. School holidays fill it; a late opening for grown-ups on Thursdays.',
  howTo: 'Two by two, doors in the front left. The best day out for children in town.',
  w: 2, h: 2,
  attrs: { venueType: 'science', openHours: [10, 21], ticket: 9, stay: [2, 3], visitorCapacity: 100, leisureValue: 7, radius: 22,
    eventNights: [3], eventStart: 18.5, dayAppeal: 1.3, eveningAppeal: 0.5, retireeAppeal: 1.0, childAppeal: 2.6 },
  staff: { jobs: 8, wage: 15, occupation: roster('science explainer', 9, 13, false) },
  cost: 3200, upkeep: 40, work: 1200, parking: [10, 20], windows: 'office',
  designs: I.scienceCentre,
});

export const observatory = place({
  id: 'observatory', name: 'observatory', kindId: 255, code: 14, group: 'daysout', tier: 5,
  label: 'Observatory', toolId: 'observatory', color: '#3a3f5a',
  blurb: 'A white dome with a big telescope and a viewing terrace. Open from dusk; on Saturday nights the astronomers run a stargazing evening.',
  howTo: 'One tile, ideally away from bright avenues. Only open in the evening.',
  attrs: { venueType: 'observatory', openHours: [18, 24], ticket: 5, stay: [1.5, 3], visitorCapacity: 20, leisureValue: 5, radius: 18,
    eventNights: [5], eventStart: 21, dayAppeal: 0, eveningAppeal: 1.4, retireeAppeal: 1.3, childAppeal: 1.0 },
  staff: { jobs: 2, wage: 17, occupation: roster('astronomer', 17, 18, true) },
  cost: 1200, upkeep: 14, work: 600, parking: [3, 0], windows: 'office',
  designs: I.observatory,
});

export const funfair = place({
  id: 'funfair', name: 'funfair', kindId: 250, code: 14, group: 'daysout', tier: 6,
  label: 'Funfair', toolId: 'funfair', color: '#e0402e',
  blurb: 'A Ferris wheel over a carousel, dodgems, a helter-skelter and stalls of candyfloss. The biggest day out in town, with fireworks on Saturday nights.',
  howTo: 'Three by three, the gate in the middle of the frontage. Needs room around it for the crowds and parking.',
  w: 3, h: 3,
  attrs: { venueType: 'funfair', openHours: [11, 23], ticket: 9, stay: [2, 3.5], visitorCapacity: 160, leisureValue: 8, radius: 24,
    eventNights: [5], eventStart: 21, eventSize: 2.0, dayAppeal: 1.2, eveningAppeal: 1.4, retireeAppeal: 0.8, childAppeal: 2.4 },
  staff: { jobs: 14, wage: 14, occupation: roster('ride operator', 11, 16, true) },
  cost: 4500, upkeep: 60, work: 1600, parking: [14, 0], windows: 'shop',
  designs: I.funfair,
});

// ================================================================= Arts and games (family 12 with the theatre, 11 with the cinema)

export const artGallery = place({
  id: 'art-gallery', name: 'art gallery', kindId: 118, code: 12, group: 'hobbies', tier: 1,
  label: 'Art gallery', toolId: 'gallery', color: '#c8b28a',
  blurb: 'White rooms of paintings and sculpture under skylights. Free to visit; an exhibition opening on Thursday evenings.',
  howTo: 'One tile on a smart street. Retirees and art lovers come from across the district.',
  attrs: { venueType: 'gallery', openHours: [10, 19], ticket: 0, stay: [1, 2], visitorCapacity: 30, leisureValue: 4, radius: 14,
    eventNights: [3], eventStart: 18, eventSize: 0.8, dayAppeal: 1.1, eveningAppeal: 0.4, retireeAppeal: 2.0, childAppeal: 0.8 },
  staff: { jobs: 3, wage: 15, occupation: roster('gallery attendant', 10, 11, false) },
  cost: 900, upkeep: 12, work: 450, parking: [2, 4], windows: 'office',
  designs: I.artGallery,
});

export const potteryStudio = place({
  id: 'pottery-studio', name: 'pottery studio', kindId: 119, code: 12, group: 'hobbies', tier: 2,
  label: 'Pottery studio', toolId: 'pottery', color: '#b8643a',
  blurb: 'Potter\'s wheels, a kiln and shelves of drying pots. Evening classes after work and an open studio on Sunday lunchtimes.',
  howTo: 'One tile, a quiet street will do. Adults and retirees book a class.',
  attrs: { venueType: 'pottery', openHours: [10, 21], ticket: 12, stay: [2, 2.5], visitorCapacity: 12, leisureValue: 5, radius: 12,
    eventNights: [6], eventStart: 12, eventSize: 0.6, dayAppeal: 0.9, eveningAppeal: 1.1, retireeAppeal: 1.5, childAppeal: 0.9 },
  staff: { jobs: 2, wage: 14, occupation: roster('pottery tutor', 10, 13, true) },
  cost: 600, upkeep: 8, work: 350, parking: [2, 0], windows: 'shop',
  designs: I.potteryStudio,
});

export const danceHall = place({
  id: 'dance-hall', name: 'dance hall', kindId: 140, code: 12, group: 'hobbies', tier: 3,
  label: 'Dance hall', toolId: 'dancehall', color: '#c84a6a',
  blurb: 'A sprung floor under chandeliers with a bandstand at one end. Classes in the week and the tea dance on Sunday afternoons.',
  howTo: 'One tile. Retirees adore the tea dance; couples come for the evening classes.',
  attrs: { venueType: 'dancehall', openHours: [13, 23], ticket: 4, stay: [1.5, 3], visitorCapacity: 40, leisureValue: 5, radius: 14,
    eventNights: [6], eventStart: 14.5, dayAppeal: 0.9, eveningAppeal: 1.1, retireeAppeal: 2.4, childAppeal: 0.4 },
  staff: { jobs: 4, wage: 14, occupation: roster('dance teacher', 13, 15, true) },
  cost: 900, upkeep: 12, work: 450, parking: [3, 6],
  designs: I.danceHall,
});

export const concertHall = place({
  id: 'concert-hall', name: 'concert hall', kindId: 129, code: 12, group: 'hobbies', tier: 4,
  label: 'Concert hall', toolId: 'concerthall', color: '#7a5a2a',
  blurb: 'A great hall with an organ and an orchestra in residence: concerts three nights a week and lunchtime recitals.',
  howTo: 'Two by two, doors in the front left, near restaurants and a station. Draws from across the city.',
  w: 2, h: 2,
  attrs: { venueType: 'concert', openHours: [12, 23], ticket: 16, stay: [2.2, 3], visitorCapacity: 120, leisureValue: 8, radius: 24,
    eventNights: [3, 4, 5], eventStart: 19.5, eventSize: 1.4, dayAppeal: 0.2, eveningAppeal: 1.3, retireeAppeal: 1.8, childAppeal: 0.6 },
  staff: { jobs: 24, wage: 18, occupation: roster('orchestra musician', 12, 15, true) },
  cost: 3400, upkeep: 44, work: 1200, parking: [10, 20], windows: 'venue',
  designs: I.concertHall,
});

export const arcade = place({
  id: 'arcade', name: 'family arcade', kindId: 147, code: 11, group: 'hobbies', tier: 5,
  label: 'Family arcade', toolId: 'arcade', color: '#f05ad0',
  blurb: 'Retro video games, air hockey, a racing simulator and a claw machine, paid in tokens. After school and wet weekends; high-score night on Fridays.',
  howTo: 'One tile on a high street or by the seafront. Children and teenagers love it.',
  attrs: { venueType: 'arcade', openHours: [10, 22], ticket: 4, stay: [0.8, 1.6], visitorCapacity: 30, leisureValue: 4, radius: 12,
    eventNights: [4], eventStart: 18, eventSize: 0.7, dayAppeal: 0.8, eveningAppeal: 1.1, retireeAppeal: 0.2, childAppeal: 2.4 },
  staff: { jobs: 2, wage: 12, occupation: roster('arcade attendant', 10, 14, true) },
  cost: 600, upkeep: 8, work: 300, parking: [2, 4],
  designs: I.arcade,
});

export const boardGameCafe = place({
  id: 'board-game-cafe', name: 'board-game café', kindId: 148, code: 11, group: 'hobbies', tier: 6,
  label: 'Board-game café', toolId: 'gamescafe', color: '#5a8a3a',
  blurb: 'Shelves of hundreds of games, big tables, hot chocolate and a games guru to teach the rules. A tournament on Tuesday nights.',
  howTo: 'One tile. Friends and families settle in for a whole evening.',
  attrs: { venueType: 'boardgames', openHours: [11, 23], ticket: 5, stay: [2, 3.5], visitorCapacity: 28, leisureValue: 4, radius: 12,
    eventNights: [1], eventStart: 19, eventSize: 0.8, dayAppeal: 0.7, eveningAppeal: 1.3, retireeAppeal: 0.8, childAppeal: 1.3 },
  staff: { jobs: 3, wage: 12, occupation: roster('games guru', 11, 15, true) },
  cost: 500, upkeep: 6, work: 300, parking: [2, 0], windows: 'shop',
  designs: I.boardGameCafe,
});

export const escapeRoom = place({
  id: 'escape-room', name: 'escape room', kindId: 149, code: 11, group: 'hobbies', tier: 7,
  label: 'Escape room', toolId: 'escaperoom', color: '#6a4a8a',
  blurb: 'Themed puzzle rooms: a professor\'s study, a pirate\'s cabin, a space station. An hour to find the clues and open the door.',
  howTo: 'One tile. Teams of friends and families book an evening slot.',
  attrs: { venueType: 'escape', openHours: [11, 22], ticket: 14, stay: [1, 1.3], visitorCapacity: 18, leisureValue: 5, radius: 16,
    dayAppeal: 0.7, eveningAppeal: 1.3, retireeAppeal: 0.4, childAppeal: 1.0 },
  staff: { jobs: 2, wage: 13, occupation: roster('escape room host', 11, 14, true) },
  cost: 700, upkeep: 9, work: 350, parking: [2, 4],
  designs: I.escapeRoom,
});

/** Every free-time place, in picker order within each group. */
export const ATTRACTIONS: KindDef[] = [
  playground, skatePark, allotments, fishingLake, natureReserve,
  lido, tennisClub, bowlingAlley, iceRink, rollerDisco, climbingCentre, trampolinePark, goKartTrack,
  cityFarm, aquarium, planetarium, scienceCentre, observatory, funfair,
  artGallery, potteryStudio, danceHall, concertHall, arcade, boardGameCafe, escapeRoom,
];
