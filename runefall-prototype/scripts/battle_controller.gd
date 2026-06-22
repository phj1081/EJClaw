extends RefCounted

const GameData := preload("res://scripts/game_data.gd")
const BalanceTable := preload("res://scripts/balance_table.gd")
const TouchInput := preload("res://scripts/touch_input.gd")
const TutorialFlow := preload("res://scripts/tutorial_flow.gd")
const BATTLE_DURATION := BalanceTable.BATTLE_DURATION
const ARENA_MIN := BalanceTable.ARENA_MIN
const ARENA_MAX := BalanceTable.ARENA_MAX
const ENEMY_TYPES := BalanceTable.ENEMY_TYPES
const FUSION_ATTACKS := BalanceTable.FUSION_ATTACKS
const DUNGEON_ROOMS := [
	{"name": "먼지 낀 입구", "quota": 7, "kinds": ["zombie", "scarab_swarm"], "tint": Color("#16243a")},
	{"name": "해골 초소", "quota": 9, "kinds": ["shade_runner", "bone_guard", "orc_shaman"], "tint": Color("#1b263d")},
	{"name": "포자 저장고", "quota": 10, "kinds": ["spore_bomber", "crystal_slug", "muddy"], "tint": Color("#1b2d2a")},
	{"name": "균열 감시실", "quota": 12, "kinds": ["rift_eye", "ember_guard", "rift_commander", "orc_shaman"], "tint": Color("#211d3d")},
	{"name": "균열 제단", "quota": 0, "kinds": [], "tint": Color("#2c1728")}
]

static func start(main) -> void:
	var root: Control = main.screen_root()
	main.battle_root = root
	var bg := ColorRect.new()
	bg.size = main.VIEW_SIZE
	bg.color = Color("#0b1020")
	root.add_child(bg)

	main.arena = Control.new()
	main.arena.position = Vector2(0, 0)
	main.arena.size = main.VIEW_SIZE
	root.add_child(main.arena)

	var top: Control = main.framed_panel(root, Vector2(520, 18), Vector2(560, 54), Color("#101827dd"), "fantasy_border_banner", Color("#c4d7ff"), 12)
	main.timer_label = main.label(top, "방 1/5", Vector2(16, 8), Vector2(110, 34), 20)
	main.wave_label = main.label(top, "먼지 낀 입구", Vector2(134, 8), Vector2(190, 34), 20)
	main.xp_bar = ProgressBar.new()
	main.xp_bar.position = Vector2(342, 13)
	main.xp_bar.size = Vector2(160, 24)
	main.xp_bar.max_value = main.hero_next_xp[main.active_slot]
	main.xp_bar.value = main.hero_xp[main.active_slot]
	top.add_child(main.xp_bar)

	var party_panel: Control = main.framed_panel(root, Vector2(22, 112), Vector2(222, 282), Color("#101827e8"), "fantasy_panel_banner", Color("#c4d7ff"), 14)
	main.label(party_panel, "파티", Vector2(16, 8), Vector2(80, 28), 20)
	main.divider(party_panel, Vector2(16, 34), Vector2(132, 18), Color("#c4d7ff"))
	for i in range(4):
		var b: Button = main.button(party_panel, "", Vector2(14, 54 + i * 52), Vector2(194, 42), Callable(main, "try_switch").bind(i), 15, Color("#24314a"))
		main.party_buttons.append(b)

	TouchInput.build_controls(main, root)

	main.battle_time = 0.0
	main.wave = 1
	main.dungeon_room_index = 0
	main.dungeon_room_count = DUNGEON_ROOMS.size()
	main.room_spawned = 0
	main.room_quota = int(DUNGEON_ROOMS[0].quota)
	main.room_clear = false
	main.door_open = false
	main.door_rect = Rect2(1438, 382, 54, 132)
	main.door_node = null
	main.room_label = null
	main.room_goal_label = null
	main.result_applied = false
	main.last_run_rewards = {"gold": 0, "material": 0, "meta_xp": 0}
	main.spawn_timer = 0.0
	main.attack_timer = 0.0
	main.boss_spawned = false
	main.boss_alive = false
	main.paused = false
	main.dash_cooldown = 0.0
	main.skill_cooldown = 0.0
	main.invuln_timer = 0.0
	main.low_hp_warned = false
	main.switch_flash_timer = 0.0
	main.switch_cd.clear()
	main.switch_cd.append_array([0.0, 0.0, 0.0, 0.0])
	main.hero_pos.clear()
	main.hero_pos.append_array([Vector2(760, 430), Vector2(700, 488), Vector2(824, 490), Vector2(760, 552)])
	main.hero_hp.clear()
	main.hero_levels = [1, 1, 1, 1]
	main.hero_xp.clear()
	main.hero_xp.append_array([0.0, 0.0, 0.0, 0.0])
	main.hero_next_xp.clear()
	main.hero_next_xp.append_array([
		float(BalanceTable.LEVEL_XP.start),
		float(BalanceTable.LEVEL_XP.start),
		float(BalanceTable.LEVEL_XP.start),
		float(BalanceTable.LEVEL_XP.start)
	])
	main.hero_tags = ["", "", "", ""]
	main.hero_skill_tags.clear()
	main.hero_skill_cooldowns.clear()
	for i in range(4):
		var h := GameData.hero(main.party_indices[i])
		main.hero_hp.append(float(h.hp))
		main.hero_tags[i] = h.tag
		main.hero_skill_tags.append([h.tag])
		main.hero_skill_cooldowns.append([0.0])
	draw_dungeon_map(main)
	build_hero_nodes(main)
	TouchInput.refresh_skill_buttons(main)

	main.battle_running = true
	update_ui(main)
	TutorialFlow.start_battle(main)

static func build_hero_nodes(main) -> void:
	main.hero_nodes.clear()
	main.hero_labels.clear()
	main.hero_anim.clear()
	for i in range(4):
		var h := GameData.hero(main.party_indices[i])
		var asset_id := str(h.get("asset", GameData.hero_asset_id(main.party_indices[i])))
		var body: Control = main.pixel_art(main.arena, GameData.hero_frame(asset_id, "down", 0), main.hero_pos[i], Vector2(64, 78), Color(h.color))
		body.position = main.hero_pos[i]
		body.pivot_offset = Vector2(32, 39)
		main.hero_nodes.append(body)
		main.hero_anim.append({
			"asset_id": asset_id,
			"direction": "down",
			"frame_index": 0,
			"anim_time": randf_range(0.0, 0.2),
			"attack_time": 0.0,
			"flip_h": false,
			"last_pos": main.hero_pos[i]
		})
		var name_label: Label = main.label(main.arena, h.name, main.hero_pos[i] + Vector2(-18, -28), Vector2(80, 22), 14, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		main.hero_labels.append(name_label)

static func draw_dungeon_map(main) -> void:
	var room: Dictionary = DUNGEON_ROOMS[main.dungeon_room_index]
	var tint: Color = room.tint
	for y in range(96, 850, 48):
		for x in range(264, 1536, 48):
			var tile_index := int((x / 48 + y / 48 + main.dungeon_room_index) % GameData.FLOOR_TILES.size())
			var tile: Control = main.pixel_art(main.arena, GameData.floor_tile(tile_index), Vector2(x, y), Vector2(48, 48), tint)
			tile.modulate = Color(0.75 + main.dungeon_room_index * 0.05, 0.78, 0.86, 1.0)

	for x in range(264, 1536, 48):
		main.pixel_art(main.arena, GameData.prop_tile(1), Vector2(x, 96), Vector2(48, 48), Color("#24314a"))
		main.pixel_art(main.arena, GameData.prop_tile(0), Vector2(x, 816), Vector2(48, 48), Color("#24314a"))
	for y in range(144, 816, 48):
		main.pixel_art(main.arena, GameData.prop_tile(0), Vector2(264, y), Vector2(48, 48), Color("#24314a"))
		main.pixel_art(main.arena, GameData.prop_tile(0), Vector2(1488, y), Vector2(48, 48), Color("#24314a"))

	var props := [
		Vector2(410, 324), Vector2(552, 396), Vector2(684, 500), Vector2(848, 612),
		Vector2(984, 312), Vector2(1120, 456), Vector2(1248, 660), Vector2(1360, 300),
		Vector2(720, 218), Vector2(1040, 728), Vector2(1280, 200), Vector2(500, 710)
	]
	for i in range(props.size()):
		main.pixel_art(main.arena, GameData.prop_tile(2 + i), props[i], Vector2(48, 48), Color("#24314a"))

	main.room_label = main.label(main.arena, str(room.name), Vector2(650, 118), Vector2(300, 34), 26, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	main.room_goal_label = main.label(main.arena, "", Vector2(604, 154), Vector2(392, 28), 18, Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)
	var entry := ColorRect.new()
	entry.position = Vector2(266, 382)
	entry.size = Vector2(22, 132)
	entry.color = Color("#20304ddd")
	main.arena.add_child(entry)
	main.door_node = ColorRect.new()
	main.door_node.position = main.door_rect.position
	main.door_node.size = main.door_rect.size
	main.door_node.color = Color("#54302c") if not main.door_open else Color("#35d07f")
	main.arena.add_child(main.door_node)
	main.label(main.arena, "문", main.door_rect.position + Vector2(-8, 132), Vector2(72, 24), 16, Color("#c9d5ee"), HORIZONTAL_ALIGNMENT_CENTER)
	draw_room_minimap(main)

static func draw_room_minimap(main) -> void:
	var start := Vector2(620, 826)
	for i in range(DUNGEON_ROOMS.size()):
		var chip := ColorRect.new()
		chip.position = start + Vector2(i * 76, 0)
		chip.size = Vector2(54, 30)
		if i < main.dungeon_room_index:
			chip.color = Color("#2bb673cc")
		elif i == main.dungeon_room_index:
			chip.color = Color("#f0d25ccc")
		else:
			chip.color = Color("#33415ccc")
		main.arena.add_child(chip)
		main.label(main.arena, "%d" % (i + 1), chip.position, chip.size, 16, Color("#101725"), HORIZONTAL_ALIGNMENT_CENTER)

static func update(main, delta: float) -> void:
	if main.paused:
		update_ui(main)
		return
	TouchInput.update(main, delta)
	main.battle_time += delta
	main.wave = main.dungeon_room_index + 1
	for i in range(4):
		main.switch_cd[i] = maxf(0.0, main.switch_cd[i] - delta)

	var input_dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if input_dir.length() < 0.05 and main.touch_move_dir.length() > 0.05:
		input_dir = main.touch_move_dir
	if input_dir.length() > 0.05:
		var h := GameData.hero(main.party_indices[main.active_slot])
		main.hero_pos[main.active_slot] += input_dir.normalized() * float(h.speed) * delta
		TutorialFlow.mark(main, "move_seen")
	main.hero_pos[main.active_slot] = main.hero_pos[main.active_slot].clamp(ARENA_MIN, ARENA_MAX)

	update_party_ai_positions(main, delta)

	main.spawn_timer -= delta
	if main.spawn_timer <= 0.0:
		process_room_spawns(main)
		main.spawn_timer = maxf(float(BalanceTable.WAVE.spawn_min), float(BalanceTable.WAVE.spawn_base) - main.wave * float(BalanceTable.WAVE.spawn_per_wave))

	update_enemies(main, delta)
	update_projectiles(main, delta)
	update_effects(main, delta)
	update_floating_texts(main, delta)
	process_room_clear(main)

	main.attack_timer -= delta
	if main.attack_timer <= 0.0:
		for i in range(4):
			hit_nearest_enemy(main, i)
		main.attack_timer = 0.38

	update_hero_animations(main, delta, input_dir)

	if Input.is_action_just_pressed("dash"):
		dash_active(main)
	if Input.is_action_just_pressed("skill"):
		use_skill(main)

	if process_level_ups(main):
		return

	if main.hero_hp.max() <= 0.0:
		main.show_result(false)
		return
	if is_final_room(main) and main.boss_spawned and not main.boss_alive:
		main.show_result(true)
		return

	update_ui(main)

static func process_room_spawns(main) -> void:
	if main.room_clear:
		return
	if is_final_room(main):
		if not main.boss_spawned:
			spawn_boss(main)
		return
	if main.room_spawned < main.room_quota and main.enemies.size() < 7:
		spawn_enemy(main)

static func process_room_clear(main) -> void:
	if main.room_clear:
		if main.door_open and main.door_rect.has_point(main.hero_pos[main.active_slot] + Vector2(24, 28)):
			advance_room(main)
		return
	if is_final_room(main):
		return
	if main.room_spawned >= main.room_quota and main.enemies.is_empty():
		open_room_door(main)

static func is_final_room(main) -> bool:
	return main.dungeon_room_index >= DUNGEON_ROOMS.size() - 1

static func open_room_door(main) -> void:
	main.room_clear = true
	main.door_open = true
	if main.door_node and is_instance_valid(main.door_node):
		(main.door_node as ColorRect).color = Color("#35d07f")
	main.play_sfx("ui_confirm", -8.0, 0.0)
	create_floating_text(main, "방 클리어", Vector2(760, 238), Color("#ffd24a"), 34, Vector2(0, -18), 1.25)
	main.show_message("방 클리어 - 오른쪽 문으로 이동")

static func advance_room(main) -> void:
	main.dungeon_room_index = mini(main.dungeon_room_index + 1, DUNGEON_ROOMS.size() - 1)
	main.wave = main.dungeon_room_index + 1
	main.room_spawned = 0
	main.room_quota = int(DUNGEON_ROOMS[main.dungeon_room_index].quota)
	main.room_clear = false
	main.door_open = false
	main.boss_spawned = false
	main.boss_alive = false
	main.spawn_timer = 0.0
	main.enemies.clear()
	main.projectiles.clear()
	main.effects.clear()
	main.floating_texts.clear()
	for child in main.arena.get_children():
		child.queue_free()
	main.hero_pos.clear()
	main.hero_pos.append_array([Vector2(340, 430), Vector2(390, 494), Vector2(442, 430), Vector2(390, 366)])
	draw_dungeon_map(main)
	build_hero_nodes(main)
	main.play_sfx("ui_confirm", -8.0, 0.0)
	main.show_message("%s 진입" % str(DUNGEON_ROOMS[main.dungeon_room_index].name))

static func spawn_enemy(main) -> void:
	var kind := choose_enemy_kind(main)
	var spec: Dictionary = ENEMY_TYPES[kind]
	var pos := spawn_position(main)
	var hp: float = float(spec.hp) + main.wave * 5.0
	var frames := GameData.topdown_monster_frames(str(spec.get("asset", "")))
	var sprite_path := str(frames[0]) if not frames.is_empty() else GameData.enemy_sprite(spec.sprite)
	var node: Control = main.pixel_art(main.arena, sprite_path, pos, spec.size, spec.color)
	node.position = pos
	var hp_bar := create_enemy_hp_bar(main, pos, spec.size, false)
	main.room_spawned += 1
	main.enemies.append({
		"kind": kind,
		"name": str(spec.name),
		"node": node,
		"hp_bar": hp_bar.bar,
		"hp_fill": hp_bar.fill,
		"hp_bar_width": hp_bar.width,
		"pos": pos,
		"hp": hp,
		"max_hp": hp,
		"speed": float(spec.speed) + main.wave * 4.0,
		"damage": float(spec.damage),
		"range": float(spec.range),
		"xp": float(spec.xp),
		"attack_cd": randf_range(0.25, 0.9),
		"attack_interval": float(spec.attack_interval),
		"frames": frames,
		"frame_index": 0,
		"anim_time": randf_range(0.0, 0.25),
		"anim_fps": randf_range(7.0, 9.0),
		"is_boss": false
	})

static func spawn_boss(main) -> void:
	main.boss_spawned = true
	main.boss_alive = true
	var pos := Vector2(1188, 338)
	var frames := GameData.topdown_monster_frames(str(BalanceTable.BOSS.asset))
	var node: Control = main.pixel_art(main.arena, str(frames[0]), pos, Vector2(104, 104), Color("#ff395d"))
	node.position = pos
	var title: Label = main.label(main.arena, "균열 장군", pos + Vector2(-18, -30), Vector2(132, 24), 16, Color("#ffd24a"), HORIZONTAL_ALIGNMENT_CENTER)
	var hp_bar := create_enemy_hp_bar(main, pos, Vector2(104, 104), true)
	main.enemies.append({
		"kind": "boss",
		"name": "균열 장군",
		"node": node,
		"label": title,
		"hp_bar": hp_bar.bar,
		"hp_fill": hp_bar.fill,
		"hp_bar_width": hp_bar.width,
		"pos": pos,
		"hp": float(BalanceTable.BOSS.hp),
		"max_hp": float(BalanceTable.BOSS.hp),
		"speed": float(BalanceTable.BOSS.speed),
		"damage": float(BalanceTable.BOSS.damage),
		"range": float(BalanceTable.BOSS.range),
		"xp": float(BalanceTable.BOSS.xp),
		"attack_cd": 1.2,
		"attack_interval": float(BalanceTable.BOSS.attack_interval),
		"pattern_cd": float(BalanceTable.BOSS.pattern_cd),
		"phase": 1,
		"frames": frames,
		"frame_index": 0,
		"anim_time": 0.0,
		"anim_fps": 8.0,
		"is_boss": true
	})
	main.play_sfx("impact", -13.0, 0.06)
	main.show_message("보스 출현: 균열 장군")

static func choose_enemy_kind(main) -> String:
	if main.dungeon_room_index == 0 and main.room_spawned == 0:
		return "zombie"
	var room: Dictionary = DUNGEON_ROOMS[main.dungeon_room_index]
	var kinds: Array = room.kinds
	if kinds.is_empty():
		return "zombie"
	return str(kinds[randi() % kinds.size()])

static func choose_enemy_kind_legacy(wave: int) -> String:
	var roll := randf()
	if wave <= 1:
		return "zombie"
	if wave == 2:
		if roll < 0.20:
			return "shade_runner"
		return "orc_shaman" if roll < 0.48 else "zombie"
	if wave == 3:
		if roll < 0.18:
			return "shade_runner"
		if roll < 0.38:
			return "muddy"
		return "orc_shaman" if roll < 0.66 else "zombie"
	if roll < 0.18:
		return "shade_runner"
	if roll < 0.34:
		return "spore_bomber"
	if roll < 0.56:
		return "muddy"
	return "orc_shaman" if roll < 0.78 else "zombie"

static func spawn_position(main) -> Vector2:
	var side := randi() % 4
	var pos := Vector2.ZERO
	match side:
		0:
			pos = Vector2(randf_range(340, 1390), 168)
		1:
			pos = Vector2(1390, randf_range(190, 740))
		2:
			pos = Vector2(randf_range(340, 1390), 748)
		_:
			pos = Vector2(340, randf_range(190, 740))
	if pos.distance_to(main.hero_pos[main.active_slot]) < 260.0:
		pos.x = clampf(pos.x + 280.0, 340.0, 1390.0)
	return pos

static func update_enemies(main, delta: float) -> void:
	for enemy_index in range(main.enemies.size() - 1, -1, -1):
		if enemy_index >= main.enemies.size():
			continue
		var enemy: Dictionary = main.enemies[enemy_index]
		if enemy.is_boss:
			update_boss(main, enemy, delta)
		elif enemy.kind == "orc_shaman" or enemy.kind == "rift_eye":
			update_ranged_enemy(main, enemy, delta)
		elif enemy.kind == "shade_runner" or enemy.kind == "scarab_swarm":
			update_shade_runner(main, enemy, delta)
		elif enemy.kind == "spore_bomber" or enemy.kind == "crystal_slug":
			update_spore_bomber(main, enemy, delta)
		else:
			update_melee_enemy(main, enemy, delta)
		enemy.node.position = enemy.pos
		update_enemy_animation(main, enemy, delta)
		if enemy.has("label") and is_instance_valid(enemy.label):
			enemy.label.position = enemy.pos + Vector2(-18, -30)
		update_enemy_hp_bar(enemy)

static func update_enemy_animation(main, enemy: Dictionary, delta: float) -> void:
	var frames: Array = enemy.get("frames", [])
	if frames.size() < 2 or not is_instance_valid(enemy.node) or not (enemy.node is TextureRect):
		return
	enemy.anim_time = float(enemy.get("anim_time", 0.0)) + delta
	var frame_index: int = int(float(enemy.anim_time) * float(enemy.get("anim_fps", 8.0))) % frames.size()
	if frame_index == int(enemy.get("frame_index", 0)):
		return
	enemy.frame_index = frame_index
	(enemy.node as TextureRect).texture = main.texture_from_path(str(frames[frame_index]))

static func create_enemy_hp_bar(main, pos: Vector2, body_size: Vector2, is_boss: bool) -> Dictionary:
	var bar_width := 112.0 if is_boss else clampf(body_size.x + 10.0, 52.0, 84.0)
	var bar_height := 8.0 if is_boss else 6.0
	var bar := ColorRect.new()
	bar.size = Vector2(bar_width, bar_height)
	bar.color = Color("#101725dd")
	main.arena.add_child(bar)
	var fill := ColorRect.new()
	fill.position = Vector2(1, 1)
	fill.size = Vector2(bar_width - 2.0, bar_height - 2.0)
	fill.color = Color("#ff395d") if is_boss else Color("#72f0a8")
	bar.add_child(fill)
	var enemy := {"pos": pos, "hp": 1.0, "max_hp": 1.0, "hp_bar": bar, "hp_fill": fill, "hp_bar_width": bar_width}
	update_enemy_hp_bar(enemy)
	return {"bar": bar, "fill": fill, "width": bar_width}

static func update_enemy_hp_bar(enemy: Dictionary) -> void:
	if not enemy.has("hp_bar") or not is_instance_valid(enemy.hp_bar):
		return
	var width: float = float(enemy.get("hp_bar_width", 58.0))
	var bar: ColorRect = enemy.hp_bar
	bar.position = Vector2(enemy.pos.x + 20.0 - width * 0.5, enemy.pos.y - 12.0)
	if not enemy.has("hp_fill") or not is_instance_valid(enemy.hp_fill):
		return
	var ratio := clampf(float(enemy.hp) / maxf(1.0, float(enemy.max_hp)), 0.0, 1.0)
	(enemy.hp_fill as ColorRect).size.x = maxf(0.0, (width - 2.0) * ratio)

static func update_party_ai_positions(main, delta: float) -> void:
	for i in range(4):
		if i == main.active_slot:
			continue
		var preset := str(main.ai_presets[i]) if i < main.ai_presets.size() else "균형"
		var desired: Vector2 = ai_desired_position(main, i, preset)
		var follow_rate := 2.2
		if preset == "공격":
			follow_rate = 3.0 if not main.enemies.is_empty() else 2.4
		elif preset == "방어":
			follow_rate = 3.2
		main.hero_pos[i] = main.hero_pos[i].lerp(desired, delta * follow_rate).clamp(ARENA_MIN, ARENA_MAX)

static func ai_desired_position(main, slot: int, preset: String) -> Vector2:
	var active_pos: Vector2 = main.hero_pos[main.active_slot]
	var formation_offset := Vector2(cos(float(slot) * 2.1), sin(float(slot) * 2.1))
	if preset == "공격":
		var target_index := closest_enemy_index(main, main.hero_pos[slot])
		if target_index != -1:
			var target_pos: Vector2 = main.enemies[target_index].pos + Vector2(22, 22)
			var away_from_target := active_pos - target_pos
			if away_from_target.length() < 0.01:
				away_from_target = Vector2.RIGHT.rotated(float(slot))
			var flank := Vector2(-away_from_target.y, away_from_target.x).normalized() * (float(slot) - 1.5) * 22.0
			return target_pos + away_from_target.normalized() * 128.0 + flank
		return active_pos + formation_offset * 130.0
	if preset == "방어":
		var threat_index := closest_enemy_index(main, active_pos, 340.0)
		if threat_index != -1:
			var threat_pos: Vector2 = main.enemies[threat_index].pos + Vector2(22, 22)
			var threat_dir := threat_pos - active_pos
			if threat_dir.length() < 0.01:
				threat_dir = formation_offset
			var guard_line := threat_dir.normalized() * 72.0
			var guard_spread := Vector2(-threat_dir.y, threat_dir.x).normalized() * (float(slot) - 1.5) * 18.0
			return active_pos + guard_line + guard_spread
		return active_pos + formation_offset * 74.0
	return active_pos + formation_offset * 110.0

static func closest_enemy_index(main, pos: Vector2, max_distance: float = INF) -> int:
	var best := -1
	var best_dist := max_distance * max_distance
	for i in range(main.enemies.size()):
		var enemy_pos: Vector2 = main.enemies[i].pos
		var dist: float = enemy_pos.distance_squared_to(pos)
		if dist < best_dist:
			best = i
			best_dist = dist
	return best

static func update_hero_animations(main, delta: float, active_move_dir: Vector2 = Vector2.ZERO) -> void:
	if main.hero_anim.size() != main.hero_nodes.size():
		return
	for i in range(main.hero_nodes.size()):
		if not is_instance_valid(main.hero_nodes[i]):
			continue
		var state: Dictionary = main.hero_anim[i]
		var previous_pos: Vector2 = state.get("last_pos", main.hero_pos[i])
		var move_dir: Vector2 = main.hero_pos[i] - previous_pos
		if i == main.active_slot and active_move_dir.length() > 0.05:
			move_dir = active_move_dir

		var direction := str(state.get("direction", "down"))
		var flip_h := bool(state.get("flip_h", false))
		var moving: bool = move_dir.length() > 0.35
		if moving:
			if absf(move_dir.x) > absf(move_dir.y):
				direction = "side"
				flip_h = move_dir.x < 0.0
			elif move_dir.y < 0.0:
				direction = "up"
				flip_h = false
			else:
				direction = "down"
				flip_h = false
			state.anim_time = float(state.get("anim_time", 0.0)) + delta
		else:
			state.anim_time = 0.0

		state.attack_time = maxf(0.0, float(state.get("attack_time", 0.0)) - delta)
		var frames := GameData.hero_frames(str(state.get("asset_id", "luna")), direction)
		var frame_index := 0
		if moving and frames.size() > 1:
			frame_index = int(float(state.anim_time) * 9.0) % frames.size()
		var needs_texture := frame_index != int(state.get("frame_index", -1)) or direction != str(state.get("direction", ""))
		if needs_texture and main.hero_nodes[i] is TextureRect:
			(main.hero_nodes[i] as TextureRect).texture = main.texture_from_path(str(frames[frame_index]))
			(main.hero_nodes[i] as TextureRect).flip_h = flip_h

		var attack_strength: float = float(state.attack_time) / 0.22
		if attack_strength > 0.0:
			main.hero_nodes[i].scale = Vector2(1.0 + attack_strength * 0.12, 1.0 + attack_strength * 0.12)
			main.hero_nodes[i].modulate = Color(1.0 + attack_strength * 0.45, 1.0 + attack_strength * 0.34, 1.0 + attack_strength * 0.18, 1.0)
		else:
			main.hero_nodes[i].scale = Vector2.ONE
			main.hero_nodes[i].modulate = Color.WHITE

		main.hero_nodes[i].position = main.hero_pos[i]
		main.hero_labels[i].position = main.hero_pos[i] + Vector2(-8, -28)
		state.direction = direction
		state.flip_h = flip_h
		state.frame_index = frame_index
		state.last_pos = main.hero_pos[i]
		main.hero_anim[i] = state

static func trigger_hero_attack(main, slot: int) -> void:
	if slot < 0 or slot >= main.hero_anim.size():
		return
	var state: Dictionary = main.hero_anim[slot]
	state.attack_time = 0.22
	main.hero_anim[slot] = state

static func update_melee_enemy(main, enemy: Dictionary, delta: float) -> void:
	var target: int = closest_hero(main, enemy.pos)
	var dir: Vector2 = (main.hero_pos[target] - enemy.pos).normalized()
	enemy.pos = (enemy.pos + dir * float(enemy.speed) * delta).clamp(ARENA_MIN, ARENA_MAX)
	if enemy.pos.distance_to(main.hero_pos[target]) < float(enemy.range):
		damage_hero(main, target, float(enemy.damage) * delta)

static func update_ranged_enemy(main, enemy: Dictionary, delta: float) -> void:
	var target: int = closest_hero(main, enemy.pos)
	var to_target: Vector2 = main.hero_pos[target] - enemy.pos
	var distance: float = to_target.length()
	var dir := to_target.normalized()
	if distance < 220.0:
		enemy.pos = (enemy.pos - dir * float(enemy.speed) * delta).clamp(ARENA_MIN, ARENA_MAX)
	elif distance > 330.0:
		enemy.pos = (enemy.pos + dir * float(enemy.speed) * delta).clamp(ARENA_MIN, ARENA_MAX)
	enemy.attack_cd = maxf(0.0, float(enemy.attack_cd) - delta)
	if enemy.attack_cd <= 0.0 and distance <= float(enemy.range):
		fire_projectile(main, enemy.pos + Vector2(20, 20), main.hero_pos[target], 205.0, float(enemy.damage), Color("#b56cff"), true, 8.0)
		enemy.attack_cd = float(enemy.attack_interval)

static func update_shade_runner(main, enemy: Dictionary, delta: float) -> void:
	var target: int = closest_hero(main, enemy.pos)
	var to_target: Vector2 = main.hero_pos[target] - enemy.pos
	var dir := to_target.normalized()
	var flank := Vector2(-dir.y, dir.x) * sin(main.battle_time * 4.0) * 0.45
	enemy.pos = (enemy.pos + (dir + flank).normalized() * float(enemy.speed) * delta).clamp(ARENA_MIN, ARENA_MAX)
	if enemy.pos.distance_to(main.hero_pos[target]) < float(enemy.range):
		damage_hero(main, target, float(enemy.damage) * delta)

static func update_spore_bomber(main, enemy: Dictionary, delta: float) -> void:
	var target: int = closest_hero(main, enemy.pos)
	var to_target: Vector2 = main.hero_pos[target] - enemy.pos
	var distance: float = to_target.length()
	if distance > float(enemy.range):
		enemy.pos = (enemy.pos + to_target.normalized() * float(enemy.speed) * delta).clamp(ARENA_MIN, ARENA_MAX)
		return
	enemy.attack_cd = maxf(0.0, float(enemy.attack_cd) - delta)
	if enemy.attack_cd <= 0.0:
		create_area_effect(main, enemy.pos + Vector2(22, 20), 96.0, float(enemy.damage), Color("#d9f06a"), 0.34, true)
		enemy.xp = float(enemy.xp) * 0.5
		var index: int = main.enemies.find(enemy)
		if index != -1:
			damage_enemy(main, index, 9999.0)

static func update_boss(main, enemy: Dictionary, delta: float) -> void:
	var target: int = closest_hero(main, enemy.pos)
	var hp_ratio: float = float(enemy.hp) / float(enemy.max_hp)
	enemy.phase = 3 if hp_ratio < 0.34 else 2 if hp_ratio < 0.67 else 1
	var dir: Vector2 = (main.hero_pos[target] - enemy.pos).normalized()
	var pace: float = float(enemy.speed) + int(enemy.phase) * 7.0
	if enemy.pattern_cd < 0.55:
		pace *= 0.45
	enemy.pos = (enemy.pos + dir * pace * delta).clamp(ARENA_MIN, ARENA_MAX)
	if enemy.pos.distance_to(main.hero_pos[target]) < float(enemy.range):
		damage_hero(main, target, float(enemy.damage) * delta)
	enemy.pattern_cd = maxf(0.0, float(enemy.pattern_cd) - delta)
	if enemy.pattern_cd <= 0.0:
		boss_pattern(main, enemy)
		enemy.pattern_cd = 2.8 - enemy.phase * 0.32

static func boss_pattern(main, enemy: Dictionary) -> void:
	if int(enemy.phase) == 1:
		for slot in range(4):
			fire_projectile(main, enemy.pos + Vector2(48, 52), main.hero_pos[slot], 230.0, 18.0, Color("#ff395d"), true, 10.0)
	elif int(enemy.phase) == 2:
		for angle in range(0, 360, 45):
			var target: Vector2 = enemy.pos + Vector2.RIGHT.rotated(deg_to_rad(angle)) * 180.0
			fire_projectile(main, enemy.pos + Vector2(48, 52), target, 255.0, 16.0, Color("#ff9b3d"), true, 9.0)
	else:
		create_area_effect(main, enemy.pos + Vector2(48, 52), 138.0, 28.0, Color("#8d5cff"), 0.65, true)
		for angle in range(45, 360, 90):
			var target: Vector2 = enemy.pos + Vector2.RIGHT.rotated(deg_to_rad(angle)) * 220.0
			fire_projectile(main, enemy.pos + Vector2(48, 52), target, 210.0, 12.0, Color("#8d5cff"), true, 8.0)

static func closest_hero(main, pos: Vector2) -> int:
	var best := 0
	var best_dist := INF
	for i in range(main.hero_pos.size()):
		var dist: float = pos.distance_squared_to(main.hero_pos[i])
		if dist < best_dist:
			best = i
			best_dist = dist
	return best

static func hit_nearest_enemy(main, slot: int) -> void:
	if main.enemies.is_empty():
		return
	var best_index := -1
	var best_dist := INF
	for i in range(main.enemies.size()):
		var dist: float = main.enemies[i].pos.distance_squared_to(main.hero_pos[slot])
		if dist < best_dist:
			best_index = i
			best_dist = dist
	if best_index == -1 or best_dist > 420.0 * 420.0:
		return
	trigger_hero_attack(main, slot)
	var origin: Vector2 = main.hero_pos[slot] + Vector2(20, 20)
	var target_pos: Vector2 = main.enemies[best_index].pos + Vector2(20, 20)
	var tag: String = main.hero_tags[slot]
	var fusion: Dictionary = FUSION_ATTACKS.get(tag, {})
	if fusion.is_empty():
		var damage: float = 12.0 + main.hero_levels[slot] * 3.0
		if slot == main.active_slot:
			damage *= 1.35
			main.play_sfx("attack", -18.0, 0.05)
		fire_projectile(main, origin, target_pos, 540.0, damage, GameData.color_for_tag(tag), false, 7.0)
	else:
		if slot == main.active_slot:
			main.play_sfx("fusion", -12.0, 0.02)
		fire_fusion_attack(main, slot, origin, target_pos, fusion)

static func distribute_xp(main, amount: float) -> void:
	for i in range(4):
		var ratio: float = float(BalanceTable.XP_SPLIT.active) if i == main.active_slot else float(BalanceTable.XP_SPLIT.ally)
		main.hero_xp[i] += amount * ratio

static func process_level_ups(main) -> bool:
	for i in range(4):
		while main.hero_xp[i] >= main.hero_next_xp[i]:
			main.hero_xp[i] -= main.hero_next_xp[i]
			main.hero_next_xp[i] += float(BalanceTable.LEVEL_XP.step)
			main.hero_levels[i] += 1
			if i == main.active_slot:
				show_level_up(main, i)
				return true
			auto_choose_level(main, i)
	return false

static func auto_choose_level(main, slot: int) -> void:
	var choices := pick_level_choices()
	apply_level_choice(main, slot, choices[0])

static func try_switch(main, slot: int) -> void:
	if slot == main.active_slot or main.switch_cd[slot] > 0.0:
		return
	main.switch_cd[main.active_slot] = 12.0
	main.active_slot = slot
	main.hero_hp[main.active_slot] = minf(main.hero_hp[main.active_slot] + 12.0, float(GameData.hero(main.party_indices[main.active_slot]).hp))
	TouchInput.did_switch(main)
	main.play_sfx("ui_confirm", -10.0, 0.02)
	TutorialFlow.mark(main, "switch_seen")
	update_ui(main)

static func dash_active(main) -> void:
	if not main.battle_running or main.paused or not TouchInput.can_dash(main):
		return
	var dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if dir.length() < 0.05 and main.touch_move_dir.length() > 0.05:
		dir = main.touch_move_dir
	if dir.length() < 0.05:
		dir = Vector2.RIGHT
	main.hero_pos[main.active_slot] = (main.hero_pos[main.active_slot] + dir.normalized() * 150.0).clamp(ARENA_MIN, ARENA_MAX)
	TouchInput.did_dash(main)
	main.play_sfx("dash", -12.0, 0.08)
	TutorialFlow.mark(main, "dash_seen")

static func use_skill(main, skill_index: int = 0) -> void:
	if not main.battle_running or main.paused or not TouchInput.can_skill(main, skill_index):
		return
	var origin: Vector2 = main.hero_pos[main.active_slot]
	var tag: String = active_skill_tag(main, skill_index)
	var radius: float = 172.0 + skill_index * 18.0
	var damage: float = 34.0 + main.hero_levels[main.active_slot] * 3.0 + skill_index * 4.0
	create_area_effect(main, origin + Vector2(22, 22), radius, damage, GameData.color_for_tag(tag), 0.42, false, {"effect": GameData.effect_for_tag(tag)})
	TouchInput.did_skill(main, skill_index)
	main.play_sfx("skill", -10.0, 0.04)

static func active_skill_tag(main, skill_index: int) -> String:
	if main.active_slot >= 0 and main.active_slot < main.hero_skill_tags.size():
		var tags: Array = main.hero_skill_tags[main.active_slot]
		if skill_index >= 0 and skill_index < tags.size():
			return str(tags[skill_index])
	if main.active_slot >= 0 and main.active_slot < main.hero_tags.size():
		return str(main.hero_tags[main.active_slot])
	return "화염"

static func update_ui(main) -> void:
	if main.timer_label:
		main.timer_label.text = "방 %d/%d" % [main.dungeon_room_index + 1, main.dungeon_room_count]
	if main.wave_label:
		main.wave_label.text = "보스전" if main.boss_alive else str(DUNGEON_ROOMS[main.dungeon_room_index].name)
	if main.room_goal_label:
		if is_final_room(main):
			main.room_goal_label.text = "균열 장군 처치" if main.boss_alive else "제단 진입 중"
		elif main.room_clear:
			main.room_goal_label.text = "문 열림 - 오른쪽으로 이동"
		else:
			main.room_goal_label.text = "남은 적 %d / 처치 %d" % [maxi(0, main.room_quota - main.room_spawned + main.enemies.size()), main.room_spawned]
	if main.xp_bar:
		main.xp_bar.max_value = main.hero_next_xp[main.active_slot]
		main.xp_bar.value = main.hero_xp[main.active_slot]
	for i in range(main.party_buttons.size()):
		var h := GameData.hero(main.party_indices[i])
		var hp_ratio: float = main.hero_hp[i] / float(h.hp)
		var marker := "◀ " if i == main.active_slot else ""
		var cd := "" if main.switch_cd[i] <= 0.0 else " CD%d" % ceili(main.switch_cd[i])
		main.party_buttons[i].text = "%s%d %s  HP %d%%%s" % [marker, i + 1, h.name, int(hp_ratio * 100.0), cd]
		main.party_buttons[i].disabled = i != main.active_slot and main.switch_cd[i] > 0.0

static func show_level_up(main, slot: int) -> void:
	main.battle_running = false
	main.play_sfx("level_up", -8.0, 0.0)
	var overlay := ColorRect.new()
	overlay.name = "LevelOverlay"
	overlay.position = Vector2.ZERO
	overlay.size = main.VIEW_SIZE
	overlay.color = Color("#050812cc")
	main.battle_root.add_child(overlay)

	var box: Control = main.framed_panel(overlay, Vector2(190, 110), Vector2(1220, 650), Color("#111827ee"), "fantasy_panel", Color("#d2bc82"), 16)
	var h := GameData.hero(main.party_indices[slot])
	main.label(box, "LEVEL UP - %s 선택 중" % h.name, Vector2(0, 26), Vector2(1220, 54), 34, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	main.divider(box, Vector2(410, 82), Vector2(400, 26), Color("#d2bc82"))
	var choices := TutorialFlow.maybe_force_fusion_choice(main, slot, pick_level_choices())
	for i in range(3):
		var c: Dictionary = choices[i]
		var card: Button = main.button(box, "", Vector2(95 + i * 360, 130), Vector2(310, 360), Callable(main, "choose_level").bind(c, overlay, slot), 18, Color("#1c2940"))
		main.pixel_art(card, GameData.icon_for_tag(c.tag), Vector2(100, 46), Vector2(110, 110), GameData.color_for_tag(c.tag))
		main.label(card, c.name, Vector2(18, 184), Vector2(274, 36), 26, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		main.tag_chip(card, c.kind + " / " + c.tag, Vector2(80, 232), GameData.color_for_tag(c.tag))
		main.label(card, c.desc, Vector2(26, 286), Vector2(258, 40), 18, Color("#c8d4ee"), HORIZONTAL_ALIGNMENT_CENTER)

	var fusion := GameData.fusion_name(main.hero_tags[slot], choices[0].tag)
	var fusion_text := "융합 가능: %s + %s → %s" % [main.hero_tags[slot], choices[0].tag, fusion] if fusion != "" else "융합 후보를 더 모으면 태그 조합이 열립니다."
	main.label(box, fusion_text, Vector2(110, 532), Vector2(800, 42), 24, Color("#ffd24a"))
	main.button(box, "추천 자동 선택", Vector2(960, 526), Vector2(200, 54), Callable(main, "choose_level").bind(choices[0], overlay, slot), 20, Color("#f05a28"), "button_red")
	TutorialFlow.on_level_up_shown(main)

static func pick_level_choices() -> Array:
	var pool := GameData.LEVEL_CHOICES.duplicate()
	pool.shuffle()
	return [pool[0], pool[1], pool[2]]

static func choose_level(main, choice: Dictionary, overlay_node: Control, slot: int) -> void:
	apply_level_choice(main, slot, choice)
	overlay_node.queue_free()
	main.battle_running = true

static func apply_level_choice(main, slot: int, choice: Dictionary) -> void:
	var fusion := GameData.fusion_name(main.hero_tags[slot], choice.tag)
	if fusion != "":
		main.play_sfx("fusion", -8.0, 0.0)
		if slot == main.active_slot:
			TutorialFlow.on_fusion(main, fusion)
	else:
		main.play_sfx("ui_confirm", -10.0, 0.02)
	main.hero_tags[slot] = choice.tag if fusion == "" else fusion
	add_skill_tag(main, slot, main.hero_tags[slot])
	if slot == main.active_slot:
		TouchInput.refresh_skill_buttons(main)

static func add_skill_tag(main, slot: int, tag: String) -> void:
	while main.hero_skill_tags.size() <= slot:
		main.hero_skill_tags.append([])
	while main.hero_skill_cooldowns.size() <= slot:
		main.hero_skill_cooldowns.append([])
	var tags: Array = main.hero_skill_tags[slot]
	if not tags.has(tag):
		tags.append(tag)
	var cooldowns: Array = main.hero_skill_cooldowns[slot]
	while cooldowns.size() < tags.size():
		cooldowns.append(0.0)
	main.hero_skill_tags[slot] = tags
	main.hero_skill_cooldowns[slot] = cooldowns

static func fire_fusion_attack(main, slot: int, origin: Vector2, target_pos: Vector2, fusion: Dictionary) -> void:
	var mode: String = fusion.mode
	var effect_name := GameData.effect_for_tag(main.hero_tags[slot])
	if mode == "gravity":
		create_area_effect(main, target_pos, float(fusion.radius), float(fusion.damage) + main.hero_levels[slot] * 2.0, fusion.color, 0.75, false, {"slow": 0.42, "effect": effect_name})
	elif mode == "splash":
		fire_projectile(main, origin, target_pos, 500.0, float(fusion.damage), fusion.color, false, 10.0, float(fusion.radius))
	elif mode == "rail":
		create_rail_attack(main, origin, target_pos, float(fusion.damage) + main.hero_levels[slot] * 2.0, fusion.color)
	elif mode == "chain":
		create_chain_attack(main, origin, target_pos, float(fusion.damage), fusion.color, float(fusion.radius))
	elif mode == "summon":
		create_summon_attack(main, origin, target_pos, float(fusion.damage), fusion.color)
	elif mode == "guard":
		create_guard_attack(main, slot, origin, float(fusion.radius), float(fusion.damage), fusion.color)
	else:
		create_area_effect(main, origin, float(fusion.radius), float(fusion.damage), fusion.color, 0.32, false, {"effect": effect_name})

static func fire_projectile(main, origin: Vector2, target: Vector2, speed: float, damage: float, color: Color, hostile: bool, radius: float, splash_radius: float = 0.0) -> void:
	var node := ColorRect.new()
	node.position = origin
	node.size = Vector2(radius * 2.0, radius * 2.0)
	node.color = color
	main.arena.add_child(node)
	var dir := (target - origin).normalized()
	main.projectiles.append({
		"node": node,
		"pos": origin,
		"velocity": dir * speed,
		"damage": damage,
		"hostile": hostile,
		"radius": radius,
		"splash_radius": splash_radius,
		"life": 1.8
	})

static func update_projectiles(main, delta: float) -> void:
	for i in range(main.projectiles.size() - 1, -1, -1):
		var projectile: Dictionary = main.projectiles[i]
		projectile.life = float(projectile.life) - delta
		projectile.pos += projectile.velocity * delta
		projectile.node.position = projectile.pos
		var consumed: bool = projectile.life <= 0.0 or not Rect2(ARENA_MIN - Vector2(40, 40), ARENA_MAX - ARENA_MIN + Vector2(80, 80)).has_point(projectile.pos)
		if not consumed:
			if projectile.hostile:
				consumed = hit_hero_with_projectile(main, projectile)
			else:
				consumed = hit_enemy_with_projectile(main, projectile)
		if consumed:
			if is_instance_valid(projectile.node):
				projectile.node.queue_free()
			main.projectiles.remove_at(i)

static func hit_hero_with_projectile(main, projectile: Dictionary) -> bool:
	for slot in range(main.hero_pos.size()):
		if projectile.pos.distance_to(main.hero_pos[slot] + Vector2(22, 22)) <= float(projectile.radius) + 22.0:
			damage_hero(main, slot, float(projectile.damage))
			return true
	return false

static func hit_enemy_with_projectile(main, projectile: Dictionary) -> bool:
	for i in range(main.enemies.size() - 1, -1, -1):
		if projectile.pos.distance_to(main.enemies[i].pos + Vector2(20, 20)) <= float(projectile.radius) + 24.0:
			damage_enemy(main, i, float(projectile.damage))
			if float(projectile.splash_radius) > 0.0:
				create_area_effect(main, projectile.pos, float(projectile.splash_radius), float(projectile.damage) * 0.55, projectile.node.color, 0.24, false)
			return true
	return false

static func create_area_effect(main, pos: Vector2, radius: float, damage: float, color: Color, life: float, hostile: bool, meta: Dictionary = {}) -> void:
	var frames: Array = GameData.effect_frames(str(meta.get("effect", "")))
	var node: Control
	if frames.is_empty():
		var color_node := ColorRect.new()
		color_node.color = Color(color.r, color.g, color.b, 0.34)
		node = color_node
	else:
		var texture_node := TextureRect.new()
		texture_node.texture = main.texture_from_path(str(frames[0]))
		texture_node.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		texture_node.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
		texture_node.modulate = Color(color.r, color.g, color.b, 0.82)
		node = texture_node
	node.position = pos - Vector2(radius, radius)
	node.size = Vector2(radius * 2.0, radius * 2.0)
	main.arena.add_child(node)
	if hostile:
		for slot in range(main.hero_pos.size()):
			if damage > 0.0 and pos.distance_to(main.hero_pos[slot] + Vector2(22, 22)) <= radius:
				damage_hero(main, slot, damage)
	else:
		for i in range(main.enemies.size() - 1, -1, -1):
			if damage > 0.0 and pos.distance_to(main.enemies[i].pos + Vector2(20, 20)) <= radius:
				if meta.has("slow"):
					main.enemies[i].speed = maxf(18.0, float(main.enemies[i].speed) * float(meta["slow"]))
				damage_enemy(main, i, damage)
	main.effects.append({"node": node, "life": life, "duration": life, "frames": frames, "frame_index": 0})

static func update_effects(main, delta: float) -> void:
	for i in range(main.effects.size() - 1, -1, -1):
		main.effects[i].life = float(main.effects[i].life) - delta
		var frames: Array = main.effects[i].get("frames", [])
		if not frames.is_empty() and is_instance_valid(main.effects[i].node):
			var duration: float = maxf(0.01, float(main.effects[i].duration))
			var progress: float = clampf(1.0 - float(main.effects[i].life) / duration, 0.0, 0.999)
			var frame_index: int = mini(int(progress * frames.size()), frames.size() - 1)
			if frame_index != int(main.effects[i].frame_index):
				main.effects[i].frame_index = frame_index
				(main.effects[i].node as TextureRect).texture = main.texture_from_path(str(frames[frame_index]))
		if main.effects[i].life <= 0.0:
			if is_instance_valid(main.effects[i].node):
				main.effects[i].node.queue_free()
			main.effects.remove_at(i)

static func create_floating_text(main, text: String, pos: Vector2, color: Color, font_size: int = 22, velocity: Vector2 = Vector2(0, -34), life: float = 0.72) -> void:
	if main.arena == null or not is_instance_valid(main.arena):
		return
	var label := Label.new()
	label.text = text
	label.position = pos
	label.size = Vector2(180, 42)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.add_theme_color_override("font_shadow_color", Color("#101725dd"))
	label.add_theme_constant_override("shadow_offset_x", 2)
	label.add_theme_constant_override("shadow_offset_y", 2)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	main.arena.add_child(label)
	main.floating_texts.append({"node": label, "life": life, "duration": life, "velocity": velocity})

static func update_floating_texts(main, delta: float) -> void:
	for i in range(main.floating_texts.size() - 1, -1, -1):
		var item: Dictionary = main.floating_texts[i]
		item.life = float(item.life) - delta
		if is_instance_valid(item.node):
			item.node.position += item.velocity * delta
			var duration: float = maxf(0.01, float(item.duration))
			var alpha := clampf(float(item.life) / duration, 0.0, 1.0)
			item.node.modulate = Color(1.0, 1.0, 1.0, alpha)
		if float(item.life) <= 0.0:
			if is_instance_valid(item.node):
				item.node.queue_free()
			main.floating_texts.remove_at(i)

static func create_rail_attack(main, origin: Vector2, target: Vector2, damage: float, color: Color) -> void:
	var dir := (target - origin).normalized()
	var center := origin + dir * 210.0
	var node := ColorRect.new()
	node.position = center - Vector2(200, 6)
	node.size = Vector2(400, 12)
	node.rotation = dir.angle()
	node.color = Color(color.r, color.g, color.b, 0.72)
	main.arena.add_child(node)
	for i in range(main.enemies.size() - 1, -1, -1):
		var to_enemy: Vector2 = main.enemies[i].pos + Vector2(20, 20) - origin
		var along := to_enemy.dot(dir)
		var lateral := absf(to_enemy.cross(dir))
		if along > 0.0 and along < 430.0 and lateral < 34.0:
			damage_enemy(main, i, damage)
	main.effects.append({"node": node, "life": 0.18})

static func create_chain_attack(main, origin: Vector2, target: Vector2, damage: float, color: Color, radius: float) -> void:
	var hits := 0
	var chain_origin := target
	while hits < 3:
		var best_index := -1
		var best_dist := INF
		for i in range(main.enemies.size()):
			var dist: float = main.enemies[i].pos.distance_squared_to(chain_origin)
			if dist < best_dist and dist <= radius * radius:
				best_index = i
				best_dist = dist
		if best_index == -1:
			break
		chain_origin = main.enemies[best_index].pos
		damage_enemy(main, best_index, damage * (1.0 - hits * 0.18))
		create_area_effect(main, chain_origin + Vector2(20, 20), 34.0, 0.0, color, 0.12, false, {"effect": "arcane"})
		hits += 1
	if hits == 0:
		fire_projectile(main, origin, target, 560.0, damage, color, false, 7.0)

static func create_summon_attack(main, origin: Vector2, target: Vector2, damage: float, color: Color) -> void:
	for angle in [0.0, 120.0, 240.0]:
		var offset := Vector2.RIGHT.rotated(deg_to_rad(angle)) * 46.0
		fire_projectile(main, origin + offset, target + offset * 0.25, 450.0, damage * 0.72, color, false, 8.0)
	create_area_effect(main, origin, 62.0, damage * 0.35, color, 0.24, false, {"effect": "arcane"})

static func create_guard_attack(main, slot: int, origin: Vector2, radius: float, damage: float, color: Color) -> void:
	main.invuln_timer = maxf(main.invuln_timer, 0.45)
	main.hero_hp[slot] = minf(main.hero_hp[slot] + 5.0, float(GameData.hero(main.party_indices[slot]).hp))
	create_area_effect(main, origin + Vector2(22, 22), radius, damage, color, 0.32, false, {"effect": "arcane"})

static func damage_enemy(main, index: int, damage: float) -> void:
	if index < 0 or index >= main.enemies.size():
		return
	main.enemies[index].hp -= damage
	update_enemy_hp_bar(main.enemies[index])
	if damage > 0.0:
		main.play_sfx("hit", -20.0, 0.08)
		create_floating_text(main, "-%d" % maxi(1, roundi(damage)), main.enemies[index].pos + Vector2(-54, -34), Color("#ffe082"), 21)
	if main.enemies[index].hp > 0.0:
		return
	var defeated: Dictionary = main.enemies[index]
	if (defeated.kind == "spore_bomber" or defeated.kind == "crystal_slug") and damage > 0.0:
		create_area_effect(main, defeated.pos + Vector2(22, 20), 74.0, 0.0, Color("#d9f06a"), 0.20, false, {"effect": "arcane"})
	if defeated.has("label") and is_instance_valid(defeated.label):
		defeated.label.queue_free()
	if defeated.has("hp_bar") and is_instance_valid(defeated.hp_bar):
		defeated.hp_bar.queue_free()
	if is_instance_valid(defeated.node):
		defeated.node.queue_free()
	if defeated.is_boss:
		main.boss_alive = false
		main.play_sfx("victory", -6.0, 0.0)
	create_floating_text(main, "+%d XP" % roundi(float(defeated.xp)), defeated.pos + Vector2(-58, -64), Color("#72f0a8"), 18, Vector2(0, -26), 0.82)
	distribute_xp(main, float(defeated.xp))
	main.enemies.remove_at(index)

static func damage_hero(main, slot: int, damage: float) -> void:
	if main.invuln_timer > 0.0 and slot == main.active_slot:
		return
	main.hero_hp[slot] = maxf(0.0, main.hero_hp[slot] - damage)
	if damage >= 4.0:
		create_floating_text(main, "-%d" % maxi(1, roundi(damage)), main.hero_pos[slot] + Vector2(-48, -42), Color("#ff6b6b"), 20)
	if slot == main.active_slot:
		var hero: Dictionary = GameData.hero(main.party_indices[slot])
		var hp_ratio: float = main.hero_hp[slot] / float(hero.hp)
		if hp_ratio < 0.25 and not main.low_hp_warned:
			main.low_hp_warned = true
			main.play_sfx("low_hp", -9.0, 0.0)
