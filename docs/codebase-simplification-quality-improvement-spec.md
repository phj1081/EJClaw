# EJClaw Codebase Simplification & Quality Improvement Spec

**Status:** Proposed
**Audience:** Maintainers / developers implementing cleanup work
**Language:** English
**Review basis:** Static repository review on 2026-04-10. This review did **not** execute Bun builds or tests in the analysis environment, so all behavior changes must be validated after the quality gate is fixed.

## 1. Objective

Raise codebase quality by **removing unnecessary complexity**, not by adding new architecture.

The target end state is:

- one trustworthy quality gate,
- one source of truth per concept,
- less legacy compatibility surface,
- fewer hidden global states,
- smaller lifecycle-oriented modules in the few places where complexity is truly concentrated,
- no speculative abstractions.

This spec is intentionally biased toward **simple implementation**. It is not a request for a rewrite.

## 2. Guiding Rules

1. **Prefer deletion over abstraction.** If a new abstraction does not remove real duplication or real branching, do not add it.
2. **Prefer one real shared module over “keep in sync” comments.** Manual SSOT is not SSOT.
3. **Prefer plain TypeScript modules and small factories over frameworks.** No DI container, no service locator, no “clean architecture” ceremony.
4. **Keep the existing single-service + file-IPC shape unless a change clearly reduces complexity.** Do not introduce Redis, sockets, queues, or microservices as part of this cleanup.
5. **Refactor only the hotspots.** Do not split stable small modules just to reduce file count.
6. **Quality gate first.** Until CI reflects reality, all other cleanup work is lower-confidence.
7. **Do not re-open runtime compatibility paths that were already intentionally removed.** Finish deletion instead.

## 3. Executive Summary

The codebase is not primarily suffering from “too little architecture.” It is suffering from:

- a **non-trustworthy quality gate**,
- a handful of **stateful orchestration hotspots** that grew too large,
- **manual protocol duplication** between host and runners,
- **unfinished legacy compatibility cleanup** in setup/tooling/test paths,
- **hidden mutable module state**,
- and a **giant schema/migration surface** that is too hard to reason about safely.

There are also several signs that the code is already moving in the right direction and should **not** be churned unnecessarily:

- `src/message-runtime-*` is already split by responsibility.
- `src/provider-retry.ts` is a good example of extracting real duplication.
- `src/paired-task-status.ts` is already acting as a central status-transition guard.
- `setup/register.ts` is already much simpler than older compatibility assumptions would suggest.

So the right move is **targeted simplification**, not broad reorganization.

## 4. Current Findings

### 4.1 The quality gate is currently unreliable

The repository declares Bun as the package manager:

- root `package.json`: `"packageManager": "bun@1.3.11"`
- runner packages also declare Bun
- repository contains `bun.lock`

But important automation still uses npm:

- `.github/workflows/ci.yml` uses `npm ci`, `npm run format:check`, and `npx ...`
- `.husky/pre-commit` runs `npm run format:fix`

This means the repo’s actual development/runtime toolchain and its merge gate are not aligned.

### 4.2 Format/type/build coverage is incomplete

Current root scripts only format `src/**/*.ts`.

That means formatting does **not** cover, at minimum:

- `setup/**/*.ts`
- `runners/**/*.ts`
- `test/**/*.ts`
- `scripts/**/*.ts`
- `vitest*.ts`

Current root `tsconfig.json` only includes `src/**/*`, so root typecheck does **not** cover:

- `setup/**/*`
- `runners/**/*`
- top-level scripts/config files outside `src`

CI also does not build the runners as part of the default merge gate.

### 4.3 Complexity is concentrated in a small number of files

Approximate non-test LOC hotspots:

| File | Approx. LOC | Problem shape | Required response |
| --- | ---: | --- | --- |
| `src/db/schema.ts` | 3156 | Giant imperative migration surface | Break into versioned migrations |
| `runners/agent-runner/src/index.ts` | 1170 | Multiple unrelated responsibilities in one entry file | Split by lifecycle boundary |
| `src/group-queue.ts` | 1060 | Stateful queue/process orchestration hotspot | Split state model vs scheduler vs process lifecycle |
| `src/message-agent-executor.ts` | 1031 | Target resolution, execution, retry/failover, delivery are mixed | Split into focused executor pieces |
| `src/db.ts` | 970 | God facade / singleton entry to many DB domains | Freeze growth and narrow usage |
| `src/ipc.ts` | 854 | File claiming, routing, watcher loop, task IPC all mixed | Split IPC concerns without changing architecture |
| `src/db/paired-state.ts` | 853 | Large paired-task data surface | Keep domain-specific, but stop routing everything through `db.ts` |
| `src/channels/discord.ts` | 853 | Channel implementation likely doing too much in one place | Reduce hot-path sync work and isolate channel concerns |
| `src/paired-workspace-manager.ts` | 850 | Workspace lifecycle complexity | Keep, but isolate expensive filesystem work |
| `src/unified-dashboard.ts` | 761 | Large UI/render orchestration | Lower priority; simplify only after core runtime |
| `src/message-turn-controller.ts` | 747 | Turn orchestration complexity | Lower priority than protocol/IPC/executor |
| `runners/agent-runner/src/ipc-mcp-stdio.ts` | 696 | Mixed protocol/runtime concerns | Simplify after shared protocol extraction |
| `src/agent-runner-environment.ts` | 674 | Environment/bootstrap logic with heavy sync IO | Keep bootstrap-oriented, but isolate and simplify |
| `src/task-scheduler.ts` | 612 | Scheduling loop + execution + state in one module | Extract scheduler runtime state + execution unit |
| `src/message-runtime.ts` | 588 | Orchestration wrapper, but already partially split | Touch only if still needed after other changes |
| `setup/legacy-room-registrations.ts` | 545 | Legacy compatibility logic still alive | Keep temporary or delete after migration completion |

Important nuance: the answer is **not** “split everything.” The answer is to split only the files where multiple lifecycles or domains are still mixed together.

### 4.4 Host ↔ runner protocol is duplicated manually

`src/agent-protocol.ts` is explicitly documented as the SSOT for host ↔ runner constants, but runners keep local copies and comments such as “keep in sync”.

Examples duplicated in runner entry files:

- output markers
- image tag regex
- IPC poll interval
- structured output normalization logic

This is exactly the kind of complexity that should be removed, not documented.

### 4.5 Legacy runtime cleanup is already mostly done — finish it, do not reverse it

The runtime now explicitly rejects unexpected legacy room-binding state during database initialization, e.g. in `src/db/database-lifecycle.ts`.

That is the correct direction.

However, a significant compatibility surface still exists in setup/migration/test code, especially around:

- `setup/legacy-room-registrations.ts`
- `setup/migrate-room-registrations.ts`
- `setup/room-registration-state.ts`
- `setup/environment.ts`
- several setup tests that still focus on legacy scenarios
- broad runtime carrier types like `RegisteredGroup` that still mix room-binding data with wider runtime usage

The cleanup goal should be:

- keep runtime strict,
- provide an explicit migration/backfill path,
- then delete the remaining compatibility layer.

### 4.6 Hidden mutable module state is still common

Examples:

- `src/service-routing.ts` keeps lease cache and global failover state in module globals.
- `src/task-scheduler.ts` keeps scheduler state in module globals.
- `src/ipc.ts` keeps watcher state in module globals.
- token rotation modules also keep module-level mutable state.

This is not a reason to add a framework. It is a reason to wrap state in **small factory-created runtime objects**.

### 4.7 Config/env access is not fully centralized

There are still many direct `process.env` reads outside a clear config boundary (at least dozens in production code, with the heaviest concentration in runner entrypoints and environment/bootstrap files).

That makes behavior harder to audit, test, and reason about.

### 4.8 The database/migration story is too large for safe iteration

`src/db/base-schema.ts` and especially `src/db/schema.ts` represent a very large schema/migration surface.

The current style makes it too easy to:

- add one more conditional migration branch,
- accidentally couple unrelated schema changes,
- and make future reviews expensive.

This is a good candidate for simplification through **versioned migrations**, not through an ORM rewrite.

### 4.9 Some runtime registration is still “magic”

`src/channels/index.ts` uses side-effect imports for channel registration.

This is not a catastrophic issue, but it is unnecessary indirection for a codebase that is trying to become simpler.

### 4.10 Test volume is high, but test focus is mixed

Approximate TypeScript volume:

- production TS: ~40.8k LOC
- test TS: ~38.1k LOC

The problem is not “too many tests.” The problem is that some tests still spend significant surface area preserving behavior that should be deleted.

## 5. Mandatory Workstreams

### 5.1 Workstream A — Fix the quality gate first

### Required changes

1. Replace npm-based CI/hook paths with Bun-based ones.
2. Add **one** canonical root command for merge validation.
3. Expand format/type/build coverage to all real code paths.
4. Ensure runners are part of the gate.

### Minimum script shape

The exact script names can vary, but the repository should end with something equivalent to:

```json
{
  "scripts": {
    "format:check": "prettier --check \"{src,setup,runners,shared,test,scripts}/**/*.{ts,js}\" \"vitest*.ts\"",
    "format:fix": "prettier --write \"{src,setup,runners,shared,test,scripts}/**/*.{ts,js}\" \"vitest*.ts\"",
    "typecheck:all": "bunx tsc --noEmit -p tsconfig.check.json && bunx tsc --noEmit -p runners/shared/tsconfig.json && bunx tsc --noEmit -p runners/agent-runner/tsconfig.json && bunx tsc --noEmit -p runners/codex-runner/tsconfig.json",
    "build:all": "bun run build && bun run --cwd runners/shared build && bun run build:runners",
    "check": "bun run format:check && bun run typecheck:all && bun run test && bun run build:all"
  }
}
```

If the root build `tsconfig.json` currently assumes `rootDir=src` / `outDir=dist`, prefer a separate `tsconfig.check.json` for broad no-emit validation rather than widening the build config itself.

### CI requirement

CI should reduce to one truthful flow:

1. install with Bun,
2. run `bun run check`.

Do **not** keep parallel npm and Bun paths unless there is a documented hard requirement.

### Pre-commit requirement

`.husky/pre-commit` must use Bun, not npm.

### Acceptance criteria

- A fresh checkout passes locally and in CI with the same top-level command.
- Setup code, runners, and tests are covered by formatting and typecheck.
- Runner builds are part of the merge gate.
- There is no npm-vs-Bun ambiguity in routine contributor workflow.
- After this lands, every follow-up cleanup PR must pass the same canonical `bun run check` gate before merge.

### 5.2 Workstream B — Finish deleting remaining legacy compatibility

### Required changes

1. Treat the runtime’s current strictness as intentional and correct.
2. Keep migration helpers only as **explicit migration tooling**, not as long-term compatibility logic.
3. Narrow broad runtime carrier types after migration completion so room-binding-specific fields stop leaking across unrelated runtime paths.
4. Move any remaining legacy behavior coverage into a narrowly-scoped migration suite.

### Files in scope

Primary:

- `setup/legacy-room-registrations.ts`
- `setup/migrate-room-registrations.ts`
- `setup/room-registration-state.ts`
- `setup/environment.ts`
- `setup/verify.ts`
- legacy-heavy setup tests

Secondary:

- `src/types.ts` (`RegisteredGroup` usage and shape leakage)
- any code path still branching on legacy room-registration semantics

### Important rule

Do **not** reintroduce runtime fallback behavior for legacy room registrations. The runtime should remain strict. Migration should happen before startup, not silently during runtime.

### Acceptance criteria

- No runtime code path depends on legacy room-registration tables/files.
- Legacy-only fields are removed, and room-binding-specific fields no longer need to travel through umbrella runtime types where they are unrelated.
- Legacy behavior is covered only in dedicated migration tests/tools, not general runtime logic.
- Setup verification reports current-state issues clearly without acting as a permanent compatibility layer.

### 5.3 Workstream C — Unify the host ↔ runner protocol and reviewer runtime policy

### Required changes

1. Extend the existing `runners/shared` package as the default shared boundary for host ↔ runner protocol constants/types/helpers unless a narrower shared module is clearly simpler.
2. Delete manual copies in runner entrypoints.
3. Centralize reviewer runtime capability differences.
4. Make capability gaps explicit in code, not hidden in comments.

### Protocol items that must be shared for real

At minimum:

- output start/end markers,
- image tag regex,
- IPC polling constants,
- input/output envelope types,
- structured output normalization/parsing helpers.

### Reviewer runtime policy

Current reviewer policy is split awkwardly across runner-specific files. Codex limitations are documented in comments rather than represented as explicit capability rules.

Replace that with a small capability model, e.g.:

- supports shell preflight hook,
- supports readonly sandboxing,
- supports git-write guard only,
- supports hard mutation blocking.

This must remain simple. A plain exported object or discriminated union is enough.

The capability model should live with the shared runner boundary by default. If host code needs awareness of those differences, expose a thin serialized capability surface instead of making `src/` depend deeply on runner-only internals.

### Files in scope

- `src/agent-protocol.ts`
- `runners/agent-runner/src/index.ts`
- `runners/codex-runner/src/index.ts`
- `runners/agent-runner/src/reviewer-runtime.ts`
- `runners/codex-runner/src/reviewer-runtime.ts`
- existing shared runner package (`runners/shared/...`)

### Acceptance criteria

- No protocol constant is duplicated manually between host and runners.
- No “keep in sync” comments remain for protocol items.
- Reviewer capability differences are represented in one place.
- Both runners consume the same protocol/policy definitions where applicable.

### 5.4 Workstream D — Finish config/env centralization and remove hidden mutable state

### Required changes

1. Restrict direct `process.env` access to explicit config/bootstrap boundaries.
2. Create small `loadXConfig()` / `createXRuntime()` entrypoints where needed.
3. Replace module-global runtime state with plain-object state holders.

### Scope rules

Allowed places for direct env access:

- config loaders,
- bootstrap files,
- true process entrypoints,
- runner startup config loaders.

Not allowed in normal domain logic.

### State wrapping targets

High priority:

- `src/service-routing.ts`
- `src/task-scheduler.ts`
- `src/ipc.ts`

Medium priority:

- token rotation modules,
- other modules with nontrivial mutable singleton state.

### Implementation rule

Use **small factory functions**, not a DI framework.

Good:

```ts
const serviceRouting = createServiceRoutingRuntime(...)
```

Bad:

- container registration frameworks,
- deep dependency graphs introduced only for “purity”,
- passing giant service bags everywhere.

### Acceptance criteria

- Direct `process.env` reads outside config/bootstrap/entrypoint code are either removed or explicitly justified.
- Stateful modules can be initialized/reset without relying on hidden module-global mutation.
- Test setup becomes simpler because state can be created explicitly.

### 5.5 Workstream E — Split only the highest-risk orchestration hotspots

This is the most important “simplify without overengineering” section.

#### 5.5.1 `src/message-agent-executor.ts`

Current file mixes:

- execution target resolution,
- paired-context preparation,
- runner execution,
- retry/session recovery,
- failover behavior,
- delivery/handoff side effects.

#### Required split

Keep one coordinator file, but extract:

- **target/context resolution**,
- **attempt execution**,
- **failure classification + retry/session recovery**,
- **delivery/handoff side effects**.

Do not invent a new class hierarchy.

#### 5.5.2 `src/group-queue.ts`

Current file mixes:

- state model,
- run-phase transitions,
- concurrency scheduling,
- process close/termination behavior,
- retry timing.

#### Required split

Extract into small plain modules:

- group state / transitions,
- waiting/drain scheduler,
- process shutdown handling,
- IPC follow-up helpers if still needed.

Keep `GroupQueue` as the public coordinator if that remains simplest.

#### 5.5.3 `src/ipc.ts`

Current file mixes:

- file claiming/quarantine,
- inbound message forwarding,
- task IPC processing,
- watcher loop lifecycle.

#### Required split

Keep file-based IPC, but isolate:

- file claim/quarantine utilities,
- message forwarding/authorization,
- task command handling,
- watcher runtime.

Do **not** replace this with a new platform.

#### 5.5.4 `runners/agent-runner/src/index.ts`

Current file mixes:

- stdin parsing,
- output protocol writing,
- transcript parsing/markdown generation,
- compact memory logic,
- IPC polling/draining,
- main runner lifecycle.

#### Required split

Extract by lifecycle:

- input/output protocol,
- transcript/memory helpers,
- IPC polling/drain,
- runner main.

#### 5.5.5 `src/db.ts`

This file is too large and too central.

#### Required response

- Stop adding new behavior to `src/db.ts`.
- Treat it as a temporary compatibility facade.
- New code should import from domain modules under `src/db/*` directly where practical.
- Over time, shrink `db.ts` instead of growing it.

#### 5.5.6 `src/index.ts`

The entrypoint should become a clearer composition root.

#### Required changes

- Replace side-effect channel registration with explicit startup registration.
- Keep startup wiring visible in one place.
- Avoid pushing more domain logic into the entrypoint.

### Important non-targets

- `setup/register.ts` is already reasonably simple. Do not churn it.
- `src/message-runtime.ts` is already partially decomposed into `message-runtime-*` files. Only trim it further if complexity still leaks after other workstreams land.

### Acceptance criteria

- Hotspot files are reduced because responsibilities were actually separated, not because helper wrappers were added around the same logic.
- No new framework-style abstraction layer is introduced.
- Public entrypoints remain obvious and easy to trace.

### 5.6 Workstream F — Simplify persistence and migrations

### Required changes

1. Keep `applyBaseSchema()` only for fresh database creation.
2. Freeze `src/db/schema.ts` for new schema work except emergency fixes.
3. Route new schema changes into ordered versioned migrations first, then backfill older conditional branches incrementally.
4. Make each migration small, isolated, and testable.
5. Reduce reliance on broad compatibility-shaped types at runtime.

### Suggested shape

- `src/db/migrations/001_*.ts`
- `src/db/migrations/002_*.ts`
- etc.

The implementation can be plain TypeScript or SQL files. No ORM is required.

### Type boundary cleanup

`RegisteredGroup` is still carrying room-binding data across too many unrelated paths.

Fields such as `requiresTrigger` may still be canonical room-binding data; the goal is not to delete valid semantics, but to stop leaking them through one umbrella type everywhere.

Introduce narrower runtime boundary types where needed, such as:

- `RoomBinding`
- `ExecutionLease`
- `TaskSnapshot`

This is not a request to rewrite all domain types. It is a request to stop overloading one broad type across unrelated paths.

### Status transition rule

All paired-task status writes should continue converging on `src/paired-task-status.ts`. Do not allow status mutation rules to scatter again.

### Acceptance criteria

- New schema changes are added as small versioned migrations.
- Fresh DB bootstrap and incremental migration are clearly separated.
- New runtime code does not need to import a giant umbrella `db.ts` unless there is a strong reason.
- Canonical runtime types are narrower, and room-binding-only semantics are no longer spread through unrelated runtime surfaces by default.

### 5.7 Workstream G — Reduce hot-path sync I/O without overengineering

There are many synchronous filesystem/process calls across production code, with especially high concentrations in:

- `src/agent-runner-environment.ts`
- `src/paired-workspace-manager.ts`
- `runners/agent-runner/src/index.ts`
- `src/workspace-package-manager.ts`
- `src/ipc.ts`
- `src/channels/discord.ts`
- `src/token-refresh.ts`

### Important rule

This does **not** mean “convert everything to async.”

Synchronous I/O is acceptable in:

- setup commands,
- one-shot bootstrap,
- CLI-style preparatory work,
- failure-path diagnostics.

It is more problematic in:

- repeated polling loops,
- repeated watcher ticks,
- per-message hot paths,
- runner input-drain loops.

### Required changes

1. Identify repeated sync scans/reads/writes in hot loops.
2. Move hot-path file operations to async equivalents when they execute on every poll/watch tick, per-message hot path, or runner drain iteration, unless there is an explicit documented reason not to.
3. Keep semantics and architecture simple.
4. Do not replace file IPC with a new platform.

Minimum decision rule:

- repeated sync `readdirSync` / `statSync` / `readFileSync` / `writeFileSync` / `renameSync` / process probes inside polling loops must be removed or explicitly justified,
- one-shot bootstrap/setup/failure-path sync calls may stay if they keep the code simpler.

### Initial priority targets

- `src/ipc.ts`
- `runners/agent-runner/src/index.ts`
- `src/channels/discord.ts`

### Acceptance criteria

- Repeated poll/watch loops no longer do avoidable synchronous filesystem work on every tick.
- Setup/bootstrap paths may remain sync where simpler.
- No new infra dependency is introduced just to avoid sync I/O.

### 5.8 Workstream H — Simplify tests around the current architecture

### Required changes

1. Keep strong coverage, but re-focus it on current behavior.
2. Move legacy-compat verification into dedicated migration suites.
3. Remove tests that only preserve behavior the codebase intends to delete.
4. Reduce fixture duplication with a few shared builders.

### Suggested test buckets

- canonical runtime behavior,
- migration / legacy import behavior,
- host ↔ runner protocol,
- reviewer capability policy,
- setup orchestration,
- database migration behavior.

### Acceptance criteria

- Tests document the current architecture, not historical debris.
- Deleting legacy compatibility also deletes corresponding legacy tests.
- Protocol/policy behavior is protected with focused tests so duplication does not return.

## 6. File-by-File Action Map

| Priority | File / Area | Action |
| --- | --- | --- |
| P0 | `.github/workflows/ci.yml` | Replace npm flow with Bun and one truthful `bun run check` path |
| P0 | `.husky/pre-commit` | Switch to Bun |
| P0 | `package.json` | Add `check`, broaden format/type/build coverage |
| P0 | `tsconfig.check.json` / new `typecheck:all` path | Ensure setup/runners/shared are typechecked without widening the build tsconfig |
| P1 | `src/agent-protocol.ts` + runners/shared + runners | Move to a real shared import boundary using the existing shared runner package |
| P1 | runner reviewer runtime files | Centralize reviewer capability policy |
| P1 | `setup/legacy-room-registrations.ts` and related setup files | Limit to explicit migration tooling, then delete as possible |
| P1 | `src/types.ts` | Narrow `RegisteredGroup` leakage and introduce more focused runtime boundary types |
| P1 | `src/message-agent-executor.ts` | Split by execution lifecycle |
| P1 | `src/group-queue.ts` | Split state/transitions from scheduling and shutdown |
| P1 | `src/ipc.ts` | Split watcher/claiming/forwarding/task IPC |
| P1 | `runners/agent-runner/src/index.ts` | Split IO protocol, transcript/memory, IPC poll, main |
| P2 | `src/db/schema.ts` | Freeze new growth and shift schema changes to versioned migrations |
| P2 | `src/db.ts` | Freeze growth; move new code to domain modules |
| P2 | `src/service-routing.ts` | Wrap global state in runtime object |
| P2 | `src/task-scheduler.ts` | Wrap scheduler state in runtime object |
| P2 | `src/index.ts` + `src/channels/index.ts` | Replace side-effect registration with explicit registration |
| P3 | `src/channels/discord.ts` | Trim hot-path sync IO and reduce mixed responsibilities |
| P3 | `src/unified-dashboard.ts` | Simplify only after runtime/core cleanup |
| P3 | `src/message-turn-controller.ts` | Revisit after protocol/executor cleanup |

## 7. Recommended Implementation Order

Do **not** attempt this as one giant PR.

### PR 1 — Trustworthy quality gate

- Bun-only CI/hook flow
- broaden formatting/typecheck/build coverage
- add one `check` command
- establish the gate that every later cleanup PR must continue to pass

### PR 2 — Real shared protocol + reviewer capability model

- remove manual protocol duplication
- extend `runners/shared` instead of creating a second shared boundary
- centralize reviewer capability logic there
- add focused protocol/policy tests

### PR 3 — Legacy cleanup completion

- narrow setup migration tooling
- remove legacy compatibility branches where migration is complete
- narrow `RegisteredGroup` leakage instead of deleting valid room-binding semantics blindly
- move remaining legacy tests into migration-only coverage

After PR 1, PR 2 and PR 3 can proceed in parallel if team bandwidth allows. They are logically related, but neither should depend on the other to start.

### PR 4 — Hotspot splits

- `message-agent-executor.ts`
- `group-queue.ts`
- `ipc.ts`
- `runners/agent-runner/src/index.ts`

### PR 5 — Persistence simplification

- freeze `src/db/schema.ts` growth
- route new work to versioned migrations first
- stop growing `db.ts`
- introduce narrower runtime DTOs where needed

### PR 6 — Follow-up cleanup

- service-routing/task-scheduler runtime state factories
- explicit channel registration
- lower-priority large-file cleanup

## 8. Definition of Done

This effort is done when all of the following are true:

1. CI, local checks, and pre-commit all use the same toolchain and the same expectations.
2. There is a single truthful validation command for contributors.
3. Host ↔ runner protocol is defined in one real shared module.
4. Reviewer runtime capability differences are encoded once, not in comments or duplicated conditionals.
5. Legacy room-registration compatibility is no longer part of normal runtime logic.
6. The worst orchestration hotspots are split by lifecycle, without introducing framework complexity.
7. Database migration changes are versioned and small.
8. Hidden mutable module state is reduced in the main runtime hotspots.
9. Hot-path sync I/O is reduced where it actually matters.
10. Tests primarily protect the current system, not deprecated behavior.

## 9. Explicit Non-Goals

The following are **not** part of this spec:

- rewriting the app into microservices,
- replacing file-based IPC with Redis/sockets/queues,
- introducing a DI container,
- introducing Nx/Turborepo or other heavy build orchestration just for cleanup,
- converting the persistence layer to an ORM,
- broad “clean architecture” layering,
- mass file splitting with no behavioral simplification,
- refactoring already-simple modules just to satisfy style preferences.

## 10. Final Direction

The implementation principle for this cleanup is simple:

> **Delete duplication. Delete compatibility branches. Isolate the few real hotspots. Keep the architecture understandable.**

A successful implementation should make the codebase feel **smaller**, not more “enterprisey”.

## 11. Companion Notes

There is already a detailed legacy-focused document in:

- `docs/legacy-compat-removal-spec.md`

That document can still be used as historical context, but implementation should follow the **current-state rules in this spec**, especially:

- do not reintroduce runtime compatibility,
- prefer deletion over accommodation,
- and keep the cleanup implementation as plain and direct as possible.
