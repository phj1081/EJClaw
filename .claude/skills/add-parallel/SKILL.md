---
name: add-parallel
description: Add Parallel AI MCP tools to the current host-process Claude runner.
---

# Add Parallel AI Integration

Parallel AI는 현재 구조에서도 유효한 도구 연동입니다. 다만 예전 문서처럼 컨테이너를 수정하지 않고, Claude 러너의 MCP 설정만 바꿉니다.

## 1. API 키 준비

`PARALLEL_API_KEY`를 `.env`에 넣습니다.

```bash
PARALLEL_API_KEY=...
```

## 2. 환경 변수 전달

`src/agent-runner.ts`

- `.env`에서 `PARALLEL_API_KEY`를 읽도록 `readEnvFile([...])` 목록에 추가합니다.
- Claude 러너 child env에 `PARALLEL_API_KEY`를 넣습니다.

## 3. MCP 서버 등록

`runners/agent-runner/src/index.ts`

- `query({ options: { mcpServers } })`에 Parallel HTTP MCP 서버를 추가합니다.
- `allowedTools`에 `mcp__parallel-search__*`, `mcp__parallel-task__*`를 추가합니다.

구분은 이렇게 가져가는 편이 안전합니다.

- `parallel-search`: 빠른 검색, 저비용, 기본 허용
- `parallel-task`: 긴 조사 작업, 비용/시간이 더 큼, 명시적 승인 후 사용

## 4. 프롬프트 규칙 추가

`groups/global/CLAUDE.md` 또는 대상 그룹의 `CLAUDE.md`

아래 원칙을 문서화합니다.

- 빠른 사실 조회나 최신 정보 확인은 `parallel-search`
- 긴 조사나 깊은 분석은 `parallel-task`
- `parallel-task`는 항상 먼저 사용자 허가를 받을 것
- 오래 걸리는 작업은 답변을 붙잡고 있지 말고 `mcp__ejclaw__schedule_task`로 후속 체크를 맡길 것

## 5. 빌드와 검증

```bash
npm run build:runners
npm run build
npm run setup -- --step service
```

디스코드 테스트 예시:

> `최신 AI 뉴스 찾아줘`

> `AI 에이전트 역사 자세히 조사해줘`

두 번째 요청에서는 비용/시간 안내 후 허가를 먼저 묻게 만드는 게 맞습니다.

## 문제 확인

### MCP가 안 뜸

- `PARALLEL_API_KEY`가 child env까지 전달되는지 확인합니다
- `allowedTools`에 Parallel prefix가 빠지지 않았는지 봅니다

### 긴 작업이 응답을 오래 붙잡음

- `parallel-task` 결과를 기다리며 블로킹하지 말고 스케줄러로 넘기도록 프롬프트와 구현을 같이 수정합니다
