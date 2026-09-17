# ADR 0002: Node SQLite + Drizzle persistence adapter

## Status

Accepted — v0.1 Packet 2.

## Context

OpenRepurpose needs a local, durable SQLite persistence boundary that works on Windows and Linux
without a hosted service or platform-specific native database setup. It must also remain usable from
future server/worker composition roots.

## Decision

Use Node.js's built-in `node:sqlite` driver behind `@openrepurpose/db`, with Drizzle ORM's supported
Node SQLite adapter and application-owned, checksummed TypeScript migrations. The migration runner
uses `BEGIN IMMEDIATE` transactions and records applied migration checksums in
`__openrepurpose_migrations`; changed historical migrations fail fast.

`@openrepurpose/testkit` creates migrated disposable file databases, rather than using the production
application data directory. Current Drizzle documentation describes the Node SQLite adapter for
Node 22.5+; the repository's pinned Node 24 Active LTS satisfies that requirement:
https://orm.drizzle.team/docs/sqlite/connect-node-sqlite

## Consequences

- No external database, service, or native addon is required for the local or Docker/VPS deployment
  paths.
- Data locations and database paths remain configuration-driven and host-native.
- Schema tables for media, jobs, accounts, and workflows are deferred to their owning roadmap
  packets. New schema changes require new migrations; the initial migration is not edited.
- Node currently emits an experimental warning for `node:sqlite`; it does not affect correctness and
  should be revisited when Node changes that status.
