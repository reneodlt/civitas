import {
  NEWS, NEWS_RADIUS_OF, NEWS_TIER_OF, NEWS_HELIS_OF, FireOutcome, BLAST_CAUSES, RANKS, Cause, TICKS_PER_HOUR, TICKS_PER_DAY, Zone,
  kindManifest, signSource, signText, isMediaKind, isMergedKind, isMultiTile, coverStory, channelName, headline, reaches,
  type StoryDTO, type StoryKind, type StoryWords, type HeadlineSet, type Channel, type MediaInfo, type TransitLine,
} from '@msimcity/shared';
import type { World, Site, Building } from '../world';
import type { FireStoryEvent } from './fires';
import type { RankStoryEvent } from '../ranks';
import type { DeathStoryEvent } from './death';
import type { WeatherHold } from './weatherfx';

/** A story as the log keeps it: the DTO and the key of what it is about (a fire's id), so a later event finds it. */
interface Story extends StoryDTO { ref?: string }
/** What the snapshot keeps (snapshot.ts `news`): the ring, oldest first, and the next id. */
export interface NewsSave { stories: Story[]; nextId: number }

/** Placed kinds whose opening makes the news: civic buildings costing at least this, every landmark and broadcaster. */
const OPENING_COST = 1200;
/** Staffed media centres are looked up again at most this often (ticks), or when one opens. */
const CENTRES_EVERY = TICKS_PER_HOUR / 4;

/**
 * The news story log (docs/media.md N2, shared/src/news.ts). Events the simulation already produces come in through
 * hooks game.ts wires up: Fires.onStory (a fire lit and put out; Fires v2's spread and explosions), Ranks.onStory (a
 * rank reached, a milestone), World.onSiteCompleted (a notable building opening) and Net's line saves (a new line).
 * Deaths in an incident come from Death.onStory (sim/death.ts). Each becomes a story with a headline from the shared templates filled with real names, a salience, and the channel
 * that covers its place (coverStory over the staffed media centres). Stories live in a bounded ring (NEWS.keep, at most
 * NEWS.keepDays old); Net sends the new and changed ones as `news` and the newest on joining.
 *
 * Nothing runs per tick: the work happens at events, which are rare, so the tick cost is the hooks' calls. Ids and
 * headline picks come from a counter and hashes, so the same world and the same events give the same stories.
 */
export class News {
  /** stories new or changed since Net last drained them */
  readonly fresh = new Map<number, StoryDTO>();
  /** counters since start, for the probe */
  stats = { added: 0, updated: 0, covered: 0, dropped: 0 };
  private ring: Story[] = [];
  private byRef = new Map<string, Story>();
  private nextId = 1;
  private centres: Channel[] = [];
  private centresAt = -Infinity;

  constructor(private w: World) {
    const s = w.newsLoaded;
    if (s) {
      for (const st of s.stories ?? []) if (st && Number.isInteger(st.id) && Number.isInteger(st.t) && typeof st.h === 'string' && NEWS.liveHours[st.k] !== undefined) this.ring.push({ ...st });
      this.ring.sort((a, b) => a.id - b.id);
      for (const st of this.ring) if (st.ref) this.byRef.set(st.ref, st);
      this.nextId = Math.max(1, s.nextId ?? 1, 1 + (this.ring[this.ring.length - 1]?.id ?? 0));
      w.newsLoaded = null;
    }
    w.newsSave = () => this.save();
  }

  // ---- what clients get ---------------------------------------------------------------------

  /** The newest NEWS.helloSend stories, oldest first: what a client gets when it joins. */
  recent(): StoryDTO[] { return this.ring.slice(-NEWS.helloSend).map(dto); }
  /** The stories new or changed since the last call, oldest first. */
  drain(): StoryDTO[] { const out = [...this.fresh.values()]; this.fresh.clear(); return out; }
  /** Every story in the log, oldest first (probes, the save). */
  all(): readonly StoryDTO[] { return this.ring; }

  /** The building panel's lines for a media centre: its channel, reach, rivals and latest headlines. */
  describe(b: Building): MediaInfo | undefined {
    if (!isMediaKind(b.id)) return undefined;
    const owner = this.w.parcelAt(b.x, b.y)?.owner ?? '';
    const name = (id: string) => channelName(this.w.players.get(id)?.name ?? id);
    const rivals = new Set<string>();
    for (const c of this.centresNow()) if (c.owner !== owner && reaches(c, b.x, b.y)) rivals.add(c.owner);
    const mine = this.ring.filter((s) => s.ch === owner);
    return {
      channel: name(owner), owner, radius: NEWS_RADIUS_OF[b.id], tier: NEWS_TIER_OF[b.id], staffed: this.staffed(b),
      rivals: [...rivals].sort().map(name), stories: mine.length, latest: mine.slice(-3).reverse().map((s) => s.h), helicopters: NEWS_HELIS_OF[b.id],
    };
  }

  /**
   * How many channels reach each tile of a rect, for the news overlay (overlays.ts): 0 none, 1 one, 2 two or more.
   * `out[i]` for tile (x0 + i % w, y0 + floor(i / w)).
   */
  channelsOver(x0: number, y0: number, w: number, h: number, out: Uint8Array) {
    out.fill(0);
    const cs = this.centresNow();
    if (!cs.length) return;
    const owners = [...new Set(cs.map((c) => c.owner))];
    for (const o of owners) {
      const mine = cs.filter((c) => c.owner === o);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (out[k] < 2 && mine.some((c) => reaches(c, x0 + i, y0 + j))) out[k]++;
      }
    }
  }

  // ---- the events ------------------------------------------------------------------------------

  /** Fires (sim/fires.ts onStory): a fire lit, put out, spreading or an explosion. */
  fire(e: FireStoryEvent) {
    const now = this.w.tick, key = `fire:${e.id}`;
    const words: StoryWords = { b: this.buildingName(e.kind, e.x, e.y), place: this.placeName(e.x, e.y) };
    if (e.phase === 'lit') {
      if (e.quiet) return; // explode()'s fresh source: the explosion's story follows at once
      if (e.drill) {
        // the showcase's drill home lights again and again: one story a game day, live while each drill burns
        const prev = this.byRef.get(`drill:${e.x},${e.y}`);
        if (prev && now - prev.t < NEWS.drillDedupeTicks) {
          if (prev.end !== undefined) prev.lit = now; // live again: the news helicopter goes back out (shared newsHelis.ts)
          delete prev.end; this.byRef.set(key, prev); this.touch(prev);
          return;
        }
        const st = this.add('fire', e.x, e.y, (id) => headline('drill', id, words), 12, { who: e.owner, b: e.kind }, key);
        this.byRef.set(`drill:${e.x},${e.y}`, st);
        return;
      }
      const set: HeadlineSet = e.engine ? 'fireCrew' : e.warning ? 'fire' : 'fireNoCrew';
      this.add('fire', e.x, e.y, (id) => headline(set, id, words), this.fireSalience(e), { who: e.owner, b: e.kind }, key);
    } else if (e.phase === 'out') {
      const st = this.byRef.get(key);
      if (!st) return;
      this.byRef.delete(key);
      st.end = now;
      if (!e.drill && st.k === 'fire') { // an explosion keeps its headline; it is live until its fire is out
        const set: HeadlineSet = e.outcome === FireOutcome.Burnt ? 'burnt' : e.lost ? 'damaged' : e.crew ? 'saved' : 'bucket';
        st.h = headline(set, st.id, { ...words, n: e.lost ?? 0 });
        if (e.outcome === FireOutcome.Burnt) st.s = Math.min(100, st.s + 20);
        else if (e.lost) st.s = Math.min(100, st.s + 8);
      }
      this.touch(st);
    } else if (e.phase === 'spread') {
      if (e.drill) return; // the drill's blast lights its neighbours too: the drill's own story covers it
      this.add('fire', e.x, e.y, (id) => headline('spread', id, words), Math.min(100, this.fireSalience(e) + 15), { who: e.owner, b: e.kind }, key);
    } else {
      // explode()'s source, or a burning works blowing up: one story, live until the fire is out (a levelled building's fire
      // is out already, so its story keeps the hours it broke with)
      const w2: StoryWords = { ...words, what: BLAST_CAUSES[e.cause ?? 'industrial']?.label ?? 'Explosion', n: e.lit ?? 0 };
      const set: HeadlineSet = e.levelled ? 'levelled' : e.lit ? 'explosionLit' : 'explosion';
      const s = Math.min(100, 70 + 3 * (e.lit ?? 0) + (e.levelled ? 10 : 0));
      const prev = this.byRef.get(key);
      if (prev) {
        prev.k = 'explosion'; prev.h = headline(set, prev.id, w2); prev.s = Math.max(prev.s, s);
        this.touch(prev);
        return;
      }
      this.add('explosion', e.x, e.y, (id) => headline(set, id, w2), s, { who: e.owner, b: e.kind }, e.levelled ? undefined : key);
    }
  }

  /**
   * Death (sim/death.ts onStory): people killed in a fire, an explosion or an accident at work, one story for an incident's
   * dead, naming the first; its `dead` lists them all (N5's memories, docs/remembrance.md). Returns the story's id.
   */
  death(e: DeathStoryEvent): number | undefined {
    if (!e.dead.length) return undefined;
    const n = e.dead.length, first = e.dead[0];
    const words: StoryWords = { b: this.buildingName(e.kind, e.x, e.y), place: this.placeName(e.x, e.y), what: `${first.name} (${first.age})`, n };
    const set: HeadlineSet = e.cause === Cause.Explosion ? 'deathBlast' : e.cause === Cause.Accident ? 'deathAccident' : 'deathFire';
    const st = this.add('death', e.x, e.y, (id) => headline(set, id, words), Math.min(95, 50 + 10 * n), { ...(e.owner ? { who: e.owner } : {}), b: e.kind, dead: e.dead.map((d) => d.id) });
    return st.id;
  }

  /** Ranks (ranks.ts onStory): a town reaching a rank, or passing a milestone. */
  rank(e: RankStoryEvent) {
    const [x, y] = e.at, town = this.townName(e.player, x, y);
    if (e.kind === 'rank' && e.rank !== undefined) {
      const what = RANKS[e.rank]?.name ?? 'town';
      this.add('rank', x, y, (id) => headline('rank', id, { town, what }), 50 + 10 * e.rank, { who: e.player });
    } else {
      this.add('milestone', x, y, (id) => headline('milestone', id, { town, what: e.text }), 20, { who: e.player });
    }
  }

  /** World.onSiteCompleted: builders finished a site. A broadcaster goes on air; a big civic building or a landmark opens. */
  opened(site: Site) {
    const m = kindManifest(site.kind);
    if (!m || !m.flags.civic || m.flags.parking) return;
    const media = isMediaKind(site.kind), cost = m.levels[0]?.cost ?? 0;
    if (!media && !m.landmark && cost < OPENING_COST) return;
    const owner = this.w.parcelAt(site.x, site.y)?.owner;
    const place = this.placeName(site.x, site.y);
    if (media) {
      this.centresAt = -Infinity; // it reports from now on, its own opening first
      const what = channelName(this.w.players.get(owner ?? '')?.name ?? owner ?? 'City');
      this.add('opening', site.x, site.y, (id) => headline('onAir', id, { what, place }), 45 + 5 * NEWS_TIER_OF[site.kind], { ...(owner ? { who: owner } : {}), b: site.kind });
      return;
    }
    const b = this.buildingName(site.kind, site.x, site.y).replace(/^the /, '');
    this.add('opening', site.x, site.y, (id) => headline('opening', id, { b, place }), Math.min(70, 35 + Math.round(cost / 400) + (m.landmark ? 15 : 0)), { ...(owner ? { who: owner } : {}), b: site.kind });
  }

  /** Net, a line saved for the first time: its first service. */
  line(l: TransitLine) {
    const at = l.stops[0];
    if (!at) return;
    const what = l.mode === 'metro' ? (l.name ? `the ${l.name} line` : `metro line ${l.number}`)
      : l.mode === 'rail' ? `rail line ${l.number}` : l.mode === 'ferry' ? (l.name ? `the ${l.name} river bus` : `river bus ${l.number}`) : `bus route ${l.number}`;
    const place = this.placeName(at.x, at.y);
    this.add('line', at.x, at.y, (id) => headline('line', id, { what: what[0].toUpperCase() + what.slice(1), place }), l.mode === 'metro' ? 55 : l.mode === 'bus' ? 30 : 45, { who: l.owner });
  }

  /**
   * The weather held flights, river buses or shipping (docs/weather.md W4: Airports, Ferry, Harbours onHold), or let them
   * go again: one story per hold, live until it lifts (NEWS.liveHours.weather at most), its headline then saying so.
   */
  weather(e: WeatherHold) {
    const ref = `weather|${e.what}`, now = this.w.tick;
    const place = this.placeName(e.x, e.y), cause = e.reason === 'storm' ? 'the storm' : 'the fog';
    if (!e.lifted) {
      const h = e.what === 'flights' ? (e.reason === 'storm' ? `Storm holds flights at ${place}` : `Fog grounds flights at ${place}`)
        : e.what === 'river buses' ? `River buses tied up in ${cause} at ${place}` : `Ships wait out ${cause} off ${place}`;
      this.add('weather', e.x, e.y, () => h, e.what === 'flights' ? 40 : 30, e.owner ? { who: e.owner } : {}, ref);
      return;
    }
    const st = this.byRef.get(ref);
    this.byRef.delete(ref);
    if (!st || (st.end !== undefined && st.end <= now)) return;
    st.h = e.what === 'flights' ? `Flights land again at ${place} after ${cause}` : e.what === 'river buses' ? `River buses sail again after ${cause}` : `Ships come in to ${place} after ${cause}`;
    st.end = now + TICKS_PER_HOUR;
    this.touch(st);
  }

  // ---- the log -----------------------------------------------------------------------------------

  private add(k: StoryKind, x: number, y: number, h: (id: number) => string, s: number, extra: Partial<StoryDTO>, ref?: string): Story {
    const now = this.w.tick, id = this.nextId++;
    const pc = this.w.parcelIdAt(x, y);
    const cover = coverStory(x, y, this.centresNow());
    const st: Story = {
      id, t: now, k, x, y, h: h(id), s: Math.max(0, Math.min(100, Math.round(s))),
      // a fire, and an explosion whose fire still burns, are live until the fire is out; the rest for NEWS.liveHours
      ...(k === 'fire' || (k === 'explosion' && ref) ? {} : { end: now + Math.round(NEWS.liveHours[k] * TICKS_PER_HOUR) }),
      ...(pc ? { pc } : {}), ...extra, ...cover, ...(ref ? { ref } : {}),
    };
    this.ring.push(st);
    if (ref) this.byRef.set(ref, st);
    this.stats.added++;
    if (st.ch) this.stats.covered++;
    this.fresh.set(id, dto(st));
    this.prune(now);
    return st;
  }
  private touch(st: Story) { this.stats.updated++; this.fresh.set(st.id, dto(st)); }
  /** Keep the ring at NEWS.keep and NEWS.keepDays, never dropping a fire still burning. */
  private prune(now: number) {
    const old = now - NEWS.keepDays * TICKS_PER_DAY;
    while (this.ring.length && (this.ring.length > NEWS.keep || (this.ring[0].t < old && this.ring[0].end !== undefined))) {
      const st = this.ring.shift()!;
      if (st.ref && this.byRef.get(st.ref) === st) this.byRef.delete(st.ref);
      for (const [k, v] of this.byRef) if (v === st) this.byRef.delete(k);
      this.stats.dropped++;
    }
  }
  private save(): NewsSave { return { stories: this.ring.map((s) => ({ ...s })), nextId: this.nextId }; }

  // ---- channels and words ------------------------------------------------------------------------

  private staffed(b: Building) { return b.level > 0 && b.occupants > 0 && !this.w.mothballed.has(`${b.x},${b.y}`); }
  /** The staffed media centres and whose channels they are, looked up again every CENTRES_EVERY ticks. */
  centresNow(): readonly Channel[] {
    if (this.w.tick - this.centresAt < CENTRES_EVERY) return this.centres;
    this.centresAt = this.w.tick;
    const out: Channel[] = [];
    for (const b of this.w.builtOf(Zone.Office)) {
      if (!isMediaKind(b.id) || !this.staffed(b)) continue;
      const owner = this.w.parcelAt(b.x, b.y)?.owner;
      if (owner) out.push({ owner, x: b.x, y: b.y, kind: b.id });
    }
    out.sort((a, b) => a.x - b.x || a.y - b.y); // the building index has no order of its own
    this.centres = out;
    return out;
  }

  /** The fire's level and size: a tower block on fire is a bigger story than a cottage. */
  private fireSalience(e: FireStoryEvent) {
    if (e.warning) return 25;
    const b = this.w.buildings.get(`${e.x},${e.y}`);
    return 28 + 6 * Math.min(7, b?.level ?? 1) + (isMultiTile(e.kind) ? 10 : 0);
  }
  /** A building as a headline names it: a business by its sign, a home by what it is, a placed building by its kind. */
  private buildingName(kind: number, x: number, y: number): string {
    const m = kindManifest(kind);
    if (!m) return 'a building';
    if (m.family === 'residential' && m.flags.growable) {
      if (isMergedKind(kind)) return `the ${m.name}`;
      const level = this.w.buildings.get(`${x},${y}`)?.level ?? 1;
      return level >= 3 ? 'a block of flats' : 'a house';
    }
    if (m.flags.growable && (m.family === 'commercial' || m.family === 'office' || m.family === 'industrial')) {
      const s = this.w.structureAt(x, y);
      return signText(signSource(m, s ? s.ax : x, s ? s.ay : y));
    }
    return m.landmark || m.name.startsWith('the ') ? m.name : `the ${m.name}`;
  }
  /** Where: the parcel's own name when its owner gave it one, else the owner's town ("Ada's town"); unowned land by its tile. */
  private placeName(x: number, y: number): string {
    const pc = this.w.parcelAt(x, y);
    if (!pc) return `the open country at (${x}, ${y})`;
    if (!/'s (plot|charter)$/.test(pc.name)) return pc.name;
    return `${this.w.players.get(pc.owner)?.name ?? pc.owner}'s town`;
  }
  /** The town a rank or milestone is about: the parcel at its spot when it is the player's and named, else "Ada's town". */
  private townName(player: string, x: number, y: number): string {
    const pc = this.w.parcelAt(x, y);
    if (pc && pc.owner === player && !/'s (plot|charter)$/.test(pc.name)) return pc.name;
    return `${this.w.players.get(player)?.name ?? player}'s town`;
  }
}

/** The DTO of a story: everything but the log's own key. */
function dto(s: Story): StoryDTO {
  const { ref: _ref, ...out } = s;
  return out;
}
