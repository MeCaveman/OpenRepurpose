import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './utils';

export type AlertVariant = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  readonly action?: ReactNode;
  readonly title?: ReactNode;
  readonly variant?: AlertVariant;
}

const variants: Record<AlertVariant, string> = {
  neutral:
    'border-[var(--or-status-neutral-border)] bg-[var(--or-status-neutral-bg)] text-[var(--or-status-neutral-fg)]',
  info: 'border-[var(--or-status-info-border)] bg-[var(--or-status-info-bg)] text-[var(--or-status-info-fg)]',
  success:
    'border-[var(--or-status-success-border)] bg-[var(--or-status-success-bg)] text-[var(--or-status-success-fg)]',
  warning:
    'border-[var(--or-status-warning-border)] bg-[var(--or-status-warning-bg)] text-[var(--or-status-warning-fg)]',
  error:
    'border-[var(--or-status-danger-border)] bg-[var(--or-status-danger-bg)] text-[var(--or-status-danger-fg)]',
};

export function Alert({
  action,
  children,
  className,
  role,
  title,
  variant = 'neutral',
  ...props
}: AlertProps) {
  return (
    <div
      {...props}
      className={cx(
        'rounded-[var(--or-alert-radius)] border px-[var(--or-alert-padding-inline)] py-[var(--or-alert-padding-block)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]',
        variants[variant],
        className,
      )}
      role={role ?? (variant === 'error' ? 'alert' : undefined)}
    >
      {title !== undefined && <p className="font-semibold text-current">{title}</p>}
      <div
        className={cx(
          'text-[var(--or-text-secondary)]',
          title !== undefined && 'mt-[var(--or-space-1)]',
        )}
      >
        {children}
      </div>
      {action !== undefined && <div className="mt-[var(--or-space-3)]">{action}</div>}
    </div>
  );
}
