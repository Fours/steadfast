import { describe, expect, it } from 'vitest';
import { toModelError } from '../src/adapter-errors.ts';
import { ModelError } from '../src/index.ts';
import { FakeApiError } from './fake-api-error.ts';

describe('toModelError', () => {
  it.each([
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [413, false],
    [408, true],
    [409, true],
    [429, true],
    [500, true],
    [503, true],
    [529, true],
  ])('classifies status %i as retryable: %s', (status, retryable) => {
    const error = toModelError(new FakeApiError(status));
    expect(error).toBeInstanceOf(ModelError);
    expect(error.retryable).toBe(retryable);
    expect(error.message).toBe(`${String(status)} fake API error`);
  });

  it('makes a failure with no status, such as a connection error, retryable', () => {
    const cause = new TypeError('fetch failed');
    const error = toModelError(cause);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('fetch failed');
    expect(error.cause).toBe(cause);
    expect(toModelError('socket hang up').retryable).toBe(true);
  });

  it.each([
    ['2', 2_000],
    ['1.5', 1_500],
    ['0', 0],
    [' 3 ', 3_000],
  ])('turns retry-after %j into retryAfterMs %i', (value, ms) => {
    const error = toModelError(new FakeApiError(429, new Headers({ 'retry-after': value })));
    expect(error.retryAfterMs).toBe(ms);
  });

  it('prefers retry-after-ms, and rounds up to whole ms', () => {
    const headers = new Headers({ 'retry-after-ms': '250.2', 'retry-after': '9' });
    expect(toModelError(new FakeApiError(529, headers)).retryAfterMs).toBe(251);
  });

  it('ignores a missing, malformed or HTTP-date retry-after', () => {
    expect(toModelError(new FakeApiError(429)).retryAfterMs).toBeUndefined();
    expect(toModelError(new FakeApiError(429, undefined)).retryAfterMs).toBeUndefined();
    for (const value of ['soon', '-1', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      const error = toModelError(new FakeApiError(429, new Headers({ 'retry-after': value })));
      expect(error.retryAfterMs).toBeUndefined();
    }
  });

  it('reads headers from a plain record, in any case', () => {
    const error = toModelError(new FakeApiError(429, { 'Retry-After': '4' }));
    expect(error.retryAfterMs).toBe(4_000);
  });

  it("lets the API's x-should-retry header override the status", () => {
    const no = new Headers({ 'x-should-retry': 'false' });
    const yes = new Headers({ 'x-should-retry': 'true' });
    expect(toModelError(new FakeApiError(500, no)).retryable).toBe(false);
    expect(toModelError(new FakeApiError(400, yes)).retryable).toBe(true);
  });

  it('passes a ModelError through unchanged', () => {
    const error = new ModelError('bad', { retryable: false });
    expect(toModelError(error)).toBe(error);
  });
});
