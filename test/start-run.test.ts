// Milestone 2's T8: startRun, an awaitable handle on a run for code outside an actor. Its `done`
// settles with the report, `cancel` cancels, `decide` replies, and progress reaches `onProgress`.

import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  delegate,
  startRun,
  tool,
  type DecideReply,
  type Decision,
  type JsonValue,
  type RunHandle,
  type RunProgress,
  type RunReport,
  type StartRunOptions,
} from '../src/index.ts';
import { callTool, say, scriptedModel } from '../src/testkit/index.ts';
import { deferred, drive, journalOf, makeAgent, recordingTool, RUN_ID } from './run/helpers.ts';

const kits: TestKit[] = [];

function newKit(): TestKit {
  const kit = createTestKit();
  kits.push(kit);
  return kit;
}

afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.shutdown();
});

const INPUT = 'Checkout is returning 502s.';

/** Whether `promise` has settled, without waiting for it. */
function settledYet(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return () => settled;
}

function pageTool() {
  const calls: JsonValue[] = [];
  const t = tool({
    name: 'page_oncall',
    description: 'Page a team.',
    input: { type: 'object' },
    needsApproval: true,
    run: (input) => {
      calls.push(input);
      return Promise.resolve({ paged: true });
    },
  });
  return { tool: t, calls };
}

describe('startRun', () => {
  it('settles done with the report, and passes the whole tree’s progress to onProgress', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const analyst = makeAgent(kit, persistence, scriptedModel([say('Payments times out.')]), [], {
      name: 'log-analyst',
    });
    const triage = makeAgent(
      kit,
      persistence,
      scriptedModel([callTool('log_analyst', { task: 'Read the logs.' }), say('A bad deploy.')]),
      [delegate(analyst, { description: 'Reads logs.' })],
    );
    const progress: RunProgress[] = [];
    const run = startRun(kit.system, triage, RUN_ID, {
      input: INPUT,
      onProgress: (p) => progress.push(p),
    });
    expect(run.runId).toBe(RUN_ID);
    await kit.settle();

    const report = await run.done;
    expect(report).toMatchObject<Partial<RunReport>>({
      runId: RUN_ID,
      outcome: 'completed',
      text: 'A bad deploy.',
    });
    // Every event of both journals, each with its run, after each run's `resumed`.
    const sub = `${RUN_ID}/1.0`;
    const journaled = (runId: string) =>
      progress.filter((p) => p.type === 'journaled' && p.runId === runId).map((p) => p.type);
    expect(progress[0]).toEqual({ type: 'resumed', runId: RUN_ID, seq: 0 });
    expect(progress).toContainEqual({ type: 'resumed', runId: sub, seq: 0 });
    expect(journaled(RUN_ID)).toHaveLength((await journalOf(persistence, triage)).length);
    expect(journaled(sub)).toHaveLength((await journalOf(persistence, analyst, sub)).length);
    expect(progress.some((p) => p.type === 'text' && p.runId === sub)).toBe(true);
    // The host has stopped the run, and itself, so the run can be hosted again.
    expect(() => startRun(kit.system, triage, RUN_ID, { input: INPUT })).not.toThrow();
  });

  it('cancels the run and everything under it', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const held = deferred<JsonValue>();
    const slow = recordingTool('read_log', () => held.promise);
    const analyst = makeAgent(
      kit,
      persistence,
      scriptedModel([callTool('read_log', {}), say('unreachable')]),
      [slow.tool],
      { name: 'log-analyst' },
    );
    const triage = makeAgent(
      kit,
      persistence,
      scriptedModel([callTool('log_analyst', { task: 'Read the logs.' })]),
      [delegate(analyst, { description: 'Reads logs.' })],
    );
    const run = startRun(kit.system, triage, RUN_ID, { input: INPUT });
    await drive(kit, () => slow.calls.length === 1);
    expect(slow.calls).toHaveLength(1);

    run.cancel('Superseded by incident-4212');
    const done = settledYet(run.done);
    await drive(kit, done);
    expect((await run.done).outcome).toBe('cancelled');
    expect(slow.calls[0]?.ctx.signal.aborted).toBe(true);
    expect((await journalOf(persistence, triage)).at(-1)).toMatchObject({
      type: 'runFinished',
      outcome: 'cancelled',
      text: 'Cancelled: Superseded by incident-4212',
    });
    expect((await journalOf(persistence, analyst, `${RUN_ID}/1.0`)).at(-1)).toMatchObject({
      type: 'runFinished',
      outcome: 'cancelled',
    });
    // Once done has settled, cancelling does nothing.
    expect(() => {
      run.cancel('again');
    }).not.toThrow();
  });

  it('cancels only the sub-run a runId names, and the root carries on', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const held = deferred<JsonValue>();
    const slow = recordingTool('read_log', () => held.promise);
    const analyst = makeAgent(kit, persistence, scriptedModel([callTool('read_log', {})]), [
      slow.tool,
    ]);
    const named = makeAgent(kit, persistence, analyst.model, analyst.tools, {
      name: 'log-analyst',
    });
    const triage = makeAgent(
      kit,
      persistence,
      scriptedModel([callTool('log_analyst', { task: 'Read the logs.' }), say('Gave up on logs.')]),
      [delegate(named, { description: 'Reads logs.' })],
    );
    const run = startRun(kit.system, triage, RUN_ID, { input: INPUT });
    await drive(kit, () => slow.calls.length === 1);

    run.cancel('Taking too long', `${RUN_ID}/1.0`);
    await drive(kit, settledYet(run.done));
    expect(await run.done).toMatchObject({ outcome: 'completed', text: 'Gave up on logs.' });
    expect((await journalOf(persistence, named, `${RUN_ID}/1.0`)).at(-1)).toMatchObject({
      type: 'runFinished',
      outcome: 'cancelled',
    });
  });

  it('sends decisions and resolves with the reply, and notWaiting once the run is done', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const page = pageTool();
    const triage = makeAgent(
      kit,
      persistence,
      scriptedModel([
        callTool('page_oncall', { team: 'payments' }, { id: 'toolu_p' }),
        say('Paged.'),
      ]),
      [page.tool],
    );
    const requests: RunProgress[] = [];
    const run = startRun(kit.system, triage, RUN_ID, {
      input: INPUT,
      onProgress: (p) => {
        if (p.type === 'journaled' && p.event.type === 'approvalRequested') requests.push(p);
      },
    });
    await kit.settle();
    expect(requests).toHaveLength(1);
    expect(page.calls).toEqual([]);

    const decision: Decision = { runId: RUN_ID, callId: 'toolu_p', approved: true, by: 'kyle' };
    const unknown = run.decide({ ...decision, callId: 'toolu_nope' });
    const elsewhere = run.decide({ ...decision, runId: `${RUN_ID}/9.9` });
    const reply = run.decide(decision);
    await kit.settle();
    expect(await unknown).toEqual<DecideReply>({ ok: false, reason: 'notWaiting' });
    expect(await elsewhere).toEqual<DecideReply>({ ok: false, reason: 'unknownRun' });
    expect(await reply).toEqual<DecideReply>({ ok: true });

    expect((await run.done).outcome).toBe('completed');
    expect(page.calls).toEqual([{ team: 'payments' }]);
    expect(await run.decide(decision)).toEqual<DecideReply>({ ok: false, reason: 'notWaiting' });
  });

  it('refuses to host a run twice in one system, and hosts it again once it is done', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const model = scriptedModel([say('Done.'), say('Done.')]);
    const triage = makeAgent(kit, persistence, model);
    const first = startRun(kit.system, triage, RUN_ID, { input: INPUT });
    expect(() => startRun(kit.system, triage, RUN_ID, { input: INPUT })).toThrow(
      `startRun: run-triage-${RUN_ID} is already running in system "${kit.system.name}"`,
    );
    // Another run of the same agent, and the same run in another system, are separate.
    const other = startRun(kit.system, triage, 'incident-4212', { input: INPUT });
    const elsewhere = newKit();
    expect(() => startRun(elsewhere.system, triage, RUN_ID, { input: INPUT })).not.toThrow();
    await elsewhere.shutdown();

    await kit.settle();
    expect((await first.done).outcome).toBe('completed');
    expect((await other.done).outcome).toBe('completed');
    await kit.settle();
    // A finished run reports again at once, with no model call.
    const calls = model.requests.length;
    const again = startRun(kit.system, triage, RUN_ID, { input: INPUT });
    await kit.settle();
    expect(await again.done).toMatchObject({ outcome: 'completed', text: 'Done.' });
    expect(model.requests).toHaveLength(calls);
  });

  it('rejects done when the run stops before it finishes, and frees the run', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const held = deferred<JsonValue>();
    const slow = recordingTool('read_log', () => held.promise);
    const triage = makeAgent(kit, persistence, scriptedModel([callTool('read_log', {})]), [
      slow.tool,
    ]);
    const run = startRun(kit.system, triage, RUN_ID, { input: INPUT });
    await drive(kit, () => slow.calls.length === 1);
    await kit.shutdown();
    await expect(run.done).rejects.toThrow(
      `startRun: run-triage-${RUN_ID} stopped before it finished`,
    );
    expect(await run.decide({ runId: RUN_ID, callId: 'x', approved: true, by: 'kyle' })).toEqual({
      ok: false,
      reason: 'notWaiting',
    });
  });

  it('logs a listener that throws, and the run carries on', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
    const triage = makeAgent(kit, persistence, scriptedModel([say('Done.')]));
    const run = startRun(kit.system, triage, RUN_ID, {
      input: INPUT,
      onProgress: () => {
        throw new Error('listener bug');
      },
    });
    await kit.settle();
    expect((await run.done).outcome).toBe('completed');
    expect(kit.logs.filter((l) => l.level === 'error').map((l) => l.msg)).toContain(
      `startRun: onProgress threw for run-triage-${RUN_ID}`,
    );
  });

  it('throws at once for bad arguments', () => {
    const kit = newKit();
    const persistence = inMemoryPersistence();
    const triage = makeAgent(kit, persistence, scriptedModel([]));
    const start = (options: unknown, runId = RUN_ID) =>
      startRun(kit.system, triage, runId, options as StartRunOptions);
    expect(() => start(null)).toThrow('startRun: give an options object');
    expect(() => start({ input: INPUT, reportTo: null })).toThrow(
      'startRun: unknown option "reportTo"',
    );
    expect(() => start({ input: INPUT, onProgress: 1 })).toThrow(
      'startRun: onProgress must be a function',
    );
    expect(() => start({ input: 1 })).toThrow('input must be a string');
    expect(() => start({ input: INPUT, limits: { maxTokens: 0 } })).toThrow(RangeError);
    expect(() => start({ input: INPUT }, '')).toThrow('runId must be a non-empty string');
    // Nothing was spawned by the failures, so the run can still start.
    const run = start({ input: INPUT });

    const decide = (d: unknown) => () => run.decide(d as Decision);
    const ok = { runId: RUN_ID, callId: 'c', approved: true, by: 'kyle' };
    expect(decide(null)).toThrow('decide: give a decision object');
    expect(decide({ ...ok, replyTo: null })).toThrow('decide: unknown field "replyTo"');
    expect(decide({ ...ok, callId: 1 })).toThrow('decide: callId must be a string');
    expect(decide({ ...ok, approved: 'yes' })).toThrow('decide: approved must be a boolean');
    expect(decide({ ...ok, note: 1 })).toThrow('decide: note must be a string');
    expect(() => {
      run.cancel(1 as unknown as string);
    }).toThrow('cancel: reason must be a string');
    expect(() => {
      run.cancel('x', 1 as unknown as string);
    }).toThrow('cancel: runId must be a string');
  });

  it('is typed', () => {
    expectTypeOf(startRun).returns.toEqualTypeOf<RunHandle>();
    expectTypeOf<RunHandle['done']>().toEqualTypeOf<Promise<RunReport>>();
    expectTypeOf<RunHandle['decide']>().returns.toEqualTypeOf<Promise<DecideReply>>();
    expectTypeOf<StartRunOptions['onProgress']>().toEqualTypeOf<
      ((progress: RunProgress) => void) | undefined
    >();
    // @ts-expect-error: a decision needs who made it.
    const missing: Decision = { runId: RUN_ID, callId: 'c', approved: true };
    expect(missing).toBeDefined();
  });
});
