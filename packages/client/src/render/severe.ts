import { BoxGeometry, CylinderGeometry, Group, InstancedMesh, Matrix4, MeshBasicMaterial, MeshLambertMaterial, Object3D, PlaneGeometry, Color } from 'three';
import { hash2, type ServerMsg } from '@msimcity/shared';

/**
 * Severe weather on the map (docs/weather.md W6, from the server's `severe` message): a fallen tree lying across each
 * closed road tile (a trunk and a toppled crown, each its own length, angle and green, with red-and-white barriers at
 * the ends), floodwater over the tiles under water now (a translucent brown-blue sheet), and flood walls (a low grey
 * concrete wall on each tile). Three instanced meshes and two for the trees, rebuilt only when the message changes.
 */
const MAX_TREES = 64, MAX_FLOOD = 6000, MAX_WALLS = 4096;

export class SevereView {
  readonly group = new Group();
  private trunk: InstancedMesh;
  private crown: InstancedMesh;
  private barrier: InstancedMesh;
  private water: InstancedMesh;
  private wall: InstancedMesh;
  private sig = '';
  private o = new Object3D();
  private c = new Color();
  /** the river level the server last sent (0..1), for the panels */
  level = 0;
  /** closed road tiles (fallen trees and floodwater), tile keys "x,y", for tooltips */
  readonly closed = new Set<string>();

  constructor() {
    const lam = (color: number) => new MeshLambertMaterial({ color });
    this.trunk = new InstancedMesh(new CylinderGeometry(0.05, 0.07, 1, 6), lam(0x5a3d24), MAX_TREES);
    this.crown = new InstancedMesh(new BoxGeometry(0.42, 0.3, 0.36), lam(0xffffff), MAX_TREES);
    this.barrier = new InstancedMesh(new BoxGeometry(0.5, 0.08, 0.04), lam(0xd8423a), MAX_TREES * 2);
    this.water = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: 0x4f6f7a, transparent: true, opacity: 0.62, depthWrite: false }), MAX_FLOOD);
    this.wall = new InstancedMesh(new BoxGeometry(1, 0.22, 0.24), lam(0x9a9a94), MAX_WALLS);
    for (const m of [this.trunk, this.crown, this.barrier, this.wall]) { m.castShadow = true; m.count = 0; }
    this.water.count = 0;
    this.water.renderOrder = 2;
    this.group.add(this.trunk, this.crown, this.barrier, this.water, this.wall);
  }

  set(m: Extract<ServerMsg, { t: 'severe' }>) {
    this.level = m.level;
    const sig = `${m.trees.join(',')}|${m.flood.length}:${m.flood.slice(0, 64).join(',')}|${m.walls.join(',')}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.closed.clear();
    const o = this.o, mx = new Matrix4();
    let n = 0, nb = 0;
    for (let i = 0; i + 1 < m.trees.length && n < MAX_TREES; i += 2, n++) {
      const x = m.trees[i], y = m.trees[i + 1], r = hash2(x * 7 + 1, y * 5 + 3), ang = (r - 0.5) * 1.1 + (hash2(x, y) < 0.5 ? 0 : Math.PI / 2);
      this.closed.add(`${x},${y}`);
      // the trunk lies across the road, the crown at one end
      o.position.set(x + 0.5, 0.07, y + 0.5); o.rotation.set(0, ang, Math.PI / 2); o.scale.set(1, 0.85 + 0.3 * r, 1); o.updateMatrix();
      this.trunk.setMatrixAt(n, o.matrix);
      o.position.set(x + 0.5 + Math.cos(ang) * 0.38, 0.16, y + 0.5 - Math.sin(ang) * 0.38); o.rotation.set(0.3 * r, ang, 0.2); o.scale.set(1, 1, 1); o.updateMatrix();
      this.crown.setMatrixAt(n, o.matrix);
      this.crown.setColorAt(n, this.c.setHSL(0.27 + 0.06 * r, 0.45, 0.28 + 0.08 * hash2(y, x)));
      for (const s of [-0.46, 0.46]) {
        o.position.set(x + 0.5 + (ang % Math.PI === 0 ? 0 : s), 0.1, y + 0.5 + (ang % Math.PI === 0 ? s : 0)); o.rotation.set(0, ang % Math.PI === 0 ? 0 : Math.PI / 2, 0); o.updateMatrix();
        this.barrier.setMatrixAt(nb++, o.matrix);
      }
    }
    this.trunk.count = this.crown.count = n; this.barrier.count = nb;
    let f = 0;
    for (let i = 0; i + 1 < m.flood.length && f < MAX_FLOOD; i += 2, f++) {
      mx.makeTranslation(m.flood[i] + 0.5, 0.05, m.flood[i + 1] + 0.5);
      this.water.setMatrixAt(f, mx);
      this.closed.add(`${m.flood[i]},${m.flood[i + 1]}`);
    }
    this.water.count = f;
    let k = 0;
    for (let i = 0; i + 1 < m.walls.length && k < MAX_WALLS; i += 2, k++) {
      const x = m.walls[i], y = m.walls[i + 1];
      // along the run: a neighbour east or west lays it east-west, else north-south
      let ew = false;
      for (let j = 0; j + 1 < m.walls.length; j += 2) if (m.walls[j + 1] === y && Math.abs(m.walls[j] - x) === 1) { ew = true; break; }
      o.position.set(x + 0.5, 0.11, y + 0.5); o.rotation.set(0, ew ? 0 : Math.PI / 2, 0); o.scale.set(1, 1, 1); o.updateMatrix();
      this.wall.setMatrixAt(k, o.matrix);
    }
    this.wall.count = k;
    for (const im of [this.trunk, this.crown, this.barrier, this.water, this.wall]) { im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
  }
}
