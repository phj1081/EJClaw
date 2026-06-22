extends RefCounted

const SFX := {
	"ui_click": "res://assets/audio/kenney-interface/ui_click.wav",
	"ui_confirm": "res://assets/audio/kenney-interface/ui_confirm.wav",
	"low_hp": "res://assets/audio/kenney-interface/ui_error.wav",
	"attack": "res://assets/audio/kenney-rpg/attack_slice.wav",
	"hit": "res://assets/audio/kenney-rpg/hit_metal.wav",
	"dash": "res://assets/audio/kenney-rpg/dash_cloth.wav",
	"skill": "res://assets/audio/kenney-rpg/skill_draw.wav",
	"impact": "res://assets/audio/kenney-rpg/impact_chop.wav",
	"level_up": "res://assets/audio/kenney-music-jingles/level_up.wav",
	"fusion": "res://assets/audio/kenney-music-jingles/fusion.wav",
	"victory": "res://assets/audio/kenney-music-jingles/victory.wav",
	"defeat": "res://assets/audio/kenney-music-jingles/defeat.wav"
}

const MUSIC := {
	"main": "res://assets/audio/kenney-music-loops/main_theme.wav",
	"battle": "res://assets/audio/kenney-music-loops/battle_theme.wav"
}

static func setup(main) -> void:
	if main.bgm_player == null or not is_instance_valid(main.bgm_player):
		main.bgm_player = AudioStreamPlayer.new()
		main.bgm_player.name = "AudioBgmPlayer"
		main.bgm_player.volume_db = -15.0
		main.add_child(main.bgm_player)
	main.sfx_players = main.sfx_players.filter(func(player): return is_instance_valid(player))
	while main.sfx_players.size() < 6:
		var player := AudioStreamPlayer.new()
		player.name = "AudioSfxPlayer%d" % main.sfx_players.size()
		player.volume_db = -8.0
		main.add_child(player)
		main.sfx_players.append(player)

static func play_music(main, key: String) -> void:
	setup(main)
	if not MUSIC.has(key):
		return
	var stream: AudioStream = _load_stream(MUSIC[key])
	if stream == null:
		return
	if stream is AudioStreamWAV:
		(stream as AudioStreamWAV).loop_mode = AudioStreamWAV.LOOP_FORWARD
	if main.bgm_player.stream == stream and main.bgm_player.playing:
		return
	main.bgm_player.stream = stream
	main.bgm_player.play()

static func play_sfx(main, key: String, volume_db: float = -8.0, pitch_jitter: float = 0.0) -> void:
	setup(main)
	if not SFX.has(key):
		return
	var stream: AudioStream = _load_stream(SFX[key])
	if stream == null:
		return
	var player: AudioStreamPlayer = _available_sfx_player(main)
	player.stream = stream
	player.volume_db = volume_db
	player.pitch_scale = 1.0 + randf_range(-pitch_jitter, pitch_jitter)
	player.play()

static func _available_sfx_player(main) -> AudioStreamPlayer:
	for player: AudioStreamPlayer in main.sfx_players:
		if not player.playing:
			return player
	return main.sfx_players[0]

static func _load_stream(resource_path: String) -> AudioStream:
	if resource_path.ends_with(".wav"):
		return AudioStreamWAV.load_from_file(ProjectSettings.globalize_path(resource_path))
	return load(resource_path)
