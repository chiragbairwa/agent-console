import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyChat, assistantTexts, markCurrent, parseChecklist, readNewLines, rehome } from '../src/chatlist';
import { applyPrompt, applyTodoWrite, emptyTrack, toolStart } from '../src/steps';

// The shape seen in a real session on 2026-11-20: a full list first, then only the changed lines.
const FIRST = '**Checklist**\n- [ ] 1. Count `.ts` files in `agent-console/src`\n- [ ] 2. Read `agent-console/package.json`\n- [ ] 3. List `tests` folder\n\nItem 1 start.';
const SECOND = '- [x] 1. Count `.ts` files → **21**\n- [ ] 2. Read `agent-console/package.json`';

describe('chat checklist: parse', () => {
  test('markers, numbers, notes; Markdown removed', () => {
    expect(parseChecklist(SECOND)).toEqual([
      { num: '1', text: 'Count .ts files', note: '21', status: 'completed' },
      { num: '2', text: 'Read agent-console/package.json', note: undefined, status: 'pending' },
    ]);
    expect(parseChecklist('- [~] Fix the table')[0]).toMatchObject({ status: 'in_progress', num: undefined });
  });

  test('"1. [x] text" (number first, seen in a real session) parses the same', () => {
    expect(parseChecklist('**Checklist**\n1. [ ] Count lines of `web/flow.ts`\n2. [x] List `web/` → 8 files')).toEqual([
      { num: '1', text: 'Count lines of web/flow.ts', note: undefined, status: 'pending' },
      { num: '2', text: 'List web/', note: '8 files', status: 'completed' },
    ]);
  });

  test('lines inside a code block are not a checklist', () => {
    expect(parseChecklist('```md\n- [ ] example\n```\n- [x] real')).toHaveLength(1);
  });
});

describe('chat checklist: merge', () => {
  test('a full list, then changed lines by number', () => {
    let t = applyChat(emptyTrack(), FIRST, 100);
    expect(t.source).toBe('chat');
    expect(t.steps.map(s => [s.key, s.status])).toEqual([['n1', 'pending'], ['n2', 'pending'], ['n3', 'pending']]);
    t = markCurrent(t, 110);
    expect(t.steps[0]).toMatchObject({ status: 'in_progress', startedAt: 110 });
    t = applyChat(t, SECOND, 150);
    expect(t.steps[0]).toMatchObject({ text: 'Count .ts files in agent-console/src', status: 'completed', endedAt: 150, note: '21' });
    t = markCurrent(t, 151);
    expect(t.steps[1]).toMatchObject({ status: 'in_progress', startedAt: 151 });
  });

  test('items with no number match by their words', () => {
    let t = applyChat(emptyTrack(), '- [ ] Fix the mobile navigation layout\n- [ ] Run the production build', 1);
    t = applyChat(t, '- [x] Fix the mobile navigation → done at 375px', 2);
    expect(t.steps.map(s => s.status)).toEqual(['completed', 'pending']);
    expect(t.steps).toHaveLength(2);
  });

  test('a new list for a new task replaces the old one', () => {
    let t = applyChat(emptyTrack(), FIRST, 1);
    t = applyChat(t, '- [ ] Write the plan\n- [ ] Ask the user', 2);
    expect(t.steps.map(s => s.text)).toEqual(['Write the plan', 'Ask the user']);
  });

  test('a fresh numbered list for a new task replaces the old one, even with the same numbers', () => {
    let t = applyChat(emptyTrack(), FIRST, 1);
    t = applyChat(t, SECOND, 2);
    t = applyChat(t, '- [ ] 1. Grep exports in chatlist.ts\n- [ ] 2. Run sleep 90\n- [ ] 3. Say finished', 3);
    expect(t.steps.map(s => [s.text, s.status])).toEqual([['Grep exports in chatlist.ts', 'pending'], ['Run sleep 90', 'pending'], ['Say finished', 'pending']]);
  });

  test('repeating the same open list does not reset it', () => {
    let t = markCurrent(applyChat(emptyTrack(), FIRST, 1), 5);
    t = applyChat(t, FIRST, 9);
    expect(t.steps[0]).toMatchObject({ status: 'pending' }); // the list itself says open
    expect(t.steps).toHaveLength(3);
  });

  test('prompt steps give way; their tool calls are kept as loose', () => {
    let t = toolStart(applyPrompt(emptyTrack(), 'go', 1), 'Read', { file_path: '/a/b' }, 2);
    t = applyChat(t, FIRST, 3);
    expect(t.steps).toHaveLength(3);
    expect(t.loose.map(c => c.tool)).toEqual(['Read']);
  });

  test('a tool checklist wins over chat lines', () => {
    const t = applyTodoWrite(emptyTrack(), [{ content: 'A', status: 'pending' }], 1);
    expect(applyChat(t, FIRST, 2)).toBe(t);
  });

  test('a reply with no checklist changes nothing', () => {
    const t = applyChat(emptyTrack(), FIRST, 1);
    expect(applyChat(t, 'Just text.', 2)).toBe(t);
  });
});

describe('chat checklist: late replies', () => {
  test('a call that started after its step ended moves to the running step', () => {
    let t = markCurrent(applyChat(emptyTrack(), FIRST, 100), 100);
    t = toolStart(t, 'Bash', { command: 'rg --files' }, 110);   // step 1
    t = toolStart(t, 'Read', { file_path: '/a/package.json' }, 130); // really step 2: the reply below came first
    t = applyChat(t, '- [x] 1. Count → 21', 120);
    t = rehome(markCurrent(t, 140));
    expect(t.steps[0]!.tools.map(c => c.tool)).toEqual(['Bash']);
    expect(t.steps[1]).toMatchObject({ status: 'in_progress', startedAt: 130 });
    expect(t.steps[1]!.tools.map(c => c.tool)).toEqual(['Read']);
  });

  test('nothing to move: same track', () => {
    const t = markCurrent(applyChat(emptyTrack(), FIRST, 1), 2);
    expect(rehome(t)).toBe(t);
  });
});

describe('chat checklist: transcript', () => {
  const line = (o: object) => JSON.stringify(o) + '\n';
  const asst = (text: string, ts = '2026-11-20T10:00:00Z') => line({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash' }] } });

  test('only assistant text of the main thread', () => {
    const lines = [asst('hi'), line({ type: 'user', message: { content: 'x' } }), line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }), 'not json'];
    expect(assistantTexts(lines.join('').split('\n'))).toEqual([{ text: 'hi', at: Date.parse('2026-11-20T10:00:00Z') }]);
  });

  test('reads only new complete lines', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'ac-cl-')), 't.jsonl');
    writeFileSync(f, asst('one'));
    let r = readNewLines(f, 0);
    expect(r.lines).toHaveLength(1);
    appendFileSync(f, asst('two') + '{"half":');
    r = readNewLines(f, r.offset);
    expect(assistantTexts(r.lines).map(x => x.text)).toEqual(['two']);
    appendFileSync(f, '1}\n');
    expect(readNewLines(f, r.offset).lines).toEqual(['{"half":1}']);
    expect(readNewLines(join(f, 'missing'), 5)).toEqual({ lines: [], offset: 5 });
  });
});
