import { createElement, useId } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

import { Panel } from './panel';
import { cx } from './utils';

export interface ErrorStateProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  readonly action?: ReactNode;
  readonly description: ReactNode;
  readonly headingLevel?: 1 | 2 | 3;
  readonly title: ReactNode;
}

export function ErrorState({
  action,
  className,
  description,
  headingLevel = 2,
  title,
  ...props
}: ErrorStateProps) {
  const generatedId = useId();
  const headingId = props['aria-labelledby'] ?? `${generatedId}-title`;

  return (
    <Panel
      {...props}
      aria-labelledby={headingId}
      className={cx(
        'w-full max-w-[var(--or-empty-state-max-width)] border-[var(--or-status-danger-border)]',
        className,
      )}
      padding="setup"
      role="alert"
      surface="raised"
    >
      <p className="font-semibold tracking-[var(--or-tracking-overline)] text-[var(--or-status-danger-fg)] uppercase [font-size:var(--or-type-metadata-size)]">
        Interface error
      </p>
      {createElement(
        `h${headingLevel}`,
        {
          className:
            'mt-[var(--or-space-3)] font-semibold tracking-[var(--or-tracking-page)] text-[var(--or-text-primary)] [font-size:var(--or-type-title-size)] [line-height:var(--or-type-title-line)]',
          id: headingId,
        },
        title,
      )}
      <div className="mt-[var(--or-space-3)] text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
        {description}
      </div>
      {action !== undefined && <div className="mt-[var(--or-space-6)]">{action}</div>}
    </Panel>
  );
}
