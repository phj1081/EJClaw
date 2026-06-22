#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${GODOT_BIN:-}" ]]; then
  if [[ -x "$HOME/.local/bin/godot-4.6.3" ]]; then
    GODOT_BIN="$HOME/.local/bin/godot-4.6.3"
  else
    GODOT_BIN="/snap/bin/godot-4"
  fi
fi
OUT_DIR="${RUNEFALL_CAPTURE_DIR:-/tmp/runefall-visual-captures}"

if [[ -z "${DISPLAY:-}" ]]; then
  echo "[runefall] DISPLAY is required for headed visual capture." >&2
  exit 2
fi

rm -rf "$OUT_DIR"
echo "[runefall] Godot: $("$GODOT_BIN" --version | head -n 1)"
echo "[runefall] Capture dir: $OUT_DIR"
RUNEFALL_CAPTURE_DIR="$OUT_DIR" "$GODOT_BIN" --path "$ROOT_DIR" --script res://scripts/visual_capture.gd
find "$OUT_DIR" -maxdepth 1 -type f -name '*.png' -print | sort
