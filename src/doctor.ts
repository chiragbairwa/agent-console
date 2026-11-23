import { accessSync, constants, mkdirSync } from 'node:fs';
import { ADAPTERS } from './agents';
import { configDir } from './paths';

export interface Check { name: string; ok: boolean; detail: string; /** The check failed, but the console still works. */ warn?: boolean }

function which(bin: string, path: string | undefined): string | null {
  return Bun.which(bin, { PATH: path ?? process.env.PATH ?? '' });
}

async function version(bin: string, args: string[]): Promise<string> {
  try {
    const p = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim().split('\n')[0] ?? '';
  } catch {
    return '';
  }
}

async function portFree(port: number): Promise<boolean> {
  try {
    const s = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(env: { PATH?: string } = {}, port = 7878): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({ name: 'bun', ok: true, detail: `bun ${Bun.version}` });

  const tmux = which('tmux', env.PATH);
  checks.push(tmux
    ? { name: 'tmux', ok: true, detail: await version(tmux, ['-V']) }
    : { name: 'tmux', ok: false, detail: 'tmux not found. Install it: sudo apt install tmux' });

  // One check for each agent. A missing required agent is an error. Any other is a warning.
  for (const a of Object.values(ADAPTERS)) {
    const found = which(a.bin, env.PATH);
    if (found) checks.push({ name: a.id, ok: true, detail: await version(found, ['--version']) });
    else if (a.required) checks.push({ name: a.id, ok: false, detail: `${a.bin} not found on PATH.${a.installHint ? ` ${a.installHint}` : ''}` });
    else checks.push({ name: a.id, ok: true, warn: true, detail: `${a.bin} not found on PATH (${a.label} workers will not start)` });
  }

  const dir = configDir();
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    checks.push({ name: 'config-dir', ok: true, detail: dir });
  } catch (e) {
    checks.push({ name: 'config-dir', ok: false, detail: `${dir}: ${(e as Error).message}` });
  }

  const free = await portFree(port);
  checks.push({ name: 'port', ok: free, detail: free ? `${port} is free` : `${port} is in use (is agent-console already running?)` });
  return checks;
}
