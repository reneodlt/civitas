import { REFUSE_ADDONS, VALUE_KINDS, TICKS_PER_HOUR, CAMPAIGN, PLAN_CLAIMS, conditionCost, type PlanAppDTO, type ClientMsg } from '@msimcity/shared';

/**
 * The Planning panel (docs/multiplayer-land.md section 6, M5): the open applications that are the player's own or reach
 * their land (or, for a road closure notice, that their land or traffic depends on), and those decided lately. Each shows
 * the site (a link: the camera goes there), the impact on others' land by kind against its limit, the time left, the
 * conditions and the community offer, and the voters on the frozen roll. Actions: the applicant may add a condition,
 * raise the offer or withdraw; an affected mayor may object to a road closure. A chip ("Planning · 2") shows while any
 * application concerns the player and opens the panel.
 *
 * M6 campaigns (shared/src/campaigns.ts): on an open application every stakeholder (the applicant and the mayors whose
 * land is in the zone) sees the campaigning on it (each side's spend against the cap, the public meeting, credibility)
 * and may start a campaign with a claim from the table, then leaflet the roll, call or speak at a meeting, or buy TV
 * spots; posters go up from the Campaigns panel like any campaign's.
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
  /** M6: a campaign intent on an application */
  campaign(m: Omit<Extract<ClientMsg, { t: 'planCampaign' }>, 't'>): void;
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
      else if (act === 'camp') {
        const sel = this.el.querySelector<HTMLSelectElement>(`select[data-claim="${id}"]`);
        const v = sel ? sel.value.split(':').map(Number) : [];
        if (v.length === 2) this.host.campaign({ id, act: 'create', claim: v[0], ...(v[1] ? { side: v[1] as 1 | -1 } : {}) });
      } else if (act === 'leaflet' || act === 'meeting' || act === 'tv' || act === 'end') this.host.campaign({ id, act, campaign: Number(b.dataset.c) });
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

  /** The campaigning on an open application (M6), with the stakeholder's actions. */
  private campaignHtml(a: PlanAppDTO, me: string, now: number): string {
    const c = a.camp!, mine = a.by === me, stake = mine || a.affected.includes(me), name = (id: string) => esc(id === me ? 'you' : this.host.nameOf(id));
    let h = `<div class="pp-camp"><div class="pp-row"><span>Campaigning</span><span>For ${money(c.spent[0])} · Against ${money(c.spent[1])} <em>(cap ${money(c.cap)} a side)</em></span></div>`;
    for (const k of c.campaigns) {
      const own = k.owner === me;
      h += `<div class="pp-cl ${k.side > 0 ? 'pp-for' : 'pp-against'}"><span>${k.side > 0 ? 'For' : 'Against'} · ${name(k.owner)}: "${esc(k.text)}"</span><span>${k.posters} poster${k.posters === 1 ? '' : 's'}${k.tv ? ' · TV' : ''}${k.leaflets ? ` · ${k.leaflets} doors` : ''} · ${k.reached} reached</span>`;
      if (own && (c.closesAt === undefined || now < c.closesAt)) {
        h += `<span class="pp-acts"><button data-act="leaflet" data-id="${a.id}" data-c="${k.id}" title="${money(CAMPAIGN.leafletCost)} a household on the roll">Leaflet the roll</button>`;
        const speaking = c.meeting?.speakers.includes(k.id);
        if (!c.meeting?.done && !speaking) h += `<button data-act="meeting" data-id="${a.id}" data-c="${k.id}" title="${c.meeting ? `speak: ${money(CAMPAIGN.speakCost)}` : `hire a hall: ${money(CAMPAIGN.meetingCost)}`}">${c.meeting ? 'Speak at the meeting' : 'Call a public meeting'}</button>`;
        if (!k.tv) h += `<button data-act="tv" data-id="${a.id}" data-c="${k.id}" title="${money(CAMPAIGN.tvCost)}: evening spots until the vote">TV spots</button>`;
        h += `<button data-act="end" data-id="${a.id}" data-c="${k.id}">End</button></span>`;
      }
      h += `</div>`;
    }
    if (c.meeting) h += `<div class="pp-row"><span>Public meeting</span><span data-jx="${c.meeting.x}" data-jy="${c.meeting.y}" class="pp-what">${esc(c.meeting.hall)}, ${c.meeting.done ? 'held' : `in ${Math.max(0, Math.round((c.meeting.at - now) / TICKS_PER_HOUR))} game h`}</span></div>`;
    if (stake) {
      const cred = c.cred[me] ?? 1;
      h += `<div class="pp-row"><span>Your credibility here</span><span>${cred.toFixed(2)}${cred < 1 ? ' (past claims proved false)' : cred > 1 ? ' (past claims borne out)' : ''}</span></div>`;
      if (c.closesAt === undefined || now < c.closesAt) {
        const opts = PLAN_CLAIMS.map((cl, i) => {
          if (cl.side === -1 && mine) return '';
          if (cl.side === 0) return `<option value="${i}:${mine ? 1 : -1}">Turnout: ${esc(cl.text)}</option>`;
          return `<option value="${i}:0">${cl.side > 0 ? 'For' : 'Against'}: ${esc(cl.text)}</option>`;
        }).join('');
        h += `<div class="pp-acts"><select data-claim="${a.id}">${opts}</select><button data-act="camp" data-id="${a.id}" title="${money(CAMPAIGN.artCost)} artwork; then posters (Campaigns panel), leaflets, a meeting or TV">Start a campaign</button></div>`;
      } else h += `<div class="pp-result">The vote is within the hour: no new campaigning.</div>`;
    }
    return h + `</div>`;
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
      if (a.camp && a.status === 'open') html += this.campaignHtml(a, me, now);
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
    html += `<div class="pp-foot">The roll is frozen when a plan is filed. Each resident weighs what it would do to their own home, what they have heard, the offer and the jobs; opponents turn out more readily. Refused plans are refunded; the site then cools off. The applicant and owners in the zone may campaign: once a plan is built, residents find out which claims were true, and credibility follows.</div>`;
    // keep a half-typed offer
    const typing = (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement) && this.el.contains(document.activeElement) ? document.activeElement : null;
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
#planningPanel .pp-camp { display: grid; gap: 3px; margin-top: 3px; padding-top: 4px; border-top: 1px dashed var(--line); }
#planningPanel .pp-camp em { color: var(--muted); font-style: normal; }
#planningPanel .pp-cl { display: grid; gap: 2px; padding: 2px 4px; border-left: 3px solid var(--line); }
#planningPanel .pp-cl span:nth-child(2) { color: var(--muted); }
#planningPanel .pp-for { border-left-color: rgba(94,200,120,0.8); } #planningPanel .pp-against { border-left-color: rgba(216,66,58,0.8); }
#planningPanel .pp-camp select { font: inherit; color: var(--fg); background: rgba(0,0,0,0.2); border: 1px solid var(--line); border-radius: 6px; padding: 2px; max-width: 250px; }
#planningPanel .pp-empty, #planningPanel .pp-foot { color: var(--muted); padding: 2px 0; line-height: 1.35; }
#planningPanel .pp-foot { margin-top: 8px; font-size: 11px; }
`;
  document.head.appendChild(st);
}
