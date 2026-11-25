// delegate(): a tool made from an agent, checked when it's made. And agent()'s refusal of an agent
// that delegates to itself.

import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { describe, expect, it } from 'vitest';
import { agent, delegate, type Agent, type DelegateOptions } from '../src/index.ts';
import { scriptedModel } from '../src/testkit/index.ts';

function analyst(name = 'log-analyst'): Agent {
  return agent({
    name,
    model: scriptedModel([]),
    system: 'You read logs.',
    persistence: inMemoryPersistence({ clock: () => 0 }),
    clock: () => 0,
  });
}

describe('delegate()', () => {
  it('makes a tool that takes a task and names its agent', async () => {
    const a = analyst();
    const t = delegate(a, { description: 'Give the log analyst a task.' });
    expect(t.name).toBe('log_analyst');
    expect(t.description).toBe('Give the log analyst a task.');
    expect(t.delegatesTo).toBe(a);
    expect(t.input).toMatchObject({
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    });
    expect(Object.isFrozen(t)).toBe(true);
    expect(delegate(a, { name: 'ask_log_analyst', description: 'x' }).name).toBe('ask_log_analyst');
    expect(t.needsApproval).toBe(false);
    const asked = delegate(a, { description: 'x', needsApproval: true, approvalTimeoutMs: 5_000 });
    expect(asked).toMatchObject({ needsApproval: true, approvalTimeoutMs: 5_000 });
    // A run starts a sub-run instead. Called directly, it says so.
    await expect(
      t.run(
        { task: 'x' },
        {
          runId: 'r',
          callId: 'c',
          idempotencyKey: 'k',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('log_analyst delegates to "log-analyst": a run starts it as a sub-run');
  });

  it.each([
    [
      'an agent not made by agent()',
      { ...analyst() },
      { description: 'x' },
      'agent must be made by agent()',
    ],
    ['no options', analyst(), null, 'give an options object'],
    [
      'an unknown option',
      analyst(),
      { description: 'x', idempotent: true },
      'unknown option "idempotent"',
    ],
    ['a bad name', analyst(), { name: 'ask analyst', description: 'x' }, 'name must match'],
    ['a name that isn’t a string', analyst(), { name: 5, description: 'x' }, 'got number'],
    ['no description', analyst(), {}, 'description must be a non-empty string'],
    [
      'a blank description',
      analyst(),
      { description: '  ' },
      'description must be a non-empty string',
    ],
    [
      'a needsApproval that is neither a boolean nor a function',
      analyst(),
      { description: 'x', needsApproval: 1 },
      'needsApproval must be a boolean or a function, got 1',
    ],
    [
      'an approvalTimeoutMs on a delegation that never needs approval',
      analyst(),
      { description: 'x', approvalTimeoutMs: 1_000 },
      'delegate "log-analyst": approvalTimeoutMs is only for a tool that needs approval',
    ],
  ])('throws on %s', (_name, a, options, message) => {
    const call = () => delegate(a, options as DelegateOptions);
    expect(call).toThrow(TypeError);
    expect(call).toThrow(message);
  });

  it('throws a RangeError on an approvalTimeoutMs that isn’t a positive integer', () => {
    expect(() =>
      delegate(analyst(), { description: 'x', needsApproval: true, approvalTimeoutMs: -1 }),
    ).toThrow(
      new RangeError(
        'delegate "log-analyst": approvalTimeoutMs must be a positive integer, got -1',
      ),
    );
  });

  it('can be given to an agent like any tool', () => {
    const triage = agent({
      name: 'triage',
      model: scriptedModel([]),
      system: 'You triage.',
      tools: [delegate(analyst(), { description: 'x' })],
      persistence: inMemoryPersistence({ clock: () => 0 }),
    });
    expect(triage.tools.map((t) => t.name)).toEqual(['log_analyst']);
  });
});

describe('agent() and delegation', () => {
  it('refuses an agent that delegates to an agent of its own name', () => {
    expect(() =>
      agent({
        name: 'triage',
        model: scriptedModel([]),
        system: 'You triage.',
        tools: [delegate(analyst('triage'), { name: 'ask_triage', description: 'Itself.' })],
        persistence: inMemoryPersistence({ clock: () => 0 }),
      }),
    ).toThrow(
      new TypeError('agent "triage": tool "ask_triage" delegates to an agent of the same name'),
    );
  });
});
