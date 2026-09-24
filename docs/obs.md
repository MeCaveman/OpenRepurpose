# OBS recording and Replay Buffer workflows

OpenRepurpose watches folders; it does not require an OBS plugin. Configure an OBS recording or
Replay Buffer directory that the OpenRepurpose process can read, then choose the matching workflow
preset.

## Setup

1. In OBS, open **Settings -> Output -> Recording** and note the absolute output directory.
2. In OpenRepurpose, create a workflow from the OBS recording or Replay Buffer preset.
3. Confirm the watched path and destination, then save the workflow.
4. Produce a short test recording. Leave it in place until a later scan reports it settled and imported.

The poller records a candidate first and imports only after size and modification time remain stable.
The recording preset waits 10 seconds; Replay Buffer waits 5 seconds. Durable filesystem identity
handles normal OBS renames and prevents a second import after restart.

An optional same-name JSON sidecar up to 64 KiB may contain string values for `title`, `description`,
`publishedAt`/`recordedAt`, and `externalId`. Invalid sidecars are ignored; the video still imports.

## Optional OBS WebSocket

`OBS_WEBSOCKET_URL` (normally `ws://127.0.0.1:4455`) can request an immediate scan when a replay is
saved or recording stops. Folder polling remains authoritative. Store `OBS_WEBSOCKET_PASSWORD`
outside source control; OpenRepurpose copies it to the encrypted vault. Non-loopback endpoints must
use `wss://`.
