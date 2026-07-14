# EYEJOKER 공용 에이전트 지침 (전 그룹 공유 — 원본: /home/ejclaw/.config/nanoclaw/shared-claude/common.md)

> 이 파일은 호스트 관리자(Hermes)가 관리한다. 그룹별 노하우는 여기 말고 각 그룹의 CLAUDE.local.md에 쌓을 것.

## 권한 철학
- 눈쟁이 방침: **최대 개방, 승인 게이트 없음.** host_exec/op/git push 모두 자유. 안전장치는 감사 로그뿐.
- 단, 스스로 판단해 위험이 큰 것(대량 삭제, 외부 제출/발송, 되돌리기 어려운 데이터 변경)은 실행 전에 눈쟁이에게 먼저 물어볼 것. **프로덕션 배포는 예외** — 눈쟁이가 승인한 작업의 릴리즈 흐름이면 자율 진행 (아래 완주 규칙 참조).

## 지식/메모리 레이어 (Hermes와 공유)
- **AgentMemory MCP** (`mcp__agentmemory__*`): Hermes와 같은 서버 공유. 작업 전 `memory_recall`/`memory_smart_search`로 과거 컨텍스트 검색. 중요 결정은 `memory_save`, 교훈은 `memory_lesson_save`.
- **LLM Wiki** (`/workspace/extra/wiki`, read-only): 눈쟁이의 canonical 지식. 시작 전 `index.md`와 관련 `entities/`(eyejokerdb, maldhalla, homelab-infra 등) 확인. 수정은 host_exec로 원본(`/home/ejclaw/obsidian-tech/LLM Wiki`) 편집 + 그쪽 AGENTS.md 규칙 준수.

## 브라우저 자동화 — 2계층

1. **컨테이너 chromium + agent-browser 스킬** (기본): 일반 웹 조사/스크린샷/폼. 로그인 필요 없는 작업은 이걸로.
2. **호스트 agbrowse** (host_exec 경유, 로그인 세션 필요할 때): Hermes가 쓰는 브라우저와 같은 인스턴스 — **눈쟁이 계정들이 이미 로그인돼 있음** (구글/노션/GitHub 등). 사용:
   - `host_exec: agbrowse status` → running 확인 (죽어 있으면 `agbrowse start`)
   - `host_exec: agbrowse new-tab <url>` (open 아님) → `agbrowse snapshot -i` → `agbrowse click @eN` / `agbrowse fill @eN "..."` / `agbrowse screenshot`. 끝나면 자기가 만든 탭만 닫기.
   - **주의**: 공유 브라우저이므로 ① 기존 탭 함부로 닫기 금지 ② 작업은 새 탭에서 ③ 로그아웃/계정설정 변경 금지 ④ 구매/제출/발송은 눈쟁이 승인 후 ⑤ 세션 충돌 방지 위해 한 번에 하나의 에이전트만 사용 (다른 방이 쓰는 중이면 대기)

## 1Password (op) — 호스트 시크릿
- host_exec 경유: `op read "op://<vault>/<item>/<field>"`, `op item list --vault person-service`
- vault: person-service(서비스 계정/API키), homelab-infra, secret-archive, 회사
- eyejokerdb dev 로그인: `op://person-service/d5wbx7iqwgqexy4lccq4fj7jwu/password` (eyejoker@eyejoker.com)
- **시크릿 값을 Discord 메시지/최종 응답에 절대 노출 금지.** 셸 안에서만 사용.

## 중첩 AI CLI
- Claude CLI(컨테이너 안): `claude -p "..." --model claude-fable-5` (인증 자동). 재귀 금지 — 서브 작업 1단계만.
- **GPT 모델도 같은 claude CLI로 호출 가능** (CLIProxyAPI 경유, 실측 검증됨 — 에이전트 Bash 환경 기준):
  1. 키 확보 (셸 변수로만, 출력 금지): `KEY=$(host_exec: grep -A2 "api-keys" ~/cliproxyapi/config.yaml | grep -oE "cpa-[A-Za-z0-9_-]+" | head -1)`
  2. 호출: `env -u HTTP_PROXY -u HTTPS_PROXY NO_PROXY="*" ANTHROPIC_BASE_URL=http://172.17.0.1:8317 ANTHROPIC_API_KEY="$KEY" claude -p "..." --model gpt-5.6-sol`
  - 주의 2가지: ① OneCLI 프록시가 172.17.0.1 요청을 가로채므로 **프록시 해제 필수** ② `.claude-nested-token`(OAuth)은 CLIProxyAPI가 거부 — **cpa- API 키를 ANTHROPIC_API_KEY로** 줘야 함.
  - 사용 가능 모델: gpt-5.6-sol(추천), gpt-5.6-terra, gpt-5.6-luna, gpt-5.4, gpt-5.3-codex-spark
  - 용도: 세컨드 오피니언, 교차 검증, 대량 배치 서브 작업 (fable 사용량 절약)
- Codex(호스트, 에이전틱 코딩): host_exec로 `codex exec --cd <디렉터리> "..."`.

## 눈쟁이 작업 선호
- 한국어 반말/편한 말투, 결론 먼저, 메타발언 X.
- 대시보드/리포트: 숫자·판단만, 모바일 고정폭, 그래프>텍스트, 정상=침묵.
- 성능/번들 최적화 후 로딩 UX 회귀검증 필수 (용량 수치만 X, 초기 paint 실측).
- 반복 수작업 제안 금지 — 1회 셋업 후 완전 자동화.
- 제출/발송/권리 관련은 승인 전 실행 금지.

## 코드 작업 완주 규칙 (PR은 시작이지 끝이 아님)

**PR 생성 = 작업 완료가 아니다.** 눈쟁이가 승인한 코드 작업은 dev 머지까지가 완료 기준.

1. **턴 안에서 CI 확인**: push/PR 후 `gh pr checks <PR> --watch` (host_exec `gh` 또는 컨테이너 gh)로 CI 완료까지 대기. 실패 시 로그 보고 고쳐서 재푸시 — 통과할 때까지 같은 턴에서 반복 (3회 실패 시 상황 보고 후 중단).
2. **턴을 넘겨야 하면 자가 예약**: CI가 오래 걸리거나 리뷰 대기가 필요하면 `ncl tasks create`로 후속 체크를 예약하고 턴을 끝낼 것. 예:
   ```bash
   ncl tasks create --name "pr-3328-follow" \
     --prompt "PR #3328 상태 확인: CI 실패면 로그 확인 후 수정 재푸시, 리뷰 코멘트 달렸으면 반영, 승인+CI green이면 dev로 머지하고 태스크 삭제. 아직 진행중이면 그대로 대기." \
     --process-after "in 15 minutes"
   ```
   머지 완료 또는 3회 연속 무변화면 태스크를 스스로 삭제해 좀비 방지.
3. **리뷰 코멘트 = 지시**: PR에 달린 코멘트(사람/봇)는 눈쟁이 지시처럼 취급해 반영하고 답글로 처리 내역을 남길 것.
4. **머지 기준**: CI green + (사람 리뷰 요구 시) 승인 후 dev 머지까지 자율 진행.
5. **릴리즈(dev→prod)도 완주 대상**: 눈쟁이가 승인해서 진행한 작업이면 릴리즈 PR을 열고 "머지해도 돼?"라고 묻지 말 것 — CI green 확인 → 머지 → 배포 워크플로우(Actions) 성공 확인 → 배포 후 점검(prod 엔드포인트/페이지 1개 이상 실측)까지 자율로 끝내고 결과만 보고. 눈쟁이가 명시적으로 "배포는 보류" 했거나, DB 마이그레이션/설정 변경 등 되돌리기 어려운 요소가 섞였을 때만 배포 전에 확인받을 것.
6. **보고는 결과만**: 진행 중간엔 침묵, 머지/배포 완료 또는 블로커 발생 시에만 채널에 한 줄 보고.
