import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { startServer } from '../src/server';
import { Registry } from '../src/workers';
import { loadConfig } from '../src/store';
import { FakeTmux } from './fakes';

const TOKEN = 'b'.repeat(64);
let server: Server<unknown>;
let base: string;

beforeAll(() => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-web-'));
  const tmux = new FakeTmux();
  const cfg = { ...loadConfig(), templates: [{ name: 'qa', prompt: 'Run QA' }] };
  const reg = new Registry(tmux.asTmux(), cfg, { bin: ['/b'], url: 'u', token: TOKEN, inheritedOtelAttrs: '' });
  server = startServer({ reg, cfg, token: TOKEN, port: 0, tmux: tmux.asTmux() });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

describe('page', () => {
  test('GET /app returns the canvas page and every asset it names', async () => {
    const html = await (await fetch(`${base}/app`)).text();
    expect(html).toContain('<title>Agent Console</title>'); // the app window shows this name
    expect(html).toContain('id="cmdin"');
    const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1]!);
    expect(assets.some(a => a.endsWith('.js'))).toBe(true);
    expect(assets.some(a => a.endsWith('.css'))).toBe(true);
    for (const a of assets) expect((await fetch(`${base}${a}`)).status).toBe(200);
  });

  test('the page bundle contains xterm and no simulation code', async () => {
    const html = await (await fetch(`${base}/app`)).text();
    const js = html.match(/src="(\/[^"]+\.js)"/)![1]!;
    const code = await (await fetch(`${base}${js}`)).text();
    expect(code).toContain('xterm');
    expect(code).not.toContain('runWorker');
  });

  test('GET /api/repos includes the template names', async () => {
    const r = await (await fetch(`${base}/api/repos`, { headers: { 'x-ac-token': TOKEN } })).json() as { templates: string[] };
    expect(r.templates).toEqual(['qa']);
  });
});
