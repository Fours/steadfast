// `openaiModel()`: a Model over the user's OpenAI client, on the Responses API. It sends one
// request per call, streamed by default, with the SDK's own retries off so supervision makes and
// journals every attempt, and turns every failure into a ModelError.

import { toModelError } from '../adapter-errors.js';
import { ModelError, type Model, type ModelCallOptions } from '../model.js';
import type {
  OpenAIClient,
  OpenAICreateParams,
  OpenAIRequestOptions,
  OpenAIResponse,
  OpenAIStreamEvent,
} from './client.js';
import { fromResponse, isResponse, toParams, type RequestSettings } from './mapping.js';

/** How hard a reasoning model thinks, from least to most. */
export type OpenAIEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** What {@link openaiModel} takes. */
export interface OpenAIModelOptions {
  /** Anything with the SDK's `responses.create`, such as `new OpenAI()`. */
  readonly client: OpenAIClient;
  /**
   * The model, such as `'gpt-5.6'`. Required: there's no default, so the adapter never goes stale
   * behind a caller's back.
   */
  readonly model: string;
  /**
   * `true` (the default) streams each response, so its text reaches `onText` as it's written.
   * `false` sends one request and waits for the whole response.
   */
  readonly stream?: boolean;
  /** The most output tokens per response, a positive integer, sent as `max_output_tokens`. Left out by default. */
  readonly maxTokens?: number;
  /** Sent as `reasoning.effort`. Left out by default, so the model's own default applies. */
  readonly effort?: OpenAIEffort;
}

const KEYS = new Set(['client', 'model', 'stream', 'maxTokens', 'effort']);
const EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
/** The events that end a stream, each carrying the response as it ended. */
const TERMINAL: ReadonlySet<string> = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
]);
const WHERE = 'openaiModel';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describe(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return value === null ? 'null' : typeof value;
}

interface Checked {
  readonly client: OpenAIClient;
  readonly stream: boolean;
  readonly settings: RequestSettings;
}

/** Checks the options now, so a bad one fails where it's written. */
function settingsOf(raw: unknown): Checked {
  // The options' type can't stop untyped callers, or values built at runtime.
  if (!isObject(raw)) throw new TypeError(`${WHERE}: give an options object`);
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) throw new TypeError(`${WHERE}: unknown option "${key}"`);
  }
  const { client, model, stream = true, maxTokens, effort } = raw;
  if (
    !isObject(client) ||
    !isObject(client.responses) ||
    typeof client.responses.create !== 'function'
  ) {
    throw new TypeError(`${WHERE}: client must have responses.create, as new OpenAI() does`);
  }
  if (typeof model !== 'string' || model === '') {
    throw new TypeError(`${WHERE}: model must be a non-empty string, got ${describe(model)}`);
  }
  if (typeof stream !== 'boolean') {
    throw new TypeError(`${WHERE}: stream must be a boolean, got ${describe(stream)}`);
  }
  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)
  ) {
    throw new RangeError(
      `${WHERE}: maxTokens must be a positive integer, got ${describe(maxTokens)}`,
    );
  }
  if (effort !== undefined && (typeof effort !== 'string' || !EFFORTS.has(effort))) {
    throw new TypeError(
      `${WHERE}: effort must be one of ${[...EFFORTS].join(', ')}, got ${describe(effort)}`,
    );
  }
  return {
    client: client as unknown as OpenAIClient,
    stream,
    settings: {
      model,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(effort === undefined ? {} : { effort }),
    },
  };
}

/** A text delta's text, or undefined for any other event. */
function deltaOf(event: OpenAIStreamEvent): string | undefined {
  if (event.type !== 'response.output_text.delta') return undefined;
  const { delta } = event as { readonly delta?: unknown };
  return typeof delta === 'string' ? delta : undefined;
}

/** The response a terminal event carries, checked, since the event is only typed by its `type`. */
function responseOf(event: OpenAIStreamEvent): OpenAIResponse {
  const { response } = event as { readonly response?: unknown };
  if (!isResponse(response)) {
    throw new ModelError(`OpenAI: a ${event.type} event has no response`, { retryable: false });
  }
  return response;
}

/**
 * One streamed request: text deltas to `onText`, and the response from the event that ends the
 * stream, as the provider sent it. Aborting the signal aborts the stream too, whether or not the
 * client heeds the signal it was passed.
 */
async function streamed(
  client: OpenAIClient,
  params: OpenAICreateParams,
  options: OpenAIRequestOptions,
  onText: ModelCallOptions['onText'],
): Promise<OpenAIResponse> {
  const events = await client.responses.create({ ...params, stream: true }, options);
  const abort = () => {
    events.controller.abort();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal.aborted) events.controller.abort();
    let final: OpenAIResponse | undefined;
    for await (const event of events) {
      const delta = deltaOf(event);
      if (delta !== undefined) onText?.(delta);
      else if (TERMINAL.has(event.type)) final = responseOf(event);
    }
    if (final === undefined) {
      // Retryable: a stream cut off before it ended is a connection failure, not a bad request.
      throw new ModelError('OpenAI: the stream ended without a response', { retryable: true });
    }
    return final;
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
}

/**
 * A {@link Model} over OpenAI's Responses API, named `openai:<model>`. Requests are stateless:
 * `store: false`, with reasoning asked for encrypted so it can go back in the next request, and
 * the journal, not OpenAI, holds the conversation.
 *
 * ```ts
 * import OpenAI from 'openai';
 * const model = openaiModel({ client: new OpenAI(), model: 'gpt-5.6' });
 * ```
 *
 * @throws TypeError for a missing client or model, unknown keys or a bad option.
 * @throws RangeError for a `maxTokens` that isn't a positive integer.
 */
export function openaiModel(options: OpenAIModelOptions): Model {
  const { client, stream, settings } = settingsOf(options);
  return Object.freeze({
    name: `openai:${settings.model}`,
    async call(request, { signal, onText }) {
      const params = toParams(request, settings);
      const requestOptions = { maxRetries: 0, signal };
      let response;
      try {
        response = stream
          ? await streamed(client, params, requestOptions, onText)
          : await client.responses.create(params, requestOptions);
      } catch (error) {
        throw toModelError(error);
      }
      return fromResponse(response);
    },
  } satisfies Model);
}
