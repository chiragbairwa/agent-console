#!/usr/bin/env bun
import { runDoctor } from './doctor';

const USAGE = `agent-console — canvas for Claude Code terminals

Usage:
  agent-console [serve] [--no-open]   start the server and open the page
  agent-console open [--browser]      open the desktop app, or a browser window with --browser
                                      (starts the console when it is not running)
  agent-console install-launcher      Linux: add Agent Console to the app menu
  agent-console doctor                check tmux, agents, config dir, port
  agent-console doctor --host <id>    check one remote host over SSH
  agent-console rotate-token          make a new access token
  agent-console hook <Event>          (used by Claude Code hooks)
  agent-console mcp                   (used by Claude Code as an MCP server)
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd = 'serve', ...rest] = argv;
  switch (cmd) {
    case 'serve':
      return (await import('./serve')).serve(rest);
    case 'open':
      return (await import('./open')).openApp(rest);
    case 'install-launcher': {
      if (process.platform !== 'linux') { console.error('install-launcher is for Linux. On macOS and Windows, use Install in the browser menu.'); return 2; }
      const { installLauncher } = await import('./appwindow');
      const { selfCommand } = await import('./serve');
      const bin = selfCommand();
      if (bin.length > 1) { console.error('Run install-launcher from the installed binary (bun run install-bin).'); return 2; }
      console.log(`Added ${installLauncher(bin[0]!)}`);
      return 0;
    }
    case 'doctor': {
      const hi = rest.indexOf('--host');
      if (hi >= 0) {
        const id = rest[hi + 1];
        if (!id) { console.error('doctor --host needs a host id'); return 2; }
        const { getToken, loadConfig } = await import('./store');
        const { defaultSockDir } = await import('./ssh');
        const { hostDoctor } = await import('./doctor');
        const cfg = loadConfig();
        // The same port and token as `agent-console open` uses.
        const port = Number(process.env.AC_PORT ?? cfg.port ?? 7878);
        return hostDoctor(id, { hosts: cfg.hosts ?? [], port, token: getToken(), sockDir: defaultSockDir() });
      }
      const checks = await runDoctor();
      for (const c of checks) console.log(`${c.warn ? '!' : c.ok ? '✓' : '✗'} ${c.name.padEnd(11)} ${c.detail}`);
      return checks.every(c => c.ok) ? 0 : 1;
    }
    case 'rotate-token': {
      const { rotateToken } = await import('./store');
      rotateToken();
      console.log('New token written. Restart agent-console and the running sessions.');
      return 0;
    }
    case 'hook': {
      const { runHook } = await import('./hook');
      const stdin = await new Response(Bun.stdin.stream()).text();
      const out = await runHook(rest[0] ?? '', stdin, process.env);
      if (out) process.stdout.write(out);
      return 0;
    }
    case 'mcp':
      await (await import('./mcp')).runMcp(process.env);
      return 0;
    case '-h': case '--help': case 'help':
      console.log(USAGE);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  if (code !== 0 || !['serve', undefined].includes(process.argv[2])) process.exit(code);
}
