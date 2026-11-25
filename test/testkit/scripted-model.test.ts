import { describe, expect, it } from 'vitest';
import { ModelError, type ModelRequest } from '../../src/index.ts';
import { callTool, callTools, pause, say, scriptedModel } from '../../src/testkit/index.ts';

const signal = new AbortController().signal;

function request(text: string): ModelRequest {
  return { system: 'You test.', transcript: [{ role: 'user', text }], tools: [] };
}

describe('scriptedModel', () => {
  it('answers each call with the next entry, in order', async () => {
    const first = callTool('read_log', { service: 'checkout', lines: 50 });
    const second = say('The cause is a bad deploy.');
    const model = scriptedModel([first, second]);
    expect(await model.call(request('a'), { signal })).toBe(first);
    expect(await model.call(request('b'), { signal })).toBe(second);
  });

  it('records every request in order', async () => {
    const model = scriptedModel([say('one'), say('two')]);
    const a = request('a');
    const b = request('b');
    await model.call(a, { signal });
    await model.call(b, { signal });
    expect(model.requests).toEqual([a, b]);
    expect(model.requests[0]).toBe(a);
  });

  it('answers a function entry from the request and the call number', async () => {
    const model = scriptedModel([
      say('first'),
      (req, call) => say(`call ${String(call)} saw ${String(req.transcript.length)} turn`),
      async () => Promise.resolve(say('async')),
    ]);
    await model.call(request('a'), { signal });
    expect((await model.call(request('b'), { signal })).text).toBe('call 2 saw 1 turn');
    expect((await model.call(request('c'), { signal })).text).toBe('async');
  });

  it('throws a ModelError that is not retryable past the end of its script, and records the call', async () => {
    const model = scriptedModel([say('only')]);
    await model.call(request('a'), { signal });
    const error: unknown = await model.call(request('b'), { signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).retryable).toBe(false);
    expect((error as ModelError).message).toBe(
      'scriptedModel: call 2, but the script has 1 entries',
    );
    expect(model.requests).toHaveLength(2);
  });

  it('is not changed by edits to the script array after it is made', async () => {
    const script = [say('kept')];
    const model = scriptedModel(script);
    script.length = 0;
    expect((await model.call(request('a'), { signal })).text).toBe('kept');
  });

  it('is named scripted unless given a name', () => {
    expect(scriptedModel([]).name).toBe('scripted');
    expect(scriptedModel([], { name: 'scripted:triage' }).name).toBe('scripted:triage');
  });
});

describe('responses', () => {
  it('say ends the turn with its text, no calls and no usage', () => {
    expect(say('Done.')).toEqual({
      stop: 'endTurn',
      text: 'Done.',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'scripted',
      raw: { scripted: { stop: 'endTurn', text: 'Done.', toolCalls: [] } },
    });
  });

  it('say takes usage and the answering model', () => {
    const response = say('Done.', { usage: { inputTokens: 10, outputTokens: 5 }, model: 'm' });
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(response.model).toBe('m');
  });

  it('callTool asks for one call, with a default id and optional text', () => {
    const response = callTool('read_log', { service: 'checkout' }, { text: 'Looking.' });
    expect(response.stop).toBe('toolUse');
    expect(response.text).toBe('Looking.');
    expect(response.toolCalls).toEqual([
      { id: 'read_log_1', name: 'read_log', input: { service: 'checkout' } },
    ]);
    expect(response.raw).toEqual({
      scripted: { stop: 'toolUse', text: 'Looking.', toolCalls: response.toolCalls },
    });
    expect(callTool('read_log', null, { id: 'toolu_01' }).toolCalls[0]?.id).toBe('toolu_01');
  });

  it('callTools asks for several calls in order, numbering each tool from 1', () => {
    const response = callTools([
      { name: 'read_log', input: { service: 'checkout' } },
      { name: 'query_metrics', input: { metric: 'errors' } },
      { name: 'read_log', input: { service: 'payments' } },
    ]);
    expect(response.toolCalls.map((c) => c.id)).toEqual([
      'read_log_1',
      'query_metrics_1',
      'read_log_2',
    ]);
  });

  it('callTools throws on no calls and on duplicate ids', () => {
    expect(() => callTools([])).toThrow(RangeError);
    expect(() =>
      callTools([
        { name: 'a', input: 1, id: 'x' },
        { name: 'b', input: 2, id: 'x' },
      ]),
    ).toThrow(/unique/);
  });

  it("streams each response's text a word at a time, in order, before it answers", async () => {
    const text = '  Two  spaces,\na newline, and a tail. ';
    const model = scriptedModel([say(text), async () => Promise.resolve(say('from a function'))]);
    const pieces: string[] = [];
    const onText = (piece: string) => {
      pieces.push(piece);
    };
    const first = await model.call(request('a'), { signal, onText });
    expect(pieces).toEqual(['  Two  ', 'spaces,\n', 'a ', 'newline, ', 'and ', 'a ', 'tail. ']);
    // The pieces are the text, exactly, and the response is whole.
    expect(pieces.join('')).toBe(text);
    expect(first.text).toBe(text);
    pieces.length = 0;
    await model.call(request('b'), { signal, onText });
    expect(pieces).toEqual(['from ', 'a ', 'function']);
  });

  it('streams nothing for a response with no text', async () => {
    const model = scriptedModel([callTool('read_log', {}), pause()]);
    const pieces: string[] = [];
    const onText = (piece: string) => {
      pieces.push(piece);
    };
    await model.call(request('a'), { signal, onText });
    await model.call(request('b'), { signal, onText });
    expect(pieces).toEqual([]);
  });
});

describe('pause', () => {
  it('builds a paused response with no tool calls', () => {
    const paused = pause('Searching.', { usage: { inputTokens: 3, outputTokens: 4 } });
    expect(paused).toMatchObject({
      stop: 'paused',
      text: 'Searching.',
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 4 },
      model: 'scripted',
    });
    expect(pause().text).toBe('');
  });
});
