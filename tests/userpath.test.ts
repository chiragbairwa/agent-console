import { describe, expect, test } from 'bun:test';
import { withUserBins } from '../src/paths';

describe('withUserBins', () => {
  const home = '/home/u';
  const all = () => true;

  test('adds the user bin folders a login shell has, when the PATH has none (desktop launch)', () => {
    const out = withUserBins('/usr/bin:/bin', { home, exists: all });
    expect(out.split(':')).toEqual(['/home/u/.local/bin', '/home/u/.bun/bin', '/home/u/.claude/local', '/usr/bin', '/bin']);
  });

  test('keeps the PATH as it is when the folders are already in it', () => {
    const p = '/home/u/.local/bin:/home/u/.bun/bin:/home/u/.claude/local:/usr/bin';
    expect(withUserBins(p, { home, exists: all })).toBe(p);
  });

  test('skips folders that do not exist', () => {
    const out = withUserBins('/usr/bin', { home, exists: d => d.endsWith('.local/bin') });
    expect(out).toBe('/home/u/.local/bin:/usr/bin');
  });
});
