# Remote Hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One laptop Agent Console runs and watches Claude workers on other machines over SSH. It has Remmina-style host profiles, a Hosts panel, Group by Host, Send to Host and a plain shell box.

**Architecture:** An SSH master connection per host (`ControlMaster`) carries every remote tmux call and a reverse tunnel. Through the tunnel, the remote Claude hooks and MCP reach the laptop server at `127.0.0.1:<tunnelPort>`. A `TmuxPool` gives each worker the `Tmux` of its host. `Tmux` gets a pluggable runner (local spawn or ssh).

**Tech Stack:** Bun, TypeScript, `bun:test`, tmux, OpenSSH client, vanilla TS web UI (`web/`).

**Spec:** `docs/superpowers/specs/2026-11-26-remote-hosts-design.md`

## Global Constraints

- The web server binds only to `127.0.0.1`. The reverse tunnel binds to `127.0.0.1` on the remote host.
- No password and no private key in `config.json`, `state.json` or any file of the console. Only `identityFile` paths and SSH aliases.
- Every ssh call uses `-o BatchMode=yes`.
- Every remote command argument goes through `shq()` (Task 1). No string concatenation of user input into a remote command.
- A branch name or base with a leading `-` stays refused.
- A worker with no `host`, or with `host: 'local'`, behaves exactly as today. All existing tests pass without change.
- Remote session files have mode 0600. Their folder has mode 0700 (`umask 077`).
- Version step at the end: `package.json` and `src/mcp.ts` from `0.4.0` to `0.5.0`. Commit `chore: release v0.5.0`. Tag `v0.5.0`. `desktop/` does not change, so the desktop version stays.
- Prose in docs and comments: Simplified Technical English.
- Run `bun test` and `bun run typecheck` before every commit of a task.

## Review Focus

1. **The tunnel port is in use on the remote host** (a console runs there too). Expect: connect fails with an error that names the port and "Tunnel port" in the profile. No retry loop at full speed. → test in Task 3.
2. **The SSH master dies while workers run.** Expect: the boxes show `Host offline`, the records stay, the tmux sessions on the host are not killed, and on reconnect the boxes go back to `idle`. → test in Task 6.
3. **A repo path or branch with spaces, quotes or `$(…)`.** Expect: the remote command gets it as one literal argument. → test in Task 1 and Task 7.
4. **A hook from the remote host arrives with Host `127.0.0.1:<tunnelPort>`.** Expect: accepted with the token, refused without it. Any other host port stays refused. → test in Task 5.
5. **Send to Host fails half way** (the bundle fetch fails). Expect: the source worker keeps running and is not stopped; Activity names the failed step. → test in Task 11.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/shq.ts` | new | Shell quoting for remote commands. |
| `src/hosts.ts` | new | `Host` type helpers: validate, slug, `~/.ssh/config` import. |
| `src/ssh.ts` | new | `HostLink`: master connection, control socket, `exec`, state, reconnect. |
| `src/hostpool.ts` | new | `HostPool` (links) and `TmuxPool` (tmux per host). |
| `src/hostcheck.ts` | new | `checkHost()` doctor checks. |
| `src/remotefs.ts` | new | Remote repos, dirs, branches, file write. |
| `src/sendtohost.ts` | new | The Send to Host steps. |
| `src/tmux.ts` | modify | Pluggable runner; remote `attachArgs`. |
| `src/types.ts` | modify | `Host`, `Config.hosts`, `Worker.host`, `Worker.kind: 'shell'`, new events. |
| `src/store.ts` | modify | Load and save `hosts`. |
| `src/workers.ts` | modify | Use `TmuxPool`; remote session files; remote worktree; discover per host. |
| `src/agents/claude.ts` | modify | `sessionFiles` takes the `AC_URL` and the file dir to use in args. |
| `src/server.ts` | modify | `hostOk` tunnel ports; host API routes; PtyHub through pool. |
| `src/pty.ts` | modify | Attach args from the worker's `Tmux`. |
| `src/tools.ts`, `src/mcp.ts` | modify | Host in `list_connections`; capture through pool. |
| `src/doctor.ts`, `src/cli.ts` | modify | `doctor --host <id>`. |
| `src/advisor.ts` | modify | One prompt line about hosts. |
| `src/serve.ts` | modify | Build pools; auto-connect hosts. |
| `web/hosts.ts` | new | Hosts sidebar, host manager, profile dialog. |
| `web/sendtohost.ts` | new | Send to Host dialog. |
| `web/app.ts`, `web/canvas.ts`, `web/index.html`, `web/styles.css` | modify | Badge, Host switch, Group by Host, lanes, shell box. |
| `tests/*.test.ts` | new/modify | One test file per new src file; `FakeRunner` in `tests/fakes.ts`. |

---

## Stage 1 — SSH layer and host profiles

### Task 1: Shell quoting

**Files:** Create `src/shq.ts`. Test `tests/shq.test.ts`.

**Interfaces:**
- Produces: `shq(arg: string): string` and `shJoin(args: string[]): string` (each arg quoted, joined by spaces).

- [ ] **Step 1: Write the failing tests**

```ts
test('plain word stays readable', () => expect(shq('main')).toBe("'main'"));
test('single quote is escaped', () => expect(shq("it's")).toBe(`'it'\\''s'`));
test('command substitution is literal', async () => {
  const out = await $`sh -c ${'printf %s ' + shq('$(echo pwned) a b')}`.text();
  expect(out).toBe('$(echo pwned) a b');
});
test('shJoin quotes each arg', () => expect(shJoin(['git', '-C', '/a b'])).toBe("'git' '-C' '/a b'"));
```

- [ ] **Step 2: Run** `bun test tests/shq.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** both functions in `src/shq.ts` (POSIX single-quote form).
- [ ] **Step 4: Run** `bun test tests/shq.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: shell quoting helper for remote commands`.

### Task 2: Host type, config and `~/.ssh/config` import

**Files:** Create `src/hosts.ts`. Modify `src/types.ts`, `src/store.ts`. Test `tests/hosts.test.ts`, `tests/store.test.ts`.

**Interfaces:**
- Produces (in `types.ts`): the `Host` interface exactly as spec §7.1; `Config.hosts?: Host[]`; `Worker.host?: string`; `Worker.kind?: 'tmux' | 'linked' | 'shell'`.
- Produces (in `hosts.ts`): `validateHost(h: unknown): Host` (throws `Error` with the field name), `parseSshConfig(text: string): Partial<Host>[]`, `isLocal(host?: string): boolean`.
- Produces (in `store.ts`): `loadConfig()` returns valid `hosts` only; `saveHosts(hosts: Host[]): void` writes them into `config.json` and keeps the other keys.

- [ ] **Step 1: Write the failing tests**

```ts
test('validateHost refuses id local', () => expect(() => validateHost({ id: 'local', name: 'x', ssh: 'a', roots: [] })).toThrow('id'));
test('validateHost refuses a password field', () => expect(() => validateHost({ id: 'm', name: 'M', ssh: 'a', roots: [], password: 'x' })).toThrow('password'));
test('validateHost refuses ssh starting with -', () => expect(() => validateHost({ id: 'm', name: 'M', ssh: '-oProxyCommand=x', roots: [] })).toThrow('ssh'));
test('parseSshConfig reads alias, HostName, User, Port, IdentityFile, ProxyJump', () => {
  const r = parseSshConfig('Host macmini\n  HostName 192.168.2.182\n  User scaffplan\n  Port 2222\n  IdentityFile ~/.ssh/id_mac\nHost *\n  ServerAliveInterval 30\n');
  expect(r).toEqual([{ id: 'macmini', name: 'macmini', ssh: 'macmini', port: 2222, identityFile: '~/.ssh/id_mac', roots: [] }]);
});
test('isLocal', () => { expect(isLocal()).toBe(true); expect(isLocal('local')).toBe(true); expect(isLocal('mac')).toBe(false); });
// store.test.ts
test('loadConfig drops an invalid host and keeps a valid one', /* write config.json with two hosts, expect one */);
test('saveHosts keeps port and roots', /* save, reload, expect same port/roots */);
```

`ssh` uses the alias when the import has a `Host` alias: `ssh -S` then resolves `HostName`, `User` and `Port` from `~/.ssh/config` by itself.

- [ ] **Step 2: Run** `bun test tests/hosts.test.ts tests/store.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the types, `hosts.ts` and the `store.ts` changes.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** `feat: host profiles in config and ssh config import`.

### Task 3: `HostLink` — master connection and exec

**Files:** Create `src/ssh.ts`. Modify `tests/fakes.ts`. Test `tests/ssh.test.ts`.

**Interfaces:**
- Consumes: `Host`, `shJoin`.
- Produces:
  ```ts
  type LinkState = 'down' | 'connecting' | 'up' | 'error';
  interface ExecResult { out: string; err: string; code: number }
  type Spawner = (cmd: string[], stdin?: string) => Promise<ExecResult>;
  class HostLink extends EventTarget {            // emits 'state'
    constructor(host: Host, o: { consolePort: number; sockDir: string; spawn?: Spawner; now?: () => number });
    readonly host: Host; state: LinkState; latencyMs?: number; lastError?: string;
    sock(): string;                                // `${sockDir}/${host.id}.sock`
    tunnelPort(): number;                          // host.tunnelPort ?? consolePort
    masterArgs(): string[];                        // spec §7.2 master command
    sshArgs(remote: string[], tty?: boolean): string[]; // ['ssh','-S',sock,'-o','BatchMode=yes',(tty?'-t')...,target,'--',shJoin(remote)]
    connect(): Promise<void>; disconnect(): Promise<void>;
    exec(remote: string[], stdin?: string): Promise<ExecResult>;   // throws when state !== 'up'
  }
  ```
- `FakeRunner` in `tests/fakes.ts`: records `cmd` arrays, returns scripted `ExecResult`s by first matching prefix.

- [ ] **Step 1: Write the failing tests**

```ts
test('masterArgs has ControlMaster, BatchMode, ExitOnForwardFailure and the reverse tunnel', () => {
  const l = new HostLink({ id: 'mac', name: 'Mac', ssh: 'macmini', roots: [] }, { consolePort: 7878, sockDir: '/s', spawn: fake.spawn });
  expect(l.masterArgs()).toEqual(expect.arrayContaining(['-M', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-R', '127.0.0.1:7878:127.0.0.1:7878', 'macmini']));
});
test('tunnelPort comes from the profile when set', /* tunnelPort 17878 → '-R','127.0.0.1:17878:127.0.0.1:7878' */);
test('port, identityFile and jump map to -p, -i, -J', /* expect those pairs */);
test('exec before connect throws "Mac is not connected"');
test('connect: master ok + echo probe ok → state up and latencyMs set');
test('connect: master stderr "remote port forwarding failed for listen port 7878" → state error, lastError names 7878 and "Tunnel port"');
test('connect: "Permission denied" → state error, lastError says ssh-agent or key file, no password');
test('state changes emit a state event');
```

- [ ] **Step 2: Run** `bun test tests/ssh.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `HostLink`. `connect()` spawns the master detached (it daemonises with `ControlPersist=yes` and `-f`), then runs `ssh -S sock -O check` and an `echo ok` probe and times it. `disconnect()` runs `ssh -S sock -O exit`. Make `sockDir` with mode 0700.
- [ ] **Step 4: Run** `bun test tests/ssh.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: ssh host link with control master and reverse tunnel`.

### Task 4: `HostPool`, reconnect, `checkHost` and `doctor --host`

**Files:** Create `src/hostpool.ts` (the `HostPool` part), `src/hostcheck.ts`. Modify `src/doctor.ts`, `src/cli.ts`. Test `tests/hostpool.test.ts`, `tests/hostcheck.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  class HostPool extends EventTarget {             // re-emits 'state' with { id }
    constructor(hosts: Host[], o: { consolePort: number; sockDir: string; spawn?: Spawner; sleep?: (ms: number) => Promise<void> });
    link(id: string): HostLink;                    // throws 'unknown host <id>'
    all(): HostLink[]; set(hosts: Host[]): void;   // adds, updates, removes (disconnects removed)
    connectAuto(): Promise<void>;                  // hosts with autoConnect
  }
  const BACKOFF_MS = [2000, 5000, 15000, 30000];   // last value repeats
  interface Check { id: string; ok: boolean; warn?: boolean; text: string }
  function checkHost(link: HostLink, consolePort: number): Promise<Check[]>;
  ```
- Check ids, in order: `ssh`, `os`, `tmux`, `claude`, `login`, `tunnel`, `sleep` (macOS only), `roots`.

- [ ] **Step 1: Write the failing tests**

```ts
test('reconnect: a host with reconnect=true that drops to error retries after 2000, then 5000 ms', /* fake sleep records waits */);
test('reconnect stops after disconnect()');
test('set() disconnects a removed host');
test('checkHost: pmset "sleep 1" → sleep check warn=true and text has "sudo pmset -a sleep 0"');
test('checkHost: no Claude login → login warn with "CLAUDE_CODE_OAUTH_TOKEN"');
test('checkHost: tunnel curl to 127.0.0.1:<tunnelPort>/api/health fails → tunnel ok=false');
test('checkHost: Linux host has no sleep check');
```

- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Remote commands: `uname -s`, `tmux -V`, `claude --version`, `claude auth status` (exit 0 = logged in), `curl -s -o /dev/null -w %{http_code} http://127.0.0.1:<tunnelPort>/api/health`, `pmset -g`, `test -d <root>` per root. `doctor --host <id>` prints each check as `✓`, `!` or `✗` plus text, exit 1 when one is not ok.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: host pool, reconnect and host doctor checks`.

## Stage 2 — Remote tmux and remote workers

### Task 5: Pluggable tmux runner, `TmuxPool`, `hostOk` tunnel ports

**Files:** Modify `src/tmux.ts`, `src/hostpool.ts`, `src/server.ts`, `src/pty.ts`, `tests/fakes.ts`. Test `tests/tmux.test.ts`, `tests/hostpool.test.ts`, `tests/server.test.ts`, `tests/pty.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  type TmuxRunner = (args: string[], stdin?: string) => Promise<ExecResult>;
  class Tmux { constructor(socket?: string, runner?: TmuxRunner, attach?: (name: string) => string[]) }
  function remoteTmux(link: HostLink, socket: string): Tmux;  // runner = link.exec(['tmux','-L',socket,...args]); attach = link.sshArgs(['tmux','-L',socket,'attach','-t',name], true)
  class TmuxPool { constructor(local: Tmux, hosts: HostPool); of(host?: string): Tmux; }
  ```
- `startServer` options get `pool: TmuxPool` and `hosts: HostPool`. `PtyHub` takes a `(id) => string[]` attach function in place of a `Tmux`.

- [ ] **Step 1: Write the failing tests**

```ts
test('Tmux with a runner sends its args to the runner, not to Bun.spawn', /* FakeRunner sees ['-L','s','list-sessions',...] */);
test('remoteTmux.newSession runs ssh ... tmux -L agent-console new-session ... with quoted args');
test('remoteTmux.attachArgs starts with ssh -S <sock> and has -t');
test('TmuxPool.of() and of("local") return the local Tmux; of("mac") returns the remote one');
test('hostOk accepts 127.0.0.1:17878 when a host has tunnelPort 17878, with the token');
test('hostOk refuses 127.0.0.1:17878 without the token');
test('hostOk refuses 127.0.0.1:9999 (no host has it)');
test('PtyHub uses the attach function of the worker host');
```

- [ ] **Step 2: Run** the four test files. Expected: new tests FAIL, old tests PASS.
- [ ] **Step 3: Implement.** The default runner keeps today's `Bun.spawn(['tmux','-L',socket,...])` code exactly.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: tmux runner per host and tunnel ports in host check`.

### Task 6: Remote workers in the registry

**Files:** Modify `src/workers.ts`, `src/agents/claude.ts`, `src/agents/types.ts`, `src/tools.ts`, `src/serve.ts`, `src/remotefs.ts` (create, `writeRemoteFile` only). Test `tests/workers.test.ts`, `tests/sessionfiles.test.ts`, `tests/remotefs.test.ts`.

**Interfaces:**
- Consumes: `TmuxPool`, `HostPool`, `HostLink.exec`, `HostLink.tunnelPort()`.
- Produces:
  - `Registry` constructor: `new Registry(pool: TmuxPool, cfg, opts & { hosts?: HostPool })`. Every `this.tmux.x(sessionName(id))` becomes `this.tmuxOf(id).x(...)`; `tmuxOf(id: string): Tmux`.
  - `SpawnInput.host?: string`. `Worker.host` set from it (omitted for local).
  - `LaunchInput` gets `url` per worker (remote: `http://127.0.0.1:<tunnelPort>`) and `fileDir?: string` (the remote session dir used in `--settings` and `--mcp-config` args).
  - `writeRemoteFile(link: HostLink, path: string, body: string): Promise<void>` — `sh -c 'umask 077; mkdir -p "$(dirname "$1")" && cat > "$1"' _ <path>` with the body on stdin.
  - `discoverHost(id: string): Promise<void>`; `discover()` calls it for each `up` host.
  - Registry listens to `HostPool` `state`: `up` → `discoverHost(id)`; `down`/`error` → each worker of that host gets status `stopped`, task `Host offline`.

- [ ] **Step 1: Write the failing tests**

```ts
test('spawn with host=mac starts the session through the mac Tmux, not the local one');
test('spawn with host=mac writes settings.json and mcp.json on the host with mode 600 (umask 077)');
test('remote settings.json hooks point at http://127.0.0.1:<tunnelPort>/hook/...');
test('remote claude args use the remote file paths ~/.config/agent-console/sessions/<id>/settings.json');
test('spawn with an unknown host throws "unknown host" and starts nothing');
test('spawn with a host that is not up throws "Mac is not connected"');
test('host state error → its workers show Host offline; records stay; no kill call is made');
test('host state up again → discoverHost marks live sessions idle');
test('capture tool reads through the worker host');
test('a local spawn is unchanged (same newSession args as before)');
```

- [ ] **Step 2: Run** the three test files. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Remote home folder: resolve once per link with `printf %s "$HOME"` and cache it on `HostLink` (`home(): Promise<string>`).
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Manual check on the Mac mini.** Connect the host with `agent-console doctor --host mac`. Start a worker on it from the API with `curl -X POST /api/workers` (body `{ name, repo, host: 'mac' }`). Expected: the box shows a live terminal, a prompt typed in the box runs, and a `git push --dry-run` shows in Needs You. Write the result in the commit body as `visually-confirmed` or `not checked`.
- [ ] **Step 6: Commit** `feat: start and watch workers on remote hosts`.

## Stage 3 — Remote repos and Add Worker

### Task 7: Remote repos, dirs, branches and worktrees

**Files:** Modify `src/remotefs.ts`, `src/server.ts`, `src/workers.ts`. Test `tests/remotefs.test.ts`, `tests/server.test.ts`, `tests/workers.test.ts`.

**Interfaces:**
- Produces: `listRemoteRepos(link, roots): Promise<string[]>`, `listRemoteDirs(link, path): Promise<{ path; dirs: string[] }>`, `listRemoteBranches(link, repo): Promise<string[]>`. Routes `GET /api/repos|dirs|branches?host=<id>` use them when `host` is not local.
- `spawn` with host + worktree runs `git -C <repo> worktree add <wt> -b <branch> [base]` through `link.exec`.

- [ ] **Step 1: Write the failing tests**

```ts
test('GET /api/repos?host=mac lists repos from the mac roots');
test('GET /api/branches?host=mac&path=/r runs git -C /r branch ... through ssh');
test('a repo path with a space and $(x) reaches the host as one literal argument');
test('remote worktree add gets the branch; a branch "-x" is refused before ssh runs');
test('GET /api/repos?host=nope → 404 unknown host');
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: remote repos, branches and worktrees`.

### Task 8: Host API, Add Worker host switch, badges, MCP host field

**Files:** Modify `src/server.ts`, `src/tools.ts`, `src/mcp.ts`, `src/advisor.ts`, `src/types.ts` (event), `web/app.ts`, `web/index.html`, `web/styles.css`. Test `tests/server.test.ts`, `tests/mcp.test.ts`, `tests/web-route.test.ts`.

**Interfaces:**
- Produces routes: `GET /api/hosts` → `{ hosts: (Host & { state, latencyMs?, lastError?, workers: number })[] }`; `POST /api/hosts` (save list, validated by `validateHost`); `POST /api/hosts/<id>/connect`, `/disconnect`, `GET /api/hosts/<id>/check` → `Check[]`; `GET /api/hosts/import` → `parseSshConfig(~/.ssh/config)`.
- Produces event: `{ t: 'host'; id: string; state: LinkState; latencyMs?: number; lastError?: string }`.
- `list_connections` result: each worker has `host` (`'local'` when none).
- `ADVISOR_PROMPT` gets the line: `Workers can run on other machines. The host of each worker is in list_connections.`
- UI: Add Worker gets a host segment (`#addHost`) above the agent segment, shown only when `hosts.length > 0`. The repo list reloads from `/api/repos?host=`. Each box head gets `<span class="hostb">` with the host colour (none for local). Needs You items get the same badge.

- [ ] **Step 1: Write the failing tests**

```ts
test('GET /api/hosts returns state and worker count');
test('POST /api/hosts with a password field → 400 naming password');
test('POST /api/hosts/mac/connect calls HostLink.connect');
test('list_connections shows host for each worker');
test('advisor prompt mentions other machines');
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the routes and the UI parts.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS. Start the console (`bun run src/cli.ts serve`), add the Mac, start a worker from Add Worker. Expected: the badge shows. Evidence: `visually-confirmed` or `not checked`.
- [ ] **Step 5: Commit** `feat: host api, host switch in add worker and host badges`.

## Stage 4 — Hosts UI (mockups B, D, E)

### Task 9: Hosts sidebar, host manager and profile dialog

**Files:** Create `web/hosts.ts`. Modify `web/app.ts`, `web/index.html`, `web/styles.css`. Test `tests/web-hosts.test.ts` (pure functions only).

**Interfaces:**
- Consumes: the Task 8 routes and the `host` event.
- Produces (pure, tested): `hostRows(hosts, query): HostRow[]` (search name, group, labels, server; sort by group then name); `profileFromForm(fields: Record<string,string>): Partial<Host>` (labels split by comma and trimmed; empty strings removed; port as number).
- UI (no unit tests; manual check):
  - Sidebar section `Hosts` above `Needs You` (mockup B): a card per host with dot, name, server, worker count; the expanded card lists `Check[]`; buttons Run Doctor, Open Shell, Connect or Disconnect. `+ Add Host` opens the profile dialog.
  - Toolbar button `Hosts` opens the host manager (mockup E): table Name, Group, Labels, Server, Status, Workers; search; `Import ~/.ssh/config`; double-click a row = connect.
  - Profile dialog (mockup D): Name, Group, Labels, Colour (4 swatches: `#9b51e0`, `#3b6ef5`, `#0f8f8a`, `#d08a00`); tabs Basic, Advanced, Behaviour, Notes; buttons Cancel, Test Connection, Save, Save and Connect. No password input.

- [ ] **Step 1: Write the failing tests** for `hostRows` (search hits a label; sort order) and `profileFromForm` (`'mac, worker '` → `['mac','worker']`; `port: '2222'` → `2222`; no `password` key ever).
- [ ] **Step 2: Run** `bun test tests/web-hosts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `web/hosts.ts` and wire it in `app.ts`.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Then check in the browser at 1440 px and 390 px wide: add a host by import, Test Connection, Save and Connect, see the card and the checks. Evidence: `visually-confirmed` or `not checked`.
- [ ] **Step 5: Commit** `feat: hosts sidebar, host manager and host profile dialog`.

## Stage 5 — Group by Host (mockup A)

### Task 10: Group by Host layout and lane frames

**Files:** Modify `web/app.ts`, `web/canvas.ts`, `web/index.html`, `web/styles.css`. Create `web/lanes.ts`. Test `tests/web-lanes.test.ts`.

**Interfaces:**
- Produces: `laneLayout(workers: { id; host?; role; w?; h? }[], hosts: { id; name }[]): { moves: { id; x; y }[]; lanes: { host: string; name: string; x; y; w; h }[] }`.
  - Lane order: `local` first, then hosts in config order. Hosts with no workers get no lane.
  - The advisor and the reviewer go in the `local` lane, first.
  - Inside a lane: rows of 3 boxes, box gap 60 px, lane gap 160 px, lane padding 60 px, lanes stacked top to bottom. Default box size 760 × 560 when `w`/`h` is missing.
- Toolbar button `Group by Host` (`#bGroup`): sends the moves through `/api/workers/<id>/move` (as Auto Layout does) and turns on the lane frames. Any drag or Auto Layout turns the frames off. Drag never changes a host.

- [ ] **Step 1: Write the failing tests**

```ts
test('local lane comes first and holds the advisor first');
test('two mac workers land in the mac lane, in one row, 60 px apart');
test('a host with no workers has no lane');
test('lanes do not overlap');
```

- [ ] **Step 2: Run** `bun test tests/web-lanes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Browser check: click Group by Host, see the lanes, drag a box out, and the lanes go away. Evidence level as above.
- [ ] **Step 5: Commit** `feat: group by host layout with lane frames`.

## Stage 6 — Send to Host (mockup C)

### Task 11: Send to Host backend

**Files:** Create `src/sendtohost.ts`. Modify `src/server.ts`. Test `tests/sendtohost.test.ts`.

**Interfaces:**
- Consumes: `HostLink.exec`, `writeRemoteFile`, `Registry.spawn`, `Registry.stop`, local `exec`.
- Produces:
  ```ts
  interface SendOpts { id: string; to: string; branch: boolean; patch: boolean; brief?: string; folder?: string; stopSource: boolean }
  interface SendStep { name: 'check' | 'bundle' | 'patch' | 'folder' | 'start' | 'stop'; ok: boolean; text: string }
  function sendToHost(reg: Registry, hosts: HostPool, o: SendOpts): Promise<{ steps: SendStep[]; worker?: Worker }>;
  function sendPreview(reg, hosts, id: string, to: string): Promise<{ ahead: number; dirtyFiles: number; dirtyLines: number; repoFound: boolean; checks: Check[] }>;
  ```
  Routes: `GET /api/workers/<id>/send-preview?to=` and `POST /api/workers/<id>/send`.
- Steps as spec §7.9. The bundle goes to `/tmp/ac-<id>-<rand>.bundle` on the host and is removed after the fetch. `rsync -az -e "ssh -S <sock> -o BatchMode=yes"` for the folder. The brief is the template prompt of the new worker.
- The source worker is stopped only when every earlier step is ok and `stopSource` is true.

- [ ] **Step 1: Write the failing tests**

```ts
test('check fails when the target is not up → steps [check:false], nothing else runs');
test('check fails when the repo folder is not under a target root');
test('bundle: git bundle create runs with <base>..<branch>, then git fetch on the host');
test('a failed fetch stops the move; the source is not stopped; Activity names "bundle"');
test('patch is applied with git apply on the new worktree');
test('stopSource=false keeps the source running');
test('the brief becomes the first prompt of the new worker');
test('sendPreview counts ahead commits and dirty lines');
```

- [ ] **Step 2: Run** `bun test tests/sendtohost.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: send a worker's branch, patch and brief to another host`.

### Task 12: Send to Host dialog

**Files:** Create `web/sendtohost.ts`. Modify `web/app.ts`, `web/index.html` (button `#fSend` in the focus header), `web/styles.css`.

**Interfaces:** Consumes the Task 11 routes. The dialog follows mockup C: host cards (offline ones disabled), four checkboxes (Branch, Uncommitted changes, Handover brief with a text area, Extra folder), the two "After the copy" radios, the checks from `send-preview`, buttons Cancel and `Send and Start on <host>`. The result list shows each `SendStep` with ✓ or ✗.

- [ ] **Step 1: Implement** the dialog.
- [ ] **Step 2: Run** `bun run typecheck`. Expected: 0 errors.
- [ ] **Step 3: Manual check** with the Mac: send a test branch with one commit and one dirty file. Expected: the new box appears in the Mac lane, `git log -1` there shows the commit, `git status` shows the dirty file. Evidence level as above.
- [ ] **Step 4: Commit** `feat: send to host dialog`.

## Stage 7 — Shell box (mockup E)

### Task 13: Plain SSH shell box

**Files:** Modify `src/workers.ts`, `src/server.ts`, `src/hookserver.ts`, `src/tools.ts`, `web/app.ts`, `web/styles.css`. Test `tests/workers.test.ts`, `tests/hookserver.test.ts`, `tests/mcp.test.ts`.

**Interfaces:**
- Produces: `Registry.openShell(host: string): Promise<Worker>` — `kind: 'shell'`, `role: 'worker'`, id `shell-<host>` (unique), cmd = the login shell (`$SHELL -l`, from `link.exec(['sh','-c','printf %s "$SHELL"'])`), no session files, no advisor link. Route `POST /api/hosts/<id>/shell`.
- Hooks for a shell id are ignored. `send_message` to a shell → error `shell boxes take input only from you`. `list_connections` does not list shells. The digest skips shells.
- UI: the box head shows a terminal icon and `Shell`; no port dot; host badge. "Open Shell" in the host card and the manager row calls the route.

- [ ] **Step 1: Write the failing tests**

```ts
test('openShell starts the login shell through the host tmux, with no --settings');
test('openShell does not link the shell to the advisor');
test('send_message to a shell is refused');
test('list_connections leaves shells out');
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS. Browser check: Open Shell on the Mac, run `pmset -g`. Evidence level as above.
- [ ] **Step 5: Commit** `feat: plain ssh shell box on the canvas`.

## Stage 8 — Docs and release

### Task 14: README, doctor docs and release v0.5.0

**Files:** Modify `README.md`, `package.json`, `src/mcp.ts`. Create `release-notes/v0.5.0.md` (follow the existing files in `release-notes/`).

- [ ] **Step 1: Write** a README section `Remote hosts`: what it does, the needs on the host (tmux, claude, curl; Claude login with `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` when the keychain is locked over SSH), how to add a host, the tunnel port rule, and the security notes from spec §8. Simplified Technical English.
- [ ] **Step 2: Version check:** `rg -n '"version"' package.json; rg -n "version: '" src/mcp.ts`. Expected: both `0.4.0`.
- [ ] **Step 3: Full check:** `bun test && bun run typecheck`. Expected: all pass, 0 errors.
- [ ] **Step 4: Bump** both files to `0.5.0`. Commit `chore: release v0.5.0`.
- [ ] **Step 5: Tag:** `git tag -a v0.5.0 -m "v0.5.0: remote hosts over SSH"`. Stop and tell the user when the tag exists already.
- [ ] **Step 6: Report** the branch, the old and new version, the tag and the test results. Merge and push wait for the user.
