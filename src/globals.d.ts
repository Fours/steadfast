// The globals src/ may use: the subset every JavaScript runtime provides (browsers, Node, Deno,
// Bun, edge workers). The build has no Node or DOM types (decision 0004), so anything not declared
// here fails to compile. The editor and test config excludes this file and gets these from
// @types/node instead, where a second declaration would clash. Only what src/ uses is declared.

declare interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
