import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../../src/index.ts';
import { openaiModel, type OpenAIModelOptions } from '../../src/openai/index.ts';
import { FakeApiError } from '../fake-api-error.ts';
import {
  callItem,
  eventsOf,
  fakeClient,
  reasoningItem,
  response,
  textItem,
} from './fake-client.ts';

const request: ModelRequest = {
  system: 'You triage.',
  transcript: [{ role: 'user', text: 'Checkout is down.' }],
  tools: [],
};

const signal = () => new AbortController().signal;

describe('openaiModel', () => {
  it('streams a stateless request, asking for encrypted reasoning, with maxRetries 0', async () => {
    const client = fakeClient(response([textItem('ok')]));
    const model = openaiModel({ client, model: 'gpt-5.6' });
    expect(model.name).toBe('openai:gpt-5.6');
    const s = signal();
    await model.call(request, { signal: s });

    expect(client.calls).toHaveLength(1);
    const [call] = client.calls;
    expect(call?.options).toEqual({ maxRetries: 0, signal: s });
    expect(call?.options.signal).toBe(s);
    expect(call?.params).toEqual({
      model: 'gpt-5.6',
      instructions: 'You triage.',
      input: [{ role: 'user', content: 'Checkout is down.' }],
      store: false,
      include: ['reasoning.encrypted_content'],
      stream: true,
    });
  });

  it('sends text deltas to onText in order, and maps the response from the event that ends the stream', async () => {
    const final = response([reasoningItem('rs_1'), textItem('Checking the log.')]);
    const client = fakeClient({ deltas: ['Check', 'ing the ', 'log.'], response: final });
    const pieces: string[] = [];
    const mapped = await openaiModel({ client, model: 'gpt-5.6' }).call(request, {
      signal: signal(),
      onText: (text) => pieces.push(text),
    });
    expect(pieces).toEqual(['Check', 'ing the ', 'log.']);
    expect(mapped).toMatchObject({ stop: 'endTurn', text: 'Checking the log.', model: 'gpt-5.6' });
    // The output items exactly as the provider sent them, not the in-progress ones before.
    expect(mapped.raw).toBe(final.output);
  });

  it('streams without an onText, and skips events it has no use for', async () => {
    const final = response([textItem('ok')]);
    const client = fakeClient({
      events: [
        { type: 'response.output_text.delta' },
        { type: 'response.output_item.done' },
        ...eventsOf(final),
      ],
    });
    const mapped = await openaiModel({ client, model: 'gpt-5.6' }).call(request, {
      signal: signal(),
    });
    expect(mapped.text).toBe('ok');
  });

  it('maps an incomplete and a failed stream from their own end events', async () => {
    const client = fakeClient(
      response([textItem('The cause')], {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
      response([], { status: 'failed', error: { code: 'server_error', message: 'boom' } }),
    );
    const model = openaiModel({ client, model: 'gpt-5.6' });
    expect((await model.call(request, { signal: signal() })).stop).toBe('maxOutputTokens');
    await expect(model.call(request, { signal: signal() })).rejects.toMatchObject({
      name: 'ModelError',
      retryable: true,
    });
  });

  it('fails a stream that ends without a response, as retryable', async () => {
    const client = fakeClient(
      { events: [{ type: 'response.output_text.delta', delta: 'Check' }] },
      { events: [{ type: 'response.completed' }] },
    );
    const model = openaiModel({ client, model: 'gpt-5.6' });
    await expect(model.call(request, { signal: signal() })).rejects.toMatchObject({
      message: 'OpenAI: the stream ended without a response',
      retryable: true,
    });
    await expect(model.call(request, { signal: signal() })).rejects.toMatchObject({
      message: 'OpenAI: a response.completed event has no response',
      retryable: false,
    });
  });

  it('aborts the stream when the signal aborts, as a retryable ModelError', async () => {
    const client = fakeClient({ hang: true });
    const controller = new AbortController();
    const call = openaiModel({ client, model: 'gpt-5.6' }).call(request, {
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(client.calls[0]?.aborted).toBe(false);
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'ModelError', retryable: true });
    expect(client.calls[0]?.aborted).toBe(true);
  });

  it('aborts at once for a signal that is already aborted', async () => {
    const client = fakeClient(response([textItem('ok')]));
    const controller = new AbortController();
    controller.abort();
    await expect(
      openaiModel({ client, model: 'gpt-5.6' }).call(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ retryable: true });
    expect(client.calls[0]?.aborted).toBe(true);
  });

  it('stops listening to the signal once the stream has ended', async () => {
    const client = fakeClient(response([textItem('ok')]));
    const controller = new AbortController();
    await openaiModel({ client, model: 'gpt-5.6' }).call(request, { signal: controller.signal });
    controller.abort();
    expect(client.calls[0]?.aborted).toBe(false);
  });

  it('sends one plain request when stream is false', async () => {
    const final = response([callItem('call_a', 'read_log', '{}')]);
    const client = fakeClient(final);
    const pieces: string[] = [];
    const mapped = await openaiModel({ client, model: 'gpt-5.6', stream: false }).call(request, {
      signal: signal(),
      onText: (text) => pieces.push(text),
    });
    expect(client.calls[0]?.params).not.toHaveProperty('stream');
    expect(pieces).toEqual([]);
    expect(mapped).toMatchObject({ stop: 'toolUse', raw: final.output });
  });

  it('takes max tokens and effort as options', async () => {
    const client = fakeClient(response([textItem('ok')]));
    await openaiModel({ client, model: 'gpt-5.6', maxTokens: 8_000, effort: 'xhigh' }).call(
      request,
      { signal: signal() },
    );
    expect(client.calls[0]?.params).toMatchObject({
      max_output_tokens: 8_000,
      reasoning: { effort: 'xhigh' },
    });
  });

  it.each([true, false])(
    "throws the client's failures as ModelErrors classified by the shared check (stream: %s)",
    async (stream) => {
      const headers = new Headers({ 'retry-after-ms': '1500' });
      const client = fakeClient(
        { reject: new FakeApiError(429, headers) },
        { reject: new FakeApiError(400) },
        { reject: new FakeApiError(503) },
      );
      const model = openaiModel({ client, model: 'gpt-5.6', stream });
      await expect(model.call(request, { signal: signal() })).rejects.toMatchObject({
        name: 'ModelError',
        retryable: true,
        retryAfterMs: 1_500,
      });
      await expect(model.call(request, { signal: signal() })).rejects.toMatchObject({
        name: 'ModelError',
        retryable: false,
      });
      await expect(model.call(request, { signal: signal() })).rejects.toMatchObject({
        retryable: true,
      });
    },
  );

  it('throws a TypeError for a bad client, model or option', () => {
    const client = fakeClient();
    const bad: unknown[] = [
      undefined,
      'gpt-5.6',
      { model: 'gpt-5.6' },
      { client: {}, model: 'gpt-5.6' },
      { client: { responses: {} }, model: 'gpt-5.6' },
      { client },
      { client, model: '' },
      { client, model: 5 },
      { client, model: 'gpt-5.6', stream: 'yes' },
      { client, model: 'gpt-5.6', effort: 'extreme' },
      { client, model: 'gpt-5.6', effort: null },
      { client, model: 'gpt-5.6', temperature: 0 },
    ];
    for (const options of bad) {
      expect(() => openaiModel(options as OpenAIModelOptions)).toThrow(TypeError);
    }
  });

  it('throws a RangeError for a bad maxTokens', () => {
    const client = fakeClient();
    for (const maxTokens of [0, -1, 1.5, Number.NaN, '100']) {
      expect(() =>
        openaiModel({ client, model: 'gpt-5.6', maxTokens } as unknown as OpenAIModelOptions),
      ).toThrow(RangeError);
    }
  });
});
