# ADR 0012: External-control security threat model

## Status

Accepted — v0.9 Packet 1. This ADR extends ADR 0003; it does not relax the existing local HTTP
boundary.

## Context

v0.9 adds authenticated REST, MCP, outbound webhooks, and opt-in LAN/headless operation. These
surfaces can publish media, schedule work, read local metadata, and cause network or child-process
activity. Loopback binding reduces reachability but is not authentication: a malicious web page can
target localhost, DNS can be rebound, and a broadly authorized local client can be compromised.

Assets to protect are platform credentials, API/session secrets, private media and metadata, local
files outside managed roots, publishing authority, workflow/job integrity, and the availability of
the host and configured remote services.

The relevant trust boundaries are:

```text
browser / API client / MCP client
               |
               v
HTTP or MCP boundary -> application services -> repositories / jobs
                                              -> managed filesystem / child processes
                                              -> platform APIs / webhook destinations
```

Workflow definitions, source metadata, filenames, webhook responses, platform errors, and all
remote HTTP data are untrusted even after the caller is authenticated. A process or administrator
that can read OpenRepurpose's memory and all of its secret files is outside this model; the existing
encrypted local vault still limits casual or vault-only disclosure, not same-user host compromise.

## Decision

### Authority and network boundary

- Loopback remains the default. Non-loopback binding is an explicit headless/LAN configuration and
  must fail closed unless authentication is enabled.
- Browser mutations continue to require an allowed Host, exact configured Origin, encrypted
  session, and session-bound CSRF token. Browser code does not receive or persist machine API
  tokens, and the API does not enable permissive CORS.
- Non-browser REST and any network MCP transport use revocable, high-entropy bearer credentials.
  A credential is returned only when created; persistence keeps a non-recoverable verifier plus
  safe metadata and permissions. Credentials are accepted only in the `Authorization` header,
  never in a URL, and comparisons are timing-safe.
- Read and control authority are distinguishable. Publishing, running or scheduling a workflow,
  cancellation, token administration, and configuration changes require explicit control
  permission; possession of a read credential is insufficient.
- LAN mode requires authentication for every non-health resource. Plain HTTP on a non-loopback
  interface produces a prominent startup warning; documented HTTPS termination is the supported
  deployment. Forwarded headers are trusted only under explicit reverse-proxy configuration.
  OpenRepurpose never opens firewall/router ports automatically.

### MCP authority

- MCP is a thin, allowlisted mapping to the same application services used by REST, CLI, and UI.
  Every tool has a strict schema, bounded inputs, explicit identifiers/options, and the minimum
  required permission.
- Side-effecting tools are marked as such and use protocol confirmation annotations when supported.
  Their result describes the accepted job/action without implying remote publication is complete.
- MCP exposes no raw shell, arbitrary filesystem read/write, unrestricted SQL, arbitrary URL fetch,
  secret retrieval, OAuth material, or free-form FFmpeg arguments. Client-provided tool names or
  workflow data never select an executable or application implementation dynamically.
- Publish and schedule requests use the same idempotency and immutable job/workflow snapshot
  semantics as other entry points. Audit records identify the credential/client and action but do
  not retain secrets or unbounded raw arguments.

### Child processes and paths

- Executables are selected by trusted configuration or registered providers and spawned directly
  with argument arrays and `shell: false`. User or workflow text is never concatenated into a shell
  command. Media operations accept typed recipes, not arbitrary command strings.
- Externally supplied identifiers are not filesystem paths. Managed paths are derived from safe
  segments below configured roots, normalized with host-native path functions, and checked after
  canonicalization. Reads, writes, cleanup, and archive/import operations reject traversal,
  absolute-path substitution where not explicitly supported, symlink/junction escape, and
  platform-specific separator tricks.
- Explicit local-file import remains a deliberate operator capability, but the API/MCP returns safe
  media metadata rather than creating a general filesystem browser.

### Outbound webhooks and SSRF

- Webhook delivery is default-deny. The operator must explicitly configure each destination; source
  content and workflow/template output cannot supply or override the URL.
- Destinations permit only `http` or `https`, reject embedded credentials and fragments, and are
  validated at configuration and again for every delivery. DNS results and the actual connection
  target must satisfy the policy on every attempt. Redirects are disabled unless every hop is
  resolved and revalidated under the same policy.
- Link-local, unspecified, multicast, reserved, and cloud/container metadata targets are always
  blocked. Loopback or private-network targets require an explicit endpoint allowlist entry; being
  private is not itself authorization. Public targets also require an explicit entry.
- Delivery has short connect/overall timeouts, bounded request and response bodies, bounded retries
  with jitter, and concurrency limits. Payloads use an event allowlist and never contain credentials,
  session data, request headers, local absolute paths, or arbitrary error objects.
- A per-destination secret signs the exact transmitted body with a timestamp and delivery ID. The
  secret remains in `SecretStore`, is never returned by read APIs, and is not logged.

### Untrusted workflow and error data

- REST and MCP boundaries validate with strict, versioned schemas that reject unknown fields and
  bound strings, arrays, object depth, body size, pagination, and batch counts. Application services
  re-check domain invariants and adapter capabilities rather than trusting transport validation.
- Workflow execution uses an immutable validated snapshot. Template expansion is text-only and
  output-bounded; it cannot become a path, executable, header, credential, or webhook URL. Remote
  source metadata cannot grant rights confirmation or select a local original.
- Create/publish/run operations require idempotency where replay could duplicate side effects.
  Request, tool, queue, and adapter concurrency remain bounded so authenticated input cannot create
  unbounded work.
- Logs, persisted job errors, API/MCP responses, webhook payloads, and CLI stderr use classified,
  size-bounded errors. Structured redaction covers authorization/cookie/session fields, token and
  secret key variants, OAuth codes/verifiers, signed upload URLs, and registered literal secrets;
  unknown exception messages and stacks do not cross a boundary verbatim.

## Threat and verification matrix

| Threat                                   | Required control                                                                                                  | Release evidence                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Malicious localhost page / DNS rebinding | Host allowlist, exact Origin, session + CSRF for browser mutations, no permissive CORS                            | Existing ADR 0003 tests remain; Packet 7 adds unauthorized/cross-origin regression coverage |
| LAN exposure                             | Explicit bind, mandatory auth, HTTPS warning/docs, explicit proxy trust                                           | Packet 5 startup/configuration tests                                                        |
| Bearer/token leakage                     | One-time display, verifier-only storage, header-only transport, permissions, revocation, redaction                | Packet 2 token and response/log tests; Packet 7 unauthorized/revoked-token E2E              |
| Overpowered MCP client                   | Allowlisted typed tools, least permission, side-effect annotations, no ambient shell/filesystem/SQL/secret access | Packet 3 schema/authority tests and mocked side-effect tests                                |
| Command injection                        | Registered executable + argument array, `shell: false`, typed media recipes                                       | Existing media tests remain; Packet 3 rejects free-form command surfaces                    |
| Path traversal                           | Safe IDs, managed roots, canonical containment, symlink/junction rejection, no filesystem-browser tool            | Packet 2 malicious-path tests and Packet 7 E2E                                              |
| Webhook SSRF                             | Explicit endpoint allowlist, per-attempt DNS/peer validation, metadata/link-local block, redirect revalidation    | Packet 4 resolver/delivery tests and Packet 7 blocked-metadata E2E                          |
| Untrusted workflow input                 | Strict bounded schemas, application invariant checks, immutable snapshots, idempotency                            | Packets 2–3 boundary tests and existing workflow/job tests                                  |
| Secret disclosure                        | `SecretStore`, minimal safe DTO/event fields, layered redaction, classified errors                                | Existing redaction tests plus Packet 2/3/4 response, tool, and delivery tests               |

The owning packet must implement and test its controls before exposing that surface. A missing
control is a release blocker, not a documented risk acceptance.

## Residual risks

- Same-user malware, a privileged host administrator, or a compromised OpenRepurpose process can
  exercise the user's effective local authority and may read memory or both vault files.
- A stolen control credential can perform its permitted actions until revoked. Short exposure,
  least permission, TLS outside loopback, and useful audit metadata reduce but do not remove this
  risk.
- An authorized publish, local-file import, or explicitly allowlisted webhook can disclose data by
  design. The UI/CLI must make the destination and side effect clear before authority is granted.
- Media processing is resource intensive. Size, concurrency, timeout, quota/disk-space, and retry
  bounds limit denial of service but cannot make processing untrusted media risk-free.

## Consequences

- API, MCP, webhook, and LAN packets have concrete security acceptance gates before they expose new
  control surfaces.
- Local and headless deployments share application services while using transport-appropriate
  authentication.
- Default-deny webhook policy requires explicit configuration, including for localhost/private
  destinations, but avoids turning OpenRepurpose into an ambient network request primitive.
- No frontend code or new runtime surface is introduced by this packet.
