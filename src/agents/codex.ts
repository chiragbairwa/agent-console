import { CURL_POST } from './claude';
import type { AgentAdapter, HookEvent, Launch, LaunchInput } from './types';

/** The Codex events that the console hooks. PermissionRequest does not fire in bypass mode. */
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const;

const DENY_JSON = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: 'Agent Console is not reachable. Wait, then try again.' } });

/** The time limit of the PreToolUse hook. It must be longer than the wait of the console.
 *  Else Codex stops the hook before the deny prints, and the tool runs. */
const preToolLimit = (hookTimeoutSec?: number) => Math.max(600, Math.ceil((hookTimeoutSec ?? 0) + 30));

/** The PreToolUse hook. It prints the answer of the console.
 *  The guard fails closed: -f makes curl fail on an HTTP error, and when curl fails, the hook prints a deny. Codex runs a tool when the output is empty. */
export function codexPreToolUse(limit = 600): string {
  return `curl -sf --connect-timeout 2 --max-time ${limit} -H "x-ac-token: $AC_TOKEN" -H "x-ac-id: $AC_ID" -H 'content-type: application/json' --data-binary @- "$AC_URL/hook/PreToolUse" || printf '%s\\n' '${DENY_JSON}'`;
}

/** One hook as a TOML inline array. The command is a TOML basic string, so JSON.stringify is correct. */
const hookItem = (ev: string, cmd: string, timeout: number) =>
  `hooks.${ev}=[{hooks=[{type="command",command=${JSON.stringify(cmd)},timeout=${timeout}}]}]`;

/** The Codex CLI adapter. */
export const codex: AgentAdapter = {
  id: 'codex', label: 'Codex', icon: '◎', color: '#10a37f', bin: 'codex',
  caps: { hooks: true, guard: true, mcp: true, resume: true, steps: false, import: false, advisor: true },
  options: [
    { key: 'model', label: 'Model', kind: 'text' },
    { key: 'reasoning', label: 'Reasoning', kind: 'select', choices: ['low', 'medium', 'high'] },
  ],
  launch(i: LaunchInput): Launch {
    const env = { AC_URL: i.url, AC_TOKEN: i.token, AC_ID: i.w.id, AC_ROLE: i.w.role };
    const cmd = ['codex', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'];
    // Each -c value is a TOML value. JSON.stringify makes a safe TOML basic string.
    const c = (v: string) => cmd.push('-c', v);
    c('check_for_update_on_startup=false');
    // Trust the folder of the box for this launch only. Without it, Codex asks "Trust this folder?" at the first start.
    // The inline table form works. The dotted key form `projects."<cwd>".trust_level` does not.
    c(`projects={ ${JSON.stringify(i.w.cwd)} = { trust_level = "trusted" } }`);
    c(`mcp_servers.agent-console.url=${JSON.stringify(`${i.url}/mcp`)}`);
    // env_http_headers maps a header name to an env var NAME. The token stays out of the command line, which other local users can read.
    c('mcp_servers.agent-console.env_http_headers={ "x-ac-token" = "AC_TOKEN", "x-ac-id" = "AC_ID" }');
    c('mcp_servers.agent-console.tool_timeout_sec=1800');
    const limit = preToolLimit(i.hookTimeoutSec);
    for (const ev of CODEX_EVENTS) {
      c(ev === 'PreToolUse' ? hookItem(ev, codexPreToolUse(limit), limit) : hookItem(ev, CURL_POST(ev), 10));
    }
    if (i.options.model) c(`model=${JSON.stringify(i.options.model)}`);
    if (i.options.reasoning) c(`model_reasoning_effort=${JSON.stringify(i.options.reasoning)}`);
    if ((i.w.role === 'advisor' || i.w.role === 'reviewer') && i.rules) c(`developer_instructions=${JSON.stringify(i.rules)}`);
    // Without a session id, start fresh. Never use "resume --last": it can pick another session.
    if (i.resume && i.w.sessionId) cmd.push('resume', i.w.sessionId);
    // Codex has no permission mode, so template.permissionMode is ignored.
    if (i.template?.prompt) cmd.push(i.template.prompt);
    return { cmd, env };
  },
  hook(event: string, p: any): HookEvent | null {
    switch (event) {
      case 'SessionStart': return { t: 'start', sessionId: p?.session_id };
      case 'UserPromptSubmit': return { t: 'prompt', text: String(p?.prompt ?? '') };
      case 'PreToolUse': {
        const tool = String(p?.tool_name ?? 'tool');
        return { t: 'toolStart', tool, input: p?.tool_input,
          shell: tool === 'Bash' ? String(p?.tool_input?.command ?? '') : undefined };
      }
      case 'PostToolUse':
        return { t: 'toolEnd', tool: p?.tool_name ? String(p.tool_name) : '', input: p?.tool_input, output: p?.tool_response };
      case 'PermissionRequest': return { t: 'notice', text: '', permission: true, idle: false };
      case 'Stop': return { t: 'stop' };
      default: return null;
    }
  },
  // Codex does not verify "ask", so ask becomes deny.
  // Codex rejects permissionDecision allow with a warning. An empty object means allow.
  guardReply: (d, reason) => d === 'allow' ? {} : ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      ...(reason ? { permissionDecisionReason: reason } : {}) },
  }),
  // Codex has no SendMessage tool, so drop the lines that name it.
  rules: (_role, base) => base.split('\n').filter(l => !l.includes('SendMessage')).join('\n'),
};
