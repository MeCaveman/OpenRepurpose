import type { ReactNode } from 'react';

import { ConnectionStatus } from './connection-status';
import type { ConnectionState } from './connection-status';
import { PlatformIdentity } from './platform-identity';

export interface ConnectionCardProps {
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly externalId?: string;
  readonly name: string;
  readonly platform: string;
  readonly status: ConnectionState;
  readonly statusLabel?: string;
}

export function ConnectionCard({
  actions,
  children,
  externalId,
  name,
  platform,
  status,
  statusLabel,
}: ConnectionCardProps) {
  return (
    <article className="rounded-[var(--or-setup-section-radius)] border border-[var(--or-border-subtle)] bg-[var(--or-bg-surface)] p-[var(--or-pane-padding)] text-[var(--or-text-secondary)]">
      <header className="flex flex-wrap items-start justify-between gap-[var(--or-space-3)]">
        <div className="min-w-0">
          <PlatformIdentity label={name} platform={platform} />
          {externalId !== undefined && (
            <p className="mt-[var(--or-space-1)] truncate font-[family-name:var(--or-font-technical)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
              {externalId}
            </p>
          )}
        </div>
        <ConnectionStatus
          {...(statusLabel === undefined ? {} : { label: statusLabel })}
          state={status}
        />
      </header>
      {children !== undefined && (
        <div className="mt-[var(--or-space-4)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
          {children}
        </div>
      )}
      {actions !== undefined && (
        <div className="mt-[var(--or-space-4)] flex flex-wrap gap-[var(--or-space-2)]">
          {actions}
        </div>
      )}
    </article>
  );
}
