extends SceneTree

const DEFAULT_OUT_DIR := "/tmp/runefall-visual-captures"

var out_dir := DEFAULT_OUT_DIR

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_visual_capture_save.json")
	call_deferred("_run")

func _run() -> void:
	var env_out_dir := OS.get_environment("RUNEFALL_CAPTURE_DIR")
	if not env_out_dir.is_empty():
		out_dir = env_out_dir

	var packed: PackedScene = load("res://scenes/Main.tscn")
	if packed == null:
		push_error("Main scene failed to load.")
		quit(1)
		return

	var main: Node = packed.instantiate()
	root.add_child(main)
	await _settle()
	await _capture("01_home")

	main.show_party()
	await _settle()
	await _capture("02_party")

	main.show_launch_confirm()
	await _settle()
	await _capture("03_launch_confirm")

	main.start_battle()
	await _settle()
	await _capture("04_battle")

	main.toggle_pause()
	await _settle()
	await _capture("05_pause")
	main.toggle_pause()
	await _settle()

	main.battle_time = 112.1
	main.hero_tags[0] = "작열 중력장"
	main._update_battle(0.016)
	main.hit_nearest_enemy(0)
	await _settle()
	await _capture("06_boss_fusion")

	main.show_level_up(0)
	await _settle()
	await _capture("07_level_up")

	var overlays := root.find_children("LevelOverlay", "", true, false)
	for overlay in overlays:
		overlay.queue_free()
	main.battle_running = false
	main.show_result(true)
	await _settle()
	await _capture("08_result")

	main.show_meta_tab("캐릭터")
	await _settle()
	await _capture("09_characters")

	main.show_character_detail(0)
	await _settle()
	await _capture("10_character_detail")

	main.show_meta_tab("장비/제작")
	await _settle()
	await _capture("11_equipment")

	main.show_meta_tab("상점")
	await _settle()
	await _capture("12_shop")

	main.show_meta_tab("시즌패스")
	await _settle()
	await _capture("13_season_pass")

	print("RUNEFALL_VISUAL_CAPTURE_OK %s" % out_dir)
	var save_path := "user://runefall_visual_capture_save.json"
	if FileAccess.file_exists(save_path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(save_path))
	quit(0)

func _settle() -> void:
	for i in range(8):
		await process_frame

func _capture(name: String) -> void:
	DirAccess.make_dir_recursive_absolute(out_dir)
	print("RUNEFALL_CAPTURE_START %s" % name)
	await _settle()
	var image := root.get_texture().get_image()
	if image == null:
		push_error("Failed to read viewport image for %s." % name)
		quit(1)
		return
	if _is_blank(image):
		push_error("Screenshot is blank for %s." % name)
		quit(1)
		return
	var path := "%s/%s.png" % [out_dir, name]
	var error := image.save_png(path)
	if error != OK:
		push_error("Failed to save screenshot %s: %s" % [path, error])
		quit(1)
		return
	print("RUNEFALL_CAPTURE_SAVED %s" % path)

func _is_blank(image: Image) -> bool:
	var first := image.get_pixel(0, 0)
	for y in range(0, image.get_height(), max(1, image.get_height() / 12)):
		for x in range(0, image.get_width(), max(1, image.get_width() / 12)):
			if image.get_pixel(x, y) != first:
				return false
	return true
