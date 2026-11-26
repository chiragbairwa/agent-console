import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, linkKey } from '../src/workers';
import { ADAPTERS } from '../src/agents';
import { ensureAdvisor } from '../src/advisor';
import { loadConfig, saveState } from '../src/store';
import type { StateEvent } from '../src/types';
import { FakeTmux } from './fakes';

let tmux: FakeTmux;
let now: number;
let execs: { cmd: string[]; cwd: string }[];
let events: StateEvent[];

function mkReg() {
  const r = new Registry(tmux.asTmux(), loadConfig(), {
    bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '',
    now: () => now, exec: async (cmd, cwd) => { execs.push({ cmd, cwd }); },
  });
  r.addEventListener('event', e => events.push((e as CustomEvent<StateEvent>).detail));
  return r;
}

beforeEach(() => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
  tmux = new FakeTmux(); now = 1_000_000; execs = []; events = [];
});

describe('Registry.spawn', () => {
  test('makes a slug id and a tmux session in the repo folder', async () => {
    const r = mkReg();
    const w = await r.spawn({ name: 'Web App', repo: '/r/Acme.Web.App' });
    expect(w.id).toBe('web-app');
    expect(w.repo).toBe('Acme.Web.App');
    const [name, cwd, , cmd] = tmux.of('newSession')[0]!.args as [string, string, unknown, string[]];
    expect(name).toBe('ac-web-app');
    expect(cwd).toBe('/r/Acme.Web.App');
    expect(cmd[0]).toBe('claude');
    expect(events.some(e => e.t === 'worker' && e.worker.id === 'web-app')).toBe(true);
  });

  test('a second worker with the same name gets a suffix', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/a' });
    expect((await r.spawn({ name: 'Nova', repo: '/r/b' })).id).toBe('nova-2');
  });

  test('worktree option creates a git worktree and uses it as cwd', async () => {
    const r = mkReg();
    const w = await r.spawn({ name: 'Atlas', repo: '/r/Acme.Atlas', worktree: { branch: 'fix/x' } });
    expect(execs[0]).toEqual({ cmd: ['git', 'worktree', 'add', '/r/worktrees/Acme.Atlas-fix-x', '-b', 'fix/x'], cwd: '/r/Acme.Atlas' });
    expect(w.cwd).toBe('/r/worktrees/Acme.Atlas-fix-x');
    expect(w.branch).toBe('fix/x');
  });

  test('worktree from a chosen branch passes the base to git', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Atlas', repo: '/r/B', worktree: { branch: 'feat/y', base: 'origin/main' } });
    expect(execs[0]!.cmd).toEqual(['git', 'worktree', 'add', '/r/worktrees/B-feat-y', '-b', 'feat/y', 'origin/main']);
  });

  test('a branch or base that starts with "-" is refused (git would read an option)', async () => {
    const r = mkReg();
    await expect(r.spawn({ name: 'B', repo: '/r/B', worktree: { branch: 'x', base: '--force' } })).rejects.toThrow('bad branch name');
    await expect(r.spawn({ name: 'B', repo: '/r/B', worktree: { branch: '-x' } })).rejects.toThrow('bad branch name');
    expect(execs).toHaveLength(0);
  });

  test('advisor role always gets id "advisor"', async () => {
    const r = mkReg();
    expect((await r.spawn({ name: 'Advisor', repo: '/r', role: 'advisor' })).id).toBe('advisor');
  });
});

describe('Registry.deliver (queue)', () => {
  test('sends directly to an idle worker with a from-prefix and a pulse', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/s' });
    await r.spawn({ name: 'Atlas', repo: '/r/b' });
    expect(await r.deliver('atlas', 'nova', 'hello')).toBe('sent');
    expect(tmux.of('sendText').at(-1)!.args).toEqual(['ac-nova', '[from Atlas] hello']);
    expect(events.some(e => e.t === 'pulse' && e.from === 'atlas' && e.to === 'nova')).toBe(true);
  });

  test('text from the user is sent without a prefix', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/s' });
    await r.deliver('you', 'nova', 'run tests');
    expect(tmux.of('sendText').at(-1)!.args).toEqual(['ac-nova', 'run tests']);
  });

  test('queues when the target needs you, then flushes in order on done', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/s' });
    r.setStatus('nova', 'needs-you');
    expect(await r.deliver('advisor', 'nova', 'one')).toBe('queued');
    expect(await r.deliver('advisor', 'nova', 'two')).toBe('queued');
    expect(tmux.of('sendText').length).toBe(0);
    expect(events.some(e => e.t === 'queued' && e.id === 'nova' && e.count === 2)).toBe(true);
    r.setStatus('nova', 'done');
    await Bun.sleep(10);
    expect(tmux.of('sendText').map(c => c.args[1])).toEqual(['[from advisor] one', '[from advisor] two']);
  });

  test('a message queued because the user was typing is sent when the quiet window ends', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/s' });
    r.noteUserInput('nova');
    now += 9_950; // 50 ms of quiet window left
    expect(await r.deliver('advisor', 'nova', 'later')).toBe('queued');
    now += 100;
    await Bun.sleep(250);
    expect(tmux.of('sendText').map(c => c.args[1])).toEqual(['[from advisor] later']);
  });

  test('I1: control characters and line breaks are removed from delivered text', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/s' });
    await r.deliver('advisor', 'nova', 'a\rb\x1b[Zc\x03\nd\x7f!git push');
    const sent = tmux.of('sendText').at(-1)!.args[1] as string;
    expect(sent).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(sent).toBe('[from advisor] a b[Zc d!git push');
  });

  test('I2: a worker with a tool in flight is busy; the queue flushes when the tool ends', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/s' });
    r.toolStart('nova');
    expect(await r.deliver('advisor', 'nova', 'x')).toBe('queued');
    r.toolEnd('nova');
    await Bun.sleep(10);
    expect(tmux.of('sendText').map(c => c.args[1])).toEqual(['[from advisor] x']);
  });

  test('I2: the waiting status does not flush the queue', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/s' });
    r.setStatus('nova', 'needs-you');
    await r.deliver('advisor', 'nova', 'x');
    r.setStatus('nova', 'waiting');
    await Bun.sleep(10);
    expect(tmux.of('sendText').length).toBe(0);
  });

  test('queues when the user typed into the terminal less than 10 s ago', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/s' });
    r.noteUserInput('nova');
    now += 5_000;
    expect(await r.deliver('advisor', 'nova', 'x')).toBe('queued');
    now += 6_000;
    expect(await r.deliver('advisor', 'nova', 'y')).toBe('sent');
  });
});

describe('Registry links', () => {
  test('advisor cannot reconnect a link the user cut; the user can', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Nova', repo: '/r/s' });
    await r.spawn({ name: 'Fo', repo: '/r/f' });
    expect(r.connect('nova', 'fo', 'advisor')).toBe(true);
    r.cut('nova', 'fo');
    expect(r.linked('nova', 'fo')).toBe(false);
    expect(r.connect('nova', 'fo', 'advisor')).toBe(false);
    expect(r.connect('fo', 'nova', 'you')).toBe(true);
    expect(r.snapshot().t === 'snapshot' && r.snapshot().state.cut).not.toContain(linkKey('nova', 'fo'));
  });
});

describe('Registry needs', () => {
  test('waitNeed resolves with the decision from resolveNeed', async () => {
    const r = mkReg();
    const n = r.addNeed({ id: 'nova', kind: 'guard', text: 'Allow: git push' });
    const p = r.waitNeed(n.nid, 5_000);
    r.resolveNeed(n.nid, 'allow');
    expect(await p).toEqual({ decision: 'allow', text: undefined });
    expect(r.needs()).toEqual([]);
  });

  test('waitNeed times out and removes the need', async () => {
    const r = mkReg();
    const n = r.addNeed({ id: 'nova', kind: 'guard', text: 'x' });
    expect((await r.waitNeed(n.nid, 20)).decision).toBe('timeout');
    expect(r.needs()).toEqual([]);
  });
});

describe('Registry linked sessions', () => {
  const ext = (over: object = {}) => ({ pid: 4242, sessionId: 'sess-1', cwd: '/r/Acme.Atlas', name: 'acme-atlas-3f', status: 'idle', startedAt: 1, ancestor: false, ...over });

  let extDir = '';
  function mkReg2(alive: Set<number>, killed: number[]) {
    extDir = mkdtempSync(join(tmpdir(), 'ac-x-'));
    writeFileSync(join(extDir, '4242.json'), JSON.stringify({ ...ext(), kind: 'interactive', procStart: '1' }));
    const r = new Registry(tmux.asTmux(), loadConfig(), {
      bin: ['/b'], url: 'u', token: 't', inheritedOtelAttrs: '', now: () => now,
      alive: p => alive.has(p), kill: p => { killed.push(p); alive.delete(p); },
      sessionsDir: extDir, ancestors: [], procStartOf: () => '1', cmdlineOf: () => 'claude',
    });
    r.addEventListener('event', e => events.push((e as CustomEvent<StateEvent>).detail));
    return r;
  }

  test('link adds a linked card connected to the advisor; no tmux session is made', async () => {
    const r = mkReg2(new Set([4242]), []);
    await r.spawn({ name: 'Advisor', repo: '/r', role: 'advisor' });
    const before = tmux.of('newSession').length;
    const w = r.link(ext());
    expect(w).toMatchObject({ kind: 'linked', pid: 4242, sessionId: 'sess-1', repo: 'Acme.Atlas', cwd: '/r/Acme.Atlas' });
    expect(r.linked('advisor', w.id)).toBe(true);
    expect(tmux.of('newSession').length).toBe(before);
  });

  test('adopt stops the old process, then resumes the conversation in tmux, keeping the card', async () => {
    const alive = new Set([4242]); const killed: number[] = [];
    const r = mkReg2(alive, killed);
    const linked = r.link(ext());
    r.move(linked.id, 77, 88);
    const w = await r.adopt(ext());
    expect(killed).toEqual([4242]);
    expect(w.id).toBe(linked.id);
    expect(w).toMatchObject({ kind: 'tmux', x: 77, y: 88 });
    const cmd = tmux.of('newSession').at(-1)!.args[3] as string[];
    expect(cmd.slice(-2)).toEqual(['--resume', 'sess-1']);
    expect(r.workers().filter(x => x.sessionId === 'sess-1').length).toBe(1);
  });

  test('adopt refuses a session that runs the console', async () => {
    const r = mkReg2(new Set([4242]), []);
    await expect(r.adopt(ext({ ancestor: true }))).rejects.toThrow(/runs the console/);
  });

  test('pollLinked maps busy to running and a dead pid to stopped', async () => {
    const alive = new Set([4242]);
    const r = mkReg2(alive, []);
    const w = r.link(ext());
    r.pollLinked(() => ({ status: 'busy' }));
    expect(r.get(w.id)!.status).toBe('running');
    alive.clear();
    r.pollLinked(() => undefined);
    expect(r.get(w.id)!.status).toBe('stopped');
  });

  test('discover does not mark a live linked card as stopped', async () => {
    const r = mkReg2(new Set([4242]), []);
    const w = r.link(ext());
    await r.discover();
    expect(r.get(w.id)!.status).not.toBe('stopped');
  });

  test('a message from the user to a linked card is refused', async () => {
    const r = mkReg2(new Set([4242]), []);
    const w = r.link(ext());
    await expect(r.deliver('you', w.id, 'hi')).rejects.toThrow(/linked/);
  });
});

describe('Registry.discover', () => {
  test('restores known sessions, adds unknown ones, marks missing ones stopped', async () => {
    saveState({
      workers: [
        { id: 'nova', name: 'Nova', role: 'worker', cwd: '/r/s', repo: 's', status: 'running', task: 't', x: 11, y: 22 },
        { id: 'atlas', name: 'Atlas', role: 'worker', cwd: '/r/b', repo: 'b', status: 'running', task: 't', x: 0, y: 0 },
      ], links: [], cut: [], activity: [],
    });
    tmux.sessions.add('ac-nova'); tmux.sessions.add('ac-x'); tmux.sessions.add('other');
    const r = mkReg();
    await r.discover();
    const ws = r.workers();
    expect(ws.find(w => w.id === 'nova')).toMatchObject({ x: 11, y: 22 });
    expect(ws.find(w => w.id === 'x')).toBeDefined();
    expect(ws.find(w => w.id === 'x')!.y).toBeGreaterThan(22 + 500); // placed below known boxes, not on top
    expect(ws.find(w => w.id === 'atlas')!.status).toBe('stopped');
    expect(ws.find(w => w.id === 'other')).toBeUndefined();
  });
});

test('start() with an unknown agent throws and starts nothing', async () => {
  const r = mkReg();
  const w = await r.spawn({ name: 'Nova', repo: '/r/a' });
  r.update(w.id, { agent: 'nope' });
  await expect(r.restart(w.id, true)).rejects.toThrow('unknown agent: nope');
  expect(tmux.of('newSession').length).toBe(1); // only the first spawn
  expect(tmux.of('kill').length).toBe(0); // the old session stays alive
});

test('start merges config.agents.codex under worker options', async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
  const cfg = { ...loadConfig(), agents: { codex: { model: 'cfg-model', reasoning: 'low', bad: 5 as unknown as string } } };
  const r = new Registry(tmux.asTmux(), cfg, { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async () => {} });
  await r.spawn({ name: 'Cx', repo: '/r/a', agent: 'codex', options: { reasoning: 'high' } });
  const cmd = tmux.of('newSession')[0]!.args[3] as string[];
  expect(cmd).toContain('model="cfg-model"');
  expect(cmd).toContain('model_reasoning_effort="high"');
  expect(cmd).not.toContain('model_reasoning_effort="low"');
  expect(r.get('cx')).toMatchObject({ agent: 'codex', options: { reasoning: 'high' } });
});

test('spawn uses config.defaultWorkerAgent when the input has no agent', async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
  const cfg = { ...loadConfig(), defaultWorkerAgent: 'codex' };
  const r = new Registry(tmux.asTmux(), cfg, { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async () => {} });
  const w = await r.spawn({ name: 'Cx', repo: '/r/a' });
  expect(w.agent).toBe('codex');
  expect((tmux.of('newSession')[0]!.args[3] as string[])[0]).toBe('codex');
});

test('defaultWorkerAgent does not apply to the advisor seat', async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
  const cfg = { ...loadConfig(), defaultWorkerAgent: 'codex' };
  const r = new Registry(tmux.asTmux(), cfg, { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async () => {} });
  const a = await r.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
  expect(a.agent).toBeUndefined();
  expect((tmux.of('newSession')[0]!.args[3] as string[])[0]).toBe('claude');
  const w = await r.spawn({ name: 'Cx', repo: '/r/b' });
  expect(w.agent).toBe('codex');
});

test('start passes hookTimeoutSec to the adapter', async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
  const cfg = { ...loadConfig(), hookTimeoutSec: 900 };
  const r = new Registry(tmux.asTmux(), cfg, { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async () => {} });
  await r.spawn({ name: 'Cx', repo: '/r/a', agent: 'codex' });
  expect((tmux.of('newSession')[0]!.args[3] as string[]).some(a => a.includes('--max-time 930'))).toBe(true);
});

test('defaultWorkerAgent codex: options are validated against codex and the worker stores it', async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
  const cfg = { ...loadConfig(), defaultWorkerAgent: 'codex' };
  const r = new Registry(tmux.asTmux(), cfg, { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async () => {} });
  const w = await r.spawn({ name: 'Cx', repo: '/r/a', options: { reasoning: 'high' } });
  expect(w.agent).toBe('codex');
  expect((tmux.of('newSession')[0]!.args[3] as string[])[0]).toBe('codex');
});

test('unknown defaultWorkerAgent: spawn throws before the worktree and the session', async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
  const cfg = { ...loadConfig(), defaultWorkerAgent: 'nope' };
  const r = new Registry(tmux.asTmux(), cfg, { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async (cmd, cwd) => { execs.push({ cmd, cwd }); } });
  await expect(r.spawn({ name: 'X', repo: '/r/a', worktree: { branch: 'fix/x' } })).rejects.toThrow('unknown agent: nope');
  expect(execs.length).toBe(0);
  expect(tmux.of('newSession').length).toBe(0);
});

describe('Registry.resize', () => {
  test('clamps, rounds, emits and keeps w/h after a state reload', async () => {
    const r = mkReg();
    const w = await r.spawn({ name: 'Nova', repo: '/r/a' });
    events = [];
    r.resize(w.id, 700.4, 5000);
    expect(r.get(w.id)).toMatchObject({ w: 700, h: 1600 });
    expect(events.some(e => e.t === 'worker' && e.worker.id === w.id && e.worker.w === 700)).toBe(true);
    r.flush();
    const r2 = mkReg();
    expect(r2.get(w.id)).toMatchObject({ w: 700, h: 1600 });
  });

  test('without a size it removes w/h', async () => {
    const r = mkReg();
    const w = await r.spawn({ name: 'Nova', repo: '/r/a' });
    r.resize(w.id, 800, 500);
    r.resize(w.id);
    expect('w' in r.get(w.id)!).toBe(false);
    expect('h' in r.get(w.id)!).toBe(false);
  });
});

describe('Registry.swapAdvisor', () => {
  const PROMPT = 'RULE one\n- use SendMessage for linked\nRULE two';
  async function mkAdv(): Promise<Registry> {
    process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
    const r = new Registry(tmux.asTmux(), loadConfig(), { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async () => {}, advisorPrompt: PROMPT, swapSettleMs: 0 });
    r.addEventListener('event', e => events.push((e as CustomEvent<StateEvent>).detail));
    await r.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
    return r;
  }
  const lastCmd = () => tmux.of('newSession').at(-1)!.args[3] as string[];

  test('swapAdvisor to codex: saves the claude sessionId, kills, starts codex fresh', async () => {
    const r = await mkAdv();
    r.update('advisor', { sessionId: 'cl-1' });
    const w = await r.swapAdvisor('codex');
    expect(tmux.of('kill').at(-1)!.args[0]).toBe('ac-advisor');
    expect(w.agent).toBe('codex');
    expect(w.lastSessions).toEqual({ claude: 'cl-1' });
    expect(w.sessionId).toBeUndefined();
    expect(lastCmd()[0]).toBe('codex');
    expect(lastCmd()).not.toContain('resume');
    expect(w.status).toBe('idle');
    expect(w.task).toBe('Switched to Codex');
  });

  test('swap back to claude resumes the saved claude sessionId (--resume <id>)', async () => {
    const r = await mkAdv();
    r.update('advisor', { sessionId: 'cl-1' });
    await r.swapAdvisor('codex');
    r.update('advisor', { sessionId: 'cx-1' });
    const w = await r.swapAdvisor('claude');
    expect(w.sessionId).toBe('cl-1');
    expect(w.lastSessions).toEqual({ claude: 'cl-1', codex: 'cx-1' });
    const cmd = lastCmd();
    expect(cmd[cmd.indexOf('--resume') + 1]).toBe('cl-1');
  });

  test('swap to the same agent does nothing', async () => {
    const r = await mkAdv();
    const before = tmux.calls.length;
    const w = await r.swapAdvisor('claude');
    expect(w.id).toBe('advisor');
    expect(tmux.calls.length).toBe(before);
  });

  test('swap to unknown agent throws and does not kill', async () => {
    const r = await mkAdv();
    await expect(r.swapAdvisor('nope')).rejects.toThrow('unknown agent: nope');
    await expect(r.swapAdvisor('toString')).rejects.toThrow('unknown agent');
    expect(tmux.of('kill').length).toBe(0);
    expect(r.get('advisor')!.agent).toBeUndefined();
  });

  test('swap with no advisor throws', async () => {
    process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
    const r = new Registry(tmux.asTmux(), loadConfig(), { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '' });
    await expect(r.swapAdvisor('codex')).rejects.toThrow('no advisor');
  });

  test('swap with no sessionId saves nothing', async () => {
    const r = await mkAdv();
    const w = await r.swapAdvisor('codex');
    expect(w.lastSessions).toBeUndefined();
    expect(w.sessionId).toBeUndefined();
  });

  test('swap clears the advisor needs and queue', async () => {
    const r = await mkAdv();
    await r.spawn({ name: 'Nova', repo: '/r/b' });
    r.addNeed({ id: 'advisor', kind: 'permission', text: 'p' });
    r.addNeed({ id: 'advisor', kind: 'waiting', text: 'w' });
    r.addNeed({ id: 'nova', kind: 'permission', text: 'other' });
    r.toolStart('advisor');
    await r.deliver('nova', 'advisor', 'hello');
    expect(r.queuedFor('advisor')).toBe(1);
    await r.swapAdvisor('codex');
    expect(r.needs().map(n => n.id)).toEqual(['nova']);
    expect(r.queuedFor('advisor')).toBe(0);
    expect(events.some(e => e.t === 'queued' && e.id === 'advisor' && e.count === 0)).toBe(true);
    // The pending-tool mark is gone: a new message is sent at once.
    expect(await r.deliver('nova', 'advisor', 'again')).toBe('sent');
  });

  test('a deliver during the swap is queued, not sent; it is sent once after the settle time', async () => {
    const r = await mkAdv();
    (r as any).opts.swapSettleMs = 30;
    let release!: () => void;
    const orig = tmux.kill.bind(tmux);
    tmux.kill = async (...a: Parameters<typeof orig>) => { await new Promise<void>(res => { release = res; }); return orig(...a); };
    const sends = () => tmux.of('sendText').length;
    const p = r.swapAdvisor('codex');
    await new Promise(res => setTimeout(res, 5));
    expect(await r.deliver('you', 'advisor', 'during')).toBe('queued');
    expect(sends()).toBe(0);
    release();
    await p;
    // Settle time still runs: the new TUI may be loading.
    expect(await r.deliver('you', 'advisor', 'settling')).toBe('queued');
    expect(sends()).toBe(0);
    await new Promise(res => setTimeout(res, 80));
    expect(sends()).toBe(2);
    expect(tmux.of('sendText').map(c => c.args[0])).toEqual(['ac-advisor', 'ac-advisor']);
  });

  test('a start failure releases the busy mark at once', async () => {
    const r = await mkAdv();
    (r as any).opts.swapSettleMs = 60_000;
    const orig = tmux.newSession.bind(tmux);
    tmux.newSession = async () => { throw new Error('boom'); };
    await expect(r.swapAdvisor('codex')).rejects.toThrow('boom');
    expect((r as any).pendingTools.has('advisor')).toBe(false);
    tmux.newSession = orig;
  });

  test('the swap logs the queued messages it drops', async () => {
    const r = await mkAdv();
    await r.spawn({ name: 'Nova', repo: '/r/b' });
    r.toolStart('advisor');
    await r.deliver('nova', 'advisor', 'one');
    await r.deliver('nova', 'advisor', 'two');
    await r.swapAdvisor('codex');
    expect(r.snapshot().state.activity.map(a => a.text)).toContain('Dropped 2 queued message(s) for the advisor (swap).');
  });

  test('no drop line when nothing was queued', async () => {
    const r = await mkAdv();
    await r.swapAdvisor('codex');
    expect(r.snapshot().state.activity.some(a => a.text.startsWith('Dropped'))).toBe(false);
  });

  test('start passes codex rules without the SendMessage line, claude rules unchanged', async () => {
    const r = await mkAdv();
    const claudeCmd = lastCmd();
    expect(claudeCmd[claudeCmd.indexOf('--append-system-prompt') + 1]).toBe(PROMPT);
    await r.swapAdvisor('codex');
    const di = lastCmd().find(a => a.startsWith('developer_instructions='))!;
    expect(JSON.parse(di.slice('developer_instructions='.length))).toBe('RULE one\nRULE two');
  });

  test('swap denies a guard need with a waiter; the final status is idle', async () => {
    const r = await mkAdv();
    const need = r.addNeed({ id: 'advisor', kind: 'guard', text: 'Allow: git push' });
    // The same code path as the hook server after a waiter ends.
    const after = r.waitNeed(need.nid, 60_000).then(d => { r.setStatus('advisor', 'running', 'Bash: git push'); return d; });
    r.setStatus('advisor', 'needs-you', 'Waiting for you');
    await r.swapAdvisor('codex');
    expect(await after).toEqual({ decision: 'deny', text: undefined });
    expect(r.needs().some(n => n.id === 'advisor')).toBe(false);
    expect(r.get('advisor')!.status).toBe('idle');
    expect(r.get('advisor')!.task).toBe('Switched to Codex');
  });

  test('a swap that is restarted by a new registry resumes the saved sessions', async () => {
    const r = await mkAdv();
    r.update('advisor', { sessionId: 'cl-1' });
    await r.swapAdvisor('codex');
    r.update('advisor', { sessionId: 'cx-1' });
    r.flush();
    const t2 = new FakeTmux();
    const r2 = new Registry(t2.asTmux(), loadConfig(), { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async () => {}, advisorPrompt: PROMPT });
    await r2.discover();
    expect(r2.get('advisor')!.status).toBe('stopped');
    await ensureAdvisor(r2, { ...loadConfig(), advisorAgent: 'claude' });
    const cmd = t2.of('newSession').at(-1)!.args[3] as string[];
    expect(cmd[0]).toBe('codex');
    expect(cmd.slice(cmd.indexOf('resume'))).toContain('cx-1');
    expect(r2.get('advisor')!.lastSessions).toEqual({ claude: 'cl-1' });
  });

  test('start fails after the kill: advisor stopped with the reason, error rethrown', async () => {
    const r = await mkAdv();
    const orig = tmux.newSession.bind(tmux);
    let once = true;
    tmux.newSession = async (...a: Parameters<typeof orig>) => { if (once) { once = false; throw new Error('boom'); } return orig(...a); };
    await expect(r.swapAdvisor('codex')).rejects.toThrow('boom');
    expect(r.get('advisor')!.status).toBe('stopped');
    expect(r.get('advisor')!.task).toBe('Swap failed: boom');
    // The guard is released: a new swap can run.
    await r.swapAdvisor('claude');
  });

  test('a second swap while one runs throws', async () => {
    const r = await mkAdv();
    const first = r.swapAdvisor('codex');
    await expect(r.swapAdvisor('codex')).rejects.toThrow('a swap is already running');
    await first;
    expect(r.get('advisor')!.agent).toBe('codex');
  });

  test('an agent without caps.advisor cannot take the seat', async () => {
    const r = await mkAdv();
    ADAPTERS.stub = { ...ADAPTERS.codex!, id: 'stub', label: 'Stub', caps: { ...ADAPTERS.codex!.caps, advisor: false } };
    try {
      await expect(r.swapAdvisor('stub')).rejects.toThrow('Stub cannot be the advisor');
      expect(tmux.of('kill').length).toBe(0);
    } finally { delete ADAPTERS.stub; }
  });
});

describe('Registry reviewer seat', () => {
  const ADV = 'ADVISOR RULES';
  const REV = 'REVIEWER RULES';
  async function mkSeats(leadAgent = 'claude', revAgent = 'codex'): Promise<Registry> {
    process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
    const r = new Registry(tmux.asTmux(), loadConfig(), { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async () => {}, advisorPrompt: ADV, reviewerPrompt: REV, swapSettleMs: 0 });
    r.addEventListener('event', e => events.push((e as CustomEvent<StateEvent>).detail));
    await r.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor', agent: leadAgent });
    await r.addReviewer(revAgent);
    return r;
  }
  const lastCmd = () => tmux.of('newSession').at(-1)!.args[3] as string[];
  const acts = (r: Registry) => r.snapshot().state.activity.map(a => a.text);

  test('addReviewer: id reviewer, role reviewer, own agent, lead cwd, position right of the lead, one link', async () => {
    const r = await mkSeats();
    const lead = r.get('advisor')!;
    const rev = r.get('reviewer')!;
    expect(rev.role).toBe('reviewer');
    expect(rev.agent).toBe('codex');
    expect(rev.cwd).toBe(lead.cwd);
    expect(rev.x).toBe(lead.x + (lead.w ?? 760) + 60);
    expect(rev.y).toBe(lead.y);
    expect(r.links().filter(l => l.a === 'reviewer' || l.b === 'reviewer').map(l => [l.a, l.b].sort())).toEqual([['advisor', 'reviewer']]);
    expect(acts(r)).toContain('Added a reviewer (Codex).');
  });

  test('addReviewer uses the width of the lead when it was resized', async () => {
    process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
    const r = new Registry(tmux.asTmux(), loadConfig(), { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', exec: async () => {} });
    await r.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
    r.resize('advisor', 900, 500);
    await r.addReviewer('claude');
    expect(r.get('reviewer')!.x).toBe(r.get('advisor')!.x + 900 + 60);
  });

  test('addReviewer errors: a reviewer exists, no advisor, unknown agent, agent without caps.advisor', async () => {
    const r = await mkSeats();
    await expect(r.addReviewer('claude')).rejects.toThrow('a reviewer exists');
    process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
    const r2 = new Registry(tmux.asTmux(), loadConfig(), { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', exec: async () => {} });
    await expect(r2.addReviewer('claude')).rejects.toThrow('no advisor');
    await expect(r.addReviewer('nope')).rejects.toThrow('unknown agent');
    await expect(r.addReviewer('toString')).rejects.toThrow('unknown agent');
    ADAPTERS.stub = { ...ADAPTERS.codex!, id: 'stub', label: 'Stub', caps: { ...ADAPTERS.codex!.caps, advisor: false } };
    try {
      await r2.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
      await expect(r2.addReviewer('stub')).rejects.toThrow('Stub cannot be the reviewer');
      expect(r2.get('reviewer')).toBeUndefined();
    } finally { delete ADAPTERS.stub; }
  });

  test('the reviewer gets the reviewer rules; the lead keeps the advisor rules (both adapters)', async () => {
    const r = await mkSeats('claude', 'codex');
    const di = lastCmd().find(a => a.startsWith('developer_instructions='))!;
    expect(JSON.parse(di.slice('developer_instructions='.length))).toBe(REV);
    await r.removeReviewer();
    await r.addReviewer('claude');
    const c = lastCmd();
    expect(c[c.indexOf('--append-system-prompt') + 1]).toBe(REV);
    const first = tmux.of('newSession')[0]!.args[3] as string[];
    expect(first[first.indexOf('--append-system-prompt') + 1]).toBe(ADV);
  });

  test('connect refuses a reviewer–worker pair for both by values and either order', async () => {
    const r = await mkSeats();
    const w = await r.spawn({ name: 'Nova', repo: '/r/b' });
    expect(r.connect('reviewer', w.id, 'advisor')).toBe(false);
    expect(r.connect(w.id, 'reviewer', 'you')).toBe(false);
    expect(r.connect('reviewer', w.id, 'you')).toBe(false);
    expect(r.linked('reviewer', w.id)).toBe(false);
    // The reviewer keeps its one link, and a new worker is not linked to it.
    expect(r.links().filter(l => l.a === 'reviewer' || l.b === 'reviewer').length).toBe(1);
    expect(r.linked('advisor', w.id)).toBe(true);
  });

  test('removeReviewer: needs denied, queue cleared, link removed, lead keeps running (Review Focus 5)', async () => {
    const r = await mkSeats();
    const w = await r.spawn({ name: 'Nova', repo: '/r/b' });
    r.addNeed({ id: 'reviewer', kind: 'permission', text: 'p' });
    r.addNeed({ id: 'advisor', kind: 'permission', text: 'lead need' });
    r.toolStart('reviewer');
    await r.deliver('advisor', 'reviewer', 'q1');
    expect(r.queuedFor('reviewer')).toBe(1);
    const killsBefore = tmux.of('kill').length;
    await r.removeReviewer();
    expect(r.get('reviewer')).toBeUndefined();
    expect(r.needs().map(n => n.id)).toEqual(['advisor']);
    expect(r.queuedFor('reviewer')).toBe(0);
    expect(events.some(e => e.t === 'queued' && e.id === 'reviewer' && e.count === 0)).toBe(true);
    expect(r.links().some(l => l.a === 'reviewer' || l.b === 'reviewer')).toBe(false);
    expect(tmux.of('kill').slice(killsBefore).map(c => c.args[0])).toEqual(['ac-reviewer']);
    expect(r.get('advisor')!.status).not.toBe('stopped');
    expect(r.linked('advisor', w.id)).toBe(true);
    expect(acts(r)).toContain('Removed the reviewer.');
    await expect(r.removeReviewer()).rejects.toThrow('no reviewer');
  });

  test('swapSeat reviewer: saves its session, resumes from its own lastSessions, own settle mark', async () => {
    const r = await mkSeats('claude', 'codex');
    r.update('reviewer', { sessionId: 'cx-1' });
    r.update('advisor', { sessionId: 'cl-lead' });
    await r.swapSeat('reviewer', 'claude');
    expect(r.get('reviewer')!.agent).toBe('claude');
    expect(r.get('reviewer')!.lastSessions).toEqual({ codex: 'cx-1' });
    expect(r.get('advisor')!.agent).toBe('claude');
    expect(r.get('advisor')!.lastSessions).toBeUndefined();
    expect(tmux.of('kill').at(-1)!.args[0]).toBe('ac-reviewer');
    expect(acts(r)).toContain('Reviewer switched from Codex to Claude.');
    r.update('reviewer', { sessionId: 'cl-1' });
    await r.swapSeat('reviewer', 'codex');
    const cmd = lastCmd();
    expect(cmd[0]).toBe('codex');
    expect(cmd.slice(cmd.indexOf('resume'))).toContain('cx-1');
  });

  test('swapSeat reviewer: need denial, dropped-queue line, start failure stops it (phase-4 rules)', async () => {
    const r = await mkSeats();
    r.addNeed({ id: 'reviewer', kind: 'permission', text: 'p' });
    r.toolStart('reviewer');
    await r.deliver('advisor', 'reviewer', 'hello');
    await r.swapSeat('reviewer', 'claude');
    expect(r.needs().length).toBe(0);
    expect(r.queuedFor('reviewer')).toBe(0);
    expect(acts(r)).toContain('Dropped 1 queued message(s) for the reviewer (swap).');
    const orig = tmux.newSession.bind(tmux);
    let once = true;
    tmux.newSession = async (...a: Parameters<typeof orig>) => { if (once) { once = false; throw new Error('boom'); } return orig(...a); };
    await expect(r.swapSeat('reviewer', 'codex')).rejects.toThrow('boom');
    expect(r.get('reviewer')!.status).toBe('stopped');
    expect(r.get('reviewer')!.task).toBe('Swap failed: boom');
    expect(r.get('advisor')!.status).not.toBe('stopped');
    await r.swapSeat('reviewer', 'codex');
  });

  test('swapSeat reviewer settle timer is per seat: a swap of the lead does not cancel it', async () => {
    const r = await mkSeats('claude', 'codex');
    (r as any).opts.swapSettleMs = 30;
    await r.swapSeat('reviewer', 'claude');
    await r.swapSeat('advisor', 'codex');
    expect(await r.deliver('you', 'reviewer', 'x')).toBe('queued');
    expect(await r.deliver('you', 'advisor', 'y')).toBe('queued');
    await new Promise(res => setTimeout(res, 80));
    expect(tmux.of('sendText').map(c => c.args[0]).sort()).toEqual(['ac-advisor', 'ac-reviewer']);
  });

  test('swapSeat: one lock for both seats; the unknown seat and a missing reviewer are errors', async () => {
    const r = await mkSeats();
    const first = r.swapSeat('reviewer', 'claude');
    await expect(r.swapSeat('advisor', 'codex')).rejects.toThrow('a swap is already running');
    await first;
    await expect(r.swapSeat('reviewer', 'nope')).rejects.toThrow('unknown agent');
    await r.removeReviewer();
    await expect(r.swapSeat('reviewer', 'codex')).rejects.toThrow('no reviewer');
    await r.swapAdvisor('codex');
    expect(r.get('advisor')!.agent).toBe('codex');
  });

  test('swapRoles: advisor first, then reviewer, each resumes from its own lastSessions', async () => {
    const r = await mkSeats('claude', 'codex');
    r.update('advisor', { sessionId: 'cl-1' });
    r.update('reviewer', { sessionId: 'cx-1' });
    const res = await r.swapRoles();
    expect(res.advisor.agent).toBe('codex');
    expect(res.reviewer.agent).toBe('claude');
    expect(r.get('advisor')!.lastSessions).toEqual({ claude: 'cl-1' });
    expect(r.get('reviewer')!.lastSessions).toEqual({ codex: 'cx-1' });
    expect(tmux.of('kill').slice(-2).map(c => c.args[0])).toEqual(['ac-advisor', 'ac-reviewer']);
    // Swap back: each seat resumes the agent it held before.
    r.update('advisor', { sessionId: 'cx-2' });
    r.update('reviewer', { sessionId: 'cl-2' });
    await r.swapRoles();
    expect(r.get('advisor')!.sessionId).toBe('cl-1');
    expect(r.get('reviewer')!.sessionId).toBe('cx-1');
    // Both timers ran: both seats take messages.
    expect(await r.deliver('you', 'advisor', 'a')).toBe('sent');
    expect(await r.deliver('you', 'reviewer', 'b')).toBe('sent');
  });

  test('swapRoles with the same agent changes nothing', async () => {
    const r = await mkSeats('claude', 'claude');
    const kills = tmux.of('kill').length;
    const res = await r.swapRoles();
    expect(res.advisor.agent).toBe('claude');
    expect(res.reviewer.agent).toBe('claude');
    expect(tmux.of('kill').length).toBe(kills);
  });

  test('swapRoles with no reviewer, or while a seat swaps → error, nothing stops (Review Focus 4)', async () => {
    process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-reg-'));
    const solo = new Registry(tmux.asTmux(), loadConfig(), { bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', exec: async () => {} });
    await solo.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
    await expect(solo.swapRoles()).rejects.toThrow('no reviewer');
    expect(tmux.of('kill').length).toBe(0);
    const r = await mkSeats('claude', 'codex');
    const kills = tmux.of('kill').length;
    const first = r.swapSeat('advisor', 'codex');
    await expect(r.swapRoles()).rejects.toThrow('a swap is already running');
    await first;
    expect(tmux.of('kill').length).toBe(kills + 1);
    await r.swapSeat('reviewer', 'claude');
    const p = r.swapRoles();
    await expect(r.swapSeat('reviewer', 'codex')).rejects.toThrow('a swap is already running');
    await p;
  });

  test('swapRoles: an agent that cannot advise → error before any kill', async () => {
    const r = await mkSeats('claude', 'codex');
    const kills = tmux.of('kill').length;
    ADAPTERS.codex!.caps.advisor = false;
    try { await expect(r.swapRoles()).rejects.toThrow('cannot be the advisor'); }
    finally { ADAPTERS.codex!.caps.advisor = true; }
    expect(tmux.of('kill').length).toBe(kills);
  });

  test('removeReviewer during a reviewer swap is refused; one session and the worker remain', async () => {
    const r = await mkSeats('claude', 'codex');
    const orig = tmux.newSession.bind(tmux);
    let release!: () => void;
    tmux.newSession = async (...a: Parameters<typeof orig>) => { await new Promise<void>(res => { release = res; }); return orig(...a); };
    const p = r.swapSeat('reviewer', 'claude');
    await new Promise(res => setTimeout(res, 10));
    await expect(r.removeReviewer()).rejects.toThrow('a swap is already running');
    release();
    await p;
    expect(r.get('reviewer')).toBeDefined();
    expect([...tmux.sessions].filter(n => n === 'ac-reviewer').length).toBe(1);
  });

  test('the generic remove clears the settle timer and the busy mark of the reviewer', async () => {
    const r = await mkSeats('claude', 'codex');
    (r as any).opts.swapSettleMs = 40;
    await r.swapSeat('reviewer', 'claude');
    await r.remove('reviewer');
    expect((r as any).settleTimers.size).toBe(0);
    await r.addReviewer('codex');
    expect(await r.deliver('you', 'reviewer', 'x')).toBe('sent');
  });

  test('swapRoles: the second seat fails to start; advisor swapped, reviewer stopped, lock released', async () => {
    const r = await mkSeats('claude', 'codex');
    const orig = tmux.newSession.bind(tmux);
    let n = 0;
    tmux.newSession = async (...a: Parameters<typeof orig>) => { if (++n === 2) throw new Error('boom'); return orig(...a); };
    await expect(r.swapRoles()).rejects.toThrow('boom');
    expect(r.get('advisor')!.agent).toBe('codex');
    expect(r.get('reviewer')!.status).toBe('stopped');
    expect(r.get('reviewer')!.task).toBe('Swap failed: boom');
    await r.swapRoles();
    await r.removeReviewer();
  });

  test('the generic remove of a seat during its swap is refused; a worker can still be removed', async () => {
    const r = await mkSeats('claude', 'codex');
    const w = await r.spawn({ name: 'Nova', repo: '/r/b' });
    const orig = tmux.newSession.bind(tmux);
    let release!: () => void;
    tmux.newSession = async (...a: Parameters<typeof orig>) => { await new Promise<void>(res => { release = res; }); return orig(...a); };
    const p = r.swapSeat('advisor', 'codex');
    await new Promise(res => setTimeout(res, 10));
    await expect(r.remove('advisor')).rejects.toThrow('a swap is already running');
    await expect(r.remove('reviewer')).rejects.toThrow('a swap is already running');
    await r.remove(w.id);
    expect(r.get(w.id)).toBeUndefined();
    release();
    await p;
    expect(r.get('advisor')).toBeDefined();
    expect([...tmux.sessions].filter(n => n === 'ac-advisor').length).toBe(1);
  });
});

describe('seat ids are reserved (final review I1)', () => {
  test('a worker named Reviewer or Advisor gets another id; addReviewer still works', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
    const w1 = await r.spawn({ name: 'Reviewer', repo: '/r/b' });
    const w2 = await r.spawn({ name: 'Advisor', repo: '/r/c' });
    expect(w1.id).toBe('reviewer-2');
    expect(w1.role).toBe('worker');
    expect(w2.id).toBe('advisor-2');
    expect(r.reviewer()).toBeUndefined();
    const rev = await r.addReviewer('claude');
    expect(rev.id).toBe('reviewer');
    expect(r.reviewer()?.id).toBe('reviewer');
    expect(r.workers().filter(w => w.role === 'reviewer').length).toBe(1);
  });

  test('link and adopt do not take a seat id', () => {
    const r = mkReg();
    const w = r.link({ pid: 1, sessionId: 's1', name: 'Reviewer', cwd: '/r/x', status: 'idle' } as any);
    expect(w.id).toBe('reviewer-2');
  });

  test('old state: a worker with id reviewer stays a worker; addReviewer refuses', async () => {
    saveState({
      workers: [
        { id: 'advisor', name: 'Advisor', role: 'advisor', cwd: '/r/a', repo: 'a', status: 'idle', task: 't', x: 0, y: 0 },
        { id: 'reviewer', name: 'Reviewer', role: 'worker', cwd: '/r/b', repo: 'b', status: 'idle', task: 't', x: 0, y: 0 },
      ], links: [], cut: [], activity: [],
    });
    tmux.sessions.add('ac-reviewer');
    const r = mkReg();
    await r.discover();
    expect(r.get('reviewer')!.role).toBe('worker');
    await expect(r.addReviewer('claude')).rejects.toThrow('id reviewer is taken by a worker; rename or remove it');
    expect(r.get('reviewer')!.role).toBe('worker');
    expect(r.reviewer()).toBeUndefined();
    await expect(r.removeReviewer()).rejects.toThrow('no reviewer');
  });

  test('discover: an unknown ac-reviewer session becomes the seat by its id', async () => {
    tmux.sessions.add('ac-reviewer');
    const r = mkReg();
    await r.discover();
    expect(r.reviewer()?.id).toBe('reviewer');
  });
});

describe('a cut lead-reviewer link (final review I2)', () => {
  async function seats() {
    const r = mkReg();
    await r.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
    await r.addReviewer('claude');
    return r;
  }
  test('removeReviewer drops the cut key; a new reviewer gets its wire', async () => {
    const r = await seats();
    r.cut('advisor', 'reviewer');
    expect(r.snapshot().state.cut).toContain(linkKey('advisor', 'reviewer'));
    await r.removeReviewer();
    expect(r.snapshot().state.cut).not.toContain(linkKey('advisor', 'reviewer'));
    await r.addReviewer('claude');
    expect(r.linked('advisor', 'reviewer')).toBe(true);
  });

  test('removing the advisor keeps the user cuts of advisor-worker links', async () => {
    const r = await seats();
    const w = await r.spawn({ name: 'Nova', repo: '/r/s' });
    r.cut('advisor', w.id);
    await r.remove('advisor');
    expect(r.snapshot().state.cut).toContain(linkKey('advisor', w.id));
    await ensureAdvisor(r, loadConfig());
    expect(r.linked('advisor', w.id)).toBe(false);
  });

  test('addReviewer links even when a stale cut key exists', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
    r.cut('advisor', 'reviewer');
    await r.addReviewer('claude');
    expect(r.linked('advisor', 'reviewer')).toBe(true);
    expect(r.snapshot().state.cut).not.toContain(linkKey('advisor', 'reviewer'));
  });
});

describe('seat restart and stop during a swap (final review M1)', () => {
  test('restart and stop of a seat throw while a swap runs; a worker is fine', async () => {
    const r = mkReg();
    await r.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
    await r.addReviewer('codex');
    const w = await r.spawn({ name: 'Nova', repo: '/r/s' });
    const orig = tmux.newSession.bind(tmux);
    let release!: () => void;
    tmux.newSession = async (...a: Parameters<typeof orig>) => { await new Promise<void>(res => { release = res; }); return orig(...a); };
    const swap = r.swapSeat('reviewer', 'claude');
    await new Promise(res => setTimeout(res, 20));
    await expect(r.restart('reviewer')).rejects.toThrow('a swap is already running');
    await expect(r.stop('advisor')).rejects.toThrow('a swap is already running');
    tmux.newSession = orig;
    await r.stop(w.id);
    release();
    await swap;
  });
});


describe('remote hosts', () => {
  const { HostPool, TmuxPool } = require('../src/hostpool') as typeof import('../src/hostpool');
  const { FakeRunner } = require('./fakes') as typeof import('./fakes');
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  let runner: InstanceType<typeof FakeRunner>;
  let hosts: InstanceType<typeof HostPool>;
  let listOut: string;
  let listCode = 0; let listErr = '';
  let shellOut = '/bin/zsh';
  const mac = { id: 'mac', name: 'Mac', ssh: 'macmini', roots: [], tunnelPort: 17878 };
  const remoteCmds = () => runner.cmds.map(c => c.at(-1) ?? '');

  function mkRemote(over: Record<string, unknown> = {}) {
    runner = new FakeRunner().on(['ssh', '-S', '--'], { out: 'ok\n' });
    listOut = ''; listCode = 0; listErr = ''; shellOut = '/bin/zsh';
    const spawn = async (cmd: string[], stdin?: string) => {
      const last = cmd.at(-1) ?? '';
      if (cmd[0] === 'ssh' && last.includes('HOME')) { runner.cmds.push(cmd); runner.stdins.push(stdin); return { out: '/Users/me', err: '', code: 0 }; }
      if (cmd[0] === 'ssh' && last.includes('$SHELL')) { runner.cmds.push(cmd); runner.stdins.push(stdin); return { out: shellOut, err: '', code: 0 }; }
      if (cmd[0] === 'ssh' && last.includes('list-sessions')) { runner.cmds.push(cmd); runner.stdins.push(stdin); return { out: listOut, err: listErr, code: listCode }; }
      return runner.spawn(cmd, stdin);
    };
    hosts = new HostPool([mac, { id: 'off', name: 'Off', ssh: 'off', roots: [] }], { consolePort: 7878, sockDir: '/tmp/ac-reg-ssh', spawn });
    const r = new Registry(new TmuxPool(tmux.asTmux(), hosts), loadConfig(), {
      bin: ['/bin/ac'], url: 'http://x', token: 't', inheritedOtelAttrs: '', now: () => now, exec: async () => {}, hosts, ...over,
    });
    r.addEventListener('event', e => events.push((e as CustomEvent<StateEvent>).detail));
    return r;
  }

  test('spawn with host=mac starts the session through the mac Tmux, not the local one', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    const w = await r.spawn({ name: 'Rem', repo: '/Users/me/code/app', host: 'mac' });
    expect(w.host).toBe('mac');
    expect(tmux.of('newSession')).toHaveLength(0);
    const c = remoteCmds().find(s => s.includes('new-session'))!;
    expect(c).toContain("'ac-rem'");
    expect(c).toContain("'/Users/me/code/app'");
    expect(c).toContain('AC_URL=http://127.0.0.1:17878');
  });

  test('spawn with host=mac writes settings.json and mcp.json on the host with umask 077', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/Users/me/code/app', host: 'mac' });
    const writes = runner.cmds.map((c, i) => ({ c: c.at(-1) ?? '', s: runner.stdins[i] })).filter(x => x.c.includes('umask 077'));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.c).toContain('/Users/me/.config/agent-console/sessions/rem/settings.json');
    expect(writes[1]!.c).toContain('/Users/me/.config/agent-console/sessions/rem/mcp.json');
    expect(JSON.parse(writes[1]!.s!).mcpServers['agent-console'].url).toBe('http://127.0.0.1:17878/mcp');
  });

  test('remote settings.json hooks point at the tunnel port', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/Users/me/code/app', host: 'mac' });
    const i = runner.cmds.findIndex(c => (c.at(-1) ?? '').includes('settings.json'));
    const s = JSON.parse(runner.stdins[i]!);
    expect(s.hooks.PreToolUse[0].hooks[0].url).toBe('http://127.0.0.1:17878/hook/PreToolUse');
  });

  test('remote claude args use the remote file paths', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/Users/me/code/app', host: 'mac' });
    const c = remoteCmds().find(s => s.includes('new-session'))!;
    expect(c).toContain("'--settings' '/Users/me/.config/agent-console/sessions/rem/settings.json'");
    expect(c).toContain("'--mcp-config' '/Users/me/.config/agent-console/sessions/rem/mcp.json'");
  });

  test('spawn with an unknown host throws "unknown host" and starts nothing', async () => {
    const r = mkRemote();
    await expect(r.spawn({ name: 'Rem', repo: '/r', host: 'nope' })).rejects.toThrow('unknown host');
    expect(r.workers()).toHaveLength(0);
    expect(runner.cmds).toHaveLength(0);
  });

  test('spawn with a host that is not up throws "Off is not connected"', async () => {
    const r = mkRemote();
    await expect(r.spawn({ name: 'Rem', repo: '/r', host: 'off' })).rejects.toThrow('Off is not connected');
    expect(r.workers()).toHaveLength(0);
  });

  test('a non-claude agent on a remote host is refused', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await expect(r.spawn({ name: 'A', repo: '/r', host: 'mac', agent: 'codex' })).rejects.toThrow('codex workers cannot run on a remote host yet');
  });

  test('remote worktree add runs git -C <repo> through ssh and the worker starts in the worktree', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    const w = await r.spawn({ name: 'Wt', repo: '/Users/me/code/app', host: 'mac', worktree: { branch: 'fix/x', base: 'origin/main' } });
    const c = remoteCmds().find(s => s.includes('worktree'))!;
    expect(c).toBe(`'git' '-C' '/Users/me/code/app' 'worktree' 'add' '-b' 'fix/x' '--' '/Users/me/code/worktrees/app-fix-x' 'origin/main'`);
    expect(w.cwd).toBe('/Users/me/code/worktrees/app-fix-x');
    expect(w.worktree).toBe('/Users/me/code/worktrees/app-fix-x');
    expect(execs).toHaveLength(0); // nothing ran on this machine
  });

  test('remote worktree: a branch "-x" or base "-y" is refused before ssh runs', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    const before = runner.cmds.length;
    await expect(r.spawn({ name: 'B', repo: '/r', host: 'mac', worktree: { branch: '-x' } })).rejects.toThrow('bad branch name');
    await expect(r.spawn({ name: 'C', repo: '/r', host: 'mac', worktree: { branch: 'ok', base: '-y' } })).rejects.toThrow('bad branch name');
    expect(runner.cmds.length).toBe(before);
    expect(r.workers()).toHaveLength(0);
  });

  test('host error → its workers show Host offline; records stay; no kill', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    await r.spawn({ name: 'Loc', repo: '/l' });
    (hosts.link('mac') as any).set('error');
    expect(r.get('rem')).toMatchObject({ status: 'stopped', task: 'Host offline' });
    expect(r.get('loc')!.status).toBe('idle');
    expect(tmux.of('kill')).toHaveLength(0);
    expect(remoteCmds().some(s => s.includes('kill-session'))).toBe(false);
  });

  test('host up again → discoverHost marks live sessions idle', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    (hosts.link('mac') as any).set('error');
    listOut = 'ac-rem\nac-stranger\n';
    (hosts.link('mac') as any).set('up');
    await new Promise(res => setTimeout(res, 20));
    expect(r.get('rem')!.status).toBe('idle');
    expect(r.get('stranger')).toBeUndefined();
  });

  test('discover() does not stop a remote worker for a missing local session', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    listOut = '';
    await r.discover();
    expect(r.get('rem')!.status).toBe('stopped'); // the host is up and lists no session
    listOut = 'ac-rem\n';
    await r.discover();
    expect(r.get('rem')!.status).toBe('idle');
  });

  test('capture tool reads through the worker host', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Advisor', repo: '/l', role: 'advisor' });
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    const { handleTool } = require('../src/tools') as typeof import('../src/tools');
    await handleTool(r, tmux.asTmux(), { caller: 'advisor', tool: 'read_worker', args: { id: 'rem' } });
    expect(tmux.of('capture')).toHaveLength(0);
    expect(remoteCmds().some(s => s.includes('capture-pane'))).toBe(true);
  });

  test('a failed ssh list keeps a live worker as it is; ssh code 255 marks the host offline', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    listCode = 2; listErr = 'tmux: bad socket';
    await expect(r.discoverHost('mac')).rejects.toThrow('could not list');
    expect(r.get('rem')!.status).toBe('idle');
    listCode = 255; listErr = 'ssh: connection reset';
    await expect(r.discoverHost('mac')).rejects.toThrow('could not list');
    expect(hosts.link('mac').state).toBe('error');
    expect(r.get('rem')).toMatchObject({ status: 'stopped', task: 'Host offline' });
    await hosts.link('mac').connect();
    listCode = 1; listErr = 'no server running on /tmp/tmux-1/agent-console';
    await r.discoverHost('mac');
    expect(r.get('rem')).toMatchObject({ status: 'stopped', task: 'Session not running' });
  });

  test('discover() marks workers of a host that is not up as Host offline, and of an unknown host as Host removed', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    await r.spawn({ name: 'Ghost', repo: '/g', host: 'mac' });
    r.get('ghost')!.host = 'gone';
    await hosts.link('mac').disconnect();
    (r as any).state.workers.find((w: any) => w.id === 'rem').status = 'idle';
    await r.discover();
    expect(r.get('rem')).toMatchObject({ status: 'stopped', task: 'Host offline' });
    expect(r.get('ghost')).toMatchObject({ status: 'stopped', task: 'Host removed' });
  });

  test('a stopped worker keeps its task text when the host goes offline', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    r.setStatus('rem', 'stopped', 'Stopped');
    (hosts.link('mac') as any).set('error');
    expect(r.get('rem')!.task).toBe('Stopped');
  });

  test('a worker of an unknown host can be removed and stopped', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    r.get('rem')!.host = 'gone';
    await r.stop('rem');
    await r.remove('rem');
    expect(r.get('rem')).toBeUndefined();
    const warn = r.snapshot().state.activity.filter(a => a.text.includes('may still run'));
    expect(warn).toHaveLength(2);
    expect(warn[0]!.text).toContain('gone');
  });

  test('stop and remove on a known host that is not up are refused; the worker and its session stay', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    (hosts.link('mac') as any).set('error');
    const n = runner.cmds.length;
    await expect(r.stop('rem')).rejects.toThrow('Mac is not connected. Connect the host first.');
    await expect(r.remove('rem')).rejects.toThrow('Mac is not connected. Connect the host first.');
    expect(r.get('rem')).toBeDefined();
    expect(runner.cmds.length).toBe(n);
  });

  test('a host removed from the pool does not throw and marks its workers Host removed', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    const errors: unknown[] = [];
    const onErr = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onErr);
    try {
      hosts.set([{ id: 'off', name: 'Off', ssh: 'off', roots: [] }]);
      await new Promise(res => setTimeout(res, 10));
    } finally { process.off('uncaughtException', onErr); }
    expect(errors).toEqual([]);
    expect(r.get('rem')).toMatchObject({ status: 'stopped', task: 'Host removed' });
  });

  test('a colour change of an up host leaves its workers as they are', async () => {
    const r = mkRemote(); await hosts.link('mac').connect();
    await r.spawn({ name: 'Rem', repo: '/r', host: 'mac' });
    const n = runner.cmds.length;
    await hosts.set([{ ...mac, color: '#00ff00' }, { id: 'off', name: 'Off', ssh: 'off', roots: [] }]);
    await new Promise(res => setTimeout(res, 10));
    expect(r.get('rem')).toMatchObject({ status: 'idle' });
    expect(runner.cmds.length).toBe(n);
  });

  test('a local spawn still has the same newSession args and writes no remote file', async () => {
    const r = mkRemote();
    await r.spawn({ name: 'Loc', repo: '/l' });
    const [name, cwd, env, cmd] = tmux.of('newSession')[0]!.args as [string, string, Record<string, string>, string[]];
    expect([name, cwd, env.AC_URL]).toEqual(['ac-loc', '/l', 'http://x']);
    expect(cmd[1]).toBe('--settings');
    expect(cmd[2]).toContain('/sessions/loc/settings.json');
    expect(runner.cmds).toHaveLength(0);
  });
  describe('shell box', () => {
    const { handleTool } = require('../src/tools') as typeof import('../src/tools');
    const { digestLines } = require('../src/digest') as typeof import('../src/digest');
    const { handleHook } = require('../src/hookserver') as typeof import('../src/hookserver');

    test('openShell starts the login shell through the host tmux, with no --settings', async () => {
      const r = mkRemote(); await hosts.link('mac').connect();
      const w = await r.openShell('mac');
      expect(w).toMatchObject({ id: 'shell-mac', kind: 'shell', role: 'worker', host: 'mac', cwd: '/Users/me', name: 'Shell · Mac', status: 'idle', task: 'Shell' });
      expect(tmux.of('newSession')).toHaveLength(0);
      const c = remoteCmds().find(s => s.includes('new-session'))!;
      expect(c).toContain("'ac-shell-mac'");
      expect(c).toContain("'/bin/zsh' '-l'");
      expect(c).not.toContain('--settings');
      expect(c).not.toContain('AC_TOKEN');
      expect(c).not.toContain('AC_URL');
      expect(remoteCmds().some(s => s.includes('umask 077'))).toBe(false);
      expect((await r.openShell('mac')).id).toBe('shell-mac-2');
    });

    test('openShell falls back to /bin/sh when $SHELL is not an absolute path', async () => {
      const r = mkRemote(); await hosts.link('mac').connect();
      shellOut = 'zsh; rm -rf /';
      await r.openShell('mac');
      expect(remoteCmds().find(s => s.includes('new-session'))!).toContain("'/bin/sh' '-l'");
    });

    test('openShell refuses an unknown host and a host that is not up', async () => {
      const r = mkRemote();
      await expect(r.openShell('nope')).rejects.toThrow('unknown host');
      await expect(r.openShell('off')).rejects.toThrow('Off is not connected');
      expect(r.workers()).toHaveLength(0);
    });

    test('openShell does not link the shell to the advisor', async () => {
      const r = mkRemote(); await hosts.link('mac').connect();
      await ensureAdvisor(r, { ...loadConfig(), advisorCwd: '/r' });
      await r.openShell('mac');
      await ensureAdvisor(r, { ...loadConfig(), advisorCwd: '/r' }); // links every worker except a shell
      expect(r.links().some(l => l.a === 'shell-mac' || l.b === 'shell-mac')).toBe(false);
    });

    test('send_message to a shell is refused', async () => {
      const r = mkRemote(); await hosts.link('mac').connect();
      await r.spawn({ name: 'Nova', repo: '/r' });
      await r.openShell('mac');
      r.connect('nova', 'shell-mac', 'you');
      const res = await handleTool(r, tmux.asTmux(), { caller: 'nova', tool: 'send_message', args: { to: 'shell-mac', text: 'hi' } });
      expect(res).toEqual({ ok: false, error: 'shell boxes take input only from you' });
    });

    test('send_to_worker, read_worker and interrupt_worker refuse a shell', async () => {
      const r = mkRemote(); await hosts.link('mac').connect();
      await ensureAdvisor(r, { ...loadConfig(), advisorCwd: '/r' });
      await r.openShell('mac');
      const call = (tool: string, args: any) => handleTool(r, tmux.asTmux(), { caller: 'advisor', tool, args });
      expect(await call('send_to_worker', { id: 'shell-mac', text: 'ls' })).toEqual({ ok: false, error: 'shell boxes take input only from you' });
      expect(await call('read_worker', { id: 'shell-mac' })).toEqual({ ok: false, error: 'shell boxes are private to you' });
      expect(await call('interrupt_worker', { id: 'shell-mac' })).toEqual({ ok: false, error: 'shell boxes take input only from you' });
    });

    test('connect to a shell is refused, and deliver refuses a shell for any sender but you', async () => {
      const r = mkRemote(); await hosts.link('mac').connect();
      await ensureAdvisor(r, { ...loadConfig(), advisorCwd: '/r' });
      await r.spawn({ name: 'Nova', repo: '/r' });
      await r.openShell('mac');
      expect(await handleTool(r, tmux.asTmux(), { caller: 'advisor', tool: 'connect', args: { a: 'nova', b: 'shell-mac' } }))
        .toEqual({ ok: false, error: 'shell boxes take input only from you' });
      await expect(r.deliver('nova', 'shell-mac', 'x')).rejects.toThrow('shell boxes take input only from you');
      await expect(r.deliver('advisor', 'shell-mac', 'x')).rejects.toThrow('shell boxes take input only from you');
    });

    test('list_connections leaves shells out', async () => {
      const r = mkRemote(); await hosts.link('mac').connect();
      await r.spawn({ name: 'Nova', repo: '/r' });
      await r.spawn({ name: 'Pal', repo: '/r' });
      await r.openShell('mac');
      r.connect('nova', 'shell-mac', 'you'); r.connect('nova', 'pal', 'you');
      const res = await handleTool(r, tmux.asTmux(), { caller: 'nova', tool: 'list_connections' });
      expect(res).toEqual({ ok: true, result: [{ name: 'Pal', host: 'local' }] });
    });

    test('the digest skips shells and hooks for a shell are ignored', async () => {
      const r = mkRemote(); await hosts.link('mac').connect();
      await r.openShell('mac');
      expect(digestLines(r, 0)).toHaveLength(0);
      await handleHook(r, loadConfig(), { event: 'UserPromptSubmit', id: 'shell-mac', payload: { prompt: 'x' } });
      expect(r.get('shell-mac')).toMatchObject({ status: 'idle', task: 'Shell' });
    });

    test('remove kills the tmux session of the shell box on the host', async () => {
      const r = mkRemote(); await hosts.link('mac').connect();
      await r.openShell('mac');
      await r.remove('shell-mac');
      expect(remoteCmds().some(s => s.includes('kill-session') && s.includes('ac-shell-mac'))).toBe(true);
      expect(r.get('shell-mac')).toBeUndefined();
    });
  });
});
