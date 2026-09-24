# MCP and local API

## MCP

Start the stdio MCP server with `openrepurpose mcp start`. It is a local process boundary, not a
network listener. Configure an MCP client to launch that command and communicate over stdin/stdout.
The server exposes allowlisted tools that call the same application services as the UI and CLI.

## REST API v1

Create and administer revocable tokens locally:

```text
openrepurpose api token create automation
openrepurpose api token create observer --read-only
openrepurpose api token list
openrepurpose api token revoke <token-id>
```

Send the token only in `Authorization: Bearer ...`. It is displayed once; SQLite stores only a
verifier. OpenAPI 3.1 is available at `GET /api/v1/openapi.json`. Create/import/publish requests
require an `Idempotency-Key` so safe retries do not duplicate work.

The browser does not use API bearer tokens; it uses a local encrypted session plus Origin/CSRF
checks. LAN access adds a separate browser/static boundary and does not replace API permissions.
See the [API reference](api/README.md) for pagination, error envelopes, webhooks, and resource groups.
