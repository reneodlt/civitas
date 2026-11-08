import { Group, InstancedMesh, Matrix4, Vector3, Color, type Camera } from 'three';
import { hash2, leisureAt, isOpenAt } from '@msimcity/shared';
import { vehicleMaterial, sceneUniforms } from './materials';
import { motion } from './motionGate';
import { RIGS, type Rig } from './leisureRigs';

/**
 * The leisure places' moving parts (docs/leisure.md section 9): karts round a track, a carousel turning, swings
 * swinging. The kit draws each place still (buildings/attraction-models-*.ts); this pass draws what moves, the way the
 * Ferris wheel pass does (render/wheels.ts): every moving part is an instance of a small geometry shared by every place
 * of its kind, so all the karts on all the tracks in range are one draw call. A rig (render/leisureRigs.ts) says which
 * kind and design it moves, what its props are, and where each instance goes this frame in the recipe's own frame; the
 * building's matrix takes it into the world.
 *
 * What moves depends on who is there: the server sends how many guests each place has (ServerMsg 'venues', with the
 * stats), so a track runs more karts as the crowd grows and nothing moves at a shut or empty place. Each place eases its
 * activity over a few seconds so parts never pop in and out. Without a guest count (an older server, the viewer), an
 * open place is taken as half full.
 *
 * The switch (render/motionGate.ts, shared with the fires): the pass costs nothing when nothing is in range, and it turns
 * itself down when the frame rate drops. `level` 2 moves everything every frame; 1 updates every other frame over a
 * shorter range; 0 freezes the parts where they are (no updates, the draws stay). It falls a level when the smoothed frame
 * time passes 30 ms, two past 45, and climbs back under 20, re-judged once a second; `?anim=0|1|2` pins it. Zooming out needs no rule: a place more than
 * the rig's range (tens of tiles) from every camera is neither updated nor drawn, so a wide view of the town has none of
 * this cost at all.
 *
 * Organic rule: every place has its own seed (its door tile), so its karts carry their own colours, speeds and spacing,
 * and its clock runs a few per cent off its neighbours'; two tracks are never in step.
 */
const MAX_PLACES = 32;

export interface Place {
  kind: number; design: number; level: number;
  doorX: number; doorY: number; key: string;
  matrix: Matrix4; centre: Vector3;
  rig: Rig;
}
interface State {
  /** activity 0-1, eased toward the place's target (open and how full); the rig scales what moves by it */
  act: number;
  /** the place's own clock, seconds, advanced while it is in range */
  t: number;
  /** its clock's pace against wall time */
  pace: number;
  seed: number;
}
/** What a rig is told about a place each frame (docs/leisure.md section 9). */
export interface PlaceFrame {
  /** the place's clock (seconds) and this update's step */
  t: number; dt: number;
  /** eased activity 0-1: 0 shut or empty, 1 full */
  act: number;
  /** guests there now (0 when the server has not said), and the place's visitor capacity */
  guests: number; capacity: number;
  /** open now, by its hours */
  open: boolean;
  seed: number;
  /** the switch level this frame (1 asks the rig for fewer parts) */
  level: number;
}
/** Place one instance of prop `i` at `local` (the recipe's frame), tinted `colour` (hex; white keeps the geometry's own). */
export type Put = (i: number, local: Matrix4, colour?: number) => void;

interface Slot { rig: Rig; meshes: InstancedMesh[]; counts: number[] }

const TMP = new Vector3();

export class LeisureAnims {
  readonly group = new Group();
  /** the switch (render/motionGate.ts, shared with the fires): 2 everything moves, 1 half rate and shorter range, 0 frozen */
  get level() { return motion.level; }
  get pinned() { return motion.pinned; }
  /** places in range last update and the last update's cost in ms, for the perf readout */
  inRange = 0; lastMs = 0;
  private perChunk = new Map<string, Place[]>();
  private state = new Map<string, State>();
  private slots: Slot[] = [];
  private guests = new Map<string, number>();
  private guestsKnown = false;
  private last = performance.now();
  private frames = 0; private carry = 0;
  private dirty = false;
  private m = new Matrix4(); private col = new Color();
  /** the place and slot `put` writes for, this frame */
  private cur: { slot: Slot; place: Place } | null = null;
  private put: Put = (i, local, colour = 0xffffff) => {
    const c = this.cur;
    if (!c) return;
    const k = c.slot.counts[i], im = c.slot.meshes[i];
    if (k >= im.instanceMatrix.count) return;
    this.m.multiplyMatrices(c.place.matrix, local);
    im.setMatrixAt(k, this.m);
    im.setColorAt(k, this.col.setHex(colour));
    c.slot.counts[i] = k + 1;
  };

  constructor() {
    const mat = vehicleMaterial();
    for (const rig of RIGS) {
      const meshes = rig.props.map((g, i) => {
        const im = new InstancedMesh(g, mat, MAX_PLACES * rig.perPlace[i]);
        im.count = 0; im.frustumCulled = false; im.castShadow = rig.shadows ?? false; im.receiveShadow = false;
        for (let k = 0; k < im.instanceMatrix.count; k++) im.setColorAt(k, this.col.setHex(0xffffff));
        this.group.add(im);
        return im;
      });
      this.slots.push({ rig, meshes, counts: rig.props.map(() => 0) });
    }
    this.group.visible = false;
  }

  /** One chunk's buildings were (re)placed: keep the places a rig moves (built ones: a site's rising shell has no sign). */
  setChunk(key: string, items: { key: string; matrix: Matrix4; sign?: unknown; ad?: [number, number, number] }[]) {
    const list: Place[] = [];
    for (const it of items) {
      if (!it.sign || !it.ad) continue;
      const parts = it.key.split(':');
      if (parts.length < 3) continue;
      const kind = Number(parts[0]), level = Number(parts[1]) || 1, design = Number(parts[2]) || 0;
      const rig = RIGS.find((r) => r.kind === kind && (r.design === undefined || r.design === design));
      if (!rig) continue;
      const centre = new Vector3(0, 0, 0).applyMatrix4(it.matrix);
      list.push({ kind, design, level, doorX: it.ad[0], doorY: it.ad[1], key: `${it.ad[0]},${it.ad[1]}`, matrix: it.matrix, centre, rig });
    }
    if (list.length) this.perChunk.set(key, list); else this.perChunk.delete(key);
    this.dirty = true;
  }
  clear(key: string) { if (this.perChunk.delete(key)) this.dirty = true; }
  /** how many animated places stand in the loaded chunks */
  count(): number { let n = 0; for (const l of this.perChunk.values()) n += l.length; return n; }

  /** The server's guest counts: flat [x, y, guests, ...] for every place with someone there (ServerMsg 'venues'). */
  setGuests(v: number[]) {
    this.guests.clear();
    for (let i = 0; i + 2 < v.length; i += 3) this.guests.set(`${v[i]},${v[i + 1]}`, v[i + 2]);
    this.guestsKnown = true;
  }
  /** `?anim=0|1|2` pins the switch; null lets it adapt again */
  pin(level: number | null) { motion.pin(level); }

  private stateOf(p: Place): State {
    let st = this.state.get(p.key);
    if (!st) {
      const seed = hash2(p.doorX * 31 + 3, p.doorY * 17 + 9);
      st = { act: 0, t: seed * 1000, pace: 0.96 + 0.08 * hash2(p.doorX * 7 + 1, p.doorY * 5 + 2), seed };
      this.state.set(p.key, st);
    }
    return st;
  }

  frame(cams: readonly Camera[], visible = true) {
    const t0 = performance.now();
    this.frames++;
    const dt = Math.min(0.1, (t0 - this.last) / 1000);
    this.last = t0;
    motion.judge(t0, dt);
    if (!visible || !this.perChunk.size || !cams.length) { this.group.visible = false; this.inRange = 0; this.lastMs = 0; this.carry = 0; return; }
    this.carry += dt;
    // frozen: the parts stay where they are, unless a chunk came or went (then one pass places them without moving)
    if (this.level === 0 && !this.dirty) { this.lastMs = 0; return; }
    if (this.level === 1 && (this.frames & 1) && !this.dirty) return;
    const step = this.level === 0 ? 0 : this.carry;
    this.carry = 0;
    this.dirty = false;
    const hour = sceneUniforms.uHour.value;
    let n = 0;
    for (const s of this.slots) s.counts.fill(0);
    for (const list of this.perChunk.values()) for (const p of list) {
      const slot = this.slots[RIGS.indexOf(p.rig)];
      const range = p.rig.range * (this.level === 1 ? 0.75 : 1), r2 = range * range;
      let near = false;
      for (const c of cams) if (c.position.distanceToSquared(p.centre) < r2) { near = true; break; }
      if (!near || n >= MAX_PLACES) continue;
      n++;
      const st = this.stateOf(p);
      const sp = leisureAt(p.kind, p.level, p.doorX, p.doorY);
      const open = !sp || isOpenAt(sp, hour, p.doorX, p.doorY);
      const capacity = sp?.capacity ?? 20;
      const guests = this.guests.get(p.key) ?? 0;
      const target = !open ? 0 : this.guestsKnown ? Math.min(1, guests / Math.max(1, capacity)) : 0.5;
      const sdt = step * st.pace;
      st.act += (target - st.act) * Math.min(1, sdt / 4);
      if (st.act < 0.002 && target === 0) st.act = 0;
      st.t += sdt;
      const pf: PlaceFrame = { t: st.t, dt: sdt, act: st.act, guests: this.guestsKnown ? guests : -1, capacity, open, seed: st.seed, level: this.level };
      this.cur = { slot, place: p };
      p.rig.frame(pf, this.put);
    }
    this.cur = null;
    let any = false;
    for (const s of this.slots) s.meshes.forEach((im, i) => {
      im.count = s.counts[i];
      if (im.count) { any = true; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
    });
    this.inRange = n;
    this.group.visible = any;
    this.lastMs = performance.now() - t0;
  }
}
