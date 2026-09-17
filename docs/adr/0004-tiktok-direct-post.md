# ADR 0004: TikTok Direct Post integration boundary

## Status

Accepted — v0.2 Packet 1, 2026-09-17.

## Context

OpenRepurpose v0.2 adds TikTok as a second destination while remaining a local-first application
that can later run headlessly behind HTTPS on a Linux VPS. TikTok's current Content Posting API
has account-specific, audit-dependent publishing rules; treating it as a generic "upload and it is
public" destination would be incorrect. This ADR records the official API contract verified on
2026-09-17 before any TikTok production code is introduced.

## Decision

### Supported scope

v0.2 will implement only **video Direct Post** through the Content Posting API using
`source=FILE_UPLOAD`. It will not implement TikTok as a source, photo posting, inbox/draft upload,
`PULL_FROM_URL`, browser/device automation, scraping, or an audit bypass.

`video.publish` must be approved for the TikTok app and explicitly granted by the creator. The
connection also requests `user.info.basic`, the Login Kit baseline scope, solely to identify the
connected creator. TikTok users can grant a subset of requested scopes, so a connected account is
publish-capable only when the returned grant contains `video.publish`; account identity is
available only when `user.info.basic` is granted. The later account adapter will persist only
browser-safe granted-capability flags and `open_id`/display metadata in SQLite. Client credentials,
access tokens, refresh tokens, authorization codes, PKCE verifiers, and upload URLs remain in the
server-side `SecretStore` and must never enter browser responses, structured logs, or ordinary
destination checkpoint records.

### OAuth and deployment modes

Use TikTok's current authorization-code flow at
`https://www.tiktok.com/v2/auth/authorize/` and exchange/refresh tokens at
`https://open.tiktokapis.com/v2/oauth/token/`. Generate a high-entropy, one-time `state`, bind its
hash to the initiating browser session, validate and consume it exactly once, and keep the
configured redirect URI unchanged through the token exchange. Refresh token rotation is mandatory:
TikTok may return a replacement refresh token that must replace the old value atomically.

TikTok distinguishes two supported clients that matter to OpenRepurpose:

- **Web/VPS mode:** use a registered, absolute, static HTTPS callback URL (no query string or
  fragment). This is the mode for a reverse-proxied Linux VPS and any web integration.
- **Native desktop mode:** use a registered `localhost` or `127.0.0.1` loopback callback with a
  port; HTTP is permitted. Generate a fresh S256 PKCE verifier/challenge per authorization and send
  the verifier in the token exchange. Desktop PKCE is required by TikTok's current documentation.

Packet 2 must choose the flow from typed deployment configuration rather than assuming every
installation is localhost. It must reject an invalid redirect URI before redirecting the browser.
The current local-HTTP server restriction remains unchanged in Packet 1.

### Account-specific capability preflight

Before rendering a TikTok export/publish form and again immediately before initializing a post,
call `POST /v2/post/publish/creator_info/query/` with `video.publish`. Its returned data is the
authoritative, short-lived account preflight, not a static UI default:

- creator identity (username, nickname, and an avatar URL with a two-hour TTL);
- exact `privacy_level_options` available to that creator;
- whether the creator has already disabled comments, Duets, or Stitches;
- that creator's `max_video_post_duration_sec`.

The UI will expose only values returned by this preflight and will visibly explain unavailable
interaction controls. It must not substitute a different privacy value after validation. Generic
`DestinationCapabilities` already models static media and metadata limits; it deliberately does
not represent credentials or mutable per-account state. Consequently Packet 1 makes **no
platform-SDK type change**. Packet 2 will introduce a TikTok-specific, browser-safe creator
preflight DTO at the account/integration boundary rather than overloading the static generic
adapter contract. Packet 5 can project that DTO into the UI.

### Audit and other publish availability restrictions

Unaudited API clients are restricted to private viewing. An attempt incompatible with that
restriction can fail with
`unaudited_client_can_only_post_to_private_accounts`; other availability failures include the
per-user daily post cap, a client active-user cap, and a creator ban. The adapter must preserve
these as typed, actionable availability/authorization errors and the UI must show the audit/private
restriction rather than silently changing the requested visibility. Passing an app audit is an
external TikTok process, not something OpenRepurpose may simulate or work around.

### Direct Post and status model

Packet 3 will use this durable sequence:

1. Query creator info and validate the requested privacy, caption, interaction flags, duration,
   MIME type, and local file size.
2. Call `POST /v2/post/publish/video/init/` with `video.publish`, `FILE_UPLOAD`, file size, chunk
   plan, and user-confirmed post metadata. The returned `publish_id` is the durable remote
   operation identifier. The returned `upload_url` expires after one hour and is sensitive because
   it contains authorization material.
3. Stream sequential `PUT` chunks to the returned URL with `Content-Type`, `Content-Length`, and
   `Content-Range`; never buffer a complete video. A `206` acknowledges an intermediate chunk and
   `201` completes transfer. Retry a transient 5xx only at a safely checkpointed chunk boundary.
4. Persist the `publish_id`, transfer progress, and a non-secret remote state. Persist an unexpired
   upload URL only through `SecretStore`; if recovery occurs without it or after expiry, do not
   blindly create a second Direct Post. Packet 3 must first establish whether TikTok provides safe
   resumability/status recovery for the existing `publish_id`; otherwise it must stop with a
   recoverable, user-visible ambiguity rather than duplicate a post.
5. Poll `POST /v2/post/publish/status/fetch/` by `publish_id`. Map `PROCESSING_UPLOAD` to local
   upload/remote-processing-in-progress, `PUBLISH_COMPLETE` to success, and `FAILED` plus its
   `fail_reason` to a terminal typed failure. A `publish_id` does not prove public availability;
   a public `post_id` is returned only after moderation. Webhooks are optional future optimization,
   not a v0.2 dependency.

The existing `RemotePublishState` (`processing`, `published`, `failed`) can express the final
mapping, while destination job checkpoint fields distinguish transfer progress from remote
processing. No job-state or platform-SDK type change is needed in this documentation packet.

### Verified limits and validation rules

- Caption (`post_info.title`) is optional and limited to 2,200 UTF-16 code units.
- The init endpoint permits six requests per access token per minute; creator-info permits 20; the
  status endpoint permits 30. Honor `429` and `Retry-After` when present, use bounded backoff with
  jitter, and do not busy-poll.
- An upload URL is valid for one hour. Chunks upload in order; each normal chunk is 5–64 MB, the
  final chunk can be up to 128 MB, and a transfer has 1–1,000 chunks. A file smaller than 5 MB is a
  single whole-file chunk.
- Video input is limited to MP4, WebM, or MOV; H.264/H.265/VP8/VP9; 23–60 FPS; 360–4096 pixels in
  each dimension; and 4 GB. The static maximum developer-sent duration is 10 minutes, but the
  creator-info duration is the authoritative lower per-account limit.
- `PULL_FROM_URL` is intentionally excluded: it requires a public HTTPS URL under a verified domain
  or URL prefix, must not redirect, and remains available for TikTok to download for up to an hour.
  A self-hosted local file path cannot satisfy those requirements.

## Consequences

- Packet 2 owns OAuth, token storage/rotation, identity, and creator-capability query; Packet 3
  owns the streaming transport, secure checkpoint treatment, and status polling.
- TikTok's creator-specific privacy and interaction policy is retrieved live; it is not encoded as
  a cross-platform `DestinationPrivacy` enum or hard-coded in the UI.
- A later audit can change availability, so availability must be rechecked rather than inferred from
  a past connection.
- The status endpoint and persisted `publish_id` make asynchronous remote processing observable;
  no successful local transfer is reported as a completed/public TikTok post.

## Official documentation checked

- [Login Kit overview](https://developers.tiktok.com/docs/en/login-kit-overview)
- [Web Login Kit](https://developers.tiktok.com/docs/en/login-kit-web)
- [User Access Token Management](https://developers.tiktok.com/docs/en/oauth-user-access-token-management)
- [Direct Post getting started](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
- [Direct Post reference](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post)
- [Query Creator Info](https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info)
- [Media Transfer Guide](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide)
- [Get Post Status](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status)
