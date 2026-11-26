import type { Subprocess } from 'bun';
import type { Tmux } from './tmux';
import { sessionName } from './workers';

/** Anything we can push terminal bytes to (a ServerWebSocket in production). */
export interface Sink { send(data: string | Uint8Array): unknown; close?(): unknown }

interface Entry { term: Bun.Terminal; proc: Subprocess; sinks: Set<Sink> }

const CLEAR = '\x1b[2J\x1b[H';

/** One tmux attach per session, fanned out to every watching socket. */
export class PtyHub {
  private entries = new Map<string, Entry>();
  /** Sinks that left; a subscribe still awaiting its snapshot must not add them back (review I6). */
  private gone = new WeakSet<Sink>();
  private attach: (id: string) => string[];
  private snap?: (id: string) => Tmux | undefined;
  /**
   * `attach` gives the tmux attach command for a worker. A plain Tmux works too (same host for all).
   * `tmuxFor` gives the Tmux that holds the session, for the snapshot a late viewer gets.
   */
  constructor(attach: ((id: string) => string[]) | Tmux, tmuxFor?: (id: string) => Tmux | undefined) {
    if (typeof attach === 'function') { this.attach = attach; this.snap = tmuxFor; }
    else { this.attach = id => attach.attachArgs(sessionName(id)); this.snap = tmuxFor ?? (() => attach); }
  }

  active(id: string) { return this.entries.has(id); }

  async subscribe(id: string, sink: Sink, size = { cols: 120, rows: 36 }): Promise<void> {
    this.gone.delete(sink);
    let e = this.entries.get(id);
    if (!e) {
      const sinks = new Set<Sink>();
      // Resolve the command first: an unknown host throws here, before a Terminal exists.
      const argv = this.attach(id);
      const term = new Bun.Terminal({
        cols: size.cols, rows: size.rows, name: 'xterm-256color',
        data: (_t, data) => { for (const s of sinks) s.send(data); },
      });
      const proc = Bun.spawn(argv, {
        terminal: term, env: { ...process.env, TERM: 'xterm-256color', TMUX: '' },
      });
      const entry: Entry = { term, proc, sinks };
      e = entry;
      this.entries.set(id, entry);
      proc.exited.then(() => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
        try { entry.term.close(); } catch { /* already closed */ }
        // Close the viewers so the page reconnects (for example after a Restart).
        for (const s of entry.sinks) { s.send('\r\n\x1b[2m[session detached]\x1b[0m\r\n'); s.close?.(); }
        entry.sinks.clear();
      });
    } else {
      // A late viewer: tmux will not redraw for it, so send the current screen.
      const snap = (await this.snap?.(id)?.capture(sessionName(id), { escapes: true })) ?? '';
      if (this.gone.has(sink) || this.entries.get(id) !== e) return;
      sink.send(CLEAR + snap.replace(/\n/g, '\r\n'));
    }
    e.sinks.add(sink);
  }

  unsubscribe(sink: Sink) {
    this.gone.add(sink);
    for (const [id, e] of this.entries) {
      if (!e.sinks.delete(sink) || e.sinks.size) continue;
      this.entries.delete(id);
      e.proc.kill(); // detaches the tmux client; the session keeps running
      e.term.close();
    }
  }

  input(id: string, data: string | Uint8Array) { this.entries.get(id)?.term.write(data); }

  resize(id: string, cols: number, rows: number) {
    const e = this.entries.get(id);
    if (!e || !(cols > 0 && rows > 0)) return;
    e.term.resize(Math.floor(cols), Math.floor(rows));
    // Bun.Terminal sets the new size but sends no SIGWINCH (the child does not own the tty as a
    // foreground group). Without the signal the tmux client keeps its old size, so tell it.
    try { e.proc.kill('SIGWINCH'); } catch { /* already gone */ }
  }

  closeAll() {
    for (const e of this.entries.values()) { e.proc.kill(); e.term.close(); }
    this.entries.clear();
  }
}
