import type { Tmux } from '../src/tmux';

/** Records tmux calls; holds a set of "live" sessions. Test utility only. */
export class FakeTmux {
  socket = 'fake';
  sessions = new Set<string>();
  calls: { fn: string; args: unknown[] }[] = [];
  screen = 'line1\nline2\nline3\n';
  private rec(fn: string, ...args: unknown[]) { this.calls.push({ fn, args }); }
  async newSession(name: string, cwd: string, env: Record<string, string>, cmd: string[]) { this.rec('newSession', name, cwd, env, cmd); this.sessions.add(name); }
  async list() { return [...this.sessions]; }
  async has(n: string) { return this.sessions.has(n); }
  async kill(n: string) { this.rec('kill', n); this.sessions.delete(n); }
  async sendText(n: string, t: string) { this.rec('sendText', n, t); }
  async sendKey(n: string, k: string) { this.rec('sendKey', n, k); }
  async capture(n: string, o: { lines?: number } = {}) { this.rec('capture', n, o); return o.lines ? this.screen.trimEnd().split('\n').slice(-o.lines).join('\n') + '\n' : this.screen; }
  /** A long-lived stand-in for `tmux attach`, so PtyHub keeps the viewer open. */
  attachArgs(_n: string) { return ['sleep', '30']; }
  of(fn: string) { return this.calls.filter(c => c.fn === fn); }
  asTmux() { return this as unknown as Tmux; }
}
