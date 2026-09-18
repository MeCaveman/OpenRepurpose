# Meta Reels setup

OpenRepurpose uses your own Meta app and sends Reel bytes directly from the local machine to Meta.
It does not start a tunnel, upload media to an OpenRepurpose service, or use browser automation to
sign in to Meta.

## Eligibility and access

Use **Facebook Login for Business** for this release. One connected Meta identity can expose both
Facebook Pages and linked Instagram professional targets. Business Login for Instagram alone does
not provide the Page relationship required here.

Supported targets are:

- Facebook Pages where the connecting user can perform the `CREATE_CONTENT` task;
- linked Instagram Business or Creator accounts with the required Page relationship and publishing
  permissions.

Personal Facebook profiles, groups, and consumer Instagram accounts are not supported. Meta may
also require Page Publishing Authorization or Page two-factor authentication.

## Create the Meta app

1. Create a Meta app in the [Meta for Developers](https://developers.facebook.com/) dashboard.
2. Add and configure Facebook Login for Business.
3. Add the permissions needed for the targets you manage:
   - `pages_show_list` to discover Pages;
   - `pages_read_engagement` and `pages_manage_posts` for Facebook Page Reels;
   - `instagram_basic` and `instagram_content_publish` for linked Instagram Reels.
4. On OpenRepurpose's **Accounts** page, copy the exact callback URI shown in the Meta card into
   the app's Valid OAuth Redirect URIs.
5. Save the Meta app ID and app secret in the local Meta card, then choose **Connect Meta**.

The callback is derived from `APP_URL`. Local development should use the configured loopback URL.
An HTTPS, reviewer-accessible deployment is required if Meta App Review or Advanced Access is
needed; OpenRepurpose will not create a public tunnel.

## Development and review

In development mode, Meta limits unapproved permissions to people with an appropriate app or
business role. Serving other users or businesses requires the current Meta App Review and Business
Verification process, including reviewer access to the configured HTTPS callback and publishing
flow. Standard Access is sufficient for owned or managed targets when the user has the required
role.

After OAuth, OpenRepurpose discovers Page and linked Instagram targets separately. Enable only the
targets you want to use. A successful OAuth callback does not guarantee publishing access; missing
permissions, Page tasks, review requirements, or an ineligible account are shown as an actionable
target blocker.

## Local-first media behavior

Instagram Reels use Meta's resumable upload container and Facebook Page Reels use Meta's Page upload
session. Local files are streamed directly to Meta and are not fully loaded into memory. The UI and
job history retain the remote processing state and any safe recovery information.

## Security notes

The app secret, OAuth code, user/Page tokens, upload URLs, and session material stay in the local
server-side secret store. They are not returned to the browser, persisted in ordinary SQLite job
checkpoints, or written to logs. Never commit them or place them in `.env` files.

See [ADR 0005](../adr/0005-meta-reels-publishing.md) for the API boundary, permissions, limits,
async lifecycle, and current limitations.
