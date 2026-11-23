import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadState, saveState } from './store';
import { ADAPTERS, adapterOf, validateAgent } from './agents';
import { sessionDir } from './paths';
import type { AgentAdapter } from './agents/types';
import { slugify, uniqueId } from './slug';
import type { Tmux } from './tmux';
import { SESSIONS_DIR, ancestorPids, envOf, listExternal, pidAlive, readSessionFile, type ExternalSession } from './external';
import { emptyTrack, type StepTrack } from './steps';
import type { Activity, Config, Link, Template, Need, Role, State, StateEvent, Status, Worker } from './types';

export const linkKey = (a: string, b: string) => [a, b].sort().join('~');
export const sessionName = (id: string) => `ac-${id}`;
const TYPING_QUIET_MS = 10_000;
const SWAP_SETTLE_MS = 5000;

export interface RegistryOpts {
  bin: string[]; url: string; token: string;
  inheritedOtelAttrs?: string; advisorPrompt?: string;
  now?: () => number;
  /** How long the advisor stays busy after a swap, while the new TUI loads. Default 5000. */
  swapSettleMs?: number;
  exec?: (cmd: string[], cwd: string) => Promise<void>;
  /** For linked sessions (spec §12). Defaults use /proc and ~/.claude/sessions. */
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  sessionsDir?: string;
  ancestors?: number[];
  procStartOf?: (pid: number) => string | undefined;
  cmdlineOf?: (pid: number) => string;
}

export interface SpawnInput {
  name: string; repo: string; role?: Role; worktree?: { branch: string; base?: string };
  template?: string; resume?: boolean;
  /** The agent id. A missing value uses config.defaultWorkerAgent for a worker, else claude. The advisor always uses claude. */
  agent?: string;
  options?: Record<string, string>;
}

type Waiter = (r: { decision: 'allow' | 'deny' | 'answer' | 'timeout'; text?: string }) => void;

async function defaultExec(cmd: string[], cwd: string) {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed: ${err.trim()}`);
}

export class Registry extends EventTarget {
  private state: State;
  private needMap = new Map<string, Need>();
  private waiters = new Map<string, Waiter>();
  private queue = new Map<string, string[]>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private now: () => number;
  private exec: (cmd: string[], cwd: string) => Promise<void>;

  constructor(private tmux: Tmux, private cfg: Config, private opts: RegistryOpts) {
    super();
    this.state = loadState();
    this.now = opts.now ?? Date.now;
    this.exec = opts.exec ?? defaultExec;
  }

  // ---------- events / persistence ----------
  private emit(ev: StateEvent) { this.dispatchEvent(new CustomEvent('event', { detail: ev })); }
  private persist() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 200);
  }
  flush() { if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = null; saveState(this.state); }
  activity(text: string) {
    const item: Activity = { at: this.now(), text };
    this.state.activity.push(item);
    if (this.state.activity.length > 600) this.state.activity.splice(0, 100);
    this.emit({ t: 'activity', item });
    this.persist();
  }
  private touch(w: Worker) { this.emit({ t: 'worker', worker: w }); this.persist(); }

  // ---------- queries ----------
  config(): Config { return this.cfg; }
  workers(): Worker[] { return this.state.workers; }
  get(id: string): Worker | undefined { return this.state.workers.find(w => w.id === id); }
  needs(): Need[] { return [...this.needMap.values()]; }
  links(): Link[] { return this.state.links; }
  nameOf(id: string) { return this.get(id)?.name ?? id; }
  snapshot(): Extract<StateEvent, { t: 'snapshot' }> {
    const queued = Object.fromEntries([...this.queue].map(([k, v]) => [k, v.length]));
    return { t: 'snapshot', state: structuredClone(this.state), needs: this.needs(), queued };
  }

  // ---------- steps (flow view) ----------
  stepsOf(id: string): StepTrack { return this.state.steps?.[id] ?? emptyTrack(); }
  /** Apply one change to a worker's steps; emit and save only when it changed. */
  steps(id: string, fn: (t: StepTrack) => StepTrack) {
    if (!this.get(id)) return;
    const old = this.stepsOf(id), next = fn(old);
    if (next === old) return;
    (this.state.steps ??= {})[id] = next;
    this.emit({ t: 'steps', id, track: next });
    this.persist();
  }

  // ---------- lifecycle ----------
  /** Start the tmux session of a worker with its agent adapter. */
  private async start(w: Worker, extra: { resume?: boolean; template?: Template } = {}, adapter: AgentAdapter = adapterOf(w)) {
    const { bin, url, token, inheritedOtelAttrs, advisorPrompt } = this.opts;
    // Worker options win over the config of the agent. Only string values count.
    const fromCfg = Object.entries(this.cfg.agents?.[adapter.id] ?? {}).filter(([, v]) => typeof v === 'string');
    const l = adapter.launch({
      w, dir: sessionDir(w.id), url, token, bin, inheritedOtelAttrs,
      rules: w.role === 'advisor' && advisorPrompt !== undefined ? (adapter.rules?.('advisor', advisorPrompt) ?? advisorPrompt) : undefined,
      resume: extra.resume ?? false, template: extra.template,
      options: { ...Object.fromEntries(fromCfg), ...(w.options ?? {}) }, hookTimeoutSec: this.cfg.hookTimeoutSec,
    });
    await this.tmux.newSession(sessionName(w.id), w.cwd, l.env, l.cmd);
  }

  async spawn(input: SpawnInput): Promise<Worker> {
    // Check the agent and the options first, before any side effect (the worktree, the session).
    // The default worker agent is for workers only. The advisor agent comes from the caller.
    const agent = validateAgent(input.agent ?? ((input.role ?? 'worker') === 'worker' ? this.cfg.defaultWorkerAgent : undefined), input.options).agent;
    const role = input.role ?? 'worker';
    const id = role === 'advisor' ? 'advisor' : uniqueId(input.name, this.state.workers.map(w => w.id));
    if (this.get(id) && role === 'advisor') this.state.workers = this.state.workers.filter(w => w.id !== id);
    let cwd = input.repo;
    let branch: string | undefined;
    let worktree: string | undefined;
    if (input.worktree) {
      branch = input.worktree.branch;
      const base = input.worktree.base;
      // A leading "-" would be read by git as an option.
      if (!branch || branch.startsWith('-') || base?.startsWith('-')) throw new Error('bad branch name');
      worktree = join(dirname(input.repo), 'worktrees', `${basename(input.repo)}-${slugify(branch)}`);
      await this.exec(['git', 'worktree', 'add', worktree, '-b', branch, ...(base ? [base] : [])], input.repo);
      cwd = worktree;
    }
    const n = this.state.workers.filter(x => x.role === 'worker').length;
    const w: Worker = {
      id, name: input.name, role, cwd, repo: basename(input.repo), branch, worktree,
      status: 'idle', task: 'Starting…',
      ...(agent ? { agent } : {}), ...(input.options && Object.keys(input.options).length ? { options: input.options } : {}),
      x: role === 'advisor' ? 760 : 40 + (n % 3) * 760, y: role === 'advisor' ? 620 : (Math.floor(n / 3) % 2 ? 1200 : 40) + Math.floor(n / 6) * 1160,
    };
    const template = this.cfg.templates.find(t => t.name === input.template);
    await this.start(w, { resume: input.resume, template });
    this.state.workers.push(w);
    if (role === 'worker' && this.get('advisor')) this.connect('advisor', id, 'advisor');
    this.activity(`Started ${w.name} in ${w.repo}${branch ? ` (worktree ${branch}${input.worktree?.base ? ` from ${input.worktree.base}` : ''})` : ''}.`);
    this.touch(w);
    return w;
  }

  async stop(id: string) {
    const w = this.get(id); if (!w) return;
    await this.tmux.kill(sessionName(id));
    w.status = 'stopped'; w.task = 'Stopped';
    this.activity(`Stopped ${w.name}.`);
    this.touch(w);
  }

  async restart(id: string, resume = true) {
    const w = this.get(id); if (!w) return;
    // Find the adapter first: an unknown agent must throw while the old session still runs.
    const adapter = adapterOf(w);
    await this.tmux.kill(sessionName(id));
    await this.start(w, { resume }, adapter);
    w.status = 'idle'; w.task = 'Restarted';
    this.activity(`Restarted ${w.name}.`);
    this.touch(w);
  }

  private swapping = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Change the agent of the advisor. Check everything first, then stop the old session. */
  async swapAdvisor(agent: string): Promise<Worker> {
    const adv = this.get('advisor');
    if (!adv) throw new Error('no advisor');
    if (!Object.hasOwn(ADAPTERS, agent)) throw new Error(`unknown agent: ${agent} (known: ${Object.keys(ADAPTERS).join(', ')})`);
    const a = ADAPTERS[agent]!;
    if (!a.caps.advisor) throw new Error(`${a.label} cannot be the advisor`);
    const oldAdapter = adapterOf(adv);
    const old = oldAdapter.id;
    if (old === agent) return adv;
    if (this.swapping) throw new Error('a swap is already running');
    this.swapping = true;
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    // Hold all messages for the whole swap: the old session is dead and the new one is not ready.
    this.pendingTools.add('advisor');
    // Messages queued for the old session are dropped. Tell the user.
    const dropped = this.queue.get('advisor')?.length ?? 0;
    if (this.queue.delete('advisor')) this.emit({ t: 'queued', id: 'advisor', count: 0 });
    if (dropped > 0) this.activity(`Dropped ${dropped} queued message(s) for the advisor (swap).`);
    try {
      if (adv.sessionId) adv.lastSessions = { ...adv.lastSessions, [old]: adv.sessionId };
      // Deny every open need of the old session, as remove() does. Their waiters belong to the process that stops now.
      for (const n of this.needs()) if (n.id === 'advisor') this.resolveNeed(n.nid, 'deny');
      // Let the waiter code (hook server) finish before the swap sets the final status.
      await new Promise<void>(r => setTimeout(r, 0));
      await this.tmux.kill(sessionName('advisor'));
      adv.agent = agent;
      const saved = adv.lastSessions?.[agent];
      if (saved) adv.sessionId = saved; else delete adv.sessionId;
      try { await this.start(adv, { resume: !!adv.sessionId }, a); }
      catch (e) {
        this.pendingTools.delete('advisor');
        adv.status = 'stopped'; adv.task = `Swap failed: ${(e as Error).message}`;
        this.touch(adv);
        throw e;
      }
      adv.status = 'idle';
      adv.task = `Switched to ${a.label}`;
      this.activity(`Advisor switched from ${oldAdapter.label} to ${a.label}${adv.sessionId ? ' (resumed)' : ''}.`);
      this.touch(adv);
      // Keep the busy mark while the new TUI loads. Then send the queued messages.
      const settle = this.opts.swapSettleMs ?? SWAP_SETTLE_MS;
      if (settle <= 0) this.toolEnd('advisor');
      else this.settleTimer = setTimeout(() => { this.settleTimer = null; this.toolEnd('advisor'); }, settle);
    } catch (e) {
      this.pendingTools.delete('advisor');
      throw e;
    } finally { this.swapping = false; }
    return adv;
  }

  async remove(id: string) {
    const w = this.get(id); if (!w) return;
    await this.tmux.kill(sessionName(id));
    this.state.workers = this.state.workers.filter(x => x.id !== id);
    this.state.links = this.state.links.filter(l => l.a !== id && l.b !== id);
    if (this.state.steps) delete this.state.steps[id];
    for (const n of this.needs()) if (n.id === id) this.resolveNeed(n.nid, 'deny');
    this.queue.delete(id);
    this.emit({ t: 'removed', id });
    this.emit({ t: 'links', links: this.state.links, cut: this.state.cut });
    this.activity(`Removed ${w.name}.`);
    this.persist();
  }

  async interrupt(id: string) {
    await this.tmux.sendKey(sessionName(id), 'Escape');
    this.activity(`Interrupted ${this.nameOf(id)}.`);
  }

  move(id: string, x: number, y: number) {
    const w = this.get(id); if (!w) return;
    w.x = x; w.y = y; this.touch(w);
  }

  /** Set the box size (clamped, rounded). Without a size, remove it so the default size applies. */
  resize(id: string, wPx?: number, hPx?: number) {
    const w = this.get(id); if (!w) return;
    if (wPx === undefined || hPx === undefined) { delete w.w; delete w.h; }
    else {
      w.w = Math.round(Math.min(2400, Math.max(360, wPx)));
      w.h = Math.round(Math.min(1600, Math.max(220, hPx)));
    }
    this.touch(w);
  }

  update(id: string, patch: Partial<Worker>) {
    const w = this.get(id); if (!w) return;
    Object.assign(w, patch); this.touch(w);
  }

  setStatus(id: string, s: Status, task?: string) {
    const w = this.get(id); if (!w) return;
    w.status = s;
    if (task !== undefined) w.task = task;
    this.touch(w);
    if (s === 'done' || s === 'idle') void this.flushQueue(id);
  }

  async discover() {
    const live = new Set((await this.tmux.list()).filter(s => s.startsWith('ac-')).map(s => s.slice(3)));
    for (const w of this.state.workers) {
      if (w.kind === 'linked') { if (!this.alive(w.pid ?? 0)) { w.status = 'stopped'; w.task = 'Session ended'; } continue; }
      if (live.has(w.id)) { if (w.status === 'stopped') w.status = 'idle'; }
      else { w.status = 'stopped'; w.task = 'Session not running'; }
    }
    const maxY = Math.max(0, ...this.state.workers.map(w => w.y));
    let k = 0;
    for (const id of live) {
      if (this.get(id)) continue;
      // Below everything known, so a found session never covers an existing box.
      this.state.workers.push({ id, name: id, role: id === 'advisor' ? 'advisor' : 'worker', cwd: '', repo: '?', status: 'idle', task: 'Found running', x: 40 + (k % 3) * 760, y: maxY + 600 + Math.floor(k / 3) * 600 });
      k++;
    }
    this.persist();
  }

  // ---------- links ----------
  linked(a: string, b: string) { return this.state.links.some(l => linkKey(l.a, l.b) === linkKey(a, b)); }

  connect(a: string, b: string, by: 'advisor' | 'you'): boolean {
    if (a === b) return false;
    const k = linkKey(a, b);
    if (by === 'advisor' && this.state.cut.includes(k)) return false;
    if (by === 'you') this.state.cut = this.state.cut.filter(c => c !== k);
    const l = this.state.links.find(x => linkKey(x.a, x.b) === k);
    if (l) { if (by === 'you') l.by = 'you'; }
    else {
      this.state.links.push({ a, b, by });
      this.activity(`${by === 'you' ? 'You' : 'Advisor'} connected ${this.nameOf(a)} ↔ ${this.nameOf(b)}.`);
    }
    this.emit({ t: 'links', links: this.state.links, cut: this.state.cut });
    this.persist();
    return true;
  }

  cut(a: string, b: string) {
    const k = linkKey(a, b);
    this.state.links = this.state.links.filter(l => linkKey(l.a, l.b) !== k);
    if (!this.state.cut.includes(k)) this.state.cut.push(k);
    this.activity(`You cut ${this.nameOf(a)} ↔ ${this.nameOf(b)}.`);
    this.emit({ t: 'links', links: this.state.links, cut: this.state.cut });
    this.persist();
  }

  disconnect(a: string, b: string) {
    const k = linkKey(a, b);
    this.state.links = this.state.links.filter(l => linkKey(l.a, l.b) !== k);
    this.activity(`Advisor disconnected ${this.nameOf(a)} ↔ ${this.nameOf(b)}.`);
    this.emit({ t: 'links', links: this.state.links, cut: this.state.cut });
    this.persist();
  }

  pulse(from: string, to: string) { this.emit({ t: 'pulse', from, to }); }

  // ---------- needs ----------
  addNeed(n: Omit<Need, 'nid' | 'createdAt'>): Need {
    const need: Need = { ...n, nid: randomUUID().slice(0, 8), createdAt: this.now() };
    this.needMap.set(need.nid, need);
    this.emit({ t: 'needs', needs: this.needs() });
    return need;
  }

  resolveNeed(nid: string, decision: 'allow' | 'deny' | 'answer', text?: string) {
    const need = this.needMap.get(nid);
    if (!need) return false;
    this.needMap.delete(nid);
    this.waiters.get(nid)?.({ decision, text });
    this.waiters.delete(nid);
    this.emit({ t: 'needs', needs: this.needs() });
    return true;
  }

  clearNeeds(id: string, kinds: Need['kind'][]) {
    let changed = false;
    for (const n of this.needs()) if (n.id === id && kinds.includes(n.kind) && !this.waiters.has(n.nid)) { this.needMap.delete(n.nid); changed = true; }
    if (changed) this.emit({ t: 'needs', needs: this.needs() });
  }

  waitNeed(nid: string, timeoutMs: number) {
    return new Promise<{ decision: 'allow' | 'deny' | 'answer' | 'timeout'; text?: string }>(resolve => {
      const timer = setTimeout(() => {
        this.waiters.delete(nid);
        if (this.needMap.delete(nid)) this.emit({ t: 'needs', needs: this.needs() });
        resolve({ decision: 'timeout' });
      }, timeoutMs);
      this.waiters.set(nid, r => { clearTimeout(timer); resolve(r); });
    });
  }

  // ---------- linked sessions (spec §12) ----------
  private alive(pid: number) { return (this.opts.alive ?? pidAlive)(pid); }

  private nextSlot() {
    const n = this.state.workers.filter(x => x.role === 'worker').length;
    return { x: 40 + (n % 3) * 760, y: (Math.floor(n / 3) % 2 ? 1200 : 40) + Math.floor(n / 6) * 1160 };
  }

  /** Outside sessions, with `known` set when a card for that conversation exists already. */
  externalSessions(): (ExternalSession & { known: boolean })[] {
    const known = new Set(this.state.workers.map(w => w.sessionId).filter(Boolean));
    return listExternal({
      dir: this.opts.sessionsDir ?? SESSIONS_DIR(), alive: p => this.alive(p), envOf,
      ancestors: this.opts.ancestors ?? ancestorPids(),
      procStartOf: this.opts.procStartOf, cmdlineOf: this.opts.cmdlineOf,
    }).map(e => ({ ...e, known: known.has(e.sessionId) }));
  }

  private static extStatus(s: string | undefined): Status {
    return s === 'busy' || s === 'shell' ? 'running' : 'idle';
  }

  link(ext: ExternalSession): Worker {
    const existing = this.state.workers.find(w => w.sessionId === ext.sessionId);
    if (existing) return existing;
    const w: Worker = {
      id: uniqueId(ext.name, this.state.workers.map(x => x.id)), name: ext.name, role: 'worker', kind: 'linked',
      pid: ext.pid, sessionId: ext.sessionId, cwd: ext.cwd, repo: basename(ext.cwd),
      status: Registry.extStatus(ext.status), task: 'Linked: runs in its own terminal', ...this.nextSlot(),
    };
    this.state.workers.push(w);
    if (this.get('advisor')) this.connect('advisor', w.id, 'advisor');
    this.activity(`Linked ${w.name} (${w.repo}).`);
    this.touch(w);
    return w;
  }

  /** Stop the outside process, then resume the same conversation in tmux. */
  async adopt(ext: ExternalSession): Promise<Worker> {
    // The same rule as restart(): find the adapter before the outside process is stopped.
    const known = this.state.workers.find(x => x.sessionId === ext.sessionId);
    if (known) adapterOf(known);
    if (ext.ancestor) throw new Error(`${ext.name} runs the console itself; it cannot be moved`);
    // Check the identity again right before the kill: pid, conversation and start time must still match (review I4).
    if (!this.externalSessions().some(e => e.pid === ext.pid && e.sessionId === ext.sessionId))
      throw new Error(`${ext.name} (pid ${ext.pid}) is no longer the same running session`);
    (this.opts.kill ?? (p => process.kill(p, 'SIGTERM')))(ext.pid);
    for (let i = 0; i < 50 && this.alive(ext.pid); i++) await Bun.sleep(100);
    if (this.alive(ext.pid)) throw new Error(`${ext.name} (pid ${ext.pid}) did not stop; close it in its tab and try again`);
    let w = this.state.workers.find(x => x.sessionId === ext.sessionId);
    if (!w) {
      w = { id: uniqueId(ext.name, this.state.workers.map(x => x.id)), name: ext.name, role: 'worker', cwd: ext.cwd,
        repo: basename(ext.cwd), sessionId: ext.sessionId, status: 'idle', task: '', ...this.nextSlot() };
      this.state.workers.push(w);
    }
    w.kind = 'tmux'; delete w.pid;
    w.status = 'idle'; w.task = 'Moved into the console (resumed)';
    await this.start(w, { resume: true });
    if (this.get('advisor') && !this.linked('advisor', w.id)) this.connect('advisor', w.id, 'advisor');
    this.activity(`Moved ${w.name} into the console.`);
    this.touch(w);
    return w;
  }

  /** Refresh linked cards from ~/.claude/sessions. */
  pollLinked(read: (pid: number) => { status?: string } | undefined = p => readSessionFile(this.opts.sessionsDir ?? SESSIONS_DIR(), p)) {
    for (const w of this.state.workers) {
      if (w.kind !== 'linked' || !w.pid) continue;
      const next: Status = this.alive(w.pid) ? Registry.extStatus(read(w.pid)?.status) : 'stopped';
      if (next !== w.status) { w.status = next; if (next === 'stopped') w.task = 'Session ended'; this.touch(w); }
    }
  }

  /** Remove a linked card. The outside session keeps running. */
  unlink(id: string) {
    const w = this.get(id); if (!w || w.kind !== 'linked') return;
    this.state.workers = this.state.workers.filter(x => x.id !== id);
    this.state.links = this.state.links.filter(l => l.a !== id && l.b !== id);
    this.emit({ t: 'removed', id });
    this.emit({ t: 'links', links: this.state.links, cut: this.state.cut });
    this.activity(`Unlinked ${w.name}.`);
    this.persist();
  }

  // ---------- messages ----------
  queuedFor(id: string): number { return this.queue.get(id)?.length ?? 0; }
  noteUserInput(id: string) { const w = this.get(id); if (w) w.lastUserInputAt = this.now(); }

  /** A tool is between PreToolUse and PostToolUse: a permission menu may be on screen (review I2). */
  private pendingTools = new Set<string>();
  toolStart(id: string) { this.pendingTools.add(id); }
  toolEnd(id: string) { if (this.pendingTools.delete(id)) void this.flushQueue(id); }

  private busy(w: Worker) {
    return w.status === 'needs-you' || w.status === 'stopped' || this.pendingTools.has(w.id)
      || (w.lastUserInputAt !== undefined && this.now() - w.lastUserInputAt < TYPING_QUIET_MS);
  }

  async deliver(from: string, to: string, text: string): Promise<'sent' | 'queued'> {
    const w = this.get(to);
    if (!w) throw new Error(`no worker ${to}`);
    if (w.kind === 'linked') throw new Error(`${w.name} is a linked session outside the console: type in its own tab, or Move into Console`);
    // Typed keys, not text: control characters would submit early, change modes or interrupt (review I1).
    const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    const msg = from === 'you' ? clean : `[from ${this.nameOf(from)}] ${clean}`;
    if (this.busy(w)) {
      const q = this.queue.get(to) ?? [];
      q.push(msg); this.queue.set(to, q);
      this.emit({ t: 'queued', id: to, count: q.length });
      // Typing is the only busy reason that ends by itself: retry when the quiet window is over.
      if (w.status !== 'needs-you' && w.status !== 'stopped' && w.lastUserInputAt !== undefined) {
        const wait = Math.max(0, w.lastUserInputAt + TYPING_QUIET_MS - this.now()) + 100;
        setTimeout(() => void this.flushQueue(to), wait);
      }
      return 'queued';
    }
    await this.tmux.sendText(sessionName(to), msg);
    if (from !== 'you') this.pulse(from, to);
    return 'sent';
  }

  async flushQueue(id: string) {
    const w = this.get(id);
    const q = this.queue.get(id);
    if (!w || !q?.length) return;
    if (this.busy(w)) {
      if (w.status !== 'needs-you' && w.status !== 'stopped' && w.lastUserInputAt !== undefined)
        setTimeout(() => void this.flushQueue(id), Math.max(0, w.lastUserInputAt + TYPING_QUIET_MS - this.now()) + 100);
      return;
    }
    this.queue.delete(id);
    for (const msg of q) await this.tmux.sendText(sessionName(id), msg);
    this.emit({ t: 'queued', id, count: 0 });
  }
}
