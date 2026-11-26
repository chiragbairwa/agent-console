import { BoxTerm, FocusTerm } from './term';
import { Canvas, linkKey, type Pos, type Wire } from './canvas';
import { loadCanvas, saveCanvas } from './restore';
import type { Activity, Link, Need, StateEvent, Worker } from '../src/types';
import type { StepTrack } from '../src/steps';
import { Flow } from './flow';
import { initHosts, type HostInfo } from './hosts';
import { laneLayout, type Lane } from './lanes';
import { openSendDialog } from './sendtohost';
import { pasteText, pathsFromDrop } from './drop';

/** One agent from GET /api/agents. */
interface AgentOpt { key: string; label: string; kind: 'select' | 'text'; choices?: string[]; default?: string }
interface AgentInfo { id: string; label: string; icon: string; color: string; caps: { guard?: boolean; advisor?: boolean }; options: AgentOpt[] }

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

// ---------- state ----------
const workers = new Map<string, Worker>();
let links: Link[] = [];
let needs: Need[] = [];
const queued: Record<string, number> = {};
const talking = new Map<string, number>(); // linkKey → until ts
const els = new Map<string, HTMLElement>();
const terms = new Map<string, BoxTerm>();
const sel = new Set<string>();
let focus: { id: string; term: FocusTerm } | null = null;
const steps = new Map<string, StepTrack>();
const acts: Activity[] = [];
let agents: AgentInfo[] = []; // API order. The first entry is the fallback for a worker with no agent.
const hostMap = new Map<string, HostInfo>();
const HOST_COLORS = ['#e0802b', '#2b9fe0', '#2bb673', '#d6457a', '#8a6ee0', '#c2a21f'];
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;
const hostColor = (h: HostInfo) => (h.color && SAFE_COLOR.test(h.color) ? h.color : '') || HOST_COLORS[[...h.id].reduce((n, c) => n + c.charCodeAt(0), 0) % HOST_COLORS.length]!;
/** The pill for a worker on another machine. Empty for a local worker. */
function hostBadge(id: string | undefined): string {
  if (!id || id === 'local') return '';
  const h = hostMap.get(id);
  return `<span class="hostb" style="--hc:${esc(h ? hostColor(h) : 'var(--you)')}" title="Runs on ${esc(h?.name ?? id)}">${esc(h?.name ?? id)}</span>`;
}
const agentOf = (w: Worker): AgentInfo | undefined => w.agent ? agents.find(a => a.id === w.agent) : agents[0];

const vp = $('#vp'), world = $('#world');
const canvas = new Canvas(vp, world, $<SVGGElement>('#gl'), $<SVGGElement>('#gp'), $<SVGSVGElement>('#mini'), $('#zLbl'),
  (): Pos[] => [...workers.values()].filter(w => els.has(w.id)).map(w => ({ id: w.id, x: w.x, y: w.y, el: els.get(w.id)! })),
  (): Wire[] => links.map(l => ({ ...l, talk: (talking.get(linkKey(l.a, l.b)) ?? 0) > Date.now() })));

// ---------- flow view (steps, KPI strip, hover card) ----------
const flow = new Flow({
  workers: () => [...workers.values()], steps: id => steps.get(id), needs: () => needs, activity: () => acts,
  // Refit after the batched render frame, so a sized terminal that became visible measures its new box.
  onChange: () => { markNode('all', true); requestAnimationFrame(() => requestAnimationFrame(() => refitSized())); },
});

// ---------- api ----------
async function api(path: string, body?: object) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!r.ok) { const e = await r.json().catch(() => ({})) as { error?: string }; feed(`Error: ${e.error ?? r.status}`); }
  return r;
}

// ---------- nodes ----------
const isLinked = (w: Worker) => w.kind === 'linked';
const isShell = (w: Worker) => w.kind === 'shell';
const SHELL_ICON = '<svg class="shicon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3"/></svg>';

function nodeEl(w: Worker): HTMLElement {
  let d = els.get(w.id);
  const kind = isLinked(w) ? 'linked' : 'tmux';
  if (d && d.dataset.kind !== kind) { // moved into the console: rebuild as a live terminal
    terms.get(w.id)?.dispose(); terms.delete(w.id); d.remove(); els.delete(w.id); d = undefined;
  }
  if (d) return d;
  d = document.createElement('div');
  d.className = 'node' + (w.role === 'advisor' ? ' adv' : w.role === 'reviewer' ? ' rev' : '') + (kind === 'linked' ? ' linked' : '');
  d.dataset.id = w.id; d.dataset.kind = kind;
  const body = kind === 'linked'
    ? `<div class="linked-box"><div class="lk-tag">↗ Linked: runs in its own terminal tab. The advisor reaches it with SendMessage.</div>
       <div class="tx">Loading the latest messages…</div>
       <div class="lk-acts"><button class="tb" data-act="adopt">Move into Console</button><button class="tb" data-act="unlink">Unlink</button></div></div>`
    : `<div class="term-box"></div><div class="flow-box"></div>`;
  d.innerHTML = `<div class="hd" title="Drag to move · double-click to focus · shift+click to select"><span class="dot"></span>${isShell(w) ? SHELL_ICON : ''}<b></b><span class="agent-chip" hidden></span><span class="hostslot"></span><span class="repo"></span>
    <span class="qchip" hidden></span><span class="badge" hidden>⚠</span>
    ${kind === 'linked' ? '' : `${isShell(w) ? '' : '<button class="ib" data-act="flip" title="Swap terminal and flow for this box">⇄</button>'}<button class="ib" data-act="focus" title="Focus">⤢</button>`}<button class="ib" data-act="menu" title="More">⋯</button></div>
    <div class="task"></div>${body}${isShell(w) ? '' : '<div class="port" title="Drag to another box to connect"></div>'}
    <div class="grip" title="Drag to resize · double-click to reset"></div>`;
  world.appendChild(d);
  els.set(w.id, d);
  if (kind === 'linked') void refreshTranscript(w.id);
  else terms.set(w.id, new BoxTerm(w.id, d.querySelector('.term-box') as HTMLElement, () => focus?.id === w.id));
  return d;
}

async function refreshTranscript(id: string) {
  const box = els.get(id)?.querySelector('.tx') as HTMLElement | null;
  if (!box) return;
  const r = await fetch(`/api/workers/${id}/transcript`);
  if (!r.ok) return;
  const { messages } = await r.json() as { messages: { role: string; text: string }[] };
  const html = messages.length
    ? messages.slice(-6).map(m => `<div class="${m.role === 'user' ? 'u' : 'a'}">${m.role === 'user' ? '› ' : ''}${esc(m.text.slice(0, 400))}</div>`).join('<br>')
    : '<span class="empty">No messages yet.</span>';
  if (box.dataset.html === html) return; // nothing new: keep the DOM and the reader's scroll
  box.dataset.html = html; box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}
const refreshLinked = () => { for (const w of workers.values()) if (isLinked(w)) void refreshTranscript(w.id); };
setInterval(() => { if (!document.hidden) refreshLinked(); }, 5000);

async function moveIntoConsole(w: Worker, btn: HTMLElement) {
  if (!btn.dataset.sure) {
    btn.dataset.sure = '1';
    btn.textContent = 'Click Again: Stops It in Its Tab';
    setTimeout(() => { delete btn.dataset.sure; btn.textContent = 'Move into Console'; }, 5000);
    return;
  }
  btn.textContent = 'Moving…';
  await api(`/api/external/${w.pid}`, { mode: 'adopt' });
}

function renderNode(w: Worker) {
  const d = nodeEl(w);
  d.style.left = `${w.x}px`; d.style.top = `${w.y}px`;
  (d.querySelector('.dot') as HTMLElement).className = `dot s-${w.status}`;
  (d.querySelector('b') as HTMLElement).textContent = w.name;
  (d.querySelector('.repo') as HTMLElement).textContent = [w.repo, w.branch].filter(Boolean).join(' · ');
  (d.querySelector('.task') as HTMLElement).textContent = w.task;
  (d.querySelector('.hostslot') as HTMLElement).innerHTML = hostBadge(w.host);
  const ag = agentOf(w), chip = d.querySelector('.agent-chip') as HTMLElement;
  chip.hidden = !ag;
  if (ag) {
    const model = w.options?.model;
    chip.textContent = `${ag.icon} ${ag.label}${model ? ` · ${model}` : ''}`;
    chip.style.setProperty('--ac', ag.color);
    d.style.setProperty('--ac', ag.color);
    d.classList.add('has-agent');
    chip.title = ag.caps.guard === false ? 'Guard off: this agent runs without the permission guard' : ag.label;
    if (ag.caps.guard === false) { chip.dataset.guard = 'off'; chip.textContent += ' · guard off'; }
    else delete chip.dataset.guard;
  } else d.classList.remove('has-agent');
  (d.querySelector('.badge') as HTMLElement).hidden = !needs.some(n => n.id === w.id && n.kind !== 'waiting');
  const q = d.querySelector('.qchip') as HTMLElement;
  q.hidden = !queued[w.id]; q.textContent = `${queued[w.id] ?? 0} queued`;
  d.classList.toggle('sel', sel.has(w.id));
  applySize(w, d);
  flow.renderNode(w, d);
  if (focus?.id === w.id) renderFocus();
}

/** The smallest box keeps the title bar usable (the same values as the server clamp). */
const MIN_W = 360, MIN_H = 220, MAX_W = 2400, MAX_H = 1600;

/** Set the box size. Without a saved size, clear it so the default CSS applies. */
function setBoxSize(d: HTMLElement, w?: number, h?: number) {
  const on = w !== undefined && h !== undefined;
  d.classList.toggle('sized', on);
  d.style.width = on ? `${w}px` : ''; d.style.height = on ? `${h}px` : '';
}

/** Apply the saved size of a worker and fit its terminal, only when the size changed. */
function applySize(w: Worker, d: HTMLElement) {
  if (mode?.kind === 'resize' && mode.id === w.id) return; // the drag owns the size until pointerup
  const key = w.w !== undefined && w.h !== undefined ? `${w.w}x${w.h}` : '';
  if (d.dataset.size === key) return;
  const first = d.dataset.size === undefined;
  d.dataset.size = key;
  setBoxSize(d, w.w, w.h);
  if (first && !key) return; // a box at the default size: keep BASE, send nothing
  requestAnimationFrame(() => { terms.get(w.id)?.fit(!!key); canvas.schedule(); });
}

/** Fit the terminals of sized boxes again (all, or one id), for example after a switch from Flow
 *  to Terminals. A terminal that is still hidden does nothing. */
function refitSized(id?: string) {
  for (const w of workers.values()) {
    if ((id && w.id !== id) || w.w === undefined || w.h === undefined) continue;
    terms.get(w.id)?.fit(true);
  }
}

/** The size to give back to the PTY when focus mode closes. */
const boxSize = (id: string) => terms.get(id)?.size();

function removeNode(id: string) {
  steps.delete(id);
  terms.get(id)?.dispose(); terms.delete(id);
  els.get(id)?.remove(); els.delete(id);
  workers.delete(id); sel.delete(id);
  setLanes(null);
  if (focus?.id === id) closeFocus();
}

// ---------- frame batching: a burst of state events becomes one render per box ----------
const dirty = new Set<string>();
let flushQueued = false, kpisDirty = false;
function markNode(id: string | 'all', kpis = false) {
  if (id === 'all') for (const k of workers.keys()) dirty.add(k); else dirty.add(id);
  kpisDirty ||= kpis;
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    flushQueued = false;
    for (const k of dirty) { const w = workers.get(k); if (w) renderNode(w); }
    dirty.clear();
    if (kpisDirty) { kpisDirty = false; flow.renderKpis(); }
    canvas.schedule();
  });
}

function dimForSel() {
  for (const [id, el] of els) {
    const near = !sel.size || sel.has(id) || links.some(l => (sel.has(l.a) && l.b === id) || (sel.has(l.b) && l.a === id));
    el.classList.toggle('dim', !near);
  }
}

function renderAll() {
  for (const w of workers.values()) renderNode(w);
  canvas.draw(); renderNeeds(); renderSel(); target(); dimForSel(); flow.renderKpis();
}

// ---------- side panel ----------
function renderNeeds() {
  const order = { guard: 0, question: 1, permission: 2, waiting: 3 };
  const list = [...needs].sort((a, b) => order[a.kind] - order[b.kind]);
  $('#nCount').textContent = list.length ? String(list.length) : '';
  const name = (id: string) => esc(workers.get(id)?.name ?? id);
  $('#needs').innerHTML = list.length ? list.map(n => {
    const acts = n.kind === 'guard'
      ? `<button class="yes" data-allow="${n.nid}">Allow</button><button class="no" data-deny="${n.nid}">Deny</button><button data-open="${n.id}">Open</button>`
      : n.kind === 'question'
        ? `<form data-answer="${n.nid}" style="display:flex;gap:6px;width:100%"><input placeholder="Your answer"><button class="yes">Answer</button></form>`
        : `<button data-open="${n.id}">Open</button>`;
    const label = { guard: 'asks to run', question: 'asks you', permission: 'needs permission', waiting: 'is waiting' }[n.kind];
    return `<div class="need ${n.kind === 'waiting' ? 'soft' : ''}"><div class="who" data-open="${n.id}">${n.kind === 'waiting' ? '◌' : '⚠'} ${name(n.id)}${hostBadge(workers.get(n.id)?.host)} ${label}</div>${esc(n.text)}<div class="acts">${acts}</div></div>`;
  }).join('') : '<div class="empty">Nothing waits on you.</div>';
  markNode('all');
}

$('#needs').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.dataset.open) return openFocus(t.dataset.open);
  if (t.dataset.allow) void api(`/api/needs/${t.dataset.allow}`, { decision: 'allow' });
  if (t.dataset.deny) void api(`/api/needs/${t.dataset.deny}`, { decision: 'deny' });
});
$('#needs').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  const text = (f.querySelector('input') as HTMLInputElement).value.trim();
  if (text) void api(`/api/needs/${f.dataset.answer}`, { decision: 'answer', text });
});

function renderSel() {
  const s = [...sel].map(id => workers.get(id)).filter(Boolean) as Worker[];
  const el = $('#selInfo');
  el.className = s.length ? '' : 'empty';
  el.innerHTML = s.length
    ? `${s.map(w => `<b>${esc(w.name)}</b>`).join(', ')}<br><span class="empty">The command bar sends to ${s.length > 1 ? `these ${s.length} sessions` : 'this session'}. <kbd>F</kbd> focus · <kbd>Esc</kbd> clear.</span>`
    : 'Nothing selected. The command bar talks to the advisor.';
}

function feed(text: string, at = Date.now()) {
  acts.push({ at, text }); if (acts.length > 50) acts.splice(0, acts.length - 50);
  const f = $('#feed'), d = document.createElement('div');
  d.innerHTML = `<time>${hhmm(at)}</time>${esc(text)}`;
  f.prepend(d);
  while (f.children.length > 200) f.lastElementChild!.remove();
}

// ---------- state socket ----------
function onEvent(ev: StateEvent) {
  switch (ev.t) {
    case 'snapshot':
      for (const id of [...workers.keys()]) if (!ev.state.workers.some(w => w.id === id)) removeNode(id);
      for (const w of ev.state.workers) workers.set(w.id, w);
      links = ev.state.links; needs = ev.needs;
      for (const k of Object.keys(queued)) delete queued[k];
      Object.assign(queued, ev.queued);
      $('#feed').innerHTML = ''; acts.length = 0;
      steps.clear(); for (const [id, t] of Object.entries(ev.state.steps ?? {})) steps.set(id, t);
      ev.state.activity.slice(-100).forEach((a: Activity) => feed(a.text, a.at));
      renderAll(); renderAdvisorBtn();
      for (const t of terms.values()) t.reconnect();
      focus?.term.reconnect(); // the server restarted: the old focus socket is dead
      setTimeout(() => { canvas.draw(); if (!fitted) { fitted = true; if (!restoreCanvas()) canvas.fit(); } }, 400);
      break;
    case 'worker': if (!workers.has(ev.worker.id)) setLanes(null); workers.set(ev.worker.id, ev.worker); markNode(ev.worker.id); if (ev.worker.id === 'advisor') renderAdvisorBtn(); break;
    case 'removed': removeNode(ev.id); canvas.schedule(); break;
    case 'links': links = ev.links; canvas.schedule(); dimForSel(); break;
    case 'needs': needs = ev.needs; renderNeeds(); kpisDirty = true; break;
    case 'queued': queued[ev.id] = ev.count; markNode(ev.id); break;
    case 'activity': feed(ev.item.text, ev.item.at); markNode('advisor'); break;
    case 'host': {
      const h = hostMap.get(ev.id);
      if (h) {
        const changed = h.state !== ev.state;
        h.state = ev.state; h.latencyMs = ev.latencyMs; h.lastError = ev.lastError;
        if (changed) { renderHostSwitch(); drawLanes(); }
      }
      else void loadHosts();
      break;
    }
    case 'steps': steps.set(ev.id, ev.track); markNode(ev.id, true); break;
    case 'pulse':
      talking.set(linkKey(ev.from, ev.to), Date.now() + 2500);
      canvas.draw(); canvas.pulse(ev.from, ev.to);
      setTimeout(() => canvas.schedule(), 2600);
      break;
  }
}

let fitted = false;
function connectState() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/state`);
  ws.onopen = () => { $('#conn').className = 'conn on'; $('#conn').textContent = '● live'; };
  ws.onmessage = e => onEvent(JSON.parse(String(e.data)));
  ws.onclose = () => { $('#conn').className = 'conn off'; $('#conn').textContent = '● offline'; setTimeout(connectState, 2000); };
}

// ---------- pointer: pan, drag, connect ----------
type Mode = { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'drag'; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; add: boolean }
  | { kind: 'connect'; from: string }
  | { kind: 'resize'; id: string; sx: number; sy: number; ow: number; oh: number; moved: boolean } | null;
let mode: Mode = null;

vp.addEventListener('pointerdown', e => {
  const t = e.target as HTMLElement;
  if (t.closest('#zoom,#mini,#focus,#importDlg,.pop,button,.term-box,.tx')) return;
  closePop();
  const hit = t.closest('.hit') as SVGElement | null;
  if (hit) return linkPop(hit.dataset.k!, e);
  const node = t.closest('.node') as HTMLElement | null;
  if (t.closest('.grip') && node) {
    mode = { kind: 'resize', id: node.dataset.id!, sx: e.clientX, sy: e.clientY, ow: node.offsetWidth, oh: node.offsetHeight, moved: false };
  } else if (t.closest('.port') && node) {
    mode = { kind: 'connect', from: node.dataset.id! };
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('class', 'wire you'); p.id = 'tmp';
    $('#gp').appendChild(p);
  } else if (t.closest('.hd') && node) {
    const w = workers.get(node.dataset.id!)!;
    mode = { kind: 'drag', id: w.id, sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y, moved: false, add: e.shiftKey || e.ctrlKey || e.metaKey };
  } else if (!node) {
    mode = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: canvas.view.x, oy: canvas.view.y };
    vp.classList.add('panning');
  } else return;
  // A drag, a pan, a connect or a resize must not select the text of the boxes that the pointer moves over.
  e.preventDefault();
  window.getSelection()?.removeAllRanges();
  vp.classList.add('moving');
  vp.setPointerCapture(e.pointerId);
});

vp.addEventListener('pointermove', e => {
  if (!mode) return;
  if (mode.kind === 'pan') { canvas.view.x = mode.ox + e.clientX - mode.sx; canvas.view.y = mode.oy + e.clientY - mode.sy; canvas.apply(); }
  else if (mode.kind === 'drag') {
    const dx = (e.clientX - mode.sx) / canvas.view.z, dy = (e.clientY - mode.sy) / canvas.view.z;
    if (Math.abs(dx) + Math.abs(dy) > 3) mode.moved = true;
    const w = workers.get(mode.id)!; w.x = mode.ox + dx; w.y = mode.oy + dy;
    const el = els.get(w.id)!; el.style.left = `${w.x}px`; el.style.top = `${w.y}px`;
    canvas.schedule();
  } else if (mode.kind === 'resize') {
    // The threshold is in screen px, so a small jitter in a double-click is not a resize at any zoom.
    if (Math.hypot(e.clientX - mode.sx, e.clientY - mode.sy) > 4) mode.moved = true;
    if (!mode.moved) return;
    const dx = (e.clientX - mode.sx) / canvas.view.z, dy = (e.clientY - mode.sy) / canvas.view.z;
    const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));
    setBoxSize(els.get(mode.id)!, clamp(mode.ow + dx, MIN_W, MAX_W), clamp(mode.oh + dy, MIN_H, MAX_H));
    canvas.schedule();
  } else if (mode.kind === 'connect') {
    const n = workers.get(mode.from)!, el = els.get(mode.from)!, p = canvas.toWorld(e.clientX, e.clientY);
    ($('#tmp') as Element)?.setAttribute('d', `M${n.x + el.offsetWidth},${n.y + 26} L${p.x},${p.y}`);
  }
});

vp.addEventListener('pointerup', e => {
  if (mode?.kind === 'connect') {
    $('#tmp')?.remove();
    const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.node') as HTMLElement | null;
    if (target && target.dataset.id !== mode.from) void api('/api/links', { a: mode.from, b: target.dataset.id, op: 'connect' });
  } else if (mode?.kind === 'drag') {
    const w = workers.get(mode.id)!;
    if (mode.moved) { setLanes(null); void api(`/api/workers/${w.id}/move`, { x: Math.round(w.x), y: Math.round(w.y) }); }
    else clickNode(w.id, mode.add);
  } else if (mode?.kind === 'resize' && mode.moved) {
    const id = mode.id, el = els.get(id)!;
    const w = el.offsetWidth, h = el.offsetHeight;
    // Keep the new size locally before endMode, which puts back the saved size.
    // Fit now; the worker event from the server then finds the same size and does nothing.
    const wk = workers.get(id);
    if (wk) { wk.w = w; wk.h = h; el.dataset.size = `${w}x${h}`; }
    endMode();
    terms.get(id)?.fit(true); canvas.schedule();
    setLanes(null);
    void api(`/api/workers/${id}/resize`, { w, h });
    return;
  }
  endMode();
});

/** Stop the current drag, pan, connect or resize. Also on pointercancel, so text selection comes back. */
function endMode() {
  if (mode?.kind === 'connect') $('#tmp')?.remove();
  if (mode?.kind === 'resize') { // cancelled: go back to the saved size
    const id = mode.id, w = workers.get(id), el = els.get(id);
    mode = null;
    if (w && el) setBoxSize(el, w.w, w.h);
  }
  mode = null; vp.classList.remove('panning', 'moving');
}
vp.addEventListener('pointercancel', endMode);

vp.addEventListener('dblclick', e => {
  // Pointer capture retargets the event to #vp, so look at what is under the cursor.
  const t = (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) as HTMLElement;
  const n = t.closest('.node') as HTMLElement | null;
  if (n && t.closest('.hd')) openFocus(n.dataset.id!);
  else if (n && t.closest('.grip')) void api(`/api/workers/${n.dataset.id}/resize`, { reset: true });
});

vp.addEventListener('wheel', e => {
  const t = e.target as HTMLElement;
  if (t.closest('#focus')) return;
  if (t.closest('.term-box') && !e.ctrlKey) return; // let the terminal scroll
  const fb = t.closest('.flow-box') as HTMLElement | null;
  if (fb && !e.ctrlKey && fb.scrollHeight > fb.clientHeight) return; // let a long checklist scroll
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  canvas.zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

world.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!b) return;
  const id = (b.closest('.node') as HTMLElement).dataset.id!;
  const w = workers.get(id); if (!w) return;
  if (b.dataset.act === 'focus') openFocus(id);
  else if (b.dataset.act === 'flip') { flow.flip(id); renderNode(w); refitSized(id); flow.renderKpis(); canvas.draw(); }
  else if (b.dataset.act === 'adopt') void moveIntoConsole(w, b);
  else if (b.dataset.act === 'unlink') void api(`/api/workers/${id}/remove`, {});
  else nodeMenu(id, b);
});

function clickNode(id: string, add: boolean) {
  if (add) { sel.has(id) ? sel.delete(id) : sel.add(id); }
  else { const only = sel.size === 1 && sel.has(id); sel.clear(); if (!only) sel.add(id); }
  for (const w of workers.values()) renderNode(w);
  renderSel(); target(); dimForSel();
}

// ---------- popovers ----------
let pop: HTMLElement | null = null;
function closePop() { pop?.remove(); pop = null; }
function popAt(x: number, y: number, html: string) {
  closePop();
  pop = document.createElement('div'); pop.className = 'pop'; pop.innerHTML = html;
  vp.appendChild(pop);
  const r = vp.getBoundingClientRect();
  pop.style.left = `${Math.min(x - r.left, r.width - 200)}px`;
  pop.style.top = `${Math.min(y - r.top, r.height - pop.offsetHeight - 10)}px`;
  return pop;
}

function linkPop(k: string, e: PointerEvent) {
  const l = links.find(x => linkKey(x.a, x.b) === k); if (!l) return;
  const n = (id: string) => esc(workers.get(id)?.name ?? id);
  const p = popAt(e.clientX, e.clientY, `<div class="cap">${n(l.a)} ↔ ${n(l.b)} · made by ${l.by}</div><button data-x="cut" class="danger">Cut Connection</button>`);
  p.onclick = ev => { if ((ev.target as HTMLElement).dataset.x === 'cut') void api('/api/links', { a: l.a, b: l.b, op: 'cut' }); closePop(); };
}

function nodeMenu(id: string, btn: HTMLElement) {
  const w = workers.get(id)!; const r = btn.getBoundingClientRect();
  if (isLinked(w)) {
    const p = popAt(r.left, r.bottom + 4, `<div class="cap">Linked · pid ${w.pid}</div><button data-x="adopt">Move into Console</button>
      <button data-x="sel">Add to Selection</button><button data-x="editor">Open in VS Code</button><button data-x="unlink" class="danger">Unlink (Keeps It Running)</button>`);
    p.onclick = ev => {
      const t = ev.target as HTMLElement, x = t.dataset.x; if (!x) return;
      if (x === 'adopt') { void moveIntoConsole(w, t); if (!t.dataset.sure) closePop(); return; }
      closePop();
      if (x === 'sel') clickNode(id, true);
      else if (x === 'editor') void api(`/api/workers/${id}/open-editor`, {});
      else if (x === 'unlink') void api(`/api/workers/${id}/remove`, {});
    };
    return;
  }
  const p = popAt(r.left, r.bottom + 4, `<button data-x="focus">Focus Terminal</button><button data-x="sel">Add to Selection</button>
    <button data-x="interrupt">Interrupt</button>
    ${w.status === 'stopped' ? '<button data-x="resume">Resume Last Session</button><button data-x="fresh">Start Fresh</button>' : '<button data-x="stop">Stop</button><button data-x="resume">Restart (Resume)</button>'}
    <button data-x="editor">Open in VS Code</button>
    ${w.role === 'advisor' ? ([...workers.values()].some(x => x.role === 'reviewer') ? '<button data-x="swap">Swap Roles</button><button data-x="rmrev" class="danger">Remove Reviewer</button>' : '<button data-x="addrev">Add Reviewer…</button>')
      : w.role === 'reviewer' ? '<button data-x="rmrev" class="danger">Remove Reviewer</button>'
      : '<button data-x="remove" class="danger">Remove Worker</button>'}`);
  p.onclick = ev => {
    const t = ev.target as HTMLElement, x = t.dataset.x; if (!x) return;
    // These items need a second click.
    const sure = { remove: 'Click Again to Remove', rmrev: 'Click Again to Remove Reviewer', swap: 'Click Again to Swap Roles' }[x];
    if (sure && !t.dataset.sure) { t.dataset.sure = '1'; t.textContent = sure; return; }
    if (x === 'addrev') { addReviewerPop(r); return; }
    closePop();
    if (x === 'rmrev') { void api('/api/reviewer/remove', {}); return; }
    if (x === 'swap') { void api('/api/reviewer/swap-roles', {}); return; }
    if (x === 'focus') openFocus(id);
    else if (x === 'sel') clickNode(id, true);
    else if (x === 'resume') void api(`/api/workers/${id}/restart`, { resume: true });
    else if (x === 'fresh') void api(`/api/workers/${id}/restart`, { resume: false });
    else if (x === 'editor') void api(`/api/workers/${id}/open-editor`, {});
    else void api(`/api/workers/${id}/${x}`, {});
  };
}

/** Show the adapters that can take the reviewer seat. A pick adds the reviewer. */
function addReviewerPop(r: DOMRect) {
  const opts = agents.filter(a => a.caps.advisor);
  const p = popAt(r.left, r.bottom + 4, `<div class="cap">Reviewer Agent</div>${opts.map(a =>
    `<button data-agent="${esc(a.id)}">${esc(a.icon)} ${esc(a.label)}</button>`).join('')}`);
  p.onclick = ev => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('button[data-agent]'); if (!t) return;
    closePop();
    void api('/api/reviewer', { agent: t.dataset.agent });
  };
}

// ---------- focus mode ----------
function openFocus(id: string) {
  const fw = workers.get(id);
  if (!fw) return;
  if (isLinked(fw)) { feed(`${fw.name} is linked: use Move into Console to get a live terminal here.`); return; }
  closePop();
  if (focus?.id === id) { focus.term.focus(); return; }
  if (focus) focus.term.dispose(boxSize(focus.id));
  $('#focus').hidden = false;
  focus = { id, term: new FocusTerm(id, $('#fTerm')) };
  renderFocus();
}
function closeFocus() {
  if (!focus) return;
  focus.term.dispose(boxSize(focus.id)); focus = null;
  $('#focus').hidden = true;
  canvas.draw();
}
function renderFocus() {
  if (!focus) return;
  const w = workers.get(focus.id); if (!w) return closeFocus();
  $('#fName').textContent = w.name;
  $('#fRepo').textContent = [w.repo, w.branch].filter(Boolean).join(' · ');
  $('#fDot').className = `dot s-${w.status}`;
  $('#fStop').textContent = w.status === 'stopped' ? 'Resume' : 'Stop';
  $('#fSend').hidden = isShell(w) || !((!w.host || w.host === 'local') && hostMap.size > 0);
  const con = links.filter(l => l.a === w.id || l.b === w.id)
    .map(l => (workers.get(l.a === w.id ? l.b : l.a)?.name ?? '?') + (l.by === 'you' ? ' (yours)' : '')).join(', ') || 'none';
  const nd = needs.filter(n => n.id === w.id).map(n => n.text).join('; ') || '—';
  const rows: [string, unknown][] = [['Status', w.status], ['Task', w.task], ['Folder', w.cwd], ['Branch', w.branch ?? '—'],
    ['Connected to', con], ['Needs you', nd], ['Queued', queued[w.id] ?? 0], ['tmux', `tmux -L agent-console attach -t ac-${w.id}`]];
  $('#fDl').innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join('');
  $('#fStrip').innerHTML = [...workers.values()].map((x, i) =>
    `<button class="thumb ${x.id === w.id ? 'on' : ''}" data-f="${x.id}"><span class="dot s-${x.status}"></span>${esc(x.name)} <kbd>${i + 1}</kbd></button>`).join('');
}
$('#fStrip').onclick = e => { const b = (e.target as HTMLElement).closest('[data-f]') as HTMLElement | null; if (b) openFocus(b.dataset.f!); };
$('#fBack').onclick = closeFocus;
// The terminal takes the whole canvas; the details panel is opt-in and remembered per browser.
function showInfo(on: boolean) {
  $('#fBody').classList.toggle('info', on); $('#fInfo').classList.toggle('on', on);
  try { localStorage.setItem('ac.focusInfo', on ? '1' : '0'); } catch { /* storage blocked */ }
}
showInfo((() => { try { return localStorage.getItem('ac.focusInfo') === '1'; } catch { return false; } })());
$('#fInfo').onclick = () => { showInfo(!$('#fBody').classList.contains('info')); focus?.term.focus(); };
$('#fSend').onclick = () => {
  const w = focus && workers.get(focus.id); if (!w) return;
  openSendDialog({ workerId: w.id, workerName: w.name, hosts: [...hostMap.values()], hostColor: id => { const h = hostMap.get(id); return h ? hostColor(h) : 'var(--you)'; }, api, esc });
};
$('#fInt').onclick = () => focus && void api(`/api/workers/${focus.id}/interrupt`, {});
$('#fEditor').onclick = () => focus && void api(`/api/workers/${focus.id}/open-editor`, {});
$('#fStop').onclick = () => {
  if (!focus) return;
  const w = workers.get(focus.id);
  void api(`/api/workers/${focus.id}/${w?.status === 'stopped' ? 'restart' : 'stop'}`, { resume: true });
};

// ---------- command bar ----------
function target() {
  const v = ($('#cmdin') as HTMLInputElement).value, m = v.match(/^@(\S+)/), t = $('#target');
  if (m) { t.textContent = `→ @${m[1]}`; return; }
  t.textContent = sel.size ? `→ ${[...sel].map(id => workers.get(id)?.name ?? id).join(', ')}` : '→ Advisor';
}
$('#cmdin').addEventListener('input', target);
$('#cmdForm').addEventListener('submit', e => {
  e.preventDefault();
  const i = $('#cmdin') as HTMLInputElement, v = i.value.trim();
  if (!v) return;
  const m = v.match(/^@(\S+)\s+([\s\S]+)/);
  const targets = m ? [m[1]!] : sel.size ? [...sel] : ['advisor'];
  void api('/api/send', { targets, text: m ? m[2] : v, via: 'you' });
  i.value = ''; target();
});

// ---------- add worker ----------
let addAgent = '';
let addHost = 'local';
/** The query part that names the host for /api/repos, /api/dirs and /api/branches. */
const hostQ = () => addHost === 'local' ? '' : `host=${encodeURIComponent(addHost)}`;
/** The Host switch: This computer plus one button for each host. Hidden when there are no hosts. */
function renderHostSwitch() {
  hostsUi?.render();
  const sw = $('#addHost'), list = [...hostMap.values()];
  sw.hidden = list.length === 0;
  if (addHost !== 'local' && !hostMap.has(addHost)) { addHost = 'local'; setPicked(''); }
  sw.innerHTML = `<button type="button" data-host="local">This computer</button>` + list.map(h =>
    `<button type="button" data-host="${esc(h.id)}"${h.state === 'up' ? '' : ' disabled'} title="${esc(h.state === 'up' ? h.name : `${h.name} is ${h.state}`)}" style="--ac:${esc(hostColor(h))}">${esc(h.name)}</button>`).join('');
  if (addHost !== 'local' && hostMap.get(addHost)?.state !== 'up') { addHost = 'local'; setPicked(''); void loadRepos(); }
  for (const b of sw.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.host === addHost);
  for (const w of workers.values()) renderNode(w);
  renderNeeds();
}
async function loadHosts(): Promise<void> {
  const r = await fetch('/api/hosts'); if (!r.ok) return;
  const { hosts } = await r.json() as { hosts: HostInfo[] };
  hostMap.clear(); for (const h of hosts) hostMap.set(h.id, h);
  renderHostSwitch();
  if (focus) renderFocus();
}
const hostsUi = initHosts({ api, esc, hostMap, hostColor, reload: loadHosts, feed });
$('#addHost').addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-host]');
  if (!b || b.disabled || b.dataset.host === addHost) return;
  addHost = b.dataset.host!;
  for (const x of $('#addHost').querySelectorAll<HTMLElement>('button')) x.classList.toggle('on', x.dataset.host === addHost);
  setPicked('');
  void loadRepos();
});
function agentOpts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of $('#addOpts').querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-opt]')) {
    if (el.value.trim()) out[el.dataset.opt!] = el.value.trim();
  }
  return out;
}
/** Show the option fields of the picked agent. */
function renderAgentOpts() {
  const a = agents.find(x => x.id === addAgent), box = $('#addOpts');
  box.hidden = !a || !a.options.length;
  box.innerHTML = (a?.options ?? []).map(o => {
    const f = o.kind === 'select'
      ? `<select data-opt="${esc(o.key)}">${o.default === undefined ? '<option value="">Config default</option>' : ''}${(o.choices ?? []).map(c => `<option value="${esc(c)}"${c === o.default ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`
      : `<input data-opt="${esc(o.key)}" value="${esc(o.default ?? '')}" placeholder="${esc(o.label)} (optional)">`;
    return `<label class="f">${esc(o.label)}${f}</label>`;
  }).join('');
  box.style.setProperty('--ac', a?.color ?? 'var(--accent)');
  $('#addStart').textContent = a ? `Start ${a.label} Worker` : 'Start Worker';
}
function pickAgent(id: string) {
  addAgent = id;
  try { localStorage.setItem('ac.addAgent', id); } catch { /* storage may be blocked */ }
  for (const b of $('#addAgent').querySelectorAll<HTMLElement>('button')) {
    const on = b.dataset.agent === id;
    b.classList.toggle('on', on);
    if (on) b.style.setProperty('--ac', agents.find(a => a.id === id)?.color ?? '');
  }
  renderAgentOpts();
}
// ---------- advisor menu ----------
/** The agent that holds the advisor seat. A missing agent means the first adapter. */
const advisorAgent = () => { const w = workers.get('advisor'); return w ? agentOf(w) : undefined; };
function renderAdvisorBtn() {
  const b = $('#bAdvisor'), a = advisorAgent();
  b.hidden = !a;
  if (a) b.textContent = `Advisor: ${a.icon} ${a.label} ▾`;
}
$('#bAdvisor').onclick = e => {
  e.stopPropagation();
  if (pop) { closePop(); return; }
  const cur = advisorAgent(), r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const opts = agents.filter(a => a.caps.advisor);
  const p = popAt(r.left, vp.getBoundingClientRect().top + 4, `<div class="cap">Advisor agent</div>${opts.map(a =>
    `<button data-agent="${esc(a.id)}">${esc(a.icon)} ${esc(a.label)}${a.id === cur?.id ? ' ✓' : ''}</button>`).join('')}
    <div class="cap">The current conversation is kept. It resumes when you switch back.</div>`);
  p.onclick = ev => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('button[data-agent]'); if (!t) return;
    const id = t.dataset.agent!;
    if (id === cur?.id) { closePop(); return; }
    if (!t.dataset.sure) { t.dataset.sure = '1'; t.textContent = `Click Again to Switch to ${agents.find(a => a.id === id)?.label ?? id}`; return; }
    closePop();
    void api('/api/advisor', { agent: id });
  };
};

async function loadAgents() {
  const r = await fetch('/api/agents'); if (!r.ok) throw new Error(`HTTP ${r.status}`);
  agents = await r.json() as AgentInfo[];
  $('#addAgent').innerHTML = agents.map(a => `<button type="button" data-agent="${esc(a.id)}">${esc(a.icon)} ${esc(a.label)}</button>`).join('');
  let saved = '';
  try { saved = localStorage.getItem('ac.addAgent') ?? ''; } catch { /* storage may be blocked */ }
  pickAgent(agents.some(a => a.id === saved) ? saved : agents[0]?.id ?? '');
  for (const w of workers.values()) renderNode(w);
  renderAdvisorBtn();
}
$('#addAgent').addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-agent]');
  if (b) pickAgent(b.dataset.agent!);
});
async function loadRepos() {
  const r = await fetch(`/api/repos?${hostQ()}`);
  if (!r.ok) {
    $('#addRepo').innerHTML = '<option value="">Repository…</option>';
    if (addHost !== 'local') feed(`Cannot list repositories on ${hostMap.get(addHost)?.name ?? addHost}.`);
    return;
  }
  const { repos, templates } = await r.json() as { repos: { name: string; path: string }[]; templates: string[] };
  $('#addRepo').innerHTML = '<option value="">Repository…</option>' + repos.map(x => `<option value="${esc(x.path)}">${esc(x.name)}</option>`).join('');
  $('#addTpl').innerHTML = '<option value="">No template</option>' + templates.map(t => `<option>${esc(t)}</option>`).join('');
}
// A folder picked with Browse Folders wins over the repository list.
let picked = '';
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
/** Fill the "From branch" combobox with the branches of the chosen repo. */
async function loadBranches() {
  const repo = picked || ($('#addRepo') as HTMLSelectElement).value;
  const list = $('#addBaseList'), base = $('#addBase') as HTMLInputElement;
  list.innerHTML = ''; base.value = '';
  base.placeholder = 'From branch (default: current)';
  if (!repo) return;
  const r = await fetch(`/api/branches?path=${encodeURIComponent(repo)}${hostQ() ? `&${hostQ()}` : ''}`); if (!r.ok) return;
  const b = await r.json() as { current: string | null; local: string[]; remote: string[]; error?: string };
  if (b.error) { base.placeholder = 'Not a Git repository: no worktree'; return; }
  if (b.current) base.placeholder = `From branch (default: ${b.current})`;
  list.innerHTML = [...b.local.map(x => `<option value="${esc(x)}">${x === b.current ? 'current' : 'local'}</option>`),
    ...b.remote.map(x => `<option value="${esc(x)}">remote</option>`)].join('');
}
const showBase = () => { ($('#addBase') as HTMLInputElement).hidden = !($('#addBranch') as HTMLInputElement).value.trim(); };
$('#addBranch').addEventListener('input', showBase);

function setPicked(p: string) {
  picked = p;
  const el = $('#addPicked');
  el.hidden = !p;
  el.innerHTML = p ? `<span title="${esc(p)}">📁 <b>${esc(baseName(p))}</b> <i>${esc(p)}</i></span><button type="button" class="ib" id="addUnpick" title="Clear the folder">✕</button>` : '';
  if (p) ($('#addRepo') as HTMLSelectElement).value = '';
  void loadBranches();
}
$('#addPicked').addEventListener('click', e => { if ((e.target as HTMLElement).id === 'addUnpick') setPicked(''); });
$('#addRepo').addEventListener('change', () => { if (($('#addRepo') as HTMLSelectElement).value) setPicked(''); else void loadBranches(); });
$('#addBrowse').onclick = () => void openBrowser();

interface DirListing { path: string; parent: string | null; dirs: { name: string; path: string; git: boolean }[]; places: { name: string; path: string }[]; error?: string }
async function openBrowser(start?: string) {
  const old = document.getElementById('importDlg');
  if (old?.dataset.busy) { feed('Finish or wait for the open dialog first.'); return; }
  old?.remove();
  const dlg = document.createElement('div'); dlg.id = 'importDlg'; dlg.className = 'dirs';
  vp.appendChild(dlg);
  let hidden = false;
  const show = async (path?: string) => {
    const q = new URLSearchParams(); if (path !== undefined) q.set('path', path); if (hidden) q.set('hidden', '1');
    if (addHost !== 'local') q.set('host', addHost);
    const r = await fetch(`/api/dirs?${q}`); if (!r.ok) return;
    const d = await r.json() as DirListing;
    dlg.dataset.path = d.path;
    dlg.innerHTML = `<h2>Choose a Folder</h2>
      <p>Claude starts in the folder you choose. ⎇ marks a Git repository.</p>
      <div class="places">${d.places.map(p => `<button class="tb" data-go="${esc(p.path)}">${esc(p.name)}</button>`).join('')}
        <label class="hid"><input type="checkbox" data-hidden ${hidden ? 'checked' : ''}> Show hidden</label></div>
      <div class="crumb">${d.parent !== null ? `<button class="ib" data-go="${esc(d.parent)}" title="Up one folder">⬆</button>` : ''}<code>${esc(d.path || (addHost === 'local' ? 'This computer' : hostMap.get(addHost)?.name ?? addHost))}</code></div>
      <div class="dlist">${d.error ? `<div class="empty">Cannot open this folder (${esc(d.error)}).</div>`
        : d.dirs.length ? d.dirs.map(x => `<button class="drow" data-go="${esc(x.path)}">📁 ${esc(x.name)}${x.git ? ' <span class="git">⎇ git</span>' : ''}</button>`).join('')
        : '<div class="empty">No sub-folders.</div>'}</div>
      <div class="imp-foot"><button class="tb" data-close>Cancel</button><button class="send" data-use ${d.path ? '' : 'disabled'}>Use This Folder</button></div>`;
  };
  dlg.onclick = e => {
    const t = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!t) return;
    if (t.dataset.go !== undefined) void show(t.dataset.go);
    else if (t.dataset.close !== undefined) dlg.remove();
    else if (t.dataset.use !== undefined && dlg.dataset.path) {
      setPicked(dlg.dataset.path);
      const n = $('#addName') as HTMLInputElement; if (!n.value) n.placeholder = `Name (default: ${baseName(dlg.dataset.path)})`;
      dlg.remove();
    }
  };
  dlg.onchange = e => { if ((e.target as HTMLElement).dataset.hidden !== undefined) { hidden = (e.target as HTMLInputElement).checked; void show(dlg.dataset.path); } };
  await show(start ?? (picked || undefined));
}

$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const repoSel = $('#addRepo') as HTMLSelectElement;
  const repo = picked || repoSel.value;
  if (!repo) { feed('Pick a repository, or use Browse Folders to choose any folder.'); return; }
  const name = ($('#addName') as HTMLInputElement).value.trim() || (picked ? baseName(picked) : repoSel.selectedOptions[0]!.text);
  const branch = ($('#addBranch') as HTMLInputElement).value.trim();
  const template = ($('#addTpl') as HTMLSelectElement).value || undefined;
  const base = ($('#addBase') as HTMLInputElement).value.trim() || undefined;
  const r = await api('/api/workers', { name, repo, worktree: branch ? { branch, base } : undefined, template, host: addHost === 'local' ? undefined : addHost, agent: addAgent || undefined, options: agentOpts() });
  if (r.ok) { (e.target as HTMLFormElement).reset(); renderAgentOpts(); setPicked(''); showBase(); ($('#addName') as HTMLInputElement).placeholder = 'Name (optional)'; }
});

// ---------- import running sessions (spec §12): the user picks Link / Move / Skip per session ----------
interface Ext { pid: number; sessionId: string; cwd: string; name: string; status: string; startedAt: number; ancestor: boolean; known: boolean }

async function openImport() {
  const old = document.getElementById('importDlg');
  if (old?.dataset.busy) { feed('Finish or wait for the open dialog first.'); return; }
  old?.remove();
  const r = await fetch('/api/external'); if (!r.ok) return;
  const { sessions } = await r.json() as { sessions: Ext[] };
  const fresh = sessions.filter(s => !s.known);
  const old2 = document.getElementById('importDlg');
  if (old2?.dataset.busy) { feed('Finish or wait for the open dialog first.'); return; }
  old2?.remove();
  const dlg = document.createElement('div'); dlg.id = 'importDlg';
  const home = (p: string) => p.replace(/^\/home\/[^/]+/, '~');
  const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };
  dlg.innerHTML = `<h2>Import Running Sessions</h2>
    <p>Claude Code sessions that run in your own terminal tabs. For each one, choose how to add it.
    <b>Link</b> shows it as a card that the advisor can message; nothing is stopped.
    <b>Move into Console</b> stops it in its tab and resumes the same conversation here as a live terminal.</p>
    ${fresh.length ? fresh.map(s => `<div class="imp-row" data-pid="${s.pid}">
      <div><b>${esc(s.name)}</b> <span class="dot s-${s.status === 'busy' || s.status === 'shell' ? 'running' : 'idle'}"></span> ${esc(s.status)}
        <div class="meta">${esc(home(s.cwd))} · pid ${s.pid} · started ${ago(s.startedAt)} ago${s.ancestor ? ' · <b>runs this console</b>' : ''}</div></div>
      <div class="acts"><button data-c="link" class="on">Link</button>
        <button data-c="adopt" ${s.ancestor ? 'disabled title="This session runs the console; moving it would stop the console."' : ''}>Move into Console</button>
        <button data-c="skip">Skip</button></div></div>`).join('')
      : '<p class="empty">No other Claude sessions are running (or all of them are on the canvas already).</p>'}
    ${sessions.length - fresh.length ? `<p class="empty">${sessions.length - fresh.length} session(s) are on the canvas already.</p>` : ''}
    <div class="imp-foot"><button class="tb" data-close>Cancel</button>${fresh.length ? '<button class="send" data-go>Import</button>' : ''}</div>`;
  vp.appendChild(dlg);
  dlg.onclick = async e => {
    const t = e.target as HTMLElement;
    if (t.dataset.c && !t.hasAttribute('disabled')) {
      t.parentElement!.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === t));
      const go = dlg.querySelector('[data-go]') as HTMLElement | null;
      const moves = dlg.querySelectorAll('button.on[data-c="adopt"]').length;
      if (go) go.textContent = moves ? `Import (${moves} will be stopped in their tabs)` : 'Import';
    }
    if (t.dataset.close !== undefined) dlg.remove();
    if (t.dataset.go !== undefined) {
      t.setAttribute('disabled', ''); t.textContent = 'Importing…';
      for (const row of dlg.querySelectorAll<HTMLElement>('.imp-row')) {
        const mode = (row.querySelector('button.on') as HTMLElement | null)?.dataset.c;
        if (mode === 'link' || mode === 'adopt') await api(`/api/external/${row.dataset.pid}`, { mode });
      }
      dlg.remove();
      setTimeout(() => canvas.fit(), 600);
    }
  };
}
$('#bImport').onclick = () => void openImport();

// ---------- toolbar + keys ----------
$('#bFit').onclick = () => canvas.fit();
// Lane frames (Group by Host). In memory only: the on/off flag is not saved.
let lanes: Lane[] | null = null;
function drawLanes() {
  for (const e of [...world.querySelectorAll('.lane')]) e.remove();
  if (!lanes) return;
  for (const l of [...lanes].reverse()) {
    const h = hostMap.get(l.host);
    const color = h ? hostColor(h) : 'var(--accent)';
    const d = document.createElement('div'); d.className = 'lane';
    d.style.cssText = `left:${l.x}px;top:${l.y}px;width:${l.w}px;height:${l.h}px;--hc:${color}`;
    d.innerHTML = `<div class="lane-hd"><i class="lane-dot"></i><b>${esc(l.name)}</b><span>${esc(l.host === 'local' ? 'local' : h?.state ?? 'unknown')}</span></div>`;
    world.insertBefore(d, world.firstChild);
  }
}
function setLanes(l: Lane[] | null) {
  lanes = l; drawLanes();
  $('#bGroup').classList.toggle('on', !!l);
}
$('#bGroup').onclick = () => {
  if (lanes) { setLanes(null); return; }
  const r = laneLayout([...workers.values()], [...hostMap.values()]);
  for (const m of r.moves) {
    const w = workers.get(m.id), el = els.get(m.id);
    if (w) { w.x = m.x; w.y = m.y; }
    if (el) { el.style.left = `${m.x}px`; el.style.top = `${m.y}px`; }
    void api(`/api/workers/${m.id}/move`, { x: m.x, y: m.y });
  }
  setLanes(r.lanes);
  canvas.schedule();
  setTimeout(() => canvas.fit(), 300);
};
$('#bLayout').onclick = () => {
  setLanes(null);
  const ws = [...workers.values()].filter(w => w.role === 'worker'), a = workers.get('advisor');
  const ax = 1400, ay = 1000, R = 1150;
  if (a) void api('/api/workers/advisor/move', { x: ax - 380, y: ay - 300 });
  ws.forEach((w, i) => {
    const ang = -Math.PI / 2 + i * 2 * Math.PI / Math.max(ws.length, 1);
    void api(`/api/workers/${w.id}/move`, { x: Math.round(ax + Math.cos(ang) * R * 1.2 - 380), y: Math.round(ay + Math.sin(ang) * R * 0.8 - 300) });
  });
  setTimeout(() => canvas.fit(), 300);
};
$('#bSelAll').onclick = () => { for (const w of workers.values()) if (w.role === 'worker') sel.add(w.id); renderAll(); };
$('#bClear').onclick = () => { sel.clear(); renderAll(); };
$('#zIn').onclick = () => canvas.zoomAt(1.15);
$('#zOut').onclick = () => canvas.zoomAt(1 / 1.15);

document.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  const typing = t.matches('input,select,textarea') || !!t.closest('.xterm');
  if (e.key === 'Escape' && !t.closest('.xterm')) {
    const dlg = document.getElementById('importDlg');
    if (dlg) { if (!dlg.dataset.busy) dlg.remove(); } else if (pop) closePop(); else if (focus) closeFocus(); else { sel.clear(); renderAll(); t.blur?.(); }
    return;
  }
  if (e.key === 'Escape' && focus && e.shiftKey) { closeFocus(); return; } // Shift+Esc leaves focus from inside the terminal
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); $('#cmdin').focus(); }
  else if (e.key === 'f' || e.key === 'F') { if (sel.size === 1) openFocus([...sel][0]!); else canvas.fit(); }
  else if (e.key === 'a' || e.key === 'A') $('#bSelAll').click();
  else if (/^[1-9]$/.test(e.key)) { const w = [...workers.values()][Number(e.key) - 1]; if (w) openFocus(w.id); }
});
addEventListener('resize', () => canvas.drawMini());

// ---------- last canvas (survives a reload, a new tab and a server restart) ----------
/** Put back the saved pan/zoom, selection and focus. False when nothing usable was saved. */
const store = () => { try { return localStorage; } catch { return null; } }; // reading it can throw when blocked
function restoreCanvas(): boolean {
  const ls = store(); const c = ls && loadCanvas(ls);
  if (!c) return false;
  canvas.view = { ...c.view }; canvas.apply();
  sel.clear(); for (const id of c.sel) if (workers.has(id)) sel.add(id);
  renderAll();
  if (c.focus && workers.has(c.focus) && !isLinked(workers.get(c.focus)!)) openFocus(c.focus);
  return true;
}
let lastSaved = '';
function persistCanvas() {
  if (!fitted) return; // do not overwrite the saved canvas before it is restored
  const c = { view: { ...canvas.view }, sel: [...sel], focus: focus?.id ?? null };
  const j = JSON.stringify(c);
  const ls = store();
  if (ls && j !== lastSaved) { lastSaved = j; saveCanvas(ls, c); }
}
setInterval(() => { if (!document.hidden) persistCanvas(); }, 1000);
addEventListener('pagehide', persistCanvas);

// ---------- hidden tab: no polling, no terminal streams; catch up when it shows again ----------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { persistCanvas(); for (const t of terms.values()) t.pause(); return; }
  for (const t of terms.values()) t.resume();
  refreshLinked(); markNode('all', true);
});

// ---------- theme: Auto (system) → Light → Dark, remembered in this browser ----------
type Theme = 'auto' | 'light' | 'dark';
function applyTheme(t: Theme) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $('#bTheme').textContent = `Theme: ${t[0]!.toUpperCase()}${t.slice(1)}`;
}
let theme: Theme = (() => { try { const v = localStorage.getItem('ac.theme'); return v === 'light' || v === 'dark' ? v : 'auto'; } catch { return 'auto'; } })();
applyTheme(theme);
$('#bTheme').onclick = () => {
  theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
  applyTheme(theme);
  try { localStorage.setItem('ac.theme', theme); } catch { /* storage blocked */ }
};

// ---------- drop a file on a terminal ----------
// As in a real terminal, a dropped file gives its path. Without these handlers the browser or
// the webview opens the file and leaves the console page. The file content is never uploaded.
const carriesFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].some(t => t === 'Files' || t === 'text/uri-list');
document.addEventListener('dragover', e => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
});
document.addEventListener('drop', e => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  const t = e.target as HTMLElement | null;
  const node = t?.closest?.('.node') as HTMLElement | null;
  const target = focus && t?.closest?.('#fTerm') ? focus.term : node ? terms.get(node.dataset.id!) : undefined;
  if (!target) return;
  const dt = e.dataTransfer!;
  const paths = pathsFromDrop({
    uriList: dt.getData('text/uri-list'), text: dt.getData('text/plain'),
    files: [...dt.files].map(f => ({ name: f.name, path: (f as File & { path?: unknown }).path as string | undefined })),
  });
  if (paths.length) target.paste(pasteText(paths));
  else feed('The dropped file gave no path. Paste the path by hand.');
});

// ---------- boot ----------
// The server serves these two (no bundling): the window name and icon for the app window.
for (const [rel, href] of [['icon', '/icon.svg'], ['manifest', '/manifest.webmanifest']] as const) {
  const l = document.createElement('link'); l.rel = rel; l.href = href; document.head.appendChild(l);
}
canvas.apply();
connectState();
void loadHosts();
void loadRepos();
loadAgents().catch(e => feed(`Error: cannot load the agents (${e instanceof Error ? e.message : e})`));
setTimeout(() => { $('#hint').style.opacity = '0'; }, 8000);
