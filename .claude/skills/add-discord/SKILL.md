---
name: add-discord
description: Finish Discord bot setup and registration for EJClaw.
---

# Add Discord Channel

현재 저장소에는 디스코드 채널 구현이 이미 포함되어 있습니다. 이 스킬은 외부 브랜치를 머지하는 용도가 아니라, 토큰 설정과 채널 등록을 빠르게 끝내는 체크리스트로 사용합니다.

## 1. 전제 확인

확인할 것:

- `src/channels/discord.ts`가 존재하는지
- `package.json`에 `discord.js`가 있는지
- `npm run typecheck`가 통과하는지

## 2. 봇 토큰 준비

토큰이 없다면 디스코드 개발자 포털에서 새 애플리케이션과 봇을 만들고 아래 권한을 켭니다.

- `Message Content Intent`
- 필요하면 `Server Members Intent`

봇 초대 링크는 `bot` 스코프와 최소 `Send Messages`, `Read Message History`, `View Channels` 권한으로 생성합니다.

## 3. 환경 변수 설정

`.env`:

```bash
DISCORD_BOT_TOKEN=<token>
```

선택:

```bash
DISCORD_CODEX_BOT_TOKEN=<second-token>
```

두 번째 토큰이 있으면 Codex 전용 디스코드 봇도 따로 띄울 수 있습니다.

## 4. 채널 등록

디스코드에서 개발자 모드를 켜고 채널 ID를 복사합니다. 등록 JID는 `dc:<channel-id>` 형식입니다.

메인 채널:

```bash
npm run setup -- --step register -- \
  --jid dc:<channel-id> \
  --name "<server-name> #<channel-name>" \
  --folder discord_main \
  --trigger @Andy \
  --is-main \
  --no-trigger-required
```

보조 채널:

```bash
npm run setup -- --step register -- \
  --jid dc:<channel-id> \
  --name "<server-name> #<channel-name>" \
  --folder discord_<channel-name> \
  --trigger @Andy
```

## 5. 빌드와 검증

```bash
npm run build
npm run build:runners
npm run setup -- --step service
npm run setup -- --step verify
```

필요하면 로그 확인:

```bash
tail -f logs/ejclaw.log
```

메인 채널이면 일반 메시지, 보조 채널이면 멘션 또는 트리거 메시지로 테스트합니다.
