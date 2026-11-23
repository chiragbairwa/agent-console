import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('web agents', () => {
  test('web has no agent id literal', () => {
    const dir = join(import.meta.dir, '..', 'web');
    const bad: string[] = [];
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8');
      if (/['"`](claude|codex)['"`]/.test(text)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
  test('Add Worker has the agent switch and the option box', () => {
    const html = readFileSync(join(import.meta.dir, '..', 'web', 'index.html'), 'utf8');
    expect(html).toContain('id="addAgent"');
    expect(html).toContain('id="addOpts"');
  });
});
