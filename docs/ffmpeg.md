# FFmpeg and ffprobe setup

OpenRepurpose uses `ffprobe` JSON output for media inspection and spawns FFmpeg with an executable
plus argument array. Portable and Docker releases do not bundle either executable.

## Install safely

Choose a maintained build for your operating system. Record its source, version, SHA-256, build
configuration, enabled codecs, and license terms. GPL/nonfree codec choices can change your own
redistribution obligations. Do not copy an unaudited binary into an OpenRepurpose release.

Install `ffmpeg` and `ffprobe` on `PATH`, or set their absolute executable paths using the matching
configuration variables documented by the release and `.env.example`. Restart OpenRepurpose after
changing configuration, then run `openrepurpose doctor`.

`ffprobe` provides persisted duration, dimensions, codecs, frame rate, and stream metadata during
import. `ffmpeg` provides deterministic transforms, subtitle burn-in/muxing, and media derivatives.
Publishing a compatible local original may not need a transform, but destination validation can
still reject unsupported media.

If a service reports a missing executable, confirm that the service account—not only your
interactive shell—can execute the configured path. In Docker, add a specific audited build to a
derived image. Do not mount an arbitrary host executable without matching runtime libraries and
provenance.
