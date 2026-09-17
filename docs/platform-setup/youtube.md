# YouTube OAuth setup

OpenRepurpose uses your own Google Cloud OAuth credentials. Tokens stay on the machine running
OpenRepurpose; there is no OpenRepurpose-hosted callback or credential service.

## Create the Google project

1. Create or select a project in the [Google Cloud console](https://console.cloud.google.com/).
2. Enable the [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
3. Configure the OAuth consent screen. While the project is in **Testing**, add every Google
   account that should connect as a test user. Google can expire or restrict testing credentials.
4. Create an OAuth client with application type **Desktop app**. Google's current installed-app
   guidance supports loopback redirects for Windows, Linux, and macOS desktop applications.
5. Download the client JSON. Keep it private; do not commit it or copy it into the repository.

The callback shown on the Accounts and Setup pages is derived from `APP_URL`. With the defaults it
is:

```text
http://127.0.0.1:3000/api/accounts/youtube/oauth/callback
```

Keep the host and port in `APP_URL` aligned with the address used in the browser. v0.1 accepts only
loopback deployment; a future server-mode packet will own public HTTPS/reverse-proxy operation.

## Configure OpenRepurpose

In the web UI:

1. Start OpenRepurpose and open **Accounts**.
2. Paste the downloaded client's `client_id` and, when present, `client_secret`.
3. Select **Save credentials**, then **Connect YouTube**.
4. Complete consent in the system browser. Do not use an embedded browser.

Or configure from the CLI while the server is running:

```text
openrepurpose accounts add youtube --credentials C:\path\to\client_secret.json
```

The CLI stores the credentials and prints the Accounts-page URL. Open that page in a browser that
can reach `APP_URL`, then select **Connect YouTube** so the OAuth `state` can be bound to the secure
browser session.

OpenRepurpose requests only these scopes:

- `youtube.readonly`, to identify and show the authorized channel;
- `youtube.upload`, for the upload capability implemented in Packet 8.

The OAuth request uses a one-time, hashed server-side `state` value bound to the initiating browser
session and S256 PKCE. The PKCE verifier,
client secret, and refresh token are stored only in the encrypted local secret vault. Access tokens
are not returned to the browser or persisted. If Google grants only some requested scopes, the
Accounts page reports the resulting capabilities and upload remains unavailable without
`youtube.upload`.

## Local secret-vault threat model

The vault uses AES-256-GCM with a randomly generated key stored in a separate file. Both files use
owner-only permissions where the operating system supports them. Override their deployment paths
with `SECRET_VAULT_PATH` and `SECRET_KEY_PATH`.

This protects against casual inspection and against a database or vault-only backup leaking usable
tokens. It does **not** protect against malware, an administrator, or another process already running
as the same OS user and able to read both files. OS-native credential storage remains a stable-release
hardening target.

## Google restrictions and troubleshooting

- A `redirect_uri_mismatch` normally means the browser address/`APP_URL` does not match the OAuth
  request or the wrong OAuth client type was configured.
- `access_denied` means consent was declined or the Google Workspace administrator blocked a scope.
- If refresh fails with `invalid_grant`, reconnect the account. Google refresh tokens can expire or
  be revoked.
- Google's current `videos.insert` documentation states that uploads from unverified API projects
  created after July 28, 2020 are restricted to private viewing until the project passes an audit.
  OpenRepurpose cannot bypass that restriction and must not describe such an upload as public.

Official references checked for this packet:

- [OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [YouTube OAuth scopes](https://developers.google.com/youtube/v3/guides/authentication)
- [Channels: list](https://developers.google.com/youtube/v3/docs/channels/list)
- [Videos: insert and audit restriction](https://developers.google.com/youtube/v3/docs/videos/insert)
