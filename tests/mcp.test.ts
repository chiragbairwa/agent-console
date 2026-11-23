import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

async function toolNames(role: string) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [cli, 'mcp'],
    env: { ...process.env, AC_ROLE: role, AC_ID: role === 'worker' ? 'nova' : role, AC_URL: 'http://127.0.0.1:1', AC_TOKEN: 't' } as Record<string, string>,
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map(t => t.name).sort();
}

describe('mcp server', () => {
  test('a worker sees only its two tools', async () => {
    expect(await toolNames('worker')).toEqual(['list_connections', 'send_message']);
  });

  test('the advisor sees the advisor tool set', async () => {
    expect(await toolNames('advisor')).toEqual(['ask_second_opinion', 'ask_user', 'connect', 'disconnect', 'interrupt_worker', 'list_workers',
      'read_worker', 'send_to_worker', 'spawn_worker', 'stop_worker']);
  });
});

describe('mcp server roles', () => {
  test('the reviewer sees exactly three tools', async () => {
    expect(await toolNames('reviewer')).toEqual(['advise', 'list_workers', 'read_worker']);
  });
});
