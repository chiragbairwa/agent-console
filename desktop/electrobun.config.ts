import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Agent Console",
		identifier: "dev.agentconsole.desktop",
		version: "0.1.0",
	},
	// Closing the window keeps the tray icon; Quit in the tray ends the app.
	runtime: { exitOnLastWindowClosed: false },
	build: {
		mainProcess: "bun",
		bun: { entrypoint: "src/bun/index.ts" },
		copy: {
			"assets/icon-32.png": "views/assets/icon-32.png",
			"assets/icon-256.png": "views/assets/icon-256.png",
		},
		// The system webview: WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows. No Chromium bundled.
		linux: { bundleCEF: false, icon: "assets/icon-512.png" },
		mac: { bundleCEF: false },
		win: { bundleCEF: false, icon: "assets/icon-256.png" },
	},
} satisfies ElectrobunConfig;
