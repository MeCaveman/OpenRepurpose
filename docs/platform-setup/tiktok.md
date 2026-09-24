# TikTok OAuth and Direct Post setup

OpenRepurpose uses your own TikTok developer app. Client credentials and user tokens stay in the
server-side encrypted `SecretStore`; the browser receives only configuration status, connected
identity, granted scopes, and live creator posting capabilities.

## Create and configure the TikTok app

1. Create an app in [TikTok for Developers](https://developers.tiktok.com/).
2. Add **Login Kit** and **Content Posting API** products.
3. Add the `user.info.basic` scope. Request TikTok approval for `video.publish`; adding a scope to
   the app does not grant it for a creator, so each connected creator must also approve it.
4. Register the exact callback shown on OpenRepurpose's **Accounts** page:
   - Local Windows/Linux: use the shown `localhost` or `127.0.0.1` URL with its explicit port.
     TikTok treats this as a desktop flow, and OpenRepurpose uses required S256 PKCE.
   - Reverse-proxied/VPS deployment: `APP_URL` must produce an absolute, static HTTPS
     callback. TikTok treats this as a web confidential-client flow.
5. Copy the app's **Client key** and **Client secret** into the TikTok card on **Accounts**, save,
   then select **Connect TikTok**.

Do not put the client secret or tokens in `.env`, a browser bundle, logs, or SQLite. Replacing the
client key marks existing TikTok connections as requiring authorization again.

## What the connection verifies

OpenRepurpose validates one-time `state` against the initiating secure browser session. Desktop
flows additionally store the temporary PKCE verifier only in `SecretStore`. After exchanging the
code server-side it queries `/v2/user/info/` for `open_id` and display name, persists only that
browser-safe identity in SQLite, and keeps the access/refresh token bundle in `SecretStore`.

TikTok access tokens are short-lived. OpenRepurpose refreshes them before use and atomically
replaces the saved token bundle because TikTok may rotate the refresh token. An invalid refresh
marks the account **Reconnect required**.

For accounts that grant `video.publish`, the Accounts page queries the official
`/v2/post/publish/creator_info/query/` endpoint. The displayed nickname, privacy options,
interaction restrictions, and maximum duration are live account-specific values. If Direct Post
is not currently available, OpenRepurpose reports the TikTok error rather than enabling controls
with guessed defaults.

## Audit and posting restrictions

TikTok restricts every Direct Post made by an **unaudited** API client to private viewing. The
creator-info endpoint does not reveal the developer app's audit status. Therefore OpenRepurpose:

- always shows the private-only unaudited restriction;
- distinguishes creator support for public visibility from proof that the app passed audit;
- never labels public posting as confirmed merely because `PUBLIC_TO_EVERYONE` appears in the
  creator's privacy options;
- does not silently change a requested privacy value or work around TikTok review, rate limits,
  creator bans, or posting caps.

OpenRepurpose queries creator information before a publish, streams the selected local file to the
official upload URL, and polls publish status through the persistent job runner. Upload completion
does not imply that TikTok finished processing or made the post visible.

## Official references

- [Login Kit overview](https://developers.tiktok.com/docs/en/login-kit-overview)
- [Desktop Login Kit](https://developers.tiktok.com/docs/en/login-kit-desktop)
- [Web Login Kit](https://developers.tiktok.com/docs/en/login-kit-web)
- [User Access Token Management](https://developers.tiktok.com/docs/en/oauth-user-access-token-management)
- [Scopes reference](https://developers.tiktok.com/docs/en/tiktok-api-scopes)
- [Direct Post getting started](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
- [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
