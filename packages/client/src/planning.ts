import { REFUSE_ADDONS, VALUE_KINDS, TICKS_PER_HOUR, conditionCost, type PlanAppDTO } from '@msimcity/shared';

/**
 * The Planning panel (docs/multiplayer-land.md section 6, M5): the open applications that are the player's own or reach
 * their land (or, for a road closure notice, that their land or traffic depends on), and those decided lately. Each shows
 * the site (a link: the camera goes there), the impact on others' land by kind against its limit, the time left, the
 * conditions and the community offer, and the voters on the frozen roll. Actions: the applicant may add a condition,
 * raise the offer or withdraw; an affected mayor may object to a road closure. A chip ("Planning · 2") shows while any
 * application concerns the player and opens the panel.
 */
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const money = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;

export interface PlanningHost {
  me(): string;
  nameOf(id: string): string;
  tick(): number;
  jump(x: number, y: number): void;
  act(id: number, act: 'object' | 'withdraw' | 'amend', extra?: { conditions?: string[]; offer?: number }): void;
}

export class PlanningPanel {
  readonly el: HTMLDivElement;
  readonly chip: HTMLButtonElement;
  open = false;
  apps: PlanAppDTO[] = [];
  /** votes on nuisance builds are on in this world (the server says so with the list) */
  votes = false;
  private timer = 0;
  constructor(private host: PlanningHost) {
    injectStyle();
    const ui = document.getElementById('ui')!;
    this.el = document.createElement('div');
    this.el.id = 'planningPanel';
    this.el.className = 'hidden';
    this.el.setAttribute('role', 'dialog');
    ui.appendChild(this.el);
    this.chip = document.createElement('button');
    this.chip.id = 'planningChip';
    this.chip.className = 'hidden';
    this.chip.title = 'Planning notices that concern you';
    this.chip.addEventListener('click', () => this.toggle());
    ui.appendChild(this.chip);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.x')) { this.toggle(false); return; }
      const go = t.closest<HTMLElement>('[data-jx]');
      if (go) { this.host.jump(Number(go.dataset.jx), Number(go.dataset.jy)); return; }
      const b = t.closest<HTMLElement>('[data-act]');
      if (!b) return;
      const id = Number(b.dataset.id), act = b.dataset.act!;
      if (act === 'object') this.host.act(id, 'object');
      else if (act === 'withdraw') this.host.act(id, 'withdraw');
      else if (act === 'cond') this.host.act(id, 'amend', { conditions: [b.dataset.c!] });
      else if (act === 'offer') {
        const inp = this.el.querySelector<HTMLInputElement>(`input[data-offer="${id}"]`);
        const v = Number(inp?.value);
        if (Number.isFinite(v) && v > 0) this.host.act(id, 'amend', { offer: v });
      }
    });
  }

  /** The `planning` message: the whole list. */
  set(apps: PlanAppDTO[], votes: boolean) {
    this.apps = apps;
    this.votes = votes;
    const n = this.mine().filter((a) => a.status === 'open').length;
    this.chip.textContent = `Planning · ${n}`;
    this.chip.classList.toggle('hidden', n === 0 && !this.open);
    if (this.open) this.render();
  }
  /** The applications that concern the player: their own, and those reaching their land. */
  mine(): PlanAppDTO[] {
    const me = this.host.me();
    return this.apps.filter((a) => a.by === me || a.affected.includes(me));
  }
  toggle(open = !this.open) {
    this.open = open;
    this.el.classList.toggle('hidden', !open);
    clearInterval(this.timer);
    if (open) { this.render(); this.timer = window.setInterval(() => this.render(), 2000); }
    else this.chip.classList.toggle('hidden', this.mine().filter((a) => a.status === 'open').length === 0);
  }

  private render() {
    const me = this.host.me(), now = this.host.tick(), list = this.mine().sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || a.ends - b.ends);
    let html = `<div class="ph"><b>Planning</b><span>${this.votes ? 'residents vote on nuisance builds near others\' land' : 'road closure notices'}</span><button class="x" aria-label="Close">×</button></div>`;
    if (!list.length) html += `<div class="pp-empty">No applications concern you. A nuisance build (a refuse site) that reaches someone else's land goes to a residents' vote here; a protected public road can be closed by a notice.</div>`;
    for (const a of list) {
      const mine = a.by === me, left = a.ends - now;
      const when = a.status === 'open' ? (left > 0 ? `${Math.max(1, Math.round(left / TICKS_PER_HOUR))} game h left` : 'counting…') : a.status;
      html += `<div class="pp-app pp-${a.status}">`;
      html += `<div class="pp-head"><span class="pp-what" data-jx="${a.x}" data-jy="${a.y}" title="go there">${esc(cap(a.what))}</span><span class="pp-when">${esc(when)}</span></div>`;
      html += `<div class="pp-row"><span>${mine ? 'Your application' : `By ${esc(this.host.nameOf(a.by))}`}</span><span>${a.kind === 'closure' ? `affects ${esc(a.affected.map((o) => this.host.nameOf(o)).join(', '))}` : `${a.voters} voter${a.voters === 1 ? '' : 's'} on the roll`}</span></div>`;
      if (a.impact.length) html += `<div class="pp-imp">${a.impact.map(([k, v, lim]) => `<span title="${esc(VALUE_KINDS[k].explain)}"><i style="width:${Math.min(100, (100 * v) / lim)}%"></i>${esc(VALUE_KINDS[k].name)} ${pct(v)} <em>of ${pct(lim)}</em></span>`).join('')}</div>`;
      if (a.kind === 'build') html += `<div class="pp-row"><span>Conditions</span><span>${a.conditions.length ? esc(a.conditions.map((c) => REFUSE_ADDONS.find((d) => d.id === c)?.label.toLowerCase() ?? c).join(', ')) : 'none'}</span></div><div class="pp-row"><span>Community offer</span><span>${a.offer ? money(a.offer) : 'none'}</span></div>`;
      if (a.result) html += `<div class="pp-result">${esc(a.result)}</div>`;
      if (a.status === 'open') {
        const acts: string[] = [];
        if (mine && a.kind === 'build') {
          for (const d of REFUSE_ADDONS) if (!a.conditions.includes(d.id)) acts.push(`<button data-act="cond" data-id="${a.id}" data-c="${d.id}" title="${esc(d.blurb)}">+ ${esc(d.label.toLowerCase())}${d.cost ? ` (${money(conditionCost(d.bit))})` : ''}</button>`);
          acts.push(`<span class="pp-offer"><input type="number" min="0" step="100" data-offer="${a.id}" value="${a.offer || ''}" placeholder="offer $"><button data-act="offer" data-id="${a.id}">Raise offer</button></span>`);
        }
        if (mine) acts.push(`<button data-act="withdraw" data-id="${a.id}">Withdraw (refund)</button>`);
        if (!mine && a.kind === 'closure' && a.affected.includes(me) && !(a.objections ?? []).includes(me)) acts.push(`<button class="pp-obj" data-act="object" data-id="${a.id}">Object: keep the road</button>`);
        if (acts.length) html += `<div class="pp-acts">${acts.join('')}</div>`;
      }
      html += `</div>`;
    }
    html += `<div class="pp-foot">The roll is frozen when a plan is filed. Each resident weighs what it would do to their own home, what they have heard, the offer and the jobs; opponents turn out more readily. Refused plans are refunded; the site then cools off.</div>`;
    // keep a half-typed offer
    const typing = document.activeElement instanceof HTMLInputElement && this.el.contains(document.activeElement) ? document.activeElement : null;
    if (typing) return;
    this.el.innerHTML = html;
  }
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function injectStyle() {
  const st = document.createElement('style');
  st.textContent = `
#planningChip { position: absolute; right: 12px; top: 56px; z-index: 5; padding: 4px 10px; border-radius: 12px; border: 1px solid rgba(242,194,48,0.6); background: rgba(242,194,48,0.16); color: var(--fg); font: inherit; cursor: pointer; }
#planningChip.hidden, #planningPanel.hidden { display: none; }
#planningPanel { position: absolute; right: 12px; top: 88px; z-index: 6; width: min(380px, calc(100vw - 24px)); max-height: calc(100vh - 110px); overflow-y: auto; padding: 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; backdrop-filter: blur(8px); box-shadow: 0 8px 24px rgba(0,0,0,0.3); font-size: 12px; }
#planningPanel .ph { display: flex; align-items: baseline; gap: 10px; margin: 0 2px 8px; }
#planningPanel .ph b { font-size: 14px; } #planningPanel .ph span { color: var(--muted); font-size: 11px; }
#planningPanel .ph .x { margin-left: auto; border: 0; background: transparent; color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer; padding: 0 4px; }
#planningPanel .pp-app { padding: 7px 0; border-top: 1px solid var(--line); display: grid; gap: 3px; }
#planningPanel .pp-app.pp-refused, #planningPanel .pp-app.pp-withdrawn, #planningPanel .pp-app.pp-lapsed { opacity: 0.7; }
#planningPanel .pp-head { display: flex; justify-content: space-between; gap: 8px; }
#planningPanel .pp-what { font-weight: 600; cursor: pointer; } #planningPanel .pp-what:hover { text-decoration: underline; }
#planningPanel .pp-when { color: #f2c230; white-space: nowrap; }
#planningPanel .pp-row { display: flex; justify-content: space-between; gap: 8px; } #planningPanel .pp-row span:first-child { color: var(--muted); }
#planningPanel .pp-imp { display: grid; gap: 2px; }
#planningPanel .pp-imp span { position: relative; padding: 1px 4px; border-radius: 4px; overflow: hidden; background: rgba(255,255,255,0.04); }
#planningPanel .pp-imp i { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(216,66,58,0.28); z-index: -1; }
#planningPanel .pp-imp em { color: var(--muted); font-style: normal; }
#planningPanel .pp-result { color: var(--muted); }
#planningPanel .pp-acts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
#planningPanel .pp-acts button { padding: 3px 7px; border-radius: 6px; border: 1px solid var(--line); background: rgba(255,255,255,0.05); color: var(--fg); font: inherit; cursor: pointer; }
#planningPanel .pp-acts .pp-obj { border-color: rgba(216,66,58,0.6); background: rgba(216,66,58,0.14); }
#planningPanel .pp-offer { display: inline-flex; gap: 4px; } #planningPanel .pp-offer input { width: 80px; font: inherit; color: var(--fg); background: rgba(0,0,0,0.2); border: 1px solid var(--line); border-radius: 6px; padding: 2px 4px; }
#planningPanel .pp-empty, #planningPanel .pp-foot { color: var(--muted); padding: 2px 0; line-height: 1.35; }
#planningPanel .pp-foot { margin-top: 8px; font-size: 11px; }
`;
  document.head.appendChild(st);
}
