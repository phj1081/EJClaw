# Spec: Preserve the Intended Turn Role Across Auth Failures, Fallbacks, and Service Handoffs

## Summary

The invalid token / 401 issue is the **trigger**, but it is **not** the workflow bug.

The workflow bug is that a logical paired turn can lose its original role (`reviewer` / `arbiter`) during fallback or recovery. A failed reviewer turn must remain a reviewer turn until it either:

1. completes with a reviewer verdict,
2. escalates to arbiter / human by an explicit reviewer outcome, or
3. is deliberately cancelled.

It must **not** become an owner execution merely because Claude auth failed, token rotation failed, a fallback handoff was created, or a retry path was entered.

## Confirmed problems in the current code

### 1) Service handoff polling ignores `target_service_id`

In `src/message-runtime-handoffs.ts`, pending handoffs are loaded with `getAllPendingServiceHandoffs()` and then claimed immediately.

That means **any runtime instance can claim any pending handoff**, even if the handoff was created for another service such as `codex-review`.

The database layer already has the correct filtered accessor:

- `getPendingServiceHandoffs(targetServiceId)` in `src/db/service-handoffs.ts`

but the runtime is not using it.

This is the clearest reason a reviewer fallback handoff can end up being executed by the wrong service process.

### 2) The origin run still performs generic paired recovery after delegating to a fallback handoff

In `src/message-agent-executor.ts`, `maybeHandoffToCodex(...)` creates a service handoff and returns success.

But the originating paired execution still reaches `asyncFinalize()` in `src/message-agent-executor-paired.ts`, where it can:

- call `completePairedExecutionContext(...)`,
- preserve the task in `review_ready`, and
- queue a generic paired follow-up after a failed reviewer / arbiter execution.

So one logical failure path can produce **two continuation mechanisms at once**:

1. the explicit service handoff, and
2. the normal paired follow-up scheduler.

That is not a clean model. The turn should continue through **one** mechanism only.

### 3) Role loss is catastrophic because owner preparation mutates reviewer states

In `src/paired-execution-context.ts`, the owner branch resets `review_ready` / `in_review` back to `active`.

So if a reviewer handoff is ever resolved as owner, the system does not merely use the wrong bot; it also mutates the paired task into the wrong workflow state.

This is why role resolution errors must fail closed, not silently fall back to owner.

### 4) Some queued paired runs still rely on inferred role instead of an explicit forced role

`src/message-runtime-flow.ts` and `src/message-runtime-queue.ts` still allow some queued turns to be executed based on inferred task status rather than always carrying an explicit role invariant.

That is acceptable in the happy path, but it is not robust under retries, stale revisions, or recovery after handoff / error conditions.

## Desired invariant

A logical paired turn must carry an explicit immutable role:

- owner turn stays owner,
- reviewer turn stays reviewer,
- arbiter turn stays arbiter.

Backend recovery may change:

- provider (`claude` -> `codex`),
- service runtime (`claude` -> `codex-review`),
- session,
- token,
- retry count,
- process,

but it must **not** change the logical turn role.

## Minimal clean fix

### A. Only the target service may claim a service handoff

Change `src/message-runtime-handoffs.ts` to use the filtered pending-handoff accessor for the current runtime service instead of the unfiltered accessor.

Implementation direction:

- replace `getAllPendingServiceHandoffs()` with `getPendingServiceHandoffs(SERVICE_SESSION_SCOPE)`
- do not let the owner runtime claim a reviewer-targeted handoff
- do not let the reviewer runtime claim an owner-targeted handoff

This is the smallest and most important correctness fix.

### B. A delegated fallback handoff must suppress normal paired recovery in the origin run

When `maybeHandoffToCodex(...)` successfully creates a service handoff, the originating paired run should enter a **delegated** state.

In that delegated state, the origin run should:

- stop heartbeat,
- release its lease if needed,
- skip `completePairedExecutionContext(...)`, and
- skip generic paired follow-up enqueue.

The delegated handoff is now the sole continuation path for that logical turn.

This avoids double continuation (`service_handoff` + `paired_follow_up`) for the same reviewer failure.

### C. Never silently default a claimed handoff to owner when role resolution fails

In `src/message-runtime-handoffs.ts`, if `resolveHandoffRoleOverride(...)` returns `undefined`, the handoff should be failed explicitly.

It should **not** continue with an implicit owner path.

Recommended behavior:

- `failServiceHandoff(handoff.id, 'Cannot resolve intended handoff role')`
- log the row fields (`target_role`, `intended_role`, `reason`, `target_service_id`)
- return without executing the turn

Failing closed is safer than silently mutating reviewer state into owner state.

### D. Always pass an explicit role for queued paired turns

Harden the queued turn path so the runtime always executes the exact intended role.

Implementation direction:

- in `src/message-runtime-queue.ts`, use `forcedRole = turnRole` for paired tasks, not only for the mismatch case
- in `src/message-runtime-flow.ts`, include explicit owner / reviewer / arbiter role on pending turns and pass it into `executeTurn(...)`

This removes unnecessary dependence on mutable task status during recovery.

## Recommended deeper refactor

The real long-term fix is to make the **logical turn** a first-class database entity.

Right now the system derives turn intent from a combination of:

- task status,
- last persisted turn output role,
- pending reservation rows,
- service handoff rows,
- execution leases.

That is workable in the happy path, but it is too indirect for failure recovery.

### Introduce a persistent turn-attempt model

Create a table (or extend the existing paired reservation / lease model) that stores:

- `turn_id`
- `task_id`
- `task_updated_at`
- `role`
- `intent_kind`
- `state` (`queued`, `running`, `delegated`, `completed`, `failed`, `cancelled`)
- `executor_service_id`
- `executor_agent_type`
- `attempt_no`
- `created_at`, `updated_at`
- optional `parent_turn_id` or `handoff_from_attempt_id`

Then enforce these rules:

1. The scheduler creates a turn record once.
2. Recovery / fallback never creates a new logical turn role.
3. Fallback only updates the executor fields or creates a new attempt of the same turn.
4. The next workflow step is created only when the current turn reaches a terminal state.

With this design:

- `reviewer` remains reviewer even if execution moves from Claude to Codex
- token rotation is just another attempt of the same reviewer turn
- handoff cannot accidentally become owner because role is stored on the turn itself

### Service handoffs should reference the logical turn

A service handoff row should carry enough identity to prove what it belongs to, at minimum:

- `paired_task_id`
- `task_updated_at`
- `role`
- `intent_kind`
- ideally `turn_id`

Without that linkage, a handoff is just “some prompt for this chat”, which is too weak for strong recovery semantics.

## File-by-file guidance

### `src/message-runtime-handoffs.ts`

Required:

- claim only `getPendingServiceHandoffs(SERVICE_SESSION_SCOPE)`
- fail closed if role cannot be resolved
- add structured logging for `target_service_id`, `target_role`, `intended_role`, and the resolved role

### `src/message-agent-executor.ts`

Required:

- when a fallback handoff is created, mark the current paired run as delegated
- do not let the origin run also go through normal failed-reviewer recovery

### `src/message-agent-executor-paired.ts`

Required:

- add a delegated completion path that releases / stops the current run without mutating the paired task state
- skip executor-side follow-up enqueue for delegated runs

### `src/message-runtime-queue.ts`

Required:

- always pass `forcedRole` for paired turns

### `src/message-runtime-flow.ts`

Required:

- carry explicit role in `PendingPairedTurn`
- pass that role into `executeTurn(...)`

### `src/paired-execution-context.ts`

No semantic change is required here for the minimal patch, but this file explains why misrouting is severe:

- owner preparation resets `review_ready` / `in_review` back to `active`

That behavior is valid only when the turn is truly owner.

## Acceptance criteria

1. A reviewer turn that fails with Claude auth / token errors and falls back to Codex must still be executed as a reviewer turn.
2. The owner runtime must not claim reviewer-targeted service handoffs.
3. Creating a fallback handoff must not also enqueue generic paired reviewer recovery from the same origin run.
4. If the fallback handoff later fails, the requeued turn must still be reviewer, not owner.
5. No path may silently default an unresolved claimed handoff to owner.
6. Reviewer / arbiter recovery must preserve the intended role even when credentials are broken.

## Regression tests to add

### 1) Reviewer handoff is only claimed by the target service

Add a test proving that a `target_service_id = codex-review` handoff is invisible to a `codex-main` runtime poller.

### 2) Reviewer fallback does not also enqueue generic paired recovery from the origin run

Simulate:

- reviewer Claude auth failure
- service handoff creation

Expect:

- no executor-side paired follow-up is enqueued from the origin run
- only the service handoff remains as the continuation path

### 3) Claimed reviewer handoff executes with reviewer role invariant

Simulate a claimed reviewer handoff and assert that:

- `forcedRole === reviewer`
- the resolved logical turn role remains reviewer
- owner preparation is not entered

### 4) Unresolvable handoff role fails closed

Simulate a malformed handoff row with:

- no `target_role`
- no `intended_role`
- no reason prefix

Expect the handoff to fail, not to run as owner.

### 5) Failed reviewer fallback requeues reviewer again, not owner

Simulate:

- reviewer handoff execution fails
- task remains `review_ready`

Expect the next queued logical turn to remain reviewer.

## Bottom line

Yes — this is a workflow bug.

A token outage should cause:

- retry,
- rotation,
- handoff,
- or same-role requeue,

but it should **never** change the logical turn from reviewer to owner unless a real reviewer result explicitly changed the task state.

The smallest clean patch is:

1. filter handoff claiming by `target_service_id`,
2. treat fallback handoff as delegated continuation (not as a normal failed turn),
3. fail closed when handoff role cannot be resolved, and
4. always pass explicit `forcedRole` for queued paired turns.

The real architectural fix is to store the logical turn explicitly and treat fallback / retry as attempts of that same turn instead of inferring intent from task status during recovery.
