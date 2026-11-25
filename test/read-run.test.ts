// T7: readRun. The oracle is Troupe itself: Backstage's `stateAt` folds the live run actor's own
// journal through the definition the actor runs, so readRun agreeing with it at every sequence
// number means it shows what the run had then.

import { backstage, encode } from '@kylewillett/troupe/backstage';
import { inMemoryPersistence, type Persistence } from '@kylewillett/troupe/persistence';
import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agent,
  readRun,
  type Agent,
  type JsonValue,
  type Model,
  type RunTimeline,
  type TimelineStep,
} from '../src/index.ts';
import { INTERRUPTED } from '../src/run/actor.ts';
import { initialState } from '../src/run/state.ts';
import {
  callTool,
  callTools,
  faultyModel,
  rateLimited,
  say,
  scriptedModel,
} from '../src/testkit/index.ts';
import {
  journalOf,
  makeAgent,
  PAST_BACKOFF,
  recordingTool,
  RUN_ID,
  startRun,
  SYSTEM,
} from './run/helpers.ts';

const kits: TestKit[] = [];

function newKit(): TestKit {
  const kit = createTestKit();
  kits.push(kit);
  return kit;
}

afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.shutdown();
});

/** A model that must never be called: readRun reads, and never asks. */
function untouchable(): Model & { calls: number } {
  const model = {
    name: 'scripted',
    calls: 0,
    call(): Promise<never> {
      model.calls++;
      return Promise.reject(new Error('readRun called the model'));
    },
  };
  return model;
}

/** The same agent as the run's, but with a model that throws if it's called. */
function readerOf(persistence: Persistence, model: Model): Agent {
  return agent({ name: 'triage', model, system: SYSTEM, persistence, clock: () => 0 });
}

const SCRIPT = [
  callTools([
    { name: 'read_log', input: { service: 'checkout' }, id: 'toolu_1a' },
    { name: 'query_metrics', input: { metric: '5xx' }, id: 'toolu_1b' },
  ]),
  callTool('page_oncall', { team: 'payments' }, { id: 'toolu_2a' }),
  say('Paged payments about the bad deploy.'),
];

/**
 * A run with a bit of everything: tools at the same time, a tool that fails once and is retried,
 * a rate-limited model call, and a crash while a tool that isn't idempotent is in flight. It's
 * resumed in a second kit, whose live run actor is returned for Backstage to read.
 */
async function recordedRun(): Promise<{ persistence: Persistence; kit: TestKit }> {
  const persistence = inMemoryPersistence({ clock: () => 0 });
  let metricsCalls = 0;
  const readLog = recordingTool('read_log');
  const metrics = recordingTool('query_metrics', () =>
    ++metricsCalls === 1
      ? Promise.reject(new Error('metrics store unavailable'))
      : Promise.resolve({ rate: 0.31 }),
  );
  const page = recordingTool('page_oncall', () => new Promise<JsonValue>(() => undefined), false);
  const tools = [readLog.tool, metrics.tool, page.tool];
  const model = faultyModel(scriptedModel(SCRIPT), {
    step: 2,
    fail: [rateLimited({ retryAfterMs: 2_000 })],
  });

  const first = newKit();
  startRun(first, makeAgent(first, persistence, model, tools));
  await first.settle();
  await first.advance(PAST_BACKOFF);
  await first.advance(PAST_BACKOFF);
  expect(page.calls).toHaveLength(1);
  await first.shutdown();

  const second = newKit();
  startRun(second, makeAgent(second, persistence, scriptedModel(SCRIPT.slice(2)), tools));
  await second.settle();
  return { persistence, kit: second };
}

describe('readRun', () => {
  it('gives the state the run had after every event, and calls no model', async () => {
    const { persistence, kit } = await recordedRun();
    const events = await journalOf(persistence, makeAgent(kit, persistence, untouchable()));
    expect(events.map((e) => e.type)).toEqual([
      'runStarted',
      'modelResponded',
      'toolFinished',
      'attemptFailed',
      'toolFinished',
      'attemptFailed',
      'modelResponded',
      'toolFinished',
      'modelResponded',
      'runFinished',
    ]);

    const model = untouchable();
    const reader = readerOf(persistence, model);
    const source = backstage(kit.system);
    const path = `/user/${RUN_ID}`;
    for (let seq = 0; seq <= events.length; seq++) {
      const timeline = await readRun(reader, RUN_ID, { upTo: seq });
      const troupe = await source.request({ type: 'stateAt', path, seq });
      expect(troupe.ok, `stateAt ${String(seq)}`).toBe(true);
      if (!troupe.ok || troupe.type !== 'stateAt') continue;
      expect(encode(timeline.state), `after event ${String(seq)}`).toEqual(troupe.state);
      expect(timeline.events.map((e) => e.event)).toEqual(events.slice(0, seq));
      expect(timeline.events.map((e) => e.seq)).toEqual(events.slice(0, seq).map((_, i) => i + 1));
    }

    // The whole run is the live actor's state now.
    const whole = await readRun(reader, RUN_ID);
    const live = await source.request({ type: 'state', path });
    expect(live.ok && live.type === 'state' ? live.state : undefined).toEqual(
      encode({ seq: events.length, state: whole.state }),
    );
    expect(whole.state.outcome).toBe('completed');
    expect(model.calls).toBe(0);
    source.close();
  });

  it('groups the events by step', async () => {
    const { persistence } = await recordedRun();
    const { steps } = await readRun(readerOf(persistence, untouchable()), RUN_ID);
    expect(steps).toEqual<TimelineStep[]>([
      {
        step: 1,
        attempts: [],
        response: SCRIPT[0] as never,
        responseSeq: 2,
        tools: [
          {
            callId: 'toolu_1a',
            name: 'read_log',
            input: { service: 'checkout' },
            attempts: [],
            result: { ok: true, output: { from: 'read_log' } },
            resultSeq: 3,
          },
          {
            callId: 'toolu_1b',
            name: 'query_metrics',
            input: { metric: '5xx' },
            attempts: [{ seq: 4, error: { message: 'metrics store unavailable' } }],
            result: { ok: true, output: { rate: 0.31 } },
            resultSeq: 5,
          },
        ],
      },
      {
        step: 2,
        attempts: [{ seq: 6, error: { message: expect.stringContaining('ate limit') as never } }],
        response: SCRIPT[1] as never,
        responseSeq: 7,
        tools: [
          {
            callId: 'toolu_2a',
            name: 'page_oncall',
            input: { team: 'payments' },
            attempts: [],
            result: { ok: false, error: INTERRUPTED, interrupted: true },
            resultSeq: 8,
          },
        ],
      },
      { step: 3, attempts: [], response: SCRIPT[2] as never, responseSeq: 9, tools: [] },
    ]);
  });

  it('shows a step the model hasn’t answered, and tool calls still running', async () => {
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const kit = newKit();
    const model = faultyModel(scriptedModel(SCRIPT), {
      step: 1,
      fail: [rateLimited(), rateLimited()],
    });
    startRun(kit, makeAgent(kit, persistence, model, [recordingTool('read_log').tool]));
    await kit.settle();
    await kit.advance(PAST_BACKOFF);
    await kit.shutdown();

    const reader = readerOf(persistence, untouchable());
    // After two failed attempts at step 1, before its response.
    const waiting = await readRun(reader, RUN_ID, { upTo: 3 });
    expect(waiting.state.pending).toEqual({ kind: 'model' });
    expect(waiting.steps).toHaveLength(1);
    expect(waiting.steps[0]?.attempts.map((a) => a.seq)).toEqual([2, 3]);
    expect(waiting.steps[0]?.response).toBeUndefined();

    // After the response, with one of its two tool calls in. This agent has no query_metrics, so
    // that call's result is known at once, ahead of read_log's.
    const running = await readRun(reader, RUN_ID, { upTo: 5 });
    expect(running.steps[0]?.tools.map((t) => [t.name, t.result?.ok])).toEqual([
      ['read_log', undefined],
      ['query_metrics', false],
    ]);
  });

  it('reads an empty journal as a run that hasn’t started', async () => {
    const reader = readerOf(inMemoryPersistence(), untouchable());
    expect(await readRun(reader, 'never-run')).toEqual<RunTimeline>({
      state: initialState,
      events: [],
      steps: [],
    });
  });

  it('reads past a page of events', async () => {
    // More events than one journal read returns, so readRun has to page.
    const calls = Array.from({ length: 300 }, (_, i) => ({
      name: 'read_log',
      input: { n: i },
      id: `toolu_${String(i)}`,
    }));
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const kit = newKit();
    const model = scriptedModel([callTools(calls), say('Read them all.')]);
    startRun(kit, makeAgent(kit, persistence, model, [recordingTool('read_log').tool]));
    await kit.settle();

    const timeline = await readRun(readerOf(persistence, untouchable()), RUN_ID);
    expect(timeline.events).toHaveLength(304);
    expect(timeline.steps[0]?.tools.every((t) => t.result?.ok === true)).toBe(true);
    expect(timeline.state.outcome).toBe('completed');
  });

  it('rejects an upTo past the end of the journal', async () => {
    const reader = readerOf(inMemoryPersistence(), untouchable());
    await expect(readRun(reader, RUN_ID, { upTo: 1 })).rejects.toThrow(
      new RangeError('readRun: run-triage-incident-4211 ends at event 0, before 1'),
    );
  });

  it('throws at once for bad arguments', () => {
    const reader = readerOf(inMemoryPersistence(), untouchable());
    expect(() => readRun(reader, '')).toThrow(TypeError);
    expect(() => readRun(reader, RUN_ID, { upTo: -1 })).toThrow(
      'readRun: upTo must be a non-negative integer, got -1',
    );
    expect(() => readRun(reader, RUN_ID, { upTo: 1.5 })).toThrow(TypeError);
    // @ts-expect-error: a typo in an option is caught.
    expect(() => readRun(reader, RUN_ID, { upto: 3 })).toThrow('readRun: unknown option "upto"');
    // @ts-expect-error: options must be an object.
    expect(() => readRun(reader, RUN_ID, null)).toThrow(TypeError);
  });

  it('keeps a tool event for a call no response made, rather than throwing', async () => {
    // The run never journals one, but a reader shouldn't throw on a journal it didn't write.
    const persistence = inMemoryPersistence();
    const reader = readerOf(persistence, untouchable());
    await persistence.journal.append(reader.persistenceId(RUN_ID), 0, [
      {
        version: 1,
        tags: [],
        event: { type: 'runStarted', agent: 'triage', model: 'scripted', input: 'x', startedAt: 0 },
      },
      {
        version: 1,
        tags: [],
        event: {
          type: 'attemptFailed',
          step: 1,
          target: { kind: 'tool', callId: 'toolu_x' },
          error: { message: 'stray' },
        },
      },
    ]);
    const { steps } = await readRun(reader, RUN_ID);
    expect(steps[0]?.tools).toEqual([
      {
        callId: 'toolu_x',
        name: '',
        input: null,
        attempts: [{ seq: 2, error: { message: 'stray' } }],
      },
    ]);
  });

  it('refuses a journal with a gap in it', async () => {
    const base = inMemoryPersistence();
    const persistence: Persistence = {
      journal: {
        ...base.journal,
        read: () =>
          Promise.resolve([
            {
              persistenceId: 'x',
              seq: 2,
              offset: 1,
              timestamp: 0,
              version: 1,
              tags: [],
              event: { type: 'runFinished' },
            },
          ]),
      },
    };
    await expect(readRun(readerOf(persistence, untouchable()), RUN_ID)).rejects.toThrow(
      'readRun: run-triage-incident-4211 skips from event 0 to 2',
    );
  });
});
