import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** Sent on real keystrokes only, so the server can tell them from automatic terminal replies. */
const TYPING = '{"typing":1}';

export const BASE = { cols: 120, rows: 36 };
const THEME = { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9', selectionBackground: '#264f78' };

function termSocket(id: string, onData: (d: Uint8Array) => void): WebSocket {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term/${id}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = e => onData(typeof e.data === 'string' ? new TextEncoder().encode(e.data) : new Uint8Array(e.data));
  return ws;
}

/** A small live terminal inside a canvas box. Attached only while visible.
 *  A box with a saved size fits the terminal to the box and sends that size to the PTY.
 *  A box without a saved size keeps BASE and sends no resize message. */
export class BoxTerm {
  readonly term: Terminal;
  private fitter = new FitAddon();
  private ws: WebSocket | null = null;
  private io: IntersectionObserver;
  private visible = false;
  private sized = false;
  private paused = false;

  /** `held` is true while focus mode shows this worker: then the focus terminal owns the PTY size. */
  constructor(readonly id: string, readonly el: HTMLElement, private held: () => boolean = () => false) {
    this.term = new Terminal({ ...BASE, fontSize: 8, lineHeight: 1, theme: THEME, cursorBlink: false, scrollback: 100, allowProposedApi: false });
    this.term.loadAddon(this.fitter);
    this.term.open(el);
    this.term.onData(d => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(new TextEncoder().encode(d)); });
    this.term.onKey(() => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(TYPING); });
    this.io = new IntersectionObserver(([e]) => {
      this.visible = !!e?.isIntersecting;
      if (!this.visible) { this.detach(); return; }
      // The box may have got its size while the terminal was hidden (Flow view): fit before attach,
      // so that onopen sends the correct size.
      if (this.sized) this.fit(true);
      this.attach();
    });
    this.io.observe(el);
  }

  attach() {
    if (this.ws || !this.visible || this.paused) return;
    this.term.reset();
    const ws = termSocket(this.id, d => this.term.write(d));
    // A new PTY starts at BASE, so give it the box size again.
    ws.onopen = () => { if (this.sized) this.sendSize(); };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; setTimeout(() => this.attach(), 2000); } };
    this.ws = ws;
  }

  private sendSize() {
    if (this.held()) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ resize: [this.term.cols, this.term.rows] }));
  }

  /** Fit cols/rows to the box when it has a saved size. Without one, go back to BASE.
   *  After a reset the PTY still has the old box size, so it gets BASE again. */
  fit(sized: boolean) {
    const wasSized = this.sized;
    this.sized = sized;
    if (sized) {
      // A hidden terminal (Flow view) has no size to fit to. It fits when it becomes visible.
      if (!this.el.offsetWidth || !this.el.offsetHeight) return;
      try { this.fitter.fit(); } catch { return; }
      this.sendSize();
    } else if (wasSized) {
      this.term.resize(BASE.cols, BASE.rows);
      this.sendSize();
    }
  }

  /** The size that the PTY must have when this box is the only viewer. */
  size() { return { cols: this.term.cols, rows: this.term.rows }; }

  detach() { const ws = this.ws; this.ws = null; ws?.close(); }
  reconnect() { this.detach(); this.attach(); }
  /** The tab is hidden: stop the stream. On resume the server sends a fresh screen snapshot. */
  pause() { this.paused = true; this.detach(); }
  resume() { this.paused = false; this.attach(); }
  dispose() { this.io.disconnect(); this.detach(); this.term.dispose(); }
}

/** The big terminal in focus mode. It resizes the PTY to fit, and gives it back at the box size on close.
 *  The socket reconnects by itself, so a server restart does not leave a dead terminal. */
export class FocusTerm {
  private term: Terminal;
  private fit = new FitAddon();
  private ws: WebSocket | null = null;
  private ro: ResizeObserver;
  private disposed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly id: string, el: HTMLElement) {
    el.innerHTML = '';
    this.term = new Terminal({ fontSize: 14, theme: THEME, cursorBlink: true, scrollback: 5000 });
    this.term.loadAddon(this.fit);
    this.term.open(el);
    this.term.onData(d => this.send(new TextEncoder().encode(d)));
    this.term.onKey(() => this.send(TYPING));
    el.addEventListener('paste', () => this.send(TYPING), true);
    this.ro = new ResizeObserver(() => this.doFit());
    this.ro.observe(el);
    this.connect();
    this.term.focus();
  }

  private send(d: string | Uint8Array<ArrayBuffer>) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(d); }

  private connect() {
    if (this.disposed) return;
    this.term.reset();
    const ws = termSocket(this.id, d => this.term.write(d));
    ws.onopen = () => this.doFit();
    ws.onclose = () => {
      if (this.ws !== ws || this.disposed) return;
      this.ws = null;
      this.retry = setTimeout(() => this.connect(), 2000);
    };
    this.ws = ws;
  }

  /** Drop the socket and attach again (for example when the state socket says the server is back). */
  reconnect() {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const ws = this.ws; this.ws = null; ws?.close();
    this.connect();
  }

  private doFit() {
    try { this.fit.fit(); } catch { return; }
    this.send(JSON.stringify({ resize: [this.term.cols, this.term.rows] }));
  }

  focus() { this.term.focus(); }

  /** `back` is the size of the canvas box terminal (BASE when the box has none). */
  dispose(back: { cols: number; rows: number } = BASE) {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ro.disconnect();
    this.send(JSON.stringify({ resize: [back.cols, back.rows] }));
    this.ws?.close();
    this.term.dispose();
  }
}
