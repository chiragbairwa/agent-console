import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nearestTop } from '../web/flow';

describe('flow box scroll', () => {
  // scrollIntoView also scrolls every scrollable parent, #vp included. #vp has overflow:hidden,
  // but a script can still scroll it. Then the focus view (inset:0 in #vp) moves up and the
  // canvas shows below it.
  test('flow.ts does not use scrollIntoView', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'web', 'flow.ts'), 'utf8');
    expect(src).not.toContain('scrollIntoView');
  });
  test('a step that is already visible keeps the scroll', () => {
    expect(nearestTop(100, 400, 150, 30)).toBe(100);
  });
  test('a step below the visible part scrolls down just enough', () => {
    expect(nearestTop(0, 400, 500, 30)).toBe(130);
  });
  test('a step above the visible part scrolls up to its top', () => {
    expect(nearestTop(300, 400, 120, 30)).toBe(120);
  });
});
