/**
 * The switch for everything that moves for show: the leisure places' parts (render/leisureAnims.ts, docs/leisure.md
 * section 9) and the fires' per-frame work (render/fires.ts, docs/incidents.md). `level` 2 moves everything every frame;
 * 1 updates at half rate, over a shorter range and with fewer parts; 0 freezes what is drawn where it is (the draws stay,
 * so nothing pops). It falls a level when the smoothed frame time passes SLOW_MS, to 0 past BAD_MS, and climbs back
 * under FINE_MS, re-judged once a second. `pin` fixes it (`?anim=0|1|2`); null lets it adapt again. One judgement a
 * frame however many passes ask.
 */
const SLOW_MS = 30, BAD_MS = 45, FINE_MS = 20;

export const motion = {
  level: 2,
  pinned: null as number | null,
  /** the smoothed frame time, ms */
  frameMs: 16,
  judgeAt: 0,
  lastNow: -1,
  judge(now: number, dt: number) {
    if (now === this.lastNow) return;
    this.lastNow = now;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    if (this.pinned !== null || now < this.judgeAt) return;
    this.judgeAt = now + 1000;
    if (this.frameMs > BAD_MS) this.level = 0;
    else if (this.frameMs > SLOW_MS) this.level = Math.min(this.level, 1);
    else if (this.frameMs < FINE_MS) this.level = Math.min(2, this.level + 1);
  },
  pin(level: number | null) {
    this.pinned = level === null || Number.isNaN(level) ? null : Math.max(0, Math.min(2, Math.round(level)));
    if (this.pinned !== null) this.level = this.pinned;
  },
};
