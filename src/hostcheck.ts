import type { HostLink } from './ssh';

export interface Check { id: string; ok: boolean; warn?: boolean; text: string }

type Res = Omit<Check, 'id'>;

/** ssh runs a command without the login profile, so a PATH set in ~/.zshrc does not apply. */
const notFound = (bin: string) =>
  `${bin} not found on the PATH of a non-interactive SSH login. On macOS with Homebrew, add "export PATH=/opt/homebrew/bin:$PATH" to ~/.zshenv on the host.`;

/** Run the host checks over the link. A failing check never stops the others. */
export async function checkHost(link: HostLink, consolePort: number): Promise<Check[]> {
  const out: Check[] = [];
  const run = async (id: string, fn: () => Promise<Res | null>) => {
    try { const r = await fn(); if (r) out.push({ id, ...r }); }
    catch (e) { out.push({ id, ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };
  const sh = (cmd: string[]) => link.exec(cmd, undefined, { timeoutMs: 10000 });
  let os = '';

  await run('ssh', async () => ({ ok: link.state === 'up', text: link.state === 'up' ? `connected${link.latencyMs !== undefined ? `, ${link.latencyMs} ms` : ''}` : link.lastError ?? `link is ${link.state}` }));
  await run('os', async () => {
    const r = await sh(['uname', '-s']);
    os = r.out.trim();
    return r.code === 0 ? { ok: true, text: os } : { ok: false, text: r.err.trim() || 'uname failed' };
  });
  await run('tmux', async () => {
    const r = await sh(['tmux', '-V']);
    return r.code === 0 ? { ok: true, text: r.out.trim() } : { ok: false, text: notFound('tmux') };
  });
  await run('claude', async () => {
    const r = await sh(['claude', '--version']);
    return r.code === 0 ? { ok: true, text: r.out.trim() } : { ok: false, text: notFound('claude') };
  });
  await run('login', async () => {
    const r = await sh(['claude', 'auth', 'status']);
    return r.code === 0 ? { ok: true, text: 'Claude is logged in' }
      : { ok: true, warn: true, text: 'Claude is not logged in. Run "claude login" on the host, or set CLAUDE_CODE_OAUTH_TOKEN there.' };
  });
  await run('tunnel', async () => {
    const r = await sh(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${link.tunnelPort()}/api/health`]);
    return r.code === 0 && r.out.trim() === '200' ? { ok: true, text: `tunnel port ${link.tunnelPort()} reaches the console` }
      : { ok: false, text: `The host cannot reach the console through tunnel port ${link.tunnelPort()}` };
  });
  if (os === 'Darwin') await run('sleep', async () => {
    const r = await sh(['pmset', '-g']);
    const m = /^\s*sleep\s+(\d+)/m.exec(r.out);
    if (!m) return { ok: true, warn: true, text: 'Could not read the sleep setting' };
    return m[1] === '0' ? { ok: true, text: 'The Mac does not sleep' }
      : { ok: true, warn: true, text: `The Mac sleeps after ${m[1]} min. Run: sudo pmset -a sleep 0` };
  });
  await run('roots', async () => {
    const roots = link.host.roots;
    if (!roots.length) return { ok: true, text: 'no repo folders set' };
    const bad: string[] = [];
    for (const r of roots) if ((await sh(['test', '-d', r])).code !== 0) bad.push(r);
    return bad.length ? { ok: false, text: `Folder not found: ${bad.join(', ')}` } : { ok: true, text: roots.join(', ') };
  });
  return out;
}

export const checkMark = (c: Check) => c.warn ? '!' : c.ok ? '✓' : '✗';
