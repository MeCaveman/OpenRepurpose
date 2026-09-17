import { useEffect, useState } from 'react';

const pages: Readonly<
  Record<string, { readonly description: string; readonly eyebrow: string; readonly title: string }>
> = {
  '/': {
    eyebrow: 'Local workspace',
    title: 'Your media pipeline, on your machine.',
    description: 'OpenRepurpose is ready for local setup.',
  },
  '/setup': {
    eyebrow: 'System readiness',
    title: 'Setup',
    description: 'Configuration and dependency checks will appear here as capabilities are added.',
  },
  '/accounts': {
    eyebrow: 'Destinations',
    title: 'Accounts',
    description: 'Connected publishing accounts will be managed here.',
  },
  '/media': {
    eyebrow: 'Local library',
    title: 'Media',
    description: 'Import local files and inspect persisted ffprobe details.',
  },
  '/workflows': {
    eyebrow: 'Automation',
    title: 'Workflows',
    description: 'Source-to-destination workflow controls will live here.',
  },
  '/jobs': {
    eyebrow: 'Execution history',
    title: 'Jobs',
    description: 'Persistent job state, attempts, and actionable errors will appear here.',
  },
  '/settings': {
    eyebrow: 'Local configuration',
    title: 'Settings',
    description: 'Deployment-neutral application preferences will be managed here.',
  },
};
const navigation = [
  ['/', 'Dashboard'],
  ['/setup', 'Setup'],
  ['/accounts', 'Accounts'],
  ['/media', 'Media'],
  ['/workflows', 'Workflows'],
  ['/jobs', 'Jobs'],
  ['/settings', 'Settings'],
] as const;
type MediaItem = {
  id: string;
  path: string;
  state: string;
  metadata: { durationSeconds?: number; width?: number; height?: number };
};
type JobItem = {
  attemptCount: number;
  cancellationRequestedAt?: string;
  id: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  maxAttempts: number;
  status: string;
  type: string;
};
type JobAttemptItem = {
  attemptNumber: number;
  errorCode?: string;
  errorMessage?: string;
  status: string;
};
function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return pathname;
}

export function App() {
  const pathname = usePathname();
  const page = pages[pathname] ?? {
    eyebrow: 'Not found',
    title: 'This local view does not exist.',
    description: 'Choose a section from the navigation to continue.',
  };
  const [media, setMedia] = useState<readonly MediaItem[]>([]);
  const [jobs, setJobs] = useState<readonly JobItem[]>([]);
  const [attempts, setAttempts] = useState<readonly JobAttemptItem[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const [importPath, setImportPath] = useState('');
  const loadMedia = async () => {
    const response = await fetch('/api/media');
    if (!response.ok) throw new Error('Media library is unavailable.');
    const body = (await response.json()) as { media: readonly MediaItem[] };
    setMedia(body.media);
  };
  const loadJobs = async () => {
    const response = await fetch('/api/jobs');
    if (!response.ok) throw new Error('Job history is unavailable.');
    const body = (await response.json()) as { jobs: readonly JobItem[] };
    setJobs(body.jobs);
  };
  const showAttempts = async (jobId: string) => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) throw new Error('Job attempt history is unavailable.');
    const body = (await response.json()) as { attempts: readonly JobAttemptItem[] };
    setSelectedJobId(jobId);
    setAttempts(body.attempts);
  };
  useEffect(() => {
    if (pathname === '/media')
      void loadMedia().catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load media.'),
      );
    if (pathname === '/jobs')
      void loadJobs().catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load jobs.'),
      );
  }, [pathname]);
  const navigate = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    window.history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  const importMedia = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    try {
      const session = await fetch('/api/session');
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const response = await fetch('/api/media/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ path: importPath }),
      });
      if (!response.ok) throw new Error('Import failed. Check the file and ffprobe.');
      setImportPath('');
      await loadMedia();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Import failed.');
    }
  };
  const cancelJob = async (jobId: string) => {
    setError(undefined);
    try {
      const session = await fetch('/api/session');
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!response.ok) throw new Error('Job cancellation failed.');
      await loadJobs();
      if (selectedJobId === jobId) await showAttempts(jobId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Job cancellation failed.');
    }
  };
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-white/10 bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8">
          <a className="flex items-center gap-3" href="/" onClick={(event) => navigate(event, '/')}>
            <span className="grid size-9 place-items-center rounded-xl bg-cyan-300 font-black text-slate-950">
              OR
            </span>
            <span>
              <span className="block text-sm font-semibold">OpenRepurpose</span>
              <span className="block text-xs text-slate-400">Local media automation</span>
            </span>
          </a>
          <div className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-200">
            Local only
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-8 lg:grid-cols-[14rem_1fr] lg:px-8">
        <nav aria-label="Primary navigation" className="flex gap-2 overflow-x-auto lg:flex-col">
          {navigation.map(([href, label]) => (
            <a
              aria-current={pathname === href ? 'page' : undefined}
              className={`shrink-0 rounded-lg px-3 py-2 text-sm ${pathname === href ? 'bg-cyan-300 font-semibold text-slate-950' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}
              href={href}
              key={href}
              onClick={(event) => navigate(event, href)}
            >
              {label}
            </a>
          ))}
        </nav>
        <main>
          <section className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900">
            <div className="border-b border-white/10 px-7 py-10 sm:px-10">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
                {page.eyebrow}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">
                {page.title}
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
                {page.description}
              </p>
            </div>
            <div className="p-7 sm:p-10">
              {pathname === '/media' ? (
                <div className="space-y-6">
                  <form className="flex flex-col gap-3 sm:flex-row" onSubmit={importMedia}>
                    <label className="sr-only" htmlFor="media-path">
                      Local file path
                    </label>
                    <input
                      className="min-w-0 flex-1 rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-sm"
                      id="media-path"
                      onChange={(event) => setImportPath(event.target.value)}
                      placeholder="C:\\Media\\video file.mp4"
                      required
                      value={importPath}
                    />
                    <button
                      className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950"
                      type="submit"
                    >
                      Import
                    </button>
                  </form>
                  {error !== undefined && <p className="text-sm text-rose-300">{error}</p>}
                  <table className="w-full text-left text-sm">
                    <thead className="text-slate-400">
                      <tr>
                        <th>File</th>
                        <th>Details</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {media.map((asset) => (
                        <tr className="border-t border-white/10" key={asset.id}>
                          <td className="max-w-sm truncate py-3" title={asset.path}>
                            {asset.path}
                          </td>
                          <td>
                            {asset.metadata.width ?? '—'}×{asset.metadata.height ?? '—'} ·{' '}
                            {asset.metadata.durationSeconds?.toFixed(1) ?? '—'}s
                          </td>
                          <td className="text-emerald-200">{asset.state}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {media.length === 0 && (
                    <p className="text-sm text-slate-400">No local media has been imported yet.</p>
                  )}
                </div>
              ) : pathname === '/jobs' ? (
                <div className="space-y-6">
                  {error !== undefined && <p className="text-sm text-rose-300">{error}</p>}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-slate-400">
                        <tr>
                          <th>Job</th>
                          <th>Status</th>
                          <th>Attempts</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobs.map((job) => (
                          <tr className="border-t border-white/10" key={job.id}>
                            <td className="py-3 pr-4">
                              <button
                                className="text-left text-cyan-200 hover:underline"
                                onClick={() => void showAttempts(job.id)}
                                type="button"
                              >
                                <span className="block font-medium">{job.type}</span>
                                <span className="block font-mono text-xs text-slate-500">
                                  {job.id}
                                </span>
                              </button>
                              {job.lastErrorMessage !== undefined && (
                                <span className="mt-1 block text-xs text-rose-300">
                                  {job.lastErrorCode}: {job.lastErrorMessage}
                                </span>
                              )}
                            </td>
                            <td className="pr-4">{job.status}</td>
                            <td className="pr-4">
                              {job.attemptCount}/{job.maxAttempts}
                            </td>
                            <td>
                              {(job.status === 'pending' ||
                                job.status === 'retrying' ||
                                job.status === 'running') && (
                                <button
                                  className="rounded-lg border border-rose-300/30 px-3 py-1.5 text-xs text-rose-200"
                                  disabled={job.cancellationRequestedAt !== undefined}
                                  onClick={() => void cancelJob(job.id)}
                                  type="button"
                                >
                                  {job.cancellationRequestedAt === undefined
                                    ? 'Cancel'
                                    : 'Cancelling…'}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {jobs.length === 0 && (
                    <p className="text-sm text-slate-400">No jobs have been queued yet.</p>
                  )}
                  {selectedJobId !== undefined && (
                    <section className="rounded-xl border border-white/10 bg-slate-950 p-4">
                      <h2 className="font-semibold">Attempt history</h2>
                      <p className="mt-1 font-mono text-xs text-slate-500">{selectedJobId}</p>
                      <ol className="mt-4 space-y-2 text-sm">
                        {attempts.map((attempt) => (
                          <li className="rounded-lg bg-white/5 p-3" key={attempt.attemptNumber}>
                            #{attempt.attemptNumber} · {attempt.status}
                            {attempt.errorCode !== undefined && (
                              <span className="block text-xs text-rose-300">
                                {attempt.errorCode}: {attempt.errorMessage}
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                      {attempts.length === 0 && (
                        <p className="mt-3 text-sm text-slate-400">No attempts have started.</p>
                      )}
                    </section>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-400">
                  This area will grow in its owning roadmap packet.
                </p>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
