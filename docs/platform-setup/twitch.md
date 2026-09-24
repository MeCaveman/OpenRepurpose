# Twitch source setup

OpenRepurpose uses your own Twitch developer application for clip and VOD metadata. Official clip
download is opt-in and requires the connected user to be the broadcaster or an authorized editor
with Twitch's clip-management scope.

## Configure the application

1. Register an application in the Twitch developer console.
2. Add the exact OAuth callback shown in OpenRepurpose **Setup** or **Accounts**.
3. Save the client ID and client secret under **Accounts**.
4. Connect Twitch. Enable official clip download only when the authorizing account has the required
   broadcaster/editor relationship and you are authorized to reuse the clips.
5. Add a source with `openrepurpose sources add twitch` or the web source flow.

Basic source polling uses the official Helix Clips and Videos APIs. The source records safe metadata
and preserves cursors. An app/user access token is still required by Twitch even for these reads.

## Media boundary

OpenRepurpose uses Twitch's official temporary clip-download endpoint only when the connected token
has `editor:manage:clips` or `channel:manage:clips` and matches the broadcaster/editor IDs. Temporary
URLs are refreshed on retry and are never logged. Twitch VOD metadata does not provide downloadable
VOD bytes through this integration; provide a local original instead.

OpenRepurpose does not infer CDN URLs, use browser cookies, scrape the Twitch site, or bypass creator
permissions. See Twitch's official [API reference](https://dev.twitch.tv/docs/api/reference) and
[authentication scopes](https://dev.twitch.tv/docs/authentication/scopes/).
