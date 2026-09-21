# ADR 0006: Remote source identity, recovery, and media ownership

## Status

Accepted — v0.4 Packet 1, 2026-09-18.

## Context

OpenRepurpose v0.4 observes items on remote source accounts and eventually feeds authorized media
into the existing workflow, job, media, and destination pipeline. A source may return the same item
on every poll, reorder pages, repeat an event, or change an opaque cursor. The process may stop after
any durable or remote operation. Remote publishing APIs generally cannot promise exactly-once
effects, and a remote source file may be either a user's irreplaceable local original or disposable
OpenRepurpose working data.

The design therefore needs durable identities and checkpoints before Packet 2 adds polling and
before later packets add media resolution, execution, and cleanup.

## Decision

### Source connections, cursors, and watermarks

A `source_connections` row identifies one configured source using the unique pair
`(adapter_id, external_source_id)`. `account_id` is an optional local credential/account reference;
it is not the source identity. Adapter configuration is browser-safe JSON. Secrets remain in
`SecretStore`.

The adapter cursor is opaque. OpenRepurpose stores it as `cursor_json` and never derives item
identity from it. A `(published_at, external_id)` watermark is stored separately when the adapter
can provide ordered publication times. The timestamp orders observations and the external ID is a
deterministic tie-breaker for equal timestamps. Neither cursor nor watermark is a correctness
boundary: they reduce polling work, while persisted item identity performs deduplication.

A polling transaction must follow this order:

1. validate the adapter page;
2. upsert every observed item and create any intended workflow execution records;
3. commit those records; and
4. only then persist the returned cursor/watermark and successful-poll timestamps.

If the process stops before step 4, the page may be fetched again and deduplicated. Advancing the
cursor before durable item persistence is forbidden because it could lose an item permanently.

### Source item identity and deduplication

`SourceAdapter.poll` is detection-only and returns a stable, non-empty `externalId` within the
source connection. Event IDs are optional delivery/audit identifiers; they may change when the same
item is redelivered and never replace the stable item identity.

`source_items` enforces both `(source_connection_id, external_id)` and
`(source_connection_id, dedupe_key)` uniqueness. The dedupe key is an application-generated,
versioned canonical key based on adapter/source identity and the stable external item ID. Repeated
observations update `last_observed_at` and refresh permitted metadata; they do not create another
source item. Reordered pages and cursor rollback are therefore safe.

The generic source contract uses JSON-serializable metadata, opaque cursors, RFC 3339 publication
timestamps, and rejects blank or duplicate external IDs within a page. Media resolution is not part
of this contract and remains behind the later `MediaResolver` boundary. ADR 0009 further separates
optional external-downloader infrastructure beneath that resolver boundary; source adapters only
provide a generic locator when advertising that resolution strategy.

### Observed state is not completed state

A durable source item exists as soon as it is observed, before downloading or publishing anything.
Its lifecycle is explicit:

```text
observed -> queued -> resolving -> media_ready -> processing -> publishing
          -> partial_failure -> retrying -> published -> cleanup_pending -> completed
```

`failed` is also explicit. File existence, cursor position, and a successful first destination do
not imply completion. `completed_at` is present only for the `completed` source-item state.
Resolution has a separate state (`unresolved`, `resolving`, `ready`, `unavailable`, or `failed`) so
an observed item remains visible even when no authorized media can be resolved.

### Workflow execution uniqueness and snapshots

Each source-triggered execution has these durable identities:

- `source_item_id`: the observed item;
- `workflow_key`: the immutable identity of the workflow even if the live workflow is later
  deleted;
- `workflow_version`: a stable version of the selected immutable workflow snapshot; and
- `snapshot_json`: the complete source metadata, filters already evaluated, rendered inputs,
  destination set, required/optional flags, and retention choice used by the execution.

The database unique constraint on `(source_item_id, workflow_key, workflow_version)` allows at most
one intended execution for that item and workflow version. Poll redelivery must look up this record,
not enqueue another execution. A normal workflow edit applies only to newly selected items and does
not silently replay old source items. A future explicit user reprocess/republish action must create
a deliberate new version/reprocess identity and audit record; it must never erase or reset the old
execution.

The nullable live `workflow_id` uses `ON DELETE SET NULL`, while `workflow_key` and `snapshot_json`
remain. Deleting a workflow therefore cannot delete its history or mutate an in-flight execution.

### Independent destination persistence and recovery

`source_execution_destinations` contains one row per destination snapshot entry, keyed by
`(execution_id, destination_key)`. A destination key distinguishes platform/account/target entries;
the platform ID alone is insufficient when a workflow publishes to multiple targets on one
platform. Each row independently records:

- required versus optional;
- queue `job_id` and a globally unique idempotency key;
- pending/running/waiting/retrying/succeeded/failed/cancelled state;
- attempt count and last classified error; and
- remote operation ID, URL, and completion time.

The existing `jobs` table remains the queue/retry engine, and `destination_job_records` remains the
adapter's detailed remote-operation checkpoint. The new destination row is the workflow-level
result linking that job to the source execution; it is not a second publisher or queue.

Before scheduling or recovering destination work, the application reads these rows and selects only
unfinished/failed destinations. A `succeeded` row is a terminal checkpoint: a database trigger
rejects regression to a runnable state, and the domain predicate excludes it from retry. The same
idempotency key is reused for retries of the same intended destination operation. The remote ID is
persisted before dependent status checks.

This provides at-most-one intended local operation and prevents blind republishing after restart.
It cannot promise exactly-once effects across a remote API if the process stops after the remote
side accepts a request but before the local success/remote ID is committed. Adapters must use the
platform's idempotency token, resumable operation ID, or reconciliation API when available. When
none exists, recovery must surface an ambiguous result for user reconciliation rather than
automatically starting a second publish.

### Media ownership

Every source-related file reference has an explicit ownership discriminator:

| Ownership                 | Meaning                                                              | Automatic deletion |
| ------------------------- | -------------------------------------------------------------------- | ------------------ |
| `user_owned_original`     | Existing local file supplied/owned outside managed temporary storage | Never              |
| `openrepurpose_temporary` | Source bytes downloaded/copied into a managed execution directory    | Policy-controlled  |
| `openrepurpose_generated` | Derivative generated by OpenRepurpose in managed temporary storage   | Policy-controlled  |

`source_media_artifacts` is history/provenance, not a delete queue. Its database constraints force
a user-owned original to remain `protected`, forbid a `deleted` state/deletion timestamp for it,
and reject deletion of artifact history rows. Only managed ownership variants can become cleanup
candidates. The later cleanup service must additionally resolve and validate every candidate path
under the configured managed temporary root immediately before deleting it; ownership does not
make an arbitrary path safe. Cleanup APIs must accept a managed-artifact type/candidate rather than
a raw path. No source adapter or workflow handler may call filesystem deletion for source media.

These rules guarantee that remote-media cleanup has no state transition or cleanup input capable
of selecting a user-owned local original. The filesystem implementation in Packet 4 must preserve
that guarantee with managed-root containment checks, including symlink/reparse-point handling.

### Retention and cleanup eligibility

Retention is captured in the immutable execution snapshot and normalized into one of:

- `delete_after_success`: default for downloaded/generated remote media; due immediately after all
  required destinations succeed;
- `keep_for_duration`: due only after all required destinations succeed plus a positive duration;
- `keep_forever`: explicit opt-in; automatic cleanup remains `retained` and never becomes eligible.

Optional destination failure does not block cleanup. Any required destination in a state other than
`succeeded` does block cleanup, including retryable failure, waiting, cancellation, or an ambiguous
remote result. The database rejects advancing an execution to an eligible/running/completed cleanup
state while a required destination is incomplete. Cleanup failure is recorded independently and
does not turn a successfully published workflow into a publication failure.

Terminally failed/abandoned executions may gain a separately configured failure-retention policy in
the cleanup packet. That policy still applies only to OpenRepurpose-managed artifacts and must not
reuse the success-retention transition.

### Crash and restart boundaries

Recovery is based on committed records, not inferred file state:

| Stop point                                       | Recovery behavior                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Before source item commit                        | Cursor was not advanced; observe again                                                                |
| After item commit, before execution creation     | Find the observed item and create the missing unique execution                                        |
| After execution creation, before cursor advance  | Redelivered item conflicts with the same execution identity; continue it                              |
| After media resolution                           | Reuse a valid managed artifact; do not redownload merely because the process restarted                |
| After destination A succeeds, before B starts    | A's terminal row is skipped; schedule/retry B only                                                    |
| Remote request accepted, local outcome ambiguous | Reconcile through persisted operation/idempotency data; do not blindly publish again                  |
| After every required destination succeeds        | Mark cleanup eligible according to retention                                                          |
| After success, before cleanup                    | Recover from eligible/scheduled cleanup state                                                         |
| During cleanup                                   | Reconcile artifact state/path idempotently; a missing managed file is success, while errors stay open |

Leases and bounded retries continue to come from the existing persistent job runner. This packet
does not add the poll runner, resolver, workflow executor, or cleanup runner.

### Persistent history after file cleanup

Deleting managed bytes updates the artifact row to `deleted` with `deleted_at`; it does not delete
the row. Source item metadata, observation timestamps, resolution history, immutable execution
snapshot, destination status/remote IDs, job attempts, and cleanup audit data live in independent
durable rows and survive temporary-file deletion. A nullable link to `media_assets` may be cleared
without removing source or execution history.

## Consequences

- Migration `0011_source_domain` adds source connections, items, workflow executions, independent
  destination results, and media-artifact ownership/audit tables without changing prior migrations.
- v0.3 databases migrate additively; current job and destination checkpoints remain intact.
- Packet 2 must implement transaction ordering for item persistence before cursor advancement.
- Packet 4 must implement managed-root storage and cleanup using the ownership and retention
  boundaries above.
- Packet 5 must bind source executions to the existing job pipeline, persist every destination
  transition, and recover only destinations that do not have terminal success checkpoints.
- Exactly-once remote publication is not claimed; durable intent, idempotency, and reconciliation
  narrow the ambiguity honestly.
