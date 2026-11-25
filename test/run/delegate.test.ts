// Milestone 2's T3: sub-agents and limits. A delegation starts a sub-run, a persistent child with a
// journal of its own, whose report is the call's result. It resumes rather than retrying, and it
// can't outlive or outspend its parent.

import {
  inMemoryPersistence,
  type Journal,
  type Persistence,
} from '@kylewillett/troupe/persistence';
import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agent,
  delegate,
  readRun,
  type Agent,
  type Budget,
  type JsonValue,
  type Model,
  type ModelRequest,
  type RunEvent,
  type RunProgress,
  type RunReport,
  type Tool,
  type Turn,
  type Usage,
} from '../../src/index.ts';
import {
  callTool,
  callTools,
  say,
  scriptedModel,
  type ScriptEntry,
} from '../../src/testkit/index.ts';
import {
  deferred,
  drive,
  INPUT,
  journalOf,
  PAST_BACKOFF,
  recordingTool,
  RUN_ID,
} from './helpers.ts';

const kits: TestKit[] = [];

function newKit(): TestKit {
  const kit = createTestKit();
  kits.push(kit);
  return kit;
}

afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.shutdown();
});

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
const usage = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
});
const SUB_ID = `${RUN_ID}/1.0`;
const TASK = 'Find errors in checkout since 14:00.';

/**
 * The analyst's model: it reads the log for its task, then says what it read. Its answers depend
 * only on the request, so sub-runs running side by side, or resumed, get the same answers.
 */
function analystModel(perCall: Usage = NO_USAGE) {
  const requests: ModelRequest[] = [];
  const model: Model = {
    name: 'analyst-model',
    call(request) {
      requests.push(request);
      const first = request.transcript[0];
      const task = first?.role === 'user' ? first.text : '';
      return Promise.resolve(
        request.transcript.at(-1)?.role === 'user'
          ? callTool('read_log', { task }, { id: 'toolu_r', usage: perCall })
          : say(`Read the logs for: ${task}`, { usage: perCall }),
      );
    },
  };
  return { model, requests };
}

interface TreeOptions {
  readonly kit: TestKit;
  readonly persistence: Persistence;
  readonly parent: Model;
  readonly analyst: Model;
  readonly readLog?: Tool;
  readonly parentBudget?: Budget;
  readonly analystBudget?: Budget;
  readonly parentTools?: readonly Tool[];
  readonly analystTools?: readonly Tool[];
}

/** The triage agent, which delegates to a log analyst. */
function tree(options: TreeOptions): { triage: Agent; analyst: Agent } {
  const { kit, persistence } = options;
  const clock = (): number => kit.scheduler.now();
  const analyst = agent({
    name: 'log-analyst',
    model: options.analyst,
    system: 'You read service logs.',
    tools: options.analystTools ?? [options.readLog ?? recordingTool('read_log').tool],
    persistence,
    clock,
    ...(options.analystBudget === undefined ? {} : { budget: options.analystBudget }),
  });
  const triage = agent({
    name: 'triage',
    model: options.parent,
    system: 'You triage production incidents.',
    tools: [
      delegate(analyst, { name: 'ask_log_analyst', description: 'Give the log analyst a task.' }),
      ...(options.parentTools ?? []),
    ],
    persistence,
    clock,
    ...(options.parentBudget === undefined ? {} : { budget: options.parentBudget }),
  });
  return { triage, analyst };
}

function spawnRoot(kit: TestKit, triage: Agent, runId = RUN_ID) {
  const reporter = kit.probe<RunReport>(`desk-${String(kits.length)}`);
  const ref = kit.system.spawn(triage.run(runId, { input: INPUT, reportTo: reporter.ref }), 'root');
  return { ref, reporter };
}

const ask = (task: string, id = 'toolu_d', u: Usage = NO_USAGE) =>
  callTool('ask_log_analyst', { task }, { id, usage: u });

describe('delegation', () => {
  it('starts a sub-run with the task as its input, and its text is the result', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const analyst = analystModel(usage(40, 10));
    const parent = scriptedModel([ask(TASK, 'toolu_d', usage(100, 20)), say('Checkout is down.')]);
    const { triage, analyst: a } = tree({ kit, persistence, parent, analyst: analyst.model });
    const { reporter } = spawnRoot(kit, triage);
    await kit.settle();

    expect(await journalOf(persistence, a, SUB_ID)).toEqual<RunEvent[]>([
      {
        type: 'runStarted',
        agent: 'log-analyst',
        model: 'analyst-model',
        input: TASK,
        startedAt: 0,
        limits: { depthLeft: 2 },
      },
      {
        type: 'modelResponded',
        step: 1,
        response: callTool('read_log', { task: TASK }, { id: 'toolu_r', usage: usage(40, 10) }),
      },
      {
        type: 'toolFinished',
        step: 1,
        callId: 'toolu_r',
        result: { ok: true, output: { from: 'read_log' } },
      },
      {
        type: 'modelResponded',
        step: 2,
        response: say(`Read the logs for: ${TASK}`, { usage: usage(40, 10) }),
      },
      { type: 'runFinished', outcome: 'completed', text: `Read the logs for: ${TASK}` },
    ]);
    expect(a.persistenceId(SUB_ID)).toBe('run-log-analyst-incident-4211/1.0');

    const result = { ok: true as const, output: `Read the logs for: ${TASK}` };
    const parentEvents = await journalOf(persistence, triage);
    expect(parentEvents[2]).toEqual<RunEvent>({
      type: 'toolFinished',
      step: 1,
      callId: 'toolu_d',
      result,
      usage: usage(80, 20),
    });
    expect(parent.requests[1]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [{ callId: 'toolu_d', result }],
    });
    reporter.expectMessage({
      type: 'runFinished',
      runId: RUN_ID,
      outcome: 'completed',
      text: 'Checkout is down.',
      usage: usage(100, 20),
      treeUsage: usage(180, 40),
    });
    // The model sees an ordinary tool, with a task as its input.
    expect(parent.requests[0]?.tools.map((t) => t.name)).toEqual(['ask_log_analyst']);
    expect(parent.requests[0]?.tools[0]?.input).toMatchObject({ required: ['task'] });
  });

  it('stops the sub-run’s actor once its report is journaled', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    // The parent's second call is held, so the parent is still running when we look.
    const held = deferred<ReturnType<typeof say>>();
    const parent = scriptedModel([ask(TASK), () => held.promise]);
    const { triage } = tree({ kit, persistence, parent, analyst: analystModel().model });
    spawnRoot(kit, triage);
    await drive(kit, () => parent.requests.length === 2);

    const sub = '/user/root/sub-1-toolu_d';
    const lifecycle = kit.events.filter(
      (e) => (e.type === 'spawned' || e.type === 'stopped') && e.path === sub,
    );
    expect(lifecycle.map((e) => e.type)).toEqual(['spawned', 'stopped']);
    held.resolve(say('Done.'));
    await kit.settle();
  });

  it('turns any other outcome into an error result that names it', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const parent = scriptedModel([ask(TASK), say('The analyst ran out of steps.')]);
    const { triage } = tree({
      kit,
      persistence,
      parent,
      analyst: analystModel().model,
      analystBudget: { maxSteps: 1 },
    });
    const { reporter } = spawnRoot(kit, triage);
    await kit.settle();

    expect(parent.requests[1]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [
        {
          callId: 'toolu_d',
          result: {
            ok: false,
            error:
              'The sub-agent stopped: stepsExceeded. The run reached its budget of 1 model calls.',
          },
        },
      ],
    });
    expect(reporter.messages().map((r) => r.outcome)).toEqual(['completed']);
  });

  it('runs two delegations of one step at the same time, each in its own stream', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    // Each sub-run's read is held until both have started, which couldn't happen one at a time.
    const both = deferred<JsonValue>();
    const readLog = recordingTool('read_log', () => {
      if (readLog.calls.length === 2) both.resolve({ lines: [] });
      return both.promise;
    });
    const parent = scriptedModel([
      callTools([
        { name: 'ask_log_analyst', input: { task: 'Read checkout.' }, id: 'toolu_a' },
        { name: 'ask_log_analyst', input: { task: 'Read payments.' }, id: 'toolu_b' },
      ]),
      say('Both read.'),
    ]);
    const { triage, analyst } = tree({
      kit,
      persistence,
      parent,
      analyst: analystModel().model,
      readLog: readLog.tool,
    });
    const { reporter } = spawnRoot(kit, triage);
    await drive(kit, () => reporter.messages().length === 1);

    expect(readLog.calls.map((c) => c.ctx.runId)).toEqual([`${RUN_ID}/1.0`, `${RUN_ID}/1.1`]);
    for (const [id, task] of [
      [`${RUN_ID}/1.0`, 'Read checkout.'],
      [`${RUN_ID}/1.1`, 'Read payments.'],
    ] as const) {
      const events = await journalOf(persistence, analyst, id);
      expect(events[0]).toMatchObject({ type: 'runStarted', input: task });
      expect(events.at(-1)).toEqual({
        type: 'runFinished',
        outcome: 'completed',
        text: `Read the logs for: ${task}`,
      });
    }
    expect(parent.requests[1]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [
        { callId: 'toolu_a', result: { ok: true, output: 'Read the logs for: Read checkout.' } },
        { callId: 'toolu_b', result: { ok: true, output: 'Read the logs for: Read payments.' } },
      ],
    });
  });

  it('tells one progress ref about every run in the tree', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const parent = scriptedModel([ask(TASK), say('Done.')]);
    const { triage, analyst } = tree({ kit, persistence, parent, analyst: analystModel().model });
    const progress = kit.probe<RunProgress>('progress');
    kit.system.spawn(triage.run(RUN_ID, { input: INPUT, progressTo: progress.ref }), RUN_ID);
    await kit.settle();

    const messages = progress.messages();
    const heard = messages.filter((p) => p.type === 'journaled');
    for (const [a, id] of [
      [triage, RUN_ID],
      [analyst, SUB_ID],
    ] as const) {
      expect(heard.filter((p) => p.runId === id).map((p) => p.event)).toEqual(
        await journalOf(persistence, a, id),
      );
    }
    expect(messages.filter((p) => p.type === 'resumed')).toEqual([
      { type: 'resumed', runId: RUN_ID, seq: 0 },
      { type: 'resumed', runId: SUB_ID, seq: 0 },
    ]);
  });

  it('names each delegation’s sub-run in readRun', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const queryMetrics = recordingTool('query_metrics').tool;
    const parent = scriptedModel([
      callTools([
        { name: 'ask_log_analyst', input: { task: TASK }, id: 'toolu_a' },
        { name: 'query_metrics', input: {}, id: 'toolu_q' },
        { name: 'ask_log_analyst', input: { task: 5 }, id: 'toolu_bad' },
      ]),
      say('Done.'),
    ]);
    const { triage, analyst } = tree({
      kit,
      persistence,
      parent,
      analyst: analystModel().model,
      parentTools: [queryMetrics],
    });
    spawnRoot(kit, triage);
    await kit.settle();

    const timeline = await readRun(triage, RUN_ID);
    const [ask1, query, bad] = timeline.steps[0]?.tools ?? [];
    expect(ask1?.subRun).toEqual({ agent: 'log-analyst', runId: SUB_ID });
    expect(query?.subRun).toBeUndefined();
    // Its input had no task, so nothing started.
    expect(bad?.subRun).toBeUndefined();
    expect(bad?.result).toEqual({
      ok: false,
      error: 'Invalid input for ask_log_analyst: task must be a string',
    });
    // The id it names is the one the run used.
    const sub = await readRun(analyst, SUB_ID);
    expect(sub.state.outcome).toBe('completed');
    expect(sub.state.input).toBe(TASK);
  });

  it('reports bad input from the adapter without starting anything', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const garbled = callTool('ask_log_analyst', '{"task": ', { id: 'toolu_g' });
    const parent = scriptedModel([
      {
        ...garbled,
        toolCalls: [
          {
            id: 'toolu_g',
            name: 'ask_log_analyst',
            input: '{"task": ',
            inputError: 'Unexpected end of JSON input',
          },
        ],
      },
      say('Done.'),
    ]);
    const analyst = analystModel();
    const { triage } = tree({ kit, persistence, parent, analyst: analyst.model });
    spawnRoot(kit, triage);
    await kit.settle();

    expect(analyst.requests).toEqual([]);
    expect(parent.requests[1]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [
        {
          callId: 'toolu_g',
          result: {
            ok: false,
            error: 'Invalid input for ask_log_analyst: Unexpected end of JSON input',
          },
        },
      ],
    });
  });

  it('ignores a report from a run it isn’t waiting on', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const held = deferred<ReturnType<typeof say>>();
    const parent = scriptedModel([() => held.promise]);
    const { triage } = tree({ kit, persistence, parent, analyst: analystModel().model });
    const { ref } = spawnRoot(kit, triage);
    await drive(kit, () => parent.requests.length === 1);
    ref.tell({
      type: 'runFinished',
      runId: SUB_ID,
      outcome: 'completed',
      text: 'Stray.',
      usage: NO_USAGE,
      treeUsage: NO_USAGE,
    });
    held.resolve(say('Done.'));
    await kit.settle();
    expect((await journalOf(persistence, triage)).map((e) => e.type)).toEqual([
      'runStarted',
      'modelResponded',
      'runFinished',
    ]);
  });
});

describe('limits handed down', () => {
  it('gives a sub-run its parent’s deadline, the tokens left, and one level less', async () => {
    const kit = newKit();
    await kit.advance(5_000);
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const parent = scriptedModel([ask(TASK, 'toolu_d', usage(250, 50)), say('Done.')]);
    const { triage, analyst } = tree({
      kit,
      persistence,
      parent,
      analyst: analystModel().model,
      parentBudget: { deadlineMs: 60_000, maxTokens: 1_000 },
      analystBudget: { deadlineMs: 600_000, maxTokens: 100_000, maxDepth: 9 },
    });
    spawnRoot(kit, triage);
    await kit.settle();

    const [started] = await journalOf(persistence, analyst, SUB_ID);
    expect(started).toMatchObject({
      type: 'runStarted',
      startedAt: 5_000,
      limits: { deadlineAt: 65_000, maxTokens: 700, depthLeft: 2 },
    });
  });

  it('finishes a run at the deadline it was started with, when that’s earlier than its own', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const hang = recordingTool('read_log', () => new Promise<JsonValue>(() => undefined));
    const { analyst } = tree({
      kit,
      persistence,
      parent: scriptedModel([]),
      analyst: analystModel().model,
      readLog: hang.tool,
      analystBudget: { deadlineMs: 600_000 },
    });
    const reporter = kit.probe<RunReport>('desk');
    kit.system.spawn(
      analyst.run('alone', { input: TASK, reportTo: reporter.ref, limits: { deadlineAt: 30_000 } }),
      'alone',
    );
    await kit.advance(29_999);
    expect(reporter.messages()).toEqual([]);
    await kit.advance(1);
    expect(reporter.messages().map((r) => [r.outcome, r.text])).toEqual([
      ['deadlineExceeded', 'The run passed the deadline it was started with, at 30000 ms.'],
    ]);
  });

  it('holds a sub-run to the tokens its parent had left', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    // The parent's first call leaves 700 of its 1,000. The analyst's first answer uses 800.
    const parent = scriptedModel([ask(TASK, 'toolu_d', usage(300, 0)), say('Over.')]);
    const { triage, analyst } = tree({
      kit,
      persistence,
      parent,
      analyst: analystModel(usage(800, 0)).model,
      parentBudget: { maxTokens: 1_000 },
      analystBudget: { maxTokens: 100_000 },
    });
    const { reporter } = spawnRoot(kit, triage);
    await kit.settle();

    expect((await journalOf(persistence, analyst, SUB_ID)).at(-1)).toEqual({
      type: 'runFinished',
      outcome: 'tokensExceeded',
      text: 'The run used 800 tokens, reaching its budget of 700.',
    });
    // Its usage reached the parent too, which stops in the same write as the result.
    expect(reporter.messages().map((r) => [r.outcome, r.text])).toEqual([
      ['tokensExceeded', 'The run used 1100 tokens, reaching its budget of 1000.'],
    ]);
  });

  it('makes a delegation with no depth left an error result', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const clock = (): number => kit.scheduler.now();
    const leafModel = analystModel();
    const leaf = agent({
      name: 'leaf',
      model: leafModel.model,
      system: 'You read logs.',
      tools: [recordingTool('read_log').tool],
      persistence,
      clock,
    });
    // The analyst delegates too, but the root allows only one level under it.
    const analystScript = scriptedModel([
      callTool('ask_leaf', { task: 'Go deeper.' }, { id: 'toolu_l' }),
      say('Couldn’t go deeper.'),
    ]);
    const { triage, analyst } = tree({
      kit,
      persistence,
      parent: scriptedModel([ask(TASK), say('Done.')]),
      analyst: analystScript,
      analystTools: [delegate(leaf, { name: 'ask_leaf', description: 'A leaf.' })],
      parentBudget: { maxDepth: 1 },
    });
    spawnRoot(kit, triage);
    await kit.settle();

    expect(analystScript.requests[1]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [
        {
          callId: 'toolu_l',
          result: {
            ok: false,
            error: "ask_leaf can't start: this run can't delegate any further.",
          },
        },
      ],
    });
    expect(leafModel.requests).toEqual([]);
    expect((await journalOf(persistence, analyst, SUB_ID))[0]).toMatchObject({
      limits: { depthLeft: 0 },
    });
    expect((await readRun(analyst, SUB_ID)).steps[0]?.tools[0]?.subRun).toBeUndefined();
  });

  it('makes a delegation whose sub-run id would be too long an error result', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    // The root's stream id fits, at 255 characters, but `run-log-analyst-<id>/1.0` wouldn't.
    const runId = 'x'.repeat(255 - 'run-triage-'.length);
    const parent = scriptedModel([ask(TASK), say('Done.')]);
    const analyst = analystModel();
    const { triage } = tree({ kit, persistence, parent, analyst: analyst.model });
    spawnRoot(kit, triage, runId);
    await kit.settle();

    expect(analyst.requests).toEqual([]);
    expect(parent.requests[1]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [
        {
          callId: 'toolu_d',
          result: {
            ok: false,
            error: "ask_log_analyst can't start: the tree of runs is too deep for another sub-run.",
          },
        },
      ],
    });
  });
});

describe('treeUsage', () => {
  it('adds each finished sub-run’s usage to the parent’s, and keeps its own apart', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const parent = scriptedModel([
      callTools(
        [
          { name: 'ask_log_analyst', input: { task: 'a' }, id: 'toolu_a' },
          { name: 'ask_log_analyst', input: { task: 'b' }, id: 'toolu_b' },
        ],
        { usage: usage(100, 10) },
      ),
      say('Done.', { usage: usage(200, 20) }),
    ]);
    const { triage } = tree({
      kit,
      persistence,
      parent,
      analyst: analystModel(usage(30, 3)).model,
    });
    const { reporter } = spawnRoot(kit, triage);
    await kit.settle();

    const timeline = await readRun(triage, RUN_ID);
    expect(timeline.state.usage).toEqual(usage(300, 30));
    // Two sub-runs of two calls each.
    expect(timeline.state.treeUsage).toEqual(usage(420, 42));
    expect(reporter.messages()[0]?.treeUsage).toEqual(usage(420, 42));
  });
});

/**
 * A process that dies once `limit` events are stored across every stream. The append that would
 * pass it, and every one after it, rejects and writes nothing.
 */
function crashAfterTotal(base: Persistence, limit: number): Persistence {
  let stored = 0;
  let dead = false;
  const journal: Journal = {
    async append(id, expectedSeq, events) {
      if (dead || stored + events.length > limit) {
        dead = true;
        throw new Error(`crashed after ${String(limit)} events`);
      }
      // Counted before the write, so two runs appending at once can't both slip under the limit.
      stored += events.length;
      return base.journal.append(id, expectedSeq, events);
    },
    read: (id, fromSeq, n) => base.journal.read(id, fromSeq, n),
    readByTag: (tag, afterOffset, n) => base.journal.readByTag(tag, afterOffset, n),
  };
  return { ...base, journal };
}

describe('recovery', () => {
  /** The parent: a delegation and a lookup at once, then the answer. */
  const PARENT: readonly ScriptEntry[] = [
    callTools(
      [
        { name: 'ask_log_analyst', input: { task: TASK }, id: 'toolu_d' },
        { name: 'query_metrics', input: { metric: '5xx' }, id: 'toolu_q' },
      ],
      { usage: usage(100, 10) },
    ),
    say('A bad deploy.', { usage: usage(100, 10) }),
  ];

  interface Incarnation {
    readonly parentEvents: RunEvent[];
    readonly subEvents: RunEvent[];
    readonly parentRequests: readonly ModelRequest[];
    readonly subRequests: readonly ModelRequest[];
    readonly reports: RunReport[];
  }

  async function incarnation(
    persistence: Persistence,
    journalFor: Persistence,
    parentAnswered: number,
  ): Promise<Incarnation> {
    const kit = newKit();
    const parent = scriptedModel(PARENT.slice(parentAnswered));
    const analyst = analystModel(usage(10, 1));
    const { triage, analyst: a } = tree({
      kit,
      persistence,
      parent,
      analyst: analyst.model,
      parentTools: [recordingTool('query_metrics').tool],
    });
    const { reporter } = spawnRoot(kit, triage);
    await kit.settle();
    await kit.shutdown();
    return {
      parentEvents: await journalOf(journalFor, triage),
      subEvents: await journalOf(journalFor, a, SUB_ID),
      parentRequests: parent.requests,
      subRequests: analyst.requests,
      reports: reporter.messages(),
    };
  }

  const responses = (events: readonly RunEvent[]) =>
    events.filter((e) => e.type === 'modelResponded').length;

  it('resumes the parent and the sub-run after a stop at any event, and ends the same', async () => {
    const memory = inMemoryPersistence({ clock: () => 0 });
    const baseline = await incarnation(memory, memory, 0);
    const total = baseline.parentEvents.length + baseline.subEvents.length;
    expect(total).toBe(11);
    expect(baseline.reports.map((r) => r.outcome)).toEqual(['completed']);

    for (let limit = 1; limit < total; limit++) {
      const persistence = inMemoryPersistence({ clock: () => 0 });
      const first = await incarnation(crashAfterTotal(persistence, limit), persistence, 0);
      const left = first.parentEvents.length + first.subEvents.length;
      expect(left, `stopped after event ${String(limit)}`).toBeLessThanOrEqual(limit);

      const parentAnswered = responses(first.parentEvents);
      const after = await incarnation(persistence, persistence, parentAnswered);
      const where = `stopped after event ${String(limit)}`;
      expect(after.parentEvents, where).toEqual(baseline.parentEvents);
      expect(after.subEvents, where).toEqual(baseline.subEvents);
      expect(after.reports, where).toEqual(baseline.reports);
      // No model call that was journaled is made again, in either run.
      expect(
        [...first.parentRequests.slice(0, parentAnswered), ...after.parentRequests],
        where,
      ).toEqual(baseline.parentRequests);
      const subAnswered = responses(first.subEvents);
      expect([...first.subRequests.slice(0, subAnswered), ...after.subRequests], where).toEqual(
        baseline.subRequests,
      );
    }
  });

  it('restarts a sub-run that throws, and it recovers from its journal', async () => {
    const kit = newKit();
    const memory = inMemoryPersistence({ clock: () => 0 });
    // The sub-run's tool result fails to write once, which fails its actor.
    let failed = false;
    const journal: Journal = {
      append(id, expectedSeq, events) {
        const first = events[0]?.event as RunEvent | undefined;
        if (!failed && id.includes('/') && first?.type === 'toolFinished') {
          failed = true;
          return Promise.reject(new Error('The journal hiccuped.'));
        }
        return memory.journal.append(id, expectedSeq, events);
      },
      read: (id, fromSeq, n) => memory.journal.read(id, fromSeq, n),
      readByTag: (tag, afterOffset, n) => memory.journal.readByTag(tag, afterOffset, n),
    };
    const persistence: Persistence = { ...memory, journal };
    const readLog = recordingTool('read_log');
    const analyst = analystModel();
    const parent = scriptedModel([ask(TASK), say('Done.')]);
    const { triage, analyst: a } = tree({
      kit,
      persistence,
      parent,
      analyst: analyst.model,
      readLog: readLog.tool,
    });
    const { reporter } = spawnRoot(kit, triage);
    await kit.settle();
    expect(failed).toBe(true);
    expect(reporter.messages()).toEqual([]);

    await kit.advance(PAST_BACKOFF);
    const sub = '/user/root/sub-1-toolu_d';
    expect(kit.events.filter((e) => e.type === 'failed' && e.path === sub)).toMatchObject([
      { directive: 'restart' },
    ]);
    expect(reporter.messages().map((r) => r.outcome)).toEqual(['completed']);
    // Recovered from its journal: the model's first answer wasn't asked for again, and the
    // idempotent read whose result was lost ran again.
    expect(analyst.requests).toHaveLength(2);
    expect(readLog.calls).toHaveLength(2);
    expect((await journalOf(memory, a, SUB_ID)).map((e) => e.type)).toEqual([
      'runStarted',
      'modelResponded',
      'toolFinished',
      'modelResponded',
      'runFinished',
    ]);
  });
});
