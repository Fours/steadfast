// The child that makes one model call (decision 0002). Like the tool-call child, it does one thing
// and stops: its `initial` calls the model, and its `receive` tells the parent how it went. A
// retryable failure is reported and then thrown, so supervision restarts the child with backoff,
// and the next incarnation's `initial` calls again. A model call has no side effects, so repeating
// one is always safe.

import { actor, type ActorDef, type ActorRef, type Result } from '@kylewillett/troupe';
import { jsonProblem } from '../json.js';
import { ModelError, type Model, type ModelRequest, type ModelResponse } from '../model.js';
import type { ApprovalCheckResult, ModelCallReport } from '../run/types.js';

/** Everything one model call needs. */
export interface ModelCallChildOptions {
  readonly model: Model;
  readonly request: ModelRequest;
  /** The step this call answers: one more than the steps answered so far. */
  readonly step: number;
  readonly replyTo: ActorRef<ModelCallReport>;
  /** Given each piece of streamed text, with the attempt it belongs to, from 1. */
  readonly onText?: (text: string, attempt: number) => void;
  /**
   * Checks which of the response's calls need a person's approval, before the response is
   * reported, so the run journals the answer with it (decision 0007). Returns undefined when no
   * call might, and never rejects.
   */
  readonly checkApprovals?: (
    response: ModelResponse,
  ) => Promise<readonly ApprovalCheckResult[]> | undefined;
}

/** The child's own messages, from its `pipeToSelf`. */
export type ModelCallMsg =
  | {
      readonly type: 'settled';
      /** Which incarnation made the call, so an aborted earlier attempt's result is ignored. */
      readonly attempt: number;
      readonly result: Result<ModelResponse>;
    }
  | {
      readonly type: 'checked';
      readonly response: ModelResponse;
      readonly approvals: readonly ApprovalCheckResult[];
    };

/** Which attempt this incarnation is making. */
export interface ModelCallState {
  readonly attempt: number;
}

/**
 * The fewest ms a restart must wait after `failure`: the `retryAfterMs` of the model error this
 * child threw, as its cause. For Troupe's `minDelayFor` (Troupe's 0041), so a provider that says
 * how long to wait is waited for, even past the backoff's `maxMs`.
 */
export function retryAfterOf(failure: unknown): number | undefined {
  return failure instanceof Error && failure.cause instanceof ModelError
    ? failure.cause.retryAfterMs
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The actor definition for one model call. Spawn it under the run, supervised with
 * `restartWithBackoff`.
 */
export function modelCall(options: ModelCallChildOptions): ActorDef<ModelCallMsg, ModelCallState> {
  const { model, request, step, replyTo, onText, checkApprovals } = options;
  // Per incarnation, and not in state, since a controller isn't a plain value (Troupe's 0001).
  let attempts = 0;
  let controller = new AbortController();

  return actor<ModelCallMsg, ModelCallState>({
    initial(ctx) {
      attempts += 1;
      controller = new AbortController();
      const n = attempts;
      const { signal } = controller;
      // `call` may throw before it returns a promise. That's a failed call like any other.
      // The attempt goes with each piece, so a listener can drop what a failed attempt streamed.
      const callOptions =
        onText === undefined
          ? { signal }
          : {
              signal,
              onText: (text: string) => {
                // A stopped attempt's late pieces aren't wanted.
                if (!signal.aborted) onText(text, n);
              },
            };
      const call = (async () => model.call(request, callOptions))();
      // With the signal, the pipe ends when the attempt is stopped, whatever the model does, and
      // the testkit doesn't wait on it as busy work (Troupe's 0038).
      ctx.pipeToSelf(call, (result) => ({ type: 'settled', attempt: n, result }), { signal });
      return { attempt: n };
    },

    receive(state, msg, ctx) {
      if (msg.type === 'checked') {
        replyTo.tell({
          type: 'modelReplied',
          step,
          response: msg.response,
          approvals: msg.approvals,
        });
        ctx.stop();
        return state;
      }
      // An earlier incarnation's call, aborted as it ended. That incarnation has already reported.
      if (msg.attempt !== state.attempt) return state;
      const { result } = msg;
      if (result.ok) {
        // Checked here, so a bad response is the model's failure, not a journal write that fails
        // the run itself.
        const problem = jsonProblem(result.value);
        const checking = problem === undefined ? checkApprovals?.(result.value) : undefined;
        if (checking !== undefined) {
          // The child stops once it has told the answer. The check never rejects, but if it did,
          // asking about every call would be the safe answer.
          const response = result.value;
          ctx.pipeToSelf(checking, (checked) => ({
            type: 'checked',
            response,
            approvals: checked.ok
              ? checked.value
              : response.toolCalls.map((c) => ({ callId: c.id, ask: true as const })),
          }));
          return state;
        }
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
