# Steadfast: roadmap

Steadfast is a runtime for durable AI agents in TypeScript, built on Troupe. An agent's run is an event-sourced Troupe actor, and every model call and tool call is a supervised child of it. A crash, a deploy or a rate limit loses nothing: the run recovers from its journal and carries on from the step it was on. Every model response is in the journal, so any run can be replayed exactly, with no model calls.

It's a portfolio piece for product engineer roles, and Troupe's first real user. Each milestone should end in something a reviewer can run and see.

Each milestone gets a full spec in `docs/milestone-N.md` when it starts. This page is the plan those specs are written from, so it describes outcomes and scope, not detailed design.

## Why it exists

Durable agents are a crowded space. As of November 2026:

| Project | What it is | How Steadfast differs |
| --- | --- | --- |
| Vercel Workflow DevKit | Durable, retryable steps for the AI SDK, with an experimental `DurableAgent` | Steps in a workflow, not a supervision tree. Built around Vercel's workflow runtime |
| Cloudflare Agents and Workflows | Durable agents on Workers and Durable Objects | Tied to Cloudflare |
| Temporal | Durable execution, now pitched at agents | Needs a Temporal cluster. A general workflow engine, not an agent runtime |
| DBOS | Durable execution as a library on Postgres | The closest in spirit. Workflows and steps rather than actors, with no inspector of agent runs |
| Agentspan (Orkes) | Open-source durable agent runtime | Compiles agents into workflows on the Conductor engine, which you run |
| Dapr, Diagrid Catalyst | Durable workflows for agent frameworks | Needs the Dapr sidecar runtime |
| LangGraph JS, Mastra | Agent frameworks with persistence | Frameworks first, durability second: no supervision, and no exact replay |

Check these before the README makes any comparison public: they change quickly.

The angles Steadfast leans into:

1. **Agents as actors.** A run is an actor, and its model calls, tools and sub-agents are supervised children. A failure restarts only what failed, with backoff, and the run carries on.
2. **Durable by default, self-hosted.** The journal is Troupe's, on SQLite or Postgres. There's no server to run and no platform to adopt.
3. **Exact replay.** Model responses are journaled verbatim, so a run can be replayed offline, step by step, and tested on Troupe's virtual time with scripted models.
4. **Visible runs.** A run timeline you can scrub through, on Troupe's Backstage inspector.

## Decisions so far

- **A run is a persistent Troupe actor, and its journal is the run** ([0001](decisions/0001-a-run-is-a-persistent-actor.md)).
- **Model and tool calls run in supervised child actors**, and the run only persists their results ([0002](decisions/0002-steps-run-in-supervised-children.md)).
- **An unfinished step is retried on recovery when it's safe to repeat**, and reported to the model when it isn't ([0003](decisions/0003-unfinished-steps-retry-only-when-safe.md)).
- **Built on Troupe, with no other runtime dependencies.** Providers are adapters over structurally typed clients ([0004](decisions/0004-built-on-troupe-with-no-other-dependencies.md)).
- **Model responses are journaled verbatim**, so runs replay without the model and providers get their own blocks back unchanged ([0005](decisions/0005-model-responses-are-journaled-verbatim.md)).

All five are Proposed until milestone 1 proves them.

## Milestones

| # | Milestone | Shippable? |
| --- | --- | --- |
| 1 | Durable agent runs: the run as a persistent actor, supervised steps, recovery, budgets, a testkit, one provider adapter | Library and a CLI example |
| 2 | Agent trees and people: sub-agents, delegation, approvals that survive restarts, cancellation, progress events | Library only |
| 3 | Run inspector, demo site, and the first npm release | **Yes: first portfolio point** |
| 4 | Evals on replay: recorded runs as fixtures, fault injection from a seed, an eval harness | Yes |
| 5 | Many runs across nodes, on Troupe's cluster sharding | Yes, a bonus |

Stopping after milestone 3 still leaves a complete project.

### 1. Durable agent runs

**Outcome:** one agent, in one process, runs a task with tools. Killing the process mid-run and starting it again resumes the run at the step it was on. A rate-limited model call backs off and retries without the run noticing. Budgets stop a run that goes on too long. Every run can be read back as a timeline, step by step, without calling the model.

Scope:

- `agent()` and `tool()` definitions, and `agent.run(runId, options)`, which returns a Troupe actor definition
- The run's events and state, and recovery that derives pending work from state
- Model and tool calls as supervised children, with backoff, timeouts and retryable errors
- Idempotency keys for tools, and what happens to an interrupted tool that isn't idempotent
- Budgets: steps, tokens, a deadline, and attempts per step
- A provider-neutral `Model` interface, and one adapter: Anthropic's Messages API
- The `/testkit` entry point: scripted and faulty models on Troupe's virtual time
- `readRun()`: a run's timeline from its journal, at any sequence number
- A CLI example, unit tests, type tests and a README

Spec: [milestone-1.md](milestone-1.md).

### 2. Agent trees and people

**Outcome:** an agent can hand part of its task to a sub-agent, which is a child run with its own budget, journal and supervision. A tool can require a person's approval, and the run waits for it durably: a restart while it waits loses nothing. Cancelling a run cancels its children. Callers can follow a run's progress as it happens.

Scope:

- Sub-agents as child runs, and a delegation tool the model can call
- Approvals as a durable wait, with a timeout
- Cancellation that cascades down the tree
- Progress events for callers and UIs, including streamed model output
- A second provider adapter, to prove the `Model` interface isn't shaped around the first

Spec: [milestone-2.md](milestone-2.md).

### 3. Run inspector, demo site, first npm release

**Outcome:** a public demo site runs Steadfast in the browser with no backend and no API key, on scripted models. A visitor watches an agent work, crashes a tool or the whole run, and sees it recover. A run timeline shows every step, and can be scrubbed back through time. The package is on npm.

Scope:

- A run view on Troupe's Backstage: the agent tree, each step's request and response, and a timeline you can scrub
- The demo site, and a write-up, "How Steadfast works", built from the decision records like Troupe's
- The first npm release from CI, with provenance, as Troupe does it

### 4. Evals on replay

**Outcome:** a recorded run becomes a test fixture. A change to a prompt or a tool can be checked against a set of recorded runs, with fault injection from a seed: rate limits, timeouts, tool crashes and process kills. Any failure replays exactly from its seed.

Scope:

- Recording runs as fixtures, and replaying them against a changed agent
- Fault injection on models and tools, on Troupe's Rehearsal (Troupe milestone 5)
- An eval harness that scores outcomes, ties in with the log-triage project's harness, and reports regressions

This depends on Troupe's Rehearsal being exported. If it isn't ready, this milestone waits or narrows.

### 5. Many runs across nodes

**Outcome:** runs are sharded entities on a Troupe cluster. Thousands of runs spread across nodes, and killing a node moves its runs to the others, where they resume from the journal.

Scope:

- Runs as sharded entities, on `@kylewillett/troupe/cluster`
- Failover mid-run, proven with real processes on Postgres, as Troupe's milestone 4 does
