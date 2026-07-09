# Changelog

이 문서는 EJClaw의 주요 변경 사항을 기록합니다.

## [Unreleased]

## [0.3.0] - 2026-07-10

### Added

- **웹 대시보드 (베타, 미완성)**: read-only MVP에서 시작해 two-pane 방 타임라인(라이브 진행 마크다운 렌더), Inbox(승인/거절/무시 액션), 스케줄 작업 생성·편집, 설정(모델/방별 모델/Fast Mode/Codex 계정/MoA/스킬), 사용량 쿼터 뷰(5h/7d), PWA 셸, 토큰 인증, 모바일 내비게이션까지 확장 — 골격은 갖췄으나 미완성, UX/데이터 정합성 다듬기 진행 중
- Android thin client MVP + 대시보드 토큰 인증
- Ray-Ban display 대시보드 PoC
- `glm-code` agent runner 타입 지원
- 방별(role별) 모델·effort override 지원: `room_role_overrides.agent_config_json`에 저장된 방별 값이 전역 `OWNER_/REVIEWER_/ARBITER_MODEL`보다 우선 적용
- `assign_room`에 `owner_model`/`owner_effort`/`reviewer_model`/`reviewer_effort`/`arbiter_model`/`arbiter_effort` 파라미터 추가 (빈 문자열로 삭제)
- 웹 대시보드 설정 → 모델에 "방별 모델" 카드와 `/api/settings/room-models` API 추가
- Claude API auth mode (`claudeAuthMode: 'api'`) 방별 override — 구독 OAuth 대신 ANTHROPIC_API_KEY 사용 선택 가능
- 방별 스킬 override 설정 및 runner spawn 반영
- STEP_DONE/TASK_DONE verdict 분리, verdict 저장, step-done 루프 이스컬레이션
- 구조화된 Discord 첨부(structured attachments) + `MEDIA:` outbound 첨부 디렉티브 + 첨부 allowlist 디렉토리 설정
- reviewer/verification/GitHub step evidence preset + repo evidence MCP 툴 + host evidence IPC
- Codex warm-up 스케줄러(옵션), Codex 계정 6h 자동 리프레시/수동 전환, 라이브 plan_type 조회
- Claude OAuth refresh CLI + systemd 타이머 지원
- handoff-only EJClaw runner 모드 (`SERVICE_SESSION_SCOPE` 분리 운영)
- MoA(Mixture of Agents) 대시보드 설정, gated Codex goals 토글

### Changed

- 기본 역할 배치 스와프: owner=codex(`gpt-5.6-sol`), reviewer/arbiter=claude(`claude-opus-4-8`)
- SDK 업데이트: `@openai/codex` 0.144.0, `@anthropic-ai/claude-agent-sdk` 0.3.205
- 대규모 구조 리팩토링: message runtime/executor/dashboard 모듈 분리, 품질 버짓(quality budget) 도입 및 핫스팟 5개까지 축소, 테스트 모놀리스 분할
- deprecated export 제거 및 legacy compat guard 추가

### Fixed

- **Codex rotation 안정화**: 슬롯별 canonical `CODEX_HOME` 격리(OAuth copy-pool refresh token 무효화 재발 방지), 최종 스트림 출력 후 lease 해제, read-only prep 실패 시 lease 누수 수정, pool retry 루프 및 unavailable 복구 루프 상한, dead-auth 슬롯 분류 개선
- **전역 role 모델 family-mismatch 가드**: `channel_owner` 라우팅이 전역 agent type과 다른 계열로 향할 때 전역 모델(예: gpt-5.5)이 잘못된 러너(CLAUDE_MODEL)로 주입되던 문제 차단
- 턴 간 컨텍스트 유실 수정: codex 세션을 provider별 키(`:codex`)로 분리해 failover/스케줄 codex 실행이 Claude owner 세션을 덮어쓰거나 지우지 못하게 함 (재배포 시 codex 스레드는 1회 새로 시작)
- reviewer가 owner와 같은 agent type일 때 owner 세션 키를 공유해 리뷰 사이클마다 owner 컨텍스트를 파괴하던 문제 수정 (reviewer는 항상 `:reviewer` 키)
- Anthropic 529/네트워크 일시 장애 재시도 시 세션을 무조건 삭제하던 로직을 완화 — 첫 재시도는 세션 유지, 마지막 재시도에서만 삭제
- 세션 리셋 패턴이 에이전트의 긴 일반 출력(에러 문구 인용 등)에 오탐되어 세션을 삭제하던 문제 수정 — 짧은 원문 에러 텍스트/error 필드만 매칭
- 세션 하이지니가 턴의 역할·provider와 무관하게 항상 owner 키를 지우던 문제 수정
- codex resume이 조용히 새 스레드로 대체될 때 경고 로그를 남기도록 개선
- 오염된(poisoned) Claude resume 세션을 transient 재시도 전에 정리, Claude paired 일시 장애 재시도 추가
- 고아 paired follow-up reservation 복구, 재시작 후 로컬/중단된 paired attempt 복구
- arbiter ESCALATE 후 사용자 응답을 위해 task를 열린 상태로 유지
- CI watcher 완료를 시스템 입력으로 처리해 owner wake 보장, watcher stall 수정
- 보안: 공개 대시보드 바인드 시 auth 토큰 강제, outbound 텍스트의 Discord 봇 토큰 redaction, 모델 설정 env 쓰기 newline injection 차단, MoA base URL 사설 호스트 SSRF 차단, 의존성 취약점 패치

## [0.2.3] - 2026-04-22

### Added

- room-level reviewer / arbiter agent 선택 지원

### Changed

- 최신 owner final carry-forward를 기본적으로 비활성화
- superseded task에서 직전 owner / reviewer final을 얇은 breadcrumb로 이어줘 reviewer가 task 경계 맥락을 덜 놓치도록 조정
- `unsafe host mode`와 Claude reviewer fresh-session 강제를 분리해, reviewer가 기본적으로 세션을 이어가도록 변경

### Fixed

- Claude Code bundled binary 경로 문제를 수정해 runner 실행 안정성 개선
- paired owner compaction / failure recovery 흐름 보강

## [0.2.2] - 2026-04-15

### Fixed

- CI watcher 완료 뒤 reviewer가 끝난 상태에서 owner 후속 흐름이 이어지지 않던 문제 수정
- `merge_ready` 상태에서 새 human message가 오면 이전 task를 supersede 처리해, 직전 owner final이나 turn output이 다음 질문으로 누출되며 한 턴 늦게 보이던 문제 수정

## [0.2.1] - 2026-04-13

### Changed

- Claude / Codex SDK를 최신 patch/minor 수준으로 갱신하고 runner 의존성을 정리
- reviewer 검증 기준과 continuation/checklist mode 계획 문서를 현재 구조에 맞게 정리

### Fixed

- stale reviewer workspace 레코드가 남아 있을 때 reviewer가 현재 owner worktree 대신 옛 경로를 보는 문제 수정
- reviewer 프롬프트를 `EJCLAW_WORK_DIR` 기준 검증으로 고정해 canonical clone을 단독 근거로 오판하는 문제 완화
- stale owner run이 buffered progress flush, tracked progress send/edit를 외부로 새는 문제 수정
- Claude SDK `task_*` 이벤트가 nested/internal task까지 별도 subagent처럼 표시되던 progress 렌더링 문제 수정

## [0.2.0] - 2026-04-11

### Added

- owner / reviewer / arbiter 기반 Tribunal 3-에이전트 흐름 정비
- MoA(Mixture of Agents) 기반 외부 모델 의견 수집
- `assign_room` 기반 room assignment 모델과 `room_settings` SSOT 정착
- 역할별 model / effort / fallback 설정
- reviewer host runtime read-only guard 및 host verification 경로
- Claude OAuth 멀티 토큰 로테이션

### Changed

- reviewer는 owner workspace를 direct mount로 읽는 현재 모델로 정리
- final delivery 경로를 단일화해 duplicate final 배달 문제를 줄임
- startup precondition을 전용 오류 / exit code 체계로 정리해 crash loop를 막음
- deploy 과정에 `migrate-room-registrations`를 포함해 startup strictness와 운영 절차를 맞춤
- Bun 기준 단일 quality gate(`bun run check`)로 format / typecheck / test / build를 통합

### Fixed

- stale paired finalize retry가 이전 attempt의 side effect를 밖으로 새는 문제 수정
- reviewer / arbiter intermediate progress가 final 직전에 외부 채팅으로 flush되는 문제 수정
- owner final이 progress edit + 새 work item 메시지로 이중 배달되는 문제 수정
- owner workspace branch mismatch 시 안전한 auto-repair 또는 visible blocked 처리 추가
- stale reviewer workspace 레코드가 옛 경로를 유지해 reviewer가 다른 worktree를 보는 문제 수정
- legacy room migration 미실행 상태에서 서비스가 restart loop에 빠지는 문제 완화

## [0.1.0] - 2026-04-09

### Added

- Discord 기반 EJClaw 초기 공개 버전
- owner / reviewer / arbiter 역할 고정 봇 구조
- auto user notify, loop protection, Discord-independent paired communication 기반 정착
