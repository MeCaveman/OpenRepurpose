# Plugin SDK v1

`@openrepurpose/platform-sdk` version `1.0.0` is the compatibility boundary for platform
integrations. Its API version is exported as `OPENREPURPOSE_PLUGIN_API_VERSION` and follows semantic
versioning: a major change may require a plugin migration, while compatible additions stay within
the current major version.

The SDK currently supports these contribution kinds:

- `source` through `SourceAdapter`;
- direct destinations through `DestinationAdapter`;
- persistent, restart-safe destinations through `DestinationJobAdapter`;
- manifest declarations for transcription providers and media transforms. Runtime loading for the
  latter two is not part of v1.0 Packet 2.

First-party publishing uses `DestinationJobAdapter`. The host owns persistence, retries,
cancellation, recovery, and idempotency; the adapter owns platform validation, upload, status, and
remote error handling. Its `type` is stored in SQLite and must not change without a compatible data
migration.

## Manifest

Every plugin exports a manifest validated by `parsePluginManifest`. It includes:

- a stable lowercase plugin ID, display name, and semantic version;
- `requiredApiVersion`, using an exact version, caret range, tilde range, or bounded comparator range;
- source/destination/provider capabilities and destination job types;
- a JSON Schema object for non-secret configuration;
- explicit network, filesystem, secret, and child-process permission declarations.

Permission arrays are mandatory even when empty. Network entries are exact lowercase hosts or
`*.example.com` patterns. Filesystem permissions use host-owned roots (`app_data`, `media`,
`plugin_data`, or `temp`) rather than arbitrary absolute paths. Child-process entries are executable
names, never shell command strings. Secret declarations name a scope and allowed operations; secret
values continue to flow only through `SecretStore`.

These declarations are auditable metadata, not a security sandbox. A future loader must enforce
them at each host boundary. A plugin must not assume that declaring a permission grants access.

## Discovery and loading policy

OpenRepurpose v1.0 discovers bundled first-party integrations through static application
composition. It does not recursively scan the filesystem, import packages named by a manifest, or
install code from a registry.

Third-party installation and loading are disabled by `DEFAULT_PLUGIN_LOAD_POLICY`. Any future
advanced loading path must follow this order:

1. read and parse inert manifest data without importing plugin code;
2. reject an incompatible `requiredApiVersion`;
3. show the requested permissions and the in-process trust warning;
4. require an explicit acknowledgement for that load;
5. only then import the selected module and register its contributions.

`evaluatePluginLoad` implements the compatibility and acknowledgement gate. Setting its policy to
`advanced` does not create isolation. Third-party JavaScript runs in the OpenRepurpose process with
the same operating-system privileges as OpenRepurpose and can bypass SDK permission declarations.
Only code the operator fully trusts should ever be enabled. There is no marketplace, silent install,
or automatic update path in v1.0.

## Contract tests

`@openrepurpose/testkit` exports:

- `runPluginContract` to validate a manifest and match declared contributions to runtime adapters;
- `runSourceAdapterContract`;
- `runDestinationAdapterContract`;
- `runDestinationJobAdapterContract`.

The repository runs `runPluginContract` for YouTube, TikTok, Meta, Twitch, and Kick. Adapter-specific
tests still own HTTP behavior, recovery, credential, validation, and rate-limit scenarios; the
contract kit is the shared compatibility floor rather than a substitute for those tests.

## First-party permission summary

| Plugin  | Contributions                       | Filesystem                                      | Network                                      | Child process |
| ------- | ----------------------------------- | ----------------------------------------------- | -------------------------------------------- | ------------- |
| YouTube | source, destination                 | media read                                      | Google OAuth and YouTube Data API hosts      | none          |
| TikTok  | destination                         | media read                                      | TikTok OAuth/API and signed upload hosts     | none          |
| Meta    | Instagram and Facebook destinations | media read                                      | Facebook Graph and resumable-upload hosts    | none          |
| Twitch  | source                              | managed temp write for official clip resolution | Twitch identity and Helix hosts              | none          |
| Kick    | source                              | none                                            | Kick identity, API, and public locator hosts | none          |

The exported manifests are the authoritative detailed declarations, including secret names and
access modes.
