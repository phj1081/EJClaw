extends RefCounted

const BATTLE_DURATION := 150.0
const ARENA_MIN := Vector2(270, 112)
const ARENA_MAX := Vector2(1470, 806)

const XP_SPLIT := {"active": 0.4, "ally": 0.2}
const LEVEL_XP := {"start": 80.0, "step": 45.0}
const WAVE := {"seconds_per_wave": 28.0, "spawn_base": 1.35, "spawn_per_wave": 0.12, "spawn_min": 0.35}
const RUN_REWARDS := {
	"victory": {"gold": 820, "material": 34, "meta_xp": 1, "season_xp": 40},
	"defeat": {"gold": 360, "material": 14, "meta_xp": 0, "season_xp": 18}
}

const HERO_UPGRADE := {"gold_base": 220, "gold_per_level": 80, "material_base": 12, "material_per_level": 4}
const EQUIPMENT_CRAFT := {"gold": 420, "material": 18, "max_common_slots": 6}

const ENEMY_TYPES := {
	"zombie": {
		"name": "뿔투구 돌격병",
		"asset": "00",
		"sprite": 1,
		"color": Color("#d74848"),
		"size": Vector2(58, 58),
		"hp": 24.0,
		"speed": 106.0,
		"damage": 15.0,
		"range": 36.0,
		"xp": 18.0,
		"attack_interval": 0.25
	},
	"orc_shaman": {
		"name": "붉은 갑주 주술사",
		"asset": "01",
		"sprite": 4,
		"color": Color("#b56cff"),
		"size": Vector2(62, 62),
		"hp": 34.0,
		"speed": 82.0,
		"damage": 11.0,
		"range": 305.0,
		"xp": 26.0,
		"attack_interval": 1.35
	},
	"muddy": {
		"name": "독포자 탱커",
		"asset": "02",
		"sprite": 5,
		"color": Color("#8f6a4c"),
		"size": Vector2(62, 62),
		"hp": 78.0,
		"speed": 50.0,
		"damage": 20.0,
		"range": 44.0,
		"xp": 36.0,
		"attack_interval": 0.42
	},
	"shade_runner": {
		"name": "해골 추격자",
		"asset": "03",
		"sprite": 0,
		"color": Color("#54c8ff"),
		"size": Vector2(54, 54),
		"hp": 28.0,
		"speed": 154.0,
		"damage": 12.0,
		"range": 38.0,
		"xp": 24.0,
		"attack_interval": 0.55
	},
	"spore_bomber": {
		"name": "염각 폭탄병",
		"asset": "04",
		"sprite": 2,
		"color": Color("#d9f06a"),
		"size": Vector2(62, 62),
		"hp": 42.0,
		"speed": 68.0,
		"damage": 22.0,
		"range": 74.0,
		"xp": 30.0,
		"attack_interval": 1.2
	},
	"bone_guard": {
		"name": "호박 방패병",
		"asset": "05",
		"sprite": 3,
		"color": Color("#c9d5ee"),
		"size": Vector2(58, 58),
		"hp": 96.0,
		"speed": 46.0,
		"damage": 18.0,
		"range": 48.0,
		"xp": 38.0,
		"attack_interval": 0.55
	},
	"scarab_swarm": {
		"name": "잿불 난동꾼",
		"asset": "06",
		"sprite": 0,
		"color": Color("#f6b84a"),
		"size": Vector2(52, 52),
		"hp": 18.0,
		"speed": 176.0,
		"damage": 8.0,
		"range": 32.0,
		"xp": 14.0,
		"attack_interval": 0.35
	},
	"rift_eye": {
		"name": "서리 감시자",
		"asset": "07",
		"sprite": 4,
		"color": Color("#ff7bd5"),
		"size": Vector2(58, 58),
		"hp": 46.0,
		"speed": 76.0,
		"damage": 15.0,
		"range": 340.0,
		"xp": 32.0,
		"attack_interval": 1.05
	},
	"crystal_slug": {
		"name": "불씨 포자괴",
		"asset": "08",
		"sprite": 2,
		"color": Color("#70f0ff"),
		"size": Vector2(58, 58),
		"hp": 58.0,
		"speed": 54.0,
		"damage": 24.0,
		"range": 86.0,
		"xp": 34.0,
		"attack_interval": 1.35
	},
	"ember_guard": {
		"name": "용암 근위병",
		"asset": "09",
		"sprite": 3,
		"color": Color("#ff8738"),
		"size": Vector2(66, 66),
		"hp": 120.0,
		"speed": 58.0,
		"damage": 26.0,
		"range": 52.0,
		"xp": 46.0,
		"attack_interval": 0.65
	},
	"rift_commander": {
		"name": "균열 지휘관",
		"asset": "10",
		"sprite": 3,
		"color": Color("#ff395d"),
		"size": Vector2(68, 68),
		"hp": 135.0,
		"speed": 64.0,
		"damage": 24.0,
		"range": 58.0,
		"xp": 52.0,
		"attack_interval": 0.78
	}
}

const BOSS := {
	"name": "균열 장군",
	"asset": "10",
	"hp": 780.0,
	"speed": 58.0,
	"damage": 28.0,
	"range": 58.0,
	"xp": 180.0,
	"attack_interval": 1.6,
	"pattern_cd": 2.0
}

const FUSION_ATTACKS := {
	"작열 중력장": {"mode": "gravity", "color": Color("#ff7a45"), "damage": 11.0, "radius": 122.0},
	"번지는 화염": {"mode": "splash", "color": Color("#ff4d2e"), "damage": 28.0, "radius": 82.0},
	"용암 레일": {"mode": "rail", "color": Color("#ffb238"), "damage": 34.0, "radius": 30.0},
	"별핵 창": {"mode": "rail", "color": Color("#8fc7ff"), "damage": 32.0, "radius": 26.0},
	"반사 레일건": {"mode": "chain", "color": Color("#ffe65c"), "damage": 27.0, "radius": 170.0},
	"궤도 정령": {"mode": "summon", "color": Color("#42d787"), "damage": 24.0, "radius": 132.0},
	"수호 토템": {"mode": "guard", "color": Color("#4bd0d9"), "damage": 20.0, "radius": 118.0}
}

const SHOP_OFFERS := {
	"starter_material": {"title": "성장 소재 보급", "desc": "소재 +120", "price": "젬 40", "gem_cost": 40, "reward": {"material": 120}, "skin": "button_blue"},
	"hero_unlock": {"title": "캐릭터 준비 패키지", "desc": "골드 +1200", "price": "젬 120", "gem_cost": 120, "reward": {"gold": 1200}, "skin": "button_red"},
	"season_skin": {"title": "서리 균열 루나", "desc": "외형 보유 등록", "price": "젬 180", "gem_cost": 180, "reward": {"skin": "서리 균열 루나"}, "skin": "button_yellow"}
}

const IAP_PRODUCTS := {
	"gem_120": {"store_id": "runefall.gem_120", "title": "젬 120", "price": "₩1,500", "reward": {"gem": 120}},
	"starter_pack": {"store_id": "runefall.starter_pack", "title": "스타터 팩", "price": "₩4,900", "reward": {"gem": 320, "gold": 3000, "material": 160}},
	"premium_pass": {"store_id": "runefall.premium_pass.s1", "title": "프리미엄 시즌 패스", "price": "₩9,900", "reward": {"premium_pass": true, "gem": 180}}
}

const SEASON := {
	"id": "frost_rift_s1",
	"name": "서리 균열 시즌",
	"days_left": 12,
	"xp_per_level": 100,
	"max_level": 5
}

const SEASON_MISSIONS := [
	{"id": "run_once", "title": "런 1회 완료", "xp": 40},
	{"id": "defeat_boss", "title": "균열 장군 처치", "xp": 70},
	{"id": "craft_item", "title": "장비 1회 제작", "xp": 35},
	{"id": "use_fusion", "title": "융합 공격 3회 사용", "xp": 50}
]

const SEASON_REWARDS := [
	{"level": 1, "free": {"gold": 600}, "premium": {"gem": 60}},
	{"level": 2, "free": {"material": 30}, "premium": {"gold": 1400}},
	{"level": 3, "free": {"gem": 40}, "premium": {"skin": "서리 균열 브람"}},
	{"level": 4, "free": {"gold": 900}, "premium": {"material": 90}},
	{"level": 5, "free": {"material": 50}, "premium": {"skin": "서리 균열 루나"}}
]

static func default_season_pass() -> Dictionary:
	var missions := {}
	for mission in SEASON_MISSIONS:
		missions[str(mission.id)] = false
	return {
		"season_id": SEASON.id,
		"xp": 0,
		"level": 1,
		"premium_unlocked": false,
		"claimed_free": [],
		"claimed_premium": [],
		"missions": missions
	}

static func season_level_for_xp(xp: int) -> int:
	return clampi(1 + int(xp / int(SEASON.xp_per_level)), 1, int(SEASON.max_level))

static func reward_text(reward: Dictionary) -> String:
	var parts: Array[String] = []
	if reward.has("gold"):
		parts.append("골드 +%d" % int(reward.gold))
	if reward.has("gem"):
		parts.append("젬 +%d" % int(reward.gem))
	if reward.has("material"):
		parts.append("소재 +%d" % int(reward.material))
	if reward.has("skin"):
		parts.append("외형 %s" % str(reward.skin))
	if reward.has("premium_pass"):
		parts.append("프리미엄 해금")
	return " / ".join(parts)
