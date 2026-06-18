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
		"hp": 120,
		"speed": 280
	},
	{
		"name": "브람",
		"role": "수호 전위",
		"tag": "수호",
		"weapon": "성벽 망치",
		"color": "#4bd0d9",
		"hp": 170,
		"speed": 220
	},
	{
		"name": "세라",
		"role": "중력 제어",
		"tag": "중력",
		"weapon": "별핵 지팡이",
		"color": "#7b5cff",
		"hp": 100,
		"speed": 250
	},
	{
		"name": "이온",
		"role": "연쇄 사격",
		"tag": "연쇄",
		"weapon": "전류 석궁",
		"color": "#ffd24a",
		"hp": 105,
		"speed": 300
	},
	{
		"name": "마로",
		"role": "소환 지원",
		"tag": "소환",
		"weapon": "정령 토템",
		"color": "#21a67a",
		"hp": 115,
		"speed": 240
	},
	{
		"name": "카인",
		"role": "관통 저격",
		"tag": "관통",
		"weapon": "룬 레일건",
		"color": "#56a7ff",
		"hp": 95,
		"speed": 270
	}
]

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
	var parts := [tag_a, tag_b]
	parts.sort()
	var key := "%s+%s" % [parts[0], parts[1]]
	return FUSIONS.get(key, "")
