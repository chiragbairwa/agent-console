import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { startServer } from '../src/server';
import { Registry } from '../src/workers';
import { loadConfig } from '../src/store';
import type { StateEvent } from '../src/types';
import { FakeTmux, START_OK } from './fakes';
import { HostPool } from '../src/hostpool';

const TOKEN = 'a'.repeat(64);
let server: Server<unknown>;
let reg: Registry;
let tmux: FakeTmux;
let base: string;
let root: string;
let sessionsDir: string;

beforeEach(async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-srv-'));
  root = mkdtempSync(join(tmpdir(), 'ac-root-'));
  mkdirSync(join(root, 'RepoA', '.git'), { recursive: true });
  mkdirSync(join(root, 'NotRepo'));
  sessionsDir = mkdtempSync(join(tmpdir(), 'ac-sess-'));
  writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'ext-1', cwd: '/r/Acme.Atlas', name: 'atlas-tab', status: 'busy', kind: 'interactive', startedAt: 1, procStart: '1' }));
  const cfg = { ...loadConfig(), roots: [root] };
  tmux = new FakeTmux();
  reg = new Registry(tmux.asTmux(), cfg, { bin: ['/b'], url: 'u', token: TOKEN, inheritedOtelAttrs: '', ...START_OK, sessionsDir, alive: () => true, ancestors: [], procStartOf: () => '1', cmdlineOf: () => 'claude' });
  await reg.spawn({ name: 'Nova', repo: join(root, 'RepoA') });
  server = startServer({ reg, cfg, token: TOKEN, port: 0, tmux: tmux.asTmux() });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => server.stop(true));

const auth = { 'x-ac-token': TOKEN };

describe('POST /api/workers allow-list', () => {
  test('a body beforeStart is ignored', async () => {
    const seen: any[] = [];
    const orig = reg.spawn.bind(reg);
    reg.spawn = (async (i: any) => { seen.push(i); return orig(i); }) as typeof reg.spawn;
    const r = await fetch(`${base}/api/workers`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Zed', repo: join(root, 'RepoA'), beforeStart: 'x', evil: 1 }) });
    expect(r.status).toBe(200);
    expect(seen[0]).not.toHaveProperty('beforeStart');
    expect(seen[0]).not.toHaveProperty('evil');
    expect(seen[0].role).toBe('worker');
  });
});

describe('server auth', () => {
  test('no token → 403', async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(403);
  });

  test('foreign Origin → 403 even with a token', async () => {
    expect((await fetch(`${base}/api/state`, { headers: { ...auth, origin: 'http://evil.example' } })).status).toBe(403);
  });

  test('foreign Host → 403 even with a token', async () => {
    expect((await fetch(`${base}/api/state`, { headers: { ...auth, host: `evil.example:${server.port}` } })).status).toBe(403);
  });

  test('GET /?token= sets an HttpOnly strict cookie and redirects to the app', async () => {
    const r = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/app');
    expect(r.headers.get('set-cookie')).toContain(`ac_token=${TOKEN}`);
    expect(r.headers.get('set-cookie')).toContain('HttpOnly');
    expect(r.headers.get('set-cookie')).toContain('SameSite=Strict');
  });

  test('GET / with a bad token → 403', async () => {
    expect((await fetch(`${base}/?token=nope`, { redirect: 'manual' })).status).toBe(403);
  });

  test('the cookie authorises API calls', async () => {
    expect((await fetch(`${base}/api/state`, { headers: { cookie: `ac_token=${TOKEN}` } })).status).toBe(200);
  });
});

describe('server API', () => {
  test('GET /api/agents lists claude then codex with caps and options', async () => {
    const a = await (await fetch(`${base}/api/agents`, { headers: auth })).json() as any[];
    expect(a.map(x => x.id)).toEqual(['claude', 'codex']);
    expect(Object.keys(a[1])).toEqual(['id', 'label', 'icon', 'color', 'caps', 'options']);
    expect(a[1].caps.guard).toBe(true);
    expect(a[1].options.map((o: any) => o.key)).toEqual(['model', 'reasoning']);
  });

  test('POST /api/workers rejects agent "nope" with 400 and starts no session', async () => {
    const n = tmux.of('newSession').length;
    const r = await fetch(`${base}/api/workers`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'X', repo: join(root, 'RepoA'), agent: 'nope' }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain('unknown agent: nope');
    expect(tmux.of('newSession').length).toBe(n);
  });

  test('POST /api/workers rejects reasoning "max" with 400', async () => {
    const r = await fetch(`${base}/api/workers`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'X', repo: join(root, 'RepoA'), agent: 'codex', options: { reasoning: 'max' } }) });
    expect(r.status).toBe(400);
  });

  test('POST /api/workers with agent codex starts tmux with a codex command', async () => {
    const r = await fetch(`${base}/api/workers`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Cx', repo: join(root, 'RepoA'), agent: 'codex', options: { model: 'm1' } }) });
    expect(r.status).toBe(200);
    const cmd = tmux.of('newSession').at(-1)!.args[3] as string[];
    expect(cmd[0]).toBe('codex');
    expect(cmd).toContain('model="m1"');
  });

  test('POST /api/workers with defaultWorkerAgent codex accepts codex options', async () => {
    reg.config().defaultWorkerAgent = 'codex';
    const r = await fetch(`${base}/api/workers`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Dx', repo: join(root, 'RepoA'), options: { reasoning: 'high' } }) });
    expect(r.status).toBe(200);
    expect(reg.get('dx')!.agent).toBe('codex');
    expect((tmux.of('newSession').at(-1)!.args[3] as string[])[0]).toBe('codex');
  });

  test('POST /api/workers with an unknown defaultWorkerAgent → 400, no session', async () => {
    reg.config().defaultWorkerAgent = 'nope';
    const n = tmux.of('newSession').length;
    const r = await fetch(`${base}/api/workers`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Dx', repo: join(root, 'RepoA'), worktree: { branch: 'fix/x' } }) });
    expect(r.status).toBe(400);
    expect(tmux.of('newSession').length).toBe(n);
  });

  test('POST /api/workers with a non-string agent → 400', async () => {
    const r = await fetch(`${base}/api/workers`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Dx', repo: join(root, 'RepoA'), agent: 5 }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe('agent must be a string');
  });

  test('GET /api/state returns a snapshot', async () => {
    const s = await (await fetch(`${base}/api/state`, { headers: auth })).json() as StateEvent;
    expect(s.t).toBe('snapshot');
    expect(s.t === 'snapshot' && s.state.workers.map(w => w.id)).toEqual(['nova']);
  });

  test('GET /api/repos lists git repos one level under the roots', async () => {
    const r = await (await fetch(`${base}/api/repos`, { headers: auth })).json() as { repos: { name: string; path: string }[] };
    expect(r.repos).toEqual([{ name: 'RepoA', path: join(root, 'RepoA') }]);
  });

  test('POST /api/hook routes to the hook handler', async () => {
    const r = await fetch(`${base}/api/hook`, { method: 'POST', headers: auth, body: JSON.stringify({ event: 'UserPromptSubmit', id: 'nova', payload: { prompt: 'do x' } }) });
    expect(r.status).toBe(200);
    expect(reg.get('nova')).toMatchObject({ status: 'running', task: 'do x' });
  });

  test('POST /api/send types into the resolved worker', async () => {
    await fetch(`${base}/api/send`, { method: 'POST', headers: auth, body: JSON.stringify({ targets: ['Nova'], text: 'run tests', via: 'you' }) });
    expect(tmux.of('sendText').at(-1)!.args).toEqual(['ac-nova', 'run tests']);
  });

  test('POST /api/send to an unknown target → 404', async () => {
    const r = await fetch(`${base}/api/send`, { method: 'POST', headers: auth, body: JSON.stringify({ targets: ['zzz'], text: 'x', via: 'you' }) });
    expect(r.status).toBe(404);
  });

  test('POST /api/workers/:id/move saves the position', async () => {
    await fetch(`${base}/api/workers/nova/move`, { method: 'POST', headers: auth, body: JSON.stringify({ x: 5, y: 6 }) });
    expect(reg.get('nova')).toMatchObject({ x: 5, y: 6 });
  });

  const resize = (id: string, body: unknown) =>
    fetch(`${base}/api/workers/${id}/resize`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

  test('resize clamps and saves w/h', async () => {
    expect((await resize('nova', { w: 800.6, h: 500.2 })).status).toBe(200);
    expect(reg.get('nova')).toMatchObject({ w: 801, h: 500 });
    await resize('nova', { w: 10, h: 99999 });
    expect(reg.get('nova')).toMatchObject({ w: 360, h: 1600 });
    await resize('nova', { w: 99999, h: 10 });
    expect(reg.get('nova')).toMatchObject({ w: 2400, h: 220 });
  });

  test('resize reset removes w/h', async () => {
    await resize('nova', { w: 800, h: 500 });
    expect((await resize('nova', { reset: true })).status).toBe(200);
    const w = reg.get('nova')!;
    expect('w' in w).toBe(false);
    expect('h' in w).toBe(false);
  });

  test('resize with non-numbers → 400', async () => {
    expect((await resize('nova', { w: 'big', h: 500 })).status).toBe(400);
    expect((await resize('nova', { w: 800 })).status).toBe(400);
    expect((await resize('nova', { w: Infinity, h: null })).status).toBe(400);
    expect(reg.get('nova')!.w).toBeUndefined();
  });

  test('resize unknown worker → 404', async () => {
    expect((await resize('nobody', { w: 800, h: 500 })).status).toBe(404);
  });

  test('POST /api/needs/:nid resolves a need', async () => {
    const n = reg.addNeed({ id: 'nova', kind: 'guard', text: 'x' });
    const p = reg.waitNeed(n.nid, 2000);
    await fetch(`${base}/api/needs/${n.nid}`, { method: 'POST', headers: auth, body: JSON.stringify({ decision: 'deny' }) });
    expect((await p).decision).toBe('deny');
  });

  test('WS /ws/state sends a snapshot first, then live events', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/state?token=${TOKEN}`);
    const got: StateEvent[] = [];
    ws.onmessage = e => got.push(JSON.parse(String(e.data)));
    await new Promise(r => (ws.onopen = r));
    await Bun.sleep(50);
    reg.setStatus('nova', 'done');
    await Bun.sleep(100);
    ws.close();
    expect(got[0]!.t).toBe('snapshot');
    expect(got.some(e => e.t === 'worker' && e.worker.status === 'done')).toBe(true);
  });

  test('terminal bytes alone do not count as typing; the typing frame does', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/term/nova?token=${TOKEN}`);
    await new Promise(r => (ws.onopen = r));
    ws.send(new TextEncoder().encode('\x1b[?1;2c')); // an automatic terminal reply
    await Bun.sleep(50);
    expect(reg.get('nova')!.lastUserInputAt).toBeUndefined();
    ws.send('{"typing":1}');
    await Bun.sleep(50);
    expect(reg.get('nova')!.lastUserInputAt).toBeNumber();
    ws.close();
  });

  test('GET /api/external lists outside sessions', async () => {
    const r = await (await fetch(`${base}/api/external`, { headers: auth })).json() as { sessions: any[] };
    expect(r.sessions).toEqual([{ pid: process.pid, sessionId: 'ext-1', cwd: '/r/Acme.Atlas', name: 'atlas-tab', status: 'busy', startedAt: 1, ancestor: false, known: false }]);
  });

  test('POST /api/external/:pid link adds a linked card; sending to it is refused with 409', async () => {
    const r = await fetch(`${base}/api/external/${process.pid}`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'link' }) });
    expect(r.status).toBe(200);
    expect(reg.get('atlas-tab')).toMatchObject({ kind: 'linked', status: 'running' });
    const s = await fetch(`${base}/api/send`, { method: 'POST', headers: auth, body: JSON.stringify({ targets: ['atlas-tab'], text: 'x', via: 'you' }) });
    expect(s.status).toBe(409);
    const t = await (await fetch(`${base}/api/workers/atlas-tab/transcript`, { headers: auth })).json() as { messages: unknown[] };
    expect(t.messages).toEqual([]);
  });

  test('POST /api/external/:pid for an unknown pid → 404', async () => {
    expect((await fetch(`${base}/api/external/1`, { method: 'POST', headers: auth, body: '{"mode":"link"}' })).status).toBe(404);
  });

  test('WS without a token is refused', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/state`);
    const ok = await new Promise(r => { ws.onopen = () => r(true); ws.onerror = () => r(false); ws.onclose = () => r(false); });
    expect(ok).toBe(false);
  });
});

describe('MCP over HTTP (/mcp)', () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  async function client(id: string, token = TOKEN) {
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'x-ac-token': token, 'x-ac-id': id } } }));
    return c;
  }

  test('a worker lists its two tools and calls one, in the server process', async () => {
    const c = await client('nova');
    expect((await c.listTools()).tools.map((t: { name: string }) => t.name).sort()).toEqual(['list_connections', 'send_message']);
    const r = await c.callTool({ name: 'list_connections', arguments: {} });
    expect(r.isError).toBeFalsy();
    await c.close();
  });

  test('the advisor gets the advisor tools', async () => {
    await reg.spawn({ name: 'Advisor', repo: join(root, 'RepoA'), role: 'advisor' });
    const c = await client('advisor');
    const names = (await c.listTools()).tools.map((t: { name: string }) => t.name);
    expect(names).toContain('spawn_worker');
    const r = await c.callTool({ name: 'list_workers', arguments: {} });
    expect(JSON.stringify(r.content)).toContain('Nova');
    await c.close();
  });

  test('no token → 403; unknown session id → 404', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...h, 'x-ac-id': 'nova' }, body })).status).toBe(403);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...h, ...auth, 'x-ac-id': 'nobody' }, body })).status).toBe(404);
  });
});

describe('HTTP hooks (/hook/<Event>)', () => {
  const post = (event: string, payload: object, h: Record<string, string> = { ...auth, 'x-ac-id': 'nova' }) =>
    fetch(`${base}/hook/${event}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(payload) });

  test('an event updates the worker, the same as the old command hook', async () => {
    const r = await post('UserPromptSubmit', { prompt: 'fix the bug' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
    expect(reg.get('nova')).toMatchObject({ status: 'running', task: 'fix the bug' });
  });

  test('a guarded Bash command waits for the user; Deny comes back as the hook output', async () => {
    const pending = post('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
    let need; for (let i = 0; i < 50 && !need; i++) { await Bun.sleep(10); need = reg.needs().find(n => n.kind === 'guard'); }
    expect(need).toBeDefined();
    reg.resolveNeed(need!.nid, 'deny');
    const out = await (await pending).json() as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('POST /hook/PreToolUse for a worker with an unknown agent → 200 and {}', async () => {
    reg.update('nova', { agent: 'nope' });
    const r = await post('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
  });

  test('no token → 403; health answers with a token', async () => {
    expect((await post('Stop', {}, { 'x-ac-id': 'nova' })).status).toBe(403);
    expect(await (await fetch(`${base}/api/health`, { headers: auth })).json()).toEqual({ ok: true });
  });
});

describe('app window files', () => {
  test('manifest and icon need no token (Chrome fetches them without cookies)', async () => {
    const m = await fetch(`${base}/manifest.webmanifest`);
    expect(m.status).toBe(200);
    expect((await m.json()).name).toBe('Agent Console');
    const i = await fetch(`${base}/icon.svg`);
    expect(i.headers.get('content-type')).toBe('image/svg+xml');
  });

  test('a foreign Host still gets 403', async () => {
    expect((await fetch(`${base}/icon.svg`, { headers: { host: `evil.example:${server.port}` } })).status).toBe(403);
  });
});

describe('POST /api/advisor', () => {
  const post = (body: unknown) => fetch(`${base}/api/advisor`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('POST /api/advisor codex → 200', async () => {
    await reg.spawn({ name: 'Advisor', repo: join(root, 'RepoA'), role: 'advisor' });
    const r = await post({ agent: 'codex' });
    expect(r.status).toBe(200);
    expect((await r.json() as { agent: string }).agent).toBe('codex');
  });

  test('POST /api/advisor nope → 400 and no kill', async () => {
    await reg.spawn({ name: 'Advisor', repo: join(root, 'RepoA'), role: 'advisor' });
    const r = await post({ agent: 'nope' });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain('unknown agent');
    expect(tmux.of('kill').length).toBe(0);
  });

  test('POST /api/advisor 5 → 400 agent must be a string', async () => {
    await reg.spawn({ name: 'Advisor', repo: join(root, 'RepoA'), role: 'advisor' });
    const r = await post({ agent: 5 });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'agent must be a string' });
  });

  test('POST /api/advisor with no advisor → 404', async () => {
    expect((await post({ agent: 'codex' })).status).toBe(404);
  });
});

describe('reviewer routes', () => {
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const addLead = () => reg.spawn({ name: 'Advisor', repo: join(root, 'RepoA'), role: 'advisor' });

  test('POST /api/reviewer: no advisor → 404; bad agent → 400; ok → 200; second → 400', async () => {
    expect((await post('/api/reviewer', { agent: 'codex' })).status).toBe(404);
    await addLead();
    expect((await post('/api/reviewer', { agent: 5 })).status).toBe(400);
    expect((await post('/api/reviewer', { agent: 'nope' })).status).toBe(400);
    const ok = await post('/api/reviewer', { agent: 'codex' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: 'reviewer', role: 'reviewer', agent: 'codex' });
    expect((await post('/api/reviewer', { agent: 'claude' })).status).toBe(400);
  });

  test('POST /api/reviewer/remove: none → 404; ok → 200', async () => {
    await addLead();
    expect((await post('/api/reviewer/remove')).status).toBe(404);
    await post('/api/reviewer', { agent: 'codex' });
    expect((await post('/api/reviewer/remove')).status).toBe(200);
    expect(reg.get('reviewer')).toBeUndefined();
  });

  test('POST /api/reviewer/swap-roles: none → 404; ok → 200 { advisor, reviewer }; busy → 400', async () => {
    await addLead();
    expect((await post('/api/reviewer/swap-roles')).status).toBe(404);
    await post('/api/reviewer', { agent: 'codex' });
    const r = await post('/api/reviewer/swap-roles');
    expect(r.status).toBe(200);
    const j = await r.json() as { advisor: { agent: string }; reviewer: { agent: string } };
    expect(j.advisor.agent).toBe('codex');
    expect(j.reviewer.agent).toBe('claude');
    const orig = tmux.newSession.bind(tmux);
    let release!: () => void;
    tmux.newSession = async (...a: Parameters<typeof orig>) => { await new Promise<void>(res => { release = res; }); return orig(...a); };
    const first = post('/api/reviewer/swap-roles');
    await new Promise(res => setTimeout(res, 50));
    const second = await post('/api/reviewer/swap-roles');
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'a swap is already running' });
    release();
    await new Promise(res => setTimeout(res, 20));
    release();
    expect((await first).status).toBe(200);
  });

  test('POST /api/links reviewer–worker → 409; reviewer–advisor still 200', async () => {
    await addLead();
    await post('/api/reviewer', { agent: 'codex' });
    const r = await post('/api/links', { a: 'reviewer', b: 'nova' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'the reviewer links only to the advisor' });
    expect(reg.linked('reviewer', 'nova')).toBe(false);
    expect((await post('/api/links', { a: 'reviewer', b: 'advisor' })).status).toBe(200);
    expect((await post('/api/links', { a: 'nova', b: 'advisor' })).status).toBe(200);
  });

  test('POST /api/workers ignores body.role: workers only', async () => {
    const r = await post('/api/workers', { name: 'Sneaky', repo: join(root, 'RepoA'), role: 'reviewer' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ role: 'worker', id: 'sneaky' });
    expect(reg.reviewer()).toBeUndefined();
  });

  test('POST /api/tool: the reviewer cannot call send_to_worker', async () => {
    await addLead();
    await post('/api/reviewer', { agent: 'codex' });
    const r = await post('/api/tool', { caller: 'reviewer', tool: 'send_to_worker', args: { id: 'nova', text: 'x' } });
    expect(await r.json()).toEqual({ ok: false, error: 'send_to_worker is not allowed for the reviewer' });
  });

  test('restart and stop of a seat during a swap → 409', async () => {
    await addLead();
    await post('/api/reviewer', { agent: 'codex' });
    const orig = tmux.newSession.bind(tmux);
    let release!: () => void;
    tmux.newSession = async (...a: Parameters<typeof orig>) => { await new Promise<void>(res => { release = res; }); return orig(...a); };
    const swap = reg.swapSeat('reviewer', 'claude');
    await new Promise(res => setTimeout(res, 20));
    for (const act of ['restart', 'stop']) {
      const r = await post(`/api/workers/reviewer/${act}`);
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: 'a swap is already running' });
    }
    release();
    await swap;
  });

  test('POST /api/workers/reviewer/remove during a reviewer swap → 409; the worker stays', async () => {
    await addLead();
    await post('/api/reviewer', { agent: 'codex' });
    const orig = tmux.newSession.bind(tmux);
    let release!: () => void;
    tmux.newSession = async (...a: Parameters<typeof orig>) => { await new Promise<void>(res => { release = res; }); return orig(...a); };
    const swap = reg.swapSeat('reviewer', 'claude');
    await new Promise(res => setTimeout(res, 20));
    const r = await post('/api/workers/reviewer/remove');
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'a swap is already running' });
    release();
    await swap;
    expect(reg.get('reviewer')).toBeDefined();
    expect([...tmux.sessions].filter(n => n === 'ac-reviewer').length).toBe(1);
  });
});

describe('hostOk with tunnel ports', () => {
  let s2: Server<unknown>;
  afterEach(() => s2.stop(true));
  const start = () => {
    const hosts = new HostPool([{ id: 'mac', name: 'Mac', ssh: 'mac', roots: [], tunnelPort: 17878 }], { consolePort: 1, sockDir: '/tmp/ac-srv-hp' });
    s2 = startServer({ reg, cfg: loadConfig(), token: TOKEN, port: 0, tmux: tmux.asTmux(), hosts });
    return `http://127.0.0.1:${s2.port}`;
  };
  test('accepts 127.0.0.1:17878 when a host has that tunnelPort, with the token', async () => {
    const b = start();
    expect((await fetch(`${b}/api/state`, { headers: { ...auth, host: '127.0.0.1:17878' } })).status).toBe(200);
    expect((await fetch(`${b}/api/state`, { headers: { ...auth, host: '127.0.0.1:17878', origin: 'http://127.0.0.1:17878' } })).status).toBe(200);
  });
  test('refuses 127.0.0.1:17878 without the token', async () => {
    const b = start();
    expect((await fetch(`${b}/api/state`, { headers: { host: '127.0.0.1:17878' } })).status).toBe(403);
  });
  test('refuses 127.0.0.1:9999 (no host has it)', async () => {
    const b = start();
    expect((await fetch(`${b}/api/state`, { headers: { ...auth, host: '127.0.0.1:9999' } })).status).toBe(403);
  });
});

describe('remote host routes', () => {
  let s2: Server<unknown>;
  let seen: string[];
  afterEach(() => s2.stop(true));
  const start = async () => {
    seen = [];
    const spawn = async (cmd: string[]) => {
      const last = cmd.at(-1) ?? '';
      if (cmd[0] !== 'ssh') return { out: '', err: '', code: 0 };
      if (last.includes('HOME')) return { out: '/Users/me', err: '', code: 0 };
      if (last.includes('connected')) return { out: 'ok\n', err: '', code: 0 };
      seen.push(last);
      if (last.includes("'find'")) return { out: '/Users/me/code/app/.git\n', err: '', code: 0 };
      if (last.includes('--show-current')) return { out: 'main\n', err: '', code: 0 };
      if (last.includes('refs/heads')) return { out: 'main\n', err: '', code: 0 };
      if (last.includes('refs/remotes')) return { out: 'origin/main\n', err: '', code: 0 };
      if (last.includes("'ls'")) return { out: './\n../\nsub/\n', err: '', code: 0 };
      return { out: 'ok\n', err: '', code: 0 };
    };
    const hosts = new HostPool([{ id: 'mac', name: 'Mac', ssh: 'mac', roots: ['~/code'] }, { id: 'off', name: 'Off', ssh: 'off', roots: [] }], { consolePort: 1, sockDir: '/tmp/ac-srv-rt', spawn });
    await hosts.link('mac').connect();
    s2 = startServer({ reg, cfg: { ...loadConfig(), roots: [] }, token: TOKEN, port: 0, tmux: tmux.asTmux(), hosts });
    return `http://127.0.0.1:${s2.port}`;
  };
  test('GET /api/repos?host=mac lists repos from the mac roots', async () => {
    const b = await start();
    const j = await (await fetch(`${b}/api/repos?host=mac`, { headers: auth })).json() as any;
    expect(j.repos).toEqual([{ name: 'app', path: '/Users/me/code/app' }]);
    expect(Array.isArray(j.templates)).toBe(true);
  });
  test('GET /api/branches?host=mac&path=/r runs git -C /r through ssh', async () => {
    const b = await start();
    const j = await (await fetch(`${b}/api/branches?host=mac&path=${encodeURIComponent('/r')}`, { headers: auth })).json() as any;
    expect(j).toEqual({ current: 'main', local: ['main'], remote: ['origin/main'] });
    expect(seen.some(s => s.includes(`'git' '-C' '/r'`))).toBe(true);
  });
  test('GET /api/dirs?host=mac lists remote folders', async () => {
    const b = await start();
    const j = await (await fetch(`${b}/api/dirs?host=mac&path=${encodeURIComponent('/Users/me')}`, { headers: auth })).json() as any;
    expect(j.dirs.map((d: { name: string }) => d.name)).toEqual(['sub']);
  });
  test('a repo path with a space and $(x) reaches the host as one literal argument', async () => {
    const b = await start();
    await fetch(`${b}/api/branches?host=mac&path=${encodeURIComponent('/r/my repo $(x)')}`, { headers: auth });
    expect(seen.some(s => s.includes(`'-C' '/r/my repo $(x)'`))).toBe(true);
  });
  test('?host=nope → 404 unknown host, for all three routes', async () => {
    const b = await start();
    for (const r of ['repos', 'dirs', 'branches']) {
      const res = await fetch(`${b}/api/${r}?host=nope&path=/r`, { headers: auth });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'unknown host' });
    }
  });
  test('?host=off (known, not up) → 409 Off is not connected', async () => {
    const b = await start();
    const res = await fetch(`${b}/api/repos?host=off`, { headers: auth });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Off is not connected' });
  });
  test('?host=local behaves as today', async () => {
    const b = await start();
    const res = await fetch(`${b}/api/repos?host=local`, { headers: auth });
    expect(res.status).toBe(200);
  });
});

describe('host api', () => {
  let s2: Server<unknown>;
  let b2: string;
  afterEach(() => s2.stop(true));
  const start = async () => {
    const spawn = async (cmd: string[]) => {
      if (cmd[0] !== 'ssh') return { out: '', err: '', code: 0 };
      const last = cmd.at(-1) ?? '';
      if (last.includes('HOME')) return { out: '/Users/me', err: '', code: 0 };
      return { out: 'ok\n', err: '', code: 0 };
    };
    const hosts = new HostPool([{ id: 'mac', name: 'Mac', ssh: 'mac', roots: [] }], { consolePort: 1, sockDir: '/tmp/ac-srv-api', spawn });
    s2 = startServer({ reg, cfg: { ...loadConfig(), roots: [] }, token: TOKEN, port: 0, tmux: tmux.asTmux(), hosts });
    b2 = `http://127.0.0.1:${s2.port}`;
    return hosts;
  };
  const post = (path: string, body: unknown) => fetch(`${b2}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

  test('GET /api/hosts returns state and worker count', async () => {
    await start();
    reg.get('nova')!.host = 'mac';
    const j = await (await fetch(`${b2}/api/hosts`, { headers: auth })).json() as any;
    expect(j.hosts).toHaveLength(1);
    expect(j.hosts[0]).toMatchObject({ id: 'mac', name: 'Mac', state: 'down', workers: 1 });
  });
  test('POST /api/hosts/<id>/shell: unknown host is 404, a down host is 409', async () => {
    const hosts = await start();
    const reg2 = new Registry(tmux.asTmux(), { ...loadConfig(), roots: [] }, { bin: ['/b'], url: 'u', token: TOKEN, inheritedOtelAttrs: '', ...START_OK, sessionsDir, alive: () => true, ancestors: [], procStartOf: () => '1', cmdlineOf: () => 'claude', hosts });
    s2.stop(true);
    s2 = startServer({ reg: reg2, cfg: { ...loadConfig(), roots: [] }, token: TOKEN, port: 0, tmux: tmux.asTmux(), hosts });
    b2 = `http://127.0.0.1:${s2.port}`;
    expect((await post('/api/hosts/nope/shell', {})).status).toBe(404);
    const r = await post('/api/hosts/mac/shell', {});
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toContain('is not connected');
  });
  test('send routes: unknown host is 404, a down host fails the check step', async () => {
    await start();
    expect((await fetch(`${b2}/api/workers/nova/send-preview?to=nope`, { headers: auth })).status).toBe(404);
    expect((await post('/api/workers/nova/send', { to: 'nope' })).status).toBe(404);
    expect((await post('/api/workers/nova/send', {})).status).toBe(400);
    const j = await (await post('/api/workers/nova/send', { to: 'mac' })).json() as any;
    expect(j.steps[0]).toMatchObject({ name: 'check', ok: false });
  });
  test('POST /api/workers with a host: no local path check; unknown host 404, down host 409, up host starts', async () => {
    const hosts = await start();
    const reg2 = new Registry(tmux.asTmux(), { ...loadConfig(), roots: [] }, { bin: ['/b'], url: 'u', token: TOKEN, inheritedOtelAttrs: '', ...START_OK, sessionsDir, alive: () => true, ancestors: [], procStartOf: () => '1', cmdlineOf: () => 'claude', hosts });
    s2.stop(true);
    s2 = startServer({ reg: reg2, cfg: { ...loadConfig(), roots: [] }, token: TOKEN, port: 0, tmux: tmux.asTmux(), hosts });
    b2 = `http://127.0.0.1:${s2.port}`;
    const body = (host: string) => ({ name: 'Rem', repo: '/Users/me/no-such-local-dir/app', host });
    let r = await post('/api/workers', body('nope'));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'unknown host' });
    r = await post('/api/workers', body('mac'));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'Mac is not connected' });
    await hosts.link('mac').connect();
    r = await post('/api/workers', body('mac'));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).host).toBe('mac');
    r = await post('/api/workers', { name: 'Loc', repo: '/no/such/local/dir' });
    expect(r.status).toBe(400);
  });
  test('stop and remove of a worker on a down host → 409', async () => {
    const hosts = await start();
    const reg2 = new Registry(tmux.asTmux(), { ...loadConfig(), roots: [] }, { bin: ['/b'], url: 'u', token: TOKEN, inheritedOtelAttrs: '', ...START_OK, sessionsDir, alive: () => true, ancestors: [], procStartOf: () => '1', cmdlineOf: () => 'claude', hosts });
    s2.stop(true);
    s2 = startServer({ reg: reg2, cfg: { ...loadConfig(), roots: [] }, token: TOKEN, port: 0, tmux: tmux.asTmux(), hosts });
    b2 = `http://127.0.0.1:${s2.port}`;
    await hosts.link('mac').connect();
    await reg2.spawn({ name: 'Rem', repo: '/Users/me/app', host: 'mac' });
    await hosts.link('mac').disconnect();
    for (const a of ['stop', 'remove']) {
      const r = await post(`/api/workers/rem/${a}`, {});
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error).toBe('Mac is not connected. Connect the host first.');
    }
    expect(reg2.get('rem')).toBeDefined();
  });
  test('POST /api/workers: a prompt that is not a string is 400', async () => {
    await start();
    const r = await post('/api/workers', { name: 'X', repo: '/tmp', prompt: { a: 1 } });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toContain('prompt');
  });
  test('POST /api/hosts with a password field → 400 naming password', async () => {
    await start();
    const r = await post('/api/hosts', { hosts: [{ id: 'm', name: 'M', ssh: 'a', roots: [], password: 'x' }] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain('password');
  });
  test('POST /api/hosts with a CSS-injecting colour → 400 naming color', async () => {
    await start();
    const r = await post('/api/hosts', { hosts: [{ id: 'm', name: 'M', ssh: 'a', roots: [], color: 'red;background:url(x)' }] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain('color');
  });
  test('POST /api/hosts refuses a duplicate id', async () => {
    await start();
    const h = { id: 'm', name: 'M', ssh: 'a', roots: [] };
    const r = await post('/api/hosts', { hosts: [h, h] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain('duplicate');
  });
  test('POST /api/hosts saves to config.json and updates the pool', async () => {
    const hosts = await start();
    const r = await post('/api/hosts', { hosts: [{ id: 'new', name: 'New', ssh: 'new', roots: [] }] });
    expect(r.status).toBe(200);
    expect(hosts.all().map(l => l.host.id)).toEqual(['new']);
    expect(loadConfig().hosts?.map(h => h.id)).toEqual(['new']);
  });
  test('POST /api/hosts/mac/connect calls HostLink.connect', async () => {
    const hosts = await start();
    const r = await post('/api/hosts/mac/connect', {});
    expect(r.status).toBe(200);
    expect(hosts.link('mac').state).toBe('up');
    await post('/api/hosts/mac/disconnect', {});
    expect(hosts.link('mac').state).toBe('down');
  });
  test('connect on an unknown host → 404', async () => {
    await start();
    expect((await post('/api/hosts/nope/connect', {})).status).toBe(404);
  });
  test('GET /api/hosts/mac/check returns a list of checks', async () => {
    const hosts = await start();
    await hosts.link('mac').connect();
    const j = await (await fetch(`${b2}/api/hosts/mac/check`, { headers: auth })).json() as any;
    expect(Array.isArray(j)).toBe(true);
    expect(j[0].id).toBe('ssh');
  });
  test('GET /api/hosts/import reads ~/.ssh/config; a missing file gives []', async () => {
    await start();
    const home = mkdtempSync(join(tmpdir(), 'ac-home-'));
    const old = process.env.HOME; process.env.HOME = home;
    try {
      expect(await (await fetch(`${b2}/api/hosts/import`, { headers: auth })).json()).toEqual([]);
      mkdirSync(join(home, '.ssh'));
      writeFileSync(join(home, '.ssh', 'config'), 'Host box\n  Port 2200\n');
      expect(await (await fetch(`${b2}/api/hosts/import`, { headers: auth })).json()).toEqual([{ id: 'box', name: 'box', ssh: 'box', port: 2200, roots: [] }]);
    } finally { process.env.HOME = old; }
  });
  test('a host state change reaches the state socket as a host event', async () => {
    await start();
    const msgs: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${s2.port}/ws/state?token=${TOKEN}`);
    ws.onmessage = e => msgs.push(JSON.parse(String(e.data)));
    await new Promise(r => { ws.onopen = r; });
    await post('/api/hosts/mac/connect', {});
    await new Promise(r => setTimeout(r, 100));
    ws.close();
    const ev = msgs.filter(m => m.t === 'host');
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.at(-1)).toMatchObject({ t: 'host', id: 'mac', state: 'up' });
  });
  test('GET /api/branches?host= with no path → 404 no such folder', async () => {
    await start();
    await post('/api/hosts/mac/connect', {});
    const r = await fetch(`${b2}/api/branches?host=mac`, { headers: auth });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'no such folder' });
  });
});
