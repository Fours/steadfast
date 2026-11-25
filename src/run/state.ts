// The run's state as a pure fold of its events. It runs again for every event on every recovery,
// and `readRun` folds the same events the same way, so it reads nothing but its arguments, never
// mutates them, and never throws for an event it has accepted (Troupe's 0012).

import type { ModelResponse, StopReason, ToolResult, Turn, Usage } from '../model.js';
import { attemptKey, type Outcome, type RunEvent, type RunState } from './types.js';

const initial: RunState = {
  phase: 'new',
  input: '',
  startedAt: 0,
  limits: {},
  transcript: [],
  step: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  treeUsage: { inputTokens: 0, outputTokens: 0 },
  pending: { kind: 'none' },
  stepResults: [],
  approvals: {},
  attempts: {},
  unfinished: [],
};
/** The state before any event. */
export const initialState: RunState = Object.freeze(initial);

/** Two usages added up. */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** Whether a response asks for tools the run should now call. */
export function wantsTools(response: ModelResponse): boolean {
  return response.stop === 'toolUse' && response.toolCalls.length > 0;
}

/**
 * Whether the run goes on after a response: to its tool calls, or to the model again after a
 * pause. A response that does neither ends the run.
 */
export function continues(response: ModelResponse): boolean {
  return wantsTools(response) || response.stop === 'paused';
}

/** How a run ends on a response that doesn't ask for tools. */
export function outcomeOf(stop: StopReason): Outcome {
  switch (stop) {
    case 'endTurn':
      return 'completed';
    case 'maxOutputTokens':
      return 'maxOutputTokens';
    case 'refusal':
      return 'refused';
    case 'toolUse':
      // `toolUse` with no tool calls: the model said it would call something, and didn't.
      return 'failed';
    case 'paused':
      // Never asked: a paused response continues the run. Here so the switch stays exhaustive.
      return 'failed';
  }
}

/** The text a run finishes with after `response`. */
export function finalText(response: ModelResponse): string {
  if (response.stop === 'toolUse') return 'The model stopped to use a tool, but called none.';
  return response.text;
}

/** Applies one event. Pure. */
export function onEvent(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case 'runStarted':
      return {
        ...state,
        phase: 'running',
        input: event.input,
        startedAt: event.startedAt,
        // A journal from before limits existed has none.
        limits: event.limits ?? {},
        transcript: [{ role: 'user', text: event.input }],
        pending: { kind: 'model' },
      };
    case 'modelResponded': {
      const { response } = event;
      return {
        ...state,
        step: event.step,
        transcript: [...state.transcript, { role: 'assistant', response }],
        usage: addUsage(state.usage, response.usage),
        treeUsage: addUsage(state.treeUsage, response.usage),
        // A paused turn goes straight back to the model, with nothing added: the provider resumes
        // from the response itself. Its stop reason wins over any tool calls in it.
        pending:
          response.stop === 'paused'
            ? { kind: 'model' }
            : wantsTools(response)
              ? { kind: 'tools', callIds: response.toolCalls.map((c) => c.id) }
              : { kind: 'none' },
        stepResults: [],
        approvals: {},
      };
    }
    case 'approvalRequested': {
      // Only the current step's calls are asked about, in the write of the response that made them.
      if (event.step !== state.step) return state;
      const approval = {
        status: 'waiting' as const,
        requestedAt: event.requestedAt,
        ...(event.timeoutMs === undefined ? {} : { timeoutMs: event.timeoutMs }),
      };
      return { ...state, approvals: { ...state.approvals, [event.callId]: approval } };
    }
    case 'approvalDecided': {
      const approval = state.approvals[event.callId];
      if (event.step !== state.step || approval === undefined) return state;
      const status = event.approved ? ('approved' as const) : ('denied' as const);
      return {
        ...state,
        approvals: { ...state.approvals, [event.callId]: { ...approval, status } },
      };
    }
    case 'toolFinished': {
      const next = toolFinished(state, event.callId, event.result);
      // A sub-run's usage counts once its delegation is in. An older journal's events have none.
      if (next === state || event.usage === undefined) return next;
      return { ...next, treeUsage: addUsage(next.treeUsage, event.usage) };
    }
    case 'attemptFailed': {
      const key = attemptKey(event.step, event.target);
      return { ...state, attempts: { ...state.attempts, [key]: (state.attempts[key] ?? 0) + 1 } };
    }
    case 'runFinished':
      return {
        ...state,
        phase: 'finished',
        pending: { kind: 'none' },
        // Kept, so a finished run can close whatever sub-runs they had started (decision 0008).
        unfinished: state.pending.kind === 'tools' ? state.pending.callIds : [],
        outcome: event.outcome,
        text: event.text,
      };
  }
}

function toolFinished(state: RunState, callId: string, result: ToolResult): RunState {
  const { pending } = state;
  // The run only persists results it's waiting on, so this is never true of a journaled event.
  // It's a no-op rather than a throw, since onEvent must never throw for an accepted event.
  if (pending.kind !== 'tools' || !pending.callIds.includes(callId)) return state;
  const stepResults = [...state.stepResults, { callId, result }];
  const callIds = pending.callIds.filter((id) => id !== callId);
  if (callIds.length > 0) return { ...state, pending: { kind: 'tools', callIds }, stepResults };
  // Every call of the step is in: they go to the model as one turn, in the order it called them,
  // whichever order they finished in.
  const turn: Turn = { role: 'toolResults', results: inCallOrder(state.transcript, stepResults) };
  return {
    ...state,
    transcript: [...state.transcript, turn],
    pending: { kind: 'model' },
    stepResults: [],
  };
}

function inCallOrder(
  transcript: readonly Turn[],
  results: RunState['stepResults'],
): RunState['stepResults'] {
  // While tools are pending, the last turn is the response that called them.
  const last = transcript.at(-1);
  const order = last?.role === 'assistant' ? last.response.toolCalls.map((c) => c.id) : [];
  return [...results].sort((a, b) => order.indexOf(a.callId) - order.indexOf(b.callId));
}
