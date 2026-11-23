import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { configDir, configPath, desktopDir, statePath, tokenPath } from './paths';
import type { Config, State, Worker } from './types';

const ACTIVITY_MAX = 500;

function ensureDir() { mkdirSync(configDir(), { recursive: true, mode: 0o700 }); }

export function loadConfig(): Config {
  const defRoot = desktopDir(); // the same on every machine and OS; teammates' folders differ below it
  let file: Partial<Config> = {};
  try { file = JSON.parse(readFileSync(configPath(), 'utf8')); } catch { /* defaults */ }
  const roots = file.roots?.length ? file.roots : [defRoot];
  // Keep string option values only.
  const agents: Record<string, Record<string, string>> = {};
  if (file.agents && typeof file.agents === 'object' && !Array.isArray(file.agents)) {
    for (const [id, o] of Object.entries(file.agents)) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      agents[id] = Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string'));
    }
  }
  return {
    roots,
    port: file.port ?? 7878,
    guardPatterns: file.guardPatterns ?? [],
    templates: file.templates ?? [],
    advisorCwd: file.advisorCwd ?? roots[0]!,
    hookTimeoutSec: file.hookTimeoutSec ?? 590,
    advisorDigestMin: file.advisorDigestMin ?? 5,
    ...(Object.keys(agents).length ? { agents } : {}),
    ...(typeof file.advisorAgent === 'string' ? { advisorAgent: file.advisorAgent } : {}),
    ...(typeof file.defaultWorkerAgent === 'string' ? { defaultWorkerAgent: file.defaultWorkerAgent } : {}),
  };
}

const emptyState = (): State => ({ workers: [], links: [], cut: [], activity: [] });

export function loadState(): State {
  const p = statePath();
  if (!existsSync(p)) return emptyState();
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as Partial<State>;
    const workers = (s.workers ?? []).map(w => {
      const old = w as Worker & { claudeSessionId?: string };
      if (old.claudeSessionId === undefined) return w;
      // Old state files use claudeSessionId. Move it to sessionId.
      const { claudeSessionId, ...rest } = old;
      return rest.sessionId ? rest : { ...rest, sessionId: claudeSessionId };
    });
    return { workers, links: s.links ?? [], cut: s.cut ?? [], activity: s.activity ?? [], ...(s.steps ? { steps: s.steps } : {}) };
  } catch {
    renameSync(p, `${p}.bad-${Date.now()}`);
    return emptyState();
  }
}

export function saveState(s: State): void {
  ensureDir();
  const out: State = { ...s, activity: s.activity.slice(-ACTIVITY_MAX) };
  const tmp = `${statePath()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, statePath());
}

function writeToken(): string {
  ensureDir();
  const t = randomBytes(32).toString('hex');
  writeFileSync(tokenPath(), t, { mode: 0o600 });
  chmodSync(tokenPath(), 0o600);
  return t;
}

export function getToken(): string {
  try {
    const t = readFileSync(tokenPath(), 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch { /* create */ }
  return writeToken();
}

export function rotateToken(): string { return writeToken(); }
