import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { describe, expect, it } from 'vitest';
import { agent, tool, type AgentOptions, type Tool } from '../src/index.ts';
import { scriptedModel } from '../src/testkit/index.ts';

const readLog = tool({
  name: 'read_log',
  description: 'Read a log.',
  input: { type: 'object' },
  run: () => Promise.resolve('ok'),
});

function options(overrides: Record<string, unknown> = {}): AgentOptions {
  return {
    name: 'triage',
    model: scriptedModel([]),
    system: 'You triage.',
    tools: [readLog],
    persistence: inMemoryPersistence({ clock: () => 0 }),
    clock: () => 0,
    ...overrides,
  };
}

describe('agent()', () => {
  it('fills in the budget’s defaults', () => {
    const a = agent(options());
    expect(a.budget).toEqual({ maxSteps: 50, maxAttemptsPerStep: 5, maxDepth: 3 });
    expect(agent(options({ budget: { maxTokens: 200_000, deadlineMs: 900_000 } })).budget).toEqual({
      maxSteps: 50,
      maxTokens: 200_000,
      deadlineMs: 900_000,
      maxAttemptsPerStep: 5,
      maxDepth: 3,
    });
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.tools).toEqual([readLog]);
  });

  it('defaults to the wall clock', () => {
    const a = agent(options({ clock: undefined }));
    expect(Number.isInteger(a.clock())).toBe(true);
    expect(a.clock()).toBeGreaterThan(1_700_000_000_000);
  });

  it('throws on two tools with the same name', () => {
    expect(() => agent(options({ tools: [readLog, { ...readLog }] }))).toThrow(
      new TypeError('agent "triage": two tools are named "read_log"'),
    );
  });

  it.each([
    ['maxSteps', 0],
    ['maxTokens', -1],
    ['deadlineMs', 1.5],
    ['maxAttemptsPerStep', '5'],
    ['maxDepth', 0],
    ['maxSteps', Number.MAX_SAFE_INTEGER + 1],
  ])('throws on a budget.%s of %s', (key, value) => {
    expect(() => agent(options({ budget: { [key]: value } }))).toThrow(RangeError);
    expect(() => agent(options({ budget: { [key]: value } }))).toThrow(
      `budget.${key} must be a positive integer`,
    );
  });

  it.each([
    ['an unknown budget key', { budget: { maxStep: 5 } }, 'budget: unknown option "maxStep"'],
    ['a budget that isn’t an object', { budget: 5 }, 'budget must be an object'],
    ['a bad name', { name: 'has spaces' }, 'name must match'],
    ['an unknown option', { tool: [] }, 'unknown option "tool"'],
    ['a model without call', { model: { name: 'x' } }, 'model must be a Model'],
    ['a missing system', { system: undefined }, 'system must be a string'],
    ['tools that aren’t an array', { tools: readLog }, 'tools must be an array'],
    [
      'a tool not made by tool()',
      { tools: [{ name: 'raw', run: () => Promise.resolve(1) }] },
      'tools must be made by tool()',
    ],
    ['persistence without a journal', { persistence: {} }, 'persistence must be a Troupe'],
    ['a clock that isn’t a function', { clock: 5 }, 'clock must be a function'],
  ])('throws on %s', (_name, overrides, message) => {
    expect(() => agent(options(overrides))).toThrow(TypeError);
    expect(() => agent(options(overrides))).toThrow(message);
  });

  it('throws on options that aren’t an object', () => {
    expect(() => agent(null as unknown as AgentOptions)).toThrow('agent: give an options object');
  });

  it('accepts an agent with no tools', () => {
    expect(agent(options({ tools: undefined })).tools).toEqual([]);
  });

  describe('run()', () => {
    const a = agent(options());

    it.each([
      ['an empty runId', '', { input: 'x' }, 'runId must be a non-empty string'],
      ['a runId that isn’t a string', 42, { input: 'x' }, 'runId must be a non-empty string'],
      ['a runId too long for a stream id', 'x'.repeat(250), { input: 'x' }, 'runId is too long'],
      ['options that aren’t an object', 'r1', null, 'run options must be an object'],
      ['an input that isn’t a string', 'r1', { input: 5 }, 'input must be a string'],
      ['a reportTo that isn’t a ref', 'r1', { input: 'x', reportTo: {} }, 'reportTo must be'],
      ['a progressTo that isn’t a ref', 'r1', { input: 'x', progressTo: 3 }, 'progressTo must be'],
      ['an unknown option', 'r1', { input: 'x', reportto: null }, 'unknown option "reportto"'],
      ['limits that aren’t an object', 'r1', { input: 'x', limits: 3 }, 'limits must be an object'],
      ['an unknown limit', 'r1', { input: 'x', limits: { depth: 1 } }, 'unknown option "depth"'],
    ])('throws on %s', (_name, runId, runOptions, message) => {
      expect(() => a.run(runId as string, runOptions as { input: string })).toThrow(TypeError);
      expect(() => a.run(runId as string, runOptions as { input: string })).toThrow(message);
    });

    it.each([
      ['deadlineAt', -1],
      ['deadlineAt', 1.5],
      ['maxTokens', 0],
      ['depthLeft', -1],
      ['depthLeft', '2'],
    ])('throws on limits.%s of %s', (key, value) => {
      const call = () => a.run('r1', { input: 'x', limits: { [key]: value } });
      expect(call).toThrow(RangeError);
      expect(call).toThrow(`limits.${key} must be an integer of at least`);
    });

    it('takes limits at their least', () => {
      expect(() =>
        a.run('r1', { input: 'x', limits: { deadlineAt: 0, maxTokens: 1, depthLeft: 0 } }),
      ).not.toThrow();
    });

    it('takes the longest runId that fits', () => {
      const longest = 'x'.repeat(255 - 'run-triage-'.length);
      expect(() => a.run(longest, { input: 'x' })).not.toThrow();
      expect(() => a.run(`${longest}x`, { input: 'x' })).toThrow('runId is too long');
    });
  });

  it('keeps tools it was given in order', () => {
    const queryMetrics: Tool = tool({
      name: 'query_metrics',
      description: 'Query metrics.',
      input: { type: 'object' },
      run: () => Promise.resolve(1),
    });
    expect(agent(options({ tools: [queryMetrics, readLog] })).tools.map((t) => t.name)).toEqual([
      'query_metrics',
      'read_log',
    ]);
  });
});
