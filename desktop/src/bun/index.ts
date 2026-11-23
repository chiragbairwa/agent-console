import { BrowserWindow, Tray, Utils } from "electrobun/main";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Agent Console desktop app. It does not contain the console: it makes sure the installed
 * `agent-console` server runs, then shows its page in a native window. The server and the
 * tmux sessions keep running when the app quits, the same as when you close a browser tab.
 */

const CONFIG_DIR = process.env.AC_CONFIG_DIR || join(homedir(), ".config", "agent-console");
mkdirSync(CONFIG_DIR, { recursive: true });
const FRAME_FILE = join(CONFIG_DIR, "desktop-window.json");
const DEFAULT_FRAME = { x: 80, y: 60, width: 1400, height: 900 };

// ---------- one copy only: a second start brings the first window to the front ----------
// A Unix socket, not a signal: catching a signal crashes Bun inside Electrobun (seen with SIGUSR1).
const SOCK = join(CONFIG_DIR, "desktop.sock");
async function handOff(): Promise<boolean> {
	try {
		await new Promise<void>((resolve, reject) => {
			Bun.connect({
				unix: SOCK,
				socket: {
					open(sock) { sock.write("open\n"); sock.end(); resolve(); },
					data() {},
					error(_s, e) { reject(e); },
					connectError(_s, e) { reject(e); },
				},
			}).catch(reject);
		});
		return true;
	} catch {
		return false; // nobody listens: this is the first copy
	}
}
if (process.platform !== "win32" && (await handOff())) {
	await Bun.sleep(150); // let the message leave before exit
	process.exit(0);
}

// ---------- the console server ----------
function consoleBin(): string | null {
	const found = [process.env.AGENT_CONSOLE_BIN, Bun.which("agent-console"), join(homedir(), ".local", "bin", "agent-console")]
		.find((p): p is string => !!p && existsSync(p));
	return found ?? null;
}
function port(): number {
	try { return Number(JSON.parse(readFileSync(join(CONFIG_DIR, "config.json"), "utf8")).port) || 7878; } catch { return 7878; }
}
const base = () => `http://127.0.0.1:${port()}`;
const token = () => { try { return readFileSync(join(CONFIG_DIR, "token"), "utf8").trim(); } catch { return ""; } };

async function up(): Promise<boolean> {
	try {
		const r = await fetch(`${base()}/api/health`, { headers: { "x-ac-token": token() }, signal: AbortSignal.timeout(1000) });
		return r.ok;
	} catch {
		return false;
	}
}

/** Start the server in its own session when it is not running. Returns an error text, or null. */
async function ensureConsole(): Promise<string | null> {
	if (await up()) return null;
	const bin = consoleBin();
	if (!bin) return "The agent-console command was not found. Install it with: bun run install-bin";
	const detach = Bun.which("setsid") ? ["setsid"] : Bun.which("nohup") ? ["nohup"] : [];
	const log = openSync(join(CONFIG_DIR, "serve.log"), "a");
	Bun.spawn([...detach, bin, "serve", "--no-open"], { stdin: "ignore", stdout: log, stderr: log }).unref();
	for (let i = 0; i < 60; i++) {
		await Bun.sleep(250);
		if (await up()) return null;
	}
	return `The console did not start. See ${join(CONFIG_DIR, "serve.log")}.`;
}

// ---------- the window ----------
function savedFrame() {
	try {
		const f = JSON.parse(readFileSync(FRAME_FILE, "utf8"));
		if ([f.x, f.y, f.width, f.height].every(n => Number.isFinite(n)) && f.width >= 400 && f.height >= 300) return f;
	} catch { /* first start */ }
	return DEFAULT_FRAME;
}

let win: BrowserWindow | null = null;
let lastSaved = "";
function saveFrame() {
	if (!win) return;
	try {
		const j = JSON.stringify(win.getFrame());
		if (j !== lastSaved) { lastSaved = j; writeFileSync(FRAME_FILE, j); }
	} catch { /* the window is closing */ }
}
setInterval(saveFrame, 3000);

const errorPage = (text: string) =>
	"data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><title>Agent Console</title>
<body style="font:15px system-ui;padding:40px;color:#1d2330;background:#eef0f4">
<h2>Agent Console could not start</h2><p>${text.replace(/[<&]/g, c => (c === "<" ? "&lt;" : "&amp;"))}</p>
<p>Fix it, then use <b>Retry</b> in the tray menu.</p></body>`);

async function openWindow() {
	if (win) {
		try { win.activate(); } catch (e) { console.error(`activate failed: ${(e as Error).message}`); }
		return;
	}
	const err = await ensureConsole();
	win = new BrowserWindow({
		title: "Agent Console",
		url: err ? errorPage(err) : `${base()}/?token=${token()}`,
		frame: savedFrame(),
	});
	win.on("close", () => { saveFrame(); win = null; });
}

// ---------- tray ----------
const tray = new Tray({ title: "Agent Console", image: "views://assets/icon-32.png", width: 22, height: 22 });
tray.setMenu([
	{ type: "normal", label: "Open Agent Console", action: "open" },
	{ type: "normal", label: "Open in Browser", action: "browser" },
	{ type: "normal", label: "Retry", action: "retry" },
	{ type: "divider" },
	{ type: "normal", label: "Quit (Sessions Keep Running)", action: "quit" },
]);
tray.on("tray-clicked", async (event: any) => {
	switch (event.data?.action) {
		case "open": return openWindow();
		case "browser": return Utils.openExternal(`${base()}/?token=${token()}`);
		case "retry": win?.close(); win = null; return openWindow();
		case "quit":
			saveFrame();
			tray.remove();
			process.exit(0);
	}
});

if (process.platform !== "win32") {
	try { unlinkSync(SOCK); } catch { /* no old socket */ }
	Bun.listen({
		unix: SOCK,
		socket: { data(_sock, d) { if (String(d).includes("open")) setTimeout(() => void openWindow(), 0); } },
	});
}

await openWindow();
