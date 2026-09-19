import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ConnectionCard,
  JobStatus,
  ResourceEmptyState,
  WorkflowRoute,
  getPlatformMetadata,
} from '../../apps/web/src/components/patterns/index';

describe('web domain patterns', () => {
  it('keeps provider display metadata separate from the generic connection card', () => {
    const metadata = getPlatformMetadata('youtube');
    const fallback = getPlatformMetadata('custom_provider');
    const markup = renderToStaticMarkup(
      createElement(ConnectionCard, {
        externalId: 'channel-123',
        name: 'Creator channel',
        platform: metadata.id,
        status: 'connected',
      }),
    );

    expect(metadata).toEqual({ id: 'youtube', label: 'YouTube', mark: 'YT' });
    expect(fallback).toEqual({ id: 'custom_provider', label: 'Custom Provider', mark: 'CP' });
    expect(markup).toContain('Creator channel');
    expect(markup).toContain('channel-123');
    expect(markup).toContain('Connected');
    expect(markup).toContain('YT');
    expect(markup).toContain('var(--or-status-success-bg)');
  });

  it.each([
    ['pending', 'Pending', '--or-status-neutral-bg'],
    ['running', 'Running', '--or-status-info-bg'],
    ['waiting', 'Waiting', '--or-status-warning-bg'],
    ['retrying', 'Retrying', '--or-status-warning-bg'],
    ['succeeded', 'Succeeded', '--or-status-success-bg'],
    ['failed', 'Failed', '--or-status-danger-bg'],
    ['cancelled', 'Cancelled', '--or-status-neutral-bg'],
  ])('maps the %s job state to a named semantic treatment', (status, label, token) => {
    const markup = renderToStaticMarkup(createElement(JobStatus, { status }));

    expect(markup).toContain(label);
    expect(markup).toContain(token);
  });

  it('renders the route topology as a read-only source, stage, and destination branch', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkflowRoute, {
        destinations: [
          { kind: 'destination', label: 'Creator channel', platform: 'youtube' },
          { kind: 'destination', label: '@creator', platform: 'tiktok' },
        ],
        source: { kind: 'source', label: 'Incoming renders', platform: 'local' },
        stages: [{ kind: 'filter', label: 'MP4 only' }],
      }),
    );

    expect(markup).toContain('aria-label="Workflow route"');
    expect(markup).toContain('aria-label="Destinations"');
    expect(markup).toContain('Incoming renders');
    expect(markup).toContain('MP4 only');
    expect(markup).toContain('Creator channel');
    expect(markup).toContain('@creator');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<canvas');
  });

  it('shows an explicit destination requirement when a route is incomplete', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkflowRoute, {
        destinations: [],
        source: { kind: 'source', label: 'Watched folder', platform: 'local' },
      }),
    );

    expect(markup).toContain('Destination required');
    expect(markup).toContain('>disabled<');
    expect(markup).toContain('var(--or-route-disabled)');
  });

  it('composes a domain empty state from the shared panel primitive', () => {
    const markup = renderToStaticMarkup(
      createElement(ResourceEmptyState, {
        description: 'Create a workflow to begin routing media.',
        title: 'No saved workflows',
      }),
    );

    expect(markup).toContain('<section');
    expect(markup).toContain('No saved workflows');
    expect(markup).toContain('Create a workflow to begin routing media.');
    expect(markup).toContain('var(--or-empty-state-max-width)');
  });
});
