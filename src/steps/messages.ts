// What a step's child tells the run. These are the internal cases of the run's protocol, so the
// run can take them straight from its children. Every field is a JSON value, since the run
// journals what it's told.

import type { ToolResult } from '../model.js';

/** What a failed attempt was trying to do: the step's model call, or one of its tool calls. */
export type StepTarget =
  { readonly kind: 'model' } | { readonly kind: 'tool'; readonly callId: string };

/** Why an attempt failed, as it's journaled. */
export interface StepError {
  readonly message: string;
}

/** A tool call's result, final for this call: it won't be tried again. */
export interface ToolReturned {
  readonly type: 'toolReturned';
  readonly step: number;
  readonly callId: string;
  readonly result: ToolResult;
}

/** An attempt failed in a way worth retrying. The child is about to throw, and be restarted. */
export interface AttemptFailed {
  readonly type: 'attemptFailed';
  readonly step: number;
  readonly target: StepTarget;
  readonly error: StepError;
}

/** What a tool-call child tells its parent. */
export type ToolCallReport = ToolReturned | AttemptFailed;
