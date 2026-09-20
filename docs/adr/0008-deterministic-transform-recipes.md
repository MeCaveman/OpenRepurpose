# ADR 0008: Deterministic transform recipes and derivative provenance

## Status

Accepted — v0.6 Packet 1, 2026-09-20.

## Context

OpenRepurpose needs to transform local media before publishing while remaining safe to run on a
single Windows or Linux host. Transform intent can come from two places: edits explicitly chosen
by the user and changes required only to satisfy a destination. Those reasons must remain visible
even when one FFmpeg process eventually performs both sets of work.

The pipeline also needs reliable cache reuse. A semantically identical request must have one stable
identity regardless of omitted defaults or object key order, while changes to source bytes,
effective recipe, output-profile policy, FFmpeg version, or selected encoder must invalidate reuse.
Persisting raw FFmpeg arguments would couple workflows to one executable version and could turn
user-controlled data into shell syntax.

## Decision

### Persist typed, versioned intent rather than commands

A transform plan is a versioned value with an ordered user recipe and an optional ordered
destination requirement. Each recipe contains typed steps and a typed output specification.
Supported v1 step families are trim, fit, audio, and image watermark. Styled text is deliberately
absent until the v0.7 subtitle/font work can provide predictable cross-platform font handling.

The destination layer records both a stable destination ID and an output-profile version. The
profile version identifies the platform policy that selected those compliance transforms. User
steps execute before destination-required steps. The two layers are not flattened in persisted
intent or provenance, even if a later command builder combines compatible filters into one process.

Recipes are validated with Zod at the application boundary. They contain values only—never an
executable name, raw filter graph, raw command fragment, or shell string. Stretch fitting must be
explicit. A trim uses millisecond bounds and declares either an end or a duration, never both.
The v1 `accurate` trim mode means the reference implementation decodes to the requested boundary;
future keyframe-copy behavior would require an explicit new mode or schema version.

### Normalize before hashing or persistence

Normalization parses the input, materializes every behavior-affecting default, and emits objects in
a fixed property order. It preserves step order because transforms are not generally commutative.
Defaults such as crop anchor, contain background, loudness targets, watermark placement, MP4
codec/pixel format, CRF, and software preset therefore cannot vary by caller or host.

The normalized v1 plan is the only recipe representation used for cache identity and derivative
provenance. Schema evolution must add a new version and an explicit normalizer; it must not silently
reinterpret an already-persisted normalized plan.

### Derive a cache key from all output-affecting inputs

The cache key is SHA-256 over canonical JSON containing:

- a cache-key format version;
- the source media fingerprint;
- the normalized transform plan, including the user/destination distinction;
- the destination output-profile version represented by that plan;
- the FFmpeg version; and
- the actual encoder implementation selected for the run.

Canonical JSON sorts object keys recursively while preserving array order. The public key is
prefixed with `sha256:`. A separate recipe hash uses the same canonical encoding over only the
normalized plan, so provenance can identify recipe equality independently of a particular source
or toolchain.

Packet 3 will reserve/cache through SQLite before process execution. Cache lookup may reuse only a
`succeeded` derivative whose finalized file and recorded source fingerprint still validate. A
pending, running, failed, or cancelled row is never a completed cache hit.

### Persist derivative state and immutable provenance

`transform_derivatives` stores one durable record per cache identity. It references the source
media asset, has a unique cache key, records the recipe hash and normalized plan JSON, and stores
the output-profile version, FFmpeg version, encoder, timestamps, state, and eventual output path,
size, and media metadata. The source fingerprint is copied into provenance so later changes at the
same source path are detectable.

Database constraints enforce the important shape: terminal success requires a finalized path,
size, completion time, and output metadata; non-success states cannot claim success output; failure
details are restricted to failed records. Source deletion is restricted while provenance exists.
Packet 3 owns state transitions, concurrency reservation, file validation, atomic finalize, and
cleanup behavior.

## Rejected alternatives

- **Persist FFmpeg command strings:** unsafe, non-portable, hard to migrate, and incompatible with
  the rule that user values never become shell syntax.
- **Hash raw request JSON:** omitted defaults and object insertion order would create avoidable
  cache misses, and future caller behavior could accidentally change identity.
- **Hash only source plus recipe:** encoder/tool upgrades and destination-policy changes can alter
  bytes without changing the visible steps.
- **Flatten user and destination transforms:** this loses the explanation for a platform-induced
  change and makes later UI inspection and policy upgrades ambiguous.
- **Store derivatives only as ordinary media assets:** media assets do not contain the transform
  recipe, toolchain, policy, or state needed for recovery and safe cache reuse.
- **Include text overlays in v1:** reliable font discovery, packaging, and shaping across Windows
  and headless Linux is not established in this packet.

## Consequences

- Packet 2 can compile a closed, validated value model into an executable plus argument array; it
  does not need to parse free-form FFmpeg syntax.
- Destination changes remain auditable, and one effective normalized plan can later be shared by
  multiple destinations when their complete cache identity matches.
- FFmpeg patch-version or encoder changes intentionally invalidate cached output. This favors
  reproducibility over maximizing reuse.
- Hardware acceleration can be added later by naming the selected encoder in provenance and cache
  identity; the CPU/software encoder remains the reference path.
- The database may contain nonterminal or failed derivative records without finalized files. This
  is explicit recoverable state, not evidence of usable media.
