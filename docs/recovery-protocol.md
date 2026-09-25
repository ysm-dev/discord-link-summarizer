# Durable Run recovery

This specifies the operator-approved corrections to issue #1 and ADR-0007.
Tickets #10 and #6 implement the protocol. Discord remains the progress record.

## Machine lock

Every invocation, including dry-run, acquires the same machine-wide kernel lock
before Discord access or OpenCode startup. Contention logs a skipped Run and
returns 0; other acquisition failures return 1. The supported deployment uses
one macOS machine and one Unix user. Configuration paths do not partition locks.

The Bun Run owns an open descriptor on a stable, private local lock file. Use
macOS `lockf -t 0 3` with that descriptor inherited as FD 3, and retain the Bun
descriptor after the helper exits. Verified on Bun 1.4.2: a contender receives
exit 75 until the owning descriptor closes. Do not use a command wrapper that
owns the lock while an independently surviving child performs the Run. Never
unlink, replace, or truncate the lock file. Close the descriptor only after all
Run fibers and cleanup have finished; process death releases it in the kernel.

The lock file contains no progress and may be recreated after machine loss.
Cross-machine writers and non-cooperating programs are outside this contract.

## Channel Records

`state_channel_id` identifies a dedicated Discord text channel, distinct from
Watched Channels. The bot needs View Channel, Read Message History, Send Messages,
Create Public Threads, Send Messages in Threads, and Manage Threads there. This
supports announcement Watched Channels without relying on standalone threads in
announcement channels.

Each Watched Channel has a bot-authored record message and a public journal
thread started from that message. The shared message/thread ID is its durable
address. Index the state channel's complete history, checking author, version,
and Watched Channel identity. Ambiguous records, malformed records, or a missing
journal whose parent survives fail visibly. Dry-run reads records but never
initializes them; it reports an uninitialized channel's proposed start.

A Channel Record preserves:

- the Onboarding Floor, initially capped by the Horizon and effective Since;
- the effective Since last applied;
- a settled history floor, separate from a discovery cursor;
- a bounded scan epoch's upper message ID and next `before` cursor;
- an optional recent-rescan `before` cursor, frozen lower-bound Snowflake and
  effective Since, plus the oldest deleted-thread reset candidate seen so far;
- whether the epoch is being discovered or worked.

Message IDs are compared as integers. The settled floor is exclusive. The
journal records deterministic page keys and every eligible Link Post ID on each
page. A Link Post may be pending, ready for commit, or terminal. Split records to
respect Discord's message limit. Duplicate identical page records can be
reconciled; divergent records must not be guessed away.

## Discovery and ordering

1. Snapshot an epoch's highest actual message ID, then scan newest-to-oldest,
   at most 100 messages per request, down to its settled floor.
2. Persist every eligible ID in a page before checkpointing the next cursor.
   A lost reply requires read reconciliation before any cursor advances.
3. Continue an unfinished scan in the next Run when the budget is exhausted.
   Do not start newer work while an undiscovered older interval could contain
   eligible Link Posts.
4. Once discovery finishes, process due journaled IDs oldest-first across
   channels with the configured concurrency. A waiting retry need not block
   other due Attempts. Re-read the source and its thread; journal entries are
   references, not a substitute for thread state and ownership checks.
5. Advance the settled floor only after every ID in the epoch is verified Done,
   Given up, deleted, excluded, or owned by someone else's thread. Persist that
   checkpoint before garbage-collecting settled journal entries.

A younger successful Attempt cannot conceal an older unresolved ID. A failed
or ambiguous state write never advances discovery or settlement. Repeated Runs
continue the journal instead of rescanning the entire historical gap.

Recent-Horizon rescans detect deleted completed Summary Threads and deliberate
Since backfills. Journal a reset before rewinding and restarting discovery;
retain and deduplicate existing unresolved IDs. Moving Since forward may exclude
new Pending work, but must not discard already-started In-progress work.
Changing the Horizon must not jump an existing settled floor.
Recent rescans snapshot the newest message and persist their cursor and any
reset candidate after each complete page or when their share of the half-Run
time slice is spent. A completed single-page rescan needs no marker write. An
interrupted rescan resumes from that cursor in the next Run; a Since
change restarts it with a fresh boundary. It completes before applying a floor
rewind using the frozen boundary, then clears its cursor. Already-journaled work may run during a partial
recent rescan only after historical discovery and archived adoption complete;
an incomplete initial-history scan still blocks all newer Attempts. At Attempt
admission the current Since excludes an unstarted Pending post (even if already
journaled), while a freshly verified bot-owned In-progress thread, including a
READY thread, remains eligible before Since.
When an eligible journaled READY source's whole Summary Thread was deleted,
clear its old manifest to Pending before claiming a replacement thread. Dry-run
also reads archived and active bot-owned In-progress threads outside its normal
history bound; if its deadline interrupts that enumeration, it labels the
reported counts partial.

Journal references address archived Summary Threads directly by source message
ID. Recovery also enumerates active and public archived bot-owned In-progress
threads so existing work, including work before a later Since, is adopted.
Archived pagination uses archive timestamps and `has_more`; a recent-page sample
does not establish absence. Reopen an archived In-progress thread before work.

## Publication handoff

A non-In-progress Done thread must contain the complete Summary. Multipart
drafts can be visible while its name still starts with ⏳.

After posting all Summary parts, read them back and verify their order/content.
Persist a READY journal record containing the part count and a digest of the
length-delimited ordered parts. Only after that record is durable may Attempt
notes be deleted and the name-plus-archive commit be sent.

After a crash, READY plus matching parts permits finishing the commit without
another model call or counting the successful Attempt as a stale failure. A
mismatch in an existing thread fails visibly. Deliberate deletion of the whole
Summary Thread clears READY and resets its still-eligible source to Pending.
Parts written before READY are drafts; recovery must not infer completeness
from them. Human-authored messages are never deleted or modified.

Reconcile uncertain thread creation by its source ID, uncertain notes/parts by
thread history, and uncertain commits by thread and part state. Short-lived
Discord nonce deduplication is supplementary, not a durable claim or journal.

## Explicit boundaries

- Known infrastructure failures do not count when an interrupted note can be
  recorded. An unreachable Discord can leave a started note that later counts
  as stale, as ADR-0003 already acknowledges.
- Deleting a completed Summary Thread is detected while its source is journaled
  or within the rechecked Horizon. Arbitrary ancient deletions require explicit
  backfill; bounded incremental discovery cannot notice every historical edit.
- Deleting both a Channel Record parent and its journal removes all evidence of
  onboarding. This is a destructive reset. Detecting it automatically requires
  another retained locator; preserve the dedicated state channel during recovery.
- Removed Watched Channels are paused. Restore them to the configuration to
  finish their retained work; removing a channel must not delete its records.
- Dry-run must identify partial discovery rather than present partial counts as
  complete when the Run deadline prevents finishing a read-only scan.
