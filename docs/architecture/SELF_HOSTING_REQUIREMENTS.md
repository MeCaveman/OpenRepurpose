# OpenRepurpose — Local + VPS Self-Hosting Architecture Requirement

## Status

This file is a permanent architecture constraint for the OpenRepurpose repository.
Codex must read it before implementing any roadmap packet.

## Core requirement

OpenRepurpose must remain self-hostable from the same codebase in all of these environments:

1. Windows PC using Docker Desktop and/or the supported native development/runtime path.
2. Linux PC using Docker Engine and/or the supported native development/runtime path.
3. Linux VPS/server using Docker Engine, a domain or IP, and an optional reverse proxy with HTTPS.

Do not create separate application versions for local and VPS deployment.
The application must be deployment-agnostic. Deployment-specific behavior belongs in configuration, not forks of application logic.

## Scope rule

This requirement does **not** mean every deployment feature must be implemented in v0.1.

- Preserve local/VPS compatibility from the beginning.
- Implement only the functionality requested by the current roadmap packet.
- Do not pull future-version features forward merely because this file mentions them.
- Full Docker/headless/LAN/VPS operational support may be completed by the roadmap packets that own those features, especially v0.9 and v1.0.
- Never make an architectural decision in an earlier packet that makes later local/VPS support require a major rewrite.

## Architectural shape

Keep responsibilities separated approximately as:

```text
OpenRepurpose
├── Web UI
├── CLI
├── API / Backend
├── Application Services
├── Job / Worker Runtime
├── Scheduler / Source Polling
├── Database
├── Media Processing
├── Storage Abstraction
└── Platform / Source Integrations
```

Prefer a modular monolith with clear ports/adapters and independently runnable background components over unnecessary microservices.

The same business/application services should eventually serve Web UI, CLI, REST, MCP, scheduled work, and background jobs.

## Repository organization

Preserve modular separation. A structure similar to the following is acceptable where it fits the existing repository:

```text
openrepurpose/
├── apps/
│   ├── web/
│   ├── api/
│   ├── worker/
│   └── cli/
├── packages/
│   ├── core/
│   ├── application/
│   ├── integrations/
│   ├── media/
│   ├── storage/
│   └── shared/
├── infrastructure/
│   ├── docker/
│   ├── migrations/
│   └── deployment/
└── docs/
```

Do not restructure merely to match this example if the existing repository already satisfies the architectural boundaries.

## Deployment-neutral configuration

Never hard-code deployment-specific public URLs, callback URLs, addresses, ports, credentials, storage paths, or service IPs.

Use typed configuration/environment variables for values such as:

```env
APP_URL=http://localhost:3000
API_URL=http://localhost:3000/api
BIND_HOST=127.0.0.1
DATABASE_URL=...
STORAGE_PROVIDER=local
MEDIA_ROOT=...
```

A VPS configuration might instead use:

```env
APP_URL=https://repurpose.example.com
API_URL=https://repurpose.example.com/api
BIND_HOST=0.0.0.0
```

Public/LAN binding must remain explicit and secure. Default to loopback until a roadmap packet intentionally adds authenticated LAN/server mode.

Maintain a documented `.env.example` or equivalent typed configuration reference.

## Networking

When containers are used, services must communicate using container/service DNS names or configured endpoints, not hard-coded host IP addresses.

Do not assume that `localhost` inside one container reaches another container.

Internal services such as the database or future queue/cache must not be exposed publicly unless there is a specific documented need.

## Docker

Docker is a first-class deployment target for OpenRepurpose, but implement Docker functionality according to the roadmap packet that owns it.

The final supported experience should allow a technical user to perform a deployment similar to:

```bash
git clone <repository>
cd openrepurpose
cp .env.example .env
docker compose up -d
```

Do not require host installation of infrastructure that can reasonably live in containers for the Docker deployment path.

Persistent data must survive container recreation.

## Persistence

Stopping and restarting OpenRepurpose must not destroy required application state.

Persist, as applicable:

- database state;
- workflow definitions and immutable versions/snapshots;
- schedules;
- jobs/history;
- source cursors;
- account metadata;
- uploaded/managed media;
- user settings;
- application configuration that is meant to persist.

Use migrations. Never rely on deleting the database as a normal upgrade path.

## Local filesystem and storage abstraction

Local storage is the default and must work without an external cloud provider.

Do not scatter direct filesystem assumptions throughout business logic. Use storage/media abstractions where appropriate so future providers can be added without rewriting unrelated code.

Future providers may include S3-compatible storage, MinIO, Cloudflare R2, or Backblaze, but do not implement them until a roadmap packet requires them.

## Background work

Long-running operations must not depend on an HTTP request or browser tab staying open.

Examples include:

- media probing;
- uploads;
- remote processing polling;
- source polling;
- scheduled publishing;
- FFmpeg transforms;
- transcription;
- retries and recovery.

The architecture must allow these operations to run while the Web UI is closed.

Do not use browser timers as the source of truth for scheduling or automation.

## Process-boundary rule

Do not make core correctness depend on Web UI/API/worker components sharing in-memory state.

Use persistent state and explicit service/repository boundaries for anything that must survive restart or may later run in another process/container.

An in-process implementation is acceptable in early versions when the interfaces and persistence model do not prevent later separation.

## OAuth and external integrations

OAuth callback/public URLs must come from configuration rather than being hard-coded to localhost.

Examples:

```text
Local: https?://localhost/.../callback
VPS:   https://repurpose.example.com/.../callback
```

Use the official API behavior of each platform and current roadmap rules.

Credentials/tokens must remain behind the repository's secret-storage abstraction and must never be exposed to browser bundles or logs.

## Reverse proxy and HTTPS

A VPS deployment must be able to operate behind Caddy, Traefik, Nginx, or another standards-compliant reverse proxy.

Do not couple application logic to one reverse proxy.

The application must correctly support configured public origins and forwarded-proxy behavior once server/LAN deployment is implemented.

Production HTTPS should normally terminate at the reverse proxy unless the relevant packet explicitly implements application TLS.

## Health and diagnostics

Preserve a path toward health/readiness diagnostics for:

- API/server;
- database;
- workers/job runner;
- scheduler/source polling;
- media dependencies such as FFmpeg;
- configuration and writable paths.

This should support `openrepurpose doctor` and headless/server operation without making every check a v0.1 requirement.

## CLI

Preserve an architecture that can support commands such as:

```text
openrepurpose setup
openrepurpose start
openrepurpose stop
openrepurpose restart
openrepurpose status
openrepurpose logs
openrepurpose doctor
openrepurpose update
```

Only implement commands owned by the current roadmap packet.

## Security baseline

Local-first does not mean security-free.

Preserve these rules:

- bind to loopback by default until LAN/server mode is explicitly enabled;
- LAN/VPS exposure must be explicit and authenticated;
- database/internal services are not publicly exposed;
- secrets are never logged or sent to the browser;
- state-changing browser requests use appropriate Origin/CSRF/session protections;
- OAuth state/PKCE requirements are followed where applicable;
- path inputs are validated;
- child processes use executable + argument arrays, never untrusted shell strings;
- reverse-proxy/public-origin configuration is explicit;
- user credentials are never baked into container images.

## Scaling boundary

Do not introduce Kubernetes or distributed microservices merely to satisfy this requirement.

Keep the initial deployment simple while preserving the ability to move from:

```text
1 application process
```

toward:

```text
1 API/server
1 scheduler/poller
N workers
```

without redesigning domain/application logic.

## Required deployment compatibility

Every major architecture decision must remain compatible with:

```text
MODE A
Windows PC
localhost UI
local persistent data

MODE B
Linux PC
localhost UI
local persistent data

MODE C
Linux VPS/server
Docker
persistent volumes
reverse proxy + HTTPS
headless/24x7 operation
```

## Packet execution rule

Before implementing any roadmap packet, Codex must check whether the proposed implementation introduces assumptions such as:

- "this always runs on localhost";
- "the browser remains open";
- "all components share process memory";
- "storage is always one hard-coded host path";
- "OAuth callbacks always use localhost";
- "the API performs every long-running operation synchronously";
- "there is only one supported deployment model";
- "a host IP is fixed".

If so, adjust the implementation so the architecture remains deployment-neutral **without implementing unrelated future features**.

## Completion rule for every packet

A roadmap packet is not complete until Codex has:

1. implemented only the current packet's scope;
2. preserved the architecture rules in `AGENTS.md` and this file;
3. added/updated appropriate tests;
4. run the relevant typecheck/lint/test/build checks;
5. updated the current `docs/progress/vX.Y.md` file with decisions, verification, blockers, and the exact next packet;
6. stopped before implementing the next packet.
