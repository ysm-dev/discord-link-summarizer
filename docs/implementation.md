# Summarizer implementation

Specification: [#1](https://github.com/ysm-dev/discord-link-summarizer/issues/1).

The specification and its linked tickets are the acceptance criteria. All work
lands on one PR branch; ticket branches merge when their dependencies are present.

```text
#2 Effect application and quality gates
 ├── #3 Config and pure lifecycle rules ──────┐
 ├── #4 Discord HTTP client ─────────────────┼── #6 Runs and Attempts
 ├── #5 Private OpenCode server and sessions ┘
 └── #7 Deployment and recovery runbook
```

The operator approved replacing the existing entry-shim coverage exception with
`apps/summarizer/src/index.ts`. All application logic remains subject to the
existing quality gates.

Bot creation, channel selection, installing the translate agent, and enabling the
crnd job are the human rollout steps listed in the specification.
