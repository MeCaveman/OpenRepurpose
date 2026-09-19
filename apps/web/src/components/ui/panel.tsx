import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';

import { cx } from './utils';

export type PanelSurface = 'surface' | 'raised' | 'inset';
export type PanelPadding = 'none' | 'compact' | 'default' | 'setup';

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  readonly padding?: PanelPadding;
  readonly surface?: PanelSurface;
}

const surfaces: Record<PanelSurface, string> = {
  surface: 'bg-[var(--or-bg-surface)]',
  raised: 'bg-[var(--or-bg-surface-raised)]',
  inset: 'bg-[var(--or-bg-workspace)]',
};

const paddings: Record<PanelPadding, string> = {
  none: '',
  compact: 'p-[var(--or-pane-padding-compact)]',
  default: 'p-[var(--or-pane-padding)]',
  setup: 'p-[var(--or-setup-section-padding)]',
};

export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  { className, padding = 'default', surface = 'surface', ...props },
  ref,
) {
  return (
    <section
      {...props}
      className={cx(
        'rounded-[var(--or-setup-section-radius)] border border-[var(--or-border-subtle)] text-[var(--or-text-secondary)]',
        surfaces[surface],
        paddings[padding],
        className,
      )}
      ref={ref}
    />
  );
});
