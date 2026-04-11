# 아키텍처

## 서비스 구성

EJClaw는 단일 `ejclaw` 서비스가 세 Discord 봇과 paired runtime을 함께 운영하는 구조입니다.

- `ejclaw.service`: 단일 unified process
- Discord 봇:
  - `DISCORD_OWNER_BOT_TOKEN`
  - `DISCORD_REVIEWER_BOT_TOKEN`
  - `DISCORD_ARBITER_BOT_TOKEN`
- 저장소:
  - `store/`: SQLite DB
  - `groups/`: room별 로그 / 메모리 / 설정
  - `data/`: 세션, worktree, 런타임 보조 데이터
- SQLite는 WAL + `busy_timeout=5000` 기준으로 동작

## 핵심 데이터 모델

| 구성 요소 | 역할 |
| --- | --- |
| `room_settings` | room-level SSOT |
| `room_role_overrides` | 역할별 agent type / agentConfig override |
| `paired_projects` | canonical project root (`canonical_work_dir`) |
| `paired_tasks` | paired runtime의 상태 머신 |
| `paired_workspaces` | owner / reviewer의 실제 실행 workspace 경로 |
| `registered_groups` | compatibility / materialized read-model 성격의 잔존 레이어 |

현재 기준에서 중요한 점:

- room 설정의 기준은 `room_settings`
- reviewer / arbiter는 room의 공개 진입점이 아니라 내부 역할
- `registered_groups`는 제거 진행 대상이지만 아직 완전히 사라진 것은 아님

## 실행 흐름

```text
Discord ──► SQLite (WAL) ──► GroupQueue ──┬──► Owner (host process)
                                          │       │
                                          │       ▼
                                          ├──► Reviewer (host process, read-only)
                                          │       │
                                          │   verdict routing
                                          │       ├─ DONE → owner finalize
                                          │       ├─ feedback → owner loop
                                          │       └─ BLOCKED → arbiter / user
                                          │
                                          ├──► Arbiter (on-demand)
                                          │       │
                                          │   ┌───┴─── MoA ───┐
                                          │   │ Kimi / GLM    │
                                          │   │ 의견 수집      │
                                          │   └───────────────┘
                                          │
                                     IPC polling / host tools
                                          │
                              ┌────────── Router ──────────┐
                              ▼                            ▼
                    paired_turn_outputs            Discord display
```

## Tribunal 역할 분리

| 역할 | 기본 선택 | 설명 |
| --- | --- | --- |
| owner | room별 `owner_agent_type` (기본 Codex) | 사용자 요청 처리, 코드 작성, 최종 응답 |
| reviewer | 전역 `REVIEWER_AGENT_TYPE` (기본 Claude Code) | owner 결과 검토, 회귀 검증 |
| arbiter | 전역 `ARBITER_AGENT_TYPE` (옵션) | owner / reviewer 교착 시 판정 |

역할별 model / effort는 전역 env(`OWNER_*`, `REVIEWER_*`, `ARBITER_*`)로 정하고, room-level `agentConfig`는 provider별(`claudeModel`, `codexModel`) override만 제공합니다.

## Reviewer / Arbiter runtime

- reviewer는 owner의 현재 workspace를 direct mount로 읽습니다
- snapshot copy는 현재 기본 실행 경로가 아닙니다
- reviewer workspace 레코드가 오래된 경로를 가리키면 실행 직전에 owner 현재 workspace로 재동기화합니다
- arbiter는 reviewer와 같은 read-only workspace를 쓰되, 세션 디렉토리는 매 호출마다 fresh하게 준비합니다

즉 reviewer가 보는 실행 경로는:

1. `paired_projects.canonical_work_dir` 같은 canonical root와 별개로
2. `paired_workspaces.workspace_dir`에 저장된 실제 owner worktree

입니다.

## 세션 / 프롬프트 구성

- owner는 stable worktree + stable session을 사용
- reviewer / arbiter는 read-only 세션 디렉토리를 매 실행 전에 다시 준비
- `prepareReadonlySessionEnvironment()`가 `CLAUDE.md`, `.codex/AGENTS.md`, 설정 파일을 매번 재생성
- 그래서 reviewer 관련 프롬프트 / workspace 변경은 기존 실행 중 프로세스에는 즉시 적용되지 않지만, **다음 reviewer 턴부터는 자동 반영**됩니다

## 검증 / 운영 경로

- 검증 명령은 `bun run check` 하나로 묶여 있음
  - format
  - typecheck
  - test
  - build
- reviewer / arbiter가 직접 로컬 빌드를 못 돌려도, host verification 경로로 `typecheck`, `test`, `build`를 수행할 수 있음
- startup precondition은 전용 오류로 올리고, `RestartPreventExitStatus=78`로 crash loop를 막음
- deploy는 `migrate-room-registrations`를 선행한 뒤 service restart를 수행

## 주요 파일

| 파일 | 역할 |
| --- | --- |
| `src/index.ts` | 전체 오케스트레이션 진입점 |
| `src/message-runtime.ts` | 메시지 루프, paired flow 연결 |
| `src/message-turn-controller.ts` | progress / final delivery 제어 |
| `src/paired-execution-context.ts` | owner / reviewer / arbiter 실행 준비 |
| `src/paired-workspace-manager.ts` | owner / reviewer workspace 관리 |
| `src/agent-runner.ts` | host process spawn, env/session wiring |
| `src/db.ts` | 런타임 DB facade |
| `src/db/` | canonical room / paired state / migration 로직 |
| `runners/agent-runner/` | Claude Code runner |
| `runners/codex-runner/` | Codex runner |
| `setup/` | setup / verify / service rendering |
