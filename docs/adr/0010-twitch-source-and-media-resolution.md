# ADR 0010: Twitch source discovery and authorized media resolution

## Status

Accepted — v0.8 Packet 2, 2026-09-21.

## Context

OpenRepurpose v0.8 adds Twitch as a remote source while remaining local-first and usable on a
localhost desktop or a headless Linux host. Twitch exposes public clip and video metadata, but the
ability to see a Twitch page is not the same as authorization to obtain its media bytes. Detection
also has to tolerate duplicate observations, changing result order, WebSocket gaps, process
restarts, and expiring download URLs.

This decision records the official Twitch API contract checked on 2026-09-21. It extends the
remote-source identity and recovery rules in ADR 0006 and uses the existing official-API
`MediaResolver` boundary. It does not add an adapter or change runtime behavior in this packet.

## Decision

### Account connection and least-privilege scopes

Each installation uses a user-supplied Twitch developer application. OpenRepurpose will use a
Twitch user access token for a connected broadcaster or editor and keep the client secret, access
token, refresh token, authorization code, and OAuth transaction data in `SecretStore`. None of
that material may enter source configuration, browser responses, source-item metadata, ordinary
logs, or download checkpoints.

Metadata discovery through `Get Users`, `Get Clips`, and `Get Videos` accepts an app or user access
token and requires no OAuth scope. A user connection may therefore begin without a content-management
scope. Additional capabilities are granted independently:

| Capability                                   | Scope and identity rule                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Download clips for the connected broadcaster | `channel:manage:clips`; `editor_id` is the connected broadcaster ID and equals `broadcaster_id`                  |
| Download clips as a channel editor           | `editor:manage:clips`; the connected user is the `editor_id` and must actually be an editor for `broadcaster_id` |
| Create a clip from a live stream             | `clips:edit` on a user token                                                                                     |
| Create a clip from a VOD                     | `channel:manage:clips` for the broadcaster or `editor:manage:clips` for an editor                                |

Packet 3 must request only the scopes for capabilities the user enables and persist browser-safe
granted-scope/capability flags separately from the token. A successful metadata connection must
not be shown as download-capable. A `403` from the clip-download endpoint means the connected user
is not an editor for that broadcaster and is an authorization/capability failure, not a missing
clip.

For the normal server-backed installation, use Twitch's authorization-code grant with a registered
redirect URI and a high-entropy, browser-bound, single-use `state`; the code exchange requires the
same redirect URI and the developer-app secret. Twitch's current authorization-code documentation
does not specify PKCE, so OpenRepurpose must not invent unsupported PKCE parameters. The documented
device-code grant is an acceptable headless alternative when Packet 3 can fit it into the existing
account boundary without creating a second credential model. It is not required by this packet.

Third-party applications that maintain a Twitch OAuth session must call `/oauth2/validate` at
startup and hourly thereafter. Packet 3 must refresh expiring tokens, atomically replace a rotated
refresh token, disable the affected capability on revocation or terminal refresh failure, and map
API `401` responses to an actionable reauthorization state.

### Metadata discovery is polling-authoritative

The current EventSub subscription catalog contains stream online/offline events but no clip-created
or VOD-published event. Twitch metadata discovery will therefore use Helix polling as the
authoritative path:

- `GET /helix/clips?broadcaster_id=...` discovers clip metadata. It accepts RFC 3339 `started_at`
  and `ended_at` windows, returns at most 100 items per page, and caps multi-page results at
  approximately 1,000. Results for a broadcaster are ordered by view count, not creation time.
- `GET /helix/videos?user_id=...&type=archive&sort=time` discovers published VOD metadata. It
  returns at most 100 items per page and provides a pagination cursor.

Clip polling must use bounded, overlapping time windows and persist Twitch clip ID as the stable
external ID. It must not treat page position, view-count order, or a pagination cursor from an old
query window as a durable watermark. VOD polling uses video ID as the stable external ID and may
use `published_at` plus ID as a watermark while still overlapping polls. Both sources follow ADR
0006: persist observations before advancing any cursor/watermark, tolerate repeated and reordered
items, and distinguish `observed_at` from Twitch's `created_at` or `published_at`.

EventSub WebSocket may be added as a latency optimization. `stream.offline` can wake VOD polling,
but it is not proof that a VOD has been published and is not a substitute for polling. WebSocket is
the preferred event transport for local-first installations because it needs no public inbound
HTTPS callback. It uses a user access token, requires subscriptions to be created against the
received session ID, and requires recreation after an ungraceful disconnect. Twitch provides no
replay for the disconnected interval, so every reconnect must schedule a catch-up poll. Graceful
server-directed reconnect uses the supplied URL so existing subscriptions continue without a gap.

EventSub delivery is at least once. The EventSub message ID may deduplicate repeated delivery of an
event, but never replaces the Twitch clip/video ID as source identity. Webhook transport requires a
public HTTPS callback and an app access token; it is not the default localhost path. Conduits are
unnecessary for the single-user v0.8 implementation.

### Clip metadata and clip bytes are separate capabilities

`GET /helix/clips` returns metadata including clip ID, browser/embed URLs, broadcaster and creator,
source video ID when available, title, creation time, thumbnail URL, duration, VOD offset, and
featured state. Its `url`, `embed_url`, and `thumbnail_url` fields are not binary media locators.

Authorized clip bytes are resolved only through
`GET /helix/clips/downloads?broadcaster_id=...&editor_id=...&clip_id=...`:

- the request accepts at most 10 clip IDs;
- the connected broadcaster/editor must have `channel:manage:clips` or `editor:manage:clips` as
  described above;
- each result may contain a landscape URL, a portrait URL, or `null` for either unavailable
  rendition; and
- Twitch explicitly describes the returned URLs as temporary and expected to expire.

Packet 3 must represent metadata availability and download availability separately. A discovered
clip remains a valid observed source item when authorization is missing or both rendition URLs are
`null`; its media-resolution state becomes unavailable with an actionable reason. A temporary URL
is short-lived resolver input, not durable source metadata. The official resolver should fetch a
fresh URL by stable clip ID when starting or retrying, stream the selected rendition into the
existing managed staging area, and persist only the normal resolution checkpoint/artifact data.
An expired URL may be retried by resolving a fresh URL while the token and editor relationship
remain valid. It must not derive media URLs from thumbnail/browser URLs or scrape a Twitch page.

The existing explicit rights rule still applies even though Twitch enforces a broadcaster/editor
relationship: OpenRepurpose only resolves media the user owns or is authorized to reuse.

### VOD metadata does not imply downloadable VOD media

`GET /helix/videos` returns published-video metadata: video and stream IDs, owner, title,
description, creation/publication timestamps, a Twitch viewing-page URL, thumbnail, visibility,
views, language, type, duration, and muted segments. The official Twitch API reference exposes no
endpoint that returns the VOD's binary media or an authorized VOD download URL. The viewing-page
URL and thumbnail URL are metadata, not media locators.

Consequently, v0.8 treats VOD discovery as metadata-only. Packet 3 must not infer an HLS playlist,
extract CDN URLs, scrape authenticated pages, use browser cookies, or label a VOD as downloadable.
A user-provided local original may still resolve through the existing local-original path.

Twitch separately exposes `POST /helix/videos/clips`, which lets an authorized broadcaster/editor
create a 5–60 second clip from a VOD using `vod_id`, end offset, duration, and title. The resulting
clip can later use the official clip-download endpoint. That is a bounded clip-creation capability,
not VOD download. It is outside Packet 3's automatic source polling/resolution baseline and must
not be used automatically for every observed VOD. A later explicit workflow or user action may add
it behind the applicable scope, validation, and durable asynchronous-operation handling.

`POST /helix/clips` likewise creates a clip from a live stream using `clips:edit`. It returns `202`,
and Twitch directs clients to poll `Get Clips` for up to 60 seconds to establish whether creation
succeeded. This is an explicit action rather than a discovery event and is not required for the
v0.8 source adapter.

### Rate limits and retry behavior

Helix uses one-minute token buckets. The default endpoint cost is one point; app-access requests
and user-access requests have separate buckets, with the latter limited per client ID and user.
Twitch communicates the actual bucket limit, remaining points, and Unix reset instant in
`Ratelimit-Limit`, `Ratelimit-Remaining`, and `Ratelimit-Reset`. The documentation's `800` value is
an example header value, not a constant OpenRepurpose will hard-code.

`Get Clips Download` additionally has a documented limit of 100 requests per minute. Packet 3 will
batch up to 10 clip IDs where practical, account for both the endpoint-specific limit and the
general bucket, and honor `429` using the reset header with bounded backoff and jitter. Poll cadence
must be configurable and must not busy-poll. A `401` or `403` is not retried as transient; a `5xx`
or network failure may use the existing bounded retry policy.

EventSub WebSocket currently permits at most three enabled connections per client-ID/user tuple,
300 enabled subscriptions per connection, and aggregate `max_total_cost` 10. OpenRepurpose needs
one connection for a connected account and should consume the limits reported by the API rather
than assume they will remain fixed.

## Consequences

- Packet 3 can implement Twitch by extending the existing source adapter, account/secret,
  source-polling, media-resolution, managed-storage, and retry boundaries; no parallel workflow or
  downloader subsystem is needed.
- Clip and VOD observations share durable dedupe semantics, but only an authorized clip can expose
  the official binary resolution strategy.
- WebSocket events improve latency without making localhost publicly reachable, while overlapping
  polls close reconnect gaps and remain authoritative.
- Temporary Twitch download URLs are never treated as permanent source metadata or a completed
  media artifact.
- Full VOD download remains explicitly unsupported by the official API surface checked for this
  decision.

## Official documentation checked

Checked on 2026-09-21:

- [Twitch API reference — Clips and Videos](https://dev.twitch.tv/docs/api/reference/)
- [Twitch API concepts and rate limits](https://dev.twitch.tv/docs/api/guide/)
- [Twitch access-token scopes](https://dev.twitch.tv/docs/authentication/scopes/)
- [Getting OAuth access tokens](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Validating tokens](https://dev.twitch.tv/docs/authentication/validate-tokens/)
- [EventSub overview](https://dev.twitch.tv/docs/eventsub/)
- [EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
- [Managing EventSub subscriptions and limits](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/)
- [Handling EventSub WebSocket events](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)
- [EventSub WebSocket message reference](https://dev.twitch.tv/docs/eventsub/websocket-reference/)
