import { useEffect, useState } from 'react';

import { SetupPage } from './setup-page';
import type { SetupCredentialStatusView, TikTokSetupCredentialStatusView } from './setup-page';

export function SetupRoute() {
  const [youtubeStatus, setYoutubeStatus] = useState<SetupCredentialStatusView>();
  const [tiktokStatus, setTikTokStatus] = useState<TikTokSetupCredentialStatusView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const loadSetup = async () => {
      const response = await fetch('/api/setup');
      if (!response.ok) throw new Error('Setup status is unavailable.');
      const body = (await response.json()) as {
        tiktok: TikTokSetupCredentialStatusView;
        youtube: SetupCredentialStatusView;
      };
      setYoutubeStatus(body.youtube);
      setTikTokStatus(body.tiktok);
    };

    void loadSetup().catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : 'Could not load setup status.'),
    );
  }, []);

  return <SetupPage error={error} tiktokStatus={tiktokStatus} youtubeStatus={youtubeStatus} />;
}
