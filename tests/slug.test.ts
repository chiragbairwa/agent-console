import { describe, expect, test } from 'bun:test';
import { resolveName, slugify, uniqueId } from '../src/slug';
import type { Worker } from '../src/types';

const w = (id: string, name: string): Worker =>
  ({ id, name, role: 'worker', cwd: '/', repo: '/', status: 'idle', task: '', x: 0, y: 0 });

describe('slug', () => {
  test('slugify lowercases and joins words with dashes', () => {
    expect(slugify('Web App')).toBe('web-app');
    expect(slugify('  Nova!! 2 ')).toBe('nova-2');
  });

  test('slugify of a name with no letters falls back to "worker"', () => {
    expect(slugify('!!!')).toBe('worker');
  });

  test('uniqueId adds a numeric suffix when taken', () => {
    expect(uniqueId('Nova', ['nova'])).toBe('nova-2');
    expect(uniqueId('Nova', ['nova', 'nova-2'])).toBe('nova-3');
    expect(uniqueId('Atlas', ['nova'])).toBe('atlas');
  });

  test('resolveName finds a worker by id, name, compact name or unique prefix', () => {
    const ws = [w('web-app', 'Web App'), w('nova', 'Nova'), w('advisor', 'Advisor')];
    for (const q of ['web-app', 'Web App', 'webapp', 'WEB']) expect(resolveName(q, ws)?.id).toBe('web-app');
    expect(resolveName('@nova', ws)?.id).toBe('nova');
  });

  test('resolveName returns undefined for an ambiguous prefix or no match', () => {
    const ws = [w('nova', 'Nova'), w('nova-2', 'Nova 2')];
    expect(resolveName('sim', ws)).toBeUndefined();
    expect(resolveName('zzz', ws)).toBeUndefined();
  });
});
