import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionDir } from '../paths';
import { assistantTexts, readNewLines } from '../chatlist';
import * as St from '../steps';
import type { Config, Template, Worker } from '../types';
import type { AgentAdapter, HookEvent, Launch, LaunchInput } from './types';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'SessionEnd'] as const;

export interface SessionOpts {
  bin: string[]; url: string; token: string;
  /** Folder on a remote host. The args name the files there. The files are still written here. */
  fileDir?: string;
  resume?: boolean; template?: Template; advisorPrompt?: string; inheritedOtelAttrs?: string;
}

export interface SessionFiles { settingsPath: string; mcpPath: string; env: Record<string, string>; args: string[] }

const ASK_JSON = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
  permissionDecisionReason: 'Agent Console is not running, so a guarded command cannot be checked' } });
/** Post the hook input (stdin) to the console. Always exit 0: a missing console must not stop Claude. */
export const CURL_POST = (event: string) =>
  `curl -s -o /dev/null --max-time 5 -H "x-ac-token: $AC_TOKEN" -H "x-ac-id: $AC_ID" -H 'content-type: application/json' --data-binary @- "$AC_URL/hook/${event}" || true`;
/** curl, not the console binary: a few MB for a few ms. Exit 0 with no output when the console answers.
 *  A console that is down refuses the connection at once. A busy machine can make a running console
 *  slow for some seconds: that is not "down", so the total limit is 8 s (connect: 2 s). */
export const BASH_FAILSAFE = `curl -s -o /dev/null --connect-timeout 2 --max-time 8 -H "x-ac-token: $AC_TOKEN" "$AC_URL/api/health" || printf '%s\\n' '${ASK_JSON}'`;

/** The user's OTel attrs from ~/.claude/settings.json env (read only), else the process env. */
export function readInheritedOtelAttrs(): string {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    const v = s?.env?.OTEL_RESOURCE_ATTRIBUTES;
    if (typeof v === 'string') return v;
  } catch { /* fall through */ }
  return process.env.OTEL_RESOURCE_ATTRIBUTES ?? '';
}

export function sessionFiles(w: Worker, _cfg: Config, o: SessionOpts): SessionFiles {
  const dir = sessionDir(w.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = { AC_URL: o.url, AC_TOKEN: o.token, AC_ID: w.id, AC_ROLE: w.role };

  const inherited = o.inheritedOtelAttrs ?? readInheritedOtelAttrs();
  const ours = `agent.role=${w.role},agent.name=${w.id},agent.repo=${w.repo}`;
  // HTTP hooks: Claude Code posts each event to the console. No process starts for a hook.
  const headers = { 'x-ac-token': o.token, 'x-ac-id': w.id };
  const hooks: Record<string, unknown[]> = Object.fromEntries(HOOK_EVENTS.map(ev => [ev, [{
    hooks: [{ type: 'http', url: `${o.url}/hook/${ev}`, headers, timeout: ev === 'PreToolUse' ? 600 : 10 }],
  }]]));
  // Fail-safe for the guard: when the console is down, the HTTP hook fails and Claude goes on.
  // So Bash also gets this small check: no answer from the console → "ask" in the terminal.
  hooks.PreToolUse!.push({ matcher: 'Bash', hooks: [{ type: 'command', command: BASH_FAILSAFE, timeout: 10 }] });
  // Claude Code skips HTTP hooks on SessionStart, so this one event posts its input with curl.
  hooks.SessionStart = [{ hooks: [{ type: 'command', command: CURL_POST('SessionStart'), timeout: 10 }] }];
  const settings = { env: { OTEL_RESOURCE_ATTRIBUTES: inherited ? `${inherited},${ours}` : ours }, hooks };
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  // MCP over HTTP from the console server: no helper process for each session.
  const mcp = { mcpServers: { 'agent-console': { type: 'http', url: `${o.url}/mcp`, headers: { 'x-ac-token': o.token, 'x-ac-id': w.id } } } };
  const mcpPath = join(dir, 'mcp.json');
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2), { mode: 0o600 });

  const args = ['--settings', o.fileDir ? `${o.fileDir}/settings.json` : settingsPath, '--mcp-config', o.fileDir ? `${o.fileDir}/mcp.json` : mcpPath];
  if ((w.role === 'advisor' || w.role === 'reviewer') && o.advisorPrompt) args.push('--append-system-prompt', o.advisorPrompt);
  if (o.resume) args.push(...(w.sessionId ? ['--resume', w.sessionId] : ['--continue']));
  if (o.template?.permissionMode) args.push('--permission-mode', o.template.permissionMode);
  // '--' ends the options, so a prompt that starts with '-' stays text.
  if (o.template?.prompt) args.push('--', o.template.prompt);
  return { settingsPath, mcpPath, env, args };
}

/** The Claude Code adapter. */
export const claude: AgentAdapter = {
  id: 'claude', label: 'Claude', icon: '✻', color: '#d9773a', bin: 'claude', required: true, installHint: 'Install Claude Code.',
  caps: { hooks: true, guard: true, mcp: true, resume: true, steps: true, import: true, advisor: true },
  options: [],
  launch(i: LaunchInput): Launch {
    // sessionFiles() finds the session folder by itself, so `i.dir` is not used here.
    const sf = sessionFiles(i.w, null as unknown as Config, {
      bin: i.bin, url: i.url, token: i.token, resume: i.resume, template: i.template,
      advisorPrompt: i.rules, inheritedOtelAttrs: i.inheritedOtelAttrs, fileDir: i.fileDir,
    });
    return { cmd: ['claude', ...sf.args], env: sf.env };
  },
  hook(event: string, p: any): HookEvent | null {
    const transcript = p?.transcript_path;
    switch (event) {
      case 'SessionStart': return { t: 'start', sessionId: p?.session_id, transcript };
      case 'UserPromptSubmit': return { t: 'prompt', text: p?.prompt, transcript };
      case 'PreToolUse': {
        const tool = String(p?.tool_name ?? 'tool');
        return { t: 'toolStart', tool, input: p?.tool_input, transcript,
          shell: tool === 'Bash' ? String(p?.tool_input?.command ?? '') : undefined };
      }
      case 'PostToolUse':
        return { t: 'toolEnd', tool: p?.tool_name ? String(p.tool_name) : '', input: p?.tool_input, output: p?.tool_response, transcript };
      case 'Notification': {
        const text = String(p?.message ?? '');
        return { t: 'notice', text, permission: /permission/i.test(text), idle: /waiting for your input/i.test(text) };
      }
      case 'Stop': return { t: 'stop', transcript };
      case 'SessionEnd': return { t: 'end' };
      default: return null;
    }
  },
  // Claude has its own checklist tools: TodoWrite, TaskUpdate and TaskCreate.
  checklist(ev, track, now) {
    if (ev.t === 'toolStart') {
      if (ev.tool === 'TodoWrite') return St.applyTodoWrite(track, (ev.input as any)?.todos, now);
      if (ev.tool === 'TaskUpdate') return St.applyTaskUpdate(track, ev.input, now);
    } else if (ev.t === 'toolEnd' && ev.tool === 'TaskCreate') {
      return St.applyTaskCreate(track, ev.input, ev.output);
    }
    return track;
  },
  chat(transcript, from) {
    const r = readNewLines(transcript, from);
    return { texts: assistantTexts(r.lines), offset: r.offset };
  },
  rules: (_role, base) => base,
  // For ask, the user answers in the terminal, so the reason says so.
  guardReply: (permissionDecision, reason) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision,
      ...(reason ? { permissionDecisionReason: permissionDecision === 'ask' ? `${reason}; asking in the terminal` : reason } : {}) },
  }),
};
