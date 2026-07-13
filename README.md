# EJClaw v2 — NanoClaw 위 얇은 래퍼

EJClaw는 더 이상 독립 앱이 아니다. **업스트림 NanoClaw + 최소 커스텀**으로 운용하는
EYEJOKER 스택의 carry 저장소다. 구 Tribunal 스택(v0.x)은 2026-07-14 은퇴
(`retire/nanoclaw-migration` 브랜치와 `~/archive/ejclaw-retired-20260714/`에 보존,
필요한 사람은 알아서).

## 구조

```text
upstream nanoclaw (github.com/nanocoai/nanoclaw, main)
  └─ eyejoker/carry-* 브랜치  ← 이 레포가 미러하는 carry 커밋 시리즈
       ├─ feat(channels): Discord adapter
       ├─ feat(providers): gpt-proxy (CLIProxyAPI Anthropic-compat, 16줄)
       ├─ feat(container-runner): OneCLI CA env / git deploy key 활성화 / nested-claude 인증 sentinel
       └─ docs: EYEJOKER_STACK.md (carry 인벤토리)

eyejoker/ (이 레포의 추가 payload — 나노클로 트리 밖 커스텀)
  ├─ host-executor/        컨테이너→호스트 실행 MCP (Unix socket + audit log + op 토큰 주입)
  │   ├─ server.py / client.py / test_server.py
  │   ├─ nanoclaw-host-executor.service
  │   └─ op.dropin.conf    (systemd drop-in — EnvironmentFile 참조만, 토큰 값 없음)
  ├─ shared-claude-common.md   전 그룹 공용 지침 (배포 위치: ~/.config/nanoclaw/shared-claude/)
  └─ mount-allowlist.json      마운트 allowlist 스냅샷 (배포 위치: ~/.config/nanoclaw/)
```

## 운영 원칙

- **커스텀은 최소로.** 새 기능이 필요하면 ① 나노클로 기본 설정으로 되는지 → ② 공식 확장점(프로바이더 registry, 스킬, MCP 등록)으로 되는지 → ③ 그래도 안 되면 carry 패치. 순서 엄수.
- carry 패치는 항상 `eyejoker/carry-<날짜>` 브랜치의 독립 커밋으로. 업스트림 업데이트 시 rebase.
- 시크릿은 이 레포에 절대 커밋하지 않는다 (1Password + .env, 여기엔 참조 경로만).
- 라이브 설치는 `~/NanoClaw` (업스트림 clone + carry 브랜치). 이 레포는 그 carry의 백업/이력.

## 라이브 시스템 (algo 호스트)

| 서비스 | 역할 |
|---|---|
| `nanoclaw-v2-*.service` | 본체 (Discord 4방 + 스케줄러) |
| `nanoclaw-host-executor.service` | 호스트 실행 MCP (audit: `~/.local/share/nanoclaw-host-executor/audit.jsonl`) |
| `cliproxyapi.service` | Codex OAuth 풀 → Anthropic-compat 엔드포인트 |

지식 레이어: AgentMemory MCP(Hermes와 공유) + LLM Wiki(ro mount) + 그룹별 CLAUDE.local.md.

## 재구축 절차 (요약)

1. `git clone https://github.com/nanocoai/nanoclaw ~/NanoClaw && cd ~/NanoClaw`
2. 이 레포의 carry 브랜치를 remote로 추가해 cherry-pick (또는 `nanoclaw-src/` 미러에서 diff 적용)
3. `eyejoker/host-executor/` → `~/nanoclaw-host-executor/` 복사, systemd unit + drop-in 설치
4. `eyejoker/mount-allowlist.json`, `shared-claude-common.md` → `~/.config/nanoclaw/` 배치
5. `.env` 구성 (Discord 토큰, CLIPROXY_BASE_URL 등 — 1Password 참조)
6. `pnpm install && pnpm build`, 그룹/wiring은 `ncl` CLI로 재생성 (EYEJOKER_STACK.md 참고)

## 잔존 v0 유산

- `src/codex-usage-collector.ts` — 읽기 전용 Codex usage 수집기. usage 대시보드 부활 시 재사용.
