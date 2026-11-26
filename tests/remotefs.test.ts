import { expect, test } from 'bun:test';
import { HostLink } from '../src/ssh';
import { writeRemoteFile } from '../src/remotefs';
import { FakeRunner } from './fakes';

test('writeRemoteFile sends the body on stdin with umask 077 and a quoted path', async () => {
  const f = new FakeRunner().on(['ssh', '-S', '--'], { out: 'ok\n' });
  const l = new HostLink({ id: 'mac', name: 'Mac', ssh: 'macmini', roots: [] }, { consolePort: 7878, sockDir: '/tmp/ac-rfs', spawn: f.spawn });
  await l.connect();
  await writeRemoteFile(l, "/h/a b/it's/x.json", '{"a":1}');
  const cmd = f.cmds.at(-1)!.at(-1)!;
  expect(cmd).toContain('umask 077; mkdir -p "$(dirname "$1")" && cat > "$1" && chmod 600 "$1"');
  expect(cmd).toContain(`'/h/a b/it'\\''s/x.json'`);
  expect(f.stdins.at(-1)).toBe('{"a":1}');
});
test('writeRemoteFile throws when the remote command fails', async () => {
  const f = new FakeRunner().on(['ssh', '-S', '--'], { out: 'ok\n' });
  const l = new HostLink({ id: 'mac', name: 'Mac', ssh: 'macmini', roots: [] }, { consolePort: 7878, sockDir: '/tmp/ac-rfs', spawn: f.spawn });
  await l.connect();
  f.cmds.length = 0;
  (l as any).spawn = async () => ({ out: '', err: 'disk full', code: 1 });
  await expect(writeRemoteFile(l, '/x', 'b')).rejects.toThrow('disk full');
});

import { addRemoteWorktree, listRemoteBranches, listRemoteDirs, listRemoteRepos } from '../src/remotefs';

/** A link whose remote commands are answered by `answer`. The answer gets the quoted remote command. */
async function mkLink(answer: (remote: string) => { out?: string; code?: number; err?: string }, roots: string[] = []) {
  const cmds: string[] = [];
  let ready = false;
  const spawn = async (cmd: string[]) => {
    const last = cmd.at(-1) ?? '';
    if (cmd[0] !== 'ssh') return { out: '', err: '', code: 0 };
    if (last.includes('HOME')) return { out: '/Users/me', err: '', code: 0 };
    if (!ready) return { out: 'ok\n', err: '', code: 0 };
    cmds.push(last);
    const a = answer(last);
    return { out: a.out ?? '', err: a.err ?? '', code: a.code ?? 0 };
  };
  const l = new HostLink({ id: 'mac', name: 'Mac', ssh: 'macmini', roots }, { consolePort: 7878, sockDir: '/tmp/ac-rfs2', spawn });
  await l.connect();
  ready = true;
  return { l, cmds };
}

test('listRemoteRepos finds child folders with .git in each root, expands ~/, sorts by name', async () => {
  const { l, cmds } = await mkLink(c => c.includes("'/Users/me/code'")
    ? { out: '/Users/me/code/zed/.git\n/Users/me/code/app/.git\n' } : { code: 1, err: 'No such file' });
  const repos = await listRemoteRepos(l, ['~/code', '/missing']);
  expect(repos).toEqual([{ name: 'app', path: '/Users/me/code/app' }, { name: 'zed', path: '/Users/me/code/zed' }]);
  expect(cmds[0]).toBe(`'find' '/Users/me/code' '-mindepth' '2' '-maxdepth' '2' '-name' '.git'`);
});

test('listRemoteDirs lists only folders, hides dotfolders, marks git folders, gives parent and places', async () => {
  const { l, cmds } = await mkLink(c => c.includes("'ls'")
    ? { out: './\n../\n.hid/\nb/\nA/\nfile.txt\nlink@\n' }
    : { out: '/Users/me/code/b/.git\n' }, ['/srv/w']);
  const d = await listRemoteDirs(l, '/Users/me/code');
  expect(d.path).toBe('/Users/me/code');
  expect(d.parent).toBe('/Users/me');
  expect(d.dirs).toEqual([{ name: 'A', path: '/Users/me/code/A', git: false }, { name: 'b', path: '/Users/me/code/b', git: true }]);
  expect(d.places).toEqual([{ name: 'Home', path: '/Users/me' }, { name: 'w', path: '/srv/w' }]);
  expect(cmds[0]).toBe(`'ls' '-1pa' '--' '/Users/me/code'`);
  const h = await listRemoteDirs(l, '/Users/me/code', { hidden: true });
  expect(h.dirs.map(x => x.name)).toContain('.hid');
});

test('listRemoteDirs reports an error and no dirs when ls fails; the root has no parent', async () => {
  const { l } = await mkLink(() => ({ code: 2, err: 'ls: cannot access' }));
  const d = await listRemoteDirs(l, '/');
  expect(d.parent).toBeNull();
  expect(d.dirs).toEqual([]);
  expect(d.error).toBeTruthy();
});

test('listRemoteBranches mirrors the local shape and a path with a space and $(x) stays one argument', async () => {
  const { l, cmds } = await mkLink(c => c.includes('--show-current') ? { out: 'dev\n' }
    : c.includes('refs/heads') ? { out: 'main\ndev\n' } : { out: 'origin/HEAD\norigin/main\n' });
  const b = await listRemoteBranches(l, '/r/my repo $(x)');
  expect(b).toEqual({ current: 'dev', local: ['dev', 'main'], remote: ['origin/main'] });
  expect(cmds[0]).toContain(`'git' '-C' '/r/my repo $(x)'`);
});

test('listRemoteBranches reports an error when git fails', async () => {
  const { l } = await mkLink(() => ({ code: 128, err: 'fatal' }));
  const b = await listRemoteBranches(l, '/nope');
  expect(b.error).toBe('not a git repository');
});

test('addRemoteWorktree puts -- before the path and refuses a relative repo', async () => {
  const { l, cmds } = await mkLink(() => ({ out: '' }));
  const wt = await addRemoteWorktree(l, '/r/app', 'fix/x', 'origin/main', s => s.replace('/', '-'));
  expect(wt).toBe('/r/worktrees/app-fix-x');
  expect(cmds[0]).toBe(`'git' '-C' '/r/app' 'worktree' 'add' '-b' 'fix/x' '--' '/r/worktrees/app-fix-x' 'origin/main'`);
  await expect(addRemoteWorktree(l, 'rel/app', 'x', undefined, s => s)).rejects.toThrow('absolute');
});

test('addRemoteWorktree with existing=true checks out the branch without -b', async () => {
  const { l, cmds } = await mkLink(() => ({ out: '' }));
  const wt = await addRemoteWorktree(l, '/r/app', 'fix/x', undefined, s => s.replace('/', '-'), true);
  expect(wt).toBe('/r/worktrees/app-fix-x');
  expect(cmds[0]).toBe(`'git' '-C' '/r/app' 'worktree' 'add' '--' '/r/worktrees/app-fix-x' 'fix/x'`);
  await expect(addRemoteWorktree(l, '/r/app', '-x', undefined, s => s, true)).rejects.toThrow('bad branch name');
});
