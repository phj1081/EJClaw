# Checklist Continuation Mode Plan

## 목표

- 장기 리팩토링/장기 과제가 중간 `DONE`에서 끊기지 않게 한다.
- `DONE`의 의미는 유지한다.
  - `DONE` = 이번 step 승인
  - task 종료 = 마지막 step 완료
- `DONE_WITH_CONCERNS`를 continuation 용도로 남용하지 않게 한다.

## 원칙

- 새 상태값/새 테이블/마이그레이션부터 늘리지 않는다.
- 기존 `paired_tasks.plan_notes`를 versioned JSON으로 재사용한다.
- split point는 reviewer `DONE`이 아니라 owner finalize 직전이다.
- Arbiter/deadlock은 step 단위로 보고, 장기 stagnation은 plan 단위로 본다.

## 단계 전략

### 1. Lite Plan Mode

복잡도를 크게 늘리지 않고 플랜모드의 UX만 먼저 도입한다.

- `plan_notes`에 체크리스트 저장
- 명령:
  - `플랜 시작: 1) ... 2) ...`
  - `플랜 상태`
  - `플랜 중지`
- 현재 step / 남은 step / 직전 요약만 표시
- 다음 step은 사용자가 수동으로 진행

장점:

- 상태 머신을 거의 건드리지 않는다
- 기존 owner/reviewer/arbiter 루프와 충돌이 적다
- checklist 기반 장기 작업 UX를 바로 제공할 수 있다

제한:

- `DONE` 후 자동 다음 step은 없다
- fresh session 자동 절단도 없다

### 2. Real Continuation Mode (MVP)

자동 continuation이 필요한 경우에만 확장한다.

- `plan_notes` JSON 스키마 + 파서
- 플랜 시작 / 상태 / 중지 명령
- owner finalize continuation 분기
- `round_trip_count` step 단위 리셋
- fresh session prompt wiring
- 테스트

## `plan_notes` JSON 스키마

```json
{
  "version": 1,
  "mode": "planned",
  "items": [
    {
      "id": "step-1",
      "title": "A 리팩토링",
      "status": "done",
      "summary": "직전 step 요약",
      "changedFiles": ["src/a.ts"]
    },
    {
      "id": "step-2",
      "title": "B 리팩토링",
      "status": "in_progress"
    },
    {
      "id": "step-3",
      "title": "C 리팩토링",
      "status": "pending"
    }
  ],
  "currentIndex": 1,
  "autoContinueOnDone": true,
  "maxAutoTurns": 6,
  "autoTurnsUsed": 2,
  "lastStepSummary": "A 완료"
}
```

판별 규칙:

- `plan_notes`가 versioned JSON이고 `mode: "planned"`일 때만 continuation mode로 해석
- 그 외 값은 legacy/freeform note로 유지

## 구현 포인트

### owner finalize 분기

- 위치: `src/paired-execution-context-owner.ts`
- reviewer 승인 후 owner finalize가 `DONE`이고 남은 checklist item이 있으면:
  - 현재 item -> `done`
  - 다음 item -> `in_progress`
  - `round_trip_count = 0`
  - `autoTurnsUsed += 1`
  - `lastStepSummary`, `changedFiles` 저장
  - task status는 `completed`가 아니라 continuation 가능한 상태로 유지
- 마지막 item일 때만 `completed`

### 다음 owner step 자동 시작

- 위치: `src/message-runtime-rules.ts`
- planned task는 `active + lastTurnOutputRole=owner`라도 `owner-follow-up`으로 이어질 수 있어야 한다

### compact owner prompt

- 위치: `src/message-runtime-prompts.ts`
- planned continuation에서는 기존 pending prompt를 그대로 재사용하지 않는다
- 다음 step prompt에는 최소한 아래만 전달한다
  - 현재 checklist item
  - 직전 step 요약
  - 변경 파일 목록
  - 남은 item 목록

## 외부 프로젝트에서 차용할 것

### Archon

- checklist step 진행
- fresh context
- approval gate 발상

### OpenHarness

- permission mode 분리
- auto-compaction 같은 운영 아이디어

## 외부 프로젝트에서 차용하지 않을 것

- Archon의 YAML DAG/workflow 엔진 전체
- OpenHarness의 `plan mode` 자체
  - 이쪽은 continuation 엔진이 아니라 permission toggle에 가깝다
- 프레임워크/런타임 통째 교체

## 구현 순서 제안

1. Lite Plan Mode
2. 실제 사용 패턴 확인
3. Real Continuation Mode MVP
4. 이후 compaction / permission polish는 별도 enhancement

## out of scope

- step 순서 변경
- step 분할/병합
- 중간 삽입/삭제
- 새 테이블 도입
- auto-compaction 본체 구현
