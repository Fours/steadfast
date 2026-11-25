// The provider-neutral model interface. A run talks to every provider through `Model`, and an
// adapter turns a request into the provider's own messages. Responses keep the provider's content
// verbatim in `raw` (decision 0005), so the next request can send it back exactly as it came.

import type { JsonValue } from './json.js';

/** A JSON Schema for a tool's input. Providers require an object schema at the top. */
export type JsonSchemaObject = { readonly type: 'object' } & { readonly [key: string]: JsonValue };

/** What the model is told about a tool: its name, what it does, and the schema of its input. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input: JsonSchemaObject;
}

/** One tool call the model asked for, as Steadfast reads it from the provider's content. */
export interface ToolCall {
  /** The provider's id for the call. Unique within its response. */
  readonly id: string;
  readonly name: string;
  /** The parsed input, or the provider's raw arguments when they couldn't be parsed. */
  readonly input: JsonValue;
  /**
   * Why the adapter couldn't read the input, such as arguments that aren't JSON. The run reports
   * it to the model as the call's result, and never runs the tool.
   */
  readonly inputError?: string;
}

/**
 * The result of one tool call, as the model sees it. A failure is reported, not thrown, since the
 * model can often work around it. `interrupted` marks a call that may or may not have run
 * (decision 0003).
 */
export type ToolResult =
  | { readonly ok: true; readonly output: JsonValue }
  | { readonly ok: false; readonly error: string; readonly interrupted?: true };

/** Tokens a model call used, as the provider reports them. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Why the model stopped. `paused` is a turn the provider stopped to be resumed, such as
 * Anthropic's `pause_turn`: the run calls the model again with the transcript as it is.
 */
export type StopReason = 'endTurn' | 'toolUse' | 'maxOutputTokens' | 'refusal' | 'paused';

/** One model response: Steadfast's reading of it, and the provider's own content in `raw`. */
export interface ModelResponse {
  readonly stop: StopReason;
  /** The visible text, joined, for the timeline and the outcome. */
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
  /** The model that actually answered, which a fallback can change. */
  readonly model: string;
  /** The provider's own content, verbatim. Sent back exactly as it came. */
  readonly raw: JsonValue;
}

/**
 * One entry of the transcript: the run's input, a model response, or the results of every tool
 * call of one step, in call order. The transcript only grows: turns are never edited.
 */
export type Turn =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly response: ModelResponse }
  | {
      readonly role: 'toolResults';
      readonly results: readonly { readonly callId: string; readonly result: ToolResult }[];
    };

/** Everything a model call needs. The run derives it from its state. */
export interface ModelRequest {
  readonly system: string;
  readonly transcript: readonly Turn[];
  readonly tools: readonly ToolSpec[];
}

/** What a model call is given besides the request. An object, so it can grow without breaking. */
export interface ModelCallOptions {
  /** Aborted on timeout, on cancel, and when the run stops. */
  readonly signal: AbortSignal;
  /**
   * Called with each piece of visible text as it's generated, in order. A model that can't
   * stream never calls it. Only the final response is journaled: this is a preview.
   */
  readonly onText?: (text: string) => void;
}

/** A model, behind a provider adapter or scripted for tests. */
export interface Model {
  /** Recorded in `runStarted`, e.g. `'anthropic:claude-opus-5-5'`. */
  readonly name: string;
  /**
   * Answers one request. Every failure must be a {@link ModelError}, so the run never inspects a
   * provider's error types.
   */
  call(request: ModelRequest, options: ModelCallOptions): Promise<ModelResponse>;
}

/** A bad option's value for an error message: a number as itself, anything else by its type. */
function describe(value: unknown): string {
  return typeof value === 'number' ? String(value) : typeof value;
}

/** Options for {@link ModelError}. */
export interface ModelErrorOptions {
  /** Whether the same request may succeed if it's tried again, after a backoff. */
  readonly retryable: boolean;
  /** The least time to wait before trying again, in integer ms, such as a `retry-after` header. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/**
 * A failed model call. Adapters throw it for every failure: rate limits, overload, timeouts and
 * network errors are `retryable`, and supervision restarts the call with backoff. Anything else
 * ends the run.
 */
export class ModelError extends Error {
  /** Whether the same request may succeed if it's tried again. */
  readonly retryable: boolean;
  /** The least time to wait before trying again, in integer ms. */
  readonly retryAfterMs: number | undefined;

  /**
   * @throws TypeError if `retryable` isn't a boolean.
   * @throws RangeError if `retryAfterMs` isn't a non-negative integer.
   */
  constructor(message: string, options: ModelErrorOptions) {
    // Checked before anything else: a bad error from an adapter should fail where it's made, not
    // later in the run's backoff arithmetic. The options type can't stop untyped callers.
    const { retryable, retryAfterMs } = options as { retryable: unknown; retryAfterMs?: unknown };
    if (typeof retryable !== 'boolean') {
      throw new TypeError(`ModelError: retryable must be a boolean, got ${describe(retryable)}`);
    }
    if (
      retryAfterMs !== undefined &&
      !(typeof retryAfterMs === 'number' && Number.isInteger(retryAfterMs) && retryAfterMs >= 0)
    ) {
      throw new RangeError(
        `ModelError: retryAfterMs must be a non-negative integer, got ${describe(retryAfterMs)}`,
      );
    }
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'ModelError';
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}
