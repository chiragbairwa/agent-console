import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/doctor';

describe('runDoctor', () => {
  test('returns the six named checks with boolean ok', async () => {
    const checks = await runDoctor();
    expect(checks.map(c => c.name)).toEqual(['bun', 'tmux', 'claude', 'codex', 'config-dir', 'port']);
    for (const c of checks) expect(typeof c.ok).toBe('boolean');
  });

  test('missing codex is a warning, missing claude is an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-path-'));
    const fake = join(dir, 'claude');
    writeFileSync(fake, '#!/bin/sh\necho 1.0\n'); chmodSync(fake, 0o755);
    let checks = await runDoctor({ PATH: dir });
    const codex = checks.find(c => c.name === 'codex')!;
    expect(codex).toMatchObject({ ok: true, warn: true, detail: 'codex not found on PATH (Codex workers will not start)' });
    expect(checks.find(c => c.name === 'claude')!.ok).toBe(true);
    checks = await runDoctor({ PATH: mkdtempSync(join(tmpdir(), 'ac-path-')) });
    expect(checks.find(c => c.name === 'claude')).toMatchObject({ ok: false, detail: 'claude not found on PATH. Install Claude Code.' });
  });

  test('tmux check fails with an install hint when tmux is not on PATH', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ac-path-'));
    const checks = await runDoctor({ PATH: empty });
    const tmux = checks.find(c => c.name === 'tmux')!;
    expect(tmux.ok).toBe(false);
    expect(tmux.detail).toContain('sudo apt install tmux');
  });
});

describe('hostDoctor (doctor --host)', () => {
  const { hostDoctor } = require('../src/doctor') as typeof import('../src/doctor');
  const { HostLink } = require('../src/ssh') as typeof import('../src/ssh');
  const { FakeRunner } = require('./fakes') as typeof import('./fakes');
  const mac: import('../src/types').Host = { id: 'mac', name: 'Mac', ssh: 'macmini', roots: [] };
  const TOKEN = 'b'.repeat(64);

  test('a running console answers: its checks are printed and no ssh link starts', async () => {
    const seen: { url: string; token?: string | null }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, token: new Headers(init?.headers).get('x-ac-token') });
      if (url.endsWith('/api/health')) return Response.json({ ok: true });
      return Response.json([{ id: 'ssh', ok: true, text: 'connected, 9 ms' }, { id: 'tmux', ok: true, text: 'tmux 3.4' }]);
    };
    const lines: string[] = [];
    let made = 0;
    const code = await hostDoctor('mac', { hosts: [mac], port: 7999, token: TOKEN, sockDir: '/tmp/ac-doc', fetch, print: l => lines.push(l), makeLink: () => { made++; throw new Error('no'); } });
    expect(code).toBe(0);
    expect(made).toBe(0);
    expect(seen.map(s => s.url)).toEqual(['http://127.0.0.1:7999/api/health', 'http://127.0.0.1:7999/api/hosts/mac/check']);
    expect(seen.every(s => s.token === TOKEN)).toBe(true);
    expect(lines[0]).toContain('connected, 9 ms');
    expect(lines).toHaveLength(2);
  });

  test('a running console that does not know the host → unknown host, code 1', async () => {
    const fetch = async (url: string) => url.endsWith('/api/health') ? Response.json({ ok: true }) : Response.json({ error: 'unknown host' }, { status: 404 });
    const lines: string[] = [];
    expect(await hostDoctor('nope', { hosts: [], port: 1, token: TOKEN, sockDir: '/tmp/ac-doc', fetch, print: l => lines.push(l) })).toBe(1);
    expect(lines.join('\n')).toContain('unknown host nope');
  });

  test('no console running: a private socket folder is used, and only that master gets -O exit', async () => {
    const fetch = async () => { throw new Error('ECONNREFUSED'); };
    const f = new FakeRunner().on(['ssh', '-O', 'check'], { code: 255, err: 'no master' });
    const dirs: string[] = [];
    const makeLink = (h: typeof mac, sockDir: string) => { dirs.push(sockDir); return new HostLink(h, { consolePort: 7878, sockDir, spawn: f.spawn }); };
    const lines: string[] = [];
    const code = await hostDoctor('mac', { hosts: [mac], port: 7878, token: TOKEN, sockDir: '/tmp/ac-doc', fetch, makeLink, print: l => lines.push(l) });
    expect(code).toBe(1);
    expect(dirs).toEqual([`/tmp/ac-doc/doctor-${process.pid}`]);
    const socks = f.cmds.filter(c => c.includes('-S')).map(c => c[c.indexOf('-S') + 1]);
    expect(socks.every(s => s === `/tmp/ac-doc/doctor-${process.pid}/mac.sock`)).toBe(true);
    expect(f.cmds.some(c => c.includes('exit'))).toBe(true);
    expect(lines.join('\n')).toContain('ssh');
  });

  test('no console running and no such host in the config → unknown host, code 1', async () => {
    const fetch = async () => { throw new Error('ECONNREFUSED'); };
    const lines: string[] = [];
    expect(await hostDoctor('nope', { hosts: [mac], port: 1, token: TOKEN, sockDir: '/tmp/ac-doc', fetch, print: l => lines.push(l) })).toBe(1);
    expect(lines).toEqual(['✗ unknown host nope']);
  });
});

describe('runDoctor port check', () => {
  const portOf = async (body: string, status: number) => {
    const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(body, { status }) });
    return s;
  };
  const portCheck = async (port: number, o?: Parameters<typeof runDoctor>[2]) =>
    (await runDoctor({}, port, o)).find(c => c.name === 'port')!;

  test('a port used by the running Agent Console (403 Forbidden without a token) is ✓', async () => {
    const s = await portOf('Forbidden', 403);
    try { expect(await portCheck(s.port!)).toEqual({ name: 'port', ok: true, detail: `${s.port} used by the running Agent Console` }); }
    finally { s.stop(true); }
  });

  test('200 {ok:true} from /api/health is the console too; the check asks /api/health', async () => {
    let asked = '';
    const fetch = async (url: string) => { asked = url; return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
    const s = await portOf('x', 500);
    try {
      expect((await portCheck(s.port!, { fetch })).ok).toBe(true);
      expect(asked).toBe(`http://127.0.0.1:${s.port}/api/health`);
    } finally { s.stop(true); }
  });

  test('a port used by another program stays ✗', async () => {
    const s = await portOf('<html>other</html>', 200);
    try { expect(await portCheck(s.port!)).toEqual({ name: 'port', ok: false, detail: `${s.port} is in use (is agent-console already running?)` }); }
    finally { s.stop(true); }
    const fail = async () => { throw new Error('refused'); };
    const s2 = await portOf('x', 200);
    try { expect((await portCheck(s2.port!, { fetch: fail })).ok).toBe(false); } finally { s2.stop(true); }
  });
});

describe('runDoctor folder access (macOS)', () => {
  const eperm = (p: string) => { if (p.includes('Desktop')) throw Object.assign(new Error('x'), { code: 'EPERM' }); return []; };

  test('on macOS a blocked root or advisorCwd is a warning with the System Settings hint', async () => {
    const checks = await runDoctor({}, 1, { platform: 'darwin', folders: ['/Users/me/code', '/Users/me/Desktop/app'], readDir: eperm });
    expect(checks.find(c => c.name === 'folders')).toEqual({
      name: 'folders', ok: true, warn: true,
      detail: 'macOS blocks access to /Users/me/Desktop/app. Give Agent Console access in System Settings → Privacy & Security → Files and Folders (or Full Disk Access), then restart the session.',
    });
  });

  test('on macOS readable folders pass', async () => {
    const checks = await runDoctor({}, 1, { platform: 'darwin', folders: ['/Users/me/code', '/Users/me/code'], readDir: () => [] });
    expect(checks.find(c => c.name === 'folders')).toEqual({ name: 'folders', ok: true, detail: 'the roots and advisorCwd are readable' });
  });

  test('on Linux there is no folder check', async () => {
    const checks = await runDoctor({}, 1, { platform: 'linux', folders: ['/x/Desktop'], readDir: eperm });
    expect(checks.find(c => c.name === 'folders')).toBeUndefined();
  });
});
