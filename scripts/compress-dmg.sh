#!/usr/bin/env bash
# Recompress a built .dmg with ULMO (LZMA) — typically 25-30 MB smaller than
# the zlib (UDZO) image the Tauri bundler produces. The file is replaced
# atomically under its ORIGINAL name, so release-asset names and links are
# unchanged. macOS only (hdiutil). ULMO images mount on macOS 10.15+, which
# every supported install satisfies (Atlas ships Apple-silicon-only).
#
# Usage: scripts/compress-dmg.sh <path/to/Atlas_X.Y.Z_aarch64.dmg>
#
# IMPORTANT: only ever run this on the human-download .dmg. The updater
# artifacts (.app.tar.gz + .sig) must never be rewritten — minisign signed
# those exact bytes, and any change breaks update verification.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <path-to.dmg>" >&2
  exit 2
fi

dmg="$1"

if [ ! -f "$dmg" ]; then
  echo "error: no such file: $dmg" >&2
  exit 1
fi
case "$dmg" in
  *.dmg) ;;
  *)
    echo "error: not a .dmg: $dmg" >&2
    exit 1
    ;;
esac

# Convert to a sibling temp path (same filesystem → mv is atomic), then swap.
tmp="${dmg%.dmg}.ulmo-tmp.dmg"
trap 'rm -f "$tmp"' EXIT

before=$(stat -f%z "$dmg")

# `set -e` makes any hdiutil failure abort here, leaving the original .dmg
# untouched; the trap removes the partial temp file.
if ! hdiutil convert "$dmg" -format ULMO -o "$tmp" -ov; then
  echo "error: hdiutil convert failed for $dmg — original left untouched" >&2
  exit 1
fi

after=$(stat -f%z "$tmp")
mv -f "$tmp" "$dmg"
trap - EXIT

echo "Recompressed $(basename "$dmg"): ${before} -> ${after} bytes ($(( (before - after) / 1024 / 1024 )) MB saved)"
