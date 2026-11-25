import { describe, expect, it } from 'vitest';
import {
  FALLBACK_BETA,
  fromMessage,
  resendable,
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
  serverTools: [],
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
    ['pause_turn', 'paused'],
  ])('maps stop reason %s to %s', (from, to) => {
    expect(fromMessage(message([], from)).stop).toBe(to);
  });

  it('reads a paused turn as paused, and sends it back as the last message, verbatim', () => {
    const paused = [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
      { type: 'text', text: 'Still searching.' },
    ];
    const response = fromMessage(message(paused, 'pause_turn'));
    expect(response.stop).toBe('paused');
    expect(response.raw).toEqual(paused);
    expect(response.toolCalls).toEqual([]);
    const params = toParams(
      {
        system: '',
        transcript: [
          { role: 'user', text: 'Search.' },
          { role: 'assistant', response },
        ],
        tools: [],
      },
      settings,
    );
    // Nothing follows it: the API resumes from the paused content itself.
    expect(params.messages.at(-1)).toEqual({ role: 'assistant', content: paused });
  });

  it.each(['stop_sequence', 'compaction', 'model_context_window_exceeded', null])(
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

// A streamed response where the requested model declined partway and a fallback model finished.
// Each block before the fallback is labelled with what the resend rule does to it.
const fallbackBlock = {
  type: 'fallback',
  from: { model: 'claude-opus-5-5' },
  to: { model: 'claude-opus-4-8' },
  trigger: { type: 'refusal', category: 'cyber' },
};
const declinedThinking = { type: 'thinking', thinking: '', signature: 'sig-declined' };
const declinedRedacted = { type: 'redacted_thinking', data: 'opaque' };
const declinedConnector = { type: 'connector_text', text: 'from a connector' };
const declinedText = { type: 'text', text: 'Step one is to ' };
const pairedSearch = {
  type: 'server_tool_use',
  id: 'srvtoolu_1',
  name: 'web_search',
  input: { query: 'cve' },
};
const pairedResult = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] };
const unpairedSearch = {
  type: 'server_tool_use',
  id: 'srvtoolu_2',
  name: 'web_search',
  input: { query: 'exploit' },
};
const declinedToolUse = { type: 'tool_use', id: 'toolu_declined', name: 'read_log', input: {} };
const answerThinking = { type: 'thinking', thinking: '', signature: 'sig-fallback' };
const answerText = { type: 'text', text: 'I can help with the defensive part.' };
const answerToolUse = {
  type: 'tool_use',
  id: 'toolu_answer',
  name: 'read_log',
  input: { service: 'auth' },
};
const midOutput = [
  declinedThinking,
  declinedRedacted,
  declinedConnector,
  declinedText,
  pairedSearch,
  pairedResult,
  unpairedSearch,
  declinedToolUse,
  fallbackBlock,
  answerThinking,
  answerText,
  answerToolUse,
];

describe('a response with a fallback', () => {
  it('keeps raw exactly as it came', () => {
    const response = fromMessage(message(midOutput, 'tool_use', { model: 'claude-opus-4-8' }));
    expect(response.raw).toEqual(midOutput);
    expect(response.model).toBe('claude-opus-4-8');
  });

  it('reads text and tool calls only from blocks after the last fallback block', () => {
    const response = fromMessage(message(midOutput, 'tool_use'));
    expect(response.text).toBe('I can help with the defensive part.');
    expect(response.toolCalls).toEqual([
      { id: 'toolu_answer', name: 'read_log', input: { service: 'auth' } },
    ]);

    const twice = fromMessage(
      message([
        { type: 'text', text: 'first ' },
        fallbackBlock,
        { type: 'text', text: 'second ' },
        fallbackBlock,
        { type: 'text', text: 'third' },
      ]),
    );
    expect(twice.text).toBe('third');
  });

  it('goes back with the blocks the rule leaves out removed, and the rest in place', () => {
    expect(resendable(midOutput)).toEqual([
      declinedText,
      pairedSearch,
      pairedResult,
      fallbackBlock,
      answerThinking,
      answerText,
      answerToolUse,
    ]);
  });

  it('applies the rule only before the last fallback block, keeping every fallback block', () => {
    const content = [
      declinedThinking,
      { type: 'text', text: 'a' },
      fallbackBlock,
      declinedRedacted,
      { type: 'text', text: 'b' },
      fallbackBlock,
      answerThinking,
      unpairedSearch,
      answerText,
    ];
    expect(resendable(content)).toEqual([
      { type: 'text', text: 'a' },
      fallbackBlock,
      { type: 'text', text: 'b' },
      fallbackBlock,
      answerThinking,
      unpairedSearch,
      answerText,
    ]);
  });

  it("sends a turn back through the rule, from the response's raw", () => {
    const response = fromMessage(message(midOutput, 'tool_use'));
    const params = toParams(
      {
        system: '',
        transcript: [
          { role: 'user', text: 'Audit the auth service.' },
          { role: 'assistant', response },
        ],
        tools: [],
      },
      settings,
    );
    expect(params.messages[1]).toEqual({ role: 'assistant', content: resendable(midOutput) });
    // The journaled response is untouched by the mapping.
    expect(response.raw).toEqual(midOutput);
  });

  it('leaves a turn with no fallback block as the very array it came as', () => {
    expect(resendable(content)).toBe(content);
  });
});

describe('server tools', () => {
  const webSearch = { type: 'web_search_20260318', name: 'web_search', max_uses: 3 };

  it('reach the request as written, after the agent tools', () => {
    const params = toParams(request, { ...settings, serverTools: [webSearch] });
    expect(params.tools).toEqual([
      {
        name: 'read_log',
        description: 'Reads a log.',
        input_schema: { type: 'object', properties: { service: { type: 'string' } } },
      },
      webSearch,
    ]);
    const alone = toParams(
      { system: '', transcript: [{ role: 'user', text: 'hi' }], tools: [] },
      { ...settings, serverTools: [webSearch] },
    );
    expect(alone.tools).toEqual([webSearch]);
  });

  it('come back in raw, and their blocks go back unchanged', () => {
    const blocks = [pairedSearch, pairedResult, unpairedSearch, answerText];
    const response = fromMessage(message(blocks, 'pause_turn'));
    expect(response.raw).toEqual(blocks);
    const params = toParams(
      {
        system: '',
        transcript: [
          { role: 'user', text: 'Search.' },
          { role: 'assistant', response },
        ],
        tools: [],
      },
      { ...settings, serverTools: [webSearch] },
    );
    expect(params.messages[1]?.content).toBe(response.raw);
  });
});
