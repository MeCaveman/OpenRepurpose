# Linux portable installation

The Linux x64 portable artifact contains the pinned Node runtime and the production application.
Node.js, pnpm, and workspace source files are not required on the installed machine. Download and
verify the release archive, then extract it in a directory owned by the account that will run
OpenRepurpose:

```sh
tar -xJf OpenRepurpose-linux-x64.tar.xz
cd OpenRepurpose
sha256sum -c SHA256SUMS.txt
./openrepurpose doctor
./openrepurpose start
```

The artifact targets x86_64 GNU/Linux with glibc. It is produced and smoke-tested on a clean Ubuntu
runner. Linux arm64 is not released in this packet because there is no ARM64 CI runner or clean-host
evidence yet. Alpine/musl systems should use the Docker deployment or wait for a separately tested
musl artifact.

## Runtime dependencies

The portable server needs no system Node.js or pnpm. It does require a normal POSIX userland with
`/bin/sh` and glibc. FFmpeg and ffprobe are intentionally external until Packet 7 verifies their
licensing and provenance. Install them through the distribution package manager when using media
imports or transforms; `openrepurpose doctor` checks application paths and migrations, while media
commands explain when either executable is unavailable. Whisper.cpp and transcription models are
also user-provided/explicitly installed.

## Persistent locations and upgrades

For a desktop/user service, default paths follow XDG:

| Data                                                                  | Default location                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Configuration, session key, vault key                                 | `$XDG_CONFIG_HOME/OpenRepurpose` or `~/.config/OpenRepurpose`    |
| SQLite database, encrypted vault, media metadata, derivatives, models | `$XDG_DATA_HOME/OpenRepurpose` or `~/.local/share/OpenRepurpose` |
| Managed temporary files                                               | `$TMPDIR/OpenRepurpose` or the system temporary directory        |

Keep those locations outside the extracted release directory. To upgrade, stop the process, extract
the new archive beside the old one, run `./openrepurpose doctor` from the new directory under the
same account, then start it. Existing migrations create a pre-upgrade SQLite backup before applying
pending migrations. Do not copy a fresh configuration/data directory over an existing installation.

For a system service, create an unprivileged `openrepurpose` account, make `/etc/openrepurpose` and
`/var/lib/openrepurpose` writable only by that account, and set absolute paths in an `EnvironmentFile`:

```ini
APP_CONFIG_DIR=/etc/openrepurpose
APP_DATA_DIR=/var/lib/openrepurpose/data
APP_TEMP_DIR=/var/lib/openrepurpose/tmp
WHISPER_MODEL_DIR=/var/lib/openrepurpose/models
```

Use the systemd and reverse-proxy guidance in [headless and LAN deployment](self-hosting.md). Keep
the service loopback-only unless LAN mode, an access token, and TLS/reverse-proxy protections are
explicitly configured.
