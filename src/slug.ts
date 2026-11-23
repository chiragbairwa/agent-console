import type { Worker } from './types';

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'worker';
}

export function uniqueId(name: string, taken: string[]): string {
  const base = slugify(name);
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve "@Web App", "web-app", "webapp" or a unique prefix to one worker. */
export function resolveName(q: string, workers: Worker[]): Worker | undefined {
  const raw = q.replace(/^@/, '').trim();
  const c = compact(raw);
  if (!c) return undefined;
  const exact = workers.find(w => w.id === raw.toLowerCase() || compact(w.name) === c || compact(w.id) === c);
  if (exact) return exact;
  const prefix = workers.filter(w => compact(w.name).startsWith(c) || compact(w.id).startsWith(c));
  return prefix.length === 1 ? prefix[0] : undefined;
}
