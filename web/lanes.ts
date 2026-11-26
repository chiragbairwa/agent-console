/** Group by Host: one lane for each host. Pure layout, no DOM. */
export interface LaneWorker { id: string; host?: string; role: string; w?: number; h?: number }
export interface Lane { host: string; name: string; x: number; y: number; w: number; h: number }

export const LANE_PAD = 60, LANE_HEAD = 40, BOX_GAP = 60, LANE_GAP = 160, PER_ROW = 3, BOX_W = 760, BOX_H = 560;

export function laneLayout(workers: LaneWorker[], hosts: { id: string; name: string }[]) {
  const groups = new Map<string, LaneWorker[]>([['local', []]]);
  for (const h of hosts) groups.set(h.id, []);
  const names = new Map([['local', 'This computer'], ...hosts.map(h => [h.id, h.name] as const)]);
  for (const w of workers) {
    const k = !w.host ? 'local' : w.host;
    // The advisor and the reviewer always stay on this computer.
    const g = w.role === 'advisor' || w.role === 'reviewer' ? 'local' : k;
    if (!groups.has(g)) { groups.set(g, []); names.set(g, g); }
    groups.get(g)!.push(w);
  }
  const rank = (w: LaneWorker) => w.role === 'advisor' ? 0 : w.role === 'reviewer' ? 1 : 2;
  const moves: { id: string; x: number; y: number }[] = [], lanes: Lane[] = [];
  let y = 0;
  for (const [host, list] of groups) {
    if (!list.length) continue;
    const ws = list.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map(o => o.w);
    let rowY = y + LANE_PAD + LANE_HEAD, inner = 0;
    for (let i = 0; i < ws.length; i += PER_ROW) {
      const row = ws.slice(i, i + PER_ROW);
      let x = LANE_PAD, rowH = 0;
      for (const w of row) {
        moves.push({ id: w.id, x, y: rowY });
        x += (w.w ?? BOX_W) + BOX_GAP; rowH = Math.max(rowH, w.h ?? BOX_H);
      }
      inner = Math.max(inner, x - BOX_GAP - LANE_PAD);
      rowY += rowH + BOX_GAP;
    }
    const h = rowY - BOX_GAP + LANE_PAD - y;
    lanes.push({ host, name: names.get(host)!, x: 0, y, w: LANE_PAD * 2 + inner, h });
    y += h + LANE_GAP;
  }
  return { moves, lanes };
}
