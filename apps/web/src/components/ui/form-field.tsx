import { cloneElement, useId } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { cx } from './utils';

type FormControlProps = {
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean | 'false' | 'true';
  readonly id?: string;
  readonly required?: boolean;
};

export interface FormFieldProps {
  readonly children: ReactElement<FormControlProps>;
  readonly className?: string;
  readonly description?: ReactNode;
  readonly error?: string;
  readonly label: ReactNode;
  readonly required?: boolean;
}

export function FormField({
  children,
  className,
  description,
  error,
  label,
  required = false,
}: FormFieldProps) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [children.props['aria-describedby'], descriptionId, errorId]
    .filter(Boolean)
    .join(' ');
  const control = cloneElement(children, {
    id,
    required: children.props.required ?? required,
    ...(describedBy.length === 0 ? {} : { 'aria-describedby': describedBy }),
    ...(error !== undefined
      ? { 'aria-invalid': true as const }
      : children.props['aria-invalid'] === undefined
        ? {}
        : { 'aria-invalid': children.props['aria-invalid'] }),
  });

  return (
    <div className={cx('grid gap-[var(--or-field-internal-gap)]', className)}>
      <label
        className="font-medium text-[var(--or-text-secondary)] [font-size:var(--or-field-label-size)] [line-height:var(--or-field-label-line)]"
        htmlFor={id}
      >
        {label}
        {required && (
          <span aria-hidden="true" className="text-[var(--or-status-danger-fg)]">
            {' '}
            *
          </span>
        )}
      </label>
      {control}
      {description !== undefined && (
        <p
          className="text-[var(--or-text-tertiary)] [font-size:var(--or-field-help-size)] [line-height:var(--or-field-help-line)]"
          id={descriptionId}
        >
          {description}
        </p>
      )}
      {error !== undefined && (
        <p
          className="text-[var(--or-status-danger-fg)] [font-size:var(--or-field-help-size)] [line-height:var(--or-field-help-line)]"
          id={errorId}
        >
          {error}
        </p>
      )}
    </div>
  );
}
