// An error shaped like both SDKs' APIError, for the error check the adapters share.

/** An error shaped like an SDK's APIError: a status and headers. */
export class FakeApiError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly headers: unknown = new Headers(),
  ) {
    super(`${String(status)} fake API error`);
  }
}
