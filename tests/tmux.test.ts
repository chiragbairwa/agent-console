import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tmux, remoteTmux, settleMs, stillInInput } from '../src/tmux';
import { HostLink } from '../src/ssh';
import { FakeRunner } from './fakes';

const hasTmux = !!Bun.which('tmux');
const socket = `ac-test-${Math.random().toString(36).slice(2, 8)}`;
const tmux = new Tmux(socket);
const cwd = mkdtempSync(join(tmpdir(), 'ac-tmux-'));

async function waitFor(fn: () => Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await Bun.sleep(50); }
  return false;
}

afterAll(async () => { await Bun.spawn(['tmux', '-L', socket, 'kill-server'], { stderr: 'ignore' }).exited; });

describe.skipIf(!hasTmux)('Tmux', () => {
  test('newSession creates a session that list() returns', async () => {
    await tmux.newSession('ac-t1', cwd, { FOO: 'bar' }, ['bash', '--norc', '--noprofile']);
    expect(await tmux.list()).toContain('ac-t1');
    expect(await tmux.has('ac-t1')).toBe(true);
  });

  test('mouse is on, so clicks and the wheel reach Claude Code', async () => {
    const out = await new Response(Bun.spawn(['tmux', '-L', socket, 'show', '-gv', 'mouse']).stdout).text();
    expect(out.trim()).toBe('on');
  });

  test('configure() sets the options on a server that a different process started', async () => {
    const sock = `ac-test-${Math.random().toString(36).slice(2, 8)}`;
    await Bun.spawn(['tmux', '-L', sock, 'new-session', '-d', '-s', 'ac-x', 'bash --norc --noprofile']).exited;
    try {
      await new Tmux(sock).configure();
      const out = await new Response(Bun.spawn(['tmux', '-L', sock, 'show', '-gv', 'mouse']).stdout).text();
      expect(out.trim()).toBe('on');
    } finally { await Bun.spawn(['tmux', '-L', sock, 'kill-server'], { stderr: 'ignore' }).exited; }
  });

  test('sendText runs in the session with its env', async () => {
    await tmux.sendText('ac-t1', 'echo val=$FOO');
    expect(await waitFor(async () => (await tmux.capture('ac-t1')).includes('val=bar'))).toBe(true);
  });

  test('sendText types special characters literally', async () => {
    await tmux.sendText('ac-t1', `echo 'a;b "c" $(x)'`);
    expect(await waitFor(async () => (await tmux.capture('ac-t1')).includes('a;b "c" $(x)\n'))).toBe(true);
  });

  test('I3: concurrent sendText calls never merge two messages into one line', async () => {
    await tmux.newSession('ac-t3', cwd, {}, ['bash', '--norc', '--noprofile']);
    await Bun.sleep(150);
    const out = join(cwd, 'lines.txt');
    await Promise.all(Array.from({ length: 30 }, (_, i) => tmux.sendText('ac-t3', `echo L${i}-END >> ${out}`)));
    await Bun.sleep(800);
    const lines = (await Bun.file(out).text()).trim().split('\n');
    expect(lines.length).toBe(30);
    for (const l of lines) expect(l).toMatch(/^L\d+-END$/);
    await tmux.kill('ac-t3');
  });

  test('capture with lines limits the output', async () => {
    const out = await tmux.capture('ac-t1', { lines: 3 });
    expect(out.trimEnd().split('\n').length).toBeLessThanOrEqual(3);
  });

  test('attachArgs targets the socket and session', () => {
    expect(tmux.attachArgs('ac-t1')).toEqual(['tmux', '-L', socket, 'attach', '-t', 'ac-t1']);
  });

  test('kill removes the session', async () => {
    await tmux.kill('ac-t1');
    expect(await tmux.has('ac-t1')).toBe(false);
  });

  test('list() on a socket with no server is empty', async () => {
    expect(await new Tmux(`${socket}-none`).list()).toEqual([]);
  });
});

describe('stillInInput (Claude Code input box)', () => {
  const RULE = '─'.repeat(60);
  const screen = (input: string) => `● Done.\n\n${RULE}\n❯ ${input}\n${RULE}\n  ⏵⏵ auto mode on\n`;

  test('the message is still in the box → true', () => {
    expect(stillInInput(screen('Fifth read-only task, no file changes'), 'Fifth read-only task, no file changes, no logging.')).toBe(true);
  });

  test('a long message shown as a paste placeholder → true', () => {
    expect(stillInInput(screen('[Pasted text #1 +3 lines]'), 'anything')).toBe(true);
  });

  test('an empty box or a grey suggestion of other text → false', () => {
    expect(stillInInput(screen(''), 'hello there')).toBe(false);
    expect(stillInInput(screen('Try "fix lint errors"'), 'hello there')).toBe(false);
  });

  test('no box on the screen (a plain shell) → false, so nothing is retried', () => {
    expect(stillInInput('$ echo hi\nhi\n$ ', 'echo hi')).toBe(false);
  });

  test('a box that wraps over two lines still matches', () => {
    const s = `${RULE}\n❯ Read-only test, do not change any file. First make\n  a checklist\n${RULE}\n`;
    expect(stillInInput(s, 'Read-only test, do not change any file. First make a checklist')).toBe(true);
  });

  test('settleMs grows with the length, with a cap', () => {
    expect(settleMs('hi')).toBe(80);
    expect(settleMs('x'.repeat(1000))).toBe(180);
    expect(settleMs('x'.repeat(100000))).toBe(580);
  });
});

describe.skipIf(!hasTmux)('Tmux sendText: Enter is not lost', () => {
  test('a long line pasted into a reader arrives whole and is submitted', async () => {
    await tmux.newSession('ac-t5', cwd, {}, ['bash', '--norc', '--noprofile']);
    await Bun.sleep(150);
    const long = 'x'.repeat(900);
    const out = join(cwd, 'long.txt');
    await tmux.sendText('ac-t5', `echo ${long} > ${out}`);
    expect(await waitFor(async () => (await Bun.file(out).exists()) && (await Bun.file(out).text()).trim() === long, 3000)).toBe(true);
  });
});

describe.skipIf(!hasTmux)('Tmux env', () => {
  test('a new tmux server gets PATH changes made after start-up (desktop launch, issue: "no sessions")', async () => {
    const sock = `ac-test-env-${Math.random().toString(36).slice(2, 8)}`;
    const t = new Tmux(sock);
    const old = process.env.PATH;
    process.env.PATH = `/ac-marker-bin:${old}`;
    try {
      await t.newSession('ac-env', cwd, {}, ['sh', '-c', 'echo "P=$PATH"; sleep 5']);
      expect(await waitFor(async () => (await t.capture('ac-env')).includes('P=/ac-marker-bin:'))).toBe(true);
    } finally {
      process.env.PATH = old;
      await Bun.spawn(['tmux', '-L', sock, 'kill-server'], { stderr: 'ignore' }).exited;
    }
  });
});

describe('Tmux with a runner', () => {
  test('sends its args to the runner, not to Bun.spawn', async () => {
    const r = new FakeRunner().on(['list-sessions'], { out: 'a\nb\n' });
    const t = new Tmux('s', r.spawn);
    expect(await t.list()).toEqual(['a', 'b']);
    expect(r.cmds[0]!.slice(0, 3)).toEqual(['-L', 's', 'list-sessions']);
  });
  test('run() throws "tmux <cmd> failed" on a non-zero code, unless allowFail', async () => {
    const r = new FakeRunner().on(['kill-session'], { code: 1, err: 'nope\n' }).on(['send-keys'], { code: 1, err: 'bad\n' });
    const t = new Tmux('s', r.spawn);
    await t.kill('x'); // allowFail
    await expect(t.sendKey('x', 'a')).rejects.toThrow('tmux send-keys failed: bad');
  });
});

describe('remoteTmux', () => {
  const up = () => {
    const f = new FakeRunner();
    const link = new HostLink({ id: 'mac', name: 'Mac', ssh: 'mac', roots: [] }, { consolePort: 1, sockDir: '/tmp/ac-rt', spawn: f.spawn });
    link.state = 'up';
    return { f, link };
  };
  test('newSession runs ssh ... tmux -L agent-console new-session ... with quoted args', async () => {
    const { f, link } = up();
    await remoteTmux(link, 'agent-console').newSession('ac-x', '/r/my repo', { A: 'b c' }, ['claude', '--x']);
    const c = f.cmds.find(x => x.at(-1)!.includes('new-session'))!;
    expect(c[0]).toBe('ssh');
    expect(c.at(-1)).toContain("'tmux' '-L' 'agent-console' 'new-session' '-d' '-s' 'ac-x' '-c' '/r/my repo'");
    expect(c.at(-1)).toContain("'-e' 'A=b c'");
  });
  test('attachArgs starts with ssh -S <sock> and has -t', () => {
    const { link } = up();
    const a = remoteTmux(link, 'agent-console').attachArgs('ac-x');
    expect(a.slice(0, 2)).toEqual(['ssh', '-S']);
    expect(a[2]).toBe(link.sock());
    expect(a).toContain('-t');
    expect(a.at(-1)).toContain("'attach' '-t' 'ac-x'");
  });
  test('a link that is not up throws, but list() (allowFail) gives []', async () => {
    const { link } = up();
    link.state = 'down';
    const t = remoteTmux(link, 'agent-console');
    expect(await t.list()).toEqual([]);
    await expect(t.sendKey('x', 'a')).rejects.toThrow('tmux send-keys failed');
  });
});
