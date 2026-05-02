# 설정

EJClaw의 설정 기준은 `.env` 하나입니다.
프로젝트 루트의 [`../.env.example`](../.env.example)를 기본 예시로 보고, 이 문서는 현재 런타임에서 의미가 있는 키만 추려 설명합니다.

## 기본 원칙

- Discord 토큰은 role-fixed canonical 키만 사용합니다
- reviewer 기본 provider는 `claude-code`
- owner 기본 provider는 `codex`
- room-level override는 provider 단위(`claudeModel`, `codexModel`)만 지원합니다
- `CLAUDE_CODE_OAUTH_TOKENS`가 canonical이고, `CLAUDE_CODE_OAUTH_TOKEN`은 legacy fallback입니다

## Discord 봇

```bash
DISCORD_OWNER_BOT_TOKEN=
DISCORD_REVIEWER_BOT_TOKEN=
DISCORD_ARBITER_BOT_TOKEN=
```

예전 service-based alias는 더 이상 허용되지 않습니다.

## 역할 / 모델 설정

```bash
# 역할별 provider
OWNER_AGENT_TYPE=codex
REVIEWER_AGENT_TYPE=claude-code
# ARBITER_AGENT_TYPE=claude-code

# provider 기본 모델
CLAUDE_MODEL=claude-opus-4-6
CLAUDE_EFFORT=high
CLAUDE_THINKING=adaptive
CODEX_MODEL=gpt-5.4
CODEX_EFFORT=xhigh

# 역할별 override
OWNER_MODEL=gpt-5.4
OWNER_EFFORT=xhigh
OWNER_FALLBACK_ENABLED=true

REVIEWER_MODEL=claude-opus-4-6
REVIEWER_EFFORT=high
REVIEWER_FALLBACK_ENABLED=true

ARBITER_MODEL=claude-sonnet-4-6
ARBITER_EFFORT=high
ARBITER_FALLBACK_ENABLED=true
```

설명:

- reviewer / arbiter provider 선택은 **전역 설정**
- 특정 방에서만 reviewer를 Codex로 고르는 기능은 없음
- room-level `agentConfig`의 `claudeModel`, `codexModel`은 역할별이 아니라 provider별 override
- `ARBITER_AGENT_TYPE`은 옵션이며, 설정하지 않으면 arbiter는 비활성 상태입니다

## 인증

```bash
# Claude Code OAuth
CLAUDE_CODE_OAUTH_TOKENS=
CLAUDE_CODE_OAUTH_TOKEN=

# Claude host env (선택)
ANTHROPIC_API_KEY=
ANTHROPIC_AUTH_TOKEN=
ANTHROPIC_BASE_URL=
```

설명:

- `CLAUDE_CODE_OAUTH_TOKENS`: canonical, 쉼표 구분
- `CLAUDE_CODE_OAUTH_TOKEN`: 단일 토큰 legacy fallback
- 실제 runner에는 현재 선택된 Claude 토큰 하나만 주입됩니다

Codex 쪽은 현재 **OAuth 세션 파일** 기준으로 동작합니다. `OPENAI_API_KEY`를 Codex child process에 넘겨서 빌링하는 구조는 사용하지 않습니다.

## 음성 전사

```bash
GROQ_API_KEY=
```

- 기본은 Groq Whisper
- 필요 시 OpenAI Whisper fallback을 별도 확장할 수 있지만, 현재 README / 문서 기준 최소 키는 `GROQ_API_KEY`입니다

## MoA

```bash
MOA_ENABLED=true
MOA_REF_MODELS=kimi,glm

MOA_KIMI_MODEL=kimi-k2.6
MOA_KIMI_BASE_URL=https://api.kimi.com/coding
MOA_KIMI_API_KEY=sk-kimi-xxx
MOA_KIMI_API_FORMAT=anthropic

MOA_GLM_MODEL=glm-5.1
MOA_GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic
MOA_GLM_API_KEY=xxx
MOA_GLM_API_FORMAT=anthropic
```

MoA는 arbiter 판정 전에 외부 모델 의견을 수집해 prompt에 주입합니다.
대시보드 설정 화면에서 `MOA_ENABLED`, `MOA_REF_MODELS`, 모델명, base URL,
API format, API key 교체와 연결 테스트를 관리할 수 있습니다. 저장 후에는
스택 재시작이 필요합니다.

## 운영 / 배포 관련 설정

```bash
ASSISTANT_NAME=claude
STATUS_CHANNEL_ID=
SESSION_COMMAND_ALLOWED_SENDERS=
MAX_CONCURRENT_AGENTS=5
```

## Discord 이미지 첨부 allowlist

```bash
EJCLAW_ATTACHMENT_ALLOWED_DIRS=~/Pictures/Screenshots,~/Downloads/ejclaw-images
```

- 콤마 또는 플랫폼 path delimiter(Linux는 `:`)로 여러 폴더를 지정합니다.
- 지정한 폴더 하위의 PNG/JPEG/GIF/WebP/BMP만 Discord 첨부 후보가 됩니다.
- `realpath`, 이미지 signature, size cap 검증은 그대로 적용됩니다.
- `/home/**` 전체보다 자주 쓰는 스크린샷/이미지 출력 폴더만 추가하는 것을 권장합니다.

- `ASSISTANT_NAME`은 owner trigger 기본 이름을 만듭니다
- paired room에서도 사용자 진입점은 owner가 기준입니다
- status dashboard와 session command는 선택 설정입니다

## 디버깅 경로

| 항목                   | 경로 / 명령                      |
| ---------------------- | -------------------------------- |
| DB                     | `store/messages.db`              |
| 서비스 로그            | `journalctl --user -u ejclaw -f` |
| room 로그              | `groups/{folder}/logs/`          |
| owner/reviewer 세션    | `data/sessions/{folder}*`        |
| owner worktree         | `data/workspaces/{folder}/owner` |
| Claude 플랫폼 프롬프트 | `prompts/claude-platform.md`     |
| reviewer 프롬프트      | `prompts/claude-paired-room.md`  |
| arbiter 프롬프트       | `prompts/arbiter-paired-room.md` |
| Codex 플랫폼 프롬프트  | `prompts/codex-platform.md`      |
| 글로벌 메모리          | `groups/global/CLAUDE.md`        |

## 문서와 실제 코드의 우선순위

문서보다 실제 동작이 우선입니다. 동작 기준을 확인할 때는 아래를 먼저 봅니다.

1. `.env.example`
2. `src/config/load-config.ts`
3. `src/agent-runner-environment.ts`
4. `src/paired-execution-context.ts`
