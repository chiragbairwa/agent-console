import { HostLink, type Every, type Spawner } from './ssh';
import { isLocal } from './hosts';
import { remoteTmux, type Tmux } from './tmux';
import type { Host } from './types';

/** The profile fields that the ssh master uses. A change of one of them needs a new link. */
const LINK_KEYS = ['ssh', 'port', 'identityFile', 'jump', 'tunnelPort'] as const;

/** Wait times before each reconnect try. The last value repeats. */
export const BACKOFF_MS = [2000, 5000, 15000, 30000];

interface PoolOpts { consolePort: number; sockDir: string; spawn?: Spawner; sleep?: (ms: number) => Promise<void>; every?: Every; watchMs?: number }

/** All host links. Re-emits each link 'state' event as CustomEvent('state', { detail: { id } }). */
export class HostPool extends EventTarget {
  private links = new Map<string, HostLink>();
  private looping = new Set<HostLink>();
  private sleep: (ms: number) => Promise<void>;

  constructor(hosts: Host[], private o: PoolOpts) {
    super();
    this.sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    for (const h of hosts) this.add(h);
  }

  private add(h: Host) {
    const link = new HostLink(h, { consolePort: this.o.consolePort, sockDir: this.o.sockDir, spawn: this.o.spawn, every: this.o.every, watchMs: this.o.watchMs });
    this.links.set(h.id, link);
    link.addEventListener('state', () => {
      this.dispatchEvent(new CustomEvent('state', { detail: { id: h.id } }));
      this.maybeReconnect(link);
    });
  }

  private wanted(link: HostLink): boolean {
    return this.links.get(link.host.id) === link && link.host.reconnect === true && !link.wantDown
      && (link.state === 'error' || link.state === 'down');
  }

  private maybeReconnect(link: HostLink) {
    if (this.looping.has(link) || !this.wanted(link)) return;
    this.looping.add(link);
    void (async () => {
      try {
        let i = 0;
        while (this.wanted(link)) {
          await this.sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]!);
          i++;
          if (!this.wanted(link)) break;
          await link.connect();
          if (link.state === 'up') i = 0;
        }
      } finally { this.looping.delete(link); }
    })();
  }

  link(id: string): HostLink {
    const l = this.links.get(id);
    if (!l) throw new Error(`unknown host ${id}`);
    return l;
  }

  all(): HostLink[] { return [...this.links.values()]; }

  /**
   * Add new hosts, disconnect removed ones, and apply changed ones.
   * A change of a cosmetic field (name, colour, notes, roots …) keeps the link.
   * A change of a connection field replaces the link. When the old link was up, the new one connects.
   * The promise ends when those connects end.
   */
  set(hosts: Host[]): Promise<void> {
    const ids = new Set(hosts.map(h => h.id));
    for (const [id, l] of [...this.links]) {
      if (!ids.has(id)) { this.links.delete(id); void l.disconnect(); }
    }
    const waits: Promise<void>[] = [];
    for (const h of hosts) {
      const old = this.links.get(h.id);
      if (!old) { this.add(h); continue; }
      if (JSON.stringify(old.host) === JSON.stringify(h)) continue;
      if (LINK_KEYS.every(k => old.host[k] === h[k])) {
        old.host = h;
        this.dispatchEvent(new CustomEvent('state', { detail: { id: h.id, profile: true } }));
        continue;
      }
      const wasUp = old.state === 'up' || old.state === 'connecting';
      this.links.delete(h.id);
      const gone = old.disconnect();
      this.add(h);
      const fresh = this.links.get(h.id)!;
      if (wasUp || h.autoConnect) waits.push(gone.then(() => this.links.get(h.id) === fresh ? fresh.connect() : undefined));
    }
    return Promise.all(waits).then(() => undefined);
  }

  async connectAuto(): Promise<void> {
    await Promise.all(this.all().filter(l => l.host.autoConnect).map(l => l.connect()));
  }
}

/** The Tmux for a host. No host, or 'local', is the local Tmux. A remote Tmux is made once for each link. */
export class TmuxPool {
  private remote = new Map<HostLink, Tmux>();
  constructor(readonly local: Tmux, private hosts: HostPool) {}

  of(host?: string): Tmux {
    if (isLocal(host)) return this.local;
    const link = this.hosts.link(host!);
    let t = this.remote.get(link);
    if (!t) { t = remoteTmux(link, this.local.socket); this.remote.set(link, t); }
    return t;
  }
}
