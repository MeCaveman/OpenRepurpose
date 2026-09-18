# ADR 0005: Meta Reels publishing boundary

## Status

Accepted — v0.3 Packet 1, 2026-09-18.

## Context

OpenRepurpose v0.3 adds Instagram Reels and Facebook Page Reels while remaining a local-first,
self-hosted application. Meta changes its API versions, permissions, publishing limits, and media
requirements frequently. This decision records the official contract checked on 2026-09-18,
before any Meta transport code is introduced.

The current Meta developer documentation identifies Graph API `v26.0` as the latest version. Later
packets must pin a supported version in one integration boundary and recheck the official changelog
before changing it; they must not scatter version strings through application services.

## Decision

### Use Facebook Login for Business for v0.3

v0.3 will use **Facebook Login for Business**, not Business Login for Instagram. This is the only
current Meta login configuration that satisfies both requirements of this release:

- one Facebook OAuth identity can discover multiple Facebook Pages and their linked Instagram
  professional accounts; and
- Instagram's current `upload_type=resumable` flow for pushing local video bytes is documented as
  available only to apps that implement Facebook Login for Business.

Business Login for Instagram remains a valid Meta API configuration, but it does not expose the
Facebook Page targets required by this release. It is not a v0.3 fallback and will not be
implemented speculatively.

Use Meta's server-side OAuth authorization-code flow. The app redirects to the versioned Facebook
OAuth dialog with a configured app ID, registered `redirect_uri`, requested scopes, and a
high-entropy `state`. The callback must validate and consume browser-bound `state` exactly once.
The authorization code is exchanged server-to-server using the app secret; the `redirect_uri` in
the exchange must be the same one used to start authorization. The app secret, authorization code,
user token, Page tokens, and upload URLs remain in `SecretStore` and never enter browser responses,
ordinary logs, or non-secret job checkpoints.

Meta's current Instagram overview describes the authorization code and short-lived access token as
valid for one hour, and the exchanged long-lived token as valid for 60 days and refreshable before
expiry. Packet 2 must persist explicit expiry and reauthorization state instead of assuming a token
is permanent. The current Facebook manual-flow documentation does not specify PKCE for this
server-side flow; Packet 2 must not invent unsupported parameters, but must recheck the selected
Facebook Login for Business configuration and use PKCE if Meta then documents it as supported or
required.

After user-token exchange, discover Pages with `/me/accounts` and obtain a Page access token for
each Page. Treat the credential identity separately from every discovered target:

```text
MetaCredential (Facebook identity and secret token material)
  |
  +-- FacebookPageTarget (Page ID + browser-safe capability metadata)
  +-- InstagramTarget (linked Instagram professional account ID + Page relation)
```

The Page access token acts on behalf of the Page and is also the documented token for the
Page-linked Instagram publishing flow. Enabling or disabling one target must not mutate the shared
credential or another target.

### Required permissions and Page tasks

Request the least-privilege union needed for target discovery and publishing:

| Purpose                                        | Permissions                                                                                           | Target task/role                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Discover Pages                                 | `pages_show_list`                                                                                     | User can manage the Page                                                                             |
| Publish Facebook Page Reels                    | `pages_read_engagement`, `pages_manage_posts` (with `pages_show_list` as their documented dependency) | `CREATE_CONTENT`                                                                                     |
| Discover and publish a linked Instagram target | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`, `pages_show_list`            | `PROFILE_PLUS_CREATE_CONTENT`/Content or `PROFILE_PLUS_FULL_CONTROL`/Full control on the linked Page |

Do not request `instagram_manage_comments`, insights, messaging, ads, product tagging, location
search, or other permissions for this release.

Meta's current surfaces are not perfectly consistent. The September 2026 Permissions Reference
lists `pages_read_user_content` as a dependency of `instagram_basic`, while the current Instagram
publishing guide and official Meta Postman collection do not list it for publishing. The publishing
guide also lists `ads_management` and `ads_read` for some Page roles granted through Business
Manager, while the endpoint reference says one of those permissions can be needed. Packet 2 must
verify the exact grant returned by the configured app/API version and expose a capability blocker.
It must not silently add either ads permission or `pages_read_user_content` to every request. A
direct content-capable Page task with the four Instagram scopes above is the normal supported path.

Users can decline individual permissions. A completed OAuth callback therefore creates only the
targets supported by the actual granted scopes and current Page tasks; connection success alone is
not proof of publish capability.

### Eligible targets

Instagram publishing supports **professional accounts** (business or creator), not consumer
accounts. With Facebook Login for Business, the professional account must be linked to a Facebook
Page, and the connecting user must have an admin-equivalent content task on that Page. Page
Publishing Authorization and Page-required two-factor authentication must be completed when Meta
requires them. Meta provides no preflight that tells an app whether PPA will later be required, so
permission/PPA failures must be actionable and rechecked rather than cached as permanent facts.

Facebook Reels publishing supports **Facebook Pages only**. Personal profiles and groups are not
eligible. The Page token must come from a user who can perform the `CREATE_CONTENT` task. Page Reel
audience is implicitly public; the UI must disclose that and must not offer unsupported privacy
choices.

### Instagram Reels media transfer and publish sequence

Use Meta's direct resumable-upload path, not a public URL, tunnel, or third-party relay:

1. Create a container with `POST /<IG_ID>/media`, `media_type=REELS`, and
   `upload_type=resumable`. Persist the returned container ID and use the returned upload URI rather
   than constructing one.
2. Stream the local file to the returned `rupload.facebook.com/ig-api-upload/...` URI using
   `Authorization: OAuth <PAGE_ACCESS_TOKEN>`, `offset`, and `file_size`. Never buffer the complete
   video.
3. Poll `GET /<IG_CONTAINER_ID>?fields=status_code` until `FINISHED` before publishing. Model
   `EXPIRED`, `ERROR`, `IN_PROGRESS`, `FINISHED`, and `PUBLISHED` distinctly. Meta recommends
   polling once per minute for no more than five minutes; a local job may wait and reconcile later
   rather than busy-poll.
4. Publish with `POST /<IG_ID>/media_publish` and the container ID. Persist the returned Instagram
   media ID and fetch a permalink only when the API exposes one.

Meta calls this protocol resumable, but the current Instagram guide documents only the starting
`offset` (normally zero) and does not document an offset-query/recovery procedure equivalent to the
Facebook Video endpoint. Packet 3 must not claim restart-safe byte resumption until that behavior is
verified against the then-current official documentation. The persisted container ID is still the
authoritative remote operation ID and prevents blind duplicate publication.

An optional `video_url` flow still exists, but OpenRepurpose will not use it for local files. An
optional `cover_url` also requires a public server; use `thumb_offset` for the local-first path and
do not add a media relay merely to supply a cover.

### Facebook Page Reels media transfer and publish sequence

Use the current Page Reels upload session:

1. Start with `POST /<PAGE_ID>/video_reels` and `upload_phase=start`. Persist the returned
   `video_id` and use the returned `upload_url`.
2. Stream the local file as `application/octet-stream` to the returned
   `rupload.facebook.com/video-upload/...` URL using `Authorization: OAuth <PAGE_ACCESS_TOKEN>`,
   `offset`, and `file_size`.
3. Poll `GET /<VIDEO_ID>?fields=status`. Persist uploading, processing, and publishing phases. If
   upload is interrupted, the current API explicitly returns `bytes_transfered`; resume at that
   value rather than creating a second video.
4. Finish with `POST /<PAGE_ID>/video_reels`, the existing `video_id`,
   `upload_phase=finish`, and `video_state=PUBLISHED`. A successful finish acknowledgement is not
   proof that remote processing and publishing succeeded; continue status reconciliation.

The API can also fetch a hosted `file_url`, but direct local binary upload is the default and
requires no public media host.

### Current Reel constraints

Validate against the stricter current endpoint documentation before transfer. Do not rely on older
Postman examples when they conflict with the current v26 guide.

| Constraint        | Instagram Reels                                                     | Facebook Page Reels                                                                        |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Container         | MOV or MP4; MPEG-4 Part 14; no edit lists; `moov` atom first        | MP4 recommended                                                                            |
| Video codec       | H.264 or HEVC; progressive; closed GOP; 4:2:0                       | H.264/H.265; VP9 and AV1 also documented; progressive, fixed frame rate, closed GOP, 4:2:0 |
| Audio             | AAC; at most 48 kHz; mono or stereo; 128 kbps                       | AAC Low Complexity; 48 kHz; stereo; 128 kbps or higher                                     |
| Frame rate        | 23–60 FPS                                                           | 24–60 FPS                                                                                  |
| Aspect/resolution | Ratio 0.01:1–10:1, 9:16 recommended; maximum 1920 horizontal pixels | 9:16; minimum 540×960, 1080×1920 recommended                                               |
| Duration          | 3 seconds–15 minutes                                                | 3–90 seconds                                                                               |
| File size         | 300 MB maximum                                                      | No maximum stated in the current Reels guide                                               |
| Text              | Caption at most 2,200 characters, 30 hashtags, and 20 mentions      | Optional description/title; no Reel-specific length limit stated in the current guide      |

Instagram containers expire after 24 hours, and an account can create at most 400 containers in a
rolling 24-hour period. Reels cannot be carousel children. These constraints are separate from the
publish quota.

The official Meta Instagram sample README and Postman material still contain older values (1 GB
and, in the sample, a 25-post quota); the current v26 endpoint and publishing guides are the source
of truth for v0.3. Similarly, current Facebook documentation supersedes older Postman values of
4–60 seconds and 23 FPS with 3–90 seconds and 24–60 FPS.

### Publish quotas and API throttling

- Instagram: 100 API-published posts per professional account in a moving 24-hour period, enforced
  at `/<IG_ID>/media_publish`. Query `/<IG_ID>/content_publishing_limit` before scheduled publish
  work and treat its result as authoritative.
- Facebook Page Reels: 30 API-published Reels per Page in a moving 24-hour period, enforced at
  `/<PAGE_ID>/video_reels`.
- Instagram Platform calls use the Business Use Case formula `4800 × impressions` for each app and
  app-user pair over a rolling 24 hours.
- Pages API calls made with a Page token use `4800 × engaged users` over a rolling 24 hours.

Later transports must inspect `X-Business-Use-Case-Usage` (and other returned usage headers), honor
the reported `estimated_time_to_regain_access`, stop on throttling, and apply bounded backoff with
jitter. Relevant documented throttle codes include `80002` for Instagram and `80001` for Page-token
calls. Publish quotas are product limits and must not be confused with Graph call quotas.

### Access levels, App Review, and deployment

Standard Access is sufficient when a BYO Meta app serves only Instagram professional accounts and
Pages that the app owner owns or manages and the user has an app/business role. In development,
unapproved permissions work only for people with the required role on the app or claiming business.

Serving accounts owned or managed by people without those roles requires Advanced Access. Current
Meta rules require App Review and Business Verification for Advanced Access. Reviewers must be able
to complete the login and exercise each requested permission; the permission reference asks for a
use-case explanation and screencast of the login and publishing flow. A private localhost-only
instance that reviewers cannot reach cannot obtain content-publishing approval. OpenRepurpose will
not solve that by starting a tunnel. A user who needs Advanced Access must provide an explicitly
configured, reviewer-accessible HTTPS deployment, such as the supported future VPS mode, and must
follow the current App Dashboard submission instructions.

### OAuth and lifecycle callback rules

- Build the OAuth redirect URI from typed `APP_URL` configuration. Register that exact callback in
  the app's Valid OAuth Redirect URIs and send the identical value during code exchange. Do not
  hard-code localhost.
- Production/VPS callbacks must use HTTPS. Meta's maintained Reels sample also uses HTTPS with a
  locally trusted certificate for localhost development; do not promise that an arbitrary HTTP
  loopback callback is accepted. Packet 2 must capability-gate connection when the configured URI
  is not accepted by Meta.
- Validate one-time, browser-bound `state` before processing success or denial. Never expose the
  app secret to the browser; token exchange and token inspection are server-side operations.
- Configure and handle Meta's deauthorization callback so uninstall/revocation disables the
  credential and its targets. Provide the required data-deletion callback or instructions URL for
  App Dashboard/review. These callbacks are separate from the OAuth redirect and must come from
  deployment configuration when a public callback is required.

No automatic tunnel, Meta credential proxy, OpenRepurpose-hosted callback, or third-party media
relay is permitted.

## Consequences

- Packet 2 owns the credential/target schema, OAuth lifecycle, target discovery, expiry and
  revocation state, and browser-safe capability blockers.
- Packet 3 owns Instagram validation, direct local transfer, container status, publish, and typed
  failure mapping. It must use the current 300 MB limit unless official documentation changes.
- Packet 4 owns Facebook Page upload-session transport, resumable offset recovery, status phases,
  and publish finalization.
- The current core/platform SDK needs no change in Packet 1. Existing `SecretStore`, account,
  destination job, checkpoint, and typed `PlatformError` boundaries remain the integration points.
- Both transports work from Windows, Linux, and a headless Linux VPS without publicly exposing the
  source media. OAuth callback reachability remains configuration-dependent and is surfaced as an
  account capability/setup issue.

## Official material checked

Checked on 2026-09-18:

- [Instagram Platform overview](https://developers.facebook.com/docs/instagram-platform/overview/)
- [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/)
- [Instagram IG User media endpoint and Reel specifications](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/)
- [Instagram resumable uploads](https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads/)
- [Facebook Reels Publishing API](https://developers.facebook.com/docs/video-api/guides/reels-publishing/)
- [Graph API rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)
- [Meta permissions reference](https://developers.facebook.com/docs/permissions/reference/)
- [Facebook Login manual authorization-code flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/)
- [Meta App Review](https://developers.facebook.com/docs/app-review/)
- [Official Meta Instagram Postman collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Official Meta Facebook Postman collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api)
- [Meta Instagram Reels sample](https://github.com/fbsamples/reels_publishing_apis/tree/main/insta_reels_publishing_api_sample)
- [Meta Facebook Reels sample](https://github.com/fbsamples/reels_publishing_apis/tree/main/fb_reels_publishing_api_sample)
