import process from 'node:process';

const timeoutMs = 15_000;

async function request(platform, url, options, validate) {
  const response = await globalThis.fetch(url, {
    ...options,
    signal: globalThis.AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${platform} live smoke failed with HTTP ${response.status}.`);
  const body = await response.json();
  if (!validate(body)) throw new Error(`${platform} live smoke returned an unexpected response.`);
  process.stdout.write(`${platform} read-only live smoke passed.\n`);
}

const checks = [];
const youtubeToken = process.env.OPENREPURPOSE_LIVE_YOUTUBE_ACCESS_TOKEN;
if (youtubeToken)
  checks.push(() =>
    request(
      'YouTube',
      'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',
      { headers: { authorization: `Bearer ${youtubeToken}` } },
      (body) => Array.isArray(body?.items),
    ),
  );

const tiktokToken = process.env.OPENREPURPOSE_LIVE_TIKTOK_ACCESS_TOKEN;
if (tiktokToken)
  checks.push(() =>
    request(
      'TikTok',
      'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tiktokToken}`,
          'content-type': 'application/json; charset=UTF-8',
        },
      },
      (body) => body?.error?.code === 'ok' && typeof body?.data === 'object',
    ),
  );

const metaToken = process.env.OPENREPURPOSE_LIVE_META_ACCESS_TOKEN;
if (metaToken)
  checks.push(() =>
    request(
      'Meta',
      'https://graph.facebook.com/v26.0/me?fields=id,name',
      { headers: { authorization: `Bearer ${metaToken}` } },
      (body) => typeof body?.id === 'string',
    ),
  );

const twitchToken = process.env.OPENREPURPOSE_LIVE_TWITCH_ACCESS_TOKEN;
const twitchClientId = process.env.OPENREPURPOSE_LIVE_TWITCH_CLIENT_ID;
if (twitchToken || twitchClientId) {
  if (!twitchToken || !twitchClientId)
    throw new Error('Twitch live smoke requires both access token and client ID.');
  checks.push(() =>
    request(
      'Twitch',
      'https://api.twitch.tv/helix/users',
      {
        headers: {
          authorization: `Bearer ${twitchToken}`,
          'client-id': twitchClientId,
        },
      },
      (body) => Array.isArray(body?.data),
    ),
  );
}

const kickToken = process.env.OPENREPURPOSE_LIVE_KICK_ACCESS_TOKEN;
if (kickToken)
  checks.push(() =>
    request(
      'Kick',
      'https://api.kick.com/public/v1/users',
      { headers: { authorization: `Bearer ${kickToken}` } },
      (body) => Array.isArray(body?.data),
    ),
  );

if (checks.length === 0)
  throw new Error(
    'No live platform credential set was supplied. Configure at least one OPENREPURPOSE_LIVE_* secret.',
  );

for (const check of checks) await check();
