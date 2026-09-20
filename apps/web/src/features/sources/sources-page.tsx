import type { FormEventHandler, MouseEvent } from 'react';

import { PlatformSectionHeader, ResourceEmptyState, SourceStatus } from '../../components/patterns';
import {
  Alert,
  Badge,
  Button,
  FormField,
  Input,
  Panel,
  Select,
  Spinner,
} from '../../components/ui';
import type { BadgeVariant } from '../../components/ui';

export interface SourceAccountView {
  readonly displayName: string;
  readonly id: string;
  readonly provider: string;
  readonly status: string;
}

export interface SourceItemView {
  readonly cleanupStatus?: string;
  readonly externalId: string;
  readonly id: string;
  readonly lifecycleStatus: string;
  readonly metadata: { readonly title?: string };
  readonly resolutionStatus: string;
}

export interface SourceConnectionView {
  readonly adapterId: string;
  readonly displayName: string;
  readonly id: string;
  readonly lastPollAt?: string;
  readonly lastPollErrorCode?: string;
  readonly lastPollErrorMessage?: string;
  readonly lastSuccessfulPollAt?: string;
  readonly status: string;
}

export interface SourcesPageProps {
  readonly accounts: readonly SourceAccountView[];
  readonly activeAction: string | undefined;
  readonly draft: {
    readonly accountId: string;
    readonly channelId: string;
    readonly displayName: string;
  };
  readonly error: string | undefined;
  readonly isLoading: boolean;
  readonly itemsBySource: Readonly<Record<string, readonly SourceItemView[]>>;
  readonly onAccountIdChange: (value: string) => void;
  readonly onAddSource: FormEventHandler<HTMLFormElement>;
  readonly onChannelIdChange: (value: string) => void;
  readonly onDisplayNameChange: (value: string) => void;
  readonly onNavigateAccounts: (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly onRetry: () => void;
  readonly onSourceAction: (sourceId: string, action: 'pause' | 'poll' | 'resume') => void;
  readonly sources: readonly SourceConnectionView[];
}

function formatTimestamp(value: string | undefined): string {
  if (value === undefined) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Timestamp unavailable';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function humanizeStatus(value: string): string {
  const label = value
    .trim()
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  return label || 'Unknown';
}

function stateVariant(kind: 'cleanup' | 'lifecycle' | 'resolution', state: string): BadgeVariant {
  const normalized = state.trim().toLowerCase();
  if (
    (kind === 'resolution' && normalized === 'ready') ||
    (kind === 'lifecycle' && (normalized === 'published' || normalized === 'completed')) ||
    (kind === 'cleanup' && normalized === 'completed')
  )
    return 'success';

  if (
    normalized === 'failed' ||
    normalized === 'partial_failure' ||
    (kind === 'resolution' && normalized === 'unavailable')
  )
    return normalized === 'unavailable' ? 'warning' : 'error';

  if (
    normalized === 'resolving' ||
    normalized === 'processing' ||
    normalized === 'publishing' ||
    normalized === 'running' ||
    normalized === 'scheduled' ||
    normalized === 'eligible'
  )
    return 'info';

  if (normalized === 'queued' || normalized === 'retrying' || normalized === 'cleanup_pending') {
    return 'warning';
  }
  return 'neutral';
}

function ItemStateBadge({
  kind,
  state,
}: {
  readonly kind: 'cleanup' | 'lifecycle' | 'resolution';
  readonly state: string;
}) {
  return (
    <Badge variant={stateVariant(kind, state)}>
      {humanizeStatus(kind)} · {humanizeStatus(state)}
    </Badge>
  );
}

function SourceItem({ item }: { readonly item: SourceItemView }) {
  const title = item.metadata.title?.trim() || item.externalId.trim() || 'Untitled source item';

  return (
    <article className="rounded-[var(--or-radius-sm)] border border-[var(--or-border-subtle)] bg-[var(--or-bg-surface)] p-[var(--or-pane-padding-compact)]">
      <div className="min-w-0">
        <h4 className="break-words font-medium text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
          {title}
        </h4>
        {item.metadata.title !== undefined && (
          <p className="mt-[var(--or-space-1)] break-all font-mono text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
            <span translate="no">{item.externalId}</span>
          </p>
        )}
      </div>
      <div
        aria-label="Source item states"
        className="mt-[var(--or-space-3)] flex flex-wrap gap-[var(--or-space-2)]"
      >
        <ItemStateBadge kind="resolution" state={item.resolutionStatus} />
        <ItemStateBadge kind="lifecycle" state={item.lifecycleStatus} />
        <ItemStateBadge kind="cleanup" state={item.cleanupStatus ?? 'not_eligible'} />
      </div>
      {item.resolutionStatus === 'unavailable' && (
        <Alert className="mt-[var(--or-space-3)]" title="Local original required" variant="warning">
          This item cannot be resolved automatically. Link an authorized local original;
          OpenRepurpose will not download protected or unauthorized content.
        </Alert>
      )}
    </article>
  );
}

function SourceConnection({
  activeAction,
  items,
  onAction,
  source,
}: {
  readonly activeAction: string | undefined;
  readonly items: readonly SourceItemView[];
  readonly onAction: SourcesPageProps['onSourceAction'];
  readonly source: SourceConnectionView;
}) {
  const toggleAction = source.status === 'active' ? 'pause' : 'resume';
  const isPolling = activeAction === `poll:${source.id}`;
  const isToggling = activeAction === `${toggleAction}:${source.id}`;
  const hasActiveAction = activeAction !== undefined;
  const headingId = `source-${source.id}`;

  return (
    <Panel aria-labelledby={headingId} padding="none" surface="surface">
      <PlatformSectionHeader
        className="border-b border-[var(--or-border-subtle)] p-[var(--or-pane-padding)]"
        description={<SourceStatus status={source.status} />}
        headingId={headingId}
        headingLevel={3}
        platform={source.adapterId}
        title={source.displayName.trim() || 'Unnamed source'}
        trailing={
          <div className="flex flex-wrap gap-[var(--or-space-2)]">
            <Button
              disabled={hasActiveAction && !isPolling}
              isLoading={isPolling}
              loadingLabel="Polling…"
              onClick={() => onAction(source.id, 'poll')}
              size="sm"
              variant="primary"
            >
              Poll now
            </Button>
            <Button
              disabled={hasActiveAction && !isToggling}
              isLoading={isToggling}
              loadingLabel={toggleAction === 'pause' ? 'Pausing…' : 'Resuming…'}
              onClick={() => onAction(source.id, toggleAction)}
              size="sm"
              variant="secondary"
            >
              {toggleAction === 'pause' ? 'Pause' : 'Resume'}
            </Button>
          </div>
        }
      />

      <dl className="grid gap-[var(--or-space-3)] border-b border-[var(--or-border-subtle)] px-[var(--or-pane-padding)] py-[var(--or-space-3)] sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-medium text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
            Last successful poll
          </dt>
          <dd className="mt-[var(--or-space-1)] text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
            {formatTimestamp(source.lastSuccessfulPollAt)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-medium text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
            Last poll attempt
          </dt>
          <dd className="mt-[var(--or-space-1)] text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
            {formatTimestamp(source.lastPollAt)}
          </dd>
        </div>
      </dl>

      {source.lastPollErrorMessage !== undefined && (
        <Alert
          className="mx-[var(--or-pane-padding)] mt-[var(--or-space-4)]"
          title="Last poll failed"
          variant="error"
        >
          {source.lastPollErrorCode !== undefined && (
            <code className="font-mono" translate="no">
              {source.lastPollErrorCode}:{' '}
            </code>
          )}
          {source.lastPollErrorMessage}
        </Alert>
      )}

      <section aria-labelledby={`${headingId}-items`} className="p-[var(--or-pane-padding)]">
        <div className="flex flex-wrap items-center justify-between gap-[var(--or-space-2)]">
          <h4
            className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]"
            id={`${headingId}-items`}
          >
            Observed items
          </h4>
          <Badge variant="neutral">{items.length}</Badge>
        </div>
        {items.length === 0 ? (
          <p className="mt-[var(--or-space-3)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
            No media has been observed from this source yet.
          </p>
        ) : (
          <div className="mt-[var(--or-space-3)] grid gap-[var(--or-space-2)]">
            {items.map((item) => (
              <SourceItem item={item} key={item.id} />
            ))}
          </div>
        )}
      </section>
    </Panel>
  );
}

export function SourcesPage({
  accounts,
  activeAction,
  draft,
  error,
  isLoading,
  itemsBySource,
  onAccountIdChange,
  onAddSource,
  onChannelIdChange,
  onDisplayNameChange,
  onNavigateAccounts,
  onRetry,
  onSourceAction,
  sources,
}: SourcesPageProps) {
  const youtubeAccounts = accounts.filter(
    (account) => account.provider === 'youtube' && account.status === 'connected',
  );

  return (
    <div aria-busy={isLoading || undefined} className="space-y-[var(--or-setup-section-gap)]">
      {error !== undefined && (
        <Alert
          action={
            <Button onClick={onRetry} size="sm" variant="secondary">
              Reload sources
            </Button>
          }
          title="Source action unavailable"
          variant="error"
        >
          {error}
        </Alert>
      )}

      <Panel aria-labelledby="add-source-title" padding="setup" surface="surface">
        <PlatformSectionHeader
          description="Detection uses the official YouTube Data API uploads playlist. It observes metadata and does not download video bytes."
          headingId="add-source-title"
          platform="youtube"
          title="Add a YouTube upload source"
        />

        {youtubeAccounts.length === 0 && !isLoading && (
          <Alert
            className="mt-[var(--or-space-5)]"
            title="YouTube account required"
            variant="warning"
          >
            Connect an authorized YouTube account before adding a remote source.{' '}
            <a
              className="font-medium text-[var(--or-text-link)] underline decoration-[var(--or-border-selected)] underline-offset-4"
              href="/accounts"
              onClick={onNavigateAccounts}
            >
              Open accounts
            </a>
            .
          </Alert>
        )}

        <form className="mt-[var(--or-space-5)]" onSubmit={onAddSource}>
          <div className="grid gap-[var(--or-field-group-gap)] lg:grid-cols-2">
            <FormField label="Connected YouTube account" required>
              <Select
                disabled={isLoading || activeAction !== undefined || youtubeAccounts.length === 0}
                name="source-account-id"
                onChange={(event) => onAccountIdChange(event.target.value)}
                value={draft.accountId}
              >
                <option value="">
                  {isLoading ? 'Loading connected accounts…' : 'Select a connected account'}
                </option>
                {youtubeAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName.trim() || 'Unnamed account'}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="YouTube channel ID" required>
              <Input
                autoComplete="off"
                disabled={isLoading || activeAction !== undefined}
                name="source-channel-id"
                onChange={(event) => onChannelIdChange(event.target.value)}
                placeholder="Example: UC…"
                spellCheck={false}
                value={draft.channelId}
              />
            </FormField>
            <FormField
              className="lg:col-span-2"
              description="Leave blank to use the channel ID as the local source name."
              label="Local display name (optional)"
            >
              <Input
                disabled={isLoading || activeAction !== undefined}
                name="source-display-name"
                onChange={(event) => onDisplayNameChange(event.target.value)}
                placeholder="Example: Workshop uploads"
                value={draft.displayName}
              />
            </FormField>
          </div>
          <Button
            className="mt-[var(--or-space-4)]"
            disabled={isLoading || activeAction !== undefined || youtubeAccounts.length === 0}
            isLoading={activeAction === 'add'}
            loadingLabel="Adding source…"
            type="submit"
            variant="primary"
          >
            Add source
          </Button>
        </form>
      </Panel>

      <section aria-labelledby="source-connections-title">
        <div className="flex flex-wrap items-end justify-between gap-[var(--or-space-3)]">
          <div>
            <h2
              className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
              id="source-connections-title"
            >
              Source connections
            </h2>
            <p className="mt-[var(--or-space-1)] text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
              Polling health and observed media from authorized remote channels.
            </p>
          </div>
          {!isLoading && <Badge variant="neutral">{sources.length}</Badge>}
        </div>

        {isLoading ? (
          <Panel
            aria-live="polite"
            className="mt-[var(--or-space-4)]"
            padding="default"
            role="status"
            surface="surface"
          >
            <div className="flex items-center gap-[var(--or-space-3)]">
              <Spinner size="sm" />
              <div>
                <p className="font-semibold text-[var(--or-text-primary)]">
                  Loading source connections…
                </p>
                <p className="mt-[var(--or-space-1)] text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
                  Reading polling state and observed media from this installation.
                </p>
              </div>
            </div>
          </Panel>
        ) : sources.length === 0 ? (
          <ResourceEmptyState
            className="mt-[var(--or-space-4)]"
            description="Add an authorized remote channel above to begin observing media for workflows."
            title="No remote sources"
          />
        ) : (
          <div className="mt-[var(--or-space-4)] grid gap-[var(--or-space-4)]">
            {sources.map((source) => (
              <SourceConnection
                activeAction={activeAction}
                items={itemsBySource[source.id] ?? []}
                key={source.id}
                onAction={onSourceAction}
                source={source}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
