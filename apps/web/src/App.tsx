import { useEffect, useState } from 'react';
import {
  ApplicationShell,
  PageHeader,
  ResourceNavigation,
  TopCommandBar,
  Workspace,
  type ResourceNavigationItem,
} from './components/layout';
import { AccountsPage } from './features/accounts';
import { JobsPage, type JobAttemptView, type JobView } from './features/jobs';
import { MediaPage, type MediaAssetView, type MediaPublishPlatform } from './features/media';
import { NotFoundPage } from './features/not-found';
import { OverviewPage } from './features/overview';
import { SettingsPage } from './features/settings';
import { SetupPage } from './features/setup';
import { SourcesPage } from './features/sources';
import {
  WorkflowsPage,
  type WorkflowDefinitionView,
  type WorkflowEditorValue,
} from './features/workflows';

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
    description: 'Configure credentials, publishing targets, and connected platform identities.',
  },
  '/sources': {
    eyebrow: 'Remote ingestion',
    title: 'Sources',
    description: 'Poll authorized remote accounts and inspect their media lifecycle.',
  },
  '/media': {
    eyebrow: 'Local library',
    title: 'Media',
    description: 'Import local files and inspect persisted ffprobe details.',
  },
  '/workflows': {
    eyebrow: 'Automation',
    title: 'Workflows',
    description: 'Build and review durable source-to-destination routes.',
  },
  '/jobs': {
    eyebrow: 'Execution history',
    title: 'Jobs',
    description: 'Inspect persisted work, attempts, and actionable execution errors.',
  },
  '/settings': {
    eyebrow: 'Local configuration',
    title: 'Settings',
    description: 'Find the current owners of local system and integration configuration.',
  },
};
const navigation: readonly ResourceNavigationItem[] = [
  { href: '/', icon: 'dashboard', label: 'Dashboard' },
  { href: '/setup', icon: 'setup', label: 'Setup' },
  { href: '/accounts', icon: 'accounts', label: 'Accounts' },
  { href: '/sources', icon: 'sources', label: 'Sources' },
  { href: '/media', icon: 'media', label: 'Media' },
  { href: '/workflows', icon: 'workflows', label: 'Workflows' },
  { href: '/jobs', icon: 'jobs', label: 'Jobs' },
  { href: '/settings', icon: 'settings', label: 'Settings' },
];
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
type MetaCredentialStatus = { configured: boolean; redirectUri: string };
type MetaCredentialItem = {
  id: string;
  scopes: readonly string[];
  displayName: string;
  externalId: string;
  status: string;
  tokenExpiresAt: string;
};
type MetaTargetItem = {
  id: string;
  credentialId: string;
  kind: string;
  displayName: string;
  username?: string;
  enabled: boolean;
  availability: string;
  blocker?: string;
  pageId: string;
};
type WorkflowItem = {
  id: string;
  name: string;
  enabled: boolean;
  sourceDirectory: string;
  remoteSource?: {
    connectionId: string;
    retentionPolicy?: { kind: string; durationSeconds?: number };
  };
  titleTemplate: string;
  destinations: readonly WorkflowDestinationItem[];
  definition?: WorkflowDefinitionView;
};
type SourceItem = {
  id: string;
  externalId: string;
  metadata: { title?: string };
  lifecycleStatus: string;
  resolutionStatus: string;
  cleanupStatus?: string;
};
type SourceItemSummary = {
  adapterId: string;
  displayName: string;
  id: string;
  lastPollAt?: string;
  lastPollErrorCode?: string;
  lastPollErrorMessage?: string;
  lastSuccessfulPollAt?: string;
  status: string;
};
type WorkflowDestinationItem = {
  accountId: string;
  destinationId: string;
  [key: string]: unknown;
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
  const [media, setMedia] = useState<readonly MediaAssetView[]>([]);
  const [jobs, setJobs] = useState<readonly JobView[]>([]);
  const [attempts, setAttempts] = useState<readonly JobAttemptView[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [selectedJob, setSelectedJob] = useState<JobView>();
  const [isJobsLoading, setIsJobsLoading] = useState(false);
  const [isJobDetailLoading, setIsJobDetailLoading] = useState(false);
  const [activeJobAction, setActiveJobAction] = useState<string>();
  const [error, setError] = useState<string>();
  const [importPath, setImportPath] = useState('');
  const [isMediaLoading, setIsMediaLoading] = useState(false);
  const [activeMediaAction, setActiveMediaAction] = useState<string>();
  const [accounts, setAccounts] = useState<readonly AccountItem[]>([]);
  const [youtubeStatus, setYoutubeStatus] = useState<YouTubeCredentialStatus>();
  const [youtubeClientId, setYoutubeClientId] = useState('');
  const [youtubeClientSecret, setYoutubeClientSecret] = useState('');
  const [tiktokStatus, setTikTokStatus] = useState<TikTokCredentialStatus>();
  const [tiktokClientKey, setTikTokClientKey] = useState('');
  const [tiktokClientSecret, setTikTokClientSecret] = useState('');
  const [metaStatus, setMetaStatus] = useState<MetaCredentialStatus>();
  const [metaClientId, setMetaClientId] = useState('');
  const [metaClientSecret, setMetaClientSecret] = useState('');
  const [metaCredentials, setMetaCredentials] = useState<readonly MetaCredentialItem[]>([]);
  const [metaTargets, setMetaTargets] = useState<readonly MetaTargetItem[]>([]);
  const [activeAccountAction, setActiveAccountAction] = useState<string>();
  const [workflows, setWorkflows] = useState<readonly WorkflowItem[]>([]);
  const [sources, setSources] = useState<readonly SourceItemSummary[]>([]);
  const [sourceItems, setSourceItems] = useState<Readonly<Record<string, readonly SourceItem[]>>>(
    {},
  );
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [sourceChannelId, setSourceChannelId] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [activeSourceAction, setActiveSourceAction] = useState<string>();
  const [isSourcesLoading, setIsSourcesLoading] = useState(false);
  const [isWorkflowsLoading, setIsWorkflowsLoading] = useState(false);
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
    const body = (await response.json()) as { media: readonly MediaAssetView[] };
    setMedia(body.media);
  };
  const loadJobs = async () => {
    const response = await fetch('/api/jobs');
    if (!response.ok) throw new Error('Job history is unavailable.');
    const body = (await response.json()) as { jobs: readonly JobView[] };
    setJobs(body.jobs);
  };
  const loadAccounts = async () => {
    const response = await fetch('/api/accounts');
    if (!response.ok) throw new Error('Account status is unavailable.');
    const body = (await response.json()) as {
      accounts: readonly AccountItem[];
      tiktok: TikTokCredentialStatus;
      youtube: YouTubeCredentialStatus;
      meta?: MetaCredentialStatus;
      metaCredentials?: readonly MetaCredentialItem[];
      metaTargets?: readonly MetaTargetItem[];
    };
    setAccounts(body.accounts);
    setYoutubeStatus(body.youtube);
    setTikTokStatus(body.tiktok);
    setMetaStatus(body.meta);
    setMetaCredentials(body.metaCredentials ?? []);
    setMetaTargets(body.metaTargets ?? []);
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
  const loadWorkflows = async () => {
    const response = await fetch('/api/workflows');
    if (!response.ok) throw new Error('Workflow list is unavailable.');
    const body = (await response.json()) as { workflows: readonly WorkflowItem[] };
    setWorkflows(body.workflows);
  };
  const loadSources = async () => {
    const response = await fetch('/api/sources');
    if (!response.ok) throw new Error('Source status is unavailable.');
    const body = (await response.json()) as { sources: readonly SourceItemSummary[] };
    setSources(body.sources);
    const details = await Promise.all(
      body.sources.map(async (source) => {
        const itemResponse = await fetch(`/api/sources/${encodeURIComponent(source.id)}`);
        const itemBody = (await itemResponse.json()) as { items?: readonly SourceItem[] };
        return [source.id, itemBody.items ?? []] as const;
      }),
    );
    setSourceItems(Object.fromEntries(details));
  };
  const showAttempts = async (jobId: string) => {
    setSelectedJobId(jobId);
    setSelectedJob(jobs.find((job) => job.id === jobId));
    setAttempts([]);
    setIsJobDetailLoading(true);
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
      setIsJobDetailLoading(false);
    }
  };
  useEffect(() => {
    if (pathname === '/media') {
      setIsMediaLoading(true);
      void Promise.all([loadMedia(), loadAccounts()])
        .catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : 'Could not load media.'),
        )
        .finally(() => setIsMediaLoading(false));
    }
    if (pathname === '/jobs') {
      setIsJobsLoading(true);
      void loadJobs()
        .catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : 'Could not load jobs.'),
        )
        .finally(() => setIsJobsLoading(false));
    }
    if (pathname === '/accounts')
      void loadAccounts().catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load accounts.'),
      );
    if (pathname === '/setup')
      void loadSetup().catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load setup status.'),
      );
    if (pathname === '/sources') {
      setIsSourcesLoading(true);
      void Promise.all([loadAccounts(), loadSources()])
        .catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : 'Could not load sources.'),
        )
        .finally(() => setIsSourcesLoading(false));
    }
    if (pathname === '/workflows') {
      setIsWorkflowsLoading(true);
      void Promise.all([loadAccounts(), loadWorkflows(), loadSources()])
        .catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : 'Could not load workflows.'),
        )
        .finally(() => setIsWorkflowsLoading(false));
    }
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
    setActiveMediaAction('import');
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
    } finally {
      setActiveMediaAction(undefined);
    }
  };
  const cancelJob = async (jobId: string) => {
    setError(undefined);
    setActiveJobAction(`cancel:${jobId}`);
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
    } finally {
      setActiveJobAction(undefined);
    }
  };
  const queueYouTubePublish = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (publishMediaId === undefined) return;
    setError(undefined);
    setActiveMediaAction('publish:youtube');
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
    } finally {
      setActiveMediaAction(undefined);
    }
  };
  const queueTikTokPublish = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (publishMediaId === undefined) return;
    setError(undefined);
    setActiveMediaAction('publish:tiktok');
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
    } finally {
      setActiveMediaAction(undefined);
    }
  };
  const beginMediaPublish = (asset: MediaAssetView, platform: MediaPublishPlatform) => {
    const name = asset.path.split(/[\\/]/).pop() ?? 'Untitled video';
    setPublishMediaId(asset.id);
    setPublishPlatform(platform);
    setPublishCaption(name.replace(/\.[^.]+$/, ''));
    if (platform === 'youtube') {
      setPublishTitle(name.replace(/\.[^.]+$/, ''));
      setPublishDescription('');
      setPublishAccountId(accounts[0]?.id ?? '');
      return;
    }
    setPublishAccountId(accounts.find((account) => account.provider === 'tiktok')?.id ?? '');
    const capability = Object.values(tiktokCapabilities).find(
      (view) => view.capabilities !== undefined,
    )?.capabilities;
    setPublishPrivacy(capability?.privacyLevelOptions[0] ?? 'SELF_ONLY');
  };
  const createWorkflow = async (value: WorkflowEditorValue) => {
    setError(undefined);
    try {
      const response = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify(value),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The workflow could not be saved.');
      await loadWorkflows();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The workflow could not be saved.');
    }
  };
  const addYouTubeSource = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setActiveSourceAction('add');
    try {
      const response = await fetch('/api/sources/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify({
          accountId: sourceAccountId,
          channelId: sourceChannelId,
          displayName: sourceName,
        }),
      });
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ?? 'Could not add source.',
        );
      setSourceChannelId('');
      setSourceName('');
      await loadSources();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not add source.');
    } finally {
      setActiveSourceAction(undefined);
    }
  };
  const sourceAction = async (id: string, action: 'poll' | 'pause' | 'resume') => {
    setError(undefined);
    setActiveSourceAction(`${action}:${id}`);
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': await csrfToken() },
      });
      if (!response.ok) throw new Error('Source update failed.');
      await loadSources();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Source update failed.');
    } finally {
      setActiveSourceAction(undefined);
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
    setActiveAccountAction('youtube-save');
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
    } finally {
      setActiveAccountAction(undefined);
    }
  };
  const connectYouTube = async () => {
    setError(undefined);
    setActiveAccountAction('youtube-connect');
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
    } finally {
      setActiveAccountAction(undefined);
    }
  };
  const saveMetaCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setActiveAccountAction('meta-save');
    try {
      const response = await fetch('/api/accounts/meta/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify({ clientId: metaClientId, clientSecret: metaClientSecret }),
      });
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ??
            'Meta credentials could not be saved.',
        );
      setMetaClientId('');
      setMetaClientSecret('');
      await loadAccounts();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Meta credentials could not be saved.');
    } finally {
      setActiveAccountAction(undefined);
    }
  };
  const connectMeta = async () => {
    setError(undefined);
    setActiveAccountAction('meta-connect');
    try {
      const response = await fetch('/api/accounts/meta/oauth/start', {
        method: 'POST',
        headers: { 'X-CSRF-Token': await csrfToken() },
      });
      const body = (await response.json()) as { authorizationUrl?: string; error?: string };
      if (!response.ok || body.authorizationUrl === undefined)
        throw new Error(body.error ?? 'Meta authorization could not be started.');
      window.location.assign(body.authorizationUrl);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Meta authorization could not be started.',
      );
    } finally {
      setActiveAccountAction(undefined);
    }
  };
  const setMetaTarget = async (target: MetaTargetItem, enabled: boolean) => {
    setError(undefined);
    setActiveAccountAction(`meta-target:${target.id}`);
    try {
      const response = await fetch(`/api/accounts/meta/targets/${encodeURIComponent(target.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error('Meta target could not be updated.');
      await loadAccounts();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Meta target could not be updated.');
    } finally {
      setActiveAccountAction(undefined);
    }
  };
  const rediscoverMetaTargets = async (credentialId: string) => {
    setError(undefined);
    setActiveAccountAction(`meta-refresh:${credentialId}`);
    try {
      const response = await fetch(
        `/api/accounts/meta/${encodeURIComponent(credentialId)}/discover`,
        {
          method: 'POST',
          headers: { 'X-CSRF-Token': await csrfToken() },
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Meta targets could not be refreshed.');
      await loadAccounts();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Meta targets could not be refreshed.');
    } finally {
      setActiveAccountAction(undefined);
    }
  };
  const saveTikTokCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setActiveAccountAction('tiktok-save');
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
    } finally {
      setActiveAccountAction(undefined);
    }
  };
  const connectTikTok = async () => {
    setError(undefined);
    setActiveAccountAction('tiktok-connect');
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
    } finally {
      setActiveAccountAction(undefined);
    }
  };
  const removeAccount = async (accountId: string) => {
    setError(undefined);
    setActiveAccountAction(`account-remove:${accountId}`);
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': await csrfToken() },
      });
      if (!response.ok) throw new Error('The account could not be removed.');
      await loadAccounts();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The account could not be removed.');
    } finally {
      setActiveAccountAction(undefined);
    }
  };
  return (
    <ApplicationShell
      commandBar={
        <TopCommandBar onHomeClick={(event) => navigate(event, '/')} statusLabel="Local only" />
      }
      resourceRail={
        <ResourceNavigation
          currentPath={pathname}
          items={navigation}
          mode="rail"
          onNavigate={navigate}
        />
      }
    >
      <ResourceNavigation
        currentPath={pathname}
        items={navigation}
        mode="compact"
        onNavigate={navigate}
      />
      <div className="min-w-0 px-[var(--or-space-3)] py-[var(--or-space-3)] sm:px-[var(--or-space-4)] sm:py-[var(--or-space-4)]">
        <Workspace
          header={
            <PageHeader
              description={page.description}
              eyebrow={page.eyebrow}
              title={page.title}
              titleId="workspace-title"
            />
          }
          labelledBy="workspace-title"
          mode={
            pathname === '/setup' || pathname === '/settings' || pages[pathname] === undefined
              ? 'setup'
              : 'default'
          }
        >
          {pathname === '/accounts' ? (
            <AccountsPage
              accounts={accounts}
              activeAction={activeAccountAction}
              error={error}
              feedback={{
                meta: new URLSearchParams(window.location.search).get('meta'),
                tiktok: new URLSearchParams(window.location.search).get('tiktok'),
                youtube: new URLSearchParams(window.location.search).get('youtube'),
              }}
              meta={{
                clientId: metaClientId,
                clientSecret: metaClientSecret,
                credentials: metaCredentials,
                status: metaStatus,
                targets: metaTargets,
              }}
              onConnectMeta={() => void connectMeta()}
              onConnectTikTok={() => void connectTikTok()}
              onConnectYouTube={() => void connectYouTube()}
              onMetaClientIdChange={setMetaClientId}
              onMetaClientSecretChange={setMetaClientSecret}
              onMetaTargetChange={(target, enabled) => void setMetaTarget(target, enabled)}
              onRediscoverMetaTargets={(credentialId) => void rediscoverMetaTargets(credentialId)}
              onRemoveAccount={(accountId) => void removeAccount(accountId)}
              onSaveMeta={saveMetaCredentials}
              onSaveTikTok={saveTikTokCredentials}
              onSaveYouTube={saveYouTubeCredentials}
              onTikTokClientKeyChange={setTikTokClientKey}
              onTikTokClientSecretChange={setTikTokClientSecret}
              onYouTubeClientIdChange={setYoutubeClientId}
              onYouTubeClientSecretChange={setYoutubeClientSecret}
              tiktok={{
                capabilities: tiktokCapabilities,
                clientKey: tiktokClientKey,
                clientSecret: tiktokClientSecret,
                status: tiktokStatus,
              }}
              youtube={{
                clientId: youtubeClientId,
                clientSecret: youtubeClientSecret,
                status: youtubeStatus,
              }}
            />
          ) : pathname === '/sources' ? (
            <SourcesPage
              accounts={accounts}
              activeAction={activeSourceAction}
              draft={{
                accountId: sourceAccountId,
                channelId: sourceChannelId,
                displayName: sourceName,
              }}
              error={error}
              isLoading={isSourcesLoading}
              itemsBySource={sourceItems}
              onAccountIdChange={setSourceAccountId}
              onAddSource={addYouTubeSource}
              onChannelIdChange={setSourceChannelId}
              onDisplayNameChange={setSourceName}
              onNavigateAccounts={(event) => navigate(event, '/accounts')}
              onSourceAction={(sourceId, action) => void sourceAction(sourceId, action)}
              sources={sources}
            />
          ) : pathname === '/workflows' ? (
            <WorkflowsPage
              accounts={accounts}
              error={error}
              isLoading={isWorkflowsLoading}
              metaTargets={metaTargets}
              onCreateWorkflow={createWorkflow}
              sources={sources}
              workflows={workflows}
            />
          ) : pathname === '/setup' ? (
            <SetupPage error={error} tiktokStatus={tiktokStatus} youtubeStatus={youtubeStatus} />
          ) : pathname === '/media' ? (
            <MediaPage
              accounts={accounts}
              activeAction={activeMediaAction}
              error={error}
              importPath={importPath}
              isLoading={isMediaLoading}
              media={media}
              onAccountIdChange={setPublishAccountId}
              onBeginPublish={beginMediaPublish}
              onCancelPublish={() => setPublishMediaId(undefined)}
              onCaptionChange={setPublishCaption}
              onDescriptionChange={setPublishDescription}
              onDisableCommentChange={setDisableComment}
              onDisableDuetChange={setDisableDuet}
              onDisableStitchChange={setDisableStitch}
              onImport={importMedia}
              onImportPathChange={setImportPath}
              onPrivacyChange={setPublishPrivacy}
              onPublish={publishPlatform === 'youtube' ? queueYouTubePublish : queueTikTokPublish}
              onTitleChange={setPublishTitle}
              publish={{
                accountId: publishAccountId,
                caption: publishCaption,
                captionMaxLength: Object.values(tiktokCapabilities).find(
                  (view) => view.capabilities,
                )?.capabilities?.media?.captionMaxUtf16CodeUnits,
                description: publishDescription,
                disableComment,
                disableDuet,
                disableStitch,
                mediaId: publishMediaId,
                platform: publishPlatform,
                privacy: publishPrivacy,
                privacyOptions:
                  tiktokCapabilities[publishAccountId]?.capabilities?.privacyLevelOptions ?? [],
                title: publishTitle,
              }}
            />
          ) : pathname === '/jobs' ? (
            <JobsPage
              activeAction={activeJobAction}
              attempts={attempts}
              error={error}
              isDetailLoading={isJobDetailLoading}
              isLoading={isJobsLoading}
              jobs={jobs}
              onCancelJob={(jobId) => void cancelJob(jobId)}
              onCloseDetails={() => {
                setSelectedJobId(undefined);
                setSelectedJob(undefined);
                setAttempts([]);
              }}
              onSelectJob={(jobId) => void showAttempts(jobId)}
              selectedJob={selectedJob}
              selectedJobId={selectedJobId}
            />
          ) : pathname === '/settings' ? (
            <SettingsPage onNavigate={navigate} />
          ) : pathname === '/' ? (
            <OverviewPage onNavigate={navigate} />
          ) : (
            <NotFoundPage onNavigate={navigate} />
          )}
        </Workspace>
      </div>
    </ApplicationShell>
  );
}
