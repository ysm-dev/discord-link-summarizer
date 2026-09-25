# discord-link-summarizer

Summarizes links posted in selected Discord channels. An OpenCode model in the `translate` workspace writes each summary, and the summarizer posts it as a thread on the message that carried the link.

## Language

### Discord

**Watched Channel**:
A Discord text or announcement channel listed in the Summarizer's config.
_Avoid_: subscription, feed, monitored channel. A wachi "channel" is a named group of feed subscriptions, not a Discord channel.

**Link Post**:
A top-level message in a Watched Channel that contains a Link, posted by anyone except the Summarizer. wachi's own alerts are not Link Posts.
_Avoid_: item, entry, feed item

**Link**:
The first URL in a Link Post's text, taken exactly as posted. It is what a Summary is about.
_Avoid_: article, source

**Summary Thread**:
The public thread the Summarizer starts from a Link Post to hold its Summary.
_Avoid_: reply, comment thread

**Summarizer**:
This tool, together with the dedicated Discord bot it posts as. A thread belongs to the Summarizer only if that bot started it.
_Avoid_: bot (pany is also a bot), agent (an OpenCode term)

### Lifecycle

**Pending**:
A Link Post within the channel's eligible history that has no Summary Thread yet. Eligible history includes unfinished catch-up beyond the Horizon.
_Avoid_: new, queued, unprocessed

**In progress**:
A Link Post whose Summary Thread exists but doesn't hold a complete Summary yet. This includes the waits between Attempts.
_Avoid_: claimed, locked, running

**Done**:
A Link Post whose Summary Thread holds its complete Summary.
_Avoid_: summarized, completed, processed

**Given up**:
A Link Post whose last allowed Attempt failed (the third by default). It is never retried automatically; deleting its Summary Thread makes it Pending again when the Link Post is rediscovered.
_Avoid_: failed (an Attempt fails; a Link Post is given up), dead, abandoned

**Attempt**:
One try at summarizing a Link Post. It fails when OpenCode errors, runs out of time, or writes nothing. Problems that aren't the Link's fault don't count.
_Avoid_: try, retry

### Summarizing

**Summary**:
The text the model writes about one Link. It is the only thing the model produces.
_Avoid_: digest, TL;DR (a TL;DR is one section of a Summary)

### Operation

**Run**:
One invocation of the Summarizer by the scheduler. It resumes unfinished work from durable progress and checks the current Link Posts and Summary Threads.
_Avoid_: job (the crnd schedule entry), check (wachi's word), tick

**Horizon**:
How far back recent history is re-checked and how far back a newly added channel may initially be summarized. It does not discard unfinished catch-up.
_Avoid_: lookback, window, retention

**Channel Record**:
The Summarizer's durable record of a Watched Channel's onboarding and discovery progress. It distinguishes previously covered history from work still requiring discovery.
_Avoid_: recent-thread heuristic, local ledger

**Onboarding Floor**:
The earliest moment admitted when a Watched Channel is first activated. It preserves the initial backfill boundary across later Runs and outages.
_Avoid_: activation timestamp, moving Horizon

**Since**:
The moment from which a Watched Channel's Link Posts count. Older Link Posts are never summarized. One value applies to every Watched Channel unless a channel sets its own.
_Avoid_: start point, baseline (wachi's word), cutoff

### Quality enforcement (inherited from ts-template)

**Gate**:
A single automated check that blocks a merge when it fails. The gates are listed in `README.md`.
_Avoid_: rule, check, lint (a lint rule is one implementation of a gate, not a synonym)

**Silent false pass**:
A gate that exits 0 while enforcing nothing, usually because its inputs failed to resolve. The failure mode the template is designed around, and the reason `verify-gates` exists.
_Avoid_: false negative, silent failure

**Exception**:
A named, reasoned, human-approved waiver of one gate for one path. Lives in `quality-exceptions.json` when it covers a whole file, or as an inline suppression carrying `-- <reason>` when it covers a single line.
_Avoid_: ignore, suppression, disable, override, waiver

**Tier**:
Where a gate runs: pre-commit, pre-push, or CI. Tiers exist because gates differ by orders of magnitude in cost, not because they differ in importance.
_Avoid_: stage, level, phase

**Archetype**:
One of the two shapes a workspace package may take. A **library** lives in `packages/` and is consumed by other workspace packages; an **application** lives in `apps/` and is the thing that runs.
_Avoid_: kind, category, template (overloaded here), project

**Just-in-Time package**:
A workspace package whose `exports` points at TypeScript source, with no build step and no emitted `dist/`. The only package shape this repo supports.
_Avoid_: source package, unbuilt package, internal package

**Trust boundary**:
A function that accepts untrusted input as `unknown` and narrows it before anything downstream sees it. The only place `unknown` may be declared, and the only accepted justification for suppressing the `unknown` ban.
_Avoid_: validator, parser, guard (a type guard is a tool used at a trust boundary, not the boundary itself)
