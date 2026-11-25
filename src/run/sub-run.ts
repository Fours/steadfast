// Sub-runs, derived (decision 0006). A delegation's sub-run id, actor name and input all come from
// the parent's journal and definitions, never from a choice the parent made, so a recovering
// parent finds the same sub-run, and `readRun` can name it without asking anyone. Pure, so the run
// and `readRun` derive them the same way.

import type { Agent } from '../agent.js';
import type { JsonValue } from '../json.js';
import type { ToolCall, ToolResult } from '../model.js';
import type { Tool } from '../tool.js';
import type { RunReport } from './types.js';

/** Troupe's actor name pattern, which a provider's call id must fit to name a child. */
export const ACTOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;
/** Troupe's limit on a persistence id. */
const MAX_ID_LENGTH = 255;

/** What a delegation call comes to: a sub-run to start, or an error result for the model. */
export type SubRunPlan =
  | { readonly kind: 'start'; readonly agent: Agent; readonly runId: string; readonly task: string }
  | { readonly kind: 'error'; readonly error: string };

/** A sub-run's id: `<parent run id>/<step>.<index>`, where `index` is the call's place in the response. */
export function subRunId(runId: string, step: number, index: number): string {
  return `${runId}/${String(step)}.${String(index)}`;
}

/**
 * A sub-run's actor name under its parent. As for a tool-call child, the call id is in it when it
 * fits Troupe's name rules, falling back to the call's place in the response after a `~`.
 */
export function subRunChildName(step: number, callId: string, index: number): string {
  const name = `sub-${String(step)}-${callId}`;
  return ACTOR_NAME.test(name) ? name : `sub-${String(step)}~${String(index)}`;
}

/**
 * What the delegation `call`, the `index`-th of `step`'s response in run `runId`, comes to, with
 * `depthLeft` levels of sub-runs still allowed under the run. Every reason not to start is decided
 * by the journal and the definitions alone, so a recovering run decides the same.
 */
export function planSubRun(
  tool: Tool & { readonly delegatesTo: Agent },
  call: ToolCall,
  runId: string,
  step: number,
  index: number,
  depthLeft: number,
): SubRunPlan {
  const error = (message: string): SubRunPlan => ({ kind: 'error', error: message });
  if (call.inputError !== undefined) {
    return error(`Invalid input for ${tool.name}: ${call.inputError}`);
  }
  const { input } = call;
  const task = isRecord(input) ? input.task : undefined;
  if (typeof task !== 'string') {
    return error(`Invalid input for ${tool.name}: task must be a string`);
  }
  if (depthLeft <= 0) {
    return error(`${tool.name} can't start: this run can't delegate any further.`);
  }
  const agent = tool.delegatesTo;
  const id = subRunId(runId, step, index);
  if (agent.persistenceId(id).length > MAX_ID_LENGTH) {
    return error(`${tool.name} can't start: the tree of runs is too deep for another sub-run.`);
  }
  return { kind: 'start', agent, runId: id, task };
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `tool` was made by `delegate()`. */
export function isDelegation(tool: Tool): tool is Tool & { readonly delegatesTo: Agent } {
  return tool.delegatesTo !== undefined;
}

/** A sub-run's report as its delegation's result, so the model hears how it ended. */
export function delegationResult(report: RunReport): ToolResult {
  if (report.outcome === 'completed') return { ok: true, output: report.text };
  return { ok: false, error: `The sub-agent stopped: ${report.outcome}. ${report.text}` };
}
