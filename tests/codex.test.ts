import { expect, test } from 'bun:test';
import { ADVISOR_PROMPT } from '../src/advisor';
import { CODEX_EVENTS, codex, codexPreToolUse } from '../src/agents/codex';
import type { LaunchInput } from '../src/agents/types';
import type { Worker } from '../src/types';

const worker = (over: Partial<Worker> = {}): Worker => ({
  id: 'cx', name: 'Cx', role: 'worker', cwd: '/r/x', repo: 'x',
  status: 'idle', task: '', x: 0, y: 0, agent: 'codex', ...over,
});
const input = (over: Partial<LaunchInput> = {}): LaunchInput => ({
  w: worker(), dir: '', url: 'http://u', token: 'tok', bin: ['codex'], resume: false, options: {}, ...over,
});
const cValues = (cmd: string[]) => cmd.flatMap((a, k) => (cmd[k - 1] === '-c' ? [a] : []));

test('launch: flags first', () => {
  expect(codex.launch(input()).cmd.slice(0, 3)).toEqual(
    ['codex', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust']);
});
test('launch: env', () => {
  expect(codex.launch(input()).env).toEqual({ AC_URL: 'http://u', AC_TOKEN: 'tok', AC_ID: 'cx', AC_ROLE: 'worker' });
});
test('launch: update check off and mcp config', () => {
  const v = cValues(codex.launch(input()).cmd);
  expect(v).toContain('check_for_update_on_startup=false');
  expect(v).toContain('mcp_servers.agent-console.url="http://u/mcp"');
  expect(v).toContain('mcp_servers.agent-console.env_http_headers={ "x-ac-token" = "AC_TOKEN", "x-ac-id" = "AC_ID" }');
  expect(v).toContain('mcp_servers.agent-console.tool_timeout_sec=1800');
});
test('launch: the token is not on the command line', () => {
  const { cmd, env } = codex.launch(input());
  expect(cmd.some(a => a.includes('tok"') || a.includes('"tok'))).toBe(false);
  expect(cmd.some(a => a.includes('http_headers={'))).toBe(cmd.some(a => a.includes('env_http_headers')));
  expect(cmd.join(' ')).not.toMatch(/(^|[^_])http_headers/);
  expect(env.AC_TOKEN).toBe('tok');
});
test('launch: one -c hooks item per event', () => {
  const hooks = cValues(codex.launch(input()).cmd).filter(v => v.startsWith('hooks.'));
  expect(hooks.length).toBe(5);
  expect(CODEX_EVENTS.length).toBe(5);
  for (const ev of CODEX_EVENTS) {
    const item = hooks.find(v => v.startsWith(`hooks.${ev}=`))!;
    expect(item).toBeDefined();
    if (ev === 'PreToolUse') { expect(item).toContain('timeout=600'); expect(item).toContain('--max-time 600'); }
    else expect(item).toContain('timeout=10');
  }
});
test('launch: TOML values survive quotes', () => {
  const weird = 'a"b\\c\nd';
  const { cmd } = codex.launch(input({ options: { model: weird } }));
  expect(cmd).toContain(`model=${JSON.stringify(weird)}`);
});
test('launch: no model/reasoning when unset', () => {
  const v = cValues(codex.launch(input()).cmd);
  expect(v.some(x => x.startsWith('model='))).toBe(false);
  expect(v.some(x => x.startsWith('model_reasoning_effort='))).toBe(false);
});
test('launch: model and reasoning when set', () => {
  const v = cValues(codex.launch(input({ options: { model: 'm1', reasoning: 'high' } })).cmd);
  expect(v).toContain('model="m1"');
  expect(v).toContain('model_reasoning_effort="high"');
});
test('launch: resume <id> when resume and sessionId', () => {
  const { cmd } = codex.launch(input({ resume: true, w: worker({ sessionId: 'sid1' }) }));
  expect(cmd.slice(-2)).toEqual(['resume', 'sid1']);
});
test('launch: no resume without sessionId or without resume flag', () => {
  expect(codex.launch(input({ resume: true })).cmd).not.toContain('resume');
  expect(codex.launch(input({ w: worker({ sessionId: 's' }) })).cmd).not.toContain('resume');
  expect(codex.launch(input({ resume: true })).cmd).not.toContain('--last');
});
test('launch: rules only for advisor', () => {
  const adv = codex.launch(input({ w: worker({ role: 'advisor' }), rules: 'R"1' })).cmd;
  expect(adv).toContain(`developer_instructions=${JSON.stringify('R"1')}`);
  const wk = codex.launch(input({ rules: 'R' })).cmd;
  expect(wk.some(a => a.startsWith('developer_instructions='))).toBe(false);
});
test('launch: template prompt is last', () => {
  const { cmd } = codex.launch(input({ resume: true, w: worker({ sessionId: 's' }),
    template: { prompt: 'do it', permissionMode: 'plan' } as any }));
  expect(cmd.slice(-3)).toEqual(['resume', 's', 'do it']);
  expect(cmd).not.toContain('--permission-mode');
});

const h = (e: string, p: object) => codex.hook(e, p);
test('hook mapping', () => {
  expect(h('SessionStart', { session_id: 's', transcript_path: '/t' })).toEqual({ t: 'start', sessionId: 's' });
  expect(h('UserPromptSubmit', { prompt: 'hi' })).toEqual({ t: 'prompt', text: 'hi' });
  expect(h('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }))
    .toEqual({ t: 'toolStart', tool: 'Bash', input: { command: 'ls' }, shell: 'ls' });
  expect(h('PreToolUse', { tool_name: 'mcp__agent_console__list_connections', tool_input: {} }))
    .toEqual({ t: 'toolStart', tool: 'mcp__agent_console__list_connections', input: {}, shell: undefined });
  expect(h('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'x\n' }))
    .toEqual({ t: 'toolEnd', tool: 'Bash', input: { command: 'ls' }, output: 'x\n' });
  expect(h('PermissionRequest', {})).toEqual({ t: 'notice', text: '', permission: true, idle: false });
  expect(h('Stop', { last_assistant_message: 'x' })).toEqual({ t: 'stop' });
  expect(h('PreCompact', {})).toBeNull();
});
test('guardReply: ask becomes deny', () => {
  expect(codex.guardReply('ask', 'x')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } });
  // Codex rejects permissionDecision allow, and an empty object means allow.
  expect(codex.guardReply('allow')).toEqual({});
  expect(codex.guardReply('deny', 'n')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'n' } });
});
test('rules: removes the SendMessage line only', () => {
  const out = codex.rules!('advisor', ADVISOR_PROMPT);
  const before = ADVISOR_PROMPT.split('\n');
  expect(before.some(l => l.includes('SendMessage'))).toBe(true);
  expect(out.includes('SendMessage')).toBe(false);
  expect(out.split('\n')).toEqual(before.filter(l => !l.includes('SendMessage')));
});
test('no checklist, no chat', () => {
  expect(codex.checklist).toBeUndefined();
  expect(codex.chat).toBeUndefined();
});

const runHook = async (url: string, stdin = '{}') => {
  const p = Bun.spawn(['sh', '-c', codexPreToolUse()], {
    stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, AC_URL: url, AC_TOKEN: 't', AC_ID: 'cx' },
  });
  const out = await new Response(p.stdout).text();
  return { out, code: await p.exited };
};
test('fail-closed hook, console down', async () => {
  const r = await runHook('http://127.0.0.1:1');
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny');
});
test('fail-closed hook, console up', async () => {
  let body: object = {};
  const srv = Bun.serve({ port: 0, fetch: () => Response.json(body) });
  try {
    const url = `http://127.0.0.1:${srv.port}`;
    expect((await runHook(url)).out.trim()).toBe('{}');
    body = codex.guardReply('deny', 'no');
    expect(JSON.parse((await runHook(url)).out)).toEqual(body);
  } finally { srv.stop(true); }
});
test.each([[403, 'Forbidden'], [500, 'oops']])('fail-closed hook, console answers HTTP %i', async (status, text) => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response(text, { status }) });
  try {
    const r = await runHook(`http://127.0.0.1:${srv.port}`);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny');
  } finally { srv.stop(true); }
});

test('guard timeout: codex denies with the neutral reason', () => {
  expect(codex.guardReply('ask', 'No answer in Agent Console')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No answer in Agent Console' } });
});
test('hookTimeoutSec 900 → PreToolUse limits 930', () => {
  const hooks = cValues(codex.launch(input({ hookTimeoutSec: 900 })).cmd).filter(v => v.startsWith('hooks.PreToolUse='));
  expect(hooks[0]).toContain('timeout=930');
  expect(hooks[0]).toContain('--max-time 930');
});
test('hookTimeoutSec default → 600', () => {
  const hooks = cValues(codex.launch(input()).cmd).filter(v => v.startsWith('hooks.PreToolUse='));
  expect(hooks[0]).toContain('timeout=600');
  expect(hooks[0]).toContain('--max-time 600');
  expect(codexPreToolUse()).toContain('--max-time 600');
});
test('hookTimeoutSec 590 (the config default) → 620', () => {
  expect(cValues(codex.launch(input({ hookTimeoutSec: 590 })).cmd).find(v => v.startsWith('hooks.PreToolUse='))).toContain('timeout=620');
});

test('trusts the box folder for this launch, for a folder with dots and spaces', () => {
  const cwd = '/tmp/a b/repo.dot test';
  const v = cValues(codex.launch(input({ w: { ...input().w, cwd } })).cmd);
  expect(v).toContain(`projects={ ${JSON.stringify(cwd)} = { trust_level = "trusted" } }`);
});
