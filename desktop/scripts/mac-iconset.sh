#!/bin/sh
# macOS only. Makes assets/icon.iconset from assets/icon-512.png with sips.
# Electrobun converts the .iconset to .icns with iconutil (mac.icons in electrobun.config.ts).
# Run it from desktop/ before "hutch run build" on a Mac.
set -eu
cd "$(dirname "$0")/.."
SRC=assets/icon-512.png
OUT=assets/icon.iconset
rm -rf "$OUT"
mkdir -p "$OUT"
for s in 16 32 128 256 512; do
	sips -z "$s" "$s" "$SRC" --out "$OUT/icon_${s}x${s}.png" >/dev/null
	d=$((s * 2))
	sips -z "$d" "$d" "$SRC" --out "$OUT/icon_${s}x${s}@2x.png" >/dev/null
done
ls "$OUT"
