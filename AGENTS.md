## Agent skills

### Issue tracker

Issues live in GitHub Issues for this repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Quality gates

This repo enforces eight gates. They are not advisory. `bun run ci` runs all of them and CI blocks on it.

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

### Rules that are easy to get wrong

- **`any` is banned outright.** No exceptions.
- **`unknown` is allowed only at a trust boundary** — a function taking untrusted input (CLI arguments, parsed JSON, environment variables) and narrowing it before anything downstream sees it. It is banned in every other declared parameter, return, or field type. See `packages/duration/src/parse-duration.ts` for the intended shape.
- **Coverage is per file, not global.** A global average is trivially gamed by one large well-covered file.
- **Untestable code goes in a thin edge file**, not behind a coverage ignore comment. `apps/cli/src/index.ts` is the worked example: all logic lives in `main.ts`, and the shim that reads `process.argv` is the only excused file.

### When a gate blocks you

Do **not** delete the test, weaken the type, or inline a duplicate to get green. Those are worse than the violation.

Exceptions live in `quality-exceptions.json`, which is owned by a human via CODEOWNERS. You may propose an entry; you cannot land one. Every entry needs a `reason`. Inline suppressions must carry `-- <reason>` and are reported by `bun run exceptions`.

A sudden burst of `no-unsafe-*` errors means the TypeScript program is misconfigured, **not** that you should add a disable comment.

### Package shape

Packages are Just-in-Time: `exports` points at `./src/index.ts`, there is no build step, and relative imports use explicit `.ts` extensions. Do not add a `build` script or emit `dist/` — an unbuilt compiled package makes type-aware lint and knip exit 0 while enforcing nothing.
