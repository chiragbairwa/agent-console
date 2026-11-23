import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appCommand, desktopLauncher, installLauncher, MANIFEST, uiCommand } from '../src/appwindow';

const U = 'http://127.0.0.1:7878/?token=t';

describe('appCommand: an app window per OS', () => {
  test('Linux: the first Chromium browser found, with --app', () => {
    const which = (c: string) => (c === 'chromium' ? '/usr/bin/chromium' : null);
    expect(appCommand(U, { platform: 'linux', which, isWsl: false })).toEqual({ cmd: ['/usr/bin/chromium', `--app=${U}`], app: true });
  });

  test('Linux: Chrome wins over Chromium', () => {
    const which = (c: string) => (c === 'google-chrome' || c === 'chromium' ? `/usr/bin/${c}` : null);
    expect(appCommand(U, { platform: 'linux', which, isWsl: false }).cmd[0]).toBe('/usr/bin/google-chrome');
  });

  test('Linux with no Chromium: a plain tab', () => {
    expect(appCommand(U, { platform: 'linux', which: () => null, isWsl: false })).toEqual({ cmd: ['xdg-open', U], app: false });
  });

  test('WSL: Edge on the Windows side', () => {
    expect(appCommand(U, { platform: 'linux', isWsl: true }).cmd).toEqual(['cmd.exe', '/c', 'start', '""', 'msedge', `--app=${U}`]);
  });

  test('macOS: open -na with the installed browser', () => {
    const exists = (p: string) => p === '/Applications/Microsoft Edge.app';
    expect(appCommand(U, { platform: 'darwin', exists }).cmd).toEqual(['open', '-na', 'Microsoft Edge', '--args', `--app=${U}`]);
    expect(appCommand(U, { platform: 'darwin', exists: () => false })).toEqual({ cmd: ['open', U], app: false });
  });

  test('Windows: Edge', () => {
    expect(appCommand(U, { platform: 'win32' }).cmd).toEqual(['cmd', '/c', 'start', '""', 'msedge', `--app=${U}`]);
  });
});

describe('launcher and manifest', () => {
  test('the Linux launcher runs "open" on the binary and has an icon', () => {
    const home = mkdtempSync(join(tmpdir(), 'ac-home-'));
    const file = installLauncher('/home/x/.local/bin/agent-console', home);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Exec="/home/x/.local/bin/agent-console" open');
    expect(text).toContain(`Icon=${join(home, '.local', 'share', 'icons', 'agent-console.svg')}`);
    expect(readFileSync(join(home, '.local', 'share', 'icons', 'agent-console.svg'), 'utf8')).toStartWith('<svg');
  });

  test('the manifest opens /app as a standalone window', () => {
    expect(MANIFEST).toMatchObject({ name: 'Agent Console', start_url: '/app', display: 'standalone' });
  });
});

describe('uiCommand: the desktop app first', () => {
  const L = '/h/.local/share/dev.agentconsole.desktop/stable/app/bin/launcher';
  const linux = { platform: 'linux' as const, which: (c: string) => (c === 'google-chrome' ? '/usr/bin/google-chrome' : null), isWsl: false, home: '/h', env: {} };

  test('installed desktop app → it opens, not the browser', () => {
    expect(uiCommand(U, { ...linux, exists: p => p === L })).toEqual({ cmd: [L], kind: 'desktop' });
  });

  test('--browser, or no desktop app → the browser app window', () => {
    expect(uiCommand(U, { ...linux, exists: p => p === L, browser: true })).toEqual({ cmd: ['/usr/bin/google-chrome', `--app=${U}`], kind: 'app' });
    expect(uiCommand(U, { ...linux, exists: () => false }).kind).toBe('app');
  });

  test('AGENT_CONSOLE_DESKTOP points at another install', () => {
    expect(desktopLauncher({ home: '/h', env: { AGENT_CONSOLE_DESKTOP: '/opt/ac/launcher' }, exists: p => p === '/opt/ac/launcher' })).toBe('/opt/ac/launcher');
  });
});
