import { basename, dirname, join } from 'node:path';
import { VERSION } from './version';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { loadState, saveState } from './store';
import { ADAPTERS, adapterOf, validateAgent } from './agents';
import { folderProblem, sessionDir } from './paths';
import { addRemoteWorktree, writeRemoteFile } from './remotefs';
import type { AgentAdapter } from './agents/types';
import { slugify, uniqueId } from './slug';
import type { Tmux } from './tmux';
import { HostPool, TmuxPool } from './hostpool';
import { isLocal } from './hosts';
import { SESSIONS_DIR, ancestorPids, envOf, listExternal, pidAlive, readSessionFile, type ExternalSession } from './external';
import { emptyTrack, type StepTrack } from './steps';
import type { Activity, Config, Link, Template, Need, Role, State, StateEvent, Status, Worker } from './types';

export const linkKey = (a: string, b: string) => [a, b].sort().join('~');
export const sessionName = (id: string) => `ac-${id}`;
const TYPING_QUIET_MS = 10_000;
const SWAP_SETTLE_MS = 5000;
const SEAT_IDS = ['advisor', 'reviewer'];

export interface RegistryOpts {
  bin: string[]; url: string; token: string;
  inheritedOtelAttrs?: string; advisorPrompt?: string; reviewerPrompt?: string;
  /** The remote hosts. Without it only the local machine works. */
  hosts?: HostPool;
  now?: () => number;
  /** How long a seat stays busy after a swap, while the new TUI loads. Default 5000. */
  swapSettleMs?: number;
  exec?: (cmd: string[], cwd: string) => Promise<void>;
  /** For linked sessions (spec §12). Defaults use /proc and ~/.claude/sessions. */
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  sessionsDir?: string;
  ancestors?: number[];
  procStartOf?: (pid: number) => string | undefined;
  cmdlineOf?: (pid: number) => string;
  /** Finds an agent binary on PATH. Default: Bun.which with the PATH of the process. */
  which?: (bin: string) => string | null;
  /** How long a local start waits before it checks that the session still runs. Default 1500 ms. */
  startCheckMs?: number;
  /** True when a session has a local transcript, for resume. Default: a search in the Claude projects folder. */
  transcriptExists?: (sessionId: string) => boolean;
  /** Reads a working folder before a local start. Default: readdirSync. */
  readDir?: (path: string) => unknown;
  /** The OS for the folder message. Default: process.platform. */
  platform?: NodeJS.Platform;
  /** The wait of the start check. Default: Bun.sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** A local session did not start: the agent binary is missing, or the session ended at once. */
export class StartError extends Error {}

export interface SpawnInput {
  name: string; repo: string; role?: Role; worktree?: { branch: string; base?: string; existing?: boolean };
  template?: string;
  /** A first prompt for the agent. A template with the same name wins. */
  prompt?: string; resume?: boolean;
  /** Runs after the worktree exists and before the agent starts. A throw stops the start; the worktree stays. */
  beforeStart?: (cwd: string) => Promise<void>;
  /** The id of a remote host. A missing value or 'local' is this machine. */
  host?: string;
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

  private pool: TmuxPool;
  private hosts?: HostPool;

  /** `tmux` is a TmuxPool, or one Tmux that serves the local machine only. */
  constructor(tmux: Tmux | TmuxPool, private cfg: Config, private opts: RegistryOpts) {
    super();
    this.hosts = opts.hosts;
    this.pool = tmux instanceof TmuxPool ? tmux : new TmuxPool(tmux, opts.hosts ?? new HostPool([], { consolePort: 0, sockDir: '' }));
    this.hosts?.addEventListener('state', e => {
      const { id, profile } = (e as CustomEvent<{ id: string; profile?: boolean }>).detail;
      // A cosmetic profile change keeps the link. The workers stay as they are.
      if (profile) return;
      let st: string;
      // A host that left the config still sends its last 'down'. Its workers cannot be reached.
      try { st = this.hosts!.link(id).state; } catch { this.hostRemoved(id); return; }
      if (st === 'up') void this.discoverHost(id).catch(err => console.error(`host ${id}: ${(err as Error).message}`));
      else if (st === 'down' || st === 'error') this.hostOffline(id);
    });
    this.state = loadState();
    this.now = opts.now ?? Date.now;
    this.exec = opts.exec ?? defaultExec;
  }

  /**
   * Kill the session of a worker. A known remote host that is not up throws: the session would keep running there.
   * A host that left the config cannot be reached. Then nothing is killed, and Activity warns about it.
   */
  private async killSession(w: Worker) {
    if (!isLocal(w.host) && w.kind !== 'linked') {
      let link;
      try { link = this.hosts?.link(w.host!); } catch { /* the host left the config */ }
      if (!link) {
        this.activity(`${w.name}: the host ${w.host} is no longer in the config. Its session may still run on that machine.`);
        return;
      }
      if (link.state !== 'up') throw new Error(`${link.host.name} is not connected. Connect the host first.`);
    }
    await this.tmuxOf(w.id).kill(sessionName(w.id));
  }

  /** The Tmux that holds the session of a worker. */
  tmuxOf(id: string): Tmux { return this.pool.of(this.get(id)?.host); }

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
  /** The reviewer seat. A worker with the id reviewer (old state) is not the seat. */
  reviewer(): Worker | undefined { return this.state.workers.find(w => w.role === 'reviewer'); }
  /** Ids that only a seat can take. A worker never gets one. */
  private takenIds(): string[] { return [...this.state.workers.map(w => w.id), ...SEAT_IDS]; }
  needs(): Need[] { return [...this.needMap.values()]; }
  links(): Link[] { return this.state.links; }
  nameOf(id: string) { return this.get(id)?.name ?? id; }
  snapshot(): Extract<StateEvent, { t: 'snapshot' }> {
    const queued = Object.fromEntries([...this.queue].map(([k, v]) => [k, v.length]));
    return { t: 'snapshot', state: structuredClone(this.state), needs: this.needs(), queued, version: VERSION };
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
  /** The link of a remote worker. Throw when the host is unknown, not connected, or cannot run the agent. */
  private remoteLink(host: string, agent: string) {
    if (!this.hosts) throw new Error(`unknown host ${host}`);
    const link = this.hosts.link(host);
    if (agent !== 'claude') throw new Error(`${agent} workers cannot run on a remote host yet`);
    if (link.state !== 'up') throw new Error(`${link.host.name} is not connected`);
    return link;
  }

  /** Start the tmux session of a worker with its agent adapter.
   *  `beforeSession` runs after the checks and right before the session starts: spawn() registers the worker there,
   *  so MCP calls and hooks of the new session find it during the start wait. */
  private async start(w: Worker, extra: { resume?: boolean; template?: Template } = {}, adapter: AgentAdapter = adapterOf(w),
    beforeSession?: () => void) {
    const { bin, token, inheritedOtelAttrs, advisorPrompt, reviewerPrompt } = this.opts;
    let { url } = this.opts;
    // A remote worker calls the console through the reverse tunnel, and its session files live on the host.
    const link = isLocal(w.host) ? undefined : this.remoteLink(w.host!, adapter.id);
    let fileDir: string | undefined;
    if (link) {
      url = `http://127.0.0.1:${link.tunnelPort()}`;
      fileDir = `${await link.home()}/.config/agent-console/sessions/${w.id}`;
    }
    // The rules text depends on the seat. A worker has none.
    const seatPrompt = w.role === 'advisor' ? advisorPrompt : w.role === 'reviewer' ? reviewerPrompt : undefined;
    // Worker options win over the config of the agent. Only string values count.
    const fromCfg = Object.entries(this.cfg.agents?.[adapter.id] ?? {}).filter(([, v]) => typeof v === 'string');
    const l = adapter.launch({
      w, dir: sessionDir(w.id), fileDir, url, token, bin, inheritedOtelAttrs,
      rules: (w.role === 'advisor' || w.role === 'reviewer') && seatPrompt !== undefined ? (adapter.rules?.(w.role, seatPrompt) ?? seatPrompt) : undefined,
      resume: extra.resume ?? false, template: extra.template,
      options: { ...Object.fromEntries(fromCfg), ...(w.options ?? {}) }, hookTimeoutSec: this.cfg.hookTimeoutSec,
      hasTranscript: this.opts.transcriptExists,
    });
    if (link && fileDir) {
      for (const f of ['settings.json', 'mcp.json'])
        await writeRemoteFile(link, `${fileDir}/${f}`, readFileSync(join(sessionDir(w.id), f), 'utf8'));
    }
    // A local agent that is not on PATH makes tmux exit at once. Say so, before the session starts.
    const agentBin = l.cmd[0]!;
    const local = isLocal(w.host) && w.kind !== 'shell';
    if (local && !(this.opts.which ?? (b => Bun.which(b, { PATH: process.env.PATH ?? '' })))(agentBin))
      throw new StartError(`${agentBin} not found on PATH. Install it, or start the console from a login shell. See agent-console doctor.`);
    // A folder that the agent cannot read makes it exit at once (macOS privacy blocks Desktop for an app).
    const folder = local ? folderProblem(w.cwd, this.opts.readDir ?? readdirSync, this.opts.platform) : null;
    if (folder) throw new StartError(folder);
    beforeSession?.();
    // A tmux server that survives from an older start (for example a launcher start) keeps its old
    // global PATH. So a local session gets the PATH of this server. A remote session keeps the host PATH.
    const env = local && process.env.PATH ? { ...l.env, PATH: process.env.PATH } : l.env;
    await this.pool.of(w.host).newSession(sessionName(w.id), w.cwd, env, l.cmd);
    if (!local) return; // A remote check would need one more ssh round trip. The host poll finds a dead session.
    const wait = this.opts.startCheckMs ?? 1500;
    if (wait > 0) await (this.opts.sleep ?? Bun.sleep)(wait);
    if (!(await this.tmuxOf(w.id).has(sessionName(w.id))))
      throw new StartError(`${w.name} exited right after start. Run the agent in a terminal to see why: ${agentBin} …`);
  }

  /** Take a worker out of the state again after a failed spawn. Its session did not start. */
  private unregister(id: string) {
    this.state.workers = this.state.workers.filter(x => x.id !== id);
    this.state.links = this.state.links.filter(l => l.a !== id && l.b !== id);
    this.emit({ t: 'removed', id });
    this.emit({ t: 'links', links: this.state.links, cut: this.state.cut });
    this.persist();
  }

  /** Show a failed start on the card: stopped, with the error as task, and one Activity line. */
  private startFailed(w: Worker, e: unknown) {
    const msg = (e as Error).message;
    w.status = 'stopped'; w.task = msg;
    this.activity(`${w.name} did not start: ${msg}`);
    this.touch(w);
  }

  /** Start the login shell of a shell box. It gets no console token and no session files. */
  private async startShell(w: Worker) {
    const link = this.remoteLink(w.host!, 'claude');
    const r = await link.exec(['sh', '-c', 'printf %s "$SHELL"']);
    const out = r.code === 0 ? r.out.trim() : '';
    const sh = /^\/[^\s;&|<>$`'"\\]+$/.test(out) ? out : '/bin/sh';
    await this.pool.of(w.host).newSession(sessionName(w.id), w.cwd, {}, [sh, '-l']);
  }

  /** Open a plain login shell on a connected remote host. No agent runs in it. */
  async openShell(host: string): Promise<Worker> {
    const link = this.remoteLink(host, 'claude');
    const id = uniqueId(`shell-${host}`, this.takenIds());
    const w: Worker = {
      id, name: `Shell · ${link.host.name}`, role: 'worker', kind: 'shell', host, cwd: await link.home(), repo: link.host.name,
      status: 'idle', task: 'Shell', ...this.nextSlot(),
    };
    await this.startShell(w);
    this.state.workers.push(w);
    this.activity(`Opened a shell on ${link.host.name}.`);
    this.touch(w);
    return w;
  }

  async spawn(input: SpawnInput): Promise<Worker> {
    // Check the agent and the options first, before any side effect (the worktree, the session).
    // The default worker agent is for workers only. The advisor agent comes from the caller.
    const agent = validateAgent(input.agent ?? ((input.role ?? 'worker') === 'worker' ? this.cfg.defaultWorkerAgent : undefined), input.options).agent;
    const role = input.role ?? 'worker';
    const host = isLocal(input.host) ? undefined : input.host;
    const rlink = host ? this.remoteLink(host, agent ?? 'claude') : undefined;
    const id = role === 'advisor' || role === 'reviewer' ? role : uniqueId(input.name, this.takenIds());
    // A seat replaces an older seat with the same id. It never replaces a worker.
    const held = this.get(id);
    if (held && role !== 'worker') {
      if (held.role === 'worker') throw new Error(`id ${id} is taken by a worker; rename or remove it`);
      this.state.workers = this.state.workers.filter(w => w.id !== id);
    }
    let cwd = input.repo;
    let branch: string | undefined;
    let worktree: string | undefined;
    if (input.worktree) {
      branch = input.worktree.branch;
      const base = input.worktree.base;
      // A leading "-" would be read by git as an option.
      if (rlink) {
        worktree = await addRemoteWorktree(rlink, input.repo, branch, base, slugify, input.worktree.existing);
      } else {
        if (!branch || branch.startsWith('-') || base?.startsWith('-')) throw new Error('bad branch name');
        worktree = join(dirname(input.repo), 'worktrees', `${basename(input.repo)}-${slugify(branch)}`);
        await this.exec(['git', 'worktree', 'add', ...(input.worktree.existing ? ['--', worktree, branch] : [worktree, '-b', branch, ...(base ? [base] : [])])], input.repo);
      }
      cwd = worktree;
    }
    const n = this.state.workers.filter(x => x.role === 'worker').length;
    const lead = this.get('advisor');
    // The reviewer box sits right of the lead box.
    const seatPos = role === 'reviewer' && lead ? { x: lead.x + (lead.w ?? 760) + 60, y: lead.y } : undefined;
    const w: Worker = {
      id, name: input.name, role, cwd, repo: basename(input.repo), branch, worktree,
      status: 'idle', task: 'Starting…', ...(host ? { host } : {}),
      ...(agent ? { agent } : {}), ...(input.options && Object.keys(input.options).length ? { options: input.options } : {}),
      x: seatPos?.x ?? (role === 'advisor' ? 760 : 40 + (n % 3) * 760), y: seatPos?.y ?? (role === 'advisor' ? 620 : (Math.floor(n / 3) % 2 ? 1200 : 40) + Math.floor(n / 6) * 1160),
    };
    if (input.beforeStart) await input.beforeStart(cwd);
    const template = this.cfg.templates.find(t => t.name === input.template) ?? (input.prompt ? { name: 'prompt', prompt: input.prompt } : undefined);
    let registered = false;
    const register = () => {
      if (registered) return;
      registered = true;
      this.state.workers.push(w);
      if (role === 'worker' && this.get('advisor')) this.connect('advisor', id, 'advisor');
      this.touch(w);
    };
    try { await this.start(w, { resume: input.resume, template }, adapterOf(w), register); }
    catch (e) {
      // The user removed the card during the start wait: do not bring it back.
      if (registered && !this.get(id)) throw e;
      if (e instanceof StartError) {
        // Keep the card, so the user sees why it did not start and can restart it.
        register();
        this.startFailed(w, e);
      } else if (registered) this.unregister(id);
      throw e;
    }
    this.activity(`Started ${w.name} in ${w.repo}${branch ? ` (worktree ${branch}${input.worktree?.base ? ` from ${input.worktree.base}` : ''})` : ''}.`);
    this.touch(w);
    return w;
  }

  async stop(id: string) {
    const w = this.get(id); if (!w) return;
    if (this.swapping && w.role !== 'worker') throw new Error('a swap is already running');
    await this.killSession(w);
    w.status = 'stopped'; w.task = 'Stopped';
    this.activity(`Stopped ${w.name}.`);
    this.touch(w);
  }

  async restart(id: string, resume = true) {
    const w = this.get(id); if (!w) return;
    if (this.swapping && w.role !== 'worker') throw new Error('a swap is already running');
    // Find the adapter first: an unknown agent must throw while the old session still runs.
    if (w.kind === 'shell') {
      await this.tmuxOf(id).kill(sessionName(id));
      await this.startShell(w);
      w.status = 'idle'; w.task = 'Shell';
      this.activity(`Restarted ${w.name}.`);
      this.touch(w);
      return;
    }
    const adapter = adapterOf(w);
    await this.tmuxOf(id).kill(sessionName(id));
    // The old session is gone now, so any start error leaves the card stopped. The route still gets the error (409).
    try { await this.start(w, { resume }, adapter); }
    catch (e) { this.startFailed(w, e); throw e; }
    w.status = 'idle'; w.task = 'Restarted';
    this.activity(`Restarted ${w.name}.`);
    this.touch(w);
  }

  private swapping = false;
  /** One settle timer for each seat, so a swap of one seat does not cancel the other. */
  private settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private clearSettle(id: string) {
    const t = this.settleTimers.get(id);
    if (t) { clearTimeout(t); this.settleTimers.delete(id); }
  }
  private seatAdapter(id: string, agent: string): AgentAdapter {
    if (!Object.hasOwn(ADAPTERS, agent)) throw new Error(`unknown agent: ${agent} (known: ${Object.keys(ADAPTERS).join(', ')})`);
    const a = ADAPTERS[agent]!;
    if (!a.caps.advisor) throw new Error(`${a.label} cannot be the ${id}`);
    return a;
  }

  /** Change the agent of the advisor. */
  swapAdvisor(agent: string): Promise<Worker> { return this.swapSeat('advisor', agent); }

  /** Change the agent of a seat (advisor or reviewer). One lock covers both seats. */
  async swapSeat(id: 'advisor' | 'reviewer', agent: string): Promise<Worker> {
    // A swap of the same agent is no change, also while another swap runs.
    const cur = this.get(id);
    if (cur && Object.hasOwn(ADAPTERS, agent) && adapterOf(cur).id === agent && ADAPTERS[agent]!.caps.advisor) return cur;
    if (this.swapping) throw new Error('a swap is already running');
    this.swapping = true;
    try { return await this.swapSeatLocked(id, agent); }
    finally { this.swapping = false; }
  }

  /** Swap the agents of the two seats. Advisor first, then reviewer, under one lock. */
  async swapRoles(): Promise<{ advisor: Worker; reviewer: Worker }> {
    if (this.swapping) throw new Error('a swap is already running');
    const lead = this.get('advisor');
    const rev = this.reviewer();
    if (!lead) throw new Error('no advisor');
    if (!rev) throw new Error('no reviewer');
    const leadAgent = adapterOf(lead).id;
    const revAgent = adapterOf(rev).id;
    // Check both seats first. Nothing stops when a check fails.
    this.seatAdapter('advisor', revAgent);
    this.seatAdapter('reviewer', leadAgent);
    if (leadAgent === revAgent) return { advisor: lead, reviewer: rev };
    this.swapping = true;
    try {
      const advisor = await this.swapSeatLocked('advisor', revAgent);
      const reviewer = await this.swapSeatLocked('reviewer', leadAgent);
      return { advisor, reviewer };
    } finally { this.swapping = false; }
  }

  /** The work of a swap. The caller holds the lock. Check everything first, then stop the old session. */
  private async swapSeatLocked(id: 'advisor' | 'reviewer', agent: string): Promise<Worker> {
    const seat = this.get(id);
    if (!seat) throw new Error(`no ${id}`);
    const a = this.seatAdapter(id, agent);
    const label = id === 'advisor' ? 'Advisor' : 'Reviewer';
    const oldAdapter = adapterOf(seat);
    const old = oldAdapter.id;
    if (old === agent) return seat;
    this.clearSettle(id);
    // Hold all messages for the whole swap: the old session is dead and the new one is not ready.
    this.pendingTools.add(id);
    // Messages queued for the old session are dropped. Tell the user.
    const dropped = this.queue.get(id)?.length ?? 0;
    if (this.queue.delete(id)) this.emit({ t: 'queued', id, count: 0 });
    if (dropped > 0) this.activity(`Dropped ${dropped} queued message(s) for the ${id} (swap).`);
    try {
      if (seat.sessionId) seat.lastSessions = { ...seat.lastSessions, [old]: seat.sessionId };
      // Deny every open need of the old session, as remove() does. Their waiters belong to the process that stops now.
      for (const n of this.needs()) if (n.id === id) this.resolveNeed(n.nid, 'deny');
      // Let the waiter code (hook server) finish before the swap sets the final status.
      await new Promise<void>(r => setTimeout(r, 0));
      await this.tmuxOf(id).kill(sessionName(id));
      seat.agent = agent;
      const saved = seat.lastSessions?.[agent];
      if (saved) seat.sessionId = saved; else delete seat.sessionId;
      try { await this.start(seat, { resume: !!seat.sessionId }, a); }
      catch (e) {
        this.pendingTools.delete(id);
        seat.status = 'stopped'; seat.task = `Swap failed: ${(e as Error).message}`;
        this.touch(seat);
        throw e;
      }
      seat.status = 'idle';
      seat.task = `Switched to ${a.label}`;
      this.activity(`${label} switched from ${oldAdapter.label} to ${a.label}${seat.sessionId ? ' (resumed)' : ''}.`);
      this.touch(seat);
      // Keep the busy mark while the new TUI loads. Then send the queued messages.
      const settle = this.opts.swapSettleMs ?? SWAP_SETTLE_MS;
      if (settle <= 0) this.toolEnd(id);
      else this.settleTimers.set(id, setTimeout(() => { this.settleTimers.delete(id); this.toolEnd(id); }, settle));
    } catch (e) {
      this.pendingTools.delete(id);
      throw e;
    }
    return seat;
  }

  /** Add the reviewer next to the lead, linked to the lead only. */
  async addReviewer(agent: string): Promise<Worker> {
    const a = this.seatAdapter('reviewer', agent);
    if (this.reviewer()) throw new Error('a reviewer exists');
    if (this.get('reviewer')) throw new Error('id reviewer is taken by a worker; rename or remove it');
    const lead = this.get('advisor');
    if (!lead) throw new Error('no advisor');
    const w = await this.spawn({ name: 'Reviewer', repo: lead.cwd, role: 'reviewer', agent });
    // The user asked for this reviewer, so it always gets its wire.
    this.connect('advisor', w.id, 'you');
    this.activity(`Added a reviewer (${a.label}).`);
    return w;
  }

  /** Remove the reviewer. Its needs are denied, its queue is dropped and its link goes. The lead keeps running. */
  async removeReviewer(): Promise<void> {
    if (!this.reviewer()) throw new Error('no reviewer');
    const had = this.queue.has('reviewer');
    await this.remove('reviewer', 'Removed the reviewer.');
    if (had) this.emit({ t: 'queued', id: 'reviewer', count: 0 });
  }

  async remove(id: string, note?: string) {
    const w = this.get(id); if (!w) return;
    // A swap holds the seat object while its session starts. Wait for it to end.
    if (this.swapping && w.role !== 'worker') throw new Error('a swap is already running');
    this.clearSettle(id);
    this.pendingTools.delete(id);
    await this.killSession(w);
    this.state.workers = this.state.workers.filter(x => x.id !== id);
    this.state.links = this.state.links.filter(l => l.a !== id && l.b !== id);
    // A cut of the reviewer link does not outlive the reviewer. The user cuts of advisor-worker links stay.
    if (w.role === 'reviewer') this.state.cut = this.state.cut.filter(k => !k.split('~').includes(id));
    if (this.state.steps) delete this.state.steps[id];
    for (const n of this.needs()) if (n.id === id) this.resolveNeed(n.nid, 'deny');
    this.queue.delete(id);
    this.emit({ t: 'removed', id });
    this.emit({ t: 'links', links: this.state.links, cut: this.state.cut });
    this.activity(note ?? `Removed ${w.name}.`);
    this.persist();
  }

  async interrupt(id: string) {
    await this.tmuxOf(id).sendKey(sessionName(id), 'Escape');
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
    const live = new Set((await this.pool.local.list()).filter(s => s.startsWith('ac-')).map(s => s.slice(3)));
    for (const w of this.state.workers) {
      if (w.kind === 'linked') { if (!this.alive(w.pid ?? 0)) { w.status = 'stopped'; w.task = 'Session ended'; } continue; }
      // A remote worker is checked against its own host in discoverHost.
      if (!isLocal(w.host)) continue;
      if (live.has(w.id)) { if (w.status === 'stopped') w.status = 'idle'; }
      else { w.status = 'stopped'; w.task = 'Session not running'; }
    }
    const maxY = Math.max(0, ...this.state.workers.map(w => w.y));
    let k = 0;
    for (const id of live) {
      if (this.get(id)) continue;
      // Below everything known, so a found session never covers an existing box.
      this.state.workers.push({ id, name: id, role: id === 'advisor' || id === 'reviewer' ? id : 'worker', cwd: '', repo: '?', status: 'idle', task: 'Found running', x: 40 + (k % 3) * 760, y: maxY + 600 + Math.floor(k / 3) * 600 });
      k++;
    }
    this.persist();
    for (const l of this.hosts?.all() ?? []) {
      if (l.state === 'up') await this.discoverHost(l.host.id).catch(e => console.error(`host ${l.host.id}: ${(e as Error).message}`));
      else this.hostOffline(l.host.id);
    }
    // A worker whose host left the config cannot be reached.
    const known = new Set((this.hosts?.all() ?? []).map(l => l.host.id));
    for (const w of this.state.workers) {
      if (isLocal(w.host) || known.has(w.host!) || w.kind === 'linked' || w.status === 'stopped') continue;
      w.status = 'stopped'; w.task = 'Host removed'; this.touch(w);
    }
  }

  /** Match the workers of one host with the tmux sessions on it. Unknown remote sessions are not added. */
  async discoverHost(id: string): Promise<void> {
    const link = this.hosts?.link(id);
    if (!link) throw new Error(`unknown host ${id}`);
    // Ask ssh directly: a failed ssh call must not look like "no sessions".
    const r = await link.exec(['tmux', '-L', this.pool.local.socket, 'list-sessions', '-F', '#{session_name}']);
    let out = r.out;
    if (r.code !== 0) {
      if (r.code === 1 && /no server running|error connecting/i.test(r.err)) out = '';
      else throw new Error(`could not list tmux sessions on ${link.host.name}: ${r.err.trim() || `code ${r.code}`}`);
    }
    const live = new Set(out.split('\n').filter(s => s.startsWith('ac-')).map(s => s.slice(3)));
    for (const w of this.state.workers) {
      if (w.host !== id || w.kind === 'linked') continue;
      if (live.has(w.id)) {
        if (w.status === 'stopped') { w.status = 'idle'; if (w.task === 'Host offline') w.task = 'Reconnected'; this.touch(w); }
      } else if (w.status !== 'stopped' || w.task === 'Host offline') {
        w.status = 'stopped'; w.task = 'Session not running'; this.touch(w);
      }
    }
    this.persist();
  }

  /** The host went down. Its workers show as offline. The sessions may still run there, so nothing is killed. */
  private hostOffline(id: string) {
    for (const w of this.state.workers) {
      if (w.host !== id || w.kind === 'linked' || w.status === 'stopped') continue;
      w.status = 'stopped'; w.task = 'Host offline'; this.touch(w);
    }
  }

  /** The host left the config. Its workers stay as records, marked as stopped. */
  private hostRemoved(id: string) {
    for (const w of this.state.workers) {
      if (w.host !== id || w.kind === 'linked' || (w.status === 'stopped' && w.task === 'Host removed')) continue;
      w.status = 'stopped'; w.task = 'Host removed'; this.touch(w);
    }
  }

  // ---------- links ----------
  linked(a: string, b: string) { return this.state.links.some(l => linkKey(l.a, l.b) === linkKey(a, b)); }

  connect(a: string, b: string, by: 'advisor' | 'you'): boolean {
    if (a === b) return false;
    // The advisor never wires a shell box on its own. The user still can.
    if (by === 'advisor' && (this.get(a)?.kind === 'shell' || this.get(b)?.kind === 'shell')) return false;
    // The reviewer links to the advisor only.
    const ra = this.get(a)?.role; const rb = this.get(b)?.role;
    if ((ra === 'reviewer' && rb !== 'advisor') || (rb === 'reviewer' && ra !== 'advisor')) return false;
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
      id: uniqueId(ext.name, this.takenIds()), name: ext.name, role: 'worker', kind: 'linked',
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
      w = { id: uniqueId(ext.name, this.takenIds()), name: ext.name, role: 'worker', cwd: ext.cwd,
        repo: basename(ext.cwd), sessionId: ext.sessionId, status: 'idle', task: '', ...this.nextSlot() };
      this.state.workers.push(w);
    }
    w.kind = 'tmux'; delete w.pid;
    w.status = 'idle'; w.task = 'Moved into the console (resumed)';
    // The outside process is gone now, so a start error must not leave an idle card with no session.
    try { await this.start(w, { resume: true }); }
    catch (e) { this.startFailed(w, e); throw e; }
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
    // Defense in depth: only the user types into a shell box.
    if (w.kind === 'shell' && from !== 'you') throw new Error('shell boxes take input only from you');
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
    await this.tmuxOf(to).sendText(sessionName(to), msg);
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
    for (const msg of q) await this.tmuxOf(id).sendText(sessionName(id), msg);
    this.emit({ t: 'queued', id, count: 0 });
  }
}
