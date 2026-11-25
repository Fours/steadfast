// The run's protocol, events and state (the spec's "The run's protocol" and "Events and state").
// Events are facts about the outside world, and the state is their fold. Every field is a JSON
// value, since Troupe journals events and snapshots state.

import type { ActorRef } from '@kylewillett/troupe';
import type { ModelResponse, ToolResult, Turn, Usage } from '../model.js';
import type { AttemptFailed, StepError, StepTarget, ToolReturned } from '../steps/messages.js';

export type { StepError, StepTarget } from '../steps/messages.js';

/** How a run ended. */
export type Outcome =
  | 'completed'
  | 'refused'
  | 'maxOutputTokens'
  | 'stepsExceeded'
  | 'tokensExceeded'
  | 'deadlineExceeded'
  | 'cancelled'
  | 'failed';

/** What the run is waiting on, derived from its events and never journaled on its own. */
export type Pending =
  | { readonly kind: 'model' }
  | { readonly kind: 'tools'; readonly callIds: readonly string[] }
  | { readonly kind: 'none' };

/** The run's journal: facts it learned, never what it meant to do (decision 0001). */
export type RunEvent =
  | {
      readonly type: 'runStarted';
      readonly agent: string;
      readonly model: string;
      readonly input: string;
      /** Wall-clock ms from the agent's clock, so a deadline means something after a restart. */
      readonly startedAt: number;
    }
  | { readonly type: 'modelResponded'; readonly step: number; readonly response: ModelResponse }
  | {
      readonly type: 'toolFinished';
      readonly step: number;
      readonly callId: string;
      readonly result: ToolResult;
    }
  | {
      readonly type: 'attemptFailed';
      readonly step: number;
      readonly target: StepTarget;
      readonly error: StepError;
    }
  | { readonly type: 'runFinished'; readonly outcome: Outcome; readonly text: string };

/** A run's state: the fold of its events. */
export interface RunState {
  readonly phase: 'new' | 'running' | 'finished';
  readonly input: string;
  readonly startedAt: number;
  /** What the model sees: the input, each response, and each batch of tool results. */
  readonly transcript: readonly Turn[];
  /** Model calls answered so far. */
  readonly step: number;
  readonly usage: Usage;
  /** What the run is waiting on. */
  readonly pending: Pending;
  /**
   * The current step's tool results so far, in the order they finished. Once the last one is in,
   * they join the transcript as one turn, in call order, and this empties.
   */
  readonly stepResults: readonly { readonly callId: string; readonly result: ToolResult }[];
  /** Failed attempts so far, keyed by {@link attemptKey}. */
  readonly attempts: Readonly<Record<string, number>>;
  readonly outcome?: Outcome;
  readonly text?: string;
}

/** What `status` replies with. */
export interface RunStatus {
  readonly phase: RunState['phase'];
  readonly step: number;
  readonly usage: Usage;
  readonly pending: Pending;
  readonly outcome?: Outcome;
}

/** What a finished run tells its `reportTo`, once per incarnation. */
export interface RunReport {
  readonly type: 'runFinished';
  readonly runId: string;
  readonly outcome: Outcome;
  readonly text: string;
  readonly usage: Usage;
}

/** The model's answer for a step, from the model-call child. */
export interface ModelReplied {
  readonly type: 'modelReplied';
  readonly step: number;
  readonly response: ModelResponse;
}

/** The model call failed in a way that trying again won't fix. */
export interface ModelFailed {
  readonly type: 'modelFailed';
  readonly step: number;
  readonly error: StepError;
}

/** What a model-call child tells its parent. */
export type ModelCallReport = ModelReplied | ModelFailed | AttemptFailed;

/**
 * The run's messages. `status` and `cancel` are for callers. The rest are internal, sent by the run
 * itself, its children and its timers, and exported so the type is complete. Each message from a
 * child carries its step, and the run ignores one for a step it's no longer on.
 */
export type RunMsg =
  | { readonly type: 'status'; readonly replyTo: ActorRef<RunStatus> }
  /** Finishes the run with `cancelled`, and stops its children. A finished run ignores it. */
  | { readonly type: 'cancel'; readonly reason: string }
  /** Sent to itself when recovery finds no events, so starting is a command that persists. */
  | { readonly type: 'start' }
  /** The deadline timer, or a recovery that finds the deadline already past. */
  | { readonly type: 'deadline' }
  | ModelReplied
  | ModelFailed
  | ToolReturned
  | AttemptFailed;

/** The key `attempts` counts a step's target under. */
export function attemptKey(step: number, target: StepTarget): string {
  return target.kind === 'model'
    ? `${String(step)}:model`
    : `${String(step)}:tool:${target.callId}`;
}
