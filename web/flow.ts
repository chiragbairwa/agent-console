import type { Activity, Need, Worker } from '../src/types';
import type { Step, StepTrack, ToolCall } from '../src/steps';

/** The flow view: each box shows its steps instead of the terminal, the advisor box and
 *  the KPI strip show the whole fleet, and a hover card shows the tool calls of one step. */

/** The scrollTop that shows an item of height h at offset top in a box of height boxH. It moves as little as possible. */
export function nearestTop(scrollTop: number, boxH: number, top: number, h: number): number {
  if (top < scrollTop) return top;
  if (top + h > scrollTop + boxH) return top + h - boxH;
  return scrollTop;
}

export interface FlowSource {
  workers(): Worker[];
  steps(id: string): StepTrack | undefined;
  needs(): Need[];
  activity(): Activity[];
  onChange(): void;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const store = () => { try { return localStorage; } catch { return null; } };

export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
/** Empty when the start is unknown: a step seen only once its end was known has start = end. */
const stepDur = (s: Step, now: number) => (s.startedAt === undefined || s.startedAt === s.endedAt ? '' : dur((s.endedAt ?? now) - s.startedAt));
const current = (t: StepTrack | undefined) => t?.steps.find(s => s.status === 'in_progress');
const openCall = (s: Step | undefined) => s?.tools.findLast(c => c.end === undefined);

function marker(s: Step, i: number, blocked: boolean) {
  if (s.status === 'completed') return '<span class="mk done">✓</span>';
  if (s.status === 'in_progress') return blocked ? '<span class="mk block">!</span>' : `<span class="mk cur">${i + 1}</span>`;
  return `<span class="mk">${i + 1}</span>`;
}

export class Flow {
  /** true = every box shows its flow; a flipped id shows the other view. */
  all: boolean;
  private flipped: Set<string>;
  private hc: HTMLElement;
  private kpis: HTMLElement;
  private painted = new WeakMap<HTMLElement, string>();

  constructor(private src: FlowSource) {
    const ls = store();
    this.all = ls?.getItem('ac.view') === 'flow';
    try { this.flipped = new Set(JSON.parse(ls?.getItem('ac.flipped') ?? '[]')); } catch { this.flipped = new Set(); }

    this.hc = document.createElement('div'); this.hc.id = 'hc'; this.hc.setAttribute('role', 'tooltip');
    document.body.appendChild(this.hc);
    this.kpis = document.getElementById('kpis')!;

    const seg = document.getElementById('viewSeg')!;
    seg.addEventListener('click', e => {
      const v = (e.target as HTMLElement).closest('[data-v]') as HTMLElement | null;
      if (v) this.setAll(v.dataset.v === 'flow');
    });
    this.paintSeg();

    document.addEventListener('mouseover', e => this.hover(e));
    document.addEventListener('mousemove', e => { if (this.hc.classList.contains('on')) this.place(e); });
    // Durations move on their own.
    setInterval(() => { if (!document.hidden && this.anyFlow()) src.onChange(); }, 15_000);
  }

  private save() {
    const ls = store(); if (!ls) return;
    try { ls.setItem('ac.view', this.all ? 'flow' : 'term'); ls.setItem('ac.flipped', JSON.stringify([...this.flipped])); } catch { /* storage blocked */ }
  }
  private paintSeg() {
    for (const b of document.querySelectorAll<HTMLElement>('#viewSeg [data-v]')) b.classList.toggle('on', (b.dataset.v === 'flow') === this.all);
  }
  setAll(on: boolean) { this.all = on; this.flipped.clear(); this.save(); this.paintSeg(); this.src.onChange(); }
  flip(id: string) { this.flipped.has(id) ? this.flipped.delete(id) : this.flipped.add(id); this.save(); }
  isFlow(w: Worker) { return w.kind !== 'linked' && w.kind !== 'shell' && this.all !== this.flipped.has(w.id); }
  private anyFlow() { return this.src.workers().some(w => this.isFlow(w)); }

  // ---------- one box ----------
  renderNode(w: Worker, d: HTMLElement) {
    const on = this.isFlow(w);
    d.classList.toggle('flow', on);
    if (!on) return;
    const box = d.querySelector('.flow-box') as HTMLElement | null;
    if (!box) return;
    const html = w.role === 'advisor' ? this.advisorHTML() : this.workerHTML(w);
    if (this.painted.get(box) === html) return; // nothing changed: keep the scroll and the hover
    this.painted.set(box, html);
    box.innerHTML = html;
    // Scroll only this box. The DOM "scroll into view" call also scrolls #vp, and then the focus view moves up.
    const cur = box.querySelector<HTMLElement>('.f-step.cur');
    if (cur) {
      const top = cur.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      box.scrollTop = nearestTop(box.scrollTop, box.clientHeight, top, cur.offsetHeight);
    }
  }

  private blocked(w: Worker) { return w.status === 'needs-you' || this.src.needs().some(n => n.id === w.id && n.kind !== 'waiting'); }

  private workerHTML(w: Worker): string {
    const t = this.src.steps(w.id), now = Date.now();
    if (w.role === 'reviewer') {
      return `<div class="f-empty"><b>${esc(w.task || 'Reviewer')}</b>
        <span>Reviewer: gives advice to the advisor when asked.</span></div>`;
    }
    if (!t?.steps.length) {
      return `<div class="f-empty"><b>${esc(w.task || 'No steps yet')}</b>
        <span>Steps show here when the agent writes its checklist, or when you send it a prompt.</span></div>`;
    }
    const blocked = this.blocked(w);
    const bar = t.steps.map(s => `<i class="${s.status === 'completed' ? 'd' : s.status === 'in_progress' ? (blocked ? 'b' : 'c') : ''}"></i>`).join('');
    const done = t.steps.filter(s => s.status === 'completed').length;
    const rows = t.steps.map((s, i) => {
      const cls = s.status === 'completed' ? 'd' : s.status === 'in_progress' ? 'cur' : 'todo';
      const call = s.status === 'in_progress' ? openCall(s) : undefined;
      const live = s.status === 'in_progress'
        ? `<div class="f-live">${blocked ? '⚠ Waiting for you' : call ? `<b>${esc(call.tool)}</b> ${esc(call.detail)}` : esc(s.active ?? 'Working…')}</div>` : '';
      return `<div class="f-step ${cls}" data-sid="${esc(w.id)}" data-si="${i}">${marker(s, i, blocked)}<span class="t">${esc(s.text)}${s.note ? `<span class="nt">→ ${esc(s.note)}</span>` : ''}</span><span class="du">${stepDur(s, now)}</span></div>${live}`;
    }).join('');
    const src = t.source === 'prompt' ? '<div class="f-note">No checklist yet: one step for each prompt.</div>' : '';
    return `<div class="f-head"><span>${done} of ${t.steps.length} steps</span><div class="f-bar">${bar}</div></div><div class="f-list">${rows}</div>${src}`;
  }

  private advisorHTML(): string {
    const k = this.kpiData();
    const tiles = [k[0]!, k[1]!, k[2]!].map(x => `<div class="${x.warn ? 'warn' : ''}" data-kpi="${x.key}"><small>${x.label}</small><strong>${esc(x.value)}</strong></div>`).join('');
    const ev = this.src.activity().slice(-6).reverse().map(a => `<div><time>${hhmm(a.at)}</time><span>${esc(a.text)}</span></div>`).join('');
    return `<div class="f-kpi">${tiles}</div><div class="f-ev">${ev || '<span class="muted">No activity yet.</span>'}</div>`;
  }

  // ---------- KPI strip ----------
  private kpiData() {
    const ws = this.src.workers().filter(w => w.role === 'worker');
    const now = Date.now();
    let done = 0, total = 0, longest: { w: Worker; s: Step; ms: number } | null = null;
    for (const w of ws) {
      const t = this.src.steps(w.id); if (!t) continue;
      total += t.steps.length; done += t.steps.filter(s => s.status === 'completed').length;
      const c = current(t);
      if (c?.startedAt !== undefined && (!longest || now - c.startedAt > longest.ms)) longest = { w, s: c, ms: now - c.startedAt };
    }
    const asking = this.src.needs().filter(n => n.kind !== 'waiting').length;
    return [
      { key: 'running', label: 'Agents Running', value: `${ws.filter(w => w.status === 'running').length} / ${ws.length}` },
      { key: 'steps', label: 'Steps Done', value: `${done} / ${total}` },
      { key: 'needs', label: 'Needs You', value: String(asking), warn: asking > 0 },
      { key: 'longest', label: 'Longest Step', value: longest ? dur(longest.ms) : '—', sub: longest ? longest.w.name : '' },
      { key: 'done', label: 'Finished', value: String(ws.filter(w => w.status === 'done' || w.status === 'idle').length) },
    ];
  }

  renderKpis() {
    this.kpis.hidden = !this.anyFlow();
    if (this.kpis.hidden) return;
    this.kpis.innerHTML = this.kpiData().map(k =>
      `<div class="kpi ${k.warn ? 'warn' : ''}" data-kpi="${k.key}"><small>${k.label}</small><strong>${esc(k.value)}</strong>${k.sub ? `<span>${esc(k.sub)}</span>` : ''}</div>`).join('');
  }

  // ---------- hover card ----------
  private hover(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const step = t.closest('[data-sid]') as HTMLElement | null;
    const kpi = step ? null : t.closest('[data-kpi]') as HTMLElement | null;
    const html = step ? this.stepCard(step.dataset.sid!, Number(step.dataset.si)) : kpi ? this.kpiCard(kpi.dataset.kpi!) : '';
    if (!html) { this.hc.classList.remove('on'); return; }
    this.hc.innerHTML = html;
    this.hc.classList.add('on');
    this.place(e);
  }

  private place(e: MouseEvent) {
    const r = 14, w = this.hc.offsetWidth, h = this.hc.offsetHeight;
    let x = e.clientX + r, y = e.clientY + r;
    if (x + w > innerWidth - 8) x = e.clientX - w - r;
    if (y + h > innerHeight - 8) y = Math.max(8, e.clientY - h - r);
    this.hc.style.left = `${x}px`; this.hc.style.top = `${y}px`;
  }

  private stepCard(id: string, i: number): string {
    const w = this.src.workers().find(x => x.id === id), t = this.src.steps(id), s = t?.steps[i];
    if (!w || !t || !s) return '';
    const now = Date.now();
    const when = s.startedAt === undefined ? 'Not started' : `${hhmm(s.startedAt)} → ${s.endedAt ? hhmm(s.endedAt) : 'now'} · ${stepDur(s, now)}`;
    const call = (c: ToolCall) => `<li><span class="m ${c.end === undefined ? 'p' : 'x'}">${c.end === undefined ? '▶' : '✓'}</span>
      <span class="k">${esc(c.tool)}</span><span class="v">${esc(c.detail)}</span><span class="tm">${hhmm(c.at)}</span></li>`;
    const calls = s.tools.length
      ? `<ul>${s.tools.map(call).join('')}</ul>${s.tools.length >= 25 ? '<div class="note">Only the last 25 actions are kept.</div>' : ''}`
      : `<div class="note">${s.status === 'pending' ? 'Not started yet.' : 'No tool calls in this step.'}</div>`;
    return `<h4>${marker(s, i, s.status === 'in_progress' && this.blocked(w))} Step ${i + 1} of ${t.steps.length}: ${esc(s.text)}</h4>
      <div class="sub">${esc(w.name)} · ${when}</div>
      ${s.active && s.status === 'in_progress' ? `<div class="act">${esc(s.active)}…</div>` : ''}
      ${s.note ? `<div class="res">→ ${esc(s.note)}</div>` : ''}
      <div class="cap">Actions in this step</div>${calls}`;
  }

  private kpiCard(key: string): string {
    const ws = this.src.workers().filter(w => w.role === 'worker');
    if (key === 'needs') {
      const n = this.src.needs().filter(x => x.kind !== 'waiting');
      const name = (id: string) => ws.find(w => w.id === id)?.name ?? id;
      return `<h4>Needs You</h4><ul>${n.length ? n.map(x => `<li><span class="m p">⚠</span><span><b>${esc(name(x.id))}</b> ${esc(x.text)}</span></li>`).join('') : '<li class="note">Nothing waits on you.</li>'}</ul>`;
    }
    const now = Date.now();
    const rows = ws.map(w => {
      const t = this.src.steps(w.id), c = current(t);
      const done = t?.steps.filter(s => s.status === 'completed').length ?? 0;
      const what = c ? `${esc(c.text)} <span class="tm">${stepDur(c, now)}</span>` : `<span class="tm">${esc(w.status)}</span>`;
      return `<li><span class="dot s-${w.status}"></span><span><b>${esc(w.name)}</b> · ${done}/${t?.steps.length ?? 0}<br>${what}</span></li>`;
    }).join('');
    return `<h4>All Agents</h4><div class="sub">Current step of each agent</div><ul class="ag">${rows || '<li class="note">No workers yet.</li>'}</ul>`;
  }
}
