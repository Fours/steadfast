# Steadfast

Durable AI agents for TypeScript, built on [Troupe](https://github.com/Fours/troupe) actors. An agent's run is an event-sourced actor, and every model call and tool call is a supervised child of it. A crash, a deploy or a rate limit loses nothing: the run recovers from its journal and carries on from the step it was on. Every model response is in the journal, so any run can be read back exactly, with no model calls.

> **Status:** milestone 1 is done: durable runs, recovery, budgets, the Anthropic adapter and a testkit, in one process. It isn't on npm yet. That comes in milestone 3, with a run inspector. See the [roadmap](docs/roadmap.md) and the [decision records](docs/decisions/).

## Try it

```bash
npm install
npm run example -- --reset
```

[`examples/incident-triage`](examples/incident-triage) is an agent investigating a fake checkout outage with three tools: `read_log` and `query_metrics`, which are safe to repeat, and `page_oncall`, which isn't. It runs on a scripted model, so it needs no API key. The log shows every step as it's journaled, including step 2's model call, which gets a 429 and restarts with backoff.

Then crash it, and run the same command again:

```bash
npm run example -- --reset --crash-after 3   # exits with 137 once step 3 is journaled
npm run example                              # resumes at step 4
npm run example -- --reset --crash-during page_oncall
npm run example                              # the model is told the page may not have gone out
npm run example -- --show incident-4211      # the whole run, from its journal, with no model calls
```

`--model anthropic` runs it on Claude instead, with `ANTHROPIC_API_KEY` set.

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
- Send it `{ type: 'status', replyTo }` for its phase, step, usage and what it's waiting on, and `{ type: 'cancel', reason }` to finish it with `cancelled`.

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

A response that asks for no tools ends the run on its own terms: a final answer past `maxTokens` is still `completed`.

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

`@kylewillett/steadfast/anthropic` is an adapter for Claude's Messages API. Steadfast never imports the SDK: `client` is anything with the SDK's `beta.messages.create`, and `@anthropic-ai/sdk` is an optional peer dependency.

- **Defaults:** `claude-opus-5-5`, 16,000 output tokens, `effort: 'high'`, the model's default thinking, and no streaming. Each is an option.
- **Responses go back verbatim.** Each response's content is journaled as it came, and sent back exactly so, thinking blocks included ([0005](docs/decisions/0005-model-responses-are-journaled-verbatim.md)).
- **Retries belong to the run.** The SDK's own retries are off, so every attempt is supervised and journaled. Errors are retryable for a 408, 409, 429, 5xx or a lost connection, or as the API's `x-should-retry` says, and `retry-after` becomes `retryAfterMs`.

> **The refusal fallback is on by default.** Requests use the `server-side-fallback-2026-07-01` beta with `fallbacks: 'default'`, so a request a safety classifier declines is retried on a fallback model in the same call. That changes which model may answer, which each response's `model` records, and how a declined request is billed. Pass `fallbacks: false` to turn it off. A response that still refuses finishes the run with `refused`.

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

- `scriptedModel(script)` answers each call with the next entry, a response or a function of the request, and records every request. A call past the end fails the run, so a test notices.
- `faultyModel(inner, faults)` fails chosen steps' first attempts with chosen errors: `rateLimited`, `overloaded`, `timedOut` and `badRequest`.
- Pass the kit's scheduler as the agent's `clock`, so deadlines run on virtual time too. The same seed gives the same run.

## Development

```bash
npm run lint
npm run typecheck      # the editor config, then the build config with no Node types
npm test
npm run coverage       # 90% lines on src/
npm run build
npm run example:check  # the example's paths, crash and resume included, against dist/
```

## Licence

MIT
