# discord-link-summarizer

A Discord bot that summarizes shared links.

Built on [ysm-dev/ts-template](https://github.com/ysm-dev/ts-template): bun, Turborepo, TypeScript 7, and nine quality gates that block CI. The premise is that when agents write most of the code, review does not scale but gates do.

## Quick start

```sh
bun install
bun run ci
```

## Layout

```
apps/summarizer/src/   Single Effect application and its internal modules; no build step.
apps/summarizer/test/  Effect tests and platform-edge fakes, outside measured source.
scripts/               Repo tooling: exceptions report, gate verification.
quality-exceptions.json  The only place file-level gate exceptions may live.
```

The entry shim provides `BunServices.layer` and runs `main` with `BunRuntime.runMain`.
Until Run integration lands, `bun apps/summarizer/src/index.ts` exits non-zero with an explicit message.

## The gates

| Gate                  | Threshold      | Command                |
| --------------------- | -------------- | ---------------------- |
| Formatting            | clean          | `bun run format:check` |
| Cyclomatic complexity | < 22           | `bun run lint`         |
| Cognitive complexity  | < 22           | `bun run lint`         |
| Lines per file        | < 500          | `bun run lint`         |
| `any` types           | 0              | `bun run lint`         |
| Types                 | clean          | `bun run typecheck`    |
| Effect diagnostics    | clean          | `bun run effect:check` |
| Coverage              | 100%, per file | `bun run test`         |
| Dead code             | 0              | `bun run knip`         |
| Duplicated code       | 0              | `bun run dup`          |
| Surviving mutants     | 0              | `bun run mutate`       |

`bun run verify-gates` proves the gates actually reject bad code. It plants a deliberate violation for each gate, runs the real gate, and asserts it is rejected **and named the expected rule** — an exit code alone would pass if the gate had failed for an unrelated reason. It also asserts the Stryker patch is still applied, since that is the mutation gate’s real failure mode. A gate that has silently stopped enforcing anything is the failure mode this repo is designed around.

## Design decisions worth knowing

- **bun installs and runs scripts; Node runs tests.** Vitest treats bun as a package manager only, and the v8 coverage provider does not work on the bun runtime.
- **No build step anywhere.** Packages export TypeScript source directly. A compiled package that has not been built makes type-aware lint and knip exit 0 while enforcing nothing — a silent false pass.
- **Exact version pins, no ranges.** oxfmt is pre-1.0 with no semver protection on formatting output, and `oxlint-tsgolint` is hard-pinned to a TypeScript patch release.
- **Effect v4 is pinned to `4.0.0-rc.117`.** `effect`, `@effect/platform-bun`, and `@effect/vitest` upgrade together in Renovate. `@effect/tsgo` is pinned separately; `effect:check` passes the diagnostics configuration inline with `--lspconfig` and rejects warnings with `--strict`. Floating Effects and missing `return yield*` are errors. Without this configuration the tool checks zero files; gate verification plants a floating Effect and requires the `floatingEffect` diagnostic to prevent that silent false pass.
- **bun's default isolated linker is kept.** It turns an undeclared dependency into an immediate failure instead of a latent bug.
- **`globalStore = true` in `bunfig.toml`.** Packages are symlinked from one machine-wide store, so a clone's `node_modules` is ~200KB instead of ~240MB. The cost is that tools resolving plugins by package name from their _own_ location break, since the store is not a parent of the project — `stryker.config.js` references its runner by path for exactly this reason.

## Known patch

`@stryker-mutator/vitest-runner@10.0.0` is patched via `bun patch` (see `patches/`).

Vitest 5 changed `testNamePattern` to match against a `" > "`-joined test name; the Stryker runner still joins with a single space, so every test nested in a `describe` is skipped and every mutant is reported as survived. Upstream: [stryker-js#6210](https://github.com/stryker-mutator/stryker-js/issues/6210).

The patch is pinned to exactly `10.0.0`. If Renovate bumps the runner, `patchedDependencies` stops matching and bun applies nothing — but it **fails closed**: gate verification checks the patch is present, and `thresholds.break: 100` rejects surviving mutants. Remove the patch when the fix ships upstream.
