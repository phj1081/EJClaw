# EJClaw — retired (2026-07-14)

EJClaw(Tribunal owner/reviewer/arbiter 스택)는 2026-07-14에 은퇴했다.
후속 스택은 NanoClaw 기반의 얇은 구성으로 대체됐다.

## 대체 구조

```text
NanoClaw (~/NanoClaw, upstream + 최소 carry patch)
├─ Discord adapter (upstream channels 브랜치 + 기존 오너 봇 토큰)
├─ EYEJOKER 그룹  → Claude Agent SDK → 공식 Claude 구독 → claude-fable-5
├─ GPT 그룹      → gpt-proxy provider → CLIProxyAPI(172.17.0.1:8317) → Codex OAuth 풀
├─ ECC rules/skills/hooks (~/ecc-poc, sync-to-nanoclaw.sh로 그룹에 투영)
└─ host_exec MCP → ~/nanoclaw-host-executor (Unix socket, audit log, 위험명령 확인 게이트)
```

## 이 저장소에 남긴 것

- `src/codex-usage-collector.ts` (+ test) — 읽기 전용 Codex usage 수집기.
  usage 대시보드를 되살릴 때 재사용할 유일한 모듈.
- 전체 이전 코드/히스토리는 git history와
  `~/archive/ejclaw-retired-20260714/` (bundle, DB tarball, stash 패치)에 보존.

## 은퇴 시점 상태

- `ejclaw.service`, `ejclaw-codex-review.service`, `ejclaw-claude-token-refresh.timer`
  → disabled + stopped
- 마지막 알려진 결함: reviewer 슬롯이 존재하지 않는 모델 `gpt-5.5`를 참조해
  Tribunal review 단계가 실패/대기 상태로 남았음 (`gpt-5.6-*`로 계정이 이관된 뒤 방치된 설정).
- Discord 방 등록 25개 중 EJcrawler만 NanoClaw로 이관 완료.
  나머지 방은 필요할 때 NanoClaw 그룹/wiring으로 개별 이관한다.
