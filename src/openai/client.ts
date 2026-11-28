// The OpenAI client, typed structurally by the one method the adapter calls (decision 0004).
// Steadfast never imports the SDK: anything whose `responses.create` accepts these params and gives
// this response, or this stream of events, works, and a type test proves `new OpenAI()` does.
// Every param is optional and typed as loosely as the SDK's own, only so the SDK's method fits:
// the adapter always sends `model`, `input`, `store` and `include`.
//
// Streaming goes through `create` with `stream: true`, not the SDK's `responses.stream()` helper.
// The helper's final response isn't what the provider sent, since the SDK adds `parsed` and
// `parsed_arguments` fields to its output items, and its params are generic over the SDK's own
// input types, which no structural type can fit without importing them.

/** The params of one Responses API request: the fields the adapter sends. */
export interface OpenAICreateParams {
  readonly model?: string;
  /** Input items: messages, the provider's own output items, and `function_call_output` items. */
  readonly input?: string | readonly unknown[];
  readonly instructions?: string | null;
  readonly tools?: readonly unknown[];
  /** Always `false`: the journal holds the conversation, not OpenAI. */
  readonly store?: boolean | null;
  /** Always `['reasoning.encrypted_content']`, so reasoning items can go back in the next request. */
  readonly include?: readonly string[] | null;
  readonly max_output_tokens?: number | null;
  readonly reasoning?: { readonly effort?: string | null } | null;
}

/** Per-request options. The adapter always sends both. */
export interface OpenAIRequestOptions {
  /** Always 0: retries belong to supervision, so every attempt is journaled. */
  readonly maxRetries: number;
  readonly signal: AbortSignal;
}

/** A Responses API response: the fields the adapter reads. */
export interface OpenAIResponse {
  /** `completed`, `incomplete` or `failed` for a response that has ended. */
  readonly status?: string;
  /** The provider's output items, journaled verbatim as the response's `raw`. */
  readonly output: readonly unknown[];
  /** The model that answered. */
  readonly model: string;
  readonly incomplete_details: { readonly reason?: string } | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly usage?: {
    /** Includes cached input tokens, unlike Anthropic's `input_tokens`. */
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

/**
 * One server-sent event of a streamed response. The adapter reads `response.output_text.delta`
 * events' `delta`, and the `response` of `response.completed`, `response.incomplete` and
 * `response.failed`, checking each field's shape as it reads it.
 */
export interface OpenAIStreamEvent {
  readonly type: string;
}

/** A streamed response, as `responses.create({ stream: true })` resolves to it. */
export interface OpenAIEventStream extends AsyncIterable<OpenAIStreamEvent> {
  /** Aborting it stops the stream, so iterating it throws. */
  readonly controller: { abort(): void };
}

/** Anything with the SDK's `responses.create`, such as `new OpenAI()`. */
export interface OpenAIClient {
  readonly responses: {
    create(
      params: OpenAICreateParams & { readonly stream?: false | null },
      options: OpenAIRequestOptions,
    ): PromiseLike<OpenAIResponse>;
    create(
      params: OpenAICreateParams & { readonly stream: true },
      options: OpenAIRequestOptions,
    ): PromiseLike<OpenAIEventStream>;
  };
}
