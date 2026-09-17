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
  destination?: DestinationJobItem;
};
type DestinationJobItem = {
  destinationId: string;
  remoteStatus: string;
  uploadedBytes: number;
  remoteId?: string;
};
type JobAttemptItem = {
  attemptNumber: number;
  errorCode?: string;
  errorMessage?: string;
  status: string;
};
type AccountItem = {
  capabilities: readonly string[];
  displayName: string;
  externalId: string;
  id: string;
  provider: string;
  status: string;
};
type YouTubeCredentialStatus = {
  clientSecretConfigured: boolean;
  configured: boolean;
  redirectUri: string;
};
type TikTokCredentialStatus = {
  clientSecretConfigured: boolean;
  configured: boolean;
  flow: 'desktop' | 'web';
  redirectUri: string;
};
type TikTokAccountCapabilities = {
  accountId: string;
  audit: { status: 'not_exposed_by_tiktok'; unauditedClientsPrivateOnly: true };
  creator?: { nickname: string; username: string };
  directPostAvailable: boolean;
  grantedScopes: readonly string[];
  interactions?: {
    commentsDisabled: boolean;
    duetDisabled: boolean;
    stitchDisabled: boolean;
  };
  media?: {
    captionMaxUtf16CodeUnits: number;
    formats: readonly string[];
    maxFileSizeBytes: number;
    maxVideoDurationSeconds: number;
  };
  privacyLevelOptions: readonly string[];
  publicPostingAvailability:
    'not_authorized' | 'requires_audit_confirmation' | 'unavailable_for_creator';
};
type TikTokCapabilityView =
  | { capabilities: TikTokAccountCapabilities; error?: never }
  | { capabilities?: never; error: string };
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
  const [accounts, setAccounts] = useState<readonly AccountItem[]>([]);
  const [youtubeStatus, setYoutubeStatus] = useState<YouTubeCredentialStatus>();
  const [youtubeClientId, setYoutubeClientId] = useState('');
  const [youtubeClientSecret, setYoutubeClientSecret] = useState('');
  const [tiktokStatus, setTikTokStatus] = useState<TikTokCredentialStatus>();
  const [tiktokClientKey, setTikTokClientKey] = useState('');
  const [tiktokClientSecret, setTikTokClientSecret] = useState('');
  const [tiktokCapabilities, setTikTokCapabilities] = useState<
    Readonly<Record<string, TikTokCapabilityView>>
  >({});
  const [publishMediaId, setPublishMediaId] = useState<string>();
  const [publishAccountId, setPublishAccountId] = useState('');
  const [publishTitle, setPublishTitle] = useState('');
  const [publishDescription, setPublishDescription] = useState('');
  const [publishPlatform, setPublishPlatform] = useState<'youtube' | 'tiktok'>('youtube');
  const [publishPrivacy, setPublishPrivacy] = useState('SELF_ONLY');
  const [publishCaption, setPublishCaption] = useState('');
  const [disableComment, setDisableComment] = useState(false);
  const [disableDuet, setDisableDuet] = useState(false);
  const [disableStitch, setDisableStitch] = useState(false);
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
  const loadAccounts = async () => {
    const response = await fetch('/api/accounts');
    if (!response.ok) throw new Error('Account status is unavailable.');
    const body = (await response.json()) as {
      accounts: readonly AccountItem[];
      tiktok: TikTokCredentialStatus;
      youtube: YouTubeCredentialStatus;
    };
    setAccounts(body.accounts);
    setYoutubeStatus(body.youtube);
    setTikTokStatus(body.tiktok);
    const views = await Promise.all(
      body.accounts
        .filter((account) => account.provider === 'tiktok')
        .map(async (account): Promise<readonly [string, TikTokCapabilityView]> => {
          const capabilityResponse = await fetch(
            `/api/accounts/tiktok/${encodeURIComponent(account.id)}/capabilities`,
          );
          const capabilityBody = (await capabilityResponse.json()) as {
            capabilities?: TikTokAccountCapabilities;
            error?: string;
          };
          return [
            account.id,
            capabilityResponse.ok && capabilityBody.capabilities !== undefined
              ? { capabilities: capabilityBody.capabilities }
              : { error: capabilityBody.error ?? 'TikTok posting availability is unavailable.' },
          ];
        }),
    );
    setTikTokCapabilities(Object.fromEntries(views));
  };
  const loadSetup = async () => {
    const response = await fetch('/api/setup');
    if (!response.ok) throw new Error('Setup status is unavailable.');
    const body = (await response.json()) as {
      tiktok: TikTokCredentialStatus;
      youtube: YouTubeCredentialStatus;
    };
    setYoutubeStatus(body.youtube);
    setTikTokStatus(body.tiktok);
  };
  const showAttempts = async (jobId: string) => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) throw new Error('Job attempt history is unavailable.');
    const body = (await response.json()) as {
      attempts: readonly JobAttemptItem[];
      destination?: DestinationJobItem;
    };
    setSelectedJobId(jobId);
    setAttempts(body.attempts);
  };
  useEffect(() => {
    if (pathname === '/media')
      void Promise.all([loadMedia(), loadAccounts()]).catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load media.'),
      );
    if (pathname === '/jobs')
      void loadJobs().catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load jobs.'),
      );
    if (pathname === '/accounts')
      void loadAccounts().catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load accounts.'),
      );
    if (pathname === '/setup')
      void loadSetup().catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load setup status.'),
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
  const queueYouTubePublish = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (publishMediaId === undefined) return;
    setError(undefined);
    try {
      const response = await fetch('/api/publish/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify({
          mediaId: publishMediaId,
          accountId: publishAccountId,
          metadata: { title: publishTitle, description: publishDescription, privacy: 'private' },
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The YouTube upload could not be queued.');
      setPublishMediaId(undefined);
      await loadJobs();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The YouTube upload could not be queued.',
      );
    }
  };
  const queueTikTokPublish = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (publishMediaId === undefined) return;
    setError(undefined);
    try {
      const response = await fetch('/api/publish/tiktok', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify({
          mediaId: publishMediaId,
          accountId: publishAccountId,
          metadata: {
            caption: publishCaption,
            privacyLevel: publishPrivacy,
            disableComment,
            disableDuet,
            disableStitch,
          },
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The TikTok post could not be queued.');
      setPublishMediaId(undefined);
      await loadJobs();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The TikTok post could not be queued.');
    }
  };
  const csrfToken = async () => {
    const response = await fetch('/api/session');
    if (!response.ok) throw new Error('The local session could not be created.');
    return ((await response.json()) as { csrfToken: string }).csrfToken;
  };
  const saveYouTubeCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    try {
      const response = await fetch('/api/accounts/youtube/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify({
          clientId: youtubeClientId,
          clientSecret: youtubeClientSecret,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'YouTube credentials could not be saved.');
      setYoutubeClientId('');
      setYoutubeClientSecret('');
      await loadAccounts();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'YouTube credentials could not be saved.',
      );
    }
  };
  const connectYouTube = async () => {
    setError(undefined);
    try {
      const response = await fetch('/api/accounts/youtube/oauth/start', {
        method: 'POST',
        headers: { 'X-CSRF-Token': await csrfToken() },
      });
      const body = (await response.json()) as { authorizationUrl?: string; error?: string };
      if (!response.ok || body.authorizationUrl === undefined)
        throw new Error(body.error ?? 'YouTube authorization could not be started.');
      window.location.assign(body.authorizationUrl);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'YouTube authorization could not be started.',
      );
    }
  };
  const saveTikTokCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    try {
      const response = await fetch('/api/accounts/tiktok/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify({ clientKey: tiktokClientKey, clientSecret: tiktokClientSecret }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'TikTok credentials could not be saved.');
      setTikTokClientKey('');
      setTikTokClientSecret('');
      await loadAccounts();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'TikTok credentials could not be saved.',
      );
    }
  };
  const connectTikTok = async () => {
    setError(undefined);
    try {
      const response = await fetch('/api/accounts/tiktok/oauth/start', {
        method: 'POST',
        headers: { 'X-CSRF-Token': await csrfToken() },
      });
      const body = (await response.json()) as { authorizationUrl?: string; error?: string };
      if (!response.ok || body.authorizationUrl === undefined)
        throw new Error(body.error ?? 'TikTok authorization could not be started.');
      window.location.assign(body.authorizationUrl);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'TikTok authorization could not be started.',
      );
    }
  };
  const removeAccount = async (accountId: string) => {
    setError(undefined);
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': await csrfToken() },
      });
      if (!response.ok) throw new Error('The account could not be removed.');
      await loadAccounts();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The account could not be removed.');
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
              {pathname === '/accounts' ? (
                <div className="space-y-8">
                  {new URLSearchParams(window.location.search).get('youtube') === 'connected' && (
                    <p className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm text-emerald-200">
                      YouTube connected successfully.
                    </p>
                  )}
                  {new URLSearchParams(window.location.search).get('youtube') === 'error' && (
                    <p className="rounded-lg border border-rose-300/20 bg-rose-300/10 p-3 text-sm text-rose-200">
                      YouTube connection failed. Check the credential setup and try again.
                    </p>
                  )}
                  {new URLSearchParams(window.location.search).get('tiktok') === 'connected' && (
                    <p className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm text-emerald-200">
                      TikTok connected successfully.
                    </p>
                  )}
                  {new URLSearchParams(window.location.search).get('tiktok') === 'error' && (
                    <p className="rounded-lg border border-rose-300/20 bg-rose-300/10 p-3 text-sm text-rose-200">
                      TikTok connection failed. Check the credential setup and granted scopes.
                    </p>
                  )}
                  {error !== undefined && <p className="text-sm text-rose-300">{error}</p>}
                  <section className="rounded-xl border border-white/10 bg-slate-950 p-5">
                    <h2 className="font-semibold">Google OAuth credentials</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-400">
                      Use your own Google Cloud desktop OAuth client. Values are encrypted locally
                      and are never returned to this page.
                    </p>
                    <form className="mt-5 grid gap-3" onSubmit={saveYouTubeCredentials}>
                      <label className="grid gap-1 text-sm" htmlFor="youtube-client-id">
                        <span className="text-slate-300">Client ID</span>
                        <input
                          className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                          id="youtube-client-id"
                          onChange={(event) => setYoutubeClientId(event.target.value)}
                          placeholder="…apps.googleusercontent.com"
                          required
                          value={youtubeClientId}
                        />
                      </label>
                      <label className="grid gap-1 text-sm" htmlFor="youtube-client-secret">
                        <span className="text-slate-300">Client secret (optional)</span>
                        <input
                          autoComplete="new-password"
                          className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                          id="youtube-client-secret"
                          onChange={(event) => setYoutubeClientSecret(event.target.value)}
                          type="password"
                          value={youtubeClientSecret}
                        />
                      </label>
                      <div className="flex flex-wrap gap-3">
                        <button
                          className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950"
                          type="submit"
                        >
                          Save credentials
                        </button>
                        <button
                          className="rounded-lg border border-cyan-300/30 px-4 py-2 text-sm text-cyan-200 disabled:opacity-40"
                          disabled={youtubeStatus?.configured !== true}
                          onClick={() => void connectYouTube()}
                          type="button"
                        >
                          Connect YouTube
                        </button>
                      </div>
                    </form>
                    <p className="mt-4 break-all text-xs text-slate-500">
                      Callback: {youtubeStatus?.redirectUri ?? 'Loading…'}
                    </p>
                  </section>
                  <section className="rounded-xl border border-white/10 bg-slate-950 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="font-semibold">TikTok Login Kit credentials</h2>
                        <p className="mt-2 text-sm leading-6 text-slate-400">
                          Use your own TikTok developer app with Login Kit and Content Posting API.
                          Credentials and tokens stay encrypted on this machine.
                        </p>
                      </div>
                      <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs text-amber-200">
                        Unaudited apps: private only
                      </span>
                    </div>
                    <form className="mt-5 grid gap-3" onSubmit={saveTikTokCredentials}>
                      <label className="grid gap-1 text-sm" htmlFor="tiktok-client-key">
                        <span className="text-slate-300">Client key</span>
                        <input
                          className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                          id="tiktok-client-key"
                          onChange={(event) => setTikTokClientKey(event.target.value)}
                          required
                          value={tiktokClientKey}
                        />
                      </label>
                      <label className="grid gap-1 text-sm" htmlFor="tiktok-client-secret">
                        <span className="text-slate-300">Client secret</span>
                        <input
                          autoComplete="new-password"
                          className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                          id="tiktok-client-secret"
                          onChange={(event) => setTikTokClientSecret(event.target.value)}
                          required
                          type="password"
                          value={tiktokClientSecret}
                        />
                      </label>
                      <div className="flex flex-wrap gap-3">
                        <button
                          className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950"
                          type="submit"
                        >
                          Save TikTok credentials
                        </button>
                        <button
                          className="rounded-lg border border-cyan-300/30 px-4 py-2 text-sm text-cyan-200 disabled:opacity-40"
                          disabled={tiktokStatus?.configured !== true}
                          onClick={() => void connectTikTok()}
                          type="button"
                        >
                          Connect TikTok
                        </button>
                      </div>
                    </form>
                    <p className="mt-4 break-all text-xs text-slate-500">
                      {tiktokStatus?.flow === 'desktop' ? 'Desktop + PKCE' : 'HTTPS web'} callback:{' '}
                      {tiktokStatus?.redirectUri ?? 'Loading…'}
                    </p>
                    <p className="mt-3 text-sm leading-6 text-amber-200/80">
                      Request <code>user.info.basic</code> and <code>video.publish</code> in the
                      TikTok portal. TikTok does not expose app-audit status through creator-info;
                      non-private posting requires a successful TikTok audit and is never assumed.
                    </p>
                  </section>
                  <section>
                    <h2 className="font-semibold">Connected accounts</h2>
                    <div className="mt-3 grid gap-3">
                      {accounts.map((account) => {
                        const tiktokView = tiktokCapabilities[account.id];
                        return (
                          <article
                            className="rounded-xl border border-white/10 bg-slate-950 p-5"
                            key={account.id}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h3 className="font-medium">
                                  {account.displayName}{' '}
                                  <span className="text-xs uppercase tracking-wide text-slate-500">
                                    {account.provider}
                                  </span>
                                </h3>
                                <p className="mt-1 font-mono text-xs text-slate-500">
                                  {account.externalId}
                                </p>
                              </div>
                              <span
                                className={
                                  account.status === 'connected'
                                    ? 'text-emerald-200'
                                    : 'text-amber-200'
                                }
                              >
                                {account.status === 'connected'
                                  ? 'Connected'
                                  : 'Reconnect required'}
                              </span>
                            </div>
                            {account.provider === 'youtube' ? (
                              <p className="mt-4 text-sm text-slate-300">
                                Upload:{' '}
                                {account.capabilities.includes('youtube.video.upload')
                                  ? 'allowed'
                                  : 'not granted'}{' '}
                                · Identity:{' '}
                                {account.capabilities.includes('youtube.identity.read')
                                  ? 'available'
                                  : 'not granted'}
                              </p>
                            ) : tiktokView?.capabilities !== undefined ? (
                              <div className="mt-4 space-y-2 text-sm text-slate-300">
                                <p>
                                  Granted scopes: {tiktokView.capabilities.grantedScopes.join(', ')}
                                </p>
                                <p>
                                  Direct Post:{' '}
                                  {tiktokView.capabilities.directPostAvailable
                                    ? 'available for this creator'
                                    : 'video.publish not granted'}
                                </p>
                                {tiktokView.capabilities.creator !== undefined && (
                                  <p>
                                    Live creator: @{tiktokView.capabilities.creator.username} · up
                                    to {tiktokView.capabilities.media?.maxVideoDurationSeconds}s ·{' '}
                                    {tiktokView.capabilities.privacyLevelOptions.join(', ')}
                                  </p>
                                )}
                                <p className="text-amber-200/80">
                                  Public posting:{' '}
                                  {tiktokView.capabilities.publicPostingAvailability ===
                                  'requires_audit_confirmation'
                                    ? 'creator allows it, but TikTok app audit must be confirmed'
                                    : tiktokView.capabilities.publicPostingAvailability ===
                                        'unavailable_for_creator'
                                      ? 'not offered for this creator'
                                      : 'not authorized'}
                                  . Unaudited clients are private-only.
                                </p>
                              </div>
                            ) : tiktokView?.error !== undefined ? (
                              <p className="mt-4 text-sm text-amber-200">{tiktokView.error}</p>
                            ) : (
                              <p className="mt-4 text-sm text-slate-400">
                                Loading live TikTok posting availability…
                              </p>
                            )}
                            <button
                              className="mt-4 text-sm text-rose-200 hover:underline"
                              onClick={() => void removeAccount(account.id)}
                              type="button"
                            >
                              Remove local connection
                            </button>
                          </article>
                        );
                      })}
                    </div>
                    {accounts.length === 0 && (
                      <p className="mt-3 text-sm text-slate-400">
                        No publishing account is connected.
                      </p>
                    )}
                  </section>
                  <p className="text-sm leading-6 text-amber-200/80">
                    Google may limit uploads from unverified API projects. OpenRepurpose shows
                    granted capabilities but cannot override Google audit or visibility rules.
                  </p>
                </div>
              ) : pathname === '/setup' ? (
                <div className="space-y-4">
                  {error !== undefined && <p className="text-sm text-rose-300">{error}</p>}
                  <div className="rounded-xl border border-white/10 bg-slate-950 p-5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h2 className="font-semibold">YouTube credentials</h2>
                        <p className="mt-1 text-sm text-slate-400">
                          BYO Google OAuth desktop client
                        </p>
                      </div>
                      <span
                        className={
                          youtubeStatus?.configured === true ? 'text-emerald-200' : 'text-amber-200'
                        }
                      >
                        {youtubeStatus?.configured === true ? 'Configured' : 'Action required'}
                      </span>
                    </div>
                    <p className="mt-3 break-all text-xs text-slate-500">
                      {youtubeStatus?.redirectUri}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-slate-950 p-5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h2 className="font-semibold">TikTok credentials</h2>
                        <p className="mt-1 text-sm text-slate-400">
                          BYO TikTok Login Kit app · {tiktokStatus?.flow ?? 'deployment'} flow
                        </p>
                      </div>
                      <span
                        className={
                          tiktokStatus?.configured === true ? 'text-emerald-200' : 'text-amber-200'
                        }
                      >
                        {tiktokStatus?.configured === true ? 'Configured' : 'Action required'}
                      </span>
                    </div>
                    <p className="mt-3 break-all text-xs text-slate-500">
                      {tiktokStatus?.redirectUri}
                    </p>
                    <p className="mt-2 text-xs text-amber-200/80">
                      TikTok unaudited clients can publish only with private visibility.
                    </p>
                  </div>
                </div>
              ) : pathname === '/media' ? (
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
                        <th>Action</th>
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
                          <td>
                            <button
                              className="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-xs text-cyan-200"
                              onClick={() => {
                                const name = asset.path.split(/[\\/]/).pop() ?? 'Untitled video';
                                setPublishMediaId(asset.id);
                                setPublishPlatform('youtube');
                                setPublishTitle(name.replace(/\.[^.]+$/, ''));
                                setPublishCaption(name.replace(/\.[^.]+$/, ''));
                                setPublishDescription('');
                                setPublishAccountId(accounts[0]?.id ?? '');
                              }}
                              type="button"
                            >
                              Publish to YouTube
                            </button>
                            {accounts.some((account) => account.provider === 'tiktok') && (
                              <button
                                className="ml-2 rounded-lg border border-fuchsia-300/30 px-3 py-1.5 text-xs text-fuchsia-200"
                                onClick={() => {
                                  const name = asset.path.split(/[\\/]/).pop() ?? 'Untitled video';
                                  setPublishMediaId(asset.id);
                                  setPublishPlatform('tiktok');
                                  setPublishCaption(name.replace(/\.[^.]+$/, ''));
                                  setPublishAccountId(
                                    accounts.find((account) => account.provider === 'tiktok')?.id ??
                                      '',
                                  );
                                  const capability = Object.values(tiktokCapabilities).find(
                                    (view) => view.capabilities !== undefined,
                                  )?.capabilities;
                                  setPublishPrivacy(
                                    capability?.privacyLevelOptions[0] ?? 'SELF_ONLY',
                                  );
                                }}
                                type="button"
                              >
                                Publish to TikTok
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {media.length === 0 && (
                    <p className="text-sm text-slate-400">No local media has been imported yet.</p>
                  )}
                  {publishMediaId !== undefined && (
                    <form
                      className="grid gap-3 rounded-xl border border-cyan-300/20 bg-slate-950 p-5"
                      onSubmit={
                        publishPlatform === 'youtube' ? queueYouTubePublish : queueTikTokPublish
                      }
                    >
                      <h2 className="font-semibold">
                        Queue {publishPlatform === 'youtube' ? 'YouTube upload' : 'TikTok post'}
                      </h2>
                      <label className="grid gap-1 text-sm" htmlFor="publish-account">
                        <span className="text-slate-300">Connected account</span>
                        <select
                          className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                          id="publish-account"
                          onChange={(event) => setPublishAccountId(event.target.value)}
                          required
                          value={publishAccountId}
                        >
                          <option value="">
                            Select a {publishPlatform === 'youtube' ? 'YouTube' : 'TikTok'} account
                          </option>
                          {accounts
                            .filter((account) => account.provider === publishPlatform)
                            .map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.displayName}
                              </option>
                            ))}
                        </select>
                      </label>
                      {publishPlatform === 'youtube' ? (
                        <label className="grid gap-1 text-sm" htmlFor="publish-title">
                          <span className="text-slate-300">Title</span>
                          <input
                            className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                            id="publish-title"
                            onChange={(event) => setPublishTitle(event.target.value)}
                            required
                            value={publishTitle}
                          />
                        </label>
                      ) : (
                        <>
                          <label className="grid gap-1 text-sm" htmlFor="publish-caption">
                            <span className="text-slate-300">Caption</span>
                            <textarea
                              className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                              id="publish-caption"
                              maxLength={
                                Object.values(tiktokCapabilities).find((view) => view.capabilities)
                                  ?.capabilities?.media?.captionMaxUtf16CodeUnits
                              }
                              onChange={(event) => setPublishCaption(event.target.value)}
                              required
                              value={publishCaption}
                            />
                          </label>
                          <label className="grid gap-1 text-sm" htmlFor="publish-privacy">
                            <span className="text-slate-300">
                              Privacy (offered by this creator)
                            </span>
                            <select
                              className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                              id="publish-privacy"
                              onChange={(event) => setPublishPrivacy(event.target.value)}
                              required
                              value={publishPrivacy}
                            >
                              {(
                                tiktokCapabilities[publishAccountId]?.capabilities
                                  ?.privacyLevelOptions ?? []
                              ).map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex gap-2 text-sm">
                            <input
                              checked={disableComment}
                              onChange={(event) => setDisableComment(event.target.checked)}
                              type="checkbox"
                            />{' '}
                            Disable comments
                          </label>
                          <label className="flex gap-2 text-sm">
                            <input
                              checked={disableDuet}
                              onChange={(event) => setDisableDuet(event.target.checked)}
                              type="checkbox"
                            />{' '}
                            Disable duet
                          </label>
                          <label className="flex gap-2 text-sm">
                            <input
                              checked={disableStitch}
                              onChange={(event) => setDisableStitch(event.target.checked)}
                              type="checkbox"
                            />{' '}
                            Disable stitch
                          </label>
                        </>
                      )}
                      {publishPlatform === 'youtube' && (
                        <label className="grid gap-1 text-sm" htmlFor="publish-description">
                          <span className="text-slate-300">Description</span>
                          <textarea
                            className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                            id="publish-description"
                            onChange={(event) => setPublishDescription(event.target.value)}
                            value={publishDescription}
                          />
                        </label>
                      )}
                      <div className="flex gap-3">
                        <button
                          className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950"
                          type="submit"
                        >
                          Queue upload
                        </button>
                        <button
                          className="rounded-lg border border-white/15 px-4 py-2 text-sm"
                          onClick={() => setPublishMediaId(undefined)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
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
                              {job.destination !== undefined && (
                                <span className="mt-1 block text-xs text-fuchsia-200">
                                  {job.destination.destinationId}: {job.destination.remoteStatus}
                                  {job.destination.remoteId === undefined
                                    ? ''
                                    : ` · ${job.destination.remoteId}`}
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
