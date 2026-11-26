import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths';
import { shJoin } from './shq';
import type { Host } from './types';

export type LinkState = 'down' | 'connecting' | 'up' | 'error';
export interface ExecResult { out: string; err: string; code: number }
export type Spawner = (cmd: string[], stdin?: string, timeoutMs?: number) => Promise<ExecResult>;

export const defaultSockDir = () => join(configDir(), 'ssh');

/** How often an up link asks its master if it still runs. */
export const WATCH_MS = 15000;
/** Run fn every ms. Returns a function that stops it. */
export type Every = (fn: () => void, ms: number) => () => void;
const realEvery: Every = (fn, ms) => {
  const t = setInterval(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
};
export interface LinkOpts {
  consolePort: number; sockDir: string; spawn?: Spawner; now?: () => number; timeoutMs?: number;
  /** The timer of the master watch. Tests inject one. */
  every?: Every; watchMs?: number;
}

/** The real spawner. It never runs in tests: they inject a fake. */
const bunSpawner = (defaultMs: number): Spawner => async (cmd, stdin, ms) => {
  const timeoutMs = ms ?? defaultMs;
  const p = Bun.spawn(cmd, { stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill(); }, timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return timedOut ? { out: '', err: 'timed out', code: 124 } : { out, err, code };
  } finally { clearTimeout(timer); }
};

/** One SSH control master for one host, plus the reverse tunnel. Emits 'state'. */
export class HostLink extends EventTarget {
  state: LinkState = 'down';
  /** The profile. The pool changes it in place when only the cosmetic fields change. */
  host: Host;
  latencyMs?: number;
  lastError?: string;
  /** True after disconnect() and before the next connect(). The pool does not reconnect then. */
  wantDown = false;
  private spawn: Spawner;
  private now: () => number;
  private consolePort: number;
  private sockDir: string;
  private timeoutMs: number;
  private every: Every;
  private watchMs: number;
  private stopWatch?: () => void;
  private checking = false;

  constructor(host: Host, o: LinkOpts) {
    super();
    this.host = host;
    this.consolePort = o.consolePort; this.sockDir = o.sockDir;
    this.every = o.every ?? realEvery; this.watchMs = o.watchMs ?? WATCH_MS;
    this.timeoutMs = o.timeoutMs ?? 20000;
    this.spawn = o.spawn ?? bunSpawner(this.timeoutMs); this.now = o.now ?? Date.now;
  }

  sock(): string { return `${this.sockDir}/${this.host.id}.sock`; }
  tunnelPort(): number { return this.host.tunnelPort ?? this.consolePort; }

  masterArgs(): string[] {
    const h = this.host;
    return [
      'ssh', '-M', '-N', '-f',
      '-o', 'ControlPersist=yes', '-o', 'ServerAliveInterval=15',
      '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
      '-S', this.sock(),
      '-R', `127.0.0.1:${this.tunnelPort()}:127.0.0.1:${this.consolePort}`,
      ...(h.port ? ['-p', String(h.port)] : []),
      ...(h.identityFile ? ['-i', h.identityFile] : []),
      ...(h.jump ? ['-J', h.jump] : []),
      h.ssh,
    ];
  }

  private homeCache?: string;
  /** The home folder on the host. Read once, then cached. */
  async home(): Promise<string> {
    if (this.homeCache) return this.homeCache;
    const r = await this.exec(['sh', '-c', 'printf %s "$HOME"']);
    const h = r.out.trim();
    if (r.code !== 0 || !h.startsWith('/')) throw new Error(`could not read the home folder on ${this.host.name}`);
    return (this.homeCache = h);
  }

  sshArgs(remote: string[], tty = false): string[] {
    return ['ssh', '-S', this.sock(), '-o', 'BatchMode=yes', ...(tty ? ['-t'] : []), this.host.ssh, '--', shJoin(remote)];
  }

  /** Run one command. A spawner that never answers ends as code 124 after timeoutMs. */
  private run(cmd: string[], stdin?: string, timeoutMs = this.timeoutMs): Promise<ExecResult> {
    let timer: ReturnType<typeof setTimeout>;
    const late = new Promise<ExecResult>(r => { timer = setTimeout(() => r({ out: '', err: 'timed out', code: 124 }), timeoutMs + 500); });
    return Promise.race([this.spawn(cmd, stdin, timeoutMs), late]).finally(() => clearTimeout(timer));
  }

  private set(s: LinkState) {
    this.state = s;
    // Only an up link has a master to watch.
    if (s === 'up') this.stopWatch ??= this.every(() => void this.watchOnce(), this.watchMs);
    else { this.stopWatch?.(); this.stopWatch = undefined; }
    this.dispatchEvent(new Event('state'));
  }

  private checkArgs(): string[] { return ['ssh', '-S', this.sock(), '-O', 'check', this.host.ssh]; }

  /** Ask the master if it still runs. A master that does not answer makes the link go to 'error'. */
  async watchOnce(): Promise<void> {
    if (this.state !== 'up' || this.checking) return;
    this.checking = true;
    try {
      const r = await this.run(this.checkArgs());
      if (r.code !== 0) this.lost();
    } finally { this.checking = false; }
  }

  /** The master is gone. The pool then reconnects, and the registry marks the workers offline. */
  private lost() {
    if (this.state !== 'up' || this.wantDown) return;
    this.fail(`${this.host.name} lost the connection`);
  }

  private fail(msg: string) {
    this.lastError = msg;
    this.latencyMs = undefined;
    this.set('error');
  }

  private explain(err: string, code = 1): string {
    const name = this.host.name;
    if (code === 124) return `${name} did not answer in time`;
    if (/remote port forwarding failed/i.test(err))
      return `Tunnel port ${this.tunnelPort()} is in use on ${name}. Change "Tunnel port" in the host profile.`;
    if (/permission denied/i.test(err))
      return `${name} refused the login. Use ssh-agent or a key file. The console does not use passwords.`;
    const lines = err.trim().split('\n');
    return lines[lines.length - 1] || `${name} connect failed`;
  }

  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'up') return;
    this.lastError = undefined;
    this.wantDown = false;
    this.set('connecting');
    try {
      mkdirSync(this.sockDir, { recursive: true, mode: 0o700 });
      // A master from an earlier run (a crash or kill -9) holds the tunnel port. Stop it first.
      const old = await this.run(this.checkArgs());
      if (this.wantDown) return this.abort();
      if (old.code === 0) await this.killMaster();
      else if (existsSync(this.sock())) { try { unlinkSync(this.sock()); } catch { /* ignore */ } }
      if (this.wantDown) return this.abort();
      const m = await this.run(this.masterArgs());
      if (this.wantDown) return this.abort();
      if (m.code !== 0) return this.fail(this.explain(m.err, m.code));
      const chk = await this.run(this.checkArgs());
      if (this.wantDown) return this.abort();
      if (chk.code !== 0) { await this.killMaster(); return this.fail(this.explain(chk.err, chk.code)); }
      const t0 = this.now();
      const p = await this.run(this.sshArgs(['echo', 'ok']));
      if (this.wantDown) return this.abort();
      if (p.code !== 0 || p.out.trim() !== 'ok') {
        await this.killMaster();
        return this.fail(p.code === 124 ? this.explain('', 124) : this.explain(p.err) || `${this.host.name} did not answer the probe`);
      }
      this.latencyMs = this.now() - t0;
      this.set('up');
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** disconnect() came during connect(). Stop the master and end in 'down'. */
  private async abort(): Promise<void> {
    await this.killMaster();
    this.latencyMs = undefined;
    if (this.state !== 'down') this.set('down');
  }

  /** Best effort: stop a master that started but is not usable. */
  private async killMaster(): Promise<void> {
    try { await this.run(['ssh', '-S', this.sock(), '-O', 'exit', this.host.ssh]); } catch { /* ignore */ }
  }

  async disconnect(): Promise<void> {
    this.wantDown = true;
    await this.killMaster();
    this.latencyMs = undefined;
    this.set('down');
  }

  async exec(remote: string[], stdin?: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    if (this.state !== 'up') throw new Error(`${this.host.name} is not connected`);
    const r = await this.run(this.sshArgs(remote), stdin, opts.timeoutMs);
    // ssh itself exits with 255 when it cannot reach the host.
    if (r.code === 255) this.lost();
    return r;
  }
}
