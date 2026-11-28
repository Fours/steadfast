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
| [0004](0004-built-on-troupe-with-no-other-dependencies.md) | Built on Troupe, with no other runtime dependencies: providers are adapters over structurally typed clients | Accepted | 1 |
| [0005](0005-model-responses-are-journaled-verbatim.md) | Model responses are journaled verbatim, so runs replay without the model and providers get their own blocks back | Superseded by 0010 | 1 |
| [0006](0006-a-sub-agent-is-a-child-run-that-resumes.md) | A sub-agent is a child run, with its own journal, so an interrupted one resumes rather than retrying or reporting "may have run" | Accepted | 2 |
| [0007](0007-approvals-are-durable-waits-in-the-journal.md) | Approvals are durable waits: the request and the decision are journaled events, and the wait is derived from state | Accepted | 2 |
| [0008](0008-cancellation-is-journaled-in-every-run.md) | Cancellation is journaled in every run of the tree, and a finished run closes its unfinished sub-runs on recovery | Accepted | 2 |
| [0009](0009-progress-is-told-to-a-ref.md) | Progress is told to a ref captured by the run's definition: journaled events with their `seq`, and streamed text at most once | Accepted | 2 |
| [0010](0010-adapters-apply-their-providers-resend-rules.md) | Adapters apply their provider's rules for resending a response, and the journal stays verbatim | Accepted | 2 |
| [0011](0011-the-second-adapter-is-openai-responses.md) | The second adapter is OpenAI's Responses API, because it differs from Anthropic's where `Model` could have been shaped by it | Accepted | 2 |
