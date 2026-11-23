import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Open the console as an app window: a Chromium browser with `--app=<url>` shows the page in
 * its own window with no tabs and no address bar. When that browser already runs, the window
 * shares its processes, so it costs about the same memory as a tab. No Chromium found: a tab.
 */
export interface OpenEnv {
  platform?: NodeJS.Platform;
  which?: (cmd: string) => string | null;
  exists?: (p: string) => boolean;
  isWsl?: boolean;
}

const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
const MAC_BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser'];

export function inWsl(): boolean {
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

/** The command that opens `url` as an app window, or as a plain tab when no Chromium is found. */
export function appCommand(url: string, e: OpenEnv = {}): { cmd: string[]; app: boolean } {
  const platform = e.platform ?? process.platform;
  const which = e.which ?? (c => Bun.which(c));
  const exists = e.exists ?? existsSync;
  const flag = `--app=${url}`;
  if (platform === 'win32') return { cmd: ['cmd', '/c', 'start', '""', 'msedge', flag], app: true };
  if (platform === 'darwin') {
    const app = MAC_BROWSERS.find(a => exists(`/Applications/${a}.app`));
    return app ? { cmd: ['open', '-na', app, '--args', flag], app: true } : { cmd: ['open', url], app: false };
  }
  // In WSL the browser is on the Windows side; Edge is part of Windows 10 and 11.
  if (e.isWsl ?? inWsl()) return { cmd: ['cmd.exe', '/c', 'start', '""', 'msedge', flag], app: true };
  for (const b of LINUX_BROWSERS) { const p = which(b); if (p) return { cmd: [p, flag], app: true }; }
  return { cmd: ['xdg-open', url], app: false };
}

/** The installed desktop app (Electrobun installer path on Linux), or null. AGENT_CONSOLE_DESKTOP overrides. */
export function desktopLauncher(e: { home?: string; exists?: (p: string) => boolean; env?: Record<string, string | undefined> } = {}): string | null {
  const home = e.home ?? homedir();
  const exists = e.exists ?? existsSync;
  const env = e.env ?? process.env;
  const found = [env.AGENT_CONSOLE_DESKTOP, join(home, '.local', 'share', 'dev.agentconsole.desktop', 'stable', 'app', 'bin', 'launcher')]
    .find((p): p is string => !!p && exists(p));
  return found ?? null;
}

/** How to show the console: the desktop app when it is installed, else a browser app window or tab. */
export function uiCommand(url: string, o: { browser?: boolean } & OpenEnv & Parameters<typeof desktopLauncher>[0] = {}):
  { cmd: string[]; kind: 'desktop' | 'app' | 'tab' } {
  const desk = o.browser ? null : desktopLauncher(o);
  if (desk) return { cmd: [desk], kind: 'desktop' };
  const a = appCommand(url, o);
  return { cmd: a.cmd, kind: a.app ? 'app' : 'tab' };
}

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#3b6ef5"/>
<rect x="10" y="14" width="20" height="14" rx="3" fill="#fff"/>
<rect x="34" y="36" width="20" height="14" rx="3" fill="#fff"/>
<path d="M30 21h6a4 4 0 0 1 4 4v11" stroke="#fff" stroke-width="3" fill="none"/>
<circle cx="20" cy="43" r="6" fill="#ffd166"/>
</svg>`;

export const MANIFEST = {
  name: 'Agent Console', short_name: 'Agent Console', start_url: '/app', display: 'standalone',
  background_color: '#0b0e13', theme_color: '#3b6ef5',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
};

/** Linux app-menu entry. `exec` is the console binary; clicking it runs `agent-console open`. */
export function installLauncher(exec: string, home = homedir()): string {
  const icons = join(home, '.local', 'share', 'icons');
  const apps = join(home, '.local', 'share', 'applications');
  mkdirSync(icons, { recursive: true }); mkdirSync(apps, { recursive: true });
  const icon = join(icons, 'agent-console.svg');
  writeFileSync(icon, ICON_SVG);
  const file = join(apps, 'agent-console.desktop');
  writeFileSync(file, ['[Desktop Entry]', 'Type=Application', 'Name=Agent Console',
    'Comment=Canvas for Claude Code sessions', `Exec="${exec}" open`, `Icon=${icon}`,
    'Terminal=false', 'Categories=Development;', 'StartupWMClass=agent-console', ''].join('\n'));
  return file;
}
