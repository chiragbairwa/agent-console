import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADVISOR_PROMPT, advisorPrompt, ensureAdvisor } from '../src/advisor';
import { ADAPTERS } from '../src/agents';
import { loadConfig } from '../src/store';
import { Registry } from '../src/workers';
import { FakeTmux } from './fakes';

let tmux: FakeTmux;
beforeEach(() => {
  process.env.AC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ac-adv-'));
  tmux = new FakeTmux();
});
const mk = (cfg = loadConfig()) => new Registry(tmux.asTmux(), cfg, { bin: ['/b'], url: 'u', token: 't', inheritedOtelAttrs: '', advisorPrompt: ADVISOR_PROMPT });

describe('advisor rules text', () => {
  test('advisorPrompt lists every adapter id and says "Other agent sessions"', () => {
    const p = advisorPrompt(Object.keys(ADAPTERS));
    expect(p).toContain('Other agent sessions');
    expect(p).not.toContain('Claude Code sessions');
    for (const id of Object.keys(ADAPTERS)) expect(p).toContain(id);
    expect(p).toContain(`- spawn_worker takes an optional agent (${Object.keys(ADAPTERS).join(', ')}); list_workers shows the agent of each worker.`);
    expect(ADVISOR_PROMPT).toBe(p);
  });
});

describe('ensureAdvisor', () => {
  test('ensureAdvisor uses config.advisorAgent for a new advisor', async () => {
    const r = mk({ ...loadConfig(), advisorAgent: 'codex' });
    await ensureAdvisor(r, { ...loadConfig(), advisorAgent: 'codex' });
    expect(r.get('advisor')!.agent).toBe('codex');
    expect((tmux.of('newSession')[0]!.args[3] as string[])[0]).toBe('codex');
  });

  test('ensureAdvisor falls back when advisorAgent is unknown', async () => {
    const cfg = { ...loadConfig(), advisorAgent: 'nope' };
    const r = mk(cfg);
    await ensureAdvisor(r, cfg);
    expect((tmux.of('newSession')[0]!.args[3] as string[])[0]).toBe('claude');
    expect(r.snapshot().state.activity.map(a => a.text)).toContain('advisorAgent "nope" cannot be the advisor; using Claude');
  });

  test('ensureAdvisor falls back when the adapter has no caps.advisor', async () => {
    ADAPTERS.stub = { ...ADAPTERS.codex!, id: 'stub', label: 'Stub', caps: { ...ADAPTERS.codex!.caps, advisor: false } };
    try {
      const cfg = { ...loadConfig(), advisorAgent: 'stub' };
      const r = mk(cfg);
      await ensureAdvisor(r, cfg);
      expect(r.get('advisor')!.agent).not.toBe('stub');
      expect((tmux.of('newSession')[0]!.args[3] as string[])[0]).toBe('claude');
      expect(r.snapshot().state.activity.map(a => a.text)).toContain('advisorAgent "stub" cannot be the advisor; using Claude');
    } finally { delete ADAPTERS.stub; }
  });

  test('ensureAdvisor without advisorAgent starts claude', async () => {
    const r = mk();
    await ensureAdvisor(r, loadConfig());
    expect((tmux.of('newSession')[0]!.args[3] as string[])[0]).toBe('claude');
  });

  test('ensureAdvisor restarts a stopped codex advisor as codex with resume', async () => {
    const cfg = { ...loadConfig(), advisorAgent: 'claude' };
    const r = mk(cfg);
    await r.spawn({ name: 'Advisor', repo: '/r/a', role: 'advisor', agent: 'codex' });
    r.update('advisor', { sessionId: 'cx-9' });
    await r.stop('advisor');
    await ensureAdvisor(r, cfg);
    const cmd = tmux.of('newSession').at(-1)!.args[3] as string[];
    expect(cmd[0]).toBe('codex');
    expect(cmd.slice(cmd.indexOf('resume'))).toContain('cx-9');
  });
});
