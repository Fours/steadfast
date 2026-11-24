# 0005. Model responses are journaled verbatim, so runs replay without the model and providers get their own blocks back

- **Status:** Proposed
- **Date:** 2026-11-24
- **Milestone:** 1

## Context

A run's history is what it sends the model on the next call. Providers attach content Steadfast doesn't understand and must not change: Claude's thinking blocks, for example, must be sent back unchanged, and history the model has seen shouldn't be edited. Replaying a run, for the timeline, for tests and for milestone 4's evals, needs every response exactly as it came, without calling the model again.

## Decision

Each `ModelResponse` keeps the provider's content verbatim in `raw`, alongside Steadfast's reading of it (`text`, `toolCalls`, `stop`, `usage`). `raw` is journaled with the response. Adapters rebuild the provider's messages from `raw`, never from Steadfast's reading. The transcript only grows: turns are appended, never edited or reordered.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Journal a provider-neutral form only | Smaller and tidier, but it drops what the provider needs back, such as thinking blocks, so the next call either fails or loses the model's reasoning. |
| Journal requests as well as responses | Requests are derived from state, so journaling them only duplicates it. |
| Re-call the model on replay, with a seed | Models aren't deterministic, and it costs money. A replay that calls the model is a new run. |

## Evidence

Proposed. T3 proves each response's `raw` reaches the next request unchanged and that the transcript only grows. T7 proves `readRun` rebuilds every state of a recorded run without calling the model.

**T3 (2026-11-24):** `test/run/run.test.ts`, over a five-step run with scripted responses:

- Every request's transcript starts with the previous request's, and is longer.
- Each response reaches the next request unchanged, `raw` included, compared with the response as the script made it.

T6 proves the adapter sends assistant turns back as `raw`, and T7 proves `readRun`, so this stays Proposed.

## Consequences

- The journal grows with every response, thinking included. Snapshots keep recovery quick, but streams aren't small.
- A second adapter in milestone 2 must keep its own `raw` the same way, which keeps `Model` honest.
- Milestone 2's context management must append (for example, a compaction turn), never rewrite earlier turns.
- The journal holds everything the model said, so it's as sensitive as the conversation. The README must say so.
