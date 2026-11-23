import { describe, expect, test } from 'bun:test';
import { loadCanvas, saveCanvas, KEY } from '../web/restore';
import { waitForPage } from '../src/serve';

class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }

describe('last canvas', () => {
  test('saves and loads the view, the selection and the open focus', () => {
    const s = new Mem();
    saveCanvas(s, { view: { x: 10, y: -20, z: 0.8 }, sel: ['a', 'b'], focus: 'a' });
    expect(loadCanvas(s)).toEqual({ view: { x: 10, y: -20, z: 0.8 }, sel: ['a', 'b'], focus: 'a' });
  });

  test('returns null for nothing saved, broken JSON, or a bad view', () => {
    expect(loadCanvas(new Mem())).toBeNull();
    const s = new Mem(); s.setItem(KEY, '{nope'); expect(loadCanvas(s)).toBeNull();
    s.setItem(KEY, JSON.stringify({ view: { x: 1, y: 2, z: 0 } })); expect(loadCanvas(s)).toBeNull();
    s.setItem(KEY, JSON.stringify({ view: { x: 'a', y: 2, z: 1 } })); expect(loadCanvas(s)).toBeNull();
  });

  test('drops odd selection and focus values but keeps the view', () => {
    const s = new Mem(); s.setItem(KEY, JSON.stringify({ view: { x: 1, y: 2, z: 1 }, sel: [1, 'ok'], focus: 5 }));
    expect(loadCanvas(s)).toEqual({ view: { x: 1, y: 2, z: 1 }, sel: ['ok'], focus: null });
  });

  test('blocked storage does not throw', () => {
    const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(loadCanvas(bad)).toBeNull();
    expect(() => saveCanvas(bad, { view: { x: 0, y: 0, z: 1 }, sel: [], focus: null })).not.toThrow();
  });
});

describe('waitForPage', () => {
  test('true as soon as an old page reconnects', async () => {
    let n = 0; setTimeout(() => { n = 1; }, 100);
    const t0 = Date.now();
    expect(await waitForPage(() => n, 2000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  test('false when no page comes back in time', async () => {
    expect(await waitForPage(() => 0, 200)).toBe(false);
  });
});
