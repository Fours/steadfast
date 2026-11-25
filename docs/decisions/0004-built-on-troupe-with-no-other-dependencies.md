# 0004. Built on Troupe, with no other runtime dependencies: providers are adapters over structurally typed clients

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 1

## Context

Steadfast needs actors, supervision, persistence and virtual-time tests, which Troupe has. It also needs to call model providers, each with its own SDK. Troupe has no runtime dependencies and runs on any JavaScript runtime (Troupe's 0004), and its Postgres backend takes a `pg` pool it never imports (Troupe's 0017). Milestone 3's demo must run in a browser.

## Decision

`@kylewillett/troupe` is a peer dependency, and Steadfast depends on its public entry points only. There are no other runtime dependencies. The core is runtime-agnostic, with no Node types in its build. A provider adapter is its own entry point, such as `/anthropic`, and takes the user's SDK client, typed structurally by the few methods it calls. The SDK is an optional peer dependency, and a dev dependency for type tests that prove the real client fits.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Depend on provider SDKs directly | Every user would install every SDK, and the core couldn't run in a browser without a bundler pruning them. |
| Call providers over raw HTTP | No SDK to install, but it re-implements auth, error types and request shapes that the SDKs keep current. |
| Vendor Troupe, or reach into its internals | Hides gaps in Troupe instead of fixing them. Steadfast is meant to prove Troupe's public API is enough, and to grow it where it isn't. |

## Evidence

T6's type test proves the real Anthropic client fits the structural type, and the build check proves `src/` has no Node types and no other dependencies.

**T6 (2026-11-24):**

- `test/anthropic/types.test.ts` checks that `Anthropic` from `@anthropic-ai/sdk` 1.14.0 extends `AnthropicClient`, and that `anthropicModel({ client: new Anthropic() })` compiles. Making it fit took one loosening: a message's `content` is optional in the structural type, because the SDK's own message union includes effort-only system messages with no content.
- `npm run typecheck` builds `src/`, `src/anthropic/` included, with no Node types. `package.json`'s only runtime dependencies are peers: Troupe, and `@anthropic-ai/sdk` as an optional one. `dist/anthropic/` mentions the SDK only in a doc comment's example.
- The adapter's tests run on a fake client, with no SDK and no network.

## Consequences

- Steadfast and Troupe version together: a breaking Troupe minor needs a Steadfast release.
- Things Steadfast needs from Troupe, such as a JSON value type or reading a stream, go into Troupe with their own decision record there.
- An adapter can only use what its structural type names. A new SDK feature means widening the type.
