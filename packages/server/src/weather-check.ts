/**
 * `npm run weather:check` (docs/weather.md W1): the pure weather model in shared/src/weather.ts over several seeds and six
 * years of game hours: determinism (cold and warm caches, out-of-order ticks), the wind rose, rain share, temperature by
 * season, snow only in the cold, the length of systems and the cost of a call.
 *
 *   npx tsx packages/server/src/weather-check.ts
 */
import { TICKS_PER_DAY, TICKS_PER_HOUR, climateOf, weatherAt, seasonOf, dayForecast } from '@msimcity/shared';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const f2 = (v: number) => v.toFixed(2);

const SEEDS = [1, 7, 42, 1234, 20260101, 987654321, 3000000000, 55];
const YEAR_HOURS = 24 * 7, HOURS = YEAR_HOURS * 6;
const at = (seed: number, h: number) => weatherAt(seed, h * TICKS_PER_HOUR);

// ---- determinism: a first run, a repeat, reversed and strided orders, and after the seed cache evicted the world
{
  const ticks: number[] = [];
  for (let h = 0; h < YEAR_HOURS * 2; h += 3) ticks.push(h * TICKS_PER_HOUR + (h % 7) * 11);
  const run = (seed: number) => ticks.map((t) => JSON.stringify(weatherAt(seed, t)));
  let same = true;
  for (const seed of SEEDS) {
    const a = run(seed), b = run(seed);
    if (a.some((v, i) => v !== b[i])) same = false;
    for (let i = ticks.length - 1; i >= 0; i--) if (JSON.stringify(weatherAt(seed, ticks[i])) !== a[i]) same = false;
    for (let k = 0; k < ticks.length; k++) { const i = (k * 37) % ticks.length; if (JSON.stringify(weatherAt(seed, ticks[i])) !== a[i]) same = false; }
    if (JSON.stringify(weatherAt(seed + 1, ticks[40])) === a[40]) same = false; // neighbouring seeds differ
  }
  ok(same, `deterministic: ${SEEDS.length} seeds x ${ticks.length} ticks: repeat, reverse and strided orders agree, neighbouring seeds differ`);
  const a = run(42);
  for (let s = 100; s < 120; s++) weatherAt(s, 5000); // evict seed 42's state
  ok(run(42).every((v, i) => v === a[i]), 'deterministic after the seed cache evicted the world (cache-cold)');
  ok(JSON.stringify(climateOf(42)) === JSON.stringify(climateOf(42)), 'the climate repeats');
}

// ---- seasons
{
  const wk = TICKS_PER_DAY * 7;
  ok(seasonOf(0).name === 'spring' && seasonOf(0).phase === 0, 'the year starts in spring at phase 0');
  ok(seasonOf(wk * 0.3).name === 'summer' && seasonOf(wk * 0.6).name === 'autumn' && seasonOf(wk * 0.9).name === 'winter' && seasonOf(wk * 1.1).name === 'spring', 'one cycle a game week');
}

// ---- per seed
console.log('\nseed        wetness rain%  prevails(dx,dy)  roseMax  meanT  spring summer autumn winter  tempLo..Hi    snow%  storm%  coverMax');
for (const seed of SEEDS) {
  const t0 = performance.now();
  const clim = climateOf(seed);
  const roseMs = performance.now() - t0;
  const sum = clim.rose.reduce((a, r) => a + r.share, 0);
  ok(clim.rose.length === 16 && Math.abs(sum - 1) < 1e-9, `seed ${seed}: 16 rose bins, shares sum to ${sum.toFixed(6)} (${roseMs.toFixed(1)} ms cold)`);
  const best = clim.rose.reduce((b, r, i) => (r.share > clim.rose[b].share ? i : b), 0);
  ok(Math.abs(clim.rose[best].dx - clim.prevailing.dx) < 1e-9 && Math.abs(clim.rose[best].dy - clim.prevailing.dy) < 1e-9, `seed ${seed}: the prevailing wind carries the largest share (${(clim.rose[best].share * 100).toFixed(0)}%)`);
  ok(Math.abs(Math.hypot(clim.prevailing.dx, clim.prevailing.dy) - 1) < 1e-9, `seed ${seed}: prevailing is a unit vector`);

  let wet = 0, snowH = 0, stormH = 0, bad = 0, snowWarm = 0, coverWarm = 0, coverMax = 0, sumT = 0, tLo = 99, tHi = -99;
  const bySeason: Record<string, { n: number; sum: number }> = {};
  for (let h = 0; h < HOURS; h++) {
    const w = at(seed, h);
    if (![w.tempC, w.cloud, w.rain, w.fog, w.snowCover, w.wind.speed, w.wind.gust, w.wind.dir].every(Number.isFinite)) bad++;
    if (w.rain < 0 || w.rain > 1 || w.cloud < 0 || w.cloud > 1 || w.fog < 0 || w.fog > 1 || w.snowCover < 0 || w.snowCover > 1 || w.wind.gust < w.wind.speed) bad++;
    if (Math.abs(Math.hypot(w.wind.dx, w.wind.dy) - 1) > 1e-6) bad++;
    if (w.rain > 0.1) wet++;
    if (w.snow) { snowH++; if (w.tempC >= 1) snowWarm++; }
    if (w.storm) stormH++;
    if (w.snowCover > 0.3 && w.tempC > 8) coverWarm++;
    coverMax = Math.max(coverMax, w.snowCover);
    sumT += w.tempC; tLo = Math.min(tLo, w.tempC); tHi = Math.max(tHi, w.tempC);
    const s = (bySeason[seasonOf(h * TICKS_PER_HOUR).name] ??= { n: 0, sum: 0 });
    s.n++; s.sum += w.tempC;
  }
  const share = wet / HOURS, sn = (k: string) => bySeason[k].sum / bySeason[k].n;
  console.log(`${String(seed).padEnd(11)} ${f2(clim.wetness).padStart(6)}  ${(share * 100).toFixed(0).padStart(4)}%  ${(f2(clim.prevailing.dx) + ',' + f2(clim.prevailing.dy)).padEnd(14)} ${(clim.rose[best].share * 100).toFixed(0).padStart(5)}%  ${f2(sumT / HOURS).padStart(6)} ${f2(sn('spring')).padStart(6)} ${f2(sn('summer')).padStart(6)} ${f2(sn('autumn')).padStart(6)} ${f2(sn('winter')).padStart(6)}  ${tLo.toFixed(1).padStart(5)}..${tHi.toFixed(1).padEnd(5)}  ${(snowH / HOURS * 100).toFixed(1).padStart(4)}%  ${(stormH / HOURS * 100).toFixed(1).padStart(4)}%  ${f2(coverMax)}`);
  ok(bad === 0, `seed ${seed}: every field finite and in range, wind a unit vector, gust >= speed`);
  ok(snowWarm === 0 && coverWarm === 0, `seed ${seed}: snow falls only below 1 C and no deep cover lies on a warm hour`);
  ok(sn('summer') > sn('winter') + clim.swing && sn('winter') < 8 && sn('summer') > 14, `seed ${seed}: summer ${f2(sn('summer'))} C, winter ${f2(sn('winter'))} C (swing ${f2(clim.swing)})`);
  const mid = clim.wetness > 0.45 && clim.wetness < 0.65;
  ok(share > 0.15 && share < 0.6 && (!mid || (share >= 0.25 && share <= 0.5)), `seed ${seed}: ${(share * 100).toFixed(0)}% of hours wet at wetness ${f2(clim.wetness)} (a mid wetness, 0.45-0.65, must give 25-50%)`);
  ok(stormH / HOURS < 0.06, `seed ${seed}: storms are rare (${(stormH / HOURS * 100).toFixed(1)}% of hours)`);
  ok(snowH > 0, `seed ${seed}: it snows in six winters`);
}

// ---- systems: runs of the dominant system type between fronts (same-type neighbours merge into longer runs, so the
// meaningful bounds are the shortest run, which must not flicker, and the mean)
{
  let shortest = 1e9, tot = 0, n = 0, longest = 0;
  const kinds = new Set<string>();
  for (const seed of SEEDS) {
    let prev = '', run = 0;
    for (let h = 24; h < HOURS; h++) {
      const s = at(seed, h).system;
      kinds.add(s);
      if (s === prev) run++;
      else { if (prev) { shortest = Math.min(shortest, run); longest = Math.max(longest, run); tot += run; n++; } prev = s; run = 1; }
    }
  }
  ok(shortest >= 16, `no system flickers: shortest run ${shortest} h, longest ${longest} h (a system is 24-72 h, front blends included)`);
  ok(tot / n > 30 && tot / n < 90, `mean system run ${(tot / n).toFixed(0)} h; kinds seen: ${[...kinds].join(', ')}`);
  ok(kinds.size === 4, 'low, ridge, high and calm all occur');
}

// ---- diurnal curve and daylight
{
  let cold = 0, warm = 0, cn = 0, wn = 0, minLen = 99, maxLen = 0;
  for (let d = 0; d < 7 * 6; d++) for (let hod = 0; hod < 24; hod++) {
    const w = at(42, d * 24 + hod);
    if (hod >= 4 && hod <= 6) { cold += w.tempC; cn++; }
    if (hod >= 14 && hod <= 16) { warm += w.tempC; wn++; }
    const len = w.daylight[1] - w.daylight[0];
    minLen = Math.min(minLen, len); maxLen = Math.max(maxLen, len);
  }
  ok(warm / wn > cold / cn + 3, `afternoons ${f2(warm / wn)} C against dawns ${f2(cold / cn)} C`);
  ok(minLen < 9 && maxLen > 15, `daylight runs ${minLen.toFixed(1)} to ${maxLen.toFixed(1)} h over the year`);
}

// ---- the forecast reads the same model
{
  const days = 7 * 20;
  let bad = 0, wetDays = 0;
  const skies = new Set<string>();
  for (let d = 0; d < days; d++) {
    const f = dayForecast(42, d), temps = [0, 6, 12, 18].map((h) => at(42, d * 24 + h).tempC);
    if (f.hi < f.lo || f.hi + 0.6 < Math.max(...temps) || f.lo - 0.6 > Math.min(...temps) || !/^[NESW]{1,3}$/.test(f.windFrom) || f.wind < 0) bad++;
    if (f.wet) wetDays++;
    skies.add(f.sky);
  }
  ok(bad === 0, `dayForecast agrees with weatherAt over ${days} days; ${(wetDays / days * 100).toFixed(0)}% wet; skies: ${[...skies].join(', ')}`);
  const c = climateOf(42);
  console.log(`seed 42: prevailing towards (${f2(c.prevailing.dx)}, ${f2(c.prevailing.dy)}), day 3 ${JSON.stringify(dayForecast(42, 3))}`);
  console.log(`seed 42 rose (towards, degrees clockwise from north): ${c.rose.map((r, i) => `${i * 22.5}:${(r.share * 100).toFixed(0)}%`).join(' ')}`);
}

// ---- cost
{
  let sink = 0;
  const N = 200000;
  let t0 = performance.now();
  for (let i = 0; i < N; i++) sink += weatherAt(42, 50000 + (i >> 2) * 3).tempC; // the way the game asks: many calls on close ticks
  const warm = (performance.now() - t0) / N * 1000;
  t0 = performance.now();
  const M = 4000;
  for (let i = 0; i < M; i++) sink += weatherAt(900 + (i % 5), (i * 997 + 12345) * TICKS_PER_HOUR).tempC; // a jump to a new hour (and snow day) every call
  const cold = (performance.now() - t0) / M * 1000;
  t0 = performance.now();
  for (let i = 0; i < 5000; i++) sink += weatherAt(77, i * TICKS_PER_HOUR).tempC; // a fresh world played on hour by hour
  const seq = (performance.now() - t0) / 5000 * 1000;
  t0 = performance.now();
  for (let i = 0; i < 2000; i++) sink += dayForecast(42 + (i % 3), 1000 + i).hi;
  const fc = (performance.now() - t0) / 2000 * 1000;
  console.log(`cost: weatherAt ${warm.toFixed(2)} us warm, ${cold.toFixed(1)} us for a jump to a new hour, ${seq.toFixed(1)} us a call playing on hour by hour from a fresh world, dayForecast ${fc.toFixed(1)} us${sink < 0 ? '!' : ''}`);
  ok(warm < 5, `a warm call costs microseconds (${warm.toFixed(2)} us)`);
  ok(seq < 30, `playing on costs ${seq.toFixed(1)} us per game hour`);
  ok(cold < 600, `a cold call is cheap (${cold.toFixed(1)} us)`);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
