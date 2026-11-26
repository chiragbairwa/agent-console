import { accessSync, constants, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS } from './agents';
import { configDir, folderProblem } from './paths';
import { checkHost, checkMark, type Check as HostCheck } from './hostcheck';
import { HostLink } from './ssh';
import type { Host } from './types';

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

/** True when the program on the port is Agent Console. Without a token the console answers 403 "Forbidden". */
async function isConsole(port: number, get: (url: string, init?: RequestInit) => Promise<Response>): Promise<boolean> {
  try {
    const r = await get(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await r.text()).trim();
    if (r.status === 403) return body === 'Forbidden';
    if (r.status === 200) { try { return JSON.parse(body)?.ok === true; } catch { return false; } }
    return false;
  } catch {
    return false;
  }
}

export interface DoctorOpts {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** The config roots and advisorCwd. macOS only: the doctor checks that it can read them. */
  folders?: string[];
  readDir?: (p: string) => unknown;
  platform?: NodeJS.Platform;
}

export async function runDoctor(env: { PATH?: string } = {}, port = 7878, o: DoctorOpts = {}): Promise<Check[]> {
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

  // macOS privacy blocks Desktop, Documents and Downloads for an app until the user allows it.
  if ((o.platform ?? process.platform) === 'darwin' && o.folders?.length) {
    const problems = [...new Set(o.folders)].map(d => folderProblem(d, o.readDir ?? readdirSync, 'darwin')).filter(Boolean);
    checks.push(problems.length
      ? { name: 'folders', ok: true, warn: true, detail: problems.join(' ') }
      : { name: 'folders', ok: true, detail: 'the roots and advisorCwd are readable' });
  }

  const free = await portFree(port);
  if (free) checks.push({ name: 'port', ok: true, detail: `${port} is free` });
  else if (await isConsole(port, o.fetch ?? ((url, init) => fetch(url, init))))
    checks.push({ name: 'port', ok: true, detail: `${port} used by the running Agent Console` });
  else checks.push({ name: 'port', ok: false, detail: `${port} is in use (is agent-console already running?)` });
  return checks;
}

/** Connect one host, print its checks, disconnect. Returns the exit code. */
export async function runHostDoctor(
  link: HostLink | undefined,
  id: string, consolePort: number, print: (line: string) => void = console.log,
): Promise<number> {
  if (!link) { print(`✗ unknown host ${id}`); return 1; }
  await link.connect();
  let checks: HostCheck[];
  try {
    checks = link.state === 'up'
      ? await checkHost(link, consolePort)
      : [{ id: 'ssh', ok: false, text: link.lastError ?? 'connect failed' }];
  } finally { await link.disconnect(); }
  for (const c of checks) print(`${checkMark(c)} ${c.id.padEnd(11)} ${c.text}`);
  return checks.every(c => c.ok) ? 0 : 1;
}

export interface HostDoctorOpts {
  hosts: Host[]; port: number; token: string;
  /** The socket folder of the console. The CLI uses a private folder inside it. */
  sockDir: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  makeLink?: (h: Host, sockDir: string) => HostLink;
  print?: (line: string) => void;
}

/**
 * `doctor --host <id>`. A running console owns the master and the tunnel, so ask it first.
 * Only when no console runs, start a private master. Its -O exit cannot stop the master of a console.
 */
export async function hostDoctor(id: string, o: HostDoctorOpts): Promise<number> {
  const print = o.print ?? console.log;
  const get = o.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const base = `http://127.0.0.1:${o.port}`;
  const headers = { 'x-ac-token': o.token };
  let running = false;
  try { running = (await get(`${base}/api/health`, { headers, signal: AbortSignal.timeout(1000) })).ok; } catch { /* no console */ }
  if (running) {
    let r: Response;
    try { r = await get(`${base}/api/hosts/${encodeURIComponent(id)}/check`, { headers }); }
    catch (e) { print(`✗ the console did not answer: ${(e as Error).message}`); return 1; }
    if (r.status === 404) { print(`✗ unknown host ${id}`); return 1; }
    if (!r.ok) { print(`✗ the console refused the check (HTTP ${r.status})`); return 1; }
    const checks = await r.json() as HostCheck[];
    for (const c of checks) print(`${checkMark(c)} ${c.id.padEnd(11)} ${c.text}`);
    if (checks[0]?.id === 'ssh' && !checks[0].ok) print('  Connect the host in the console, then run the doctor again.');
    return checks.every(c => c.ok) ? 0 : 1;
  }
  const host = o.hosts.find(h => h.id === id);
  if (!host) return runHostDoctor(undefined, id, o.port, print);
  const dir = join(o.sockDir, `doctor-${process.pid}`);
  const link = o.makeLink ? o.makeLink(host, dir) : new HostLink(host, { consolePort: o.port, sockDir: dir });
  try { return await runHostDoctor(link, id, o.port, print); }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
