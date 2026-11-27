import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version';
import { versionLabel } from '../web/version';

test('VERSION is the package.json version and the MCP server version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  expect(VERSION).toBe(pkg.version);
  expect(readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8')).toContain(`version: '${VERSION}'`);
});

describe('versionLabel', () => {
  test('same version: the plain version', () => {
    expect(versionLabel('0.6.0', '0.6.0')).toEqual({ text: 'v0.6.0', stale: false, title: 'Agent Console v0.6.0' });
  });
  test('no server version yet: the page version', () => {
    expect(versionLabel('0.6.0', undefined)).toMatchObject({ text: 'v0.6.0', stale: false });
  });
  test('the page is older than the server: ask for a reload', () => {
    expect(versionLabel('0.5.3', '0.6.0')).toEqual({ text: 'v0.5.3 · reload for v0.6.0', stale: true, title: 'This page is v0.5.3. The server is v0.6.0. Click to reload.' });
  });
});
