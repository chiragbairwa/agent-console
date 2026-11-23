import { existsSync } from 'node:fs';
import { ADAPTERS, validateAgent } from './agents';
import { listRepos } from './repos';
import { lastMessages, transcriptPath } from './external';
import { resolveName } from './slug';
import type { Tmux } from './tmux';
import type { Worker } from './types';
import { sessionName, type Registry } from './workers';

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

export const ADVISOR_TOOLS = ['list_workers', 'read_worker', 'send_to_worker', 'spawn_worker', 'stop_worker',
  'interrupt_worker', 'connect', 'disconnect', 'ask_user'] as const;
export const WORKER_TOOLS = ['send_message', 'list_connections'] as const;

const ASK_USER_MS = 30 * 60 * 1000;
const ok = (result: unknown): ToolResult => ({ ok: true, result });
const err = (error: string): ToolResult => ({ ok: false, error });

function connectionsOf(reg: Registry, id: string) {
  return reg.links().filter(l => l.a === id || l.b === id).map(l => reg.nameOf(l.a === id ? l.b : l.a));
}

export async function handleTool(
  reg: Registry, tmux: Tmux, body: { caller: string; tool: string; args?: any },
): Promise<ToolResult> {
  const caller = reg.get(body.caller);
  if (!caller) return err(`unknown caller ${body.caller}`);
  const a = body.args ?? {};
  const isAdvisorTool = (ADVISOR_TOOLS as readonly string[]).includes(body.tool);
  if (isAdvisorTool && caller.role !== 'advisor') return err(`${body.tool} is for the advisor only`);
  const find = (q: unknown): Worker | undefined => resolveName(String(q ?? ''), reg.workers());

  try {
    switch (body.tool) {
      case 'list_workers':
        return ok(reg.workers().filter(w => w.role === 'worker').map(w => ({
          id: w.id, name: w.name, kind: w.kind ?? 'tmux', agent: w.agent ?? 'claude', repo: w.repo, cwd: w.cwd, branch: w.branch, status: w.status, task: w.task,
          connections: connectionsOf(reg, w.id),
          needs: reg.needs().filter(n => n.id === w.id).map(n => `${n.kind}: ${n.text}`),
        })));
      case 'read_worker': {
        const w = find(a.id); if (!w) return err(`no worker ${a.id}`);
        if (w.kind === 'linked') {
          const msgs = lastMessages(transcriptPath(w.cwd, w.sessionId ?? ''), 12);
          return ok(msgs.map(m => `${m.role === 'user' ? 'USER' : 'CLAUDE'}: ${m.text.slice(0, 600)}`).join('\n\n') || '(no transcript yet)');
        }
        return ok(await tmux.capture(sessionName(w.id), { lines: Math.min(Number(a.lines) || 80, 500) }));
      }
      case 'send_to_worker': {
        const w = find(a.id); if (!w) return err(`no worker ${a.id}`);
        if (w.kind === 'linked')
          return err(`${w.name} is a linked session outside the console. Use your SendMessage tool with to: "${w.name}" to message it.`);
        if (!reg.linked('advisor', w.id) && !reg.connect('advisor', w.id, 'advisor'))
          return err(`The link to ${w.name} was cut by the user. Ask the user with ask_user.`);
        const r = await reg.deliver('advisor', w.id, String(a.text ?? ''));
        reg.activity(`Advisor → ${w.name}: ${String(a.text ?? '').slice(0, 80)}${r === 'queued' ? ' (queued)' : ''}`);
        return ok(r);
      }
      case 'spawn_worker': {
        const byName = listRepos(reg.config().roots).find(r => r.name.toLowerCase() === String(a.repo).toLowerCase());
        const repo = byName?.path ?? String(a.repo ?? '');
        if (!existsSync(repo)) return err(`repo not found: ${a.repo}`);
        const v = validateAgent(a.agent === undefined ? reg.config().defaultWorkerAgent : String(a.agent), a.options);
        const w = await reg.spawn({
          agent: v.agent, options: v.options,
          name: String(a.name || byName?.name || 'Worker'), repo,
          worktree: a.worktree_branch ? { branch: String(a.worktree_branch), base: a.worktree_base ? String(a.worktree_base) : undefined } : undefined, template: a.template,
        });
        return ok({ id: w.id, name: w.name, cwd: w.cwd });
      }
      case 'stop_worker': { const w = find(a.id); if (!w) return err(`no worker ${a.id}`); await reg.stop(w.id); return ok('stopped'); }
      case 'interrupt_worker': { const w = find(a.id); if (!w) return err(`no worker ${a.id}`); await reg.interrupt(w.id); return ok('interrupted'); }
      case 'connect': {
        const x = find(a.a), y = find(a.b); if (!x || !y) return err('unknown worker');
        return reg.connect(x.id, y.id, 'advisor') ? ok('connected') : err(`${x.name} ↔ ${y.name} was cut by the user`);
      }
      case 'disconnect': {
        const x = find(a.a), y = find(a.b); if (!x || !y) return err('unknown worker');
        reg.disconnect(x.id, y.id); return ok('disconnected');
      }
      case 'ask_user': {
        const n = reg.addNeed({ id: caller.id, kind: 'question', text: String(a.question ?? '') });
        const r = await reg.waitNeed(n.nid, ASK_USER_MS);
        return ok(r.decision === 'answer' ? r.text ?? '' : r.decision === 'timeout' ? '(no answer)' : `(${r.decision})`);
      }
      case 'send_message': {
        const to = find(a.to); if (!to) return err(`no worker ${a.to}`);
        if (!reg.linked(caller.id, to.id)) return err(`You are not connected to ${to.name}; ask the advisor to connect you.`);
        const r = await reg.deliver(caller.id, to.id, String(a.text ?? ''));
        reg.activity(`${caller.name} → ${to.name}: ${String(a.text ?? '').slice(0, 80)}`);
        return ok(r);
      }
      case 'list_connections':
        return ok(connectionsOf(reg, caller.id));
      default:
        return err(`unknown tool ${body.tool}`);
    }
  } catch (e) {
    return err((e as Error).message);
  }
}
