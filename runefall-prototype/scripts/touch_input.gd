extends RefCounted

const GameData := preload("res://scripts/game_data.gd")
const STICK_CENTER := Vector2(154, 770)
const STICK_RADIUS := 82.0
const STICK_DEADZONE := 12.0
const DASH_COOLDOWN := 1.8
const SKILL_COOLDOWN := 5.0
const INVULN_DURATION := 0.4
const SWITCH_FLASH_DURATION := 0.4

static func build_controls(main, root: Control) -> void:
	main.joystick_base = main.panel(root, Vector2(72, 688), Vector2(164, 164), Color("#26334d88"), 82)
	main.joystick_base.add_theme_stylebox_override("panel", main.style(Color("#26334d88"), 82, Color("#c4d7ff66"), 2))
	main.joystick_knob = main.panel(main.joystick_base, Vector2(58, 58), Vector2(48, 48), Color("#cde3ffcc"), 24)
	main.joystick_knob.add_theme_stylebox_override("panel", main.style(Color("#cde3ffcc"), 24, Color("#ffffffaa"), 2))
	main.label(root, "터치/드래그 이동", Vector2(58, 850), Vector2(210, 28), 16, Color("#8392b2"), HORIZONTAL_ALIGNMENT_CENTER)

	main.dash_button = main.button(root, "대시", Vector2(1418, 710), Vector2(130, 130), Callable(main, "dash_active"), 26, Color("#2f8cff"), "square_blue")
	main.dash_cd_label = main.label(root, "", Vector2(1418, 710), Vector2(130, 130), 22, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	main.dash_cd_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	refresh_skill_buttons(main)

	main.pause_button = main.button(root, "⏸", Vector2(1466, 22), Vector2(94, 44), Callable(main, "toggle_pause"), 24, Color("#26334d"), "button_blue")
	update_cooldown_ui(main)

static func handle_input(main, event: InputEvent) -> void:
	if not main.battle_running:
		return
	if event is InputEventScreenTouch:
		var touch := event as InputEventScreenTouch
		if touch.pressed and _in_stick_area(touch.position) and main.touch_active_id == -1:
			main.touch_active_id = touch.index
			_set_stick_vector(main, touch.position)
		elif not touch.pressed and touch.index == main.touch_active_id:
			_release_stick(main)
	elif event is InputEventScreenDrag:
		var drag := event as InputEventScreenDrag
		if drag.index == main.touch_active_id:
			_set_stick_vector(main, drag.position)
	elif event is InputEventMouseButton:
		var mouse := event as InputEventMouseButton
		if mouse.button_index == MOUSE_BUTTON_LEFT:
			if mouse.pressed and _in_stick_area(mouse.position):
				main.touch_mouse_active = true
				_set_stick_vector(main, mouse.position)
			elif not mouse.pressed and main.touch_mouse_active:
				main.touch_mouse_active = false
				_release_stick(main)
	elif event is InputEventMouseMotion and main.touch_mouse_active:
		var motion := event as InputEventMouseMotion
		_set_stick_vector(main, motion.position)

static func update(main, delta: float) -> void:
	if main.dash_cooldown > 0.0:
		main.dash_cooldown = maxf(0.0, main.dash_cooldown - delta)
	if main.skill_cooldown > 0.0:
		main.skill_cooldown = maxf(0.0, main.skill_cooldown - delta)
	for hero_index in range(main.hero_skill_cooldowns.size()):
		var cooldowns: Array = main.hero_skill_cooldowns[hero_index]
		for skill_index in range(cooldowns.size()):
			cooldowns[skill_index] = maxf(0.0, float(cooldowns[skill_index]) - delta)
		main.hero_skill_cooldowns[hero_index] = cooldowns
	main.skill_cooldown = _active_skill_cooldown(main, 0)
	if main.invuln_timer > 0.0:
		main.invuln_timer = maxf(0.0, main.invuln_timer - delta)
	if main.switch_flash_timer > 0.0:
		main.switch_flash_timer = maxf(0.0, main.switch_flash_timer - delta)
	_update_switch_flash(main)
	update_cooldown_ui(main)

static func toggle_pause(main) -> void:
	if not main.battle_running:
		return
	main.paused = not main.paused
	if main.pause_button:
		main.pause_button.text = "▶" if main.paused else "⏸"
	if main.paused:
		_show_pause_overlay(main)
	elif main.pause_overlay and is_instance_valid(main.pause_overlay):
		main.pause_overlay.queue_free()
		main.pause_overlay = null

static func can_dash(main) -> bool:
	return main.dash_cooldown <= 0.0

static func did_dash(main) -> void:
	main.dash_cooldown = DASH_COOLDOWN
	main.invuln_timer = INVULN_DURATION
	update_cooldown_ui(main)

static func can_skill(main, skill_index: int = 0) -> bool:
	return skill_index >= 0 and skill_index < _active_skill_tags(main).size() and _active_skill_cooldown(main, skill_index) <= 0.0

static func did_skill(main, skill_index: int = 0) -> void:
	_ensure_active_skill_cooldowns(main)
	var cooldowns: Array = main.hero_skill_cooldowns[main.active_slot]
	if skill_index >= 0 and skill_index < cooldowns.size():
		cooldowns[skill_index] = SKILL_COOLDOWN
	main.hero_skill_cooldowns[main.active_slot] = cooldowns
	main.skill_cooldown = _active_skill_cooldown(main, 0)
	update_cooldown_ui(main)

static func did_switch(main) -> void:
	main.invuln_timer = INVULN_DURATION
	main.switch_flash_timer = SWITCH_FLASH_DURATION
	refresh_skill_buttons(main)
	_update_switch_flash(main)

static func update_cooldown_ui(main) -> void:
	if main.dash_button:
		main.dash_button.disabled = main.dash_cooldown > 0.0
	if main.dash_cd_label:
		main.dash_cd_label.text = "%.1f" % main.dash_cooldown if main.dash_cooldown > 0.0 else ""
	for i in range(main.skill_buttons.size()):
		var cooldown := _active_skill_cooldown(main, i)
		main.skill_buttons[i].disabled = cooldown > 0.0
		if i < main.skill_cd_labels.size():
			main.skill_cd_labels[i].text = "%.1f" % cooldown if cooldown > 0.0 else ""

static func refresh_skill_buttons(main) -> void:
	for button: Button in main.skill_buttons:
		if button and is_instance_valid(button):
			button.queue_free()
	for label: Label in main.skill_cd_labels:
		if label and is_instance_valid(label):
			label.queue_free()
	main.skill_buttons.clear()
	main.skill_cd_labels.clear()
	main.skill_button = null
	main.skill_cd_label = null
	if main.battle_root == null or not is_instance_valid(main.battle_root):
		return
	_ensure_active_skill_cooldowns(main)
	var tags := _active_skill_tags(main)
	var positions := [
		Vector2(1300, 748),
		Vector2(1336, 642),
		Vector2(1432, 602),
		Vector2(1238, 666),
		Vector2(1218, 770)
	]
	var size := Vector2(88, 88)
	for i in range(mini(tags.size(), positions.size())):
		var tag := str(tags[i])
		var label_text := _skill_label(tag)
		var button: Button = main.button(main.battle_root, label_text, positions[i], size, Callable(main, "use_skill").bind(i), 16, GameData.color_for_tag(tag), "square_blue")
		var cd_label: Label = main.label(main.battle_root, "", positions[i], size, 18, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		cd_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		main.skill_buttons.append(button)
		main.skill_cd_labels.append(cd_label)
	if not main.skill_buttons.is_empty():
		main.skill_button = main.skill_buttons[0]
	if not main.skill_cd_labels.is_empty():
		main.skill_cd_label = main.skill_cd_labels[0]
	update_cooldown_ui(main)

static func _skill_label(tag: String) -> String:
	if tag.length() <= 2:
		return tag
	if tag.contains(" "):
		var parts := tag.split(" ")
		return "%s\n%s" % [str(parts[0]), str(parts[1])]
	return tag.substr(0, 2)

static func _active_skill_tags(main) -> Array:
	if main.active_slot >= 0 and main.active_slot < main.hero_skill_tags.size():
		return main.hero_skill_tags[main.active_slot]
	if main.active_slot >= 0 and main.active_slot < main.hero_tags.size():
		return [main.hero_tags[main.active_slot]]
	return []

static func _ensure_active_skill_cooldowns(main) -> void:
	while main.hero_skill_cooldowns.size() <= main.active_slot:
		main.hero_skill_cooldowns.append([])
	var tags := _active_skill_tags(main)
	var cooldowns: Array = main.hero_skill_cooldowns[main.active_slot]
	while cooldowns.size() < tags.size():
		cooldowns.append(0.0)
	main.hero_skill_cooldowns[main.active_slot] = cooldowns

static func _active_skill_cooldown(main, skill_index: int) -> float:
	if main.active_slot < 0 or main.active_slot >= main.hero_skill_cooldowns.size():
		return main.skill_cooldown if skill_index == 0 else 0.0
	var cooldowns: Array = main.hero_skill_cooldowns[main.active_slot]
	if skill_index < 0 or skill_index >= cooldowns.size():
		return 0.0
	return float(cooldowns[skill_index])

static func _in_stick_area(pos: Vector2) -> bool:
	return pos.distance_to(STICK_CENTER) <= STICK_RADIUS * 1.25

static func _set_stick_vector(main, pos: Vector2) -> void:
	var offset := pos - STICK_CENTER
	var length := offset.length()
	if length < STICK_DEADZONE:
		main.touch_move_dir = Vector2.ZERO
	else:
		main.touch_move_dir = offset.limit_length(STICK_RADIUS) / STICK_RADIUS
	_update_knob(main, offset)

static func _release_stick(main) -> void:
	main.touch_move_dir = Vector2.ZERO
	main.touch_active_id = -1
	if main.joystick_knob:
		main.joystick_knob.position = Vector2(58, 58)

static func _update_knob(main, offset: Vector2) -> void:
	if main.joystick_knob == null:
		return
	var knob_offset := offset.limit_length(STICK_RADIUS - 24.0)
	main.joystick_knob.position = Vector2(58, 58) + knob_offset

static func _update_switch_flash(main) -> void:
	for i in range(main.hero_nodes.size()):
		if main.hero_nodes[i] == null:
			continue
		main.hero_nodes[i].modulate = Color("#ffffff")
	if main.switch_flash_timer > 0.0 and main.active_slot < main.hero_nodes.size():
		var pulse := 0.55 + sin(main.switch_flash_timer * 32.0) * 0.25
		main.hero_nodes[main.active_slot].modulate = Color(1.0, 1.0, pulse, 1.0)

static func _show_pause_overlay(main) -> void:
	if main.pause_overlay and is_instance_valid(main.pause_overlay):
		return
	var overlay := ColorRect.new()
	overlay.name = "PauseOverlay"
	overlay.position = Vector2.ZERO
	overlay.size = main.VIEW_SIZE
	overlay.color = Color("#050812aa")
	main.battle_root.add_child(overlay)
	var box: Control = main.framed_panel(overlay, Vector2(560, 310), Vector2(480, 260), Color("#111827ee"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(box, "일시정지", Vector2(0, 32), Vector2(480, 54), 36, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	main.divider(box, Vector2(120, 86), Vector2(240, 24), Color("#d2bc82"))
	main.label(box, "전투가 멈췄습니다.", Vector2(0, 96), Vector2(480, 34), 20, Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)
	main.button(box, "계속", Vector2(140, 158), Vector2(200, 64), Callable(main, "toggle_pause"), 26, Color("#2f8cff"), "button_blue")
	main.pause_overlay = overlay
