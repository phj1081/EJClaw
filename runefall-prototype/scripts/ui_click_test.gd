extends SceneTree

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_ui_click_save.json")
	call_deferred("_run")

func _run() -> void:
	var packed: PackedScene = load("res://scenes/Main.tscn")
	if packed == null:
		push_error("Main scene failed to load.")
		quit(1)
		return

	var main: Node = packed.instantiate()
	root.add_child(main)
	await _settle()

	if not _has_label("RUNEFALL"):
		_fail("Home screen did not render.")
		return

	await _click(Vector2(1227, 611))
	if not _has_label("파티 편성"):
		_fail("Party button click did not open party screen.")
		return

	await _click(Vector2(88, 50))
	if not _has_label("RUNEFALL"):
		_fail("Back-home button click did not return to home.")
		return

	await _click(Vector2(1421, 611))
	if not _has_label("출격 직전 확인"):
		_fail("Launch button click did not open launch confirmation.")
		return

	await _click(Vector2(1346, 758))
	if not bool(main.battle_running):
		_fail("Battle start click did not enter battle.")
		return

	await _click(Vector2(1513, 44))
	if not bool(main.paused):
		_fail("Pause click did not pause battle.")
		return

	await _click(Vector2(800, 500))
	if bool(main.paused):
		_fail("Continue click did not resume battle.")
		return

	print("RUNEFALL_UI_CLICK_OK")
	_cleanup_save()
	quit(0)

func _click(position: Vector2) -> void:
	var press := InputEventMouseButton.new()
	press.button_index = MOUSE_BUTTON_LEFT
	press.position = position
	press.pressed = true
	Input.parse_input_event(press)
	await process_frame

	var release := InputEventMouseButton.new()
	release.button_index = MOUSE_BUTTON_LEFT
	release.position = position
	release.pressed = false
	Input.parse_input_event(release)
	await _settle()

func _settle() -> void:
	for i in range(8):
		await process_frame

func _has_label(text: String) -> bool:
	for node in root.find_children("*", "Label", true, false):
		if node is Label and (node as Label).text == text:
			return true
	return false

func _fail(message: String) -> void:
	push_error(message)
	_cleanup_save()
	quit(1)

func _cleanup_save() -> void:
	var save_path := OS.get_environment("RUNEFALL_SAVE_PATH")
	if FileAccess.file_exists(save_path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(save_path))
