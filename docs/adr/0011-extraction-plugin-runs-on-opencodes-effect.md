# The extraction plugin runs on OpenCode's Effect and gates every Run

OpenCode v2.0.26 redirects plugin imports of `effect` and `@opencode/plugin` to its
own runtime instances, including imports made by packages in a plugin's
`node_modules`, and provides only the public `effect` modules of its own release
(`4.0.0-rc.112`). The plugin's `@effect/platform-bun@4.0.0-rc.117` imported
`effect/unstable/net/NetAddress`, which that release lacks, so the plugin stopped
loading. OpenCode logged a warning at each server start and kept serving. The
agent's allowlist then left the model with only file reads, web fetch and search.
It answered YouTube Links with refusals, and the Run posted them as Summaries.

The plugin's three files import only `effect`, `@opencode/plugin` and Node
built-ins, and a test enforces that. The runner spawns the fixed script with
`node:child_process` and uses only stable `effect` core APIs. It keeps the
detached process group, the 3-minute deadline and SIGTERM followed by SIGKILL
after 1.5 seconds.

Before creating Summary Threads, the Run waits up to 20 seconds for
`GET /api/plugin` to report `summarizer-extraction` as active. A freshly started
server lists no plugins for a moment, and a plugin that failed to load has no ID.
If the plugin never becomes active, the Run fails as an infrastructure error that
names every failed plugin with its log reference, and Link Posts stay Pending.

## Considered Options

- **Downgrade or pin OpenCode (rejected as the fix).** It restores loading only until
  the next upgrade, and the interactive service shares the same binary.
- **Match `@effect/platform-bun` to OpenCode's `effect` (rejected).** Any OpenCode
  release can change that version again.
- **Rewrite the plugin against the Effect plugin API (not needed).** The Promise tool
  API used here is identical in v2.0.15 and v2.0.26.

## Consequences

- Tests run the plugin on this repo's `effect` pin, while OpenCode runs it on its own
  release. Keep to stable core APIs, and after an OpenCode upgrade confirm that the
  installed plugin still loads; the Run-start check fails loudly if it does not.
- translate's `.opencode` needs no packages for this plugin.
- A broken plugin pauses summarizing instead of degrading it.
