extends RefCounted

const TAG_COLORS := {
	"화염": Color("#f05a28"),
	"중력": Color("#7b5cff"),
	"소환": Color("#21a67a"),
	"관통": Color("#56a7ff"),
	"연쇄": Color("#ffd24a"),
	"수호": Color("#4bd0d9")
}

const HEROES := [
	{
		"name": "루나",
		"role": "화염 돌격",
		"tag": "화염",
		"weapon": "룬블레이드",
		"color": "#f05a28",
		"asset": "luna",
		"sprite": "res://assets/cc0-hero-characters/luna_down_0.png",
		"hp": 120,
		"speed": 280
	},
	{
		"name": "브람",
		"role": "수호 전위",
		"tag": "수호",
		"weapon": "성벽 망치",
		"color": "#4bd0d9",
		"asset": "bram",
		"sprite": "res://assets/cc0-hero-characters/bram_down_0.png",
		"hp": 170,
		"speed": 220
	},
	{
		"name": "세라",
		"role": "중력 제어",
		"tag": "중력",
		"weapon": "별핵 지팡이",
		"color": "#7b5cff",
		"asset": "sera",
		"sprite": "res://assets/cc0-hero-characters/sera_down_0.png",
		"hp": 100,
		"speed": 250
	},
	{
		"name": "이온",
		"role": "연쇄 사격",
		"tag": "연쇄",
		"weapon": "전류 석궁",
		"color": "#ffd24a",
		"asset": "ion",
		"sprite": "res://assets/cc0-hero-characters/ion_down_0.png",
		"hp": 105,
		"speed": 300
	},
	{
		"name": "마로",
		"role": "소환 지원",
		"tag": "소환",
		"weapon": "정령 토템",
		"color": "#21a67a",
		"asset": "maro",
		"sprite": "res://assets/cc0-hero-characters/maro_down_0.png",
		"hp": 115,
		"speed": 240
	},
	{
		"name": "카인",
		"role": "관통 저격",
		"tag": "관통",
		"weapon": "룬 레일건",
		"color": "#56a7ff",
		"asset": "kain",
		"sprite": "res://assets/cc0-hero-characters/kain_down_0.png",
		"hp": 95,
		"speed": 270
	}
]

const ENEMY_SPRITES := [
	"res://assets/0x72-dungeon-tileset-ii/frames/tiny_zombie_run_anim_f0.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/zombie_anim_f1.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/slug_anim_f0.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/orc_warrior_run_anim_f0.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/orc_shaman_run_anim_f0.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/muddy_anim_f0.png"
]

const FLOOR_TILES := [
	"res://assets/0x72-dungeon-tileset-ii/frames/floor_1.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/floor_2.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/floor_3.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/floor_4.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/floor_5.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/floor_6.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/floor_7.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/floor_8.png"
]

const PROP_TILES := [
	"res://assets/0x72-dungeon-tileset-ii/frames/wall_mid.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/wall_top_mid.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/wall_banner_blue.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/wall_banner_red.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/crate.png",
	"res://assets/0x72-dungeon-tileset-ii/frames/chest_full_open_anim_f0.png"
]

const TAG_ICONS := {
	"화염": "res://assets/0x72-dungeon-tileset-ii/frames/weapon_anime_sword.png",
	"중력": "res://assets/0x72-dungeon-tileset-ii/frames/weapon_red_magic_staff.png",
	"소환": "res://assets/0x72-dungeon-tileset-ii/frames/weapon_green_magic_staff.png",
	"관통": "res://assets/0x72-dungeon-tileset-ii/frames/weapon_spear.png",
	"연쇄": "res://assets/0x72-dungeon-tileset-ii/frames/weapon_throwing_axe.png",
	"수호": "res://assets/0x72-dungeon-tileset-ii/frames/weapon_big_hammer.png"
}

const SKILL_EFFECTS := {
	"fire": [
		"res://assets/skill-effects/fire-frames/fire_0.png",
		"res://assets/skill-effects/fire-frames/fire_1.png",
		"res://assets/skill-effects/fire-frames/fire_2.png",
		"res://assets/skill-effects/fire-frames/fire_3.png",
		"res://assets/skill-effects/fire-frames/fire_b_0.png",
		"res://assets/skill-effects/fire-frames/fire_b_1.png",
		"res://assets/skill-effects/fire-frames/fire_b_2.png",
		"res://assets/skill-effects/fire-frames/fire_b_3.png"
	],
	"arcane": [
		"res://assets/skill-effects/arcane-frames/arcane_0.png",
		"res://assets/skill-effects/arcane-frames/arcane_1.png",
		"res://assets/skill-effects/arcane-frames/arcane_2.png",
		"res://assets/skill-effects/arcane-frames/arcane_3.png",
		"res://assets/skill-effects/arcane-frames/arcane_b_0.png",
		"res://assets/skill-effects/arcane-frames/arcane_b_1.png",
		"res://assets/skill-effects/arcane-frames/arcane_b_2.png",
		"res://assets/skill-effects/arcane-frames/arcane_b_3.png"
	]
}

const UI_ASSETS := {
	"button_blue": "res://assets/kenney-ui-pack/Blue/Default/button_rectangle_depth_gradient.png",
	"button_green": "res://assets/kenney-ui-pack/Green/Default/button_rectangle_depth_gradient.png",
	"button_red": "res://assets/kenney-ui-pack/Red/Default/button_rectangle_depth_gradient.png",
	"button_yellow": "res://assets/kenney-ui-pack/Yellow/Default/button_rectangle_depth_gradient.png",
	"square_blue": "res://assets/kenney-ui-pack/Blue/Default/button_square_depth_gradient.png",
	"square_red": "res://assets/kenney-ui-pack/Red/Default/button_square_depth_gradient.png",
	"round_blue": "res://assets/kenney-ui-pack/Blue/Default/button_round_depth_gradient.png",
	"round_green": "res://assets/kenney-ui-pack/Green/Default/button_round_depth_gradient.png",
	"check_green": "res://assets/kenney-ui-pack/Green/Default/icon_checkmark.png",
	"cross_red": "res://assets/kenney-ui-pack/Red/Default/icon_cross.png",
	"star_yellow": "res://assets/kenney-ui-pack/Yellow/Default/star.png",
	"arrow_blue_e": "res://assets/kenney-ui-pack/Blue/Default/arrow_basic_e.png",
	"arrow_blue_w": "res://assets/kenney-ui-pack/Blue/Default/arrow_basic_w.png",
	"fantasy_panel": "res://assets/kenney-fantasy-ui-borders/border/border-ornate.png",
	"fantasy_panel_banner": "res://assets/kenney-fantasy-ui-borders/border/border-banner.png",
	"fantasy_border": "res://assets/kenney-fantasy-ui-borders/border/border-ornate.png",
	"fantasy_border_banner": "res://assets/kenney-fantasy-ui-borders/border/border-banner.png",
	"fantasy_divider": "res://assets/kenney-fantasy-ui-borders/divider/divider-ornate.png",
	"fantasy_divider_fade": "res://assets/kenney-fantasy-ui-borders/divider/divider-fade.png"
}

const LEVEL_CHOICES := [
	{"name": "화염 궤도", "kind": "무기", "tag": "화염", "desc": "주위를 도는 불꽃 고리"},
	{"name": "중력 파동", "kind": "스킬", "tag": "중력", "desc": "근처 적을 느리게 함"},
	{"name": "관통 탄환", "kind": "무기", "tag": "관통", "desc": "일직선 적을 관통"},
	{"name": "연쇄 룬", "kind": "패시브", "tag": "연쇄", "desc": "타격이 인접 적에게 튐"},
	{"name": "수호 장막", "kind": "패시브", "tag": "수호", "desc": "전환 직후 보호막"},
	{"name": "정령 소환", "kind": "무기", "tag": "소환", "desc": "작은 정령이 자동 공격"}
]

const FUSIONS := {
	"화염+중력": "작열 중력장",
	"화염+연쇄": "번지는 화염",
	"화염+관통": "용암 레일",
	"중력+관통": "별핵 창",
	"중력+소환": "궤도 정령",
	"소환+수호": "수호 토템",
	"관통+연쇄": "반사 레일건"
}

static func color_for_tag(tag: String) -> Color:
	return TAG_COLORS.get(tag, Color("#f0f4ff"))

static func hero(index: int) -> Dictionary:
	return HEROES[index % HEROES.size()]

static func hero_asset_id(index: int) -> String:
	return str(hero(index).get("asset", "luna"))

static func hero_frame(asset_id: String, direction: String = "down", frame_index: int = 0) -> String:
	var safe_direction := direction if ["down", "side", "up"].has(direction) else "down"
	return "res://assets/cc0-hero-characters/%s_%s_%d.png" % [asset_id, safe_direction, frame_index % 6]

static func hero_frames(asset_id: String, direction: String = "down") -> Array[String]:
	var frames: Array[String] = []
	for i in range(6):
		frames.append(hero_frame(asset_id, direction, i))
	return frames

static func hero_idle(asset_id: String, direction: String = "down") -> String:
	var idle_name := "%s_idle" % direction if ["down", "side", "up"].has(direction) else "down_idle"
	return "res://assets/cc0-hero-characters/%s_%s.png" % [asset_id, idle_name]

static func enemy_sprite(index: int) -> String:
	return ENEMY_SPRITES[index % ENEMY_SPRITES.size()]

static func topdown_monster_frame(monster_id: String, frame_index: int = 0) -> String:
	return "res://assets/topdown-monsters-free/%s_run_%d.png" % [monster_id, frame_index % 8]

static func topdown_monster_frames(monster_id: String) -> Array[String]:
	var frames: Array[String] = []
	if monster_id.is_empty():
		return frames
	for i in range(8):
		frames.append(topdown_monster_frame(monster_id, i))
	return frames

static func floor_tile(index: int) -> String:
	return FLOOR_TILES[index % FLOOR_TILES.size()]

static func prop_tile(index: int) -> String:
	return PROP_TILES[index % PROP_TILES.size()]

static func icon_for_tag(tag: String) -> String:
	return TAG_ICONS.get(tag, "res://assets/0x72-dungeon-tileset-ii/frames/weapon_regular_sword.png")

static func effect_frames(effect_name: String) -> Array:
	return SKILL_EFFECTS.get(effect_name, [])

static func effect_for_tag(tag: String) -> String:
	return "fire" if tag.contains("화염") or tag.contains("작열") or tag.contains("용암") else "arcane"

static func ui_asset(name: String) -> String:
	return UI_ASSETS.get(name, "")

static func synergy_for_party(indices: Array) -> Array[String]:
	var counts := {}
	for index in indices:
		var tag: String = hero(index).tag
		counts[tag] = counts.get(tag, 0) + 1

	var chips: Array[String] = []
	for tag in counts:
		if counts[tag] >= 2:
			chips.append("%s%d +%d%%" % [tag, counts[tag], counts[tag] * 8])

	var names := {}
	for index in indices:
		names[hero(index).name] = true
	if names.has("루나") and names.has("세라"):
		chips.append("작열별 조합")
	if names.has("브람") and names.has("마로"):
		chips.append("수호정령 조합")
	if chips.is_empty():
		chips.append("시너지 탐색 중")
	return chips

static func fusion_name(tag_a: String, tag_b: String) -> String:
	var direct_key := "%s+%s" % [tag_a, tag_b]
	if FUSIONS.has(direct_key):
		return FUSIONS[direct_key]
	var reverse_key := "%s+%s" % [tag_b, tag_a]
	return FUSIONS.get(reverse_key, "")
