import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADVISOR_PROMPT, REVIEWER_PROMPT, advisorPrompt, ensureAdvisor } from '../src/advisor';
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
  test('advisor prompt mentions other machines', () => {
    expect(ADVISOR_PROMPT).toContain('Workers can run on other machines. The host of each worker is in list_connections.');
  });
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

describe('ensureAdvisor and the reviewer', () => {
  const rmk = (cfg = loadConfig()) => new Registry(tmux.asTmux(), cfg, { bin: ['/b'], url: 'u', token: 't', inheritedOtelAttrs: '', advisorPrompt: ADVISOR_PROMPT, reviewerPrompt: REVIEWER_PROMPT });

  test('REVIEWER_PROMPT: read-only, advises the lead, no orders', () => {
    expect(REVIEWER_PROMPT).toContain('REVIEWER');
    expect(REVIEWER_PROMPT).toContain('list_workers');
    expect(REVIEWER_PROMPT).toContain('read_worker');
    expect(REVIEWER_PROMPT).toContain('advise');
    expect(REVIEWER_PROMPT).not.toContain('send_to_worker');
  });

  test('does not create a reviewer when none exists', async () => {
    const cfg = loadConfig();
    const r = rmk(cfg);
    await ensureAdvisor(r, cfg);
    expect(r.get('reviewer')).toBeUndefined();
  });

  test('restarts a stopped reviewer with its own agent and resume, and restores its link', async () => {
    const cfg = { ...loadConfig(), advisorAgent: 'claude' };
    const r = rmk(cfg);
    await ensureAdvisor(r, cfg);
    await r.addReviewer('codex');
    r.update('reviewer', { sessionId: 'cx-7' });
    await r.stop('reviewer');
    // The link is missing, and the user did not cut it.
    (r as any).state.links = (r as any).state.links.filter((l: any) => l.a !== 'reviewer' && l.b !== 'reviewer');
    expect(r.linked('advisor', 'reviewer')).toBe(false);
    await ensureAdvisor(r, cfg);
    const cmd = tmux.of('newSession').at(-1)!.args[3] as string[];
    expect(cmd[0]).toBe('codex');
    expect(cmd.slice(cmd.indexOf('resume'))).toContain('cx-7');
    expect(r.get('reviewer')!.status).not.toBe('stopped');
    expect(r.linked('advisor', 'reviewer')).toBe(true);
  });

  test('the link is restored when it is missing, and the reviewer never links to a worker', async () => {
    const cfg = loadConfig();
    const r = rmk(cfg);
    await ensureAdvisor(r, cfg);
    await r.addReviewer('claude');
    const w = await r.spawn({ name: 'Nova', repo: '/r/b' });
    (r as any).state.links = (r as any).state.links.filter((l: any) => l.a !== 'reviewer' && l.b !== 'reviewer');
    expect(r.linked('advisor', 'reviewer')).toBe(false);
    await ensureAdvisor(r, cfg);
    expect(r.linked('advisor', 'reviewer')).toBe(true);
    expect(r.linked('reviewer', w.id)).toBe(false);
  });

  test('a failing reviewer restart does not block the advisor-worker links', async () => {
    const cfg = loadConfig();
    const r = rmk(cfg);
    await ensureAdvisor(r, cfg);
    ADAPTERS.stub = { ...ADAPTERS.codex!, id: 'stub', label: 'Stub' };
    await r.addReviewer('stub');
    const w = await r.spawn({ name: 'Nova', repo: '/r/b' });
    await r.stop('reviewer');
    (r as any).state.links = (r as any).state.links.filter((l: any) => l.b !== w.id && l.a !== w.id);
    delete ADAPTERS.stub;
    await ensureAdvisor(r, cfg);
    expect(r.linked('advisor', w.id)).toBe(true);
    expect(r.snapshot().state.activity.some(a => a.text.startsWith('Reviewer did not restart: '))).toBe(true);
  });
});
