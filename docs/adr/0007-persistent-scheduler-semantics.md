# ADR 0007: Persistent scheduler semantics

## Status

Accepted — v0.5 Packet 1, 2026-09-19.

## Context

OpenRepurpose v0.5 adds one-time publishing, recurring source/workflow triggers, and
destination-specific holds. These operations must remain correct when the process is stopped,
restarted, or offline across one or more due times. Calendar schedules also need an explicit civil
time model because a local wall time can be nonexistent or repeated at a daylight-saving
transition.

The v0.4 implementation already has two relevant durable execution paths:

- `SourcePollingRunner` owns source adapter calls, cursor advancement, observation deduplication,
  retry delay, and authorization-failure pausing. It persists `source_connections.next_poll_at` and
  hands observations to the normal queue as idempotent `source.item.observed` jobs.
- `JobRunner` owns persisted work, `available_at`, leases, bounded attempts, retry delay,
  cancellation, and crash recovery. `jobs.idempotency_key` is globally unique, and workflow
  destination records retain their own stable idempotency keys and remote checkpoints.

Scheduling must extend those paths instead of creating a second source poller, publisher, or job
executor. It also must not use process-local timers or an operating-system cron service as the
source of truth, because both would lose state or diverge between Windows, Linux desktop, and a
future headless Linux deployment.

## Decision

### Persist schedules and materialized occurrences

The scheduler is a local application service backed by SQLite. A short server-owned loop scans
persisted due times and materializes occurrences. It does not execute adapters, workflows, or
publishing operations itself. Materialized work always enters the existing `JobService` and is
executed by `JobRunner` or, for source polling, is handed to the existing source-poll application
boundary described below.

Packet 2 will persist two concepts:

1. A **schedule** contains its status, target, recurrence definition, IANA timezone, revision,
   next occurrence UTC instant, and denormalized last-occurrence/result data for inspection.
2. A **schedule occurrence** is an immutable record of one intended firing. It contains the
   schedule ID and revision, nominal UTC instant, target snapshot/version, dispatch state, linked
   job ID when applicable, and outcome. Occurrence history is retained when a schedule is edited,
   paused, cancelled, or completed.

`next_occurrence_at` is an integer UTC instant in SQLite and is the scheduler's durable wake-up
checkpoint. Process timers may wake the loop efficiently, but they never define correctness.

The schedule target is typed and versioned rather than arbitrary executable JSON. An occurrence
captures the target data or validated workflow-plan version used for that firing before dispatch.
Editing a workflow or schedule cannot mutate an already-materialized occurrence or its job input.
Recurring future occurrences may use the then-current validated workflow version; every occurrence
records which version it selected.

### Recurrence format and library

Recurring schedules use a versioned representation equivalent to:

```ts
interface CronRecurrenceV1 {
  readonly format: 'cron-v1';
  readonly expression: string;
  readonly timeZone: string;
}
```

`cron-v1` is the five-field Croner 10 cron syntax: minute, hour, day of month, month, and day of
week. Seconds and year fields are not accepted in v0.5, so the minimum recurrence is one minute.
Day-of-month and day-of-week use Croner's default OR behavior (`domAndDow: false`). A fixed UTC
offset is not a timezone and the `utcOffset` option is not used.

Packet 2 will add an exact pin of the current supported Croner 10 release and record it in the
lockfile. Croner is used only to validate an expression and calculate previous/next instants with
an explicit `timezone`; OpenRepurpose will not register Croner callbacks or treat Croner's
in-memory timer/control API as durable state. The dependency is small, has TypeScript declarations,
supports current Node.js, has no runtime dependencies, documents its DST behavior, and is actively
maintained. A version upgrade requires the scheduler contract tests to pass before the pin changes.

Raw cron is the storage/interchange form. The UI may initially offer structured presets and a
readable summary instead of exposing every syntax feature, but it must round-trip the persisted
expression without inventing a second recurrence model.

### One-time representation

A one-time schedule stores all of the following:

- the user's requested local date and time for display and audit;
- the explicit IANA timezone ID used to interpret it; and
- the resolved UTC instant used for ordering and execution.

An RFC 3339 instant supplied by an API client can be accepted only after it is also associated with
the display timezone. The scheduler never reparses a wall-clock string during dispatch. Once the
one-time schedule is accepted, its resolved UTC instant is authoritative even if the host timezone
or timezone database changes later.

### IANA timezone and DST policy

Every calendar schedule has an explicit valid IANA timezone such as `Asia/Riyadh` or
`America/New_York`. The browser's or server's current timezone may be offered as a creation
default, but it is never an implicit persisted value. Abbreviations such as `EST`, locale names,
and bare numeric offsets are rejected. All comparisons, leases, due scans, and job `available_at`
values use UTC instants.

The civil-time policy is:

- A **one-time nonexistent local time** in a spring-forward gap is rejected at creation. The UI/API
  must ask for a valid local time rather than silently shifting it.
- A **one-time repeated local time** in a fall-back overlap resolves to the earlier occurrence,
  matching the recurring policy. The UI/API must show the resolved offset and UTC instant before
  save so the result is explicit. Selecting the later fold is outside v0.5.
- A **recurring occurrence in a spring-forward gap** is skipped. It does not run at a shifted wall
  time and does not consume a retry attempt.
- A **recurring occurrence in a fall-back overlap** runs once at the first occurrence. It never
  runs twice for the two offsets.

These are Croner's documented DST semantics and become OpenRepurpose contract semantics. Packet 2
must add deterministic tests with a timezone that has DST and must run them with a host timezone
different from the schedule timezone. The implementation must reject a result that cannot be
round-tripped to the requested one-time local representation; it must not rely on JavaScript
`Date` parsing of an offset-free string.

For recurring schedules, a persisted `next_occurrence_at` remains authoritative until it is
materialized. Later occurrences are calculated with the timezone data available at that time. This
means a timezone-database update does not silently move an already-promised next run, while future
runs follow the updated civil-time rules. The schedule's IANA zone and recurrence expression remain
available for audit and display.

### Restart and misfire semantics

The scheduler performs a due scan on startup before waiting for its normal polling interval. A
schedule is due when it is active and `next_occurrence_at <= now` according to the injected clock.

- An overdue **one-time** schedule is materialized exactly once and then becomes completed. It is
  caught up no matter how long the process was offline unless the user cancelled it.
- An overdue **recurring** schedule materializes at most one catch-up occurrence per recovery scan.
  If several nominal times elapsed while OpenRepurpose was offline, they are coalesced into one
  firing identified by the persisted oldest due instant, and the next instant is advanced to the
  first recurrence strictly after the scan time. Skipped/coalesced coverage is recorded for
  history. This prevents an upload or poll storm after a long outage.
- A paused recurring schedule does not accumulate catch-up work. Resume calculates the first
  occurrence strictly after the resume instant. A paused one-time schedule retains its requested
  instant and fires once immediately when resumed if overdue.

Materializing an occurrence and advancing/completing the schedule happen in one SQLite
transaction. Dispatch may be a separate step so the core does not need a cross-repository
transaction API: an occurrence first enters a durable `pending_dispatch` state, and recovery scans
that state until its deterministic job is linked. The important crash boundaries are:

| Stop point                                      | Recovery behavior                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Before occurrence transaction commits           | The unchanged due schedule is scanned again                                      |
| After occurrence commit, before job enqueue     | `pending_dispatch` is found and dispatched                                       |
| After enqueue, before occurrence links the job  | Re-enqueue returns the existing job by its unique idempotency key, then links it |
| While a job is running                          | Existing job leases and attempt recovery apply                                   |
| After job completion, before occurrence outcome | Outcome reconciliation reads the linked job and updates occurrence history       |
| After the host clock moves backward             | Persisted occurrence uniqueness prevents an already-fired instant from rerunning |

The loop must bound each scan and yield between batches. The recurrence calculator starts from
persisted instants, not from a count of elapsed process timer ticks.

### Uniqueness and idempotency

`schedule_occurrences` has a database unique constraint on
`(schedule_id, schedule_revision, scheduled_for_utc)`. Schedule edits increment
`schedule_revision`; they affect future materialization only and never rewrite an existing
occurrence.

Every occurrence dispatch uses a deterministic queue idempotency key with the equivalent identity:

```text
schedule:<schedule-id>:revision:<revision>:at:<utc-epoch-ms>:trigger
```

The exact encoding is centralized and versioned. It must not use a display string, host timezone,
random job ID, or current dispatch time. If one occurrence fans out to destinations, existing
workflow execution and destination identities extend that occurrence identity with the stable
destination key. A retry reuses the same job and destination idempotency keys; it does not create a
new occurrence.

These constraints provide one intended local firing for a schedule revision and UTC occurrence.
They do not claim exactly-once publication across a remote API boundary. Destination adapters keep
using the persisted remote-operation checkpoints and reconciliation rules from ADR 0006. An
ambiguous remote acceptance must not be converted into a fresh scheduled publish.

### Interaction with `JobRunner`

The scheduler is a producer, while `JobRunner` remains the only general job executor:

- scheduled work is created through the shared application/job services with immutable JSON input;
- `jobs.available_at` remains a not-before execution gate, useful for a destination hold that is
  already known, but it is not the recurrence database or schedule history;
- retries, `Retry-After`, cancellation, leases, attempt history, and later concurrency/rate controls
  continue to belong to the existing job path; and
- a schedule occurrence records the trigger job outcome separately from downstream destination
  results, rather than reporting an enqueue as a completed publication.

A destination-specific delay opens a persisted gate at its resolved UTC instant. If upstream work
is ready first, its destination job is persisted with an appropriate future `available_at`; if the
gate opens first, later-ready work may proceed immediately. The same destination intent and
idempotency key are used in either ordering. This ADR does not introduce delay-step persistence or
workflow-plan code before their roadmap packets.

### Interaction with the v0.4 source poller

`SourcePollingRunner` remains the sole caller of `SourceAdapter.poll` and remains responsible for
cursor/item transaction ordering, adapter error classification, backoff, and authorization pause.
A scheduled source occurrence must request a poll through an application boundary; it must not call
an adapter and must not enqueue `source.item.observed` itself.

A source connection has one cadence owner:

- existing v0.4 connections default to their current interval cadence so upgrading does not change
  behavior; or
- a scheduler-managed connection receives poll requests from a recurring schedule and does not
  also schedule the normal success interval.

Packet 2 must add the minimum persisted cadence/request distinction needed for that rule. Poll
requests for the same connection coalesce when one is pending or active. A scheduled request never
resumes a paused/authorization-failed connection and never shortens an active retry/rate-limit
cooldown. When allowed, it marks the connection due and the existing runner performs the poll. Its
normal source-item and workflow uniqueness rules handle repeated observations.

Source polling and publish work that become due at the same instant are independent. Both retain
their persisted identities, and neither receives ordering priority merely because it was scanned
first. The existing queue plus the later v0.5 concurrency/rate-control packet decides execution
capacity.

## Rejected alternatives

- **A homegrown cron parser or calendar iterator:** timezone, field, and DST edge cases are not a
  product differentiator and are too risky to recreate.
- **RFC 5545/RRULE via `rrule`:** it is more expressive than v0.5 needs, and its JavaScript
  floating-time/UTC `Date` conventions make the persisted instant boundary easier to misuse.
- **`cron-parser`:** it is a credible alternative, but Croner has no runtime dependencies and
  directly documents the chosen gap/overlap behavior. Only one recurrence engine should define
  product semantics.
- **Croner callbacks, `node-cron`, `setTimeout`, or OS cron as the scheduler:** these are useful
  wake-up mechanisms but do not provide OpenRepurpose's durable occurrence history, transaction
  boundaries, or restart deduplication.
- **Creating a second scheduled-job runner:** this would duplicate leases, retries, cancellation,
  observability, and destination recovery already provided by `JobRunner`.
- **Replaying every missed recurring occurrence:** after a long outage this can flood platform APIs
  and repeatedly publish stale work. A single recorded catch-up is safer and deterministic.

## Consequences

- Packet 2 owns schedule/occurrence persistence, recurrence calculation, the injected clock,
  scheduler loop, source cadence/request compatibility, and deterministic unit/integration tests.
- Croner is not added to the dependency graph in this decision-only packet. Packet 2 must pin the
  exact reviewed 10.x version and verify its DST behavior before implementation depends on it.
- All user-visible next-run values can show both the IANA timezone/wall time and resolved UTC
  instant. No host-local timezone assumption is required on Windows or Linux.
- The database may contain a pending occurrence without a linked job briefly; this is an explicit,
  recoverable state rather than an implicit crash gap.
- Existing v0.4 polling, job leasing, destination idempotency, and remote reconciliation behavior
  remain unchanged until their owning v0.5 packets extend them.

## Material checked

Checked on 2026-09-19:

- [Croner repository and documentation](https://github.com/Hexagon/croner)
- [Croner changelog](https://github.com/Hexagon/croner/blob/master/CHANGELOG.md)
- [cron-parser repository and documentation](https://github.com/harrisiirak/cron-parser)
- [rrule repository and timezone guidance](https://github.com/jkbrzt/rrule)
