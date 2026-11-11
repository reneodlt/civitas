import { InstancedMesh, MeshBasicMaterial, Matrix4, Quaternion, Vector3, Color, Group, type BufferGeometry, type Material } from 'three';
import { FleetKind, hash2 } from '@msimcity/shared';
import { Kit } from './kit';
import { LAMP, lampLenses } from './headlights';

/**
 * The vehicles of mobile workers (docs/mobile-jobs.md, shared/src/fleet.ts): taxis with a roof sign lit while for hire,
 * private-hire cars with a small lit badge, delivery bicycles and mopeds with a box and a rider who steps off at the
 * door, courier vans, bin lorries that lift a wheelie bin at each stop, street sweepers with a flashing beacon, yellow school
 * buses (the School buses policy, docs/education.md section 16) with hazard beacons while they take pupils on. Drawn
 * for render/citizens.ts, which owns the agents, picking and the follow camera; every instance varies by its id
 * (paint, brand, bin colour, the lift's timing), as everything in the city does.
 */

// vehicles are sized to the server's VEHICLE_LEN (a cab 0.34, a two-wheeler 0.16, a van 0.4, a lorry 0.46)
function cab(): BufferGeometry {
  const k = new Kit();
  k.box(0.34, 0.09, 0.18, 0, 0.045, 0, 0xffffff)
    .box(0.18, 0.075, 0.15, -0.025, 0.135, 0, 0x2f3b4d)
    .box(0.34, 0.012, 0.182, 0, 0.1, 0, 0xe8e2c8) // a pale stripe along the side
    .box(0.025, 0.02, 0.035, 0.17, 0.075, 0.06, 0xfff2b0, LAMP.head).box(0.025, 0.02, 0.035, 0.17, 0.075, -0.06, 0xfff2b0, LAMP.head)
    .box(0.015, 0.02, 0.035, -0.17, 0.075, 0.06, 0xd62020, LAMP.tail).box(0.015, 0.02, 0.035, -0.17, 0.075, -0.06, 0xd62020, LAMP.tail);
  for (const [x, z] of [[0.11, 0.095], [-0.11, 0.095], [0.11, -0.095], [-0.11, -0.095]]) k.wheel(0.04, 0.035, x, 0.04, z, 0x151515);
  return lampLenses(k.build());
}
/** the TAXI sign on the roof (unlit material: it glows by its colour) */
function cabSign(): BufferGeometry { return new Kit().box(0.06, 0.035, 0.13, -0.02, 0.21, 0, 0xffffff).build(); }
/** a private-hire car's badge, low on the windscreen */
function phBadge(): BufferGeometry { return new Kit().box(0.012, 0.022, 0.035, 0.068, 0.14, 0.035, 0xffffff).build(); }
function bicycle(): BufferGeometry {
  const k = new Kit();
  k.wheel(0.032, 0.008, 0.05, 0.032, 0, 0x1a1a1a).wheel(0.032, 0.008, -0.05, 0.032, 0, 0x1a1a1a)
    .box(0.1, 0.008, 0.008, 0, 0.055, 0, 0xffffff)                  // top tube
    .box(0.008, 0.045, 0.008, -0.02, 0.032, 0, 0xffffff)            // seat tube
    .box(0.008, 0.05, 0.008, 0.045, 0.035, 0, 0xffffff)             // fork and head tube
    .box(0.006, 0.006, 0.05, 0.045, 0.085, 0, 0x2a2a2a)             // handlebars
    .box(0.01, 0.01, 0.012, 0.06, 0.07, 0, 0xfff2b0, LAMP.head).box(0.006, 0.01, 0.012, -0.075, 0.06, 0, 0xd62020, LAMP.tail);
  return lampLenses(k.build());
}
function moped(): BufferGeometry {
  const k = new Kit();
  k.wheel(0.03, 0.02, 0.055, 0.03, 0, 0x1a1a1a).wheel(0.03, 0.02, -0.055, 0.03, 0, 0x1a1a1a)
    .box(0.13, 0.02, 0.04, -0.005, 0.035, 0, 0xffffff)              // floor
    .box(0.03, 0.08, 0.045, 0.05, 0.035, 0, 0xffffff)               // leg shield
    .box(0.06, 0.035, 0.045, -0.04, 0.055, 0, 0xffffff)             // seat body
    .box(0.006, 0.006, 0.06, 0.055, 0.12, 0, 0x2a2a2a)              // handlebars
    .box(0.05, 0.008, 0.04, -0.06, 0.09, 0, 0x2a2a2a)               // rear rack
    .box(0.012, 0.012, 0.012, 0.068, 0.095, 0.014, 0xfff2b0, LAMP.head).box(0.012, 0.012, 0.012, 0.068, 0.095, -0.014, 0xfff2b0, LAMP.head)
    .box(0.008, 0.012, 0.012, -0.075, 0.07, 0.012, 0xd62020, LAMP.tail).box(0.008, 0.012, 0.012, -0.075, 0.07, -0.012, 0xd62020, LAMP.tail);
  return lampLenses(k.build());
}
/** a seated rider (hi-vis jacket in the instance colour, a dark helmet) */
function rider(): BufferGeometry {
  const k = new Kit();
  k.box(0.035, 0.06, 0.04, -0.01, 0.075, 0, 0xffffff)    // torso, leaning a little forward
    .box(0.02, 0.02, 0.045, 0.02, 0.11, 0, 0xffffff)     // arms to the bars
    .box(0.05, 0.015, 0.035, 0.005, 0.06, 0, 0x2b2f3a)   // thighs
    .box(0.026, 0.026, 0.026, -0.005, 0.135, 0, 0xe0b48c) // face
    .box(0.03, 0.016, 0.03, -0.005, 0.155, 0, 0x22262e);  // helmet
  return k.build();
}
/** someone standing: a rider or courier at the door, a refuse loader at the back of the lorry */
function standing(): BufferGeometry {
  const k = new Kit();
  k.box(0.03, 0.06, 0.035, 0, 0, 0, 0x2b2f3a)            // legs
    .box(0.036, 0.06, 0.045, 0, 0.06, 0, 0xffffff)       // hi-vis jacket
    .box(0.026, 0.026, 0.026, 0, 0.12, 0, 0xe0b48c)      // head
    .box(0.03, 0.012, 0.03, 0, 0.146, 0, 0x22262e);       // cap
  return k.build();
}
/** an insulated delivery box (the delivery app's colour) */
function foodBox(): BufferGeometry { return new Kit().box(0.045, 0.045, 0.05, 0, 0, 0, 0xffffff).build(); }
function courierVan(): BufferGeometry {
  const k = new Kit();
  k.box(0.4, 0.17, 0.2, -0.01, 0.045, 0, 0xf4f4f2)
    .box(0.07, 0.085, 0.18, 0.155, 0.13, 0, 0x2f3b4d)
    .box(0.36, 0.035, 0.202, -0.03, 0.09, 0, 0xffffff)    // the courier's band in the instance colour
    .box(0.025, 0.02, 0.035, 0.2, 0.075, 0.065, 0xfff2b0, LAMP.head).box(0.025, 0.02, 0.035, 0.2, 0.075, -0.065, 0xfff2b0, LAMP.head)
    .box(0.015, 0.03, 0.03, -0.21, 0.09, 0.07, 0xd62020, LAMP.tail).box(0.015, 0.03, 0.03, -0.21, 0.09, -0.07, 0xd62020, LAMP.tail);
  for (const [x, z] of [[0.12, 0.105], [-0.13, 0.105], [0.12, -0.105], [-0.13, -0.105]]) k.wheel(0.042, 0.035, x, 0.042, z, 0x151515);
  return lampLenses(k.build());
}
/** a refuse collection vehicle: white cab, council-green compactor body, the hopper and lifting arms at the back */
function binLorry(): BufferGeometry {
  const k = new Kit();
  k.box(0.11, 0.15, 0.2, 0.175, 0.045, 0, 0xf2f2ee)                // cab
    .box(0.02, 0.06, 0.17, 0.232, 0.12, 0, 0x2f3b4d)                // windscreen
    .box(0.3, 0.17, 0.2, -0.05, 0.05, 0, 0x2f7a3e)                  // compactor body
    .box(0.29, 0.02, 0.202, -0.05, 0.13, 0, 0xe8e8e0)               // white band
    .box(0.06, 0.13, 0.19, -0.225, 0.05, 0, 0x3a4048)               // hopper
    .box(0.012, 0.11, 0.012, -0.258, 0.04, 0.07, 0x9aa0a8).box(0.012, 0.11, 0.012, -0.258, 0.04, -0.07, 0x9aa0a8) // lifting arms
    .box(0.012, 0.025, 0.035, 0.231, 0.07, 0.07, 0xfff2b0, LAMP.head).box(0.012, 0.025, 0.035, 0.231, 0.07, -0.07, 0xfff2b0, LAMP.head)
    .box(0.012, 0.02, 0.03, -0.256, 0.06, 0.085, 0xd62020, LAMP.tail).box(0.012, 0.02, 0.03, -0.256, 0.06, -0.085, 0xd62020, LAMP.tail);
  for (const [x, z] of [[0.17, 0.105], [-0.06, 0.105], [-0.14, 0.105], [0.17, -0.105], [-0.06, -0.105], [-0.14, -0.105]]) k.wheel(0.045, 0.035, x, 0.045, z, 0x151515);
  return lampLenses(k.build());
}
/** a wheelie bin, lid included, in the instance colour */
function wheelieBin(): BufferGeometry {
  const k = new Kit();
  k.box(0.045, 0.07, 0.045, 0, 0, 0, 0xffffff).box(0.05, 0.008, 0.05, 0.003, 0.07, 0, 0xffffff)
    .wheel(0.009, 0.006, -0.02, 0.009, 0.02, 0x111111).wheel(0.009, 0.006, -0.02, 0.009, -0.02, 0x111111);
  return k.build();
}
function sweeper(): BufferGeometry {
  const k = new Kit();
  k.box(0.13, 0.13, 0.17, 0.1, 0.04, 0, 0xffffff)                  // cab, in the instance colour
    .box(0.02, 0.06, 0.15, 0.166, 0.1, 0, 0x2f3b4d)
    .box(0.2, 0.12, 0.18, -0.08, 0.04, 0, 0xe9e9e4)                 // hopper body
    .cyl(0.035, 0.035, 0.012, 0.13, 0.0, 0.085, 0x8a6a3a, 10).cyl(0.035, 0.035, 0.012, 0.13, 0.0, -0.085, 0x8a6a3a, 10) // side brushes
    .box(0.012, 0.02, 0.03, 0.165, 0.06, 0.06, 0xfff2b0, LAMP.head).box(0.012, 0.02, 0.03, 0.165, 0.06, -0.06, 0xfff2b0, LAMP.head)
    .box(0.012, 0.02, 0.03, -0.181, 0.06, 0.07, 0xd62020, LAMP.tail).box(0.012, 0.02, 0.03, -0.181, 0.06, -0.07, 0xd62020, LAMP.tail);
  for (const [x, z] of [[0.1, 0.09], [-0.12, 0.09], [0.1, -0.09], [-0.12, -0.09]]) k.wheel(0.035, 0.03, x, 0.035, z, 0x151515);
  return lampLenses(k.build());
}
/** a school bus, VEHICLE_LEN[3] long like a service bus: chrome yellow with a black rail and a lit sign (the instance colour only dims the paint a little) */
function schoolBus(): BufferGeometry {
  const k = new Kit();
  k.box(0.6, 0.18, 0.19, 0, 0.05, 0, 0xf2b705)                                    // body
    .box(0.6, 0.016, 0.194, 0, 0.1, 0, 0x1c1c1c)                                  // black rub rail
    .box(0.52, 0.065, 0.196, -0.015, 0.145, 0, 0x2a3546)                          // window band
    .box(0.6, 0.02, 0.19, 0, 0.23, 0, 0xd9a004)                                   // roof, a shade down so the sun does not bleach it
    .box(0.02, 0.09, 0.17, 0.295, 0.13, 0, 0x2a3546)                              // windscreen
    .box(0.012, 0.03, 0.12, 0.302, 0.2, 0, 0xffe680, LAMP.sign)                   // sign, lit after dark
    .box(0.02, 0.02, 0.04, 0.3, 0.07, 0.075, 0xfff2b0, LAMP.head).box(0.02, 0.02, 0.04, 0.3, 0.07, -0.075, 0xfff2b0, LAMP.head)
    .box(0.015, 0.02, 0.04, -0.3, 0.07, 0.075, 0xd62020, LAMP.tail).box(0.015, 0.02, 0.04, -0.3, 0.07, -0.075, 0xd62020, LAMP.tail);
  for (const [x, z] of [[0.19, 0.1], [-0.17, 0.1], [0.19, -0.1], [-0.17, -0.1]]) k.wheel(0.045, 0.035, x, 0.045, z, 0x151515);
  return lampLenses(k.build());
}
/** a hearse (docs/remembrance.md): a long black estate, a glass rear compartment with a chrome rail, the coffin (its own part) inside when loaded */
function hearse(): BufferGeometry {
  const k = new Kit();
  // painted in the vertex colours (the instance colour only varies the sheen: a black hearse multiplied black would lose its glass)
  k.box(0.42, 0.085, 0.18, 0, 0.04, 0, 0x17181d)                                  // body
    .box(0.12, 0.07, 0.16, 0.1, 0.125, 0, 0x4f6274)                               // the driver's cab glass
    .box(0.24, 0.075, 0.166, -0.08, 0.125, 0, 0x7d93a8)                           // the long glass of the coffin compartment
    .box(0.24, 0.008, 0.168, -0.08, 0.2, 0, 0x17181d)                             // the roof
    .box(0.4, 0.006, 0.182, 0, 0.09, 0, 0xdfe2e6)                                 // a chrome rail along the side
    .box(0.025, 0.02, 0.035, 0.21, 0.07, 0.06, 0xfff2b0, LAMP.head).box(0.025, 0.02, 0.035, 0.21, 0.07, -0.06, 0xfff2b0, LAMP.head)
    .box(0.015, 0.02, 0.035, -0.21, 0.07, 0.06, 0xd62020, LAMP.tail).box(0.015, 0.02, 0.035, -0.21, 0.07, -0.06, 0xd62020, LAMP.tail);
  for (const [x, z] of [[0.13, 0.095], [-0.14, 0.095], [0.13, -0.095], [-0.14, -0.095]]) k.wheel(0.04, 0.035, x, 0.04, z, 0x151515);
  return lampLenses(k.build());
}
/** the coffin in a hearse's glass compartment, with flowers on its lid (the instance colour) */
function coffin(): BufferGeometry { return new Kit().box(0.19, 0.035, 0.06, -0.08, 0.13, 0, 0x6a4428).box(0.07, 0.014, 0.04, -0.08, 0.165, 0, 0xffffff).build(); }

/** an amber beacon on the roof of a sweeper or bin lorry, flashing in its own rhythm */
function beacon(): BufferGeometry { return new Kit().box(0.022, 0.02, 0.022, 0, 0, 0, 0xffffff).build(); }

const TAXI_PAINT = [0xf2c230, 0xf2c230, 0x3c4048, 0x2c6e4a, 0xe9e7e0].map((c) => new Color(c));
const CAR_PAINT = [0xe8e8e8, 0x6a707a, 0xc0392b, 0x2e86de, 0xf5f5f5, 0x8e8e8e, 0x3b5fd6].map((c) => new Color(c));
/** delivery apps' colours (jackets and boxes), courier firms' bands */
const APP = [0x16b3a4, 0xff7a1a, 0xe03a3e, 0x6fbf2a].map((c) => new Color(c));
const COURIER = [0xd9302c, 0x2f5fb5, 0xf2b705, 0x4f2a7a, 0x2a8a4a].map((c) => new Color(c));
const BINS = [0x2e7d32, 0x3a3a3a, 0x2a5db0, 0x6d4c2f, 0x8a8f96].map((c) => new Color(c));
const SIGN_FREE = new Color(0xfffbe0), SIGN_HIRED = new Color(0x3a3833), BADGE = new Color(0xa88bff), HIVIS = new Color(0xf28c28), BEACON = new Color(0xffa31a), DIM = new Color(0x5a4a30);
const WHITE = new Color(0xffffff);
/** hearses: the sheen of each one's black paint (a factor on the vertex colours); the wreath on the coffin */
const HEARSE_PAINT = [0xffffff, 0xf4f4f4, 0xe6e6ea, 0xfff0f0, 0xeef2ff].map((c) => new Color(c));
const WREATH = [0xf2f0ea, 0xd23a5a, 0xe7c13e, 0xb64d8a].map((c) => new Color(c));
const tmpC = new Color();

/** One model's instances, plus the selected vehicle's own copy on layer 1 (the first-person camera never sees it). */
class Part {
  n = 0; s = 0;
  readonly mesh: InstancedMesh; readonly sel: InstancedMesh;
  constructor(geo: BufferGeometry, mat: Material, max: number, group: Group, lamp?: (m: InstancedMesh) => void) {
    this.mesh = new InstancedMesh(geo, mat, max);
    this.sel = new InstancedMesh(lamp ? geo.clone() : geo, mat, 1);
    this.sel.layers.set(1);
    for (const m of [this.mesh, this.sel]) { m.count = 0; m.frustumCulled = false; m.castShadow = true; group.add(m); if (lamp) lamp(m); }
  }
  /** place an instance; returns the mesh and index it went to, or null when full */
  put(m: Matrix4, c: Color, mine: boolean): [InstancedMesh, number] | null {
    if (mine) { if (this.s) return null; this.sel.setMatrixAt(0, m); this.sel.setColorAt(0, c); this.s = 1; return [this.sel, 0]; }
    if (this.n >= this.mesh.instanceMatrix.count) return null;
    this.mesh.setMatrixAt(this.n, m); this.mesh.setColorAt(this.n, c);
    return [this.mesh, this.n++];
  }
  begin() { this.n = 0; this.s = 0; }
  end() {
    for (const [m, k] of [[this.mesh, this.n], [this.sel, this.s]] as [InstancedMesh, number][]) {
      m.count = k; m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}

export type FleetBody = 'sedan' | 'van' | 'truck' | 'bus' | null;

export class FleetMeshes {
  private parts: Part[] = [];
  private cab: Part; private sign: Part; private badge: Part;
  private bike: Part; private moped: Part; private rider: Part; private box: Part; private person: Part;
  private van: Part; private lorry: Part; private bin: Part; private sweeper: Part; private beacon: Part; private schoolBus: Part; private hearse: Part; private coffin: Part;
  private m = new Matrix4(); private l = new Matrix4(); private q = new Quaternion(); private p = new Vector3(); private s = new Vector3(1, 1, 1);
  private axisY = new Vector3(0, 1, 0); private axisZ = new Vector3(0, 0, 1);

  /** `vm`: the vehicle material (lamps, render/headlights.ts); `lamp` gives a mesh its per-instance lamp attribute */
  constructor(group: Group, vm: Material, lamp: (m: InstancedMesh) => void) {
    const glow = new MeshBasicMaterial({ color: 0xffffff });
    const add = (geo: BufferGeometry, mat: Material, max: number, lit = false) => { const p = new Part(geo, mat, max, group, lit ? lamp : undefined); this.parts.push(p); return p; };
    this.cab = add(cab(), vm, 600, true);
    this.sign = add(cabSign(), glow, 600);
    this.badge = add(phBadge(), glow, 600);
    this.bike = add(bicycle(), vm, 1500, true);
    this.moped = add(moped(), vm, 1500, true);
    this.rider = add(rider(), vm, 3000);
    this.box = add(foodBox(), vm, 3000);
    this.person = add(standing(), vm, 3000);
    this.van = add(courierVan(), vm, 600, true);
    this.lorry = add(binLorry(), vm, 300, true);
    this.bin = add(wheelieBin(), vm, 300);
    this.sweeper = add(sweeper(), vm, 300, true);
    this.beacon = add(beacon(), glow, 600);
    this.schoolBus = add(schoolBus(), vm, 300, true);
    this.hearse = add(hearse(), vm, 120, true);
    this.coffin = add(coffin(), vm, 120);
  }
  begin() { for (const p of this.parts) p.begin(); }
  end() { for (const p of this.parts) p.end(); }

  /** The existing body whose beams, blinker positions and eye height fit a fleet kind (render/citizens.ts tables). */
  static body(kind: number): FleetBody {
    return kind === FleetKind.Taxi || kind === FleetKind.PrivateHire || kind === FleetKind.Hearse ? 'sedan' : kind === FleetKind.CourierVan || kind === FleetKind.TradesVan || kind === FleetKind.UtilityVan || kind === FleetKind.RoadCrew ? 'van' : kind === FleetKind.BinLorry || kind === FleetKind.Sweeper || kind === FleetKind.Gritter ? 'truck' : kind === FleetKind.SchoolBus ? 'bus' : null;
  }
  /** Eye height for the first-person view, tile units. */
  static eye(kind: number): number { return kind === FleetKind.Bicycle || kind === FleetKind.Moped ? 0.14 : kind === FleetKind.BinLorry || kind === FleetKind.SchoolBus ? 0.24 : kind === FleetKind.Taxi || kind === FleetKind.PrivateHire ? 0.16 : 0.21; }
  /** A body colour for the dashboard of the first-person view. */
  static color(kind: number, id: number): number {
    if (kind === FleetKind.Taxi) return TAXI_PAINT[Math.floor(hash2(id, 3) * TAXI_PAINT.length)].getHex();
    if (kind === FleetKind.BinLorry) return 0xf2f2ee;
    if (kind === FleetKind.SchoolBus) return 0xf2b705;
    if (kind === FleetKind.Hearse) return 0x17181d;
    return kind === FleetKind.PrivateHire ? CAR_PAINT[Math.floor(hash2(id, 3) * CAR_PAINT.length)].getHex() : 0xf4f4f2;
  }

  /**
   * Draw one fleet vehicle at (x, y, z) facing `ang` (the model's yaw). `loaded`: a fare aboard, a box full; `working`:
   * at a stop doing the job. `lit(mesh, at)` sets the lamp attribute of each body drawn (brake lights, indicators).
   */
  put(id: number, kind: number, x: number, y: number, z: number, ang: number, loaded: boolean, working: boolean, now: number, mine: boolean, lit: (mesh: InstancedMesh, at: number) => void) {
    this.p.set(x, y, z); this.q.setFromAxisAngle(this.axisY, ang); this.m.compose(this.p, this.q, this.s);
    const body = (part: Part, c: Color) => { const r = part.put(this.m, c, mine); if (r) lit(r[0], r[1]); };
    /** a part placed at (lx, ly, lz) in the vehicle's frame (x forward, z to its right), turned `yaw` and tipped `tilt` */
    const at = (part: Part, c: Color, lx: number, ly: number, lz: number, yaw = 0, tilt = 0) => {
      this.l.makeRotationAxis(this.axisY, yaw);
      if (tilt) this.l.multiply(new Matrix4().makeRotationAxis(this.axisZ, tilt));
      this.l.setPosition(lx, ly, lz);
      return part.put(this.l.premultiply(this.m), c, mine);
    };
    switch (kind) {
      case FleetKind.Taxi:
        body(this.cab, TAXI_PAINT[Math.floor(hash2(id, 3) * TAXI_PAINT.length)]);
        at(this.sign, loaded ? SIGN_HIRED : SIGN_FREE, 0, 0, 0);
        return;
      case FleetKind.PrivateHire:
        body(this.cab, CAR_PAINT[Math.floor(hash2(id, 3) * CAR_PAINT.length)]);
        at(this.badge, loaded ? tmpC.copy(BADGE).multiplyScalar(0.55) : BADGE, 0, 0, 0);
        return;
      case FleetKind.Bicycle:
      case FleetKind.Moped: {
        const brand = APP[Math.floor(hash2(id, 7) * APP.length)];
        body(kind === FleetKind.Bicycle ? this.bike : this.moped, kind === FleetKind.Bicycle ? tmpC.setHSL(hash2(id, 9), 0.35, 0.5) : tmpC.setHSL(hash2(id, 9), 0.45, 0.45));
        // at the door the rider gets off, box in hand, and stands on the pavement facing the house; else rides
        const side = 0.17 + 0.03 * hash2(id, 13);
        if (working) { at(this.person, brand, 0.02, 0, side, Math.PI / 2); if (loaded) at(this.box, brand, 0.035, 0.05, side - 0.01, Math.PI / 2); }
        else {
          at(this.rider, brand, 0, kind === FleetKind.Moped ? 0.02 : 0, 0);
          at(this.box, brand, kind === FleetKind.Bicycle ? -0.03 : -0.06, kind === FleetKind.Bicycle ? 0.105 : 0.098, 0);
        }
        return;
      }
      case FleetKind.CourierVan:
      case FleetKind.TradesVan: {
        const brand = COURIER[Math.floor(hash2(id, 7) * COURIER.length)];
        body(this.van, brand);
        if (working) at(this.person, brand, -0.05, 0, 0.2 + 0.03 * hash2(id, 13), Math.PI / 2);
        return;
      }
      case FleetKind.BinLorry: {
        body(this.lorry, tmpC.copy(WHITE).multiplyScalar(0.92 + 0.08 * hash2(id, 5)));
        this.flash(id, now, 0.07, 0.205, 0);
        if (working) {
          // the loader wheels a bin to the back and the arms tip it into the hopper, each crew at its own pace
          const t = ((now / (900 + 300 * hash2(id, 17)) + hash2(id, 19)) % 1);
          const up = t < 0.25 ? 0 : t < 0.5 ? (t - 0.25) / 0.25 : t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
          const bin = BINS[Math.floor(hash2(id, Math.floor(now / 2000)) * BINS.length)];
          at(this.bin, bin, -0.3 + 0.04 * up, 0.0 + 0.16 * up, 0, 0, -2.1 * up);
          at(this.person, HIVIS, -0.33, 0, 0.09 + 0.02 * hash2(id, 23), -Math.PI / 2);
        }
        return;
      }
      case FleetKind.SchoolBus:
        body(this.schoolBus, tmpC.setScalar(0.86 + 0.14 * hash2(id, 5))); // some buses are fresher from the paint shop than others
        if (working) { this.flash(id, now, 0.27, 0.245, 0.07); this.flash(id + 1, now, -0.27, 0.245, -0.07); } // hazards while pupils get on
        return;
      case FleetKind.Hearse:
        body(this.hearse, HEARSE_PAINT[Math.floor(hash2(id, 3) * HEARSE_PAINT.length)]);
        if (loaded) at(this.coffin, WREATH[Math.floor(hash2(id, 5) * WREATH.length)], 0, 0, 0);
        if (working) at(this.person, DIM.clone().multiplyScalar(0.3), -0.26, 0, 0.12 + 0.02 * hash2(id, 13), -Math.PI / 2); // the funeral director stands by the back door
        return;
      case FleetKind.UtilityVan: {
        // a lineworkers' van (docs/utilities.md 4.4): white with a fresh or road-worn hi-vis stripe, its beacon on while it works a fault
        body(this.van, tmpC.copy(WHITE).lerp(HIVIS, 0.18 + 0.12 * hash2(id, 5)));
        if (working) { this.flash(id, now, 0.02, 0.2, 0); at(this.person, HIVIS, -0.05, 0, 0.2 + 0.03 * hash2(id, 13), Math.PI / 2); }
        return;
      }
      case FleetKind.Gritter:
        // a gritter (docs/weather.md W6): the lorry in council orange, a fresher or more weathered coat each, its beacon going all round
        body(this.lorry, tmpC.setHex(0xf28a1e).multiplyScalar(0.85 + 0.15 * hash2(id, 5)));
        this.flash(id, now, 0.07, 0.205, 0);
        return;
      case FleetKind.RoadCrew:
        // a road crew's van out to a fallen tree: hi-vis, beacon on and a sawyer at the kerb while they work
        body(this.van, tmpC.copy(HIVIS).lerp(WHITE, 0.35 + 0.2 * hash2(id, 5)));
        if (working) { this.flash(id, now, 0.02, 0.2, 0); at(this.person, HIVIS, -0.05, 0, 0.2 + 0.03 * hash2(id, 13), Math.PI / 2); }
        return;
      case FleetKind.Sweeper:
        body(this.sweeper, tmpC.setHex(hash2(id, 5) < 0.5 ? 0xf2a33a : 0xf5f5f0));
        this.flash(id, now, 0.1, 0.17, 0);
        return;
    }
  }
  /** an amber beacon on the roof, flashing in the vehicle's own rhythm */
  private flash(id: number, now: number, lx: number, ly: number, lz: number) {
    const on = ((now / (520 + 160 * hash2(id, 29)) + hash2(id, 31)) % 1) < 0.5;
    this.l.makeTranslation(lx, ly, lz).premultiply(this.m);
    this.beacon.put(this.l, on ? BEACON : DIM, false);
  }
}
