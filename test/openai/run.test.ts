// Milestone 1's T3 run tests that involve the model, on openaiModel over a fake client. The run
// and its assertions are the same as in test/run/run.test.ts: only the model differs, so what the
// journal holds and what each request sends are the Responses API's shapes.
import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue, RunEvent } from '../../src/index.ts';
import { openaiModel } from '../../src/openai/index.ts';
import {
  deferred,
  drive,
  INPUT,
  journalOf,
  makeAgent,
  recordedPersistence,
  recordingTool,
  RUN_ID,
  startRun,
  statusOf,
  SYSTEM,
  type Recorded,
} from '../run/helpers.ts';
import {
  callItem,
  fakeClient,
  reasoningItem,
  response,
  textItem,
  type Answer,
} from './fake-client.ts';

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
const tokens = (input_tokens: number, output_tokens: number) => ({ input_tokens, output_tokens });

function openai(...answers: Answer[]) {
  const client = fakeClient(...answers);
  return { client, model: openaiModel({ client, model: 'gpt-5.6' }) };
}

/** The input items of each request the client got. */
function inputs(client: ReturnType<typeof fakeClient>): unknown[][] {
  return client.calls.map((c) => c.params.input as unknown[]);
}

describe('a run on openaiModel', () => {
  it('with no tool calls persists runStarted, modelResponded and runFinished, and reports', async () => {
    kit.scheduler.advanceTo(1_700);
    const output = [reasoningItem('rs_1'), textItem('The cause is a bad deploy.')];
    const { client, model } = openai(response(output, { usage: tokens(120, 30) }));
    const a = makeAgent(kit, recorded.persistence, model);
    const { reporter } = startRun(kit, a);
    await kit.settle();

    expect(await journalOf(recorded.persistence, a)).toEqual<RunEvent[]>([
      {
        type: 'runStarted',
        agent: 'triage',
        model: 'openai:gpt-5.6',
        input: INPUT,
        startedAt: 1_700,
      },
      {
        type: 'modelResponded',
        step: 1,
        response: {
          stop: 'endTurn',
          text: 'The cause is a bad deploy.',
          toolCalls: [],
          usage: usage(120, 30),
          model: 'gpt-5.6',
          raw: output,
        },
      },
      { type: 'runFinished', outcome: 'completed', text: 'The cause is a bad deploy.' },
    ]);
    expect(recorded.appends).toEqual([['runStarted'], ['modelResponded', 'runFinished']]);
    reporter.expectMessage({
      type: 'runFinished',
      runId: RUN_ID,
      outcome: 'completed',
      text: 'The cause is a bad deploy.',
      usage: usage(120, 30),
      treeUsage: usage(120, 30),
    });
    reporter.expectNoMessage();
    expect(inputs(client)).toEqual([[{ role: 'user', content: INPUT }]]);
    expect(client.calls[0]?.params.instructions).toBe(SYSTEM);
  });

  it('runs a step’s tool calls at the same time, and sends their results as one turn in call order', async () => {
    const names = ['read_log', 'query_metrics', 'page_oncall'] as const;
    const started: string[] = [];
    const gates = new Map(names.map((n) => [n, deferred<JsonValue>()]));
    const tools = names.map((n) =>
      recordingTool(n, () => {
        started.push(n);
        // Each one is held until the test lets it go, so they can only all start if they run at
        // the same time.
        return gates.get(n)?.promise ?? Promise.reject(new Error('no gate'));
      }),
    );
    const first = names.map((n) => callItem(`call_${n}`, n, '{"service":"checkout"}'));
    const { client, model } = openai(response(first), response([textItem('Paged the on-call.')]));
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
      callIds: names.map((n) => `call_${n}`),
    });

    // They finish in the reverse order.
    for (const n of [...names].reverse()) {
      gates.get(n)?.resolve({ from: n });
      await drive(kit);
    }
    await kit.settle();

    const events = await journalOf(recorded.persistence, a);
    expect(events.flatMap((e) => (e.type === 'toolFinished' ? [e.callId] : []))).toEqual([
      'call_page_oncall',
      'call_query_metrics',
      'call_read_log',
    ]);
    expect(tools.map((t) => t.calls[0]?.input)).toEqual(names.map(() => ({ service: 'checkout' })));
    expect(client.calls).toHaveLength(2);
    expect(inputs(client)[1]).toEqual([
      { role: 'user', content: INPUT },
      ...first,
      ...names.map((n) => ({
        type: 'function_call_output',
        call_id: `call_${n}`,
        output: JSON.stringify({ from: n }),
      })),
    ]);
    expect(events.at(-1)).toEqual({
      type: 'runFinished',
      outcome: 'completed',
      text: 'Paged the on-call.',
    });
  });

  describe('over five steps', () => {
    const outputs = [
      [reasoningItem('rs_1'), textItem('Reading the log.'), callItem('c1', 'read_log', '{}')],
      [callItem('c2', 'query_metrics', '{"metric":"errors"}')],
      [
        reasoningItem('rs_3'),
        callItem('c3', 'read_log', '{"service":"payments"}'),
        callItem('c4', 'query_metrics', '{"metric":"latency"}'),
      ],
      [callItem('c5', 'read_log', '{"service":"gateway"}')],
      [textItem('A bad deploy of the gateway.')],
    ];

    async function runFive() {
      const { client, model } = openai(
        ...outputs.map((o, i) => response(o, { usage: tokens(10 * (i + 1), i + 2) })),
      );
      const tools = [recordingTool('read_log').tool, recordingTool('query_metrics').tool];
      const a = makeAgent(kit, recorded.persistence, model, tools);
      const { reporter } = startRun(kit, a);
      await kit.settle();
      return { client, a, reporter };
    }

    it('only grows the transcript: every request starts with the one before', async () => {
      const { client } = await runFive();
      const all = inputs(client);
      expect(all).toHaveLength(5);
      for (let i = 1; i < all.length; i++) {
        const before = all[i - 1] ?? [];
        const after = all[i] ?? [];
        expect(after.length).toBeGreaterThan(before.length);
        expect(after.slice(0, before.length)).toEqual(before);
      }
    });

    it("passes each response's output items to the next request unchanged", async () => {
      const { client, a } = await runFive();
      const last = inputs(client).at(-1) ?? [];
      const items: unknown[] = outputs.slice(0, -1).flat();
      // Every item the model sent, the very objects, in order among the user turn and the results.
      expect(last.filter((item) => items.includes(item))).toEqual(items);
      // And the journal holds the same items, so a recovered run sends the same bytes.
      const raws = (await journalOf(recorded.persistence, a)).flatMap((e) =>
        e.type === 'modelResponded' ? [e.response.raw] : [],
      );
      expect(raws).toEqual(outputs);
    });

    it('sums usage and reports it', async () => {
      const { reporter } = await runFive();
      reporter.expectMessage({
        type: 'runFinished',
        runId: RUN_ID,
        outcome: 'completed',
        text: 'A bad deploy of the gateway.',
        usage: usage(150, 20),
        treeUsage: usage(150, 20),
      });
    });

    it('sends the agent’s system prompt and tool specs with every request', async () => {
      const { client, a } = await runFive();
      const tools = a.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.input,
        strict: false,
      }));
      for (const call of client.calls) {
        expect(call.params.instructions).toBe(SYSTEM);
        expect(call.params.tools).toEqual(tools);
      }
    });
  });

  it('replies to status with the phase, step, usage and what the run is waiting on', async () => {
    const gate = deferred<JsonValue>();
    const readLog = recordingTool('read_log', () => gate.promise);
    const { model } = openai(
      response([callItem('call_1', 'read_log', '{"service":"checkout"}')], {
        usage: tokens(100, 10),
      }),
      response([textItem('Done.')], { usage: tokens(200, 20) }),
    );
    const a = makeAgent(kit, recorded.persistence, model, [readLog.tool]);
    const { ref } = startRun(kit, a);

    await drive(kit, () => readLog.calls.length === 1);
    expect(await statusOf(kit, ref)).toEqual({
      phase: 'running',
      step: 1,
      usage: usage(100, 10),
      treeUsage: usage(100, 10),
      pending: { kind: 'tools', callIds: ['call_1'] },
      approvals: [],
      subRuns: [],
    });

    gate.resolve('502s since 14:02');
    await kit.settle();
    expect(await statusOf(kit, ref)).toEqual({
      phase: 'finished',
      step: 2,
      usage: usage(300, 30),
      treeUsage: usage(300, 30),
      pending: { kind: 'none' },
      approvals: [],
      subRuns: [],
      outcome: 'completed',
    });
  });

  it("tells the model when a call's arguments aren't JSON, without running the tool", async () => {
    const readLog = recordingTool('read_log');
    const { client, model } = openai(
      response([callItem('call_1', 'read_log', '{"service":')]),
      response([textItem('Sorry.')]),
    );
    const a = makeAgent(kit, recorded.persistence, model, [readLog.tool]);
    startRun(kit, a);
    await kit.settle();

    expect(readLog.calls).toEqual([]);
    const output = (inputs(client)[1]?.at(-1) ?? {}) as { output?: string };
    expect(output).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    expect(JSON.parse(output.output ?? '')).toEqual({
      error: expect.stringContaining("aren't valid JSON") as unknown,
    });
  });
});
