# Troubleshooting

OpenRepurpose is local-first. Start with `openrepurpose doctor`, then inspect the job history in
the web UI or with `openrepurpose jobs list` / `openrepurpose jobs show <job-id>`.

## The dashboard does not start

- For a portable release, run the packaged `openrepurpose doctor`; Node.js and pnpm are bundled.
- For a source checkout, confirm Node.js 24.21.0 and pnpm 12.4.2, then run `pnpm build` and `pnpm start`.
- OpenRepurpose binds to `127.0.0.1` by default. A LAN/public `BIND_HOST` or `APP_URL` requires
  explicit authenticated LAN mode.
- If the port is busy, set a different `PORT` and matching loopback `APP_URL`.

## Setup reports missing ffmpeg or ffprobe

Install both executables with the package manager for the host OS, or configure their executable
paths using the variables in `.env.example`. Restart the server after changing configuration.
Media import cannot persist probe metadata until `ffprobe` is available.

The repository's Docker image intentionally leaves FFmpeg/ffprobe out. To use media transforms in
Docker, build a derived image with a specific FFmpeg build and carry that build's notices and
provenance with your image.

## A watched-folder file is not imported

The folder runner uses periodic scans. A supported file must keep the same size and modification
time for the workflow's settle window; this avoids importing partially-written OBS or render
output. Standard folders use `WATCH_SETTLE_MS`. The OBS recording preset waits 10 seconds, and the
OBS Replay Buffer preset waits 5 seconds. Keep the file in the configured folder, wait for the
settling period, and check the next scan. The first scan records the candidate; a later settled scan
imports it. Durable filesystem identity preserves that state when OBS renames a file and prevents a
second import after restart.

OBS presets do not require a plugin. Configure the watched path to match OBS Settings → Output →
Recording. Common OBS timestamp filenames are parsed for metadata. An optional same-name JSON file
beside the video, such as `Replay 2026-09-21 14-35-42.json`, may provide string values for `title`,
`description`, `publishedAt` (or `recordedAt`), and `externalId`. Invalid, unreadable, or larger than
64 KiB sidecars are ignored; the video still imports using filename metadata.

## OBS WebSocket is disconnected

OBS WebSocket is optional. Folder scans still discover and settle recordings/replays when OBS is
closed or its WebSocket service is unavailable. To request an immediate scan when OBS saves a replay
or stops recording, set `OBS_WEBSOCKET_URL` (normally `ws://127.0.0.1:4455`) and, if enabled in
OBS, `OBS_WEBSOCKET_PASSWORD`. The password is stored in the local encrypted vault at startup and
never exposed to the browser. A non-loopback endpoint must use `wss://`; do not put credentials in
the URL. Authentication/session-invalidated failures deliberately do not retry—correct the local
configuration and restart OpenRepurpose.

## A YouTube upload is waiting or failed

Open the job detail to see the safe error code and attempt history. `retrying` jobs are waiting for
the persisted backoff; transient network, quota, and rate-limit responses are retried. Reconnect
the account for authentication failures. YouTube processing is asynchronous, so a completed byte
upload can remain in `processing` until the API reports its final state.

Uploads use the account's granted scope and the user's own Google developer application. Google
may restrict public visibility for unverified projects; OpenRepurpose will not report a private or
unverified upload as publicly published.

## Recovery after a crash

Jobs are stored in SQLite. On restart, an expired running lease is recorded as a retryable
`LEASE_EXPIRED` attempt and the job is claimed again. YouTube destination checkpoints preserve the
resumable session and remote video ID, so recovery does not blindly create a second publish.

## Security errors from the browser

State-changing API requests require the local origin and a session CSRF token. Do not disable this
check. If using a reverse proxy, set the configured public origin exactly, protect the backend from
direct access, enable authenticated LAN mode, and trust forwarded headers only from that proxy.

## Backup restore says the database is busy

Stop every OpenRepurpose server, worker, scheduler, and CLI process using the database. Restore
validates the entire backup before mutation and refuses to continue without the database lock. Do
not delete `-wal`/`-shm` files from a running database. See [backup and restore](backup-restore.md).

## OAuth succeeds but publishing is unavailable

OAuth proves identity, not every capability. Check the account card for missing scopes, reconnect
requirements, target eligibility, app-review/audit restrictions, creator privacy choices, quota, or
remote processing failures. Use the current [platform guide](platform-setup/README.md) and never try
to work around a platform restriction.
