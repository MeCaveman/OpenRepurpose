export type KnownPlatform =
  'facebook' | 'instagram' | 'kick' | 'local' | 'meta' | 'tiktok' | 'twitch' | 'youtube';

export type PlatformMetadata = {
  readonly id: string;
  readonly label: string;
  readonly mark: string;
};

const platforms: Readonly<Record<KnownPlatform, PlatformMetadata>> = {
  facebook: { id: 'facebook', label: 'Facebook', mark: 'FB' },
  instagram: { id: 'instagram', label: 'Instagram', mark: 'IG' },
  kick: { id: 'kick', label: 'Kick', mark: 'KI' },
  local: { id: 'local', label: 'Local files', mark: 'LF' },
  meta: { id: 'meta', label: 'Meta', mark: 'ME' },
  tiktok: { id: 'tiktok', label: 'TikTok', mark: 'TT' },
  twitch: { id: 'twitch', label: 'Twitch', mark: 'TW' },
  youtube: { id: 'youtube', label: 'YouTube', mark: 'YT' },
};

function humanizePlatformId(platform: string): string {
  return platform
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function getPlatformMetadata(platform: string): PlatformMetadata {
  if (platform in platforms) return platforms[platform as KnownPlatform];

  const label = humanizePlatformId(platform) || 'Unknown platform';
  return {
    id: platform,
    label,
    mark: label
      .split(' ')
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase(),
  };
}
