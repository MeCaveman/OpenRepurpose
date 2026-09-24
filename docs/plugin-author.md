# Plugin author guide

OpenRepurpose plugin API v1 is exported by `@openrepurpose/platform-sdk`. Start with one focused
source or destination adapter and a manifest; do not control workflows or access repositories directly.

## Manifest checklist

- stable lowercase plugin ID, display name, and semantic version;
- compatible `requiredApiVersion` range;
- declared source/destination/provider capabilities and persistent destination job types;
- JSON Schema for non-secret configuration;
- explicit network hosts, host-owned filesystem roots, secret scopes/operations, and child-process
  executable names—even when each list is empty.

Permissions are review metadata, not a sandbox. Third-party JavaScript runs in-process with the same
OS privileges as OpenRepurpose. Third-party discovery/loading is disabled by default in v1; there is
no marketplace, silent installation, or automatic plugin update path.

## Adapter rules

- Return typed platform errors with safe public messages, retryability, and retry delays where available.
- Stream large media and accept host-managed paths; never read entire videos into memory.
- Keep OAuth tokens and app secrets behind `SecretStore`; never return them to UI models or logs.
- Treat upload completion and remote processing completion as different states.
- Let the host own persistence, retries, cancellation, idempotency, and recovery.
- Use official APIs and respect scopes, reviews, quotas, rate-limit headers, and rights restrictions.

Use `@openrepurpose/testkit` contract suites for the manifest and every adapter contribution. Mock
HTTP by default; live tests must be opt-in and credential-gated. See [Plugin SDK v1](PLUGIN_SDK.md)
for exact compatibility, load policy, and first-party examples.
