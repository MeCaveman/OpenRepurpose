# Workflow tutorial

A workflow is a durable route:

```text
source -> optional filters/transforms/transcription -> one or more destinations
```

## Build the first route

1. **Connect a destination.** Under **Accounts**, connect an authorized YouTube, TikTok, Facebook
   Page, or Instagram professional target. Read any capability blocker before continuing.
2. **Choose a source.** Import a local original, add a watched folder, or configure a supported
   YouTube/Twitch/Kick source. Remote metadata does not always include reusable media bytes.
3. **Create a workflow.** Under **Workflows**, name it and choose the source and destinations.
4. **Start simple.** Leave optional stages collapsed unless the destination needs a transform,
   transcript, or filter. A preset creates an ordinary editable workflow, not hidden behavior.
5. **Review the route preview.** Confirm each stage and destination before saving.
6. **Run and inspect.** Execution snapshots the workflow input. Later edits do not mutate an active
   job. Use **Jobs** for attempts, retry timing, destination processing, cancellation, and errors.

## Reliability rules

- A successful byte upload can still be processing remotely.
- Destination checkpoints and idempotency prevent a restart from blindly republishing a completed target.
- Retries are bounded and persisted. Authentication, permission, validation, and terminal platform
  failures require user action rather than endless retry.
- Only use media you own or are authorized to reuse.

For recording automation, continue with the [OBS guide](obs.md).
