# ADR 0009: Optional external downloader boundary

## Status

Accepted — v0.7 architectural retrofit, 2026-09-21.

## Context

ADR 0006 and the v0.4 implementation already separate detection-only `SourceAdapter` polling from
durable media resolution. `MediaResolutionService` coordinates local-original reuse, managed
staging, media import, resolution checkpoints, retry-visible errors, and later cleanup through the
generic `MediaResolver` port. No concrete remote downloader currently ships.

A future post-v1.0 downloader must fit below that existing resolution boundary. Without a narrower
port, a process-backed implementation could accidentally make application code understand an
executable path, command arguments, version output, or tool-specific failure format. It could also
tempt source account configuration to become downloader configuration. Both outcomes would weaken
the existing modular boundary.

## Decision

### Discovery and downloading remain separate capabilities

`SourceAdapter` remains detection-only. It may report that an observed item supports the generic
`external_downloader` resolution strategy and supply an opaque, non-empty external-download
locator. It does not select, construct, configure, invoke, or depend on a downloader implementation.
The locator is handoff data for media acquisition, not source-account configuration.

The application pipeline remains:

```text
SourceAdapter.poll
        |
        v
MediaResolutionService
        |
        v
ExternalDownloaderMediaResolver
        |
        v
ExternalDownloaderRegistry -> ExternalDownloader implementation (infrastructure)
```

Official API downloads may continue to use other `MediaResolver` implementations. The narrower
external-downloader port is used only for the explicitly declared `external_downloader` strategy.

### Generic downloader port

`ExternalDownloader` is a core/application contract with:

- a stable implementation ID;
- capability inspection, including availability, supported operations, and an optional detected
  implementation/tool version;
- a synchronous check for a generic locator;
- an abortable download operation into an application-provided managed staging path;
- a generic result that identifies the output path and may report the actual version used; and
- structured, implementation-neutral failures with retryability.

The contract contains no platform names and no assumptions about a particular executable. Raw
process output, command arguments, secrets, and implementation-specific result formats must remain
inside the concrete infrastructure adapter.

`ExternalDownloaderMediaResolver` translates between this port and the existing `MediaResolver`
contract. It maps downloader failures to stable `MediaResolutionError` classifications and safe
public messages. `MediaResolutionService` still owns staging/finalization, media probing/import,
durable checkpoints, restart reuse, and cleanup ownership. Downloaders do not publish, transform,
schedule, delete, or control workflows.

### Registration and configuration

`ExternalDownloaderRegistry` is a composition-time registry. The server composition root currently
creates it empty, so an installation with no downloader remains fully supported. A disabled or
unconfigured implementation is not registered.

Future implementation configuration belongs to typed application/infrastructure configuration,
separate from `SourceAdapter` connection/account configuration. A concrete adapter may receive an
enabled state, executable path, and implementation-specific settings in its constructor. Those
settings must not enter source domain models or the generic downloader contract. Adding an
implementation should normally require only:

1. implementing `ExternalDownloader` in an infrastructure/integration package;
2. loading its separate typed configuration and conditionally registering it at composition;
3. adding implementation contract/process tests; and
4. exposing configuration/diagnostics appropriate to that implementation.

No unrelated workflow, job, destination, FFmpeg, scheduler, or cleanup service should change.

### Safety and optionality

External downloading remains optional. An empty registry produces the existing stable
`MEDIA_RESOLVER_UNAVAILABLE` resolution failure and does not prevent local originals, official
downloads, imports, transforms, destinations, scheduling, or other application functions from
operating.

The existing explicit-rights-confirmation check runs in `MediaResolutionService` before the
external downloader bridge is invoked. Concrete adapters must not bypass authentication/access
controls, DRM, platform restrictions, or this rights gate.

## Future implementation note

`yt-dlp` is one possible post-v1.0 infrastructure implementation of `ExternalDownloader`. It is
not installed, bundled, invoked, configured, or required by this decision. If it is added later,
its executable discovery, argument construction, version parsing, output parsing, and process
failures must remain inside that adapter.

## Consequences

- Source discovery and external downloading have independent contracts and configuration owners.
- Core orchestration depends on a generic port and contains no concrete downloader process logic.
- Capability/version diagnostics and structured failures are available without making a downloader
  mandatory.
- Existing resolution checkpoints, job orchestration, transform processing, destination publishing,
  and cleanup behavior remain unchanged.
- A source adapter declaring `external_downloader` must provide a generic non-empty locator; current
  adapters declare no such strategy, so their behavior is unchanged.
