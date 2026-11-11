import { TICKS_PER_DAY } from './constants';
import { LEVEL_SLOTS, Zone } from './buildings/codes';
import { TOP_LEVEL_TABLE, DESIGN_COUNT_TABLE, AD_SLOTS, KIND_ID } from './buildings/compiled';
import { AD_SIZE, AD_SIZES, AD_STRIDE, FACE_YAW, type AdSize } from './buildings/adslot';
import { isRoad, zoneOf, levelOf, underConstruction, kindIdOf } from './tile';
import { isPartAux, isAnchorAux, auxOrientation, isMultiTile, placedFromAnchor, partDx, partDy, type Placed } from './structures';
import { hash2 } from './noise';
import { designPick } from './leisure';

/**
 * Adverts (docs/adverts.md): slots on buildings, campaigns and rentals. The definitions both sides read: the server
 * (server/src/sim/adverts.ts) checks intents, charges rent to the renter and pays it to the slot's parcel owner, ages
 * the posters once a game day; the client (render/adverts.ts, adverts.ts) draws the posters and the Campaigns panel.
 *
 * A slot is (the door tile of a building or site, the slot's index in its design), found from the same hashes and road
 * test the client's chunk view places the model with (render/chunkView.ts), so server and client agree on every slot
 * without sending any. Only a rented slot has state.
 */

export { AD_SIZE, AD_SIZES, AD_STRIDE, FACE_YAW, type AdSize };

/** Tunables (docs/adverts.md sections 3 and 6). */
export const AD = {
  /** live campaigns a player may run */
  maxCampaigns: 8,
  /** slots one player may rent at once */
  maxRentals: 60,
  /** artwork and setup for a new campaign */
  campaignCost: 150,
  /** "rent the N nearest free slots" looks this far (tiles) from where the camera is */
  nearReach: 24,
  /**
   * Wear per game day (the area rate, before the slot size's own `wear`): a well-served neighbourhood keeps a poster
   * clean for weeks, a neglected one tags it within a couple of days. need is 0 (everyone in work, every service and a
   * park in reach) to 1 (a third of adults out of work, no services, nowhere to go).
   */
  rateLow: 0.012, rateHigh: 0.4,
  /** a poster's wear past which it is shown as wrecked (the panel's "needs replacing") */
  wreckedAt: 0.8,
  /**
   * Big screens (docs/adverts.md section 9): a building's screens share one ring of turns, one turn per screen panel
   * (both big-screen designs have `screenTurns` panels). Every `screenSecs` real seconds each panel steps on to the next
   * turn, so a campaign renting one panel takes its turn on all of them. The clock is the wall clock, so every viewer
   * sees the same rotation and nothing is sent.
   */
  screenSecs: 8, screenTurns: 6,
};

// ---------------------------------------------------------------- big screens (docs/adverts.md section 9)

/**
 * What one turn of a building's screens shows: a renting campaign; a house advert (generic brand art, so the screens are
 * never dark when turns are unrented, `art` picks one of HOUSE_ADS); or the news.
 *
 * **The news hook.** One unrented turn per building is a 'news' turn. Today it shows a "LIVE · Civitas News" card from
 * the ad atlas; the media centre (UTD 90cd3857) is to fill it with the news helicopter's live picture by handing the
 * client's AdvertsView a render target (`AdvertsView.setNewsFeed`), which every news turn then samples instead. Selling
 * the news turn (airtime auctions) belongs to that card too.
 */
export type ScreenTurn = { kind: 'campaign'; campaign: number } | { kind: 'house'; art: number } | { kind: 'news' };
/** Generic house adverts for unrented turns (the client draws them once into the ad atlas). */
export const HOUSE_ADS = ['FIZZ', 'Nimbus', 'Civitas Bank', 'Rail Express', 'Kettle Tea', 'Neon Noodles', 'Metro Mobile'] as const;
/**
 * The ring of turns for a building's screens: `rented[k]` is the campaign renting the k-th screen panel, or null. Unrented
 * turns show house adverts, picked from the building's seed so two screens in a town do not show the same; the last
 * unrented one is the news.
 */
export function screenTurns(rented: readonly (number | null)[], seed: number): ScreenTurn[] {
  let news = -1;
  for (let k = rented.length - 1; k >= 0; k--) if (rented[k] === null) { news = k; break; }
  const first = Math.floor(seed * HOUSE_ADS.length);
  return rented.map((c, k): ScreenTurn => (c !== null ? { kind: 'campaign', campaign: c } : k === news ? { kind: 'news' } : { kind: 'house', art: (first + k * 3) % HOUSE_ADS.length }));
}
/** Whether a building's k-th slot is a big screen (its own rotation, its own rent, no wear). */
export const isScreenSlot = (slots: readonly number[], i: number) => slots[i * AD_STRIDE + 1] === AD_SIZES.indexOf('screen');

/** What a campaign speaks to (docs/motivation.md section 3, the six values). */
export const AD_THEMES = ['Money', 'Family', 'Status', 'Roots', 'Time', 'Adventure'] as const;
/**
 * What a campaign says, per theme (docs/adverts.md section 3): templates filled with real names, never free text, so
 * there is nothing to moderate. {place} is the target parcel's or estate's name, {building} a workplace's name.
 */
export interface AdClaim {
  theme: number; text: string; needs: 'place' | 'building' | null;
  /**
   * Area claims (docs/multiplayer-land.md section 6 "Opinion about areas", M6): about a parcel's neighbourhood kind (a
   * ValueKind): `high` says the kind is high there, `good` whether that is praise. An area claim may name someone else's
   * parcel, and then it must be true when posted (checked against the M1 field) and stay true while it runs.
   */
  kind?: number; high?: boolean; good?: boolean;
}
export const AD_CLAIMS: AdClaim[] = [
  { theme: 0, text: 'Low rents in {place}', needs: 'place' },
  { theme: 0, text: '{building} pays well', needs: 'building' },
  { theme: 0, text: 'Keep more of your wage in {place}', needs: 'place' },
  { theme: 1, text: 'Great schools in {place}', needs: 'place' },
  { theme: 1, text: 'Room to grow in {place}', needs: 'place' },
  { theme: 1, text: 'Safe streets, happy kids', needs: null },
  { theme: 2, text: 'A career at {building}', needs: 'building' },
  { theme: 2, text: 'Live in {place}', needs: 'place' },
  { theme: 3, text: 'Local jobs for local people', needs: null },
  { theme: 3, text: '{place}: proud since day one', needs: 'place' },
  { theme: 4, text: 'Five minutes from work in {place}', needs: 'place' },
  { theme: 4, text: 'Shop local at {building}', needs: 'building' },
  { theme: 5, text: 'Something new in {place}', needs: 'place' },
  { theme: 5, text: 'Come and see {place}', needs: 'place' },
  // area claims (M6): kinds 8 access, 0 noise, 1 smell, 6 green (shared/src/value.ts ValueKind)
  { theme: 5, text: '{place} is up-and-coming', needs: 'place', kind: 8, high: true, good: true },
  { theme: 4, text: '{place} is noisy', needs: 'place', kind: 0, high: true, good: false },
  { theme: 1, text: '{place} reeks', needs: 'place', kind: 1, high: true, good: false },
  { theme: 3, text: 'Leafy {place}', needs: 'place', kind: 6, high: true, good: true },
];
/** Whether claim `i` is an area claim (about a parcel's kind: may name someone else's land if true). */
export const isAreaClaim = (i: number) => AD_CLAIMS[i]?.kind !== undefined;
/** The claim with its names filled in, or null when the claim needs a name the target does not give. */
export function claimText(claim: number, names: { place?: string; building?: string }): string | null {
  const c = AD_CLAIMS[claim];
  if (!c) return null;
  if (c.needs === 'place' && !names.place) return null;
  if (c.needs === 'building' && !names.building) return null;
  return c.text.replace('{place}', names.place ?? '').replace('{building}', names.building ?? '');
}

/**
 * The look (docs/adverts.md section 5): a layout, an icon and a palette, packed as layout * 64 + icon * 8 + palette.
 * The client draws one atlas cell per campaign from it (render/adverts.ts); nothing else depends on it.
 */
export const AD_PALETTES: { name: string; bg: string; ink: string; accent: string }[] = [
  { name: 'Pillar-box', bg: '#c8282e', ink: '#ffffff', accent: '#ffd23f' },
  { name: 'Midnight', bg: '#16224a', ink: '#ffffff', accent: '#5ec8f2' },
  { name: 'Meadow', bg: '#2f7d4f', ink: '#fdf6e3', accent: '#f2c230' },
  { name: 'Sunshine', bg: '#ffcf33', ink: '#1d1d1d', accent: '#d9372b' },
  { name: 'Seaside', bg: '#1fa3b5', ink: '#ffffff', accent: '#ffe7a0' },
  { name: 'Plum', bg: '#5b2a6e', ink: '#ffe9f4', accent: '#ff8fb8' },
  { name: 'Newsprint', bg: '#f1ece0', ink: '#1a1a1a', accent: '#c8282e' },
  { name: 'Tangerine', bg: '#f07c24', ink: '#1b1b1b', accent: '#ffffff' },
];
export const AD_ICONS = ['house', 'coin', 'star', 'tree', 'clock', 'compass', 'heart', 'cap'] as const;
export const AD_LAYOUTS = ['Bold', 'Banner', 'Classic'] as const;
export const packLook = (layout: number, icon: number, palette: number) => (layout % 3) * 64 + (icon & 7) * 8 + (palette & 7);
export const unpackLook = (look: number) => ({ layout: Math.floor(look / 64) % 3, icon: (look >> 3) & 7, palette: look & 7 });
/** A theme's usual icon. */
export const THEME_ICON = [1, 0, 2, 3, 4, 5];

/** What a campaign is about: one of the player's parcels (its name, or its estate's) or a workplace on their land (its sign). */
export interface AdTarget { kind: 'parcel' | 'building' | 'plan'; id: number; x?: number; y?: number }
/** A campaign as everyone sees it (its posters are on everyone's streets). */
export interface CampaignDTO {
  id: number; owner: string; theme: number; claim: number; look: number;
  /** game day it was created */
  created: number;
  /** the claim as it reads on the poster */
  text: string;
  target?: AdTarget;
}
/**
 * Rented slots, AD_RENTAL numbers each: door x, door y, slot index, campaign id, the poster's wear age at tick `at` and
 * the area rate it ages at from then (wear units per game day), the tick it went up, and the slot's size code (AD_SIZES).
 */
export const AD_RENTAL = 9;
export interface AdsDTO { campaigns: CampaignDTO[]; r: number[] }

// ---------------------------------------------------------------- wear (docs/adverts.md section 6)

/** A rental's own seed, so every poster wears, tags and tears its own way. */
export const adSeed = (x: number, y: number, slot: number, campaign: number) => hash2(x * 31 + slot * 7 + 3, y * 17 + campaign * 13 + 5);
/**
 * Wear from a poster's age in wear units (the sum of its area's daily rate since it went up or was cleaned): 0 fresh,
 * towards 1 wrecked. The seed spreads posters in the same street from 0.7x to 1.3x. Server and client compute the same
 * number from the same inputs, so wear never goes over the wire.
 */
export const adWear = (age: number, seed: number) => 1 - Math.exp(-Math.max(0, age) * (0.7 + 0.6 * seed));
/** A rental's age now: its age at `at` plus the rate since. */
export const adAge = (age: number, rate: number, at: number, tick: number) => age + (rate * Math.max(0, tick - at)) / TICKS_PER_DAY;
/**
 * The area's wear rate per game day from what the simulation already knows about the slot's neighbourhood: the share of
 * its adults out of work (or study), and the service cover (0-3: police, fire, health) and leisure tier of the homes
 * there (0-2, server sim/life.ts leisureTier). Times the slot size's own `wear` (AD_SIZE).
 */
export function adAreaRate(jobless: number, cover: number, leisure: number, size: AdSize): number {
  const need = Math.min(1, 0.6 * Math.min(1, jobless / 0.3) + 0.25 * (1 - Math.min(3, cover) / 3) + 0.15 * (1 - Math.min(2, leisure) / 2));
  return (AD.rateLow + (AD.rateHigh - AD.rateLow) * need ** 1.5) * AD_SIZE[size].wear;
}
/** Words for a poster's state, for the panel and tooltips. */
export const wearWords = (w: number) => (w < 0.15 ? 'fresh' : w < 0.35 ? 'weathered' : w < 0.6 ? 'tagged' : w < AD.wreckedAt ? 'torn' : 'wrecked');

// ---------------------------------------------------------------- slots on the map

/** What finding a building's slots reads (the world on either side). */
export interface AdEnv {
  tile(x: number, y: number): number | undefined;
  aux(x: number, y: number): number;
  sub(x: number, y: number): number;
}
/** A building's (or site's) slots: its design key, the slot records, its quarter turn, centre and scale (structures 1). */
export interface AdHost { key: string; slots: number[]; r: number; cx: number; cy: number; multi: boolean }

/** Directions of a lot's turn r (render/chunkView.ts): r 0 faces +y, 1 +x, 2 -y, 3 -x. */
const DIRS: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];

/** The way a 1×1 building faces: the first road of +y, +x, -x, -y (as chunkView turns it), or -1 with no road beside it. */
export function lotTurn(env: AdEnv, x: number, y: number): number {
  const road = (dx: number, dy: number) => { const t = env.tile(x + dx, y + dy); return t !== undefined && isRoad(t); };
  if (road(0, 1)) return 0;
  if (road(1, 0)) return 1;
  if (road(-1, 0)) return 3;
  if (road(0, -1)) return 2;
  return -1;
}

/** The design key a tile of this kind and level shows (render/models.ts `variant`), or null. */
export function designKey(kind: number, level: number, pick: number): string | null {
  const top = TOP_LEVEL_TABLE[kind] ?? 0;
  let lv = Math.min(level, top);
  while (lv < top && !DESIGN_COUNT_TABLE[kind * LEVEL_SLOTS + lv]) lv++;
  const n = DESIGN_COUNT_TABLE[kind * LEVEL_SLOTS + lv];
  if (!n) return null;
  return `${kind}:${lv}:${Math.min(n - 1, Math.floor(pick * n))}`;
}

/**
 * The slots of the building or site whose door (or any tile of it) is (x, y), or null when it has none or faces no road.
 * A site on an empty lot shows the site fence's hoarding; a building (or one being upgraded) its design's slots.
 */
export function adHostAt(env: AdEnv, x: number, y: number): AdHost | null {
  const t = env.tile(x, y);
  if (t === undefined || isRoad(t) || !zoneOf(t)) return null;
  let a = env.aux(x, y), ax = x, ay = y;
  if (a && isPartAux(a)) { ax = x - partDx(a); ay = y - partDy(a); a = env.aux(ax, ay); }
  const at = ax === x && ay === y ? t : env.tile(ax, ay);
  if (at === undefined) return null;
  const kind = kindIdOf(zoneOf(at), env.sub(ax, ay)), level = levelOf(at);
  let placed: Placed | null = null;
  if (a && isAnchorAux(a) && isMultiTile(kind)) placed = placedFromAnchor(kind, ax, ay, auxOrientation(a));
  const r = placed ? placed.r & 3 : lotTurn(env, ax, ay);
  if (r < 0) return null;
  let key: string | null;
  if (level === 0) key = underConstruction(at) ? 'site' : null;
  else key = designKey(kind, level, designPick(ax, ay));
  const slots = key ? AD_SLOTS[key] : undefined;
  if (!key || !slots) return null;
  return { key, slots, r, cx: placed ? placed.ax + placed.w / 2 : ax + 0.5, cy: placed ? placed.ay + placed.h / 2 : ay + 0.5, multi: !!placed };
}
/** The door tile of whatever stands at (x, y) (structures are known by their anchor here, as the server keys buildings by door). */
export const adSlotCount = (h: AdHost | null) => (h ? h.slots.length / AD_STRIDE : 0);
export const adSizeOf = (h: AdHost, i: number): AdSize => AD_SIZES[h.slots[i * AD_STRIDE + 1]];

/** Rotate a model-space offset (x along the lot, z towards its front) by the host's turn to world x, y. */
export function adTurn(r: number, lx: number, lz: number): [number, number] {
  switch (r & 3) {
    case 0: return [lx, lz];
    case 1: return [lz, -lx];
    case 2: return [-lx, -lz];
    default: return [-lz, lx];
  }
}
/** A slot's world point (the poster's centre, on the ground plane) and the direction it faces (a screen on a curve: its own). */
export function adSlotWorld(h: AdHost, i: number): { x: number; y: number; dir: [number, number]; height: number } {
  const s = h.slots, o = i * AD_STRIDE;
  const [dx, dy] = adTurn(h.r, s[o + 2], s[o + 4]);
  const yaw = s[o + 7] ?? FACE_YAW[s[o]];
  const dir: [number, number] = Math.abs(yaw - FACE_YAW[s[o]]) < 1e-3 ? DIRS[(s[o] + h.r) & 3] : adTurn(h.r, Math.sin(yaw), Math.cos(yaw));
  return { x: h.cx + dx, y: h.cy + dy, dir, height: s[o + 3] };
}
/**
 * Whether a slot can be seen from the street: a front slot always; a side-wall slot on a 1×1 lot only when the tile it
 * looks onto is open (a road, open ground, a car park, a park, a bus shelter), not a neighbour's wall. Shelter panels and
 * the slots of multi-tile buildings stand free.
 */
export function adSlotOpen(env: AdEnv, h: AdHost, i: number, doorX: number, doorY: number): boolean {
  const face = h.slots[i * AD_STRIDE], size = adSizeOf(h, i);
  if (face === 0 || h.multi || size === 'panel' || h.key === 'site') return true;
  const [dx, dy] = DIRS[(face + h.r) & 3];
  const x = doorX + dx, y = doorY + dy, t = env.tile(x, y);
  if (t === undefined || isRoad(t)) return true;
  const z = zoneOf(t);
  // open ground beside it: nothing, a car park, a park, a bus shelter
  return z === 0 || z === Zone.Parking || kindIdOf(z, env.sub(x, y)) === KIND_ID.park || kindIdOf(z, env.sub(x, y)) === KIND_ID['bus-stop'];
}
/** Rent per game day for a slot of this size. */
export const adRent = (size: AdSize) => AD_SIZE[size].rent;
