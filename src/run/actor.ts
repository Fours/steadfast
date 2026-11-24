// The run: a persistent actor whose journal is the run (decision 0001). It never calls a model or
// a tool itself (decision 0002). Each command persists what a child learned, and then the new
// state says what to start next. Nothing about what the run meant to do is journaled, so the same
// derivation drives a fresh start and, from T4, a recovery.

import { supervise, type ActorContext, type ActorDef } from '@kylewillett/troupe';
import {
  persistentActor,
  type Effect,
  type PersistentContext,
  type PersistentState,
} from '@kylewillett/troupe/persistence';
import type { Agent, RunOptions } from '../agent.js';
import type { ModelRequest, ToolSpec } from '../model.js';
import { modelCall } from '../steps/model-call.js';
import { toolCall } from '../steps/tool-call.js';
import { finalText, initialState, onEvent, outcomeOf, wantsTools } from './state.js';
import type { RunEvent, RunMsg, RunReport, RunState, RunStatus } from './types.js';

type Ctx = PersistentContext<RunMsg, RunEvent, RunState>;

/** Every step's children are restarted with this after a retryable failure (the spec's "Steps as children"). */
const STEP_BACKOFF = supervise.restartWithBackoff({
  minMs: 1_000,
  maxMs: 60_000,
  randomFactor: 0.2,
});
/** Snapshot every this many events. Bump the version whenever `RunState` changes shape. */
const SNAPSHOTS = { every: 100, version: 1 } as const;
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
   * left alone.
   */
  const act = (state: RunState, ctx: ActorContext<RunMsg>): void => {
    if (state.phase === 'finished') {
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

  const onCommand = (state: RunState, msg: RunMsg, ctx: Ctx): Effect<RunEvent, RunState> => {
    switch (msg.type) {
      case 'status':
        return ctx.reply(msg.replyTo, statusOf(state));
      case 'start':
        if (state.phase !== 'new') return ctx.none();
        return persistThenAct(ctx, {
          type: 'runStarted',
          agent: agent.name,
          model: agent.model.name,
          input,
          startedAt: agent.clock(),
        });
      case 'modelReplied': {
        if (!awaitsModel(state, msg.step)) return ctx.none();
        const { response } = msg;
        const responded: RunEvent = { type: 'modelResponded', step: msg.step, response };
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
        // Journaled so the count survives a crash. T5 gives up when attempts run out.
        return ctx.persist({ type: 'attemptFailed', step: msg.step, target, error: msg.error });
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
      if (state.phase === 'new') ctx.self.tell({ type: 'start' });
      // Resuming a run that has events is T4.
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
