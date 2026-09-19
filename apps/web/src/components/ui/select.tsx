import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';

import { controlClassName } from './control-styles';
import { cx } from './utils';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, ...props },
  ref,
) {
  return (
    <select
      {...props}
      className={cx('h-[var(--or-field-height)]', controlClassName, className)}
      ref={ref}
    />
  );
});
