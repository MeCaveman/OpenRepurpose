import type { MouseEvent } from 'react';

import { Panel } from '../../components/ui';

export interface NotFoundPageProps {
  readonly onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}

export function NotFoundPage({ onNavigate }: NotFoundPageProps) {
  return (
    <Panel aria-labelledby="not-found-recovery-heading" padding="setup" surface="inset">
      <h2
        className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
        id="not-found-recovery-heading"
      >
        Return to the local workbench
      </h2>
      <p className="mt-[var(--or-space-2)] max-w-[var(--or-empty-state-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
        This address is not one of the current OpenRepurpose views. Your local files, workflows, and
        jobs are unaffected.
      </p>
      <a
        className="mt-[var(--or-space-5)] inline-flex min-h-[var(--or-target-min)] items-center gap-[var(--or-space-2)] rounded-[var(--or-radius-sm)] font-medium text-[var(--or-text-link)] underline decoration-[var(--or-border-selected)] underline-offset-4"
        href="/"
        onClick={(event) => onNavigate(event, '/')}
      >
        Open Dashboard
        <span aria-hidden="true">→</span>
      </a>
    </Panel>
  );
}
