extends SceneTree

const SaveData := preload("res://scripts/save_data.gd")

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_ftue_save.json")
	call_deferred("_run")

func _run() -> void:
	_cleanup_save()

	var packed: PackedScene = load("res://scenes/Main.tscn")
	if packed == null:
		push_error("Main scene failed to load.")
		quit(1)
		return

	var main: Node = packed.instantiate()
	root.add_child(main)
	await process_frame
	main.start_battle()
	await process_frame

	if main.tutorial_panel == null or bool(main.onboarding_state.move_seen):
		push_error("FTUE move prompt did not start correctly.")
		quit(1)
		return

	main.touch_move_dir = Vector2.RIGHT
	main._update_battle(0.12)
	if not bool(main.onboarding_state.move_seen):
		push_error("FTUE movement step was not marked.")
		quit(1)
		return

	main.dash_active()
	if not bool(main.onboarding_state.dash_seen):
		push_error("FTUE dash step was not marked.")
		quit(1)
		return

	main.try_switch(1)
	if main.active_slot != 1 or not bool(main.onboarding_state.switch_seen):
		push_error("FTUE switch step was not marked.")
		quit(1)
		return

	main.show_level_up(main.active_slot)
	await process_frame
	if not bool(main.onboarding_state.level_up_seen):
		push_error("FTUE level-up step was not marked.")
		quit(1)
		return

	main.apply_level_choice(main.active_slot, {"name": "정령 소환", "kind": "무기", "tag": "소환", "desc": "작은 정령이 자동 공격"})
	if not bool(main.onboarding_state.fusion_seen) or main.hero_tags[main.active_slot] != "수호 토템":
		push_error("FTUE fusion step was not marked: %s" % [main.onboarding_state])
		quit(1)
		return

	var loaded: Node = packed.instantiate()
	root.add_child(loaded)
	await process_frame
	loaded.load_game()
	if not bool(loaded.onboarding_state.move_seen) or not bool(loaded.onboarding_state.fusion_seen):
		push_error("FTUE onboarding state did not persist: %s" % [loaded.onboarding_state])
		quit(1)
		return

	_cleanup_save()
	print("RUNEFALL_FTUE_OK")
	quit(0)

func _cleanup_save() -> void:
	if FileAccess.file_exists(SaveData.save_path()):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(SaveData.save_path()))
