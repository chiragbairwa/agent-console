import { desktopDir } from '../src/paths';
import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getToken, loadConfig, loadState, rotateToken, saveState } from '../src/store';
import type { State } from '../src/types';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ac-store-')); process.env.AC_CONFIG_DIR = dir; });

describe('store', () => {
  test('loadConfig returns the defaults when no file exists', () => {
    const c = loadConfig();
    expect(c.port).toBe(7878);
    expect(c.hookTimeoutSec).toBe(590);
    expect(c.roots[0]).toBe(desktopDir()); // the Desktop: the same on every teammate's machine
    expect(c.advisorCwd).toBe(c.roots[0]!);
    expect(c.guardPatterns).toEqual([]);
  });

  test('loadConfig reads agents and defaultWorkerAgent', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ agents: { codex: { model: 'm', n: 3 } }, defaultWorkerAgent: 'codex' }));
    const c = loadConfig();
    expect(c.agents).toEqual({ codex: { model: 'm' } });
    expect(c.defaultWorkerAgent).toBe('codex');
    writeFileSync(join(dir, 'config.json'), '{}');
    expect(loadConfig().agents).toBeUndefined();
    expect(loadConfig().defaultWorkerAgent).toBeUndefined();
  });

  test('loadConfig merges a partial file over the defaults', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 9000, roots: ['/r'] }));
    const c = loadConfig();
    expect(c.port).toBe(9000);
    expect(c.advisorCwd).toBe('/r');
    expect(c.hookTimeoutSec).toBe(590);
  });

  test('getToken is stable and the file is mode 0600', () => {
    const a = getToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(getToken()).toBe(a);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
  });

  test('rotateToken gives a new token', () => {
    const a = getToken();
    expect(rotateToken()).not.toBe(a);
  });

  test('saveState then loadState round-trips', () => {
    const s: State = { workers: [], links: [{ a: 'advisor', b: 'nova', by: 'advisor' }], cut: ['x~y'], activity: [{ at: 1, text: 'hi' }] };
    saveState(s);
    expect(loadState()).toEqual(s);
  });

  test('steps survive a save and a load', () => {
    const s: State = { workers: [], links: [], cut: [], activity: [],
      steps: { nova: { source: 'todo', loose: [], steps: [{ key: '1', text: 'Fix', status: 'in_progress', startedAt: 5, tools: [] }] } } };
    saveState(s);
    expect(loadState()).toEqual(s);
  });

  test('saveState keeps only the last 500 activity items', () => {
    const activity = Array.from({ length: 600 }, (_, i) => ({ at: i, text: String(i) }));
    saveState({ workers: [], links: [], cut: [], activity });
    const got = loadState().activity;
    expect(got.length).toBe(500);
    expect(got[0]!.at).toBe(100);
  });

  test('a corrupt state file gives an empty state and is kept aside', () => {
    writeFileSync(join(dir, 'state.json'), '{not json');
    expect(loadState()).toEqual({ workers: [], links: [], cut: [], activity: [] });
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
    expect(readdirSync(dir).some(f => f.startsWith('state.json.bad-'))).toBe(true);
  });
  test('loadState moves claudeSessionId to sessionId', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ workers: [{ id: 'a', name: 'A', role: 'worker', cwd: '/r', repo: 'r',
      status: 'idle', task: '', x: 0, y: 0, claudeSessionId: 'sess-9' }], links: [], cut: [], activity: [] }));
    const w = loadState().workers[0]!;
    expect(w.sessionId).toBe('sess-9');
    expect('claudeSessionId' in w).toBe(false);
    expect(w.agent).toBeUndefined();
  });
});

test('loadConfig reads advisorAgent', () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ advisorAgent: 'codex' }));
  expect(loadConfig().advisorAgent).toBe('codex');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ advisorAgent: 5 }));
  expect(loadConfig().advisorAgent).toBeUndefined();
});
