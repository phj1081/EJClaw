extends SceneTree

const BattleController := preload("res://scripts/battle_controller.gd")

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_combat_save.json")
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
	main.start_battle()
	await process_frame

	main.enemies.clear()
	main.wave = 1
	main.spawn_enemy()
	if main.enemies.is_empty() or main.enemies[0].kind != "zombie":
		push_error("Wave 1 should spawn melee zombie, got: %s" % [main.enemies])
		quit(1)
		return

	main.enemies.clear()
	main.battle_time = 112.1
	main.boss_spawned = false
	main.boss_alive = false
	main._update_battle(0.016)
	if not main.boss_spawned or not main.boss_alive:
		push_error("Boss did not spawn at wave 5.")
		quit(1)
		return

	main.enemies.clear()
	main.projectiles.clear()
	main.effects.clear()
	_add_enemy(main, "zombie", main.hero_pos[0] + Vector2(120, 0), 200.0)
	main.hero_tags[0] = "작열 중력장"
	main.hit_nearest_enemy(0)
	if main.effects.is_empty():
		push_error("Fusion gravity attack did not create an area effect.")
		quit(1)
		return

	if BattleController.FUSION_ATTACKS.size() < 6:
		push_error("Phase 0 should expose at least 6 fusion attacks.")
		quit(1)
		return
	for fusion_name in ["작열 중력장", "번지는 화염", "용암 레일", "반사 레일건", "궤도 정령", "수호 토템"]:
		if not _fusion_creates_visible_pattern(main, fusion_name):
			push_error("Fusion did not create a visible pattern: %s" % fusion_name)
			quit(1)
			return

	var shade := _add_enemy(main, "shade_runner", main.hero_pos[0] + Vector2(220, 0), 80.0)
	var shade_before: Vector2 = shade.pos
	BattleController.update_shade_runner(main, shade, 0.25)
	if shade.pos.distance_to(shade_before) < 4.0:
		push_error("Shade runner did not move.")
		quit(1)
		return

	main.enemies.clear()
	main.invuln_timer = 0.0
	var bomber := _add_enemy(main, "spore_bomber", main.hero_pos[0] + Vector2(50, 0), 40.0)
	bomber.attack_cd = 0.0
	var hp_before: float = main.hero_hp[0]
	BattleController.update_spore_bomber(main, bomber, 0.2)
	if main.enemies.size() != 0 or main.hero_hp[0] >= hp_before:
		push_error("Spore bomber did not detonate and damage the party.")
		quit(1)
		return

	var before_phase: int = main.enemies.size()
	main.enemies.clear()
	main.boss_spawned = false
	main.boss_alive = false
	BattleController.spawn_boss(main)
	if main.enemies.size() <= before_phase or float(main.enemies[0].pattern_cd) <= 0.0:
		push_error("Boss tuning state did not initialize.")
		quit(1)
		return

	print("RUNEFALL_COMBAT_OK")
	_cleanup_save()
	quit(0)

func _add_enemy(main: Node, kind: String, pos: Vector2, hp: float) -> Dictionary:
	var enemy := ColorRect.new()
	enemy.size = Vector2(38, 38)
	enemy.color = Color("#d74848")
	main.arena.add_child(enemy)
	var data := {
		"kind": kind,
		"node": enemy,
		"pos": pos,
		"hp": hp,
		"max_hp": hp,
		"speed": 80.0,
		"damage": 10.0,
		"range": 74.0,
		"xp": 0.0,
		"attack_cd": 0.0,
		"attack_interval": 1.0,
		"is_boss": false
	}
	main.enemies.append(data)
	return data

func _fusion_creates_visible_pattern(main: Node, fusion_name: String) -> bool:
	main.enemies.clear()
	main.projectiles.clear()
	main.effects.clear()
	main.hero_tags[0] = fusion_name
	main.invuln_timer = 0.0
	_add_enemy(main, "zombie", main.hero_pos[0] + Vector2(120, 0), 240.0)
	main.hit_nearest_enemy(0)
	if fusion_name == "궤도 정령":
		return main.projectiles.size() >= 3
	if fusion_name == "수호 토템":
		return main.effects.size() > 0 and main.invuln_timer > 0.0
	return main.effects.size() > 0 or main.projectiles.size() > 0

func _cleanup_save() -> void:
	var save_path := OS.get_environment("RUNEFALL_SAVE_PATH")
	if FileAccess.file_exists(save_path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(save_path))
