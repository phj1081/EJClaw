---
name: setup
description: Run initial EJClaw setup for the unified single-service Discord architecture.
---

# EJClaw Setup

설치는 `bash setup.sh`로 부트스트랩하고, 나머지는 `bun run setup -- --step <name>`으로 진행합니다. 현재 기준 채널은 디스코드만 지원합니다.

EJClaw는 현재 **단일 서비스**로 동작합니다:
- **ejclaw** — 통합 런타임 서비스

Claude가 기본 봇으로 동작하고, Codex는 별도 서비스가 아니라 필요 시 내부 러너/역할 라우팅으로 사용됩니다.

## 1. 부트스트랩

```bash
bash setup.sh
```

- Node 20 이상과 의존성이 준비되어야 합니다.
- 실패하면 `logs/setup.log`를 먼저 봅니다.

## 2. 현재 상태 확인

```bash
bun run setup -- --step environment
```

여기서 확인할 것:

- `.env` 존재 여부
- 기존 등록 그룹 존재 여부
- 이미 초기화된 설치인지 여부

## 3. 필수 환경 변수

### 기본 환경 변수 (.env)

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

Codex 관련 선택 설정은 **별도 서비스 파일이 아니라 같은 `.env` 또는 서비스 환경 변수**에 넣습니다:

```bash
# 같은 .env 또는 서비스 Environment=에 추가 가능
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
bun run setup -- --step runners
```

이 단계는 아래 두 러너를 빌드합니다.

- `runners/agent-runner` (Claude Code)
- `runners/codex-runner` (Codex)

서비스는 하나지만, 내부 역할 라우팅과 paired 흐름에서 두 러너를 모두 쓸 수 있어서 둘 다 빌드합니다.

실패하면 보통 `bun run build:runners` 출력과 각 러너의 `package.json` 의존성을 같이 보면 됩니다.

## 5. 디스코드 채널 등록

먼저 디스코드에서 개발자 모드를 켜고 채널 ID를 복사합니다. 등록 JID는 `dc:<channel_id>` 형식입니다.

채널 등록은 기본적으로 한 번 하면 됩니다.

예시:

```bash
bun run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #general" \
  --folder discord_main \
  --trigger @claude \
  --is-main \
  --no-trigger-required
```

보조 채널 예시:

```bash
bun run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #ops" \
  --folder discord_ops \
  --trigger @claude
```

## 6. 서비스 시작

```bash
bun run setup -- --step service
```

이 명령은:
- **ejclaw** 서비스를 설치하고 시작합니다

플랫폼별:
- Linux (systemd): `~/.config/systemd/user/ejclaw.service`
- macOS: `~/Library/LaunchAgents/com.ejclaw.plist`
- WSL (no systemd): `start-ejclaw.sh`

수동으로 서비스 관리:

```bash
# Linux (systemd)
systemctl --user status ejclaw
systemctl --user restart ejclaw

# 로그
journalctl --user -u ejclaw -f
```

## 7. 최종 검증

```bash
bun run setup -- --step verify
```

성공 기준:

- **ejclaw** 서비스가 running
- Claude 인증이 configured
- `CHANNEL_AUTH`에 `discord`
- 등록 그룹 수가 1 이상

## 빠른 문제 해결

- 빌드 문제: `bun run typecheck`, `bun test`, `bun run build:runners`
- Claude 서비스 문제: `logs/ejclaw.error.log` 또는 `journalctl --user -u ejclaw -f`
- Codex 실행 문제: 같은 `ejclaw` 서비스 로그에서 `CODEX_MODEL`, `CODEX_EFFORT`, `OPENAI_API_KEY` 설정을 같이 확인
- 디스코드 연결 문제: `.env`의 `DISCORD_BOT_TOKEN`과 등록된 `dc:*` JID 확인
- 응답 문제: `tail -f logs/ejclaw.log`
