import { CanvasTexture, WebGLRenderTarget, PerspectiveCamera, LinearFilter, SRGBColorSpace, Vector3, type Texture, type WebGLRenderer, type Scene, type Object3D } from 'three';
import {
  CIVITAS_CHANNELS, dayForecast, playerChannel, programmeAt, homeChannel, tvOnAt, watchingLine, GENRE_CODE, hash2, leisureAt, eventOn, eventStartAt, isLeisure,
  isRoad, zoneOf, levelOf, CHUNK_SIZE, RANKS, TRANSIT, TAXI, FOOD, CITIES, WEEKDAY_NAMES, TICKS_PER_DAY, TICKS_PER_HOUR, Zone,
  type TvChannel, type Programme, type Genre, type HeliState, type StoryDTO, type CitizenInfo, type RankDTO, type ServerMsg, type LeisureSpec,
} from '@msimcity/shared';
import { news } from '../news';
import type { ClientWorld } from '../world';
import type { HelicoptersView } from './helicopters';
import { placeOf, homeSeedOf, barSetSeed, type TvPicture, type TvSource } from './interiors';

/**
 * Television (docs/media.md sections 7-8, UTD e857a19d and 90cd3857 N4): what every set in the first-person rooms shows.
 *
 * - **Channels:** Civitas 1, Civitas 2 and each player's media channel (any channel that has reported a story). The
 *   schedule is shared/tv.ts `programmeAt`, a pure function of the channel and the game hour.
 * - **Live news:** while a channel's news helicopter is over a story (shared newsHelis.ts), its sets show the
 *   helicopter's own camera: `LiveFeed`, one 160×90 render target refreshed about 5 times a second, only while a set
 *   showing it is on screen in the FPV (or a big screen is near the camera), one feed at a time, never on the low preset.
 *   The same texture goes to the big screens' news turn (AdvertsView.setNewsFeed).
 * - **Graphics per channel, not per set:** a 320×240 canvas per channel holds what the channel lays over its picture
 *   (the news lower third and LIVE bug, a programme's strap and logo, the weather map, the test card's name) or the whole
 *   teletext page. It is redrawn only when that changes (a teletext page turns every 40 ticks, about 8 s at 1x).
 * - **Priority:** live news, then the advert break (`adBreak`, adverts A6: not built), then the programme.
 *
 * Nothing goes over the wire and nothing new runs on the server: the pages come from what the client already holds
 * (the story log, the traffic bytes, the venues in loaded chunks, the rank message, the parcels).
 */

const GFX_W = 320, GFX_H = 240;
/** ticks a teletext page stays up */
const PAGE_TICKS = 40;
/** the live feed: its size and refreshes a second */
export const FEED_W = 160, FEED_H = 90, FEED_FPS = 5;

export interface TvDeps {
  world: ClientWorld;
  helis: HelicoptersView;
  /** the server's tick now (fractional) */
  tick(): number;
  /** the big screens' news turn (render/adverts.ts AdvertsView.setNewsFeed) */
  setNewsFeed(tex: Texture | null): void;
  /** the low preset (render/lighting.ts quality 0) or ?tvlive=0: no live render */
  lowPreset(): boolean;
}

/** What is on a channel now. */
export interface Show {
  ch: TvChannel;
  genre: Genre;
  title: string;
  seed: number;
  /** the news helicopter whose pictures it carries (live news), and its story */
  live: HeliState | null;
  story?: StoryDTO;
  /** the programme, when scheduled */
  prog?: Programme;
}

const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** One channel's graphics layer: a canvas, its texture and what is drawn on it now. */
interface Gfx { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; tex: CanvasTexture; key: string; draws: number }

/**
 * The forecast for a game day, the same on every set (weather pages and the weather map): read off the shared weather model
 * (shared/src/weather.ts) with the WORLD's seed, so the presenter agrees with the sky. `chSeed` only varies the "local" temperatures.
 */
export function forecast(day: number, chSeed = 0, worldSeed = 0) {
  const f = dayForecast(worldSeed, day);
  return { ...f, local: (i: number) => f.hi - 2 + Math.floor(hash2(day * 7 + i, 1706 + chSeed) * 5) };
}

/** A football club's name for a stadium: its place's name and a suffix. */
const CLUB = ['Rovers', 'United', 'Town', 'Athletic', 'Wanderers', 'City', 'Albion'];

export class LiveFeed {
  readonly rt = new WebGLRenderTarget(FEED_W, FEED_H, { minFilter: LinearFilter, magFilter: LinearFilter });
  /** a long lens over the scene: it sees a few tiles round the story, so the far plane is short (fewer draw calls) */
  readonly camera = new PerspectiveCamera(30, FEED_W / FEED_H, 0.05, 45);
  /** the helicopter a set on screen asked for, until when (ms); and the one being rendered */
  private wantId: number | null = null;
  private wantUntil = 0;
  private last = 0;
  private look = new Vector3();
  private cur: HeliState | null = null;
  heli: number | null = null;
  /** renders done and their cost (ms, CPU side including submission), for the probe and the perf note */
  renders = 0; lastMs = 0;
  constructor() { this.rt.texture.colorSpace = SRGBColorSpace; }
  /** A set showing helicopter `id` live is on screen this frame (the first asker keeps it while it keeps asking). */
  want(id: number) {
    const now = performance.now();
    if (this.wantId === null || this.wantId === id || now > this.wantUntil) { this.wantId = id; this.wantUntil = now + 400; }
  }
  /** Whether the feed carries this helicopter's pictures now. */
  runningFor(id: number) { return this.heli === id; }
  /**
   * Once a frame, before the buildings' cull: the helicopter asked for (by a set on screen, or a big screen near the
   * camera) and the camera on it, posed under its nose looking at the scene; null when no feed is wanted. The camera
   * goes into the buildings' cull and detail tiers (render/buildings.ts updateLod) so the scene is there to film.
   */
  prepare(d: TvDeps): PerspectiveCamera | null {
    const now = performance.now();
    const s = this.wantId !== null && now < this.wantUntil && !d.lowPreset() ? d.helis.newsStates.find((h) => h.id === this.wantId && h.news?.doing === 'live') : undefined;
    this.cur = s ?? null;
    if (!s) {
      if (this.heli !== null) { this.heli = null; d.setNewsFeed(null); }
      return null;
    }
    // the camera under the nose, looking at the scene; it breathes in and out a little, as a hand-held zoom does
    const c = this.camera, tt = now / 1000;
    const fx = Math.cos(s.heading), fz = Math.sin(s.heading);
    c.position.set(s.x + fx * 0.12, s.y - 0.08, s.z + fz * 0.12);
    const [lx, lz] = s.news!.look ?? [s.x, s.z];
    this.look.set(lx + 0.35 * Math.sin(tt * 0.23 + s.seed * 9), 0.35, lz + 0.35 * Math.cos(tt * 0.19 + s.seed * 7));
    c.lookAt(this.look);
    c.fov = 26 + 5 * Math.sin(tt * 0.11 + s.seed * 5);
    c.updateProjectionMatrix();
    return c;
  }
  /**
   * Then, before the FPV draws: render it when due (FEED_FPS). The big screens' news turn gets the texture while it runs;
   * during the render itself they are given the card back (the target cannot be read while it is written).
   */
  render(renderer: WebGLRenderer, scene: Scene, d: TvDeps, hide: readonly Object3D[]) {
    const s = this.cur, now = performance.now();
    if (!s || (this.heli === s.id && now - this.last < 1000 / FEED_FPS)) return;
    this.last = now;
    const t0 = performance.now();
    d.setNewsFeed(null);
    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.autoUpdate = shadows;
    hide.forEach((o, i) => { o.visible = vis[i]; });
    d.setNewsFeed(this.rt.texture);
    this.heli = s.id;
    this.renders++;
    this.lastMs = performance.now() - t0;
  }
}

export class TvGuide implements TvSource {
  readonly feed = new LiveFeed();
  /** the world's seed (the `welcome` message), which the weather model reads */
  worldSeed = 0;
  /** adverts A6 (docs/adverts.md section 9, not built): an advert break on a channel at a tick, ahead of the programme */
  adBreak: ((ch: TvChannel, tick: number) => Show | null) | null = null;
  /** N5 (citizen memories, not built): told what a set's household is watching when it changes, by home seed */
  onWatch: ((homeSeed: number, ch: TvChannel, show: Show) => void) | null = null;
  private gfx = new Map<string, Gfx>();
  private chans: TvChannel[] = [...CIVITAS_CHANNELS];
  private chansKey = '';
  private venues: { x: number; y: number; spec: LeisureSpec; name: string }[] = [];
  private venuesAt = -1e9;
  private venuesKey = '';
  private rank: RankDTO | null = null;
  private watched = new Map<number, string>();

  constructor(private d: TvDeps) {}

  /** Watch the net for the rank message (the ranks page) without taking it from ranks.ts. */
  tapNet(tap: (fn: (m: ServerMsg) => void) => void) { tap((m) => { if (m.t === 'rank') this.rank = m.rank; }); }

  /** The channels on air: the two national ones, then each player's that has reported something, by owner id. */
  channels(): readonly TvChannel[] {
    const key = `${news.version}|${this.d.world.players.size}`;
    if (key === this.chansKey) return this.chans;
    this.chansKey = key;
    const owners = [...new Set(news.all().map((s) => s.ch).filter((c): c is string => !!c))].sort();
    this.chans = [...CIVITAS_CHANNELS, ...owners.map((o) => { const p = this.d.world.players.get(o); return playerChannel(o, p?.name ?? o, p?.color ?? 0x888888); })];
    return this.chans;
  }

  /** Whether any stadium or sports hall in the loaded chunks has an event on this game day. */
  matchNight(day: number) { return this.sportsVenues().some((v) => eventOn(v.spec, day)); }

  /** What is on a channel at a tick: live news, an advert break, or the programme. */
  show(ch: TvChannel, tick: number): Show {
    const live = this.liveHeli(ch);
    if (live) return { ch, genre: 'news', title: 'Breaking news', seed: hash2(ch.seed, live.id), live, story: live.news?.story !== undefined ? news.get(live.news.story) : undefined };
    const ad = this.adBreak?.(ch, tick);
    if (ad) return ad;
    const prog = programmeAt(ch, tick, this.matchNight(Math.floor(tick / TICKS_PER_DAY)));
    const story = prog.genre === 'news' ? news.latest(1, ch.owner)[0] : undefined;
    return { ch, genre: prog.genre, title: prog.title, seed: prog.seed, live: null, story, prog };
  }

  /** A player channel's helicopter over a story; Civitas 1 takes the pictures of any channel's (the pool feed). */
  private liveHeli(ch: TvChannel): HeliState | null {
    if (ch.id === 'c2') return null;
    let best: HeliState | null = null;
    for (const h of this.d.helis.newsStates) {
      if (h.news?.doing !== 'live' || h.news.story === undefined) continue;
      if (ch.owner && h.news.channel !== ch.owner) continue;
      if (!best || h.news.story > best.news!.story!) best = h;
    }
    return best;
  }

  /** The channel a set is tuned to: a home's by its household, a pub's to the match (or Civitas 1). */
  channelOf(setSeed: number, home: boolean, tick: number): TvChannel {
    const chans = this.channels();
    if (home) return homeChannel(setSeed, tick, chans);
    const day = Math.floor(tick / TICKS_PER_DAY);
    const night = this.matchNight(day);
    for (const c of chans) if (programmeAt(c, tick, night).genre === 'match') return c;
    return chans[hash2(setSeed, Math.floor(tick / TICKS_PER_HOUR)) < 0.75 ? 0 : 1];
  }

  /** interiors.ts asks this once a frame for each set (TvSource). */
  picture(setSeed: number, home: boolean, visible: boolean): TvPicture {
    const tick = this.d.tick();
    const ch = this.channelOf(setSeed, home, tick);
    const show = this.show(ch, tick);
    if (show.live && visible && !this.d.lowPreset()) this.feed.want(show.live.id);
    const feed = show.live && this.feed.runningFor(show.live.id) ? this.feed.rt.texture : null;
    if (home && this.onWatch) {
      const k = `${ch.id}|${show.title}|${show.prog?.hour ?? 'live'}`;
      if (this.watched.get(setSeed) !== k) { this.watched.set(setSeed, k); if (this.watched.size > 64) this.watched.clear(); this.onWatch(setSeed, ch, show); }
    }
    return {
      genre: feed ? 11 : GENRE_CODE[show.genre], seed: show.seed, pace: 0.75 + 0.5 * hash2(ch.seed, 3),
      color: ch.color, gfx: this.gfxOf(ch, show, tick), feed,
      label: show.live ? `the live news on ${ch.name}` : watchingLine(show, ch),
    };
  }

  /** "watching Quiz Night on Civitas 1": what a citizen at home (or in the pub) is watching now, or null (ui.ts citizen panel). */
  watching(info: CitizenInfo): string | null {
    const tick = this.d.tick(), hour = (tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
    const place = placeOf(info, hour);
    if (!place) return null;
    if (place.room === 'bar') return this.label(this.show(this.channelOf(barSetSeed(place.seed), false, tick), tick));
    if (place.room !== 'lounge') return null;
    const retired = info.life?.stage === 'retired' || (info.life?.age ?? 30) >= 66;
    if (!tvOnAt(homeSeedOf(info), hour, retired)) return null;
    return this.label(this.show(this.channelOf(homeSeedOf(info), true, tick), tick));
  }
  private label(s: Show) { return s.live ? `the live news on ${s.ch.name}` : watchingLine(s, s.ch); }

  /**
   * Once a frame from main.ts, before the buildings' cull: a big screen near the camera asks for the newest live
   * helicopter's pictures for its news turn (`near`), then the feed poses its camera; the camera is returned for the cull.
   */
  prepare(near: boolean): PerspectiveCamera | null {
    if (near && !this.d.lowPreset()) { const h = this.liveHeli(CIVITAS_CHANNELS[0]); if (h) this.feed.want(h.id); }
    return this.feed.prepare(this.d);
  }
  /** Then, before the FPV draws: the feed's render when due. */
  render(renderer: WebGLRenderer, scene: Scene, hide: readonly Object3D[]) { this.feed.render(renderer, scene, this.d, hide); }

  /** Debug and the perf probe: canvases drawn so far, per channel. */
  stats() { return [...this.gfx].map(([id, g]) => ({ id, draws: g.draws, key: g.key })); }

  // ---- the channel's graphics layer ------------------------------------------------------------------

  private gfxOf(ch: TvChannel, show: Show, tick: number): Texture {
    let g = this.gfx.get(ch.id);
    if (!g) {
      const canvas = document.createElement('canvas');
      canvas.width = GFX_W; canvas.height = GFX_H;
      const tex = new CanvasTexture(canvas);
      tex.colorSpace = SRGBColorSpace; tex.minFilter = LinearFilter; tex.generateMipmaps = false;
      g = { canvas, g: canvas.getContext('2d')!, tex, key: '', draws: 0 };
      this.gfx.set(ch.id, g);
    }
    const key = this.gfxKey(ch, show, tick);
    if (key !== g.key) {
      g.key = key;
      g.g.clearRect(0, 0, GFX_W, GFX_H);
      this.draw(g.g, ch, show, tick);
      g.tex.needsUpdate = true;
      g.draws++;
    }
    return g.tex;
  }

  /** What the layer shows, as a string: it is redrawn only when this changes. */
  private gfxKey(ch: TvChannel, s: Show, tick: number): string {
    const strap = s.prog ? tick - s.prog.start < TICKS_PER_HOUR / 10 : false;
    switch (s.genre) {
      case 'teletext': return `tt|${Math.floor(tick / PAGE_TICKS)}|${news.version}`;
      case 'news': return `news|${s.live ? 'live' : 'studio'}|${s.story?.id ?? ''}|${s.story?.h ?? ''}|${s.title}`;
      case 'weather': return `wx|${Math.floor(tick / TICKS_PER_DAY)}|${this.d.world.chunks.size}`;
      case 'match': return `match|${s.prog?.hour}|${Math.floor((tick - (s.prog?.start ?? 0)) / 25)}|${strap}`;
      default: return `${s.genre}|${s.title}|${strap}|${ch.name}`;
    }
  }

  private draw(g: CanvasRenderingContext2D, ch: TvChannel, s: Show, tick: number) {
    switch (s.genre) {
      case 'teletext': return this.teletext(g, ch, tick);
      case 'news': return this.newsGfx(g, ch, s);
      case 'weather': return this.weatherMap(g, ch, tick);
      case 'testcard': return this.testCard(g, ch);
      case 'match': return this.matchGfx(g, ch, s, tick);
      default: return this.strap(g, ch, s, tick);
    }
  }

  /** the channel's logo, small in a top corner (a "dog") */
  private dog(g: CanvasRenderingContext2D, ch: TvChannel, right = true) {
    g.font = 'bold 13px system-ui, sans-serif';
    const w = g.measureText(ch.name).width + 12;
    const x = right ? GFX_W - w - 10 : 10;
    g.globalAlpha = 0.55;
    g.fillStyle = hex(ch.color); g.fillRect(x, 10, w, 19);
    g.globalAlpha = 0.8;
    g.fillStyle = '#fff'; g.fillText(ch.name, x + 6, 24);
    g.globalAlpha = 1;
  }

  private newsGfx(g: CanvasRenderingContext2D, ch: TvChannel, s: Show) {
    this.dog(g, ch);
    // the bug: LIVE in red while the helicopter's pictures run, else the channel's news
    g.font = 'bold 15px system-ui, sans-serif';
    const bug = s.live ? 'LIVE' : 'NEWS';
    g.fillStyle = s.live ? '#d0302a' : hex(ch.color); g.fillRect(10, 10, g.measureText(bug).width + 14, 22);
    g.fillStyle = '#fff'; g.fillText(bug, 17, 27);
    // the lower third: the story's headline on the channel's colour
    const h = s.story?.h ?? (s.live ? 'Pictures from our helicopter' : `${s.title}: no news tonight is good news`);
    g.fillStyle = 'rgba(8,10,16,0.82)'; g.fillRect(0, 178, GFX_W, 46);
    g.fillStyle = hex(ch.color); g.fillRect(0, 178, 8, 46);
    g.fillStyle = '#fff'; g.font = 'bold 14px system-ui, sans-serif';
    wrap(g, h, 16, 196, GFX_W - 26, 17, 2);
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = '10px system-ui, sans-serif';
    g.fillText(s.live ? `${ch.name} · from the news helicopter` : `${ch.name} · ${s.title}`, 16, 174);
  }

  private strap(g: CanvasRenderingContext2D, ch: TvChannel, s: Show, tick: number) {
    this.dog(g, ch);
    if (!s.prog || tick - s.prog.start >= TICKS_PER_HOUR / 10) return;
    // the first few minutes of a programme: its title across the bottom
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 190, GFX_W, 34);
    g.fillStyle = '#fff'; g.font = 'bold 17px Georgia, serif';
    g.fillText(s.title, 14, 213);
  }

  private matchGfx(g: CanvasRenderingContext2D, ch: TvChannel, s: Show, tick: number) {
    this.dog(g, ch);
    const v = this.sportsVenues().find((x) => eventOn(x.spec, Math.floor(tick / TICKS_PER_DAY)));
    const home = v ? clubOf(v) : 'Civitas Rovers', away = CITIES[Math.floor(hash2(s.seed * 1000, 3) * CITIES.length)];
    // the score as it stands: goals come at hashed minutes over the two hours
    const mins = Math.floor(((tick - (s.prog?.start ?? tick)) / (2 * TICKS_PER_HOUR)) * 90);
    let a = 0, b = 0;
    for (let i = 0; i < 6; i++) { const at = hash2(s.seed * 1000 + i, 9) * 95; if (at < mins && hash2(s.seed * 1000 + i, 11) < 0.55) { if (hash2(s.seed * 1000 + i, 13) < 0.55) a++; else b++; } }
    g.fillStyle = 'rgba(10,14,30,0.85)'; g.fillRect(10, 10, 168, 22);
    g.fillStyle = '#fff'; g.font = 'bold 12px system-ui, sans-serif';
    g.fillText(`${abbr(home)} ${a}-${b} ${abbr(away)}`, 16, 25);
    g.fillStyle = '#9fe870'; g.fillText(`${Math.min(90, mins)}'`, 140, 25);
  }

  private testCard(g: CanvasRenderingContext2D, ch: TvChannel) {
    g.fillStyle = '#111'; g.fillRect(GFX_W / 2 - 60, GFX_H / 2 - 14, 120, 28);
    g.fillStyle = '#fff'; g.font = 'bold 15px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(ch.name.toUpperCase(), GFX_W / 2, GFX_H / 2 + 5);
    g.textAlign = 'left';
  }

  /** The weather map: the town's real outline (its built tiles; a player channel its owner's land), places and temperatures. */
  private weatherMap(g: CanvasRenderingContext2D, ch: TvChannel, tick: number) {
    const day = Math.floor(tick / TICKS_PER_DAY), fc = forecast(day, ch.seed, this.worldSeed);
    g.fillStyle = '#1d3f73'; g.fillRect(0, 0, GFX_W, GFX_H);
    const w = this.d.world;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const cells: [number, number][] = [];
    // the town: its built tiles and roads (every tile while the loaded area is small, every other one beyond)
    const step = w.chunks.size > 120 ? 2 : 1;
    for (const c of w.chunks.values()) {
      for (let j = 0; j < CHUNK_SIZE; j += step) for (let i = 0; i < CHUNK_SIZE; i += step) {
        const t = c.tiles[j * CHUNK_SIZE + i];
        if (t === undefined || (!isRoad(t) && zoneOf(t) === Zone.None)) continue;
        const x = c.cx * CHUNK_SIZE + i, y = c.cy * CHUNK_SIZE + j;
        if (ch.owner && w.parcelAt(x, y)?.owner !== ch.owner) continue;
        cells.push([x, y]);
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      }
    }
    if (cells.length) {
      const sc = Math.min((GFX_W - 60) / Math.max(8, x1 - x0 + 2), (GFX_H - 80) / Math.max(8, y1 - y0 + 2));
      const ox = (GFX_W - (x1 - x0 + 2) * sc) / 2 - x0 * sc, oy = 40 + (GFX_H - 70 - (y1 - y0 + 2) * sc) / 2 - y0 * sc;
      // a coastline: the land a little larger in a darker green under it
      const k = step * sc;
      g.fillStyle = '#2f6b33';
      for (const [x, y] of cells) g.fillRect(ox + x * sc - k * 0.8, oy + y * sc - k * 0.8, k * 2.6, k * 2.6);
      g.fillStyle = '#4f9a48';
      for (const [x, y] of cells) g.fillRect(ox + x * sc, oy + y * sc, k + 0.5, k + 0.5);
      // places with their temperatures: the parcels with the most people, at their middles, never on top of each other
      const places = [...w.parcels.values()].filter((p) => !ch.owner || p.owner === ch.owner).sort((a, b) => b.stats.population - a.stats.population || a.id - b.id);
      const put: [number, number][] = [];
      g.font = 'bold 11px system-ui, sans-serif';
      for (const [i, p] of places.entries()) {
        if (put.length >= 3) break;
        const px = ox + (p.x + p.w / 2) * sc, py = oy + (p.y + p.h / 2) * sc;
        if (put.some(([qx, qy]) => Math.abs(qx - px) < 90 && Math.abs(qy - py) < 40)) continue;
        put.push([px, py]);
        g.fillStyle = '#ffd23a'; g.fillRect(px - 13, py - 10, 26, 20);
        g.fillStyle = '#111'; g.textAlign = 'center'; g.fillText(`${fc.local(i)}`, px, py + 4);
        g.fillStyle = '#fff'; g.fillText(p.name.length > 18 ? `${p.name.slice(0, 17)}…` : p.name, px, py + 23);
      }
      g.textAlign = 'left';
    }
    g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, GFX_W, 32);
    g.fillStyle = '#fff'; g.font = 'bold 14px system-ui, sans-serif';
    g.fillText(`${WEEKDAY_NAMES[((day % 7) + 7) % 7]}: ${fc.sky}`, 10, 21);
    g.textAlign = 'right'; g.fillText(`${fc.lo}° to ${fc.hi}°`, GFX_W - 10, 21); g.textAlign = 'left';
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, GFX_H - 22, GFX_W, 22);
    g.fillStyle = '#fff'; g.font = '11px system-ui, sans-serif'; g.fillText(`${ch.name} weather · wind ${fc.windFrom} ${fc.wind} mph`, 10, GFX_H - 7);
  }

  // ---- teletext ------------------------------------------------------------------------------------------

  /** One Ceefax-style page: 40 columns by 24 rows of blocky colour text, page numbers and the fastext keys. */
  private teletext(g: CanvasRenderingContext2D, ch: TvChannel, tick: number) {
    const pages = this.pages(ch, tick);
    const n = Math.floor(tick / PAGE_TICKS);
    const p = pages[((n % pages.length) + pages.length) % pages.length];
    const cw = GFX_W / 40, rh = GFX_H / 24;
    g.fillStyle = '#000'; g.fillRect(0, 0, GFX_W, GFX_H);
    g.textBaseline = 'top';
    const text = (col: number, row: number, s: string, color: string, dbl = false) => {
      // double height: the same cell width, stretched to two rows, as the Ceefax headings are
      g.font = `bold ${dbl ? 11 : 9}px "Courier New", monospace`;
      g.fillStyle = color;
      if (dbl) { g.save(); g.scale(1, 1.9); }
      const k = dbl ? 1.9 : 1;
      for (let i = 0; i < s.length && col + i < 40; i++) g.fillText(s[i], (col + i) * cw + 0.5, (row * rh + 0.5) / k);
      if (dbl) g.restore();
    };
    const day = Math.floor(tick / TICKS_PER_DAY), hh = (tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
    text(0, 0, `P${p.no}`, '#fff');
    text(6, 0, `CIVITEXT ${p.no}`, '#ff0');
    text(23, 0, `${WEEKDAY_NAMES[((day % 7) + 7) % 7]} ${pad2(hh)}:${pad2((hh % 1) * 60)}`, '#fff');
    // the title band, double height on a colour
    g.fillStyle = p.band; g.fillRect(0, rh * 1.2, GFX_W, rh * 2.6);
    text(1, 1.4, p.title, '#fff', true);
    text(28, 2, ch.name.slice(0, 11).toUpperCase(), '#000');
    p.lines.slice(0, 18).forEach(([s, c], i) => text(1, 4.5 + i, s.slice(0, 38), c));
    // the fastext row
    const keys: [string, string][] = [['#f33', 'News'], ['#3f3', 'Travel'], ['#ff3', 'Sport'], ['#3ff', 'Weather']];
    keys.forEach(([c, k], i) => text(i * 10, 23, k, c));
    g.textBaseline = 'alphabetic';
  }

  /** The pages a channel's teletext turns through, from the city's own data. */
  private pages(ch: TvChannel, tick: number): { no: number; title: string; band: string; lines: [string, string][] }[] {
    const out: { no: number; title: string; band: string; lines: [string, string][] }[] = [];
    const col = ['#fff', '#0ff', '#ff0', '#0f0'];
    // 101 headlines from the story log
    const heads = news.latest(6, ch.owner);
    const nl: [string, string][] = [];
    if (!heads.length) nl.push(['No news yet. A staffed TV studio', '#fff'], ['reports the town\'s stories.', '#fff']);
    heads.forEach((s, i) => { for (const l of lines(s.h, 37).slice(0, 3)) nl.push([l, col[i % 2]]); nl.push(['', '#fff']); });
    out.push({ no: 101, title: 'NEWS', band: '#0000c8', lines: nl });
    // 140 weather
    const day = Math.floor(tick / TICKS_PER_DAY), fc = forecast(day, ch.seed, this.worldSeed), tm = forecast(day + 1, ch.seed, this.worldSeed);
    out.push({ no: 140, title: 'WEATHER', band: '#008000', lines: [
      ['TODAY', '#ff0'], [`${fc.sky}.`, '#fff'], [`Highs of ${fc.hi}C, lows of ${fc.lo}C.`, '#fff'], [`Wind ${fc.windFrom}, ${fc.wind} mph.`, '#fff'], ['', '#fff'],
      ['TOMORROW', '#ff0'], [`${tm.sky}. ${tm.lo}C to ${tm.hi}C.`, '#0ff'],
    ] });
    // 430 travel: real jams from the traffic bytes the client holds
    out.push({ no: 430, title: 'TRAVEL', band: '#c80000', lines: this.travel() });
    // 302 sport: the stadiums' and halls' event nights
    out.push({ no: 302, title: 'SPORT', band: '#c800c8', lines: this.sport(day, tick) });
    // 200 prices, 500 the town's rank
    out.push({ no: 200, title: 'PRICES', band: '#c87800', lines: this.prices() });
    const rk = this.rankLines(ch);
    if (rk.length) out.push({ no: 500, title: 'YOUR TOWN', band: '#0078c8', lines: rk });
    return out;
  }

  private travel(): [string, string][] {
    const w = this.d.world;
    const jams = new Map<string, { x: number; y: number; n: number; peak: number }>();
    for (const [key, bytes] of w.traffic) {
      const c = w.chunks.get(key);
      if (!c) continue;
      for (let i = 0; i < bytes.length; i++) {
        const v = bytes[i];
        if (v < 150 || !isRoad(c.tiles[i])) continue;
        const x = c.cx * CHUNK_SIZE + (i % CHUNK_SIZE), y = c.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        const k = `${Math.floor(x / 8)},${Math.floor(y / 8)}`;
        const j = jams.get(k) ?? { x, y, n: 0, peak: 0 };
        j.n++; if (v > j.peak) { j.peak = v; j.x = x; j.y = y; }
        jams.set(k, j);
      }
    }
    const list = [...jams.values()].sort((a, b) => b.n - a.n || b.peak - a.peak).slice(0, 6);
    if (!list.length) return [['ROADS', '#ff0'], ['Traffic is moving freely on all', '#fff'], ['roads in the town.', '#fff'], ['', '#fff'], ['BUSES', '#ff0'], [`Fares $${TRANSIT.fare} a journey.`, '#0ff']];
    const out: [string, string][] = [['QUEUES ON THE ROADS', '#ff0']];
    for (const j of list) {
      const p = w.parcelAt(j.x, j.y);
      out.push([`${j.peak > 220 ? 'Standstill' : 'Slow traffic'}: ${p?.name ?? 'open road'}`, j.peak > 220 ? '#f55' : '#fff'], [`  near (${j.x}, ${j.y}), ${j.n} road${j.n === 1 ? '' : 's'}`, '#0ff']);
    }
    return out;
  }

  private sport(day: number, tick: number): [string, string][] {
    const vs = this.sportsVenues().filter((v) => v.spec.eventNights.length);
    if (!vs.length) return [['No stadium or sports hall in town', '#fff'], ['yet: build one for match nights.', '#fff']];
    const out: [string, string][] = [['RESULTS', '#ff0']];
    const hour = (tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
    for (const v of vs.slice(0, 4)) {
      // the last event night that has finished
      let last = -1;
      for (let d = day; d > day - 8; d--) if (eventOn(v.spec, d) && (d < day || hour > eventStartAt(v.spec, v.x, v.y) + 2)) { last = d; break; }
      const club = clubOf(v), away = CITIES[Math.floor(hash2(v.x * 31 + last, v.y) * CITIES.length)];
      if (last >= 0) out.push([`${club.slice(0, 16).padEnd(16)} ${Math.floor(hash2(last, v.x) * 4)}-${Math.floor(hash2(last, v.y) * 3)} ${away.slice(0, 14)}`, '#fff']);
      let next = -1;
      for (let d = day; d < day + 8; d++) if (eventOn(v.spec, d) && (d > day || hour < eventStartAt(v.spec, v.x, v.y))) { next = d; break; }
      if (next >= 0) out.push([`  next: ${WEEKDAY_NAMES[((next % 7) + 7) % 7]} ${pad2(eventStartAt(v.spec, v.x, v.y))}:${pad2((eventStartAt(v.spec, v.x, v.y) % 1) * 60)} at ${v.name}`.slice(0, 38), '#0ff']);
    }
    return out;
  }

  private prices(): [string, string][] {
    const out: [string, string][] = [['LOCAL PRICES', '#ff0'], [`Bus fare            $${TRANSIT.fare}`, '#fff'], [`Taxi                $${TAXI.flagfall} + $${TAXI.perTile}/tile`, '#fff'], [`Takeaway meal       from $${FOOD.mealBase}`, '#fff']];
    const seen = new Set<string>();
    for (const v of this.allVenues()) {
      if (!v.spec.ticket || seen.has(v.spec.type)) continue;
      seen.add(v.spec.type);
      out.push([`${(v.spec.type === 'sports' ? 'Match ticket' : `${v.spec.type[0].toUpperCase()}${v.spec.type.slice(1)} ticket`).padEnd(20)}$${v.spec.ticket}`, '#0ff']);
    }
    const ps = [...this.d.world.parcels.values()];
    if (ps.length) {
      const tax = ps.reduce((a, p) => a + p.taxRate, 0) / ps.length;
      out.push(['', '#fff'], [`Council tax (mean)  ${(tax * 100).toFixed(1)}%`, '#0f0']);
    }
    return out;
  }

  private rankLines(ch: TvChannel): [string, string][] {
    const r = this.rank, w = this.d.world;
    if (r && (!ch.owner || ch.owner === w.me)) {
      const now = RANKS[r.rank], next = RANKS[r.rank + 1];
      const out: [string, string][] = [[`${now.name.toUpperCase()}`, '#ff0']];
      if (!next) out.push(['The top rank. Congratulations!', '#fff']);
      else {
        out.push([`Next: ${next.name}`, '#fff']);
        next.needs.forEach((q, i) => { const have = r.have[i] ?? 0; out.push([`${q.label.slice(0, 22).padEnd(22)} ${String(Math.min(have, q.target)).padStart(5)}/${q.target}`, have >= q.target ? '#0f0' : '#0ff']); });
      }
      return out;
    }
    // no rank (demos, test cities): the town in figures from the parcels
    const ps = [...w.parcels.values()].filter((p) => !ch.owner || p.owner === ch.owner);
    if (!ps.length) return [];
    const pop = ps.reduce((a, p) => a + p.stats.population, 0), jobs = ps.reduce((a, p) => a + p.stats.jobs, 0), emp = ps.reduce((a, p) => a + p.stats.employed, 0);
    return [['THE TOWN IN FIGURES', '#ff0'], [`Residents      ${pop.toLocaleString('en-GB')}`, '#fff'], [`Jobs           ${jobs.toLocaleString('en-GB')}`, '#fff'], [`Jobs filled    ${jobs ? Math.round((100 * emp) / jobs) : 0}%`, '#0ff'], [`Parcels        ${ps.length}`, '#fff']];
  }

  // ---- venues in the loaded chunks ---------------------------------------------------------------------

  private sportsVenues() { return this.allVenues().filter((v) => v.spec.type === 'sports'); }
  /** Every staffed leisure venue in the loaded chunks, by door, rescanned when the chunks change (at most every 5 s). */
  private allVenues() {
    const w = this.d.world, now = performance.now(), key = `${w.chunks.size}`;
    if (key === this.venuesKey && now - this.venuesAt < 30000) return this.venues;
    if (now - this.venuesAt < 5000) return this.venues;
    this.venuesKey = key; this.venuesAt = now;
    const seen = new Set<string>(), out: typeof this.venues = [];
    for (const c of w.chunks.values()) {
      for (let i = 0; i < c.tiles.length; i++) {
        const t = c.tiles[i];
        if (!t || isRoad(t) || zoneOf(t) === Zone.None || levelOf(t) <= 0) continue;
        const x = c.cx * CHUNK_SIZE + (i % CHUNK_SIZE), y = c.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        const kind = w.kindIdAt(x, y);
        if (!isLeisure(kind)) continue;
        const [dx, dy] = w.doorOf(x, y), k = `${dx},${dy}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const spec = leisureAt(kind, levelOf(t), dx, dy);
        if (!spec || spec.type === 'park') continue;
        out.push({ x: dx, y: dy, spec, name: spec.title });
      }
    }
    out.sort((a, b) => a.x - b.x || a.y - b.y);
    this.venues = out;
    return out;
  }
}

const clubOf = (v: { x: number; y: number }) => `${CITIES[Math.floor(hash2(v.x, v.y * 3 + 1) * CITIES.length)]} ${CLUB[Math.floor(hash2(v.x * 5, v.y) * CLUB.length)]}`;
const abbr = (s: string) => s.replace(/[^A-Za-z ]/g, '').split(' ').map((w) => w.slice(0, 3)).join('').slice(0, 3).toUpperCase();

/** words into lines of at most `n` characters */
function lines(s: string, n: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of s.split(' ')) {
    if ((cur ? cur.length + 1 : 0) + w.length > n) { if (cur) out.push(cur); cur = w.slice(0, n); } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}
/** canvas text wrapped to a width, at most `max` lines (the last cut with an ellipsis) */
function wrap(g: CanvasRenderingContext2D, s: string, x: number, y: number, width: number, lh: number, max: number) {
  const words = s.split(' ');
  let line = '', row = 0;
  for (let i = 0; i < words.length; i++) {
    const t = line ? `${line} ${words[i]}` : words[i];
    if (g.measureText(t).width > width && line) {
      if (row === max - 1) { g.fillText(`${line}…`, x, y + row * lh); return; }
      g.fillText(line, x, y + row * lh); row++; line = words[i];
    } else line = t;
  }
  if (line) g.fillText(line, x, y + row * lh);
}

