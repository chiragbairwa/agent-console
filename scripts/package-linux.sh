#!/usr/bin/env bash
# Makes the Linux packages: a .deb and an AppImage.
# Each package holds the agent-console CLI and the desktop app.
#
# Usage: scripts/package-linux.sh <version> <cli-binary> <app-bundle.tar.zst> <out-dir>
# Set APPIMAGETOOL to the path of appimagetool. Without it, the script makes only the .deb.
set -euo pipefail

VERSION="$1"; CLI="$2"; BUNDLE="$3"; OUT="$4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICON="$ROOT/desktop/assets/icon-512.png"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# The Electrobun bundle unpacks to AgentConsole/.
tar --zstd -xf "$BUNDLE" -C "$WORK"
APP="$WORK/AgentConsole"
[ -x "$APP/bin/launcher" ] || { echo "no AgentConsole/bin/launcher in $BUNDLE" >&2; exit 1; }

desktop_entry() { # $1 = Exec value
	cat <<EOF
[Desktop Entry]
Type=Application
Name=Agent Console
Comment=Canvas for Claude Code and Codex terminals
Exec=$1
Icon=agent-console
Terminal=false
StartupWMClass=AgentConsole
Categories=Development;Utility;
EOF
}

# ---------- .deb ----------
DEB="$WORK/deb"
mkdir -p "$DEB/DEBIAN" "$DEB/usr/bin" "$DEB/opt/agent-console" \
	"$DEB/usr/share/applications" "$DEB/usr/share/icons/hicolor/512x512/apps"
install -m 755 "$CLI" "$DEB/usr/bin/agent-console"
cp -a "$APP" "$DEB/opt/agent-console/"
cat > "$DEB/usr/bin/agent-console-desktop" <<'EOF'
#!/bin/sh
exec /opt/agent-console/AgentConsole/bin/launcher "$@"
EOF
chmod 755 "$DEB/usr/bin/agent-console-desktop"
desktop_entry /usr/bin/agent-console-desktop > "$DEB/usr/share/applications/agent-console.desktop"
install -m 644 "$ICON" "$DEB/usr/share/icons/hicolor/512x512/apps/agent-console.png"
cat > "$DEB/DEBIAN/control" <<EOF
Package: agent-console
Version: $VERSION
Section: devel
Priority: optional
Architecture: amd64
Depends: tmux, libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0, libayatana-appindicator3-1
Installed-Size: $(du -sk "$DEB" | cut -f1)
Maintainer: Chirag Bairwa <chirag.dev18@gmail.com>
Homepage: https://github.com/chiragbairwa/agent-console
Description: Canvas for Claude Code and Codex terminals
 Agent Console shows each Claude Code or Codex session as a live terminal
 box on a canvas. The sessions run in tmux. The package holds the
 agent-console command and the desktop app.
EOF
chmod -R u+rwX,go+rX,go-w "$DEB" # no group- or world-writable files under /usr or /opt
dpkg-deb --root-owner-group --build "$DEB" "$OUT/agent-console_${VERSION}_amd64.deb"

# ---------- AppImage ----------
if [ -z "${APPIMAGETOOL:-}" ]; then echo "APPIMAGETOOL is not set: no AppImage"; exit 0; fi
AD="$WORK/AppDir"
mkdir -p "$AD/usr/bin"
install -m 755 "$CLI" "$AD/usr/bin/agent-console"
cp -a "$APP" "$AD/"
desktop_entry AppRun > "$AD/agent-console.desktop"
install -m 644 "$ICON" "$AD/agent-console.png"
cat > "$AD/AppRun" <<EOF
#!/bin/sh
HERE="\$(dirname "\$(readlink -f "\$0")")"
# The AppImage mount goes away when the app quits, but the console server keeps running.
# So the server must not run from the mount: copy the CLI to the cache folder one time.
if [ -z "\${AGENT_CONSOLE_BIN:-}" ] && ! command -v agent-console >/dev/null 2>&1 && [ ! -x "\$HOME/.local/bin/agent-console" ]; then
	c="\${XDG_CACHE_HOME:-\$HOME/.cache}/agent-console/agent-console-$VERSION"
	if [ ! -x "\$c" ]; then
		mkdir -p "\$(dirname "\$c")" && cp "\$HERE/usr/bin/agent-console" "\$c.tmp" && chmod 755 "\$c.tmp" && mv "\$c.tmp" "\$c"
	fi
	export AGENT_CONSOLE_BIN="\$c"
fi
exec "\$HERE/AgentConsole/bin/launcher" "\$@"
EOF
chmod 755 "$AD/AppRun"
chmod -R u+rwX,go+rX,go-w "$AD"
ARCH=x86_64 "$APPIMAGETOOL" --no-appstream "$AD" "$OUT/AgentConsole-${VERSION}-x86_64.AppImage"
