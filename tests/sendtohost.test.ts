import { beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/workers';
import { HostPool, TmuxPool } from '../src/hostpool';
import { loadConfig } from '../src/store';
import { sendToHost, sendPreview, defaultRun } from '../src/sendtohost';
import { FakeTmux } from './fakes';

let tmux: FakeTmux;
let remote: { cmd: string; stdin?: string }[];
let answers: ((c: string) => { out?: string; err?: string; code?: number } | undefined)[];
let hosts: HostPool;
let src: string;

const git = (cwd: string, ...a: string[]) => {
  const p = Bun.spawnSync(['git', '-c', 'user.email=a@b.c', '-c', 'user.name=T', ...a], { cwd });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
};

function mkSource() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-send-')));
  const repo = join(root, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'checkout', '-qb', 'feat/x');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'second');
  return repo;
}

async function mkReg(up = true) {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-send-cfg-'));
  tmux = new FakeTmux(); remote = []; answers = [];
  const spawn = async (cmd: string[], stdin?: string) => {
    const last = cmd.at(-1) ?? '';
    if (cmd[0] !== 'ssh') return { out: '', err: '', code: 0 };
    if (last.includes('HOME')) return { out: '/Users/me', err: '', code: 0 };
    if (last.includes("'echo'")) return { out: 'ok\n', err: '', code: 0 };
    remote.push({ cmd: last, stdin });
    for (const a of answers) { const r = a(last); if (r) return { out: '', err: '', code: 0, ...r }; }
    if (last.includes("'find'")) return { out: '/Users/me/code/app/.git\n', err: '', code: 0 };
    return { out: '', err: '', code: 0 };
  };
  hosts = new HostPool([{ id: 'mac', name: 'Mac', ssh: 'macmini', roots: ['/Users/me/code'], tunnelPort: 17878 }], { consolePort: 7878, sockDir: '/tmp/ac-send-ssh', spawn });
  if (up) await hosts.link('mac').connect();
  const reg = new Registry(new TmuxPool(tmux.asTmux(), hosts), loadConfig(), {
    bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', exec: async () => {}, hosts,
  });
  src = mkSource();
  const w = await reg.spawn({ name: 'Src', repo: src });
  w.branch = 'feat/x';
  return { reg, w };
}

const base = { to: 'mac', branch: true, patch: false, stopSource: false };

beforeEach(() => { remote = []; });

test('check fails when the target is not up: only the check step runs', async () => {
  const { reg, w } = await mkReg(false);
  const r = await sendToHost(reg, hosts, { ...base, id: w.id });
  expect(r.steps.map(s => [s.name, s.ok])).toEqual([['check', false]]);
  expect(remote).toHaveLength(0);
});

test('check fails when the repo folder is not under a target root', async () => {
  const { reg, w } = await mkReg();
  answers.push(c => c.includes("'find'") ? { out: '' } : undefined);
  const r = await sendToHost(reg, hosts, { ...base, id: w.id });
  expect(r.steps).toEqual([{ name: 'check', ok: false, text: 'app is not on Mac' }]);
});

test('check fails for a remote source worker', async () => {
  const { reg, w } = await mkReg();
  w.host = 'mac';
  const r = await sendToHost(reg, hosts, { ...base, id: w.id });
  expect(r.steps[0]).toEqual({ name: 'check', ok: false, text: 'Send to Host works from a worker on this computer for now' });
});

test('bundle: git bundle create runs locally, then git fetch on the host, then rm', async () => {
  const { reg, w } = await mkReg();
  const run: { cmd: string[] }[] = [];
  const r = await sendToHost(reg, hosts, { ...base, id: w.id }, { run: async (cmd, cwd, o) => { run.push({ cmd }); return realRun(cmd, cwd, o); } });
  const bundle = r.steps.find(s => s.name === 'bundle')!;
  expect(bundle.ok).toBe(true);
  expect(run.some(x => x.cmd.slice(0, 3).join(' ') === 'git bundle create')).toBe(true);
  const write = remote.find(x => x.cmd.includes('openssl'))!;
  expect(write.cmd).toMatch(/\/tmp\/ac-src-[a-z0-9]+\.bundle/);
  expect(Buffer.from(write.stdin!, 'base64').toString('latin1')).toStartWith('# v2 git bundle');
  const fetchI = remote.findIndex(x => x.cmd.includes("'fetch'"));
  expect(remote[fetchI]!.cmd).toContain("'-C' '/Users/me/code/app'");
  expect(remote[fetchI]!.cmd).toContain("'feat/x:feat/x'");
  expect(remote[fetchI + 1]!.cmd).toContain("'rm' '-f'");
});

test('a failed fetch stops the move; the source is not stopped; Activity names bundle', async () => {
  const { reg, w } = await mkReg();
  answers.push(c => c.includes("'fetch'") ? { code: 1, err: 'no room' } : undefined);
  const r = await sendToHost(reg, hosts, { ...base, id: w.id, stopSource: true });
  expect(r.steps.at(-1)).toMatchObject({ name: 'bundle', ok: false });
  expect(r.steps.map(s => s.name)).toEqual(['check', 'bundle']);
  expect(reg.get(w.id)!.status).not.toBe('stopped');
  expect(reg.snapshot().state.activity.some(a => a.text.startsWith('Send to Mac: bundle failed: '))).toBe(true);
  expect(remote.some(x => x.cmd.includes("'rm' '-f'"))).toBe(true);
});

test('the new worker checks out the existing branch and starts on the host', async () => {
  const { reg, w } = await mkReg();
  const r = await sendToHost(reg, hosts, { ...base, id: w.id });
  expect(r.worker!.host).toBe('mac');
  expect(r.worker!.name).toBe('Src-mac');
  expect(remote.some(x => x.cmd.includes("'worktree' 'add' '--'") && x.cmd.includes("'feat/x'"))).toBe(true);
  expect(remote.some(x => x.cmd.includes("'worktree' 'add' '-b'"))).toBe(false);
});

test('patch is applied with git apply on the new worktree', async () => {
  const { reg, w } = await mkReg();
  writeFileSync(join(src, 'a.txt'), 'changed\n');
  const r = await sendToHost(reg, hosts, { ...base, id: w.id, patch: true });
  expect(r.steps.find(s => s.name === 'patch')!.ok).toBe(true);
  const ap = remote.find(x => x.cmd.includes("'apply'"))!;
  expect(ap.cmd).toContain("'-C' '/Users/me/code/worktrees/app-feat-x'");
  expect(ap.stdin).toContain('+changed');
});

test('an empty patch is skipped as ok with "no changes"', async () => {
  const { reg, w } = await mkReg();
  const r = await sendToHost(reg, hosts, { ...base, id: w.id, patch: true });
  expect(r.steps.find(s => s.name === 'patch')).toEqual({ name: 'patch', ok: true, text: 'no changes' });
  expect(remote.some(x => x.cmd.includes("'apply'"))).toBe(false);
});

test('stopSource=false keeps the source running; true stops it after all steps are ok', async () => {
  const a = await mkReg();
  await sendToHost(a.reg, hosts, { ...base, id: a.w.id });
  expect(a.reg.get(a.w.id)!.status).not.toBe('stopped');
  const b = await mkReg();
  const r = await sendToHost(b.reg, hosts, { ...base, id: b.w.id, stopSource: true });
  expect(r.steps.at(-1)).toMatchObject({ name: 'stop', ok: true });
  expect(b.reg.get(b.w.id)!.status).toBe('stopped');
});

test('the brief becomes the first prompt of the new worker', async () => {
  const { reg, w } = await mkReg();
  await sendToHost(reg, hosts, { ...base, id: w.id, brief: 'Finish the login form' });
  const c = remote.find(x => x.cmd.includes('new-session'))!.cmd;
  expect(c).toContain('Finish the login form');
});

const stubRsync = (log: string[][]) => async (cmd: string[], cwd: string, o?: { binary?: boolean }) => {
  if (cmd[0] === 'rsync') { log.push(cmd); return { out: '', bytes: new Uint8Array(), err: '', code: 0 }; }
  return realRun(cmd, cwd, o);
};
const folderStep = (r: { steps: { name: string }[] }) => r.steps.find(s => s.name === 'folder') as any;

test('folder: rsync gets -s, a fixed -e string with a quoted sock, and an unquoted dest', async () => {
  const { reg, w } = await mkReg();
  const folder = mkdtempSync(join(realpathSync(homedir()), 'ac-send-'));
  try {
    const log: string[][] = [];
    const r = await sendToHost(reg, hosts, { ...base, id: w.id, folder }, { run: stubRsync(log) });
    expect(folderStep(r).ok).toBe(true);
    const name = folder.split('/').at(-1);
    expect(log[0]!.slice(0, 5)).toEqual(['rsync', '-az', '-s', '-e', `ssh -S '/tmp/ac-send-ssh/mac.sock' -o BatchMode=yes`]);
    expect(log[0]!.at(-1)).toBe(`macmini:/Users/me/${name}/`);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('folder: the home folder, a hidden home folder and an outside folder are refused', async () => {
  for (const f of [homedir(), join(homedir(), '.ssh'), '/etc']) {
    const { reg, w } = await mkReg();
    const log: string[][] = [];
    const r = await sendToHost(reg, hosts, { ...base, id: w.id, folder: f }, { run: stubRsync(log) });
    expect(folderStep(r).ok).toBe(false);
    expect(log).toHaveLength(0);
    expect(r.worker).toBeUndefined();
  }
});

test('folder: a relative folder resolves against the cwd of the worker', async () => {
  const { reg, w } = await mkReg();
  mkdirSync(join(src, 'assets'));
  const log: string[][] = [];
  const r = await sendToHost(reg, hosts, { ...base, id: w.id, folder: 'assets' }, { run: stubRsync(log) });
  expect(folderStep(r).ok).toBe(true);
  expect(log[0]![log[0]!.length - 2]).toBe(`${join(src, 'assets')}/`);
});

test('patch: apply runs before new-session; a failed apply starts no worker and keeps the source', async () => {
  const a = await mkReg();
  writeFileSync(join(src, 'a.txt'), 'changed\n');
  await sendToHost(a.reg, hosts, { ...base, id: a.w.id, patch: true });
  const iApply = remote.findIndex(x => x.cmd.includes("'apply'"));
  const iStart = remote.findIndex(x => x.cmd.includes('new-session'));
  expect(iApply).toBeGreaterThan(-1);
  expect(iApply).toBeLessThan(iStart);

  const b = await mkReg();
  writeFileSync(join(src, 'a.txt'), 'changed\n');
  answers.push(c => c.includes("'apply'") ? { code: 1, err: 'does not apply' } : undefined);
  const r = await sendToHost(b.reg, hosts, { ...base, id: b.w.id, patch: true, stopSource: true });
  const p = r.steps.find(s => s.name === 'patch')!;
  expect(p.ok).toBe(false);
  expect(p.text).toContain('patch failed: does not apply (worktree at /Users/me/code/worktrees/app-feat-x)');
  expect(r.steps.some(s => s.name === 'start' || s.name === 'stop')).toBe(false);
  expect(r.worker).toBeUndefined();
  expect(remote.some(x => x.cmd.includes('new-session'))).toBe(false);
  expect(b.reg.get(b.w.id)!.status).not.toBe('stopped');
});

test('check fails when branch=true and the worker has no branch', async () => {
  const { reg, w } = await mkReg();
  git(src, 'checkout', '-q', '--detach');
  w.branch = undefined;
  const r = await sendToHost(reg, hosts, { ...base, id: w.id });
  expect(r.steps).toEqual([{ name: 'check', ok: false, text: 'Src has no branch to send' }]);
});

test('a failed bundle write still runs rm -f', async () => {
  const { reg, w } = await mkReg();
  answers.push(c => c.includes('openssl') ? { code: 1, err: 'no openssl' } : undefined);
  const r = await sendToHost(reg, hosts, { ...base, id: w.id });
  expect(r.steps.at(-1)).toMatchObject({ name: 'bundle', ok: false });
  expect(remote.some(x => x.cmd.includes("'rm' '-f'"))).toBe(true);
});

test('sendPreview counts ahead commits and dirty lines', async () => {
  const { reg, w } = await mkReg();
  git(src, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(src, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  writeFileSync(join(src, 'a.txt'), 'one\ntwo\nthree\n');
  const p = await sendPreview(reg, hosts, w.id, 'mac');
  expect(p.ahead).toBe(1);
  expect(p.dirtyFiles).toBe(1);
  expect(p.dirtyLines).toBe(2);
  expect(p.repoFound).toBe(true);
  expect(Array.isArray(p.checks)).toBe(true);
});

const realRun = defaultRun;

test('folder: a folder inside the worker folder is allowed even when the worker folder is under a hidden home folder', async () => {
  const { reg, w } = await mkReg();
  const hidden = mkdtempSync(join(realpathSync(homedir()), '.ac-send-hidden-'));
  try {
    mkdirSync(join(hidden, 'assets'));
    w.cwd = hidden;
    const log: string[][] = [];
    const r = await sendToHost(reg, hosts, { ...base, branch: false, id: w.id, folder: 'assets' }, { run: stubRsync(log) });
    expect(folderStep(r).ok).toBe(true);
    expect(log).toHaveLength(1);
  } finally { rmSync(hidden, { recursive: true, force: true }); }
});

test('folder: a hidden home folder outside the worker folder is still refused', async () => {
  const { reg, w } = await mkReg();
  const hidden = mkdtempSync(join(realpathSync(homedir()), '.ac-send-hidden-'));
  try {
    const log: string[][] = [];
    const r = await sendToHost(reg, hosts, { ...base, branch: false, id: w.id, folder: hidden }, { run: stubRsync(log) });
    expect(folderStep(r).ok).toBe(false);
    expect(log).toHaveLength(0);
  } finally { rmSync(hidden, { recursive: true, force: true }); }
});
