import { isGuarded } from './guard';
import * as St from './steps';
import { applyChat, markCurrent, rehome } from './chatlist';
import { adapterOf } from './agents';
import type { AgentAdapter } from './agents/types';
import type { Registry } from './workers';
import type { Config } from './types';

/** How far each worker's transcript is read, so each hook call reads only the new lines. */
const readTo = new Map<string, { path: string; offset: number }>();

/** Merge the Markdown checklist lines of new replies into the steps. */
function syncChat(reg: Registry, ad: AgentAdapter, id: string, path: unknown, working: boolean) {
  if (typeof path !== 'string' || !path || !ad.chat) return;
  const was = readTo.get(id);
  const r = ad.chat(path, was?.path === path ? was.offset : 0);
  readTo.set(id, { path, offset: r.offset });
  for (const t of r.texts) reg.steps(id, s => applyChat(s, t.text, t.at));
  if (working) reg.steps(id, s => markCurrent(s, Date.now()));
  reg.steps(id, rehome);
}

const clip = (s: string, n = 80) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export async function handleHook(
  reg: Registry, cfg: Config, body: { event: string; id: string; payload: any },
): Promise<{ output?: object }> {
  const w = reg.get(body.id);
  if (!w) return {};
  let ad: AgentAdapter;
  try { ad = adapterOf(w); } catch { return {}; }
  const ev = ad.hook(body.event, body.payload ?? {});
  if (!ev) return {};
  /** Apply the agent checklist tools to the steps, when the adapter has them. */
  const checklist = (now: number) => { if (ad.checklist) reg.steps(w.id, t => ad.checklist!(ev, t, now)); };
  switch (ev.t) {
    case 'start':
      reg.update(w.id, { sessionId: ev.sessionId, status: 'idle', task: 'Ready' });
      return {};
    case 'prompt':
      reg.setStatus(w.id, 'running', clip(String(ev.text ?? '')));
      reg.steps(w.id, t => St.applyPrompt(t, ev.text, Date.now()));
      return {};
    case 'toolStart': {
      const tool = ev.tool;
      const cmd = ev.shell ?? '';
      reg.toolStart(w.id);
      syncChat(reg, ad, w.id, ev.transcript, true);
      const now = Date.now();
      checklist(now);
      reg.steps(w.id, t => St.toolStart(t, tool, ev.input, now));
      if (cmd && isGuarded(cmd, cfg.guardPatterns)) {
        const need = reg.addNeed({ id: w.id, kind: 'guard', text: `Allow: ${cmd}` });
        reg.setStatus(w.id, 'needs-you', `Waiting for you: ${clip(cmd)}`);
        reg.activity(`${w.name} asks: ${clip(cmd, 120)}`);
        const r = await reg.waitNeed(need.nid, cfg.hookTimeoutSec * 1000);
        reg.setStatus(w.id, 'running', `Bash: ${clip(cmd)}`);
        if (r.decision === 'allow') { reg.activity(`You allowed ${w.name}: ${clip(cmd, 120)}`); return { output: ad.guardReply('allow') }; }
        if (r.decision === 'deny') { reg.activity(`You denied ${w.name}: ${clip(cmd, 120)}`); return { output: ad.guardReply('deny', 'Denied in Agent Console') }; }
        return { output: ad.guardReply('ask', 'No answer in Agent Console') };
      }
      reg.setStatus(w.id, 'running', cmd ? `Bash: ${clip(cmd)}` : tool);
      return {};
    }
    case 'toolEnd':
      if (w.status === 'needs-you') { reg.clearNeeds(w.id, ['permission']); reg.setStatus(w.id, 'running'); }
      reg.toolEnd(w.id);
      checklist(Date.now());
      reg.steps(w.id, t => St.toolEnd(t, ev.tool || undefined, Date.now()));
      syncChat(reg, ad, w.id, ev.transcript, true);
      return {};
    case 'notice': {
      const msg = ev.text;
      reg.clearNeeds(w.id, ['permission', 'waiting']);
      if (ev.permission) {
        reg.addNeed({ id: w.id, kind: 'permission', text: msg || 'Permission prompt' });
        reg.setStatus(w.id, 'needs-you');
      } else {
        reg.addNeed({ id: w.id, kind: 'waiting', text: msg || 'Waiting for input' });
        reg.setStatus(w.id, 'waiting');
        // Only the plain idle prompt is safe to type into; other notices may be a dialog (review I2).
        if (ev.idle) void reg.flushQueue(w.id);
      }
      return {};
    }
    case 'stop':
      reg.toolEnd(w.id);
      syncChat(reg, ad, w.id, ev.transcript, false);
      reg.steps(w.id, t => St.applyStop(t, Date.now()));
      reg.clearNeeds(w.id, ['permission', 'waiting']);
      reg.setStatus(w.id, 'done');
      return {};
    case 'end':
      reg.clearNeeds(w.id, ['permission', 'waiting']);
      reg.setStatus(w.id, 'stopped', 'Session ended');
      return {};
  }
}
