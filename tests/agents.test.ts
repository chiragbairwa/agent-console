import { beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, adapterOf } from '../src/agents';
import type { Worker } from '../src/types';

beforeEach(() => { process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-ag-')); });

const worker = (over: Partial<Worker> = {}): Worker => ({
  id: 'nova', name: 'Nova', role: 'worker', cwd: '/r/Acme.Nova', repo: 'Acme.Nova',
  status: 'idle', task: '', x: 0, y: 0, ...over,
});

test('adapterOf: missing agent → claude', () => expect(adapterOf({}).id).toBe('claude'));
test('adapterOf: unknown agent throws', () => expect(() => adapterOf({ agent: 'nope' })).toThrow('unknown agent: nope'));
test('claude launch: cmd starts with claude and carries settings + mcp config', () => {
  const l = ADAPTERS.claude!.launch({ w: worker(), dir: '', url: 'http://x', token: 't', bin: ['/b'], resume: false, options: {}, inheritedOtelAttrs: '' });
  expect(l.cmd[0]).toBe('claude');
  expect(l.cmd).toContain('--settings');
  expect(l.cmd).toContain('--mcp-config');
});
test('claude launch: advisor gets the rules', () => {
  const l = ADAPTERS.claude!.launch({ w: worker({ id: 'advisor', role: 'advisor' }), dir: '', url: 'u', token: 't', bin: ['/b'], resume: false, options: {}, rules: 'RULES' });
  expect(l.cmd.slice(l.cmd.indexOf('--append-system-prompt'))).toEqual(['--append-system-prompt', 'RULES']);
});

const h = (e: string, p: object) => ADAPTERS.claude!.hook(e, p);
test('claude hook: SessionStart', () => expect(h('SessionStart', { session_id: 's', transcript_path: '/t' })).toEqual({ t: 'start', sessionId: 's', transcript: '/t' }));
test('claude hook: Bash PreToolUse carries shell', () => expect(h('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })).toMatchObject({ t: 'toolStart', tool: 'Bash', shell: 'ls' }));
test('claude hook: Edit PreToolUse has no shell', () => expect((h('PreToolUse', { tool_name: 'Edit', tool_input: {} }) as any).shell).toBeUndefined());
test('claude hook: idle notice', () => expect(h('Notification', { message: 'Claude is waiting for your input' })).toMatchObject({ t: 'notice', idle: true, permission: false }));
test('claude hook: permission notice', () => expect(h('Notification', { message: 'Claude needs your permission to use Bash' })).toMatchObject({ permission: true, idle: false }));
test('claude hook: unknown event → null', () => expect(h('PreCompact', {})).toBeNull());
test('claude guardReply: deny', () => expect(ADAPTERS.claude!.guardReply('deny', 'x')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } }));
test('claude rules: unchanged', () => expect(ADAPTERS.claude!.rules!('advisor', 'BASE')).toBe('BASE'));

test('contract: every adapter', () => {
  for (const a of Object.values(ADAPTERS)) {
    if (a.caps.guard) expect(a.caps.hooks).toBe(true);
    if (a.caps.advisor) expect(a.caps.mcp).toBe(true);
    expect(a.hook('UnknownEvent', {})).toBeNull();
    const l = a.launch({ w: worker({ agent: a.id }), dir: '', url: 'http://x', token: 't', bin: ['/b'], resume: false, options: {}, inheritedOtelAttrs: '' });
    expect(l.cmd.length).toBeGreaterThan(0);
    expect(l.cmd[0]).toBe(a.bin);
  }
});
