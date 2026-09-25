# No Link Post is silently skipped

The recent-thread catch-up heuristic below is superseded by ADR-0007. It can
miss older Pending gaps after a partially successful Run.

Every Link Post after its channel's Since must end Done or Given up, however long the Summarizer was down. A Run normally re-checks only the Horizon. When a channel shows none of the Summarizer's threads within the Horizon, the Run checks that channel's archived threads to tell two cases apart:

- **The Summarizer has worked in the channel before.** The outage was longer than the Horizon, so the Run reads further back until it reaches the Summarizer's newest Summary Thread. It never reads past Since.
- **The Summarizer has never worked in the channel.** The channel is new, so the Horizon caps how far back its Link Posts are summarized. This protects against a channel that was added without its own Since and inherited an old global one.

## Considered Options

- **A fixed Horizon, plus a manual step after long outages to raise it.** Rejected, because forgetting that step silently loses Link Posts.

## Consequences

- A Run does nothing while the Mac's clock is more than a minute away from Discord's, as read from the `Date` header. After a power cut, a wrong clock would shift Since and the Horizon and silently skip Link Posts.
- Some failures are not the Link's fault: no network, Discord or OpenCode unreachable, a full disk, or an expired OpenCode login. These stop the Run without counting an Attempt, and the next Run tries again.
- Telling whether the Summarizer "has worked in the channel before" relies on its threads appearing among the channel's most recently archived threads. In a channel where people archive many threads of their own, the check could miss them.
