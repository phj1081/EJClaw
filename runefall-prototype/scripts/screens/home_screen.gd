extends RefCounted

const GameData = preload("res://scripts/game_data.gd")

static func show(main) -> void:
	var root: Control = main.screen_root()
	root.add_theme_stylebox_override("panel", main.style(Color("#0c1220")))

	var bg: ColorRect = ColorRect.new()
	bg.size = main.VIEW_SIZE
	bg.color = Color("#111a2c")
	root.add_child(bg)

	for i in range(12):
		var prop: Control = main.pixel_art(root, GameData.prop_tile(i), Vector2(76 + i * 128, 146 + (i % 4) * 92), Vector2(54, 54), Color("#1f3751"))
		prop.modulate = Color(1, 1, 1, 0.22)

	main.label(root, "RUNEFALL", Vector2(40, 24), Vector2(260, 44), 34, Color("#ffffff"))
	main.label(root, "Lv.12 암석 거점", Vector2(42, 68), Vector2(260, 34), 18, Color("#a7b7d5"))
	var resource_keys: Array[String] = ["gold", "gem", "material"]
	var resource_labels: Array[String] = ["골드", "젬", "소재"]
	for i in range(3):
		var key: String = resource_keys[i]
		var text: String = resource_labels[i]
		var chip: Control = main.framed_panel(root, Vector2(1012 + i * 138, 26), Vector2(126, 42), Color("#111827e8"), "fantasy_border_banner", Color("#c4d7ff"), 12)
		main.label(chip, "%s %d" % [text, int(main.currencies[key])], Vector2(10, 4), Vector2(106, 32), 17, Color("#ffe28a"), HORIZONTAL_ALIGNMENT_CENTER)
	main.button(root, "우편", Vector2(1454, 26), Vector2(104, 48), func(): main.show_message("우편함은 후속 구현 영역입니다."), 18, Color("#24314a"), "button_blue")

	var party_frame: Control = main.framed_panel(root, Vector2(56, 126), Vector2(1044, 626), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(party_frame, "현재 파티", Vector2(34, 28), Vector2(260, 36), 28)
	main.divider(party_frame, Vector2(32, 70), Vector2(360, 28), Color("#d2bc82"))
	main.label(party_frame, "편성, 시너지, 출격 준비를 한 화면에서 확인합니다.", Vector2(34, 100), Vector2(560, 30), 18, Color("#9fb0d0"))

	for i in range(4):
		var h: Dictionary = GameData.hero(main.party_indices[i])
		var card: Control = main.framed_panel(root, Vector2(120 + i * 232, 310 + (i % 2) * 76), Vector2(168, 220), Color("#101827e8"), "fantasy_border", Color("#ffffff") if i == main.active_slot else Color("#8f9bb3"), 14)
		main.pixel_art(card, h.sprite, Vector2(36, 26), Vector2(96, 106), Color(h.color))
		main.label(card, h.name, Vector2(18, 140), Vector2(132, 28), 24, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
		var meta_level: int = int(main.meta_hero_levels[main.party_indices[i]]) if main.party_indices[i] < main.meta_hero_levels.size() else 1
		main.label(card, "Lv.%d  %s" % [meta_level, h.role], Vector2(10, 170), Vector2(148, 24), 16, Color("#b9c7e3"), HORIZONTAL_ALIGNMENT_CENTER)
		if i == main.active_slot:
			main.tag_chip(card, "조작", Vector2(48, 10), Color("#ffd24a"))

	for i in range(5):
		var tab_labels: Array[String] = ["홈", "캐릭터", "장비/제작", "상점", "도감·시련"]
		var tab_text: String = tab_labels[i]
		main.button(root, tab_text, Vector2(56 + i * 142, 794), Vector2(132, 58), Callable(main, "show_meta_tab").bind(tab_text), 18, Color("#202b43"), "button_blue")

	var mission: Control = main.framed_panel(root, Vector2(1140, 134), Vector2(370, 192), Color("#121c31e8"), "fantasy_panel_banner", Color("#c4d7ff"), 14)
	main.pixel_art(root, GameData.ui_asset("check_green"), Vector2(1458, 168), Vector2(30, 30), Color("#21a67a"))
	main.label(mission, "일일 미션", Vector2(32, 28), Vector2(180, 34), 26)
	main.label(mission, "런 1회 완료\n화염 태그 무기 3회 선택\n보상 2배 광고 준비", Vector2(32, 76), Vector2(292, 88), 19, Color("#c9d5ee"))
	var season_panel: Control = main.framed_panel(root, Vector2(1140, 354), Vector2(370, 162), Color("#121c31e8"), "fantasy_panel_banner", Color("#c4d7ff"), 14)
	main.pixel_art(root, GameData.ui_asset("star_yellow"), Vector2(1452, 382), Vector2(34, 34), Color("#ffd24a"))
	main.label(season_panel, "시즌 패스", Vector2(32, 24), Vector2(180, 34), 26)
	main.label(season_panel, "서리 균열 시즌 12일 남음", Vector2(32, 72), Vector2(290, 32), 19, Color("#c9d5ee"))
	main.button(root, "파티 편성", Vector2(1138, 574), Vector2(178, 74), func(): main.show_party(), 24, Color("#45536f"), "button_blue")
	main.button(root, "출격", Vector2(1332, 574), Vector2(178, 74), func(): main.show_launch_confirm(), 28, Color("#f05a28"), "button_red")

static func show_meta_tab(main, tab_name: String) -> void:
	var root: Control = main.screen_root()
	var bg: ColorRect = ColorRect.new()
	bg.size = main.VIEW_SIZE
	bg.color = Color("#0f1726")
	root.add_child(bg)
	main.button(root, "← 홈", Vector2(36, 28), Vector2(120, 50), func(): main.show_home(), 20, Color("#26334d"), "button_blue")
	main.label(root, tab_name, Vector2(190, 30), Vector2(360, 50), 34)

	if tab_name == "캐릭터":
		for i in range(GameData.HEROES.size()):
			var h: Dictionary = GameData.hero(i)
			var x: int = 78 + (i % 3) * 480
			var y: int = 150 + int(i / 3) * 250
			var card: Panel = main.panel(root, Vector2(x, y), Vector2(390, 200), Color("#172033"))
			main.pixel_art(card, h.sprite, Vector2(24, 20), Vector2(92, 118), Color(h.color))
			main.label(card, h.name, Vector2(136, 24), Vector2(200, 34), 28)
			var meta_level: int = int(main.meta_hero_levels[i]) if i < main.meta_hero_levels.size() else 1
			main.label(card, "Lv.%d  %s / %s" % [meta_level, h.role, h.weapon], Vector2(136, 64), Vector2(220, 32), 18, Color("#b7c6e4"))
			main.tag_chip(card, h.tag, Vector2(136, 110), GameData.color_for_tag(h.tag))
			main.label(card, "승급, 전용 슬롯, 코스튬은 다음 단계에서 실제 수치 연결", Vector2(22, 154), Vector2(340, 32), 16, Color("#93a4c6"))
	else:
		main.label(root, "%s 화면 와이어프레임" % tab_name, Vector2(86, 160), Vector2(600, 44), 32)
		main.label(root, "확정형 구매, 제작, 도감, 시즌 콘텐츠의 상세 리스트를 배치할 자리입니다.", Vector2(86, 220), Vector2(820, 36), 22, Color("#b7c6e4"))
		for i in range(6):
			main.panel(root, Vector2(86 + i * 240, 330), Vector2(200, 230), Color("#172033"))
			main.label(root, "슬롯 %d" % (i + 1), Vector2(112 + i * 240, 362), Vector2(150, 34), 22)
