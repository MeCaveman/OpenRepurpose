# Quick Start — Linux

The portable release targets x86_64 glibc Linux. Linux arm64 and Alpine/musl artifacts are not
currently released.

```sh
sha256sum -c OpenRepurpose-linux-x64.tar.xz.sha256
tar -xJf OpenRepurpose-linux-x64.tar.xz
cd OpenRepurpose
./openrepurpose doctor
./openrepurpose start
```

Open the printed loopback URL, normally `http://127.0.0.1:3000`. The artifact includes Node.js and
production dependencies but not FFmpeg/ffprobe, whisper.cpp, or model files.

## First setup

Open **Setup**, register its exact callback URIs in your own platform apps, then connect accounts and
targets. Read [platform setup](platform-setup/README.md), [FFmpeg setup](ffmpeg.md), and the
[workflow tutorial](workflow-tutorial.md).

## Service and upgrade

Keep the extracted release separate from XDG configuration/data. For a service, use an unprivileged
account and absolute `APP_CONFIG_DIR`, `APP_DATA_DIR`, `APP_TEMP_DIR`, and `WHISPER_MODEL_DIR`
values. Stop the old process, create a backup, extract the new release beside it, run `doctor`, then
start it under the same account. See [Docker/headless operation](docker-headless.md) for systemd,
reverse proxy, authenticated LAN mode, and volume guidance.

The older [Linux portable installation notes](linux-install.md) remain the packaging-specific
reference. Data paths and removal are documented in [data locations](data-locations.md) and
[uninstall](uninstall.md).
