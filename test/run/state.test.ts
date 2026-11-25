import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent, RunState } from '../../src/index.ts';
import { initialState, onEvent } from '../../src/run/state.ts';
import { callTool, callTools, say, scriptedModel } from '../../src/testkit/index.ts';
import { journalOf, makeAgent, recordedPersistence, recordingTool, startRun } from './helpers.ts';

let kit: TestKit;

beforeEach(() => {
  kit = createTestKit();
});

afterEach(async () => {
  await kit.shutdown();
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const fold = (events: readonly RunEvent[]): RunState => events.reduce(onEvent, initialState);

/** Folds with every state frozen as it's made, so a fold that changed a state it was given throws. */
const frozenFold = (events: readonly RunEvent[]): RunState =>
  events.reduce(
    (state, event) => deepFreeze(onEvent(state, event)),
    deepFreeze(structuredClone(initialState)),
  );

/** The events of a real run with parallel tools, a failed attempt and a finish. */
async function recordedEvents(): Promise<RunEvent[]> {
  const { persistence } = recordedPersistence(() => kit.scheduler.now());
  const model = scriptedModel([
    callTools([
      { name: 'read_log', input: { service: 'checkout' } },
      { name: 'query_metrics', input: { metric: 'errors' } },
    ]),
    callTool('read_log', { service: 'gateway' }),
    say('A bad deploy.', { usage: { inputTokens: 5, outputTokens: 1 } }),
  ]);
  const tools = [recordingTool('read_log').tool, recordingTool('query_metrics').tool];
  const a = makeAgent(kit, persistence, model, tools);
  startRun(kit, a);
  await kit.settle();
  const events = await journalOf(persistence, a);
  // An attempt in the middle, as a retried call would leave.
  events.splice(2, 0, {
    type: 'attemptFailed',
    step: 1,
    target: { kind: 'tool', callId: 'read_log_1' },
    error: { message: 'Connection reset' },
  });
  return events;
}

describe('onEvent', () => {
  it('is pure: folding the same events twice gives equal states, and changes nothing it was given', async () => {
    const events = deepFreeze(await recordedEvents());
    const copy = structuredClone(events);
    // Frozen inputs: a fold that mutated its state or an event would throw here.
    const first = frozenFold(events);
    const second = frozenFold(events);
    expect(fold(events)).toEqual(first);
    expect(second).toEqual(first);
    expect(events).toEqual(copy);
    expect(initialState).toEqual({
      phase: 'new',
      input: '',
      startedAt: 0,
      limits: {},
      transcript: [],
      step: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      treeUsage: { inputTokens: 0, outputTokens: 0 },
      pending: { kind: 'none' },
      stepResults: [],
      attempts: {},
    });
    expect(first).toMatchObject({
      phase: 'finished',
      step: 3,
      outcome: 'completed',
      text: 'A bad deploy.',
      attempts: { '1:tool:read_log_1': 1 },
      stepResults: [],
    });
  });

  it('folds every prefix of the journal to a state that is a JSON value', async () => {
    const events = await recordedEvents();
    for (let n = 0; n <= events.length; n++) {
      const state = fold(events.slice(0, n));
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    }
  });

  it('keeps tool results back until the step’s last one is in', () => {
    const started: RunEvent = {
      type: 'runStarted',
      agent: 'triage',
      model: 'scripted',
      input: 'Go',
      startedAt: 0,
    };
    const response = callTools([
      { name: 'a', input: {} },
      { name: 'b', input: {} },
    ]);
    const s1 = fold([started, { type: 'modelResponded', step: 1, response }]);
    const s2 = onEvent(s1, {
      type: 'toolFinished',
      step: 1,
      callId: 'b_1',
      result: { ok: true, output: 2 },
    });
    expect(s2.transcript).toHaveLength(s1.transcript.length);
    expect(s2.pending).toEqual({ kind: 'tools', callIds: ['a_1'] });
    expect(s2.stepResults).toEqual([{ callId: 'b_1', result: { ok: true, output: 2 } }]);
  });

  it('ignores a tool result the state isn’t waiting on, rather than throwing', () => {
    const state = fold([
      { type: 'runStarted', agent: 'triage', model: 'scripted', input: 'Go', startedAt: 0 },
    ]);
    const event: RunEvent = {
      type: 'toolFinished',
      step: 1,
      callId: 'nope',
      result: { ok: true, output: null },
    };
    expect(onEvent(state, event)).toBe(state);
  });
});
