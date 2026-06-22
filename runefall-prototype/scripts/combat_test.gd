extends SceneTree

const GameData := preload("res://scripts/game_data.gd")
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
	if main.hero_anim.size() != 4 or not str(main.hero_anim[0].get("asset_id", "")).contains("luna"):
		push_error("Hero animation state did not initialize: %s" % [main.hero_anim])
		quit(1)
		return
	main.hero_anim[0].frame_index = 0
	main.hero_anim[0].anim_time = 0.0
	main.hero_pos[0] += Vector2(24, 0)
	BattleController.update_hero_animations(main, 0.2, Vector2.RIGHT)
	if int(main.hero_anim[0].frame_index) == 0 or bool(main.hero_anim[0].flip_h):
		push_error("Hero walk animation did not advance to right-facing side frames: %s" % [main.hero_anim[0]])
		quit(1)
		return
	main.hero_pos[0] -= Vector2(24, 0)
	BattleController.update_hero_animations(main, 0.2, Vector2.LEFT)
	if not bool(main.hero_anim[0].flip_h):
		push_error("Hero side animation did not flip when moving left: %s" % [main.hero_anim[0]])
		quit(1)
		return
	main.enemies.clear()
	main.ai_presets = ["균형", "공격", "방어", "균형"]
	var ai_target := _add_enemy(main, "zombie", main.hero_pos[0] + Vector2(260, 0), 120.0)
	var target_center: Vector2 = ai_target.pos + Vector2(22, 22)
	var attack_desired: Vector2 = BattleController.ai_desired_position(main, 1, "공격")
	var balanced_desired: Vector2 = BattleController.ai_desired_position(main, 1, "균형")
	if attack_desired.distance_to(target_center) >= balanced_desired.distance_to(target_center):
		push_error("Attack AI preset did not push ally toward enemy: %s vs %s" % [attack_desired, balanced_desired])
		quit(1)
		return
	var guard_desired: Vector2 = BattleController.ai_desired_position(main, 2, "방어")
	var threat_dir: Vector2 = (target_center - main.hero_pos[0]).normalized()
	if guard_desired.distance_to(main.hero_pos[0]) > 120.0 or (guard_desired - main.hero_pos[0]).dot(threat_dir) <= 0.0:
		push_error("Defense AI preset did not guard between active hero and threat: %s" % [guard_desired])
		quit(1)
		return
	var before_ai_move: Vector2 = main.hero_pos[1]
	BattleController.update_party_ai_positions(main, 0.25)
	if main.hero_pos[1].distance_to(attack_desired) >= before_ai_move.distance_to(attack_desired):
		push_error("Attack AI ally did not move toward its desired position.")
		quit(1)
		return

	main.enemies.clear()
	main.room_spawned = 0
	main.wave = 1
	var attached_frame := GameData.topdown_monster_frame("00", 0)
	if not FileAccess.file_exists(attached_frame):
		push_error("Attached RAR monster frame was not imported into the project: %s" % attached_frame)
		quit(1)
		return
	main.spawn_enemy()
	if main.enemies.is_empty() or main.enemies[0].kind != "zombie":
		push_error("Wave 1 should spawn melee zombie, got: %s" % [main.enemies])
		quit(1)
		return
	var spawned_frames: Array = main.enemies[0].get("frames", [])
	if spawned_frames.size() != 8 or not str(spawned_frames[0]).contains("topdown-monsters-free"):
		push_error("Spawned enemy is not using attached RAR monster animation frames: %s" % [spawned_frames])
		quit(1)
		return
	main.enemies[0].anim_time = 0.0
	main.enemies[0].frame_index = 0
	var frame_before: int = int(main.enemies[0].frame_index)
	BattleController.update_enemy_animation(main, main.enemies[0], 0.2)
	if int(main.enemies[0].frame_index) == frame_before:
		push_error("Attached monster animation did not advance frames.")
		quit(1)
		return
	main.floating_texts.clear()
	BattleController.damage_enemy(main, 0, 15.0)
	if main.floating_texts.is_empty():
		push_error("Enemy damage should create floating combat text.")
		quit(1)
		return
	BattleController.update_floating_texts(main, 1.0)
	if not main.floating_texts.is_empty():
		push_error("Floating combat text did not expire.")
		quit(1)
		return

	main.enemies.clear()
	main.room_spawned = main.room_quota
	main.room_clear = false
	BattleController.process_room_clear(main)
	if not main.door_open:
		push_error("Room clear did not open the dungeon door.")
		quit(1)
		return
	if main.floating_texts.is_empty():
		push_error("Room clear should create a floating status banner.")
		quit(1)
		return

	main.hero_pos[main.active_slot] = main.door_rect.position + Vector2(18, 42)
	BattleController.process_room_clear(main)
	if main.dungeon_room_index != 1 or main.room_spawned != 0:
		push_error("Door transition did not advance to room 2.")
		quit(1)
		return

	main.dungeon_room_index = 4
	main.wave = 5
	main.room_quota = 0
	main.room_clear = false
	main.door_open = false
	main.boss_spawned = false
	main.boss_alive = false
	BattleController.process_room_spawns(main)
	if not main.boss_spawned or not main.boss_alive:
		push_error("Boss did not spawn in the final dungeon room.")
		quit(1)
		return

	main.enemies.clear()
	main.projectiles.clear()
	main.effects.clear()
	_add_enemy(main, "zombie", main.hero_pos[0] + Vector2(120, 0), 200.0)
	main.hero_tags[0] = "화염"
	main.hit_nearest_enemy(0)
	if float(main.hero_anim[0].get("attack_time", 0.0)) <= 0.0:
		push_error("Hero attack animation did not trigger on a valid attack.")
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
