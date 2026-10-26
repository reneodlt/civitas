/**
 * Congestion probe (docs/traffic-tuning.md "Congestion"): does the number the congestion overlay is sent agree with how
 * held up the cars on each road tile are?
 *
 *   npx tsx packages/server/src/loadtest/congestion-probe.ts --load SAVE.json [--warm 150] [--span 60] [--json FILE] [--check]
 *   npx tsx packages/server/src/loadtest/congestion-probe.ts [--demo london | --districts 2] [--warm 150] [--span 60]
 *
 * Loads a save (`--load`, a world.json: snapshot.ts) or fills London or a seedCity test city as the other probes do
 * (probe-city.ts), steps `--warm` ticks, then samples `--span` ticks. Per driven tile over the span (Traffic's own
 * per-tick counts, the inputs of endTick): cars on the tile a tick, the share of them held (moving under 30% of free
 * speed, the HUD's "queued"), the share of ticks with a car, and the congestion value (Traffic.congestionAt, what the
 * overlay's byte is made from) at the end of the span, and its mean over the span. It prints the HUD's vehicles, queued and speed; a table of tiles by held share
 * (rows) against congestion value (columns); the twelve busiest standstill tiles; signal approaches; the overlay's lag
 * behind a standstill (ticks from a run of held ticks starting to the value reaching 0.5) and its flicker (the range of
 * a standstill tile's value over the last ten ticks); and how high quiet tiles with a held car go (a lone car at a light). `--check` exits 1 if the acceptance below fails:
 *  - of the tiles held 70%+ of the time with at least 0.8 cars a tick, 90% read 0.6 or more; the twelve busiest 0.75+
 *    (one held under 85% of the time: within 0.1 of its held share, which is what the value measures);
 *  - tiles held under 10% (with a car at least a tick in four) read under 0.2;
 *  - no flicker: no standstill tile held in each of the last ten ticks goes back and forth by 0.1 or more over them
 *    (total movement less net change; their range is printed too, which a jam still forming or easing has, steadily).
 * Deterministic for a given save and arguments.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DEMO_TOWN, isDemoId, type DemoId } from '@msimcity/shared';
import { createGame, type Game } from '../game';
import { worldFromSnapshot } from '../snapshot';
import { seededRandom } from '../demo/seed';
import { probeGame } from './probe-city';

interface Rc { pres: Uint16Array; stop: Uint16Array }
interface TrafficView {
  presKeys: number[]; presRc: Rc[]; presIdx: number[];
  lastVehicles: number; lastQueued: number; lastSpeedPct: number;
  congestionAt(x: number, y: number): number; junctionKind(x: number, y: number): string; degreeOf(x: number, y: number): number;
}
/** `runAt`: the tick the tile's current held run began (-1 none); `done`: its lag is recorded (or it began at 0.5+); `missed`: runs of 25+ ticks that ended under 0.5 */
interface Acc { x: number; y: number; pres: number; stop: number; ticks: number; sum: number; max: number; last: number[]; held10: number; held: boolean; runAt: number; done: boolean; lags: number[]; missed: number }
interface Row { x: number; y: number; carsPerTick: number; held: number; busy: number; cong: number; mean: number; max: number; flicker: number; wobble: number; heldThrough: boolean; signal: boolean }

const unkey = (k: number): [number, number] => [Math.floor(k / 65536) - 0x8000, (k % 65536) - 0x8000];
const HELD_BANDS = ['held 70%+', 'held 40-70%', 'held 10-40%', 'held <10%'] as const;
const heldBand = (h: number) => (h >= 0.7 ? 0 : h >= 0.4 ? 1 : h >= 0.1 ? 2 : 3);
const CONG_BANDS = ['<0.2', '0.2-0.4', '0.4-0.6', '0.6-0.75', '0.75+'] as const;
const congBand = (v: number) => (v < 0.2 ? 0 : v < 0.4 ? 1 : v < 0.6 ? 2 : v < 0.75 ? 3 : 4);
/** back-and-forth movement of a series: its total variation less its net change (0 for one that only rises or falls) */
const wobble = (v: number[]) => { let t = 0; for (let i = 1; i < v.length; i++) t += Math.abs(v[i] - v[i - 1]); return v.length > 1 ? t - Math.abs(v[v.length - 1] - v[0]) : 0; };
const pct = (s: number[], p: number) => (s.length ? [...s].sort((a, b) => a - b)[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN);

async function main(argv: string[]) {
  const arg = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const warm = Number(arg('warm', '150')), span = Number(arg('span', '60'));
  const loadFile = arg('load', ''), json = arg('json', ''), check = argv.includes('--check');
  let game: Game, label: string;
  if (loadFile) {
    Math.random = seededRandom(DEMO_TOWN.seed);
    game = createGame(worldFromSnapshot(JSON.parse(readFileSync(loadFile, 'utf8')))!, { onConnection() {} }, { devTools: false, sandbox: true });
    label = loadFile;
  } else {
    const districts = Number(arg('districts', '0'));
    const d = arg('demo', 'london');
    const demo: DemoId | null = districts ? null : isDemoId(d) ? (d as DemoId) : 'london';
    ({ game, label } = await probeGame(demo, districts));
  }
  const tr = game.sim.traffic as unknown as TrafficView;
  for (let i = 0; i < warm; i++) game.step();

  const acc = new Map<number, Acc>();
  let veh = 0, que = 0, spd = 0;
  for (let i = 0; i < span; i++) {
    game.step();
    veh += tr.lastVehicles; que += tr.lastQueued; spd += tr.lastSpeedPct;
    const seen = new Set<number>();
    for (let j = 0; j < tr.presKeys.length; j++) {
      const k = tr.presKeys[j], rc = tr.presRc[j], ri = tr.presIdx[j];
      let a = acc.get(k);
      if (!a) { const [x, y] = unkey(k); a = { x, y, pres: 0, stop: 0, ticks: 0, sum: 0, max: 0, last: [], held10: 0, held: false, runAt: -1, done: false, lags: [], missed: 0 }; acc.set(k, a); }
      const n = rc.pres[ri], st = rc.stop[ri];
      a.pres += n; a.stop += st; if (n > 0) a.ticks++;
      if (i >= span - 10 && n > 0 && st / n >= 0.7) a.held10++;
      seen.add(k);
      // held this tick: 1.5+ cars on the tile (a queue, not a lone car at a light) and 70%+ of them held
      a.held = n >= 1.5 && st / n >= 0.7;
    }
    for (const [k, a] of acc) {
      if (!seen.has(k)) a.held = false;
      const v = tr.congestionAt(a.x, a.y);
      a.sum += v; if (v > a.max) a.max = v;
      if (i >= span - 10) a.last.push(v);
      // the overlay's lag behind a queue forming: ticks from a held run starting (with the value under 0.5) to 0.5
      if (a.held) {
        if (a.runAt < 0) { a.runAt = i; a.done = v >= 0.5; }
        else if (!a.done && v >= 0.5) { a.lags.push(i - a.runAt); a.done = true; }
      } else if (a.runAt >= 0) {
        if (!a.done && i - a.runAt >= 25) a.missed++;
        a.runAt = -1;
      }
    }
  }
  const rows: Row[] = [];
  const isSignal = (x: number, y: number) => tr.degreeOf(x, y) >= 3 && tr.junctionKind(x, y) === 'signal';
  for (const a of acc.values()) {
    if (a.pres === 0) continue;
    const signal = tr.degreeOf(a.x, a.y) < 3 && (isSignal(a.x + 1, a.y) || isSignal(a.x - 1, a.y) || isSignal(a.x, a.y + 1) || isSignal(a.x, a.y - 1));
    rows.push({
      x: a.x, y: a.y, carsPerTick: a.pres / span, held: a.stop / a.pres, busy: a.ticks / span, cong: tr.congestionAt(a.x, a.y), mean: a.sum / span, max: a.max,
      flicker: a.last.length ? Math.max(...a.last) - Math.min(...a.last) : 0, wobble: wobble(a.last), heldThrough: a.held10 >= 10, signal,
    });
  }
  const V = veh / span, Q = que / span, S = spd / span;
  console.log(`${label}: warm ${warm}, span ${span} ticks`);
  console.log(`vehicles ${V.toFixed(0)}, queued ${Q.toFixed(0)} (${((Q / Math.max(1, V)) * 100).toFixed(0)}%), speed ${(S * 100).toFixed(0)}% of free; ${rows.length} tiles driven`);

  const table = HELD_BANDS.map(() => CONG_BANDS.map(() => 0));
  for (const r of rows) if (r.busy >= 0.25) table[heldBand(r.held)][congBand(r.cong)]++;
  console.log('\ntiles with a car a tick in four or more: rows how held up their cars were over the span, columns the congestion value at the end of the span');
  console.log(`| | ${CONG_BANDS.join(' | ')} | total |`);
  console.log(`| --- | ${CONG_BANDS.map(() => '---').join(' | ')} | --- |`);
  table.forEach((t, i) => console.log(`| ${HELD_BANDS[i]} | ${t.join(' | ')} | ${t.reduce((s, n) => s + n, 0)} |`));

  const still = rows.filter((r) => r.held >= 0.7 && r.carsPerTick >= 0.8);
  const worst = [...still].sort((a, b) => b.carsPerTick - a.carsPerTick || b.held - a.held).slice(0, 12);
  console.log('\nthe busiest standstill tiles (held 70%+, 0.8+ cars a tick): cars a tick, share held, ticks with a car, congestion at the end of the span (its mean over the span)');
  for (const r of worst) console.log(`  ${r.x},${r.y}: ${r.carsPerTick.toFixed(2)} cars, held ${(r.held * 100).toFixed(0)}%, busy ${(r.busy * 100).toFixed(0)}%, cong ${r.cong.toFixed(2)} (mean ${r.mean.toFixed(2)})`);

  const sig = rows.filter((r) => r.signal && r.carsPerTick >= 0.8).sort((a, b) => b.carsPerTick - a.carsPerTick);
  console.log(`\nsignal approaches (a tile next to a signalled junction, 0.8+ cars a tick): ${sig.length}`);
  for (const r of sig.slice(0, 10)) console.log(`  ${r.x},${r.y}: ${r.carsPerTick.toFixed(2)} cars, held ${(r.held * 100).toFixed(0)}%, cong ${r.cong.toFixed(2)}`);

  const lags = [...acc.values()].flatMap((a) => a.lags), missed = [...acc.values()].reduce((s, a) => s + a.missed, 0);
  // flicker: standstill tiles whose cars were held in each of the last ten ticks (a queue moving off on green is not
  // flicker); the range, and the back-and-forth (a jam still forming rises steadily: range, no back-and-forth)
  const through = still.filter((r) => r.heldThrough), fl = through.map((r) => r.flicker), wob = through.map((r) => r.wobble);
  // the busiest: 0.75 or more, or (a tile held under 80% of the time, which the value, a held share, cannot exceed by
  // much) no more than 0.1 under its held share
  const busiestOk = (r: Row) => r.cong >= Math.min(0.75, r.held - 0.1);
  const stillOk = still.filter((r) => r.cong >= 0.6).length;
  const free = rows.filter((r) => r.held < 0.1 && r.busy >= 0.25);
  const freeBad = free.filter((r) => r.cong >= 0.2);
  console.log(`\nstandstill tiles reading 0.6+: ${stillOk} of ${still.length} (${((stillOk / Math.max(1, still.length)) * 100).toFixed(0)}%); the twelve busiest at 0.75+ (or within 0.1 of a held share under 0.85): ${worst.filter(busiestOk).length} of ${worst.length}`);
  console.log(`free tiles (held under 10%) reading 0.2+: ${freeBad.length} of ${free.length}${freeBad.length ? ` (worst ${Math.max(...freeBad.map((r) => r.cong)).toFixed(2)})` : ''}`);
  // a lone car at a red light: quiet tiles (under 0.3 cars a tick) whose cars were held, at their highest over the span
  const quiet = rows.filter((r) => r.carsPerTick < 0.3 && r.held >= 0.5).map((r) => r.max);
  console.log(`quiet tiles (under 0.3 cars a tick, held half the time or more): ${quiet.length}, highest value median ${pct(quiet, 0.5)?.toFixed(2)}, p90 ${pct(quiet, 0.9)?.toFixed(2)}, max ${quiet.length ? Math.max(...quiet).toFixed(2) : '-'}`);
  console.log(`lag: ticks from a held run starting to 0.5, median ${pct(lags, 0.5)}, p90 ${pct(lags, 0.9)}, max ${lags.length ? Math.max(...lags) : NaN} (${lags.length} runs; ${missed} runs of 25+ ticks ended under 0.5; a tick is 0.2 s at normal speed)`);
  console.log(`flicker: on the ${fl.length} standstill tiles held all of the last ten ticks, the value's range over them p90 ${pct(fl, 0.9)?.toFixed(3)}, max ${fl.length ? Math.max(...fl).toFixed(3) : '-'}; back-and-forth max ${wob.length ? Math.max(...wob).toFixed(3) : '-'}`);

  const ok = still.length > 0 && stillOk / still.length >= 0.9 && worst.every(busiestOk) && freeBad.length === 0 && wob.every((f) => f < 0.1);
  if (json) {
    writeFileSync(json, JSON.stringify({ label, warm, span, vehicles: V, queued: Q, speed: S, bands: { held: HELD_BANDS, cong: CONG_BANDS }, table, worst, signal: sig.slice(0, 10), rows, lag: { median: pct(lags, 0.5), p90: pct(lags, 0.9), runs: lags.length, missed }, flicker: { range: fl.length ? Math.max(...fl) : 0, backAndForth: wob.length ? Math.max(...wob) : 0 }, standstill: { n: still.length, ok: stillOk }, free: { n: free.length, over: freeBad.length }, ok }, null, 1));
    console.log(`written ${json}`);
  }
  if (check) console.log(ok ? '\nacceptance: passed' : '\nacceptance: FAILED');
  process.exit(check && !ok ? 1 : 0);
}

main(process.argv.slice(2));
