import { describe, expect, it } from 'vitest';
import { ModelError, type ModelRequest, type ModelResponse } from '../../src/index.ts';
import type { OpenAIResponse } from '../../src/openai/index.ts';
import { fromResponse, toParams } from '../../src/openai/mapping.ts';
import { callItem, reasoningItem, response, textItem } from './fake-client.ts';

const settings = { model: 'gpt-5.6' };

/** A response without one of its optional fields. */
function without(r: OpenAIResponse, key: 'status' | 'usage'): OpenAIResponse {
  return Object.fromEntries(
    Object.entries(r).filter(([k]) => k !== key),
  ) as unknown as OpenAIResponse;
}

function responded(raw: unknown[]): ModelResponse {
  return fromResponse(response(raw));
}

describe('toParams', () => {
  it('maps a transcript to input items: the user turn, output items verbatim, and tool results', () => {
    const first = [
      reasoningItem('rs_1'),
      textItem('Checking.'),
      callItem('call_a', 'read_log', '{"service":"checkout"}'),
      callItem('call_b', 'query_metrics', '{}'),
    ];
    const second = [textItem('A bad deploy.', 'msg_2')];
    const request: ModelRequest = {
      system: 'You triage.',
      transcript: [
        { role: 'user', text: 'Checkout is down.' },
        { role: 'assistant', response: responded(first) },
        {
          role: 'toolResults',
          results: [
            { callId: 'call_a', result: { ok: true, output: { lines: ['502'] } } },
            { callId: 'call_b', result: { ok: false, error: 'timed out' } },
          ],
        },
        { role: 'assistant', response: responded(second) },
      ],
      tools: [
        { name: 'read_log', description: 'Reads a log.', input: { type: 'object' } },
        {
          name: 'query_metrics',
          description: 'Queries metrics.',
          input: { type: 'object', properties: { metric: { type: 'string' } } },
        },
      ],
    };
    const params = toParams(request, settings);
    expect(params).toEqual({
      model: 'gpt-5.6',
      instructions: 'You triage.',
      input: [
        { role: 'user', content: 'Checkout is down.' },
        ...first,
        { type: 'function_call_output', call_id: 'call_a', output: '{"lines":["502"]}' },
        { type: 'function_call_output', call_id: 'call_b', output: '{"error":"timed out"}' },
        ...second,
      ],
      tools: [
        {
          type: 'function',
          name: 'read_log',
          description: 'Reads a log.',
          parameters: { type: 'object' },
          strict: false,
        },
        {
          type: 'function',
          name: 'query_metrics',
          description: 'Queries metrics.',
          parameters: { type: 'object', properties: { metric: { type: 'string' } } },
          strict: false,
        },
      ],
      store: false,
      include: ['reasoning.encrypted_content'],
    });
    // The very items that came, not copies rebuilt from Steadfast's reading of them.
    const input = params.input as unknown[];
    const raw = (request.transcript[1] as { response: ModelResponse }).response.raw as unknown[];
    raw.forEach((item, i) => {
      expect(input[1 + i]).toBe(item);
    });
  });

  it('leaves out an empty system text and an empty tool list', () => {
    const params = toParams(
      { system: '', transcript: [{ role: 'user', text: 'Hi.' }], tools: [] },
      settings,
    );
    expect(params).not.toHaveProperty('instructions');
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('max_output_tokens');
    expect(params).not.toHaveProperty('reasoning');
  });

  it('sends max_output_tokens and reasoning.effort when they are set', () => {
    const params = toParams(
      { system: '', transcript: [{ role: 'user', text: 'Hi.' }], tools: [] },
      { model: 'gpt-5.6', maxTokens: 8_000, effort: 'low' },
    );
    expect(params).toMatchObject({ max_output_tokens: 8_000, reasoning: { effort: 'low' } });
  });

  it("refuses an assistant turn whose raw isn't a list of items", () => {
    const turn: ModelResponse = {
      stop: 'endTurn',
      text: 'ok',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'scripted',
      raw: { not: 'a list' },
    };
    expect(() =>
      toParams(
        { system: '', transcript: [{ role: 'assistant', response: turn }], tools: [] },
        settings,
      ),
    ).toThrow(ModelError);
  });
});

describe('fromResponse', () => {
  it('reads a completed response with no calls as endTurn, joining its text', () => {
    const output = [
      reasoningItem('rs_1'),
      {
        ...textItem('Checkout '),
        content: [
          { type: 'output_text', text: 'Checkout ', annotations: [] },
          { type: 'output_text', text: 'is down.', annotations: [] },
        ],
      },
    ];
    const mapped = fromResponse(response(output, { model: 'gpt-5.6-2026-10-01' }));
    expect(mapped).toEqual<ModelResponse>({
      stop: 'endTurn',
      text: 'Checkout is down.',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      model: 'gpt-5.6-2026-10-01',
      raw: output,
    });
    expect(mapped.raw).toBe(output);
  });

  it('reads function_call items as tool calls by call_id, as toolUse', () => {
    const mapped = responded([
      textItem('Reading.'),
      callItem('call_a', 'read_log', '{"service":"checkout"}'),
      callItem('call_b', 'query_metrics', '{}'),
    ]);
    expect(mapped.stop).toBe('toolUse');
    expect(mapped.toolCalls).toEqual([
      { id: 'call_a', name: 'read_log', input: { service: 'checkout' } },
      { id: 'call_b', name: 'query_metrics', input: {} },
    ]);
  });

  it("gives an inputError, with the arguments as they came, for arguments that aren't JSON", () => {
    const mapped = responded([
      callItem('call_a', 'read_log', '{"service": "checkout"'),
      callItem('call_b', 'read_log', '[1, 2]'),
    ]);
    expect(mapped.stop).toBe('toolUse');
    expect(mapped.toolCalls).toEqual([
      {
        id: 'call_a',
        name: 'read_log',
        input: '{"service": "checkout"',
        inputError: "The arguments aren't valid JSON.",
      },
      {
        id: 'call_b',
        name: 'read_log',
        input: '[1, 2]',
        inputError: "The arguments aren't a JSON object.",
      },
    ]);
  });

  it('reads a refusal part as refusal, even beside other output', () => {
    const mapped = responded([
      {
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: "I can't help with that." }],
      },
    ]);
    expect(mapped).toMatchObject({ stop: 'refusal', text: '' });
  });

  it('reads incomplete responses by their reason', () => {
    const cut = fromResponse(
      response([textItem('The cause is')], {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    );
    expect(cut).toMatchObject({ stop: 'maxOutputTokens', text: 'The cause is' });
    const filtered = fromResponse(
      response([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
    );
    expect(filtered.stop).toBe('refusal');
    // A response without a status is read from its incomplete_details.
    const noStatus = without(
      response([], { incomplete_details: { reason: 'max_output_tokens' } }),
      'status',
    );
    expect(fromResponse(noStatus).stop).toBe('maxOutputTokens');
    expect(fromResponse({ ...noStatus, incomplete_details: null }).stop).toBe('endTurn');
  });

  it('throws an incomplete reason or a status it does not handle, as not retryable', () => {
    for (const bad of [
      response([], { status: 'incomplete', incomplete_details: { reason: 'max_messages' } }),
      response([], { status: 'incomplete', incomplete_details: {} }),
      response([], { status: 'in_progress' }),
      response([], { status: 'cancelled' }),
    ]) {
      expect(() => fromResponse(bad)).toThrow(expect.objectContaining({ retryable: false }));
    }
  });

  it('throws a failed response, retryable only for a server error or a rate limit', () => {
    const failed = (code: string) =>
      response([], { status: 'failed', error: { code, message: `${code} happened` } });
    for (const [code, retryable] of [
      ['server_error', true],
      ['rate_limit_exceeded', true],
      ['invalid_prompt', false],
    ] as const) {
      expect(() => fromResponse(failed(code))).toThrow(
        expect.objectContaining({
          name: 'ModelError',
          retryable,
          message: `OpenAI: the response failed (${code}): ${code} happened`,
        }),
      );
    }
    expect(() => fromResponse(response([], { status: 'failed' }))).toThrow(
      expect.objectContaining({
        retryable: false,
        message: expect.stringContaining('unknown') as unknown,
      }),
    );
  });

  it("doesn't add cached tokens to input_tokens, which already count them", () => {
    const usage = {
      input_tokens: 1_000,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 800 },
    };
    expect(fromResponse(response([textItem('ok')], { usage })).usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 50,
    });
    const noUsage = without(response([textItem('ok')]), 'usage');
    expect(fromResponse(noUsage).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('throws malformed output and usage as not retryable', () => {
    const bad = [
      response([callItem('call_a', 'read_log', '{}')], {
        usage: { input_tokens: -1, output_tokens: 0 },
      }),
      response([{ type: 'function_call', name: 'read_log', arguments: '{}' }]),
      response([{ type: 'function_call', call_id: 'call_a', name: 'read_log', arguments: {} }]),
      response([{ type: 'message', content: [{ type: 'output_text', text: Number.NaN }] }]),
    ];
    for (const r of bad) {
      expect(() => fromResponse(r)).toThrow(expect.objectContaining({ retryable: false }));
    }
  });

  it('skips items and parts it has no use for', () => {
    const mapped = responded([
      'not an item',
      { type: 'web_search_call', id: 'ws_1' },
      { type: 'message', content: 'not a list' },
      { type: 'message', content: [null, { type: 'output_text', text: 'ok' }] },
    ]);
    expect(mapped).toMatchObject({ stop: 'endTurn', text: 'ok', toolCalls: [] });
  });
});
