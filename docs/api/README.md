# Local API v1

## Outbound event webhooks

Outbound webhooks are configured by `WEBHOOK_DESTINATIONS_JSON`; an empty or absent array disables
all destinations. Every entry is an explicit allowlist record, including localhost and private
network targets. Source metadata and workflow templates cannot select or override the URL.

Supported subscriptions are `job.succeeded`, `job.failed`, `workflow.execution.started`, and
`workflow.execution.completed`. The configured secret is copied into `SecretStore` at startup and
is never written to SQLite. Deliveries include:

- `X-OpenRepurpose-Delivery`: durable delivery ID;
- `X-OpenRepurpose-Event`: event type;
- `X-OpenRepurpose-Timestamp`: Unix timestamp in seconds;
- `X-OpenRepurpose-Signature`: `v1=` plus the hexadecimal HMAC-SHA256 of
  `<timestamp>.<delivery-id>.<exact-body>`.

Delivery uses the persistent job runner and its attempt history. Redirects are not followed. DNS is
resolved and pinned on every attempt, the connected peer is revalidated, and unspecified,
link-local, multicast, reserved/documentation, carrier-grade NAT, and known metadata targets are
always rejected. Response bodies, timeouts, attempts, and retry delays are bounded by the
`WEBHOOK_*` settings in `.env.example`.

OpenRepurpose exposes its versioned local API at `/api/v1`. The generated OpenAPI 3.1 document is
available without authentication at:

```text
GET /api/v1/openapi.json
```

The document is generated from the same strict Zod request schemas used by the handlers. Unknown
request fields are rejected. Resource identifiers, string lengths, arrays, page sizes, and create
requests are bounded at the transport boundary; application services continue to enforce domain
rules.

## Authentication and authority

Non-browser clients send an API token only in the `Authorization` header:

```text
Authorization: Bearer orp_v1_<token-id>_<secret>
```

Tokens have `read` and/or `control` permission. `control` automatically includes `read`.
Publishing, creation, cancellation, scheduling, and token administration require `control`.
Tokens are returned once when created; SQLite stores only a SHA-256 verifier and safe metadata.
Revoked tokens stop authenticating immediately. Token values and verifiers never appear in list
responses or logs.

The localhost web application uses its encrypted browser session plus Origin/CSRF checks instead of
receiving or storing a machine token. A browser session can create a token through
`POST /api/v1/auth/tokens`; the CLI supports `openrepurpose api token create`, `list`, and `revoke`.

## Errors

Every v1 JSON error uses a stable envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request did not match the API schema.",
    "requestId": "req-1",
    "details": [{ "path": "metadata.title", "message": "Too small" }]
  }
}
```

`details` is optional and bounded. Unexpected exception messages, stacks, secrets, local media
paths, transform output paths, and resumable upload URLs are not returned.

## Pagination

Collection endpoints accept `limit` (default 25, maximum 100) and an opaque `cursor`. Responses
have a consistent shape:

```json
{
  "data": [],
  "page": { "limit": 25, "nextCursor": "djE6MjU" }
}
```

Omit `cursor` for the first page. `nextCursor` is absent on the last page.

## Idempotency

Create/import/publish endpoints require a bounded `Idempotency-Key` header. Records are scoped to
the authenticated token or browser session and operation. An identical replay returns the original
status and JSON with `Idempotency-Replayed: true`; reusing a key for a different request returns
`409 IDEMPOTENCY_KEY_REUSED`. In-progress duplicates return `409 IDEMPOTENCY_IN_PROGRESS`.

Token creation deliberately is not replay-cached because persisting its one-time plaintext result
would defeat verifier-only token storage.

## Resource groups

The v1 schema currently covers health/version, token administration, safe account metadata, media
and import, sources, workflows, jobs and cancellation, schedules, transforms, transcripts, and the
publish action. All operations delegate to the same application services used by the existing web
and CLI entry points. Legacy `/api/*` browser routes remain available during the v1 migration.
