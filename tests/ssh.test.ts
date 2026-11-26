import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostLink } from '../src/ssh';
import { FakeRunner } from './fakes';
import type { Host } from '../src/types';

const mac: Host = { id: 'mac', name: 'Mac', ssh: 'macmini', roots: [] };
const mk = (f: FakeRunner, h: Host = mac) => new HostLink(h, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn: f.spawn });
const okProbe = (f: FakeRunner) => f.on(['ssh', '-S', '--'], { out: 'ok\n' });

test('masterArgs has ControlMaster, BatchMode, ExitOnForwardFailure and the reverse tunnel', () => {
  const a = mk(new FakeRunner()).masterArgs();
  expect(a).toEqual(expect.arrayContaining(['-M', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-R', '127.0.0.1:7878:127.0.0.1:7878', 'macmini']));
  expect(a[a.length - 1]).toBe('macmini');
  expect(a).toContain('/tmp/ac-ssh-test/mac.sock');
});
test('tunnelPort comes from the profile when set', () => {
  const l = mk(new FakeRunner(), { ...mac, tunnelPort: 17878 });
  expect(l.tunnelPort()).toBe(17878);
  expect(l.masterArgs()).toEqual(expect.arrayContaining(['-R', '127.0.0.1:17878:127.0.0.1:7878']));
});
test('port, identityFile and jump map to -p, -i, -J', () => {
  const a = mk(new FakeRunner(), { ...mac, port: 2222, identityFile: '/k/id', jump: 'bastion' }).masterArgs();
  for (const [f, v] of [['-p', '2222'], ['-i', '/k/id'], ['-J', 'bastion']]) expect(a[a.indexOf(f) + 1]).toBe(v);
});
test('sshArgs quotes the remote command and adds -t on request', () => {
  const l = mk(new FakeRunner());
  expect(l.sshArgs(['echo', "a b'c"])).toEqual(['ssh', '-S', l.sock(), '-o', 'BatchMode=yes', 'macmini', '--', `'echo' 'a b'\\''c'`]);
  expect(l.sshArgs(['x'], true)).toContain('-t');
});
test('exec before connect throws "Mac is not connected"', async () => {
  await expect(mk(new FakeRunner()).exec(['ls'])).rejects.toThrow('Mac is not connected');
});
test('connect: master ok + echo probe ok → state up and latencyMs set', async () => {
  const f = new FakeRunner(); okProbe(f);
  let t = 100; const l = new HostLink(mac, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn: f.spawn, now: () => (t += 7) });
  await l.connect();
  expect(l.state).toBe('up');
  expect(l.latencyMs).toBe(7);
  // cmds[0] and [1] are the orphan check and its -O exit (the fake master always answers).
  expect(f.cmds[2]).toEqual(l.masterArgs());
  await l.exec(['ls'], 'in');
  expect(f.stdins.at(-1)).toBe('in');
});
test('connect: forward failure → error naming the port and "Tunnel port"', async () => {
  const f = new FakeRunner().on(['ssh', '-M'], { code: 255, err: 'Error: remote port forwarding failed for listen port 7878\n' });
  const l = mk(f); await l.connect();
  expect(l.state).toBe('error');
  expect(l.lastError).toContain('7878');
  expect(l.lastError).toContain('Tunnel port');
});
test('connect: "Permission denied" → ssh-agent or key file, no password', async () => {
  const f = new FakeRunner().on(['ssh', '-M'], { code: 255, err: 'macmini: Permission denied (publickey,password).\n' });
  const l = mk(f); await l.connect();
  expect(l.state).toBe('error');
  expect(l.lastError).toContain('ssh-agent or a key file');
  expect(l.lastError).toContain('does not use passwords');
});
test('other failure → last stderr line', async () => {
  const f = new FakeRunner().on(['ssh', '-M'], { code: 255, err: 'warn\nConnection refused\n' });
  const l = mk(f); await l.connect();
  expect(l.lastError).toBe('Connection refused');
});
test('state changes emit a state event; disconnect runs -O exit', async () => {
  const f = new FakeRunner(); okProbe(f);
  const l = mk(f); const seen: string[] = [];
  l.addEventListener('state', () => seen.push(l.state));
  await l.connect(); await l.disconnect();
  expect(seen).toEqual(['connecting', 'up', 'down']);
  expect(f.cmds.some(c => c.includes('-O') && c.includes('exit'))).toBe(true);
});
const exits = (f: FakeRunner) => f.cmds.filter(c => c.includes('-O') && c.includes('exit'));
test('ConnectTimeout is in masterArgs', () => {
  expect(mk(new FakeRunner()).masterArgs()).toEqual(expect.arrayContaining(['-o', 'ConnectTimeout=10']));
});
test('a spawner that never answers ends in error, not stuck', async () => {
  const l = new HostLink(mac, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn: () => new Promise(() => {}), timeoutMs: 20 });
  await l.connect();
  expect(l.state).toBe('error');
  expect(l.lastError).toBe('Mac did not answer in time');
});
test('-O check fails → master is stopped with -O exit', async () => {
  const f = new FakeRunner().on(['ssh', '-O', 'check'], { code: 255, err: 'no master' });
  const l = mk(f); await l.connect();
  expect(l.state).toBe('error');
  expect(exits(f).length).toBe(1);
});
test('probe fails → master is stopped with -O exit', async () => {
  const f = new FakeRunner().on(['ssh', '-S', '--'], { code: 1, err: 'boom' });
  const l = mk(f); await l.connect();
  expect(l.state).toBe('error');
  // Count from the new master on: the -O exit before it is for an orphan master.
  const mi = f.cmds.findIndex(c => c.includes('-M'));
  expect(f.cmds.slice(mi).filter(c => c.includes('-O') && c.includes('exit')).length).toBe(1);
});
test('connect while up does nothing', async () => {
  const f = new FakeRunner(); okProbe(f);
  const l = mk(f); await l.connect(); const n = f.cmds.length; await l.connect();
  expect(f.cmds.length).toBe(n);
});
test('exec passes a per-call timeout to the spawner', async () => {
  const seen: (number | undefined)[] = [];
  const l = new HostLink(mac, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn: async (_c, _s, t) => { seen.push(t); return { out: 'ok\n', err: '', code: 0 }; } });
  await l.connect();
  await l.exec(['x'], undefined, { timeoutMs: 123456 });
  expect(seen[seen.length - 1]).toBe(123456);
});

test('home() reads $HOME once and caches it', async () => {
  const f = new FakeRunner(); okProbe(f);
  const l = mk(f); await l.connect();
  (l as any).spawn = async (cmd: string[]) => { f.cmds.push(cmd); return { out: '/Users/me', err: '', code: 0 }; };
  const before = f.cmds.length;
  expect(await l.home()).toBe('/Users/me');
  expect(await l.home()).toBe('/Users/me');
  expect(f.cmds.length).toBe(before + 1);
  expect(f.cmds.at(-1)!.at(-1)).toContain('HOME');
});

/** A timer for the master watch that the test fires by hand. */
function fakeEvery() {
  const t = { fn: undefined as undefined | (() => void), ms: 0, stops: 0 };
  return { t, every: (fn: () => void, ms: number) => { t.fn = fn; t.ms = ms; return () => { t.stops++; t.fn = undefined; }; } };
}
/** A spawner whose answer to -O check the test can change. */
function switchable() {
  const s = { checkCode: 0, cmds: [] as string[][] };
  const spawn = async (cmd: string[]) => {
    s.cmds.push(cmd);
    if (cmd.includes('-O') && cmd.includes('check')) return { out: '', err: s.checkCode ? 'no master' : '', code: s.checkCode };
    if (cmd.includes('--')) return { out: 'ok\n', err: '', code: 0 };
    return { out: '', err: '', code: 0 };
  };
  return { s, spawn };
}
/** The probe answers ok. Every other remote command ends with code. */
const execCode = (code: number) => async (cmd: string[]) => {
  const last = cmd.at(-1) ?? '';
  if (last.includes("'echo'")) return { out: 'ok\n', err: '', code: 0 };
  if (cmd.includes('--')) return { out: '', err: 'Connection reset', code };
  return { out: '', err: '', code: 0 };
};
const flush = () => new Promise(r => setTimeout(r, 0));

describe('master watch', () => {
  test('an up link runs -O check every 15000 ms; a failed check → error "Mac lost the connection"', async () => {
    const { t, every } = fakeEvery(); const { s, spawn } = switchable();
    const l = new HostLink(mac, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn, every });
    await l.connect();
    expect(l.state).toBe('up');
    expect(t.ms).toBe(15000);
    const n = s.cmds.length;
    t.fn!(); await flush();
    expect(s.cmds.slice(n)).toEqual([['ssh', '-S', l.sock(), '-O', 'check', 'macmini']]);
    expect(l.state).toBe('up');
    s.checkCode = 255;
    t.fn!(); await flush();
    expect(l.state).toBe('error');
    expect(l.lastError).toBe('Mac lost the connection');
    expect(t.stops).toBe(1);
  });
  test('disconnect stops the watch', async () => {
    const { t, every } = fakeEvery(); const { spawn } = switchable();
    const l = new HostLink(mac, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn, every });
    await l.connect(); await l.disconnect();
    expect(t.stops).toBe(1);
    expect(t.fn).toBeUndefined();
  });
  test('an exec that ends with ssh code 255 → error "Mac lost the connection"; the result still returns', async () => {
    const { every } = fakeEvery();
    const l = new HostLink(mac, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn: execCode(255), every });
    await l.connect();
    expect(l.state).toBe('up');
    const r = await l.exec(['ls']);
    expect(r.code).toBe(255);
    expect(l.state).toBe('error');
    expect(l.lastError).toBe('Mac lost the connection');
  });
  test('an exec with another failure code keeps the link up', async () => {
    const l = new HostLink(mac, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn: execCode(2), every: fakeEvery().every });
    await l.connect(); await l.exec(['ls']);
    expect(l.state).toBe('up');
  });
});

describe('orphan master', () => {
  test('connect first runs -O check; a master that answers gets -O exit before the new master starts', async () => {
    const { s, spawn } = switchable();
    const l = new HostLink(mac, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn, every: fakeEvery().every });
    await l.connect();
    expect(s.cmds.slice(0, 3)).toEqual([
      ['ssh', '-S', l.sock(), '-O', 'check', 'macmini'],
      ['ssh', '-S', l.sock(), '-O', 'exit', 'macmini'],
      l.masterArgs(),
    ]);
    expect(l.state).toBe('up');
  });
  test('no master answers and a stale socket file exists → the file is removed, no -O exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ssh-orphan-'));
    const { s, spawn } = switchable(); s.checkCode = 255;
    const l = new HostLink(mac, { consolePort: 7878, sockDir: dir, spawn, every: fakeEvery().every });
    writeFileSync(l.sock(), '');
    let seenAtMaster: boolean | undefined;
    const spy = async (cmd: string[]) => { if (cmd.includes('-M')) seenAtMaster = existsSync(l.sock()); return spawn(cmd); };
    (l as any).spawn = spy;
    await l.connect();
    expect(seenAtMaster).toBe(false);
    expect(s.cmds[1]).toEqual(l.masterArgs());
  });
});

describe('disconnect during connect', () => {
  test('a disconnect while the master starts ends in down, not up, and stops the master', async () => {
    let l!: HostLink;
    const f = new FakeRunner(); okProbe(f);
    const spawn = async (cmd: string[]) => {
      const r = await f.spawn(cmd);
      if (cmd.includes('-M')) await l.disconnect();
      return r;
    };
    l = new HostLink(mac, { consolePort: 7878, sockDir: '/tmp/ac-ssh-test', spawn, every: fakeEvery().every });
    const seen: string[] = [];
    l.addEventListener('state', () => seen.push(l.state));
    await l.connect();
    expect(l.state).toBe('down');
    expect(seen).not.toContain('up');
    const mi = f.cmds.findIndex(c => c.includes('-M'));
    expect(f.cmds.slice(mi + 1).filter(c => c.includes('exit')).length).toBeGreaterThanOrEqual(1);
    expect(f.cmds.some(c => c.includes('echo'))).toBe(false);
  });
});
