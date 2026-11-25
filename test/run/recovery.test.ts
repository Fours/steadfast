// T4: recovery and interrupted tools. A crash is a kit whose journal stops taking appends, or a
// kit shut down while a tool runs. Either way the run is spawned again, in a new kit, on the same
// journal, as a restarted process would.

import { inMemoryPersistence, type Persistence } from '@kylewillett/troupe/persistence';
import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, ModelRequest, RunEvent, RunReport, Turn } from '../../src/index.ts';
import { INTERRUPTED } from '../../src/run/actor.ts';
import { initialState, onEvent } from '../../src/run/state.ts';
import type { RunState } from '../../src/run/types.ts';
import {
  callTool,
  callTools,
  say,
  scriptedModel,
  type ScriptEntry,
} from '../../src/testkit/index.ts';
import {
  crashAfter,
  INPUT,
  journalOf,
  makeAgent,
  readsRecorded,
  recordingTool,
  RUN_ID,
  startRun,
} from './helpers.ts';

const kits: TestKit[] = [];

/** A kit for one incarnation of the run. Each starts at time 0, as a new process's would. */
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
  ];
}

/** Five model calls: two tools at once, one, one, two at once, then the answer. */
const FIVE_STEPS: readonly ScriptEntry[] = [
  callTools([
    { name: 'read_log', input: { service: 'checkout' }, id: 'toolu_1a' },
    { name: 'query_metrics', input: { metric: '5xx' }, id: 'toolu_1b' },
  ]),
  callTool('read_log', { service: 'payments' }, { id: 'toolu_2a' }),
  callTool('query_metrics', { metric: 'latency' }, { id: 'toolu_3a' }),
  callTools([
    { name: 'read_log', input: { service: 'db' }, id: 'toolu_4a' },
    { name: 'query_metrics', input: { metric: 'connections' }, id: 'toolu_4b' },
  ]),
  say('A payments deploy exhausted the database connections.'),
];

interface Outcome {
  readonly events: RunEvent[];
  readonly requests: readonly ModelRequest[];
  readonly reports: RunReport[];
}

/** Runs `script` to the end in one incarnation, on a fresh journal. */
async function uninterrupted(script: readonly ScriptEntry[]): Promise<Outcome> {
  const kit = newKit();
  const persistence = inMemoryPersistence({ clock: () => 0 });
  const model = scriptedModel(script);
  const a = makeAgent(
    kit,
    persistence,
    model,
    lookupTools().map((t) => t.tool),
  );
  const { reporter } = startRun(kit, a);
  await kit.settle();
  return {
    events: await journalOf(persistence, a),
    requests: model.requests,
    reports: reporter.messages(),
  };
}

interface Crashed {
  /** Events the first incarnation left in the journal. */
  readonly left: RunEvent[];
  /** The first incarnation's requests that were answered and journaled. */
  readonly answered: readonly ModelRequest[];
}

/** Runs `script` until `limit` events are stored, then kills the kit. */
async function crashedRun(
  persistence: Persistence,
  script: readonly ScriptEntry[],
  limit: number,
): Promise<Crashed> {
  const kit = newKit();
  const model = scriptedModel(script);
  const a = makeAgent(
    kit,
    crashAfter(persistence, limit),
    model,
    lookupTools().map((t) => t.tool),
  );
  startRun(kit, a);
  await kit.settle();
  await kit.shutdown();
  const left = await journalOf(persistence, a);
  const steps = left.filter((e) => e.type === 'modelResponded').length;
  return { left, answered: model.requests.slice(0, steps) };
}

/** Spawns the run again on `persistence`, with what's left of the script, and runs it to the end. */
async function resumed(
  persistence: Persistence,
  script: readonly ScriptEntry[],
  answered: number,
): Promise<Outcome> {
  const kit = newKit();
  const model = scriptedModel(script.slice(answered));
  const a = makeAgent(
    kit,
    persistence,
    model,
    lookupTools().map((t) => t.tool),
  );
  const { reporter } = startRun(kit, a);
  await kit.settle();
  return {
    events: await journalOf(persistence, a),
    requests: model.requests,
    reports: reporter.messages(),
  };
}

describe('recovery', () => {
  it('resumes a five-step run stopped after any event, and ends as it would have', async () => {
    const baseline = await uninterrupted(FIVE_STEPS);
    expect(baseline.events).toHaveLength(13);
    expect(baseline.reports.map((r) => r.outcome)).toEqual(['completed']);

    for (let limit = 1; limit < baseline.events.length; limit++) {
      const persistence = inMemoryPersistence({ clock: () => 0 });
      const { left, answered } = await crashedRun(persistence, FIVE_STEPS, limit);
      // The crash left a prefix of the run. The last response and the finish are one append, so
      // a crash can't land between them, and stopping after the 12th event leaves 11.
      expect(left).toEqual(baseline.events.slice(0, left.length));
      expect(left.length).toBe(limit === 12 ? 11 : limit);

      const after = await resumed(persistence, FIVE_STEPS, answered.length);
      expect(after.events, `stopped after event ${String(limit)}`).toEqual(baseline.events);
      expect(after.reports).toEqual(baseline.reports);
      // A model call that was in flight is made again, with the same request.
      expect([...answered, ...after.requests]).toEqual(baseline.requests);
    }
  });

  it('runs an interrupted idempotent tool again, with the same idempotency key', async () => {
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const script = [callTool('read_log', { service: 'checkout' }, { id: 'toolu_a' }), say('Done.')];
    const readLog = recordingTool('read_log', () =>
      // The first incarnation's call never finishes, and ignores its signal. The process dies
      // with it in flight.
      readLog.calls.length > 1
        ? Promise.resolve({ lines: ['502 upstream'] })
        : new Promise<JsonValue>(() => undefined),
    );

    const first = newKit();
    const a1 = makeAgent(first, persistence, scriptedModel(script), [readLog.tool]);
    startRun(first, a1);
    await first.settle();
    expect((await journalOf(persistence, a1)).map((e) => e.type)).toEqual([
      'runStarted',
      'modelResponded',
    ]);
    await first.shutdown();

    const second = newKit();
    const model = scriptedModel(script.slice(1));
    const a2 = makeAgent(second, persistence, model, [readLog.tool]);
    const { reporter } = startRun(second, a2);
    await second.settle();

    expect(readLog.calls.map((c) => c.ctx.idempotencyKey)).toEqual([
      `${RUN_ID}:1:toolu_a`,
      `${RUN_ID}:1:toolu_a`,
    ]);
    expect(model.requests[0]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [{ callId: 'toolu_a', result: { ok: true, output: { lines: ['502 upstream'] } } }],
    });
    expect(reporter.messages().map((r) => r.outcome)).toEqual(['completed']);
  });

  it('doesn’t run an interrupted non-idempotent tool again, and tells the model', async () => {
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const script = [
      callTools([
        { name: 'read_log', input: { service: 'checkout' }, id: 'toolu_a' },
        { name: 'page_oncall', input: { team: 'payments' }, id: 'toolu_b' },
      ]),
      say('Checked the pager before paging again.'),
    ];
    const readLog = recordingTool('read_log');
    // Never finishes: the page may or may not have gone out when the process dies.
    const page = recordingTool('page_oncall', () => new Promise<JsonValue>(() => undefined), false);

    const first = newKit();
    const a1 = makeAgent(first, persistence, scriptedModel(script), [readLog.tool, page.tool]);
    startRun(first, a1);
    await first.settle();
    await first.shutdown();
    expect(page.calls).toHaveLength(1);

    const second = newKit();
    const model = scriptedModel(script.slice(1));
    const a2 = makeAgent(second, persistence, model, [readLog.tool, page.tool]);
    const { reporter } = startRun(second, a2);
    await second.settle();

    // At most once: neither tool ran again, since read_log had finished and page_oncall isn't safe.
    expect(page.calls).toHaveLength(1);
    expect(readLog.calls).toHaveLength(1);
    const interrupted = {
      ok: false as const,
      error: 'The tool was interrupted and may or may not have run. Check before trying again.',
      interrupted: true as const,
    };
    expect(INTERRUPTED).toBe(interrupted.error);
    expect((await journalOf(persistence, a2)).filter((e) => e.type === 'toolFinished')).toEqual([
      {
        type: 'toolFinished',
        step: 1,
        callId: 'toolu_a',
        result: { ok: true, output: { from: 'read_log' } },
      },
      { type: 'toolFinished', step: 1, callId: 'toolu_b', result: interrupted },
    ]);
    expect(model.requests[0]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [
        { callId: 'toolu_a', result: { ok: true, output: { from: 'read_log' } } },
        { callId: 'toolu_b', result: interrupted },
      ],
    });
    expect(reporter.messages().map((r) => r.outcome)).toEqual(['completed']);
  });

  it('reports a finished run again when it’s spawned, and calls nothing', async () => {
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const first = newKit();
    const a1 = makeAgent(first, persistence, scriptedModel([say('All clear.')]));
    const { reporter: firstReporter } = startRun(first, a1);
    await first.settle();
    const [report] = firstReporter.messages();
    await first.shutdown();
    const events = await journalOf(persistence, a1);

    const second = newKit();
    // An empty script: any call would end the run `failed`, and write to the journal.
    const model = scriptedModel([]);
    const readLog = recordingTool('read_log');
    const a2 = makeAgent(second, persistence, model, [readLog.tool]);
    const { reporter } = startRun(second, a2);
    await second.settle();

    expect(report?.outcome).toBe('completed');
    expect(reporter.messages()).toEqual([report]);
    expect(model.requests).toEqual([]);
    expect(readLog.calls).toEqual([]);
    expect(await journalOf(persistence, a2)).toEqual(events);
  });

  it('ignores a different input on resume, with a warning', async () => {
    const script = [callTool('read_log', { service: 'checkout' }), say('Done.')];
    const resumeWith = async (input: string) => {
      const persistence = inMemoryPersistence({ clock: () => 0 });
      await crashedRun(persistence, script, 2);
      const kit = newKit();
      const model = scriptedModel(script.slice(1));
      const a = makeAgent(
        kit,
        persistence,
        model,
        lookupTools().map((t) => t.tool),
      );
      startRun(kit, a, RUN_ID, input);
      await kit.settle();
      return { warnings: kit.logs.filter((l) => l.level === 'warn'), model };
    };

    const changed = await resumeWith('Something else entirely.');
    expect(changed.warnings).toEqual([
      {
        level: 'warn',
        msg: 'run-triage-incident-4211: resumed with a different input, which is ignored',
        fields: { runId: RUN_ID, path: `/user/${RUN_ID}` },
      },
    ]);
    expect(changed.model.requests[0]?.transcript[0]).toEqual<Turn>({ role: 'user', text: INPUT });

    const same = await resumeWith(INPUT);
    expect(same.warnings).toEqual([]);
  });

  it('gives the same state from a snapshot as from every event', async () => {
    // Ten steps of ten tool calls each: 111 events before the answer, so a snapshot is taken at 100.
    const step = (n: number) =>
      callTools(
        Array.from({ length: 10 }, (_, i) => ({
          name: 'read_log',
          input: { shard: n * 10 + i },
          id: `toolu_${String(n)}_${String(i)}`,
        })),
      );
    const script = [
      ...Array.from({ length: 10 }, (_, n) => step(n + 1)),
      say('Every shard is fine.'),
    ];
    const limit = 105;

    const recoverFrom = async (snapshots: boolean) => {
      const memory = inMemoryPersistence({ clock: () => 0 });
      const { answered } = await crashedRun(memory, script, limit);
      const base: Persistence = snapshots ? memory : { journal: memory.journal };
      const { persistence, reads } = readsRecorded(base);
      const after = await resumed(persistence, script, answered.length);
      return { memory, reads, after, answered };
    };

    const fromSnapshot = await recoverFrom(true);
    const fromEvents = await recoverFrom(false);

    // The snapshot is the fold of the first 100 events, and recovery replayed only what followed.
    const id = 'run-triage-incident-4211';
    const snapshot = await fromSnapshot.memory.snapshots.load(id);
    const first100 = (await fromSnapshot.memory.journal.read(id, 1, 100)).map(
      (e) => e.event as RunEvent,
    );
    expect(snapshot?.seq).toBe(100);
    expect(snapshot?.state).toEqual(first100.reduce<RunState>(onEvent, initialState));
    expect(fromSnapshot.reads[0]).toBe(101);
    expect(fromEvents.reads[0]).toBe(1);

    // The first request after recovery holds the whole transcript, so it shows the recovered state.
    expect(fromSnapshot.answered).toHaveLength(10);
    expect(fromSnapshot.after.requests).toEqual(fromEvents.after.requests);
    expect(fromSnapshot.after.events).toEqual(fromEvents.after.events);
    expect(fromSnapshot.after.reports).toEqual(fromEvents.after.reports);
    expect(fromSnapshot.after.reports.map((r) => r.outcome)).toEqual(['completed']);
    expect(fromSnapshot.after.events).toHaveLength(113);
  });
});
