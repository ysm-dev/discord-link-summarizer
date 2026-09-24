# One writer and durable Channel Records

Discord cannot atomically claim an existing retry thread. The operator approved
one supported machine with an OS-held lock covering manual and scheduled Runs,
instead of adding a distributed coordinator. A Run must hold that lock through
its writes and cleanup; process death must release it without unsafe stale-file
takeover. Cross-machine concurrent writers are outside the supported contract.

The operator also approved durable Channel Records in Discord. A recent Summary
Thread does not prove older history is complete: a later successful Attempt can
hide an earlier unclaimed gap. Records preserve the Onboarding Floor and discovery
progress; progress must not advance past work that has not been durably accounted
for. Recovery includes archived In-progress threads, including those before a
later Since. The concrete record and pagination protocol belongs in the Run
implementation specification.

This supersedes the ownership and discovery heuristics in ADR-0003 and ADR-0004.
Discord remains the only record of Summarizer progress (ADR-0001). The operator
approved `Manage Threads`, which Discord documents as required for the final
rename-and-archive request.
