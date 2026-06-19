extends SceneTree

const SaveData := preload("res://scripts/save_data.gd")

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_test_save.json")
	call_deferred("_run")

func _run() -> void:
	if FileAccess.file_exists(SaveData.save_path()):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(SaveData.save_path()))

	var packed: PackedScene = load("res://scenes/Main.tscn")
	if packed == null:
		push_error("Main scene failed to load.")
		quit(1)
		return

	var main: Node = packed.instantiate()
	root.add_child(main)
	await process_frame

	main.party_indices = [2, 1, 4, 5]
	main.active_slot = 2
	main.ai_presets = ["공격", "균형", "방어", "공격"]
	main.currencies = {"gold": 100, "gem": 20, "material": 3}
	main.meta_hero_levels = [1, 2, 3, 4, 5, 6]
	main.onboarding_state = {"first_session_complete": true, "fusion_seen": true, "switch_seen": false}
	main.save_game()

	var loaded: Node = packed.instantiate()
	root.add_child(loaded)
	await process_frame
	loaded.load_game()
	if loaded.party_indices != [2, 1, 4, 5] or loaded.active_slot != 2:
		push_error("Saved party did not load.")
		quit(1)
		return
	if int(loaded.currencies.gold) != 100 or int(loaded.meta_hero_levels[4]) != 5:
		push_error("Saved currencies or hero levels did not load.")
		quit(1)
		return
	if not bool(loaded.onboarding_state.fusion_seen):
		push_error("Saved onboarding state did not load.")
		quit(1)
		return

	loaded.start_battle()
	await process_frame
	loaded.show_result(true)
	await process_frame
	if int(loaded.currencies.gold) != 920 or int(loaded.currencies.material) != 37:
		push_error("Run rewards were not saved into currencies: %s" % [loaded.currencies])
		quit(1)
		return
	if int(loaded.season_pass.xp) != 40:
		push_error("Run rewards were not saved into season pass XP: %s" % [loaded.season_pass])
		quit(1)
		return
	if int(loaded.meta_hero_levels[2]) != 4 or not bool(loaded.onboarding_state.first_session_complete):
		push_error("Run rewards were not saved into meta levels/onboarding.")
		quit(1)
		return

	var reloaded: Node = packed.instantiate()
	root.add_child(reloaded)
	await process_frame
	reloaded.load_game()
	if int(reloaded.currencies.gold) != 920 or int(reloaded.meta_hero_levels[2]) != 4:
		push_error("Saved run result did not persist across reload.")
		quit(1)
		return

	if FileAccess.file_exists(SaveData.save_path()):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(SaveData.save_path()))

	print("RUNEFALL_SAVE_OK")
	quit(0)
