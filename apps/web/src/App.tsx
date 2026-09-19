import { useEffect, useState } from 'react';
import {
  WorkflowEditor,
  type WorkflowEditorValue,
  type WorkflowDefinitionView,
} from './components/WorkflowEditor';
import {
  ConnectionCard,
  JobStatus,
  ResourceEmptyState,
  WorkflowCard,
  type WorkflowRouteData,
  type WorkflowRouteNodeData,
} from './components/patterns';
import {
  ApplicationShell,
  PageHeader,
  ResourceNavigation,
  TopCommandBar,
  Workspace,
  type ResourceNavigationItem,
} from './components/layout';
import { Button } from './components/ui';
import { SetupPage } from './features/setup';

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

function toWorkflowRouteData(workflow: WorkflowItem): WorkflowRouteData {
  const sourceLabel =
    workflow.sourceDirectory || workflow.remoteSource?.connectionId || 'Remote source';
  const nodeState = workflow.enabled ? ('default' as const) : ('disabled' as const);
  const source: WorkflowRouteNodeData = {
    detail: workflow.remoteSource === undefined ? 'Watched folder' : 'Remote source',
    kind: 'source',
    label: sourceLabel,
    state: nodeState,
    ...(workflow.remoteSource === undefined ? { platform: 'local' } : {}),
  };
  const stages: WorkflowRouteNodeData[] = [];
  const destinations: WorkflowRouteNodeData[] = [];

  for (const step of workflow.definition?.steps ?? []) {
    if (step.kind === 'filter') {
      stages.push({ kind: 'filter', label: 'Filter', state: nodeState });
    } else if (step.kind === 'transform') {
      stages.push({ kind: 'transform', label: 'Pass-through', state: nodeState });
    } else if (step.kind === 'schedule') {
      stages.push({
        detail: step.scheduleId,
        kind: 'schedule',
        label: 'Schedule',
        state: nodeState,
      });
    } else if (step.kind === 'destination') {
      destinations.push({
        detail: step.destination.accountId || 'Account not selected',
        kind: 'destination',
        label: step.destination.destinationId,
        platform: step.destination.destinationId,
        state: nodeState,
      });
    }
  }

  if (destinations.length === 0) {
    destinations.push(
      ...workflow.destinations.map((destination) => ({
        detail: destination.accountId || 'Account not selected',
        kind: 'destination' as const,
        label: destination.destinationId,
        platform: destination.destinationId,
        state: nodeState,
      })),
    );
  }

  return { destinations, source, stages };
}

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
  const [metaStatus, setMetaStatus] = useState<MetaCredentialStatus>();
  const [metaClientId, setMetaClientId] = useState('');
  const [metaClientSecret, setMetaClientSecret] = useState('');
  const [metaCredentials, setMetaCredentials] = useState<readonly MetaCredentialItem[]>([]);
  const [metaTargets, setMetaTargets] = useState<readonly MetaTargetItem[]>([]);
  const [workflows, setWorkflows] = useState<readonly WorkflowItem[]>([]);
  const [sources, setSources] = useState<readonly SourceItemSummary[]>([]);
  const [sourceItems, setSourceItems] = useState<Readonly<Record<string, readonly SourceItem[]>>>(
    {},
  );
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [sourceChannelId, setSourceChannelId] = useState('');
  const [sourceName, setSourceName] = useState('');
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
    if (pathname === '/sources')
      void Promise.all([loadAccounts(), loadSources()]).catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load sources.'),
      );
    if (pathname === '/workflows')
      void Promise.all([loadAccounts(), loadWorkflows(), loadSources()]).catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load workflows.'),
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
    }
  };
  const sourceAction = async (id: string, action: 'poll' | 'pause' | 'resume') => {
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': await csrfToken() },
      });
      if (!response.ok) throw new Error('Source update failed.');
      await loadSources();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Source update failed.');
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
  const saveMetaCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
    }
  };
  const connectMeta = async () => {
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
    }
  };
  const setMetaTarget = async (target: MetaTargetItem, enabled: boolean) => {
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
    }
  };
  const rediscoverMetaTargets = async (credentialId: string) => {
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
          mode={pathname === '/setup' ? 'setup' : 'default'}
        >
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
              {new URLSearchParams(window.location.search).get('meta') === 'connected' && (
                <p className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm text-emerald-200">
                  Meta connected successfully. Available Pages and linked Instagram professional
                  accounts were discovered.
                </p>
              )}
              {error !== undefined && <p className="text-sm text-rose-300">{error}</p>}
              <section className="rounded-xl border border-white/10 bg-slate-950 p-5">
                <h2 className="font-semibold">Google OAuth credentials</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  Use your own Google Cloud desktop OAuth client. Values are encrypted locally and
                  are never returned to this page.
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
                <h2 className="font-semibold">Meta app and publishing targets</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  Connect one Meta identity, then independently enable its Facebook Pages and linked
                  Instagram professional accounts. App secrets and tokens remain encrypted locally.
                </p>
                <form className="mt-5 grid gap-3" onSubmit={saveMetaCredentials}>
                  <label className="grid gap-1 text-sm" htmlFor="meta-client-id">
                    <span className="text-slate-300">Meta app ID</span>
                    <input
                      className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                      id="meta-client-id"
                      onChange={(event) => setMetaClientId(event.target.value)}
                      required
                      value={metaClientId}
                    />
                  </label>
                  <label className="grid gap-1 text-sm" htmlFor="meta-client-secret">
                    <span className="text-slate-300">Meta app secret</span>
                    <input
                      autoComplete="new-password"
                      className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                      id="meta-client-secret"
                      onChange={(event) => setMetaClientSecret(event.target.value)}
                      required
                      type="password"
                      value={metaClientSecret}
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button
                      className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950"
                      type="submit"
                    >
                      Save Meta credentials
                    </button>
                    <button
                      className="rounded-lg border border-cyan-300/30 px-4 py-2 text-sm text-cyan-200 disabled:opacity-40"
                      disabled={metaStatus?.configured !== true}
                      onClick={() => void connectMeta()}
                      type="button"
                    >
                      Connect Meta
                    </button>
                  </div>
                </form>
                <p className="mt-4 break-all text-xs text-slate-500">
                  Callback: {metaStatus?.redirectUri ?? 'Loading…'}
                </p>
                {metaCredentials.map((credential) => (
                  <div className="mt-4 rounded-lg border border-white/10 p-4" key={credential.id}>
                    <p className="font-medium">
                      {credential.displayName}{' '}
                      <span className="text-xs text-slate-500">
                        Meta identity · {credential.status}
                      </span>
                    </p>
                    <p className="mt-2 text-xs text-slate-400">
                      Credential identity: {credential.externalId} · granted permissions:{' '}
                      {credential.scopes.length === 0
                        ? 'none reported'
                        : credential.scopes.join(', ')}
                    </p>
                    {credential.status !== 'connected' && (
                      <p className="mt-2 text-sm text-amber-200">
                        Permission blocker: reconnect this Meta identity before publishing.
                      </p>
                    )}
                    <button
                      className="mt-3 rounded-lg border border-cyan-300/30 px-3 py-1.5 text-xs text-cyan-200"
                      onClick={() => void rediscoverMetaTargets(credential.id)}
                      type="button"
                    >
                      Refresh available targets
                    </button>
                    {metaTargets
                      .filter((target) => target.credentialId === credential.id)
                      .sort(
                        (left, right) =>
                          left.kind.localeCompare(right.kind) ||
                          left.displayName.localeCompare(right.displayName),
                      )
                      .map((target) => (
                        <div className="mt-3 rounded-lg border border-white/10 p-3" key={target.id}>
                          <label className="flex items-start gap-3 text-sm">
                            <input
                              checked={target.enabled}
                              disabled={target.availability !== 'available'}
                              onChange={(event) => void setMetaTarget(target, event.target.checked)}
                              type="checkbox"
                            />
                            <span>
                              <span className="font-medium">{target.displayName}</span>{' '}
                              <span className="text-xs uppercase text-slate-500">
                                {target.kind === 'facebook_page'
                                  ? 'Facebook Page target'
                                  : 'Instagram professional target'}
                              </span>
                              {target.username !== undefined && (
                                <span className="block text-slate-400">@{target.username}</span>
                              )}
                              <span
                                className={
                                  target.availability === 'available'
                                    ? 'block text-emerald-200'
                                    : 'block text-amber-200'
                                }
                              >
                                {target.availability === 'available'
                                  ? 'Available for publishing'
                                  : 'Unavailable'}
                              </span>
                              {target.blocker !== undefined && (
                                <span className="block text-amber-200">
                                  Permission/review blocker: {target.blocker}
                                </span>
                              )}
                            </span>
                          </label>
                        </div>
                      ))}
                    {metaTargets.filter((target) => target.credentialId === credential.id)
                      .length === 0 && (
                      <p className="mt-3 text-sm text-amber-200">
                        No Page or linked Instagram professional targets are available. Check Meta
                        app review, Page roles, and account eligibility.
                      </p>
                    )}
                  </div>
                ))}
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
                  Request <code>user.info.basic</code> and <code>video.publish</code> in the TikTok
                  portal. TikTok does not expose app-audit status through creator-info; non-private
                  posting requires a successful TikTok audit and is never assumed.
                </p>
              </section>
              <section>
                <h2 className="font-semibold">Connected accounts</h2>
                <div className="mt-3 grid gap-3">
                  {accounts.map((account) => {
                    const tiktokView = tiktokCapabilities[account.id];
                    return (
                      <ConnectionCard
                        actions={
                          <Button
                            onClick={() => void removeAccount(account.id)}
                            size="sm"
                            variant="danger"
                          >
                            Remove local connection
                          </Button>
                        }
                        externalId={account.externalId}
                        key={account.id}
                        name={account.displayName}
                        platform={account.provider}
                        status={account.status === 'connected' ? 'connected' : 'attention'}
                      >
                        {account.provider === 'youtube' ? (
                          <p>
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
                          <div className="space-y-2">
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
                                Live creator: @{tiktokView.capabilities.creator.username} · up to{' '}
                                {tiktokView.capabilities.media?.maxVideoDurationSeconds}s ·{' '}
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
                          <p className="text-[var(--or-status-warning-fg)]">{tiktokView.error}</p>
                        ) : (
                          <p className="text-[var(--or-text-tertiary)]">
                            Loading live TikTok posting availability…
                          </p>
                        )}
                      </ConnectionCard>
                    );
                  })}
                </div>
                {accounts.length === 0 && (
                  <ResourceEmptyState
                    className="mt-3"
                    description="Connect a publishing account before choosing it as a workflow destination."
                    title="No publishing accounts"
                  />
                )}
              </section>
              <p className="text-sm leading-6 text-amber-200/80">
                Google may limit uploads from unverified API projects. OpenRepurpose shows granted
                capabilities but cannot override Google audit or visibility rules.
              </p>
            </div>
          ) : pathname === '/sources' ? (
            <div className="space-y-6">
              {error !== undefined && <p className="text-sm text-rose-300">{error}</p>}
              <section className="rounded-xl border border-white/10 bg-slate-950 p-5">
                <h2 className="font-semibold">Add a YouTube upload source</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  Detection uses the YouTube Data API uploads playlist. It does not download video
                  bytes.
                </p>
                <form className="mt-4 grid gap-3" onSubmit={addYouTubeSource}>
                  <select
                    className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                    required
                    value={sourceAccountId}
                    onChange={(event) => setSourceAccountId(event.target.value)}
                  >
                    <option value="">Select connected YouTube account</option>
                    {accounts
                      .filter(
                        (account) =>
                          account.provider === 'youtube' && account.status === 'connected',
                      )
                      .map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.displayName}
                        </option>
                      ))}
                  </select>
                  <input
                    className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                    placeholder="YouTube channel ID"
                    required
                    value={sourceChannelId}
                    onChange={(event) => setSourceChannelId(event.target.value)}
                  />
                  <input
                    className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
                    placeholder="Optional local display name"
                    value={sourceName}
                    onChange={(event) => setSourceName(event.target.value)}
                  />
                  <button
                    className="w-fit rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950"
                    type="submit"
                  >
                    Add source
                  </button>
                </form>
              </section>
              {sources.map((source) => (
                <section
                  className="rounded-xl border border-white/10 bg-slate-950 p-5"
                  key={source.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">{source.displayName}</h2>
                      <p className="mt-1 text-xs text-slate-400">
                        {source.adapterId} · {source.status} · last successful poll:{' '}
                        {source.lastSuccessfulPollAt ?? 'never'}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="rounded border border-cyan-300/30 px-3 py-1 text-xs text-cyan-200"
                        onClick={() => void sourceAction(source.id, 'poll')}
                        type="button"
                      >
                        Poll now
                      </button>
                      <button
                        className="rounded border border-white/15 px-3 py-1 text-xs"
                        onClick={() =>
                          void sourceAction(
                            source.id,
                            source.status === 'active' ? 'pause' : 'resume',
                          )
                        }
                        type="button"
                      >
                        {source.status === 'active' ? 'Pause' : 'Resume'}
                      </button>
                    </div>
                  </div>
                  {source.lastPollErrorMessage !== undefined && (
                    <p className="mt-3 text-sm text-rose-300">
                      Last error ({source.lastPollErrorCode}): {source.lastPollErrorMessage}
                    </p>
                  )}
                  <div className="mt-4 grid gap-2">
                    {(sourceItems[source.id] ?? []).map((item) => (
                      <article className="rounded-lg border border-white/10 p-3" key={item.id}>
                        <p className="font-medium">{item.metadata.title ?? item.externalId}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          Resolution: {item.resolutionStatus} · lifecycle: {item.lifecycleStatus} ·
                          cleanup: {item.cleanupStatus ?? 'not eligible'}
                        </p>
                        {item.resolutionStatus === 'unavailable' && (
                          <p className="mt-2 text-sm text-amber-200">
                            This item cannot be resolved automatically. Link an authorized local
                            original; OpenRepurpose will not download protected or unauthorized
                            content.
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : pathname === '/workflows' ? (
            <div className="space-y-6">
              {error !== undefined && <p className="text-sm text-rose-300">{error}</p>}
              <section className="rounded-xl border border-white/10 bg-slate-950 p-5">
                <h2 className="font-semibold">Create a workflow</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  Select one exact account or Meta publish target. A Meta credential identity is not
                  itself a publish target.
                </p>
                <WorkflowEditor
                  accounts={accounts}
                  metaTargets={metaTargets}
                  onSubmit={createWorkflow}
                  sources={sources}
                />
              </section>
              <section className="rounded-xl border border-white/10 bg-slate-950 p-5">
                <h2 className="font-semibold">Saved workflows</h2>
                <div className="mt-3 grid gap-3">
                  {workflows.map((workflow) => {
                    const route = toWorkflowRouteData(workflow);

                    return (
                      <WorkflowCard
                        destinations={route.destinations}
                        enabled={workflow.enabled}
                        key={workflow.id}
                        name={workflow.name}
                        source={route.source}
                        sourceLabel={
                          workflow.sourceDirectory ||
                          workflow.remoteSource?.connectionId ||
                          'Remote source'
                        }
                        stages={route.stages ?? []}
                      />
                    );
                  })}
                </div>
                {workflows.length === 0 && (
                  <ResourceEmptyState
                    className="mt-3"
                    description="Create a route from a source through any processing stages to one or more destinations."
                    title="No saved workflows"
                  />
                )}
              </section>
            </div>
          ) : pathname === '/setup' ? (
            <SetupPage error={error} tiktokStatus={tiktokStatus} youtubeStatus={youtubeStatus} />
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
                                accounts.find((account) => account.provider === 'tiktok')?.id ?? '',
                              );
                              const capability = Object.values(tiktokCapabilities).find(
                                (view) => view.capabilities !== undefined,
                              )?.capabilities;
                              setPublishPrivacy(capability?.privacyLevelOptions[0] ?? 'SELF_ONLY');
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
                <ResourceEmptyState
                  description="Import a local media file to inspect it and prepare a publish job."
                  title="No local media has been imported yet."
                />
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
                        <span className="text-slate-300">Privacy (offered by this creator)</span>
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
                            <span className="block font-mono text-xs text-slate-500">{job.id}</span>
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
                        <td className="pr-4">
                          <JobStatus status={job.status} />
                        </td>
                        <td className="pr-4">
                          {job.attemptCount}/{job.maxAttempts}
                        </td>
                        <td>
                          {(job.status === 'pending' ||
                            job.status === 'retrying' ||
                            job.status === 'running') && (
                            <Button
                              disabled={job.cancellationRequestedAt !== undefined}
                              onClick={() => void cancelJob(job.id)}
                              size="sm"
                              type="button"
                              variant="danger"
                            >
                              {job.cancellationRequestedAt === undefined ? 'Cancel' : 'Cancelling…'}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {jobs.length === 0 && (
                <ResourceEmptyState
                  description="Jobs will appear here when a workflow or direct publish operation is queued."
                  title="No queued jobs"
                />
              )}
              {selectedJobId !== undefined && (
                <section className="rounded-xl border border-white/10 bg-slate-950 p-4">
                  <h2 className="font-semibold">Attempt history</h2>
                  <p className="mt-1 font-mono text-xs text-slate-500">{selectedJobId}</p>
                  <ol className="mt-4 space-y-2 text-sm">
                    {attempts.map((attempt) => (
                      <li className="rounded-lg bg-white/5 p-3" key={attempt.attemptNumber}>
                        <JobStatus
                          label={`#${attempt.attemptNumber} · ${attempt.status}`}
                          status={attempt.status}
                        />
                        {attempt.errorCode !== undefined && (
                          <span className="block text-xs text-rose-300">
                            {attempt.errorCode}: {attempt.errorMessage}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                  {attempts.length === 0 && (
                    <ResourceEmptyState
                      className="mt-3"
                      description="Attempt details will appear when the selected job begins processing."
                      title="No attempts"
                    />
                  )}
                </section>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              This area will grow in its owning roadmap packet.
            </p>
          )}
        </Workspace>
      </div>
    </ApplicationShell>
  );
}
