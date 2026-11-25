// Delegation: a tool made from an agent (decision 0006). The model sees an ordinary tool that
// takes a task. The run sees `delegatesTo`, and starts a sub-run of that agent, as a persistent
// child with a journal of its own, instead of calling the tool's `run`.

import { isAgent, type Agent } from './agent.js';
import { tool, type Tool } from './tool.js';

/** What {@link delegate} takes. */
export interface DelegateOptions {
  /** The tool's name, as the model sees it. Default: the agent's name, with `-` as `_`. */
  readonly name?: string;
  /** What the agent can do, for the model, such as the kind of task to give it. */
  readonly description: string;
}

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const KEYS = new Set(['name', 'description']);

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
  const made = tool({
    name,
    description: o.description,
    input: INPUT,
    // The run never calls it: a delegation is a sub-run. Called directly, it says so.
    run: () =>
      Promise.reject(
        new Error(`${name} delegates to "${agent.name}": a run starts it as a sub-run`),
      ),
  });
  return Object.freeze({ ...made, delegatesTo: agent });
}
