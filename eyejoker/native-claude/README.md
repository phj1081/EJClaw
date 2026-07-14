# Native Claude Code Runtime

NanoClaw의 agent/container/work-run 계층을 다시 구현하지 않고, Discord를 Native Claude Code `claude -p` 세션에 연결하는 얇은 운영 런타임이다.

## 보장하는 것

- Discord 채널/스레드 → 프로젝트와 Claude session ID 매핑
- 매 요청을 `/goal`로 실행해 코드·테스트·PR/CI 같은 완료 조건까지 bounded continuation
- 프로젝트(lock key)별 직렬화, 서로 다른 프로젝트는 병렬 실행
- SQLite durable queue와 동일 session `--resume`
- 서비스 재시작 시 `running → queued` 복구
- 최대 시도 횟수·6시간 기본 timeout·`!cancel`
- 실제 프로세스/heartbeat 기반 `working / stalled / queued / idle`
- owner 멘션은 최종 완료/실패 메시지에만 1회
- 첨부 파일 로컬 mode 600 보존
- CLIProxy API-key only. OAuth 환경 변수는 자식 Claude 프로세스에서 비운다.

## 일부러 만들지 않은 것

- 별도 agent lifecycle engine
- Docker/container sweep
- PR/CI 상태 머신
- 모델 텍스트를 완료로 간주하는 가짜 status

Claude Code의 `/goal`, native Agent tool, session transcript, worktree/CLI 기능을 그대로 사용한다.

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

- `!status`: 해당 bridge의 실제 queue/process 상태
- `!cancel`: 현재 채널/스레드의 queued/running 작업 중지

## Cutover 원칙

1. 기존 NanoClaw 중앙 DB와 wiring row를 백업한다.
2. Native route는 먼저 `require_mention=true`로 shadow 배치한다.
3. 대상 채널의 NanoClaw wiring만 제거한다. 예약 task와 DB는 삭제하지 않는다.
4. Native route를 `require_mention=false`로 전환한다.
5. 실제 Discord 작업, `/goal`, service restart/resume, final reply를 확인한다.
6. 문제면 Native route를 닫고 wiring row를 백업에서 복구한다.

NanoClaw 전체 서비스 제거는 모든 예약 task가 systemd/native schedule로 이전된 뒤에만 한다.
