# Changelog

이 문서는 EJClaw의 주요 변경 사항을 기록합니다.

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
