import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { createTestKit } from '@kylewillett/troupe/testkit';
import { describe, expect, it } from 'vitest';
import { anthropicModel, type AnthropicModelOptions } from '../../src/anthropic/index.ts';
import {
  agent,
  ModelError,
  tool,
  type ModelRequest,
  type RunEvent,
  type RunReport,
} from '../../src/index.ts';
import { FakeApiError, fakeClient, message } from './fake-client.ts';

const request: ModelRequest = {
  system: 'You triage.',
  transcript: [{ role: 'user', text: 'Checkout is down.' }],
  tools: [],
};

describe('anthropicModel', () => {
  it('streams, with maxRetries 0, 64,000 max tokens, the fallback beta and fallbacks "default" by default', async () => {
    const client = fakeClient(message([{ type: 'text', text: 'ok' }]));
    const model = anthropicModel({ client });
    expect(model.name).toBe('anthropic:claude-opus-5-5');
    const signal = new AbortController().signal;
    await model.call(request, { signal });

    expect(client.calls).toHaveLength(1);
    const [call] = client.calls;
    expect(call?.method).toBe('stream');
    expect(call?.options).toEqual({ maxRetries: 0, signal });
    expect(call?.options.signal).toBe(signal);
    expect(call?.params).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 64_000,
      system: 'You triage.',
      messages: [{ role: 'user', content: 'Checkout is down.' }],
      output_config: { effort: 'high' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    // Adaptive thinking is the model's default, so it's left out.
    expect(call?.params).not.toHaveProperty('thinking');
  });

  it('sends text deltas to onText in order, and maps the response from finalMessage()', async () => {
    const final = message([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Checking the log.' },
    ]);
    const client = fakeClient({ deltas: ['Check', 'ing the ', 'log.'], message: final });
    const pieces: string[] = [];
    const response = await anthropicModel({ client }).call(request, {
      signal: new AbortController().signal,
      onText: (text) => pieces.push(text),
    });
    expect(pieces).toEqual(['Check', 'ing the ', 'log.']);
    expect(response).toMatchObject({ stop: 'endTurn', text: 'Checking the log.' });
    expect(response.raw).toEqual(final.content);
  });

  it('streams without an onText', async () => {
    const client = fakeClient(message([{ type: 'text', text: 'ok' }]));
    const response = await anthropicModel({ client }).call(request, {
      signal: new AbortController().signal,
    });
    expect(response.text).toBe('ok');
  });

  it('aborts the stream when the signal aborts, as a retryable ModelError', async () => {
    const client = fakeClient({ hang: true });
    const controller = new AbortController();
    const call = anthropicModel({ client }).call(request, { signal: controller.signal });
    expect(client.calls[0]?.aborted).toBe(false);
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'ModelError', retryable: true });
    expect(client.calls[0]?.aborted).toBe(true);
  });

  it('aborts at once for a signal that is already aborted', async () => {
    const client = fakeClient(message([{ type: 'text', text: 'ok' }]));
    const controller = new AbortController();
    controller.abort();
    const call = anthropicModel({ client }).call(request, { signal: controller.signal });
    await expect(call).rejects.toBeInstanceOf(ModelError);
    expect(client.calls[0]?.aborted).toBe(true);
  });

  it('stops listening to the signal once the stream has ended', async () => {
    const client = fakeClient(message([{ type: 'text', text: 'ok' }]));
    const controller = new AbortController();
    await anthropicModel({ client }).call(request, { signal: controller.signal });
    controller.abort();
    expect(client.calls[0]?.aborted).toBe(false);
  });

  it('sends one create request with 16,000 max tokens when stream is false', async () => {
    const client = fakeClient({
      deltas: ['never', 'streamed'],
      message: message([{ type: 'text', text: 'ok' }]),
    });
    const pieces: string[] = [];
    const response = await anthropicModel({ client, stream: false }).call(request, {
      signal: new AbortController().signal,
      onText: (text) => pieces.push(text),
    });
    expect(client.calls[0]?.method).toBe('create');
    expect(client.calls[0]?.params.max_tokens).toBe(16_000);
    expect(pieces).toEqual([]);
    expect(response.text).toBe('ok');
  });

  it('sends server tools as written, and a later change to the caller array changes nothing', async () => {
    const webSearch = { type: 'web_search_20260318', name: 'web_search', max_uses: 3 };
    const serverTools = [webSearch];
    const client = fakeClient(message([]));
    const model = anthropicModel({ client, serverTools });
    serverTools.push({ type: 'code_execution_20250825', name: 'code_execution', max_uses: 1 });
    await model.call(request, { signal: new AbortController().signal });
    expect(client.calls[0]?.params.tools).toEqual([webSearch]);
  });

  it('leaves out the beta and fallbacks when fallbacks is false, and still sends maxRetries 0', async () => {
    const client = fakeClient(message([]));
    await anthropicModel({ client, fallbacks: false }).call(request, {
      signal: new AbortController().signal,
    });
    const [call] = client.calls;
    expect(call?.params).not.toHaveProperty('betas');
    expect(call?.params).not.toHaveProperty('fallbacks');
    expect(call?.options.maxRetries).toBe(0);
  });

  it('takes the model, max tokens, effort and thinking as options', async () => {
    const client = fakeClient(message([]));
    const model = anthropicModel({
      client,
      model: 'claude-sonnet-5-5',
      maxTokens: 4_096,
      effort: 'low',
      thinking: { type: 'adaptive', display: 'summarized' },
    });
    expect(model.name).toBe('anthropic:claude-sonnet-5-5');
    await model.call(request, { signal: new AbortController().signal });
    expect(client.calls[0]?.params).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 4_096,
      output_config: { effort: 'low' },
      thinking: { type: 'adaptive', display: 'summarized' },
    });
  });

  it('records the model that answered, and maps the response', async () => {
    const client = fakeClient(
      message([{ type: 'text', text: 'Declined.' }], 'refusal', { model: 'claude-opus-4-8' }),
    );
    const response = await anthropicModel({ client }).call(request, {
      signal: new AbortController().signal,
    });
    expect(response).toMatchObject({
      stop: 'refusal',
      text: 'Declined.',
      model: 'claude-opus-4-8',
    });
  });

  it("throws the client's failures as classified ModelErrors", async () => {
    const headers = new Headers({ 'retry-after': '7' });
    const client = fakeClient(
      { reject: new FakeApiError(429, headers) },
      { reject: new FakeApiError(400) },
    );
    const model = anthropicModel({ client });
    const signal = new AbortController().signal;
    await expect(model.call(request, { signal })).rejects.toMatchObject({
      name: 'ModelError',
      retryable: true,
      retryAfterMs: 7_000,
    });
    await expect(model.call(request, { signal })).rejects.toMatchObject({ retryable: false });
  });

  it('throws an unexpected stop reason as a ModelError that is not retryable', async () => {
    const client = fakeClient(message([], 'stop_sequence'));
    const call = anthropicModel({ client }).call(request, { signal: new AbortController().signal });
    await expect(call).rejects.toBeInstanceOf(ModelError);
    await expect(call).rejects.toMatchObject({ retryable: false });
  });

  it.each<[string, unknown, RegExp]>([
    ['no options', undefined, /give an options object/],
    ['no client', {}, /client must have beta.messages.create/],
    ['a client without create', { client: { beta: { messages: {} } } }, /client must/],
    ['a client without stream', { client: { beta: { messages: { create() {} } } } }, /stream/],
    ['an unknown key', { client: fakeClient(), streaming: true }, /unknown option "streaming"/],
    ['a stream that is not a boolean', { client: fakeClient(), stream: 'yes' }, /stream must be/],
    ['serverTools that are not a list', { client: fakeClient(), serverTools: {} }, /serverTools/],
    ['a server tool without a type', { client: fakeClient(), serverTools: [{}] }, /serverTools/],
    [
      "a server tool that isn't JSON",
      { client: fakeClient(), serverTools: [{ type: 'x', at: new Date() }] },
      /serverTools/,
    ],
    ['an empty model', { client: fakeClient(), model: '' }, /model must be a non-empty string/],
    ['a fractional maxTokens', { client: fakeClient(), maxTokens: 1.5 }, /maxTokens must be/],
    ['a zero maxTokens', { client: fakeClient(), maxTokens: 0 }, /maxTokens must be/],
    ['an unknown effort', { client: fakeClient(), effort: 'extreme' }, /effort must be one of/],
    ['thinking without a type', { client: fakeClient(), thinking: {} }, /thinking must be/],
    ['fallbacks true', { client: fakeClient(), fallbacks: true }, /fallbacks must be/],
  ])('throws when it is made, for %s', (_, options, error) => {
    expect(() => anthropicModel(options as AnthropicModelOptions)).toThrow(error);
  });

  it('throws a RangeError for a bad maxTokens', () => {
    expect(() => anthropicModel({ client: fakeClient(), maxTokens: -1 })).toThrow(RangeError);
  });
});

describe('a run on anthropicModel', () => {
  it("sends each response's content back verbatim on the next call", async () => {
    const kit = createTestKit();
    const first = [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'text', text: 'Checking the log.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_log', input: { service: 'checkout' } },
    ];
    const client = fakeClient(
      message(first, 'tool_use'),
      message([{ type: 'text', text: 'A bad deploy.' }]),
    );
    const readLog = tool({
      name: 'read_log',
      description: 'Reads a log.',
      input: { type: 'object' },
      idempotent: true,
      run: () => Promise.resolve({ lines: ['502 upstream'] }),
    });
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const a = agent({
      name: 'triage',
      model: anthropicModel({ client }),
      system: 'You triage.',
      tools: [readLog],
      persistence,
      clock: () => kit.scheduler.now(),
    });
    const reporter = kit.probe<RunReport>('desk');
    kit.system.spawn(
      a.run('incident-1', { input: 'Checkout is down.', reportTo: reporter.ref }),
      'run',
    );
    await kit.settle();

    expect(reporter.expectMessage()).toMatchObject({ outcome: 'completed', text: 'A bad deploy.' });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.params.messages).toEqual([
      { role: 'user', content: 'Checkout is down.' },
      { role: 'assistant', content: first },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"lines":["502 upstream"]}' },
        ],
      },
    ]);
    // And the journal holds the same content, so a recovered run sends the same bytes.
    const events = (await persistence.journal.read(a.persistenceId('incident-1'), 1, 100)).map(
      (e) => e.event as RunEvent,
    );
    const responded = events.find((e) => e.type === 'modelResponded');
    expect(responded).toMatchObject({ response: { raw: first, model: 'claude-opus-5-5' } });
    await kit.shutdown();
  });
});

describe('a run on anthropicModel, with a mid-output fallback', () => {
  it('journals raw as it came, and sends the turn back under the resend rule', async () => {
    const kit = createTestKit();
    const fallback = {
      type: 'fallback',
      from: { model: 'claude-opus-5-5' },
      to: { model: 'claude-opus-4-8' },
      trigger: { type: 'refusal', category: 'cyber' },
    };
    const first = [
      { type: 'thinking', thinking: '', signature: 'sig-declined' },
      { type: 'text', text: 'To get in, first ' },
      fallback,
      { type: 'thinking', thinking: '', signature: 'sig-fallback' },
      { type: 'text', text: 'I will read the log instead.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_log', input: { service: 'auth' } },
    ];
    const client = fakeClient(
      message(first, 'tool_use', { model: 'claude-opus-4-8' }),
      message([{ type: 'text', text: 'Nothing unusual.' }], 'end_turn', {
        model: 'claude-opus-4-8',
      }),
    );
    const readLog = tool({
      name: 'read_log',
      description: 'Reads a log.',
      input: { type: 'object' },
      idempotent: true,
      run: () => Promise.resolve({ lines: [] }),
    });
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const a = agent({
      name: 'audit',
      model: anthropicModel({ client }),
      system: 'You audit.',
      tools: [readLog],
      persistence,
      clock: () => kit.scheduler.now(),
    });
    const reporter = kit.probe<RunReport>('desk');
    kit.system.spawn(
      a.run('audit-1', { input: 'How do I get into the auth service?', reportTo: reporter.ref }),
      'run',
    );
    await kit.settle();

    expect(reporter.expectMessage()).toMatchObject({
      outcome: 'completed',
      text: 'Nothing unusual.',
    });
    expect(client.calls[1]?.params.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'To get in, first ' },
        fallback,
        { type: 'thinking', thinking: '', signature: 'sig-fallback' },
        { type: 'text', text: 'I will read the log instead.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_log', input: { service: 'auth' } },
      ],
    });
    const events = (await persistence.journal.read(a.persistenceId('audit-1'), 1, 100)).map(
      (e) => e.event as RunEvent,
    );
    const responded = events.find((e) => e.type === 'modelResponded');
    expect(responded).toMatchObject({
      response: {
        raw: first,
        text: 'I will read the log instead.',
        model: 'claude-opus-4-8',
      },
    });
    await kit.shutdown();
  });
});
