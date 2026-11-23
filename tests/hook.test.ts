import { describe, expect, test } from 'bun:test';
import { runHook } from '../src/hook';

const env = { AC_URL: 'http://127.0.0.1:1', AC_TOKEN: 'tok', AC_ID: 'nova' };
const pre = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
const refused = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
const hanging = ((_u: unknown, init?: RequestInit) => new Promise((_, rej) => {
  init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
})) as unknown as typeof fetch;

describe('runHook', () => {
  test('prints nothing when not started by the console', async () => {
    expect(await runHook('Stop', '{}', {})).toBe('');
  });

  test('server down + guarded PreToolUse → ask, quickly', async () => {
    const t = Date.now();
    const out = JSON.parse(await runHook('PreToolUse', pre('git push origin main'), env, refused));
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Agent Console is not running' });
    expect(Date.now() - t).toBeLessThan(2000);
  });

  test('server down + other event → nothing', async () => {
    expect(await runHook('Stop', '{}', env, refused)).toBe('');
    expect(await runHook('PreToolUse', pre('ls'), env, refused)).toBe('');
  });

  test('a hanging server does not block a non-guarded hook for more than 2.5 s', async () => {
    const t = Date.now();
    expect(await runHook('PreToolUse', pre('ls'), env, hanging)).toBe('');
    expect(Date.now() - t).toBeLessThan(2500);
  });

  test('C1: a config guard pattern also gives ask when the server is down', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'ac-hk-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ guardPatterns: ['\\bnpm publish\\b'] }));
    process.env.AC_CONFIG_DIR = dir;
    const out = JSON.parse(await runHook('PreToolUse', pre('npm publish'), env, refused));
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  test('C1: a config-guarded command waits for the server (no 2 s abort)', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'ac-hk-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ guardPatterns: ['\\bnpm publish\\b'] }));
    process.env.AC_CONFIG_DIR = dir;
    let aborted = false;
    const slow = ((_u: unknown, init?: RequestInit) => new Promise(res => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      setTimeout(() => res(Response.json({ output: { hookSpecificOutput: { permissionDecision: 'deny' } } })), 2600);
    })) as unknown as typeof fetch;
    const out = JSON.parse(await runHook('PreToolUse', pre('npm publish'), env, slow));
    expect(aborted).toBe(false);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  }, 5000);

  test('posts event, id and payload with the token, and prints the output', async () => {
    let seen: { url: string; headers: Headers; body: any } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return Response.json({ output: { hookSpecificOutput: { permissionDecision: 'deny' } } });
    }) as unknown as typeof fetch;
    const out = await runHook('PreToolUse', pre('git push'), env, f);
    expect(seen!.url).toBe('http://127.0.0.1:1/api/hook');
    expect(seen!.headers.get('x-ac-token')).toBe('tok');
    expect(seen!.body).toEqual({ event: 'PreToolUse', id: 'nova', payload: { tool_name: 'Bash', tool_input: { command: 'git push' } } });
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('bad stdin JSON is sent as an empty payload', async () => {
    let body: any;
    const f = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return Response.json({}); }) as unknown as typeof fetch;
    expect(await runHook('Stop', 'not json', env, f)).toBe('');
    expect(body.payload).toEqual({});
  });
});
