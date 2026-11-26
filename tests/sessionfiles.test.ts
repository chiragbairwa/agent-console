import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASH_FAILSAFE, CURL_POST, sessionFiles } from '../src/sessionfiles';
import { projectSlug } from '../src/agents/claude';
import { homedir } from 'node:os';
import { loadConfig } from '../src/store';
import type { Worker } from '../src/types';

beforeEach(() => { process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-sf-')); });

const worker = (over: Partial<Worker> = {}): Worker => ({
  id: 'nova', name: 'Nova', role: 'worker', cwd: '/r/Acme.Nova', repo: 'Acme.Nova',
  status: 'idle', task: '', x: 0, y: 0, ...over,
});
const base = { bin: ['/bin/agent-console'], url: 'http://127.0.0.1:7878', token: 't0k' };

describe('sessionFiles', () => {
  test('env carries the console variables', () => {
    const sf = sessionFiles(worker(), loadConfig(), { ...base });
    expect(sf.env).toEqual({ AC_URL: base.url, AC_TOKEN: 't0k', AC_ID: 'nova', AC_ROLE: 'worker' });
  });

  test('settings env appends agent attributes to the inherited OTel attributes', () => {
    const sf = sessionFiles(worker(), loadConfig(), { ...base, inheritedOtelAttrs: 'a=b' });
    const s = JSON.parse(readFileSync(sf.settingsPath, 'utf8'));
    expect(s.env.OTEL_RESOURCE_ATTRIBUTES).toBe('a=b,agent.role=worker,agent.name=nova,agent.repo=Acme.Nova');
  });

  test('no leading comma when nothing is inherited', () => {
    const sf = sessionFiles(worker(), loadConfig(), { ...base, inheritedOtelAttrs: '' });
    const s = JSON.parse(readFileSync(sf.settingsPath, 'utf8'));
    expect(s.env.OTEL_RESOURCE_ATTRIBUTES).toBe('agent.role=worker,agent.name=nova,agent.repo=Acme.Nova');
  });

  test('settings register all eight hook events; PreToolUse has a 600 s timeout', () => {
    const sf = sessionFiles(worker(), loadConfig(), { ...base });
    const s = JSON.parse(readFileSync(sf.settingsPath, 'utf8'));
    expect(Object.keys(s.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
    const pre = s.hooks.PreToolUse[0].hooks[0];
    expect(pre).toEqual({ type: 'http', url: `${base.url}/hook/PreToolUse`, headers: { 'x-ac-token': base.token, 'x-ac-id': worker().id }, timeout: 600 });
    expect(s.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'http', url: `${base.url}/hook/Stop`, timeout: 10 });
    // Claude Code skips HTTP hooks on SessionStart: curl posts that one.
    expect(s.hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: CURL_POST('SessionStart'), timeout: 10 });
    // No hook starts the console binary any more.
    expect(JSON.stringify(s.hooks)).not.toContain('agent-console');
  });

  test('Bash gets a curl fail-safe: "ask" when the console does not answer', () => {
    const s = JSON.parse(readFileSync(sessionFiles(worker(), loadConfig(), { ...base }).settingsPath, 'utf8'));
    expect(s.hooks.PreToolUse[1]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: BASH_FAILSAFE, timeout: 10 }] });
  });

  test('fail-safe limits: 2 s to connect, 8 s in total (inside the 10 s hook timeout)', () => {
    expect(BASH_FAILSAFE).toContain('--connect-timeout 2');
    expect(BASH_FAILSAFE).toContain('--max-time 8');
  });

  // Async: a sync spawn would block the event loop, and the test server below could not answer.
  const runFailsafe = async (url: string) => {
    const p = Bun.spawn(['sh', '-c', BASH_FAILSAFE], { env: { ...process.env, AC_URL: url, AC_TOKEN: 't' }, stdout: 'pipe' });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { code, out };
  };

  test('fail-safe, console down: prints an "ask" decision and exits 0', async () => {
    const r = await runFailsafe('http://127.0.0.1:1');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' });
  });

  test('SessionStart curl posts stdin with the token and id; console down still exits 0', async () => {
    let got: { id: string | null; body: unknown } | null = null;
    const srv = Bun.serve({ port: 0, async fetch(req) { got = { id: req.headers.get('x-ac-id'), body: await req.json() }; return Response.json({}); } });
    try {
      const run = async (url: string) => {
        const p = Bun.spawn(['sh', '-c', CURL_POST('SessionStart')], { env: { ...process.env, AC_URL: url, AC_TOKEN: 't', AC_ID: 'w1' }, stdin: new TextEncoder().encode('{"session_id":"abc"}') });
        return p.exited;
      };
      expect(await run(`http://127.0.0.1:${srv.port}`)).toBe(0);
      expect(got as unknown).toEqual({ id: 'w1', body: { session_id: 'abc' } });
      expect(await run('http://127.0.0.1:1')).toBe(0);
    } finally { srv.stop(true); }
  });

  // A busy machine can make the console slow for a few seconds. Slow is not down: no "ask".
  test('fail-safe, console slow (3 s) but up: prints nothing', async () => {
    const srv = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(3000); return Response.json({ ok: true }); } });
    try { expect(await runFailsafe(`http://127.0.0.1:${srv.port}`)).toEqual({ code: 0, out: '' }); }
    finally { srv.stop(true); }
  }, 10_000);

  test('fail-safe, console up: prints nothing', async () => {
    const srv = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
    try { expect(await runFailsafe(`http://127.0.0.1:${srv.port}`)).toEqual({ code: 0, out: '' }); }
    finally { srv.stop(true); }
  });

  test('mcp config points at the console over HTTP: no helper process', () => {
    const sf = sessionFiles(worker(), loadConfig(), { bin: ['bun', '/src/cli.ts'], url: base.url, token: 't0k' });
    const m = JSON.parse(readFileSync(sf.mcpPath, 'utf8'));
    expect(m.mcpServers['agent-console']).toEqual({ type: 'http', url: `${base.url}/mcp`, headers: { 'x-ac-token': 't0k', 'x-ac-id': worker().id } });
  });

  test('args: settings and mcp for a worker; advisor gets the system prompt', () => {
    const w = sessionFiles(worker(), loadConfig(), { ...base });
    expect(w.args).toEqual(['--settings', w.settingsPath, '--mcp-config', w.mcpPath]);
    const a = sessionFiles(worker({ id: 'advisor', role: 'advisor' }), loadConfig(), { ...base, advisorPrompt: 'ROLE' });
    expect(a.args).toContain('--append-system-prompt');
    expect(a.args[a.args.indexOf('--append-system-prompt') + 1]).toBe('ROLE');
    const r = sessionFiles(worker({ id: 'reviewer', role: 'reviewer' }), loadConfig(), { ...base, advisorPrompt: 'REV' });
    expect(r.args[r.args.indexOf('--append-system-prompt') + 1]).toBe('REV');
  });

  test('resume uses the known session id when its transcript exists, else --continue', () => {
    expect(sessionFiles(worker({ sessionId: 'abc' }), loadConfig(), { ...base, resume: true, hasTranscript: () => true }).args).toContain('abc');
    expect(sessionFiles(worker(), loadConfig(), { ...base, resume: true }).args).toContain('--continue');
  });

  test('a template adds its permission mode and first prompt', () => {
    const sf = sessionFiles(worker(), loadConfig(), { ...base, template: { name: 'qa', prompt: 'Run QA', permissionMode: 'plan' } });
    expect(sf.args.slice(-4)).toEqual(['--permission-mode', 'plan', '--', 'Run QA']);
  });
});

describe('sessionFiles fileDir', () => {
  test('fileDir puts the remote paths in the args; the local files are still written', () => {
    const sf = sessionFiles(worker(), loadConfig(), { ...base, fileDir: '/Users/me/.config/agent-console/sessions/nova' });
    expect(sf.args.slice(0, 4)).toEqual(['--settings', '/Users/me/.config/agent-console/sessions/nova/settings.json',
      '--mcp-config', '/Users/me/.config/agent-console/sessions/nova/mcp.json']);
    expect(readFileSync(sf.settingsPath, 'utf8')).toContain('hooks');
  });
});

describe('resume of a session with no transcript', () => {
  const { findTranscript, claudeConfigDir } = require('../src/agents/claude') as typeof import('../src/agents/claude');
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const mkBase = () => {
    const b = mkdtempSync(join(tmpdir(), 'ac-cc-'));
    mkdirSync(join(b, 'projects', '-r-Acme-Nova'), { recursive: true });
    mkdirSync(join(b, 'projects', '-private-tmp-other'), { recursive: true });
    return b;
  };

  test('projectSlug replaces each character that is not a letter or a digit with "-"', () => {
    expect(projectSlug('/home/a/b.c')).toBe('-home-a-b-c');
  });

  test('claudeConfigDir honours CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/cc' })).toBe('/cc');
    expect(claudeConfigDir({})).toBe(join(homedir(), '.claude'));
  });

  test('findTranscript finds <id>.jsonl in any project folder (a symlinked or shortened cwd gives another name)', () => {
    const b = mkBase();
    writeFileSync(join(b, 'projects', '-private-tmp-other', 'abc.jsonl'), '{}\n');
    expect(findTranscript('abc', { base: b })).toBe(join(b, 'projects', '-private-tmp-other', 'abc.jsonl'));
    expect(findTranscript('zzz', { base: b })).toBeNull();
    expect(findTranscript('../x', { base: b })).toBeNull();
    expect(findTranscript('abc', { base: join(b, 'missing') })).toBeNull();
  });

  test('the default check uses CLAUDE_CONFIG_DIR', () => {
    const b = mkBase();
    writeFileSync(join(b, 'projects', '-r-Acme-Nova', 'abc.jsonl'), '{}\n');
    const old = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = b;
    try {
      const args = sessionFiles(worker({ sessionId: 'abc' }), loadConfig(), { ...base, resume: true }).args;
      expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'abc']);
      const fresh = sessionFiles(worker({ sessionId: 'nope' }), loadConfig(), { ...base, resume: true }).args;
      expect(fresh).not.toContain('--resume');
      expect(fresh).not.toContain('--continue');
    } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; }
  });

  test('an injected check: a transcript resumes, none starts fresh', () => {
    let asked = '';
    const args = sessionFiles(worker({ sessionId: 'abc' }), loadConfig(), { ...base, resume: true, hasTranscript: id => { asked = id; return true; } }).args;
    expect(args).toContain('--resume');
    expect(asked).toBe('abc');
    const fresh = sessionFiles(worker({ sessionId: 'abc' }), loadConfig(), { ...base, resume: true, hasTranscript: () => false }).args;
    expect(fresh).not.toContain('--resume');
    expect(fresh).not.toContain('--continue');
  });

  test('a remote worker keeps --resume (its transcript is on the host)', () => {
    const args = sessionFiles(worker({ sessionId: 'abc', host: 'mac' }), loadConfig(), { ...base, resume: true, fileDir: '/Users/me/x', hasTranscript: () => false }).args;
    expect(args).toContain('--resume');
  });
});
