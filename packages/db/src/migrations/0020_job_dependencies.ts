import type { Migration } from './types.js';

/** Durable prerequisite links let a transform complete before its publish jobs are claimable. */
export const jobDependenciesMigration: Migration = {
  id: '0020_job_dependencies',
  sql: `
    ALTER TABLE jobs ADD COLUMN depends_on_job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT;
    CREATE INDEX jobs_dependency_idx ON jobs (depends_on_job_id, status);
  `,
};
