// The budget's pure checks with limits: a run's deadline and tokens are the tighter of its own and
// those it was started with, and what it hands down counts its whole tree.

import { describe, expect, it } from 'vitest';
import type { CheckedBudget } from '../../src/index.ts';
import {
  deadlineOf,
  deadlinePassed,
  depthLeftOf,
  limitsFor,
  maxTokensOf,
  timeLeft,
  tokensRunOut,
} from '../../src/run/budget.ts';
import { initialState } from '../../src/run/state.ts';

const budget = (b: Partial<CheckedBudget> = {}): CheckedBudget => ({
  maxSteps: 50,
  maxAttemptsPerStep: 5,
  maxDepth: 3,
  ...b,
});

describe('limits', () => {
  it('takes the earlier deadline, and either one alone', () => {
    expect(deadlineOf(budget(), {}, 1_000)).toBeUndefined();
    expect(deadlineOf(budget({ deadlineMs: 500 }), {}, 1_000)).toBe(1_500);
    expect(deadlineOf(budget(), { deadlineAt: 1_200 }, 1_000)).toBe(1_200);
    expect(deadlineOf(budget({ deadlineMs: 500 }), { deadlineAt: 1_200 }, 1_000)).toBe(1_200);
    expect(deadlineOf(budget({ deadlineMs: 100 }), { deadlineAt: 1_200 }, 1_000)).toBe(1_100);
    expect(timeLeft(budget(), { deadlineAt: 1_200 }, 1_000, 1_150)).toBe(50);
    expect(timeLeft(budget(), { deadlineAt: 1_200 }, 1_000, 2_000)).toBe(0);
  });

  it('names whose deadline passed', () => {
    expect(deadlinePassed(budget({ deadlineMs: 100 }), { deadlineAt: 1_200 }, 1_000).text).toBe(
      'The run passed its deadline of 100 ms.',
    );
    expect(deadlinePassed(budget({ deadlineMs: 500 }), { deadlineAt: 1_200 }, 1_000).text).toBe(
      'The run passed the deadline it was started with, at 1200 ms.',
    );
    expect(deadlinePassed(budget(), { deadlineAt: 1_200 }, 1_000).text).toBe(
      'The run passed the deadline it was started with, at 1200 ms.',
    );
  });

  it('takes the smaller token budget, and the depth handed down over its own', () => {
    expect(maxTokensOf(budget(), {})).toBeUndefined();
    expect(maxTokensOf(budget({ maxTokens: 900 }), { maxTokens: 700 })).toBe(700);
    expect(maxTokensOf(budget({ maxTokens: 600 }), { maxTokens: 700 })).toBe(600);
    expect(depthLeftOf(budget(), {})).toBe(3);
    expect(depthLeftOf(budget({ maxDepth: 9 }), { depthLeft: 1 })).toBe(1);
  });

  it('checks tokens against the whole tree', () => {
    const used = { inputTokens: 600, outputTokens: 100 };
    expect(tokensRunOut(budget(), {}, used)).toBeUndefined();
    expect(tokensRunOut(budget({ maxTokens: 701 }), {}, used)).toBeUndefined();
    expect(tokensRunOut(budget({ maxTokens: 900 }), { maxTokens: 700 }, used)).toEqual({
      outcome: 'tokensExceeded',
      text: 'The run used 700 tokens, reaching its budget of 700.',
    });
  });

  it('hands down its deadline, what’s left of its tokens, and one level less', () => {
    const state = {
      ...initialState,
      startedAt: 1_000,
      limits: { depthLeft: 2 },
      usage: { inputTokens: 100, outputTokens: 0 },
      treeUsage: { inputTokens: 300, outputTokens: 50 },
    };
    expect(limitsFor(budget({ deadlineMs: 500, maxTokens: 1_000 }), state)).toEqual({
      deadlineAt: 1_500,
      maxTokens: 650,
      depthLeft: 1,
    });
    expect(limitsFor(budget(), { ...state, limits: {} })).toEqual({ depthLeft: 2 });
  });
});
