# Remote-source delivery and recovery semantics

OpenRepurpose v0.4 provides durable, exact-once-ish orchestration. It does **not** guarantee
exactly-once delivery to an external platform API.

## What is deduplicated locally

- A source item is unique by source connection plus the adapter's stable external item ID.
  Repeated polls, reordered pages, and a replayed cursor update the observation instead of creating
  another item.
- A source workflow execution is unique by source item, workflow key, and the SHA-256 version of
  its immutable workflow/source snapshot. Editing a workflow affects later observations; it does
  not mutate an execution already in progress.
- Each snapshotted destination has one durable destination key and one durable idempotency key.
  Its publish job uses the normal OpenRepurpose destination handler and job queue. A successful
  destination checkpoint is terminal and is excluded from restart and retry selection.
- An explicit retry requeues only destination jobs recorded as failed. It retains their original
  local idempotency keys and never resets a successful destination. A future explicit republish
  operation must use a new audited execution/republish identity; it must not erase a prior success.

These rules provide at most one _intended local operation_ for a source item, workflow version, and
destination. They prevent a restart from blindly publishing destinations whose success was already
committed.

## External API ambiguity

There is an unavoidable boundary between a remote API accepting a publish request and
OpenRepurpose committing the returned remote ID/success state to SQLite. If the process stops in
that interval, OpenRepurpose cannot prove that the remote side did or did not accept the request.
Therefore exactly-once external delivery is not claimed.

Destination adapters must reuse a platform idempotency token, resumable operation ID, or status
reconciliation API when the platform offers one. Their operation checkpoints remain in
`destination_job_records` and are copied to the source destination result. When the platform offers
no safe reconciliation mechanism, an ambiguous result must remain visible for user reconciliation;
the system must not automatically start a fresh publish merely because the local success commit is
missing.

## Crash recovery checkpoints

- Before execution-job creation: the unique pending execution is found at startup and its
  idempotent execution job is created.
- After job creation: the persistent queue claims the existing job after restart.
- After one destination succeeds: that destination's terminal result is skipped; only unfinished
  or explicitly retried failed destinations run.
- After all required destinations succeed: SQLite marks the execution cleanup-eligible according
  to its snapshotted retention policy. Optional destination failure does not block eligibility.
- During cleanup: cleanup resumes from the execution/artifact state. Missing managed files count as
  successful cleanup, errors remain visible and retryable, and user-owned originals are protected.

Source metadata, immutable snapshots, destination results and remote IDs, job attempts, and media
artifact audit rows remain after managed temporary bytes are deleted.
