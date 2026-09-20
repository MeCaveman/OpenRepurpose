import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { JobStatus, ResourceEmptyState } from '../../components/patterns';
import { Alert, Badge, Button, Panel, Spinner } from '../../components/ui';

export interface DestinationJobView {
  readonly destinationId: string;
  readonly remoteId?: string;
  readonly remoteStatus: string;
  readonly uploadedBytes: number;
}

export interface JobView {
  readonly accountId?: string;
  readonly attemptCount: number;
  readonly availableAt?: string;
  readonly cancellationRequestedAt?: string;
  readonly completedAt?: string;
  readonly createdAt?: string;
  readonly destination?: DestinationJobView;
  readonly id: string;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
  readonly maxAttempts: number;
  readonly platformId?: string;
  readonly status: string;
  readonly type: string;
  readonly updatedAt?: string;
}

export interface JobAttemptView {
  readonly attemptNumber: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly finishedAt?: string;
  readonly startedAt?: string;
  readonly status: string;
}

export interface JobsPageProps {
  readonly activeAction: string | undefined;
  readonly attempts: readonly JobAttemptView[];
  readonly error: string | undefined;
  readonly isDetailLoading: boolean;
  readonly isLoading: boolean;
  readonly jobs: readonly JobView[];
  readonly onCancelJob: (jobId: string) => void;
  readonly onCloseDetails: () => void;
  readonly onRetry: () => void;
  readonly onSelectJob: (jobId: string) => void;
  readonly selectedJob: JobView | undefined;
  readonly selectedJobId: string | undefined;
}

function formatTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Timestamp unavailable';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'No bytes uploaded';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** unitIndex;
  return `${amount.toFixed(unitIndex === 0 ? 0 : amount >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatAttemptCount(value: number): string {
  return Number.isFinite(value) && value >= 0 ? String(Math.floor(value)) : '—';
}

function canCancel(job: JobView): boolean {
  return job.status === 'pending' || job.status === 'retrying' || job.status === 'running';
}

function destinationStatusVariant(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'succeeded' || normalized === 'published') return 'success' as const;
  if (
    normalized === 'processing' ||
    normalized === 'publishing' ||
    normalized === 'uploading' ||
    normalized === 'verifying'
  ) {
    return 'info' as const;
  }
  if (normalized === 'failed' || normalized === 'unavailable') return 'error' as const;
  if (
    normalized === 'rate_limited' ||
    normalized === 'rate limited' ||
    normalized === 'retrying' ||
    normalized === 'waiting'
  ) {
    return 'warning' as const;
  }
  return 'neutral' as const;
}

function JobIdentity({
  job,
  onSelect,
  selected,
}: {
  readonly job: JobView;
  readonly onSelect: (jobId: string, trigger: HTMLButtonElement) => void;
  readonly selected: boolean;
}) {
  const createdAt = formatTimestamp(job.createdAt);

  return (
    <div className="min-w-0">
      <button
        aria-pressed={selected}
        className="min-h-[var(--or-target-min)] max-w-full rounded-[var(--or-radius-sm)] text-left text-[var(--or-text-link)] outline-none hover:underline focus-visible:outline-[var(--or-focus-width)] focus-visible:outline-offset-[var(--or-focus-offset)] focus-visible:[outline-color:var(--or-focus-ring)]"
        data-job-select={job.id}
        onClick={(event) => onSelect(job.id, event.currentTarget)}
        type="button"
      >
        <span className="block break-words font-semibold [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
          {job.type.trim() || 'Unknown job type'}
        </span>
        <span
          className="mt-[var(--or-space-1)] block break-all font-[family-name:var(--or-font-technical)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]"
          translate="no"
        >
          {job.id}
        </span>
      </button>
      {createdAt !== undefined && (
        <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
          Created {createdAt}
        </p>
      )}
      {job.lastErrorMessage !== undefined && (
        <p className="mt-[var(--or-space-2)] break-words text-[var(--or-status-danger-fg)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
          {job.lastErrorCode !== undefined && (
            <code className="font-[family-name:var(--or-font-technical)]" translate="no">
              {job.lastErrorCode}:{' '}
            </code>
          )}
          {job.lastErrorMessage}
        </p>
      )}
    </div>
  );
}

function DestinationCheckpoint({ destination }: { readonly destination: DestinationJobView }) {
  const destinationId = destination.destinationId.trim() || 'unknown destination';
  const remoteStatus = destination.remoteStatus.trim().replaceAll('_', ' ') || 'unknown status';

  return (
    <div className="mt-[var(--or-space-2)] flex flex-wrap items-center gap-[var(--or-space-2)]">
      <Badge variant={destinationStatusVariant(remoteStatus)}>
        {destinationId} · {remoteStatus}
      </Badge>
      <span className="text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
        {formatBytes(destination.uploadedBytes)}
      </span>
      {destination.remoteId !== undefined && (
        <code
          className="break-all font-[family-name:var(--or-font-technical)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)]"
          translate="no"
        >
          {destination.remoteId}
        </code>
      )}
    </div>
  );
}

function CancelAction({
  activeAction,
  job,
  onCancel,
}: {
  readonly activeAction: string | undefined;
  readonly job: JobView;
  readonly onCancel: JobsPageProps['onCancelJob'];
}) {
  if (!canCancel(job)) return <span className="text-[var(--or-text-disabled)]">—</span>;

  const isCancelling = activeAction === `cancel:${job.id}`;
  const cancellationRequested = job.cancellationRequestedAt !== undefined;
  const requestCancellation = () => {
    if (
      window.confirm(
        `Cancel ${job.type}? The current operation will stop at the next safe cancellation boundary.`,
      )
    ) {
      onCancel(job.id);
    }
  };

  return (
    <Button
      disabled={cancellationRequested}
      isLoading={isCancelling}
      loadingLabel="Cancelling…"
      onClick={requestCancellation}
      size="sm"
      variant="danger"
    >
      {cancellationRequested ? 'Cancellation requested' : 'Cancel'}
    </Button>
  );
}

function JobsTable({
  activeAction,
  jobs,
  onCancelJob,
  onSelectJob,
  selectedJobId,
}: Pick<JobsPageProps, 'activeAction' | 'jobs' | 'onCancelJob' | 'selectedJobId'> & {
  readonly onSelectJob: (jobId: string, trigger: HTMLButtonElement) => void;
}) {
  return (
    <Panel className="hidden overflow-x-auto md:block" padding="none">
      <table className="w-full text-left [font-size:var(--or-type-interface-size)]">
        <thead className="h-[var(--or-table-header-height)] bg-[var(--or-bg-workspace)] text-[var(--or-text-tertiary)]">
          <tr>
            <th className="px-[var(--or-table-cell-padding-inline)] font-medium" scope="col">
              Job
            </th>
            <th className="px-[var(--or-table-cell-padding-inline)] font-medium" scope="col">
              Status
            </th>
            <th className="px-[var(--or-table-cell-padding-inline)] font-medium" scope="col">
              Attempts
            </th>
            <th className="px-[var(--or-table-cell-padding-inline)] font-medium" scope="col">
              Action
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const selected = selectedJobId === job.id;
            return (
              <tr
                className={`border-t border-[var(--or-border-subtle)] align-top ${selected ? 'bg-[var(--or-bg-selected)]' : 'hover:bg-[var(--or-bg-hover)]'}`}
                key={job.id}
              >
                <td className="px-[var(--or-table-cell-padding-inline)] py-[var(--or-space-3)]">
                  <JobIdentity job={job} onSelect={onSelectJob} selected={selected} />
                  {job.destination !== undefined && (
                    <DestinationCheckpoint destination={job.destination} />
                  )}
                </td>
                <td className="px-[var(--or-table-cell-padding-inline)] py-[var(--or-space-3)]">
                  <JobStatus status={job.status} />
                </td>
                <td className="px-[var(--or-table-cell-padding-inline)] py-[var(--or-space-3)] font-[family-name:var(--or-font-technical)] text-[var(--or-text-secondary)] tabular-nums">
                  {formatAttemptCount(job.attemptCount)}/{formatAttemptCount(job.maxAttempts)}
                </td>
                <td className="px-[var(--or-table-cell-padding-inline)] py-[var(--or-space-3)]">
                  <CancelAction activeAction={activeAction} job={job} onCancel={onCancelJob} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function JobsList({
  activeAction,
  jobs,
  onCancelJob,
  onSelectJob,
  selectedJobId,
}: Pick<JobsPageProps, 'activeAction' | 'jobs' | 'onCancelJob' | 'selectedJobId'> & {
  readonly onSelectJob: (jobId: string, trigger: HTMLButtonElement) => void;
}) {
  return (
    <div className="grid gap-[var(--or-space-3)] md:hidden">
      {jobs.map((job) => {
        const selected = selectedJobId === job.id;
        return (
          <Panel
            className={
              selected ? 'border-[var(--or-border-selected)] bg-[var(--or-bg-selected)]' : ''
            }
            key={job.id}
          >
            <div className="flex items-start justify-between gap-[var(--or-space-3)]">
              <JobIdentity job={job} onSelect={onSelectJob} selected={selected} />
              <JobStatus status={job.status} />
            </div>
            {job.destination !== undefined && (
              <DestinationCheckpoint destination={job.destination} />
            )}
            <div className="mt-[var(--or-space-4)] flex flex-wrap items-center justify-between gap-[var(--or-space-3)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-3)]">
              <span className="font-[family-name:var(--or-font-technical)] text-[var(--or-text-tertiary)] tabular-nums [font-size:var(--or-type-metadata-size)]">
                {formatAttemptCount(job.attemptCount)}/{formatAttemptCount(job.maxAttempts)}{' '}
                attempts
              </span>
              <CancelAction activeAction={activeAction} job={job} onCancel={onCancelJob} />
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

function AttemptHistory({
  attempts,
  isLoading,
  job,
  headingRef,
  onClose,
}: {
  readonly attempts: readonly JobAttemptView[];
  readonly isLoading: boolean;
  readonly job: JobView | undefined;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onClose: () => void;
}) {
  return (
    <Panel
      aria-labelledby="attempt-history-heading"
      className="xl:sticky xl:top-[var(--or-space-4)]"
    >
      <header className="flex items-start justify-between gap-[var(--or-space-3)]">
        <div className="min-w-0">
          <h3
            className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
            id="attempt-history-heading"
            ref={headingRef}
            tabIndex={-1}
          >
            Attempt history
          </h3>
          {job !== undefined && (
            <p
              className="mt-[var(--or-space-1)] break-all font-[family-name:var(--or-font-technical)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]"
              translate="no"
            >
              {job.id}
            </p>
          )}
        </div>
        <Button onClick={onClose} size="sm" variant="ghost">
          Close details
        </Button>
      </header>

      {job !== undefined && (
        <div className="mt-[var(--or-space-4)] flex flex-wrap items-center gap-[var(--or-space-2)]">
          <JobStatus status={job.status} />
          <span className="break-words text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)]">
            {job.type}
          </span>
        </div>
      )}

      {isLoading ? (
        <div
          aria-live="polite"
          className="mt-[var(--or-space-5)] flex items-center gap-[var(--or-space-3)]"
          role="status"
        >
          <Spinner />
          <span className="[font-size:var(--or-type-interface-size)]">Loading attempts…</span>
        </div>
      ) : attempts.length === 0 ? (
        <ResourceEmptyState
          className="mt-[var(--or-space-5)]"
          description="Attempt details will appear when the selected job begins processing."
          title="No attempts"
        />
      ) : (
        <ol className="mt-[var(--or-space-5)] border-y border-[var(--or-border-subtle)]">
          {attempts.map((attempt) => {
            const startedAt = formatTimestamp(attempt.startedAt);
            const finishedAt = formatTimestamp(attempt.finishedAt);
            return (
              <li
                className="grid gap-[var(--or-space-2)] border-b border-[var(--or-border-subtle)] py-[var(--or-space-3)] last:border-b-0"
                key={attempt.attemptNumber}
              >
                <div className="flex flex-wrap items-center justify-between gap-[var(--or-space-2)]">
                  <span className="font-[family-name:var(--or-font-technical)] font-semibold text-[var(--or-text-secondary)] tabular-nums [font-size:var(--or-type-interface-size)]">
                    Attempt {attempt.attemptNumber}
                  </span>
                  <JobStatus status={attempt.status} />
                </div>
                {(startedAt !== undefined || finishedAt !== undefined) && (
                  <p className="text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
                    {startedAt === undefined ? 'Start time unavailable' : `Started ${startedAt}`}
                    {finishedAt === undefined ? '' : ` · Finished ${finishedAt}`}
                  </p>
                )}
                {attempt.errorMessage !== undefined && (
                  <p className="break-words text-[var(--or-status-danger-fg)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
                    {attempt.errorCode !== undefined && (
                      <code className="font-[family-name:var(--or-font-technical)]" translate="no">
                        {attempt.errorCode}:{' '}
                      </code>
                    )}
                    {attempt.errorMessage}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {job?.destination !== undefined && (
        <div className="mt-[var(--or-space-5)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-4)]">
          <h4 className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)]">
            Destination checkpoint
          </h4>
          <DestinationCheckpoint destination={job.destination} />
        </div>
      )}
    </Panel>
  );
}

export function JobsPage({
  activeAction,
  attempts,
  error,
  isDetailLoading,
  isLoading,
  jobs,
  onCancelJob,
  onCloseDetails,
  onRetry,
  onSelectJob,
  selectedJob,
  selectedJobId,
}: JobsPageProps) {
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailTriggerRef = useRef<{
    readonly element: HTMLButtonElement;
    readonly jobId: string;
  } | null>(null);

  useEffect(() => {
    if (selectedJobId !== undefined) {
      requestAnimationFrame(() => detailHeadingRef.current?.focus());
    }
  }, [selectedJobId]);

  const selectJob = (jobId: string, trigger: HTMLButtonElement) => {
    detailTriggerRef.current = { element: trigger, jobId };
    onSelectJob(jobId);
  };

  const closeDetails = () => {
    onCloseDetails();
    requestAnimationFrame(() => {
      const previousTrigger = detailTriggerRef.current;
      if (previousTrigger === null) return;
      const visibleTrigger = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-job-select]'),
      ].find(
        (candidate) =>
          candidate.dataset.jobSelect === previousTrigger.jobId &&
          candidate.getClientRects().length > 0,
      );
      (visibleTrigger ?? previousTrigger.element).focus();
    });
  };

  return (
    <div aria-busy={isLoading || undefined} className="grid gap-[var(--or-space-6)]">
      {error !== undefined && (
        <Alert
          action={
            <Button onClick={onRetry} size="sm" variant="secondary">
              Reload jobs
            </Button>
          }
          title="Job request failed"
          variant="error"
        >
          {error}
        </Alert>
      )}

      <section aria-labelledby="execution-ledger-heading">
        <header className="mb-[var(--or-space-4)] flex flex-wrap items-end justify-between gap-[var(--or-space-3)]">
          <div>
            <p className="font-[family-name:var(--or-font-technical)] font-semibold tracking-[var(--or-type-eyebrow-tracking)] text-[var(--or-text-accent)] uppercase [font-size:var(--or-type-eyebrow-size)] [line-height:var(--or-type-eyebrow-line)]">
              Local activity
            </p>
            <h2
              className="mt-[var(--or-space-1)] font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
              id="execution-ledger-heading"
            >
              Execution ledger
            </h2>
            <p className="mt-[var(--or-space-2)] text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
              Review persisted work, destination processing, attempts, and actionable failures.
            </p>
          </div>
          {!isLoading && (
            <Badge variant="neutral">
              {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
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
            <p className="[font-size:var(--or-type-interface-size)]">Loading job history…</p>
          </Panel>
        ) : jobs.length === 0 ? (
          <ResourceEmptyState
            description="Jobs will appear here when a workflow or direct publish operation is queued."
            title="No queued jobs"
          />
        ) : (
          <div
            className={`grid items-start gap-[var(--or-space-5)] ${selectedJobId === undefined ? '' : 'xl:grid-cols-[minmax(0,1fr)_var(--or-shell-inspector-width)]'}`}
          >
            <div className={`min-w-0 ${selectedJobId === undefined ? '' : 'hidden xl:block'}`}>
              <JobsTable
                activeAction={activeAction}
                jobs={jobs}
                onCancelJob={onCancelJob}
                onSelectJob={selectJob}
                selectedJobId={selectedJobId}
              />
              <JobsList
                activeAction={activeAction}
                jobs={jobs}
                onCancelJob={onCancelJob}
                onSelectJob={selectJob}
                selectedJobId={selectedJobId}
              />
            </div>
            {selectedJobId !== undefined && (
              <AttemptHistory
                attempts={attempts}
                headingRef={detailHeadingRef}
                isLoading={isDetailLoading}
                job={selectedJob}
                onClose={closeDetails}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}
