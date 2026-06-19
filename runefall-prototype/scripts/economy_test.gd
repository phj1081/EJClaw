extends SceneTree

const BalanceTable := preload("res://scripts/balance_table.gd")
const SaveData := preload("res://scripts/save_data.gd")

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_economy_save.json")
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

	if BalanceTable.ENEMY_TYPES.size() < 5 or BalanceTable.SEASON_REWARDS.size() < 5 or BalanceTable.IAP_PRODUCTS.size() < 3:
		push_error("Balance/economy tables are incomplete.")
		quit(1)
		return

	main.show_meta_tab("시즌패스")
	await process_frame
	main.complete_season_mission("run_once")
	await process_frame
	if int(main.season_pass.xp) != 40 or int(main.season_pass.level) != 1:
		push_error("Season mission XP failed: %s" % [main.season_pass])
		quit(1)
		return

	main.complete_season_mission("defeat_boss")
	await process_frame
	if int(main.season_pass.xp) != 110 or int(main.season_pass.level) != 2:
		push_error("Season level did not advance: %s" % [main.season_pass])
		quit(1)
		return

	main.claim_season_reward(1, false)
	await process_frame
	if int(main.currencies.gold) != 13440 or not main.season_pass.claimed_free.has(1):
		push_error("Free season reward did not apply: %s / %s" % [main.currencies, main.season_pass])
		quit(1)
		return

	main.buy_iap_product("premium_pass")
	await process_frame
	if not bool(main.season_pass.premium_unlocked) or int(main.currencies.gem) != 940 or main.iap_receipts.size() != 1:
		push_error("Dummy premium IAP did not apply: %s / %s / %s" % [main.season_pass, main.currencies, main.iap_receipts])
		quit(1)
		return

	main.claim_season_reward(1, true)
	await process_frame
	if int(main.currencies.gem) != 1000 or not main.season_pass.claimed_premium.has(1):
		push_error("Premium season reward did not apply: %s / %s" % [main.currencies, main.season_pass])
		quit(1)
		return

	main.buy_iap_product("starter_pack")
	await process_frame
	if int(main.currencies.gold) != 16440 or int(main.currencies.material) != 484 or main.iap_receipts.size() != 2:
		push_error("Starter pack dummy reward failed: %s / %s" % [main.currencies, main.iap_receipts])
		quit(1)
		return

	var loaded: Node = packed.instantiate()
	root.add_child(loaded)
	await process_frame
	loaded.load_game()
	if not bool(loaded.season_pass.premium_unlocked) or int(loaded.season_pass.xp) != 110 or loaded.iap_receipts.size() != 2:
		push_error("Economy state did not persist: %s / %s" % [loaded.season_pass, loaded.iap_receipts])
		quit(1)
		return

	_cleanup_save()
	print("RUNEFALL_ECONOMY_OK")
	quit(0)

func _cleanup_save() -> void:
	if FileAccess.file_exists(SaveData.save_path()):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(SaveData.save_path()))
