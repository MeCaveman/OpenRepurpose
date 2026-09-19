import type { HTMLAttributes } from 'react';

import { cx } from './utils';

export type BadgeProps = HTMLAttributes<HTMLSpanElement>;

export function Badge({ className, ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={cx(
        'inline-flex h-[var(--or-status-badge-height)] items-center rounded-[var(--or-status-badge-radius)] border border-[var(--or-status-neutral-border)] bg-[var(--or-status-neutral-bg)] px-[var(--or-space-2)] text-[var(--or-status-neutral-fg)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]',
        className,
      )}
    />
  );
}
