import type { HostLink } from './ssh';
import { expand } from './remotefs';

export interface Check { id: string; ok: boolean; warn?: boolean; text: string }

type Res = Omit<Check, 'id'>;

/** ssh runs a command without the login profile, so a PATH set in ~/.zshrc does not apply. */
const notFound = (bin: string) =>
  `${bin} not found on the PATH of a non-interactive SSH login. Add its folder to ~/.zshenv on the host: "export PATH=$HOME/.local/bin:$PATH" for the native Claude installer, "export PATH=/opt/homebrew/bin:$PATH" for Homebrew on macOS.`;

/** The HTTP codes that prove the console answered: /api/health needs the token, so a call without it gets 401 or 403. */
const CONSOLE_ANSWERED = ['200', '401', '403'];

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
  let claudeFound = false;
  await run('claude', async () => {
    const r = await sh(['claude', '--version']);
    claudeFound = r.code === 0;
    return claudeFound ? { ok: true, text: r.out.trim() } : { ok: false, text: notFound('claude') };
  });
  await run('login', async () => {
    // Without the claude binary, "auth status" fails too. Do not report that as a missing login.
    if (!claudeFound) return { ok: true, warn: true, text: 'The login cannot be checked until the claude check passes.' };
    const r = await sh(['claude', 'auth', 'status']);
    if (r.code === 0) return { ok: true, text: 'Claude is logged in' };
    // On macOS, "claude login" keeps the login in the Keychain. An SSH login cannot read a locked Keychain,
    // so Claude can work in a Terminal on the Mac and still be logged out for a worker.
    return { ok: true, warn: true, text: os === 'Darwin'
      ? 'Claude is not logged in for an SSH login. On macOS the login is in the Keychain, which SSH cannot read. Run "claude setup-token" on the Mac and add "export CLAUDE_CODE_OAUTH_TOKEN=<token>" to ~/.zshenv there.'
      : 'Claude is not logged in. Run "claude login" on the host, or set CLAUDE_CODE_OAUTH_TOKEN there.' };
  });
  await run('tunnel', async () => {
    const r = await sh(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${link.tunnelPort()}/api/health`]);
    return r.code === 0 && CONSOLE_ANSWERED.includes(r.out.trim()) ? { ok: true, text: `tunnel port ${link.tunnelPort()} reaches the console` }
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
    // A root such as "~/code" is passed quoted, so the remote shell does not expand "~". Expand it here.
    for (const r of roots) if ((await sh(['test', '-d', await expand(link, r)])).code !== 0) bad.push(r);
    return bad.length ? { ok: false, text: `Folder not found: ${bad.join(', ')}` } : { ok: true, text: roots.join(', ') };
  });
  return out;
}

export const checkMark = (c: Check) => c.warn ? '!' : c.ok ? '✓' : '✗';
/** The CSS class of a check row. A warning is ok=true, so test warn first. */
export const checkClass = (c: Check) => c.warn ? 'wn' : c.ok ? 'ok' : 'bad';
