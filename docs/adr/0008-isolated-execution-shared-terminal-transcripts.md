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

The private database holds credentials and inspectable transcripts, not Discord
progress. Transcript backup remains out of scope. This supersedes ADR-0002's
shared execution database and next-Run sweep as an isolation mechanism.
