extends RefCounted

const GameData := preload("res://scripts/game_data.gd")

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
	main.button(root, "정산", Vector2(1466, 22), Vector2(94, 44), func(): main.show_result(true), 18, Color("#26334d"), "button_blue")

	var party_panel: Panel = main.panel(root, Vector2(22, 112), Vector2(222, 282), Color("#111827e8"))
	main.label(party_panel, "파티", Vector2(16, 8), Vector2(80, 28), 20)
	for i in range(4):
		var b: Button = main.button(party_panel, "", Vector2(14, 46 + i * 56), Vector2(194, 46), Callable(main, "try_switch").bind(i), 16, Color("#24314a"))
		main.party_buttons.append(b)

	var stick: Panel = main.panel(root, Vector2(72, 688), Vector2(164, 164), Color("#26334d99"), 82)
	main.label(stick, "◉", Vector2(44, 34), Vector2(76, 76), 54, Color("#cde3ff"), HORIZONTAL_ALIGNMENT_CENTER)
	main.label(root, "WASD/방향키 이동", Vector2(58, 850), Vector2(210, 28), 16, Color("#8392b2"), HORIZONTAL_ALIGNMENT_CENTER)
	main.button(root, "스킬", Vector2(1308, 704), Vector2(104, 104), func(): main.use_skill(), 24, Color("#7b5cff"), "square_blue")
	main.button(root, "대시", Vector2(1434, 704), Vector2(104, 104), func(): main.dash_active(), 24, Color("#2f8cff"), "square_blue")

	main.battle_time = 0.0
	main.wave = 1
	main.spawn_timer = 0.0
	main.attack_timer = 0.0
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
	main.battle_time += delta
	main.wave = clampi(1 + int(main.battle_time / 28.0), 1, 5)
	for i in range(4):
		main.switch_cd[i] = maxf(0.0, main.switch_cd[i] - delta)

	var input_dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if input_dir.length() > 0.05:
		var h := GameData.hero(main.party_indices[main.active_slot])
		main.hero_pos[main.active_slot] += input_dir.normalized() * float(h.speed) * delta
	main.hero_pos[main.active_slot] = main.hero_pos[main.active_slot].clamp(Vector2(270, 112), Vector2(1470, 806))

	for i in range(4):
		if i == main.active_slot:
			continue
		var desired: Vector2 = main.hero_pos[main.active_slot] + Vector2(cos(float(i) * 2.1), sin(float(i) * 2.1)) * 110.0
		main.hero_pos[i] = main.hero_pos[i].lerp(desired, delta * 2.2)

	main.spawn_timer -= delta
	if main.spawn_timer <= 0.0:
		spawn_enemy(main)
		main.spawn_timer = maxf(0.25, 1.2 - main.wave * 0.12)

	for enemy in main.enemies:
		var target: int = closest_hero(main, enemy.pos)
		var dir: Vector2 = (main.hero_pos[target] - enemy.pos).normalized()
		enemy.pos += dir * (70.0 + main.wave * 20.0) * delta
		enemy.node.position = enemy.pos
		if enemy.pos.distance_to(main.hero_pos[target]) < 38.0:
			main.hero_hp[target] = maxf(0.0, main.hero_hp[target] - 12.0 * delta)

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
	if main.battle_time >= 150.0:
		main.show_result(true)
		return

	update_ui(main)

static func spawn_enemy(main) -> void:
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
	var node: Control = main.pixel_art(main.arena, GameData.enemy_sprite(randi()), pos, Vector2(38, 38), Color("#d74848"))
	node.position = pos
	main.enemies.append({"node": node, "pos": pos, "hp": 18.0 + main.wave * 5.0})

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
	var damage: float = 12.0 + main.hero_levels[slot] * 3.0
	if slot == main.active_slot:
		damage *= 1.35
	main.enemies[best_index].hp -= damage
	if main.enemies[best_index].hp <= 0.0:
		main.enemies[best_index].node.queue_free()
		main.enemies.remove_at(best_index)
		distribute_xp(main, 22.0)

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
	update_ui(main)

static func dash_active(main) -> void:
	if not main.battle_running:
		return
	var dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if dir.length() < 0.05:
		dir = Vector2.RIGHT
	main.hero_pos[main.active_slot] = (main.hero_pos[main.active_slot] + dir.normalized() * 150.0).clamp(Vector2(270, 112), Vector2(1470, 806))

static func use_skill(main) -> void:
	if not main.battle_running:
		return
	var origin: Vector2 = main.hero_pos[main.active_slot]
	for i in range(main.enemies.size() - 1, -1, -1):
		if main.enemies[i].pos.distance_to(origin) < 190.0:
			main.enemies[i].node.queue_free()
			main.enemies.remove_at(i)
			distribute_xp(main, 14.0)

static func update_ui(main) -> void:
	if main.timer_label:
		var remain := maxi(0, int(150.0 - main.battle_time))
		main.timer_label.text = "%02d:%02d" % [remain / 60, remain % 60]
	if main.wave_label:
		main.wave_label.text = "웨이브 %d/5" % main.wave
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
