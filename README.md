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

## Deployment and recovery

**Rollout is blocked.** The proposed translate agent's `shell` allowlist is not a sandbox: OpenCode v2.0.15 misses executable zsh expansions and some redirections. Do not install that allowlist or enable the job. A reviewed translate agent must deny `shell` and use narrow structured extraction tools that validate a single URL and invoke the two trusted scripts with fixed argv (no shell). No such installable agent/tool artifact is included here yet. Sharing `OPENCODE_DB` with the interactive OpenCode service is also unsafe: on restart that service may resume a private Run's live session. Use a dedicated persistent database and enroll provider credentials there before rollout; the interactive session list will not show these sessions. These changes require resolving the #1/ADR-0002 expectations before claiming the original guarantees. The cross-Run ownership and long-outage catch-up gaps described in #1 also need decisions before an enabled job can promise no duplicates or missing Link Posts.

The committed `config.yml` has no Watched Channels. Set `since` to the intended rollout instant with an explicit timezone offset; add one channel first, then expand only after checking its dry run and results. For example:

```yaml
channels:
  - id: "123456789012345678"
    label: test-channel
    since: "2026-09-25T09:00:00+09:00"
```

Keep IDs quoted, replace the example ID/time with the real channel and activation instant, and commit/push the token-free config for recovery. `opencode.directory` must point to the installed translate checkout. Optional config settings and defaults are in [#1](https://github.com/ysm-dev/discord-link-summarizer/issues/1): `command: summarize`, `horizon: 7 days`, `concurrency: 10`, `summary_timeout: 10 minutes`, `run_budget: 20 minutes`, `retry_waits: [10 minutes, 1 hour]`, and `delete_sessions: false`. A per-channel `since` or `command` overrides the global setting.

### Bot and translate setup (human)

1. In the Discord Developer Portal, create a **dedicated** Summarizer application/bot (never reuse wachi's or pany's token). Enable the privileged **Message Content** intent. Invite with the `bot` scope and grant View Channel, Read Message History, Create Public Threads, Send Messages in Threads, **and Manage Threads** in the chosen text/announcement channel(s). Manage Threads is needed for the final rename/archive operation; verify effective channel permissions, including overrides. Keep the token outside Git.
2. Install translate and its `/summarize` command and extraction scripts. Before enabling, the human must install a reviewed hidden primary `summarizer` agent in translate with an explicit model/variant, file reads excluding `.env` files, web fetch/search, and **only** safe structured URL extraction tools for the two scripts. Deny arbitrary shell, edits, other execution tools and subagents. The proposed shell-glob agent from #1 is unsafe; there is no approved exact artifact yet. Test the actual private server's agent registration, model/variant, command availability and permitted tools before running on a Link Post.
3. Give the private server a dedicated persistent absolute `OPENCODE_DB`, separate from the interactive service's DB. OpenCode v2 stores provider credentials in its DB; provision/login to the chosen provider in the dedicated DB through a human-controlled setup, then verify it can run the configured model. Changing only config/data directories does not isolate sessions when `OPENCODE_DB` still points to the shared DB. Keep the DB and credentials private. Inspect retained sessions via this dedicated DB/server rather than the interactive session list.

### Run and schedule (human, after blockers are resolved)

`DISCORD_BOT_TOKEN` and `OPENCODE_DB` must be set in the Run environment; never put the token in `config.yml` or this repo. From the installed checkout, after securely loading those environment values:

```sh
bun apps/summarizer/src/index.ts --config ./config.yml --dry-run
bun apps/summarizer/src/index.ts --config ./config.yml
```

The default config path without `--config` is `~/.config/discord-link-summarizer/config.yml`. Dry run reports each channel's effective start and its Pending/In-progress/Given-up counts without writing to Discord or starting OpenCode. Inspect results for the one test channel before adding more. The second command performs a real Run; use it only after the safety and recovery blockers above are addressed. For a manual Run, do not overlap an enabled schedule: `overlap_policy = "skip"` only protects ticks of the **same local crnd job**, not manual Runs or other machines.

The checked-in `crnd-job.toml` is a **paused fragment**, not a complete export. crnd **v0.2.5** `import -f` synchronizes the _entire_ job set and deletes every absent job, including `wachi-check`. To preserve wachi and all other jobs:

1. On the target machine, create a private directory (`umask 077`) outside the repo. Run `crnd export -o /private/path/jobs.toml` and keep an untouched, private copy of that full export as a rollback snapshot; exports can contain existing job secrets. Record `crnd list` and check wachi's `crnd show -n wachi-check` before changes. Never commit or print the export.
2. In a **working copy of the full export**, append the fragment after a blank line:

   ```sh
   cp /private/path/jobs.toml /private/path/merged-jobs.toml
   printf '\n' >> /private/path/merged-jobs.toml
   cat crnd-job.toml >> /private/path/merged-jobs.toml
   ```

   Ensure the result still contains **every** exported `[jobs.<name>]` and its nested env/settings; do not replace, redact or re-create wachi's job. Edit only the new job's absolute Bun/checkout paths, `cwd`, dedicated `OPENCODE_DB` path and `DISCORD_BOT_TOKEN` placeholder. Supply the real token privately in this copy. Keep `paused = true` and permissions restrictive; do not commit this merged file.

3. Validate the merged TOML and compare it to the snapshot: every original job and its settings must be preserved, plus exactly the new paused job. For example, Python 3.11+ can check this without contacting crnd:

   ```sh
   python3 - /private/path/jobs.toml /private/path/merged-jobs.toml <<'PY'
   import sys, tomllib
   with open(sys.argv[1], 'rb') as original, open(sys.argv[2], 'rb') as merged:
       before, after = tomllib.load(original)['jobs'], tomllib.load(merged)['jobs']
   assert set(after) == set(before) | {'discord-link-summarizer'}
   assert all(after[name] == job for name, job in before.items())
   assert after['discord-link-summarizer']['paused'] is True
   PY
   ```

   Run `crnd import -f /private/path/merged-jobs.toml` **only on this complete file**, then check `crnd list`, `crnd show -n wachi-check` and `crnd show -n discord-link-summarizer`. If anything differs unexpectedly, restore with `crnd import -f /private/path/jobs.toml` and investigate. `crnd import -f crnd-job.toml` would delete wachi.

4. Once the agent, isolated credentials, Run behavior and test channel are verified, enable with `crnd resume -n discord-link-summarizer`. Inspect `crnd runs -n discord-link-summarizer` and `crnd logs -n discord-link-summarizer --show` for failures; pause with `crnd pause -n discord-link-summarizer` before troubleshooting. The one-minute schedule skips overlapping ticks; the 35-minute crnd timeout is only a backstop for the Run's own deadline. Do not enable until the unresolved #1 guarantees have been addressed.

After machine loss, clone this repo and translate, restore/provision Bun, crnd, wachi's job, the dedicated bot token and **dedicated** OpenCode DB/provider login, install the reviewed translate agent, and set the checkout paths in `config.yml` and the paused job fragment. Re-export the target scheduler's full job set (including wachi), merge the fragment and verify it as above; do not restore by importing the fragment alone. Run `--dry-run` and verify channel permissions and Since, then verify a single test channel before resuming the job. Discord holds Link Post progress; retained OpenCode sessions in the dedicated DB are diagnostic and may be lost on rebuild. Check `crnd runs`/`crnd logs` during recovery; do not presume long-outage catch-up is complete while the #1 design gaps remain.

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
