// Approvals, derived (decision 0007). Which of a response's calls a person must be asked about is
// decided once, by the model-call child when the response arrives, and journaled with it. From
// then on, what a call is waiting on is read from the state, never from the tool's definition, so
// a run recovered with different code behaves as it did.

import type { JsonValue } from '../json.js';
import type { ModelResponse, ToolCall } from '../model.js';
import { checkInput } from '../steps/tool-call.js';
import type { Tool } from '../tool.js';
import { wantsTools } from './state.js';
import type { ApprovalCheckResult, PendingApproval, RunState } from './types.js';

/** The tag on every approval event, for an inbox's projection. */
export const APPROVAL_TAG = 'steadfast.approval';
/** Who `approvalDecided` names when nobody decided in time. */
export const TIMEOUT_BY = 'timeout';

/** The key of a call's approval timer. Call ids are unique within a step, and timers end with it. */
export function approvalTimer(callId: string): string {
  return `approval:${callId}`;
}

/** What the model is told when a person denies a call. */
export function denied(by: string, note: string | undefined): string {
  return `A person denied this call. ${by}: ${note ?? '(no note)'}`;
}

/** What the model is told when nobody decided on a call in time. */
export function timedOut(timeoutMs: number): string {
  return `Nobody decided on this call within ${String(timeoutMs)} ms, so it was denied.`;
}

/**
 * Checks each of `response`'s calls that may need approval: parses its input, and asks its tool's
 * `needsApproval`. Returns undefined when no call might need it, so most responses go on at once.
 * Never rejects. A function that throws, or returns anything but `false`, means asking.
 */
export function checkApprovals(
  tools: ReadonlyMap<string, Tool>,
  response: ModelResponse,
): Promise<readonly ApprovalCheckResult[]> | undefined {
  if (!wantsTools(response)) return undefined;
  const checks = response.toolCalls.flatMap((call) => {
    const t = tools.get(call.name);
    // An unknown tool or an unreadable input is an error result anyway: nobody is asked.
    if (t === undefined || call.inputError !== undefined || t.needsApproval === false) return [];
    return [check(t, call)];
  });
  if (checks.length === 0) return undefined;
  return Promise.all(checks).then((results) => results.filter((r) => r !== undefined));
}

async function check(t: Tool, call: ToolCall): Promise<ApprovalCheckResult | undefined> {
  let input: JsonValue = call.input;
  if (t.delegatesTo !== undefined) {
    // A delegation's task that isn't a string fails as the sub-run's plan says. Nobody is asked.
    if (!hasTask(call.input)) return undefined;
  } else {
    const checked = await checkInput(t, call.input);
    if (!checked.ok) return { callId: call.id, invalid: checked.error };
    input = checked.value;
  }
  const { needsApproval } = t;
  if (needsApproval === true) return { callId: call.id, ask: true };
  if (needsApproval === false) return undefined;
  try {
    // Untyped callers can return anything, and only a plain `false` is safe to skip asking on.
    const answer: unknown = needsApproval(input);
    return answer === false ? undefined : { callId: call.id, ask: true };
  } catch {
    // Asking is the safe answer.
    return { callId: call.id, ask: true };
  }
}

function hasTask(input: JsonValue): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  return typeof (input as { readonly [key: string]: JsonValue }).task === 'string';
}

/** The current step's calls waiting for a decision, in call order, for `status`. */
export function pendingApprovals(state: RunState, runId: string): PendingApproval[] {
  const last = state.transcript.at(-1);
  const calls = last?.role === 'assistant' ? last.response.toolCalls : [];
  return calls.flatMap((call) => {
    const approval = state.approvals[call.id];
    if (state.phase !== 'running' || approval?.status !== 'waiting') return [];
    return [
      {
        runId,
        step: state.step,
        callId: call.id,
        tool: call.name,
        input: call.input,
        requestedAt: approval.requestedAt,
        ...(approval.timeoutMs === undefined ? {} : { timeoutMs: approval.timeoutMs }),
      },
    ];
  });
}

/** Whether the current step's call `callId` is waiting for a decision. */
export function isWaiting(state: RunState, callId: string): boolean {
  return (
    state.phase === 'running' &&
    state.pending.kind === 'tools' &&
    state.approvals[callId]?.status === 'waiting'
  );
}
