// The child that runs one tool call (decision 0002). It does one thing and stops: its `initial`
// starts the call, and its `receive` tells the parent how it went. A failure worth retrying is
// reported and then thrown, so the parent's supervision restarts it with backoff, and the next
// incarnation's `initial` calls again. Everything else is reported, and the child stops.

import { actor, type ActorDef, type ActorRef, type Result } from '@kylewillett/troupe';
import type { StandardSchemaV1 } from '@kylewillett/troupe/persistence';
import { jsonProblem, type JsonValue } from '../json.js';
import type { ToolResult } from '../model.js';
import { RetryableToolError, type Tool, type ToolContext } from '../tool.js';
import type { StepError, ToolCallReport } from './messages.js';

/** Everything one tool call needs. */
export interface ToolCallOptions {
  readonly tool: Tool;
  readonly runId: string;
  readonly step: number;
  readonly callId: string;
  /** The model's input, as it came. */
  readonly input: JsonValue;
  readonly replyTo: ActorRef<ToolCallReport>;
}

/** How one attempt went, short of `run` throwing. */
type Attempt =
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'ran'; readonly output: unknown };

/** The child's own messages, from its `pipeToSelf` and its timer. */
export type ToolCallMsg =
  | { readonly type: 'settled'; readonly attempt: number; readonly result: Result<Attempt> }
  | { readonly type: 'timedOut' };

/** Which attempt this incarnation is making, so a late result from an earlier one is ignored. */
export interface ToolCallState {
  readonly attempt: number;
}

/** What the model is told when a tool may have acted but its result is unknown (decision 0003). */
export function mayHaveRun(what: string): string {
  return `${what} and may or may not have run. Check before trying again.`;
}

/** The key a tool can dedupe on: the same on every attempt, and in every incarnation of the run. */
export function idempotencyKey(runId: string, step: number, callId: string): string {
  return `${runId}:${String(step)}:${callId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issuesText(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? []).map((segment) =>
        String(typeof segment === 'object' ? segment.key : segment),
      );
      return path.length === 0 ? issue.message : `${path.join('.')}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Checks the model's input with the tool's `parse`, if it has one, then runs the tool. Only `run`
 * can reject: an input that fails its check, or a check that throws, is an `invalid` attempt.
 */
async function runAttempt(tool: Tool, input: JsonValue, ctx: ToolContext): Promise<Attempt> {
  let parsed: JsonValue = input;
  if (tool.parse !== undefined) {
    let checked: StandardSchemaV1.Result<JsonValue>;
    try {
      checked = await tool.parse['~standard'].validate(input);
    } catch (error) {
      return {
        kind: 'invalid',
        error: `Couldn't check the input for ${tool.name}: ${messageOf(error)}`,
      };
    }
    if (checked.issues !== undefined) {
      return {
        kind: 'invalid',
        error: `Invalid input for ${tool.name}: ${issuesText(checked.issues)}`,
      };
    }
    parsed = checked.value;
  }
  return { kind: 'ran', output: await tool.run(parsed, ctx) };
}

/**
 * The actor definition for one tool call. Spawn it under the run, supervised with
 * `restartWithBackoff`: the parent counts attempts and stops the child when they run out.
 */
export function toolCall(options: ToolCallOptions): ActorDef<ToolCallMsg, ToolCallState> {
  const { tool, runId, step, callId, input, replyTo } = options;
  const key = idempotencyKey(runId, step, callId);
  // Per incarnation, and not in state, since a controller isn't a plain value (Troupe's 0001).
  // Only the latest incarnation's is live: each one aborts it as it ends.
  let attempts = 0;
  let controller = new AbortController();

  const finish = (result: ToolResult, ctx: { stop(): void }): ToolCallState => {
    replyTo.tell({ type: 'toolReturned', step, callId, result });
    ctx.stop();
    return { attempt: attempts };
  };

  /** Reports the attempt, then throws so supervision restarts the child. */
  const retry = (error: StepError, cause?: unknown): never => {
    replyTo.tell({ type: 'attemptFailed', step, target: { kind: 'tool', callId }, error });
    const message = `${tool.name} (${callId}): ${error.message}`;
    throw cause === undefined ? new Error(message) : new Error(message, { cause });
  };

  return actor<ToolCallMsg, ToolCallState>({
    initial(ctx) {
      attempts += 1;
      controller = new AbortController();
      const n = attempts;
      const toolCtx: ToolContext = Object.freeze({
        runId,
        callId,
        idempotencyKey: key,
        signal: controller.signal,
      });
      ctx.timers.startSingle('timeout', { type: 'timedOut' }, tool.timeoutMs);
      // With the signal, the pipe ends at the timeout or the stop, whatever the tool does, and the
      // testkit doesn't wait on it as busy work (Troupe's 0038).
      ctx.pipeToSelf(
        runAttempt(tool, input, toolCtx),
        (result) => ({ type: 'settled', attempt: n, result }),
        { signal: controller.signal },
      );
      return { attempt: n };
    },

    receive(state, msg, ctx) {
      if (msg.type === 'timedOut') {
        const what = `${tool.name} timed out after ${String(tool.timeoutMs)} ms`;
        controller.abort(new Error(what));
        // It may have acted before the deadline, so only a tool that's safe to repeat goes again.
        if (tool.idempotent) return retry({ message: what });
        return finish({ ok: false, error: mayHaveRun(what), interrupted: true }, ctx);
      }
      // A late result from an attempt that timed out. Its incarnation has already reported.
      if (msg.attempt !== state.attempt) return state;
      const { result } = msg;
      if (!result.ok) {
        const message = messageOf(result.error);
        if (tool.idempotent || result.error instanceof RetryableToolError) {
          return retry({ message }, result.error);
        }
        return finish({ ok: false, error: message }, ctx);
      }
      if (result.value.kind === 'invalid')
        return finish({ ok: false, error: result.value.error }, ctx);
      const output = result.value.output;
      const problem = jsonProblem(output);
      if (problem !== undefined) {
        return finish(
          { ok: false, error: `${tool.name} returned a value that isn't JSON: ${problem}` },
          ctx,
        );
      }
      return finish({ ok: true, output: output as JsonValue }, ctx);
    },

    onSignal(state, signal) {
      // The attempt is over, by restart or stop: a tool still running should give up.
      if (signal.type === 'preRestart' || signal.type === 'postStop')
        controller.abort(new Error(`${tool.name} was stopped`));
      return state;
    },
  });
}
