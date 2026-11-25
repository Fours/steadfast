// The run: a persistent actor whose journal is the run (decision 0001). It never calls a model or
// a tool itself (decision 0002). Each command persists what a child learned, and then the new
// state says what to start next. Nothing about what the run meant to do is journaled, so the same
// derivation drives a fresh start and a recovery.

import { supervise, type ActorContext, type ActorDef } from '@kylewillett/troupe';
import {
  persistentActor,
  type Effect,
  type PersistentContext,
  type PersistentState,
} from '@kylewillett/troupe/persistence';
import type { Agent, RunOptions } from '../agent.js';
import type { ModelRequest, ToolSpec } from '../model.js';
import { modelCall, retryAfterOf } from '../steps/model-call.js';
import { mayHaveRun, toolCall } from '../steps/tool-call.js';
import { afterResponse, attemptsRunOut, deadlinePassed, timeLeft, type Stop } from './budget.js';
import { finalText, initialState, onEvent, outcomeOf, wantsTools } from './state.js';
import {
  attemptKey,
  type RunEvent,
  type RunMsg,
  type RunReport,
  type RunState,
  type RunStatus,
  type StepTarget,
} from './types.js';

type Ctx = PersistentContext<RunMsg, RunEvent, RunState>;

/**
 * Every step's children are restarted with this after a retryable failure (the spec's "Steps as
 * children"). A model error's `retryAfterMs` raises the delay for that attempt.
 */
const STEP_BACKOFF = supervise.restartWithBackoff({
  minMs: 1_000,
  maxMs: 60_000,
  randomFactor: 0.2,
  minDelayFor: retryAfterOf,
});
/** Snapshot every this many events. Bump the version whenever `RunState` changes shape. */
const SNAPSHOTS = { every: 100, version: 1 } as const;
/** What the model is told about a tool call that wasn't safe to run again (decision 0003). */
export const INTERRUPTED = mayHaveRun('The tool was interrupted');
/** The key of the run's one timer. */
const DEADLINE = 'deadline';
/** Troupe's actor name pattern, which a provider's call id must fit to name a child. */
const ACTOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;

/** The model-call child's name for a step. */
export function modelChildName(step: number): string {
  return `model-${String(step)}`;
}

/**
 * A tool-call child's name. The call id is in it when it fits Troupe's name rules, so a stale
 * child of another step can't be confused with a current one. An id that doesn't fit falls back
 * to the call's place in the response, after a `~`, which a fitting id's name can't contain there.
 */
export function toolChildName(step: number, callId: string, index: number): string {
  const name = `tool-${String(step)}-${callId}`;
  return ACTOR_NAME.test(name) ? name : `tool-${String(step)}~${String(index)}`;
}

/** What `status` replies with. */
export function statusOf(state: RunState): RunStatus {
  return {
    phase: state.phase,
    step: state.step,
    usage: state.usage,
    pending: state.pending,
    ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
  };
}

/** The actor definition for one run of `agent`. Made by `agent.run`, which checks its arguments. */
export function runActor(
  agent: Agent,
  runId: string,
  options: RunOptions,
): ActorDef<RunMsg, PersistentState<RunState>> {
  const { input, reportTo } = options;
  const tools = new Map(agent.tools.map((t) => [t.name, t]));
  const specs: readonly ToolSpec[] = agent.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input: t.input,
  }));

  const report = (state: RunState): void => {
    if (reportTo === undefined) return;
    const message: RunReport = {
      type: 'runFinished',
      runId,
      // A finished state always has both. The fallbacks only satisfy the type.
      outcome: state.outcome ?? 'failed',
      text: state.text ?? '',
      usage: state.usage,
    };
    reportTo.tell(message);
  };

  /**
   * Starts whatever the state is waiting on that isn't already running, or reports a finished
   * run. It's safe to call after any event: a child that's still running is found by its name and
   * left alone. `resuming` is for the first call after a recovery, when a pending tool call was
   * started by an earlier incarnation and may or may not have run.
   */
  const act = (state: RunState, ctx: ActorContext<RunMsg>, resuming = false): void => {
    if (state.phase === 'finished') {
      // Whatever ended the run, nothing it started is wanted any more. Stopping a child aborts its
      // signal, and anything it reports afterwards is for a run that has finished, so it's ignored.
      for (const child of ctx.children()) ctx.stop(child);
      ctx.timers.cancel(DEADLINE);
      report(state);
      return;
    }
    const { pending } = state;
    if (pending.kind === 'model') {
      const step = state.step + 1;
      const name = modelChildName(step);
      if (ctx.child(name) !== undefined) return;
      const request: ModelRequest = {
        system: agent.system,
        transcript: state.transcript,
        tools: specs,
      };
      ctx.spawn(modelCall({ model: agent.model, request, step, replyTo: ctx.self }), name, {
        supervision: STEP_BACKOFF,
      });
      return;
    }
    if (pending.kind === 'tools') {
      const last = state.transcript.at(-1);
      const calls = last?.role === 'assistant' ? last.response.toolCalls : [];
      calls.forEach((call, index) => {
        if (!pending.callIds.includes(call.id)) return;
        const name = toolChildName(state.step, call.id, index);
        if (ctx.child(name) !== undefined) return;
        const t = tools.get(call.name);
        if (t === undefined) {
          // Nothing to run, so the result is known now. It goes through the mailbox like any
          // other, so it's journaled by the same command.
          ctx.self.tell({
            type: 'toolReturned',
            step: state.step,
            callId: call.id,
            result: { ok: false, error: unknownTool(call.name, [...tools.keys()]) },
          });
          return;
        }
        if (resuming && !t.idempotent) {
          // It isn't safe to repeat, so it doesn't run again, and the model decides what to do
          // (decision 0003). Through the mailbox, since onSignal can't persist.
          ctx.self.tell({
            type: 'toolReturned',
            step: state.step,
            callId: call.id,
            result: { ok: false, error: INTERRUPTED, interrupted: true },
          });
          return;
        }
        const child = toolCall({
          tool: t,
          runId,
          step: state.step,
          callId: call.id,
          input: call.input,
          replyTo: ctx.self,
        });
        ctx.spawn(child, name, { supervision: STEP_BACKOFF });
      });
    }
  };

  /** Persists `events`, then starts what the new state is waiting on. */
  const persistThenAct = (ctx: Ctx, ...events: RunEvent[]): Effect<RunEvent, RunState> =>
    ctx.persist(...events).thenRun((state) => {
      act(state, ctx);
    });

  const finished = (stop: Stop): RunEvent => ({ type: 'runFinished', ...stop });

  /**
   * Starts the deadline timer for what's left of it, measured from the run's start on the agent's
   * clock, so it holds across restarts. Returns false if it has already passed, having told the
   * run so: onSignal can't persist, so finishing is a command like any other.
   */
  const armDeadline = (state: RunState, ctx: ActorContext<RunMsg>): boolean => {
    const left = timeLeft(agent.budget, state.startedAt, agent.clock());
    if (left === undefined) return true;
    if (left === 0) {
      ctx.self.tell({ type: 'deadline' });
      return false;
    }
    ctx.timers.startSingle(DEADLINE, { type: 'deadline' }, left);
    return true;
  };

  /** The child working on `target` of `step`, if it hasn't terminated. */
  const childFor = (state: RunState, ctx: Ctx, step: number, target: StepTarget) => {
    if (target.kind === 'model') return ctx.child(modelChildName(step));
    const last = state.transcript.at(-1);
    const calls = last?.role === 'assistant' ? last.response.toolCalls : [];
    const index = calls.findIndex((c) => c.id === target.callId);
    return ctx.child(toolChildName(step, target.callId, index));
  };

  const started = (): RunEvent => ({
    type: 'runStarted',
    agent: agent.name,
    model: agent.model.name,
    input,
    startedAt: agent.clock(),
  });

  const onCommand = (state: RunState, msg: RunMsg, ctx: Ctx): Effect<RunEvent, RunState> => {
    switch (msg.type) {
      case 'status':
        return ctx.reply(msg.replyTo, statusOf(state));
      case 'start':
        if (state.phase !== 'new') return ctx.none();
        return ctx.persist(started()).thenRun((next) => {
          if (armDeadline(next, ctx)) act(next, ctx);
        });
      case 'cancel': {
        if (state.phase === 'finished') return ctx.none();
        const cancelled = finished({ outcome: 'cancelled', text: `Cancelled: ${msg.reason}` });
        // A run cancelled before it started still starts, so its journal says what was cancelled,
        // but it never calls the model: both facts are one write.
        if (state.phase === 'new') return persistThenAct(ctx, started(), cancelled);
        return persistThenAct(ctx, cancelled);
      }
      case 'deadline':
        if (state.phase !== 'running' || agent.budget.deadlineMs === undefined) return ctx.none();
        return persistThenAct(ctx, finished(deadlinePassed(agent.budget.deadlineMs)));
      case 'modelReplied': {
        if (!awaitsModel(state, msg.step)) return ctx.none();
        const { response } = msg;
        const responded: RunEvent = { type: 'modelResponded', step: msg.step, response };
        const usage = onEvent(state, responded).usage;
        const stop = afterResponse(agent.budget, msg.step, usage, response);
        // A budget that runs out ends the run instead of the tools it asked for, in the same write.
        if (stop !== undefined) return persistThenAct(ctx, responded, finished(stop));
        if (wantsTools(response)) return persistThenAct(ctx, responded);
        // A response that asks for nothing ends the run, in the same write.
        return persistThenAct(ctx, responded, {
          type: 'runFinished',
          outcome: outcomeOf(response.stop),
          text: finalText(response),
        });
      }
      case 'modelFailed':
        if (!awaitsModel(state, msg.step)) return ctx.none();
        // A model's failure ends the run, since nothing else can answer for it.
        return persistThenAct(ctx, {
          type: 'runFinished',
          outcome: 'failed',
          text: `The model call failed: ${msg.error.message}`,
        });
      case 'toolReturned':
        if (!awaitsTool(state, msg.step, msg.callId)) return ctx.none();
        return persistThenAct(ctx, {
          type: 'toolFinished',
          step: msg.step,
          callId: msg.callId,
          result: msg.result,
        });
      case 'attemptFailed': {
        const { target } = msg;
        const current =
          target.kind === 'model'
            ? awaitsModel(state, msg.step)
            : awaitsTool(state, msg.step, target.callId);
        if (!current) return ctx.none();
        // Journaled so the count survives a crash, and counted from the journal for the same reason.
        const failed: RunEvent = {
          type: 'attemptFailed',
          step: msg.step,
          target,
          error: msg.error,
        };
        const count = (state.attempts[attemptKey(msg.step, target)] ?? 0) + 1;
        if (!attemptsRunOut(agent.budget, count)) return ctx.persist(failed);
        // Giving up is in the same write as the last attempt, so the journal never holds a count
        // that has run out with nothing to say what came of it.
        const tries = `failed ${String(count)} times. The last error: ${msg.error.message}`;
        const givenUp: RunEvent =
          target.kind === 'model'
            ? finished({ outcome: 'failed', text: `The model call ${tries}` })
            : {
                type: 'toolFinished',
                step: msg.step,
                callId: target.callId,
                result: { ok: false, error: `The tool call ${tries}` },
              };
        // The child is waiting out its backoff, to try again. It's stopped before the next state
        // acts, so a finished tool call can't be confused with one still running.
        const child = childFor(state, ctx, msg.step, target);
        return ctx.persist(failed, givenUp).thenRun((next) => {
          if (child !== undefined) ctx.stop(child);
          act(next, ctx);
        });
      }
    }
  };

  return persistentActor<RunMsg, RunEvent, RunState>({
    id: agent.persistenceId(runId),
    persistence: agent.persistence,
    initial: initialState,
    onCommand,
    onEvent,
    onSignal(state, signal, ctx) {
      if (signal.type !== 'recoveryCompleted') return;
      // onSignal can't persist, so starting is a command the run sends itself. Anything sent
      // during recovery is ahead of it in the mailbox, and sees the phase as `new`.
      if (state.phase === 'new') {
        ctx.self.tell({ type: 'start' });
        return;
      }
      // The journal's input is the run's. The caller's is only for a run that hasn't started.
      if (state.input !== input) {
        ctx.log.warn(`${ctx.persistenceId}: resumed with a different input, which is ignored`, {
          runId,
        });
      }
      // A deadline that has passed while the run was down finishes it before anything starts.
      if (state.phase === 'running' && !armDeadline(state, ctx)) return;
      // The same derivation as after any event. A finished run reports, and starts nothing.
      act(state, ctx, true);
    },
    ...(agent.persistence.snapshots === undefined ? {} : { snapshots: SNAPSHOTS }),
  });
}

/** Whether the run is waiting on the model call for `step`. */
function awaitsModel(state: RunState, step: number): boolean {
  return state.phase === 'running' && state.pending.kind === 'model' && step === state.step + 1;
}

/** Whether the run is waiting on tool call `callId` of `step`. */
function awaitsTool(state: RunState, step: number, callId: string): boolean {
  const { pending } = state;
  return (
    state.phase === 'running' &&
    pending.kind === 'tools' &&
    step === state.step &&
    pending.callIds.includes(callId)
  );
}

/** What the model is told when it calls a tool the agent doesn't have. */
export function unknownTool(name: string, names: readonly string[]): string {
  const known =
    names.length === 0 ? 'This agent has no tools.' : `The tools are: ${names.join(', ')}.`;
  return `There is no tool named "${name}". ${known}`;
}
