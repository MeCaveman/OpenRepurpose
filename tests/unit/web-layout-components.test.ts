import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ApplicationShell,
  PageHeader,
  ResourceNavigation,
  TopCommandBar,
  Workspace,
} from '../../apps/web/src/components/layout/index';

function renderShell(
  shellProps: Partial<Parameters<typeof ApplicationShell>[0]> = {},
  workspaceProps: Partial<Parameters<typeof Workspace>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(
      ApplicationShell,
      {
        commandBar: createElement(TopCommandBar),
        ...shellProps,
      },
      createElement(
        Workspace,
        {
          header: createElement(PageHeader, {
            description: 'Route local media through connected destinations.',
            eyebrow: 'Workbench',
            title: 'Overview',
            titleId: 'workspace-title',
          }),
          labelledBy: 'workspace-title',
          ...workspaceProps,
        },
        createElement('p', null, 'Workspace content'),
      ),
    ),
  );
}

describe('web layout components', () => {
  it('connects the command bar, skip link, page heading, and workspace semantics', () => {
    const markup = renderShell();

    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain('OpenRepurpose');
    expect(markup).toContain('Local only');
    expect(markup).toContain('id="main-content"');
    expect(markup).toContain('aria-labelledby="workspace-title"');
    expect(markup).toContain('id="workspace-title"');
    expect(markup).toContain('Route local media through connected destinations.');
  });

  it('does not render optional panes when they have no current purpose', () => {
    const markup = renderShell();

    expect(markup).not.toContain('data-shell-region="resource-rail"');
    expect(markup).not.toContain('data-shell-region="navigator"');
    expect(markup).not.toContain('data-shell-region="inspector"');
    expect(markup).not.toContain('data-shell-region="activity"');
  });

  it('keeps the inspector closed until explicitly opened', () => {
    const closedMarkup = renderShell({ inspector: createElement('p', null, 'Details') });
    const openMarkup = renderShell({
      inspector: createElement('p', null, 'Details'),
      inspectorOpen: true,
    });

    expect(closedMarkup).not.toContain('data-shell-region="inspector"');
    expect(openMarkup).toContain('data-shell-region="inspector"');
    expect(openMarkup).toContain('Details');
  });

  it('exposes controlled collapsed and expanded activity states', () => {
    const collapsedMarkup = renderShell({
      activityShelf: createElement('p', null, 'No current activity'),
    });
    const expandedMarkup = renderShell({
      activityShelf: createElement('p', null, 'One job processing'),
      activityShelfExpanded: true,
    });

    expect(collapsedMarkup).toContain('data-shell-region="activity"');
    expect(collapsedMarkup).toContain('data-state="collapsed"');
    expect(expandedMarkup).toContain('data-state="expanded"');
    expect(expandedMarkup).toContain('One job processing');
  });

  it('uses the narrower setup composition without changing workspace semantics', () => {
    const markup = renderShell({}, { mode: 'setup' });

    expect(markup).toContain('max-w-[var(--or-setup-content-max-width)]');
    expect(markup).toContain('id="main-content"');
  });

  it('renders accessible rail navigation with a redundant active-state cue', () => {
    const markup = renderToStaticMarkup(
      createElement(ResourceNavigation, {
        currentPath: '/workflows',
        items: [
          { href: '/', icon: 'dashboard', label: 'Dashboard' },
          { href: '/workflows', icon: 'workflows', label: 'Workflows' },
        ],
        mode: 'rail',
        onNavigate: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Primary navigation"');
    expect(markup).toContain('data-navigation-mode="rail"');
    expect(markup).toContain('href="/workflows"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('title="Workflows"');
    expect(markup).toContain('var(--or-nav-active-edge-width)');
    expect(markup).toContain('>Workflows</span>');
  });

  it('keeps compact navigation labels visible with mobile-sized targets', () => {
    const markup = renderToStaticMarkup(
      createElement(ResourceNavigation, {
        currentPath: '/',
        items: [{ href: '/', icon: 'dashboard', label: 'Dashboard' }],
        mode: 'compact',
        onNavigate: () => undefined,
      }),
    );

    expect(markup).toContain('data-navigation-mode="compact"');
    expect(markup).toContain('min-h-[var(--or-target-mobile)]');
    expect(markup).toContain('>Dashboard</span>');
    expect(markup).not.toContain('title="Dashboard"');
  });
});
