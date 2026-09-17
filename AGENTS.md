# AGENTS.md — OpenRepurpose Repository Instructions

These rules apply to every Codex task in this repository.

## 1. Product invariant

OpenRepurpose is a **local-first, open-source, self-hosted media automation application** for Windows and Linux.

The primary deployment is one user running one installation on their own computer:

```text
Browser on localhost
        |
        v
Local HTTP server/API
        |
        +--> SQLite
        +--> local filesystem
        +--> FFmpeg/ffprobe
        +--> local job runner
        +--> platform APIs
```

A CLI uses the same application/core services as the web UI.

Do not introduce a mandatory cloud service, SaaS control plane, hosted database, Redis, Kafka, Kubernetes, Temporal, or remote OpenRepurpose account.

## 2. Core stack

Use this stack unless a version instruction explicitly changes it:

- TypeScript with `strict` enabled.
- Current Node.js Active LTS pinned in the repository.
- `pnpm` workspaces.
- React + Vite for the web UI.
- Tailwind CSS + shadcn/ui for UI primitives.
- Fastify for the local HTTP API/server.
- Zod for boundary validation.
- SQLite for persistent state.
- Drizzle ORM + migrations unless a concrete packaging blocker requires an ADR-approved alternative.
- Commander.js for CLI commands.
- FFmpeg and ffprobe invoked as child processes using argument arrays, never shell-concatenated command strings.
- Vitest for unit/integration tests.
- Playwright for web end-to-end tests.
- ESLint + Prettier.
- GitHub Actions for CI/release automation.

Prefer boring, maintained dependencies. Before introducing a major dependency, verify that it is actively maintained and record the reason in an ADR.

## 3. Intended repository layout

Keep the architecture close to:

```text
apps/
  server/        # Fastify server and production static serving
  web/           # React/Vite localhost UI
  cli/           # CLI entry point

packages/
  core/          # domain, workflow engine, job semantics
  db/            # schema, migrations, repositories
  media/         # ffmpeg/ffprobe and media abstractions
  platform-sdk/  # destination/source adapter contracts
  shared/        # shared DTOs, schemas, utilities
  testkit/       # fixtures and reusable mocks

integrations/
  youtube/
  tiktok/
  meta/
  twitch/
  kick/

docs/
  adr/
  api/
  platform-setup/
  progress/
  roadmap/

scripts/
.github/
```

Do not create packages just to satisfy this diagram. Add them when they have a real responsibility.

## 4. Architecture rules

### Dependency direction and separation of concerns

External-facing layers call the application layer; they do not perform business operations directly:

```text
CLI / Web UI / REST API / schedulers / event triggers
                         |
                         v
                 Application services
                         |
                         v
                   Domain / core
                         ^
                         |
       Infrastructure implementations of core contracts
```

- UI components, CLI commands, and API route handlers translate input/output and call application services. They must not contain business logic.
- Integrations provide capabilities through explicit adapters. They must not control workflows directly.
- Database access stays behind repositories or data-access contracts.
- Core and application code depend on contracts. Filesystems, databases, schedulers, queues, platform APIs, and other infrastructure implement those contracts.
- Keep persistence records separate from domain/application models where practical. Database structure must not dictate the application architecture.

### Modular feature boundaries

Treat each major capability as a cohesive module, including publishing, media, metadata, workflows, scheduling, automation, notifications, analytics, authentication, accounts, storage, logging, configuration, webhooks, monitoring, and plugins as they are introduced.

A feature should expose only the public contracts, application services, domain types, infrastructure adapters, and tests that consumers need. Unrelated modules must not import its internal implementation details.

New capabilities should normally be added by implementing or extending a focused interface, service, handler, processor, adapter, provider, or module. Avoid:

- direct imports between unrelated feature modules;
- large global service objects;
- central constructors or registries that know every feature;
- growing switch statements or `if`/`else` chains for providers, triggers, processors, job types, or workflow steps.

Use composition, dependency injection, and modular registration where practical. Adding a provider or feature may register a new implementation, but should not require unrelated modules to know it exists.

Public interfaces and event contracts change deliberately. Preserve backward compatibility between modules when practical; internal implementations may evolve independently.

### Replaceable local infrastructure

Start with the simplest local implementation that satisfies current requirements: SQLite, the local filesystem, an in-process event bus, and a local background job runner/queue. Do not add distributed infrastructure preemptively.

Define narrow contracts so infrastructure can be replaced without rewriting application logic. Representative relationships include:

```text
SQLiteRepository implements Repository
LocalJobQueue implements JobQueue
LocalEventBus implements EventBus
LocalFileStorage implements StorageProvider
YouTubeAdapter implements PublishingProvider
```

These examples do not authorize speculative PostgreSQL, Redis, cloud-storage, or distributed-worker implementations. Add alternatives only when a real requirement justifies them.

All configuration loading and environment-variable access must be centralized and typed. Cross-cutting concerns such as logging, retries, error handling, rate limiting, authentication, telemetry, and caching must be reusable rather than reimplemented independently by every feature.

### Reusable execution and event extension points

Represent long-running and user-triggered operations as commands/jobs handled by application services. CLI, UI, API, schedulers, integrations, and event handlers all use the same execution path.

Important actions may emit typed internal events through an `EventBus` contract so later modules can react without changing the producer. Expected event families include:

```text
media.downloaded
media.processed
upload.started
upload.completed
upload.failed
job.created
job.completed
workflow.completed
```

Event names and payload contracts must be deliberate, testable, and versionable where compatibility requires it. Do not use events to hide required synchronous invariants or create an untraceable dependency graph.

### Extension-point and boundary tests

The architecture must make it clear where to add a publishing platform, media processor, job type, trigger, workflow step, storage backend, notification provider, API endpoint, UI feature, or new feature module.

Test important boundaries with mocks/fakes and contract tests so infrastructure implementations and feature modules can change independently. Prefer the simplest implementation that preserves these boundaries. Do not predict or implement future features merely to prove extensibility.

### Shared core
The web UI and CLI must call the same application services. Never duplicate business logic in route handlers, React components, or CLI commands.

### Adapter boundaries
All external platforms implement explicit interfaces. Core workflow code must not contain platform-specific HTTP calls.

Destination example:

```ts
interface DestinationAdapter {
  id: string;
  capabilities(): Promise<DestinationCapabilities>;
  validate(input: PublishRequest): Promise<ValidationResult>;
  publish(input: PublishRequest, ctx: AdapterContext): Promise<PublishResult>;
  getStatus?(remoteId: string, ctx: AdapterContext): Promise<RemoteStatus>;
}
```

Source example:

```ts
interface SourceAdapter {
  id: string;
  capabilities(): Promise<SourceCapabilities>;
  poll(cursor: SourceCursor | null, ctx: AdapterContext): Promise<SourcePollResult>;
  resolve(item: SourceItem, ctx: AdapterContext): Promise<ResolvedMedia>;
}
```

Interfaces can evolve, but preserve capability discovery and typed errors.

### Persistent jobs
Jobs are persisted in SQLite. The process may crash at any time. Design for restart/recovery.

Use explicit states such as:

```text
pending
running
waiting
retrying
succeeded
failed
cancelled
```

Use bounded retries, exponential backoff with jitter, idempotency keys, and persisted attempt/error history. A restart must not blindly republish already-successful destinations.

### Workflow semantics
A workflow should eventually model:

```text
Source trigger -> optional filters -> optional transforms -> one or more destinations
```

Execution must create immutable/snapshot-like job inputs so editing a workflow does not mutate an already-running job.

## 5. Local security rules

- Bind to `127.0.0.1` by default, not `0.0.0.0`.
- Exposing LAN access must require an explicit `--host`/config change and show a warning.
- Validate request `Origin`/host and implement CSRF protection for state-changing browser requests.
- Generate and enforce a local application secret/session boundary as appropriate.
- Never log OAuth access tokens, refresh tokens, client secrets, authorization codes, cookies, or raw Authorization headers.
- Redact secrets from structured logs and error objects.
- Never commit credentials or `.env` files.
- Put secret persistence behind a `SecretStore` interface.
- Prefer OS-native protected storage for stable releases. If an interim encrypted local vault is used, document its threat model honestly.
- Use PKCE and `state` for OAuth flows where supported/required.
- Use least-privilege scopes.
- Do not disable TLS verification.
- Do not use browser automation to log into social platforms.
- Do not bypass API audits, rate limits, visibility restrictions, DRM, private-content controls, or platform access controls.

## 6. Content ownership / download rule

Only ingest or download media the user owns or is authorized to reuse.

For platforms that do not expose an official media-download endpoint:
- prefer user-provided local originals;
- if an optional external downloader is supported, keep it separate from the core, require an explicit rights confirmation, and never use it to defeat DRM or authentication/access controls;
- document that platform terms may impose additional restrictions.

## 7. API integration rules

Before implementing any social API integration, inspect the platform's **current official documentation**. API permissions, review/audit requirements, media limits, and endpoints change.

Implementation must:
- expose capability/limitation information in the UI;
- provide BYO developer-app credential setup documentation;
- allow mocked integration tests without live credentials;
- gate live tests behind explicit environment variables;
- represent platform errors as typed domain errors;
- honor retry/rate-limit headers where available;
- never assume that a successful upload means processing/publishing has completed.

## 8. Media rules

- Never load large video files fully into memory.
- Stream files when possible.
- Use `ffprobe` JSON output to inspect media.
- Spawn FFmpeg without `shell: true`.
- Validate file paths and keep temporary files inside the application's managed temp directory.
- Every generated derivative needs provenance: source media ID, transform recipe hash, tool version, creation time.
- Make transforms deterministic where reasonably possible.
- Clean abandoned temporary files on startup using conservative age/status rules.

## 9. Cross-platform rules

Support Windows and Linux continuously. Do not postpone Windows path/process issues until v1.0.

Avoid:
- POSIX-only shell assumptions in application code;
- hardcoded `/tmp`;
- hardcoded path separators;
- relying on executable file bits for core behavior;
- requiring Bash for normal user operation.

Centralize:
- application data directory resolution;
- config directory resolution;
- temp directory resolution;
- executable discovery;
- process shutdown handling.

## 10. Testing rules

Every feature needs the lowest-cost useful test.

Required layers:
- unit tests for domain logic;
- repository/integration tests using temporary SQLite databases;
- adapter contract tests with mocked HTTP;
- a few Playwright user journeys;
- CLI smoke tests;
- migration tests from the previous released schema;
- opt-in live API smoke tests only when credentials are supplied.

A packet is not complete if tests are failing.

## 11. Observability

Use structured local logs with:
- timestamp;
- level;
- subsystem;
- job/workflow ID when relevant;
- adapter/platform ID when relevant;
- redacted error classification.

The UI needs a human-readable job history. The CLI needs `status`, `jobs`, and later `logs` views.

No telemetry is sent off-device by default. Any future telemetry must be opt-in and documented.

## 12. Database/migration discipline

- Never edit an already-released migration.
- Add a new migration.
- Keep schema migrations transactional where SQLite allows.
- Back up before destructive migrations.
- Add migration tests for supported upgrade paths.
- Use UTC instants in storage and explicit IANA timezone IDs for user scheduling.

## 13. UI principles

This is a technical creator tool, not an enterprise dashboard.

Prioritize:
- setup clarity;
- account connection status;
- workflows;
- queue/history;
- media;
- actionable errors.

Never hide platform limitations. Show why a publish action is unavailable.

## 14. CLI principles

CLI and web features should converge toward parity.

Expected command family over time:

```text
openrepurpose start
openrepurpose doctor
openrepurpose accounts ...
openrepurpose media ...
openrepurpose workflows ...
openrepurpose jobs ...
openrepurpose publish ...
openrepurpose schedule ...
openrepurpose mcp ...
```

Commands return non-zero exit codes on failure. Support `--json` on machine-readable commands where useful.

## 15. Codex working protocol — important for usage

Do not attempt a whole release in one giant turn.

For every version:
1. Read this file.
2. Read only the current version file.
3. Read `docs/progress/vX.Y.md` if it exists.
4. Inspect only the parts of the repository needed for the current work packet.
5. Implement one packet.
6. Run the packet's tests/lint/typecheck.
7. Fix failures caused by the packet.
8. Update `docs/progress/vX.Y.md` with:
   - completed checklist items;
   - important decisions;
   - commands/tests run;
   - known blockers;
   - exact next packet.
9. Stop at the packet boundary.

Do not repeatedly re-read all historical version files. Use Git history and targeted file inspection when older context is necessary.

## 16. Progress-file format

Keep progress concise:

```md
# vX.Y progress

## Completed
- ...

## Decisions
- ...

## Verification
- `pnpm ...` — pass

## Known issues
- ...

## Next packet
- Packet N: ...
```

This file is a context handoff, not a diary.

## 17. Definition of done for any packet

A packet is done only when:
- implementation is complete for its stated scope;
- types pass;
- relevant tests pass;
- lint passes for touched code;
- no secrets are in logs/test fixtures;
- docs are updated if behavior/setup changed;
- progress file is updated;
- unrelated refactors are not mixed in.

## 18. When blocked

Do not stop because real social credentials are unavailable. Implement against official documentation, mocks, contract tests, and an opt-in live-test harness.

Do stop and report clearly if:
- the requested behavior requires bypassing an API/platform restriction;
- a current official API does not expose the needed capability;
- implementing safely would require an architectural decision outside the current version scope.

Record such a blocker in the progress file and continue with the remaining independent tasks.
