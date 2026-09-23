# ADR 0011: Kick source discovery and media boundary

## Status

Accepted — v0.8 Packet 4, 2026-09-23.

## Context

OpenRepurpose v0.8 adds only the Kick capabilities exposed by Kick's current official developer
surface. A channel page, livestream thumbnail, or undocumented website endpoint does not establish
an authorized media source. The integration must also remain useful on localhost without requiring
a hosted relay, while still allowing an explicitly configured public webhook on a headless host.

This decision records the official Kick OAuth, Public API, and Events contracts checked on
2026-09-23. It extends ADR 0006's remote-source identity and recovery rules and ADR 0009's separate,
opt-in external-downloader boundary. It adds no adapter or runtime behavior in this packet.

## Decision

### OAuth 2.1 and least-privilege credentials

Each installation uses a user-supplied Kick developer application created from the account's
Developer settings. Kick requires 2FA before those developer tools are available and issues a
client ID, client secret, and registered redirect URL.

Kick documents two token types on `https://id.kick.com`:

- an app access token from the client-credentials grant for public data and app-owned event
  subscriptions; and
- a user access token from the authorization-code grant for connected-user identity and scoped
  actions.

The user flow requires `state`, a PKCE `code_challenge`, and `code_challenge_method=S256`; the code
exchange requires the matching `code_verifier`, client ID, client secret, and exact redirect URI.
Packet 5 must reuse OpenRepurpose's persistent, browser-bound, single-use OAuth state and
`SecretStore` boundaries. Client secrets, authorization codes, PKCE verifiers, access tokens, and
refresh tokens must never enter source configuration, browser-safe account data, ordinary logs, or
job metadata.

Kick's token endpoint also supports refresh-token and client-credentials grants. A refresh response
contains both access and refresh tokens, so replacements must be written atomically. Kick exposes
token revocation and the current `POST /oauth/token/introspect` endpoint, whose response reports
active state, client ID, token type, scopes, and expiry. The older
`POST /public/v1/token/introspect` endpoint is deprecated and must not be used for new code.

Kick currently documents a `localhost` loopback redirect. It also documents a frontend bug that
rewrites the first `127.0.0.1` occurrence to `localhost`, with a sacrificial query-parameter
workaround when `127.0.0.1` cannot be changed. Packet 5 must make the registered callback and the
authorization/code-exchange redirect URI identical; it may use the documented workaround but must
not relax OpenRepurpose's loopback host, Origin, state, or CSRF protections.

The current user scopes are:

| Scope                            | Official capability                         | v0.8 source use                          |
| -------------------------------- | ------------------------------------------- | ---------------------------------------- |
| `user:read`                      | Read user identity                          | Connect the user's identity              |
| `channel:read`                   | Read channel information                    | Discover the connected user's channel    |
| `events:subscribe`               | Manage channel event subscriptions          | Optional user-token webhook subscription |
| `channel:write`                  | Update livestream metadata                  | Unsupported by the v0.8 source           |
| `streamkey:read`                 | Read stream URL and stream key              | Must not be requested                    |
| `chat:write`                     | Send chat messages                          | Unsupported by the v0.8 source           |
| `moderation:ban`                 | Ban, time out, or unban users               | Unsupported by the v0.8 source           |
| `moderation:chat_message:manage` | Manage chat messages                        | Unsupported by the v0.8 source           |
| `channel:rewards:read`           | Read channel reward data                    | Unsupported by the v0.8 source           |
| `channel:rewards:write`          | Manage rewards and redemptions              | Unsupported by the v0.8 source           |
| `kicks:read`                     | Read KICKs information such as leaderboards | Unsupported by the v0.8 source           |
| `ads:read`                       | Read ad settings and breaks                 | Unsupported by the v0.8 source           |
| `ads:write`                      | Manage ad settings and breaks               | Unsupported by the v0.8 source           |

The authenticated source baseline therefore requests only `user:read channel:read`. Add
`events:subscribe` only when the user explicitly enables the user-token webhook path. Public
channel and livestream reads can instead use an app access token with no user scopes. App-token
subscriptions can target a supplied broadcaster user ID and do not justify broader user scopes.

### Official channel and active-livestream discovery

The Public API is hosted at `https://api.kick.com`. The verified source-relevant reads are:

- `GET /public/v1/users` returns users by ID. With a user token and no IDs it returns the currently
  authorized user. The OpenAPI contract permits an app token or a user token with `user:read`.
- `GET /public/v1/channels` returns channels by up to 50 broadcaster IDs or up to 50 slugs, but the
  two filters cannot be mixed. The result includes broadcaster ID, slug, channel description,
  category, title, banner, subscriber counts, and current stream metadata when available. It
  accepts an app token or a user token with `channel:read`.
- `GET /public/v1/users/livestreams` returns active livestreams for up to 100 supplied user IDs.
  Results include a livestream UUID, broadcaster, channel slug, category, title, language, tags,
  mature-content flag, start time, thumbnail, and viewer count. It accepts app or user tokens with
  no additional scope.
- `GET /public/v2/livestreams` lists active livestreams with cursor pagination, up to 1,000 results
  per page, optional category/language filters, and oldest-to-newest ordering. It accepts app or
  user tokens with no additional scope. It is useful for browsing, not targeted channel polling.

The older `GET /public/v1/livestreams` endpoint is deprecated. Packet 5 must use the per-user active
endpoint for configured broadcasters and v2 only if an explicit browse capability is needed. It
must not build new behavior on the deprecated endpoint.

Kick does not expose a historical-livestream listing in this official surface. Active polling can
observe that a stable livestream UUID is live and later absent, but absence is only an observation;
it does not create a VOD or prove that a replay was published. Store Kick's livestream UUID as the
stable external ID, with `started_at` as published time and OpenRepurpose's own `observed_at` for
dedupe and ordering. Channel slug, list position, thumbnail URL, and viewer count are mutable
metadata, not identity.

Although the channel schema can contain stream URL/key fields when authorized, those are broadcaster
ingestion credentials associated with `streamkey:read`, not playback media. OpenRepurpose must not
request that scope, persist those values, expose them to the browser, or treat them as source media.

### Webhooks are optional wake-up hints, not the local correctness path

Kick's Events API currently supports only webhook delivery. There is no official Events WebSocket
transport. The app's webhook URL must be publicly reachable; localhost does not work unless the user
deliberately supplies a tunnel or comparable public route. OpenRepurpose will not require a tunnel,
relay, or hosted service for normal local use. Conservative polling of configured broadcaster IDs
therefore remains authoritative.

`GET`, `POST`, and `DELETE /public/v1/events/subscriptions` manage subscriptions. A user token uses
the connected broadcaster inferred from the token; on subscription creation a supplied
`broadcaster_user_id` is ignored. An app token can subscribe for a supplied broadcaster ID. User
token writes require `events:subscribe`; the OpenAPI contract permits app-token subscription
management without a user scope. The only documented delivery method is `webhook`.

The current event catalog contains:

- `livestream.status.updated` version 1, with broadcaster identity, `is_live`, title, `started_at`,
  and nullable `ended_at`;
- `livestream.metadata.updated` version 1, with title, language, mature-content flag, and category;
- chat, follow, subscription, reward-redemption, moderation-ban, and KICKs-gift events that are not
  media-source events for v0.8.

There is no clip-created, VOD-created/published, replay-ready, or downloadable-media event. A stream
ended event may wake an overlapping active-stream poll, but it must not synthesize a VOD item.

Kick documents 10,000 subscriptions per event type for one app. Unverified apps are limited to
1,000 `chat.message.sent` subscriptions; verified apps can receive 10,000. OpenRepurpose does not
need chat subscriptions for this source. If an app continually fails to process an event for more
than a day, Kick automatically unsubscribes that app from the event, so Packet 5 must reconcile
desired subscriptions and retain polling across delivery gaps.

Every webhook includes a unique `Kick-Event-Message-Id` documented as an idempotency key, a
subscription ID, RFC 3339 message timestamp, event type/version, and Base64 signature. Verify the
RSA PKCS#1 v1.5 SHA-256 signature over
`message-id + "." + timestamp + "." + raw-request-body` using Kick's published public key (available
from `GET /public/v1/public-key`) before parsing or persisting the event. Preserve the raw request
bytes for verification and durably deduplicate by message ID. Kick does not document delivery
ordering, replay, retry timing, or an exactly-once guarantee, so event arrival must never advance a
source cursor past an overlapping poll or become the sole record of a livestream session.

### No official clip, VOD, playback, upload, or media-download surface

The official documentation index and current OpenAPI schema contain no endpoint for:

- listing, creating, or reading clips;
- listing historical streams, VODs, replays, or recordings;
- returning a playback manifest or downloadable media URL;
- downloading livestream, clip, or VOD bytes; or
- uploading/publishing video media.

The active-livestream `thumbnail` and channel/banner/category image fields are presentation metadata,
not video locators. A Kick website URL, undocumented site/mobile endpoint, browser cookie, inferred
HLS/CDN URL, or broadcaster RTMPS ingest URL is not an official media resolver.

Consequently, Packet 5 may expose channel and active-livestream metadata and lifecycle observations,
but the official Kick resolver must report binary media as unavailable. A workflow requiring media
bytes must remain blocked with an actionable limitation unless the user matches a local original.
An optional external resolver remains a separately enabled ADR 0009 capability with explicit rights
confirmation; it is not part of the Kick adapter and cannot use cookies, defeat authentication, or
be presented as official Kick download support.

### Rate limits and retry behavior

Kick's current official docs do not publish a general numeric REST request limit, a source-polling
quota, or authoritative rate-limit response headers. OpenRepurpose must not invent or hard-code
one. Poll configured broadcasters in batches within the documented 100-ID active-livestream limit,
avoid busy polling, and cache stable channel identity.

The OpenAPI contract documents `429 Too Many Requests` for at least the chat write endpoint but not
a source-specific numeric policy. The shared Kick transport should still classify an encountered
`429` as transient, honor `Retry-After` when supplied, and use bounded exponential backoff with
jitter. `5xx` and network failures may use the same bounded retry policy. `401` requires token
refresh or reauthorization; `403` is an authorization/capability failure and is not retried as a
transient error.

## Consequences

- Packet 5 can reuse the existing account/secret, remote-source, durable polling, event dedupe, and
  local-original matching boundaries without a parallel workflow or downloader system.
- App access tokens are sufficient for public channel/livestream polling and app-owned webhook
  subscriptions; a connected user token adds user identity without implying media access.
- Localhost installations remain fully functional through polling. Webhooks are optional only when
  the user provides a public callback path and never introduce a mandatory hosted dependency.
- Kick source observations are metadata-only. Official media resolution, clips, VODs, replay
  discovery, and media publishing remain explicitly unsupported by the checked API surface.
- Packet 5 must surface the limitation rather than create a placeholder download or scrape an
  undocumented endpoint.

## Official documentation checked

Checked on 2026-09-23:

- [Kick developer documentation index](https://docs.kick.com/llms.txt)
- [Kick developer changelog](https://docs.kick.com/changelog)
- [Kick app setup](https://docs.kick.com/getting-started/kick-apps-setup)
- [Kick OAuth 2.1](https://docs.kick.com/getting-started/generating-tokens-oauth2-flow)
- [Kick Public API OpenAPI schema](https://api.kick.com/swagger/doc.yaml)
- [Channels API](https://docs.kick.com/apis/channels)
- [Users API](https://docs.kick.com/apis/users)
- [Livestreams API](https://docs.kick.com/apis/livestreams)
- [Events introduction](https://docs.kick.com/events/introduction)
- [Event subscriptions](https://docs.kick.com/events/subscribe-to-events)
- [Webhook payloads and event catalog](https://docs.kick.com/events/event-types)
- [Webhook signature verification](https://docs.kick.com/events/webhook-security)
- [Kick Public API FAQ](https://docs.kick.com/apis/faqs)
