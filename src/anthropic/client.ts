// The Anthropic client, typed structurally by the two methods the adapter calls (decision 0004).
// Steadfast never imports the SDK: anything whose `beta.messages.create` and `beta.messages.stream`
// accept these params and give this message shape works, and a type test proves `new Anthropic()`
// does. Fields the
// adapter doesn't fill in are typed as loosely as the SDK's own, so a newer SDK still fits.

/** One message of a request, as the Messages API takes it. */
export interface AnthropicMessageParam {
  readonly role: string;
  /** Optional only so the SDK's own message type fits: every message the adapter sends has it. */
  readonly content?: string | readonly unknown[];
}

/** The params of one Messages API request: the fields the adapter sends. */
export interface AnthropicCreateParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly AnthropicMessageParam[];
  readonly system?: string | readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly output_config?: { readonly effort?: string | null };
  readonly thinking?: unknown;
  readonly betas?: readonly string[];
  readonly fallbacks?: unknown;
}

/** Per-request options. The adapter always sends both. */
export interface AnthropicRequestOptions {
  /** Always 0: retries belong to supervision, so every attempt is journaled. */
  readonly maxRetries: number;
  readonly signal: AbortSignal;
}

/** A Messages API response: the fields the adapter reads. */
export interface AnthropicMessage {
  /** The provider's content blocks, journaled verbatim as the response's `raw` (decision 0010). */
  readonly content: readonly unknown[];
  readonly stop_reason: string | null;
  /** The model that answered, which a fallback can change. */
  readonly model: string;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens?: number | null;
    readonly cache_read_input_tokens?: number | null;
  };
}

/** A streaming response, as `beta.messages.stream()` returns it: the members the adapter uses. */
export interface AnthropicMessageStream {
  /** Listens for each piece of visible text as it's generated. */
  on(event: 'text', listener: (textDelta: string) => void): unknown;
  /** The whole message once the stream ends. Rejects if the stream fails or is aborted. */
  finalMessage(): PromiseLike<AnthropicMessage>;
  /** Stops the stream, so `finalMessage()` rejects. */
  abort(): void;
}

/** Anything with the SDK's `beta.messages.create` and `beta.messages.stream`, such as `new Anthropic()`. */
export interface AnthropicClient {
  readonly beta: {
    readonly messages: {
      create(
        params: AnthropicCreateParams,
        options: AnthropicRequestOptions,
      ): PromiseLike<AnthropicMessage>;
      stream(
        params: AnthropicCreateParams,
        options: AnthropicRequestOptions,
      ): AnthropicMessageStream;
    };
  };
}
