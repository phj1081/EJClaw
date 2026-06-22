extends SceneTree

const TouchInput := preload("res://scripts/touch_input.gd")

func _initialize() -> void:
	OS.set_environment("RUNEFALL_SAVE_PATH", "user://runefall_touch_save.json")
	call_deferred("_run")

func _run() -> void:
	_cleanup_save()

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
	if main.skill_buttons.size() != 1 or main.hero_skill_tags[main.active_slot].size() != 1:
		push_error("Initial dynamic skill buttons did not match base skill count.")
		quit(1)
		return
	if main.dash_button.size.x < 120.0 or main.dash_button.size.y < 120.0:
		push_error("Dash button should be the large anchor control.")
		quit(1)
		return

	var touch := InputEventScreenTouch.new()
	touch.index = 1
	touch.position = Vector2(214, 770)
	touch.pressed = true
	TouchInput.handle_input(main, touch)
	if main.touch_move_dir.length() <= 0.1:
		push_error("Virtual stick touch did not set movement direction.")
		quit(1)
		return

	var drag := InputEventScreenDrag.new()
	drag.index = 1
	drag.position = Vector2(154, 688)
	TouchInput.handle_input(main, drag)
	if main.touch_move_dir.y >= -0.1:
		push_error("Virtual stick drag did not update direction: %s" % main.touch_move_dir)
		quit(1)
		return

	touch.pressed = false
	TouchInput.handle_input(main, touch)
	if main.touch_move_dir != Vector2.ZERO:
		push_error("Virtual stick release did not clear direction.")
		quit(1)
		return

	main.touch_move_dir = Vector2.RIGHT
	var before_dash: Vector2 = main.hero_pos[main.active_slot]
	main.dash_active()
	if main.dash_cooldown <= 0.0 or main.invuln_timer <= 0.0 or main.hero_pos[main.active_slot].x <= before_dash.x:
		push_error("Dash cooldown, invuln, or movement failed.")
		quit(1)
		return

	main.use_skill()
	if main.skill_cooldown <= 0.0:
		push_error("Skill cooldown was not set.")
		quit(1)
		return
	main.skill_cooldown = 0.0
	main.hero_skill_cooldowns[main.active_slot][0] = 0.0
	main.apply_level_choice(main.active_slot, {"name": "중력 파동", "kind": "스킬", "tag": "중력", "desc": "근처 적을 느리게 함"})
	await process_frame
	if main.skill_buttons.size() != 2 or main.hero_skill_tags[main.active_slot].size() != 2:
		push_error("Skill button did not grow after gaining a skill: %s" % [main.hero_skill_tags])
		quit(1)
		return
	var effects_before: int = main.effects.size()
	main.use_skill(1)
	if main.effects.size() <= effects_before or float(main.hero_skill_cooldowns[main.active_slot][1]) <= 0.0:
		push_error("Second skill button did not trigger effect and cooldown.")
		quit(1)
		return

	main.try_switch(1)
	if main.active_slot != 1 or main.invuln_timer <= 0.0 or main.switch_flash_timer <= 0.0:
		push_error("Switch feedback or invuln failed.")
		quit(1)
		return

	main.toggle_pause()
	if not main.paused:
		push_error("Pause did not activate.")
		quit(1)
		return
	main.toggle_pause()
	if main.paused:
		push_error("Pause did not resume.")
		quit(1)
		return

	print("RUNEFALL_TOUCH_OK")
	_cleanup_save()
	quit(0)

func _cleanup_save() -> void:
	var save_path := OS.get_environment("RUNEFALL_SAVE_PATH")
	if FileAccess.file_exists(save_path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(save_path))
