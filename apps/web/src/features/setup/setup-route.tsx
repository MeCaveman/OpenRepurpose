import { useEffect, useState } from 'react';

import { SetupPage } from './setup-page';
import type { SetupCredentialStatusView, TikTokSetupCredentialStatusView } from './setup-page';

export function SetupRoute() {
  const [youtubeStatus, setYoutubeStatus] = useState<SetupCredentialStatusView>();
  const [tiktokStatus, setTikTokStatus] = useState<TikTokSetupCredentialStatusView>();
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
        youtube: SetupCredentialStatusView;
      };
      setYoutubeStatus(body.youtube);
      setTikTokStatus(body.tiktok);
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
      onRetry={() => void loadSetup()}
      tiktokStatus={tiktokStatus}
      youtubeStatus={youtubeStatus}
    />
  );
}
