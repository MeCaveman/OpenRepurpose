# Windows x64 portable release

Packet 5 ships a portable Windows x64 ZIP. It contains a pinned Node runtime, the production CLI
and its deployed workspace dependencies, and the built dashboard. A normal user extracts the ZIP
and runs `openrepurpose.cmd start`; Node.js, pnpm, and the source workspace are not required.

The artifact deliberately does not bundle FFmpeg, ffprobe, whisper.cpp, or transcription models.
Those tools remain optional, user-supplied/configured dependencies until Packet 7 completes their
license, codec, provenance, and notice audit. `openrepurpose.cmd doctor` verifies writable local
paths and SQLite migrations; media commands report a clear missing-tool error if applicable.

## Build

Run from a Windows checkout with the pinned Node/pnpm toolchain:

```powershell
.\scripts\package-windows.ps1
.\scripts\smoke-windows-artifact.ps1 -ArtifactDirectory .\artifacts\windows-x64
```

`package-windows.ps1` installs from `pnpm-lock.yaml`, builds every workspace package, uses pnpm's
production deployment for the CLI dependency graph, copies the web production build, and downloads
the exact Node archive recorded in `scripts/release/windows-runtime.json`. The archive SHA-256 is
verified before packaging. `build-metadata.json` records the source commit and runtime digest, while
`SHA256SUMS.txt` records every shipped file.

For an offline/reproducible release build, obtain the exact archive named in
`scripts/release/windows-runtime.json` from Node's official release mirror, verify its SHA-256, and
pass its path explicitly:

```powershell
.\scripts\package-windows.ps1 -NodeRuntimeArchive C:\release-inputs\node-v24.21.0-win-x64.zip
```

The script rejects a runtime whose locked hash or Node version differs. The ZIP is a portable
artifact, not an MSI installer; upgrades and uninstall/data-removal guidance remain Packet 9 work.

## Clean-user-profile smoke

The smoke script extracts the ZIP into a fresh installation directory, overrides `APPDATA`,
`LOCALAPPDATA`, `TEMP`, and `TMP` with a directory inside the artifact, runs the packaged `doctor`,
starts the packaged server, checks `/api/health`, and verifies that the built dashboard is served.
It never reads or writes the builder's normal OpenRepurpose profile. Run it on a clean Windows VM
for release-candidate evidence.
