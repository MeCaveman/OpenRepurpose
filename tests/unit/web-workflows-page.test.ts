import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorkflowsPage } from '../../apps/web/src/features/workflows/index';
import type { WorkflowsPageProps } from '../../apps/web/src/features/workflows/index';

function workflowsProps(overrides: Partial<WorkflowsPageProps> = {}): WorkflowsPageProps {
  return {
    accounts: [
      {
        displayName: 'Workshop Channel',
        id: 'account-1',
        provider: 'youtube',
        status: 'connected',
      },
    ],
    error: undefined,
    isLoading: false,
    metaTargets: [],
    onCreateWorkflow: async () => undefined,
    onRetry: () => undefined,
    sources: [],
    workflows: [],
    ...overrides,
  };
}

describe('web workflows page', () => {
  it('uses the workbench route builder without exposing optional stages by default', () => {
    const markup = renderToStaticMarkup(createElement(WorkflowsPage, workflowsProps()));

    expect(markup).toContain('Route builder');
    expect(markup).toContain('Create a workflow');
    expect(markup).toContain('name="workflow-name"');
    expect(markup).toContain('name="workflow-source-directory"');
    expect(markup).toContain('name="workflow-watched-folder-preset"');
    expect(markup).toContain('OBS recording folder');
    expect(markup).toContain('OBS Replay Buffer folder');
    expect(markup).toContain('<details');
    expect(markup).not.toContain('<details open');
    expect(markup).toContain('Optional route stages');
    expect(markup).toContain('Route preview');
    expect(markup).toContain('aria-label="Workflow route"');
    expect(markup).not.toMatch(/(?:slate|cyan|emerald|rose|amber)-/);
  });

  it('shows persisted OBS source behavior in saved workflow routes', () => {
    const markup = renderToStaticMarkup(
      createElement(
        WorkflowsPage,
        workflowsProps({
          workflows: [
            {
              definition: {
                edges: [{ from: 'source', to: 'destination-1' }],
                schemaVersion: 1,
                steps: [
                  {
                    id: 'source',
                    kind: 'source',
                    sourceType: 'watched_folder',
                    watchedFolder: {
                      filenameMetadata: 'obs',
                      preset: 'obs_replay_buffer',
                      settleMs: 5_000,
                      sidecarMetadata: true,
                    },
                  },
                  {
                    id: 'destination-1',
                    kind: 'destination',
                    destination: {
                      accountId: 'account-1',
                      destinationId: 'youtube',
                      privacy: 'private',
                    },
                  },
                ],
              },
              destinations: [
                { accountId: 'account-1', destinationId: 'youtube', privacy: 'private' },
              ],
              enabled: true,
              id: 'workflow-obs',
              name: 'Replay saves',
              sourceDirectory: 'C:\\OBS\\Replay Buffer',
              titleTemplate: '{{source.title}}',
            },
          ],
        }),
      ),
    );

    expect(markup).toContain('OBS Replay Buffer folder');
    expect(markup).toContain('C:\\OBS\\Replay Buffer');
  });

  it('renders saved definitions as source-to-stage-to-destination routes', () => {
    const markup = renderToStaticMarkup(
      createElement(
        WorkflowsPage,
        workflowsProps({
          workflows: [
            {
              definition: {
                edges: [
                  { from: 'source', to: 'filter' },
                  { from: 'filter', to: 'schedule' },
                  { from: 'schedule', to: 'destination-1' },
                ],
                schemaVersion: 1,
                steps: [
                  { id: 'source', kind: 'source', sourceType: 'remote' },
                  { id: 'filter', kind: 'filter', filters: { titleContains: 'Workshop' } },
                  { id: 'schedule', kind: 'schedule', scheduleId: 'schedule-1' },
                  {
                    id: 'destination-1',
                    kind: 'destination',
                    destination: {
                      accountId: 'account-1',
                      destinationId: 'youtube',
                      privacy: 'private',
                    },
                  },
                ],
              },
              destinations: [
                { accountId: 'account-1', destinationId: 'youtube', privacy: 'private' },
              ],
              enabled: true,
              id: 'workflow-1',
              name: 'Workshop uploads',
              remoteSource: { connectionId: 'source-1' },
              sourceDirectory: '',
              titleTemplate: '{{file.stem}}',
            },
          ],
        }),
      ),
    );

    expect(markup).toContain('Workshop uploads');
    expect(markup).toContain('>Enabled<');
    expect(markup).toContain('source-1');
    expect(markup).toContain('>Filter<');
    expect(markup).toContain('>Schedule<');
    expect(markup).toContain('schedule-1');
    expect(markup).toContain('>YouTube<');
    expect(markup).toContain('1 workflow');
  });

  it('distinguishes loading, empty, and request-error states', () => {
    const loadingMarkup = renderToStaticMarkup(
      createElement(WorkflowsPage, workflowsProps({ isLoading: true })),
    );
    expect(loadingMarkup).toContain('role="status"');
    expect(loadingMarkup).toContain('Loading workflow routes…');
    expect(loadingMarkup).not.toContain('No saved workflows');

    const emptyMarkup = renderToStaticMarkup(createElement(WorkflowsPage, workflowsProps()));
    expect(emptyMarkup).toContain('No saved workflows');
    expect(emptyMarkup).toContain('0 workflows');

    const errorMarkup = renderToStaticMarkup(
      createElement(WorkflowsPage, workflowsProps({ error: 'Workflow list is unavailable.' })),
    );
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain('Workflow request failed');
    expect(errorMarkup).toContain('Workflow list is unavailable.');
    expect(errorMarkup).toContain('Reload workflow data');
  });

  it('offers only active remote sources in the current source selector', () => {
    const markup = renderToStaticMarkup(
      createElement(
        WorkflowsPage,
        workflowsProps({
          sources: [
            {
              displayName: 'Active uploads',
              id: 'source-1',
              status: 'active',
            },
            {
              displayName: 'Paused uploads',
              id: 'source-2',
              status: 'paused',
            },
          ],
        }),
      ),
    );

    expect(markup).toContain('Active uploads');
    expect(markup).not.toContain('Paused uploads');
  });
});
