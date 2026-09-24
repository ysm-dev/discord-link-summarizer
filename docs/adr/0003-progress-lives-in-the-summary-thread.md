# Progress lives in the Summary Thread

ADR-0007 supersedes the overlapping-Run claim and adds durable Channel Records.
Thread creation alone does not lock an existing retry thread.

Each Link Post's progress is recorded in its Summary Thread. Because of ADR-0001 it can't live in a database, and the thread is the only other place readers already look.

When the first Attempt begins, the Summarizer starts the thread with a ⏳ at the front of its name and the longest auto-archive setting (1 week). Discord allows one thread per message, so starting the thread also acts as the lock.

Before each Attempt, the Summarizer posts a one-line note in the thread, then edits it with the outcome.

- **On success:** it posts the Summary, deletes the notes, then renames the thread without the ⏳ and archives it in the same request. That request is the commit.
- **After the third failed Attempt:** it renames the thread with a ⚠️ in front and archives it in the same request, leaving the notes in place.

Only In-progress threads stay active. That keeps the server under Discord's limit of 1,000 active threads, and it lets a Run find leftover ⏳ threads in the server's list of active threads.

## Considered Options

- **Summarize first, then create the thread and mark it done with a ✅ reaction on the Link Post.** Rejected: readers see nothing for minutes, and every Link Post in the channel ends up with a reaction.
- **A pinned start marker in each channel.** Rejected in favour of a `since` value in the config.

## Consequences

- Two Runs may work at the same time, for example a manual run beside crnd, or a second machine. An Attempt note younger than the Summary time limit plus a margin marks a live Attempt, and other Runs leave that Link Post alone.
- An older note with no outcome counts as a failed Attempt, whether a crash, a power loss or a lost network left it that way. So a Link Post that crashes the Summarizer can't loop forever, and a network loss can cost each In-progress Link Post one Attempt.
- A Run that is told to stop (SIGTERM) first records its interrupted Attempts as not counted, then exits.
- The Summarizer finishes, or gives up on, every ⏳ thread, even when its Link Post has since fallen outside the Horizon or before a later `since`.
- Deleting a Summary Thread makes its Link Post Pending again.
- The Summarizer only ever writes in threads it started. A Link Post that someone else started a thread on is never summarized.
