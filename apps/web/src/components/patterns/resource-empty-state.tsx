import type { HTMLAttributes, ReactNode } from 'react';

import { Panel } from '../ui';

export interface ResourceEmptyStateProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'children' | 'title'
> {
  readonly action?: ReactNode;
  readonly description: ReactNode;
  readonly title: ReactNode;
}

export function ResourceEmptyState({
  action,
  className,
  description,
  title,
  ...props
}: ResourceEmptyStateProps) {
  return (
    <Panel
      {...props}
      className={`max-w-[var(--or-empty-state-max-width)] ${className ?? ''}`}
      surface="inset"
    >
      <h3 className="font-medium text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
        {title}
      </h3>
      <div className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
        {description}
      </div>
      {action !== undefined && <div className="mt-[var(--or-space-4)]">{action}</div>}
    </Panel>
  );
}
