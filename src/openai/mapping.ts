// The mapping between Steadfast's model interface and OpenAI's Responses API, both ways. Pure, so
// the shapes are tested without a client. A response's output items go back as input items exactly
// as they came: the Responses API takes its own output as input, reasoning included, so long as
// it was asked for encrypted reasoning, and it documents no rule for resending them otherwise
// (decision 0010).

import { jsonProblem, type JsonValue } from '../json.js';
import {
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type ToolCall,
  type ToolResult,
  type Turn,
} from '../model.js';
import type { OpenAICreateParams, OpenAIResponse } from './client.js';

/** The request settings an {@link openaiModel} fixes when it's made. */
export interface RequestSettings {
  readonly model: string;
  readonly maxTokens?: number;
  readonly effort?: string;
}

/** What every request includes, so reasoning items come back in a form that can be sent again. */
export const INCLUDE = ['reasoning.encrypted_content'] as const;

/** Failure codes of a `failed` response that may succeed if the same request is tried again. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['server_error', 'rate_limit_exceeded']);

const INCOMPLETE: Readonly<Record<string, StopReason>> = {
  max_output_tokens: 'maxOutputTokens',
  content_filter: 'refusal',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, retryable = false): never {
  throw new ModelError(`OpenAI: ${message}`, { retryable });
}

/** A tool result's output, as the JSON text a `function_call_output` item carries. */
function outputOf(result: ToolResult): string {
  // The item has no error flag, so a failure is told as an object the model can read as one.
  return JSON.stringify(result.ok ? result.output : { error: result.error });
}

/** One turn as input items. A step's tool results are one item each, in call order. */
function toItems(turn: Turn): readonly unknown[] {
  switch (turn.role) {
    case 'user':
      return [{ role: 'user', content: turn.text }];
    case 'assistant': {
      const { raw } = turn.response;
      // Only a response this adapter made can go back. Anything else would be rewritten to fit.
      if (!Array.isArray(raw)) fail("an assistant turn's raw isn't a list of output items");
      return raw;
    }
    case 'toolResults':
      return turn.results.map(({ callId, result }) => ({
        type: 'function_call_output',
        call_id: callId,
        output: outputOf(result),
      }));
  }
}

/** A Steadfast request as Responses API params. */
export function toParams(request: ModelRequest, settings: RequestSettings): OpenAICreateParams {
  return {
    model: settings.model,
    // An empty system text says nothing, so it's left out, as the Anthropic adapter does.
    ...(request.system === '' ? {} : { instructions: request.system }),
    input: request.transcript.flatMap(toItems),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.input,
            // Strict mode needs every property required and no others allowed, which a tool's
            // schema needn't say. The tool's own parse checks the input instead.
            strict: false,
          })),
        }),
    store: false,
    include: [...INCLUDE],
    ...(settings.maxTokens === undefined ? {} : { max_output_tokens: settings.maxTokens }),
    ...(settings.effort === undefined ? {} : { reasoning: { effort: settings.effort } }),
  };
}

function tokens(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`usage.${field} isn't a non-negative integer`);
  }
  return value;
}

/** A `function_call` item as a tool call. Arguments that can't be read give an `inputError`. */
function toolCallOf(item: Record<string, unknown>): ToolCall {
  // `call_id` pairs the call with its `function_call_output`. The item's `id` is the item's own.
  const { call_id: id, name, arguments: args } = item;
  if (typeof id !== 'string' || typeof name !== 'string') {
    fail('a function_call item has no call_id or name');
  }
  if (typeof args !== 'string') fail(`the arguments of function_call "${name}" aren't a string`);
  let input: unknown;
  try {
    input = JSON.parse(args);
  } catch {
    return { id, name, input: args, inputError: "The arguments aren't valid JSON." };
  }
  if (!isObject(input)) {
    return { id, name, input: args, inputError: "The arguments aren't a JSON object." };
  }
  return { id, name, input: input as JsonValue };
}

/** Whether a value has the fields of a response the adapter reads, for one read from a stream. */
export function isResponse(value: unknown): value is OpenAIResponse {
  return isObject(value) && Array.isArray(value.output) && typeof value.model === 'string';
}

/**
 * A Responses API response as a {@link ModelResponse}. `raw` is the output items, verbatim.
 * @throws ModelError for a `failed` response, retryable for a server error or a rate limit, and
 *   not retryable for an incomplete reason or status Steadfast doesn't handle, or output that
 *   isn't JSON.
 */
export function fromResponse(response: OpenAIResponse): ModelResponse {
  const status = response.status ?? (response.incomplete_details ? 'incomplete' : 'completed');
  if (status === 'failed') {
    const code = response.error?.code ?? 'unknown';
    fail(
      `the response failed (${code}): ${response.error?.message ?? 'no message'}`,
      RETRYABLE_CODES.has(code),
    );
  }
  if (status !== 'completed' && status !== 'incomplete') {
    fail(`unexpected status ${JSON.stringify(status)}`);
  }
  const problem = jsonProblem(response.output);
  if (problem !== undefined) fail(`the response's output isn't JSON: ${problem}`);
  const raw = response.output as JsonValue;

  let text = '';
  let refused = false;
  const toolCalls: ToolCall[] = [];
  for (const item of response.output) {
    if (!isObject(item)) continue;
    if (item.type === 'function_call') toolCalls.push(toolCallOf(item));
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as unknown[]) {
      if (!isObject(part)) continue;
      if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
      if (part.type === 'refusal') refused = true;
    }
  }

  let stop: StopReason | undefined;
  if (status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    stop = reason === undefined ? undefined : INCOMPLETE[reason];
    // max_messages and steered come with features Steadfast doesn't use.
    if (stop === undefined) fail(`unexpected incomplete reason ${JSON.stringify(reason ?? null)}`);
  } else if (refused) {
    stop = 'refusal';
  } else {
    stop = toolCalls.length > 0 ? 'toolUse' : 'endTurn';
  }

  const { usage } = response;
  return {
    stop,
    text,
    toolCalls,
    // `input_tokens` already counts cached input, so nothing is added to it.
    usage: {
      inputTokens: tokens(usage?.input_tokens, 'input_tokens'),
      outputTokens: tokens(usage?.output_tokens, 'output_tokens'),
    },
    model: response.model,
    raw,
  };
}
