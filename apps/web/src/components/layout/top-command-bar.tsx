import type { MouseEventHandler, ReactNode } from 'react';

import { Badge } from '../ui';

export interface TopCommandBarProps {
  readonly actions?: ReactNode;
  readonly homeHref?: string;
  readonly onHomeClick?: MouseEventHandler<HTMLAnchorElement>;
  readonly statusLabel?: string;
}

export function TopCommandBar({
  actions,
  homeHref = '/',
  onHomeClick,
  statusLabel = 'Local only',
}: TopCommandBarProps) {
  return (
    <header className="relative z-[var(--or-z-shell)] flex h-[var(--or-shell-topbar-height)] shrink-0 items-center justify-between border-b border-[var(--or-border-subtle)] bg-[var(--or-bg-shell)] px-[var(--or-space-3)] sm:px-[var(--or-space-4)]">
      <a
        className="flex min-h-[var(--or-target-min)] min-w-0 items-center gap-[var(--or-space-2)] rounded-[var(--or-radius-sm)] px-[var(--or-space-1)] text-[var(--or-text-primary)] transition-[background-color,color] duration-[var(--or-duration-fast)] hover:bg-[var(--or-bg-hover)] active:bg-[var(--or-bg-selected)] motion-reduce:transition-none"
        href={homeHref}
        onClick={onHomeClick}
      >
        <span
          aria-hidden="true"
          className="grid size-[var(--or-icon-xl)] shrink-0 place-items-center rounded-[var(--or-radius-sm)] border border-[var(--or-border-selected)] bg-[var(--or-bg-selected)] font-bold text-[var(--or-text-link)] [font-size:var(--or-type-micro-size)]"
        >
          OR
        </span>
        <span className="min-w-0">
          <span className="block truncate font-semibold [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
            OpenRepurpose
          </span>
          <span className="hidden truncate text-[var(--or-text-tertiary)] [font-size:var(--or-type-micro-size)] [line-height:var(--or-type-micro-line)] sm:block">
            Local media automation
          </span>
        </span>
      </a>
      <div className="flex items-center gap-[var(--or-space-2)]">
        {actions}
        <Badge variant="neutral">{statusLabel}</Badge>
      </div>
    </header>
  );
}
