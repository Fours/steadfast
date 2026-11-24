// The child that makes one model call (decision 0002). Like the tool-call child, it does one thing
// and stops: its `initial` calls the model, and its `receive` tells the parent how it went. A
// retryable failure is reported and then thrown, so supervision restarts the child with backoff,
// and the next incarnation's `initial` calls again. A model call has no side effects, so repeating
// one is always safe.

import { actor, type ActorDef, type ActorRef, type Result } from '@kylewillett/troupe';
import { jsonProblem } from '../json.js';
import { ModelError, type Model, type ModelRequest, type ModelResponse } from '../model.js';
import type { ModelCallReport } from '../run/types.js';

/** Everything one model call needs. */
export interface ModelCallOptions {
  readonly model: Model;
  readonly request: ModelRequest;
  /** The step this call answers: one more than the steps answered so far. */
  readonly step: number;
  readonly replyTo: ActorRef<ModelCallReport>;
}

/** The child's own message, from its `pipeToSelf`. */
export interface ModelCallMsg {
  readonly type: 'settled';
  readonly result: Result<ModelResponse>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The actor definition for one model call. Spawn it under the run, supervised with
 * `restartWithBackoff`.
 */
export function modelCall(options: ModelCallOptions): ActorDef<ModelCallMsg, null> {
  const { model, request, step, replyTo } = options;
  // Per incarnation, and not in state, since a controller isn't a plain value (Troupe's 0001).
  let controller = new AbortController();

  return actor<ModelCallMsg, null>({
    initial(ctx) {
      controller = new AbortController();
      // `call` may throw before it returns a promise. That's a failed call like any other.
      const call = (async () => model.call(request, controller.signal))();
      ctx.pipeToSelf(call, (result) => ({ type: 'settled', result }));
      return null;
    },

    receive(state, msg, ctx) {
      const { result } = msg;
      if (result.ok) {
        // Checked here, so a bad response is the model's failure, not a journal write that fails
        // the run itself.
        const problem = jsonProblem(result.value);
        if (problem === undefined) {
          replyTo.tell({ type: 'modelReplied', step, response: result.value });
        } else {
          const message = `${model.name} returned a response that isn't JSON: ${problem}`;
          replyTo.tell({ type: 'modelFailed', step, error: { message } });
        }
        ctx.stop();
        return state;
      }
      const message = messageOf(result.error);
      if (result.error instanceof ModelError && result.error.retryable) {
        replyTo.tell({
          type: 'attemptFailed',
          step,
          target: { kind: 'model' },
          error: { message },
        });
        throw new Error(`${model.name} (step ${String(step)}): ${message}`, {
          cause: result.error,
        });
      }
      // Adapters throw ModelError for every failure, so anything else is a bug in the adapter,
      // which retrying won't fix.
      replyTo.tell({ type: 'modelFailed', step, error: { message } });
      ctx.stop();
      return state;
    },

    onSignal(state, signal) {
      // The attempt is over, by restart or stop: a call still running should give up.
      if (signal.type === 'preRestart' || signal.type === 'postStop') {
        controller.abort(new Error(`The call to ${model.name} was stopped`));
      }
      return state;
    },
  });
}
