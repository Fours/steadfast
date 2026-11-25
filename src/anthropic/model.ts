// `anthropicModel()`: a Model over the user's Anthropic client. It sends one request per call,
// streamed by default, with the SDK's own retries off so supervision makes and journals every
// attempt, and turns every failure into a ModelError.

import { jsonProblem, type JsonValue } from '../json.js';
import type { Model, ModelCallOptions } from '../model.js';
import type { AnthropicClient, AnthropicCreateParams, AnthropicRequestOptions } from './client.js';
import { toModelError } from './errors.js';
import { fromMessage, toParams, type RequestSettings } from './mapping.js';

/** How hard the model thinks and how many tokens it spends, from least to most. */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A thinking configuration, sent as it is, such as `{ type: 'adaptive', display: 'summarized' }`. */
export type AnthropicThinking = { readonly type: string } & { readonly [key: string]: JsonValue };

/** What {@link anthropicModel} takes. */
export interface AnthropicModelOptions {
  /** Anything with the SDK's `beta.messages.create` and `beta.messages.stream`, such as `new Anthropic()`. */
  readonly client: AnthropicClient;
  /** Default `'claude-opus-5-5'`. */
  readonly model?: string;
  /**
   * `true` (the default) streams each response through `beta.messages.stream()`, so its text
   * reaches `onText` as it's written. `false` sends one `beta.messages.create()` request.
   */
  readonly stream?: boolean;
  /**
   * The most output tokens per response, a positive integer. Default 64,000 when streaming, which
   * can't hit an HTTP timeout, and 16,000 when not.
   */
  readonly maxTokens?: number;
  /** Sent as `output_config.effort`. Default `'high'`. */
  readonly effort?: AnthropicEffort;
  /** Left out by default, so the model's own default applies: adaptive, on current models. */
  readonly thinking?: AnthropicThinking;
  /**
   * `'default'` (the default) retries a request a safety classifier declines on a fallback model,
   * in the same call, through the `server-side-fallback-2026-07-01` beta. This changes which model
   * may answer, recorded in each response's `model`, and how a declined request is billed.
   * `false` turns it off.
   */
  readonly fallbacks?: 'default' | false;
  /**
   * Anthropic's server tools, such as `{ type: 'web_search_20260209', name: 'web_search' }`, sent
   * in `tools` exactly as written. Their blocks come back in each response's `raw` and go back
   * unchanged. Each is a JSON object with a string `type`.
   */
  readonly serverTools?: readonly AnthropicServerTool[];
}

/** A server tool's definition, sent as it is. */
export type AnthropicServerTool = { readonly type: string } & { readonly [key: string]: JsonValue };

const KEYS = new Set([
  'client',
  'model',
  'stream',
  'maxTokens',
  'effort',
  'thinking',
  'fallbacks',
  'serverTools',
]);
const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const WHERE = 'anthropicModel';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describe(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return value === null ? 'null' : typeof value;
}

/** A JSON object with a string `type`, as thinking settings and server tools are. */
function isTyped(value: unknown): boolean {
  return isObject(value) && typeof value.type === 'string' && jsonProblem(value) === undefined;
}

interface Checked {
  readonly client: AnthropicClient;
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
  const { client } = raw;
  if (
    !isObject(client) ||
    !isObject(client.beta) ||
    !isObject(client.beta.messages) ||
    typeof client.beta.messages.create !== 'function' ||
    typeof client.beta.messages.stream !== 'function'
  ) {
    throw new TypeError(
      `${WHERE}: client must have beta.messages.create and beta.messages.stream, as new Anthropic() does`,
    );
  }
  const { stream = true } = raw;
  if (typeof stream !== 'boolean') {
    throw new TypeError(`${WHERE}: stream must be a boolean, got ${describe(stream)}`);
  }
  const {
    model = 'claude-opus-5-5',
    maxTokens = stream ? 64_000 : 16_000,
    effort = 'high',
    thinking,
    serverTools = [],
  } = raw;
  const fallbacks = raw.fallbacks ?? 'default';
  if (typeof model !== 'string' || model === '') {
    throw new TypeError(`${WHERE}: model must be a non-empty string, got ${describe(model)}`);
  }
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new RangeError(
      `${WHERE}: maxTokens must be a positive integer, got ${describe(maxTokens)}`,
    );
  }
  if (typeof effort !== 'string' || !EFFORTS.has(effort)) {
    throw new TypeError(
      `${WHERE}: effort must be one of ${[...EFFORTS].join(', ')}, got ${describe(effort)}`,
    );
  }
  if (thinking !== undefined && !isTyped(thinking)) {
    throw new TypeError(`${WHERE}: thinking must be a JSON object with a string type`);
  }
  if (!Array.isArray(serverTools) || !serverTools.every(isTyped)) {
    throw new TypeError(
      `${WHERE}: serverTools must be a list of JSON objects, each with a string type`,
    );
  }
  if (fallbacks !== 'default' && fallbacks !== false) {
    throw new TypeError(
      `${WHERE}: fallbacks must be 'default' or false, got ${describe(fallbacks)}`,
    );
  }
  return {
    client: client as unknown as AnthropicClient,
    stream,
    settings: {
      model,
      maxTokens,
      effort,
      ...(thinking === undefined ? {} : { thinking: thinking as JsonValue }),
      fallbacks,
      // Copied, so a caller changing their array later can't change what's sent.
      serverTools: [...(serverTools as JsonValue[])],
    },
  };
}

/**
 * One streamed request: text deltas to `onText`, the response from `finalMessage()`. Aborting the
 * signal aborts the stream too, whether or not the client heeds the signal it was passed.
 */
async function streamed(
  client: AnthropicClient,
  params: AnthropicCreateParams,
  options: AnthropicRequestOptions,
  onText: ModelCallOptions['onText'],
) {
  const stream = client.beta.messages.stream(params, options);
  const abort = () => {
    stream.abort();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    if (onText !== undefined) {
      stream.on('text', (delta) => {
        onText(delta);
      });
    }
    if (options.signal.aborted) stream.abort();
    return await stream.finalMessage();
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
}

/**
 * A {@link Model} over the Anthropic Messages API, named `anthropic:<model>`.
 *
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * const model = anthropicModel({ client: new Anthropic() });
 * ```
 *
 * @throws TypeError for a missing client, unknown keys or a bad option.
 * @throws RangeError for a `maxTokens` that isn't a positive integer.
 */
export function anthropicModel(options: AnthropicModelOptions): Model {
  const { client, stream, settings } = settingsOf(options);
  return Object.freeze({
    name: `anthropic:${settings.model}`,
    async call(request, { signal, onText }) {
      const params = toParams(request, settings);
      const requestOptions = { maxRetries: 0, signal };
      let message;
      try {
        message = stream
          ? await streamed(client, params, requestOptions, onText)
          : await client.beta.messages.create(params, requestOptions);
      } catch (error) {
        throw toModelError(error);
      }
      return fromMessage(message);
    },
  } satisfies Model);
}
