import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

import { cx } from './utils';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly description?: ReactNode;
  readonly error?: string;
  readonly label: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, description, disabled, error, id: providedId, label, ...props },
  ref,
) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <label
      className={cx(
        'grid min-h-[var(--or-target-min)] cursor-pointer grid-cols-[var(--or-target-min)_minmax(0,1fr)] items-start text-[var(--or-text-secondary)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-[var(--or-disabled-opacity)]',
        className,
      )}
      htmlFor={id}
    >
      <span className="relative grid size-[var(--or-target-min)] place-items-center">
        <input
          {...props}
          aria-describedby={describedBy}
          aria-invalid={error === undefined ? undefined : true}
          className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-[var(--or-field-radius)] disabled:cursor-not-allowed"
          disabled={disabled}
          id={id}
          ref={ref}
          type="checkbox"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none grid size-[var(--or-icon-default)] place-items-center rounded-[var(--or-radius-xs)] border border-[var(--or-control-border)] bg-[var(--or-control-bg)] text-[var(--or-action-primary-fg)] transition-[background-color,border-color,opacity] duration-[var(--or-duration-fast)] peer-checked:border-[var(--or-action-primary-bg)] peer-checked:bg-[var(--or-action-primary-bg)] peer-checked:[&_svg]:opacity-100 peer-focus-visible:border-[var(--or-focus-ring)] peer-focus-visible:outline peer-focus-visible:outline-[var(--or-focus-width)] peer-focus-visible:outline-offset-[var(--or-focus-offset)] peer-focus-visible:[outline-color:var(--or-focus-ring)]"
        >
          <svg
            aria-hidden="true"
            className="size-[var(--or-icon-sm)] opacity-0"
            fill="none"
            viewBox="0 0 12 12"
          >
            <path d="m2.25 6.1 2.2 2.15 5.3-5" stroke="currentColor" strokeWidth="1.75" />
          </svg>
        </span>
      </span>
      <span className="py-[var(--or-space-2)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
        <span className="block">{label}</span>
        {description !== undefined && (
          <span
            className="mt-[var(--or-space-0-5)] block text-[var(--or-text-tertiary)]"
            id={descriptionId}
          >
            {description}
          </span>
        )}
        {error !== undefined && (
          <span
            className="mt-[var(--or-space-0-5)] block text-[var(--or-status-danger-fg)]"
            id={errorId}
          >
            {error}
          </span>
        )}
      </span>
    </label>
  );
});
