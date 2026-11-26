import type { ExecResult } from '../src/ssh';
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

/** Stands in for a spawner. Records each cmd. A rule matches when its words
 *  appear in the cmd in the same order. The first matching rule wins.
 *  With no match it returns code 0 and empty output. Test utility only. */
export class FakeRunner {
  cmds: string[][] = [];
  stdins: (string | undefined)[] = [];
  private rules: { words: string[]; res: ExecResult }[] = [];
  on(words: string[], res: Partial<ExecResult>) {
    this.rules.push({ words, res: { out: '', err: '', code: 0, ...res } });
    return this;
  }
  spawn = async (cmd: string[], stdin?: string): Promise<ExecResult> => {
    this.cmds.push(cmd); this.stdins.push(stdin);
    for (const r of this.rules) {
      let i = 0;
      for (const c of cmd) if (c === r.words[i]) i++;
      if (i === r.words.length) return r.res;
    }
    return { out: '', err: '', code: 0 };
  };
}

/** Registry options for tests: no wait after a start, every agent binary is found, every transcript exists, and every folder is readable. */
export const START_OK = { startCheckMs: 0, which: (b: string) => `/usr/bin/${b}`, transcriptExists: () => true, readDir: () => [] };
