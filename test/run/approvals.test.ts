// Milestone 2's T4: approvals. A call that needs a person's approval waits for a decision that's
// journaled, so the wait survives any restart, a timeout is measured from the request on the
// agent's clock, and a decision sent to the root reaches the sub-run it's for.

import type { ActorRef } from '@kylewillett/troupe';
import {
  inMemoryPersistence,
  projection,
  type Persistence,
  type StandardSchemaV1,
  type StoredEvent,
} from '@kylewillett/troupe/persistence';
import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agent,
  APPROVAL_TAG,
  delegate,
  readRun,
  tool,
  type Agent,
  type DecideReply,
  type JsonValue,
  type PendingApproval,
  type RunEvent,
  type RunMsg,
  type Tool,
  type ToolContext,
  type Turn,
} from '../../src/index.ts';
import { callTool, callTools, say, scriptedModel } from '../../src/testkit/index.ts';
import {
  deferred,
  drive,
  journalOf,
  makeAgent,
  recordedPersistence,
  recordingTool,
  RUN_ID,
  startRun,
  statusOf,
  type Deferred,
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

const PAGE = { team: 'payments', severity: 'sev1' };

interface PageOptions {
  readonly needsApproval?: boolean | ((input: JsonValue) => boolean);
  readonly approvalTimeoutMs?: number;
  readonly parse?: StandardSchemaV1<unknown, JsonValue>;
  /** Holds each call open until the test resolves it. */
  readonly held?: Deferred<JsonValue>;
}

/** `page_oncall`, which isn't safe to repeat, and needs approval unless told otherwise. */
function pageTool(options: PageOptions = {}): {
  tool: Tool;
  calls: { input: JsonValue; ctx: ToolContext }[];
} {
  const calls: { input: JsonValue; ctx: ToolContext }[] = [];
  const t = tool({
    name: 'page_oncall',
    description: 'Page the on-call engineer for a team.',
    input: { type: 'object' },
    needsApproval: options.needsApproval ?? true,
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: options.approvalTimeoutMs }),
    ...(options.parse === undefined ? {} : { parse: options.parse }),
    run: (input, ctx) => {
      calls.push({ input, ctx });
      return options.held?.promise ?? Promise.resolve({ paged: true });
    },
  });
  return { tool: t, calls };
}

/** The response that pages, and queries metrics alongside, in one step. */
const pageAndQuery = () =>
  callTools([
    { name: 'page_oncall', input: PAGE, id: 'toolu_p' },
    { name: 'query_metrics', input: {}, id: 'toolu_q' },
  ]);

const REQUESTED: PendingApproval = {
  runId: RUN_ID,
  step: 1,
  callId: 'toolu_p',
  tool: 'page_oncall',
  input: PAGE,
  requestedAt: 0,
};

interface Decision {
  readonly runId?: string;
  readonly callId?: string;
  readonly approved: boolean;
  readonly by?: string;
  readonly note?: string;
}

let probes = 0;

/** Sends `decide` to `ref`, driving the system until it replies. */
async function decide(kit: TestKit, ref: ActorRef<RunMsg>, d: Decision): Promise<DecideReply> {
  const probe = kit.probe<DecideReply>(`decide-${String(probes++)}`);
  ref.tell({
    type: 'decide',
    runId: d.runId ?? RUN_ID,
    callId: d.callId ?? 'toolu_p',
    approved: d.approved,
    by: d.by ?? 'kyle',
    ...(d.note === undefined ? {} : { note: d.note }),
    replyTo: probe.ref,
  });
  // messages() takes what it returns, so the reply is kept as it's found.
  let reply: DecideReply | undefined;
  await drive(kit, () => {
    reply ??= probe.messages()[0];
    return reply !== undefined;
  });
  if (reply === undefined) throw new Error('the run never replied to decide');
  return reply;
}

describe('approval', () => {
  it('holds the call until it is approved, while the step’s other calls run, and sends one turn', async () => {
    const kit = newKit();
    const recorded = recordedPersistence(() => kit.scheduler.now());
    const page = pageTool();
    const query = recordingTool('query_metrics');
    const model = scriptedModel([pageAndQuery(), say('Paged payments.')]);
    const a = makeAgent(kit, recorded.persistence, model, [page.tool, query.tool]);
    const { ref, reporter } = startRun(kit, a);
    await kit.advance(5_000);

    // Asked in the write of the response that called it.
    expect(recorded.appends.slice(0, 2)).toEqual([
      ['runStarted'],
      ['modelResponded', 'approvalRequested'],
    ]);
    expect(query.calls).toHaveLength(1);
    expect(page.calls).toHaveLength(0);
    expect(model.requests).toHaveLength(1);
    const waiting = await statusOf(kit, ref);
    expect(waiting.approvals).toEqual([REQUESTED]);
    expect(waiting.pending).toEqual({ kind: 'tools', callIds: ['toolu_p'] });

    expect(await decide(kit, ref, { approved: true, note: 'Go.' })).toEqual({ ok: true });
    await kit.settle();
    expect(page.calls.map((c) => c.input)).toEqual([PAGE]);
    // Both results go back as one turn, in the order the model called them.
    expect(model.requests[1]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [
        { callId: 'toolu_p', result: { ok: true, output: { paged: true } } },
        { callId: 'toolu_q', result: { ok: true, output: { from: 'query_metrics' } } },
      ],
    });
    reporter.expectMessage((m) => m.outcome === 'completed');
    const events = await journalOf(recorded.persistence, a);
    expect(events.filter((e) => e.type.startsWith('approval'))).toEqual<RunEvent[]>([
      { type: 'approvalRequested', ...REQUESTED },
      {
        type: 'approvalDecided',
        step: 1,
        callId: 'toolu_p',
        approved: true,
        by: 'kyle',
        note: 'Go.',
        decidedAt: 5_000,
      },
    ]);
    // readRun shows the request and the decision on the call.
    const { steps } = await readRun(a, RUN_ID);
    expect(steps[0]?.tools[0]?.approval).toEqual({
      requestedSeq: 3,
      requestedAt: 0,
      decision: { seq: 5, approved: true, by: 'kyle', note: 'Go.', decidedAt: 5_000 },
    });
  });

  it('turns a denial into an error result that says who denied it and why, and never runs the tool', async () => {
    const kit = newKit();
    const recorded = recordedPersistence(() => kit.scheduler.now());
    const page = pageTool();
    const model = scriptedModel([callTool('page_oncall', PAGE, { id: 'toolu_p' }), say('OK.')]);
    const a = makeAgent(kit, recorded.persistence, model, [page.tool]);
    const { ref, reporter } = startRun(kit, a);
    await kit.settle();

    expect(await decide(kit, ref, { approved: false, note: 'Not a sev1.' })).toEqual({ ok: true });
    await kit.settle();
    expect(page.calls).toHaveLength(0);
    // The denial is the call's result, in the same write.
    expect(recorded.appends[2]).toEqual(['approvalDecided', 'toolFinished']);
    expect(model.requests[1]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: [
        {
          callId: 'toolu_p',
          result: { ok: false, error: 'A person denied this call. kyle: Not a sev1.' },
        },
      ],
    });
    reporter.expectMessage((m) => m.outcome === 'completed');
    const { steps } = await readRun(a, RUN_ID);
    expect(steps[0]?.tools[0]?.approval?.decision).toMatchObject({ approved: false });
  });

  it('keeps waiting through a restart, asks nobody again, and honours a decision sent to the new incarnation', async () => {
    const persistence = inMemoryPersistence();
    const first = newKit();
    const model1 = scriptedModel([pageAndQuery()]);
    const page1 = pageTool();
    const query1 = recordingTool('query_metrics');
    const a1 = makeAgent(first, persistence, model1, [page1.tool, query1.tool]);
    startRun(first, a1);
    await first.settle();
    expect(query1.calls).toHaveLength(1);
    await first.shutdown();

    const second = newKit();
    const model2 = scriptedModel([say('Paged payments.')]);
    const page2 = pageTool();
    const query2 = recordingTool('query_metrics');
    const a2 = makeAgent(second, persistence, model2, [page2.tool, query2.tool]);
    const { ref, reporter } = startRun(second, a2);
    await second.advance(60_000);

    expect(model2.requests).toHaveLength(0);
    expect(page2.calls).toHaveLength(0);
    expect(query2.calls).toHaveLength(0);
    expect((await statusOf(second, ref)).approvals).toEqual([REQUESTED]);

    expect(await decide(second, ref, { approved: true })).toEqual({ ok: true });
    await second.settle();
    expect(page2.calls).toHaveLength(1);
    expect(model2.requests).toHaveLength(1);
    reporter.expectMessage((m) => m.outcome === 'completed');
  });

  describe('timeout', () => {
    const TIMEOUT = 30_000;
    const TIMED_OUT = `Nobody decided on this call within ${String(TIMEOUT)} ms, so it was denied.`;

    /**
     * Waits 10 s for a decision on a first process, which then dies. The second process's agent
     * clock starts `downMs` after the first one stopped, as a wall clock would.
     */
    async function restartedAfter(persistence: Persistence, downMs: number) {
      const first = newKit();
      const a1 = makeAgent(
        first,
        persistence,
        scriptedModel([callTool('page_oncall', PAGE, { id: 'toolu_p' })]),
        [pageTool({ approvalTimeoutMs: TIMEOUT }).tool],
      );
      startRun(first, a1);
      await first.advance(10_000);
      await first.shutdown();

      const second = newKit();
      const offset = 10_000 + downMs;
      const model = scriptedModel([say('Nobody answered.')]);
      const page = pageTool({ approvalTimeoutMs: TIMEOUT });
      const a2 = makeAgent(second, persistence, model, [page.tool], {
        clock: () => offset + second.scheduler.now(),
      });
      const { ref, reporter } = startRun(second, a2);
      return { kit: second, ref, reporter, model, page, agent: a2 };
    }

    it('denies the call, measured from the request on the agent’s clock, across a restart', async () => {
      const persistence = inMemoryPersistence();
      // Down for 5 s, so 15 s are left of the 30.
      const {
        kit,
        ref,
        reporter,
        model,
        page,
        agent: a,
      } = await restartedAfter(persistence, 5_000);
      await kit.advance(14_999);
      expect((await statusOf(kit, ref)).approvals).toEqual([{ ...REQUESTED, timeoutMs: TIMEOUT }]);

      await kit.advance(1);
      reporter.expectMessage((m) => m.outcome === 'completed');
      expect(page.calls).toHaveLength(0);
      const events = await journalOf(persistence, a);
      expect(events.slice(3, 5)).toEqual<RunEvent[]>([
        {
          type: 'approvalDecided',
          step: 1,
          callId: 'toolu_p',
          approved: false,
          by: 'timeout',
          decidedAt: TIMEOUT,
          timedOut: true,
        },
        {
          type: 'toolFinished',
          step: 1,
          callId: 'toolu_p',
          result: { ok: false, error: TIMED_OUT },
        },
      ]);
      expect(model.requests[0]?.transcript.at(-1)).toEqual<Turn>({
        role: 'toolResults',
        results: [{ callId: 'toolu_p', result: { ok: false, error: TIMED_OUT } }],
      });
      // Too late now.
      expect(await decide(kit, ref, { approved: true })).toEqual({
        ok: false,
        reason: 'notWaiting',
      });
    });

    it('denies at once a call whose timeout passed while the run was down', async () => {
      const persistence = inMemoryPersistence();
      const { kit, reporter, page, agent: a } = await restartedAfter(persistence, 40_000);
      await kit.settle();
      reporter.expectMessage((m) => m.outcome === 'completed');
      expect(page.calls).toHaveLength(0);
      const events = await journalOf(persistence, a);
      expect(events[3]).toMatchObject({
        type: 'approvalDecided',
        timedOut: true,
        decidedAt: 50_000,
      });
    });
  });

  it('lets the first decision win: a second, or one for a call that isn’t waiting, changes nothing', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence();
    // The page is held, so the call is still pending when the later decisions arrive.
    const held = deferred<JsonValue>();
    const page = pageTool({ held });
    const model = scriptedModel([pageAndQuery(), say('Done.')]);
    const a = makeAgent(kit, persistence, model, [page.tool, recordingTool('query_metrics').tool]);
    const { ref } = startRun(kit, a);
    await kit.settle();

    const notWaiting = { ok: false, reason: 'notWaiting' };
    expect(await decide(kit, ref, { approved: true, by: 'kyle' })).toEqual({ ok: true });
    const before = await journalOf(persistence, a);
    expect(await decide(kit, ref, { approved: false, by: 'sam' })).toEqual(notWaiting);
    // Never asked about, and not a call at all.
    expect(await decide(kit, ref, { approved: true, callId: 'toolu_q' })).toEqual(notWaiting);
    expect(await decide(kit, ref, { approved: true, callId: 'toolu_x' })).toEqual(notWaiting);
    expect(await journalOf(persistence, a)).toEqual(before);
    expect(page.calls).toHaveLength(1);

    held.resolve({ paged: true });
    await kit.settle();
    const decided = (await journalOf(persistence, a)).filter((e) => e.type === 'approvalDecided');
    expect(decided).toEqual([expect.objectContaining({ approved: true, by: 'kyle' })]);
  });

  it('works with no replyTo, since a caller may not want the answer', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence();
    const page = pageTool();
    const model = scriptedModel([callTool('page_oncall', PAGE, { id: 'toolu_p' }), say('OK.')]);
    const a = makeAgent(kit, persistence, model, [page.tool]);
    const { ref, reporter } = startRun(kit, a);
    await kit.settle();
    ref.tell({ type: 'decide', runId: RUN_ID, callId: 'toolu_p', approved: true, by: 'kyle' });
    await kit.settle();
    expect(page.calls).toHaveLength(1);
    reporter.expectMessage((m) => m.outcome === 'completed');
  });

  describe('needsApproval as a function', () => {
    it('is called once per call, and its answer is journaled, so a run recovered with another function behaves as it did', async () => {
      const persistence = inMemoryPersistence();
      const asked: JsonValue[] = [];
      const sev1Only = (input: JsonValue): boolean => {
        asked.push(input);
        return (input as { severity?: string }).severity === 'sev1';
      };
      const script = () =>
        callTools([
          { name: 'page_oncall', input: PAGE, id: 'toolu_1' },
          { name: 'page_oncall', input: { team: 'search', severity: 'sev3' }, id: 'toolu_3' },
        ]);
      const first = newKit();
      const page1 = pageTool({ needsApproval: sev1Only });
      const a1 = makeAgent(first, persistence, scriptedModel([script()]), [page1.tool]);
      const { ref: ref1 } = startRun(first, a1);
      await first.settle();
      expect(asked).toEqual([PAGE, { team: 'search', severity: 'sev3' }]);
      expect(page1.calls.map((c) => c.ctx.callId)).toEqual(['toolu_3']);
      expect((await statusOf(first, ref1)).approvals.map((p) => p.callId)).toEqual(['toolu_1']);
      await first.shutdown();

      // The opposite answer now. It's never asked: the journal already says what it said.
      const second = newKit();
      let askedAgain = 0;
      const page2 = pageTool({
        needsApproval: (input) => {
          askedAgain += 1;
          return (input as { severity?: string }).severity !== 'sev1';
        },
      });
      const model2 = scriptedModel([say('Paged both.')]);
      const a2 = makeAgent(second, persistence, model2, [page2.tool]);
      const { ref } = startRun(second, a2);
      await second.settle();
      expect(askedAgain).toBe(0);
      expect(page2.calls).toHaveLength(0);
      expect(model2.requests).toHaveLength(0);
      expect((await statusOf(second, ref)).approvals.map((p) => p.callId)).toEqual(['toolu_1']);
      expect(asked).toHaveLength(2);
    });

    it('asks when the function throws, and asks nobody about a call whose input fails parse', async () => {
      const kit = newKit();
      const recorded = recordedPersistence(() => kit.scheduler.now());
      const needsTeam: StandardSchemaV1<unknown, JsonValue> = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) =>
            typeof (value as { team?: unknown }).team === 'string'
              ? { value: value as JsonValue }
              : { issues: [{ message: 'is required', path: ['team'] }] },
        },
      };
      let asked = 0;
      const page = pageTool({
        parse: needsTeam,
        needsApproval: () => {
          asked += 1;
          throw new Error('the rota is down');
        },
      });
      const model = scriptedModel([
        callTools([
          { name: 'page_oncall', input: {}, id: 'toolu_bad' },
          { name: 'page_oncall', input: PAGE, id: 'toolu_ok' },
        ]),
        say('Unused.'),
      ]);
      const a = makeAgent(kit, recorded.persistence, model, [page.tool]);
      const { ref } = startRun(kit, a);
      await kit.settle();

      expect(asked).toBe(1);
      expect(recorded.appends[1]).toEqual(['modelResponded', 'approvalRequested', 'toolFinished']);
      const events = await journalOf(recorded.persistence, a);
      expect(events[2]).toMatchObject({ type: 'approvalRequested', callId: 'toolu_ok' });
      expect(events[3]).toEqual<RunEvent>({
        type: 'toolFinished',
        step: 1,
        callId: 'toolu_bad',
        result: { ok: false, error: 'Invalid input for page_oncall: team: is required' },
      });
      expect((await statusOf(kit, ref)).approvals.map((p) => p.callId)).toEqual(['toolu_ok']);
      expect(page.calls).toHaveLength(0);
    });
  });

  describe('in a tree', () => {
    const SUB_ID = `${RUN_ID}/1.0`;

    function tree(kit: TestKit, persistence: Persistence, delegationNeedsApproval = false) {
      const clock = (): number => kit.scheduler.now();
      const page = pageTool();
      const analystModel = scriptedModel([
        callTool('page_oncall', PAGE, { id: 'toolu_p' }),
        say('Paged payments.'),
      ]);
      const analyst = agent({
        name: 'log-analyst',
        model: analystModel,
        system: 'You read logs, and page when they say to.',
        tools: [page.tool],
        persistence,
        clock,
      });
      const model = scriptedModel([
        callTool('ask_log_analyst', { task: 'Read checkout.' }, { id: 'toolu_d' }),
        say('The analyst paged.'),
      ]);
      const triage: Agent = agent({
        name: 'triage',
        model,
        system: 'You triage production incidents.',
        tools: [
          delegate(analyst, {
            name: 'ask_log_analyst',
            description: 'Give the log analyst a task.',
            needsApproval: delegationNeedsApproval,
          }),
        ],
        persistence,
        clock,
      });
      return { triage, analyst, page, analystModel };
    }

    it('forwards a decision sent to the root to the sub-run it’s for, and says when no run has the id', async () => {
      const kit = newKit();
      const persistence = inMemoryPersistence();
      const { triage, analyst, page } = tree(kit, persistence);
      const { ref, reporter } = startRun(kit, triage);
      await kit.settle();

      const status = await statusOf(kit, ref);
      expect(status.subRuns).toEqual([{ agent: 'log-analyst', runId: SUB_ID }]);
      // The root's own status lists only its own calls.
      expect(status.approvals).toEqual([]);
      const sub = await readRun(analyst, SUB_ID);
      expect(sub.events[2]?.event).toMatchObject({ type: 'approvalRequested', runId: SUB_ID });

      const unknownRun = { ok: false, reason: 'unknownRun' };
      expect(await decide(kit, ref, { runId: `${RUN_ID}/9.9`, approved: true })).toEqual(
        unknownRun,
      );
      expect(await decide(kit, ref, { runId: `${RUN_ID}/1.00`, approved: true })).toEqual(
        unknownRun,
      );
      expect(await decide(kit, ref, { runId: 'incident-9999', approved: true })).toEqual(
        unknownRun,
      );
      expect(await decide(kit, ref, { runId: SUB_ID, approved: true })).toEqual({ ok: true });
      await kit.settle();
      expect(page.calls.map((c) => c.ctx.runId)).toEqual([SUB_ID]);
      reporter.expectMessage((m) => m.outcome === 'completed' && m.text === 'The analyst paged.');
    });

    it('starts no sub-run for a delegation until it’s approved', async () => {
      const kit = newKit();
      const persistence = inMemoryPersistence();
      const { triage, analystModel } = tree(kit, persistence, true);
      const { ref, reporter } = startRun(kit, triage);
      await kit.settle();

      const status = await statusOf(kit, ref);
      expect(status.subRuns).toEqual([]);
      expect(status.approvals).toEqual([
        {
          runId: RUN_ID,
          step: 1,
          callId: 'toolu_d',
          tool: 'ask_log_analyst',
          input: { task: 'Read checkout.' },
          requestedAt: 0,
        },
      ]);
      expect(analystModel.requests).toHaveLength(0);
      // A decision for a sub-run that hasn't started has nowhere to go.
      expect(await decide(kit, ref, { runId: SUB_ID, approved: true })).toEqual({
        ok: false,
        reason: 'unknownRun',
      });

      expect(await decide(kit, ref, { callId: 'toolu_d', approved: true })).toEqual({ ok: true });
      await kit.settle();
      expect(analystModel.requests).toHaveLength(1);
      expect((await statusOf(kit, ref)).subRuns).toEqual([{ agent: 'log-analyst', runId: SUB_ID }]);
      expect(await decide(kit, ref, { runId: SUB_ID, approved: true })).toEqual({ ok: true });
      await kit.settle();
      reporter.expectMessage((m) => m.outcome === 'completed');
    });
  });

  it('tags every request and decision, so one projection sees them across runs', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence();
    const seen: StoredEvent[] = [];
    kit.system.spawn(
      projection({
        name: 'inbox',
        persistence,
        tag: APPROVAL_TAG,
        handle: (e) => {
          seen.push(e);
        },
      }),
      'inbox',
    );
    const runs = ['incident-4211', 'incident-4212'].map((runId) => {
      const model = scriptedModel([callTool('page_oncall', PAGE, { id: 'toolu_p' }), say('OK.')]);
      const a = makeAgent(kit, persistence, model, [pageTool().tool]);
      return { runId, ...startRun(kit, a, runId) };
    });
    await kit.advance(1_000);
    expect(seen.map((e) => (e.event as RunEvent).type)).toEqual([
      'approvalRequested',
      'approvalRequested',
    ]);

    const [one, two] = runs;
    if (one === undefined || two === undefined) throw new Error('two runs');
    await decide(kit, one.ref, { runId: one.runId, approved: true });
    await decide(kit, two.ref, { runId: two.runId, approved: false, note: 'Duplicate.' });
    await kit.advance(1_000);

    const byRun = (id: string) =>
      seen.filter((e) => e.persistenceId === `run-triage-${id}`).map((e) => e.event as RunEvent);
    expect(byRun(one.runId)).toEqual([
      expect.objectContaining({ type: 'approvalRequested', runId: one.runId }),
      expect.objectContaining({ type: 'approvalDecided', approved: true }),
    ]);
    expect(byRun(two.runId)).toEqual([
      expect.objectContaining({ type: 'approvalRequested', runId: two.runId }),
      expect.objectContaining({ type: 'approvalDecided', approved: false, note: 'Duplicate.' }),
    ]);
    expect(seen.every((e) => e.tags.includes(APPROVAL_TAG))).toBe(true);
  });
});
