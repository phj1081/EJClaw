---
name: setup
description: Run initial EJClaw setup for the dual-service Discord architecture.
---

# EJClaw Setup

설치는 `bash setup.sh`로 부트스트랩하고, 나머지는 `npm run setup -- --step <name>`으로 진행합니다. 현재 기준 채널은 디스코드만 지원합니다.

EJClaw는 두 개의 서비스로 구성됩니다:
- **ejclaw** — Claude Code 봇 (`@claude`)
- **ejclaw-codex** — Codex 봇 (`@codex`) — `.env.codex` 파일이 있으면 자동 설치

## 1. 부트스트랩

```bash
bash setup.sh
```

- Node 20 이상과 의존성이 준비되어야 합니다.
- 실패하면 `logs/setup.log`를 먼저 봅니다.

## 2. 현재 상태 확인

```bash
npm run setup -- --step environment
```

여기서 확인할 것:

- `.env` 존재 여부
- 기존 등록 그룹 존재 여부
- 이미 초기화된 설치인지 여부

## 3. 필수 환경 변수

### Claude 서비스 (.env)

`.env`에 최소한 아래 값이 있어야 합니다.

```bash
DISCORD_BOT_TOKEN=...                # Claude 봇 토큰
CLAUDE_CODE_OAUTH_TOKEN=...          # 또는 ANTHROPIC_API_KEY=...
ASSISTANT_NAME=claude                # 트리거 이름 (@claude)
```

권장:

```bash
CLAUDE_CODE_OAUTH_TOKENS=token1,token2   # 다중 계정 자동 로테이션
GROQ_API_KEY=...                          # Discord 음성 전사 (Groq Whisper)
```

### Codex 서비스 (.env.codex)

Codex 봇을 함께 운영하려면 `.env.codex`를 만듭니다. 이 파일이 있으면 `--step service`가 자동으로 `ejclaw-codex` 서비스도 설치합니다.

```bash
DISCORD_BOT_TOKEN=...                # Codex 봇 토큰 (Claude와 별도)
```

Codex 서비스의 추가 설정은 systemd 유닛에서 `Environment=` 라인으로 지정하거나 `.env.codex`에 추가합니다:

```bash
# systemd 유닛 또는 .env.codex에 추가 가능
CODEX_MODEL=gpt-5.4
CODEX_EFFORT=xhigh
OPENAI_API_KEY=...
```

### 선택 환경 변수

```bash
# 사용량 대시보드
STATUS_CHANNEL_ID=...                # 상태 업데이트 디스코드 채널
USAGE_DASHBOARD=true

# 고급 설정
MAX_CONCURRENT_AGENTS=5
SESSION_COMMAND_ALLOWED_SENDERS=...  # 세션 명령 허용 유저 ID (쉼표 구분)
```

## 4. 러너 빌드

```bash
npm run setup -- --step runners
```

이 단계는 아래 두 러너를 빌드합니다.

- `runners/agent-runner` (Claude Code)
- `runners/codex-runner` (Codex)

실패하면 보통 `npm run build:runners` 출력과 각 러너의 `package.json` 의존성을 같이 보면 됩니다.

## 5. 디스코드 채널 등록

먼저 디스코드에서 개발자 모드를 켜고 채널 ID를 복사합니다. 등록 JID는 `dc:<channel_id>` 형식입니다.

듀얼 서비스에서는 **같은 채널을 두 번 등록**할 수 있습니다 — 각 agent type에 한 번씩. 등록은 `(jid, agent_type)` 복합 키로 저장됩니다.

Claude 봇 채널 등록:

```bash
npm run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #general" \
  --folder discord_main \
  --trigger @claude \
  --is-main \
  --no-trigger-required
```

Codex 봇도 같은 채널을 쓴다면 별도로 등록합니다:

```bash
ASSISTANT_NAME=codex npm run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #general" \
  --folder discord_main \
  --trigger @codex \
  --is-main \
  --no-trigger-required
```

보조 채널 예시:

```bash
npm run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #ops" \
  --folder discord_ops \
  --trigger @claude
```

## 6. 서비스 시작

```bash
npm run setup -- --step service
```

이 명령은:
- **ejclaw** 서비스를 항상 설치합니다
- `.env.codex`가 있으면 **ejclaw-codex** 서비스도 함께 설치합니다

플랫폼별:
- Linux (systemd): `~/.config/systemd/user/ejclaw.service` + `ejclaw-codex.service`
- macOS: `~/Library/LaunchAgents/com.ejclaw.plist` + `com.ejclaw-codex.plist`
- WSL (no systemd): `start-ejclaw.sh` + `start-ejclaw-codex.sh`

수동으로 서비스 관리:

```bash
# Linux (systemd)
systemctl --user status ejclaw ejclaw-codex
systemctl --user restart ejclaw ejclaw-codex

# 로그
journalctl --user -u ejclaw -f
journalctl --user -u ejclaw-codex -f
```

## 7. 최종 검증

```bash
npm run setup -- --step verify
```

성공 기준:

- **ejclaw** 서비스가 running
- **ejclaw-codex** 서비스가 running (`.env.codex`가 있을 때)
- Claude 인증이 configured
- `CHANNEL_AUTH`에 `discord`
- 등록 그룹 수가 1 이상

## 빠른 문제 해결

- 빌드 문제: `npm run typecheck`, `npm test`, `npm run build:runners`
- Claude 서비스 문제: `logs/ejclaw.error.log` 또는 `journalctl --user -u ejclaw -f`
- Codex 서비스 문제: `logs/ejclaw-codex.error.log` 또는 `journalctl --user -u ejclaw-codex -f`
- 디스코드 연결 문제: `.env`의 `DISCORD_BOT_TOKEN`과 등록된 `dc:*` JID 확인
- 응답 문제: `tail -f logs/ejclaw.log`
