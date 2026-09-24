# Upgrade database fixtures

These are committed SQLite databases, not databases assembled inside the upgrade tests. They contain
synthetic records only; no credentials, tokens, personal data, or usable secrets are present.

`v0.9-latest.sqlite.fixture` is pinned to commit
`fa974d48b86881159506094b33058c55433aee3c`, the final v0.9 repository state immediately before
v1.0 Packet 1. The repository did not publish a v0.9 tag or artifact, so the manifest records that
limitation instead of claiming release provenance that does not exist. Its ledger ends at
`0026_webhooks`, exactly as that commit did.

The matrix also stores:

- `v0.8-latest.sqlite.fixture`, populated at the final v0.8 schema boundary; and
- `v0.4-migrated-chain.sqlite.fixture`, created at the v0.1 boundary, populated there, then migrated
  in place through v0.4 before being stored.

`manifest.json` pins the source commit, ordered migration IDs, byte length, and SHA-256 for every
fixture. Tests verify those values before copying a fixture to a temporary directory. They never
open a committed fixture for writing.

Regenerate only when deliberately replacing the compatibility corpus:

```text
corepack pnpm fixtures:upgrade
```

Review every binary/hash change. Adding a new migration does not by itself justify rewriting old
fixtures; old fixture bytes are compatibility evidence.
