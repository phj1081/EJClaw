extends RefCounted

const GameData := preload("res://scripts/game_data.gd")
const STEP_ORDER := ["move_seen", "dash_seen", "switch_seen", "level_up_seen", "fusion_seen"]
const STEP_TEXT := {
	"move_seen": ["이동", "왼쪽 스틱을 드래그해서 루나를 움직이세요."],
	"dash_seen": ["대시", "오른쪽 대시 버튼으로 위험 지역을 빠르게 벗어나세요."],
	"switch_seen": ["전환", "좌측 파티 패널에서 다른 영웅을 눌러 조작 대상을 바꾸세요."],
	"level_up_seen": ["레벨업", "카드 하나를 선택해 현재 조작 영웅의 빌드를 강화하세요."],
	"fusion_seen": ["융합", "서로 맞는 태그를 고르면 강력한 융합 공격이 열립니다."]
}

static func start_battle(main) -> void:
	clear(main)
	if _tutorial_done(main):
		return
	show_next(main)

static func mark(main, key: String) -> void:
	if _tutorial_done(main) or bool(main.onboarding_state.get(key, false)):
		return
	main.onboarding_state[key] = true
	main.save_game()
	show_next(main)

static func on_level_up_shown(main) -> void:
	if _tutorial_done(main):
		return
	if not bool(main.onboarding_state.get("level_up_seen", false)):
		main.onboarding_state.level_up_seen = true
		main.save_game()
	_show_prompt(main, "레벨업", "카드를 골라 무기 태그를 바꾸면 융합 후보가 생깁니다.", 4)

static func on_fusion(main, fusion_name: String) -> void:
	if _tutorial_done(main):
		return
	if bool(main.onboarding_state.get("fusion_seen", false)):
		return
	main.onboarding_state.fusion_seen = true
	main.save_game()
	_show_prompt(main, "융합 발동", "%s 공격이 열렸습니다. 자동 공격 패턴이 바뀝니다." % fusion_name, 5)

static func maybe_force_fusion_choice(main, slot: int, choices: Array) -> Array:
	if _tutorial_done(main) or bool(main.onboarding_state.get("fusion_seen", false)):
		return choices
	var current_tag: String = main.hero_tags[slot]
	for choice in choices:
		if GameData.fusion_name(current_tag, choice.tag) != "":
			return choices
	for candidate in GameData.LEVEL_CHOICES:
		if GameData.fusion_name(current_tag, candidate.tag) != "":
			choices[0] = candidate
			return choices
	return choices

static func show_next(main) -> void:
	if _tutorial_done(main):
		clear(main)
		return
	for i in range(STEP_ORDER.size()):
		var key: String = STEP_ORDER[i]
		if not bool(main.onboarding_state.get(key, false)):
			var text: Array = STEP_TEXT[key]
			_show_prompt(main, text[0], text[1], i + 1)
			return
	clear(main)

static func clear(main) -> void:
	if main.tutorial_panel and is_instance_valid(main.tutorial_panel):
		main.tutorial_panel.queue_free()
	main.tutorial_panel = null
	main.tutorial_title_label = null
	main.tutorial_body_label = null

static func _tutorial_done(main) -> bool:
	return bool(main.onboarding_state.get("first_session_complete", false))

static func _show_prompt(main, title: String, body: String, step_number: int) -> void:
	if main.battle_root == null or not is_instance_valid(main.battle_root):
		return
	if main.tutorial_panel and is_instance_valid(main.tutorial_panel):
		main.tutorial_panel.queue_free()

	var panel: Control = main.framed_panel(main.battle_root, Vector2(430, 760), Vector2(740, 104), Color("#101827ee"), "fantasy_border_banner", Color("#f0d28a"), 12)
	panel.name = "TutorialPanel"
	main.label(panel, "FTUE %d/5 · %s" % [step_number, title], Vector2(24, 10), Vector2(220, 28), 18, Color("#ffd24a"))
	main.label(panel, body, Vector2(24, 40), Vector2(690, 42), 20, Color("#f4f7ff"), HORIZONTAL_ALIGNMENT_LEFT)
	main.tutorial_panel = panel
	panel.move_to_front()
