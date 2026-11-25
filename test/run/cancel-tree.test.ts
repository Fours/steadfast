// Milestone 2's T5: cancellation across the tree (decision 0008). Finishing a run cancels every
// sub-run under it, each of which journals its own end. A finished run closes whatever sub-runs
// its unfinished calls had started whenever it's spawned again, and reports once its tree has
// closed.

import type { ActorRef } from '@kylewillett/troupe';
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
  tool,
  type Agent,
  type Budget,
  type DecideReply,
  type Model,
  type ModelRequest,
  type RunEvent,
  type RunMsg,
  type RunProgress,
  type RunReport,
  type Tool,
  type ToolContext,
} from '../../src/index.ts';
import { CLOSE_TIMEOUT_MS } from '../../src/run/actor.ts';
import { callTool, callTools, say, scriptedModel } from '../../src/testkit/index.ts';
import { INPUT, journalOf, RUN_ID, statusOf } from './helpers.ts';

const kits: TestKit[] = [];

function newKit(): TestKit {
  const kit = createTestKit();
  kits.push(kit);
  return kit;
}

afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.shutdown();
});

const ANALYST_ID = `${RUN_ID}/1.0`;
const READER_ID = `${ANALYST_ID}/1.0`;
const ROOT = '/user/root';
const ANALYST = `${ROOT}/sub-1-toolu_d`;
const READER = `${ANALYST}/sub-1-toolu_ar`;

/** A tool that runs until its signal is aborted, recording each call. */
function heldTool(name: string): { tool: Tool; calls: ToolContext[] } {
  const calls: ToolContext[] = [];
  return {
    calls,
    tool: tool({
      name,
      description: `The ${name} tool.`,
      input: { type: 'object' },
      idempotent: true,
      run: (_input, ctx) => {
        calls.push(ctx);
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            reject(new Error(`${name} was aborted`));
          });
        });
      },
    }),
  };
}

interface Tree {
  readonly root: Agent;
  readonly analyst: Agent;
  readonly reader: Agent;
  /** Each level's held tool: the root's, the analyst's and the reader's. */
  readonly held: readonly { tool: Tool; calls: ToolContext[] }[];
  readonly models: readonly { readonly requests: readonly ModelRequest[] }[];
}

/**
 * Three levels: triage delegates to a log analyst, which delegates to a reader. Each level calls
 * a tool that runs until it's stopped, alongside its delegation. With `scripted: false`, every
 * model has an empty script, so a call to any of them shows up in its requests and fails.
 */
function threeLevels(kit: TestKit, persistence: Persistence, scripted = true): Tree {
  const clock = (): number => kit.scheduler.now();
  const queryMetrics = heldTool('query_metrics');
  const grepLogs = heldTool('grep_logs');
  const readLog = heldTool('read_log');
  const script = (entries: Parameters<typeof scriptedModel>[0]) =>
    scriptedModel(scripted ? entries : []);
  const readerModel = script([callTool('read_log', {}, { id: 'toolu_r' })]);
  const analystModel = script([
    callTools([
      { name: 'ask_reader', input: { task: 'Read the checkout log.' }, id: 'toolu_ar' },
      { name: 'grep_logs', input: {}, id: 'toolu_g' },
    ]),
  ]);
  const rootModel = script([
    callTools([
      { name: 'ask_log_analyst', input: { task: 'Find errors in checkout.' }, id: 'toolu_d' },
      { name: 'query_metrics', input: {}, id: 'toolu_q' },
    ]),
  ]);
  const reader = agent({
    name: 'reader',
    model: readerModel,
    system: 'You read one log.',
    tools: [readLog.tool],
    persistence,
    clock,
  });
  const analyst = agent({
    name: 'log-analyst',
    model: analystModel,
    system: 'You read service logs.',
    tools: [delegate(reader, { name: 'ask_reader', description: 'Read a log.' }), grepLogs.tool],
    persistence,
    clock,
  });
  const root = agent({
    name: 'triage',
    model: rootModel,
    system: 'You triage production incidents.',
    tools: [
      delegate(analyst, { name: 'ask_log_analyst', description: 'Ask the log analyst.' }),
      queryMetrics.tool,
    ],
    persistence,
    clock,
  });
  return {
    root,
    analyst,
    reader,
    held: [queryMetrics, grepLogs, readLog],
    models: [rootModel, analystModel, readerModel],
  };
}

function spawnRoot(kit: TestKit, root: Agent) {
  const reporter = kit.probe<RunReport>(`desk-${String(kits.length)}`);
  const ref = kit.system.spawn(root.run(RUN_ID, { input: INPUT, reportTo: reporter.ref }), 'root');
  return { ref, reporter };
}

/** Each level's journal: the root's, the analyst's and the reader's. */
async function journals(persistence: Persistence, tree: Tree): Promise<RunEvent[][]> {
  return [
    await journalOf(persistence, tree.root, RUN_ID),
    await journalOf(persistence, tree.analyst, ANALYST_ID),
    await journalOf(persistence, tree.reader, READER_ID),
  ];
}

const cancelledWith = (text: string): RunEvent => ({
  type: 'runFinished',
  outcome: 'cancelled',
  text: `Cancelled: ${text}`,
});
const BY_PARENT = cancelledWith('The parent run finished: cancelled');

/** Every actor under the root that was spawned, and whether each has stopped. */
function actorsUnderRoot(kit: TestKit): Map<string, boolean> {
  const actors = new Map<string, boolean>();
  for (const e of kit.events) {
    if (!('path' in e) || !e.path.startsWith(`${ROOT}/`)) continue;
    if (e.type === 'spawned') actors.set(e.path, actors.get(e.path) ?? false);
    if (e.type === 'stopped') actors.set(e.path, true);
  }
  return actors;
}

describe('cancelling the root of a three-level tree', () => {
  it('journals cancelled in every run, aborts every tool call, stops every actor, and reports last', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const tree = threeLevels(kit, persistence);
    // One probe hears the report and every run's progress, so their order shows what came first.
    const desk = kit.probe<RunReport | RunProgress>('desk');
    const ref = kit.system.spawn(
      tree.root.run(RUN_ID, { input: INPUT, reportTo: desk.ref, progressTo: desk.ref }),
      'root',
    );
    await kit.settle();

    ref.tell({ type: 'cancel', reason: 'the incident was resolved' });
    await kit.settle();
    const [root, analyst, reader] = await journals(persistence, tree);
    expect(root?.at(-1)).toEqual(cancelledWith('the incident was resolved'));
    expect(analyst?.at(-1)).toEqual(BY_PARENT);
    expect(reader?.at(-1)).toEqual(BY_PARENT);

    // The root reports once, after every run under it has journaled its end.
    const heard = desk.messages();
    const reports = heard.filter((m) => m.type === 'runFinished');
    expect(reports).toMatchObject([{ runId: RUN_ID, outcome: 'cancelled' }]);
    const finishedAt = (id: string) =>
      heard.findIndex(
        (m) => m.type === 'journaled' && m.runId === id && m.event.type === 'runFinished',
      );
    const reportedAt = heard.findIndex((m) => m.type === 'runFinished');
    expect(finishedAt(RUN_ID)).toBeLessThan(finishedAt(ANALYST_ID));
    expect(finishedAt(READER_ID)).toBeGreaterThan(0);
    expect(finishedAt(READER_ID)).toBeLessThan(reportedAt);
    expect(finishedAt(ANALYST_ID)).toBeLessThan(reportedAt);

    await kit.settle();
    expect(tree.held.map((h) => h.calls[0]?.signal.aborted)).toEqual([true, true, true]);
    const actors = actorsUnderRoot(kit);
    expect([...actors.keys()]).toEqual(
      expect.arrayContaining([
        `${ROOT}/tool-1-toolu_q`,
        ANALYST,
        `${ANALYST}/tool-1-toolu_g`,
        READER,
        `${READER}/tool-1-toolu_r`,
      ]),
    );
    expect([...actors].filter(([, stopped]) => !stopped)).toEqual([]);
    // The root itself is finished, and still answers.
    expect(await statusOf(kit, ref)).toMatchObject({ outcome: 'cancelled', subRuns: [] });
    expect(desk.messages().filter((m) => m.type === 'runFinished')).toHaveLength(0);
  });
});

describe('a parent that finishes for another reason', () => {
  it('cancels its sub-runs the same way, and says why', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const clock = (): number => kit.scheduler.now();
    const readLog = heldTool('read_log');
    // A fast task answers at once, using more than the root has. A slow one reads a log.
    const analystModel: Model = {
      name: 'analyst-model',
      call(request) {
        const first = request.transcript[0];
        const task = first?.role === 'user' ? first.text : '';
        return Promise.resolve(
          task === 'fast'
            ? say('Nothing here.', { usage: { inputTokens: 150, outputTokens: 50 } })
            : callTool('read_log', {}, { id: 'toolu_r' }),
        );
      },
    };
    const analyst = agent({
      name: 'log-analyst',
      model: analystModel,
      system: 'You read service logs.',
      tools: [readLog.tool],
      persistence,
      clock,
    });
    const budget: Budget = { maxTokens: 100 };
    const root = agent({
      name: 'triage',
      model: scriptedModel([
        callTools([
          { name: 'ask_log_analyst', input: { task: 'slow' }, id: 'toolu_s' },
          { name: 'ask_log_analyst', input: { task: 'fast' }, id: 'toolu_f' },
        ]),
      ]),
      system: 'You triage production incidents.',
      tools: [delegate(analyst, { name: 'ask_log_analyst', description: 'Ask the analyst.' })],
      budget,
      persistence,
      clock,
    });
    const { reporter } = spawnRoot(kit, root);
    await kit.settle();

    const rootEvents = await journalOf(persistence, root);
    expect(rootEvents.at(-1)).toMatchObject({ type: 'runFinished', outcome: 'tokensExceeded' });
    const slow = await journalOf(persistence, analyst, `${RUN_ID}/1.0`);
    expect(slow.at(-1)).toEqual(cancelledWith('The parent run finished: tokensExceeded'));
    expect(readLog.calls[0]?.signal.aborted).toBe(true);
    expect(reporter.messages()).toMatchObject([{ outcome: 'tokensExceeded' }]);
  });
});

/**
 * A process that dies as soon as the run `id` has written `runFinished`: every append after that
 * rejects and writes nothing, so whatever was due next is lost, as in a crash.
 */
function dieAfterFinishing(base: Persistence, id: string): Persistence {
  let dead = false;
  const journal: Journal = {
    async append(streamId, expectedSeq, events) {
      if (dead) throw new Error('the process has died');
      await base.journal.append(streamId, expectedSeq, events);
      if (streamId === id && events.some((e) => (e.event as RunEvent).type === 'runFinished')) {
        dead = true;
      }
    },
    read: (streamId, fromSeq, n) => base.journal.read(streamId, fromSeq, n),
    readByTag: (tag, afterOffset, n) => base.journal.readByTag(tag, afterOffset, n),
  };
  return { ...base, journal };
}

describe('a finished run spawned again', () => {
  // The level whose `runFinished` is the last thing written: the root's, then the analyst's.
  const levels = [
    { level: 1, id: (t: Tree) => t.root.persistenceId(RUN_ID) },
    { level: 2, id: (t: Tree) => t.analyst.persistenceId(ANALYST_ID) },
  ];

  for (const { level, id } of levels) {
    it(`closes the sub-runs under it after a stop at level ${String(level)}, and calls nothing`, async () => {
      const memory = inMemoryPersistence({ clock: () => 0 });
      const kit = newKit();
      const shape = threeLevels(kit, memory);
      const dying = dieAfterFinishing(memory, id(shape));
      const tree = threeLevels(kit, dying);
      const first = spawnRoot(kit, tree.root);
      await kit.settle();
      first.ref.tell({ type: 'cancel', reason: 'the incident was resolved' });
      await kit.settle();
      // The root waits for its tree to close, which it can't: nothing is reported.
      expect(first.reporter.messages()).toEqual([]);
      await kit.shutdown();

      const before = await journals(memory, tree);
      expect(before.map((events) => events.at(-1)?.type === 'runFinished')).toEqual(
        [true, true, false].map((finished, i) => i < level && finished),
      );

      const next = newKit();
      const again = threeLevels(next, memory, false);
      const second = spawnRoot(next, again.root);
      await next.settle();
      const after = await journals(memory, again);
      expect(after[0]).toEqual(before[0]);
      expect(after.slice(1).map((events) => events.at(-1))).toEqual([BY_PARENT, BY_PARENT]);
      expect(second.reporter.messages()).toMatchObject([{ outcome: 'cancelled' }]);
      // Nothing was called to be cancelled: no model call and no tool call, at any level.
      expect(again.models.map((m) => m.requests.length)).toEqual([0, 0, 0]);
      expect(again.held.map((h) => h.calls.length)).toEqual([0, 0, 0]);

      // No second report.
      await next.settle();
      expect(second.reporter.messages()).toEqual([]);
      expect([...actorsUnderRoot(next)].filter(([, stopped]) => !stopped)).toEqual([]);
    });
  }

  it('reports anyway once a sub-run hasn’t closed in time, and lists it until then', async () => {
    const memory = inMemoryPersistence({ clock: () => 0 });
    const kit = newKit();
    const shape = threeLevels(kit, memory);
    const tree = threeLevels(kit, dieAfterFinishing(memory, shape.root.persistenceId(RUN_ID)));
    const { ref, reporter } = spawnRoot(kit, tree.root);
    await kit.settle();
    ref.tell({ type: 'cancel', reason: 'the incident was resolved' });
    await kit.settle();
    expect(await statusOf(kit, ref)).toMatchObject({
      phase: 'finished',
      subRuns: [{ agent: 'log-analyst', runId: ANALYST_ID }],
    });
    expect(reporter.messages()).toEqual([]);

    await kit.advance(CLOSE_TIMEOUT_MS - 1);
    expect(reporter.messages()).toEqual([]);
    await kit.advance(1);
    expect(reporter.messages()).toMatchObject([{ outcome: 'cancelled' }]);
    expect(await statusOf(kit, ref)).toMatchObject({ subRuns: [] });
    expect(actorsUnderRoot(kit).get(ANALYST)).toBe(true);
  });
});

describe('cancelling a sub-run alone', () => {
  it('finishes it with cancelled, and its parent’s model hears so and carries on', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const clock = (): number => kit.scheduler.now();
    const readLog = heldTool('read_log');
    const analyst = agent({
      name: 'log-analyst',
      model: scriptedModel([callTool('read_log', {}, { id: 'toolu_r' })]),
      system: 'You read service logs.',
      tools: [readLog.tool],
      persistence,
      clock,
    });
    const rootModel = scriptedModel([
      callTool('ask_log_analyst', { task: 'Find errors.' }, { id: 'toolu_d' }),
      say('Carried on without the logs.'),
    ]);
    const root = agent({
      name: 'triage',
      model: rootModel,
      system: 'You triage production incidents.',
      tools: [delegate(analyst, { name: 'ask_log_analyst', description: 'Ask the analyst.' })],
      persistence,
      clock,
    });
    const { ref, reporter } = spawnRoot(kit, root);
    await kit.settle();

    // Ids with no live run under them change nothing.
    ref.tell({ type: 'cancel', reason: 'wrong', runId: `${RUN_ID}/9.9` });
    ref.tell({ type: 'cancel', reason: 'wrong', runId: 'another-run' });
    await kit.settle();
    expect(readLog.calls[0]?.signal.aborted).toBe(false);

    ref.tell({ type: 'cancel', reason: 'the logs aren’t needed', runId: ANALYST_ID });
    await kit.settle();
    expect(reporter.messages()).toMatchObject([
      { outcome: 'completed', text: 'Carried on without the logs.' },
    ]);
    expect(readLog.calls[0]?.signal.aborted).toBe(true);
    const sub = await journalOf(persistence, analyst, ANALYST_ID);
    expect(sub.at(-1)).toEqual(cancelledWith('the logs aren’t needed'));
    const error = 'The sub-agent stopped: cancelled. Cancelled: the logs aren’t needed';
    expect(await journalOf(persistence, root)).toContainEqual({
      type: 'toolFinished',
      step: 1,
      callId: 'toolu_d',
      result: { ok: false, error },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(rootModel.requests[1]?.transcript.at(-1)).toEqual({
      role: 'toolResults',
      results: [{ callId: 'toolu_d', result: { ok: false, error } }],
    });
  });
});

describe('a cancelled run’s pending approvals', () => {
  async function decide(
    kit: TestKit,
    ref: ActorRef<RunMsg>,
    runId: string,
    callId: string,
  ): Promise<DecideReply | undefined> {
    const probe = kit.probe<DecideReply>(`decider-${runId.replaceAll('/', '_')}-${callId}`);
    ref.tell({ type: 'decide', runId, callId, approved: true, by: 'kyle', replyTo: probe.ref });
    await kit.settle();
    return probe.messages()[0];
  }

  // The delegation is the step's second call.
  const PAGER_ID = `${RUN_ID}/1.1`;

  it('reply notWaiting to any decision, in the run and under it', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const clock = (): number => kit.scheduler.now();
    const page = (name: string) =>
      tool({
        name,
        description: 'Page the on-call engineer.',
        input: { type: 'object' },
        needsApproval: true,
        run: () => Promise.resolve('paged'),
      });
    const analyst = agent({
      name: 'log-analyst',
      model: scriptedModel([callTool('page_team', {}, { id: 'toolu_t' })]),
      system: 'You read service logs.',
      tools: [page('page_team')],
      persistence,
      clock,
    });
    const root = agent({
      name: 'triage',
      model: scriptedModel([
        callTools([
          { name: 'page_oncall', input: {}, id: 'toolu_p' },
          { name: 'ask_log_analyst', input: { task: 'Page them.' }, id: 'toolu_d' },
        ]),
      ]),
      system: 'You triage production incidents.',
      tools: [
        page('page_oncall'),
        delegate(analyst, { name: 'ask_log_analyst', description: 'Ask the analyst.' }),
      ],
      persistence,
      clock,
    });
    const { ref, reporter } = spawnRoot(kit, root);
    await kit.settle();
    expect((await statusOf(kit, ref)).approvals).toHaveLength(1);

    ref.tell({ type: 'cancel', reason: 'the incident was resolved' });
    await kit.settle();
    expect(reporter.messages()).toMatchObject([{ outcome: 'cancelled' }]);
    const rootEvents = await journalOf(persistence, root);
    const subEvents = await journalOf(persistence, analyst, PAGER_ID);
    expect(subEvents.at(-1)).toEqual(BY_PARENT);

    expect(await decide(kit, ref, RUN_ID, 'toolu_p')).toEqual({ ok: false, reason: 'notWaiting' });
    // The sub-run has closed, so no live run in the tree has its id.
    expect(await decide(kit, ref, PAGER_ID, 'toolu_t')).toEqual({
      ok: false,
      reason: 'unknownRun',
    });
    expect(await journalOf(persistence, root)).toEqual(rootEvents);
    expect(await journalOf(persistence, analyst, PAGER_ID)).toEqual(subEvents);
    expect((await statusOf(kit, ref)).approvals).toEqual([]);
  });
});
