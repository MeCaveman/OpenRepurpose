# whisper.cpp process bridge

OpenRepurpose runs local transcription through the provider-neutral `TranscriptionProvider`
boundary. `whisper.cpp` is a media-infrastructure adapter, not a dependency of transcript storage,
the API, CLI, or UI.

## Runtime layout

The default roots are derived from the configured application data directory:

```text
<data>/
  tools/whisper-cpp/
    current.json
    installations/<version>/<platform>-<architecture>/
      whisper-cli[.exe]
      ...adjacent runtime libraries
  models/whisper-cpp/
    <model-id>/<model-version>/ggml-model.bin
```

Both roots are constructor inputs. A headless or container composition can mount different absolute
paths without changing application or domain code.

Executable discovery is deterministic:

1. an explicitly configured executable;
2. the active managed installation;
3. a packaged companion executable;
4. `whisper-cli` on `PATH`.

Every candidate must pass a direct `whisper-cli --version` probe. OpenRepurpose never constructs a
shell command.

## Managed installation strategy

`LocalWhisperCppInstallationStore` adopts one prepared whisper.cpp distribution directory into an
immutable, versioned target and activates it with a small manifest. The whole directory is copied so
Windows DLLs or Linux shared libraries shipped next to `whisper-cli` stay together. It validates the
source and copied executable before activation and applies the executable bit on non-Windows hosts.

Archive acquisition is deliberately outside the process bridge. A packaging layer or a future
user-initiated installer can download and verify an official release, extract it, then hand the
prepared directory to the store. This keeps installation Python-free and prevents silent downloads.
Model downloading, checksums, deletion, and disk-space UX belong to v0.7 Packet 3.

The upstream build and binary conventions are documented in the
[whisper.cpp quick start](https://github.com/ggml-org/whisper.cpp#quick-start). Its converted model
format and published model hashes are documented in the
[whisper.cpp model guide](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md).

## Invocation and output

The bridge invokes `whisper-cli` with an executable plus argv array and requests a JSON sidecar with
`--output-json` and `--output-file`. Input audio, model, and output paths remain single argv entries,
including Windows paths, spaces, Unicode, and shell-looking punctuation. Only a fixed allowlist of
typed provider options can add arguments.

Both stdout and stderr are drained. The bridge parses `--print-progress` diagnostics into monotonic
percent snapshots, caps retained diagnostics, enforces a time limit, cooperatively terminates on an
`AbortSignal`, force-kills after a grace period, and removes its temporary output directory on every
exit path. JSON offsets are validated as milliseconds and converted to provider-neutral transcript
cues. The current bridge intentionally reports `wordTimestamps: false`; whisper.cpp token timestamps
are not mislabeled as linguistic words.
