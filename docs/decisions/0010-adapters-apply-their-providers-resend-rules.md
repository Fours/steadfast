# 0010. Adapters apply their provider's rules for resending a response, and the journal stays verbatim

- **Status:** Accepted
- **Date:** 2026-11-25
- **Milestone:** 2
- **Supersedes:** [0005](0005-model-responses-are-journaled-verbatim.md)

## Context

[0005](0005-model-responses-are-journaled-verbatim.md) made two promises: each response is journaled exactly as it came, and it goes back to the provider exactly as it came. Anthropic's refusal fallback breaks the second one. When a safety classifier declines a streamed request partway through its output, the API hands over to a fallback model in the same response, and marks the hop with a `fallback` content block. The declined model's partial output stays in `content`, before that block. The API doesn't accept everything from before the block when the turn goes back, so sending the content as it came fails, or gives the next model the declined reasoning.

Anthropic's [refusals and fallback guide](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback#continuing-the-conversation), "Continuing the conversation" (read 2026-11-25), says what to send back:

| Block | Rule |
| --- | --- |
| `fallback` | Keep it exactly where it appeared |
| `text` | Keep |
| Anything after the final `fallback` block | Keep |
| `thinking`, `redacted_thinking` or `connector_text` before the final `fallback` block | Drop |
| Client `tool_use` before the final `fallback` block | Drop |
| `server_tool_use` before the final `fallback` block | Keep it with its result, drop it without one |

The SDK's type for a resent `fallback` block (`BetaFallbackBlockParam` in `@anthropic-ai/sdk` 1.14.0) adds that no `tool_result` is sent for a `tool_use` that was left out.

## Decision

The journal keeps every response exactly as it came: `raw` is still the provider's content, verbatim, and replay never calls the model. What changes is the way back. An adapter rebuilds each assistant turn from `raw`, as before, and applies its provider's documented rules for resending a response as it does. It applies only those rules, written in one pure function (`resendable` in `src/anthropic/mapping.ts`), and leaves every other block where it is, unchanged.

- **What's sent is derived, not journaled.** The rule runs every time a request is built, so a journal written before the rule changes still works with the new rule, and the journal never holds a rewritten response.
- **Steadfast's reading follows the same boundary.** `text` and `toolCalls` come from the blocks after the last `fallback` block, since a model declined what came before it. So the run never runs a tool call the next request leaves out, and never needs a `tool_result` for one.
- **A turn with no `fallback` block goes back as the very array it came as.** Only a turn the rule applies to is copied.
- Blocks the guide doesn't name, such as `mcp_tool_use`, are kept. Keeping them is the reading closest to "verbatim", and the record should change if the guide comes to name them.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Journal the response with the declined blocks already removed | Loses what happened: the declined partial, and where the hop was. Replay and evals in milestone 4 need it, and a journal can't be corrected once a rule changes. |
| Keep 0005 as it is, and turn fallbacks off by default | The fallback is how a declined request still gets an answer, and the rule only matters when it happens mid-output. Turning off a feature to keep a promise the provider doesn't ask for is the wrong trade. |
| Let the run filter blocks, with a provider-neutral rule | Only the adapter knows its provider's blocks. A neutral rule would either be Anthropic's under another name, or a second place to keep in step. |
| Read `text` and `toolCalls` from all the content | The declined model's text and tool calls would reach the report and the tools, though the API drops them from the conversation. |

## Evidence

In `test/anthropic/`, with a fake client and no network (T6, 2026-11-25):

- `mapping.test.ts`, "a response with a fallback": a response with a declined thinking block, redacted thinking, connector text, text, a server tool use with its result, one without, and a client tool use, then a `fallback` block and the fallback model's thinking, text and tool use. `raw` equals the content exactly. Sent back, it loses exactly the declined thinking, redacted thinking, connector text, unpaired server tool use and client tool use, and everything else stays in order, the `fallback` block included. With two `fallback` blocks, only blocks before the last one are filtered, and both blocks stay. `text` and `toolCalls` come only from after the last `fallback` block.
- `mapping.test.ts`: a turn with no `fallback` block goes back as the very `raw` array the response kept, and server tool blocks go back unchanged.
- `model.test.ts`, "a run on anthropicModel, with a mid-output fallback": a two-step run journals the first response's `raw` exactly as the stream's final message had it, reports the fallback model's text, and sends the second request the turn with the declined thinking removed and the declined text and `fallback` block in place.

Each was checked by breaking the rule: filtering after the last `fallback` block as well, reading text from all the content, and sending `raw` unfiltered each fail a test.

## Consequences

- The journal stays a faithful record, and the requests built from it can follow a provider's rules as they change. A rule change is a code change in the adapter, never a migration.
- An adapter is no longer a pure passthrough of `raw`, so each adapter must cite its provider's rule where it filters, and test it. The OpenAI adapter in T7 has no such rule yet, and sends its items back as they came.
- A streamed preview isn't covered: the declined partial text has already reached `onText` by the time the `fallback` block arrives. A UI shows text the run then sets aside (milestone 2's open question 9).
- Everything else 0005 decided still holds: replay never calls the model, the transcript only grows, and the journal is as sensitive as the conversation.
