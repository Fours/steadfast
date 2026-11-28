# 0008. Cancellation is journaled in every run of the tree, and a finished run closes its unfinished sub-runs on recovery

- **Status:** Accepted
- **Date:** 2026-11-25
- **Milestone:** 2

## Context

In milestone 1, a run that finished, whether it was cancelled, ran out of budget, or hit its deadline, stopped its children. That's right for model and tool calls: their results are journaled by the run, and stopping one aborts its signal. A sub-run is different (decision 0006). It has a journal of its own, and stopping it leaves that journal unfinished forever, because nothing will ever resume it. A crash can also land between a parent's `runFinished` and a sub-run's, and the sub-run must still end. Stopping a sub-run too soon also stops the sub-runs under it before they can journal their own end.

## Decision

Every run in a tree journals its own end, and a finished run doesn't report until every run under it has closed.

- **Finishing cascades by message.** A run that finishes for any reason stops its model and tool calls as before. It tells each live sub-run `cancel`, with the reason `The parent run finished: <outcome>`, and watches it. Each sub-run journals `runFinished` with `cancelled`, closes its own sub-runs the same way, and then reports. The parent stops each sub-run once it has reported, and journals nothing more.
- **A finished run reports once its tree has closed.** It reports when the last sub-run it watches has terminated, so a report means every run under it has journaled its end. A sub-run that can't close within `CLOSE_TIMEOUT_MS` (30 s), for example because its journal is down, is stopped, and the run reports anyway. The keyed timer for that limit stays active until the run reports, so the run never reports twice.
- **The state remembers what was unfinished.** Folding `runFinished` keeps the step's pending call ids as `unfinished`. No event changes, so old journals fold as before.
- **A finished run closes its unfinished sub-runs whenever it's spawned.** On recovery, each unfinished delegation's sub-run is spawned again in closing mode, with the reason it's cancelled for. A delegation still waiting for approval had no sub-run, so it's skipped. A sub-run in closing mode starts nothing when it recovers. It sends itself `cancel` instead, so no model or tool call is made again only to be aborted. One that had already finished reports at once. One that had never started journals its start and its cancellation in one write, like any run cancelled before it starts.
- **`cancel` can target a sub-run.** With a `runId` other than its own, a run forwards `cancel` to the sub-run that id is in, or starts with, as it does with `decide`. Cancelling a sub-run alone finishes it with `cancelled`, and its parent's model sees `The sub-agent stopped: cancelled. Cancelled: <reason>` as the delegation's result, and carries on.
- **Cancelling ends pending approvals with the run.** A decision for one of the run's own calls replies `notWaiting`. A decision for a sub-run that has closed replies `unknownRun`, since no live run in the tree has its id.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Stopping sub-runs, as milestone 1 stops every child | A sub-run's journal is left without an end, and nothing ever resumes it. |
| Reporting as soon as the run's own `runFinished` is written | The caller, or the parent, would stop the run while its sub-runs are still cancelling, which stops them before they write. |
| Telling a recovered sub-run `cancel` after an ordinary spawn | A sub-run that recovers as `running` starts its calls in `onSignal`, before it reads `cancel`, so a model request or a tool call would be made only to be aborted. |
| Journaling the parent's intent, as an event such as `subRunCancelled` | The sub-run's own `runFinished` is the fact. The parent's `unfinished` calls already say what to close, derived from the journal. |
| Counting closed sub-runs in memory | The run's state is a plain value, the fold of its journal. The timer's `isActive` is the one piece of memory that belongs to the incarnation, and Troupe guarantees it's active until its message is received, even if the message is already queued. |

## Evidence

`test/run/cancel-tree.test.ts` and `test/run/state.test.ts`, from T5, on a three-level tree (triage, log analyst, reader). Each level holds a tool open next to its delegation:

- Cancelling the root journals `runFinished` with `cancelled` in all three runs, the sub-runs with `The parent run finished: cancelled`. All three tools' signals are aborted, and every actor under the root is stopped. One probe hears both the report and the progress, and the root's report comes after both sub-runs' `runFinished`.
- A root whose sibling sub-run pushes it past `maxTokens` finishes `tokensExceeded`, and the other sub-run ends with `Cancelled: The parent run finished: tokensExceeded`.
- If the process dies right after the root's `runFinished`, and again after the analyst's, then spawning the root again closes every open run below. All three journals end in `cancelled`, and the root reports once. No model is called and no tool is run, at any level.
- A root whose sub-run can't close lists it in `status` and reports after 30 s, not before.
- Cancelling the analyst alone, by its `runId`, gives the root's model the error result, and the root completes. Ids with no live run under them change nothing.
- A decision for a cancelled run's waiting call replies `notWaiting`, and one for its closed sub-run replies `unknownRun`. Neither journal changes.
- Folding `runFinished` keeps the pending calls as `unfinished`.

Each of these makes a test fail: stopping sub-runs instead of cancelling them, reporting without waiting for the tree, skipping recovery's cleanup, ignoring closing mode, ignoring `cancel`'s `runId`, leaving `unfinished` empty, taking a decision once the run has finished, never reporting after the timeout, and dropping the `isActive` check that keeps it to one report.

A sub-run inherits its parent's deadline, so at a deadline its own timer fires too, and it ends with `deadlineExceeded` rather than `cancelled`. That's why the tests use `tokensExceeded` as the other reason to finish.

**T8 (2026-11-27):** `scripts/check-example.ts`: `--cancel-after 2` cancels the example's run once the log analyst's first step is journaled, through `startRun`'s `cancel`. `--show` then prints both journals as a tree, the analyst's under step 2, and each ends in `finished: cancelled`. `test/start-run.test.ts`: `cancel` aborts the analyst's held tool and ends both journals in `cancelled`, and `cancel` with the analyst's `runId` cancels it alone while the root completes.

## Consequences

- Every run in a tree ends in its journal, whatever happened to the process, the first time its root is spawned after a crash. Spawning a finished root spawns its unfinished sub-runs too, which is rare and brief.
- A report now means the tree under the run has closed. Callers that stop a run on its report no longer cut its sub-runs short.
- A cancelled sub-run's usage never reaches its parent's `treeUsage`, since the parent's journal has already ended (the spec's open question 8).
- If a live sub-run's write of its cancellation fails, supervision restarts it, and the restart has forgotten the `cancel`. It resumes until the parent's closing timeout stops it, and it's closed the next time the parent is spawned.
- A parent finishing at its deadline usually finds its sub-runs finishing at the same deadline, as `deadlineExceeded`, which is just as final.
