extends RefCounted

const GameData := preload("res://scripts/game_data.gd")

static func show(main) -> void:
	var root: Control = main.screen_root()
	var bg := ColorRect.new()
	bg.size = main.VIEW_SIZE
	bg.color = Color("#0d1424")
	root.add_child(bg)

	main.button(root, "← 홈", Vector2(32, 26), Vector2(112, 48), func(): main.show_home(), 20, Color("#26334d"), "button_blue")
	main.label(root, "파티 편성", Vector2(174, 28), Vector2(250, 48), 34)
	var chips: Array[String] = GameData.synergy_for_party(main.party_indices)
	for i in range(chips.size()):
		main.tag_chip(root, chips[i], Vector2(440 + i * 164, 34), Color("#ffd24a") if chips[i].contains("조합") else Color("#76d7ff"))

	var slots_frame: Control = main.framed_panel(root, Vector2(70, 130), Vector2(850, 520), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(slots_frame, "편성 슬롯", Vector2(34, 26), Vector2(220, 34), 28)
	main.divider(slots_frame, Vector2(34, 68), Vector2(300, 26), Color("#d2bc82"))
	for i in range(4):
		var h := GameData.hero(main.party_indices[i])
		var card: Control = main.framed_panel(root, Vector2(108 + i * 196, 236), Vector2(166, 260), Color("#101827e8"), "fantasy_border", Color("#ffffff") if i == main.active_slot else Color("#8f9bb3"), 14)
		main.pixel_art(card, h.sprite, Vector2(35, 32), Vector2(96, 110), Color(h.color))
		main.label(card, "%d" % (i + 1), Vector2(8, 8), Vector2(36, 26), 18, Color("#9fb0d0"))
		main.label(card, h.name, Vector2(16, 154), Vector2(134, 30), 24, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		main.label(card, "조작" if i == main.active_slot else "AI", Vector2(16, 188), Vector2(134, 24), 18, Color("#ffd24a") if i == main.active_slot else Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)
		main.button(card, "지정", Vector2(36, 216), Vector2(94, 34), Callable(main, "set_active_slot").bind(i), 16, Color("#364764"), "button_blue")

	main.label(root, "선택 슬롯 AI 프리셋", Vector2(108, 530), Vector2(230, 30), 22)
	for i in range(3):
		var preset: String = ["공격", "균형", "방어"][i]
		main.button(root, preset, Vector2(340 + i * 120, 526), Vector2(102, 42), Callable(main, "set_ai_preset").bind(preset), 18, Color("#f05a28") if main.ai_presets[main.active_slot] == preset else Color("#33415c"), "button_red" if main.ai_presets[main.active_slot] == preset else "button_blue")
	main.button(root, "전용 장비 보기", Vector2(706, 526), Vector2(160, 42), func(): main.show_message("전용 장비 슬롯은 다음 구현 단계에서 연결합니다."), 18, Color("#33415c"), "button_blue")

	var roster_frame: Control = main.framed_panel(root, Vector2(980, 130), Vector2(540, 520), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(roster_frame, "보유 캐릭터", Vector2(34, 26), Vector2(220, 34), 28)
	main.divider(roster_frame, Vector2(34, 68), Vector2(300, 26), Color("#d2bc82"))
	for i in range(GameData.HEROES.size()):
		var h := GameData.hero(i)
		var x := 1016 + (i % 3) * 160
		var y := 220 + int(i / 3) * 168
		var b: Button = main.button(root, "", Vector2(x, y), Vector2(132, 132), Callable(main, "set_party_member").bind(i), 18, Color("#111827"))
		var roster_border: Control = main.framed_panel(root, Vector2(x, y), Vector2(132, 132), Color("#00000000"), "fantasy_border", Color("#8f9bb3"), 14)
		roster_border.mouse_filter = Control.MOUSE_FILTER_IGNORE
		main.pixel_art(b, h.sprite, Vector2(30, 10), Vector2(72, 72), Color(h.color))
		main.label(b, h.name, Vector2(8, 80), Vector2(116, 24), 18, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		main.label(b, h.tag, Vector2(8, 102), Vector2(116, 20), 13, Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)

	main.button(root, "출격 확인으로", Vector2(1190, 718), Vector2(290, 72), func(): main.show_launch_confirm(), 26, Color("#f05a28"), "button_red")

static func show_launch_confirm(main) -> void:
	var root: Control = main.screen_root()
	var bg := ColorRect.new()
	bg.size = main.VIEW_SIZE
	bg.color = Color("#0d1424")
	root.add_child(bg)
	main.button(root, "← 편성", Vector2(32, 26), Vector2(124, 48), func(): main.show_party(), 20, Color("#26334d"), "button_blue")
	main.label(root, "출격 직전 확인", Vector2(190, 28), Vector2(320, 48), 34)
	main.label(root, "싱글 플레이: 1명 직접 조작 + 3명 AI. 전투 중 파티 패널 탭으로 전환합니다.", Vector2(96, 104), Vector2(900, 34), 22, Color("#b7c6e4"))

	for i in range(4):
		var h := GameData.hero(main.party_indices[i])
		var card: Control = main.framed_panel(root, Vector2(96 + i * 350, 190), Vector2(300, 400), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
		main.pixel_art(card, h.sprite, Vector2(78, 36), Vector2(144, 148), Color(h.color))
		main.label(card, h.name, Vector2(24, 202), Vector2(252, 34), 28, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		main.label(card, h.role, Vector2(24, 242), Vector2(252, 28), 18, Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)
		main.tag_chip(card, h.tag, Vector2(74, 288), GameData.color_for_tag(h.tag))
		main.label(card, "AI: %s" % main.ai_presets[i], Vector2(24, 338), Vector2(252, 28), 18, Color("#ffd24a") if i != main.active_slot else Color("#8ee6ff"), HORIZONTAL_ALIGNMENT_CENTER)

	main.button(root, "전투 시작", Vector2(1196, 720), Vector2(300, 76), func(): main.start_battle(), 30, Color("#f05a28"), "button_red")
