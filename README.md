# Agent Console

A local web canvas for Claude Code. Each box is a live terminal with `claude` running in tmux. One **advisor** session is the single point of contact. It sends work to the **worker** sessions, watches them, and decides which ones may talk to each other.

- One executable file: `agent-console`. It is built with Bun.
- The work continues when you close the browser or stop the server. The sessions live in tmux.
- Push, deploy and gate-approval commands wait for your **Allow** or **Deny** in the browser.

## Install

```bash
sudo apt install tmux        # the only other program you need (Claude Code must be installed)
bun install
bun run install-bin          # builds dist/agent-console and copies it to ~/.local/bin
agent-console doctor         # checks tmux, claude, the config folder and the port
```

## Install on macOS

> **Note:** Agent Console is not tested on macOS yet. If a step fails, send the output of `agent-console doctor` to the team.

1. Install tmux and git with Homebrew:

   ```bash
   brew install tmux git
   ```

2. Install Bun. Then open a new terminal.

   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

3. Install Claude Code and log in. Codex is optional. You need it only for Codex workers.
4. Clone the repository from the bundle file. Replace `<bundle-file>` with the path to the file that you received.

   ```bash
   git clone <bundle-file> agent-console
   cd agent-console
   bun install
   ```

5. Build the executable file and copy it to `~/.local/bin`:

   ```bash
   mkdir -p ~/.local/bin && bun run install-bin
   ```

6. Make sure that `~/.local/bin` is on your `PATH`. The default macOS shell is zsh, so add this line to `~/.zprofile`. Then open a new terminal.

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   ```

7. Check the setup:

   ```bash
   agent-console doctor
   ```

8. Start the console:

   ```bash
   agent-console
   ```

9. Set `roots` and `advisorCwd` in `~/.config/agent-console/config.json`. Use the folders that hold your repositories. See [Config](#config).

   ```json
   {
     "roots": ["/Users/you/code"],
     "advisorCwd": "/Users/you/code"
   }
   ```

10. Add the console to your apps. `agent-console install-launcher` is for Linux only. On macOS, open the console in Chrome and use the Chrome menu: **Install Agent Console**.

**Desktop app (optional):** build it on the Mac. Hutch must be installed (`npx electrobun` downloads it one time).

```bash
cd desktop && hutch install && hutch run build
```

The build writes the app to `desktop/artifacts/`.

**Known gap (macOS app icon):** `desktop/electrobun.config.ts` has no macOS icon. For macOS, Electrobun does not accept a PNG `icon`. It accepts `mac.icons`: the path to an `.iconset` folder or an `.icon` file. Electrobun converts an `.iconset` with `iconutil` on the Mac. Until an `.iconset` is added, the macOS app has no custom icon.

## Use

```bash
agent-console                # starts the server and opens http://127.0.0.1:7878/?token=…
agent-console --no-open      # start the server, but do not open the browser
agent-console open           # open the desktop app (or --browser for a browser window); starts the console first
agent-console install-launcher   # Linux: add "Agent Console" to the app menu
```

- **Command bar:**
  - Plain text goes to the advisor.
  - `@name text` goes straight to one worker.
  - Shift+click title bars to select several sessions; the text then goes to each one.
- **Focus mode:**
  - Open a terminal full size: double-click a title bar, click ⤢, or press `1`–`9`.
  - Leave focus mode: **Shift+Esc** or **Back to Map**. Plain Esc goes to Claude.
- **Box size:**
  - Drag the grip in the bottom-right corner of a box to resize it. The console saves the size.
  - Double-click the grip to go back to the default size.
  - Limit: when two browser tabs show the same box, the last tab that fits the terminal sets the terminal size. This also applies when one tab shows the box in focus mode.
- **Connections:**
  - Make one: drag the purple ● port onto another box.
  - Cut one: click its line. The advisor cannot re-make a connection that you cut.
- **Needs You:**
  - Guarded commands: Allow or Deny.
  - Advisor questions: type an answer.
  - Permission prompts: click Open and answer in the terminal.
- **Terminals or Flow:**
  - The top bar switch **Terminals | Flow** changes all boxes. Terminals is the default.
  - The **⇄** button on a box changes only that box. The browser keeps your choice.
  - In Flow, a box shows the agent's checklist as steps: done ✓, running, and next. The time of each step shows on the right.
  - The advisor box and the strip above the canvas show the KPIs: agents running, steps done, needs you, longest step, and finished.
  - Hover a step to see its tool calls (✓ done, ▶ running) and its result. Hover a KPI to see the current step of each agent.
  - The steps come from the hooks:
    - A Markdown checklist in the agent's replies (`- [ ] 1. …`, `1. [x] …`, `[~]`). The console reads the transcript.
    - `TodoWrite` and `TaskCreate`/`TaskUpdate`, when the session has these tools.
    - With no checklist: one step for each prompt.
- **Add Worker, any folder:**
  - **Browse Folders…** opens a folder chooser. It starts on your Desktop, with shortcuts to Desktop, Home and your roots. ⎇ marks a Git repository.
  - Type a **New worktree branch** to work in a Git worktree. **From branch** then lists the local and remote branches; the current branch is the default.
- **Add Worker:** pick a repository under your roots. You can give a new worktree branch and a template.
- **Without the browser:** `tmux -L agent-console attach -t ac-<id>` (detach with `Ctrl-b d`).

## Codex workers

- **Start one:** in Add Worker, set **Agent** to Codex. You can set a model and a reasoning level. The API takes `POST /api/workers` with `agent: "codex"` and `options`.
- **Bypass mode:** a Codex box always runs with no sandbox and no Codex approval prompts. The console guard is the only gate for guarded commands, such as `git push`.
- **Fail-closed guard:** when the console is down or does not answer, the hook denies the tool call. No tool runs until the console is back. The console does not use `ask` for Codex (not verified). A timeout gives `deny`.
- **Trust dialog:** the console marks the folder of the box as trusted for this start. Codex does not ask "Trust this folder?".
- **No Flow plan steps:** a Codex box shows no checklist steps in Flow. Terminals shows the box as usual.
- **Resume:** Restart with resume keeps the same Codex conversation.

## Desktop app (optional)

`desktop/` holds an Electrobun app that shows the console in a native window (WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows). It does not contain the console: it starts the installed `agent-console` server when it is not running, then opens the page.

- **Build and install (Linux):** install Hutch (`npx electrobun` downloads it once), then `cd desktop && hutch install && hutch run build`. Extract `artifacts/linux-x64-AgentConsole-Setup.tar.gz` and run `./installer`. It installs into `~/.local/share/dev.agentconsole.desktop/` and adds an app-menu entry and a Desktop icon.
- **Tray:** Open Agent Console, Open in Browser, Retry, Quit. Closing the window keeps the tray icon. Quit ends the app; the console server and the sessions keep running.
- **One copy:** a second start brings the window to the front, through `~/.config/agent-console/desktop.sock`.
- **Window:** size and position are saved in `~/.config/agent-console/desktop-window.json`.
- **Memory:** about 290 MB, measured on 20 Nov 2026. The app window (`agent-console open`) inside a Chrome that already runs needs about 100 MB, so it is the lighter choice when Chrome is open anyway.

## Advisor agent

- **Switch:** click `Advisor: <agent> ▾` in the top bar. Pick an agent, then click again to confirm. The API call is `POST /api/advisor {"agent":"codex"}`.
- **Conversations:** each agent keeps its own conversation. The console saves the session id when you leave. It resumes that session when you switch back.
- **First agent:** the `advisorAgent` key in `config.json` selects the agent at first start.
- **Codex advisor:** it runs without a sandbox. The guard still applies to it.
- **Rules:** the Codex advisor gets the advisor rules through `developer_instructions`.

## Config

`~/.config/agent-console/config.json` (all keys are optional):

```json
{
  "roots": ["/home/you/code"],
  "port": 7878,
  "advisorCwd": "/home/you/code",
  "guardPatterns": ["\\bnpm publish\\b"],
  "templates": [{ "name": "qa", "prompt": "Run the QA checklist", "permissionMode": "plan" }],
  "hookTimeoutSec": 590,
  "advisorDigestMin": 5
}
```

- **Status check:** every `advisorDigestMin` minutes (default 5, `0` = off) the console sends the advisor one line for each worker: state, current step, time in the step, and what it waits on. When nothing changed, the console sends nothing, so a quiet fleet costs no tokens.
- **Defaults:** `roots` and `advisorCwd` are your Desktop, so a teammate needs no config. The console finds the Desktop on each system:
  - Windows: the OneDrive Desktop when it exists, else `%USERPROFILE%\Desktop`.
  - macOS: `~/Desktop`.
  - Linux: `XDG_DESKTOP_DIR` from `~/.config/user-dirs.dirs`, else `~/Desktop`.
  - No Desktop: the home folder.
- **Windows:** the sessions run in tmux, and tmux is not a native Windows program. Run the console in WSL.
- **Token:** `~/.config/agent-console/token` (mode 0600). `agent-console rotate-token` makes a new one. Restart the server and the sessions after you rotate it.
- **State:** `~/.config/agent-console/state.json` holds the boxes, the positions, the connections and the activity.
- **Per-session files:** `~/.config/agent-console/sessions/<id>/`. They hold the hooks and the MCP config, and they are passed with `--settings` and `--mcp-config`. Your global `~/.claude/settings.json` is never changed. The global hooks, env and MCP servers still apply (tested).
- **Which window opens:** when the desktop app is installed, `agent-console` and `agent-console open` open it, and never a browser. Without it, or with `open --browser`, the browser app window opens.
- **App window:** the console opens in its own window (`--app`) of Chrome, Edge, Chromium or Brave, with no tabs and no address bar. When that browser already runs, the window shares its processes, so it costs about the same memory as a tab. With no Chromium browser, it opens a normal tab. WSL uses Edge on the Windows side. On macOS and Windows you can also use the browser menu: Install Agent Console.
- **HTTP hooks:** Claude Code posts each hook event to `http://127.0.0.1:<port>/hook/<Event>`. No process starts for a hook. Two small `curl` commands remain:
  - `SessionStart`, because Claude Code skips HTTP hooks on that event.
  - A Bash fail-safe. When the console does not answer, every Bash command asks in the terminal, so a guarded command cannot slip through. This is stricter than before: earlier only guarded commands asked.
  - Sessions started before this change keep the old `agent-console hook` commands until you restart them.
- **MCP over HTTP:** each session reaches the console tools at `http://127.0.0.1:<port>/mcp` with its token and id in headers. No helper process runs for each session. A session started before this change keeps its old `agent-console mcp` helper until you restart it (⋯ → Restart (Resume)).
- **OTel:** every session adds `agent.role`, `agent.name` and `agent.repo` to your existing `OTEL_RESOURCE_ATTRIBUTES`.

## Known limits (version 1)

- **The guard is light.** It is a regex on the Bash command text: `git push`, `az pipelines … run`, gate approvals and `terraform apply`. A push through an alias, a script or `sh -c` is not caught. Claude Code's own permission prompt is then the only check.
- **Not a sandbox.** All sessions run as your own user. A worker (or a script it runs) can read the token file, call the console API, or use `tmux -L agent-console send-keys` directly. The role checks and the guard stop mistakes, not a hostile process. Do not run untrusted code in a worker.
- **Typing in a direct attach is not seen.** Typing in `tmux -L agent-console attach` does not hold back queued messages. Only typing in the browser does.
- **Queued messages are kept in memory only.** A server restart drops them.
- **Messages are one line.** Line breaks and control characters in advisor and worker messages become spaces or are removed.
- Linux only.

## Develop

```bash
bun test                     # 100+ tests; the e2e test runs only when dist/agent-console exists
bunx tsc --noEmit
bun src/cli.ts serve         # run from source
```

