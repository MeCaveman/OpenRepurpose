import type { MouseEvent } from 'react';

import { Alert, Panel } from '../../components/ui';

export interface OverviewPageProps {
  readonly onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}

const routeSteps = [
  {
    description: 'Choose an authorized remote account or local input for media ingestion.',
    href: '/sources',
    label: 'Sources',
  },
  {
    description: 'Define how media moves from its source to one or more publishing targets.',
    href: '/workflows',
    label: 'Workflows',
  },
  {
    description: 'Connect and verify the platform accounts that receive published media.',
    href: '/accounts',
    label: 'Destinations',
  },
] as const;

export function OverviewPage({ onNavigate }: OverviewPageProps) {
  return (
    <div className="space-y-[var(--or-space-8)]">
      <section aria-labelledby="route-start-title">
        <div>
          <p className="font-semibold tracking-[var(--or-tracking-overline)] text-[var(--or-text-link)] uppercase [font-size:var(--or-type-micro-size)] [line-height:var(--or-type-micro-line)]">
            Start a route
          </p>
          <h2
            className="mt-[var(--or-space-2)] font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
            id="route-start-title"
          >
            Move media through the local workbench
          </h2>
          <p className="mt-[var(--or-space-2)] max-w-[var(--or-empty-state-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
            Begin with the three resources that define every OpenRepurpose route.
          </p>
        </div>

        <Panel className="mt-[var(--or-space-5)]" padding="none" surface="surface">
          <ol
            aria-label="Route setup sequence"
            className="divide-y divide-[var(--or-border-subtle)]"
          >
            {routeSteps.map((step, index) => (
              <li key={step.href}>
                <a
                  className="group grid min-h-[var(--or-row-comfortable-height)] grid-cols-[var(--or-control-compact-height)_minmax(0,1fr)_var(--or-icon-lg)] items-center gap-[var(--or-space-3)] px-[var(--or-pane-padding)] py-[var(--or-space-3)] text-[var(--or-text-secondary)] transition-[background-color,color] duration-[var(--or-duration-fast)] ease-[var(--or-ease-out)] hover:bg-[var(--or-bg-hover)] active:bg-[var(--or-bg-selected)] motion-reduce:transition-none sm:gap-[var(--or-space-4)]"
                  href={step.href}
                  onClick={(event) => onNavigate(event, step.href)}
                >
                  <span
                    aria-hidden="true"
                    className="grid size-[var(--or-control-compact-height)] place-items-center rounded-[var(--or-radius-sm)] border border-[var(--or-border-selected)] bg-[var(--or-bg-selected)] font-mono text-[var(--or-text-link)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
                      {step.label}
                    </span>
                    <span className="mt-[var(--or-space-1)] block text-pretty text-[var(--or-text-tertiary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
                      {step.description}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-[var(--or-text-tertiary)] transition-[color,transform] duration-[var(--or-duration-fast)] ease-[var(--or-ease-out)] group-hover:translate-x-[var(--or-motion-distance-sm)] group-hover:text-[var(--or-text-link)] motion-reduce:transform-none"
                  >
                    →
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </Panel>
      </section>

      <Alert title="Local-first operation" variant="neutral">
        OpenRepurpose keeps its application state on this installation. Review{' '}
        <a
          className="font-medium text-[var(--or-text-link)] underline decoration-[var(--or-border-selected)] underline-offset-4"
          href="/setup"
          onClick={(event) => onNavigate(event, '/setup')}
        >
          setup readiness
        </a>{' '}
        before connecting publishing accounts.
      </Alert>
    </div>
  );
}
