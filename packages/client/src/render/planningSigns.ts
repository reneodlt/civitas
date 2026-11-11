import { BoxGeometry, Group, Mesh, MeshLambertMaterial, MeshBasicMaterial, type BufferGeometry } from 'three';
import type { PlanAppDTO } from '@msimcity/shared';
import { Kit } from './kit';

/**
 * Planning site markers (docs/multiplayer-land.md M5): a yellow notice board on a post at the door of every open
 * application's site, its footprint pegged out in translucent orange (a building) or the road to be closed tinted red
 * (a closure notice). From the `planning` message; decided applications take their markers down.
 */
function signGeometry(): BufferGeometry {
  return new Kit().box(0.05, 0.62, 0.05, -0.2, 0, 0, 0x6b5a40).box(0.05, 0.62, 0.05, 0.2, 0, 0, 0x6b5a40)
    .box(0.56, 0.34, 0.04, 0, 0.38, 0, 0xf2c230).box(0.44, 0.04, 0.045, 0, 0.62, 0, 0x2a2a2a).box(0.44, 0.04, 0.045, 0, 0.52, 0, 0x2a2a2a).build();
}

export class PlanningSigns {
  readonly group = new Group();
  private sign = signGeometry();
  private signMat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private pegMat = new MeshBasicMaterial({ color: 0xf28c28, transparent: true, opacity: 0.35, depthWrite: false });
  private roadMat = new MeshBasicMaterial({ color: 0xd8423a, transparent: true, opacity: 0.4, depthWrite: false });
  private sig = '';

  set(apps: PlanAppDTO[]) {
    const open = apps.filter((a) => a.status === 'open');
    const sig = JSON.stringify(open.map((a) => [a.id, a.x, a.y, a.fx, a.fy, a.fw, a.fh]));
    if (sig === this.sig) return;
    this.sig = sig;
    for (const c of [...this.group.children]) { this.group.remove(c); if (c instanceof Mesh && c.geometry !== this.sign) c.geometry.dispose(); }
    for (const a of open) {
      if (a.kind === 'build' && a.fw && a.fh) {
        const peg = new Mesh(new BoxGeometry(a.fw - 0.1, 0.04, a.fh - 0.1), this.pegMat);
        peg.position.set(a.fx! + a.fw / 2, 0.03, a.fy! + a.fh / 2);
        this.group.add(peg);
      }
      if (a.kind === 'closure') {
        const tile = new Mesh(new BoxGeometry(0.96, 0.04, 0.96), this.roadMat);
        tile.position.set(a.x + 0.5, 0.06, a.y + 0.5);
        this.group.add(tile);
      }
      const s = new Mesh(this.sign, this.signMat);
      s.position.set(a.x + 0.5, 0, a.y + 0.5);
      s.rotation.y = (a.id % 4) * 0.4;
      s.castShadow = true;
      this.group.add(s);
    }
  }
}
