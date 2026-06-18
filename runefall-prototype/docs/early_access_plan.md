# RUNEFALL Early Access Gap List

## Current Prototype State

- Mobile landscape Godot prototype with Home, Party, Launch Confirm, Battle HUD, Level Up, and Result flows.
- CC0 placeholder art and audio are integrated for heroes, enemies, dungeon tiles, props, weapon icons, UI buttons, SFX, stingers, and temporary BGM.
- Single-player 4-party loop exists: switchable active hero, AI followers, enemy spawn, auto attacks, XP split, level-up choices, result screen.
- Phase 0 combat has distinct melee/ranged/tank enemies, a wave 5 boss gate, and visible fusion attack patterns.
- Mobile battle input now supports virtual stick drag, dash/skill cooldowns, switch invulnerability feedback, and pause/resume.
- Save data persists party setup, currencies, meta hero levels, equipment placeholder data, and first-session onboarding state.
- Audio pass covers button, attack, hit, dash, skill, level-up, fusion, low-HP warning, victory/defeat stingers, main BGM, and battle BGM.

## Next Critical Slices

1. Tune and expand Phase 0 combat: add 2 more enemy variants, balance boss pacing, and fill out all 6 fusion outcomes.
2. Done: add real mobile touch input: virtual stick drag, dash cooldown, skill cooldown, switch feedback, pause/resume.
3. Done: split monolithic `main.gd` into screen/gameplay modules before feature count grows.
4. Done: add save data for party, currencies, hero levels, equipment, and first-session onboarding state.
5. Done: add audio pass: hit, level-up, button, dash, skill, fusion, low HP, victory/defeat, main BGM, battle BGM.
6. Partial: add packaging checks for Android landscape build and basic performance budget. Android toolchain setup and PCK export are verified; APK export is still blocked by Godot 4.6.1 Android preset validation returning an empty configuration error.

## Early Access Bar

- 15-20 minute playable loop without editor/debug commands.
- At least one complete stage with a boss and loss/win states.
- Persistent progression across app restart.
- No missing-license assets; all temporary assets documented.
- Headed visual capture and smoke test pass before each review handoff.
