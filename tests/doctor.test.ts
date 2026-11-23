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
