import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { getCsrfToken } from '../../lib/local-api';
import { MediaPage } from './media-page';
import type { MediaAccountView, MediaAssetView, MediaPublishPlatform } from './media-page';
import type {
  SubtitleFormat,
  TranscriptCueView,
  TranscriptView,
  TranscriptWorkspaceView,
} from './transcript-editor';

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
  const [notice, setNotice] = useState<{
    readonly description: string;
    readonly title: string;
  }>();
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
  const [transcriptWorkspace, setTranscriptWorkspace] = useState<TranscriptWorkspaceView>();
  const [transcriptIsDirty, setTranscriptIsDirty] = useState(false);

  const confirmDiscardTranscriptEdits = () =>
    !transcriptIsDirty || window.confirm('Discard unsaved transcript edits?');

  useEffect(() => {
    if (!transcriptIsDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const warnBeforeNavigation = (event: MouseEvent) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.origin !== window.location.origin) return;
      if (!window.confirm('Discard unsaved transcript edits?')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      setTranscriptIsDirty(false);
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    document.addEventListener('click', warnBeforeNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
      document.removeEventListener('click', warnBeforeNavigation, true);
    };
  }, [transcriptIsDirty]);

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
    setNotice(undefined);
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
    setNotice(undefined);
    setActiveAction('import');
    try {
      const importedPath = importPath;
      const response = await fetch('/api/media/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify({ path: importPath }),
      });
      if (!response.ok) throw new Error('Import failed. Check the file and ffprobe.');
      setImportPath('');
      await loadMedia();
      setNotice({
        description: `${importedPath} is ready for local inspection and publishing.`,
        title: 'Media imported',
      });
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
    setNotice(undefined);
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
      setNotice({
        description: 'Track upload progress and final platform processing in Jobs.',
        title: 'YouTube upload queued',
      });
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
    setNotice(undefined);
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
      setNotice({
        description: 'Track upload progress and final platform processing in Jobs.',
        title: 'TikTok post queued',
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The TikTok post could not be queued.');
    } finally {
      setActiveAction(undefined);
    }
  };

  const beginPublish = (asset: MediaAssetView, platform: MediaPublishPlatform) => {
    if (!confirmDiscardTranscriptEdits()) return;
    setTranscriptWorkspace(undefined);
    setTranscriptIsDirty(false);
    setNotice(undefined);
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

  const loadTranscript = async (mediaId: string, assetPath: string) => {
    setTranscriptWorkspace({
      assetPath,
      isLoading: true,
      isSaving: false,
      mediaId,
    });
    try {
      const response = await fetch(`/api/media/${encodeURIComponent(mediaId)}/transcripts`);
      const body = (await response.json()) as {
        readonly error?: string;
        readonly transcripts?: readonly TranscriptView[];
      };
      if (!response.ok)
        throw new Error(body.error ?? 'The transcript could not be loaded for this media item.');
      setTranscriptWorkspace({
        assetPath,
        isLoading: false,
        isSaving: false,
        mediaId,
        ...(body.transcripts?.[0] === undefined ? {} : { transcript: body.transcripts[0] }),
      });
    } catch (failure) {
      setTranscriptWorkspace({
        assetPath,
        error: failure instanceof Error ? failure.message : 'The transcript could not be loaded.',
        isLoading: false,
        isSaving: false,
        mediaId,
      });
    }
  };

  const beginTranscript = (asset: MediaAssetView) => {
    if (transcriptWorkspace?.isSaving || !confirmDiscardTranscriptEdits()) return;
    setPublishMediaId(undefined);
    setTranscriptIsDirty(false);
    void loadTranscript(asset.id, asset.path);
  };

  const closeTranscript = () => {
    if (transcriptWorkspace?.isSaving || !confirmDiscardTranscriptEdits()) return;
    setTranscriptWorkspace(undefined);
    setTranscriptIsDirty(false);
  };

  const saveTranscript = async (cues: readonly TranscriptCueView[], expectedRevision: number) => {
    const current = transcriptWorkspace;
    if (current?.transcript === undefined) return;
    setTranscriptWorkspace({
      assetPath: current.assetPath,
      isLoading: current.isLoading,
      isSaving: true,
      mediaId: current.mediaId,
      transcript: current.transcript,
    });
    try {
      const response = await fetch(
        `/api/transcripts/${encodeURIComponent(current.transcript.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
          body: JSON.stringify({ cues, expectedRevision }),
        },
      );
      const body = (await response.json()) as {
        readonly error?: string;
        readonly transcript?: TranscriptView;
      };
      if (!response.ok || body.transcript === undefined)
        throw new Error(body.error ?? 'The transcript edit could not be saved.');
      setTranscriptIsDirty(false);
      setTranscriptWorkspace({
        ...current,
        isSaving: false,
        notice: 'Your cue text and timestamps are persisted locally.',
        transcript: body.transcript,
      });
    } catch (failure) {
      setTranscriptWorkspace({
        ...current,
        error:
          failure instanceof Error ? failure.message : 'The transcript edit could not be saved.',
        isSaving: false,
      });
    }
  };

  const exportTranscript = async (format: SubtitleFormat) => {
    const current = transcriptWorkspace;
    if (current?.transcript === undefined) return;
    setTranscriptWorkspace({
      assetPath: current.assetPath,
      exportingFormat: format,
      isLoading: current.isLoading,
      isSaving: current.isSaving,
      mediaId: current.mediaId,
      transcript: current.transcript,
    });
    try {
      const response = await fetch(
        `/api/transcripts/${encodeURIComponent(current.transcript.id)}/export?format=${format}`,
      );
      if (!response.ok) {
        const body = (await response.json()) as { readonly error?: string };
        throw new Error(body.error ?? `The ${format.toUpperCase()} export failed.`);
      }
      const url = URL.createObjectURL(await response.blob());
      const download = document.createElement('a');
      download.href = url;
      download.download = `${current.transcript.id}.${format}`;
      document.body.append(download);
      download.click();
      download.remove();
      URL.revokeObjectURL(url);
      setTranscriptWorkspace({ ...current, notice: `${format.toUpperCase()} export is ready.` });
    } catch (failure) {
      setTranscriptWorkspace({
        ...current,
        error:
          failure instanceof Error ? failure.message : `The ${format.toUpperCase()} export failed.`,
        isSaving: false,
      });
    }
  };

  return (
    <MediaPage
      accounts={accounts}
      activeAction={activeAction}
      error={error}
      importPath={importPath}
      isLoading={isLoading}
      media={media}
      notice={notice}
      onAccountIdChange={setPublishAccountId}
      onBeginPublish={beginPublish}
      onBeginTranscript={beginTranscript}
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
      onTranscriptClose={closeTranscript}
      onTranscriptDirtyChange={setTranscriptIsDirty}
      onTranscriptExport={(format) => void exportTranscript(format)}
      onTranscriptRetry={() => {
        if (transcriptWorkspace !== undefined && confirmDiscardTranscriptEdits()) {
          setTranscriptIsDirty(false);
          void loadTranscript(transcriptWorkspace.mediaId, transcriptWorkspace.assetPath);
        }
      }}
      onTranscriptSave={(cues, expectedRevision) => void saveTranscript(cues, expectedRevision)}
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
      transcript={transcriptWorkspace}
    />
  );
}
