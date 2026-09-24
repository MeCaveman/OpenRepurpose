# Platform setup

OpenRepurpose has no hosted credential broker. You create and control each developer application,
register the exact callback shown by the local **Setup** or **Accounts** page, and grant only the
scopes needed by the capabilities you use. App secrets and OAuth tokens stay in the encrypted local
vault; do not commit them or put them in browser storage.

| Platform              | OpenRepurpose capability                                       | Important boundary                                                            |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [YouTube](youtube.md) | source polling and video publishing                            | affected unverified API projects are private-only until audit                 |
| [TikTok](tiktok.md)   | Direct Post publishing                                         | unaudited clients are private-only and creator/post caps apply                |
| [Meta](meta.md)       | Facebook Page and Instagram professional Reels                 | app review/access and eligible managed targets are required                   |
| [Twitch](twitch.md)   | clip/VOD source metadata and authorized official clip download | download requires broadcaster/editor authorization; VOD bytes are unavailable |
| [Kick](kick.md)       | channel and active-livestream metadata                         | no supported official media-download capability                               |

OAuth success does not prove publish eligibility. OpenRepurpose shows granted capabilities and
platform processing separately, honors rate limits, and never bypasses audits, review, visibility,
account-type, quota, DRM, or rights restrictions.
