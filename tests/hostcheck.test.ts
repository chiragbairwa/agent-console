import { expect, test } from 'bun:test';
import { HostLink, type ExecResult } from '../src/ssh';
import { checkHost, checkMark, checkClass } from '../src/hostcheck';
import { runHostDoctor } from '../src/doctor';
import type { Host } from '../src/types';

const host: Host = { id: 'mac', name: 'Mac', ssh: 'macmini', roots: ['/r'], tunnelPort: 17878 };

/** A spawner that answers by the remote command text (the last ssh argument). */
function link(answers: Record<string, Partial<ExecResult>>, h: Host = host) {
  const spawn = async (cmd: string[]): Promise<ExecResult> => {
    const remote = cmd[cmd.length - 1]!;
    for (const [k, v] of Object.entries(answers)) if (remote.includes(k)) return { out: '', err: '', code: 0, ...v };
    return { out: 'ok\n', err: '', code: 0 };
  };
  return new HostLink(h, { consolePort: 7878, sockDir: '/tmp/ac-hc-test', spawn });
}
const up = async (l: HostLink) => { await l.connect(); return l; };
const base = { "'uname'": { out: 'Linux\n' }, "'curl'": { out: '200' }, "'tmux'": { out: 'tmux 3.4\n' }, "'--version'": { out: '2.0\n' } };

test('checkHost: Linux host has no sleep check, ids in order', async () => {
  const c = await checkHost(await up(link(base)), 7878);
  expect(c.map(x => x.id)).toEqual(['ssh', 'os', 'tmux', 'claude', 'login', 'tunnel', 'roots']);
  expect(c.every(x => x.ok)).toBe(true);
});
test('checkHost: pmset "sleep 1" warns with the pmset command', async () => {
  const l = await up(link({ ...base, "'uname'": { out: 'Darwin\n' }, "'pmset'": { out: ' sleep                1\n displaysleep 10\n' } }));
  const s = (await checkHost(l, 7878)).find(x => x.id === 'sleep')!;
  expect(s.warn).toBe(true);
  expect(s.text).toContain('sudo pmset -a sleep 0');
});
test('checkHost: pmset "sleep 0" is fine', async () => {
  const l = await up(link({ ...base, "'uname'": { out: 'Darwin\n' }, "'pmset'": { out: ' sleep                0\n' } }));
  const s = (await checkHost(l, 7878)).find(x => x.id === 'sleep')!;
  expect(s).toMatchObject({ ok: true });
  expect(s.warn).toBeUndefined();
});
test('checkHost: no Claude login warns with CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const c = await checkHost(await up(link({ ...base, "'auth'": { code: 1 } })), 7878);
  const l = c.find(x => x.id === 'login')!;
  expect(l.warn).toBe(true);
  expect(l.text).toContain('CLAUDE_CODE_OAUTH_TOKEN');
});
test('checkHost: tunnel curl failure gives ok=false and uses the tunnel port', async () => {
  const l = await up(link({ ...base, "'curl'": { code: 7 } }));
  const t = (await checkHost(l, 7878)).find(x => x.id === 'tunnel')!;
  expect(t.ok).toBe(false);
  expect(t.text).toContain('17878');
});
test('checkHost: a missing root fails the roots check', async () => {
  const c = await checkHost(await up(link({ ...base, "'test'": { code: 1 } })), 7878);
  expect(c.find(x => x.id === 'roots')).toMatchObject({ ok: false });
});

test('runHostDoctor: unknown host exits 1', async () => {
  const lines: string[] = [];
  expect(await runHostDoctor(undefined, 'x', 7878, l => lines.push(l))).toBe(1);
  expect(lines[0]).toContain('unknown host x');
});
test('runHostDoctor: prints marks, exit 0 on warn only, 1 on failure', async () => {
  const lines: string[] = [];
  const ok = await up(link({ ...base, "'auth'": { code: 1 } }));
  await ok.disconnect();
  expect(await runHostDoctor(ok, 'mac', 7878, l => lines.push(l))).toBe(0);
  expect(lines.some(l => l.startsWith('! login'))).toBe(true);
  expect(lines.some(l => l.startsWith('✓ ssh'))).toBe(true);
  const bad = link({ ...base, "'curl'": { code: 7 } });
  const l2: string[] = [];
  expect(await runHostDoctor(bad, 'mac', 7878, l => l2.push(l))).toBe(1);
  expect(l2.some(l => l.startsWith('✗ tunnel'))).toBe(true);
});
test('checkMark', () => {
  expect([checkMark({ id: 'a', ok: true, text: '' }), checkMark({ id: 'a', ok: true, warn: true, text: '' }), checkMark({ id: 'a', ok: false, text: '' })]).toEqual(['✓', '!', '✗']);
});
test('checkHost: tmux or claude not found names the non-interactive SSH PATH and ~/.zshenv', async () => {
  const c = await checkHost(await up(link({ ...base, "'tmux'": { code: 127 }, "'--version'": { code: 127 } })), 7878);
  for (const id of ['tmux', 'claude']) {
    const x = c.find(y => y.id === id)!;
    expect(x.ok).toBe(false);
    expect(x.text).toContain(`${id} not found on the PATH of a non-interactive SSH login`);
    expect(x.text).toContain('export PATH=/opt/homebrew/bin:$PATH');
    expect(x.text).toContain('~/.zshenv');
  }
});
test('checkHost: a 401 or 403 from the console means the tunnel works (the health route needs the token)', async () => {
  for (const code of ['401', '403']) {
    const t = (await checkHost(await up(link({ ...base, "'curl'": { out: code } })), 7878)).find(x => x.id === 'tunnel')!;
    expect(t).toMatchObject({ ok: true });
  }
  const none = (await checkHost(await up(link({ ...base, "'curl'": { out: '000', code: 7 } })), 7878)).find(x => x.id === 'tunnel')!;
  expect(none.ok).toBe(false);
});
test('checkHost: claude not found gives no false "not logged in"; login is not checked', async () => {
  const c = await checkHost(await up(link({ ...base, "'--version'": { code: 127 }, "'auth'": { code: 127 } })), 7878);
  const l = c.find(x => x.id === 'login')!;
  expect(l).toMatchObject({ ok: true, warn: true });
  expect(l.text).not.toContain('not logged in');
  expect(l.text).toContain('claude not found');
});
test('checkHost: the PATH hint names ~/.local/bin of the native installer', async () => {
  const c = await checkHost(await up(link({ ...base, "'--version'": { code: 127 } })), 7878);
  expect(c.find(x => x.id === 'claude')!.text).toContain('$HOME/.local/bin');
});
test('checkClass: a warning is never painted as ok', () => {
  expect([checkClass({ id: 'a', ok: true, text: '' }), checkClass({ id: 'a', ok: true, warn: true, text: '' }), checkClass({ id: 'a', ok: false, text: '' })]).toEqual(['ok', 'wn', 'bad']);
});
