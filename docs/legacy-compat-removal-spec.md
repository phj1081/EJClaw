# EJClaw 레거시 호환 제거 및 구조 정리 Spec

- 상태: Draft
- 대상: 코어 개발자 / 리팩토링 담당자
- 기준일: 2026-04-09
- 기준: 저장소 정적 분석 결과
- 참고: 현재 환경에는 Bun 런타임이 없어 테스트/실행 검증은 하지 못했고, 이 문서는 코드 구조와 저장소 상태를 기준으로 작성했다.

## 0. 한 줄 결론

이 저장소의 핵심 문제는 **문서상 SSOT는 하나인데, 실제 런타임/설정/검증 경로에는 예전 방식이 계속 살아 있어서 같은 의미가 2~3군데에서 동시에 정의되는 점**이다. 이 브랜치의 목표는 “조금 더 예쁘게 정리”가 아니라, **레거시 호환 경로를 런타임에서 완전히 제거하고, 데이터 모델과 실행 경로를 단일화하는 것**이다.

---

## 1. 문제 정의

현재 저장소는 README 상으로는 다음을 선언하고 있다.

- `room_settings`가 room-level SSOT
- 공개 room assignment 인터페이스는 `assign_room`
- `registered_groups`는 legacy fallback 성격의 materialized layer

하지만 실제 코드는 아래와 같이 동작한다.

1. setup 경로는 여전히 `registered_groups`에 직접 쓴다.
2. 앱 시작 시 `registered_groups`를 읽어서 `room_settings`를 다시 복원한다.
3. verify/setup/환경 점검은 `room_settings`와 `registered_groups`를 동시에 본다.
4. 일부 런타임 읽기 로직은 저장된 값이 부족하면 `room_settings`, `registered_groups`, `folder`, `service shadow`를 조합해서 의미를 “추론”한다.
5. 레거시 JSON 파일과 환경변수 alias도 아직 읽는다.

즉, 현재 버그의 근본 원인은 단순한 코드 스타일 문제가 아니라, **도메인 의미가 여러 저장소/레이어에 중복 저장되고, 부족한 값을 읽기 시점에 복원하는 구조**에 있다.

---

## 2. 이 리팩토링의 목표

### 목표

1. **단일 진실원(SSOT) 확립**
   - room 메타데이터와 실행 설정은 하나의 canonical schema만 사용한다.

2. **런타임에서 레거시 호환 제거**
   - startup, read-path, verify-path 어디에서도 legacy row/json/env alias를 fallback으로 읽지 않는다.

3. **쓰기 시 canonical, 읽기 시 deterministic**
   - 새 데이터는 항상 완전한 canonical 형태로 저장한다.
   - 읽을 때 추론/복원/재구성을 하지 않는다.

4. **책임 분리(SRP)**
   - setup, migration, runtime, delivery, scheduler, agent process spawning의 책임을 분리한다.

5. **작은 단위로 안전하게 삭제**
   - “리팩토링하면서 조금씩 살리기”가 아니라, migration → cutover → 삭제 순으로 간다.

### 비목표

1. Tribunal 동작 규칙 자체를 새로 설계하지 않는다.
2. Discord 채널 UX를 바꾸는 작업은 이번 범위의 중심이 아니다.
3. 모델/프로바이더 전략 자체를 갈아엎는 작업은 아니다.
4. 대규모 네이밍 변경을 첫 PR에서 같이 하지 않는다.
   - 동작 변경과 rename을 한 PR에 섞지 않는다.

---

## 3. 저장소 감사 결과

### 3.1 SSOT 선언과 실제 구현이 다르다

문서에서는 `room_settings`를 SSOT라고 적고 있지만, 실제 동작에서는 `registered_groups`가 아직도 쓰기/읽기/복원 경로에 살아 있다.

| 위치                            | 관찰 내용                                                                          | 의미                                          |
| ------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `README.md:37-43`               | `room_settings`가 SSOT라고 문서화                                                  | 설계 의도는 명확함                            |
| `setup/register.ts:116-160`     | setup 단계가 `registered_groups`를 직접 생성/쓰기                                  | 공식 setup 경로가 canonical write path를 우회 |
| `src/db.ts:810-878`             | `assignRoom()`이 `room_settings`를 쓰면서 동시에 `registered_groups`를 materialize | 하나의 행위를 두 저장소에 반영                |
| `src/db.ts:1000-1016`           | startup 시 `registered_groups`를 읽어서 `room_settings`를 다시 sync                | 런타임이 legacy projection을 source처럼 사용  |
| `src/db.ts:907-935`             | `getAllRegisteredGroups()`가 stored rows + legacy rows를 합쳐서 반환               | read path가 dual-source                       |
| `setup/verify-state.ts:124-158` | tribunal room 계산 시 `room_settings`와 `registered_groups`를 UNION/fallback       | verify도 dual-source                          |

### 3.2 setup 경로가 SRP를 심하게 위반한다

`setup/register.ts`는 실제로 아래를 한 번에 수행한다.

1. SQLite 테이블 생성/쓰기
2. 그룹 폴더 생성
3. `groups/.../CLAUDE.md` 수정
4. `.env`의 `ASSISTANT_NAME` 수정

특히 `setup/register.ts:170-214`는 채널 등록 단계가 assistant identity까지 바꾸고 있다. 이건 room assignment와 완전히 다른 책임이다.

결론: **setup/register는 room 등록 도구가 아니라, 여러 전역 설정을 몰래 바꾸는 side-effect command**다.

### 3.3 startup이 암묵적 마이그레이션을 수행한다

`src/db/bootstrap.ts:46-92`는 startup 흐름에서 아래 파일을 읽고 `.migrated`로 rename한다.

- `router_state.json`
- `sessions.json`
- `registered_groups.json`

또 `setup/environment.ts:45-58`는 아직도 `registered_groups.json` 존재 여부를 setup 상태 판단에 사용한다.

결론: **앱 시작 자체가 데이터 정리/마이그레이션 도구 역할을 하고 있어 재현 가능성과 디버깅 가능성을 해친다.**

### 3.4 읽기 시점 복원 로직이 많다

`src/db/legacy-rebuilds.ts:19-96`와 `src/db/paired-state.ts:85-120`는 저장된 값이 부족해도 아래 소스를 뒤져서 owner/reviewer agent type을 복원한다.

- persisted row
- `room_settings`
- `registered_groups` by jid
- `registered_groups` by folder
- service shadow

이 구조에서는 row가 불완전해도 시스템이 계속 돌아가므로, 데이터가 어긋난 상태가 초기에 드러나지 않고 런타임 버그로 누적된다.

결론: **canonical write가 아니라 read-time repair에 의존하고 있다.**

### 3.5 legacy alias가 계속 살아 있다

현재 프로덕션 코드가 여전히 읽는 레거시 alias/호환 키:

- Discord bot token alias (`src/channels/discord.ts:30-63`)
  - `DISCORD_BOT_TOKEN`
  - `DISCORD_CLAUDE_BOT_TOKEN`
  - `DISCORD_CODEX_BOT_TOKEN`
  - `DISCORD_CODEX_MAIN_BOT_TOKEN`
  - `DISCORD_REVIEW_BOT_TOKEN`
  - `DISCORD_CODEX_REVIEW_BOT_TOKEN`
- session command sender alias (`src/config/load-config.ts:218-223`)
  - `SESSION_COMMAND_USER_IDS`
- router state legacy key alias (`src/index.ts:172-203`)
  - `last_timestamp` → `last_seq`
  - `last_agent_timestamp` → `last_agent_seq`

결론: **canonical config/state 이름이 있어도 시스템은 구 이름을 받아주기 때문에, 실제 운영 상태를 확신하기 어렵다.**

### 3.6 God file / high coupling이 심하다

정적 집계 기준, 주요 production 파일 크기는 다음과 같다.

- `src/db.ts` — 1342 LOC
- `src/db/schema.ts` — 1139 LOC
- `src/group-queue.ts` — 1044 LOC
- `src/message-agent-executor.ts` — 910 LOC
- `src/channels/discord.ts` — 892 LOC
- `src/ipc.ts` — 858 LOC
- `src/paired-workspace-manager.ts` — 850 LOC
- `src/message-runtime.ts` — 757 LOC
- `src/index.ts` — 569 LOC
- `src/agent-runner.ts` — 557 LOC

추가로 함수 길이도 길다.

- `createMessageRuntime()` — 636 LOC
- `runAgentProcess()` — 494 LOC
- `runTask()` — 367 LOC
- `main()` — 237 LOC

또한 `db.js` façade를 직접 import하는 파일이 47개다.

결론: **현재 구조는 개별 버그 수정이 곧 전체 시스템 리스크로 이어지는 결합 형태**다.

### 3.7 runner 계층 중복이 있다

- `runners/agent-runner/src/room-role-context.ts` — 23 LOC
- `runners/codex-runner/src/room-role-context.ts` — 23 LOC (동일)

`reviewer-runtime.ts`도 역할 정책이라는 같은 도메인을 두 러너가 따로 유지한다.

결론: **러너별 구현 차이가 아니라 공통 정책 코드의 중복 유지비가 발생하고 있다.**

### 3.8 테스트도 레거시 호환에 많이 묶여 있다

정적 검색상 `legacy|backfill|compat|backward` 키워드가 테스트 코드에서 247개 라인에 등장한다.

문제는 테스트가 많다는 점이 아니라, **원하는 최종 행동보다 과거 호환 동작을 보호하는 표면적이 너무 넓다**는 점이다.

---

## 4. 핵심 설계 결정

### 결정 1. `registered_groups`는 더 이상 runtime source가 아니다

최종 목표는 아래 둘 중 하나다.

1. **권장안:** `registered_groups` 테이블 자체 제거
2. **차선안:** SQL VIEW 또는 in-memory projection으로만 유지
   - 단, write path 금지
   - source로 사용 금지

이번 브랜치의 목표가 “레거시 호환 제거”인 만큼, 최종 상태는 **삭제**를 기본으로 한다.

### 결정 2. canonical persistence를 아래처럼 재구성한다

#### 4.2.1 room-level truth

`room_settings`를 room-level canonical table로 유지하되, 필요한 필드를 보강한다.

권장 canonical field:

- `chat_jid`
- `name`
- `folder`
- `trigger_pattern`
- `requires_trigger`
- `is_main`
- `work_dir`
- `room_mode`
- `owner_agent_type`
- `created_at`
- `updated_at`

#### 4.2.2 role/runtime override 분리

현재 `registered_groups.agent_config`가 사실상 role/runtime override 역할까지 떠안고 있으므로, 아래 신규 테이블을 추가한다.

`room_role_overrides`

- `chat_jid`
- `role` (`owner` | `reviewer` | `arbiter`)
- `agent_type`
- `agent_config_json`
- `created_at`
- `updated_at`
- PK: (`chat_jid`, `role`)

이렇게 하면

- room-level 설정은 `room_settings`
- role/runtime override는 `room_role_overrides`
- 실제 실행용 DTO는 코드에서 조립

으로 명확히 나뉜다.

### 결정 3. startup은 마이그레이션을 수행하지 않는다

startup이 해도 되는 일:

- DB open
- schema version check
- required table existence check
- fail fast

startup이 하면 안 되는 일:

- JSON state 읽고 rename
- legacy table 보고 canonical row 재구성
- 불완전 row를 추론으로 보정

즉, `src/db/bootstrap.ts`의 JSON migration과 `src/db.ts`의 `syncLegacyRegisteredGroupsIntoStoredRooms()`는 **명시적 migration command**로 옮기고 런타임 경로에서 제거한다.

### 결정 4. 읽기 시 복원 대신 쓰기 시 canonical complete row를 강제한다

새로 생성되는 row는 항상 아래를 완전하게 가져야 한다.

- paired task: owner/reviewer/arbiter agent type
- paired task: owner/reviewer service id
- channel owner lease: role별 agent/service metadata
- service handoff/work item: target/source role 및 canonical service id

읽기 시에는 아래를 금지한다.

- folder 기반 agent type 추론
- legacy table 기반 fallback
- service id shadow를 보고 agent type 재추론

`legacy-rebuilds.ts`는 migration 기간이 끝나면 삭제한다.

### 결정 5. setup은 application service를 호출해야 한다

`setup/register.ts`처럼 setup 코드가 직접 SQL을 치고, 파일 시스템을 수정하고, `.env`를 바꾸는 구조를 금지한다.

setup은 아래 중 하나만 해야 한다.

- `assignRoom()` 같은 application service 호출
- dedicated config command 호출

즉,

- room assignment
- assistant name 변경
- prompt/CLAUDE.md 템플릿 관리

는 서로 다른 command로 분리한다.

### 결정 6. 네이밍은 “동작 정리 후” 바꾼다

현재 `RegisteredGroup`은 이미 room binding/runtime binding DTO에 더 가깝다. 하지만 첫 단계에서 타입 rename까지 섞으면 diff가 너무 커진다.

권장 순서:

1. 동작 cutover
2. legacy source 삭제
3. 그 다음 `RegisteredGroup` → `RoomBinding` rename

---

## 5. 목표 아키텍처

### 5.1 도메인 모델

#### Room

room의 room-level truth.

- chatJid
- name
- folder
- triggerPattern
- requiresTrigger
- isMain
- workDir
- roomMode
- ownerAgentType
- createdAt
- updatedAt

#### RoomRoleOverride

room별 role/runtime override.

- chatJid
- role
- agentType
- agentConfig
- createdAt
- updatedAt

#### RoomBinding

실행 시점 DTO. DB에 저장하지 않는다.

- room
- role
- effectiveAgentType
- effectiveServiceId
- effectiveChannelName
- effectiveAgentConfig
- workDir

### 5.2 레이어 구조

권장 구조:

```text
src/
  app/
    bootstrap.ts
    shutdown.ts
  domain/
    rooms/
      room-service.ts
      room-binding.ts
      room-migration.ts
    paired/
      paired-task-service.ts
      handoff-service.ts
    delivery/
      work-item-service.ts
  repositories/
    rooms-repository.ts
    room-role-overrides-repository.ts
    paired-tasks-repository.ts
    messages-repository.ts
    router-state-repository.ts
  runtime/
    message-loop/
      ingress.ts
      turn-coordinator.ts
      delivery-coordinator.ts
      recovery.ts
    agent-process/
      process-runner.ts
      output-parser.ts
      timeout-controller.ts
      run-logger.ts
  runners/
    shared/
      room-role-context.ts
      reviewer-policy.ts
```

핵심은 **composition root**, **domain service**, **repository**, **runtime coordinator**를 분리하는 것이다.

---

## 6. 단계별 실행 계획

## Phase 0. 리팩토링 가드레일 추가

### 해야 할 일

1. `db.ts` 신규 export 금지
2. 신규 코드에서 legacy key/table 사용 금지
3. startup 경로에 migration 로직 추가 금지
4. room assignment는 오직 하나의 application service만 통해서 수행

### 산출물

- ADR 또는 짧은 architecture note
- lint/grep 기반 CI guard 추가

### 통과 기준

- 새 PR이 `registered_groups`/legacy env alias를 새로 참조하지 않음

---

## Phase 1. schema cutover 준비

### 해야 할 일

1. `room_settings`에 canonical field 부족분 추가
   - 최소: `created_at`
2. `room_role_overrides` 신규 테이블 추가
3. explicit migration command 구현
   - 기존 `scripts/run-migrations.ts` 체계를 활용 가능
4. migration report 생성
   - migrated rows
   - skipped rows
   - conflict rows

### migration 규칙

1. `registered_groups`를 room 단위로 fold
2. room-level 필드 충돌 시 fail fast
   - name/folder/requires_trigger/is_main/work_dir conflict는 자동 복구 금지
3. owner/reviewer runtime row는 `room_role_overrides`로 이동
4. `registered_groups.json`도 같은 규칙으로 fold
5. 성공 시 legacy backup table/file로 보관
   - 예: `registered_groups_legacy_backup`
   - 예: `registered_groups.json.migrated`

### 통과 기준

- migration 명령이 idempotent
- conflict가 있으면 startup이 아니라 migration 단계에서 실패

---

## Phase 2. write path 단일화

### 해야 할 일

1. `assignRoom()`이 canonical table만 쓰도록 변경
2. `materializeRegisteredGroupsForRoom()` 제거
3. `setup/register.ts` 제거 또는 `setup/assign-room.ts`로 대체
4. assistant name 변경 로직을 별도 step으로 분리
5. setup/verify/environment 경로가 canonical table만 보게 수정

### 명시적 삭제 대상

- `setup/register.ts`의 direct SQL write
- `setup/register.ts`의 `.env` 수정
- `setup/register.ts`의 `CLAUDE.md` 수정
- verify output의 legacy field

### 통과 기준

- room 생성/수정 write path가 하나뿐임
- setup/verify도 그 write path를 공유함

---

## Phase 3. read path 단일화

### 해야 할 일

1. `getAllRegisteredGroups()` 제거 또는 `getAllRoomBindings()`로 대체
2. runtime에서 `room_settings` + `room_role_overrides`만 읽도록 수정
3. `syncLegacyRegisteredGroupsIntoStoredRooms()` 삭제
4. `getLegacyRegisteredGroupRows()` / `getLegacyRegisteredGroup()` 삭제
5. `buildRegisteredGroupFromStoredSettings()`는 남기더라도 source는 canonical table만 사용

### 권장 API

- `getRoom(chatJid)`
- `listRooms()`
- `buildRoomBinding(chatJid, role)`
- `listRoomBindings()`

### 통과 기준

- production code에서 `registered_groups` 참조 0
- production code에서 `registered_groups.json` 참조 0

---

## Phase 4. read-time repair 제거

### 해야 할 일

1. paired task / lease / handoff / work item row migration 수행
2. row creation 시 canonical service/agent metadata 강제
3. `legacy-rebuilds.ts` 삭제
4. `paired-state.ts` hydrate 시 fallback 추론 제거
5. read path는 incomplete row를 만나면 fail fast + operator action 요구

### 통과 기준

- `legacy-rebuilds.ts` 삭제
- `resolveStablePairedTaskOwnerAgentType()` 류의 fallback 제거
- canonical fields 없는 row가 조용히 복원되지 않음

---

## Phase 5. 구조 분해

### 해야 할 일

1. `src/index.ts`를 composition root로 축소
2. `src/message-runtime.ts` 분해
   - ingress
   - pending turn coordinator
   - delivery coordinator
   - recovery coordinator
3. `src/agent-runner.ts` 분해
   - env builder
   - process runner
   - output parser
   - timeout policy
   - run log persistence
4. `src/db.ts` façade 축소 또는 제거
5. `runners/shared` 추출

### 우선 분해 대상

1. `src/db.ts`
2. `src/message-runtime.ts`
3. `src/index.ts`
4. `src/agent-runner.ts`
5. `src/ipc.ts`
6. `src/group-queue.ts`

### 권장 가드레일

- 일반 production file 400 LOC 초과 금지
- 일반 function 80~100 LOC 초과 금지
- setup/command는 single responsibility 유지

> 위 숫자는 절대 규칙이라기보다, 지금처럼 God file로 재응집되는 것을 막기 위한 guardrail이다.

---

## Phase 6. config/state legacy alias 제거

### 삭제 대상

#### 환경변수 alias

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLAUDE_BOT_TOKEN`
- `DISCORD_CODEX_BOT_TOKEN`
- `DISCORD_CODEX_MAIN_BOT_TOKEN`
- `DISCORD_REVIEW_BOT_TOKEN`
- `DISCORD_CODEX_REVIEW_BOT_TOKEN`
- `SESSION_COMMAND_USER_IDS`

#### router state alias

- `last_timestamp`
- `last_agent_timestamp`

#### JSON migration source

- `router_state.json`
- `sessions.json`
- `registered_groups.json`

### 정책

- alias를 더는 읽지 않는다.
- deprecated key가 발견되면 warning이 아니라 startup error를 내고 canonical key명을 안내한다.

### 통과 기준

- production code에서 legacy alias string이 남아 있지 않음

---

## 7. 추천 PR 분할

### PR 1. Schema + explicit migration command

- `room_role_overrides` 추가
- migration report 작성
- legacy backup 전략 도입

### PR 2. Room assignment write-path cutover

- `assignRoom()` canonical-only
- setup/register 제거/대체
- verify/environment canonical-only

### PR 3. Runtime read-path cutover

- `registered_groups` 참조 제거
- `getAllRoomBindings()` 도입
- startup sync 제거

하위 컷 메모:

- 하위 컷 1. `registered_groups` 기반 owner/room-mode/snapshot 추론 제거
  - 대상: `src/service-routing.ts`, `src/db.ts`, `src/db/room-registration.ts`
  - 범위: stored canonical 값이 없을 때 `registered_groups` legacy row로 owner service, room mode, snapshot 의미를 추론하는 read-path fallback 제거
  - 동반 테스트: `src/service-routing.test.ts`, `src/db.test.ts`
- 하위 컷 2. 남은 `registeredGroups` runtime consumer 제거
  - 대상: `src/index.ts`, `src/message-runtime-loop.ts`, `src/ipc.ts`
  - 범위: `getAllRegisteredGroups()` read-path 소비자 제거, `getAllRoomBindings()` 도입, startup sync 제거
- 주의: 여기서 말하는 추론 제거는 PR 4 / Phase 4의 `paired-state.ts` hydrate fallback 제거와 별개다.

### PR 4. Paired task canonicalization

- paired/channel owner/handoff/work item backfill
- `legacy-rebuilds.ts` 삭제

### PR 5. Config/state alias 제거

- env alias 삭제
- router state alias 삭제
- startup JSON migration 삭제

### PR 6. 구조 분해

- `index.ts`, `message-runtime.ts`, `agent-runner.ts`, `db.ts` 분해
- `runners/shared` 추출

---

## 8. 테스트 전략 변경

### 기존 문제

현재 테스트는 legacy/backfill 호환 보호 비중이 크다.

### 바꿔야 할 방향

1. **runtime 테스트**는 canonical behavior만 검증
2. **migration 테스트**는 explicit migration command에만 집중
3. legacy 호환 테스트는 runtime suite에서 제거
4. startup은 migration을 하지 않는다는 계약을 테스트로 고정

### 반드시 추가할 테스트

1. canonical room assignment round-trip
2. migration conflict detection
3. incomplete canonical row fail-fast
4. setup/assign-room side-effect isolation
5. startup idempotence
6. paired task hydrate가 fallback 없이 동작함을 보장하는 테스트

---

## 9. 완료 기준(Definition of Done)

아래를 모두 만족해야 “레거시 제거 완료”로 본다.

### 데이터/설정

- `registered_groups`가 runtime source가 아님
- startup이 JSON/legacy row를 읽어 canonical row를 만들지 않음
- paired/task/handoff/lease row가 canonical metadata를 완전하게 저장함

### 코드

- `src/db/legacy-rebuilds.ts` 삭제
- `setup/register.ts` 삭제 또는 room assignment 전용 thin wrapper로 교체
- production code에서 legacy env alias 참조 0
- production code에서 legacy state key 참조 0
- production code에서 `registered_groups` 참조 0

### 구조

- `src/index.ts`는 bootstrap/composition root 역할만 수행
- `src/message-runtime.ts`는 coordinator 분해 완료
- `src/agent-runner.ts`는 process runner 전용 책임으로 축소
- `db.js` façade 직접 import를 강하게 축소하거나 제거

### 운영

- migration은 explicit command로만 수행
- deprecated key가 있으면 startup error로 조기 발견
- 문서와 코드가 같은 canonical path를 설명함

---

## 10. 바로 먼저 고쳐야 할 것들

전체 리팩토링 전에 가장 빨리 효과가 나는 순서:

1. `setup/register.ts`에서 `.env` / `CLAUDE.md` 수정 제거
2. startup의 `syncLegacyRegisteredGroupsIntoStoredRooms()` 제거 준비
3. explicit migration command 먼저 도입
4. verify/environment에서 `registered_groups.json`/`registered_groups` fallback 제거
5. `buildVerifySummary()`의 의미 어긋난 네이밍 정리
   - 현재 `codexConfigured`가 사실상 reviewer bot configured 의미
   - `reviewConfigured`가 arbiter bot configured 의미

이 5개만 먼저 해도 “버그가 곳곳에서 새는 느낌”이 크게 줄어든다.

---

## 11. 요약

이 저장소는 단순히 코드가 긴 게 문제가 아니다.

핵심 문제는 다음 세 가지다.

1. **같은 의미를 여러 저장소가 동시에 들고 있음**
2. **런타임이 과거 데이터를 읽으면서 현재 의미를 추론함**
3. **setup/runtime/migration 책임이 섞여 있음**

따라서 정리 순서는 반드시 아래여야 한다.

1. schema와 canonical model을 먼저 고정
2. explicit migration 제공
3. write path cutover
4. read path cutover
5. legacy 삭제
6. 그 다음에 큰 파일 분해와 rename

즉, 이번 작업의 핵심은 “클린코드 스타일 적용”이 아니라,

> **호환 경로 삭제 → 진실원 단일화 → 읽기 시 추론 제거 → 책임 분리**

이다.

---

## 12. 추천 자동 검증 명령

아래 검색은 cleanup branch에서 CI guard로 넣는 것을 권장한다.

```bash
# legacy table / json source
rg -n "registered_groups|registered_groups.json" src setup runners

# legacy migration-on-startup
rg -n "migrateJsonStateFromFiles|syncLegacyRegisteredGroupsIntoStoredRooms" src setup runners

# legacy env aliases
rg -n "DISCORD_BOT_TOKEN|DISCORD_CLAUDE_BOT_TOKEN|DISCORD_CODEX_BOT_TOKEN|DISCORD_CODEX_MAIN_BOT_TOKEN|DISCORD_REVIEW_BOT_TOKEN|DISCORD_CODEX_REVIEW_BOT_TOKEN|SESSION_COMMAND_USER_IDS" src setup runners

# legacy router state aliases
rg -n "last_timestamp|last_agent_timestamp" src setup runners

# read-time repair helpers
rg -n "legacy-rebuilds|resolveStablePairedTaskOwnerAgentType|resolveStableReviewerAgentType" src setup runners
```

최종 상태에서는 위 검색이 아래 중 하나여야 한다.

- 0건
- migration command / legacy backup doc / changelog 같은 명시적 예외 파일에만 존재
