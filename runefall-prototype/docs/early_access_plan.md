# RUNEFALL Early Access Gap List

## Current Prototype State

- Mobile landscape Godot prototype with Home, Party, Launch Confirm, Battle HUD, Level Up, and Result flows.
- CC0 placeholder art is integrated for heroes, enemies, dungeon tiles, props, weapon icons, and UI buttons.
- Single-player 4-party loop exists: switchable active hero, AI followers, enemy spawn, auto attacks, XP split, level-up choices, result screen.

## Next Critical Slices

1. Replace dummy combat with tuned Phase 0 content: 1 stage, 4 launch heroes, 5 enemy types, 1 boss, 6 fusion outcomes.
2. Add real mobile touch input: virtual stick drag, dash cooldown, skill cooldown, switch feedback, pause/settings.
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
