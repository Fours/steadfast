// A fake Anthropic client: it records each request and answers in turn, with no network.

import type {
  AnthropicClient,
  AnthropicCreateParams,
  AnthropicMessage,
  AnthropicRequestOptions,
} from '../../src/anthropic/index.ts';

export interface FakeClient extends AnthropicClient {
  readonly calls: { params: AnthropicCreateParams; options: AnthropicRequestOptions }[];
}

/** Each answer is a message to resolve with, or an error to reject with. */
export function fakeClient(...answers: (AnthropicMessage | { reject: Error })[]): FakeClient {
  const calls: FakeClient['calls'] = [];
  return {
    calls,
    beta: {
      messages: {
        create(params, options) {
          calls.push({ params, options });
          const answer = answers[calls.length - 1];
          if (answer === undefined) return Promise.reject(new Error('no more answers'));
          return 'reject' in answer ? Promise.reject(answer.reject) : Promise.resolve(answer);
        },
      },
    },
  };
}

/** A message as the API sends it, with the content and stop reason given. */
export function message(
  content: unknown[],
  stop_reason: string | null = 'end_turn',
  overrides: Partial<AnthropicMessage> = {},
): AnthropicMessage {
  return {
    content,
    stop_reason,
    model: 'claude-opus-5-5',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

/** An error shaped like the SDK's APIError: a status and headers. */
export class FakeApiError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly headers: unknown = new Headers(),
  ) {
    super(`${String(status)} fake API error`);
  }
}
