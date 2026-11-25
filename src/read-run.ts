// Reading a run back from its journal, with no model and no actor. It folds the events through the
// run's own `onEvent`, so what it shows is exactly what a recovering run would see (decision 0005).
// It's the base for the example's `--show`, milestone 3's timeline and milestone 4's replays.

import type { Agent } from './agent.js';
import type { JsonValue } from './json.js';
import type { ModelResponse, ToolResult } from './model.js';
import { initialState, onEvent } from './run/state.js';
import type { RunEvent, RunState, StepError } from './run/types.js';

/** What {@link readRun} takes. */
export interface ReadRunOptions {
  /** Read only the first `upTo` events, to see the run as it was then. Default: every event. */
  readonly upTo?: number;
}

/** One journaled event, where it sits in the run's stream, and when it was written. */
export interface TimelineEvent {
  /** Its place in the run's stream: 1, 2, 3, ... */
  readonly seq: number;
  /** The journal's wall-clock ms when it was appended. For people, never for ordering. */
  readonly timestamp: number;
  readonly event: RunEvent;
}

/** A failed attempt, and the event that journaled it. */
export interface TimelineAttempt {
  readonly seq: number;
  readonly error: StepError;
}

/** One tool call of a step: what the model asked for, the failed attempts, and the result. */
export interface TimelineToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly attempts: readonly TimelineAttempt[];
  /** Missing while the call hasn't finished. */
  readonly result?: ToolResult;
  /** The `seq` of the event that journaled `result`. */
  readonly resultSeq?: number;
}

/** One step: a model call, and the tool calls its response asked for. */
export interface TimelineStep {
  /** From 1: the step's model call is the run's `step`-th. */
  readonly step: number;
  /** Failed attempts at the step's model call, in order. */
  readonly attempts: readonly TimelineAttempt[];
  /** Missing while the model hasn't answered, or if the run ended before it did. */
  readonly response?: ModelResponse;
  /** The `seq` of the event that journaled `response`. */
  readonly responseSeq?: number;
  /** In the order the model called them. */
  readonly tools: readonly TimelineToolCall[];
}

/** A run as its journal tells it, from {@link readRun}. */
export interface RunTimeline {
  /** The run's state after the last event read: the same fold a recovering run makes. */
  readonly state: RunState;
  readonly events: readonly TimelineEvent[];
  /** The events grouped by step, in step order. */
  readonly steps: readonly TimelineStep[];
}

/** Events per journal read. */
const PAGE = 256;
const KEYS = new Set(['upTo']);

/**
 * Reads a run back from `agent`'s journal: its state, its events and its steps. It never calls
 * the model or a tool, and needs no actor system, so it works on a run that's finished, one that's
 * running elsewhere, and one that crashed. Snapshots are skipped, so the state is exact at any
 * `upTo`.
 * @throws TypeError at once for a bad `runId` or bad options.
 * @returns A promise that rejects with a RangeError when `upTo` is past the journal's end.
 */
export function readRun(
  agent: Agent,
  runId: string,
  options: ReadRunOptions = {},
): Promise<RunTimeline> {
  const upTo = checkArgs(runId, options);
  return read(agent, runId, upTo);
}

function checkArgs(runId: unknown, options: unknown): number {
  if (typeof runId !== 'string' || runId === '') {
    throw new TypeError('readRun: runId must be a non-empty string');
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('readRun: options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (!KEYS.has(key)) throw new TypeError(`readRun: unknown option "${key}"`);
  }
  const { upTo } = options as { upTo?: unknown };
  if (upTo === undefined) return Infinity;
  if (typeof upTo !== 'number' || !Number.isSafeInteger(upTo) || upTo < 0) {
    throw new TypeError(
      `readRun: upTo must be a non-negative integer, got ${typeof upTo === 'number' ? String(upTo) : typeof upTo}`,
    );
  }
  return upTo;
}

async function read(agent: Agent, runId: string, upTo: number): Promise<RunTimeline> {
  const id = agent.persistenceId(runId);
  const events: TimelineEvent[] = [];
  let state = initialState;
  for (;;) {
    const want = Math.min(PAGE, upTo - events.length);
    if (want <= 0) break;
    const page = await agent.persistence.journal.read(id, events.length + 1, want);
    for (const stored of page) {
      const seq = events.length + 1;
      if (stored.seq !== seq) {
        throw new Error(
          `readRun: ${id} skips from event ${String(seq - 1)} to ${String(stored.seq)}`,
        );
      }
      // The run's events are its own and have no schema, as the run's recovery reads them.
      const event = stored.event as RunEvent;
      state = onEvent(state, event);
      events.push({ seq, timestamp: stored.timestamp, event });
    }
    if (page.length < want) break;
  }
  if (upTo !== Infinity && events.length < upTo) {
    throw new RangeError(
      `readRun: ${id} ends at event ${String(events.length)}, before ${String(upTo)}`,
    );
  }
  return { state, events, steps: stepsOf(events) };
}

interface DraftTool {
  callId: string;
  name: string;
  input: JsonValue;
  attempts: TimelineAttempt[];
  result?: ToolResult;
  resultSeq?: number;
}

interface DraftStep {
  step: number;
  attempts: TimelineAttempt[];
  response?: ModelResponse;
  responseSeq?: number;
  tools: DraftTool[];
}

/** Groups events by step. Every event but `runStarted` and `runFinished` names its step. */
function stepsOf(events: readonly TimelineEvent[]): TimelineStep[] {
  const steps = new Map<number, DraftStep>();
  const stepFor = (step: number): DraftStep => {
    let draft = steps.get(step);
    if (draft === undefined) {
      draft = { step, attempts: [], tools: [] };
      steps.set(step, draft);
    }
    return draft;
  };
  // A tool event for a call the step's response didn't make can't be journaled by the run, but a
  // reader shouldn't throw on a journal it didn't write, so such a call is added by its id.
  const toolFor = (draft: DraftStep, callId: string): DraftTool => {
    let call = draft.tools.find((t) => t.callId === callId);
    if (call === undefined) {
      call = { callId, name: '', input: null, attempts: [] };
      draft.tools.push(call);
    }
    return call;
  };
  for (const { seq, event } of events) {
    switch (event.type) {
      case 'modelResponded': {
        const draft = stepFor(event.step);
        draft.response = event.response;
        draft.responseSeq = seq;
        for (const call of event.response.toolCalls) {
          draft.tools.push({ callId: call.id, name: call.name, input: call.input, attempts: [] });
        }
        break;
      }
      case 'attemptFailed': {
        const draft = stepFor(event.step);
        const attempt = { seq, error: event.error };
        if (event.target.kind === 'model') draft.attempts.push(attempt);
        else toolFor(draft, event.target.callId).attempts.push(attempt);
        break;
      }
      case 'toolFinished': {
        const call = toolFor(stepFor(event.step), event.callId);
        call.result = event.result;
        call.resultSeq = seq;
        break;
      }
      case 'runStarted':
      case 'runFinished':
        break;
    }
  }
  return [...steps.values()].sort((a, b) => a.step - b.step);
}
