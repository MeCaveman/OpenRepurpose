import type { HTMLAttributes } from 'react';

import { cx } from './utils';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  readonly label?: string;
  readonly size?: 'sm' | 'md';
}

const sizes = {
  sm: 'size-[var(--or-button-icon-sm)] border-[1.5px]',
  md: 'size-[var(--or-button-icon-md)] border-[2px]',
} as const;

export function Spinner({ className, label, size = 'md', ...props }: SpinnerProps) {
  return (
    <span
      {...props}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      className={cx(
        'inline-block shrink-0 animate-spin rounded-full border-current border-r-transparent motion-reduce:animate-none',
        sizes[size],
        className,
      )}
      role={label === undefined ? undefined : 'status'}
    />
  );
}
