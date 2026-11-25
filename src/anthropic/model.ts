// `anthropicModel()`: a Model over the user's Anthropic client. It sends one non-streaming request
// per call, with the SDK's own retries off so supervision makes and journals every attempt, and
// turns every failure into a ModelError.

import { jsonProblem, type JsonValue } from '../json.js';
import type { Model } from '../model.js';
import type { AnthropicClient } from './client.js';
import { toModelError } from './errors.js';
import { fromMessage, toParams, type RequestSettings } from './mapping.js';

/** How hard the model thinks and how many tokens it spends, from least to most. */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A thinking configuration, sent as it is, such as `{ type: 'adaptive', display: 'summarized' }`. */
export type AnthropicThinking = { readonly type: string } & { readonly [key: string]: JsonValue };

/** What {@link anthropicModel} takes. */
export interface AnthropicModelOptions {
  /** Anything with the SDK's `beta.messages.create`, such as `new Anthropic()`. */
  readonly client: AnthropicClient;
  /** Default `'claude-opus-5-5'`. */
  readonly model?: string;
  /** The most output tokens per response, a positive integer. Default 16,000. */
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
}

const KEYS = new Set(['client', 'model', 'maxTokens', 'effort', 'thinking', 'fallbacks']);
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

/** Checks the options now, so a bad one fails where it's written. */
function settingsOf(raw: unknown): { client: AnthropicClient; settings: RequestSettings } {
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
    typeof client.beta.messages.create !== 'function'
  ) {
    throw new TypeError(`${WHERE}: client must have beta.messages.create, as new Anthropic() does`);
  }
  const { model = 'claude-opus-5-5', maxTokens = 16_000, effort = 'high', thinking } = raw;
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
  if (
    thinking !== undefined &&
    (!isObject(thinking) ||
      typeof thinking.type !== 'string' ||
      jsonProblem(thinking) !== undefined)
  ) {
    throw new TypeError(`${WHERE}: thinking must be a JSON object with a string type`);
  }
  if (fallbacks !== 'default' && fallbacks !== false) {
    throw new TypeError(
      `${WHERE}: fallbacks must be 'default' or false, got ${describe(fallbacks)}`,
    );
  }
  return {
    client: client as unknown as AnthropicClient,
    settings: {
      model,
      maxTokens,
      effort,
      ...(thinking === undefined ? {} : { thinking: thinking as JsonValue }),
      fallbacks,
    },
  };
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
  const { client, settings } = settingsOf(options);
  return Object.freeze({
    name: `anthropic:${settings.model}`,
    // Not streaming yet, so onText is never called (milestone 2's T6 streams).
    async call(request, { signal }) {
      const params = toParams(request, settings);
      let message;
      try {
        message = await client.beta.messages.create(params, { maxRetries: 0, signal });
      } catch (error) {
        throw toModelError(error);
      }
      return fromMessage(message);
    },
  } satisfies Model);
}
