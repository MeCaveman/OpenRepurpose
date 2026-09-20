import type { HTMLAttributes } from 'react';

import { getPlatformMetadata } from './platform-metadata';

export interface PlatformIdentityProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  readonly label?: string;
  readonly platform: string;
  readonly showLabel?: boolean;
  readonly size?: 'sm' | 'md';
}

const markSizes = {
  sm: 'size-[var(--or-platform-mark-size-sm)] [font-size:var(--or-type-micro-size)]',
  md: 'size-[var(--or-platform-mark-size-md)] [font-size:var(--or-type-metadata-size)]',
} as const;

export function PlatformIdentity({
  className,
  label,
  platform,
  showLabel = true,
  size = 'md',
  ...props
}: PlatformIdentityProps) {
  const metadata = getPlatformMetadata(platform);
  const accessibleLabel = label?.trim() || metadata.label;

  return (
    <span
      {...props}
      aria-label={showLabel ? undefined : accessibleLabel}
      className={`inline-flex min-w-0 items-center gap-[var(--or-space-2)] text-[var(--or-text-secondary)] ${className ?? ''}`}
    >
      <span
        aria-hidden="true"
        className={`grid shrink-0 place-items-center rounded-[var(--or-radius-sm)] border border-[var(--or-border-default)] bg-[var(--or-bg-selected)] font-semibold text-[var(--or-text-link)] opacity-[var(--or-platform-identity-opacity)] ${markSizes[size]}`}
      >
        {metadata.mark}
      </span>
      {showLabel && (
        <span className="min-w-0 break-words [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
          {accessibleLabel}
        </span>
      )}
    </span>
  );
}
