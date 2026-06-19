extends Node

const GameData := preload("res://scripts/game_data.gd")
const BattleController := preload("res://scripts/battle_controller.gd")
const SaveData := preload("res://scripts/save_data.gd")
const TouchInput := preload("res://scripts/touch_input.gd")
const AudioManager := preload("res://scripts/audio_manager.gd")
const TutorialFlow := preload("res://scripts/tutorial_flow.gd")
const HomeScreen := preload("res://scripts/screens/home_screen.gd")
const PartyScreen := preload("res://scripts/screens/party_screen.gd")
const ResultScreen := preload("res://scripts/screens/result_screen.gd")

const VIEW_SIZE := Vector2(1600, 900)
const SAFE_MARGIN := 24.0

var party_indices := [0, 1, 2, 3]
var active_slot := 0
var ai_presets := ["균형", "균형", "방어", "공격"]
var currencies := {"gold": 12840, "gem": 760, "material": 324}
var meta_hero_levels := [1, 1, 1, 1, 1, 1]
var equipment := {"common_slots": [], "hero_slots": {}}
var onboarding_state := {"first_session_complete": false, "move_seen": false, "dash_seen": false, "switch_seen": false, "level_up_seen": false, "fusion_seen": false}
var last_run_rewards := {"gold": 0, "material": 0, "meta_xp": 0}
var result_applied := false

var battle_running := false
var paused := false
var battle_root: Control
var arena: Control
var party_buttons: Array[Button] = []
var hero_nodes: Array[Control] = []
var hero_labels: Array[Label] = []
var hero_hp: Array[float] = []
var hero_levels := [1, 1, 1, 1]
var hero_xp: Array[float] = [0.0, 0.0, 0.0, 0.0]
var hero_next_xp: Array[float] = [80.0, 80.0, 80.0, 80.0]
var hero_tags := ["", "", "", ""]
var hero_pos: Array[Vector2] = []
var enemies: Array[Dictionary] = []
var projectiles: Array[Dictionary] = []
var effects: Array[Dictionary] = []
var battle_time := 0.0
var wave := 1
var spawn_timer := 0.0
var attack_timer := 0.0
var boss_spawned := false
var boss_alive := false
var touch_move_dir := Vector2.ZERO
var touch_active_id := -1
var touch_mouse_active := false
var joystick_base: Panel
var joystick_knob: Panel
var dash_button: Button
var skill_button: Button
var pause_button: Button
var dash_cd_label: Label
var skill_cd_label: Label
var dash_cooldown := 0.0
var skill_cooldown := 0.0
var invuln_timer := 0.0
var switch_flash_timer := 0.0
var pause_overlay: Control
var tutorial_panel: Control
var tutorial_title_label: Label
var tutorial_body_label: Label
var bgm_player: AudioStreamPlayer
var sfx_players: Array[AudioStreamPlayer] = []
var low_hp_warned := false
var switch_cd: Array[float] = [0.0, 0.0, 0.0, 0.0]
var timer_label: Label
var wave_label: Label
var xp_bar: ProgressBar

func _ready() -> void:
	get_viewport().size = Vector2i(VIEW_SIZE)
	AudioManager.setup(self)
	load_game()
	show_home()

func _process(delta: float) -> void:
	if not battle_running:
		return
	BattleController.update(self, delta)

func _input(event: InputEvent) -> void:
	if battle_root == null:
		return
	TouchInput.handle_input(self, event)

func set_active_slot(slot: int) -> void:
	active_slot = slot
	save_game()
	show_party()

func set_ai_preset(preset: String) -> void:
	ai_presets[active_slot] = preset
	save_game()
	show_party()

func set_party_member(hero_index: int) -> void:
	party_indices[active_slot] = hero_index
	save_game()
	show_party()

func clear_screen() -> void:
	battle_running = false
	paused = false
	for child in get_children():
		var is_audio_child := child == bgm_player
		for player: AudioStreamPlayer in sfx_players:
			if child == player:
				is_audio_child = true
				break
		if is_audio_child:
			continue
		child.free()
	party_buttons.clear()
	hero_nodes.clear()
	hero_labels.clear()
	enemies.clear()
	projectiles.clear()
	effects.clear()
	touch_move_dir = Vector2.ZERO
	touch_active_id = -1
	touch_mouse_active = false
	joystick_base = null
	joystick_knob = null
	dash_button = null
	skill_button = null
	pause_button = null
	dash_cd_label = null
	skill_cd_label = null
	pause_overlay = null
	tutorial_panel = null
	tutorial_title_label = null
	tutorial_body_label = null

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

func panel(parent: Control, pos: Vector2, size: Vector2, color: Color = Color("#172033d8"), radius: int = 8) -> Panel:
	var p := Panel.new()
	p.position = pos
	p.size = size
	p.add_theme_stylebox_override("panel", style(color, radius, Color("#35415e"), 1))
	parent.add_child(p)
	return p

func pixel_art(parent: Control, texture_path: String, pos: Vector2, size: Vector2, fallback_color: Color = Color("#f4f7ff")) -> Control:
	var image := Image.new()
	var load_error := image.load(ProjectSettings.globalize_path(texture_path))
	if load_error == OK:
		var sprite := TextureRect.new()
		sprite.texture = ImageTexture.create_from_image(image)
		sprite.position = pos
		sprite.size = size
		sprite.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
		parent.add_child(sprite)
		return sprite

	var fallback := ColorRect.new()
	fallback.position = pos
	fallback.size = size
	fallback.color = fallback_color
	parent.add_child(fallback)
	return fallback

func texture_from_path(texture_path: String) -> Texture2D:
	var image := Image.new()
	var load_error := image.load(ProjectSettings.globalize_path(texture_path))
	if load_error != OK:
		return null
	return ImageTexture.create_from_image(image)

func framed_panel(parent: Control, pos: Vector2, size: Vector2, fill := Color("#101827dd"), frame := "fantasy_panel", tint := Color("#f3d38a"), margin: int = 16) -> Control:
	var c := Control.new()
	c.position = pos
	c.size = size
	parent.add_child(c)
	var bg := ColorRect.new()
	bg.position = Vector2(9, 9)
	bg.size = size - Vector2(18, 18)
	bg.color = fill
	c.add_child(bg)
	var border := NinePatchRect.new()
	border.texture = texture_from_path(GameData.ui_asset(frame))
	border.position = Vector2.ZERO
	border.size = size
	border.draw_center = false
	border.patch_margin_left = margin
	border.patch_margin_top = margin
	border.patch_margin_right = margin
	border.patch_margin_bottom = margin
	border.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	border.modulate = tint
	c.add_child(border)
	return c

func divider(parent: Control, pos: Vector2, size: Vector2, tint := Color("#f3d38a")) -> TextureRect:
	var d := TextureRect.new()
	d.texture = texture_from_path(GameData.ui_asset("fantasy_divider_fade"))
	d.position = pos
	d.size = size
	d.stretch_mode = TextureRect.STRETCH_SCALE
	d.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	d.modulate = tint
	parent.add_child(d)
	return d

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

func button(parent: Control, text: String, pos: Vector2, size: Vector2, pressed: Callable, font_size: int = 24, bg := Color("#2f8cff"), skin: String = "") -> Button:
	if skin != "":
		var skin_node := pixel_art(parent, GameData.ui_asset(skin), pos, size, bg)
		if skin_node is TextureRect:
			(skin_node as TextureRect).stretch_mode = TextureRect.STRETCH_SCALE
	var b := Button.new()
	b.text = text
	b.position = pos
	b.size = size
	b.focus_mode = Control.FOCUS_NONE
	b.add_theme_font_size_override("font_size", font_size)
	var normal_bg := Color.TRANSPARENT if skin != "" else bg
	b.add_theme_stylebox_override("normal", style(normal_bg, 8))
	b.add_theme_stylebox_override("hover", style(normal_bg, 8))
	b.add_theme_stylebox_override("pressed", style(normal_bg, 8))
	b.add_theme_stylebox_override("disabled", style(Color("#566070"), 8))
	b.pressed.connect(func():
		play_sfx("ui_click", -12.0, 0.04)
		pressed.call()
	)
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
	play_music("main")
	HomeScreen.show(self)

func show_meta_tab(tab_name: String) -> void:
	HomeScreen.show_meta_tab(self, tab_name)

func show_party() -> void:
	PartyScreen.show(self)

func show_launch_confirm() -> void:
	PartyScreen.show_launch_confirm(self)

func start_battle() -> void:
	play_music("battle")
	BattleController.start(self)

func draw_dungeon_map() -> void:
	BattleController.draw_dungeon_map(self)

func _update_battle(delta: float) -> void:
	BattleController.update(self, delta)

func spawn_enemy() -> void:
	BattleController.spawn_enemy(self)

func closest_hero(pos: Vector2) -> int:
	return BattleController.closest_hero(self, pos)

func hit_nearest_enemy(slot: int) -> void:
	BattleController.hit_nearest_enemy(self, slot)

func distribute_xp(amount: float) -> void:
	BattleController.distribute_xp(self, amount)

func process_level_ups() -> bool:
	return BattleController.process_level_ups(self)

func auto_choose_level(slot: int) -> void:
	BattleController.auto_choose_level(self, slot)

func try_switch(slot: int) -> void:
	BattleController.try_switch(self, slot)

func dash_active() -> void:
	BattleController.dash_active(self)

func use_skill() -> void:
	BattleController.use_skill(self)

func toggle_pause() -> void:
	TouchInput.toggle_pause(self)

func update_battle_ui() -> void:
	BattleController.update_ui(self)

func show_level_up(slot: int) -> void:
	BattleController.show_level_up(self, slot)

func pick_level_choices() -> Array:
	return BattleController.pick_level_choices()

func choose_level(choice: Dictionary, overlay_node: Control, slot: int) -> void:
	BattleController.choose_level(self, choice, overlay_node, slot)

func apply_level_choice(slot: int, choice: Dictionary) -> void:
	BattleController.apply_level_choice(self, slot, choice)

func tutorial_mark(key: String) -> void:
	TutorialFlow.mark(self, key)

func show_result(victory: bool) -> void:
	ResultScreen.show(self, victory)

func play_music(key: String) -> void:
	AudioManager.play_music(self, key)

func play_sfx(key: String, volume_db: float = -8.0, pitch_jitter: float = 0.0) -> void:
	AudioManager.play_sfx(self, key, volume_db, pitch_jitter)

func load_game() -> void:
	SaveData.load_into(self)

func save_game() -> void:
	SaveData.save_from(self)

func reset_save() -> void:
	SaveData.reset(self)

func apply_run_result(victory: bool) -> void:
	SaveData.apply_run_result(self, victory)

func show_message(message: String) -> void:
	var root: Control = battle_root if battle_root != null and is_instance_valid(battle_root) else null
	if root == null:
		for child in get_children():
			if child is Control:
				root = child
				break
	if root == null:
		return
	var toast := panel(root, Vector2(500, 396), Vector2(600, 108), Color("#111827ee"))
	label(toast, message, Vector2(24, 24), Vector2(552, 54), 22, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	var timer := get_tree().create_timer(1.4)
	timer.timeout.connect(func(): if is_instance_valid(toast): toast.queue_free())
