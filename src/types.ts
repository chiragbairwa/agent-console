import type { StepTrack } from './steps';

export type Role = 'advisor' | 'worker';
export type Status = 'running' | 'needs-you' | 'waiting' | 'done' | 'idle' | 'stopped';

export interface Worker {
  id: string; name: string; role: Role; cwd: string; repo: string;
  branch?: string; worktree?: string;
  /** The agent id. A missing value means claude. */
  agent?: string;
  /** The conversation id of the agent. */
  sessionId?: string;
  /** The last conversation id of each agent that held this seat, by agent id (advisor swap). */
  lastSessions?: Record<string, string>;
  /** The agent options from Add Worker. */
  options?: Record<string, string>;
  status: Status; task: string; x: number; y: number; lastUserInputAt?: number;
  /** The outer size of the box in world pixels. A missing value means the default size. */
  w?: number; h?: number;
  /** 'linked' = a session outside the console, shown as a card (no tmux). Default 'tmux'. */
  kind?: 'tmux' | 'linked'; pid?: number;
}

export interface Link { a: string; b: string; by: 'advisor' | 'you' }

export type NeedKind = 'guard' | 'permission' | 'waiting' | 'question';
export interface Need { nid: string; id: string; kind: NeedKind; text: string; createdAt: number }

export interface Activity { at: number; text: string }

export interface Template { name: string; prompt: string; permissionMode?: string }

export interface Config {
  roots: string[]; port: number; guardPatterns: string[];
  templates: Template[]; advisorCwd: string; hookTimeoutSec: number;
  /** Minutes between status checks sent to the advisor; 0 turns them off. */
  advisorDigestMin: number;
  /** Default options for each agent id. Worker options win. */
  agents?: Record<string, Record<string, string>>;
  /** The agent of a new worker when the request names none. A missing value means claude. */
  defaultWorkerAgent?: string;
  /** The agent of a new advisor. A missing value means claude. */
  advisorAgent?: string;
}

export interface State {
  workers: Worker[]; links: Link[]; cut: string[]; activity: Activity[];
  /** Steps per worker id, from the hooks (see src/steps.ts). */
  steps?: Record<string, StepTrack>;
}

export type StateEvent =
  | { t: 'snapshot'; state: State; needs: Need[]; queued: Record<string, number> }
  | { t: 'worker'; worker: Worker }
  | { t: 'removed'; id: string }
  | { t: 'links'; links: Link[]; cut: string[] }
  | { t: 'needs'; needs: Need[] }
  | { t: 'pulse'; from: string; to: string }
  | { t: 'activity'; item: Activity }
  | { t: 'queued'; id: string; count: number }
  | { t: 'steps'; id: string; track: StepTrack };
