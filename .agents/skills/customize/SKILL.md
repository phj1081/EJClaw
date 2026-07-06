---
name: customize
description: Customize Discord-only EJClaw behavior, routing, integrations, prompts, or commands.
---

# EJClaw Customization

이 스킬은 현재 디스코드 전용 EJClaw를 기준으로 동작합니다. 새 채널 추가보다 기존 디스코드 흐름, 러너, 프롬프트, 스케줄링, 도구 연결을 직접 수정하는 쪽을 우선합니다.

## 진행 순서

1. 요청을 `행동 변경`, `명령 추가`, `도구 연동`, `설정/배포`, `프롬프트 수정` 중 어디에 속하는지 먼저 정리합니다.
2. 영향 범위를 좁힙니다.
3. 관련 파일만 수정합니다.
4. 가능하면 바로 검증합니다.

## 자주 보는 수정 지점

- `src/channels/discord.ts` - 디스코드 메시지 파싱, 멘션 규칙, 첨부파일 처리, 음성 전사
- `src/index.ts` - 오케스트레이션, 세션 명령, 라우팅, 상태 갱신
- `src/session-commands.ts` - `/compact`, `/clear` 같은 세션 명령
- `src/db.ts` - 등록 그룹, 세션, 스케줄, 마이그레이션
- `src/config.ts` - 서비스 식별값, 디렉터리, 타임아웃, 기능 플래그
- `src/agent-runner.ts` - 에이전트 실행과 환경 변수 전달
- `runners/agent-runner/src/index.ts` - Codex 쪽 허용 도구와 MCP
- `runners/codex-runner/src/index.ts` - Codex 쪽 실행 경로
- `setup/register.ts` - 디스코드 채널 등록
- `groups/global/AGENTS.md` 및 각 그룹의 `AGENTS.md` - 프롬프트/운영 규칙

## 요청별 가이드

### 동작을 바꾸고 싶을 때

- 응답 조건, 멘션 처리, 첨부파일 처리: `src/channels/discord.ts`
- 세션 명령, 상태머신, 런루프: `src/index.ts`, `src/session-commands.ts`
- 페르소나/응답 스타일: `groups/global/AGENTS.md`

### 도구나 MCP를 붙일 때

- 러너에 실제 도구 허용과 MCP 설정을 추가합니다.
- Codex 쪽은 `runners/agent-runner/src/index.ts`를 먼저 보고, 필요하면 `src/agent-runner.ts`의 env 전달 범위를 같이 수정합니다.
- 그룹별 사용 규칙은 해당 `AGENTS.md`에 문서화합니다.

### 새 명령을 만들 때

- 먼저 슬래시 명령인지, 자연어 규칙인지 구분합니다.
- 슬래시/예약 명령이면 `src/session-commands.ts`와 `src/index.ts` 경로를 봅니다.
- 자연어 지시만으로 충분하면 프롬프트 문서만 수정합니다.

### 등록/배포 흐름을 바꿀 때

- 설치/검증 단계는 `setup/*`
- 서비스 동작은 `setup/service.ts`
- 그룹 등록 형식은 `setup/register.ts`

## 검증 원칙

작게 바꿨으면 최소 이 정도는 확인합니다.

```bash
bun run typecheck
bun test
```

러너나 실행 경로를 건드렸으면 추가로 확인합니다.

```bash
bun run build:runners
bun run setup -- --step verify
```
