// T5: budgets. Each one finishes the run with its own outcome, and the deadline holds across a
// restart because it's measured from the journaled start on the agent's clock.

import { inMemoryPersistence, type Persistence } from '@kylewillett/troupe/persistence';
import { createTestKit, type TestKit } from '@kylewillett/troupe/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { tool, type RunEvent, type ToolContext } from '../../src/index.ts';
import { callTool, say, scriptedModel } from '../../src/testkit/index.ts';
import {
  journalOf,
  makeAgent,
  recordedPersistence,
  recordingTool,
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

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

describe('maxSteps', () => {
  it('finishes with stepsExceeded instead of running the tools the last allowed response asks for', async () => {
    const kit = newKit();
    const recorded = recordedPersistence(() => 0);
    const model = scriptedModel([
      callTool('read_log', { service: 'checkout' }, { id: 'toolu_1' }),
      callTool('read_log', { service: 'payments' }, { id: 'toolu_2' }),
      say('Never reached.'),
    ]);
    const readLog = recordingTool('read_log');
    const a = makeAgent(kit, recorded.persistence, model, [readLog.tool], {
      budget: { maxSteps: 2 },
    });
    const { reporter } = startRun(kit, a);
    await kit.settle();

    expect(model.requests).toHaveLength(2);
    expect(readLog.calls).toHaveLength(1);
    expect((await journalOf(recorded.persistence, a)).at(-1)).toEqual<RunEvent>({
      type: 'runFinished',
      outcome: 'stepsExceeded',
      text: 'The run reached its budget of 2 model calls.',
    });
    expect(recorded.appends.at(-1)).toEqual(['modelResponded', 'runFinished']);
    reporter.expectMessage((m) => m.outcome === 'stepsExceeded');
  });

  it('lets the last allowed response finish the run on its own terms', async () => {
    const kit = newKit();
    const model = scriptedModel([callTool('read_log', {}), say('Done in two.')]);
    const a = makeAgent(kit, inMemoryPersistence(), model, [recordingTool('read_log').tool], {
      budget: { maxSteps: 2 },
    });
    const { reporter } = startRun(kit, a);
    await kit.settle();
    reporter.expectMessage((m) => m.outcome === 'completed' && m.text === 'Done in two.');
  });
});

describe('maxTokens', () => {
  it('finishes with tokensExceeded once usage reaches it, counting input and output', async () => {
    const kit = newKit();
    const recorded = recordedPersistence(() => 0);
    const model = scriptedModel([
      callTool('read_log', {}, { usage: usage(400, 200) }),
      callTool('read_log', {}, { usage: usage(300, 100) }),
      say('Never reached.'),
    ]);
    const readLog = recordingTool('read_log');
    const a = makeAgent(kit, recorded.persistence, model, [readLog.tool], {
      budget: { maxTokens: 1_000 },
    });
    const { reporter } = startRun(kit, a);
    await kit.settle();

    // 600 after the first response, 1,000 after the second: exactly the budget.
    expect(readLog.calls).toHaveLength(1);
    expect((await journalOf(recorded.persistence, a)).at(-1)).toEqual<RunEvent>({
      type: 'runFinished',
      outcome: 'tokensExceeded',
      text: 'The run used 1000 tokens, reaching its budget of 1000.',
    });
    expect(recorded.appends.at(-1)).toEqual(['modelResponded', 'runFinished']);
    reporter.expectMessage((m) => m.outcome === 'tokensExceeded' && m.usage.inputTokens === 700);
  });

  it('lets a final answer that crosses it finish the run on its own terms', async () => {
    const kit = newKit();
    const model = scriptedModel([say('A long answer.', { usage: usage(900, 900) })]);
    const a = makeAgent(kit, inMemoryPersistence(), model, [], { budget: { maxTokens: 1_000 } });
    const { reporter } = startRun(kit, a);
    await kit.settle();
    reporter.expectMessage((m) => m.outcome === 'completed');
  });
});

/** A tool that never finishes on its own, and records the context of each call. */
function heldTool(): { tool: ReturnType<typeof tool>; calls: ToolContext[] } {
  const calls: ToolContext[] = [];
  return {
    calls,
    tool: tool({
      name: 'read_log',
      description: 'Reads a log, slowly.',
      input: { type: 'object' },
      idempotent: true,
      timeoutMs: 600_000,
      run: (_input, ctx) => {
        calls.push(ctx);
        return new Promise(() => undefined);
      },
    }),
  };
}

const DEADLINE = 10_000;
const DEADLINE_TEXT = 'The run passed its deadline of 10000 ms.';

describe('deadlineMs', () => {
  it('finishes with deadlineExceeded when it passes, and stops the children', async () => {
    const kit = newKit();
    const persistence = inMemoryPersistence();
    const held = heldTool();
    const model = scriptedModel([callTool('read_log', {})]);
    const a = makeAgent(kit, persistence, model, [held.tool], {
      budget: { deadlineMs: DEADLINE },
    });
    const { ref, reporter } = startRun(kit, a);

    await kit.advance(DEADLINE - 1);
    expect((await statusOf(kit, ref)).phase).toBe('running');
    expect(held.calls[0]?.signal.aborted).toBe(false);

    await kit.advance(1);
    reporter.expectMessage((m) => m.outcome === 'deadlineExceeded' && m.text === DEADLINE_TEXT);
    expect(held.calls[0]?.signal.aborted).toBe(true);
    expect((await journalOf(persistence, a)).at(-1)).toEqual<RunEvent>({
      type: 'runFinished',
      outcome: 'deadlineExceeded',
      text: DEADLINE_TEXT,
    });
  });

  /**
   * Runs for 6 s on a first process, which then dies. The second process's agent clock starts
   * `downMs` after the first one stopped, as a wall clock would.
   */
  async function restartedAfter(persistence: Persistence, downMs: number) {
    const first = newKit();
    const script = [callTool('read_log', {})];
    const a1 = makeAgent(first, persistence, scriptedModel(script), [heldTool().tool], {
      budget: { deadlineMs: DEADLINE },
      clock: () => first.scheduler.now(),
    });
    startRun(first, a1);
    await first.advance(6_000);
    await first.shutdown();

    const second = newKit();
    const offset = 6_000 + downMs;
    const held = heldTool();
    const a2 = makeAgent(second, persistence, scriptedModel([]), [held.tool], {
      budget: { deadlineMs: DEADLINE },
      clock: () => offset + second.scheduler.now(),
    });
    const { ref, reporter } = startRun(second, a2);
    return { kit: second, ref, reporter, held, agent: a2 };
  }

  it('holds across a restart, measured from the run’s start on the agent’s clock', async () => {
    const persistence = inMemoryPersistence();
    // Down for 1 s, so 3 s are left of the 10.
    const { kit, ref, reporter, held } = await restartedAfter(persistence, 1_000);
    await kit.advance(2_999);
    expect((await statusOf(kit, ref)).phase).toBe('running');
    expect(held.calls).toHaveLength(1);

    await kit.advance(1);
    reporter.expectMessage((m) => m.outcome === 'deadlineExceeded');
    expect(held.calls[0]?.signal.aborted).toBe(true);
  });

  it('finishes a run at once when it passed while the run was down, and starts nothing', async () => {
    const persistence = inMemoryPersistence();
    const { kit, reporter, held, agent } = await restartedAfter(persistence, 5_000);
    await kit.settle();
    reporter.expectMessage((m) => m.outcome === 'deadlineExceeded' && m.text === DEADLINE_TEXT);
    expect(held.calls).toHaveLength(0);
    const events = await journalOf(persistence, agent);
    expect(events.filter((e) => e.type === 'runFinished')).toHaveLength(1);
  });

  it('isn’t timed when the budget has none', async () => {
    const kit = newKit();
    const held = heldTool();
    const model = scriptedModel([callTool('read_log', {})]);
    const a = makeAgent(kit, inMemoryPersistence(), model, [held.tool]);
    const { ref } = startRun(kit, a);
    await kit.advance(500_000);
    expect((await statusOf(kit, ref)).phase).toBe('running');
  });
});
