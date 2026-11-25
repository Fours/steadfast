// T5: failures and retries, row by row of the spec's "Errors and retries". Backoff runs on the
// kit's virtual time, so a test moves time on with `kit.advance` and never sleeps.

import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RetryableToolError,
  tool,
  type JsonValue,
  type Model,
  type ModelError,
  type RunEvent,
  type ToolContext,
  type Turn,
} from '../../src/index.ts';
import {
  badRequest,
  callTool,
  callTools,
  faultyModel,
  rateLimited,
  say,
  scriptedModel,
  type ScriptedModel,
} from '../../src/testkit/index.ts';
import {
  deferred,
  journalOf,
  makeAgent,
  PAST_BACKOFF,
  recordedPersistence,
  recordingTool,
  RUN_ID,
  startRun,
  statusOf,
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

/** Wraps `inner` to record the virtual time of every call, failed ones included. */
function timed(kit: TestKit, inner: Model): Model & { readonly at: number[] } {
  const at: number[] = [];
  return {
    name: inner.name,
    at,
    call(request, options) {
      at.push(kit.scheduler.now());
      return inner.call(request, options);
    },
  };
}

/** A model whose every call fails with `error`. */
function alwaysFailing(error: () => ModelError): Model & { calls: number } {
  const model = {
    name: 'failing',
    calls: 0,
    call(): Promise<never> {
      model.calls += 1;
      return Promise.reject(error());
    },
  };
  return model;
}

/** The tool results the model was sent in its `n`th request, from 1. */
function resultsSent(model: ScriptedModel, n: number) {
  const last: Turn | undefined = model.requests[n - 1]?.transcript.at(-1);
  return last?.role === 'toolResults' ? last.results : undefined;
}

const attemptsOf = (events: readonly RunEvent[]) =>
  events.filter((e) => e.type === 'attemptFailed');

describe('a model call', () => {
  it('that is rate-limited is restarted with backoff on virtual time, and each attempt is journaled', async () => {
    const kit = newKit();
    const { persistence } = recordedPersistence(() => kit.scheduler.now());
    const inner = scriptedModel([say('Found it.')]);
    const model = timed(kit, faultyModel(inner, { step: 1, fail: [rateLimited(), rateLimited()] }));
    const a = makeAgent(kit, persistence, model);
    const { reporter } = startRun(kit, a);

    await kit.settle();
    expect(model.at).toEqual([0]);
    // The first restart waits at least minMs, 1 s, before it calls again.
    await kit.advance(999);
    expect(model.at).toEqual([0]);

    await kit.advance(PAST_BACKOFF);
    expect(model.at).toHaveLength(3);
    const [, second = 0, third = 0] = model.at;
    // 1 s, then 2 s, each with up to 20% jitter.
    expect(second).toBeGreaterThanOrEqual(1_000);
    expect(second).toBeLessThanOrEqual(1_200);
    expect(third - second).toBeGreaterThanOrEqual(2_000);
    expect(third - second).toBeLessThanOrEqual(2_400);

    const events = await journalOf(persistence, a);
    expect(attemptsOf(events)).toEqual([
      {
        type: 'attemptFailed',
        step: 1,
        target: { kind: 'model' },
        error: { message: 'Rate limited (429)' },
      },
      {
        type: 'attemptFailed',
        step: 1,
        target: { kind: 'model' },
        error: { message: 'Rate limited (429)' },
      },
    ]);
    reporter.expectMessage((m) => m.outcome === 'completed' && m.text === 'Found it.');
  });

  it.each([
    ['longer than the backoff', 5_000],
    ['longer than the backoff’s maxMs, uncapped', 90_000],
  ])('waits out a retryAfterMs %s before it tries again', async (_what, retryAfterMs) => {
    const kit = newKit();
    const inner = scriptedModel([say('Found it.')]);
    const model = timed(
      kit,
      faultyModel(inner, { step: 1, fail: [rateLimited({ retryAfterMs })] }),
    );
    const a = makeAgent(kit, inMemoryPersistence(), model);
    const { reporter } = startRun(kit, a);

    // The backoff alone would have called again after 1 to 1.2 s.
    await kit.advance(retryAfterMs - 1);
    expect(model.at).toEqual([0]);
    await kit.advance(retryAfterMs);
    const [, second = 0] = model.at;
    // Jitter goes on top, so it's never sooner than the server said.
    expect(second).toBeGreaterThanOrEqual(retryAfterMs);
    expect(second).toBeLessThanOrEqual(retryAfterMs * 1.2);
    reporter.expectMessage((m) => m.outcome === 'completed');
  });

  it('has its attempts counted from the journal, so a crash between them doesn’t reset the count', async () => {
    const recorded = recordedPersistence(() => 0);
    const { persistence } = recorded;
    const budget = { maxAttemptsPerStep: 3 };

    // The first process fails twice, then dies while it waits to try again.
    const first = newKit();
    const before = alwaysFailing(() => rateLimited());
    startRun(first, makeAgent(first, persistence, before, [], { budget }));
    await first.advance(1_500);
    expect(before.calls).toBe(2);
    await first.shutdown();
    const written = recorded.appends.length;

    // The second has one attempt left, not three.
    const second = newKit();
    const after = alwaysFailing(() => rateLimited());
    const a = makeAgent(second, persistence, after, [], { budget });
    const { reporter } = startRun(second, a);
    await second.advance(PAST_BACKOFF * 10);

    expect(after.calls).toBe(1);
    const events = await journalOf(persistence, a);
    expect(attemptsOf(events)).toHaveLength(3);
    expect(events.at(-1)).toEqual<RunEvent>({
      type: 'runFinished',
      outcome: 'failed',
      text: 'The model call failed 3 times. The last error: Rate limited (429)',
    });
    // Giving up is the same write as the last attempt.
    expect(recorded.appends.slice(written)).toEqual([['attemptFailed', 'runFinished']]);
    reporter.expectMessage((m) => m.outcome === 'failed');
  });

  it('finishes the run with failed when its attempts run out, and is never tried again', async () => {
    const kit = newKit();
    const model = alwaysFailing(() => rateLimited());
    const a = makeAgent(kit, inMemoryPersistence({ clock: () => 0 }), model);
    const { reporter } = startRun(kit, a);
    // Four backoffs at most: 1.2 + 2.4 + 4.8 + 9.6 s.
    await kit.advance(20_000);
    reporter.expectMessage({
      type: 'runFinished',
      runId: RUN_ID,
      outcome: 'failed',
      text: 'The model call failed 5 times. The last error: Rate limited (429)',
      usage: { inputTokens: 0, outputTokens: 0 },
      treeUsage: { inputTokens: 0, outputTokens: 0 },
    });
    // The child was stopped while it waited out its backoff, so nothing calls again.
    await kit.advance(120_000);
    expect(model.calls).toBe(5);
  });

  it('that fails in a way retrying won’t fix finishes the run with failed at once', async () => {
    const kit = newKit();
    const model = alwaysFailing(() => badRequest('Bad request (400): max_tokens is too large'));
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const a = makeAgent(kit, persistence, model);
    const { reporter } = startRun(kit, a);
    await kit.advance(PAST_BACKOFF);
    expect(model.calls).toBe(1);
    expect(attemptsOf(await journalOf(persistence, a))).toEqual([]);
    reporter.expectMessage(
      (m) =>
        m.outcome === 'failed' &&
        m.text === 'The model call failed: Bad request (400): max_tokens is too large',
    );
  });
});

describe('a tool call', () => {
  it('of an idempotent tool becomes an error result the model sees when its attempts run out', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const model = scriptedModel([
      callTools([
        { name: 'read_log', input: { service: 'checkout' }, id: 'toolu_1' },
        { name: 'query_metrics', input: { metric: '5xx' }, id: 'toolu_2' },
      ]),
      say('The logs are unavailable.'),
    ]);
    const failing = recordingTool('read_log', () => Promise.reject(new Error('disk full')));
    // Held open, so the step, and the run, are still going after read_log gives up.
    const metrics = deferred<JsonValue>();
    const slow = recordingTool('query_metrics', () => metrics.promise);
    const a = makeAgent(kit, persistence, model, [failing.tool, slow.tool], {
      budget: { maxAttemptsPerStep: 2 },
    });
    const { ref, reporter } = startRun(kit, a);
    await kit.advance(PAST_BACKOFF);

    const error = 'The tool call failed 2 times. The last error: disk full';
    const events = await journalOf(persistence, a);
    expect(attemptsOf(events)).toHaveLength(2);
    expect(events.at(-1)).toEqual<RunEvent>({
      type: 'toolFinished',
      step: 1,
      callId: 'toolu_1',
      result: { ok: false, error },
    });
    // Stopped while it waited out its backoff, so it never runs again. 30 s is well past its next
    // backoff, and short of query_metrics' 60 s timeout.
    await kit.advance(30_000);
    expect(failing.calls).toHaveLength(2);
    expect((await statusOf(kit, ref)).pending).toEqual({ kind: 'tools', callIds: ['toolu_2'] });

    metrics.resolve({ rate: 0.3 });
    await kit.settle();
    expect(resultsSent(model, 2)).toEqual([
      { callId: 'toolu_1', result: { ok: false, error } },
      { callId: 'toolu_2', result: { ok: true, output: { rate: 0.3 } } },
    ]);
    reporter.expectMessage((m) => m.outcome === 'completed');
  });

  it('of a tool that isn’t idempotent runs once when it throws, and the model sees the error', async () => {
    const kit = newKit();
    const model = scriptedModel([
      callTool('page_oncall', { team: 'payments' }, { id: 'toolu_1' }),
      say('Paging failed.'),
    ]);
    const page = recordingTool('page_oncall', () => Promise.reject(new Error('pager down')), false);
    const a = makeAgent(kit, inMemoryPersistence({ clock: () => 0 }), model, [page.tool]);
    startRun(kit, a);
    await kit.advance(PAST_BACKOFF);
    expect(page.calls).toHaveLength(1);
    expect(resultsSent(model, 2)).toEqual([
      { callId: 'toolu_1', result: { ok: false, error: 'pager down' } },
    ]);
  });

  it('of a tool that isn’t idempotent comes back interrupted when it times out, and isn’t retried', async () => {
    const kit = newKit();
    const model = scriptedModel([
      callTool('page_oncall', { team: 'payments' }, { id: 'toolu_1' }),
      say('Checking whether the page went out.'),
    ]);
    const calls: ToolContext[] = [];
    const page = tool({
      name: 'page_oncall',
      description: 'Pages the on-call engineer.',
      input: { type: 'object' },
      idempotent: false,
      timeoutMs: 5_000,
      run: (_input, ctx) => {
        calls.push(ctx);
        return new Promise<JsonValue>(() => undefined);
      },
    });
    const a = makeAgent(kit, inMemoryPersistence({ clock: () => 0 }), model, [page]);
    startRun(kit, a);
    await kit.advance(5_000 + PAST_BACKOFF);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(resultsSent(model, 2)).toEqual([
      {
        callId: 'toolu_1',
        result: {
          ok: false,
          error:
            'page_oncall timed out after 5000 ms and may or may not have run. Check before trying again.',
          interrupted: true,
        },
      },
    ]);
  });

  it('of a tool that isn’t idempotent is retried when it throws RetryableToolError', async () => {
    const kit = newKit();
    const model = scriptedModel([
      callTool('page_oncall', { team: 'payments' }, { id: 'toolu_1' }),
      say('Paged.'),
    ]);
    let n = 0;
    const page = recordingTool(
      'page_oncall',
      () => {
        n += 1;
        // The pager said no before sending anything, so trying again is safe.
        return n === 1
          ? Promise.reject(new RetryableToolError('pager busy'))
          : Promise.resolve({ paged: true });
      },
      false,
    );
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const a = makeAgent(kit, persistence, model, [page.tool]);
    startRun(kit, a);
    await kit.advance(PAST_BACKOFF);
    expect(page.calls).toHaveLength(2);
    expect(attemptsOf(await journalOf(persistence, a))).toHaveLength(1);
    expect(resultsSent(model, 2)).toEqual([
      { callId: 'toolu_1', result: { ok: true, output: { paged: true } } },
    ]);
  });

  it('whose input fails parse becomes an error result, and the tool never runs', async () => {
    const kit = newKit();
    const model = scriptedModel([
      callTool('read_log', { lines: 'fifty' }, { id: 'toolu_1' }),
      say('I sent a bad input.'),
    ]);
    let ran = false;
    const readLog = tool({
      name: 'read_log',
      description: 'Reads a service log.',
      input: { type: 'object' },
      parse: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: () => ({ issues: [{ message: 'must be a number', path: ['lines'] }] }),
        },
      },
      idempotent: true,
      run: () => {
        ran = true;
        return Promise.resolve(null);
      },
    });
    const a = makeAgent(kit, inMemoryPersistence({ clock: () => 0 }), model, [readLog]);
    startRun(kit, a);
    await kit.advance(PAST_BACKOFF);
    expect(ran).toBe(false);
    expect(resultsSent(model, 2)).toEqual([
      {
        callId: 'toolu_1',
        result: { ok: false, error: 'Invalid input for read_log: lines: must be a number' },
      },
    ]);
  });
});
