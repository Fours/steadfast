# Design decisions

Each file here records one design choice: the choice itself, the alternatives, and the evidence for it. Write them for a reader, not just as notes to yourself. In milestone 3 they become the public write-up, "How Steadfast works", as Troupe's records did.

## How to add one

1. Copy `template.md` to `NNNN-short-title.md`, using the next free number.
2. Set the status:
   - **Proposed** means it's planned but not proven yet.
   - **Accepted** means it's backed by evidence or built.
   - **Superseded by NNNN** means a later record replaced it. Don't delete old records, and don't rewrite their history.
3. Add a row to the index below.
4. Put raw benchmark output in `data/`, named after the record, and link it from the Evidence section. Every set of numbers states the machine, the runtime and its version, and the exact command, so it can be rerun.

When you change a decision, update its record in the same commit as the code.

Troupe's records are in `../troupe/docs/decisions/`. Cite them as "Troupe's 0011" when a choice here rests on one there.

## Index

| # | Decision | Status | Milestone |
| --- | --- | --- | --- |
| [0001](0001-a-run-is-a-persistent-actor.md) | A run is a persistent Troupe actor, and its journal is the run | Accepted | 1 |
| [0002](0002-steps-run-in-supervised-children.md) | Model and tool calls run in supervised child actors, and the run only persists their results | Accepted | 1 |
| [0003](0003-unfinished-steps-retry-only-when-safe.md) | An unfinished step is retried on recovery when it's safe to repeat, and reported to the model when it isn't | Accepted | 1 |
| [0004](0004-built-on-troupe-with-no-other-dependencies.md) | Built on Troupe, with no other runtime dependencies: providers are adapters over structurally typed clients | Proposed | 1 |
| [0005](0005-model-responses-are-journaled-verbatim.md) | Model responses are journaled verbatim, so runs replay without the model and providers get their own blocks back | Proposed | 1 |
