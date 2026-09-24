# Release process

OpenRepurpose releases are built from a clean tagged commit after the current roadmap release gate
is green. Maintainers must not treat a source-workspace pass as artifact evidence.

1. Review changelog, version alignment, migrations, third-party notices, and security findings.
2. Run typecheck, lint, formatting, unit/integration, Playwright, migration/rollback, CLI, API/MCP,
   adapter-contract, Docker, and package smoke suites.
3. Build Windows x64 and Linux x64 artifacts with the pinned official Node runtime.
4. Smoke extracted artifacts under clean profiles/hosts, including `doctor`, startup, health,
   dashboard, configured FFmpeg/subtitles, and upgrade/rollback.
5. Generate SHA-256 files and record runtime/source provenance. Never claim a signature that was not produced.
6. Publish notes, artifacts, checksums, source, license, notices, and known limitations.
7. Download published artifacts and repeat clean Windows/Linux verification before marking stable.

GitHub Actions use least-privilege read permissions and immutable action commit SHAs. Live platform
smokes are optional, credential-gated, and never required for ordinary contributors.
