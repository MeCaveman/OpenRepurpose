import type { HTMLAttributes } from 'react';

import { cx } from './utils';

export type BadgeVariant = 'neutral' | 'info' | 'success' | 'warning' | 'error' | 'accent';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly variant?: BadgeVariant;
}

const variants: Record<BadgeVariant, string> = {
  neutral:
    'border-[var(--or-status-neutral-border)] bg-[var(--or-status-neutral-bg)] text-[var(--or-status-neutral-fg)]',
  info: 'border-[var(--or-status-info-border)] bg-[var(--or-status-info-bg)] text-[var(--or-status-info-fg)]',
  success:
    'border-[var(--or-status-success-border)] bg-[var(--or-status-success-bg)] text-[var(--or-status-success-fg)]',
  warning:
    'border-[var(--or-status-warning-border)] bg-[var(--or-status-warning-bg)] text-[var(--or-status-warning-fg)]',
  error:
    'border-[var(--or-status-danger-border)] bg-[var(--or-status-danger-bg)] text-[var(--or-status-danger-fg)]',
  accent:
    'border-[var(--or-border-selected)] bg-[var(--or-bg-selected)] text-[var(--or-text-link)]',
};

export function Badge({ className, variant = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={cx(
        'inline-flex h-[var(--or-status-badge-height)] items-center rounded-[var(--or-status-badge-radius)] border px-[var(--or-space-2)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]',
        variants[variant],
        className,
      )}
    />
  );
}
