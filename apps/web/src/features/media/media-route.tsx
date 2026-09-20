import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { getCsrfToken } from '../../lib/local-api';
import { MediaPage } from './media-page';
import type { MediaAccountView, MediaAssetView, MediaPublishPlatform } from './media-page';

interface TikTokPublishingCapabilities {
  readonly media?: { readonly captionMaxUtf16CodeUnits: number };
  readonly privacyLevelOptions: readonly string[];
}

type TikTokCapabilityView =
  | { readonly capabilities: TikTokPublishingCapabilities; readonly error?: never }
  | { readonly capabilities?: never; readonly error: string };

export function MediaRoute() {
  const [media, setMedia] = useState<readonly MediaAssetView[]>([]);
  const [accounts, setAccounts] = useState<readonly MediaAccountView[]>([]);
  const [tiktokCapabilities, setTikTokCapabilities] = useState<
    Readonly<Record<string, TikTokCapabilityView>>
  >({});
  const [importPath, setImportPath] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [activeAction, setActiveAction] = useState<string>();
  const [error, setError] = useState<string>();
  const [publishMediaId, setPublishMediaId] = useState<string>();
  const [publishAccountId, setPublishAccountId] = useState('');
  const [publishTitle, setPublishTitle] = useState('');
  const [publishDescription, setPublishDescription] = useState('');
  const [publishPlatform, setPublishPlatform] = useState<MediaPublishPlatform>('youtube');
  const [publishPrivacy, setPublishPrivacy] = useState('SELF_ONLY');
  const [publishCaption, setPublishCaption] = useState('');
  const [disableComment, setDisableComment] = useState(false);
  const [disableDuet, setDisableDuet] = useState(false);
  const [disableStitch, setDisableStitch] = useState(false);

  const loadMedia = async () => {
    const response = await fetch('/api/media');
    if (!response.ok) throw new Error('Media library is unavailable.');
    const body = (await response.json()) as { media: readonly MediaAssetView[] };
    setMedia(body.media);
  };

  const loadAccounts = async () => {
    const response = await fetch('/api/accounts');
    if (!response.ok) throw new Error('Account status is unavailable.');
    const body = (await response.json()) as { accounts: readonly MediaAccountView[] };
    setAccounts(body.accounts);
    const views = await Promise.all(
      body.accounts
        .filter((account) => account.provider === 'tiktok')
        .map(async (account): Promise<readonly [string, TikTokCapabilityView]> => {
          const capabilityResponse = await fetch(
            `/api/accounts/tiktok/${encodeURIComponent(account.id)}/capabilities`,
          );
          const capabilityBody = (await capabilityResponse.json()) as {
            capabilities?: TikTokPublishingCapabilities;
            error?: string;
          };
          return [
            account.id,
            capabilityResponse.ok && capabilityBody.capabilities !== undefined
              ? { capabilities: capabilityBody.capabilities }
              : { error: capabilityBody.error ?? 'TikTok posting availability is unavailable.' },
          ];
        }),
    );
    setTikTokCapabilities(Object.fromEntries(views));
  };

  const retryMedia = async () => {
    setError(undefined);
    setIsLoading(true);
    try {
      await Promise.all([loadMedia(), loadAccounts()]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load media.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void retryMedia();
  }, []);

  const importMedia = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setActiveAction('import');
    try {
      const response = await fetch('/api/media/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify({ path: importPath }),
      });
      if (!response.ok) throw new Error('Import failed. Check the file and ffprobe.');
      setImportPath('');
      await loadMedia();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Import failed.');
    } finally {
      setActiveAction(undefined);
    }
  };

  const queueYouTubePublish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (publishMediaId === undefined) return;
    setError(undefined);
    setActiveAction('publish:youtube');
    try {
      const response = await fetch('/api/publish/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify({
          mediaId: publishMediaId,
          accountId: publishAccountId,
          metadata: { title: publishTitle, description: publishDescription, privacy: 'private' },
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The YouTube upload could not be queued.');
      setPublishMediaId(undefined);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The YouTube upload could not be queued.',
      );
    } finally {
      setActiveAction(undefined);
    }
  };

  const queueTikTokPublish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (publishMediaId === undefined) return;
    setError(undefined);
    setActiveAction('publish:tiktok');
    try {
      const response = await fetch('/api/publish/tiktok', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify({
          mediaId: publishMediaId,
          accountId: publishAccountId,
          metadata: {
            caption: publishCaption,
            privacyLevel: publishPrivacy,
            disableComment,
            disableDuet,
            disableStitch,
          },
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The TikTok post could not be queued.');
      setPublishMediaId(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The TikTok post could not be queued.');
    } finally {
      setActiveAction(undefined);
    }
  };

  const beginPublish = (asset: MediaAssetView, platform: MediaPublishPlatform) => {
    const name = asset.path.split(/[\\/]/).pop() ?? 'Untitled video';
    setPublishMediaId(asset.id);
    setPublishPlatform(platform);
    setPublishCaption(name.replace(/\.[^.]+$/, ''));
    if (platform === 'youtube') {
      setPublishTitle(name.replace(/\.[^.]+$/, ''));
      setPublishDescription('');
      setPublishAccountId(accounts[0]?.id ?? '');
      return;
    }
    setPublishAccountId(accounts.find((account) => account.provider === 'tiktok')?.id ?? '');
    const capability = Object.values(tiktokCapabilities).find(
      (view) => view.capabilities !== undefined,
    )?.capabilities;
    setPublishPrivacy(capability?.privacyLevelOptions[0] ?? 'SELF_ONLY');
  };

  return (
    <MediaPage
      accounts={accounts}
      activeAction={activeAction}
      error={error}
      importPath={importPath}
      isLoading={isLoading}
      media={media}
      onAccountIdChange={setPublishAccountId}
      onBeginPublish={beginPublish}
      onCancelPublish={() => setPublishMediaId(undefined)}
      onCaptionChange={setPublishCaption}
      onDescriptionChange={setPublishDescription}
      onDisableCommentChange={setDisableComment}
      onDisableDuetChange={setDisableDuet}
      onDisableStitchChange={setDisableStitch}
      onImport={importMedia}
      onImportPathChange={setImportPath}
      onPrivacyChange={setPublishPrivacy}
      onPublish={publishPlatform === 'youtube' ? queueYouTubePublish : queueTikTokPublish}
      onRetry={() => void retryMedia()}
      onTitleChange={setPublishTitle}
      publish={{
        accountId: publishAccountId,
        caption: publishCaption,
        captionMaxLength: Object.values(tiktokCapabilities).find((view) => view.capabilities)
          ?.capabilities?.media?.captionMaxUtf16CodeUnits,
        description: publishDescription,
        disableComment,
        disableDuet,
        disableStitch,
        mediaId: publishMediaId,
        platform: publishPlatform,
        privacy: publishPrivacy,
        privacyOptions:
          tiktokCapabilities[publishAccountId]?.capabilities?.privacyLevelOptions ?? [],
        title: publishTitle,
      }}
    />
  );
}
