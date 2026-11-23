import { describe, expect, test } from 'bun:test';
import {
  MAX_TOOLS, applyPrompt, applyStop, applyTaskCreate, applyTaskUpdate, applyTodoWrite,
  emptyTrack, taskIdFrom, toolDetail, toolEnd, toolStart,
} from '../src/steps';

const todos = (...s: [string, string][]) => s.map(([content, status]) => ({ content, status, activeForm: `Doing ${content}` }));

describe('steps: TodoWrite', () => {
  test('the first list replaces prompt steps and keeps the order', () => {
    let t = applyPrompt(emptyTrack(), 'fix the bug', 1);
    t = applyTodoWrite(t, todos(['Read', 'completed'], ['Fix', 'in_progress'], ['Test', 'pending']), 10);
    expect(t.source).toBe('todo');
    expect(t.steps.map(s => [s.text, s.status])).toEqual([['Read', 'completed'], ['Fix', 'in_progress'], ['Test', 'pending']]);
    expect(t.steps[1]).toMatchObject({ startedAt: 10, active: 'Doing Fix' });
  });

  test('a later list keeps the start time of a matching item and sets the end time', () => {
    let t = applyTodoWrite(emptyTrack(), todos(['Fix', 'in_progress'], ['Test', 'pending']), 10);
    t = applyTodoWrite(t, todos(['Fix', 'completed'], ['Test', 'in_progress']), 50);
    expect(t.steps[0]).toMatchObject({ status: 'completed', startedAt: 10, endedAt: 50 });
    expect(t.steps[1]).toMatchObject({ status: 'in_progress', startedAt: 50 });
    expect(t.steps[1]!.endedAt).toBeUndefined();
  });

  test('a bad payload changes nothing', () => {
    const t = emptyTrack();
    expect(applyTodoWrite(t, 'nope', 1)).toBe(t);
  });
});

describe('steps: TaskCreate / TaskUpdate', () => {
  test('the id comes from the response text', () => {
    expect(taskIdFrom('Task #7 created successfully: Fix')).toBe('7');
    expect(taskIdFrom({ task: { id: '12' } })).toBe('12');
    expect(taskIdFrom('')).toBeUndefined();
  });

  test('create, start, finish, delete', () => {
    let t = applyTaskCreate(emptyTrack(), { subject: 'Fix', activeForm: 'Fixing' }, 'Task #1 created successfully: Fix');
    t = applyTaskCreate(t, { subject: 'Test' }, 'Task #2 created successfully: Test');
    t = applyTaskUpdate(t, { taskId: '1', status: 'in_progress' }, 5);
    t = applyTaskUpdate(t, { taskId: '1', status: 'completed' }, 9);
    expect(t.steps[0]).toMatchObject({ key: '1', text: 'Fix', status: 'completed', startedAt: 5, endedAt: 9 });
    t = applyTaskUpdate(t, { taskId: '2', status: 'deleted' }, 10);
    expect(t.steps.map(s => s.key)).toEqual(['1']);
  });

  test('an unknown task id changes nothing', () => {
    const t = applyTaskCreate(emptyTrack(), { subject: 'A' }, 'Task #1 created successfully');
    expect(applyTaskUpdate(t, { taskId: '9', status: 'completed' }, 1)).toBe(t);
  });

  test('no id in the response: a running number', () => {
    const t = applyTaskCreate(applyTaskCreate(emptyTrack(), { subject: 'A' }, {}), { subject: 'B' }, {});
    expect(t.steps.map(s => s.key)).toEqual(['1', '2']);
  });
});

describe('steps: prompt fallback', () => {
  test('each prompt is one step; Stop finishes it', () => {
    let t = applyPrompt(emptyTrack(), 'first line\nsecond line', 1);
    t = applyPrompt(t, 'next', 5);
    expect(t.steps.map(s => [s.text, s.status])).toEqual([['first line', 'completed'], ['next', 'in_progress']]);
    t = applyStop(t, 9);
    expect(t.steps[1]).toMatchObject({ status: 'completed', endedAt: 9 });
  });

  test('a prompt does not touch a checklist', () => {
    const t = applyTodoWrite(emptyTrack(), todos(['A', 'pending']), 1);
    expect(applyPrompt(t, 'x', 2)).toBe(t);
  });
});

describe('steps: tool calls', () => {
  test('calls go to the running step and close on PostToolUse', () => {
    let t = applyTodoWrite(emptyTrack(), todos(['A', 'completed'], ['B', 'in_progress']), 1);
    t = toolStart(t, 'Bash', { command: 'bun test' }, 2);
    expect(t.steps[1]!.tools).toEqual([{ at: 2, tool: 'Bash', detail: 'bun test' }]);
    t = toolEnd(t, 'Bash', 3);
    expect(t.steps[1]!.tools[0]!.end).toBe(3);
  });

  test('checklist tools are not listed as calls', () => {
    const t = applyTodoWrite(emptyTrack(), todos(['A', 'in_progress']), 1);
    expect(toolStart(t, 'TodoWrite', {}, 2)).toBe(t);
  });

  test('calls before any step go to loose; the list is capped', () => {
    let t = emptyTrack();
    for (let i = 0; i < MAX_TOOLS + 5; i++) t = toolStart(t, 'Read', { file_path: `/a/b/f${i}.ts` }, i);
    expect(t.loose).toHaveLength(MAX_TOOLS);
    expect(t.loose.at(-1)!.detail).toBe('b/f29.ts');
  });

  test('Stop closes open calls', () => {
    let t = applyTodoWrite(emptyTrack(), todos(['A', 'in_progress']), 1);
    t = applyStop(toolStart(t, 'Grep', { pattern: 'x' }, 2), 7);
    expect(t.steps[0]!.tools[0]!.end).toBe(7);
    expect(t.steps[0]!.status).toBe('in_progress'); // a checklist keeps its own state
  });

  test('toolDetail is short and readable', () => {
    expect(toolDetail('Edit', { file_path: '/x/y/src/app.ts' })).toBe('src/app.ts');
    expect(toolDetail('Grep', { pattern: 'foo', path: '/r/src' })).toBe('foo in r/src');
    expect(toolDetail('Bash', { command: 'ls', description: 'List files' })).toBe('ls — List files');
    expect(toolDetail('mcp__x__y', { q: 'hello' })).toBe('hello');
  });
});
