extends RefCounted

const GameData := preload("res://scripts/game_data.gd")
const TouchInput := preload("res://scripts/touch_input.gd")
const BATTLE_DURATION := 150.0
const ARENA_MIN := Vector2(270, 112)
const ARENA_MAX := Vector2(1470, 806)

const ENEMY_TYPES := {
	"zombie": {
		"name": "좀비 돌격병",
		"sprite": 1,
		"color": Color("#d74848"),
		"size": Vector2(38, 38),
		"hp": 24.0,
		"speed": 106.0,
		"damage": 15.0,
		"range": 36.0,
		"xp": 18.0,
		"attack_interval": 0.25
	},
	"orc_shaman": {
		"name": "오크 주술사",
		"sprite": 4,
		"color": Color("#b56cff"),
		"size": Vector2(42, 44),
		"hp": 34.0,
		"speed": 82.0,
		"damage": 11.0,
		"range": 305.0,
		"xp": 26.0,
		"attack_interval": 1.35
	},
	"muddy": {
		"name": "진흙 탱커",
		"sprite": 5,
		"color": Color("#8f6a4c"),
		"size": Vector2(50, 48),
		"hp": 78.0,
		"speed": 50.0,
		"damage": 20.0,
		"range": 44.0,
		"xp": 36.0,
		"attack_interval": 0.42
	}
}

const FUSION_ATTACKS := {
	"작열 중력장": {"mode": "gravity", "color": Color("#ff7a45"), "damage": 11.0, "radius": 122.0},
	"번지는 화염": {"mode": "splash", "color": Color("#ff4d2e"), "damage": 28.0, "radius": 82.0},
	"용암 레일": {"mode": "rail", "color": Color("#ffb238"), "damage": 34.0, "radius": 30.0},
	"별핵 창": {"mode": "rail", "color": Color("#8fc7ff"), "damage": 32.0, "radius": 26.0},
	"반사 레일건": {"mode": "chain", "color": Color("#ffe65c"), "damage": 27.0, "radius": 170.0},
	"궤도 정령": {"mode": "summon", "color": Color("#42d787"), "damage": 24.0, "radius": 132.0},
	"수호 토템": {"mode": "guard", "color": Color("#4bd0d9"), "damage": 20.0, "radius": 118.0}
}

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

	draw_dungeon_map(main)

	var top: Panel = main.panel(root, Vector2(520, 18), Vector2(560, 54), Color("#111827d8"))
	main.timer_label = main.label(top, "05:32", Vector2(16, 8), Vector2(110, 34), 20)
	main.wave_label = main.label(top, "웨이브 1/5", Vector2(134, 8), Vector2(142, 34), 20)
	main.xp_bar = ProgressBar.new()
	main.xp_bar.position = Vector2(292, 13)
	main.xp_bar.size = Vector2(210, 24)
	main.xp_bar.max_value = main.hero_next_xp[main.active_slot]
	main.xp_bar.value = main.hero_xp[main.active_slot]
	top.add_child(main.xp_bar)

	var party_panel: Panel = main.panel(root, Vector2(22, 112), Vector2(222, 282), Color("#111827e8"))
	main.label(party_panel, "파티", Vector2(16, 8), Vector2(80, 28), 20)
	for i in range(4):
		var b: Button = main.button(party_panel, "", Vector2(14, 46 + i * 56), Vector2(194, 46), Callable(main, "try_switch").bind(i), 16, Color("#24314a"))
		main.party_buttons.append(b)

	TouchInput.build_controls(main, root)

	main.battle_time = 0.0
	main.wave = 1
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
	main.hero_next_xp.append_array([80.0, 80.0, 80.0, 80.0])
	main.hero_tags = ["", "", "", ""]
	for i in range(4):
		var h := GameData.hero(main.party_indices[i])
		main.hero_hp.append(float(h.hp))
		main.hero_tags[i] = h.tag
		var body: Control = main.pixel_art(main.arena, h.sprite, main.hero_pos[i], Vector2(48, 56), Color(h.color))
		body.position = main.hero_pos[i]
		main.hero_nodes.append(body)
		var name_label: Label = main.label(main.arena, h.name, main.hero_pos[i] + Vector2(-18, -28), Vector2(80, 22), 14, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		main.hero_labels.append(name_label)

	main.battle_running = true
	update_ui(main)

static func draw_dungeon_map(main) -> void:
	for y in range(96, 850, 48):
		for x in range(264, 1536, 48):
			var tile_index := int((x / 48 + y / 48) % GameData.FLOOR_TILES.size())
			main.pixel_art(main.arena, GameData.floor_tile(tile_index), Vector2(x, y), Vector2(48, 48), Color("#16243a"))

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

static func update(main, delta: float) -> void:
	if main.paused:
		update_ui(main)
		return
	TouchInput.update(main, delta)
	main.battle_time += delta
	main.wave = clampi(1 + int(main.battle_time / 28.0), 1, 5)
	for i in range(4):
		main.switch_cd[i] = maxf(0.0, main.switch_cd[i] - delta)

	var input_dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if input_dir.length() < 0.05 and main.touch_move_dir.length() > 0.05:
		input_dir = main.touch_move_dir
	if input_dir.length() > 0.05:
		var h := GameData.hero(main.party_indices[main.active_slot])
		main.hero_pos[main.active_slot] += input_dir.normalized() * float(h.speed) * delta
	main.hero_pos[main.active_slot] = main.hero_pos[main.active_slot].clamp(ARENA_MIN, ARENA_MAX)

	for i in range(4):
		if i == main.active_slot:
			continue
		var desired: Vector2 = main.hero_pos[main.active_slot] + Vector2(cos(float(i) * 2.1), sin(float(i) * 2.1)) * 110.0
		main.hero_pos[i] = main.hero_pos[i].lerp(desired, delta * 2.2)

	if main.wave >= 5 and not main.boss_spawned:
		spawn_boss(main)
	main.spawn_timer -= delta
	if main.spawn_timer <= 0.0:
		if main.wave < 5 or main.enemies.size() < 10:
			spawn_enemy(main)
		main.spawn_timer = maxf(0.35, 1.35 - main.wave * 0.12)

	update_enemies(main, delta)
	update_projectiles(main, delta)
	update_effects(main, delta)

	main.attack_timer -= delta
	if main.attack_timer <= 0.0:
		for i in range(4):
			hit_nearest_enemy(main, i)
		main.attack_timer = 0.38

	for i in range(main.hero_nodes.size()):
		main.hero_nodes[i].position = main.hero_pos[i]
		main.hero_labels[i].position = main.hero_pos[i] + Vector2(-20, -28)

	if Input.is_action_just_pressed("dash"):
		dash_active(main)
	if Input.is_action_just_pressed("skill"):
		use_skill(main)

	if process_level_ups(main):
		return

	if main.hero_hp.max() <= 0.0:
		main.show_result(false)
		return
	if main.boss_spawned and not main.boss_alive:
		main.show_result(true)
		return

	update_ui(main)

static func spawn_enemy(main) -> void:
	var kind := choose_enemy_kind(main.wave)
	var spec: Dictionary = ENEMY_TYPES[kind]
	var pos := spawn_position()
	var hp: float = float(spec.hp) + main.wave * 5.0
	var node: Control = main.pixel_art(main.arena, GameData.enemy_sprite(spec.sprite), pos, spec.size, spec.color)
	node.position = pos
	main.enemies.append({
		"kind": kind,
		"node": node,
		"pos": pos,
		"hp": hp,
		"max_hp": hp,
		"speed": float(spec.speed) + main.wave * 4.0,
		"damage": float(spec.damage),
		"range": float(spec.range),
		"xp": float(spec.xp),
		"attack_cd": randf_range(0.25, 0.9),
		"attack_interval": float(spec.attack_interval),
		"is_boss": false
	})

static func spawn_boss(main) -> void:
	main.boss_spawned = true
	main.boss_alive = true
	var pos := Vector2(1250, 210)
	var node: Control = main.pixel_art(main.arena, GameData.enemy_sprite(3), pos, Vector2(96, 104), Color("#ff395d"))
	node.position = pos
	var title: Label = main.label(main.arena, "균열 장군", pos + Vector2(-18, -30), Vector2(132, 24), 16, Color("#ffd24a"), HORIZONTAL_ALIGNMENT_CENTER)
	main.enemies.append({
		"kind": "boss",
		"name": "균열 장군",
		"node": node,
		"label": title,
		"pos": pos,
		"hp": 780.0,
		"max_hp": 780.0,
		"speed": 58.0,
		"damage": 28.0,
		"range": 58.0,
		"xp": 180.0,
		"attack_cd": 1.2,
		"attack_interval": 1.6,
		"pattern_cd": 2.0,
		"phase": 1,
		"is_boss": true
	})
	main.show_message("보스 출현: 균열 장군")

static func choose_enemy_kind(wave: int) -> String:
	var roll := randf()
	if wave <= 1:
		return "zombie"
	if wave == 2:
		return "orc_shaman" if roll < 0.28 else "zombie"
	if wave == 3:
		if roll < 0.22:
			return "muddy"
		return "orc_shaman" if roll < 0.52 else "zombie"
	if roll < 0.30:
		return "muddy"
	return "orc_shaman" if roll < 0.62 else "zombie"

static func spawn_position() -> Vector2:
	var side := randi() % 4
	var pos := Vector2.ZERO
	match side:
		0:
			pos = Vector2(randf_range(270, 1480), 90)
		1:
			pos = Vector2(1520, randf_range(120, 790))
		2:
			pos = Vector2(randf_range(270, 1480), 830)
		_:
			pos = Vector2(270, randf_range(120, 790))
	return pos

static func update_enemies(main, delta: float) -> void:
	for enemy in main.enemies:
		if enemy.is_boss:
			update_boss(main, enemy, delta)
		elif enemy.kind == "orc_shaman":
			update_ranged_enemy(main, enemy, delta)
		else:
			update_melee_enemy(main, enemy, delta)
		enemy.node.position = enemy.pos
		if enemy.has("label") and is_instance_valid(enemy.label):
			enemy.label.position = enemy.pos + Vector2(-18, -30)

static func update_melee_enemy(main, enemy: Dictionary, delta: float) -> void:
	var target: int = closest_hero(main, enemy.pos)
	var dir: Vector2 = (main.hero_pos[target] - enemy.pos).normalized()
	enemy.pos = (enemy.pos + dir * float(enemy.speed) * delta).clamp(ARENA_MIN, ARENA_MAX)
	if enemy.pos.distance_to(main.hero_pos[target]) < float(enemy.range):
		damage_hero(main, target, float(enemy.damage) * delta)

static func update_ranged_enemy(main, enemy: Dictionary, delta: float) -> void:
	var target: int = closest_hero(main, enemy.pos)
	var to_target: Vector2 = main.hero_pos[target] - enemy.pos
	var distance := to_target.length()
	var dir := to_target.normalized()
	if distance < 220.0:
		enemy.pos = (enemy.pos - dir * float(enemy.speed) * delta).clamp(ARENA_MIN, ARENA_MAX)
	elif distance > 330.0:
		enemy.pos = (enemy.pos + dir * float(enemy.speed) * delta).clamp(ARENA_MIN, ARENA_MAX)
	enemy.attack_cd = maxf(0.0, float(enemy.attack_cd) - delta)
	if enemy.attack_cd <= 0.0 and distance <= float(enemy.range):
		fire_projectile(main, enemy.pos + Vector2(20, 20), main.hero_pos[target], 205.0, float(enemy.damage), Color("#b56cff"), true, 8.0)
		enemy.attack_cd = float(enemy.attack_interval)

static func update_boss(main, enemy: Dictionary, delta: float) -> void:
	var target: int = closest_hero(main, enemy.pos)
	var hp_ratio: float = float(enemy.hp) / float(enemy.max_hp)
	enemy.phase = 3 if hp_ratio < 0.34 else 2 if hp_ratio < 0.67 else 1
	var dir: Vector2 = (main.hero_pos[target] - enemy.pos).normalized()
	enemy.pos = (enemy.pos + dir * (float(enemy.speed) + enemy.phase * 10.0) * delta).clamp(ARENA_MIN, ARENA_MAX)
	if enemy.pos.distance_to(main.hero_pos[target]) < float(enemy.range):
		damage_hero(main, target, float(enemy.damage) * delta)
	enemy.pattern_cd = maxf(0.0, float(enemy.pattern_cd) - delta)
	if enemy.pattern_cd <= 0.0:
		boss_pattern(main, enemy)
		enemy.pattern_cd = 2.4 - enemy.phase * 0.35

static func boss_pattern(main, enemy: Dictionary) -> void:
	if int(enemy.phase) == 1:
		for slot in range(4):
			fire_projectile(main, enemy.pos + Vector2(48, 52), main.hero_pos[slot], 230.0, 18.0, Color("#ff395d"), true, 10.0)
	elif int(enemy.phase) == 2:
		for angle in range(0, 360, 45):
			var target: Vector2 = enemy.pos + Vector2.RIGHT.rotated(deg_to_rad(angle)) * 180.0
			fire_projectile(main, enemy.pos + Vector2(48, 52), target, 255.0, 16.0, Color("#ff9b3d"), true, 9.0)
	else:
		create_area_effect(main, enemy.pos + Vector2(48, 52), 154.0, 32.0, Color("#8d5cff"), 0.65, true)

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
	var origin: Vector2 = main.hero_pos[slot] + Vector2(20, 20)
	var target_pos: Vector2 = main.enemies[best_index].pos + Vector2(20, 20)
	var tag: String = main.hero_tags[slot]
	var fusion: Dictionary = FUSION_ATTACKS.get(tag, {})
	if fusion.is_empty():
		var damage: float = 12.0 + main.hero_levels[slot] * 3.0
		if slot == main.active_slot:
			damage *= 1.35
		fire_projectile(main, origin, target_pos, 540.0, damage, GameData.color_for_tag(tag), false, 7.0)
	else:
		fire_fusion_attack(main, slot, origin, target_pos, fusion)

static func distribute_xp(main, amount: float) -> void:
	for i in range(4):
		var ratio := 0.4 if i == main.active_slot else 0.2
		main.hero_xp[i] += amount * ratio

static func process_level_ups(main) -> bool:
	for i in range(4):
		while main.hero_xp[i] >= main.hero_next_xp[i]:
			main.hero_xp[i] -= main.hero_next_xp[i]
			main.hero_next_xp[i] += 45.0
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

static func use_skill(main) -> void:
	if not main.battle_running or main.paused or not TouchInput.can_skill(main):
		return
	var origin: Vector2 = main.hero_pos[main.active_slot]
	create_area_effect(main, origin + Vector2(22, 22), 190.0, 42.0, GameData.color_for_tag(main.hero_tags[main.active_slot]), 0.28, false)
	TouchInput.did_skill(main)

static func update_ui(main) -> void:
	if main.timer_label:
		var remain := maxi(0, int(BATTLE_DURATION - main.battle_time))
		main.timer_label.text = "%02d:%02d" % [remain / 60, remain % 60]
	if main.wave_label:
		main.wave_label.text = "보스전" if main.boss_alive else "웨이브 %d/5" % main.wave
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
	var overlay := ColorRect.new()
	overlay.name = "LevelOverlay"
	overlay.position = Vector2.ZERO
	overlay.size = main.VIEW_SIZE
	overlay.color = Color("#050812cc")
	main.battle_root.add_child(overlay)

	var box: Panel = main.panel(overlay, Vector2(190, 110), Vector2(1220, 650), Color("#111827"))
	var h := GameData.hero(main.party_indices[slot])
	main.label(box, "LEVEL UP - %s 선택 중" % h.name, Vector2(0, 26), Vector2(1220, 54), 34, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	var choices := pick_level_choices()
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
	main.hero_tags[slot] = choice.tag if fusion == "" else fusion

static func fire_fusion_attack(main, slot: int, origin: Vector2, target_pos: Vector2, fusion: Dictionary) -> void:
	var mode: String = fusion.mode
	if mode == "gravity":
		create_area_effect(main, target_pos, float(fusion.radius), float(fusion.damage) + main.hero_levels[slot] * 2.0, fusion.color, 0.75, false)
	elif mode == "splash":
		fire_projectile(main, origin, target_pos, 500.0, float(fusion.damage), fusion.color, false, 10.0, float(fusion.radius))
	elif mode == "rail":
		create_rail_attack(main, origin, target_pos, float(fusion.damage) + main.hero_levels[slot] * 2.0, fusion.color)
	elif mode == "chain":
		create_chain_attack(main, origin, target_pos, float(fusion.damage), fusion.color, float(fusion.radius))
	elif mode == "summon":
		fire_projectile(main, origin + Vector2(randf_range(-42, 42), randf_range(-36, 36)), target_pos, 430.0, float(fusion.damage), fusion.color, false, 9.0)
	else:
		create_area_effect(main, origin, float(fusion.radius), float(fusion.damage), fusion.color, 0.32, false)

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

static func create_area_effect(main, pos: Vector2, radius: float, damage: float, color: Color, life: float, hostile: bool) -> void:
	var node := ColorRect.new()
	node.position = pos - Vector2(radius, radius)
	node.size = Vector2(radius * 2.0, radius * 2.0)
	node.color = Color(color.r, color.g, color.b, 0.34)
	main.arena.add_child(node)
	if hostile:
		for slot in range(main.hero_pos.size()):
			if pos.distance_to(main.hero_pos[slot] + Vector2(22, 22)) <= radius:
				damage_hero(main, slot, damage)
	else:
		for i in range(main.enemies.size() - 1, -1, -1):
			if pos.distance_to(main.enemies[i].pos + Vector2(20, 20)) <= radius:
				damage_enemy(main, i, damage)
	main.effects.append({"node": node, "life": life})

static func update_effects(main, delta: float) -> void:
	for i in range(main.effects.size() - 1, -1, -1):
		main.effects[i].life = float(main.effects[i].life) - delta
		if main.effects[i].life <= 0.0:
			if is_instance_valid(main.effects[i].node):
				main.effects[i].node.queue_free()
			main.effects.remove_at(i)

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
		create_area_effect(main, chain_origin + Vector2(20, 20), 34.0, 0.0, color, 0.12, false)
		hits += 1
	if hits == 0:
		fire_projectile(main, origin, target, 560.0, damage, color, false, 7.0)

static func damage_enemy(main, index: int, damage: float) -> void:
	if index < 0 or index >= main.enemies.size():
		return
	main.enemies[index].hp -= damage
	if main.enemies[index].hp > 0.0:
		return
	var defeated: Dictionary = main.enemies[index]
	if defeated.has("label") and is_instance_valid(defeated.label):
		defeated.label.queue_free()
	if is_instance_valid(defeated.node):
		defeated.node.queue_free()
	if defeated.is_boss:
		main.boss_alive = false
	distribute_xp(main, float(defeated.xp))
	main.enemies.remove_at(index)

static func damage_hero(main, slot: int, damage: float) -> void:
	if main.invuln_timer > 0.0 and slot == main.active_slot:
		return
	main.hero_hp[slot] = maxf(0.0, main.hero_hp[slot] - damage)
