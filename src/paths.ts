import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export function configDir(): string {
  return process.env.AC_CONFIG_DIR || join(homedir(), '.config', 'agent-console');
}

export function sessionDir(id: string): string {
  return join(configDir(), 'sessions', id);
}

export const configPath = () => join(configDir(), 'config.json');
export const statePath = () => join(configDir(), 'state.json');
export const tokenPath = () => join(configDir(), 'token');

export interface DesktopEnv {
  platform?: NodeJS.Platform; home?: string; env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean; read?: (p: string) => string;
}

/** The user's Desktop folder on Windows, macOS and Linux. Falls back to the home folder.
 *  - Windows: OneDrive often moves the Desktop to `%OneDrive%\Desktop`.
 *  - Linux: `XDG_DESKTOP_DIR` in `~/.config/user-dirs.dirs` can rename it (for example "Escritorio"). */
export function desktopDir(o: DesktopEnv = {}): string {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const read = o.read ?? (p => readFileSync(p, 'utf8'));
  const p = platform === 'win32' ? win32 : posix;
  const candidates: string[] = [];
  if (platform === 'win32') {
    for (const od of [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial]) if (od) candidates.push(p.join(od, 'Desktop'));
    candidates.push(p.join(home, 'OneDrive', 'Desktop'));
  } else if (platform === 'linux') {
    try {
      const m = read(p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'user-dirs.dirs')).match(/^XDG_DESKTOP_DIR="([^"]+)"/m);
      if (m) candidates.push(m[1]!.replace(/^\$HOME/, home));
    } catch { /* no user-dirs file */ }
  }
  candidates.push(p.join(home, 'Desktop'));
  return candidates.find(c => exists(c)) ?? home;
}

/**
 * The PATH with the user's own bin folders in front. The desktop app starts the server from
 * the session manager at login, not from a shell, so the PATH has no `~/.local/bin`. Then tmux
 * cannot find `claude`, each new session exits at once, and the cards show "no sessions".
 */
export function withUserBins(path: string, o: { home?: string; exists?: (p: string) => boolean } = {}): string {
  const home = o.home ?? homedir();
  const exists = o.exists ?? existsSync;
  const parts = path.split(':').filter(Boolean);
  const add = ['.local/bin', '.bun/bin', '.claude/local'].map(d => join(home, d))
    .filter(d => !parts.includes(d) && exists(d));
  return [...add, ...parts].join(':');
}
