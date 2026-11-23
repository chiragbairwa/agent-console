import { describe, expect, test } from 'bun:test';
import { isGuarded } from '../src/guard';

describe('isGuarded', () => {
  test('matches push, pipeline runs, approvals and terraform apply', () => {
    for (const c of ['git push origin main', 'cd x && git push', 'az pipelines run --id 98',
      'terraform apply', 'az pipelines runs approve --id 4']) expect(isGuarded(c, [])).toBe(true);
  });

  test('does not match look-alike commands', () => {
    for (const c of ['git status', 'echo pushed', 'git pushd', 'terraform plan']) expect(isGuarded(c, [])).toBe(false);
  });

  test('extra patterns from config are applied', () => {
    expect(isGuarded('npm publish', [])).toBe(false);
    expect(isGuarded('npm publish', ['\\bnpm publish\\b'])).toBe(true);
  });

  test('an invalid extra pattern is ignored, not thrown', () => {
    expect(isGuarded('git status', ['('])).toBe(false);
  });
});
