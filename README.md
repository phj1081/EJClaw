# EJClaw

![Version](https://img.shields.io/badge/version-0.2.3-blue)
![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.126-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.128.0-green)
![Bun](https://img.shields.io/badge/Bun-1.3+-f9f1e1?logo=bun&logoColor=black)
![Discord](https://img.shields.io/badge/Discord-Tribunal-5865F2?logo=discord&logoColor=white)

EJClaw는 Discord 위에서 동작하는 Tribunal 멀티에이전트 개발 보조 시스템입니다.
사용자 요청은 owner가 받고, reviewer가 자동 리뷰를 수행하며, 필요할 때 arbiter가 교착을 정리합니다.

원본은 [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)에서 출발했지만, 현재는 EJClaw의 Discord/paired-runtime 구조에 맞게 독립적으로 유지되고 있습니다.

## 개요

- 단일 `ejclaw` 서비스가 owner / reviewer / arbiter 세 역할과 세 Discord 봇을 함께 관리합니다.
- 사용자 진입점은 owner 하나이며, reviewer와 arbiter는 내부 역할로 동작합니다.
- room-level 설정은 `room_settings`를 기준으로 하며, `assign_room`이 공개 assignment 인터페이스입니다.
- reviewer는 owner의 현재 worktree를 direct mount로 읽고, role-scoped read-only 보호를 적용받습니다.
- paired runtime은 SQLite(WAL), stable owner worktree, turn/lease 추적, host verification으로 구성됩니다.

## 핵심 기능

- Tribunal 3-에이전트 루프: owner / reviewer / arbiter
- Mixture of Agents(MoA): 외부 모델 의견을 arbiter 판단에 주입
- 역할별 agent type / model / effort 설정
- role-fixed Discord 봇 3개 체계
- reviewer host runtime + read-only guard
- 승인 후 변경 감지와 재리뷰
- Claude 장애 시 Codex로 넘기는 global failover
- Claude OAuth 멀티 토큰 로테이션
- `assign_room` 기반 명시적 room assignment
- Bun + SQLite 기반 빠른 런타임

## Tribunal 시스템

| 역할 | 현재 기본값 | 설명 |
| --- | --- | --- |
| Owner | room별 `owner_agent_type` (기본 Codex) | 사용자 요청 처리, 코드 작성, 최종 응답 |
| Reviewer | 전역 `REVIEWER_AGENT_TYPE` (기본 Claude Code) | owner 결과 비판적 리뷰, 회귀 검증 |
| Arbiter | 전역 `ARBITER_AGENT_TYPE` (옵션) | owner/reviewer 교착 시 판정 |

```text
사용자 메시지
  → Owner 응답
    → Reviewer 자동 실행
      → verdict:
          DONE               → Owner finalize → 완료
          DONE_WITH_CONCERNS → Owner 수정 → 재리뷰 루프
          BLOCKED/NEEDS_CONTEXT
            ├─ Arbiter enabled  → Arbiter 판정
            └─ Arbiter disabled → 사용자로 에스컬레이션
      → 왕복이 누적되면 arbiter 자동 요청 가능
```

### MoA

MoA가 켜져 있으면 arbiter가 판정하기 전에 Kimi, GLM 같은 외부 모델 의견을 병렬 수집하고, 그 결과를 arbiter 프롬프트에 주입합니다. 최종 판정은 여전히 EJClaw arbiter가 내립니다.

## 방 설정 모델

현재 room 설정의 기준은 다음과 같습니다.

- `room_settings`: room-level SSOT
- `room_role_overrides`: owner / reviewer / arbiter 역할별 override
- `paired_projects`: canonical project root
- `paired_workspaces`: 실제 owner / reviewer 실행 workspace
- `registered_groups`: 완전히 제거되지는 않았지만, canonical source가 아니라 compatibility/read-model 성격으로 남아 있는 레이어

운영적으로는:

- `single` → owner만 실행
- `tribunal` → owner + reviewer + optional arbiter

중요한 점:

- reviewer는 더 이상 snapshot copy를 기본 실행 경로로 쓰지 않습니다.
- reviewer는 owner의 현재 workspace를 direct mount로 읽습니다.
- stale reviewer workspace 레코드가 남아 있어도 실행 직전 owner 현재 경로로 재동기화됩니다.

## 아키텍처

```text
Discord ──► SQLite (WAL) ──► GroupQueue ──┬──► Owner (host process)
                                          │       │
                                          │       ▼
                                          ├──► Reviewer (host process, read-only)
                                          │       │
                                          │   verdict routing
                                          │       ├─ DONE → finalize
                                          │       ├─ feedback → owner loop
                                          │       └─ BLOCKED → arbiter / user
                                          │
                                          ├──► Arbiter (on-demand, fresh session)
                                          │       │
                                          │   ┌───┴─── MoA ───┐
                                          │   │ Kimi / GLM    │
                                          │   │ 의견 수집      │
                                          │   └───────────────┘
                                          │
                                     IPC follow-up / host tools
                                          │
                              ┌────────── Router ──────────┐
                              ▼                            ▼
                    paired_turn_outputs            Discord display
```

## 시작하기

### 요구사항

- Linux(Ubuntu 22.04+) 또는 macOS
- [Bun](https://bun.sh/) 1.3+
- Claude Code CLI
- Codex CLI
- Discord 봇 토큰 3개(owner / reviewer / arbiter)

현재 runner 번들 기준 버전:

- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk@0.2.126`
- Codex SDK/CLI: `@openai/codex@0.128.0`

### 설치

```bash
git clone https://github.com/phj1081/EJClaw.git
cd EJClaw
bun install
bun run build:all
```

### 환경 설정

- `.env.example`를 기준으로 `.env`를 작성합니다.
- 전체 키 설명은 [docs/configuration.md](docs/configuration.md)를 봅니다.
- 최소한 아래는 먼저 채워야 합니다.

```bash
DISCORD_OWNER_BOT_TOKEN=
DISCORD_REVIEWER_BOT_TOKEN=
DISCORD_ARBITER_BOT_TOKEN=
CLAUDE_CODE_OAUTH_TOKENS=
OWNER_AGENT_TYPE=codex
REVIEWER_AGENT_TYPE=claude-code
```

### 실행

```bash
bun run dev
```

### 배포

```bash
bun run deploy
```

이 스크립트는 다음을 순서대로 수행합니다.

1. 최신 커밋 fast-forward pull
2. 전체 build
3. `migrate-room-registrations` 실행
4. `systemctl --user restart ejclaw`

## 개발

```bash
bun run build
bun run build:runners
bun run test
bun run typecheck
bun run check
```

## 문서

- [docs/architecture.md](docs/architecture.md) — 데이터 모델, 실행 흐름, 주요 파일
- [docs/configuration.md](docs/configuration.md) — `.env` 키와 디버깅 경로
- [docs/legacy-compat-removal-spec.md](docs/legacy-compat-removal-spec.md) — 남아 있는 레거시 제거 계획
- [CHANGELOG.md](CHANGELOG.md) — 릴리즈 이력

## 라이선스

MIT
