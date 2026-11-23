import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

const bin = new URL('../dist/agent-console', import.meta.url).pathname;
const ready = existsSync(bin) && !!Bun.which('tmux') && !!Bun.which('claude');
const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-'));
const socket = `ac-test-e2e-${Math.random().toString(36).slice(2, 6)}`;
const port = 17000 + Math.floor(Math.random() * 1000);
const env = { ...process.env, AC_CONFIG_DIR: dir, AC_PORT: String(port), AC_TMUX_SOCKET: socket };
let proc: Subprocess | null = null;

const start = () => { proc = Bun.spawn([bin, 'serve', '--no-open'], { env, cwd: tmpdir(), stdout: 'ignore', stderr: 'ignore' }); };
const token = () => readFileSync(join(dir, 'token'), 'utf8').trim();
const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-ac-token': token() } });

async function until<T>(fn: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* not up yet */ } await Bun.sleep(250); }
  return undefined;
}
const advisorListed = () => until(async () => {
  const s = await (await get('/api/state')).json() as { state: { workers: { id: string }[] } };
  return s.state.workers.some(w => w.id === 'advisor') || undefined;
}, 15_000);

afterAll(async () => {
  proc?.kill();
  await Bun.spawn(['tmux', '-L', socket, 'kill-server'], { stderr: 'ignore' }).exited;
});

describe.skipIf(!ready)('binary end to end', () => {
  test('starts, lists the advisor, gates a guarded hook, and survives a restart', async () => {
    start();
    expect(await advisorListed()).toBe(true);

    const hook = fetch(`http://127.0.0.1:${port}/api/hook`, {
      method: 'POST', headers: { 'x-ac-token': token() },
      body: JSON.stringify({ event: 'PreToolUse', id: 'advisor', payload: { tool_name: 'Bash', tool_input: { command: 'git push origin main' } } }),
    });
    const need = await until(async () => {
      const s = await (await get('/api/state')).json() as { needs: { nid: string; kind: string }[] };
      return s.needs.find(n => n.kind === 'guard');
    }, 5_000);
    expect(need).toBeDefined();
    await fetch(`http://127.0.0.1:${port}/api/needs/${need!.nid}`, { method: 'POST', headers: { 'x-ac-token': token() }, body: '{"decision":"deny"}' });
    const out = await (await hook).json() as { output: { hookSpecificOutput: { permissionDecision: string } } };
    expect(out.output.hookSpecificOutput.permissionDecision).toBe('deny');

    const before = token();
    proc!.kill(); await proc!.exited;
    start();
    expect(await advisorListed()).toBe(true);
    expect(token()).toBe(before);
    const sessions = await new Response(Bun.spawn(['tmux', '-L', socket, 'ls', '-F', '#{session_name}'], { stdout: 'pipe' }).stdout).text();
    expect(sessions.split('\n').filter(s => s === 'ac-advisor').length).toBe(1);
  }, 60_000);
});
