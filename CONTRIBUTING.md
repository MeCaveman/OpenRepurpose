# Contributing to OpenRepurpose

OpenRepurpose is a local-first Windows/Linux application. Read `AGENTS.md`, the current roadmap and
progress file, and any scoped `AGENTS.md` before changing code. Keep packets focused and preserve the
shared application-service path used by the web UI, CLI, API, MCP, scheduler, and workers.

## Development setup

Use the pinned Node.js 24.21.0 and pnpm 12.4.2 versions:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm test
corepack pnpm build
corepack pnpm test:e2e
```

Start the source workspace with `corepack pnpm dev`. Never commit credentials, `.env` files,
platform tokens, media owned by someone else, or production databases.

## Change rules

- Keep default binding on loopback and preserve authenticated, deployment-neutral LAN/headless paths.
- Put business logic in application/core services, not route handlers, React components, or CLI commands.
- Keep database access behind repositories and add migrations rather than editing released migrations.
- Spawn FFmpeg/ffprobe and other tools with argument arrays, never shell-concatenated input.
- Use official platform APIs, least-privilege scopes, mocked tests, and opt-in credential-gated live tests.
- For frontend work, read `apps/web/AGENTS.md`, `.interface-design/system.md`, and
  `docs/UI_ARCHITECTURE.md`; reuse the existing token/component system.
- Add the lowest-cost useful regression test and update documentation when behavior changes.

## Pull requests

Explain the problem, scope, architecture/security impact, checks run, and any limitation. Keep
unrelated refactors out. UI changes should include keyboard/responsive evidence; integration changes
should link current official documentation; migration changes should include upgrade/rollback tests.

Security reports belong in the private process documented by [SECURITY.md](SECURITY.md), not an issue.
The maintainer release checklist is in [docs/release-process.md](docs/release-process.md).
