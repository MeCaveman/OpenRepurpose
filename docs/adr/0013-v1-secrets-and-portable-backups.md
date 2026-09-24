# ADR 0013: v1 secret vault and portable backup format

## Status

Accepted for v1.0 Packet 3.

## Decision

Keep `SecretStore` as the application boundary and promote the existing AES-256-GCM local vault to
a fail-closed, versioned format. Vault format 2 binds entries to their reference, records a key
fingerprint, validates all entries before migration, and retains an immutable legacy copy. Missing
or mismatched key material never causes automatic key replacement. Explicit recovery archives both
files and requires account reconnection.

Use the encrypted file vault as the common v1 implementation for Windows, Linux desktop, Docker,
and headless Linux. Do not add a native OS-keyring dependency until packaging work can prove a
reliable unattended fallback and migration path.

Use a single versioned portable-backup container: fixed magic, bounded JSON manifest, then one raw
SQLite payload. The manifest authenticates the payload with its size and SHA-256 and records the
migration ledger. Restore validates the entire input before replacement and preserves the current
database as an exact recovery copy.

Portable snapshots are sanitized copies. They exclude secret files, API token verifiers, transient
OAuth state, media, derivatives, and models, and mark secret-dependent metadata for reconnect. An
optional manifest section records external paths without copying or extracting them.

Create exact local database recovery copies before upgrades and restores. These are local rollback
artifacts, not portable secret-free exports.

## Consequences

- The same secret implementation works without desktop services or a cloud dependency.
- A missing key becomes an explicit recover-or-reconnect event with no silent vault loss.
- Portable restores cannot unexpectedly retain authentication authority from the source host.
- Backup restore avoids general archive extraction and its path-traversal surface.
- Portable backups can be larger than compressed archives; media and model payloads remain outside
  the format.
- Secret-inclusive export remains unsupported until a separately reviewed passphrase/KDF design is
  available.
