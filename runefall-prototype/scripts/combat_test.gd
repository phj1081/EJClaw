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
	var enemy := ColorRect.new()
	enemy.size = Vector2(38, 38)
	enemy.color = Color("#d74848")
	main.arena.add_child(enemy)
	main.enemies.append({
		"kind": "zombie",
		"node": enemy,
		"pos": main.hero_pos[0] + Vector2(120, 0),
		"hp": 200.0,
		"max_hp": 200.0,
		"speed": 0.0,
		"damage": 0.0,
		"range": 0.0,
		"xp": 0.0,
		"attack_cd": 0.0,
		"attack_interval": 1.0,
		"is_boss": false
	})
	main.hero_tags[0] = "작열 중력장"
	main.hit_nearest_enemy(0)
	if main.effects.is_empty():
		push_error("Fusion gravity attack did not create an area effect.")
		quit(1)
		return

	print("RUNEFALL_COMBAT_OK")
	quit(0)
