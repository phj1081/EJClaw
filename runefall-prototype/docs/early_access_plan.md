# RUNEFALL Early Access Gap List

## Current Prototype State

- Mobile landscape Godot prototype with Home, Party, Launch Confirm, Battle HUD, Level Up, and Result flows.
- CC0 placeholder art and audio are integrated for heroes, enemies, dungeon tiles, props, weapon icons, UI buttons, SFX, stingers, and temporary BGM.
- Single-player 4-party loop exists: switchable active hero, AI followers, enemy spawn, auto attacks, XP split, level-up choices, result screen.
- Phase 0 combat has distinct melee/ranged/tank enemies, a wave 5 boss gate, and visible fusion attack patterns.
- Mobile battle input now supports virtual stick drag, dash/skill cooldowns, switch invulnerability feedback, and pause/resume.
- Save data persists party setup, currencies, meta hero levels, equipment placeholder data, and first-session onboarding state.
- Audio pass covers button, attack, hit, dash, skill, level-up, fusion, low-HP warning, victory/defeat stingers, main BGM, and battle BGM.
- First-run FTUE prompts now guide movement, dash, party switching, level-up choices, and first fusion.
- Character detail, equipment/crafting, shop, and codex/trials tabs are now interactive prototype flows instead of static placeholders.

## Next Critical Slices

1. Done: tune and expand Phase 0 combat with 2 more enemy variants, adjusted boss pacing, and 6+ distinct fusion outcomes.
2. Done: add real mobile touch input: virtual stick drag, dash cooldown, skill cooldown, switch feedback, pause/resume.
3. Done: split monolithic `main.gd` into screen/gameplay modules before feature count grows.
4. Done: add save data for party, currencies, hero levels, equipment, and first-session onboarding state.
5. Done: add audio pass: hit, level-up, button, dash, skill, fusion, low HP, victory/defeat, main BGM, battle BGM.
6. Done: add Android landscape debug APK packaging with Godot 4.6.3, JDK 17, SDK 35, local debug signing, and export verification.

## Early Access Bar

- 15-20 minute playable loop without editor/debug commands.
- At least one complete stage with a boss and loss/win states.
- Persistent progression across app restart.
- No missing-license assets; all temporary assets documented.
- Headed visual capture and smoke test pass before each review handoff.

## Current Follow-Up Priorities

1. Device or emulator APK smoke test.
2. Balance pass for 15-20 minute pacing and rewards.
3. Final art replacement plan for temporary CC0 placeholders.
