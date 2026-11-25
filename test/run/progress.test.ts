// Milestone 2's T2: what a run tells its `progressTo`. Every journaled event once, in order, with
// its seq; streamed text before the response it belongs to; `resumed` first on every spawn; and
// nothing a listener does changes the run.

import { actor, type ActorRef } from '@kylewillett/troupe';
import { inMemoryPersistence, type Persistence } from '@kylewillett/troupe/persistence';
import { createTestKit, type TestKit, type TestProbe } from '@kylewillett/troupe/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelError,
  readRun,
  type Agent,
  type JsonValue,
  type Model,
  type RunEvent,
  type RunProgress,
  type RunReport,
} from '../../src/index.ts';
import {
  callTool,
  callTools,
  faultyModel,
  say,
  scriptedModel,
  type ScriptEntry,
} from '../../src/testkit/index.ts';
import {
  crashAfter,
  INPUT,
  journalOf,
  makeAgent,
  PAST_BACKOFF,
  recordedPersistence,
  recordingTool,
  RUN_ID,
} from './helpers.ts';

const kits: TestKit[] = [];

/** A kit for one incarnation of the run, as a new process would have. */
function newKit(): TestKit {
  const kit = createTestKit();
  kits.push(kit);
  return kit;
}

afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.shutdown();
});

/** Idempotent tools whose output is a function of their input, so every run of them agrees. */
function lookupTools() {
  const answer = (name: string) => (input: JsonValue) => Promise.resolve({ name, input });
  return [
    recordingTool('read_log', answer('read_log')),
    recordingTool('query_metrics', answer('query_metrics')),
  ].map((t) => t.tool);
}

/** Three model calls: two tools at once, one more, then the answer. */
const SCRIPT: readonly ScriptEntry[] = [
  callTools(
    [
      { name: 'read_log', input: { service: 'checkout' }, id: 'toolu_1a' },
      { name: 'query_metrics', input: { metric: '5xx' }, id: 'toolu_1b' },
    ],
    { text: 'Reading the logs and the error rate.' },
  ),
  callTool('read_log', { service: 'payments' }, { id: 'toolu_2a', text: 'Now payments.' }),
  say('A payments deploy exhausted the database connections.'),
];

interface Listening {
  readonly ref: ActorRef<never>;
  readonly progress: TestProbe<RunProgress>;
  readonly reporter: TestProbe<RunReport>;
}

/** Spawns the run with a probe as its `progressTo`. */
function startListening(kit: TestKit, a: Agent): Listening {
  const progress = kit.probe<RunProgress>(`progress-${RUN_ID}`);
  const reporter = kit.probe<RunReport>(`desk-${RUN_ID}`);
  const ref = kit.system.spawn(
    a.run(RUN_ID, { input: INPUT, reportTo: reporter.ref, progressTo: progress.ref }),
    RUN_ID,
  );
  return { ref, progress, reporter };
}

function journaled(messages: readonly RunProgress[]) {
  return messages.flatMap((m) =>
    m.type === 'journaled' ? [{ runId: m.runId, seq: m.seq, event: m.event }] : [],
  );
}

/** The journal as `{ seq, event }`, the shape `journaled` messages are compared in. */
async function seqd(persistence: Persistence, a: Agent) {
  return (await journalOf(persistence, a)).map((event, i) => ({
    runId: RUN_ID,
    seq: i + 1,
    event,
  }));
}

describe('journaled', () => {
  it('tells every event once, in order, with the seq the journal gave it', async () => {
    const kit = newKit();
    const recorded = recordedPersistence(() => kit.scheduler.now());
    // A failed attempt at step 2 puts an attemptFailed in the journal too.
    const model = faultyModel(scriptedModel(SCRIPT), {
      step: 2,
      fail: [new ModelError('Overloaded', { retryable: true })],
    });
    const a = makeAgent(kit, recorded.persistence, model, lookupTools());
    const { progress, reporter } = startListening(kit, a);
    await kit.settle();
    await kit.advance(PAST_BACKOFF);
    await kit.settle();
    reporter.expectMessage((m) => m.outcome === 'completed');

    const messages = progress.messages();
    const told = journaled(messages);
    expect(told).toEqual(await seqd(recorded.persistence, a));
    expect(told.map((m) => m.event.type)).toContain('attemptFailed');
    // The last response and runFinished went in one write, and were told as two events.
    expect(recorded.appends.at(-1)).toEqual(['modelResponded', 'runFinished']);
    expect(messages[0]).toEqual<RunProgress>({ type: 'resumed', runId: RUN_ID, seq: 0 });
  });

  it('tells a run cancelled before it started both events of its one write', async () => {
    const kit = newKit();
    const recorded = recordedPersistence(() => kit.scheduler.now());
    const a = makeAgent(kit, recorded.persistence, scriptedModel([say('Never reached.')]));
    const { ref, progress } = startListening(kit, a);
    (ref as ActorRef<{ type: 'cancel'; reason: string }>).tell({
      type: 'cancel',
      reason: 'Duplicate',
    });
    await kit.settle();
    expect(recorded.appends).toEqual([['runStarted', 'runFinished']]);
    expect(journaled(progress.messages())).toEqual(await seqd(recorded.persistence, a));
  });

  it('tells nothing for a write that fails', async () => {
    const kit = newKit();
    const memory = inMemoryPersistence({ clock: () => 0 });
    const a = makeAgent(kit, crashAfter(memory, 2), scriptedModel(SCRIPT), lookupTools());
    const { progress } = startListening(kit, a);
    await kit.settle();
    // runStarted and the first response fit. The first tool result's write failed.
    expect(journaled(progress.messages()).map((m) => m.seq)).toEqual([1, 2]);
  });
});

describe('text', () => {
  it('arrives a step at a time, before the journaled response it belongs to', async () => {
    const kit = newKit();
    const recorded = recordedPersistence(() => kit.scheduler.now());
    const a = makeAgent(kit, recorded.persistence, scriptedModel(SCRIPT), lookupTools());
    const { progress } = startListening(kit, a);
    await kit.settle();

    const messages = progress.messages();
    const texts = [
      'Reading the logs and the error rate.',
      'Now payments.',
      'A payments deploy exhausted the database connections.',
    ];
    for (const [i, whole] of texts.entries()) {
      const step = i + 1;
      const responded = messages.findIndex(
        (m) => m.type === 'journaled' && m.event.type === 'modelResponded' && m.event.step === step,
      );
      const pieces = messages.flatMap((m, at) =>
        m.type === 'text' && m.step === step ? [{ at, text: m.text, attempt: m.attempt }] : [],
      );
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces.every((p) => p.at < responded && p.attempt === 1)).toBe(true);
      expect(pieces.map((p) => p.text).join('')).toBe(whole);
    }
  });

  it('carries the next attempt number when a call is tried again', async () => {
    const kit = newKit();
    const recorded = recordedPersistence(() => kit.scheduler.now());
    const inner = scriptedModel([say('Checkout is down.')]);
    let calls = 0;
    // Streams part of an answer, then fails, as a dropped connection would.
    const model: Model = {
      name: inner.name,
      async call(request, options) {
        calls += 1;
        if (calls === 1) {
          options.onText?.('Half an ');
          await Promise.resolve();
          throw new ModelError('Connection reset', { retryable: true });
        }
        return inner.call(request, options);
      },
    };
    const a = makeAgent(kit, recorded.persistence, model);
    const { progress } = startListening(kit, a);
    await kit.settle();
    await kit.advance(PAST_BACKOFF);
    await kit.settle();

    const events = await journalOf(recorded.persistence, a);
    const j = (seq: number): RunProgress => ({
      type: 'journaled',
      runId: RUN_ID,
      seq,
      event: events[seq - 1] as RunEvent,
    });
    const text = (attempt: number, piece: string): RunProgress => ({
      type: 'text',
      runId: RUN_ID,
      step: 1,
      attempt,
      text: piece,
    });
    expect(events.map((e) => e.type)).toEqual([
      'runStarted',
      'attemptFailed',
      'modelResponded',
      'runFinished',
    ]);
    expect(progress.messages()).toEqual<RunProgress[]>([
      { type: 'resumed', runId: RUN_ID, seq: 0 },
      j(1),
      text(1, 'Half an '),
      j(2),
      text(2, 'Checkout '),
      text(2, 'is '),
      text(2, 'down.'),
      j(3),
      j(4),
    ]);
  });
});

describe('resumed', () => {
  // Every point the first incarnation can die at: 1 to 6 of 8 events, since the last two are
  // one write.
  it.each([1, 2, 3, 4, 5, 6])(
    'comes first after a crash at %i events, and readRun up to it plus what follows is every event once',
    async (limit) => {
      const memory = inMemoryPersistence({ clock: () => 0 });

      const first = newKit();
      const a1 = makeAgent(first, crashAfter(memory, limit), scriptedModel(SCRIPT), lookupTools());
      const before = startListening(first, a1);
      await first.settle();
      await first.shutdown();
      const left = await journalOf(memory, a1);
      expect(journaled(before.progress.messages()).map((m) => m.seq)).toEqual(
        left.map((_e, i) => i + 1),
      );

      const second = newKit();
      const answered = left.filter((e) => e.type === 'modelResponded').length;
      const a2 = makeAgent(second, memory, scriptedModel(SCRIPT.slice(answered)), lookupTools());
      const after = startListening(second, a2);
      await second.settle();
      after.reporter.expectMessage((m) => m.outcome === 'completed');

      const messages = after.progress.messages();
      expect(messages[0]).toEqual<RunProgress>({
        type: 'resumed',
        runId: RUN_ID,
        seq: left.length,
      });
      const caughtUp = await readRun(a2, RUN_ID, { upTo: left.length });
      const all = [
        ...caughtUp.events.map(({ seq, event }) => ({ runId: RUN_ID, seq, event })),
        ...journaled(messages),
      ];
      expect(all).toEqual(await seqd(memory, a2));
    },
  );

  it('is told by a finished run too, at its last seq', async () => {
    const memory = inMemoryPersistence({ clock: () => 0 });
    const first = newKit();
    const a1 = makeAgent(first, memory, scriptedModel([say('Done.')]));
    startListening(first, a1);
    await first.settle();
    await first.shutdown();

    const second = newKit();
    const a2 = makeAgent(second, memory, scriptedModel([]));
    const { progress } = startListening(second, a2);
    await second.settle();
    expect(progress.messages()).toEqual<RunProgress[]>([
      { type: 'resumed', runId: RUN_ID, seq: 3 },
    ]);
  });
});

describe('a stopped listener', () => {
  /** Runs SCRIPT to the end in a kit of its own, telling progress to `listener` if it's given. */
  async function runWith(stopListener: boolean) {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const a = makeAgent(kit, persistence, scriptedModel(SCRIPT), lookupTools());
    const reporter = kit.probe<RunReport>('desk');
    let progressTo: ActorRef<RunProgress> | undefined;
    if (stopListener) {
      progressTo = kit.system.spawn(
        actor<RunProgress, null>({ initial: () => null, receive: (state) => state }),
        'listener',
      );
      kit.system.stop(progressTo);
      await kit.settle();
    }
    kit.system.spawn(
      a.run(RUN_ID, {
        input: INPUT,
        reportTo: reporter.ref,
        ...(progressTo === undefined ? {} : { progressTo }),
      }),
      RUN_ID,
    );
    await kit.settle();
    return { events: await journalOf(persistence, a), reports: reporter.messages() };
  }

  it("doesn't change the run's journal or outcome", async () => {
    const without = await runWith(false);
    const stopped = await runWith(true);
    expect(stopped).toEqual(without);
    expect(stopped.reports).toEqual([expect.objectContaining({ outcome: 'completed' })]);
  });
});
