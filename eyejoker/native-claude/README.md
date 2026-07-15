# Native Claude Code Runtime

NanoClaw의 agent/container/work-run 계층을 다시 구현하지 않고, Discord를 `@anthropic-ai/claude-agent-sdk` streaming 세션에 연결하는 durable 운영 런타임이다. SDK `0.3.201`과 Claude Code `2.1.201`을 같은 cohort로 고정하고 시작 시 버전을 검증한다.

## 보장하는 것

- Discord 채널/스레드 → 프로젝트와 Claude session ID/branch/checkpoint 매핑
- 일반 요청은 `/goal` 완료 계약으로 실행하고, raw Claude slash는 wrapper 없이 전달
- native `AskUserQuestion`·permission callback을 owner-only Discord 버튼(평문/reaction fallback)으로 왕복
- 실행 중 follow-up steering과 동적 model/permission 제어
- reply/history context와 source/follow-up message edit/delete 전파
- **30초 뒤 임시 Discord progress 카드 한 장**만 2초 cadence로 갱신하고, final delivery 성공 후 삭제
- 프로젝트(lock key)별 직렬화, 서로 다른 프로젝트는 최대 3개 병렬 실행
- SQLite durable queue/session/interaction/steering desired state/delivery cursor와 Discord nonce reconciliation
- 서비스 재시작 시 interrupted execution을 at-least-once로 복구하고, 질문은 logical `toolUseID`, marker answer+exact continuation, final delivery는 stable nonce로 dedupe
- 최초 시작 시점 기준 6시간 absolute timeout·최대 시도 횟수·`!cancel`; 취소된 pending 질문은 DB orphan 처리 후 Discord 버튼을 제거
- bounded inbound streaming, credential 파일명 차단, immutable outbound spool, `MEDIA:` attachment delivery
- 실제 SDK message metadata 기반 main/subagent model 표시
- SDK custom Agent `fable-worker → claude-fable-5`, `gpt-worker → gpt-5.6-sol` 등록
- owner allowlist와 final mention 1회

## 일부러 만들지 않은 것

- 별도 agent lifecycle engine
- Docker/container sweep
- PR/CI 상태 머신
- 모델 텍스트를 완료로 간주하는 가짜 status

Claude Code의 native Agent tool, session transcript, settings/CLAUDE.md, file checkpointing을 SDK 제어면으로 그대로 사용한다.

## 설치

```bash
cd ~/EJClaw/eyejoker/native-claude
bun install --frozen-lockfile
bun run check

install -d -m 700 ~/.config/claude-native ~/.local/state/claude-native
install -m 600 ops/env.example ~/.config/claude-native/env
install -m 600 ops/routes.example.json ~/.config/claude-native/routes.json
# 위 두 파일의 placeholder와 secret을 운영 값으로 교체

install -m 644 ops/claude-native-bridge.service ~/.config/systemd/user/claude-native-bridge.service
install -m 644 ops/claude-native-maldhalla-balance.service ~/.config/systemd/user/
install -m 644 ops/claude-native-maldhalla-balance.timer ~/.config/systemd/user/
# 반복 작업 prompt는 ~/.config/claude-native/schedules/*.prompt에 mode 600으로 둔다.
systemctl --user daemon-reload
systemctl --user enable --now claude-native-bridge.service
systemctl --user enable --now claude-native-maldhalla-balance.timer
```

## 운영

```bash
systemctl --user status claude-native-bridge.service
journalctl --user -u claude-native-bridge.service -f
bun run src/status.ts
bun run src/status.ts --json
bun run src/admin.ts enqueue-file maldhalla-balance ~/.config/claude-native/schedules/maldhalla-balance.prompt
systemctl --user list-timers claude-native-maldhalla-balance.timer
```

Discord 명령:

- 상태/중지: `!status`, `!cancel`, `!settings`
- 실행 설정: `!model`, `!permission`, `!effort`
- 세션: `!fork`, `!branch list`, `!branch use <prefix>`, `!reset`
- checkpoint/rewind: `!checkpoint list`, `!rewind preview <uuid>`, `!rewind apply <operation-id>`
- Claude command: `!compact`, `!claude /command`, `!background <prompt>`

Discord message lifecycle:

- 최초 source 수정은 queued prompt 교체 또는 running correction, 삭제는 queued/running job 전체 취소다.
- running 중 follow-up 수정은 아직 SDK mailbox에 있으면 교체하고, 이미 소비됐으면 correction을 보낸다.
- follow-up 삭제는 mailbox에서 제거하거나 원본·모든 correction을 가리키는 retraction을 보낼 뿐 job 전체를 취소하지 않는다.
- follow-up의 현재 desired state는 DB에 먼저 저장한다. crash recovery에서는 accepted/edited/deleted 전체를 at-least-once로 재구성하며 이미 반영한 동일 지시는 중복 실행하지 않도록 명시한다.
- 이미 실행된 외부 side effect는 메시지 삭제만으로 rollback하지 않는다. 파일 복구는 별도 checkpoint/rewind를 사용한다.

## Cutover 원칙

1. 기존 NanoClaw 중앙 DB와 wiring row를 백업한다.
2. Native route는 먼저 `require_mention=true`로 shadow 배치한다.
3. 대상 채널의 NanoClaw wiring만 제거한다. 예약 task와 DB는 삭제하지 않는다.
4. Native route를 `require_mention=false`로 전환한다.
5. 실제 Discord 작업, `/goal`, service restart/resume, final reply를 확인한다.
6. 문제면 Native route를 닫고 wiring row를 백업에서 복구한다.

NanoClaw 전체 서비스 제거는 모든 예약 task가 systemd/native schedule로 이전된 뒤에만 한다.
