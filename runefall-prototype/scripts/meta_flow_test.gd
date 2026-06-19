extends SceneTree

const SaveData := preload("res://scripts/save_data.gd")

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_meta_flow_save.json")
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

	main.show_meta_tab("캐릭터")
	await process_frame
	main.upgrade_hero(0)
	await process_frame
	if int(main.meta_hero_levels[0]) != 2:
		push_error("Hero upgrade did not change level.")
		quit(1)
		return
	if int(main.currencies.gold) != 12540 or int(main.currencies.material) != 308:
		push_error("Hero upgrade cost was not applied: %s" % [main.currencies])
		quit(1)
		return

	main.craft_equipment("화염")
	await process_frame
	var slots: Array = main.equipment.get("common_slots", [])
	if slots.size() != 1 or str(slots[0].tag) != "화염":
		push_error("Crafted equipment was not stored: %s" % [main.equipment])
		quit(1)
		return

	main.buy_shop_offer("starter_material")
	await process_frame
	if int(main.currencies.gem) != 720 or int(main.currencies.material) != 410:
		push_error("Starter material offer did not apply: %s" % [main.currencies])
		quit(1)
		return

	main.buy_shop_offer("season_skin")
	await process_frame
	var skins: Array = main.equipment.get("owned_skins", [])
	if int(main.currencies.gem) != 540 or not skins.has("서리 균열 루나"):
		push_error("Season skin offer did not apply: %s" % [main.equipment])
		quit(1)
		return

	var loaded: Node = packed.instantiate()
	root.add_child(loaded)
	await process_frame
	loaded.load_game()
	var loaded_slots: Array = loaded.equipment.get("common_slots", [])
	var loaded_skins: Array = loaded.equipment.get("owned_skins", [])
	if int(loaded.meta_hero_levels[0]) != 2 or loaded_slots.size() != 1 or not loaded_skins.has("서리 균열 루나"):
		push_error("Meta flow did not persist after reload: %s / %s" % [loaded.meta_hero_levels, loaded.equipment])
		quit(1)
		return

	_cleanup_save()
	print("RUNEFALL_META_FLOW_OK")
	quit(0)

func _cleanup_save() -> void:
	if FileAccess.file_exists(SaveData.save_path()):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(SaveData.save_path()))
