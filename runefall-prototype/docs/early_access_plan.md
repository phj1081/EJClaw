# RUNEFALL Early Access Gap List

## Current Prototype State

- Mobile landscape Godot prototype with Home, Party, Launch Confirm, Battle HUD, Level Up, and Result flows.
- CC0 placeholder art is integrated for heroes, enemies, dungeon tiles, props, weapon icons, and UI buttons.
- Single-player 4-party loop exists: switchable active hero, AI followers, enemy spawn, auto attacks, XP split, level-up choices, result screen.
- Phase 0 combat has distinct melee/ranged/tank enemies, a wave 5 boss gate, and visible fusion attack patterns.
- Mobile battle input now supports virtual stick drag, dash/skill cooldowns, switch invulnerability feedback, and pause/resume.

## Next Critical Slices

1. Tune and expand Phase 0 combat: add 2 more enemy variants, balance boss pacing, and fill out all 6 fusion outcomes.
2. Done: add real mobile touch input: virtual stick drag, dash cooldown, skill cooldown, switch feedback, pause/resume.
3. Done: split monolithic `main.gd` into screen/gameplay modules before feature count grows.
4. Add save data for party, currencies, hero levels, equipment, and first-session onboarding state.
5. Add audio pass: hit, level-up, button, dash, low HP, victory/defeat.
6. Add packaging checks for Android landscape build and basic performance budget.

## Early Access Bar

- 15-20 minute playable loop without editor/debug commands.
- At least one complete stage with a boss and loss/win states.
- Persistent progression across app restart.
- No missing-license assets; all temporary assets documented.
- Headed visual capture and smoke test pass before each review handoff.
