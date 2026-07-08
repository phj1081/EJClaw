# RUNEFALL Progress Report

## Current State

- Mobile landscape Godot prototype is playable through Home, Party, Launch Confirm, Battle HUD, Level Up, Pause, and Result screens.
- CC0 placeholder art/audio are integrated and documented.
- Single-player 4-party loop is implemented with active hero switching, AI followers, XP split, level choices, fusion attacks, win/loss result, and persistent progression.
- Phase 0 combat includes melee, ranged, tank, runner, bomber enemy roles, a wave 5 boss, and 6+ distinct fusion outcomes.
- Mobile touch controls, cooldown feedback, pause/resume, save data, audio, and Android debug APK packaging are implemented.
- First-run FTUE now walks the player through movement, dash, character switching, level-up selection, and first fusion.
- Character detail, equipment/crafting, shop, and codex/trials meta screens now have interactive prototype flows backed by save data.
- Season pass has free/premium tracks, mission XP, claim state, and dummy premium purchase flow.
- Shop and IAP now share prototype product tables with product IDs, price labels, reward mapping, and dummy receipt records.
- Core balance/economy numbers are centralized in `scripts/balance_table.gd` for tuning.
- Headed visual capture now produces 13 QA screenshots under `/tmp/runefall-visual-captures`.
- Release readiness review is documented in `docs/release_readiness_review.md`: current state is a playable vertical prototype, not an asset-only public release candidate yet.

## Verified Commands

```bash
/home/hyeon/.local/bin/godot-4.6.3 --headless --path runefall-prototype --script res://scripts/smoke_test.gd
/home/hyeon/.local/bin/godot-4.6.3 --headless --path runefall-prototype --script res://scripts/combat_test.gd
/home/hyeon/.local/bin/godot-4.6.3 --headless --path runefall-prototype --script res://scripts/touch_input_test.gd
/home/hyeon/.local/bin/godot-4.6.3 --headless --path runefall-prototype --script res://scripts/save_data_test.gd
/home/hyeon/.local/bin/godot-4.6.3 --headless --path runefall-prototype --script res://scripts/audio_test.gd
/home/hyeon/.local/bin/godot-4.6.3 --headless --path runefall-prototype --script res://scripts/ftue_test.gd
/home/hyeon/.local/bin/godot-4.6.3 --headless --path runefall-prototype --script res://scripts/meta_flow_test.gd
/home/hyeon/.local/bin/godot-4.6.3 --headless --path runefall-prototype --script res://scripts/economy_test.gd
cd runefall-prototype && ./tools/package_android.sh
cd runefall-prototype && ./tools/capture_visuals.sh
```

## Next Work

1. Run an actual device or emulator smoke test for the generated APK.
2. Tune the 15-20 minute loop: stage pacing, reward amounts, boss difficulty, and fusion balance.
3. Replace remaining placeholder icons/sprites with final or higher-quality licensed pixel assets.
4. Prepare release signing, store metadata, privacy/compliance, and public-scope messaging before external launch.
