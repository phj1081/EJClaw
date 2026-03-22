---
name: update-ejclaw
description: Safely merge upstream EJClaw changes into a customized install with minimal drift.
---

# Update EJClaw

커스텀된 EJClaw에 upstream 변경을 가져올 때 쓰는 절차입니다. 현재 기준 중요 경로는 `src/`, `runners/`, `setup/`, `.claude/skills/`, `groups/`, `README.md` 입니다.

## 원칙

- 워킹트리가 더럽다면 진행하지 않습니다
- 시작 전에 항상 백업 브랜치와 태그를 만듭니다
- 먼저 `preview`, 그 다음 `merge` 또는 `cherry-pick` 순서로 갑니다
- 충돌이 나면 충돌 파일만 엽니다

## 1. 사전 점검

```bash
git status --porcelain
git remote -v
git fetch upstream --prune
```

- 변경 파일이 남아 있으면 먼저 정리하게 합니다
- `upstream`이 없으면 추가합니다
- upstream 기본 브랜치가 `main`인지 먼저 확인합니다

## 2. 백업

```bash
HASH=$(git rev-parse --short HEAD)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
git branch backup/pre-update-$HASH-$TIMESTAMP
git tag pre-update-$HASH-$TIMESTAMP
```

## 3. 미리 보기

```bash
BASE=$(git merge-base HEAD upstream/main)
git log --oneline $BASE..upstream/main
git log --oneline $BASE..HEAD
git diff --name-only $BASE..upstream/main
```

파일은 대략 이렇게 나눠서 봅니다.

- `.claude/skills/` - 스킬 문서/도우미
- `src/` - 런타임과 채널 처리
- `runners/` - Claude/Codex 실행 경로
- `setup/` - 설치, 등록, 검증, 서비스
- `README.md`, `groups/` - 운영 문서와 프롬프트

## 4. 적용

기본은 merge 입니다.

```bash
git merge upstream/main --no-edit
```

일부 커밋만 가져올 거면 cherry-pick으로 갑니다.

```bash
git cherry-pick <hash1> <hash2>
```

## 5. 충돌 처리

- 충돌 파일만 엽니다
- 로컬 커스터마이징은 유지합니다
- 주변 리팩터링은 하지 않습니다
- 해결 후 바로 `git add <file>` 합니다

## 6. 검증

```bash
pnpm typecheck
pnpm test
pnpm build:runners
pnpm build
```

런타임 경로가 바뀌었으면 추가로 확인합니다.

```bash
pnpm setup -- --step verify
```

## 7. 요약

사용자에게 최소한 이 네 가지를 알려줍니다.

- 백업 태그 이름
- 새 HEAD
- 해결한 충돌 파일 목록
- upstream 대비 아직 남은 로컬 diff

롤백 안내는 태그 기준으로 알려줍니다.
