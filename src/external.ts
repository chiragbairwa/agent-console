import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A Claude Code session that runs outside the console (for example in a Ghostty tab). */
export interface ExternalSession {
  pid: number; sessionId: string; cwd: string; name: string; status: string; startedAt: number;
  /** True when this session is an ancestor of the console process: moving it would stop the console. */
  ancestor: boolean;
}

export const SESSIONS_DIR = () => join(homedir(), '.claude', 'sessions');

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function envOf(pid: number): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  } catch { return {}; }
}

/** The pids of this process and all its parents (from /proc). */
export function ancestorPids(pid = process.pid): number[] {
  const out: number[] = [];
  let p = pid;
  for (let i = 0; i < 64 && p > 1; i++) {
    out.push(p);
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
      p = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return out;
}

export function readSessionFile(dir: string, pid: number): any | undefined {
  try { return JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8')); } catch { return undefined; }
}

/** Field 22 of /proc/<pid>/stat (start time in clock ticks). Claude writes the same value as `procStart`. */
export function procStartOf(pid: number): string | undefined {
  try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return undefined; }
}

export function cmdlineOf(pid: number): string {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } catch { return ''; }
}

const looksLikeClaude = (cmd: string) => /(^|\/)claude(\s|$)/.test(cmd.split(' ')[0] ?? '') || /\/claude\/versions\//.test(cmd);

export function listExternal(o: {
  dir: string; alive: (pid: number) => boolean; envOf: (pid: number) => Record<string, string>; ancestors: number[];
  procStartOf?: (pid: number) => string | undefined; cmdlineOf?: (pid: number) => string;
}): ExternalSession[] {
  const startOf = o.procStartOf ?? procStartOf, cmdOf = o.cmdlineOf ?? cmdlineOf;
  let files: string[] = [];
  try { files = readdirSync(o.dir).filter(f => /^\d+\.json$/.test(f)); } catch { return []; }
  const out: ExternalSession[] = [];
  for (const f of files) {
    let j: any;
    try { j = JSON.parse(readFileSync(join(o.dir, f), 'utf8')); } catch { continue; }
    const pid = Number(j?.pid);
    if (!pid || j.kind !== 'interactive' || !o.alive(pid) || o.envOf(pid).AC_ID) continue;
    // A stale or crafted file must not point at another process (review I4).
    if (!j.procStart || String(j.procStart) !== startOf(pid) || !looksLikeClaude(cmdOf(pid))) continue;
    out.push({
      pid, sessionId: String(j.sessionId), cwd: String(j.cwd), name: String(j.name ?? `session-${pid}`),
      status: String(j.status ?? 'idle'), startedAt: Number(j.startedAt ?? 0), ancestor: o.ancestors.includes(pid),
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

export const projectDirFor = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export function transcriptPath(cwd: string, sessionId: string) {
  return join(homedir(), '.claude', 'projects', projectDirFor(cwd), `${sessionId}.jsonl`);
}

/** The last n user prompts and assistant replies (text only). Reads at most the last 2 MB. */
export function lastMessages(file: string, n: number): { role: 'user' | 'assistant'; text: string }[] {
  let raw: string;
  try {
    const buf = readFileSync(file);
    raw = buf.subarray(Math.max(0, buf.length - 2_000_000)).toString('utf8');
  } catch { return []; }
  const out: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const line of raw.split('\n')) {
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if ((j.type !== 'user' && j.type !== 'assistant') || j.isMeta || j.isSidechain) continue;
    const c = j.message?.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
    const t = text.trim();
    // Lines the harness injects as "user" (notifications, slash-command echoes, reminders) are not prompts.
    if (j.type === 'user' && /^<(task-notification|command-|local-command-|system-reminder|bash-)/.test(t)) continue;
    if (t) out.push({ role: j.type, text: t });
  }
  return out.slice(-n);
}
