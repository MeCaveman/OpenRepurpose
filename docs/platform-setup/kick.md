# Kick source setup

OpenRepurpose's Kick integration discovers channel and active-livestream metadata through Kick's
official API. It does not download clips, VODs, replays, livestreams, or playback media: that API
surface is not currently published by Kick.

## Prerequisites

1. Enable 2FA on the Kick account, then create a Kick app in its Developer settings.
2. Register the exact callback URL shown by OpenRepurpose **Setup** or **Accounts**.
3. Save the app's client ID and client secret under **Accounts**, then complete browser consent.

The connection requests only `user:read` and `channel:read`. OpenRepurpose uses PKCE, an
installation-local browser-bound state, and local secret storage; authorization codes and tokens
are not returned by source APIs or written to job metadata.

## Add a source

Use the connected account ID and the broadcaster's Kick user ID:

```text
openrepurpose sources add kick --account <account-id> --broadcaster <broadcaster-user-id>
```

The durable poller calls Kick's non-deprecated per-user active-livestream endpoint. A detected
livestream is identified by its Kick livestream UUID; an absent stream only means it was not active
at the time of polling and does not create a VOD.

## Media limitation

Each observation explicitly reports official binary media as unavailable. A user may match their
own local original through the normal source workflow. If a separately installed, explicitly
authorized external resolver supports the public channel locator, it still requires rights
confirmation and is not Kick download support. OpenRepurpose never uses browser cookies,
undocumented site endpoints, inferred HLS URLs, or stream keys.

Public webhook delivery is optional and requires a deliberately configured publicly reachable
endpoint; it is not needed for local polling and is not configured by this packet.
