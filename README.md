# discord-link-summarizer

A Discord bot that summarizes shared links.

Built on [ysm-dev/ts-template](https://github.com/ysm-dev/ts-template): bun, Turborepo, TypeScript 7, and eight quality gates that block CI. The premise is that when agents write most of the code, review does not scale but gates do.

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

The entry shim provides `BunServices.layer` and runs `invoke` with `BunRuntime.runMain`.

## Deployment and recovery

**The checked-in scheduler fragment is paused by default; verify credentials and a test channel before enabling a new deployment.** The Run uses a one-machine OS lock and stores durable [Channel Records](docs/recovery-protocol.md) in an automatically created SQLite file at `~/.local/state/discord-link-summarizer/progress.sqlite`. No extra Discord channel or bookkeeping messages are needed. Back up this file for machine-loss recovery; see [ADR-0010](docs/adr/0010-local-sqlite-progress.md). [ADR-0008](docs/adr/0008-isolated-execution-shared-terminal-transcripts.md) resolves session ownership: private executions use a separate persistent DB and independently provisioned credentials; terminal transcripts are exported and imported into the already-running interactive service at the translate location for eventual visibility. Active private sessions do not appear in the interactive list. The old `shell` glob allowlist is unsafe and must never be installed.

See [config.yml](config.yml) for the current Watched Channels and their activation times. Give each added channel its own `since` so it starts with new posts rather than backfilling older history. For another deployment, set `since` to the intended rollout instant with an explicit timezone offset and verify a dry run before enabling channels. Remove `state_channel_id` from older configs; it is no longer supported. For example:

```yaml
channels:
  - id: "123456789012345678"
    label: test-channel
    since: "2026-09-25T09:00:00+09:00"
```

Keep IDs quoted, replace the example ID/time with the real channel and activation instant, and commit/push the token-free config for recovery. `opencode.directory` must point to the installed translate checkout. Optional config settings and defaults are in [#1](https://github.com/ysm-dev/discord-link-summarizer/issues/1): `command: summarize`, `horizon: 7 days`, `concurrency: 10`, `summary_timeout: 10 minutes`, `run_budget: 20 minutes`, `retry_waits: [10 minutes, 1 hour]`, and `delete_sessions: false`. A per-channel `since` or `command` overrides the global setting.

### Bot and translate setup (human)

1. In the Discord Developer Portal, create a **dedicated** Summarizer application/bot (never reuse wachi's or pany's token). Enable the privileged **Message Content** intent. Invite with the `bot` scope and grant View Channel, Read Message History, Create Public Threads, Send Messages in Threads, **and Manage Threads** in the chosen text/announcement Watched Channels; verify effective permissions and channel overrides. Manage Threads is needed for rename/archive. Keep the token outside Git.
2. Install translate and leave its `/summarize` command and both extraction scripts unchanged. The installable V2 artifacts are `extraction-agent.md` and `apps/summarizer/src/extraction-{plugin,runner,url}.ts`. On the human-managed translate checkout, copy the agent to `.opencode/agents/summarizer.md`; copy the three TypeScript files into `.opencode/plugins/summarizer-extraction/`, renaming `extraction-plugin.ts` to `index.ts` and keeping the two helper filenames. This **directory** is discovered as one plugin; putting all three files directly under `.opencode/plugins/` would try to load the helpers as plugins. The plugin needs no installed packages: OpenCode supplies `effect` and `@opencode/plugin` to plugins and redirects every import of them, including imports made by packages in a plugin's `node_modules`, to its own instances. The plugin therefore runs on OpenCode's `effect` (4.0.0-rc.112 in the verified v2.0.26), not this repo's pin, so its three files import only `effect`, `@opencode/plugin` and Node built-ins, and a test enforces that. Never add an Effect platform package to it: those are locked to one `effect` release, and `@effect/platform-bun` is what stopped the plugin loading after the v2.0.26 upgrade ([ADR-0011](docs/adr/0011-extraction-plugin-runs-on-opencodes-effect.md)). The runner's fixed Bun path `/Users/chris/.bun/bin/bun` must exist on that host. The plugin reads its scripts from the active translate Location's `scripts/` directory; verify the actual agent registry lists `summarizer`, its model/variant and the two tools before enabling. Copy and commit these files **in translate** as a human rollout step; this repo does not edit translate.
3. The agent denies all actions then allows only file reads (except `.env`), web fetch/search and the two direct extraction tools. In V2, denying `execute` disables Code Mode, so the plugin registers its tools with `codemode: false`; `shell`, `edit`, `subagent`, `execute`, MCP and other plugin actions remain denied. Its validators reject IP literals, localhost/internal names, credentials, custom ports, malformed URLs and non-YouTube URLs for captions. The URL is passed as a single argv argument to a fixed Bun script, with no shell and a 3-minute Effect deadline. OpenCode applies the translate Location's `tool_output.max_lines` and `tool_output.max_bytes` settings (configured in `translate/opencode.jsonc`) to the returned output; the extraction runner has no separate size cap. The runner starts the script with Node's `child_process` in its own process group. On interruption or the deadline it sends SIGTERM to the whole group and SIGKILL 1.5 seconds later if any member remains, so a browser the script launched cannot outlive the tool call; the native V2 tool executor is the only Promise bridge. Untrusted pages may redirect or DNS-rebind; if network access to internal services must be prohibited, enforce egress at the host/network boundary too. Test the real private server's agent and tools without changing translate's command. **Do not use the shell-glob agent from #1.**
4. Set `OPENCODE_DB` to a private, persistent **isolated** database path, not the interactive service's DB. With an interactive terminal, provision its own provider login (for example `OPENCODE_DB=/secure/path/summarizer.db opencode auth login opencode-go --standalone`) or a verified supported environment connection; never copy live SQLite credentials or OAuth secrets. This setup is separate from the interactive service. Publication transfers only **terminal** sessions via the V2 export/import API after discovering the healthy already-running managed service; an absent service defers publication and retains the private transcript, without restarting/starting it. At each Run unmarked owned terminal sessions in the private DB are paginated and retried oldest-first; verified imports are marked in private metadata and skipped on later sweeps. Already-present IDs are checked against the location, ownership, outcome and entire settled message transcript before marking. An unrelated ID collision is reported rather than overwritten. The target is an eventual snapshot, never a live active-session mirror. `delete_sessions: true` opts out of retention and publication and deletes each used private session. Verify eventual visibility in translate's interactive list before enabling the job. See ADR-0008 for the transfer, retry and 409 reconciliation protocol.

### Run and schedule (human, after setup is verified)

`DISCORD_BOT_TOKEN` and `OPENCODE_DB` must be set in the Run environment; never put the token in `config.yml` or this repo. Keep them in a private environment file such as `~/.config/discord-link-summarizer/.env` (directory mode `0700`, file mode `0600`):

```dotenv
DISCORD_BOT_TOKEN=your-dedicated-bot-token
OPENCODE_DB=/absolute/private/summarizer-opencode.sqlite
```

From the installed checkout, load that file with Bun. Clear inherited values first because Bun's env-file does not override process environment; this prevents an interactive `OPENCODE_DB` from leaking into the Run:

```sh
env -u DISCORD_BOT_TOKEN -u OPENCODE_DB bun --env-file="$HOME/.config/discord-link-summarizer/.env" apps/summarizer/src/index.ts --config ./config.yml --dry-run
env -u DISCORD_BOT_TOKEN -u OPENCODE_DB bun --env-file="$HOME/.config/discord-link-summarizer/.env" apps/summarizer/src/index.ts --config ./config.yml
env -u DISCORD_BOT_TOKEN -u OPENCODE_DB bun --env-file="$HOME/.config/discord-link-summarizer/.env" apps/summarizer/src/index.ts --config ./config.yml --watch
```

The second command performs one discovery/work pass. `--watch` keeps the Run alive,
checking each readable Watched Channel for new messages every five seconds after
startup recovery. It reuses one private OpenCode server and fills available worker
slots as Attempts finish. Waiting retries do not block discovery of newer posts.
The interval is a delay between completed discovery cycles; rate limits, network
latency and backlog can extend pickup time. Full Horizon rescans, archived-thread
adoption and deferred transcript sweeps happen at the start of each Run, not every
five seconds. Deleted completed threads are therefore rediscovered on a later Run.
`--watch` cannot be combined with `--dry-run`.

Before creating any Summary Thread, each Run waits up to 20 seconds for the private
server to report the `summarizer-extraction` plugin as active. OpenCode only logs a
warning when a plugin fails to load; without its extraction tools the model posts
refusals that would otherwise be accepted as Summaries. A Run that finds the plugin
missing or failed ends with `OpenCode plugin summarizer-extraction is not active;
failed plugins: [...]` and leaves Link Posts Pending. Each failed plugin's `ref`
locates its cause in `~/.local/share/opencode/log/opencode.log`. After upgrading
OpenCode, check `crnd logs` for this error before assuming summaries are healthy.

The default config path without `--config` is `~/.config/discord-link-summarizer/config.yml`. Dry run reads local Channel Records and reports each channel's effective start, partial discovery, and Pending/In-progress/Given-up counts without progress/Discord writes or OpenCode startup. If the progress database is absent, dry-run leaves it absent. Inspect results for one test channel before adding more. The second command performs a real Run and creates the private database automatically. Run manual and scheduled invocations as the same Unix user so they share progress and the lock. The approved single-machine lock uses Bun's retained descriptor with macOS `lockf -t 0 3` on one stable private lock file, including manual and dry Runs; `overlap_policy = "skip"` protects only ticks of the **same local crnd job**. Do not replace/unlink the lock file or run a second machine; see the recovery protocol.

The checked-in `crnd-job.toml` is a **paused fragment**, not a complete export. It uses Bun's `--env-file`; crnd **v0.2.5** rejects TOML `env` tables because its parser attaches symbol metadata that its environment validator rejects. If existing exported jobs contain such tables, resolve that crnd incompatibility before importing; preserve their settings. `import -f` synchronizes the _entire_ job set and deletes every absent job, including `wachi-check`. To preserve wachi and all other jobs:

1. On the target machine, create a private directory (`umask 077`) outside the repo. Run `crnd export -o /private/path/jobs.toml` and keep an untouched, private copy of that full export as a rollback snapshot; exports can contain existing job secrets. Record `crnd list` and check wachi's `crnd show -n wachi-check` before changes. Never commit or print the export.
2. In a **working copy of the full export**, append the fragment after a blank line:

   ```sh
   cp /private/path/jobs.toml /private/path/merged-jobs.toml
   printf '\n' >> /private/path/merged-jobs.toml
   cat crnd-job.toml >> /private/path/merged-jobs.toml
   ```

   Ensure the result still contains **every** exported `[jobs.<name>]` and its nested env/settings; do not replace, redact or re-create wachi's job. Edit only the new job's absolute Bun/checkout paths, `cwd` and `--env-file` path. Put the dedicated token and isolated `OPENCODE_DB` path in that private environment file, not in the TOML. Keep `paused = true` and permissions restrictive; do not commit this merged file or the environment file.

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

4. Once the agent, private login and terminal-session publication, OS lock, Channel Records, Run behavior and test channel are verified, enable with `crnd resume -n discord-link-summarizer`. Inspect `crnd runs -n discord-link-summarizer` and `crnd logs -n discord-link-summarizer --show` for failures; pause with `crnd pause -n discord-link-summarizer` before troubleshooting. The fragment includes `--watch`; existing jobs need that argument added to their command to enable five-second polling. The one-minute schedule skips overlapping ticks; the 35-minute crnd timeout is only a backstop for the Run's own deadline.

In watch mode, the default 20-minute Run budget stops polling and admission of new
Attempts; active Attempts drain under their existing timeouts. The next crnd tick
starts a fresh Run and reloads configuration. Pickup can pause during this drain
and for up to a minute afterward. Infrastructure errors end the Run and interrupt
active Attempts; crnd supplies the next retry rather than a five-second outage
retry loop. To perform a manual or dry Run, pause the job and wait for its current
Run to finish, since watch mode retains the same machine lock for its lifetime.

After machine loss, clone this repo and translate; restore/provision Bun, crnd, wachi's job and the dedicated bot token. Restore `~/.local/state/discord-link-summarizer/progress.sqlite` from a consistent SQLite backup. Without a backup, explicitly select a recovery Since and temporarily widen Horizon to cover the entire interval; the default seven days can miss an older backlog. Existing Summary Threads are reconciled during the rescan, but lost READY manifests may require regenerating unfinished drafts. See the [backup and recovery instructions](docs/recovery-protocol.md#backup-and-machine-loss-recovery).

Separately restore the persistent **private** OpenCode DB or enroll its provider again, install the translate agent/plugin, and set checkout paths and Since in `config.yml` and the paused job fragment. Re-export the target scheduler's full job set (including wachi), merge the fragment and verify it as above; never import the fragment alone. Run `--dry-run`, verify permissions and that partial discovery is identified, then verify one test channel and terminal transcript publication to the interactive translate list before resuming. `OPENCODE_DB` holds private transcripts and credentials, not summarizer progress. If the interactive service is unavailable, terminal transcripts stay private and are retried on a later Run. Check `crnd runs`/`crnd logs` and the recovery protocol before declaring the backlog clear.

## Performance diagnostics

Runs emit `performance phase=... elapsed_ms=...` logs for discovery, archive
adoption, model execution, Discord publication and transcript publication. The
Discord service also reports `discord_requests` (including explicit 429 retries)
and `discord_wait_ms` (summed lane queueing and rate-limit waits). Concurrent
waits can make this total exceed wall time. These logs contain no source URLs or
credentials. Compare stage times and request counts before increasing concurrency.

The regression suite checks constant history-read counts for multipart summaries,
multi-Run archive catch-up, publication ordering, request deadlines, and atomic
migration of legacy progress databases. Progress writes now update individual
SQLite entry rows; see the [recovery protocol](docs/recovery-protocol.md).

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

`bun run verify-gates` proves the gates actually reject bad code. It plants a deliberate violation for each gate, runs the real gate, and asserts it is rejected **and named the expected rule** — an exit code alone would pass if the gate had failed for an unrelated reason. A gate that has silently stopped enforcing anything is the failure mode this repo is designed around.

## Design decisions worth knowing

- **bun installs and runs scripts; Node runs tests.** Vitest treats bun as a package manager only, and the v8 coverage provider does not work on the bun runtime.
- **No build step anywhere.** Packages export TypeScript source directly. A compiled package that has not been built makes type-aware lint and knip exit 0 while enforcing nothing — a silent false pass.
- **Exact version pins, no ranges.** oxfmt is pre-1.0 with no semver protection on formatting output, and `oxlint-tsgolint` is hard-pinned to a TypeScript patch release.
- **Effect v4 is pinned to `4.0.0-rc.117`.** `effect`, `@effect/platform-bun`, and `@effect/vitest` upgrade together in Renovate. The installed extraction plugin is the exception: inside OpenCode it runs on OpenCode's own `effect` ([ADR-0011](docs/adr/0011-extraction-plugin-runs-on-opencodes-effect.md)). `@effect/tsgo` is pinned separately; `effect:check` passes the diagnostics configuration inline with `--lspconfig` and rejects warnings with `--strict`. Floating Effects and missing `return yield*` are errors. Without this configuration the tool checks zero files; gate verification plants a floating Effect and requires the `floatingEffect` diagnostic to prevent that silent false pass.
- **bun's default isolated linker is kept.** It turns an undeclared dependency into an immediate failure instead of a latent bug.
- **`globalStore = true` in `bunfig.toml`.** Packages are symlinked from one machine-wide store, so a clone's `node_modules` is ~200KB instead of ~240MB. The cost is that tools resolving plugins by package name from their _own_ location break, since the store is not a parent of the project.
