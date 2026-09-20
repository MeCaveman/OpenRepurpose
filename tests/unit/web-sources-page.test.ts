import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SourcesPage } from '../../apps/web/src/features/sources/index';
import type { SourcesPageProps } from '../../apps/web/src/features/sources/index';

function sourcesProps(overrides: Partial<SourcesPageProps> = {}): SourcesPageProps {
  return {
    accounts: [
      {
        displayName: 'Workshop Channel',
        id: 'account-1',
        provider: 'youtube',
        status: 'connected',
      },
    ],
    activeAction: undefined,
    draft: { accountId: '', channelId: '', displayName: '' },
    error: undefined,
    isLoading: false,
    itemsBySource: {},
    onAccountIdChange: () => undefined,
    onAddSource: () => undefined,
    onChannelIdChange: () => undefined,
    onDisplayNameChange: () => undefined,
    onNavigateAccounts: () => undefined,
    onRetry: () => undefined,
    onSourceAction: () => undefined,
    sources: [],
    ...overrides,
  };
}

describe('web sources page', () => {
  it('uses labeled token-backed controls for the current YouTube source contract', () => {
    const markup = renderToStaticMarkup(createElement(SourcesPage, sourcesProps()));

    expect(markup).toContain('Add a YouTube upload source');
    expect(markup).toContain('name="source-account-id"');
    expect(markup).toContain('name="source-channel-id"');
    expect(markup).toContain('name="source-display-name"');
    expect(markup).toContain('Workshop Channel');
    expect(markup).toContain('official YouTube Data API uploads playlist');
    expect(markup).not.toMatch(/(?:slate|cyan|emerald|rose|amber)-/);
  });

  it('presents polling health and observed lifecycle states as structured source data', () => {
    const props = sourcesProps({
      itemsBySource: {
        'source-1': [
          {
            cleanupStatus: 'not_eligible',
            externalId: 'video-1',
            id: 'item-1',
            lifecycleStatus: 'observed',
            metadata: { title: 'Workshop introduction' },
            resolutionStatus: 'unavailable',
          },
        ],
      },
      sources: [
        {
          adapterId: 'youtube',
          displayName: 'Workshop uploads',
          id: 'source-1',
          lastPollAt: '2026-01-02T13:00:00.000Z',
          lastSuccessfulPollAt: '2026-01-02T12:00:00.000Z',
          status: 'active',
        },
      ],
    });
    const markup = renderToStaticMarkup(createElement(SourcesPage, props));

    expect(markup).toContain('Workshop uploads');
    expect(markup).toContain('>Active<');
    expect(markup).toContain('Last successful poll');
    expect(markup).toContain('Workshop introduction');
    expect(markup).toContain('Resolution · Unavailable');
    expect(markup).toContain('Lifecycle · Observed');
    expect(markup).toContain('Cleanup · Not Eligible');
    expect(markup).toContain('Local original required');
    expect(markup).not.toContain('2026-01-02T12:00:00.000Z');
  });

  it('distinguishes local loading, request progress, poll failure, and empty item states', () => {
    const loadingMarkup = renderToStaticMarkup(
      createElement(SourcesPage, sourcesProps({ isLoading: true })),
    );
    expect(loadingMarkup).toContain('role="status"');
    expect(loadingMarkup).toContain('Loading source connections…');
    expect(loadingMarkup).not.toContain('No remote sources');

    const source = {
      adapterId: 'youtube',
      displayName: 'Paused source',
      id: 'source-2',
      lastPollErrorCode: 'AUTH_EXPIRED',
      lastPollErrorMessage: 'Reconnect the account.',
      status: 'paused',
    };
    const progressMarkup = renderToStaticMarkup(
      createElement(
        SourcesPage,
        sourcesProps({ activeAction: 'poll:source-2', sources: [source] }),
      ),
    );
    expect(progressMarkup).toContain('Polling…');
    expect(progressMarkup).toContain('aria-busy="true"');
    expect(progressMarkup).toContain('>Paused<');
    expect(progressMarkup).toContain('Last poll failed');
    expect(progressMarkup).toContain('AUTH_EXPIRED');
    expect(progressMarkup).toContain('No media has been observed from this source yet.');

    const errorMarkup = renderToStaticMarkup(
      createElement(SourcesPage, sourcesProps({ error: 'Source service is unavailable.' })),
    );
    expect(errorMarkup).toContain('Reload sources');
  });

  it('provides recovery when no connected YouTube account or source exists', () => {
    const markup = renderToStaticMarkup(createElement(SourcesPage, sourcesProps({ accounts: [] })));

    expect(markup).toContain('YouTube account required');
    expect(markup).toContain('href="/accounts"');
    expect(markup).toContain('No remote sources');
    expect(markup).toContain('disabled=""');
  });
});
