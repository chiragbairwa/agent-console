import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Git repositories one level under each root. */
export function listRepos(roots: string[]): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names.sort()) {
      const p = join(root, name);
      try { if (statSync(p).isDirectory() && existsSync(join(p, '.git'))) out.push({ name, path: p }); } catch { /* skip */ }
    }
  }
  return out;
}
