import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';

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
export function withUserBins(path: string, o: { home?: string; exists?: (p: string) => boolean; platform?: NodeJS.Platform } = {}): string {
  const home = o.home ?? homedir();
  const exists = o.exists ?? existsSync;
  const parts = path.split(':').filter(Boolean);
  const add = ['.local/bin', '.bun/bin', '.claude/local'].map(d => join(home, d))
    .filter(d => !parts.includes(d) && exists(d));
  // macOS: a Dock or Finder launch gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, so Homebrew tmux is not found.
  // Add the package folders at the end, so the order of the user's own PATH stays first.
  const sys = (o.platform ?? process.platform) === 'darwin'
    ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'].filter(d => !parts.includes(d) && exists(d))
    : [];
  return [...add, ...parts, ...sys].join(':');
}

/** Join two PATH values. Keep the order of `a`. Then add the entries of `b` that are not in `a`. */
export function mergePath(a: string | undefined, b: string | null | undefined): string {
  const out: string[] = [];
  for (const d of [...(a ?? '').split(':'), ...(b ?? '').split(':')]) if (d && !out.includes(d)) out.push(d);
  return out.join(':');
}

const PATH_START = '__AC_PATH_START__';
const PATH_END = '__AC_PATH_END__';

async function runShell(cmd: string[], timeoutMs: number): Promise<{ out: string; code: number }> {
  // detached: its own process group, so an interactive shell cannot take the terminal of the console.
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL', detached: true });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out, code };
}

/**
 * The PATH of the user's login shell, or null. A process that starts from a desktop launcher or
 * the Dock does not read the shell profile. Then its PATH has no nvm, fnm, volta, asdf or npm-prefix
 * folder, and `claude` is not found. The markers remove the text that rc files can print.
 */
export async function loginShellPath(o: {
  shell?: string; run?: (cmd: string[]) => Promise<{ out: string; code: number }>; timeoutMs?: number;
  /** stdin is a terminal. Default: process.stdin.isTTY. */
  tty?: boolean;
} = {}): Promise<string | null> {
  // From a terminal the PATH is already the one of the shell. An interactive login shell in the same
  // terminal can also take the foreground process group, and a kill at the timeout leaves it broken.
  if (o.tty ?? !!process.stdin.isTTY) return null;
  const timeoutMs = o.timeoutMs ?? 3000;
  const shell = o.shell ?? (process.env.SHELL || '/bin/sh');
  // fish keeps PATH as a list. "$PATH" would join it with spaces, so join it with ':'.
  const print = basename(shell) === 'fish'
    ? `printf '%s' ${PATH_START}(string join : $PATH)${PATH_END}`
    // The braces are needed: without them the shell reads "$PATH__AC_PATH_END__" as one variable name.
    : `printf '%s' "${PATH_START}\${PATH}${PATH_END}"`;
  const cmd = [shell, '-lic', print];
  const run = o.run ?? (c => runShell(c, timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(r => { timer = setTimeout(() => r(null), timeoutMs); });
  try {
    const r = await Promise.race([run(cmd), late]);
    // An rc file with an error can make the exit code non-zero. The markers show that the PATH came out.
    if (!r) return null;
    const i = r.out.indexOf(PATH_START);
    const j = r.out.indexOf(PATH_END, i + PATH_START.length);
    if (i < 0 || j < 0) return null;
    return r.out.slice(i + PATH_START.length, j) || null;
  } catch {
    return null;
  } finally { clearTimeout(timer); }
}

/** The PATH that the server uses: its own PATH, then the new entries of the login shell PATH, with the user bins in front. */
export async function serverPath(path = process.env.PATH, login: Promise<string | null> = loginShellPath()): Promise<string> {
  return withUserBins(mergePath(path, await login));
}

/** The System Settings path that gives an app access to a protected folder on macOS. */
export const MAC_ACCESS_HINT = 'Give Agent Console access in System Settings → Privacy & Security → Files and Folders (or Full Disk Access)';

/**
 * Why a working folder cannot be used, or null when it can. macOS privacy (TCC) protects Desktop,
 * Documents and Downloads. A process from an app or a launchd agent then gets EPERM, and Claude exits at once.
 */
export function folderProblem(dir: string, readDir: (p: string) => unknown, platform: NodeJS.Platform = process.platform): string | null {
  try { readDir(dir); return null; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES')
      return platform === 'darwin' ? `macOS blocks access to ${dir}. ${MAC_ACCESS_HINT}, then restart the session.` : `No permission to read ${dir}.`;
    if (code === 'ENOENT') return `${dir} does not exist.`;
    return null; // Another error: let the agent start and show its own message.
  }
}
