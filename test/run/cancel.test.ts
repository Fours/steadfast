// T5: cancel. It finishes the run with `cancelled`, stops its children, which aborts their
// signals, and nothing they report afterwards changes the run.

import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue, ModelRequest, RunEvent } from '../../src/index.ts';
import { callTool, say, scriptedModel } from '../../src/testkit/index.ts';
import {
  deferred,
  journalOf,
  makeAgent,
  recordedPersistence,
  recordingTool,
  startRun,
  statusOf,
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

const CANCELLED: RunEvent = {
  type: 'runFinished',
  outcome: 'cancelled',
  text: 'Cancelled: the incident was resolved',
};

describe('cancel', () => {
  it('finishes the run, aborts its tool calls, and ignores what they report afterwards', async () => {
    const late = deferred<JsonValue>();
    const readLog = recordingTool('read_log', () => late.promise);
    const model = scriptedModel([callTool('read_log', {}, { id: 'toolu_1' }), say('Unused.')]);
    const a = makeAgent(kit, recorded.persistence, model, [readLog.tool]);
    const { ref, reporter } = startRun(kit, a);
    await kit.settle();
    expect(readLog.calls).toHaveLength(1);

    ref.tell({ type: 'cancel', reason: 'the incident was resolved' });
    await kit.settle();
    reporter.expectMessage((m) => m.outcome === 'cancelled' && m.text === CANCELLED.text);
    expect(readLog.calls[0]?.ctx.signal.aborted).toBe(true);

    // The tool finishes anyway, and an old report turns up: neither is journaled.
    late.resolve({ lines: [] });
    ref.tell({ type: 'toolReturned', step: 1, callId: 'toolu_1', result: { ok: true, output: 1 } });
    await kit.settle();
    const events = await journalOf(recorded.persistence, a);
    expect(events.map((e) => e.type)).toEqual(['runStarted', 'modelResponded', 'runFinished']);
    expect(events.at(-1)).toEqual(CANCELLED);
    expect(model.requests).toHaveLength(1);
    expect(await statusOf(kit, ref)).toMatchObject({ phase: 'finished', outcome: 'cancelled' });
  });

  it('aborts a model call that’s in flight, and its answer is ignored', async () => {
    const answer = deferred<ReturnType<typeof say>>();
    let signal: AbortSignal | undefined;
    const model = {
      name: 'slow',
      requests: [] as ModelRequest[],
      call(request: ModelRequest, s: AbortSignal) {
        model.requests.push(request);
        signal = s;
        return answer.promise;
      },
    };
    const a = makeAgent(kit, recorded.persistence, model);
    const { ref, reporter } = startRun(kit, a);
    await kit.settle();
    expect(signal?.aborted).toBe(false);

    ref.tell({ type: 'cancel', reason: 'the incident was resolved' });
    await kit.settle();
    reporter.expectMessage((m) => m.outcome === 'cancelled');
    expect(signal?.aborted).toBe(true);

    answer.resolve(say('Too late.'));
    ref.tell({ type: 'modelReplied', step: 1, response: say('Also too late.') });
    await kit.settle();
    expect((await journalOf(recorded.persistence, a)).map((e) => e.type)).toEqual([
      'runStarted',
      'runFinished',
    ]);
  });

  it('before the run starts journals the start and the cancel in one write, and calls nothing', async () => {
    const model = scriptedModel([say('Unused.')]);
    const a = makeAgent(kit, recorded.persistence, model);
    const { ref, reporter } = startRun(kit, a);
    // Sent during recovery, so it's ahead of `start` in the mailbox.
    ref.tell({ type: 'cancel', reason: 'the incident was resolved' });
    await kit.settle();

    expect(recorded.appends).toEqual([['runStarted', 'runFinished']]);
    expect(model.requests).toHaveLength(0);
    reporter.expectMessage((m) => m.outcome === 'cancelled');
  });

  it('of a finished run changes nothing', async () => {
    const a = makeAgent(kit, recorded.persistence, scriptedModel([say('Done.')]));
    const { ref, reporter } = startRun(kit, a);
    await kit.settle();
    reporter.expectMessage((m) => m.outcome === 'completed');

    ref.tell({ type: 'cancel', reason: 'too late' });
    await kit.settle();
    expect(recorded.appends).toEqual([['runStarted'], ['modelResponded', 'runFinished']]);
    reporter.expectNoMessage();
  });
});
