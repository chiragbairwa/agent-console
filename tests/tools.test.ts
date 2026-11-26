import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleTool, TOOLS_BY_ROLE } from '../src/tools';
import { ensureAdvisor, ADVISOR_PROMPT } from '../src/advisor';
import { Registry, linkKey } from '../src/workers';
import { loadConfig } from '../src/store';
import type { Config, StateEvent } from '../src/types';
import { FakeTmux } from './fakes';

let reg: Registry;
let tmux: FakeTmux;
let cfg: Config;
let events: StateEvent[];
let root: string;

beforeEach(async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-tools-'));
  root = mkdtempSync(join(tmpdir(), 'ac-troot-'));
  mkdirSync(join(root, 'Acme.Atlas', '.git'), { recursive: true });
  cfg = { ...loadConfig(), roots: [root], advisorCwd: root };
  tmux = new FakeTmux();
  events = [];
  reg = new Registry(tmux.asTmux(), cfg, { bin: ['/b'], url: 'u', token: 't', inheritedOtelAttrs: '' });
  reg.addEventListener('event', e => events.push((e as CustomEvent<StateEvent>).detail));
  await reg.spawn({ name: 'Advisor', repo: root, role: 'advisor' });
  await reg.spawn({ name: 'Nova', repo: '/r/s' });
  await reg.spawn({ name: 'Web App', repo: '/r/f' });
});

const call = (caller: string, tool: string, args: object = {}) => handleTool(reg, tmux.asTmux(), { caller, tool, args });

describe('handleTool permissions', () => {
  test('a worker cannot use advisor tools', async () => {
    expect((await call('nova', 'list_workers')).ok).toBe(false);
  });

  test('an unknown caller is refused', async () => {
    expect((await call('ghost', 'list_connections')).ok).toBe(false);
  });
});

describe('advisor tools', () => {
  test('list_workers returns workers with status and connections', async () => {
    const r = await call('advisor', 'list_workers');
    expect(r.ok).toBe(true);
    const list = (r as { result: any[] }).result;
    expect(list.map(w => w.id)).toEqual(['nova', 'web-app']);
    expect(list[0]).toMatchObject({ name: 'Nova', status: 'idle', connections: ['Advisor'] });
  });

  test('send_to_worker resolves the name, links, and delivers with a pulse', async () => {
    reg.cut('advisor', 'web-app');
    reg.connect('advisor', 'web-app', 'you');
    const r = await call('advisor', 'send_to_worker', { id: 'Web App', text: 'retest batch 108' });
    expect(r).toEqual({ ok: true, result: 'sent' });
    expect(tmux.of('sendText').at(-1)!.args).toEqual(['ac-web-app', '[from Advisor] retest batch 108']);
    expect(events.some(e => e.t === 'pulse' && e.from === 'advisor' && e.to === 'web-app')).toBe(true);
  });

  test('send_to_worker is refused when the user cut the advisor link', async () => {
    reg.cut('advisor', 'nova');
    const r = await call('advisor', 'send_to_worker', { id: 'nova', text: 'x' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('cut by the user');
  });

  test('read_worker returns the last lines of the screen', async () => {
    expect(await call('advisor', 'read_worker', { id: 'nova', lines: 2 })).toEqual({ ok: true, result: 'line2\nline3\n' });
  });

  test('connect refuses a link the user cut', async () => {
    reg.connect('nova', 'web-app', 'advisor');
    reg.cut('nova', 'web-app');
    const r = await call('advisor', 'connect', { a: 'nova', b: 'web-app' });
    expect((r as { error: string }).error).toContain('cut by the user');
    expect((await call('advisor', 'disconnect', { a: 'advisor', b: 'nova' })).ok).toBe(true);
    expect(reg.linked('advisor', 'nova')).toBe(false);
  });

  test('ask_user creates a question need and returns the answer', async () => {
    const p = call('advisor', 'ask_user', { question: 'Which branch?' });
    await Bun.sleep(5);
    const n = reg.needs()[0]!;
    expect(n).toMatchObject({ kind: 'question', text: 'Which branch?', id: 'advisor' });
    reg.resolveNeed(n.nid, 'answer', 'main');
    expect(await p).toEqual({ ok: true, result: 'main' });
  });

  test('spawn_worker accepts a repo name from the roots', async () => {
    const r = await call('advisor', 'spawn_worker', { name: 'Atlas', repo: 'Acme.Atlas' });
    expect(r.ok).toBe(true);
    expect(reg.get('atlas')!.cwd).toBe(join(root, 'Acme.Atlas'));
  });

  test('stop_worker and interrupt_worker act on the session', async () => {
    await call('advisor', 'interrupt_worker', { id: 'nova' });
    expect(tmux.of('sendKey').at(-1)!.args).toEqual(['ac-nova', 'Escape']);
    await call('advisor', 'stop_worker', { id: 'nova' });
    expect(reg.get('nova')!.status).toBe('stopped');
  });
});

describe('linked sessions', () => {
  test('send_to_worker on a linked card tells the advisor to use SendMessage with the session name', async () => {
    const w = reg.link({ pid: process.pid, sessionId: 's', cwd: '/r/x', name: 'acme-atlas-3f', status: 'idle', startedAt: 1, ancestor: false });
    const r = await call('advisor', 'send_to_worker', { id: w.id, text: 'hi' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('SendMessage');
    expect((r as { error: string }).error).toContain('acme-atlas-3f');
  });

  test('list_workers marks linked cards', async () => {
    reg.link({ pid: process.pid, sessionId: 's', cwd: '/r/x', name: 'ext-one', status: 'idle', startedAt: 1, ancestor: false });
    const list = (await call('advisor', 'list_workers') as { result: any[] }).result;
    expect(list.find(w => w.name === 'ext-one')).toMatchObject({ kind: 'linked' });
  });
});

describe('worker tools', () => {
  test('send_message without a link is refused', async () => {
    const r = await call('nova', 'send_message', { to: 'Web App', text: 'hi' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('ask the advisor');
  });

  test('send_message with a link delivers with a pulse', async () => {
    reg.connect('nova', 'web-app', 'advisor');
    expect(await call('nova', 'send_message', { to: 'web-app', text: 'fix ready' })).toEqual({ ok: true, result: 'sent' });
    expect(tmux.of('sendText').at(-1)!.args).toEqual(['ac-web-app', '[from Nova] fix ready']);
    expect(events.some(e => e.t === 'pulse' && e.from === 'nova' && e.to === 'web-app')).toBe(true);
  });

  test('list_connections names the linked sessions', async () => {
    reg.connect('nova', 'web-app', 'advisor');
    expect(await call('nova', 'list_connections')).toEqual({ ok: true, result: [{ name: 'Advisor', host: 'local' }, { name: 'Web App', host: 'local' }] });
  });

  test('list_connections shows host for each worker', async () => {
    reg.connect('nova', 'web-app', 'advisor');
    reg.get('web-app')!.host = 'mac';
    expect(await call('nova', 'list_connections')).toEqual({ ok: true, result: [{ name: 'Advisor', host: 'local' }, { name: 'Web App', host: 'mac' }] });
  });
});

describe('ensureAdvisor', () => {
  test('connects the advisor to every worker, except cut links', async () => {
    reg.disconnect('advisor', 'nova');
    reg.cut('advisor', 'web-app');
    await ensureAdvisor(reg, cfg);
    expect(reg.linked('advisor', 'nova')).toBe(true);
    expect(reg.links().some(l => linkKey(l.a, l.b) === linkKey('advisor', 'web-app'))).toBe(false);
  });

  test('restarts a stopped advisor instead of making a second one', async () => {
    await reg.stop('advisor');
    await ensureAdvisor(reg, cfg);
    expect(reg.workers().filter(w => w.role === 'advisor').length).toBe(1);
    expect(reg.get('advisor')!.status).not.toBe('stopped');
  });

  test('the role text forbids approving guarded actions', () => {
    expect(ADVISOR_PROMPT).toContain('never approve');
  });
});

describe('agents in tools', () => {
  test('spawn_worker with agent codex', async () => {
    const r = await call('advisor', 'spawn_worker', { name: 'Cx', repo: 'Acme.Atlas', agent: 'codex', options: { reasoning: 'high' } });
    expect(r.ok).toBe(true);
    expect(reg.get('cx')).toMatchObject({ agent: 'codex', options: { reasoning: 'high' } });
    expect((tmux.of('newSession').at(-1)!.args[3] as string[])[0]).toBe('codex');
  });
  test('spawn_worker unknown agent → error lists known ids', async () => {
    const r = await call('advisor', 'spawn_worker', { name: 'X', repo: 'Acme.Atlas', agent: 'nope' });
    expect(r).toEqual({ ok: false, error: 'unknown agent: nope (known: claude, codex)' });
  });
  test('spawn_worker bad option → error', async () => {
    const r = await call('advisor', 'spawn_worker', { name: 'X', repo: 'Acme.Atlas', agent: 'codex', options: { reasoning: 'max' } });
    expect(r.ok).toBe(false);
  });
  test('list_workers shows agent', async () => {
    await call('advisor', 'spawn_worker', { name: 'Cx', repo: 'Acme.Atlas', agent: 'codex' });
    const r = await call('advisor', 'list_workers');
    const items = (r as any).result as { id: string; agent: string }[];
    expect(items.find(w => w.id === 'nova')!.agent).toBe('claude');
    expect(items.find(w => w.id === 'cx')!.agent).toBe('codex');
  });
});

describe('reviewer role', () => {
  // Every tool of every role that the reviewer does not have.
  const FORBIDDEN = [...new Set(Object.values(TOOLS_BY_ROLE).flat())].filter(t => !TOOLS_BY_ROLE.reviewer.includes(t));

  test('the reviewer is refused every worker-changing tool', async () => {
    await reg.addReviewer('claude');
    for (const tool of FORBIDDEN) {
      const r = await call('reviewer', tool, { id: 'nova', a: 'nova', b: 'web-app', text: 'x', question: 'q', name: 'n', repo: root });
      expect(r).toEqual({ ok: false, error: `${tool} is not allowed for the reviewer` });
    }
    expect(reg.linked('reviewer', 'nova')).toBe(false);
  });

  test('the reviewer can list and read workers, and the lists hide the lead and the reviewer', async () => {
    await reg.addReviewer('claude');
    const r = await call('reviewer', 'list_workers');
    expect((r as { result: any[] }).result.map(w => w.id)).toEqual(['nova', 'web-app']);
    expect((await call('reviewer', 'read_worker', { id: 'nova' })).ok).toBe(true);
  });

  test('the lead connect tool refuses a reviewer-worker pair with the right reason', async () => {
    await reg.addReviewer('claude');
    expect(await call('advisor', 'connect', { a: 'reviewer', b: 'nova' }))
      .toEqual({ ok: false, error: 'the reviewer links only to the advisor' });
    expect(await call('advisor', 'connect', { a: 'nova', b: 'reviewer' }))
      .toEqual({ ok: false, error: 'the reviewer links only to the advisor' });
    expect(reg.linked('reviewer', 'nova')).toBe(false);
  });

  test('send_to_worker refuses the reviewer and the lead as targets', async () => {
    await reg.addReviewer('claude');
    expect((await call('advisor', 'send_to_worker', { id: 'reviewer', text: 'x' })).ok).toBe(false);
    expect((await call('advisor', 'send_to_worker', { id: 'advisor', text: 'x' })).ok).toBe(false);
    expect(tmux.of('sendText').some(c => String(c.args[1]).includes('x'))).toBe(false);
  });

  test('advise delivers to the lead with the prefix and logs activity', async () => {
    await reg.addReviewer('claude');
    const r = await call('reviewer', 'advise', { text: 'check the tests' });
    expect(r).toEqual({ ok: true, result: 'sent' });
    expect(JSON.stringify(tmux.of('sendText'))).toContain('[from Reviewer] check the tests');
    expect(JSON.stringify(events)).toContain('Reviewer → Advisor: check the tests');
  });

  test('advise is for the reviewer only', async () => {
    expect((await call('nova', 'advise', { text: 'x' })).ok).toBe(false);
    expect(((await call('advisor', 'advise', { text: 'x' })) as { error: string }).error).toBe('advise is not allowed for the advisor');
  });

  test('ask_second_opinion delivers to the reviewer', async () => {
    await reg.addReviewer('claude');
    const r = await call('advisor', 'ask_second_opinion', { text: 'is this safe?' });
    expect(r).toEqual({ ok: true, result: 'asked' });
    expect(JSON.stringify(tmux.of('sendText'))).toContain('[from Advisor] is this safe?');
    expect(JSON.stringify(events)).toContain('Advisor → Reviewer: is this safe?');
  });

  test('ask_second_opinion without a reviewer is an error', async () => {
    const r = await call('advisor', 'ask_second_opinion', { text: 'x' });
    expect(r).toEqual({ ok: false, error: 'No reviewer. The user can add one in the advisor menu.' });
  });

  test('send_to_worker hint depends on the target role', async () => {
    await reg.addReviewer('claude');
    expect(await call('advisor', 'send_to_worker', { id: 'advisor', text: 'x' })).toEqual({ ok: false, error: 'The advisor is not a worker.' });
    expect(await call('advisor', 'send_to_worker', { id: 'reviewer', text: 'x' }))
      .toEqual({ ok: false, error: 'The reviewer is not a worker. Use ask_second_opinion.' });
  });

  test('ask_second_opinion returns asked (queued) when the reviewer is busy', async () => {
    await reg.addReviewer('claude');
    reg.toolStart('reviewer');
    expect(await call('advisor', 'ask_second_opinion', { text: 'later' })).toEqual({ ok: true, result: 'asked (queued)' });
  });

  test('a cut lead-reviewer link stops advise and ask_second_opinion', async () => {
    await reg.addReviewer('claude');
    reg.cut('advisor', 'reviewer');
    const msg = 'The user cut the link between the advisor and the reviewer.';
    expect(await call('reviewer', 'advise', { text: 'x' })).toEqual({ ok: false, error: msg });
    expect(await call('advisor', 'ask_second_opinion', { text: 'x' })).toEqual({ ok: false, error: msg });
    expect(tmux.of('sendText').length).toBe(0);
  });

  test('a worker named Reviewer does not block the seat tools', async () => {
    await reg.spawn({ name: 'Reviewer', repo: '/r/x' });
    expect(await call('advisor', 'ask_second_opinion', { text: 'x' })).toMatchObject({ ok: false });
    await reg.addReviewer('claude');
    expect(await call('advisor', 'ask_second_opinion', { text: 'x' })).toEqual({ ok: true, result: 'asked' });
    expect(tmux.of('sendText').at(-1)!.args[0]).toBe('ac-reviewer');
  });

  test('a worker cannot use ask_second_opinion', async () => {
    expect(((await call('nova', 'ask_second_opinion', { text: 'x' })) as { error: string }).error).toBe('ask_second_opinion is not allowed for the worker');
  });
});
