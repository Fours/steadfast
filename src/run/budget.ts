// The run's budgets as pure checks (the spec's "Budgets"). The actor asks them after each event
// that could exceed a budget, and finishes the run with what they return.

import type { CheckedBudget } from '../agent.js';
import type { ModelResponse, Usage } from '../model.js';
import type { Outcome } from './types.js';
import { continues } from './state.js';

/** How a run ends early: its outcome, and the sentence it finishes with. */
export interface Stop {
  readonly outcome: Outcome;
  readonly text: string;
}

function total(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Whether the response for `step`, with `usage` counted up to and including it, runs out a budget.
 * Only a response the run would go on from can: one asking for tools, or a pause, which counts as
 * a step like any other so a model that keeps pausing is bounded. One that ends the run ends it
 * anyway, and its own stop reason says more about how it ended than a budget would.
 */
export function afterResponse(
  budget: CheckedBudget,
  step: number,
  usage: Usage,
  response: ModelResponse,
): Stop | undefined {
  if (!continues(response)) return undefined;
  const used = total(usage);
  if (budget.maxTokens !== undefined && used >= budget.maxTokens) {
    return {
      outcome: 'tokensExceeded',
      text: `The run used ${String(used)} tokens, reaching its budget of ${String(budget.maxTokens)}.`,
    };
  }
  if (step >= budget.maxSteps) {
    return {
      outcome: 'stepsExceeded',
      text: `The run reached its budget of ${String(budget.maxSteps)} model calls.`,
    };
  }
  return undefined;
}

/** How a run ends when its deadline passes. */
export function deadlinePassed(deadlineMs: number): Stop {
  return {
    outcome: 'deadlineExceeded',
    text: `The run passed its deadline of ${String(deadlineMs)} ms.`,
  };
}

/**
 * The ms left before the deadline, at `now` on the agent's clock, measured from the run's start.
 * Never below 0. `undefined` when there's no deadline.
 */
export function timeLeft(
  budget: CheckedBudget,
  startedAt: number,
  now: number,
): number | undefined {
  if (budget.deadlineMs === undefined) return undefined;
  return Math.max(0, startedAt + budget.deadlineMs - now);
}

/** Whether this many failed attempts at one target means giving up on it. */
export function attemptsRunOut(budget: CheckedBudget, failed: number): boolean {
  return failed >= budget.maxAttemptsPerStep;
}
