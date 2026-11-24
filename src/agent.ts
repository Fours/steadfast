// Agents: a model, a system prompt, tools and a budget, checked when they're defined. An agent's
// `run` gives the actor definition for one run, which callers spawn like any other actor.

import type { ActorDef, ActorRef } from '@kylewillett/troupe';
import type { Persistence, PersistentState } from '@kylewillett/troupe/persistence';
import type { Model } from './model.js';
import { runActor } from './run/actor.js';
import type { RunMsg, RunReport, RunState } from './run/types.js';
import type { Tool } from './tool.js';

/** Limits on one run. Every value is a positive integer. */
export interface Budget {
  /** Model calls per run. Default 50. */
  readonly maxSteps?: number;
  /** Input plus output tokens per run, as the model reports them. No default. */
  readonly maxTokens?: number;
  /** Wall-clock ms from the run's start, on the agent's clock. No default. */
  readonly deadlineMs?: number;
  /** Failed attempts at one model call or one tool call before giving up. Default 5. */
  readonly maxAttemptsPerStep?: number;
}

/** A budget with its defaults filled in. */
export interface CheckedBudget {
  readonly maxSteps: number;
  readonly maxTokens?: number;
  readonly deadlineMs?: number;
  readonly maxAttemptsPerStep: number;
}

/** What {@link agent} takes. */
export interface AgentOptions {
  /** Part of every run's journal stream id. Matches `^[a-zA-Z0-9_-]{1,64}$`. */
  readonly name: string;
  readonly model: Model;
  readonly system: string;
  /** Made by `tool()`. Names must be unique. */
  readonly tools?: readonly Tool[];
  readonly budget?: Budget;
  /** Troupe persistence: in-memory, SQLite or Postgres. The journal holds every run. */
  readonly persistence: Persistence;
  /** Wall-clock time in ms, for deadlines that survive restarts. Default: the real clock. */
  readonly clock?: () => number;
}

/** What {@link Agent.run} takes. */
export interface RunOptions {
  /** The run's input, used only when the journal has no events for the run. */
  readonly input: string;
  /** Told a {@link RunReport} when the run finishes, once per incarnation. */
  readonly reportTo?: ActorRef<RunReport>;
}

/** A checked agent, made by {@link agent}. */
export interface Agent {
  readonly name: string;
  readonly model: Model;
  readonly system: string;
  readonly tools: readonly Tool[];
  readonly budget: CheckedBudget;
  readonly persistence: Persistence;
  readonly clock: () => number;
  /** The journal stream a run's events are kept in: `run-<agent name>-<runId>`. */
  readonly persistenceId: (runId: string) => string;
  /**
   * The actor definition for one run. Spawning it starts the run if its journal is empty, and
   * resumes it from the journal if not. Spawn, name, watch and supervise it like any other actor.
   * A property rather than a method, so it can be passed around on its own.
   * @throws TypeError for a bad `runId` or bad options.
   */
  readonly run: (runId: string, options: RunOptions) => ActorDef<RunMsg, PersistentState<RunState>>;
}

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const KEYS = new Set(['name', 'model', 'system', 'tools', 'budget', 'persistence', 'clock']);
const BUDGET_KEYS = new Set(['maxSteps', 'maxTokens', 'deadlineMs', 'maxAttemptsPerStep']);
const RUN_KEYS = new Set(['input', 'reportTo']);
/** Troupe's limit on a persistence id. */
const MAX_ID_LENGTH = 255;

/** A bad option's value for an error message: a number or string as itself, anything else by type. */
function describe(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return value === null ? 'null' : typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function checkKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`${where}: unknown option "${key}"`);
  }
}

// The default wall clock, for a run's start and its deadline: the injected clock's default, and
// the one place src/ reads real time. Tests always pass their own.
// eslint-disable-next-line no-restricted-properties
const wallClock = (): number => Date.now();

/**
 * Defines an agent, checking it now so a bad one fails where it's written.
 * @throws TypeError for a missing or invalid option, unknown keys, or two tools with one name.
 * @throws RangeError for a budget value that isn't a positive integer.
 */
export function agent(options: AgentOptions): Agent {
  // The options' type can't stop untyped callers, or values built at runtime.
  const raw: unknown = options;
  if (!isObject(raw)) throw new TypeError('agent: give an options object');
  const { name } = raw;
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(`agent: name must match ${NAME.source}, got ${describe(name)}`);
  }
  const where = `agent "${name}"`;
  checkKeys(raw, KEYS, where);
  const { model } = raw;
  if (!isObject(model) || typeof model.name !== 'string' || typeof model.call !== 'function') {
    throw new TypeError(`${where}: model must be a Model, with a name and a call method`);
  }
  if (typeof raw.system !== 'string') throw new TypeError(`${where}: system must be a string`);
  const tools = checkTools(raw.tools ?? [], where);
  const budget = checkBudget(raw.budget ?? {}, where);
  const { persistence } = raw;
  if (
    !isObject(persistence) ||
    !isObject(persistence.journal) ||
    typeof persistence.journal.append !== 'function' ||
    typeof persistence.journal.read !== 'function'
  ) {
    throw new TypeError(`${where}: persistence must be a Troupe Persistence, with a journal`);
  }
  if (raw.clock !== undefined && typeof raw.clock !== 'function') {
    throw new TypeError(`${where}: clock must be a function`);
  }

  const persistenceId = (runId: string): string => `run-${name}-${runId}`;
  const checked: Agent = Object.freeze({
    name,
    model: options.model,
    system: options.system,
    tools,
    budget,
    persistence: options.persistence,
    clock: options.clock ?? wallClock,
    persistenceId,
    run: (runId: string, runOptions: RunOptions) => {
      checkRun(runId, runOptions, persistenceId, where);
      return runActor(checked, runId, runOptions);
    },
  });
  return checked;
}

function checkTools(value: unknown, where: string): readonly Tool[] {
  if (!Array.isArray(value)) throw new TypeError(`${where}: tools must be an array`);
  const seen = new Set<string>();
  for (const t of value as unknown[]) {
    // tool() fills in idempotent and timeoutMs, so a definition that skipped it is caught here.
    if (
      !isObject(t) ||
      typeof t.name !== 'string' ||
      typeof t.run !== 'function' ||
      typeof t.idempotent !== 'boolean' ||
      typeof t.timeoutMs !== 'number'
    ) {
      throw new TypeError(`${where}: tools must be made by tool()`);
    }
    if (seen.has(t.name)) throw new TypeError(`${where}: two tools are named "${t.name}"`);
    seen.add(t.name);
  }
  return Object.freeze([...(value as Tool[])]);
}

function checkBudget(value: unknown, where: string): CheckedBudget {
  if (!isObject(value)) throw new TypeError(`${where}: budget must be an object`);
  checkKeys(value, BUDGET_KEYS, `${where}: budget`);
  for (const key of BUDGET_KEYS) {
    const v = value[key];
    if (v !== undefined && !(typeof v === 'number' && Number.isSafeInteger(v) && v > 0)) {
      throw new RangeError(
        `${where}: budget.${key} must be a positive integer, got ${describe(v)}`,
      );
    }
  }
  const b = value as Budget;
  return Object.freeze({
    maxSteps: b.maxSteps ?? 50,
    ...(b.maxTokens === undefined ? {} : { maxTokens: b.maxTokens }),
    ...(b.deadlineMs === undefined ? {} : { deadlineMs: b.deadlineMs }),
    maxAttemptsPerStep: b.maxAttemptsPerStep ?? 5,
  });
}

function checkRun(
  runId: unknown,
  options: unknown,
  persistenceId: (runId: string) => string,
  where: string,
): void {
  if (typeof runId !== 'string' || runId === '') {
    throw new TypeError(`${where}: runId must be a non-empty string, got ${describe(runId)}`);
  }
  if (persistenceId(runId).length > MAX_ID_LENGTH) {
    throw new TypeError(
      `${where}: runId is too long: its stream id must be at most ${String(MAX_ID_LENGTH)} characters`,
    );
  }
  if (!isObject(options)) throw new TypeError(`${where}: run options must be an object`);
  checkKeys(options, RUN_KEYS, `${where}: run`);
  if (typeof options.input !== 'string') {
    throw new TypeError(`${where}: input must be a string, got ${describe(options.input)}`);
  }
  const { reportTo } = options;
  if (reportTo !== undefined && !(isObject(reportTo) && typeof reportTo.tell === 'function')) {
    throw new TypeError(`${where}: reportTo must be an actor ref`);
  }
}
