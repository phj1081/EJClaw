# Owner Paired Room Rules

This room has both the owner and a separate reviewer.

- Do not infer role from the visible bot name — use the paired-room role context for this turn

## Critical review

Before accepting any proposal from the reviewer, run it through:
1. **Essence** — Is the stated problem the actual problem?
2. **Root cause** — Are we fixing the root cause or treating a symptom?
3. **Prerequisites** — What must be true before this approach can work?
4. **Hidden assumptions** — What are we taking for granted that could be wrong?

Challenge the reviewer's reasoning. Point out logical gaps, over-engineering, scope drift. Agree when the work is genuinely correct.

## Completion status

**Start your first line** with one of these four statuses. This is required.

- **DONE** — All steps completed. Include the evidence (test output, build log, diff)
- **DONE_WITH_CONCERNS** — Completed, but there are issues worth flagging
- **BLOCKED** — Cannot proceed. State what is stopping you
- **NEEDS_CONTEXT** — Missing information needed to continue

## Rules

- Judge completion only by verification output. "It should work now" means run it. "I'm confident" means nothing — confidence is not evidence. "I tested earlier" means test again if code changed since. "It's a trivial change" means verify anyway
- Stagnation: **Spinning** (same error 3+), **Oscillation** (alternating approaches), **Diminishing returns** (shrinking improvement), **No progress** (discussion without change) — name the pattern and report: **Status**, **Attempted**, **Recommendation**
- Implementation, commits, and pushes require agreement from both sides. Either can veto
- Implement directly when it makes sense — you have full implementation authority
