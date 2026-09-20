import type { ProgressHTMLAttributes } from 'react';

import { cx } from './utils';

export interface ProgressProps extends ProgressHTMLAttributes<HTMLProgressElement> {
  readonly value?: number;
}

/** Native, theme-aware progress for durable jobs and other measurable local work. */
export function Progress({ className, max = 100, value, ...props }: ProgressProps) {
  const normalizedValue =
    value === undefined ? undefined : Math.min(Number(max) || 100, Math.max(0, value));

  return (
    <progress
      {...props}
      className={cx(
        'h-[var(--or-space-1-5)] w-full overflow-hidden rounded-[var(--or-radius-round)] bg-[var(--or-bg-control)] accent-[var(--or-action-primary-bg)] [&::-moz-progress-bar]:bg-[var(--or-action-primary-bg)] [&::-webkit-progress-bar]:bg-[var(--or-bg-control)] [&::-webkit-progress-value]:bg-[var(--or-action-primary-bg)]',
        className,
      )}
      max={max}
      {...(normalizedValue === undefined ? {} : { value: normalizedValue })}
    />
  );
}
