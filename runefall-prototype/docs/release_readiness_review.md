# RUNEFALL Release Readiness Review

## Verdict

RUNEFALL is not yet "asset replacement only" ready for public release.

The current build is a playable single-player vertical prototype and a reasonable internal or very limited early-access candidate. It has enough structure to evaluate the core loop, UI, save flow, audio, and Android packaging, but release readiness still depends on device validation, release packaging, balance, compliance, and final content scope decisions.

## What Is Ready

- Mobile landscape Godot prototype with full Home -> Party -> Battle -> Result loop.
- Four-hero single-player party combat with switching, AI allies, XP split, level-up choices, fusion attacks, boss, and win/loss states.
- Interactive prototype meta screens for character growth, equipment/crafting, shop offers, and codex/trials.
- First-run FTUE prompts for movement, dash, switching, level-up, and fusion.
- Persistent save data for party, currencies, meta levels, equipment, shop outcomes, and FTUE state.
- CC0 placeholder art/audio documented in `docs/asset_credits.md`.
- Android debug APK export and signing verification.
- Automated smoke, combat, touch, save, audio, FTUE, meta, APK, and visual capture checks.

## Not Asset-Only Yet

- Android APK has not been smoke-tested on a real device or emulator in this workspace.
- Release signing, store-ready export profile, package metadata, privacy policy, and storefront materials are not complete.
- The playable loop is not yet proven for 15-20 minute pacing through real playtesting.
- Shop and purchases are prototype-only; no real IAP, backend validation, ads, analytics, or account recovery exists.
- GDD multiplayer/co-op is not implemented. Early access must be scoped as single-player unless networking is added later.
- Final art replacement still needs a style pass across heroes, enemies, maps, VFX, icons, UI, and store screenshots.

## Release Gate

Treat the next public build as ready only after these pass:

1. Android device or emulator install/run test passes.
2. Release APK/AAB is signed with a production key and validated.
3. One 15-20 minute stage loop is balanced enough for repeated play.
4. Placeholder assets are either replaced or explicitly approved for early access with license records.
5. Store/legal basics are complete: app id, icon, screenshots, privacy policy, permissions review, and IAP/ad disclosure if used.
6. Known scope is communicated clearly: single-player prototype/early access, not full 4-player co-op launch.

## Recommended Next Work

1. Device/emulator smoke test for the current APK.
2. 15-20 minute balance pass with reward and boss tuning.
3. Final asset replacement list by screen/system.
4. Release signing and store packaging pass.
5. Store compliance and monetization implementation only after the core loop survives device testing.
