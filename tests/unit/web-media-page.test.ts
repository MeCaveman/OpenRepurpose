import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MediaPage, type MediaPageProps } from '../../apps/web/src/features/media/index';

function renderMediaPage(overrides: Partial<MediaPageProps> = {}): string {
  const props: MediaPageProps = {
    accounts: [
      { displayName: 'Studio channel', id: 'youtube-1', provider: 'youtube' },
      { displayName: 'Short-form channel', id: 'tiktok-1', provider: 'tiktok' },
    ],
    activeAction: undefined,
    error: undefined,
    importPath: '',
    isLoading: false,
    media: [
      {
        id: 'media-1',
        metadata: { durationSeconds: 7, height: 1080, width: 1920 },
        path: 'C:\\clips\\episode one.mp4',
        state: 'available',
      },
    ],
    notice: undefined,
    onAccountIdChange: () => undefined,
    onBeginPublish: () => undefined,
    onBeginTranscript: () => undefined,
    onCancelPublish: () => undefined,
    onCaptionChange: () => undefined,
    onDescriptionChange: () => undefined,
    onDisableCommentChange: () => undefined,
    onDisableDuetChange: () => undefined,
    onDisableStitchChange: () => undefined,
    onImport: () => undefined,
    onImportPathChange: () => undefined,
    onPrivacyChange: () => undefined,
    onPublish: () => undefined,
    onRetry: () => undefined,
    onTranscriptClose: () => undefined,
    onTranscriptDirtyChange: () => undefined,
    onTranscriptExport: () => undefined,
    onTranscriptRetry: () => undefined,
    onTranscriptSave: () => undefined,
    onTitleChange: () => undefined,
    publish: {
      accountId: '',
      caption: '',
      captionMaxLength: undefined,
      description: '',
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      mediaId: undefined,
      platform: 'youtube',
      privacy: 'SELF_ONLY',
      privacyOptions: [],
      title: '',
    },
    transcript: undefined,
    ...overrides,
  };

  return renderToStaticMarkup(createElement(MediaPage, props));
}

describe('web media page', () => {
  it('renders the local import control and persisted media ledger', () => {
    const markup = renderMediaPage();

    expect(markup).toContain('Import local original');
    expect(markup).toContain('Local file path');
    expect(markup).toContain('Media ledger');
    expect(markup).toContain('episode one.mp4');
    expect(markup).toContain('1920×1080');
    expect(markup).toContain('Available');
    expect(markup).toContain('Publish to YouTube');
    expect(markup).toContain('Publish to TikTok');
    expect(markup).toContain('Transcript');
  });

  it('renders explicit loading, error, and empty states', () => {
    const loading = renderMediaPage({ isLoading: true, media: [] });
    const empty = renderMediaPage({ media: [] });
    const error = renderMediaPage({ error: 'Media library is unavailable.', media: [] });

    expect(loading).toContain('Loading local media…');
    expect(empty).toContain('No local media has been imported yet.');
    expect(error).toContain('Media request failed');
    expect(error).toContain('Media library is unavailable.');
    expect(error).toContain('Reload media');
  });

  it('announces successful import and publish outcomes', () => {
    const markup = renderMediaPage({
      notice: {
        description: 'Track upload progress and final platform processing in Jobs.',
        title: 'YouTube upload queued',
      },
    });

    expect(markup).toContain('role="status"');
    expect(markup).toContain('YouTube upload queued');
    expect(markup).toContain('Track upload progress and final platform processing in Jobs.');
  });

  it('blocks publish preparation until local media inspection succeeds', () => {
    const markup = renderMediaPage({
      media: [
        {
          id: 'media-processing',
          metadata: { durationSeconds: Number.NaN, height: 0, width: Number.POSITIVE_INFINITY },
          path: '',
          state: 'processing',
        },
      ],
    });

    expect(markup).toContain('Unnamed media file');
    expect(markup).toContain('—×— · —');
    expect(markup).toContain('Publishing is available after local media inspection succeeds.');
    expect(markup).toContain('disabled=""');
  });

  it('reveals the YouTube publish preparation only after an asset is selected', () => {
    const closed = renderMediaPage();
    const open = renderMediaPage({
      publish: {
        accountId: 'youtube-1',
        caption: 'Episode one',
        captionMaxLength: undefined,
        description: 'Prepared locally.',
        disableComment: false,
        disableDuet: false,
        disableStitch: false,
        mediaId: 'media-1',
        platform: 'youtube',
        privacy: 'SELF_ONLY',
        privacyOptions: [],
        title: 'Episode one',
      },
    });

    expect(closed).not.toContain('Queue YouTube upload');
    expect(open).toContain('Queue YouTube upload');
    expect(open).toContain('name="accountId"');
    expect(open).toContain('name="title"');
    expect(open).toContain('name="description"');
    expect(open).not.toContain('name="caption"');
  });

  it('keeps TikTok creator options and interaction controls in the selected publish pane', () => {
    const markup = renderMediaPage({
      publish: {
        accountId: 'tiktok-1',
        caption: 'Episode one',
        captionMaxLength: 2200,
        description: '',
        disableComment: true,
        disableDuet: false,
        disableStitch: true,
        mediaId: 'media-1',
        platform: 'tiktok',
        privacy: 'SELF_ONLY',
        privacyOptions: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'],
        title: '',
      },
    });

    expect(markup).toContain('Queue TikTok post');
    expect(markup).toContain('maxLength="2200"');
    expect(markup).toContain('SELF_ONLY');
    expect(markup).toContain('PUBLIC_TO_EVERYONE');
    expect(markup).toContain('Disable comments');
    expect(markup).toContain('Disable duet');
    expect(markup).toContain('Disable stitch');
  });

  it('renders an editable transcript workbench with deterministic export actions', () => {
    const markup = renderMediaPage({
      transcript: {
        assetPath: 'C:\\clips\\episode one.mp4',
        isLoading: false,
        isSaving: false,
        mediaId: 'media-1',
        transcript: {
          cues: [{ startMs: 0, endMs: 1_250, text: 'Opening caption' }],
          hasUserEdits: false,
          id: 'transcript-1',
          language: 'en',
          model: { id: 'base', version: 'v1' },
          providerId: 'whisper-cpp',
          revision: 1,
          updatedAt: new Date(0).toISOString(),
        },
      },
    });

    expect(markup).toContain('Edit episode one.mp4');
    expect(markup).toContain('Cue 1');
    expect(markup).toContain('00:00:00.000');
    expect(markup).toContain('00:00:01.250');
    expect(markup).toContain('Opening caption');
    expect(markup).toContain('Save transcript');
    expect(markup).toContain('Export SRT');
    expect(markup).toContain('Export VTT');
    expect(markup).toContain('min-[90rem]:grid-cols');
  });

  it('uses OpenRepurpose tokens instead of feature colors', () => {
    const markup = renderMediaPage();

    expect(markup).toContain('var(--or-bg-workspace)');
    expect(markup).toContain('var(--or-text-primary)');
    expect(markup).not.toMatch(
      /(?:bg|border|text)-(?:slate|cyan|fuchsia|rose|emerald|white|black)-/,
    );
  });
});
