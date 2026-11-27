import { describe, expect, test } from 'bun:test';
import { previewLines, sendBody, sendBlockers } from '../web/sendtohost';

const pv = (o: object = {}) => ({ ahead: 3, dirtyFiles: 2, dirtyLines: 41, repoFound: true, checks: [], ...o });

describe('previewLines', () => {
  test('commits, changes and repo found', () => {
    expect(previewLines(pv())).toEqual(['3 commits ahead', '2 files · 41 lines changed', 'Repo found']);
  });
  test('singular, no changes, repo not found', () => {
    expect(previewLines(pv({ ahead: 1, dirtyFiles: 0, dirtyLines: 0, repoFound: false }))).toEqual(['1 commit ahead', 'No uncommitted changes', 'Repo not found']);
    expect(previewLines(pv({ dirtyFiles: 1, dirtyLines: 1 }))[1]).toBe('1 file · 1 line changed');
  });
});

describe('sendBody', () => {
  const f = { to: 'mac', branch: true, patch: false, briefOn: false, brief: '', folderOn: false, folder: '', stopSource: true };
  test('plain form omits brief and folder', () => {
    expect(sendBody(f)).toEqual({ to: 'mac', branch: true, patch: false, stopSource: true });
  });
  test('trims brief and folder; unchecked boxes drop them', () => {
    expect(sendBody({ ...f, briefOn: true, brief: '  go on  ', folderOn: true, folder: ' assets ' })).toEqual({ to: 'mac', branch: true, patch: false, stopSource: true, brief: 'go on', folder: 'assets' });
    expect(sendBody({ ...f, brief: 'x', folder: 'y' })).toEqual({ to: 'mac', branch: true, patch: false, stopSource: true });
  });
  test('empty trimmed values are omitted', () => {
    expect(sendBody({ ...f, briefOn: true, brief: '  ', folderOn: true, folder: '' })).not.toHaveProperty('brief');
  });
});

describe('sendBlockers', () => {
  const chk = (id: string, ok: boolean, warn?: boolean) => ({ id, ok, ...(warn ? { warn } : {}), text: `${id} text` });
  test('a missing repo blocks and names the repo folders', () => {
    expect(sendBlockers(pv({ repoFound: false, repo: 'app', host: 'Mac', roots: [] }))[0]).toBe('app is not on Mac: the host has no repo folders. Add one in the host profile (Edit).');
    expect(sendBlockers(pv({ repoFound: false, repo: 'app', host: 'Mac', roots: ['~/code'] }))[0]).toBe('app is not on Mac under ~/code.');
  });
  test('ssh, tmux, claude and tunnel failures block; warnings and a bad root do not', () => {
    const checks = [chk('ssh', false), chk('tmux', false), chk('claude', false), chk('tunnel', false), chk('login', true, true), chk('sleep', true, true), chk('roots', false)];
    expect(sendBlockers(pv({ agent: 'claude', checks }))).toEqual(['ssh text', 'tmux text', 'claude text', 'tunnel text']);
  });
  test('claude does not block a codex worker', () => {
    expect(sendBlockers(pv({ agent: 'codex', checks: [chk('claude', false)] }))).toEqual([]);
  });
});
