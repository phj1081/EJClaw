extends RefCounted

const GameData := preload("res://scripts/game_data.gd")

static func show(main, victory: bool) -> void:
	main.apply_run_result(victory)
	main.play_sfx("victory" if victory else "defeat", -7.0, 0.0)
	main.play_music("main")
	main.battle_running = false
	var root: Control = main.screen_root()
	var bg := ColorRect.new()
	bg.size = main.VIEW_SIZE
	bg.color = Color("#0d1424")
	root.add_child(bg)
	main.label(root, "RESULT - %s" % ("클리어" if victory else "전멸"), Vector2(0, 52), Vector2(1600, 58), 42, Color("#ffffff"), HORIZONTAL_ALIGNMENT_CENTER)
	main.label(root, "도달 웨이브 %d / 생존 시간 %d초" % [main.wave, int(main.battle_time)], Vector2(0, 112), Vector2(1600, 36), 22, Color("#b7c6e4"), HORIZONTAL_ALIGNMENT_CENTER)

	var growth: Control = main.framed_panel(root, Vector2(170, 190), Vector2(900, 420), Color("#16243add"), "fantasy_panel", Color("#d2bc82"), 16)
	main.label(growth, "4인 개별 성장", Vector2(36, 30), Vector2(300, 40), 30)
	main.divider(growth, Vector2(34, 78), Vector2(420, 26), Color("#d2bc82"))
	for i in range(4):
		var h := GameData.hero(main.party_indices[i])
		var share := 40 if i == main.active_slot else 20
		var xp_percent := int((main.hero_xp[i] / main.hero_next_xp[i]) * 100.0)
		main.label(root, "%d %s  Lv.%d  EXP %d%%  분배 +%d%%" % [i + 1, h.name, main.hero_levels[i], xp_percent, share], Vector2(220, 292 + i * 62), Vector2(620, 34), 24, Color("#ffffff"))
		var bar := ProgressBar.new()
		bar.position = Vector2(720, 298 + i * 62)
		bar.size = Vector2(260, 22)
		bar.max_value = 100
		bar.value = xp_percent
		root.add_child(bar)

	var rewards: Control = main.framed_panel(root, Vector2(1110, 190), Vector2(330, 420), Color("#16243add"), "fantasy_panel_banner", Color("#d2bc82"), 16)
	main.label(rewards, "획득 보상", Vector2(34, 30), Vector2(200, 40), 30)
	main.divider(rewards, Vector2(32, 78), Vector2(230, 24), Color("#d2bc82"))
	main.label(rewards, "골드 +%d\n소재 +%d\n메타 Lv +%d\n저장 완료" % [main.last_run_rewards.gold, main.last_run_rewards.material, main.last_run_rewards.meta_xp], Vector2(34, 104), Vector2(220, 160), 24, Color("#f6d66d"))
	main.button(root, "한 번 더", Vector2(940, 708), Vector2(220, 72), func(): main.start_battle(), 26, Color("#f05a28"), "button_red")
	main.button(root, "메인으로", Vector2(1190, 708), Vector2(220, 72), func(): main.show_home(), 26, Color("#33415c"), "button_blue")
