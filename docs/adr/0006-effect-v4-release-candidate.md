# Built on Effect v4, pinned to a release candidate

The Summarizer is written with Effect v4 throughout. Anything that does I/O, can fail, or involves time or concurrency is an Effect:

- services and layers;
- `Schema` at every trust boundary;
- `HttpClient` and `Sse`;
- `ChildProcess` with `Scope` for the private OpenCode server;
- `Schedule` for retries;
- `TestClock` in tests.

Small pure calculations stay plain functions. No stable 4.0 exists yet, so `effect`, `@effect/platform-bun` and `@effect/vitest` are pinned exactly to `4.0.0-rc.117`, whose APIs are declared final.

## Considered Options

- **Wait for stable 4.0**, targeted for Q3/Q4 2026.
- **Effect v3.** `effect@latest` on npm is still v3.
- **Wrap `@discordjs/rest`** instead of writing our own small Discord client on `HttpClient`. Rejected: it would put a Promise-based library at the core of an Effect app.

## Consequences

- The Effect packages must always be upgraded together, as one Renovate group.
- The next release moves every `effect/unstable/...` import to `effect/...`, with no fallback for the old paths.
- oxlint cannot see a dropped Effect, such as a missing `yield*`. `effect-tsgo diagnostics` therefore runs as an additional gate.
- `@effect/platform-bun` serves both the app, which runs on Bun, and the tests, which run on Node.
