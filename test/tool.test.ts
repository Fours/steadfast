import type { StandardSchemaV1 } from '@kylewillett/troupe/persistence';
import { describe, expect, it } from 'vitest';
import { RetryableToolError, tool, type ToolDef } from '../src/index.ts';

const valid: ToolDef = {
  name: 'read_log',
  description: 'Read the last lines of a service log.',
  input: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
  run: () => Promise.resolve('ok'),
};

/** `valid` with `changes` applied, typed loosely, as an untyped caller would pass it. */
function withChanges(changes: Record<string, unknown>): ToolDef {
  return { ...valid, ...changes };
}

const passThrough: StandardSchemaV1<unknown, string> = {
  '~standard': { version: 1, vendor: 'test', validate: () => ({ value: 'x' }) },
};

describe('tool', () => {
  it('fills in the defaults: not idempotent, and a 60 s timeout', () => {
    const t = tool(valid);
    expect(t).toMatchObject({ name: 'read_log', idempotent: false, timeoutMs: 60_000 });
    expect('parse' in t).toBe(false);
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('keeps what it was given', () => {
    const t = tool({ ...valid, idempotent: true, timeoutMs: 10_000, parse: passThrough });
    expect(t).toMatchObject({ idempotent: true, timeoutMs: 10_000, parse: passThrough });
    expect(t.input).toBe(valid.input);
  });

  it('calls run with the definition as its this', async () => {
    const def: ToolDef = {
      ...valid,
      run() {
        return Promise.resolve(this === def);
      },
    };
    const signal = new AbortController().signal;
    const ctx = { runId: 'r', callId: 'c', idempotencyKey: 'r:1:c', signal };
    await expect(tool(def).run('x', ctx)).resolves.toBe(true);
  });

  it('accepts a Standard Schema that is a function, as some libraries make them', () => {
    const fn = Object.assign(() => undefined, { '~standard': passThrough['~standard'] });
    expect(() => tool({ ...valid, parse: fn })).not.toThrow();
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a name with a space', { name: 'read log' }],
    ['a name with a dot', { name: 'read.log' }],
    ['a name of 65 characters', { name: 'a'.repeat(65) }],
    ['a name that is not a string', { name: 42 }],
  ])('throws on %s', (_, changes) => {
    expect(() => tool(withChanges(changes))).toThrow(/^tool: name must match/);
  });

  it('accepts a name of 64 characters', () => {
    expect(() => tool({ ...valid, name: 'a'.repeat(64) })).not.toThrow();
  });

  it.each([
    ['a missing description', { description: undefined }],
    ['an empty description', { description: '' }],
    ['a blank description', { description: '   ' }],
    ['a description that is not a string', { description: 7 }],
  ])('throws on %s', (_, changes) => {
    expect(() => tool(withChanges(changes))).toThrow(
      'tool "read_log": description must be a non-empty string',
    );
  });

  it.each([
    ['a timeoutMs of 0', 0],
    ['a negative timeoutMs', -1],
    ['a fractional timeoutMs', 1.5],
    ['an infinite timeoutMs', Infinity],
    ['a NaN timeoutMs', Number.NaN],
    ['a timeoutMs that is a string', '1000'],
  ])('throws a RangeError on %s', (_, timeoutMs) => {
    expect(() => tool(withChanges({ timeoutMs }))).toThrow(RangeError);
    expect(() => tool(withChanges({ timeoutMs }))).toThrow(
      /^tool "read_log": timeoutMs must be a positive integer/,
    );
  });

  it.each([
    ['a missing input', { input: undefined }, 'input must be a JSON Schema object'],
    ['an array input', { input: [] }, 'input must be a JSON Schema object'],
    [
      'an input that is not an object schema',
      { input: { type: 'string' } },
      'must have type "object"',
    ],
    [
      'an input that is not JSON',
      { input: { type: 'object', default: undefined } },
      'input must be JSON',
    ],
    ['a parse that is not a Standard Schema', { parse: {} }, 'parse must be a Standard Schema'],
    ['a parse with no validate', { parse: { '~standard': {} } }, 'parse must be a Standard Schema'],
    ['a parse that is a string', { parse: 'zod' }, 'parse must be a Standard Schema'],
    ['an idempotent that is not a boolean', { idempotent: 'yes' }, 'idempotent must be a boolean'],
    ['a missing run', { run: undefined }, 'run must be a function'],
    ['an unknown option, most likely a typo', { idempotant: true }, 'unknown option "idempotant"'],
  ])('throws a TypeError on %s', (_, changes, message) => {
    expect(() => tool(withChanges(changes))).toThrow(TypeError);
    expect(() => tool(withChanges(changes))).toThrow(message);
  });

  it('throws when it is given no definition', () => {
    expect(() => tool(null as unknown as ToolDef)).toThrow('tool: give a definition object');
  });
});

describe('RetryableToolError', () => {
  it('is an Error with its own name, and keeps its cause', () => {
    const cause = new Error('connection refused');
    const error = new RetryableToolError('Not sent', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RetryableToolError');
    expect(error.message).toBe('Not sent');
    expect(error.cause).toBe(cause);
  });
});
