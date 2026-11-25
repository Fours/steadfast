// Delegation: a tool made from an agent (decision 0006). The model sees an ordinary tool that
// takes a task. The run sees `delegatesTo`, and starts a sub-run of that agent, as a persistent
// child with a journal of its own, instead of calling the tool's `run`.

import { isAgent, type Agent } from './agent.js';
import type { JsonValue } from './json.js';
import { checkApproval, tool, type ApprovalCheck, type Tool } from './tool.js';

/** What {@link delegate} takes. */
export interface DelegateOptions {
  /** The tool's name, as the model sees it. Default: the agent's name, with `-` as `_`. */
  readonly name?: string;
  /** What the agent can do, for the model, such as the kind of task to give it. */
  readonly description: string;
  /**
   * Whether a person must approve each delegation before its sub-run starts, as on a tool: `true`,
   * `false` (the default), or a function of the call's input (decision 0007).
   */
  readonly needsApproval?: boolean | ApprovalCheck<{ readonly task: string }>;
  /** How long a delegation may wait for a decision, in integer ms, as on a tool. */
  readonly approvalTimeoutMs?: number;
}

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const KEYS = new Set(['name', 'description', 'needsApproval', 'approvalTimeoutMs']);

/** The tool's input: one string, which becomes the sub-run's input. Fixed, so it's always one. */
const INPUT = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'The task, in full: the sub-agent sees nothing else.' },
  },
  required: ['task'],
  additionalProperties: false,
} as const;

/**
 * Makes a tool from an agent. When the model calls it, the run starts a sub-run of `agent` with the
 * call's `task` as its input, under limits handed down from the run, and the sub-run's report is
 * the call's result. A sub-run that's interrupted resumes from its journal: it's never retried or
 * reported as interrupted.
 * @throws TypeError for an `agent` not made by `agent()`, or a missing, invalid or unknown option.
 * @throws RangeError if `approvalTimeoutMs` isn't a positive integer.
 */
export function delegate(agent: Agent, options: DelegateOptions): Tool {
  // The arguments' types can't stop untyped callers, or values built at runtime.
  if (!isAgent(agent)) throw new TypeError('delegate: agent must be made by agent()');
  const raw: unknown = options;
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError(`delegate "${agent.name}": give an options object`);
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!KEYS.has(key)) throw new TypeError(`delegate "${agent.name}": unknown option "${key}"`);
  }
  const name = o.name ?? agent.name.replaceAll('-', '_');
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(
      `delegate "${agent.name}": name must match ${NAME.source}, got ${typeof name === 'string' ? JSON.stringify(name) : typeof name}`,
    );
  }
  if (typeof o.description !== 'string' || o.description.trim() === '') {
    throw new TypeError(`delegate "${agent.name}": description must be a non-empty string`);
  }
  const where = `delegate "${agent.name}"`;
  checkApproval(o.needsApproval, o.approvalTimeoutMs, where);
  const made = tool<JsonValue, JsonValue>({
    name,
    description: o.description,
    input: INPUT,
    // The run asks only about a call whose task is a string, so the function gets one.
    ...(options.needsApproval === undefined ? {} : { needsApproval: options.needsApproval }),
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: options.approvalTimeoutMs }),
    // The run never calls it: a delegation is a sub-run. Called directly, it says so.
    run: () =>
      Promise.reject(
        new Error(`${name} delegates to "${agent.name}": a run starts it as a sub-run`),
      ),
  });
  return Object.freeze({ ...made, delegatesTo: agent });
}
