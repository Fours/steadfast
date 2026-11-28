# Milestone 2: Agent trees and people

Source: [roadmap](roadmap.md), Milestones → 2.

## Outcome

In one process, you can:

- give an agent a sub-agent as a tool, and watch it hand part of its task to a child run with its own budget, journal and supervision
- mark a tool as needing a person's approval, and see the run wait for a decision, durably, through any number of restarts
- cancel a run and see every run under it finish as `cancelled`, even if the process dies halfway through
- follow a run as it happens, from the first event to the last, including the model's text as it's written
- run the same agent on a second provider with no change but the model

A sub-agent that is interrupted isn't retried or reported as "may or may not have run", as an interrupted tool is. It has a journal of its own, so it resumes from where it was. An approval is a fact in the journal, never a promise in memory, so a restart while waiting loses nothing, and the model isn't asked again.

**Demo at the end:** `npm run example` runs `examples/incident-triage`, extended. The triage agent now hands log reading to a `log-analyst` sub-agent, and `page_oncall` needs a person's approval. The narrated log is built from progress events, so it shows the analyst's steps indented under the step that delegated to it, and with `--model anthropic` the model's text streams as it's written. When the agent wants to page, the terminal asks `Approve page_oncall to payments? [y/n]`. `--approve yes|no` answers for CI. `--crash-while-waiting` kills the process with exit code 137 while the approval is pending. Running it again shows the same request, still waiting, with no new model call. `--cancel-after 2` cancels the run while the analyst is working, and `--show incident-4211` then prints both journals, each ending in `cancelled`. `--model openai` runs the whole thing on the second adapter.

## Scope

In scope:

- Sub-agents: `delegate()`, which makes a tool from an agent, and sub-runs as persistent children of the run, with limits handed down from the parent
- Approvals: `needsApproval` on tools, the run's durable wait, decisions from callers, timeouts, and tags for an approval inbox
- Cancellation that reaches every run in the tree, and is journaled in each
- Progress: every journaled event as it's written, and streamed model text, told to a `progressTo` ref
- Streaming in the `Model` interface and the Anthropic adapter, the refusal fallback on a stream, and `pause_turn`
- A second provider adapter, `@kylewillett/steadfast/openai`, on OpenAI's Responses API
- `startRun()`: an awaitable handle on a run for plain async code (milestone 1's open question 2)
- The example, unit tests, type tests and the README

Out of scope:

| Item | Milestone |
| --- | --- |
| The run view on Backstage, the demo site, the npm release | 3 |
| Recorded runs as fixtures, fault injection from a seed, the eval harness | 4 |
| Runs as sharded entities across nodes | 5 |
| Context management for long runs (compaction, clearing old tool results) | Unassigned (open question 6) |
| Server-side tools beyond passing them through the Anthropic adapter | Unassigned |
| Editing a tool call's input when approving it | Unassigned (open question 3) |

Milestone 1 put context management and server-side tools in milestone 2. This spec takes only `pause_turn`, which any server tool can cause, and leaves the rest. It's a milestone of its own in size, and nothing here blocks it.

Design for later milestones without building them. In particular:

- A run tree can be read back from journals alone, given the root agent: every sub-run's id and agent are derived from its parent's journal and definition. Milestone 3's inspector draws the tree from that.
- Callers reach runs through refs and messages, never shared memory, so a tree can span nodes in milestone 5. Progress and approvals are messages too.
- Progress events carry each run's sequence numbers, so a UI that misses one can fill the gap with `readRun`. That's what milestone 3's live view will do.

## Design

### Sub-agents

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

```ts
export interface DelegateOptions {
  /** The tool's name, as the model sees it. Default: the agent's name, with `-` as `_`. */
  name?: string;
  description: string;
  /** As on a tool. See "Approvals". */
  needsApproval?: boolean | ((input: { task: string }) => boolean);
  approvalTimeoutMs?: number;
}

export function delegate(agent: Agent, options: DelegateOptions): Tool;
```

- **The model sees an ordinary tool**, whose input is `{ task: string }`. The schema is fixed, so the sub-run always gets one string, which becomes its input.
- **A sub-run is a run.** The parent spawns the sub-agent's `run` as a child actor, with its own journal, budget and children. It's supervised with `restartWithBackoff`, as Troupe recommends for persistent actors, so a bug that throws in a sub-run restarts it from its journal.
- **Ids are derived, never chosen.** A sub-run's id is `<parent run id>/<step>.<index>`, where `index` is the call's place in the response. Its stream is `run-<sub-agent name>-<that id>`, and its actor is named `sub-<step>-<call id>`, falling back to `sub-<step>~<index>` like a tool child. Since all three come from the parent's journal and definitions, a recovering parent finds the same sub-run, and `readRun` can find it without asking anyone. A call whose stream id would pass Troupe's 255 characters becomes an error result saying the tree is too deep.
- **It resumes, it isn't retried** ([0006](decisions/0006-a-sub-agent-is-a-child-run-that-resumes.md)). On recovery, a pending delegation is spawned again. If the sub-run's journal has events, it carries on from them. If it had finished, it reports at once. So a sub-run runs exactly once, whatever happens to its parent, and "Interrupted tools" never applies to one.
- **Its report is the tool's result.** The sub-run reports to its parent (`reportTo` is the parent's ref), and the parent journals `toolFinished`. `completed` is `{ ok: true, output: text }`. Any other outcome is `{ ok: false, error: 'The sub-agent stopped: <outcome>. <text>' }`, so the model hears why. Then the parent stops the sub-run's actor.
- **Usage adds up.** `toolFinished` for a delegation carries the sub-run's whole usage, its own sub-runs included. The parent's state keeps `usage` (its own model calls) and `treeUsage` (its own plus every finished sub-run's).
- `delegate()` checks its options when it's called, like `tool()`. An agent can't delegate to itself directly, which `agent()` checks. Indirect cycles are stopped by depth ("Limits handed down").

### Limits handed down

A sub-run can't outlive or outspend its parent. `RunOptions` gains `limits`, and a run journals the limits it started with in `runStarted`, so a restart keeps them:

```ts
export interface RunLimits {
  /** Wall-clock ms, on the agent's clock. The run's deadline is the earlier of this and its own. */
  deadlineAt?: number;
  /** Tokens for the whole tree under this run. The run's budget is the smaller of this and its own. */
  maxTokens?: number;
  /** How many more levels of sub-runs may start under this one. Default: the agent's maxDepth. */
  depthLeft?: number;
}
```

- When a run delegates, it passes down its own deadline, what's left of its `maxTokens` (counting `treeUsage`), and `depthLeft - 1`. A delegation at `depthLeft` 0 becomes an error result, and the model hears that it can't delegate any further.
- `Budget` gains `maxDepth`, default 3. Only the root's counts, since sub-runs inherit `depthLeft`.
- **The parent checks `maxTokens` against `treeUsage`**, after each `toolFinished` from a sub-run as well as after each response. So delegation isn't a way around the budget.
- Sub-runs started in the same step each get what's left when they start, so together they can overshoot it. The parent stops once they report. Open question 4 is whether that's good enough.
- Callers can pass `limits` too, for example to give one run a tighter deadline than its agent's.

### Approvals

```ts
const pageOncall = tool({
  name: 'page_oncall',
  description: 'Page the on-call engineer for a team.',
  input: { /* ... */ },
  needsApproval: true, // or (input) => input.severity === 'sev1'
  approvalTimeoutMs: 30 * 60_000,
  run: async (input, { idempotencyKey }) => pager.page(input, { idempotencyKey }),
});
```

- **`needsApproval`** is `true`, `false` (the default), or a function of the parsed input. A function runs once, when the response arrives, and what it said is journaled, so changing the code later doesn't change past runs. A function that throws counts as `true`, the safe answer. A call whose input fails `parse` is an error result at once, and nobody is asked.
- **Asking is journaled** ([0007](decisions/0007-approvals-are-durable-waits-in-the-journal.md)). In the same write as the `modelResponded` that called the tool, the run journals `approvalRequested`, with its run id, the tool, its input, and `requestedAt` from the agent's clock. Calls in the same step that don't need approval start at once. The step's results still go to the model as one turn, once every call is done.
- **Deciding is a message:**

```ts
type RunMsg =
  // ...milestone 1's messages
  | {
      type: 'decide';
      runId: string;
      callId: string;
      approved: boolean;
      /** Who decided, for the journal. */
      by: string;
      note?: string;
      replyTo?: ActorRef<DecideReply>;
    };

export type DecideReply = { ok: true } | { ok: false; reason: 'notWaiting' | 'unknownRun' };
```

- The run journals `approvalDecided`, with `decidedAt`. If it's approved, the tool call starts. If it's denied, `toolFinished` with `{ ok: false, error: 'A person denied this call. <by>: <note>' }` is in the same write, and the model sees it.
- **Decisions reach sub-runs.** `decide` carries the `runId` it's for, which callers get from the request. A run that isn't the target forwards the message to the sub-run whose id the target starts with, so a caller only ever needs the root's ref. An id with no live run under it replies `unknownRun`.
- **A decision for a call that isn't waiting** (already decided, timed out, or never asked) replies `notWaiting`, and changes nothing. The first decision wins.
- **Timeouts are timers,** restarted on recovery for what's left, measured from `requestedAt` on the agent's clock, exactly as the deadline is. When one fires, the run journals `approvalDecided` with `timedOut: true` and `approved: false`, and a `toolFinished` saying nobody decided in time. No timeout means the run waits until it's cancelled or its deadline passes.
- **The run deadline still runs while waiting.** An agent that waits on people should have a deadline longer than its approval timeouts. Open question 2 is whether waiting should pause it.
- **An approved call is an ordinary tool call** from then on: retries, timeouts, and "Interrupted tools" all apply as before.
- **Recovery** re-arms the timer of every call still waiting, and starts nothing for them.
- **An inbox across runs:** `approvalRequested` and `approvalDecided` events are tagged `steadfast.approval`. An app builds a list of pending approvals across every run and tree with a Troupe projection on that tag, with no polling of runs. The README shows one.
- `status` gains the run's pending approvals and its live sub-runs.

### Cancellation

Milestone 1's `cancel` finishes the run and stops its children. That leaves a sub-run's journal unfinished forever, since nothing will ever resume it. Milestone 2 journals the end in every run of the tree ([0008](decisions/0008-cancellation-is-journaled-in-every-run.md)).

- **`cancel` cascades by message.** When a run finishes for any reason, it stops its tool calls as before, and tells each live sub-run `cancel`, with the reason `The parent run finished: <outcome>`. Each sub-run journals its own `runFinished` with `cancelled`, tells its own sub-runs, reports, and is then stopped by its parent.
- **A finished run reports once its tree has closed.** It watches the sub-runs it's closing, and reports when the last has terminated, so stopping a sub-run never cuts short the sub-runs under it. One that hasn't closed after 30 s is stopped, and the run reports anyway.
- **A finished run cleans up on recovery.** `runFinished` keeps the step's pending call ids in state as `unfinished`. When a finished run recovers, it spawns every unfinished delegation's sub-run in closing mode: it cancels itself as soon as it has recovered, and starts nothing first. One that has already finished reports at once, and is stopped. So a crash between the parent's `runFinished` and a sub-run's can't leave the sub-run open. The cost is a few actors spawned when a finished run is spawned again, which is rare.
- **`cancel` can target a sub-run,** with an optional `runId`, forwarded as `decide` is. Cancelling a sub-run alone finishes it with `cancelled`, and its parent's model sees that as the delegation's error result, and carries on.
- Cancelling ends pending approvals with the run. A `decide` that arrives afterwards replies `notWaiting`.

### Progress

A run tells a `progressTo` ref what's happening ([0009](decisions/0009-progress-is-told-to-a-ref.md)):

```ts
const ref = ctx.spawn(
  triage.run('incident-4211', { input, reportTo: ctx.self, progressTo: ctx.self }),
  'incident-4211',
);

export type RunProgress =
  /** An event, after it's written. Every run in the tree, in journal order per run. */
  | { type: 'journaled'; runId: string; seq: number; event: RunEvent }
  /** Model text as it's generated. Not journaled: the response's text is, when it's whole. */
  | { type: 'text'; runId: string; step: number; attempt: number; text: string }
  /** The run has recovered, at this seq (0 for a new run). Anything earlier comes from readRun. */
  | { type: 'resumed'; runId: string; seq: number };
```

- **`progressTo` is captured by the definition,** like `reportTo`, since refs aren't plain values. A run passes it down to its sub-runs, so one ref hears the whole tree, and `runId` says which run each message is from.
- **`journaled` is exact, and replayable.** The run tells it in `thenRun`, after the write, with the `seq` the journal gave the event. A gap in a run's `seq`s means a message was lost, and `readRun(agent, runId, { upTo })` fills it. On every recovery, the run tells `resumed` first, so a UI knows where it's joining.
- **`text` is a preview,** delivered at most once and never replayed. The model-call child sends it straight to `progressTo`, so streaming never holds up the run's mailbox. `attempt` starts at 1 and goes up when a call is retried, so a UI clears what it showed for the failed attempt.
- `tell` never throws, so a slow or stopped subscriber never slows or breaks a run.

### Streaming

```ts
export interface Model {
  readonly name: string;
  call(request: ModelRequest, options: ModelCallOptions): Promise<ModelResponse>;
}

export interface ModelCallOptions {
  readonly signal: AbortSignal;
  /** Called with each piece of visible text as it's generated. A model that can't stream never calls it. */
  readonly onText?: (text: string) => void;
}
```

- `call`'s second argument becomes an options object. It breaks milestone 1's interface, which is fine before the first release, and leaves room for what comes next.
- Only the final response is journaled. A stream that fails partway is a failed attempt like any other, and the retry starts again from nothing.
- The scripted model streams each response's text a word at a time, with no delay, so tests see `text` progress on virtual time.
- **`paused`** joins `StopReason`. A provider that stops a turn to be resumed (Anthropic's `pause_turn`) returns it, and the run calls the model again with the transcript as it is, adding nothing. It counts as a step, so `maxSteps` bounds a model that keeps pausing.
- **Bad tool input from the model** gets a place of its own. `ToolCall` gains `inputError?: string`, for an adapter that gets arguments it can't parse (OpenAI's arrive as a JSON string). The run journals `toolFinished` with that error, without running the tool, as it does for a failed `parse`.

### The Anthropic adapter

- **Streaming by default,** through `client.beta.messages.stream()`: text deltas go to `onText`, and the response is `finalMessage()`. `max_tokens` goes up to 64,000, since a stream doesn't risk an HTTP timeout. `stream: false` keeps milestone 1's behaviour.
- **`pause_turn`** maps to `paused`, and server tools in `serverTools` are passed through to the request as written. Their blocks come back in `raw`, and go back verbatim.
- **The refusal fallback on a stream.** When a fallback happens mid-output, the declined partial stays in `content`, before a `fallback` block. The API wants the `thinking`, `redacted_thinking` and `tool_use` blocks before the last `fallback` block left out when the turn is sent back, along with any `server_tool_use` without its result, and the `fallback` block kept where it is. That's a rule about what to send, not what happened, so `raw` is still journaled as it came, and the adapter applies the rule when it maps an assistant turn back into a message ([0010](decisions/0010-adapters-apply-their-providers-resend-rules.md), superseding [0005](decisions/0005-model-responses-are-journaled-verbatim.md)). `text` and `toolCalls` are read from the blocks after the last `fallback` block, since those before it were declined.
- The structural client type gains `beta.messages.stream`, typed by the few members the adapter uses: the `text` event, `finalMessage()`, and `abort()`. The type test still proves `new Anthropic()` fits.

### The OpenAI adapter

`@kylewillett/steadfast/openai` exports `openaiModel(options)`, on OpenAI's Responses API. It's there to prove `Model` isn't shaped around Anthropic's API, and the Responses API differs in the ways that matter: output is a list of items rather than one message, tool arguments arrive as a JSON string, results go back as items of their own, and reasoning comes back encrypted.

```ts
import OpenAI from 'openai';
import { openaiModel } from '@kylewillett/steadfast/openai';

const model = openaiModel({ client: new OpenAI(), model: 'gpt-…' });
```

- **No default model.** `model` is required, so the adapter never goes stale behind a caller's back.
- **No dependency,** as for Anthropic ([0004](decisions/0004-built-on-troupe-with-no-other-dependencies.md)): `client` is structurally typed, `openai` is an optional peer dependency and a dev dependency, and a type test proves the real client fits.
- **Options** besides `client` and `model`, as for Anthropic: `stream` (default `true`; `false` sends one plain request), `maxTokens`, sent as `max_output_tokens`, and `effort`, sent as `reasoning.effort`. Both are left out by default, so the model's own defaults apply.
- **Stateless:** requests pass `store: false` and ask for `reasoning.encrypted_content`, so reasoning items can go back in the next request, and the journal, not OpenAI, holds the conversation. The system prompt goes in `instructions`.
- **`raw` is the response's `output` items,** verbatim, and they go back as input items exactly as they came. Tool results go back as `function_call_output` items, paired by the call's `call_id`, not its item `id`, with the output as JSON text. The item has no error flag, so a failure goes back as `{"error": "..."}`.
- **Mapping:** `function_call` items are tool calls, with `arguments` parsed as JSON, or an `inputError` if they aren't JSON or aren't an object. A response with tool calls is `toolUse`. An incomplete response for `max_output_tokens` is `maxOutputTokens`. A refusal content part, or an incomplete response for `content_filter`, is `refusal`. Anything else complete is `endTurn`. Text is the `output_text` parts, joined. Any other incomplete reason (`max_messages`, `steered`) is a `ModelError` that isn't retryable. A `failed` response is a `ModelError`, retryable for `server_error` and `rate_limit_exceeded`. `input_tokens` already counts cached tokens, so nothing is added to it. Tools are sent with `strict: false`, since strict mode needs schemas written for it.
- **Streaming** through `client.responses.create({ stream: true })`, with text deltas to `onText`, and the response from the event that ends the stream (`response.completed`, `response.incomplete` or `response.failed`), as the provider sent it. Not through `responses.stream()`: its final response adds `parsed` and `parsed_arguments` fields the provider never sent, and its params can't be typed structurally ([0011](decisions/0011-the-second-adapter-is-openai-responses.md)).
- **Errors** are classified exactly as for Anthropic: by status, with `retry-after-ms` and `retry-after`. The check moves to a module both adapters share.
- T7 checks every shape here against the SDK's types at the time, and the type test keeps it honest after.

### Awaiting a run

For plain async code, outside an actor:

```ts
import { startRun } from '@kylewillett/steadfast';

const run = startRun(system, triage, 'incident-4211', {
  input: 'Checkout is returning 502s.',
  onProgress: (p) => narrate(p),
});

const report = await run.done; // RunReport
run.cancel('Superseded by incident-4212');
await run.decide({ runId, callId, approved: true, by: 'kyle' }); // DecideReply
```

- `startRun` spawns a small host actor, which spawns the run under it, forwards progress to `onProgress`, and settles `done` with the first report.
- Starting a run that `startRun` is already running in the same system throws, rather than starting a second incarnation on the same journal.
- It's a convenience over the actor API, never a replacement: the example and the README use it, and the tests use both.

### Events and state

`RunEvent` gains:

```ts
| { type: 'approvalRequested'; runId: string; step: number; callId: string; tool: string; input: JsonValue; requestedAt: number; timeoutMs?: number }
| { type: 'approvalDecided'; step: number; callId: string; approved: boolean; by: string; note?: string; decidedAt: number; timedOut?: true }
```

and changes:

- `runStarted` gains `limits`, the ones the run started with.
- `toolFinished` gains `usage`, for a delegation's result.

`RunState` gains `limits`, `treeUsage`, `approvals` (the current step's, by call id: waiting, approved or denied, with `requestedAt`), and `unfinished`. Snapshots go to version 4 (see the notes from T4 and T5). An old journal still folds: `runStarted` without `limits` means none, and `toolFinished` without `usage` adds nothing.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T1. Model calls v2: options, streamed text, `paused`, bad input | Done | 39977ab |
| T2. Progress | Done | e31342e |
| T3. Sub-agents and limits | Done | 5128d09 |
| T4. Approvals | Done | 147f3b8 |
| T5. Cancellation across the tree | Done | 7556953 |
| T6. Streaming and the fallback in the Anthropic adapter | Done | 887c3b9 |
| T7. The OpenAI adapter | Done | |
| T8. startRun, the example and the README | Not started | |

### T1. Model calls v2: options, streamed text, `paused`, bad input

- `Model.call(request, options)`, with `onText`, across `src/`, the testkit and the Anthropic adapter, which doesn't stream yet
- `StopReason` gains `paused`, and the run calls the model again on it. The Anthropic adapter maps `pause_turn` to it
- `ToolCall.inputError`, journaled as an error result without running the tool
- `scriptedModel` streams text a word at a time, and gains `pause()` for a paused response

**Done when** tests cover:

- [x] A model that calls `onText` streams its pieces in order, and the journaled response is the whole one.
- [x] A `paused` response calls the model again with the same transcript plus the response, adding no user turn, and counts as a step against `maxSteps`.
- [x] A tool call with an `inputError` becomes an error result, and the tool never runs.
- [x] `pause_turn` maps to `paused`.
- [x] Type test: a model that ignores `onText` is still a `Model`.

### T2. Progress

- `progressTo` on `RunOptions`, `RunProgress`, and telling it from `thenRun` with each event's `seq`
- The model-call child tells `text` straight to `progressTo`, with its attempt number
- `resumed` on every recovery, including a new run's, at seq 0
- Write [0009](decisions/0009-progress-is-told-to-a-ref.md), Proposed, and add it to the index

**Done when** tests cover:

- [x] Every journaled event reaches `progressTo` once, in order, with the `seq` the journal gave it, including events persisted together in one write.
- [x] `text` pieces arrive before the `journaled` response they belong to, and a retried call's carry the next attempt number.
- [x] After a restart, `resumed` comes first with the recovered `seq`, and `readRun` up to it plus the progress after it gives every event exactly once.
- [x] A stopped `progressTo` doesn't change the run's journal or outcome.

### T3. Sub-agents and limits

- `delegate()`, and its checks. `agent()` refuses an agent that delegates to itself
- Sub-runs as supervised persistent children: derived ids, `reportTo` the parent, the report as `toolFinished` with `usage`, and stopping the sub-run's actor after
- `RunLimits`, journaled in `runStarted`. `Budget.maxDepth`. `treeUsage`, and `maxTokens` checked against it
- `RunMsg` gains `RunReport`, for sub-runs' reports
- `readRun` names each delegation's sub-run, by agent and run id, in its step
- Write [0006](decisions/0006-a-sub-agent-is-a-child-run-that-resumes.md), Proposed, and add it to the index

**Done when** tests cover:

- [x] A delegation starts a sub-run with the task as its input, in its own stream, and its `completed` text is the tool's result. Any other outcome is an error result that names it.
- [x] Two delegations in one step run at the same time, each in its own stream.
- [x] Stopping the system after any event of the parent or the sub-run, and spawning the parent again, resumes both, and the tree ends as it would have with no stop. The sub-run's model calls are never repeated: the scripted models' requests are compared, as in milestone 1's T4.
- [x] A sub-run's deadline is no later than its parent's, its `maxTokens` is no more than what its parent had left, and a delegation with no depth left is an error result.
- [x] The parent's `treeUsage` includes each finished sub-run's usage, and a sub-run that uses up the parent's `maxTokens` finishes the parent with `tokensExceeded`.
- [x] A sub-run that throws is restarted, and recovers from its journal.
- [x] `delegate()` throws on bad options, and `agent()` on an agent that delegates to itself.

Notes from T3:

- An agent's tools are copied when it's made, so it can't hold itself. `agent()` refuses a delegation to an agent of its own name, the nearest thing, since its sub-runs would read as the same agent in every journal.
- `RunReport` and `RunStatus` gain `treeUsage` next to `usage`, rather than changing what `usage` means, and a delegation's `toolFinished` carries the sub-run's `treeUsage`.
- `runStarted` carries `limits` only when the run was given some, as a sub-run always is. Budgets stay unjournaled, as in milestone 1, so a root's `depthLeft` comes from its agent's `maxDepth`.
- `Tool` gains `delegatesTo`, so the tree reads back from the root agent alone. A delegation's `idempotent` and `timeoutMs` don't apply to it.
- Until T5, a parent that finishes for any reason still stops its live sub-runs, as milestone 1 did, which leaves their journals unfinished.

### T4. Approvals

- `needsApproval` and `approvalTimeoutMs` on `tool()` and `delegate()`, checked when they're defined
- `approvalRequested` in the same write as the response, `decide`, `DecideReply`, `approvalDecided`, timeouts, and forwarding to sub-runs
- Re-arming approval timers on recovery
- The `steadfast.approval` tag, and `status`'s pending approvals and sub-runs
- Write [0007](decisions/0007-approvals-are-durable-waits-in-the-journal.md), Proposed

**Done when** tests cover:

- [x] A call that needs approval doesn't start until it's approved, while the step's other calls run, and the step's results still go to the model as one turn.
- [x] A denial becomes an error result with who denied it and their note, and the tool never runs.
- [x] Stopping the system while a call waits, and spawning the run again, keeps waiting: no model call, no tool call, and the same approval in `status`. A decision sent to the new incarnation is honoured.
- [x] A timeout denies the call, measured from `requestedAt` on the agent's clock, across a restart.
- [x] The first decision wins. A second, or one for a call that isn't waiting, replies `notWaiting` and changes nothing.
- [x] A decision sent to the root for a sub-run's call reaches it. One for a run id with nothing under it replies `unknownRun`.
- [x] A `needsApproval` function is called once per call, and its answer is journaled: a run recovered with a different function behaves as it did.
- [x] A projection on `steadfast.approval` sees every request and decision, across two runs.

Notes from T4:

- The model-call child checks approvals, once the model has answered and before it reports, since `parse` may be async and a command can't await. The run never runs user code, and the response arrives with what it needs for one write.
- `approvalRequested` carries `runId`. A projection only sees the stream id, `run-<agent>-<runId>`, which can't be split when agent names contain `-`, and an inbox needs the run id to send `decide`.
- A timeout's `approvalDecided` has `by: 'timeout'`, so `by` stays required.
- A delegation whose `task` isn't a string isn't asked about. It fails as `planSubRun` says, as before.
- `approvalTimeoutMs` on a tool that never needs approval throws, since it can't be what was meant.
- Snapshots are at version 3, not 2: T3 took 2, and `RunState` gained `approvals` here.
- `status` gains `approvals`, the run's own waiting calls, and `subRuns`. `readRun` shows each call's approval, for T8's `--show`.

### T5. Cancellation across the tree

- Finishing tells live sub-runs `cancel` instead of stopping them, and stops each once it reports
- `unfinished` in state, and cancelling unfinished sub-runs when a finished run recovers
- `cancel` with a `runId`, forwarded
- Write [0008](decisions/0008-cancellation-is-journaled-in-every-run.md), Proposed

**Done when** tests cover:

- [x] Cancelling the root of a three-level tree journals `runFinished` with `cancelled` in every run, aborts every tool call's signal, and stops every actor.
- [x] A parent that finishes for another reason, such as its deadline, cancels its sub-runs the same way, and says why.
- [x] Stopping the system after the root's `runFinished` and before a sub-run's, then spawning the root again, finishes the sub-run with `cancelled`. Checked at each level of the tree.
- [x] Cancelling a sub-run alone finishes it with `cancelled`, and its parent's model sees the error result and carries on.
- [x] A cancelled run's pending approvals reply `notWaiting` to any decision.

Notes from T5:

- A finished run reports only once every sub-run it's closing has terminated, so a report means the tree under it has closed. Otherwise the parent stopping a sub-run that had just reported would stop that sub-run's own sub-runs before they journaled. The wait is capped at `CLOSE_TIMEOUT_MS`, 30 s, for a sub-run whose journal is down.
- On recovery, a finished run spawns its unfinished sub-runs in closing mode rather than telling them `cancel` after an ordinary spawn. A sub-run that recovers as `running` would otherwise start its model or tool calls in `onSignal`, before it read the `cancel`. The parent calls `runActor` directly for this, since everything it passes is derived.
- The "finishes for another reason" test uses `tokensExceeded`. A sub-run inherits its parent's deadline, so at the deadline its own timer fires as well, and it ends `deadlineExceeded`.
- A decision for one of a cancelled run's own calls replies `notWaiting`. One for a sub-run that has closed replies `unknownRun`, since no live run in the tree has its id.
- `cancel` for an id with no live run under it changes nothing. It has no reply, as in milestone 1.
- Snapshots are at version 4, since `RunState` gained `unfinished`.
- The README's cancellation section is left for T8.

### T6. Streaming and the fallback in the Anthropic adapter

- `beta.messages.stream()` by default, with `stream: false` to turn it off. `max_tokens` 64,000 when streaming
- `serverTools`, passed through
- The resend rule for a mid-output fallback, in the mapping. `text` and `toolCalls` read after the last `fallback` block
- Check the resend rule against Anthropic's refusals documentation at the time, and cite it in the record
- Write [0010](decisions/0010-adapters-apply-their-providers-resend-rules.md), Accepted with its tests, and mark 0005 Superseded by 0010. Update the "kept verbatim" rule in `AGENTS.md` to match

**Done when** tests cover, with a fake client and no network:

- [x] Text deltas reach `onText` in order, and the response is mapped from `finalMessage()`.
- [x] Aborting the signal aborts the stream.
- [x] A response with a mid-output fallback journals `raw` exactly as it came, and goes back with the blocks the rule leaves out removed, and everything else, the `fallback` block included, in place.
- [x] `text` and `toolCalls` come only from blocks after the last `fallback` block.
- [x] Server tools reach the request as written, and their blocks go back unchanged.
- [x] Type test: `new Anthropic()` still fits the structural client type, `stream` included.

Notes from T6:

- Anthropic's guide also drops `connector_text` before the last `fallback` block, which the design above leaves out. The adapter follows the guide, and [0010](decisions/0010-adapters-apply-their-providers-resend-rules.md) cites it. Blocks the guide doesn't name, such as `mcp_tool_use`, are kept.
- The default `maxTokens` is 64,000 when streaming and 16,000 with `stream: false`. An explicit `maxTokens` wins either way.
- The client must have both `create` and `stream`, at runtime as in its type, whichever mode is used.
- Aborting the signal calls the stream's `abort()`, as well as passing the signal to the client.
- `README.md` now gives the new defaults and links 0010. Its streaming section is still for T8.

### T7. The OpenAI adapter

- `src/openai/`: the `/openai` entry point, `openaiModel()`, its structural client type, the mapping both ways, and streaming
- The shared HTTP error check, moved out of `src/anthropic/`
- `openai` as an optional peer dependency and a dev dependency. `exports` gains `./openai`
- Check every shape in "The OpenAI adapter" against the SDK's current types first, and correct this spec where they differ
- Write [0011](decisions/0011-the-second-adapter-is-openai-responses.md), on why this API and what it proved about `Model`

**Done when** tests cover, with a fake client and no network:

- [x] A transcript maps to Responses API input: the user turn, each response's output items verbatim, and tool results as `function_call_output` items.
- [x] Each kind of response maps to its stop reason as described, and arguments that aren't JSON give an `inputError`.
- [x] Requests pass `store: false`, ask for encrypted reasoning, and pass `maxRetries: 0`.
- [x] Errors are classified by the shared check.
- [x] The run tests from milestone 1's T3 that involve the model pass on an OpenAI-shaped fake client, with the same run and the same checks, in the provider's shapes.
- [x] Type test: `new OpenAI()` fits the structural client type.

Notes from T7:

- Checked against `openai` 7.65.0's types. Where they differed from the design above, it was corrected in place: pairing by `call_id`, cached tokens, `strict`, the `failed` status and the newer incomplete reasons, and streaming through `create`, not `responses.stream()`.
- "Unchanged but for the model" can't hold literally: `test/run/run.test.ts` checks journals that hold the scripted model's `raw` and name. `test/openai/run.test.ts` runs the same T3 runs and checks on `openaiModel`, in the Responses API's shapes. The T3 items that don't touch the model (ignoring a message for another step, `onEvent` purity, `agent()`'s checks) aren't repeated.
- The client needs only `responses.create`, for both modes.
- The shared check is `src/adapter-errors.ts`. Its tests moved to `test/adapter-errors.test.ts`, and the fake API error both adapters' tests throw to `test/fake-api-error.ts`.
- Not proven: that OpenAI accepts its encrypted reasoning items back as sent, with `store: false`. It's documented, but no test here sends a real request. Milestone 4's recorded runs are the place.
- `README.md` doesn't describe the adapter yet. That's in T8.

### T8. startRun, the example and the README

- `startRun()` and its handle
- The example: the `log-analyst` sub-agent, approval for `page_oncall`, narration from progress, and the flags under "Outcome". `npm run example:check` runs every path in CI on the scripted model
- `--show` prints the tree, each sub-run indented under the step that started it
- The README: sub-agents, approvals and an inbox projection, cancellation, progress, streaming, the OpenAI adapter, `startRun`
- Every record from this milestone Accepted with its evidence

**Done when:**

- [ ] `startRun`'s `done` settles with the report, `cancel` cancels, and `decide` replies, in tests on the testkit.
- [ ] `npm run example` runs to `completed` with `--approve yes`, and with `--approve no` the model is told and finishes without paging.
- [ ] `--crash-while-waiting` and a second run end the same way as an uninterrupted run, with no extra model call.
- [ ] `--cancel-after 2` leaves both journals ending in `cancelled`, and `--show` prints them as a tree.
- [ ] The README's examples type-check, in the test that compiles them.

## Definition of done

- [ ] T1 to T8 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `coverage` and `build` all pass, locally and in CI.
- [ ] Line coverage is at least 90% for `src/`.
- [ ] There are no runtime dependencies besides the Troupe peer, and both adapters' SDKs are optional peers.
- [ ] `src/` builds with no Node types and imports no Node built-ins.
- [ ] Records 0006 to 0011 are Accepted, each with its evidence, and 0005 is Superseded by 0010.

## Decision records

This milestone adds:

| # | Decision | Task |
| --- | --- | --- |
| 0006 | A sub-agent is a child run, with its own journal, so an interrupted one resumes rather than retrying or reporting "may have run" | T3 |
| 0007 | Approvals are durable waits: the request and the decision are journaled events, and the wait is derived from state | T4 |
| 0008 | Cancellation is journaled in every run of the tree, and a finished run closes its unfinished sub-runs on recovery | T5 |
| 0009 | Progress is told to a ref captured by the run's definition: journaled events with their `seq`, and streamed text at most once | T2, Accepted in T8 |
| 0010 | Adapters apply their provider's rules for resending a response, and the journal stays verbatim. Supersedes 0005 | T6 |
| 0011 | The second adapter is OpenAI's Responses API, because it differs from Anthropic's where `Model` could have been shaped by it | T7 |

Each task writes its record as Proposed and fills in the evidence as its tests pass. If the design changes during implementation, update the record in the same commit.

## Open questions

1. **Troupe.** Nothing here looks like it needs a change to Troupe: persistent children, `thenRun` with `lastSeq`, tags, projections and keyed timers cover it. If a task finds otherwise, raise it with Troupe before working around it, as milestone 1 did with 0038 and 0041.
2. **Should waiting on people pause the deadline?** Here the deadline is wall-clock time from the start, so an agent that waits a day for approval needs a deadline over a day. Pausing it while every pending call is waiting on a person would match what callers mean by "too long", but makes the deadline harder to explain and test. Decide when the example shows which is less surprising.
3. **Approving with changes.** A person may want to approve a page to a different team. That needs the approved input journaled and used instead of the model's, and the model told what changed. It fits the design, as a field on `approvalDecided`, but isn't in this milestone.
4. **Sub-runs in parallel share what's left of `maxTokens`,** each getting all of it, so together they can overshoot. Splitting it between them would be strict, but starves a sub-run its sibling didn't need. This spec accepts the overshoot, bounded by one step's sub-runs.
5. **Who can decide.** `decide` records `by`, but doesn't check it. Authorisation belongs to the app that sends the message. Should a tool be able to name who may approve it, so the journal can show a decision was allowed?
6. **Context management.** Long runs still outgrow the context window. Anthropic's server-side compaction would fit the append-only transcript, since its blocks come back in `raw`, but a provider-neutral answer needs a design of its own. It needs a milestone, or a place in milestone 4, once the evals can measure it.
7. **Carried from milestone 1: retrying a tool's failure vs reporting it** (milestone 1's open question 7). Still open. Sub-agents make it sharper, since a sub-run's failure is never retried, only reported.
8. **A cancelled sub-run's usage is lost to its parent.** The parent's journal has ended by the time the sub-run reports, so its usage never reaches the parent's `treeUsage`, and the root's report undercounts what the tree spent. Should the report add what its closing sub-runs used, though `readRun` can't show it from the journal?
9. **A streamed preview of declined text.** When a fallback happens mid-output, the declined model's partial text has already reached `onText` before the `fallback` block arrives, so a UI shows text the response then sets aside. `attempt` doesn't help, since it's the same attempt. A progress signal that tells a UI to clear the preview, sent when a `fallback` block starts, would fix it, but needs the adapter to report more than text through `onText`.
