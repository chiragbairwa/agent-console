import { openSync } from 'node:fs';
import { join } from 'node:path';
import { uiCommand } from './appwindow';
import { configDir } from './paths';
import { selfCommand } from './serve';
import { getToken, loadConfig } from './store';

/** `agent-console open`: start the console when it is not running, then open the app window. */
export async function openApp(args: string[] = []): Promise<number> {
  const port = Number(process.env.AC_PORT ?? loadConfig().port);
  const token = getToken();
  const base = `http://127.0.0.1:${port}`;
  const up = () => fetch(`${base}/api/health`, { headers: { 'x-ac-token': token }, signal: AbortSignal.timeout(1000) })
    .then(r => r.ok).catch(() => false);
  if (!(await up())) {
    // Detached, so the console keeps running when this command or its terminal ends.
    const detach = Bun.which('setsid') ? ['setsid'] : Bun.which('nohup') ? ['nohup'] : [];
    const log = openSync(join(configDir(), 'serve.log'), 'a');
    Bun.spawn([...detach, ...selfCommand(), 'serve', '--no-open'], { stdin: 'ignore', stdout: log, stderr: log }).unref();
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) { await Bun.sleep(250); ok = await up(); }
    if (!ok) { console.error(`Agent Console did not start. See ${join(configDir(), 'serve.log')}.`); return 1; }
  }
  const { cmd, kind } = uiCommand(`${base}/?token=${token}`, { browser: args.includes('--browser') });
  Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref();
  console.log({ desktop: 'Opened the Agent Console desktop app.', app: 'Opened the Agent Console browser window.',
    tab: 'No Chrome, Chromium, Edge or Brave found: opened a browser tab.' }[kind]);
  return 0;
}
