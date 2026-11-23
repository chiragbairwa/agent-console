import { ADAPTERS } from './agents';
import type { Config } from './types';
import type { Registry } from './workers';

/** The advisor rules. The agent ids come from the adapters. */
export const advisorPrompt = (agentIds: string[]): string => `You are the ADVISOR in Agent Console. Rules:
- The user talks only to you. Other agent sessions ("workers") run in their own repos.
- Route work to workers with the agent-console tools: list_workers, read_worker, send_to_worker, spawn_worker, stop_worker, interrupt_worker.
- spawn_worker takes an optional agent (${agentIds.join(', ')}); list_workers shows the agent of each worker.
- Do not edit code yourself unless the user asks you to.
- Report status in short lines: worker, state, what it does, what it waits on.
- You must never approve guarded actions (git push, deploys, pipeline runs, gate approvals). The user approves them in the console.
- Connect two workers (connect) only when they must share results. A link the user cut stays cut.
- Some workers are "linked": Claude sessions that run in the user's own terminal tabs (kind "linked" in list_workers). read_worker shows their latest messages. To message one, use your built-in SendMessage tool with its session name. send_to_worker cannot type into them.
- When you are not sure what the user wants, use ask_user.
- Say in plain words which worker you picked and why.`;

/** The rules, built one time at module load. */
export const ADVISOR_PROMPT = advisorPrompt(Object.keys(ADAPTERS));

/** Start (or restart) the advisor, and link it to every worker whose link the user did not cut. */
export async function ensureAdvisor(reg: Registry, cfg: Config): Promise<void> {
  const adv = reg.get('advisor');
  let agent = cfg.advisorAgent;
  // The config can name an unknown agent, or one that cannot be the advisor. Then use the first one that can.
  if (agent !== undefined && !adv && !(Object.hasOwn(ADAPTERS, agent) && ADAPTERS[agent]!.caps.advisor)) {
    const first = Object.values(ADAPTERS).find(a => a.caps.advisor);
    if (!first) throw new Error('no agent can be the advisor');
    reg.activity(`advisorAgent "${agent}" cannot be the advisor; using ${first.label}`);
    agent = first.id;
  }
  if (!adv) await reg.spawn({ name: 'Advisor', repo: cfg.advisorCwd, role: 'advisor', agent });
  else if (adv.status === 'stopped') await reg.restart('advisor', true);
  for (const w of reg.workers()) if (w.role === 'worker' && !reg.linked('advisor', w.id)) reg.connect('advisor', w.id, 'advisor');
}
