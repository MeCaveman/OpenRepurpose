# Privacy and security model

OpenRepurpose is local-first, not offline-only. SQLite state, configuration, media metadata, logs,
derivatives, models, sessions, and the encrypted secret vault stay on the configured host. A workflow
sends selected media/metadata to configured platform APIs or webhooks; model downloads and update
checks occur only when explicitly requested. No telemetry is sent by default.

## Security boundaries

- loopback binding is the default;
- non-loopback/LAN mode is explicit, authenticated, and should use TLS or a protected reverse proxy;
- browser mutations use Origin, CSRF, and session checks;
- REST uses revocable scoped bearer tokens; MCP is local stdio;
- OAuth uses one-time state and PKCE where supported/required;
- app secrets and OAuth tokens stay in `SecretStore` and are redacted from logs/errors;
- child processes use executable/argument arrays, never shell-concatenated input;
- webhook destinations are allowlisted and protected against redirects, DNS rebinding, and unsafe addresses.

The AES-256-GCM file vault separates its random key from encrypted data and uses owner-only
permissions where supported. It limits casual disclosure and vault-only backup exposure; it cannot
protect against malware, an administrator, or another process running as the same OS user.

Protect the OS account, configuration/data directories, backups, media mounts, reverse proxy, and
developer-app credentials. Use least-privilege scopes. Do not expose the backend port directly to
the internet. Review third-party plugin code before enabling it: declarations do not provide isolation.

Report vulnerabilities through [SECURITY.md](../SECURITY.md), not a public issue.
