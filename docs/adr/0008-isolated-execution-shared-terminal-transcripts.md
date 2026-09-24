# Isolate execution and publish completed sessions

The operator requires completed Summarizer sessions in the interactive session
list, prohibits upstream changes, and requires interactive use to remain
undisturbed. OpenCode v2.0.15's managed restart sweep can resume private executions
when both processes share a database. The existing session export/import API
provides shared visibility without sharing active execution claims.

The private server uses a persistent dedicated `OPENCODE_DB` with separately
provisioned credentials. Terminal owned sessions are exported and imported into
the already-running interactive service at the translate location. Imported
transcripts preserve session identity and contain no execution claim. The
Summarizer discovers the service without starting, replacing, or restarting it.

Publication is eventual: retain terminal private sessions and retry when the
interactive service is available. An existing session ID must match the expected
transcript before an ambiguous import is considered successful. Publication
failures do not consume Attempts. `delete_sessions: true` opts out of retention
and publication. Active sessions are visible only on the private server.

The implementation calls `@opencode/client/service` v2.0.15 `Service.discover()`
(never `ensure`), uses its authenticated endpoint, and sends the raw export
`{data:{info,messages}}` as `{info,messages,location:{directory}}` to the
experimental import route. Import preserves the ID. A 409 or lost reply is
reconciled against a target export: ID, location, ownership, title, model,
outcome, immutable session details, and all settled messages must match.
After verification the private session is marked via v2.0.15's
`PATCH /api/session/:sessionID` metadata endpoint (which replaces the metadata
object). The marker preserves other private metadata; a lost PATCH reply is
confirmed by reading the private session. Later Runs skip marked sessions and
retry unmarked sessions oldest-first. Only the private marker is excluded from
source identity comparisons; target metadata must match exactly. The private
copy remains for retry, and the target receives no later private mutations.
Transfers are limited to 2 MiB and 15-second requests, with bounded discovery
and sweep.
The verified v2.0.11 and v2.0.15 transfer handlers share this contract; an
unavailable or incompatible target defers publication.
The v2.0.15 route was also exercised between two disposable isolated databases
without a model: a terminal fixture with user, settled assistant, and idle
messages retained its ID, location, outcome, complete messages, and no active
claim after import. Neither database was the interactive database.

The private database holds credentials and inspectable transcripts, not Discord
progress. Transcript backup remains out of scope. This supersedes ADR-0002's
shared execution database and next-Run sweep as an isolation mechanism.
