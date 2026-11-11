/**
 * Bot F in process (docs/ranks.md section 3): the card-following player the ranks were tuned with, on a fake client and
 * the game's own loop, with no sockets and no real-time waits. Each `await` of the WebSocket bot (a sleep, waiting for
 * a reply, waiting for the next game hour) runs game loops instead, `steps` simulation ticks and one flush each, as the
 * server does at SIM_STEPS, so a three-hour frontier plays in a minute or two and the same seed plays the same game.
 *
 * Its choices are the WebSocket bot's (scratchpad ranks/play.mts with FRONTIER=1 FOLLOW=1 RINGS=1): the opening street,
 * camp and six rows of homes; then once a game hour cover, a park and the library, another builders' yard when lots
 * wait, every technology on its list once ready and affordable, a bus line, and the next block or row. It spends down
 * to a few hundred dollars whenever a card allows, so its treasury's low point is the floor a keen player would see.
 *
 * Used by loadtest/ranks.ts (the frontier cash floor). The treasury is read from the world after every loop, so the low
 * point is the true one, not an hourly sample.
 *
 * How it matches play.mts: the same blocks in the same order, the same thresholds ($700 spare for a technology or a
 * yard, $900 for a row, cover first when the card asks, a yard a game day while 20 lots wait) and the same order of
 * moves each game hour, on its FRONTIER=1 FOLLOW=1 RINGS=1 path only. What differs is time: a sleep of n ms is n/200
 * loops (one loop is 200 ms on the server), and a reply arrives within the loop, so the bot never falls behind a busy
 * server. Logging, screenshots, JOIN_HOUR and the Commons path are left out. On the same code the two agree within
 * the run-to-run spread (docs/ranks.md section 3): before the cash floor, seeds 1-12 gave medians of 17.9 / 42.5 /
 * 83.3 / 124.5 min against the WebSocket bot's 17.3 / 48.6 / 83.3 / 105.9.
 */
import {
  CHUNK_SIZE, RANKS, TECH, rankNeeds, ZONE_COST, TICKS_PER_DAY, TICK_MS, isRoad, zoneOf,
  type ServerMsg, type ClientMsg,
} from '@msimcity/shared';
import type { Game } from '../game';
import type { Conn } from '../transport';

/** a game day is 8 real minutes at 1× */
const minOf = (days: number) => Math.round(days * TICKS_PER_DAY * TICK_MS / 6000) / 10;

type Msg = ServerMsg & Record<string, any>;

/** The WebSocket bot's view of the game (scratchpad ranks/lib.mts), fed by a fake connection. */
class LocalBot {
  you = ''; day = 0; dayFrac = 0; home: [number, number] | null = null;
  players: any[] = []; parcels: any[] = []; stats: any = {};
  tiles = new Map<string, Uint16Array>(); owner = new Map<string, Int32Array>();
  toasts: { kind: string; msg: string }[] = []; pendingToasts: { kind: string; msg: string }[] = [];
  goals: any = null; rank: any = null;
  rankUps: { t: number; rank: number; grant: number }[] = [];
  done: { t: number; id: string }[] = [];
  /** every advisor hint heard, with the game time */
  hints: { t: number; id: string }[] = [];
  private onMsg: ((d: string) => void) | null = null;
  /** called after every game loop (the cash watch) */
  afterLoop = () => {};

  constructor(private game: Game, accept: (c: Conn) => void, name: string) {
    accept({ open: true, send: (d) => this.recv(JSON.parse(d)), close() {}, onMessage: (fn) => { this.onMsg = fn; }, onClose() {} });
    this.send({ t: 'hello', name } as ClientMsg);
    this.loops(1);
  }
  send(m: ClientMsg) { this.onMsg!(JSON.stringify(m)); }
  private recv(m: Msg) {
    switch (m.t) {
      case 'welcome': this.you = m.you; this.day = m.day; this.players = m.players; this.parcels = m.parcels; this.home = m.home ?? null; break;
      case 'players': { const old = new Map(this.players.map((p: any) => [p.id, p.ledger])); for (const p of m.players) if (!p.ledger) p.ledger = old.get(p.id); this.players = m.players; break; }
      case 'parcels': {
        const map = new Map(this.parcels.map((p) => [p.id, p]));
        for (const p of m.parcels) map.set(p.id, p);
        for (const id of m.removed ?? []) map.delete(id);
        this.parcels = [...map.values()]; break;
      }
      case 'stats': this.stats = m; this.day = m.day; this.dayFrac = m.dayFrac; break;
      case 'toast': { const o = { kind: m.kind, msg: m.msg }; this.toasts.push(o); this.pendingToasts.push(o); break; }
      case 'chunk': {
        const c = m.chunk, k = `${c.cx},${c.cy}`;
        const ab = (s: string) => { const b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
        this.tiles.set(k, new Uint16Array(ab(c.tiles))); this.owner.set(k, new Int32Array(ab(c.parcels)));
        break;
      }
      case 'tiles': {
        for (let i = 0; i < m.u.length; i += 4) {
          const x = m.u[i], y = m.u[i + 1], cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), k = `${cx},${cy}`;
          const a = this.tiles.get(k); if (!a) continue;
          const j = (y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE);
          a[j] = m.u[i + 2];
          const o = this.owner.get(k); if (o) o[j] = m.u[i + 3];
        }
        break;
      }
      case 'rank': this.rank = m.rank; if (m.up) this.rankUps.push({ t: this.day + this.dayFrac, ...m.up }); break;
      case 'goals': this.goals = m.goals; if (m.completed) this.done.push({ t: this.day + this.dayFrac, id: m.completed.id }); break;
      case 'hint': { this.hints.push({ t: this.day + this.dayFrac, id: m.id }); const o = { kind: 'hint:' + m.id, msg: m.msg ?? m.id }; this.toasts.push(o); this.pendingToasts.push(o); break; }
    }
  }
  tile(x: number, y: number): number | undefined {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
    return this.tiles.get(`${cx},${cy}`)?.[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)];
  }
  parcelId(x: number, y: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
    return this.owner.get(`${cx},${cy}`)?.[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)] ?? -1;
  }
  sub(cx0: number, cy0: number, cx1: number, cy1: number) {
    const chunks: [number, number][] = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) chunks.push([cx, cy]);
    this.send({ t: 'sub', chunks } as ClientMsg);
  }
  get me() { return this.players.find((p) => p.id === this.you); }
  /** the treasury as the server holds it now (the players message lags it by up to a second) */
  get money() { return this.game.world.players.get(this.you)?.money ?? Infinity; }
  /** n game loops (a loop is 200 ms of real time on the server) */
  loops(n: number) { for (let i = 0; i < n; i++) { this.game.loop(); this.afterLoop(); } }
  async sleep(ms: number) { this.loops(Math.max(1, Math.round(ms / 200))); }
  async until(f: () => boolean, ms = 10000) { for (let i = 0; !f(); i++) { if (i * 200 > ms) throw new Error('timeout'); this.loops(1); } }
  async waitGame(day: number) { while (this.day + this.dayFrac < day) this.loops(1); }
  buy(x: number, y: number, w: number, h: number) { this.send({ t: 'buy', x, y, w, h } as ClientMsg); }
  build(tool: string, tiles: [number, number][]) { this.send({ t: 'build', tool, tiles } as ClientMsg); }
  rect(x: number, y: number, w: number, h: number): [number, number][] { const o: [number, number][] = []; for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) o.push([i, j]); return o; }
}

export interface BotFResult {
  /** game minutes after joining at which each rank (1 = Hamlet ... 4 = City) was reached */
  ups: number[];
  /** the treasury's lowest point, read after every loop, and when (game minutes after joining, at 1× real minutes) */
  low: number; lowAt: number;
  /** the treasury at each game hour */
  hourly: number[];
  residents: number;
  /** goals done and advisor hints heard, with game minutes after joining (docs/ranks.md section 3, the first twenty minutes) */
  goals: { min: number; id: string }[];
  hints: { min: number; id: string }[];
}

/**
 * Join a fresh frontier world as its first player and play bot F for `minutes` (real minutes at 1×). `accept` is the
 * game's ConnSource hook (what createGame passed to `onConnection`); `log`, if given, hears each purchase and rank-up.
 */
export async function playF(game: Game, accept: (c: Conn) => void, minutes = 180, log?: (min: number, what: string) => void, opts: { power?: boolean; sample?: (min: number) => void } = {}): Promise<BotFResult> {
  return play(new LocalBot(game, accept, 'Gauntlet'), minutes, log, opts.power ?? true, opts.sample);
}
/**
 * Bot F on a shared world with the market rules (docs/multiplayer-land.md M2, loadtest/landbot.ts): it joins beside the
 * Commons, takes its free 16×16 homestead with its first block at `x0` (west edge against the Commons' east edge road,
 * so its streets join the town's), and buys each later block's land as it needs it (only the rows it does not own yet).
 * Blocks west of `x0` are left out (the Commons is there). Everything else is bot F's.
 */
export async function playMarket(game: Game, accept: (c: Conn) => void, x0: number, minutes = 180, log?: (min: number, what: string) => void, name = 'Homesteader'): Promise<BotFResult> {
  return play(new LocalBot(game, accept, name), minutes, log, true, undefined, x0);
}

/** `withPower` false: the bot as before utilities (no Electrification, no substations), the baseline loadtest/utilities-ranks.ts compares against */
async function play(b: LocalBot, minutes: number, log?: (min: number, what: string) => void, withPower = true, sample?: (min: number) => void, marketX0?: number): Promise<BotFResult> {
  b.sub(-3, -3, 3, 3);
  await b.sleep(1500);
  const T0 = b.day + b.dayFrac;
  const low = { v: Infinity, at: 0 };
  const note = (what: string) => log?.(minOf(b.day + b.dayFrac - T0), `${what} ($${Math.round(b.money)})`);
  let sampled = -1;
  b.afterLoop = () => {
    const m = b.money, now = minOf(b.day + b.dayFrac - T0);
    if (m < low.v) { low.v = m; low.at = now; }
    if (sample && Math.floor(now) > sampled) { sampled = Math.floor(now); sample(sampled); }
  };
  b.afterLoop();

  const mine = () => b.parcels.filter((p) => p.owner === b.you);
  const sum = (k: string) => mine().reduce((a, p) => a + (p.stats?.[k] ?? 0), 0);
  const money = () => b.me.money as number;

  // ---- layout: blocks of 16×9 (Z R Z Z R Z Z R Z) off the road end at welcome.home
  const market = marketX0 !== undefined;
  const X0 = marketX0 ?? b.home?.[0] ?? -10, W = 16;
  interface Block { x0: number; y0: number; bought: boolean; rows: { y: number; zone: string | null }[]; roadRows: number[] }
  const mkBlock = (y0: number, x0 = X0): Block => {
    const rel = ['Z', 'R', 'Z', 'Z', 'R', 'Z', 'Z', 'R', 'Z'];
    return { x0, y0, bought: false, rows: rel.map((r, i) => ({ y: y0 + i, r })).filter((o) => o.r === 'Z').map((o) => ({ y: o.y, zone: null })), roadRows: rel.map((r, i) => (r === 'R' ? y0 + i : -999)).filter((y) => y > -900) };
  };
  const blocks: Block[] = [mkBlock(-3), mkBlock(6), mkBlock(-12), mkBlock(15), mkBlock(-21),
    mkBlock(6, X0 - W), mkBlock(-12, X0 - W), mkBlock(15, X0 - W), mkBlock(-21, X0 - W),
    mkBlock(-3, X0 + W), mkBlock(6, X0 + W), mkBlock(-12, X0 + W), mkBlock(15, X0 + W), mkBlock(-21, X0 + W), mkBlock(-30), mkBlock(-30, X0 + W),
    mkBlock(-3, X0 + 2 * W), mkBlock(6, X0 + 2 * W), mkBlock(-12, X0 + 2 * W), mkBlock(15, X0 + 2 * W), mkBlock(-21, X0 + 2 * W), mkBlock(24), mkBlock(24, X0 + W)]
    .filter((k) => !market || k.x0 >= X0); // the market bot: the Commons is west of X0
  const allMine = (x: number, y: number, w: number, h: number) => {
    const own = new Map(b.parcels.map((p) => [p.id, p.owner]));
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (own.get(b.parcelId(i, j)) !== b.you) return false;
    return true;
  };
  let nextBlock = 0;
  async function buyBlock() {
    const blk = blocks[nextBlock];
    if (blk && market && !allMine(blk.x0, blk.y0, W, 9)) {
      // the market rules: the homestead first (16×16 from the first block's corner), then the rows of each block not yet owned
      const rows: number[] = [];
      for (let y = blk.y0; y < blk.y0 + 9; y++) if (!allMine(blk.x0, y, W, 1)) rows.push(y);
      const y0 = Math.min(...rows), h = Math.max(...rows) - y0 + 1, first = !b.parcels.some((p) => p.owner === b.you);
      const before = b.money;
      b.buy(blk.x0, y0, W, first ? Math.max(h, W) : h);
      await b.sleep(400);
      note(`bought ${W}×${first ? Math.max(h, W) : h} at (${blk.x0}, ${y0}) for $${Math.round(before - b.money)}`);
    }
    if (!blk || !allMine(blk.x0, blk.y0, W, 9)) return false; // a frontier's land comes with rank: wait for the ring
    blk.bought = true; nextBlock++;
    const tiles: [number, number][] = [];
    for (const y of blk.roadRows) for (let x = blk.x0; x < blk.x0 + W; x++) tiles.push([x, y]);
    const ys = blocks.filter((k) => (k.bought || k === blk) && k.x0 === blk.x0).flatMap((k) => k.roadRows);
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) if (!blk.roadRows.includes(y)) tiles.push([blk.x0, y]);
    b.build('road', tiles);
    note(`block y0=${blk.y0}: ${tiles.length} road tiles`);
    return true;
  }
  function zoneRowFor(): string {
    const owned = new Set(b.me.tech as string[]);
    const jobs: string[] = [];
    if (owned.has('zon1')) jobs.push('com', 'com');
    if (owned.has('zon2')) jobs.push('ind');
    if (owned.has('zon3')) jobs.push('off');
    const zoned = blocks.flatMap((k) => k.rows).filter((r) => r.zone && r.zone !== 'svc');
    const nRes = zoned.filter((r) => r.zone === 'res').length, nJob = zoned.length - nRes;
    if (!jobs.length) return 'res';
    if (nJob < nRes * 0.7) return jobs[nJob % jobs.length];
    return 'res';
  }
  async function zoneNext() {
    if (money() < 800) return false;
    const zonedRows = blocks.flatMap((k) => k.rows).filter((r) => r.zone && r.zone !== 'svc');
    const firstJob = zoneRowFor() !== 'res' && zonedRows.every((r) => r.zone === 'res');
    if (!firstJob && sum('sites') > 24) return false; // let builders catch up
    const resTiles = zonedRows.filter((r) => r.zone === 'res').length * W;
    if (zonedRows.length >= 6 && sum('population') < 0.5 * 4 * resTiles && zoneRowFor() === 'res') return false;
    for (const blk of blocks) {
      if (!blk.bought) continue;
      const row = blk.rows.find((r) => !r.zone);
      if (!row) continue;
      const z = zoneRowFor();
      if (money() < W * ZONE_COST + 500) return false;
      b.build(z, b.rect(blk.x0 + 1, row.y, W - 1, 1));
      row.zone = z;
      note(`zoned a row ${z}`);
      await b.sleep(150);
      return true;
    }
    return false;
  }

  // ---- technology, services, yards, a bus line
  // Electrification (docs/utilities.md): two-storey buildings need power, so the bot buys it with Masonry, as the rank card says
  const ORDER = ['zon1', 'con1', ...(withPower ? ['ut1'] : []), 'civ1', 'cul1', 'zon2', 'tr1', 'civ2', 'cul2', 'zon3', 'con2', 'tr2', 'tr3', 'tr5', 'civ3'];
  const BUY = new Set(['zon1', 'con1', ...(withPower ? ['ut1'] : []), 'civ1', 'cul1', 'zon2', 'tr1', 'civ2', 'cul2', 'zon3', 'con2', 'civ3', 'tr2', 'tr5']);
  const LATE = new Set(['tr2', 'tr3', 'tr5']);
  const ready = () => {
    const owned = new Set(b.me.tech as string[]);
    return TECH.filter((t) => !owned.has(t.id) && t.requires.every((r) => owned.has(r)) && (b.me.progress[t.condition.counter] ?? 0) >= t.condition.min);
  };
  const placed = new Set<string>();
  function freeTile(): [number, number] | null {
    for (const blk of blocks) {
      if (!blk.bought) continue;
      for (const r of blk.rows) {
        if (r.zone !== 'svc') continue;
        for (let x = blk.x0 + 1; x < blk.x0 + W - 1; x++) { const t = b.tile(x, r.y); if (t !== undefined && !isRoad(t) && zoneOf(t) === 0) return [x, r.y]; }
      }
    }
    for (const blk of [...blocks].reverse()) {
      if (!blk.bought) continue;
      for (const r of [...blk.rows].reverse()) { if (r.zone) continue; r.zone = 'svc'; return [blk.x0 + 1, r.y]; }
    }
    return null;
  }
  let yardPlaced = false, extraYards = 0, lastYardAt = 0;
  async function yard() {
    if (yardPlaced && extraYards < 8 && sum('sites') > 20 && money() > 700 && b.day + b.dayFrac - lastYardAt >= 1) {
      const ft = freeTile();
      if (ft) { b.build('yard', [ft]); await b.sleep(300); extraYards++; lastYardAt = b.day + b.dayFrac; note(`builders' yard #${extraYards + 1}`); }
    }
    if (yardPlaced) return;
    const told = b.toasts.some((t) => /waiting for builders/.test(t.msg)) || b.goals?.active === 'yard';
    if (!told && (b.day + b.dayFrac - T0 < 1.0 || sum('sites') < 20 || (b.me.progress.built ?? 0) > 0 || money() < 1500)) return;
    const ft = freeTile(); if (!ft) return;
    b.build('handyman', [ft]);
    await b.sleep(300);
    yardPlaced = true;
  }
  async function tech() {
    const owned = new Set(b.me.tech as string[]);
    // Electrification once Masonry is in: before that nothing needs power, and day one plays exactly as it did
    const ts = ready().filter((t) => BUY.has(t.id) && !(LATE.has(t.id) && b.day < 6) && (t.id !== 'ut1' || owned.has('con1'))).sort((a, c) => ORDER.indexOf(a.id) - ORDER.indexOf(c.id));
    for (const t of ts) {
      if (money() - t.cost < 700) continue;
      b.send({ t: 'unlock', id: t.id } as ClientMsg);
      await b.sleep(200);
      note(`unlocked ${t.id} $${t.cost}`);
    }
  }
  const rankWants = (id: string) => {
    const r = b.rank; if (!r || !RANKS[r.rank + 1]) return false;
    return rankNeeds(r.rank + 1, true).some((q, i) => q.id === id && (r.have[i] ?? 0) < q.target);
  };
  async function services() {
    const owned = new Set(b.me.tech as string[]);
    for (const [tid, tool, cost] of [['civ1', 'policebox', 150], ['civ1', 'firepost', 220], ['cul1', 'library', 450]] as const) {
      if (!owned.has(tid) || placed.has(tool)) continue;
      if (money() < cost + ((b.goals?.active === 'cover' || rankWants('cover')) && tid === 'civ1' ? 150 : 1200)) continue;
      const ft = freeTile(); if (!ft) continue;
      b.build(tool, [ft]);
      await b.sleep(300);
      placed.add(tool);
      note(tool);
    }
    if (!placed.has('park') && ((b.me.progress.housed ?? 0) >= 40 || b.goals?.active === 'leisure') && money() > 300) {
      const ft = freeTile();
      if (ft) { b.build('citypark', [ft]); await b.sleep(300); placed.add('park'); note('park'); }
    }
  }
  // power (docs/utilities.md section 3.4): two-storey buildings need a substation, so once Masonry and Electrification are
  // in, a substation by each zoned block's connector road (x0), on a middle row: from there its supply runs down the
  // connector and along all three streets. One a game hour while there is money; a lot already there is bulldozed first,
  // as a player would. The grid feeds them from the gate.
  const powered = new Set<Block>();
  async function power() {
    if (!withPower || !(b.me.tech as string[]).includes('ut1') || !(b.me.tech as string[]).includes('con1') || money() < 900 + 700) return;
    for (const blk of blocks) {
      if (!blk.bought || powered.has(blk) || !blk.rows.some((r) => r.zone && r.zone !== 'svc')) continue;
      powered.add(blk);
      for (const rel of [3, 5, 2, 6]) {
        const x = blk.x0 + 1, y = blk.y0 + rel, t = b.tile(x, y);
        if (t === undefined || isRoad(t)) continue;
        const row = blk.rows.find((r) => r.y === y);
        if (row?.zone === 'svc' && zoneOf(t) !== 0) continue; // a service stands there already
        b.pendingToasts.length = 0;
        if (zoneOf(t) !== 0) { b.build('bulldoze', [[x, y]]); await b.sleep(200); }
        b.build('substation', [[x, y]]); await b.sleep(300);
        if (b.pendingToasts.some((q) => q.kind === 'error')) continue;
        note(`substation at (${x}, ${y})`);
        return;
      }
    }
  }
  let lineTried = 0;
  async function busLine() {
    if (lineTried >= 3 || !(b.me.tech as string[]).includes('tr5') || money() < 600) return;
    lineTried++;
    const stops: { x: number; y: number }[] = [];
    for (let i = 0; i < 2; i++) {
      const ft = freeTile(); if (!ft) return;
      b.pendingToasts.length = 0;
      b.build('busstop', [ft]); await b.sleep(300);
      if (b.pendingToasts.some((t) => t.kind === 'error')) continue;
      stops.push({ x: ft[0], y: ft[1] });
    }
    if (stops.length < 2) return;
    b.pendingToasts.length = 0;
    b.send({ t: 'line', op: 'save', line: { stops, loop: false, vehicles: 1, number: 1, colour: 0xff8800 } } as ClientMsg); await b.sleep(400);
    if (b.pendingToasts.some((t) => /saved/.test(t.msg))) lineTried = 99;
  }
  let campAt: [number, number] | null = null;
  async function camp() {
    if (campAt) return;
    await b.until(() => b.goals?.active === 'camp', 6000).catch(() => {});
    if (b.goals?.active !== 'camp') return;
    for (const x of [X0 + 2, X0 + 5, X0 + 8]) {
      const door: [number, number] = [x, blocks[0].roadRows[0] + 1];
      const before = money();
      b.build('camp', [door]);
      await b.sleep(600);
      if (money() < before) { campAt = door; return; }
    }
  }

  // ---- the game hours
  const hourly: number[] = [];
  for (let step = 0; minOf(b.day + b.dayFrac - T0) < minutes; step++) {
    b.pendingToasts.length = 0;
    if (step === 0) {
      await buyBlock();
      await b.sleep(300);
      await camp();
      for (const r of blocks[0].rows) { b.build('res', b.rect(X0 + 1, r.y, W - 1, 1)); r.zone = 'res'; }
      await b.sleep(500);
    } else {
      if (!campAt && b.goals?.active === 'camp') await camp();
      await services();
      await yard();
      await tech();
      await power();
      await busLine();
      if (blocks.filter((k) => k.bought).every((k) => k.rows.every((r) => r.zone))) await buyBlock();
      await zoneNext();
    }
    await b.sleep(250);
    await b.waitGame((Math.floor((b.day + b.dayFrac) * 24 + 1e-9) + 1) / 24);
    hourly.push(Math.round(money()));
  }
  const ups: number[] = [];
  for (const u of b.rankUps) { ups[u.rank - 1] = minOf(u.t - T0); log?.(ups[u.rank - 1], `rank ${u.rank} +$${u.grant}`); }
  for (const g of b.done) log?.(minOf(g.t - T0), `goal ${g.id} done`);
  return {
    ups, low: Math.round(low.v), lowAt: low.at, hourly, residents: b.me.progress.housed ?? 0,
    goals: b.done.map((g) => ({ min: minOf(g.t - T0), id: g.id })), hints: b.hints.map((h) => ({ min: minOf(h.t - T0), id: h.id })),
  };
}
