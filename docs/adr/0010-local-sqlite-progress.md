# Local SQLite progress, Discord summaries

The operator rejected both a dedicated state channel and bookkeeping threads in Watched Channels as unnecessary setup and clutter. Store Channel Records, pending Link Post IDs and READY manifests in an automatically created local SQLite database; retain Discord reconciliation for Summary Threads and the single-machine OS lock. This supersedes ADR-0001's Discord-only storage decision and the Discord journal implementation in ADR-0007.

The database lives at `~/.local/state/discord-link-summarizer/progress.sqlite`, separately from `OPENCODE_DB`. Built-in `node:sqlite` works under the pinned Bun runtime and Node test runtime without another dependency. Each channel change is a synchronous SQLite transaction against the latest stored state; settlement advances its floor and clears settled entries in one commit. Dry-run opens existing progress read-only and creates no progress file when absent.

Machine-loss recovery now requires a progress backup or an explicit rescan from an operator-selected recovery Since, with Horizon wide enough to include it. A rescan reuses verified existing Summary Threads but cannot recover a lost READY manifest for an unfinished multipart draft; that Attempt may need regeneration. See the [recovery protocol](../recovery-protocol.md).
