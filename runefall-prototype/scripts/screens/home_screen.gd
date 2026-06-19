extends RefCounted

const GameData = preload("res://scripts/game_data.gd")
const BalanceTable = preload("res://scripts/balance_table.gd")

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
	main.label(season_panel, "%s %d일 남음\nLv.%d / XP %d" % [BalanceTable.SEASON.name, int(BalanceTable.SEASON.days_left), int(main.season_pass.get("level", 1)), int(main.season_pass.get("xp", 0))], Vector2(32, 68), Vector2(290, 64), 18, Color("#c9d5ee"))
	main.button(season_panel, "보기", Vector2(250, 92), Vector2(86, 42), Callable(main, "show_meta_tab").bind("시즌패스"), 17, Color("#2f8cff"))
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
	elif tab_name == "시즌패스":
		_show_season_pass(main, root)
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
	var gold_cost: int = int(BalanceTable.HERO_UPGRADE.gold_base) + level * int(BalanceTable.HERO_UPGRADE.gold_per_level)
	var material_cost: int = int(BalanceTable.HERO_UPGRADE.material_base) + level * int(BalanceTable.HERO_UPGRADE.material_per_level)
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
		main.label(craft_panel, "골드 %d / 소재 %d" % [int(BalanceTable.EQUIPMENT_CRAFT.gold), int(BalanceTable.EQUIPMENT_CRAFT.material)], Vector2(214, row_y + 10), Vector2(190, 28), 17, Color("#c9d5ee"))
		main.button(craft_panel, "제작", Vector2(430, row_y), Vector2(110, 42), Callable(main, "craft_equipment").bind(tag), 18, Color("#2f8cff"))

static func _show_shop(main, root: Control) -> void:
	main.label(root, "상점", Vector2(80, 106), Vector2(320, 44), 30)
	main.label(root, "확정형 인게임 상품과 실제 결제 연동 전 더미 IAP 상품 구조입니다.", Vector2(80, 148), Vector2(760, 30), 20, Color("#b7c6e4"))
	var offer_keys := BalanceTable.SHOP_OFFERS.keys()
	for i in range(offer_keys.size()):
		var offer_id: String = str(offer_keys[i])
		var offer: Dictionary = BalanceTable.SHOP_OFFERS[offer_id]
		var card: Control = main.framed_panel(root, Vector2(70 + i * 328, 214), Vector2(294, 300), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
		main.label(card, str(offer.title), Vector2(34, 34), Vector2(320, 42), 28)
		main.divider(card, Vector2(34, 84), Vector2(210, 24), Color("#d2bc82"))
		main.label(card, str(offer.desc), Vector2(34, 126), Vector2(310, 34), 22, Color("#ffffff"))
		main.label(card, str(offer.price), Vector2(34, 182), Vector2(220, 34), 24, Color("#ffd24a"))
		main.button(card, "구매", Vector2(66, 230), Vector2(164, 48), Callable(main, "buy_shop_offer").bind(offer_id), 20, Color("#2f8cff"), str(offer.skin))

	var product_keys := BalanceTable.IAP_PRODUCTS.keys()
	for i in range(product_keys.size()):
		var product_id: String = str(product_keys[i])
		var product: Dictionary = BalanceTable.IAP_PRODUCTS[product_id]
		var card: Control = main.framed_panel(root, Vector2(70 + i * 328, 542), Vector2(294, 244), Color("#16243add"), "fantasy_panel_banner", Color("#c4d7ff"), 14)
		main.label(card, str(product.title), Vector2(28, 24), Vector2(226, 34), 24)
		main.label(card, str(product.price), Vector2(28, 72), Vector2(168, 28), 20, Color("#ffd24a"))
		main.label(card, BalanceTable.reward_text(product.reward), Vector2(28, 110), Vector2(226, 46), 16, Color("#c9d5ee"))
		main.label(card, "영수증 자리표시", Vector2(28, 154), Vector2(180, 24), 15, Color("#8fa2c8"))
		main.button(card, "더미 구매", Vector2(68, 188), Vector2(160, 40), Callable(main, "buy_iap_product").bind(product_id), 18, Color("#2f8cff"), "button_blue")
	var skins: Array = main.equipment.get("owned_skins", [])
	var skin_text := "없음"
	if not skins.is_empty():
		var skin_names := PackedStringArray()
		for skin in skins:
			skin_names.append(str(skin))
		skin_text = ", ".join(skin_names)
	main.label(root, "보유 외형: %s / 더미 영수증 %d건" % [skin_text, main.iap_receipts.size()], Vector2(1038, 714), Vector2(460, 34), 18, Color("#c9d5ee"))

static func _show_season_pass(main, root: Control) -> void:
	main.label(root, "시즌패스", Vector2(80, 106), Vector2(320, 44), 30)
	main.label(root, "%s · %d일 남음 · Lv.%d / XP %d" % [BalanceTable.SEASON.name, int(BalanceTable.SEASON.days_left), int(main.season_pass.get("level", 1)), int(main.season_pass.get("xp", 0))], Vector2(80, 148), Vector2(720, 30), 20, Color("#b7c6e4"))
	if bool(main.season_pass.get("premium_unlocked", false)):
		main.tag_chip(root, "프리미엄 활성", Vector2(780, 148), Color("#ffd24a"))
	else:
		main.button(root, "프리미엄 더미 구매", Vector2(780, 140), Vector2(220, 46), Callable(main, "buy_iap_product").bind("premium_pass"), 18, Color("#f05a28"), "button_red")

	var mission_panel: Control = main.framed_panel(root, Vector2(76, 204), Vector2(420, 526), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(mission_panel, "시즌 미션", Vector2(30, 24), Vector2(220, 36), 28)
	main.divider(mission_panel, Vector2(30, 66), Vector2(250, 22), Color("#d2bc82"))
	var missions: Dictionary = main.season_pass.get("missions", {})
	for i in range(BalanceTable.SEASON_MISSIONS.size()):
		var mission: Dictionary = BalanceTable.SEASON_MISSIONS[i]
		var y := 108 + i * 92
		var done := bool(missions.get(str(mission.id), false))
		main.label(mission_panel, str(mission.title), Vector2(30, y), Vector2(230, 28), 19, Color("#ffffff"))
		main.label(mission_panel, "시즌 XP +%d" % int(mission.xp), Vector2(30, y + 30), Vector2(150, 24), 16, Color("#ffd24a"))
		if done:
			main.tag_chip(mission_panel, "완료", Vector2(262, y + 12), Color("#21a67a"))
		else:
			main.button(mission_panel, "완료 처리", Vector2(248, y + 10), Vector2(126, 42), Callable(main, "complete_season_mission").bind(str(mission.id)), 16, Color("#2f8cff"))

	var reward_panel: Control = main.framed_panel(root, Vector2(540, 204), Vector2(920, 526), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(reward_panel, "무료 / 프리미엄 보상 트랙", Vector2(30, 24), Vector2(420, 36), 28)
	main.divider(reward_panel, Vector2(30, 66), Vector2(350, 22), Color("#d2bc82"))
	var claimed_free: Array = main.season_pass.get("claimed_free", [])
	var claimed_premium: Array = main.season_pass.get("claimed_premium", [])
	var season_level := int(main.season_pass.get("level", 1))
	for i in range(BalanceTable.SEASON_REWARDS.size()):
		var row: Dictionary = BalanceTable.SEASON_REWARDS[i]
		var level := int(row.level)
		var y := 106 + i * 78
		var unlocked := season_level >= level
		main.label(reward_panel, "Lv.%d" % level, Vector2(30, y), Vector2(70, 34), 22, Color("#ffd24a"))
		main.label(reward_panel, "무료: %s" % BalanceTable.reward_text(row.free), Vector2(104, y), Vector2(270, 30), 17, Color("#ffffff"))
		main.label(reward_panel, "프리미엄: %s" % BalanceTable.reward_text(row.premium), Vector2(104, y + 32), Vector2(320, 30), 17, Color("#c9d5ee"))
		if claimed_free.has(level):
			main.tag_chip(reward_panel, "무료 수령", Vector2(470, y), Color("#21a67a"))
		else:
			main.button(reward_panel, "무료 받기", Vector2(470, y), Vector2(128, 40), Callable(main, "claim_season_reward").bind(level, false), 16, Color("#2f8cff") if unlocked else Color("#566070"))
		if claimed_premium.has(level):
			main.tag_chip(reward_panel, "유료 수령", Vector2(628, y), Color("#21a67a"))
		else:
			main.button(reward_panel, "프리미엄", Vector2(628, y), Vector2(128, 40), Callable(main, "claim_season_reward").bind(level, true), 16, Color("#f05a28") if unlocked else Color("#566070"))

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
