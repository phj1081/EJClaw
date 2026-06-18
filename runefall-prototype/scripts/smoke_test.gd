extends SceneTree

func _initialize() -> void:
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

	main.show_home()
	await process_frame
	main.show_party()
	await process_frame
	main.show_launch_confirm()
	await process_frame
	main.start_battle()
	await process_frame

	for i in range(12):
		await process_frame

	main.show_result(true)
	await process_frame

	print("RUNEFALL_SMOKE_OK")
	quit(0)
