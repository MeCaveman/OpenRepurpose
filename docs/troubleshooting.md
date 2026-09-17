# Troubleshooting

OpenRepurpose is local-first. Start with `openrepurpose doctor`, then inspect the job history in
the web UI or with `openrepurpose jobs list` / `openrepurpose jobs show <job-id>`.

## The dashboard does not start

- Confirm Node.js 24.21.0 and pnpm 12.4.2 are installed.
- Run `pnpm build` and then `pnpm start` from the repository root.
- v0.1 binds to `127.0.0.1` by default. A LAN/public `BIND_HOST` or `APP_URL` is rejected.
- If the port is busy, set a different `PORT` and matching loopback `APP_URL`.

## Setup reports missing ffmpeg or ffprobe

Install both executables with the package manager for the host OS, or configure their executable
paths using the variables in `.env.example`. Restart the server after changing configuration.
Media import cannot persist probe metadata until `ffprobe` is available.

## A watched-folder file is not imported

The folder runner uses periodic scans. A supported file must keep the same size and modification
time for `WATCH_SETTLE_MS`; this avoids importing partially-written OBS or render output. Keep the
file in the configured folder, wait for the settling period, and check the next scan. The first
scan records the candidate; the following settled scan imports it. The durable source cursor makes
restarts idempotent.

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
check or expose the v0.1 server through a reverse proxy; loopback-only access is intentional until a
later release adds authenticated headless/LAN support.
