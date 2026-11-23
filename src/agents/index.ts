import type { Worker } from '../types';
import type { AgentAdapter } from './types';
import { claude } from './claude';
import { codex } from './codex';

/** The adapters by id. */
export const ADAPTERS: Record<string, AgentAdapter> = { claude, codex };

/** Check the agent id and the options of a new worker. A missing agent means claude. */
export function validateAgent(agent: string | undefined, options: unknown): { agent?: string; options: Record<string, string> } {
  if (agent !== undefined && !Object.hasOwn(ADAPTERS, agent))
    throw new Error(`unknown agent: ${agent} (known: ${Object.keys(ADAPTERS).join(', ')})`);
  if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options)))
    throw new Error('bad option options: must be an object');
  const fields = ADAPTERS[agent ?? 'claude']!.options;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((options ?? {}) as Record<string, unknown>)) {
    const f = fields.find(x => x.key === k);
    if (!f || typeof v !== 'string' || (f.kind === 'select' && !f.choices?.includes(v)))
      throw new Error(`bad option ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    out[k] = v;
  }
  return { agent, options: out };
}

/** Find the adapter of a worker. A missing agent means claude. */
export function adapterOf(w: Pick<Worker, 'agent'>): AgentAdapter {
  const id = w.agent ?? 'claude';
  const a = ADAPTERS[id];
  if (!a) throw new Error(`unknown agent: ${id}`);
  return a;
}
