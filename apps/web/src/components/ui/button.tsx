import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

import { Spinner } from './spinner';
import { cx } from './utils';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly isLoading?: boolean;
  readonly loadingLabel?: string;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
}

const variants: Record<ButtonVariant, string> = {
  primary:
    'border-transparent bg-[var(--or-action-primary-bg)] text-[var(--or-action-primary-fg)] hover:bg-[var(--or-action-primary-bg-hover)] active:bg-[var(--or-action-primary-bg-active)]',
  secondary:
    'border-[var(--or-border-default)] bg-[var(--or-action-secondary-bg)] text-[var(--or-action-secondary-fg)] hover:border-[var(--or-border-strong)] hover:bg-[var(--or-action-secondary-bg-hover)]',
  ghost:
    'border-transparent bg-transparent text-[var(--or-action-ghost-fg)] hover:bg-[var(--or-action-ghost-bg-hover)]',
  danger:
    'border-transparent bg-[var(--or-action-danger-bg)] text-[var(--or-action-danger-fg)] hover:bg-[var(--or-action-danger-bg-hover)]',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-[var(--or-button-height-sm)] gap-[var(--or-button-gap-sm)] px-[var(--or-button-padding-inline-sm)] [font-size:var(--or-button-font-sm)]',
  md: 'h-[var(--or-button-height-md)] gap-[var(--or-button-gap-md)] px-[var(--or-button-padding-inline-md)] [font-size:var(--or-button-font-md)]',
  lg: 'h-[var(--or-button-height-lg)] gap-[var(--or-button-gap-md)] px-[var(--or-button-padding-inline-lg)] [font-size:var(--or-button-font-md)]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    disabled,
    isLoading = false,
    loadingLabel,
    size = 'md',
    type = 'button',
    variant = 'secondary',
    ...props
  },
  ref,
) {
  const content = isLoading && loadingLabel !== undefined ? loadingLabel : children;

  return (
    <button
      {...props}
      aria-busy={isLoading || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-[var(--or-button-radius)] border font-medium whitespace-nowrap transition-[background-color,border-color,color,opacity,transform] duration-[var(--or-duration-fast)] ease-[var(--or-ease-out)] active:scale-[var(--or-motion-press-scale)] disabled:cursor-not-allowed disabled:opacity-[var(--or-disabled-opacity)] motion-reduce:transform-none',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || isLoading}
      ref={ref}
      type={type}
    >
      {isLoading && <Spinner size="sm" />}
      {content}
    </button>
  );
});
