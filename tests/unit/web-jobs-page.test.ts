import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { JobsPage } from '../../apps/web/src/features/jobs/index';
import type { JobView, JobsPageProps } from '../../apps/web/src/features/jobs/index';

const retryingJob: JobView = {
  attemptCount: 1,
  createdAt: '2026-09-18T12:00:00.000Z',
  destination: {
    destinationId: 'youtube',
    remoteId: 'remote-1',
    remoteStatus: 'processing',
    uploadedBytes: 1_572_864,
  },
  id: 'job-1',
  lastErrorCode: 'REMOTE_PROCESSING',
  lastErrorMessage: 'The platform is still processing this upload.',
  maxAttempts: 3,
  status: 'retrying',
  type: 'youtube.upload',
};

function jobsProps(overrides: Partial<JobsPageProps> = {}): JobsPageProps {
  return {
    activeAction: undefined,
    attempts: [],
    error: undefined,
    isDetailLoading: false,
    isLoading: false,
    jobs: [],
    onCancelJob: () => undefined,
    onCloseDetails: () => undefined,
    onSelectJob: () => undefined,
    selectedJob: undefined,
    selectedJobId: undefined,
    ...overrides,
  };
}

describe('web jobs page', () => {
  it('renders the persisted execution ledger with semantic job and destination state', () => {
    const markup = renderToStaticMarkup(
      createElement(JobsPage, jobsProps({ jobs: [retryingJob] })),
    );

    expect(markup).toContain('Execution ledger');
    expect(markup).toContain('youtube.upload');
    expect(markup).toContain('>Retrying<');
    expect(markup).toContain('REMOTE_PROCESSING');
    expect(markup).toContain('youtube · processing');
    expect(markup).toContain('1.50 MB');
    expect(markup).toContain('remote-1');
    expect(markup).toContain('1/3');
    expect(markup).toContain('1 job');
    expect(markup).toContain('translate="no"');
    expect(markup).not.toMatch(/(?:slate|cyan|emerald|rose|amber|fuchsia)-/);
  });

  it('shows a selected job as a contextual attempt-history surface', () => {
    const markup = renderToStaticMarkup(
      createElement(
        JobsPage,
        jobsProps({
          attempts: [
            {
              attemptNumber: 1,
              errorCode: 'REMOTE_PROCESSING',
              errorMessage: 'The platform is still processing this upload.',
              finishedAt: '2026-09-18T12:02:00.000Z',
              startedAt: '2026-09-18T12:01:00.000Z',
              status: 'failed',
            },
          ],
          jobs: [retryingJob],
          selectedJob: retryingJob,
          selectedJobId: retryingJob.id,
        }),
      ),
    );

    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('Attempt history');
    expect(markup).toContain('Attempt 1');
    expect(markup).toContain('>Failed<');
    expect(markup).toContain('Destination checkpoint');
    expect(markup).toContain('Close details');
    expect(markup).not.toContain('#1 · failed');
  });

  it('distinguishes list loading, detail loading, errors, and empty history', () => {
    const loadingMarkup = renderToStaticMarkup(
      createElement(JobsPage, jobsProps({ isLoading: true })),
    );
    expect(loadingMarkup).toContain('role="status"');
    expect(loadingMarkup).toContain('Loading job history…');
    expect(loadingMarkup).not.toContain('No queued jobs');

    const detailLoadingMarkup = renderToStaticMarkup(
      createElement(
        JobsPage,
        jobsProps({
          isDetailLoading: true,
          jobs: [retryingJob],
          selectedJob: retryingJob,
          selectedJobId: retryingJob.id,
        }),
      ),
    );
    expect(detailLoadingMarkup).toContain('Loading attempts…');
    expect(detailLoadingMarkup).not.toContain('No attempts');

    const emptyMarkup = renderToStaticMarkup(createElement(JobsPage, jobsProps()));
    expect(emptyMarkup).toContain('No queued jobs');
    expect(emptyMarkup).toContain('0 jobs');

    const errorMarkup = renderToStaticMarkup(
      createElement(JobsPage, jobsProps({ error: 'Job history is unavailable.' })),
    );
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain('Job request failed');
  });

  it('keeps cancellation progress and persisted requests distinct', () => {
    const activeMarkup = renderToStaticMarkup(
      createElement(JobsPage, jobsProps({ activeAction: 'cancel:job-1', jobs: [retryingJob] })),
    );
    expect(activeMarkup).toContain('aria-busy="true"');
    expect(activeMarkup).toContain('Cancelling…');

    const requestedMarkup = renderToStaticMarkup(
      createElement(
        JobsPage,
        jobsProps({
          jobs: [{ ...retryingJob, cancellationRequestedAt: '2026-09-18T12:03:00.000Z' }],
        }),
      ),
    );
    expect(requestedMarkup).toContain('Cancellation requested');
    expect(requestedMarkup).toContain('disabled=""');
  });
});
