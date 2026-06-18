#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${GODOT_BIN:-}" && -x "$HOME/.local/bin/godot-4.6.1" ]]; then
  GODOT_BIN="$HOME/.local/bin/godot-4.6.1"
else
  GODOT_BIN="${GODOT_BIN:-/snap/bin/godot-4}"
fi
PRESET="${RUNEFALL_ANDROID_PRESET:-Android Debug}"
OUT_DIR="$ROOT_DIR/builds"
OUT_APK="$OUT_DIR/runefall-debug.apk"

mkdir -p "$OUT_DIR"

echo "[runefall] Godot: $("$GODOT_BIN" --version | head -n 1)"
echo "[runefall] Preset: $PRESET"

"$GODOT_BIN" --headless --path "$ROOT_DIR" --quit >/tmp/runefall-android-import.log 2>&1

set +e
"$GODOT_BIN" --headless --path "$ROOT_DIR" --export-debug "$PRESET" "$OUT_APK" \
  >"$OUT_DIR/android-export.log" 2>&1
status=$?
set -e

if [[ $status -ne 0 || ! -s "$OUT_APK" ]]; then
  echo "[runefall] Android export failed. See builds/android-export.log"
  tail -n 80 "$OUT_DIR/android-export.log" || true
  exit 1
fi

bytes="$(stat -c '%s' "$OUT_APK")"
echo "[runefall] APK created: $OUT_APK ($bytes bytes)"
