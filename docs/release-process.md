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
smokes are optional, credential-gated, and never required for ordinary contributors. A maintainer
can dispatch CI with `run_live_platform_smoke` enabled after configuring the protected
`live-platform-smoke` environment. The job accepts any non-empty subset of the following secrets and
performs only identity/capability reads (TikTok's creator-info query is a read-only POST):

- `OPENREPURPOSE_LIVE_YOUTUBE_ACCESS_TOKEN`
- `OPENREPURPOSE_LIVE_TIKTOK_ACCESS_TOKEN`
- `OPENREPURPOSE_LIVE_META_ACCESS_TOKEN`
- `OPENREPURPOSE_LIVE_TWITCH_ACCESS_TOKEN` together with `OPENREPURPOSE_LIVE_TWITCH_CLIENT_ID`
- `OPENREPURPOSE_LIVE_KICK_ACCESS_TOKEN`

The live smoke prints platform names and pass/fail status only. It does not print response bodies or
credential values, and it fails if dispatched without at least one complete credential set.

Windows maintainers with Docker Desktop can also run `corepack pnpm smoke:linux-artifact:docker`.
That command builds the Linux x64 portable archive in a pinned Debian/Node environment, installs
FFmpeg only in the disposable certification image, and exercises the extracted artifact through the
same clean-profile smoke used by Ubuntu CI. The release artifact itself continues to keep
FFmpeg/ffprobe external.
