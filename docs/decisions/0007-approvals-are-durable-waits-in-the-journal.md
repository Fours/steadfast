# 0007. Approvals are durable waits: the request and the decision are journaled, and the wait is derived from state

- **Status:** Proposed
- **Date:** 2026-11-25
- **Milestone:** 2

## Context

Some tool calls shouldn't run until a person says so, such as paging the on-call engineer. People take minutes or days to answer, and the process may restart any number of times while it waits. If the wait lived in memory, as a promise or a timer only, a restart would lose it. The run would then either ask the model again, which costs money and may give a different answer, or run the call without approval. Whether a call needs approval can also depend on its input, through code that may change between deploys.

## Decision

A tool, or a delegation, takes `needsApproval`: `true`, `false` (the default), or a function of the parsed input, and an optional `approvalTimeoutMs`. Both are checked when the tool is defined.

- **The answer is decided once, and journaled.** When the model answers, the model-call child parses the input of each call that may need approval and asks the tool's `needsApproval`, before it reports. A function that throws counts as `true`. An input that fails `parse` is an error result, and nobody is asked. The run then writes `modelResponded`, an `approvalRequested` for each call to ask about (with its run id, tool, input, `requestedAt` from the agent's clock, and timeout), and the error results, in one write. From then on, what a call waits on is read from the state, never from the tool's definition, so a run recovered with different code behaves as it did.
- **The wait is derived.** `RunState.approvals` holds the step's requests: waiting, approved or denied. `act` starts nothing for a waiting call. Calls in the same step that don't need approval start at once, and the step's results still go to the model as one turn.
- **A decision is a message, and an event.** `decide` carries the run id, the call id, `approved`, `by` and an optional `note`. The run journals `approvalDecided`. A denial's `toolFinished`, saying who denied it and why, is in the same write, so the tool never runs. An approved call is an ordinary tool call from then on. The first decision wins: any other replies `notWaiting` and changes nothing.
- **Decisions reach sub-runs.** A run forwards a `decide` for another run id to the live sub-run whose id it is, or starts with, so a caller only needs the root's ref. An id with no live run under it replies `unknownRun`.
- **Timeouts are timers, measured from `requestedAt`** on the agent's clock, as the deadline is from `startedAt`. Recovery re-arms each one for what's left of it, and fires at once one that passed while the run was down. A timeout journals `approvalDecided` with `timedOut: true` and `by: 'timeout'`, and an error result.
- **An inbox is a projection.** Both events are tagged `steadfast.approval`, so an app can list every pending approval across every run and tree with one Troupe projection, with no polling. `approvalRequested` carries its run id, since the stream id can't be split back into agent and run id when agent names contain `-`.
- `status` lists the run's own waiting calls and its live sub-runs.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A tool whose `run` awaits the decision | The wait is a promise. A restart loses it, and a tool that isn't idempotent is then reported as "may have run" (decision 0003) though it never did. |
| Asking `needsApproval` again on recovery | Code changes between deploys would change past runs: a call asked about could start without a decision, or one that started could be held. |
| Checking approval in the run actor, before persisting | `parse` may be async, and a command can't await. Piping the check through the run's mailbox opens a window between the response and its write in which other messages see a half-answered step. The child already holds the response, and the run never runs user code (decision 0002). |
| Journaling the request in a write after the response | A crash between the two writes would leave a call with no request, which recovery would start or report as interrupted. |
| A decision as a direct call into the run, or shared state | It wouldn't survive a restart, and wouldn't cross nodes in milestone 5. A message with a reply does both. |

## Evidence

`test/run/approvals.test.ts`, from T4:

- A step that pages and queries metrics journals `modelResponded` and `approvalRequested` in one write. The query runs, the page waits, and `status` lists the request. Approving it runs the page, and both results go back as one turn, in call order. `readRun` shows the request and the decision on the call.
- A denial journals `approvalDecided` and the error result `A person denied this call. kyle: Not a sev1.` in one write, and the tool never runs.
- Shutting the system down while the call waits, and spawning the run again in a new kit 60 s later, makes no model call and no tool call. `status` shows the same request, and a decision sent to the new incarnation runs the call.
- A 30 s timeout on a run that was down for 5 s after 10 s fires 15 s into the second process, not 30 s, at `decidedAt` 30,000 on the agent's clock. One that passed while the run was down fires at once. A decision after it replies `notWaiting`.
- A second decision, and one for a call that was never asked about, reply `notWaiting`, and the journal doesn't change.
- A `needsApproval` function is called once per call, and a run recovered with the opposite function never calls it, and waits on the same call. One that throws counts as `true`, and an input that fails `parse` is an error result in the response's write, about which nobody is asked.
- A decision sent to the root for a sub-run's call reaches it. `…/9.9`, `…/1.00` and an unrelated id reply `unknownRun`, as does a decision for a sub-run whose delegation is itself waiting for approval. Until that delegation is approved, no sub-run starts.
- A projection on `steadfast.approval` sees both runs' requests and decisions.

Each of these makes a test fail: letting `act` start a waiting call, measuring a timeout from now rather than `requestedAt`, not re-arming timers on recovery, not forwarding to sub-runs, taking a decision for a call that's already decided, treating a function that throws as `false`, writing the requests after the response rather than with it, and leaving the tag off.

Still to prove, in T5 and T8: a cancelled run's pending approvals reply `notWaiting`, and the example's `--crash-while-waiting` ends as an uninterrupted run does. This record becomes Accepted then.

## Consequences

- A run can wait on people for as long as its deadline allows, through any number of restarts, at the cost of nothing but its journal. The deadline still runs while it waits (open question 2).
- Decisions aren't authorised here: `by` is recorded, not checked. That belongs to the app that sends `decide` (open question 5).
- `decide` has to name the run the call is in. Callers get it from the request, in `status` or from the inbox projection.
- A call approved just before a crash, whose tool hadn't started, is reported as interrupted on recovery if it isn't idempotent, as any started call is (decision 0003).
- The model-call child now runs `parse` and `needsApproval` for calls that may need approval. A slow `parse` delays the step's write.
