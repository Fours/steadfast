import { describe, expect, it } from 'vitest';
import { ModelError } from '../src/index.ts';
import { badRequest, overloaded, rateLimited, timedOut } from '../src/testkit/index.ts';

describe('ModelError', () => {
  it('carries retryable, retryAfterMs and cause', () => {
    const cause = new Error('socket hang up');
    const error = new ModelError('Rate limited', { retryable: true, retryAfterMs: 2_000, cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ModelError');
    expect(error.message).toBe('Rate limited');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(2_000);
    expect(error.cause).toBe(cause);
  });

  it('leaves retryAfterMs and cause unset when they are not given', () => {
    const error = new ModelError('Bad request', { retryable: false });
    expect(error.retryable).toBe(false);
    expect(error.retryAfterMs).toBeUndefined();
    expect('cause' in error).toBe(false);
  });

  it('accepts a retryAfterMs of 0', () => {
    expect(new ModelError('x', { retryable: true, retryAfterMs: 0 }).retryAfterMs).toBe(0);
  });

  it.each([undefined, 'yes', 1, null])('throws when retryable is %s', (retryable) => {
    expect(() => new ModelError('x', { retryable } as unknown as { retryable: boolean })).toThrow(
      TypeError,
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100'])(
    'throws when retryAfterMs is %s',
    (retryAfterMs) => {
      expect(
        () =>
          new ModelError('x', { retryable: true, retryAfterMs } as unknown as {
            retryable: boolean;
          }),
      ).toThrow(RangeError);
    },
  );
});

describe('error helpers', () => {
  it('make retryable errors for rate limits, overload and timeouts', () => {
    for (const error of [rateLimited(), overloaded(), timedOut()]) {
      expect(error).toBeInstanceOf(ModelError);
      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBeUndefined();
    }
  });

  it('pass retryAfterMs through for rate limits', () => {
    expect(rateLimited({ retryAfterMs: 2_000 }).retryAfterMs).toBe(2_000);
  });

  it('make a bad request that is not retryable, with its message', () => {
    expect(badRequest().retryable).toBe(false);
    expect(badRequest('max_tokens is too large').message).toBe('max_tokens is too large');
  });
});
