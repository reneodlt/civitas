import { hash2, type AmbienceHint, Terrain, terrainOf, isRoad, zoneOf, familyOf, underConstruction, footprintOf, KIND_ID_COUNT, Zone } from '@msimcity/shared';
import type { AudioEngine } from './engine';
import { fire, makeBed, ringBell, type Bed, type BedId } from './voices';
import { StreetLife, type StreetAgent } from './street';
import { VOICES } from './manifest';

/**
 * The ambient mix (docs/audio.md). Every 250 ms (never per frame) it reads what the client already knows: the vehicles
 * and walkers drawn round the camera, the kinds of tile in a radius round the camera target, the hour and the zoom
 * distance, and turns that into a target level and tone for each bed, which the beds glide to over one to three
 * seconds. Events (birds, owls, horns, bells, the crossing's beep) are drawn on Poisson clocks from the same numbers.
 */
const TICK_MS = 250;

export interface AgentLike { rx: number; rz: number; car: boolean; trav: boolean }
export interface AmbSources {
  /** the game hour, 0..24 */
  hour(): number;
  /** where the hour comes from, for the audio readout: "clock", or "pinned light (tour stop)" */
  hourSource?(): string;
  camera(): { x: number; z: number; dist: number; map: boolean; rightX: number; rightZ: number };
  tileAt(x: number, y: number): number | undefined;
  kindIdAt(x: number, y: number): number;
  agents(): Iterable<AgentLike>;
  /** every agent drawn with its id, without allocating (Map.forEach): the street-life layer (street.ts) needs the id to hear one vehicle once; without it the scan reads agents() and the street is silent */
  eachAgent?(f: (a: StreetAgent, id: number) => void): void;
  /** the nearest signal crossing within `r` tiles of (x, z) that holds the cars at red (render/signals.ts redPelicanNear) */
  pelican?(x: number, z: number, r: number): { x: number; z: number } | null;
  /** which city this is (the server it is connected to, or the demo): a district bed picks its recording by a hash of it, so a city always sounds like itself and two cities differ */
  city?(): string;
}

/** what the tile scan found round the camera, as shares of the tiles sampled (0..1) */
export interface Scan {
  /** homes, shops and offices together (`off` says how much of it is offices), industry and power, parks and gardens, water and roads: shares of the tiles sampled (0..1) */
  res: number; com: number; ind: number; park: number; water: number; road: number; bell: number; bellDeep: number; cars: number; walkers: number;
  /** the share of tiles that are offices (a part of `com`), and the share that are civic, cultural, education, sport or landmark buildings (the district model, zonesOf) */
  off: number; civic: number;
  /** the tiles under construction in the sample (a count: the builders' digging needs one), */
  sites: number;
  /** counts of the sampled tiles that are a school or nursery, a stadium, a fire station, a police station, a builders' depot, a fountain */
  school: number; stadium: number; fire: number; police: number; builders: number; fountain: number;
}
export const newScan = (): Scan => ({ res: 0, com: 0, ind: 0, park: 0, water: 0, road: 0, bell: 0, bellDeep: 0, cars: 0, walkers: 0, off: 0, civic: 0, sites: 0, school: 0, stadium: 0, fire: 0, police: 0, builders: 0, fountain: 0 });

/** kind ids that give a place its own sound (the second pass): which Scan count each raises */
const SPOT_KIND = new Map<number, 'school' | 'stadium' | 'fire' | 'police' | 'builders' | 'fountain'>([
  [101, 'school'], [102, 'school'], [103, 'school'], [67, 'stadium'], [186, 'stadium'], [199, 'stadium'],
  [50, 'fire'], [51, 'fire'], [52, 'fire'], [46, 'police'], [47, 'police'], [48, 'police'], [49, 'police'], [54, 'builders'], [55, 'builders'], [144, 'fountain'],
]);

/** the families that are civic, cultural, education, sport or landmark: police 5, fire 6, hospital 7, cinema 11, theatre 12, sport 13, library, school and landmark 14 */
const CIVIC_FAMILY = new Set<number>([5, 6, 7, 11, 12, 13, 14]);

/**
 * What a tile of each kind counts for in the zone shares: one for a house, less for a tile of a big building, so a street reads by its
 * buildings and not by the floor area of the biggest (a theatre or a landmark is a dozen tiles but one building). 1 over the root of its footprint.
 */
const TILE_W = new Float32Array(Math.max(256, KIND_ID_COUNT));
for (let id = 0; id < TILE_W.length; id++) { const f = footprintOf(id); TILE_W[id] = 1 / Math.sqrt(Math.max(1, f.w * f.h)); }

/** kind ids that ring the hour: the churchyard (151) and the Houses of Parliament (96) */
const BELL_KIND = 151, BELL_DEEP_KIND = 96;
/** power stations hum like works */
const POWER_FIRST = 163, POWER_LAST = 164;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

/** how busy the city is at an hour, 0.4 at night (after midnight and before 05:00) to 1 by day: a city is never silent */
export const NIGHT_FLOOR = 0.4;
export const activityAt = (h: number) => (h < 5 ? NIGHT_FLOOR : h < 8 ? lerp(NIGHT_FLOOR, 1, (h - 5) / 3) : h < 21 ? 1 : lerp(1, NIGHT_FLOOR, Math.min(1, (h - 21) / 3)));

/** an hour as 08:05 (the audio readout's words) */
export const hm = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const pc = (v: number) => `${Math.round(v * 100)}%`;
/** the most each bed is driven to, rain included (HINT_CEIL covers the beds a tour stop can name) */
const CEIL = (id: string) => (id === 'rain-light' ? 0.45 : id === 'rain-heavy' ? 0.55 : (HINT_CEIL as Record<string, number>)[id] ?? 1);

/**
 * In words, what a bed is being driven by (the audio readout): the numbers the 250 ms tick read, the share of the bed's ceiling it
 * is aiming at and the tour stop's hold on it, if any. Pure.
 */
export function bedWhy(id: string, sc: Scan, dist: number, hour: number, level: number, hint: AmbienceHint | null, map: boolean, rain = 0, lead: Zn | null = null): string {
  const d = Math.round(dist), t = hm(hour);
  const zo = zonesOf(sc, lead), dz = zoneText(zo);
  let inputs: string;
  switch (id) {
    case 'traffic': inputs = `cars near ${sc.cars} (full from ${Math.round(carKnee(dist))}), roads ${pc(sc.road)} of tiles, zoom ${d}, hour ${t}; district: ${dz}`; break;
    case 'wind': inputs = `zoom ${d} (louder the higher the camera)`; break;
    case 'crowd': inputs = `walkers ${sc.walkers} (${peopleNear(sc, dist).toFixed(2)} of a crowd), zoom ${d}, hour ${t}; district: ${dz}`; break;
    case 'industry': inputs = `industry and power ${pc(sc.ind)} of tiles, zoom ${d}, hour ${t}; district: ${dz}`; break;
    case 'zone-ind': case 'zone-com': case 'zone-off': case 'zone-res': case 'zone-civic': {
      const z = ZONES.find((k) => ZONE_BED[k] === id)!;
      inputs = `${dz}; ${ZONE_NAME[z]} weight ${zo.w[z].toFixed(2)}, built ${pc(zo.presence)} of presence, zoom ${d}, hour ${t}`;
      break;
    }
    case 'water': inputs = `water ${pc(sc.water)} of tiles, zoom ${d}`; break;
    case 'market': inputs = `shops ${pc(Math.max(0, sc.com - sc.off))}, walkers ${sc.walkers}, hour ${t} (08:00 to 17:00)`; break;
    case 'pub': inputs = `shops ${pc(Math.max(0, sc.com - sc.off))}, hour ${t} (16:30 to midnight)`; break;
    case 'playground': inputs = `schools in view ${sc.school}, hour ${t} (08:45 to 15:30)`; break;
    case 'stadium': inputs = `stadiums in view ${sc.stadium}, hour ${t} (13:00 to 22:00)`; break;
    case 'fountain': inputs = `fountains in view ${sc.fountain}, zoom ${d}`; break;
    case 'rain-light': case 'rain-heavy': inputs = `weather ${rain.toFixed(2)}`; break;
    default: inputs = `zoom ${d}, hour ${t}`;
  }
  const held = (hint as Record<string, number | undefined> | null)?.[id];
  return `${inputs} → ${(level / CEIL(id)).toFixed(2)} of its ceiling${map ? ' (map view: thinned)' : ''}${held !== undefined ? `; tour stop holds it at ${held}` : ''}`;
}

/** why a second-pass event fired, in words: the Poisson rate it was drawn at and the numbers behind it */
export function placeWhy(id: string, sc: Scan, dist: number, hour: number, lambda: number, lead: Zn | null = null): string {
  const t = hm(hour), d = Math.round(dist), dz = zoneText(zonesOf(sc, lead));
  const w: Record<string, string> = {
    gust: `high camera, zoom ${d}`, footsteps: `walkers ${sc.walkers} close in (${peopleNear(sc, dist).toFixed(2)} of a crowd), hour ${t}`, siren: `police stations in view ${sc.police}`, 'siren-fire': `fire stations in view ${sc.fire}`,
    seagulls: `water ${pc(sc.water)} of tiles, by day (${t})`, pigeons: `parks ${pc(sc.park)}, ${dz}, by day (${t})`, dog: `${dz}, hour ${t}`,
    'bike-bell': `walkers ${sc.walkers} on roads ${pc(sc.road)}, by day (${t})`, 'bin-lorry': `${dz}, morning (${t})`, 'station-chime': `${dz}, by day (${t})`,
    'heli-over': `camera high, zoom ${d}, by day (${t})`, 'plane-over': `camera high, zoom ${d}, hour ${t}`, 'boat-horn': `water ${pc(sc.water)} of tiles, zoom ${d}`,
    hammer: `sites under construction ${sc.sites}, builders' depots ${sc.builders}, working hours (${t})`, drill: `sites under construction ${sc.sites}, builders' depots ${sc.builders}, working hours (${t})`, lawnmower: `${dz}, hour ${t}`, thunder: 'storm',
    'metal-clank': `${dz}, works hours (${t})`, 'reverse-beep': `${dz}, works hours (${t})`, 'steam-vent': `${dz}, hour ${t}`,
    till: `${dz}, shop hours (${t})`, 'shop-bell': `${dz}, shop hours (${t})`, busker: `${dz}, walkers ${sc.walkers}, hour ${t}`, 'music-door': `${dz}, hour ${t}`,
    'revolving-door': `${dz}, office hours (${t})`, 'lift-ding': `${dz}, office hours (${t})`,
    'radio-window': `${dz}, hour ${t}`, 'front-door': `${dz}, hour ${t}`, 'kids-yard': `${dz}, hour ${t}`,
    'camera-shutter': `${dz}, tourist hours (${t})`,
  };
  return `${w[id] ?? `zoom ${d}, hour ${t}`}; drawn at ${lambda.toFixed(3)} a second`;
}

/**
 * Fill `out` from the tiles round (cx, cz) within `rad` tiles (a grid of at most 15 by 15 samples) and the agents drawn round it. `visit`, when
 * the source can hand over each agent with its id (eachAgent), is called for every agent in the same walk: the street-life layer's share of the
 * pass (street.ts), so the agents are walked once a tick.
 */
export function scanAround(src: AmbSources, cx: number, cz: number, dist: number, out: Scan, visit?: (a: StreetAgent, id: number, dx: number, dz: number, d2: number) => void): Scan {
  const rad = Math.max(6, Math.min(24, dist * 0.5)), step = Math.max(1, Math.floor(rad / 7));
  let n = 0, res = 0, com = 0, off = 0, civic = 0, sites = 0, ind = 0, park = 0, water = 0, road = 0, bell = 0, deep = 0;
  const x0 = Math.floor(cx), z0 = Math.floor(cz);
  out.school = out.stadium = out.fire = out.police = out.builders = out.fountain = 0;
  for (let dz = -rad; dz <= rad; dz += step) {
    for (let dx = -rad; dx <= rad; dx += step) {
      const x = x0 + Math.round(dx), z = z0 + Math.round(dz), t = src.tileAt(x, z);
      if (t === undefined) continue;
      n++;
      if (terrainOf(t) === Terrain.Water) { water++; continue; }
      if (isRoad(t)) { road++; continue; }
      const z4 = zoneOf(t);
      if (z4 === 0) continue;
      if (underConstruction(t)) sites++;
      const id = src.kindIdAt(x, z), fam = familyOf(id);
      if (id === BELL_KIND) bell++; else if (id === BELL_DEEP_KIND) deep++;
      const spot = SPOT_KIND.get(id);
      if (spot) out[spot]++;
      const wt = TILE_W[id] ?? 1;
      if (fam === Zone.Residential) res += wt;
      else if (fam === Zone.Commercial) com += wt;
      else if (fam === Zone.Office) { com += wt; off += wt; }
      else if (CIVIC_FAMILY.has(fam)) civic += wt;
      else if (fam === Zone.Industrial || (id >= POWER_FIRST && id <= POWER_LAST)) ind += wt;
      else if (fam === 10) park++;
    }
  }
  const k = n ? 1 / n : 0;
  out.res = res * k; out.com = com * k; out.ind = ind * k; out.park = park * k; out.water = water * k; out.road = road * k; out.off = off * k; out.civic = civic * k; out.sites = sites;
  out.bell = bell; out.bellDeep = deep;
  // agents: cars within a radius that grows with the zoom, walkers within a smaller one
  const rc = Math.max(25, Math.min(140, dist * 0.9)), rw = Math.max(15, Math.min(60, dist * 0.5));
  const rc2 = rc * rc, rw2 = rw * rw;
  let cars = 0, walkers = 0;
  if (visit && src.eachAgent) {
    src.eachAgent((a, id) => {
      const dx = a.rx - cx, dz = a.rz - cz, d2 = dx * dx + dz * dz;
      if (a.car) { if (d2 < rc2) cars++; } else if (a.trav && d2 < rw2) walkers++;
      visit(a, id, dx, dz, d2);
    });
  } else {
    for (const a of src.agents()) {
      const dx = a.rx - cx, dz = a.rz - cz, d2 = dx * dx + dz * dz;
      if (a.car) { if (d2 < rc2) cars++; } else if (a.trav && d2 < rw2) walkers++;
    }
  }
  out.cars = cars; out.walkers = walkers;
  return out;
}

// ---- the districts (docs/audio.md "Districts") ----------------------------------------------------------------------------

/** the five kinds of street the ear can tell apart, in the order a dead heat is settled (shops win a tie) */
export type Zn = 'com' | 'off' | 'ind' | 'civic' | 'res';
export const ZONES: readonly Zn[] = ['com', 'off', 'ind', 'civic', 'res'];
export const ZONE_NAME: Record<Zn, string> = { com: 'commercial', off: 'office', ind: 'industrial', civic: 'civic', res: 'residential' };
/** the bed each district plays (its recorded signature) */
export const ZONE_BED: Record<Zn, BedId> = { com: 'zone-com', off: 'zone-off', ind: 'zone-ind', civic: 'zone-civic', res: 'zone-res' };
/**
 * The soft-max's exponent and the lead's hysteresis. A zone's weight is its share to the power SOFT over the sum of them all, so the
 * street is mostly one thing: 0.55 against 0.45 becomes 0.73 against 0.27, 0.6 against 0.4 becomes 0.88 against 0.12, and 0.9 against
 * 0.1 is 1 against 0. The zone that led at the last tick counts LEAD times its share, so a street on the border does not flip.
 */
const SOFT = 5, LEAD = 1.25;
/** a weight turned into how much of its bed is let through: nothing under 0.08, all of it from 0.6 */
export const zoneGain = (w: number) => smooth(0.08, 0.6, w);

export interface Zoning {
  /** each zone's share of the built tiles sampled (they sum to 1; all 0 where nothing is built) */
  share: Record<Zn, number>;
  /** the soft-max weights (sum to 1) */
  w: Record<Zn, number>;
  /** the zone that wins, or null where nothing is built */
  win: Zn | null;
  /** 0 where nothing is built, 1 from a built share of about 12% of the tiles sampled (a street, not open country) */
  presence: number;
}
export const newZoning = (): Zoning => ({ share: { com: 0, off: 0, ind: 0, civic: 0, res: 0 }, w: { com: 0, off: 0, ind: 0, civic: 0, res: 0 }, win: null, presence: 0 });

/**
 * Which district the camera is in, from the scan: the zone shares of the built tiles (offices apart from shops, civic apart from both),
 * a soft-max over them for the weights, and the winner. `lead` is the zone that won last time (the hysteresis). Pure.
 */
export function zonesOf(s: Scan, lead: Zn | null = null, out: Zoning = newZoning()): Zoning {
  const raw: Record<Zn, number> = { com: Math.max(0, s.com - s.off), off: s.off, ind: s.ind, civic: s.civic, res: s.res };
  let total = 0;
  for (const z of ZONES) total += raw[z];
  out.presence = smooth(0.03, 0.12, total);
  if (total <= 1e-9) { for (const z of ZONES) { out.share[z] = 0; out.w[z] = 0; } out.win = null; return out; }
  let sum = 0, best: Zn = 'com', bestP = -1;
  for (const z of ZONES) {
    out.share[z] = raw[z] / total;
    const p = Math.pow(out.share[z] * (z === lead ? LEAD : 1), SOFT);
    out.w[z] = p; sum += p;
    if (p > bestP + 1e-12) { bestP = p; best = z; }
  }
  for (const z of ZONES) out.w[z] /= sum;
  out.win = best;
  return out;
}
/** how much of its bed a district is given: its soft-max weight through the gain, and the presence (nothing built, nothing heard) */
export const zoneLevel = (zo: Zoning, z: Zn) => zoneGain(zo.w[z]) * zo.presence;

/** the readout's words: "commercial 0.62 wins, industrial 0.21, residential 0.17; ducked" */
export function zoneText(zo: Zoning): string {
  if (!zo.win) return 'nothing built in the view: no district bed';
  const rest = ZONES.filter((z) => z !== zo.win && zo.share[z] >= 0.02).sort((a, b) => zo.share[b] - zo.share[a]).map((z) => `${ZONE_NAME[z]} ${zo.share[z].toFixed(2)}`);
  return `${ZONE_NAME[zo.win]} ${zo.share[zo.win].toFixed(2)} wins${rest.length ? `, ${rest.join(', ')}; ducked` : ''}`;
}

/** how much the cars of a street are heard, by district: a lorry yard and a shopping street are busy, a terrace is quiet */
const TRAFFIC_BY: Record<Zn, number> = { ind: 0.85, com: 0.7, off: 0.8, civic: 0.55, res: 0.4 };
/**
 * How much a district's talk is heard on top of the walkers drawn: the shops and the squares are all talk, the yards and the terraces little.
 * Balanced with peopleNear's knee so a shopping street with 20 walkers in the circle sits at about half the bed's ceiling, a terrace with 5 at a tenth.
 */
const CROWD_BY: Record<Zn, number> = { com: 0.52, civic: 0.52, off: 0.35, res: 0.25, ind: 0.05 };
const byZone = (zo: Zoning, t: Record<Zn, number>) => { let v = 0; for (const z of ZONES) v += zo.w[z] * t[z]; return v; };
/** the walkers drawn near the camera per 15-tile circle (the scan's circle grows with the zoom, so the same count over a wider circle is fewer) */
export const walkerDensity = (s: Scan, dist: number) => { const rw = Math.max(15, Math.min(60, dist * 0.5)); return s.walkers * (15 / rw) * (15 / rw); };
/**
 * The walkers drawn near the camera as a density eased into a crowd: 0 under three, 1 from twenty-five per 15-tile circle (a pavement of
 * people, not a stadium). An ease-out (quick from the first few, settling at the top), so five walkers are already a little talk.
 */
export const peopleNear = (s: Scan, dist: number) => { const t = clamp01((walkerDensity(s, dist) - 3) / 22); return t * (2 - t); };
/** the cars that make the traffic bed full: about 15 in the street-zoom circle (25 tiles), easing to the old 45 as the circle grows with the zoom, so a far view sounds as it did */
export const carKnee = (dist: number) => lerp(15, 45, smooth(40, 140, dist));

export interface Target { level: number; tone: number }
export type Mix = Record<BedId, Target>;
/** the five beds that always run (they have a synthesised recipe); the rest start when their level is wanted and stop after a while at zero */
const ALWAYS: readonly BedId[] = ['traffic', 'wind', 'crowd', 'industry', 'water'];
/** a string as a number in [0, 1), for choosing a take by city */
const hashStr = (t: string) => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };
export const newMix = (): Mix => {
  const m = {} as Mix;
  for (const id of ['traffic', 'wind', 'crowd', 'industry', 'water', 'rain-light', 'rain-heavy', 'market', 'pub', 'playground', 'stadium', 'fountain', 'zone-ind', 'zone-com', 'zone-off', 'zone-res', 'zone-civic'] as BedId[]) m[id] = { level: 0, tone: 0.5 };
  return m;
};
/**
 * The most each bed is ever driven to by the scene (mixFor's own ceilings), so a tour stop's bias (shared/src/demo/tourSound.ts
 * AmbienceHint, 0 to 1) is a share of the bed's own range: 1 is as loud as that bed gets, 0.5 half of it.
 */
export const HINT_CEIL: Record<keyof AmbienceHint, number> = { traffic: 0.6, wind: 0.57, crowd: 0.4, industry: 0.45, water: 0.4, market: 0.35, pub: 0.3, playground: 0.4, stadium: 0.5, fountain: 0.35, 'zone-ind': 0.6, 'zone-com': 0.6, 'zone-off': 0.45, 'zone-res': 0.5, 'zone-civic': 0.55 };
/** Lay a tour stop's bias over a mix: each bed it names is held at its share of the bed's ceiling, with a slow breath of its own (the organic rule). Pure. */
export function applyHint(mix: Mix, hint: AmbienceHint | null, now: number, salt = 0): Mix {
  if (!hint) return mix;
  for (const k of Object.keys(hint) as (keyof AmbienceHint)[]) {
    const v = hint[k], t = mix[k];
    if (v === undefined || !t) continue;
    const ph = hash2(k.length * 31 + k.charCodeAt(0), salt) * 6.28;
    t.level = v * HINT_CEIL[k] * (1 + 0.07 * Math.sin(now / 1000 * (0.13 + 0.1 * hash2(k.charCodeAt(1), salt)) + ph));
  }
  return mix;
}

/** a window of the day: 1 between `a` and `b` o'clock, easing over an hour at each end (a > b wraps midnight) */
const during = (h: number, a: number, b: number) => (a <= b ? smooth(a - 0.5, a + 0.5, h) * (1 - smooth(b - 0.5, b + 0.5, h)) : Math.max(smooth(a - 0.5, a + 0.5, h), 1 - smooth(b - 0.5, b + 0.5, h)));

/**
 * The target level and tone of every bed for a scan, a camera distance and an hour. Pure, so a test can read it. `lead` is the district
 * that won the soft-max at the last tick (the Ambience keeps it): it counts a little more, so a street on the border does not flip.
 */
export function mixFor(s: Scan, dist: number, hour: number, map: boolean, out: Mix = newMix(), rain = 0, lead: Zn | null = null, wind = 0): Mix {
  const act = activityAt(hour);
  const near = (full: number, gone: number) => 1 - smooth(full, gone, dist); // 1 close in, 0 zoomed out
  const zo = zonesOf(s, lead, ZSCRATCH), pres = zo.presence;
  const density = clamp01(s.cars / carKnee(dist));
  // the cars are heard by the kind of street they are in (a terrace is quiet, a yard busy); open country takes them as they are
  out.traffic.level = (0.5 * Math.sqrt(density) + 0.1 * s.road) * lerp(0.45, 1, act) * lerp(1, 0.4, smooth(40, 400, dist)) * lerp(1, byZone(zo, TRAFFIC_BY), pres);
  out.traffic.tone = 0.2 + 0.7 * density;
  const h = smooth(20, 320, dist);
  // the weather's wind (Ambience.setWeather, 0 calm .. 1 gale) lifts the bed at every zoom and brightens its tone
  out.wind.level = Math.min(0.57, 0.07 + 0.5 * Math.pow(h, 0.8) + 0.3 * wind);
  out.wind.tone = Math.min(1, h + 0.4 * wind);
  // the talk of the street: the walkers drawn near (a density, not a count) by the kind of street they are in
  out.crowd.level = 0.4 * Math.sqrt(peopleNear(s, dist)) * lerp(0.6, byZone(zo, CROWD_BY), pres) * act * near(60, 170);
  out.crowd.tone = 0.3 + 0.5 * act;
  // the synthesised hum under the works: only where industry wins
  out.industry.level = 0.45 * Math.min(1, s.ind * 2.5) * zoneLevel(zo, 'ind') * lerp(0.6, 1, act) * near(120, 320);
  out.industry.tone = 0.3 + 0.5 * Math.min(1, s.ind * 2.5);
  out.water.level = 0.4 * Math.min(1, s.water * 3) * near(100, 330);
  out.water.tone = 0.3 + 0.5 * near(40, 200);
  // the district beds: a recording each, the winner held near its ceiling and the others ducked (zoneLevel), by the hour of its street, close in
  const close = near(45, 160);
  const day = (a: number, b: number, floor: number) => floor + (1 - floor) * during(hour, a, b);
  out['zone-ind'].level = HINT_CEIL['zone-ind'] * zoneLevel(zo, 'ind') * day(6.5, 18.5, 0.5) * close;
  out['zone-com'].level = HINT_CEIL['zone-com'] * zoneLevel(zo, 'com') * day(8, 22, 0.35) * close;
  out['zone-off'].level = HINT_CEIL['zone-off'] * zoneLevel(zo, 'off') * day(7.5, 19, 0.2) * close; // quieter after 19:00
  out['zone-res'].level = HINT_CEIL['zone-res'] * zoneLevel(zo, 'res') * day(6.5, 22.5, 0.3) * close;
  out['zone-civic'].level = HINT_CEIL['zone-civic'] * zoneLevel(zo, 'civic') * day(8.5, 20, 0.35) * close;
  for (const z of ZONES) out[ZONE_BED[z]].tone = 0.5 + 0.3 * act;
  // the second pass: places with a bed of their own (recordings only; a bed with no file is never started)
  const shops = Math.max(0, s.com - s.off), people = peopleNear(s, dist);
  out.market.level = 0.35 * smooth(0.1, 0.35, shops) * Math.sqrt(clamp01(s.walkers / 15)) * during(hour, 8, 17) * near(45, 130);
  out.pub.level = 0.3 * smooth(0.08, 0.3, shops) * (0.7 + 0.3 * people) * during(hour, 16.5, 24) * near(40, 110);
  out.playground.level = 0.4 * Math.min(1, s.school) * during(hour, 8.75, 15.5) * near(30, 100);
  out.stadium.level = 0.5 * Math.min(1, s.stadium) * during(hour, 13, 22) * near(60, 180);
  out.fountain.level = 0.35 * Math.min(1, s.fountain) * near(25, 90);
  // rain comes from the weather hook (Ambience.setWeather): light under 0.6, heavy over 0.4, the two cross-fading between
  const wet = clamp01(rain) * lerp(1, 0.55, smooth(60, 300, dist));
  out['rain-light'].level = 0.45 * wet * (1 - smooth(0.4, 0.8, rain));
  out['rain-heavy'].level = 0.55 * wet * smooth(0.4, 0.8, rain);
  if (map) { // zoomed out to the map: only the wind, thin
    out.traffic.level *= 0.1; out.crowd.level = 0; out.industry.level *= 0.1; out.water.level *= 0.2; out.wind.level = 0.2;
    out.market.level = out.pub.level = out.playground.level = out.stadium.level = out.fountain.level = 0;
    for (const z of ZONES) out[ZONE_BED[z]].level = 0;
  }
  return out;
}
/** mixFor's own scratch for the zoning (the readout asks zonesOf for its own) */
const ZSCRATCH = newZoning();

/** the green of a place for birds: parks and gardens, and homes only where homes are what the street is (an office quarter has no garden) */
export function greenOf(s: Scan, lead: Zn | null = null): number {
  const zo = zonesOf(s, lead);
  return clamp01(s.park * 3 + s.res * 1.1 * zoneLevel(zo, 'res'));
}

/**
 * How much of the builders' noise there is, 0 to 1: a site under construction among the tiles sampled (`sites`), by working hours, close in.
 * A builders' depot alone is a quiet yard (a few percent of it); with neither a site nor a depot it is nothing.
 */
export function worksOf(s: Scan, hour: number, dist: number): number {
  return clamp01(s.sites / 3 + 0.15 * Math.min(1, s.builders)) * (s.sites > 0 ? 1 : 0.4) * during(hour, 7.5, 17) * (1 - smooth(25, 80, dist));
}

/**
 * Events per second for the birds, from the scan and the hour (0 when the camera is far off). Only where there is green (a park, or a
 * street of homes: `greenOf`) and only from dawn to dusk: a chorus from half past four to seven, a song by day, a few at dusk, none at night.
 */
export function birdRate(s: Scan, hour: number, dist: number, lead: Zn | null = null): number {
  const green = greenOf(s, lead);
  if (green < 0.07) return 0;
  const nearF = 1 - smooth(100, 220, dist);
  let base = 0;
  if (hour >= 4.5 && hour < 7) base = 0.35 + 2 * green;              // the dawn chorus
  else if (hour >= 7 && hour < 19) base = 0.01 + 0.22 * green;       // the day
  else if (hour >= 19 && hour < 20.5) base = 0.1 * green;            // dusk
  return base * nearF;
}
export function owlRate(s: Scan, hour: number, dist: number, lead: Zn | null = null): number {
  if (!(hour >= 21 || hour < 4.5)) return 0;
  const green = Math.min(1, s.park * 3 + s.res * 0.8 * zoneLevel(zonesOf(s, lead), 'res'));
  return green < 0.1 ? 0 : 0.06 * green * (1 - smooth(80, 180, dist));
}

export class Ambience {
  /** the cost of the 250 ms tick, ms: the last, the worst steady one, the number run, and the first (which builds the beds and the noise) */
  stats = { last: 0, max: 0, ticks: 0, setup: 0 };
  private recent = new Float32Array(64);
  /** when each of the last 64 ticks ran (performance.now) and what it cost, for the frame trace; `recentAt[i]` pairs with `recent[i]` */
  readonly recentAt = new Float64Array(64);
  /** the last 64 ticks as (at, ms), oldest first */
  ticks(): { at: number; ms: number }[] {
    const n = Math.min(this.stats.ticks - 1, 64), out: { at: number; ms: number }[] = [];
    for (let k = n; k > 0; k--) { const i = (this.stats.ticks - 1 - k) & 63; out.push({ at: this.recentAt[i], ms: this.recent[i] }); }
    return out;
  }
  /** the median and 95th percentile of the last 64 steady ticks, ms (read once a second by the perf readout, never per frame) */
  get cost() {
    const n = Math.min(this.stats.ticks - 1, 64);
    if (n < 1) return { median: 0, p95: 0 };
    const a = Array.from(this.recent.subarray(0, n)).sort((x, y) => x - y);
    return { median: a[Math.floor(n / 2)], p95: a[Math.min(n - 1, Math.floor(n * 0.95))] };
  }
  readonly scan = newScan();
  readonly mix = newMix();
  /** the district the last tick found (zonesOf): shares, soft-max weights, the winner. `lead` is the winner, handed back next tick as the hysteresis */
  readonly zoning = newZoning();
  private lead: Zn | null = null;
  private beds: Partial<Record<BedId, Bed>> = {};
  /** when each bed started (performance.now), for the audio readout */
  private born: Partial<Record<BedId, number>> = {};
  /** seconds each optional bed has been wanted at nothing: it is stopped after a while, freeing its voice */
  private quiet: Partial<Record<BedId, number>> = {};
  /** the weather hook (setWeather): rain 0..1, wind 0..1, and whether a storm is on (thunder) */
  private rain = 0;
  private wind = 0;
  private storm = false;
  /** the tour stop's bias on the beds (setHint), or null */
  private hint: AmbienceHint | null = null;
  private made = false;
  /** the camera distance, map view and hour the last tick read (the audio readout) */
  private camNow = { dist: 0, map: false };
  private hourNow = 0;
  private at = 0;
  private n = 0;
  private lastHour = -1;
  private lastBell = -1e9;
  private beepAt = 0;

  /** street life (street.ts): pass-bys, footsteps and talk, the sirens that follow their vehicles; fed by the scan's walk over the agents */
  readonly street: StreetLife;
  /** the ridden vehicle's key ('c123' a road vehicle), set by Audio from the first-person sound: its own pass-by and siren never fire */
  ridden: () => string = () => '';

  constructor(private eng: AudioEngine, private src: AmbSources, private salt = (Math.random() * 1e9) | 0) {
    this.street = new StreetLife(eng, salt, (x, z) => { const t = src.tileAt(x, z); return t !== undefined && isRoad(t); });
  }

  /** A tour stop's bias on the beds (client/src/audio/tourcue.ts): the beds it names are held at their share of their ceiling while it is shown; null gives them back to the scene. */
  setHint(h: AmbienceHint | null) { this.hint = h && Object.keys(h).length ? { ...h } : null; }
  get hinted() { return this.hint; }

  /**
   * The weather hook (render/weather.ts calls it every frame): rain 0 (dry) to 1 (a downpour) starts the rain beds, `wind` 0 (calm) to 1 (a gale)
   * lifts the wind bed and the gusts, and `storm` brings thunder.
   */
  setWeather(rain: number, wind = 0, storm = false) { this.rain = clamp01(rain); this.wind = clamp01(wind); this.storm = storm; }

  /**
   * A firework shell from the fireworks system (render/fireworks.ts calls this for each shell as a show is scheduled): `at` seconds from now
   * it launches, and its bang is heard a second or so later, a little later still the further off it is, softer, and to the side it is on.
   */
  firework(x: number, z: number, at: number, size: number) {
    const cam = this.src.camera(), dx = x - cam.x, dz = z - cam.z, d = Math.hypot(dx, dz);
    const far = 1 - smooth(25, 260 + cam.dist, d);
    if (far < 0.03) return;
    fire(this.eng, 'fireworks', { why: `fireworks shell at ${Math.round(x)},${Math.round(z)}, ${Math.round(d)} tiles off, size ${size}`, seed: (this.rand() * 1e9) | 0, gain: far * Math.min(1, 0.5 + 0.2 * size), delay: Math.max(0, at) + 1.1 + Math.min(2, d / 150), pan: Math.max(-1, Math.min(1, (dx * cam.rightX + dz * cam.rightZ) / (12 + d * 0.3))) });
  }

  /** the scan's per-agent hook into the street (bound once: no closure per tick) */
  private visit = (a: StreetAgent, id: number, dx: number, dz: number, d2: number) => this.street.visit(a, id, dx, dz, d2);
  private rand() { return hash2(this.n++, this.salt); }
  private rate(lambda: number, dt: number) { return lambda > 0 && this.rand() < 1 - Math.exp(-lambda * dt); }

  /** Call every frame; it works once in 250 ms. */
  frame(now: number) {
    if (now - this.at < TICK_MS) return;
    const dt = Math.min(1, (now - this.at) / 1000);
    this.at = now;
    const eng = this.eng;
    if (!eng.ready || eng.muted || !eng.ctx || eng.ctx.state !== 'running') { if (this.street.following) this.street.silence(eng.muted ? 'muted' : 'the sound is suspended'); return; }
    const t0 = performance.now();
    this.tick(dt, now);
    const ms = performance.now() - t0, s = this.stats;
    s.last = ms;
    if (s.ticks === 0) s.setup = ms; // the first tick makes the beds and the noise buffers: counted apart
    else { this.recent[(s.ticks - 1) & 63] = ms; this.recentAt[(s.ticks - 1) & 63] = t0; if (ms > s.max) s.max = ms; }
    s.ticks++;
  }

  private tick(dt: number, now: number) {
    const src = this.src, cam = src.camera(), hour = src.hour(), eng = this.eng;
    this.camNow.dist = cam.dist; this.camNow.map = cam.map; this.hourNow = hour;
    if (!this.made) {
      this.made = true;
      for (const id of ALWAYS) {
        const b = makeBed(eng, id, hash2(this.n++, this.salt));
        if (b) { this.beds[id] = b; this.born[id] = performance.now(); eng.log('start', 'bed', id, 'always on: the ambience started'); } else eng.log('skip', 'bed', id, 'no voice free');
      }
    }
    const rk = this.ridden(), street = this.street;
    street.begin(cam, rk.startsWith('c') ? Number(rk.slice(1)) : -1, dt);
    const s0 = performance.now();
    const sc = scanAround(src, cam.x, cam.z, cam.dist, this.scan, street.off ? undefined : this.visit);
    zonesOf(sc, this.lead, this.zoning); // the district, for the events and the readout; mixFor finds the same one for the beds
    const mix = applyHint(mixFor(sc, cam.dist, hour, cam.map, this.mix, this.rain, this.lead, this.wind), this.hint, now, this.salt);
    const lead = this.lead; this.lead = this.zoning.win; // the winner leads the next tick a little (no flipping on a border)
    for (const id of Object.keys(mix) as BedId[]) { // the optional beds (recordings only) start when wanted and stop after eight quiet seconds
      if (ALWAYS.includes(id)) continue;
      const lv = mix[id].level;
      if (lv > 0.02 && !this.beds[id] && VOICES[id].takes?.length) {
        // a district bed's take is chosen by a hash of the city: a city always sounds like itself, and two cities differ
        const b = makeBed(eng, id, hash2(this.n++, this.salt), id.startsWith('zone-') ? hashStr(`${src.city?.() ?? ''}|${id}`) : undefined);
        if (b) { this.beds[id] = b; this.born[id] = performance.now(); eng.log('start', 'bed', id, `wanted: ${bedWhy(id, sc, cam.dist, hour, lv, this.hint, cam.map, this.rain, lead)}`); }
      }
      if (lv < 0.004 && this.beds[id]) { const q = (this.quiet[id] ?? 0) + dt; this.quiet[id] = q; if (q > 8) { this.beds[id]!.stop(); delete this.beds[id]; this.quiet[id] = 0; eng.log('stop', 'bed', id, 'quiet for 8 s, voice given back'); } } else this.quiet[id] = 0;
    }
    for (const id in this.beds) {
      const k = id as BedId, tg = mix[k];
      this.beds[k]!.tune(tg.level, tg.tone, 0.5 + 0.7 * hash2(k.length, this.salt)); // each bed glides at its own pace: 1.5 to 3.6 s
    }
    const s1 = performance.now();
    if (!street.off) street.end(now, dt, during(hour, 7, 22), walkerDensity(sc, cam.dist));
    street.cost = performance.now() - s1; // the street's own end of the tick; its visits run inside the scan (s1 - s0 is scan and visits together)
    street.scanCost = s1 - s0;
    if (cam.map) return;
    // events
    if (this.rate(birdRate(sc, hour, cam.dist, lead), dt)) {
      const chorus = hour >= 4.5 && hour < 7, n = chorus ? 1 + Math.floor(this.rand() * 3) : 1;
      for (let i = 0; i < n; i++) fire(eng, 'bird', { why: `${chorus ? 'dawn chorus' : hour >= 19 ? 'dusk' : 'daytime'} ${hm(hour)}, parks ${pc(sc.park)}, homes ${pc(sc.res)}, green ${greenOf(sc, lead).toFixed(2)}; district: ${zoneText(this.zoning)}`, seed: (this.rand() * 1e9) | 0, delay: i * (0.15 + this.rand() * 0.5), gain: 0.5 + 0.5 * this.rand() });
    }
    if (this.rate(owlRate(sc, hour, cam.dist, lead), dt)) fire(eng, 'owl', { why: `night ${hm(hour)}, parks ${pc(sc.park)}, homes ${pc(sc.res)}`, seed: (this.rand() * 1e9) | 0, gain: 0.6 + 0.4 * this.rand() });
    // (the horn is the street's now: one in 25 cars passing close honks, more at a junction; street.ts)
    this.places(sc, cam, hour, dt);
    // the hour: a bell, if one is in the view and it is a striking hour (every third, by day) and has not just rung
    const hf = Math.floor(hour);
    if (this.lastHour >= 0 && hf !== this.lastHour && hf >= 6 && hf <= 21 && hf % 3 === 0 && cam.dist < 140 && (sc.bell > 0 || sc.bellDeep > 0) && now - this.lastBell > 40000) {
      this.lastBell = now;
      if (hf === 10 || (hf === 18 && sc.bell > 0)) { // a peal at ten and six (in place of the strikes at six) when there is a recording
        if (VOICES['bell-peal'].takes?.length && sc.bellDeep === 0) { fire(eng, 'bell-peal', { why: `peal at ${hf}:00, bell tiles in view ${sc.bell}`, seed: (this.rand() * 1e9) | 0, gain: 1 - smooth(40, 140, cam.dist), pan: this.rand() * 1.2 - 0.6 }); this.lastHour = hf; return; }
      }
      ringBell(eng, sc.bellDeep > 0, (this.rand() * 1e9) | 0, Math.min(6, hf % 12 || 12), 1 - smooth(40, 140, cam.dist), this.rand() * 1.2 - 0.6, `strikes ${hf}:00, ${sc.bellDeep > 0 ? 'Parliament' : 'a churchyard'} in view`);
    }
    this.lastHour = hf;
    // a signal crossing holding the cars at red, near the camera: its beep, every half second
    if (src.pelican && cam.dist < 80 && now >= this.beepAt) {
      const p = src.pelican(cam.x, cam.z, 18);
      if (p) {
        this.beepAt = now + 500;
        const dx = p.x - cam.x, dz = p.z - cam.z, d = Math.hypot(dx, dz);
        fire(eng, 'beep', { why: `crossing red at ${Math.round(p.x)},${Math.round(p.z)}, ${d.toFixed(0)} tiles off`, seed: (this.rand() * 1e9) | 0, gain: (1 - d / 20) * (1 - smooth(30, 80, cam.dist)), pan: Math.max(-1, Math.min(1, (dx * cam.rightX + dz * cam.rightZ) / 12)) });
      }
    }
  }

  /** the second pass's events: each a Poisson clock from the scan and the hour; no file, no sound (fire skips a recording-only voice that has none) */
  private places(sc: Scan, cam: ReturnType<AmbSources['camera']>, hour: number, dt: number) {
    const eng = this.eng, d = cam.dist, day = during(hour, 6.5, 20), act = activityAt(hour), zo = this.zoning, lead = this.lead;
    const go = (id: Parameters<typeof fire>[1], lambda: number, gain: number, pan?: number) => {
      if (lambda > 0 && gain > 0.02 && VOICES[id].takes?.length && this.rate(lambda, dt)) fire(eng, id, { why: placeWhy(id, sc, d, hour, lambda, lead), seed: (this.rand() * 1e9) | 0, gain, pan: pan ?? this.rand() * 1.6 - 0.8 });
    };
    const close = (a: number, b: number) => 1 - smooth(a, b, d);
    const people = peopleNear(sc, d);
    go('gust', (0.045 * smooth(40, 260, d) + 0.12 * this.wind) * (1 + 2 * this.wind), 0.35 + 0.6 * Math.max(smooth(60, 300, d), this.wind));
    // (footsteps follow the walkers drawn within 8 tiles, one voice a side: street.ts)
    // a station's call: a patrol never reports one (the sim sets no emergency flag on a patrol), so the police call stays; the fire engines
    // carry their own sirens (street.ts), so the fire station's is a tenth of what it was, for a town that has a station and no call yet.
    // Neither sounds while a vehicle's siren is being followed.
    const quiet = this.street.following > 0 ? 0 : 1;
    go('siren', quiet * 0.004 * Math.min(1, sc.police) * (1 - smooth(60, 120, d)), 0.4 + 0.6 * (1 - smooth(30, 110, d)));
    go('siren-fire', quiet * 0.0003 * Math.min(1, sc.fire) * (1 - smooth(60, 120, d)), 0.4 + 0.6 * (1 - smooth(30, 110, d)));
    go('seagulls', 0.05 * Math.min(1, sc.water * 3) * day * (1 - smooth(100, 170, d)), 0.3 + 0.7 * this.rand());
    // the districts: each zone's events are heard while that zone wins the soft-max (zoneLevel is 0 where it is ducked), close in
    const zi = zoneLevel(zo, 'ind'), zc = zoneLevel(zo, 'com'), zf = zoneLevel(zo, 'off'), zr = zoneLevel(zo, 'res'), zv = zoneLevel(zo, 'civic');
    go('pigeons', 0.04 * clamp01(sc.park * 4 + 0.6 * (zc + zv)) * day * (1 - smooth(60, 120, d)), 0.3 + 0.7 * this.rand());
    go('dog', 0.02 * zr * during(hour, 7, 21) * close(40, 100), 0.3 + 0.7 * this.rand());
    go('bike-bell', 0.012 * clamp01(sc.walkers / 8) * clamp01(sc.road * 4) * day * close(25, 55), 0.4 + 0.6 * this.rand());
    go('bin-lorry', 0.006 * zr * during(hour, 6, 10) * close(40, 100), 0.4 + 0.5 * this.rand());
    go('station-chime', 0.008 * Math.max(zc, zf) * day * close(30, 70), 0.4 + 0.5 * this.rand());
    go('heli-over', 0.004 * during(hour, 7, 20) * smooth(50, 120, d), 0.4 + 0.5 * this.rand());
    go('plane-over', 0.006 * during(hour, 6, 23) * smooth(70, 160, d), 0.4 + 0.5 * this.rand());
    go('boat-horn', 0.008 * clamp01(sc.water * 4) * (1 - smooth(80, 150, d)), 0.4 + 0.6 * this.rand());
    // digging: only with a site under construction in the tiles sampled (a depot alone is a quiet yard), and a long gap between blows
    const works = worksOf(sc, hour, d);
    go('hammer', 0.035 * works, 0.4 + 0.6 * this.rand());
    go('drill', 0.012 * works, 0.4 + 0.6 * this.rand());
    go('lawnmower', 0.004 * zr * during(hour, 10, 17) * close(30, 80), 0.4 + 0.5 * this.rand());
    // industry: metal, a reversing lorry, steam
    const shift = during(hour, 6.5, 18.5);
    go('metal-clank', 0.07 * zi * shift * close(40, 110), 0.35 + 0.65 * this.rand());
    go('reverse-beep', 0.012 * zi * during(hour, 7, 17) * close(35, 90), 0.4 + 0.6 * this.rand());
    go('steam-vent', 0.01 * zi * lerp(0.5, 1, shift) * close(40, 100), 0.4 + 0.6 * this.rand());
    // shops: a till and the shop door, music from a doorway, and in the busiest streets a busker
    const trade = during(hour, 8.5, 19.5);
    go('till', 0.03 * zc * trade * close(30, 80), 0.4 + 0.6 * this.rand());
    go('shop-bell', 0.025 * zc * trade * close(30, 80), 0.4 + 0.6 * this.rand());
    go('music-door', 0.008 * zc * during(hour, 10, 24) * close(25, 70), 0.4 + 0.6 * this.rand());
    go('busker', 0.006 * zc * people * during(hour, 10, 20.5) * close(25, 60), 0.5 + 0.5 * this.rand());
    // offices: the lobby door and the lift
    const office = during(hour, 7.5, 19);
    go('revolving-door', 0.014 * zf * office * close(30, 80), 0.4 + 0.6 * this.rand());
    go('lift-ding', 0.012 * zf * office * close(30, 80), 0.4 + 0.6 * this.rand());
    // homes: a radio through a window, a front door, children
    go('radio-window', 0.005 * zr * during(hour, 8, 22) * close(25, 70), 0.4 + 0.6 * this.rand());
    go('front-door', 0.016 * zr * during(hour, 7, 22.5) * close(25, 70), 0.4 + 0.6 * this.rand());
    go('kids-yard', 0.012 * zr * during(hour, 8, 19) * close(30, 80), 0.4 + 0.6 * this.rand());
    // squares and landmarks: tourists' cameras, one to three shots
    const lam = 0.04 * zv * during(hour, 9, 19.5) * close(30, 80);
    if (lam > 0 && VOICES['camera-shutter'].takes?.length && this.rate(lam, dt)) {
      const n = 1 + Math.floor(this.rand() * 3), pan = this.rand() * 1.6 - 0.8;
      for (let i = 0; i < n; i++) fire(eng, 'camera-shutter', { why: placeWhy('camera-shutter', sc, d, hour, lam, lead), seed: (this.rand() * 1e9) | 0, gain: 0.4 + 0.6 * this.rand(), pan: pan + this.rand() * 0.3 - 0.15, delay: i * (0.25 + this.rand() * 0.7) });
    }
    go('thunder', this.storm ? 0.05 * smooth(0.3, 0.8, this.rain) : 0, 0.5 + 0.5 * this.rand());
  }

  /** the beds sounding now, each with what drives it, in words (the audio readout; built only when it is open) */
  bedList(): { id: BedId; bed: Bed; level: number; why: string; born: number }[] {
    const sc = this.scan, c = this.camNow;
    return (Object.keys(this.beds) as BedId[]).map((id) => ({ id, bed: this.beds[id]!, born: this.born[id] ?? 0, level: this.mix[id].level, why: bedWhy(id, sc, c.dist, this.hourNow, this.mix[id].level, this.hint, c.map, this.rain, this.lead) }));
  }
  /** the hour the beds and events use now and where it comes from */
  hourInfo(): { hour: number; source: string } { return { hour: this.hourNow, source: this.src.hourSource?.() ?? 'clock' }; }

  /** drop every bed (the context is going away, or the player left the world) */
  dispose() { this.street.silence('the ambience was disposed'); for (const id in this.beds) { this.beds[id as BedId]!.stop(); this.eng.log('stop', 'bed', id, 'the ambience was disposed'); } this.beds = {}; this.quiet = {}; this.made = false; }
}
