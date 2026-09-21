import { useEffect, useId, useRef } from 'react';
import type { FormEventHandler, RefObject } from 'react';

import {
  PlatformIdentity,
  ResourceEmptyState,
  getPlatformMetadata,
} from '../../components/patterns';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Panel,
  Select,
  Spinner,
  Textarea,
} from '../../components/ui';
import type { BadgeVariant } from '../../components/ui';
import { TranscriptEditor } from './transcript-editor';
import type {
  SubtitleFormat,
  TranscriptCueView,
  TranscriptWorkspaceView,
} from './transcript-editor';

export type MediaPublishPlatform = 'tiktok' | 'youtube';

export interface MediaAssetView {
  readonly id: string;
  readonly metadata: {
    readonly durationSeconds?: number;
    readonly height?: number;
    readonly width?: number;
  };
  readonly path: string;
  readonly state: string;
}

export interface MediaAccountView {
  readonly displayName: string;
  readonly id: string;
  readonly provider: string;
}

export interface MediaPublishDraft {
  readonly accountId: string;
  readonly caption: string;
  readonly captionMaxLength: number | undefined;
  readonly description: string;
  readonly disableComment: boolean;
  readonly disableDuet: boolean;
  readonly disableStitch: boolean;
  readonly mediaId: string | undefined;
  readonly platform: MediaPublishPlatform;
  readonly privacy: string;
  readonly privacyOptions: readonly string[];
  readonly title: string;
}

export interface MediaPageProps {
  readonly accounts: readonly MediaAccountView[];
  readonly activeAction: string | undefined;
  readonly error: string | undefined;
  readonly importPath: string;
  readonly isLoading: boolean;
  readonly media: readonly MediaAssetView[];
  readonly notice: { readonly description: string; readonly title: string } | undefined;
  readonly onAccountIdChange: (value: string) => void;
  readonly onBeginPublish: (
    asset: MediaAssetView,
    platform: MediaPublishPlatform,
    trigger?: HTMLButtonElement,
  ) => void;
  readonly onBeginTranscript: (asset: MediaAssetView, trigger?: HTMLButtonElement) => void;
  readonly onCancelPublish: () => void;
  readonly onCaptionChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onDisableCommentChange: (value: boolean) => void;
  readonly onDisableDuetChange: (value: boolean) => void;
  readonly onDisableStitchChange: (value: boolean) => void;
  readonly onImport: FormEventHandler<HTMLFormElement>;
  readonly onImportPathChange: (value: string) => void;
  readonly onPrivacyChange: (value: string) => void;
  readonly onPublish: FormEventHandler<HTMLFormElement>;
  readonly onRetry: () => void;
  readonly onTranscriptClose: () => void;
  readonly onTranscriptDirtyChange: (isDirty: boolean) => void;
  readonly onTranscriptExport: (format: SubtitleFormat) => void;
  readonly onTranscriptRetry: () => void;
  readonly onTranscriptSave: (cues: readonly TranscriptCueView[], expectedRevision: number) => void;
  readonly onTitleChange: (value: string) => void;
  readonly publish: MediaPublishDraft;
  readonly transcript: TranscriptWorkspaceView | undefined;
}

function filename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || 'Unnamed media file';
}

function humanize(value: string): string {
  const label = value
    .trim()
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  return label || 'Unknown';
}

function mediaStateVariant(state: string): BadgeVariant {
  const normalized = state.trim().toLowerCase();
  if (normalized === 'available' || normalized === 'ready' || normalized === 'imported') {
    return 'success';
  }
  if (normalized === 'processing' || normalized === 'probing') return 'info';
  if (normalized === 'failed' || normalized === 'unavailable') return 'error';
  return 'neutral';
}

function MediaState({ state }: { readonly state: string }) {
  return <Badge variant={mediaStateVariant(state)}>{humanize(state)}</Badge>;
}

function formatTechnicalDetails(asset: MediaAssetView): string {
  const displayDimension = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : '—';
  const dimensions = `${displayDimension(asset.metadata.width)}×${displayDimension(asset.metadata.height)}`;
  const duration =
    asset.metadata.durationSeconds === undefined ||
    !Number.isFinite(asset.metadata.durationSeconds) ||
    asset.metadata.durationSeconds < 0
      ? '—'
      : new Intl.NumberFormat(undefined, {
          maximumFractionDigits: 1,
          minimumFractionDigits: 1,
        }).format(asset.metadata.durationSeconds);
  return `${dimensions} · ${duration}\u00a0s`;
}

function MediaIdentity({ asset }: { readonly asset: MediaAssetView }) {
  const name = filename(asset.path);

  return (
    <div className="min-w-0">
      <p className="break-words font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
        {name}
      </p>
      <code
        className="mt-[var(--or-space-1)] block break-all font-[family-name:var(--or-font-technical)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]"
        title={asset.path}
        translate="no"
      >
        {asset.path}
      </code>
    </div>
  );
}

function PublishActions({
  activeAction,
  asset,
  hasTikTokAccount,
  onBeginPublish,
  onBeginTranscript,
}: {
  readonly activeAction: string | undefined;
  readonly asset: MediaAssetView;
  readonly hasTikTokAccount: boolean;
  readonly onBeginPublish: MediaPageProps['onBeginPublish'];
  readonly onBeginTranscript: MediaPageProps['onBeginTranscript'];
}) {
  const unavailable = asset.state !== 'available';
  const disabled = activeAction !== undefined || unavailable;
  const unavailableReason = unavailable
    ? 'Publishing is available after local media inspection succeeds.'
    : undefined;
  const unavailableReasonId = useId();
  const platforms: readonly MediaPublishPlatform[] = hasTikTokAccount
    ? ['youtube', 'tiktok']
    : ['youtube'];

  return (
    <div className="grid gap-[var(--or-space-2)]">
      <div className="flex flex-wrap gap-[var(--or-space-2)]">
        {platforms.map((platform) => (
          <Button
            aria-describedby={unavailable ? unavailableReasonId : undefined}
            data-media-id={asset.id}
            data-media-publish-trigger={platform}
            disabled={disabled}
            key={platform}
            onClick={(event) => onBeginPublish(asset, platform, event.currentTarget)}
            size="sm"
            variant="secondary"
          >
            Publish to {getPlatformMetadata(platform).label}
          </Button>
        ))}
        <Button
          aria-describedby={unavailable ? unavailableReasonId : undefined}
          data-media-id={asset.id}
          data-media-transcript-trigger
          disabled={disabled}
          onClick={(event) => onBeginTranscript(asset, event.currentTarget)}
          size="sm"
          variant="secondary"
        >
          Transcript
        </Button>
      </div>
      {unavailableReason !== undefined && (
        <p
          className="max-w-[var(--or-empty-state-max-width)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-micro-size)] [line-height:var(--or-type-body-line)]"
          id={unavailableReasonId}
        >
          {unavailableReason}
        </p>
      )}
    </div>
  );
}

function MediaTable({
  activeAction,
  hasTikTokAccount,
  media,
  onBeginPublish,
  onBeginTranscript,
}: Pick<MediaPageProps, 'activeAction' | 'media' | 'onBeginPublish'> & {
  readonly hasTikTokAccount: boolean;
  readonly onBeginTranscript: MediaPageProps['onBeginTranscript'];
}) {
  return (
    <Panel className="hidden overflow-x-auto md:block" padding="none">
      <table className="w-full text-left [font-size:var(--or-type-interface-size)]">
        <thead className="h-[var(--or-table-header-height)] bg-[var(--or-bg-workspace)] text-[var(--or-text-tertiary)]">
          <tr>
            <th className="px-[var(--or-table-cell-padding-inline)] font-medium" scope="col">
              File
            </th>
            <th className="px-[var(--or-table-cell-padding-inline)] font-medium" scope="col">
              Technical details
            </th>
            <th className="px-[var(--or-table-cell-padding-inline)] font-medium" scope="col">
              State
            </th>
            <th className="px-[var(--or-table-cell-padding-inline)] font-medium" scope="col">
              Publish
            </th>
          </tr>
        </thead>
        <tbody>
          {media.map((asset) => (
            <tr
              className="border-t border-[var(--or-border-subtle)] align-top hover:bg-[var(--or-bg-hover)]"
              key={asset.id}
            >
              <td className="max-w-[24rem] px-[var(--or-table-cell-padding-inline)] py-[var(--or-space-3)]">
                <MediaIdentity asset={asset} />
              </td>
              <td className="px-[var(--or-table-cell-padding-inline)] py-[var(--or-space-3)] font-[family-name:var(--or-font-technical)] text-[var(--or-text-secondary)] tabular-nums whitespace-nowrap">
                {formatTechnicalDetails(asset)}
              </td>
              <td className="px-[var(--or-table-cell-padding-inline)] py-[var(--or-space-3)]">
                <MediaState state={asset.state} />
              </td>
              <td className="px-[var(--or-table-cell-padding-inline)] py-[var(--or-space-3)]">
                <PublishActions
                  activeAction={activeAction}
                  asset={asset}
                  hasTikTokAccount={hasTikTokAccount}
                  onBeginPublish={onBeginPublish}
                  onBeginTranscript={onBeginTranscript}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function MediaList({
  activeAction,
  hasTikTokAccount,
  media,
  onBeginPublish,
  onBeginTranscript,
}: Pick<MediaPageProps, 'activeAction' | 'media' | 'onBeginPublish'> & {
  readonly hasTikTokAccount: boolean;
  readonly onBeginTranscript: MediaPageProps['onBeginTranscript'];
}) {
  return (
    <div className="grid gap-[var(--or-space-3)] md:hidden">
      {media.map((asset) => (
        <Panel key={asset.id}>
          <div className="flex min-w-0 items-start justify-between gap-[var(--or-space-3)]">
            <MediaIdentity asset={asset} />
            <MediaState state={asset.state} />
          </div>
          <p className="mt-[var(--or-space-3)] font-[family-name:var(--or-font-technical)] text-[var(--or-text-secondary)] tabular-nums [font-size:var(--or-type-metadata-size)]">
            {formatTechnicalDetails(asset)}
          </p>
          <div className="mt-[var(--or-space-4)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-3)]">
            <PublishActions
              activeAction={activeAction}
              asset={asset}
              hasTikTokAccount={hasTikTokAccount}
              onBeginPublish={onBeginPublish}
              onBeginTranscript={onBeginTranscript}
            />
          </div>
        </Panel>
      ))}
    </div>
  );
}

function PublishPanel({
  accounts,
  activeAction,
  asset,
  onAccountIdChange,
  onCancelPublish,
  onCaptionChange,
  onDescriptionChange,
  onDisableCommentChange,
  onDisableDuetChange,
  onDisableStitchChange,
  onPrivacyChange,
  onPublish,
  onTitleChange,
  publish,
  headingRef,
}: Omit<
  MediaPageProps,
  | 'error'
  | 'importPath'
  | 'isLoading'
  | 'media'
  | 'notice'
  | 'onBeginPublish'
  | 'onBeginTranscript'
  | 'onImport'
  | 'onImportPathChange'
  | 'onRetry'
  | 'onTranscriptClose'
  | 'onTranscriptDirtyChange'
  | 'onTranscriptExport'
  | 'onTranscriptRetry'
  | 'onTranscriptSave'
  | 'transcript'
> & {
  readonly asset: MediaAssetView | undefined;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const platformAccounts = accounts.filter((account) => account.provider === publish.platform);
  const isPublishing = activeAction === `publish:${publish.platform}`;
  const platformLabel = getPlatformMetadata(publish.platform).label;

  return (
    <Panel
      aria-labelledby="publish-preparation-heading"
      className="min-[90rem]:sticky min-[90rem]:top-[var(--or-space-4)]"
      surface="raised"
    >
      <header className="flex items-start justify-between gap-[var(--or-space-3)]">
        <div className="min-w-0">
          <div className="flex items-center gap-[var(--or-space-3)]">
            <PlatformIdentity platform={publish.platform} showLabel={false} />
            <h3
              className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
              id="publish-preparation-heading"
              ref={headingRef}
              tabIndex={-1}
            >
              Queue {platformLabel} {publish.platform === 'youtube' ? 'upload' : 'post'}
            </h3>
          </div>
          {asset !== undefined && (
            <code
              className="mt-[var(--or-space-2)] block break-all font-[family-name:var(--or-font-technical)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]"
              translate="no"
            >
              {asset.path}
            </code>
          )}
        </div>
        <Button disabled={isPublishing} onClick={onCancelPublish} size="sm" variant="ghost">
          Close
        </Button>
      </header>

      {platformAccounts.length === 0 && (
        <Alert
          className="mt-[var(--or-space-4)]"
          title="Connected account required"
          variant="warning"
        >
          Connect a {platformLabel} account before queuing this publish job.
        </Alert>
      )}

      <form
        className="mt-[var(--or-space-5)] grid gap-[var(--or-field-group-gap)]"
        onSubmit={onPublish}
      >
        <FormField label="Connected account" required>
          <Select
            disabled={isPublishing}
            name="accountId"
            onChange={(event) => onAccountIdChange(event.target.value)}
            value={publish.accountId}
          >
            <option value="">Select a {platformLabel} account</option>
            {platformAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.displayName.trim() || 'Unnamed account'}
              </option>
            ))}
          </Select>
        </FormField>

        {publish.platform === 'youtube' ? (
          <>
            <FormField label="Title" required>
              <Input
                autoComplete="off"
                disabled={isPublishing}
                name="title"
                onChange={(event) => onTitleChange(event.target.value)}
                value={publish.title}
              />
            </FormField>
            <FormField label="Description">
              <Textarea
                autoComplete="off"
                disabled={isPublishing}
                name="description"
                onChange={(event) => onDescriptionChange(event.target.value)}
                value={publish.description}
              />
            </FormField>
          </>
        ) : (
          <>
            <FormField label="Caption" required>
              <Textarea
                autoComplete="off"
                disabled={isPublishing}
                maxLength={publish.captionMaxLength}
                name="caption"
                onChange={(event) => onCaptionChange(event.target.value)}
                value={publish.caption}
              />
            </FormField>
            <FormField
              description="Only privacy levels currently offered by this creator are available."
              label="Privacy"
              required
            >
              <Select
                disabled={isPublishing}
                name="privacyLevel"
                onChange={(event) => onPrivacyChange(event.target.value)}
                value={publish.privacy}
              >
                {publish.privacyOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </FormField>
            <fieldset className="grid gap-[var(--or-space-1)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-3)]">
              <legend className="mb-[var(--or-space-2)] font-medium text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)]">
                Interactions
              </legend>
              <Checkbox
                checked={publish.disableComment}
                disabled={isPublishing}
                label="Disable comments"
                name="disableComment"
                onChange={(event) => onDisableCommentChange(event.target.checked)}
              />
              <Checkbox
                checked={publish.disableDuet}
                disabled={isPublishing}
                label="Disable duet"
                name="disableDuet"
                onChange={(event) => onDisableDuetChange(event.target.checked)}
              />
              <Checkbox
                checked={publish.disableStitch}
                disabled={isPublishing}
                label="Disable stitch"
                name="disableStitch"
                onChange={(event) => onDisableStitchChange(event.target.checked)}
              />
            </fieldset>
          </>
        )}

        <div className="flex flex-wrap gap-[var(--or-space-2)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-4)]">
          <Button isLoading={isPublishing} loadingLabel="Queuing…" type="submit" variant="primary">
            Queue {publish.platform === 'youtube' ? 'upload' : 'post'}
          </Button>
          <Button
            disabled={isPublishing}
            onClick={onCancelPublish}
            type="button"
            variant="secondary"
          >
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function MediaPage({
  accounts,
  activeAction,
  error,
  importPath,
  isLoading,
  media,
  notice,
  onAccountIdChange,
  onBeginPublish,
  onBeginTranscript,
  onCancelPublish,
  onCaptionChange,
  onDescriptionChange,
  onDisableCommentChange,
  onDisableDuetChange,
  onDisableStitchChange,
  onImport,
  onImportPathChange,
  onPrivacyChange,
  onPublish,
  onRetry,
  onTranscriptClose,
  onTranscriptDirtyChange,
  onTranscriptExport,
  onTranscriptRetry,
  onTranscriptSave,
  onTitleChange,
  publish,
  transcript,
}: MediaPageProps) {
  const hasTikTokAccount = accounts.some((account) => account.provider === 'tiktok');
  const selectedAsset = media.find((asset) => asset.id === publish.mediaId);
  const publishOpen = publish.mediaId !== undefined;
  const transcriptOpen = transcript !== undefined;
  const secondaryTaskOpen = publishOpen || transcriptOpen;
  const publishHeadingRef = useRef<HTMLHeadingElement>(null);
  const publishTriggerRef = useRef<{
    readonly assetId: string;
    readonly element: HTMLButtonElement;
    readonly platform: MediaPublishPlatform;
  } | null>(null);
  const publishWasOpenRef = useRef(false);
  const transcriptTriggerRef = useRef<{
    readonly assetId: string;
    readonly element: HTMLButtonElement;
  } | null>(null);
  const transcriptWasOpenRef = useRef(false);

  useEffect(() => {
    if (publishOpen) {
      requestAnimationFrame(() => publishHeadingRef.current?.focus());
    } else if (publishWasOpenRef.current) {
      requestAnimationFrame(() => {
        const previousTrigger = publishTriggerRef.current;
        if (previousTrigger === null) return;
        const visibleTrigger = [
          ...document.querySelectorAll<HTMLButtonElement>('[data-media-publish-trigger]'),
        ].find(
          (candidate) =>
            candidate.dataset.mediaId === previousTrigger.assetId &&
            candidate.dataset.mediaPublishTrigger === previousTrigger.platform &&
            candidate.getClientRects().length > 0,
        );
        (visibleTrigger ?? previousTrigger.element).focus();
      });
    }
    publishWasOpenRef.current = publishOpen;
  }, [publish.mediaId, publish.platform, publishOpen]);

  useEffect(() => {
    if (!transcriptOpen && transcriptWasOpenRef.current) {
      requestAnimationFrame(() => {
        const previousTrigger = transcriptTriggerRef.current;
        if (previousTrigger === null) return;
        const visibleTrigger = [
          ...document.querySelectorAll<HTMLButtonElement>('[data-media-transcript-trigger]'),
        ].find(
          (candidate) =>
            candidate.dataset.mediaId === previousTrigger.assetId &&
            candidate.getClientRects().length > 0,
        );
        (visibleTrigger ?? previousTrigger.element).focus();
      });
    }
    transcriptWasOpenRef.current = transcriptOpen;
  }, [transcriptOpen]);

  const beginPublish: MediaPageProps['onBeginPublish'] = (asset, platform, trigger) => {
    publishTriggerRef.current =
      trigger === undefined ? null : { assetId: asset.id, element: trigger, platform };
    onBeginPublish(asset, platform, trigger);
  };

  const closePublish = () => {
    onCancelPublish();
  };

  const beginTranscript: MediaPageProps['onBeginTranscript'] = (asset, trigger) => {
    transcriptTriggerRef.current =
      trigger === undefined ? null : { assetId: asset.id, element: trigger };
    onBeginTranscript(asset, trigger);
  };

  return (
    <div aria-busy={isLoading || undefined} className="grid gap-[var(--or-space-6)]">
      {error !== undefined && (
        <Alert
          action={
            <Button onClick={onRetry} size="sm" variant="secondary">
              Reload media
            </Button>
          }
          title="Media request failed"
          variant="error"
        >
          {error}
        </Alert>
      )}

      {notice !== undefined && (
        <Alert title={notice.title} variant="success">
          {notice.description}
        </Alert>
      )}

      <div
        className={`grid items-start gap-[var(--or-space-5)] ${secondaryTaskOpen ? 'min-[90rem]:grid-cols-[minmax(0,1fr)_var(--or-shell-inspector-width)]' : ''}`}
      >
        <div
          className={`min-w-0 ${secondaryTaskOpen ? 'hidden min-[90rem]:grid min-[90rem]:gap-[var(--or-space-6)]' : 'grid gap-[var(--or-space-6)]'}`}
        >
          <Panel aria-labelledby="local-import-heading" surface="inset">
            <h2
              className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
              id="local-import-heading"
            >
              Import local original
            </h2>
            <p className="mt-[var(--or-space-2)] max-w-[var(--or-empty-state-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
              Reference a media file you own or are authorized to reuse. OpenRepurpose will inspect
              it locally with ffprobe.
            </p>
            <form
              className="mt-[var(--or-space-4)] flex flex-col items-end gap-[var(--or-space-3)] sm:flex-row"
              onSubmit={onImport}
            >
              <FormField className="w-full flex-1" label="Local file path" required>
                <Input
                  autoComplete="off"
                  disabled={activeAction !== undefined}
                  name="path"
                  onChange={(event) => onImportPathChange(event.target.value)}
                  placeholder="C:\\Media\\video file.mp4"
                  spellCheck={false}
                  value={importPath}
                />
              </FormField>
              <Button
                className="w-full sm:w-auto"
                isLoading={activeAction === 'import'}
                loadingLabel="Importing…"
                type="submit"
                variant="primary"
              >
                Import
              </Button>
            </form>
          </Panel>

          <section aria-labelledby="media-ledger-heading">
            <header className="mb-[var(--or-space-4)] flex flex-wrap items-end justify-between gap-[var(--or-space-3)]">
              <div>
                <p className="font-[family-name:var(--or-font-technical)] font-semibold tracking-[var(--or-type-eyebrow-tracking)] text-[var(--or-text-accent)] uppercase [font-size:var(--or-type-eyebrow-size)] [line-height:var(--or-type-eyebrow-line)]">
                  Local inventory
                </p>
                <h2
                  className="mt-[var(--or-space-1)] font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
                  id="media-ledger-heading"
                >
                  Media ledger
                </h2>
                <p className="mt-[var(--or-space-2)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
                  Inspect persisted file identity and technical metadata before queuing a direct
                  publish job.
                </p>
              </div>
              {!isLoading && (
                <Badge variant="neutral">
                  {media.length} {media.length === 1 ? 'asset' : 'assets'}
                </Badge>
              )}
            </header>

            {isLoading ? (
              <Panel
                aria-live="polite"
                className="flex items-center gap-[var(--or-space-3)]"
                role="status"
              >
                <Spinner />
                <p className="[font-size:var(--or-type-interface-size)]">Loading local media…</p>
              </Panel>
            ) : media.length === 0 ? (
              <ResourceEmptyState
                description="Import a local media file to inspect it and prepare a publish job."
                title="No local media has been imported yet."
              />
            ) : (
              <>
                <MediaTable
                  activeAction={activeAction}
                  hasTikTokAccount={hasTikTokAccount}
                  media={media}
                  onBeginPublish={beginPublish}
                  onBeginTranscript={beginTranscript}
                />
                <MediaList
                  activeAction={activeAction}
                  hasTikTokAccount={hasTikTokAccount}
                  media={media}
                  onBeginPublish={beginPublish}
                  onBeginTranscript={beginTranscript}
                />
              </>
            )}
          </section>
        </div>

        {publishOpen && (
          <PublishPanel
            accounts={accounts}
            activeAction={activeAction}
            asset={selectedAsset}
            headingRef={publishHeadingRef}
            onAccountIdChange={onAccountIdChange}
            onCancelPublish={closePublish}
            onCaptionChange={onCaptionChange}
            onDescriptionChange={onDescriptionChange}
            onDisableCommentChange={onDisableCommentChange}
            onDisableDuetChange={onDisableDuetChange}
            onDisableStitchChange={onDisableStitchChange}
            onPrivacyChange={onPrivacyChange}
            onPublish={onPublish}
            onTitleChange={onTitleChange}
            publish={publish}
          />
        )}
        {transcript !== undefined && (
          <TranscriptEditor
            onClose={onTranscriptClose}
            onDirtyChange={onTranscriptDirtyChange}
            onExport={onTranscriptExport}
            onRetry={onTranscriptRetry}
            onSave={onTranscriptSave}
            workspace={transcript}
          />
        )}
      </div>
    </div>
  );
}
