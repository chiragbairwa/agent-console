import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

type Env = Record<string, string | undefined>;

const ADVISOR_SPECS: Record<string, { description: string; input: z.ZodRawShape }> = {
  list_workers: { description: 'List all workers with status, task, repo, connections and open needs.', input: {} },
  read_worker: { description: 'Read the last lines of a worker terminal screen.', input: { id: z.string(), lines: z.number().int().optional() } },
  send_to_worker: { description: 'Type a message or task into a worker. It waits in a queue if the worker is busy with the user.', input: { id: z.string(), text: z.string() } },
  spawn_worker: { description: 'Start a new worker (agent: claude by default, or codex) in a repo (name or path), optionally in a new git worktree branch cut from worktree_base (default: the current branch).', input: { name: z.string(), repo: z.string(), worktree_branch: z.string().optional(), worktree_base: z.string().optional(), template: z.string().optional(), agent: z.string().optional(), options: z.record(z.string(), z.string()).optional() } },
  stop_worker: { description: 'Stop a worker session.', input: { id: z.string() } },
  interrupt_worker: { description: 'Interrupt what a worker is doing (Escape).', input: { id: z.string() } },
  connect: { description: 'Let two workers message each other.', input: { a: z.string(), b: z.string() } },
  disconnect: { description: 'Remove the link between two sessions.', input: { a: z.string(), b: z.string() } },
  ask_user: { description: 'Ask the user a question in the console and wait for the answer.', input: { question: z.string() } },
};

const WORKER_SPECS: typeof ADVISOR_SPECS = {
  send_message: { description: 'Send a message to a connected session (by name). Only works when the advisor connected you.', input: { to: z.string(), text: z.string() } },
  list_connections: { description: 'List the sessions you may message.', input: {} },
};

export type ToolReply = { ok: boolean; result?: unknown; error?: string };
export type CallTool = (tool: string, args: unknown) => Promise<ToolReply>;

/** The MCP server for one role. `call` runs a tool: in-process (HTTP) or through the API (stdio). */
export function buildMcpServer(role: 'advisor' | 'worker', call: CallTool): McpServer {
  const server = new McpServer({ name: 'agent-console', version: '0.3.0' });
  const specs = role === 'advisor' ? ADVISOR_SPECS : WORKER_SPECS;
  for (const [tool, spec] of Object.entries(specs)) {
    server.registerTool(tool, { description: spec.description, inputSchema: spec.input }, async (args: unknown) => {
      try {
        const r = await call(tool, args);
        const text = r.ok ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)) : `Error: ${r.error}`;
        return { content: [{ type: 'text' as const, text }], isError: !r.ok };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Agent Console is not reachable: ${(e as Error).message}` }], isError: true };
      }
    });
  }
  return server;
}

/**
 * MCP over HTTP, served by the console itself: no helper process for each session.
 * Stateless: a new server and transport for each request, so nothing is kept between calls.
 * The caller is the `x-ac-id` header; the token was checked before this runs.
 */
export async function handleMcpHttp(
  req: Request, role: 'advisor' | 'worker' | undefined, call: CallTool,
): Promise<Response> {
  if (!role) return Response.json({ error: 'unknown session (x-ac-id)' }, { status: 404 });
  const server = buildMcpServer(role, call);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(req); }
  finally { void server.close(); }
}

/** The old stdio helper (`agent-console mcp`). Sessions started before HTTP MCP still use it. */
export async function runMcp(env: Env): Promise<void> {
  const role = env.AC_ROLE === 'advisor' ? 'advisor' : 'worker';
  const server = buildMcpServer(role, async (tool, args) => {
    const res = await fetch(`${env.AC_URL}/api/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ac-token': env.AC_TOKEN ?? '' },
      body: JSON.stringify({ caller: env.AC_ID, tool, args }),
    });
    return await res.json() as ToolReply;
  });
  await server.connect(new StdioServerTransport());
  await new Promise<void>(resolve => { process.stdin.on('close', () => resolve()); });
}
