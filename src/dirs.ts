import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { desktopDir } from './paths';

export interface DirEntry { name: string; path: string; git: boolean }
export interface DirListing {
  path: string; parent: string | null; dirs: DirEntry[];
  places: { name: string; path: string }[]; error?: string;
}

const MAX = 500;

/** Windows drive letters that exist, for the "computer" level above C:\ . */
function drives(): string[] {
  return 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').map(d => `${d}:\\`).filter(d => { try { return existsSync(d); } catch { return false; } });
}

/** The sub-folders of one folder, for the folder chooser. Hidden folders are left out unless asked. */
export function listDirs(path: string | undefined, o: { hidden?: boolean; roots?: string[] } = {}): DirListing {
  const desk = desktopDir();
  const places = [{ name: 'Desktop', path: desk }, { name: 'Home', path: homedir() },
    ...(o.roots ?? []).filter(r => r !== desk).map(r => ({ name: r.split(/[\\/]/).filter(Boolean).pop() ?? r, path: r }))];
  if (process.platform === 'win32' && path === '') {
    return { path: '', parent: null, places, dirs: drives().map(d => ({ name: d, path: d, git: false })) };
  }
  const p = path && isAbsolute(path) ? resolve(path) : desk;
  const up = dirname(p);
  const parent = up !== p ? up : process.platform === 'win32' ? '' : null;
  let names: string[];
  try {
    names = readdirSync(p, { withFileTypes: true })
      .filter(d => d.isDirectory() || (d.isSymbolicLink() && existsSync(join(p, d.name))))
      .map(d => d.name)
      .filter(n => o.hidden || !n.startsWith('.'));
  } catch (e) {
    return { path: p, parent, places, dirs: [], error: (e as NodeJS.ErrnoException).code ?? 'cannot read this folder' };
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const dirs = names.slice(0, MAX).map(name => ({ name, path: join(p, name), git: existsSync(join(p, name, '.git')) }));
  return { path: p, parent, places, dirs };
}
