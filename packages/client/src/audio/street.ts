import { hash2, VehicleClass, VehicleKind, FleetKind } from '@msimcity/shared';
import { MAX_VOICES, HELD_RESERVE, toDb, type AudioEngine } from './engine';
import { fire, playPass, makeLoop, type Loop, type EventId } from './voices';
import { VOICES } from './manifest';

/**
 * Street life (docs/audio.md "Street life"): the vehicles and walkers actually drawn round the camera, heard one by one. A road vehicle
 * passing close to the camera at street zoom fires a pass-by for its class, panned along its path and bent down in pitch as it goes by;
 * walkers close in are footsteps and, on a busy pavement, a snatch of talk; an emergency vehicle on a call carries its siren with it.
 * Ticked by the ambience's 250 ms tick, from the same walk over the agents as its scan (`visit`), so it costs a few comparisons an agent.
 * Client only: it reads what the client already draws (render/citizens.ts) and changes nothing in the simulation.
 */

/** what the street hears of an agent (render/citizens.ts Agent has all of these) */
export interface StreetAgent {
  rx: number; rz: number; car: boolean; trav: boolean;
  /** VehicleKind for a non-citizen road user (10 to 15), the workplace family for a citizen */
  kind?: number;
  /** VehicleClass on the wire: sedan, truck, van, bus */
  cls?: number;
  /** FleetKind of a mobile worker's vehicle (taxi, bicycle, moped, vans, bin lorry, ...), 0 for anything else */
  fleet?: number;
  /** on a call: lights and siren (a fire engine or an ambulance sent to an emergency; the sim never sets it on a patrol) */
  emergency?: boolean;
  /** below ground (a metro platform or train): the street does not hear it */
  under?: boolean;
  /** the drawn velocity, tiles per millisecond (render/glide.ts), when the vehicle glides */
  vx?: number; vy?: number;
}

export type PassKind = 'car' | 'taxi' | 'van' | 'lorry' | 'bus' | 'moped' | 'bike';
export type SirenKind = 'police' | 'fire' | 'ambulance';

/** the class of a road vehicle as the ear tells it: the fleet kind first (a bicycle is drawn as a sedan's class), then the body */
export function passKindOf(a: StreetAgent): PassKind {
  switch (a.fleet ?? 0) {
    case FleetKind.Bicycle: return 'bike';
    case FleetKind.Moped: return 'moped';
    case FleetKind.Taxi: case FleetKind.PrivateHire: return 'taxi';
    case FleetKind.CourierVan: case FleetKind.TradesVan: case FleetKind.UtilityVan: case FleetKind.RoadCrew: return 'van';
    case FleetKind.BinLorry: case FleetKind.Sweeper: case FleetKind.Gritter: return 'lorry';
    case FleetKind.SchoolBus: return 'bus';
    case FleetKind.Hearse: return 'car';
  }
  if (a.cls === VehicleClass.Bus) return 'bus';
  if (a.cls === VehicleClass.Truck) return 'lorry';
  if (a.cls === VehicleClass.Van) return 'van';
  return 'car';
}
/** an emergency vehicle on a call, and which siren it sounds (null: none) */
export function sirenKindOf(a: StreetAgent): SirenKind | null {
  if (!a.car || !a.emergency) return null;
  return a.kind === VehicleKind.FireEngine ? 'fire' : a.kind === VehicleKind.Ambulance ? 'ambulance' : 'police';
}

/** each class's recording, its pitch (a van is a car take a little lower) and level */
export const PASS_VOICE: Record<PassKind, { voice: EventId; rate: number; gain: number; name: string }> = {
  car: { voice: 'pass-car', rate: 1, gain: 1, name: 'car' },
  taxi: { voice: 'pass-car', rate: 0.94, gain: 1, name: 'taxi' },
  van: { voice: 'pass-car', rate: 0.86, gain: 1.05, name: 'van' },
  lorry: { voice: 'pass-lorry', rate: 1, gain: 1.1, name: 'lorry' },
  bus: { voice: 'bus-pass', rate: 1, gain: 1, name: 'bus' },
  moped: { voice: 'pass-moped', rate: 1, gain: 0.9, name: 'moped' },
  bike: { voice: 'pass-bike', rate: 1, gain: 0.8, name: 'bicycle' },
};
export const SIREN_VOICE: Record<SirenKind, string> = { police: 'siren-loop', fire: 'siren-fire-loop', ambulance: 'siren-ambulance-loop' };

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** The numbers (docs/audio.md "Street life"); every one is a constant here. */
export const STREET = {
  /** the pass-by radius at street zoom (dist 24), tiles; it scales with the zoom and is nothing above `passTop` */
  passR: 12, passMinR: 6, passTop: 90,
  /** the budget: at most one new pass-by a second, six sounding at once, the nearest first */
  passGapMs: 1000, passMax: 6,
  /** a vehicle slower than this (tiles a second) is queued or parked, not passing */
  passMinSpeed: 0.3,
  /** sirens: heard within this many tiles at any zoom under the map, at most three at once (the nearest), the gain falling as 1/d past the knee */
  sirenR: 70, sirenMax: 3, sirenKnee: 10,
  /** a siren already followed keeps its slot until another is this much nearer (a share), and is let go this many tiles past the circle: no flapping at the edges */
  sirenKeep: 0.75, sirenHold: 6,
  /** a siren stops when its vehicle has stood still this long (it has arrived at the call, though the flag stays on until it heads back), and starts again only when it moves */
  sirenArrive: 3, sirenStill: 0.25,
  /** at most one new siren every this many ms (a busy fire district sends one engine after another) */
  sirenGapMs: 4000,
  /** footsteps and talk: walkers within this many tiles */
  walkR: 8,
  /** a horn: one in this many close car pass-bys, one in `hornJunction` at a junction */
  hornOdds: 25, hornJunction: 10, hornClose: 6,
};

/** the pass-by radius for a camera distance: about 12 tiles at street zoom (24), growing with the zoom, 0 (no pass-bys) above 90 */
export const passRadius = (dist: number) => (dist > STREET.passTop ? 0 : Math.max(STREET.passMinR, STREET.passR * dist / 24));

/** the closest approach of a vehicle at p (relative to the camera's ground point) moving at v (tiles a second): when (s, 0 if it is going away) and how near (tiles) */
export function approach(px: number, pz: number, vx: number, vz: number): { t: number; d: number } {
  const v2 = vx * vx + vz * vz;
  const t = v2 > 1e-9 ? Math.max(0, -(px * vx + pz * vz) / v2) : 0;
  return { t, d: Math.hypot(px + vx * t, pz + vz * t) };
}
/** a pan (-1 left .. 1 right) for a point relative to the camera, from its side along the camera's right vector */
export const panOf = (px: number, pz: number, rightX: number, rightZ: number, soft = 6) => clamp((px * rightX + pz * rightZ) / (soft + 0.25 * Math.hypot(px, pz)), -1, 1);
/** a siren's gain for its distance: full inside the knee, then 1/d */
export const sirenGain = (d: number) => (d <= STREET.sirenKnee ? 1 : STREET.sirenKnee / d);

/**
 * The pass-by picker: one start per crossing, nearest first, under a budget. Pure (it is handed the time), so the checks can drive it.
 * A vehicle is tracked while it is within 2R; inside R and moving it is a candidate until it fires; it is re-armed once it leaves 2R
 * (or is no longer drawn).
 */
export class PassPicker {
  private seen = new Map<number, PassRec>();
  private cands: { id: number; d: number }[] = [];
  private tick = 0;
  /** when each pass-by sounding now ends (ms), and when the last started */
  private until: number[] = [];
  private last = -1e9;
  /** start a tick */
  begin() { this.tick++; this.cands.length = 0; }
  /** the record of a vehicle (its last position, for its speed), or undefined when it is not tracked */
  rec(id: number) { return this.seen.get(id); }
  /** a vehicle `d` tiles from the camera's ground point, moving at `speed` tiles a second, with the pass-by radius R */
  visit(id: number, d: number, R: number, speed: number, x = 0, z = 0, rec?: PassRec): PassRec | undefined {
    if (R <= 0 || d >= 2 * R) { this.seen.delete(id); return undefined; }
    let r = rec ?? this.seen.get(id);
    if (!r) { r = { fired: false, at: this.tick, x, z, vx: 0, vz: 0, a: null }; this.seen.set(id, r); }
    r.at = this.tick; r.x = x; r.z = z;
    if (!r.fired && d < R && speed >= STREET.passMinSpeed) this.cands.push({ id, d });
    return r;
  }
  /** forget vehicles no longer drawn; then the one to fire now (the nearest candidate) or null when the budget says wait */
  pick(now: number): number | null {
    for (const [id, r] of this.seen) if (r.at !== this.tick) this.seen.delete(id);
    this.until = this.until.filter((u) => u > now);
    if (!this.cands.length || now - this.last < STREET.passGapMs || this.until.length >= STREET.passMax) return null;
    let best = this.cands[0];
    for (const c of this.cands) if (c.d < best.d) best = c;
    return best.id;
  }
  /** the pick fired (or was tried): mark it, and hold the budget for `seconds` */
  fired(id: number, now: number, seconds: number) {
    const r = this.seen.get(id);
    if (r) r.fired = true;
    this.last = now;
    if (seconds > 0) this.until.push(now + seconds * 1000);
  }
  /** how many pass-bys sound now */
  sounding(now: number) { return this.until.filter((u) => u > now).length; }
  get tracked() { return this.seen.size; }
  clear() { this.seen.clear(); this.until.length = 0; this.cands.length = 0; }
}

/** a vehicle the picker tracks: whether it has fired on this crossing, the tick it was last seen, where it was drawn, its velocity (tiles a second) and the agent */
export interface PassRec { fired: boolean; at: number; x: number; z: number; vx: number; vz: number; a: StreetAgent | null }

/** one siren following its vehicle */
interface Follow { id: number; kind: SirenKind; loop: Loop; d: number; lastD: number; rate: number; gain: number; pan: number; born: number; why: string }

/** what the camera and the scene give the street each tick */
export interface StreetCam { x: number; z: number; dist: number; map: boolean; rightX: number; rightZ: number }

export class StreetLife {
  readonly picker = new PassPicker();
  private follows = new Map<number, Follow>();
  /** when the last siren started (ms) */
  private sirenAt = -1e9;
  /** a switch for measuring (msc.audio.ambience.street.off = true): the scan then walks the agents without the street, and nothing on the street starts */
  off = false;
  private sirenCands: { id: number; kind: SirenKind; d: number; x: number; z: number; moving: boolean }[] = [];
  /** emergency vehicles on a call that stood still (arrived): since when (ms), and whether their siren was stopped for it */
  private still = new Map<number, { since: number; x: number; z: number; arrived: boolean }>();
  /** the followed vehicles still drawn with their flag on this tick (an arrival, three nearer, or leaving the circle; a followed vehicle not here dropped its flag or vanished) */
  private followSeen = new Set<number>();
  /** walkers close in, each side of the camera, this tick */
  private walkL = 0; private walkR = 0; private walkNear = 1e9;
  private stepUntil = [0, 0];
  private talkUntil = 0;
  private cam: StreetCam = { x: 0, z: 0, dist: 0, map: false, rightX: 1, rightZ: 0 };
  private R = 0;
  private ridden = -1;
  private n = 0;
  /** pass-bys started (performance.now ms), for the readout's last minute */
  private recent: number[] = [];
  /** the cost of the street's part of the tick, ms (visit plus end), the last */
  cost = 0;
  /** walkers close in (the last tick), for the readout */
  walkersClose = 0;

  constructor(private eng: AudioEngine, private salt = 0, private roadAt?: (x: number, z: number) => boolean) {}

  private rand() { return hash2(this.n++, this.salt ^ 0x5ee7); }

  /** seconds since the last tick (for a speed from positions) */
  private dt = 0.25;
  /** what the scan and its visits cost, ms, the last tick (the readout's tick includes it) */
  scanCost = 0;
  /** start a tick: the camera, the ridden vehicle's agent id (-1: none), whose own pass-by and siren are never fired, and the seconds since the last */
  begin(cam: StreetCam, ridden: number, dt = 0.25) {
    this.cam = cam; this.ridden = ridden; this.dt = dt;
    this.R = cam.map ? 0 : passRadius(cam.dist);
    this.picker.begin();
    this.sirenCands.length = 0; this.followSeen.clear();
    this.walkL = this.walkR = 0; this.walkNear = 1e9;
  }

  /** one agent from the scan's walk (dx, dz: from the camera's ground point; d2 its square distance) */
  visit(a: StreetAgent, id: number, dx: number, dz: number, d2: number) {
    if (a.under || id === this.ridden) return;
    if (a.car) {
      if (a.emergency) {
        const held = this.follows.has(id), sk = sirenKindOf(a), sr = held ? STREET.sirenR + STREET.sirenHold : STREET.sirenR;
        if (held) this.followSeen.add(id);
        if (sk && d2 < sr * sr && !this.cam.map) {
        const glide = a.vx !== undefined && a.vy !== undefined ? Math.hypot(a.vx, a.vy) * 1000 : -1;
        this.sirenCands.push({ id, kind: sk, d: Math.sqrt(d2), x: a.rx, z: a.rz, moving: glide < 0 || glide >= STREET.sirenStill });
        }
      }
      const R = this.R;
      if (R > 0) {
        if (d2 >= 4 * R * R) return; // not seen this tick: the picker forgets it (re-armed) when it picks
        const d = Math.sqrt(d2), r = this.picker.rec(id);
        let vx = 0, vz = 0;
        if (a.vx !== undefined && a.vy !== undefined && (a.vx !== 0 || a.vy !== 0)) { vx = a.vx * 1000; vz = a.vy * 1000; } else if (r && this.dt > 0) { vx = (a.rx - r.x) / this.dt; vz = (a.rz - r.z) / this.dt; }
        if (vx * vx + vz * vz > 400) vx = vz = 0; // a jump (a teleport, a reroute) is not speed
        const rec = this.picker.visit(id, d, R, Math.sqrt(vx * vx + vz * vz), a.rx, a.rz, r);
        if (rec) { rec.vx = vx; rec.vz = vz; rec.a = a; }
      }
    } else if (a.trav && d2 < STREET.walkR * STREET.walkR) {
      if (dx * this.cam.rightX + dz * this.cam.rightZ < 0) this.walkL++; else this.walkR++;
      if (d2 < this.walkNear) this.walkNear = d2;
    }
  }

  /** end a tick: fire a pass-by if the budget allows, follow the sirens, footsteps and talk. `day` 0..1, `crowd` the walkers per 15-tile circle */
  end(now: number, dt: number, day: number, crowd: number) {
    const eng = this.eng, cam = this.cam;
    const id = this.picker.pick(now);
    if (id !== null) this.pass(id, now);
    this.sirens(now, dt);
    this.walkersClose = this.walkL + this.walkR;
    if (cam.map || cam.dist > 60) return;
    const close = 1 - smooth(25, 55, cam.dist), near = Math.sqrt(this.walkNear);
    // footsteps: one voice a side, the odd step for one walker, steady for six
    const sides = [this.walkL, this.walkR];
    for (let s = 0; s < 2; s++) {
      const k = sides[s];
      if (!k || now < this.stepUntil[s]) continue;
      const lam = 0.6 * smooth(0, 6, k) + 0.04;
      if (this.rand() >= 1 - Math.exp(-lam * dt)) continue;
      const pan = (s ? 1 : -1) * (0.25 + 0.55 * this.rand());
      const gain = (0.35 + 0.5 * smooth(0, 6, k)) * close * (1 - 0.5 * smooth(2, STREET.walkR, near));
      if (gain < 0.03) continue;
      const before = eng.shots.length;
      fire(eng, 'footsteps', { why: `footsteps: ${k} walker${k > 1 ? 's' : ''} within ${STREET.walkR} tiles on the ${s ? 'right' : 'left'}, the nearest ${near.toFixed(0)} tiles off`, seed: (this.rand() * 1e9) | 0, gain, pan });
      this.stepUntil[s] = now + (eng.shots.length > before ? 3200 : 1000);
    }
    // talk: a snatch of conversation over a busy pavement by day
    if (crowd >= 15 && now >= this.talkUntil && VOICES.talk?.takes?.length) {
      const lam = (0.05 + 0.1 * smooth(15, 45, crowd)) * day * close;
      if (lam > 0 && this.rand() < 1 - Math.exp(-lam * dt)) {
        fire(eng, 'talk', { why: `talk: ${Math.round(crowd)} walkers per 15-tile circle (15 or more), ${this.walkersClose} within ${STREET.walkR} tiles, by day`, seed: (this.rand() * 1e9) | 0, gain: 0.45 + 0.45 * this.rand(), pan: this.rand() * 1.4 - 0.7 });
        this.talkUntil = now + 3500;
      }
    }
  }

  /** fire the pass-by of vehicle `id` (the picker's choice) */
  private pass(id: number, now: number) {
    const eng = this.eng, cam = this.cam, rec = this.picker.rec(id), a = rec?.a;
    if (!rec || !a) { this.picker.fired(id, now, 0); return; }
    const kind = passKindOf(a), pv = PASS_VOICE[kind];
    const px = a.rx - cam.x, pz = a.rz - cam.z, vx = rec.vx, vz = rec.vz;
    const speed = Math.hypot(vx, vz), ap = approach(px, pz, vx, vz);
    const seed = (hash2(id, this.salt + this.n++) * 1e9) | 0; // per vehicle and per crossing: take, pitch, level, pan path all differ
    const buf = eng.sample(pv.voice, hash2(seed, 5));
    const len = buf ? buf.duration : 3;
    // the clip's loudest moment (the build centres a pass on it, about mid-clip) meets the vehicle's closest approach
    const peak = len * 0.5, tc = Math.min(ap.t, 4);
    const offset = clamp(peak - tc, 0, Math.max(0, len - 1.2)), delay = clamp(tc - peak, 0, 1);
    const playFor = len - offset;
    const pan0 = panOf(px, pz, cam.rightX, cam.rightZ), x1 = px + vx * playFor, z1 = pz + vz * playFor, pan1 = panOf(x1, z1, cam.rightX, cam.rightZ);
    const bend = clamp(speed / 60, 0.01, 0.04); // a few per cent at a street's pace (Doppler: higher coming, lower going)
    const zoom = 1 - 0.75 * smooth(30, STREET.passTop, cam.dist);
    const gain = pv.gain * zoom / (1 + ap.d / 5);
    const dir = Math.abs(pan1 - pan0) < 0.15 ? (pan0 < -0.3 ? 'on the left' : pan0 > 0.3 ? 'on the right' : 'ahead') : pan1 > pan0 ? 'left to right' : 'right to left';
    const why = `pass-by: ${pv.name} #c${id} at ${ap.d.toFixed(0)} tiles${ap.t > 0 ? ` in ${ap.t.toFixed(1)} s` : ', going away'}, ${speed.toFixed(1)} tiles/s, ${dir}`;
    const sec = playPass(eng, pv.voice, { seed, gain, pan: pan0, panTo: pan1, bend: ap.t > 0 ? bend : bend / 2, bendAt: Math.max(0, tc - offset) + delay, rate: pv.rate, offset, delay, why });
    this.picker.fired(id, now, sec);
    if (sec <= 0) return;
    this.recent.push(now);
    // a bicycle rings its bell one time in four; a car close in honks now and then, at a junction more often
    if (kind === 'bike' && hash2(id, seed) < 0.25) fire(eng, 'bike-bell', { why: `bike bell: the bicycle #c${id} passing ${ap.d.toFixed(0)} tiles off (one in four)`, seed: seed ^ 0x77, gain: gain * 1.2, pan: pan0, delay: delay + 0.2 + 0.6 * hash2(seed, 9) });
    if ((kind === 'car' || kind === 'taxi' || kind === 'van') && ap.d < STREET.hornClose) {
      const junction = this.roadAt ? this.isJunction(a.rx, a.rz) : false;
      if (hash2(seed, 11) < 1 / (junction ? STREET.hornJunction : STREET.hornOdds)) fire(eng, 'horn', { why: `horn: the ${pv.name} #c${id} passing ${ap.d.toFixed(0)} tiles off${junction ? ' at a junction (one in 10)' : ' (one in 25)'}`, seed: seed ^ 0x51, gain: Math.min(1, gain * 1.3), pan: pan0, delay: delay + 0.1 + 0.8 * hash2(seed, 12) });
    }
  }
  /** a road tile with three or more road neighbours */
  private isJunction(x: number, z: number) {
    const f = this.roadAt!, tx = Math.floor(x), tz = Math.floor(z);
    return (f(tx + 1, tz) ? 1 : 0) + (f(tx - 1, tz) ? 1 : 0) + (f(tx, tz + 1) ? 1 : 0) + (f(tx, tz - 1) ? 1 : 0) >= 3;
  }

  /** follow the nearest three emergency vehicles on a call with their sirens; stop the rest with a fade */
  private sirens(now: number, dt: number) {
    const eng = this.eng, cam = this.cam;
    // arrival: a vehicle standing still for a few seconds has reached its call (its flag stays on until it heads back): its siren stops, and starts again when it moves
    for (const c of this.sirenCands) {
      let st = this.still.get(c.id);
      if (!st) { st = { since: now, x: c.x, z: c.z, arrived: false }; this.still.set(c.id, st); }
      const moved = Math.hypot(c.x - st.x, c.z - st.z) > 0.5;
      if (c.moving || moved) { st.since = now; st.x = c.x; st.z = c.z; st.arrived = false; } else if (now - st.since > STREET.sirenArrive * 1000) st.arrived = true;
    }
    if (this.still.size > 64) for (const [id] of this.still) if (!this.sirenCands.some((c) => c.id === id)) this.still.delete(id);
    const rank = (c: { id: number; d: number }) => c.d * (this.follows.has(c.id) ? STREET.sirenKeep : 1);
    const want = this.sirenCands.filter((c) => !this.still.get(c.id)?.arrived).sort((a, b) => rank(a) - rank(b)).slice(0, STREET.sirenMax);
    const keep = new Set(want.map((w) => w.id));
    for (const [id, f] of this.follows) {
      if (keep.has(id)) continue;
      const still = this.sirenCands.find((c) => c.id === id);
      const reason = cam.map ? 'the map view' : !this.followSeen.has(id) ? (f.d < STREET.sirenR - 4 ? `its call is over at ${f.d.toFixed(0)} tiles (the emergency flag dropped, or it parked and is no longer drawn)` : `it left the ${STREET.sirenR}-tile circle`) : still && this.still.get(id)?.arrived ? `it arrived (standing still ${STREET.sirenArrive} s at ${still.d.toFixed(0)} tiles; the call goes on)` : still ? `three nearer sirens (it is ${still.d.toFixed(0)} tiles off)` : `it left the ${STREET.sirenR}-tile circle (and ${STREET.sirenHold} past it)`;
      f.loop.stop(still && this.still.get(id)?.arrived ? 2.5 : 1.5);
      this.follows.delete(id);
      eng.log('stop', 'event', SIREN_VOICE[f.kind], `siren: ${f.kind} #c${id} stopped: ${reason}`);
    }
    const zoom = 1 - 0.6 * smooth(60, 220, cam.dist);
    for (const w of want) {
      let f = this.follows.get(w.id);
      const px = w.x - cam.x, pz = w.z - cam.z;
      if (!f) {
        if (now - this.sirenAt < STREET.sirenGapMs) continue;
        const voice = SIREN_VOICE[w.kind];
        const loop = makeLoop(eng, voice, (hash2(w.id, 0x51e) * 1e9) | 0);
        if (!loop) continue; // no recording yet, or no voice free: tried again next tick
        f = { id: w.id, kind: w.kind, loop, d: w.d, lastD: w.d, rate: 1, gain: 0, pan: 0, born: performance.now(), why: '' };
        this.sirenAt = now;
        this.follows.set(w.id, f);
        eng.log('start', 'event', voice, `siren: ${w.kind} #c${w.id} at ${w.d.toFixed(0)} tiles, on a call (the nearest ${keep.size} of ${this.sirenCands.length} within ${STREET.sirenR})`);
      }
      const dd = dt > 0 ? (w.d - f.d) / dt : 0; // tiles a second, + going away
      f.lastD = f.d; f.d = w.d;
      f.rate = 1 - clamp(dd / 50, -0.04, 0.04);
      f.gain = sirenGain(w.d) * zoom;
      f.pan = panOf(px, pz, cam.rightX, cam.rightZ, 8);
      f.loop.set(f.gain, f.pan, f.rate, 0.3);
      f.why = `siren: ${w.kind} #c${w.id} at ${w.d.toFixed(0)} tiles, ${dd < -0.3 ? 'nearing' : dd > 0.3 ? 'going away' : 'holding its distance'} (${Math.abs(dd).toFixed(1)} tiles/s), gain ${f.gain.toFixed(2)} (1/d past ${STREET.sirenKnee} tiles), pan ${f.pan.toFixed(2)}`;
    }
  }

  /** the sirens sounding now, for the audio readout's voice list */
  sirenRows(now: number): { id: string; key: string; db: number; cents: number; take: string; age: number; why: string }[] {
    const out = [];
    for (const f of this.follows.values()) {
      const id = SIREN_VOICE[f.kind], i = f.loop.info();
      out.push({ id, key: `siren:${f.id}`, db: toDb(f.gain * (VOICES[id]?.level ?? 1) * this.eng.busGain('ambience')), cents: 1200 * Math.log2(f.rate) + i.cents, take: i.take, age: now - f.born, why: f.why });
    }
    return out;
  }
  /** pass-bys started in the last minute */
  perMinute(now: number) { this.recent = this.recent.filter((t) => now - t < 60000); return this.recent.length; }
  get following() { return this.follows.size; }
  /** the readout header's words */
  text(now: number) { return `pass-bys ${this.perMinute(now)} in the last minute (radius ${this.R.toFixed(0)} tiles${this.R ? '' : ': zoomed out, none'}), sirens following ${this.following}, walkers close ${this.walkersClose}`; }

  /** stop every siren (the map, a mute, the ambience going away) */
  silence(reason: string) {
    for (const f of this.follows.values()) { f.loop.stop(0.8); this.eng.log('stop', 'event', SIREN_VOICE[f.kind], `siren: ${f.kind} #c${f.id} stopped: ${reason}`); }
    this.follows.clear();
  }
}

/** the voices never above the cap: a siren takes a held voice only while the one-shots' share leaves the beds and the ride their four */
export const sirenRoom = (eng: AudioEngine) => eng.active < MAX_VOICES - HELD_RESERVE;
