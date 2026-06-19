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
	_draw_resource_bar(main, root)

	if tab_name == "캐릭터":
		_show_character_roster(main, root)
	elif tab_name == "장비/제작":
		_show_equipment_crafting(main, root)
	elif tab_name == "상점":
		_show_shop(main, root)
	else:
		_show_codex_trials(main, root)

static func show_character_detail(main, hero_index: int) -> void:
	var root: Control = main.screen_root()
	var bg := ColorRect.new()
	bg.size = main.VIEW_SIZE
	bg.color = Color("#0f1726")
	root.add_child(bg)
	main.button(root, "← 목록", Vector2(36, 28), Vector2(132, 50), func(): main.show_meta_tab("캐릭터"), 20, Color("#26334d"), "button_blue")
	_draw_resource_bar(main, root)

	var h := GameData.hero(hero_index)
	var level: int = int(main.meta_hero_levels[hero_index]) if hero_index < main.meta_hero_levels.size() else 1
	var gold_cost := 220 + level * 80
	var material_cost := 12 + level * 4
	var hero_panel: Control = main.framed_panel(root, Vector2(80, 126), Vector2(560, 650), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(hero_panel, h.name, Vector2(38, 28), Vector2(260, 42), 34)
	main.divider(hero_panel, Vector2(36, 74), Vector2(330, 26), Color("#d2bc82"))
	main.pixel_art(hero_panel, h.sprite, Vector2(68, 122), Vector2(180, 210), Color(h.color))
	main.tag_chip(hero_panel, h.tag, Vector2(300, 132), GameData.color_for_tag(h.tag))
	main.label(hero_panel, "Lv.%d  %s" % [level, h.role], Vector2(300, 178), Vector2(220, 30), 24, Color("#ffffff"))
	main.label(hero_panel, "무기: %s\nHP: %d\n이동 속도: %d" % [h.weapon, int(h.hp), int(h.speed)], Vector2(300, 224), Vector2(220, 108), 20, Color("#c9d5ee"))
	main.label(hero_panel, "다음 승급 비용", Vector2(58, 388), Vector2(240, 30), 24, Color("#ffd24a"))
	main.label(hero_panel, "골드 %d / 소재 %d" % [gold_cost, material_cost], Vector2(58, 426), Vector2(260, 30), 20, Color("#c9d5ee"))
	main.button(hero_panel, "승급", Vector2(330, 398), Vector2(150, 64), Callable(main, "upgrade_hero").bind(hero_index), 24, Color("#f05a28"), "button_red")
	main.button(hero_panel, "파티에 지정", Vector2(58, 520), Vector2(190, 56), func():
		main.set_party_member(hero_index)
		main.show_party()
	, 20, Color("#2f8cff"))

	var equip_panel: Control = main.framed_panel(root, Vector2(700, 126), Vector2(760, 650), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(equip_panel, "전용 성장", Vector2(38, 28), Vector2(260, 42), 30)
	main.divider(equip_panel, Vector2(36, 72), Vector2(330, 26), Color("#d2bc82"))
	main.label(equip_panel, "현재는 프로토타입용 수치입니다. 승급은 저장되고 전투 보상 성장과 함께 누적됩니다.", Vector2(40, 104), Vector2(610, 56), 20, Color("#b7c6e4"))
	var slots: Array = main.equipment.get("common_slots", [])
	for i in range(4):
		var item: Dictionary = slots[i] if i < slots.size() else {}
		var y := 190 + i * 92
		var slot_panel: Control = main.framed_panel(equip_panel, Vector2(44, y), Vector2(640, 70), Color("#101827cc"), "fantasy_border_banner", Color("#8f9bb3"), 12)
		var label_text := "빈 공용 슬롯"
		if not item.is_empty():
			label_text = "%s  +%s 빌드" % [str(item.name), str(item.tag)]
		main.label(slot_panel, label_text, Vector2(26, 12), Vector2(420, 32), 20, Color("#ffffff"))
		if not item.is_empty():
			main.tag_chip(slot_panel, str(item.rarity), Vector2(480, 18), GameData.color_for_tag(str(item.tag)))

static func _show_character_roster(main, root: Control) -> void:
	main.label(root, "보유 캐릭터", Vector2(80, 106), Vector2(320, 44), 30)
	for i in range(GameData.HEROES.size()):
		var h: Dictionary = GameData.hero(i)
		var x: int = 76 + (i % 3) * 490
		var y: int = 166 + int(i / 3) * 270
		var card: Control = main.framed_panel(root, Vector2(x, y), Vector2(420, 230), Color("#16243add"), "fantasy_panel_banner", Color("#c4d7ff"), 14)
		main.pixel_art(card, h.sprite, Vector2(28, 26), Vector2(104, 128), Color(h.color))
		main.label(card, h.name, Vector2(150, 26), Vector2(190, 34), 28)
		var meta_level: int = int(main.meta_hero_levels[i]) if i < main.meta_hero_levels.size() else 1
		main.label(card, "Lv.%d  %s" % [meta_level, h.role], Vector2(150, 64), Vector2(240, 28), 18, Color("#b7c6e4"))
		main.label(card, h.weapon, Vector2(150, 96), Vector2(220, 28), 18, Color("#c9d5ee"))
		main.tag_chip(card, h.tag, Vector2(150, 134), GameData.color_for_tag(h.tag))
		main.button(card, "상세", Vector2(150, 178), Vector2(104, 38), Callable(main, "show_character_detail").bind(i), 18, Color("#2f8cff"))
		main.button(card, "승급", Vector2(268, 178), Vector2(104, 38), Callable(main, "upgrade_hero").bind(i), 18, Color("#f05a28"))

static func _show_equipment_crafting(main, root: Control) -> void:
	main.label(root, "장비/제작", Vector2(80, 106), Vector2(320, 44), 30)
	main.label(root, "확률형 없이 골드와 소재로 태그 장비를 확정 제작합니다.", Vector2(80, 148), Vector2(680, 30), 20, Color("#b7c6e4"))
	var crafted: Array = main.equipment.get("common_slots", [])
	var inventory: Control = main.framed_panel(root, Vector2(76, 204), Vector2(720, 520), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(inventory, "보유 공용 장비", Vector2(34, 26), Vector2(280, 36), 28)
	main.divider(inventory, Vector2(34, 68), Vector2(330, 26), Color("#d2bc82"))
	for i in range(6):
		var x := 42 + (i % 2) * 326
		var y := 116 + int(i / 2) * 122
		var slot: Control = main.framed_panel(inventory, Vector2(x, y), Vector2(286, 92), Color("#101827cc"), "fantasy_border_banner", Color("#8f9bb3"), 12)
		if i < crafted.size():
			var item: Dictionary = crafted[i]
			main.label(slot, str(item.name), Vector2(20, 12), Vector2(210, 28), 20, Color("#ffffff"))
			main.label(slot, "%s  Lv.%d" % [str(item.rarity), int(item.level)], Vector2(20, 44), Vector2(130, 24), 16, Color("#b7c6e4"))
			main.tag_chip(slot, str(item.tag), Vector2(160, 34), GameData.color_for_tag(str(item.tag)))
		else:
			main.label(slot, "빈 슬롯", Vector2(20, 24), Vector2(190, 36), 20, Color("#8392b2"))

	var craft_panel: Control = main.framed_panel(root, Vector2(850, 204), Vector2(610, 520), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(craft_panel, "확정 제작", Vector2(34, 26), Vector2(220, 36), 28)
	main.divider(craft_panel, Vector2(34, 68), Vector2(300, 26), Color("#d2bc82"))
	var tags := ["화염", "중력", "소환", "관통", "연쇄", "수호"]
	for i in range(tags.size()):
		var tag: String = tags[i]
		var row_y := 112 + i * 62
		main.tag_chip(craft_panel, tag, Vector2(42, row_y + 8), GameData.color_for_tag(tag))
		main.label(craft_panel, "골드 420 / 소재 18", Vector2(214, row_y + 10), Vector2(190, 28), 17, Color("#c9d5ee"))
		main.button(craft_panel, "제작", Vector2(430, row_y), Vector2(110, 42), Callable(main, "craft_equipment").bind(tag), 18, Color("#2f8cff"))

static func _show_shop(main, root: Control) -> void:
	main.label(root, "상점", Vector2(80, 106), Vector2(320, 44), 30)
	main.label(root, "가챠 없이 가격이 보이는 확정 구매만 배치합니다.", Vector2(80, 148), Vector2(680, 30), 20, Color("#b7c6e4"))
	var offers := [
		{"id": "starter_material", "title": "성장 소재 보급", "desc": "소재 +120", "price": "젬 40", "skin": "button_blue"},
		{"id": "hero_unlock", "title": "캐릭터 준비 패키지", "desc": "골드 +1200", "price": "젬 120", "skin": "button_red"},
		{"id": "season_skin", "title": "서리 균열 루나", "desc": "외형 보유 등록", "price": "젬 180", "skin": "button_yellow"}
	]
	for i in range(offers.size()):
		var offer: Dictionary = offers[i]
		var card: Control = main.framed_panel(root, Vector2(96 + i * 482, 230), Vector2(410, 390), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
		main.label(card, str(offer.title), Vector2(34, 34), Vector2(320, 42), 28)
		main.divider(card, Vector2(34, 84), Vector2(270, 24), Color("#d2bc82"))
		main.label(card, str(offer.desc), Vector2(34, 126), Vector2(310, 34), 22, Color("#ffffff"))
		main.label(card, str(offer.price), Vector2(34, 182), Vector2(220, 34), 24, Color("#ffd24a"))
		main.label(card, "구매 즉시 저장됩니다.", Vector2(34, 226), Vector2(270, 28), 18, Color("#b7c6e4"))
		main.button(card, "구매", Vector2(110, 300), Vector2(190, 58), Callable(main, "buy_shop_offer").bind(str(offer.id)), 24, Color("#2f8cff"), str(offer.skin))
	var skins: Array = main.equipment.get("owned_skins", [])
	var skin_text := "없음"
	if not skins.is_empty():
		var skin_names := PackedStringArray()
		for skin in skins:
			skin_names.append(str(skin))
		skin_text = ", ".join(skin_names)
	main.label(root, "보유 외형: %s" % skin_text, Vector2(100, 682), Vector2(840, 34), 20, Color("#c9d5ee"))

static func _show_codex_trials(main, root: Control) -> void:
	main.label(root, "도감·시련", Vector2(80, 106), Vector2(320, 44), 30)
	main.label(root, "발견한 시너지와 융합 조합을 한 화면에서 확인합니다.", Vector2(80, 148), Vector2(680, 30), 20, Color("#b7c6e4"))
	var synergy_panel: Control = main.framed_panel(root, Vector2(76, 214), Vector2(560, 460), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(synergy_panel, "현재 파티 시너지", Vector2(34, 26), Vector2(300, 36), 28)
	main.divider(synergy_panel, Vector2(34, 68), Vector2(330, 26), Color("#d2bc82"))
	var chips := GameData.synergy_for_party(main.party_indices)
	for i in range(chips.size()):
		main.tag_chip(synergy_panel, chips[i], Vector2(42, 118 + i * 52), Color("#ffd24a") if chips[i].contains("조합") else Color("#76d7ff"))

	var fusion_panel: Control = main.framed_panel(root, Vector2(706, 214), Vector2(760, 460), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(fusion_panel, "융합 도감", Vector2(34, 26), Vector2(300, 36), 28)
	main.divider(fusion_panel, Vector2(34, 68), Vector2(330, 26), Color("#d2bc82"))
	var index := 0
	for pair in GameData.FUSIONS:
		var x := 42 + (index % 2) * 330
		var y := 112 + int(index / 2) * 58
		main.label(fusion_panel, "%s → %s" % [pair, GameData.FUSIONS[pair]], Vector2(x, y), Vector2(300, 28), 17, Color("#ffffff"))
		index += 1

static func _draw_resource_bar(main, root: Control) -> void:
	var resource_keys: Array[String] = ["gold", "gem", "material"]
	var resource_labels: Array[String] = ["골드", "젬", "소재"]
	for i in range(3):
		var key: String = resource_keys[i]
		var chip: Control = main.framed_panel(root, Vector2(1006 + i * 142, 28), Vector2(130, 42), Color("#111827e8"), "fantasy_border_banner", Color("#c4d7ff"), 12)
		main.label(chip, "%s %d" % [resource_labels[i], int(main.currencies[key])], Vector2(10, 4), Vector2(110, 32), 17, Color("#ffe28a"), HORIZONTAL_ALIGNMENT_CENTER)
