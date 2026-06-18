# RUNEFALL Android Packaging

## Goal

Create a landscape Android debug APK from the Godot prototype:

```bash
cd runefall-prototype
./tools/setup_android_toolchain.sh
./tools/package_android.sh
```

The debug artifact is written to `builds/runefall-debug.apk`.

As of this packaging pass, Android export is verified with:

```bash
cd runefall-prototype
./tools/package_android.sh
```

The script installs the Godot Android build template when needed, then writes `builds/runefall-debug.apk`.

## Project Settings

- Preset: `Android Debug`
- Package id: `com.ejclaw.runefall.prototype`
- Format: APK
- Architecture: `arm64-v8a`
- Orientation: `sensor_landscape` from `project.godot`
- Immersive mode: enabled
- Signing: debug signed through local Godot editor settings. No keystore secrets are stored in git.
- Texture import: Android ETC2/ASTC import is enabled in `project.godot`; without this, Godot can fail Android validation with an empty configuration error.

## Local Toolchain Required

The local machine must have:

- Godot 4.6.3 export templates matching the installed editor.
- Android SDK command-line tools with platform 35 and build-tools 35.0.1.
- JDK 17 with `keytool` for the local debug keystore.

Godot's official archive page provides version-matched export templates:
https://godotengine.org/download/archive/4.6.3-stable/

Android's Godot export guide describes the Android build template/export flow:
https://developer.android.com/games/engines/godot/godot-export

This workspace was prepared with:

- Standard Godot 4.6.3: `/home/hyeon/.local/bin/godot-4.6.3`
- JDK 17: `/home/hyeon/snap/godot-4/common/Java/jdk-17.0.19+10`
- Android SDK: `/home/hyeon/snap/godot-4/common/Android/Sdk`
- Standard export templates: `/home/hyeon/.local/share/godot/export_templates/4.6.3.stable`

## Release Build Notes

For Play Store or external testing:

- Add release signing through local `export_credentials.cfg` or CI secrets.
- Enable all required architectures or switch to AAB.
- Replace temporary launcher icons before submission.
- Run the smoke/combat/touch/save/audio tests before exporting.
