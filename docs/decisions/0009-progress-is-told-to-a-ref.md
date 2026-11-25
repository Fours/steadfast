# 0009. Progress is told to a ref captured by the run's definition

- **Status:** Proposed
- **Date:** 2026-11-25
- **Milestone:** 2

## Context

A caller wants to follow a run as it happens: to narrate it in a terminal, draw it in a UI, or stream the model's text as it's written. The journal already holds everything the run learned, but reading it means polling, and the model's text isn't journaled until the response is whole. Whatever does this has to work across a tree of runs (milestone 2's sub-agents) and, later, across nodes (milestone 5), so it can't rely on shared memory. And a slow or broken listener must never slow down or change a run.

## Decision

`RunOptions` takes a `progressTo` ref, captured by the run's definition as `reportTo` is, since refs aren't plain values. The run tells it `RunProgress` messages:

- **`journaled`**, for every event, told in `thenRun` after the write, with the `seq` the journal gave it. Every write in the run goes through one helper that does this, so each event is told exactly once, in journal order, and never before it's written. The seqs are counted from `ctx.lastSeq` as the command began.
- **`text`**, for model text as it's generated. The model-call child tells it straight to `progressTo`, so streaming never waits behind the run's mailbox. It's a preview: delivered at most once, never journaled or replayed. It carries the attempt number, so a listener can clear what a failed attempt streamed.
- **`resumed`**, first, on every spawn, with the `seq` recovery reached, which is 0 for a new run. Events up to it come from `readRun(agent, runId, { upTo: seq })`, and those after it come as `journaled`. Together, they give every event exactly once.

Every message names its `runId`, so in T3 one ref can hear a whole tree, with sub-runs passing `progressTo` down.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Subscribers read the journal, through a Troupe projection or by polling | Works for events, but not for streamed text, which is never journaled. Polling adds latency, and a projection needs a tag on every event. Progress is a message, which also fits milestone 5's nodes. |
| A callback in `RunOptions` | A function can't cross nodes, and would run inside the run's turn, so a slow callback slows the run. A ref's `tell` never blocks or throws. |
| Tell progress before the write, as soon as the event is decided | A failed write would leave a listener believing in an event the journal doesn't have. |
| Route text through the run actor | Each piece would queue behind the run's other messages, and the run would do work that changes nothing in its state. |
| Tell `resumed` only when recovery found events | A listener would need a special case for a new run. Always telling it means a run's first message always says where the listener joins. |

## Evidence

`test/run/progress.test.ts`, from T2:

- Every event reaches `progressTo` once, in order, with its journal seq, including a failed attempt and the final response and `runFinished` written together. A run cancelled before it started tells both events of its one write. A failed write tells nothing.
- Text pieces for each step arrive before that step's `journaled` response, and join to the response's text. A call that streams part of an answer and then fails is followed by the retry's pieces at `attempt: 2`.
- After a crash at each of 1 to 6 of the run's 8 events, the new incarnation tells `resumed` first with the recovered seq, and `readRun` up to it plus the `journaled` messages after it equal the whole journal. A finished run tells only `resumed`.
- A run whose `progressTo` is a stopped actor journals and reports exactly what a run with no `progressTo` does.

Breaking the seq offset, telling before the write, the attempt number, or `resumed`'s seq each makes these tests fail.

**T3 (2026-11-25):** `test/run/delegate.test.ts`: one ref given to the root hears `resumed` from the root and its sub-run, and every event of both journals, each with its `runId`.

Still to prove, in T8: the example's narration is built from progress alone. This record becomes Accepted then.

## Consequences

- A UI can follow a run live, notice a gap from the seqs, and fill it with `readRun`. Milestone 3's live view will do exactly that.
- Progress is best-effort delivery, just like any `tell`. Events can always be recovered from the journal. Streamed text can't, and it doesn't need to be.
- Each event costs one extra `tell` per listener. A run with no `progressTo` pays nothing.
