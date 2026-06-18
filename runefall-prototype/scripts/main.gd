extends Node

const GameData := preload("res://scripts/game_data.gd")

const VIEW_SIZE := Vector2(1600, 900)
const SAFE_MARGIN := 24.0

var party_indices := [0, 1, 2, 3]
var active_slot := 0
var ai_presets := ["균형", "균형", "방어", "공격"]
var currencies := {"gold": 12840, "gem": 760, "material": 324}

var battle_running := false
var battle_root: Control
var arena: Control
var party_buttons: Array[Button] = []
var hero_nodes: Array[Control] = []
var hero_labels: Array[Label] = []
var hero_hp: Array[float] = []
var hero_levels := [1, 1, 1, 1]
var hero_tags := ["", "", "", ""]
var hero_pos: Array[Vector2] = []
var enemies: Array[Dictionary] = []
var xp := 0.0
var next_xp := 80.0
var battle_time := 0.0
var wave := 1
var spawn_timer := 0.0
var attack_timer := 0.0
var switch_cd: Array[float] = [0.0, 0.0, 0.0, 0.0]
var timer_label: Label
var wave_label: Label
var xp_bar: ProgressBar

func _ready() -> void:
	get_viewport().size = Vector2i(VIEW_SIZE)
	show_home()

func _process(delta: float) -> void:
	if not battle_running:
		return
	_update_battle(delta)

func set_active_slot(slot: int) -> void:
	active_slot = slot
	show_party()

func set_ai_preset(preset: String) -> void:
	ai_presets[active_slot] = preset
	show_party()

func set_party_member(hero_index: int) -> void:
	party_indices[active_slot] = hero_index
	show_party()

func clear_screen() -> void:
	battle_running = false
	for child in get_children():
		child.free()
	party_buttons.clear()
	hero_nodes.clear()
	hero_labels.clear()
	enemies.clear()

func screen_root() -> Control:
	clear_screen()
	var root := Control.new()
	root.size = VIEW_SIZE
	root.mouse_filter = Control.MOUSE_FILTER_PASS
	add_child(root)
	return root

func style(color: Color, radius: int = 8, border_color: Color = Color.TRANSPARENT, border_width: int = 0) -> StyleBoxFlat:
	var box := StyleBoxFlat.new()
	box.bg_color = color
	box.corner_radius_top_left = radius
	box.corner_radius_top_right = radius
	box.corner_radius_bottom_left = radius
	box.corner_radius_bottom_right = radius
	box.border_color = border_color
	box.border_width_left = border_width
	box.border_width_top = border_width
	box.border_width_right = border_width
	box.border_width_bottom = border_width
	return box

func panel(parent: Control, pos: Vector2, size: Vector2, color: Color = Color("#172033d8"), radius: int = 8) -> PanelContainer:
	var p := PanelContainer.new()
	p.position = pos
	p.size = size
	p.add_theme_stylebox_override("panel", style(color, radius, Color("#35415e"), 1))
	parent.add_child(p)
	return p

func label(parent: Control, text: String, pos: Vector2, size: Vector2, font_size: int = 22, color: Color = Color("#f4f7ff"), align := HORIZONTAL_ALIGNMENT_LEFT) -> Label:
	var l := Label.new()
	l.text = text
	l.position = pos
	l.size = size
	l.horizontal_alignment = align
	l.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	l.add_theme_font_size_override("font_size", font_size)
	l.add_theme_color_override("font_color", color)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	parent.add_child(l)
	return l

func button(parent: Control, text: String, pos: Vector2, size: Vector2, pressed: Callable, font_size: int = 24, bg := Color("#2f8cff")) -> Button:
	var b := Button.new()
	b.text = text
	b.position = pos
	b.size = size
	b.focus_mode = Control.FOCUS_NONE
	b.add_theme_font_size_override("font_size", font_size)
	b.add_theme_stylebox_override("normal", style(bg, 8))
	b.add_theme_stylebox_override("hover", style(bg.lightened(0.08), 8))
	b.add_theme_stylebox_override("pressed", style(bg.darkened(0.12), 8))
	b.add_theme_stylebox_override("disabled", style(Color("#566070"), 8))
	b.pressed.connect(pressed)
	parent.add_child(b)
	return b

func tag_chip(parent: Control, text: String, pos: Vector2, color: Color) -> Label:
	var chip := Label.new()
	chip.text = text
	chip.position = pos
	chip.size = Vector2(150, 34)
	chip.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	chip.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	chip.add_theme_font_size_override("font_size", 17)
	chip.add_theme_color_override("font_color", Color("#101725"))
	chip.add_theme_stylebox_override("normal", style(color, 8))
	parent.add_child(chip)
	return chip

func show_home() -> void:
	var root := screen_root()
	root.add_theme_stylebox_override("panel", style(Color("#0c1220")))

	var bg := ColorRect.new()
	bg.size = VIEW_SIZE
	bg.color = Color("#111b2f")
	root.add_child(bg)

	for i in range(12):
		var tile := ColorRect.new()
		tile.position = Vector2(70 + i * 135, 160 + (i % 3) * 58)
		tile.size = Vector2(82, 34)
		tile.color = Color("#1f3751")
		root.add_child(tile)

	label(root, "RUNEFALL", Vector2(40, 28), Vector2(240, 44), 34, Color("#ffffff"))
	label(root, "Lv.12 암석 거점", Vector2(40, 74), Vector2(260, 36), 20, Color("#a7b7d5"))
	label(root, "골드 %d   젬 %d   소재 %d" % [currencies.gold, currencies.gem, currencies.material], Vector2(1030, 28), Vector2(420, 44), 22, Color("#f6d66d"), HORIZONTAL_ALIGNMENT_RIGHT)
	button(root, "우편", Vector2(1470, 28), Vector2(96, 44), func(): show_message("우편함은 후속 구현 영역입니다."), 18, Color("#24314a"))

	var base := panel(root, Vector2(56, 138), Vector2(1040, 610), Color("#18253c"))
	label(root, "현재 파티", Vector2(88, 162), Vector2(260, 36), 28)
	label(root, "밝은 하이 판타지 거점 배경과 파티 4인 배치 영역", Vector2(88, 204), Vector2(520, 30), 18, Color("#9fb0d0"))

	for i in range(4):
		var h := GameData.hero(party_indices[i])
		var card := panel(root, Vector2(120 + i * 232, 310 + (i % 2) * 76), Vector2(168, 220), Color("#111827"))
		var sprite := ColorRect.new()
		sprite.position = Vector2(45, 30)
		sprite.size = Vector2(78, 98)
		sprite.color = Color(h.color)
		card.add_child(sprite)
		label(card, h.name, Vector2(18, 140), Vector2(132, 28), 24, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		label(card, h.role, Vector2(10, 170), Vector2(148, 24), 16, Color("#b9c7e3"), HORIZONTAL_ALIGNMENT_CENTER)
		if i == active_slot:
			tag_chip(card, "조작", Vector2(48, 6), Color("#ffd24a"))

	for i in range(5):
		var tab_text: String = ["홈", "캐릭터", "장비/제작", "상점", "도감·시련"][i]
		button(root, tab_text, Vector2(56 + i * 142, 794), Vector2(132, 58), Callable(self, "show_meta_tab").bind(tab_text), 18, Color("#202b43"))

	panel(root, Vector2(1140, 140), Vector2(370, 186), Color("#172033"))
	label(root, "일일 미션", Vector2(1172, 164), Vector2(180, 34), 26)
	label(root, "런 1회 완료\n화염 태그 무기 3회 선택\n보상 2배 광고 준비", Vector2(1172, 210), Vector2(292, 88), 19, Color("#c9d5ee"))
	panel(root, Vector2(1140, 352), Vector2(370, 160), Color("#172033"))
	label(root, "시즌 패스", Vector2(1172, 376), Vector2(180, 34), 26)
	label(root, "서리 균열 시즌 12일 남음", Vector2(1172, 424), Vector2(290, 32), 19, Color("#c9d5ee"))
	button(root, "파티 편성", Vector2(1138, 574), Vector2(178, 74), func(): show_party(), 24, Color("#45536f"))
	button(root, "출격", Vector2(1332, 574), Vector2(178, 74), func(): show_launch_confirm(), 28, Color("#f05a28"))

func show_meta_tab(tab_name: String) -> void:
	var root := screen_root()
	ColorRect.new()
	var bg := ColorRect.new()
	bg.size = VIEW_SIZE
	bg.color = Color("#0f1726")
	root.add_child(bg)
	button(root, "← 홈", Vector2(36, 28), Vector2(120, 50), func(): show_home(), 20, Color("#26334d"))
	label(root, tab_name, Vector2(190, 30), Vector2(360, 50), 34)

	if tab_name == "캐릭터":
		for i in range(GameData.HEROES.size()):
			var h := GameData.hero(i)
			var x := 78 + (i % 3) * 480
			var y := 150 + int(i / 3) * 250
			var card := panel(root, Vector2(x, y), Vector2(390, 200), Color("#172033"))
			var swatch := ColorRect.new()
			swatch.position = Vector2(22, 28)
			swatch.size = Vector2(92, 116)
			swatch.color = Color(h.color)
			card.add_child(swatch)
			label(card, h.name, Vector2(136, 24), Vector2(200, 34), 28)
			label(card, "%s / %s" % [h.role, h.weapon], Vector2(136, 64), Vector2(220, 32), 18, Color("#b7c6e4"))
			tag_chip(card, h.tag, Vector2(136, 110), GameData.color_for_tag(h.tag))
			label(card, "승급, 전용 슬롯, 코스튬은 다음 단계에서 실제 수치 연결", Vector2(22, 154), Vector2(340, 32), 16, Color("#93a4c6"))
	else:
		label(root, "%s 화면 와이어프레임" % tab_name, Vector2(86, 160), Vector2(600, 44), 32)
		label(root, "확정형 구매, 제작, 도감, 시즌 콘텐츠의 상세 리스트를 배치할 자리입니다.", Vector2(86, 220), Vector2(820, 36), 22, Color("#b7c6e4"))
		for i in range(6):
			panel(root, Vector2(86 + i * 240, 330), Vector2(200, 230), Color("#172033"))
			label(root, "슬롯 %d" % (i + 1), Vector2(112 + i * 240, 362), Vector2(150, 34), 22)

func show_party() -> void:
	var root := screen_root()
	var bg := ColorRect.new()
	bg.size = VIEW_SIZE
	bg.color = Color("#0d1424")
	root.add_child(bg)

	button(root, "← 홈", Vector2(32, 26), Vector2(112, 48), func(): show_home(), 20, Color("#26334d"))
	label(root, "파티 편성", Vector2(174, 28), Vector2(250, 48), 34)
	var chips := GameData.synergy_for_party(party_indices)
	for i in range(chips.size()):
		tag_chip(root, chips[i], Vector2(440 + i * 164, 34), Color("#ffd24a") if chips[i].contains("조합") else Color("#76d7ff"))

	panel(root, Vector2(70, 130), Vector2(850, 520), Color("#172033"))
	label(root, "편성 슬롯", Vector2(104, 156), Vector2(220, 34), 28)
	for i in range(4):
		var h := GameData.hero(party_indices[i])
		var card := panel(root, Vector2(108 + i * 196, 236), Vector2(166, 260), Color("#111827"))
		var sprite := ColorRect.new()
		sprite.position = Vector2(43, 36)
		sprite.size = Vector2(80, 106)
		sprite.color = Color(h.color)
		card.add_child(sprite)
		label(card, "%d" % (i + 1), Vector2(8, 8), Vector2(36, 26), 18, Color("#9fb0d0"))
		label(card, h.name, Vector2(16, 154), Vector2(134, 30), 24, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		label(card, "조작" if i == active_slot else "AI", Vector2(16, 188), Vector2(134, 24), 18, Color("#ffd24a") if i == active_slot else Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)
		button(card, "지정", Vector2(22, 216), Vector2(122, 34), Callable(self, "set_active_slot").bind(i), 16, Color("#364764"))

	label(root, "선택 슬롯 AI 프리셋", Vector2(108, 530), Vector2(230, 30), 22)
	for i in range(3):
		var preset: String = ["공격", "균형", "방어"][i]
		button(root, preset, Vector2(340 + i * 120, 526), Vector2(102, 42), Callable(self, "set_ai_preset").bind(preset), 18, Color("#f05a28") if ai_presets[active_slot] == preset else Color("#33415c"))
	button(root, "전용 장비 보기", Vector2(706, 526), Vector2(160, 42), func(): show_message("전용 장비 슬롯은 다음 구현 단계에서 연결합니다."), 18, Color("#33415c"))

	panel(root, Vector2(980, 130), Vector2(540, 520), Color("#172033"))
	label(root, "보유 캐릭터", Vector2(1014, 156), Vector2(220, 34), 28)
	for i in range(GameData.HEROES.size()):
		var h := GameData.hero(i)
		var x := 1016 + (i % 3) * 160
		var y := 220 + int(i / 3) * 168
		var b := button(root, "", Vector2(x, y), Vector2(132, 132), Callable(self, "set_party_member").bind(i), 18, Color("#111827"))
		var swatch := ColorRect.new()
		swatch.position = Vector2(36, 16)
		swatch.size = Vector2(60, 66)
		swatch.color = Color(h.color)
		b.add_child(swatch)
		label(b, h.name, Vector2(8, 86), Vector2(116, 24), 18, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		label(b, h.tag, Vector2(8, 108), Vector2(116, 20), 14, Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)

	button(root, "출격 확인으로", Vector2(1190, 718), Vector2(290, 72), func(): show_launch_confirm(), 26, Color("#f05a28"))

func show_launch_confirm() -> void:
	var root := screen_root()
	var bg := ColorRect.new()
	bg.size = VIEW_SIZE
	bg.color = Color("#0d1424")
	root.add_child(bg)
	button(root, "← 편성", Vector2(32, 26), Vector2(124, 48), func(): show_party(), 20, Color("#26334d"))
	label(root, "출격 직전 확인", Vector2(190, 28), Vector2(320, 48), 34)
	label(root, "싱글 플레이: 1명 직접 조작 + 3명 AI. 전투 중 파티 패널 탭으로 전환합니다.", Vector2(96, 104), Vector2(900, 34), 22, Color("#b7c6e4"))

	for i in range(4):
		var h := GameData.hero(party_indices[i])
		var card := panel(root, Vector2(96 + i * 350, 190), Vector2(300, 400), Color("#172033"))
		var sprite := ColorRect.new()
		sprite.position = Vector2(100, 42)
		sprite.size = Vector2(100, 132)
		sprite.color = Color(h.color)
		card.add_child(sprite)
		label(card, h.name, Vector2(24, 202), Vector2(252, 34), 28, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		label(card, h.role, Vector2(24, 242), Vector2(252, 28), 18, Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)
		tag_chip(card, h.tag, Vector2(74, 288), GameData.color_for_tag(h.tag))
		label(card, "AI: %s" % ai_presets[i], Vector2(24, 338), Vector2(252, 28), 18, Color("#ffd24a") if i != active_slot else Color("#8ee6ff"), HORIZONTAL_ALIGNMENT_CENTER)

	button(root, "전투 시작", Vector2(1196, 720), Vector2(300, 76), func(): start_battle(), 30, Color("#f05a28"))

func start_battle() -> void:
	var root := screen_root()
	battle_root = root
	var bg := ColorRect.new()
	bg.size = VIEW_SIZE
	bg.color = Color("#0b1020")
	root.add_child(bg)

	arena = Control.new()
	arena.position = Vector2(0, 0)
	arena.size = VIEW_SIZE
	root.add_child(arena)

	for i in range(24):
		var tile := ColorRect.new()
		tile.position = Vector2((i * 137) % 1560, 110 + ((i * 71) % 650))
		tile.size = Vector2(60, 18)
		tile.color = Color("#16243a")
		arena.add_child(tile)

	var top := panel(root, Vector2(520, 18), Vector2(560, 54), Color("#111827d8"))
	timer_label = label(top, "05:32", Vector2(16, 8), Vector2(110, 34), 20)
	wave_label = label(top, "웨이브 1/5", Vector2(134, 8), Vector2(142, 34), 20)
	xp_bar = ProgressBar.new()
	xp_bar.position = Vector2(292, 13)
	xp_bar.size = Vector2(210, 24)
	xp_bar.max_value = next_xp
	xp_bar.value = xp
	top.add_child(xp_bar)
	button(root, "정산", Vector2(1466, 22), Vector2(94, 44), func(): show_result(true), 18, Color("#26334d"))

	var party_panel := panel(root, Vector2(22, 112), Vector2(222, 282), Color("#111827e8"))
	label(party_panel, "파티", Vector2(16, 8), Vector2(80, 28), 20)
	for i in range(4):
		var b := button(party_panel, "", Vector2(14, 46 + i * 56), Vector2(194, 46), Callable(self, "try_switch").bind(i), 16, Color("#24314a"))
		party_buttons.append(b)

	var stick := panel(root, Vector2(72, 688), Vector2(164, 164), Color("#26334d99"), 82)
	label(stick, "◉", Vector2(44, 34), Vector2(76, 76), 54, Color("#cde3ff"), HORIZONTAL_ALIGNMENT_CENTER)
	label(root, "WASD/방향키 이동", Vector2(58, 850), Vector2(210, 28), 16, Color("#8392b2"), HORIZONTAL_ALIGNMENT_CENTER)
	button(root, "스킬", Vector2(1308, 704), Vector2(104, 104), func(): use_skill(), 24, Color("#7b5cff"))
	button(root, "대시", Vector2(1434, 704), Vector2(104, 104), func(): dash_active(), 24, Color("#2f8cff"))

	battle_time = 0.0
	wave = 1
	xp = 0.0
	next_xp = 80.0
	spawn_timer = 0.0
	attack_timer = 0.0
	switch_cd = [0.0, 0.0, 0.0, 0.0]
	hero_pos = [Vector2(760, 430), Vector2(700, 488), Vector2(824, 490), Vector2(760, 552)]
	hero_hp.clear()
	hero_tags = ["", "", "", ""]
	for i in range(4):
		var h := GameData.hero(party_indices[i])
		hero_hp.append(float(h.hp))
		hero_tags[i] = h.tag
		var body := ColorRect.new()
		body.position = hero_pos[i]
		body.size = Vector2(38, 48)
		body.color = Color(h.color)
		arena.add_child(body)
		hero_nodes.append(body)
		var name_label := label(arena, h.name, hero_pos[i] + Vector2(-18, -28), Vector2(80, 22), 14, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		hero_labels.append(name_label)

	battle_running = true
	update_battle_ui()

func _update_battle(delta: float) -> void:
	battle_time += delta
	wave = clampi(1 + int(battle_time / 28.0), 1, 5)
	for i in range(4):
		switch_cd[i] = maxf(0.0, switch_cd[i] - delta)

	var input_dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if input_dir.length() > 0.05:
		var h := GameData.hero(party_indices[active_slot])
		hero_pos[active_slot] += input_dir.normalized() * float(h.speed) * delta
	hero_pos[active_slot] = hero_pos[active_slot].clamp(Vector2(270, 112), Vector2(1470, 806))

	for i in range(4):
		if i == active_slot:
			continue
		var desired := hero_pos[active_slot] + Vector2(cos(float(i) * 2.1), sin(float(i) * 2.1)) * 110.0
		hero_pos[i] = hero_pos[i].lerp(desired, delta * 2.2)

	spawn_timer -= delta
	if spawn_timer <= 0.0:
		spawn_enemy()
		spawn_timer = maxf(0.25, 1.2 - wave * 0.12)

	for enemy in enemies:
		var target: int = closest_hero(enemy.pos)
		var dir: Vector2 = (hero_pos[target] - enemy.pos).normalized()
		enemy.pos += dir * (70.0 + wave * 20.0) * delta
		enemy.node.position = enemy.pos
		if enemy.pos.distance_to(hero_pos[target]) < 38.0:
			hero_hp[target] = maxf(0.0, hero_hp[target] - 12.0 * delta)

	attack_timer -= delta
	if attack_timer <= 0.0:
		for i in range(4):
			hit_nearest_enemy(i)
		attack_timer = 0.38

	for i in range(hero_nodes.size()):
		hero_nodes[i].position = hero_pos[i]
		hero_labels[i].position = hero_pos[i] + Vector2(-20, -28)

	if Input.is_action_just_pressed("dash"):
		dash_active()
	if Input.is_action_just_pressed("skill"):
		use_skill()

	if xp >= next_xp:
		xp -= next_xp
		next_xp += 45.0
		hero_levels[active_slot] += 1
		show_level_up()
		return

	if hero_hp.max() <= 0.0:
		show_result(false)
		return
	if battle_time >= 150.0:
		show_result(true)
		return

	update_battle_ui()

func spawn_enemy() -> void:
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
	var node := ColorRect.new()
	node.position = pos
	node.size = Vector2(28, 28)
	node.color = Color("#d74848")
	arena.add_child(node)
	enemies.append({"node": node, "pos": pos, "hp": 18.0 + wave * 5.0})

func closest_hero(pos: Vector2) -> int:
	var best := 0
	var best_dist := INF
	for i in range(hero_pos.size()):
		var dist := pos.distance_squared_to(hero_pos[i])
		if dist < best_dist:
			best = i
			best_dist = dist
	return best

func hit_nearest_enemy(slot: int) -> void:
	if enemies.is_empty():
		return
	var best_index := -1
	var best_dist := INF
	for i in range(enemies.size()):
		var dist: float = enemies[i].pos.distance_squared_to(hero_pos[slot])
		if dist < best_dist:
			best_index = i
			best_dist = dist
	if best_index == -1 or best_dist > 420.0 * 420.0:
		return
	var damage: float = 12.0 + hero_levels[slot] * 3.0
	if slot == active_slot:
		damage *= 1.35
	enemies[best_index].hp -= damage
	if enemies[best_index].hp <= 0.0:
		enemies[best_index].node.queue_free()
		enemies.remove_at(best_index)
		xp += 8.0 if slot == active_slot else 4.0

func try_switch(slot: int) -> void:
	if slot == active_slot or switch_cd[slot] > 0.0:
		return
	switch_cd[active_slot] = 12.0
	active_slot = slot
	hero_hp[active_slot] = minf(hero_hp[active_slot] + 12.0, float(GameData.hero(party_indices[active_slot]).hp))
	update_battle_ui()

func dash_active() -> void:
	if not battle_running:
		return
	var dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if dir.length() < 0.05:
		dir = Vector2.RIGHT
	hero_pos[active_slot] = (hero_pos[active_slot] + dir.normalized() * 150.0).clamp(Vector2(270, 112), Vector2(1470, 806))

func use_skill() -> void:
	if not battle_running:
		return
	var origin := hero_pos[active_slot]
	for i in range(enemies.size() - 1, -1, -1):
		if enemies[i].pos.distance_to(origin) < 190.0:
			enemies[i].node.queue_free()
			enemies.remove_at(i)
			xp += 5.0

func update_battle_ui() -> void:
	if timer_label:
		var remain := maxi(0, int(150.0 - battle_time))
		timer_label.text = "%02d:%02d" % [remain / 60, remain % 60]
	if wave_label:
		wave_label.text = "웨이브 %d/5" % wave
	if xp_bar:
		xp_bar.max_value = next_xp
		xp_bar.value = xp
	for i in range(party_buttons.size()):
		var h := GameData.hero(party_indices[i])
		var hp_ratio := hero_hp[i] / float(h.hp)
		var marker := "◀ " if i == active_slot else ""
		var cd := "" if switch_cd[i] <= 0.0 else " CD%d" % ceili(switch_cd[i])
		party_buttons[i].text = "%s%d %s  HP %d%%%s" % [marker, i + 1, h.name, int(hp_ratio * 100.0), cd]
		party_buttons[i].disabled = i != active_slot and switch_cd[i] > 0.0

func show_level_up() -> void:
	battle_running = false
	var overlay := ColorRect.new()
	overlay.name = "LevelOverlay"
	overlay.position = Vector2.ZERO
	overlay.size = VIEW_SIZE
	overlay.color = Color("#050812cc")
	battle_root.add_child(overlay)

	var box := panel(overlay, Vector2(190, 110), Vector2(1220, 650), Color("#111827"))
	var h := GameData.hero(party_indices[active_slot])
	label(box, "LEVEL UP - %s 선택 중" % h.name, Vector2(0, 26), Vector2(1220, 54), 34, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	var choices := pick_level_choices()
	for i in range(3):
		var c: Dictionary = choices[i]
		var card := button(box, "", Vector2(95 + i * 360, 130), Vector2(310, 360), Callable(self, "choose_level").bind(c, overlay), 18, Color("#1c2940"))
		var icon := ColorRect.new()
		icon.position = Vector2(105, 52)
		icon.size = Vector2(100, 100)
		icon.color = GameData.color_for_tag(c.tag)
		card.add_child(icon)
		label(card, c.name, Vector2(18, 184), Vector2(274, 36), 26, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		tag_chip(card, c.kind + " / " + c.tag, Vector2(80, 232), GameData.color_for_tag(c.tag))
		label(card, c.desc, Vector2(26, 286), Vector2(258, 40), 18, Color("#c8d4ee"), HORIZONTAL_ALIGNMENT_CENTER)

	var fusion := GameData.fusion_name(hero_tags[active_slot], choices[0].tag)
	var fusion_text := "융합 가능: %s + %s → %s" % [hero_tags[active_slot], choices[0].tag, fusion] if fusion != "" else "융합 후보를 더 모으면 태그 조합이 열립니다."
	label(box, fusion_text, Vector2(110, 532), Vector2(800, 42), 24, Color("#ffd24a"))
	button(box, "추천 자동 선택", Vector2(960, 526), Vector2(200, 54), Callable(self, "choose_level").bind(choices[0], overlay), 20, Color("#f05a28"))

func pick_level_choices() -> Array:
	var pool := GameData.LEVEL_CHOICES.duplicate()
	pool.shuffle()
	return [pool[0], pool[1], pool[2]]

func choose_level(choice: Dictionary, overlay_node: Control) -> void:
	var fusion := GameData.fusion_name(hero_tags[active_slot], choice.tag)
	hero_tags[active_slot] = choice.tag if fusion == "" else fusion
	overlay_node.queue_free()
	battle_running = true

func show_result(victory: bool) -> void:
	battle_running = false
	var root := screen_root()
	var bg := ColorRect.new()
	bg.size = VIEW_SIZE
	bg.color = Color("#0d1424")
	root.add_child(bg)
	label(root, "RESULT - %s" % ("클리어" if victory else "전멸"), Vector2(0, 52), Vector2(1600, 58), 42, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	label(root, "도달 웨이브 %d / 생존 시간 %d초" % [wave, int(battle_time)], Vector2(0, 112), Vector2(1600, 36), 22, Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)

	panel(root, Vector2(170, 190), Vector2(900, 420), Color("#172033"))
	label(root, "4인 개별 성장", Vector2(206, 220), Vector2(300, 40), 30)
	for i in range(4):
		var h := GameData.hero(party_indices[i])
		var share := 40 if i == active_slot else 20
		label(root, "%d %s  Lv.%d → Lv.%d  EXP +%d%%" % [i + 1, h.name, hero_levels[i], hero_levels[i] + (1 if victory else 0), share], Vector2(220, 292 + i * 62), Vector2(620, 34), 24, Color("#ffffff"))
		var bar := ProgressBar.new()
		bar.position = Vector2(720, 298 + i * 62)
		bar.size = Vector2(260, 22)
		bar.max_value = 100
		bar.value = share
		root.add_child(bar)

	panel(root, Vector2(1110, 190), Vector2(330, 420), Color("#172033"))
	label(root, "획득 보상", Vector2(1144, 220), Vector2(200, 40), 30)
	label(root, "골드 +820\n소재 +34\n장비 드롭 1\n도감 갱신 2", Vector2(1144, 294), Vector2(220, 160), 24, Color("#f6d66d"))
	button(root, "한 번 더", Vector2(940, 708), Vector2(220, 72), func(): start_battle(), 26, Color("#f05a28"))
	button(root, "메인으로", Vector2(1190, 708), Vector2(220, 72), func(): show_home(), 26, Color("#33415c"))

func show_message(message: String) -> void:
	var root := get_child(0) as Control
	var toast := panel(root, Vector2(500, 396), Vector2(600, 108), Color("#111827ee"))
	label(toast, message, Vector2(24, 24), Vector2(552, 54), 22, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	var timer := get_tree().create_timer(1.4)
	timer.timeout.connect(func(): if is_instance_valid(toast): toast.queue_free())
