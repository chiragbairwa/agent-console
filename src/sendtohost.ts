import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Registry } from './workers';
import type { HostPool } from './hostpool';
import { checkHost, type Check } from './hostcheck';
import { listRemoteRepos } from './remotefs';
import { isLocal } from './hosts';
import { shq } from './shq';
import type { HostLink } from './ssh';
import type { Worker } from './types';

export interface SendOpts { id: string; to: string; branch: boolean; patch: boolean; brief?: string; folder?: string; stopSource: boolean }
export interface SendStep { name: 'check' | 'bundle' | 'patch' | 'folder' | 'start' | 'stop'; ok: boolean; text: string }

export interface LocalResult { out: string; bytes: Uint8Array; err: string; code: number }
/** Run one command on this machine. */
export type LocalRun = (cmd: string[], cwd: string, o?: { binary?: boolean; timeoutMs?: number }) => Promise<LocalResult>;

const SLOW_MS = 120000;

/** The real local runner. Tests use a real temp repository or a stub. */
export const defaultRun: LocalRun = async (cmd, cwd, o) => {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const timer = setTimeout(() => p.kill(), o?.timeoutMs ?? SLOW_MS);
  try {
    const [bytes, err, code] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text(), p.exited]);
    return { out: o?.binary ? '' : new TextDecoder().decode(bytes), bytes, err, code };
  } finally { clearTimeout(timer); }
};

interface Deps { run?: LocalRun }

const msg = (e: unknown) => e instanceof Error ? e.message : String(e);

/** The branch to send: the branch of the worker, else the current branch of its folder. */
async function branchOf(w: Worker, run: LocalRun): Promise<string | undefined> {
  if (w.branch) return w.branch;
  const r = await run(['git', 'branch', '--show-current'], w.cwd);
  return r.code === 0 ? r.out.trim() || undefined : undefined;
}

/** The local ref that the remote repo should already hold: origin/HEAD, origin/main or origin/master. */
async function baseOf(w: Worker, run: LocalRun): Promise<string | undefined> {
  const head = await run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], w.cwd);
  const cand = [...(head.code === 0 && head.out.trim() ? [head.out.trim()] : []), 'origin/main', 'origin/master'];
  for (const c of cand) if ((await run(['git', 'rev-parse', '--verify', '--quiet', `${c}^{commit}`], w.cwd)).code === 0) return c;
  return undefined;
}

/** Find the repo with the same folder name under a root of the host. */
async function findRepo(link: HostLink, name: string): Promise<string | undefined> {
  return (await listRemoteRepos(link, link.host.roots)).find(r => r.name === name)?.path;
}

/** Check a local folder. It must be in the cwd of the worker or in the home folder, but not the home folder itself. A hidden top-level folder of the home folder is refused unless it is inside the cwd. Return its dest on the host, relative to the remote home. */
function folderDest(folder: string, cwd: string, id: string): { src: string; dest: string } {
  let src: string; let root: string; let home: string;
  try { src = realpathSync(resolve(cwd, folder)); root = realpathSync(resolve(cwd)); home = realpathSync(homedir()); }
  catch { throw new Error(`${folder} was not found`); }
  const inside = (r: string) => src.startsWith(r.endsWith(sep) ? r : r + sep);
  const inCwd = root !== home && (src === root || inside(root)); // a worker in the home folder gets no exemption
  if (src === home) throw new Error('the home folder cannot be sent');
  if (!inCwd && inside(home) && relative(home, src).split(sep)[0]!.startsWith('.')) throw new Error(`${folder} is a hidden folder in your home folder`);
  if (!inCwd && !inside(home)) throw new Error(`${folder} is outside the folder of the worker and your home folder`);
  const dest = inside(home) ? relative(home, src) : posix.join('ac-send', id, posix.basename(src));
  return { src, dest };
}

export async function sendToHost(reg: Registry, hosts: HostPool, o: SendOpts, deps: Deps = {}): Promise<{ steps: SendStep[]; worker?: Worker }> {
  const run = deps.run ?? defaultRun;
  const steps: SendStep[] = [];
  const w = reg.get(o.id);
  let hostName = o.to;
  /** Record a step and log it. Return its ok flag. */
  const note = (name: SendStep['name'], ok: boolean, text: string) => {
    steps.push({ name, ok, text });
    reg.activity(`Send to ${hostName}: ${name} ${ok ? 'ok' : 'failed'}: ${text}`);
    return ok;
  };

  // --- check
  let link: HostLink;
  try { link = hosts.link(o.to); } catch (e) { note('check', false, msg(e)); return { steps }; }
  hostName = link.host.name;
  if (!w) { note('check', false, 'unknown worker'); return { steps }; }
  if (!isLocal(w.host)) { note('check', false, 'Send to Host works from a worker on this computer for now'); return { steps }; }
  if (link.state !== 'up') { note('check', false, `${hostName} is not connected`); return { steps }; }
  const repo = await findRepo(link, w.repo).catch(() => undefined);
  if (!repo) { note('check', false, `${w.repo} is not on ${hostName}`); return { steps }; }
  const realBranch = await branchOf(w, run);
  if (o.branch && !realBranch) { note('check', false, `${w.name} has no branch to send`); return { steps }; }
  const branch = realBranch ?? `send-${w.id}`;
  if (branch.startsWith('-')) { note('check', false, 'bad branch name'); return { steps }; }
  note('check', true, `${repo} on ${hostName}`);

  // --- bundle: the commits of the branch go over as one Git bundle.
  // With no commits ahead of the base, git refuses an empty bundle. Then the new worker gets a new branch
  // from the local HEAD commit, which the host repo must already hold.
  let newBranch: { name: string; base: string } | undefined;
  if (o.branch) {
    const base = await baseOf(w, run);
    const n = base ? await run(['git', 'rev-list', '--count', `${base}..${branch}`], w.cwd) : undefined;
    if (n && n.code === 0 && n.out.trim() === '0') {
      const head = await run(['git', 'rev-parse', 'HEAD'], w.cwd);
      if (head.code !== 0) { note('bundle', false, head.err.trim() || 'git rev-parse failed'); return { steps }; }
      newBranch = { name: `${branch}-${link.host.id}`, base: head.out.trim() };
      note('bundle', true, 'no commits to send');
    }
  }
  if (o.branch && !newBranch) {
    const tmp = `/tmp/ac-${w.id}-${randomBytes(4).toString('hex')}.bundle`;
    try {
      const base = await baseOf(w, run);
      const b = await run(['git', 'bundle', 'create', '-', base ? `${base}..${branch}` : branch], w.cwd, { binary: true });
      if (b.code !== 0) throw new Error(b.err.trim() || 'git bundle failed');
      // exec takes text only. The bundle goes over as one line of base64. openssl exists on Linux and macOS.
      const wr = await link.exec(['sh', '-c', 'umask 077; openssl base64 -d -A > "$1"', '_', tmp], Buffer.from(b.bytes).toString('base64'), { timeoutMs: SLOW_MS });
      if (wr.code !== 0) throw new Error(wr.err.trim() || 'could not write the bundle');
      const f = await link.exec(['git', '-C', repo, 'fetch', '--', tmp, `${branch}:${branch}`], undefined, { timeoutMs: SLOW_MS });
      if (f.code !== 0) throw new Error(f.err.trim() || 'git fetch failed');
      note('bundle', true, `${branch} (${b.bytes.length} bytes${base ? `, since ${base}` : ''})`);
    } catch (e) {
      note('bundle', false, msg(e));
      await link.exec(['rm', '-f', tmp]).catch(() => undefined);
      return { steps };
    }
    await link.exec(['rm', '-f', tmp]).catch(() => undefined);
  }

  // --- folder
  if (o.folder) {
    try {
      const { src, dest } = folderDest(o.folder, w.cwd, w.id);
      const home = await link.home();
      const full = posix.join(home, dest);
      const mk = await link.exec(['mkdir', '-p', full]);
      if (mk.code !== 0) throw new Error(mk.err.trim() || 'mkdir failed');
      // The -e string has fixed parts and the quoted socket path only.
      // -s (protect-args) keeps rsync >= 3.2.4 from reading the dest twice, so the dest goes unquoted.
      const r = await run(['rsync', '-az', '-s', '-e', `ssh -S ${shq(link.sock())} -o BatchMode=yes`, '--', `${src}/`, `${link.host.ssh}:${full}/`], w.cwd, { timeoutMs: SLOW_MS });
      if (r.code !== 0) throw new Error(r.err.trim() || 'rsync failed');
      note('folder', true, `${src} -> ${full}`);
    } catch (e) { note('folder', false, msg(e)); return { steps }; }
  }

  // --- patch, then start: the changes go into the new worktree before the agent starts
  let hook: ((cwd: string) => Promise<void>) | undefined;
  let patchFailed = false;
  if (o.patch) {
    const d = await run(['git', 'diff', '--binary', 'HEAD'], w.cwd);
    if (d.code !== 0) { note('patch', false, `patch failed: ${d.err.trim() || 'git diff failed'}`); return { steps }; }
    if (!d.out.trim()) note('patch', true, 'no changes');
    else hook = async wt => {
      const a = await link.exec(['git', '-C', wt, 'apply'], d.out, { timeoutMs: SLOW_MS });
      if (a.code !== 0) {
        patchFailed = true;
        note('patch', false, `patch failed: ${a.err.trim() || 'git apply failed'} (worktree at ${wt})`);
        throw new Error('patch failed');
      }
      note('patch', true, `${d.out.split('\n').length} lines applied`);
    };
  }
  let nw: Worker;
  try {
    nw = await reg.spawn({
      name: `${w.name}-${link.host.id}`, repo, host: link.host.id,
      worktree: newBranch ? { branch: newBranch.name, base: newBranch.base } : { branch, existing: o.branch }, ...(o.brief ? { prompt: o.brief } : {}), ...(hook ? { beforeStart: hook } : {}),
    });
    note('start', true, `${nw.name} in ${nw.cwd}`);
  } catch (e) { if (!patchFailed) note('start', false, msg(e)); return { steps }; }

  // --- stop: only when every earlier step is ok
  if (o.stopSource && steps.every(s => s.ok)) {
    try { await reg.stop(w.id); note('stop', true, `${w.name} stopped`); }
    catch (e) { note('stop', false, msg(e)); }
  }
  return { steps, worker: nw };
}

/** What a send would move. Nothing changes. */
export async function sendPreview(reg: Registry, hosts: HostPool, id: string, to: string, deps: Deps = {}):
  Promise<{ ahead: number; dirtyFiles: number; dirtyLines: number; repoFound: boolean; checks: Check[]; repo: string; host: string; roots: string[]; agent: string }> {
  const run = deps.run ?? defaultRun;
  const w = reg.get(id);
  const link = hosts.link(to);
  if (!w) throw new Error('unknown worker');
  const branch = await branchOf(w, run);
  const base = await baseOf(w, run);
  let ahead = 0;
  if (base && branch) {
    const r = await run(['git', 'rev-list', '--count', `${base}..${branch}`], w.cwd);
    if (r.code === 0) ahead = Number(r.out.trim()) || 0;
  }
  let dirtyFiles = 0; let dirtyLines = 0;
  const n = await run(['git', 'diff', '--numstat', 'HEAD'], w.cwd);
  if (n.code === 0) for (const line of n.out.split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t');
    dirtyFiles++; dirtyLines += (Number(a) || 0) + (Number(d) || 0);
  }
  const repoFound = !!(await findRepo(link, w.repo).catch(() => undefined));
  const checks = await checkHost(link, link.tunnelPort());
  return { ahead, dirtyFiles, dirtyLines, repoFound, checks, repo: w.repo, host: link.host.name, roots: link.host.roots, agent: w.agent ?? 'claude' };
}
