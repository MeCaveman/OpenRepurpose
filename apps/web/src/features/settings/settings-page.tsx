import type { MouseEvent } from 'react';

import { Alert, Badge, Panel } from '../../components/ui';

export interface SettingsPageProps {
  readonly onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}

const configurationAreas = [
  {
    action: 'Review setup',
    description:
      'Check platform credential readiness and the OAuth callback addresses used by this installation.',
    href: '/setup',
    label: 'System readiness',
    scope: 'Setup',
  },
  {
    action: 'Manage accounts',
    description:
      'Configure provider credentials, connected identities, and available publishing targets.',
    href: '/accounts',
    label: 'Platform connections',
    scope: 'Accounts',
  },
  {
    action: 'Manage models',
    description:
      'Choose which local transcription models occupy disk space and inspect their integrity.',
    href: '/models',
    label: 'Local transcription models',
    scope: 'Models',
  },
  {
    action: 'Manage workflows',
    description:
      'Keep source, processing, and destination behavior attached to each durable automation route.',
    href: '/workflows',
    label: 'Route behavior',
    scope: 'Workflows',
  },
] as const;

const installationPolicy = [
  { label: 'Deployment', value: 'Local, self-hosted installation' },
  { label: 'Network scope', value: 'Loopback only in v0.5' },
  { label: 'Application state', value: 'Stored on this installation' },
  { label: 'Telemetry', value: 'Off by default' },
] as const;

export function SettingsPage({ onNavigate }: SettingsPageProps) {
  return (
    <div className="space-y-[var(--or-setup-section-gap)]">
      <section aria-labelledby="configuration-ownership-title">
        <h2
          className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
          id="configuration-ownership-title"
        >
          Configuration ownership
        </h2>
        <p className="mt-[var(--or-space-2)] max-w-[var(--or-empty-state-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
          OpenRepurpose keeps settings beside the resource they control. Use this ledger to reach
          the configuration surfaces owned by each local resource.
        </p>

        <Panel className="mt-[var(--or-space-5)]" padding="none" surface="surface">
          <ul
            aria-label="Configuration areas"
            className="divide-y divide-[var(--or-border-subtle)]"
          >
            {configurationAreas.map((area) => (
              <li key={area.href}>
                <a
                  className="group grid min-h-[var(--or-row-comfortable-height)] gap-[var(--or-space-3)] px-[var(--or-pane-padding)] py-[var(--or-space-4)] text-[var(--or-text-secondary)] transition-[background-color,color] duration-[var(--or-duration-fast)] ease-[var(--or-ease-out)] hover:bg-[var(--or-bg-hover)] active:bg-[var(--or-bg-selected)] motion-reduce:transition-none sm:grid-cols-[var(--or-shell-navigator-min-width)_minmax(0,1fr)_auto] sm:items-center sm:gap-[var(--or-space-4)]"
                  href={area.href}
                  onClick={(event) => onNavigate(event, area.href)}
                >
                  <span className="flex items-center gap-[var(--or-space-3)] sm:block">
                    <Badge variant="accent">{area.scope}</Badge>
                    <span className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)] sm:mt-[var(--or-space-2)] sm:block">
                      {area.label}
                    </span>
                  </span>
                  <span className="text-pretty text-[var(--or-text-tertiary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
                    {area.description}
                  </span>
                  <span className="flex min-h-[var(--or-target-min)] items-center gap-[var(--or-space-2)] font-medium text-[var(--or-text-link)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
                    {area.action}
                    <span
                      aria-hidden="true"
                      className="transition-transform duration-[var(--or-duration-fast)] ease-[var(--or-ease-out)] group-hover:translate-x-[var(--or-motion-distance-sm)] motion-reduce:transform-none"
                    >
                      →
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <section aria-labelledby="installation-policy-title">
        <h2
          className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
          id="installation-policy-title"
        >
          Installation policy
        </h2>
        <p className="mt-[var(--or-space-2)] max-w-[var(--or-empty-state-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
          These are current product boundaries, not inferred live system status or editable
          controls.
        </p>

        <Panel className="mt-[var(--or-space-5)]" padding="none" surface="inset">
          <dl className="divide-y divide-[var(--or-border-subtle)]">
            {installationPolicy.map((item) => (
              <div
                className="grid gap-[var(--or-space-1)] px-[var(--or-pane-padding)] py-[var(--or-space-3)] sm:grid-cols-[var(--or-shell-navigator-min-width)_minmax(0,1fr)] sm:gap-[var(--or-space-4)]"
                key={item.label}
              >
                <dt className="font-medium text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
                  {item.label}
                </dt>
                <dd className="text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      </section>

      <Alert title="No in-app global preference controls" variant="neutral">
        Current configuration remains with setup, accounts, models, and workflows. Host-level paths
        continue to use typed environment configuration.
      </Alert>
    </div>
  );
}
