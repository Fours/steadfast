// Tools: what an agent can do in the outside world. A tool is checked when it's defined, so a bad
// definition fails at startup rather than in the middle of a run. Running one is the tool-call
// child's job (src/steps/tool-call.ts), never the run's (decision 0002).

import type { StandardSchemaV1 } from '@kylewillett/troupe/persistence';
import { jsonProblem, type JsonValue } from './json.js';
import type { JsonSchemaObject } from './model.js';

/** What a tool's `run` gets besides its input. */
export interface ToolContext {
  readonly runId: string;
  readonly callId: string;
  /**
   * `<runId>:<step>:<callId>`: the same on every attempt of this call, across restarts. Pass it to
   * APIs that dedupe, so a retried call doesn't act twice.
   */
  readonly idempotencyKey: string;
  /** Aborted on timeout, on cancel, and when the run stops. */
  readonly signal: AbortSignal;
}

/**
 * A tool's definition, as it's passed to {@link tool}.
 *
 * `I` is the input `run` gets. With `parse`, it's the schema's output, and the model's input is
 * checked before `run` sees it. Without `parse`, it's whatever `run` is annotated with, and it's
 * unchecked: the model's input arrives as it came.
 */
export interface ToolDef<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue> {
  /** Unique within an agent. Matches `^[a-zA-Z0-9_-]{1,64}$`. */
  readonly name: string;
  /** What the tool does, for the model. */
  readonly description: string;
  /** JSON Schema for the input, sent to the model as written. */
  readonly input: JsonSchemaObject;
  /** Optional runtime check of the model's input, as a Standard Schema (Troupe's 0018). */
  readonly parse?: StandardSchemaV1<unknown, I>;
  /**
   * Safe to run twice with the same input. Default false. An idempotent tool is retried after a
   * failure, a timeout or a crash. One that isn't runs at most once (decision 0003).
   */
  readonly idempotent?: boolean;
  /**
   * How long one attempt may take, in integer ms. Default 60,000. A call that takes longer is
   * aborted. An idempotent tool then retries. One that isn't reports that it may or may not have
   * run, since it may have acted before the timeout.
   */
  readonly timeoutMs?: number;
  /**
   * Does the work. A failure is reported by throwing. The output must be a JSON value, since it's
   * journaled: it's checked before it's written.
   */
  run(input: I, ctx: ToolContext): Promise<O>;
}

/** A checked tool definition, with its defaults filled in. Made by {@link tool}. */
export interface Tool<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> extends ToolDef<I, O> {
  readonly idempotent: boolean;
  readonly timeoutMs: number;
}

/**
 * Thrown by a tool to say "nothing happened, try me again", for example when a request was refused
 * before it was sent. It lets a tool that isn't idempotent be retried like one that is.
 */
export class RetryableToolError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'RetryableToolError';
  }
}

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const KEYS = new Set(['name', 'description', 'input', 'parse', 'idempotent', 'timeoutMs', 'run']);

/** A bad option's value for an error message: a number or string as itself, anything else by type. */
function describe(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return value === null ? 'null' : typeof value;
}

/**
 * Defines a tool, checking it now so a bad one fails where it's written.
 * @throws TypeError for a missing or invalid `name`, `description`, `input`, `parse`,
 * `idempotent` or `run`, and for unknown keys, which are most likely typos.
 * @throws RangeError if `timeoutMs` isn't a positive integer.
 */
export function tool<I extends JsonValue, O extends JsonValue>(def: ToolDef<I, O>): Tool<I, O> {
  // The definition's type can't stop untyped callers, or values built at runtime.
  const raw: unknown = def;
  if (typeof raw !== 'object' || raw === null)
    throw new TypeError('tool: give a definition object');
  const d = raw as Record<string, unknown>;
  const name = d.name;
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(`tool: name must match ${NAME.source}, got ${describe(name)}`);
  }
  const where = `tool "${name}"`;
  for (const key of Object.keys(d)) {
    if (!KEYS.has(key)) throw new TypeError(`${where}: unknown option "${key}"`);
  }
  if (typeof d.description !== 'string' || d.description.trim() === '') {
    throw new TypeError(`${where}: description must be a non-empty string`);
  }
  const input = d.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${where}: input must be a JSON Schema object`);
  }
  if ((input as Record<string, unknown>).type !== 'object') {
    throw new TypeError(`${where}: input must have type "object", as providers require`);
  }
  const problem = jsonProblem(input);
  if (problem !== undefined) {
    throw new TypeError(`${where}: input must be JSON, since it's sent to the model: ${problem}`);
  }
  if (d.parse !== undefined && !isStandardSchema(d.parse)) {
    throw new TypeError(`${where}: parse must be a Standard Schema`);
  }
  if (d.idempotent !== undefined && typeof d.idempotent !== 'boolean') {
    throw new TypeError(`${where}: idempotent must be a boolean, got ${describe(d.idempotent)}`);
  }
  const timeoutMs = d.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `${where}: timeoutMs must be a positive integer, got ${describe(timeoutMs)}`,
    );
  }
  if (typeof d.run !== 'function') throw new TypeError(`${where}: run must be a function`);

  const checked: Tool<I, O> = {
    name: def.name,
    description: def.description,
    input: def.input,
    ...(def.parse === undefined ? {} : { parse: def.parse }),
    idempotent: def.idempotent ?? false,
    timeoutMs,
    // A wrapper rather than the method itself, so `run` keeps `def` as its `this`.
    run: (input, ctx) => def.run(input, ctx),
  };
  return Object.freeze(checked);
}

function isStandardSchema(value: unknown): boolean {
  // Some libraries' schemas are functions, such as ArkType's.
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) return false;
  const props = (value as Record<string, unknown>)['~standard'];
  return (
    typeof props === 'object' &&
    props !== null &&
    typeof (props as Record<string, unknown>).validate === 'function'
  );
}
