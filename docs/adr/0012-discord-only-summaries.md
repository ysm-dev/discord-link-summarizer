# Keep Summaries only in Discord

The operator no longer wants OpenCode transcript publication or retention and intentionally gives up transcript debugging for failed Attempts. Delete every Attempt's session after reading its model result, with cleanup on success, failure, timeout and interruption, so Summaries remain only in Discord. This supersedes only ADR-0008's publication and retention decision: keep the private persistent `OPENCODE_DB` and independently provisioned credentials for isolated active execution.

## Consequences

- Failed deletion warns; each startup paginates and deletes all `metadata.summarizer`-owned terminal sessions and unfinished sessions whose last update is older than `summary_timeout` plus a two-minute grace, logging the leftover count after successful cleanup when nonzero.
- Normal Runs do not discover the interactive service, export/import or publish transcripts, or emit transcript-publication or transcript-maintenance timing phases. Remove `delete_sessions`; unknown config keys are rejected. `progress.sqlite` remains unchanged, holding IDs, statuses and digests, not Summary text.
- After deployment, the approved one-time global purge selects `metadata.summarizer` ownership and the exact translate `location.directory` matching `opencode.directory` through the service API, then deletes only those IDs. No title-only or broad directory/database deletion; no forensic-erasure or file-size guarantee. See the [recovery protocol](../recovery-protocol.md#opencode-session-cleanup).
