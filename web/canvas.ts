/** Pan / zoom / node positions / wires / minimap. Pure view logic; app.ts owns the data. */
export interface View { x: number; y: number; z: number }
export interface Pos { id: string; x: number; y: number; el: HTMLElement }
export interface Wire { a: string; b: string; by: 'advisor' | 'you'; talk?: boolean }

/** Minimap fill for each status: the same colours as the `.s-*` dots in styles.css. */
const MINI: Record<string, string> = { done: '--ok', idle: '--ok', running: '--run', 'needs-you': '--warn', waiting: '--idle', stopped: '--idle' };

export const linkKey = (a: string, b: string) => [a, b].sort().join('~');

export class Canvas {
  view: View = { x: 0, y: 0, z: 0.6 };
  private pulses = new Set<SVGCircleElement>();
  private queued: 'draw' | 'mini' | null = null;
  constructor(
    readonly vp: HTMLElement, readonly world: HTMLElement,
    private gl: SVGGElement, private gp: SVGGElement, private mini: SVGSVGElement, private zLbl: HTMLElement,
    private nodes: () => Pos[], private wires: () => Wire[],
  ) {}

  apply() {
    this.world.style.transform = `translate(${this.view.x}px,${this.view.y}px) scale(${this.view.z})`;
    this.zLbl.textContent = `${Math.round(this.view.z * 100)}%`;
    this.schedule('mini');
  }

  /** Paint at most once per frame. A burst of events (or a pan) then costs one layout read, not one per event. */
  schedule(what: 'draw' | 'mini' = 'draw') {
    if (this.queued === 'draw' || this.queued === what) return;
    const first = this.queued === null;
    this.queued = what;
    if (first) requestAnimationFrame(() => {
      const q = this.queued; this.queued = null;
      if (q === 'draw') this.draw(); else this.drawMini();
    });
  }

  toWorld(clientX: number, clientY: number) {
    const r = this.vp.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.z, y: (clientY - r.top - this.view.y) / this.view.z };
  }

  zoomAt(f: number, sx?: number, sy?: number) {
    const r = this.vp.getBoundingClientRect();
    sx ??= r.width / 2; sy ??= r.height / 2;
    const nz = Math.min(2, Math.max(0.15, this.view.z * f));
    const wx = (sx - this.view.x) / this.view.z, wy = (sy - this.view.y) / this.view.z;
    this.view = { x: sx - wx * nz, y: sy - wy * nz, z: nz };
    this.apply();
  }

  private center(id: string, ns = this.nodes()): [number, number] | null {
    const n = ns.find(p => p.id === id);
    if (!n) return null;
    return [n.x + n.el.offsetWidth / 2, n.y + Math.min(n.el.offsetHeight / 2, 60)];
  }

  path(a: string, b: string, ns = this.nodes()) {
    const p = this.center(a, ns), q = this.center(b, ns);
    if (!p || !q) return '';
    const mx = (p[0] + q[0]) / 2;
    return `M${p[0]},${p[1]} C${mx},${p[1]} ${mx},${q[1]} ${q[0]},${q[1]}`;
  }

  draw() {
    const ns = this.nodes();
    this.gl.innerHTML = this.wires().map(w => {
      const d = this.path(w.a, w.b, ns); if (!d) return '';
      const k = linkKey(w.a, w.b);
      return `<path class="wire ${w.by === 'you' ? 'you' : ''} ${w.talk ? 'talk' : ''}" id="w-${k}" d="${d}"/><path class="hit" data-k="${k}" d="${d}"/>`;
    }).join('');
    this.drawMini();
  }

  pulse(from: string, to: string, color?: string) {
    const k = linkKey(from, to);
    const path = () => document.getElementById(`w-${k}`) as SVGPathElement | null;
    if (!path()) return;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', '7'); c.setAttribute('class', 'pulse');
    if (color) c.style.fill = color;
    this.gp.appendChild(c); this.pulses.add(c);
    const wire = this.wires().find(w => linkKey(w.a, w.b) === k);
    const rev = !!wire && wire.a !== from; // paths run from wire.a to wire.b
    let t0: number | null = null;
    const step = (ts: number) => {
      t0 ??= ts;
      const p = Math.min((ts - t0) / 900, 1);
      const el = path();
      if (el) { const L = el.getTotalLength(), pt = el.getPointAtLength((rev ? 1 - p : p) * L); c.setAttribute('cx', String(pt.x)); c.setAttribute('cy', String(pt.y)); }
      if (p < 1) requestAnimationFrame(step); else { c.remove(); this.pulses.delete(c); }
    };
    requestAnimationFrame(step);
  }

  bounds() {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const n of this.nodes()) {
      x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
      x2 = Math.max(x2, n.x + n.el.offsetWidth); y2 = Math.max(y2, n.y + n.el.offsetHeight);
    }
    return Number.isFinite(x1) ? { x1, y1, x2, y2 } : { x1: 0, y1: 0, x2: 800, y2: 600 };
  }

  fit() {
    const b = this.bounds(), r = this.vp.getBoundingClientRect(), pad = 50;
    const z = Math.min(1.2, Math.max(0.15, Math.min((r.width - pad * 2) / (b.x2 - b.x1), (r.height - pad * 2) / (b.y2 - b.y1))));
    this.view = { z, x: (r.width - (b.x2 - b.x1) * z) / 2 - b.x1 * z, y: (r.height - (b.y2 - b.y1) * z) / 2 - b.y1 * z };
    this.apply();
  }

  drawMini() {
    const ns = this.nodes(); if (!ns.length) { this.mini.innerHTML = ''; return; }
    const b = this.bounds(), W = 180, H = 110, pad = 200;
    const bx = b.x1 - pad, by = b.y1 - pad, s = Math.min(W / (b.x2 - b.x1 + pad * 2), H / (b.y2 - b.y1 + pad * 2));
    const r = this.vp.getBoundingClientRect(), v = this.view;
    this.mini.innerHTML = ns.map(n => {
      // The status class gives the colour: no getComputedStyle (a style recalc) per box per paint.
      const st = /\bs-([\w-]+)/.exec(n.el.querySelector('.dot')?.getAttribute('class') ?? '')?.[1] ?? '';
      return `<rect x="${(n.x - bx) * s}" y="${(n.y - by) * s}" width="${n.el.offsetWidth * s}" height="${n.el.offsetHeight * s}" rx="2" fill="var(${MINI[st] ?? '--idle'})" opacity=".75"/>`;
    }).join('') + `<rect x="${(-v.x / v.z - bx) * s}" y="${(-v.y / v.z - by) * s}" width="${r.width / v.z * s}" height="${r.height / v.z * s}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`;
    this.mini.onclick = e => {
      const m = this.mini.getBoundingClientRect();
      const wx = (e.clientX - m.left) / s + bx, wy = (e.clientY - m.top) / s + by;
      this.view = { ...this.view, x: r.width / 2 - wx * this.view.z, y: r.height / 2 - wy * this.view.z };
      this.apply();
    };
  }
}
