// Responses for scripted models. Each is complete when it's built, so a test can compare it with
// what the run journaled. `raw` stands in for a provider's content: a JSON copy of the response,
// so it changes if anything about the response changes, and a run that rewrites it is caught.

import type { JsonValue } from '../json.js';
import type { ModelResponse, ToolCall, Usage } from '../model.js';

/** What every scripted response can set. */
export interface ResponseOptions {
  /** Default `{ inputTokens: 0, outputTokens: 0 }`. */
  readonly usage?: Usage;
  /** The model that answered. Default `'scripted'`. */
  readonly model?: string;
}

/** Options for {@link callTool}. */
export interface CallToolOptions extends ResponseOptions {
  /** The call's id. Default `<name>_1`. */
  readonly id?: string;
  /** Text the model says alongside the call. Default empty. */
  readonly text?: string;
}

/** One call in {@link callTools}. */
export interface ScriptedToolCall {
  readonly name: string;
  readonly input: JsonValue;
  /** Default `<name>_<n>`, where n counts this tool's calls in the response from 1. */
  readonly id?: string;
}

/** Options for {@link callTools}. */
export interface CallToolsOptions extends ResponseOptions {
  /** Text the model says alongside the calls. Default empty. */
  readonly text?: string;
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

function response(
  stop: ModelResponse['stop'],
  text: string,
  toolCalls: readonly ToolCall[],
  options: ResponseOptions,
): ModelResponse {
  const usage = options.usage ?? NO_USAGE;
  return {
    stop,
    text,
    toolCalls,
    usage,
    model: options.model ?? 'scripted',
    raw: {
      scripted: {
        stop,
        text,
        toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
      },
    },
  };
}

/** A response that ends the turn with `text`. */
export function say(text: string, options: ResponseOptions = {}): ModelResponse {
  return response('endTurn', text, [], options);
}

/**
 * A response the provider paused, to be resumed, as Anthropic's `pause_turn` is. The run calls the
 * model again with it at the end of the transcript.
 */
export function pause(text = '', options: ResponseOptions = {}): ModelResponse {
  return response('paused', text, [], options);
}

/** A response that calls one tool. */
export function callTool(
  name: string,
  input: JsonValue,
  options: CallToolOptions = {},
): ModelResponse {
  const call: ScriptedToolCall =
    options.id === undefined ? { name, input } : { name, input, id: options.id };
  return callTools([call], options);
}

/** A response that calls several tools in one step, in the order given. */
export function callTools(
  calls: readonly ScriptedToolCall[],
  options: CallToolsOptions = {},
): ModelResponse {
  if (calls.length === 0) throw new RangeError('callTools: give at least one call');
  const seen = new Map<string, number>();
  const toolCalls = calls.map((c): ToolCall => {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    return { id: c.id ?? `${c.name}_${String(n)}`, name: c.name, input: c.input };
  });
  const ids = new Set(toolCalls.map((c) => c.id));
  if (ids.size !== toolCalls.length) throw new RangeError('callTools: call ids must be unique');
  return response('toolUse', options.text ?? '', toolCalls, options);
}
