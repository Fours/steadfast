# 0011. The second adapter is OpenAI's Responses API, because it differs from Anthropic's where `Model` could have been shaped by it

- **Status:** Accepted
- **Date:** 2026-11-27
- **Milestone:** 2

## Context

`Model` was designed alongside one adapter, Anthropic's, so nothing showed whether it was provider-neutral or just Anthropic's Messages API under other names. A second adapter is the test, but only if it differs where it matters. It should differ in how output is shaped, how tool calls and their results travel, how reasoning comes back, and where the conversation lives. If `Model`, `ModelResponse` or the journal have to bend to fit it, they were shaped by the first provider.

## Decision

`@kylewillett/steadfast/openai` exports `openaiModel()`, on OpenAI's Responses API, with the SDK's client typed structurally and `openai` as an optional peer dependency ([0004](0004-built-on-troupe-with-no-other-dependencies.md)).

- **Stateless.** Every request sends `store: false` and `include: ['reasoning.encrypted_content']`, so reasoning items come back in a form that can be sent again. The journal holds the conversation, not OpenAI, as [0001](0001-a-run-is-a-persistent-actor.md) requires, and replay never depends on what OpenAI keeps.
- **`raw` is the response's `output` items, verbatim,** and they go back as input items exactly as they came. OpenAI documents no rule for resending them, so under [0010](0010-adapters-apply-their-providers-resend-rules.md) the adapter applies none. Tool results go back as `function_call_output` items, paired by `call_id` (not the item's `id`), with the output as JSON text. The item has no error flag, so a failure goes back as `{"error": "..."}`.
- **Arguments arrive as a JSON string.** Text that isn't JSON, or JSON that isn't an object, gives `ToolCall.inputError` with the arguments as they came, and the run reports it without running the tool (milestone 2's T1).
- **Streaming goes through `responses.create({ stream: true })`, not the SDK's `responses.stream()` helper.** The response comes from the event that ends the stream, `response.completed`, `response.incomplete` or `response.failed`, as the provider sent it. The helper's `finalResponse()` isn't that: in `openai` 7.65.0 it adds `parsed: null` to every `output_text` part and `parsed_arguments: null` to every `function_call` item, so journaling it would store, and send back, fields the provider never sent. The helper's params are also generic over the SDK's own input types (`Params extends ResponseStreamParams`), which no structural type can fit without importing them.
- **Mapping.** A `failed` response is a `ModelError`, retryable only for `server_error` and `rate_limit_exceeded`. An incomplete response is `maxOutputTokens` for `max_output_tokens` and `refusal` for `content_filter`. Other reasons, such as `max_messages` and `steered`, come with features Steadfast doesn't use, and are errors that aren't retryable. A complete response is `refusal` if it has a refusal part, `toolUse` if it has tool calls, and `endTurn` otherwise. `input_tokens` already includes cached tokens, so unlike Anthropic's usage nothing is added to it.
- **Errors** go through one check both adapters share (`src/adapter-errors.ts`), since both SDKs put `status` and `headers` on their errors and read the same retry headers.
- **No default model.** `model` is required, so the adapter never goes stale behind a caller's back. Tools are sent with `strict: false`, since strict mode needs schemas written for it, and a tool's own `parse` checks its input.

### What it proved about `Model`

Nothing in `Model`, `ModelResponse`, `Turn` or the journal changed for this adapter. Every difference lands in the adapter:

| Responses API | Anthropic's Messages API | Where it's absorbed |
| --- | --- | --- |
| Output is a list of items, reasoning items among them | One message of content blocks | `raw` is `JsonValue`, so it holds either as it came |
| Arguments are a JSON string | Input is a parsed object | `inputError`, added in T1 for this |
| Each tool result is an input item of its own | All results are one user message | The adapter maps one `toolResults` turn either way |
| Reasoning is encrypted, and only returned when asked | Thinking blocks carry signatures | Both go back inside `raw` |
| The conversation can live on the server | The conversation is always resent | `store: false`, so it's always resent |
| Cached tokens are counted in `input_tokens` | Cached tokens are counted apart | Each adapter reports total input tokens |

The one change to `Model` that a second provider needed, a place for arguments that can't be parsed, was made in T1 when the design was written, before either adapter was built against it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Chat Completions | Shaped much like Anthropic's messages: one assistant message with tool calls inside, and results as `tool` messages. It would prove less, and reasoning doesn't come back through it, so a reasoning model's turn can't go back whole. |
| The Responses API with `store: true` and `previous_response_id` | The conversation would live at OpenAI, so the journal wouldn't be the run. Replay and recovery would depend on OpenAI's retention, and a restarted run couldn't rebuild its request from its own journal. |
| The SDK's `responses.stream()` helper | It adds `parsed` and `parsed_arguments` fields to the output items, and its generic params can't be typed structurally. Stripping the fields again would mean relying on which fields a given SDK version adds. |
| A third provider, such as Gemini | Its differences from Anthropic are fewer at the level `Model` works at: contents of parts, with function calls and responses as parts. The Responses API differs on more of the axes above. |

## Evidence

In `test/openai/`, with a fake client and no network, on `openai` 7.65.0's types (T7, 2026-11-27):

- `run.test.ts`: milestone 1's T3 run tests that involve the model pass on `openaiModel` over the fake client, with nothing changed in the run. A run with no tool calls journals `runStarted`, `modelResponded` and `runFinished`. Three tool calls run at the same time, and their results go back as `function_call_output` items in call order. Over five steps the input only grows, every output item, reasoning included, reaches the next request as the very object that came, and the journal's `raw` equals each response's output. Usage sums, the system prompt and tool specs go with every request, and `status` replies as it does on the scripted model. Arguments that aren't JSON are reported to the model without running the tool.
- `mapping.test.ts`: the transcript maps to input items, and each kind of response maps to its stop reason as above. Arguments that aren't JSON, or that aren't an object, give an `inputError`. Cached tokens aren't added, and a `failed` response is retryable only for its two codes.
- `model.test.ts`: requests pass `store: false`, `include: ['reasoning.encrypted_content']` and `maxRetries: 0`. Text deltas reach `onText` in order, and `raw` is the ending event's output, not the in-progress response before it. Aborting the signal aborts the stream, and errors are classified by the shared check, streamed or not.
- `types.test.ts`: `new OpenAI()` fits the structural client type, and so do the SDK's `Response` and its stream of events. Every `effort` the adapter takes is one the SDK sends.

Each was checked by breaking it, and each break failed a test: dropping reasoning items on resend, sending `store: true`, leaving out `include`, turning the SDK's retries on, pairing results by the item's `id`, returning no `inputError`, taking the first event that carries a response, unwiring the abort, ignoring refusal parts or `content_filter`, sending a tool's output as anything but JSON, and making the shared check retry everything.

## Consequences

- `Model` has been shown to fit two providers that differ on output shape, arguments, results, reasoning and state. A third adapter should need nothing new from it, and if it does, that's a design change to record.
- The fake client follows the SDK's types, not recorded traffic. That requests with encrypted reasoning items and `store: false` are accepted as sent is OpenAI's documented behaviour, but no test here has sent one. Milestone 4's recorded runs are where to prove it.
- An `error` event in a stream reaches the adapter as the SDK's `APIError` with no status, which the shared check treats as retryable, as it does a connection failure.
- Refusal text isn't streamed to `onText`, only `output_text` deltas are, and OpenAI's hosted tools aren't passed through. Neither is in this milestone.
