# Summarizer implementation

Specification: [#1](https://github.com/ysm-dev/discord-link-summarizer/issues/1).

The specification and its linked tickets record the original implementation plan;
approved corrections below supersede conflicting requirements. The original plan
uses one PR branch; ticket branches merge when their dependencies are present.

```text
#2 Effect application and quality gates
 ├── #3 Config and pure lifecycle rules ──────┐
 ├── #4 Discord HTTP client ─────────────────┼── #10 Channel Records and lock
 │                                          │       └── #6 Runs and Attempts
 ├── #5 Private OpenCode server and sessions
 │    └── #9 Shared terminal-session publication ┘
 └── #7 Deployment and recovery runbook
```

The operator approved replacing the existing entry-shim coverage exception with
`apps/summarizer/src/index.ts`. All application logic remains subject to the
existing quality gates.

Bot creation, channel selection, installing the translate agent, and enabling the
crnd job are the human rollout steps listed in the specification.

## Approved corrections

Implementation research exposed contradictions in the original protocol. The
operator approved one-machine Run exclusion, durable channel-level progress in
Discord, `Manage Threads`, and structured extraction tools instead of generic
shell access. See ADR-0007 and ADR-0009. ADR-0010 subsequently replaced Discord
journals with local SQLite Channel Records while retaining Discord Summaries.

The operator originally required shared session visibility without upstream
changes. ADR-0008 used OpenCode's export/import API without sharing active execution
claims; #9 above records that historical publication work.

ADR-0012 supersedes only ADR-0008's publication and retention decision. Summaries
remain only in Discord. The persistent isolated `OPENCODE_DB` and separately
provisioned credentials remain, but every Attempt deletes its session after reading
the model result, with cleanup on success, failure, timeout and interruption.
Deletion failures warn; startup paginates and deletes all `metadata.summarizer`-owned
terminal sessions and unfinished sessions whose last update is older than
`summary_timeout` plus a two-minute grace, logging the leftover count after
successful cleanup when nonzero.
Normal Runs no longer discover the interactive service, export/import transcripts
or emit transcript-publication or transcript-maintenance timing phases. `delete_sessions` is
removed and rejected as an unknown config key. `progress.sqlite` is unchanged:
IDs, statuses and digests, not Summary text. Losing failure-transcript debugging
is intentional.

After deployment, the approved one-time global purge uses the service API to
select `metadata.summarizer` ownership and the exact translate `location.directory`
matching `opencode.directory`; it never deletes by title alone or broadly by
directory. Session deletion is not a forensic-erasure or file-size guarantee.

The durable discovery and publication handoff is specified in
[`recovery-protocol.md`](./recovery-protocol.md).
