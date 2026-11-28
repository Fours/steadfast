# 0006. A sub-agent is a child run, with its own journal, so an interrupted one resumes

- **Status:** Accepted
- **Date:** 2026-11-25
- **Milestone:** 2

## Context

An agent should be able to hand part of its task to another agent, such as a triage agent asking a log analyst to read the logs. The obvious way to build this is as a tool whose `run` runs the other agent. But a tool that's interrupted is either run again, if it's idempotent, or reported to the model as "may or may not have run" (decision 0003). Neither suits a sub-agent. Running it again repeats model calls and tool calls that already happened. Reporting it throws away work that's already in a journal. A sub-agent also needs its own budget and supervision, and its parent's limits still have to hold over it.

## Decision

`delegate(agent, { name?, description })` makes a tool whose input is `{ task: string }`, and which carries the agent it hands to as `delegatesTo`. The run never calls that tool's `run`. For a delegation, it spawns the sub-agent's `run` as a persistent child, with the task as its input:

- **Ids are derived, never chosen.** The sub-run's id is `<parent run id>/<step>.<index>`, where `index` is the call's place in the response, and its actor is `sub-<step>-<call id>`, or `sub-<step>~<index>` when the call id doesn't fit an actor name. Both come from the parent's journal, so a recovering parent finds the same sub-run, and `readRun` names it without asking anyone. One pure function, `planSubRun`, derives the id or the reason not to start, for the run and for `readRun`.
- **It resumes; it isn't retried.** On recovery, a pending delegation is spawned again. Its journal carries it on from where it was, or, if it had finished, it reports at once. "Interrupted tools" never applies to one.
- **Its report is the result.** The sub-run's `reportTo` is the parent, so `RunMsg` takes `RunReport`. The parent matches the report's `runId` to a pending call, journals `toolFinished` with the result and the sub-run's `treeUsage`, and then stops the sub-run's actor. `completed` is `{ ok: true, output: text }`. Any other outcome is an error result naming it.
- **It's supervised as a persistent actor,** with `restartWithBackoff`, so a sub-run that throws restarts and recovers from its journal.
- **Limits are handed down,** as `RunLimits` on `RunOptions`, journaled in `runStarted`: the parent's deadline, what's left of its `maxTokens` after its `treeUsage`, and one less level of depth. A run's deadline and token budget are the tighter of its own and its limits. The parent checks `maxTokens` against `treeUsage` after each sub-run reports, as well as after each response.
- Delegations that can't start, because the task isn't a string, there's no depth left, or the stream id would pass 255 characters, are error results, decided from the journal alone.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A tool whose `run` runs the sub-agent's loop in-process | It's a tool call, so an interruption either repeats the sub-agent's model calls or reports "may have run". Its steps aren't journaled, so nobody can see or replay them. |
| Sub-agent steps journaled into the parent's stream | One journal per tree makes it hard to read one agent's run on its own, and parallel sub-runs would write to one stream through the parent's mailbox. It also breaks "one run, one journal", which `readRun` and the replays in milestone 4 rely on. |
| Ids chosen when the sub-run starts, such as a random id journaled by the parent | That needs an extra event before the sub-run starts, and a crash between the choice and the event would start a second sub-run. Deriving the id from the step and the call's place needs no event. |
| Sub-runs as independent top-level runs that the parent watches | The parent couldn't stop them when it finishes, or hand them limits through supervision. Milestone 5 can still shard them, since everything is reached by refs and messages. |

## Evidence

`test/run/delegate.test.ts`, `test/run/budget.test.ts` and `test/delegate.test.ts`, from T3:

- A delegation starts a sub-run in `run-log-analyst-<run id>/1.0`, with the task as its input, and its `completed` text is the call's result. A `stepsExceeded` sub-run is an error result that names the outcome. Once the report is journaled, the sub-run's actor is stopped while the parent carries on.
- Two delegations in one step run at the same time, in `/1.0` and `/1.1`: each sub-run's tool is held until both have started.
- Stopping the system after each of the tree's 11 events, across the parent's stream and the sub-run's, and spawning the parent again, gives the same two journals and the same report. No model call that was journaled is made again in either run.
- A sub-run whose journal write fails is restarted by supervision, and recovers from its journal: its model's first answer isn't asked for again.
- A sub-run starts with its parent's deadline, the tokens its parent had left, and one less level. A run finishes at the deadline it was started with when that's earlier than its own. A sub-run held to 700 tokens stops at 800, and the parent, now at 1,100 of 1,000, finishes `tokensExceeded` in the same write as the result. A delegation with no depth left, and one whose stream id would be too long, are error results, and nothing starts.
- `readRun` names each delegation's sub-run, and the id it names reads back the sub-run's journal.

Each of these makes a test fail: leaving the index out of the sub-run's id, reporting a pending delegation as interrupted on recovery, leaving the usage off `toolFinished`, not handing the deadline down, not stopping the sub-run after its report, and not checking tokens after a report.

From T5, in `test/run/cancel-tree.test.ts`: cancellation reaches every run of a three-level tree, and each journals its end. A finished root that is spawned again closes the sub-runs it left open (decision 0008).

**T8 (2026-11-27):** `scripts/check-example.ts`, which CI runs as `npm run example:check`: `--crash-after 3` kills the example with exit code 137 after the log analyst's second step. Run again, the root recovers, its pending delegation spawns the sub-run again, and `incident-4211/2.0` resumes from its journal at event 5. It goes on with its step 3, and its first two steps aren't asked again or retried. The two processes' narration, both runs' events, equals an uninterrupted run's, and so does the final text.

Breaking it to check: starting the analyst's scripted model from its first step on resume, as a retried sub-run would, makes the check fail.

## Consequences

- A tree of runs reads back from journals alone, given the root agent: each delegation's sub-run id follows from the parent's journal, and its agent is the tool's `delegatesTo`. Milestone 3's inspector draws the tree from that.
- A sub-run's failure is reported, never retried, as its own journal already holds what it tried. That sharpens milestone 1's open question 7.
- Sub-runs started in the same step each get what was left of `maxTokens` when they start, so together they can overshoot it (open question 4).
- A parent's deadline is read on its sub-agent's clock. Agents in one tree should share a clock.
- A parent that finishes cancels its live sub-runs, and each journals its end (decision 0008).
- An agent can't delegate to an agent of its own name, since its sub-runs would read as the same agent in every journal. Indirect cycles are bounded by depth.
