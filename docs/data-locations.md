# Data locations

OpenRepurpose resolves host-native paths and keeps persistent data outside the portable release directory.

| Purpose                                      | Windows default                | Linux default                                                    |
| -------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Configuration, session key, vault key        | `%APPDATA%\OpenRepurpose`      | `$XDG_CONFIG_HOME/OpenRepurpose` or `~/.config/OpenRepurpose`    |
| SQLite, encrypted vault, derivatives, models | `%LOCALAPPDATA%\OpenRepurpose` | `$XDG_DATA_HOME/OpenRepurpose` or `~/.local/share/OpenRepurpose` |
| Managed temporary files                      | `%TEMP%\OpenRepurpose`         | `$TMPDIR/OpenRepurpose` or system temp                           |

Exact effective paths are shown by `openrepurpose config show`. Override with absolute
`APP_CONFIG_DIR`, `APP_DATA_DIR`, `APP_TEMP_DIR`, `DATABASE_URL`, `SESSION_KEY_PATH`,
`SECRET_KEY_PATH`, `SECRET_VAULT_PATH`, and `WHISPER_MODEL_DIR` values. Relative paths are rejected.

The configuration directory is sensitive because it contains session/vault key material. The data
directory contains the database, encrypted vault, account metadata, job history, derivatives,
models, and recovery copies. Portable backups intentionally exclude secrets, media, derivatives,
and models.

Docker uses named mounts at `/etc/openrepurpose`, `/var/lib/openrepurpose/data`,
`/var/lib/openrepurpose/models`, and `/var/lib/openrepurpose/tmp`, plus explicit authorized media
mounts. See [Docker/headless](docker-headless.md).
