// Error classification shared by the provider adapters. Every failure becomes a ModelError, so the
// run never inspects an SDK's error types. Anthropic's and OpenAI's SDKs both put `status` and
// `headers` on their errors and read the same retry headers, so one check reads them structurally,
// since no adapter imports its SDK's error classes (decision 0004).

import { ModelError } from './model.js';

/** Statuses below 500 that may succeed if the same request is tried again. */
const RETRYABLE_STATUSES = new Set([408, 409, 429]);
const SECONDS = /^\d+(\.\d+)?$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A header's value, from a `Headers`-like object with `get`, or from a plain record. */
function header(headers: unknown, name: string): string | undefined {
  if (!isObject(headers)) return undefined;
  if (typeof headers.get === 'function') {
    const value: unknown = (headers.get as (name: string) => unknown).call(headers, name);
    return typeof value === 'string' ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/** A non-negative number of seconds or ms from a header, as whole ms, rounded up. */
function parseMs(value: string | undefined, msPerUnit: number): number | undefined {
  if (value === undefined || !SECONDS.test(value.trim())) return undefined;
  return Math.ceil(Number.parseFloat(value) * msPerUnit);
}

/**
 * How long the provider asked us to wait. `retry-after-ms` first, as the SDK reads it, then
 * `retry-after` in seconds. The HTTP-date form of `retry-after` is ignored: reading it needs the
 * wall clock, which src/ only reads through what's injected.
 */
function retryAfterMs(headers: unknown): number | undefined {
  return (
    parseMs(header(headers, 'retry-after-ms'), 1) ?? parseMs(header(headers, 'retry-after'), 1_000)
  );
}

/**
 * Whether a failure may succeed on a retry. The API's own `x-should-retry` header wins when it's
 * there. Otherwise 408, 409, 429 and 500 and above are retryable, and so is a failure with no
 * status at all, such as a connection error or a timeout.
 */
function isRetryable(status: number | undefined, headers: unknown): boolean {
  const shouldRetry = header(headers, 'x-should-retry');
  if (shouldRetry === 'true') return true;
  if (shouldRetry === 'false') return false;
  return status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500;
}

/** Turns anything the client threw into a {@link ModelError}, classified by its status. */
export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  const status = isObject(error) && typeof error.status === 'number' ? error.status : undefined;
  const headers = isObject(error) ? error.headers : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const wait = retryAfterMs(headers);
  return new ModelError(message, {
    retryable: isRetryable(status, headers),
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    cause: error,
  });
}
