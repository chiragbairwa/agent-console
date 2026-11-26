import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withUserBins } from '../src/paths';

describe('withUserBins', () => {
  const home = '/home/u';
  const all = () => true;

  test('adds the user bin folders a login shell has, when the PATH has none (desktop launch)', () => {
    const out = withUserBins('/usr/bin:/bin', { home, exists: all });
    expect(out.split(':')).toEqual(['/home/u/.local/bin', '/home/u/.bun/bin', '/home/u/.claude/local', '/usr/bin', '/bin']);
  });

  test('keeps the PATH as it is when the folders are already in it', () => {
    const p = '/home/u/.local/bin:/home/u/.bun/bin:/home/u/.claude/local:/usr/bin';
    expect(withUserBins(p, { home, exists: all })).toBe(p);
  });

  test('skips folders that do not exist', () => {
    const out = withUserBins('/usr/bin', { home, exists: d => d.endsWith('.local/bin') });
    expect(out).toBe('/home/u/.local/bin:/usr/bin');
  });

  // A Dock or Finder launch on macOS gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, so Homebrew tmux is not found.
  test('macOS: adds the Homebrew and /usr/local bin folders at the end', () => {
    const out = withUserBins('/usr/bin:/bin', { home, exists: all, platform: 'darwin' });
    expect(out.split(':')).toEqual(['/home/u/.local/bin', '/home/u/.bun/bin', '/home/u/.claude/local', '/usr/bin', '/bin',
      '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']);
  });

  test('macOS: does not add a system folder that is already in the PATH or missing', () => {
    const out = withUserBins('/opt/homebrew/bin:/usr/bin', { home, exists: d => d !== '/usr/local/bin' && !d.startsWith(home), platform: 'darwin' });
    expect(out).toBe('/opt/homebrew/bin:/usr/bin:/opt/homebrew/sbin');
  });

  test('Linux: adds no Homebrew folders', () => {
    expect(withUserBins('/usr/bin', { home, exists: d => !d.startsWith(home), platform: 'linux' })).toBe('/usr/bin');
  });
});

describe('loginShellPath', () => {
  const { loginShellPath, mergePath } = require('../src/paths') as typeof import('../src/paths');

  test('runs the login shell and takes the text between the markers (rc files can print noise)', async () => {
    let cmd: string[] = [];
    const run = async (c: string[]) => { cmd = c; return { out: 'Welcome!\nnvm ok\n__AC_PATH_START__/n/bin:/usr/bin__AC_PATH_END__bye\n', code: 0 }; };
    expect(await loginShellPath({ tty: false, shell: '/bin/zsh', run })).toBe('/n/bin:/usr/bin');
    expect(cmd).toEqual(['/bin/zsh', '-lic', `printf '%s' "__AC_PATH_START__\${PATH}__AC_PATH_END__"`]);
  });

  test('no markers or a failed shell gives null', async () => {
    expect(await loginShellPath({ tty: false, shell: '/bin/sh', run: async () => ({ out: 'nothing', code: 0 }) })).toBeNull();
    expect(await loginShellPath({ tty: false, shell: '/bin/sh', run: async () => ({ out: '', code: 1 }) })).toBeNull();
    expect(await loginShellPath({ tty: false, shell: '/bin/sh', run: async () => { throw new Error('no shell'); } })).toBeNull();
  });

  test('a shell that does not answer in time gives null', async () => {
    const run = () => new Promise<{ out: string; code: number }>(() => {});
    const t0 = Date.now();
    expect(await loginShellPath({ tty: false, shell: '/bin/sh', run, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('a real shell that hangs is killed at the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sh-'));
    const sh = join(dir, 'slowsh');
    writeFileSync(sh, '#!/bin/sh\nexec sleep 30\n'); chmodSync(sh, 0o755);
    const t0 = Date.now();
    expect(await loginShellPath({ tty: false, shell: sh, timeoutMs: 200 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('mergePath keeps the order of the first PATH, then adds the new entries of the second', () => {
    expect(mergePath('/usr/bin:/bin', '/n/bin:/usr/bin:/v/bin:/n/bin')).toBe('/usr/bin:/bin:/n/bin:/v/bin');
    expect(mergePath('/usr/bin', null)).toBe('/usr/bin');
    expect(mergePath(undefined, '/a::/b')).toBe('/a:/b');
  });
});

test('serverPath adds the login shell entries after the own PATH', async () => {
  const { serverPath } = require('../src/paths') as typeof import('../src/paths');
  const out = (await serverPath('/usr/bin:/bin', Promise.resolve('/nvm/bin:/usr/bin'))).split(':');
  expect(out.slice(-3)).toEqual(['/usr/bin', '/bin', '/nvm/bin']);
});

describe('loginShellPath review fixes', () => {
  const { loginShellPath } = require('../src/paths') as typeof import('../src/paths');

  test('the probe is skipped when stdin is a terminal (the login shell could take the foreground)', async () => {
    let ran = false;
    const run = async () => { ran = true; return { out: '__AC_PATH_START__/x__AC_PATH_END__', code: 0 }; };
    expect(await loginShellPath({ shell: '/bin/zsh', run, tty: true })).toBeNull();
    expect(ran).toBe(false);
    expect(await loginShellPath({ shell: '/bin/zsh', run, tty: false })).toBe('/x');
  });

  test('a POSIX shell keeps the braces (else $PATH__AC… is one variable name); fish joins its PATH list with ":"', async () => {
    const cmds: string[][] = [];
    const run = async (c: string[]) => { cmds.push(c); return { out: '__AC_PATH_START__/x__AC_PATH_END__', code: 0 }; };
    await loginShellPath({ shell: '/bin/bash', run, tty: false });
    await loginShellPath({ shell: '/usr/local/bin/fish', run, tty: false });
    expect(cmds[0]).toEqual(['/bin/bash', '-lic', `printf '%s' "__AC_PATH_START__\${PATH}__AC_PATH_END__"`]);
    expect(cmds[1]).toEqual(['/usr/local/bin/fish', '-lic', `printf '%s' __AC_PATH_START__(string join : $PATH)__AC_PATH_END__`]);
  });
});
