import type { StepTrack } from '../steps';
import type { Template, Worker } from '../types';

export interface AgentCaps {
  /** The status dot and the task line come from hooks. */
  hooks: boolean;
  /** PreToolUse can wait for Allow or Deny. */
  guard: boolean;
  /** The agent can use the console tools. */
  mcp: boolean;
  /** A restart can resume the same conversation. */
  resume: boolean;
  /** The Flow view gets real steps. Else it shows one step for each prompt. */
  steps: boolean;
  /** Import Sessions can find outside sessions. */
  import: boolean;
  /** The agent can sit in the advisor or reviewer seat. */
  advisor: boolean;
}

export interface OptionField {
  key: string; label: string;
  kind: 'select' | 'text';
  /** The choices for a select field. */
  choices?: string[];
  /** Shown as "(config)" when the value comes from the agent's own config. */
  default?: string;
}

export interface LaunchInput {
  w: Worker;
  /** The session folder. */
  dir: string;
  /** The session folder on a remote host. Only the Claude adapter uses it. */
  fileDir?: string;
  url: string; token: string;
  /** The rules for an advisor or a reviewer. */
  rules?: string;
  resume: boolean; template?: Template;
  options: Record<string, string>;
  /** The command that starts the agent. */
  bin: string[];
  /** The OTEL attributes that the console inherits. */
  inheritedOtelAttrs?: string;
  /** How long the console waits for a guard answer, in seconds. */
  hookTimeoutSec?: number;
}

export interface Launch { cmd: string[]; env: Record<string, string> }

/** One event shape for hookserver.ts. Each adapter maps its native payload to this. */
export type HookEvent =
  | { t: 'start'; sessionId?: string; transcript?: string }
  | { t: 'prompt'; text: string; transcript?: string }
  | { t: 'toolStart'; tool: string; input: unknown; shell?: string; transcript?: string }
  | { t: 'toolEnd'; tool: string; input?: unknown; output?: unknown; transcript?: string }
  /** permission: a permission prompt is on screen. idle: the input prompt is ready, so the queue can flush. */
  | { t: 'notice'; text: string; permission: boolean; idle: boolean }
  | { t: 'stop'; transcript?: string }
  | { t: 'end' };

export interface AgentAdapter {
  id: string;
  label: string; icon: string; color: string;
  bin: string;
  /** Doctor reports an error, not a warning, when the bin is missing. */
  required?: boolean;
  /** Added to the doctor message when the bin is missing. */
  installHint?: string;
  caps: AgentCaps;
  options: OptionField[];
  /** Write the session files. Return the command. */
  launch(i: LaunchInput): Launch;
  hook(event: string, payload: any): HookEvent | null;
  /** The answer that the hook command prints for a guard decision, in the format of this agent. */
  guardReply(d: 'allow' | 'deny' | 'ask', reason?: string): object;
  /** Apply the checklist tool calls of the agent to the steps. */
  checklist?(ev: HookEvent, track: StepTrack, now: number): StepTrack;
  /** Read the assistant texts that are new since `from`. */
  chat?(transcript: string, from: number): { texts: { text: string; at: number }[]; offset: number };
  /** Write the role rules in the words of this agent. */
  rules?(role: 'advisor' | 'reviewer', base: string): string;
}
