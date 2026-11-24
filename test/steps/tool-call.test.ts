import { supervise, type ActorRef, type SystemEvent } from '@kylewillett/troupe';
import type { StandardSchemaV1 } from '@kylewillett/troupe/persistence';
import { createTestKit, type TestKit, type TestProbe } from '@kylewillett/troupe/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RetryableToolError,
  tool,
  type JsonValue,
  type ToolContext,
  type ToolDef,
} from '../../src/index.ts';
import type { ToolCallReport } from '../../src/steps/messages.ts';
import { idempotencyKey, toolCall, type ToolCallMsg } from '../../src/steps/tool-call.ts';

// What the run will spawn its tool calls with (the spec's "Steps as children").
const backoff = supervise.restartWithBackoff({ minMs: 1_000, maxMs: 60_000, randomFactor: 0.2 });
// Past the longest backoff the tests reach: three restarts, at most 1.2 s, 2.4 s and 4.8 s.
const PAST_BACKOFF = 10_000;

type Run = (input: JsonValue, ctx: ToolContext) => Promise<JsonValue>;

/** Every call a test tool gets, so tests can see its input, its context and how often it ran. */
interface Calls {
  readonly inputs: JsonValue[];
  readonly contexts: ToolContext[];
}

let kit: TestKit;

beforeEach(() => {
  kit = createTestKit();
});

afterEach(async () => {
  await kit.shutdown();
});

/** A tool around `run`, recording each call. */
function testTool(run: Run, options: Partial<ToolDef> = {}): { def: ToolDef; calls: Calls } {
  const calls: Calls = { inputs: [], contexts: [] };
  const def: ToolDef = {
    name: 'read_log',
    description: 'Read a log.',
    input: { type: 'object' },
    timeoutMs: 10_000,
    ...options,
    run: (input, ctx) => {
      calls.inputs.push(input);
      calls.contexts.push(ctx);
      return run(input, ctx);
    },
  };
  return { def, calls };
}

/** Spawns the child for call `call_1` of step 3, as the run would, with a probe for its parent. */
function start(
  def: ToolDef,
  input: JsonValue = { service: 'checkout' },
): { parent: TestProbe<ToolCallReport>; ref: ActorRef<ToolCallMsg> } {
  const parent = kit.probe<ToolCallReport>('run');
  const ref = kit.system.spawn(
    toolCall({
      tool: tool(def),
      runId: 'incident-4211',
      step: 3,
      callId: 'call_1',
      input,
      replyTo: parent.ref,
    }),
    'tool-3-call_1',
    { supervision: backoff },
  );
  parent.watch(ref);
  return { parent, ref };
}

/** A run that never settles until its signal is aborted, then rejects with the abort's reason. */
function untilAborted(_input: JsonValue, ctx: ToolContext): Promise<JsonValue> {
  return new Promise((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => {
      reject(ctx.signal.reason as Error);
    });
  });
}

/** A run that fails its first `failures` calls with `error`, then returns `output`. */
function failing(failures: number, error: () => unknown, output: JsonValue = 'ok'): Run {
  let n = 0;
  return () => {
    n += 1;
    // A thrown value is the test's choice of failure, Error or not.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return n <= failures ? Promise.reject(error()) : Promise.resolve(output);
  };
}

// While a tool is still running, `kit.settle` and `kit.advance` wait for it, since a piped promise
// counts as busy, so they can't reach a timeout that would end it. These drive the scheduler
// directly instead, until the tool has settled (the spec's open question 8).
async function runReady(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    kit.scheduler.runReady();
    await Promise.resolve();
  }
}

async function advanceWhileRunning(ms: number): Promise<void> {
  kit.scheduler.advanceTo(kit.scheduler.now() + ms);
  await runReady();
}

function eventsOf<T extends SystemEvent['type']>(type: T): Extract<SystemEvent, { type: T }>[] {
  return kit.events.filter((e): e is Extract<SystemEvent, { type: T }> => e.type === type);
}

describe('the tool-call child', () => {
  it('tells its parent the result, then stops', async () => {
    const { def, calls } = testTool(() => Promise.resolve({ lines: ['502 upstream'] }));
    const { parent, ref } = start(def);
    await kit.settle();
    parent.expectMessage({
      type: 'toolReturned',
      step: 3,
      callId: 'call_1',
      result: { ok: true, output: { lines: ['502 upstream'] } },
    });
    parent.expectNoMessage();
    parent.expectTerminated(ref);
    expect(calls.inputs).toEqual([{ service: 'checkout' }]);
    expect(calls.contexts[0]).toMatchObject({ runId: 'incident-4211', callId: 'call_1' });
  });

  it("turns an output that isn't JSON into an error result, without retrying", async () => {
    const { def } = testTool(() => Promise.resolve({ at: new Date(0) } as unknown as JsonValue), {
      idempotent: true,
    });
    const { parent, ref } = start(def);
    await kit.advance(PAST_BACKOFF);
    parent.expectMessage({
      type: 'toolReturned',
      step: 3,
      callId: 'call_1',
      result: {
        ok: false,
        error: "read_log returned a value that isn't JSON: $.at is not a plain object (Date)",
      },
    });
    parent.expectTerminated(ref);
    expect(eventsOf('restarted')).toEqual([]);
  });

  it('aborts its signal when it is stopped', async () => {
    const { def, calls } = testTool(untilAborted);
    const { parent, ref } = start(def);
    await runReady();
    kit.system.stop(ref);
    await kit.settle();
    expect(calls.contexts[0]?.signal.aborted).toBe(true);
    parent.expectNoMessage();
    parent.expectTerminated(ref);
  });

  describe('timeouts', () => {
    it("abort an idempotent tool's signal and count as a retryable failure", async () => {
      let n = 0;
      const { def, calls } = testTool(
        (input, ctx) => (++n === 1 ? untilAborted(input, ctx) : Promise.resolve('second time')),
        { idempotent: true },
      );
      const { parent, ref } = start(def);
      await advanceWhileRunning(9_999);
      parent.expectNoMessage();
      expect(calls.contexts[0]?.signal.aborted).toBe(false);

      await advanceWhileRunning(1);
      expect(calls.contexts[0]?.signal.reason).toEqual(
        new Error('read_log timed out after 10000 ms'),
      );
      parent.expectMessage({
        type: 'attemptFailed',
        step: 3,
        target: { kind: 'tool', callId: 'call_1' },
        error: { message: 'read_log timed out after 10000 ms' },
      });
      // The timed-out attempt's own rejection arrives late, and isn't reported as the result.
      parent.expectNoMessage();
      expect(eventsOf('failed').map((e) => e.directive)).toEqual(['restart']);

      await kit.advance(PAST_BACKOFF);
      expect(eventsOf('restarted')).toHaveLength(1);
      expect(calls.contexts).toHaveLength(2);
      expect(calls.contexts[1]?.signal.aborted).toBe(true); // Aborted as the child stopped.
      parent.expectMessage((m) => m.type === 'toolReturned' && m.result.ok);
      parent.expectTerminated(ref);
    });

    it('abort a non-idempotent tool and report that it may or may not have run', async () => {
      const { def, calls } = testTool(untilAborted, { name: 'page_oncall', timeoutMs: 5_000 });
      const { parent, ref } = start(def);
      await advanceWhileRunning(5_000);
      expect(calls.contexts[0]?.signal.reason).toEqual(
        new Error('page_oncall timed out after 5000 ms'),
      );
      parent.expectMessage({
        type: 'toolReturned',
        step: 3,
        callId: 'call_1',
        result: {
          ok: false,
          error:
            'page_oncall timed out after 5000 ms and may or may not have run. Check before trying again.',
          interrupted: true,
        },
      });
      parent.expectTerminated(ref);
      await kit.advance(PAST_BACKOFF);
      expect(calls.contexts).toHaveLength(1);
      expect(eventsOf('failed')).toEqual([]);
    });
  });

  describe('parse', () => {
    const service: StandardSchemaV1<unknown, { service: string; lines: number }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          const v = value as { service?: unknown; lines?: unknown };
          if (typeof v.service !== 'string') {
            return {
              issues: [
                { message: 'Expected a string', path: [{ key: 'service' }] },
                { message: 'Bad' },
              ],
            };
          }
          return {
            value: { service: v.service, lines: typeof v.lines === 'number' ? v.lines : 50 },
          };
        },
      },
    };

    it('gives run what the schema returns', async () => {
      const { def, calls } = testTool(() => Promise.resolve('ok'), { parse: service });
      start(def);
      await kit.settle();
      expect(calls.inputs).toEqual([{ service: 'checkout', lines: 50 }]);
    });

    it('turns a failed check into an error result, and the tool never runs', async () => {
      const { def, calls } = testTool(() => Promise.resolve('ok'), {
        parse: service,
        idempotent: true,
      });
      const { parent, ref } = start(def, { service: 42, lines: 'many' });
      await kit.advance(PAST_BACKOFF);
      parent.expectMessage({
        type: 'toolReturned',
        step: 3,
        callId: 'call_1',
        result: { ok: false, error: 'Invalid input for read_log: service: Expected a string; Bad' },
      });
      parent.expectTerminated(ref);
      expect(calls.inputs).toEqual([]);
      expect(eventsOf('restarted')).toEqual([]);
    });

    it('turns a check that throws into an error result, and the tool never runs', async () => {
      const throwing: StandardSchemaV1<unknown, JsonValue> = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: () => Promise.reject(new Error('schema bug')),
        },
      };
      const { def, calls } = testTool(() => Promise.resolve('ok'), { parse: throwing });
      const { parent } = start(def);
      await kit.settle();
      parent.expectMessage(
        (m) =>
          m.type === 'toolReturned' &&
          !m.result.ok &&
          m.result.error === "Couldn't check the input for read_log: schema bug",
      );
      expect(calls.inputs).toEqual([]);
    });
  });

  describe('failures', () => {
    it('of an idempotent tool report attemptFailed and throw, so supervision restarts it', async () => {
      const { def, calls } = testTool(
        failing(1, () => new Error('disk full'), { lines: [] }),
        {
          idempotent: true,
        },
      );
      const { parent, ref } = start(def);
      await kit.settle();
      parent.expectMessage({
        type: 'attemptFailed',
        step: 3,
        target: { kind: 'tool', callId: 'call_1' },
        error: { message: 'disk full' },
      });
      parent.expectNoMessage();
      const [failed] = eventsOf('failed');
      expect(failed).toMatchObject({ path: '/user/tool-3-call_1', directive: 'restart' });
      expect((failed?.error as Error).cause).toBeInstanceOf(Error);

      await kit.advance(PAST_BACKOFF);
      expect(calls.inputs).toHaveLength(2);
      parent.expectMessage({
        type: 'toolReturned',
        step: 3,
        callId: 'call_1',
        result: { ok: true, output: { lines: [] } },
      });
      parent.expectTerminated(ref);
    });

    it("of a tool that isn't idempotent are reported without throwing, and it runs once", async () => {
      const { def, calls } = testTool(
        failing(1, () => new Error('pager service is down')),
        {
          name: 'page_oncall',
        },
      );
      const { parent, ref } = start(def);
      await kit.advance(PAST_BACKOFF);
      parent.expectMessage({
        type: 'toolReturned',
        step: 3,
        callId: 'call_1',
        result: { ok: false, error: 'pager service is down' },
      });
      parent.expectTerminated(ref);
      expect(calls.inputs).toHaveLength(1);
      expect(eventsOf('failed')).toEqual([]);
    });

    it("report a thrown value that isn't an Error by its text", async () => {
      const { def } = testTool(failing(1, () => 'nope'));
      const { parent } = start(def);
      await kit.settle();
      parent.expectMessage(
        (m) => m.type === 'toolReturned' && !m.result.ok && m.result.error === 'nope',
      );
    });

    it("throw RetryableToolError, and a tool that isn't idempotent is retried", async () => {
      const { def, calls } = testTool(
        failing(1, () => new RetryableToolError('Refused before sending')),
        { name: 'page_oncall' },
      );
      const { parent, ref } = start(def);
      await kit.settle();
      parent.expectMessage({
        type: 'attemptFailed',
        step: 3,
        target: { kind: 'tool', callId: 'call_1' },
        error: { message: 'Refused before sending' },
      });
      await kit.advance(PAST_BACKOFF);
      expect(calls.inputs).toHaveLength(2);
      parent.expectMessage((m) => m.type === 'toolReturned' && m.result.ok);
      parent.expectTerminated(ref);
    });
  });

  it('gives the same idempotency key, and a fresh signal, on every attempt', async () => {
    const { def, calls } = testTool(
      failing(2, () => new Error('flaky')),
      { idempotent: true },
    );
    start(def);
    await kit.advance(PAST_BACKOFF);
    expect(eventsOf('restarted')).toHaveLength(2);
    expect(calls.contexts.map((c) => c.idempotencyKey)).toEqual([
      'incident-4211:3:call_1',
      'incident-4211:3:call_1',
      'incident-4211:3:call_1',
    ]);
    expect(new Set(calls.contexts.map((c) => c.signal)).size).toBe(3);
  });

  it('makes the key from the run, the step and the call, and nothing else', () => {
    expect(idempotencyKey('incident-4211', 3, 'toolu_01A')).toBe('incident-4211:3:toolu_01A');
    expect(idempotencyKey('incident-4211', 4, 'toolu_01A')).not.toBe(
      idempotencyKey('incident-4211', 3, 'toolu_01A'),
    );
  });
});
