import { BoxGeometry, CylinderGeometry, ConeGeometry, Group, InstancedMesh, Matrix4, Quaternion, Vector3, Color, type BufferGeometry, type Camera } from 'three';
import { FERRIS, FUNFAIR_KIND, hash2, leisureAt, isOpenAt, eventOn, eventStartAt } from '@msimcity/shared';
import { Kit } from './kit';
import { vehicleMaterial, sceneUniforms } from './materials';

/**
 * The funfair's Ferris wheel (docs/leisure.md, shared/src/ferris.ts). The building's recipe stands the A-frame legs and the
 * axle; this pass draws what turns: the twin rims, spokes and hub as one instanced wheel, and the gondolas, each hung level
 * from its pivot on the rim, as another. It turns while the fair is open (the funfair's opening hours, from its
 * attributes and the clock) and winds down over a few seconds when it shuts, as a real wheel stops for the night.
 *
 * Organic rule: each wheel has its own phase and a speed within a few per cent of the others, and its gondolas their own
 * colours; no two wheels turn in step.
 *
 * The first-person view rides one gondola (render/leisureRooms.ts, the funfair's scene): `wheelSeat` gives the pivot of a
 * gondola in world tiles and the wheel's turn this frame, and that gondola is left out of the pass while it is ridden, so
 * the rider's own cabin (drawn over the town by the room) is not doubled.
 */
const MAX_WHEELS = 64, RANGE = 220;
const CAB_COLOURS = [0xd94f4f, 0xe6b734, 0x2f8fd6, 0x4f9a5c, 0xd94fa0, 0xe0662e, 0x7a5ad9, 0x2fbfa0];

interface Wheel {
  /** the door tile (the funfair's registered tile), its key, its level */
  doorX: number; doorY: number; key: string; level: number;
  hub: Vector3; yaw: number;
}
interface State { angle: number; speed: number; jitter: number }

/** the wheel in its own frame: axle along +z, hub at the origin, the twin rims either side of the gondolas */
function wheelGeometry(): BufferGeometry {
  const k = new Kit(), R = FERRIS.r, half = FERRIS.cabD / 2 + 0.03, SEG = 40, N = FERRIS.gondolas;
  const WHITE = 0xf2f2ee, STEEL = 0xb8bcc4, HUB = 0x5a5f6a;
  for (const s of [-1, 1]) {
    const z = s * half;
    for (let i = 0; i < SEG; i++) {
      const a = ((i + 0.5) / SEG) * Math.PI * 2, len = (2 * Math.PI * R) / SEG + 0.004;
      k.part(new BoxGeometry(len, 0.035, 0.03).rotateZ(a + Math.PI / 2).translate(R * Math.cos(a), R * Math.sin(a), z), WHITE);
    }
    for (let i = 0; i < N * 2; i++) {
      const a = (i / (N * 2)) * Math.PI * 2;
      k.part(new BoxGeometry(R, 0.014, 0.014).translate(R / 2, 0, 0).rotateZ(a).translate(0, 0, z), i % 2 ? STEEL : WHITE);
    }
  }
  // cross-ties between the rims at every gondola pivot, and the hub drum
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    k.part(new BoxGeometry(0.02, 0.02, half * 2).translate(R * Math.cos(a), R * Math.sin(a), 0), STEEL);
  }
  k.part(new CylinderGeometry(0.1, 0.1, half * 2 + 0.06, 16).rotateX(Math.PI / 2), HUB);
  k.part(new CylinderGeometry(0.05, 0.05, half * 2 + 0.16, 10).rotateX(Math.PI / 2), STEEL);
  const g = k.build();
  g.computeVertexNormals();
  return g;
}
/** a gondola in its own frame: the pivot at the origin, the cabin hanging below it, open sides facing ±z (along the axle) */
function gondolaGeometry(): BufferGeometry {
  const k = new Kit(), w = FERRIS.cabW, d = FERRIS.cabD, h = FERRIS.cabH, y0 = -FERRIS.hang;
  const WHITE = 0xf4f4f0, DARK = 0x3a3e49;
  k.part(new BoxGeometry(0.016, FERRIS.hang - h + 0.02, 0.016).translate(0, y0 + h + (FERRIS.hang - h) / 2, 0), DARK); // the hanger
  k.part(new BoxGeometry(w, 0.03, d).translate(0, y0 + 0.015, 0), 0xffffff); // floor (takes the gondola's colour)
  k.part(new BoxGeometry(w, h * 0.42, 0.012).translate(0, y0 + h * 0.21, d / 2), 0xffffff); // waist-high front and back
  k.part(new BoxGeometry(w, h * 0.42, 0.012).translate(0, y0 + h * 0.21, -d / 2), 0xffffff);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.part(new BoxGeometry(0.012, h, 0.012).translate(sx * (w / 2 - 0.006), y0 + h / 2, sz * (d / 2 - 0.006)), WHITE);
  k.part(new BoxGeometry(0.012, h * 0.9, d).translate(-w / 2 + 0.006, y0 + h * 0.45, 0), WHITE); // the sides along the plane
  k.part(new BoxGeometry(0.012, h * 0.9, d).translate(w / 2 - 0.006, y0 + h * 0.45, 0), WHITE);
  k.part(new ConeGeometry(Math.hypot(w, d) * 0.56, 0.07, 4).rotateY(Math.PI / 4).translate(0, y0 + h + 0.035, 0), 0xffffff); // the roof
  const g = k.build();
  g.computeVertexNormals();
  return g;
}

let active: WheelsView | null = null;
const TMP = new Vector3(), UP = new Vector3(0, 1, 0), Z = new Vector3(0, 0, 1);

/**
 * A gondola on the funfair whose door is (doorX, doorY): its pivot in world tiles and the wheel's yaw (radians about +y,
 * as the building is turned), this frame. Marks that gondola as ridden for the next frame (the pass leaves it out). Null
 * when no such wheel is loaded.
 */
export function wheelSeat(doorX: number, doorY: number, seat: number): { pivot: Vector3; yaw: number; angle: number } | null {
  return active?.seat(doorX, doorY, seat) ?? null;
}

export class WheelsView {
  readonly group = new Group();
  /** wheels in range last frame, and the last frame's cost in ms */
  inRange = 0; lastMs = 0;
  private perChunk = new Map<string, Wheel[]>();
  private state = new Map<string, State>();
  private wheel: InstancedMesh; private cabs: InstancedMesh;
  private last = performance.now();
  private m = new Matrix4(); private q = new Quaternion(); private qa = new Quaternion(); private p = new Vector3(); private one = new Vector3(1, 1, 1);
  private col = new Color();
  private ridden: { key: string; seat: number; frame: number } | null = null;
  private frames = 0;
  /**
   * Fireworks night (the funfair's event, Saturday at 21:00 give or take its own minutes): two shows over each fair in range,
   * a quarter and half an hour of game time after the start (a game hour is twenty seconds). main.ts sets the clock (game
   * day and hour) and where a show goes (render/fireworks.ts); the last show fired per fair is kept so each fires once.
   */
  clock: (() => { day: number; hour: number }) | null = null;
  onShow: ((x: number, y: number, seed: number) => void) | null = null;
  private shown = new Map<string, number>();

  constructor() {
    const mat = vehicleMaterial();
    this.wheel = new InstancedMesh(wheelGeometry(), mat, MAX_WHEELS);
    this.cabs = new InstancedMesh(gondolaGeometry(), mat, MAX_WHEELS * FERRIS.gondolas);
    for (const m of [this.wheel, this.cabs]) { m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = false; this.group.add(m); }
    // instance colours: the gondolas' paint (the wheel stays white)
    for (let i = 0; i < MAX_WHEELS * FERRIS.gondolas; i++) this.cabs.setColorAt(i, this.col.setHex(CAB_COLOURS[i % CAB_COLOURS.length]));
    for (let i = 0; i < MAX_WHEELS; i++) this.wheel.setColorAt(i, this.col.setHex(0xffffff));
    this.group.visible = false;
    active = this;
  }

  /** One chunk's buildings were (re)placed: keep the funfairs among them (built ones: a site's rising shell has no sign). */
  setChunk(key: string, items: { key: string; matrix: Matrix4; sign?: unknown; ad?: [number, number, number] }[]) {
    const list: Wheel[] = [];
    for (const it of items) {
      if (!it.sign || !it.ad || !it.key.startsWith(`${FUNFAIR_KIND}:`)) continue;
      const level = Number(it.key.split(':')[1]) || 1;
      const hub = new Vector3(FERRIS.hubX, FERRIS.hubY, FERRIS.hubZ).applyMatrix4(it.matrix);
      it.matrix.decompose(this.p, this.q, TMP);
      const fwd = Z.clone().applyQuaternion(this.q);
      list.push({ doorX: it.ad[0], doorY: it.ad[1], key: `${it.ad[0]},${it.ad[1]}`, level, hub, yaw: Math.atan2(fwd.x, fwd.z) });
    }
    if (list.length) this.perChunk.set(key, list); else this.perChunk.delete(key);
  }
  clear(key: string) { this.perChunk.delete(key); }
  /** how many wheels stand in the loaded chunks */
  count(): number { let n = 0; for (const l of this.perChunk.values()) n += l.length; return n; }

  private find(doorX: number, doorY: number): Wheel | null {
    for (const l of this.perChunk.values()) for (const w of l) if (w.doorX === doorX && w.doorY === doorY) return w;
    return null;
  }
  private stateOf(w: Wheel): State {
    let st = this.state.get(w.key);
    if (!st) {
      const h = (k: number) => hash2(w.doorX * 29 + k, w.doorY * 13 + 7 + k * 5);
      st = { angle: h(1) * Math.PI * 2, speed: this.open(w) ? 1 : 0, jitter: 0.94 + 0.12 * h(2) };
      this.state.set(w.key, st);
    }
    return st;
  }
  private open(w: Wheel): boolean {
    const sp = leisureAt(FUNFAIR_KIND, w.level, w.doorX, w.doorY);
    return !sp || isOpenAt(sp, sceneUniforms.uHour.value, w.doorX, w.doorY);
  }
  seat(doorX: number, doorY: number, seat: number): { pivot: Vector3; yaw: number; angle: number } | null {
    const w = this.find(doorX, doorY);
    if (!w) return null;
    const st = this.stateOf(w), n = FERRIS.gondolas, s = ((seat % n) + n) % n;
    const phi = st.angle + (s / n) * Math.PI * 2;
    this.ridden = { key: w.key, seat: s, frame: this.frames };
    // the pivot: out along the rim in the wheel's plane (its x across the frontage, y up), turned with the building
    const lx = FERRIS.r * Math.cos(phi), ly = FERRIS.r * Math.sin(phi);
    const pivot = new Vector3(lx * Math.cos(w.yaw), ly, -lx * Math.sin(w.yaw)).add(w.hub);
    return { pivot, yaw: w.yaw, angle: phi };
  }

  private fireworks(w: Wheel) {
    const ck = this.clock?.();
    if (!ck || !this.onShow) return;
    const sp = leisureAt(FUNFAIR_KIND, w.level, w.doorX, w.doorY);
    if (!sp || !eventOn(sp, ck.day)) return;
    const start = eventStartAt(sp, w.doorX, w.doorY);
    for (let n = 0; n < 2; n++) {
      const at = start + 0.25 + n * 0.25;
      if (ck.hour < at || ck.hour > at + 0.2) continue;
      const key = ck.day * 4 + n;
      if (this.shown.get(w.key) === key) continue;
      this.shown.set(w.key, key);
      this.onShow(Math.floor(w.hub.x), Math.floor(w.hub.z), ck.day * 131 + w.doorX * 7 + w.doorY * 3 + n);
    }
  }

  frame(cams: readonly Camera[], visible = true) {
    const t0 = performance.now();
    this.frames++;
    const dt = Math.min(0.1, (t0 - this.last) / 1000);
    this.last = t0;
    if (!visible || !this.perChunk.size || !cams.length) { this.group.visible = false; this.inRange = 0; this.lastMs = 0; return; }
    const r2 = RANGE * RANGE, n = FERRIS.gondolas, full = (Math.PI * 2) / FERRIS.period;
    const ridden = this.ridden && this.frames - this.ridden.frame <= 2 ? this.ridden : null;
    let nw = 0, nc = 0;
    for (const list of this.perChunk.values()) for (const w of list) {
      let near = false;
      for (const c of cams) if (c.position.distanceToSquared(w.hub) < r2) { near = true; break; }
      if (!near || nw >= MAX_WHEELS) continue;
      const st = this.stateOf(w);
      this.fireworks(w);
      // wind up to speed while open, down to a stop when the fair shuts
      const target = this.open(w) ? 1 : 0, step = dt / FERRIS.ramp;
      st.speed += Math.max(-step, Math.min(step, target - st.speed));
      st.angle = (st.angle + full * st.jitter * st.speed * dt) % (Math.PI * 2);
      this.q.setFromAxisAngle(UP, w.yaw);
      this.qa.setFromAxisAngle(Z, st.angle);
      this.m.compose(w.hub, this.q.clone().multiply(this.qa), this.one);
      this.wheel.setMatrixAt(nw++, this.m);
      for (let i = 0; i < n; i++) {
        if (ridden && ridden.key === w.key && ridden.seat === i) continue;
        const phi = st.angle + (i / n) * Math.PI * 2, lx = FERRIS.r * Math.cos(phi), ly = FERRIS.r * Math.sin(phi);
        this.p.set(lx * Math.cos(w.yaw), ly, -lx * Math.sin(w.yaw)).add(w.hub);
        this.m.compose(this.p, this.q, this.one);
        this.cabs.setMatrixAt(nc, this.m);
        this.cabs.setColorAt(nc, this.col.setHex(CAB_COLOURS[(i + Math.floor(hash2(w.doorX, w.doorY) * 8)) % CAB_COLOURS.length]));
        nc++;
      }
    }
    this.inRange = nw;
    this.group.visible = nw > 0;
    this.wheel.count = nw; this.cabs.count = nc;
    this.wheel.instanceMatrix.needsUpdate = true; this.cabs.instanceMatrix.needsUpdate = true;
    if (this.cabs.instanceColor) this.cabs.instanceColor.needsUpdate = true;
    this.lastMs = performance.now() - t0;
  }
}
