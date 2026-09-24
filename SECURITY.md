# Security policy

## Supported versions

OpenRepurpose is pre-release software. Security fixes are applied to the current development branch;
older snapshots and unreleased branches are not supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository when it is available. Include
the affected revision, impact, reproduction steps, and any suggested mitigation. Do not include live
credentials, OAuth tokens, private media, or other people's data.

If private vulnerability reporting is unavailable, open a minimal public issue asking the maintainers
for a private contact channel. Do not publish exploit details in that issue. Please allow the
maintainers time to investigate and prepare a coordinated fix before public disclosure.

## Security model

OpenRepurpose is local-first and binds to loopback by default. LAN exposure is opt-in and requires an
access token; operators are responsible for TLS termination and host security when exposing it beyond
the local machine. API tokens and local process access are security boundaries. The MCP transport is
local stdio and inherits the authority of the process that launches it; it is not a network listener.
Third-party plugins run in process and therefore remain disabled by default unless the operator
accepts that risk.

The project does not request secrets in bug reports. Redact tokens, authorization headers, cookies,
signed URLs, local paths, and personally identifying media metadata from diagnostics before sharing
them.
