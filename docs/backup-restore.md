# Backup and restore

OpenRepurpose v1 backups are single `.orpbackup` files containing a versioned manifest and a
validated SQLite snapshot. Stop the server before restore.

```text
openrepurpose backup create
openrepurpose backup create --output /safe/path/openrepurpose.orpbackup
openrepurpose backup create --include-metadata
openrepurpose backup restore /safe/path/openrepurpose.orpbackup
```

The default output directory is `<data directory>/backups`. `--include-metadata` adds a bounded
manifest list of referenced media and workflow-source paths; it does not copy those files.

## Portable-backup contents

Included:

- the SQLite database, including workflows, settings, job history, schedules, and safe account
  metadata;
- the applied migration IDs and checksums;
- optional external-path references.

Excluded:

- the secret vault and its key;
- OAuth access/refresh tokens, client secrets, webhook signing secrets, and OBS passwords;
- API bearer-token verifiers and incomplete OAuth requests;
- media files, cached derivatives, transcription models, and model runtimes.

Because secrets are excluded, the exported snapshot marks account and source metadata for reconnect
and disables persisted webhook destinations. The original database is not modified by export.
After restore, reconnect platform accounts and recreate API tokens. Webhook secrets continue to come
from the current deployment configuration.

Restore checks the container version, manifest shape, payload length and SHA-256, SQLite integrity,
and the complete migration ledger before touching the configured database. If a current database
exists, OpenRepurpose first writes an exact `pre-restore-*.bak` recovery copy. Restore refuses to run
when it cannot obtain the database lock; stop every OpenRepurpose server/worker process and retry.

The portable format deliberately does not extract paths from an archive, so paths recorded as
metadata cannot write files during restore.

## Upgrade recovery copies

When an existing migrated database has pending migrations, the migration runner checkpoints SQLite
and creates an exact `pre-upgrade-*.bak` database before applying the first change. New/empty
databases do not produce an upgrade copy. These exact local recovery copies can contain local API
authentication verifiers and other database metadata, so protect the backup directory like the
database itself.

Neither portable restore nor upgrade requires deleting the database.

## Secret-vault migration and recovery

The supported v1 strategy is the versioned AES-256-GCM file vault on Windows, Linux desktop, Docker,
and headless Linux. The random 32-byte key remains separate from the vault and both files receive
owner-only permissions where the host supports them. This protects against casual inspection and a
vault-only copy; it does not protect against malware or another process running as the same user.

On first v1 use, OpenRepurpose decrypts every v0.x vault entry before changing anything, writes an
owner-only `.v1.backup`, and atomically writes vault format 2. If the key is missing, invalid, or does
not match, OpenRepurpose creates no replacement key and leaves the vault untouched.

```text
openrepurpose secrets status
openrepurpose secrets migrate
openrepurpose secrets recover --confirm-reconnect
```

Recovery archives the vault/key rather than deleting them, removes transient authentication
verifiers, and marks connected account metadata for reconnect. Try restoring the matching original
key and vault before choosing recovery.

OS keyrings are not the v1 default because the same implementation must work on unattended Linux
and containers where a desktop keyring/session service may not exist. An OS-keyring adapter can be
added later behind the existing `SecretStore` contract.

OpenRepurpose does not currently offer secret-inclusive portable export. Co-locating the vault and
key would defeat their separation, and a passphrase export should not be added without a deliberate
memory-hard KDF and recovery design.
