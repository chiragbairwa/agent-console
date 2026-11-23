/** Branches of a Git repository, for the "From Branch" combobox. The current branch comes first. */
export interface Branches { current: string | null; local: string[]; remote: string[]; error?: string }

export async function listBranches(repo: string): Promise<Branches> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) throw new Error('not a git repository');
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  };
  try {
    const [cur] = await run(['branch', '--show-current']).catch(() => [] as string[]);
    const local = await run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']);
    const remote = (await run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes']))
      .filter(r => !r.endsWith('/HEAD') && r.includes('/'));
    const current = cur ?? null;
    return { current, local: current ? [current, ...local.filter(b => b !== current)] : local, remote };
  } catch (e) {
    return { current: null, local: [], remote: [], error: (e as Error).message };
  }
}
