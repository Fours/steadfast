import { describe, expect, it } from 'vitest';
import type { ModelRequest, ModelResponse, Turn } from '../../src/index.ts';
import {
  badRequest,
  callTool,
  faultyModel,
  overloaded,
  rateLimited,
  say,
  scriptedModel,
} from '../../src/testkit/index.ts';

const signal = new AbortController().signal;

/** A request for `step`: the input, then one assistant turn per step already answered. */
function requestFor(step: number): ModelRequest {
  const transcript: Turn[] = [{ role: 'user', text: 'Checkout is returning 502s.' }];
  for (let i = 1; i < step; i++) {
    transcript.push({ role: 'assistant', response: callTool('read_log', i) });
    transcript.push({
      role: 'toolResults',
      results: [{ callId: 'read_log_1', result: { ok: true, output: 'ok' } }],
    });
  }
  return { system: 'You triage.', transcript, tools: [] };
}

async function outcome(promise: Promise<ModelResponse>): Promise<ModelResponse | Error> {
  return promise.catch((e: unknown) => e as Error);
}

describe('faultyModel', () => {
  it('fails exactly the faulted step attempts, with the given errors in order, and passes the rest through', async () => {
    const limited = rateLimited({ retryAfterMs: 2_000 });
    const busy = overloaded();
    const inner = scriptedModel([say('one'), say('two'), say('three')]);
    const model = faultyModel(inner, { step: 2, fail: [limited, busy] });

    expect(await outcome(model.call(requestFor(1), signal))).toEqual(say('one'));
    expect(await outcome(model.call(requestFor(2), signal))).toBe(limited);
    expect(await outcome(model.call(requestFor(2), signal))).toBe(busy);
    expect(await outcome(model.call(requestFor(2), signal))).toEqual(say('two'));
    expect(await outcome(model.call(requestFor(3), signal))).toEqual(say('three'));

    // The inner model sees only the calls that passed.
    expect(inner.requests).toEqual([requestFor(1), requestFor(2), requestFor(3)]);
  });

  it('takes several faults, one per step', async () => {
    const first = badRequest();
    const third = rateLimited();
    const inner = scriptedModel([say('one'), say('two'), say('three')]);
    const model = faultyModel(inner, [
      { step: 1, fail: [first] },
      { step: 3, fail: [third] },
    ]);
    expect(await outcome(model.call(requestFor(1), signal))).toBe(first);
    expect(await outcome(model.call(requestFor(1), signal))).toEqual(say('one'));
    expect(await outcome(model.call(requestFor(2), signal))).toEqual(say('two'));
    expect(await outcome(model.call(requestFor(3), signal))).toBe(third);
    expect(await outcome(model.call(requestFor(3), signal))).toEqual(say('three'));
  });

  it('passes the signal through and keeps the inner model name', async () => {
    let seen: AbortSignal | undefined;
    const inner = {
      name: 'inner',
      call: async (_req: ModelRequest, s: AbortSignal) => {
        seen = s;
        return Promise.resolve(say('ok'));
      },
    };
    const model = faultyModel(inner, []);
    expect(model.name).toBe('inner');
    await model.call(requestFor(1), signal);
    expect(seen).toBe(signal);
  });

  it('throws on a step that is not a positive integer, or given twice', () => {
    const inner = scriptedModel([]);
    expect(() => faultyModel(inner, { step: 0, fail: [] })).toThrow(RangeError);
    expect(() => faultyModel(inner, { step: 1.5, fail: [] })).toThrow(RangeError);
    expect(() =>
      faultyModel(inner, [
        { step: 2, fail: [] },
        { step: 2, fail: [] },
      ]),
    ).toThrow(/twice/);
  });
});
