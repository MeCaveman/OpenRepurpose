import { useEffect, useState } from 'react';

import { SetupPage } from './setup-page';
import type { SetupCredentialStatusView, TikTokSetupCredentialStatusView } from './setup-page';

export function SetupRoute() {
  const [youtubeStatus, setYoutubeStatus] = useState<SetupCredentialStatusView>();
  const [tiktokStatus, setTikTokStatus] = useState<TikTokSetupCredentialStatusView>();
  const [metaStatus, setMetaStatus] = useState<SetupCredentialStatusView>();
  const [twitchStatus, setTwitchStatus] = useState<SetupCredentialStatusView>();
  const [kickStatus, setKickStatus] = useState<SetupCredentialStatusView>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);

  const loadSetup = async () => {
    setError(undefined);
    setIsLoading(true);
    try {
      const response = await fetch('/api/setup');
      if (!response.ok) throw new Error('Setup status is unavailable.');
      const body = (await response.json()) as {
        tiktok: TikTokSetupCredentialStatusView;
        kick?: SetupCredentialStatusView;
        meta?: SetupCredentialStatusView;
        twitch?: SetupCredentialStatusView;
        youtube: SetupCredentialStatusView;
      };
      setYoutubeStatus(body.youtube);
      setTikTokStatus(body.tiktok);
      setMetaStatus(body.meta);
      setTwitchStatus(body.twitch);
      setKickStatus(body.kick);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load setup status.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadSetup();
  }, []);

  return (
    <SetupPage
      error={error}
      isLoading={isLoading}
      kickStatus={kickStatus}
      metaStatus={metaStatus}
      onRetry={() => void loadSetup()}
      tiktokStatus={tiktokStatus}
      twitchStatus={twitchStatus}
      youtubeStatus={youtubeStatus}
    />
  );
}
