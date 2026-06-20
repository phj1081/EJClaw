extends SceneTree

const GameData := preload("res://scripts/game_data.gd")

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_smoke_save.json")
	call_deferred("_run")

func _run() -> void:
	var packed: PackedScene = load("res://scenes/Main.tscn")
	if packed == null:
		push_error("Main scene failed to load.")
		quit(1)
		return

	var main: Node = packed.instantiate()
	root.add_child(main)
	await process_frame
	for texture_path in [
		str(GameData.hero(0).sprite),
		GameData.topdown_monster_frame("00", 0),
		str(GameData.effect_frames("fire")[0])
	]:
		if main.texture_from_path(texture_path) == null:
			push_error("Texture failed to load through ResourceLoader path: %s" % texture_path)
			quit(1)
			return

	main.show_home()
	await process_frame
	main.show_party()
	await process_frame
	main.show_launch_confirm()
	await process_frame
	main.start_battle()
	await process_frame
	main.hero_xp.clear()
	main.hero_xp.append_array([0.0, 0.0, 0.0, 0.0])
	main.distribute_xp(100.0)
	if main.hero_xp[0] != 40.0 or main.hero_xp[1] != 20.0 or main.hero_xp[2] != 20.0 or main.hero_xp[3] != 20.0:
		push_error("XP distribution failed: %s" % [main.hero_xp])
		quit(1)
		return

	for i in range(12):
		await process_frame

	main.show_result(true)
	await process_frame

	print("RUNEFALL_SMOKE_OK")
	_cleanup_save()
	quit(0)

func _cleanup_save() -> void:
	var save_path := OS.get_environment("RUNEFALL_SAVE_PATH")
	if FileAccess.file_exists(save_path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(save_path))
