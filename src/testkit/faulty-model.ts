// A model that fails chosen calls, to test retries and backoff without a real provider.

import type { Model, ModelRequest } from '../model.js';
import type { ModelError } from '../model.js';

/** The failures for one step: its first attempts fail with these errors, in order. */
export interface Fault {
  /** The step, from 1: the model call that will be the step's response. */
  readonly step: number;
  readonly fail: readonly ModelError[];
}

/**
 * The step a request is for, from the request alone: one more than the responses in its
 * transcript. That's what the run's own step count will be once it's answered, and it holds for a
 * request made after recovery too.
 */
function stepOf(request: ModelRequest): number {
  return request.transcript.filter((turn) => turn.role === 'assistant').length + 1;
}

/**
 * Wraps `inner` so the first attempts at each faulted step throw the given errors, in order. Every
 * other call passes through to `inner`, which never sees the failed ones. Attempts are counted by
 * this model, so share one instance across a run's restarts.
 */
export function faultyModel(inner: Model, faults: Fault | readonly Fault[]): Model {
  const byStep = new Map<number, readonly ModelError[]>();
  // concat takes one fault or a list of them, and keeps the type, where Array.isArray wouldn't.
  for (const fault of ([] as readonly Fault[]).concat(faults)) {
    if (!Number.isInteger(fault.step) || fault.step < 1) {
      throw new RangeError(
        `faultyModel: step must be a positive integer, got ${String(fault.step)}`,
      );
    }
    if (byStep.has(fault.step))
      throw new RangeError(`faultyModel: step ${String(fault.step)} is given twice`);
    byStep.set(fault.step, fault.fail);
  }
  const attempts = new Map<number, number>();
  return {
    name: inner.name,
    async call(request, signal) {
      const step = stepOf(request);
      const attempt = attempts.get(step) ?? 0;
      attempts.set(step, attempt + 1);
      const error = byStep.get(step)?.[attempt];
      if (error !== undefined) throw error;
      return inner.call(request, signal);
    },
  };
}
