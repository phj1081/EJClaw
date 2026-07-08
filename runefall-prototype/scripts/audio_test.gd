extends SceneTree

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_audio_save.json")
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

	if main.bgm_player == null or main.sfx_players.size() < 6:
		push_error("Audio players were not initialized.")
		quit(1)
		return

	main.play_music("main")
	await process_frame
	if main.bgm_player.stream == null:
		push_error("Main BGM did not load.")
		quit(1)
		return

	main.start_battle()
	await process_frame
	if main.bgm_player.stream == null:
		push_error("Battle BGM did not load.")
		quit(1)
		return

	for key in ["ui_click", "attack", "hit", "dash", "skill", "level_up", "fusion", "victory", "defeat", "low_hp"]:
		main.play_sfx(key)
	await process_frame
	var has_sfx_stream := false
	for player: AudioStreamPlayer in main.sfx_players:
		if player.stream != null:
			has_sfx_stream = true
			break
	if not has_sfx_stream:
		push_error("SFX stream did not load.")
		quit(1)
		return

	print("RUNEFALL_AUDIO_OK")
	_cleanup_save()
	quit(0)

func _cleanup_save() -> void:
	var save_path := OS.get_environment("RUNEFALL_SAVE_PATH")
	if FileAccess.file_exists(save_path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(save_path))
