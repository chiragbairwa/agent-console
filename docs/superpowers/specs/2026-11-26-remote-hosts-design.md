# Remote Hosts — Design

Date: 2026-11-26 · Branch: `feat/remote-hosts` · Target version: `0.5.0` (MINOR)
Mockups: https://claude.ai/artifact/JvnGQw7a28WLoiyNNcmJxz (artboards A to E)

## 1. Intent

On 2026-11-25 the user made a Mac mini a second dev machine and a remote Claude worker. All remote steps were manual: SSH, a tmux session started from a GUI file, a handover pack sent with scp, and Remote Control to watch the worker. The laptop console did not show the Mac worker. The advisor could not send messages to it.

This feature lets one Agent Console on the laptop run and watch Claude workers on other machines over SSH. The remote workers look and behave like local workers.

## 2. Goals

- G1. Keep SSH host profiles in the console, in the style of the Remmina connection profiles (mockup D, E).
- G2. Start, watch, type into, interrupt and stop a Claude worker on a remote host.
- G3. Keep hooks, status, steps, the guard (Allow / Deny) and MCP working for remote workers.
- G4. Show host health in the sidebar: SSH, tunnel, tmux, claude, Claude login, sleep (mockup B).
- G5. Group the canvas by host on request (mockup A). This is a layout action only.
- G6. Move a worker's work to another host: branch bundle, patch, brief, extra folder (mockup C).
- G7. Open a plain SSH shell box on the canvas (mockup E).

## 3. Non-goals

- No GUI or VNC connection.
- No second console on the remote host (approach 2 below).
- No import of outside sessions (`linked` kind) from a remote host.
- No Windows remote hosts. Remote hosts are macOS or Linux.
- No sync of the WorkBrain vault.

## 4. Anti-goals (a failure even when it works)

- The console stores a password or a private key. It must not.
- A remote push or deploy runs without Allow in the laptop browser.
- The web server listens on a LAN address.
- A drag on the canvas starts a move to another machine.
- A dropped SSH connection stops or kills the remote workers.

## 5. Approaches

| # | Approach | Result |
|---|---|---|
| 1 | The laptop console runs `ssh <host> tmux …` for each tmux call. One shared SSH connection (`ControlMaster`). A reverse tunnel brings hooks and MCP back to the laptop. | **Picked.** The remote host needs only tmux, claude and curl. One state, one guard list. It fits the `Tmux` class. |
| 2 | A full console on each machine. The laptop console reads the remote console API. | Not picked. Two states and two guard lists to merge. About 3 times the work. |
| 3 | A local box that runs `ssh host` and then `claude`. | Not picked. No status, hooks, guard or handover. |

The user picked all three UIs (A, B, C) plus the Remmina-style profiles (D, E). The user asked for a full plan. Claude made these calls (the user can change them):

- Approach 1.
- The shell box (G7) is in scope, as a last stage.
- No password field. Login uses ssh-agent or a key file.

## 6. How it works today (facts from the code)

- `src/tmux.ts` `Tmux.run` spawns `tmux -L <socket> …` locally. `attachArgs` gives the local attach command for `PtyHub`.
- `src/workers.ts` calls `tmux.newSession`, `kill`, `list`, `sendText`, `sendKey`. `src/tools.ts` calls `tmux.capture`.
- `spawn` runs `git worktree add` locally through `exec`.
- `src/agents/claude.ts` `sessionFiles` writes `settings.json` and `mcp.json` into `~/.config/agent-console/sessions/<id>/`. Hooks are HTTP hooks to `AC_URL` (`http://127.0.0.1:<port>`). Two command hooks use `curl`. MCP is HTTP to `AC_URL/mcp`.
- `src/server.ts` `hostOk` accepts only `127.0.0.1:<port>` and `localhost:<port>` as the Host header.
- `GET /api/repos`, `/api/dirs`, `/api/branches` read the local disk.

The key fact: a remote Claude needs no console binary. It needs only the two JSON files and a path to `AC_URL`.

## 7. Design

### 7.1 Host profiles (config)

`Config.hosts?: Host[]` in `config.json`:

```ts
interface Host {
  id: string;            // slug, unique, never 'local'
  name: string;          // "Mac mini"
  group?: string; labels?: string[]; color?: string;  // lane and badge colour
  ssh: string;           // an ~/.ssh/config alias, or user@server
  port?: number;         // default 22
  identityFile?: string; // optional key file path; no password
  jump?: string;         // optional ProxyJump
  roots: string[];       // repo folders on the host
  tunnelPort?: number;   // remote port of the reverse tunnel; default = console port
  autoConnect?: boolean; reconnect?: boolean; warnSleep?: boolean;
  notes?: string;
}
```

Import: parse `~/.ssh/config` `Host` blocks (`HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`). Skip wildcard hosts.

### 7.2 The SSH layer (`src/ssh.ts`)

- One control socket per host: `~/.config/agent-console/ssh/<id>.sock`, mode 0700 folder.
- Master: `ssh -M -N -o ControlPersist=yes -o ServerAliveInterval=15 -o BatchMode=yes -o ExitOnForwardFailure=yes -R 127.0.0.1:<tunnelPort>:127.0.0.1:<port> <target>`.
- Every other call: `ssh -S <sock> -o BatchMode=yes <target> -- <cmd>`, with each argument shell-quoted.
- `BatchMode=yes`: SSH never asks for a password. A host that needs one fails with a clear error.
- A `HostLink` object per host holds the state: `down | connecting | up | error`, the last latency and the last error. It emits events. With `reconnect`, a backoff loop (2 s, 5 s, 15 s, 30 s) starts the master again.

### 7.3 Remote tmux

- `Tmux` gets an optional `runner` (`(args, stdin?) => Promise<{out, err, code}>`). Local = `Bun.spawn(['tmux', …])`. Remote = `ssh … tmux -L <socket> …`.
- `attachArgs` for a remote host: `['ssh', '-S', sock, '-t', target, 'tmux', '-L', socket, 'attach', '-t', name]`.
- A `TmuxPool` maps a host id to its `Tmux`. `'local'` (or no host) = today's object.
- `Worker.host?: string`. No value = local. All call sites use `pool.of(w.host)`.

### 7.4 Session files on the remote host

- `sessionFiles` stays as it is and writes the local copy.
- For a remote worker, the registry copies the two files to `~/.config/agent-console/sessions/<id>/` on the host (`ssh … 'umask 077; mkdir -p … && cat > …'`), then passes the remote paths to `claude`.
- `AC_URL` for a remote worker = `http://127.0.0.1:<tunnelPort>`.
- `hostOk` also accepts `127.0.0.1:<tunnelPort>` for each host with a different tunnel port. The token check does not change.

### 7.5 Remote repos, dirs, branches, worktrees

- `GET /api/repos?host=<id>`, `/api/dirs?host=`, `/api/branches?host=` run small `ssh` commands (`git -C`, `ls -1p`) on the host.
- `spawn` with a host runs `git worktree add` through `ssh`.

### 7.6 Discover and status

- `discover()` lists sessions on each `up` host. A remote worker on a `down` host gets status `stopped`, task `Host offline`. Its record stays.
- When the host comes back, `discover` for that host runs again. Live sessions get `idle`.

### 7.7 Doctor and health (mockup B, D "Test Connection")

`checkHost(host)` returns a list of `{ id, ok, warn, text }`:
SSH login and latency, `uname`, tmux version, claude version, Claude login over SSH (`claude auth status` or a token check), tunnel (a `curl` to `AC_URL/api/health` from the host), sleep (`pmset -g` on macOS), repo roots exist. `agent-console doctor --host <id>` prints the same list.

### 7.8 UI

- **Hosts sidebar section (B):** one card per host: dot, name, server, worker count, the checks, and Run Doctor, Open Shell, Connect / Disconnect.
- **Host manager (E):** a dialog with a table (Name, Group, Labels, Server, Status, Workers), search, Import `~/.ssh/config`, + Add Host.
- **Host profile dialog (D):** Name, Group, Labels, Colour; tabs Basic (Server, Port, Username, Login, Repo folders), Advanced (Jump host, tmux socket, Tunnel port), Behaviour (Connect at start, Reconnect, Warn on sleep), Notes. Buttons: Cancel, Test Connection, Save, Save and Connect.
- **Add Worker:** a Host switch. The repo list comes from the selected host.
- **Boxes:** a host badge in the host colour. Needs You items show the badge.
- **Group by Host (A):** a toolbar button. It moves the boxes into one lane per host, in the same way as Auto Layout. Boxes stay free to drag. The canvas draws a light lane frame behind the boxes of each host while grouping is on.
- **Send to Host (C):** a button in the focus header and a dialog (7.9).
- **Shell box (E):** "Open Shell" makes a box of kind `shell`. It has no hooks, no guard and no advisor link.

### 7.9 Send to Host

1. Check the target host is `up` and has the repo (same folder name under a root).
2. `git bundle create` of the branch (the commits that the target does not have), sent with `ssh … 'cat > /tmp/…'`, then `git fetch` of the bundle on the target.
3. Optional patch of uncommitted changes (`git diff --binary HEAD`), applied with `git apply` on the target worktree.
4. Optional brief: the console asks the source worker for a handover note (a message through the MCP tool flow), or the user types it. The brief is the first prompt of the new worker.
5. Optional extra folder: `rsync -az -e "ssh -S <sock>"`.
6. Start the new worker on the target with a worktree of that branch.
7. "Stop this one" (default) or "Keep this one".

Every step reports in Activity. A failed step stops the move and leaves the source worker as it was.

### 7.10 MCP and the advisor

- `list_connections` shows the host of each worker.
- `send_message` works for remote workers without change (it uses `sendText` through the pool).
- The advisor prompt gets one line: workers can run on other hosts. The host name is in the worker list.

## 8. Security

- No password or key stored. Only paths and aliases.
- The web server stays on 127.0.0.1. The reverse tunnel binds to 127.0.0.1 on the remote host.
- Hooks and MCP keep the token check. The token travels inside the SSH tunnel and in files of mode 0600 on the host.
- Arguments to remote commands are shell-quoted by one helper with tests. A repo path or branch name from the UI cannot inject a command.
- A branch name with a leading `-` stays refused (today's rule).

## 9. Edge cases

- The tunnel port is in use on the remote host (for example, a console runs there too). `ExitOnForwardFailure` fails the connect. The error names the port and the profile field.
- The SSH master dies. Remote workers keep running in tmux. The boxes show `Host offline`. The reconnect loop starts.
- The laptop sleeps. Same as above. Remote Claude hooks fail fast. The Bash fail-safe asks in the terminal.
- Claude is not logged in over SSH (macOS keychain). Doctor shows a warning with the fix: `CLAUDE_CODE_OAUTH_TOKEN` in the host shell profile.
- Two hosts with the same worker id. Worker ids stay globally unique (today's `uniqueId`).

## 10. Stages

1. SSH layer and host profiles (config, `ssh.ts`, `HostLink`, import, doctor). API only.
2. Remote tmux and remote workers (pool, session files, tunnel, hostOk, discover, attach).
3. Remote repos and worktrees; Add Worker host switch; box badges.
4. Hosts sidebar (B), host manager (E) and profile dialog (D).
5. Group by Host (A).
6. Send to Host (C).
7. Shell box (E).
8. Release `v0.5.0`.

## 11. Left to the builder

- The exact lane frame drawing in `canvas.ts`.
- The exact backoff numbers.
- How the brief is asked from the source worker (a fixed prompt is enough).
