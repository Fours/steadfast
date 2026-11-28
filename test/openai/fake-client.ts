// A fake OpenAI client: it records each request and answers in turn, with no network. A streamed
// request and a plain one take the next answer alike, so a test reads the same way in either mode.

import type {
  OpenAIClient,
  OpenAICreateParams,
  OpenAIEventStream,
  OpenAIRequestOptions,
  OpenAIResponse,
  OpenAIStreamEvent,
} from '../../src/openai/index.ts';

/**
 * What one request gets: a response, an error to fail with, a response streamed as the deltas
 * given (by default, its `output_text` parts), the events given and nothing else, or a stream that
 * never ends until it's aborted.
 */
export type Answer =
  | OpenAIResponse
  | { reject: Error }
  | { deltas: string[]; response: OpenAIResponse }
  | { events: FakeEvent[] }
  | { hang: true };

/** A stream event with whatever fields its type carries. */
export type FakeEvent = OpenAIStreamEvent & { readonly [key: string]: unknown };

export interface FakeCall {
  params: OpenAICreateParams & { readonly stream?: boolean | null };
  options: OpenAIRequestOptions;
  /** For a stream, whether its controller was aborted. */
  aborted: boolean;
}

export interface FakeClient extends OpenAIClient {
  readonly calls: FakeCall[];
}

/** The error the SDK's stream fails with when it's aborted, shaped by what the adapter reads. */
export class FakeAbortError extends Error {
  constructor() {
    super('Request was aborted.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textOf(response: OpenAIResponse): string[] {
  return response.output.flatMap((item) =>
    isRecord(item) && item.type === 'message' && Array.isArray(item.content)
      ? (item.content as unknown[]).flatMap((part) =>
          isRecord(part) && part.type === 'output_text' && typeof part.text === 'string'
            ? [part.text]
            : [],
        )
      : [],
  );
}

/** The events the API sends for a response: created, its text deltas, and the one that ends it. */
export function eventsOf(response: OpenAIResponse, deltas = textOf(response)): FakeEvent[] {
  const end =
    response.status === 'incomplete'
      ? 'response.incomplete'
      : response.status === 'failed'
        ? 'response.failed'
        : 'response.completed';
  return [
    // The created event carries a response too, still in progress. Only the last one counts.
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    ...deltas.map((delta) => ({ type: 'response.output_text.delta', delta })),
    { type: end, response },
  ];
}

function fakeStream(events: FakeEvent[] | 'hang', call: FakeCall): OpenAIEventStream {
  let wake: (() => void) | undefined;
  return {
    controller: {
      abort() {
        call.aborted = true;
        wake?.();
      },
    },
    async *[Symbol.asyncIterator]() {
      if (events === 'hang') {
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (call.aborted) resolve();
        });
      } else {
        for (const event of events) {
          if (call.aborted) break;
          yield event;
        }
      }
      if (call.aborted) throw new FakeAbortError();
    },
  };
}

/** A client that answers each request, streamed or not, with the next answer. */
export function fakeClient(...answers: Answer[]): FakeClient {
  const calls: FakeCall[] = [];
  const create = (
    params: FakeCall['params'],
    options: OpenAIRequestOptions,
  ): Promise<OpenAIResponse | OpenAIEventStream> => {
    const call: FakeCall = { params, options, aborted: false };
    calls.push(call);
    const answer = answers[calls.length - 1];
    if (answer === undefined) return Promise.reject(new Error('no more answers'));
    if ('reject' in answer) return Promise.reject(answer.reject);
    if (params.stream !== true) {
      if ('hang' in answer) return new Promise(() => undefined);
      if ('events' in answer) return Promise.reject(new Error('events need a stream'));
      return Promise.resolve('deltas' in answer ? answer.response : answer);
    }
    if ('hang' in answer) return Promise.resolve(fakeStream('hang', call));
    if ('events' in answer) return Promise.resolve(fakeStream(answer.events, call));
    const events = 'deltas' in answer ? eventsOf(answer.response, answer.deltas) : eventsOf(answer);
    return Promise.resolve(fakeStream(events, call));
  };
  // One function stands in for both overloads: which it returns depends on `stream`, as the SDK's.
  return { calls, responses: { create: create as OpenAIClient['responses']['create'] } };
}

/** A response as the API sends it, with the output given. */
export function response(
  output: unknown[],
  overrides: Partial<OpenAIResponse> = {},
): OpenAIResponse {
  return {
    status: 'completed',
    output,
    model: 'gpt-5.6',
    incomplete_details: null,
    error: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

/** An assistant message item with one `output_text` part. */
export function textItem(text: string, id = 'msg_1') {
  return {
    type: 'message',
    id,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

/** A `function_call` item, with its arguments as the JSON text the API sends. */
export function callItem(callId: string, name: string, args: string) {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: args,
    status: 'completed',
  };
}

/** A reasoning item, encrypted, as a `store: false` request gets it. */
export function reasoningItem(id: string) {
  return { type: 'reasoning', id, summary: [], encrypted_content: `enc-${id}` };
}
