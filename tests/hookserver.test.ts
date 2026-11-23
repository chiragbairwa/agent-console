import { beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleHook } from '../src/hookserver';
import { Registry } from '../src/workers';
import { loadConfig } from '../src/store';
import type { Config } from '../src/types';
import { FakeTmux } from './fakes';

let reg: Registry;
let cfg: Config;
let tmux: FakeTmux;

beforeEach(async () => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-hs-'));
  cfg = { ...loadConfig(), hookTimeoutSec: 0.05 };
  tmux = new FakeTmux();
  reg = new Registry(tmux.asTmux(), cfg, { bin: ['/b'], url: 'u', token: 't', inheritedOtelAttrs: '' });
  await reg.spawn({ name: 'Nova', repo: '/r/s' });
});

const hook = (event: string, payload: object = {}) => handleHook(reg, cfg, { event, id: 'nova', payload });
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

describe('handleHook', () => {
  test('SessionStart stores the Claude session id', async () => {
    await hook('SessionStart', { session_id: 'abc' });
    expect(reg.get('nova')!.sessionId).toBe('abc');
  });

  test('UserPromptSubmit → running with the prompt as task', async () => {
    await hook('UserPromptSubmit', { prompt: 'x'.repeat(100) });
    expect(reg.get('nova')).toMatchObject({ status: 'running', task: 'x'.repeat(80) });
  });

  test('PreToolUse (not guarded) → running with the tool as task', async () => {
    expect(await hook('PreToolUse', bash('ls -la'))).toEqual({});
    expect(reg.get('nova')).toMatchObject({ status: 'running', task: 'Bash: ls -la' });
    await hook('PreToolUse', { tool_name: 'Edit', tool_input: {} });
    expect(reg.get('nova')!.task).toBe('Edit');
  });

  test('Notification about permission → needs-you; other → waiting', async () => {
    await hook('Notification', { message: 'Claude needs your permission to use Bash' });
    expect(reg.get('nova')!.status).toBe('needs-you');
    expect(reg.needs().map(n => n.kind)).toEqual(['permission']);
    await hook('Notification', { message: 'Claude is waiting for your input' });
    expect(reg.get('nova')!.status).toBe('waiting');
    expect(reg.needs().map(n => n.kind)).toEqual(['waiting']);
  });

  test('flow view: TodoWrite and tool calls build the steps and emit them', async () => {
    const events: string[] = [];
    reg.addEventListener('event', e => events.push((e as CustomEvent).detail.t));
    await hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [
      { content: 'Read', status: 'completed', activeForm: 'Reading' },
      { content: 'Fix', status: 'in_progress', activeForm: 'Fixing' }] } });
    await hook('PreToolUse', bash('bun test'));
    let t = reg.stepsOf('nova');
    expect(t.steps.map(s => s.status)).toEqual(['completed', 'in_progress']);
    expect(t.steps[1]!.tools.map(c => [c.tool, c.detail, c.end])).toEqual([['Bash', 'bun test', undefined]]);
    await hook('PostToolUse', bash('bun test'));
    t = reg.stepsOf('nova');
    expect(t.steps[1]!.tools[0]!.end).toBeNumber();
    expect(events).toContain('steps');
    expect(reg.snapshot().state.steps?.nova?.steps).toHaveLength(2);
  });

  test('flow view: TaskCreate takes its id from the response; TaskUpdate moves it', async () => {
    await hook('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Fix' }, tool_response: 'Task #4 created successfully: Fix' });
    await hook('PreToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '4', status: 'in_progress' } });
    expect(reg.stepsOf('nova').steps).toMatchObject([{ key: '4', text: 'Fix', status: 'in_progress' }]);
  });

  test('flow view: a Markdown checklist in the transcript becomes the steps', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'ac-tr-')), 't.jsonl');
    const asst = (text: string) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } }) + '\n';
    writeFileSync(f, asst('- [ ] 1. Read\n- [ ] 2. Fix'));
    await hook('PreToolUse', { ...bash('ls'), transcript_path: f });
    let t = reg.stepsOf('nova');
    expect(t.source).toBe('chat');
    expect(t.steps.map(s => s.status)).toEqual(['in_progress', 'pending']);
    expect(t.steps[0]!.tools.map(c => c.detail)).toEqual(['ls']);
    appendFileSync(f, asst('- [x] 1. Read → 3 files'));
    await hook('Stop', { transcript_path: f });
    t = reg.stepsOf('nova');
    expect(t.steps[0]).toMatchObject({ status: 'completed', note: '3 files' });
  });

  test('flow view: removing a worker drops its steps', async () => {
    await hook('UserPromptSubmit', { prompt: 'go' });
    expect(reg.stepsOf('nova').steps).toHaveLength(1);
    await reg.remove('nova');
    expect(reg.snapshot().state.steps?.nova).toBeUndefined();
  });

  test('I2: PreToolUse marks a tool in flight; PostToolUse ends it and flushes', async () => {
    await hook('PreToolUse', bash('ls'));
    expect(await reg.deliver('advisor', 'nova', 'hi')).toBe('queued');
    await hook('PostToolUse', bash('ls'));
    await Bun.sleep(10);
    expect(tmux.of('sendText').map(c => c.args[1])).toEqual(['[from advisor] hi']);
  });

  test('I2: an idle-input notification flushes; another dialog notification does not', async () => {
    await hook('Notification', { message: 'Claude needs your approval for the plan' });
    expect(await reg.deliver('advisor', 'nova', 'q')).toBe('sent'); // 'waiting' is not busy by itself…
    tmux.calls.length = 0;
    reg.setStatus('nova', 'needs-you');
    await reg.deliver('advisor', 'nova', 'later');
    await hook('Notification', { message: 'Claude needs your approval for the plan' });
    await Bun.sleep(10);
    expect(tmux.of('sendText').length).toBe(0); // …but a dialog notification must not flush the queue
    await hook('Notification', { message: 'Claude is waiting for your input' });
    await Bun.sleep(10);
    expect(tmux.of('sendText').map(c => c.args[1])).toEqual(['[from advisor] later']);
  });

  test('Stop → done and clears permission/waiting needs', async () => {
    await hook('Notification', { message: 'needs your permission' });
    await hook('Stop');
    expect(reg.get('nova')!.status).toBe('done');
    expect(reg.needs()).toEqual([]);
  });

  test('SessionEnd → stopped', async () => {
    await hook('SessionEnd');
    expect(reg.get('nova')!.status).toBe('stopped');
  });

  test('guarded PreToolUse waits for Allow', async () => {
    cfg.hookTimeoutSec = 5;
    const p = hook('PreToolUse', bash('git push origin main'));
    await Bun.sleep(5);
    const need = reg.needs()[0]!;
    expect(need).toMatchObject({ kind: 'guard', text: 'Allow: git push origin main', id: 'nova' });
    expect(reg.get('nova')!.status).toBe('needs-you');
    reg.resolveNeed(need.nid, 'allow');
    expect(await p).toEqual({ output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } });
    expect(reg.get('nova')!.status).toBe('running');
  });

  test('guarded PreToolUse returns deny with a reason', async () => {
    cfg.hookTimeoutSec = 5;
    const p = hook('PreToolUse', bash('git push'));
    await Bun.sleep(5);
    reg.resolveNeed(reg.needs()[0]!.nid, 'deny');
    expect(await p).toEqual({ output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Denied in Agent Console' } } });
  });

  test('guarded PreToolUse with no answer → ask', async () => {
    const out = await hook('PreToolUse', bash('terraform apply'));
    expect((out.output as any).hookSpecificOutput.permissionDecision).toBe('ask');
    expect(reg.needs()).toEqual([]);
  });

  test('config guard patterns apply', async () => {
    cfg.guardPatterns = ['\\bnpm publish\\b'];
    const out = await hook('PreToolUse', bash('npm publish'));
    expect((out.output as any).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  test('unknown worker id → empty result', async () => {
    expect(await handleHook(reg, cfg, { event: 'Stop', id: 'nobody', payload: {} })).toEqual({});
  });

  test('hook for a worker with an unknown agent → {} and no change', async () => {
    reg.update('nova', { agent: 'nope' });
    const before = JSON.stringify(reg.get('nova'));
    expect(await hook('UserPromptSubmit', { prompt: 'x' })).toEqual({});
    expect(JSON.stringify(reg.get('nova'))).toBe(before);
  });

  test('claude: no answer keeps the terminal hint in the reason', async () => {
    const out = await hook('PreToolUse', bash('terraform apply'));
    expect((out.output as any).hookSpecificOutput.permissionDecisionReason).toBe('No answer in Agent Console; asking in the terminal');
  });

  test('unknown event → {} and no change', async () => {
    const before = JSON.stringify(reg.get('nova'));
    expect(await hook('PreCompact', {})).toEqual({});
    expect(JSON.stringify(reg.get('nova'))).toBe(before);
  });
});
