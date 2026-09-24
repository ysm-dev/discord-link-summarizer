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

**Rollout is blocked pending Run integration and OpenCode ownership research.** The user approved a single-machine OS lock (not cross-machine safety), durable Discord channel markers for catch-up, Manage Threads, and the structured translate extraction tools below. Those Run changes are not yet in this branch. OpenCode's managed service can resume a concurrently running private server's sessions when they share its DB; the user requires interactive session visibility and forbids upstream changes. A supported, verified workaround for that combination is still being researched. Do not enable the job or claim shared-DB safety until resolved. The old `shell` glob allowlist is unsafe and must never be installed.

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
2. Install translate and leave its `/summarize` command and both extraction scripts unchanged. The installable V2 artifacts are `extraction-agent.md` and `apps/summarizer/src/extraction-{plugin,runner,url}.ts`. On the human-managed translate checkout, copy the agent to `.opencode/agents/summarizer.md`; copy the three TypeScript files into `.opencode/plugins/summarizer-extraction/`, renaming `extraction-plugin.ts` to `index.ts` and keeping the two helper filenames. This **directory** is discovered as one plugin; putting all three files directly under `.opencode/plugins/` would try to load the helpers as plugins. Install exactly `@opencode/plugin@2.0.15` for translate's `.opencode` package if it is not already resolvable there, matching the verified OpenCode v2.0.15 host. The runner's fixed Bun path `/Users/chris/.bun/bin/bun` must exist on that host. The plugin reads its scripts from the active translate Location's `scripts/` directory; verify the actual agent registry lists `summarizer`, its model/variant and the two tools before enabling. Copy and commit these files **in translate** as a human rollout step; this repo does not edit translate.
3. The agent denies all actions then allows only file reads (except `.env`), web fetch/search and the two direct extraction tools. In V2, denying `execute` disables Code Mode, so the plugin registers its tools with `codemode: false`; `shell`, `edit`, `subagent`, `execute`, MCP and other plugin actions remain denied. Its validators reject IP literals, localhost/internal names, credentials, custom ports, malformed URLs and non-YouTube URLs for captions. The URL is passed as a single argv argument to a fixed Bun script, with no shell, a 3-minute deadline, 200 KB output limit and process-group termination on abort. Untrusted pages may redirect or DNS-rebind; if network access to internal services must be prohibited, enforce egress at the host/network boundary too. Test the real private server's agent and tools without changing translate's command. **Do not use the shell-glob agent from #1.**
4. Set `OPENCODE_DB` only to the DB path validated by the pending shared-session ownership solution. A separate DB would hide sessions from the required interactive list and is **not** an accepted rollout solution. The committed crnd path is a placeholder, not a recommendation to point the Run at the current shared DB.

### Run and schedule (human, after blockers are resolved)

`DISCORD_BOT_TOKEN` and `OPENCODE_DB` must be set in the Run environment; never put the token in `config.yml` or this repo. From the installed checkout, after securely loading those environment values:

```sh
bun apps/summarizer/src/index.ts --config ./config.yml --dry-run
bun apps/summarizer/src/index.ts --config ./config.yml
```

The default config path without `--config` is `~/.config/discord-link-summarizer/config.yml`. Dry run reports each channel's effective start and its Pending/In-progress/Given-up counts without writing to Discord or starting OpenCode. Inspect results for the one test channel before adding more. The second command performs a real Run; use it only after the remaining blockers above are addressed. The approved single-machine OS lock must cover manual and scheduled Runs; `overlap_policy = "skip"` only protects ticks of the **same local crnd job**. No cross-machine safety is promised.

The checked-in `crnd-job.toml` is a **paused fragment**, not a complete export. crnd **v0.2.5** `import -f` synchronizes the _entire_ job set and deletes every absent job, including `wachi-check`. To preserve wachi and all other jobs:

1. On the target machine, create a private directory (`umask 077`) outside the repo. Run `crnd export -o /private/path/jobs.toml` and keep an untouched, private copy of that full export as a rollback snapshot; exports can contain existing job secrets. Record `crnd list` and check wachi's `crnd show -n wachi-check` before changes. Never commit or print the export.
2. In a **working copy of the full export**, append the fragment after a blank line:

   ```sh
   cp /private/path/jobs.toml /private/path/merged-jobs.toml
   printf '\n' >> /private/path/merged-jobs.toml
   cat crnd-job.toml >> /private/path/merged-jobs.toml
   ```

   Ensure the result still contains **every** exported `[jobs.<name>]` and its nested env/settings; do not replace, redact or re-create wachi's job. Edit only the new job's absolute Bun/checkout paths, `cwd`, verified `OPENCODE_DB` path and `DISCORD_BOT_TOKEN` placeholder. Supply the real token privately in this copy. Keep `paused = true` and permissions restrictive; do not commit this merged file.

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

4. Once the agent, OpenCode ownership, OS lock, channel markers, Run behavior and test channel are verified, enable with `crnd resume -n discord-link-summarizer`. Inspect `crnd runs -n discord-link-summarizer` and `crnd logs -n discord-link-summarizer --show` for failures; pause with `crnd pause -n discord-link-summarizer` before troubleshooting. The one-minute schedule skips overlapping ticks; the 35-minute crnd timeout is only a backstop for the Run's own deadline. Do not enable until these blockers have been addressed.

After machine loss, clone this repo and translate, restore/provision Bun, crnd, wachi's job and the dedicated bot token; restore the **approved** OpenCode database/session-visibility setup and provider login, install the translate agent/plugin, and set the checkout paths in `config.yml` and the paused job fragment. Re-export the target scheduler's full job set (including wachi), merge the fragment and verify it as above; do not restore by importing the fragment alone. Run `--dry-run` and verify channel permissions and Since, then verify a single test channel before resuming the job. Discord holds Link Post progress; OpenCode sessions are diagnostic. Check `crnd runs`/`crnd logs` during recovery; verify durable channel markers and catch-up before declaring the backlog clear.

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
