# AGENTS.md

Guidance for coding agents working in this repo.

## Project

Steadfast is a runtime for durable AI agents in TypeScript, built on Troupe (`@kylewillett/troupe`, in `../troupe`). An agent's run is an event-sourced Troupe actor, and its model and tool calls are supervised children. It's a portfolio project for product engineer roles, and Troupe's first real user.

- Package: `@kylewillett/steadfast`, one package with subpath exports, like Troupe. It stays `"private": true` until milestone 3. Never `npm publish` by hand.
- Full plan: [docs/roadmap.md](docs/roadmap.md)
- Milestone specs: `docs/milestone-N.md`. **Work only on the current milestone.** Don't build features from later milestones early, but don't block them either.
- Task status lives in the table at the top of each spec's "Tasks" section. When a task's "Done when" passes, mark it Done there and tick its `- [ ]` boxes in the same commit as the code. Fill in the Commit column with the short hash of the task's commit in the next commit, since a commit can't contain its own hash. When every task is done, update the milestone's row below and tick the spec's "Definition of done".

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Durable agent runs: the run as a persistent actor, supervised steps, recovery, budgets, testkit | Done — [spec](docs/milestone-1.md) |
| 2 | Agent trees and people: sub-agents, approvals, cancellation, progress events | Not started — [spec](docs/milestone-2.md) |
| 3 | Run inspector, demo site, first npm release | Not started |
| 4 | Evals on replay: recorded runs, fault injection from a seed, an eval harness | Not started |
| 5 | Many runs across nodes, on Troupe's cluster sharding | Not started |

## Stack

- Node 22.18 or later (CI runs 22, 24 and 26), TypeScript in strict mode, ESM
- `@kylewillett/troupe` as a peer dependency, and no other runtime dependencies
- Vitest for tests, ESLint and Prettier

## Commands

```bash
npm install
npm run lint
npm run typecheck   # editor config, then the build config with no Node types
npm test
npm run coverage    # enforces 90% lines on src/
npm run build       # tsc → dist/
```

Before you say a task is done, run lint, typecheck, test, coverage and build, and make sure they all pass.

## Working with Troupe

- Troupe lives in `../troupe` and is on npm. Read its README and `docs/decisions/` before designing around how it behaves. Its rules hold here too: state is a plain value, one message at a time per actor, `tell` never throws, and time and chance are injected.
- If Steadfast needs something Troupe doesn't have, don't work around it here. Write down what's missing in the spec's open questions, and raise it, so it can be added to Troupe properly.
- Depend on Troupe's public entry points only, never on files under its `src/`.

## Rules that must hold

- **The core is runtime-agnostic** ([0004](docs/decisions/0004-built-on-troupe-with-no-other-dependencies.md)). No `node:*` imports, no `process` or `Buffer`, and no Node types in the build. Node-only features get their own entry point.
- **Time, scheduling and chance are injected.** Read time through Troupe's scheduler (`ctx.now()`) or an injected clock, schedule through actor timers, and draw chance from the system's random. Never call `Date.now()`, `setTimeout` or `Math.random()` in `src/`.
- **The journal is the run** ([0001](docs/decisions/0001-a-run-is-a-persistent-actor.md)). Everything a run learns from the outside world, every model response and tool result, is an event before the run acts on it. `onEvent` stays pure.
- **Side effects happen in children** ([0002](docs/decisions/0002-steps-run-in-supervised-children.md)). The run actor never calls a model or a tool itself.
- **Model responses are kept verbatim** ([0005](docs/decisions/0005-model-responses-are-journaled-verbatim.md)). Never rewrite, trim or reorder a provider's content blocks: they go back to the provider exactly as they came.
- **Providers are adapters over structurally typed clients.** Steadfast never imports a provider SDK at runtime. An adapter's SDK is an optional peer dependency, imported only from that adapter's entry point.
- Invalid options throw when they're passed in, never later.

## Tests

- Use Troupe's testkit (`createTestKit`) and Steadfast's scripted models for everything. Tests never call a real model or the network, and never use real sleeps or timers.
- Every behaviour listed in a milestone spec's "Done when" needs a test.
- Use `expectTypeOf` type tests for API typing claims.
- Keep line coverage on `src/` at 90% or higher.
- Prove that the important tests can fail. After a task's tests pass, temporarily break each key behaviour, such as resuming at the right step or the idempotency key staying stable across retries. Check that a test fails, then restore the code, and say in the commit message what you broke.

## Style

- Strict TypeScript: no `any`, and no non-null `!` unless a comment explains why.
- Integer milliseconds everywhere.
- Keep functions small and pure where possible. I/O and scheduling belong at the edges.
- Write comments that explain why, not what.
- Every public export has a TSDoc comment.

## Commits

- Never add an attribution line for Claude or any other AI to commit messages. That includes `Co-Authored-By: Claude ...` trailers and "Generated with ..." footers.

## Design decisions

`docs/decisions/` holds one numbered record per design choice: the context, the decision, the alternatives, the evidence and the consequences. See `docs/decisions/README.md` for the format and the index.

- Read the related records before changing anything they cover.
- When you make or change a decision, add or update its record in the same commit as the code. Never rewrite an Accepted record. Supersede it with a new one instead.
- When a test proves a Proposed record, fill in its Evidence section and change its status to Accepted.
