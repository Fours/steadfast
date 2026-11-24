# Milestone 1: Durable agent runs

Source: [roadmap](roadmap.md), Milestones → 1.

## Outcome

In one process, you can:

- define tools and an agent, and start a run with an id and an input
- watch the run call the model, call tools, and finish with an outcome
- kill the process at any point, start it again, and see the run resume at the step it was on
- read any run back as a timeline, step by step, without calling the model

A rate-limited or failing model call is restarted with backoff by its supervisor, and the run carries on. A tool that was interrupted is retried if it's safe to repeat, and reported to the model if it isn't. Budgets stop a run that takes too many steps, tokens or time. Everything runs on Troupe's virtual time in tests, with scripted models, so the same seed gives the same run.

**Demo at the end:** `npm run example` runs `examples/incident-triage`. An agent investigates a fake checkout outage with three tools: `read_log`, `query_metrics` (both idempotent), and `page_oncall` (not idempotent). It runs on a scripted model by default, so it needs no API key, or on Claude with `--model anthropic`. The narrated log shows every step. The scripted model returns a 429 on step 2, and the log shows the model call restarting with backoff. `--crash-after 3` kills the process with exit code 137 once step 3 is journaled. Running the same command again resumes at step 4. Crashing during `page_oncall` shows the other path: on resume, the model is told the page may or may not have gone out, and decides what to do. `npm run example -- --show incident-4211` prints the whole run from its journal, with no model calls.

## Scope

In scope:

- `tool()` and `agent()` definitions, and `agent.run(runId, options)`, which returns a Troupe actor definition
- The run's protocol, events and state, and recovery that derives pending work from state
- Model calls and tool calls as supervised children, with backoff, timeouts and retryable errors
- Idempotency keys for tools, and the rule for interrupted tools that aren't idempotent
- Budgets: steps, tokens, a deadline, and attempts per step
- The provider-neutral `Model` interface, and `@kylewillett/steadfast/anthropic`, an adapter for Claude's Messages API
- The `/testkit` entry point: `scriptedModel`, `faultyModel`, and error helpers
- `readRun()`: a run's timeline from its journal, at any sequence number
- Unit tests, type tests, the example and a README

Out of scope (later milestones):

| Item | Milestone |
| --- | --- |
| Sub-agents, delegation, approvals, cancellation that cascades | 2 |
| Streaming model output, progress events for UIs | 2 |
| A second provider adapter | 2 |
| Context management for long runs (compaction, clearing old tool results) | 2 |
| Server-side tools (web search, code execution), and the `pause_turn` stop reason they bring | 2 |
| The run view on Backstage, the demo site, the npm release | 3 |
| Recorded runs as fixtures, fault injection from a seed, the eval harness | 4 |
| Runs as sharded entities across nodes | 5 |

Design for these without building them. In particular:

- A run's children are found by name, so milestone 2's sub-agents are just another kind of child.
- Nothing assumes a run and its caller share memory: callers hear back through a ref, so milestone 5 can put them on different nodes.
- The journal holds everything milestone 3's timeline and milestone 4's replays will need.

## Design

### Defining a tool

```ts
import { tool } from '@kylewillett/steadfast';

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
  timeoutMs: 10_000,
  run: async ({ service, lines }, { signal }) => tailLog(service, lines, { signal }),
});
```

```ts
export interface ToolDef<I extends JsonValue, O extends JsonValue> {
  /** Unique within an agent. Matches ^[a-zA-Z0-9_-]{1,64}$. */
  name: string;
  description: string;
  /** JSON Schema for the input, sent to the model as written. */
  input: JsonSchemaObject;
  /** Optional runtime check of the model's input, as a Standard Schema (Troupe's 0018). */
  parse?: StandardSchemaV1<unknown, I>;
  /** Safe to run twice with the same input. Default false. See "Interrupted tools". */
  idempotent?: boolean;
  /** Default 60,000. A call that takes longer is aborted and counts as a retryable failure. */
  timeoutMs?: number;
  run(input: I, ctx: ToolContext): Promise<O>;
}

export interface ToolContext {
  readonly runId: string;
  readonly callId: string;
  /** The same on every attempt of this call, across restarts. Pass it to APIs that dedupe. */
  readonly idempotencyKey: string;
  /** Aborted on timeout, on cancel, and when the run stops. */
  readonly signal: AbortSignal;
}
```

- `run`'s output must be a JSON value, since it's journaled. It's checked before it's written.
- A tool reports a failure by throwing. What happens next depends on whether the tool is idempotent ("Errors and retries").
- A tool that isn't idempotent can throw `RetryableToolError` to say "nothing happened, try me again", for example when a request was refused before it was sent.
- Invalid definitions throw at `tool()`: a bad name, a missing description, a `timeoutMs` that isn't a positive integer.

### Defining an agent

```ts
import { agent } from '@kylewillett/steadfast';

const triage = agent({
  name: 'triage',
  model,
  system: 'You triage production incidents. Find the cause, then say what to do next.',
  tools: [readLog, queryMetrics, pageOncall],
  budget: { maxSteps: 30, maxTokens: 200_000, deadlineMs: 15 * 60_000 },
  persistence,
});
```

```ts
export interface AgentOptions {
  name: string;
  model: Model;
  system: string;
  tools?: readonly Tool[];
  budget?: Budget;
  /** Troupe persistence: in-memory, SQLite or Postgres. The journal holds every run. */
  persistence: Persistence;
  /** Wall-clock time in ms, for deadlines that survive restarts. Default: the real clock. */
  clock?: () => number;
}

export interface Budget {
  /** Model calls per run. Default 50. */
  maxSteps?: number;
  /** Input plus output tokens per run, as the model reports them. No default. */
  maxTokens?: number;
  /** Wall-clock time from the run's start. No default. */
  deadlineMs?: number;
  /** Failed attempts at one model call or one tool call before giving up. Default 5. */
  maxAttemptsPerStep?: number;
}
```

`agent()` checks its options and returns an `Agent`. Two tools with the same name throw.

### Starting a run and hearing back

```ts
const desk = actor<DeskMsg, null>({
  initial: (ctx) => {
    ctx.spawn(triage.run('incident-4211', { input: 'Checkout is returning 502s.', reportTo: ctx.self }), 'incident-4211');
    return null;
  },
  receive(state, msg, ctx) {
    // msg: { type: 'runFinished', runId, outcome, text, usage }
    ctx.log.info('run finished', { runId: msg.runId, outcome: msg.outcome });
    return state;
  },
});
```

- `agent.run(runId, { input, reportTo? })` returns an ordinary Troupe actor definition: spawn, name, watch and supervise it like any other. Its journal stream is `run-<agent name>-<runId>`.
- **Spawning starts or resumes.** If the journal has no events for that run, the run starts with `input`. If it has events, the run resumes from them, and `input` is ignored, with a warning if it differs from the journaled one. So the code that starts a run and the code that restarts it after a crash are the same code.
- **`reportTo` hears once per incarnation.** When the run finishes, it tells `reportTo` a `RunReport`. A run that's spawned after it has already finished reports at once. So a caller can always hear the outcome, but may hear it more than once.
- `reportTo` is captured by the definition, not kept in state, since refs aren't plain values (Troupe's 0001).

### The run's protocol

```ts
export type RunMsg =
  | { type: 'status'; replyTo: ActorRef<RunStatus> }
  | { type: 'cancel'; reason: string }
  // Internal: sent by the run's own children and timers. Exported so the type is complete.
  | { type: 'modelReplied'; step: number; response: ModelResponse }
  | { type: 'toolReturned'; step: number; callId: string; result: ToolResult }
  | { type: 'attemptFailed'; step: number; target: StepTarget; error: StepError }
  | { type: 'deadline' };
```

- `status` replies with the phase, the step, usage so far, and what the run is waiting on.
- `cancel` finishes the run with outcome `cancelled` and stops its children, which aborts their signals. Milestone 2 makes cancellation cascade to sub-agents.
- Internal messages carry their `step`, and the run ignores any for a step it's no longer on. A slow child of an old incarnation can't change a newer one's state.

### Events and state

A run is a persistent actor ([0001](decisions/0001-a-run-is-a-persistent-actor.md)). Its events are facts about the outside world, and its state is their fold:

```ts
export type RunEvent =
  | { type: 'runStarted'; agent: string; model: string; input: string; startedAt: number }
  | { type: 'modelResponded'; step: number; response: ModelResponse }
  | { type: 'toolFinished'; step: number; callId: string; result: ToolResult }
  | { type: 'attemptFailed'; step: number; target: StepTarget; error: StepError }
  | { type: 'runFinished'; outcome: Outcome; text: string };

export type StepTarget = { kind: 'model' } | { kind: 'tool'; callId: string };
export type ToolResult =
  | { ok: true; output: JsonValue }
  | { ok: false; error: string; interrupted?: true };
export type Outcome =
  | 'completed' | 'refused' | 'maxOutputTokens' | 'stepsExceeded' | 'tokensExceeded'
  | 'deadlineExceeded' | 'cancelled' | 'failed';

export interface RunState {
  phase: 'new' | 'running' | 'finished';
  input: string;
  startedAt: number;
  /** What the model sees: the input, each response, and each batch of tool results. */
  transcript: readonly Turn[];
  /** Model calls answered so far. */
  step: number;
  usage: { inputTokens: number; outputTokens: number };
  /** What the run is waiting on. Derived from the events, never journaled on its own. */
  pending: { kind: 'model' } | { kind: 'tools'; callIds: readonly string[] } | { kind: 'none' };
  /** Failed attempts so far, keyed by step and target. */
  attempts: Readonly<Record<string, number>>;
  outcome?: Outcome;
  text?: string;
}
```

- **The journal holds facts, never intentions.** There's no `modelRequested` or `toolStarted` event. What the run must do next is derived from state: after `runStarted`, or once every tool call of a step has finished, it calls the model. After a response with tool calls, it runs them. That's what makes recovery simple ("Recovery").
- `startedAt` comes from the agent's `clock`, not from `ctx.now()`, which is monotonic within a process but means nothing in the next one.
- Events and state must be JSON values. Troupe checks them before they're written.
- One command can persist several events. A response with no tool calls persists `modelResponded` and `runFinished` together.
- Snapshots are on, every 100 events, so long runs recover quickly. Bump `snapshots.version` whenever `RunState` changes shape.

### Steps as children

The run never calls a model or a tool itself ([0002](decisions/0002-steps-run-in-supervised-children.md)). For each piece of pending work, it spawns a child:

```
/user/incident-4211                 the run: a persistent actor
  ├─ model-3                        the model call for step 3
  └─ tool-3-toolu_01A…              one per tool call of step 3, running at the same time
```

- **A child does one thing and stops.** Its `initial` starts the call with `pipeToSelf`. Its `receive` tells the parent the result, then stops itself.
- **A retryable failure throws.** The child first tells the parent `attemptFailed`, so the attempt is journaled, and then throws. The parent spawned it with `supervise.restartWithBackoff({ minMs: 1_000, maxMs: 60_000, randomFactor: 0.2 })`, so Troupe restarts it after a delay, and its new `initial` calls again. A `retryAfterMs` on the error raises the delay for that attempt.
- **A failure that isn't retryable doesn't throw.** The child tells the parent, and stops. The parent decides what it means ("Errors and retries").
- **When attempts run out,** the parent stops the child. Watching it is how the parent knows it's gone.
- Children are named by step and call id, so the parent finds them with `ctx.child(name)`, and a stale child of an earlier step can't be confused with a current one.
- Timeouts are the child's own timer. When it fires, the child aborts its signal and treats it as a retryable failure.

### Recovery

On every start, the run replays its journal, then acts on `recoveryCompleted`:

1. **No events:** persist `runStarted` with the input, then call the model.
2. **Finished:** tell `reportTo`, and wait for messages. Nothing runs.
3. **Waiting on the model:** spawn the model call for the current step. A model call has no side effects, so repeating one is always safe.
4. **Waiting on tools:** for each tool call of the current step with no `toolFinished`, follow "Interrupted tools".
5. **A deadline:** start a timer for what's left of it, measured from `startedAt` by the agent's clock. If it's already passed, finish with `deadlineExceeded`.

Commands that arrive during recovery wait in the mailbox, as Troupe's persistent actors always do (Troupe's 0011).

### Interrupted tools

A tool call that was started but has no `toolFinished` was interrupted: by a crash, a deploy or a stop. Whether it ran is unknown ([0003](decisions/0003-unfinished-steps-retry-only-when-safe.md)).

- **Idempotent tools run again**, with the same idempotency key. The key is `<runId>:<step>:<callId>`, so it's the same on every attempt and in every incarnation.
- **Tools that aren't idempotent don't run again.** The run journals `toolFinished` with `{ ok: false, interrupted: true, error: 'The tool was interrupted and may or may not have run. Check before trying again.' }`, and the model sees that as an error result. The model decides what to do next, for example by checking whether the page went out.

So Steadfast runs idempotent tools at least once, and other tools at most once.

### Errors and retries

| Failure | What happens |
| --- | --- |
| Model call, retryable (`ModelError` with `retryable: true`: rate limits, overload, timeouts, network) | Journal `attemptFailed`, restart with backoff. When attempts run out, finish with `failed`. |
| Model call, not retryable (a bad request, bad credentials) | Finish with `failed` and the error's message. |
| Idempotent tool throws, or times out | Journal `attemptFailed`, restart with backoff. When attempts run out, journal `toolFinished` with the error, and let the model see it. |
| Tool that isn't idempotent throws | One attempt only: journal `toolFinished` with the error, and let the model see it. |
| Tool that isn't idempotent throws `RetryableToolError` | Treated like an idempotent tool's failure. |
| Tool input fails `parse` | Journal `toolFinished` with the validation error, without running the tool, and let the model see it. |
| The model calls a tool that doesn't exist | Journal `toolFinished` with an error naming the tools that do. |
| Anything else that throws in the run itself (a bug) | Troupe's supervision, as the run's parent chose. The journal is untouched, so a restart recovers. |

A tool's failure goes back to the model, since the model can often work around it. A model's failure ends the run, since nothing else can.

### Budgets

Checked by the run after each event that could exceed them:

- **`maxSteps`:** after a response, if `step` has reached it and the response asks for tools, finish with `stepsExceeded` instead of running them.
- **`maxTokens`:** after a response, if usage has reached it, finish with `tokensExceeded`.
- **`deadlineMs`:** a timer, restarted on recovery for what's left ("Recovery"). When it fires, stop the children and finish with `deadlineExceeded`.
- **`maxAttemptsPerStep`:** counted from journaled `attemptFailed` events, so a crash doesn't reset it.

A finished run's `text` is the last response's text, or a sentence saying which budget ran out.

### The model interface

```ts
export interface Model {
  /** Recorded in runStarted, e.g. 'anthropic:claude-opus-5-5'. */
  readonly name: string;
  call(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export interface ModelRequest {
  readonly system: string;
  readonly transcript: readonly Turn[];
  readonly tools: readonly ToolSpec[]; // name, description, input schema
}

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; response: ModelResponse }
  | { role: 'toolResults'; results: readonly { callId: string; result: ToolResult }[] };

export interface ModelResponse {
  stop: 'endTurn' | 'toolUse' | 'maxOutputTokens' | 'refusal';
  /** The visible text, joined, for the timeline and the outcome. */
  text: string;
  toolCalls: readonly { id: string; name: string; input: JsonValue }[];
  usage: { inputTokens: number; outputTokens: number };
  /** The model that actually answered, which a fallback can change. */
  model: string;
  /** The provider's own content, verbatim. Sent back exactly as it came. */
  raw: JsonValue;
}

export class ModelError extends Error {
  constructor(message: string, opts: { retryable: boolean; retryAfterMs?: number; cause?: unknown });
}
```

- **`raw` is the source of truth for the provider** ([0005](decisions/0005-model-responses-are-journaled-verbatim.md)). An adapter turns the transcript back into the provider's messages from `raw`, never from `text` and `toolCalls`, which are Steadfast's reading of it. Thinking blocks and anything else the provider needs to see again survive unchanged.
- **The transcript only grows.** Turns are appended, never edited, so the provider sees an append-only history, which caching and preserved thinking rely on.
- All tool results of one step go back as one turn, in call order.
- An adapter throws `ModelError` for every failure, so the run never inspects a provider's error types.

### The Anthropic adapter

`@kylewillett/steadfast/anthropic` exports `anthropicModel(options)`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { anthropicModel } from '@kylewillett/steadfast/anthropic';

const model = anthropicModel({ client: new Anthropic() });
```

- **No dependency** ([0004](decisions/0004-built-on-troupe-with-no-other-dependencies.md)). `client` is structurally typed: anything with the SDK's `beta.messages.create` works. `@anthropic-ai/sdk` is an optional peer dependency, and a dev dependency for type tests that prove the real client fits.
- **Defaults:** model `claude-opus-5-5`, `max_tokens` 16,000, non-streaming, `output_config: { effort: 'high' }`, and adaptive thinking (the model's default, so `thinking` is left out). Each is an option.
- **Refusal fallback on by default:** requests go through `client.beta.messages.create` with `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'`, so a request a safety classifier declines is retried on a fallback model in the same call. `fallbacks: false` turns it off. `ModelResponse.model` records which model answered. A response that still ends in `refusal` finishes the run with `refused`.
- **Retries belong to supervision:** each request passes `maxRetries: 0`, so the SDK doesn't retry behind the run's back and every attempt is journaled.
- **Errors:** an error with `status` 408, 409, 429 or 500 and above, or with no status (a connection error), is retryable, and a `retry-after` header becomes `retryAfterMs`. Anything else isn't. The check reads `status` and `headers` structurally, since the adapter never imports the SDK's error classes.
- **Mapping:** a user turn is a user message. An assistant turn is `{ role: 'assistant', content: raw }`. A tool-results turn is one user message of `tool_result` blocks, with `is_error: true` for failures and the output as JSON text. Stop reasons map `end_turn` → `endTurn`, `tool_use` → `toolUse`, `max_tokens` → `maxOutputTokens`, `refusal` → `refusal`. Anything else is a `ModelError` that isn't retryable, until milestone 2 handles it.
- Tool inputs are parsed from the response's `tool_use` blocks as objects, never matched as strings.

### Reading a run back

```ts
import { readRun } from '@kylewillett/steadfast';

const run = await readRun(triage, 'incident-4211');            // the whole run
const early = await readRun(triage, 'incident-4211', { upTo: 5 }); // as it was after event 5
```

- Returns `{ state, events, steps }`, where `steps` groups the events by step: the response, each tool call and its result, and the failed attempts in between.
- It folds the journal through the same `onEvent` the run uses, so what it shows is exactly what a recovering run would see. It never calls the model.
- It's the base for the CLI's `--show`, milestone 3's timeline, and milestone 4's replays.

### The testkit

`@kylewillett/steadfast/testkit`:

```ts
import { createTestKit } from '@kylewillett/troupe/testkit';
import { scriptedModel, faultyModel, say, callTool, rateLimited } from '@kylewillett/steadfast/testkit';

const model = faultyModel(
  scriptedModel([callTool('read_log', { service: 'checkout', lines: 50 }), say('The cause is a bad deploy.')]),
  { step: 1, fail: [rateLimited({ retryAfterMs: 2_000 })] },
);
```

- **`scriptedModel(script)`** answers each call with the next entry: a response built by `say` or `callTool`, or a function of the request. A call past the end of the script throws, so a run that calls the model more than expected fails its test. It records every request for assertions.
- **`faultyModel(inner, faults)`** fails chosen calls with chosen errors before passing the rest to `inner`.
- **Error helpers:** `rateLimited`, `overloaded`, `badRequest`, `timedOut`.
- Everything runs on Troupe's testkit: backoff delays and deadlines pass with `kit.advance(ms)`, and a run is the same from the same seed.
- A test's `clock` is the kit's scheduler, so deadlines are on virtual time too.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T0. Scaffold the repo | Done | 8204533 |
| T1. Models, messages and the scripted model | Done | |
| T2. Tools and the tool-call child | Not started | |
| T3. The run: events, state and the loop | Not started | |
| T4. Recovery and interrupted tools | Not started | |
| T5. Failures, retries and budgets | Not started | |
| T6. The Anthropic adapter | Not started | |
| T7. readRun, the example and the README | Not started | |

### T0. Scaffold the repo

- `package.json`: `"name": "@kylewillett/steadfast"`, `"version": "0.0.0"`, `"private": true` until milestone 3, `"type": "module"`, `"engines": { "node": ">=22.18" }`, and `exports` for `.` and `./testkit`
- `@kylewillett/troupe` as a peer dependency (`^0.2.0`), and a dev dependency
- `.nvmrc` (26), `.gitignore`, `LICENSE` (MIT), Prettier, and ESLint with the `src/` runtime rules
- `tsconfig.json` for the editor and tests, and `tsconfig.build.json` for `src/` with no Node types
- Vitest with coverage, a 90% line threshold on `src/`
- GitHub Actions, on Node 22, 24 and 26: lint, typecheck, test, coverage, build

**Done when:**

- [x] `npm run lint && npm run typecheck && npm test && npm run build` passes on an empty suite, locally.
- [x] The same passes in CI, on Node 22, 24 and 26.

### T1. Models, messages and the scripted model

- `src/json.ts`: `JsonValue` and the check, or Troupe's if it exports them (open question 3)
- `src/model.ts`: `Model`, `ModelRequest`, `ModelResponse`, `Turn`, `ToolSpec`, `ModelError`
- `src/testkit/`: `scriptedModel`, `faultyModel`, `say`, `callTool`, and the error helpers
- `src/globals.d.ts`: `AbortController` and `AbortSignal`, the runtime globals `src/` now uses

**Done when** tests cover:

- [x] `scriptedModel` answers in order, records each request, and throws past the end of its script.
- [x] `faultyModel` fails exactly the calls it was told to, with the errors it was given, and passes the rest through.
- [x] `ModelError` carries `retryable` and `retryAfterMs`, and checks them when it's made.
- [x] Type tests: `say` and `callTool` build valid `ModelResponse`s, and a model's `raw` must be a `JsonValue`.

### T2. Tools and the tool-call child

- `src/tool.ts`: `tool()`, `ToolDef`, `ToolContext`, `RetryableToolError`, and the definition checks
- `src/steps/tool-call.ts`: the child that runs one tool call: `pipeToSelf`, its timeout timer, its abort signal, `parse`, and reporting to its parent

**Done when** tests cover:

- [ ] `tool()` throws on a bad name, a missing description and a bad `timeoutMs`.
- [ ] The child tells its parent the result, then stops. A non-JSON output becomes an error result.
- [ ] A timeout aborts the signal and counts as a retryable failure.
- [ ] `parse` failures become error results, and the tool never runs.
- [ ] An idempotent tool's failure reports `attemptFailed` and throws, so supervision restarts it. A non-idempotent tool's failure doesn't throw. `RetryableToolError` does.
- [ ] The idempotency key is the same on every attempt.

### T3. The run: events, state and the loop

- `src/agent.ts`: `agent()`, `AgentOptions`, `Budget`, and `agent.run(runId, options)`
- `src/run/`: the persistent actor (`onCommand`, the pure `onEvent`, `RunMsg`, `RunEvent`, `RunState`), and the model-call child in `src/steps/model-call.ts`
- The happy path only: start, model, tools in parallel, model, finish, report. T4 adds recovery past a clean start, T5 failures and budgets.

**Done when** tests cover:

- [ ] A run with no tool calls persists `runStarted`, `modelResponded` and `runFinished`, and reports `completed` with the response's text.
- [ ] A step with three tool calls runs them at the same time, journals each result, and sends them to the model as one turn, in call order.
- [ ] The transcript only grows: every request's transcript starts with the previous request's.
- [ ] Each response's `raw` reaches the next request unchanged.
- [ ] `status` replies with the phase, step, usage and what the run is waiting on.
- [ ] A message for a step the run isn't on is ignored.
- [ ] `onEvent` is pure: folding the same events twice gives equal states.
- [ ] `agent()` throws on duplicate tool names and on bad budgets.

### T4. Recovery and interrupted tools

- Recovery on `recoveryCompleted`, for each case in "Recovery"
- Interrupted tools, both kinds
- Spawning a finished run reports at once

**Done when** tests cover:

- [ ] Stopping the system after any event and spawning the run again on the same journal resumes it, and the run ends as it would have with no stop. Checked after every event of a five-step run, with the scripted model's requests compared.
- [ ] An interrupted idempotent tool runs again with the same idempotency key.
- [ ] An interrupted non-idempotent tool doesn't run again, and the model sees the interrupted error.
- [ ] A finished run reports again when it's spawned, and calls nothing.
- [ ] A different `input` on resume is ignored, with a warning.
- [ ] Recovery from a snapshot gives the same state as recovery from every event.

### T5. Failures, retries and budgets

- Every row of "Errors and retries", and every budget
- Cancel

**Done when** tests cover:

- [ ] A rate-limited model call is restarted with backoff, on virtual time, and `retryAfterMs` raises the delay. Each attempt is journaled.
- [ ] Attempts are counted from the journal: a crash between attempts doesn't reset the count.
- [ ] When attempts run out, a model call finishes the run with `failed`, and a tool call becomes an error result.
- [ ] A model error that isn't retryable finishes the run with `failed`.
- [ ] Each budget finishes the run with its outcome. The deadline holds across a restart, measured on the agent's clock.
- [ ] `cancel` finishes the run with `cancelled`, aborts its children's signals, and nothing they report afterwards changes the state.
- [ ] Unknown tools become error results that name the tools that exist.

### T6. The Anthropic adapter

- `src/anthropic/`: the `/anthropic` entry point, `anthropicModel()`, its structural client type, the mapping both ways, and error classification
- `@anthropic-ai/sdk` as an optional peer dependency, and a dev dependency
- `exports` gains `./anthropic`

**Done when** tests cover, with a fake client and no network:

- [ ] A transcript maps to the Messages API shape described in "The Anthropic adapter", including tool results as one user message and assistant turns as `raw`.
- [ ] Each stop reason maps as described, and an unexpected one is a `ModelError` that isn't retryable.
- [ ] Errors are classified by status, and `retry-after` becomes `retryAfterMs`.
- [ ] Requests pass `maxRetries: 0`, the fallback beta and `fallbacks: 'default'` by default, and leave them out when `fallbacks: false`.
- [ ] Type test: `new Anthropic()` from the real SDK fits the structural client type.

### T7. readRun, the example and the README

- `src/read-run.ts`: `readRun()`, and the step grouping
- `examples/incident-triage/`: the demo described under "Outcome", on SQLite in `.steadfast/`, run by Node with type stripping against `dist/`
- `npm run example`, and a CI step that runs it on the scripted model, crash and resume included
- The README: quick start, tools, agents, runs and recovery, budgets, the adapter, the testkit

**Done when:**

- [ ] `readRun` at every sequence number of a recorded run gives the state the run had then, and calls no model.
- [ ] `npm run example` runs to `completed` on the scripted model, and the crash-and-resume path ends the same way as an uninterrupted run.
- [ ] `--show` prints the run's steps from the journal.
- [ ] The README's examples type-check, in a test that compiles them.

## Definition of done

- [ ] T0 to T7 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `coverage` and `build` all pass, locally and in CI.
- [ ] Line coverage is at least 90% for `src/`.
- [ ] There are no runtime dependencies besides the Troupe peer, and the adapter's SDK is an optional peer.
- [ ] `src/` builds with no Node types and imports no Node built-ins.
- [ ] The public API is exported only from the entry points' `index.ts` files.
- [ ] Records 0001 to 0005 are Accepted, each with its evidence.

## Decision records

This milestone sets up records 0001 to 0005 in `docs/decisions/`, all Proposed. The tasks named in each one prove them. If the design changes during implementation, update the matching record in the same commit.

## Open questions

1. **The first provider.** This spec assumes Anthropic's Messages API for the first adapter, since the example and the demo use Claude. Milestone 2 adds a second, to keep `Model` honest.
2. **Awaiting a run.** Callers hear back through `reportTo`, which suits actors. Plain async code would rather `await` a promise. Should there be a helper, such as `runToCompletion(system, agent, runId, input)`, that spawns a small actor to wait? It could come in T7 if the example wants it.
3. **What Troupe exports.** Steadfast needs a JSON value type and its check, and `readRun` needs to read a stream from the journal and fold it. If Troupe's public API doesn't offer these, add them to Troupe (with a decision record there) rather than copying its internals.

   **Status (T1):** Troupe 0.2.0 doesn't export them: `JsonValue`, `isJsonValue` and `jsonProblem` are in its `src/json.ts` but not in any entry point. T1 declares the `JsonValue` type in `src/json.ts`, structurally the same as Troupe's, since types alone need nothing at runtime. T2 needs the check, for tool outputs, so before T2 Troupe should export `JsonValue` and `jsonProblem` from its main entry, with a decision record there and a release. Then `src/json.ts` re-exports them instead.
4. **Long transcripts.** State holds the whole transcript, and snapshots keep recovery quick, but a long run can outgrow the model's context window. Milestone 2's context management needs to fit with the append-only rule: compaction as a new turn, never an edit.
5. **Streaming.** Non-streaming with 16,000 output tokens keeps M1 simple. Long turns at high effort can run for minutes, so milestone 2 should stream, and journal only the final response.
6. **The refusal fallback is on by default.** It's what Anthropic recommends for Claude Opus 5.5. It changes which model may answer and how a declined request is billed, so the adapter's README must say so plainly.
7. **Retrying a tool's failure vs reporting it.** This spec retries idempotent tools before telling the model. For some tools, such as a search that returns nothing, the model would do better hearing at once. Should a tool be able to opt out of retries?
