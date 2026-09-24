## Agent skills

### Issue tracker

Issues live in GitHub Issues for this repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Quality gates

This repo enforces nine gates. They are not advisory. `bun run ci` runs all of them and CI blocks on it.

| Gate                  | Threshold      | Enforced by                     |
| --------------------- | -------------- | ------------------------------- |
| Cyclomatic complexity | < 22           | oxlint `eslint/complexity`      |
| Cognitive complexity  | < 22           | `oxlint-plugin-complexity`      |
| Lines per file        | < 500          | oxlint `eslint/max-lines`       |
| Test coverage         | 100%, per file | vitest `thresholds.perFile`     |
| Surviving mutants     | 0              | Stryker `thresholds.break: 100` |
| Dead code             | 0              | knip                            |
| Duplicated code       | 0              | jscpd                           |
| `any` types           | 0              | oxlint `no-explicit-any`        |
| Effect diagnostics    | clean          | `effect-tsgo diagnostics`       |

### Rules that are easy to get wrong

- **`any` is banned outright.** No exceptions.
- **`unknown` is allowed only at a trust boundary** — a function taking untrusted input (CLI arguments, parsed JSON, environment variables) and narrowing it before anything downstream sees it. It is banned in every other declared parameter, return, or field type. Use Effect Schema to decode external data.
- **Coverage is per file, not global.** A global average is trivially gamed by one large well-covered file.
- **Untestable code goes in a thin edge file**, not behind a coverage ignore comment. `apps/summarizer/src/index.ts` provides the Bun platform and runs `main` with `BunRuntime.runMain`; all logic belongs in testable modules.
- **Effect diagnostics need the inline `--lspconfig`** in `effect:check`; without configuration, the tool checks zero files and exits successfully. `bun run verify-gates` checks that a floating Effect fails with `floatingEffect`, then that clean code passes.
- **Tests and fakes live in `apps/summarizer/test/`**, outside the source tree measured by coverage and mutation testing. Use `@effect/vitest` and its test clock for Effect programs.

### When a gate blocks you

Do **not** delete the test, weaken the type, or inline a duplicate to get green. Those are worse than the violation.

Exceptions live in `quality-exceptions.json`, which is owned by a human via CODEOWNERS. You may propose an entry; you cannot land one. Every entry needs a `reason`. Inline suppressions must carry `-- <reason>` and are reported by `bun run exceptions`.

A sudden burst of `no-unsafe-*` errors means the TypeScript program is misconfigured, **not** that you should add a disable comment.

### Package shape

Packages are Just-in-Time: `exports` points at `./src/index.ts`, there is no build step, and relative imports use explicit `.ts` extensions. Do not add a `build` script or emit `dist/` — an unbuilt compiled package makes type-aware lint and knip exit 0 while enforcing nothing.
