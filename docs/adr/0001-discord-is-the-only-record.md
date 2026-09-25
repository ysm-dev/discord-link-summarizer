# Discord is the only record of progress

Superseded by [ADR-0010](0010-local-sqlite-progress.md). The following records the original decision.

The Summarizer keeps no local state. Every Run works out which Link Posts are done, in progress, or still pending from Discord alone, reading the messages within the Horizon, the threads started from them, and the Summarizer's own marks. We chose this over a local ledger such as wachi's SQLite outbox for three reasons. The result has to live in Discord anyway. A second record can drift from it when messages or threads are deleted. And the machine can be wiped, or be down for days, without losing anything.

## Consequences

- Anything the Summarizer must remember has to be written into Discord, where people can see it.
- The bot's identity is part of the record: a thread counts as the Summarizer's only if its own bot started it. For that reason the Summarizer never shares a bot token with another bot, such as pany.
- Each Run re-reads every Watched Channel back to the Horizon, and further after a long outage (ADR-0004). That re-read is the price of having no local state.
