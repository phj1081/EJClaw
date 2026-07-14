# NanoClaw Carry 관리 — EYEJOKER 포지션

EJClaw는 upstream NanoClaw 위의 **얇은 carry 레이어 관리 주체**다.
upstream에 PR하지 않는(못 받을) 기능들을 여기서 기능 단위로 버전 관리한다.

## 현재 carry 시리즈 (upstream base: ef220b53)

| # | patch | 성격 | upstream 충돌 위험 |
|---|-------|------|-------------------|
| 0001 | Discord adapter | upstream `channels` 브랜치 산출물 | 낮음 (skill-install 영역) |
| 0002 | gpt-proxy provider | 16줄 등록 | 매우 낮음 |
| 0003 | container-runner carries | OneCLI CA / git auth / nested sentinel | 중간 (container-runner.ts 직접 수정) |
| 0004 | EYEJOKER_STACK.md | 문서 | 없음 |
| 0005–0007 | **live progress UX** | typing 모듈 확장 + activity_log | 중간 (typing/index.ts, claude.ts, chat-sdk-bridge.ts) |
| 0008 | Discord 시스템 메시지 드랍 | 버그픽스 | **upstream PR #3039 제출됨** — merge되면 이 패치 드랍 |

- `patches/` — `git format-patch` 시리즈 (기능별 rebase/드랍 판단용, 정본)
- `carry-20260714.patch` — 통짜 diff (빠른 전체 적용용, 파생본)

## upstream 업데이트 절차

```bash
cd ~/NanoClaw
git fetch origin
git checkout -b eyejoker/carry-$(date +%Y%m%d) origin/main
git am ~/EJClaw/nanoclaw-src/patches/*.patch   # 충돌 시 기능 단위로 해결/드랍
pnpm exec tsc --noEmit && pnpm vitest run && pnpm build
# 검증 후 서비스 전환, EJClaw에 새 시리즈 재생성:
git format-patch <new-base>..HEAD -o ~/EJClaw/nanoclaw-src/patches/ --zero-commit
git diff <new-base>..HEAD > ~/EJClaw/nanoclaw-src/carry-<date>.patch
```

## 충돌 시 판단 기준

1. **0002 (gpt-proxy)**: 사실상 영구 유지. upstream provider 레지스트리 시그니처만 추종.
2. **0005–0007 (progress UX)**: upstream이 typing 모듈을 크게 바꾸면
   렌더러(`progressBody`)는 보존하고 신호원(heartbeat/container_state/processing_ack)만 재배선.
   activity_log 테이블/훅은 display-only라 어떤 upstream 변경과도 데이터 충돌 없음.
3. **0003 (container-runner)**: upstream이 같은 기능(예: per-group CA env)을 도입하면 드랍하고 upstream 채택.
4. upstream이 progress 기능을 자체 도입하면: 우리 0005–0007 드랍 후 upstream 기능 위에 렌더러 취향만 carry.

## 불변 원칙

- carry는 **기능 추가만**, upstream 코어 로직 수정 금지 (수정 필요 시 모듈 경계에서 후킹)
- 새 테이블은 display-only + `CREATE TABLE IF NOT EXISTS` (스키마 마이그레이션 비의존)
- 시크릿은 carry 코드에 하드코딩 금지 — env/1Password 경유
- 모든 carry 변경은 라이브 acceptance (실제 Discord 스레드) 후 커밋
