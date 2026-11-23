import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastMessages, listExternal, projectDirFor } from '../src/external';

const sess = (pid: number, over: object = {}) => ({
  pid, sessionId: `s-${pid}`, cwd: `/r/${pid}`, name: `n-${pid}`, status: 'idle', kind: 'interactive', startedAt: 1, procStart: '1', ...over,
});

describe('listExternal', () => {
  test('keeps live interactive sessions the console did not start, and marks ancestors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ext-'));
    writeFileSync(join(dir, '1.json'), JSON.stringify(sess(1, { status: 'busy' })));
    writeFileSync(join(dir, '2.json'), JSON.stringify(sess(2)));               // dead
    writeFileSync(join(dir, '3.json'), JSON.stringify(sess(3)));               // ours (AC_ID)
    writeFileSync(join(dir, '4.json'), JSON.stringify(sess(4, { kind: 'sdk' })));
    writeFileSync(join(dir, '5.json'), JSON.stringify(sess(5)));               // ancestor
    writeFileSync(join(dir, '6.json'), '{broken');
    writeFileSync(join(dir, '1.abc.key'), 'secret');
    const out = listExternal({
      dir, alive: p => p !== 2, envOf: (p): Record<string, string> => (p === 3 ? { AC_ID: 'x' } : {}), ancestors: [5],
      procStartOf: () => '1', cmdlineOf: () => 'claude',
    });
    expect(out.map(s => s.pid)).toEqual([1, 5]);
    expect(out[0]).toEqual({ pid: 1, sessionId: 's-1', cwd: '/r/1', name: 'n-1', status: 'busy', startedAt: 1, ancestor: false });
    expect(out[1]!.ancestor).toBe(true);
  });
});

describe('I4: listExternal checks the process identity', () => {
  test('drops a session whose pid start time or command does not match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-ext2-'));
    writeFileSync(join(dir, '7.json'), JSON.stringify(sess(7, { procStart: '100' })));
    writeFileSync(join(dir, '8.json'), JSON.stringify(sess(8, { procStart: '200' })));
    writeFileSync(join(dir, '9.json'), JSON.stringify(sess(9, { procStart: '300' })));
    const out = listExternal({
      dir, alive: () => true, envOf: () => ({}), ancestors: [],
      procStartOf: p => ({ 7: '100', 8: '999', 9: '300' } as Record<number, string>)[p],
      cmdlineOf: p => (p === 9 ? 'python evil.py' : 'claude --resume x'),
    });
    expect(out.map(s => s.pid)).toEqual([7]);
  });
});

describe('projectDirFor', () => {
  test('replaces every non-alphanumeric character with a dash', () => {
    expect(projectDirFor('/home/a/x.y')).toBe('-home-a-x-y');
    expect(projectDirFor('/tmp/claude-1000/-home')).toBe('-tmp-claude-1000--home');
  });
});

describe('lastMessages', () => {
  test('reads user prompts and assistant text, skips meta, sidechains and tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-tr-'));
    const f = join(dir, 't.jsonl');
    const lines = [
      { type: 'user', message: { content: 'first question' } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'first answer' }] } },
      { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'meta' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'r' }] } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'second question' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'second answer' }] } },
    ];
    writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n{bad line\n');
    expect(lastMessages(f, 3)).toEqual([
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'second question' },
      { role: 'assistant', text: 'second answer' },
    ]);
  });

  test('skips harness-injected user lines (notifications, commands, reminders)', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'ac-tr2-')), 't.jsonl');
    const lines = ['<task-notification>x</task-notification>', '<command-name>/clear</command-name>', '<local-command-stdout></local-command-stdout>',
      '<system-reminder>r</system-reminder>', 'real prompt'].map(c => JSON.stringify({ type: 'user', message: { content: c } }));
    writeFileSync(f, lines.join('\n'));
    expect(lastMessages(f, 5)).toEqual([{ role: 'user', text: 'real prompt' }]);
  });

  test('a missing transcript gives an empty list', () => {
    expect(lastMessages('/nope/x.jsonl', 5)).toEqual([]);
  });
});
