/** Steps of one session, built from its own checklist (TodoWrite / TaskCreate / TaskUpdate)
 *  and from the tool calls the hooks report. Pure functions: old track in, new track out. */

export type StepStatus = 'pending' | 'in_progress' | 'completed';

export interface ToolCall { at: number; tool: string; detail: string; end?: number }

export interface Step {
  key: string;            // TaskCreate id, or the TodoWrite content, or `p<n>` for a prompt step
  text: string;           // the checklist line
  active?: string;        // activeForm: "Running tests"
  note?: string;          // chat checklist: the result after "→"
  status: StepStatus;
  startedAt?: number; endedAt?: number;
  tools: ToolCall[];
}

export interface StepTrack {
  /** 'todo' = TodoWrite / Task tools; 'chat' = a Markdown checklist in the replies; 'prompt' = one step per prompt. */
  source: 'todo' | 'chat' | 'prompt';
  steps: Step[];
  /** Tool calls that came before any step existed. */
  loose: ToolCall[];
}

export const MAX_STEPS = 40;
export const MAX_TOOLS = 25;
const CHECKLIST_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

export const emptyTrack = (): StepTrack => ({ source: 'prompt', steps: [], loose: [] });

const clip = (s: unknown, n = 100) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const base = (p: unknown) => String(p ?? '').split('/').filter(Boolean).slice(-2).join('/');
const capTools = (t: ToolCall[]) => t.slice(-MAX_TOOLS);
const capSteps = (s: Step[]) => s.slice(-MAX_STEPS);
const asStatus = (s: unknown): StepStatus => (s === 'in_progress' || s === 'completed' ? s : 'pending');

/** One short line that says what a tool call does. */
export function toolDetail(tool: string, input: any): string {
  const i = input ?? {};
  switch (tool) {
    case 'Bash': return clip(i.description ? `${i.command} — ${i.description}` : i.command);
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return base(i.file_path ?? i.notebook_path);
    case 'Grep': return clip(`${i.pattern ?? ''}${i.path ? ` in ${base(i.path)}` : ''}`);
    case 'Glob': return clip(i.pattern);
    case 'Agent': case 'Task': return clip(i.description ?? i.prompt);
    case 'WebFetch': return clip(i.url);
    case 'WebSearch': return clip(i.query);
    case 'Skill': return clip(i.skill);
    default: {
      const first = Object.values(i).find(v => typeof v === 'string');
      return clip(first ?? '');
    }
  }
}

/** Move a step to a new status and keep its start and end times true. */
function setStatus(s: Step, next: StepStatus, now: number): Step {
  if (s.status === next) return s;
  const out = { ...s, status: next };
  if (next === 'in_progress') { out.startedAt ??= now; delete out.endedAt; }
  if (next === 'completed') { out.startedAt ??= now; out.endedAt = now; }
  if (next === 'pending') { delete out.startedAt; delete out.endedAt; }
  return out;
}

/** The first checklist replaces the prompt steps; later lists keep the times of matching items. */
function fromPrompt(t: StepTrack): StepTrack {
  return t.source === 'todo' ? t : { source: 'todo', steps: [], loose: t.loose };
}

/** TodoWrite sends the whole list each time. */
export function applyTodoWrite(t: StepTrack, todos: unknown, now: number): StepTrack {
  if (!Array.isArray(todos)) return t;
  const cur = fromPrompt(t);
  const old = new Map(cur.steps.map(s => [s.key, s]));
  const steps = todos.map((x: any): Step => {
    const key = clip(x?.content, 200);
    const prev = old.get(key) ?? { key, text: key, status: 'pending' as StepStatus, tools: [] };
    return { ...setStatus(prev, asStatus(x?.status), now), text: key, active: clip(x?.activeForm) || undefined };
  });
  return { ...cur, steps: capSteps(steps) };
}

/** Task ids are in the response text: "Task #3 created successfully: …". */
export function taskIdFrom(response: unknown): string | undefined {
  const s = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return s.match(/Task #(\w+) created/)?.[1] ?? s.match(/"id"\s*:\s*"?(\w+)/)?.[1];
}

export function applyTaskCreate(t: StepTrack, input: any, response: unknown): StepTrack {
  const cur = fromPrompt(t);
  const key = taskIdFrom(response) ?? String(cur.steps.length + 1);
  const step: Step = { key, text: clip(input?.subject, 200), active: clip(input?.activeForm) || undefined, status: 'pending', tools: [] };
  return { ...cur, steps: capSteps([...cur.steps.filter(s => s.key !== key), step]) };
}

export function applyTaskUpdate(t: StepTrack, input: any, now: number): StepTrack {
  const key = String(input?.taskId ?? '');
  if (!t.steps.some(s => s.key === key)) return t;
  if (input?.status === 'deleted') return { ...t, steps: t.steps.filter(s => s.key !== key) };
  return {
    ...t,
    steps: t.steps.map(s => {
      if (s.key !== key) return s;
      let n = input?.status ? setStatus(s, asStatus(input.status), now) : s;
      if (input?.subject) n = { ...n, text: clip(input.subject, 200) };
      if (input?.activeForm) n = { ...n, active: clip(input.activeForm) };
      return n;
    }),
  };
}

/** No checklist: each prompt is one step, the one before it is done. */
export function applyPrompt(t: StepTrack, prompt: unknown, now: number): StepTrack {
  if (t.source !== 'prompt') return t;
  const steps = t.steps.map(s => setStatus(s, 'completed', s.endedAt ?? now));
  const text = clip(String(prompt ?? '').split('\n')[0], 120) || 'Prompt';
  steps.push({ key: `p${now}`, text, status: 'in_progress', startedAt: now, tools: [] });
  return { ...t, steps: capSteps(steps) };
}

/** The agent stopped: a prompt step is done; a checklist keeps its own state. */
export function applyStop(t: StepTrack, now: number): StepTrack {
  const tracks = closeTools(t, now);
  if (tracks.source !== 'prompt') return tracks;
  return { ...tracks, steps: tracks.steps.map(s => setStatus(s, 'completed', now)) };
}

/** The step that owns new tool calls: the running one, else the last one that started. */
function ownerIndex(t: StepTrack): number {
  const run = t.steps.findIndex(s => s.status === 'in_progress');
  if (run >= 0) return run;
  for (let i = t.steps.length - 1; i >= 0; i--) if (t.steps[i]!.startedAt !== undefined) return i;
  return -1;
}

export function toolStart(t: StepTrack, tool: string, input: unknown, now: number): StepTrack {
  if (CHECKLIST_TOOLS.has(tool)) return t;
  const call: ToolCall = { at: now, tool, detail: toolDetail(tool, input) };
  const i = ownerIndex(t);
  if (i < 0) return { ...t, loose: capTools([...t.loose, call]) };
  const steps = t.steps.slice();
  steps[i] = { ...steps[i]!, tools: capTools([...steps[i]!.tools, call]) };
  return { ...t, steps };
}

/** Close the newest open call of this tool (or any open call when the tool is unknown). */
export function toolEnd(t: StepTrack, tool: string | undefined, now: number): StepTrack {
  const close = (list: ToolCall[]) => {
    for (let k = list.length - 1; k >= 0; k--) {
      const c = list[k]!;
      if (c.end === undefined && (!tool || c.tool === tool)) { const n = list.slice(); n[k] = { ...c, end: now }; return n; }
    }
    return list;
  };
  return { ...t, loose: close(t.loose), steps: t.steps.map(s => (s.tools.some(c => c.end === undefined) ? { ...s, tools: close(s.tools) } : s)) };
}

function closeTools(t: StepTrack, now: number): StepTrack {
  const all = (l: ToolCall[]) => l.map(c => (c.end === undefined ? { ...c, end: now } : c));
  return { ...t, loose: all(t.loose), steps: t.steps.map(s => ({ ...s, tools: all(s.tools) })) };
}
