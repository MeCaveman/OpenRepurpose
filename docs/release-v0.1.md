# OpenRepurpose v0.1 developer release

v0.1 is a local Windows/Linux MVP for importing owned local video, watching a local folder, and
queuing/uploading to YouTube with BYO Google OAuth credentials.

## Release gate

Run from the repository root:

```text
corepack pnpm install
corepack pnpm verify
```

The gate includes strict TypeScript, ESLint, Prettier, unit/integration tests, package builds, and
mocked Chromium Playwright journeys. The browser tests do not contact Google or upload media.

## First run

1. Run `corepack pnpm start` (or `corepack pnpm dev` for development).
2. Open `http://127.0.0.1:3000/setup`.
3. Run `openrepurpose doctor` and resolve dependency/setup warnings.
4. Add a Google desktop OAuth client in `/accounts`, then connect YouTube.
5. Import an owned local video in `/media`, queue it with **Publish to YouTube**, and monitor `/jobs`.
6. For automation, create a watched-folder workflow using the CLI or API and leave the folder
   runner time to settle new files.

Live OAuth and upload checks remain manual/opt-in because they require user-owned credentials. See
[`docs/platform-setup/youtube.md`](platform-setup/youtube.md) and
[`docs/troubleshooting.md`](troubleshooting.md).
