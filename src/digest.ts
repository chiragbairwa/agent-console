import type { Registry } from './workers';
import type { Worker } from './types';

/** Every few minutes the console sends the advisor one status line for each worker.
 *  It sends nothing when nothing changed, so a quiet fleet costs no tokens. */

const fmtMin = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

export interface DigestLine { id: string; sig: string; text: string }

export function digestLines(reg: Registry, now: number): DigestLine[] {
  const needs = reg.needs();
  return reg.workers().filter((w: Worker) => w.role === 'worker' && w.kind !== 'shell').map(w => {
    const t = reg.stepsOf(w.id);
    const done = t.steps.filter(s => s.status === 'completed').length;
    const cur = t.steps.find(s => s.status === 'in_progress');
    const ask = needs.filter(n => n.id === w.id && n.kind !== 'waiting').map(n => n.text.slice(0, 80));
    const step = cur ? `step ${t.steps.indexOf(cur) + 1}/${t.steps.length} "${cur.text.slice(0, 70)}"${cur.startedAt ? ` for ${fmtMin(now - cur.startedAt)}` : ''}`
      : t.steps.length ? `${done}/${t.steps.length} steps done` : `task: ${w.task.slice(0, 70)}`;
    const text = `- ${w.name} (${w.repo}): ${w.status}; ${step}${ask.length ? `; WAITS ON YOU: ${ask.join(' | ')}` : ''}`;
    // The time in a step is left out of the signature: a step that only gets older is no change.
    const sig = [w.status, cur?.key ?? '', done, t.steps.length, ask.join('|')].join('·');
    return { id: w.id, sig, text };
  });
}

export const DIGEST_TAIL = '(Status check from the console. Act only when a worker is stuck on one step for a long time, waits on the user, or has finished: tell the user in one short line. Otherwise reply only "ok".)';

/** Holds the last signature, so an unchanged fleet sends nothing. */
export class Digest {
  private last = '';
  constructor(private reg: Registry, private now: () => number = Date.now) {}

  /** The message to send, or null when there is nothing new or the advisor cannot take it now. */
  build(): string | null {
    const adv = this.reg.get('advisor');
    if (!adv || adv.status === 'stopped' || this.reg.queuedFor('advisor') > 0) return null;
    const lines = digestLines(this.reg, this.now());
    if (!lines.length) return null;
    const sig = lines.map(l => `${l.id}:${l.sig}`).join('\n');
    if (sig === this.last) return null;
    this.last = sig;
    const t = new Date(this.now()).toTimeString().slice(0, 5);
    return `Status at ${t}: ${lines.map(l => l.text).join(' ')} ${DIGEST_TAIL}`;
  }

  async tick(): Promise<boolean> {
    const msg = this.build();
    if (!msg) return false;
    await this.reg.deliver('console', 'advisor', msg);
    this.reg.activity(`Sent the advisor a status check (${digestLines(this.reg, this.now()).length} workers).`);
    return true;
  }
}
