# Steadfast

Durable AI agents for TypeScript, built on [Troupe](https://github.com/Fours/troupe) actors. An agent's run is an event-sourced actor, and every model call and tool call is a supervised child of it. A crash, a deploy or a rate limit loses nothing: the run recovers from its journal and carries on from the step it was on. Every model response is in the journal, so any run can be read back exactly, with no model calls.

> **Status:** milestones 1 and 2 are done. That covers durable runs, recovery, budgets and a testkit; sub-agents, approvals, cancellation across a tree and progress; and adapters for Claude and OpenAI, all in one process. It isn't on npm yet. That comes in milestone 3, with a run inspector. See the [roadmap](docs/roadmap.md) and the [decision records](docs/decisions/).

## Try it

```bash
npm install
npm run example -- --reset
```

[`examples/incident-triage`](examples/incident-triage) is an agent investigating a fake checkout outage. It checks metrics itself, and hands log reading to a `log-analyst` sub-agent, whose steps the log shows indented under the step that delegated to them. `page_oncall` isn't safe to repeat, and needs a person's approval, so the terminal asks `Approve page_oncall to payments? [y/n]`. The example runs on scripted models, so it needs no API key. The log is built from the run's progress: every event as it's journaled, in every run of the tree, and the model's text as it's written. That includes step 3's model call, which gets a 429 and restarts with backoff.

Then crash it, and run the same command again:

```bash
npm run example -- --reset --crash-while-waiting   # exits with 137 while the approval waits
npm run example                              # the same request, still waiting, with no new model call
npm run example -- --reset --crash-after 3   # exits with 137 inside the log analyst
npm run example                              # the analyst resumes from its journal, at its step 3
npm run example -- --reset --crash-during page_oncall
npm run example                              # the model is told the page may not have gone out
npm run example -- --reset --cancel-after 2  # cancels the run while the analyst is working
npm run example -- --show incident-4211      # the tree, from its journals, with no model calls
```

`--approve yes|no` answers the approval without asking. `--model anthropic` runs it on Claude, with `ANTHROPIC_API_KEY` set, and `--model openai` on OpenAI, with `OPENAI_API_KEY` and `OPENAI_MODEL`.

## Quick start

```ts
import { actor, createActorSystem } from '@kylewillett/troupe';
import { sqlitePersistence } from '@kylewillett/troupe/persistence/sqlite';
import { agent, tool, type RunReport } from '@kylewillett/steadfast';
import { anthropicModel } from '@kylewillett/steadfast/anthropic';
import Anthropic from '@anthropic-ai/sdk';

const readLog = tool({
  name: 'read_log',
  description: 'Read the last lines of a service log.',
  input: {
    type: 'object',
    properties: { service: { type: 'string' }, lines: { type: 'integer' } },
    required: ['service', 'lines'],
    additionalProperties: false,
  },
  idempotent: true,
  run: ({ service, lines }: { service: string; lines: number }, { signal }) =>
    tailLog(service, lines, { signal }),
});

const triage = agent({
  name: 'triage',
  model: anthropicModel({ client: new Anthropic() }),
  system: 'You triage production incidents. Find the cause, then say what to do next.',
  tools: [readLog],
  budget: { maxSteps: 30, maxTokens: 200_000, deadlineMs: 15 * 60_000 },
  persistence: sqlitePersistence({ path: 'runs.db' }),
});

const system = createActorSystem();
const desk = system.spawn(
  actor<RunReport, null>({
    initial: () => null,
    receive(state, report) {
      console.log(report.outcome, report.text);
      return state;
    },
  }),
  'desk',
);
system.spawn(
  triage.run('incident-4211', { input: 'Checkout is returning 502s.', reportTo: desk }),
  'incident-4211',
);
```

Kill the process in the middle of that run and start it again: the same code resumes the run from its journal.

## Tools

```ts
import { RetryableToolError, tool } from '@kylewillett/steadfast';

const pageOncall = tool({
  name: 'page_oncall',
  description: "Page a team's on-call engineer.",
  input: {
    type: 'object',
    properties: { team: { type: 'string' }, summary: { type: 'string' } },
    required: ['team', 'summary'],
  },
  timeoutMs: 10_000,
  run: async ({ team, summary }: { team: string; summary: string }, ctx) => {
    if (!(await pager.reachable())) throw new RetryableToolError('The pager is down. Nothing was sent.');
    // The key is the same on every attempt and after every restart, so the pager can dedupe.
    return pager.page(team, summary, { idempotencyKey: ctx.idempotencyKey, signal: ctx.signal });
  },
});
```

- `input` is a JSON Schema, sent to the model as written. `parse` takes a [Standard Schema](https://standardschema.dev), such as a Zod schema, to check the model's input before `run` sees it. Input that fails it goes back to the model as an error, and the tool doesn't run.
- `run`'s output must be a JSON value, since it's journaled.
- A tool reports a failure by throwing, and the model sees the error. An **idempotent** tool that throws or times out is retried with backoff first. A tool that isn't idempotent gets one attempt, unless it throws `RetryableToolError` to say nothing happened.
- `ctx.signal` aborts on a timeout (default 60 s), when the run is cancelled and when it stops.
- `tool()` throws at once for a bad name, a missing description, a bad `timeoutMs` and an unknown option.

## Agents and runs

`agent()` checks its options and returns an `Agent`. `agent.run(runId, { input, reportTo })` returns an ordinary Troupe actor definition: spawn it, name it, watch it and supervise it like any other actor.

- **Spawning starts or resumes.** With no events in the journal, the run starts with `input`. With events, it resumes from them, and `input` is ignored, with a warning if it differs.
- **`reportTo` hears a `RunReport` once per incarnation**: `{ runId, outcome, text, usage }`. A run that's spawned after it finished reports at once, so a caller always hears the outcome, but may hear it more than once.
- A run's journal stream is `run-<agent name>-<runId>`. It snapshots every 100 events, so long runs recover quickly.
- Send it `{ type: 'status', replyTo }` for its phase, step, usage, what it's waiting on, its pending approvals and its live sub-runs, and `{ type: 'cancel', reason }` to finish it with `cancelled`.
- For plain async code, [`startRun`](#awaiting-a-run) wraps all of this in a handle you can await.

### Recovery

The journal holds facts, never intentions: each response, each tool result and each failed attempt. What a run does next is derived from them, so a fresh start and a recovery are the same code ([0001](docs/decisions/0001-a-run-is-a-persistent-actor.md)).

- A model call that was in flight is made again. It has no side effects, so that's always safe.
- A tool call that was in flight is run again with the same idempotency key, if it's idempotent. If it isn't, it doesn't run again, and the model is told it was interrupted and may or may not have run ([0003](docs/decisions/0003-unfinished-steps-retry-only-when-safe.md)). So idempotent tools run at least once, and the others at most once.

### Errors and retries

Every step runs in a supervised child ([0002](docs/decisions/0002-steps-run-in-supervised-children.md)), restarted with backoff from 1 s to 60 s after a retryable failure. A model error's `retryAfterMs` raises the delay. Every failed attempt is journaled, so a crash doesn't reset the count.

- A retryable model error (a 429, an overload, a timeout) is retried. When attempts run out, or for an error that isn't retryable, the run finishes with `failed`.
- A tool's failure goes back to the model, which can often work around it. So does a call to a tool that doesn't exist.

### Budgets

| Budget | Default | When it runs out |
| --- | --- | --- |
| `maxSteps` | 50 model calls | `stepsExceeded`, instead of running the tools the last response asked for |
| `maxTokens` | none | `tokensExceeded`, the same way. Input and output tokens both count. |
| `deadlineMs` | none | `deadlineExceeded`. Measured on the agent's `clock` from the run's start, so it holds across restarts. |
| `maxAttemptsPerStep` | 5 | A model call fails the run. A tool call's error goes to the model. |

| `maxDepth` | 3 levels of sub-runs | A delegation past it is an error result: the model hears it can't delegate any further. |

A response that asks for no tools ends the run on its own terms: a final answer past `maxTokens` is still `completed`.

A response that pauses (Anthropic's `pause_turn`, from a long server tool) has the stop reason `paused`. The run calls the model again with the transcript as it is, and it counts as a step, so `maxSteps` bounds a model that keeps pausing.

## Sub-agents

```ts
import { agent, delegate } from '@kylewillett/steadfast';

const analyst = agent({
  name: 'log-analyst',
  model,
  system: 'You read service logs and say what they show. Quote the lines that matter.',
  tools: [readLog],
  budget: { maxSteps: 10 },
  persistence,
});

const triage = agent({
  name: 'triage',
  model,
  system: 'You triage production incidents. Ask the log analyst to read logs for you.',
  tools: [
    queryMetrics,
    pageOncall,
    delegate(analyst, {
      name: 'ask_log_analyst',
      description: 'Give the log analyst a task, such as "find errors in checkout since 14:00".',
    }),
  ],
  budget: { maxSteps: 30, maxTokens: 200_000, deadlineMs: 15 * 60_000 },
  persistence,
});
```

`delegate()` makes a tool from an agent. The model sees an ordinary tool that takes a `task`. When it calls it, the run starts a **sub-run** of that agent, as a persistent child with a journal of its own, and the sub-run's report becomes the call's result ([0006](docs/decisions/0006-a-sub-agent-is-a-child-run-that-resumes.md)).

- **An interrupted sub-run resumes.** It isn't retried, or reported as "may or may not have run" as an interrupted tool is. Its journal says where it was, so it carries on from there.
- **Its id is derived:** `<parent run id>/<step>.<index>`, such as `incident-4211/2.0`, where `index` is the call's place in the response. The tree can be read back from journals alone, and `readRun` names each delegation's `subRun`.
- **It can't outlive or outspend its parent.** It starts with its parent's deadline, what's left of its parent's `maxTokens`, and one less level of depth. The parent counts every sub-run's usage in its `treeUsage`, and checks `maxTokens` against it, so delegating isn't a way around the budget. Callers can pass `limits` to a run too, such as a tighter deadline than its agent's.
- Sub-runs started in the same step run at the same time. Each gets what's left of the budget when it starts, so together they can overshoot it, by at most one step's sub-runs.

## Approvals

```ts
import { tool } from '@kylewillett/steadfast';

const pageOncall = tool({
  name: 'page_oncall',
  description: "Page a team's on-call engineer.",
  input: { type: 'object', properties: { team: { type: 'string' } }, required: ['team'] },
  needsApproval: true, // or a function of the input, such as (input) => input.team === 'payments'
  approvalTimeoutMs: 10 * 60_000,
  run: ({ team }: { team: string }, { idempotencyKey, signal }) =>
    pager.page(team, 'Checkout is down.', { idempotencyKey, signal }),
});
```

A call that needs approval waits for a person's decision, and the wait is durable: the request and the decision are events in the journal, never promises in memory ([0007](docs/decisions/0007-approvals-are-durable-waits-in-the-journal.md)). A restart while it waits loses nothing, and the model isn't asked again.

- **The request is journaled** as `approvalRequested`, in the same write as the response that made the call, with the run id, the tool, its input, and the time on the agent's clock. Calls in the same step that don't need approval start at once.
- **A decision is a message:** `{ type: 'decide', runId, callId, approved, by, note?, replyTo? }`. Send it to the root. A run forwards it to the sub-run `runId` is in. The first decision wins, and a later one replies `notWaiting`.
- **A denial is a result.** The model sees `A person denied this call. <by>: <note>`, and the tool never runs. An approved call is an ordinary tool call from then on.
- **A timeout is a timer,** measured from the request on the agent's clock, so it holds across restarts. When it fires, the call is denied, and the model is told nobody decided in time.
- A `needsApproval` function runs once, when the response arrives, and its answer is journaled, so changing the code later doesn't change past runs. One that throws counts as `true`.
- **The run's deadline keeps running while it waits.** Give an agent that waits on people a deadline longer than its approval timeouts.

Every request and decision is tagged `steadfast.approval`, so an inbox of pending approvals across every run is a Troupe projection, with no polling of runs:

```ts
import { projection, type StoredEvent } from '@kylewillett/troupe/persistence';
import { APPROVAL_TAG, type RunEvent } from '@kylewillett/steadfast';

type Request = Extract<RunEvent, { type: 'approvalRequested' }>;
const inbox = new Map<string, Request>();

system.spawn(
  projection({
    name: 'approval-inbox',
    persistence,
    tag: APPROVAL_TAG,
    handle: (stored: StoredEvent) => {
      const event = stored.event as RunEvent;
      // A call id is unique within its run, and the stream id names the run.
      if (event.type === 'approvalRequested') {
        inbox.set(`${stored.persistenceId} ${event.callId}`, event);
      } else if (event.type === 'approvalDecided') {
        inbox.delete(`${stored.persistenceId} ${event.callId}`);
      }
    },
  }),
  'approval-inbox',
);
```

Each request carries the `runId` and `callId` a decision needs.

## Cancellation

`{ type: 'cancel', reason }` finishes a run with `cancelled`, and every run under it too. Each one journals its own `runFinished`, so no sub-run's journal is left open ([0008](docs/decisions/0008-cancellation-is-journaled-in-every-run.md)).

- **It cascades by message.** A run that finishes for any reason stops its tool calls, and tells each live sub-run `cancel`, with the reason `The parent run finished: <outcome>`. It reports once its whole tree has closed.
- **A crash halfway through can't leave a sub-run open.** A finished run that's spawned again closes any sub-run its journal says was still working.
- **`cancel` can target a sub-run** with a `runId`, forwarded as `decide` is. The sub-run finishes `cancelled`, and its parent's model sees that as the delegation's error result, and carries on.
- Cancelling ends pending approvals with the run: a decision that arrives afterwards replies `notWaiting`.

## Progress

```ts
import { actor } from '@kylewillett/troupe';
import type { RunProgress } from '@kylewillett/steadfast';

const screen = system.spawn(
  actor<RunProgress, null>({
    initial: () => null,
    receive(state, p) {
      if (p.type === 'text') process.stdout.write(p.text);
      if (p.type === 'journaled') console.log(`\n${p.runId} #${String(p.seq)} ${p.event.type}`);
      return state;
    },
  }),
  'screen',
);
system.spawn(triage.run('incident-4211', { input: 'Checkout is down.', progressTo: screen }), 'incident-4211');
```

A run tells its `progressTo` what's happening, and passes the ref down to its sub-runs, so one ref hears the whole tree, each message naming its `runId` ([0009](docs/decisions/0009-progress-is-told-to-a-ref.md)).

- **`journaled`** is each event once it's written, with the `seq` the journal gave it, in journal order per run. A gap in a run's `seq`s means a message was lost, and `readRun(agent, runId, { upTo })` fills it.
- **`resumed`** comes first, on every spawn, with the `seq` the run recovered to, 0 for a new run. Events up to it come from `readRun`.
- **`text`** is the model's text as it's generated, for a preview. It's delivered at most once and never journaled: the response's text is, when it's whole. `attempt` goes up when a call is retried, so a listener can clear what a failed attempt showed.
- `tell` never throws, so a slow or stopped listener never slows or breaks a run.

## Awaiting a run

For plain async code, outside an actor:

```ts
import { createActorSystem } from '@kylewillett/troupe';
import { startRun } from '@kylewillett/steadfast';

const system = createActorSystem();
const run = startRun(system, triage, 'incident-4211', {
  input: 'Checkout is returning 502s.',
  onProgress: (p) => {
    if (p.type === 'journaled' && p.event.type === 'approvalRequested') {
      const { runId, callId } = p.event;
      void run.decide({ runId, callId, approved: true, by: 'kyle', note: 'Go ahead.' });
    }
  },
});

const report = await run.done; // the RunReport
console.log(report.outcome, report.text);
```

- `startRun` spawns a small host actor, which spawns the run as its child, passes its progress to `onProgress`, and settles `done` with its first report. It then stops the run, and itself.
- `run.cancel(reason, runId?)` cancels the run, or one sub-run. `run.decide(decision)` resolves with the run's `DecideReply`.
- Starting a run that `startRun` is already running in the same system throws, rather than starting a second incarnation on the same journal.
- `done` rejects if the run stops without finishing, such as when the system terminates first. Spawning it again resumes it.
- It's a convenience over the actor API, never a replacement: everything it does goes through `reportTo`, `progressTo` and messages.

## Reading a run back

```ts
import { readRun } from '@kylewillett/steadfast';

const run = await readRun(triage, 'incident-4211'); // the whole run
const early = await readRun(triage, 'incident-4211', { upTo: 5 }); // as it was after event 5

for (const step of run.steps) {
  console.log(step.step, step.response?.text, step.tools.map((t) => [t.name, t.result]));
}
```

`readRun` returns `{ state, events, steps }`: the run's state, each event with its sequence number and timestamp, and the events grouped by step. It folds the journal through the same function the run recovers with, so it shows exactly what a recovering run would see. It never calls the model, and needs no actor system ([0005](docs/decisions/0005-model-responses-are-journaled-verbatim.md)).

> **The journal is as sensitive as the conversation.** It holds the input, every model response verbatim (thinking included) and every tool result. Store and share it as you would the conversation itself.

## Claude

```ts
import Anthropic from '@anthropic-ai/sdk';
import { anthropicModel } from '@kylewillett/steadfast/anthropic';

const model = anthropicModel({ client: new Anthropic(), effort: 'high' });
```

`@kylewillett/steadfast/anthropic` is an adapter for Claude's Messages API. Steadfast never imports the SDK: `client` is anything with the SDK's `beta.messages.create` and `beta.messages.stream`, and `@anthropic-ai/sdk` is an optional peer dependency.

- **Defaults:** `claude-opus-5-5`, streamed, 64,000 output tokens (16,000 with `stream: false`), `effort: 'high'`, and the model's default thinking. Each is an option, and `serverTools` passes Anthropic's server tools through as written.
- **Streaming:** text deltas reach the run's `progressTo` as `text` progress as they're written. Only the final message is journaled, and a stream that fails partway is a failed attempt like any other.
- **Responses are journaled verbatim.** Each response's content is journaled as it came, and sent back as it came, thinking blocks included. The one exception is the API's own rule for a turn with a refusal fallback in it, which the adapter applies as it sends the turn back ([0010](docs/decisions/0010-adapters-apply-their-providers-resend-rules.md)).
- **Retries belong to the run.** The SDK's own retries are off, so every attempt is supervised and journaled. Errors are retryable for a 408, 409, 429, 5xx or a lost connection, or as the API's `x-should-retry` says, and `retry-after` becomes `retryAfterMs`.

> **The refusal fallback is on by default.** Requests use the `server-side-fallback-2026-07-01` beta with `fallbacks: 'default'`, so a request a safety classifier declines is retried on a fallback model in the same call. That changes which model may answer, which each response's `model` records, and how a declined request is billed. Pass `fallbacks: false` to turn it off. A response that still refuses finishes the run with `refused`.

## OpenAI

```ts
import OpenAI from 'openai';
import { openaiModel } from '@kylewillett/steadfast/openai';

const model = openaiModel({ client: new OpenAI(), model: 'gpt-5.6' });
```

`@kylewillett/steadfast/openai` is an adapter for OpenAI's Responses API. It's there to prove `Model` isn't shaped around Anthropic's API: the same agent runs on it with no change but the model ([0011](docs/decisions/0011-the-second-adapter-is-openai-responses.md)). As for Claude, `client` is structurally typed, and `openai` is an optional peer dependency.

- **No default model.** `model` is required, so the adapter never goes stale behind your back. `stream` (default `true`), `maxTokens` and `effort` are options.
- **Stateless:** requests pass `store: false` and ask for encrypted reasoning, so the journal, not OpenAI, holds the conversation. A response's output items are journaled verbatim, and go back as they came.
- Tool arguments arrive as a JSON string. Ones that don't parse to an object are an error result for the model, and the tool doesn't run.
- Retries belong to the run, and errors are classified as for Claude.

## Testing agents

`@kylewillett/steadfast/testkit` has models that never touch the network, for tests on Troupe's virtual time:

```ts
import { createTestKit } from '@kylewillett/troupe/testkit';
import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { agent, type RunReport } from '@kylewillett/steadfast';
import { callTool, faultyModel, rateLimited, say, scriptedModel } from '@kylewillett/steadfast/testkit';

const kit = createTestKit();
const model = faultyModel(
  scriptedModel([callTool('read_log', { service: 'checkout', lines: 50 }), say('The cause is a bad deploy.')]),
  { step: 1, fail: [rateLimited({ retryAfterMs: 2_000 })] },
);
const triage = agent({
  name: 'triage',
  model,
  system: 'You triage production incidents.',
  tools: [readLog],
  persistence: inMemoryPersistence(),
  clock: () => kit.scheduler.now(),
});

const reporter = kit.probe<RunReport>('desk');
kit.system.spawn(triage.run('incident-4211', { input: 'Checkout is down.', reportTo: reporter.ref }), 'incident-4211');
await kit.settle();
await kit.advance(5_000); // past the 429's backoff
reporter.expectMessage((report) => report.outcome === 'completed');
```

- `scriptedModel(script)` answers each call with the next entry, a response or a function of the request, and records every request. It streams each response's text a word at a time, with no delay. A call past the end fails the run, so a test notices.
- `faultyModel(inner, faults)` fails chosen steps' first attempts with chosen errors: `rateLimited`, `overloaded`, `timedOut` and `badRequest`.
- Pass the kit's scheduler as the agent's `clock`, so deadlines run on virtual time too. The same seed gives the same run.

## Development

```bash
npm run lint
npm run typecheck      # the editor config, then the build config with no Node types
npm test
npm run coverage       # 90% lines on src/
npm run build
npm run example:check  # every path of the example, crashes, approvals and cancelling included, against dist/
```

## Licence

MIT
