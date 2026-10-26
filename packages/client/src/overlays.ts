import { Overlay, OVERLAY_TEXT, ROAD_CLASS_DEFS } from '@msimcity/shared';

/**
 * The overlays menu (docs/audit-2026-10.md section 4.4) on the top bar's overlay chip and the H key: traffic congestion
 * (the roads' own tint from the traffic bytes) and the server's data overlays (shared/src/issues.ts Overlay: service
 * coverage, leisure, happiness, jobs against homes, news reach), each with its legend. H cycles congestion, coverage, leisure,
 * happiness, jobs/homes, news, off; the chip opens a small menu to pick one. Ramps are colour-blind safe: viridis for the
 * sequential ones, blue against orange for jobs/homes (render/materials.ts).
 */
export type OverlayMode = 'off' | 'traffic' | 'roads' | 'power' | number;
const CYCLE: OverlayMode[] = ['traffic', 'roads', Overlay.Coverage, Overlay.Leisure, Overlay.Happiness, Overlay.JobsHomes, Overlay.News, 'power', 'off'];
/** legend gradients matching the shaders (render/materials.ts mscViridis, mscDiverge, HEAT) */
const VIRIDIS = 'linear-gradient(90deg, #440154, #3b528b, #21918c, #5ec962, #fde725)';
const DIVERGE = 'linear-gradient(90deg, #e6750d, #eeebdb, #2166cc)';
const TRAFFIC = 'linear-gradient(90deg, #4fd36a, #f2c230, #e8392b)';
/** the road classes overlay (render/materials.ts HEAT, uHeatMode 2): each class's colour (shared/src/roadclass.ts), lane to pedestrian */
const ROAD_ORDER = [1, 0, 2, 3, 4, 5];
const ROADS = `linear-gradient(90deg, ${ROAD_ORDER.map((c, i) => `#${ROAD_CLASS_DEFS[c].colour.toString(16).padStart(6, '0')} ${(i * 100) / 6}% ${((i + 1) * 100) / 6}%`).join(', ')})`;
/** the power overlay's states (render/materials.ts HEAT, uHeatMode 1): supplied, brownout, cut or fault, no supply */
const POWER = 'linear-gradient(90deg, #4fd36a 0 25%, #f2c230 25% 50%, #e8392b 50% 75%, #8c929e 75%)';

export interface OverlayDeps {
  /** congestion on the roads on or off (main.ts setHeat) */
  setTraffic(on: boolean): void;
  /** a server overlay channel (0 none): ask the server, switch the shaders' ramp */
  setChannel(ch: number): void;
  /** the power overlay (client utilities.ts): roads by their substation's state, on the congestion path */
  setPower(on: boolean): void;
  /** the road classes overlay: roads in their class's colour, on the congestion path (main.ts) */
  setRoads(on: boolean): void;
  /** R5: open or close the Traffic panel (trafficpanel.ts) */
  trafficPanel?(): void;
}

export class OverlayMenu {
  mode: OverlayMode = 'off';
  private chip: HTMLButtonElement;
  private menu: HTMLDivElement;

  constructor(private d: OverlayDeps) {
    injectStyle();
    this.chip = document.getElementById('heat') as HTMLButtonElement;
    this.chip.title = 'Overlays: traffic, service coverage, leisure, happiness, jobs against homes (H cycles them)';
    this.chip.onclick = (e) => { e.stopPropagation(); this.menu.classList.toggle('hidden'); this.renderMenu(); };
    this.menu = document.createElement('div');
    this.menu.id = 'ovlMenu'; this.menu.className = 'hidden';
    document.getElementById('ui')!.append(this.menu);
    this.menu.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-panel]')) { this.menu.classList.add('hidden'); this.d.trafficPanel?.(); return; }
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
      if (!b) return;
      const m = b.dataset.mode!;
      this.set(m === 'off' || m === 'traffic' || m === 'power' || m === 'roads' ? m : Number(m));
    });
    document.addEventListener('pointerdown', (e) => { if (!this.menu.contains(e.target as Node) && e.target !== this.chip && !this.chip.contains(e.target as Node)) this.menu.classList.add('hidden'); });
    this.render();
  }

  /** H: the next overlay in the cycle. */
  cycle() { const i = CYCLE.indexOf(this.mode); this.set(CYCLE[(i + 1) % CYCLE.length]); }

  set(mode: OverlayMode) {
    this.mode = mode;
    this.d.setPower(mode === 'power');
    this.d.setRoads(mode === 'roads');
    this.d.setTraffic(mode === 'traffic' || mode === 'power' || mode === 'roads');
    this.d.setChannel(typeof mode === 'number' ? mode : 0);
    this.render();
    this.renderMenu();
  }

  private label(mode: OverlayMode) { return mode === 'off' ? 'off' : mode === 'traffic' ? 'traffic' : mode === 'roads' ? 'road classes' : mode === 'power' ? 'power' : OVERLAY_TEXT[mode].name; }
  private ramp(mode: OverlayMode) { return mode === 'traffic' ? TRAFFIC : mode === 'roads' ? ROADS : mode === 'power' ? POWER : typeof mode === 'number' && OVERLAY_TEXT[mode].ramp === 1 ? DIVERGE : VIRIDIS; }

  private render() {
    const on = this.mode !== 'off';
    this.chip.classList.toggle('on', on);
    this.chip.innerHTML = on ? `overlay: ${this.label(this.mode)} <i class="legend" style="background:${this.ramp(this.mode)}"></i>` : 'overlays';
  }

  private renderMenu() {
    if (this.menu.classList.contains('hidden')) return;
    const r = this.chip.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(innerWidth - 300, r.left))}px`;
    this.menu.style.top = `${r.bottom + 6}px`;
    const row = (mode: OverlayMode, lo: string, hi: string, explain: string) => `
      <button class="orow${this.mode === mode ? ' sel' : ''}" data-mode="${mode}">
        <span class="oname">${this.label(mode)}</span>
        ${mode === 'off' ? '' : `<span class="olegend"><i style="background:${this.ramp(mode)}"></i><span><em>${lo}</em><em>${hi}</em></span></span>`}
        <span class="oexp">${explain}</span>
      </button>`;
    let html = '<div class="ohead">Overlays <span>H cycles</span></div>';
    html += row('traffic', 'free flowing', 'jammed', 'Roads by how held up their cars are; hover a red road to see why it is slow');
    if (this.d.trafficPanel) html += `<button class="orow" data-panel="traffic"><span class="oname">Traffic panel…</span><span class="oexp">Who is on the roads (residents, visitors, lorries), arrivals by gateway, the worst junctions and the longest queues</span></button>`;
    html += row('roads', 'lane · street · one-way', 'avenue · motorway · pedestrian', 'Roads by class: country lane, street, one-way street, avenue, motorway, pedestrian street (docs/roads.md)');
    for (const ch of [Overlay.Coverage, Overlay.Leisure, Overlay.Happiness, Overlay.JobsHomes, Overlay.News]) { const t = OVERLAY_TEXT[ch]; html += row(ch, t.lo, t.hi, t.explain); }
    html += row('power', 'supplied', 'no supply', 'Streets by their substation: supplied, brownout, cut or fault, or a substation with no supply (docs/utilities.md)');
    html += row('off', '', '', 'No overlay');
    this.menu.innerHTML = html;
  }
}

function injectStyle() {
  const style = document.createElement('style');
  style.textContent = `
#ovlMenu { position: absolute; width: 290px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  backdrop-filter: blur(8px); box-shadow: 0 8px 24px rgba(0,0,0,0.3); z-index: 7; display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
#ovlMenu.hidden { display: none; }
#ovlMenu .ohead { display: flex; justify-content: space-between; color: var(--muted); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; padding: 0 4px 3px; }
#ovlMenu .orow { display: grid; grid-template-columns: 1fr; gap: 3px; text-align: left; padding: 6px 8px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
#ovlMenu .orow:hover { background: rgba(255,255,255,0.06); }
#ovlMenu .orow.sel { border-color: rgba(98,210,162,0.6); background: rgba(98,210,162,0.12); }
#ovlMenu .oname { font-weight: 600; }
#ovlMenu .olegend { display: flex; flex-direction: column; gap: 2px; }
#ovlMenu .olegend i { display: block; height: 8px; border-radius: 4px; }
#ovlMenu .olegend span { display: flex; justify-content: space-between; color: var(--muted); font-size: 10.5px; }
#ovlMenu .olegend em { font-style: normal; }
#ovlMenu .oexp { color: var(--muted); font-size: 11px; line-height: 1.3; }
`;
  document.head.appendChild(style);
}
