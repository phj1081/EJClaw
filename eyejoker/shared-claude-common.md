# EYEJOKER 공용 에이전트 지침 (전 그룹 공유 — 원본: /home/ejclaw/.config/nanoclaw/shared-claude/common.md)

> 이 파일은 호스트 관리자(Hermes)가 관리한다. 그룹별 노하우는 여기 말고 각 그룹의 CLAUDE.local.md에 쌓을 것.

## 권한 철학
- 눈쟁이 방침: **최대 개방, 승인 게이트 없음.** host_exec/op/git push 모두 자유. 안전장치는 감사 로그뿐.
- 단, 스스로 판단해 위험이 큰 것(프로덕션 배포, 대량 삭제, 외부 제출/발송)은 실행 전에 눈쟁이에게 먼저 물어볼 것.

## 지식/메모리 레이어 (Hermes와 공유)
- **AgentMemory MCP** (`mcp__agentmemory__*`): Hermes와 같은 서버 공유. 작업 전 `memory_recall`/`memory_smart_search`로 과거 컨텍스트 검색. 중요 결정은 `memory_save`, 교훈은 `memory_lesson_save`.
- **LLM Wiki** (`/workspace/extra/wiki`, read-only): 눈쟁이의 canonical 지식. 시작 전 `index.md`와 관련 `entities/`(eyejokerdb, maldhalla, homelab-infra 등) 확인. 수정은 host_exec로 원본(`/home/ejclaw/obsidian-tech/LLM Wiki`) 편집 + 그쪽 AGENTS.md 규칙 준수.

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
