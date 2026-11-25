# Changelog

## Unreleased

- The repo, the roadmap and the milestone 1 spec.
- `tool()`, `ToolDef`, `ToolContext` and `RetryableToolError`, and the child that runs one tool call with a timeout, an abort signal, input checks and retries.
- `agent()` and `agent.run()`: a run as a persistent Troupe actor, with model and tool calls in supervised children.
- Recovery from the journal: interrupted idempotent tools run again with the same key, and others are reported to the model.
- Retries with backoff, `retryAfterMs`, budgets (steps, tokens, a deadline, attempts per step) and `cancel`.
- `@kylewillett/steadfast/anthropic`: `anthropicModel()`, an adapter for Claude's Messages API, with the refusal fallback on by default.
- `@kylewillett/steadfast/testkit`: `scriptedModel`, `faultyModel` and error helpers.
- `readRun()`: a run's state, events and steps from its journal, at any sequence number.
- `examples/incident-triage`, with crash and resume, and the README.
