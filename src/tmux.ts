import type { ExecResult, HostLink } from './ssh';

const ENTER_RETRIES = 2;
const RETRY_MS = 350;
/** Longer text needs longer before Enter: 80 ms plus 1 ms for each 10 characters, at most 580 ms. */
export const settleMs = (text: string) => 80 + Math.min(Math.round(text.length / 10), 500);

/**
 * True when Claude Code's input box still holds the message. The box is the text between the
 * last two horizontal rules (────) on the screen. A long message can show as "[Pasted text #1 …]".
 * With no such box on the screen (a plain shell), this is false, so nothing is retried.
 */
export function stillInInput(screen: string, text: string): boolean {
  const rows = screen.replace(/\n+$/, '').split('\n');
  const rules: number[] = [];
  rows.forEach((r, i) => { if (/^\s*─{20,}/.test(r)) rules.push(i); });
  if (rules.length < 2) return false;
  const box = rows.slice(rules.at(-2)! + 1, rules.at(-1)!).join(' ').replace(/[│\s]+/g, ' ').replace(/^ ?[❯>] ?/, '').trim();
  if (!box) return false;
  if (/\[Pasted text #\d+/.test(box)) return true;
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 24);
  return head.length > 0 && box.startsWith(head);
}

/** Claude Code draws its input box between two horizontal rules. */
const hasInputBox = (screen: string) => (screen.match(/^\s*─{20,}/gm) ?? []).length >= 2;

/** Runs tmux. `args` start with `-L <socket>`. A non-zero code is a result, not an error. */
export type TmuxRunner = (args: string[], stdin?: string) => Promise<ExecResult>;

/** The local runner: Bun.spawn on this machine. */
const localRunner: TmuxRunner = async (args, stdin) => {
  // Pass env: Bun.spawn does not see later changes to process.env (serve adds user bin folders to PATH).
  const p = Bun.spawn(['tmux', ...args], { env: { ...process.env },
    stdout: 'pipe', stderr: 'pipe', stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin) });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

/** Thin wrapper over one tmux server (`tmux -L <socket>`), on this machine or on a remote host. */
export class Tmux {
  private configured = false;
  private runner: TmuxRunner;
  private attach: (name: string) => string[];
  constructor(readonly socket = 'agent-console', runner?: TmuxRunner, attach?: (name: string) => string[]) {
    this.runner = runner ?? localRunner;
    this.attach = attach ?? (name => ['tmux', '-L', this.socket, 'attach', '-t', name]);
  }

  private async run(args: string[], allowFail = false, stdin?: string): Promise<string> {
    const { out, err, code } = await this.runner(['-L', this.socket, ...args], stdin);
    if (code !== 0 && !allowFail) throw new Error(`tmux ${args[0]} failed: ${err.trim()}`);
    return code === 0 ? out : '';
  }

  async newSession(name: string, cwd: string, env: Record<string, string>, cmd: string[]): Promise<void> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    await this.run(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envArgs, ...cmd]);
    if (!this.configured) await this.configure();
  }

  /**
   * Server-wide options. Needs a running tmux server; call again after start-up when the
   * sessions already exist (they survive a console restart, so newSession may never run).
   * `mouse on` makes tmux ask the browser terminal for mouse events and pass clicks and
   * the wheel on to Claude Code, which tracks the mouse itself.
   */
  async configure(): Promise<void> {
    const opts: [string, string][] = [['window-size', 'latest'], ['status', 'off'], ['mouse', 'on']];
    for (const [k, v] of opts) await this.run(['set-option', '-g', k, v], true);
    // With no server running the options fail silently; try again on the next newSession.
    this.configured = (await this.list()).length > 0;
  }

  async list(): Promise<string[]> {
    const out = await this.run(['list-sessions', '-F', '#{session_name}'], true);
    return out.split('\n').filter(Boolean);
  }

  async has(name: string): Promise<boolean> {
    return (await this.list()).includes(name);
  }

  async kill(name: string): Promise<void> {
    await this.run(['kill-session', '-t', name], true);
  }

  /** One queue per session, so two senders cannot interleave text and Enter (review I3). */
  private queues = new Map<string, Promise<void>>();
  private serial(name: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(name) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(name, next.catch(() => {}));
    return next;
  }

  /**
   * Type a message and submit it. Claude Code reads a fast burst of keys as a paste, and an
   * Enter that comes while the paste is still handled is lost: long messages stayed in the
   * input box. So: a bracketed paste, a short wait, Enter, then look at the input box and
   * press Enter again while the text is still there.
   */
  async sendText(name: string, text: string): Promise<void> {
    return this.serial(name, async () => {
      const claudeBox = hasInputBox(await this.capture(name)); // a plain shell needs no check
      const buf = `ac-send-${Math.random().toString(36).slice(2, 10)}`;
      await this.run(['load-buffer', '-b', buf, '-'], false, text);
      await this.run(['paste-buffer', '-p', '-d', '-b', buf, '-t', name]);
      await Bun.sleep(settleMs(text));
      await this.run(['send-keys', '-t', name, 'Enter']);
      for (let i = 0; claudeBox && i < ENTER_RETRIES; i++) {
        await Bun.sleep(RETRY_MS);
        if (!stillInInput(await this.capture(name), text)) return;
        await this.run(['send-keys', '-t', name, 'Enter']);
      }
    });
  }

  async sendKey(name: string, key: string): Promise<void> {
    await this.run(['send-keys', '-t', name, key]);
  }

  async capture(name: string, opts: { escapes?: boolean; lines?: number } = {}): Promise<string> {
    const args = ['capture-pane', '-p', '-t', name];
    if (opts.escapes) args.push('-e');
    const out = await this.run(args, true);
    if (!opts.lines) return out;
    const rows = out.replace(/\n+$/, '').split('\n');
    return rows.slice(-opts.lines).join('\n') + '\n';
  }

  attachArgs(name: string): string[] {
    return this.attach(name);
  }
}

/** A Tmux that runs on a remote host through its SSH link. A link that is not up counts as a tmux failure. */
export function remoteTmux(link: HostLink, socket: string): Tmux {
  const runner: TmuxRunner = async (args, stdin) => {
    try { return await link.exec(['tmux', ...args], stdin); }
    catch (e) { return { out: '', err: e instanceof Error ? e.message : String(e), code: 1 }; }
  };
  return new Tmux(socket, runner, name => link.sshArgs(['tmux', '-L', socket, 'attach', '-t', name], true));
}
