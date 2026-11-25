// The mapping between Steadfast's model interface and the Messages API, both ways. Pure, so the
// shapes are tested without a client. Assistant turns go back as the provider's own content, never
// rebuilt from Steadfast's reading of it, with only the blocks the API's resend rule leaves out
// removed (decision 0010).

import { jsonProblem, type JsonValue } from '../json.js';
import {
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type ToolCall,
  type Turn,
} from '../model.js';
import type { AnthropicCreateParams, AnthropicMessage, AnthropicMessageParam } from './client.js';

/** The request settings an {@link anthropicModel} fixes when it's made. */
export interface RequestSettings {
  readonly model: string;
  readonly maxTokens: number;
  readonly effort: string;
  readonly thinking?: JsonValue;
  readonly fallbacks: 'default' | false;
  /** Server tools, sent after the agent's own tools exactly as they were given. */
  readonly serverTools: readonly JsonValue[];
}

/** The beta that lets a declined request be retried on a fallback model in the same call. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  end_turn: 'endTurn',
  tool_use: 'toolUse',
  max_tokens: 'maxOutputTokens',
  refusal: 'refusal',
  // A server tool's long turn, stopped to be resumed. The paused content goes back as it is.
  pause_turn: 'paused',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ModelError(`Anthropic: ${message}`, { retryable: false });
}

/** Blocks that go back only when they come after a turn's last `fallback` block. */
const DECLINED_TYPES: ReadonlySet<string> = new Set([
  'thinking',
  'redacted_thinking',
  'connector_text',
  'tool_use',
]);

/** Where the content a response stands by starts: just after its last `fallback` block, or 0. */
function lastFallbackEnd(content: readonly unknown[]): number {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (isObject(block) && block.type === 'fallback') return i + 1;
  }
  return 0;
}

/**
 * An assistant turn's content as the API wants it back. Before the last `fallback` block, the
 * declined model's thinking, connector text and client tool calls are left out, as is a
 * `server_tool_use` with no result, and every other block, the `fallback` block included, stays
 * where it is. See "Continuing the conversation" in Anthropic's refusals and fallback guide. A
 * turn with no fallback goes back as the very array it came as.
 */
export function resendable(content: readonly unknown[]): readonly unknown[] {
  const end = lastFallbackEnd(content);
  if (end === 0) return content;
  const resultIds = new Set<unknown>();
  for (const block of content) {
    if (isObject(block) && 'tool_use_id' in block) resultIds.add(block.tool_use_id);
  }
  const kept = (block: unknown): boolean => {
    if (!isObject(block) || typeof block.type !== 'string') return true;
    if (block.type === 'server_tool_use') return resultIds.has(block.id);
    return !DECLINED_TYPES.has(block.type);
  };
  return [...content.slice(0, end).filter(kept), ...content.slice(end)];
}

/** One turn as a message. All tool results of one step are one user message, in call order. */
function toMessage(turn: Turn): AnthropicMessageParam {
  switch (turn.role) {
    case 'user':
      return { role: 'user', content: turn.text };
    case 'assistant': {
      const { raw } = turn.response;
      // Only a response this adapter made can go back. Anything else would be rewritten to fit.
      if (!Array.isArray(raw)) fail("an assistant turn's raw isn't a list of content blocks");
      return { role: 'assistant', content: resendable(raw) };
    }
    case 'toolResults':
      return {
        role: 'user',
        content: turn.results.map(({ callId, result }) =>
          result.ok
            ? { type: 'tool_result', tool_use_id: callId, content: JSON.stringify(result.output) }
            : { type: 'tool_result', tool_use_id: callId, content: result.error, is_error: true },
        ),
      };
  }
}

/** A Steadfast request as Messages API params. */
export function toParams(request: ModelRequest, settings: RequestSettings): AnthropicCreateParams {
  return {
    model: settings.model,
    max_tokens: settings.maxTokens,
    // The API rejects an empty system text, and an empty one says nothing anyway.
    ...(request.system === '' ? {} : { system: request.system }),
    messages: request.transcript.map(toMessage),
    ...(request.tools.length === 0 && settings.serverTools.length === 0
      ? {}
      : {
          tools: [
            ...request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input,
            })),
            ...settings.serverTools,
          ],
        }),
    output_config: { effort: settings.effort },
    ...(settings.thinking === undefined ? {} : { thinking: settings.thinking }),
    ...(settings.fallbacks === false
      ? {}
      : { betas: [FALLBACK_BETA], fallbacks: settings.fallbacks }),
  };
}

function tokens(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`usage.${field} isn't a non-negative integer`);
  }
  return value;
}

function toolCallOf(block: Record<string, unknown>): ToolCall {
  const { id, name, input } = block;
  if (typeof id !== 'string' || typeof name !== 'string') {
    fail('a tool_use block has no id or name');
  }
  // The input is the parsed object the API sent, never matched as a string: escaping can differ
  // between models.
  if (!isObject(input)) fail(`the input of tool_use "${name}" isn't an object`);
  return { id, name, input: input as JsonValue };
}

/**
 * A Messages API response as a {@link ModelResponse}. `raw` is the content, verbatim. `text` and
 * `toolCalls` are read from the blocks after the last `fallback` block, since a model declined
 * what came before it.
 * @throws ModelError, not retryable, for a stop reason Steadfast doesn't handle yet or content
 *   that isn't JSON.
 */
export function fromMessage(message: AnthropicMessage): ModelResponse {
  const stop = message.stop_reason === null ? undefined : STOP_REASONS[message.stop_reason];
  // stop_sequence and the rest come with features Steadfast doesn't use yet.
  if (stop === undefined) fail(`unexpected stop reason ${JSON.stringify(message.stop_reason)}`);
  const problem = jsonProblem(message.content);
  if (problem !== undefined) fail(`the response's content isn't JSON: ${problem}`);
  const raw = message.content as JsonValue;

  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of message.content.slice(lastFallbackEnd(message.content))) {
    if (!isObject(block)) continue;
    // Joined with nothing between: citations split one sentence across several text blocks.
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block.type === 'tool_use') toolCalls.push(toolCallOf(block));
  }

  const { usage } = message;
  // Cached input is input the model read, so a token budget counts it too.
  const inputTokens =
    tokens(usage.input_tokens, 'input_tokens') +
    tokens(usage.cache_creation_input_tokens, 'cache_creation_input_tokens') +
    tokens(usage.cache_read_input_tokens, 'cache_read_input_tokens');
  const outputTokens = tokens(usage.output_tokens, 'output_tokens');
  return {
    stop,
    text,
    toolCalls,
    usage: { inputTokens, outputTokens },
    model: message.model,
    raw,
  };
}
