# 0003. An unfinished step is retried on recovery when it's safe to repeat, and reported to the model when it isn't

- **Status:** Proposed
- **Date:** 2026-11-24
- **Milestone:** 1

## Context

A crash can land after a tool call has started and before its result is journaled. On recovery, the run can't know whether the call happened. For a model call or a read, running it again is harmless. For a tool that pages someone, sends an email or charges a card, running it twice is a real bug.

## Decision

Model calls have no side effects, so an unfinished one is always made again. Tools declare `idempotent` (default false). An unfinished idempotent tool runs again, with an idempotency key that's the same on every attempt and in every incarnation: `<runId>:<step>:<callId>`. An unfinished tool that isn't idempotent doesn't run again. The run records it as an error result that says the tool was interrupted and may or may not have run, and the model decides what to do. So idempotent tools run at least once, and other tools at most once.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Always retry (at least once for everything) | The usual workflow-engine default, and simple, but it silently repeats side effects, which is exactly the failure that makes people distrust agents. |
| Never retry (at most once for everything) | Safe, but a crash during a read would bother the model with an error it shouldn't have to handle. |
| Journal a `toolStarted` event and ask the tool whether it ran | Only works for tools that can answer, and most can't. The idempotency key gives tools that can dedupe what they need, without an intention event (0001). |

## Evidence

Proposed. T4 proves it: an interrupted idempotent tool runs again with the same key, and an interrupted non-idempotent tool doesn't run again, while the model sees the interrupted error.

## Consequences

- Tool authors make one choice, `idempotent`, and get the right recovery for it.
- A non-idempotent tool that knows nothing happened can throw `RetryableToolError` to opt into a retry.
- The model has to be able to handle "may or may not have run". The example shows this with `page_oncall`.
- Milestone 2's approvals reuse the rule: a tool waiting for approval hasn't started, so it's always safe to ask again.
