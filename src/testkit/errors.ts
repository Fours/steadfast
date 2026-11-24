// The model failures tests reach for most, as the errors an adapter would throw for them.

import { ModelError } from '../model.js';

/** A 429: retryable, waiting at least `retryAfterMs` if it's given. */
export function rateLimited(options: { readonly retryAfterMs?: number } = {}): ModelError {
  return new ModelError('Rate limited (429)', { retryable: true, ...options });
}

/** A 529: the provider is overloaded. Retryable. */
export function overloaded(): ModelError {
  return new ModelError('Overloaded (529)', { retryable: true });
}

/** A request that timed out or lost its connection. Retryable. */
export function timedOut(): ModelError {
  return new ModelError('The request timed out', { retryable: true });
}

/** A 400: the request itself is wrong, so trying again won't help. Not retryable. */
export function badRequest(message = 'Bad request (400)'): ModelError {
  return new ModelError(message, { retryable: false });
}
