// The run's budgets as pure checks (the spec's "Budgets"). The actor asks them after each event
// that could exceed a budget, and finishes the run with what they return.

import type { CheckedBudget } from '../agent.js';
import type { ModelResponse, Usage } from '../model.js';
import type { Outcome, RunLimits, RunState } from './types.js';
import { continues } from './state.js';

/** How a run ends early: its outcome, and the sentence it finishes with. */
export interface Stop {
  readonly outcome: Outcome;
  readonly text: string;
}

function total(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

/** The smaller of two optional limits, or whichever is set. */
function earlier(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** The run's own deadline, on the agent's clock, if its budget has one. */
function ownDeadline(budget: CheckedBudget, startedAt: number): number | undefined {
  return budget.deadlineMs === undefined ? undefined : startedAt + budget.deadlineMs;
}

/** When the run must finish, on the agent's clock: the earlier of its own deadline and its limit's. */
export function deadlineOf(
  budget: CheckedBudget,
  limits: RunLimits,
  startedAt: number,
): number | undefined {
  return earlier(ownDeadline(budget, startedAt), limits.deadlineAt);
}

/** The tokens the run's whole tree may use: the smaller of its budget's and its limit's. */
export function maxTokensOf(budget: CheckedBudget, limits: RunLimits): number | undefined {
  return earlier(budget.maxTokens, limits.maxTokens);
}

/** How many more levels of sub-runs may start under the run. Only a root's budget counts. */
export function depthLeftOf(budget: CheckedBudget, limits: RunLimits): number {
  return limits.depthLeft ?? budget.maxDepth;
}

/**
 * The limits a run hands down to a sub-run it starts now: its own deadline, what's left of its
 * tokens, counting every finished sub-run, and one level less. Only a run with depth left
 * delegates, and one with no tokens left has already finished, so both stay valid limits.
 */
export function limitsFor(budget: CheckedBudget, state: RunState): RunLimits {
  const deadlineAt = deadlineOf(budget, state.limits, state.startedAt);
  const maxTokens = maxTokensOf(budget, state.limits);
  return {
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(maxTokens === undefined ? {} : { maxTokens: maxTokens - total(state.treeUsage) }),
    depthLeft: depthLeftOf(budget, state.limits) - 1,
  };
}

/**
 * Whether `treeUsage`, the run's own model calls and its finished sub-runs, reaches the tokens
 * the run's tree may use.
 */
export function tokensRunOut(
  budget: CheckedBudget,
  limits: RunLimits,
  treeUsage: Usage,
): Stop | undefined {
  const max = maxTokensOf(budget, limits);
  const used = total(treeUsage);
  if (max === undefined || used < max) return undefined;
  return {
    outcome: 'tokensExceeded',
    text: `The run used ${String(used)} tokens, reaching its budget of ${String(max)}.`,
  };
}

/**
 * Whether the response for `step`, with `treeUsage` counted up to and including it, runs out a
 * budget. Only a response the run would go on from can: one asking for tools, or a pause, which
 * counts as a step like any other so a model that keeps pausing is bounded. One that ends the run
 * ends it anyway, and its own stop reason says more about how it ended than a budget would.
 */
export function afterResponse(
  budget: CheckedBudget,
  limits: RunLimits,
  step: number,
  treeUsage: Usage,
  response: ModelResponse,
): Stop | undefined {
  if (!continues(response)) return undefined;
  const tokens = tokensRunOut(budget, limits, treeUsage);
  if (tokens !== undefined) return tokens;
  if (step >= budget.maxSteps) {
    return {
      outcome: 'stepsExceeded',
      text: `The run reached its budget of ${String(budget.maxSteps)} model calls.`,
    };
  }
  return undefined;
}

/** How a run ends when its deadline passes, naming whose deadline it was. */
export function deadlinePassed(budget: CheckedBudget, limits: RunLimits, startedAt: number): Stop {
  const own = ownDeadline(budget, startedAt);
  const text =
    budget.deadlineMs !== undefined &&
    (limits.deadlineAt === undefined || own === deadlineOf(budget, limits, startedAt))
      ? `The run passed its deadline of ${String(budget.deadlineMs)} ms.`
      : `The run passed the deadline it was started with, at ${String(limits.deadlineAt)} ms.`;
  return { outcome: 'deadlineExceeded', text };
}

/**
 * The ms left before the deadline, at `now` on the agent's clock. Never below 0. `undefined` when
 * there's no deadline.
 */
export function timeLeft(
  budget: CheckedBudget,
  limits: RunLimits,
  startedAt: number,
  now: number,
): number | undefined {
  const deadline = deadlineOf(budget, limits, startedAt);
  if (deadline === undefined) return undefined;
  return Math.max(0, deadline - now);
}

/** Whether this many failed attempts at one target means giving up on it. */
export function attemptsRunOut(budget: CheckedBudget, failed: number): boolean {
  return failed >= budget.maxAttemptsPerStep;
}
