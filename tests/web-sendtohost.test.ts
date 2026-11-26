import { describe, expect, test } from 'bun:test';
import { previewLines, sendBody } from '../web/sendtohost';

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
