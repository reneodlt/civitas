/**
 * Traffic probe (docs/search-perf.md, the traffic step): searchprof.ts `--mode tcount | tprof | hash`, in its child
 * process. Fills London (or a seedCity test city) as the other modes do, then runs one more game day.
 *
 *  - `tcount`: every Traffic method of interest wrapped, with calls and self time per window (08:00-09:00, 17:00-18:00,
 *    the whole day), and what the body guard's sweeps came to (no heading, nothing near, cars or walkers gathered, cut
 *    short). The wrappers cost far more than the small methods they time: read the calls, and the self times of the big ones.
 *  - `tprof`: no wrappers; an inspector CPU profile of 08:00-09:00 and of 17:00-18:00 (`--cpu-prof PREFIX` writes
 *    PREFIX-08.cpuprofile and PREFIX-17.cpuprofile), and the tick times.
 *  - `hash`: a fingerprint of the game after the fill and after every tick of the day (every citizen's and vehicle's
 *    position, lane, progress, path node, wait, stuck clock and state; the traffic counters, totals and congestion; the
 *    population, jobs and money), so two builds can be shown to play the same game tick for tick. `--json FILE`.
 *
 * `--client` connects one client after the fill (hello, then a subscription to every chunk), as a browser would over a
 * socket (`--client-at H`: at hour H of the day instead); every frame it is sent is counted and hashed (`wire` in the
 * summary). The network flush is timed per tick either way. `--reload` saves the filled world and loads it again
 * (snapshot.ts) before the day, as a server restart does, and prints a hash of the snapshot's content (`--save FILE`
 * writes it, `--resave FILE` writes the loaded world saved again); `--load FILE` plays the day from a save instead of a fill.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { DEMO_TOWN, TICKS_PER_DAY, TICKS_PER_HOUR, isDemoId, type DemoId } from '@msimcity/shared';
import { Traffic } from '../sim/traffic';
import type { World, Mover } from '../world';
import type { Conn } from '../transport';
import { probeGame } from './probe-city';
import { snapshotOf, worldFromSnapshot } from '../snapshot';
import { createGame, type Game } from '../game';
import { seededRandom } from '../demo/seed';

type Fn = (this: unknown, ...a: unknown[]) => unknown;
interface PfHook { orig: Record<string, Fn>; set: Record<string, (f: Fn) => void> }
const G = globalThis as unknown as { __pfHook?: PfHook };
const DAY = TICKS_PER_DAY, TPH = TICKS_PER_HOUR;

/** timed (calls and self time) */
const TIMED = ['beginTick', 'endTick', 'sweep', 'step', 'enter', 'leave', 'guardSweep', 'canEnter', 'boxConflict', 'forecourtFree', 'roomBeyond',
  'offCrossing', 'ringGiven', 'carBodyAt', 'boxBusy', 'pedInBody', 'carInBody', 'pedNear', 'holderOf', 'queuedBehind', 'carWaitingInto', 'noteWalker',
  'cost', 'congestionAt', 'walkPolyline', 'barrierAhead', 'signalPhase', 'walkSignal', 'crossingsAt', 'noteCrossing', 'laneRoom', 'headingOf', 'posAt', 'posAlong',
  'place', 'push', 'junction', 'degreeOf', 'junctionAux', 'isCrossingAt', 'barrierDownAt', 'crossingClosed', 'stopLine', 'clearAt', 'nextDirOf',
  'flyAt', 'apart', 'filtering', 'turning', 'turnSlow', 'isRoadAt', 'kerbless', 'motionOf', 'turnProgress', 'reversing', 'atHalt', 'turnsAtHalt',
  'laneCount', 'onTile', 'capacityInto', 'inJunctionBox', 'sweepProg', 'pathCost'];

const pct = (s: ArrayLike<number>, p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0);
const sorted = (a: ArrayLike<number>) => Float64Array.from(a).sort();
const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; };

export async function main(argv: string[]) {
  const arg = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const mode = arg('mode', 'tcount');
  const days = Number(arg('days', '1'));
  const districts = Number(arg('districts', '0'));
  const demo: DemoId | null = districts ? null : (isDemoId(arg('demo', 'london')) ? (arg('demo', 'london') as DemoId) : 'london');
  const hook = G.__pfHook;
  if (hook) for (const [n, f] of Object.entries(hook.orig)) hook.set[n](f); // the hook's counters off

  const t0 = performance.now();
  let connect: ((c: Conn) => void) | null = null;
  const source = { onConnection(fn: (c: Conn) => void) { connect = fn; } };
  const loadFile = arg('load', '');
  let label: string, fill: { pop: number; ticks: number }, game: Game;
  if (loadFile) {
    // a save written by --save (by this build or another): no fill, the game from the file
    Math.random = seededRandom(DEMO_TOWN.seed);
    const text = readFileSync(loadFile, 'utf8');
    console.log(`snapshot ${loadFile}: ${text.length} bytes, ${sortedHash(JSON.parse(text))} with its keys sorted`);
    game = createGame(worldFromSnapshot(JSON.parse(text))!, source, { devTools: false, sandbox: true });
    label = `loaded ${loadFile}`; fill = { pop: game.world.citizens.size, ticks: 0 };
  } else {
    const probe = await probeGame(demo, districts, source);
    ({ label, fill, game } = probe);
  }
  const save = (g: Game, file: string) => {
    const text = JSON.stringify(snapshotOf(g.world));
    console.log(`snapshot: ${text.length} bytes, ${sortedHash(JSON.parse(text))} with its keys sorted${file ? `, written to ${file}` : ''}`);
    if (file) writeFileSync(file, text);
    return text;
  };
  if (argv.includes('--reload') || arg('save', '')) {
    // the server's restart: the world saved and loaded again (snapshot.ts), and a new game made round it
    const text = save(game, arg('save', ''));
    if (argv.includes('--reload')) {
      game = createGame(worldFromSnapshot(JSON.parse(text))!, source, { devTools: false, sandbox: true });
      if (arg('resave', '')) save(game, arg('resave', ''));
    }
  }
  const w = game.world;
  console.log(`${label} filled: ${fill.pop} citizens, ${(fill.ticks / DAY).toFixed(2)} days, ${((performance.now() - t0) / 1000).toFixed(0)} s wall, ${process.arch} node ${process.version}, mode ${mode}`);
  console.log(`world: ${w.chunks.size} chunks, ${w.vehicles.size} vehicles, tick ${w.tick}`);
  const traffic = (game.sim as unknown as { traffic: Traffic }).traffic;
  // one client, everything it is sent hashed
  const wire = { frames: 0, bytes: 0, hash: 0x811c9dc5 >>> 0 };
  const join = () => {
    let onMsg: ((d: string) => void) | null = null;
    const conn: Conn = {
      open: true,
      send(d) { wire.frames++; wire.bytes += d.length; let h = wire.hash; for (let i = 0; i < d.length; i++) { h ^= d.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } wire.hash = h; },
      close() {}, onMessage(fn) { onMsg = fn; }, onClose() {},
    };
    if (!connect) throw new Error('no connection source');
    (connect as (c: Conn) => void)(conn);
    onMsg!(JSON.stringify({ t: 'hello', name: 'probe' }));
    onMsg!(JSON.stringify({ t: 'sub', chunks: [...w.chunks.values()].map((c) => [c.cx, c.cy]) }));
    console.log(`client connected at tick ${w.tick}: ${wire.frames} frames, ${wire.bytes} bytes on joining`);
  };
  const joinAt = argv.includes('--client-at') ? Number(arg('client-at', '0')) : argv.includes('--client') ? -1 : -2;
  if (joinAt === -1) join();
  // the network flush's time per tick
  const flushMs = new Float64Array(Math.round(days * DAY));
  let cur = 0; // the tick under way
  const net = game.net as unknown as { flush(): void }, flush = net.flush.bind(net);
  net.flush = () => { const t = performance.now(); flush(); flushMs[cur] += performance.now() - t; };

  const n = Math.round(days * DAY);
  const tick0 = w.tick + 1;
  const hourOf = (i: number) => Math.floor(((tick0 + i) % DAY) / TPH);
  const tickMs = new Float64Array(n);
  const out: Record<string, unknown> = { label, arch: process.arch, node: process.version, mode, fill, tick0, ticks: n };

  // ---- tcount: wrappers ----
  const NM = TIMED.length + 1; // + moveVehicles
  const calls = new Float64Array(n * NM), self = new Float64Array(n * NM);
  const GS = ['calls', 'noHeading', 'nothingNear', 'withPeds', 'withCars', 'cut', 'pedsGathered', 'carsGathered'];
  const gs = new Float64Array(n * GS.length);
  if (mode === 'tcount') {
    const child: number[] = [0];
    const tp = Traffic.prototype as unknown as Record<string, Fn>;
    const wrap = (orig: Fn, idx: number): Fn => function (this: unknown, ...a: unknown[]) {
      child.push(0);
      const t = performance.now();
      try { return orig.apply(this, a); } finally {
        const dt = performance.now() - t, ch = child.pop()!;
        self[cur * NM + idx] += dt - ch; calls[cur * NM + idx]++;
        child[child.length - 1] += dt;
      }
    };
    TIMED.forEach((m, i) => { if (typeof tp[m] !== 'function') throw new Error(`Traffic.${m} is gone`); tp[m] = wrap(tp[m], i); });
    const sp = Object.getPrototypeOf(game.sim) as Record<string, Fn>;
    sp.moveVehicles = wrap(sp.moveVehicles, TIMED.length);
    // what the sweeps came to
    const gsw = tp.guardSweep;
    tp.guardSweep = function (this: unknown, ...a: unknown[]) {
      const t = this as unknown as { gNp: number; gNc: number };
      const m = a[0] as Mover, allowed = a[1] as number;
      const o = cur * GS.length;
      gs[o]++;
      const r = gsw.apply(this, a) as number;
      const peds = t.gNp / 3, cars = t.gNc;
      if (peds === 0 && cars === 0) { if (m.lane < 0 || m.pi < 1 || m.pi * 2 + 1 >= m.path.length) gs[o + 1]++; else gs[o + 2]++; }
      if (peds) gs[o + 3]++;
      if (cars) gs[o + 4]++;
      if (r < allowed) gs[o + 5]++;
      gs[o + 6] += peds; gs[o + 7] += cars;
      return r;
    };
  } else if (mode !== 'tprof' && mode !== 'hash') throw new Error(`unknown --mode ${mode}`);

  // ---- tprof: windowed CPU profiles ----
  const prof = arg('cpu-prof', '');
  let session: Session | null = null;
  const post = <T>(m: string, p?: object) => new Promise<T>((r, j) => session!.post(m, p ?? {}, (err, res) => (err ? j(err) : r(res as T))));
  if (mode === 'tprof' && prof) { session = new Session(); session.connect(); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 200 }); }

  // ---- hash ----
  const hashes: string[] = [];
  const fillHash = mode === 'hash' ? fingerprint(w, traffic) : '';
  if (fillHash) console.log(`fill fingerprint ${fillHash}`);

  const wall0 = performance.now();
  let profiling = false;
  for (let i = 0; i < n; i++) {
    cur = i;
    if (joinAt >= 0 && hourOf(i) === joinAt && (i === 0 || hourOf(i - 1) !== joinAt)) join();
    if (session && (i === 0 || hourOf(i) !== hourOf(i - 1))) {
      const h = hourOf(i);
      if (h === 8 || h === 17) { await post('Profiler.start'); profiling = true; }
      if ((h === 9 || h === 18) && profiling) {
        profiling = false;
        const res = await post<{ profile: unknown }>('Profiler.stop');
        const f = `${prof}-${String(h - 1).padStart(2, '0')}.cpuprofile`;
        writeFileSync(f, JSON.stringify(res.profile));
        console.log(`cpu profile ${f}`);
      }
    }
    const t = performance.now();
    game.step();
    tickMs[i] = performance.now() - t;
    if (mode === 'hash') hashes.push(fingerprint(w, traffic));
  }
  const wallS = (performance.now() - wall0) / 1000;
  let employed = 0;
  for (const c of w.citizens.values()) if (c.job) employed++;
  const end = { tick: w.tick, citizens: w.citizens.size, vehicles: w.vehicles.size, employed, counters: { ...traffic.counters } };
  Object.assign(out, { end, wallS, wire: { ...wire, hash: wire.hash.toString(16) } });
  if (joinAt > -2) console.log(`wire: ${wire.frames} frames, ${wire.bytes} bytes, hash ${wire.hash.toString(16)}`);
  console.log(`after ${days} day(s): ${end.citizens} citizens, ${end.employed} employed, ${end.vehicles} vehicles; day wall ${wallS.toFixed(1)} s`);

  const windows: [string, (i: number) => boolean][] = [['08-09', (i) => hourOf(i) === 8], ['17-18', (i) => hourOf(i) === 17], ['day', () => true]];
  for (const [wn, inWin] of windows) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (inWin(i)) idx.push(i);
    const tm = sorted(idx.map((i) => tickMs[i]));
    const fm = sorted(idx.map((i) => flushMs[i]));
    const win: Record<string, unknown> = { ticks: idx.length, tickMean: mean(tm), tickP50: pct(tm, 0.5), tickP95: pct(tm, 0.95), tickMax: tm[tm.length - 1] ?? 0, flushMean: mean(fm), flushP95: pct(fm, 0.95) };
    console.log(`\n== ${wn}: ${idx.length} ticks, tick mean ${mean(tm).toFixed(2)} ms, p95 ${pct(tm, 0.95).toFixed(2)} ms; flush ${mean(fm).toFixed(2)} ms`);
    if (mode === 'tcount') {
      const per: Record<string, { calls: number; selfMs: number; usPerCall: number }> = {};
      let trafficSelf = 0;
      const names = [...TIMED, 'moveVehicles'];
      for (let k = 0; k < NM; k++) {
        let c = 0, s = 0;
        for (const i of idx) { c += calls[i * NM + k]; s += self[i * NM + k]; }
        per[names[k]] = { calls: c / idx.length, selfMs: s / idx.length, usPerCall: c ? (s / c) * 1000 : 0 };
        trafficSelf += s / idx.length;
      }
      const g: Record<string, number> = {};
      GS.forEach((name, k) => { let s = 0; for (const i of idx) s += gs[i * GS.length + k]; g[name] = s / idx.length; });
      Object.assign(win, { per, trafficSelf, guard: g });
      console.log(`traffic + moveVehicles self (wrapped): ${trafficSelf.toFixed(2)} ms a tick`);
      console.log('method              calls/tick   self ms/tick   us/call');
      for (const [m, r] of Object.entries(per).sort((a, b) => b[1].selfMs - a[1].selfMs)) if (r.calls) console.log(`${m.padEnd(18)} ${r.calls.toFixed(0).padStart(10)} ${r.selfMs.toFixed(3).padStart(12)} ${r.usPerCall.toFixed(3).padStart(9)}`);
      console.log(`guardSweep a tick: ${GS.map((name) => `${name} ${g[name].toFixed(0)}`).join(', ')}`);
    }
    out[wn] = win;
  }
  if (mode === 'hash') { out.fillHash = fillHash; out.hashes = hashes; out.endHash = hashes[hashes.length - 1]; console.log(`end fingerprint ${out.endHash}`); }
  const json = arg('json', '');
  if (json) { writeFileSync(json, JSON.stringify(out, null, 1)); console.log(`summary: ${json}`); }
  process.exit(0);
}

/** FNV-1a of a JSON value written with every object's keys in sorted order (so the same content, whatever the key order). */
function sortedHash(v: unknown): string {
  const canon = (x: unknown): unknown => Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])])) : x;
  const s = JSON.stringify(canon(v));
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** FNV-1a over 32-bit words: every float by its bits. */
function fingerprint(w: World, traffic: Traffic): string {
  const f = new Float64Array(1), u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5 >>> 0;
  const word = (x: number) => { h ^= x >>> 0; h = Math.imul(h, 0x01000193) >>> 0; };
  const num = (x: number) => { f[0] = x; word(u[0]); word(u[1]); };
  const str = (s: string) => { for (let i = 0; i < s.length; i++) word(s.charCodeAt(i)); };
  const mover = (m: Mover) => {
    num(m.id); num(m.x); num(m.y); num(m.lane); num(m.prog); num(m.pi); num(m.wait); num(m.stuck); word(m.committed ? 1 : 0);
    num(m.path.length); num(m.inDir); num(m.pp); num(m.rerouted); num(m.trail.length);
  };
  num(w.tick); num(w.citizens.size); num(w.vehicles.size);
  for (const c of w.citizens.values()) {
    mover(c);
    const x = c as unknown as { state?: unknown; job?: unknown; money?: number; home?: unknown };
    str(String(x.state)); word(x.job ? 1 : 0); if (typeof x.money === 'number') num(x.money);
  }
  for (const v of w.vehicles.values()) { mover(v); str(String((v as unknown as { phase?: string }).phase)); }
  const t = traffic as unknown as { cong: Map<number, { s: number; n: number; at: number }>; dirty: Set<number> };
  for (const [k, c] of t.cong) { num(k); num(c.s); num(c.n); num(c.at); }
  for (const [k, v] of Object.entries(traffic.counters)) { str(k); num(v); }
  num(traffic.lastVehicles); num(traffic.lastQueued); num(traffic.lastSpeedPct); num(t.dirty.size);
  for (const p of w.players.values()) num((p as unknown as { money: number }).money);
  return h.toString(16).padStart(8, '0');
}
