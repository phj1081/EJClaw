extends RefCounted

const GameData := preload("res://scripts/game_data.gd")
const DEFAULT_SAVE_PATH := "user://runefall_save.json"
const VERSION := 1

const DEFAULT_CURRENCIES := {"gold": 12840, "gem": 760, "material": 324}
const DEFAULT_ONBOARDING := {"first_session_complete": false, "fusion_seen": false, "switch_seen": false}

static func load_into(main) -> void:
	_apply_defaults(main)
	if not FileAccess.file_exists(save_path()):
		save_from(main)
		return

	var file := FileAccess.open(save_path(), FileAccess.READ)
	if file == null:
		push_warning("Failed to open RUNEFALL save for read.")
		return
	var parsed = JSON.parse_string(file.get_as_text())
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("RUNEFALL save was invalid JSON; defaults kept.")
		return

	var data: Dictionary = parsed
	main.party_indices = _int_array(data.get("party_indices", main.party_indices), 4, main.party_indices)
	main.active_slot = clampi(int(data.get("active_slot", main.active_slot)), 0, 3)
	main.ai_presets = _string_array(data.get("ai_presets", main.ai_presets), 4, main.ai_presets)
	main.currencies = _dictionary(data.get("currencies", DEFAULT_CURRENCIES), DEFAULT_CURRENCIES)
	main.meta_hero_levels = _int_array(data.get("meta_hero_levels", main.meta_hero_levels), GameData.HEROES.size(), main.meta_hero_levels)
	main.equipment = _dictionary(data.get("equipment", main.equipment), main.equipment)
	main.onboarding_state = _dictionary(data.get("onboarding_state", DEFAULT_ONBOARDING), DEFAULT_ONBOARDING)

static func save_from(main) -> void:
	var data := {
		"version": VERSION,
		"party_indices": main.party_indices,
		"active_slot": main.active_slot,
		"ai_presets": main.ai_presets,
		"currencies": main.currencies,
		"meta_hero_levels": main.meta_hero_levels,
		"equipment": main.equipment,
		"onboarding_state": main.onboarding_state
	}
	var file := FileAccess.open(save_path(), FileAccess.WRITE)
	if file == null:
		push_warning("Failed to open RUNEFALL save for write.")
		return
	file.store_string(JSON.stringify(data, "\t"))

static func apply_run_result(main, victory: bool) -> void:
	if main.result_applied:
		return
	var gold := 820 if victory else 360
	var material := 34 if victory else 14
	var meta_xp := 1 if victory else 0
	main.currencies.gold = int(main.currencies.get("gold", 0)) + gold
	main.currencies.material = int(main.currencies.get("material", 0)) + material
	main.onboarding_state.first_session_complete = true
	main.last_run_rewards = {"gold": gold, "material": material, "meta_xp": meta_xp}
	for hero_index in main.party_indices:
		if hero_index >= 0 and hero_index < main.meta_hero_levels.size():
			main.meta_hero_levels[hero_index] = int(main.meta_hero_levels[hero_index]) + meta_xp
	main.result_applied = true
	save_from(main)

static func reset(main) -> void:
	if FileAccess.file_exists(save_path()):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(save_path()))
	_apply_defaults(main)
	save_from(main)

static func save_path() -> String:
	var override := OS.get_environment("RUNEFALL_SAVE_PATH")
	return override if not override.is_empty() else DEFAULT_SAVE_PATH

static func _apply_defaults(main) -> void:
	main.party_indices = [0, 1, 2, 3]
	main.active_slot = 0
	main.ai_presets = ["균형", "균형", "방어", "공격"]
	main.currencies = DEFAULT_CURRENCIES.duplicate(true)
	main.meta_hero_levels = []
	for i in range(GameData.HEROES.size()):
		main.meta_hero_levels.append(1)
	main.equipment = {"common_slots": [], "hero_slots": {}}
	main.onboarding_state = DEFAULT_ONBOARDING.duplicate(true)
	main.last_run_rewards = {"gold": 0, "material": 0, "meta_xp": 0}
	main.result_applied = false

static func _int_array(value, size: int, fallback: Array) -> Array:
	if typeof(value) != TYPE_ARRAY:
		return fallback.duplicate(true)
	var result := []
	for i in range(size):
		var item = value[i] if i < value.size() else fallback[i]
		result.append(int(item))
	return result

static func _string_array(value, size: int, fallback: Array) -> Array:
	if typeof(value) != TYPE_ARRAY:
		return fallback.duplicate(true)
	var result := []
	for i in range(size):
		var item = value[i] if i < value.size() else fallback[i]
		result.append(str(item))
	return result

static func _dictionary(value, fallback: Dictionary) -> Dictionary:
	if typeof(value) != TYPE_DICTIONARY:
		return fallback.duplicate(true)
	var merged := fallback.duplicate(true)
	for key in value:
		merged[key] = value[key]
	return merged
