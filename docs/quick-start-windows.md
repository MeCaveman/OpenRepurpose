# Quick Start — Windows

## Install

1. Download the official Windows x64 ZIP, checksum file, and release notes from the same release.
2. Verify the published SHA-256 before extraction:

   ```powershell
   Get-FileHash .\OpenRepurpose-windows-x64.zip -Algorithm SHA256
   ```

3. Extract to a user-writable folder such as `C:\Tools\OpenRepurpose`. Do not extract over a running
   installation or store application data inside the release folder.
4. Run:

   ```powershell
   .\openrepurpose.cmd doctor
   .\openrepurpose.cmd start
   ```

5. Open the printed loopback URL. The default is `http://127.0.0.1:3000`.

The portable release includes Node.js and production dependencies. It does not include FFmpeg,
ffprobe, whisper.cpp, or model files. Configure those only when needed; see [FFmpeg setup](ffmpeg.md).

## First setup

Open **Setup** in the dashboard. Register each displayed callback URI in your own platform developer
app, then save credentials and connect under **Accounts**. Platform audits, app review, scopes,
account type, and quotas may limit publishing even after OAuth succeeds. See the
[platform guides](platform-setup/README.md).

## Upgrade and unattended startup

Stop OpenRepurpose, create a portable backup, extract the new release beside the old release, run
the new `doctor`, then start it under the same Windows account. Database migrations create a
pre-upgrade recovery copy when needed. Never copy a fresh data directory over the existing one.

For unattended operation, use Windows Task Scheduler to run `openrepurpose.cmd start --headless`
under a dedicated account. A Windows service wrapper is not bundled. Keep loopback binding unless
you deliberately configure authenticated LAN mode and TLS/reverse-proxy protection.

See [data locations](data-locations.md), [backup and restore](backup-restore.md), and
[uninstall](uninstall.md).
