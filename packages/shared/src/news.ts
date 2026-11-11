import { MANIFEST } from './buildings/compiled';
import { hash2 } from './noise';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';

/**
 * The news (docs/media.md N2): the city's story log and the channels that report it. The server's sim/news.ts turns
 * what the simulation already does (fires, rank-ups and milestones, notable openings, new lines) into stories, keeps
 * the last NEWS.keep of them in a ring and sends them to every client; the client's News panel and ticker
 * (client/src/news.ts) show them. A story is covered by the channel of the staffed media centre (buildings/media.ts)
 * that reaches its place, the highest tier winning where two players' channels overlap; uncovered stories still
 * happen, but nobody reports them.
 *
 * The record is shaped for what comes next: N3's `newsFlights(pads, stories, tick)` flies the news helicopter to a
 * covered story's place while it is live (`t` to `end`) above a salience; N4's live TV shows the stories of the
 * channel covering the home; N5's citizens remember a story they passed (`x`, `y` while live) or watched (`ch`) by its
 * `id`, and a death story names the deceased (`dead`, docs/remembrance.md); the Piccadilly Lights' news turn reads the newest headline (client news.ts `latest`).
 */

export type StoryKind = 'fire' | 'explosion' | 'rank' | 'milestone' | 'opening' | 'line' | 'death'
  /** planning notices, votes and road closures (docs/multiplayer-land.md M5, server sim/planning.ts) */
  | 'planning'
  /** the weather holding flights, river buses or shipping (docs/weather.md W4) */
  | 'weather';

/** One story as the server keeps and sends it (message `news`). Ticks are world ticks. */
export interface StoryDTO {
  /** unique in the world, rising: a story updated later (a fire put out) keeps its id */
  id: number;
  /** the tick it broke */
  t: number;
  k: StoryKind;
  /** where it happened: the tile a helicopter orbits and a witness passes */
  x: number; y: number;
  /** the headline, from the templates below with real names; it changes as the story develops */
  h: string;
  /** how big a story it is, 0-100: what the ticker and the helicopter pick first */
  s: number;
  /** the tick it stopped being live; absent while it goes on (a fire still burning) */
  end?: number;
  /** the tick it went live again, when it did after an end (the showcase's drill home catching light again the same day) */
  lit?: number;
  /** the player whose town, building or line it is about */
  who?: string;
  /** the parcel at the place (0 or absent: unowned land) */
  pc?: number;
  /** the building's kind id, when it is about one */
  b?: number;
  /** the covering channel: the player who owns the media centre that reported it. Absent: nobody covered it */
  ch?: string;
  /** rival channels whose centres also reached it (they ran it second) */
  rv?: string[];
  /**
   * a death story (docs/remembrance.md): the deceased it is about, ids of the server's archive (sim/death.ts), so N5's
   * memories can name them ("my grandad died in the Brixton fire") and open their headstone
   */
  dead?: number[];
}

export const NEWS = {
  /** stories kept in the ring, and the oldest kept (game days) */
  keep: 200, keepDays: 7,
  /** stories a client gets when it joins (the newest) */
  helloSend: 60,
  /**
   * game hours a story stays live: it gets its end when it breaks, t plus these, except a fire and an explosion whose fire
   * still burns, which are live until the fire is out (their hours are then only a guard for an end that never came)
   */
  liveHours: { fire: 12, explosion: 6, rank: 4, milestone: 2, opening: 3, line: 3, death: 8, planning: 6, weather: 6 } as Record<StoryKind, number>,
  /** the showcase's fire drill relights every hour or so: one story per drill home a game day, not one per drill */
  drillDedupeTicks: TICKS_PER_DAY,
};

/** Tiles (square, from the door) a broadcaster's channel reaches by kind id: -1 not a broadcaster, 0 the whole map. */
export const NEWS_RADIUS_OF = new Int16Array(256).fill(-1);
/** A broadcaster's tier (1 TV studio, 2 broadcast centre, 3 media centre): the higher wins a story two channels reach. */
export const NEWS_TIER_OF = new Uint8Array(256);
/** News helicopters based on the roof pad (N3). */
export const NEWS_HELIS_OF = new Uint8Array(256);
for (const k of MANIFEST) {
  const a = k.levels[0]?.attrs ?? k.attrs;
  if (typeof a.newsRadius !== 'number') continue;
  NEWS_RADIUS_OF[k.kindId] = a.newsRadius;
  NEWS_TIER_OF[k.kindId] = typeof a.newsTier === 'number' ? a.newsTier : 1;
  NEWS_HELIS_OF[k.kindId] = typeof a.newsHelicopters === 'number' ? a.newsHelicopters : 0;
}
export const isMediaKind = (id: number) => (NEWS_RADIUS_OF[id] ?? -1) >= 0;

/** A staffed media centre: whose channel it is, its door and kind. */
export interface Channel { owner: string; x: number; y: number; kind: number }

/** Whether a centre's channel reaches tile (x, y). */
export function reaches(c: Channel, x: number, y: number): boolean {
  const r = NEWS_RADIUS_OF[c.kind];
  return r === 0 || (r > 0 && Math.max(Math.abs(c.x - x), Math.abs(c.y - y)) <= r);
}

/**
 * Who covers a story at (x, y): of every channel whose centre reaches it, the one with the highest-tier centre there,
 * then the nearest, then by player id (so the answer never depends on list order); the others are its rivals.
 */
export function coverStory(x: number, y: number, centres: readonly Channel[]): { ch?: string; rv?: string[] } {
  const best = new Map<string, { tier: number; d: number }>();
  for (const c of centres) {
    if (!reaches(c, x, y)) continue;
    const tier = NEWS_TIER_OF[c.kind], d = Math.max(Math.abs(c.x - x), Math.abs(c.y - y));
    const b = best.get(c.owner);
    if (!b || tier > b.tier || (tier === b.tier && d < b.d)) best.set(c.owner, { tier, d });
  }
  if (!best.size) return {};
  const order = [...best].sort((a, b) => b[1].tier - a[1].tier || a[1].d - b[1].d || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return order.length > 1 ? { ch: order[0][0], rv: order.slice(1).map((o) => o[0]) } : { ch: order[0][0] };
}

/** A channel's name on air: the owner's name and "TV" ("Commons TV"). */
export const channelName = (ownerName: string) => `${ownerName} TV`;

/** Whether a story is still live at `tick`: until its end, or (a fire still burning) at most NEWS.liveHours. */
export function storyLive(s: Pick<StoryDTO, 't' | 'k' | 'end'>, tick: number): boolean {
  return tick >= s.t && tick < (s.end ?? s.t + NEWS.liveHours[s.k] * TICKS_PER_HOUR);
}

// ---------------------------------------------------------------- headlines

/** One of a list, by the story's id and a salt: the same story always reads the same, on every server. */
export const storyPick = <T>(id: number, salt: number, list: readonly T[]): T => list[Math.floor(hash2(id * 7 + 1, salt) * list.length)];

/** What a headline is filled with: real names (the building's sign, the place, the town, the channel). */
export interface StoryWords {
  /** the building, as its sign or kind reads ("Patel's Bakery", "the general hospital") */
  b?: string;
  /** where: a parcel's own name, or the owner's town ("Riverside", "Ada's town") */
  place?: string;
  /** the town a rank or milestone is about */
  town?: string;
  /** a rank's name, a milestone's text, a line's name, a channel's name */
  what?: string;
  /** a number: levels lost, the grant */
  n?: number;
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The headline templates, by story kind and phase. Each is a list the story's id picks from (storyPick), so the ticker
 * does not repeat itself; every word comes from the simulation, nothing is typed by a player.
 */
export const HEADLINES = {
  fire: [
    (w: StoryWords) => `Fire at ${w.b} in ${w.place}`,
    (w: StoryWords) => `${cap(w.b!)} ablaze in ${w.place}`,
    (w: StoryWords) => `Smoke over ${w.place}: ${w.b} on fire`,
  ],
  fireCrew: [
    (w: StoryWords) => `Fire at ${w.b} in ${w.place}: crews on the way`,
    (w: StoryWords) => `${cap(w.b!)} on fire in ${w.place}, engines called`,
  ],
  fireNoCrew: [
    (w: StoryWords) => `${cap(w.b!)} burning in ${w.place} with no fire engine in reach`,
    (w: StoryWords) => `Fire at ${w.b} in ${w.place}: no crew can reach it`,
  ],
  saved: [
    (w: StoryWords) => `Crews save ${w.b} from fire in ${w.place}`,
    (w: StoryWords) => `Fire at ${w.b} put out before it spread`,
  ],
  bucket: [(w: StoryWords) => `Neighbours' bucket chain saves ${w.b} in ${w.place}`],
  damaged: [
    (w: StoryWords) => `${cap(w.b!)} damaged by fire: ${w.n} floor${w.n === 1 ? '' : 's'} lost`,
    (w: StoryWords) => `Fire out at ${w.b} in ${w.place}, ${w.n} floor${w.n === 1 ? '' : 's'} lost`,
  ],
  burnt: [
    (w: StoryWords) => `${cap(w.b!)} burns down in ${w.place}`,
    (w: StoryWords) => `${cap(w.b!)} in ${w.place} lost to fire`,
  ],
  drill: [(w: StoryWords) => `Fire drill at ${w.b} in ${w.place}`],
  spread: [(w: StoryWords) => `Fire spreads to ${w.b} in ${w.place}`],
  /** `what` is the blast's label (shared fires.ts BLAST_CAUSES: 'Explosion', 'Gas explosion'), `n` the buildings it set alight */
  explosion: [
    (w: StoryWords) => `${w.what} at ${w.b} in ${w.place}`,
    (w: StoryWords) => `${w.what} rocks ${w.place}: ${w.b} hit`,
  ],
  explosionLit: [
    (w: StoryWords) => `${w.what} at ${w.b} in ${w.place} sets ${w.n} building${w.n === 1 ? '' : 's'} alight`,
    (w: StoryWords) => `${w.what} in ${w.place}: fire spreads from ${w.b} to ${w.n} building${w.n === 1 ? '' : 's'}`,
  ],
  levelled: [
    (w: StoryWords) => `${cap(w.b!)} destroyed by ${w.what === 'Gas explosion' ? 'a gas explosion' : 'an explosion'} in ${w.place}`,
  ],
  /** deaths in an incident (docs/remembrance.md, server sim/death.ts): `what` the first to die ("Ada Patel (34)"), `n` how many died */
  deathFire: [
    (w: StoryWords) => (w.n! > 1 ? `${w.n} die in fire at ${w.b} in ${w.place}` : `${w.what} dies in fire at ${w.b} in ${w.place}`),
    (w: StoryWords) => (w.n! > 1 ? `Fire at ${w.b} in ${w.place} claims ${w.n} lives` : `Fire at ${w.b} in ${w.place} claims a life: ${w.what}`),
  ],
  deathBlast: [
    (w: StoryWords) => (w.n! > 1 ? `${w.n} killed in explosion at ${w.b} in ${w.place}` : `${w.what} killed in explosion at ${w.b} in ${w.place}`),
    (w: StoryWords) => (w.n! > 1 ? `Explosion at ${w.b} leaves ${w.n} dead in ${w.place}` : `Explosion at ${w.b} in ${w.place} claims a life`),
  ],
  deathAccident: [
    (w: StoryWords) => `Worker killed in accident at ${w.b} in ${w.place}`,
    (w: StoryWords) => `${w.what} dies in accident at ${w.b} in ${w.place}`,
  ],
  rank: [
    (w: StoryWords) => `${w.town} becomes a ${w.what}`,
    (w: StoryWords) => `${w.what} status for ${w.town}`,
    (w: StoryWords) => `Bells ring as ${w.town} is named a ${w.what}`,
  ],
  milestone: [(w: StoryWords) => `${w.town}: ${w.what}`],
  opening: [
    (w: StoryWords) => `${cap(w.b!)} opens in ${w.place}`,
    (w: StoryWords) => `Doors open at the new ${w.b} in ${w.place}`,
  ],
  onAir: [(w: StoryWords) => `${w.what} goes on air from ${w.place}`],
  line: [
    (w: StoryWords) => `${w.what} opens in ${w.place}`,
    (w: StoryWords) => `First service on ${w.what}`,
  ],
  /** planning (M5): `town` the applicant's ("Ada's town"), `what` the plan ("an open tip"), `n` the votes for, `place` where */
  planFiled: [
    (w: StoryWords) => `${w.town} applies to build ${w.what} by ${w.place}: residents to vote`,
    (w: StoryWords) => `Planning notice: ${w.what} proposed near ${w.place}`,
  ],
  planApproved: [
    (w: StoryWords) => `Residents back ${w.what} near ${w.place}`,
    (w: StoryWords) => `Plans for ${w.what} by ${w.place} approved`,
  ],
  planRefused: [
    (w: StoryWords) => `Residents throw out ${w.what} near ${w.place}`,
    (w: StoryWords) => `Plans for ${w.what} by ${w.place} refused after a vote`,
  ],
  closureFiled: [(w: StoryWords) => `${w.town} gives notice to close a road near ${w.place}`],
  closureDone: [(w: StoryWords) => `Road near ${w.place} closed: no objections`],
  closureBlocked: [(w: StoryWords) => `Road closure near ${w.place} stopped by an objection`],
};
export type HeadlineSet = keyof typeof HEADLINES;
/** The headline of a story with this id from a template set. */
export const headline = (set: HeadlineSet, id: number, w: StoryWords) => storyPick(id, 31 + set.length, HEADLINES[set])(w);
