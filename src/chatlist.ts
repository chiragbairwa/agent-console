import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Step, StepStatus, StepTrack } from './steps';

/** Checklists that the agent writes as Markdown in its chat replies:
 *    - [ ] 1. Read the code        - [x] 1. Read the code → 21 files        - [~] 2. Fix (blocked)
 *  A later reply often repeats only the lines that changed, so lines merge into the list. */

export interface ChatItem { num?: string; text: string; note?: string; status: StepStatus }

const LINE = /^\s*[-*+]\s+\[([ xX~])\]\s+(.+?)\s*$/;
/** "1. [x] text": the number comes before the box. */
const NUM_FIRST = /^\s*(\d+)[.)]\s+\[([ xX~])\]\s+(.+?)\s*$/;
const NUM = /^(\d+)[.)]\s+/;

const plain = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
const words = (s: string) => plain(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length > 1);

/** The checklist lines of one reply, outside code blocks. */
export function parseChecklist(text: string): ChatItem[] {
  const out: ChatItem[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    let num: string | undefined, mark: string, body: string;
    const nf = line.match(NUM_FIRST);
    if (nf) { num = nf[1]; mark = nf[2]!; body = nf[3]!; }
    else {
      const m = line.match(LINE);
      if (!m) continue;
      mark = m[1]!; body = m[2]!;
      const n = body.match(NUM);
      if (n) { num = n[1]; body = body.slice(n[0].length); }
    }
    const [head, ...rest] = body.split(/\s+(?:→|->|—)\s+/);
    const status: StepStatus = mark === ' ' ? 'pending' : mark === '~' ? 'in_progress' : 'completed';
    out.push({ num, text: plain(head!).slice(0, 200), note: rest.length ? plain(rest.join(' → ')).slice(0, 160) : undefined, status });
  }
  return out;
}

/** Same first word and most of the words. */
function similar(textA: string, textB: string): boolean {
  const a = words(textA), b = words(textB);
  if (!a.length || !b.length || a[0] !== b[0]) return false;
  const shared = b.filter(w => a.includes(w)).length;
  return shared / Math.min(a.length, b.length) >= 0.5;
}

/** Same item: same number, or (with no numbers) similar words. */
function sameItem(s: Step, it: ChatItem): boolean {
  if (it.num && s.key === `n${it.num}`) return true;
  if (it.num && s.key.startsWith('n')) return false;
  return similar(s.text, it.text);
}

function move(s: Step, next: StepStatus, at: number): Step {
  if (s.status === next) return s;
  const o: Step = { ...s, status: next };
  if (next === 'in_progress') { o.startedAt ??= at; delete o.endedAt; }
  if (next === 'completed') { o.startedAt ??= at; o.endedAt = at; }
  if (next === 'pending') { delete o.startedAt; delete o.endedAt; }
  return o;
}

/** Merge one reply into the track. A tool checklist (TodoWrite / Task*) wins over chat lines. */
export function applyChat(t: StepTrack, text: string, at: number): StepTrack {
  if (t.source === 'todo') return t;
  const items = parseChecklist(text);
  if (!items.length) return t;
  let steps = t.source === 'chat' ? t.steps.slice() : [];
  let loose = t.loose;
  if (t.source !== 'chat') loose = [...t.loose, ...t.steps.flatMap(s => s.tools)].slice(-25); // prompt steps give way

  // A new task replaces the old list: two or more lines that are mostly unknown, or a fresh
  // all-open list whose words differ (numbers restart at 1 for each task, so they prove nothing).
  const known = items.filter(it => steps.some(s => sameItem(s, it))).length;
  const sameWords = items.filter(it => steps.some(s => similar(s.text, it.text))).length;
  const fresh = items.every(it => it.status === 'pending') && sameWords < items.length / 2;
  if (items.length >= 2 && (known < items.length / 2 || fresh)) steps = [];

  for (const it of items) {
    const i = steps.findIndex(s => sameItem(s, it));
    if (i < 0) {
      const key = it.num ? `n${it.num}` : `c${steps.length + 1}`;
      steps.push(move({ key, text: it.text, note: it.note, status: 'pending', tools: [] }, it.status, at));
    } else {
      steps[i] = { ...move(steps[i]!, it.status, at), ...(it.note ? { note: it.note } : {}) };
    }
  }
  return { source: 'chat', steps: steps.slice(-40), loose };
}

/** While the agent works, the first open item is the running one. */
export function markCurrent(t: StepTrack, at: number): StepTrack {
  if (t.source !== 'chat' || t.steps.some(s => s.status === 'in_progress')) return t;
  const i = t.steps.findIndex(s => s.status === 'pending');
  if (i < 0) return t;
  const steps = t.steps.slice();
  steps[i] = move(steps[i]!, 'in_progress', at);
  return { ...t, steps };
}

/** A reply reaches the transcript after the next tool call has started, so that call lands on
 *  the step that just finished. Move calls that started after a step ended to the running step. */
export function rehome(t: StepTrack): StepTrack {
  if (t.source !== 'chat') return t;
  const cur = t.steps.findIndex(s => s.status === 'in_progress');
  if (cur < 0) return t;
  const moved = t.steps.flatMap((s, i) => (i !== cur && s.status === 'completed' && s.endedAt !== undefined)
    ? s.tools.filter(c => c.at > s.endedAt!) : []);
  if (!moved.length) return t;
  const steps = t.steps.map((s, i) => {
    if (i === cur) {
      const tools = [...moved, ...s.tools].sort((a, b) => a.at - b.at).slice(-25);
      return { ...s, tools, startedAt: Math.min(s.startedAt ?? Infinity, tools[0]!.at) };
    }
    return s.status === 'completed' && s.endedAt !== undefined ? { ...s, tools: s.tools.filter(c => c.at <= s.endedAt!) } : s;
  });
  return { ...t, steps };
}

// ---------- reading the transcript ----------

export interface TranscriptText { text: string; at: number }

/** Assistant text blocks from JSONL lines. Bad lines are skipped. */
export function assistantTexts(lines: string[]): TranscriptText[] {
  const out: TranscriptText[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }
    if (o?.type !== 'assistant' || o.isSidechain) continue;
    const at = Date.parse(o.timestamp) || Date.now();
    for (const c of o.message?.content ?? []) if (c?.type === 'text' && typeof c.text === 'string') out.push({ text: c.text, at });
  }
  return out;
}

const MAX_READ = 4 * 1024 * 1024;

/** New complete lines after `offset`. A half-written last line waits for the next call. */
export function readNewLines(path: string, offset: number): { lines: string[]; offset: number } {
  let size: number;
  try { size = statSync(path).size; } catch { return { lines: [], offset }; }
  if (size < offset) offset = 0; // the file was replaced
  if (size === offset) return { lines: [], offset };
  const start = Math.max(offset, size - MAX_READ);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const s = buf.toString('utf8');
  const end = s.lastIndexOf('\n');
  if (end < 0) return { lines: [], offset };
  const lines = s.slice(0, end).split('\n');
  if (start > offset) lines.shift(); // the first line was cut by the size cap
  return { lines, offset: start + Buffer.byteLength(s.slice(0, end + 1)) };
}
