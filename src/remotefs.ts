import { posix } from 'node:path';
import type { HostLink } from './ssh';
import type { DirListing } from './dirs';
import type { Branches } from './branches';

/** Write a file on the host. The folder gets mode 0700 and the file mode 0600 (umask 077). */
export async function writeRemoteFile(link: HostLink, path: string, body: string): Promise<void> {
  const r = await link.exec(['sh', '-c', 'umask 077; mkdir -p "$(dirname "$1")" && cat > "$1" && chmod 600 "$1"', '_', path], body);
  if (r.code !== 0) throw new Error(`write ${path} on ${link.host.name} failed: ${r.err.trim() || `code ${r.code}`}`);
}

const MAX_DIRS = 500;

/** Expand a leading "~/" with the home folder of the host. */
async function expand(link: HostLink, p: string): Promise<string> {
  if (p === '~') return link.home();
  return p.startsWith('~/') ? posix.join(await link.home(), p.slice(2)) : p;
}

/** Git repositories one level under each root, on the host. Same shape as listRepos. */
export async function listRemoteRepos(link: HostLink, roots: string[]): Promise<{ name: string; path: string }[]> {
  const out: { name: string; path: string }[] = [];
  for (const raw of roots) {
    const root = await expand(link, raw);
    const r = await link.exec(['find', root, '-mindepth', '2', '-maxdepth', '2', '-name', '.git']).catch(() => undefined);
    if (!r || !r.out.trim()) continue; // a root that is missing or has no repos
    const found = r.out.split('\n').map(s => s.trim()).filter(Boolean).map(s => posix.dirname(s))
      .map(p => ({ name: posix.basename(p), path: p }));
    found.sort((a, b) => a.name.localeCompare(b.name));
    out.push(...found);
  }
  return out;
}

/** The sub-folders of one folder on the host. Same shape as listDirs. */
export async function listRemoteDirs(link: HostLink, path: string | undefined, o: { hidden?: boolean; roots?: string[] } = {}): Promise<DirListing> {
  const home = await link.home();
  const places = [{ name: 'Home', path: home },
    ...await Promise.all((o.roots ?? link.host.roots).map(async r => { const p = await expand(link, r); return { name: posix.basename(p) || p, path: p }; }))];
  const p = path && path.startsWith('/') ? posix.normalize(path).replace(/(.)\/$/, '$1') : home;
  const up = posix.dirname(p);
  const parent = up !== p ? up : null;
  const r = await link.exec(['ls', '-1pa', '--', p]);
  if (r.code !== 0) return { path: p, parent, places, dirs: [], error: r.err.trim() || 'cannot read this folder' };
  const names = r.out.split('\n').filter(n => n.endsWith('/') && n !== './' && n !== '../')
    .map(n => n.slice(0, -1)).filter(n => o.hidden || !n.startsWith('.'));
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const git = await link.exec(['find', p, '-mindepth', '2', '-maxdepth', '2', '-name', '.git']).catch(() => undefined);
  const gitDirs = new Set((git?.out ?? '').split('\n').filter(Boolean).map(s => posix.basename(posix.dirname(s.trim()))));
  return { path: p, parent, places, dirs: names.slice(0, MAX_DIRS).map(name => ({ name, path: posix.join(p, name), git: gitDirs.has(name) })) };
}

/** Branches of a Git repository on the host. Same shape as listBranches. */
export async function listRemoteBranches(link: HostLink, repo: string): Promise<Branches> {
  const run = async (args: string[]) => {
    const r = await link.exec(['git', '-C', repo, ...args]);
    if (r.code !== 0) throw new Error('not a git repository');
    return r.out.split('\n').map(s => s.trim()).filter(Boolean);
  };
  try {
    const [cur] = await run(['branch', '--show-current']).catch(() => [] as string[]);
    const local = await run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']);
    const remote = (await run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes']))
      .filter(b => !b.endsWith('/HEAD') && b.includes('/'));
    const current = cur ?? null;
    return { current, local: current ? [current, ...local.filter(b => b !== current)] : local, remote };
  } catch (e) {
    return { current: null, local: [], remote: [], error: (e as Error).message };
  }
}

/** Make a Git worktree on the host. Return its path. With existing=true the branch exists already and is checked out (no -b, no base). A branch or base with a leading "-" is refused before ssh runs. */
export async function addRemoteWorktree(link: HostLink, repo: string, branch: string, base: string | undefined, slug: (s: string) => string, existing = false): Promise<string> {
  if (!branch || branch.startsWith('-') || base?.startsWith('-')) throw new Error('bad branch name');
  if (!repo.startsWith('/')) throw new Error('repo path must be absolute');
  const wt = posix.join(posix.dirname(repo), 'worktrees', `${posix.basename(repo)}-${slug(branch)}`);
  const r = await link.exec(['git', '-C', repo, 'worktree', 'add', ...(existing ? [] : ['-b', branch]), '--', wt, ...(existing ? [branch] : base ? [base] : [])], undefined, { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`git worktree add on ${link.host.name} failed: ${r.err.trim() || `code ${r.code}`}`);
  return wt;
}
