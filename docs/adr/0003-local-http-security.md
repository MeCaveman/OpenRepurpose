# ADR 0003: Local HTTP security boundary

## Status

Accepted — v0.1 Packet 3.

## Context

The localhost UI needs a real HTTP server without making the eventual Linux VPS deployment a
separate application. Localhost alone is not a security boundary: browsers can be induced to send
cross-origin requests, Host headers can be abused for DNS rebinding, and session state must remain
valid across process restarts.

## Decision

Use Fastify 5 as the local HTTP composition root and `@fastify/static` for the production React
bundle. Fastify is configured with `trustProxy: false`; reverse-proxy trust remains a future
server-mode decision. Packet 3 refuses non-loopback `BIND_HOST` and public `APP_URL` values at
startup, while retaining those typed configuration fields for the roadmap packet that enables
public/server operation.

Use `@fastify/secure-session` with a generated 32-byte key stored at the configured
`SESSION_KEY_PATH`. The session cookie is encrypted, HTTP-only, same-site strict, time-limited, and
marked secure when `APP_URL` uses HTTPS. Mutating `/api/*` requests require all of:

- an exact configured browser Origin;
- a valid encrypted session cookie;
- a session-bound CSRF token supplied through `x-csrf-token`.

All requests also require an allowed Host. The implementation does not trust forwarded headers and
does not expose CORS. Error responses and logs use classifications rather than request headers,
cookies, session contents, or arbitrary error objects.

The implementation follows current official Fastify guidance:

- Fastify warns against listening on all interfaces and defaults proxy trust to false:
  https://fastify.dev/docs/latest/Reference/Server/
- `@fastify/static` is the maintained static-file adapter for Fastify 5:
  https://github.com/fastify/fastify-static
- `@fastify/secure-session` provides encrypted stateless cookie sessions and requires a 32-byte key:
  https://github.com/fastify/fastify-secure-session

## Consequences

- Session protection survives restarts without a shared in-memory store or external service.
- The generated key is local infrastructure state, not a platform credential; Packet 6 still owns
  the general `SecretStore` abstraction.
- Vite development uses an explicitly configured development origin and proxies `/api` to Fastify.
- LAN/VPS exposure, authentication, and trusted reverse-proxy configuration remain intentionally
  disabled until their owning roadmap packets.
