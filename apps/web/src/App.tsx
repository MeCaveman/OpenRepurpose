import { useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';

import {
  ApplicationShell,
  PageHeader,
  ResourceNavigation,
  TopCommandBar,
  Workspace,
  type ResourceNavigationItem,
  type WorkspaceMode,
} from './components/layout';
import { AccountsRoute } from './features/accounts';
import { JobsRoute } from './features/jobs';
import { MediaRoute } from './features/media';
import { NotFoundPage } from './features/not-found';
import { OverviewPage } from './features/overview';
import { SettingsPage } from './features/settings';
import { SetupRoute } from './features/setup';
import { SourcesRoute } from './features/sources';
import { WorkflowsRoute } from './features/workflows';

type Navigate = (event: MouseEvent<HTMLAnchorElement>, href: string) => void;

interface RouteDefinition extends ResourceNavigationItem {
  readonly description: string;
  readonly eyebrow: string;
  readonly render: (navigate: Navigate) => ReactNode;
  readonly title: string;
  readonly workspaceMode?: WorkspaceMode;
}

const routes: readonly RouteDefinition[] = [
  {
    href: '/',
    icon: 'dashboard',
    label: 'Dashboard',
    eyebrow: 'Local workspace',
    title: 'Your media pipeline, on your machine.',
    description: 'OpenRepurpose is ready for local setup.',
    render: (navigate) => <OverviewPage onNavigate={navigate} />,
  },
  {
    href: '/setup',
    icon: 'setup',
    label: 'Setup',
    eyebrow: 'System readiness',
    title: 'Setup',
    description: 'Configuration and dependency checks will appear here as capabilities are added.',
    render: () => <SetupRoute />,
    workspaceMode: 'setup',
  },
  {
    href: '/accounts',
    icon: 'accounts',
    label: 'Accounts',
    eyebrow: 'Destinations',
    title: 'Accounts',
    description: 'Configure credentials, publishing targets, and connected platform identities.',
    render: () => <AccountsRoute />,
  },
  {
    href: '/sources',
    icon: 'sources',
    label: 'Sources',
    eyebrow: 'Remote ingestion',
    title: 'Sources',
    description: 'Poll authorized remote accounts and inspect their media lifecycle.',
    render: (navigate) => (
      <SourcesRoute onNavigateAccounts={(event) => navigate(event, '/accounts')} />
    ),
  },
  {
    href: '/media',
    icon: 'media',
    label: 'Media',
    eyebrow: 'Local library',
    title: 'Media',
    description: 'Import local files and inspect persisted ffprobe details.',
    render: () => <MediaRoute />,
  },
  {
    href: '/workflows',
    icon: 'workflows',
    label: 'Workflows',
    eyebrow: 'Automation',
    title: 'Workflows',
    description: 'Build and review durable source-to-destination routes.',
    render: () => <WorkflowsRoute />,
  },
  {
    href: '/jobs',
    icon: 'jobs',
    label: 'Jobs',
    eyebrow: 'Execution history',
    title: 'Jobs',
    description: 'Inspect persisted work, attempts, and actionable execution errors.',
    render: () => <JobsRoute />,
  },
  {
    href: '/settings',
    icon: 'settings',
    label: 'Settings',
    eyebrow: 'Local configuration',
    title: 'Settings',
    description: 'Find the current owners of local system and integration configuration.',
    render: (navigate) => <SettingsPage onNavigate={navigate} />,
    workspaceMode: 'setup',
  },
];

const navigation: readonly ResourceNavigationItem[] = routes.map(({ href, icon, label }) => ({
  href,
  icon,
  label,
}));

const notFoundRoute = {
  eyebrow: 'Not found',
  title: 'This local view does not exist.',
  description: 'Choose a section from the navigation to continue.',
  render: (navigate: Navigate) => <NotFoundPage onNavigate={navigate} />,
  workspaceMode: 'setup' as const,
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
  const route = routes.find((candidate) => candidate.href === pathname) ?? notFoundRoute;
  const navigate: Navigate = (event, href) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    window.history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
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
              description={route.description}
              eyebrow={route.eyebrow}
              title={route.title}
              titleId="workspace-title"
            />
          }
          labelledBy="workspace-title"
          mode={route.workspaceMode ?? 'default'}
        >
          {route.render(navigate)}
        </Workspace>
      </div>
    </ApplicationShell>
  );
}
