# 0001. A run is a persistent Troupe actor, and its journal is the run

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 1

## Context

The point of Steadfast is that a run survives anything: a crash, a deploy, a rate limit. That needs somewhere durable to keep what a run has learned, and a way to pick up exactly where it left off. Troupe already has event-sourced persistent actors that recover from a journal on SQLite or Postgres.

## Decision

Each run is one Troupe persistent actor, with its own event stream. Every fact the run learns from outside, each model response and tool result, is persisted as an event before the run acts on it. The run's state is a pure fold of those events. The journal holds facts only, never intentions: what to do next is derived from state, so there's no "started" event to reconcile.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Checkpoint the whole transcript after each step (LangGraph-style) | Simple, but each checkpoint overwrites the last, so there's no history to replay or inspect, and a crash between the call and the checkpoint loses the call's result. |
| A workflow engine's steps (Temporal, DBOS, Vercel Workflow) | Proven, but it's another runtime to run or a platform to adopt, and it isn't actors, which is the angle this project exists to show. |
| Journal intentions too (`modelRequested`, `toolStarted`) | Makes the timeline richer, but recovery then has to reconcile intentions with results. Deriving pending work from state is simpler, and attempts are journaled anyway (0002). |

## Evidence

Proposed. Milestone 1 proves it in T3 and T4: a test stops the system after every event of a five-step run, spawns the run again on the same journal, and checks that it ends as an uninterrupted run would, with the same model requests.

**T3 (2026-11-24):** `test/run/run.test.ts` and `test/run/state.test.ts`:

- A run's journal holds only facts: `runStarted`, `modelResponded`, `toolFinished`, `attemptFailed` and `runFinished`. A response that ends the run is written together with `runFinished`, in one append.
- What runs next is derived from state alone. The same `act` starts the model call or the step's tool calls after any event, and leaves a child that's still running alone.
- `onEvent` is pure. Folding a recorded run's events twice, with every event and every state frozen as it's made, gives equal states, and every prefix folds to a JSON value.

**T4 (2026-11-24):** `test/run/recovery.test.ts`:

- A five-step run, with two steps that call tools at the same time, is stopped after every event in turn. A journal that takes no appends past event N makes the crash, and a new kit spawns the run again on the same journal. Every time, the resumed run writes the same journal and the same report as a run that was never stopped. The answered requests from the first incarnation, followed by the second's requests, equal the uninterrupted run's requests, so a model call that was in flight is made again with the same request. The last response and `runFinished` are one append, so no crash lands between them.
- Recovery is the same derivation as a live run: on `recoveryCompleted`, the run calls the `act` it uses after every event, with a flag for tool calls an earlier incarnation started (0003). A finished run only reports.
- A run stopped after event 105 of 113 recovers from its snapshot at 100, reading the journal from 101, and the snapshot equals the fold of the first 100 events. Recovered again from every event, it makes the same requests and writes the same journal.

Breaking it fails these tests: not resuming a pending model call, resuming it one step late, and turning snapshots off.

## Consequences

- Recovery is Troupe's: replay the stream, then act on `recoveryCompleted`.
- `readRun` and milestone 3's timeline fold the same events with the same `onEvent`, so they show exactly what a recovering run sees.
- State must stay a JSON value, and `onEvent` must stay pure. Anything else would happen again on every replay.
- A long run's state is large. Snapshots keep recovery quick, and their version must be bumped whenever the state's shape changes.
