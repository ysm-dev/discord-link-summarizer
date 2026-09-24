# Summaries run on a private OpenCode server driven over HTTP

Each Run starts its own `opencode serve --stdio` in the `translate` workspace. It drives that server through OpenCode's HTTP API: create a session, run the channel's command on the Link, wait for it to finish, and read the final assistant text as the Summary.

## Considered Options

- **`opencode run` (rejected).** In OpenCode v2.0.15 it sends `/summarize …` to the model as plain text, so the command template never applies. It also ignores the configured model variant, and killing the process does not stop the work.
- **The shared background service (rejected).** It shares its environment, version and restarts with interactive use. Its plugins would also announce every Summary on Discord.
- **The `opencode-run-server` plugin (rejected).** It returns neither the session nor the text.

## Consequences

- A dedicated `summarizer` agent in translate's `.opencode/agents/` holds the model, the variant and the permission allowlist. When a session selects an agent, OpenCode does not switch to that agent's model, so the Summarizer reads the agent's model and variant and sets them on every session.
- The Run controls the server's environment, including `PATH`, `PWD` and `OPENCODE_DB`. It switches off `opencode-discord-noti` and `opencode-run-server` for that server only.
- A session cut off mid-run stays "suspended" in the shared OpenCode database, and the background service resumes suspended sessions the next time it starts. The Summarizer must therefore clean up its own orphaned sessions.
