import { useEffect, useState } from 'react';

import { getCsrfToken } from '../../lib/local-api';
import { JobsPage } from './jobs-page';
import type { JobAttemptView, JobView } from './jobs-page';

export function JobsRoute() {
  const [jobs, setJobs] = useState<readonly JobView[]>([]);
  const [attempts, setAttempts] = useState<readonly JobAttemptView[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [selectedJob, setSelectedJob] = useState<JobView>();
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string>();
  const [error, setError] = useState<string>();

  const loadJobs = async () => {
    const response = await fetch('/api/jobs');
    if (!response.ok) throw new Error('Job history is unavailable.');
    const body = (await response.json()) as { jobs: readonly JobView[] };
    setJobs(body.jobs);
    return body.jobs;
  };

  const showAttempts = async (jobId: string, knownJobs = jobs) => {
    setSelectedJobId(jobId);
    setSelectedJob(knownJobs.find((job) => job.id === jobId));
    setAttempts([]);
    setIsDetailLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (!response.ok) throw new Error('Job attempt history is unavailable.');
      const body = (await response.json()) as {
        attempts: readonly JobAttemptView[];
        destination?: JobView['destination'];
        job: JobView;
      };
      setSelectedJob({
        ...body.job,
        ...(body.destination === undefined ? {} : { destination: body.destination }),
      });
      setAttempts(body.attempts);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Job attempt history is unavailable.');
    } finally {
      setIsDetailLoading(false);
    }
  };

  const retryJobs = async () => {
    setError(undefined);
    setIsLoading(true);
    try {
      await loadJobs();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load jobs.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void retryJobs();
  }, []);

  const cancelJob = async (jobId: string) => {
    setError(undefined);
    setActiveAction(`cancel:${jobId}`);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': await getCsrfToken() },
      });
      if (!response.ok) throw new Error('Job cancellation failed.');
      const refreshedJobs = await loadJobs();
      if (selectedJobId === jobId) await showAttempts(jobId, refreshedJobs);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Job cancellation failed.');
    } finally {
      setActiveAction(undefined);
    }
  };

  return (
    <JobsPage
      activeAction={activeAction}
      attempts={attempts}
      error={error}
      isDetailLoading={isDetailLoading}
      isLoading={isLoading}
      jobs={jobs}
      onCancelJob={(jobId) => void cancelJob(jobId)}
      onCloseDetails={() => {
        setSelectedJobId(undefined);
        setSelectedJob(undefined);
        setAttempts([]);
      }}
      onRetry={() => void retryJobs()}
      onSelectJob={(jobId) => void showAttempts(jobId)}
      selectedJob={selectedJob}
      selectedJobId={selectedJobId}
    />
  );
}
