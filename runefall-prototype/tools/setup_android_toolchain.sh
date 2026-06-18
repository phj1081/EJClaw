#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="${RUNEFALL_TOOLCHAIN_WORK_DIR:-/tmp/runefall-android-toolchain}"
GODOT_BIN="$HOME/.local/bin/godot-4.6.1"
STANDARD_TEMPLATE_DIR="$HOME/.local/share/godot/export_templates/4.6.1.stable"
JAVA_DIR="$HOME/snap/godot-4/common/Java"
JDK_DIR="$JAVA_DIR/jdk-21.0.11+10"
ANDROID_SDK="$HOME/snap/godot-4/common/Android/Sdk"

mkdir -p "$WORK_DIR" "$HOME/.local/bin" "$STANDARD_TEMPLATE_DIR" "$JAVA_DIR" "$ANDROID_SDK"

cd "$WORK_DIR"

if [[ ! -x "$GODOT_BIN" ]]; then
  curl -L --fail --retry 3 -o Godot_v4.6.1-stable_linux.x86_64.zip \
    'https://downloads.godotengine.org/?version=4.6.1&flavor=stable&slug=linux.x86_64.zip&platform=linux'
  rm -rf godot-standard
  unzip -q Godot_v4.6.1-stable_linux.x86_64.zip -d godot-standard
  install -m 755 godot-standard/Godot_v4.6.1-stable_linux.x86_64 "$GODOT_BIN"
fi

if [[ ! -d "$JDK_DIR" ]]; then
  curl -L --fail --retry 3 -o jdk21.tar.gz \
    'https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk'
  tar -xzf jdk21.tar.gz -C "$JAVA_DIR"
fi

if [[ ! -x "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" ]]; then
  curl -L --fail --retry 3 -o cmdline-tools.zip \
    https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
  rm -rf cmdline-tools "$ANDROID_SDK/cmdline-tools"
  unzip -q cmdline-tools.zip -d "$WORK_DIR"
  mkdir -p "$ANDROID_SDK/cmdline-tools"
  mv "$WORK_DIR/cmdline-tools" "$ANDROID_SDK/cmdline-tools/latest"
fi

export JAVA_HOME="$JDK_DIR"
export ANDROID_SDK_ROOT="$ANDROID_SDK"
export PATH="$JAVA_HOME/bin:$ANDROID_SDK/cmdline-tools/latest/bin:$PATH"

yes | sdkmanager --sdk_root="$ANDROID_SDK" --licenses >/tmp/runefall-sdk-licenses.log || true
sdkmanager --sdk_root="$ANDROID_SDK" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'

if [[ ! -s "$STANDARD_TEMPLATE_DIR/android_debug.apk" ]]; then
  curl -L --fail --retry 3 -o Godot_v4.6.1-stable_export_templates.tpz \
    'https://downloads.godotengine.org/?version=4.6.1&flavor=stable&slug=export_templates.tpz&platform=templates'
  unzip -o -j Godot_v4.6.1-stable_export_templates.tpz \
    'templates/android_debug.apk' 'templates/android_release.apk' 'templates/version.txt' \
    -d "$STANDARD_TEMPLATE_DIR"
fi

SETTINGS="$HOME/.config/godot/editor_settings-4.6.tres"
mkdir -p "$(dirname "$SETTINGS")" "$HOME/.local/share/godot/keystores"
"$GODOT_BIN" --headless --path "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" --quit >/tmp/runefall-standard-init.log 2>&1 || true

if [[ ! -s "$HOME/.local/share/godot/keystores/debug.keystore" ]]; then
  "$JAVA_HOME/bin/keytool" -genkeypair -v \
    -keystore "$HOME/.local/share/godot/keystores/debug.keystore" \
    -storepass android -alias androiddebugkey -keypass android \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname 'CN=Android Debug,O=Android,C=US'
fi

if [[ -s "$SETTINGS" ]]; then
  if grep -q 'export/android/java_sdk_path' "$SETTINGS"; then
    perl -0pi -e 's|export/android/debug_keystore = "[^"]*"|export/android/debug_keystore = "'$HOME'/.local/share/godot/keystores/debug.keystore"|; s|export/android/java_sdk_path = "[^"]*"|export/android/java_sdk_path = "'$JDK_DIR'"|; s|export/android/android_sdk_path = "[^"]*"|export/android/android_sdk_path = "'$ANDROID_SDK'"|' "$SETTINGS"
  else
    {
      echo "export/android/debug_keystore = \"$HOME/.local/share/godot/keystores/debug.keystore\""
      echo 'export/android/debug_keystore_pass = "android"'
      echo "export/android/java_sdk_path = \"$JDK_DIR\""
      echo "export/android/android_sdk_path = \"$ANDROID_SDK\""
    } >> "$SETTINGS"
  fi
fi

echo "[runefall] Android toolchain ready"
echo "[runefall] Godot: $GODOT_BIN"
echo "[runefall] JDK: $JDK_DIR"
echo "[runefall] SDK: $ANDROID_SDK"
