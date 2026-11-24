# 0002. Model and tool calls run in supervised child actors, and the run only persists their results

- **Status:** Proposed
- **Date:** 2026-11-24
- **Milestone:** 1

## Context

Model calls get rate-limited and time out, and tools fail in their own ways. Retrying them needs backoff, attempt counts and timeouts. If the run did this itself, its persistent actor would hold the mailbox for every slow call and mix failure handling into its domain logic. Troupe already supervises actors, with restart and backoff strategies.

## Decision

The run never calls a model or a tool itself. For each piece of pending work, it spawns a child that does one call and stops. The parent supervises each child with `restartWithBackoff`. A child that hits a retryable failure first tells the parent, so the attempt is journaled, and then throws, so supervision restarts it after a delay. A failure that isn't retryable is reported without throwing, and the parent decides what it means. The run only persists results and failed attempts.

## Alternatives considered

| Option | Why not |
| --- | --- |
| The run calls the model with `pipeToSelf` and retries with its own timers | Fewer actors, but retry logic lives in the run's reducer, and the supervision tree, the thing that makes this an actor framework, goes unused. |
| The SDK's built-in retries | Invisible: attempts aren't journaled, so a crash resets them, the timeline can't show them, and they can't be tested on virtual time. The Anthropic adapter turns them off (`maxRetries: 0`). |
| One long-lived child per tool, handling many calls | Saves spawns, but a child's restart would lose its other calls, and per-call timeouts and idempotency keys get harder. |

## Evidence

Proposed. T2 and T5 prove it: a rate-limited model call is restarted with backoff on virtual time, each attempt is journaled, and a crash between attempts doesn't reset the count.

**T2 (2026-11-24):** `test/steps/tool-call.test.ts`:

- An idempotent tool's failure tells the parent `attemptFailed`, then throws. Supervision restarts the child with backoff on virtual time, and the next attempt's result reaches the parent.
- A failure that isn't retryable is reported without throwing, and the tool runs once.
- A timeout is the child's own timer: it aborts the tool's signal, and a late result from that attempt is ignored.

**T3 (2026-11-24):** `test/steps/model-call.test.ts` and `test/run/run.test.ts`:

- The model call is a child of its own, with the same shape as a tool call. A retryable `ModelError` is reported as `attemptFailed`, then thrown, and supervision calls again after a backoff. Anything else is reported as `modelFailed` without a restart.
- A step's three tool calls run in three children at the same time. Each tool is held until all three have started, which couldn't happen if they ran one after another.
- Messages for a step the run isn't on are ignored: late and early model answers, results for other steps, and calls the step didn't make.

## Consequences

- Milestone 2's sub-agents are another kind of child, supervised the same way.
- Tool calls of one step run at the same time, one child each.
- Children are named by step and call id, so a stale child can't be confused with a current one, and the run ignores messages for steps it has left.
- Each attempt costs a spawn. That's cheap in Troupe, and it's dwarfed by a model call.
