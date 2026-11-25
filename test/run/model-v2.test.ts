// Milestone 2's T1, in a run: a paused response goes straight back to the model, and a tool call
// whose input the adapter couldn't read is an error result without running the tool.

import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelResponse, RunEvent, Turn } from '../../src/index.ts';
import { INTERRUPTED } from '../../src/run/actor.ts';
import { callTool, callTools, pause, say, scriptedModel } from '../../src/testkit/index.ts';
import {
  crashAfter,
  INPUT,
  journalOf,
  makeAgent,
  recordedPersistence,
  recordingTool,
  startRun,
  type Recorded,
} from './helpers.ts';

let kit: TestKit;
let recorded: Recorded;

beforeEach(() => {
  kit = createTestKit();
  recorded = recordedPersistence(() => kit.scheduler.now());
});

afterEach(async () => {
  await kit.shutdown();
});

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

describe('a paused response', () => {
  it('calls the model again with the transcript plus the response, adding no user turn', async () => {
    const paused = pause('Searching the incident history.');
    const done = say('Nothing like it before.');
    const model = scriptedModel([paused, done]);
    const a = makeAgent(kit, recorded.persistence, model);
    const { reporter } = startRun(kit, a);
    await kit.settle();

    const input: Turn = { role: 'user', text: INPUT };
    expect(model.requests.map((r) => r.transcript)).toEqual([
      [input],
      [input, { role: 'assistant', response: paused }],
    ]);
    expect(await journalOf(recorded.persistence, a)).toEqual<RunEvent[]>([
      expect.objectContaining({ type: 'runStarted' }) as RunEvent,
      { type: 'modelResponded', step: 1, response: paused },
      { type: 'modelResponded', step: 2, response: done },
      { type: 'runFinished', outcome: 'completed', text: 'Nothing like it before.' },
    ]);
    reporter.expectMessage((m) => m.outcome === 'completed');
  });

  it('goes back to the model even if it has tool calls, which never run', async () => {
    const readLog = recordingTool('read_log');
    const paused: ModelResponse = { ...callTool('read_log', {}), stop: 'paused' };
    const model = scriptedModel([paused, say('Done.')]);
    const a = makeAgent(kit, recorded.persistence, model, [readLog.tool]);
    startRun(kit, a);
    await kit.settle();
    expect(readLog.calls).toEqual([]);
    expect(model.requests[1]?.transcript.at(-1)).toEqual({ role: 'assistant', response: paused });
  });

  it('counts as a step against maxSteps', async () => {
    const model = scriptedModel([pause(), pause(), say('Never reached.')]);
    const a = makeAgent(kit, recorded.persistence, model, [], { budget: { maxSteps: 2 } });
    const { reporter } = startRun(kit, a);
    await kit.settle();
    expect(model.requests).toHaveLength(2);
    expect((await journalOf(recorded.persistence, a)).at(-1)).toEqual<RunEvent>({
      type: 'runFinished',
      outcome: 'stepsExceeded',
      text: 'The run reached its budget of 2 model calls.',
    });
    expect(recorded.appends.at(-1)).toEqual(['modelResponded', 'runFinished']);
    reporter.expectMessage((m) => m.outcome === 'stepsExceeded');
  });

  it('counts its tokens against maxTokens', async () => {
    const model = scriptedModel([pause('', { usage: usage(60, 40) }), say('Never reached.')]);
    const a = makeAgent(kit, recorded.persistence, model, [], { budget: { maxTokens: 100 } });
    const { reporter } = startRun(kit, a);
    await kit.settle();
    expect(model.requests).toHaveLength(1);
    reporter.expectMessage((m) => m.outcome === 'tokensExceeded');
  });
});

describe('a tool call with an inputError', () => {
  /** A response whose `read_log` call the adapter couldn't read, beside a `query_metrics` call. */
  function badArguments(): ModelResponse {
    const response = callTools([
      { name: 'read_log', input: {} },
      { name: 'query_metrics', input: { metric: 'errors' } },
    ]);
    const [readLog, metrics] = response.toolCalls;
    if (readLog === undefined || metrics === undefined) throw new Error('two calls expected');
    return {
      ...response,
      toolCalls: [
        { ...readLog, input: '{"service": chec', inputError: 'Unexpected token c at 13' },
        metrics,
      ],
    };
  }

  it('becomes an error result, the tool never runs, and the step goes on', async () => {
    const readLog = recordingTool('read_log');
    const metrics = recordingTool('query_metrics');
    const model = scriptedModel([badArguments(), say('I will try again.')]);
    const a = makeAgent(kit, recorded.persistence, model, [readLog.tool, metrics.tool]);
    const { reporter } = startRun(kit, a);
    await kit.settle();

    expect(readLog.calls).toEqual([]);
    expect(metrics.calls).toHaveLength(1);
    expect(model.requests[1]?.transcript.at(-1)).toEqual({
      role: 'toolResults',
      results: [
        {
          callId: 'read_log_1',
          result: { ok: false, error: 'Invalid input for read_log: Unexpected token c at 13' },
        },
        { callId: 'query_metrics_1', result: { ok: true, output: { from: 'query_metrics' } } },
      ],
    });
    reporter.expectMessage((m) => m.outcome === 'completed');
  });

  it('names an unknown tool first, since that is the bigger mistake', async () => {
    const model = scriptedModel([badArguments(), say('Sorry.')]);
    const a = makeAgent(kit, recorded.persistence, model, [recordingTool('query_metrics').tool]);
    startRun(kit, a);
    await kit.settle();
    const last = model.requests[1]?.transcript.at(-1);
    expect(last?.role === 'toolResults' && last.results[0]?.result).toEqual({
      ok: false,
      error: 'There is no tool named "read_log". The tools are: query_metrics.',
    });
  });

  it('is still an error result after a restart, never an interrupted call', async () => {
    // Not idempotent, so a call that was pending at the crash would be reported as interrupted.
    // One with an inputError never ran, and the model hears why.
    const tools = () => [
      recordingTool('read_log', undefined, false).tool,
      recordingTool('query_metrics', undefined, false).tool,
    ];
    const first = makeAgent(
      kit,
      crashAfter(recorded.persistence, 2),
      scriptedModel([badArguments()]),
      tools(),
    );
    startRun(kit, first);
    await kit.settle();
    expect((await journalOf(recorded.persistence, first)).map((e) => e.type)).toEqual([
      'runStarted',
      'modelResponded',
    ]);

    const next = createTestKit();
    try {
      const model = scriptedModel([say('Trying again.')]);
      const a = makeAgent(next, recorded.persistence, model, tools());
      const { reporter } = startRun(next, a);
      await next.settle();
      const last = model.requests[0]?.transcript.at(-1);
      expect(last?.role === 'toolResults' && last.results.map((r) => r.result)).toEqual([
        { ok: false, error: 'Invalid input for read_log: Unexpected token c at 13' },
        { ok: false, error: INTERRUPTED, interrupted: true },
      ]);
      reporter.expectMessage((m) => m.outcome === 'completed');
    } finally {
      await next.shutdown();
    }
  });
});
