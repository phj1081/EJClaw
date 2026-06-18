# RUNEFALL Android Packaging

## Goal

Create a landscape Android debug APK from the Godot prototype:

```bash
cd runefall-prototype
./tools/setup_android_toolchain.sh
./tools/package_android.sh
```

The debug artifact is written to `builds/runefall-debug.apk`.

As of this packaging pass, project data export is verified with:

```bash
/home/hyeon/.local/bin/godot-4.6.1 --headless --path runefall-prototype --export-pack "Android Debug" builds/runefall-debug.pck
```

APK export reaches Godot's Android platform validation but fails with an empty configuration error from Godot 4.6.1 after the SDK/JDK/templates are present. This is recorded in `builds/android-export.log` when `tools/package_android.sh` is run.

## Project Settings

- Preset: `Android Debug`
- Package id: `com.ejclaw.runefall.prototype`
- Format: APK
- Architecture: `arm64-v8a`
- Orientation: `sensor_landscape` from `project.godot`
- Immersive mode: enabled
- Signing: disabled in the committed preset so no keystore secrets are stored in git

## Local Toolchain Required

The local machine must have:

- Godot 4.6.1 export templates matching the installed editor.
- Android SDK command-line tools if Gradle/custom builds are enabled later.
- JDK with `keytool`/`jarsigner` if signed APK/AAB output is required.

Godot's official archive page provides version-matched export templates:
https://godotengine.org/download/archive/4.6.1-stable/

Android's Godot export guide describes the Android build template/export flow:
https://developer.android.com/games/engines/godot/godot-export

This workspace was prepared with:

- Standard Godot 4.6.1: `/home/hyeon/.local/bin/godot-4.6.1`
- JDK 21: `/home/hyeon/snap/godot-4/common/Java/jdk-21.0.11+10`
- Android SDK: `/home/hyeon/snap/godot-4/common/Android/Sdk`
- Standard export templates: `/home/hyeon/.local/share/godot/export_templates/4.6.1.stable`

## Release Build Notes

For Play Store or external testing:

- Add release signing through local `export_credentials.cfg` or CI secrets.
- Enable all required architectures or switch to AAB.
- Replace temporary launcher icons before submission.
- Run the smoke/combat/touch/save/audio tests before exporting.
