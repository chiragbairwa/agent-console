import { loadConfig, getToken } from './store';
import { Registry } from './workers';
import { Tmux } from './tmux';
import { startServer } from './server';
import { ADVISOR_PROMPT, ensureAdvisor } from './advisor';
import { Digest } from './digest';
import { uiCommand } from './appwindow';
import { withUserBins } from './paths';

/** How hooks and MCP call back into this program: the compiled binary, or bun + this source file. */
export function selfCommand(): string[] {
  const compiled = import.meta.path.startsWith('/$bunfs');
  return compiled ? [process.execPath] : [process.execPath, new URL('./cli.ts', import.meta.url).pathname];
}

export async function serve(args: string[]): Promise<number> {
  // tmux, claude and the hooks inherit this PATH (see withUserBins).
  if (process.platform !== 'win32') process.env.PATH = withUserBins(process.env.PATH ?? '');
  const cfg = loadConfig();
  const port = Number(process.env.AC_PORT ?? cfg.port);
  const token = getToken();
  const tmux = new Tmux(process.env.AC_TMUX_SOCKET ?? 'agent-console');
  const url = `http://127.0.0.1:${port}`;
  const reg = new Registry(tmux, cfg, { bin: selfCommand(), url, token, advisorPrompt: ADVISOR_PROMPT });
  await reg.discover();
  await tmux.configure(); // sessions from before a restart get the current options too
  const server = startServer({ reg, cfg, token, port, tmux });
  try { await ensureAdvisor(reg, cfg); } catch (e) { console.error(`advisor did not start: ${(e as Error).message}`); }

  const open = `${url}/?token=${token}`;
  console.log(`Agent Console: ${open}`);
  console.log(`Sessions: tmux -L ${tmux.socket} ls`);
  // After a restart the old tab reconnects by itself (it retries every 2 s) and keeps its canvas.
  // Open a new tab only when no page came back.
  if (!args.includes('--no-open')) {
    void waitForPage(() => server.subscriberCount('state'), 4000).then(back => {
      if (back) console.log('An open page reconnected; no new tab.');
      else { const ui = uiCommand(open); Bun.spawn(ui.cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref(); console.log(`Opened the ${ui.kind === 'desktop' ? 'desktop app' : 'browser'}.`); }
    });
  }

  const poll = setInterval(() => reg.pollLinked(), 3000);
  const digest = new Digest(reg);
  const digestTimer = cfg.advisorDigestMin > 0
    ? setInterval(() => { void digest.tick().catch(e => console.error(`status check: ${(e as Error).message}`)); }, cfg.advisorDigestMin * 60_000)
    : undefined;
  const shutdown = () => { clearInterval(poll); clearInterval(digestTimer); reg.flush(); server.stop(true); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

/** Resolves true as soon as count() > 0, or false after ms. */
export async function waitForPage(count: () => number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (count() > 0) return true; await Bun.sleep(100); }
  return count() > 0;
}

