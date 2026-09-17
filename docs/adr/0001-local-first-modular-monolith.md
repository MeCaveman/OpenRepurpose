# ADR 0001: Local-first modular monolith

- Status: Accepted
- Date: 2026-09-17

## Context

OpenRepurpose must run from one codebase on a Windows or Linux personal computer and on a
Linux VPS. Its initial product is operated by one user and should remain simple to install, but
durable jobs, media operations, integrations, and scheduling must not become coupled to an HTTP
request, an open browser tab, or process-local state.

The repository therefore needs useful module boundaries before it needs distributed services.
Splitting the initial product into independently deployed microservices would increase packaging
and operational cost without improving v0.1 correctness.

## Decision

OpenRepurpose starts as a local-first modular monolith. The first deployment may compose the API,
application services, job runner, scheduler, and local infrastructure in one process. The web UI
and CLI remain external adapters that call the same application services.

The initial dependency direction is:

```text
Web / CLI / HTTP / scheduled triggers
                 |
                 v
        application services
                 |
                 v
          domain contracts
                 ^
                 |
 SQLite / filesystem / jobs / platform adapters
```

The workspace expresses these responsibilities as:

- `apps/server`: the local server and initial process composition root;
- `apps/web`: the browser adapter;
- `apps/cli`: the command-line adapter;
- `packages/core`: domain and application policies and ports;
- `packages/db`, `packages/media`, and future integrations: infrastructure adapters;
- `packages/platform-sdk`: platform capability contracts and typed integration errors;
- `packages/shared`: deliberately shared boundary DTOs and utilities;
- `packages/testkit`: contract-test fakes and fixtures.

Business behavior must not be duplicated in web components, route handlers, CLI commands, or
integration adapters. Correctness that must survive a restart will use persisted state and explicit
repository/service contracts. In-memory implementations are acceptable for early composition and
tests only where losing that state cannot violate product guarantees.

All deployment-specific addresses, public origins, storage locations, and process endpoints are
configuration. Loopback remains the default; later LAN/VPS support can configure public binding
and reverse-proxy behavior without forking application logic.

The contracts must allow the composition to evolve from one application process to separate API,
scheduler, and worker processes or containers. That separation is deferred until a roadmap packet
requires it; no distributed queue, cache, or control plane is introduced now.

## Toolchain implications

The repository uses pnpm workspaces and strict TypeScript so package boundaries are visible and
checked on Windows and Linux. Vite/React supply the browser build, Vitest supplies fast unit and
integration tests, and Playwright supplies browser journeys when those journeys are introduced.
ESLint and Prettier provide one cross-platform lint/format path. GitHub Actions runs the same root
commands on Windows and Linux.

These dependencies are the maintained tools required by the repository's mandated stack. Their
official release channels were checked on 2026-09-17; exact versions are pinned in package
manifests and the lockfile. Node.js 24.21.0 is pinned because Node 24 is the current Active LTS line.

## Consequences

- Local installation and development require only Node.js/pnpm at this packet boundary.
- Feature packages expose explicit public entry points instead of importing one another's internals.
- A single-process start is simple, while durable boundaries preserve later process/container
  separation.
- Cross-process coordination is not available until a packet implements its persistent mechanism.
- Additional packages or processes are added only when they own a concrete responsibility.

## Alternatives considered

- **Microservices from v0.1:** rejected because they add deployment and failure modes before there
  is a scaling requirement.
- **One undifferentiated application package:** rejected because it encourages business logic in
  delivery and infrastructure layers and makes later worker separation expensive.
- **Separate local and VPS applications:** rejected because deployment differences belong in typed
  configuration, not duplicated product logic.
