import { expect, test } from 'bun:test';
import { $ } from 'bun';
import { shq, shJoin } from '../src/shq';

test('plain word stays readable', () => expect(shq('main')).toBe("'main'"));
test('single quote is escaped', () => expect(shq("it's")).toBe(`'it'\\''s'`));
test('command substitution is literal', async () => {
  const out = await $`sh -c ${'printf %s ' + shq('$(echo pwned) a b')}`.text();
  expect(out).toBe('$(echo pwned) a b');
});
test('shJoin quotes each arg', () => expect(shJoin(['git', '-C', '/a b'])).toBe("'git' '-C' '/a b'"));
