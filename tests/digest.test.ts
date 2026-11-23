import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Digest, DIGEST_TAIL } from '../src/digest';
import { loadConfig } from '../src/store';
import { applyTodoWrite } from '../src/steps';
import { Registry } from '../src/workers';
import { FakeTmux } from './fakes';

let reg: Registry, tmux: FakeTmux, now: number;
beforeEach(async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-dg-'));
  tmux = new FakeTmux(); now = Date.parse('2026-11-20T11:00:00Z');
  reg = new Registry(tmux.asTmux(), loadConfig(), { bin: ['/b'], url: 'u', token: 't', inheritedOtelAttrs: '', now: () => now });
  await reg.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor' });
  await reg.spawn({ name: 'Atlas', repo: '/r/Acme.Atlas' });
});
const sent = () => tmux.of('sendText').map(c => String(c.args[1]));

describe('advisor status check', () => {
  test('one line per worker with its step, sent to the advisor', async () => {
    reg.setStatus('atlas', 'running');
    reg.steps('atlas', t => applyTodoWrite(t, [{ content: 'Read', status: 'completed' }, { content: 'Fix the bug', status: 'in_progress' }], now - 12 * 60000));
    const d = new Digest(reg, () => now);
    expect(await d.tick()).toBe(true);
    const msg = sent().at(-1)!;
    expect(msg).toStartWith('[from console] Status at ');
    expect(msg).toContain('- Atlas (Acme.Atlas): running; step 2/2 "Fix the bug" for 12 min');
    expect(msg).toEndWith(DIGEST_TAIL);
  });

  test('nothing changed → nothing sent; a step that only gets older is no change', async () => {
    const d = new Digest(reg, () => now);
    expect(await d.tick()).toBe(true);
    now += 5 * 60000;
    expect(await d.tick()).toBe(false);
    reg.setStatus('atlas', 'done');
    expect(await d.tick()).toBe(true);
  });

  test('a need from the user is in the line', async () => {
    reg.addNeed({ id: 'atlas', kind: 'guard', text: 'Allow: git push origin main' });
    expect(new Digest(reg, () => now).build()).toContain('WAITS ON YOU: Allow: git push origin main');
  });

  test('no check while one waits in the advisor queue, or with no workers, or a stopped advisor', async () => {
    reg.setStatus('advisor', 'needs-you');
    await reg.deliver('you', 'advisor', 'hello'); // queued: the advisor is busy
    expect(new Digest(reg, () => now).build()).toBeNull();
    reg.setStatus('advisor', 'stopped');
    expect(new Digest(reg, () => now).build()).toBeNull();
    await reg.remove('atlas');
    reg.setStatus('advisor', 'idle');
    expect(new Digest(reg, () => now).build()).toBeNull();
  });

  test('the interval comes from config; default 5 minutes', () => {
    expect(loadConfig().advisorDigestMin).toBe(5);
  });
});

