import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirs } from '../src/dirs';
import { desktopDir } from '../src/paths';
import { listBranches } from '../src/branches';

describe('desktopDir', () => {
  const has = (...ps: string[]) => (p: string) => ps.includes(p);

  test('Windows: the OneDrive Desktop wins when it exists', () => {
    expect(desktopDir({ platform: 'win32', home: 'C:\\Users\\ana', env: { OneDrive: 'C:\\Users\\ana\\OneDrive' },
      exists: has('C:\\Users\\ana\\OneDrive\\Desktop', 'C:\\Users\\ana\\Desktop') })).toBe('C:\\Users\\ana\\OneDrive\\Desktop');
  });

  test('Windows: no OneDrive → the home Desktop', () => {
    expect(desktopDir({ platform: 'win32', home: 'C:\\Users\\ana', env: {}, exists: has('C:\\Users\\ana\\Desktop') })).toBe('C:\\Users\\ana\\Desktop');
  });

  test('macOS: ~/Desktop', () => {
    expect(desktopDir({ platform: 'darwin', home: '/Users/ana', env: {}, exists: has('/Users/ana/Desktop') })).toBe('/Users/ana/Desktop');
  });

  test('Linux: a renamed Desktop from user-dirs.dirs', () => {
    const read = (p: string) => { if (p === '/home/ana/.config/user-dirs.dirs') return 'XDG_DESKTOP_DIR="$HOME/Escritorio"\n'; throw new Error('no'); };
    expect(desktopDir({ platform: 'linux', home: '/home/ana', env: {}, read, exists: has('/home/ana/Escritorio') })).toBe('/home/ana/Escritorio');
  });

  test('no Desktop at all → the home folder', () => {
    expect(desktopDir({ platform: 'linux', home: '/home/ana', env: {}, read: () => '', exists: () => false })).toBe('/home/ana');
  });
});

describe('listDirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-dirs-'));
  mkdirSync(join(root, 'beta', '.git'), { recursive: true });
  mkdirSync(join(root, 'Alpha'));
  mkdirSync(join(root, '.hidden'));
  writeFileSync(join(root, 'file.txt'), 'x');

  test('folders only, sorted, git marked, hidden left out', () => {
    const d = listDirs(root);
    expect(d.path).toBe(root);
    expect(d.dirs.map(x => [x.name, x.git])).toEqual([['Alpha', false], ['beta', true]]);
    expect(d.parent).toBe(tmpdir());
    expect(d.places[0]!.name).toBe('Desktop');
  });

  test('hidden folders on request', () => {
    expect(listDirs(root, { hidden: true }).dirs.map(x => x.name)).toContain('.hidden');
  });

  test('a folder that cannot be read gives an error, not a crash', () => {
    expect(listDirs(join(root, 'missing')).error).toBe('ENOENT');
  });

  test('no path or a relative path → the Desktop', () => {
    expect(listDirs(undefined).path).toBe(desktopDir());
    expect(listDirs('relative/x').path).toBe(desktopDir());
  });
});

describe('listBranches', () => {
  test('current branch first; not a repo gives an error', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ac-br-'));
    const git = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
    git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'a'); git('branch', 'dev'); git('switch', '-q', 'dev');
    const b = await listBranches(repo);
    expect(b.current).toBe('dev');
    expect(b.local[0]).toBe('dev');
    expect(b.local).toContain('main');
    expect((await listBranches(tmpdir())).error).toBeDefined();
  });
});
