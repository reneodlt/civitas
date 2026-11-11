import type { WebGLRenderer } from 'three';
import type { NetClient } from '../net';
import type { AudioEvent } from '../audio/engine';

/** The server's tick budget: one tick interval (TICK_MS), and the average the loop should stay under. */
const BUDGET_MS = 200, AMBER_MS = 50;
/** a frame over LONG_FRAME_MS is a dropped frame at 60 Hz; over SLOW_MS it reads as a stutter; over BAD_MS as a freeze */
const LONG_FRAME_MS = 20, SLOW_MS = 33, BAD_MS = 50;

/** The phases of the client frame, in the order main.ts laps them (`PerfHud.lap`). */
export const FRAME_PHASES = [
  'input',    // input, the tour's and the flights' camera, the rig
  'light',    // quality, lighting, fog, the underground view
  'weather',  // the weather state, particles' uniforms and the chip (render/weather.ts)
  'chunks',   // dirty chunks rebuilt (chunkView, roads, lights, parks, junctions, bridges, landmarks, power)
  'world',    // parcels, traffic field, overlays, issue bubbles, fires, graves
  'agents',   // citizens and vehicles interpolated and placed (citizens.frame), lines, the route view, the signals
  'vehicles', // planes, helicopters, boats, trains, the tools' previews, power, parks, landmarks, fireworks, bridges, the first-person view
  'audio',    // the ambient mix's 250 ms tick and the ridden vehicle's sound
  'hover',    // the hover footprint, the buy rectangle, the status line
  'lod',      // building detail tiers and culling, road geometry near the cameras
  'render',   // the TV feed, the first-person pass and the main renderer.render (CPU side; the GPU runs on)
] as const;
export type FramePhase = (typeof FRAME_PHASES)[number];
const NP = FRAME_PHASES.length;
const PIDX: Record<string, number> = Object.fromEntries(FRAME_PHASES.map((p, i) => [p, i]));
/** the causes a frame's time is split into: the phases, the network handlers between frames (JSON.parse and the message handlers, on the main
 *  thread), and everything else (the browser: compositing, layout, GC, other handlers, idle) */
export const CAUSES = [...FRAME_PHASES, 'net', 'outside'] as const;
export type Cause = (typeof CAUSES)[number];

export interface PerfSources {
  net: NetClient;
  renderer: WebGLRenderer;
  /** agents currently drawn (citizens.count) */
  agentsDrawn: () => number;
  chunksLoaded: () => number;
  /** the audio engine's cost and log, for the sound line, the trace and the jitter finder (client/src/audio) */
  audio?: () => { tickMs: number; maxMs: number; voices: number; started: boolean; muted: boolean; events?: AudioEvent[]; ticks?: () => { at: number; ms: number }[] };
  /** where the server's /api/perf is (with ?demo= or ?city= for a child world); null when there is none (local mode) */
  perfUrl?: () => string | null;
  /** the chunk rebuild counters since the page opened (render/chunkWork.ts, world.ts DirtyStats): dirty marks by cause, rebuilds and their ms, chunks waiting */
  chunks?: () => { marks: Record<string, number>; rebuilds: number; rebuildMs: number; pending: number };
}

/** one second's chunk rebuild figures (PerfSources.chunks): dirty marks by cause, rebuilds, their ms, chunks waiting at the end */
export interface ChunkSecond { marks: Record<string, number>; rebuilds: number; ms: number; pending: number }

/** one second of the readout: what the frame loop did and what else happened */
export interface Second {
  at: number; fps: number; ms: number; worst: number; over20: number; over33: number; over50: number;
  /** ms per frame in each cause (CAUSES order) */
  causes: number[];
  msgs: number; decodeMs: number; longTasks: number; longWorst: number; measures: number;
  heapUsed?: number; heapTotal?: number;
  calls: number; triangles: number;
  chunks?: ChunkSecond;
}

export interface FrameRecord { at: number; dt: number; phases: number[]; net: number }

export interface JitterReport {
  seconds: number; frames: number; slow: number; worstMs: number; fps: number;
  /** the three causes most often behind a frame over 33 ms: slow frames attributed to each, the excess ms over the cause's median in those frames */
  causes: { cause: Cause; frames: number; excessMs: number; share: number }[];
  server: { statsGaps: number; worstGapMs: number; late: boolean; tick: { avg: number; p95: number; max: number } | null };
  audio: { started: boolean; muted: boolean; ticks: number; tickMedianMs: number; tickWorstMs: number; decodes: number; crossfades: number; slowFramesNearAudio: number; slowFramesNearAudioEvent: number };
  longTasks: { count: number; worstMs: number };
  /** chunk rebuilds over the window (docs/perf.md): a second, their ms a second, dirty marks a second by cause, the most chunks waiting */
  chunks?: { rebuildsPerSecond: number; rebuildMsPerSecond: number; marksPerSecond: Record<string, number>; pendingMax: number };
  verdict: string;
}

const FRAMES = 4096; // the per-frame ring: about a minute at 60 fps
const SECONDS = 60;

/**
 * Performance readout: how the server's 5 Hz tick is coping against its budget, what this client receives
 * (agents streamed, bytes) and the client's frame budget: ms per frame in each phase of the frame loop, the network
 * handlers between frames and what is left to the browser, with long tasks, the frame-time histogram and the JS heap.
 * A plain DOM panel; toggled by the "perf" chip in the top bar or Shift+M (M alone is the sound mute), and forced on in test cities.
 * Server figures come from the optional tickAvg / tickP95 / tickMax fields of the stats message (last minute of
 * ticks, simulation plus network flush); everything else is measured here. `trace(10)` records ten seconds and downloads
 * them (our JSON and a Chrome trace-event JSON for chrome://tracing or Perfetto, with the server's /api/perf embedded);
 * `jitter(10)` names the causes of the frames over 33 ms (docs/perf.md).
 */
export class PerfHud {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private noteEl: HTMLElement;
  private on = false;
  private last = performance.now();
  private prevNow = 0;
  private frames = 0;
  private frameSum = 0;
  private frameWorst = 0;
  private over20 = 0; private over33 = 0; private over50 = 0;
  private rx0 = { bytes: 0, msgs: 0, agents: 0, decodeMs: 0, handlerMs: 0 };
  private tick: { avg: number; p95: number; max: number } | null = null;
  private serverSeen = false;
  /** the last second's figures, for tests and the console (window.msc.perf.readout) */
  readout = { fps: 0, ms: 0, worst: 0, bps: 0, aps: 0, mps: 0, calls: 0, agents: 0, chunks: 0, tick: null as { avg: number; p95: number; max: number } | null, causes: {} as Record<Cause, number>, over20: 0, over50: 0, longTasks: 0 };
  private calls = 0;
  private triangles = 0;
  // the frame under way: lap times
  private lapAt = 0;
  private cur = new Float64Array(NP);
  private curStart = new Float64Array(NP);
  // the per-frame ring: start time, interval to the next frame, phases, net handler ms since the frame before
  private fAt = new Float64Array(FRAMES);
  private fDt = new Float32Array(FRAMES);
  private fPh = new Float32Array(FRAMES * NP);
  private fNet = new Float32Array(FRAMES);
  private fN = 0;
  private secSum = new Float64Array(NP);
  /** the last 60 s, one entry a second */
  readonly seconds: Second[] = [];
  private longTasks: { at: number; ms: number }[] = [];
  private measures = 0;
  private tracing = false;
  private netAtFrame = 0;
  private chunks0: { marks: Record<string, number>; rebuilds: number; rebuildMs: number } | null = null;

  constructor(private src: PerfSources, mount: HTMLElement, private chip: HTMLElement | null, opts: { forceOn?: boolean } = {}) {
    this.el = document.createElement('div');
    this.el.id = 'perf';
    this.el.className = 'hidden';
    this.body = document.createElement('div');
    this.el.appendChild(this.body);
    const bar = document.createElement('div');
    bar.className = 'pbar';
    const btn = (label: string, title: string, f: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.addEventListener('click', f); bar.appendChild(b); };
    btn('trace 10 s', 'Record ten seconds of frame phases, messages, audio and the server\'s /api/perf, then download them (our JSON and a Chrome trace for chrome://tracing or ui.perfetto.dev)', () => void this.trace(10));
    btn('jitter 10 s', 'Watch ten seconds and name the causes of the frames over 33 ms (the full report goes to the console: msc.perf.jitter(10))', () => void this.jitter(10).then((r) => { console.table(r.causes); console.log(r.verdict, r); }));
    this.el.appendChild(bar);
    this.noteEl = document.createElement('div');
    this.noteEl.className = 'pnote';
    this.el.appendChild(this.noteEl);
    mount.appendChild(this.el);
    src.net.tap((m) => {
      if (m.t === 'stats' && m.tickAvg !== undefined) { this.tick = { avg: m.tickAvg, p95: m.tickP95 ?? 0, max: m.tickMax ?? 0 }; this.serverSeen = true; }
    });
    chip?.addEventListener('click', () => this.set(!this.on));
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.set(!this.on);
    });
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) { this.longTasks.push({ at: e.startTime, ms: e.duration }); if (this.longTasks.length > 512) this.longTasks.shift(); } }).observe({ type: 'longtask', buffered: true });
    } catch { /* no Long Tasks API (Safari): the count stays 0 */ }
    try { new PerformanceObserver((list) => { this.measures += list.getEntries().length; }).observe({ type: 'measure' }); } catch { /* none */ }
    this.set(opts.forceOn ?? false);
  }
  private note(text: string) { this.noteEl.textContent = text; }

  get visible() { return this.on; }
  set(on: boolean) {
    this.on = on;
    this.el.classList.toggle('hidden', !on);
    this.chip?.classList.toggle('on', on);
    if (on) { const r = this.readout; this.render({ fps: r.fps, ms: r.ms, worst: r.worst, bps: r.bps, aps: r.aps, mps: r.mps }, this.seconds[this.seconds.length - 1]); }
  }
  toggle() { this.set(!this.on); }

  /** Call once per animation frame, at the top of the frame (the renderer's info still holds the previous frame's draw). */
  frame(now: number) {
    const rx = this.src.net.rx;
    if (this.prevNow) {
      const dt = now - this.prevNow;
      this.frames++; this.frameSum += dt; if (dt > this.frameWorst) this.frameWorst = dt;
      if (dt > LONG_FRAME_MS) this.over20++; if (dt > SLOW_MS) this.over33++; if (dt > BAD_MS) this.over50++;
      // close the previous frame's record: its interval, its phases, and the handler time that ran since it began
      const i = (this.fN - 1) & (FRAMES - 1);
      this.fDt[i] = dt;
      this.fPh.set(this.cur, i * NP);
      const netMs = rx.handlerMs + rx.decodeMs;
      this.fNet[i] = netMs - this.netAtFrame; this.netAtFrame = netMs;
      for (let p = 0; p < NP; p++) this.secSum[p] += this.cur[p];
      if (this.tracing) for (let p = 0; p < NP; p++) if (this.cur[p] > 0.02) try { performance.measure(FRAME_PHASES[p], { start: this.curStart[p], end: this.curStart[p] + this.cur[p] }); } catch { /* an old browser */ }
    } else this.netAtFrame = rx.handlerMs + rx.decodeMs;
    this.prevNow = now;
    this.cur.fill(0);
    this.fAt[this.fN & (FRAMES - 1)] = now;
    this.fN++;
    this.lapAt = performance.now();
    const info = this.src.renderer.info.render;
    this.calls = info.calls; this.triangles = info.triangles;
    const span = now - this.last;
    if (span < 1000) return;
    const rate = {
      fps: this.frames * 1000 / span, ms: this.frames ? this.frameSum / this.frames : 0, worst: this.frameWorst,
      bps: (rx.bytes - this.rx0.bytes) * 1000 / span, aps: (rx.agents - this.rx0.agents) * 1000 / span, mps: (rx.msgs - this.rx0.msgs) * 1000 / span,
    };
    const perFrame = this.frames || 1;
    const causes = Array.from(this.secSum, (v) => v / perFrame);
    causes.push((rx.handlerMs - this.rx0.handlerMs + rx.decodeMs - this.rx0.decodeMs) / perFrame);
    causes.push(Math.max(0, rate.ms - causes.reduce((s, v) => s + v, 0)));
    const lt = this.longTasks.filter((t) => t.at >= this.last);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    const sec: Second = {
      at: now, fps: rate.fps, ms: rate.ms, worst: rate.worst, over20: this.over20, over33: this.over33, over50: this.over50, causes,
      msgs: rx.msgs - this.rx0.msgs, decodeMs: (rx.decodeMs - this.rx0.decodeMs) / perFrame, longTasks: lt.length, longWorst: lt.reduce((m, t) => Math.max(m, t.ms), 0), measures: this.measures,
      ...(mem ? { heapUsed: mem.usedJSHeapSize, heapTotal: mem.totalJSHeapSize } : {}), calls: this.calls, triangles: this.triangles,
      ...(this.src.chunks ? { chunks: this.chunkSecond(span) } : {}),
    };
    this.seconds.push(sec);
    if (this.seconds.length > SECONDS) this.seconds.shift();
    this.rx0 = { bytes: rx.bytes, msgs: rx.msgs, agents: rx.agents, decodeMs: rx.decodeMs, handlerMs: rx.handlerMs };
    this.readout = { ...rate, calls: this.calls, agents: this.src.agentsDrawn(), chunks: this.src.chunksLoaded(), tick: this.tick, causes: Object.fromEntries(CAUSES.map((c, i) => [c, causes[i]])) as Record<Cause, number>, over20: this.over20, over50: this.over50, longTasks: lt.length };
    this.last = now; this.frames = 0; this.frameSum = 0; this.frameWorst = 0; this.over20 = this.over33 = this.over50 = 0; this.secSum.fill(0); this.measures = 0;
    if (this.on) this.render(rate, sec);
  }

  /** this second's chunk rebuild figures, from the counters' change since the last (per second of `span` ms) */
  private chunkSecond(span: number): ChunkSecond {
    const c = this.src.chunks!(), p = this.chunks0 ?? c, per = 1000 / span;
    const marks: Record<string, number> = {};
    for (const k of Object.keys(c.marks)) marks[k] = (c.marks[k] - (p.marks[k] ?? 0)) * per;
    this.chunks0 = { marks: { ...c.marks }, rebuilds: c.rebuilds, rebuildMs: c.rebuildMs };
    return { marks, rebuilds: (c.rebuilds - p.rebuilds) * per, ms: (c.rebuildMs - p.rebuildMs) * per, pending: c.pending };
  }

  /** Attribute the time since the last lap (or the top of the frame) to `phase`; main.ts calls this after each stage of the frame. */
  lap(phase: FramePhase) {
    const t = performance.now(), i = PIDX[phase];
    if (this.cur[i] === 0) this.curStart[i] = this.lapAt;
    this.cur[i] += t - this.lapAt;
    this.lapAt = t;
  }

  private render(r: { fps: number; ms: number; worst: number; bps: number; aps: number; mps: number }, sec?: Second) {
    const cls = (v: number) => (v > BUDGET_MS ? 'bad' : v > AMBER_MS ? 'warn' : '');
    const num = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
    const t = this.tick, a = this.src.audio?.();
    const server = t
      ? `<span class="${cls(t.avg)}">avg <b>${num(t.avg)}</b></span> · <span class="${cls(t.p95)}">p95 <b>${num(t.p95)}</b></span> · <span class="${cls(t.max)}">max <b>${num(t.max)}</b></span> ms <i>of ${BUDGET_MS}</i>`
      : `<i>${this.serverSeen ? '' : 'waiting for the server…'}</i>`;
    const kb = r.bps / 1024;
    const fpsCls = r.fps && r.fps < 20 ? 'bad' : r.fps && r.fps < 40 ? 'warn' : '';
    const row = (k: string, v: string, c = '') => `<div class="prow${c}"><span>${k}</span><span>${v}</span></div>`;
    let budget = '';
    if (sec) {
      const total = sec.ms || 1;
      const rows = CAUSES.map((c, i) => [c, sec.causes[i]] as const).filter(([, v]) => v >= 0.05).sort((x, y) => y[1] - x[1]);
      budget = rows.map(([c, v]) => row(`<i>budget</i> ${c}${c === 'net' ? ` <i>(${sec.msgs} msg, parse ${sec.decodeMs.toFixed(2)})</i>` : ''}`, `<b>${v.toFixed(2)}</b> ms <i>${Math.round((100 * v) / total)}%</i>`, v > 8 ? ' warn' : '')).join('');
    }
    const hist = sec ? `<i>&gt;20 ms</i> ${sec.over20} · <i>&gt;50</i> ${sec.over50} · <i>long tasks</i> ${sec.longTasks}${sec.longWorst ? ` <i>(worst ${sec.longWorst.toFixed(0)})</i>` : ''}` : '';
    const heap = sec?.heapUsed ? row('JS heap', `<b>${(sec.heapUsed / 1048576).toFixed(0)}</b> of ${(sec.heapTotal! / 1048576).toFixed(0)} MB`) : '';
    const since = performance.now() - 60_000;
    const recent = (a?.events ?? []).filter((e) => e.at >= since);
    const decodes = recent.filter((e) => e.kind === 'decode').length, fades = recent.filter((e) => e.kind === 'crossfade' || e.kind === 'bed').length;
    this.body.innerHTML =
      row('server tick, last minute', server) +
      row('stream', `<b>${Math.round(r.aps).toLocaleString()}</b> agents/s · <b>${kb >= 100 ? kb.toFixed(0) : kb.toFixed(1)}</b> KB/s · ${Math.round(r.mps)} msg/s`) +
      row('client', `<span class="${fpsCls}"><b>${r.fps.toFixed(0)}</b> fps · <b>${r.ms.toFixed(1)}</b> ms/frame <i>(worst ${r.worst.toFixed(0)})</i></span>`) +
      (hist ? row('frames this second', hist) : '') +
      budget +
      (sec?.chunks ? row('chunk rebuilds', `<b>${sec.chunks.rebuilds.toFixed(0)}</b>/s · <b>${sec.chunks.ms.toFixed(1)}</b> ms · ${sec.chunks.pending} waiting${marksText(sec.chunks.marks) ? ` · <i>dirty marks/s</i> ${marksText(sec.chunks.marks)}` : ''}`, sec.chunks.ms > 100 ? ' warn' : '') : '') +
      heap +
      row('drawn', `<b>${this.src.agentsDrawn().toLocaleString()}</b> agents · <b>${this.src.chunksLoaded()}</b> chunks · <b>${this.calls.toLocaleString()}</b> draw calls · ${(this.triangles / 1000).toFixed(0)}k tris`) +
      (a ? row('sound', a.started ? (a.muted ? 'muted' : `<b>${a.tickMs.toFixed(2)}</b> ms/tick <i>(p95 ${a.maxMs.toFixed(2)})</i> · <b>${a.voices}</b> voices${decodes || fades ? ` · <i>last minute</i> ${decodes} decodes, ${fades} beds/fades` : ''}`) : 'waiting for a click') : '');
  }

  // ---- the trace -------------------------------------------------------------------------------------------------

  /** the closed per-frame records with a start time in [from, to], oldest first */
  framesBetween(from: number, to: number): FrameRecord[] {
    const out: FrameRecord[] = [];
    const n = Math.min(this.fN - 1, FRAMES - 1); // the newest frame is still open
    for (let k = n; k > 0; k--) {
      const i = (this.fN - 1 - k) & (FRAMES - 1), at = this.fAt[i];
      if (at < from || at > to) continue;
      out.push({ at, dt: this.fDt[i], phases: Array.from(this.fPh.subarray(i * NP, (i + 1) * NP)), net: this.fNet[i] });
    }
    return out;
  }

  /** the handled messages in [from, to] from the net layer's log */
  private messagesBetween(from: number, to: number) {
    const l = this.src.net.log, out: { at: number; ms: number; type: string }[] = [];
    for (let k = Math.min(l.n, 2048); k > 0; k--) { const i = (l.n - k) & 2047; if (l.at[i] >= from && l.at[i] <= to) out.push({ at: l.at[i], ms: l.ms[i], type: l.type[i] }); }
    return out;
  }

  /** Record `seconds` of frames (with performance.measure per phase, so Chrome's own Performance panel shows them too) and download the trace. */
  async trace(seconds = 10): Promise<void> {
    if (this.tracing) return;
    const at = performance.now();
    this.tracing = true;
    this.note(`tracing ${seconds} s…`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const to = performance.now();
    this.tracing = false;
    let server: unknown = null;
    const url = this.src.perfUrl?.();
    if (url) try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); if (r.ok) server = await r.json(); } catch { /* no server snapshot */ }
    const frames = this.framesBetween(at, to), msgs = this.messagesBetween(at, to);
    const a = this.src.audio?.();
    const audio = { events: (a?.events ?? []).filter((e) => e.at >= at - 1000 && e.at <= to), ticks: (a?.ticks?.() ?? []).filter((t) => t.at >= at && t.at <= to) };
    const longTasks = this.longTasks.filter((t) => t.at >= at && t.at <= to);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ours = { version: 1, at: new Date(performance.timeOrigin + at).toISOString(), seconds, url: location.href, ua: navigator.userAgent, phases: FRAME_PHASES, timeOrigin: performance.timeOrigin, frames, messages: msgs, audio, longTasks, lastMinute: this.seconds.slice(), server };
    download(`civitas-trace-${stamp}.json`, JSON.stringify(ours));
    download(`civitas-trace-${stamp}.chrome.json`, JSON.stringify(chromeTrace(frames, msgs, audio, longTasks, server)));
    this.note(`trace saved: ${frames.length} frames, ${msgs.length} messages, ${longTasks.length} long tasks${server ? ', server snapshot' : ''}`);
  }

  // ---- the jitter finder ---------------------------------------------------------------------------------------------

  /** Watch `seconds` and name the top three causes of frames over 33 ms, whether the server's ticks ran late, and whether the audio coincided. */
  async jitter(seconds = 10): Promise<JitterReport> {
    const from = performance.now();
    this.note(`watching ${seconds} s for jitter…`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return this.jitterBetween(from, performance.now(), seconds);
  }

  /** the jitter report over frames already recorded (the last `seconds`, or any window) */
  jitterBetween(from: number, to: number, seconds = (to - from) / 1000): JitterReport {
    const frames = this.framesBetween(from, to);
    const med = (vals: number[]) => { const a = vals.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
    const rows = frames.map(causesOf);
    const medians = CAUSES.map((_, i) => med(rows.map((r) => r[i])));
    const agg = CAUSES.map((cause) => ({ cause, frames: 0, excessMs: 0, share: 0 }));
    const slow = frames.filter((f) => f.dt > SLOW_MS);
    for (const f of slow) {
      const r = causesOf(f);
      let best = -1, bestEx = 0;
      for (let i = 0; i < r.length; i++) { const ex = r[i] - medians[i]; agg[i].excessMs += Math.max(0, ex); if (ex > bestEx) { bestEx = ex; best = i; } }
      if (best >= 0) agg[best].frames++;
    }
    const causes = agg.filter((c) => c.frames > 0 || c.excessMs > 0).sort((x, y) => y.frames - x.frames || y.excessMs - x.excessMs).slice(0, 3)
      .map((c) => ({ ...c, excessMs: Math.round(c.excessMs * 10) / 10, share: slow.length ? Math.round((100 * c.frames) / slow.length) : 0 }));
    // the server: stats come once a second (every 5 ticks); a gap over 1.5 s means its ticks ran late
    const st = this.src.net.statsAt.filter((t) => t >= from - 1000 && t <= to);
    let gaps = 0, worstGap = 0;
    for (let i = 1; i < st.length; i++) { const g = st[i] - st[i - 1]; if (g > worstGap) worstGap = g; if (g > 1500) gaps++; }
    // the audio: its ticks and events near the slow frames
    const a = this.src.audio?.();
    const ticks = (a?.ticks?.() ?? []).filter((t) => t.at >= from && t.at <= to);
    const events = (a?.events ?? []).filter((e) => e.at >= from && e.at <= to);
    const near = (t: number, f: FrameRecord) => t >= f.at - 2 && t <= f.at + f.dt + 2;
    const slowNearAudio = slow.filter((f) => ticks.some((t) => t.ms > 1 && near(t.at, f))).length;
    const slowNearEvent = slow.filter((f) => events.some((e) => e.kind !== 'stop' && e.kind !== 'event' && near(e.at, f))).length;
    const lt = this.longTasks.filter((t) => t.at >= from && t.at <= to);
    const ltWorst = lt.reduce((m, t) => Math.max(m, t.ms), 0);
    const fps = frames.length ? (frames.length * 1000) / (to - from) : 0;
    const worst = frames.reduce((m, f) => Math.max(m, f.dt), 0);
    const top = causes[0];
    // the chunk rebuilds over the window, from the per-second figures
    const cs = this.seconds.filter((s) => s.chunks && s.at > from + 500 && s.at <= to + 500);
    let chunks: JitterReport['chunks'];
    if (cs.length) {
      const marks: Record<string, number> = {};
      for (const s of cs) for (const [k, v] of Object.entries(s.chunks!.marks)) marks[k] = (marks[k] ?? 0) + v / cs.length;
      for (const k of Object.keys(marks)) marks[k] = Math.round(marks[k] * 100) / 100;
      chunks = { rebuildsPerSecond: Math.round((cs.reduce((a, s) => a + s.chunks!.rebuilds, 0) / cs.length) * 10) / 10, rebuildMsPerSecond: Math.round((cs.reduce((a, s) => a + s.chunks!.ms, 0) / cs.length) * 10) / 10, marksPerSecond: marks, pendingMax: cs.reduce((a, s) => Math.max(a, s.chunks!.pending), 0) };
    }
    const chunkLine = chunks ? ` Chunks: ${chunks.rebuildsPerSecond} rebuilds/s (${chunks.rebuildMsPerSecond} ms/s, up to ${chunks.pendingMax} waiting)${marksText(chunks.marksPerSecond) ? `, dirty marks/s ${marksText(chunks.marksPerSecond)}` : ''}.` : '';
    const audioShare = slow.length ? Math.round((100 * (slowNearAudio + slowNearEvent)) / slow.length) : 0;
    const verdict = !slow.length
      ? `No frames over ${SLOW_MS} ms in ${seconds.toFixed(0)} s (${fps.toFixed(0)} fps, worst ${worst.toFixed(0)} ms).${chunkLine}`
      : `${slow.length} of ${frames.length} frames over ${SLOW_MS} ms (worst ${worst.toFixed(0)} ms, ${fps.toFixed(0)} fps). Top cause: ${top.cause} (${top.share}% of slow frames, ${top.excessMs} ms excess)${causes[1] ? `, then ${causes[1].cause} (${causes[1].share}%)` : ''}${causes[2] ? `, ${causes[2].cause} (${causes[2].share}%)` : ''}. Server ticks ${gaps ? `were late (${gaps} stats gaps over 1.5 s, worst ${(worstGap / 1000).toFixed(1)} s)` : 'arrived on time'}. Audio ${a?.started ? (a.muted ? 'muted' : `on: ${slowNearAudio + slowNearEvent} slow frames (${audioShare}%) coincided with an audio tick over 1 ms or a decode/bed change`) : 'never started'}. ${lt.length} long tasks (worst ${ltWorst.toFixed(0)} ms).${chunkLine}`;
    this.note(verdict);
    return {
      seconds, frames: frames.length, slow: slow.length, worstMs: Math.round(worst * 10) / 10, fps: Math.round(fps * 10) / 10, causes,
      server: { statsGaps: gaps, worstGapMs: Math.round(worstGap), late: gaps > 0, tick: this.tick },
      audio: { started: !!a?.started, muted: !!a?.muted, ticks: ticks.length, tickMedianMs: med(ticks.map((t) => t.ms)), tickWorstMs: ticks.reduce((m, t) => Math.max(m, t.ms), 0), decodes: events.filter((e) => e.kind === 'decode').length, crossfades: events.filter((e) => e.kind === 'crossfade').length, slowFramesNearAudio: slowNearAudio, slowFramesNearAudioEvent: slowNearEvent },
      longTasks: { count: lt.length, worstMs: Math.round(ltWorst * 10) / 10 },
      ...(chunks ? { chunks } : {}),
      verdict,
    };
  }

  /** the frame-time distribution over the last `seconds` (up to the ring's minute): for side-by-side runs */
  distribution(seconds = 60): { frames: number; fps: number; mean: number; p50: number; p95: number; p99: number; max: number; over20: number; over33: number; over50: number; causesMean: Record<Cause, number>; longTasks: number } {
    const to = performance.now(), from = to - seconds * 1000, frames = this.framesBetween(from, to);
    const dts = frames.map((f) => f.dt).sort((a, b) => a - b), n = dts.length || 1;
    const q = (p: number) => (dts.length ? dts[Math.min(dts.length - 1, Math.floor(p * dts.length))] : 0);
    const sums = new Array(CAUSES.length).fill(0) as number[];
    for (const f of frames) { const r = causesOf(f); for (let i = 0; i < r.length; i++) sums[i] += r[i]; }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const span = frames.length ? frames[frames.length - 1].at + frames[frames.length - 1].dt - frames[0].at : 0;
    return {
      frames: dts.length, fps: r2(span ? (dts.length * 1000) / span : 0), mean: r2(dts.reduce((s, v) => s + v, 0) / n), p50: r2(q(0.5)), p95: r2(q(0.95)), p99: r2(q(0.99)), max: r2(dts[dts.length - 1] ?? 0),
      over20: dts.filter((v) => v > LONG_FRAME_MS).length, over33: dts.filter((v) => v > SLOW_MS).length, over50: dts.filter((v) => v > BAD_MS).length,
      causesMean: Object.fromEntries(CAUSES.map((c, i) => [c, r2(sums[i] / n)])) as Record<Cause, number>,
      longTasks: this.longTasks.filter((t) => t.at >= from && t.at <= to).length,
    };
  }
}

/** dirty marks a second by cause, the ones over 0.05, largest first: "tiles 10.0, tiles-edge 1.0" */
function marksText(m: Record<string, number>): string {
  return Object.entries(m).filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
}

/** a frame's time split by cause (CAUSES order): its phases, the net handlers before it, and what is left to the browser */
function causesOf(f: FrameRecord): number[] {
  return [...f.phases, f.net, Math.max(0, f.dt - f.phases.reduce((s, v) => s + v, 0) - f.net)];
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** The Chrome trace-event format (X events in µs): the frames and their phases, the messages, the audio ticks and events, long tasks and the server's recent ticks, each on its own track. */
function chromeTrace(frames: FrameRecord[], msgs: { at: number; ms: number; type: string }[], audio: { events: AudioEvent[]; ticks: { at: number; ms: number }[] }, longTasks: { at: number; ms: number }[], server: unknown) {
  type Ev = { name: string; cat: string; ph: 'X' | 'i' | 'M'; ts: number; dur?: number; pid: number; tid: number; args?: Record<string, unknown>; s?: 'g' };
  const ev: Ev[] = [];
  const meta = (tid: number, name: string) => ev.push({ name: 'thread_name', cat: '__metadata', ph: 'M', ts: 0, pid: 1, tid, args: { name } });
  meta(1, 'frame'); meta(2, 'phases'); meta(3, 'messages'); meta(4, 'audio'); meta(5, 'long tasks'); meta(10, 'server tick');
  const us = (ms: number) => Math.round(ms * 1000);
  for (const f of frames) {
    ev.push({ name: 'frame', cat: 'frame', ph: 'X', ts: us(f.at), dur: us(f.dt), pid: 1, tid: 1, args: { ms: f.dt } });
    let t = f.at;
    for (let p = 0; p < NP; p++) { const d = f.phases[p]; if (d > 0.01) { ev.push({ name: FRAME_PHASES[p], cat: 'phase', ph: 'X', ts: us(t), dur: us(d), pid: 1, tid: 2 }); t += d; } }
  }
  for (const m of msgs) ev.push({ name: m.type, cat: 'net', ph: 'X', ts: us(m.at), dur: us(m.ms), pid: 1, tid: 3 });
  for (const t of audio.ticks) ev.push({ name: 'ambience tick', cat: 'audio', ph: 'X', ts: us(t.at), dur: us(t.ms), pid: 1, tid: 4 });
  for (const e of audio.events) ev.push({ name: `${e.kind} ${e.id}`, cat: 'audio', ph: 'i', ts: us(e.at), pid: 1, tid: 4, s: 'g', ...(e.ms !== undefined ? { args: { ms: e.ms } } : {}) });
  for (const l of longTasks) ev.push({ name: 'long task', cat: 'longtask', ph: 'X', ts: us(l.at), dur: us(l.ms), pid: 1, tid: 5 });
  const s = server as { recent?: { ms: number[]; at: number[] } } | null;
  if (s?.recent) for (let i = 0; i < s.recent.ms.length; i++) { const start = s.recent.at[i] - performance.timeOrigin - s.recent.ms[i]; if (start > 0) ev.push({ name: 'tick', cat: 'server', ph: 'X', ts: us(start), dur: us(s.recent.ms[i]), pid: 1, tid: 10 }); }
  return { traceEvents: ev, displayTimeUnit: 'ms' };
}
