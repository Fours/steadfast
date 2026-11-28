// A fake Anthropic client: it records each request and answers in turn, with no network. Both
// `create` and `stream` take the next answer, so a test reads the same way in either mode.

import type {
  AnthropicClient,
  AnthropicCreateParams,
  AnthropicMessage,
  AnthropicMessageStream,
  AnthropicRequestOptions,
} from '../../src/anthropic/index.ts';

/**
 * What one request gets: a message, an error to fail with, a message streamed as the deltas given
 * (by default, its text blocks' text), or a stream that never ends until it's aborted.
 */
export type Answer =
  | AnthropicMessage
  | { reject: Error }
  | { deltas: string[]; message: AnthropicMessage }
  | { hang: true };

export interface FakeCall {
  method: 'create' | 'stream';
  params: AnthropicCreateParams;
  options: AnthropicRequestOptions;
  /** For a stream, whether `abort()` was called on it. */
  aborted: boolean;
}

export interface FakeClient extends AnthropicClient {
  readonly calls: FakeCall[];
}

/** The error the SDK's stream fails with when it's aborted, shaped by what the adapter reads. */
export class FakeAbortError extends Error {
  constructor() {
    super('Request was aborted.');
  }
}

function textOf(message: AnthropicMessage): string[] {
  return message.content.flatMap((block) =>
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'text' &&
    'text' in block &&
    typeof block.text === 'string'
      ? [block.text]
      : [],
  );
}

function fakeStream(answer: Answer | undefined, call: FakeCall): AnthropicMessageStream {
  const listeners: ((delta: string) => void)[] = [];
  let failAbort: ((error: Error) => void) | undefined;
  return {
    on(_event, listener) {
      listeners.push(listener);
      return this;
    },
    finalMessage() {
      if (call.aborted) return Promise.reject(new FakeAbortError());
      if (answer === undefined) return Promise.reject(new Error('no more answers'));
      if ('reject' in answer) return Promise.reject(answer.reject);
      if ('hang' in answer) {
        return new Promise<AnthropicMessage>((_, reject) => {
          failAbort = reject;
        });
      }
      const [deltas, message] =
        'deltas' in answer ? [answer.deltas, answer.message] : [textOf(answer), answer];
      for (const delta of deltas) for (const listener of listeners) listener(delta);
      return Promise.resolve(message);
    },
    abort() {
      call.aborted = true;
      failAbort?.(new FakeAbortError());
    },
  };
}

/** A client that answers each request, streamed or not, with the next answer. */
export function fakeClient(...answers: Answer[]): FakeClient {
  const calls: FakeCall[] = [];
  const record = (
    method: FakeCall['method'],
    params: AnthropicCreateParams,
    options: AnthropicRequestOptions,
  ) => {
    const call: FakeCall = { method, params, options, aborted: false };
    calls.push(call);
    return { call, answer: answers[calls.length - 1] };
  };
  return {
    calls,
    beta: {
      messages: {
        create(params, options) {
          const { answer } = record('create', params, options);
          if (answer === undefined) return Promise.reject(new Error('no more answers'));
          if ('reject' in answer) return Promise.reject(answer.reject);
          if ('hang' in answer) return new Promise<AnthropicMessage>(() => undefined);
          return Promise.resolve('deltas' in answer ? answer.message : answer);
        },
        stream(params, options) {
          const { call, answer } = record('stream', params, options);
          return fakeStream(answer, call);
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
