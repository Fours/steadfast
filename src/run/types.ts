// The run's protocol, events and state (the spec's "The run's protocol" and "Events and state").
// Events are facts about the outside world, and the state is their fold. Every field is a JSON
// value, since Troupe journals events and snapshots state.

import type { ActorRef } from '@kylewillett/troupe';
import type { JsonValue } from '../json.js';
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

/**
 * Limits a run starts with from whoever started it, on top of its agent's budget. A sub-run gets
 * them from its parent, so it can't outlive or outspend it. Journaled in `runStarted`, so a restart
 * keeps them.
 */
export interface RunLimits {
  /**
   * Wall-clock ms, on the agent's clock. The run's deadline is the earlier of this and its own.
   * Agents in one tree should share a clock, since a parent's deadline is read on its sub-agent's.
   */
  readonly deadlineAt?: number;
  /** Tokens for the whole tree under this run. The run's budget is the smaller of this and its own. */
  readonly maxTokens?: number;
  /** How many more levels of sub-runs may start under this one. Default: the agent's maxDepth. */
  readonly depthLeft?: number;
}

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
      /** The limits the run was started with. Missing when there were none. */
      readonly limits?: RunLimits;
    }
  | { readonly type: 'modelResponded'; readonly step: number; readonly response: ModelResponse }
  | {
      readonly type: 'toolFinished';
      readonly step: number;
      readonly callId: string;
      readonly result: ToolResult;
      /** A delegation's: everything its sub-run's tree used. */
      readonly usage?: Usage;
    }
  | {
      readonly type: 'attemptFailed';
      readonly step: number;
      readonly target: StepTarget;
      readonly error: StepError;
    }
  /**
   * A call needs a person's approval, journaled with the response that made it, so the wait
   * survives any restart (decision 0007). Tagged `steadfast.approval`.
   */
  | {
      readonly type: 'approvalRequested';
      /** The run it's in, so an inbox built on the tag can send `decide` to it. */
      readonly runId: string;
      readonly step: number;
      readonly callId: string;
      readonly tool: string;
      /** The model's input, as it came. */
      readonly input: JsonValue;
      /** Wall-clock ms from the agent's clock, which a timeout is measured from. */
      readonly requestedAt: number;
      readonly timeoutMs?: number;
    }
  /** What became of a request: a person's decision, or a timeout. Tagged `steadfast.approval`. */
  | {
      readonly type: 'approvalDecided';
      readonly step: number;
      readonly callId: string;
      readonly approved: boolean;
      /** Who decided, as the caller said. `timeout` when nobody did in time. */
      readonly by: string;
      readonly note?: string;
      /** Wall-clock ms from the agent's clock. */
      readonly decidedAt: number;
      readonly timedOut?: true;
    }
  | { readonly type: 'runFinished'; readonly outcome: Outcome; readonly text: string };

/** Where one of the current step's calls stands with its approval. */
export interface Approval {
  readonly status: 'waiting' | 'approved' | 'denied';
  readonly requestedAt: number;
  readonly timeoutMs?: number;
}

/** A call waiting for a person's decision, as `status` reports it. */
export interface PendingApproval {
  /** The run the call is in: give it to `decide`. */
  readonly runId: string;
  readonly step: number;
  readonly callId: string;
  readonly tool: string;
  readonly input: JsonValue;
  readonly requestedAt: number;
  readonly timeoutMs?: number;
}

/** A sub-run: its agent's name and its run id. */
export interface SubRun {
  readonly agent: string;
  readonly runId: string;
}

/** What `decide` replies with. */
export type DecideReply =
  | { readonly ok: true }
  /**
   * `notWaiting`: the call isn't waiting for a decision, because it was decided already, timed
   * out, finished with its run, or was never asked about. `unknownRun`: no live run in this tree
   * has the id.
   */
  | { readonly ok: false; readonly reason: 'notWaiting' | 'unknownRun' };

/** A run's state: the fold of its events. */
export interface RunState {
  readonly phase: 'new' | 'running' | 'finished';
  readonly input: string;
  readonly startedAt: number;
  /** What the model sees: the input, each response, and each batch of tool results. */
  readonly transcript: readonly Turn[];
  /** The limits the run started with: `{}` for none. */
  readonly limits: RunLimits;
  /** Model calls answered so far. */
  readonly step: number;
  /** What the run's own model calls used. */
  readonly usage: Usage;
  /** What the run and every finished sub-run under it used. `maxTokens` is checked against it. */
  readonly treeUsage: Usage;
  /** What the run is waiting on. */
  readonly pending: Pending;
  /**
   * The current step's tool results so far, in the order they finished. Once the last one is in,
   * they join the transcript as one turn, in call order, and this empties.
   */
  readonly stepResults: readonly { readonly callId: string; readonly result: ToolResult }[];
  /** The current step's approvals, by call id. Empty when nothing in the step needed one. */
  readonly approvals: Readonly<Record<string, Approval>>;
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
  readonly treeUsage: Usage;
  readonly pending: Pending;
  /** The run's own calls waiting for a decision. A sub-run's are in its own status. */
  readonly approvals: readonly PendingApproval[];
  /** The sub-runs working for the run now. */
  readonly subRuns: readonly SubRun[];
  readonly outcome?: Outcome;
}

/** What a finished run tells its `reportTo`, once per incarnation. */
export interface RunReport {
  readonly type: 'runFinished';
  readonly runId: string;
  readonly outcome: Outcome;
  readonly text: string;
  /** What the run's own model calls used. */
  readonly usage: Usage;
  /** What the run and every sub-run under it used. */
  readonly treeUsage: Usage;
}

/**
 * What a run tells its `progressTo` as it goes (decision 0009). Every message names the run it's
 * from, since a tree's runs will share one ref.
 */
export type RunProgress =
  /**
   * An event, after it's written, with the `seq` the journal gave it. Each one is told once, in
   * journal order, so a gap in a run's `seq`s means a message was lost, and `readRun` fills it.
   */
  | {
      readonly type: 'journaled';
      readonly runId: string;
      readonly seq: number;
      readonly event: RunEvent;
    }
  /**
   * Model text as it's generated, for a preview. Never journaled or replayed: the response's text
   * is journaled when it's whole. `attempt` starts at 1 and goes up when the call is tried again,
   * so a listener can clear what a failed attempt showed.
   */
  | {
      readonly type: 'text';
      readonly runId: string;
      readonly step: number;
      readonly attempt: number;
      readonly text: string;
    }
  /**
   * The run has been spawned and has recovered its journal up to `seq`, 0 for a new run. Told
   * first, on every spawn, so a listener knows where it joins. Events up to `seq` come from
   * `readRun`.
   */
  | { readonly type: 'resumed'; readonly runId: string; readonly seq: number };

/**
 * What the model-call child found about one of the response's calls that may need approval: that
 * a person must be asked, or that its input failed the tool's `parse`, so it's an error result
 * and nobody is asked. A call it says nothing about starts at once.
 */
export type ApprovalCheckResult =
  | { readonly callId: string; readonly ask: true }
  | { readonly callId: string; readonly invalid: string };

/** The model's answer for a step, from the model-call child. */
export interface ModelReplied {
  readonly type: 'modelReplied';
  readonly step: number;
  readonly response: ModelResponse;
  /** What the child found about calls that may need approval. Missing when none might. */
  readonly approvals?: readonly ApprovalCheckResult[];
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
 * child carries its step, or a sub-run's id, and the run ignores one for a call it isn't waiting on.
 */
export type RunMsg =
  | { readonly type: 'status'; readonly replyTo: ActorRef<RunStatus> }
  /** Finishes the run with `cancelled`, and stops its children. A finished run ignores it. */
  | { readonly type: 'cancel'; readonly reason: string }
  /**
   * A person's decision on a call waiting for approval. Send it to the root: a run forwards it to
   * the sub-run `runId` is in. The first decision wins (decision 0007).
   */
  | {
      readonly type: 'decide';
      /** The run the call is in, from the request. */
      readonly runId: string;
      readonly callId: string;
      readonly approved: boolean;
      /** Who decided, for the journal. */
      readonly by: string;
      readonly note?: string;
      readonly replyTo?: ActorRef<DecideReply>;
    }
  /** A call's approval timer. */
  | { readonly type: 'approvalTimedOut'; readonly step: number; readonly callId: string }
  /** Sent to itself when recovery finds no events, so starting is a command that persists. */
  | { readonly type: 'start' }
  /** The deadline timer, or a recovery that finds the deadline already past. */
  | { readonly type: 'deadline' }
  | ModelReplied
  | ModelFailed
  | ToolReturned
  | AttemptFailed
  /** A sub-run's report, which is its delegation's result. */
  | RunReport;

/** The key `attempts` counts a step's target under. */
export function attemptKey(step: number, target: StepTarget): string {
  return target.kind === 'model'
    ? `${String(step)}:model`
    : `${String(step)}:tool:${target.callId}`;
}
