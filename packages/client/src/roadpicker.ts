import { ROAD_CLASS_DEFS, TRACK_NAMES, techFor, PUBLIC_ROAD_COST, ROAD_COST, PUBLIC_ROAD_TUNING, type RoadClassDef } from '@msimcity/shared';

/**
 * The road tool's class picker (docs/roads.md "Classes", shared/src/roadclass.ts): the road tool (3) opens it beside
 * the tool bar the way a building tool opens its size picker (picker.ts), with one card per class: a drawing of its
 * cross-section, what it carries, its cost and upkeep, and the technology it needs (a locked class is greyed with the
 * technology named). Picking a card makes it the class the next drags lay; the last one picked is remembered
 * (roadtool.ts RoadTool.pick).
 */
export interface RoadPickerHost {
  /** the class picked now */
  picked(): number;
  /** the technology a class still needs, or null */
  lockOf(cls: number): string | null;
  pick(cls: number): void;
  /** a locked class was clicked */
  locked(msg: string): void;
}

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** A class's cross-section, looking along it (tiles across, drawn at 84 px a tile): what the card shows. */
function sketch(d: RoadClassDef): string {
  const W = 168, H = 120, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const grass = '#5f8a4a', pave = '#b9b6ae', asphalt = '#3b3e45', white = '#f2f2ee';
  g.fillStyle = grass; g.fillRect(0, 0, W, H);
  const tiles = d.divided ? 2 : 1, T = W / (tiles + 0.4), x0 = (W - tiles * T) / 2;
  const dash = (x: number) => { g.fillStyle = white; for (let y = 6; y < H; y += 26) g.fillRect(x - 1, y, 2, 13); };
  const arrow = (x: number, up: boolean) => {
    g.fillStyle = white; const y = H / 2, s = up ? -1 : 1;
    g.fillRect(x - 2, y - 14, 4, 28);
    g.beginPath(); g.moveTo(x, y + s * 24); g.lineTo(x - 8, y + s * 12); g.lineTo(x + 8, y + s * 12); g.fill();
  };
  for (let i = 0; i < tiles; i++) {
    const tx = x0 + i * T;
    if (d.access === 'pedestrian') {
      g.fillStyle = '#c9b79a'; g.fillRect(tx, 0, T, H);
      g.strokeStyle = 'rgba(90,70,50,0.35)';
      for (let y = 0; y < H; y += 10) { g.beginPath(); g.moveTo(tx, y); g.lineTo(tx + T, y); g.stroke(); }
      g.fillStyle = '#2b2e33';
      for (const f of [0.22, 0.5, 0.78]) { g.beginPath(); g.arc(tx + f * T, 10, 3, 0, Math.PI * 2); g.fill(); }
      continue;
    }
    const half = d.id === 1 ? 0.3 : d.access === 'noFrontage' ? 0.42 : 0.375; // carriageway each side of the tile's centre
    if (d.id !== 1 && d.access !== 'noFrontage') { g.fillStyle = pave; g.fillRect(tx, 0, T, H); }
    g.fillStyle = d.id === 1 ? '#55585e' : asphalt;
    const inner = d.divided ? (i === 0 ? tx + T * 0.5 - half * T : tx) : tx + T * 0.5 - half * T;
    const outer = d.divided ? (i === 0 ? tx + T : tx + T * 0.5 + half * T) : tx + T * 0.5 + half * T;
    g.fillRect(inner, 0, outer - inner, H);
    const mid = tx + T / 2;
    if (d.id === 0) dash(mid);
    else if (d.oneWay) { dash(mid); arrow(mid - T * 0.19, d.divided && i === 0); arrow(mid + T * 0.19, d.divided && i === 0); }
    if (d.access === 'noFrontage') { g.fillStyle = white; g.fillRect(i === 0 ? inner + 6 : outer - 8, 0, 2, H); }
  }
  if (d.divided) {
    // the reservation on the shared edge: planted for an avenue, a barrier on grass for a motorway
    const m = x0 + T;
    g.fillStyle = d.access === 'noFrontage' ? '#6b8a52' : '#4f7d3c'; g.fillRect(m - 9, 0, 18, H);
    if (d.access === 'noFrontage') { g.fillStyle = '#c9ccd2'; g.fillRect(m - 1.5, 0, 3, H); }
    else { g.fillStyle = '#2f6a2a'; for (let y = 12; y < H; y += 34) { g.beginPath(); g.arc(m, y, 8, 0, Math.PI * 2); g.fill(); } }
  }
  return c.toDataURL('image/png');
}
const sketches = new Map<number, string>();

export class RoadClassPicker {
  readonly el: HTMLDivElement;
  open = false;
  constructor(private host: RoadPickerHost) {
    this.el = document.createElement('div');
    this.el.id = 'roadPicker';
    this.el.className = 'hidden';
    this.el.setAttribute('role', 'dialog');
    document.getElementById('ui')!.appendChild(this.el);
    document.addEventListener('pointerdown', (e) => {
      if (!this.open) return;
      const t = e.target as HTMLElement | null;
      if (t && (this.el.contains(t) || t.closest('button[data-tool="road"]'))) return;
      this.close();
    });
  }
  /** Show the cards beside the tool bar, level with the road button. */
  show(anchor: HTMLElement) {
    if (!sketches.size) for (const d of ROAD_CLASS_DEFS) sketches.set(d.id, sketch(d));
    this.open = true;
    this.render();
    this.el.classList.remove('hidden');
    const bar = anchor.closest('#tools') as HTMLElement | null;
    const br = (bar ?? anchor).getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    this.el.style.left = `${Math.round(br.right + 8)}px`;
    const h = this.el.offsetHeight;
    this.el.style.top = `${Math.round(Math.max(52, Math.min(window.innerHeight - h - 12, ar.top - 12)))}px`;
  }
  close() { this.open = false; this.el.classList.add('hidden'); }
  refresh() { if (this.open) this.render(); }

  private render() {
    const on = this.host.picked();
    const cards = ROAD_CLASS_DEFS.map((d) => {
      const lock = this.host.lockOf(d.id), t = d.feature ? techFor(d.feature) : undefined;
      const lanes = d.access === 'pedestrian' ? 'walkers and bikes' : d.divided ? `${d.lanes}+${d.lanes} lanes, 2 tiles wide` : d.oneWay ? `${d.lanes} lanes one way` : `a lane each way`;
      const per = d.divided ? `$${d.cost * 2} a length` : `$${d.cost}/tile`;
      return `<button class="card${lock ? ' locked' : ''}${d.id === on ? ' on' : ''}" data-cls="${d.id}" aria-pressed="${d.id === on}" aria-disabled="${!!lock}" title="${esc(d.blurb)}">
        <span class="thumb"><img alt="" src="${sketches.get(d.id) ?? ''}" /><span class="fp" style="color:${hex(d.colour)}">●</span></span>
        <span class="nm">${esc(d.title)}</span>
        <span class="ln">${esc(lanes)}${d.access === 'pedestrian' ? '' : ` · ${Math.round(d.speed * 100)}% speed`}</span>
        <span class="ln"><b>${per}</b> · $${d.upkeep}/day</span>
        <span class="tech">${lock ? `🔒 Needs ${esc(lock)}${t ? ` · ${esc(TRACK_NAMES[t.track])} ${t.tier}` : ''}` : t ? `✓ ${esc(t.name)}` : 'Available from the start'}</span>
      </button>`;
    }).join('');
    const cur = ROAD_CLASS_DEFS[on] ?? ROAD_CLASS_DEFS[0];
    const about = (d: RoadClassDef) => `<b>${esc(d.title)}</b> ${esc(d.blurb)}<br><span>${esc(d.howTo)} ${d.access === 'pedestrian' ? '' : `Holds ${d.capacity} cars a tile${d.oneWay ? ' (its lanes together)' : ' each way'}. `}Unclaimed land adds $${PUBLIC_ROAD_COST - ROAD_COST} a tile, and you pay the upkeep of public road you lay there (it fades after ${PUBLIC_ROAD_TUNING.fadeDays} days unused; once other players' traffic uses it daily it is adopted and you stop paying).</span>`;
    this.el.innerHTML = `<div class="ph"><b>Road</b><span>${ROAD_CLASS_DEFS.length} classes · drag over a road to upgrade it in place</span><button class="x" aria-label="Close">×</button></div>
      <div class="cards">${cards}</div>
      <div class="about">${about(cur)}</div>`;
    this.el.querySelector<HTMLButtonElement>('.x')!.onclick = () => this.close();
    const ab = this.el.querySelector<HTMLDivElement>('.about')!;
    this.el.querySelectorAll<HTMLButtonElement>('button.card').forEach((b) => {
      const d = ROAD_CLASS_DEFS[Number(b.dataset.cls)];
      b.onmouseenter = () => { ab.innerHTML = about(d); };
      b.onclick = () => {
        const lock = this.host.lockOf(d.id);
        if (lock) { const t = techFor(d.feature); this.host.locked(`${d.title} needs ${lock}${t ? ` (${TRACK_NAMES[t.track]} tier ${t.tier}, $${t.cost})` : ''}: press T for the tech tree`); return; }
        this.host.pick(d.id);
        this.close();
      };
    });
  }
}
