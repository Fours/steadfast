import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue, ModelResponse, RunEvent, Turn } from '../../src/index.ts';
import {
  callTool,
  callTools,
  faultyModel,
  rateLimited,
  say,
  scriptedModel,
} from '../../src/testkit/index.ts';
import {
  deferred,
  drive,
  INPUT,
  journalOf,
  makeAgent,
  PAST_BACKOFF,
  recordedPersistence,
  recordingTool,
  RUN_ID,
  startRun,
  statusOf,
  SYSTEM,
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

describe('a run', () => {
  it('with no tool calls persists runStarted, modelResponded and runFinished, and reports', async () => {
    kit.scheduler.advanceTo(1_700);
    const answer = say('The cause is a bad deploy.', { usage: usage(120, 30) });
    const model = scriptedModel([answer]);
    const a = makeAgent(kit, recorded.persistence, model);
    const { reporter } = startRun(kit, a);
    await kit.settle();

    expect(await journalOf(recorded.persistence, a)).toEqual<RunEvent[]>([
      { type: 'runStarted', agent: 'triage', model: 'scripted', input: INPUT, startedAt: 1_700 },
      { type: 'modelResponded', step: 1, response: answer },
      { type: 'runFinished', outcome: 'completed', text: 'The cause is a bad deploy.' },
    ]);
    // The response and the finish are one write, so no crash can land between them.
    expect(recorded.appends).toEqual([['runStarted'], ['modelResponded', 'runFinished']]);
    reporter.expectMessage({
      type: 'runFinished',
      runId: RUN_ID,
      outcome: 'completed',
      text: 'The cause is a bad deploy.',
      usage: usage(120, 30),
    });
    reporter.expectNoMessage();
    expect(model.requests).toEqual([
      { system: SYSTEM, transcript: [{ role: 'user', text: INPUT }], tools: [] },
    ]);
  });

  it('keeps its journal in run-<agent>-<runId>', async () => {
    const a = makeAgent(kit, recorded.persistence, scriptedModel([say('ok')]));
    expect(a.persistenceId(RUN_ID)).toBe('run-triage-incident-4211');
    startRun(kit, a);
    await kit.settle();
    expect(await recorded.persistence.journal.read('run-triage-incident-4211', 1, 10)).toHaveLength(
      3,
    );
  });

  it('runs a step’s tool calls at the same time, and sends their results as one turn in call order', async () => {
    const names = ['read_log', 'query_metrics', 'page_oncall'] as const;
    const started: string[] = [];
    const gates = new Map(names.map((n) => [n, deferred<JsonValue>()]));
    const tools = names.map((n) =>
      recordingTool(n, () => {
        started.push(n);
        // Each one is held until the test lets it go, so they can only all start if they run at
        // the same time. Run one after another, the first would block the rest.
        return gates.get(n)?.promise ?? Promise.reject(new Error('no gate'));
      }),
    );
    const call = callTools(names.map((n) => ({ name: n, input: { service: 'checkout' } })));
    const model = scriptedModel([call, say('Paged the on-call.')]);
    const a = makeAgent(
      kit,
      recorded.persistence,
      model,
      tools.map((t) => t.tool),
    );
    const { ref } = startRun(kit, a);

    await drive(kit, () => started.length === 3);
    expect(started).toEqual(['read_log', 'query_metrics', 'page_oncall']);
    expect((await statusOf(kit, ref)).pending).toEqual({
      kind: 'tools',
      callIds: ['read_log_1', 'query_metrics_1', 'page_oncall_1'],
    });

    // They finish in the reverse order.
    for (const n of [...names].reverse()) {
      gates.get(n)?.resolve({ from: n });
      await drive(kit);
    }
    await kit.settle();

    const events = await journalOf(recorded.persistence, a);
    expect(events.filter((e) => e.type === 'toolFinished')).toEqual([
      {
        type: 'toolFinished',
        step: 1,
        callId: 'page_oncall_1',
        result: { ok: true, output: { from: 'page_oncall' } },
      },
      {
        type: 'toolFinished',
        step: 1,
        callId: 'query_metrics_1',
        result: { ok: true, output: { from: 'query_metrics' } },
      },
      {
        type: 'toolFinished',
        step: 1,
        callId: 'read_log_1',
        result: { ok: true, output: { from: 'read_log' } },
      },
    ]);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.transcript.at(-1)).toEqual<Turn>({
      role: 'toolResults',
      results: names.map((n) => ({
        callId: `${n}_1`,
        result: { ok: true, output: { from: n } },
      })),
    });
    expect(events.at(-1)).toEqual({
      type: 'runFinished',
      outcome: 'completed',
      text: 'Paged the on-call.',
    });
  });

  describe('over five steps', () => {
    const script: ModelResponse[] = [
      callTool(
        'read_log',
        { service: 'checkout' },
        { text: 'Reading the log.', usage: usage(10, 2) },
      ),
      callTool('query_metrics', { metric: 'errors' }, { usage: usage(20, 3) }),
      callTools(
        [
          { name: 'read_log', input: { service: 'payments' } },
          { name: 'query_metrics', input: { metric: 'latency' } },
        ],
        { usage: usage(30, 4) },
      ),
      callTool('read_log', { service: 'gateway' }, { id: 'toolu_01Gateway', usage: usage(40, 5) }),
      say('A bad deploy of the gateway.', { usage: usage(50, 6) }),
    ];

    async function runFive() {
      const model = scriptedModel(script);
      const tools = [recordingTool('read_log').tool, recordingTool('query_metrics').tool];
      const a = makeAgent(kit, recorded.persistence, model, tools);
      const { reporter } = startRun(kit, a);
      await kit.settle();
      return { model, a, reporter };
    }

    it('only grows the transcript: every request starts with the one before', async () => {
      const { model } = await runFive();
      expect(model.requests).toHaveLength(5);
      for (let i = 1; i < model.requests.length; i++) {
        const before = model.requests[i - 1]?.transcript ?? [];
        const after = model.requests[i]?.transcript ?? [];
        expect(after.length).toBeGreaterThan(before.length);
        expect(after.slice(0, before.length)).toEqual(before);
      }
    });

    it("passes each response's raw to the next request unchanged", async () => {
      const { model } = await runFive();
      for (let i = 0; i < script.length - 1; i++) {
        const assistant = model.requests[i + 1]?.transcript.filter((t) => t.role === 'assistant');
        const turn = assistant?.[i];
        expect(turn?.role).toBe('assistant');
        if (turn?.role !== 'assistant') continue;
        expect(turn.response.raw).toEqual(script[i]?.raw);
        expect(turn.response).toEqual(script[i]);
      }
    });

    it('sums usage and reports it', async () => {
      const { reporter } = await runFive();
      reporter.expectMessage({
        type: 'runFinished',
        runId: RUN_ID,
        outcome: 'completed',
        text: 'A bad deploy of the gateway.',
        usage: usage(150, 20),
      });
    });

    it('sends the agent’s system prompt and tool specs with every request', async () => {
      const { model, a } = await runFive();
      const specs = a.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input: t.input,
      }));
      for (const request of model.requests) {
        expect(request.system).toBe(SYSTEM);
        expect(request.tools).toEqual(specs);
      }
    });
  });

  describe('status', () => {
    it('replies with the phase, step, usage and what the run is waiting on', async () => {
      const gate = deferred<JsonValue>();
      const readLog = recordingTool('read_log', () => gate.promise);
      const model = scriptedModel([
        callTool('read_log', { service: 'checkout' }, { usage: usage(100, 10) }),
        say('Done.', { usage: usage(200, 20) }),
      ]);
      const a = makeAgent(kit, recorded.persistence, model, [readLog.tool]);
      const { ref } = startRun(kit, a);

      // Sent while the run recovers, so it's answered before the run has started.
      expect(await statusOf(kit, ref)).toEqual({
        phase: 'new',
        step: 0,
        usage: usage(0, 0),
        pending: { kind: 'none' },
      });

      await drive(kit, () => readLog.calls.length === 1);
      expect(await statusOf(kit, ref)).toEqual({
        phase: 'running',
        step: 1,
        usage: usage(100, 10),
        pending: { kind: 'tools', callIds: ['read_log_1'] },
      });

      gate.resolve('502s since 14:02');
      await kit.settle();
      expect(await statusOf(kit, ref)).toEqual({
        phase: 'finished',
        step: 2,
        usage: usage(300, 30),
        pending: { kind: 'none' },
        outcome: 'completed',
      });
    });

    it('says when the run is waiting on the model', async () => {
      const answer = deferred<ModelResponse>();
      const model = scriptedModel([() => answer.promise]);
      const a = makeAgent(kit, recorded.persistence, model);
      const { ref } = startRun(kit, a);
      await drive(kit, () => model.requests.length === 1);
      expect(await statusOf(kit, ref)).toMatchObject({
        phase: 'running',
        pending: { kind: 'model' },
      });
      answer.resolve(say('ok'));
      await kit.settle();
    });

    it('ignores a model answer for another step while it waits on the model', async () => {
      const answer = deferred<ModelResponse>();
      const model = scriptedModel([callTool('read_log', {}), () => answer.promise]);
      const a = makeAgent(kit, recorded.persistence, model, [recordingTool('read_log').tool]);
      const { ref, reporter } = startRun(kit, a);
      await drive(kit, () => model.requests.length === 2);
      const before = await journalOf(recorded.persistence, a);

      // Waiting on step 2: a late answer for step 1, and one for step 3, change nothing.
      ref.tell({ type: 'modelReplied', step: 1, response: say('late') });
      ref.tell({ type: 'modelReplied', step: 3, response: say('early') });
      ref.tell({ type: 'modelFailed', step: 1, error: { message: 'late' } });
      await drive(kit);
      expect(await journalOf(recorded.persistence, a)).toEqual(before);
      expect(await statusOf(kit, ref)).toMatchObject({ step: 1, pending: { kind: 'model' } });

      answer.resolve(say('The real answer.'));
      await kit.settle();
      reporter.expectMessage((m) => m.text === 'The real answer.');
    });
  });

  it('ignores a message for a step it isn’t on', async () => {
    const gate = deferred<JsonValue>();
    const readLog = recordingTool('read_log', () => gate.promise);
    const model = scriptedModel([callTool('read_log', {}), say('Done.')]);
    const a = makeAgent(kit, recorded.persistence, model, [readLog.tool]);
    const { ref, reporter } = startRun(kit, a);
    await drive(kit, () => readLog.calls.length === 1);
    const before = await journalOf(recorded.persistence, a);
    const status = await statusOf(kit, ref);

    const result = { ok: true, output: 'stale' } as const;
    // An earlier step's tool result, a later step's, and a call this step didn't make.
    ref.tell({ type: 'toolReturned', step: 0, callId: 'read_log_1', result });
    ref.tell({ type: 'toolReturned', step: 2, callId: 'read_log_1', result });
    ref.tell({ type: 'toolReturned', step: 1, callId: 'read_log_9', result });
    // Model answers while the run waits on tools, for this step and the next.
    ref.tell({ type: 'modelReplied', step: 1, response: say('stale') });
    ref.tell({ type: 'modelReplied', step: 2, response: say('stale') });
    ref.tell({ type: 'modelFailed', step: 2, error: { message: 'stale' } });
    // Failed attempts for targets the run isn't waiting on.
    ref.tell({
      type: 'attemptFailed',
      step: 2,
      target: { kind: 'model' },
      error: { message: 'x' },
    });
    ref.tell({
      type: 'attemptFailed',
      step: 0,
      target: { kind: 'tool', callId: 'read_log_1' },
      error: { message: 'x' },
    });
    await drive(kit);

    expect(await journalOf(recorded.persistence, a)).toEqual(before);
    expect(await statusOf(kit, ref)).toEqual(status);

    gate.resolve('the real result');
    await kit.settle();
    const events = await journalOf(recorded.persistence, a);
    expect(events.find((e) => e.type === 'toolFinished')).toMatchObject({
      result: { ok: true, output: 'the real result' },
    });
    reporter.expectMessage((m) => m.outcome === 'completed');

    // A finished run ignores them too.
    const finished = await journalOf(recorded.persistence, a);
    ref.tell({ type: 'modelReplied', step: 3, response: say('late') });
    ref.tell({ type: 'start' });
    await kit.settle();
    expect(await journalOf(recorded.persistence, a)).toEqual(finished);
  });

  describe('finishes', () => {
    it.each([
      ['maxOutputTokens', { ...say('Cut off'), stop: 'maxOutputTokens' }, 'Cut off'],
      ['refused', { ...say('No.'), stop: 'refusal' }, 'No.'],
      [
        'failed',
        { ...say('Calling a tool'), stop: 'toolUse' },
        'The model stopped to use a tool, but called none.',
      ],
    ] as const)('with %s on that stop reason', async (outcome, response, text) => {
      const a = makeAgent(kit, recorded.persistence, scriptedModel([response]));
      const { reporter } = startRun(kit, a);
      await kit.settle();
      reporter.expectMessage((m) => m.outcome === outcome && m.text === text);
    });

    it('with failed when the model fails in a way retrying won’t fix', async () => {
      // A call past the end of the script throws a ModelError that isn't retryable.
      const a = makeAgent(kit, recorded.persistence, scriptedModel([]));
      const { reporter } = startRun(kit, a);
      await kit.settle();
      reporter.expectMessage({
        type: 'runFinished',
        runId: RUN_ID,
        outcome: 'failed',
        text: 'The model call failed: scriptedModel: call 1, but the script has 0 entries',
        usage: usage(0, 0),
      });
    });
  });

  it('journals each failed model attempt, and carries on when the retry answers', async () => {
    const model = faultyModel(scriptedModel([say('ok')]), { step: 1, fail: [rateLimited()] });
    const a = makeAgent(kit, recorded.persistence, model);
    const { reporter } = startRun(kit, a);
    await kit.advance(PAST_BACKOFF);
    expect((await journalOf(recorded.persistence, a)).map((e) => e.type)).toEqual([
      'runStarted',
      'attemptFailed',
      'modelResponded',
      'runFinished',
    ]);
    reporter.expectMessage((m) => m.outcome === 'completed');
  });

  it('tells the model when it calls a tool that doesn’t exist, naming the ones that do', async () => {
    const model = scriptedModel([callTool('restart_pod', {}), say('I cannot restart it.')]);
    const tools = [recordingTool('read_log').tool, recordingTool('query_metrics').tool];
    const a = makeAgent(kit, recorded.persistence, model, tools);
    startRun(kit, a);
    await kit.settle();
    expect(model.requests[1]?.transcript.at(-1)).toEqual({
      role: 'toolResults',
      results: [
        {
          callId: 'restart_pod_1',
          result: {
            ok: false,
            error: 'There is no tool named "restart_pod". The tools are: read_log, query_metrics.',
          },
        },
      ],
    });
  });

  it('runs a tool whose call id doesn’t fit an actor name', async () => {
    const readLog = recordingTool('read_log');
    const model = scriptedModel([
      callTool('read_log', {}, { id: 'call/with spaces' }),
      say('Done.'),
    ]);
    const a = makeAgent(kit, recorded.persistence, model, [readLog.tool]);
    const { reporter } = startRun(kit, a);
    await kit.settle();
    expect(readLog.calls[0]?.ctx.idempotencyKey).toBe('incident-4211:1:call/with spaces');
    reporter.expectMessage((m) => m.outcome === 'completed');
  });

  it('runs without snapshots when the persistence has no snapshot store', async () => {
    const bare = recordedPersistence(() => kit.scheduler.now(), false);
    const a = makeAgent(kit, bare.persistence, scriptedModel([say('ok')]));
    const { reporter } = startRun(kit, a);
    await kit.settle();
    reporter.expectMessage((m) => m.outcome === 'completed');
  });

  it('runs without a reportTo', async () => {
    const a = makeAgent(kit, recorded.persistence, scriptedModel([say('ok')]));
    kit.system.spawn(a.run(RUN_ID, { input: INPUT }), RUN_ID);
    await kit.settle();
    expect((await journalOf(recorded.persistence, a)).at(-1)).toMatchObject({
      outcome: 'completed',
    });
  });
});
