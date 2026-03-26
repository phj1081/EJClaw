---
name: debug
description: Debug EJClaw runtime issues on the current Discord-only, host-process architecture.
---

# EJClaw Debugging

현재 기준 EJClaw는 디스코드 전용이고, 에이전트는 컨테이너가 아니라 호스트 프로세스로 실행됩니다. 디버깅은 `채널`, `서비스`, `러너`, `DB 등록`, `자격 증명` 순서로 좁혀갑니다.

## 빠른 점검 순서

1. 타입과 테스트부터 확인
   ```bash
   npm run typecheck
   npm test
   ```
2. 서비스 상태 확인
   ```bash
   npm run setup -- --step verify
   ```
3. 런타임 로그 확인
   ```bash
   tail -f logs/ejclaw.log
   tail -f logs/ejclaw.error.log
   ls -t groups/*/logs/agent-*.log | head
   ```
4. 러너 빌드 확인
   ```bash
   npm run build:runners
   ```

## 핵심 파일

- `src/index.ts` - 메시지 루프, 세션 명령, 라우팅
- `src/channels/discord.ts` - 디스코드 수신/송신, 멘션, 첨부파일, 음성 전사
- `src/agent-runner.ts` - 러너 실행, 환경 변수 전달, 워크디렉터리 처리
- `runners/agent-runner/src/index.ts` - Claude Code 러너
- `runners/codex-runner/src/index.ts` - Codex 러너
- `src/db.ts` - 등록 그룹, 세션, 스케줄 저장
- `setup/register.ts` - 디스코드 채널 등록
- `setup/verify.ts` - 설치 상태 검증

## 자주 보는 문제

### 봇이 아예 말이 없음

```bash
grep -n '^DISCORD_BOT_TOKEN=' .env
npm run setup -- --step verify
```

- `DISCORD_BOT_TOKEN`이 없으면 채널이 안 붙습니다.
- `REGISTERED_GROUPS=0`이면 채널 등록이 안 된 상태입니다.
- 메인 채널이 아니면 디스코드 멘션이나 트리거 조건을 먼저 확인합니다.

### 에이전트가 실행 직후 죽음

```bash
grep -nE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_OPENAI_API_KEY)=' .env
ls -t groups/*/logs/agent-*.log | head -3
```

- Claude 계열은 `CLAUDE_CODE_OAUTH_TOKEN` 또는 `ANTHROPIC_API_KEY`가 필요합니다.
- Codex 계열은 `OPENAI_API_KEY` 또는 `CODEX_OPENAI_API_KEY`가 필요합니다.
- 러너 로그에 인증 실패나 CLI 실행 오류가 바로 찍힙니다.

### 음성 전사가 안 됨

```bash
grep -nE '^(GROQ_API_KEY|OPENAI_API_KEY)=' .env
tail -f logs/ejclaw.log | grep -iE 'transcri|audio|whisper|groq'
```

- 기본 우선순위는 Groq Whisper, 없으면 OpenAI Whisper fallback입니다.
- 키가 없으면 디스코드 채널은 음성 첨부를 텍스트로 확장하지 못합니다.

### 등록은 되어 있는데 응답이 이상함

```bash
sqlite3 store/messages.db "select jid, folder, requires_trigger, is_main, agent_type from registered_groups;"
```

- `jid`는 `dc:<channel_id>` 형식이어야 합니다.
- `folder`는 `discord_main` 또는 `discord_<name>` 형태를 유지합니다.
- 세션 명령 문제면 `src/session-commands.ts`와 `src/index.ts` 호출부를 같이 봅니다.

## 원칙

- 채널 문제와 에이전트 문제를 섞지 말고 분리해서 봅니다.
- `.env`, DB 등록, 서비스, 러너 빌드 중 하나라도 틀리면 상위 증상이 비슷하게 보입니다.
- 컨테이너 전제 문서는 무시하고 `runners/*`와 `setup/*` 기준으로 확인합니다.
