/** The last canvas of this browser: pan/zoom, selection and the open focus terminal. */
export const KEY = 'ac.canvas';

export interface SavedCanvas { view: { x: number; y: number; z: number }; sel: string[]; focus: string | null }
interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadCanvas(s: Store): SavedCanvas | null {
  try {
    const raw = JSON.parse(s.getItem(KEY) ?? 'null');
    const v = raw?.view;
    if (!v || !num(v.x) || !num(v.y) || !num(v.z) || v.z <= 0) return null;
    return {
      view: { x: v.x, y: v.y, z: v.z },
      sel: Array.isArray(raw.sel) ? raw.sel.filter((x: unknown): x is string => typeof x === 'string') : [],
      focus: typeof raw.focus === 'string' ? raw.focus : null,
    };
  } catch { return null; }
}

/** Storage can be blocked (private window); the canvas works without it. */
export function saveCanvas(s: Store, c: SavedCanvas): void {
  try { s.setItem(KEY, JSON.stringify(c)); } catch { /* storage blocked */ }
}
