import type { ReactNode } from 'react';

import { SkipLink } from './skip-link';

export interface ApplicationShellProps {
  readonly activityShelf?: ReactNode;
  readonly activityShelfExpanded?: boolean;
  readonly children: ReactNode;
  readonly commandBar: ReactNode;
  readonly inspector?: ReactNode;
  readonly inspectorOpen?: boolean;
  readonly navigator?: ReactNode;
  readonly resourceRail?: ReactNode;
}

export function ApplicationShell({
  activityShelf,
  activityShelfExpanded = false,
  children,
  commandBar,
  inspector,
  inspectorOpen = false,
  navigator,
  resourceRail,
}: ApplicationShellProps) {
  const showInspector = inspector !== undefined && inspectorOpen;

  return (
    <div className="flex min-h-dvh min-w-0 flex-col bg-[var(--or-bg-shell)] text-[var(--or-text-secondary)]">
      <SkipLink />
      {commandBar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
          {resourceRail !== undefined && (
            <aside
              className="hidden w-[var(--or-shell-rail-width)] shrink-0 border-r border-[var(--or-border-subtle)] bg-[var(--or-bg-shell)] lg:block"
              data-shell-region="resource-rail"
            >
              {resourceRail}
            </aside>
          )}
          {navigator !== undefined && (
            <aside
              className="hidden w-[var(--or-shell-navigator-width)] min-w-[var(--or-shell-navigator-min-width)] max-w-[var(--or-shell-navigator-max-width)] shrink-0 overflow-y-auto border-r border-[var(--or-border-subtle)] bg-[var(--or-bg-navigator)] lg:block"
              data-shell-region="navigator"
            >
              {navigator}
            </aside>
          )}
          <div className="min-w-0 flex-1">{children}</div>
          {showInspector && (
            <aside
              className="hidden w-[var(--or-shell-inspector-width)] min-w-[var(--or-shell-inspector-min-width)] max-w-[var(--or-shell-inspector-max-width)] shrink-0 overflow-y-auto border-l border-[var(--or-border-subtle)] bg-[var(--or-bg-inspector)] min-[90rem]:block"
              data-shell-region="inspector"
            >
              {inspector}
            </aside>
          )}
        </div>
        {activityShelf !== undefined && (
          <section
            aria-label="Activity"
            className={
              activityShelfExpanded
                ? 'max-h-[var(--or-shell-activity-max-height)] min-h-[var(--or-shell-activity-default-height)] overflow-y-auto border-t border-[var(--or-border-subtle)] bg-[var(--or-bg-navigator)]'
                : 'h-[var(--or-shell-activity-collapsed-height)] overflow-hidden border-t border-[var(--or-border-subtle)] bg-[var(--or-bg-navigator)]'
            }
            data-shell-region="activity"
            data-state={activityShelfExpanded ? 'expanded' : 'collapsed'}
          >
            {activityShelf}
          </section>
        )}
      </div>
    </div>
  );
}
