# Summarizer implementation

Specification: [#1](https://github.com/ysm-dev/discord-link-summarizer/issues/1).

The specification and its linked tickets are the acceptance criteria. All work
lands on one PR branch; ticket branches merge when their dependencies are present.

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
shell access. See ADR-0007 and ADR-0009.

The operator requires shared session visibility and prohibits upstream changes.
ADR-0008 preserves completed-session visibility using OpenCode's existing
export/import API, without sharing active execution claims.

The durable discovery and publication handoff is specified in
[`recovery-protocol.md`](./recovery-protocol.md).
