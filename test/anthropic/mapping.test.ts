import { describe, expect, it } from 'vitest';
import {
  FALLBACK_BETA,
  fromMessage,
  toParams,
  type RequestSettings,
} from '../../src/anthropic/mapping.ts';
import { ModelError, type ModelRequest, type ModelResponse } from '../../src/index.ts';
import { say } from '../../src/testkit/index.ts';
import { message } from './fake-client.ts';

const settings: RequestSettings = {
  model: 'claude-opus-5-5',
  maxTokens: 16_000,
  effort: 'high',
  fallbacks: 'default',
};

// Content as Claude sends it, with blocks Steadfast doesn't read: they must go back unchanged.
const content = [
  { type: 'thinking', thinking: '', signature: 'sig-abc' },
  { type: 'text', text: 'Reading the log first.' },
  { type: 'tool_use', id: 'toolu_1', name: 'read_log', input: { service: 'checkout' } },
  { type: 'tool_use', id: 'toolu_2', name: 'query_metrics', input: { metric: 'errors' } },
];
const first: ModelResponse = fromMessage(message(content, 'tool_use'));

const request: ModelRequest = {
  system: 'You triage.',
  transcript: [
    { role: 'user', text: 'Checkout is down.' },
    { role: 'assistant', response: first },
    {
      role: 'toolResults',
      results: [
        { callId: 'toolu_1', result: { ok: true, output: { lines: ['502 upstream'] } } },
        { callId: 'toolu_2', result: { ok: false, error: 'metrics are down' } },
      ],
    },
    {
      role: 'assistant',
      response: fromMessage(
        message([{ type: 'tool_use', id: 'toolu_3', name: 'page_oncall', input: {} }], 'tool_use'),
      ),
    },
    {
      role: 'toolResults',
      results: [
        {
          callId: 'toolu_3',
          result: { ok: false, error: 'It may or may not have run.', interrupted: true },
        },
      ],
    },
  ],
  tools: [
    {
      name: 'read_log',
      description: 'Reads a log.',
      input: { type: 'object', properties: { service: { type: 'string' } } },
    },
  ],
};

describe('toParams', () => {
  it('maps a transcript to the Messages API shape', () => {
    expect(toParams(request, settings)).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      system: 'You triage.',
      messages: [
        { role: 'user', content: 'Checkout is down.' },
        { role: 'assistant', content },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"lines":["502 upstream"]}' },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: 'metrics are down',
              is_error: true,
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_3', name: 'page_oncall', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_3',
              content: 'It may or may not have run.',
              is_error: true,
            },
          ],
        },
      ],
      tools: [
        {
          name: 'read_log',
          description: 'Reads a log.',
          input_schema: { type: 'object', properties: { service: { type: 'string' } } },
        },
      ],
      output_config: { effort: 'high' },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    });
  });

  it('sends an assistant turn as its raw content, not as its text and tool calls', () => {
    // Steadfast's reading disagrees with raw here, so only raw can have produced the message.
    const edited: ModelResponse = { ...first, text: 'rewritten', toolCalls: [] };
    const params = toParams(
      {
        system: '',
        transcript: [
          { role: 'user', text: 'hi' },
          { role: 'assistant', response: edited },
        ],
        tools: [],
      },
      settings,
    );
    expect(params.messages[1]).toEqual({ role: 'assistant', content });
    // The very blocks the response kept, not a copy.
    expect(params.messages[1]?.content).toBe(first.raw);
  });

  it('leaves out an empty system, no tools, thinking, and fallbacks when they are off', () => {
    const params = toParams(
      { system: '', transcript: [{ role: 'user', text: 'hi' }], tools: [] },
      { ...settings, fallbacks: false },
    );
    expect(params).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { effort: 'high' },
    });
  });

  it('sends thinking when it is set', () => {
    const params = toParams(
      { system: '', transcript: [{ role: 'user', text: 'hi' }], tools: [] },
      { ...settings, thinking: { type: 'adaptive', display: 'summarized' } },
    );
    expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it("rejects an assistant turn whose raw isn't content blocks, such as a scripted model's", () => {
    const transcript = [
      { role: 'user' as const, text: 'hi' },
      { role: 'assistant' as const, response: say('ok') },
    ];
    expect(() => toParams({ system: '', transcript, tools: [] }, settings)).toThrow(ModelError);
  });
});

describe('fromMessage', () => {
  it('reads text, tool calls, usage and the answering model, and keeps content as raw', () => {
    const response = fromMessage(
      message(content, 'tool_use', {
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
        },
      }),
    );
    expect(response).toEqual<ModelResponse>({
      stop: 'toolUse',
      text: 'Reading the log first.',
      toolCalls: [
        { id: 'toolu_1', name: 'read_log', input: { service: 'checkout' } },
        { id: 'toolu_2', name: 'query_metrics', input: { metric: 'errors' } },
      ],
      // Cached input counts as input, so a token budget sees everything the model read.
      usage: { inputTokens: 420, outputTokens: 40 },
      model: 'claude-opus-4-8',
      raw: content,
    });
  });

  it('joins text blocks with nothing between, as citations split them', () => {
    const response = fromMessage(
      message([
        { type: 'text', text: 'The deploy at 14:02 ' },
        { type: 'text', text: 'broke checkout.', citations: [] },
      ]),
    );
    expect(response.text).toBe('The deploy at 14:02 broke checkout.');
  });

  it.each([
    ['end_turn', 'endTurn'],
    ['tool_use', 'toolUse'],
    ['max_tokens', 'maxOutputTokens'],
    ['refusal', 'refusal'],
  ])('maps stop reason %s to %s', (from, to) => {
    expect(fromMessage(message([], from)).stop).toBe(to);
  });

  it.each(['stop_sequence', 'pause_turn', 'compaction', 'model_context_window_exceeded', null])(
    'makes stop reason %s a ModelError that is not retryable',
    (stop) => {
      const read = () => fromMessage(message([], stop));
      expect(read).toThrow(ModelError);
      expect(read).toThrow(/unexpected stop reason/);
      try {
        read();
      } catch (error) {
        expect((error as ModelError).retryable).toBe(false);
      }
    },
  );

  it("makes a tool_use whose input isn't an object a ModelError", () => {
    const block = { type: 'tool_use', id: 't', name: 'read_log', input: '{"service":"checkout"}' };
    expect(() => fromMessage(message([block], 'tool_use'))).toThrow(/isn't an object/);
    expect(() => fromMessage(message([{ type: 'tool_use', input: {} }], 'tool_use'))).toThrow(
      /no id or name/,
    );
  });

  it("makes content that isn't JSON, or bad usage, a ModelError", () => {
    expect(() => fromMessage(message([{ type: 'text', text: 'x', at: new Date(0) }]))).toThrow(
      /isn't JSON/,
    );
    expect(() =>
      fromMessage(message([], 'end_turn', { usage: { input_tokens: -1, output_tokens: 0 } })),
    ).toThrow(/usage.input_tokens/);
  });
});
